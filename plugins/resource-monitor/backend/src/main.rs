mod accessibility;
mod attribution;
mod model;
#[cfg(target_os = "macos")]
mod native;
mod surfaces;
#[cfg(not(target_os = "macos"))]
compile_error!("应用资源监控第一版仅支持 macOS");

use model::{Group, Identity, Process};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, Read, Write},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone)]
struct Snapshot {
    at: u64,
    groups: Vec<Group>,
    system: Value,
    error: Option<String>,
}
impl Snapshot {
    fn full(&self) -> Value {
        json!({"at":self.at,"groups":self.groups,"system":self.system,"error":self.error,"memoryMetric":"footprint","interval":5})
    }
    fn status(&self) -> Value {
        // Status cache intentionally excludes paths, argv, working directories and individual PIDs.
        let stale = now().saturating_sub(self.at) > 20_000;
        let rows: Vec<_> = self.groups.iter().filter(|g| !g.system).map(|g| {
            json!({"id":g.id,"name":g.name,"at":self.at,"status":if self.at == 0 {"unknown"} else if stale || self.error.is_some() {"stale"} else {"healthy"},
                "summary":format!("{} · CPU {} · {} 个进程",g.footprint.map(|v|format!("{:.0} MiB 足迹{}",v as f64/1048576.,if g.footprint_incomplete {"（部分）"} else {""})).unwrap_or("足迹未知".into()),g.cpu.map(|v|format!("{v:.1}%")).unwrap_or("采样中".into()),g.processes.len()),
                "values":{"memory":g.memory,"footprint":g.footprint,"rss":g.memory,"cpu":g.cpu},"count":g.processes.len(),"incomplete":g.footprint_incomplete})
        }).collect();
        json!({"title":"应用资源","monitoring":true,"at":self.at,"rows":rows,"system":self.system,"error":self.error,"memoryMetric":"footprint"})
    }
}

#[derive(Clone)]
struct Plan {
    token: String,
    created: Instant,
    targets: Vec<Identity>,
    group: Option<String>,
    force: bool,
}
struct Monitor {
    snapshot: Snapshot,
    previous: HashMap<i32, (Identity, u64)>,
    sampled: Option<Instant>,
    plans: HashMap<String, Plan>,
    links: surfaces::Links,
}
impl Monitor {
    fn new() -> Self {
        Self {
            snapshot: Snapshot {
                at: 0,
                groups: vec![],
                system: json!({}),
                error: None,
            },
            previous: HashMap::new(),
            sampled: None,
            plans: HashMap::new(),
            links: surfaces::Links::default(),
        }
    }
    fn refresh(&mut self) -> Result<(), String> {
        let mut processes = match native::collect() {
            Ok(p) => p,
            Err(e) => {
                self.snapshot.error = Some(e.clone());
                return Err(e);
            }
        };
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
        self.snapshot = Snapshot {
            at: now(),
            groups: model::group_processes(processes, native::uid()),
            system: native::system(),
            error: None,
        };
        Ok(())
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
        let members: Vec<&Process> = if let Some(id) = &group {
            self.snapshot
                .groups
                .iter()
                .find(|g| &g.id == id)
                .ok_or("应用已退出，请刷新")?
                .processes
                .iter()
                .collect()
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
        let result = json!({"token":token,"force":force,"expiresIn":30,"targets":members,"memoryMetric":"rss"});
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
                .map(|g| g.processes.iter().collect())
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
        let mut results = Vec::new();
        for target in &plan.targets {
            let error = native::signal(target, force).err();
            results.push(json!({"pid":target.pid,"sent":error.is_none(),"error":error}));
        }
        // SIGTERM may be handled asynchronously. Report observed exit separately from signal delivery.
        std::thread::sleep(Duration::from_millis(250));
        for (result, target) in results.iter_mut().zip(&plan.targets) {
            let unchanged = native::identity(target.pid).as_ref() == Some(target);
            result["exited"] = json!(!unchanged);
        }
        let refresh_error = self.refresh().err();
        Ok(json!({"results":results,"refreshError":refresh_error,"snapshot":self.snapshot.full()}))
    }
    fn dispatch(&mut self, method: &str, params: &Value) -> Result<Value, String> {
        match method {
            "health" => Ok(json!({"protocol":2,"name":"resource-monitor"})),
            "status_snapshot" => Ok(self.snapshot.status()),
            "snapshot" => Ok(self.snapshot.full()),
            "refresh" => {
                self.refresh()?;
                Ok(self.snapshot.full())
            }
            "terminate_preview" => self.preview(params),
            "terminate_confirm" => self.execute(params),
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
                        "refresh",
                        "terminate_preview",
                        "terminate_confirm",
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
    let monitor = Arc::new(Mutex::new(Monitor::new()));
    let background = monitor.clone();
    std::thread::spawn(move || loop {
        if let Ok(mut monitor) = background.lock() {
            let _ = monitor.refresh();
        }
        std::thread::sleep(Duration::from_secs(5));
    });
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut output = std::io::stdout().lock();
    loop {
        let mut line = String::new();
        match (&mut input).take(65537).read_line(&mut line) {
            Ok(0) | Err(_) => break,
            _ => {}
        }
        if line.len() > 65536 {
            break;
        }
        let Ok(req) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let result = monitor
            .lock()
            .map_err(|_| "监控缓存不可用".to_string())
            .and_then(|mut m| m.dispatch(req["method"].as_str().unwrap_or(""), &req["params"]));
        let response = match result {
            Ok(value) => json!({"id":req["id"],"result":value}),
            Err(error) => json!({"id":req["id"],"error":error}),
        };
        if writeln!(output, "{response}")
            .and_then(|_| output.flush())
            .is_err()
        {
            break;
        }
    }
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
