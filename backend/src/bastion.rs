//! Interactive gateways run in a dedicated, user-owned tmux server.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::{Path, PathBuf}, sync::LazyLock, time::Duration};
use tokio::process::Command;

static LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Profile {
    pub script: String,
    pub target: String,
    pub command: String,
}
impl Profile {
    pub fn validate(&self) -> Result<(), String> {
        if !Path::new(&self.script).is_absolute() || self.script.len() > 1024 || self.script.chars().any(char::is_control) {
            return Err("relay 脚本须为本机绝对路径".into());
        }
        if self.target.is_empty() || self.target.len() > 128 || !self.target.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) || self.target.starts_with('-') {
            return Err("目标机器名称无效".into());
        }
        if !["n", "s", "v", "c", "k", "o"].contains(&self.command.as_str()) { return Err("不支持的堡垒机连接指令".into()); }
        Ok(())
    }
}
fn quote(s: &str) -> String { format!("'{}'", s.replace('\'', "'\\''")) }
fn binary() -> Result<PathBuf, String> {
    ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].into_iter().map(PathBuf::from).find(|p| p.is_file()).ok_or("需要安装 tmux（brew install tmux）".into())
}
fn ids(root: &Path, host: &str) -> (String, String) {
    (format!("flowhub-{:x}", Sha256::digest(root.to_string_lossy().as_bytes()))[..24].into(), format!("host-{:x}", Sha256::digest(host.as_bytes()))[..21].into())
}
async fn call(socket: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(binary()?);
    command.args(["-L", socket, "-f", "/dev/null"]).args(args).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(4), command.output()).await.map_err(|_| "tmux 操作超时")?.map_err(|e| e.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).chars().take(1000).collect()); }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
fn gateway_ready(output: &str) -> bool {
    let line = output.trim_end().lines().last().unwrap_or("").trim();
    line.contains('@') && line.ends_with(" ->") && !line.contains('\n')
}
pub async fn active(root: &Path, host: &str) -> bool {
    let (socket, session) = ids(root, host);
    call(&socket, &["has-session", "-t", &session]).await.is_ok()
}
pub async fn handle(root: &Path, host: &str, profile: &Profile, action: &str, payload: &Value) -> Result<Value, String> {
    let _guard = LOCK.lock().await;
    profile.validate()?;
    let (socket, session) = ids(root, host);
    let exists = call(&socket, &["has-session", "-t", &session]).await.is_ok();
    if action == "bastionStop" {
        if exists { call(&socket, &["kill-session", "-t", &session]).await?; }
        return Ok(json!({"connected":false,"output":"会话已断开。"}));
    }
    if action == "bastionStart" && !exists {
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::metadata(&profile.script).map_err(|e| format!("无法读取 relay 脚本：{e}"))?;
        if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 { return Err("relay 脚本不是可执行文件".into()); }
        let launch = format!("exec {}", quote(&profile.script));
        let home = dirs::home_dir().ok_or("找不到用户目录")?;
        let path = format!("PATH={}/.asdf/shims:{}/.local/bin:/opt/homebrew/bin:/usr/local/bin:{}", home.display(), home.display(), std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into()));
        call(&socket, &["new-session", "-d", "-s", &session, "-x", "120", "-y", "32", "-c", &home.to_string_lossy(), "-e", &path, &launch]).await?;
        call(&socket, &["set-option", "-t", &session, "@flowhub-profile", &serde_json::to_string(profile).unwrap()]).await?;
        call(&socket, &["set-option", "-t", &session, "@flowhub-target", "0"]).await?;
    } else if !exists {
        if action == "bastionState" { return Ok(json!({"connected":false,"output":"尚未连接，或会话已结束。"})); }
        return Err("请先连接堡垒机会话".into());
    }
    let saved = call(&socket, &["show-option", "-qv", "-t", &session, "@flowhub-profile"]).await?;
    if saved.trim() != serde_json::to_string(profile).unwrap() { return Err("会话使用旧配置，请先断开后重新连接".into()); }
    if action == "bastionTerminal" {
        let command = format!("exec {} -L {} attach-session -t {}", quote(&binary()?.to_string_lossy()), quote(&socket), quote(&session));
        let script = format!("tell application \"Terminal\"\nactivate\ndo script {}\nend tell", serde_json::to_string(&command).unwrap());
        let result = Command::new("/usr/bin/osascript").arg("-e").arg(script).status().await.map_err(|e| e.to_string())?;
        if !result.success() { return Err("打开系统终端失败".into()); }
    }
    if action == "bastionSend" {
        if let Some(key) = payload["key"].as_str() {
            if !["C-c", "Enter", "Tab", "Up", "Down", "Escape"].contains(&key) { return Err("不支持的按键".into()); }
            call(&socket, &["send-keys", "-t", &session, key]).await?;
        } else {
            let text = payload["text"].as_str().ok_or("缺少输入")?;
            if text.len() > 8192 || text.contains('\0') { return Err("输入过长或含无效字符".into()); }
            call(&socket, &["send-keys", "-l", "-t", &session, "--", text]).await?;
            call(&socket, &["send-keys", "-t", &session, "Enter"]).await?;
        }
    }
    let output = call(&socket, &["capture-pane", "-p", "-J", "-t", &session, "-S", "-200"]).await?;
    let sent = call(&socket, &["show-option", "-qv", "-t", &session, "@flowhub-target"]).await?;
    if sent.trim() == "0" && gateway_ready(&output) {
        // Mark first: interrupted requests must never replay a target command.
        call(&socket, &["set-option", "-t", &session, "@flowhub-target", "1"]).await?;
        call(&socket, &["send-keys", "-l", "-t", &session, "--", &format!("{} {}", profile.command, profile.target)]).await?;
        call(&socket, &["send-keys", "-t", &session, "Enter"]).await?;
    }
    Ok(json!({"connected":true,"output":output.chars().take(65536).collect::<String>(),"targetSent":sent.trim()=="1"}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn profile_and_prompt_boundaries() {
        let mut p = Profile { script:"/tmp/relay".into(), command:"n".into(), target:"vm-01".into() }; assert!(p.validate().is_ok());
        p.target="vm; rm".into(); assert!(p.validate().is_err());
        assert!(gateway_ready("banner\nuser@10.0.0.1 ->   \n")); assert!(!gateway_ready("user@host:~$"));
        assert_ne!(ids(Path::new("/a"),"host"), ids(Path::new("/b"),"host"));
    }
    #[tokio::test]
    async fn simulated_gateway_keeps_a_shared_session_and_never_replays_target() {
        use std::os::unix::fs::PermissionsExt;
        if binary().is_err() { return; }
        let root = std::env::temp_dir().join(format!("fh-gateway-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("relay");
        std::fs::write(&script, "#!/bin/sh\nprintf 'demo@relay -> '\nIFS= read -r line\nprintf '\\nTARGET:%s\\nmock$ ' \"$line\"\nwhile IFS= read -r line; do printf '\\nOUTPUT:%s\\nmock$ ' \"$line\"; done\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let profile = Profile { script: script.to_string_lossy().into(), target:"vm-01".into(), command:"n".into() };
        handle(&root, "test", &profile, "bastionStart", &json!({})).await.unwrap();
        let mut output = String::new();
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let state = handle(&root, "test", &profile, "bastionState", &json!({})).await.unwrap();
            output = state["output"].as_str().unwrap().to_string();
            if output.contains("TARGET:n vm-01") { break; }
        }
        assert!(output.contains("TARGET:n vm-01"), "{output}");
        let (socket, session) = ids(&root, "test");
        // Another client sends input to the same pane, as an attached terminal does.
        call(&socket, &["send-keys", "-l", "-t", &session, "external-client"]).await.unwrap();
        call(&socket, &["send-keys", "-t", &session, "Enter"]).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let state = handle(&root, "test", &profile, "bastionStart", &json!({})).await.unwrap();
        assert!(state["output"].as_str().unwrap().contains("OUTPUT:external-client"));
        assert_eq!(state["output"].as_str().unwrap().matches("TARGET:n vm-01").count(), 1);
        handle(&root, "test", &profile, "bastionStop", &json!({})).await.unwrap();
        assert!(!active(&root,"test").await);
        std::fs::remove_dir_all(root).unwrap();
    }
}
