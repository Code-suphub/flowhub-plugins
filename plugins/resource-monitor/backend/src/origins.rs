//! Recover display ownership for helpers whose current executable path is unreadable.
//! A verified launch path does not grant signal permission or recreate a parent edge.
use crate::model::{self, Identity, Process};
use std::{
    collections::HashMap,
    path::{Component, Path},
};

fn launch_bundle(executable: &str) -> Option<String> {
    let path = Path::new(executable);
    if !path.is_absolute()
        || executable.len() > 4096
        || executable.chars().any(char::is_control)
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return None;
    }
    let (key, _) = model::app_bundle(executable)?;
    let bundle = Path::new(key.strip_prefix("app:")?).canonicalize().ok()?;
    let actual = path.canonicalize().ok()?;
    // Reject missing/old binaries and symlinks escaping the real bundle. A name
    // such as ChatGPT in argv, cwd, a label or a non-bundle directory is insufficient.
    if bundle.extension()?.to_str()? != "app"
        || !bundle.join("Contents/Info.plist").is_file()
        || !actual.is_file()
        || !actual.starts_with(bundle.join("Contents"))
    {
        return None;
    }
    Some(bundle.to_string_lossy().into_owned())
}

pub fn resolve(
    processes: &mut [Process],
    own_uid: u32,
    read_launch: impl Fn(&Identity) -> Option<String>,
    current: impl Fn(&Identity) -> bool,
) {
    let mut bundles = HashMap::new();
    for process in processes {
        let id = &process.identity;
        if id.uid != own_uid
            || id.started == 0
            || !id.executable.is_empty()
            || process.registered_app_path.is_some()
            || !current(id)
        {
            continue;
        }
        let Some(path) = read_launch(id) else {
            continue;
        };
        let Some(bundle) = bundles
            .entry(path.clone())
            .or_insert_with(|| launch_bundle(&path))
            .as_ref()
        else {
            continue;
        };
        if !current(id) {
            continue;
        }
        process.registered_app_path = Some(bundle.clone());
        if process.display_name.is_none() {
            process.display_name = Path::new(&path)
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| *name != process.name)
                .map(str::to_string);
        }
        process.launch_executable = Some(path);
        // Deliberately retain the empty executable, protection, PPID and root identity.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{group_processes, tests::process};
    use std::{cell::Cell, fs, os::unix::fs::symlink, path::PathBuf};

    struct Fixture {
        root: PathBuf,
        bundle: PathBuf,
        helper: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("flowhub-origins-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let root = root.canonicalize().unwrap();
            let bundle = root.join("Example.app");
            let helper = bundle.join("Contents/Resources/native/bare-modifier-monitor");
            fs::create_dir_all(helper.parent().unwrap()).unwrap();
            fs::write(bundle.join("Contents/Info.plist"), b"fixture").unwrap();
            fs::write(&helper, b"fixture helper").unwrap();
            Self {
                root,
                bundle,
                helper,
            }
        }
        fn path(&self) -> String {
            self.helper.to_string_lossy().into_owned()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn launch_path_requires_real_bundle_files_without_symlink_escape_or_traversal() {
        let f = Fixture::new();
        assert_eq!(
            launch_bundle(&f.path()),
            Some(f.bundle.to_string_lossy().into_owned())
        );
        let outside = f.root.join("outside-helper");
        fs::write(&outside, b"outside").unwrap();
        let escaped = f.helper.parent().unwrap().join("escape");
        symlink(&outside, &escaped).unwrap();
        for path in [
            outside.to_string_lossy().into_owned(),
            escaped.to_string_lossy().into_owned(),
            f.helper
                .parent()
                .unwrap()
                .join("../native/bare-modifier-monitor")
                .to_string_lossy()
                .into_owned(),
            "Example.app/Contents/MacOS/relative".into(),
            format!("{}/missing", f.bundle.display()),
        ] {
            assert!(launch_bundle(&path).is_none(), "must reject {path}");
        }
        fs::remove_file(f.bundle.join("Contents/Info.plist")).unwrap();
        assert!(launch_bundle(&f.path()).is_none());
        fs::write(f.bundle.join("Contents/Info.plist"), b"fixture").unwrap();
        fs::remove_file(&f.helper).unwrap();
        assert!(
            launch_bundle(&f.path()).is_none(),
            "old deleted helper must not be reassigned"
        );
    }

    #[test]
    fn display_ownership_preserves_protection_identity_and_independent_instance() {
        let f = Fixture::new();
        let mut helper = process(20, 1, "");
        helper.name = "bare-modifier-m".into();
        helper.protected = true;
        helper.protection = "无法核实可执行路径".into();
        let original = helper.identity.clone();
        let mut processes = vec![helper];
        resolve(&mut processes, 501, |_| Some(f.path()), |_| true);
        let helper = processes.pop().unwrap();
        assert_eq!(helper.identity, original);
        assert_eq!(helper.ppid, 1);
        assert!(helper.protected);
        assert_eq!(helper.protection, "无法核实可执行路径");
        assert_eq!(
            helper.display_name.as_deref(),
            Some("bare-modifier-monitor")
        );
        assert_eq!(helper.launch_executable.as_deref(), Some(f.path().as_str()));
        let main = process(
            10,
            1,
            &format!("{}/Contents/MacOS/Main", f.bundle.display()),
        );
        let mut groups = group_processes(vec![main, helper], 501);
        assert_eq!(groups.len(), 1);
        let group = groups.pop().unwrap();
        assert_eq!(group.source, "应用包及启动路径");
        assert_eq!(group.footprint, Some(300));
        assert_eq!(group.processes.len(), 2);
        assert_eq!(group.instances.len(), 2);
        assert!(!group.can_terminate);
        let instance = group.instances.iter().find(|i| i.root.pid == 20).unwrap();
        assert_eq!(instance.root, original);
        assert!(!instance.can_terminate);
        assert_eq!(
            group
                .processes
                .iter()
                .find(|p| p.identity.pid == 20)
                .unwrap()
                .attribution,
            "启动路径归属"
        );
    }

    #[test]
    fn foreign_uid_known_path_existing_owner_and_changed_identity_are_not_overwritten() {
        let f = Fixture::new();
        let mut foreign = process(10, 1, "");
        foreign.identity.uid = 502;
        let known = process(11, 1, "/usr/bin/sleep");
        let mut registered = process(12, 1, "");
        registered.registered_app_path = Some("/Applications/Registered.app".into());
        let mut unknown = process(13, 1, "");
        unknown.identity.started = 0;
        let changed = process(20, 1, "");
        let read = Cell::new(false);
        let mut processes = vec![foreign, known, registered, unknown, changed];
        resolve(
            &mut processes,
            501,
            |id| {
                assert_eq!(id.pid, 20);
                read.set(true);
                Some(f.path())
            },
            |_| !read.get(),
        );
        assert!(read.get());
        assert!(processes.iter().all(|p| p.launch_executable.is_none()));
        assert_eq!(
            processes[2].registered_app_path.as_deref(),
            Some("/Applications/Registered.app")
        );
        assert!(
            processes[4].registered_app_path.is_none(),
            "PID identity changed after reading launch path"
        );
    }

    #[test]
    fn rpc_data_cannot_supply_local_launch_ownership_evidence() {
        let mut value = serde_json::to_value(process(10, 1, "")).unwrap();
        value["launchExecutable"] = "/Applications/Example.app/Contents/MacOS/Fake".into();
        value["registeredAppPath"] = "/Applications/Example.app".into();
        let process: Process = serde_json::from_value(value).unwrap();
        assert!(process.launch_executable.is_none());
        assert!(process.registered_app_path.is_none());
    }
}
