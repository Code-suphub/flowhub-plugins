//! Local VM traffic estimates from Netdata rates or persisted SSH NIC counters.
//! Monthly windows can be anchored to the machine's provider reset day.
use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::path::Path;

const GIB: f64 = 1_073_741_824.0;
const SECONDS_PER_DAY: f64 = 86_400.0;
const SHANGHAI_OFFSET_SECONDS: i32 = 8 * 60 * 60;
const MAX_MONTH_SECONDS: u64 = 31 * 86_400;

fn selected_bytes(rx: f64, tx: f64, direction: Option<&str>) -> f64 {
    if direction == Some("tx") { tx } else { rx + tx }
}

fn direction_name(direction: Option<&str>) -> &'static str {
    if direction == Some("tx") { "tx" } else { "both" }
}

fn dimension_index(history: &Value, wanted: &[&str]) -> Option<usize> {
    history["labels"].as_array()?.iter().enumerate().find_map(|(i, label)| {
        let name = label.as_str()?.to_ascii_lowercase().replace(['_', '-'], "");
        wanted.iter().any(|candidate| name == candidate.to_ascii_lowercase().replace(['_', '-'], "")).then_some(i)
    })
}

/// Integrate Netdata's network rate series. Netdata's network charts are rates
/// in kilobits/s, even when the dimensions are exposed as InOctets/OutOctets.
/// The API returns rows `[timestamp, rx, tx]`, not one array per dimension.
fn history_bytes(history: &Value, start: f64, end: f64) -> Result<(f64, f64), String> {
    let rx_idx = dimension_index(history, &["received", "rx", "inoctets", "in"])
        .ok_or("Netdata 历史数据缺少接收流量维度")?;
    let tx_idx = dimension_index(history, &["sent", "tx", "outoctets", "out"])
        .ok_or("Netdata 历史数据缺少发送流量维度")?;
    let mut rows = history["data"].as_array().cloned().unwrap_or_default();
    rows.sort_by(|a,b| a[0].as_f64().partial_cmp(&b[0].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
    let mut total_rx = 0.0;
    let mut total_tx = 0.0;
    for pair in rows.windows(2) {
        let t0 = pair[0][0].as_f64();
        let t1 = pair[1][0].as_f64();
        let (a, b) = match (t0, t1) {
            (Some(a), Some(b)) if b > a && b-a <= 86_400.0 => (a, b),
            _ => continue,
        };
        let left = a.max(start);
        let right = b.min(end);
        if right <= left { continue; }
        let rate = |row: &Value, index: usize| row[index].as_f64().filter(|v| v.is_finite()).map(|v| v.abs());
        let interpolate = |index: usize, at: f64| -> Option<f64> {
            let first = rate(&pair[0], index)?;
            let last = rate(&pair[1], index)?;
            Some(first + (last-first) * (at-a) / (b-a))
        };
        if let (Some(first), Some(last)) = (interpolate(rx_idx, left), interpolate(rx_idx, right)) { total_rx += (first+last)/2.0 * 1000.0/8.0 * (right-left); }
        if let (Some(first), Some(last)) = (interpolate(tx_idx, left), interpolate(tx_idx, right)) { total_tx += (first+last)/2.0 * 1000.0/8.0 * (right-left); }
    }
    if total_rx == 0.0 && total_tx == 0.0 && rows.len() < 2 { return Err("Netdata 历史数据不足，暂时无法计算流量".into()); }
    Ok((total_rx, total_tx))
}

fn history_is_partial(history: &Value, start: i64, end: i64) -> Result<(bool, i64), String> {
    let rx_idx = dimension_index(history, &["received", "rx", "inoctets", "in"]).ok_or("Netdata 历史数据缺少接收流量维度")?;
    let tx_idx = dimension_index(history, &["sent", "tx", "outoctets", "out"]).ok_or("Netdata 历史数据缺少发送流量维度")?;
    let mut times: Vec<i64> = history["data"].as_array().into_iter().flatten()
        .filter(|row| row[rx_idx].as_f64().is_some_and(f64::is_finite) && row[tx_idx].as_f64().is_some_and(f64::is_finite))
        .filter_map(|row| row[0].as_i64()).collect();
    times.sort_unstable();
    if times.len() < 2 { return Err("Netdata 历史数据不足，暂时无法计算流量".into()); }
    let mut gaps: Vec<i64> = times.windows(2).map(|pair| pair[1] - pair[0]).filter(|gap| *gap > 0).collect();
    gaps.sort_unstable();
    let typical = gaps.get(gaps.len() / 2).copied().unwrap_or(0);
    let tolerance = (typical * 2).max(3_600);
    let partial = times[0] > start + tolerance || *times.last().unwrap() < end - tolerance || gaps.iter().any(|gap| *gap > (typical * 4).max(86_400));
    Ok((partial, times[0]))
}

fn parse_cycle_start(value: &str) -> Result<NaiveDateTime, String> {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M"))
        .or_else(|_| NaiveDate::parse_from_str(value, "%Y-%m-%d").map(|date| date.and_hms_opt(0, 0, 0).unwrap()))
        .map_err(|_| "周期起始时间应为 YYYY-MM-DDTHH:mm:ss（北京时间）".into())
}

pub(crate) fn validate_cycle_start(value: &str) -> Result<(), String> {
    if value.is_empty() { return Ok(()); }
    let anchor = parse_cycle_start(value)?;
    let now = Utc::now().with_timezone(&FixedOffset::east_opt(SHANGHAI_OFFSET_SECONDS).unwrap());
    if anchor > now.naive_local() { return Err("周期起始时间不能晚于现在".into()); }
    Ok(())
}

fn month_start(offset: FixedOffset, year: i32, month: u32, day: u32, time: NaiveTime) -> DateTime<FixedOffset> {
    let last_day = (NaiveDate::from_ymd_opt(if month == 12 { year + 1 } else { year }, if month == 12 { 1 } else { month + 1 }, 1).unwrap() - Duration::days(1)).day();
    offset.from_local_datetime(&NaiveDate::from_ymd_opt(year, month, day.min(last_day)).unwrap().and_time(time)).single().unwrap()
}

fn current_month_window(now: DateTime<Utc>, cycle_start: Option<&str>) -> Result<(i64, u64, f64, DateTime<FixedOffset>, DateTime<FixedOffset>), String> {
    let offset = FixedOffset::east_opt(SHANGHAI_OFFSET_SECONDS).unwrap();
    let local_now = now.with_timezone(&offset);
    let anchor = cycle_start.filter(|value| !value.is_empty()).map(parse_cycle_start).transpose()?;
    if anchor.is_some_and(|date| date > local_now.naive_local()) { return Err("周期起始时间不能晚于现在".into()); }
    let day = anchor.map(|date| date.day()).unwrap_or(1);
    let time = anchor.map(|date| date.time()).unwrap_or(NaiveTime::MIN);
    let candidate = month_start(offset, local_now.year(), local_now.month(), day, time);
    let (year, month) = if candidate > local_now {
        if local_now.month() == 1 { (local_now.year() - 1, 12) } else { (local_now.year(), local_now.month() - 1) }
    } else { (local_now.year(), local_now.month()) };
    let start_local = month_start(offset, year, month, day, time);
    let (next_year, next_month) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    let end_local = month_start(offset, next_year, next_month, day, time);
    let start_utc = start_local.with_timezone(&Utc);
    let elapsed = (now-start_utc).num_seconds().max(1) as u64;
    Ok((start_utc.timestamp(), elapsed, elapsed as f64 / SECONDS_PER_DAY, start_local, end_local))
}

#[derive(Clone, Copy)]
struct CounterSample { at_ms: i64, rx: f64, tx: f64, uptime: f64 }

fn sum_counters(samples: &[CounterSample], start_ms: i64, interval: u64) -> Result<(f64, f64, bool), String> {
    if samples.len() < 2 { return Err("需要至少两次 SSH 网卡采样后才能计算累计用量".into()); }
    let tolerance_ms = (interval.clamp(30, 3_600) * 2 * 1_000) as i64;
    let mut partial = samples[0].at_ms > start_ms + tolerance_ms;
    let (mut rx, mut tx) = (0.0, 0.0);
    for pair in samples.windows(2) {
        let [a, b] = [pair[0], pair[1]];
        if b.at_ms <= a.at_ms { continue; }
        if b.rx < a.rx || b.tx < a.tx || b.uptime < a.uptime {
            partial = true;
            continue;
        }
        rx += b.rx - a.rx;
        tx += b.tx - a.tx;
    }
    Ok((rx, tx, partial))
}

// A boot-aligned cycle can use /proc/net/dev's cumulative counters as a
// provisional baseline. Reject reboot/reset evidence and boot-time drift.
fn boot_aligned_counters(samples: &[CounterSample], start_ms: i64) -> Option<(f64, f64)> {
    let first = *samples.first()?;
    let last = *samples.last()?;
    let aligned = |sample: CounterSample| (sample.at_ms as f64 - sample.uptime * 1_000.0 - start_ms as f64).abs() <= 120_000.0;
    if !aligned(first) || !aligned(last) { return None; }
    if samples.iter().any(|sample| !aligned(*sample)) { return None; }
    if samples.windows(2).any(|pair| pair[1].at_ms <= pair[0].at_ms || pair[1].rx < pair[0].rx || pair[1].tx < pair[0].tx || pair[1].uptime < pair[0].uptime) { return None; }
    Some((last.rx, last.tx))
}

pub fn query_ssh(root: &Path, host: &str, limit_gb: f64, cycle_start: Option<&str>, direction: Option<&str>, interval: u64) -> Result<Value, String> {
    let now = Utc::now();
    let (start, _, period_days, start_local, end_local) = current_month_window(now, cycle_start)?;
    let path = root.join("commands.sqlite3");
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| "尚无机器采集历史，请先开启 SSH 基础采集")?;
    let mut stmt = db.prepare("SELECT at, json_extract(data,'$.netRxBytes'), json_extract(data,'$.netTxBytes'), json_extract(data,'$.uptime') FROM metric_samples WHERE host=?1 AND source='ssh' AND status='success' AND at>=?2 AND at<=?3 ORDER BY at")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![host, start * 1_000, now.timestamp_millis()], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<f64>>(1)?, row.get::<_, Option<f64>>(2)?, row.get::<_, Option<f64>>(3)?)))
        .map_err(|e| e.to_string())?;
    let mut samples = Vec::new();
    for row in rows {
        let (at_ms, rx, tx, uptime) = row.map_err(|e| e.to_string())?;
        if let (Some(rx), Some(tx), Some(uptime)) = (rx, tx, uptime) {
            if rx.is_finite() && tx.is_finite() && uptime.is_finite() && rx >= 0.0 && tx >= 0.0 && uptime >= 0.0 {
                samples.push(CounterSample { at_ms, rx, tx, uptime });
            }
        }
    }
    let (mut rx, mut tx, mut partial) = sum_counters(&samples, start * 1_000, interval)?;
    let baseline = cycle_start.filter(|value| !value.is_empty()).and_then(|_| boot_aligned_counters(&samples, start * 1_000));
    let boot_baseline = baseline.is_some();
    if let Some(counters) = baseline {
        (rx, tx) = counters;
        partial = false;
    }
    let used = selected_bytes(rx, tx, direction);
    let limit_bytes = limit_gb * GIB;
    let daily_days = if partial { ((now.timestamp_millis() - samples[0].at_ms) as f64 / 86_400_000.0).max(1.0 / 86_400.0) } else { period_days };
    let daily_avg = used / daily_days;
    let remaining = (limit_bytes - used).max(0.0);
    Ok(json!({
        "provider":"localSsh", "at":now.to_rfc3339(), "rows":[{
            "InstanceId":host, "TrafficPackageSet":[{
                "TrafficPackageTotal":limit_bytes, "TrafficUsed":used,
                "TrafficPackageRemaining":if partial { None } else { Some(remaining) },
                "TrafficOverflow":if partial { None } else { Some((used-limit_bytes).max(0.0)) },
                "StartTime":start_local.to_rfc3339(), "EndTime":end_local.to_rfc3339(),
                "CoverageStartTime":DateTime::<Utc>::from_timestamp_millis(if boot_baseline { start * 1_000 } else { samples[0].at_ms }).map(|time|time.to_rfc3339()),
                "PartialHistory":partial,
                "BootBaseline":boot_baseline,
                "CycleType":if cycle_start.is_some_and(|value|!value.is_empty()) { "purchaseDay" } else { "calendarMonth" },
                "RxBytes":rx, "TxBytes":tx, "TrafficDirection":direction_name(direction), "DailyAverage":daily_avg,
                "DaysRemaining":if partial || limit_gb<=0.0 || daily_avg<=0.0 { None } else { Some(remaining/daily_avg) },
                "PeriodDays":period_days, "LimitGB":limit_gb,
                "PercentUsed":if partial || limit_gb<=0.0 { None } else { Some((used/limit_bytes*100.0).clamp(0.0,100.0)) }
            }]
        }]
    }))
}

pub async fn query(instance: &crate::monitoring::netdata::Instance, limit_gb: f64, cycle_start: Option<&str>, direction: Option<&str>) -> Result<Value, String> {
    instance.validate()?;

    let chart = if instance.network_chart.is_empty() {
        "system.net"
    } else {
        instance.network_chart.as_str()
    };
    let now = Utc::now();
    let (month_start, elapsed_seconds, period_days, month_start_local, month_end_local) = current_month_window(now, cycle_start)?;
    let history_seconds = elapsed_seconds.max(3_600).min(MAX_MONTH_SECONDS);
    let history = crate::monitoring::netdata::history(instance, chart, history_seconds).await?;
    let (period_rx, period_tx) = history_bytes(&history, month_start as f64, now.timestamp() as f64)?;
    // Netdata down-samples to 180 points. Treat gaps and truncated retention
    // as partial data instead of presenting a false package balance.
    let (partial, first_sample) = history_is_partial(&history, month_start, now.timestamp())?;
    let total = selected_bytes(period_rx, period_tx, direction);
    let covered_days = if partial { ((now.timestamp() - first_sample) as f64 / SECONDS_PER_DAY).max(1.0 / SECONDS_PER_DAY) } else { period_days };
    let daily_avg = if total > 0.0 {
        total / covered_days
    } else {
        0.0
    };

    let limit_bytes = (limit_gb as f64) * GIB;
    let remaining = (limit_bytes - total).max(0.0);
    let overflow = (total - limit_bytes).max(0.0);
    let days_remaining = if daily_avg > 0.0 && limit_gb > 0.0 {
        remaining / daily_avg
    } else {
        0.0
    };
    let percent_used = if limit_bytes > 0.0 {
        (total / limit_bytes * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };

    Ok(json!({
        "provider": "localNet",
        "instanceName": instance.name,
        "instanceId": instance.id,
        "at": now.to_rfc3339(),
        "rows": [{
            "InstanceId": instance.id,
            "TrafficPackageSet": [{
                "TrafficPackageTotal": limit_bytes,
                "TrafficUsed": total,
                "TrafficPackageRemaining": if partial { None } else { Some(remaining) },
                "TrafficOverflow": if partial { None } else { Some(overflow) },
                "StartTime": month_start_local.to_rfc3339(),
                "EndTime": month_end_local.to_rfc3339(),
                "CoverageStartTime": DateTime::<Utc>::from_timestamp(first_sample, 0).map(|time| time.to_rfc3339()),
                "PartialHistory": partial,
                "CycleType": if cycle_start.is_some_and(|value| !value.is_empty()) { "purchaseDay" } else { "calendarMonth" },
                "RxBytes": period_rx,
                "TxBytes": period_tx,
                "TrafficDirection": direction_name(direction),
                "DailyAverage": daily_avg,
                "DaysRemaining": if partial { None } else { Some(days_remaining) },
                "PeriodDays": period_days,
                "LimitGB": limit_gb,
                "PercentUsed": if partial { None } else { Some(percent_used) },
            }]
        }]
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn history_bytes_integrates_rows_and_aliases_dimensions() {
        let data = json!({
            "labels": ["time", "InOctets", "OutOctets"],
            "data": [
                [1000, 8.0, 16.0],
                [1010, 8.0, 16.0],
            ]
        });
        let (rx, tx) = history_bytes(&data, 1000.0, 1010.0).unwrap();
        assert_eq!(rx, 10_000.0);
        assert_eq!(tx, 20_000.0);
    }

    #[test]
    fn local_direction_defaults_to_both_and_can_count_outbound_only() {
        assert_eq!(selected_bytes(70.0, 90.0, None), 160.0);
        assert_eq!(selected_bytes(70.0, 90.0, Some("both")), 160.0);
        assert_eq!(selected_bytes(70.0, 90.0, Some("tx")), 90.0);
    }

    #[test]
    fn history_bytes_accepts_received_sent_labels() {
        let data = json!({
            "labels": ["time", "received", "sent"],
            "data": [
                [1000, 42.0, 7.0],
                [1010, 43.0, 8.0],
            ]
        });
        let (rx, tx) = history_bytes(&data, 1000.0, 1010.0).unwrap();
        assert_eq!(rx, 53_125.0);
        assert_eq!(tx, 9_375.0);
    }

    #[test]
    fn history_bytes_skips_null_samples() {
        let data = json!({
            "labels": ["time", "received", "sent"],
            "data": [
                [1000, null, 60_000.0],
                [1010, 11_000.0, 12_000.0],
                [1020, 13_000.0, 14_000.0],
            ]
        });
        let (rx, tx) = history_bytes(&data, 1000.0, 1020.0).unwrap();
        assert_eq!(rx, 15_000_000.0);
        assert_eq!(tx, 61_250_000.0);
    }

    #[test]
    fn history_coverage_detects_missing_cycle_start_and_gaps() {
        let data = json!({"labels":["time","received","sent"],"data":[[0,1,1],[3600,1,1],[7200,1,1]]});
        assert_eq!(history_is_partial(&data, 0, 7200).unwrap(), (false, 0));
        assert_eq!(history_is_partial(&data, -10_000, 7200).unwrap(), (true, 0));
        let gap = json!({"labels":["time","received","sent"],"data":[[0,1,1],[3600,1,1],[100_000,1,1],[103_600,1,1]]});
        assert!(history_is_partial(&gap, 0, 103_600).unwrap().0);
    }

    #[test]
    fn daily_average_handles_counter_reset_without_panicking() {
        let rx = 20.0_f64;
        let start_rx = 1000.0_f64;
        let period_rx = (rx - start_rx).max(0.0);
        assert_eq!(period_rx, 0.0);
        let daily_avg = if period_rx > 0.0 { period_rx / 30.0 } else { 0.0 };
        assert_eq!(daily_avg, 0.0);
    }

    #[test]
    fn days_remaining_uses_clamped_remaining_and_daily_average() {
        let limit = 500.0_f64 * GIB;
        let used = 50.0_f64 * GIB;
        let daily = 14.49_f64 * GIB;
        let remaining = (limit - used).max(0.0);
        let days = remaining / daily;
        assert!((days - 31.056).abs() < 0.01);
    }

    #[test]
    fn days_remaining_zero_when_no_limit_configured() {
        let limit_bytes = 0.0_f64;
        let daily_avg = 14.0_f64 * GIB;
        let days = if daily_avg > 0.0 && limit_bytes > 0.0 {
            (limit_bytes - 100.0_f64 * GIB).max(0.0) / daily_avg
        } else {
            0.0
        };
        assert_eq!(days, 0.0);
    }

    #[test]
    fn month_window_starts_at_shanghai_month_boundary() {
        let now = Utc.with_ymd_and_hms(2026, 9, 18, 8, 0, 0).unwrap();
        let (start, seconds, days, local, end) = current_month_window(now, None).unwrap();
        assert_eq!(local.to_rfc3339(), "2026-09-01T00:00:00+08:00");
        assert_eq!(start, Utc.with_ymd_and_hms(2026, 8, 31, 16, 0, 0).unwrap().timestamp());
        assert_eq!(seconds, 17 * 86_400 + 16 * 3_600);
        assert_eq!(days, 17.0 + 16.0 / 24.0);
        assert_eq!(end.to_rfc3339(), "2026-10-01T00:00:00+08:00");
    }

    #[test]
    fn purchase_day_window_crosses_calendar_month_and_clamps_short_month() {
        let now = Utc.with_ymd_and_hms(2026, 2, 10, 0, 0, 0).unwrap();
        let (_, _, _, start, end) = current_month_window(now, Some("2025-01-31")).unwrap();
        assert_eq!(start.to_rfc3339(), "2026-01-31T00:00:00+08:00");
        assert_eq!(end.to_rfc3339(), "2026-02-28T00:00:00+08:00");
        let now = Utc.with_ymd_and_hms(2026, 3, 1, 0, 0, 0).unwrap();
        let (_, _, _, start, end) = current_month_window(now, Some("2025-01-31")).unwrap();
        assert_eq!(start.to_rfc3339(), "2026-02-28T00:00:00+08:00");
        assert_eq!(end.to_rfc3339(), "2026-03-31T00:00:00+08:00");
    }

    #[test]
    fn monthly_window_preserves_beijing_hour_minute_and_second() {
        let now = Utc.with_ymd_and_hms(2026, 9, 26, 17, 0, 0).unwrap();
        let (_, _, _, start, end) = current_month_window(now, Some("2026-09-16T19:54:19")).unwrap();
        assert_eq!(start.to_rfc3339(), "2026-09-16T19:54:19+08:00");
        assert_eq!(end.to_rfc3339(), "2026-10-16T19:54:19+08:00");
        assert!(current_month_window(now, Some("2026-09-27T01:00:01")).is_err());
    }

    #[test]
    fn purchase_day_must_be_valid_and_not_future() {
        let now = Utc.with_ymd_and_hms(2026, 9, 18, 8, 0, 0).unwrap();
        assert!(current_month_window(now, Some("2026-02-30")).is_err());
        assert!(current_month_window(now, Some("2026-10-01")).is_err());
    }

    #[test]
    fn ssh_counters_sum_both_directions_and_mark_missing_baseline_or_reboot() {
        let sample = |at_ms, rx, tx, uptime| CounterSample { at_ms, rx, tx, uptime };
        let samples = [sample(1_000, 100.0, 200.0, 100.0), sample(61_000, 140.0, 260.0, 160.0), sample(121_000, 170.0, 290.0, 220.0)];
        assert_eq!(sum_counters(&samples, 0, 60).unwrap(), (70.0, 90.0, false));
        assert_eq!(sum_counters(&samples, -200_000, 60).unwrap(), (70.0, 90.0, true));
        let rebooted = [samples[0], sample(61_000, 10.0, 20.0, 2.0), sample(121_000, 40.0, 50.0, 62.0)];
        assert_eq!(sum_counters(&rebooted, 0, 60).unwrap(), (30.0, 30.0, true));
    }

    #[test]
    fn boot_aligned_cycle_uses_cumulative_bytes_only_without_resets() {
        let start_ms = 1_000_000_000i64;
        let first = CounterSample { at_ms: start_ms + 10 * 86_400_000, rx: 124_000.0, tx: 125_000.0, uptime: 10.0 * 86_400.0 };
        let last = CounterSample { at_ms: first.at_ms + 60_000, rx: 125_000.0, tx: 127_000.0, uptime: first.uptime + 60.0 };
        assert_eq!(boot_aligned_counters(&[first, last], start_ms), Some((125_000.0, 127_000.0)));
        assert_eq!(boot_aligned_counters(&[first, last], start_ms - 3 * 60_000), None);
        let reset = CounterSample { rx: 100.0, ..last };
        assert_eq!(boot_aligned_counters(&[first, reset], start_ms), None);
    }

    #[test]
    fn ssh_query_reads_persisted_counters_and_marks_current_cycle_partial() {
        let root = std::env::temp_dir().join(format!("ssh-counters-{}", Utc::now().timestamp_nanos_opt().unwrap()));
        std::fs::create_dir_all(&root).unwrap();
        let db = Connection::open(root.join("commands.sqlite3")).unwrap();
        db.execute_batch("CREATE TABLE metric_samples(id TEXT PRIMARY KEY,host TEXT,at INTEGER,status TEXT,source TEXT,data TEXT)").unwrap();
        let now = Utc::now().timestamp_millis();
        for (id, at, rx, tx) in [("a", now - 120_000, 1_000, 2_000), ("b", now - 60_000, 1_400, 2_500)] {
            db.execute("INSERT INTO metric_samples VALUES (?1,'machine',?2,'success','ssh',?3)", params![id, at, json!({"netRxBytes":rx,"netTxBytes":tx,"uptime":1000+(at-now+120_000)/1000}).to_string()]).unwrap();
        }
        drop(db);
        let result = query_ssh(&root, "machine", 500.0, Some("2025-01-31"), None, 60).unwrap();
        let pack = &result["rows"][0]["TrafficPackageSet"][0];
        assert_eq!(pack["TrafficUsed"], 900.0);
        let outbound = query_ssh(&root, "machine", 500.0, Some("2025-01-31"), Some("tx"), 60).unwrap();
        let outbound_pack = &outbound["rows"][0]["TrafficPackageSet"][0];
        assert_eq!(outbound_pack["TrafficUsed"], 500.0);
        assert_eq!(outbound_pack["RxBytes"], 400.0);
        assert_eq!(outbound_pack["TxBytes"], 500.0);
        assert_eq!(outbound_pack["TrafficDirection"], "tx");
        assert_eq!(pack["PartialHistory"], true);
        assert!(pack["TrafficPackageRemaining"].is_null());
        std::fs::remove_dir_all(root).unwrap();
    }

}
