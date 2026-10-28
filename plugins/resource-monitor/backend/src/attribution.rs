use crate::model::{Group, Identity, Process};
use std::collections::{HashMap, HashSet};

pub struct CodexProcesses {
    pub threads: HashMap<String, Vec<Identity>>,
    pub unreadable: usize,
}

pub fn codex_processes(
    group: &Group,
    groups: &[Group],
    read: impl Fn(&Identity) -> Result<Option<String>, ()>,
) -> CodexProcesses {
    let all: HashMap<_, _> = groups
        .iter()
        .flat_map(|g| &g.processes)
        .map(|p| (p.identity.pid, p))
        .collect();
    let roots: HashSet<_> = group.processes.iter().map(|p| p.identity.pid).collect();
    let belongs = |process: &Process| {
        let mut pid = process.identity.pid;
        let mut seen = HashSet::new();
        while pid > 1 && seen.len() < 64 && seen.insert(pid) {
            let Some(parent) = all.get(&pid) else {
                return false;
            };
            if parent.identity.uid != process.identity.uid {
                return false;
            }
            if roots.contains(&pid) {
                return true;
            }
            pid = parent.ppid;
        }
        false
    };
    let mut result = CodexProcesses {
        threads: HashMap::new(),
        unreadable: 0,
    };
    for process in all
        .values()
        .filter(|p| !p.protected && belongs(p))
        .take(2048)
    {
        // Shared application/runtime/render processes never become a conversation total,
        // even if Codex itself was launched from a shell with a stale thread marker.
        if matches!(process.role.as_str(), "渲染进程" | "GPU")
            || group.app_path.as_ref().is_some_and(|path| {
                process
                    .identity
                    .executable
                    .starts_with(&format!("{path}/Contents/MacOS/"))
            })
            || (process.name == "codex" && process.identity.executable.contains("/codex-cli/"))
        {
            continue;
        }
        match read(&process.identity) {
            Ok(Some(id)) => result
                .threads
                .entry(id)
                .or_default()
                .push(process.identity.clone()),
            Err(()) => result.unreadable += 1,
            _ => {}
        }
    }
    for identities in result.threads.values_mut() {
        identities.sort_by_key(|id| id.pid);
        identities.dedup();
    }
    result
}

pub fn arc_title(title: &str) -> Option<String> {
    ["标签页：", "标签页:", "標籤頁：", "Tab:", "Tab："]
        .into_iter()
        .find_map(|prefix| title.strip_prefix(prefix))
        .map(|title| title.trim().chars().take(200).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arc_mapping_requires_an_explicit_tab_task_and_normalizes_only_its_prefix() {
        assert_eq!(arc_title("标签页： Work"), Some("Work".into()));
        assert_eq!(arc_title("Tab: Project"), Some("Project".into()));
        assert!(arc_title("Subframe: Project").is_none());
        assert!(arc_title("GPU Process").is_none());
    }
    #[test]
    fn codex_markers_require_the_process_tree_and_do_not_claim_shared_or_protected_processes() {
        use crate::model::{group_processes, tests::process};
        let mut protected = process(13, 10, "/usr/bin/protected");
        protected.protected = true;
        let mut renderer = process(
            14,
            10,
            "/Applications/Codex.app/Contents/Frameworks/Renderer",
        );
        renderer.role = "渲染进程".into();
        let groups = group_processes(
            vec![
                process(10, 1, "/Applications/Codex.app/Contents/MacOS/Codex"),
                process(11, 10, "/usr/bin/node"),
                process(12, 10, "/Library/Android/sdk/emulator/qemu-system"),
                protected,
                renderer,
                process(90, 1, "/usr/bin/unrelated"),
            ],
            501,
        );
        let group = groups.iter().find(|g| g.app_path.is_some()).unwrap();
        let result = codex_processes(group, &groups, |id| {
            Ok(Some(
                if id.pid == 11 || id.pid == 12 {
                    "thread"
                } else {
                    panic!("unexpected process scanned")
                }
                .into(),
            ))
        });
        assert_eq!(
            result.threads["thread"]
                .iter()
                .map(|id| id.pid)
                .collect::<Vec<_>>(),
            vec![11, 12]
        );
    }
}
