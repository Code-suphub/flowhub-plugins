//! Local CLI talks to the running plugin; it never opens a second data writer.
use crate::Context;
use serde_json::{json, Value};
use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

pub async fn request(ctx: Context, value: Value) -> Result<Value, String> {
    let state = crate::machines::machines_api(ctx.clone(), "state".into(), json!({})).await?;
    let hosts = state["config"]["hosts"].as_array().ok_or("机器清单不可用")?;
    let action = value["action"].as_str().unwrap_or("");
    if action == "list" {
        return Ok(Value::Array(hosts.iter().map(|h| json!({"id":h["id"],"alias":h["alias"],"name":h["name"],"group":h["group"],"readOnly":h["readOnly"],"connectionType":if h["bastion"].is_object(){"bastion"}else{"ssh"}})).collect()));
    }
    if action == "status" { return Ok(ctx.runtime.status_snapshot()); }
    if !["collect", "query", "exec"].contains(&action) { return Err("支持 list、status、collect、query、exec".into()); }
    let target = value["target"].as_str().ok_or("缺少机器 ID 或别名")?;
    let matched: Vec<_> = hosts.iter().filter(|h| h["id"].as_str()==Some(target) || h["alias"].as_str()==Some(target)).collect();
    if matched.len()!=1 { return Err("机器不存在或别名不唯一，请使用机器 ID".into()); }
    let host = matched[0];
    let command = value["command"].as_str().unwrap_or("");
    if action == "query" && !crate::machines::query_allowed(command) { return Err("查询仅支持 uptime、hostname、uname -a、df -h /、free -m".into()); }
    let mut bytes=[0u8;16];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(),&mut bytes).map_err(|_|"无法生成任务 ID")?;
    let id=bytes.iter().map(|b|format!("{b:02x}")).collect();
    crate::machines::machines_run(ctx,host["id"].as_str().unwrap().into(),host["alias"].as_str().unwrap().into(),id,
        if action=="collect"{"collect"}else{"command"}.into(),Some(command.into())).await
}

pub async fn serve(ctx: Context, root: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let path=root.join("cli.sock");
    if path.exists() {
        if tokio::net::UnixStream::connect(&path).await.is_ok(){return Err("机器插件 CLI 已由另一个进程提供".into());}
        std::fs::remove_file(&path).map_err(|e|e.to_string())?;
    }
    let listener=tokio::net::UnixListener::bind(&path).map_err(|e|e.to_string())?;
    std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o600)).map_err(|e|e.to_string())?;
    tokio::spawn(async move {
        let slots=std::sync::Arc::new(tokio::sync::Semaphore::new(8));
        while let Ok((stream,_))=listener.accept().await {
            let Ok(permit)=slots.clone().try_acquire_owned() else {continue;};
            let ctx=ctx.clone();
            tokio::spawn(async move {
                let _permit=permit;
                let mut reader=tokio::io::BufReader::new(stream);
                let mut line=String::new();
                let read=tokio::time::timeout(std::time::Duration::from_secs(5), (&mut reader).take(16385).read_line(&mut line)).await;
                let result=match read {
                    Ok(Ok(_)) if line.len()<=16384 => match serde_json::from_str(&line) {
                        Ok(value)=>{let _guard=ctx.gate.read().await; if ctx.backup.pending_restore(){Err("请先重新加载插件完成恢复".into())}else{request(ctx.clone(),value).await}},
                        Err(_)=>Err("无效 JSON 请求".into())
                    },
                    _=>Err("请求超时或超过 16 KiB".into())
                };
                let response=match result {Ok(v)=>json!({"result":v}),Err(e)=>json!({"error":e})};
                let _=reader.get_mut().write_all(format!("{response}\n").as_bytes()).await;
            });
        }
    });
    Ok(())
}

pub async fn run(args: &[String]) -> Result<(), String> {
    if args.is_empty() || args[0]=="--help" {
        println!("flowhub-machines --cli list|status\nflowhub-machines --cli collect <机器ID或别名>\nflowhub-machines --cli query <机器> 'uptime'\nflowhub-machines --cli exec <机器> '命令'\n连接正在运行的 FlowHub 机器插件，返回 JSON；FLOWHUB_PLUGIN_DATA 可指定数据目录。");
        return Ok(());
    }
    let root=std::env::var_os("FLOWHUB_PLUGIN_DATA").map(std::path::PathBuf::from).or_else(||dirs::home_dir().map(|h|h.join("Library/Application Support/FlowHub/machines"))).ok_or("找不到插件目录")?;
    let value=json!({"action":args[0],"target":args.get(1),"command":args.get(2)});
    let mut stream=tokio::net::UnixStream::connect(root.join("cli.sock")).await.map_err(|_|"无法连接机器插件，请在 FlowHub 中启用或重新加载插件")?;
    stream.write_all(format!("{value}\n").as_bytes()).await.map_err(|e|e.to_string())?;
    let mut output=String::new();
    tokio::io::BufReader::new(stream).read_line(&mut output).await.map_err(|e|e.to_string())?;
    let response:Value=serde_json::from_str(&output).map_err(|_|"插件返回无效响应")?;
    println!("{response}");
    if response.get("error").is_some() || response["result"]["status"].as_str().is_some_and(|s|s!="success") {return Err("CLI 请求失败，详情见 JSON 输出".into());}
    Ok(())
}
