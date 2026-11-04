//! Display groups may aggregate projects. Actions use one verified process tree.
use crate::model::{Group, Identity, Instance, Process};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};

fn root(process: &Process, members: &HashMap<i32, &Process>) -> Identity {
    let mut current = process;
    let mut visited = HashSet::from([current.identity.pid]);
    loop {
        let valid = |parent: &&Process| {
            parent.identity.uid == current.identity.uid
                && parent.identity.started > 0
                && parent.identity.started <= current.identity.started
        };
        let parent = members
            .get(&current.ppid)
            .copied()
            .filter(valid)
            .or_else(|| {
                let responsible = current.responsible.as_ref()?;
                members
                    .get(&responsible.pid)
                    .copied()
                    .filter(|owner| owner.identity == *responsible)
                    .filter(valid)
            });
        let Some(parent) = parent else {
            return current.identity.clone();
        };
        if visited.len() >= 64 || !visited.insert(parent.identity.pid) {
            // Broken/cyclic ancestry must never combine independent targets.
            return process.identity.clone();
        }
        current = parent;
    }
}

pub fn assign(group: &mut Group) {
    let members: HashMap<_, _> = group
        .processes
        .iter()
        .map(|p| (p.identity.pid, p))
        .collect();
    let roots: Vec<_> = group.processes.iter().map(|p| root(p, &members)).collect();
    let mut instances = BTreeMap::new();
    for (process, root) in group.processes.iter_mut().zip(roots) {
        let id = format!(
            "instance-{:x}",
            Sha256::digest(serde_json::to_vec(&root).unwrap())
        );
        process.instance_id = id.clone();
        let instance = instances.entry(id.clone()).or_insert_with(|| Instance {
            id,
            root,
            count: 0,
            memory: None,
            footprint: None,
            cpu: None,
            incomplete: false,
            footprint_incomplete: false,
            can_terminate: true,
        });
        instance.count += 1;
        instance.incomplete |= process.memory.is_none();
        instance.footprint_incomplete |= process.footprint.is_none();
        if let Some(value) = process.memory {
            instance.memory = Some(instance.memory.unwrap_or(0).saturating_add(value));
        }
        if let Some(value) = process.footprint {
            instance.footprint = Some(instance.footprint.unwrap_or(0).saturating_add(value));
        }
        if let Some(value) = process.cpu {
            instance.cpu = Some(instance.cpu.unwrap_or(0.) + value);
        }
        instance.can_terminate &= !process.protected;
    }
    group.instances = instances.into_values().collect();
    group
        .instances
        .sort_by_key(|instance| (instance.root.started, instance.root.pid));
    // Aggregate groups are read-only action scopes, even for older clients.
    group.can_terminate = group.instances.len() == 1 && group.instances[0].can_terminate;
}

pub fn members<'a>(
    group: &'a Group,
    requested: Option<&str>,
) -> Result<(&'a Instance, Vec<&'a Process>), String> {
    let instance = match requested {
        Some(id) => group
            .instances
            .iter()
            .find(|instance| instance.id == id)
            .ok_or("启动实例已退出或归属变化，请刷新")?,
        None if group.instances.len() == 1 => &group.instances[0],
        _ => return Err("包含多个启动实例，请先选择要结束的实例".into()),
    };
    Ok((
        instance,
        group
            .processes
            .iter()
            .filter(|p| p.instance_id == instance.id)
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use crate::model::{group_processes, tests::process};
    #[test]
    fn same_directory_and_same_shell_do_not_merge_separate_launches() {
        let mut first = process(10, 2, "/usr/local/bin/node");
        first.identity.started = 100;
        let mut worker = process(11, 10, "/usr/local/bin/worker");
        worker.identity.started = 101;
        worker.protected = true;
        let mut second = process(20, 2, "/usr/local/bin/node");
        second.identity.started = 102;
        let mut other = process(21, 20, "/usr/local/bin/worker");
        other.identity.started = 103;
        // Use the project classifier so helpers and roots share one display group.
        let project = crate::model::RuntimeProject {
            name: "same-project".into(),
            root: "/project".into(),
            entry: None,
            evidence: "工作目录推断".into(),
        };
        first.runtime_project = Some(project.clone());
        second.runtime_project = Some(project);
        let groups = group_processes(
            vec![process(2, 1, "/bin/zsh"), first, worker, second, other],
            501,
        );
        let group = groups.iter().find(|g| g.name == "same-project").unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(group.instances.len(), 2);
        assert!(!group.can_terminate);
        assert!(!group.instances[0].can_terminate);
        assert!(group.instances[1].can_terminate);
        assert!(super::members(group, None).unwrap_err().contains("多个"));
        for (instance, pids) in group.instances.iter().zip([vec![10, 11], vec![20, 21]]) {
            let (_, mut selected) = super::members(group, Some(&instance.id)).unwrap();
            selected.sort_by_key(|p| p.identity.pid);
            assert_eq!(
                selected.iter().map(|p| p.identity.pid).collect::<Vec<_>>(),
                pids
            );
        }
        assert_eq!(
            group
                .instances
                .iter()
                .map(|i| i.footprint.unwrap())
                .sum::<u64>(),
            group.footprint.unwrap()
        );
    }
    #[test]
    fn recycled_parent_pid_and_cycles_are_kept_separate() {
        let mut a = process(10, 11, "/usr/local/bin/node");
        a.identity.started = 100;
        let mut b = process(11, 10, "/usr/local/bin/node");
        b.identity.started = 101;
        let group = group_processes(vec![a.clone(), b], 501).remove(0);
        // PID 11 was started later, so it cannot be process 10's parent.
        assert_eq!(group.instances[0].root.pid, 10);
        a.ppid = 10;
        let group = group_processes(vec![a], 501).remove(0);
        assert_eq!(group.instances[0].root.pid, 10);
        let mut a = process(10, 11, "/usr/local/bin/node");
        a.identity.started = 100;
        let mut b = process(11, 10, "/usr/local/bin/node");
        b.identity.started = 100;
        let group = group_processes(vec![a, b], 501).remove(0);
        assert_eq!(group.instances.len(), 2);
    }
    #[test]
    fn reused_root_pid_does_not_reuse_an_instance_id() {
        let first = process(10, 1, "/usr/local/bin/node");
        let old = group_processes(vec![first.clone()], 501).remove(0);
        let mut reused = first;
        reused.identity.started += 1;
        let current = group_processes(vec![reused], 501).remove(0);
        assert_eq!(old.id, current.id); // Same display group, different action boundary.
        assert_ne!(old.instances[0].id, current.instances[0].id);
        assert!(super::members(&current, Some(&old.instances[0].id)).is_err());
    }
}
