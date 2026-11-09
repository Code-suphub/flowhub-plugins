//! Bounded local diagnostics. Never record RPC parameters, paths, command lines,
//! search text, window titles, tokens, or the raw contents of remote errors.
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

const MAX_BYTES: u64 = 2 * 1024 * 1024;
static LOGGER: OnceLock<Logger> = OnceLock::new();
struct Logger {
    sender: mpsc::SyncSender<Message>,
    state: Arc<Mutex<State>>,
    dropped: Arc<AtomicU64>,
}
enum Message {
    Event(Value),
    Flush(mpsc::Sender<()>),
}
#[derive(Default)]
struct State {
    sample: Option<Sample>,
    last_summary: Option<Instant>,
    failed: bool,
    helper: Option<String>,
}
struct Sample {
    start: Instant,
    phase_start: Instant,
    phase: &'static str,
    phases: Map<String, Value>,
    warned: bool,
}
fn millis(at: Instant) -> u64 {
    at.elapsed().as_millis().min(u64::MAX as u128) as u64
}
fn record(event: &str, data: Value) -> Value {
    json!({"at":crate::now(),"pid":std::process::id(),"event":event,"data":data})
}
pub fn init() {
    let Some(data) = std::env::var_os("FLOWHUB_PLUGIN_DATA") else {
        return;
    };
    let path = PathBuf::from(data).join("diagnostics.jsonl");
    let (sender, receiver) = mpsc::sync_channel(128);
    let state = Arc::new(Mutex::new(State::default()));
    let dropped = Arc::new(AtomicU64::new(0));
    if LOGGER
        .set(Logger {
            sender,
            state: state.clone(),
            dropped: dropped.clone(),
        })
        .is_err()
    {
        return;
    }
    std::thread::spawn(move || {
        let mut output = LogFile::new(path, MAX_BYTES);
        let mut repeats = Repeats::default();
        let mut last_drops = Instant::now();
        loop {
            match receiver.recv_timeout(Duration::from_secs(1)) {
                Ok(Message::Event(value)) => {
                    let now = Instant::now();
                    for value in repeats.due(now, false) {
                        output.write(&value);
                    }
                    if let Some(value) = repeats.accept(value, now) {
                        output.write(&value);
                    }
                }
                Ok(Message::Flush(done)) => {
                    for value in repeats.due(Instant::now(), true) {
                        output.write(&value);
                    }
                    let count = dropped.swap(0, Ordering::Relaxed);
                    if count > 0 {
                        output.write(&record("diagnostic_queue_dropped", json!({"count":count})));
                    }
                    let _ = done.send(());
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            for value in repeats.due(Instant::now(), false) {
                output.write(&value);
            }
            if last_drops.elapsed() >= Duration::from_secs(60) {
                let count = dropped.swap(0, Ordering::Relaxed);
                last_drops = Instant::now();
                if count > 0 {
                    output.write(&record("diagnostic_queue_dropped", json!({"count":count})));
                }
            }
            // Drop the sampler state lock before any filesystem operation.
            let stalled = { state.lock().unwrap_or_else(|p| p.into_inner()).stalled() };
            if let Some(value) = stalled {
                output.write(&value);
            }
        }
    });
    event(
        "backend_started",
        json!({"version":env!("CARGO_PKG_VERSION")}),
    );
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Panic text can include process metadata; only retain the source line.
        event(
            "backend_panic",
            json!({"line":info.location().map(|p|p.line())}),
        );
        flush();
        previous(info);
    }));
}
// Keep individual failed RPC traces searchable. Only repeated background
// collection/connection events are coalesced, with a one-minute count summary.
#[derive(Default)]
struct Repeats {
    entries: HashMap<String, Repeat>,
}
struct Repeat {
    at: Instant,
    count: u64,
    last: Value,
}
impl Repeats {
    fn accept(&mut self, value: Value, now: Instant) -> Option<Value> {
        let name = value["event"].as_str().unwrap_or("");
        if !matches!(
            name,
            "sample_completed"
                | "sample_failed"
                | "sample_stalled"
                | "helper_connected"
                | "helper_unavailable"
        ) {
            return Some(value);
        }
        let data = &value["data"];
        if data["changed"] == true {
            return Some(value);
        }
        let key = format!(
            "{name}:{}:{}:{}",
            data["status"], data["error"], data["phase"]
        );
        if let Some(previous) = self.entries.get_mut(&key) {
            if now.duration_since(previous.at) < Duration::from_secs(60) {
                previous.count = previous.count.saturating_add(1);
                previous.last = value;
                return None;
            }
        }
        // The key fields are generated internally, but cap memory as well.
        if self.entries.len() >= 64 && !self.entries.contains_key(&key) {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, v)| v.at)
                .map(|(k, _)| k.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(
            key,
            Repeat {
                at: now,
                count: 0,
                last: value.clone(),
            },
        );
        Some(value)
    }
    fn due(&mut self, now: Instant, force: bool) -> Vec<Value> {
        let keys: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, v)| force || now.duration_since(v.at) >= Duration::from_secs(60))
            .map(|(k, _)| k.clone())
            .collect();
        keys.into_iter().filter_map(|key|{
            let entry=self.entries.remove(&key)?;
            (entry.count>0).then(||record("diagnostic_repeats",json!({"event":entry.last["event"],"suppressed":entry.count,"lastAt":entry.last["at"],"last":entry.last["data"]})))
        }).collect()
    }
}
pub fn event(name: &str, data: Value) {
    if let Some(logger) = LOGGER.get() {
        if logger
            .sender
            .try_send(Message::Event(record(name, data)))
            .is_err()
        {
            logger.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}
pub fn flush() {
    if let Some(logger) = LOGGER.get() {
        let (send, receive) = mpsc::channel();
        if logger.sender.try_send(Message::Flush(send)).is_ok() {
            let _ = receive.recv_timeout(Duration::from_millis(500));
        }
    }
}
pub fn sample_started() {
    if let Some(logger) = LOGGER.get() {
        let at = Instant::now();
        logger
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .sample = Some(Sample {
            start: at,
            phase_start: at,
            phase: "processes",
            phases: Map::new(),
            warned: false,
        });
    }
}
pub fn phase(name: &'static str) {
    if let Some(logger) = LOGGER.get() {
        if let Some(sample) = &mut logger
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .sample
        {
            sample
                .phases
                .insert(sample.phase.into(), json!(millis(sample.phase_start)));
            sample.phase = name;
            sample.phase_start = Instant::now();
        }
    }
}
pub fn sample_finished(error: Option<&str>, processes: usize, groups: usize) {
    if let Some(logger) = LOGGER.get() {
        let mut state = logger.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some(mut sample) = state.sample.take() else {
            return;
        };
        sample
            .phases
            .insert(sample.phase.into(), json!(millis(sample.phase_start)));
        let elapsed = millis(sample.start);
        let recovered = state.failed && error.is_none();
        let log = error.is_some()
            || recovered
            || elapsed >= 1000
            || state
                .last_summary
                .is_none_or(|at| at.elapsed() >= Duration::from_secs(60));
        state.failed = error.is_some();
        if log {
            state.last_summary = Some(Instant::now());
            // Collection errors are fixed messages generated by this backend.
            event(
                if error.is_some() {
                    "sample_failed"
                } else if recovered {
                    "sample_recovered"
                } else {
                    "sample_completed"
                },
                json!({"elapsedMs":elapsed,"phasesMs":sample.phases,"processes":processes,"groups":groups,"error":error,"retainedSnapshot":error.is_some()}),
            );
        }
    }
}
impl State {
    fn stalled(&mut self) -> Option<Value> {
        let sample = self.sample.as_mut()?;
        if sample.warned || sample.start.elapsed() < Duration::from_secs(10) {
            return None;
        }
        sample.warned = true;
        Some(record(
            "sample_stalled",
            json!({"phase":sample.phase,"elapsedMs":millis(sample.start),"phaseElapsedMs":millis(sample.phase_start)}),
        ))
    }
}
pub fn helper(result: Result<usize, &str>, elapsed_ms: u64) {
    if let Some(logger) = LOGGER.get() {
        let mut state = logger.state.lock().unwrap_or_else(|p| p.into_inner());
        let status = result
            .as_ref()
            .map(|_| "connected")
            .unwrap_or_else(|code| *code);
        let changed = state.helper.as_deref() != Some(status);
        if changed || elapsed_ms >= 1000 {
            event(
                if result.is_ok() {
                    "helper_connected"
                } else {
                    "helper_unavailable"
                },
                json!({"status":status,"elapsedMs":elapsed_ms,"processes":result.ok(),"changed":changed}),
            );
        }
        state.helper = Some(status.into());
    }
}
pub fn method(name: &str) -> &str {
    match name {
        "health"
        | "snapshot"
        | "status_snapshot"
        | "ranking_snapshot"
        | "group_detail"
        | "script_activity"
        | "script_observer_status"
        | "script_observer_event"
        | "script_observer_config"
        | "refresh"
        | "refresh_summary"
        | "application_state"
        | "application_metadata"
        | "privileged_status"
        | "privileged_enable"
        | "privileged_disable"
        | "terminate_preview"
        | "terminate_confirm"
        | "quit_preview"
        | "quit_confirm"
        | "contexts"
        | "arc_tasks"
        | "focus_app"
        | "open_context"
        | "accessibility_settings"
        | "services_snapshot"
        | "service_preview"
        | "service_confirm"
        | "startup_snapshot"
        | "startup_set"
        | "startup_stop"
        | "login_items_settings"
        | "diagnostic_event" => name,
        _ => "unknown",
    }
}
pub fn trace_id(value: &Value) -> Option<&str> {
    value.as_str().filter(|id| {
        id.len() == 32
            && id
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
fn surface(value: &Value) -> &str {
    match value.as_str() {
        Some(s @ ("main" | "card" | "detail" | "editor")) => s,
        _ => "unknown",
    }
}
pub fn request(req: &Value) -> Value {
    let params = &req["params"];
    let name = if req["method"] == "widget_api" {
        params["method"].as_str().unwrap_or("status_snapshot")
    } else {
        req["method"].as_str().unwrap_or("")
    };
    json!({"method":method(name),"traceId":trace_id(&params["_trace"]["traceId"]),"surface":surface(&params["_trace"]["surface"]),"backendRequestId":req["id"].as_u64()})
}
pub fn client(params: &Value) -> Result<Value, String> {
    let code = match params["code"].as_str() {
        Some(
            code @ ("timeout" | "response_error" | "send_failed" | "late_response" | "recovered"),
        ) => code,
        _ => return Err("诊断事件无效".into()),
    };
    let surface = surface(&params["surface"]);
    let reason = match params["reason"].as_str() {
        Some(
            reason @ ("paused" | "backend_closed" | "timeout" | "busy" | "oversized"
            | "revision_changed" | "request_failed"),
        ) => Some(reason),
        _ => None,
    };
    event(
        "client_request",
        json!({"code":code,"reason":reason,"surface":surface,"method":method(params["method"].as_str().unwrap_or("")),"traceId":trace_id(&params["traceId"]),
        "elapsedMs":params["elapsedMs"].as_u64().map(|v|v.min(86_400_000)),"hidden":params["hidden"].as_bool(),"hiddenAtStart":params["hiddenAtStart"].as_bool()}),
    );
    Ok(json!({"recorded":true}))
}

struct LogFile {
    path: PathBuf,
    limit: u64,
    file: Option<File>,
    bytes: u64,
    retry_after: Option<Instant>,
}
impl LogFile {
    fn new(path: PathBuf, limit: u64) -> Self {
        Self {
            path,
            limit,
            file: None,
            bytes: 0,
            retry_after: None,
        }
    }
    fn open(&mut self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&self.path)?;
        self.bytes = file.metadata()?.len();
        self.file = Some(file);
        Ok(())
    }
    fn write(&mut self, value: &Value) {
        if self.retry_after.is_some_and(|at| Instant::now() < at) {
            return;
        }
        self.retry_after = None;
        let mut bytes = value.to_string().into_bytes();
        bytes.push(b'\n');
        let result = (|| -> std::io::Result<()> {
            if self.file.is_none() {
                self.open()?;
            }
            if self.bytes + bytes.len() as u64 > self.limit {
                self.file.take();
                std::fs::rename(&self.path, previous_path(&self.path))?;
                self.open()?;
            }
            self.file.as_mut().unwrap().write_all(&bytes)?;
            self.bytes += bytes.len() as u64;
            Ok(())
        })();
        if let Err(error) = result {
            self.file.take();
            self.retry_after = Some(Instant::now() + Duration::from_secs(10));
            eprintln!(
                "resource-monitor diagnostics write failed: {:?}",
                error.kind()
            );
        }
    }
}
fn previous_path(path: &Path) -> PathBuf {
    path.with_file_name("diagnostics.previous.jsonl")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_traces_cross_widget_and_main_without_logging_parameters() {
        let trace = "0123456789abcdef0123456789abcdef";
        for request in [
            json!({"id":7,"method":"terminate_confirm","params":{"token":"secret","_trace":{"traceId":trace,"surface":"main"}}}),
            json!({"id":8,"method":"widget_api","params":{"action":"management","method":"terminate_confirm","params":{"token":"secret"},"_trace":{"traceId":trace,"surface":"detail"}}}),
        ] {
            let data = super::request(&request);
            assert_eq!(data["traceId"], trace);
            assert_eq!(data["method"], "terminate_confirm");
            assert!(!data.to_string().contains("secret"));
        }
        let invalid = super::request(
            &json!({"id":"/private/secret","method":"/private/secret","params":{"_trace":{"traceId":"/private/secret","surface":"/private/secret"}}}),
        );
        assert!(invalid["traceId"].is_null());
        assert!(invalid["backendRequestId"].is_null());
        assert!(!invalid.to_string().contains("private"));
        assert!(trace_id(&json!("a".repeat(33))).is_none());
    }
    #[test]
    fn repeated_background_failures_are_summarized_but_rpc_traces_are_kept() {
        let mut repeats = Repeats::default();
        let start = Instant::now();
        let failure = record("sample_failed", json!({"error":"fixed-error"}));
        assert!(repeats.accept(failure.clone(), start).is_some());
        for seconds in [5, 10, 15] {
            assert!(repeats
                .accept(failure.clone(), start + Duration::from_secs(seconds))
                .is_none());
        }
        assert!(repeats
            .accept(
                record("sample_recovered", json!({})),
                start + Duration::from_secs(20)
            )
            .is_some());
        for _ in 0..100 {
            assert!(repeats
                .accept(
                    record(
                        "client_request",
                        json!({"code":"timeout","traceId":"0123456789abcdef0123456789abcdef"})
                    ),
                    start
                )
                .is_some());
        }
        assert!(repeats
            .due(start + Duration::from_secs(59), false)
            .is_empty());
        let summaries = repeats.due(start + Duration::from_secs(60), false);
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0]["data"]["suppressed"], 3);
        assert_eq!(summaries[0]["data"]["event"], "sample_failed");
        assert!(repeats
            .accept(failure, start + Duration::from_secs(60))
            .is_some());
        for n in 0..100 {
            repeats.accept(
                record("helper_unavailable", json!({"status":format!("fixed-{n}")})),
                start,
            );
        }
        assert!(repeats.entries.len() <= 64);
    }
    #[test]
    fn bounded_logs_rotate_and_remain_private() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("flowhub-diagnostics-{}", uuid::Uuid::new_v4()));
        let path = root.join("diagnostics.jsonl");
        let mut file = LogFile::new(path.clone(), 180);
        for n in 0..12 {
            file.write(&record("fixture", json!({"n":n})));
        }
        for path in [&path, &previous_path(&path)] {
            assert!(std::fs::metadata(path).unwrap().len() <= 180);
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            for line in std::fs::read_to_string(path).unwrap().lines() {
                assert!(serde_json::from_str::<Value>(line).is_ok());
            }
        }
        drop(file);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn watchdog_records_a_slow_stage_once() {
        let start = Instant::now() - Duration::from_secs(11);
        let mut state = State {
            sample: Some(Sample {
                start,
                phase_start: start,
                phase: "services",
                phases: Map::new(),
                warned: false,
            }),
            ..State::default()
        };
        let record = state.stalled().unwrap();
        assert_eq!(record["event"], "sample_stalled");
        assert_eq!(record["data"]["phase"], "services");
        assert!(state.stalled().is_none());
    }
    #[test]
    fn client_rejects_unbounded_events_and_unknown_methods_are_redacted() {
        assert!(client(&json!({"code":"/private/file"})).is_err());
        assert_eq!(method("/private/token"), "unknown");
        assert_eq!(method("ranking_snapshot"), "ranking_snapshot");
    }
}
