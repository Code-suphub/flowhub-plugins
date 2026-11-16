use crate::{adb, now, read_system_query, toolkit_adb, Device};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufRead, BufReader, Read},
    os::{fd::FromRawFd, unix::process::CommandExt},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reply {
    pub status: String,
    pub route: Option<String>,
    pub error: Option<String>,
}
struct Job {
    generation: u64,
    reply: Reply,
    stop: Arc<AtomicBool>,
}
static JOBS: OnceLock<Mutex<BTreeMap<String, Job>>> = OnceLock::new();
fn jobs() -> &'static Mutex<BTreeMap<String, Job>> {
    JOBS.get_or_init(Mutex::default)
}
fn active(reply: &Reply) -> bool {
    matches!(
        reply.status.as_str(),
        "connecting" | "starting" | "running" | "stopping"
    )
}

fn label(route: &adb::Connection) -> String {
    match route.source.as_deref().unwrap_or(&route.transport) {
        "usb" => "USB",
        "easytier" => "EasyTier",
        "tailscale" => "Tailscale",
        "wireless" => "无线调试",
        _ => "TCP/IP",
    }
    .into()
}

fn candidates(info: &adb::Info) -> Vec<adb::Connection> {
    let mut routes = info.connections.clone();
    if routes.is_empty() {
        routes.push(adb::Connection {
            serial: info.serial.clone(),
            state: info.state.clone(),
            transport: info.transport.clone(),
            source: None,
            role: None,
            identity_verified: None,
        });
    }
    // An ungrouped phone may only use the exact observed route. Hardware identity
    // is required before a registered alternative can be used.
    routes
        .retain(|route| route.identity_verified != Some(false) || info.hardware_identity.is_some());
    if info.hardware_identity.is_none() {
        routes.retain(|route| route.serial == info.serial);
    }
    routes.sort_by_key(|route| {
        (
            route.state != "device",
            route.transport != "usb",
            route.role.as_deref() != Some("primary"),
        )
    });
    routes.dedup_by(|a, b| a.serial == b.serial);
    routes.truncate(8);
    routes
}

fn query(program: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let bytes = read_system_query(
        program.to_str().ok_or("ADB 路径无效")?,
        args,
        timeout,
        128 * 1024,
    )
    .map_err(|_| "连接检查超时或设备不可用".to_string())?;
    String::from_utf8(bytes).map_err(|_| "连接返回格式无效".into())
}

fn verify(program: &Path, route: &adb::Connection, expected: Option<&str>) -> Result<(), String> {
    // Re-list on every attempt, including after adb connect. Never use an
    // arbitrary serial or command supplied by the WebView.
    let list = query(program, &["devices", "-l"], Duration::from_secs(3))?;
    let mut rows = adb::parse(&list)?;
    let mut current = rows.iter().find(|row| {
        row.adb
            .as_ref()
            .is_some_and(|info| info.serial == route.serial)
    });
    if !current.is_some_and(|row| row.status == "connected")
        && expected.is_some()
        && toolkit_adb::is_tcp_endpoint(&route.serial)
        && route.state != "unauthorized"
    {
        let _ = query(program, &["connect", &route.serial], Duration::from_secs(3));
        rows = adb::parse(&query(program, &["devices", "-l"], Duration::from_secs(3))?)?;
        current = rows.iter().find(|row| {
            row.adb
                .as_ref()
                .is_some_and(|info| info.serial == route.serial)
        });
    }
    let current = current
        .and_then(|row| row.adb.as_ref())
        .ok_or("线路未连接，请检查手机无线调试或 USB")?;
    if current.state == "unauthorized" {
        return Err("请先在手机上确认调试授权".into());
    }
    if current.state != "device" {
        return Err("线路离线，请检查手机无线调试或 USB".into());
    }
    // Transport IDs pin this read to the freshly observed connection.
    let (flag, target) = current
        .transport_id
        .as_deref()
        .map_or(("-s", route.serial.as_str()), |id| ("-t", id));
    let identity = query(
        program,
        &[flag, target, "shell", "getprop", "ro.serialno"],
        Duration::from_secs(2),
    )?;
    let identity = identity.trim();
    if identity.is_empty() || identity.len() > 256 || identity.chars().any(char::is_control) {
        return Err("无法核对手机身份，请刷新设备后重试".into());
    }
    if expected.is_some_and(|expected| identity != expected) {
        return Err("线路设备身份不匹配，已跳过".into());
    }
    Ok(())
}

fn update(id: &str, generation: u64, reply: Reply) {
    if let Ok(mut jobs) = jobs().lock() {
        if let Some(job) = jobs.get_mut(id).filter(|job| job.generation == generation) {
            job.reply = reply;
        }
    }
}

fn args(id: &str, name: &str, serial: &str) -> Vec<String> {
    vec![
        format!("--serial={serial}"),
        format!("--window-title=FlowHub · {} [{id}]", crate::short(name, 60)),
        "--force-adb-forward".into(),
        "--max-size=1280".into(),
        "--max-fps=30".into(),
        "--video-bit-rate=2M".into(),
        "--no-audio".into(),
        "--stay-awake".into(),
    ]
}

#[derive(Default)]
struct Output {
    ready: bool,
    failure: Option<&'static str>,
}
fn inspect(output: &mut Output, line: &str) {
    if line.contains("Texture") {
        output.ready = true;
    }
    if line.contains("INJECT_EVENTS") || line.contains("Injecting input events requires") {
        output.failure = Some("画面已连接，但输入控制权限不足；请检查手机的 USB 调试（安全设置）");
    } else if line.contains("Device disconnected") {
        output.failure = Some("手机连接已断开，请重新投屏");
    } else if line.contains("Could not find any ADB device") || line.contains("Device not found") {
        output.failure = Some("投屏启动时线路已断开");
    } else if line.contains("ERROR:") && output.failure.is_none() {
        output.failure = Some("scrcpy 启动失败，请检查调试授权与连接状态");
    }
}
fn drain(reader: impl Read + Send + 'static, output: Arc<Mutex<Output>>) {
    thread::spawn(move || {
        // Never retain raw phone logs, clipboard data or unbounded lines.
        let mut reader = BufReader::new(reader);
        let mut line = Vec::new();
        let mut oversized = false;
        loop {
            let Ok(chunk) = reader.fill_buf() else {
                break;
            };
            if chunk.is_empty() {
                break;
            }
            let length = chunk
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(chunk.len(), |n| n + 1);
            let ended = chunk[length - 1] == b'\n';
            if !oversized && line.len() + length <= 8192 {
                line.extend_from_slice(&chunk[..length]);
            } else {
                oversized = true;
            }
            reader.consume(length);
            if ended {
                if !oversized {
                    if let Ok(mut out) = output.lock() {
                        inspect(&mut out, &String::from_utf8_lossy(&line));
                    }
                }
                line.clear();
                oversized = false;
            }
        }
    });
}
fn stop_child(child: &mut Child) {
    // Let scrcpy restore its temporary display settings and remove its own tunnel.
    let _ = Command::new("/bin/kill")
        .args(["-INT", &child.id().to_string()])
        .status();
    let until = Instant::now() + Duration::from_secs(2);
    while Instant::now() < until {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn terminal() -> Result<(File, File), String> {
    let mut master = -1;
    let mut slave = -1;
    // scrcpy/SDL flushes its video readiness log to a terminal. A pipe can hold
    // that message until exit, falsely timing out a functioning native window.
    if unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } != 0
    {
        return Err("无法建立投屏状态终端".into());
    }
    let (master, slave) = unsafe { (File::from_raw_fd(master), File::from_raw_fd(slave)) };
    for file in [&master, &slave] {
        use std::os::fd::AsRawFd;
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err("无法配置投屏状态终端".into());
        }
    }
    Ok((master, slave))
}

fn run(
    id: &str,
    name: &str,
    info: &adb::Info,
    generation: u64,
    stop: &AtomicBool,
    adb: &Path,
    scrcpy: &Path,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(45);
    let mut routes = candidates(info);
    if let Some(identity) = info.hardware_identity.as_deref() {
        for route in toolkit_adb::Catalog::load().mirror_routes(identity) {
            if !routes
                .iter()
                .any(|existing| existing.serial == route.serial)
                && routes.len() < 8
            {
                routes.push(route);
            }
        }
    }
    let mut errors = Vec::new();
    for route in routes {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            errors.push("检查线路已超时，请确认手机在线后重试".into());
            break;
        }
        let route_label = label(&route);
        update(
            id,
            generation,
            Reply {
                status: "connecting".into(),
                route: Some(route_label.clone()),
                error: None,
            },
        );
        if let Err(error) = verify(adb, &route, info.hardware_identity.as_deref()) {
            errors.push(format!("{route_label}：{error}"));
            continue;
        }
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        let (master, slave) = terminal()?;
        let stderr = slave.try_clone().map_err(|_| "无法配置投屏状态输出")?;
        let mut child = Command::new(scrcpy)
            .args(args(id, name, &route.serial))
            .env("ADB", adb)
            .stdin(Stdio::null())
            .stdout(slave)
            .stderr(stderr)
            .process_group(0)
            .spawn()
            .map_err(|_| "无法启动 scrcpy，请确认安装可用".to_string())?;
        let output = Arc::new(Mutex::new(Output::default()));
        drain(master, output.clone());
        let started = Instant::now();
        let mut shown = false;
        update(
            id,
            generation,
            Reply {
                status: "starting".into(),
                route: Some(route_label.clone()),
                error: None,
            },
        );
        loop {
            if stop.load(Ordering::Relaxed) {
                stop_child(&mut child);
                return Ok(());
            }
            let (ready, failure) = output
                .lock()
                .map(|out| (out.ready, out.failure))
                .unwrap_or_default();
            if ready && !shown {
                shown = true;
                update(
                    id,
                    generation,
                    Reply {
                        status: "running".into(),
                        route: Some(route_label.clone()),
                        error: failure.map(str::to_owned),
                    },
                );
            }
            let exited = match child.try_wait() {
                Ok(status) => status,
                Err(_) => {
                    stop_child(&mut child);
                    return Err("无法读取投屏进程状态".into());
                }
            };
            if let Some(status) = exited {
                // Once a video session is established, do not silently jump to
                // another route while the user is interacting with the phone.
                if shown {
                    return if status.success() {
                        Ok(())
                    } else {
                        Err(failure.unwrap_or("投屏连接已中断，请重新连接").into())
                    };
                }
                errors.push(format!(
                    "{route_label}：{}",
                    failure.unwrap_or("投屏窗口未能启动")
                ));
                break;
            }
            if !shown && (started.elapsed() > Duration::from_secs(15) || Instant::now() >= deadline)
            {
                stop_child(&mut child);
                errors.push(format!("{route_label}：等待视频超时"));
                break;
            }
            if shown && failure.is_some() {
                update(
                    id,
                    generation,
                    Reply {
                        status: "running".into(),
                        route: Some(route_label.clone()),
                        error: failure.map(str::to_owned),
                    },
                );
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    Err(if errors.is_empty() {
        "没有可用线路，请刷新设备后重试".into()
    } else {
        errors.join("；")
    })
}

pub(crate) fn request(device: &Device, action: &str) -> Result<Reply, String> {
    let info = device.adb.as_ref().ok_or("请选择 ADB 手机")?;
    let mut registry = jobs().lock().map_err(|_| "投屏状态暂不可用")?;
    let current = registry.get_mut(&device.id);
    if action == "status" {
        return Ok(current
            .map(|job| job.reply.clone())
            .unwrap_or_else(|| Reply {
                status: "idle".into(),
                ..Reply::default()
            }));
    }
    if action == "stop" {
        if let Some(job) = current.filter(|job| active(&job.reply)) {
            job.stop.store(true, Ordering::Relaxed);
            job.reply.status = "stopping".into();
            return Ok(job.reply.clone());
        }
        return Ok(Reply {
            status: "idle".into(),
            ..Reply::default()
        });
    }
    if action != "start" {
        return Err("未知投屏操作".into());
    }
    if let Some(job) = current.filter(|job| active(&job.reply)) {
        return Ok(job.reply.clone());
    }
    let adb = adb::find().ok_or("未找到 ADB，请先安装 Android SDK Platform-Tools")?;
    let scrcpy = adb::find_cli("scrcpy")
        .ok_or("未找到 scrcpy，请先在本机安装 scrcpy（brew install scrcpy）")?;
    if registry.values().filter(|job| active(&job.reply)).count() >= 8 {
        return Err("同时投屏已达 8 台，请先关闭一个窗口".into());
    }
    if registry.len() >= 32 {
        if let Some(oldest) = registry
            .iter()
            .filter(|(_, job)| !active(&job.reply))
            .min_by_key(|(_, job)| job.generation)
            .map(|(id, _)| id.clone())
        {
            registry.remove(&oldest);
        }
    }
    let generation = now();
    let stop = Arc::new(AtomicBool::new(false));
    let reply = Reply {
        status: "connecting".into(),
        ..Reply::default()
    };
    registry.insert(
        device.id.clone(),
        Job {
            generation,
            reply: reply.clone(),
            stop: stop.clone(),
        },
    );
    let id = device.id.clone();
    let name = info.shared_alias.as_ref().unwrap_or(&device.name).clone();
    let mut info = info.clone();
    if info.hardware_identity.is_none() {
        info.hardware_identity = toolkit_adb::Catalog::load().mirror_identity(&device.id);
    }
    if info.hardware_identity.is_none() {
        registry.remove(&device.id);
        return Err("尚未读取手机身份，请刷新设备后重试".into());
    }
    thread::Builder::new()
        .name("adb-mirror".into())
        .spawn(move || {
            let result = run(&id, &name, &info, generation, &stop, &adb, &scrcpy);
            update(
                &id,
                generation,
                Reply {
                    status: if result.is_ok() { "idle" } else { "failed" }.into(),
                    route: None,
                    error: result.err(),
                },
            );
        })
        .map_err(|_| {
            registry.remove(&device.id);
            "无法启动投屏连接任务".to_string()
        })?;
    Ok(reply)
}

pub(crate) fn control(id: &str, stop: bool) -> Result<Reply, String> {
    let mut registry = jobs().lock().map_err(|_| "投屏状态暂不可用")?;
    Ok(match registry.get_mut(id) {
        Some(job) => {
            if stop && active(&job.reply) {
                job.stop.store(true, Ordering::Relaxed);
                job.reply.status = "stopping".into();
            }
            job.reply.clone()
        }
        None => Reply {
            status: "idle".into(),
            ..Reply::default()
        },
    })
}

pub(crate) fn shutdown() {
    if let Ok(registry) = jobs().lock() {
        for job in registry.values() {
            job.stop.store(true, Ordering::Relaxed);
        }
    }
    // Workers poll every 100 ms; allow graceful tunnel/display cleanup at exit.
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
        if jobs()
            .lock()
            .is_ok_and(|jobs| jobs.values().all(|job| !active(&job.reply)))
        {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_terminal_delivers_readiness_while_the_child_is_still_running() {
        let (master, slave) = terminal().unwrap();
        let mut child = Command::new("/bin/sh")
            .args([
                "-c",
                "test -t 1 && printf 'INFO: Texture: 576x1280\\n'; exec sleep 5",
            ])
            .stdin(Stdio::null())
            .stdout(slave.try_clone().unwrap())
            .stderr(slave)
            .spawn()
            .unwrap();
        let output = Arc::new(Mutex::new(Output::default()));
        drain(master, output.clone());
        let deadline = Instant::now() + Duration::from_secs(1);
        while !output.lock().unwrap().ready && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(output.lock().unwrap().ready);
        assert!(child.try_wait().unwrap().is_none());
        stop_child(&mut child);
    }
    #[test]
    fn ranks_online_usb_then_primary_and_never_borrows_an_unverified_alternative() {
        let mut info: adb::Info = serde_json::from_value(
            json!({"serial":"net","state":"device","transport":"tcp","connections":[
            {"serial":"fallback","state":"device","transport":"tcp","role":"fallback"},
            {"serial":"primary","state":"device","transport":"tcp","role":"primary"},
            {"serial":"usb","state":"device","transport":"usb"},
            {"serial":"net","state":"offline","transport":"tcp"}]}),
        )
        .unwrap();
        assert_eq!(
            candidates(&info)
                .iter()
                .map(|r| r.serial.as_str())
                .collect::<Vec<_>>(),
            vec!["net"]
        );
        info.hardware_identity = Some("PHONE".into());
        assert_eq!(
            candidates(&info)
                .iter()
                .map(|r| r.serial.as_str())
                .collect::<Vec<_>>(),
            vec!["usb", "primary", "fallback", "net"]
        );
    }
    #[test]
    fn only_fixed_scrcpy_options_and_one_explicit_target_are_built() {
        let args = args("adb-test", "Phone\nname; $(touch nope)", "192.0.2.1:1234");
        assert!(args.contains(&"--force-adb-forward".into()));
        assert_eq!(
            args.iter()
                .filter(|arg| arg.starts_with("--serial="))
                .count(),
            1
        );
        assert!(!args
            .iter()
            .any(|arg| arg.contains('\n') || arg.starts_with("--record")));
    }
    #[test]
    fn readiness_requires_video_and_raw_logs_are_not_returned() {
        let mut out = Output::default();
        inspect(&mut out, "INFO: Device: Phone");
        assert!(!out.ready);
        inspect(&mut out, "INFO: Texture (VideoToolbox): 576x1280");
        assert!(out.ready);
        inspect(
            &mut out,
            "ERROR: Injecting input events requires INJECT_EVENTS",
        );
        assert!(out.failure.unwrap().contains("安全设置"));
    }

    #[test]
    fn fresh_transport_identity_must_match_before_a_window_can_be_launched() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("mirror-verify-{}-{}", std::process::id(), now()));
        std::fs::create_dir(&root).unwrap();
        let program = root.join("adb");
        std::fs::write(&program,"#!/bin/sh\nif [ \"$1\" = devices ]; then printf 'List of devices attached\\n192.0.2.1:1234 device model:Phone transport_id:7\\n'; elif [ \"$1\" = -t ] && [ \"$2\" = 7 ] && [ \"$3\" = shell ] && [ \"$4\" = getprop ] && [ \"$5\" = ro.serialno ]; then printf PHONE-A; else exit 9; fi\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let route = adb::Connection {
            serial: "192.0.2.1:1234".into(),
            state: "device".into(),
            transport: "tcp".into(),
            source: None,
            role: None,
            identity_verified: None,
        };
        assert!(verify(&program, &route, Some("PHONE-A")).is_ok());
        assert!(verify(&program, &route, Some("PHONE-B"))
            .unwrap_err()
            .contains("身份不匹配"));
        std::fs::write(&program,"#!/bin/sh\n[ \"$1\" = devices ] || exit 9\nprintf 'List of devices attached\\n192.0.2.1:1234 unauthorized\\n'\n").unwrap();
        assert!(verify(&program, &route, Some("PHONE-A"))
            .unwrap_err()
            .contains("调试授权"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repeated_start_reuses_the_selected_session_and_stop_does_not_touch_another_phone() {
        let selected = adb::parse("List of devices attached\nTEST-MIRROR device\n")
            .unwrap()
            .remove(0);
        let stop = Arc::new(AtomicBool::new(false));
        jobs().lock().unwrap().insert(
            selected.id.clone(),
            Job {
                generation: 1,
                stop: stop.clone(),
                reply: Reply {
                    status: "starting".into(),
                    ..Reply::default()
                },
            },
        );
        assert_eq!(request(&selected, "start").unwrap().status, "starting");
        assert!(!stop.load(Ordering::Relaxed));
        assert_eq!(control("adb-another-phone", true).unwrap().status, "idle");
        assert!(!stop.load(Ordering::Relaxed));
        assert_eq!(control(&selected.id, true).unwrap().status, "stopping");
        assert!(stop.load(Ordering::Relaxed));
        jobs().lock().unwrap().remove(&selected.id);
    }
}
