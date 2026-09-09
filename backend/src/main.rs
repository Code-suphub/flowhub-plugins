mod machines;
mod ssh_profiles;
mod bastion;
mod storage;
mod update_cache;
use std::{path::PathBuf, sync::Arc};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
#[derive(Clone)]
pub(crate) struct Context { runtime: Arc<machines::Runtime> }

async fn choose_path(folder: bool) -> Result<Option<PathBuf>, String> {
    let script = if folder { "POSIX path of (choose folder)" } else { "POSIX path of (choose file)" };
    let output = tokio::process::Command::new("/usr/bin/osascript").args(["-e",script]).output().await.map_err(|e| e.to_string())?;
    if !output.status.success() { return Ok(None); }
    Ok(Some(PathBuf::from(String::from_utf8_lossy(&output.stdout).trim())))
}
async fn dispatch(ctx: Context, request: &Value) -> Result<Value, String> {
    let p = &request["params"];
    let text = |key: &str| p[key].as_str().unwrap_or("").to_owned();
    match request["method"].as_str().unwrap_or("") {
        "machines_api" => machines::machines_api(ctx,text("action"),p["payload"].clone()).await,
        "machines_run" => machines::machines_run(ctx,text("hostId"),text("expectedAlias"),text("id"),text("kind"),p["command"].as_str().map(str::to_owned)).await,
        "health" => Ok(json!({"protocol":1,"name":"flowhub-machines","version":env!("CARGO_PKG_VERSION")})),
        _ => Err("未知插件方法".into())
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::var_os("FLOWHUB_PLUGIN_DATA").map(PathBuf::from).ok_or("缺少 FLOWHUB_PLUGIN_DATA")?;
    let ctx = Context { runtime: Arc::new(machines::Runtime::new(root)?) };
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
