//! Graceful GUI application quit; independent of protected process termination.
use crate::{
    model::{self, Group, Identity, Process},
    native,
};
use objc2::rc::{autoreleasepool, Retained};
use objc2_app_kit::{NSApplicationActivationPolicy, NSRunningApplication, NSWorkspace};
use objc2_foundation::{NSDate, NSRunLoop};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

struct Target {
    identity: Identity,
    app: Retained<NSRunningApplication>,
}
fn appkit_turn() {
    // This RPC process otherwise waits on stdin rather than an AppKit loop.
    NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.001));
}

/// Chromium may move its executable to a signing clone while Launch Services
/// continues to identify the original app. Accept only that exact layout, plus
/// the same bundle identifier and relative executable reported for this PID.
fn signing_clone_root(
    actual: &str,
    bundle: &Path,
    executable: &Path,
    bundle_id: &str,
) -> Option<PathBuf> {
    if bundle_id.is_empty() || bundle_id.contains('/') {
        return None;
    }
    let relative = executable.strip_prefix(bundle).ok()?;
    if !relative.starts_with("Contents/MacOS") || relative.components().count() != 3 {
        return None;
    }
    let actual = Path::new(actual);
    let root = actual.parent()?.parent()?.parent()?;
    let name = bundle.file_name()?.to_str()?;
    if root.file_name()?.to_str()? != format!("{name}.bundle")
        && root.file_name()?.to_str()? != name
    {
        return None;
    }
    let unique = root.parent()?;
    let suffix = unique
        .file_name()?
        .to_str()?
        .strip_prefix("code_sign_clone.")?;
    if suffix.len() < 6
        || !suffix
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return None;
    }
    let container = unique.parent()?;
    if container.file_name()?.to_str()? != format!("{bundle_id}.code_sign_clone")
        || container.parent()?.file_name()?.to_str()? != "X"
        || root.join(relative) != actual
    {
        return None;
    }
    Some(root.into())
}

/// Preserve the real executable in each process; use verified app paths only
/// for grouping. Never infer an installed app from a clone's name alone.
fn registered_owner(bundle: &Path, executable: &Path) -> Option<PathBuf> {
    let relative = executable.strip_prefix(bundle).ok()?;
    if !relative.starts_with("Contents/MacOS") || relative.components().count() != 3 {
        return None;
    }
    let (key, _) = model::app_bundle(&executable.to_string_lossy())?;
    let outer = Path::new(key.strip_prefix("app:")?).canonicalize().ok()?;
    if !bundle.starts_with(&outer) || !outer.join("Contents/Info.plist").is_file() {
        return None;
    }
    Some(outer)
}

pub fn resolve_bundle_paths(processes: &mut [Process]) {
    autoreleasepool(|_| {
        appkit_turn();
        resolve_display_names(processes);
        let mut clones = Vec::new();
        let mut registered = HashMap::new();
        for process in processes.iter() {
            let id = &process.identity;
            if id.uid != native::uid()
                || (!id.executable.is_empty()
                    && !id.executable.contains(".code_sign_clone/code_sign_clone."))
                || native::identity(id.pid).as_ref() != Some(id)
            {
                continue;
            }
            let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(id.pid)
            else {
                continue;
            };
            if app.isTerminated() {
                continue;
            }
            let Some(bundle) = app
                .bundleURL()
                .and_then(|url| url.path())
                .and_then(|p| Path::new(&p.to_string()).canonicalize().ok())
            else {
                continue;
            };
            let Some(executable) = app
                .executableURL()
                .and_then(|url| url.path())
                .map(|p| PathBuf::from(p.to_string()))
            else {
                continue;
            };
            let Some(bundle_id) = app.bundleIdentifier() else {
                continue;
            };
            if id.executable.is_empty() {
                if let Some(outer) = registered_owner(&bundle, &executable) {
                    if native::identity(id.pid).as_ref() == Some(id) {
                        registered.insert(id.pid, (id.clone(), outer));
                    }
                }
                continue;
            }
            if let Some(root) =
                signing_clone_root(&id.executable, &bundle, &executable, &bundle_id.to_string())
            {
                if native::identity(id.pid).as_ref() == Some(id) {
                    clones.push((root, bundle));
                }
            }
        }
        for process in processes {
            if process.identity.uid != native::uid() {
                continue;
            }
            if let Some((id, path)) = registered.get(&process.identity.pid) {
                if *id == process.identity && native::identity(id.pid).as_ref() == Some(id) {
                    process.registered_app_path = Some(path.to_string_lossy().into_owned());
                }
            }
            if let Some((_, bundle)) = clones
                .iter()
                .find(|(root, _)| Path::new(&process.identity.executable).starts_with(root))
            {
                if native::identity(process.identity.pid).as_ref() == Some(&process.identity) {
                    process.registered_app_path = Some(bundle.to_string_lossy().into_owned());
                }
            }
        }
    });
}

fn resolve_display_names(processes: &mut [Process]) {
    // Activity Monitor can show a Launch Services name that differs from both
    // the kernel name and executable (e.g. ZenCP WebExtensions/plugin-container).
    // Labels are presentation/search metadata only, never process identity.
    let apps = NSWorkspace::sharedWorkspace().runningApplications();
    let by_pid: HashMap<_, _> = (0..apps.count()).map(|index| {
        let app = apps.objectAtIndex(index);
        (app.processIdentifier(), app)
    }).collect();
    for process in processes {
        let id = &process.identity;
        let Some(app) = by_pid.get(&id.pid) else { continue; };
        if id.uid != native::uid() || app.isTerminated()
            || native::identity(id.pid).as_ref() != Some(id) { continue; }
        let Some(name) = app.localizedName().map(|name| name.to_string()) else { continue; };
        let name = name.trim();
        if name.is_empty() || name == process.name || name.chars().count() > 256
            || name.chars().any(char::is_control) { continue; }
        if !app.isTerminated() && native::identity(id.pid).as_ref() == Some(id) {
            process.display_name = Some(name.into());
        }
    }
}

fn targets(group: &Group) -> Result<Vec<Target>, String> {
    autoreleasepool(|_| {
        // NSRunningApplication's changing properties update on a run-loop turn.
        appkit_turn();
        find_targets(group)
    })
}
fn find_targets(group: &Group) -> Result<Vec<Target>, String> {
    if group.origin.is_some() {
        return Err("这是独立任务，来源关联不能用于退出应用".into());
    }
    let Some(path) = group.app_path.as_deref() else {
        return Err("这是系统服务或独立进程，可在下方查看进程信息。".into());
    };
    if path.ends_with("/FlowHub.app") || path.contains("/System/Library/CoreServices/") {
        return Err("当前应用承载监控或系统服务，请从应用自身的菜单处理".into());
    }
    let expected = Path::new(path)
        .canonicalize()
        .map_err(|_| "应用包已移动，请刷新")?;
    let prefix = format!("{path}/Contents/MacOS/");
    let mut found = Vec::new();
    let mut main_seen = false;
    let mut background_main = false;
    for process in &group.processes {
        let id = &process.identity;
        if id.uid != native::uid()
            || (!id.executable.starts_with(&prefix)
                && process.registered_app_path.as_deref() != Some(path))
            || native::identity(id.pid).as_ref() != Some(id)
        {
            continue;
        }
        if process.protection == "FlowHub 及其宿主进程" {
            return Err("当前应用承载监控服务，不能从监控中退出".into());
        }
        // Clone helpers have the same grouping alias, but are not main executables.
        if process.registered_app_path.is_some() && !id.executable.contains("/Contents/MacOS/") {
            continue;
        }
        main_seen = true;
        let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(id.pid)
        else {
            continue;
        };
        if app.isTerminated() {
            continue;
        }
        let actual = app
            .bundleURL()
            .and_then(|url| url.path())
            .map(|path| path.to_string());
        if actual
            .and_then(|path| Path::new(&path).canonicalize().ok())
            .as_ref()
            != Some(&expected)
        {
            continue;
        }
        let Some(executable) = app
            .executableURL()
            .and_then(|url| url.path())
            .map(|p| PathBuf::from(p.to_string()))
        else {
            continue;
        };
        let direct = executable.starts_with(expected.join("Contents/MacOS"))
            && executable
                .strip_prefix(&expected)
                .is_ok_and(|p| p.components().count() == 3)
            && matches!((Path::new(&id.executable).canonicalize(), executable.canonicalize()), (Ok(actual), Ok(registered)) if actual == registered);
        let clone = app.bundleIdentifier().is_some_and(|bundle_id| {
            signing_clone_root(
                &id.executable,
                &expected,
                &executable,
                &bundle_id.to_string(),
            )
            .is_some()
        });
        if !direct && !clone {
            continue;
        }
        if app.activationPolicy() != NSApplicationActivationPolicy::Regular {
            background_main = true;
            continue;
        }
        if !app.isFinishedLaunching() {
            return Err("主应用正在启动，请稍后重试".into());
        }
        found.push(Target {
            identity: id.clone(),
            app,
        });
    }
    if found.is_empty() {
        return Err(if background_main {
            "主程序以无界面或后台模式运行，无法使用应用级退出；可在下方查看并结束对应进程。"
        } else if main_seen {
            "已找到主进程，但 macOS 未提供可校验的应用退出入口；请刷新或从应用自身退出。"
        } else {
            "主应用未运行，当前只剩后台或辅助进程。"
        }
        .into());
    }
    found.sort_by_key(|target| target.identity.pid);
    Ok(found)
}

struct Plan {
    created: Instant,
    group: String,
    path: String,
    identities: Vec<Identity>,
    instance: String,
}

fn scoped_group(group: &Group, instance: &str) -> Result<Group, String> {
    crate::instances::members(group, Some(instance))?;
    let mut scoped = group.clone();
    scoped
        .processes
        .retain(|process| process.instance_id == instance);
    scoped.instances.retain(|item| item.id == instance);
    Ok(scoped)
}
#[derive(Default)]
pub struct Quitter {
    plans: HashMap<String, Plan>,
}
impl Quitter {
    pub fn state(group: &Group) -> Value {
        match targets(group) {
            Ok(found) => {
                let ids: std::collections::HashSet<_> = group
                    .processes
                    .iter()
                    .filter(|p| found.iter().any(|target| target.identity == p.identity))
                    .map(|p| p.instance_id.clone())
                    .collect();
                json!({"canQuit":ids.len()==1,"instances":found.len(),"quitInstances":ids,
                    "message":if ids.len()>1 {"检测到多个界面实例，请在“启动实例”中选择要退出的实例。"} else {"向选中实例发送正常退出请求，应用可能提示保存内容。后台服务可能继续运行。"}})
            }
            Err(reason) => {
                json!({"canQuit":false,"instances":0,"quitInstances":[],"message":reason})
            }
        }
    }
    pub fn preview(&mut self, group: &Group, requested: Option<&str>) -> Result<Value, String> {
        let instance = if let Some(id) = requested {
            id.to_string()
        } else {
            let found = targets(group)?;
            let ids: std::collections::HashSet<_> = group
                .processes
                .iter()
                .filter(|p| found.iter().any(|target| target.identity == p.identity))
                .map(|p| p.instance_id.clone())
                .collect();
            if ids.len() != 1 {
                return Err("包含多个界面实例，请先选择要退出的实例".into());
            }
            ids.into_iter().next().unwrap()
        };
        let scoped = scoped_group(group, &instance)?;
        let targets = targets(&scoped)?;
        self.plans
            .retain(|_, plan| plan.created.elapsed() < Duration::from_secs(30));
        if self.plans.len() >= 16 {
            return Err("待确认操作过多，请稍后重试".into());
        }
        let token = uuid::Uuid::new_v4().to_string();
        let path = group.app_path.clone().ok_or("没有所属应用")?;
        let identities: Vec<_> = targets.into_iter().map(|target| target.identity).collect();
        let response = json!({"token":token,"expiresIn":30,"name":group.name,"appPath":path,
            "targets":identities,"instanceId":instance,"root":scoped.instances[0].root});
        self.plans.insert(
            token,
            Plan {
                created: Instant::now(),
                group: group.id.clone(),
                path,
                identities,
                instance,
            },
        );
        Ok(response)
    }
    pub fn validate(&self, params: &Value) -> Result<(), String> {
        if params["confirmed"] != true {
            return Err("请先确认退出应用及影响范围".into());
        }
        let plan = params["token"]
            .as_str()
            .and_then(|token| self.plans.get(token))
            .ok_or("退出确认已失效，请重新选择")?;
        if plan.created.elapsed() >= Duration::from_secs(30) {
            return Err("退出确认已过期，请重新选择".into());
        }
        Ok(())
    }
    pub fn execute(&mut self, params: &Value, groups: &[Group]) -> Result<Value, String> {
        self.validate(params)?;
        let plan = self
            .plans
            .remove(params["token"].as_str().unwrap())
            .unwrap();
        let group = groups
            .iter()
            .find(|g| g.id == plan.group && g.app_path.as_ref() == Some(&plan.path))
            .ok_or("应用已退出或归属改变，请刷新")?;
        let current = targets(&scoped_group(group, &plan.instance)?)?;
        if !model::same_targets(
            &plan.identities,
            &current
                .iter()
                .map(|target| target.identity.clone())
                .collect::<Vec<_>>(),
        ) || current
            .iter()
            .any(|target| native::identity(target.identity.pid).as_ref() != Some(&target.identity))
        {
            return Err("主应用实例或进程身份已变化，请重新确认".into());
        }
        let results: Vec<_> = current
            .into_iter()
            .map(|target| {
                let requested = native::identity(target.identity.pid).as_ref()
                    == Some(&target.identity)
                    && autoreleasepool(|_| target.app.terminate());
                json!({"pid":target.identity.pid,"requested":requested})
            })
            .collect();
        Ok(
            json!({"requested":results.iter().all(|result| result["requested"] == true),"results":results}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_source_association_never_authorizes_application_quit() {
        let mut group=model::group_processes(vec![model::tests::process(10,1,"/Applications/Example.app/Contents/MacOS/Example")],501).remove(0);
        group.origin=Some(model::SourceOrigin{name:"Example".into(),app_path:Some("/Applications/Example.app".into()),evidence:"source only".into()});
        let error=find_targets(&group).err().expect("source-only group must be rejected before AppKit target discovery");
        assert!(error.contains("独立任务"));
    }
    #[test]
    fn registered_login_item_resolves_to_its_outer_bundle_by_path() {
        let root = std::env::temp_dir().join(format!("flowhub-owner-{}", uuid::Uuid::new_v4()));
        let outer = root.join("Office.app");
        let helper = outer.join("Contents/Library/LoginItems/Helper.app");
        std::fs::create_dir_all(helper.join("Contents/MacOS")).unwrap();
        std::fs::write(outer.join("Contents/Info.plist"), "fixture").unwrap();
        let helper = helper.canonicalize().unwrap();
        let executable = helper.join("Contents/MacOS/Helper");
        assert_eq!(
            registered_owner(&helper, &executable),
            Some(outer.canonicalize().unwrap())
        );
        assert!(
            registered_owner(&helper, &root.join("Unrelated.app/Contents/MacOS/Helper")).is_none()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn clone_attribution_requires_matching_registered_bundle_and_executable() {
        let bundle = Path::new("/Applications/Google Chrome.app");
        let exe = bundle.join("Contents/MacOS/Google Chrome");
        let clone = "/private/var/folders/user/X/com.google.Chrome.code_sign_clone/code_sign_clone.Abc123/Google Chrome.app.bundle";
        let actual = format!("{clone}/Contents/MacOS/Google Chrome");
        assert_eq!(
            signing_clone_root(&actual, bundle, &exe, "com.google.Chrome"),
            Some(clone.into())
        );
        assert!(signing_clone_root(&actual, bundle, &exe, "com.other.Chrome").is_none());
        assert!(signing_clone_root(
            &actual,
            Path::new("/Applications/Fake.app"),
            &exe,
            "com.google.Chrome"
        )
        .is_none());
        assert!(signing_clone_root(
            &actual.replace("/X/", "/T/"),
            bundle,
            &exe,
            "com.google.Chrome"
        )
        .is_none());
        assert!(signing_clone_root(
            &actual.replace("/Google Chrome.app.bundle/", "/Fake.app.bundle/"),
            bundle,
            &exe,
            "com.google.Chrome"
        )
        .is_none());
        assert!(signing_clone_root(
            &format!("{clone}/Contents/MacOS/Helper"),
            bundle,
            &exe,
            "com.google.Chrome"
        )
        .is_none());
        assert!(signing_clone_root(
            &format!("{clone}/Contents/Frameworks/Helper.app/Contents/MacOS/Helper"),
            bundle,
            &exe,
            "com.google.Chrome"
        )
        .is_none());
        assert!(signing_clone_root(
            &actual,
            bundle,
            &bundle.join("Contents/Resources/helper"),
            "com.google.Chrome"
        )
        .is_none());
    }
    #[test]
    fn quit_requires_a_fresh_single_purpose_confirmation_before_appkit_access() {
        let mut quitter = Quitter::default();
        assert!(quitter
            .execute(&json!({}), &[])
            .unwrap_err()
            .contains("确认"));
        assert!(quitter
            .execute(&json!({"confirmed":true,"token":"forged"}), &[])
            .unwrap_err()
            .contains("失效"));
        let identity = Identity {
            pid: 999999,
            started: 100,
            uid: native::uid(),
            executable: "/Example.app/Contents/MacOS/Example".into(),
        };
        quitter.plans.insert(
            "expired".into(),
            Plan {
                created: Instant::now() - Duration::from_secs(31),
                group: "group".into(),
                path: "/Example.app".into(),
                identities: vec![identity.clone()],
                instance: "instance".into(),
            },
        );
        assert!(quitter
            .execute(&json!({"confirmed":true,"token":"expired"}), &[])
            .unwrap_err()
            .contains("过期"));
        quitter.plans.insert(
            "valid".into(),
            Plan {
                created: Instant::now(),
                group: "group".into(),
                path: "/Example.app".into(),
                identities: vec![identity],
                instance: "instance".into(),
            },
        );
        assert!(quitter
            .execute(&json!({"confirmed":true,"token":"valid"}), &[])
            .unwrap_err()
            .contains("已退出"));
        assert!(!quitter.plans.contains_key("valid"));
    }
}
