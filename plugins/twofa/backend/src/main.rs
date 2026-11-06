use ring::{aead, rand::{SecureRandom, SystemRandom}};
use serde_json::{json, Value};
use std::{fs::{self, OpenOptions}, io::{self, BufRead, Write}, os::unix::fs::{OpenOptionsExt, PermissionsExt}, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};

mod otp;
mod screen_capture;
use otp::{Entry,generate,legacy_secret,parameters,parse_import,valid_name,valid_issuer};
fn root()->Result<PathBuf,String>{std::env::var_os("FLOWHUB_PLUGIN_DATA").map(PathBuf::from).ok_or("缺少 FLOWHUB_PLUGIN_DATA".into())}
fn secure(path:&Path)->Result<(),String>{let m=fs::symlink_metadata(path).map_err(|e|e.to_string())?;if !m.is_file()||m.permissions().mode()&0o077!=0{return Err(format!("文件权限不安全：{}",path.display()))}Ok(())}
fn key(root:&Path,create:bool)->Result<aead::LessSafeKey,String>{let p=root.join("twofa.key");if !p.exists()&&create{fs::create_dir_all(root).map_err(|e|e.to_string())?;let mut b=[0;32];SystemRandom::new().fill(&mut b).map_err(|_|"无法生成加密密钥")?;let mut f=OpenOptions::new().write(true).create_new(true).mode(0o600).open(&p).map_err(|e|e.to_string())?;f.write_all(&b).map_err(|e|e.to_string())?;f.sync_all().map_err(|e|e.to_string())?;}secure(&p)?;let b=fs::read(p).map_err(|e|e.to_string())?;Ok(aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM,&b).map_err(|_|"密钥损坏")?))}
fn load(root:&Path)->Result<Vec<Entry>,String>{let p=root.join("twofa.secrets");if !p.exists(){return Ok(vec![])}secure(&p)?;let mut b=fs::read(p).map_err(|e|e.to_string())?;if b.len()<12{return Err("2FA 密钥文件损坏".into())}let nonce:[u8;12]=b[..12].try_into().unwrap();let key=key(root,false)?;let plain=key.open_in_place(aead::Nonce::assume_unique_for_key(nonce),aead::Aad::from(b"flowhub-twofa-v1"),&mut b[12..]).map_err(|_|"2FA 密钥无法解密")?;serde_json::from_slice(plain).map_err(|_|"2FA 配置格式损坏".into())}
fn save(root:&Path,entries:&[Entry])->Result<(),String>{fs::create_dir_all(root).map_err(|e|e.to_string())?;let key=key(root,true)?;let mut nonce=[0;12];SystemRandom::new().fill(&mut nonce).map_err(|_|"无法生成随机数")?;let mut c=serde_json::to_vec(entries).map_err(|e|e.to_string())?;key.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce),aead::Aad::from(b"flowhub-twofa-v1"),&mut c).map_err(|_|"2FA 配置加密失败")?;let p=root.join("twofa.secrets");let tmp=root.join("twofa.secrets.tmp");let mut f=OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).map_err(|e|e.to_string())?;f.write_all(&nonce).and_then(|_|f.write_all(&c)).and_then(|_|f.sync_all()).map_err(|e|e.to_string())?;fs::rename(tmp,p).map_err(|e|e.to_string())}
fn now()->u64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()}
fn dispatch(method:&str,p:&Value)->Result<Value,String>{dispatch_in(&root()?,method,p)}
fn dispatch_in(root:&Path,method:&str,p:&Value)->Result<Value,String>{
    match method {
        "capture_screen"=>screen_capture::capture(p),
        "health"=>Ok(json!({"protocol":1,"name":"twofa","version":env!("CARGO_PKG_VERSION")})),
        "preview_import"=>Ok(parse_import(p["uri"].as_str().unwrap_or(""))?.metadata()),
        "search"=>{
            let query=p["query"].as_str().unwrap_or("").trim().to_lowercase();
            let limit=p["limit"].as_u64().unwrap_or(12).min(50) as usize;let offset=p["offset"].as_u64().unwrap_or(0) as usize;
            Ok(json!(load(root)?.into_iter().filter(|e|query.is_empty() || e.name.to_lowercase().contains(&query) || e.issuer.as_deref().unwrap_or("").to_lowercase().contains(&query)).skip(offset).take(limit).map(|e|json!({"id":e.name,"type":"twofa","title":e.name,"issuer":e.issuer,"description":"2FA 验证码"})).collect::<Vec<_>>()))
        },
        "activate"|"code"=>{
            let name=p["name"].as_str().unwrap_or("");let entry=load(root)?.into_iter().find(|e|e.name==name).ok_or("未找到该 2FA 名称")?;
            let (value,remaining)=generate(&entry,now())?;
            Ok(json!({"ok":true,"name":entry.name,"issuer":entry.issuer,"code":value,"remaining":remaining,"period":entry.period}))
        },
        "list"=>Ok(json!({"accounts":load(root)?.iter().map(Entry::metadata).collect::<Vec<_>>()})),
        "import"=>{
            let mut entry=parse_import(p["uri"].as_str().unwrap_or(""))?;
            if let Some(name)=p.get("name"){entry.name=name.as_str().ok_or("账户名称无效")?.trim().into();}
            if !valid_name(&entry.name){return Err("名称不能为空且不能超过 80 字节".into());}
            let mut all=load(root)?;
            if all.iter().any(|e|e.name==entry.name){return Err("该名称已存在，请修改名称；不会覆盖原账户".into());}
            all.push(entry);all.sort_by(|a,b|a.name.cmp(&b.name));save(root,&all)?;Ok(json!({"saved":true}))
        },
        "save"=>{
            let name=p["name"].as_str().unwrap_or("").trim();let previous=p["previous"].as_str().unwrap_or("").trim();
            if !valid_name(name){return Err("名称不能为空且不能超过 80 字节".into());}
            let mut all=load(root)?;let old=all.iter().find(|e|e.name==previous).cloned();
            if !previous.is_empty() && old.is_none(){return Err("账户已变化，请重新加载后编辑".into());}
            if all.iter().any(|e|e.name==name && e.name!=previous){return Err("该名称已存在，请使用其他名称".into());}
            let secret=p["secret"].as_str().unwrap_or("").trim();
            let secret=if secret.is_empty(){old.as_ref().map(|e|e.secret.as_str()).ok_or("新增配置必须填写 TOTP 密钥")?}else{if secret.len()>4096{return Err("密钥过长".into());}legacy_secret(secret)?;secret};
            let issuer=p["issuer"].as_str().map(str::trim).filter(|value|!value.is_empty());if !valid_issuer(issuer){return Err("发行方名称无效".into());}
            let entry=Entry::new(name.into(),issuer.map(str::to_owned),secret.into(),parameters(p,old.as_ref())?);
            all.retain(|e|e.name!=previous);all.push(entry);all.sort_by(|a,b|a.name.cmp(&b.name));save(root,&all)?;Ok(json!({"saved":true}))
        },
        "remove"=>{let name=p["name"].as_str().unwrap_or("");let mut all=load(root)?;let count=all.len();all.retain(|e|e.name!=name);if count==all.len(){return Err("未找到该 2FA 名称".into());}save(root,&all)?;Ok(json!({"removed":true}))},
        _=>Err("未知操作".into())
    }
}
fn main()->Result<(),Box<dyn std::error::Error>>{let stdin=io::stdin();for line in stdin.lock().lines(){let line=line?;let req:Value=serde_json::from_str(&line)?;let result=dispatch(req["method"].as_str().unwrap_or(""),&req["params"]);let out=match result{Ok(v)=>json!({"id":req["id"],"result":v}),Err(e)=>json!({"id":req["id"],"error":e})};println!("{out}");}Ok(())}

#[cfg(test)] mod tests;
