//! Explicit recovery and opt-in monitored recovery share the same identity checks.
use super::*;
use std::{thread, time::Instant};

static JOBS: OnceLock<Mutex<HashMap<String,Value>>> = OnceLock::new();
fn jobs()->&'static Mutex<HashMap<String,Value>> {JOBS.get_or_init(Default::default)}
pub(super) fn status(id:&str)->Result<Value,String> {
    Ok(jobs().lock().map_err(|_|"恢复状态不可用")?.get(id).cloned().unwrap_or(json!({"status":"idle"})))
}
fn update(id:&str,patch:Value) {
    if let Ok(mut jobs)=jobs().lock(){if let Some(job)=jobs.get_mut(id){
        if patch["stage"].is_string()&&patch["stage"]!=job["stage"] {
            if let Some(history)=job["history"].as_array_mut(){history.push(json!({"stage":patch["stage"],"time":crate::now()}));}
        }
        if let Some(patch)=patch.as_object(){for(k,v)in patch{job[k]=v.clone();}}
        job["updatedAt"]=json!(crate::now());
    }}
}
fn binding(p:&Phone)->Result<&RecoveryBinding,String> {
    let b=p.adb_recovery.as_ref().ok_or("该手机尚未绑定已配对的 ADB 设备")?;
    let path=std::env::var_os("FLOWHUB_TOOLKIT_ADB_CONFIG").map(PathBuf::from)
        .or_else(||std::env::var_os("HOME").map(PathBuf::from).map(|h|h.join(".config/toolkit/adb-devices.json"))).ok_or("找不到 ADB 设备配置")?;
    let data:Value=crate::local_preferences::read(path.parent().ok_or("ADB 配置路径无效")?,path.file_name().and_then(|s|s.to_str()).ok_or("ADB 配置路径无效")?,256*1024)
        .map_err(|_|"ADB 设备配置无法读取")?.ok_or("ADB 设备配置不存在")?;
    validated_endpoint(&data,b)?;
    Ok(b)
}
fn validated_endpoint<'a>(data:&'a Value,b:&RecoveryBinding)->Result<&'a str,String>{
    let device=&data["devices"][&b.alias];
    if data["version"]!=1 || device["identity"]!=b.identity || !device["host"].is_null() {
        return Err("ADB 绑定身份或执行位置已变化，未进行恢复".into());
    }
    let endpoint=device["serial"].as_str().ok_or("ADB 设备入口无效")?;
    if !endpoint.starts_with("127.0.0.1:")||endpoint.parse::<std::net::SocketAddr>().is_err(){return Err("一键恢复仅接受已登记的本机稳定转发入口".into());}
    Ok(endpoint)
}
pub(super) fn start(p:Phone)->Result<Value,String> {start_inner(p,false)}
pub(super) fn start_automatic(p:Phone)->Result<Value,String> {
    let enabled={let _guard=CONFIG.lock().map_err(|_|"配对配置忙")?;read()?.phones.iter().any(|v|v.id==p.id&&v.auto_recovery)};
    if !enabled{return Err("自动恢复已关闭".into());}
    start_inner(p,true)
}
enum Outcome {Complete,Deferred(String)}
fn start_inner(p:Phone,automatic:bool)->Result<Value,String> {
    binding(&p)?;
    let initial=json!({"status":"running","trigger":if automatic{"automatic"}else{"manual"},"stage":"connecting-phone","startedAt":crate::now(),"updatedAt":crate::now(),"history":[]});
    {let mut jobs=jobs().lock().map_err(|_|"恢复状态不可用")?;
        if let Some(old)=jobs.get(&p.id).filter(|v|v["status"]=="running"){return Ok(old.clone());}
        if jobs.len()>=32 {jobs.retain(|_,v|v["status"]=="running");}
        jobs.insert(p.id.clone(),initial.clone());
    }
    thread::spawn(move||{
        let result=run(&p,automatic);
        match result {
            Ok(Outcome::Complete)=>update(&p.id,json!({"status":"success","stage":"ready","identityVerified":true,"finishedAt":crate::now()})),
            Ok(Outcome::Deferred(reason))=>update(&p.id,json!({"status":"deferred","reason":reason,"finishedAt":crate::now()})),
            Err(error)=>update(&p.id,json!({"status":"failed","error":error,"finishedAt":crate::now()})),
        }
    });
    Ok(initial)
}
fn select_recovery_route(p:&Phone,s:&mut Live)->Result<usize,String> {
    let relay=p.routes.len();
    if p.relay.is_some(){match rpc(p,relay,"health",json!({})){
        Ok(health) if health["deviceId"]==p.id=>{s.route=Some(relay);s.health=health;},
        _=>choose(p,s)?,
    }}else{choose(p,s)?;}
    s.route.ok_or("Phone Bridge 线路不可用".into())
}
pub(super) fn automatic_eligibility(p:&Phone)->Result<Value,String> {
    binding(p)?;let shared=live(&p.id)?;let mut s=shared.try_lock().map_err(|_|"手机会话忙")?;
    if s.session.is_some(){return Ok(json!({"allowed":false,"reason":"viewing"}));}
    let route=select_recovery_route(p,&mut s)?;
    if s.health["automaticRecoverySupported"]!=true{return Ok(json!({"allowed":false,"reason":"upgrade-required"}));}
    rpc(p,route,"recovery.eligibility",json!({}))
}
fn run(p:&Phone,automatic:bool)->Result<Outcome,String> {
    let binding=binding(p)?;
    let shared=live(&p.id)?;let mut s=shared.lock().map_err(|_|"手机会话不可用")?;
    // Prefer outbound relay so a failed private network does not prevent its own repair.
    if automatic && s.session.is_some(){return Ok(Outcome::Deferred("viewing".into()));}
    let route=select_recovery_route(p,&mut s)?;
    if s.health["adbRecoverySupported"]!=true{return Err("请先在手机升级支持 ADB 恢复的 Phone Bridge".into());}
    if let Some(session)=s.session.take(){let _=rpc(p,route,"viewer.stop",json!({"session":session}));}
    update(&p.id,json!({"phoneRoute":if route<p.routes.len(){p.routes[route].label.as_str()}else{"腾讯上海中转"}}));
    let started=rpc(p,route,"recovery.start",json!({"expectedIdentity":binding.identity,"automatic":automatic}))?;
    if started["status"]=="deferred" {return Ok(Outcome::Deferred(started["reason"].as_str().unwrap_or("phone-busy").into()));}
    let job_id=started["jobId"].as_str().ok_or("手机未返回恢复任务标识")?.to_string();
    let deadline=Instant::now()+Duration::from_secs(70);
    let port=loop {
        if Instant::now()>deadline{return Err("手机端恢复超时，请查看当前投屏页面".into());}
        thread::sleep(Duration::from_millis(600));
        let result=match rpc(p,route,"recovery.status",json!({})) {
            Ok(result)=>result,
            Err(error)=>{
                // Status is read-only. Never replay recovery.start after a lost receipt.
                update(&p.id,json!({"statusReadError":error}));
                continue;
            }
        };
        if result["jobId"]!=job_id{return Err("手机恢复任务已变化，未继续连接".into());}
        update(&p.id,json!({"stage":result["stage"],"phoneHistory":result["history"],"easyTierStarted":result["easyTierStarted"],"wirelessWasEnabled":result["wirelessWasEnabled"],"wirelessChanged":result["wirelessChanged"],"portSource":result["portSource"],"recognition":result["recognition"]}));
        if result["status"]=="failed"{return Err(result["error"].as_str().unwrap_or("手机恢复失败").chars().take(160).collect());}
        if result["status"]=="ready" {
            if result["wirelessEnabled"]!=true||!result["connectPort"].as_u64().is_some_and(|p|(1024..=65535).contains(&p)){return Err("手机没有返回有效连接端口".into());}
            update(&p.id,json!({"wirelessPort":result["connectPort"]}));break result["connectPort"].as_u64().ok_or("连接端口缺失")?;
        }
    };
    // Explicit bridge-only path: use the fresh UI port without requiring AutoJs.
    // The normal Toolkit recovery entry remains UI-free and unchanged.
    binding_check(p)?;
    update(&p.id,json!({"stage":"connecting-adb"}));
    let (python,helper)=helper(p)?;
    let raw=run_helper(&python,&[&helper,"--phonebridge-port",&port.to_string(),"--expected-identity",&binding.identity])?;
    let receipt:Value=serde_json::from_slice(&raw).map_err(|_|"电脑恢复助手回执无效")?;
    if receipt["ready"]!=true||receipt["identityVerified"]!=true{return Err(receipt["error"].as_str().unwrap_or("恢复助手尚未确认已配对手机身份").chars().take(180).collect());}
    if receipt["tlsPort"]!=port||receipt["endpoint"]!=binding_check(p)?{return Err("恢复助手回执与当前连接不匹配".into());}
    update(&p.id,json!({"stage":"verifying-adb"}));
    let endpoint=binding_check(p)?;
    let adb=crate::adb::find().ok_or("本机未找到 ADB")?;
    let observed=crate::read_system_query(adb.to_str().ok_or("ADB 路径无效")?,&["-s",&endpoint,"shell","getprop","ro.serialno"],Duration::from_secs(5),256)
        .map_err(|_|"ADB 尚未返回手机身份，未报告恢复成功".to_string())?;
    if String::from_utf8_lossy(&observed).trim()!=binding.identity{return Err("ADB 返回的手机身份不符，已停止".into());}
    Ok(Outcome::Complete)
}
fn run_helper(program:&str,args:&[&str])->Result<Vec<u8>,String>{
    use std::process::{Command,Stdio};
    let mut child=Command::new(program).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_|"电脑端恢复助手未能启动")?;
    let out=child.stdout.take().ok_or("无法读取恢复助手回执")?;
    let reader=thread::spawn(move||{let mut bytes=Vec::new();let _=out.take(16385).read_to_end(&mut bytes);bytes});
    let started=Instant::now();
    let timed_out=loop{match child.try_wait(){Ok(Some(_))=>break false,Ok(None) if started.elapsed()<Duration::from_secs(40)=>thread::sleep(Duration::from_millis(60)),_=>{let _=child.kill();let _=child.wait();break true;}}};
    let bytes=reader.join().map_err(|_|"恢复助手回执读取失败")?;
    if timed_out{return Err("电脑端恢复助手超时；未报告连接成功".into());}
    if bytes.len()>16384{return Err("恢复助手回执超过限制".into());}
    Ok(bytes)
}
fn helper(p:&Phone)->Result<(String,String),String>{
    use std::os::unix::fs::{MetadataExt,PermissionsExt};
    let b=binding(p)?;
    let path=std::env::var_os("FLOWHUB_TOOLKIT_ADB_CONFIG").map(PathBuf::from).or_else(||std::env::var_os("HOME").map(PathBuf::from).map(|h|h.join(".config/toolkit/adb-devices.json"))).ok_or("ADB 配置不可用")?;
    let data:Value=crate::local_preferences::read(path.parent().ok_or("ADB 配置路径无效")?,path.file_name().and_then(|s|s.to_str()).ok_or("ADB 配置路径无效")?,256*1024).map_err(|_|"ADB 配置无法读取")?.ok_or("ADB 配置缺失")?;
    let recovery=&data["devices"][&b.alias]["recovery"];
    if recovery["type"]!="local-helper-v1"{return Err("尚未登记支持 Phone Bridge 的恢复助手".into());}
    let python=recovery["python"].as_str().ok_or("恢复助手 Python 缺失")?;
    let helper=recovery["helper"].as_str().ok_or("恢复助手缺失")?;
    for file in [python,helper]{let path=std::path::Path::new(file);let info=path.metadata().map_err(|_|"恢复助手文件不可用")?;
        if !path.is_absolute()||!info.is_file()||info.permissions().mode()&0o022!=0||!(info.uid()==0||info.uid()==unsafe{libc::geteuid()}){return Err("恢复助手文件权限不安全".into());}}
    Ok((python.into(),helper.into()))
}
pub(super) fn binding_check(p:&Phone)->Result<String,String>{
    let b=binding(p)?;
    let path=std::env::var_os("FLOWHUB_TOOLKIT_ADB_CONFIG").map(PathBuf::from).or_else(||std::env::var_os("HOME").map(PathBuf::from).map(|h|h.join(".config/toolkit/adb-devices.json"))).ok_or("找不到 ADB 配置")?;
    let data:Value=crate::local_preferences::read(path.parent().ok_or("ADB 配置路径无效")?,path.file_name().and_then(|v|v.to_str()).ok_or("ADB 配置路径无效")?,256*1024).map_err(|_|"ADB 配置无法读取")?.ok_or("ADB 配置不存在")?;
    Ok(validated_endpoint(&data,b)?.into())
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn recovery_refuses_other_identity_remote_host_and_changed_endpoint(){
        let b=RecoveryBinding{alias:"phone".into(),identity:"serial-one".into()};
        let mut d=json!({"version":1,"devices":{"phone":{"identity":"serial-one","serial":"127.0.0.1:17354"}}});
        assert_eq!(validated_endpoint(&d,&b).unwrap(),"127.0.0.1:17354");
        d["devices"]["phone"]["identity"]=json!("serial-two");assert!(validated_endpoint(&d,&b).is_err());
        d["devices"]["phone"]["identity"]=json!("serial-one");d["devices"]["phone"]["host"]=json!("another-mac");assert!(validated_endpoint(&d,&b).is_err());
        d["devices"]["phone"]["host"]=Value::Null;d["devices"]["phone"]["serial"]=json!("100.64.0.1:5555");assert!(validated_endpoint(&d,&b).is_err());
    }
}
