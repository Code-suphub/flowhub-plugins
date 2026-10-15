use super::Job;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{path::Path, sync::Mutex};

const COMMAND_DAYS: i64 = 90;
const COMMAND_COUNT: i64 = 5000;
const COMMAND_BYTES: i64 = 32 * 1024 * 1024;

// Best-effort masking of labeled credentials; unlabeled output is still private data.
fn redact(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::new(); let mut copied = 0; let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_alphabetic() && bytes[i] != b'-' && bytes[i] != b'_' { i += 1; continue; }
        let start = i;
        while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || b"-_".contains(&bytes[i])) { i += 1; }
        let key = text[start..i].trim_start_matches('-').replace('-', "_").to_ascii_lowercase();
        if !["password","passwd","token","access_token","api_key","apikey","secret","client_secret","authorization"].contains(&key.as_str()) { continue; }
        let mut value = i;
        if value < bytes.len() && b"\"'".contains(&bytes[value]) { value += 1; }
        while value < bytes.len() && b" \t".contains(&bytes[value]) { value += 1; }
        if value < bytes.len() && b"=:".contains(&bytes[value]) { value += 1; }
        else if bytes[start] != b'-' { continue; }
        while value < bytes.len() && b" \t".contains(&bytes[value]) { value += 1; }
        if value >= bytes.len() || b"\r\n".contains(&bytes[value]) { continue; }
        let mut end = value;
        if key == "authorization" {
            while end < bytes.len() && !b"\r\n".contains(&bytes[end]) { end += 1; }
        } else if b"\"'".contains(&bytes[value]) {
            let quote = bytes[value]; end += 1;
            while end < bytes.len() {
                if bytes[end] == b'\\' { end = (end + 2).min(bytes.len()); continue; }
                if bytes[end] == quote { end += 1; break; }
                end += 1;
            }
        } else {
            while end < bytes.len() && !b" \t\r\n&;,}".contains(&bytes[end]) { end += 1; }
        }
        if end == value { continue; }
        out.push_str(&text[copied..value]);
        if b"\"'".contains(&bytes[value]) && key != "authorization" { out.push(bytes[value] as char); out.push_str("[已隐藏]"); out.push(bytes[value] as char); }
        else { out.push_str("[已隐藏]"); }
        copied = end; i = end;
    }
    out.push_str(&text[copied..]); out
}
fn protected_job(job: &Job) -> Job {
    let mut saved = job.clone();
    saved.command = job.command.as_deref().map(redact);
    saved.stdout = redact(&job.stdout); saved.stderr = redact(&job.stderr); saved
}

pub(super) struct Store(Mutex<Connection>);
impl Store {
    pub(super) fn sample(&self,id:&str,host:&str,at:i64,status:&str,source:&str,value:&Value)->Result<(),String>{self.0.lock().unwrap().execute("INSERT OR REPLACE INTO metric_samples VALUES(?1,?2,?3,?4,?5,?6)",params![id,host,at,status,source,value.to_string()]).map_err(|e|e.to_string())?;Ok(())}
    pub(super) fn prune_metrics(&self, days: u64) -> Result<(), String> {
        let cutoff = chrono::Utc::now().timestamp_millis() - days.clamp(1,365) as i64 * 86400000;
        let command_cutoff = chrono::Utc::now().timestamp_millis() - COMMAND_DAYS * 86400000;
        let mut db = self.0.lock().unwrap();
        let tx = db.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM metric_samples WHERE at < ?1", [cutoff]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM metric_samples WHERE id IN (SELECT id FROM metric_samples ORDER BY at DESC LIMIT -1 OFFSET 200000)", []).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM jobs WHERE started < ?1 AND status NOT IN ('running','queued')", [command_cutoff]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE status NOT IN ('running','queued') ORDER BY started DESC,id DESC LIMIT -1 OFFSET ?1)", [COMMAND_COUNT]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM jobs WHERE id IN (SELECT id FROM (SELECT id,sum(length(CAST(data AS BLOB))) OVER (ORDER BY started DESC,id DESC) AS bytes FROM jobs WHERE status NOT IN ('running','queued')) WHERE bytes > ?1)", [COMMAND_BYTES]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        let free: i64 = db.query_row("PRAGMA freelist_count", [], |r| r.get(0)).map_err(|e|e.to_string())?;
        let pages: i64 = db.query_row("PRAGMA page_count", [], |r| r.get(0)).map_err(|e|e.to_string())?;
        if free > 4096 && free * 4 > pages { db.execute_batch("VACUUM").map_err(|e|e.to_string())?; }
        Ok(())
    }
    pub(super) fn metric_page(&self,host:&str,metric:&str,seconds:u64,interval:u64)->Result<Value,String>{
        if !["cpu","memory","disk","load","uptime","rx","tx"].contains(&metric)||![3600,86400,604800,2592000,7776000].contains(&seconds){return Err("指标或时间范围无效".into());}
        let end=chrono::Utc::now().timestamp_millis();let start=end-seconds as i64*1000;let width=((seconds/180).max(interval).max(30)*1000) as i64;let bins=((end-start)/width+1) as usize;let mut data:Vec<Value>=(0..bins).map(|i|json!([(start+i as i64*width)/1000,Value::Null])).collect();let db=self.0.lock().unwrap();
        let mut stmt=db.prepare("SELECT (at-?1)/?2,avg(CASE WHEN status='success' THEN json_extract(data,?3) END) FROM metric_samples WHERE host=?4 AND at>=?1 AND at<=?5 GROUP BY (at-?1)/?2 ORDER BY 1").map_err(|e|e.to_string())?;let rows=stmt.query_map(params![start,width,format!("$.{metric}"),host,end],|r|Ok((r.get::<_,i64>(0)? as usize,r.get::<_,Option<f64>>(1)?))).map_err(|e|e.to_string())?;for row in rows{let(i,v)=row.map_err(|e|e.to_string())?;if i<data.len(){data[i][1]=json!(v);}}Ok(json!({"labels":["time",metric],"data":data,"unit":match metric{"cpu"|"memory"|"disk"=>"%","rx"|"tx"=>"KB/s","uptime"=>"秒",_=>""}}))
    }
    pub(super) fn open(path: &Path) -> Result<Self, String> {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        match std::fs::symlink_metadata(path) {
            Ok(meta) if !meta.is_file() => return Err("执行记录须为普通文件".into()),
            Ok(_) => std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|e|e.to_string())?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => { std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path).map_err(|e|e.to_string())?; },
            Err(e) => return Err(e.to_string()),
        }
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS history_policy(version INTEGER PRIMARY KEY);").map_err(|e|e.to_string())?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS metric_samples(id TEXT PRIMARY KEY,host TEXT NOT NULL,at INTEGER NOT NULL,status TEXT NOT NULL,source TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS metric_time ON metric_samples(at); CREATE INDEX IF NOT EXISTS metric_host_time ON metric_samples(host,at);").map_err(|e|e.to_string())?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, host TEXT NOT NULL, alias TEXT NOT NULL, status TEXT NOT NULL, started INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS jobs_time ON jobs(started DESC,id DESC); CREATE INDEX IF NOT EXISTS jobs_host ON jobs(host,status,started DESC);").map_err(|e| e.to_string())?;
        let migrated: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM history_policy WHERE version=1)", [], |r| r.get(0)).map_err(|e|e.to_string())?;
        if !migrated {
            let rows = { let mut stmt = db.prepare("SELECT data FROM jobs").map_err(|e|e.to_string())?;
                let rows = stmt.query_map([], |r| r.get::<_,String>(0)).map_err(|e|e.to_string())?;
                rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())? };
            for row in rows {
                let job: Job = serde_json::from_str(&row).map_err(|e|e.to_string())?;
                let data = serde_json::to_string(&protected_job(&job)).map_err(|e|e.to_string())?;
                if data != row { db.execute("UPDATE jobs SET data=?1 WHERE id=?2", params![data,job.id]).map_err(|e|e.to_string())?; }
            }
            db.execute("INSERT INTO history_policy VALUES(1)", []).map_err(|e|e.to_string())?;
        }
        let unfinished = {
            let mut stmt = db.prepare("SELECT data FROM jobs WHERE status IN ('queued','running')").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        let store = Self(Mutex::new(db));
        for data in unfinished {
            let mut job: Job = serde_json::from_str(&data).map_err(|e| e.to_string())?;
            job.status = "interrupted".into();
            job.finished_at = Some(chrono::Utc::now().timestamp_millis());
            job.stderr.push_str("应用退出，无法确认远端执行结果。");
            store.save(&job)?;
        }
        Ok(store)
    }
    pub(super) fn save(&self, job: &Job) -> Result<(), String> {
        if job.kind != "command" { return Ok(()); }
        self.0.lock().unwrap().execute("INSERT INTO jobs VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data", params![job.id,job.host_id,job.alias,job.status,job.started_at,serde_json::to_string(&protected_job(job)).map_err(|e| e.to_string())?]).map_err(|e| format!("执行记录保存失败：{e}"))?;
        Ok(())
    }
    pub(super) fn job(&self, id: &str) -> Result<Option<Value>, String> {
        let data: Option<String> = self.0.lock().unwrap().query_row("SELECT data FROM jobs WHERE id=?1", [id], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
        data.map(|s| serde_json::from_str(&s).map_err(|e| e.to_string())).transpose()
    }
    pub(super) fn page(&self, payload: &Value) -> Result<Value, String> {
        let db = self.0.lock().unwrap();
        let host = payload["hostId"].as_str().unwrap_or("");
        let status = payload["status"].as_str().unwrap_or("");
        let size = payload["pageSize"].as_u64().unwrap_or(20).clamp(1,100);
        let total = db.query_row("SELECT COUNT(*) FROM jobs WHERE (?1='' OR host=?1) AND (?2='' OR status=?2)", params![host,status], |r| r.get::<_,i64>(0)).map_err(|e| e.to_string())? as u64;
        let pages = total.div_ceil(size).max(1);
        let page = payload["page"].as_u64().unwrap_or(1).clamp(1,pages);
        let mut stmt = db.prepare("SELECT data FROM jobs WHERE (?1='' OR host=?1) AND (?2='' OR status=?2) ORDER BY started DESC,id DESC LIMIT ?3 OFFSET ?4").map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![host,status,size as i64,((page-1)*size) as i64], |r| r.get::<_,String>(0)).map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for row in rows { let job: Job = serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?; items.push(job.summary()); }
        let mut stmt = db.prepare("SELECT DISTINCT host,alias FROM jobs ORDER BY alias").map_err(|e| e.to_string())?;
        let instances = stmt.query_map([], |r| Ok(json!({"hostId":r.get::<_,String>(0)?,"alias":r.get::<_,String>(1)?}))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
        Ok(json!({"items":items,"instances":instances,"total":total,"page":page,"pages":pages,"pageSize":size}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_count_and_byte_limits_preserve_recent_and_active_records() {
        let root=std::env::temp_dir().join(format!("fh-history-limits-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));std::fs::create_dir_all(&root).unwrap();let store=Store::open(&root.join("history.db")).unwrap();
        let now=chrono::Utc::now().timestamp_millis();
        { let db=store.0.lock().unwrap();
          db.execute("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5002) INSERT INTO jobs SELECT 'job-'||x,'host','alias','success',?1+x,'{}' FROM n",[now]).unwrap();
          db.execute("INSERT INTO jobs VALUES('active','host','alias','running',?1,'{}')",[now-100*86400000]).unwrap(); }
        store.prune_metrics(1).unwrap();
        { let db=store.0.lock().unwrap();let count:i64=db.query_row("SELECT count(*) FROM jobs",[],|r|r.get(0)).unwrap();assert_eq!(count,5001);
          assert_eq!(db.query_row("SELECT count(*) FROM jobs WHERE id='job-1'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
          db.execute("UPDATE jobs SET data=?1 WHERE id='job-5001'",["x".repeat(COMMAND_BYTES as usize)]).unwrap(); }
        store.prune_metrics(1).unwrap();
        let db=store.0.lock().unwrap();let ids:Vec<String>=db.prepare("SELECT id FROM jobs ORDER BY id").unwrap().query_map([],|r|r.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
        assert_eq!(ids,vec!["active","job-5002"]);drop(db);drop(store);std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn existing_plaintext_records_are_masked_on_upgrade() {
        let root=std::env::temp_dir().join(format!("fh-history-upgrade-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));std::fs::create_dir_all(&root).unwrap();let path=root.join("history.db");let store=Store::open(&path).unwrap();
        let job=Job {id:"legacy".into(),host_id:"host".into(),alias:"alias".into(),kind:"command".into(),command:Some("TOKEN=fixture-legacy".into()),started_at:0,finished_at:Some(1),status:"success".into(),exit_code:Some(0),stdout:String::new(),stderr:String::new(),truncated:false};
        {let db=store.0.lock().unwrap();db.execute("DELETE FROM history_policy",[]).unwrap();db.execute("INSERT INTO jobs VALUES(?1,?2,?3,?4,?5,?6)",params![job.id,job.host_id,job.alias,job.status,job.started_at,serde_json::to_string(&job).unwrap()]).unwrap();}drop(store);
        let store=Store::open(&path).unwrap();assert!(!store.job("legacy").unwrap().unwrap().to_string().contains("fixture-legacy"));
        assert!(!std::fs::read(&path).unwrap().windows(b"fixture-legacy".len()).any(|b|b==b"fixture-legacy"));drop(store);std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn private_records_mask_labeled_secrets_and_prune_only_completed_jobs() {
        use std::os::unix::fs::PermissionsExt;
        let root=std::env::temp_dir().join(format!("fh-history-private-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        std::fs::create_dir_all(&root).unwrap();let path=root.join("history.db");
        std::fs::write(&path, []).unwrap();std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o644)).unwrap();
        let store=Store::open(&path).unwrap();assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,0o600);
        let now=chrono::Utc::now().timestamp_millis();
        let mut job=Job {id:"old".into(),host_id:"host".into(),alias:"alias".into(),kind:"command".into(),command:Some("curl --password 'fixture secret' --token=fixture-token".into()),started_at:now-91*86400000,finished_at:Some(now),status:"success".into(),exit_code:Some(0),stdout:"{\"api_key\":\"fixture-key\"}\nAuthorization: Bearer fixture-bearer\n普通结果".into(),stderr:String::new(),truncated:false};
        store.save(&job).unwrap();let saved=store.job("old").unwrap().unwrap().to_string();
        for secret in ["fixture secret","fixture-token","fixture-key","fixture-bearer"] {assert!(!saved.contains(secret));}
        assert!(saved.contains("普通结果"));
        job.id="active".into();job.status="running".into();store.save(&job).unwrap();
        job.id="new".into();job.status="success".into();job.started_at=now;store.save(&job).unwrap();
        store.prune_metrics(1).unwrap();assert!(store.job("old").unwrap().is_none());assert!(store.job("active").unwrap().is_some());assert!(store.job("new").unwrap().is_some());
        assert_eq!(redact("echo password; normal value"),"echo password; normal value");
        assert!(!redact("PASSWORD=秘密 token='a\\'b' --api-key x").contains("秘密"));
        drop(store);std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn metrics_survive_restart_and_expire_with_gaps() {
        let root=std::env::temp_dir().join(format!("metric-history-{}",std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();let path=root.join("history.db");
        let store=Store::open(&path).unwrap();let now=chrono::Utc::now().timestamp_millis();
        store.sample("old","host",now-3*86400000,"success","ssh",&json!({"cpu":50})).unwrap();
        store.sample("new","host",now-1000,"success","node_exporter",&json!({"cpu":25})).unwrap();drop(store);
        let store=Store::open(&path).unwrap();store.prune_metrics(1).unwrap();
        let count:i64=store.0.lock().unwrap().query_row("SELECT count(*) FROM metric_samples",[],|r|r.get(0)).unwrap();assert_eq!(count,1);
        let page=store.metric_page("host","cpu",3600,60).unwrap();let rows=page["data"].as_array().unwrap();assert!(rows.iter().any(|r|r[1]==25.0));assert!(rows.iter().any(|r|r[1].is_null()));
        assert!(store.metric_page("host","invalid",3600,60).is_err());
        drop(store);std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn persistent_pages_filters_details_and_restart_recovery() {
        let root = std::env::temp_dir().join(format!("flowhub-history-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("history.sqlite3");
        let store = Store::open(&path).unwrap();
        for i in 0..125 {
            store.save(&Job { id: format!("job-{i:03}"), host_id: format!("host-{}",i%2), alias: "example".into(), kind: "command".into(), command: Some("echo test".into()), started_at: i, finished_at: Some(i+1), status: "success".into(), exit_code: Some(0), stdout: format!("output-{i}"), stderr: String::new(), truncated: false }).unwrap();
        }
        let first = store.page(&json!({"page":1,"pageSize":20})).unwrap();
        assert_eq!(first["total"],125); assert_eq!(first["pages"],7); assert_eq!(first["items"][0]["id"],"job-124");
        let last = store.page(&json!({"page":99,"pageSize":20})).unwrap();
        assert_eq!(last["page"],7); assert_eq!(last["items"].as_array().unwrap().len(),5);
        assert_eq!(store.page(&json!({"hostId":"host-1","status":"success"})).unwrap()["total"],62);
        assert_eq!(store.page(&json!({"status":"failed"})).unwrap()["total"],0);
        let mut job: Job = serde_json::from_value(store.job("job-124").unwrap().unwrap()).unwrap();
        job.status = "running".into(); job.finished_at = None; store.save(&job).unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(store.job("job-000").unwrap().unwrap()["stdout"],"output-0");
        assert_eq!(store.job("job-124").unwrap().unwrap()["status"],"interrupted");
        assert_eq!(store.page(&json!({})).unwrap()["total"],125);
        drop(store); std::fs::remove_dir_all(root).unwrap();
    }
}
