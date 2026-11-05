//! Read-only display enrichment. Runs AFTER grouping and instance assignment;
//! none of these labels or source links can become an action-parent edge.
use crate::{
    model::{Group, Identity, Presentation, Process, ServiceInfo, SourceOrigin},
    native,
};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    os::fd::AsRawFd,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Default)]
pub struct Catalog {
    pending: Option<Receiver<Vec<Group>>>,
}
const ENRICHMENT_BUDGET: Duration = Duration::from_millis(800);
#[derive(Default)]
struct Evidence {
    services: HashMap<i32, (Identity, ServiceInfo)>,
    mux: HashMap<i32, Identity>,
}

fn command(program: &str, args: &[&str], deadline: Instant) -> Option<Vec<u8>> {
    let deadline = deadline.min(Instant::now() + Duration::from_millis(600));
    if Instant::now() >= deadline {
        return None;
    }
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    // Nonblocking reads also handle a child that exits after passing its pipe
    // to a descendant. Joining a blocking reader would defeat the timeout.
    let fd = stdout.as_raw_fd();
    if unsafe { libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK) } < 0 {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    }
    let mut bytes = Vec::new();
    let mut success = false;
    let mut eof = false;
    loop {
        let mut buffer = [0u8; 8192];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) => {
                    eof = true;
                    break;
                }
                Ok(n) => {
                    bytes.extend_from_slice(&buffer[..n]);
                    if bytes.len() > 262144 {
                        let _ = child.kill();
                        let _ = child.wait();
                        return None;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
            if Instant::now() >= deadline {
                break;
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                success = status.success();
                if !success || eof {
                    break;
                }
            }
            Ok(None) => {}
            Err(_) => break,
        }
        if Instant::now() >= deadline {
            success = false;
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let _ = child.kill();
    let _ = child.wait();
    (success && eof).then_some(bytes)
}

fn service_name(label: &str) -> String {
    if let Some(package) = label.strip_prefix("homebrew.mxcl.") {
        return match package {
            "mysql" | "mysql@8.0" | "mysql@8.4" => "MySQL".into(),
            "redis" => "Redis".into(),
            value if value.starts_with("postgresql") => value
                .replacen("postgresql", "PostgreSQL", 1)
                .replace('@', " "),
            value => format!("Homebrew · {value}"),
        };
    }
    match label {
        "com.mycelia.service" => "Mycelia 服务".into(),
        "com.mycelia.am-proxy" => "Mycelia 代理服务".into(),
        "com.ccx.proxy" => "CCX 代理服务".into(),
        "ac.cn.camellia.recipe-chatgpt-login" => "Recipe ChatGPT 登录服务".into(),
        "com.openssh.ssh-agent" => "SSH 密钥代理".into(),
        "com.apple.CoreDevice.remotepairingd" => "Apple 设备配对服务".into(),
        value if value.starts_with("com.toolkit.ssh-network.") => "toolkit SSH 网络服务".into(),
        value => value.to_owned(),
    }
}

fn launch_services(
    text: &str,
    by: &HashMap<i32, &Process>,
    own_uid: u32,
    current: &impl Fn(&Identity) -> bool,
) -> HashMap<i32, (Identity, ServiceInfo)> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse::<i32>().ok()?;
            fields.next()?;
            let label = fields.next()?;
            if fields.next().is_some()
                || label.len() > 256
                || label.starts_with("application.")
                || label.chars().any(char::is_control)
            {
                return None;
            }
            let p = by.get(&pid)?;
            if p.identity.uid != own_uid || p.identity.started == 0 || !current(&p.identity) {
                return None;
            }
            Some((
                pid,
                (
                    p.identity.clone(),
                    ServiceInfo {
                        name: service_name(label),
                        label: label.into(),
                        evidence: "macOS 运行服务登记".into(),
                    },
                ),
            ))
        })
        .collect()
}

fn directories(path: &Path) -> Vec<PathBuf> {
    let mut result: Vec<_> = std::fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .take(128)
        .map(|entry| entry.path())
        .collect();
    result.sort();
    result
}

fn pid_file(
    path: &Path,
    expected: &str,
    info: ServiceInfo,
    by: &HashMap<i32, &Process>,
    own_uid: u32,
    current: &impl Fn(&Identity) -> bool,
) -> Option<(i32, (Identity, ServiceInfo))> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > 32 {
        return None;
    }
    let pid = std::fs::read_to_string(path)
        .ok()?
        .trim()
        .parse::<i32>()
        .ok()?;
    let process = by.get(&pid)?;
    let id = &process.identity;
    let written = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_micros();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_micros();
    if id.uid != own_uid
        || id.started == 0
        || Path::new(&id.executable).file_name()?.to_str()? != expected
        || written + 5_000_000 < id.started as u128
        || written > now + 1_000_000
        || !current(id)
    {
        return None;
    }
    Some((pid, (id.clone(), info)))
}

fn profile_name(path: &Path) -> Option<&str> {
    path.file_name()?
        .to_str()
        .filter(|name| !name.is_empty() && name.len() <= 128 && !name.chars().any(char::is_control))
}

fn colima_services(
    home: &Path,
    by: &HashMap<i32, &Process>,
    own_uid: u32,
    current: &impl Fn(&Identity) -> bool,
) -> HashMap<i32, (Identity, ServiceInfo)> {
    let root = home.join(".colima");
    let mut result = HashMap::new();
    for profile in directories(&root) {
        let Some(name) = profile_name(&profile).filter(|name| !name.starts_with('_')) else {
            continue;
        };
        if let Some(record) = pid_file(
            &profile.join("daemon/daemon.pid"),
            "colima",
            ServiceInfo {
                name: format!("Colima 管理服务 · {name}"),
                label: format!("colima:{name}"),
                evidence: "Colima 实例 PID 记录".into(),
            },
            by,
            own_uid,
            current,
        ) {
            result.insert(record.0, record.1);
        }
    }
    for profile in directories(&root.join("_lima")) {
        let Some(name) = profile_name(&profile).filter(|name| !name.starts_with('_')) else {
            continue;
        };
        if let Some(record) = pid_file(
            &profile.join("ha.pid"),
            "limactl",
            ServiceInfo {
                name: format!("Colima 虚拟机 · {name}"),
                label: format!("colima-vm:{name}"),
                evidence: "Colima 虚拟机 PID 记录".into(),
            },
            by,
            own_uid,
            current,
        ) {
            result.insert(record.0, record.1);
        }
    }
    for network in directories(&root.join("_lima/_networks")) {
        let Some(name) = profile_name(&network) else {
            continue;
        };
        if let Some(record) = pid_file(
            &network.join(format!("usernet_{name}.pid")),
            "limactl",
            ServiceInfo {
                name: format!("Colima 网络服务 · {name}"),
                label: format!("colima-network:{name}"),
                evidence: "Colima 网络 PID 记录".into(),
            },
            by,
            own_uid,
            current,
        ) {
            result.insert(record.0, record.1);
        }
    }
    result
}

fn mapped_tmux(path: &str) -> bool {
    if path.chars().any(char::is_control) {
        return false;
    }
    let path = Path::new(path);
    path.is_absolute()
        && path.file_name().is_some_and(|name| name == "tmux")
        && !path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
}

fn real_tmux(path: &str) -> bool {
    mapped_tmux(path) && Path::new(path).is_file()
}

impl Catalog {
    pub fn enrich(&mut self, groups: &mut [Group]) {
        self.enrich_with(groups, ENRICHMENT_BUDGET, |groups, deadline| {
            enrich(groups, deadline)
        });
    }
    fn enrich_with(
        &mut self,
        groups: &mut [Group],
        budget: Duration,
        work: impl FnOnce(&mut [Group], Instant) + Send + 'static,
    ) {
        // At most one optional worker can outlive its budget. Late results are
        // discarded, never applied to another sampling generation/identity.
        if let Some(pending) = self.pending.take() {
            if matches!(pending.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                self.pending = Some(pending);
                return;
            }
        }
        let deadline = Instant::now() + budget;
        let mut copy = groups.to_vec();
        let (send, receive) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            work(&mut copy, deadline);
            let _ = send.send(copy);
        });
        match receive.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(copy) => groups.clone_from_slice(&copy),
            Err(mpsc::RecvTimeoutError::Timeout) => self.pending = Some(receive),
            Err(mpsc::RecvTimeoutError::Disconnected) => {}
        }
    }
}
fn enrich(groups: &mut [Group], deadline: Instant) {
    let by: HashMap<_, _> = groups
        .iter()
        .flat_map(|g| &g.processes)
        .map(|p| (p.identity.pid, p))
        .collect();
    let current = |id: &Identity| native::identity(id.pid).as_ref() == Some(id);
    let mut evidence = Evidence::default();
    if let Some(bytes) = command("/bin/launchctl", &["list"], deadline) {
        evidence.services = launch_services(
            &String::from_utf8_lossy(&bytes),
            &by,
            native::uid(),
            &current,
        );
    }
    if let Some(home) = std::env::var_os("HOME").filter(|_| Instant::now() < deadline) {
        evidence.services.extend(colima_services(
            Path::new(&home),
            &by,
            native::uid(),
            &current,
        ));
    }
    for p in by.values().filter(|p| {
        p.identity.uid == native::uid() && p.identity.executable.is_empty() && p.name == "tmux"
    }) {
        if Instant::now() >= deadline {
            break;
        }
        let id = &p.identity;
        if id.started == 0 || !current(id) {
            continue;
        }
        // Re-read the live mapping each sample: an unreadable executable
        // cannot safely serve as a cached image identity across exec(). A
        // mapped, deleted file is still evidence of this running process;
        // it never fills Identity.executable or removes protection.
        let path = native::launch_executable(id)
            .filter(|path| real_tmux(path))
            .or_else(|| {
                let pid = id.pid.to_string();
                let bytes = command(
                    "/usr/sbin/lsof",
                    &["-a", "-p", &pid, "-d", "txt", "-Fn"],
                    deadline,
                )?;
                String::from_utf8_lossy(&bytes)
                    .lines()
                    .filter_map(|line| line.strip_prefix('n'))
                    .find(|path| mapped_tmux(path))
                    .map(str::to_owned)
            });
        if path.is_some() && current(id) {
            evidence.mux.insert(id.pid, id.clone());
        }
    }
    drop(by);
    decorate(
        groups,
        &evidence,
        native::uid(),
        current,
        native::parent_matches,
    );
}

fn push_source(sources: &mut Vec<SourceOrigin>, source: SourceOrigin) {
    if !sources
        .iter()
        .any(|old| old.name == source.name && old.app_path == source.app_path)
    {
        sources.push(source);
    }
}

fn instance_context(
    root: &Process,
    group: &Group,
    by: &HashMap<i32, &Process>,
    evidence: &Evidence,
    current: &impl Fn(&Identity) -> bool,
    linked: &impl Fn(&Identity, &Identity) -> bool,
) -> Presentation {
    let mut context = Presentation::default();
    if !current(&root.identity) {
        return context;
    }
    let mut next = root;
    let mut visited = HashSet::new();
    while visited.len() < 64 && visited.insert(next.identity.pid) {
        if !current(&next.identity) {
            break;
        }
        if let Some((identity, service)) = evidence
            .services
            .get(&next.identity.pid)
            .filter(|(identity, _)| identity == &next.identity)
        {
            if current(identity) {
                context.services.push(service.clone());
                if context.name.is_none() && service.name != service.label {
                    context.name = Some(
                        if service.name == "MySQL"
                            && matches!(root.name.as_str(), "bash" | "sh" | "zsh")
                        {
                            "MySQL 启动脚本".into()
                        } else {
                            service.name.clone()
                        },
                    );
                }
                let owner = crate::model::process_bundle(next)
                    .map(|(path, name)| (path.trim_start_matches("app:").to_owned(), name));
                if service.name == service.label {
                    // Unknown launchd identifiers are useful in details, but
                    // must not replace an existing application/project name.
                    if let Some((path, name)) =
                        owner.filter(|(path, _)| Some(path.as_str()) != group.app_path.as_deref())
                    {
                        push_source(
                            &mut context.sources,
                            SourceOrigin {
                                name,
                                app_path: Some(path),
                                evidence: service.evidence.clone(),
                            },
                        );
                    } else if let Some(project) = &next.runtime_project {
                        push_source(
                            &mut context.sources,
                            SourceOrigin {
                                name: project.name.clone(),
                                app_path: None,
                                evidence: service.evidence.clone(),
                            },
                        );
                    }
                } else {
                    push_source(
                        &mut context.sources,
                        SourceOrigin {
                            name: service.name.clone(),
                            app_path: None,
                            evidence: service.evidence.clone(),
                        },
                    );
                }
                break;
            }
        }
        let mux = next.identity.executable.rsplit('/').next() == Some("tmux")
            || evidence.mux.get(&next.identity.pid) == Some(&next.identity);
        if mux && current(&next.identity) {
            push_source(
                &mut context.sources,
                SourceOrigin {
                    name: "tmux".into(),
                    app_path: None,
                    evidence: "当前父链与可执行文件核对".into(),
                },
            );
            break;
        }
        if next.identity.pid != root.identity.pid {
            if let Some((path, name)) = crate::model::process_bundle(next) {
                let path = path.trim_start_matches("app:");
                if Some(path) != group.app_path.as_deref() {
                    push_source(
                        &mut context.sources,
                        SourceOrigin {
                            name,
                            app_path: Some(path.into()),
                            evidence: "当前同用户父进程链".into(),
                        },
                    );
                    break;
                }
            }
        }
        let Some(parent) = by.get(&next.ppid) else {
            break;
        };
        if parent.identity.uid != root.identity.uid
            || parent.identity.started == 0
            || parent.identity.started > next.identity.started
            || !linked(&next.identity, &parent.identity)
        {
            break;
        }
        next = parent;
    }
    if let Some(source) = &group.origin {
        push_source(&mut context.sources, source.clone());
    }
    let exe = Path::new(&root.identity.executable);
    if exe
        .file_name()
        .is_some_and(|name| name == "crashpad_handler")
    {
        if let Some(parent) = exe
            .parent()
            .filter(|p| p.file_name().is_some_and(|name| name == "emulator"))
        {
            if exe.is_file() && parent.join("emulator").is_file() && parent.join("qemu").is_dir() {
                context.name = Some("Android 模拟器崩溃报告".into());
                push_source(
                    &mut context.sources,
                    SourceOrigin {
                        name: "Android 模拟器".into(),
                        app_path: None,
                        evidence: "Android SDK 组件路径（不指向某个模拟器实例）".into(),
                    },
                );
            }
        }
    }
    context
}

fn nonempty(context: Presentation) -> Option<Presentation> {
    (context.name.is_some() || !context.sources.is_empty() || !context.services.is_empty())
        .then_some(context)
}

fn service_icon(context: &Presentation) -> Option<&'static str> {
    if context.services.len() != 1 {
        return None;
    }
    match context.services[0].label.as_str() {
        "homebrew.mxcl.mysql" | "homebrew.mxcl.mysql@8.0" | "homebrew.mxcl.mysql@8.4" => {
            Some("mysql")
        }
        "homebrew.mxcl.redis" => Some("redis"),
        label
            if label == "homebrew.mxcl.postgresql"
                || label.starts_with("homebrew.mxcl.postgresql@") =>
        {
            Some("postgresql")
        }
        _ => None,
    }
}

fn decorate(
    groups: &mut [Group],
    evidence: &Evidence,
    own_uid: u32,
    current: impl Fn(&Identity) -> bool,
    linked: impl Fn(&Identity, &Identity) -> bool,
) {
    let annotations: Vec<_> = {
        let by: HashMap<_, _> = groups
            .iter()
            .flat_map(|g| &g.processes)
            .map(|p| (p.identity.pid, p))
            .collect();
        groups
            .iter()
            .map(|group| {
                let instances: Vec<_> = group
                    .instances
                    .iter()
                    .map(|instance| {
                        by.get(&instance.root.pid)
                            .filter(|p| p.identity == instance.root && p.identity.uid == own_uid)
                            .map(|root| {
                                instance_context(root, group, &by, evidence, &current, &linked)
                            })
                            .and_then(nonempty)
                    })
                    .collect();
                let mut summary = Presentation::default();
                let names: Vec<_> = instances
                    .iter()
                    .map(|context| context.as_ref().and_then(|context| context.name.as_ref()))
                    .collect();
                if let Some(Some(first)) = names.first() {
                    if names.iter().all(|name| *name == Some(*first)) {
                        summary.name = Some((*first).clone());
                    }
                }
                if summary.name.is_none()
                    && !instances.is_empty()
                    && instances.iter().all(|context| {
                        context.as_ref().is_some_and(|context| {
                            context.services.len() == 1
                                && ["colima:", "colima-vm:", "colima-network:"]
                                    .iter()
                                    .any(|prefix| context.services[0].label.starts_with(prefix))
                        })
                    })
                {
                    summary.name = Some("Colima 服务".into());
                }
                for context in instances.iter().flatten() {
                    for source in &context.sources {
                        push_source(&mut summary.sources, source.clone());
                    }
                    for service in &context.services {
                        if !summary.services.contains(service) {
                            summary.services.push(service.clone());
                        }
                    }
                }
                (nonempty(summary), instances)
            })
            .collect()
    };
    for (group, (summary, instances)) in groups.iter_mut().zip(annotations) {
        // Icon metadata follows the already computed instances. A tmux source
        // never gives an SSH job a tmux icon, and mixed services keep their own
        // runtime icon rather than borrowing the first instance's brand.
        if group.icon_key.is_none() {
            let icons: Vec<_> = instances
                .iter()
                .map(|context| context.as_ref().and_then(service_icon))
                .collect();
            if let Some(Some(first)) = icons.first() {
                if icons.iter().all(|icon| icon == &Some(*first)) {
                    group.icon_key = Some((*first).into());
                }
            }
            if group.icon_key.is_none()
                && !group.processes.is_empty()
                && group
                    .processes
                    .iter()
                    .all(|p| evidence.mux.get(&p.identity.pid) == Some(&p.identity))
            {
                group.icon_key = Some("tmux".into());
            }
        }
        group.presentation = summary;
        for (instance, context) in group.instances.iter_mut().zip(instances) {
            instance.presentation = context;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{group_processes, tests::process, RuntimeProject};
    use serde_json::{json, Value};

    fn actions(groups: &[Group]) -> Value {
        let mut value = serde_json::to_value(groups).unwrap();
        for group in value.as_array_mut().unwrap() {
            group.as_object_mut().unwrap().remove("presentation");
            group.as_object_mut().unwrap().remove("iconKey");
            for instance in group["instances"].as_array_mut().unwrap() {
                instance.as_object_mut().unwrap().remove("presentation");
            }
        }
        value
    }
    fn record(p: &Process, label: &str) -> (Identity, ServiceInfo) {
        (
            p.identity.clone(),
            ServiceInfo {
                name: service_name(label),
                label: label.into(),
                evidence: "fixture launchd".into(),
            },
        )
    }
    #[test]
    fn display_enrichment_preserves_all_members_instances_and_action_fields() {
        let app = process(10, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT");
        let mut first = process(20, 10, "/runtime/node");
        let mut second = process(30, 10, "/runtime/node");
        for p in [&mut first, &mut second] {
            p.runtime_project = Some(RuntimeProject {
                name: "artifact-tool".into(),
                root: "/tool".into(),
                entry: None,
                evidence: "fixture".into(),
            });
        }
        let python = process(40, 1, "/runtime/python3.11");
        let mut evidence = Evidence::default();
        evidence
            .services
            .insert(40, record(&python, "com.mycelia.service"));
        let mut groups = group_processes(vec![app, first, second, python], 501);
        let before = actions(&groups);
        decorate(&mut groups, &evidence, 501, |_| true, |_, _| true);
        assert_eq!(actions(&groups), before);
        let project = groups.iter().find(|g| g.name == "artifact-tool").unwrap();
        assert_eq!(project.instances.len(), 2);
        assert!(project.app_path.is_none());
        assert!(project.origin.is_none());
        assert_eq!(
            project.presentation.as_ref().unwrap().sources[0]
                .app_path
                .as_deref(),
            Some("/Applications/ChatGPT.app")
        );
        assert!(crate::instances::members(project, None).is_err());
        for instance in &project.instances {
            assert_eq!(
                crate::instances::members(project, Some(&instance.id))
                    .unwrap()
                    .1
                    .len(),
                1
            );
        }
        let service = groups.iter().find(|g| g.name == "python3.11").unwrap();
        assert_eq!(
            service.presentation.as_ref().unwrap().name.as_deref(),
            Some("Mycelia 服务")
        );
    }
    #[test]
    fn mixed_services_and_application_sources_are_kept_on_their_own_instances() {
        let a = process(1, 0, "/Applications/One.app/Contents/MacOS/One");
        let b = process(2, 0, "/Applications/Two.app/Contents/MacOS/Two");
        let mut first = process(20, 1, "/runtime/node");
        let mut second = process(30, 2, "/runtime/node");
        for p in [&mut first, &mut second] {
            p.runtime_project = Some(RuntimeProject {
                name: "same-project".into(),
                root: "/project".into(),
                entry: None,
                evidence: "fixture".into(),
            });
        }
        let mut groups = group_processes(vec![a, b, first, second], 501);
        let before = actions(&groups);
        decorate(
            &mut groups,
            &Evidence::default(),
            501,
            |_| true,
            |_, _| true,
        );
        assert_eq!(before, actions(&groups));
        let project = groups.iter().find(|g| g.name == "same-project").unwrap();
        assert_eq!(project.presentation.as_ref().unwrap().sources.len(), 2);
        assert_eq!(
            project.instances[0].presentation.as_ref().unwrap().sources[0].name,
            "One"
        );
        assert_eq!(
            project.instances[1].presentation.as_ref().unwrap().sources[0].name,
            "Two"
        );
        let a = process(40, 1, "/runtime/python3.12");
        let b = process(41, 1, "/runtime/python3.12");
        let mut evidence = Evidence::default();
        evidence
            .services
            .insert(40, record(&a, "com.mycelia.service"));
        evidence
            .services
            .insert(41, record(&b, "com.toolkit.ssh-network.instance"));
        let mut groups = group_processes(vec![a, b], 501);
        let before = actions(&groups);
        decorate(&mut groups, &evidence, 501, |_| true, |_, _| true);
        assert_eq!(before, actions(&groups));
        assert_eq!(groups.len(), 1);
        let context = groups[0].presentation.as_ref().unwrap();
        assert!(context.name.is_none());
        assert_eq!(context.services.len(), 2);
    }
    #[test]
    fn tmux_hints_for_an_unreadable_manager_do_not_regroup_or_unprotect_ssh() {
        let mut mux = process(10, 1, "");
        mux.name = "tmux".into();
        mux.protected = true;
        let first = process(20, 10, "/usr/bin/ssh");
        let second = process(21, 10, "/usr/bin/ssh");
        let wrapper = process(30, 1, "/bin/bash");
        let mut evidence = Evidence::default();
        evidence.mux.insert(10, mux.identity.clone());
        evidence
            .services
            .insert(30, record(&wrapper, "homebrew.mxcl.mysql"));
        let mut groups = group_processes(vec![mux, first, second, wrapper], 501);
        let before = actions(&groups);
        decorate(&mut groups, &evidence, 501, |_| true, |_, _| true);
        assert_eq!(before, actions(&groups));
        let ssh = groups.iter().find(|g| g.name == "ssh").unwrap();
        assert_eq!(ssh.instances.len(), 2);
        assert!(ssh.origin.is_none());
        assert!(ssh.app_path.is_none());
        assert!(
            ssh.icon_key.is_none(),
            "source-only tmux must not change SSH's own icon"
        );
        let manager = groups.iter().find(|g| g.name == "tmux").unwrap();
        assert_eq!(manager.icon_key.as_deref(), Some("tmux"));
        assert!(manager.processes[0].protected);
        assert!(manager.processes[0].identity.executable.is_empty());
        assert_eq!(
            groups
                .iter()
                .find(|g| g.name == "bash")
                .unwrap()
                .icon_key
                .as_deref(),
            Some("mysql")
        );
        for instance in &ssh.instances {
            assert_eq!(
                instance.presentation.as_ref().unwrap().sources[0].name,
                "tmux"
            );
        }
    }
    #[test]
    fn colima_summary_preserves_distinct_vm_and_network_instance_labels() {
        let vm = process(20, 1, "/runtime/limactl");
        let network = process(21, 1, "/runtime/limactl");
        let mut evidence = Evidence::default();
        evidence.services.insert(
            20,
            (
                vm.identity.clone(),
                ServiceInfo {
                    name: "Colima 虚拟机 · colima".into(),
                    label: "colima-vm:colima".into(),
                    evidence: "PID file".into(),
                },
            ),
        );
        evidence.services.insert(
            21,
            (
                network.identity.clone(),
                ServiceInfo {
                    name: "Colima 网络服务 · user-v2".into(),
                    label: "colima-network:user-v2".into(),
                    evidence: "PID file".into(),
                },
            ),
        );
        let mut groups = group_processes(vec![vm, network], 501);
        let before = actions(&groups);
        decorate(&mut groups, &evidence, 501, |_| true, |_, _| true);
        assert_eq!(before, actions(&groups));
        assert_eq!(
            groups[0].presentation.as_ref().unwrap().name.as_deref(),
            Some("Colima 服务")
        );
        assert_eq!(groups[0].instances.len(), 2);
        assert!(crate::instances::members(&groups[0], None).is_err());
        assert_ne!(
            groups[0].instances[0].presentation.as_ref().unwrap().name,
            groups[0].instances[1].presentation.as_ref().unwrap().name
        );
    }
    #[test]
    fn an_unknown_registration_does_not_replace_an_existing_app_or_project_name() {
        let app = process(10, 1, "/Applications/magpie.app/Contents/MacOS/magpie");
        let mut project = process(20, 1, "/runtime/node");
        project.runtime_project = Some(RuntimeProject {
            name: "openclaw".into(),
            root: "/project".into(),
            entry: None,
            evidence: "fixture".into(),
        });
        let mut evidence = Evidence::default();
        evidence
            .services
            .insert(10, record(&app, "com.yetone.magpie"));
        evidence
            .services
            .insert(20, record(&project, "ai.openclaw.gateway"));
        let mut groups = group_processes(vec![app, project], 501);
        let before = actions(&groups);
        decorate(&mut groups, &evidence, 501, |_| true, |_, _| true);
        assert_eq!(before, actions(&groups));
        for group in &groups {
            assert!(group.presentation.as_ref().unwrap().name.is_none());
        }
        assert_eq!(
            groups
                .iter()
                .find(|g| g.name == "openclaw")
                .unwrap()
                .presentation
                .as_ref()
                .unwrap()
                .sources[0]
                .name,
            "openclaw"
        );
    }
    #[test]
    fn changed_foreign_and_broken_parent_links_never_supply_hints() {
        let app = process(10, 1, "/Applications/Example.app/Contents/MacOS/Main");
        let mut job = process(20, 10, "/runtime/node");
        job.runtime_project = Some(RuntimeProject {
            name: "tool".into(),
            root: "/tool".into(),
            entry: None,
            evidence: "fixture".into(),
        });
        for scenario in 0..5 {
            let mut owner = app.clone();
            if scenario == 0 {
                owner.identity.uid = 502;
            }
            if scenario == 1 {
                owner.identity.started = 200;
            }
            let mut groups = group_processes(vec![owner, job.clone()], 501);
            let before = actions(&groups);
            decorate(
                &mut groups,
                &Evidence::default(),
                501,
                |id| (scenario != 2 || id.pid != 20) && (scenario != 4 || id.pid != 10),
                |_, _| scenario != 3,
            );
            assert_eq!(before, actions(&groups));
            assert!(groups
                .iter()
                .find(|g| g.name == "tool")
                .unwrap()
                .presentation
                .is_none());
        }
    }
    #[test]
    fn launch_services_and_pid_records_require_current_same_user_identities() {
        let p = process(20, 1, "/runtime/limactl");
        let mut foreign = process(21, 1, "/runtime/python");
        foreign.identity.uid = 502;
        let ps = [p.clone(), foreign];
        let by = ps.iter().map(|p| (p.identity.pid, p)).collect();
        let list = "20 0 com.mycelia.service\n21 0 com.mycelia.service\n99 0 unknown\n20 0 application.foreground\n";
        let records = launch_services(list, &by, 501, &|_| true);
        assert_eq!(records.len(), 1);
        assert_eq!(records[&20].1.name, "Mycelia 服务");
        assert!(launch_services(list, &by, 501, &|_| false).is_empty());
        let root = std::env::temp_dir().join(format!("flowhub-service-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("ha.pid");
        std::fs::write(&file, "20\n").unwrap();
        let info = records[&20].1.clone();
        assert!(pid_file(&file, "limactl", info.clone(), &by, 501, &|_| true).is_some());
        assert!(pid_file(&file, "colima", info.clone(), &by, 501, &|_| true).is_none());
        assert!(pid_file(&file, "limactl", info.clone(), &by, 502, &|_| true).is_none());
        let mut newer = p;
        newer.identity.started = (SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_micros()
            + 10_000_000) as u64;
        let newer_by = HashMap::from([(20, &newer)]);
        assert!(pid_file(&file, "limactl", info, &newer_by, 501, &|_| true).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn emulator_reporter_has_a_product_hint_without_an_emulator_action_scope() {
        let root = std::env::temp_dir().join(format!("flowhub-sdk-{}", uuid::Uuid::new_v4()));
        let emulator = root.join("emulator");
        std::fs::create_dir_all(emulator.join("qemu")).unwrap();
        std::fs::write(emulator.join("emulator"), b"fixture").unwrap();
        let file = emulator.join("crashpad_handler");
        std::fs::write(&file, b"fixture").unwrap();
        let p = process(20, 1, file.to_str().unwrap());
        let mut groups = group_processes(vec![p], 501);
        let before = actions(&groups);
        decorate(
            &mut groups,
            &Evidence::default(),
            501,
            |_| true,
            |_, _| true,
        );
        assert_eq!(before, actions(&groups));
        assert_eq!(
            groups[0].presentation.as_ref().unwrap().name.as_deref(),
            Some("Android 模拟器崩溃报告")
        );
        assert!(groups[0].app_path.is_none());
        assert!(groups[0].origin.is_none());
        assert_eq!(json!(groups[0].instances[0].root.pid), json!(20));
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
#[path = "service_budget_tests.rs"]
mod budget_tests;
