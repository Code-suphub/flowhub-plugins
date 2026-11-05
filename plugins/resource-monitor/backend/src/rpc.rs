//! Read requests never queue behind collection, refresh, or a slow action.
use crate::{cache::Cache, Monitor};
use serde_json::{json, Value};
use std::{
    io::{BufRead, Read, Write},
    sync::{mpsc, Arc, Mutex},
};

pub fn read(cache: &Cache, method: &str, params: &Value) -> Option<Result<Value, String>> {
    match method {
        "health" => Some(Ok(json!({"protocol":2,"name":"resource-monitor"}))),
        "status_snapshot" => Some(Ok(cache.get().status())),
        "snapshot" => Some(Ok(cache.get().full())),
        "ranking_snapshot" => Some(Ok(cache.get().ranking(params))),
        "group_detail" => Some(cache.get().detail(params)),
        "widget_api" => match params["action"].as_str() {
            Some("snapshot") => Some(Ok(cache.get().status())),
            Some("management") => match params["method"].as_str() {
                Some(method @ ("snapshot" | "ranking_snapshot" | "group_detail")) => {
                    read(cache, method, &params["params"])
                }
                _ => None,
            },
            _ => None,
        },
        _ => None,
    }
}
fn respond(output: &Mutex<impl Write>, id: &Value, result: Result<Value, String>) {
    let response = match result {
        Ok(value) => json!({"id":id,"result":value}),
        Err(error) => json!({"id":id,"error":error}),
    };
    // Serialize outside the stdout lock so a large legacy response cannot hold
    // up serialization of a small status response. Each response remains a line.
    let encoded = response.to_string();
    if let Ok(mut output) = output.lock() {
        let _ = writeln!(output, "{encoded}").and_then(|_| output.flush());
    }
}
pub fn serve(mut monitor: Monitor, input: impl BufRead + Send + 'static) {
    let cache = monitor.cache.clone();
    serve_with(
        cache,
        input,
        std::io::stdout(),
        true,
        move |request| match request {
            Some(req) => monitor.dispatch(req["method"].as_str().unwrap_or(""), &req["params"]),
            None => monitor.refresh().map(|_| Value::Null),
        },
    );
}
pub(super) fn serve_with(
    cache: Cache,
    mut input: impl BufRead + Send + 'static,
    output: impl Write + Send + 'static,
    background: bool,
    mut action: impl FnMut(Option<&Value>) -> Result<Value, String>,
) {
    let output = Arc::new(Mutex::new(output));
    let (send, receive) = mpsc::sync_channel::<Value>(32);
    let reader_output = output.clone();
    let reader_cache = cache.clone();
    std::thread::spawn(move || loop {
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
        if let Some(result) = read(
            &reader_cache,
            req["method"].as_str().unwrap_or(""),
            &req["params"],
        ) {
            respond(&reader_output, &req["id"], result);
        } else if let Err(error) = send.try_send(req) {
            let (mpsc::TrySendError::Full(req) | mpsc::TrySendError::Disconnected(req)) = error;
            respond(
                &reader_output,
                &req["id"],
                Err("待处理操作过多，请稍后重试".into()),
            );
        }
    });
    // All sampling and actions run on the caller's thread (the process main
    // thread in production). AppKit registration updates need a stable run loop.
    // The bounded input queue preserves action order; reads bypass it entirely.
    let mut next_sample = std::time::Instant::now();
    loop {
        let request = if background {
            receive.recv_timeout(next_sample.saturating_duration_since(std::time::Instant::now()))
        } else {
            receive
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected)
        };
        match request {
            Ok(req) => {
                let revision = cache.get().revision;
                let result = action(Some(&req));
                // An action that sampled already satisfies this background tick.
                if cache.get().revision != revision {
                    next_sample = std::time::Instant::now() + std::time::Duration::from_secs(5);
                }
                respond(&output, &req["id"], result);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = action(None);
                next_sample = std::time::Instant::now() + std::time::Duration::from_secs(5);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}
