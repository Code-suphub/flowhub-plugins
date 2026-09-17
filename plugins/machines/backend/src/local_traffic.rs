//! Local VM traffic from a Netdata agent's cumulative rx/tx counters.
//!
//! `current total` comes from Netdata's `system.net` (or configured chart) `received` / `sent`
//! dimensions, which are absolute byte counters. `daily average` is computed by comparing
//! the current cumulative value to the first sample in a 30-day history window.
//! Reboots of the VM reset the counters, which manifests as daily-average noise until the
//! next sample lands -- we surface that via the `periodDays` window and graceful fallback.
use crate::netdata;
use chrono::{Duration, Utc};
use serde_json::{json, Value};

const GIB: f64 = 1_073_741_824.0;
const SECONDS_PER_DAY: f64 = 86_400.0;
const DEFAULT_PERIOD_DAYS: i64 = 30;

fn positive(v: &Value, key: &str) -> Result<f64, String> {
    v[key]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.)
        .ok_or_else(|| format!("响应缺少有效数值：{key}"))
}

/// Pull the first non-null cumulative value for `received` / `sent` from a Netdata
/// `/api/v1/data` response. Netdata labels typically look like `["time", "received", "sent"]`,
/// but custom `network_chart` may differ -- fall back to positional indices 1/2.
fn history_first_cumulative(history: &Value) -> (f64, f64) {
    let mut rx_idx = 1usize;
    let mut tx_idx = 2usize;
    if let Some(labels) = history["labels"].as_array() {
        for (i, label) in labels.iter().enumerate() {
            if let Some(name) = label.as_str() {
                let lower = name.to_ascii_lowercase();
                if lower == "received" || lower == "rx" {
                    rx_idx = i;
                } else if lower == "sent" || lower == "tx" {
                    tx_idx = i;
                }
            }
        }
    }
    let first = |dim: usize| -> f64 {
        history["data"]
            .as_array()
            .and_then(|arr| arr.get(dim))
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.iter().find_map(|v| v.as_f64()))
            .unwrap_or(0.0)
    };
    (first(rx_idx), first(tx_idx))
}

pub async fn query(instance: &netdata::Instance, limit_gb: f64) -> Result<Value, String> {
    instance.validate()?;

    let metrics = netdata::fetch(instance).await?;
    let row = metrics["rows"]
        .get(0)
        .ok_or("Netdata 未返回任何行")?;
    let values = row["values"].as_object().ok_or("Netdata 行缺少 values")?;
    let rx = positive(values.get("rx").ok_or("缺少 rx 字段")?, "rx")?;
    let tx = positive(values.get("tx").ok_or("缺少 tx 字段")?, "tx")?;
    let total = rx + tx;

    let chart = if instance.network_chart.is_empty() {
        "system.net"
    } else {
        instance.network_chart.as_str()
    };
    let seconds = (DEFAULT_PERIOD_DAYS as f64 * SECONDS_PER_DAY) as u64;
    let history = netdata::history(instance, chart, seconds).await?;
    let (start_rx, start_tx) = history_first_cumulative(&history);

    // Netdata cumulative counters can briefly dip on VM reboot; clamp so a single bad
    // sample doesn't produce a negative period.
    let period_rx = (rx - start_rx).max(0.0);
    let period_tx = (tx - start_tx).max(0.0);
    let period_total = period_rx + period_tx;
    let period_days = DEFAULT_PERIOD_DAYS as f64;
    let daily_avg = if period_total > 0.0 {
        period_total / period_days
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

    let now = Utc::now();
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
                "StartTime": (now - Duration::days(DEFAULT_PERIOD_DAYS)).to_rfc3339(),
                "EndTime": now.to_rfc3339(),
                "RxBytes": rx,
                "TxBytes": tx,
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
    fn history_first_cumulative_uses_label_indices_when_present() {
        let data = json!({
            "labels": ["time", "received", "sent"],
            "data": [
                [1000, 2000, 3000],
                [50_000.0, 60_000.0, 70_000.0],
                [10_000.0, 11_000.0, 12_000.0],
            ]
        });
        let (rx, tx) = history_first_cumulative(&data);
        assert_eq!(rx, 50_000.0);
        assert_eq!(tx, 10_000.0);
    }

    #[test]
    fn history_first_cumulative_falls_back_to_positional_indices() {
        let data = json!({
            "labels": ["time", "rx_bytes", "tx_bytes"],
            "data": [
                [1000, 2000],
                [42.0, 43.0],
                [7.0, 8.0],
            ]
        });
        let (rx, tx) = history_first_cumulative(&data);
        // Labels mention "rx" / "tx" so the lower-case match wins and finds the right index.
        assert_eq!(rx, 42.0);
        assert_eq!(tx, 7.0);
    }

    #[test]
    fn history_first_cumulative_skips_null_entries() {
        let data = json!({
            "labels": ["time", "received", "sent"],
            "data": [
                [1000, 2000],
                [Value::Null, 60_000.0],
                [null, 11_000.0],
            ]
        });
        let (rx, tx) = history_first_cumulative(&data);
        assert_eq!(rx, 60_000.0);
        assert_eq!(tx, 11_000.0);
    }

    #[test]
    fn history_first_cumulative_returns_zero_on_empty_or_missing_data() {
        let (rx, tx) = history_first_cumulative(&json!({}));
        assert_eq!(rx, 0.0);
        assert_eq!(tx, 0.0);
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
}
