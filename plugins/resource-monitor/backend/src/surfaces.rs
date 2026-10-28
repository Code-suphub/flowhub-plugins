//! User-initiated metadata; PID links require native evidence, never a title guess.
use crate::{
    accessibility::{self, TaskSnapshot},
    attribution,
    model::{Group, Identity},
    native,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const ARC_LIST: &str = include_str!("arc-list.applescript");
const ARC_FOCUS: &str = include_str!("arc-focus.applescript");

fn command_error(program: &str, stderr: &[u8]) -> String {
    if program != "/usr/bin/osascript" {
        return "无法切换应用，请确认应用包仍然可用".into();
    }
    let message = String::from_utf8_lossy(stderr);
    let code = message
        .trim()
        .rsplit_once('(')
        .and_then(|(_, tail)| tail.strip_suffix(')'))
        .and_then(|text| text.parse::<i32>().ok());
    // Never echo source lines or titles from Apple Events stderr.
    match code {
        Some(-1743) => "请在系统设置的自动化权限中允许 FlowHub 控制 Arc（-1743）".into(),
        Some(-1712) => "Arc 接口响应超时，请稍后重试（-1712）".into(),
        Some(-1700) => "Arc 脚本接口类型转换失败，请更新插件（-1700）".into(),
        Some(-1728 | 6001 | 6002) => "Arc 窗口或标签已变化，请重新读取列表".into(),
        Some(number) => format!("Arc 接口调用失败（{number}），请重新读取列表"),
        None => "Arc 脚本执行失败，请确认应用仍在运行".into(),
    }
}

fn run(program: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "无法启动本机应用接口")?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || {
        let mut bytes = vec![];
        stdout.take(262145).read_to_end(&mut bytes).map(|_| bytes)
    });
    let err = std::thread::spawn(move || {
        let mut bytes = vec![];
        stderr.take(4097).read_to_end(&mut bytes).map(|_| bytes)
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < Duration::from_secs(15) => {
                std::thread::sleep(Duration::from_millis(25))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("应用接口未响应；如系统正在请求自动化授权，请授权后重试".to_string());
            }
        }
    };
    let bytes = out
        .join()
        .map_err(|_| "读取应用结果失败")?
        .map_err(|_| "读取应用结果失败")?;
    let errors = err
        .join()
        .map_err(|_| "读取应用结果失败")?
        .map_err(|_| "读取应用结果失败")?;
    if !status?.success() {
        return Err(command_error(program, &errors));
    }
    if bytes.len() > 262144 {
        return Err("应用列表过大，请减少打开的页面后重试".into());
    }
    Ok(bytes)
}

fn app_path(group: &Group) -> Result<&str, String> {
    let path = group.app_path.as_deref().ok_or("没有可跳转的所属应用")?;
    if !Path::new(path).is_dir() || !path.ends_with(".app") {
        return Err("应用包已移动，请刷新进程列表".into());
    }
    Ok(path)
}

pub fn focus_app(group: &Group) -> Result<Value, String> {
    let path = app_path(group)?;
    run("/usr/bin/open", &["-a", path])?;
    Ok(json!({"ok":true,"scope":"application"}))
}

#[derive(Clone, Deserialize)]
struct ArcTab {
    window: String,
    tab: String,
    title: String,
}
enum Destination {
    Arc { window: String, tab: String },
    Codex { id: String },
}
struct Link {
    group: String,
    created: Instant,
    destination: Destination,
}
#[derive(Default)]
pub struct Links {
    targets: HashMap<String, Link>,
    arc_tasks: HashMap<String, TaskSnapshot>,
}

pub fn accessibility_settings() -> Result<Value, String> {
    run(
        "/usr/bin/open",
        &["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"],
    )?;
    Ok(json!({"ok":true}))
}

fn context_entry(
    id: &str,
    title: &str,
    detail: &str,
    token: Option<&str>,
    processes: &[Identity],
    source: &str,
) -> Value {
    json!({"id":id,"title":title,"detail":detail,"token":token,"processes":processes,"source":source,"shared":false,"ambiguous":false})
}

fn attach_arc_tasks(
    entries: &mut Vec<Value>,
    tabs: &[ArcTab],
    snapshot: &TaskSnapshot,
    group: &Group,
    verify: impl Fn(&Identity) -> bool,
) -> usize {
    let mut unmatched = 0;
    let task_counts = snapshot
        .tasks
        .iter()
        .filter_map(|task| attribution::arc_title(&task.title))
        .fold(HashMap::<String, usize>::new(), |mut counts, title| {
            *counts.entry(title).or_default() += 1;
            counts
        });
    for (index, task) in snapshot.tasks.iter().enumerate() {
        let Some(title) = attribution::arc_title(&task.title) else {
            unmatched += 1;
            continue;
        };
        let candidates: Vec<_> = tabs
            .iter()
            .enumerate()
            .filter(|(_, tab)| tab.title.trim() == title)
            .collect();
        // Never expose titles absent from the ordinary-window list (private or unrelated tasks).
        if candidates.is_empty() {
            unmatched += 1;
            continue;
        }
        let Some(process) = group.processes.iter().find(|p| p.identity.pid == task.pid) else {
            unmatched += 1;
            continue;
        };
        if task.identity.as_ref() != Some(&process.identity) || !verify(&process.identity) {
            unmatched += 1;
            continue;
        }
        if candidates.len() == 1 && task_counts.get(&title) == Some(&1) {
            let entry = &mut entries[candidates[0].0];
            entry["processes"] = json!([process.identity]);
            entry["source"] = json!("Arc 任务管理器");
        } else {
            let mut entry = context_entry(
                &format!("arc-task:{}:{}:{index}", task.pid, process.identity.started),
                &title,
                "同名标签：已识别任务 PID，无法确定唯一原标签",
                None,
                &[process.identity.clone()],
                "Arc 任务管理器",
            );
            entry["ambiguous"] = json!(true);
            entries.push(entry);
        }
    }
    let mut owners = HashMap::<i32, usize>::new();
    for entry in entries.iter() {
        if let Some(processes) = entry["processes"].as_array() {
            for process in processes {
                if let Some(pid) = process["pid"].as_i64() {
                    *owners.entry(pid as i32).or_default() += 1;
                }
            }
        }
    }
    for entry in entries {
        entry["shared"] = json!(entry["processes"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| owners
                .get(&(id["pid"].as_i64().unwrap_or(0) as i32))
                .copied()
                .unwrap_or(0)
                > 1)));
    }
    unmatched
}

fn codex_database() -> Option<PathBuf> {
    let root = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".codex")))?;
    let mut candidates: Vec<_> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let version = name
                .strip_prefix("state_")?
                .strip_suffix(".sqlite")?
                .parse::<u32>()
                .ok()?;
            entry.path().is_file().then_some((version, entry.path()))
        })
        .collect();
    candidates.sort_by_key(|(version, _)| *version);
    candidates.pop().map(|(_, path)| path)
}

fn codex_titles(path: &Path) -> Result<Vec<(String, String, String)>, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "无法只读打开 Codex 对话索引")?;
    connection
        .busy_timeout(Duration::from_millis(500))
        .map_err(|_| "索引忙，请稍后重试")?;
    let mut statement=connection.prepare("SELECT id, substr(title,1,200), substr(cwd,1,512) FROM threads WHERE archived=0 AND has_user_event=1 ORDER BY updated_at DESC LIMIT 100").map_err(|_|"当前 Codex 索引版本不支持标题读取")?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|_| "读取对话标题失败")?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| "读取对话标题失败".into())
}

fn codex_linked_titles(
    path: &Path,
    ids: &[String],
) -> Result<HashMap<String, (String, String, bool)>, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "无法只读打开 Codex 对话索引")?;
    connection
        .busy_timeout(Duration::from_millis(500))
        .map_err(|_| "索引忙，请稍后重试")?;
    let mut statement = connection
        .prepare("SELECT substr(title,1,200), substr(cwd,1,512), archived FROM threads WHERE id=?1")
        .map_err(|_| "Codex 索引版本不支持工作进程标题查询")?;
    let mut result = HashMap::new();
    for id in ids.iter().take(100) {
        let row = statement
            .query_row([id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i32>(2)? != 0,
                ))
            })
            .optional()
            .map_err(|_| "读取工作进程的对话标题失败")?;
        if let Some(row) = row {
            result.insert(id.clone(), row);
        }
    }
    Ok(result)
}

impl Links {
    pub fn read_arc_tasks(
        &mut self,
        group: &Group,
        groups: &[Group],
        open: bool,
    ) -> Result<Value, String> {
        if !app_path(group)?.ends_with("/Arc.app") {
            return Err("此操作仅支持 Arc".into());
        }
        let snapshot = accessibility::read(group, open);
        self.arc_tasks.insert(group.id.clone(), snapshot);
        self.list(group, groups)
    }

    pub fn list(&mut self, group: &Group, groups: &[Group]) -> Result<Value, String> {
        let path = app_path(group)?;
        self.targets.retain(|_, link| {
            link.created.elapsed() < Duration::from_secs(300) && link.group != group.id
        });
        if self.targets.len() > 1000 {
            self.targets.clear();
        }
        self.arc_tasks
            .retain(|_, snapshot| crate::now().saturating_sub(snapshot.at) < 300_000);
        let mut entries = vec![];
        let mut diagnostics = Value::Null;
        let (kind, hint) = if path.ends_with("/Arc.app") {
            let tabs: Vec<ArcTab> = serde_json::from_slice(&run(
                "/usr/bin/osascript",
                &["-l", "AppleScript", "-e", ARC_LIST, path],
            )?)
            .map_err(|_| "Arc 返回的标签列表无效")?;
            for tab in &tabs {
                let token = uuid::Uuid::new_v4().to_string();
                entries.push(context_entry(
                    &format!("arc:{}:{}", tab.window, tab.tab),
                    &tab.title,
                    &format!("窗口 {}", tab.window),
                    Some(&token),
                    &[],
                    "Arc 标签接口",
                ));
                self.targets.insert(
                    token,
                    Link {
                        group: group.id.clone(),
                        created: Instant::now(),
                        destination: Destination::Arc {
                            window: tab.window.clone(),
                            tab: tab.tab.clone(),
                        },
                    },
                );
            }
            if let Some(snapshot) = self.arc_tasks.get(&group.id) {
                let unmatched = if snapshot.state == "ready" {
                    attach_arc_tasks(&mut entries, &tabs, snapshot, group, |id| {
                        native::identity(id.pid).as_ref() == Some(id)
                    })
                } else {
                    0
                };
                diagnostics = json!({"state":snapshot.state,"hint":snapshot.hint,"at":snapshot.at,"unmatchedTasks":unmatched,"readTasks":snapshot.tasks.len(),"partial":true});
            }
            ("arc","普通窗口标签最多 500 项。读取任务管理器可关联当前标签进程；同一 PID 可能承载多个标签，不能重复相加。未关联不代表零占用。映射五分钟失效，导航或新开标签后请重新读取。")
        } else if path.ends_with("/Codex.app")
            || (path.ends_with("/ChatGPT.app")
                && group
                    .processes
                    .iter()
                    .any(|p| p.identity.executable.to_lowercase().contains("codex")))
        {
            let database = codex_database().ok_or("没有找到本机 Codex 对话索引")?;
            let mut linked = attribution::codex_processes(group, groups, native::codex_thread);
            for (id, title, cwd) in codex_titles(&database)? {
                let Ok(id) = uuid::Uuid::parse_str(&id).map(|id| id.to_string()) else {
                    continue;
                };
                let token = uuid::Uuid::new_v4().to_string();
                let processes = linked.threads.remove(&id).unwrap_or_default();
                entries.push(context_entry(
                    &id,
                    if title.is_empty() {
                        "未命名对话"
                    } else {
                        &title
                    },
                    &cwd,
                    Some(&token),
                    &processes,
                    "CODEX_THREAD_ID",
                ));
                self.targets.insert(
                    token,
                    Link {
                        group: group.id.clone(),
                        created: Instant::now(),
                        destination: Destination::Codex { id: id.clone() },
                    },
                );
            }
            let missing_ids: Vec<_> = linked.threads.keys().cloned().take(100).collect();
            let mut older_titles = codex_linked_titles(&database, &missing_ids)?;
            for (id, processes) in linked.threads.into_iter().take(100) {
                // Active process markers may refer to an older or unindexed conversation.
                let token = uuid::Uuid::new_v4().to_string();
                let (title, detail) = match older_titles.remove(&id) {
                    Some((title, cwd, archived)) => (
                        if title.is_empty() {
                            "未命名对话".into()
                        } else {
                            title
                        },
                        if archived {
                            format!("{cwd} · 已归档，仍有工作进程")
                        } else {
                            cwd
                        },
                    ),
                    None => (
                        "未在索引中的对话".into(),
                        format!("对话 ID {id} · 由当前子进程标记识别"),
                    ),
                };
                entries.push(context_entry(
                    &id,
                    &title,
                    &detail,
                    Some(&token),
                    &processes,
                    "CODEX_THREAD_ID",
                ));
                self.targets.insert(
                    token,
                    Link {
                        group: group.id.clone(),
                        created: Instant::now(),
                        destination: Destination::Codex { id },
                    },
                );
            }
            diagnostics = json!({"state":"ready","at":crate::now(),"unreadable":linked.unreadable,"hint":"只读取同用户、Codex 进程树中工作进程的 CODEX_THREAD_ID；不读取消息或导出其他环境字段。共享界面、GPU 和服务内存不分摊到对话。"});
            ("codex","显示近期 100 个未归档对话及已识别的工作进程。指标仅是带对话标记的子进程合计，不是对话完整内存；包括历史对话，未关联不代表对话未运行。新任务启动后请重新读取关联。")
        } else {
            (
                "unsupported",
                "此应用尚无页面适配，可使用“打开应用”。系统进程名不能证明具体页面身份。",
            )
        };
        entries.sort_by_key(|entry| {
            entry["processes"]
                .as_array()
                .is_none_or(|ids| ids.is_empty())
        });
        let linked = entries.iter().any(|entry| {
            entry["processes"]
                .as_array()
                .is_some_and(|ids| !ids.is_empty())
        });
        let associated: std::collections::HashSet<_> = entries
            .iter()
            .filter_map(|entry| entry["processes"].as_array())
            .flatten()
            .filter_map(|id| id["pid"].as_i64())
            .collect();
        Ok(
            json!({"kind":kind,"hint":hint,"entries":entries,"mapping":if linked{"process-linked"}else{"application-only"},"at":crate::now(),"diagnostics":diagnostics,"unmappedProcesses":group.processes.iter().filter(|p|!associated.contains(&(p.identity.pid as i64))).count()}),
        )
    }

    pub fn open(&mut self, group: &Group, token: &str) -> Result<Value, String> {
        let path = app_path(group)?;
        let link = self
            .targets
            .get(token)
            .ok_or("跳转列表已失效，请重新读取")?;
        if link.group != group.id || link.created.elapsed() >= Duration::from_secs(300) {
            return Err("跳转列表已过期，请重新读取".into());
        }
        match &link.destination {
            Destination::Arc { window, tab } => {
                run(
                    "/usr/bin/osascript",
                    &["-l", "AppleScript", "-e", ARC_FOCUS, path, window, tab],
                )?;
            }
            Destination::Codex { id } => {
                run(
                    "/usr/bin/open",
                    &["-a", path, &format!("codex://threads/{id}")],
                )?;
            }
        }
        Ok(json!({"ok":true,"scope":"page"}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arc_shares_one_pid_without_duplicating_identity_and_rejects_private_ambiguous_and_recycled_links(
    ) {
        use crate::{
            accessibility::Task,
            model::{group_processes, tests::process},
        };
        let group = group_processes(
            vec![
                process(10, 1, "/Applications/Arc.app/Contents/MacOS/Arc"),
                process(11, 10, "/Applications/Arc.app/Contents/Frameworks/Renderer"),
                process(12, 10, "/Applications/Arc.app/Contents/Frameworks/Other"),
            ],
            501,
        )
        .remove(0);
        let tabs = vec![
            ArcTab {
                window: "w".into(),
                tab: "1".into(),
                title: "A".into(),
            },
            ArcTab {
                window: "w".into(),
                tab: "2".into(),
                title: "B".into(),
            },
            ArcTab {
                window: "w".into(),
                tab: "3".into(),
                title: "Same".into(),
            },
            ArcTab {
                window: "w".into(),
                tab: "4".into(),
                title: "Same".into(),
            },
            ArcTab {
                window: "w".into(),
                tab: "5".into(),
                title: "Recycled".into(),
            },
        ];
        let mut entries: Vec<_> = tabs
            .iter()
            .map(|tab| context_entry(&tab.tab, &tab.title, "", Some("token"), &[], "tabs"))
            .collect();
        let identity = Some(
            group
                .processes
                .iter()
                .find(|p| p.identity.pid == 11)
                .unwrap()
                .identity
                .clone(),
        );
        let mut recycled = group
            .processes
            .iter()
            .find(|p| p.identity.pid == 12)
            .unwrap()
            .identity
            .clone();
        recycled.started += 1;
        let snapshot = TaskSnapshot {
            state: "ready".into(),
            hint: String::new(),
            at: crate::now(),
            tasks: vec![
                Task {
                    title: "Tab: A".into(),
                    pid: 11,
                    identity: identity.clone(),
                },
                Task {
                    title: "Tab: B".into(),
                    pid: 11,
                    identity: identity.clone(),
                },
                Task {
                    title: "Tab: Same".into(),
                    pid: 11,
                    identity: identity.clone(),
                },
                Task {
                    title: "Tab: Private".into(),
                    pid: 11,
                    identity: identity.clone(),
                },
                Task {
                    title: "Subframe: secret".into(),
                    pid: 11,
                    identity: identity.clone(),
                },
                Task {
                    title: "Tab: Recycled".into(),
                    pid: 12,
                    identity: Some(recycled),
                },
            ],
        };
        assert_eq!(
            attach_arc_tasks(&mut entries, &tabs, &snapshot, &group, |_| true),
            3
        );
        assert_eq!(entries[0]["shared"], true);
        assert_eq!(entries[1]["shared"], true);
        assert_eq!(entries[0]["processes"].as_array().unwrap().len(), 1);
        assert!(entries[2]["processes"].as_array().unwrap().is_empty());
        assert_eq!(entries.last().unwrap()["ambiguous"], true);
        assert!(entries.last().unwrap()["token"].is_null());
        assert!(!serde_json::to_string(&entries).unwrap().contains("Private"));
        assert!(entries[4]["processes"].as_array().unwrap().is_empty());
    }
    #[test]
    fn apple_event_errors_preserve_codes_without_exposing_titles_or_script_source() {
        let failure = command_error(
            "/usr/bin/osascript",
            b"private title and script source: execution error (-1700)\n",
        );
        assert!(failure.contains("-1700"));
        assert!(failure.contains("类型转换"));
        assert!(!failure.contains("private title"));
        assert!(
            command_error("/usr/bin/osascript", b"execution error (-1743)").contains("自动化权限")
        );
        assert!(command_error("/usr/bin/osascript", b"execution error (-1712)").contains("超时"));
    }
    #[test]
    fn codex_index_reads_only_bounded_recent_titles_and_remains_read_only() {
        let path =
            std::env::temp_dir().join(format!("flowhub-contexts-{}.sqlite", uuid::Uuid::new_v4()));
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,archived INTEGER,has_user_event INTEGER,updated_at INTEGER); INSERT INTO threads VALUES('a','Visible','/project',0,1,2),('b','Archived','/secret',1,1,3),('c','Agent','/agent',0,0,4);").unwrap();
        let rows = codex_titles(&path).unwrap();
        assert_eq!(
            rows,
            vec![("a".into(), "Visible".into(), "/project".into())]
        );
        let linked = codex_linked_titles(&path, &["b".into(), "missing".into()]).unwrap();
        assert_eq!(
            linked.get("b"),
            Some(&("Archived".into(), "/secret".into(), true))
        );
        assert!(!linked.contains_key("missing"));
        drop(connection);
        std::fs::remove_file(path).unwrap();
    }
}
