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
probe_port={port}
# 读取已有 Agent 真正在监听的端口：用户可能改过 netdata.conf，或装了容器/自定义端口。
# 只读配置，不做任何改动。解析不出来就沿用表单里的端口。
detect_agent_port() {{
  conf=''
  for candidate in /etc/netdata/netdata.conf /opt/netdata/etc/netdata/netdata.conf; do
    if test -r "$candidate"; then conf="$candidate"; break; fi
  done
  if test -n "$conf"; then
    found=$(sed -n 's/^[[:space:]]*default port[[:space:]]*=[[:space:]]*\([0-9]\{{2,5\}}\).*/\1/p' "$conf" | head -1)
    if test -n "$found"; then probe_port="$found"; fi
  fi
}}
# 回传一个 FlowHub 可用的地址，供接入表单一键填入。地址是「这台机器的 IP + Agent 端口」，
# 与「本机能否连上」无关——已有安装时也要回填，用户不该因为探测不到就被要求手填。
# 云主机的公网 IP 通常不在网卡上（NAT），所以先问外部回显服务，失败再退回本机默认路由地址。
# 优先 IPv4：很多云主机的 IPv6 是临时地址、随时会变，且安全组通常只放行了 IPv4。
# IPv6 必须写成 [addr] 形式，否则端口会与最后一个 hextet 混在一起成为非法 URL。
# 这个函数在「已有安装」和「全新安装」两条路径上都会调用。
report_agent_address() {{
  agent_host=''
  if command -v curl >/dev/null; then
    # 先要 IPv4；v4.ifconfig.me / api.ipify.org 默认走 IPv4，取到才是稳定的公网地址。
    for probe in https://v4.ifconfig.me/ip https://api.ipify.org https://ifconfig.me/ip; do
      candidate=$(curl --fail --silent --max-time 5 "$probe" 2>/dev/null | tr -d '[:space:]') || candidate=''
      case "$candidate" in
        *[!0-9a-fA-F:.]*|'') continue ;;
        *:*) continue ;;   # 这一轮拿到 IPv6，继续找 IPv4
        *.*) agent_host="$candidate"; break ;;
      esac
    done
    # 实在只有 IPv6 才用它，并补上方括号使其成为合法 URL。
    if test -z "$agent_host"; then
      for probe in https://ifconfig.me/ip https://api64.ipify.org; do
        candidate=$(curl --fail --silent --max-time 5 "$probe" 2>/dev/null | tr -d '[:space:]') || candidate=''
        case "$candidate" in
          *[!0-9a-fA-F:.]*|'') continue ;;
          *:*) agent_host="[$candidate]"; break ;;
          *.*) agent_host="$candidate"; break ;;
        esac
      done
    fi
  fi
  if test -z "$agent_host"; then
    agent_host=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1) || agent_host=''
  fi
  echo "FLOWHUB_NETDATA_AGENT_HOST=$agent_host"
  echo "FLOWHUB_NETDATA_AGENT_PORT=$probe_port"
  if test -n "$agent_host"; then
    echo "Agent 地址：http://$agent_host:$probe_port"
  else
    echo '未能自动探测本机 IP，请在接入表单填写 Agent 地址。'
  fi
}}
test "$(uname -s)" = Linux || {{ echo '仅支持 Linux'; exit 1; }}
if command -v netdata >/dev/null 2>&1 || test -e /etc/netdata/netdata.conf || test -e /opt/netdata/etc/netdata/netdata.conf; then
  # 已有安装：不改动任何配置（保持「未更改」语义），但照样回传地址——机器上已经有 Netdata，
  # 就没有理由因为「FlowHub 这台机探测不到」而让用户去手填。本机自检结果只作为附加提示。
  echo '发现已有 Netdata，未更改配置。'
  detect_agent_port
  report_agent_address
  if curl --fail --silent --max-time 5 "http://127.0.0.1:$probe_port/api/v1/info" >/dev/null 2>&1; then
    echo "Agent 在 127.0.0.1:$probe_port 响应正常。"
  else
    echo "注意：本机自检未连上 127.0.0.1:$probe_port，这不代表地址不可用。"
    echo "若 Agent 监听在其他端口或仅监听本机，请按上面的地址调整后再接入。"
  fi
  exit 0
fi
if command -v docker >/dev/null 2>&1 && docker container inspect netdata >/dev/null 2>&1; then
  # 容器同样不改动，端口可能被映射到别处，所以只回传地址、不猜映射关系。
  echo '发现已有 Netdata 容器，未更改。若容器映射了 19999 端口，可填上面的地址接入。'
  detect_agent_port
  report_agent_address
  exit 0
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
# 首次安装要初始化 dbengine 并加载插件，几秒内不会响应；只探测一次会把「装好了但还没起来」
# 误报成安装失败，所以这里重试约 60 秒。只探测本机（云主机上探测自己的公网 IP 常因 NAT 失败）。
ready=''
for _ in $(seq 1 30); do
  if curl --fail --silent --max-time 3 http://127.0.0.1:{port}/api/v1/info >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
if test -z "$ready"; then
  echo 'Netdata 已安装，但 Agent 在 60 秒内没有响应。'
  echo '这不是安装失败：请查看 systemctl status netdata 与 journalctl -u netdata 排查服务状态。'
  exit 1
fi
echo 'Netdata 已安装并已就绪。'
# 校验监听地址是否真的生效：只测 127.0.0.1 无法区分「绑定所有网卡」和「只绑定本机」，
# 而后者会让 FlowHub 永远连不上，是这套流程里最容易踩空的一步。
if test "{bind}" = "0.0.0.0"; then
  listening=$( (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -c ":${{probe_port}} " || true)
  wildcard=$( (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -E "0\.0\.0\.0:${{probe_port}} |\*:${{probe_port}} |\[::\]:${{probe_port}} " | head -1 || true)
  if test -n "$wildcard"; then
    echo "监听检查：端口 $probe_port 已在所有网卡监听。"
  elif test "$listening" != "0"; then
    echo "监听检查：端口 $probe_port 已监听，但没有绑定到所有网卡。"
    echo "配置里写的是 bind to = 0.0.0.0；请确认 $conf 生效并重启 netdata。"
  else
    echo "监听检查：没有看到端口 $probe_port 的监听项，请检查 $conf 与 systemctl status netdata。"
  fi
fi
report_agent_address
echo '请确认本机防火墙与云安全组已放行 {port} 端口；历史保留受时间与容量两者限制；原始安装配置已备份。'
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
 #[test]fn install_script_retries_the_readiness_probe_instead_of_failing_once(){
  let script=install_script(19999,"0.0.0.0",7,1024).unwrap();
  // 首次启动要初始化 dbengine，单次探测会把「装好了但还没起来」误报成安装失败。
  assert!(script.contains("for _ in $(seq 1 30)"),"自检必须重试");
  assert!(!script.contains("--max-time 10 http://127.0.0.1:19999/api/v1/info >/dev/null ||"));
  // 超时措辞不能让人以为安装本身失败了。
  assert!(script.contains("这不是安装失败"));
  assert!(script.contains("journalctl -u netdata"));
 }
 #[test]fn install_script_prefers_ipv4_and_brackets_ipv6(){
  let script=install_script(19999,"0.0.0.0",7,1024).unwrap();
  // IPv4 必须优先：云主机的 IPv6 常是临时地址、随时变化，安全组通常也只放行 IPv4。
  assert!(script.contains("https://v4.ifconfig.me/ip"),"应先向 IPv4 回显服务取地址");
  let v4_at=script.find("v4.ifconfig.me").unwrap();
  let v6_at=script.find("api64.ipify.org").unwrap();
  assert!(v4_at<v6_at,"IPv4 探测必须排在 IPv6 之前");
  // IPv6 必须补方括号：http://2402:...:19999 会被 url crate 判为 invalid port number，
  // 这类地址回填给用户等于给了个用不了的地址（用户实际遇到）。
  assert!(script.contains(r#"agent_host="[$candidate]""#),"IPv6 必须写成 [addr]");
  // 只有 v4 的候选集里不应用 IPv6，避免又回退到临时地址。
  let v4_loop=&script[v4_at..script.find("实在只有 IPv6").unwrap()];
  assert!(v4_loop.contains("*:*) continue"),"第一轮应跳过 IPv6 结果");
  // 回显服务返回垃圾时的形状校验仍然保留。
  assert!(script.contains("*[!0-9a-fA-F:.]*|'') continue"));
 }
 #[test]fn install_script_verifies_the_bind_actually_took_effect(){
  // 只探测 127.0.0.1 无法区分「绑定所有网卡」与「只绑定本机」，而后者会让 FlowHub
  // 永远连不上。绑定 0.0.0.0 时必须检查监听项里是否出现通配地址。
  let public=install_script(19999,"0.0.0.0",7,1024).unwrap();
  assert!(public.contains("监听检查：端口 $probe_port 已在所有网卡监听"));
  assert!(public.contains("已监听，但没有绑定到所有网卡"),"应能识别「只监听本机」");
  assert!(public.contains(r"0\.0\.0\.0:${probe_port}"),"应匹配 IPv4 通配监听");
  assert!(public.contains(r"\[::\]:${probe_port}"),"应匹配 IPv6 通配监听");
  assert!(public.contains("ss -ltn 2>/dev/null || netstat -ltn"),"缺少 ss 时应退回 netstat");
  // 仅本机模式不做这项检查（本来就只监听本机），避免误报。检查体仍在脚本里，
  // 但它被 `if test "127.0.0.1" = "0.0.0.0"` 包住，运行时不会执行。
  let local=install_script(19999,"127.0.0.1",7,1024).unwrap();
  assert!(local.contains(r#"if test "127.0.0.1" = "0.0.0.0"; then"#),"仅本机模式不应执行通配监听检查");
  assert!(public.contains(r#"if test "0.0.0.0" = "0.0.0.0"; then"#),"绑定所有网卡时应执行该检查");
 }
 #[test]fn install_script_binds_the_requested_address_and_states_the_endpoint(){
  let public=install_script(19999,"0.0.0.0",30,2048).unwrap();
  assert!(public.contains("bind to = 0.0.0.0"));
  assert!(public.contains("default port = 19999"));
  assert!(public.contains("dbengine tier 0 retention time = 30d"));
  assert!(public.contains("dbengine tier 0 retention size = 2048MiB"));
  // 安装结束后要回传探测到的地址，供接入表单一键填入（FlowHub 解析这两个标记）。
  // 端口经由 probe_port 变量输出，所以断言变量赋值与回传语句同时存在。
  assert!(public.contains("probe_port=19999"));
  assert!(public.contains("FLOWHUB_NETDATA_AGENT_HOST="));
  assert!(public.contains("FLOWHUB_NETDATA_AGENT_PORT=$probe_port"));
  // 探测不到机器 IP 时必须留空并提示手填，不能让用户拿到一个假地址。
  assert!(public.contains("未能自动探测本机 IP"));
  assert!(is_install(&public));
  // 端口必须跟着参数走，否则一键填入的地址会指向错误端口。
  let other=install_script(20000,"0.0.0.0",7,1024).unwrap();
  assert!(other.contains("probe_port=20000"));
  assert!(!other.contains("probe_port=19999"));
  // 探测逻辑只定义一次；两个报告点（已有安装 / 全新安装）都必须调用它。
  // 注意断言的是渲染后的脚本，所以用单个大括号。
  assert_eq!(public.matches("report_agent_address() {").count(),1,"探测函数只应定义一次");
  assert_eq!(public.matches("\n  report_agent_address\n").count(),2,"已有安装与全新安装两条路径都要调用探测函数");
  assert!(public.contains("detect_agent_port"),"应读取已有配置里的真实端口");
  assert!(public.contains("发现已有 Netdata，未更改配置。"));
  assert!(!public.contains("请填写已有 Agent 地址接入。"),"旧的空提示应已移除");
  // 关键回归：已有安装时不能因为「本机自检没连通」就不回传地址。
  let existing=public.split("发现已有 Netdata，未更改配置。").nth(1).unwrap();
  let branch=existing.split("exit 0").next().unwrap();
  assert!(branch.contains("report_agent_address"),"已有安装分支必须回传地址");
  assert!(!branch.contains("FLOWHUB_NETDATA_AGENT_HOST=\n"),"已有安装分支不应把地址清空");
  assert!(branch.contains("这不代表地址不可用"),"本机自检失败只能作为附加提示");
  // 仅本机模式必须如实写成 127.0.0.1，且不再暗示会自动建立隧道。
  let local=install_script(19999,"127.0.0.1",7,512).unwrap();
  assert!(local.contains("bind to = 127.0.0.1"));
  assert!(!local.contains("SSH 转发"));
 }
 #[test]fn normalize_real_units_and_missing_data(){let i=Instance{id:"test".into(),name:"Test".into(),url:"http://host:19999".into(),network_chart:String::new()};let all=json!({"system.cpu":{"last_updated":chrono::Utc::now().timestamp(),"dimensions":{"user":{"value":12.},"system":{"value":3.},"idle":{"value":85.}}},"system.ram":{"dimensions":{"used":{"value":20.},"free":{"value":80.}}},"system.net":{"dimensions":{"received":{"value":800.},"sent":{"value":-160.}}}});let out=normalize(&i,&all).unwrap();assert_eq!(out["rows"][0]["values"]["cpu"],15.);assert_eq!(out["rows"][0]["values"]["memory"],20.);assert_eq!(out["rows"][0]["values"]["rx"],100.);assert_eq!(out["rows"][0]["values"]["tx"],20.);assert!(out["rows"][0]["values"]["disk"].is_null());}
}
