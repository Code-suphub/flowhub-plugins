use super::{local_preferences, read_system_query, Device};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{collections::BTreeMap, path::{Path, PathBuf}, time::{Duration, Instant}};

const MAX_IMAGE: u64 = 64 * 1024;
const MAX_CACHE: u64 = 90_000;
const JPEG_PREFIX: &str = "data:image/jpeg;base64,";

struct Photo {
    thumbnail: &'static str,
    source: &'static str,
    author: &'static str,
    license: &'static str,
    license_url: &'static str,
    revision: u8,
}

pub(crate) struct Entry {
    pub key: &'static str,
    name: &'static str,
    manual: Option<&'static str>,
    photo: Option<Photo>,
}

const K75: Entry = Entry {
    key: "kzzi-k75", name: "珂芝 K75",
    manual: Some("https://en.kzzi.com/media/files/20230613/20230613120005_4169.pdf"), photo: None,
};
const PIXEL: Entry = Entry {
    key: "pixel-8-pro", name: "Google Pixel 8 Pro", manual: None,
    photo: Some(Photo {
        thumbnail: "https://upload.wikimedia.org/wikipedia/commons/thumb/2/21/Google_Pixel_8_Pro.jpg/330px-Google_Pixel_8_Pro.jpg",
        source: "https://commons.wikimedia.org/wiki/File:Google_Pixel_8_Pro.jpg",
        author: "SimonWaldherr", license: "CC BY-SA 4.0",
        license_url: "https://creativecommons.org/licenses/by-sa/4.0/", revision: 1,
    }),
};
const MOUSE: Entry = Entry {
    key: "mx-master-3s", name: "Logitech MX Master 3S", manual: None,
    photo: Some(Photo {
        thumbnail: "https://upload.wikimedia.org/wikipedia/commons/thumb/2/25/Logitech_MX_Master_3S_HS03.jpg/330px-Logitech_MX_Master_3S_HS03.jpg",
        source: "https://commons.wikimedia.org/wiki/File:Logitech_MX_Master_3S_HS03.jpg",
        author: "Hayden Schiff", license: "CC BY 4.0",
        license_url: "https://creativecommons.org/licenses/by/4.0/", revision: 1,
    }),
};
const DISPLAY: Entry = Entry {
    key: "lg-ultrafine-5k", name: "LG UltraFine 5K", manual: None,
    photo: Some(Photo {
        thumbnail: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4e/LG_UltraFine_5K_Display.jpg/330px-LG_UltraFine_5K_Display.jpg",
        source: "https://commons.wikimedia.org/wiki/File:LG_UltraFine_5K_Display.jpg",
        author: "LG Electronics", license: "CC BY 2.0",
        license_url: "https://creativecommons.org/licenses/by/2.0/", revision: 1,
    }),
};

pub fn identify(device: &Device) -> Option<&'static Entry> {
    // The ADB model is hardware metadata. An editable display alias is never
    // a lookup key, and near matches such as Pixel 8 or K75 V2 stay distinct.
    let name = if let Some(adb) = &device.adb { adb.model.as_deref()? } else { &device.name };
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    match (device.category.as_str(), name.as_str()) {
        ("bluetooth" | "usb", "kzzi-k75 5.0" | "kzzi-k75 3.0" | "kzzi k75") => Some(&K75),
        ("adb" | "usb", "pixel 8 pro" | "google pixel 8 pro") => Some(&PIXEL),
        ("bluetooth" | "usb", "mx master 3s" | "logitech mx master 3s") => Some(&MOUSE),
        ("display", "lg ultrafine 5k" | "lg ultrafine 5k display") => Some(&DISPLAY),
        _ => None,
    }
}

pub fn reference(key: &str, kind: &str) -> Option<&'static str> {
    let entry = [&K75, &PIXEL, &MOUSE, &DISPLAY].into_iter().find(|entry| entry.key == key)?;
    match kind {
        "manual" => entry.manual,
        "photo" => entry.photo.as_ref().map(|photo| photo.source),
        "license" => entry.photo.as_ref().map(|photo| photo.license_url),
        _ => None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Profile<'a> {
    name: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    image: Option<Image<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Image<'a> {
    data_url: &'a str,
    author: &'static str,
    license: &'static str,
}

enum Cached {
    Pending,
    Ready(String),
    RetryAfter(Instant),
}

#[derive(Default)]
pub(crate) struct Store {
    pub root: Option<PathBuf>,
    images: BTreeMap<&'static str, Cached>,
}

impl Store {
    pub fn profile(&self, entry: &Entry) -> Profile<'_> {
        let image = match (entry.photo.as_ref(), self.images.get(entry.key)) {
            (Some(photo), Some(Cached::Ready(data_url))) => Some(Image {
                data_url, author: photo.author, license: photo.license,
            }),
            _ => None,
        };
        Profile { name: entry.name, image }
    }

    pub fn schedule<'a>(&mut self, devices: impl Iterator<Item = &'a Device>) -> Vec<(PathBuf, &'static Entry)> {
        let Some(root) = &self.root else { return Vec::new(); };
        let mut jobs = Vec::new();
        for entry in devices.filter_map(identify).filter(|entry| entry.photo.is_some()) {
            if matches!(self.images.get(entry.key), Some(Cached::Pending | Cached::Ready(_)))
                || matches!(self.images.get(entry.key), Some(Cached::RetryAfter(at)) if *at > Instant::now())
            {
                continue;
            }
            self.images.insert(entry.key, Cached::Pending);
            jobs.push((root.clone(), entry));
        }
        jobs
    }

    pub fn finish(&mut self, entry: &Entry, data: Option<String>) {
        let value = data.map(Cached::Ready)
            .unwrap_or_else(|| Cached::RetryAfter(Instant::now() + Duration::from_secs(900)));
        self.images.insert(entry.key, value);
    }
}

fn valid_jpeg(bytes: &[u8]) -> bool {
    bytes.len() as u64 <= MAX_IMAGE && bytes.starts_with(&[0xff, 0xd8, 0xff])
        && bytes.ends_with(&[0xff, 0xd9])
}

fn read_or_fetch(root: &Path, filename: &str, fetch: impl FnOnce() -> Option<Vec<u8>>) -> Option<String> {
    if let Ok(Some(data)) = local_preferences::read::<String>(root, filename, MAX_CACHE) {
        if data.strip_prefix(JPEG_PREFIX).and_then(|s| STANDARD.decode(s).ok())
            .is_some_and(|bytes| valid_jpeg(&bytes))
        {
            return Some(data);
        }
    }
    let bytes = fetch().filter(|bytes| valid_jpeg(bytes))?;
    let data = format!("{JPEG_PREFIX}{}", STANDARD.encode(bytes));
    let _ = local_preferences::write(root, filename, &data);
    Some(data)
}

pub fn load(root: &Path, entry: &Entry) -> Option<String> {
    let photo = entry.photo.as_ref()?;
    let filename = format!("device-photo-{}-v{}.json", entry.key, photo.revision);
    read_or_fetch(root, &filename, || read_system_query("/usr/bin/curl", &[
        "-q", "--silent", "--fail", "--proto", "=https", "--connect-timeout", "3",
        "--max-time", "6", "--max-filesize", "65536", "--user-agent",
        "FlowHub Device Center/0.3.12 (https://github.com/Code-suphub/flowhub-plugins)",
        "--", photo.thumbnail,
    ], Duration::from_secs(7), MAX_IMAGE).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device;

    #[test]
    fn exact_hardware_models_avoid_wrong_images_and_shortcuts() {
        let sample = |category, name: &str| device(category, name.into(), String::new(), String::new(), None, None, None);
        assert_eq!(identify(&sample("bluetooth", "Kzzi-K75 5.0 ")).unwrap().key, "kzzi-k75");
        assert!(identify(&sample("bluetooth", "Kzzi K75 V2")).is_none());
        assert!(identify(&sample("usb", "MX Master 3")).is_none());
        assert!(identify(&sample("display", "LG UltraFine")).is_none());
        assert_eq!(identify(&sample("display", "LG UltraFine 5K")).unwrap().key, "lg-ultrafine-5k");
        let adb = crate::adb::parse("List of devices attached\nTEST device model:Pixel_8_Pro").unwrap();
        assert_eq!(identify(&adb[0]).unwrap().key, "pixel-8-pro");
        assert!(reference("https://example.org", "manual").is_none());
    }

    #[test]
    fn photo_is_cached_across_reads_and_corrupt_content_is_replaced() {
        let root = std::env::temp_dir().join(format!("flowhub-device-catalog-{}-{}", std::process::id(), crate::now()));
        let name = "device-photo-test-v1.json";
        let jpeg = || Some(vec![0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);
        assert!(read_or_fetch(&root, name, || Some(b"<html>".to_vec())).is_none());
        let first = read_or_fetch(&root, name, jpeg).unwrap();
        assert_eq!(read_or_fetch(&root, name, || panic!("cache must work offline")), Some(first.clone()));
        local_preferences::write(&root, name, &"invalid").unwrap();
        assert_eq!(read_or_fetch(&root, name, jpeg), Some(first));
        std::fs::remove_dir_all(root).unwrap();
    }
}
