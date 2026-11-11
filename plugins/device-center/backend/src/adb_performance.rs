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
const STORAGE_MARKER: &str = "__FLOWHUB_STORAGE_KIB__";
const QUERY: &str = "head -n 1 /proc/stat; sleep 0.3; head -n 1 /proc/stat; grep -E '^Mem(Total|Available):' /proc/meminfo; echo __FLOWHUB_STORAGE_KIB__; LC_ALL=C df -k /data; :";

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
    let storage = storage_usage(output);
    if cpu.is_none() && memory.is_none() && storage.is_none() {
        return Err("设备未提供可读取的 CPU、内存或存储数据".into());
    }
    Ok(json!({"status":"read","sampledAt":now(),"cpuPercent":cpu,"memory":memory,"storage":storage}))
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

fn storage_usage(text: &str) -> Option<Value> {
    let (_, table) = text.split_once(STORAGE_MARKER)?;
    let mut lines = table.lines().filter(|line| !line.trim().is_empty());
    let header = lines.next()?;
    if !header.split_whitespace().any(|field| {
        field.eq_ignore_ascii_case("1K-blocks") || field.eq_ignore_ascii_case("1024-blocks")
    }) { return None; }
    lines.find_map(|line| {
        let fields: Vec<_> = line.split_whitespace().collect();
        // Some df versions wrap a long filesystem name onto a separate line.
        let row = fields.get(fields.len().checked_sub(5)?..)?;
        let mount = row[4];
        if mount != "/data" && !mount.starts_with("/data/") { return None; }
        let total = row[0].parse::<u64>().ok()?;
        let used = row[1].parse::<u64>().ok()?;
        let available = row[2].parse::<u64>().ok()?;
        let percent = row[3].strip_suffix('%')?.parse::<u8>().ok()?;
        // Available space can exclude reserved blocks; do not infer it from used.
        if total == 0 || percent > 100 || used.checked_add(available)? > total { return None; }
        Some(json!({"usedKiB":used,"totalKiB":total,"availableKiB":available,"mountPoint":mount}))
    })
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

    #[test]
    fn storage_accepts_android_mount_alias_and_reserved_blocks() {
        let table = format!("permission denied\n{STORAGE_MARKER}\nFilesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/dm-61 235354092 107657796 127565224 46% /data/user/0\n");
        assert_eq!(storage_usage(&table), Some(json!({
            "usedKiB":107657796,"totalKiB":235354092,"availableKiB":127565224,"mountPoint":"/data/user/0"
        })));
    }

    #[test]
    fn storage_accepts_wrapped_filesystem_and_zero_usage() {
        let table = format!("{STORAGE_MARKER}\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/long-name\n 100 0 100 0% /data\n");
        assert_eq!(storage_usage(&table), Some(json!({
            "usedKiB":0,"totalKiB":100,"availableKiB":100,"mountPoint":"/data"
        })));
    }

    #[test]
    fn storage_rejects_unknown_units_other_mounts_and_invalid_ranges() {
        for (header, row) in [
            ("Size", "100G 40G 60G 40% /data"),
            ("512-blocks", "100 40 60 40% /data"),
            ("1K-blocks", "100 40 60 40% /sdcard"),
            ("1K-blocks", "100 40 60 40% /database"),
            ("1K-blocks", "0 0 0 0% /data"),
            ("1K-blocks", "100 -1 60 40% /data"),
            ("1K-blocks", "100 101 0 100% /data"),
            ("1K-blocks", "100 40 61 40% /data"),
            ("1K-blocks", "100 40 60 101% /data"),
            ("1K-blocks", "100 40 60 40 /data"),
            ("1K-blocks", "18446744073709551615 18446744073709551615 1 100% /data"),
        ] {
            assert!(storage_usage(&format!("{STORAGE_MARKER}\nFilesystem {header} Used Available Use% Mounted on\nfs {row}\n")).is_none(), "{header}: {row}");
        }
        assert!(storage_usage("Filesystem 1K-blocks\nfs 100 40 60 40% /data").is_none());
        assert!(storage_usage(&format!("{STORAGE_MARKER}\ndf: Permission denied")).is_none());
    }
}
