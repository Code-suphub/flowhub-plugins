//! Login policy is independent of the live process list and service bootout.
use crate::{
    model::Identity,
    native,
    services::{command, command_until},
};
use objc2::rc::autoreleasepool;
use objc2_app_kit::NSWorkspace;
use objc2_foundation::NSString;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    env, fs,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const MYSQL: &[&str] = &["mysql", "mysql@8.0", "mysql@8.4"];
const HOMEBREW_SERVICE_PREFIX: &str = "homebrew.mxcl.";
const ONEDRIVE: &str = "com.microsoft.OneDrive";
const ONEDRIVE_LAUNCHER: &str = "com.microsoft.OneDriveLauncher";
pub(crate) const VIVO_WATCH: &str = "com.vivo.control.watch";
const VIVO_WATCH_PROGRAM: &str = "/Applications/pcsuite.app/Contents/Resources/vivoControl/vivocontrol.app/Contents/Resources/depends/darwin/vivo_remote_watch";
const VIVO_AGENTS: &[(&str, &str, &str)] = &[
    (
        "com.vivo.pcsuite.ConnService",
        "com.vivo.pcsuite.VivoConnService",
        "vivo 连接服务",
    ),
    (
        "com.vivo.pcsuite.SyncService",
        "com.vivo.pcsuite.SyncService",
        "vivo 同步服务",
    ),
    (
        "com.vivo.pcsuite.toast",
        "com.vivo.pcsuite.toast",
        "vivo 通知服务",
    ),
    (
        "com.vivo.pcsuite.launcher",
        "com.vivo.pcsuite.launcher",
        "vivo 套件启动器",
    ),
    (
        "com.vivo.control.serviceAgentAqua",
        "com.vivo.control.serviceAgent",
        "vivo 用户远控服务",
    ),
    (
        "com.vivo.control.serviceAgentLogin",
        "com.vivo.control.serviceAgentLogin",
        "vivo 登录窗口远控服务",
    ),
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    id: String,
    name: String,
    kind: &'static str,
    state: &'static str,
    revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loaded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    keep_alive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop_revision: Option<String>,
    system: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    blocked_reason: Option<&'static str>,
}

struct StartupEntry {
    row: Row,
    running: Option<Identity>,
}

fn run(program: &str, args: &[&str]) -> Option<String> {
    String::from_utf8(command(
        program,
        args,
        Instant::now() + Duration::from_millis(600),
    )?)
    .ok()
}

fn launchctl(args: &[&str]) -> Option<String> {
    run("/bin/launchctl", args)
}

fn policies(text: &str) -> Option<HashMap<&str, bool>> {
    let mut lines = text
        .lines()
        .map(str::trim)
        .skip_while(|line| line.is_empty());
    if lines.next()? != "disabled services = {" {
        return None;
    }
    let mut result = HashMap::new();
    for line in lines {
        if line == "}" {
            return Some(result);
        }
        let (label, value) = line.strip_prefix('"')?.split_once("\" => ")?;
        let enabled = match value {
            "enabled" | "false" => true,
            "disabled" | "true" => false,
            _ => return None,
        };
        if result.insert(label, enabled).is_some() {
            return None;
        }
    }
    None
}

fn enabled_policy(domain: &str, label: &str) -> Option<bool> {
    let text = launchctl(&["print-disabled", domain])?;
    policies(&text)?.get(label).copied()
}

fn field<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.lines().find_map(|line| {
        let (name, value) = line.strip_prefix('\t')?.split_once(" = ")?;
        (name == key).then_some(value)
    })
}

fn listed(text: &str, label: &str) -> bool {
    text.lines()
        .any(|line| line.split_whitespace().nth(2) == Some(label))
}

fn database_kind(formula: &str) -> Option<(&'static str, &'static str)> {
    if MYSQL.contains(&formula) {
        return Some(("mysql", "MySQL"));
    }
    if formula == "postgresql"
        || formula.strip_prefix("postgresql@").is_some_and(|version| {
            (1..=2).contains(&version.len())
                && !version.starts_with('0')
                && version.bytes().all(|c| c.is_ascii_digit())
        })
    {
        return Some(("postgresql", "PostgreSQL"));
    }
    None
}

fn safe_database_program(formula: &str, program: &str) -> bool {
    let executables: &[&str] = match database_kind(formula) {
        Some(("mysql", _)) => &["bin/mysqld_safe", "bin/mysqld"],
        Some(("postgresql", _)) => &["bin/postgres"],
        _ => return false,
    };
    ["/opt/homebrew", "/usr/local"].iter().any(|prefix| {
        program
            .strip_prefix(&format!("{prefix}/opt/{formula}/"))
            .is_some_and(|executable| executables.contains(&executable))
            || program
                .strip_prefix(&format!("{prefix}/Cellar/{formula}/"))
                .is_some_and(|tail| {
                    tail.split_once('/').is_some_and(|(version, executable)| {
                        version.as_bytes().first().is_some_and(u8::is_ascii_digit)
                            && version
                                .bytes()
                                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
                            && executables.contains(&executable)
                    })
                })
    })
}

fn plist_bytes(path: &Path, uid: u32) -> Option<Vec<u8>> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.uid() != uid || metadata.mode() & 0o022 != 0 {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(64 * 1024 + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() <= 64 * 1024 && bytes.len() as u64 == metadata.len()).then_some(bytes)
}

fn read_plist(path: &Path, owner: u32) -> Option<(Value, Vec<u8>)> {
    if fs::canonicalize(path).ok()?.as_path() != path {
        return None;
    }
    let bytes = plist_bytes(path, owner)?;
    let plist = serde_json::from_str(&run(
        "/usr/bin/plutil",
        &["-convert", "json", "-o", "-", "--", path.to_str()?],
    )?)
    .ok()?;
    (plist_bytes(path, owner)? == bytes).then_some((plist, bytes))
}

fn policy_revision(domain: &str, path: &str, program: &str, enabled: bool, bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(domain.as_bytes());
    digest.update(path.as_bytes());
    digest.update(program.as_bytes());
    digest.update([u8::from(enabled)]);
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}

fn matches_job(text: &str, path: &str, program: &Path) -> bool {
    field(text, "path") == Some(path)
        && field(text, "program")
            .and_then(|p| fs::canonicalize(p).ok())
            .as_deref()
            == Some(program)
}

fn database_entry(
    home: &Path,
    domain: &str,
    formula: &str,
    uid: u32,
    flags: Option<&HashMap<&str, bool>>,
    jobs: Option<&str>,
) -> Option<StartupEntry> {
    let (kind, name) = database_kind(formula)?;
    let label = format!("{HOMEBREW_SERVICE_PREFIX}{formula}");
    let path = home
        .join("Library/LaunchAgents")
        .join(format!("{label}.plist"));
    let (plist, bytes) = read_plist(&path, uid)?;
    let path_str = path.to_str()?;
    if plist["Label"] != label
        || (plist["RunAtLoad"] != true && plist["KeepAlive"] != true)
        || (!plist["Disabled"].is_null() && !plist["Disabled"].is_boolean())
        || !plist["UserName"].is_null()
        || !plist["RootDirectory"].is_null()
    {
        return None;
    }
    let program = plist["Program"]
        .as_str()
        .or_else(|| plist["ProgramArguments"][0].as_str())?;
    if !safe_database_program(formula, program) {
        return None;
    }
    let canonical_program = fs::canonicalize(program).ok()?;
    let canonical_program_str = canonical_program.to_str()?;
    if !safe_database_program(formula, canonical_program_str) {
        return None;
    }

    let status = launchctl(&["print", &format!("{domain}/{label}")]);
    let running = status
        .as_deref()
        .and_then(|text| field(text, "pid"))
        .and_then(|pid| pid.parse().ok())
        .and_then(native::identity);
    let verified = match status.as_deref() {
        Some(text) => {
            matches_job(text, path_str, &canonical_program)
                && field(text, "pid").is_none_or(|_| {
                    running.as_ref().is_some_and(|p| {
                        p.uid == uid
                            && (kind != "postgresql" || p.executable == canonical_program_str)
                    })
                })
        }
        None => jobs.is_some_and(|text| !listed(text, &label)),
    };
    let enabled = flags.and_then(|flags| {
        flags
            .get(label.as_str())
            .copied()
            .or_else(|| status.is_some().then_some(plist["Disabled"] != true))
            .or_else(|| (plist["Disabled"] == true).then_some(false))
    });
    let state = if verified { enabled } else { None };
    let revision = state
        .map(|enabled| policy_revision(domain, path_str, canonical_program_str, enabled, &bytes));
    let stop_revision = if state == Some(false)
        && flags.and_then(|flags| flags.get(label.as_str())) == Some(&false)
        && status.is_some()
        && plist["AbandonProcessGroup"] != true
    {
        revision.as_ref().map(|revision| {
            let mut digest = Sha256::new();
            digest.update(revision.as_bytes());
            digest.update(serde_json::to_vec(&running).unwrap_or_default());
            format!("{:x}", digest.finalize())
        })
    } else {
        None
    };
    Some(StartupEntry {
        row: Row {
            id: label,
            name: formula.split_once('@').map_or_else(
                || name.to_owned(),
                |(_, version)| format!("{name} {version}"),
            ),
            kind,
            state: state_name(state),
            revision,
            loaded: verified.then_some(status.is_some()),
            keep_alive: (verified && status.is_some()).then(|| {
                status
                    .as_deref()
                    .and_then(|text| field(text, "properties"))
                    .is_some_and(|properties| properties.split(" | ").any(|p| p == "keepalive"))
            }),
            pid: running.as_ref().filter(|_| verified).map(|p| p.pid),
            stop_revision,
            system: false,
            blocked_reason: None,
        },
        running,
    })
}

fn state_name(state: Option<bool>) -> &'static str {
    match state {
        Some(true) => "enabled",
        Some(false) => "disabled",
        None => "unknown",
    }
}

fn vivo_program(label: &str, program: &str) -> bool {
    let suffix = match label {
        "com.vivo.pcsuite.ConnService" => {
            "/Contents/Resources/vivoesService/VivoConnService/VivoConnService"
        }
        "com.vivo.pcsuite.SyncService" => "/Contents/Resources/SyncService/VivoSyncService",
        "com.vivo.pcsuite.toast" => "/Contents/MacOS/mac_toast",
        "com.vivo.pcsuite.launcher" => return program == "/Library/Preferences/pcsuite/pcsuite_",
        "com.vivo.control.serviceAgentAqua" | "com.vivo.control.serviceAgentLogin" => {
            return ["/Contents/Macos/", "/Contents/MacOS/"].iter().any(|directory| {
                program == format!("/Applications/pcsuite.app/Contents/Resources/vivoControl/vivocontrol.app{directory}vivo_remote_service")
            });
        }
        VIVO_WATCH => return program == VIVO_WATCH_PROGRAM,
        _ => return false,
    };
    program == format!("/Applications/pcsuite.app{suffix}")
}

fn vivo_entry(
    domain: &str,
    label: &str,
    path: &Path,
    name: &str,
    flags: Option<&HashMap<&str, bool>>,
    jobs: Option<&str>,
) -> Option<StartupEntry> {
    let (plist, bytes) = read_plist(path, 0)?;
    let program = plist["Program"]
        .as_str()
        .or_else(|| plist["ProgramArguments"][0].as_str())?;
    if plist["Label"] != label
        || !vivo_program(label, program)
        || !plist["RootDirectory"].is_null()
        || (!plist["Disabled"].is_null() && !plist["Disabled"].is_boolean())
        || (!plist["UserName"].is_null() && (domain != "system" || plist["UserName"] != "root"))
        || (plist["RunAtLoad"] != true
            && plist["KeepAlive"] != true
            && !plist["KeepAlive"]
                .as_object()
                .is_some_and(|conditions| !conditions.is_empty()))
    {
        return None;
    }
    let canonical = fs::canonicalize(program).ok()?;
    let canonical_str = canonical.to_str()?;
    if !vivo_program(label, canonical_str) {
        return None;
    }
    let path_str = path.to_str()?;
    // A LoginWindow agent runs before the user session exists. A gui/<uid>
    // override would give a false success for that agent's actual domain.
    let login_window = label == "com.vivo.control.serviceAgentLogin";
    let status = (!login_window)
        .then(|| launchctl(&["print", &format!("{domain}/{label}")]))
        .flatten();
    let running = status
        .as_deref()
        .and_then(|text| field(text, "pid"))
        .and_then(|pid| pid.parse().ok())
        .and_then(native::identity);
    let verified = !login_window
        && status.as_deref().map_or_else(
            || jobs.is_some_and(|text| !listed(text, label)),
            |text| matches_job(text, path_str, &canonical),
        );
    let flag = flags.and_then(|flags| flags.get(label).copied());
    let state = if verified || (domain == "system" && status.is_none()) {
        flag.or_else(|| (verified && flags.is_some()).then_some(plist["Disabled"] != true))
    } else {
        None
    };
    let revision =
        state.map(|enabled| policy_revision(domain, path_str, canonical_str, enabled, &bytes));
    Some(StartupEntry {
        row: Row {
            id: label.into(),
            name: name.into(),
            kind: "vivo",
            state: state_name(state),
            revision,
            loaded: verified.then_some(status.is_some()),
            keep_alive: None,
            pid: None,
            stop_revision: None,
            system: domain == "system",
            blocked_reason: login_window
                .then_some("此服务在 macOS 登录窗口运行，当前用户会话无法配置。"),
        },
        running,
    })
}

fn bundle_id(bundle: &Path) -> Option<String> {
    let info = bundle.join("Contents/Info.plist");
    run(
        "/usr/bin/plutil",
        &[
            "-extract",
            "CFBundleIdentifier",
            "raw",
            "-o",
            "-",
            info.to_str()?,
        ],
    )
    .map(|id| id.trim().to_owned())
}

fn onedrive_entry(home: &Path, domain: &str, flags: Option<&HashMap<&str, bool>>) -> Option<Row> {
    let registered_app = autoreleasepool(|_| {
        let url = NSWorkspace::sharedWorkspace()
            .URLForApplicationWithBundleIdentifier(&NSString::from_str(ONEDRIVE))?;
        Some(PathBuf::from(url.path()?.to_string()))
    });
    let app = registered_app
        .into_iter()
        .chain([
            PathBuf::from("/Applications/OneDrive.app"),
            home.join("Applications/OneDrive.app"),
        ])
        .find(|app| app.is_dir() && bundle_id(app).as_deref() == Some(ONEDRIVE))?;
    let helper = app.join("Contents/Library/LoginItems/OneDrive Launcher.app");
    let registration = launchctl(&["print", &format!("{domain}/{ONEDRIVE_LAUNCHER}")]);
    let registered = registration
        .as_deref()
        .and_then(|text| field(text, "parent bundle identifier"))
        == Some(ONEDRIVE);
    let state = if registered
        || (registration.is_none() && bundle_id(&helper).as_deref() == Some(ONEDRIVE_LAUNCHER))
    {
        flags.and_then(|flags| {
            flags
                .get(ONEDRIVE_LAUNCHER)
                .copied()
                .or(registered.then_some(true))
        })
    } else {
        None
    };
    Some(Row {
        id: ONEDRIVE_LAUNCHER.into(),
        name: "OneDrive".into(),
        kind: "onedrive",
        state: state_name(state),
        revision: None,
        loaded: None,
        keep_alive: None,
        pid: None,
        stop_revision: None,
        system: false,
        blocked_reason: None,
    })
}

fn user_context() -> Result<(PathBuf, u32, String), String> {
    let uid = native::uid();
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("无法核验当前用户的登录项目录")?;
    if uid == 0 || unsafe { libc::getuid() } != uid {
        return Err("只能读取和管理当前登录用户的自启动".into());
    }
    Ok((home, uid, format!("gui/{uid}")))
}

pub fn snapshot() -> Result<Value, String> {
    let (home, uid, domain) = user_context()?;
    let status = launchctl(&["print-disabled", &domain]);
    let flags = status.as_deref().and_then(policies);
    let jobs = launchctl(&["list"]);
    let mut formulas: Vec<_> = fs::read_dir(home.join("Library/LaunchAgents"))
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let file = entry.ok()?.file_name().into_string().ok()?;
            database_formula(file.strip_suffix(".plist")?).map(str::to_owned)
        })
        .collect();
    formulas.sort_unstable();
    let mut rows: Vec<Row> = formulas
        .iter()
        .filter_map(|formula| {
            database_entry(
                &home,
                &domain,
                formula,
                uid,
                flags.as_ref(),
                jobs.as_deref(),
            )
            .map(|entry| entry.row)
        })
        .collect();
    rows.extend(onedrive_entry(&home, &domain, flags.as_ref()));
    rows.extend(VIVO_AGENTS.iter().filter_map(|(label, file, name)| {
        let path = PathBuf::from(format!("/Library/LaunchAgents/{file}.plist"));
        vivo_entry(&domain, label, &path, name, flags.as_ref(), jobs.as_deref())
            .map(|entry| entry.row)
    }));
    let system = launchctl(&["print-disabled", "system"]);
    rows.extend(
        vivo_entry(
            "system",
            VIVO_WATCH,
            Path::new("/Library/LaunchDaemons/com.vivo.control.watch.plist"),
            "vivo 远控守护服务",
            system.as_deref().and_then(policies).as_ref(),
            None,
        )
        .map(|entry| entry.row),
    );
    Ok(json!({"rows":rows}))
}

pub fn set(params: &Value) -> Result<Value, String> {
    if params["confirmed"] != true {
        return Err("请确认自启动设置变更".into());
    }
    let id = params["id"].as_str().ok_or("自启动服务标识无效")?;
    let enabled = params["enabled"].as_bool().ok_or("自启动设置无效")?;
    let revision = revision_param(params)?;
    if id == VIVO_WATCH {
        return native::service_request("vivo_startup_set", params);
    }
    let (home, uid, domain) = user_context()?;
    let status = launchctl(&["print-disabled", &domain]);
    let flags = status.as_deref().and_then(policies);
    let jobs = launchctl(&["list"]);
    let entry = if let Some(formula) = database_formula(id) {
        database_entry(
            &home,
            &domain,
            formula,
            uid,
            flags.as_ref(),
            jobs.as_deref(),
        )
    } else if let Some((label, file, name)) = VIVO_AGENTS.iter().find(|(label, _, _)| *label == id)
    {
        let path = PathBuf::from(format!("/Library/LaunchAgents/{file}.plist"));
        vivo_entry(&domain, label, &path, name, flags.as_ref(), jobs.as_deref())
    } else {
        return Err("只能设置已核验的 Homebrew 数据库或 vivo 服务".into());
    }
    .filter(|entry| {
        entry.row.revision.as_deref() == Some(revision)
            && entry.row.state == state_name(Some(!enabled))
    })
    .ok_or("自启动状态或服务配置已变化，请刷新后重新确认")?;
    let target = format!("{domain}/{}", entry.row.id);
    let action = if enabled { "enable" } else { "disable" };
    // This changes the persistent launchd override only. Never bootout,
    // bootstrap or signal a process from this operation.
    let _ = launchctl(&[action, &target]);
    if enabled_policy(&domain, &entry.row.id) != Some(enabled) {
        return Err("自启动设置结果尚未确认，请刷新核实后再决定是否重试".into());
    }
    let process_changed = entry
        .running
        .is_some_and(|before| native::identity(before.pid).as_ref() != Some(&before));
    Ok(json!({"enabled":enabled,"processChanged":process_changed}))
}

fn database_formula(id: &str) -> Option<&str> {
    id.strip_prefix(HOMEBREW_SERVICE_PREFIX)
        .filter(|formula| database_kind(formula).is_some())
}

fn revision_param(params: &Value) -> Result<&str, String> {
    params["revision"]
        .as_str()
        .filter(|text| text.len() == 64 && text.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| "请刷新自启动状态".into())
}

fn database_processes(parent: &Identity, formula: &str) -> Option<Vec<Identity>> {
    let processes = run("/bin/ps", &["-axo", "pid=,ppid="])?;
    let mut targets = vec![parent.clone()];
    targets.extend(processes.lines().filter_map(|line| {
        let mut fields = line.split_whitespace();
        let pid = fields.next()?.parse().ok()?;
        let ppid: i32 = fields.next()?.parse().ok()?;
        if ppid != parent.pid {
            return None;
        }
        let child = native::identity(pid)?;
        (child.uid == parent.uid
            && safe_database_program(formula, &child.executable)
            && native::parent_matches(&child, parent))
        .then_some(child)
    }));
    Some(targets)
}

pub fn stop(params: &Value) -> Result<Value, String> {
    if params["confirmed"] != true {
        return Err("请确认停止数据库后台服务".into());
    }
    let id = params["id"].as_str().ok_or("服务标识无效")?;
    let formula = database_formula(id).ok_or("此入口仅支持已关闭自启动的 Homebrew 数据库")?;
    let revision = revision_param(params)?;
    let (home, uid, domain) = user_context()?;
    let status = launchctl(&["print-disabled", &domain]);
    let flags = status.as_deref().and_then(policies);
    let jobs = launchctl(&["list"]);
    let entry = database_entry(
        &home,
        &domain,
        formula,
        uid,
        flags.as_ref(),
        jobs.as_deref(),
    )
    .filter(|entry| entry.row.stop_revision.as_deref() == Some(revision))
    .ok_or("服务登记、进程身份或自启动策略已变化，请刷新后重新确认")?;
    let targets = match entry.running {
        Some(ref parent) => database_processes(parent, formula).ok_or("无法核验当前服务进程")?,
        None => Vec::new(),
    };
    if targets
        .iter()
        .any(|id| native::identity(id.pid).as_ref() != Some(id))
        || enabled_policy(&domain, id) != Some(false)
    {
        return Err("服务进程或自启动策略已变化，请刷新后重新确认".into());
    }
    let target = format!("{domain}/{id}");
    // bootout can return while the database is still shutting down. Verify the
    // service and original processes within one budget before reporting.
    let deadline = Instant::now() + Duration::from_secs(16);
    let _ = command_until(
        "/bin/launchctl",
        &["bootout", &target],
        Instant::now() + Duration::from_secs(10),
    );
    loop {
        let unloaded = launchctl(&["list"]).is_some_and(|jobs| !listed(&jobs, id));
        let gone = targets.iter().all(|id| native::exited(id));
        if unloaded && gone && enabled_policy(&domain, id) == Some(false) {
            return Ok(json!({"ok":true}));
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("数据库停止结果尚未确认，请刷新核对服务登记和进程状态。不会自动重试。".into())
}

pub fn open_settings() -> Result<Value, String> {
    run(
        "/usr/bin/open",
        &["x-apple.systempreferences:com.apple.LoginItems-Settings.extension"],
    )
    .ok_or("无法打开登录项设置，请在系统设置的“通用”中打开“登录项与扩展”")?;
    Ok(json!({"ok":true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launchctl_status_requires_an_explicit_complete_map() {
        let text = "\n\tdisabled services = {\n\t\t\"homebrew.mxcl.mysql\" => disabled\n\t\t\"com.microsoft.OneDriveLauncher\" => false\n\t}";
        let flags = policies(text).unwrap();
        assert_eq!(flags.get("homebrew.mxcl.mysql"), Some(&false));
        assert_eq!(flags.get(ONEDRIVE_LAUNCHER), Some(&true));
        assert_eq!(flags.get("homebrew.mxcl.mysql@8.4"), None);
        assert!(policies(&text[..text.len() - 1]).is_none());
    }

    #[test]
    fn rejects_unscoped_mutations_before_querying_the_machine() {
        assert!(safe_database_program(
            "mysql",
            "/opt/homebrew/Cellar/mysql/9.5.0/bin/mysqld_safe"
        ));
        assert!(!safe_database_program(
            "mysql",
            "/opt/homebrew/Cellar/mysql/../bin/mysqld_safe"
        ));
        assert!(!safe_database_program(
            "mysql",
            "/usr/local/opt/mysql/bin/redis"
        ));
        for id in [
            ONEDRIVE_LAUNCHER,
            "homebrew.mxcl.redis",
            "../../homebrew.mxcl.mysql",
            "homebrew.mxcl.postgresql@14/../../postgresql@14",
        ] {
            assert!(stop(&json!({"id":id,"confirmed":true}))
                .unwrap_err()
                .contains("Homebrew 数据库"));
        }
        assert!(set(&json!({"id":"homebrew.mxcl.mysql","confirmed":false}))
            .unwrap_err()
            .contains("确认"));
    }

    #[test]
    fn homebrew_postgres_program_must_match_its_formula() {
        assert_eq!(
            database_formula("homebrew.mxcl.postgresql@14"),
            Some("postgresql@14")
        );
        assert!(safe_database_program(
            "postgresql@14",
            "/opt/homebrew/opt/postgresql@14/bin/postgres"
        ));
        assert!(safe_database_program(
            "postgresql@14",
            "/usr/local/Cellar/postgresql@14/14.19/bin/postgres"
        ));
        assert!(!safe_database_program(
            "postgresql@14",
            "/opt/homebrew/Cellar/postgresql@15/15.1/bin/postgres"
        ));
        assert!(!safe_database_program(
            "postgresql@14",
            "/opt/homebrew/opt/postgresql@14/bin/pg_ctl"
        ));
    }
}
