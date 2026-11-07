use crate::local_preferences;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf};

const FILE: &str = "adb-preferences.json";
const MAX_ALIASES: usize = 256;
const MAX_ALIAS_LENGTH: usize = 40;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    aliases: BTreeMap<String, String>,
    low_battery_threshold: u8,
    revision: u64,
}

impl Default for Preferences {
    fn default() -> Self {
        Self { aliases: BTreeMap::new(), low_battery_threshold: 30, revision: 0 }
    }
}

#[derive(Default)]
pub struct Store {
    root: Option<PathBuf>,
    saved: Preferences,
    error: Option<&'static str>,
}

fn valid_id(id: &str) -> bool {
    id.strip_prefix("adb-").is_some_and(|hash| {
        hash.len() == 16 && hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}

fn valid_alias(value: &str) -> bool {
    value.chars().count() <= MAX_ALIAS_LENGTH && !value.chars().any(char::is_control)
}

impl Store {
    pub fn open(root: Option<PathBuf>) -> Self {
        let mut store = Self { root, ..Self::default() };
        let Some(root) = &store.root else {
            store.error = Some("无法确定 ADB 设置的保存目录");
            return store;
        };
        match local_preferences::read::<Preferences>(root, FILE, 128 * 1024) {
            Ok(None) => {}
            Ok(Some(saved)) if saved.low_battery_threshold <= 100
                && saved.revision < 9_007_199_254_740_991
                && saved.aliases.len() <= MAX_ALIASES
                && saved.aliases.iter().all(|(id, alias)| valid_id(id) && valid_alias(alias)) =>
            {
                store.saved = saved;
            }
            _ => store.error = Some("无法读取已保存的 ADB 设置"),
        }
        store
    }

    pub fn value(&self) -> Value {
        json!({
            "aliases": self.saved.aliases,
            "lowBatteryThreshold": self.saved.low_battery_threshold,
            "revision": self.saved.revision,
            "error": self.error,
        })
    }

    pub fn set_alias(&mut self, id: &str, alias: &str, previous_ids: &[String]) -> Result<Value, String> {
        if !valid_id(id) || !valid_alias(alias) {
            return Err("别名最多 40 字，且不能包含控制字符".into());
        }
        let mut next = self.saved.clone();
        for previous in previous_ids {
            next.aliases.remove(previous);
        }
        if alias.trim().is_empty() {
            next.aliases.remove(id);
        } else {
            next.aliases.insert(id.into(), alias.trim().into());
        }
        if next.aliases.len() > MAX_ALIASES {
            return Err("ADB 别名已达到保存上限".into());
        }
        self.save(next)
    }

    pub fn set_threshold(&mut self, threshold: u64) -> Result<Value, String> {
        if threshold > 100 {
            return Err("低电量阈值须为 0 到 100 的整数".into());
        }
        let mut next = self.saved.clone();
        next.low_battery_threshold = threshold as u8;
        self.save(next)
    }

    fn save(&mut self, mut next: Preferences) -> Result<Value, String> {
        if let Some(error) = self.error {
            return Err(error.into());
        }
        if next == self.saved {
            return Ok(self.value());
        }
        next.revision = self.saved.revision.checked_add(1)
            .filter(|revision| *revision < 9_007_199_254_740_991)
            .ok_or("ADB 设置版本已达上限")?;
        if let Some(root) = &self.root {
            local_preferences::write(root, FILE, &next).map_err(|_| "无法保存 ADB 设置")?;
        }
        self.saved = next;
        Ok(self.value())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases_and_threshold_survive_reopen_and_preserve_other_connections() {
        let root = std::env::temp_dir().join(format!("flowhub-adb-prefs-{}-{}", std::process::id(), crate::now()));
        let mut store = Store::open(Some(root.clone()));
        let first = "adb-aaaaaaaaaaaaaaaa";
        let second = "adb-bbbbbbbbbbbbbbbb";
        assert_eq!(store.value()["lowBatteryThreshold"], 30);
        store.set_alias(first, " 测试机 ", &[]).unwrap();
        store.set_alias(second, "备用机", &[]).unwrap();
        store.set_threshold(40).unwrap();
        assert!(store.set_alias("raw-serial", "无效", &[]).is_err());
        assert!(store.set_threshold(101).is_err());
        let mut reopened = Store::open(Some(root.clone()));
        assert_eq!(reopened.value(), store.value());
        assert_eq!(reopened.value()["aliases"][first], "测试机");
        reopened.set_alias(first, "", &[]).unwrap();
        let saved = Store::open(Some(root.clone())).value();
        assert!(saved["aliases"][first].is_null());
        assert_eq!(saved["aliases"][second], "备用机");
        assert_eq!(saved["lowBatteryThreshold"], 40);
        std::fs::remove_dir_all(root).unwrap();
    }
}
