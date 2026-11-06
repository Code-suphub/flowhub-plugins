//! Immutable read model. A reader holds the lock only long enough to clone an Arc;
//! collection, enrichment, searching and JSON serialization never hold this lock.
use crate::model::{Group, Identity, Process};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{Arc, RwLock},
};

#[derive(Clone)]
pub struct Snapshot {
    pub at: u64,
    pub groups: Arc<Vec<Group>>,
    pub system: Value,
    pub error: Option<String>,
    pub sampling: bool,
    pub revision: u64,
    summaries: Arc<Vec<Value>>,
    search: Arc<Vec<Vec<String>>>,
}
impl Snapshot {
    pub fn new(at: u64, groups: Vec<Group>, system: Value) -> Self {
        let summaries=groups.iter().map(|g|json!({
            "id":g.id,"name":g.name,"source":g.source,"memory":g.memory,"footprint":g.footprint,
            "footprintIncomplete":g.footprint_incomplete,"appPath":g.app_path,"origin":g.origin,
            "systemAccounting":g.system_accounting,
            "iconKey":g.icon_key,"presentation":g.presentation.as_ref().map(|p|json!({"name":p.name,"sources":p.sources})),
            "cpu":g.cpu,"incomplete":g.incomplete,"system":g.system,"canTerminate":g.can_terminate,
            "processCount":g.processes.len(),"instanceCount":g.instances.len(),
            "onlyInstanceId":if g.instances.len()==1 {Some(&g.instances[0].id)} else {None},
            "permissionLimited":!g.processes.is_empty()&&g.processes.iter().all(permission_limited),
            "hasRestrictedProcesses":g.processes.iter().any(|p|p.protection=="其他用户或系统账户"||permission_limited(p))
        })).collect();
        let search = groups.iter().map(search_fields).collect();
        Self {
            at,
            groups: Arc::new(groups),
            system,
            error: None,
            sampling: false,
            revision: 0,
            summaries: Arc::new(summaries),
            search: Arc::new(search),
        }
    }
    pub fn full(&self) -> Value {
        let mut result = self.metadata();
        result["groups"] = json!(&*self.groups);
        result
    }
    fn metadata(&self) -> Value {
        json!({"at":self.at,"revision":self.revision,"sampling":self.sampling,"stale":self.stale(),
            "system":self.system,"error":self.error,"memoryMetric":"footprint","interval":5})
    }
    pub fn stale(&self) -> bool {
        self.at == 0 || crate::now().saturating_sub(self.at) > 20_000
    }
    pub fn ranking(&self, params: &Value) -> Value {
        let query = params["query"].as_str().unwrap_or("").trim().to_lowercase();
        let matched: Vec<_> = self
            .groups
            .iter()
            .zip(self.search.iter())
            .filter(|(_, fields)| !query.is_empty() && fields.iter().any(|s| s.contains(&query)))
            .map(|(g, _)| &g.id)
            .collect();
        let mut result = self.metadata();
        let include_system = params["includeSystem"].as_bool().unwrap_or(true);
        result["groups"] = json!(self
            .summaries
            .iter()
            .zip(self.groups.iter())
            .filter(|(_, g)| include_system || !g.system)
            .map(|(summary, _)| summary)
            .collect::<Vec<_>>());
        result["includeSystem"] = json!(include_system);
        result["hasRestrictedProcesses"] = json!(self
            .groups
            .iter()
            .flat_map(|g| &g.processes)
            .any(|p| p.protection == "其他用户或系统账户" || permission_limited(p)));
        result["query"] = json!(query);
        result["matchedGroupIds"] = json!(matched);
        result
    }
    pub fn detail(&self, params: &Value) -> Result<Value, String> {
        let id = params["groupId"].as_str().ok_or("应用标识无效")?;
        if params["revision"]
            .as_u64()
            .is_some_and(|revision| revision != self.revision)
        {
            return Err("详情采样版本已更新，请重试".into());
        }
        let group = self.groups.iter().find(|g| g.id == id);
        // Only identities for previously displayed PIDs elsewhere are returned. This
        // preserves moved-vs-exited semantics without sending every other process.
        let pids = |field: &str| -> HashSet<i32> {
            params[field]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|p| p.as_i64().and_then(|p| i32::try_from(p).ok()))
                .collect()
        };
        let tracked = pids("trackedPids");
        let contexts = pids("contextPids");
        let elsewhere: Vec<&Identity> = self
            .groups
            .iter()
            .filter(|g| g.id != id)
            .flat_map(|g| &g.processes)
            .filter(|p| tracked.contains(&p.identity.pid))
            .map(|p| &p.identity)
            .collect();
        let linked: Vec<&Process> = self
            .groups
            .iter()
            .filter(|g| g.id != id)
            .flat_map(|g| &g.processes)
            .filter(|p| contexts.contains(&p.identity.pid))
            .collect();
        let mut result = self.metadata();
        result["groupId"] = json!(id);
        result["group"] = if params["includeGroup"] == false {
            Value::Null
        } else {
            json!(group)
        };
        result["elsewhere"] = json!(elsewhere);
        result["contextProcesses"] = json!(linked);
        Ok(result)
    }
    pub fn status(&self) -> Value {
        // Existing desktop protocol: no PIDs, process paths, cwd or service labels.
        let rows:Vec<_>=self.groups.iter().filter(|g|!g.system).map(|g|json!({
            "id":g.id,"name":g.name,"appPath":g.app_path,"origin":g.origin,"iconKey":g.icon_key,
            "presentation":g.presentation.as_ref().map(|p|json!({"name":p.name,"sources":p.sources})),"at":self.at,
            "systemAccounting":g.system_accounting,
            "status":if self.at==0 {"unknown"} else if self.stale()||self.error.is_some() {"stale"} else {"healthy"},
            "summary":format!("{} · CPU {} · {} 个进程",g.footprint.map(|v|format!("{:.0} MiB 足迹{}",v as f64/1048576.,if g.footprint_incomplete {"（部分）"} else {""})).unwrap_or("足迹未知".into()),g.cpu.map(|v|format!("{v:.1}%")).unwrap_or("采样中".into()),g.processes.len()),
            "values":{"memory":g.memory,"footprint":g.footprint,"rss":g.memory,"cpu":g.cpu},
            "count":g.processes.len(),"instanceCount":g.instances.len(),"incomplete":g.footprint_incomplete
        })).collect();
        json!({"title":"应用资源","monitoring":true,"at":self.at,"revision":self.revision,"sampling":self.sampling,"stale":self.stale(),"rows":rows,"system":self.system,"error":self.error,"memoryMetric":"footprint"})
    }
}
fn permission_limited(p: &Process) -> bool {
    p.protection.starts_with("当前用户权限不足")
}
fn search_fields(g: &Group) -> Vec<String> {
    let mut fields = vec![
        g.name.clone(),
        g.source.clone(),
        g.app_path.clone().unwrap_or_default(),
    ];
    let mut origin = |o: &crate::model::SourceOrigin| {
        fields.extend([o.name.clone(), o.app_path.clone().unwrap_or_default()]);
    };
    if let Some(o) = &g.origin {
        origin(o);
    }
    if let Some(p) = &g.presentation {
        for o in &p.sources {
            origin(o);
        }
        fields.push(p.name.clone().unwrap_or_default());
        for s in &p.services {
            fields.extend([s.name.clone(), s.label.clone()]);
        }
    }
    for p in &g.processes {
        fields.extend([
            p.name.clone(),
            p.display_name.clone().unwrap_or_default(),
            p.identity.executable.clone(),
            p.launch_executable.clone().unwrap_or_default(),
            p.terminal_owner
                .as_ref()
                .map(|p| p.executable.clone())
                .unwrap_or_default(),
            p.cwd.clone(),
            p.parent_name.clone(),
            p.identity.pid.to_string(),
            p.ppid.to_string(),
            p.avd.clone(),
        ]);
        if let Some(project) = &p.runtime_project {
            fields.extend([
                project.name.clone(),
                project.root.clone(),
                project.entry.clone().unwrap_or_default(),
            ]);
        }
    }
    fields.into_iter().map(|s| s.to_lowercase()).collect()
}
#[derive(Clone)]
pub struct Cache(Arc<RwLock<Arc<Snapshot>>>);
impl Cache {
    pub fn new() -> Self {
        Self(Arc::new(RwLock::new(Arc::new(Snapshot::new(
            0,
            vec![],
            json!({}),
        )))))
    }
    pub fn get(&self) -> Arc<Snapshot> {
        self.0.read().unwrap_or_else(|p| p.into_inner()).clone()
    }
    pub fn begin(&self) {
        let mut state = self.0.write().unwrap_or_else(|p| p.into_inner());
        let mut next = (**state).clone();
        next.sampling = true;
        next.revision += 1;
        *state = Arc::new(next);
    }
    // The single sampling/action thread serializes every writer through begin/finish.
    pub fn finish(&self, result: Result<Snapshot, String>) -> Arc<Snapshot> {
        let mut state = self.0.write().unwrap_or_else(|p| p.into_inner());
        let mut next = match result {
            Ok(snapshot) => snapshot,
            Err(error) => {
                let mut previous = (**state).clone();
                previous.error = Some(error);
                previous
            }
        };
        next.sampling = false;
        next.revision = state.revision + 1;
        *state = Arc::new(next);
        state.clone()
    }
}
