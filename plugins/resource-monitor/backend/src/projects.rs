//! Attribute external Node runtimes using an entry file and bounded package metadata.
use crate::model::{Identity, Process, RuntimeProject};
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

fn manifest(root: &Path) -> Option<(PathBuf, String)> {
    let root = root.canonicalize().ok()?;
    let mut input = File::open(root.join("package.json"))
        .ok()?
        .take(128 * 1024 + 1);
    let mut data = Vec::new();
    input.read_to_end(&mut data).ok()?;
    if data.len() > 128 * 1024 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&data).ok()?;
    let name = value["name"].as_str()?.trim();
    if name.is_empty() || name.chars().count() > 128 || name.chars().any(char::is_control) {
        return None;
    }
    Some((root, name.into()))
}

fn identify(cwd: &str, entry: Option<String>) -> Option<RuntimeProject> {
    let cwd = Path::new(cwd);
    let working = cwd.is_absolute().then(|| manifest(cwd)).flatten();
    let entry = entry.and_then(|entry| {
        let path = Path::new(&entry);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else if cwd.is_absolute() {
            cwd.join(path)
        } else {
            return None;
        };
        path.canonicalize().ok().filter(|p| p.is_file())
    });
    if let Some(path) = &entry {
        if let Some((root, name)) = &working {
            // Dependencies (Umi/Tailwind etc.) launched inside the project belong
            // to that project, rather than becoming a group for each dependency.
            if path.starts_with(root) {
                return Some(RuntimeProject {
                    name: name.clone(),
                    root: root.to_string_lossy().into_owned(),
                    entry: Some(path.to_string_lossy().into_owned()),
                    evidence: "入口脚本与项目清单".into(),
                });
            }
        }
        for root in path.ancestors().skip(1).take(10) {
            if let Some((root, name)) = manifest(root) {
                return Some(RuntimeProject {
                    name,
                    root: root.to_string_lossy().into_owned(),
                    entry: Some(path.to_string_lossy().into_owned()),
                    evidence: "入口脚本与工具清单".into(),
                });
            }
        }
        // An unrelated entry file must not acquire the current directory's name.
        return None;
    }
    let (root, name) = working?;
    Some(RuntimeProject {
        name,
        root: root.to_string_lossy().into_owned(),
        entry: None,
        evidence: "工作目录推断".into(),
    })
}

pub fn resolve(
    processes: &mut [Process],
    own_uid: u32,
    read_entry: impl Fn(&Identity) -> Option<String>,
) {
    for process in processes {
        let id = &process.identity;
        if id.uid != own_uid
            || Path::new(&id.executable)
                .file_name()
                .is_none_or(|name| name != "node")
            || crate::model::app_bundle(&id.executable).is_some()
        {
            continue;
        }
        process.runtime_project = identify(&process.cwd, read_entry(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{group_processes, tests::process};
    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("flowhub-projects-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }
    fn package(root: &Path, name: &str, entry: &str) -> PathBuf {
        std::fs::create_dir_all(root.join(entry).parent().unwrap()).unwrap();
        std::fs::write(
            root.join("package.json"),
            serde_json::json!({"name":name}).to_string(),
        )
        .unwrap();
        std::fs::write(root.join(entry), "// fixture").unwrap();
        root.join(entry)
    }
    #[test]
    fn node_projects_use_entry_roots_keep_dependency_workers_and_do_not_guess_from_cwd() {
        let root = fixture();
        let web = root.join("web");
        let bridge = root.join("bridge");
        let dev = package(&web, "brc-web", "node_modules/umi/dev.js");
        let cli = package(&bridge, "codex-with-chatgpt", "dist/cli/index.js");
        assert_eq!(
            identify(
                web.to_str().unwrap(),
                Some(dev.to_string_lossy().into_owned())
            )
            .unwrap()
            .name,
            "brc-web"
        );
        assert_eq!(
            identify(
                web.to_str().unwrap(),
                Some(cli.to_string_lossy().into_owned())
            )
            .unwrap()
            .name,
            "codex-with-chatgpt"
        );
        let inferred = identify(web.to_str().unwrap(), None).unwrap();
        assert_eq!(inferred.evidence, "工作目录推断");
        let loose = root.join("loose.js");
        std::fs::write(&loose, "").unwrap();
        assert!(identify(
            web.to_str().unwrap(),
            Some(loose.to_string_lossy().into_owned())
        )
        .is_none());
        assert!(identify(root.to_str().unwrap(), None).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn groups_distinguish_same_named_projects_inherit_workers_and_preserve_protections() {
        let root = fixture();
        let one = root.join("one");
        let two = root.join("two");
        let entry = package(&one, "same-name", "index.js");
        package(&two, "same-name", "index.js");
        let mut a = process(10, 1, "/usr/local/bin/node");
        a.cwd = one.to_string_lossy().into_owned();
        let mut b = process(20, 1, "/usr/local/bin/node");
        b.cwd = two.to_string_lossy().into_owned();
        let mut worker = process(11, 10, "/usr/local/bin/esbuild");
        worker.protected = true;
        let mut other = process(30, 1, "/usr/local/bin/node");
        other.identity.uid = 0;
        let embedded = process(40, 1, "/Applications/Example.app/Contents/Resources/node");
        let mut processes = vec![a, b, worker, other, embedded];
        resolve(&mut processes, 501, |id| {
            if id.pid == 10 {
                Some(entry.to_string_lossy().into_owned())
            } else {
                None
            }
        });
        let groups = group_processes(processes, 501);
        assert_eq!(
            groups
                .iter()
                .filter(|g| g.name == "same-name")
                .count(),
            2
        );
        let group = groups
            .iter()
            .find(|g| g.processes.iter().any(|p| p.identity.pid == 10))
            .unwrap();
        assert_eq!(group.processes.len(), 2);
        assert!(!group.can_terminate);
        assert_eq!(group.footprint, Some(300));
        assert!(groups
            .iter()
            .find(|g| g.app_path.is_some())
            .unwrap()
            .processes[0]
            .runtime_project
            .is_none());
        assert_eq!(groups.iter().map(|g| g.processes.len()).sum::<usize>(), 5);
        std::fs::remove_dir_all(root).unwrap();
    }
}
