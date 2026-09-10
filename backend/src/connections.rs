//! Plugin-owned profiles and encrypted SQLite credentials.
use crate::ssh_profiles::Profile;
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
use std::path::{Path,PathBuf};

#[derive(Clone,Serialize,Deserialize)]
pub(crate) struct Connection { pub profile:Profile, #[serde(default)] pub password_auth:bool }
fn path(root:&Path,alias:&str)->PathBuf { root.join("connections").join(format!("{:x}.json",Sha256::digest(alias.as_bytes()))) }
pub fn load(root:&Path,alias:&str)->Result<Option<Connection>,String>{
    match std::fs::read(path(root,alias)){Ok(bytes)=>serde_json::from_slice(&bytes).map(Some).map_err(|e|e.to_string()),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(None),Err(e)=>Err(e.to_string())}
}
pub fn revision(root:&Path,alias:&str)->Result<String,String>{
    Ok(format!("{:x}",Sha256::digest(serde_json::to_vec(&load(root,alias)?).map_err(|e|e.to_string())?)))
}
fn account(c:&Connection)->String {
    format!("{:x}",Sha256::digest(format!("{}\0{}\0{}\0{}",c.profile.alias,c.profile.hostname,c.profile.user,c.profile.port).as_bytes()))
}
pub fn validate_backup(root:&Path,c:&Connection)->Result<(),String>{
    if c.password_auth{crate::vault::read(root,&account(c))?;}Ok(())
}
pub fn save(root:&Path,c:&Connection,expected:&str,password:Option<&str>)->Result<String,String>{
    static SAVE_LOCK:std::sync::Mutex<()>=std::sync::Mutex::new(());
    let _lock=SAVE_LOCK.lock().map_err(|_|"配置保存锁不可用")?;
    c.profile.validate()?;
    if revision(root,&c.profile.alias)?!=expected{return Err("连接配置已变化，请重新加载".into());}
    if c.password_auth {
        if !c.profile.proxy_jump.is_empty(){return Err("密码认证暂不支持跳板机，请使用密钥或堡垒机会话".into());}
        if let Some(password)=password.filter(|p|!p.is_empty()) {
            if password.len()>4096 || password.contains(['\n','\r','\0']){return Err("密码格式无效".into());}
            crate::vault::save(root,&account(c),password.as_bytes())?;
        } else { crate::vault::read(root,&account(c)).map_err(|_|"请输入该地址和用户名的登录密码")?; }
    }
    std::fs::create_dir_all(root.join("connections")).map_err(|e|e.to_string())?;
    crate::storage::write_json_atomic(&path(root,&c.profile.alias),&serde_json::to_value(c).map_err(|e|e.to_string())?)?;
    revision(root,&c.profile.alias)
}
pub fn configure(process:&mut tokio::process::Command,c:&Connection,root:&Path)->Result<(),String>{
    process.env("LC_ALL","C");
    process.args(c.profile.options()?);
    if c.password_auth {
        // Disable inherited proxy commands: never send this password to another endpoint.
        process.args(["-o","BatchMode=no","-o","PreferredAuthentications=password","-o","PubkeyAuthentication=no","-o","KbdInteractiveAuthentication=no","-o","NumberOfPasswordPrompts=1","-o","ProxyJump=none","-o","ProxyCommand=none"]);
        process.env("SSH_ASKPASS",std::env::current_exe().map_err(|e|e.to_string())?)
            .env("SSH_ASKPASS_REQUIRE","force").env("DISPLAY",":0")
            .env("FLOWHUB_ASKPASS_ACCOUNT",account(c)).env("FLOWHUB_CREDENTIAL_ROOT",root);
    }
    Ok(())
}
pub fn askpass()->Option<Result<(),String>> {
    let account=std::env::var("FLOWHUB_ASKPASS_ACCOUNT").ok()?;
    let prompt=std::env::args().nth(1).unwrap_or_default().to_lowercase();
    Some((||{
        if !prompt.contains("password:") {return Err("不支持的认证提示".into());}
        let root=std::env::var_os("FLOWHUB_CREDENTIAL_ROOT").ok_or("缺少密码存储目录")?; let password=crate::vault::read(Path::new(&root),&account)?;
        use std::io::Write;std::io::stdout().write_all(&password).and_then(|_|std::io::stdout().write_all(b"\n")).map_err(|e|e.to_string())
    })())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn connection()->Connection {Connection{profile:Profile{alias:"sample".into(),hostname:"example.test".into(),user:"tester".into(),port:22,identity_file:String::new(),proxy_jump:String::new()},password_auth:false}}
    #[test]
    fn profiles_live_in_plugin_and_reject_stale_writes(){
        let root=std::env::temp_dir().join(format!("plugin-profile-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        std::fs::create_dir_all(&root).unwrap();let c=connection();let old=revision(&root,"sample").unwrap();
        save(&root,&c,&old,None).unwrap();assert!(load(&root,"sample").unwrap().is_some());
        assert!(save(&root,&c,&old,None).is_err());assert!(!root.join("config").exists());
        assert!(!std::fs::read_to_string(path(&root,"sample")).unwrap().contains("password\":"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn password_options_are_endpoint_bound_and_secrets_are_not_in_arguments(){
        let mut c=connection();c.password_auth=true;let original=account(&c);c.profile.hostname="other.test".into();assert_ne!(original,account(&c));
        let mut process=tokio::process::Command::new("ssh");configure(&mut process,&c,Path::new("/tmp")).unwrap();
        let args:Vec<_>=process.as_std().get_args().map(|a|a.to_str().unwrap()).collect();
        assert!(args.contains(&"BatchMode=no"));assert!(args.contains(&"PreferredAuthentications=password"));assert!(args.contains(&"ProxyCommand=none"));
        assert!(process.as_std().get_envs().any(|(key,_)|key=="FLOWHUB_ASKPASS_ACCOUNT"));
    }
}
