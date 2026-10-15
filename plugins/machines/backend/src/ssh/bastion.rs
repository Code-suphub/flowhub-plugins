//! Interactive gateways run in a dedicated, user-owned tmux server.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Arc, LazyLock, Mutex, Weak}, time::Duration};
use tokio::process::Command;

type SessionLocks = HashMap<(String, String), Weak<tokio::sync::Mutex<()>>>;
static LOCKS: LazyLock<Mutex<SessionLocks>> = LazyLock::new(|| Mutex::new(HashMap::new()));
fn session_lock(root: &Path, host: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = LOCKS.lock().unwrap();
    locks.retain(|_, lock| lock.strong_count() > 0);
    let key = ids(root, host);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) { return lock; }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock)); lock
}
const GATEWAY_READY_MARKER: &str = "FLOWHUB_GATEWAY_READY";
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
    if output.lines().any(|line| line.trim() == GATEWAY_READY_MARKER) { return true; }
    let line = output.trim_end().lines().last().unwrap_or("").trim();
    line.contains('@') && line.ends_with(" ->") && !line.contains('\n')
}
fn gateway_prompt(output: &str) -> bool {
    let line = output.trim_end().lines().last().unwrap_or("").trim();
    line.contains('@') && line.ends_with(" ->")
}
fn authentication_prompt(output: &str) -> bool {
    let line = output.trim_end().lines().last().unwrap_or("").to_lowercase();
    (line.ends_with(':') || line.ends_with('：')) && ["password", "verification", "otp", "验证码", "密码"].iter().any(|word|line.contains(word))
}
fn recent_output(output: &str, limit: usize) -> String {
    output.chars().rev().take(limit).collect::<Vec<_>>().into_iter().rev().collect()
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
pub async fn run_command(root: &Path, host: &str, profile: &Profile, script: &str, cancel: &std::sync::atomic::AtomicBool, timeout: Duration) -> Result<String, String> {
    use base64::Engine;
    use std::sync::atomic::Ordering;
    // Always run the idempotent start/prepare step. Besides creating a missing
    // session, this repairs an existing relay session left at the gateway
    // prompt (for example after a plugin reload) by sending the target command
    // before collection continues.
    let prepared = handle(root, host, profile, "bastionPrepare", &json!({})).await?;
    if prepared["phase"] == "failed" { return Err(prepared["output"].as_str().unwrap_or("连接脚本已退出").into()); }
    let lock = session_lock(root, host);
    let _guard = lock.lock().await;
    profile.validate()?;
    let (socket, session) = ids(root, host);
    if call(&socket, &["has-session", "-t", &session]).await.is_err() { return Err("堡垒机会话启动失败".into()); }
    let saved = call(&socket, &["show-option", "-qv", "-t", &session, "@flowhub-profile"]).await?;
    if saved.trim() != serde_json::to_string(profile).unwrap() { return Err("会话配置已变化，请重新连接".into()); }
    if call(&socket, &["display-message", "-p", "-t", &session, "#{session_attached}"]).await?.trim() != "0" {
        return Err("系统终端正在附着此会话，请先脱离终端再执行命令".into());
    }
    let mut before = call(&socket, &["capture-pane", "-p", "-J", "-t", &session, "-S", "-200"]).await?;
    let collect_marker = call(&socket, &["show-option", "-qv", "-t", &session, "@flowhub-collect"]).await?;
    if !collect_marker.trim().is_empty() {
        // A plugin restart can leave the tmux marker behind even though the
        // command has already returned to the target prompt. Recover that
        // safe idle state automatically; keep the guard when a command is
        // still running so two collectors cannot share the pane.
        if target_prompt(&before, &profile.target) {
            call(&socket, &["set-option", "-u", "-t", &session, "@flowhub-collect"]).await?;
        } else {
            return Err("上次采集仍在进行，请等待结束或断开并重新连接会话后重试".into());
        }
    }
    let target_sent = call(&socket, &["show-option", "-qv", "-t", &session, "@flowhub-target"]).await?.trim() == "1"
        || call(&socket, &["show-option", "-qv", "-t", &session, "@flowhub-ready"]).await?.trim() == "1";
    if !target_prompt(&before, &profile.target) && !target_sent { return Err("目标机器尚未就绪或正在执行命令；采集需要 user@目标机器 的空闲 Shell 提示符".into()); }
    if target_sent && !target_prompt(&before, &profile.target) {
        // The relay command may still be dialing the target. Do not write the
        // metrics command into the gateway shell until the target prompt is
        // visible; otherwise it can be consumed by `s` and lost.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            if cancel.load(Ordering::Acquire) { return Err("采集已取消".into()); }
            before = call(&socket, &["capture-pane", "-p", "-J", "-t", &session, "-S", "-200"]).await?;
            if target_prompt(&before, &profile.target) { break; }
            if tokio::time::Instant::now() >= deadline {
                return Err("目标机器尚未就绪或正在执行命令；采集需要 user@目标机器 的空闲 Shell 提示符".into());
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }
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
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let output = call(&socket, &["capture-pane", "-p", "-J", "-t", &session, "-S", "-200"]).await?;
        if let Some((body, code)) = collection_output(&output, &begin, &end) {
            call(&socket, &["set-option", "-u", "-t", &session, "@flowhub-collect"]).await?;
            return if code == 0 { Ok(body) } else { Err(format!("会话命令失败（exit {code}）：{body}")) };
        }
        // Never inject Ctrl+C into a shared pane on timeout/cancellation.
        if cancel.load(Ordering::Acquire) { return Err("会话命令已取消；远端命令可能仍在结束中".into()); }
        if tokio::time::Instant::now() >= deadline { return Err("会话命令超时，请检查会话后重新连接".into()); }
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
fn pause_path(root: &Path, host: &str) -> PathBuf {
    let (socket, session) = ids(root, host);
    let directory = if root.is_dir() { root } else { root.parent().unwrap() };
    directory.join("bastion-paused").join(format!("{socket}-{session}.json"))
}
fn paused(root: &Path, host: &str) -> bool { pause_path(root, host).exists() }
pub async fn handle(root: &Path, host: &str, profile: &Profile, action: &str, payload: &Value) -> Result<Value, String> {
    let lock = session_lock(root, host);
    let _guard = lock.lock().await;
    profile.validate()?;
    let (socket, session) = ids(root, host);
    let exists = call(&socket, &["has-session", "-t", &session]).await.is_ok();
    if action == "bastionPrepare" && paused(root, host) { return Err("此会话已手动断开，请在工作台点击连接后恢复采集".into()); }
    if action == "bastionStart" {
        match std::fs::remove_file(pause_path(root, host)) { Ok(()) => {}, Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}, Err(e) => return Err(e.to_string()) }
    }
    if action == "bastionStop" {
        let path = pause_path(root, host);
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        crate::data::storage::write_json_atomic(&path, &json!({"paused":true}))?;
        if exists { call(&socket, &["kill-session", "-t", &session]).await?; }
        return Ok(json!({"connected":false,"phase":"disconnected","paused":true,"output":"会话已断开；自动连接已暂停，点击连接后恢复。"}));
    }
    let start = matches!(action, "bastionStart" | "bastionPrepare");
    if start && !exists {
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::metadata(&profile.script).map_err(|e| format!("无法读取 relay 脚本：{e}"))?;
        if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 { return Err("relay 脚本不是可执行文件".into()); }
        let home = dirs::home_dir().ok_or("找不到用户目录")?;
        let path = format!("PATH={}/.asdf/shims:{}/.local/bin:/opt/homebrew/bin:/usr/local/bin:{}", home.display(), home.display(), std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into()));
        // tmux replaces PATH with its server's PATH when spawning a pane, even
        // when new-session -e supplies another value. Apply it after spawning;
        // separate command arguments also avoid interpreting the script as shell code.
        // Configure a holder pane before the relay can exit, retaining diagnostics
        // even when a dependency fails immediately.
        call(&socket, &["new-session", "-d", "-s", &session, "-x", "120", "-y", "32", "-c", &home.to_string_lossy(), "/bin/sleep", "60"]).await?;
        call(&socket, &["set-option", "-t", &session, "remain-on-exit", "on"]).await?;
        call(&socket, &["set-option", "-t", &session, "@flowhub-profile", &serde_json::to_string(profile).unwrap()]).await?;
        call(&socket, &["set-option", "-t", &session, "@flowhub-target", "0"]).await?;
        call(&socket, &["respawn-pane", "-k", "-t", &session, "/usr/bin/env", &path, &profile.script]).await?;
    } else if !exists {
        if action == "bastionState" { return Ok(json!({"connected":false,"phase":"disconnected","paused":paused(root,host),"output":if paused(root,host){"自动连接已暂停，点击连接后恢复。"}else{"尚未连接，或会话已结束。"}})); }
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
        if call(&socket, &["display-message", "-p", "-t", &session, "#{session_attached}"]).await?.trim() != "0" {
            return Err("系统终端正在操作此会话，请先脱离终端后再从页面发送输入".into());
        }
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
    let mut output = call(&socket, &["capture-pane", "-p", "-J", "-t", &session, "-S", "-200"]).await?;
    let mut sent = call(&socket, &["show-option", "-qv", "-t", &session, "@flowhub-target"]).await?;
    if sent.trim() == "0" && gateway_ready(&output) {
        // Mark first: interrupted requests must never replay a target command.
        call(&socket, &["set-option", "-t", &session, "@flowhub-target", "1"]).await?;
        call(&socket, &["send-keys", "-l", "-t", &session, "--", &format!("{} {}", profile.command, profile.target)]).await?;
        call(&socket, &["send-keys", "-t", &session, "Enter"]).await?;
        sent = "1".into();
    }
    let dead = call(&socket, &["display-message", "-p", "-t", &session, "#{pane_dead}"]).await?.trim() == "1";
    let phase = if dead { "failed" } else if target_prompt(&output, &profile.target) {
        call(&socket, &["set-option", "-t", &session, "@flowhub-ready", "1"]).await?; "ready"
    } else if gateway_prompt(&output) { if action == "bastionStart" || action == "bastionPrepare" || sent.trim() == "0" { "connecting" } else { "gateway" } }
    else if authentication_prompt(&output) { "authenticating" }
    else if call(&socket, &["show-option", "-qv", "-t", &session, "@flowhub-ready"]).await?.trim() == "1" { "busy" }
    else if sent.trim() == "1" { "connecting" } else { "authenticating" };
    let exit_code = if dead { call(&socket, &["display-message", "-p", "-t", &session, "#{pane_dead_status}"]).await?.trim().parse::<i32>().ok() } else { None };
    if dead { output.push_str(&format!("\n连接脚本已退出（exit {}），请检查以上输出，断开后再重试。", exit_code.map(|c|c.to_string()).unwrap_or_else(||"未知".into()))); }
    Ok(json!({"connected":!dead,"phase":phase,"exitCode":exit_code,"output":recent_output(&output,65536),"targetSent":sent.trim()=="1","paused":false}))
}
#[cfg(test)]
async fn collect(root: &Path, host: &str, profile: &Profile, script: &str, cancel: &std::sync::atomic::AtomicBool) -> Result<String, String> {
    run_command(root, host, profile, script, cancel, Duration::from_secs(20)).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn locks_serialize_one_host_without_blocking_other_hosts() {
        let root=Path::new("/tmp/flowhub-lock-tests");
        let first=session_lock(root,"a");let same=session_lock(root,"a");let other=session_lock(root,"b");
        let guard=first.lock().await;
        assert!(same.try_lock().is_err());assert!(other.try_lock().is_ok());
        drop(guard);assert!(same.try_lock().is_ok());
    }
    #[tokio::test]
    async fn fast_relay_exit_retains_output_and_exit_status() {
        use std::os::unix::fs::PermissionsExt;
        if binary().is_err() { return; }
        let root=std::env::temp_dir().join(format!("fh-relay-exit-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        std::fs::create_dir_all(&root).unwrap();let script=root.join("relay");
        std::fs::write(&script,"#!/bin/sh\necho FIXTURE_DEPENDENCY_MISSING >&2\nexit 42\n").unwrap();std::fs::set_permissions(&script,std::fs::Permissions::from_mode(0o700)).unwrap();
        let profile=Profile { script:script.to_string_lossy().into(),target:"vm-01".into(),command:"n".into() };
        handle(&root,"test",&profile,"bastionStart",&json!({})).await.unwrap();
        let deadline=tokio::time::Instant::now()+Duration::from_secs(3);
        let state=loop {
            let state=handle(&root,"test",&profile,"bastionState",&json!({})).await.unwrap();
            if state["output"].as_str().unwrap_or("").contains("FIXTURE_DEPENDENCY_MISSING") || tokio::time::Instant::now()>=deadline {break state;}
            tokio::time::sleep(Duration::from_millis(25)).await;
        };
        handle(&root,"test",&profile,"bastionStop",&json!({})).await.unwrap();std::fs::remove_dir_all(root).unwrap();
        assert_eq!(state["connected"],false);assert_eq!(state["phase"],"failed");assert_eq!(state["exitCode"],42);
        assert!(state["output"].as_str().unwrap().contains("FIXTURE_DEPENDENCY_MISSING"));
    }
    #[test]
    fn output_and_prompt_states_are_distinct() {
        assert!(authentication_prompt("banner\nPassword: "));assert!(!authentication_prompt("user@vm-01:~$ "));
        assert!(gateway_prompt("user@relay -> "));assert!(!gateway_prompt("FLOWHUB_GATEWAY_READY\nuser@vm-01:~$ "));
        assert_eq!(recent_output("旧输出新结果",3),"新结果");
    }
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
        let custom = format!("cd {}\nprintf '%s\\n' 'quote: '\\''ok'\nls", quote(&root.to_string_lossy()));
        let output = run_command(&root, "collect", &profile, &custom, &cancel, Duration::from_secs(60)).await.unwrap();
        assert!(output.contains("quote: 'ok")); assert!(output.contains("relay"));
        assert!(run_command(&root, "collect", &profile, "exit 7", &cancel, Duration::from_secs(60)).await.unwrap_err().contains("exit 7"));
        handle(&root, "collect", &profile, "bastionSend", &json!({"text":"sleep 1"})).await.unwrap();
        // 自 356721c 起，忙碌的 shell 不再直接报错：采集会等待目标提示符后再继续，
        // 以免把指标命令写进仍在拨号的网关 shell。这里用 1 秒阻塞制造忙碌窗口，
        // 断言采集确实等到提示符才执行（而不是立即注入）。
        let started = std::time::Instant::now();
        assert_eq!(collect(&root, "collect", &profile, "echo after-wait", &cancel).await.unwrap(), "after-wait");
        assert!(started.elapsed() >= Duration::from_millis(200), "忙碌的 shell 上采集应等待提示符，而不是立即注入");
        handle(&root, "collect", &profile, "bastionStop", &json!({})).await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test] fn profile_and_prompt_boundaries() {
        let mut p = Profile { script:"/tmp/relay".into(), command:"n".into(), target:"vm-01".into() }; assert!(p.validate().is_ok());
        p.target="vm; rm".into(); assert!(p.validate().is_err());
        assert!(gateway_ready("banner\nFLOWHUB_GATEWAY_READY\n"));
        assert!(gateway_ready("banner\nuser@10.0.0.1 ->   \n")); assert!(!gateway_ready("user@host:~$"));
        assert_ne!(ids(Path::new("/a"),"host"), ids(Path::new("/b"),"host"));
    }
    #[tokio::test]
    async fn gateway_preserves_dependency_path_with_a_gui_started_tmux_server() {
        use std::os::unix::fs::PermissionsExt;
        if binary().is_err() { return; }
        let root = std::env::temp_dir().join(format!("fh-gateway-path-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let (socket, _) = ids(&root, "test");
        let status = Command::new(binary().unwrap())
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .args(["-L", &socket, "-f", "/dev/null", "new-session", "-d", "-s", "holder", "/bin/sleep", "60"])
            .status().await.unwrap();
        assert!(status.success());
        // Include spaces and a quote to ensure tmux executes the path literally.
        let script = root.join("relay 'script");
        std::fs::write(&script, "#!/bin/sh\ncase \":$PATH:\" in *\":$HOME/.asdf/shims:\"*) ;; *) echo MISSING_DEPENDENCY_PATH; exit 1;; esac\nprintf 'PATH_READY\\ndemo@relay -> '\nwhile IFS= read -r line; do printf '\\nTARGET:%s\\nmock$ ' \"$line\"; done\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let profile = Profile { script: script.to_string_lossy().into(), target: "vm-01".into(), command: "n".into() };
        let mut result = handle(&root, "test", &profile, "bastionStart", &json!({})).await;
        let deadline=tokio::time::Instant::now()+Duration::from_secs(3);
        while result.as_ref().is_ok_and(|state| !state["output"].as_str().unwrap_or("").contains("PATH_READY")) && tokio::time::Instant::now()<deadline {
            tokio::time::sleep(Duration::from_millis(25)).await;
            result=handle(&root,"test",&profile,"bastionState",&json!({})).await;
        }
        // Clean up the simulated server before asserting, including on failure.
        call(&socket, &["kill-server"]).await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
        let state = result.unwrap();
        assert_eq!(state["connected"], true);
        assert!(state["output"].as_str().unwrap().contains("PATH_READY"));
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
        assert!(pause_path(&root, "test").is_file());
        assert!(handle(&root, "test", &profile, "bastionPrepare", &json!({})).await.unwrap_err().contains("手动断开"));
        assert!(collect(&root, "test", &profile, "echo must-not-run", &std::sync::atomic::AtomicBool::new(false)).await.is_err());
        assert!(!active(&root, "test").await);
        handle(&root, "test", &profile, "bastionStart", &json!({})).await.unwrap();
        assert!(!paused(&root, "test"));
        handle(&root, "test", &profile, "bastionStop", &json!({})).await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
