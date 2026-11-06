//! Display-only application resource-coalition accounting. Never an action scope.
use crate::model::{Group, Identity};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAccounting {
    pub footprint: Option<u64>,
    pub coalition_count: usize,
    pub shared: bool,
}

pub fn enrich(
    groups: &mut [Group],
    roots: HashMap<String, Vec<Identity>>,
    mut read: impl FnMut(&Identity) -> Option<(u64, u64)>,
) {
    let mut values = HashMap::new();
    let mut memberships = HashMap::<u64, usize>::new();
    for group in groups.iter() {
        if group.app_path.is_none() || group.origin.is_some() {
            continue;
        }
        let Some(roots) = roots.get(&group.id).filter(|r| !r.is_empty()) else {
            continue;
        };
        let mut coalitions = HashMap::new();
        let mut complete = true;
        for root in roots {
            if let Some((id, bytes)) = read(root).filter(|(id, _)| *id != 0) {
                coalitions.entry(id).or_insert(bytes);
            } else {
                complete = false;
            }
        }
        for id in coalitions.keys() {
            *memberships.entry(*id).or_default() += 1;
        }
        let total = complete
            .then(|| {
                coalitions
                    .values()
                    .try_fold(0_u64, |sum, n| sum.checked_add(*n))
            })
            .flatten();
        values.insert(
            group.id.clone(),
            (coalitions.keys().copied().collect::<HashSet<_>>(), total),
        );
    }
    for group in groups {
        group.system_accounting =
            values
                .remove(&group.id)
                .map(|(ids, footprint)| SystemAccounting {
                    footprint,
                    coalition_count: ids.len(),
                    shared: ids.iter().any(|id| memberships[id] > 1),
                });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{self, Process};
    fn process(pid: i32, path: &str) -> Process {
        serde_json::from_value(serde_json::json!({"pid":pid,"uid":501,"started":pid,"executable":format!("{path}/Contents/MacOS/App"),"ppid":0,"name":"App","memory":10,"footprint":20,"cpu":0,"cwd":"","role":"进程","avd":"","protected":false,"protection":"","parentName":"","groupId":"","attribution":"fixture"})).unwrap()
    }
    #[test]
    fn accounting_deduplicates_shared_coalitions_without_changing_instances_or_targets() {
        let mut groups = model::group_processes(
            vec![
                process(1, "/Applications/A.app"),
                process(2, "/Applications/A.app"),
                process(3, "/Applications/B.app"),
            ],
            501,
        );
        let before = serde_json::to_value(&groups).unwrap();
        let roots = groups
            .iter()
            .map(|g| {
                (
                    g.id.clone(),
                    g.processes.iter().map(|p| p.identity.clone()).collect(),
                )
            })
            .collect();
        enrich(&mut groups, roots, |_| Some((99, 1_000_000)));
        for (g, original) in groups.iter().zip(before.as_array().unwrap()) {
            let accounting = g.system_accounting.as_ref().unwrap();
            assert_eq!(accounting.footprint, Some(1_000_000));
            assert_eq!(accounting.coalition_count, 1);
            assert!(accounting.shared);
            let current = serde_json::to_value(g).unwrap();
            for field in [
                "processes",
                "instances",
                "canTerminate",
                "footprint",
                "memory",
            ] {
                assert_eq!(current[field], original[field]);
            }
            for instance in &g.instances {
                let (_, members) = crate::instances::members(g, Some(&instance.id)).unwrap();
                assert_eq!(members.len(), 1);
            }
        }
    }
    #[test]
    fn unreadable_roots_never_report_partial_totals_or_reuse_old_accounting() {
        let mut groups = model::group_processes(
            vec![
                process(1, "/Applications/A.app"),
                process(2, "/Applications/A.app"),
            ],
            501,
        );
        let roots = HashMap::from([(
            groups[0].id.clone(),
            groups[0]
                .processes
                .iter()
                .map(|p| p.identity.clone())
                .collect(),
        )]);
        enrich(&mut groups, roots, |id| {
            if id.pid == 1 {
                Some((1, 100))
            } else {
                None
            }
        });
        assert_eq!(
            groups[0].system_accounting.as_ref().unwrap().footprint,
            None
        );
        enrich(&mut groups, HashMap::new(), |_| {
            panic!("no live main application")
        });
        assert!(groups[0].system_accounting.is_none());
    }
}
