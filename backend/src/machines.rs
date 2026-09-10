//! Declarative plugin host. Downloaded packages never execute local code.
#[path = "machine_history.rs"]
mod machine_history;
use crate::{storage::write_json_atomic, update_cache};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use crate::Context;

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::Semaphore,
};

const BUILTIN: &str = include_str!("../../legacy-package.json");
const OUTPUT_LIMIT: usize = 32768;
const COLLECT: &str = r#"set -eu
export LC_ALL=C
test "$(uname -s)" = Linux || { echo '基础监控目前仅支持 Linux' >&2; exit 2; }
cpu() { awk '/^cpu / {idle=$5+$6; total=0; for(i=2;i<=9;i++) total+=$i; print total, idle; exit}' /proc/stat; }
set -- $(cpu); t1=$1; i1=$2; sleep 1; set -- $(cpu)
cpu_pct=$(awk -v t="$(( $1-t1 ))" -v i="$(( $2-i1 ))" 'BEGIN {if(t>0) printf "%.1f",100*(t-i)/t; else print 0}')
mem=$(awk '/MemTotal:/ {t=$2} /MemAvailable:/ {a=$2} END {if(t>0) printf "%.1f",100*(t-a)/t; else print 0}' /proc/meminfo)
disk=$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
load=$(awk '{print $1}' /proc/loadavg)
up=$(awk '{printf "%.0f",$1}' /proc/uptime)
printf '{"cpu":%s,"memory":%s,"disk":%s,"load":%s,"uptime":%s}\n' "$cpu_pct" "$mem" "$disk" "$load" "$up"
"#;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Template {
    name: String,
    command: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Package {
    schema: u32,
    id: String,
    name: String,
    version: String,
    host_version: String,
    capabilities: Vec<String>,
    templates: Vec<Template>,
}
impl Package {
    fn validate(&self) -> Result<(), String> {
        if self.schema != 1 || self.id != "machines" || self.name.len() > 80 {
            return Err("不支持的插件协议或 ID".into());
        }
        semver::Version::parse(&self.version).map_err(|e| e.to_string())?;
        let requirement =
            semver::VersionReq::parse(&self.host_version).map_err(|e| e.to_string())?;
        if !requirement.matches(&semver::Version::parse("0.1.9").unwrap()) {
            return Err("插件与当前 FlowHub 版本不兼容".into());
        }
        let allowed = [
            "ssh:collect",
            "ssh:execute",
            "ssh:terminal",
            "ssh:configure",
        ];
        if self
            .capabilities
            .iter()
            .any(|c| !allowed.contains(&c.as_str()))
            || self.capabilities.len() > 4
        {
            return Err("插件请求了不支持的权限".into());
        }
        if self.templates.len() > 50
            || self.templates.iter().any(|t| {
                t.name.is_empty() || t.name.len() > 100 || validate_command(&t.command).is_err()
            })
        {
            return Err("命令模板无效".into());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Host {
    id: String,
    alias: String,
    name: String,
    group: String,
    #[serde(default)]
    bastion: Option<crate::bastion::Profile>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    url: String,
    key: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Config {
    installed: Option<Package>,
    previous: Option<Package>,
    origin: Option<Origin>,
    previous_origin: Option<Origin>,
    enabled: bool,
    source: Option<Source>,
    sources: Vec<Source>,
    folders: Vec<String>,
    hosts: Vec<Host>,
    templates: Option<Vec<Template>>,
    monitoring: bool,
    interval: u64,
    reuse_connections: bool,
    connection_idle_seconds: u64,
}
impl Config {
    fn save_templates(&mut self, templates: Vec<Template>) -> Result<(), String> {
        authorize(self, "ssh:execute")?;
        if templates.len() > 50 || templates.iter().any(|t| t.name.trim().is_empty() || t.name.len() > 100 || t.command.trim().is_empty() || t.command.len() > 8192) {
            return Err("最多 50 个模板，名称为 1–100 字节，命令为 1–8192 字节".into());
        }
        self.templates = Some(templates);
        Ok(())
    }
    fn sources(&self) -> Vec<Source> {
        let mut sources = self.sources.clone();
        if let Some(old) = &self.source {
            if !sources.iter().any(|s| s.url == old.url) {
                sources.push(old.clone());
            }
        }
        sources
    }
    fn save_source(&mut self, source: Source, old_url: Option<&str>) -> Result<(), String> {
        let mut sources = self.sources();
        if let Some(old) = old_url {
            let index = sources
                .iter()
                .position(|s| s.url == old)
                .ok_or("仓库已移除，请刷新")?;
            if sources
                .iter()
                .enumerate()
                .any(|(i, s)| i != index && s.url == source.url)
            {
                return Err("该仓库地址已存在".into());
            }
            sources[index] = source;
        } else {
            if sources.iter().any(|s| s.url == source.url) {
                return Err("该仓库已存在，请使用编辑".into());
            }
            if sources.len() >= 16 {
                return Err("最多添加 16 个线上仓库".into());
            }
            sources.push(source);
        }
        self.sources = sources;
        self.source = None;
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct Origin {
    kind: String,
    path: Option<String>,
    digest: String,
}
#[derive(Clone, Serialize)]
struct Pending {
    #[serde(flatten)]
    package: Package,
    origin: Origin,
}
fn install_package(config: &mut Config, pending: &Pending) -> Result<(), String> {
    pending.package.validate()?;
    config.previous = config.installed.replace(pending.package.clone());
    config.previous_origin = config.origin.replace(pending.origin.clone());
    config.enabled = true;
    if pending.origin.kind == "local" {
        config.monitoring = false;
    }
    Ok(())
}
fn read_local_package(path: PathBuf) -> Result<Pending, String> {
    use std::io::Read;
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 262144 {
        return Err("请选择不超过 256 KiB 的插件 JSON 文件".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .map_err(|e| e.to_string())?
        .take(262145)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 262144 {
        return Err("插件包超过 256 KiB".into());
    }
    let package: Package =
        serde_json::from_slice(&bytes).map_err(|e| format!("插件 JSON 无效：{e}"))?;
    package.validate()?;
    Ok(Pending {
        package,
        origin: Origin {
            kind: "local".into(),
            path: Some(path.to_string_lossy().into_owned()),
            digest: format!("{:x}", Sha256::digest(&bytes)),
        },
    })
}

// Bounded discovery: root JSON files and two levels of child folders, never symlinks.
fn scan_folders(folders: &[String]) -> Value {
    let mut packages = Vec::new();
    let mut errors = Vec::new();
    let mut visited = 0usize;
    let mut queue: Vec<_> = folders.iter().map(|p| (PathBuf::from(p), 0)).collect();
    while let Some((dir, depth)) = queue.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) => {
                errors.push(format!("{}: {e}", dir.display()));
                continue;
            }
        };
        for entry in entries {
            visited += 1;
            if visited > 2000 {
                errors.push("达到 2000 个目录项扫描上限，请选择更具体的文件夹".into());
                return json!({"packages": packages, "errors": errors});
            }
            let Ok(entry) = entry else {
                continue;
            };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir()
                && depth < 2
                && !entry.file_name().to_string_lossy().starts_with('.')
                && entry.file_name() != "node_modules"
                && entry.file_name() != "target"
            {
                queue.push((path, depth + 1));
            } else if kind.is_file() && path.extension().is_some_and(|e| e == "json") {
                match read_local_package(path.clone()) {
                    Ok(package) => packages.push(package),
                    Err(e) => errors.push(format!("{}: {e}", path.display())),
                }
            }
        }
    }
    packages.sort_by(|a, b| a.origin.path.cmp(&b.origin.path));
    packages.dedup_by(|a, b| a.origin.path == b.origin.path);
    json!({"packages": packages, "errors": errors})
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    id: String,
    host_id: String,
    alias: String,
    kind: String,
    command: Option<String>,
    started_at: i64,
    finished_at: Option<i64>,
    status: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    truncated: bool,
}
struct Active {
    cancel: Arc<AtomicBool>,
    job: Job,
}
impl Job {
    fn summary(&self) -> Value {
        json!({"id": self.id, "hostId": self.host_id, "alias": self.alias, "kind": self.kind,
            "startedAt": self.started_at, "finishedAt": self.finished_at, "status": self.status,
            "exitCode": self.exit_code, "truncated": self.truncated})
    }
}
pub(crate) struct Runtime {
    path: PathBuf,
    config: Mutex<Config>,
    pending: Mutex<Option<Pending>>,
    active: Mutex<HashMap<String, Active>>,
    history: Mutex<Vec<Job>>,
    history_store: machine_history::Store,
    metrics: Mutex<HashMap<String, Value>>,
    slots: Semaphore,
}
impl Runtime {
    pub(crate) fn backup_ready(&self)->Result<(),String>{
        if self.config.lock().unwrap().monitoring{return Err("请先关闭后台监控，再进行备份或恢复".into());}
        if !self.active.lock().unwrap().is_empty(){return Err("请等待当前任务结束，再进行备份或恢复".into());} Ok(())
    }
    pub(crate) fn new(root: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let path = root.join("state.json");
        let mut config: Config = match std::fs::read(&path) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|e| format!("机器配置损坏：{e}"))?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Config::default(),
            Err(e) => return Err(e.to_string()),
        };
        validate_hosts(&config.hosts)?;
        // Copy only legacy FlowHub-owned profiles; never rewrite user SSH files.
        if let Some(home)=dirs::home_dir() {
            for host in &config.hosts {
                if host.bastion.is_none() && crate::connections::load(&root,&host.alias)?.is_none() {
                    if let Ok(Some(profile))=crate::ssh_profiles::managed(&home.join(".ssh"),&host.alias) {
                        let revision=crate::connections::revision(&root,&host.alias)?;
                        crate::connections::save(&root,&crate::connections::Connection{profile,password_auth:false},&revision,None)?;
                    }
                }
            }
        }
        config.installed = Some(serde_json::from_str(BUILTIN).map_err(|e| format!("{e}"))?);
        config.enabled = true;
        // A host upgrade must not prevent FlowHub itself from starting.
        if config
            .installed
            .as_ref()
            .is_some_and(|p| p.validate().is_err())
        {
            config.enabled = false;
            config.monitoring = false;
        }
        Ok(Self {
            history_store: machine_history::Store::open(&root.join("commands.sqlite3"))?,
            path,
            config: Mutex::new(config),
            pending: Mutex::new(None),
            active: Mutex::new(HashMap::new()),
            history: Mutex::new(Vec::new()),
            metrics: Mutex::new(HashMap::new()),
            slots: Semaphore::new(4),
        })
    }
    fn save(
        &self,
        update: impl FnOnce(&mut Config) -> Result<(), String>,
    ) -> Result<Value, String> {
        let mut config = self.config.lock().unwrap();
        let mut next = config.clone();
        update(&mut next)?;
        write_json_atomic(&self.path, &serde_json::to_value(&next).unwrap())?;
        *config = next;
        drop(config);
        Ok(self.snapshot())
    }
    pub(crate) fn status_snapshot(&self) -> Value {
        let snapshot=json!({"config":self.config.lock().unwrap().clone(),"metrics":self.metrics.lock().unwrap().clone()});
        status_summary(&snapshot, chrono::Utc::now().timestamp_millis())
    }
    fn snapshot(&self) -> Value {
        json!({"config": self.config.lock().unwrap().clone(), "pending": self.pending.lock().unwrap().clone(), "metrics": self.metrics.lock().unwrap().clone(), "active": self.active.lock().unwrap().values().map(|a| a.job.summary()).collect::<Vec<_>>(), "history": self.history.lock().unwrap().iter().map(Job::summary).collect::<Vec<_>>(), "readonly": false})
    }
    fn cancel_all(&self) {
        for active in self.active.lock().unwrap().values() {
            active.cancel.store(true, Ordering::Release);
        }
    }
}

fn status_summary(snapshot: &Value, now: i64) -> Value {
    let config = &snapshot["config"];
    let stale_ms = config["interval"].as_i64().unwrap_or(60).max(30) * 3000;
    let rows: Vec<Value> = config["hosts"].as_array().into_iter().flatten().map(|h| {
        let id = h["id"].as_str().unwrap_or("");
        let m = &snapshot["metrics"][id];
        let at = m["at"].as_i64();
        let status = if at.is_none() { "unknown" } else if now - at.unwrap() > stale_ms { "stale" }
            else if m["status"] == "success" { "healthy" } else { "error" };
        json!({"id":id,"name":h["name"],"status":status,"at":at,
            "values": if status == "healthy" {m["values"].clone()} else {Value::Null}})
    }).collect();
    json!({"title":"机器状态","monitoring":config["monitoring"],"rows":rows,"updatedAt":now})
}

#[cfg(test)]
mod status_tests {
    use super::*;
    #[test]
    fn summary_distinguishes_missing_stale_and_failed_without_exposing_connections() {
        let snapshot=json!({"config":{"interval":60,"monitoring":true,"hosts":[
            {"id":"a","name":"A","alias":"private-host","password":"secret"},
            {"id":"b","name":"B"},{"id":"c","name":"C"},{"id":"d","name":"D"}]},
            "metrics":{"a":{"at":999000,"status":"success","values":{"cpu":12.}},
            "b":{"at":1000,"status":"success","values":{"cpu":99.}},
            "c":{"at":999000,"status":"failed","error":"private SSH details"}}});
        let out=status_summary(&snapshot,1000000);
        assert_eq!(out["rows"][0]["status"],"healthy");
        assert_eq!(out["rows"][1]["status"],"stale");
        assert!(out["rows"][1]["values"].is_null());
        assert_eq!(out["rows"][2]["status"],"error");
        assert_eq!(out["rows"][3]["status"],"unknown");
        assert!(!out.to_string().contains("private"));assert!(!out.to_string().contains("secret"));
    }
}
fn valid_alias(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && !s.starts_with('-')
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
}
fn validate_command(s: &str) -> Result<(), String> {
    if s.trim().is_empty() || s.len() > 8192 || s.contains('\0') {
        Err("命令不能为空、包含 NUL 或超过 8192 字节".into())
    } else {
        Ok(())
    }
}
fn validate_hosts(hosts: &[Host]) -> Result<(), String> {
    let mut ids = HashSet::new();
    if hosts.len() > 500 {
        return Err("最多管理 500 台机器".into());
    }
    for h in hosts {
        if let Some(profile) = &h.bastion { profile.validate()?; }
        if !valid_alias(&h.alias)
            || !valid_alias(&h.id)
            || h.name.is_empty()
            || h.name.len() > 100
            || h.group.len() > 80
            || !ids.insert(&h.id)
        {
            return Err("机器名称、SSH 别名或 ID 无效/重复".into());
        }
    }
    Ok(())
}
fn authorize(config: &Config, capability: &str) -> Result<(), String> {
    if !config.enabled
        || !config
            .installed
            .as_ref()
            .is_some_and(|p| p.capabilities.iter().any(|c| c == capability))
    {
        Err("插件未启用或未授予所需权限".into())
    } else {
        Ok(())
    }
}
fn secure_url(s: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(s).map_err(|e| e.to_string())?;
    if u.scheme() != "https"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
    {
        return Err("仓库源和下载地址必须为无凭据的 HTTPS URL".into());
    }
    Ok(u)
}
async fn download(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || secure_url(attempt.url().as_str()).is_err() {
                attempt.error("插件下载仅允许最多 5 次 HTTPS 重定向")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(secure_url(url)?)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err("下载源未返回成功响应".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 262144 {
            return Err("插件/目录超过 256 KiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn verify_package(bytes: &[u8], entry: &Value, key: &str) -> Result<Package, String> {
    if entry["id"] != "machines"
        || format!("{:x}", Sha256::digest(bytes)) != entry["sha256"].as_str().unwrap_or("")
    {
        return Err("插件 ID 或摘要不匹配".into());
    }
    update_cache::verify(bytes, entry["signature"].as_str().ok_or("缺少签名")?, key)?;
    let package: Package = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    package.validate()?;
    Ok(package)
}
pub(crate) async fn machines_api(
    app: Context,
    action: String,
    payload: Value,
) -> Result<Value, String> {
    let rt = app.runtime.clone();
    match action.as_str() {
        "bastionStart" | "bastionState" | "bastionSend" | "bastionStop" | "bastionTerminal" => {
            let host = {
                let config = rt.config.lock().unwrap();
                authorize(&config, "ssh:terminal")?;
                config.hosts.iter().find(|h| Some(h.id.as_str()) == payload["hostId"].as_str()).cloned().ok_or("机器不存在")?
            };
            let profile = host.bastion.as_ref().ok_or("不是堡垒机连接")?;
            crate::bastion::handle(&rt.path, &host.id, profile, &action, &payload).await
        }
        "state" => Ok(rt.snapshot()),
        "history" => rt.history_store.page(&payload),
        "discoverSsh" => {
            authorize(&rt.config.lock().unwrap(), "ssh:configure")?;
            let root = dirs::home_dir().ok_or("找不到用户目录")?.join(".ssh");
            tokio::task::spawn_blocking(move || crate::ssh_profiles::discover(&root))
                .await
                .map_err(|e| e.to_string())
        }
        "catalog" => {
            let mut folders = rt.config.lock().unwrap().folders.clone();
            if let Some(path) = payload["path"].as_str() {
                if !folders.iter().any(|p| p == path) {
                    return Err("目录未配置或已移除".into());
                }
                folders.retain(|p| p == path);
            }
            let mut result = tokio::task::spawn_blocking(move || scan_folders(&folders))
                .await
                .map_err(|e| e.to_string())?;
            result["builtin"] = serde_json::from_str(BUILTIN).map_err(|e| e.to_string())?;
            Ok(result)
        }
        "addFolder" => {
            let Some(path) = crate::choose_path(true).await? else { return Ok(json!({"canceled":true})); };
            if !path.is_dir() {
                return Err("请选择文件夹".into());
            }
            let path = path.to_string_lossy().into_owned();
            rt.save(|c| {
                if let Some(old) = payload["oldPath"].as_str() {
                    let index = c
                        .folders
                        .iter()
                        .position(|p| p == old)
                        .ok_or("目录已移除，请刷新")?;
                    if c.folders
                        .iter()
                        .enumerate()
                        .any(|(i, p)| i != index && p == &path)
                    {
                        return Err("该目录已存在".into());
                    }
                    c.folders[index] = path;
                    return Ok(());
                }
                if !c.folders.contains(&path) {
                    if c.folders.len() >= 16 {
                        return Err("最多添加 16 个插件文件夹".into());
                    }
                    c.folders.push(path);
                }
                Ok(())
            })
        }
        "removeFolder" => rt.save(|c| {
            c.folders
                .retain(|p| Some(p.as_str()) != payload["path"].as_str());
            Ok(())
        }),
        "removeSource" => {
            let url = payload["url"].as_str().ok_or("请选择要移除的仓库")?;
            let result = rt.save(|c| {
                c.sources = c.sources().into_iter().filter(|s| s.url != url).collect();
                c.source = None;
                Ok(())
            })?;
            *rt.pending.lock().unwrap() = None;
            Ok(result)
        }
        "prepareLocal" => {
            let folders = rt.config.lock().unwrap().folders.clone();
            let path = payload["path"].as_str().ok_or("缺少插件路径")?.to_owned();
            let digest = payload["digest"].as_str().ok_or("缺少扫描摘要")?.to_owned();
            let pending = tokio::task::spawn_blocking(move || {
                let catalog = scan_folders(&folders);
                if !catalog["packages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| p["origin"]["path"] == path && p["origin"]["digest"] == digest)
                {
                    return Err("插件文件已变更或已移除，请重新扫描".to_string());
                }
                let pending = read_local_package(PathBuf::from(path))?;
                if pending.origin.digest != digest {
                    return Err("插件已变更，请重新扫描".into());
                }
                Ok(pending)
            })
            .await
            .map_err(|e| e.to_string())??;
            *rt.pending.lock().unwrap() = Some(pending);
            Ok(rt.snapshot())
        }
        "status" => {
            let c = rt.config.lock().unwrap();
            Ok(json!({"installed": c.installed.is_some(), "enabled": c.enabled}))
        }
        "sshRead" | "sshSave" | "sshProbe" | "chooseIdentity" => {
            {
                let config = rt.config.lock().unwrap();
                authorize(&config, "ssh:configure")?;
            }
            let root = dirs::home_dir().ok_or("找不到用户目录")?.join(".ssh");
            if action == "chooseIdentity" {
                let Some(path) = crate::choose_path(false).await? else { return Ok(json!({"canceled":true})); };
                return Ok(json!({"path":path}));
            }
            if action == "sshSave" {
                let profile: crate::ssh_profiles::Profile =
                    serde_json::from_value(payload["profile"].clone())
                        .map_err(|e| e.to_string())?;
                let connection=crate::connections::Connection {profile,password_auth:payload["passwordAuth"].as_bool().unwrap_or(false)};
                let revision=crate::connections::save(rt.path.parent().unwrap(),&connection,payload["revision"].as_str().ok_or("请先读取连接配置")?,payload["password"].as_str())?;
                return Ok(json!({"revision": revision}));
            }
            let alias = payload["alias"].as_str().unwrap_or("").to_owned();
            if !valid_alias(&alias) {
                return Err("SSH 别名无效".into());
            }
            let _permit = rt
                .slots
                .try_acquire()
                .map_err(|_| "SSH 任务忙，请稍后重试")?;
            let mut process = Command::new("/usr/bin/ssh");
            process.env("LC_ALL", "C");
            let mut job = Job {
                id: "profile".into(),
                host_id: String::new(),
                alias: alias.clone(),
                kind: "probe".into(),
                command: None,
                started_at: chrono::Utc::now().timestamp_millis(),
                finished_at: None,
                status: "running".into(),
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                truncated: false,
            };
            if action == "sshRead" {
                let revision = crate::connections::revision(rt.path.parent().unwrap(), &alias)?;
                if let Some(connection)=crate::connections::load(rt.path.parent().unwrap(),&alias)? {
                    return Ok(json!({"profile":connection.profile,"revision":revision,"passwordAuth":connection.password_auth}));
                }
                let managed = crate::ssh_profiles::managed(&root, &alias)?;
                process.args(["-G", "--", &alias]);
                run_process(
                    process,
                    Arc::new(AtomicBool::new(false)),
                    Duration::from_secs(10),
                    &mut job,
                )
                .await;
                if job.status != "success" || job.truncated {
                    return Err(format!(
                        "无法解析本机 SSH 配置：{} {}",
                        job.status, job.stderr
                    ));
                }
                let field = |name: &str| {
                    job.stdout
                        .lines()
                        .find_map(|l| l.strip_prefix(&format!("{name} ")))
                        .unwrap_or("")
                        .to_owned()
                };
                let inherited_keys: Vec<String> = job
                    .stdout
                    .lines()
                    .filter_map(|l| l.strip_prefix("identityfile ").map(str::to_owned))
                    .collect();
                let profile = managed.unwrap_or(crate::ssh_profiles::Profile {
                    alias: alias.clone(),
                    hostname: field("hostname"),
                    user: field("user"),
                    port: field("port").parse().unwrap_or(22),
                    identity_file: String::new(),
                    proxy_jump: if field("proxyjump") == "none" {
                        String::new()
                    } else {
                        field("proxyjump")
                    },
                });
                return Ok(
                    json!({"profile": profile, "revision": revision, "inheritedKeys": inherited_keys, "effective": {"hostname": field("hostname"), "user": field("user"), "port": field("port"), "proxyJump": field("proxyjump")}}),
                );
            }
            if !payload["profile"].is_null() {
                let profile: crate::ssh_profiles::Profile =
                    serde_json::from_value(payload["profile"].clone())
                        .map_err(|e| e.to_string())?;
                if profile.alias != alias {
                    return Err("SSH 别名与测试目标不一致".into());
                }
                if let Some(saved)=crate::connections::load(rt.path.parent().unwrap(),&alias)? {
                    if saved.password_auth && serde_json::to_value(&saved.profile).unwrap()!=serde_json::to_value(&profile).unwrap() {
                        return Err("密码模式下请先保存连接配置，再测试连接".into());
                    }
                }
                process.args(profile.options()?);
            }
            if let Some(connection)=crate::connections::load(rt.path.parent().unwrap(),&alias)? {
                crate::connections::configure(&mut process,&connection,rt.path.parent().unwrap())?;
            }
            // Force a fresh authentication rather than borrowing a multiplexed session.
            process.args(["-o", "ControlMaster=no", "-o", "ControlPath=none"]);
            process.args(ssh_args(&alias, "printf 'FLOWHUB_SSH_OK\\n'"));
            run_process(
                process,
                Arc::new(AtomicBool::new(false)),
                Duration::from_secs(20),
                &mut job,
            )
            .await;
            let success =
                job.status == "success" && job.stdout.lines().any(|line| line == "FLOWHUB_SSH_OK");
            let reason = if success {
                "SSH 连接、认证与命令执行成功"
            } else if job.status == "timeout" {
                "连接或认证超时"
            } else if job.stderr.contains("Host key verification failed")
                || job
                    .stderr
                    .contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
            {
                "主机指纹未信任或已改变，请在终端核验"
            } else if job.stderr.contains("Permission denied") {
                "认证失败：检查用户名、密钥与 ssh-agent 解锁状态"
            } else if job.stderr.contains("Connection refused") {
                "目标拒绝连接：检查 SSH 服务和端口"
            } else if job.stderr.contains("Could not resolve hostname") {
                "主机或跳板机名称无法解析"
            } else {
                "SSH 探测失败，查看错误详情"
            };
            Ok(
                json!({"success": success, "reason": reason, "stderr": job.stderr, "durationMs": chrono::Utc::now().timestamp_millis() - job.started_at}),
            )
        }
        "job" => {
            if let Some(job) = rt.history_store.job(payload["id"].as_str().unwrap_or(""))? { return Ok(job); }
            let history = rt.history.lock().unwrap();
            let job = history
                .iter()
                .find(|j| j.id == payload["id"].as_str().unwrap_or(""))
                .ok_or("记录已过期或任务未结束")?;
            Ok(serde_json::to_value(job).unwrap())
        }
        "installBuiltin" => {
            let package: Package = serde_json::from_str(BUILTIN).map_err(|e| e.to_string())?;
            rt.save(|c| {
                install_package(
                    c,
                    &Pending {
                        package,
                        origin: Origin {
                            kind: "builtin".into(),
                            path: None,
                            digest: format!("{:x}", Sha256::digest(BUILTIN.as_bytes())),
                        },
                    },
                )
            })
        }
        "chooseLocal" | "reloadLocal" => {
            let path = if action == "chooseLocal" {
                let Some(path) = crate::choose_path(false).await? else { return Ok(json!({"canceled":true})); };
                path
            } else {
                let config = rt.config.lock().unwrap();
                let origin = config
                    .origin
                    .as_ref()
                    .filter(|o| o.kind == "local")
                    .ok_or("当前安装版本不是本地开发包")?;
                PathBuf::from(
                    origin
                        .path
                        .as_ref()
                        .ok_or("本地路径已丢失，请重新选择文件")?,
                )
            };
            let pending = tokio::task::spawn_blocking(move || read_local_package(path))
                .await
                .map_err(|e| e.to_string())??;
            *rt.pending.lock().unwrap() = Some(pending);
            Ok(rt.snapshot())
        }
        "enable" => {
            let enabled = payload["enabled"].as_bool().ok_or("缺少 enabled")?;
            let result = rt.save(|c| {
                if enabled {
                    c.installed.as_ref().ok_or("请先安装插件")?.validate()?;
                }
                c.enabled = enabled;
                if !enabled {
                    c.monitoring = false;
                }
                Ok(())
            })?;
            if !enabled {
                rt.cancel_all();
            }
            Ok(result)
        }
        "uninstall" => {
            let result = rt.save(|c| {
                c.installed = None;
                c.previous = None;
                c.origin = None;
                c.previous_origin = None;
                c.enabled = false;
                c.monitoring = false;
                Ok(())
            })?;
            rt.cancel_all();
            *rt.pending.lock().unwrap() = None;
            Ok(result)
        }
        "rollback" => {
            let result = rt.save(|c| {
                let p = c.previous.take().ok_or("没有可回退版本")?;
                p.validate()?;
                c.previous = c.installed.replace(p);
                std::mem::swap(&mut c.origin, &mut c.previous_origin);
                Ok(())
            })?;
            rt.cancel_all();
            Ok(result)
        }
        "source" => {
            let source: Source =
                serde_json::from_value(json!({"url": payload["url"], "key": payload["key"]}))
                    .map_err(|e| e.to_string())?;
            secure_url(&source.url)?;
            if source.key.len() > 1024 {
                return Err("公钥过长".into());
            }
            use base64::Engine;
            let key = base64::engine::general_purpose::STANDARD
                .decode(source.key.trim())
                .map_err(|e| e.to_string())?;
            minisign_verify::PublicKey::decode(
                std::str::from_utf8(&key).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let result = rt.save(|c| c.save_source(source, payload["oldUrl"].as_str()))?;
            *rt.pending.lock().unwrap() = None;
            Ok(result)
        }
        "check" => {
            let url = payload["url"].as_str().ok_or("请选择要检查的仓库")?;
            let source = rt
                .config
                .lock()
                .unwrap()
                .sources()
                .into_iter()
                .find(|s| s.url == url)
                .ok_or("仓库未配置或已移除")?;
            let registry: Value =
                serde_json::from_slice(&download(&source.url).await?).map_err(|e| e.to_string())?;
            if registry["schema"] != 1 {
                return Err("仓库目录协议不兼容".into());
            }
            let entry = registry["packages"]
                .as_array()
                .and_then(|a| a.iter().find(|p| p["id"] == "machines"))
                .ok_or("仓库中没有 machines 插件")?;
            let bytes = download(entry["url"].as_str().ok_or("缺少下载地址")?).await?;
            let package = verify_package(&bytes, entry, &source.key)?;
            // Do not accept an in-flight response from a replaced source.
            let config = rt.config.lock().unwrap();
            if !config
                .sources()
                .iter()
                .any(|s| s.url == source.url && s.key == source.key)
            {
                return Err("仓库源已变更，请重新检查".into());
            }
            *rt.pending.lock().unwrap() = Some(Pending {
                package,
                origin: Origin {
                    kind: "remote".into(),
                    path: Some(source.url.clone()),
                    digest: format!("{:x}", Sha256::digest(&bytes)),
                },
            });
            drop(config);
            Ok(rt.snapshot())
        }
        "installPending" => {
            rt.save(|c| {
                let p = rt
                    .pending
                    .lock()
                    .unwrap()
                    .clone()
                    .ok_or("请先检查并审阅插件")?;
                if payload["digest"].as_str() != Some(p.origin.digest.as_str()) {
                    return Err("待安装包已变化，请重新审阅后安装".into());
                }
                install_package(c, &p)
            })?;
            *rt.pending.lock().unwrap() = None;
            rt.cancel_all();
            Ok(rt.snapshot())
        }
        "templates" => {
            let templates: Vec<Template> = serde_json::from_value(payload["templates"].clone()).map_err(|e| e.to_string())?;
            rt.save(|c| c.save_templates(templates))?;
            Ok(rt.snapshot())
        }
        "hosts" => {
            let hosts: Vec<Host> =
                serde_json::from_value(payload["hosts"].clone()).map_err(|e| e.to_string())?;
            validate_hosts(&hosts)?;
            let old = rt.config.lock().unwrap().hosts.clone();
            for previous in &old {
                if previous.bastion.is_some() && !hosts.iter().any(|h| h.id == previous.id && h.bastion == previous.bastion)
                    && crate::bastion::active(&rt.path, &previous.id).await {
                    return Err("请先在工作台断开堡垒机会话，再修改连接配置或删除机器".into());
                }
            }
            let keep: HashSet<String> = hosts
                .iter()
                .filter(|h| old.iter().any(|o| o.id == h.id && o.alias == h.alias))
                .map(|h| h.id.clone())
                .collect();
            rt.save(|c| {
                c.hosts = hosts;
                Ok(())
            })?;
            rt.metrics.lock().unwrap().retain(|id, _| keep.contains(id));
            for a in rt.active.lock().unwrap().values() {
                if !keep.contains(&a.job.host_id) {
                    a.cancel.store(true, Ordering::Release);
                }
            }
            Ok(rt.snapshot())
        }
        "import" => {
            let path = dirs::home_dir()
                .ok_or("找不到用户目录")?
                .join(".ssh/config");
            let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            Ok(
                json!({"aliases": parse_aliases(&text), "note": "导入 ~/.ssh/config 中明确的 Host 别名；Include 文件中的别名可手动添加。连接时由系统 SSH 解析完整配置。"}),
            )
        }
        "monitor" => {
            let enabled = payload["enabled"].as_bool().ok_or("缺少 enabled")?;
            let interval = payload["interval"].as_u64().unwrap_or(60);
            if !(30..=3600).contains(&interval) {
                return Err("采集间隔应为 30–3600 秒".into());
            }
            rt.save(|c| {
                if enabled {
                    authorize(c, "ssh:collect")?;
                }
                c.monitoring = enabled;
                c.interval = interval;
                Ok(())
            })
        }
        "cancel" => {
            let active = rt.active.lock().unwrap();
            let a = active
                .get(payload["id"].as_str().unwrap_or(""))
                .ok_or("任务已结束")?;
            a.cancel.store(true, Ordering::Release);
            Ok(json!({"ok": true}))
        }
        "connectionSettings" => {
            let reuse = payload["reuse"].as_bool().ok_or("缺少连接模式")?;
            let idle = payload["idleSeconds"].as_u64().unwrap_or(900);
            if !(60..=3600).contains(&idle) { return Err("连接空闲时间应为 60–3600 秒".into()); }
            rt.save(|c| { authorize(c, "ssh:execute")?; c.reuse_connections = reuse; c.connection_idle_seconds = idle; Ok(()) })?;
            Ok(rt.snapshot())
        }
        "terminal" => {
            let alias = {
                let c = rt.config.lock().unwrap();
                authorize(&c, "ssh:terminal")?;
                c.hosts
                    .iter()
                    .find(|h| h.id == payload["hostId"].as_str().unwrap_or(""))
                    .ok_or("机器不存在")?
                    .alias
                    .clone()
            };
            let options = connection_args(&rt.config.lock().unwrap())?;
            let mut args = vec![std::env::current_exe().map_err(|e|e.to_string())?.to_string_lossy().into_owned(),"--terminal".into(),rt.path.parent().unwrap().to_string_lossy().into_owned(),alias]; args.extend(options);
            let command = format!("exec {}", args.iter().map(|s| format!("'{}'", s.replace('\'', "'\\''"))).collect::<Vec<_>>().join(" "));
            let script = format!("tell application \"Terminal\"\nactivate\ndo script {}\nend tell", serde_json::to_string(&command).unwrap());
            let status = Command::new("/usr/bin/osascript")
                .arg("-e")
                .arg(script)
                .status()
                .await
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("无法打开终端，请检查 macOS 自动化授权".into());
            }
            Ok(json!({"ok": true}))
        }
        _ => Err("未知机器管理操作".into()),
    }
}
fn parse_aliases(text: &str) -> Vec<String> {
    let mut aliases = Vec::new();
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").replace('=', " ");
        let mut words = line.split_whitespace();
        if words.next().is_some_and(|w| w.eq_ignore_ascii_case("host")) {
            for word in words {
                let word = word.trim_matches('"');
                if valid_alias(word) && !aliases.iter().any(|a| a == word) {
                    aliases.push(word.to_owned());
                }
            }
        }
    }
    aliases.truncate(500);
    aliases
}
async fn bounded_read(mut reader: impl AsyncRead + Unpin) -> (String, bool) {
    let mut output = Vec::new();
    let mut truncated = false;
    let mut chunk = [0u8; 4096];
    while let Ok(n) = reader.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        let keep = n.min(OUTPUT_LIMIT - output.len());
        output.extend_from_slice(&chunk[..keep]);
        truncated |= keep < n;
    }
    (String::from_utf8_lossy(&output).into_owned(), truncated)
}
fn connection_args(config: &Config) -> Result<Vec<String>, String> {
    connection_args_at(config, &dirs::home_dir().ok_or("找不到用户目录")?)
}
fn connection_args_at(config: &Config, home: &std::path::Path) -> Result<Vec<String>, String> {
    if !config.reuse_connections {
        return Ok(["-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ControlPersist=no"].iter().map(|s| s.to_string()).collect());
    }
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    let directory = home.join(".ssh/flowhub-connections");
    // Create the socket directory privately from the outset, and reject redirects.
    std::fs::create_dir_all(home.join(".ssh")).map_err(|e| e.to_string())?;
    match std::fs::DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => {},
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {},
        Err(e) => return Err(e.to_string()),
    }
    let metadata = std::fs::symlink_metadata(&directory).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || metadata.uid() != std::fs::metadata(&home).map_err(|e| e.to_string())?.uid() || metadata.permissions().mode() & 0o077 != 0 {
        return Err("SSH 连接目录必须属于当前用户且权限为 700".into());
    }
    let socket = directory.join("%C").to_string_lossy().into_owned();
    if socket.len() + 38 >= 104 { return Err("SSH 连接目录路径过长，无法创建复用套接字".into()); }
    Ok(vec!["-o".into(), "ControlMaster=auto".into(), "-o".into(), format!("ControlPath={socket}"), "-o".into(), format!("ControlPersist={}", config.connection_idle_seconds.clamp(60, 3600))])
}
fn ssh_args(alias: &str, command: &str) -> Vec<String> {
    [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=2",
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "ForwardAgent=no",
        "--",
        alias,
        command,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}
async fn execute(
    app: Context,
    host_id: String,
    expected_alias: String,
    id: String,
    kind: String,
    command: String,
) -> Result<Job, String> {
    if !valid_alias(&id) {
        return Err("任务 ID 无效".into());
    }
    if kind != "collect" && kind != "command" {
        return Err("未知任务类型".into());
    }
    validate_command(&command)?;
    let rt = app.runtime.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let mut job = {
        let config = rt.config.lock().unwrap();
        authorize(
            &config,
            if kind == "collect" {
                "ssh:collect"
            } else {
                "ssh:execute"
            },
        )?;
        let host = config
            .hosts
            .iter()
            .find(|h| h.id == host_id)
            .ok_or("机器不存在")?;
        if host.alias != expected_alias {
            return Err("机器地址在审阅后发生变化，请重新选择目标".into());
        }
        if host.bastion.is_some() { return Err("堡垒机请使用持久会话工作台；暂不支持自动指标采集".into()); }
        let job = Job {
            id: id.clone(),
            host_id,
            alias: host.alias.clone(),
            command: if kind == "command" {
                Some(command.clone())
            } else {
                None
            },
            kind,
            started_at: chrono::Utc::now().timestamp_millis(),
            finished_at: None,
            status: "queued".into(),
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            truncated: false,
        };
        let mut active = rt.active.lock().unwrap();
        if active.len() >= 16 || active.contains_key(&id) {
            return Err("队列已满（最多 16 个任务）或任务 ID 重复".into());
        }
        if job.kind == "collect"
            && active
                .values()
                .any(|a| a.job.kind == "collect" && a.job.host_id == job.host_id)
        {
            return Err("该机器正在采集".into());
        }
        rt.history_store.save(&job)?;
        active.insert(
            id.clone(),
            Active {
                cancel: cancel.clone(),
                job: job.clone(),
            },
        );
        job
    };
    let acquire = rt.slots.acquire();
    tokio::pin!(acquire);
    let permit = loop {
        tokio::select! {
            permit = &mut acquire => break Some(permit.map_err(|e| e.to_string())?),
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if cancel.load(Ordering::Acquire) { break None; }
            }
        }
    };
    let allowed = {
        let config = rt.config.lock().unwrap();
        authorize(
            &config,
            if job.kind == "collect" {
                "ssh:collect"
            } else {
                "ssh:execute"
            },
        )
        .is_ok()
            && config
                .hosts
                .iter()
                .any(|h| h.id == job.host_id && h.alias == job.alias)
    };
    if cancel.load(Ordering::Acquire) || !allowed {
        job.status = "cancelled".into();
    } else {
        job.status = "running".into();
        if let Some(a) = rt.active.lock().unwrap().get_mut(&id) {
            a.job.status = job.status.clone();
        }
        let mut child = Command::new("/usr/bin/ssh");
        let options = connection_args(&rt.config.lock().unwrap()).and_then(|options| {
            if let Some(connection)=crate::connections::load(rt.path.parent().unwrap(),&job.alias)? {crate::connections::configure(&mut child,&connection,rt.path.parent().unwrap())?;}
            rt.history_store.save(&job)?; Ok(options)
        });
        if let Ok(options) = &options { child.args(options); }
        child.args(ssh_args(&job.alias, &command));
        let duration = Duration::from_secs(if job.kind == "collect" { 20 } else { 60 });
        match options {
            Ok(_) => run_process(child, cancel, duration, &mut job).await,
            Err(error) => { job.status = "failed".into(); job.stderr = error; }
        }
    }
    drop(permit);
    job.finished_at = Some(chrono::Utc::now().timestamp_millis());
    if job.kind == "collect" {
        let parsed = if job.status == "success" {
            serde_json::from_str::<Value>(job.stdout.trim())
                .ok()
                .filter(valid_metrics)
        } else {
            None
        };
        if job.status == "success" && parsed.is_none() {
            job.status = "failed".into();
            job.stderr.push_str("采集结果不是有效的 Linux 指标");
        }
        let config = rt.config.lock().unwrap();
        if config
            .hosts
            .iter()
            .any(|h| h.id == job.host_id && h.alias == job.alias)
        {
            rt.metrics.lock().unwrap().insert(job.host_id.clone(), json!({"at": job.finished_at, "status": job.status, "values": parsed, "error": job.stderr.chars().take(1000).collect::<String>()}));
        }
    }
    let persisted = rt.history_store.save(&job);
    rt.active.lock().unwrap().remove(&id);
    let mut history = rt.history.lock().unwrap();
    history.insert(0, job.clone());
    let (mut commands, mut collections) = (0, 0);
    history.retain(|j| {
        let count = if j.kind == "collect" { &mut collections } else { &mut commands };
        *count += 1;
        *count <= 100
    });
    persisted?;
    Ok(job)
}
async fn run_process(
    mut command: Command,
    cancel: Arc<AtomicBool>,
    duration: Duration,
    job: &mut Job,
) {
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    match command.spawn() {
        Err(e) => {
            job.status = "failed".into();
            job.stderr = e.to_string();
        }
        Ok(mut child) => {
            let out = tokio::spawn(bounded_read(child.stdout.take().unwrap()));
            let err = tokio::spawn(bounded_read(child.stderr.take().unwrap()));
            let deadline = tokio::time::Instant::now() + duration;
            loop {
                if cancel.load(Ordering::Acquire) || tokio::time::Instant::now() >= deadline {
                    job.status = if cancel.load(Ordering::Acquire) {
                        "cancelled"
                    } else {
                        "timeout"
                    }
                    .into();
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    break;
                }
                match child.try_wait() {
                    Ok(Some(status)) => {
                        job.exit_code = status.code();
                        job.status = if status.success() {
                            "success"
                        } else {
                            "failed"
                        }
                        .into();
                        break;
                    }
                    Err(e) => {
                        job.status = "failed".into();
                        job.stderr = e.to_string();
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        break;
                    }
                    Ok(None) => tokio::time::sleep(Duration::from_millis(100)).await,
                }
            }
            // A user's ProxyCommand can inherit pipes. Never wait indefinitely for EOF.
            for (mut task, stdout) in [(out, true), (err, false)] {
                match tokio::time::timeout(Duration::from_secs(1), &mut task).await {
                    Ok(Ok((text, clipped))) => {
                        if stdout {
                            job.stdout = text;
                        } else {
                            job.stderr.push_str(&text);
                        }
                        job.truncated |= clipped;
                    }
                    _ => {
                        task.abort();
                        job.truncated = true;
                    }
                }
            }
        }
    }
}
fn valid_metrics(v: &Value) -> bool {
    ["cpu", "memory", "disk"].iter().all(|k| {
        v[k].as_f64()
            .is_some_and(|n| n.is_finite() && (0.0..=100.0).contains(&n))
    }) && ["load", "uptime"]
        .iter()
        .all(|k| v[k].as_f64().is_some_and(|n| n.is_finite() && n >= 0.0))
}
pub(crate) async fn machines_run(
    app: Context,
    host_id: String,
    expected_alias: String,
    id: String,
    kind: String,
    command: Option<String>,
) -> Result<Value, String> {
    let script = if kind == "collect" {
        COLLECT.to_string()
    } else {
        command.ok_or("缺少命令")?
    };
    Ok(
        serde_json::to_value(execute(app, host_id, expected_alias, id, kind, script).await?)
            .unwrap(),
    )
}
pub(crate) fn validate_backup_state(value:&Value,root:&std::path::Path)->Result<(),String>{
    let config:Config=serde_json::from_value(value.clone()).map_err(|_|"备份中的机器配置无效")?;validate_hosts(&config.hosts)?;
    if root.join("commands.sqlite3").exists(){machine_history::Store::open(&root.join("commands.sqlite3"))?;}
    Ok(())
}
pub(crate) fn start_monitor(app: &Context) {
    let app = app.clone();
    tokio::spawn(async move {
        let mut due: HashMap<String, (tokio::time::Instant, u32)> = HashMap::new();
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let _guard=app.gate.read().await;
            if app.backup.pending_restore(){continue;}
            let config = app.runtime.clone().config.lock().unwrap().clone();
            if !config.monitoring || authorize(&config, "ssh:collect").is_err() {
                due.clear();
                continue;
            }
            due.retain(|id, _| config.hosts.iter().any(|h| &h.id == id));
            let mut batch = Vec::new();
            // Unvisited hosts first, then oldest due time; early entries must not starve a large fleet.
            let mut hosts = config.hosts.clone();
            hosts.sort_by_key(|host| due.get(&host.id).map(|(time, _)| *time));
            for host in &hosts {
                if host.bastion.is_some() { continue; }
                if due
                    .get(&host.id)
                    .is_some_and(|(time, _)| *time > tokio::time::Instant::now())
                {
                    continue;
                }
                let rt = app.runtime.clone();
                if rt
                    .active
                    .lock()
                    .unwrap()
                    .values()
                    .any(|a| a.job.host_id == host.id && a.job.kind == "collect")
                {
                    continue;
                }
                let id = format!(
                    "monitor-{:x}-{}",
                    Sha256::digest(host.id.as_bytes()),
                    chrono::Utc::now().timestamp_millis()
                );
                batch.push((
                    host.id.clone(),
                    tokio::spawn(execute(
                        app.clone(),
                        host.id.clone(),
                        host.alias.clone(),
                        id,
                        "collect".into(),
                        COLLECT.into(),
                    )),
                ));
                if batch.len() == 4 {
                    break;
                }
            }
            for (host_id, task) in batch {
                let result = task.await;
                let failures = if result.is_ok_and(|r| r.is_ok_and(|j| j.status == "success")) {
                    0
                } else {
                    due.get(&host_id).map(|(_, n)| n + 1).unwrap_or(1).min(4)
                };
                due.insert(
                    host_id,
                    (
                        tokio::time::Instant::now()
                            + Duration::from_secs(
                                config.interval.clamp(30, 3600) * 2u64.pow(failures),
                            ),
                        failures,
                    ),
                );
            }
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn managed_connection_modes_use_private_sockets_and_independent_disables_reuse() {
        use super::*;
        let home = PathBuf::from(format!("/tmp/fhcm-{}", std::process::id()));
        let mut config = Config::default();
        let independent = connection_args_at(&config, &home).unwrap();
        assert!(independent.contains(&"ControlPath=none".into()));
        assert!(!home.exists());
        config.reuse_connections = true; config.connection_idle_seconds = 900;
        let args = connection_args_at(&config, &home).unwrap();
        assert!(args.contains(&"ControlMaster=auto".into()));
        assert!(args.contains(&"ControlPersist=900".into()));
        assert!(args.iter().any(|s| s.ends_with("/%C")));
        let saved = serde_json::to_vec(&config).unwrap();
        let restored: Config = serde_json::from_slice(&saved).unwrap();
        assert_eq!(args, connection_args_at(&restored, &home).unwrap());
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(home.join(".ssh/flowhub-connections"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(connection_args_at(&config, &home).is_err());
        std::fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn local_templates_persist_without_modifying_plugin_and_validate_before_write() {
        use super::*;
        let root = std::env::temp_dir().join(format!("flowhub-templates-{}", std::process::id()));
        let rt = Runtime::new(root.clone()).unwrap();
        rt.save(|c| { c.installed = Some(serde_json::from_str(BUILTIN).unwrap()); c.enabled = true; Ok(()) }).unwrap();
        rt.save(|c| c.save_templates(vec![Template { name: "目录".into(), command: "ls".into() }])).unwrap();
        let reopened = Runtime::new(root.clone()).unwrap();
        assert_eq!(reopened.config.lock().unwrap().templates.as_ref().unwrap()[0].command, "ls");
        assert_eq!(serde_json::to_value(&reopened.config.lock().unwrap().installed).unwrap(), serde_json::from_str::<Value>(BUILTIN).unwrap());
        assert!(rt.save(|c| c.save_templates(vec![Template { name: "bad".into(), command: "中".repeat(3000) }])).is_err());
        rt.save(|c| c.save_templates(vec![])).unwrap();
        assert!(Runtime::new(root.clone()).unwrap().config.lock().unwrap().templates.as_ref().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    use super::*;
    #[test]
    fn multiple_sources_preserve_legacy_and_reject_duplicate_edits() {
        let source = |url: &str| Source {
            url: url.into(),
            key: "test-key".into(),
        };
        let mut c = Config::default();
        c.source = Some(source("https://a.example/registry.json"));
        c.save_source(source("https://b.example/registry.json"), None)
            .unwrap();
        assert!(c.source.is_none());
        assert_eq!(c.sources().len(), 2);
        assert!(c
            .save_source(source("https://b.example/registry.json"), None)
            .is_err());
        assert!(c
            .save_source(
                source("https://b.example/registry.json"),
                Some("https://a.example/registry.json")
            )
            .is_err());
        c.save_source(
            source("https://c.example/registry.json"),
            Some("https://a.example/registry.json"),
        )
        .unwrap();
        assert_eq!(c.sources()[0].url, "https://c.example/registry.json");
        assert_eq!(c.sources()[1].url, "https://b.example/registry.json");
        let saved = serde_json::to_vec(&c).unwrap();
        assert_eq!(
            serde_json::from_slice::<Config>(&saved)
                .unwrap()
                .sources()
                .len(),
            2
        );
    }

    #[test]
    fn folder_discovery_is_bounded_and_does_not_follow_symlinks() {
        let root = std::env::temp_dir().join(format!("flowhub-scan-{}", std::process::id()));
        let child = root.join("development/machines");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::write(child.join("package.json"), BUILTIN).unwrap();
        std::fs::write(root.join("bad.json"), "{}").unwrap();
        std::os::unix::fs::symlink(&child, root.join("linked")).unwrap();
        let folders = vec![root.to_string_lossy().into_owned()];
        let first = scan_folders(&folders);
        assert_eq!(first["packages"].as_array().unwrap().len(), 1);
        assert_eq!(first["errors"].as_array().unwrap().len(), 1);
        let mut changed: Value = serde_json::from_str(BUILTIN).unwrap();
        changed["version"] = json!("0.2.0");
        std::fs::write(child.join("package.json"), changed.to_string()).unwrap();
        let second = scan_folders(&folders);
        assert_ne!(
            first["packages"][0]["origin"]["digest"],
            second["packages"][0]["origin"]["digest"]
        );
        std::fs::remove_file(child.join("package.json")).unwrap();
        assert!(scan_folders(&folders)["packages"]
            .as_array()
            .unwrap()
            .is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_reload_installs_reviewed_snapshot_and_preserves_hosts() {
        let root = std::env::temp_dir().join(format!(
            "flowhub-local-package-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("package.json");
        std::fs::write(&path, BUILTIN).unwrap();
        let reviewed = read_local_package(path.clone()).unwrap();
        let mut updated: Value = serde_json::from_str(BUILTIN).unwrap();
        updated["templates"][0]["command"] = json!("echo changed");
        std::fs::write(&path, serde_json::to_vec(&updated).unwrap()).unwrap();
        let mut config = Config::default();
        config.hosts.push(Host {
            bastion: None,
            id: "dev".into(),
            alias: "dev".into(),
            name: "Dev".into(),
            group: "test".into(),
        });
        config.monitoring = true;
        install_package(&mut config, &reviewed).unwrap();
        assert_ne!(
            config.installed.as_ref().unwrap().templates[0].command,
            "echo changed"
        );
        assert!(!config.monitoring);
        let reloaded = read_local_package(path).unwrap();
        assert_ne!(reviewed.origin.digest, reloaded.origin.digest);
        assert_eq!(reviewed.package.version, reloaded.package.version);
        install_package(&mut config, &reloaded).unwrap();
        assert_eq!(
            config.installed.as_ref().unwrap().templates[0].command,
            "echo changed"
        );
        assert_eq!(
            config.previous.as_ref().unwrap().templates[0].command,
            reviewed.package.templates[0].command
        );
        assert_eq!(config.hosts.len(), 1);
        assert_eq!(config.previous_origin.as_ref().unwrap().kind, "local");
        let restored: Config =
            serde_json::from_value(serde_json::to_value(config).unwrap()).unwrap();
        assert_eq!(restored.origin.unwrap().path, reloaded.origin.path);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn local_packages_reject_oversize_invalid_json_and_extra_permissions() {
        let root = std::env::temp_dir().join(format!(
            "flowhub-invalid-package-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("package.json");
        for bytes in [b"invalid".to_vec(), vec![b' '; 262145]] {
            std::fs::write(&path, bytes).unwrap();
            assert!(read_local_package(path.clone()).is_err());
        }
        let mut value: Value = serde_json::from_str(BUILTIN).unwrap();
        value["capabilities"] = json!(["shell:local"]);
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(read_local_package(path.clone()).is_err());
        assert!(read_local_package(root.clone()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn signed_package_accepts_pinned_key_and_rejects_tampering() {
        // Public fixture, independently generated with Node's Ed25519/Blake2b primitives.
        // No private test or production key is stored in the repository.
        let fixture: Value =
            serde_json::from_str(include_str!("machines-signed-test.json")).unwrap();
        let data = fixture["package"].as_str().unwrap().as_bytes();
        let key = fixture["key"].as_str().unwrap();
        assert!(verify_package(data, &fixture["entry"], key).is_ok());
        let mut tampered = data.to_vec();
        tampered.push(b' ');
        assert!(verify_package(&tampered, &fixture["entry"], key).is_err());
        let mut entry = fixture["entry"].clone();
        entry["sha256"] = json!(format!("{:x}", Sha256::digest(&tampered)));
        assert!(verify_package(&tampered, &entry, key).is_err());
        entry["signature"] = json!("invalid");
        assert!(verify_package(data, &entry, key).is_err());
        assert!(verify_package(data, &fixture["entry"], "invalid-key").is_err());
    }
    #[test]
    fn package_rejects_privilege_and_version_changes() {
        let mut p: Package = serde_json::from_str(BUILTIN).unwrap();
        assert!(p.validate().is_ok());
        p.capabilities.push("shell:local".into());
        assert!(p.validate().is_err());
        p.capabilities.pop();
        p.host_version = ">=99.0.0".into();
        assert!(p.validate().is_err());
    }
    #[test]
    fn aliases_and_arguments_do_not_inject_local_commands() {
        for bad in [
            "-oProxyCommand=evil",
            "a;touch /tmp/x",
            "$(id)",
            "a\nb",
            "a@b",
            "a b",
        ] {
            assert!(!valid_alias(bad));
        }
        assert_eq!(
            parse_aliases("Host prod dev * !bad\nHost=\"jump\"\nHost prod\nInclude hosts/*"),
            vec!["prod", "dev", "jump"]
        );
        let args = ssh_args("prod", "printf '%s' '$HOME'; uname");
        assert_eq!(
            &args[args.len() - 3..],
            &["--", "prod", "printf '%s' '$HOME'; uname"]
        );
    }
    #[test]
    fn metrics_and_urls_are_validated() {
        assert!(valid_metrics(
            &json!({"cpu": 1, "memory": 2, "disk": 3, "load": 0.1, "uptime": 50})
        ));
        assert!(!valid_metrics(&json!({"cpu": "bad"})));
        assert!(!valid_metrics(
            &json!({"cpu": 101, "memory": 2, "disk": 3, "load": 1, "uptime": 0})
        ));
        assert!(secure_url("https://raw.githubusercontent.com/a/b/main/registry.json").is_ok());
        for bad in [
            "http://example.com",
            "file:///etc/passwd",
            "https://user:pass@example.com",
        ] {
            assert!(secure_url(bad).is_err());
        }
    }
    #[tokio::test]
    async fn output_is_bounded_and_drained() {
        let data = vec![b'x'; OUTPUT_LIMIT * 3];
        let (text, clipped) = bounded_read(&data[..]).await;
        assert_eq!(text.len(), OUTPUT_LIMIT);
        assert!(clipped);
    }
    #[test]
    fn disabled_plugin_blocks_execution() {
        let mut c = Config::default();
        assert!(authorize(&c, "ssh:execute").is_err());
        c.installed = Some(serde_json::from_str(BUILTIN).unwrap());
        c.enabled = true;
        assert!(authorize(&c, "ssh:execute").is_ok());
        c.enabled = false;
        assert!(authorize(&c, "ssh:collect").is_err());
    }
    fn test_job() -> Job {
        Job {
            id: "test".into(),
            host_id: "test".into(),
            alias: "test".into(),
            kind: "command".into(),
            command: None,
            started_at: 0,
            finished_at: None,
            status: "running".into(),
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            truncated: false,
        }
    }
    #[tokio::test]
    async fn process_preserves_exit_and_both_streams() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf 'output'; printf 'problem' >&2; exit 7"]);
        let mut job = test_job();
        run_process(
            command,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(2),
            &mut job,
        )
        .await;
        assert_eq!(job.exit_code, Some(7));
        assert_eq!(job.stdout, "output");
        assert_eq!(job.stderr, "problem");
        assert_eq!(job.status, "failed");
    }
    #[tokio::test]
    async fn timeout_and_cancel_reap_process() {
        for cancelled in [false, true] {
            let mut command = Command::new("/bin/sleep");
            command.arg("10");
            let mut job = test_job();
            tokio::time::timeout(
                Duration::from_secs(2),
                run_process(
                    command,
                    Arc::new(AtomicBool::new(cancelled)),
                    Duration::from_millis(80),
                    &mut job,
                ),
            )
            .await
            .unwrap();
            assert_eq!(job.status, if cancelled { "cancelled" } else { "timeout" });
        }
    }
    #[test]
    fn failed_config_write_does_not_change_live_state() {
        let root = std::env::temp_dir().join(format!(
            "flowhub-machines-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let rt = Runtime::new(root.clone()).unwrap();
        std::fs::create_dir(rt.path.clone()).unwrap();
        assert!(rt
            .save(|c| {
                c.enabled = false;
                Ok(())
            })
            .is_err());
        assert!(rt.config.lock().unwrap().enabled);
        std::fs::remove_dir_all(root).unwrap();
    }
}
