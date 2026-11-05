//! Display ownership for terminal jobs; job boundaries stay independent of GUI ownership.
use crate::model::{self, Identity, Process};
use std::collections::{HashMap, HashSet};

fn terminal(p: &Process) -> bool {
    matches!(
        p.identity.executable.rsplit('/').next(),
        Some(
            "sh" | "bash"
                | "zsh"
                | "fish"
                | "dash"
                | "ksh"
                | "tcsh"
                | "csh"
                | "ssh"
                | "scp"
                | "sftp"
                | "mosh-client"
                | "tmux"
                | "expect"
                | "tail"
                | "sleep"
        )
    )
}
fn tmux(p: &Process) -> bool {
    p.identity.executable.rsplit('/').next() == Some("tmux")
}

fn tmux_server(
    p: &Process,
    by: &HashMap<i32, &Process>,
    link: &impl Fn(&Identity, &Identity) -> bool,
) -> bool {
    // An attached client has the same executable as the server. Protect only a
    // verified manager with a live child job in a separate process group.
    tmux(p)
        && by.values().any(|child| {
            child.ppid == p.identity.pid
                && child.identity.uid == p.identity.uid
                && child.identity.started >= p.identity.started
                && child.process_group > 0
                && child.process_group != p.process_group
                && !tmux(child)
                && link(&child.identity, &p.identity)
        })
}

// Inspect only the current, same-user, time-consistent parent chain. A login UID
// boundary stops traversal; OS responsibility may still independently name the GUI.
fn scope<'a>(
    p: &'a Process,
    by: &HashMap<i32, &'a Process>,
    servers: &HashSet<i32>,
    link: &impl Fn(&Identity, &Identity) -> bool,
) -> Option<Option<&'a Process>> {
    let mut current = p;
    let mut eligible = false;
    let mut seen = HashSet::new();
    while seen.len() < 64 && seen.insert(current.identity.pid) {
        if current.runtime_project.is_some() {
            return None;
        }
        if model::process_bundle(current).is_some() {
            return eligible.then_some(Some(current));
        }
        eligible |= terminal(current);
        if servers.contains(&current.identity.pid) {
            return Some(Some(current));
        }
        let Some(parent) = by.get(&current.ppid).copied() else {
            break;
        };
        if parent.identity.uid != p.identity.uid
            || parent.identity.started == 0
            || parent.identity.started > current.identity.started
            || !link(&current.identity, &parent.identity)
        {
            break;
        }
        current = parent;
    }
    eligible.then_some(None)
}

pub fn resolve(
    processes: &mut [Process],
    own_uid: u32,
    responsible: impl Fn(&Identity) -> Option<Identity>,
    current: impl Fn(&Identity) -> bool,
    parent_link: impl Fn(&Identity, &Identity) -> bool,
) {
    let annotations = {
        let by: HashMap<_, _> = processes.iter().map(|p| (p.identity.pid, p)).collect();
        let servers: HashSet<_> = processes
            .iter()
            .filter(|p| {
                p.identity.uid == own_uid
                    && p.identity.started > 0
                    && tmux_server(p, &by, &parent_link)
            })
            .map(|p| p.identity.pid)
            .collect();
        processes
            .iter()
            .filter_map(|p| {
                let id = &p.identity;
                if id.uid != own_uid
                    || id.started == 0
                    || id.executable.is_empty()
                    || model::process_bundle(p).is_some()
                    || !current(id)
                {
                    return None;
                }
                let structural = scope(p, &by, &servers, &parent_link)?;
                let owner = if structural.is_some_and(|p| servers.contains(&p.identity.pid)) {
                    structural.map(|p| p.identity.clone())
                } else {
                    responsible(id)
                        .filter(|owner| {
                            by.get(&owner.pid).is_some_and(|p| {
                                p.identity == *owner
                                    && owner.uid == own_uid
                                    && owner.started > 0
                                    && owner.started <= id.started
                                    && model::process_bundle(p).is_some()
                            })
                        })
                        .or_else(|| structural.map(|p| p.identity.clone()))
                }?;
                if !current(id) || !current(&owner) {
                    return None;
                }
                Some((id.clone(), owner, servers.contains(&id.pid)))
            })
            .collect::<Vec<_>>()
    };
    for (id, owner, is_server) in annotations {
        let Some(p) = processes.iter_mut().find(|p| p.identity == id) else {
            continue;
        };
        p.terminal_job = true;
        if owner != id {
            p.terminal_owner = Some(owner);
        }
        // A tmux server controls multiple jobs. Ending it has wider effects than
        // its own PID; expose its individual sessions instead of offering a server stop.
        if is_server && !p.protected {
            p.protected = true;
            p.protection = "tmux 会话管理进程，请逐个处理会话".into();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{group_processes, tests::process, RuntimeProject};
    fn job(pid: i32, ppid: i32, exe: &str, pgid: i32) -> Process {
        let mut p = process(pid, ppid, exe);
        p.process_group = pgid;
        p
    }
    fn member(groups: &[model::Group], pid: i32) -> &model::Group {
        groups
            .iter()
            .find(|g| g.processes.iter().any(|p| p.identity.pid == pid))
            .unwrap()
    }
    #[test]
    fn tmux_client_is_not_a_protected_server_and_existing_protection_is_preserved() {
        let app = job(10, 1, "/Applications/Warp.app/Contents/MacOS/stable", 10);
        let client = job(20, 10, "/opt/homebrew/bin/tmux", 20);
        let mut server = job(30, 1, "/opt/homebrew/bin/tmux", 30);
        server.protected = true;
        server.protection = "FlowHub 及其宿主进程".into();
        let mut ps = vec![app, client, server, job(31, 30, "/bin/sleep", 31)];
        resolve(&mut ps, 501, |_| None, |_| true, |_, _| true);
        assert_eq!(ps[1].terminal_owner.as_ref().map(|p| p.pid), Some(10));
        assert!(!ps[1].protected);
        assert_eq!(ps[2].protection, "FlowHub 及其宿主进程");
        assert_eq!(ps[3].terminal_owner.as_ref().map(|p| p.pid), Some(30));
        let mut no_link = vec![
            job(30, 1, "/opt/homebrew/bin/tmux", 30),
            job(31, 30, "/bin/sleep", 31),
        ];
        resolve(&mut no_link, 501, |_| None, |_| true, |_, _| false);
        assert!(!no_link[0].protected);
    }
    #[test]
    fn responsibility_is_source_only_and_cannot_add_jobs_to_application_scope() {
        let app = job(10, 1, "/Applications/cmux.app/Contents/MacOS/cmux", 10);
        let owner = app.identity.clone();
        let mut login = job(11, 10, "/usr/bin/login", 11);
        login.identity.uid = 0;
        login.protected = true;
        let mut ps = vec![
            app,
            login,
            job(20, 11, "/bin/zsh", 20),
            job(21, 20, "/bin/zsh", 21),
            job(22, 21, "/bin/sleep", 21),
        ];
        resolve(&mut ps, 501, |_| Some(owner.clone()), |_| true, |_, _| true);
        let groups = group_processes(ps, 501);
        let app = member(&groups, 10);
        let task = member(&groups, 21);
        assert_eq!(app.processes.len(), 1);
        assert_eq!(app.footprint, Some(150));
        assert!(app.origin.is_none());
        assert_ne!(app.id, task.id);
        assert!(task.app_path.is_none());
        assert_eq!(
            task.origin.as_ref().unwrap().app_path.as_deref(),
            Some("/Applications/cmux.app")
        );
        assert_eq!(
            task.processes
                .iter()
                .map(|p| p.identity.pid)
                .collect::<HashSet<_>>(),
            HashSet::from([21, 22])
        );
        assert_ne!(member(&groups, 20).id, task.id);
        let (_, targets) = crate::instances::members(app, None).unwrap();
        assert_eq!(
            targets.iter().map(|p| p.identity.pid).collect::<Vec<_>>(),
            vec![10]
        );
        assert_eq!(
            groups
                .iter()
                .flat_map(|g| &g.processes)
                .map(|p| p.identity.pid)
                .collect::<HashSet<_>>()
                .len(),
            5
        );
    }
    #[test]
    fn detached_tail_and_ssh_remain_independent_of_source_application() {
        let app = job(10, 1, "/Applications/Warp.app/Contents/MacOS/stable", 10);
        let owner = app.identity.clone();
        let mut ps = vec![
            app,
            job(20, 1, "/bin/zsh", 19),
            job(21, 20, "/usr/bin/tail", 19),
            job(30, 1, "/usr/bin/ssh", 30),
        ];
        resolve(&mut ps, 501, |_| Some(owner.clone()), |_| true, |_, _| true);
        let groups = group_processes(ps, 501);
        assert_eq!(groups.len(), 3);
        assert_eq!(member(&groups, 10).processes.len(), 1);
        assert_eq!(member(&groups, 20).processes.len(), 2);
        assert!(member(&groups, 30).app_path.is_none());
        assert_eq!(member(&groups, 30).name, "ssh");
    }
    #[test]
    fn tmux_is_only_a_source_hint_and_each_job_has_its_own_scope() {
        let mut ps = vec![
            job(10, 1, "/opt/homebrew/bin/tmux", 10),
            job(20, 10, "/usr/bin/ssh", 20),
            job(21, 20, "/usr/bin/tail", 20),
            job(30, 10, "/usr/bin/ssh", 30),
        ];
        ps[0].cwd = "/projects/flowhub/plugins/machines/build".into();
        ps[1].cwd = "/project/one".into();
        resolve(&mut ps, 501, |_| None, |_| true, |_, _| true);
        let groups = group_processes(ps, 501);
        assert_eq!(groups.len(), 3);
        let server = member(&groups, 10);
        let first = member(&groups, 20);
        let second = member(&groups, 30);
        assert!(!server.can_terminate);
        assert_ne!(first.id, second.id);
        assert_eq!(first.name, "ssh");
        assert!(first.app_path.is_none());
        assert!(first.can_terminate);
        assert_eq!(first.origin.as_ref().unwrap().name, "tmux");
        assert_eq!(first.processes.len(), 2);
        assert!(first.origin.as_ref().unwrap().app_path.is_none());
    }
    #[test]
    fn ordinary_external_children_are_not_application_members_even_without_terminal_metadata() {
        let app = job(
            10,
            1,
            "/Applications/Example.app/Contents/MacOS/Example",
            10,
        );
        let worker = job(20, 10, "/usr/local/bin/python3", 20);
        let groups = group_processes(vec![app, worker], 501);
        assert_eq!(groups.len(), 2);
        assert_eq!(member(&groups, 10).processes.len(), 1);
        let task = member(&groups, 20);
        assert!(task.app_path.is_none());
        assert!(task.origin.is_some());
        let mut bad_parent = job(
            10,
            1,
            "/Applications/Example.app/Contents/MacOS/Example",
            10,
        );
        bad_parent.identity.started += 1;
        let groups = group_processes(
            vec![bad_parent, job(20, 10, "/usr/local/bin/python3", 20)],
            501,
        );
        assert!(
            member(&groups, 20).origin.is_none(),
            "a recycled parent cannot supply source evidence"
        );
    }
    #[test]
    fn projects_invalid_links_foreign_owners_and_reused_identities_are_not_reassigned() {
        let app = job(
            10,
            1,
            "/Applications/Example.app/Contents/MacOS/Example",
            10,
        );
        let mut node = job(20, 10, "/usr/local/bin/node", 20);
        node.runtime_project = Some(RuntimeProject {
            name: "project".into(),
            root: "/project".into(),
            entry: None,
            evidence: "fixture".into(),
        });
        let mut ps = vec![app.clone(), node, job(21, 20, "/bin/sleep", 20)];
        resolve(
            &mut ps,
            501,
            |_| Some(app.identity.clone()),
            |_| true,
            |_, _| true,
        );
        assert!(ps.iter().all(|p| p.terminal_owner.is_none()));
        let groups = group_processes(ps, 501);
        assert_eq!(member(&groups, 21).name, "project");
        for mode in 0..3 {
            let mut owner = app.identity.clone();
            if mode == 0 {
                owner.uid = 502;
            }
            if mode == 1 {
                owner.started += 1;
            }
            let mut ps = vec![app.clone(), job(30, 10, "/usr/bin/ssh", 30)];
            resolve(
                &mut ps,
                501,
                |_| Some(owner.clone()),
                |id| mode != 2 || id.pid != 10,
                |_, _| false,
            );
            assert!(ps[1].terminal_owner.is_none());
        }
        let mut ps = vec![app, job(30, 10, "/usr/bin/ssh", 30)];
        resolve(&mut ps, 501, |_| None, |_| true, |_, _| false);
        assert!(ps[1].terminal_owner.is_none());
    }
}
