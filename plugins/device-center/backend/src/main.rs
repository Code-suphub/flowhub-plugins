use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
mod power_telemetry;
mod power_source;
mod smc_power;
mod device_images;
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    io::{BufRead, Read, Write},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_BYTES: u64 = 2 * 1024 * 1024;
const SCAN_INTERVAL: Duration = Duration::from_secs(45);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: String,
    name: String,
    category: String,
    kind: String,
    detail: String,
    status: String,
    battery: Option<String>,
    vendor: Option<String>,
    product_id: Option<String>,
    #[serde(skip_serializing_if="Option::is_none")]
    display_connection: Option<String>,
    #[serde(skip_serializing_if="Option::is_none")]
    pixel_resolution: Option<String>,
    #[serde(skip_serializing_if="Option::is_none")]
    logical_resolution: Option<String>,
    #[serde(skip_serializing_if="Option::is_none")]
    refresh_rate: Option<String>,
    #[serde(skip)]
    native_display_id: Option<u32>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    at: u64,
    name: String,
    category: String,
    action: String,
}
#[derive(Clone)]
struct Scan {
    devices: Vec<Device>,
    power: Value,
}
struct State {
    scan: Scan,
    at: u64,
    error: Option<String>,
    events: VecDeque<Event>,
    power_sample: Option<Value>,
    power_checked_at: u64,
}
fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}
fn short(s: &str, max: usize) -> String {
    s.trim().chars().filter(|ch| !ch.is_control()).take(max).collect()
}
fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.trim().is_empty() => Some(short(s, 110)),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(if *b {"Yes"} else {"No"}.into()),
        _ => None,
    }
}
fn field(value: &Value, names: &[&str]) -> Option<String> {
    for name in names {
        if let Some(s) = value.get(*name).and_then(value_text) { return Some(s); }
    }
    None
}
fn flag(s: &str) -> bool {
    matches!(s.trim().to_ascii_lowercase().as_str(), "yes" | "true" | "1" | "connected")
}
fn kind_for(name: &str) -> String {
    let n = name.to_lowercase();
    if ["airpods", "headphone", "headset", "earphone", "earbuds", "buds", "耳机", "耳麦"].iter().any(|x| n.contains(x)) { "headphones" }
    else if ["mouse", "鼠标", "trackpad"].iter().any(|x| n.contains(x)) { "mouse" }
    else if ["keyboard", "keychron", "键盘"].iter().any(|x| n.contains(x)) { "keyboard" }
    else if ["iphone", "pixel", "android", "phone", "手机"].iter().any(|x| n.contains(x)) { "phone" }
    else if ["ssd", "disk", "storage", "flash", "硬盘"].iter().any(|x| n.contains(x)) { "drive" }
    else if ["hub", "reader", "读卡"].iter().any(|x| n.contains(x)) { "hub" }
    else { "device" }.into()
}
fn stable_id(category: &str, name: &str, discriminant: &str) -> String {
    // Non-reversible display identity: never include USB serials, BT addresses or ADB IDs.
    let mut hash = 0xcbf29ce484222325_u64;
    for b in format!("{category}|{name}|{discriminant}").bytes() {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{category}-{hash:016x}")
}
fn device(category: &str, name: String, detail: String, discriminant: String,
    battery: Option<String>, vendor: Option<String>, product_id: Option<String>) -> Device {
    let kind = if category == "display" { "monitor".into() } else { kind_for(&format!("{name} {detail}")) };
    Device { id: stable_id(category, &name, &discriminant), name: short(&name, 92),
        category: category.into(), kind, detail: short(&detail, 150), status: "connected".into(),
        battery, vendor, product_id, display_connection:None, pixel_resolution:None,
        logical_resolution:None, refresh_rate:None, native_display_id:None }
}
// USB entries may be beneath _items, a host_controller object, or other nested
// containers depending on macOS version. Walk object containers but only emit nodes
// that carry a USB hardware ID. Do not return serial numbers or volume metadata.
fn usb(node: &Value, parent: &str, out: &mut Vec<Device>, depth: usize) {
    if depth > 16 || out.len() >= 128 { return; }
    match node {
        Value::Array(arr) => for value in arr { usb(value, parent, out, depth + 1); },
        Value::Object(obj) => {
            let vendor_id = field(node, &["vendor_id", "vendorID"]);
            let product_id = field(node, &["product_id", "productID"]);
            let has_hardware_id = vendor_id.is_some() || product_id.is_some();
            let name = field(node, &["_name", "name", "product_name", "device_name"])
                .or_else(|| (has_hardware_id && !parent.is_empty()).then(|| short(parent, 92)));
            if let Some(name) = name {
                let lower = name.trim().to_ascii_lowercase();
                // USB buses and controller wrappers are not attached peripherals.
                let controller = lower.ends_with("bus") || lower.ends_with("controller");
                if has_hardware_id && !controller {
                    let speed = field(node, &["device_speed", "speed"]).unwrap_or_default();
                    let brand = field(node, &["manufacturer"]).unwrap_or_default();
                    let detail = [brand.as_str(), speed.as_str()].iter()
                        .filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(" · ");
                    let port = field(node, &["location_id", "locationID"]).unwrap_or_default();
                    let key = format!("{}:{}:{}", vendor_id.as_deref().unwrap_or(""),
                        product_id.as_deref().unwrap_or(""), port);
                    out.push(device("usb", name, detail, key, None, vendor_id, product_id));
                }
            }
            for (key, value) in obj {
                if !value.is_array() && !value.is_object() { continue; }
                // Storage/volume metadata is not a child USB device tree.
                if matches!(key.as_str(), "Media" | "media" | "Volumes" | "volumes") { continue; }
                let next_parent = if matches!(key.as_str(),
                    "_items" | "items" | "host_controller" | "device" | "devices" |
                    "usb_devices" | "children" | "ports") { "" } else { key.as_str() };
                usb(value, next_parent, out, depth + 1);
            }
        },
        _ => {}
    }
}

fn battery_percent(node: &Value) -> Option<String> {
    let raw = field(node, &[
        "device_batteryLevelMain", "device_batteryLevel",
        "device_batteryLevelSingle", "battery_level"
    ])?;
    let percent = raw.trim().trim_end_matches('%').trim().parse::<u8>().ok()?;
    (percent <= 100).then(|| format!("{percent}%"))
}

// pmset includes accessory power sources omitted from system_profiler (e.g.
// third-party headsets). Only supplement uniquely named, connected Bluetooth
// devices; never expose the system power-source IDs or create devices from it.
fn supplement_accessory_batteries(devices: &mut [Device], report: &str) {
    let mut levels: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for line in report.lines() {
        let Some(line) = line.trim().strip_prefix('-') else { continue; };
        let Some((heading, values)) = line.split_once('\t') else { continue; };
        let name = heading.rsplit_once(" (id=").map_or(heading, |(name, _)| name).trim();
        if name.is_empty() || name.starts_with("InternalBattery-")
            || values.contains("present: false") { continue; }
        let Some(percent) = values.split(';').next().and_then(|v| v.trim().strip_suffix('%'))
            .and_then(|v| v.parse::<u8>().ok()).filter(|v| *v <= 100) else { continue; };
        levels.entry(name.to_lowercase()).or_default().push(percent);
    }
    let mut names = BTreeMap::<String, usize>::new();
    for d in devices.iter().filter(|d| d.category == "bluetooth" && d.status == "connected") {
        *names.entry(d.name.to_lowercase()).or_default() += 1;
    }
    for d in devices.iter_mut().filter(|d| d.category == "bluetooth"
        && d.status == "connected" && d.battery.is_none()) {
        let key = d.name.to_lowercase();
        if names.get(&key) != Some(&1) { continue; }
        if let Some(values) = levels.get(&key).filter(|v| v.len() == 1) {
            d.battery = Some(format!("{}%", values[0]));
        }
    }
}

// The current macOS system_profiler format uses a connected-device collection:
// "device_connected": [ {"AirPods": {"device_minorType": "...", ...}} ].
// Legacy reports can instead use "devices" with an explicit scalar connected flag.
// Never traverse device_not_connected, even if it contains stale battery metadata.
fn bluetooth(node: &Value, parent: &str, in_connected_list: bool,
    out: &mut Vec<Device>, depth: usize) {
    if depth > 16 || out.len() >= 128 { return; }
    match node {
        Value::Array(arr) => for value in arr {
            bluetooth(value, parent, in_connected_list, out, depth + 1);
        },
        Value::Object(obj) => {
            let explicit = field(node, &["device_connected", "device_is_connected", "connected"])
                .map(|s| flag(&s));
            let name = field(node, &["device_name", "_name", "name"])
                .or_else(|| (!parent.is_empty()).then(|| short(parent, 92)));
            if (in_connected_list || explicit == Some(true)) && explicit != Some(false) {
                if let Some(name) = name {
                    if !name.is_empty() {
                        let model = field(node, &["device_minorType", "device_type"])
                            .unwrap_or_default();
                        out.push(device("bluetooth", name, model,
                            String::new(), battery_percent(node), None, None));
                    }
                }
            }
            for (key, value) in obj {
                if key == "device_not_connected" || key == "controller_properties" { continue; }
                if !value.is_object() && !value.is_array() { continue; }
                // A collection name is not a device name.
                let next_parent = if matches!(key.as_str(),
                    "device_connected" | "devices" | "_items" | "items") { "" }
                    else { key.as_str() };
                bluetooth(value, next_parent,
                    in_connected_list || key == "device_connected", out, depth + 1);
            }
        },
        _ => {}
    }
}

fn resolution_size(value: &str) -> String {
    short(value.split('@').next().unwrap_or(value),80).replace(" x "," × ")
}
fn display_connection(node: &Value) -> Option<String> {
    let connection = field(node,&["spdisplays_connection_type"]).unwrap_or_default().to_lowercase();
    let kind = field(node,&["spdisplays_display_type"]).unwrap_or_default().to_lowercase();
    if connection == "spdisplays_internal" || kind.contains("built-in") { Some("built-in".into()) }
    else if ["spdisplays_external","spdisplays_hdmi","spdisplays_displayport","spdisplays_thunderbolt"].contains(&connection.as_str()) { Some("external".into()) }
    else { None }
}
#[cfg(target_os="macos")]
#[link(name="CoreGraphics",kind="framework")]
extern "C" {
    fn CGDisplayIsBuiltin(display:u32)->u32;
    fn CGDisplayIsOnline(display:u32)->u32;
}
fn supplement_display_connections(devices:&mut [Device]) {
    #[cfg(target_os="macos")]
    for d in devices.iter_mut().filter(|d|d.category=="display" && d.display_connection.is_none()) {
        if let Some(id)=d.native_display_id {
            if unsafe{CGDisplayIsOnline(id)}!=0 {
                d.display_connection=Some(if unsafe{CGDisplayIsBuiltin(id)}!=0 {"built-in"}else{"external"}.into());
            }
        }
    }
    #[cfg(not(target_os="macos"))]
    let _=devices;
}
fn displays(node: &Value, out: &mut Vec<Device>, depth: usize) {
    if depth > 12 || out.len() >= 32 { return; }
    match node {
        Value::Array(arr) => for v in arr { displays(v, out, depth + 1); },
        Value::Object(obj) => {
            if field(node, &["_spdisplays_pixels","spdisplays_resolution", "spdisplays_pixels", "_spdisplays_resolution"]).is_some() {
                let name = field(node, &["_name", "display_name"]).unwrap_or("显示器".into());
                let mode = field(node,&["_spdisplays_resolution","spdisplays_resolution"]);
                let pixels = field(node,&["_spdisplays_pixels","spdisplays_pixels"]).map(|s|resolution_size(&s));
                let logical = mode.as_deref().map(resolution_size);
                let refresh = field(node,&["spdisplays_refresh_rate"]).or_else(||mode.as_deref().and_then(|s|s.split_once('@').map(|(_,r)|r.trim().to_string())));
                let size = pixels.clone().or_else(||logical.as_ref().map(|s|format!("显示模式 {s}"))).unwrap_or_default();
                let detail = [Some(size), refresh.clone()].iter().filter_map(|s|s.as_deref()).filter(|s|!s.is_empty())
                    .collect::<Vec<_>>().join(" · ");
                let display_id = field(node, &["_spdisplays_displayID","spdisplays_display_id", "spdisplays_uuid"]).unwrap_or_default();
                let mut d=device("display", name, detail, display_id.clone(), None, None, None);
                d.display_connection=display_connection(node);
                d.pixel_resolution=pixels;d.logical_resolution=logical;d.refresh_rate=refresh;
                d.native_display_id=display_id.parse().ok();out.push(d);
            }
            for value in obj.values() {
                if value.is_object() || value.is_array() { displays(value, out, depth + 1); }
            }
        },
        _ => {}
    }
}
fn find_key<'a>(node: &'a Value, key: &str, depth: usize) -> Option<&'a Value> {
    if depth > 14 { return None; }
    match node {
        Value::Object(obj) => {
            if let Some(v) = obj.get(key) { return Some(v); }
            obj.values().find_map(|v| find_key(v, key, depth + 1))
        },
        Value::Array(arr) => arr.iter().find_map(|v| find_key(v, key, depth + 1)),
        _ => None
    }
}
fn power(node: &Value) -> Value {
    let watts = find_key(node, "sppower_ac_charger_watts", 0).and_then(value_text);
    let plugged = find_key(node, "sppower_battery_power_source", 0).and_then(value_text);
    let charging = find_key(node, "sppower_battery_is_charging", 0).and_then(value_text)
        .or_else(|| find_key(node, "sppower_battery_charging", 0).and_then(value_text));
    json!({
        "adapterWatts": watts,
        "source": plugged,
        "charging": charging.as_deref().map(flag),
        "batterySideWatts": null,
        "cableLimitWatts": null,
        "note": "充电器功率是系统报告的规格值，非实时输入功率；电池侧及线缆功率未测量"
    })
}
fn parse(raw: &Value) -> Scan {
    let mut devices = vec![];
    usb(&raw["SPUSBDataType"], "", &mut devices, 0);
    bluetooth(&raw["SPBluetoothDataType"], "", false, &mut devices, 0);
    displays(&raw["SPDisplaysDataType"], &mut devices, 0);
    let mut seen = BTreeSet::new();
    devices.retain(|d| seen.insert(d.id.clone()));
    devices.sort_by(|a, b| a.category.cmp(&b.category).then(a.name.cmp(&b.name)));
    Scan { devices, power: power(&raw["SPPowerDataType"]) }
}
fn read_system_query(program: &str, args: &[&str], timeout: Duration, max_bytes: u64) -> Result<Vec<u8>, String> {
    let mut child = Command::new(program)
        .args(args).env("LC_ALL", "C")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|_| "无法启动 macOS 系统设备查询".to_string())?;
    let reader = child.stdout.take().ok_or("读取系统设备信息失败")?;
    let handle = thread::spawn(move || {
        let mut data = Vec::new();
        let _ = reader.take(max_bytes + 1).read_to_end(&mut data);
        data
    });
    let start = Instant::now();
    let exit = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if start.elapsed() < timeout => thread::sleep(Duration::from_millis(60)),
            Ok(None) => { let _ = child.kill(); let _ = child.wait(); break Err("设备扫描超时，请重试".to_string()); },
            Err(_) => { let _ = child.kill(); let _ = child.wait(); break Err("设备扫描进程异常".to_string()); }
        }
    };
    let output = handle.join().map_err(|_| "读取系统设备信息失败")?;
    let status = exit?;
    if !status.success() { return Err("macOS 设备扫描失败或权限受限".into()); }
    if output.len() as u64 > max_bytes { return Err("设备信息过大，已安全中止读取".into()); }
    Ok(output)
}
fn profile() -> Result<Scan, String> {
    if !cfg!(target_os = "macos") { return Err("仅支持 macOS 原生设备检测".into()); }
    let output = read_system_query("/usr/sbin/system_profiler",
        &["-json", "SPBluetoothDataType", "SPUSBDataType", "SPDisplaysDataType", "SPPowerDataType"],
        Duration::from_secs(30), MAX_BYTES)?;
    let raw: Value = serde_json::from_slice(&output).map_err(|_| "系统设备信息格式不支持".to_string())?;
    let mut scan = parse(&raw);
    supplement_display_connections(&mut scan.devices);
    if scan.devices.iter().any(|d| d.category == "bluetooth" && d.battery.is_none()) {
        if let Ok(output) = read_system_query("/usr/bin/pmset", &["-g", "accps"], Duration::from_secs(3), 65_536) {
            if let Ok(report) = std::str::from_utf8(&output) {
                supplement_accessory_batteries(&mut scan.devices, report);
            }
        }
    }
    Ok(scan)
}
impl State {
    fn new() -> Self {
        Self { scan: Scan { devices: vec![], power: power(&Value::Null) },
            at: 0, error: None, events: VecDeque::new(), power_sample: None, power_checked_at: 0 }
    }
    fn apply(&mut self, result: Result<Scan, String>) {
        match result {
            Err(err) => self.error = Some(err),
            Ok(new) => {
                let time = now();
                if self.at != 0 {
                    let before: BTreeMap<&str, &Device> = self.scan.devices.iter().map(|d| (d.id.as_str(), d)).collect();
                    let after: BTreeMap<&str, &Device> = new.devices.iter().map(|d| (d.id.as_str(), d)).collect();
                    for d in &new.devices {
                        if !before.contains_key(d.id.as_str()) { self.events.push_front(Event { at: time, name: d.name.clone(), category: d.category.clone(), action: "connected".into() }); }
                    }
                    for d in &self.scan.devices {
                        if !after.contains_key(d.id.as_str()) { self.events.push_front(Event { at: time, name: d.name.clone(), category: d.category.clone(), action: "disconnected".into() }); }
                    }
                    self.events.truncate(60);
                }
                self.scan = new;
                self.at = time;
                self.error = None;
            }
        }
    }
    fn stale(&self) -> bool { self.at == 0 || now().saturating_sub(self.at) > 120_000 || self.error.is_some() }
    fn full(&self) -> Value {
        let mut power = self.scan.power.clone();
        if let Some(sample) = self.power_sample.as_ref().and_then(Value::as_object) {
            for (key, value) in sample { power[key] = value.clone(); }
        }
        json!({"at":self.at, "stale":self.stale(), "devices":self.scan.devices,
            "power":power, "events":self.events, "error":self.error,
            "intervalSeconds":45,"powerIntervalSeconds":5})
    }
    fn status(&self) -> Value {
        let rows: Vec<_> = self.scan.devices.iter().take(40).map(|d| {
            json!({"id":d.id,"name":d.name,"category":d.category,"kind":d.kind,"battery":d.battery,
                "status":if self.stale() {"stale"} else {"healthy"},
                "summary":format!("{} · {}", category_label(&d.category), if d.detail.is_empty() {"已连接"} else {&d.detail})})
        }).collect();
        json!({"title":"外设中心","monitoring":true,"at":self.at,"rows":rows,
            "counts":{"bluetooth":self.scan.devices.iter().filter(|d| d.category=="bluetooth").count(),
                      "usb":self.scan.devices.iter().filter(|d| d.category=="usb").count(),
                      "display":self.scan.devices.iter().filter(|d| d.category=="display").count()},
            "error":self.error,"stale":self.stale(),"count":self.scan.devices.len()})
    }
}
fn category_label(category: &str) -> &str {
    match category { "usb" => "USB", "bluetooth" => "蓝牙", "display" => "显示器", _ => "设备" }
}
fn power_interval_seconds(params: &Value) -> u64 {
    params["powerIntervalSeconds"].as_u64().filter(|v| [5,10,30,60].contains(v)).unwrap_or(5)
}
fn update_power_sample(state: &Arc<Mutex<State>>, force: bool, interval_seconds: u64) {
    let due = state.lock().map(|s| now().saturating_sub(s.power_checked_at) >= interval_seconds * 1_000).unwrap_or(false);
    if !force && !due { return; }
    let mut sample = power_telemetry::read().unwrap_or_else(|error| json!({
        "inputWatts":null,"systemWatts":null,"batterySideWatts":null,"sampledAt":null,
        "telemetryError":error,"externalConnected":null,"source":null,"charging":null,
        "note":"当前功率读取失败，适配器规格不代表实时输入功率。"
    }));
    power_source::apply(&mut sample, power_source::read());
    smc_power::fill_missing(&mut sample);
    if let Ok(mut s) = state.lock() { s.power_sample = Some(sample); s.power_checked_at = now(); }
}
fn dispatch(state: &Arc<Mutex<State>>, images: &Arc<Mutex<device_images::ImageStore>>, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "health" => Ok(json!({"protocol":2,"name":"device-center"})),
        "image_list" => {
            let devices=state.lock().map_err(|_|"设备状态不可用")?.scan.devices.clone();
            let store=images.lock().map_err(|_|"图片缓存不可用")?;
            Ok(store.list(&devices))
        },
        "image_get" | "image_search" | "image_choose" | "image_remove" => {
            let id=params["deviceId"].as_str().filter(|v|v.len()<=100)
                .ok_or("缺少已连接设备 ID")?;
            let device={
                let snapshot=state.lock().map_err(|_|"设备状态不可用")?;
                if method=="image_search" && snapshot.stale() {
                    return Err("设备扫描尚未完成，请先刷新后再搜索图片".into());
                }
                snapshot.scan.devices.iter().find(|d|d.id==id).cloned()
                    .ok_or("当前未检测到该设备，请刷新设备列表")?
            };
            let mut store=images.lock().map_err(|_|"图片缓存不可用")?;
            match method {
                "image_get" => store.get(&device),
                "image_search" => store.search(&device),
                "image_choose" => {
                    let candidate=params["candidateId"].as_str().filter(|s|s.len()==16)
                        .ok_or("未选择有效候选图片")?;
                    store.choose(&device,candidate)
                },
                "image_remove" => store.remove(&device),
                _ => unreachable!()
            }
        },
        "status_snapshot" => state.lock().map_err(|_| "状态缓存不可用".to_string()).map(|s| s.status()),
        "snapshot" => {
            update_power_sample(state, false, power_interval_seconds(params));
            state.lock().map_err(|_| "状态缓存不可用".to_string()).map(|s| {
                let mut snapshot = s.full();
                snapshot["powerIntervalSeconds"] = json!(power_interval_seconds(params)); snapshot
            })
        },
        "refresh" => {
            let scan = profile();
            state.lock().map_err(|_| "状态缓存不可用")?.apply(scan);
            update_power_sample(state, true, power_interval_seconds(params));
            let s = state.lock().map_err(|_| "状态缓存不可用")?;
            if let Some(e) = &s.error { Err(e.clone()) } else {
                let mut snapshot = s.full();
                snapshot["powerIntervalSeconds"] = json!(power_interval_seconds(params)); Ok(snapshot)
            }
        },
        "widget_api" => match params["action"].as_str() {
            Some("snapshot") => state.lock().map_err(|_| "状态缓存不可用".to_string()).map(|s| s.status()),
            Some("management") => match params["method"].as_str() {
                Some("snapshot") => dispatch(state, images, "snapshot", &params["params"]),
                Some("refresh") => dispatch(state, images, "refresh", &params["params"]),
                Some(method @ ("image_list" | "image_get" | "image_search" | "image_choose" | "image_remove")) =>
                    dispatch(state, images, method, &params["params"]),
                _ => Err("不支持的组件操作".into()),
            },
            _ => Err("不支持的组件操作".into())
        },
        _ => Err("未知插件方法".into())
    }
}
fn main() {
    let state = Arc::new(Mutex::new(State::new()));
    let images = Arc::new(Mutex::new(device_images::ImageStore::new()));
    let worker = Arc::clone(&state);
    thread::spawn(move || {
        loop {
            let scan = profile();
            if let Ok(mut s) = worker.lock() { s.apply(scan); }
            thread::sleep(SCAN_INTERVAL);
        }
    });
    let input = std::io::stdin();
    let mut lines = input.lock();
    let mut output = std::io::stdout().lock();
    loop {
        let mut line = String::new();
        match (&mut lines).take(65_537).read_line(&mut line) {
            Ok(0) | Err(_) => break,
            _ => {}
        }
        if line.len() > 65_536 { break; }
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue; };
        let result = dispatch(&state, &images, req["method"].as_str().unwrap_or(""), &req["params"]);
        let message = match result {
            Ok(v) => json!({"id":req["id"],"result":v}),
            Err(e) => json!({"id":req["id"],"error":e})
        };
        if writeln!(output, "{message}").and_then(|_| output.flush()).is_err() { break; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retina_display_keeps_pixels_logical_size_and_connection_separate() {
        let sample=json!({"SPDisplaysDataType":[{"spdisplays_ndrvs":[{
            "_name":"Color LCD","_spdisplays_pixels":"3024 x 1964",
            "_spdisplays_resolution":"1512 x 982 @ 120.00Hz",
            "spdisplays_connection_type":"spdisplays_internal"
        },{
            "_name":"DELL","_spdisplays_pixels":"1920 x 1080",
            "spdisplays_resolution":"1920 x 1080 @ 60.00Hz",
            "spdisplays_connection_type":"spdisplays_displayport"
        }]}]});
        let devices=parse(&sample).devices;
        let internal=devices.iter().find(|d|d.name=="Color LCD").unwrap();
        assert_eq!(internal.pixel_resolution.as_deref(),Some("3024 × 1964"));
        assert_eq!(internal.logical_resolution.as_deref(),Some("1512 × 982"));
        assert_eq!(internal.display_connection.as_deref(),Some("built-in"));
        assert!(internal.detail.starts_with("3024 × 1964"));
        assert!(!internal.detail.contains("1512"));
        let external=devices.iter().find(|d|d.name=="DELL").unwrap();
        assert_eq!(external.display_connection.as_deref(),Some("external"));
        assert_eq!(external.refresh_rate.as_deref(),Some("60.00Hz"));
    }
    #[test]
    fn unknown_display_type_and_pixel_size_are_not_inferred_from_name_or_mode() {
        let devices=parse(&json!({"SPDisplaysDataType":[{"spdisplays_ndrvs":[{
            "_name":"Color LCD","_spdisplays_resolution":"1512 x 982 @ 120Hz"
        }]}]})).devices;
        assert!(devices[0].display_connection.is_none());
        assert!(devices[0].pixel_resolution.is_none());
        assert!(devices[0].detail.starts_with("显示模式"));
    }
    #[test]
    fn power_interval_validates_configured_sampling_options() {
        for interval in [5,10,30,60] { assert_eq!(power_interval_seconds(&json!({"powerIntervalSeconds":interval})),interval); }
        for bad in [json!(0),json!(1),json!(-5),json!(99999),json!("10"),Value::Null] {
            assert_eq!(power_interval_seconds(&json!({"powerIntervalSeconds":bad})),5);
        }
    }
    #[test]
    fn collects_nested_usb_without_identifying_serials() {
        let sample = json!({"SPUSBDataType":[{"_name":"USB 3.0 Bus","_items":[
            {"_name":"Samsung T7 SSD","vendor_id":"0x04e8","product_id":"0x4001",
             "serial_num":"PRIVATE_SERIAL","speed":"Up to 10 Gb/s","location_id":"0x11000000"},
            {"_name":"USB 2.0 Bus","_items":[{"_name":"USB Mouse","vendor_id":"0x1234"}]}
        ]}]});
        let result = parse(&sample);
        assert_eq!(result.devices.len(), 2);
        assert!(result.devices.iter().any(|d| d.name == "Samsung T7 SSD"));
        assert!(!serde_json::to_string(&result.devices).unwrap().contains("PRIVATE_SERIAL"));
    }
    #[test]
    fn collects_only_connected_bluetooth() {
        let sample = json!({"SPBluetoothDataType":[{"devices":{"AirPods Pro 2":{
            "device_connected":"Yes","device_batteryLevelMain":"82"},
            "Disconnected Mouse":{"device_connected":"No"}}}]});
        let result = parse(&sample);
        assert_eq!(result.devices.len(), 1);
        assert_eq!(result.devices[0].battery.as_deref(), Some("82%"));
        assert_eq!(result.devices[0].name, "AirPods Pro 2");
    }
    #[test]
    fn macos_connected_array_reads_names_and_excludes_disconnected_devices() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/macos-bluetooth-connected.json"
        )).unwrap();
        let devices = parse(&fixture).devices;
        let bluetooth: Vec<_> = devices.iter().filter(|d| d.category == "bluetooth").collect();
        assert_eq!(bluetooth.len(), 3);
        assert!(bluetooth.iter().any(|d| d.name == "AirPods Pro 2"
            && d.battery.as_deref() == Some("82%")));
        assert!(bluetooth.iter().any(|d| d.name == "Magic Mouse"
            && d.battery.as_deref() == Some("67%")));
        assert!(bluetooth.iter().any(|d| d.name == "Keychron K3"
            && d.battery.is_none()));
        assert!(!bluetooth.iter().any(|d| d.name.contains("Disconnected")));
        let output = serde_json::to_string(&bluetooth).unwrap();
        assert!(!output.contains("AA-BB-CC"));
        assert!(!output.contains("device_address"));
    }
    #[test]
    fn macos_usb_host_controller_tree_and_empty_buses() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/macos-usb-host-controller.json"
        )).unwrap();
        let devices = parse(&fixture).devices;
        let usb: Vec<_> = devices.iter().filter(|d| d.category == "usb").collect();
        assert_eq!(usb.len(), 3);
        assert!(usb.iter().any(|d| d.name == "Samsung T7 SSD"
            && d.detail.contains("super_speed")));
        assert!(usb.iter().any(|d| d.name == "Pixel 9 Pro"));
        assert!(usb.iter().any(|d| d.name == "USB2.0 Hub"));
        assert!(!usb.iter().any(|d| d.name.contains("Controller")
            || d.name.contains("USB31Bus") || d.name == "Macintosh HD"));
        assert!(!serde_json::to_string(&usb).unwrap().contains("PRIVATE_SERIAL"));
    }
    #[test]
    fn empty_controller_reports_no_peripherals() {
        let sample = json!({"SPUSBDataType":[
            {"_name":"USB31Bus","host_controller":"AppleT8132USBXHCI"},
            {"_name":"USB31Bus","host_controller":{"_name":"AppleT8132USBXHCI"}}
        ],"SPBluetoothDataType":[{"controller_properties":{"controller_state":"On"},
            "device_connected":[],"device_not_connected":[{"Old Mouse":{
                "device_batteryLevelMain":"50%"}}]}]});
        assert!(parse(&sample).devices.is_empty());
    }
    #[test]
    fn invalid_battery_values_remain_unknown() {
        for value in ["-1", "101%", "unknown"] {
            let sample = json!({"SPBluetoothDataType":[{"device_connected":[
                {"Device":{"device_batteryLevelMain":value}}]}]});
            assert_eq!(parse(&sample).devices[0].battery, None);
        }
    }
    #[test]
    fn accessory_power_fills_missing_headset_battery_without_adding_devices() {
        let sample = json!({"SPBluetoothDataType":[{"device_connected":[
            {"Xiaomi Earphones Explore":{"device_minorType":"Headset"}},
            {"Magic Mouse":{"device_batteryLevelMain":"67%"}}
        ]}]});
        let mut scan = parse(&sample);
        supplement_accessory_batteries(&mut scan.devices,
            "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; present: true\n -Xiaomi Earphones Explore (id=2)\t70%; \n -Magic Mouse (id=3)\t90%; \n -Old Headset (id=4)\t50%;\n");
        assert_eq!(scan.devices.len(), 2);
        assert_eq!(scan.devices.iter().find(|d| d.name.starts_with("Xiaomi")).unwrap().battery.as_deref(), Some("70%"));
        assert_eq!(scan.devices.iter().find(|d| d.name == "Magic Mouse").unwrap().battery.as_deref(), Some("67%"));
        let output = serde_json::to_string(&scan.devices).unwrap();
        assert!(!output.contains("(id="));
        assert!(!output.contains("Old Headset"));
    }
    #[test]
    fn accessory_power_rejects_invalid_absent_and_ambiguous_readings() {
        let headset = device("bluetooth", "Headset".into(), String::new(), String::new(), None, None, None);
        for report in [" -Headset (id=1)\t101%;", " -Headset (id=1)\t-1%;",
            " -Headset (id=1)\tunknown;", " -Headset (id=1)\t70%; present: false",
            " -Other Headset (id=1)\t70%;", " -Headset (id=1)\t70%;\n -Headset (id=2)\t30%;"] {
            let mut devices = vec![headset.clone()];
            supplement_accessory_batteries(&mut devices, report);
            assert!(devices[0].battery.is_none(), "{report}");
        }
        let mut duplicates = vec![headset.clone(), headset.clone()];
        supplement_accessory_batteries(&mut duplicates, " -Headset (id=1)\t70%;");
        assert!(duplicates.iter().all(|d| d.battery.is_none()));
        let mut disconnected = headset;
        disconnected.status = "disconnected".into();
        supplement_accessory_batteries(std::slice::from_mut(&mut disconnected), " -Headset (id=1)\t70%;");
        assert!(disconnected.battery.is_none());
    }
    #[test]
    fn accessory_power_preserves_zero_and_only_matches_bluetooth() {
        let mut devices = vec![
            device("bluetooth", "Headset".into(), String::new(), String::new(), None, None, None),
            device("usb", "Headset".into(), String::new(), String::new(), None, None, None),
        ];
        supplement_accessory_batteries(&mut devices, " -headset (id=1)\t0%;");
        assert_eq!(devices[0].battery.as_deref(), Some("0%"));
        assert!(devices[1].battery.is_none());
    }
    #[test]
    fn collects_displays_and_reports_only_adapter_power() {
        let sample = json!({"SPDisplaysDataType":[{"spdisplays_ndrvs":[{"_name":"DELL","spdisplays_resolution":"3840 x 2160","spdisplays_refresh_rate":"60 Hz"}]}],
            "SPPowerDataType":[{"ac_charger_information":{"sppower_ac_charger_watts":"96"}}]});
        let result = parse(&sample);
        assert_eq!(result.devices.len(), 1);
        assert_eq!(result.power["adapterWatts"], "96");
        assert!(result.power["batterySideWatts"].is_null());
    }
    #[test]
    fn headset_type_matches_real_bluetooth_model() {
        let d = device("bluetooth", "Xiaomi Earphones Explore".into(),
            "Headset".into(), String::new(), None, None, None);
        assert_eq!(d.kind, "headphones");
        let m = device("bluetooth", "Magic Mouse".into(),
            "Mouse".into(), String::new(), Some("80%".into()), None, None);
        assert_eq!(m.kind, "mouse");
    }
    #[test]
    fn status_exposes_device_categories_for_widget_counts() {
        let mut state=State::new();
        state.scan.devices.push(device("bluetooth", "Headset".into(),
            "Headset".into(), String::new(), None, None, None));
        state.scan.devices.push(device("display", "DELL".into(),
            "1920 x 1080".into(), String::new(), None, None, None));
        let status=state.status();
        assert_eq!(status["counts"]["bluetooth"],1);
        assert_eq!(status["counts"]["display"],1);
        assert_eq!(status["counts"]["usb"],0);
        assert_eq!(status["rows"][0]["category"],"bluetooth");
    }
    #[test]
    fn status_never_conflates_power_values() {
        let s = State::new();
        let full = s.full();
        let p = &full["power"];
        assert!(p["batterySideWatts"].is_null());
        assert!(p["cableLimitWatts"].is_null());
    }
}
