mod machines;
mod cli;
mod ssh_profiles;
mod bastion;
mod storage;
mod connections;
mod vault;
mod backup;
mod update_cache;
mod netdata;
mod exporter;
use std::{path::PathBuf, sync::Arc};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
#[derive(Clone)]
pub(crate) struct Context { runtime: Arc<machines::Runtime>, gate:Arc<tokio::sync::RwLock<()>>, backup:Arc<backup::Manager> }

async fn choose_path(folder: bool) -> Result<Option<PathBuf>, String> {
    let script = if folder { "POSIX path of (choose folder)" } else { "POSIX path of (choose file)" };
    let output = tokio::process::Command::new("/usr/bin/osascript").args(["-e",script]).output().await.map_err(|e| e.to_string())?;
    if !output.status.success() { return Ok(None); }
    Ok(Some(PathBuf::from(String::from_utf8_lossy(&output.stdout).trim())))
}
async fn dispatch(ctx: Context, request: &Value) -> Result<Value, String> {
    if request["method"]=="backup_api" {
        let _guard=ctx.gate.write().await;
        ctx.runtime.backup_ready()?;
        return ctx.backup.api(&request["params"]).await;
    }
    let _guard=ctx.gate.read().await;
    if ctx.backup.pending_restore(){return Err("恢复已准备好，请在插件市场重新加载机器插件".into());}
    let p = &request["params"];
    let text = |key: &str| p[key].as_str().unwrap_or("").to_owned();
    match request["method"].as_str().unwrap_or("") {
        "widget_api" => match p["action"].as_str() {
            Some("machineSettings") => {
                let action=p["request"]["action"].as_str().unwrap_or("");
                if !["state","hosts","sshRead","sshSave","sshProbe","chooseIdentity"].contains(&action){Err("此页面只支持机器配置操作".into())}
                else {machines::machines_api(ctx.clone(),action.into(),p["request"]["payload"].clone()).await}
            },
            Some("settings") => machines::widget_settings(ctx.clone(),p.clone(),false),
            Some("saveSettings") => machines::widget_settings(ctx.clone(),p.clone(),true),
            Some("history") => machines::machines_api(ctx.clone(),"metricHistory".into(),serde_json::json!({"hostId":p["row"],"metric":p["metric"],"seconds":p["seconds"]})).await,
            _ => Err("不支持的组件操作".into()),
        },
        "machines_api" => machines::machines_api(ctx.clone(),text("action"),p["payload"].clone()).await,
        "machines_run" => machines::machines_run(ctx.clone(),text("hostId"),text("expectedAlias"),text("id"),text("kind"),p["command"].as_str().map(str::to_owned)).await,
        "health" => Ok(json!({"protocol":1,"name":"flowhub-machines","version":env!("CARGO_PKG_VERSION")})),
        "status_snapshot" => Ok(ctx.runtime.status_snapshot()),
        "status_history" => machines::machines_api(ctx.clone(),"metricHistory".into(),serde_json::json!({"hostId":p["row"],"metric":p["metric"],"seconds":p["seconds"]})).await,
        _ => Err("未知插件方法".into())
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if let Some(result)=connections::askpass(){return result.map_err(Into::into);}
    if std::env::args().nth(1).as_deref()==Some("--cli") {
        return cli::run(&std::env::args().skip(2).collect::<Vec<_>>()).await.map_err(Into::into);
    }
    if std::env::args().nth(1).as_deref()==Some("--terminal") {
        let args:Vec<String>=std::env::args().collect();
        let root=PathBuf::from(args.get(2).ok_or("缺少数据目录")?);
        let alias=args.get(3).ok_or("缺少机器别名")?;
        let config:Value=serde_json::from_slice(&std::fs::read(root.join("state.json"))?)?;
        if config["hosts"].as_array().is_some_and(|hosts|hosts.iter().any(|host|host["alias"].as_str()==Some(alias) && host["readOnly"].as_bool()==Some(true))) {
            return Err("此机器仅允许查询，不允许系统终端".into());
        }
        let mut process=tokio::process::Command::new("/usr/bin/ssh");
        if let Some(connection)=connections::load(&root,alias)? {connections::configure(&mut process,&connection,&root)?;}
        let status=process.args(&args[4..]).args(["-o","StrictHostKeyChecking=ask","--",alias]).status().await?;
        std::process::exit(status.code().unwrap_or(1));
    }
    let root = std::env::var_os("FLOWHUB_PLUGIN_DATA").map(PathBuf::from).ok_or("缺少 FLOWHUB_PLUGIN_DATA")?;
    backup::apply_pending(&root)?;
    let ctx = Context { runtime: Arc::new(machines::Runtime::new(root.clone())?),gate:Arc::new(tokio::sync::RwLock::new(())),backup:Arc::new(backup::Manager::new(root)) };
    cli::serve(ctx.clone(), &std::env::var_os("FLOWHUB_PLUGIN_DATA").map(PathBuf::from).unwrap()).await?;
    machines::start_monitor(&ctx);
    let out = Arc::new(tokio::sync::Mutex::new(tokio::io::stdout()));
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        if line.len() > 1024*1024 { return Err("请求过大".into()); }
        let request: Value = serde_json::from_str(&line)?;
        let ctx = ctx.clone(); let out = out.clone();
        tokio::spawn(async move {
            let result = dispatch(ctx,&request).await;
            let response = match result { Ok(value) => json!({"id":request["id"],"result":value}), Err(error) => json!({"id":request["id"],"error":error}) };
            let bytes = format!("{response}\n");
            let mut out = out.lock().await;
            let _ = out.write_all(bytes.as_bytes()).await; let _ = out.flush().await;
        });
    }
    Ok(())
}
