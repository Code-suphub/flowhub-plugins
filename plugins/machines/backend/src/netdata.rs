//! Per-node Netdata integration. History remains on the remote Agent.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct Instance { pub id:String, pub name:String, pub url:String, #[serde(default)] pub network_chart:String }
impl Instance {
    pub fn validate(&self)->Result<(),String>{
        if self.id.is_empty()||self.id.len()>64||!self.id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-')||self.name.trim().is_empty()||self.name.len()>120||self.network_chart.len()>256{return Err("节点名称或 ID 无效".into());}
        endpoint(&self.url,"api/v1/info").map(|_|())
    }
}
fn endpoint(raw:&str,path:&str)->Result<url::Url,String>{
    let mut base=url::Url::parse(raw).map_err(|_|"请输入完整的 Netdata Agent 地址")?;
    if !["http","https"].contains(&base.scheme())||base.host_str().is_none()||!base.username().is_empty()||base.password().is_some()||base.query().is_some()||base.fragment().is_some(){return Err("仅支持不含密码和查询参数的 HTTP(S) Agent 地址".into());}
    base.set_path(&format!("{}/{path}",base.path().trim_end_matches('/')));Ok(base)
}
async fn read(url:url::Url)->Result<Value,String>{
    let client=reqwest::Client::builder().timeout(Duration::from_secs(12)).redirect(reqwest::redirect::Policy::none()).build().map_err(|e|e.to_string())?;
    let mut response=client.get(url).send().await.map_err(|_|"无法连接 Netdata，请检查地址、网络和 Agent 访问权限")?.error_for_status().map_err(|_|"Netdata 返回错误，请确认使用可访问的 Agent 地址")?;
    let mut bytes=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|_|"读取指标失败")?{if bytes.len()+chunk.len()>8*1024*1024{return Err("指标响应超过 8 MiB".into());}bytes.extend_from_slice(&chunk);}
    serde_json::from_slice(&bytes).map_err(|_|"返回内容不是 Netdata JSON 数据".into())
}
fn val(all:&Value,chart:&str,dim:&str)->Option<f64>{all[chart]["dimensions"][dim]["value"].as_f64().filter(|v|v.is_finite())}
fn percent(used:Option<f64>,total:Option<f64>)->Option<f64>{used.zip(total).filter(|(_,t)|*t>0.).map(|(u,t)|(u/t*100.).clamp(0.,100.))}
fn normalize(instance:&Instance,all:&Value)->Result<Value,String>{
    let charts=all.as_object().filter(|c|c.values().any(|v|v["dimensions"].is_object())).ok_or("Netdata 未返回指标，请确认采集器已启动")?;
    let cpu=all["system.cpu"]["dimensions"].as_object().map(|d|d.iter().filter(|(k,_)|k.as_str()!="idle").filter_map(|(_,v)|v["value"].as_f64()).sum::<f64>().clamp(0.,100.));
    let memory=percent(val(all,"system.ram","used"),all["system.ram"]["dimensions"].as_object().map(|d|d.values().filter_map(|v|v["value"].as_f64()).sum()));
    let disk=percent(val(all,"disk_space._","used"),all["disk_space._"]["dimensions"].as_object().map(|d|d.values().filter_map(|v|v["value"].as_f64()).sum()));
    let network=if instance.network_chart.is_empty(){"system.net"}else{&instance.network_chart};
    let at=charts.values().filter_map(|v|v["last_updated"].as_i64()).max().map(|v|v*1000);
    let status=if at.is_some_and(|t|chrono::Utc::now().timestamp_millis()-t<120_000){"healthy"}else{"stale"};
    Ok(json!({"rows":[{"id":format!("netdata-{}",instance.id),"name":instance.name,"kind":"netdata","status":status,"at":at,"values":{"cpu":cpu,"memory":memory,"disk":disk,"rx":val(all,network,"received").map(|v|v.abs()/8.),"tx":val(all,network,"sent").map(|v|v.abs()/8.)}}],"charts":charts.iter().map(|(id,v)|json!({"id":id,"name":v["name"],"units":v["units"]})).collect::<Vec<_>>(),"updatedAt":chrono::Utc::now().timestamp_millis()}))
}
pub(crate) async fn fetch(instance:&Instance)->Result<Value,String>{instance.validate()?;let mut url=endpoint(&instance.url,"api/v1/allmetrics")?;url.query_pairs_mut().append_pair("format","json");normalize(instance,&read(url).await?)}
pub(crate) async fn history(instance:&Instance,chart:&str,seconds:u64)->Result<Value,String>{
    instance.validate()?;if chart.is_empty()||chart.len()>256||![3600,86400,604800,2592000].contains(&seconds){return Err("指标或时间范围无效".into());}
    let mut url=endpoint(&instance.url,"api/v1/data")?;url.query_pairs_mut().append_pair("chart",chart).append_pair("after",&format!("-{seconds}")).append_pair("points","180").append_pair("format","json");
    let data=read(url).await?;if !data["labels"].is_array()||!data["data"].is_array(){return Err("Agent 没有返回可用的历史数据".into());}Ok(data)
}
pub(crate) fn install_script(port:u64,bind:&str,days:u64,disk:u64)->Result<String,String>{
    if !(1024..=65535).contains(&port)||!["127.0.0.1","0.0.0.0"].contains(&bind)||![7,30,90].contains(&days)||![512,1024,2048,4096].contains(&disk){return Err("安装端口、保留时间或容量配置无效".into());}
    Ok(format!(r#"set -eu
# FlowHub Netdata installation
test "$(uname -s)" = Linux || {{ echo '仅支持 Linux'; exit 1; }}
if command -v netdata >/dev/null 2>&1 || test -e /etc/netdata/netdata.conf || test -e /opt/netdata/etc/netdata/netdata.conf; then
  echo '发现已有 Netdata，未更改。请填写已有 Agent 地址接入。'; exit 0
fi
if command -v docker >/dev/null 2>&1 && docker container inspect netdata >/dev/null 2>&1; then
  echo '发现已有 Netdata 容器，未更改。请复用已有实例。'; exit 0
fi
as_root() {{ if test "$(id -u)" = 0; then "$@"; else sudo -n "$@"; fi; }}
as_root true || {{ echo '需要 root 或免密 sudo 权限，可改在系统终端安装'; exit 1; }}
command -v curl >/dev/null || {{ echo '请先安装 curl'; exit 1; }}
task_dir=$(mktemp -d)
trap 'rm -rf "$task_dir"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 https://get.netdata.cloud/kickstart.sh -o "$task_dir/kickstart.sh"
as_root env DISABLE_TELEMETRY=1 sh "$task_dir/kickstart.sh" --non-interactive --release-channel stable --no-updates
conf=/etc/netdata/netdata.conf
if test -d /opt/netdata/etc/netdata; then conf=/opt/netdata/etc/netdata/netdata.conf; fi
if test -f "$conf"; then as_root cp "$conf" "$conf.flowhub-original"; fi
cat > "$task_dir/netdata.conf" <<'FLOWHUB_CONFIG'
[db]
    mode = dbengine
    update every = 5
    storage tiers = 1
    dbengine tier 0 retention time = {days}d
    dbengine tier 0 retention size = {disk}MiB
[web]
    bind to = {bind}
    default port = {port}
FLOWHUB_CONFIG
as_root install -m 644 "$task_dir/netdata.conf" "$conf"
if command -v systemctl >/dev/null; then as_root systemctl restart netdata; else as_root service netdata restart; fi
curl --fail --silent --max-time 10 http://127.0.0.1:{port}/api/v1/info >/dev/null || {{ echo 'Agent 尚未就绪，请查看服务状态和安装日志'; exit 1; }}
echo 'Netdata 已安装。请通过已配置的地址接入。历史保留受时间与容量两者限制；原始安装配置已备份。'
"#))
}
pub(crate) fn is_install(script:&str)->bool{script.starts_with("set -eu\n# FlowHub Netdata installation\n")}
#[cfg(test)]mod tests{use super::*;
 #[tokio::test]async fn reads_agent_metrics_and_history_over_http(){
    use tokio::io::{AsyncReadExt,AsyncWriteExt};
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap();
    let server=tokio::spawn(async move{for step in 0..2 {let (mut stream,_)=listener.accept().await.unwrap();let mut request=[0u8;4096];let count=stream.read(&mut request).await.unwrap();let req=String::from_utf8_lossy(&request[..count]);if step==0{assert!(req.contains("/api/v1/allmetrics?format=json"));}else{assert!(req.contains("chart=system.cpu"));assert!(req.contains("after=-86400"));}
      let body=if step==0{json!({"system.cpu":{"last_updated":chrono::Utc::now().timestamp(),"dimensions":{"user":{"value":25.}}}})}else{json!({"labels":["time","user"],"data":[[1700000000,25.]]})}.to_string();stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();}});
    let instance=Instance{id:"test".into(),name:"Test".into(),url:format!("http://{address}"),network_chart:String::new()};assert_eq!(fetch(&instance).await.unwrap()["rows"][0]["values"]["cpu"],25.);assert_eq!(history(&instance,"system.cpu",86400).await.unwrap()["data"][0][1],25.);server.await.unwrap();
 }
 #[test]fn validate_urls_and_install_arguments(){assert!(endpoint("file:///tmp/a","api/v1/info").is_err());assert!(endpoint("https://u:p@host","api/v1/info").is_err());assert_eq!(endpoint("https://host/netdata/","api/v1/info").unwrap().path(),"/netdata/api/v1/info");assert!(install_script(19999,"0.0.0.0;id",7,1024).is_err());assert!(install_script(22,"127.0.0.1",7,1024).is_err());}
 #[test]fn normalize_real_units_and_missing_data(){let i=Instance{id:"test".into(),name:"Test".into(),url:"http://host:19999".into(),network_chart:String::new()};let all=json!({"system.cpu":{"last_updated":chrono::Utc::now().timestamp(),"dimensions":{"user":{"value":12.},"system":{"value":3.},"idle":{"value":85.}}},"system.ram":{"dimensions":{"used":{"value":20.},"free":{"value":80.}}},"system.net":{"dimensions":{"received":{"value":800.},"sent":{"value":-160.}}}});let out=normalize(&i,&all).unwrap();assert_eq!(out["rows"][0]["values"]["cpu"],15.);assert_eq!(out["rows"][0]["values"]["memory"],20.);assert_eq!(out["rows"][0]["values"]["rx"],100.);assert_eq!(out["rows"][0]["values"]["tx"],20.);assert!(out["rows"][0]["values"]["disk"].is_null());}
}
