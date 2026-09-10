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
fn target_prompt(output: &str, target: &str) -> bool {
    let line = output.trim_end_matches(['\r', '\n']).lines().rev().find(|s| !s.trim().is_empty()).unwrap_or("").trim_end();
    if !line.ends_with('$') && !line.ends_with('#') { return false; }
    let Some((_, rest)) = line.rsplit_once('@') else { return false; };
    let hostname = rest.split(|c: char| c == ':' || c == ']' || c.is_whitespace()).next().unwrap_or("");
    hostname == target || hostname == target.split('.').next().unwrap_or(target)
}

// A dedicated lock serializes plugin input and collection. Attached terminals are
// excluded because their keystrokes do not pass through this lock.
pub async fn collect(root: &Path, host: &str, profile: &Profile, script: &str, cancel: &std::sync::atomic::AtomicBool) -> Result<String, String> {
    use base64::Engine;
    use std::sync::atomic::Ordering;
    let _guard = LOCK.lock().await;
    profile.validate()?;
    let (socket, session) = ids(root, host);
    if call(&socket, &["has-session", "-t", &session]).await.is_err() { return Err("请先连接堡垒机会话并完成目标机器登录".into()); }
    let saved = call(&socket, &["show-option", "-qv", "-t", &session, "@flowhub-profile"]).await?;
    if saved.trim() != serde_json::to_string(profile).unwrap() { return Err("会话配置已变化，请重新连接".into()); }
    if call(&socket, &["display-message", "-p", "-t", &session, "#{session_attached}"]).await?.trim() != "0" {
        return Err("系统终端正在附着此会话，请先脱离终端再采集".into());
    }
    if !call(&socket, &["show-option", "-qv", "-t", &session, "@flowhub-collect"]).await?.trim().is_empty() {
        return Err("上次采集未确认结束，请断开并重新连接会话后重试".into());
    }
    let before = call(&socket, &["capture-pane", "-p", "-J", "-t", &session, "-S", "-200"]).await?;
    if !target_prompt(&before, &profile.target) { return Err("目标机器尚未就绪或正在执行命令；采集需要 user@目标机器 的空闲 Shell 提示符".into()); }
    // Verify the real hostname again inside a separate shell before reading metrics.
    let checked = format!("h=$(hostname); case \"$h\" in {}|{}) ;; *) echo '目标机器身份不匹配'; exit 3;; esac\n{}", quote(&profile.target), quote(profile.target.split('.').next().unwrap()), script);
    let encoded = base64::engine::general_purpose::STANDARD.encode(checked);
    let mut random = [0u8; 16];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut random).map_err(|_| "无法生成采集标识")?;
    let token = random.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let begin = format!("FH_BEGIN_{token}"); let end = format!("FH_END_{token}");
    let command = format!("printf '\\n%s\\n' {begin}; printf %s {encoded} | base64 -d | sh 2>&1; printf '\\n{end}:%s\\n' \"$?\"");
    if cancel.load(Ordering::Acquire) { return Err("采集已取消".into()); }
    call(&socket, &["set-option", "-t", &session, "@flowhub-collect", &token]).await?;
    call(&socket, &["send-keys", "-l", "-t", &session, "--", &command]).await?;
    call(&socket, &["send-keys", "-t", &session, "Enter"]).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let output = call(&socket, &["capture-pane", "-p", "-J", "-t", &session, "-S", "-200"]).await?;
        if let Some((body, code)) = collection_output(&output, &begin, &end) {
            call(&socket, &["set-option", "-u", "-t", &session, "@flowhub-collect"]).await?;
            return if code == 0 { Ok(body) } else { Err(format!("堡垒机采集失败（exit {code}）：{body}")) };
        }
        // Never inject Ctrl+C into a shared pane on timeout/cancellation.
        if cancel.load(Ordering::Acquire) { return Err("采集已取消；会话中的采集命令可能仍在结束中".into()); }
        if tokio::time::Instant::now() >= deadline { return Err("堡垒机采集超时，请检查会话后重新连接".into()); }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}
fn collection_output(output: &str, begin: &str, end: &str) -> Option<(String, i32)> {
    let mut lines = output.lines().skip_while(|line| line.trim_end_matches('\r') != begin);
    lines.next()?;
    let mut body = Vec::new();
    for line in lines {
        let line = line.trim_end_matches('\r');
        if let Some(code) = line.strip_prefix(&format!("{end}:")) { return Some((body.join("\n").trim().into(), code.parse().ok()?)); }
        body.push(line);
    }
    None
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
    #[test]
    fn collection_requires_target_prompt_and_exact_output_markers() {
        assert!(target_prompt("user@vm-01:~$ \n\n", "vm-01"));
        assert!(target_prompt("[root@vm-01 /]# ", "vm-01.example"));
        for prompt in ["user@relay -> ", "Password: ", "user@other:~$ ", "user@vm-01:~$ sleep 30", "user@vm-01:~$ cat"] {
            assert!(!target_prompt(prompt, "vm-01"));
        }
        assert!(collection_output("echo BEGIN END:0", "BEGIN", "END").is_none());
        assert!(collection_output("BEGIN\n{}", "BEGIN", "END").is_none());
        assert_eq!(collection_output("echo BEGIN\r\nBEGIN\r\n{}\r\nEND:0\r\nuser@host:~$", "BEGIN", "END"), Some(("{}".into(), 0)));
    }
    #[tokio::test]
    async fn collection_reuses_idle_shell_without_replaying_login() {
        use std::os::unix::fs::PermissionsExt;
        if binary().is_err() { return; }
        let root = std::env::temp_dir().join(format!("fh-collect-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let target = String::from_utf8(Command::new("hostname").output().await.unwrap().stdout).unwrap().trim().to_string();
        let script = root.join("relay");
        std::fs::write(&script, format!("#!/bin/sh\nexport PS1={}\nexec /bin/sh -i\n", quote(&format!("test@{target}:~$ ")))).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let profile = Profile { script: script.to_string_lossy().into(), target, command: "n".into() };
        handle(&root, "collect", &profile, "bastionStart", &json!({})).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let cancel = std::sync::atomic::AtomicBool::new(false);
        for _ in 0..2 {
            assert_eq!(collect(&root, "collect", &profile, "printf '{\"cpu\":12}'", &cancel).await.unwrap(), "{\"cpu\":12}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        handle(&root, "collect", &profile, "bastionSend", &json!({"text":"sleep 1"})).await.unwrap();
        assert!(collect(&root, "collect", &profile, "echo must-not-run", &cancel).await.unwrap_err().contains("尚未就绪"));
        handle(&root, "collect", &profile, "bastionStop", &json!({})).await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
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
