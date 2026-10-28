//! macOS libproc sampling: no shell, no full command lines or environment in RPC/logs.
use crate::model::{Identity, Process};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    ffi::CStr,
    mem::{size_of, zeroed},
};

pub fn uid() -> u32 {
    unsafe { libc::geteuid() }
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
    let mut path = [0_i8; 4096];
    let length = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    Some(Identity {
        pid,
        uid: bsd.pbi_uid,
        started: bsd.pbi_start_tvsec.saturating_mul(1_000_000) + bsd.pbi_start_tvusec,
        executable: if length > 0 {
            text(&path)
        } else {
            String::new()
        },
    })
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
    fn arguments(env: &[u8]) -> Vec<u8> {
        let mut result = 2_i32.to_ne_bytes().to_vec();
        result.extend_from_slice(b"/usr/bin/tool\0\0\0tool\0--flag\0");
        result.extend_from_slice(env);
        result
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
            name,
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
            attribution: String::new(),
            cpu_time,
        });
    }
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
