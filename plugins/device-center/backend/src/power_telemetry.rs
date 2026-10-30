use plist::Value as Plist;
use serde_json::{json, Value};
use std::time::Duration;

fn at<'a>(root: &'a Plist, path: &[&str]) -> Option<&'a Plist> {
    path.iter().try_fold(root, |node, key| node.as_dictionary()?.get(*key))
}
fn number(root: &Plist, path: &[&str]) -> Option<f64> {
    let value = at(root, path)?;
    value.as_real().or_else(|| value.as_signed_integer().map(|n| n as f64))
        .or_else(|| value.as_unsigned_integer().map(|n| n as f64)).filter(|v| v.is_finite())
}
fn watts(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && (0.0..=500.0).contains(v))
        .map(|v| (v * 10.0).round() / 10.0)
}
// Older IORegistry representations may publish signed current as an unsigned
// two's-complement integer. Validate the decoded range before multiplying.
fn current_ma(root: &Plist) -> Option<f64> {
    ["InstantAmperage", "Amperage"].iter().find_map(|key| {
        let value = at(root, &[*key])?;
        let current = value.as_signed_integer().or_else(|| value.as_unsigned_integer().map(|n| n as i64))?;
        (-50_000..=50_000).contains(&current).then_some(current as f64)
    })
}
pub(super) fn parse(output: &[u8]) -> Result<Value, String> {
    let plist = Plist::from_reader_xml(output).map_err(|_| "系统功率数据格式不支持".to_string())?;
    let root = plist.as_array().and_then(|nodes| nodes.first()).ok_or("此设备未提供电源遥测")?;
    let external = at(root, &["ExternalConnected"]).and_then(Plist::as_boolean);
    let input = if external == Some(false) { Some(0.0) } else if external == Some(true) {
        watts(number(root, &["PowerTelemetryData", "SystemPowerIn"]).map(|v| v / 1000.0))
            // Only accept actual plist reals here. Legacy integer encodings do
            // not document their units and must not be guessed as watts.
            .or_else(|| watts(at(root, &["BatteryData", "AdapterPower"]).and_then(Plist::as_real)))
    } else { None };
    let system = watts(number(root, &["PowerTelemetryData", "SystemLoad"]).map(|v| v / 1000.0))
        .or_else(|| watts(at(root, &["BatteryData", "SystemPower"]).and_then(Plist::as_real)));
    let voltage = number(root, &["Voltage"]).filter(|v| (1_000.0..=30_000.0).contains(v));
    let battery = voltage.zip(current_ma(root)).map(|(mv, ma)| mv * ma / 1_000_000.0)
        .filter(|v| v.abs() <= 500.0).map(|v| (v * 10.0).round() / 10.0);
    let mut sample = json!({
        "inputWatts":input,"systemWatts":system,"batterySideWatts":battery,
        "sampledAt":super::now(),"telemetryError":null,"externalConnected":external,
        "note":"系统报告的采样值可能有延迟；电池功率按电压×电流估算。适配器规格不是实际输入功率，外设独立耗电及线缆能力未测量。"
    });
    if let Some(charging) = at(root, &["IsCharging"]).and_then(Plist::as_boolean) { sample["charging"] = json!(charging); }
    if let Some(external) = external { sample["source"] = json!(if external { "外接电源" } else { "电池供电" }); }
    sample["adapterWatts"] = json!(if external == Some(true) {
        watts(number(root, &["AdapterDetails", "Watts"]))
    } else { None });
    Ok(sample)
}
pub(super) fn read() -> Result<Value, String> {
    let output = super::read_system_query("/usr/sbin/ioreg", &["-a", "-r", "-c", "AppleSmartBattery"],
        Duration::from_secs(3), super::MAX_BYTES)?;
    parse(&output)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(body: &str) -> Value {
        let xml = format!("<?xml version=\"1.0\"?><plist version=\"1.0\"><array><dict>{body}</dict></array></plist>");
        parse(xml.as_bytes()).unwrap()
    }
    #[test]
    fn separates_adapter_rating_input_load_and_idle_battery() {
        let v = sample("<key>ExternalConnected</key><true/><key>IsCharging</key><false/>
            <key>Voltage</key><integer>12870</integer><key>InstantAmperage</key><integer>0</integer>
            <key>AdapterDetails</key><dict><key>Watts</key><integer>68</integer><key>SerialString</key><string>PRIVATE</string></dict>
            <key>PowerTelemetryData</key><dict><key>SystemPowerIn</key><integer>27440</integer><key>SystemLoad</key><integer>24000</integer></dict>");
        assert_eq!(v["adapterWatts"],68.0); assert_eq!(v["inputWatts"],27.4);
        assert_eq!(v["systemWatts"],24.0); assert_eq!(v["batterySideWatts"],0.0);
        assert!(!v.to_string().contains("PRIVATE"));
    }
    #[test]
    fn preserves_charge_and_discharge_direction_and_rejects_stale_ac_input() {
        for (current, expected) in [("2000",24.0),("-2000",-24.0),("18446744073709549616",-24.0)] {
            let v = sample(&format!("<key>ExternalConnected</key><false/><key>Voltage</key><integer>12000</integer>
                <key>InstantAmperage</key><integer>{current}</integer>
                <key>PowerTelemetryData</key><dict><key>SystemPowerIn</key><integer>28000</integer></dict>"));
            assert_eq!(v["batterySideWatts"],expected); assert_eq!(v["inputWatts"],0.0);
            assert_eq!(v["externalConnected"],false); assert!(v["adapterWatts"].is_null());
            assert!(v["systemWatts"].is_null());
        }
    }
    #[test]
    fn falls_back_to_real_power_fields_but_never_guesses_missing_values() {
        let v = sample("<key>ExternalConnected</key><true/><key>BatteryData</key><dict>
            <key>AdapterPower</key><real>27.44</real><key>SystemPower</key><real>29.79</real></dict>");
        assert_eq!(v["inputWatts"],27.4); assert_eq!(v["systemWatts"],29.8);
        assert!(v["batterySideWatts"].is_null());
        let missing = sample("<key>BatteryData</key><dict><key>SystemPower</key><integer>1104635067</integer></dict>
            <key>Voltage</key><integer>12000</integer><key>InstantAmperage</key><integer>999999</integer>");
        assert!(missing["inputWatts"].is_null()); assert!(missing["systemWatts"].is_null());
        assert!(missing["batterySideWatts"].is_null());
        assert!(parse(b"not a plist").is_err());
        assert!(parse(b"<plist><array/></plist>").is_err());
    }
}
