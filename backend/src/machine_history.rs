use super::Job;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{path::Path, sync::Mutex};

pub(super) struct Store(Mutex<Connection>);
impl Store {
    pub(super) fn sample(&self,id:&str,host:&str,at:i64,status:&str,source:&str,value:&Value)->Result<(),String>{self.0.lock().unwrap().execute("INSERT OR REPLACE INTO metric_samples VALUES(?1,?2,?3,?4,?5,?6)",params![id,host,at,status,source,value.to_string()]).map_err(|e|e.to_string())?;Ok(())}
    pub(super) fn prune_metrics(&self,days:u64)->Result<(),String>{let cutoff=chrono::Utc::now().timestamp_millis()-(days as i64)*86400000;let mut db=self.0.lock().unwrap();let tx=db.transaction().map_err(|e|e.to_string())?;tx.execute("DELETE FROM metric_samples WHERE at < ?1",[cutoff]).map_err(|e|e.to_string())?;tx.execute("DELETE FROM metric_samples WHERE id IN (SELECT id FROM metric_samples ORDER BY at DESC LIMIT -1 OFFSET 200000)",[]).map_err(|e|e.to_string())?;tx.execute("DELETE FROM jobs WHERE started < ?1 AND status NOT IN ('running','queued') AND json_extract(data,'$.kind')='collect'",[cutoff]).map_err(|e|e.to_string())?;tx.commit().map_err(|e|e.to_string())}
    pub(super) fn metric_page(&self,host:&str,metric:&str,seconds:u64,interval:u64)->Result<Value,String>{
        if !["cpu","memory","disk","load","uptime","rx","tx"].contains(&metric)||![3600,86400,604800,2592000,7776000].contains(&seconds){return Err("指标或时间范围无效".into());}
        let end=chrono::Utc::now().timestamp_millis();let start=end-seconds as i64*1000;let width=((seconds/180).max(interval).max(30)*1000) as i64;let bins=((end-start)/width+1) as usize;let mut data:Vec<Value>=(0..bins).map(|i|json!([(start+i as i64*width)/1000,Value::Null])).collect();let db=self.0.lock().unwrap();
        let mut stmt=db.prepare("SELECT (at-?1)/?2,avg(CASE WHEN status='success' THEN json_extract(data,?3) END) FROM metric_samples WHERE host=?4 AND at>=?1 AND at<=?5 GROUP BY (at-?1)/?2 ORDER BY 1").map_err(|e|e.to_string())?;let rows=stmt.query_map(params![start,width,format!("$.{metric}"),host,end],|r|Ok((r.get::<_,i64>(0)? as usize,r.get::<_,Option<f64>>(1)?))).map_err(|e|e.to_string())?;for row in rows{let(i,v)=row.map_err(|e|e.to_string())?;if i<data.len(){data[i][1]=json!(v);}}Ok(json!({"labels":["time",metric],"data":data,"unit":match metric{"cpu"|"memory"|"disk"=>"%","rx"|"tx"=>"KB/s","uptime"=>"秒",_=>""}}))
    }
    pub(super) fn open(path: &Path) -> Result<Self, String> {
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS metric_samples(id TEXT PRIMARY KEY,host TEXT NOT NULL,at INTEGER NOT NULL,status TEXT NOT NULL,source TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS metric_time ON metric_samples(at); CREATE INDEX IF NOT EXISTS metric_host_time ON metric_samples(host,at);").map_err(|e|e.to_string())?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, host TEXT NOT NULL, alias TEXT NOT NULL, status TEXT NOT NULL, started INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS jobs_time ON jobs(started DESC,id DESC); CREATE INDEX IF NOT EXISTS jobs_host ON jobs(host,status,started DESC);").map_err(|e| e.to_string())?;
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
        self.0.lock().unwrap().execute("INSERT INTO jobs VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data", params![job.id,job.host_id,job.alias,job.status,job.started_at,serde_json::to_string(job).map_err(|e| e.to_string())?]).map_err(|e| format!("执行记录保存失败：{e}"))?;
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
