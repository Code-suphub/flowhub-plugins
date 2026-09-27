use super::*;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    sync::{Arc, Mutex},
    time::Instant,
};
use uuid::Uuid;

const MAX_SESSIONS: usize = 4;
const MAX_BUFFER: usize = 512 * 1024;
const READ_CHUNK: usize = 8192;
const IDLE_TIMEOUT: Duration = Duration::from_secs(2 * 60);

#[derive(Default)]
struct Output {
    bytes: VecDeque<u8>,
    closed: bool,
    dropped: bool,
}

struct Session {
    context: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    output: Arc<Mutex<Output>>,
    last_seen: Instant,
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn size(p: &Value) -> Result<PtySize, String> {
    let rows = p["rows"].as_u64().unwrap_or(0);
    let cols = p["cols"].as_u64().unwrap_or(0);
    if !(10..=100).contains(&rows) || !(20..=300).contains(&cols) {
        return Err("终端尺寸超出允许范围".into());
    }
    Ok(PtySize {
        rows: rows as u16,
        cols: cols as u16,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn shell(p: &Value) -> Result<&str, String> {
    match p["shell"].as_str() {
        Some(s @ ("/bin/sh" | "/bin/bash")) => Ok(s),
        _ => Err("只允许选择 /bin/sh 或 /bin/bash".into()),
    }
}

fn session_id(p: &Value) -> Result<&str, String> {
    let value = p["session"].as_str().ok_or("终端会话无效")?;
    Uuid::parse_str(value).map_err(|_| "终端会话无效".to_string())?;
    Ok(value)
}

fn with_session<T>(
    p: &Value,
    f: impl FnOnce(&mut Session) -> Result<T, String>,
) -> Result<T, String> {
    let id = session_id(p)?;
    let mut all = sessions().lock().map_err(|_| "终端状态不可用")?;
    let session = all.get_mut(id).ok_or("终端会话已结束，请重新连接")?;
    if p["context"].as_str() != Some(session.context.as_str()) {
        return Err("Docker 环境与终端会话不匹配".into());
    }
    session.last_seen = Instant::now();
    f(session)
}

fn spawn(context: &str, command: CommandBuilder, size: PtySize) -> Result<Value, String> {
    if sessions().lock().map_err(|_| "终端状态不可用")?.len() >= MAX_SESSIONS {
        return Err("终端会话数量已达上限，请先关闭其他终端".into());
    }
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| e.to_string())?;
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| e.to_string())?;
    drop(pair.slave);
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(e) => {
            let _ = child.kill();
            return Err(e.to_string());
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(e) => {
            let _ = child.kill();
            return Err(e.to_string());
        }
    };
    let output = Arc::new(Mutex::new(Output::default()));
    let shared = Arc::clone(&output);
    if let Err(e) = std::thread::Builder::new()
        .name("docker-terminal-reader".into())
        .spawn(move || {
            read_output(reader, shared);
        })
    {
        let _ = child.kill();
        return Err(e.to_string());
    }
    let id = Uuid::new_v4().to_string();
    let now = Instant::now();
    sessions().lock().map_err(|_| "终端状态不可用")?.insert(
        id.clone(),
        Session {
            context: context.into(),
            master: pair.master,
            writer,
            child,
            output,
            last_seen: now,
        },
    );
    Ok(json!({"session":id}))
}

fn open(context: &str, container: &str, shell: &str, size: PtySize) -> Result<Value, String> {
    let mut command = CommandBuilder::new(docker_path()?);
    command.arg("--context");
    command.arg(context);
    command.arg("exec");
    command.arg("-it");
    command.arg("--env");
    command.arg("TERM=xterm-256color");
    command.arg(container);
    command.arg(shell);
    command.env_remove("DOCKER_HOST");
    command.env_remove("DOCKER_CONTEXT");
    spawn(context, command, size)
}

fn read_output(mut reader: Box<dyn Read + Send>, output: Arc<Mutex<Output>>) {
    let mut chunk = [0u8; 4096];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let Ok(mut state) = output.lock() else { break };
                state.bytes.extend(&chunk[..count]);
                while state.bytes.len() > MAX_BUFFER {
                    state.bytes.pop_front();
                    state.dropped = true;
                }
            }
        }
    }
    if let Ok(mut state) = output.lock() {
        state.closed = true;
    }
}

pub fn sweep() {
    if let Ok(mut all) = sessions().lock() {
        all.retain(|_, session| session.last_seen.elapsed() < IDLE_TIMEOUT);
    }
}

pub fn shutdown() {
    if let Ok(mut all) = sessions().lock() {
        all.clear();
    }
}

pub async fn dispatch(method: &str, p: &Value) -> Result<Value, String> {
    if method == "terminal_open" {
        if p["confirmed"] != true {
            return Err("请先确认连接容器终端".into());
        }
        let container = id(p)?;
        let shell = shell(p)?;
        let size = size(p)?;
        let context = local_context().await?;
        if p["context"].as_str() != Some(context.as_str()) {
            return Err("Docker 环境已变化，请刷新后重试".into());
        }
        let list = list_in_context(&context).await?;
        if !list["containers"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|row| row["id"] == container && row["state"] == "running")
        }) {
            return Err("只能连接当前运行中的容器，请刷新列表".into());
        }
        return open(&context, container, shell, size);
    }
    match method {
        "terminal_read" => with_session(p, |session| {
            let mut output = session.output.lock().map_err(|_| "终端输出不可用")?;
            let mut bytes = Vec::with_capacity(READ_CHUNK.min(output.bytes.len()));
            for _ in 0..READ_CHUNK {
                if let Some(byte) = output.bytes.pop_front() {
                    bytes.push(byte);
                } else {
                    break;
                }
            }
            let dropped = std::mem::take(&mut output.dropped);
            Ok(
                json!({"bytes":bytes,"closed":output.closed && output.bytes.is_empty(),"dropped":dropped}),
            )
        }),
        "terminal_write" => {
            let bytes = p["bytes"].as_array().ok_or("终端输入格式无效")?;
            if bytes.len() > READ_CHUNK {
                return Err("单次输入过长".into());
            }
            let bytes: Vec<u8> = bytes
                .iter()
                .map(|item| {
                    item.as_u64()
                        .and_then(|n| u8::try_from(n).ok())
                        .ok_or("终端输入格式无效".to_string())
                })
                .collect::<Result<_, _>>()?;
            with_session(p, |session| {
                session
                    .writer
                    .write_all(&bytes)
                    .map_err(|e| e.to_string())?;
                Ok(json!({"ok":true}))
            })
        }
        "terminal_resize" => {
            let size = size(p)?;
            with_session(p, |session| {
                session.master.resize(size).map_err(|e| e.to_string())?;
                Ok(json!({"ok":true}))
            })
        }
        "terminal_close" => {
            let id = session_id(p)?;
            let mut all = sessions().lock().map_err(|_| "终端状态不可用")?;
            if let Some(session) = all.get(id) {
                if p["context"].as_str() != Some(session.context.as_str()) {
                    return Err("Docker 环境与终端会话不匹配".into());
                }
            }
            all.remove(id);
            Ok(json!({"ok":true}))
        }
        _ => Err("未知终端操作".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_shell_size_and_session_before_spawning() {
        assert!(shell(&json!({"shell":"/bin/sh"})).is_ok());
        assert!(shell(&json!({"shell":"/bin/bash"})).is_ok());
        assert!(shell(&json!({"shell":"/bin/sh -c whoami"})).is_err());
        assert!(size(&json!({"rows":24,"cols":80})).is_ok());
        assert!(size(&json!({"rows":1,"cols":80})).is_err());
        assert!(session_id(&json!({"session":"not-a-session"})).is_err());
    }

    #[tokio::test]
    async fn open_requires_confirmation_before_docker_access() {
        assert!(dispatch(
            "terminal_open",
            &json!({"id":"a".repeat(64),"shell":"/bin/sh","rows":24,"cols":80})
        )
        .await
        .unwrap_err()
        .contains("确认"));
        assert!(
            dispatch("terminal_open", &json!({"confirmed":true,"id":"bad"}))
                .await
                .is_err()
        );
        assert!(
            dispatch("terminal_write", &json!({"session":"bad","bytes":[1]}))
                .await
                .is_err()
        );
        assert!(dispatch("terminal_write", &json!({"bytes":[256]}))
            .await
            .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pty_streams_input_output_and_closes() {
        let command = CommandBuilder::new("/bin/cat");
        let opened = spawn(
            "test-context",
            command,
            size(&json!({"rows":24,"cols":80})).unwrap(),
        )
        .unwrap();
        let session = opened["session"].as_str().unwrap();
        dispatch(
            "terminal_write",
            &json!({"session":session,"context":"test-context","bytes":[104,101,108,108,111,10]}),
        )
        .await
        .unwrap();
        let mut received = Vec::new();
        for _ in 0..30 {
            let chunk = dispatch(
                "terminal_read",
                &json!({"session":session,"context":"test-context"}),
            )
            .await
            .unwrap();
            received.extend(
                chunk["bytes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|byte| byte.as_u64().unwrap() as u8),
            );
            if String::from_utf8_lossy(&received).contains("hello") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        assert!(String::from_utf8_lossy(&received).contains("hello"));
        dispatch(
            "terminal_resize",
            &json!({"session":session,"context":"test-context","rows":30,"cols":100}),
        )
        .await
        .unwrap();
        assert!(dispatch(
            "terminal_read",
            &json!({"session":session,"context":"other"})
        )
        .await
        .is_err());
        dispatch(
            "terminal_close",
            &json!({"session":session,"context":"test-context"}),
        )
        .await
        .unwrap();
        assert!(dispatch(
            "terminal_read",
            &json!({"session":session,"context":"test-context"})
        )
        .await
        .is_err());
    }
}
