//! Opt-in, persistent monitor. It never changes a phone during a normal ADB scan.
use super::*;
use std::{sync::atomic::{AtomicBool,Ordering},thread};
const FILE:&str="phone-recovery-state.json";
const OFFLINE_MS:u64=90_000;
const COOLDOWN_MS:u64=300_000;
const MAX_ATTEMPTS:u8=3;
static STOP:AtomicBool=AtomicBool::new(false);
static STORE:OnceLock<Mutex<HashMap<String,Monitor>>>=OnceLock::new();

#[derive(Clone,Default,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct Monitor {
    #[serde(default)] offline_since:Option<u64>,
    #[serde(default)] attempts:u8,
    #[serde(default)] next_attempt_at:u64,
    #[serde(default)] checked_at:u64,
    #[serde(default)] handled_finished_at:u64,
    #[serde(default)] reason:String,
    #[serde(default)] last_result:Option<Value>,
}
impl Monitor {
    fn observe(&mut self,now:u64,online:bool) {
        if now<self.checked_at {self.offline_since=None;self.next_attempt_at=now.saturating_add(COOLDOWN_MS);}
        self.checked_at=now;
        if online {self.offline_since=None;self.attempts=0;self.reason="online".into();}
        else {self.offline_since.get_or_insert(now);self.reason="waiting-offline".into();}
    }
    fn due(&mut self,now:u64)->bool {
        if self.attempts>=MAX_ATTEMPTS {self.reason="exhausted".into();return false;}
        if now<self.next_attempt_at {self.reason="cooldown".into();return false;}
        self.offline_since.is_some_and(|since|now.saturating_sub(since)>=OFFLINE_MS)
    }
    fn reserve(&mut self,now:u64) {self.attempts=self.attempts.saturating_add(1);self.next_attempt_at=now.saturating_add(COOLDOWN_MS);self.reason="recovering".into();}
    fn defer(&mut self,now:u64) {self.attempts=self.attempts.saturating_sub(1);self.next_attempt_at=now.saturating_add(30_000);self.reason="phone-busy".into();}
}
fn store()->&'static Mutex<HashMap<String,Monitor>> {
    STORE.get_or_init(||Mutex::new(root().ok().and_then(|r|crate::local_preferences::read(&r,FILE,65536).ok().flatten()).unwrap_or_default()))
}
fn save()->Result<(),String> {
    let values=store().lock().map_err(|_|"自动恢复状态忙")?;
    crate::local_preferences::write(&root()?,FILE,&*values).map_err(|_|"无法保存自动恢复状态".into())
}
pub(super) fn summary(id:&str)->Value {
    let item=store().lock().ok().and_then(|s|s.get(id).cloned()).unwrap_or_default();
    json!({"reason":item.reason,"attempts":item.attempts,"nextAttemptAt":item.next_attempt_at,"checkedAt":item.checked_at,"offlineSince":item.offline_since,
        "lastResult":item.last_result,"offlineSeconds":90,"intervalSeconds":30,"cooldownSeconds":300,"maxAttempts":MAX_ATTEMPTS})
}
pub(super) fn reset(id:&str) {if let Ok(mut s)=store().lock(){s.remove(id);}let _=save();}
#[derive(Clone,Copy,PartialEq)] enum Availability {Online,Offline,Unknown,Unauthorized}
fn availability(state:&crate::State,p:&Phone)->Availability {
    if state.adb.stale() || !state.adb.available{return Availability::Unknown;}
    let Some(binding)=p.adb_recovery.as_ref() else{return Availability::Unknown;};
    let endpoint=match recovery::binding_check(p){Ok(e)=>e,Err(_)=>return Availability::Unauthorized};
    observed_availability(&state.adb.devices,&binding.identity,&endpoint)
}
fn observed_availability(devices:&[crate::Device],identity:&str,endpoint:&str)->Availability {
    let mut denied=false;
    for info in devices.iter().filter_map(|d|d.adb.as_ref()) {
        if info.state=="device" && info.hardware_identity.as_deref()==Some(identity) {return Availability::Online;}
        if info.serial==endpoint && (info.state=="unauthorized" || info.hardware_identity.as_ref().is_some_and(|s|s!=identity)) {denied=true;}
        if info.connections.iter().any(|r|r.serial==endpoint && r.state=="unauthorized") {denied=true;}
    }
    if denied {Availability::Unauthorized}else{Availability::Offline}
}
fn set_reason(id:&str,reason:&str) {if let Ok(mut values)=store().lock(){values.entry(id.into()).or_default().reason=reason.into();}}
fn tick(state:&Arc<Mutex<crate::State>>) {
    let phones=match CONFIG.lock(){Ok(_guard)=>match read(){Ok(c)=>c.phones,Err(_)=>return},Err(_)=>return};
    if let Ok(mut values)=store().lock(){values.retain(|id,_|phones.iter().any(|p|&p.id==id));}
    for p in phones.iter().filter(|p|p.auto_recovery && p.adb_recovery.is_some()) {
        if STOP.load(Ordering::Relaxed){return;}
        let now=crate::now();
        let available=state.lock().map(|s|availability(&s,p)).unwrap_or(Availability::Unknown);
        if available==Availability::Unknown {set_reason(&p.id,"awaiting-scan");continue;}
        if available==Availability::Unauthorized {set_reason(&p.id,"manual-required");continue;}
        let job=recovery::status(&p.id).unwrap_or(Value::Null);
        if job["status"]=="running" {set_reason(&p.id,"recovering");continue;}
        let due={
            let Ok(mut values)=store().lock() else{return;};let m=values.entry(p.id.clone()).or_default();
            if let Some(finished)=job["finishedAt"].as_u64().filter(|v|*v>m.handled_finished_at) {
                m.handled_finished_at=finished;
                m.last_result=Some(json!({"status":job["status"],"stage":job["stage"],"error":job["error"],"reason":job["reason"],"trigger":job["trigger"],"startedAt":job["startedAt"],"finishedAt":finished,"identityVerified":job["identityVerified"]}));
                if job["trigger"]=="automatic" && job["status"]=="deferred" {m.defer(now);}
                else {m.next_attempt_at=m.next_attempt_at.max(finished.saturating_add(COOLDOWN_MS));}
            }
            m.observe(now,available==Availability::Online);
            available==Availability::Offline && m.due(now)
        };
        if !due {continue;}
        match recovery::automatic_eligibility(p) {
            Ok(v) if v["allowed"]==true=>{},
            Ok(v)=>{set_reason(&p.id,v["reason"].as_str().unwrap_or("phone-busy"));continue;},
            Err(_)=>{set_reason(&p.id,"bridge-offline");continue;}
        }
        // Persist before issuing a command so reloads cannot reset the retry budget.
        if let Ok(mut values)=store().lock(){values.entry(p.id.clone()).or_default().reserve(now);}
        if save().is_err(){set_reason(&p.id,"storage-error");continue;}
        match recovery::start_automatic(p.clone()) {
            Ok(job) if job["trigger"]!="automatic"=>{if let Ok(mut values)=store().lock(){values.entry(p.id.clone()).or_default().defer(now);}},
            Ok(_)=>{},Err(_)=>set_reason(&p.id,"start-failed"),
        }
    }
    let _=save();
}
pub(crate) fn spawn(state:Arc<Mutex<crate::State>>) {
    thread::spawn(move||{while !STOP.load(Ordering::Relaxed){tick(&state);for _ in 0..30 {if STOP.load(Ordering::Relaxed){return;}thread::sleep(Duration::from_secs(1));}}});
}
pub(crate) fn shutdown(){STOP.store(true,Ordering::Relaxed);}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn brief_disconnect_does_not_trigger_but_sustained_one_does(){let mut m=Monitor::default();m.observe(1_000,false);assert!(!m.due(90_999));assert!(m.due(91_000));}
    #[test] fn cooldown_and_budget_survive_serialization(){let mut m=Monitor::default();m.observe(100,false);for now in [100_000,400_000,700_000]{assert!(m.due(now));m.reserve(now);assert!(!m.due(now+1));}let mut restored:Monitor=serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();assert!(!restored.due(9_000_000));assert_eq!(restored.reason,"exhausted");}
    #[test] fn busy_phone_refunds_race_without_burning_budget(){let mut m=Monitor::default();m.observe(1,false);m.reserve(100_000);m.defer(101_000);assert_eq!(m.attempts,0);assert!(!m.due(130_999));assert!(m.due(131_000));}
    #[test] fn online_resets_outage_but_keeps_cooldown(){let mut m=Monitor::default();m.observe(1,false);m.reserve(100_000);m.observe(101_000,true);assert_eq!(m.attempts,0);m.observe(102_000,false);assert!(!m.due(200_000));assert!(m.due(400_000));}
    #[test] fn clock_rollback_never_immediately_triggers(){let mut m=Monitor::default();m.observe(100_000,false);m.observe(10,true);m.observe(11,false);assert!(!m.due(100_000));}
    #[test] fn another_phone_or_unverified_metadata_cannot_mark_target_online(){
        let mut devices=crate::adb::parse("List of devices attached\n127.0.0.1:17354 device\nUSB-OTHER device\n").unwrap();
        devices[1].adb.as_mut().unwrap().hardware_identity=Some("OTHER".into());
        assert!(observed_availability(&devices,"TARGET","127.0.0.1:17354")==Availability::Offline);
        devices[0].adb.as_mut().unwrap().hardware_identity=Some("OTHER".into());
        assert!(observed_availability(&devices,"TARGET","127.0.0.1:17354")==Availability::Unauthorized);
        devices[1].adb.as_mut().unwrap().hardware_identity=Some("TARGET".into());
        assert!(observed_availability(&devices,"TARGET","127.0.0.1:17354")==Availability::Online);
    }
}
