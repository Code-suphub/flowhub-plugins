//! Arc's native task table, read only after an explicit user request.
//! No screen scraping, event injection, remote debugging or permission auto-grant.
use crate::{
    model::{Group, Identity},
    native,
};
use serde::Serialize;
use std::{
    collections::{HashSet, VecDeque},
    ffi::{c_char, c_void, CString},
    time::{Duration, Instant},
};

type Ref = *const c_void;
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXUIElementCreateApplication(pid: i32) -> Ref;
    fn AXUIElementCopyAttributeValue(element: Ref, attribute: Ref, value: *mut Ref) -> i32;
    fn AXUIElementPerformAction(element: Ref, action: Ref) -> i32;
    fn AXUIElementSetMessagingTimeout(element: Ref, timeout: f32) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(value: Ref);
    fn CFRetain(value: Ref) -> Ref;
    fn CFGetTypeID(value: Ref) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFArrayGetTypeID() -> usize;
    fn CFStringCreateWithCString(allocator: Ref, text: *const c_char, encoding: u32) -> Ref;
    fn CFStringGetCString(value: Ref, buffer: *mut c_char, size: isize, encoding: u32) -> bool;
    fn CFArrayGetCount(value: Ref) -> isize;
    fn CFArrayGetValueAtIndex(value: Ref, index: isize) -> Ref;
}
struct Owned(Ref);
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}
impl Owned {
    fn string(text: &str) -> Self {
        let text = CString::new(text).unwrap();
        Self(unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), 0x08000100) })
    }
    fn attribute(&self, name: &str) -> Option<Self> {
        let key = Self::string(name);
        let mut value = std::ptr::null();
        let status = unsafe { AXUIElementCopyAttributeValue(self.0, key.0, &mut value) };
        if status == 0 && !value.is_null() {
            Some(Self(value))
        } else {
            None
        }
    }
    fn text(&self) -> String {
        if self.0.is_null() || unsafe { CFGetTypeID(self.0) != CFStringGetTypeID() } {
            return String::new();
        }
        let mut buffer = vec![0_u8; 8192];
        if !unsafe {
            CFStringGetCString(
                self.0,
                buffer.as_mut_ptr().cast(),
                buffer.len() as isize,
                0x08000100,
            )
        } {
            return String::new();
        }
        let end = buffer.iter().position(|v| *v == 0).unwrap_or(buffer.len());
        String::from_utf8_lossy(&buffer[..end]).into_owned()
    }
    fn label(&self, key: &str) -> String {
        self.attribute(key).map(|v| v.text()).unwrap_or_default()
    }
    fn array(&self) -> Vec<Self> {
        if self.0.is_null() || unsafe { CFGetTypeID(self.0) != CFArrayGetTypeID() } {
            return vec![];
        }
        let count = unsafe { CFArrayGetCount(self.0) }.clamp(0, 2048);
        (0..count)
            .filter_map(|i| {
                let value = unsafe { CFArrayGetValueAtIndex(self.0, i) };
                (!value.is_null()).then(|| Self(unsafe { CFRetain(value) }))
            })
            .collect()
    }
    fn children(&self, key: &str) -> Vec<Self> {
        self.attribute(key).map(|v| v.array()).unwrap_or_default()
    }
    fn press(&self) -> bool {
        let action = Self::string("AXPress");
        unsafe { AXUIElementPerformAction(self.0, action.0) == 0 }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub title: String,
    pub pid: i32,
    #[serde(skip)]
    pub identity: Option<Identity>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub state: String,
    pub hint: String,
    pub at: u64,
    pub tasks: Vec<Task>,
}
impl TaskSnapshot {
    fn state(state: &str, hint: &str) -> Self {
        Self {
            state: state.into(),
            hint: hint.into(),
            at: crate::now(),
            tasks: vec![],
        }
    }
}

fn cell_text(element: &Owned, depth: usize) -> String {
    for key in ["AXValue", "AXTitle", "AXDescription"] {
        let text = element.label(key);
        if !text.is_empty() {
            return text;
        }
    }
    if depth > 0 {
        for child in element.children("AXChildren").into_iter().take(12) {
            let text = cell_text(&child, depth - 1);
            if !text.is_empty() {
                return text;
            }
        }
    }
    String::new()
}
fn task_window(app: &Owned) -> Option<Owned> {
    app.children("AXWindows").into_iter().find(|window| {
        matches!(
            window.label("AXTitle").as_str(),
            "Task Manager" | "任务管理器" | "工作管理員"
        )
    })
}
fn find_table(window: Owned) -> Option<Owned> {
    let mut queue = VecDeque::from([(window, 0)]);
    let started = Instant::now();
    for _ in 0..160 {
        if started.elapsed() > Duration::from_secs(3) {
            break;
        }
        let (element, depth) = queue.pop_front()?;
        if element.label("AXRole") == "AXTable" {
            return Some(element);
        }
        if depth < 8 {
            queue.extend(
                element
                    .children("AXChildren")
                    .into_iter()
                    .take(40)
                    .map(|child| (child, depth + 1)),
            );
        }
    }
    None
}
fn open_manager(app: &Owned) -> bool {
    // Invoke Arc's own menu command; never enable debug flags or synthesize keystrokes.
    let Some(menu) = app.attribute("AXMenuBar") else {
        return false;
    };
    let mut queue = VecDeque::from([(menu, 0)]);
    let started = Instant::now();
    for _ in 0..400 {
        if started.elapsed() > Duration::from_secs(3) {
            break;
        }
        let Some((element, depth)) = queue.pop_front() else {
            break;
        };
        let title = element.label("AXTitle");
        if matches!(
            title.as_str(),
            "Open Task Manager" | "打开任务管理器" | "開啟工作管理員"
        ) {
            return element.press();
        }
        if depth < 7 {
            queue.extend(
                element
                    .children("AXChildren")
                    .into_iter()
                    .take(100)
                    .map(|child| (child, depth + 1)),
            );
        }
    }
    false
}
fn pid_header(text: &str) -> bool {
    let text = text.to_lowercase();
    text.contains("process id")
        || text.contains("进程 id")
        || text.contains("进程id")
        || text.contains("處理程序 id")
        || text.contains("處理程序識別碼")
}
fn parse_task(cells: &[String], pid_column: usize, title_column: usize) -> Option<Task> {
    let pid_text = cells.get(pid_column)?.trim();
    if pid_text.is_empty() || !pid_text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let pid = pid_text.parse::<i32>().ok().filter(|pid| *pid > 1)?;
    let title = cells
        .get(title_column)?
        .chars()
        .take(400)
        .collect::<String>();
    (!title.is_empty()).then_some(Task {
        title,
        pid,
        identity: None,
    })
}

pub fn read(group: &Group, open: bool) -> TaskSnapshot {
    if !unsafe { AXIsProcessTrusted() } {
        return TaskSnapshot::state("permission-required","需要在系统设置 → 隐私与安全性 → 辅助功能中允许 FlowHub；授权后重新读取。仅有自动化权限不足以读取任务管理器。");
    }
    let Some(path) = group.app_path.as_deref() else {
        return TaskSnapshot::state("unavailable", "没有找到 Arc 应用。");
    };
    let Some(main) = group.processes.iter().find(|p| {
        p.identity.executable == format!("{path}/Contents/MacOS/Arc")
            && p.identity.uid == native::uid()
    }) else {
        return TaskSnapshot::state("unavailable", "Arc 主进程已变化，请刷新应用列表。");
    };
    if native::identity(main.identity.pid).as_ref() != Some(&main.identity) {
        return TaskSnapshot::state("unavailable", "Arc 进程身份已变化，请重新读取。");
    }
    let app = Owned(unsafe { AXUIElementCreateApplication(main.identity.pid) });
    unsafe {
        AXUIElementSetMessagingTimeout(app.0, 0.25);
    }
    let started = Instant::now();
    let mut window = task_window(&app);
    if window.is_none() && open && open_manager(&app) {
        while window.is_none() && started.elapsed() < Duration::from_millis(1800) {
            std::thread::sleep(Duration::from_millis(100));
            window = task_window(&app);
        }
    }
    let Some(window) = window else {
        return TaskSnapshot::state(
            "task-manager-closed",
            "请在 Arc 的 Help → Troubleshooting → Open Task Manager 打开任务管理器，然后重新读取。",
        );
    };
    let Some(table) = find_table(window) else {
        return TaskSnapshot::state("unavailable", "任务管理器表格尚未就绪，请稍后重新读取。");
    };
    let mut rows = table.children("AXRows");
    if rows.is_empty() {
        rows = table
            .children("AXChildren")
            .into_iter()
            .filter(|r| r.label("AXRole") == "AXRow")
            .collect();
    }
    let mut pid_column = None;
    let mut title_column = 0;
    for (index, column) in table.children("AXColumns").iter().enumerate() {
        let title = column
            .attribute("AXHeader")
            .map(|header| cell_text(&header, 2))
            .unwrap_or_else(|| cell_text(column, 1));
        if pid_header(&title) {
            pid_column = Some(index);
        }
    }
    let reading_started = Instant::now();
    let cells: Vec<Vec<String>> = rows
        .iter()
        .take(1500)
        .take_while(|_| reading_started.elapsed() < Duration::from_secs(4))
        .map(|row| {
            row.children("AXChildren")
                .iter()
                .map(|cell| cell_text(cell, 3))
                .collect()
        })
        .collect();
    for row in &cells {
        if let Some(index) = row.iter().position(|cell| pid_header(cell)) {
            pid_column = Some(index);
            title_column = row
                .iter()
                .position(|cell| {
                    cell.contains("任务") || cell.contains("Task") || cell.contains("工作")
                })
                .unwrap_or(0);
            break;
        }
    }
    let Some(pid_column) = pid_column else {
        return TaskSnapshot::state(
            "pid-column-missing",
            "请在 Arc 任务管理器的表头菜单中显示“进程 ID / Process ID”列，再重新读取。",
        );
    };
    let mut seen = HashSet::new();
    let tasks: Vec<_> = cells
        .iter()
        .filter_map(|cells| parse_task(cells, pid_column, title_column))
        .filter(|task| seen.insert((task.pid, task.title.clone())))
        .map(|mut task| {
            task.identity = group
                .processes
                .iter()
                .find(|p| p.identity.pid == task.pid)
                .filter(|p| native::identity(task.pid).as_ref() == Some(&p.identity))
                .map(|p| p.identity.clone());
            task
        })
        .collect();
    let mut result=TaskSnapshot::state("ready","已读取 Arc 当前可访问的任务行，受任务管理器筛选和滚动位置影响；只关联普通窗口标签，同名标签不推断唯一跳转。未匹配任务保留为未识别进程。");
    result.tasks = tasks;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pid_column_is_explicit_and_never_confused_with_memory_or_cpu() {
        let cells = vec![
            "Tab: Work".into(),
            "624 MB".into(),
            "0.2".into(),
            "0".into(),
            "62920".into(),
        ];
        assert_eq!(parse_task(&cells, 4, 0).unwrap().pid, 62920);
        assert!(parse_task(&cells, 1, 0).is_none());
        assert!(parse_task(&cells, 3, 0).is_none());
        assert!(parse_task(&["Tab".into(), "-".into()], 1, 0).is_none());
        assert!(pid_header("“进程 ID”列"));
        assert!(pid_header("Process ID"));
    }
}
