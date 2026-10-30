use serde_json::{json, Value};
use std::time::Duration;

pub(super) fn parse(text: &str) -> Result<Value, String> {
    let source = text.lines().next().and_then(|line| line.trim().strip_prefix("Now drawing from '")).and_then(|line| line.strip_suffix('\''));
    let (name, external) = match source {
        Some("AC Power") => ("外接电源", true),
        Some("Battery Power") => ("电池供电", false),
        Some("UPS Power") => ("UPS", true),
        _ => return Err("系统未提供可识别的供电来源".into()),
    };
    Ok(json!({"source":name,"externalConnected":external,"batteryPresent":text.lines().skip(1).any(|line|line.contains("InternalBattery"))}))
}

pub(super) fn read() -> Result<Value, String> {
    let output = super::read_system_query("/usr/bin/pmset", &["-g", "batt"], Duration::from_secs(3), 64 * 1024)?;
    parse(&String::from_utf8_lossy(&output))
}

pub(super) fn apply(sample: &mut Value, source: Result<Value, String>) {
    match source {
        Ok(source) => {
            for key in ["source", "externalConnected", "batteryPresent"] { sample[key] = source[key].clone(); }
            if source["externalConnected"] == false {
                // Source changes must clear stale adapter/input readings even
                // when IORegistry still reports the preceding AC sample.
                sample["inputWatts"] = json!(0.0); sample["adapterWatts"] = Value::Null;
            }
            if source["batteryPresent"] == false {
                sample["batterySideWatts"] = Value::Null; sample["charging"] = Value::Null;
                if sample["telemetryError"] == "此设备未提供电源遥测" { sample["telemetryError"] = Value::Null; }
            }
        },
        Err(error) => { if !sample["externalConnected"].is_boolean() { sample["powerSourceError"] = json!(error); } }
    }
    if sample["systemWatts"].is_null() && sample["inputWatts"].is_null() {
        sample["powerUnavailableReason"] = json!("当前未读取到实时功率，供电来源仍可独立读取。");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_ac_source_is_available_without_battery_or_watts() {
        let mut sample = json!({"systemWatts":null,"inputWatts":null,"source":null,"telemetryError":"此设备未提供电源遥测"});
        apply(&mut sample, parse("Now drawing from 'AC Power'\n"));
        assert_eq!(sample["source"], "外接电源"); assert_eq!(sample["externalConnected"], true);
        assert_eq!(sample["batteryPresent"], false); assert!(sample["telemetryError"].is_null());
        assert!(sample["systemWatts"].is_null()); assert!(sample["inputWatts"].is_null());
        assert!(sample["powerUnavailableReason"].is_string());
    }
    #[test]
    fn unplugged_source_clears_stale_input_and_keeps_real_battery_power() {
        let mut sample=json!({"systemWatts":12.3,"inputWatts":60.0,"adapterWatts":68,"batterySideWatts":-12.3});
        apply(&mut sample,parse("Now drawing from 'Battery Power'\n -InternalBattery-0 70%; discharging\n"));
        assert_eq!(sample["externalConnected"],false);assert_eq!(sample["batteryPresent"],true);
        assert_eq!(sample["inputWatts"],0.0);assert!(sample["adapterWatts"].is_null());assert_eq!(sample["batterySideWatts"],-12.3);
    }
    #[test]
    fn unsupported_or_failed_queries_do_not_guess_or_erase_known_sources() {
        assert!(parse("unrecognized output").is_err());
        assert_eq!(parse("Now drawing from 'UPS Power'\n").unwrap()["source"],"UPS");
        let mut sample=json!({"externalConnected":true,"source":"外接电源","systemWatts":24.0});
        apply(&mut sample,Err("查询失败".into()));assert_eq!(sample["externalConnected"],true);assert_eq!(sample["systemWatts"],24.0);
        let mut unknown=json!({"externalConnected":null,"systemWatts":null});
        apply(&mut unknown,Err("查询失败".into()));assert!(unknown["externalConnected"].is_null());assert_eq!(unknown["powerSourceError"],"查询失败");
        let mut failed=json!({"telemetryError":"查询权限受限"});apply(&mut failed,parse("Now drawing from 'AC Power'\n"));assert_eq!(failed["telemetryError"],"查询权限受限");
    }
}
