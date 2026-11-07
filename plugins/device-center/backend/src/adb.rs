use super::{device, now, short, stable_id, Device};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::BTreeSet, path::PathBuf, time::Duration};

#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Info {
    pub serial: String,
    pub state: String,
    pub transport: String,
    pub model: Option<String>,
    pub product: Option<String>,
    pub transport_id: Option<String>,
}

#[derive(Default)]
pub(crate) struct Report {
    pub devices: Vec<Device>,
    pub available: bool,
    pub at: u64,
    pub checked_at: u64,
    pub error: Option<String>,
}

pub(crate) enum Error { Missing, Query(String) }

impl Report {
    pub fn apply(&mut self, result: Result<Vec<Device>, Error>) {
        self.checked_at = now();
        match result {
            Ok(devices) => { self.devices = devices; self.at = self.checked_at; self.available = true; self.error = None; }
            Err(Error::Missing) => { self.available = false; self.error = Some("未找到 ADB，请安装 Android SDK Platform-Tools 后重试。".into()); }
            Err(Error::Query(error)) => { self.available = true; self.error = Some(error); }
        }
    }
    pub fn stale(&self) -> bool { self.at == 0 || self.error.is_some() || now().saturating_sub(self.at) > 30_000 }
    pub fn value(&self) -> Value {
        json!({"available":self.available,"at":self.at,"checkedAt":self.checked_at,
            "error":self.error,"stale":self.stale(),"intervalSeconds":10})
    }
}

fn executable(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    candidates.into_iter().find(|path| path.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

fn find() -> Option<PathBuf> {
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).filter(|p| p.is_absolute()).map(|p| p.join("adb")).collect()).unwrap_or_default();
    for key in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Some(root) = std::env::var_os(key) { paths.push(PathBuf::from(root).join("platform-tools/adb")); }
    }
    if let Some(home) = std::env::var_os("HOME") { paths.push(PathBuf::from(home).join("Library/Android/sdk/platform-tools/adb")); }
    paths.extend([PathBuf::from("/opt/homebrew/bin/adb"), PathBuf::from("/usr/local/bin/adb")]);
    executable(paths)
}

pub(crate) fn read() -> Result<Vec<Device>, Error> {
    let program = find().ok_or(Error::Missing)?;
    read_program(&program, Duration::from_secs(5))
}
fn read_program(program: &std::path::Path, timeout: Duration) -> Result<Vec<Device>, Error> {
    // Fixed listing only. Never reconnect devices, stop the server or run a device shell.
    let output = super::read_system_query(program.to_str().ok_or_else(|| Error::Query("ADB 路径无效".into()))?,
        &["devices", "-l"], timeout, 128 * 1024)
        .map_err(|e| Error::Query(if e.contains("超时") { "ADB 读取超时，请检查本机 ADB 服务后重试。".into() }
            else { "ADB 读取失败，请确认本机可执行 adb devices -l 后重试。".into() }))?;
    parse(std::str::from_utf8(&output).map_err(|_| Error::Query("ADB 返回的设备列表编码无效".into()))?).map_err(Error::Query)
}

fn parse(text: &str) -> Result<Vec<Device>, String> {
    let mut header = false;
    let mut devices = Vec::new();
    let mut seen = BTreeSet::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line == "List of devices attached" { header = true; continue; }
        if line.starts_with("* daemon ") { continue; }
        if !header { return Err("ADB 返回的设备列表格式无效".into()); }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 2 || fields[0].len() > 512 || devices.len() >= 256 {
            return Err("ADB 返回的设备列表格式无效或设备过多".into());
        }
        let serial = fields[0];
        if !seen.insert(serial) { continue; }
        let state = if fields[1] == "no" && fields.get(2) == Some(&"permissions") { "no permissions" } else { fields[1] };
        let attribute = |name: &str| fields[2..].iter().find_map(|field| field.strip_prefix(name)).map(|s| short(s, 150));
        let model = attribute("model:").map(|s| s.replace('_', " "));
        let transport = if serial.starts_with("emulator-") { "emulator" }
            else if attribute("usb:").is_some() { "usb" }
            else if serial.contains(':') { "tcp" }
            else if serial.contains("_adb-tls-") { "wireless" }
            else { "unknown" };
        let name = model.clone().unwrap_or_else(|| serial.to_owned());
        let mut item = device("adb", name, serial.into(), serial.into(), None, None, None);
        // Authorization can reveal a model later; identity must stay bound to the serial.
        item.id = stable_id("adb", "", serial);
        item.kind = "phone".into();
        item.status = if state == "device" { "connected" } else { state }.into();
        item.adb = Some(Info { serial:serial.into(), state:short(state, 80), transport:transport.into(), model,
            product:attribute("product:"), transport_id:attribute("transport_id:") });
        devices.push(item);
    }
    if !header { return Err("ADB 返回的设备列表格式无效".into()); }
    Ok(devices)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lists_usb_wireless_emulators_and_unavailable_states_without_hiding_them() {
        let result = parse("List of devices attached\r\nUSB1 device usb:1-2 product:husky model:Pixel_8_Pro device:husky transport_id:1\r\nUSB2 unauthorized usb:1-3 transport_id:2\n192.0.2.1:5555 offline transport_id:3\nemulator-5554 device model:sdk_phone\nadb-public._adb-tls-connect._tcp device model:Android_phone\nDENIED no permissions (user is not in the plugdev group)\nREC recovery\n").unwrap();
        assert_eq!(result.len(), 7);
        assert_eq!(result[0].name, "Pixel 8 Pro"); assert_eq!(result[0].adb.as_ref().unwrap().transport, "usb");
        assert_eq!(result[1].status, "unauthorized"); assert_eq!(result[2].status, "offline");
        assert_eq!(result[2].adb.as_ref().unwrap().transport, "tcp");
        assert_eq!(result[3].adb.as_ref().unwrap().transport, "emulator");
        assert_eq!(result[4].adb.as_ref().unwrap().transport, "wireless");
        assert_eq!(result[5].status, "no permissions"); assert_eq!(result[6].status, "recovery");
    }
    #[test]
    fn serial_identity_survives_authorization_and_lists_do_not_duplicate_it() {
        let before = parse("List of devices attached\nTEST unauthorized\n").unwrap();
        let after = parse("List of devices attached\nTEST device model:Phone\nTEST device model:Phone\n").unwrap();
        assert_eq!(before[0].id, after[0].id); assert_eq!(after.len(), 1);
    }
    #[test]
    fn tcp_forwarding_does_not_claim_a_wireless_radio_connection() {
        let devices=parse("List of devices attached\n127.0.0.1:17352 device model:Public_phone\n[2001:db8::1]:5555 offline\n").unwrap();
        assert!(devices.iter().all(|d|d.adb.as_ref().unwrap().transport=="tcp"));
    }
    #[test]
    fn empty_success_is_distinct_from_missing_or_malformed_output() {
        assert!(parse("List of devices attached\n\n").unwrap().is_empty());
        for invalid in ["", "adb: server error", "List of devices attached\nbroken"] { assert!(parse(invalid).is_err()); }
        let mut report = Report::default(); report.apply(Ok(parse("List of devices attached\nTEST device\n").unwrap()));
        report.apply(Err(Error::Missing)); assert!(!report.available); assert!(report.stale()); assert_eq!(report.devices.len(), 1);
        report.apply(Ok(vec![])); assert!(report.available); assert!(!report.stale()); assert!(report.devices.is_empty());
    }
    #[test]
    fn lookup_skips_nonexecutables_and_supports_paths_with_spaces() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("flowhub-adb-path-{}-{}", std::process::id(), now()));
        std::fs::create_dir_all(root.join("SDK with spaces")).unwrap();
        let bad = root.join("bad");
        let good = root.join("SDK with spaces/adb");
        std::fs::write(&bad, "").unwrap(); std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::write(&good, "").unwrap(); std::fs::set_permissions(&good, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(executable([bad, good.clone()]), Some(good)); std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn command_uses_only_listing_arguments_and_bounds_failed_queries() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("flowhub-adb-query-{}-{}", std::process::id(), now()));
        std::fs::create_dir_all(&root).unwrap(); let file=root.join("fake adb");
        std::fs::write(&file, "#!/bin/sh\n[ \"$#\" -eq 2 ] && [ \"$1\" = devices ] && [ \"$2\" = -l ] || exit 7\nprintf 'List of devices attached\\nTEST device model:Public_phone\\n'\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(read_program(&file,Duration::from_secs(1)).ok().unwrap()[0].name,"Public phone");
        std::fs::write(&file,"#!/bin/sh\nexit 1\n").unwrap(); assert!(read_program(&file,Duration::from_secs(1)).is_err());
        std::fs::write(&file,"#!/bin/sh\nexec sleep 10\n").unwrap();let started=std::time::Instant::now();
        assert!(matches!(read_program(&file,Duration::from_millis(20)),Err(Error::Query(message)) if message.contains("超时")));
        assert!(started.elapsed()<Duration::from_secs(1));std::fs::remove_dir_all(root).unwrap();
    }
}
