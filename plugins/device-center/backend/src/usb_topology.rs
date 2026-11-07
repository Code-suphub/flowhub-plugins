use super::{field, short};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Function { Hub, Billboard }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Connection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub function: Option<Function>,
}

impl Connection {
    pub fn parse(node: &Value, vendor: Option<&str>, parent: Option<&str>) -> Self {
        let manufacturer = field(node, &["manufacturer"]).filter(|text| {
            !text.chars().all(|ch| matches!(ch, 'x' | 'X' | '-' | '_' | '?' | '0' | ' '))
        }).or_else(|| {
            // system_profiler can resolve the USB vendor ID even when the device
            // has no manufacturer descriptor. This describes the USB node.
            let (_, label) = vendor?.split_once('(')?;
            let label = short(label.strip_suffix(')')?, 90);
            (!label.is_empty()).then_some(label)
        });
        let speed = field(node, &["device_speed", "speed"]).map(|value| {
            match value.as_str() {
                "low_speed" => "低速 · 1.5 Mb/s".into(),
                "full_speed" => "全速 · 12 Mb/s".into(),
                "high_speed" => "高速 · 480 Mb/s".into(),
                "super_speed" => "5 Gb/s".into(),
                // This label can cover more than one rate. Retain the reported
                // class without guessing the negotiated link bandwidth.
                "super_speed_plus" => "SuperSpeed Plus".into(),
                _ => value,
            }
        });
        Self { parent_id: parent.map(str::to_owned), manufacturer, speed, function: None }
    }
}
