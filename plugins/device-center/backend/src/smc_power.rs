//! Read-only fallback for desktop Macs without AppleSmartBattery power telemetry.
//! PSTR is system total power; PDTR is DC input. Never sum CPU/GPU estimates.
use serde_json::{json, Value};

#[derive(Default)]
struct Power { system: Option<f64>, input: Option<f64> }

fn decode(kind: u32, bytes: &[u8]) -> Option<f64> {
    let value = match (&kind.to_be_bytes(), bytes) {
        (b"flt ", [a,b,c,d]) => f32::from_le_bytes([*a,*b,*c,*d]) as f64,
        (b"sp78", [a,b]) => i16::from_be_bytes([*a,*b]) as f64 / 256.0,
        (b"fpe2", [a,b]) => u16::from_be_bytes([*a,*b]) as f64 / 4.0,
        (b"ui8 ", [a]) => *a as f64,
        (b"ui16", [a,b]) => u16::from_be_bytes([*a,*b]) as f64,
        (b"ui32", [a,b,c,d]) => u32::from_be_bytes([*a,*b,*c,*d]) as f64,
        _ => return None,
    };
    value.is_finite().then_some(value).filter(|v| (0.0..=500.0).contains(v))
        .map(|v| (v * 10.0).round() / 10.0)
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::{ffi::{c_char, c_void}, mem::size_of};

    #[repr(C)] #[derive(Default)]
    struct Version { major: u8, minor: u8, build: u8, reserved: u8, release: u16 }
    #[repr(C)] #[derive(Default)]
    struct Limits { version: u16, length: u16, cpu: u32, gpu: u32, memory: u32 }
    #[repr(C)] #[derive(Default)]
    struct Info { size: u32, kind: u32, attributes: u8 }
    #[repr(C)] #[derive(Default)]
    struct Data {
        key: u32, version: Version, limits: Limits, info: Info,
        result: u8, status: u8, command: u8, data32: u32, bytes: [u8;32],
    }
    const _: () = assert!(size_of::<Data>() == 80);
    const _: () = assert!(std::mem::offset_of!(Data, bytes) == 48);
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOServiceMatching(name: *const c_char) -> *mut c_void;
        fn IOServiceGetMatchingService(port: u32, matching: *mut c_void) -> u32;
        fn IOServiceOpen(service: u32, task: u32, kind: u32, connection: *mut u32) -> i32;
        fn IOObjectRelease(object: u32) -> i32;
        fn IOServiceClose(connection: u32) -> i32;
        fn IOConnectCallStructMethod(connection: u32, selector: u32, input: *const c_void,
            input_size: usize, output: *mut c_void, output_size: *mut usize) -> i32;
        static mach_task_self_: u32;
    }
    struct Connection(u32);
    impl Drop for Connection { fn drop(&mut self) { unsafe { IOServiceClose(self.0); } } }
    impl Connection {
        fn open() -> Result<Self, String> {
            unsafe {
                let matching = IOServiceMatching(b"AppleSMC\0".as_ptr().cast());
                if matching.is_null() { return Err("SMC 服务不可用".into()); }
                // IOServiceGetMatchingService consumes the matching dictionary.
                let service = IOServiceGetMatchingService(0, matching);
                if service == 0 { return Err("此设备没有 SMC 功率接口".into()); }
                let mut connection = 0;
                let result = IOServiceOpen(service, mach_task_self_, 0, &mut connection);
                IOObjectRelease(service);
                if result != 0 { return Err(format!("SMC 只读连接失败（{result:#x}）")); }
                Ok(Self(connection))
            }
        }
        fn call(&self, input: &Data) -> Option<Data> {
            let mut output = Data::default(); let mut size = size_of::<Data>();
            let result = unsafe { IOConnectCallStructMethod(self.0, 2,
                (input as *const Data).cast(), size_of::<Data>(),
                (&mut output as *mut Data).cast(), &mut size) };
            (result == 0 && size == size_of::<Data>() && output.result == 0).then_some(output)
        }
        fn watts(&self, key: [u8;4]) -> Option<f64> {
            // Only the two whitelisted power keys and read commands 9/5 are used.
            let mut input = Data { key: u32::from_be_bytes(key), command: 9, ..Data::default() };
            let info = self.call(&input)?.info;
            if info.size == 0 || info.size > 32 { return None; }
            input.info.size = info.size; input.command = 5;
            let output = self.call(&input)?;
            decode(info.kind, &output.bytes[..info.size as usize])
        }
    }
    pub(super) fn read() -> Result<Power, String> {
        let connection = Connection::open()?;
        Ok(Power { system: connection.watts(*b"PSTR"), input: connection.watts(*b"PDTR") })
    }
}

fn apply(sample: &mut Value, power: Result<Power, String>) {
    let power = match power {
        Ok(power) => power,
        Err(error) => { sample["smcTelemetryError"] = json!(error); return; }
    };
    let mut filled = false;
    if sample["systemWatts"].is_null() {
        if let Some(value) = power.system {
            sample["systemWatts"] = json!(value); sample["systemWattsSource"] = json!("AppleSMC.PSTR"); filled = true;
        }
    }
    if sample["externalConnected"] == true && sample["inputWatts"].is_null() {
        if let Some(value) = power.input {
            sample["inputWatts"] = json!(value); sample["inputWattsSource"] = json!("AppleSMC.PDTR"); filled = true;
        }
    }
    if filled {
        sample["sampledAt"] = json!(super::now());
        sample["powerUnavailableReason"] = Value::Null;
        sample["note"] = json!("系统功率采样值可能有延迟；缺失字段由 SMC 整机/直流输入传感器补充，不等同于插座功率计测量。适配器规格不是实时输入功率，电池功率按电压×电流估算。");
        if !sample["systemWatts"].is_null() && !sample["telemetryError"].is_null() {
            sample["batteryTelemetryError"] = sample["telemetryError"].take();
        }
    }
}

pub(super) fn fill_missing(sample: &mut Value) {
    if !sample["systemWatts"].is_null() && (sample["externalConnected"] != true || !sample["inputWatts"].is_null()) { return; }
    #[cfg(target_os = "macos")]
    apply(sample, native::read());
    #[cfg(not(target_os = "macos"))]
    apply(sample, Err("当前平台不支持 SMC 功率读取".into()));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_float_and_fixed_point_watts_with_strict_validation() {
        let decode_as = |kind: &[u8;4], bytes: &[u8]| decode(u32::from_be_bytes(*kind), bytes);
        assert_eq!(decode_as(b"flt ", &11.354_f32.to_le_bytes()), Some(11.4));
        assert_eq!(decode_as(b"sp78", &[0x0c,0x80]), Some(12.5));
        assert_eq!(decode_as(b"fpe2", &[0,50]), Some(12.5));
        for value in [f32::NAN, f32::INFINITY, -1.0, 501.0] {
            assert_eq!(decode_as(b"flt ", &value.to_le_bytes()), None);
        }
        assert_eq!(decode_as(b"flt ", &[0,0]), None);
        assert_eq!(decode_as(b"????", &[0,0,0,0]), None);
        assert_eq!(decode_as(b"ui16", &[0,0]), Some(0.0));
    }
    #[test]
    fn restores_desktop_watts_and_clears_obsolete_unavailable_state() {
        let mut sample = json!({"externalConnected":true,"batteryPresent":false,"systemWatts":null,"inputWatts":null,
            "telemetryError":"此设备未提供电源遥测","powerUnavailableReason":"无功率"});
        apply(&mut sample, Ok(Power { system:Some(11.4),input:Some(12.0) }));
        assert_eq!(sample["systemWatts"],11.4); assert_eq!(sample["inputWatts"],12.0);
        assert_eq!(sample["systemWattsSource"],"AppleSMC.PSTR"); assert_eq!(sample["externalConnected"],true);
        assert!(sample["telemetryError"].is_null()); assert!(sample["powerUnavailableReason"].is_null());
        assert!(sample["sampledAt"].is_number()); assert!(sample["batterySideWatts"].is_null());
    }
    #[test]
    fn preserves_primary_telemetry_and_never_restores_ac_input_on_battery() {
        let mut sample = json!({"externalConnected":false,"systemWatts":24.0,"inputWatts":0.0,"batterySideWatts":-24.0});
        apply(&mut sample, Ok(Power { system:Some(11.4),input:Some(12.0) }));
        assert_eq!(sample["systemWatts"],24.0); assert_eq!(sample["inputWatts"],0.0); assert_eq!(sample["batterySideWatts"],-24.0);
        sample["systemWatts"] = Value::Null;
        apply(&mut sample, Ok(Power { system:Some(11.4),input:Some(12.0) }));
        assert_eq!(sample["systemWatts"],11.4); assert_eq!(sample["inputWatts"],0.0);
    }
    #[test]
    fn missing_or_denied_sensors_do_not_invent_watts() {
        let mut sample = json!({"externalConnected":true,"source":"外接电源","systemWatts":null,"inputWatts":null,"powerUnavailableReason":"无功率"});
        apply(&mut sample,Ok(Power::default()));
        assert!(sample["systemWatts"].is_null()); assert_eq!(sample["powerUnavailableReason"],"无功率");
        apply(&mut sample,Err("SMC 连接失败".into()));
        assert!(sample["systemWatts"].is_null()); assert_eq!(sample["source"],"外接电源");
        assert_eq!(sample["smcTelemetryError"],"SMC 连接失败");
    }
}
