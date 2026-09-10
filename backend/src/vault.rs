//! AES-256-GCM authenticated ciphertext in SQLite, with a local random key.
use ring::{aead,rand::{SecureRandom,SystemRandom}};
use rusqlite::{Connection,params};
use std::{path::Path,io::Write,os::unix::fs::{OpenOptionsExt,PermissionsExt}};
fn key(root:&Path,create:bool)->Result<aead::LessSafeKey,String>{
    let path=root.join("credentials.key");
    if !path.exists() && create && !root.join("credentials.sqlite3").exists(){
        let mut bytes=[0u8;32];SystemRandom::new().fill(&mut bytes).map_err(|_|"无法生成加密密钥")?;
        let mut file=std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path).map_err(|e|e.to_string())?;
        file.write_all(&bytes).and_then(|_|file.sync_all()).map_err(|e|e.to_string())?;
    }
    let meta=std::fs::symlink_metadata(&path).map_err(|_|"密码密钥缺失，请恢复 credentials.key 备份")?;
    if !meta.is_file() || meta.permissions().mode()&0o077!=0{return Err("密码密钥必须是权限 600 的普通文件".into());}
    let bytes=std::fs::read(path).map_err(|e|e.to_string())?;
    Ok(aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM,&bytes).map_err(|_|"密码密钥损坏")?))
}
fn database(root:&Path,create:bool)->Result<Connection,String>{
    let path=root.join("credentials.sqlite3");
    if create && !path.exists(){
        std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path).map_err(|e|e.to_string())?;
    }
    let meta=std::fs::symlink_metadata(&path).map_err(|_|"尚未保存密码")?;
    if !meta.is_file() || meta.permissions().mode()&0o077!=0{return Err("密码数据库必须是权限 600 的普通文件".into());}
    let flags=if create{rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE}else{rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY};
    let db=Connection::open_with_flags(path,flags).map_err(|e|e.to_string())?;
    if create{db.execute_batch("CREATE TABLE IF NOT EXISTS credentials(account TEXT PRIMARY KEY, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, version INTEGER NOT NULL)").map_err(|e|e.to_string())?;}
    Ok(db)
}
pub fn save(root:&Path,account:&str,password:&[u8])->Result<(),String>{
    let key=key(root,true)?;let mut nonce=[0u8;12];SystemRandom::new().fill(&mut nonce).map_err(|_|"无法生成加密随机数")?;
    let mut ciphertext=password.to_vec();
    key.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce),aead::Aad::from(account.as_bytes()),&mut ciphertext).map_err(|_|"密码加密失败")?;
    database(root,true)?.execute("INSERT OR REPLACE INTO credentials VALUES (?1,?2,?3,1)",params![account,nonce.as_slice(),ciphertext]).map_err(|e|e.to_string())?;
    Ok(())
}
pub fn read(root:&Path,account:&str)->Result<Vec<u8>,String>{
    let key=key(root,false)?;
    let (nonce,mut ciphertext,version):(Vec<u8>,Vec<u8>,i64)=database(root,false)?.query_row("SELECT nonce,ciphertext,version FROM credentials WHERE account=?1",[account],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(|_|"该机器尚未保存密码")?;
    if version!=1{return Err("不支持的密码加密版本".into());}
    let nonce:[u8;12]=nonce.try_into().map_err(|_|"密码数据损坏")?;
    Ok(key.open_in_place(aead::Nonce::assume_unique_for_key(nonce),aead::Aad::from(account.as_bytes()),&mut ciphertext).map_err(|_|"密码解密失败：密钥不匹配或数据被修改")?.to_vec())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_persistence_and_tamper_detection(){
        let root=std::env::temp_dir().join(format!("vault-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));std::fs::create_dir_all(&root).unwrap();
        let secret=b"fixture-only-password-8391";save(&root,"host-a",secret).unwrap();assert_eq!(read(&root,"host-a").unwrap(),secret);
        let bytes=std::fs::read(root.join("credentials.sqlite3")).unwrap();assert!(!bytes.windows(secret.len()).any(|b|b==secret));
        assert!(read(&root,"host-b").is_err());
        database(&root,true).unwrap().execute("UPDATE credentials SET account='host-b'",[]).unwrap();assert!(read(&root,"host-b").is_err());
        save(&root,"host-a",secret).unwrap();std::fs::remove_file(root.join("credentials.key")).unwrap();
        assert!(read(&root,"host-a").is_err());assert!(save(&root,"host-a",secret).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
