use super::{kind_for, read_system_query, short, usb_topology::Function, Device};
use serde::Deserialize;
use std::{collections::{BTreeMap, BTreeSet}, time::Duration};

#[derive(Deserialize)]
struct HidName {
    transport: String,
    vendor: u64,
    product: u64,
    location: u64,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsbClass { vendor: u64, product: u64, location: u64, device_class: u8 }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsbReport { hid_names: Vec<HidName>, device_classes: Vec<UsbClass> }

pub fn generic(device: &Device) -> bool {
    device.category == "usb" && matches!(device.name.to_ascii_lowercase().as_str(),
        "composite_device" | "composite device" | "usb composite device")
}

pub(super) fn hex_prefix(value: &str) -> Option<u64> {
    let token = value.split_whitespace().next()?;
    u64::from_str_radix(token.strip_prefix("0x").or_else(|| token.strip_prefix("0X"))?, 16).ok()
}

#[cfg(test)]
pub fn fill_names(devices: &mut [Device], report: &[u8]) {
    let Ok(rows) = serde_json::from_slice::<Vec<HidName>>(report) else { return; };
    apply_names(devices, rows);
}

fn apply_names(devices: &mut [Device], rows: Vec<HidName>) {
    let mut products = BTreeMap::<(u64, u64, u64), BTreeSet<String>>::new();
    for row in rows.into_iter().filter(|row| row.transport == "USB" && row.location != 0) {
        let name = short(&row.name, 92);
        if !name.is_empty() {
            products.entry((row.vendor, row.product, row.location)).or_default().insert(name);
        }
    }
    for device in devices.iter_mut().filter(|d| generic(d)) {
        let (Some(vendor), Some(product), Some(location)) = (
            device.vendor.as_deref().and_then(hex_prefix),
            device.product_id.as_deref().and_then(hex_prefix),
            device.usb_location.as_deref().and_then(hex_prefix),
        ) else { continue; };
        if let Some(names) = products.get(&(vendor, product, location)).filter(|names| names.len() == 1) {
            let name = names.first().unwrap();
            device.kind = kind_for(&format!("{name} {}", device.detail));
            device.name = name.clone();
        }
    }
}

fn apply_classes(devices: &mut [Device], classes: &[UsbClass]) {
    for device in devices.iter_mut().filter(|device| device.category == "usb") {
        let vendor = match device.vendor.as_deref() {
            Some("apple_vendor_id") => Some(0x05ac),
            value => value.and_then(hex_prefix),
        };
        let location = device.usb_location.as_deref().and_then(hex_prefix);
        let product = device.product_id.as_deref().and_then(hex_prefix);
        let mut matches = classes.iter().filter(|row| Some(row.vendor) == vendor
            && Some(row.location) == location && product.is_none_or(|product| product == row.product));
        let Some(row) = matches.next() else { continue; };
        if matches.next().is_some() { continue; }
        if let Some(usb) = device.usb.as_mut() {
            usb.function = match row.device_class {
                0x09 => { device.kind = "hub".into(); Some(Function::Hub) },
                0x11 => Some(Function::Billboard),
                _ => None,
            };
        }
    }
}

pub fn read(devices: &mut [Device]) {
    if !devices.iter().any(|device| device.category == "usb") { return; }
    let Ok(executable) = std::env::current_exe() else { return; };
    let path = executable.with_file_name("flowhub-device-icons");
    let Some(program) = path.to_str() else { return; };
    if let Ok(report) = read_system_query(program, &["--usb-topology"], Duration::from_secs(2), 65_536) {
        let Ok(report) = serde_json::from_slice::<UsbReport>(&report) else { return; };
        apply_names(devices, report.hid_names);
        apply_classes(devices, &report.device_classes);
        devices.sort_by(|a, b| a.category.cmp(&b.category).then(a.name.cmp(&b.name)));
    }
}
