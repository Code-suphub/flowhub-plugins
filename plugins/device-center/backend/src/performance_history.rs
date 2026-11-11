use crate::local_preferences;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet, VecDeque}, path::PathBuf};

const FILE: &str = "adb-performance-history.json";
const SETTINGS: &str = "adb-performance-history-settings.json";
pub const INTERVAL: u64 = 60_000;
pub const MAX_DEVICES: usize = 16;
const MAX_POINTS: usize = 7 * 24 * 60 + 2;
const MAX_FILE: u64 = 32 * 1024 * 1024;

#[derive(Clone, Copy, Serialize, Deserialize)]
struct Settings { hours: u64, enabled: bool }
impl Default for Settings {
    fn default() -> Self { Self { hours: 48, enabled: true } }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Point {
    at: u64,
    cpu: Option<f64>,
    memory: Option<[u64; 2]>,
    storage: Option<[u64; 3]>,
}
impl Point {
    fn gap(at: u64) -> Self { Self { at, cpu: None, memory: None, storage: None } }
    fn empty(&self) -> bool { self.cpu.is_none() && self.memory.is_none() && self.storage.is_none() }
    fn validate(&mut self) {
        self.cpu = self.cpu.filter(|v| v.is_finite() && (0.0..=100.0).contains(v));
        self.memory = self.memory.filter(|[used, total]| *total > 0 && *total <= 9_007_199_254_740_991 && used <= total);
        self.storage = self.storage.filter(|[used, total, available]|
            *total > 0 && *total <= 9_007_199_254_740_991 && used.checked_add(*available).is_some_and(|sum| sum <= *total));
    }
}
type Records = BTreeMap<String, VecDeque<Point>>;

pub struct Store {
    root: Option<PathBuf>, settings: Settings, records: Records,
    revision: u64, saved: u64, error: Option<&'static str>,
}
impl Default for Store {
    fn default() -> Self {
        Self { root: None, settings: Settings::default(), records: Records::new(), revision: 0, saved: 0, error: None }
    }
}
pub fn valid_id(id: &str) -> bool {
    id.starts_with("adb-") && id.len() <= 80 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
impl Store {
    pub fn open(root: Option<PathBuf>, at: u64) -> Self {
        let mut store = Self { root, ..Self::default() };
        if let Some(root) = &store.root {
            match local_preferences::read::<Settings>(root, SETTINGS, 512) {
                Ok(Some(settings)) if matches!(settings.hours, 48 | 168) => store.settings = settings,
                Ok(None) => (),
                _ => store.error = Some("无法读取性能记录设置，暂不自动记录"),
            }
            if store.error.is_some() { store.settings.enabled = false; }
            match local_preferences::read::<Records>(root, FILE, MAX_FILE) {
                Ok(Some(records)) => store.records = records,
                Ok(None) => (),
                Err(_) => store.error = Some("无法读取上次的性能记录"),
            }
        }
        store.prune(at);
        // A restart is an actual interruption even when it lasted under a minute.
        store.offline(&BTreeSet::new(), at);
        store
    }
    pub fn enabled(&self) -> bool { self.settings.enabled }
    fn cutoff(&self, at: u64) -> u64 { at.saturating_sub(self.settings.hours * 3_600_000) }
    fn prune(&mut self, at: u64) {
        let cutoff = self.cutoff(at);
        self.records.retain(|id, points| {
            if !valid_id(id) { self.revision += 1; return false; }
            let before = points.len();
            let mut previous = 0;
            points.retain_mut(|point| {
                point.validate();
                if point.at < cutoff || point.at > at || point.at <= previous { return false; }
                previous = point.at;
                true
            });
            points.drain(..points.len().saturating_sub(MAX_POINTS));
            self.revision += u64::from(before != points.len());
            !points.is_empty()
        });
        while self.records.len() > MAX_DEVICES {
            let oldest = self.records.iter().min_by_key(|(_, points)| points.back().map(|p| p.at)).map(|(id, _)| id.clone()).unwrap();
            self.records.remove(&oldest); self.revision += 1;
        }
    }
    pub fn observe(&mut self, id: &str, sample: &Value, now: u64) {
        if !self.enabled() || !valid_id(id) || sample["status"] != "read" { return; }
        let Some(at) = sample["sampledAt"].as_u64().filter(|at| *at > 0 && *at <= now && now - *at < INTERVAL) else { return; };
        let mut point = Point {
            at, cpu: sample["cpuPercent"].as_f64(),
            memory: sample["memory"]["usedKiB"].as_u64().zip(sample["memory"]["totalKiB"].as_u64()).map(|(a,b)| [a,b]),
            storage: sample["storage"]["usedKiB"].as_u64().zip(sample["storage"]["totalKiB"].as_u64())
                .zip(sample["storage"]["availableKiB"].as_u64()).map(|((a,b),c)| [a,b,c]),
        };
        point.validate();
        let points = self.records.entry(id.into()).or_default();
        if points.back().is_some_and(|last| at <= last.at || !last.empty() && at / INTERVAL == last.at / INTERVAL) { return; }
        if point.empty() { self.gap(id, at); return; }
        points.push_back(point); self.revision += 1;
        self.prune(now);
    }
    pub fn gap(&mut self, id: &str, at: u64) {
        if let Some(points) = self.records.get_mut(id) {
            if points.back().is_some_and(|last| !last.empty() && at > last.at) {
                points.push_back(Point::gap(at)); self.revision += 1;
            }
        }
    }
    pub fn offline(&mut self, online: &BTreeSet<String>, at: u64) {
        let missing = self.records.keys().filter(|id| !online.contains(*id)).cloned().collect::<Vec<_>>();
        for id in missing { self.gap(&id, at); }
        self.prune(at);
    }
    pub fn settings(&mut self, hours: u64, enabled: bool, at: u64) -> Result<(), String> {
        if !matches!(hours, 48 | 168) { return Err("性能记录保留时间须为 48 小时或 7 天".into()); }
        let next = Settings { hours, enabled };
        local_preferences::write(self.root.as_ref().ok_or("性能记录目录不可用")?, SETTINGS, &next)
            .map_err(|_| "无法保存性能记录设置")?;
        self.settings = next;
        if !enabled { self.offline(&BTreeSet::new(), at); }
        self.prune(at);
        Ok(())
    }
    pub fn value(&self, id: &str, at: u64) -> Value {
        let from = self.cutoff(at);
        let points = self.records.get(id).into_iter().flatten().filter(|point| point.at >= from && point.at <= at).collect::<Vec<_>>();
        json!({"hours":self.settings.hours,"enabled":self.enabled(),"intervalSeconds":60,"from":from,"to":at,"points":points,"error":self.error})
    }
    pub fn pending(&mut self, at: u64) -> Option<Write> {
        self.prune(at);
        if self.revision == self.saved { return None; }
        Some(Write { root: self.root.clone()?, records: self.records.clone(), revision: self.revision })
    }
    pub fn finish(&mut self, revision: u64, success: bool) {
        if success { self.saved = revision; }
        self.error = (!success).then_some("无法保存性能记录");
    }
}
pub struct Write { root: PathBuf, records: Records, pub revision: u64 }
impl Write {
    pub fn save(&self) -> bool { local_preferences::write(&self.root, FILE, &self.records).is_ok() }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(at: u64, cpu: Value) -> Value {
        json!({"status":"read","sampledAt":at,"cpuPercent":cpu,"memory":{"usedKiB":4,"totalKiB":8},"storage":{"usedKiB":40,"totalKiB":100,"availableKiB":50}})
    }
    #[test]
    fn records_zero_and_partial_metrics_without_oversampling_and_breaks_on_disconnect() {
        let mut store = Store::default();
        store.observe("adb-phone-one", &sample(1000, json!(0)), 1000);
        store.observe("adb-phone-one", &sample(2000, json!(70)), 2000);
        store.observe("adb-phone-one", &sample(61_000, Value::Null), 61_000);
        store.offline(&BTreeSet::new(), 62_000);
        store.offline(&BTreeSet::new(), 63_000);
        store.observe("adb-phone-one", &sample(64_000, json!(30)), 64_000);
        let value = store.value("adb-phone-one", 65_000);
        let points = value["points"].as_array().unwrap();
        assert_eq!(points.len(), 4);
        assert_eq!(points[0]["cpu"].as_f64(), Some(0.0));
        assert!(points[1]["cpu"].is_null());
        assert_eq!(points[1]["memory"], json!([4,8]));
        assert!(points[2]["memory"].is_null());
        assert_eq!(points[3]["cpu"].as_f64(), Some(30.0));
    }
    #[test]
    fn persists_retention_and_pause_and_does_not_reconnect_history_across_restart() {
        let root = std::env::temp_dir().join(format!("flowhub-perf-history-{}-{}", std::process::id(), crate::now()));
        let hour = 3_600_000;
        let at = 200 * hour;
        let mut store = Store::open(Some(root.clone()), at);
        store.settings(168, true, at).unwrap();
        store.observe("adb-phone-one", &sample(at - 72*hour, json!(10)), at-72*hour);
        store.observe("adb-phone-one", &sample(at, json!(20)), at);
        let write = store.pending(at).unwrap(); assert!(write.save()); store.finish(write.revision, true);
        let mut restarted = Store::open(Some(root.clone()), at+1);
        assert_eq!(restarted.value("adb-phone-one", at+1)["points"].as_array().unwrap().len(), 3);
        restarted.settings(48, false, at+2).unwrap();
        restarted.observe("adb-phone-one", &sample(at+INTERVAL, json!(90)), at+INTERVAL);
        assert_eq!(restarted.value("adb-phone-one", at+INTERVAL)["points"].as_array().unwrap().len(), 2);
        assert!(restarted.pending(at+INTERVAL).unwrap().save());
        assert!(!Store::open(Some(root.clone()), at+INTERVAL).enabled());
        assert!(restarted.settings(24, true, at).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn malformed_values_and_identifiers_are_not_persisted_as_readings() {
        let mut store = Store::default();
        store.observe("raw-address:1234", &sample(1000, json!(20)), 1000);
        let mut invalid = sample(1000, json!(101));
        invalid["memory"]["usedKiB"] = json!(9);
        invalid["storage"]["availableKiB"] = json!(80);
        store.observe("adb-phone-one", &invalid, 1000);
        assert!(store.value("adb-phone-one", 2000)["points"].as_array().unwrap().is_empty());
        assert!(store.value("raw-address:1234", 2000)["points"].as_array().unwrap().is_empty());
    }
    #[test]
    fn stale_or_future_samples_do_not_erase_more_recent_device_records() {
        let mut store = Store::default();
        store.observe("adb-phone-two", &sample(62_000, json!(20)), 62_000);
        store.observe("adb-phone-one", &sample(61_000, json!(10)), 62_100);
        store.observe("adb-phone-one", &sample(63_000, json!(40)), 62_100);
        store.observe("adb-phone-one", &sample(1000, json!(90)), 62_100);
        assert_eq!(store.value("adb-phone-two", 62_100)["points"].as_array().unwrap().len(), 1);
        assert_eq!(store.value("adb-phone-one", 62_100)["points"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn bounds_loaded_point_counts_and_number_of_devices() {
        let mut store = Store::default();
        store.records.insert("adb-loaded".into(), (1..MAX_POINTS+200).map(|at| Point { at:at as u64, cpu:Some(10.0), memory:None, storage:None }).collect());
        store.prune((MAX_POINTS+200) as u64);
        assert_eq!(store.records["adb-loaded"].len(), MAX_POINTS);
        for i in 0..MAX_DEVICES+2 {
            let at = 100_000+i as u64;
            store.observe(&format!("adb-phone-{i}"), &sample(at, json!(20)), at);
        }
        assert_eq!(store.records.len(), MAX_DEVICES);
        assert!(!store.records.contains_key("adb-loaded"));
        assert!(!store.records.contains_key("adb-phone-0"));
    }
}
