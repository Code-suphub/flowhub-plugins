use super::{local_preferences, Device};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, VecDeque}, path::PathBuf};

const FILE: &str = "battery-history.json";
const SETTINGS: &str = "battery-history-retention.json";
const HOUR: u64 = 3_600_000;
const HEARTBEAT: u64 = 15 * 60_000;
const MAX_POINTS: usize = 960;
const MAX_DEVICES: usize = 128;
const MAX_FILE: u64 = 12 * 1024 * 1024;
const DEFAULT_HOURS: u64 = 48;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source { SystemProfiler, Pmset, Adb }

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct Reading { percent: u8, source: Source }

#[derive(Clone, Serialize, Deserialize)]
struct Point { at: u64, #[serde(flatten)] reading: Option<Reading> }

#[derive(Clone, Serialize, Deserialize)]
struct Series { adb: bool, points: VecDeque<Point> }

type Records = BTreeMap<String, Series>;

pub struct Store {
    root: Option<PathBuf>,
    hours: u64,
    records: Records,
    revision: u64,
    saved: u64,
    error: Option<&'static str>,
}

impl Default for Store {
    fn default() -> Self {
        Self { root: None, hours: DEFAULT_HOURS, records: Records::new(), revision: 0, saved: 0, error: None }
    }
}

impl Store {
    pub fn open(root: Option<PathBuf>, now: u64) -> Self {
        let mut store = Self { root, ..Self::default() };
        if let Some(root) = &store.root {
            store.hours = local_preferences::read::<u64>(root, SETTINGS, 64).ok().flatten()
                .filter(|hours| matches!(hours, 48 | 168)).unwrap_or(DEFAULT_HOURS);
            match local_preferences::read(root, FILE, MAX_FILE) {
                Ok(Some(records)) => store.records = records,
                Ok(None) => (),
                Err(_) => store.error = Some("无法读取上次的电量记录"),
            }
        }
        store.prune(now);
        store
    }

    fn cutoff(&self, now: u64) -> u64 { now.saturating_sub(self.hours * HOUR) }

    fn prune(&mut self, now: u64) {
        let cutoff = self.cutoff(now);
        let mut changed = false;
        self.records.retain(|_, series| {
            let before = series.points.len();
            series.points.retain(|point| point.at >= cutoff && point.at <= now
                && point.reading.is_none_or(|r| r.percent <= 100));
            series.points.drain(..series.points.len().saturating_sub(MAX_POINTS));
            changed |= series.points.len() != before || series.points.is_empty();
            !series.points.is_empty()
        });
        while self.records.len() > MAX_DEVICES {
            let oldest = self.records.iter().min_by_key(|(_, series)| series.points.back().map(|p| p.at))
                .map(|(id, _)| id.clone()).unwrap();
            self.records.remove(&oldest);
            changed = true;
        }
        self.revision += u64::from(changed);
    }

    // Call only after a successful scan. Failed queries keep the last known
    // reading intact; absence in a successful scan creates an explicit gap.
    pub fn observe(&mut self, devices: &[Device], adb: bool, at: u64) {
        let readings: BTreeMap<&str, Reading> = devices.iter().filter_map(|device| {
            if device.status != "connected" { return None; }
            let percent = device.battery.as_deref()?.strip_suffix('%')?.parse::<u8>().ok()?;
            let source = if adb { Source::Adb } else { device.battery_source? };
            (percent <= 100).then_some((device.id.as_str(), Reading { percent, source }))
        }).collect();
        for (id, series) in self.records.iter_mut().filter(|(_, s)| s.adb == adb) {
            if !readings.contains_key(id.as_str()) && series.points.back().is_some_and(|p| p.reading.is_some()) {
                series.points.push_back(Point { at, reading: None });
                self.revision += 1;
            }
        }
        for (id, reading) in readings {
            let series = self.records.entry(id.into()).or_insert_with(|| Series { adb, points: VecDeque::new() });
            if series.points.back().is_none_or(|point|
                point.reading != Some(reading) || at.saturating_sub(point.at) >= HEARTBEAT)
            {
                series.points.push_back(Point { at, reading: Some(reading) });
                self.revision += 1;
            }
        }
        self.prune(at);
    }

    pub fn value(&self, id: &str, now: u64) -> Value {
        let from = self.cutoff(now);
        let points: Vec<_> = self.records.get(id).into_iter().flat_map(|s| &s.points)
            .filter(|p| p.at >= from && p.at <= now).collect();
        json!({"hours":self.hours,"from":from,"to":now,"points":points,"error":self.error})
    }

    pub fn set_hours(&mut self, hours: u64, now: u64) -> Result<(), String> {
        if !matches!(hours, 48 | 168) { return Err("日志保留时间须为 48 小时或 7 天".into()); }
        let root = self.root.as_ref().ok_or("日志目录不可用")?;
        local_preferences::write(root, SETTINGS, &hours).map_err(|_| "无法保存电量日志设置")?;
        self.hours = hours;
        self.prune(now);
        Ok(())
    }

    pub fn pending(&mut self, now: u64) -> Option<Write> {
        self.prune(now);
        let root = self.root.as_ref()?;
        (self.revision != self.saved).then(|| Write { root: root.clone(), records: self.records.clone(), revision: self.revision })
    }

    pub fn finish(&mut self, revision: u64, success: bool) {
        if success { self.saved = revision; }
        self.error = (!success).then_some("无法保存电量日志");
    }
}

pub struct Write { root: PathBuf, records: Records, pub revision: u64 }
impl Write {
    pub fn save(&self) -> bool { local_preferences::write(&self.root, FILE, &self.records).is_ok() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_jumps_and_source_changes_and_leaves_gaps() {
        let mut store = Store::default();
        let mut device = crate::device("bluetooth", "K75".into(), "Keyboard".into(), String::new(), Some("30%".into()), None, None);
        device.battery_source = Some(Source::SystemProfiler);
        store.observe(&[device.clone()], false, 1000);
        store.observe(&[device.clone()], false, 2000);
        device.battery = Some("100%".into());
        store.observe(&[device.clone()], false, 3000);
        device.battery_source = Some(Source::Pmset);
        store.observe(&[device.clone()], false, 4000);
        store.observe(&[], true, 5000);
        store.observe(&[], false, 6000);
        let value = store.value(&device.id, 7000);
        assert_eq!(value["points"], json!([
            {"at":1000,"percent":30,"source":"system_profiler"},
            {"at":3000,"percent":100,"source":"system_profiler"},
            {"at":4000,"percent":100,"source":"pmset"},
            {"at":6000},
        ]));
        assert_eq!(store.value(&device.id, 48 * HOUR + 7000)["points"], json!([]));
    }

    #[test]
    fn persists_selected_retention_and_prunes_on_change() {
        let root = std::env::temp_dir().join(format!("flowhub-battery-history-{}-{}", std::process::id(), crate::now()));
        let at = 150 * HOUR;
        let mut store = Store::open(Some(root.clone()), at);
        assert!(store.set_hours(24, at).is_err());
        store.set_hours(168, at).unwrap();
        let mut device = crate::device("bluetooth", "Public Keyboard".into(), "Keyboard".into(), String::new(), Some("30%".into()), None, None);
        device.battery_source = Some(Source::Pmset);
        store.observe(&[device.clone()], false, at - 72 * HOUR);
        store.observe(&[], false, at - 60 * HOUR);
        device.battery = Some("100%".into());
        store.observe(&[device.clone()], false, at);
        let write = store.pending(at).unwrap();
        assert!(write.save());
        let mut restarted = Store::open(Some(root.clone()), at);
        let before = restarted.value(&device.id, at);
        assert_eq!(before["hours"], 168);
        assert_eq!(before["points"].as_array().unwrap().len(), 3);
        restarted.set_hours(48, at).unwrap();
        assert_eq!(restarted.value(&device.id, at)["points"].as_array().unwrap().len(), 1);
        assert!(restarted.pending(at).unwrap().save());
        let mut restarted = Store::open(Some(root.clone()), at);
        restarted.set_hours(168, at).unwrap();
        assert_eq!(restarted.value(&device.id, at)["points"].as_array().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
