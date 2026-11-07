use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
mod power_telemetry;
mod power_source;
mod smc_power;
mod device_icons;
mod device_catalog;
mod battery_history;
mod usb_hid;
mod adb;
mod adb_preferences;
mod local_preferences;
mod toolkit_adb;
mod widget_order;
mod cli;
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
static SCAN_LOCK: Mutex<()> = Mutex::new(());

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
    #[serde(skip_serializing_if = "Option::is_none")]
    battery_source: Option<battery_history::Source>,
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
    #[serde(skip)]
    usb_location: Option<String>,
    #[serde(default, skip_serializing_if="Option::is_none")]
    adb: Option<adb::Info>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    at: u64,
    device_id: String,
    name: String,
    category: String,
    action: String,
    #[serde(skip_serializing_if="Option::is_none")]
    route: Option<String>,
    #[serde(skip_serializing_if="Option::is_none")]
    state: Option<String>,
}
impl Event {
    fn device(at: u64, device: &Device, action: &str) -> Self {
        Self { at, device_id: device.id.clone(), name: device.name.clone(), category: device.category.clone(),
            action: action.into(), route: None, state: None }
    }

    fn adb(at: u64, device: &Device, info: &adb::Info, route: &adb::Connection, state: &str, action: &str) -> Self {
        let mut event = Self::device(at, device, action);
        event.name = info.shared_alias.as_ref().or(info.model.as_ref()).cloned()
            .unwrap_or_else(|| "Android 设备".into());
        event.route = Some(route.source.as_ref().unwrap_or(&route.transport).clone());
        event.state = Some(match state {
            "device" | "offline" | "unauthorized" | "no permissions" | "recovery" |
            "sideload" | "bootloader" | "connecting" | "authorizing" => state,
            _ => "unknown",
        }.into());
        event
    }
}
fn adb_routes(devices: &[Device]) -> BTreeMap<&str, (&Device, &adb::Info, &adb::Connection)> {
    devices.iter().filter_map(|d| d.adb.as_ref().map(|info| (d, info)))
        .flat_map(|(d, info)| info.connections.iter().map(move |route| (route.serial.as_str(), (d, info, route))))
        .collect()
}
#[derive(Clone)]
struct Scan {
    devices: Vec<Device>,
    power: Value,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogDevice<'a> {
    #[serde(flatten)]
    device: &'a Device,
    #[serde(skip_serializing_if = "Option::is_none")]
    catalog_key: Option<&'static str>,
}
struct State {
    battery_history: battery_history::Store,
    catalog: device_catalog::Store,
    widget_order: widget_order::Store,
    adb_preferences: adb_preferences::Store,
    adb: adb::Report,
    adb_query: Arc<Mutex<()>>,
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
        battery, battery_source:None, vendor, product_id, display_connection:None, pixel_resolution:None,
        logical_resolution:None, refresh_rate:None, native_display_id:None, usb_location:None, adb:None }
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
                    let mut peripheral = device("usb", name, detail, key, None, vendor_id, product_id);
                    peripheral.usb_location = Some(port);
                    out.push(peripheral);
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
            d.battery_source = Some(battery_history::Source::Pmset);
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
                        let battery = battery_percent(node);
                        let source = battery.as_ref().map(|_| battery_history::Source::SystemProfiler);
                        let mut peripheral = device("bluetooth", name, model,
                            String::new(), battery, None, None);
                        peripheral.battery_source = source;
                        out.push(peripheral);
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
    usb_hid::read(&mut scan.devices);
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
        Self { battery_history:battery_history::Store::default(), catalog:device_catalog::Store::default(), widget_order:widget_order::Store::default(), adb_preferences:adb_preferences::Store::default(), adb:adb::Report::default(), adb_query:Arc::new(Mutex::new(())), scan: Scan { devices: vec![], power: power(&Value::Null) },
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
                        if !before.contains_key(d.id.as_str()) { self.events.push_front(Event::device(time, d, "connected")); }
                    }
                    for d in &self.scan.devices {
                        if !after.contains_key(d.id.as_str()) { self.events.push_front(Event::device(time, d, "disconnected")); }
                    }
                    self.events.truncate(60);
                }
                self.battery_history.observe(&new.devices, false, time);
                self.scan = new;
                self.at = time;
                self.error = None;
            }
        }
    }
    fn apply_adb(&mut self, result: Result<Vec<Device>, adb::Error>) {
        // Use the last successful observation. Changes to grouping, aliases and
        // network labels do not change the state of an ADB route.
        if let Ok(next) = &result {
            self.battery_history.observe(next, true, now());
            if self.adb.at != 0 {
                let time = now();
                let before = adb_routes(&self.adb.devices);
                let after = adb_routes(next);
                for (&serial, &(device, info, route)) in &after {
                    let previous = before.get(serial).map(|(_, _, route)| route.state.as_str());
                    let state = route.state.as_str();
                    if previous == Some(state) { continue; }
                    let action = match (previous, state) {
                        (_, "device") => "connected",
                        (Some("device"), "offline") => "disconnected",
                        _ => "state",
                    };
                    self.events.push_front(Event::adb(time, device, info, route, state, action));
                }
                for (serial, (device, info, route)) in before {
                    if route.state == "device" && !after.contains_key(serial) {
                        self.events.push_front(Event::adb(time, device, info, route, "offline", "disconnected"));
                    }
                }
                self.events.truncate(60);
            }
        }
        self.adb.apply(result);
    }
    fn stale(&self) -> bool { self.at == 0 || now().saturating_sub(self.at) > 120_000 || self.error.is_some() }
    fn full(&self) -> Value {
        let mut power = self.scan.power.clone();
        if let Some(sample) = self.power_sample.as_ref().and_then(Value::as_object) {
            for (key, value) in sample { power[key] = value.clone(); }
        }
        let mut catalog = BTreeMap::new();
        let devices: Vec<_> = self.scan.devices.iter().chain(self.adb.devices.iter()).map(|device| {
            let catalog_key = device_catalog::identify(device).map(|entry| {
                catalog.entry(entry.key).or_insert_with(|| self.catalog.profile(entry));
                entry.key
            });
            CatalogDevice { device, catalog_key }
        }).collect();
        json!({"at":self.at, "stale":self.stale(), "devices":devices,"catalog":catalog,"adb":self.adb.value(),"widgetOrder":self.widget_order.value(),"adbPreferences":self.adb_preferences.value(),
            "power":power, "events":self.events, "error":self.error,
            "intervalSeconds":45,"powerIntervalSeconds":5})
    }
    fn status(&self) -> Value {
        let rows: Vec<_> = self.scan.devices.iter().chain(self.adb.devices.iter()).take(40).map(|d| {
            let stale=if d.category=="adb"{self.adb.stale()}else{self.stale()};
            json!({"id":d.id,"name":d.name,"category":d.category,"kind":d.kind,"battery":d.battery,
                "status":if stale {"stale"} else if d.status=="connected" {"healthy"} else {"error"},
                "summary":format!("{} · {}", category_label(&d.category), if d.detail.is_empty() {"已连接"} else {&d.detail})})
        }).collect();
        json!({"title":"外设中心","monitoring":true,"at":self.at,"rows":rows,
            "counts":{"bluetooth":self.scan.devices.iter().filter(|d| d.category=="bluetooth").count(),
                      "usb":self.scan.devices.iter().filter(|d| d.category=="usb").count(),
                      "display":self.scan.devices.iter().filter(|d| d.category=="display").count(),"adb":self.adb.devices.len()},
            "error":self.error,"stale":self.stale(),"count":self.scan.devices.len()+self.adb.devices.len()})
    }
}
fn category_label(category: &str) -> &str {
    match category { "usb" => "USB", "bluetooth" => "蓝牙", "display" => "显示器", "adb" => "ADB", _ => "设备" }
}
fn schedule_catalog(state: &Arc<Mutex<State>>) {
    let jobs = {
        let Ok(mut state) = state.lock() else { return; };
        let State { catalog, scan, adb, .. } = &mut *state;
        catalog.schedule(scan.devices.iter().chain(adb.devices.iter()))
    };
    for (root, entry) in jobs {
        let state = Arc::clone(state);
        thread::spawn(move || {
            let data = device_catalog::load(&root, entry);
            if let Ok(mut state) = state.lock() { state.catalog.finish(entry, data); }
        });
    }
}
fn refresh_devices(state: &Arc<Mutex<State>>) -> Result<(), String> {
    let _scan = SCAN_LOCK.lock().map_err(|_| "设备扫描不可用")?;
    let result = profile();
    let error = result.as_ref().err().cloned();
    state.lock().map_err(|_| "状态缓存不可用")?.apply(result);
    schedule_catalog(state);
    error.map_or(Ok(()), Err)
}

fn k75_status() -> Result<Value, String> {
    let executable = std::env::current_exe().map_err(|_| "无法定位外设中心后端")?;
    let helper = executable.with_file_name("flowhub-k75-probe");
    let path = helper.to_str().ok_or("K75 诊断工具路径无效")?;
    let output = read_system_query(path, &[], Duration::from_secs(4), 4096)
        .map_err(|_| "K75 USB 诊断工具运行失败或超时")?;
    let report: Value = serde_json::from_slice(&output).map_err(|_| "K75 诊断返回无效 JSON")?;
    match report["error"].as_str() {
        Some(error) => Err(error.into()),
        None => Ok(report),
    }
}
fn refresh_adb(state:&Arc<Mutex<State>>) {
    let Ok((query,checked))=state.lock().map(|s|(s.adb_query.clone(),s.adb.checked_at)) else{return;};
    let Ok(_guard)=query.lock() else{return;};
    if state.lock().is_ok_and(|s|s.adb.checked_at>checked){return;}
    let result=adb::read();
    if let Ok(mut s)=state.lock(){s.apply_adb(result);}
    schedule_catalog(state);
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
fn dispatch(state: &Arc<Mutex<State>>, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "health" => Ok(json!({"protocol":2,"name":"device-center","version":env!("CARGO_PKG_VERSION")})),
        "device_icons" => Ok(device_icons::snapshot()),
        "battery_history" | "battery_history_set_retention" => {
            let id = params["id"].as_str().filter(|s| s.len() <= 64).ok_or("设备标识无效")?;
            let mut s = state.lock().map_err(|_| "状态缓存不可用")?;
            let at = now();
            if method == "battery_history_set_retention" {
                let hours = params["hours"].as_u64().ok_or("日志保留时间无效")?;
                s.battery_history.set_hours(hours, at)?;
            }
            Ok(s.battery_history.value(id, at))
        },
        "open_device_reference" => {
            let key = params["key"].as_str().ok_or("缺少设备型号")?;
            let kind = params["kind"].as_str().ok_or("缺少资料类型")?;
            let url = device_catalog::reference(key, kind).ok_or("该设备资料未收录")?;
            read_system_query("/usr/bin/open", &[url], Duration::from_secs(5), 1024)
                .map(|_| json!({"opened":true})).map_err(|_| "无法打开设备资料".into())
        },
        "widget_order_set" => state.lock().map_err(|_| "状态缓存不可用")?.widget_order.update(params),
        "adb_set_alias" => {
            let id = params["id"].as_str().ok_or("缺少设备标识")?;
            let alias = params["alias"].as_str().ok_or("别名格式无效")?;
            let mut state = state.lock().map_err(|_| "状态缓存不可用")?;
            let info = state.adb.devices.iter().find(|device| device.id == id)
                .and_then(|device| device.adb.as_ref())
                .ok_or("该 ADB 连接已不在列表中，请刷新后重试")?;
            let previous_ids = info.legacy_ids.clone();
            state.adb_preferences.set_alias(id, alias, &previous_ids)
        },
        "adb_set_low_battery_threshold" => {
            let threshold = params["threshold"].as_u64().ok_or("低电量阈值须为 0 到 100 的整数")?;
            state.lock().map_err(|_| "状态缓存不可用")?.adb_preferences.set_threshold(threshold)
        },
        "adb_refresh" => { refresh_adb(state); state.lock().map_err(|_| "状态缓存不可用".to_string()).map(|s|s.full()) },
        "open_display_settings" => {
            if !cfg!(target_os = "macos") { return Err("显示器设置仅支持 macOS".into()); }
            // A fixed destination: no URL, command or display mode comes from the page.
            read_system_query("/usr/bin/open", &["x-apple.systempreferences:com.apple.Displays-Settings.extension"],
                Duration::from_secs(5), 1024)
                .map(|_| json!({"opened":true}))
                .map_err(|_| "无法打开显示器设置，请在系统设置中选择“显示器”。".into())
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
            let result = refresh_devices(state);
            update_power_sample(state, true, power_interval_seconds(params));
            result?;
            let s = state.lock().map_err(|_| "状态缓存不可用")?;
            if let Some(e) = &s.error { Err(e.clone()) } else {
                let mut snapshot = s.full();
                snapshot["powerIntervalSeconds"] = json!(power_interval_seconds(params)); Ok(snapshot)
            }
        },
        "widget_api" => match params["action"].as_str() {
            Some("snapshot") => state.lock().map_err(|_| "状态缓存不可用".to_string()).map(|s| s.status()),
            Some("management") => match params["method"].as_str() {
                Some("snapshot") => dispatch(state, "snapshot", &params["params"]),
                Some("refresh") => dispatch(state, "refresh", &params["params"]),
                Some("device_icons") => dispatch(state, "device_icons", &params["params"]),
                Some(method @ ("battery_history" | "battery_history_set_retention")) => dispatch(state, method, &params["params"]),
                Some("open_device_reference") => dispatch(state, "open_device_reference", &params["params"]),
                Some("open_display_settings") => dispatch(state, "open_display_settings", &params["params"]),
                Some("adb_refresh") => dispatch(state, "adb_refresh", &params["params"]),
                Some(method @ ("adb_set_alias" | "adb_set_low_battery_threshold")) => dispatch(state, method, &params["params"]),
                Some("widget_order_set") => dispatch(state, "widget_order_set", &params["params"]),
                _ => Err("不支持的组件操作".into()),
            },
            _ => Err("不支持的组件操作".into())
        },
        _ => Err("未知插件方法".into())
    }
}
fn persist_battery_history(state: &Mutex<State>, writer: &Mutex<()>) {
    let Ok(_writer) = writer.lock() else { return; };
    let pending = state.lock().ok().and_then(|mut s| s.battery_history.pending(now()));
    if let Some(write) = pending {
        let success = write.save();
        if let Ok(mut s) = state.lock() { s.battery_history.finish(write.revision, success); }
    }
}
fn main() {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("--cli") {
        let response = cli::run(&args.collect::<Vec<_>>()).unwrap_or_else(|error| json!({"error":error}));
        println!("{response}");
        if response.get("error").is_some() { std::process::exit(1); }
        return;
    }
    let mut initial = State::new();
    let root = std::env::var_os("FLOWHUB_PLUGIN_DATA").map(std::path::PathBuf::from);
    initial.widget_order = widget_order::Store::open(root.clone());
    initial.adb_preferences = adb_preferences::Store::open(root.clone());
    initial.battery_history = battery_history::Store::open(root.clone(), now());
    initial.catalog.root = root.clone();
    let state = Arc::new(Mutex::new(initial));
    if let Some(root) = root.as_deref() {
        if let Err(error) = cli::serve(root, Arc::clone(&state)) {
            eprintln!("外设中心 CLI 未启动: {error}");
        }
    }
    let writer = Arc::new(Mutex::new(()));
    let history_worker = Arc::clone(&state);
    let history_writer = Arc::clone(&writer);
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(10));
        persist_battery_history(&history_worker, &history_writer);
    });
    let adb_worker=Arc::clone(&state);
    thread::spawn(move || loop { refresh_adb(&adb_worker); thread::sleep(Duration::from_secs(10)); });
    let worker = Arc::clone(&state);
    thread::spawn(move || {
        loop {
            let _ = refresh_devices(&worker);
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
        let result = dispatch(&state, req["method"].as_str().unwrap_or(""), &req["params"]);
        let message = match result {
            Ok(v) => json!({"id":req["id"],"result":v}),
            Err(e) => json!({"id":req["id"],"error":e})
        };
        if writeln!(output, "{message}").and_then(|_| output.flush()).is_err() { break; }
    }
    persist_battery_history(&state, &writer);
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
    fn widget_order_management_route_saves_only_opaque_device_identities() {
        let state = Arc::new(Mutex::new(State::new()));
        let result = dispatch(&state, "widget_api", &json!({"action":"management","method":"widget_order_set","params":{"ids":["adb-aaaaaaaaaaaaaaaa","usb-bbbbbbbbbbbbbbbb"],"expectedRevision":0}})).unwrap();
        assert_eq!(result["revision"], 1);
        assert_eq!(state.lock().unwrap().full()["widgetOrder"]["ids"][0], "adb-aaaaaaaaaaaaaaaa");
        assert!(dispatch(&state, "widget_api", &json!({"action":"management","method":"widget_order_set","params":{"ids":["PUBLIC-SERIAL"],"expectedRevision":1}})).is_err());
        assert!(dispatch(&state, "widget_api", &json!({"action":"management","method":"arbitrary_write","params":{}})).is_err());
        assert_eq!(state.lock().unwrap().full()["widgetOrder"], result);
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
    fn generic_usb_keyboard_uses_the_hid_name_on_its_exact_port() {
        let sample = json!({"SPUSBDataType":[{"_name":"USB 2.0 Hub","_items":[
            {"_name":"composite_device","vendor_id":"0x258a","product_id":"0x0112","location_id":"0x00111000 / 5"},
            {"_name":"composite_device","vendor_id":"0x258a","product_id":"0x0112","location_id":"0x00112000 / 6"}
        ]}]});
        let mut devices = parse(&sample).devices;
        let keyboard_id = devices[0].id.clone();
        let original_id = devices[1].id.clone();
        let rows = json!([
            {"transport":"USB","vendor":0x258a,"product":0x0112,"location":0x00111000,"name":"Gaming Keyboard"},
            {"transport":"USB","vendor":0x258a,"product":0x0112,"location":0x00111000,"name":"Gaming Keyboard"},
            {"transport":"Bluetooth Low Energy","vendor":0x258a,"product":0x0112,"location":0x00111000,"name":"Kzzi K75"},
            {"transport":"USB","vendor":0x258a,"product":0x0112,"location":0x00112000,"name":"Other"},
            {"transport":"USB","vendor":0x258a,"product":0x0112,"location":0x00112000,"name":"Different"}
        ]);
        let report = serde_json::to_vec(&rows).unwrap();
        usb_hid::fill_names(&mut devices, &report);
        let keyboard = devices.iter().find(|d| d.name == "Gaming Keyboard").unwrap();
        assert_eq!(keyboard.id, keyboard_id);
        assert_eq!(keyboard.category, "usb");
        assert_eq!(keyboard.kind, "keyboard");
        assert_eq!(keyboard.usb_location.as_deref(), Some("0x00111000 / 5"));
        assert_eq!(devices[1].id, original_id);
        assert_eq!(devices[1].name, "composite_device");
        assert!(!serde_json::to_string(&devices).unwrap().contains("0x00111000"));
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
    #[test]
    fn adb_cache_and_failures_are_independent_from_system_devices() {
        let mut state=State::new();state.at=now();
        state.scan.devices.push(device("usb","Public USB".into(),"USB".into(),String::new(),None,None,None));
        let mut android=device("adb","Public Android".into(),"PUBLIC".into(),String::new(),None,None,None);
        android.status="unauthorized".into();
        state.adb.apply(Ok(vec![android]));
        assert_eq!(state.full()["devices"].as_array().unwrap().len(),2);
        assert_eq!(state.status()["counts"]["adb"],1);assert_eq!(state.status()["rows"][1]["status"],"error");
        state.adb.apply(Err(adb::Error::Query("ADB timeout".into())));
        assert_eq!(state.status()["rows"][0]["status"],"healthy");assert_eq!(state.status()["rows"][1]["status"],"stale");
        assert!(state.full()["error"].is_null());assert_eq!(state.full()["adb"]["error"],"ADB timeout");
    }
    #[test]
    fn adb_events_follow_route_changes_after_a_successful_baseline() {
        let mut state = State::new();
        let scan = |rows: &str| toolkit_adb::group(
            adb::parse(&format!("List of devices attached\n{rows}")).unwrap(),
            &toolkit_adb::Catalog::default(), &toolkit_adb::NetworkSources::default()
        );
        let baseline = scan("192.0.2.1:5555 device\nPUBLIC-USB device usb:1-1");
        state.apply_adb(Ok(baseline.clone()));
        assert!(state.events.is_empty());

        let mut renamed = baseline;
        renamed[0].id = "adb-group".into();
        renamed[0].adb.as_mut().unwrap().shared_alias = Some("Test Phone".into());
        state.apply_adb(Ok(renamed.clone()));
        state.apply_adb(Err(adb::Error::Query("ADB timeout".into())));
        assert!(state.events.is_empty());

        renamed[0].adb.as_mut().unwrap().connections[0].state = "offline".into();
        state.apply_adb(Ok(renamed.clone()));
        assert_eq!(state.events.len(), 1);
        let event = &state.full()["events"][0];
        assert_eq!(event["deviceId"], "adb-group");
        assert_eq!(event["name"], "Test Phone");
        assert_eq!(event["action"], "disconnected");
        assert_eq!(event["route"], "tcp");
        assert_eq!(event["state"], "offline");
        assert!(!event.to_string().contains("192.0.2.1"));

        state.apply_adb(Ok(renamed));
        assert_eq!(state.events.len(), 1);
        state.apply_adb(Ok(scan("")));
        assert_eq!(state.events.len(), 2);
        let event = &state.full()["events"][0];
        assert_eq!(event["name"], "Android 设备");
        assert_eq!(event["route"], "usb");
        assert!(!event.to_string().contains("PUBLIC-USB"));
        state.apply_adb(Ok(scan("PUBLIC-USB device usb:1-1")));
        assert_eq!(state.events[0].action, "connected");
    }
}
