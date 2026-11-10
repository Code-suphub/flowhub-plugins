mod accessibility;
mod attribution;
mod applications;
mod model;
mod cache;
mod diagnostics;
mod accounting;
mod scripts;
mod rpc;
#[cfg(test)]
mod cache_tests;
mod projects;
mod instances;
mod origins;
mod terminals;
mod services;
mod startup;
mod finder_extensions;
#[cfg(target_os = "macos")]
mod native;
mod surfaces;
#[cfg(not(target_os = "macos"))]
compile_error!("应用资源监控第一版仅支持 macOS");

use model::{Identity, Process};
use cache::{Cache, Snapshot};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone)]
struct Plan {
    token: String,
    created: Instant,
    targets: Vec<Identity>,
    group: Option<String>,
    instances: Vec<String>,
    force: bool,
}
struct Monitor {
    snapshot: Arc<Snapshot>,
    cache: Cache,
    previous: HashMap<i32, (Identity, u64)>,
    sampled: Option<Instant>,
    plans: HashMap<String, Plan>,
    links: surfaces::Links,
    quitter: applications::Quitter,
    services: services::Catalog,
    scripts: scripts::History,
}
impl Monitor {
    fn new() -> Self {
        let cache = Cache::new();
        Self {
            snapshot: cache.get(),
            cache,
            previous: HashMap::new(),
            sampled: None,
            plans: HashMap::new(),
            links: surfaces::Links::default(),
            quitter: applications::Quitter::default(),
            services: services::Catalog::default(),
            scripts: scripts::History::default(),
        }
    }
    fn refresh(&mut self) -> Result<(), String> {
        self.refresh_with(Self::collect)
    }
    fn refresh_with(&mut self, collect:impl FnOnce(&mut Self)->Result<Snapshot,String>) -> Result<(),String> {
        diagnostics::sample_started();
        self.cache.begin();
        let result = collect(self);
        let error = result.as_ref().err().cloned();
        self.snapshot = self.cache.finish(result);
        diagnostics::sample_finished(error.as_deref(),self.snapshot.groups.iter().map(|g|g.processes.len()).sum(),self.snapshot.groups.len());
        error.map_or(Ok(()), Err)
    }
    fn collect(&mut self) -> Result<Snapshot, String> {
        let mut processes = native::collect()?;
        diagnostics::phase("cpu");
        let at = Instant::now();
        for p in &mut processes {
            if let (Some(previous_at), Some((id, time))) =
                (self.sampled, self.previous.get(&p.identity.pid))
            {
                let elapsed = at.duration_since(previous_at).as_secs_f64();
                if id == &p.identity && elapsed >= 0.2 && p.memory.is_some() {
                    p.cpu = Some(
                        p.cpu_time.saturating_sub(*time) as f64 / elapsed / 1_000_000_000. * 100.,
                    );
                }
            }
        }
        self.previous = processes
            .iter()
            .map(|p| (p.identity.pid, (p.identity.clone(), p.cpu_time)))
            .collect();
        self.sampled = Some(at);
        diagnostics::phase("applications");
        applications::resolve_bundle_paths(&mut processes);
        diagnostics::phase("origins");
        origins::resolve(&mut processes, native::uid(), native::launch_executable,
            |identity| native::identity(identity.pid).as_ref()==Some(identity));
        diagnostics::phase("projects");
        projects::resolve(&mut processes, native::uid(), native::node_entry);
        diagnostics::phase("terminals");
        terminals::resolve(&mut processes,native::uid(),native::responsibility_owner,
            |identity| native::identity(identity.pid).as_ref()==Some(identity),native::parent_matches);
        diagnostics::phase("grouping");
        let mut groups = model::group_processes(processes, native::uid());
        diagnostics::phase("services");
        self.services.enrich(&mut groups);
        diagnostics::phase("accounting");
        let roots=applications::accounting_roots(&groups);
        accounting::enrich(&mut groups,roots,native::resource_accounting);
        diagnostics::phase("scripts");
        let at=now();
        let script_records=self.scripts.observe(&groups,at,native::parent_matches,native::responsibility_owner,|id|native::identity(id.pid).as_ref()==Some(id));
        diagnostics::phase("system");
        let mut snapshot=Snapshot::new(at, groups, native::system());
        snapshot.script_records=Arc::new(script_records);
        Ok(snapshot)
    }
    fn preview(&mut self, params: &Value) -> Result<Value, String> {
        self.refresh()?;
        let force = params
            .get("force")
            .and_then(Value::as_bool)
            .ok_or("请选择结束方式")?;
        let group = params
            .get("groupId")
            .and_then(Value::as_str)
            .map(String::from);
        let mut selected_instances = Vec::new();
        let mut scope = json!({"kind":"process"});
        let members: Vec<&Process> = if let Some(id) = &group {
            let selected_group = self.snapshot
                .groups
                .iter()
                .find(|g| &g.id == id)
                .ok_or("应用已退出，请刷新")?;
            if selected_group.app_path.is_some() && selected_group.origin.is_some() {
                return Err("来源线索不能作为应用结束范围，请单独选择任务".into());
            }
            let (selected,members)=if let Some(ids)=params.get("instanceIds") {
                if params.get("instanceId").is_some() {return Err("实例选择参数冲突".into());}
                let ids:Vec<String>=serde_json::from_value(ids.clone()).map_err(|_|"实例选择无效")?;
                instances::batch_members(selected_group,&ids)?
            } else {
                let (instance,members)=instances::members(selected_group,params["instanceId"].as_str())?;
                (vec![instance],members)
            };
            if let Some(path)=selected_group.app_path.as_deref() {
                if members.iter().any(|p|model::process_bundle(p).as_ref().is_none_or(|(key,_)|
                    key.strip_prefix("app:")!=Some(path)) && p.responsible.is_none()) {
                    return Err("来源关联任务不能随应用结束，请单独选择任务".into());
                }
            }
            selected_instances=selected.iter().map(|i|i.id.clone()).collect();
            scope=if selected.len()==1 {json!({"kind":"instance","name":selected_group.name,"instanceId":selected[0].id,"root":selected[0].root})}
                else {json!({"kind":"instances","name":selected_group.name,"instances":selected.iter().map(|i|json!({"id":i.id,"root":i.root,"count":i.count})).collect::<Vec<_>>()})};
            members
        } else {
            let target: Identity =
                serde_json::from_value(params["identity"].clone()).map_err(|_| "进程身份无效")?;
            vec![self
                .snapshot
                .groups
                .iter()
                .flat_map(|g| &g.processes)
                .find(|p| p.identity == target)
                .ok_or("进程已退出或身份改变，请刷新")?]
        };
        if members.is_empty() || members.len() > 256 {
            return Err("目标数量无效，单次最多 256 个进程".into());
        }
        if let Some(p) = members.iter().find(|p| p.protected) {
            return Err(format!("不能结束 {}：{}", p.name, p.protection));
        }
        let targets = members.iter().map(|p| p.identity.clone()).collect();
        let token = uuid::Uuid::new_v4().to_string();
        let result = json!({"token":token,"force":force,"expiresIn":30,"targets":members,"scope":scope,"memoryMetric":"rss"});
        self.plans
            .retain(|_, p| p.created.elapsed() < Duration::from_secs(30));
        if self.plans.len() >= 16 {
            return Err("待确认操作过多，请稍后重试".into());
        }
        self.plans.insert(
            token.clone(),
            Plan {
                token,
                created: Instant::now(),
                targets,
                group,
                instances: selected_instances,
                force,
            },
        );
        Ok(result)
    }
    fn execute(&mut self, params: &Value) -> Result<Value, String> {
        if params["confirmed"] != true {
            return Err("请先确认结束目标及影响范围".into());
        }
        let token = params["token"].as_str().ok_or("确认令牌无效")?;
        let plan = self
            .plans
            .remove(token)
            .ok_or("确认已失效，请重新选择目标")?;
        validate_plan(&plan)?;
        let force = match params.get("force") {
            None => plan.force,
            Some(value) => value.as_bool().ok_or("结束方式无效")?,
        };
        self.refresh()?;
        let current: Vec<_> = if let Some(group) = &plan.group {
            self.snapshot
                .groups
                .iter()
                .find(|g| &g.id == group)
                .and_then(|g| instances::batch_members(g,&plan.instances).ok().map(|(_,members)|members))
                .unwrap_or_default()
        } else {
            self.snapshot
                .groups
                .iter()
                .flat_map(|g| &g.processes)
                .filter(|p| plan.targets.contains(&p.identity))
                .collect()
        };
        if current.iter().any(|p| p.protected)
            || !model::same_targets(
                &plan.targets,
                &current
                    .iter()
                    .map(|p| p.identity.clone())
                    .collect::<Vec<_>>(),
            )
        {
            return Err("目标进程集合或身份已变化，请重新确认".into());
        }
        let root_targets:Vec<_>=plan.targets.iter().filter(|t|t.uid==0&&native::uid()!=0).cloned().collect();
        let privileged=native::terminate_privileged(&root_targets,force)?;
        let mut results = Vec::new();
        for target in &plan.targets {
            if let Some(result)=privileged.iter().find(|r|r["pid"]==target.pid) {results.push(result.clone());continue;}
            let gone=native::exited(target);
            let error=if gone {None} else {native::signal(target,force).err()};
            results.push(json!({"pid":target.pid,"sent":!gone&&error.is_none(),"error":error}));
        }
        std::thread::sleep(Duration::from_millis(250));
        for (result,target) in results.iter_mut().zip(&plan.targets) {
            if !root_targets.contains(target) {result["exited"]=json!(native::identity(target.pid).as_ref()!=Some(target));}
        }
        let refresh_error = self.refresh().err();
        Ok(json!({"results":results,"refreshError":refresh_error,"snapshot":self.snapshot.full()}))
    }
    fn dispatch(&mut self, method: &str, params: &Value) -> Result<Value, String> {
        match method {
            "health" => Ok(json!({"protocol":2,"name":"resource-monitor"})),
            "status_snapshot" => Ok(self.snapshot.status()),
            "snapshot" => Ok(self.snapshot.full()),
            "ranking_snapshot" => Ok(self.snapshot.ranking(params)),
            "group_detail" => self.snapshot.detail(params),
            "script_activity" => Ok(self.snapshot.scripts()),
            "diagnostic_event" => diagnostics::client(params),
            "services_snapshot" | "service_preview" | "service_confirm" => native::service_request(method,params),
            "startup_snapshot" => startup::snapshot(),
            "startup_set" => startup::set(params),
            "startup_stop" => startup::stop(params),
            "finder_extensions_snapshot" => finder_extensions::snapshot(),
            "finder_extension_set" => finder_extensions::set(params),
            "login_items_settings" => startup::open_settings(),
            "refresh_summary" => {
                self.refresh()?;
                Ok(self.snapshot.ranking(params))
            }
            "refresh" => {
                self.refresh()?;
                Ok(self.snapshot.full())
            }
            "terminate_preview" => self.preview(params),
            "terminate_confirm" => self.execute(params),
            "application_state" | "quit_preview" => {
                if method=="quit_preview" {self.refresh()?;}
                let id=params["groupId"].as_str().ok_or("应用标识无效")?;
                let group=self.snapshot.groups.iter().find(|group|group.id==id);
                if method=="application_state" {Ok(group.map(|group| {
                    let mut state=applications::Quitter::state(group);
                    state["contextKind"]=json!(surfaces::context_kind(group));
                    state
                }).unwrap_or_else(||json!({"canQuit":false,"contextKind":null,"message":"应用已退出。"})))}
                else{self.quitter.preview(group.ok_or("应用已退出，请刷新")?,params["instanceId"].as_str())}
            }
            "quit_confirm" => {
                self.quitter.validate(params)?;
                self.refresh()?;
                let mut result=self.quitter.execute(params,&self.snapshot.groups)?;
                let refresh_error=self.refresh().err();
                result["snapshot"]=self.snapshot.full();result["refreshError"]=json!(refresh_error);
                Ok(result)
            }
            "contexts" | "arc_tasks" | "focus_app" | "open_context" => {
                self.refresh()?;
                let id = params["groupId"].as_str().ok_or("应用标识无效")?;
                let group = self
                    .snapshot
                    .groups
                    .iter()
                    .find(|g| g.id == id)
                    .ok_or("应用已退出，请刷新")?;
                match method {
                    "contexts" => self.links.list(group, &self.snapshot.groups),
                    "arc_tasks" => self.links.read_arc_tasks(
                        group,
                        &self.snapshot.groups,
                        params["open"] == true,
                    ),
                    "focus_app" => surfaces::focus_app(group),
                    _ => self
                        .links
                        .open(group, params["token"].as_str().ok_or("跳转标识无效")?),
                }
            }
            "accessibility_settings" => surfaces::accessibility_settings(),
            "widget_api" => match params["action"].as_str() {
                Some("snapshot") => Ok(self.snapshot.status()),
                Some("management") => {
                    let method = params["method"].as_str().unwrap_or("");
                    if ![
                        "snapshot",
                        "ranking_snapshot",
                        "group_detail",
                        "script_activity",
                        "diagnostic_event",
                        "services_snapshot",
                        "service_preview",
                        "service_confirm",
                        "startup_snapshot",
                        "startup_set",
                        "startup_stop",
                        "finder_extensions_snapshot",
                        "finder_extension_set",
                        "login_items_settings",
                        "refresh_summary",
                        "refresh",
                        "terminate_preview",
                        "terminate_confirm",
                        "application_state",
                        "quit_preview",
                        "quit_confirm",
                        "contexts",
                        "arc_tasks",
                        "accessibility_settings",
                        "focus_app",
                        "open_context",
                    ]
                    .contains(&method)
                    {
                        return Err("不支持的组件操作".into());
                    }
                    self.dispatch(method, &params["params"])
                }
                _ => Err("不支持的组件操作".into()),
            },
            _ => Err("未知插件方法".into()),
        }
    }
}

fn validate_plan(plan: &Plan) -> Result<(), String> {
    if plan.token.is_empty() || plan.created.elapsed() >= Duration::from_secs(30) {
        Err("确认已过期，请重新选择目标".into())
    } else {
        Ok(())
    }
}

fn main() {
    diagnostics::init();
    // Keep AppKit's run loop, collection and action state on this one thread.
    // rpc's input thread serves immutable cache reads independently.
    rpc::serve(Monitor::new(), std::io::BufReader::new(std::io::stdin()));
    diagnostics::event("backend_stopped",json!({}));
    diagnostics::flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unconfirmed_invalid_and_expired_operations_never_signal() {
        let mut m = Monitor::new();
        assert!(m.execute(&json!({"token":"bad"})).is_err());
        assert!(m.execute(&json!({"token":"bad","confirmed":true})).is_err());
        let plan = Plan {
            token: "expired".into(),
            created: Instant::now() - Duration::from_secs(31),
            targets: vec![],
            group: None,
            instances: vec![],
            force: false,
        };
        m.plans.insert(plan.token.clone(), plan);
        assert!(m
            .execute(&json!({"token":"expired","confirmed":true}))
            .unwrap_err()
            .contains("过期"));
    }
    #[test]
    fn cache_only_status_and_widget_reads_do_not_collect() {
        let mut m = Monitor::new();
        assert_eq!(m.dispatch("status_snapshot", &json!({})).unwrap()["at"], 0);
        assert_eq!(
            m.dispatch("widget_api", &json!({"action":"snapshot"}))
                .unwrap()["at"],
            0
        );
        assert!(m
            .dispatch(
                "widget_api",
                &json!({"action":"management","method":"health"})
            )
            .is_err());
    }
    #[test]
    fn native_collect_and_self_protection() {
        let rows = native::collect().unwrap();
        let myself = rows
            .iter()
            .find(|p| p.identity.pid == std::process::id() as i32)
            .unwrap();
        assert!(myself.protected);
        assert!(myself.memory.is_some());
        assert_eq!(
            native::identity(myself.identity.pid).as_ref(),
            Some(&myself.identity)
        );
        let mut m = Monitor::new();
        assert!(m
            .preview(&json!({"identity":myself.identity,"force":false}))
            .unwrap_err()
            .contains("不能结束"));
    }
}
