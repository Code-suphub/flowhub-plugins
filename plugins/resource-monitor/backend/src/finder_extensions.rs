//! User elections for registered, app-owned Finder Sync extensions.
use crate::{native, services::command};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

const FINDER_SYNC: &str = "com.apple.FinderSync";
const PLUGINKIT: &str = "/usr/bin/pluginkit";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Election {
    Enabled,
    Disabled,
    Default,
    Unknown,
}

impl Election {
    fn as_str(self) -> &'static str {
        match self {
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
            Self::Default => "default",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Registration<'a> {
    id: &'a str,
    uuid: &'a str,
    path: &'a str,
    election: Election,
}

fn valid_identifier(id: &str) -> bool {
    id.len() <= 255
        && id.contains('.')
        && id.split('.').all(|part| {
            !part.is_empty() && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
}

fn registrations(text: &str) -> impl Iterator<Item = Registration<'_>> {
    text.lines().filter_map(|line| {
        let mut fields = line.splitn(4, '\t');
        let header = fields.next()?;
        let uuid = fields.next()?;
        let _registered_at = fields.next()?;
        let path = fields.next()?;
        let (id, _) = header
            .trim_start_matches(['+', '-', '!', '=', '?', ' '])
            .split_once('(')?;
        if !valid_identifier(id) || uuid::Uuid::parse_str(uuid).is_err() {
            return None;
        }
        let election = match header.as_bytes().first()? {
            b'+' => Election::Enabled,
            b'-' => Election::Disabled,
            b' ' => Election::Default,
            _ => Election::Unknown,
        };
        Some(Registration {
            id,
            uuid,
            path,
            election,
        })
    })
}

struct Extension {
    bundle: PathBuf,
    app: PathBuf,
    executable: String,
    name: String,
}

fn owning_app(bundle: &Path) -> Option<&Path> {
    if bundle.extension()?.to_str()? != "appex" || bundle.starts_with("/System") {
        return None;
    }
    let app = bundle
        .ancestors()
        .skip(1)
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))?;
    let relative = bundle.strip_prefix(app).ok()?.parent()?;
    (relative == Path::new("Contents/PlugIns")
        || relative == Path::new("Contents/Resources/PlugIns"))
    .then_some(app)
}

fn verify(record: &Registration<'_>, deadline: Instant) -> Option<Extension> {
    if record.id.starts_with("com.apple.") {
        return None;
    }
    let bundle = fs::canonicalize(record.path).ok()?;
    let app = owning_app(&bundle)?.to_owned();
    let info = bundle.join("Contents/Info.plist");
    let bytes = command(
        "/usr/bin/plutil",
        &["-convert", "json", "-o", "-", info.to_str()?],
        deadline,
    )?;
    let plist: Value = serde_json::from_slice(&bytes).ok()?;
    if plist["CFBundleIdentifier"] != record.id
        || plist["NSExtension"]["NSExtensionPointIdentifier"] != FINDER_SYNC
    {
        return None;
    }
    let name = plist["CFBundleDisplayName"]
        .as_str()
        .or_else(|| plist["CFBundleName"].as_str())
        .unwrap_or(record.id)
        .to_owned();
    let executable = plist["CFBundleExecutable"].as_str()?;
    if Path::new(executable).file_name()?.to_str()? != executable {
        return None;
    }
    let bin_dir = bundle.join("Contents/MacOS");
    let binary = fs::canonicalize(bin_dir.join(executable)).ok()?;
    if binary.parent() != Some(bin_dir.as_path()) || !binary.is_file() {
        return None;
    }
    Some(Extension {
        bundle,
        app,
        executable: binary.to_str()?.into(),
        name,
    })
}

fn revision(record: &Registration<'_>, extension: &Extension) -> String {
    let scope = json!([
        record.id,
        record.uuid,
        record.election.as_str(),
        extension.bundle,
        extension.executable
    ]);
    format!("{:x}", Sha256::digest(scope.to_string()))
}

fn query(args: &[&str], deadline: Instant) -> Result<String, String> {
    command(PLUGINKIT, args, deadline)
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| "无法核实 macOS 的访达扩展登记，请刷新重试。".into())
}

pub(crate) fn snapshot() -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(3);
    let text = query(&["-m", "-D", "-v", "-p", FINDER_SYNC], deadline)?;
    let records: Vec<_> = registrations(&text).collect();
    let mut counts = HashMap::<&str, usize>::new();
    for record in &records {
        *counts.entry(record.id).or_default() += 1;
    }
    let extensions: Vec<_> = records
        .iter()
        .filter_map(|record| verify(record, deadline).map(|extension| (record, extension)))
        .collect();
    let paths = extensions
        .iter()
        .map(|(_, extension)| extension.executable.as_str())
        .collect();
    let running = native::matching_executables(&paths).ok();
    let mut seen = HashSet::new();
    let mut rows: Vec<_> = extensions.iter().filter_map(|(record, extension)| {
        if !seen.insert((record.id, &extension.bundle)) {
            return None;
        }
        let editable = counts[record.id] == 1 && record.election != Election::Unknown;
        let running_count = running.as_ref().map(|targets| {
            targets.iter().filter(|target| target.executable == extension.executable).count()
        });
        Some(json!({
            "id": record.id, "appPath": extension.app, "bundlePath": extension.bundle,
            "name": extension.name, "state": record.election.as_str(), "runningCount": running_count,
            "revision": editable.then(|| revision(record, extension)),
        }))
    }).collect();
    rows.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(json!({"rows": rows}))
}

fn single_registration<'a>(text: &'a str, id: &str) -> Option<Registration<'a>> {
    let mut matches = registrations(text).filter(|record| record.id == id);
    let record = matches.next()?;
    (matches.next().is_none()).then_some(record)
}

pub(crate) fn set(params: &Value) -> Result<Value, String> {
    if params["confirmed"] != true {
        return Err("请先确认访达扩展操作。".into());
    }
    let id = params["id"]
        .as_str()
        .filter(|id| valid_identifier(id))
        .ok_or("访达扩展标识无效。")?;
    let enabled = params["enabled"]
        .as_bool()
        .ok_or("缺少访达扩展的目标状态。")?;
    let expected = params["revision"]
        .as_str()
        .ok_or("请刷新访达扩展后再试。")?;
    let deadline = Instant::now() + Duration::from_secs(4);
    // Elections can apply to every copy of an ID. Check the unfiltered registry.
    let before = query(&["-m", "-D", "-v", "-i", id], deadline)?;
    let record =
        single_registration(&before, id).ok_or("扩展未登记或有多份副本，请在系统设置中管理。")?;
    let extension = verify(&record, deadline).ok_or("无法核验所选访达扩展。")?;
    if record.election == Election::Unknown || expected != revision(&record, &extension) {
        return Err("扩展登记或设置已变化，请刷新后重新确认。".into());
    }

    let (desired, election) = if enabled {
        (Election::Enabled, "use")
    } else {
        (Election::Disabled, "ignore")
    };
    if record.election != desired {
        let _ = command(
            PLUGINKIT,
            &["-e", election, "-p", FINDER_SYNC, "-i", id],
            deadline,
        );
    }
    let mut applied = false;
    for _ in 0..3 {
        let readback = query(&["-m", "-D", "-v", "-i", id], deadline);
        if readback
            .as_deref()
            .ok()
            .and_then(|text| single_registration(text, id))
            .is_some_and(|after| {
                after.uuid == record.uuid && after.path == record.path && after.election == desired
            })
        {
            applied = true;
            break;
        }
        thread::sleep(Duration::from_millis(80));
    }
    if !applied {
        return Err("macOS 的扩展设置尚未确认，请刷新核对。".into());
    }

    let paths = HashSet::from([extension.executable.as_str()]);
    let mut running = native::matching_executables(&paths).ok();
    if !enabled {
        if let Some(targets) = running.as_ref().filter(|targets| !targets.is_empty()) {
            for target in targets {
                let _ = native::signal(target, false);
            }
            thread::sleep(Duration::from_millis(300));
            running = native::matching_executables(&paths).ok();
        }
    }
    Ok(json!({"enabled": enabled, "runningCount": running.map(|targets| targets.len())}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_parser_preserves_election_and_rejects_duplicate_ids() {
        let uuid = "ACD575F1-BA37-459C-9744-AD041BC1DD82";
        let first = format!("+    com.example.finder(1.0)\t{uuid}\t2026-01-01\t/Applications/A B.app/Contents/PlugIns/X.appex");
        let second = format!("-    com.example.finder(0.9)\t{uuid}\t2026-01-01\t/Applications/Old.app/Contents/PlugIns/X.appex");
        let record = single_registration(&first, "com.example.finder").unwrap();
        assert_eq!(record.election, Election::Enabled);
        assert!(record.path.contains("A B.app"));
        assert!(single_registration(&format!("{first}\n{second}"), "com.example.finder").is_none());
        assert!(single_registration("  (no matches)", "com.example.finder").is_none());
        assert_eq!(
            registrations(&first.replace('+', " "))
                .next()
                .unwrap()
                .election,
            Election::Default
        );
    }

    #[test]
    fn owner_scope_supports_vivo_nested_plugins_and_excludes_system_bundles() {
        assert_eq!(
            owning_app(Path::new(
                "/Applications/pcsuite.app/Contents/Resources/PlugIns/pcsuite_ex.appex"
            )),
            Some(Path::new("/Applications/pcsuite.app"))
        );
        assert!(owning_app(Path::new("/Applications/App.app/other/Extension.appex")).is_none());
        assert!(owning_app(Path::new(
            "/System/Applications/App.app/Contents/PlugIns/Extension.appex"
        ))
        .is_none());
        assert!(set(&json!({"id": "com.example.finder", "enabled": false})).is_err());
    }
}
