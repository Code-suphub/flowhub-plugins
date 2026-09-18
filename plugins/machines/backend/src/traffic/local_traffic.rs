//! Local VM traffic from a Netdata agent's rx/tx rate series.
//!
//! Netdata exposes network charts as kilobits/second, so the monthly total is
//! calculated by integrating the history from the start of the current month.
use chrono::{DateTime, Datelike, FixedOffset, TimeZone, Utc};
use serde_json::{json, Value};

const GIB: f64 = 1_073_741_824.0;
const SECONDS_PER_DAY: f64 = 86_400.0;
const SHANGHAI_OFFSET_SECONDS: i32 = 8 * 60 * 60;
const MAX_MONTH_SECONDS: u64 = 31 * 86_400;

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

fn current_month_window(now: DateTime<Utc>) -> (i64, u64, f64, DateTime<FixedOffset>) {
    let offset = FixedOffset::east_opt(SHANGHAI_OFFSET_SECONDS).unwrap();
    let local_now = now.with_timezone(&offset);
    let start_local = offset.with_ymd_and_hms(local_now.year(), local_now.month(), 1, 0, 0, 0).single().unwrap();
    let start_utc = start_local.with_timezone(&Utc);
    let elapsed = (now-start_utc).num_seconds().max(1) as u64;
    (start_utc.timestamp(), elapsed, elapsed as f64 / SECONDS_PER_DAY, start_local)
}

pub async fn query(instance: &crate::monitoring::netdata::Instance, limit_gb: f64) -> Result<Value, String> {
    instance.validate()?;

    let chart = if instance.network_chart.is_empty() {
        "system.net"
    } else {
        instance.network_chart.as_str()
    };
    let now = Utc::now();
    let (month_start, elapsed_seconds, period_days, month_start_local) = current_month_window(now);
    let history_seconds = elapsed_seconds.max(3_600).min(MAX_MONTH_SECONDS);
    let history = crate::monitoring::netdata::history(instance, chart, history_seconds).await?;
    let (period_rx, period_tx) = history_bytes(&history, month_start as f64, now.timestamp() as f64)?;
    let total = period_rx + period_tx;
    let daily_avg = if total > 0.0 {
        total / period_days
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
                "TrafficPackageRemaining": remaining,
                "TrafficOverflow": overflow,
                "StartTime": month_start_local.to_rfc3339(),
                "EndTime": now.to_rfc3339(),
                "RxBytes": period_rx,
                "TxBytes": period_tx,
                "DailyAverage": daily_avg,
                "DaysRemaining": days_remaining,
                "PeriodDays": period_days,
                "LimitGB": limit_gb,
                "PercentUsed": percent_used,
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
        let (start, seconds, days, local) = current_month_window(now);
        assert_eq!(local.to_rfc3339(), "2026-09-01T00:00:00+08:00");
        assert_eq!(start, Utc.with_ymd_and_hms(2026, 8, 31, 16, 0, 0).unwrap().timestamp());
        assert_eq!(seconds, 17 * 86_400 + 16 * 3_600);
        assert_eq!(days, 17.0 + 16.0 / 24.0);
    }

}
