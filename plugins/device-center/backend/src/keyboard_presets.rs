use super::local_preferences;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const FILE: &str = "k75-presets.json";
const LIMIT: u64 = 8192;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Mode { Mac, Windows }

impl Mode {
    pub fn code(self) -> &'static str { match self { Self::Mac => "1", Self::Windows => "0" } }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Lighting { Breathing, Off }

impl Lighting {
    pub fn code(self) -> &'static str { match self { Self::Breathing => "2", Self::Off => "4" } }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Preset {
    pub name: String,
    pub mode: Mode,
    pub lighting: Option<Lighting>,
}

#[derive(Default)]
pub(super) struct Store { root: Option<PathBuf> }

impl Store {
    pub fn open(root: Option<PathBuf>) -> Self { Self { root } }

    pub fn list(&self) -> Result<Vec<Preset>, String> {
        let root = self.root.as_deref().ok_or("找不到预设存储目录")?;
        let presets: Vec<Preset> = local_preferences::read(root, FILE, LIMIT)
            .map_err(|_| "预设文件无法读取")?.unwrap_or_default();
        if presets.len() > 12 || presets.iter().any(|preset| validate_name(&preset.name).is_err()) {
            return Err("预设文件格式无效".into());
        }
        Ok(presets)
    }

    pub fn record(&self, name: String, mode: Mode, lighting: Option<Lighting>) -> Result<Vec<Preset>, String> {
        let mut presets = self.list()?;
        if presets.iter().any(|preset| preset.name.eq_ignore_ascii_case(&name)) {
            return Err("已有同名预设，请换一个名称".into());
        }
        if presets.len() >= 12 { return Err("最多保存 12 个预设".into()); }
        presets.push(Preset { name, mode, lighting });
        self.save(presets)
    }

    pub fn delete(&self, name: &str) -> Result<Vec<Preset>, String> {
        let mut presets = self.list()?;
        let index = presets.iter().position(|preset| preset.name == name).ok_or("预设不存在")?;
        presets.remove(index);
        self.save(presets)
    }

    fn save(&self, presets: Vec<Preset>) -> Result<Vec<Preset>, String> {
        let root = self.root.as_deref().ok_or("找不到预设存储目录")?;
        local_preferences::write(root, FILE, &presets).map_err(|_| "预设保存失败")?;
        Ok(presets)
    }
}

pub(super) fn validate_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > 36 || name.chars().any(char::is_control) {
        return Err("预设名称须为 1 到 36 个可见字符".into());
    }
    Ok(name.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};

    #[test]
    fn recording_and_deletion_persist_typed_values_without_overwriting_names() {
        let at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("flowhub-k75-presets-{}-{at}", std::process::id()));
        let store = Store::open(Some(root.clone()));
        let name = validate_name("  Office  ").unwrap();
        assert!(validate_name("line\nbreak").is_err());
        store.record(name, Mode::Mac, Some(Lighting::Breathing)).unwrap();
        assert!(store.record("office".into(), Mode::Windows, None).is_err());
        let reopened = Store::open(Some(root.clone()));
        let presets = reopened.list().unwrap();
        assert_eq!(presets[0].mode, Mode::Mac);
        assert_eq!(presets[0].lighting, Some(Lighting::Breathing));
        assert!(reopened.delete("Office").unwrap().is_empty());
        assert!(store.list().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
