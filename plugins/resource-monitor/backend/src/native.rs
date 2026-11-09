//! macOS libproc sampling: no shell, no full command lines or environment in RPC/logs.
use crate::model::{Identity, Process};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    ffi::CStr,
    io::{Read, Write},
    mem::{size_of, zeroed},
    sync::OnceLock,
    os::{fd::AsRawFd, unix::net::UnixStream},
    time::Duration,
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrivilegedProcess {
    pid: i32,
    uid: u32,
    started: u64,
    executable: String,
    ppid: i32,
    memory: Option<u64>,
    footprint: Option<u64>,
    cpu_time: u64,
    #[serde(default)]
    control_eligible: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all="camelCase")]
struct PrivilegedSnapshot {processes:Vec<PrivilegedProcess>,#[serde(default)] control_allowed:bool,at:Option<u64>}

fn privileged_processes() -> Result<PrivilegedSnapshot, &'static str> {
    let mut stream = UnixStream::connect("/var/run/cn.ac.camellia.flowhub.resource-monitor.sock").map_err(|error|if error.kind()==std::io::ErrorKind::NotFound {"not_installed"} else {"connect_failed"})?;
    let mut peer_uid = 0;
    let mut peer_gid = 0;
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut peer_uid, &mut peer_gid) } != 0 || peer_uid != 0 {
        return Err("untrusted_peer");
    }
    stream.set_read_timeout(Some(Duration::from_secs(2))).map_err(|_|"configure_failed")?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).map_err(|_|"configure_failed")?;
    stream.write_all(b"{\"method\":\"snapshot\"}\n").map_err(|_|"write_failed")?;
    let mut response = String::new();
    stream
        .take(4 * 1024 * 1024 + 1)
        .read_to_string(&mut response)
        .map_err(|error|match error.kind(){std::io::ErrorKind::TimedOut|std::io::ErrorKind::WouldBlock=>"read_timeout",_=>"read_failed"})?;
    if response.len()>4*1024*1024{return Err("response_too_large");}
    let value: serde_json::Value = serde_json::from_str(&response).map_err(|_|"invalid_json")?;
    let snapshot:PrivilegedSnapshot=serde_json::from_value(value).map_err(|_|"invalid_processes")?;
    if snapshot.at.is_some_and(|at|at==0||crate::now().saturating_sub(at)>10_000){return Err("stale_snapshot");}
    Ok(snapshot)
}

fn merge_privileged(result: &mut Vec<Process>, own_uid: u32) {
    let started=std::time::Instant::now();
    let records=privileged_processes();
    crate::diagnostics::helper(records.as_ref().map(|s|s.processes.len()).map_err(|code|*code),started.elapsed().as_millis() as u64);
    let Ok(records) = records else {
        return;
    };
    let allow_control=records.control_allowed;
    for record in records.processes {
        if record.pid <= 0 || record.executable.is_empty() || record.started == 0 {
            continue;
        }
        if let Some(process) = result.iter_mut().find(|process| process.identity.pid == record.pid) {
            if process.identity.executable != record.executable
                || (process.identity.started != 0 && process.identity.started != record.started)
            {
                continue;
            }
            process.identity.uid = record.uid;
            process.identity.started = record.started;
            process.ppid = record.ppid;
            process.memory = record.memory;
            process.footprint = record.footprint;
            process.cpu_time = record.cpu_time;
            process.role = "进程".into();
            process.attribution = "特权采集 · 可执行路径校验".into();
            if record.uid != own_uid {
                let protection=privileged_protection(record.uid,&record.executable,allow_control,record.control_eligible);
                // Root authorization never removes host/core-process safeguards.
                if process.protection!="FlowHub 及其宿主进程"&&process.protection!="系统进程" {
                    process.protected=!protection.is_empty();process.protection=protection.into();
                }
            }
        } else if record.uid != own_uid && pid_path(record.pid).as_deref() == Some(&record.executable) {
            // Include inaccessible other-user processes only after the root sampler and
            // this process both report the same executable for the PID.
            result.push(Process {
                identity: Identity {
                    pid: record.pid,
                    started: record.started,
                    executable: record.executable.clone(),
                    uid: record.uid,
                },
                ppid: record.ppid,
                responsible: None,
                terminal_owner: None,
                process_group: 0,
                terminal_job: false,
                registered_app_path: None,
                runtime_project: None,
                name: record.executable.rsplit('/').next().unwrap_or(&record.executable).into(),
                display_name: None,
                launch_executable: None,
                memory: record.memory,
                footprint: record.footprint,
                cpu: None,
                cwd: String::new(),
                role: "进程".into(),
                avd: String::new(),
                protected: !privileged_protection(record.uid,&record.executable,allow_control,record.control_eligible).is_empty(),
                protection: privileged_protection(record.uid,&record.executable,allow_control,record.control_eligible).into(),
                parent_name: String::new(),
                group_id: String::new(),
                instance_id: String::new(),
                attribution: "特权采集 · 可执行路径校验".into(),
                cpu_time: record.cpu_time,
            });
        }
    }
}

fn privileged_protection(uid:u32,path:&str,allowed:bool,eligible:bool)->&'static str {
    if uid!=0 {return "其他用户进程，不在授权操作范围内";}
    if path.starts_with("/System/")||path.starts_with("/usr/libexec/")||path.starts_with("/usr/sbin/")||path.starts_with("/sbin/")||path.starts_with("/bin/")||path.starts_with("/usr/bin/")||path.contains("/FlowHub.app/")||path.contains("/cn.ac.camellia.flowhub.resource-monitor/") {return "系统或宿主进程，禁止结束";}
    if !allowed {return "root 进程控制尚未授权：请升级进程服务";}
    if !eligible {return "此 root 进程受保护或不在可操作范围内";}
    ""
}
pub fn terminate_privileged(targets:&[Identity],force:bool)->Result<Vec<Value>,String> {
    if targets.is_empty(){return Ok(vec![]);}
    let mut stream=UnixStream::connect("/var/run/cn.ac.camellia.flowhub.resource-monitor.sock").map_err(|_|"进程服务未连接，请刷新核实授权状态")?;
    let (mut peer_uid,mut peer_gid)=(0,0);
    if unsafe{libc::getpeereid(stream.as_raw_fd(),&mut peer_uid,&mut peer_gid)}!=0||peer_uid!=0 {return Err("进程服务身份校验失败".into());}
    stream.set_read_timeout(Some(Duration::from_secs(5))).map_err(|_|"无法配置进程服务连接")?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).map_err(|_|"无法配置进程服务连接")?;
    let request=json!({"method":"terminate","targets":targets,"force":force,"confirmed":true}).to_string()+"\n";
    stream.write_all(request.as_bytes()).map_err(|_|"结束请求未确认，请刷新核实状态；不会自动重试")?;
    let mut response=String::new();stream.take(65537).read_to_string(&mut response).map_err(|_|"结束请求未确认，请刷新核实状态；不会自动重试")?;
    if response.len()>65536{return Err("进程服务回复过大，请刷新核实状态".into());}
    let value:Value=serde_json::from_str(&response).map_err(|_|"结束结果无法读取，请刷新核实状态")?;
    if let Some(error)=value["error"].as_str(){return Err(error.chars().take(250).collect());}
    let results=value["results"].as_array().ok_or("进程服务未返回结束结果")?;
    if results.len()!=targets.len()||results.iter().zip(targets).any(|(r,t)|r["pid"]!=t.pid){return Err("进程服务返回的目标不匹配，请刷新核实状态".into());}
    Ok(results.clone())
}

pub fn uid() -> u32 {
    unsafe { libc::geteuid() }
}

pub fn service_request(method:&str,params:&Value)->Result<Value,String> {
    let mut request=json!({"method":method});
    match method {
        "services_snapshot"=>{},
        "service_preview"=>{
            let id=params["id"].as_str().filter(|s|s.len()==64&&s.bytes().all(|c|c.is_ascii_hexdigit())).ok_or("服务标识无效")?;
            let action=params["action"].as_str().filter(|s|matches!(*s,"stop"|"resume")).ok_or("服务操作无效")?;
            request["id"]=json!(id);request["action"]=json!(action);
        },
        "service_confirm"=>{
            let token=params["token"].as_str().filter(|s|uuid::Uuid::parse_str(s).is_ok()).ok_or("服务确认无效")?;
            if params["confirmed"]!=true{return Err("请明确确认后台服务操作".into());}
            request["token"]=json!(token);request["confirmed"]=json!(true);
        },
        "vivo_startup_set"=>{
            if params["id"]!=crate::startup::VIVO_WATCH||params["confirmed"]!=true{return Err("请确认所选 vivo 远控守护服务".into());}
            let revision=params["revision"].as_str().filter(|s|s.len()==64&&s.bytes().all(|c|c.is_ascii_hexdigit())).ok_or("请刷新 vivo 自启动状态")?;
            let enabled=params["enabled"].as_bool().ok_or("自启动设置无效")?;
            request["id"]=json!(crate::startup::VIVO_WATCH);request["revision"]=json!(revision);request["enabled"]=json!(enabled);request["confirmed"]=json!(true);
        },
        _=>return Err("不支持的后台服务操作".into()),
    }
    let mut stream=UnixStream::connect("/var/run/cn.ac.camellia.flowhub.resource-monitor.sock").map_err(|_|"后台服务管理需要连接系统采集服务，请检查授权")?;
    let(mut peer_uid,mut peer_gid)=(0,0);
    if unsafe{libc::getpeereid(stream.as_raw_fd(),&mut peer_uid,&mut peer_gid)}!=0||peer_uid!=0{return Err("系统采集服务身份校验失败".into());}
    stream.set_read_timeout(Some(Duration::from_secs(12))).map_err(|_|"无法配置服务连接")?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).map_err(|_|"无法配置服务连接")?;
    stream.write_all((request.to_string()+"\n").as_bytes()).map_err(|_|"服务请求结果尚未确认，请刷新核实状态")?;
    let mut text=String::new();stream.take(1024*1024+1).read_to_string(&mut text).map_err(|_|"服务请求结果尚未确认，请刷新核实状态；不会自动重试")?;
    if text.len()>1024*1024{return Err("后台服务回复过大，请稍后重试".into());}
    let value:Value=serde_json::from_str(&text).map_err(|_|"后台服务回复无法读取")?;
    if let Some(error)=value["error"].as_str(){return Err(if error=="不支持的请求" {"后台服务管理需要授权升级系统采集服务。".into()} else {error.chars().take(300).collect()});}
    Ok(value)
}

type ResponsiblePid = unsafe extern "C" fn(i32) -> i32;
fn responsibility_lookup() -> Option<ResponsiblePid> {
    static LOOKUP: OnceLock<Option<ResponsiblePid>> = OnceLock::new();
    *LOOKUP.get_or_init(|| unsafe {
        // Optional macOS SPI also used by Chromium. Missing support leaves the
        // process unattributed; it must never prevent sampling on another OS version.
        let symbol = libc::dlsym(libc::RTLD_DEFAULT, b"responsibility_get_pid_responsible_for_pid\0".as_ptr().cast());
        (!symbol.is_null()).then(|| std::mem::transmute::<*mut libc::c_void, ResponsiblePid>(symbol))
    })
}

pub fn responsibility_owner(target: &Identity) -> Option<Identity> {
    if target.uid!=uid() || target.started==0 || identity(target.pid).as_ref()!=Some(target) {return None;}
    let lookup=responsibility_lookup()?;
    let pid=unsafe {lookup(target.pid)};
    if pid<=1 || pid==target.pid {return None;}
    let owner=identity(pid)?;
    if owner.uid!=target.uid || owner.started==0 || owner.started>target.started
        || identity(target.pid).as_ref()!=Some(target) || identity(pid).as_ref()!=Some(&owner)
        || unsafe {lookup(target.pid)}!=pid {return None;}
    Some(owner)
}

pub fn parent_matches(child: &Identity, parent: &Identity) -> bool {
    let Some(bsd)=info::<libc::proc_bsdinfo>(child.pid,libc::PROC_PIDTBSDINFO) else {return false;};
    bsd.pbi_ppid as i32==parent.pid && identity(child.pid).as_ref()==Some(child)
        && identity(parent.pid).as_ref()==Some(parent)
}

fn webkit_responsibility(processes: &mut [Process], own_uid: u32) {
    let Some(lookup)=responsibility_lookup() else {return;};
    let identities: std::collections::HashMap<_, _> = processes.iter().map(|p| (p.identity.pid, p.identity.clone())).collect();
    for process in processes {
        if process.identity.uid != own_uid || !process.identity.executable.contains("/WebKit.framework/")
            || !process.name.starts_with("com.apple.WebKit.") { continue; }
        let pid = unsafe { lookup(process.identity.pid) };
        let Some(owner) = identities.get(&pid).filter(|owner| owner.pid != process.identity.pid && owner.uid == own_uid
            && crate::model::app_bundle(&owner.executable).is_some()) else { continue; };
        // Both identities and the responsibility link must still agree after lookup.
        if identity(process.identity.pid).as_ref() != Some(&process.identity)
            || identity(pid).as_ref() != Some(owner) || unsafe { lookup(process.identity.pid) } != pid { continue; }
        process.responsible = Some(owner.clone());
        process.role = if process.name.ends_with("WebContent") { "网页渲染" }
            else if process.name.ends_with("Networking") { "网页网络服务" }
            else if process.name.ends_with("GPU") { "网页图形服务" } else { "WebKit 辅助进程" }.into();
    }
}

fn text(chars: &[libc::c_char]) -> String {
    let bytes: Vec<u8> = chars
        .iter()
        .take_while(|c| **c != 0)
        .map(|c| *c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn info<T>(pid: i32, flavor: i32) -> Option<T> {
    // libproc writes a C structure of exactly the caller-provided size.
    let mut result: T = unsafe { zeroed() };
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            flavor,
            0,
            (&mut result as *mut T).cast(),
            size_of::<T>() as i32,
        )
    };
    (read == size_of::<T>() as i32).then_some(result)
}

pub fn identity(pid: i32) -> Option<Identity> {
    let bsd: libc::proc_bsdinfo = info(pid, libc::PROC_PIDTBSDINFO)?;
    let executable = pid_path(pid).unwrap_or_default();
    Some(Identity {
        pid,
        uid: bsd.pbi_uid,
        started: bsd.pbi_start_tvsec.saturating_mul(1_000_000) + bsd.pbi_start_tvusec,
        executable,
    })
}

pub fn exited(target: &Identity) -> bool {
    info::<libc::proc_bsdinfo>(target.pid, libc::PROC_PIDTBSDINFO).is_none_or(|bsd|
        bsd.pbi_status == libc::SZOMB || bsd.pbi_uid != target.uid
        || bsd.pbi_start_tvsec.saturating_mul(1_000_000)+bsd.pbi_start_tvusec != target.started)
}

fn pid_path(pid: i32) -> Option<String> {
    let mut path = [0_i8; 4096];
    let length = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    (length > 0).then(|| text(&path))
}

fn cwd(pid: i32) -> String {
    let Some(paths) = info::<libc::proc_vnodepathinfo>(pid, libc::PROC_PIDVNODEPATHINFO) else {
        return String::new();
    };
    let flat: Vec<_> = paths.pvi_cdir.vip_path.iter().flatten().copied().collect();
    text(&flat)
}

fn footprint(pid: i32) -> Option<u64> {
    let mut usage: libc::rusage_info_v2 = unsafe { zeroed() };
    // libproc's ABI takes the address of the output structure, not a pointer allocation.
    let ok = unsafe {
        libc::proc_pid_rusage(
            pid,
            libc::RUSAGE_INFO_V2,
            (&mut usage as *mut libc::rusage_info_v2).cast(),
        )
    };
    (ok == 0).then_some(usage.ri_phys_footprint)
}

// Private read-only SPI used by loginwindow's low-memory panel. Optional and
// confined to reference metadata; unavailable layouts never become zero usage.
#[repr(C)]
#[derive(Default)]
struct CoalitionIds { ids:[u64;2], reserved:[u64;3] }
#[repr(C)]
struct CoalitionUsage { prefix:[u64;40], phys_footprint:u64, suffix:[u64;3] }
const _:()={assert!(size_of::<CoalitionIds>()==40);assert!(size_of::<CoalitionUsage>()==352);assert!(std::mem::offset_of!(CoalitionUsage,phys_footprint)==320);};
type CoalitionUsageFn=unsafe extern "C" fn(u64,*mut CoalitionUsage,usize)->i32;
pub fn resource_accounting(id:&Identity)->Option<(u64,u64)> {
    static LOOKUP:OnceLock<Option<CoalitionUsageFn>>=OnceLock::new();
    let read=(*LOOKUP.get_or_init(||unsafe {
        let symbol=libc::dlsym(libc::RTLD_DEFAULT,c"coalition_info_resource_usage".as_ptr());
        if symbol.is_null(){None}else{Some(std::mem::transmute::<*mut libc::c_void,CoalitionUsageFn>(symbol))}
    }))?;
    if identity(id.pid).as_ref()!=Some(id){return None;}
    let coal:CoalitionIds=info(id.pid,20)?;
    if coal.ids[0]==0{return None;}
    let mut usage=CoalitionUsage{prefix:[0;40],phys_footprint:u64::MAX,suffix:[0;3]};
    if unsafe {read(coal.ids[0],&mut usage,size_of::<CoalitionUsage>())}!=0||usage.phys_footprint==u64::MAX||usage.prefix[23]!=7{return None;}
    if identity(id.pid).as_ref()!=Some(id)||info::<CoalitionIds>(id.pid,20)?.ids[0]!=coal.ids[0]{return None;}
    Some((coal.ids[0],usage.phys_footprint))
}

fn process_arguments(pid: i32) -> Option<Vec<u8>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut data = vec![0_u8; 256 * 1024];
    let mut length = data.len();
    let ok = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            data.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if ok != 0 || length < 5 {
        return None;
    }
    data.truncate(length);
    Some(data)
}

fn argument_sections(data: &[u8]) -> Option<(Vec<&[u8]>, &[u8])> {
    let argc = i32::from_ne_bytes(data.get(..4)?.try_into().ok()?);
    if !(0..=4096).contains(&argc) {
        return None;
    }
    let end = data.get(4..)?.iter().position(|b| *b == 0)?;
    let mut offset = end + 5;
    while offset < data.len() && data[offset] == 0 {
        offset += 1;
    }
    let mut args = Vec::new();
    for _ in 0..argc {
        let length = data.get(offset..)?.iter().position(|b| *b == 0)?;
        args.push(&data[offset..offset + length]);
        offset += length + 1;
    }
    Some((args, data.get(offset..)?))
}

fn initial_executable(data: &[u8]) -> Option<String> {
    // KERN_PROCARGS2 puts the executable path before argv. Do not use argv[0],
    // which callers can choose, or retain any arguments/environment as evidence.
    let argc = i32::from_ne_bytes(data.get(..4)?.try_into().ok()?);
    if !(0..=4096).contains(&argc) { return None; }
    let bytes = data.get(4..)?;
    let end = bytes.iter().position(|byte| *byte == 0)?;
    if end == 0 || end > 4096 { return None; }
    let value = std::str::from_utf8(&bytes[..end]).ok()?;
    if !value.starts_with('/') || value.chars().any(char::is_control) { return None; }
    Some(value.into())
}

pub fn launch_executable(target: &Identity) -> Option<String> {
    if target.uid != uid() || target.started == 0 || !target.executable.is_empty()
        || identity(target.pid).as_ref() != Some(target) { return None; }
    let mut data = process_arguments(target.pid)?;
    let path = initial_executable(&data);
    data.fill(0);
    if identity(target.pid).as_ref() != Some(target) { return None; }
    path
}

fn thread_from_arguments(data: &[u8]) -> Option<String> {
    let (_, environment) = argument_sections(data)?;
    let mut values = environment
        .split(|b| *b == 0)
        .filter_map(|item| item.strip_prefix(b"CODEX_THREAD_ID="));
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    let value = std::str::from_utf8(value).ok()?;
    uuid::Uuid::parse_str(value).ok().map(|id| id.to_string())
}

/// Explicit context reads only: retain one UUID from same-user Codex descendants.
/// Full argv/environment never leaves this function and the temporary buffer is cleared.
pub fn codex_thread(target: &Identity) -> Result<Option<String>, ()> {
    if target.uid != uid() || identity(target.pid).as_ref() != Some(target) {
        return Err(());
    }
    let mut data = process_arguments(target.pid).ok_or(())?;
    let thread = thread_from_arguments(&data);
    data.fill(0);
    if identity(target.pid).as_ref() != Some(target) {
        return Err(());
    }
    Ok(thread)
}

fn node_entry_argument(arguments: &[&[u8]]) -> Option<String> {
    let mut index = 1;
    while index < arguments.len() {
        let value = std::str::from_utf8(arguments[index]).ok()?;
        if matches!(value, "-e" | "--eval" | "-p" | "--print")
            || value.starts_with("--eval=") || value.starts_with("--print=") {
            return None; // Inline source is never retained or interpreted.
        }
        if matches!(value, "-r" | "--require" | "--import" | "--loader" | "--experimental-loader" | "--conditions" | "--title" | "--env-file" | "--inspect-port") {
            index += 2;
            continue;
        }
        if value == "--" { index += 1; break; }
        if value.starts_with('-') {
            if value.contains('=') || matches!(value, "--no-warnings" | "--no-deprecation" | "--trace-warnings" | "--enable-source-maps" | "--inspect" | "--inspect-brk" | "--experimental-strip-types" | "--experimental-vm-modules") {
                index += 1; continue;
            }
            return None; // Unknown flags may consume a value; do not guess.
        }
        break;
    }
    let entry = std::str::from_utf8(*arguments.get(index)?).ok()?;
    let entry = entry.strip_prefix("file://").unwrap_or(entry);
    if entry.is_empty() || entry.len() > 4096 || entry.starts_with('-') || entry.chars().any(char::is_control) { return None; }
    Some(entry.into())
}

/// Keep only the first Node entry path, never later script arguments or environment.
pub fn node_entry(target: &Identity) -> Option<String> {
    if target.uid != uid() || identity(target.pid).as_ref() != Some(target) { return None; }
    let mut data = process_arguments(target.pid)?;
    let entry = argument_sections(&data).and_then(|(args, _)| node_entry_argument(&args));
    data.fill(0);
    if identity(target.pid).as_ref() != Some(target) { return None; }
    entry
}

/// Routine sampling keeps only two allowlisted argv options; it never reads environment fields.
fn metadata(pid: i32, exe: &str) -> (String, String) {
    if !(exe.contains("/emulator/") || exe.contains(".app/")) {
        return (String::new(), String::new());
    }
    let Some(mut data) = process_arguments(pid) else {
        return (String::new(), String::new());
    };
    let Some((arguments, _)) = argument_sections(&data) else {
        return (String::new(), String::new());
    };
    let args: Vec<_> = arguments
        .into_iter()
        .map(|s| String::from_utf8_lossy(s))
        .collect();
    let mut avd = String::new();
    let mut role = String::new();
    for (i, arg) in args.iter().enumerate() {
        if arg == "-avd" {
            avd = args
                .get(i + 1)
                .map(|v| {
                    v.chars()
                        .filter(|c| c.is_alphanumeric() || "-_.".contains(*c))
                        .take(100)
                        .collect()
                })
                .unwrap_or_default();
        }
        if let Some(value) = arg.strip_prefix("--type=") {
            role = match value {
                "renderer" => "渲染进程",
                "gpu-process" => "GPU",
                "utility" => "后台服务",
                _ => "辅助进程",
            }
            .into();
        }
    }
    drop(args);
    data.fill(0);
    (avd, role)
}

#[cfg(test)]
mod argument_tests {
    use super::*;
    #[test]
    fn root_control_needs_both_helper_authorization_and_eligible_target_without_removing_core_guards() {
        let vivo="/Applications/pcsuite.app/Contents/Resources/vivo_remote_watch";
        assert!(privileged_protection(0,vivo,true,true).is_empty());
        assert!(privileged_protection(0,vivo,false,true).contains("尚未授权"));
        assert!(!privileged_protection(0,vivo,true,false).is_empty());
        for path in ["/System/Library/core","/usr/bin/tool","/Applications/FlowHub.app/helper","/Library/PrivilegedHelperTools/cn.ac.camellia.flowhub.resource-monitor/daemon"] {
            assert!(!privileged_protection(0,path,true,true).is_empty());
        }
        assert!(!privileged_protection(502,vivo,true,true).is_empty());
    }
    fn arguments(env: &[u8]) -> Vec<u8> {
        let mut result = 2_i32.to_ne_bytes().to_vec();
        result.extend_from_slice(b"/usr/bin/tool\0\0\0tool\0--flag\0");
        result.extend_from_slice(env);
        result
    }
    #[test]
    fn initial_path_ignores_argv_zero_arguments_and_environment() {
        let mut data=1_i32.to_ne_bytes().to_vec();
        data.extend_from_slice(b"/usr/bin/real-tool\0\0/Applications/Fake.app/Contents/MacOS/Fake\0TOKEN=secret\0");
        assert_eq!(initial_executable(&data),Some("/usr/bin/real-tool".into()));
        assert_eq!(initial_executable(&arguments(b"TOKEN=secret\0")),Some("/usr/bin/tool".into()));
        for path in [b"relative\0".as_slice(),b"\0",b"/bad\npath\0",b"/invalid\xff\0",b"/missing-terminator"] {
            let mut malformed=1_i32.to_ne_bytes().to_vec();malformed.extend_from_slice(path);
            assert!(initial_executable(&malformed).is_none());
        }
        let mut oversized=1_i32.to_ne_bytes().to_vec();
        oversized.push(b'/');oversized.extend(vec![b'a';4096]);oversized.push(0);
        assert!(initial_executable(&oversized).is_none());
        assert!(initial_executable(b"bad").is_none());
    }
    #[test]
    fn node_entry_is_one_positional_script_and_never_inline_code_or_later_arguments() {
        assert_eq!(node_entry_argument(&[b"node", b"/project/index.js", b"--token", b"secret"]),Some("/project/index.js".into()));
        assert_eq!(node_entry_argument(&[b"node", b"--require", b"/setup.js", b"--no-warnings", b"/project/index.js"]),Some("/project/index.js".into()));
        assert_eq!(node_entry_argument(&[b"node", b"--no-warnings", b"--no-deprecation", b"/tool/happy/dist/index.mjs"]),Some("/tool/happy/dist/index.mjs".into()));
        assert_eq!(node_entry_argument(&[b"node", b"--", b"file:///project/index.mjs"]),Some("/project/index.mjs".into()));
        for args in [vec![b"node".as_slice(),b"-e",b"private source",b"/fake/index.js"], vec![b"node".as_slice(),b"--unknown",b"secret",b"/fake/index.js"], vec![b"node".as_slice(),b"--eval=private source"], vec![b"node".as_slice(),b"--require",b"/setup.js"]] {
            assert!(node_entry_argument(&args).is_none());
        }
    }
    #[test]
    fn only_an_unambiguous_uuid_environment_marker_is_retained() {
        let id = "d57ca944-ef25-48d8-9464-2ef7f3037345";
        assert_eq!(
            thread_from_arguments(&arguments(
                format!("TOKEN=secret\0CODEX_THREAD_ID={id}\0OTHER=secret\0").as_bytes()
            )),
            Some(id.into())
        );
        assert!(thread_from_arguments(&arguments(b"CODEX_THREAD_ID=not-an-id\0")).is_none());
        assert!(thread_from_arguments(&arguments(
            format!("CODEX_THREAD_ID={id}\0CODEX_THREAD_ID={id}\0").as_bytes()
        ))
        .is_none());
        assert!(thread_from_arguments(b"broken").is_none());
        assert!(thread_from_arguments(&arguments(b"OTHER=CODEX_THREAD_ID=secret\0")).is_none());
    }
}

pub fn collect() -> Result<Vec<Process>, String> {
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Err("无法读取本机进程列表".into());
    }
    let mut pids = vec![0_i32; (count as usize + 1024).min(65536)];
    let n = unsafe {
        libc::proc_listallpids(
            pids.as_mut_ptr().cast(),
            (pids.len() * size_of::<i32>()) as i32,
        )
    };
    if n <= 0 {
        return Err("进程枚举失败，请稍后刷新".into());
    }
    pids.truncate(n as usize);
    let me = std::process::id() as i32;
    let mut ancestors = HashSet::from([me]);
    let mut next = unsafe { libc::getppid() };
    for _ in 0..64 {
        if next <= 1 || !ancestors.insert(next) {
            break;
        }
        let Some(bsd) = info::<libc::proc_bsdinfo>(next, libc::PROC_PIDTBSDINFO) else {
            break;
        };
        next = bsd.pbi_ppid as i32;
    }
    let own_uid = uid();
    let mut result = vec![];
    for pid in pids {
        if pid <= 0 {
            continue;
        }
        let Some(bsd) = info::<libc::proc_bsdinfo>(pid, libc::PROC_PIDTBSDINFO) else {
            // A non-privileged process may still be allowed to read proc_pidpath for a
            // root-owned process even when BSD identity and resource details are denied.
            // Keep a protected, metrics-unavailable row instead of silently dropping it.
            let Some(executable) = pid_path(pid).filter(|path| !path.is_empty()) else {
                continue;
            };
            let name = executable.rsplit('/').next().unwrap_or(&executable).to_string();
            result.push(Process {
                identity: Identity {
                    pid,
                    started: 0,
                    executable,
                    // Unknown is deliberately distinct from the current UID. This keeps
                    // the group in the system section and prevents identity validation
                    // from authorizing termination.
                    uid: u32::MAX,
                },
                ppid: 0,
                responsible: None,
                terminal_owner: None,
                process_group: 0,
                terminal_job: false,
                registered_app_path: None,
                runtime_project: None,
                name,
                display_name: None,
                launch_executable: None,
                memory: None,
                footprint: None,
                cpu: None,
                cwd: String::new(),
                role: "权限受限".into(),
                avd: String::new(),
                protected: true,
                protection: "当前用户权限不足：仅可读取名称和路径，资源指标不可读取".into(),
                parent_name: "不可读取".into(),
                group_id: String::new(),
                instance_id: String::new(),
                attribution: "权限受限进程路径".into(),
                cpu_time: 0,
            });
            continue;
        };
        let Some(identity) = identity(pid) else {
            continue;
        };
        // Reject mixed records if a PID was recycled between native reads.
        if identity.started != bsd.pbi_start_tvsec * 1_000_000 + bsd.pbi_start_tvusec {
            continue;
        }
        let task = info::<libc::proc_taskinfo>(pid, libc::PROC_PIDTASKINFO);
        let exe = &identity.executable;
        let system = exe.starts_with("/System/")
            || exe.starts_with("/usr/libexec/")
            || exe.starts_with("/usr/sbin/")
            || exe.starts_with("/sbin/");
        let protection = if pid <= 1 {
            "系统进程"
        } else if ancestors.contains(&pid) || exe.contains("/FlowHub.app/") {
            "FlowHub 及其宿主进程"
        } else if identity.uid != own_uid {
            "其他用户或系统账户"
        } else if system {
            "系统进程"
        } else if exe.is_empty() {
            "无法核实可执行路径"
        } else {
            ""
        };
        let (avd, mut role) = if identity.uid == own_uid && !system {
            metadata(pid, exe)
        } else {
            (String::new(), String::new())
        };
        if role.is_empty() {
            role = if exe.contains("Helper") {
                "辅助进程"
            } else if exe.contains("qemu") {
                "虚拟机"
            } else {
                "进程"
            }
            .into();
        }
        let name = if exe.is_empty() {
            text(&bsd.pbi_comm)
        } else {
            exe.rsplit('/').next().unwrap_or(exe).to_string()
        };
        let memory = task.as_ref().map(|v| v.pti_resident_size);
        let footprint = footprint(pid);
        let cpu_time = task
            .map(|v| v.pti_total_user.saturating_add(v.pti_total_system))
            .unwrap_or(0);
        let cwd = if identity.uid == own_uid && !system {
            cwd(pid)
        } else {
            String::new()
        };
        result.push(Process {
            identity,
            ppid: bsd.pbi_ppid as i32,
            responsible: None,
            terminal_owner: None,
            process_group: bsd.pbi_pgid as i32,
            terminal_job: false,
            registered_app_path: None,
            runtime_project: None,
            name,
            display_name: None,
            launch_executable: None,
            memory,
            footprint,
            cpu: None,
            cwd,
            role,
            avd,
            protected: !protection.is_empty(),
            protection: protection.into(),
            parent_name: String::new(),
            group_id: String::new(),
            instance_id: String::new(),
            attribution: String::new(),
            cpu_time,
        });
    }
    crate::diagnostics::phase("privileged");
    merge_privileged(&mut result, own_uid);
    webkit_responsibility(&mut result, own_uid);
    if result.is_empty() {
        Err("未读取到有效进程，保留上次数据".into())
    } else {
        Ok(result)
    }
}

fn sysctl<T>(name: &CStr) -> Option<T> {
    let mut value: T = unsafe { zeroed() };
    let mut length = size_of::<T>();
    let ok = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&mut value as *mut T).cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    (ok == 0 && length == size_of::<T>()).then_some(value)
}

pub fn system() -> Value {
    let total = sysctl::<u64>(c"hw.memsize");
    let swap = sysctl::<libc::xsw_usage>(c"vm.swapusage").map(|v| v.xsu_used);
    let pressure = sysctl::<i32>(c"kern.memorystatus_vm_pressure_level").map(|v| match v {
        1 => "normal",
        2 => "warning",
        4 => "critical",
        _ => "unknown",
    });
    json!({"totalMemory":total,"swapUsed":swap,"pressure":pressure})
}

pub fn signal(target: &Identity, force: bool) -> Result<(), String> {
    if identity(target.pid).as_ref() != Some(target) {
        return Err("进程已退出或身份改变，请重新确认".into());
    }
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    if unsafe { libc::kill(target.pid, signal) } == 0 {
        Ok(())
    } else {
        Err(format!(
            "系统拒绝结束进程：{}",
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(test)]
mod service_control_tests {
    #[test]
    fn rejects_unscoped_service_commands_before_connecting() {
        assert!(super::service_request("shell",&serde_json::json!({"command":"anything"})).is_err());
        assert!(super::service_request("service_preview",&serde_json::json!({"id":"a".repeat(64),"action":"disable"})).is_err());
        assert!(super::service_request("service_preview",&serde_json::json!({"id":"../../system","action":"stop"})).is_err());
        assert!(super::service_request("service_confirm",&serde_json::json!({"token":uuid::Uuid::new_v4().to_string(),"confirmed":false})).is_err());
    }
}
