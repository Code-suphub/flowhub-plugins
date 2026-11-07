use super::{run_k75_probe, usb_hid::hex_prefix, Device};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

struct Sample {
    at: Instant,
    value: Value,
}

struct Cache {
    samples: BTreeMap<u32, Sample>,
    probing: bool,
}

static CACHE: Mutex<Cache> = Mutex::new(Cache { samples: BTreeMap::new(), probing: false });
static HID: Mutex<()> = Mutex::new(());
const FRESH: Duration = Duration::from_secs(4);

pub(super) fn location(device: &Device) -> Option<u32> {
    if device.category != "usb"
        || device.status != "connected"
        || device.vendor.as_deref().and_then(hex_prefix) != Some(0x258a)
        || device.product_id.as_deref().and_then(hex_prefix) != Some(0x0112)
    {
        return None;
    }
    let location = hex_prefix(device.usb_location.as_deref()?)?;
    u32::try_from(location).ok().filter(|location| *location != 0)
}

pub(super) fn probe(args: &[&str]) -> Result<Value, String> {
    let _guard = HID.lock().map_err(|_| "K75 USB 接口不可用")?;
    run_k75_probe(args)
}

pub(super) fn request(location: u32) -> Value {
    let Ok(mut cache) = CACHE.lock() else { return json!({"status":"unavailable"}); };
    cache.samples.retain(|_, sample| sample.at.elapsed() < Duration::from_secs(10));
    if let Some(sample) = cache.samples.get(&location).filter(|sample| sample.at.elapsed() < FRESH) {
        return sample.value.clone();
    }
    // Return cached state while refreshing. Keep the native request off the
    // plugin's stdin loop and serialize HID reports with the diagnostic CLI.
    if !cache.probing {
        cache.probing = true;
        thread::spawn(move || {
            let value = mode_result(probe(&["--mode-at", &location.to_string()]));
            if let Ok(mut cache) = CACHE.lock() {
                cache.samples.insert(location, Sample { at: Instant::now(), value });
                cache.probing = false;
            }
        });
    }
    cache.samples.get(&location).map(|sample| sample.value.clone())
        .unwrap_or_else(|| json!({"status":"pending"}))
}

fn mode_result(result: Result<Value, String>) -> Value {
    match result {
        Ok(report) => {
            let mode = match (report["usbRelease"].as_str(), report["osMode"].as_str()) {
                (Some("0x4023"), Some(mode @ ("mac" | "windows"))) => mode,
                _ => "unknown",
            };
            json!({"status":"read","mode":mode,"usbRelease":report["usbRelease"]})
        },
        Err(_) => json!({"status":"unavailable"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_a_connected_usb_candidate_at_a_known_port() {
        let mut device = crate::device("usb", "Gaming Keyboard".into(), String::new(), String::new(),
            None, Some("0x258a (BY Tech)".into()), Some("0x0112".into()));
        assert!(location(&device).is_none());
        device.usb_location = Some("0x00111000 / 5".into());
        assert_eq!(location(&device), Some(0x00111000));
        device.category = "bluetooth".into();
        assert!(location(&device).is_none());
        device.category = "usb".into();
        device.status = "disconnected".into();
        assert!(location(&device).is_none());
    }

    #[test]
    fn only_the_verified_release_is_reported_as_windows_or_mac() {
        for (release, mode, expected) in [("0x4023", "mac", "mac"), ("0x4023", "windows", "windows"),
            ("0x4023", "unknown", "unknown"), ("0x4024", "mac", "unknown")] {
            let value = mode_result(Ok(json!({"usbRelease":release,"osMode":mode,"powerBytes":[4,4]})));
            assert_eq!(value, json!({"status":"read","mode":expected,"usbRelease":release}));
        }
        assert_eq!(mode_result(Err("USB read failed".into())), json!({"status":"unavailable"}));
    }
}
