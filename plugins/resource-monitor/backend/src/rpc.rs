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
        "script_activity" => Some(Ok(cache.get().scripts())),
        "diagnostic_event" => Some(crate::diagnostics::client(params)),
        "widget_api" => match params["action"].as_str() {
            Some("snapshot") => Some(Ok(cache.get().status())),
            Some("management") => match params["method"].as_str() {
                Some(method @ ("snapshot" | "ranking_snapshot" | "group_detail" | "script_activity" | "diagnostic_event")) => {
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
    let mut encoded = response.to_string();
    // The host stops reading a session after a line exceeds 4 MiB. Return a
    // bounded error instead of turning one oversized detail into later timeouts.
    if encoded.len()>4*1024*1024 {
        crate::diagnostics::event("rpc_response_too_large",json!({"bytes":encoded.len()}));
        encoded=json!({"id":id,"error":"插件响应数据过大，请缩小查询范围"}).to_string();
    }
    if let Ok(mut output) = output.lock() {
        if let Err(error)=writeln!(output, "{encoded}").and_then(|_| output.flush()) {
            crate::diagnostics::event("rpc_write_failed",json!({"kind":format!("{:?}",error.kind()),"bytes":encoded.len()}));
        }
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
            Ok(0) => break,
            Err(error) => {crate::diagnostics::event("rpc_read_failed",json!({"kind":format!("{:?}",error.kind())}));break;},
            _ => {}
        }
        if line.len() > 65536 {
            crate::diagnostics::event("rpc_request_too_large",json!({"bytes":line.len()}));
            break;
        }
        let Ok(req) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let started=std::time::Instant::now();
        if let Some(result) = read(
            &reader_cache,
            req["method"].as_str().unwrap_or(""),
            &req["params"],
        ) {
            let failed=result.is_err();
            respond(&reader_output, &req["id"], result);
            if failed||started.elapsed()>=std::time::Duration::from_secs(1) {
                let method=if req["method"]=="widget_api" {req["params"]["method"].as_str().unwrap_or("status_snapshot")} else {req["method"].as_str().unwrap_or("")};
                crate::diagnostics::event("rpc_read",json!({"method":crate::diagnostics::method(method),"elapsedMs":started.elapsed().as_millis() as u64,"failed":failed}));
            }
        } else if let Err(error) = send.try_send(req) {
            crate::diagnostics::event("rpc_queue_full",json!({}));
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
                let started=std::time::Instant::now();
                let result = action(Some(&req));
                if result.is_err()||started.elapsed()>=std::time::Duration::from_secs(1) {
                    let method=if req["method"]=="widget_api" {req["params"]["method"].as_str()} else {req["method"].as_str()};
                    crate::diagnostics::event("rpc_action",json!({"method":crate::diagnostics::method(method.unwrap_or("")),"elapsedMs":started.elapsed().as_millis() as u64,"failed":result.is_err()}));
                }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_response_is_an_error_and_keeps_the_next_response_readable() {
        let output=Mutex::new(Vec::new());
        respond(&output,&json!(1),Ok(json!({"payload":"x".repeat(4*1024*1024)})));
        respond(&output,&json!(2),Ok(json!({"ok":true})));
        let bytes=output.into_inner().unwrap();let text=String::from_utf8(bytes).unwrap();
        let lines:Vec<Value>=text.lines().map(|line|serde_json::from_str(line).unwrap()).collect();
        assert_eq!(lines.len(),2);assert_eq!(lines[0]["id"],1);assert!(lines[0]["error"].as_str().unwrap().contains("过大"));
        assert_eq!(lines[1]["id"],2);assert_eq!(lines[1]["result"]["ok"],true);assert!(text.len()<1024);
    }
}
