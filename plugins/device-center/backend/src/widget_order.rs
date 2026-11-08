use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeSet, path::PathBuf};
use crate::local_preferences;

const MAX_IDS: usize = 1024;
const MAX_FILE: u64 = 192 * 1024;

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    revision: u64,
    ids: Vec<String>,
}

#[derive(Default)]
pub struct Store {
    root: Option<PathBuf>,
    saved: Saved,
    error: Option<String>,
}

fn validate(ids: &[String]) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    if ids.len() > MAX_IDS { return Err("设备排序数量超出上限".into()); }
    for id in ids {
        let hashed = id.rsplit_once('-').is_some_and(|(category, hash)| matches!(category, "bluetooth" | "usb" | "display" | "adb") && hash.len() == 16 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        if !hashed || !seen.insert(id) {
            return Err("设备排序包含无效或重复的设备标识".into());
        }
    }
    Ok(())
}

impl Store {
    pub fn open(root: Option<PathBuf>) -> Self {
        let mut store = Self { root, ..Self::default() };
        let result = (|| -> Result<Saved, String> {
            let root = store.root.as_ref().ok_or("无法确定设备排序的保存目录")?;
            let saved: Saved = local_preferences::read(root, "widget-order.json", MAX_FILE)
                .map_err(|_| "无法读取已保存的设备顺序")?.unwrap_or_default();
            validate(&saved.ids)?;
            if saved.revision >= 9_007_199_254_740_991 { return Err("设备排序版本无效".into()); }
            Ok(saved)
        })();
        match result { Ok(saved) => store.saved = saved, Err(error) => store.error = Some(error) }
        store
    }

    pub fn value(&self) -> Value { json!({"ids":self.saved.ids,"revision":self.saved.revision,"error":self.error}) }

    pub fn update(&mut self, params: &Value) -> Result<Value, String> {
        if let Some(error) = &self.error { return Err(error.clone()); }
        let ids: Vec<String> = serde_json::from_value(params["ids"].clone()).map_err(|_| "设备排序格式无效")?;
        validate(&ids)?;
        if params["expectedRevision"].as_u64() != Some(self.saved.revision) { return Err("设备顺序已在其他组件更新，请重新排序".into()); }
        if ids == self.saved.ids { return Ok(self.value()); }
        let next = Saved { revision: self.saved.revision.checked_add(1).filter(|n| *n < 9_007_199_254_740_991).ok_or("设备排序版本已达上限")?, ids };
        if let Some(root) = &self.root {
            local_preferences::write(root, "widget-order.json", &next)
                .map_err(|_| "无法保存设备顺序")?;
        }
        self.saved = next;
        Ok(self.value())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn persists_order_and_rejects_stale_or_invalid_writes_without_changing_saved_data() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("flowhub-order-{}-{}", std::process::id(), crate::now()));
        let mut store = Store::open(Some(root.clone()));
        store.update(&json!({"ids":["adb-aaaaaaaaaaaaaaaa","usb-bbbbbbbbbbbbbbbb","bluetooth-cccccccccccccccc"],"expectedRevision":0})).unwrap();
        let bytes = fs::read(root.join("widget-order.json")).unwrap();
        assert_eq!(fs::metadata(root.join("widget-order.json")).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(Store::open(Some(root.clone())).value(), store.value());
        for invalid in [json!({"ids":["usb-bbbbbbbbbbbbbbbb"],"expectedRevision":0}), json!({"ids":["usb-bbbbbbbbbbbbbbbb","usb-bbbbbbbbbbbbbbbb"],"expectedRevision":1}), json!({"ids":["../file"],"expectedRevision":1}), json!({"ids":["PUBLIC_ADB_SERIAL"],"expectedRevision":1})] {
            assert!(store.update(&invalid).is_err());
            assert_eq!(fs::read(root.join("widget-order.json")).unwrap(), bytes);
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_preferences_are_not_silently_overwritten() {
        let root = std::env::temp_dir().join(format!("flowhub-order-bad-{}-{}", std::process::id(), crate::now()));
        fs::create_dir(&root).unwrap();fs::write(root.join("widget-order.json"), "broken").unwrap();
        let mut store = Store::open(Some(root.clone()));
        assert!(store.value()["error"].is_string());
        assert!(store.update(&json!({"ids":[],"expectedRevision":0})).is_err());
        assert_eq!(fs::read_to_string(root.join("widget-order.json")).unwrap(), "broken");
        fs::remove_dir_all(root).unwrap();
    }
}
