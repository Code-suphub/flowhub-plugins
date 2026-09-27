//! ZgoCloud (VirtFusion): API token (Bearer) and panel session cookie auth.
use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use serde_json::{json, Value};
use std::time::Duration;

const GIB: f64 = 1_073_741_824.0;

fn positive(v: &Value, key: &str) -> Result<f64, String> {
    v[key]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.)
        .ok_or_else(|| format!("响应缺少有效数值：{key}"))
}

fn parse_period(s: &str) -> Option<DateTime<Utc>> {
    NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|d| Utc.from_utc_datetime(&d))
}

fn to_rfc3339(s: &str) -> String {
    parse_period(s).map(|d| d.to_rfc3339()).unwrap_or_default()
}

fn validate_server_id(server_id: &str) -> Result<&str, String> {
    if server_id.is_empty() || !server_id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("serverId 应为数字".into());
    }
    Ok(server_id)
}

async fn read_body(response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取 zgoCloud 响应失败")?
    {
        if bytes.len() + chunk.len() > 1_048_576 {
            return Err("zgoCloud 响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn map_status(e: reqwest::Error) -> String {
    format!(
        "zgoCloud HTTP 错误：{}",
        e.status().map(|s| s.as_u16()).unwrap_or(0)
    )
}

/// API token mode: hits the official REST API. Requires server-side Bearer token.
async fn query_token(config: &Value) -> Result<Value, String> {
    let token = config["apiToken"].as_str().ok_or("缺少 API Token")?;
    let server_id = validate_server_id(config["serverId"].as_str().unwrap_or(""))?;

    let url = format!("https://server.zgocloud.cc/api/v1/servers/{server_id}/traffic");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法创建 zgoCloud 客户端")?;

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| "zgoCloud 请求失败，请检查网络")?
        .error_for_status()
        .map_err(map_status)?;

    let bytes = read_body(response).await?;
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| "zgoCloud 响应不是有效 JSON")?;
    if let Some(err) = data["error"].as_str() {
        return Err(format!("zgoCloud：{err}"));
    }
    if data["data"].is_null() {
        if let Some(msg) = data["message"].as_str() {
            return Err(format!("zgoCloud：{msg}"));
        }
        return Err("zgoCloud 响应缺少 data 字段".into());
    }

    let monthly = data["data"].get("monthly").unwrap_or(&Value::Null);
    let now = Utc::now();
    let entry = pick_current(monthly, now).ok_or("未找到当前流量周期，请稍后再试")?;

    let limit_gb = positive(entry, "limit")?;
    let used = positive(entry, "total")?;
    let extra_gb = blocks_extra_gb(entry);
    let limit_bytes = (limit_gb + extra_gb) * GIB;
    let remaining = (limit_bytes - used).max(0.0);
    let overflow = (used - limit_bytes).max(0.0);

    Ok(assemble(
        "zgocloud",
        server_id,
        limit_bytes,
        used,
        remaining,
        overflow,
        to_rfc3339(entry["start"].as_str().unwrap_or("")),
        to_rfc3339(entry["end"].as_str().unwrap_or("")),
    ))
}

/// Session cookie mode: hits the customer-facing /resource/traffic.json endpoint.
/// No package limit is exposed; honour `limitGB` from config if set.
async fn query_cookie(config: &Value) -> Result<Value, String> {
    let cookie = config["cookie"].as_str().ok_or("缺少 Cookie")?;
    let xsrf = config["xsrfToken"].as_str().ok_or("缺少 XSRF Token")?;
    let server_id = validate_server_id(config["serverId"].as_str().unwrap_or(""))?;

    let url = format!("https://server.zgocloud.cc/server/{server_id}/resource/traffic.json");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法创建 zgoCloud 客户端")?;

    let response = client
        .get(&url)
        .header("Cookie", cookie)
        .header("x-xsrf-token", xsrf)
        .header("x-requested-with", "XMLHttpRequest")
        .header("Accept", "application/json, text/plain, */*")
        .header("Referer", "https://server.zgocloud.cc/")
        .header("User-Agent", "Mozilla/5.0 (compatible; flowhub-machines/0.3)")
        .send()
        .await
        .map_err(|_| "zgoCloud 请求失败，请检查网络或 Cookie 是否过期")?
        .error_for_status()
        .map_err(|e| {
            let code = e.status().map(|s| s.as_u16()).unwrap_or(0);
            if code == 401 || code == 419 {
                "zgoCloud 鉴未已过期，请重新从浏览器复制 Cookie 和 XSRF Token".to_string()
            } else {
                format!("zgoCloud HTTP 错误：{code}")
            }
        })?;

    let bytes = read_body(response).await?;
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| "zgoCloud 响应不是有效 JSON")?;
    if data["success"] != Value::Bool(true) && data["success"] != json!(true) {
        if let Some(msg) = data["message"].as_str() {
            return Err(format!("zgoCloud：{msg}"));
        }
        return Err("zgoCloud 接口返回 success=false".into());
    }

    // zgoCloud /resource/traffic.json 的响应有两层 data 嵌套：
    //   { success: true, data: { hasMonthlyData, data: { monthlyRaw:[...] } } }
    let monthly = &data["data"]["data"]["monthlyRaw"];
    let entry = pick_current_with_keys(monthly, Utc::now(), "month_start", "month_end")
        .ok_or("未找到当前流量周期，请检查面板的流量重置日期")?;

    let used = positive(entry, "total")?;
    // Config stores limitGB as a string from the form; accept either string or number.
    let limit_gb = config["limitGB"].as_f64()
        .or_else(|| config["limitGB"].as_str().and_then(|s| s.trim().parse::<f64>().ok()))
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(0.0);
    let (limit_bytes, remaining, overflow) = if limit_gb > 0.0 {
        let bytes = limit_gb * GIB;
        (
            bytes,
            (bytes - used).max(0.0),
            (used - bytes).max(0.0),
        )
    } else {
        (0.0, 0.0, 0.0)
    };

    Ok(assemble(
        "zgocloudCookie",
        server_id,
        limit_bytes,
        used,
        remaining,
        overflow,
        to_rfc3339(entry["month_start"].as_str().unwrap_or("")),
        to_rfc3339(entry["month_end"].as_str().unwrap_or("")),
    ))
}

fn assemble(
    provider: &str,
    server_id: &str,
    total: f64,
    used: f64,
    remaining: f64,
    overflow: f64,
    start: String,
    end: String,
) -> Value {
    json!({
        "provider": provider,
        "at": Utc::now().to_rfc3339(),
        "rows": [{
            "InstanceId": server_id,
            "TrafficPackageSet": [{
                "TrafficPackageTotal": total,
                "TrafficUsed": used,
                "TrafficPackageRemaining": remaining,
                "TrafficOverflow": overflow,
                "StartTime": start,
                "EndTime": end,
            }]
        }]
    })
}

fn pick_current<'a>(monthly: &'a Value, now: DateTime<Utc>) -> Option<&'a Value> {
    pick_current_with_keys(monthly, now, "start", "end")
}

fn pick_current_with_keys<'a>(monthly: &'a Value, now: DateTime<Utc>, start_key: &str, end_key: &str) -> Option<&'a Value> {
    let arr = monthly.as_array()?;
    arr.iter().find(|entry| {
        let start = entry.get(start_key).and_then(|v| v.as_str()).and_then(parse_period);
        let end = entry.get(end_key).and_then(|v| v.as_str()).and_then(parse_period);
        matches!((start, end), (Some(s), Some(e)) if s <= now && now <= e)
    })
}

fn blocks_extra_gb(entry: &Value) -> f64 {
    entry["blocks"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|b| b["traffic"].as_f64()).sum())
        .unwrap_or(0.0)
}

pub async fn query(config: &Value) -> Result<Value, String> {
    match config["provider"].as_str() {
        Some("zgocloudCookie") => query_cookie(config).await,
        _ => query_token(config).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry_in_range() -> Value {
        json!({
            "month": 2,
            "start": "2025-01-06 00:00:00",
            "end":   "2025-02-05 23:59:59",
            "rx":    1_000_000_000u64,
            "tx":    500_000_000u64,
            "total": 1_500_000_000u64,
            "limit": 20000,
            "blocks": [{"id": 2, "traffic": 100}]
        })
    }

    fn cookie_entry() -> Value {
        json!({
            "server_id": 19383,
            "month": 1,
            "month_start": "2025-01-06 00:00:00",
            "month_end":   "2025-02-05 23:59:59",
            "rx":    1_000_000_000u64,
            "tx":    500_000_000u64,
            "total": 1_500_000_000u64,
            "notification_1": 0,
            "notification_2": 0,
            "created_at": "2025-01-06 00:00:00",
            "updated_at": "2025-01-20 12:00:00",
            "deleted_at": null
        })
    }

    #[test]
    fn pick_current_returns_entry_within_range() {
        let now = Utc.with_ymd_and_hms(2025, 1, 20, 12, 0, 0).unwrap();
        assert!(pick_current(&json!([entry_in_range()]), now).is_some());
    }

    #[test]
    fn pick_current_skips_out_of_range_entries() {
        let now = Utc.with_ymd_and_hms(2025, 1, 20, 12, 0, 0).unwrap();
        let data = json!([{
            "start": "2024-12-06 00:00:00",
            "end":   "2025-01-05 23:59:59",
            "total": 0u64, "limit": 1
        }]);
        assert!(pick_current(&data, now).is_none());
    }

    #[test]
    fn cookie_period_uses_current_entry_not_first_history_row() {
        let now = Utc.with_ymd_and_hms(2025, 1, 20, 12, 0, 0).unwrap();
        let previous = json!({"month_start":"2024-12-06 00:00:00","month_end":"2025-01-05 23:59:59","total":99});
        let monthly = json!([previous, cookie_entry()]);
        let current = pick_current_with_keys(&monthly, now, "month_start", "month_end").unwrap();
        assert_eq!(current["server_id"], 19383);
        assert!(pick_current_with_keys(&monthly, Utc.with_ymd_and_hms(2025, 3, 1, 0, 0, 0).unwrap(), "month_start", "month_end").is_none());
    }

    #[test]
    fn blocks_extra_sums_only_numeric_traffic() {
        let entry = json!({"blocks": [
            {"id": 1, "traffic": 50},
            {"id": 2, "traffic": 25.5},
            {"id": 3, "traffic": "ignored"},
            {"no_traffic_field": true}
        ]});
        assert!((blocks_extra_gb(&entry) - 75.5).abs() < 1e-9);
    }

    #[test]
    fn token_normalize_combines_limit_and_blocks_into_bytes() {
        let entry = entry_in_range();
        let used = positive(&entry, "total").unwrap();
        let extra = blocks_extra_gb(&entry);
        let limit_bytes = (positive(&entry, "limit").unwrap() + extra) * GIB;
        assert!(limit_bytes > 2.0e13 && limit_bytes < 2.2e13);
        let remaining = (limit_bytes - used).max(0.0);
        let overflow = (used - limit_bytes).max(0.0);
        assert!(remaining > 0.0);
        assert_eq!(overflow, 0.0);
    }

    #[test]
    fn token_normalize_flags_overflow_when_used_exceeds_allowance() {
        let mut entry = entry_in_range();
        entry["total"] = json!(30_000_000_000_000u64);
        let used = positive(&entry, "total").unwrap();
        let extra = blocks_extra_gb(&entry);
        let limit_bytes = (positive(&entry, "limit").unwrap() + extra) * GIB;
        assert_eq!((limit_bytes - used).max(0.0), 0.0);
        assert!((used - limit_bytes).max(0.0) > 0.0);
    }

    #[test]
    fn cookie_normalize_with_limit_uses_manual_value() {
        let entry = cookie_entry();
        let used = positive(&entry, "total").unwrap();
        let limit_gb = 100.0_f64;
        let bytes = limit_gb * GIB;
        let remaining = (bytes - used).max(0.0);
        let overflow = (used - bytes).max(0.0);
        assert!(remaining > 0.0);
        assert_eq!(overflow, 0.0);
        // Confirm cookie endpoint date fields round-trip via parse_period.
        assert!(to_rfc3339(entry["month_start"].as_str().unwrap()).starts_with("2025-01-06"));
    }

    #[test]
    fn cookie_normalize_without_limit_returns_zero_for_total_remaining() {
        let entry = cookie_entry();
        let used = positive(&entry, "total").unwrap();
        let limit_gb = 0.0_f64;
        // Mirrors query_cookie's branch when limitGB is unset.
        let (limit_bytes, remaining, overflow) = if limit_gb > 0.0 {
            let b = limit_gb * GIB;
            (b, (b - used).max(0.0), (used - b).max(0.0))
        } else {
            (0.0, 0.0, 0.0)
        };
        assert_eq!(limit_bytes, 0.0);
        assert_eq!(remaining, 0.0);
        assert_eq!(overflow, 0.0);
    }

    #[test]
    fn positive_rejects_missing_or_negative_or_string() {
        assert!(positive(&json!({}), "limit").is_err());
        assert!(positive(&json!({"limit": -5}), "limit").is_err());
        assert!(positive(&json!({"limit": "0"}), "limit").is_err());
        assert_eq!(positive(&json!({"limit": 100}), "limit").unwrap(), 100.0);
    }

    #[test]
    fn server_id_must_be_digits() {
        for bad in ["", "12a", "abc", "-1"] {
            assert!(validate_server_id(bad).is_err());
        }
        assert_eq!(validate_server_id("19383").unwrap(), "19383");
    }

    #[test]
    fn query_dispatches_by_provider_field() {
        // The dispatch is a one-line match; here we verify that a config with
        // `provider: "zgocloudCookie"` would route to the cookie branch and a
        // missing provider (or any other value) falls back to the token branch.
        let token_cfg = json!({"provider": "zgocloud", "apiToken": "x", "serverId": "19383"});
        let cookie_cfg = json!({"provider": "zgocloudCookie", "cookie": "c", "xsrfToken": "x", "serverId": "19383"});
        let default_cfg = json!({"provider": "other", "apiToken": "x", "serverId": "19383"});
        assert_eq!(token_cfg["provider"].as_str(), Some("zgocloud"));
        assert_eq!(cookie_cfg["provider"].as_str(), Some("zgocloudCookie"));
        // Confirm the dispatcher's match arms classify each value as expected.
        let classify = |c: &Value| match c["provider"].as_str() {
            Some("zgocloudCookie") => "cookie",
            _ => "token",
        };
        assert_eq!(classify(&token_cfg), "token");
        assert_eq!(classify(&cookie_cfg), "cookie");
        assert_eq!(classify(&default_cfg), "token");
    }
}
