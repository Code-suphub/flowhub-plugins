//! Versioned password-encrypted backups and restart-safe directory replacement.
use base64::{Engine,engine::general_purpose::STANDARD as B64};
use ring::{aead,pbkdf2,rand::{SecureRandom,SystemRandom}};
use serde::{Serialize,Deserialize};
use serde_json::{Value,json};
use std::{collections::BTreeMap,path::{Path,PathBuf},num::NonZeroU32,sync::Mutex,io::Write,os::unix::fs::{OpenOptionsExt,PermissionsExt}};
const LIMIT:usize=128*1024*1024;
#[derive(Serialize,Deserialize)]
struct Archive { version:u32,created:String,files:BTreeMap<String,String> }
#[derive(Serialize,Deserialize)]
struct Envelope { format:String,version:u32,salt:String,nonce:String,ciphertext:String }
fn stamp()->String{chrono::Utc::now().timestamp_nanos_opt().unwrap().to_string()}
fn random<const N:usize>()->Result<[u8;N],String>{let mut v=[0;N];SystemRandom::new().fill(&mut v).map_err(|_|"随机数生成失败")?;Ok(v)}
fn derive(password:&str,salt:&[u8])->Result<aead::LessSafeKey,String>{
    if password.chars().count()<12 || password.len()>1024{return Err("备份口令需为 12–1024 个字符，请妥善保存".into());}
    let mut key=[0;32];pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256,NonZeroU32::new(600_000).unwrap(),salt,password.as_bytes(),&mut key);
    Ok(aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM,&key).map_err(|_|"密钥生成失败")?))
}
fn encrypt(archive:&Archive,password:&str)->Result<Vec<u8>,String>{
    let salt=random::<16>()?;let nonce=random::<12>()?;let mut data=serde_json::to_vec(archive).map_err(|e|e.to_string())?;
    derive(password,&salt)?.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce),aead::Aad::from(b"FlowHub backup v1"),&mut data).map_err(|_|"备份加密失败")?;
    serde_json::to_vec(&Envelope{format:"flowhub-machines-backup".into(),version:1,salt:B64.encode(salt),nonce:B64.encode(nonce),ciphertext:B64.encode(data)}).map_err(|e|e.to_string())
}
fn decrypt(data:&[u8],password:&str)->Result<Archive,String>{
    if data.len()>LIMIT*2{return Err("备份包超过 256 MiB".into());}
    let e:Envelope=serde_json::from_slice(data).map_err(|_|"无效的备份格式")?;
    if e.format!="flowhub-machines-backup" || e.version!=1{return Err("不支持的备份版本".into());}
    let salt=B64.decode(e.salt).map_err(|_|"备份已损坏")?;if salt.len()!=16{return Err("备份已损坏".into());}
    let nonce:[u8;12]=B64.decode(e.nonce).map_err(|_|"备份已损坏")?.try_into().map_err(|_|"备份已损坏")?;
    let mut ciphertext=B64.decode(e.ciphertext).map_err(|_|"备份已损坏")?;
    let key=derive(password,&salt)?;
    let plain=key.open_in_place(aead::Nonce::assume_unique_for_key(nonce),aead::Aad::from(b"FlowHub backup v1"),&mut ciphertext).map_err(|_|"备份口令错误或文件已被修改")?;
    let archive:Archive=serde_json::from_slice(plain).map_err(|_|"备份内容无效")?;
    if archive.version!=1{return Err("不支持的数据版本".into());}Ok(archive)
}
fn private_dir(path:&Path)->Result<(),String>{std::fs::create_dir_all(path).map_err(|e|e.to_string())?;std::fs::set_permissions(path,std::fs::Permissions::from_mode(0o700)).map_err(|e|e.to_string())}
fn write_new(path:&Path,bytes:&[u8])->Result<(),String>{let mut f=std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path).map_err(|e|e.to_string())?;f.write_all(bytes).and_then(|_|f.sync_all()).map_err(|e|e.to_string())}
fn read_limited(path:&Path,limit:usize)->Result<Vec<u8>,String>{
    use std::io::Read;let meta=std::fs::symlink_metadata(path).map_err(|e|e.to_string())?;
    if !meta.is_file() || meta.len()>limit as u64{return Err("备份文件类型或大小无效".into());}
    let mut bytes=Vec::new();std::fs::File::open(path).map_err(|e|e.to_string())?.take(limit as u64+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
    if bytes.len()>limit{return Err("备份文件过大".into());}Ok(bytes)
}
fn allowed(name:&str)->bool{
    matches!(name,"state.json"|"commands.sqlite3"|"credentials.sqlite3"|"credentials.key") || name.strip_prefix("connections/").and_then(|n|n.strip_suffix(".json")).is_some_and(|s|s.len()==64 && s.bytes().all(|c|c.is_ascii_hexdigit()))
}
struct Temp(PathBuf);impl Drop for Temp{fn drop(&mut self){let _=std::fs::remove_dir_all(&self.0);}}
fn temp(root:&Path)->Result<Temp,String>{let path=root.parent().ok_or("数据目录无效")?.join(format!(".machines-backup-{}",stamp()));private_dir(&path)?;Ok(Temp(path))}
fn collect(root:&Path)->Result<Archive,String>{
    let scratch=temp(root)?;let mut files=BTreeMap::new();
    let mut names=vec!["state.json".to_string(),"commands.sqlite3".into(),"credentials.sqlite3".into(),"credentials.key".into()];
    if root.join("connections").exists(){for item in std::fs::read_dir(root.join("connections")).map_err(|e|e.to_string())? {let name=format!("connections/{}",item.map_err(|e|e.to_string())?.file_name().to_string_lossy());if !allowed(&name){return Err("连接目录中有未知文件，未生成不完整备份".into());}names.push(name);}}
    let mut total=0;
    for name in names {
        let source=root.join(&name);if !source.exists(){continue;}
        let data=if name.ends_with(".sqlite3"){
            read_limited(&source,LIMIT)?;
            let db=rusqlite::Connection::open_with_flags(&source,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e|e.to_string())?;
            let target=scratch.0.join(&name);db.backup("main",&target,None).map_err(|e|e.to_string())?;read_limited(&target,LIMIT)?
        }else{read_limited(&source,LIMIT)?};
        total+=data.len();if total>LIMIT{return Err("插件数据超过 128 MiB，暂不支持此大小的备份".into());}files.insert(name,B64.encode(data));
    }
    if !files.contains_key("state.json"){files.insert("state.json".into(),B64.encode(b"{}"));}
    Ok(Archive{version:1,created:chrono::Utc::now().to_rfc3339(),files})
}
fn unpack(archive:&Archive,root:&Path)->Result<Value,String>{
    if archive.files.len()>10000 || !archive.files.contains_key("state.json"){return Err("备份缺少配置或文件过多".into());}
    let mut total=0;
    for (name,data) in &archive.files{
        if !allowed(name){return Err("备份含有未知路径".into());}let bytes=B64.decode(data).map_err(|_|"备份数据损坏")?;
        total+=bytes.len();if total>LIMIT{return Err("备份解压数据过大".into());}
        let path=root.join(name);private_dir(path.parent().unwrap())?;write_new(&path,&bytes)?;
    }
    let mut state:Value=serde_json::from_slice(&read_limited(&root.join("state.json"),LIMIT)?).map_err(|_|"机器配置损坏")?;
    if !state.is_object(){return Err("机器配置无效".into());}
    state["monitoring"]=json!(false);
    crate::machines::validate_backup_state(&state,root)?;
    let has_db=root.join("credentials.sqlite3").exists();let has_key=root.join("credentials.key").exists();
    if has_db && !has_key{return Err("密码数据库缺少配套密钥".into());}
    if has_key && read_limited(&root.join("credentials.key"),32)?.len()!=32{return Err("备份中的密码密钥无效".into());}
    if has_db{
        let db=rusqlite::Connection::open_with_flags(root.join("credentials.sqlite3"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e|e.to_string())?;
        let mut stmt=db.prepare("SELECT account FROM credentials").map_err(|_|"密码数据库格式无效")?;
        let accounts=stmt.query_map([],|row|row.get::<_,String>(0)).map_err(|e|e.to_string())?;
        for account in accounts{crate::vault::read(root,&account.map_err(|e|e.to_string())?)?;}
    }
    for name in archive.files.keys().filter(|s|s.starts_with("connections/")){
        let c:crate::connections::Connection=serde_json::from_slice(&read_limited(&root.join(name),LIMIT)?).map_err(|_|"连接配置损坏")?;c.profile.validate()?;
        crate::connections::validate_backup(root,&c)?;
    }
    crate::storage::write_json_atomic(&root.join("state.json"),&state)?;
    Ok(json!({"created":archive.created,"machines":state["hosts"].as_array().map_or(0,Vec::len),"files":archive.files.len(),"hasPasswords":has_db,"hasHistory":root.join("commands.sqlite3").exists()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backup_restores_configuration_history_and_decryptable_credentials(){
        let parent=std::env::temp_dir().join(format!("backup-test-{}",stamp()));let root=parent.join("machines");private_dir(&root).unwrap();
        write_new(&root.join("state.json"),br#"{"hosts":[],"monitoring":true}"#).unwrap();
        let db=rusqlite::Connection::open(root.join("commands.sqlite3")).unwrap();db.execute_batch("CREATE TABLE fixture(value TEXT);INSERT INTO fixture VALUES ('retained')").unwrap();drop(db);
        crate::vault::save(&root,"fixture",b"fixture-secret-value").unwrap();
        let archive=collect(&root).unwrap();let encrypted=encrypt(&archive,"fixture-backup-passphrase").unwrap();
        assert!(!encrypted.windows(20).any(|s|s==b"fixture-secret-value"));
        assert!(decrypt(&encrypted,"wrong-passphrase-here").is_err());
        let mut tampered:Value=serde_json::from_slice(&encrypted).unwrap();let mut bytes=B64.decode(tampered["ciphertext"].as_str().unwrap()).unwrap();bytes[0]^=1;tampered["ciphertext"]=json!(B64.encode(bytes));assert!(decrypt(&serde_json::to_vec(&tampered).unwrap(),"fixture-backup-passphrase").is_err());
        let archive=decrypt(&encrypted,"fixture-backup-passphrase").unwrap();
        std::fs::write(root.join("state.json"),br#"{"hosts":[],"interval":120}"#).unwrap();
        let rollback=stage(&root,&archive).unwrap();assert!(root.exists());apply_pending(&root).unwrap();
        assert!(rollback.exists());assert_eq!(crate::vault::read(&root,"fixture").unwrap(),b"fixture-secret-value");
        let state:Value=serde_json::from_slice(&std::fs::read(root.join("state.json")).unwrap()).unwrap();assert_eq!(state["monitoring"],false);
        let db=rusqlite::Connection::open(root.join("commands.sqlite3")).unwrap();assert_eq!(db.query_row("SELECT value FROM fixture",[],|row|row.get::<_,String>(0)).unwrap(),"retained");drop(db);
        // Simulate interruption after moving the original directory away.
        let rollback2=stage(&root,&archive).unwrap();std::fs::rename(&root,&rollback2).unwrap();apply_pending(&root).unwrap();assert!(root.exists());assert!(rollback2.exists());
        let mut invalid=archive;invalid.files.remove("credentials.key");assert!(stage(&root,&invalid).is_err());assert!(root.join("state.json").exists());
        invalid.files.insert("../escape".into(),B64.encode(b"x"));assert!(stage(&root,&invalid).is_err());assert!(!parent.join("escape").exists());
        std::fs::remove_dir_all(parent).unwrap();
    }
}
fn marker(root:&Path)->PathBuf{root.with_extension("restore-pending.json")}
fn stage(root:&Path,archive:&Archive)->Result<PathBuf,String>{
    let staging=root.with_extension("restore-stage");if staging.exists() || marker(root).exists(){return Err("已有待恢复任务，请先重新加载插件".into());}
    private_dir(&staging)?;
    if let Err(e)=unpack(archive,&staging){let _=std::fs::remove_dir_all(&staging);return Err(e);}
    let rollback=root.with_extension(format!("before-restore-{}",stamp()));
    crate::storage::write_json_atomic(&marker(root),&json!({"rollback":rollback}))?;Ok(rollback)
}
pub fn apply_pending(root:&Path)->Result<(),String>{
    let marker=marker(root);if !marker.exists(){return Ok(());}
    let value:Value=serde_json::from_slice(&read_limited(&marker,8192)?).map_err(|_|"恢复标记损坏")?;
    let rollback=PathBuf::from(value["rollback"].as_str().ok_or("恢复路径缺失")?);
    if rollback.parent()!=root.parent() || !rollback.file_name().unwrap().to_string_lossy().starts_with(&format!("{}.before-restore-",root.file_stem().unwrap().to_string_lossy())){return Err("恢复回退路径无效".into());}
    let staging=root.with_extension("restore-stage");
    if staging.exists(){
        // Revalidate after restart before touching the current data directory.
        let verification=temp(root)?;unpack(&collect(&staging)?,&verification.0)?;
        if root.exists(){if rollback.exists(){return Err("恢复目录冲突，原数据已保留".into());}std::fs::rename(root,&rollback).map_err(|e|e.to_string())?;}
        if let Err(e)=std::fs::rename(&staging,root){if !root.exists(){let _=std::fs::rename(&rollback,root);}return Err(e.to_string());}
    }else if !root.exists(){std::fs::rename(&rollback,root).map_err(|e|e.to_string())?;}
    std::fs::remove_file(marker).map_err(|e|e.to_string())
}
pub struct Manager {root:PathBuf,preview:Mutex<Option<(String,Archive)>>}
impl Manager {
    pub fn new(root:PathBuf)->Self{Self{root,preview:Mutex::new(None)}}
    pub fn pending_restore(&self)->bool{marker(&self.root).exists()}
    pub async fn api(&self,p:&Value)->Result<Value,String>{
        if self.pending_restore(){return Err("恢复已准备好，请重新加载插件".into());}
        let password=p["password"].as_str().unwrap_or("");
        match p["action"].as_str().unwrap_or(""){
            "backup"|"export"=>{
                let directory=if p["action"]=="export"{match crate::choose_path(true).await?{Some(path)=>path,None=>return Ok(json!({"canceled":true}))}}else{self.root.with_extension("backups")};
                if p["action"]=="backup"{private_dir(&directory)?;}
                let archive=collect(&self.root)?;let scratch=temp(&self.root)?;unpack(&archive,&scratch.0)?;
                let path=directory.join(format!("machines-{}.fhbackup",stamp()));write_new(&path,&encrypt(&archive,password)?)?;Ok(json!({"path":path}))
            }
            "inspect"=>{
                *self.preview.lock().unwrap()=None;
                let Some(path)=crate::choose_path(false).await? else{return Ok(json!({"canceled":true}));};
                let archive=decrypt(&read_limited(&path,LIMIT*2)?,password)?;let scratch=temp(&self.root)?;let summary=unpack(&archive,&scratch.0)?;let token=stamp();
                *self.preview.lock().unwrap()=Some((token.clone(),archive));Ok(json!({"token":token,"summary":summary}))
            }
            "restore"=>{
                let mut preview=self.preview.lock().unwrap();let (token,archive)=preview.as_ref().ok_or("请先选择并校验备份")?;
                if p["token"].as_str()!=Some(token){return Err("恢复确认已过期，请重新选择备份".into());}
                let rollback=stage(&self.root,archive)?;*preview=None;Ok(json!({"restartRequired":true,"rollback":rollback}))
            }
            _=>Err("未知备份操作".into())
        }
    }
}
