use serde_json::{json, Value};
mod management;
mod terminal;
use std::{
    path::PathBuf,
    process::Stdio,
    sync::{OnceLock, RwLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};

const LIMIT: usize = 512 * 1024;
static SNAPSHOT: OnceLock<RwLock<Value>> = OnceLock::new();
static COLLECT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn cache() -> &'static RwLock<Value> {
    SNAPSHOT.get_or_init(|| {
        RwLock::new(json!({"title":"Docker 管理","monitoring":true,"pending":true,"rows":[]}))
    })
}
fn snapshot() -> Value {
    let mut value = cache().read().unwrap().clone();
    if value["at"]
        .as_u64()
        .is_some_and(|at| now().saturating_sub(at) > 60000)
    {
        value["error"] = json!("Docker 状态已过期，等待重新采集");
        if let Some(rows) = value["rows"].as_array_mut() {
            for row in rows {
                row["status"] = json!("stale");
            }
        }
    }
    value
}
fn status_data(list: &Value, at: u64) -> Value {
    let rows:Vec<Value>=list["containers"].as_array().into_iter().flatten().map(|c|{
        let state=c["state"].as_str().unwrap_or("unknown");
        let raw=c["status"].as_str().unwrap_or("");
        let error=["restarting","dead"].contains(&state)||raw.contains("unhealthy");
        let status=if error{"error"}else if state=="running"{"healthy"}else{"unknown"};
        let label=match state{"running"=>if error{"健康检查失败"}else{"运行中"},"exited"=>"已停止","created"=>"未启动","paused"=>"已暂停","restarting"=>"重启中","dead"=>"异常",_=>"未知"};
        json!({"id":c["id"],"name":c["name"],"project":c["project"],"state":state,"status":status,"summary":label,"at":at,"values":{}})
    }).collect();
    json!({"title":"Docker 管理","monitoring":true,"context":list["context"],"at":at,"rows":rows})
}
async fn collect_status() {
    // One collector per plugin process. Widget RPC only reads its cached result.
    loop {
        let guard = COLLECT_LOCK.lock().await;
        let value = match dispatch("list", &json!({})).await {
            Ok(list) => status_data(&list, now()),
            Err(_) => {
                json!({"title":"Docker 管理","monitoring":true,"at":now(),"error":"无法连接本机 Docker，请检查引擎与当前 context","rows":[]})
            }
        };
        *cache().write().unwrap() = value;
        drop(guard);
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}
fn docker_path() -> Result<PathBuf, String> {
    [
        "/opt/homebrew/bin/docker",
        "/usr/local/bin/docker",
        "/Applications/Docker.app/Contents/Resources/bin/docker",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|p| p.is_file())
    .ok_or("未找到 Docker CLI，请先安装 Docker Desktop 或 Docker CLI。".into())
}
async fn bounded(mut stream: impl AsyncRead + Unpin) -> Result<String, String> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut overflow = false;
    loop {
        let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let remain = LIMIT.saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..n.min(remain)]);
        overflow |= n > remain;
    }
    let mut s = String::from_utf8_lossy(&bytes).into_owned();
    if overflow {
        s.push_str("\n[输出超过 512 KiB，已截断]");
    }
    Ok(s)
}
async fn run(args: &[String]) -> Result<String, String> {
    let mut child = tokio::process::Command::new(docker_path()?)
        .args(args)
        .env_remove("DOCKER_HOST")
        .env_remove("DOCKER_CONTEXT")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let future = async {
        let (status, out, err) = tokio::join!(child.wait(), bounded(out), bounded(err));
        let status = status.map_err(|e| e.to_string())?;
        let out = out?;
        let err = err?;
        if !status.success() {
            return Err(format!("Docker 执行失败：{}", err.trim()));
        }
        Ok(format!("{out}{err}"))
    };
    tokio::time::timeout(Duration::from_secs(45), future)
        .await
        .map_err(|_| "Docker 请求超时；操作可能仍在引擎内执行，请刷新核实状态。".to_string())?
}
fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}
async fn local_context() -> Result<String, String> {
    let context = run(&strings(&["context", "show"]))
        .await?
        .trim()
        .to_string();
    let endpoint = run(&strings(&[
        "context",
        "inspect",
        &context,
        "--format",
        "{{.Endpoints.docker.Host}}",
    ]))
    .await?;
    if !endpoint.trim().starts_with("unix://") {
        return Err(
            "第一版仅支持本机 Unix socket Docker 环境；请在终端切换到本机 context。".into(),
        );
    }
    Ok(context)
}
async fn docker(context: &str, args: &[&str]) -> Result<String, String> {
    let mut a = strings(&["--context", context]);
    a.extend(strings(args));
    run(&a).await
}
fn id(params: &Value) -> Result<&str, String> {
    let s = params["id"].as_str().unwrap_or("");
    if s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(s)
    } else {
        Err("无效的容器 ID".into())
    }
}
fn action(params: &Value) -> Result<&str, String> {
    match params["action"].as_str() {
        Some(a @ ("start" | "stop" | "restart")) => Ok(a),
        _ => Err("不支持的容器操作".into()),
    }
}
fn lines(raw: &str) -> Result<Vec<Value>, String> {
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            serde_json::from_str(l).map_err(|_| "Docker 返回了无效的数据或容器数量超出限制".into())
        })
        .collect()
}
async fn list_in_context(context: &str) -> Result<Value, String> {
    let format = r#"{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},"state":{{json .State}},"status":{{json .Status}},"ports":{{json .Ports}},"project":{{json (.Label "com.docker.compose.project")}},"service":{{json (.Label "com.docker.compose.service")}}}"#;
    let raw = docker(context, &["ps", "-a", "--no-trunc", "--format", format]).await?;
    Ok(json!({"context":context,"containers":lines(&raw)?}))
}
fn stop_targets(list: &Value, p: &Value) -> Result<Vec<Value>, String> {
    let scope = p["scope"].as_str().unwrap_or("");
    if scope == "container" {
        id(p)?;
    } else if scope == "project" {
        let project = p["project"].as_str().unwrap_or("");
        if project.is_empty() || project.len() > 200 {
            return Err("请选择具体的 Compose 项目".into());
        }
    } else {
        return Err("无效的停止范围".into());
    }
    let targets: Vec<Value> = list["containers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| {
            (if scope == "container" {
                c["id"] == p["id"]
            } else {
                c["project"] == p["project"]
            }) && matches!(
                c["state"].as_str(),
                Some("running" | "restarting" | "paused")
            )
        })
        .map(|c| json!({"id":c["id"],"name":c["name"],"state":c["state"]}))
        .collect();
    if targets.len() > 128 {
        return Err("单次最多停止 128 个容器".into());
    }
    Ok(targets)
}
fn same_targets(targets: &[Value], supplied: &Value) -> bool {
    let Some(ids) = supplied.as_array() else {
        return false;
    };
    let a: std::collections::BTreeSet<_> =
        targets.iter().filter_map(|r| r["id"].as_str()).collect();
    let b: std::collections::BTreeSet<_> = ids.iter().filter_map(Value::as_str).collect();
    ids.len() == a.len() && ids.len() == b.len() && a == b
}
async fn widget_stop(p: &Value) -> Result<Value, String> {
    let execute = p["action"] == "stop_confirm";
    // Reject malformed / unconfirmed requests before invoking Docker.
    stop_targets(&json!({"containers":[]}), p)?;
    if execute && p["confirmed"] != true {
        return Err("请先确认停止目标".into());
    }
    let _guard = COLLECT_LOCK.lock().await;
    let context = local_context().await?;
    if p["context"].as_str() != Some(context.as_str()) {
        return Err("Docker 环境已变化，请刷新后重试".into());
    }
    let list = list_in_context(&context).await?;
    let targets = stop_targets(&list, p)?;
    if !execute {
        return Ok(json!({"context":context,"targets":targets}));
    }
    if !same_targets(&targets, &p["ids"]) {
        return Err("目标容器列表或状态已变化，请重新确认".into());
    }
    if targets.is_empty() {
        return Ok(json!({"results":[],"snapshot":status_data(&list,now())}));
    }
    let mut args = vec!["stop", "--timeout", "10"];
    for c in &targets {
        args.push(c["id"].as_str().ok_or("Docker 返回了无效容器 ID")?);
    }
    let execution_error = docker(&context, &args).await.err();
    let after = list_in_context(&context).await;
    let (results,state)=match after{
        Ok(after)=>{
            let rows=after["containers"].as_array().ok_or("容器结果无效")?;
            let results:Vec<Value>=targets.iter().map(|t|{
                let state=rows.iter().find(|r|r["id"]==t["id"]).and_then(|r|r["state"].as_str()).unwrap_or("removed");
                let stopped=matches!(state,"exited"|"created");
                json!({"id":t["id"],"name":t["name"],"state":state,"stopped":stopped,"error":if stopped{None}else{Some(execution_error.as_deref().unwrap_or("未确认已停止，请刷新核实"))}})
            }).collect();
            (results,status_data(&after,now()))
        },
        Err(e)=>(targets.iter().map(|t|json!({"id":t["id"],"name":t["name"],"stopped":false,"state":"unknown","error":format!("结果无法核实：{e}")})).collect(),json!({"title":"Docker 管理","monitoring":true,"rows":[],"error":"操作后状态无法读取，请刷新核实","at":now()}))
    };
    *cache().write().unwrap() = state.clone();
    Ok(json!({"results":results,"snapshot":state}))
}
async fn dispatch(method: &str, p: &Value) -> Result<Value, String> {
    if method == "health" {
        return Ok(json!({"protocol":2,"name":"docker"}));
    }
    if method == "status_snapshot" {
        return Ok(snapshot());
    }
    if method == "widget_api" {
        return match p["action"].as_str() {
            Some("snapshot") => Ok(snapshot()),
            Some("stop_preview" | "stop_confirm") => widget_stop(p).await,
            Some("management") => manage(p["method"].as_str().unwrap_or(""), &p["params"]).await,
            _ => Err("不支持的桌面组件操作".into()),
        };
    }
    manage(method, p).await
}
async fn manage(method: &str, p: &Value) -> Result<Value, String> {
    if method.starts_with("terminal_") {
        return terminal::dispatch(method, p).await;
    }
    if ["images", "image_detail", "image_remove", "container_remove"].contains(&method) {
        return management::dispatch(method, p).await;
    }
    if ["stop_preview", "stop_confirm"].contains(&method) {
        let mut request = p.clone();
        request["action"] = json!(method);
        return widget_stop(&request).await;
    }
    if !["list", "detail", "logs", "operate"].contains(&method) {
        return Err("未知插件方法".into());
    }
    // Validate before invoking any local process.
    if method != "list" {
        id(p)?;
    }
    if method == "operate" {
        action(p)?;
        if p["confirmed"] != true {
            return Err("请先确认容器操作".into());
        }
    }
    let context = local_context().await?;
    if (method == "operate" || p["context"].is_string())
        && p["context"].as_str() != Some(context.as_str())
    {
        return Err("Docker 环境已变化，请刷新列表后重新确认。".into());
    }
    match method {
        "list" => list_in_context(&context).await,
        "detail" => {
            let cid = id(p)?;
            // Deliberately exclude Config.Env and arbitrary labels (may contain secrets).
            let format = r#"{"state":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"exitCode":{{json .State.ExitCode}},"started":{{json .State.StartedAt}},"restarts":{{json .RestartCount}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}}}"#;
            let raw = docker(
                &context,
                &["inspect", "--type", "container", "--format", format, cid],
            )
            .await?;
            let mut detail: Value = serde_json::from_str(raw.trim()).map_err(|e| e.to_string())?;
            if detail["state"] == "running" {
                match docker(
                    &context,
                    &["stats", "--no-stream", "--format", "{{json .}}", cid],
                )
                .await
                {
                    Ok(raw) => {
                        detail["stats"] = lines(&raw)?.into_iter().next().unwrap_or(Value::Null)
                    }
                    Err(e) => detail["statsError"] = json!(e),
                }
            }
            Ok(detail)
        }
        "logs" => Ok(
            json!({"text":docker(&context,&["logs","--tail","300","--timestamps",id(p)?]).await?}),
        ),
        "operate" => {
            let a = action(p)?;
            let cid = id(p)?;
            let args = if a == "start" {
                vec![a, cid]
            } else {
                vec![a, "--timeout", "10", cid]
            };
            docker(&context, &args).await?;
            Ok(json!({"ok":true,"action":a,"id":cid}))
        }
        _ => unreachable!(),
    }
}
#[tokio::main]
async fn main() {
    tokio::spawn(collect_status());
    tokio::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            terminal::sweep();
        }
    });
    let mut input = BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    while let Ok(Some(line)) = input.next_line().await {
        if line.len() > 65536 {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let result = dispatch(req["method"].as_str().unwrap_or(""), &req["params"]).await;
        let response = match result {
            Ok(v) => json!({"id":req["id"],"result":v}),
            Err(e) => json!({"id":req["id"],"error":e}),
        };
        if output
            .write_all(format!("{response}\n").as_bytes())
            .await
            .is_err()
        {
            break;
        }
        let _ = output.flush().await;
    }
    terminal::shutdown();
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_stop_is_exact_and_rejects_changed_or_duplicate_targets() {
        let list = json!({"containers":[{"id":"a","project":"app","state":"running"},{"id":"b","project":"app-extra","state":"running"},{"id":"c","project":"app","state":"exited"},{"id":"d","project":"app","state":"paused"}]});
        let targets = stop_targets(&list, &json!({"scope":"project","project":"app"})).unwrap();
        assert_eq!(targets.len(), 2);
        assert!(same_targets(&targets, &json!(["d", "a"])));
        assert!(!same_targets(&targets, &json!(["a", "a"])));
        assert!(!same_targets(&targets, &json!(["a", "b"])));
        assert!(stop_targets(&list, &json!({"scope":"project","project":""})).is_err());
    }
    #[tokio::test]
    async fn stop_confirmation_required_before_engine_access() {
        assert!(
            widget_stop(&json!({"action":"stop_confirm","scope":"project","project":"test"}))
                .await
                .unwrap_err()
                .contains("确认")
        );
    }
    #[test]
    fn snapshot_distinguishes_stopped_from_fault_and_excludes_details() {
        let list = json!({"context":"local","containers":[
            {"id":"a","name":"api","project":"demo","state":"running","status":"Up (unhealthy)","image":"private","ports":"secret"},
            {"id":"b","name":"db","state":"exited","status":"Exited (0)"},
            {"id":"c","name":"web","state":"running","status":"Up"}
        ]});
        let v = status_data(&list, 42);
        assert_eq!(v["rows"][0]["status"], "error");
        assert_eq!(v["rows"][1]["status"], "unknown");
        assert_eq!(v["rows"][2]["status"], "healthy");
        assert_eq!(v["at"], 42);
        assert!(!v.to_string().contains("secret"));
        assert!(!v.to_string().contains("private"));
    }
    #[tokio::test]
    async fn widget_rpc_never_executes_container_operations() {
        assert!(dispatch(
            "widget_api",
            &json!({"action":"stop","id":"a".repeat(64),"confirmed":true})
        )
        .await
        .is_err());
        assert!(dispatch("widget_api", &json!({"action":"snapshot"}))
            .await
            .unwrap()["rows"]
            .is_array());
    }
    #[test]
    fn rejects_injected_ids_and_actions() {
        for s in ["--help", "abc;touch /tmp/x", "abc", ""] {
            assert!(id(&json!({"id":s})).is_err());
        }
        assert!(id(&json!({"id":"a".repeat(64)})).is_ok());
        assert!(action(&json!({"action":"rm"})).is_err());
    }
    #[test]
    fn parses_group_labels_and_rejects_partial_output() {
        let v = lines("{\"project\":\"app\",\"service\":\"db\"}\n").unwrap();
        assert_eq!(v[0]["project"], "app");
        assert!(lines("{bad").is_err());
    }
    #[tokio::test]
    async fn bounded_output_handles_unicode_and_overflow() {
        let bytes = vec![b'x'; LIMIT + 100];
        let s = bounded(&bytes[..]).await.unwrap();
        assert!(s.ends_with("[输出超过 512 KiB，已截断]"));
        assert!(s.len() < LIMIT + 100);
    }
    #[tokio::test]
    async fn refuses_unconfirmed_operation_before_docker() {
        assert!(
            dispatch("operate", &json!({"id":"a".repeat(64),"action":"stop"}))
                .await
                .unwrap_err()
                .contains("确认")
        );
        assert!(dispatch("shell", &json!({})).await.is_err());
    }
}
