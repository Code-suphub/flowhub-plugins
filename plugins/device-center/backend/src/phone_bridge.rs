//! Paired phones work independently of the ADB catalog. Secrets stay in the native process.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use reqwest::{blocking::Client, Url};
use ring::{aead, digest, rand::{SecureRandom, SystemRandom}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, io::Read, path::PathBuf, sync::{Arc, Mutex, OnceLock}, time::Duration};
mod recovery;
pub(crate) mod automatic;

const FILE: &str = "phone-bridge.json";
const LIMIT: u64 = 3 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
struct Route { label: String, url: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
struct Relay { url: String, client_token: String }
#[derive(Clone, Serialize, Deserialize)]
struct Phone { id: String, name: String, token: String, #[serde(default)] routes: Vec<Route>, #[serde(default)] relay: Option<Relay>, #[serde(default,rename="adbRecovery")] adb_recovery: Option<RecoveryBinding>, #[serde(default,rename="autoRecovery")] auto_recovery: bool }
#[derive(Clone,Serialize,Deserialize)]
struct RecoveryBinding { alias:String, identity:String }
#[derive(Default, Serialize, Deserialize)]
struct Config { #[serde(default)] phones: Vec<Phone> }
#[derive(Default)]
struct Live { route: Option<usize>, session: Option<String>, health: Value, error: Option<String> }
static CONFIG: Mutex<()> = Mutex::new(());
type Sessions = Mutex<HashMap<String, Arc<Mutex<Live>>>>;
static LIVE: OnceLock<Sessions> = OnceLock::new();
fn live(id: &str) -> Result<Arc<Mutex<Live>>, String> {
    let mut map=LIVE.get_or_init(Default::default).lock().map_err(|_|"手机会话不可用")?;
    Ok(map.entry(id.into()).or_default().clone())
}
fn root() -> Result<PathBuf,String> {
    std::env::var_os("FLOWHUB_PLUGIN_DATA").map(PathBuf::from)
        .or_else(||std::env::var_os("HOME").map(PathBuf::from).map(|home|home.join("Library/Application Support/FlowHub/device-center")))
        .ok_or("找不到外设中心数据目录".into())
}
fn read() -> Result<Config,String> { crate::local_preferences::read(&root()?,FILE,65536).map(|v|v.unwrap_or_default()).map_err(|_|"手机配对配置无法读取".into()) }
pub(super) fn valid_id(id:&str)->bool { (16..=80).contains(&id.len()) && id.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-') }
fn validate_url(value:&str, relay:bool)->Result<(),String> {
    let url=Url::parse(value).map_err(|_|"连接地址无效")?;
    if value.len()>512 || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("地址不能包含账号、查询参数或片段".into());
    }
    if relay && url.scheme()!="https" { return Err("中转必须使用 HTTPS".into()); }
    if !matches!(url.scheme(),"http"|"https") { return Err("仅支持 HTTP/HTTPS".into()); }
    if url.scheme()=="http" {
        let ip=url.host_str().and_then(|h|h.parse::<std::net::Ipv4Addr>().ok()).ok_or("HTTP 直连须使用私网 IPv4 地址")?;
        let b=ip.octets();
        if !(ip.is_private()||ip.is_loopback()||(b[0]==100&&(64..=127).contains(&b[1]))) { return Err("HTTP 仅允许私网、VPN 或本机地址".into()); }
    }
    Ok(())
}
fn validate(p:&Phone)->Result<(),String> {
    if let Some(b)=&p.adb_recovery {
        if b.alias.is_empty()||b.alias.len()>64||!b.alias.bytes().all(|v|v.is_ascii_alphanumeric()||v==b'-'||v==b'_')||b.identity.is_empty()||b.identity.len()>80||!b.identity.bytes().all(|v|v.is_ascii_alphanumeric()||v==b'-'||v==b'_'){return Err("ADB 恢复绑定无效".into());}
    }
    if !valid_id(&p.id)||p.name.trim().is_empty()||p.name.len()>100||p.name.chars().any(char::is_control)
        || !(40..=128).contains(&p.token.len())||!p.token.bytes().all(|c|c.is_ascii_hexdigit()) {
        return Err("设备标识、名称或配对密钥无效".into());
    }
    if p.routes.len()>4 || (p.routes.is_empty()&&p.relay.is_none()) { return Err("请配置一至四条直连线路或一个中转".into()); }
    for r in &p.routes {
        if r.label.is_empty()||r.label.len()>60||r.label.chars().any(char::is_control) { return Err("线路名称无效".into()); }
        validate_url(&r.url,false)?;
    }
    if let Some(r)=&p.relay { validate_url(&r.url,true)?;
        if !(40..=128).contains(&r.client_token.len()) || !r.client_token.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-'||c==b'_') {return Err("中转客户端密钥无效".into());}
    }
    Ok(())
}
fn random()->Result<[u8;12],String> { let mut n=[0;12];SystemRandom::new().fill(&mut n).map_err(|_|"无法创建随机请求")?;Ok(n) }
fn key(token:&str)->Result<aead::LessSafeKey,String> {
    let d=digest::digest(&digest::SHA256,token.as_bytes());
    aead::UnboundKey::new(&aead::AES_256_GCM,d.as_ref()).map(aead::LessSafeKey::new).map_err(|_|"加密初始化失败".into())
}
fn seal(token:&str,payload:&Value)->Result<Value,String> {
    let n=random()?; let mut bytes=serde_json::to_vec(payload).map_err(|_|"请求编码失败")?;
    key(token)?.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(n),aead::Aad::from(b"phonebridge-v2-request"),&mut bytes).map_err(|_|"加密失败")?;
    Ok(json!({"nonce":B64.encode(n),"data":B64.encode(bytes)}))
}
fn open(token:&str,envelope:&Value)->Result<Value,String> {
    let nonce=B64.decode(envelope["nonce"].as_str().ok_or("加密回执无效")?).map_err(|_|"加密回执无效")?;
    let n:[u8;12]=nonce.try_into().map_err(|_|"加密回执无效")?;
    let mut bytes=B64.decode(envelope["data"].as_str().ok_or("加密回执无效")?).map_err(|_|"加密回执无效")?;
    let plain=key(token)?.open_in_place(aead::Nonce::assume_unique_for_key(n),aead::Aad::from(b"phonebridge-v2-response"),&mut bytes).map_err(|_|"配对密钥不匹配或回执被修改")?;
    serde_json::from_slice(plain).map_err(|_|"手机回执格式无效".into())
}
fn client()->Result<Client,String> {
    let _=rustls::crypto::ring::default_provider().install_default();
    Client::builder().no_proxy().connect_timeout(Duration::from_secs(2)).timeout(Duration::from_secs(18))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_|"网络初始化失败".into())
}
fn rpc(p:&Phone,route:usize,method:&str,body:Value)->Result<Value,String> {
    let id=format!("{}{}",B64.encode(random()?).replace(['+','/','='],"0"),B64.encode(random()?).replace(['+','/','='],"0"));
    let envelope=seal(&p.token,&json!({"id":id,"deviceId":p.id,"issuedAt":crate::now(),"method":method,"body":body}))?;
    let (url,token,payload)=if route<p.routes.len() {
        (format!("{}/v2/rpc",p.routes[route].url.trim_end_matches('/')),None,envelope)
    } else {
        let r=p.relay.as_ref().ok_or("没有可用线路")?;
        (format!("{}/v1/phone/{}/call",r.url.trim_end_matches('/'),p.id),Some(&r.client_token),json!({"id":id,"envelope":envelope}))
    };
    let budget=if route<p.routes.len(){if method=="health"{3}else{8}}else{18};
    let mut request=client()?.post(url).timeout(Duration::from_secs(budget)).json(&payload);
    if let Some(token)=token {request=request.bearer_auth(token);}
    let response=request.send().map_err(|_|"线路不可达或响应超时")?;
    if !response.status().is_success(){return Err(match response.status().as_u16(){401=>"中转鉴权失败",503=>"手机未连接中转",504=>"未取得结果，操作不会自动重放",409=>"手机忙，请稍后再试",_=>"连接被拒绝"}.into());}
    let mut bytes=Vec::new();response.take(LIMIT+1).read_to_end(&mut bytes).map_err(|_|"回执读取失败")?;
    if bytes.len() as u64>LIMIT{return Err("手机回执过长".into());}
    let reply=open(&p.token,&serde_json::from_slice::<Value>(&bytes).map_err(|_|"加密回执无效")?)?;
    if reply["id"]!=id{return Err("手机回执身份不匹配".into());}
    if reply["ok"]!=true{return Err(reply["error"].as_str().unwrap_or("手机操作失败").chars().filter(|c|!c.is_control()).take(160).collect());}
    Ok(reply["result"].clone())
}
fn choose(p:&Phone,s:&mut Live)->Result<(),String> {
    let mut failures=Vec::new();
    for route in 0..p.routes.len()+usize::from(p.relay.is_some()) {
        match rpc(p,route,"health",json!({})) {
            Ok(health) if health["deviceId"]==p.id=>{s.health=health;s.route=Some(route);s.error=None;return Ok(());},
            Ok(_)=>failures.push("设备身份不匹配".to_string()),Err(e)=>failures.push(format!("{}：{e}",if route<p.routes.len(){p.routes[route].label.as_str()}else{"腾讯上海中转"})),
        }
    }
    s.route=None;s.session=None;
    let e=failures.join("；");s.error=Some(e.clone());Err(e)
}
fn needs_wake(display:&Value)->bool {
    display["secure"]==false && (display["screenOn"]==false || display["locked"]==true)
}
fn start_viewer(p:&Phone,s:&mut Live)->Result<(),String> {
    let route=s.route.ok_or("线路未连接")?;
    let result=rpc(p,route,"viewer.start",json!({}))?;
    s.session=result["session"].as_str().map(String::from);
    if needs_wake(&result["display"]) { rpc(p,route,"wake",json!({}))?; }
    Ok(())
}
fn summary(p:&Phone,s:&Live)->Value {json!({"id":p.id,"name":p.name,"connected":s.route.is_some(),"viewing":s.session.is_some(),
    "route":s.route.map(|i|if i<p.routes.len(){p.routes[i].label.as_str()}else{"腾讯上海中转"}),"error":s.error,"health":s.health,
    "routes":p.routes.iter().map(|r|r.label.clone()).collect::<Vec<_>>(),"relay":p.relay.is_some(),"canRecover":p.adb_recovery.is_some(),"autoRecovery":p.auto_recovery})}

pub fn dispatch(method:&str,params:&Value)->Result<Value,String> {
    if method=="phone_list" {
        let _guard=CONFIG.lock().map_err(|_|"配对配置忙")?;
        let config=read()?;
        return Ok(json!({"phones":config.phones.iter().map(|p|{let l=live(&p.id)?;let s=l.try_lock();Ok(match s{Ok(s)=>summary(p,&s),Err(_)=>json!({"id":p.id,"name":p.name,"busy":true,"canRecover":p.adb_recovery.is_some()})})}).collect::<Result<Vec<_>,String>>()?}));
    }
    if method=="phone_pair" {
        let raw=params["config"].as_str().filter(|s|s.len()<=32768).ok_or("配对配置无效")?;
        let phone:Phone=serde_json::from_str(raw).map_err(|_|"请粘贴手机导出的完整配对配置")?;validate(&phone)?;
        let _guard=CONFIG.lock().map_err(|_|"配对配置忙")?;let mut config=read()?;
        if config.phones.len()>=16&&!config.phones.iter().any(|p|p.id==phone.id){return Err("最多配对 16 台手机".into());}
        config.phones.retain(|p|p.id!=phone.id);config.phones.push(phone.clone());
        crate::local_preferences::write(&root()?,FILE,&config).map_err(|_|"无法保存配对信息")?;
        Ok(json!({"id":phone.id,"paired":true}))
    } else {
        let id=params["id"].as_str().filter(|id|valid_id(id)).ok_or("手机标识无效")?;
        let p={let _guard=CONFIG.lock().map_err(|_|"配对配置忙")?;read()?.phones.into_iter().find(|p|p.id==id).ok_or("手机尚未配对")?};validate(&p)?;
        if method=="phone_auto_recovery" {
            let enabled=params["enabled"].as_bool().ok_or("自动恢复设置无效")?;
            if enabled {recovery::binding_check(&p)?;}
            let _guard=CONFIG.lock().map_err(|_|"配对配置忙")?;let mut config=read()?;
            let phone=config.phones.iter_mut().find(|v|v.id==id).ok_or("手机尚未配对")?;
            let newly_enabled=enabled&&!phone.auto_recovery;
            phone.auto_recovery=enabled;
            crate::local_preferences::write(&root()?,FILE,&config).map_err(|_|"无法保存自动恢复设置")?;
            drop(_guard);
            if newly_enabled {automatic::reset(id);}
            return Ok(json!({"autoEnabled":enabled,"automatic":automatic::summary(id),"status":recovery::status(id)?["status"]}));
        }
        if method=="phone_recover" {return recovery::start(p);}
        if method=="phone_recovery_status" {let mut value=recovery::status(id)?;value["autoEnabled"]=json!(p.auto_recovery);value["automatic"]=automatic::summary(id);return Ok(value);}
        let shared=live(id)?;let mut s=shared.try_lock().map_err(|_|"手机正在处理上一项请求，请稍候")?;
        if method=="phone_remove" {
            if let (Some(route),Some(session))=(s.route,s.session.as_ref()){let _=rpc(&p,route,"viewer.stop",json!({"session":session}));}
            let _guard=CONFIG.lock().map_err(|_|"配对配置忙")?;let mut config=read()?;config.phones.retain(|p|p.id!=id);
            crate::local_preferences::write(&root()?,FILE,&config).map_err(|_|"无法取消配对")?;*s=Live::default();return Ok(json!({"removed":true}));
        }
        match method {
            "phone_connect"=>{choose(&p,&mut s)?;start_viewer(&p,&mut s)?;Ok(summary(&p,&s))},
            "phone_disconnect"=>{let result=if let (Some(route),Some(session))=(s.route,s.session.as_ref()){rpc(&p,route,"viewer.stop",json!({"session":session}))}else{Ok(Value::Null)};s.session=None;s.route=None;result?;Ok(summary(&p,&s))},
            "phone_wake"=>{if s.route.is_none(){choose(&p,&mut s)?;}rpc(&p,s.route.unwrap(),"wake",json!({}))},
            "phone_frame"=>{
                if s.session.is_none(){return Err("请先连接手机".into());}
                match rpc(&p,s.route.ok_or("线路已断开")?,"viewer.frame",json!({"session":s.session})) {
                    Ok(mut frame)=>{frame["route"]=json!(s.route.map(|i|if i<p.routes.len(){p.routes[i].label.as_str()}else{"腾讯上海中转"}));Ok(frame)},
                    Err(e) if e=="线路不可达或响应超时" || e=="手机未连接中转" || e=="回执读取失败" => {
                        // Only read operations reconnect. A control command is never replayed.
                        choose(&p,&mut s)?;
                        start_viewer(&p,&mut s)?;
                        let mut frame=rpc(&p,s.route.unwrap(),"viewer.frame",json!({"session":s.session}))?;
                        frame["route"]=json!(s.route.map(|i|if i<p.routes.len(){p.routes[i].label.as_str()}else{"腾讯上海中转"}));Ok(frame)
                    },
                    Err(e)=>{s.error=Some(e.clone());Err(e)}
                }
            },
            "phone_action"=>{
                let mut body=params["action"].clone();if !body.is_object(){return Err("控制指令无效".into());}
                let kind=body["type"].as_str().ok_or("缺少控制类型")?;
                if !["tap","swipe","back","home","recents","text"].contains(&kind){return Err("不支持的控制类型".into());}
                body["session"]=json!(s.session.as_ref().ok_or("投屏已结束")?);
                rpc(&p,s.route.ok_or("线路已断开")?,"viewer.action",body)
            },
            _=>Err("未知 Phone Bridge 操作".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn connection_only_wakes_explicitly_nonsecure_locked_or_sleeping_devices(){
        assert!(needs_wake(&json!({"secure":false,"screenOn":false,"locked":true})));
        assert!(!needs_wake(&json!({"secure":true,"screenOn":false,"locked":true})));
        assert!(!needs_wake(&json!({"secure":false,"screenOn":true,"locked":false})));
        assert!(!needs_wake(&Value::Null));
    }
    #[test] fn rejects_public_cleartext_and_credentials(){assert!(validate_url("http://8.8.8.8:8765",false).is_err());assert!(validate_url("http://192.168.1.2:8765",false).is_ok());assert!(validate_url("http://100.120.67.49:8765",false).is_ok());assert!(validate_url("https://user:secret@example.com",true).is_err());assert!(validate_url("http://127.0.0.1",true).is_err());}
    #[test] fn encryption_binds_direction_and_key(){let token="a".repeat(48);let e=seal(&token,&json!({"id":"sample"})).unwrap();assert!(!e.to_string().contains("sample"));assert!(open(&token,&e).is_err());let mut encrypted=B64.decode(e["data"].as_str().unwrap()).unwrap();let n:B64Nonce=B64.decode(e["nonce"].as_str().unwrap()).unwrap().try_into().unwrap();let plaintext=key(&token).unwrap().open_in_place(aead::Nonce::assume_unique_for_key(n),aead::Aad::from(b"phonebridge-v2-request"),&mut encrypted).unwrap();assert_eq!(serde_json::from_slice::<Value>(plaintext).unwrap()["id"],"sample");}
    type B64Nonce=[u8;12];
    #[test] fn summary_never_contains_credentials(){let p=Phone{id:"a".repeat(16),name:"test".into(),token:"secret-pairing".into(),routes:vec![Route{label:"VPN".into(),url:"http://100.64.0.1:8765".into()}],relay:Some(Relay{url:"https://example.com".into(),client_token:"secret-client".into()}),adb_recovery:None,auto_recovery:false};let value=summary(&p,&Live::default()).to_string();assert!(!value.contains("secret"));assert!(!value.contains("100.64"));}
}
