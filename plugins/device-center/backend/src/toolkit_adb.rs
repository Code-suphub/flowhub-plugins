use crate::{adb::Connection, local_preferences, read_system_query, stable_id, Device};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    net::IpAddr,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Default)]
pub(crate) struct Catalog(BTreeMap<String, Profile>);

#[derive(Deserialize)]
struct File {
    version: u32,
    devices: BTreeMap<String, Profile>,
}

#[derive(Deserialize)]
struct Endpoint {
    serial: String,
    host: Option<String>,
}

#[derive(Deserialize)]
struct Profile {
    #[serde(flatten)]
    primary: Endpoint,
    identity: Option<String>,
    fallback: Option<Endpoint>,
}

impl Catalog {
    pub fn load() -> Self {
        let path = std::env::var_os("FLOWHUB_TOOLKIT_ADB_CONFIG").map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config/toolkit/adb-devices.json")));
        path.filter(|path| path.is_absolute()).map_or_else(Self::default, |path| Self::read(&path))
    }

    fn read(path: &Path) -> Self {
        let (Some(root), Some(filename)) = (path.parent(), path.file_name().and_then(|name| name.to_str())) else {
            return Self::default();
        };
        let Ok(Some(file)) = local_preferences::read::<File>(root, filename, 256 * 1024) else {
            return Self::default();
        };
        if file.version != 1 || file.devices.len() > 1024 {
            return Self::default();
        }
        Self(file.devices.into_iter().filter(|(name, _)| {
            !name.is_empty() && name.chars().count() <= 64 && !name.chars().any(char::is_control)
        }).collect())
    }

    pub fn has_identities(&self) -> bool {
        self.0.values().any(|profile| profile.identity.is_some())
    }

    fn endpoint(&self, serial: &str) -> Option<(&str, &Profile, &'static str)> {
        let mut matches = self.0.iter().filter_map(|(name, profile)| {
            if profile.primary.host.is_none() && profile.primary.serial == serial {
                Some((name.as_str(), profile, "primary"))
            } else if profile.fallback.as_ref().is_some_and(|route| route.host.is_none() && route.serial == serial) {
                Some((name.as_str(), profile, "fallback"))
            } else {
                None
            }
        });
        let first = matches.next()?;
        matches.next().is_none().then_some(first)
    }

    fn by_identity(&self, identity: &str) -> Option<&str> {
        self.0.iter().find_map(|(name, profile)| {
            (profile.identity.as_deref() == Some(identity)).then_some(name.as_str())
        })
    }
}

#[derive(Default)]
pub(crate) struct NetworkSources {
    tailscale_peers: BTreeSet<IpAddr>,
    easytier_listeners: BTreeSet<String>,
}

impl NetworkSources {
    pub fn read(devices: &[Device]) -> Self {
        let mut loopback = false;
        let mut remote = false;
        for info in devices.iter().filter_map(|device| device.adb.as_ref()) {
            let Some((host, _)) = tcp_address(&info.serial) else { continue; };
            loopback |= host.is_loopback();
            remote |= !host.is_loopback();
        }
        std::thread::scope(|scope| {
            let peers = scope.spawn(|| {
                if !remote { return BTreeSet::new(); }
                crate::adb::find_cli("tailscale").and_then(|path| {
                    read_system_query(path.to_str()?, &["status", "--json"], Duration::from_millis(900), 512 * 1024).ok()
                }).and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .map_or_else(BTreeSet::new, |status| tailscale_peers(&status))
            });
            let listeners = if loopback {
                read_system_query("/usr/sbin/lsof", &["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-Fpcn"],
                    Duration::from_millis(900), 256 * 1024)
                    .ok().and_then(|bytes| String::from_utf8(bytes).ok())
                    .map_or_else(BTreeSet::new, |output| easytier_listeners(&output))
            } else {
                BTreeSet::new()
            };
            Self { tailscale_peers: peers.join().unwrap_or_default(), easytier_listeners: listeners }
        })
    }

    fn source(&self, serial: &str) -> Option<String> {
        let (host, port) = tcp_address(serial)?;
        if host.is_loopback() && (self.easytier_listeners.contains(serial)
            || self.easytier_listeners.contains(&format!("*:{port}"))) {
            return Some("easytier".into());
        }
        if !host.is_loopback() && self.tailscale_peers.contains(&host) {
            return Some("tailscale".into());
        }
        None
    }
}

fn tcp_address(serial: &str) -> Option<(IpAddr, u16)> {
    let (host, port) = serial.rsplit_once(':')?;
    let host = host.trim_start_matches('[').trim_end_matches(']').parse().ok()?;
    Some((host, port.parse().ok()?))
}

fn tailscale_peers(status: &Value) -> BTreeSet<IpAddr> {
    status["Peer"].as_object().into_iter().flat_map(|peers| peers.values())
        .flat_map(|peer| peer["TailscaleIPs"].as_array().into_iter().flatten())
        .filter_map(|ip| ip.as_str()?.parse().ok()).collect()
}

fn easytier_listeners(output: &str) -> BTreeSet<String> {
    let mut is_easytier = false;
    let mut listeners = BTreeSet::new();
    for line in output.lines() {
        if line.starts_with('p') {
            is_easytier = false;
        } else if let Some(command) = line.strip_prefix('c') {
            is_easytier = command == "easytier-core";
        } else if let Some(address) = line.strip_prefix('n').filter(|_| is_easytier) {
            listeners.insert(address.into());
        }
    }
    listeners
}

pub(crate) fn group(devices: Vec<Device>, catalog: &Catalog, network: &NetworkSources) -> Vec<Device> {
    let verified: BTreeSet<String> = devices.iter().filter_map(|device| {
        let identity = device.adb.as_ref()?.hardware_identity.as_deref()?;
        catalog.by_identity(identity)?;
        Some(identity.to_owned())
    }).collect();
    let mut buckets: Vec<Vec<Device>> = Vec::new();
    let mut positions = BTreeMap::new();
    for mut device in devices {
        let info = device.adb.as_mut().expect("ADB row");
        let declared = catalog.endpoint(&info.serial).filter(|(_, profile, _)| {
            info.hardware_identity.as_ref().zip(profile.identity.as_ref())
                .is_none_or(|(actual, expected)| actual == expected)
        });
        let identity = info.hardware_identity.as_ref().filter(|identity| verified.contains(*identity))
            .or_else(|| {
                if info.hardware_identity.is_some() { return None; }
                // A recorded route can join its device only when another live
                // route has confirmed that registered identity in this scan.
                declared.and_then(|(_, profile, _)| profile.identity.as_ref()).filter(|identity| verified.contains(*identity))
            });
        info.shared_alias = declared.map(|(name, _, _)| name)
            .or_else(|| identity.and_then(|identity| catalog.by_identity(identity))).map(str::to_owned);
        info.connections = vec![Connection {
            serial: info.serial.clone(),
            state: info.state.clone(),
            transport: info.transport.clone(),
            source: network.source(&info.serial),
            role: declared.map(|(_, _, role)| role.into()),
            identity_verified: identity.filter(|_| info.state == "device")
                .map(|identity| info.hardware_identity.as_ref() == Some(identity)),
        }];
        if let Some(identity) = identity {
            let id = stable_id("adb", "toolkit", identity);
            info.legacy_ids.push(std::mem::replace(&mut device.id, id.clone()));
            let index = *positions.entry(id).or_insert_with(|| {
                buckets.push(Vec::new());
                buckets.len() - 1
            });
            buckets[index].push(device);
        } else {
            buckets.push(vec![device]);
        }
    }
    buckets.into_iter().map(|mut rows| {
        rows.sort_by_key(|row| {
            let info = row.adb.as_ref().expect("ADB row");
            (info.state != "device", info.connections[0].identity_verified == Some(false),
                row.battery.is_none(), info.connections[0].role.as_deref() != Some("primary"))
        });
        let mut primary = rows.remove(0);
        let info = primary.adb.as_mut().expect("ADB row");
        for other in rows {
            let other = other.adb.expect("ADB row");
            info.connections.extend(other.connections);
            info.legacy_ids.extend(other.legacy_ids);
        }
        info.connections.sort_by_key(|connection| match connection.role.as_deref() {
            Some("primary") => 0,
            Some("fallback") => 1,
            _ => 2,
        });
        primary
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn verified_phone_groups_registered_network_routes_and_local_usb() {
        let catalog = Catalog(serde_json::from_value(json!({
            "phone": {
                "serial": "127.0.0.1:17352",
                "identity": "DEVICE-A",
                "fallback": {"serial": "100.64.0.2:5555"}
            }
        })).unwrap());
        let sources = NetworkSources {
            tailscale_peers: tailscale_peers(&json!({"Peer":{"node":{"TailscaleIPs":["100.64.0.2"]}}})),
            easytier_listeners: easytier_listeners("p1\nceasytier-core\nn127.0.0.1:17352\np2\ncother\nn*:17354\n"),
        };
        let mut devices = crate::adb::parse(concat!(
            "List of devices attached\n",
            "127.0.0.1:17352 device model:Same_Phone\n",
            "100.64.0.2:5555 offline\n",
            "USB-A device usb:1-1 model:Same_Phone\n",
            "127.0.0.1:17354 device model:Same_Phone\n"
        )).unwrap();
        devices[2].adb.as_mut().unwrap().hardware_identity = Some("DEVICE-A".into());
        devices[2].battery = Some("73%".into());
        devices[3].adb.as_mut().unwrap().hardware_identity = Some("DEVICE-B".into());
        let rows = group(devices, &catalog, &sources);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, stable_id("adb", "toolkit", "DEVICE-A"));
        assert_eq!(rows[0].battery.as_deref(), Some("73%"));
        let info = rows[0].adb.as_ref().unwrap();
        assert_eq!(info.shared_alias.as_deref(), Some("phone"));
        assert_eq!(info.legacy_ids.len(), 3);
        assert!(info.connections.iter().any(|c| c.transport == "usb" && c.state == "device"));
        assert!(info.connections.iter().any(|c| c.source.as_deref() == Some("easytier")
            && c.role.as_deref() == Some("primary") && c.identity_verified == Some(false)));
        assert!(info.connections.iter().any(|c| c.source.as_deref() == Some("tailscale") && c.state == "offline"));
        assert!(rows[1].adb.as_ref().unwrap().connections[0].source.is_none());
    }

    #[test]
    fn mismatched_endpoint_does_not_inherit_shared_name_or_join_group() {
        let catalog = Catalog(serde_json::from_value(json!({
            "phone": {"serial":"127.0.0.1:17352","identity":"DEVICE-A"}
        })).unwrap());
        let mut devices = crate::adb::parse("List of devices attached\n127.0.0.1:17352 device\nUSB-A device usb:1-1\n").unwrap();
        devices[0].adb.as_mut().unwrap().hardware_identity = Some("DEVICE-B".into());
        devices[1].adb.as_mut().unwrap().hardware_identity = Some("DEVICE-A".into());
        let rows = group(devices, &catalog, &NetworkSources::default());
        assert_eq!(rows.len(), 2);
        assert!(rows[0].adb.as_ref().unwrap().shared_alias.is_none());
        assert_eq!(rows[1].adb.as_ref().unwrap().shared_alias.as_deref(), Some("phone"));
    }
}
