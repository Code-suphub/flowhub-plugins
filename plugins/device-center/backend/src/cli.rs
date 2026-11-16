use super::{dispatch, refresh_devices, State};
use serde_json::{json, Value};
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::{
        fs::{DirBuilderExt, FileTypeExt, OpenOptionsExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

const REQUEST_LIMIT: u64 = 128;
const REPLY_LIMIT: u64 = 2 * 1024 * 1024;

fn directory(root: &Path) -> PathBuf {
    root.join("cli")
}

fn check_private(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "CLI 目录须为私有目录"));
    }
    Ok(())
}

fn bind(root: &Path) -> io::Result<(UnixListener, File)> {
    let directory = directory(root);
    match DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => (),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error),
    }
    check_private(&directory)?;
    let lock = OpenOptions::new().write(true).create(true).truncate(false)
        .mode(0o600).open(directory.join("lock"))?;
    lock.try_lock()?;
    let path = directory.join("control.sock");
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_socket() => fs::remove_file(&path)?,
        Ok(_) => return Err(io::Error::new(io::ErrorKind::AlreadyExists, "CLI 路径已被占用")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
        Err(error) => return Err(error),
    }
    let listener = UnixListener::bind(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    Ok((listener, lock))
}

fn performance_args(action: &str) -> Option<(&str, bool)> {
    let fields = action.split_whitespace().collect::<Vec<_>>();
    let (id, refresh) = match fields.as_slice() {
        ["adb", "performance", id] => (*id, false),
        ["adb", "performance", id, "--refresh"] => (*id, true),
        _ => return None,
    };
    (!id.is_empty() && id.len() <= 80 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'))
        .then_some((id, refresh))
}
fn history_id(action: &str) -> Option<&str> {
    let fields = action.split_whitespace().collect::<Vec<_>>();
    match fields.as_slice() {
        ["adb", "history", id] if crate::performance_history::valid_id(id) => Some(id),
        _ => None,
    }
}

fn mirror_args(action:&str)->Option<(&str,&str)> {
    let fields=action.split_whitespace().collect::<Vec<_>>();
    match fields.as_slice(){
        ["adb","mirror",method @ ("start"|"status"|"stop"),id] if crate::performance_history::valid_id(id)=>Some((method,id)),
        _=>None,
    }
}
fn phone_args(action:&str)->Option<(&str,&str)> {
    let fields=action.split_whitespace().collect::<Vec<_>>();
    match fields.as_slice(){
        ["phone","list"]=>Some(("list","")),
        ["phone",method @ ("connect"|"disconnect"|"frame"|"wake"|"recover"|"recovery_status"),id]
            if (16..=80).contains(&id.len())&&id.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-')=>Some((method,id)),
        _=>None,
    }
}

fn auto_args(action:&str)->bool {
    matches!(action.split_whitespace().collect::<Vec<_>>().as_slice(),["phone","auto","on"|"off",id] if crate::phone_bridge::valid_id(id))
}
fn execute(state: &Arc<Mutex<State>>, action: &str) -> Result<Value, String> {
    let fields=action.split_whitespace().collect::<Vec<_>>();
    if let ["phone","auto",mode @ ("on"|"off"),id]=fields.as_slice() {
        if !crate::phone_bridge::valid_id(id){return Err("手机标识无效".into());}
        let data=dispatch(state,"phone_auto_recovery",&json!({"id":id,"enabled":*mode=="on"}))?;
        return Ok(json!({"version":env!("CARGO_PKG_VERSION"),"pid":std::process::id(),"data":data}));
    }
    let value = match action {
        "status" => dispatch(state, "status_snapshot", &Value::Null)?,
        "refresh" => {
            refresh_devices(state)?;
            dispatch(state, "status_snapshot", &Value::Null)?
        }
        "k75 status" => super::k75_status()?,
        _ if phone_args(action).is_some() => {
            let (method,id)=phone_args(action).expect("validated phone command");
            dispatch(state,&format!("phone_{method}"),&json!({"id":id}))?
        },
        _ if mirror_args(action).is_some() => {
            let (method,id)=mirror_args(action).expect("validated mirror command");
            dispatch(state,&format!("adb_mirror_{method}"),&json!({"id":id}))?
        },
        _ => match performance_args(action) {
            Some((id, refresh)) => dispatch(state, "adb_performance", &json!({"id":id,"refresh":refresh}))?,
            None => match history_id(action) {
                Some(id) => dispatch(state, "adb_performance_history", &json!({"id":id}))?,
                None => return Err("未知 CLI 命令".into()),
            },
        },
    };
    Ok(json!({"pid":std::process::id(),"version":env!("CARGO_PKG_VERSION"),"data":value}))
}

pub fn serve(root: &Path, state: Arc<Mutex<State>>) -> io::Result<()> {
    let (listener, lock) = bind(root)?;
    thread::Builder::new().name("device-center-cli".into()).spawn(move || {
        let _lock = lock;
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break; };
            if stream.set_read_timeout(Some(Duration::from_secs(1))).is_err()
                || stream.set_write_timeout(Some(Duration::from_secs(2))).is_err() {
                continue;
            }
            let mut line = String::new();
            let result = match BufReader::new((&stream).take(REQUEST_LIMIT)).read_line(&mut line) {
                Ok(_) if line.ends_with('\n') => execute(&state, line.trim_end_matches('\n')),
                _ => Err("CLI 请求未结束或超过限制".into()),
            };
            let response = match result {
                Ok(value) => json!({"result":value}),
                Err(error) => json!({"error":error}),
            };
            let _ = writeln!(stream, "{response}");
        }
    })?;
    Ok(())
}

pub fn run(args: &[String]) -> Result<Value, String> {
    let joined = args.join(" ");
    let commands = ["status", "refresh", "k75 status", "adb performance <id> [--refresh]", "adb history <id>","adb mirror start|status|stop <id>","phone list","phone connect|disconnect|frame|wake|recover|recovery_status <id>","phone auto on|off <id>"];
    let action = match args {
        [cmd] if cmd == "status" => "status",
        [cmd] if cmd == "refresh" => "refresh",
        [group, cmd] if group == "k75" && cmd == "status" => "k75 status",
        [] => return Ok(json!({"result":{"commands":commands}})),
        [arg] if arg == "--help" || arg == "help" => {
            return Ok(json!({"result":{"commands":commands}}));
        }
        _ if performance_args(&joined).is_some() || history_id(&joined).is_some() || mirror_args(&joined).is_some() || phone_args(&joined).is_some() || auto_args(&joined) => &joined,
        _ => return Err("用法为 --cli status、refresh、k75 status 或 adb performance <id> [--refresh]".into()),
    };
    let root = std::env::var_os("FLOWHUB_PLUGIN_DATA").map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from).map(|home|
            home.join("Library/Application Support/FlowHub/device-center")))
        .ok_or("找不到外设中心数据目录")?;
    let directory = directory(&root);
    check_private(&directory).map_err(|_| "CLI 目录不可用，请先在 FlowHub 中打开外设中心")?;
    let mut stream = UnixStream::connect(directory.join("control.sock"))
        .map_err(|_| "无法连接外设中心，请在 FlowHub 中打开或重新加载插件")?;
    stream.set_read_timeout(Some(Duration::from_secs(36))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).map_err(|e| e.to_string())?;
    writeln!(stream, "{action}").map_err(|e| e.to_string())?;
    let mut reply = String::new();
    BufReader::new(stream.take(REPLY_LIMIT)).read_line(&mut reply).map_err(|e| e.to_string())?;
    if !reply.ends_with('\n') {
        return Err("外设中心 CLI 响应未结束或超过限制".into());
    }
    serde_json::from_str(&reply).map_err(|_| "外设中心 CLI 响应格式无效".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test] fn automatic_cli_accepts_paired_uuid_but_no_extra_commands(){
        assert!(auto_args("phone auto on 05e9e626-23c0-49d4-8223-b04ccb9fbe66"));
        assert!(auto_args("phone auto off paired-phone-123456"));
        for value in ["phone auto enable paired-phone-123456","phone auto on http://example.com","phone auto on ../../private","phone auto on paired-phone-123456 --force"] {assert!(!auto_args(value));}
    }

    #[test] fn phone_cli_does_not_accept_urls_commands_or_unpaired_paths(){
        assert_eq!(phone_args("phone list"),Some(("list","")));
        assert_eq!(phone_args("phone connect paired-phone-123456"),Some(("connect","paired-phone-123456")));
        for s in ["phone shell paired-phone-123456","phone connect http://example.com","phone frame ../private","phone connect paired-phone-123456 --force"]{assert!(phone_args(s).is_none());}
    }

    #[test]
    fn mirror_cli_accepts_only_fixed_actions_and_observed_device_ids() {
        assert_eq!(mirror_args("adb mirror start adb-phone"),Some(("start","adb-phone")));
        for text in ["adb mirror start 192.0.2.1:5555","adb mirror shell adb-phone","adb mirror start ../phone","adb mirror start adb-phone --record"] {
            assert!(mirror_args(text).is_none());
        }
        let state=Arc::new(Mutex::new(State::new()));
        assert!(execute(&state,"adb mirror start adb-phone").unwrap_err().contains("不在列表"));
        assert_eq!(execute(&state,"adb mirror status adb-phone").unwrap()["data"]["status"],"idle");
        assert_eq!(execute(&state,"adb mirror stop adb-phone").unwrap()["data"]["status"],"idle");
    }

    #[test]
    fn performance_cli_limits_input_and_uses_online_device_validation() {
        assert_eq!(performance_args("adb performance adb-phone-abc"), Some(("adb-phone-abc", false)));
        assert_eq!(performance_args("adb performance adb-phone-abc --refresh"), Some(("adb-phone-abc", true)));
        for action in ["adb shell id", "adb performance ../escape", "adb performance phone --force", "adb performance phone;id"] {
            assert!(performance_args(action).is_none());
        }
        let state = Arc::new(Mutex::new(State::new()));
        assert!(execute(&state, "adb performance adb-phone-abc").unwrap_err().contains("当前没有可用"));
    }

    #[test]
    fn cli_lease_protects_active_socket_and_recovers_stale_endpoint() {
        let root = PathBuf::from(format!("/tmp/flowhub-device-cli-test-{}", std::process::id()));
        DirBuilder::new().mode(0o700).create(&root).unwrap();
        let (listener, lock) = bind(&root).unwrap();
        let path = directory(&root).join("control.sock");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(bind(&root).is_err());
        assert!(UnixStream::connect(&path).is_ok());
        drop(listener);
        drop(lock);
        // macOS can finish closing the listening socket asynchronously.
        for _ in 0..20 {
            if UnixStream::connect(&path).is_err() { break; }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(UnixStream::connect(&path).is_err());
        let (listener, lock) = bind(&root).unwrap();
        assert!(UnixStream::connect(&path).is_ok());
        drop(listener);
        drop(lock);
        fs::remove_dir_all(root).unwrap();
    }
}
