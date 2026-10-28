use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub pid: i32,
    pub started: u64,
    pub executable: String,
    pub uid: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    #[serde(flatten)]
    pub identity: Identity,
    pub ppid: i32,
    pub name: String,
    pub memory: Option<u64>,
    pub footprint: Option<u64>,
    pub cpu: Option<f64>,
    pub cwd: String,
    pub role: String,
    pub avd: String,
    pub protected: bool,
    pub protection: String,
    pub parent_name: String,
    pub group_id: String,
    pub attribution: String,
    #[serde(skip)]
    pub cpu_time: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub source: String,
    pub memory: Option<u64>,
    pub footprint: Option<u64>,
    pub footprint_incomplete: bool,
    pub app_path: Option<String>,
    pub cpu: Option<f64>,
    pub incomplete: bool,
    pub system: bool,
    pub processes: Vec<Process>,
    pub can_terminate: bool,
}

pub fn app_bundle(executable: &str) -> Option<(String, String)> {
    let end = executable.find(".app/")? + 4;
    let path = &executable[..end];
    let name = path.rsplit('/').next()?.strip_suffix(".app")?;
    Some((format!("app:{path}"), name.into()))
}

fn special(p: &Process) -> Option<(String, String, String)> {
    let exe = p.identity.executable.to_lowercase();
    if exe.contains("/emulator/") && p.name.contains("qemu") {
        let name = if p.avd.is_empty() {
            "Android 模拟器".into()
        } else {
            format!("Android 模拟器 · {}", p.avd)
        };
        return Some((
            format!("android:{}:{}", p.identity.pid, p.identity.started),
            name,
            "Android SDK · 可执行路径识别".into(),
        ));
    }
    if p.name.starts_with("qemu-system") {
        return Some((
            format!("vm:{}:{}", p.identity.pid, p.identity.started),
            "QEMU 虚拟机".into(),
            "虚拟机 · 管理工具尚未确定".into(),
        ));
    }
    None
}

/// Each PID enters exactly one group. A process tree is evidence, not a conversation ID.
pub fn group_processes(mut processes: Vec<Process>, own_uid: u32) -> Vec<Group> {
    let index: HashMap<i32, usize> = processes
        .iter()
        .enumerate()
        .map(|(i, p)| (p.identity.pid, i))
        .collect();
    let mut assignments = Vec::with_capacity(processes.len());
    for p in &processes {
        let own = special(p)
            .map(|(id, name, source)| (id, name, source, "路径识别".to_string()))
            .or_else(|| {
                app_bundle(&p.identity.executable)
                    .map(|(id, name)| (id, name, "应用包路径".into(), "应用包路径".into()))
            });
        if let Some(found) = own {
            assignments.push(found);
            continue;
        }
        let mut next = p.ppid;
        let mut visited = HashSet::from([p.identity.pid]);
        let mut inherited = None;
        while visited.len() < 64 && next > 1 && visited.insert(next) {
            let Some(parent) = index.get(&next).map(|i| &processes[*i]) else {
                break;
            };
            if parent.identity.uid != p.identity.uid {
                break;
            }
            if let Some((id, name, source)) = special(parent) {
                inherited = Some((id, name, source, "父进程推断".into()));
                break;
            }
            if let Some((id, name)) = app_bundle(&parent.identity.executable) {
                inherited = Some((id, name, "应用包及子进程".into(), "父进程推断".into()));
                break;
            }
            next = parent.ppid;
        }
        assignments.push(inherited.unwrap_or_else(|| {
            let exe = &p.identity.executable;
            // Do not merge unrelated development projects that happen to use node/python.
            let key = if exe.is_empty() {
                format!("unknown:{}:{}", p.identity.pid, p.identity.started)
            } else {
                format!("tool:{exe}:{}:{}", p.cwd, p.identity.uid)
            };
            (
                key,
                p.name.clone(),
                if exe.is_empty() {
                    "来源未确定".into()
                } else {
                    "独立进程 · 可执行路径".into()
                },
                "独立进程".into(),
            )
        }));
    }
    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    for (p, (id, name, source, attribution)) in processes.iter_mut().zip(assignments) {
        let app_path = id.strip_prefix("app:").map(String::from);
        let id = format!("group-{:x}", Sha256::digest(id.as_bytes()));
        p.group_id = id.clone();
        p.attribution = attribution;
        let group = groups.entry(id.clone()).or_insert_with(|| Group {
            id,
            name,
            source,
            memory: None,
            footprint: None,
            footprint_incomplete: false,
            app_path,
            cpu: None,
            incomplete: false,
            system: true,
            processes: vec![],
            can_terminate: true,
        });
        group.incomplete |= p.memory.is_none();
        group.footprint_incomplete |= p.footprint.is_none();
        if let Some(v) = p.footprint {
            group.footprint = Some(group.footprint.unwrap_or(0).saturating_add(v));
        }
        if let Some(v) = p.memory {
            group.memory = Some(group.memory.unwrap_or(0).saturating_add(v));
        }
        if let Some(v) = p.cpu {
            group.cpu = Some(group.cpu.unwrap_or(0.) + v);
        }
        group.system &= p.identity.uid != own_uid || p.protection == "系统进程";
        group.can_terminate &= !p.protected;
        group.processes.push(p.clone());
    }
    let names: HashMap<i32, String> = processes
        .iter()
        .map(|p| (p.identity.pid, p.name.clone()))
        .collect();
    let mut result: Vec<_> = groups.into_values().collect();
    for g in &mut result {
        for p in &mut g.processes {
            p.parent_name = names
                .get(&p.ppid)
                .cloned()
                .unwrap_or_else(|| "已退出或不可读取".into());
        }
        g.processes
            .sort_by_key(|p| std::cmp::Reverse(p.footprint.unwrap_or(0)));
    }
    result.sort_by_key(|g| std::cmp::Reverse(g.footprint.unwrap_or(0)));
    result
}

pub fn same_targets(a: &[Identity], b: &[Identity]) -> bool {
    a.len() == b.len() && a.iter().all(|p| b.contains(p))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn process(pid: i32, ppid: i32, exe: &str) -> Process {
        Process {
            identity: Identity {
                pid,
                started: 100,
                executable: exe.into(),
                uid: 501,
            },
            ppid,
            name: exe.rsplit('/').next().unwrap().into(),
            memory: Some(100),
            footprint: Some(150),
            cpu: None,
            cwd: "/project".into(),
            role: "主进程".into(),
            avd: String::new(),
            protected: false,
            protection: String::new(),
            parent_name: String::new(),
            group_id: String::new(),
            attribution: String::new(),
            cpu_time: 0,
        }
    }
    #[test]
    fn bundles_helpers_and_descendants_are_counted_once() {
        let g = group_processes(
            vec![
                process(10, 1, "/Applications/Codex.app/Contents/MacOS/Codex"),
                process(
                    11,
                    10,
                    "/Applications/Codex.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
                ),
                process(12, 10, "/usr/local/bin/node"),
            ],
            501,
        );
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].memory, Some(300));
        assert_eq!(g[0].footprint, Some(450));
        assert_eq!(g[0].app_path.as_deref(), Some("/Applications/Codex.app"));
        assert_eq!(g[0].processes.len(), 3);
        assert_eq!(g[0].processes[2].attribution, "父进程推断");
    }
    #[test]
    fn emulator_is_independent_from_codex_and_pid_reuse_changes_identity() {
        let mut emulator = process(
            11,
            10,
            "/Library/Android/sdk/emulator/qemu/qemu-system-aarch64-headless",
        );
        emulator.avd = "test-device".into();
        let g = group_processes(
            vec![
                process(10, 1, "/Applications/Codex.app/Contents/MacOS/Codex"),
                emulator.clone(),
            ],
            501,
        );
        assert_eq!(g.len(), 2);
        assert!(g.iter().any(|g| g.name == "Android 模拟器 · test-device"));
        let mut reused = emulator.identity.clone();
        reused.started += 1;
        assert!(!same_targets(&[emulator.identity], &[reused]));
    }
    #[test]
    fn cycles_unknowns_and_protected_members_are_handled() {
        let mut p = process(10, 11, "");
        p.memory = None;
        p.protected = true;
        let g = group_processes(vec![p, process(11, 10, "/node")], 501);
        assert_eq!(g.len(), 2);
        assert!(g.iter().any(|g| !g.can_terminate && g.incomplete));
    }
}
