//! Persistent, per-group minute samples. SQLite work never holds the live cache.
use crate::cache::Snapshot;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex, RwLock,
    },
    time::Duration,
};

pub const INTERVAL: u64 = 60_000;
const MAX_POINTS: usize = 12_000;
const DATABASE: &str = "resource-history.sqlite3";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Point {
    pub at: u64,
    pub cpu: Option<f64>,
    pub footprint: Option<u64>,
    pub rss: Option<u64>,
    pub run: i64,
    pub segment: u64,
}
#[derive(Clone)]
struct Sample {
    key: String,
    cpu: Option<f64>,
    footprint: Option<u64>,
    rss: Option<u64>,
    segment: u64,
}
struct Batch {
    at: u64,
    rows: Vec<Sample>,
}
enum Command {
    Sample(Batch),
    Retention(u64, mpsc::SyncSender<Result<(), String>>),
}
#[derive(Clone)]
struct State {
    hours: u64,
    error: Option<String>,
}
#[derive(Clone)]
pub struct History {
    path: Option<PathBuf>,
    send: Option<mpsc::SyncSender<Command>>,
    state: Arc<RwLock<State>>,
    bucket: Arc<AtomicU64>,
    lifetimes: Arc<Mutex<Lifetimes>>,
}
#[derive(Default)]
struct Lifetimes {
    next: u64,
    groups: HashMap<String, (u64, HashSet<(i32, u64, u32)>)>,
}

fn key(id: &str) -> String {
    format!("{:x}", Sha256::digest(id.as_bytes()))
}
fn valid_key(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn group_id(params: &Value) -> Result<&str, String> {
    params["groupId"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 4096)
        .ok_or("应用标识无效".into())
}
fn retention_hours(db: &Connection) -> Result<u64, String> {
    let hours: i64 = db
        .query_row("SELECT value FROM settings WHERE key='hours'", [], |r| {
            r.get(0)
        })
        .map_err(|_| "资源历史保留设置无效")?;
    if !matches!(hours, 48 | 168) {
        return Err("资源历史保留设置无效".into());
    }
    Ok(hours as u64)
}
fn unsigned(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}
fn optional_unsigned(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Option<u64>> {
    let value: Option<i64> = row.get(index)?;
    value
        .map(|v| u64::try_from(v).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, v)))
        .transpose()
}
fn reader(path: &Path) -> Result<Connection, String> {
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "无法读取资源历史数据库")?;
    db.busy_timeout(Duration::from_millis(150))
        .map_err(|_| "无法设置资源历史读取时限")?;
    Ok(db)
}
fn initialize(root: &Path) -> Result<(Connection, PathBuf, u64, i64), String> {
    let directory = root.join("history");
    fs::create_dir_all(&directory).map_err(|_| "无法创建资源历史目录")?;
    let metadata = fs::symlink_metadata(&directory).map_err(|_| "无法核验资源历史目录")?;
    if !metadata.is_dir() {
        return Err("资源历史目录无效".into());
    }
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|_| "无法保护资源历史目录")?;
    let path = directory.join(DATABASE);
    use std::os::unix::fs::OpenOptionsExt;
    let file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(&path)
        .map_err(|_| "无法打开资源历史数据库")?;
    if fs::symlink_metadata(&path)
        .map_err(|_| "无法核验资源历史数据库")?
        .file_type()
        .is_symlink()
    {
        return Err("资源历史数据库不能是链接".into());
    }
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| "无法保护资源历史数据库")?;
    let db = Connection::open(&path).map_err(|_| "资源历史数据库无法读取")?;
    db.busy_timeout(Duration::from_secs(1))
        .map_err(|_| "无法设置资源历史写入时限")?;
    let version: i64 = db
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|_| "资源历史数据库格式无效")?;
    if !matches!(version, 0 | 1) {
        return Err("资源历史数据库版本不受支持".into());
    }
    db.execute_batch("PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=4194304;
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
        INSERT OR IGNORE INTO settings VALUES('hours',48);
        CREATE TABLE IF NOT EXISTS series(id INTEGER PRIMARY KEY,key TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY,started INTEGER NOT NULL,pid INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS samples(series INTEGER NOT NULL,at INTEGER NOT NULL,cpu REAL,footprint INTEGER,rss INTEGER,run INTEGER NOT NULL,segment INTEGER NOT NULL,PRIMARY KEY(series,at)) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS samples_at ON samples(at);
        PRAGMA user_version=1;").map_err(|_|"无法初始化资源历史数据库")?;
    let hours = retention_hours(&db)?;
    db.execute(
        "INSERT INTO runs(started,pid) VALUES(?1,?2)",
        params![crate::now() as i64, std::process::id()],
    )
    .map_err(|_| "无法开始资源历史记录")?;
    let run = db.last_insert_rowid();
    Ok((db, path, hours, run))
}
fn prune(db: &Connection, hours: u64, at: u64) -> rusqlite::Result<()> {
    db.execute(
        "DELETE FROM samples WHERE at < ?1",
        [at.saturating_sub(hours * 3_600_000) as i64],
    )?;
    Ok(())
}
fn write(db: &mut Connection, batch: Batch, run: i64, hours: u64) -> rusqlite::Result<()> {
    let tx = db.transaction()?;
    {
        let mut series = tx.prepare_cached("INSERT OR IGNORE INTO series(key) VALUES(?1)")?;
        let mut sample=tx.prepare_cached("INSERT OR IGNORE INTO samples(series,at,cpu,footprint,rss,run,segment) SELECT id,?2,?3,?4,?5,?6,?7 FROM series WHERE key=?1")?;
        for row in batch.rows {
            series.execute([&row.key])?;
            sample.execute(params![
                row.key,
                batch.at as i64,
                row.cpu,
                row.footprint.map(|v| v as i64),
                row.rss.map(|v| v as i64),
                run,
                row.segment as i64
            ])?;
        }
    }
    prune(&tx, hours, batch.at)?;
    tx.commit()
}
impl History {
    pub fn unavailable() -> Self {
        Self {
            path: None,
            send: None,
            state: Arc::new(RwLock::new(State {
                hours: 48,
                error: Some("资源历史目录不可用".into()),
            })),
            bucket: Arc::new(AtomicU64::new(u64::MAX)),
            lifetimes: Arc::new(Mutex::new(Lifetimes::default())),
        }
    }
    pub fn open(root: Option<PathBuf>) -> Self {
        let Some(root) = root else {
            return Self::unavailable();
        };
        let (mut db, path, hours, run) = match initialize(&root) {
            Ok(v) => v,
            Err(error) => {
                let history = Self::unavailable();
                history.state.write().unwrap().error = Some(error);
                return history;
            }
        };
        let state = Arc::new(RwLock::new(State { hours, error: None }));
        let worker_state = state.clone();
        let (send, receive) = mpsc::sync_channel(2);
        let spawned=std::thread::Builder::new().name("resource-history".into()).spawn(move||{
            let mut hours=hours;let mut maintenance=0u64;
            loop {
                let command=receive.recv_timeout(Duration::from_secs(60));
                let result=match command {
                    Ok(Command::Sample(batch))=>write(&mut db,batch,run,hours).map_err(|_|"无法保存资源历史".to_string()),
                    Ok(Command::Retention(next,reply))=>{
                        let result=(||->rusqlite::Result<()>{let tx=db.transaction()?;tx.execute("UPDATE settings SET value=?1 WHERE key='hours'",[next as i64])?;prune(&tx,next,crate::now())?;tx.commit()})().map_err(|_|"无法保存资源历史保留时间".to_string());
                        if result.is_ok(){hours=next;worker_state.write().unwrap().hours=next;}
                        let _=reply.send(result.clone());result
                    }
                    Err(mpsc::RecvTimeoutError::Timeout)=>prune(&db,hours,crate::now()).map_err(|_|"无法清理过期资源历史".to_string()),
                    Err(mpsc::RecvTimeoutError::Disconnected)=>break,
                };
                worker_state.write().unwrap().error=result.err();
                if crate::now().saturating_sub(maintenance)>=3_600_000 {
                    let _=db.execute("DELETE FROM series WHERE NOT EXISTS(SELECT 1 FROM samples WHERE samples.series=series.id)",[]);
                    let _=db.execute("DELETE FROM runs WHERE NOT EXISTS(SELECT 1 FROM samples WHERE samples.run=runs.id) AND id<>?1",[run]);
                    let _=db.execute_batch("PRAGMA incremental_vacuum(256);");maintenance=crate::now();
                }
            }
        });
        if spawned.is_err() {
            return Self::unavailable();
        }
        Self {
            path: Some(path),
            send: Some(send),
            state,
            bucket: Arc::new(AtomicU64::new(u64::MAX)),
            lifetimes: Arc::new(Mutex::new(Lifetimes::default())),
        }
    }
    pub fn observe(&self, snapshot: &Snapshot) {
        let Some(send) = &self.send else {
            return;
        };
        if snapshot.at == 0
            || snapshot.at > i64::MAX as u64
            || snapshot.error.is_some()
            || snapshot.stale()
        {
            self.lifetimes.lock().unwrap().groups.clear();
            return;
        }
        let mut life = self.lifetimes.lock().unwrap();
        let previous = std::mem::take(&mut life.groups);
        let mut rows = Vec::with_capacity(snapshot.groups.len());
        for g in snapshot.groups.iter() {
            let identities = g
                .processes
                .iter()
                .map(|p| (p.identity.pid, p.identity.started, p.identity.uid))
                .collect::<HashSet<_>>();
            let segment = previous
                .get(&g.id)
                .filter(|(_, ids)| !ids.is_disjoint(&identities))
                .map(|(segment, _)| *segment)
                .unwrap_or_else(|| {
                    life.next += 1;
                    life.next
                });
            life.groups.insert(g.id.clone(), (segment, identities));
            rows.push(Sample {
                key: key(&g.id),
                cpu: (!g.processes.iter().any(|p| p.cpu.is_none()))
                    .then_some(g.cpu)
                    .flatten()
                    .filter(|v| v.is_finite() && *v >= 0.),
                footprint: (!g.footprint_incomplete)
                    .then_some(g.footprint)
                    .flatten()
                    .filter(|v| *v <= 9_007_199_254_740_991),
                rss: (!g.incomplete)
                    .then_some(g.memory)
                    .flatten()
                    .filter(|v| *v <= 9_007_199_254_740_991),
                segment,
            });
        }
        drop(life);
        let bucket = snapshot.at / INTERVAL;
        let before = self.bucket.load(Ordering::Acquire);
        if before != u64::MAX && bucket <= before {
            return;
        }
        if self
            .bucket
            .compare_exchange(before, bucket, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        if send
            .try_send(Command::Sample(Batch {
                at: snapshot.at,
                rows,
            }))
            .is_err()
        {
            let _ =
                self.bucket
                    .compare_exchange(bucket, before, Ordering::AcqRel, Ordering::Acquire);
            self.state.write().unwrap().error = Some("资源历史写入繁忙，等待下次采样".into());
        }
    }
    pub fn retention(&self, params: &Value) -> Result<Value, String> {
        group_id(params)?;
        let hours = params["hours"]
            .as_u64()
            .filter(|v| matches!(v, 48 | 168))
            .ok_or("保留时间须为 48 小时或 7 天")?;
        let (send, receive) = mpsc::sync_channel(1);
        self.send
            .as_ref()
            .ok_or("资源历史记录不可用")?
            .try_send(Command::Retention(hours, send))
            .map_err(|_| "资源历史正在写入，请稍后重试")?;
        receive
            .recv_timeout(Duration::from_secs(4))
            .map_err(|_| "保留设置结果未确认，请重新读取后核对")??;
        self.report(params, crate::now())
    }
    pub fn report(&self, params: &Value, at: u64) -> Result<Value, String> {
        let id = group_id(params)?;
        let state = self.state.read().unwrap().clone();
        let Some(path) = &self.path else {
            return Err(state.error.unwrap_or("资源历史不可用".into()));
        };
        read_report(path, &key(id), id, state.hours, at, state.error)
    }
    pub fn status(&self) -> Result<Value, String> {
        let state = self.state.read().unwrap().clone();
        let path = self.path.as_ref().ok_or("资源历史不可用")?;
        status(path, state.error)
    }
}

#[cfg(test)]
mod tests;
fn read_report(
    path: &Path,
    key: &str,
    id: &str,
    hours: u64,
    at: u64,
    error: Option<String>,
) -> Result<Value, String> {
    let db = reader(path)?;
    let from = at.saturating_sub(hours * 3_600_000);
    let mut query=db.prepare("SELECT at,cpu,footprint,rss,run,segment FROM samples WHERE series=(SELECT id FROM series WHERE key=?1) AND at>=?2 AND at<=?3 ORDER BY at DESC LIMIT ?4").map_err(|_|"无法查询资源历史")?;
    let mut points = query
        .query_map(
            params![key, from as i64, at as i64, (MAX_POINTS + 1) as i64],
            |r| {
                Ok(Point {
                    at: unsigned(r, 0)?,
                    cpu: r.get(1)?,
                    footprint: optional_unsigned(r, 2)?,
                    rss: optional_unsigned(r, 3)?,
                    run: r.get(4)?,
                    segment: unsigned(r, 5)?,
                })
            },
        )
        .map_err(|_| "无法查询资源历史")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "资源历史格式无效")?;
    let truncated = points.len() > MAX_POINTS;
    points.truncate(MAX_POINTS);
    points.reverse();
    Ok(
        json!({"groupId":id,"hours":hours,"intervalSeconds":60,"from":from,"to":at,"points":points,"truncated":truncated,"error":error}),
    )
}
fn status(path: &Path, error: Option<String>) -> Result<Value, String> {
    let db = reader(path)?;
    let hours = retention_hours(&db)?;
    let (groups, points, first, last): (i64, i64, Option<i64>, Option<i64>) = db
        .query_row(
            "SELECT count(DISTINCT series),count(*),min(at),max(at) FROM samples",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|_| "无法统计资源历史")?;
    let pid: Option<u32> = db
        .query_row("SELECT pid FROM runs ORDER BY id DESC LIMIT 1", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|_| "无法读取记录进程")?;
    Ok(
        json!({"hours":hours,"intervalSeconds":60,"groups":groups,"points":points,"firstSampleAt":first,"lastSampleAt":last,"writerPid":pid,"databaseBytes":fs::metadata(path).map(|m|m.len()).unwrap_or(0),"error":error}),
    )
}

/// Read-only CLI: it does not start collection, initialize AppKit, or alter retention.
pub fn cli(args: &[String]) -> Result<Value, String> {
    let mut values = args.to_vec();
    let root = if let Some(index) = values.iter().position(|v| v == "--data") {
        if index + 1 >= values.len() {
            return Err("--data 需要目录".into());
        }
        let path = PathBuf::from(values.remove(index + 1));
        values.remove(index);
        path
    } else if let Some(root) = std::env::var_os("FLOWHUB_PLUGIN_DATA") {
        PathBuf::from(root)
    } else {
        PathBuf::from(std::env::var_os("HOME").ok_or("缺少数据目录")?)
            .join("Library/Application Support/FlowHub/resource-monitor")
    };
    let path = root.join("history").join(DATABASE);
    match values
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["history", "status"] => status(&path, None),
        ["history", "list"] => {
            let db = reader(&path)?;
            let mut q=db.prepare("SELECT series.key,count(*),min(at),max(at) FROM samples JOIN series ON series.id=samples.series GROUP BY samples.series ORDER BY max(at) DESC LIMIT 4096").map_err(|_|"无法列出资源历史")?;
            let rows=q.query_map([],|r|Ok(json!({"key":r.get::<_,String>(0)?,"points":unsigned(r,1)?,"firstSampleAt":unsigned(r,2)?,"lastSampleAt":unsigned(r,3)?}))).map_err(|_|"无法列出资源历史")?.collect::<Result<Vec<_>,_>>().map_err(|_|"无法列出资源历史")?;
            Ok(json!({"groups":rows}))
        }
        ["history", "show", hash] if valid_key(hash) => {
            let db = reader(&path)?;
            let hours = retention_hours(&db)?;
            read_report(&path, hash, hash, hours, crate::now(), None)
        }
        _ => Err("用法：--cli history status|list|show <匿名 key> [--data <目录>]".into()),
    }
}
