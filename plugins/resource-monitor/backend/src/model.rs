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
pub struct RuntimeProject {
    pub name: String,
    pub root: String,
    pub entry: Option<String>,
    pub evidence: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    #[serde(flatten)]
    pub identity: Identity,
    pub ppid: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub responsible: Option<Identity>,
    // Terminal ownership is presentation evidence, not an action-parent edge.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub terminal_owner: Option<Identity>,
    #[serde(skip)]
    pub process_group: i32,
    #[serde(skip)]
    pub terminal_job: bool,
    // Locally verified bundle attribution; never accepted from sampler RPC.
    #[serde(skip)]
    pub registered_app_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_project: Option<RuntimeProject>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    // A launch path is source metadata, never a replacement for Identity.executable.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub launch_executable: Option<String>,
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
    #[serde(default)]
    pub instance_id: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<SourceOrigin>,
    pub cpu: Option<f64>,
    pub incomplete: bool,
    pub system: bool,
    pub processes: Vec<Process>,
    pub can_terminate: bool,
    #[serde(default)]
    pub instances: Vec<Instance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_key: Option<String>,
    // Added after grouping. Never read by instance/quit/termination code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Presentation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceOrigin {
    pub name: String,
    pub app_path: Option<String>,
    pub evidence: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub name: String,
    pub label: String,
    pub evidence: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    pub name: Option<String>,
    pub sources: Vec<SourceOrigin>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub services: Vec<ServiceInfo>,
}

fn runtime_icon(executable: &str) -> Option<&'static str> {
    let name=std::path::Path::new(executable).file_name()?.to_str()?.to_ascii_lowercase();
    match name.as_str() {
        "mysql" | "mysqld" | "mysqld_safe" => return Some("mysql"),
        "redis-server" | "redis-cli" | "redis-sentinel" => return Some("redis"),
        "tmux" => return Some("tmux"),
        "adb" => return Some("android"),
        _ => {},
    }
    if name=="postgres" { return Some("postgresql"); }
    let suffix=name.strip_prefix("python")?;
    if suffix.is_empty() || (suffix.split('.').count()<=2 && suffix.split('.').all(|part| !part.is_empty() && part.bytes().all(|c|c.is_ascii_digit()))) {
        Some("python")
    } else { None }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    pub root: Identity,
    pub count: usize,
    pub memory: Option<u64>,
    pub footprint: Option<u64>,
    pub cpu: Option<f64>,
    pub incomplete: bool,
    pub footprint_incomplete: bool,
    pub can_terminate: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Presentation>,
}

pub fn app_bundle(executable: &str) -> Option<(String, String)> {
    let end = executable.find(".app/")? + 4;
    let path = &executable[..end];
    let name = path.rsplit('/').next()?.strip_suffix(".app")?;
    Some((format!("app:{path}"), name.into()))
}

pub(crate) fn process_bundle(process: &Process) -> Option<(String, String)> {
    process.registered_app_path.as_ref().and_then(|path| {
        let name = path.rsplit('/').next()?.strip_suffix(".app")?;
        Some((format!("app:{path}"), name.into()))
    }).or_else(|| app_bundle(&process.identity.executable))
}

fn tool_key(p: &Process) -> String {
    if p.identity.executable.is_empty() {
        format!("unknown:{}:{}",p.identity.pid,p.identity.started)
    } else {
        format!("tool:{}:{}:{}",p.identity.executable,p.cwd,p.identity.uid)
    }
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

fn runtime_project(p: &Process) -> Option<(String, String, String)> {
    let project = p.runtime_project.as_ref()?;
    Some((format!("node-project:{}:{}", p.identity.uid, project.root),
        project.name.clone(), format!("Node.js · {}", project.evidence)))
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
                process_bundle(p).map(|(id, name)| {
                    let launched=p.launch_executable.is_some();
                    let registered=p.registered_app_path.is_some()&&p.identity.executable.is_empty();
                    (id,name,if launched {"进程启动路径"}else if registered {"macOS 应用登记"}else{"应用包路径"}.into(),if launched {"启动路径归属"}else if registered {"应用登记归属"}else{"应用包路径"}.into())
                })
            });
        if let Some(found) = own {
            assignments.push(found);
            continue;
        }
        if let Some((id, name, source)) = runtime_project(p) {
            assignments.push((id, name, source, "项目/工具识别".into()));
            continue;
        }
        if let Some(owner) = p.terminal_owner.as_ref().and_then(|id| index.get(&id.pid)
            .map(|i| &processes[*i]).filter(|owner| owner.identity==*id && id.uid==p.identity.uid)) {
            if let Some((id,name))=process_bundle(owner) {
                assignments.push((id,name,"应用包及终端会话".into(),"终端应用归属".into()));
                continue;
            }
            if owner.identity.executable.rsplit('/').next()==Some("tmux") {
                assignments.push((tool_key(owner),"tmux".into(),"终端复用及独立会话".into(),"终端父进程归属".into()));
                continue;
            }
        }
        let mut next = p.ppid;
        let mut youngest = p.identity.started;
        let mut visited = HashSet::from([p.identity.pid]);
        let mut inherited = None;
        while visited.len() < 64 && next > 1 && visited.insert(next) {
            let Some(parent) = index.get(&next).map(|i| &processes[*i]) else {
                break;
            };
            if parent.identity.uid != p.identity.uid || parent.identity.started==0
                || parent.identity.started>youngest {
                break;
            }
            youngest=parent.identity.started;
            if let Some((id, name, source)) = special(parent) {
                inherited = Some((id, name, source, "父进程推断".into()));
                break;
            }
            if let Some((id, name)) = process_bundle(parent) {
                inherited = Some((id, name, "应用包及子进程".into(), "父进程推断".into()));
                break;
            }
            if let Some((id, name, source)) = runtime_project(parent) {
                inherited = Some((id, name, source, "项目父进程推断".into()));
                break;
            }
            next = parent.ppid;
        }
        if inherited.is_none() {
            inherited = p.responsible.as_ref().and_then(|identity| {
                let owner = index.get(&identity.pid).map(|i| &processes[*i])?;
                if owner.identity != *identity || owner.identity.uid != p.identity.uid {
                    return None;
                }
                process_bundle(owner).map(|(id, name)|
                    (id, name, "应用包及系统托管进程".into(), "系统责任进程归属".into()))
            });
        }
        assignments.push(inherited.unwrap_or_else(|| {
            let exe = &p.identity.executable;
            if exe.contains("/WebKit.framework/") && p.name.starts_with("com.apple.WebKit.") {
                return (format!("webkit:{}:{}", p.identity.pid, p.identity.started),
                    p.name.clone(), "WebKit · 所属应用未确定".into(), "归属未确定".into());
            }
            // Do not merge unrelated development projects that happen to use node/python.
            let key = tool_key(p);
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
    // A launch source is not application membership. External jobs stay outside
    // app action scopes even when a parent/OS responsibility link names that app.
    let by: HashMap<_,_> = processes.iter().map(|p|(p.identity.pid,p)).collect();
    let mut origins=Vec::with_capacity(processes.len());
    for (p,assignment) in processes.iter().zip(&mut assignments) {
        let app_source=assignment.0.strip_prefix("app:").filter(|_|process_bundle(p).is_none() && p.responsible.is_none());
        let tmux_source=p.terminal_owner.as_ref().and_then(|owner| by.get(&owner.pid)
            .filter(|actual|actual.identity==*owner && actual.identity.uid==p.identity.uid
                && actual.identity.executable.rsplit('/').next()==Some("tmux")));
        let origin=if let Some(path)=app_source {
            Some(SourceOrigin{name:assignment.1.clone(),app_path:Some(path.into()),evidence:"应用启动来源线索".into()})
        } else if tmux_source.is_some() {
            Some(SourceOrigin{name:"tmux".into(),app_path:None,evidence:"终端托管来源线索".into()})
        } else {None};
        if let Some(origin)=&origin {
            let (key,name)=if p.terminal_job {
                let root=crate::instances::root(p,&by);
                let name=by.get(&root.pid).map(|p|p.display_name.as_ref().unwrap_or(&p.name).clone()).unwrap_or_else(||p.name.clone());
                (format!("job:{:x}",Sha256::digest(serde_json::to_vec(&root).unwrap())),name)
            } else {(tool_key(p),p.display_name.as_ref().unwrap_or(&p.name).clone())};
            *assignment=(format!("{key}:source:{}",origin.app_path.as_deref().unwrap_or(&origin.name)),name,
                if p.terminal_job {"独立终端任务"}else{"独立任务"}.into(),"来源关联 · 独立任务".into());
        }
        origins.push(origin);
    }
    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    for ((p, (id, name, source, attribution)),origin) in processes.iter_mut().zip(assignments).zip(origins) {
        let app_path = id.strip_prefix("app:").map(String::from);
        let icon_key = if id.starts_with("tool:") {runtime_icon(&p.identity.executable).map(String::from)} else {None};
        let id = format!("group-{:x}", Sha256::digest(id.as_bytes()));
        p.group_id = id.clone();
        let hosted = attribution == "系统责任进程归属";
        p.attribution = attribution;
        let group = groups.entry(id.clone()).or_insert_with(|| Group {
            id,
            name,
            source,
            memory: None,
            footprint: None,
            footprint_incomplete: false,
            app_path,
            origin,
            cpu: None,
            incomplete: false,
            system: true,
            processes: vec![],
            can_terminate: true,
            instances: vec![],
            icon_key,
            presentation: None,
        });
        if hosted { group.source = "应用包及系统托管进程".into(); }
        if p.attribution=="应用登记归属" {group.source="应用包及登记的后台服务".into();}
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
        .map(|p| (p.identity.pid, p.display_name.as_ref().unwrap_or(&p.name).clone()))
        .collect();
    let mut result: Vec<_> = groups.into_values().collect();
    for g in &mut result {
        if g.processes.iter().any(|p| p.attribution=="启动路径归属") {
            g.source="应用包及启动路径".into();
        }
        if g.origin.is_none() && g.processes.iter().any(|p| p.terminal_owner.is_some()) {
            g.source=if g.app_path.is_some(){"应用包及关联进程"}else{"终端复用及独立会话"}.into();
        }
        for p in &mut g.processes {
            p.parent_name = names
                .get(&p.ppid)
                .cloned()
                .unwrap_or_else(|| "已退出或不可读取".into());
        }
        g.processes
            .sort_by_key(|p| std::cmp::Reverse(p.footprint.unwrap_or(0)));
        crate::instances::assign(g);
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
            responsible: None,
            terminal_owner: None,
            process_group: 0,
            terminal_job: false,
            registered_app_path: None,
            runtime_project: None,
            name: exe.rsplit('/').next().unwrap().into(),
            display_name: None,
            launch_executable: None,
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
            instance_id: String::new(),
            attribution: String::new(),
            cpu_time: 0,
        }
    }
    #[test]
    fn runtime_icons_use_executable_names_and_do_not_guess_app_ownership() {
        let groups=group_processes(vec![process(10,1,"/uv/cpython-3.12/bin/python3.12"),process(20,1,"/opt/homebrew/Cellar/postgresql@14/14.19/bin/postgres")],501);
        assert_eq!(groups.iter().find(|g|g.name=="python3.12").unwrap().icon_key.as_deref(),Some("python"));
        assert_eq!(groups.iter().find(|g|g.name=="postgres").unwrap().icon_key.as_deref(),Some("postgresql"));
        assert!(groups.iter().all(|g|g.app_path.is_none()));
        assert!(runtime_icon("/usr/bin/python3.12-config").is_none());
        assert!(runtime_icon("").is_none());
        for (name, icon) in [("mysqld","mysql"),("mysql","mysql"),("mysqld_safe","mysql"),("tmux","tmux"),("adb","android"),("redis-server","redis"),("redis-cli","redis")] {
            assert_eq!(runtime_icon(&format!("/runtime/bin/{name}")),Some(icon));
        }
        assert!(runtime_icon("/runtime/bin/mysql-helper-unrelated").is_none());
        assert!(runtime_icon("/runtime/bin/redis-server-backup").is_none());
        let mut fake=process(30,1,"/bin/sleep");fake.name="python3.12".into();
        assert!(group_processes(vec![fake],501)[0].icon_key.is_none());
    }
    #[test]
    fn display_labels_do_not_change_group_instance_or_target_identity() {
        let root=process(10,1,"/Applications/Zen.app/Contents/MacOS/zen");
        let child=process(20,10,"/Applications/Zen.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container");
        let before=group_processes(vec![root.clone(),child.clone()],501).remove(0);
        let mut labeled=child;
        labeled.display_name=Some("ZenCP WebExtensions".into());
        let after=group_processes(vec![root,labeled],501).remove(0);
        assert_eq!(before.id,after.id);
        assert_eq!(before.instances[0].id,after.instances[0].id);
        assert!(same_targets(&before.processes.iter().map(|p|p.identity.clone()).collect::<Vec<_>>(),
            &after.processes.iter().map(|p|p.identity.clone()).collect::<Vec<_>>()));
        assert_eq!(after.processes.iter().find(|p|p.identity.pid==20).unwrap().name,"plugin-container");
    }
    #[test]
    fn registered_background_helper_keeps_its_unreadable_path_protection() {
        let mut helper=process(10,1,"");helper.name="wpslaunchhelper".into();
        helper.registered_app_path=Some("/Applications/wpsoffice.app".into());
        helper.protected=true;helper.protection="无法核实可执行路径".into();
        let plugin=process(20,1,"/Applications/wpsoffice.app/Contents/PlugIns/Finder.appex/Contents/MacOS/Finder");
        let groups=group_processes(vec![helper,plugin],501);
        assert_eq!(groups.len(),1);assert_eq!(groups[0].app_path.as_deref(),Some("/Applications/wpsoffice.app"));
        assert_eq!(groups[0].instances.len(),2);assert!(!groups[0].can_terminate);
        let helper=groups[0].processes.iter().find(|p|p.identity.pid==10).unwrap();
        assert!(helper.identity.executable.is_empty());assert!(helper.protected);
        assert!(!groups[0].instances.iter().find(|i|i.root.pid==10).unwrap().can_terminate);
    }
    #[test]
    fn launchd_webkit_helpers_follow_verified_responsibility_without_double_counting() {
        let app = process(10, 1, "/Applications/Example.app/Contents/MacOS/Example");
        let mut web = process(20, 1, "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent");
        web.responsible = Some(app.identity.clone());
        web.protected = true;
        let mut recycled = web.clone(); recycled.identity.pid = 21;
        recycled.responsible.as_mut().unwrap().started += 1;
        let mut other_user = web.clone(); other_user.identity.pid = 22; other_user.identity.uid = 0;
        let groups = group_processes(vec![app, web, recycled, other_user], 501);
        let group = groups.iter().find(|g| g.app_path.as_deref() == Some("/Applications/Example.app")).unwrap();
        assert_eq!(group.processes.len(), 2);
        assert_eq!(group.footprint, Some(300));
        assert_eq!(group.source, "应用包及系统托管进程");
        assert!(!group.can_terminate); // Ownership must not remove process protections.
        assert_eq!(groups.iter().map(|g| g.processes.len()).sum::<usize>(), 4);
        assert_eq!(groups.iter().filter(|g| g.app_path.is_none()).count(), 2);
    }
    #[test]
    fn registered_signing_clones_merge_with_the_app_but_keep_original_process_paths() {
        let exe = "/private/var/folders/user/X/com.example.App.code_sign_clone/code_sign_clone.Abc123/Example.app.bundle/Contents/MacOS/Example";
        let mut main = process(10, 1, exe);
        main.registered_app_path = Some("/Applications/Example.app".into());
        let helper = process(11, 10, "/usr/local/bin/worker");
        let installed = process(12, 1, "/Applications/Example.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper");
        let unrelated = process(13, 1, &exe.replace("Abc123", "Def456"));
        let groups = group_processes(vec![main, helper, installed, unrelated], 501);
        let group = groups.iter().find(|g| g.app_path.as_deref() == Some("/Applications/Example.app")).unwrap();
        assert_eq!(group.processes.len(), 2);
        assert_eq!(group.footprint, Some(300));
        assert_eq!(group.processes.iter().find(|p| p.identity.pid == 10).unwrap().identity.executable, exe);
        assert_eq!(groups.len(), 3);
        let external=groups.iter().find(|g|g.processes.iter().any(|p|p.identity.pid==11)).unwrap();
        assert!(external.app_path.is_none());
        assert_eq!(external.origin.as_ref().unwrap().app_path.as_deref(),Some("/Applications/Example.app"));
        assert!(!serde_json::to_value(&group.processes[0]).unwrap().as_object().unwrap().contains_key("registeredAppPath"));
    }
    #[test]
    fn bundle_helpers_and_external_descendants_are_counted_once_in_separate_scopes() {
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
        assert_eq!(g.len(), 2);
        let app=g.iter().find(|g|g.app_path.is_some()).unwrap();
        assert_eq!(app.memory, Some(200));assert_eq!(app.footprint, Some(300));
        assert_eq!(app.app_path.as_deref(), Some("/Applications/Codex.app"));assert_eq!(app.processes.len(),2);
        let external=g.iter().find(|g|g.processes.iter().any(|p|p.identity.pid==12)).unwrap();
        assert!(external.app_path.is_none());assert!(external.origin.is_some());
        assert_eq!(g.iter().map(|g|g.footprint.unwrap()).sum::<u64>(),450);
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
