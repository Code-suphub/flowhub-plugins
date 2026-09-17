//! Read-only cloud APIs. Never derive a billable allowance from monitoring samples.
use chrono::{Datelike, TimeZone, Utc};
use ring::{
    hmac,
    rand::{SecureRandom, SystemRandom},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn number(v: &Value, key: &str) -> Result<f64, String> {
    v[key]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.)
        .ok_or_else(|| format!("响应缺少有效数值：{key}"))
}
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
pub fn validate(v: &Value) -> Result<(), String> {
    let required: &[&str] = match text(v, "provider") {
        "aliyun" | "aws" => &["secretId", "secretKey", "region", "instanceId"],
        "huawei" => &["secretId", "secretKey", "packageId", "site"],
        "linode" | "vultr" => &["apiKey"],
        _ => return Err("不支持的云服务商".into()),
    };
    for key in required {
        if text(v, key).is_empty() {
            return Err(format!("请填写 {key}"));
        }
    }
    for key in ["region", "instanceId", "packageId"] {
        let s = text(v, key);
        if !s.is_empty() && !identifier(s) {
            return Err(format!("{key} 格式无效，只允许字母、数字、横线和下划线"));
        }
    }
    if text(v, "provider") == "huawei" && !["cn", "intl"].contains(&text(v, "site")) {
        return Err("请选择中国站或国际站".into());
    }
    Ok(())
}
fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn mac(key: &[u8], s: &str) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), s.as_bytes())
        .as_ref()
        .to_vec()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn headers_canonical(headers: &BTreeMap<String, String>) -> (String, String) {
    (
        headers
            .iter()
            .map(|(k, v)| format!("{k}:{}\n", v.trim()))
            .collect(),
        headers.keys().cloned().collect::<Vec<_>>().join(";"),
    )
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化云服务请求".into())
}
async fn fetch(req: reqwest::RequestBuilder) -> Result<Value, String> {
    let mut response = req
        .send()
        .await
        .map_err(|_| "云服务请求失败，请检查网络与凭证".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "云服务 HTTP {}，请检查凭证、只读权限和地域",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取云服务响应失败")? {
        if bytes.len() + chunk.len() > 1048576 {
            return Err("云服务响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| "云服务响应不是有效 JSON")?;
    // Do not echo upstream error descriptions: some contain request credentials.
    if data.get("error_code").is_some()
        || data.get("Code").is_some()
        || data.get("__type").is_some()
    {
        return Err("云服务拒绝查询，请核对只读权限、实例/流量包 ID 及地域".into());
    }
    Ok(data)
}
fn report(
    provider: &str,
    scope: &str,
    used: f64,
    total: Option<f64>,
    remaining: Option<f64>,
    divisor: f64,
    end: Value,
) -> Result<Value, String> {
    if !used.is_finite()
        || total.is_some_and(|n| !n.is_finite() || n < 0.)
        || remaining.is_some_and(|n| !n.is_finite() || n < 0.)
    {
        return Err("流量数值无效".into());
    }
    let at = Utc::now().to_rfc3339();
    let summary = json!({"mode":if total.is_some(){"quota"}else{"usage"},"used":used,"total":total,"remaining":remaining,"scope":scope,"divisor":divisor,"at":at});
    Ok(
        json!({"provider":provider,"summary":summary,"at":at,"rows":[{"InstanceId":scope,"TrafficPackageSet":[{"TrafficUsed":used,"TrafficPackageTotal":total,"TrafficPackageRemaining":remaining,"TrafficOverflow":total.map(|t|(used-t).max(0.)),"EndTime":end}]}]}),
    )
}
fn quota(
    provider: &str,
    scope: &str,
    used: f64,
    total: f64,
    divisor: f64,
    end: Value,
) -> Result<Value, String> {
    report(
        provider,
        scope,
        used,
        Some(total),
        Some((total - used).max(0.)),
        divisor,
        end,
    )
}

pub async fn query(v: &Value) -> Result<Value, String> {
    validate(v)?;
    match text(v, "provider") {
        "aliyun" => aliyun(v).await,
        "huawei" => huawei(v).await,
        "aws" => aws(v).await,
        "linode" => {
            let d = fetch(
                client()?
                    .get("https://api.linode.com/v4/account/transfer")
                    .bearer_auth(text(v, "apiKey")),
            )
            .await?;
            linode(&d, text(v, "region"))
        }
        "vultr" => {
            let d = fetch(
                client()?
                    .get("https://api.vultr.com/v2/account/bandwidth")
                    .bearer_auth(text(v, "apiKey")),
            )
            .await?;
            vultr(&d)
        }
        _ => Err("不支持的云服务商".into()),
    }
}
fn linode(d: &Value, region: &str) -> Result<Value, String> {
    let (row, scope) = if region.is_empty() {
        (d, "account".to_string())
    } else {
        (
            d["region_transfers"]
                .as_array()
                .and_then(|a| a.iter().find(|r| text(r, "id") == region))
                .ok_or("该地域暂无共享额度数据")?,
            format!("region:{region}"),
        )
    };
    quota(
        "linode",
        &scope,
        number(row, "used")? * 1e9,
        number(row, "quota")? * 1e9,
        1e9,
        Value::Null,
    )
}
fn vultr(d: &Value) -> Result<Value, String> {
    let r = &d["bandwidth"]["current_month_to_date"];
    let total = number(r, "instance_bandwidth_credits")?
        + number(r, "free_bandwidth_credits")?
        + number(r, "purchased_bandwidth_credits")?;
    quota(
        "vultr",
        "account",
        number(r, "gb_out")? * 1e9,
        total * 1e9,
        1e9,
        Value::Null,
    )
}
fn aliyun_headers(
    v: &Value,
    host: &str,
    query: &str,
    date: &str,
    nonce: &str,
) -> BTreeMap<String, String> {
    let mut h = BTreeMap::from([
        ("host".into(), host.into()),
        ("x-acs-action".into(), "ListInstancesTrafficPackages".into()),
        ("x-acs-version".into(), "2020-06-01".into()),
        ("x-acs-date".into(), date.into()),
        ("x-acs-signature-nonce".into(), nonce.into()),
        ("x-acs-content-sha256".into(), hash("")),
    ]);
    if !text(v, "token").is_empty() {
        h.insert("x-acs-security-token".into(), text(v, "token").into());
    }
    acs_sign(v, query, h)
}
fn acs_sign(v: &Value, query: &str, mut h: BTreeMap<String, String>) -> BTreeMap<String, String> {
    let (canonical, signed) = headers_canonical(&h);
    let request = format!("POST\n/\n{query}\n{canonical}\n{signed}\n{}", hash(""));
    let signature = hex(&mac(
        text(v, "secretKey").as_bytes(),
        &format!("ACS3-HMAC-SHA256\n{}", hash(&request)),
    ));
    h.insert(
        "authorization".into(),
        format!(
            "ACS3-HMAC-SHA256 Credential={},SignedHeaders={signed},Signature={signature}",
            text(v, "secretId")
        ),
    );
    h
}
async fn aliyun(v: &Value) -> Result<Value, String> {
    let host = format!("swas.{}.aliyuncs.com", text(v, "region"));
    let query = format!(
        "InstanceIds={}&RegionId={}",
        encode(&json!([text(v, "instanceId")]).to_string()),
        encode(text(v, "region"))
    );
    let mut random = [0u8; 16];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| "无法生成请求随机值")?;
    let h = aliyun_headers(
        v,
        &host,
        &query,
        &Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        &hex(&random),
    );
    let mut req = client()?.post(format!("https://{host}/?{query}"));
    for (k, val) in h {
        req = req.header(k, val);
    }
    let d = fetch(req.body("")).await?;
    aliyun_report(&d, text(v, "instanceId"))
}
fn aliyun_report(d: &Value, id: &str) -> Result<Value, String> {
    let row = d["InstanceTrafficPackageUsages"]
        .as_array()
        .and_then(|a| a.iter().find(|r| text(r, "InstanceId") == id))
        .ok_or("该实例暂无流量包数据")?;
    report(
        "aliyun",
        "instance",
        number(row, "TrafficUsed")?,
        Some(number(row, "TrafficPackageTotal")?),
        Some(number(row, "TrafficPackageRemaining")?),
        1073741824.,
        Value::Null,
    )
}
fn huawei_headers(
    v: &Value,
    host: &str,
    path: &str,
    body: &str,
    date: &str,
) -> BTreeMap<String, String> {
    let mut h = BTreeMap::from([
        ("host".into(), host.into()),
        ("x-sdk-date".into(), date.into()),
    ]);
    let (canonical, signed) = headers_canonical(&h);
    // Huawei canonical URI has a trailing slash even when the wire URI does not.
    let request = format!("POST\n{path}/\n\n{canonical}\n{signed}\n{}", hash(body));
    let signature = hex(&mac(
        text(v, "secretKey").as_bytes(),
        &format!("SDK-HMAC-SHA256\n{date}\n{}", hash(&request)),
    ));
    h.insert(
        "authorization".into(),
        format!(
            "SDK-HMAC-SHA256 Access={}, SignedHeaders={signed}, Signature={signature}",
            text(v, "secretId")
        ),
    );
    h
}
async fn huawei(v: &Value) -> Result<Value, String> {
    let host = if text(v, "site") == "intl" {
        "bss-intl.myhuaweicloud.com"
    } else {
        "bss.myhuaweicloud.com"
    };
    let path = "/v2/payments/free-resources/usages/details/query";
    let body = json!({"free_resource_ids":[text(v,"packageId")]}).to_string();
    let mut req = client()?
        .post(format!("https://{host}{path}"))
        .header("content-type", "application/json");
    for (k, val) in huawei_headers(
        v,
        host,
        path,
        &body,
        &Utc::now().format("%Y%m%dT%H%M%SZ").to_string(),
    ) {
        req = req.header(k, val);
    }
    let d = fetch(req.body(body)).await?;
    huawei_report(&d, text(v, "packageId"))
}
fn huawei_report(d: &Value, id: &str) -> Result<Value, String> {
    let r = d["free_resources"]
        .as_array()
        .and_then(|a| a.iter().find(|r| text(r, "free_resource_id") == id))
        .ok_or("该流量包暂无数据，请确认填写的是流量包 ID")?;
    if r["measure_id"] != 10 {
        return Err("该资源包的计量单位不是 GB，无法作为流量包展示".into());
    }
    let now = Utc::now();
    for (key, future) in [("start_time", true), ("end_time", false)] {
        let at =
            chrono::DateTime::parse_from_rfc3339(text(r, key)).map_err(|_| "流量包周期格式无效")?;
        if (future && at > now) || (!future && at <= now) {
            return Err("该流量包不在有效周期内".into());
        }
    }
    let total = number(r, "original_amount")? * 1073741824.;
    let remaining = number(r, "amount")? * 1073741824.;
    report(
        "huawei",
        "instance",
        (total - remaining).max(0.),
        Some(total),
        Some(remaining),
        1073741824.,
        r["end_time"].clone(),
    )
}
fn aws_headers(v: &Value, host: &str, body: &str, date: &str) -> BTreeMap<String, String> {
    let mut h = BTreeMap::from([
        ("content-type".into(), "application/x-amz-json-1.1".into()),
        ("host".into(), host.into()),
        ("x-amz-date".into(), date.into()),
        (
            "x-amz-target".into(),
            "Lightsail_20161128.GetInstanceMetricData".into(),
        ),
    ]);
    if !text(v, "token").is_empty() {
        h.insert("x-amz-security-token".into(), text(v, "token").into());
    }
    let (canonical, signed) = headers_canonical(&h);
    let request = format!("POST\n/\n\n{canonical}\n{signed}\n{}", hash(body));
    let day = &date[..8];
    let region = text(v, "region");
    let scope = format!("{day}/{region}/lightsail/aws4_request");
    let key = mac(
        &mac(
            &mac(
                &mac(format!("AWS4{}", text(v, "secretKey")).as_bytes(), day),
                region,
            ),
            "lightsail",
        ),
        "aws4_request",
    );
    let signature = hex(&mac(
        &key,
        &format!("AWS4-HMAC-SHA256\n{date}\n{scope}\n{}", hash(&request)),
    ));
    h.insert(
        "authorization".into(),
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed}, Signature={signature}",
            text(v, "secretId")
        ),
    );
    h
}
fn metric_sum(d: &Value) -> Result<f64, String> {
    let points = d["metricData"]
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or("本月暂无监控数据，不能按零用量处理")?;
    let mut total = 0.;
    for p in points {
        total += number(p, "sum")?;
    }
    if !total.is_finite() {
        return Err("监控数据无效".into());
    }
    Ok(total)
}
async fn aws(v: &Value) -> Result<Value, String> {
    let now = Utc::now();
    let start = Utc
        .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
        .single()
        .ok_or("月份时间无效")?;
    let region = text(v, "region");
    let host = format!("lightsail.{region}.amazonaws.com");
    let mut used = 0.;
    for metric in ["NetworkIn", "NetworkOut"] {
        let body=json!({"instanceName":text(v,"instanceId"),"metricName":metric,"period":86400,"startTime":start.timestamp(),"endTime":now.timestamp(),"unit":"Bytes","statistics":["Sum"]}).to_string();
        let mut req = client()?.post(format!("https://{host}/"));
        for (k, val) in aws_headers(v, &host, &body, &now.format("%Y%m%dT%H%M%SZ").to_string()) {
            req = req.header(k, val);
        }
        used += metric_sum(&fetch(req.body(body)).await?)?;
    }
    let mut d = report(
        "aws",
        "instance",
        used,
        None,
        None,
        1073741824.,
        Value::Null,
    )?;
    d["note"] = json!("本月 UTC 监控入站＋出站用量，可能有延迟或缺失；不是账单用量或套餐余额。");
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_endpoint_injection() {
        for p in ["aliyun", "aws"] {
            assert!(validate(&json!({"provider":p,"secretId":"x","secretKey":"x","region":"x.test/@evil","instanceId":"ok"})).is_err());
        }
    }
    #[test]
    fn quotas_keep_scope_and_overflow() {
        let s = linode(
            &json!({"used":12,"quota":10,"region_transfers":[{"id":"id","used":2,"quota":8}]}),
            "",
        )
        .unwrap();
        assert_eq!(s["summary"]["remaining"], 0.);
        assert_eq!(s["summary"]["scope"], "account");
        assert!(linode(&json!({"used":1}), "").is_err());
        assert!(linode(&json!({"used":1,"quota":2}), "missing").is_err());
    }
    #[test]
    fn vultr_uses_accrued_not_projected() {
        let d = json!({"bandwidth":{"current_month_to_date":{"gb_out":5,"instance_bandwidth_credits":10,"free_bandwidth_credits":20,"purchased_bandwidth_credits":0},"current_month_projected":{"gb_out":999}}});
        assert_eq!(vultr(&d).unwrap()["summary"]["remaining"], 25e9);
    }
    #[test]
    fn aliyun_selects_bound_instance() {
        let d = json!({"InstanceTrafficPackageUsages":[{"InstanceId":"a","TrafficUsed":7,"TrafficPackageTotal":10,"TrafficPackageRemaining":3}]});
        assert_eq!(aliyun_report(&d, "a").unwrap()["summary"]["remaining"], 3.);
        assert!(aliyun_report(&d, "b").is_err());
    }
    #[test]
    fn huawei_rejects_expired_or_wrong_units() {
        let d = json!({"free_resources":[{"free_resource_id":"a","measure_id":10,"original_amount":200,"amount":180,"start_time":"2000-01-01T00:00:00Z","end_time":"2999-01-01T00:00:00Z"}]});
        assert_eq!(
            huawei_report(&d, "a").unwrap()["summary"]["remaining"],
            180. * 1073741824.
        );
        let mut wrong = d.clone();
        wrong["free_resources"][0]["measure_id"] = json!(1);
        assert!(huawei_report(&wrong, "a").is_err());
        wrong = d;
        wrong["free_resources"][0]["end_time"] = json!("2001-01-01T00:00:00Z");
        assert!(huawei_report(&wrong, "a").is_err());
    }
    #[test]
    fn missing_metrics_are_not_zero() {
        assert!(metric_sum(&json!({"metricData":[]})).is_err());
        assert!(metric_sum(&json!({"metricData":[{}]})).is_err());
        assert_eq!(
            metric_sum(&json!({"metricData":[{"sum":2},{"sum":3}]})).unwrap(),
            5.
        );
    }
    #[test]
    fn signing_encodes_queries_and_tokens() {
        assert_eq!(encode("[\"a b\"]"), "%5B%22a%20b%22%5D");
        let v = json!({"secretId":"id","secretKey":"key","token":"session","region":"us-east-1"});
        let h = aliyun_headers(
            &v,
            "swas.cn-hangzhou.aliyuncs.com",
            "",
            "2026-09-13T00:00:00Z",
            "nonce",
        );
        assert!(h["authorization"].contains("x-acs-security-token"));
        let a = aws_headers(
            &v,
            "lightsail.us-east-1.amazonaws.com",
            "{}",
            "20260913T000000Z",
        );
        assert!(a["authorization"].contains("20260913/us-east-1/lightsail/aws4_request"));
        assert!(a["authorization"].contains("x-amz-security-token"));
    }
}

#[cfg(test)]
mod official_vectors {
    use super::*;
    // Alibaba's published fixed-parameter ACS3 example, not a generated expected value.
    // https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
    #[test]
    fn aliyun_published_signature() {
        let headers = BTreeMap::from([
            ("host".into(), "ecs.cn-shanghai.aliyuncs.com".into()),
            ("x-acs-action".into(), "RunInstances".into()),
            ("x-acs-version".into(), "2014-05-26".into()),
            ("x-acs-date".into(), "2023-10-26T10:22:32Z".into()),
            (
                "x-acs-signature-nonce".into(),
                "3156853299f313e23d1673dc12e1703d".into(),
            ),
            ("x-acs-content-sha256".into(), hash("")),
        ]);
        let signed = acs_sign(
            &json!({"secretId":"YourAccessKeyId","secretKey":"YourAccessKeySecret"}),
            "ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai",
            headers,
        );
        assert!(signed["authorization"].ends_with(
            "Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0"
        ));
    }
}
