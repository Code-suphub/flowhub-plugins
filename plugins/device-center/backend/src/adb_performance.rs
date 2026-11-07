use crate::{adb, now, read_system_query};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

type Route = (String, Option<String>);
type Sample = (Instant, Value);

static CACHE: Mutex<Cache> = Mutex::new(Cache { pending: None, samples: BTreeMap::new() });
const FRESH: Duration = Duration::from_secs(5);
const QUERY: &str = "head -n 1 /proc/stat; sleep 0.3; head -n 1 /proc/stat; grep -E '^Mem(Total|Available):' /proc/meminfo; :";

struct Cache {
    pending: Option<Route>,
    samples: BTreeMap<Route, Sample>,
}

pub(super) fn request(info: &adb::Info, refresh: bool) -> Result<Value, String> {
    let route = (info.serial.clone(), info.transport_id.clone());
    let mut cache = CACHE.lock().map_err(|_| "ADB 采样暂不可用")?;
    cache.samples.retain(|_, (at, _)| at.elapsed() < FRESH);
    if refresh {
        cache.samples.remove(&route);
    } else if let Some((_, value)) = cache.samples.get(&route) {
        return Ok(value.clone());
    }
    if cache.pending.is_none() {
        cache.pending = Some(route.clone());
        if thread::Builder::new().name("adb-performance".into()).spawn(move || {
            let sample = collect(&route).unwrap_or_else(|error| json!({"status":"unavailable","error":error}));
            if let Ok(mut cache) = CACHE.lock() {
                cache.samples.insert(route, (Instant::now(), sample));
                cache.pending = None;
            }
        }).is_err() {
            cache.pending = None;
            return Err("无法启动 ADB 采样".into());
        }
    }
    Ok(json!({"status":"pending"}))
}

fn collect((serial, transport_id): &Route) -> Result<Value, String> {
    let program = adb::find().ok_or("未找到 ADB")?;
    let program = program.to_str().ok_or("ADB 路径无效")?;
    let (flag, target) = transport_id.as_deref().filter(|id| id.parse::<u64>().is_ok())
        .map_or(("-s", serial.as_str()), |id| ("-t", id));
    let output = read_system_query(program, &[flag, target, "shell", QUERY], Duration::from_secs(2), 4096)
        .map_err(|_| "ADB 采样失败，请确认设备仍在线后重试")?;
    let output = std::str::from_utf8(&output).map_err(|_| "ADB 采样格式无效")?;
    let cpu = cpu_usage(output);
    let memory = memory_usage(output);
    if cpu.is_none() && memory.is_none() {
        return Err("设备未提供可读取的 CPU 或内存数据".into());
    }
    Ok(json!({"status":"read","sampledAt":now(),"cpuPercent":cpu,"memory":memory}))
}

fn cpu_counters(line: &str) -> Option<[u64; 8]> {
    let mut fields = line.split_whitespace();
    if fields.next()? != "cpu" { return None; }
    let mut counters = [0; 8];
    for counter in &mut counters {
        *counter = fields.next()?.parse().ok()?;
    }
    Some(counters)
}

fn cpu_usage(text: &str) -> Option<f64> {
    let mut samples = text.lines().filter_map(cpu_counters);
    let first = samples.next()?;
    let second = samples.next()?;
    let mut total = 0_u128;
    let mut busy = 0_u128;
    for (index, (after, before)) in second.into_iter().zip(first).enumerate() {
        let delta = u128::from(after.checked_sub(before)?);
        total += delta;
        if index != 3 && index != 4 { busy += delta; }
    }
    (total > 0).then(|| (busy as f64 * 1000.0 / total as f64).round() / 10.0)
}

fn memory_usage(text: &str) -> Option<Value> {
    let field = |name: &str| -> Option<u64> {
        let mut fields = text.lines().find_map(|line| line.strip_prefix(name))?.split_whitespace();
        let value = fields.next()?.parse::<u64>().ok()?;
        (fields.next()? == "kB").then_some(value)
    };
    let total = field("MemTotal:")?;
    let available = field("MemAvailable:")?;
    let used = total.checked_sub(available)?;
    (total > 0).then(|| json!({"usedKiB":used,"totalKiB":total}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_aggregate_deltas_without_counting_guest_twice_or_iowait_as_work() {
        let before = "cpu 10 0 10 50 20 0 0 0 5 0";
        let after = "cpu 30 0 20 110 30 0 0 0 15 0";
        assert_eq!(cpu_usage(&format!("{before}\ncpu0 1 0 1 1 1 0 0 0\n{after}")), Some(30.0));
        assert_eq!(cpu_usage(&format!("{after}\n{before}")), None);
        assert_eq!(cpu_usage(&format!("{before}\n{before}")), None);
        assert_eq!(cpu_usage(before), None);
    }

    #[test]
    fn memory_requires_available_ram_and_rejects_invalid_units_or_totals() {
        assert_eq!(memory_usage("MemTotal: 16384 kB\nMemFree: 128 kB\nMemAvailable: 8192 kB"),
            Some(json!({"usedKiB":8192,"totalKiB":16384})));
        assert!(memory_usage("MemTotal: 10 kB\nMemFree: 10 kB").is_none());
        assert!(memory_usage("MemTotal: 10 kB\nMemAvailable: 20 kB").is_none());
        assert!(memory_usage("MemTotal: 10 MB\nMemAvailable: 2 kB").is_none());
    }
}
