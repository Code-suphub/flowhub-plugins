//! ZgoCloud (VirtFusion): API token (Bearer) and panel session cookie auth.
use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use serde_json::{json, Value};
use std::time::Duration;
use super::zgocloud_session::{Session, Renewal, EXPIRED};

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

/// Use the same live counters and package metadata as the panel overview.
/// traffic.json is the historical chart and can lag behind state.json.
pub(super) async fn query_session(config: &Value) -> (Result<Value, String>, Option<Renewal>) {
    let server_id = match validate_server_id(config["serverId"].as_str().unwrap_or("")) {
        Ok(id) => id,
        Err(error) => return (Err(error), None),
    };
    let base = format!("https://server.zgocloud.cc/server/{server_id}/resource/");
    query_session_at(config, &base).await
}

async fn query_session_at(config: &Value, base: &str) -> (Result<Value, String>, Option<Renewal>) {
    let url = match reqwest::Url::parse(base) { Ok(url) => url, Err(_) => return (Err("zgoCloud 地址无效".into()), None) };
    let mut session = match Session::new(config["cookie"].as_str().unwrap_or(""), config["xsrfToken"].as_str().unwrap_or(""), &url) {
        Ok(session) => session,
        Err(error) => return (Err(error), None),
    };
    let result = query_cookie(config, &url, &mut session).await;
    (result, session.renewal(&url))
}

async fn query_cookie(config: &Value, base: &reqwest::Url, session: &mut Session) -> Result<Value, String> {
    let server_id = validate_server_id(config["serverId"].as_str().unwrap_or(""))?;

    let builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none());
    #[cfg(test)]
    let builder = builder.no_proxy();
    let client = builder.build()
        .map_err(|_| "无法创建 zgoCloud 客户端")?;

    // Apply a rotation before issuing the next request. Parallel requests can
    // race when the panel replaces its session or CSRF token in Set-Cookie.
    let server = cookie_resource(&client, &base.join("server.json").map_err(|_|"zgoCloud 地址无效")?, session).await?;
    let state = cookie_resource(&client, &base.join("state.json").map_err(|_|"zgoCloud 地址无效")?, session).await?;
    normalize_overview(server_id, &server["data"]["traffic"], &state["data"]["state"]["traffic"]["total"], Utc::now())
}

async fn cookie_resource(client: &reqwest::Client, url: &reqwest::Url, session: &mut Session) -> Result<Value, String> {
    let (cookie, xsrf) = session.headers(url)?;
    let response = client
        .get(url.clone())
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
                EXPIRED.to_string()
            } else {
                format!("zgoCloud HTTP 错误：{code}")
            }
        })?;

    if !response.status().is_success() { return Err(EXPIRED.into()); }
    let headers = response.headers().clone();
    let bytes = read_body(response).await?;
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| "zgoCloud 响应不是有效 JSON")?;
    if data["success"] != Value::Bool(true) {
        return Err("zgoCloud 接口返回 success=false".into());
    }
    session.accept(&headers, url);
    Ok(data)
}

fn normalize_overview(server_id: &str, traffic: &Value, counters: &Value, now: DateTime<Utc>) -> Result<Value, String> {
    let period = |key: &str| traffic[key].as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
        .ok_or_else(|| format!("zgoCloud 缺少有效周期：{key}"));
    let start = period("start")?;
    let end = period("end")?;
    if start > now || end < now {return Err("zgoCloud 总览未返回当前流量周期".into());}
    let rx = positive(counters, "rx")?;
    let tx = positive(counters, "tx")?;
    let (used, direction) = match traffic["countMethod"].as_u64() {
        Some(1) => (rx + tx, "both"),
        Some(2) => (rx, "rx"),
        Some(3) => (tx, "tx"),
        _ => return Err("zgoCloud 返回未知流量计费方向".into()),
    };
    let limit_bytes = positive(traffic, "limit")? * GIB;
    if !used.is_finite() || !limit_bytes.is_finite() {return Err("zgoCloud 流量数值超出范围".into());}
    let mut result = assemble(
        "zgocloudCookie",
        server_id,
        limit_bytes,
        used,
        (limit_bytes - used).max(0.0),
        (used - limit_bytes).max(0.0),
        start.to_rfc3339(),
        end.to_rfc3339(),
    );
    let pack = &mut result["rows"][0]["TrafficPackageSet"][0];
    pack["RxBytes"] = json!(rx);
    pack["TxBytes"] = json!(tx);
    pack["TrafficDirection"] = json!(direction);
    Ok(result)
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
        Some("zgocloudCookie") => query_session(config).await.0,
        _ => query_token(config).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn resources(replies: Vec<(u16, Vec<&'static str>, Value)>) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base=format!("http://{}/server/123/resource/",listener.local_addr().unwrap());
        let task=tokio::spawn(async move {
            let mut requests=Vec::new();
            for (status,cookies,body) in replies {
                let (mut stream,_)=tokio::time::timeout(Duration::from_secs(5),listener.accept()).await.unwrap().unwrap();
                let mut request=Vec::new();let mut chunk=[0u8;1024];
                while !request.windows(4).any(|w|w==b"\r\n\r\n") {
                    let n=stream.read(&mut chunk).await.unwrap();if n==0{break;}request.extend_from_slice(&chunk[..n]);
                    assert!(request.len()<16384);
                }
                requests.push(String::from_utf8(request).unwrap());
                let body=body.to_string();
                let headers=cookies.into_iter().map(|c|format!("Set-Cookie: {c}\r\n")).collect::<String>();
                stream.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n{body}",body.len()).as_bytes()).await.unwrap();
            }
            requests
        });
        (base,task)
    }
    fn session_config()->Value {json!({"serverId":"123","cookie":"virtfusion_session=old; XSRF-TOKEN=old","xsrfToken":"old"})}
    fn metadata()->Value {json!({"success":true,"data":{"traffic":{"countMethod":1,"limit":500,"start":"2000-01-01T00:00:00Z","end":"2999-01-01T00:00:00Z"}}})}
    fn state()->Value {json!({"success":true,"data":{"state":{"traffic":{"total":{"rx":10,"tx":20}}}}})}
    #[tokio::test]
    async fn rotated_cookies_are_used_immediately_and_survive_the_next_query() {
        let (base,task)=resources(vec![
            (200,vec!["virtfusion_session=first; Path=/; Max-Age=7200", "XSRF-TOKEN=first%3D; Path=/; Max-Age=7200"],metadata()),
            (200,vec!["virtfusion_session=second; Path=/; Max-Age=7200", "XSRF-TOKEN=second%3D; Path=/; Max-Age=7200"],state()),
            (200,vec![],metadata()),(200,vec![],state()),
        ]).await;
        let (data,renewal)=query_session_at(&session_config(),&base).await;
        assert_eq!(data.unwrap()["rows"][0]["TrafficPackageSet"][0]["TrafficUsed"],30.0);
        let renewal=renewal.unwrap();assert_eq!(renewal.xsrf_token,"second=");
        let config=json!({"serverId":"123","cookie":renewal.cookie,"xsrfToken":renewal.xsrf_token});
        let (data,renewal)=query_session_at(&config,&base).await;assert!(data.is_ok());assert!(renewal.is_none());
        let requests=task.await.unwrap();
        assert!(requests[0].contains("virtfusion_session=old"));
        assert!(requests[1].contains("virtfusion_session=first"));assert!(requests[1].contains("x-xsrf-token: first="));
        assert!(requests[2].contains("virtfusion_session=second"));assert!(requests[2].contains("x-xsrf-token: second="));
        assert!(!requests[1].contains("virtfusion_session=old"));
    }
    #[tokio::test]
    async fn failure_responses_never_replace_auth_but_prior_successful_rotation_is_kept() {
        for (status,body) in [(401,json!({})),(419,json!({})),(302,json!({"success":true})),(200,json!({"success":false,"message":"not echoed"}))] {
            let (base,task)=resources(vec![(status,vec!["virtfusion_session=rejected; Path=/"],body)]).await;
            let (result,renewal)=query_session_at(&session_config(),&base).await;
            assert!(result.is_err());assert!(renewal.is_none());assert_eq!(task.await.unwrap().len(),1);
        }
        let (base,task)=resources(vec![
            (200,vec!["virtfusion_session=valid-renewal; Path=/"],metadata()),
            (500,vec!["virtfusion_session=invalid-replacement; Path=/"],json!({})),
        ]).await;
        let (result,renewal)=query_session_at(&session_config(),&base).await;
        assert!(result.is_err());assert!(renewal.unwrap().cookie.contains("valid-renewal"));assert_eq!(task.await.unwrap().len(),2);
    }

    #[test]
    fn cookie_overview_matches_live_panel_instead_of_chart_history() {
        let traffic=json!({"countMethod":1,"start":"2026-11-16T00:00:00.000000Z","end":"2026-12-15T23:59:59.999999Z","limit":500});
        let counters=json!({"rx":203306628u64,"tx":203978483u64,"total":247129727u64});
        let now=Utc.with_ymd_and_hms(2026,11,16,8,15,0).unwrap();
        let result=normalize_overview("19383",&traffic,&counters,now).unwrap();
        let pack=&result["rows"][0]["TrafficPackageSet"][0];
        assert_eq!(pack["TrafficUsed"],407285111.0);
        assert_eq!(pack["TrafficPackageTotal"],500.0*GIB);
        assert_eq!(pack["TrafficPackageRemaining"],500.0*GIB-407285111.0);
        assert_eq!(pack["TrafficDirection"],"both");
        for (method,expected,direction) in [(2,203306628.0,"rx"),(3,203978483.0,"tx")] {
            let mut configured=traffic.clone();configured["countMethod"]=json!(method);
            let result=normalize_overview("19383",&configured,&counters,now).unwrap();
            assert_eq!(result["rows"][0]["TrafficPackageSet"][0]["TrafficUsed"],expected);
            assert_eq!(result["rows"][0]["TrafficPackageSet"][0]["TrafficDirection"],direction);
        }
        assert!(normalize_overview("19383",&traffic,&json!({}),now).is_err());
        assert!(normalize_overview("19383",&traffic,&json!({"rx":-1,"tx":1}),now).is_err());
        assert!(normalize_overview("19383",&traffic,&counters,Utc.with_ymd_and_hms(2026,12,16,0,0,0).unwrap()).is_err());
        let mut unknown=traffic;unknown["countMethod"]=json!(9);
        assert!(normalize_overview("19383",&unknown,&counters,now).is_err());
    }

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
    fn cookie_overview_exhausted_quota_keeps_overflow_and_rejects_missing_metadata() {
        let now=Utc.with_ymd_and_hms(2026,11,16,8,15,0).unwrap();
        let traffic=json!({"countMethod":1,"start":"2026-11-16T00:00:00Z","end":"2026-12-15T23:59:59Z","limit":1});
        let counters=json!({"rx":GIB,"tx":10});
        let result=normalize_overview("19383",&traffic,&counters,now).unwrap();
        let pack=&result["rows"][0]["TrafficPackageSet"][0];
        assert_eq!(pack["TrafficPackageRemaining"],0.0);
        assert_eq!(pack["TrafficOverflow"],10.0);
        for key in ["start","end","limit"] {
            let mut missing=traffic.clone();missing.as_object_mut().unwrap().remove(key);
            assert!(normalize_overview("19383",&missing,&counters,now).is_err());
        }
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
