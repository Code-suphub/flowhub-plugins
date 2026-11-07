use serde_json::{json, Map, Value};
use std::{io::Read, path::Path, process::{Command, Stdio}, sync::OnceLock, thread, time::{Duration, Instant}};

const FAMILIES: &[&str] = &["iphone", "airpods-pro", "airpods", "apple-mouse", "apple-keyboard", "macbook"];
static ICONS: OnceLock<Value> = OnceLock::new();

fn sanitize(value: Value) -> Value {
    let mut icons = Map::new();
    if let Some(input) = value.as_object() {
        for family in FAMILIES {
            let Some(item) = input.get(*family) else { continue };
            let Some(url) = item["dataUrl"].as_str() else { continue };
            let Some(encoded) = url.strip_prefix("data:image/png;base64,") else { continue };
            let Some(identifier) = item["typeIdentifier"].as_str() else { continue };
            if encoded.len() > 90_000 || !encoded.starts_with("iVBORw0KGgo")
                || !encoded.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
                || identifier.len() > 100 || !identifier.starts_with("com.apple.") {
                continue;
            }
            icons.insert((*family).into(), json!({"dataUrl":url,"typeIdentifier":identifier,"source":"macos"}));
        }
    }
    json!({"available":!icons.is_empty(),"icons":icons,"provider":"macos"})
}

fn read_helper(path: &Path) -> Option<Value> {
    let mut child = Command::new(path).stdin(Stdio::null()).stderr(Stdio::null()).stdout(Stdio::piped()).spawn().ok()?;
    let stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(600_001).read_to_end(&mut bytes).ok()?;
        (bytes.len() <= 600_000).then_some(bytes)
    });
    let start = Instant::now();
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if start.elapsed() < Duration::from_secs(3) => thread::sleep(Duration::from_millis(15)),
            _ => { let _ = child.kill(); let _ = child.wait(); break false; }
        }
    };
    let bytes = reader.join().ok()??;
    if !success { return None; }
    serde_json::from_slice(&bytes).ok()
}

pub fn snapshot() -> Value {
    ICONS.get_or_init(|| {
        let value = std::env::current_exe().ok()
            .and_then(|exe| exe.parent().map(|parent| parent.join("flowhub-device-icons")))
            .and_then(|path| read_helper(&path));
        sanitize(value.unwrap_or_else(|| json!({})))
    }).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_bounded_system_pngs_are_returned() {
        let output = sanitize(json!({
            "iphone":{"dataUrl":"data:image/png;base64,iVBORw0KGgoAAA=","typeIdentifier":"com.apple.iphone"},
            "airpods":{"dataUrl":"https://example.test/photo.png","typeIdentifier":"com.apple.airpods"},
            "apple-mouse":{"dataUrl":"data:image/svg+xml,<svg/>","typeIdentifier":"com.apple.mouse"},
            "unknown":{"dataUrl":"data:image/png;base64,iVBORw0KGgoAAA=","typeIdentifier":"com.apple.iphone"}
        }));
        assert_eq!(output["icons"].as_object().unwrap().len(), 1);
        assert_eq!(output["icons"]["iphone"]["source"], "macos");
    }

    #[test]
    fn missing_or_invalid_provider_is_non_fatal() {
        assert_eq!(sanitize(Value::Null)["available"], false);
        assert!(read_helper(Path::new("/nonexistent-flowhub-device-icon-provider")).is_none());
        assert_eq!(sanitize(json!({"iphone":{"dataUrl":format!("data:image/png;base64,iVBORw0KGgo{}", "A".repeat(90_000)),"typeIdentifier":"com.apple.iphone"}}))["available"],false);
    }
}
