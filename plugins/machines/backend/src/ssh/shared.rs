//! Embedded shared SSH component; no external toolkit or Python installation.
include!(concat!(env!("OUT_DIR"), "/ssh_core.rs"));
use serde_json::{json,Value};
use std::path::{Path,PathBuf};
use std::process::{Command,Stdio};
use std::io::Write;

pub fn binary()->Result<PathBuf,String>{
    use sha2::{Digest,Sha256};
    use std::os::unix::fs::{PermissionsExt,OpenOptionsExt};
    if CORE.is_empty(){return Err("安装包缺少内置 SSH 组件，请重新构建或更新机器插件".into());}
    let hash=format!("{:x}",Sha256::digest(CORE));
    let root=dirs::home_dir().ok_or("找不到用户目录")?.join(".cache/flowhub/ssh-core").join(&hash);
    std::fs::create_dir_all(&root).map_err(|e|e.to_string())?;
    if root.symlink_metadata().map_err(|e|e.to_string())?.file_type().is_symlink(){return Err("SSH 组件缓存不能是软链接".into());}
    std::fs::set_permissions(&root,std::fs::Permissions::from_mode(0o700)).map_err(|e|e.to_string())?;
    let path=root.join("flowhub-ssh");
    let valid=path.symlink_metadata().is_ok_and(|m|m.is_file()&&!m.file_type().is_symlink()) && std::fs::read(&path).is_ok_and(|b|b==CORE);
    if !valid {
        let temporary=root.join(format!(".core-{}-{}",std::process::id(),chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()));
        let result=(||{let mut f=std::fs::OpenOptions::new().write(true).create_new(true).mode(0o700).open(&temporary).map_err(|e|e.to_string())?;f.write_all(CORE).map_err(|e|e.to_string())?;f.sync_all().map_err(|e|e.to_string())?;std::fs::rename(&temporary,&path).map_err(|e|e.to_string())})();
        let _=std::fs::remove_file(&temporary);result?;
    }
    std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o700)).map_err(|e|e.to_string())?;
    Ok(path)
}
pub fn path(root:&Path)->Option<PathBuf>{
    if let Ok(bytes)=std::fs::read(root.join("state.json")) {
        if let Ok(value)=serde_json::from_slice::<Value>(&bytes) {
            if let Some(path)=value["sharedConfigFile"].as_str(){return Some(PathBuf::from(path));}
        }
    }
    let value:Value=serde_json::from_slice(&std::fs::read(root.join("shared-ssh.json")).ok()?).ok()?;
    value["path"].as_str().map(PathBuf::from)
}
pub fn call(path:&Path,value:Value)->Result<Value,String>{
    let mut child=Command::new(binary()?).args(["bridge","--config"]).arg(path)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|_|"无法启动内置 SSH 组件")?;
    child.stdin.take().ok_or("缺少输入")?.write_all(value.to_string().as_bytes()).map_err(|e|e.to_string())?;
    let result=child.wait_with_output().map_err(|e|e.to_string())?;
    let bytes=if result.status.success(){&result.stdout}else{&result.stderr};
    let data:Value=serde_json::from_slice(bytes).map_err(|_|"内置 SSH 组件响应无效")?;
    if let Some(error)=data["error"].as_str(){return Err(error.into());}Ok(data)
}
pub async fn request(path:PathBuf,value:Value)->Result<Value,String>{
    tokio::task::spawn_blocking(move||call(&path,value)).await.map_err(|e|e.to_string())?
}
pub fn rows(path:&Path)->Result<Vec<Value>,String>{
    let data:Value=serde_json::from_slice(&std::fs::read(path).map_err(|_|"无法读取共享 SSH 配置")?).map_err(|_|"共享 SSH 配置无效")?;
    data.as_array().cloned().ok_or("共享配置必须是数组".into())
}
pub fn load(root:&Path,alias:&str)->Result<Option<super::connections::Connection>,String>{
    let path=path(root).ok_or("未启用共享配置")?;
    let rows=rows(&path)?;let matches:Vec<_>=rows.iter().filter(|r|r["name"].as_str()==Some(alias)).collect();
    if matches.len()>1{return Err("共享配置别名重复".into());}
    let Some(row)=matches.first() else{return Ok(None)};
    if row["type"]=="relay"{return Ok(None);}
    let profile=super::ssh_profiles::Profile{alias:alias.into(),hostname:row["host"].as_str().unwrap_or("").into(),user:row["username"].as_str().unwrap_or("").into(),port:row["port"].as_u64().unwrap_or(22).try_into().map_err(|_|"端口无效")?,identity_file:row["privateKey"].as_str().unwrap_or("").into(),proxy_jump:row["proxyJump"].as_str().unwrap_or("").into()};
    profile.validate()?;
    Ok(Some(super::connections::Connection{profile,password_auth:row["password"].as_str().is_some_and(|s|!s.is_empty())}))
}
pub fn revision(root:&Path)->Result<String,String>{
    Ok(call(&path(root).ok_or("未启用共享配置")?,json!({"action":"profiles"}))?["revision"].as_str().ok_or("缺少配置版本")?.into())
}
pub fn save(root:&Path,c:&super::connections::Connection,expected:&str,password:Option<&str>)->Result<String,String>{
    let p=&c.profile;let mut row=json!({"name":p.alias,"host":p.hostname,"username":p.user,"port":p.port,"privateKey":p.identity_file,"proxyJump":p.proxy_jump});
    if !c.password_auth{row["password"]=json!("");}else if let Some(password)=password.filter(|s|!s.is_empty()){row["password"]=json!(password);}
    let path=path(root).ok_or("未启用共享配置")?;
    let result=call(&path,json!({"action":"save","profile":row,"revision":expected}))?;
    Ok(result["revision"].as_str().ok_or("缺少配置版本")?.into())
}
pub async fn terminal(path:PathBuf,alias:&str)->Result<(),String>{
    let quote=|s:&str|format!("'{}'",s.replace('\'',"'\\''"));
    let command=format!("exec {} console {} --config {}",quote(&binary()?.to_string_lossy()),quote(alias),quote(&path.to_string_lossy()));
    let script=format!("tell application \"Terminal\"\nactivate\ndo script {}\nend tell",serde_json::to_string(&command).unwrap());
    if !tokio::process::Command::new("/usr/bin/osascript").args(["-e",&script]).status().await.map_err(|e|e.to_string())?.success(){return Err("无法打开系统终端".into());}Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_profiles_are_loaded_without_secrets_in_the_runtime_model(){
        let root=std::env::temp_dir().join(format!("fh-shared-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        std::fs::create_dir_all(&root).unwrap();let file=root.join("profiles.json");
        std::fs::write(&file,json!([{"name":"test","host":"example.test","username":"tester","port":2222,"password":"private","allowedLocalPaths":["/tmp"]}]).to_string()).unwrap();
        std::fs::write(root.join("shared-ssh.json"),json!({"path":file}).to_string()).unwrap();
        let c=load(&root,"test").unwrap().unwrap();assert_eq!(c.profile.port,2222);assert!(c.password_auth);
        assert!(!serde_json::to_string(&c).unwrap().contains("private"));
        assert!(load(&root,"missing").unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
