//! Optional, user-initiated device photo selection from Wikimedia Commons.
//! No device names leave the Mac during normal scanning or rendering.
//! The plugin host already permits data:image/*; this module keeps network
//! fetching and persistent caching inside the native plugin's data directory.
use crate::Device;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const API_ROOT: &str = "https://commons.wikimedia.org/w/api.php?";
const IMAGE_ROOT: &str = "https://upload.wikimedia.org/wikipedia/commons/";
const MAX_API: usize = 320 * 1024;
const MAX_IMAGE: usize = 120 * 1024;
const MAX_SAVED: usize = 60;
const MAX_CANDIDATES: usize = 3;
const SEARCH_VALID_SECS: u64 = 300;
const USER_AGENT: &str = "FlowHub-DeviceCenter/0.3 (on-demand device imagery; https://github.com/Code-suphub/flowhub-plugins)";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedImage {
    file: String,
    title: String,
    author: String,
    license: String,
    source_url: String,
    mime: String,
}
struct Candidate {
    id: String,
    saved: SavedImage,
    bytes: Vec<u8>,
}
struct SearchSession {
    started: Instant,
    device_key: String,
    items: Vec<Candidate>,
}
pub(crate) struct ImageStore {
    dir: Option<PathBuf>,
    saved: BTreeMap<String, SavedImage>,
    sessions: HashMap<String, SearchSession>,
}

fn hash(value: &str) -> String {
    let mut h = 0xcbf29ce484222325_u64;
    for b in value.bytes() { h = (h ^ u64::from(b)).wrapping_mul(0x100000001b3); }
    format!("{h:016x}")
}
fn key(device: &Device) -> String {
    // Ignore USB physical port and serial; retain only category, model name and VID/PID.
    let name = device.name.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    hash(&format!("{}|{}|{}|{}", device.category, name,
        device.vendor.as_deref().unwrap_or("").to_lowercase(),
        device.product_id.as_deref().unwrap_or("").to_lowercase()))
}
fn safe_text(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_owned()
}
fn plain_html(s: &str) -> String {
    let mut in_tag = false;
    let mut out = String::new();
    for c in s.chars() {
        if c == '<' { in_tag = true; continue; }
        if c == '>' { in_tag = false; continue; }
        if !in_tag && !c.is_control() { out.push(c); }
    }
    safe_text(&out.replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'"), 150)
}
// Explicit network lookup never transmits USB/BT identifiers. Refuse to send
// custom device names containing obvious address, serial or account patterns.
fn search_model(name: &str) -> Result<String, String> {
    let model=safe_text(name,72);
    if model.chars().count()<3 || model.matches(':').count()>=4 ||
        model.contains('@') || model.to_ascii_lowercase().contains("serial") {
        return Err("设备名称可能包含私人标识，请先重命名设备再搜索".into());
    }
    for token in model.split_whitespace() {
        let token=token.trim_matches(|c:char| !c.is_ascii_alphanumeric());
        let digits=token.bytes().filter(|b|b.is_ascii_digit()).count();
        if token.len()>=10 && (digits>=8 ||
            token.bytes().all(|b|b.is_ascii_hexdigit())) {
            return Err("设备名称可能包含设备序列号，已阻止联网搜索".into());
        }
    }
    Ok(model)
}
fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for byte in s.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
fn allowed_url(url: &str) -> bool {
    url.starts_with(IMAGE_ROOT)
        && url.len() < 1400
        && !url.chars().any(|c| matches!(c, '?' | '#' | '\\' | '\r' | '\n' | '\t' | '@'))
        && !url.to_ascii_lowercase().contains("%2f")
        && !url.to_ascii_lowercase().contains("%5c")
        && !url.to_ascii_lowercase().contains("%00")
        && !url.contains("/../")
        && url.bytes().all(|b| b >= 0x21 && b <= 0x7e)
}
fn allowed_source(url: &str) -> bool {
    url.starts_with("https://commons.wikimedia.org/wiki/File:")
        && url.len() < 1500 && !url.chars().any(|c|c.is_control())
}
fn allowed_license(value: &str) -> bool {
    // License metadata is untrusted. Prefix checks accidentally accept
    // restricted variants such as "CC BY NC 4.0"; allow only known free
    // variants with exact version suffixes.
    let l = value.trim().to_ascii_uppercase().replace('_', " ");
    matches!(l.as_str(),
        "CC0" | "CC0 1.0" | "PUBLIC DOMAIN" | "PD" |
        "CC BY 1.0" | "CC BY 2.0" | "CC BY 2.5" |
        "CC BY 3.0" | "CC BY 4.0" |
        "CC BY-SA 1.0" | "CC BY-SA 2.0" | "CC BY-SA 2.5" |
        "CC BY-SA 3.0" | "CC BY-SA 4.0")
}
fn meta(info: &Value, field: &str) -> String {
    info.get("extmetadata")
        .and_then(|x| x.get(field))
        .and_then(|x| x.get("value"))
        .and_then(Value::as_str)
        .map(plain_html).unwrap_or_default()
}
fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 8 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") { Some("image/png") }
    else if bytes.len() >= 4 && bytes.starts_with(&[0xff, 0xd8, 0xff]) &&
        bytes.ends_with(&[0xff, 0xd9]) { Some("image/jpeg") }
    else { None }
}
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8;64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for three in bytes.chunks(3) {
        let a = three[0];
        let b = *three.get(1).unwrap_or(&0);
        let c = *three.get(2).unwrap_or(&0);
        result.push(char::from(TABLE[(a >> 2) as usize]));
        result.push(char::from(TABLE[(((a & 3) << 4) | (b >> 4)) as usize]));
        result.push(if three.len() > 1 { char::from(TABLE[(((b & 15) << 2) | (c >> 6)) as usize]) } else { '=' });
        result.push(if three.len() > 2 { char::from(TABLE[(c & 63) as usize]) } else { '=' });
    }
    result
}
fn data_url(bytes: &[u8]) -> Option<String> {
    let mime=sniff_image(bytes)?;
    Some(format!("data:{mime};base64,{}",base64(bytes)))
}
fn curl(url: &str, cap: usize, seconds: u64) -> Result<Vec<u8>, String> {
    if !(url.starts_with(API_ROOT) || allowed_url(url)) {
        return Err("只能访问预先批准的 Wikimedia 图片服务".into());
    }
    // -q MUST be curl's first argument: ignore ~/.curlrc, which could otherwise
    // silently disable TLS checks or re-enable redirects.
    let mut child = Command::new("/usr/bin/curl").args([
        "-q", "--silent", "--fail", "--show-error", "--proto", "=https",
        "--max-redirs", "0", "--compressed", "--connect-timeout", "3",
        "--user-agent", USER_AGENT,
        "--max-time", &seconds.to_string(),
        "--max-filesize", &cap.to_string(),
        "--output", "-", url,
    ]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|_| "无法启动安全图片下载器".to_string())?;
    let output = child.stdout.take().ok_or("无法读取图片下载结果")?;
    let reader = thread::spawn(move || {
        let mut bytes = vec![];
        let _ = output.take((cap + 1) as u64).read_to_end(&mut bytes);
        bytes
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < Duration::from_secs(seconds + 2) =>
                thread::sleep(Duration::from_millis(40)),
            _ => { let _ = child.kill(); let _ = child.wait(); break Err("图片服务请求超时".to_string()); }
        }
    };
    let bytes = reader.join().map_err(|_| "下载线程异常")?;
    let exit = status?;
    if !exit.success() || bytes.len()>cap { return Err("远程图片请求失败或超过大小限制".into()); }
    Ok(bytes)
}
fn json_catalog(raw: &Value) -> Vec<(SavedImage,String)> {
    let mut out=vec![];
    let Some(pages)=raw.pointer("/query/pages").and_then(Value::as_array) else { return out };
    for page in pages {
        if out.len()>=12 { break; }
        let Some(title)=page.get("title").and_then(Value::as_str) else {continue};
        if !title.starts_with("File:") {continue}
        let Some(info)=page.pointer("/imageinfo/0") else {continue};
        let license=meta(info,"LicenseShortName");
        if !allowed_license(&license) || meta(info,"NonFree").eq_ignore_ascii_case("true") {continue}
        let author=meta(info,"Artist");
        // Required attribution must not be dropped.
        if author.is_empty() && license.to_uppercase().starts_with("CC BY") {continue}
        let image_url=info.get("thumburl").and_then(Value::as_str).unwrap_or("");
        let source=info.get("descriptionurl").and_then(Value::as_str).unwrap_or("");
        if !allowed_url(image_url)||!allowed_source(source) {continue}
        let mime=info.get("thumbmime").and_then(Value::as_str).unwrap_or("");
        if !["image/png","image/jpeg"].contains(&mime) {continue}
        out.push((SavedImage {
            file:String::new(),
            title:safe_text(title.trim_start_matches("File:"),120),
            author,license,
            source_url:source.to_string(),
            mime:mime.to_string(),
        },image_url.to_string()));
    }
    out
}
impl ImageStore {
    pub(crate) fn new() -> Self {
        let dir=std::env::var_os("FLOWHUB_PLUGIN_DATA")
            .map(PathBuf::from).filter(|p| p.is_absolute()).map(|p|p.join("device-images"));
        let mut saved=BTreeMap::new();
        if let Some(path)=&dir {
            if fs::create_dir_all(path).is_ok() {
                if let Ok(bytes)=fs::read(path.join("mapping.json")) {
                    if bytes.len()<128*1024 {
                        if let Ok(found)=serde_json::from_slice::<BTreeMap<String,SavedImage>>(&bytes) {
                            for (id, entry) in found {
                                if id.len()==16 && id.bytes().all(|b|b.is_ascii_hexdigit()) &&
                                    valid_file(&entry.file) && saved.len()<MAX_SAVED {
                                    saved.insert(id,entry);
                                }
                            }
                        }
                    }
                }
            }
        }
        Self {dir,saved,sessions:HashMap::new()}
    }
    fn directory(&self) -> Result<&PathBuf,String> {
        self.dir.as_ref().ok_or("宿主未提供插件数据目录，无法缓存图片".into())
    }
    fn persist(&self, data:&BTreeMap<String,SavedImage>) -> Result<(),String> {
        let folder=self.directory()?;
        fs::create_dir_all(folder).map_err(|_| "图片目录不可写")?;
        let filename=format!(".mapping-{}-{}.tmp",std::process::id(),now());
        let temp=folder.join(filename);
        let mut f=OpenOptions::new().create_new(true).write(true)
            .open(&temp).map_err(|_| "无法建立图片缓存索引")?;
        let payload=serde_json::to_vec(data).map_err(|_| "图片索引序列化失败")?;
        if let Err(e)=f.write_all(&payload).and_then(|_|f.sync_all()) {
            let _=fs::remove_file(&temp);
            return Err(format!("无法保存图片索引：{e}"));
        }
        fs::rename(&temp,folder.join("mapping.json")).map_err(|_| "无法提交图片索引")?;
        Ok(())
    }
    pub(crate) fn list(&self, devices:&[Device]) -> Value {
        let entries:Vec<_>=devices.iter().filter_map(|d|{
            self.saved.get(&key(d)).map(|s|json!({
                "deviceId":d.id,"title":s.title,"license":s.license,
                "author":s.author,"sourceUrl":s.source_url
            }))
        }).collect();
        json!({"selected":entries,"provider":"Wikimedia Commons","networkMode":"manual"})
    }
    pub(crate) fn get(&self, device:&Device) -> Result<Value,String> {
        let k=key(device);
        let Some(saved)=self.saved.get(&k) else {return Ok(json!({"deviceId":device.id,"dataUrl":null}))};
        let file=self.directory()?.join(&saved.file);
        let bytes=fs::read(file).map_err(|_|"图片缓存丢失，可重新搜索或恢复默认图标")?;
        if bytes.len()>MAX_IMAGE||sniff_image(&bytes)!=Some(saved.mime.as_str()) {
            return Err("图片缓存格式无效".into());
        }
        Ok(json!({"deviceId":device.id,"dataUrl":data_url(&bytes),
            "title":saved.title,"license":saved.license,"author":saved.author,
            "sourceUrl":saved.source_url}))
    }
    pub(crate) fn search(&mut self, device:&Device) -> Result<Value,String> {
        self.directory()?;
        let model=search_model(&device.name)?;
        // Only an explicit button click invokes this method. The device name
        // is the only device-derived field transmitted to Wikimedia Commons.
        let query=model.clone();
        let url=format!("{API_ROOT}action=query&format=json&formatversion=2&generator=search&gsrnamespace=6&gsrlimit=12&gsrsearch={}&prop=imageinfo&iiprop=url%7Cmime%7Cthumbmime%7Cextmetadata&iiurlwidth=160&iiextmetadatafilter=LicenseShortName%7CArtist%7CNonFree",url_encode(&query));
        let raw=curl(&url,MAX_API,10)?;
        let parsed:Value=serde_json::from_slice(&raw).map_err(|_| "图片服务返回了无法识别的格式")?;
        let mut candidates=vec![];
        for (metadata,link) in json_catalog(&parsed) {
            if candidates.len()>=MAX_CANDIDATES {break;}
            let Ok(bytes)=curl(&link,MAX_IMAGE,8) else {continue};
            if sniff_image(&bytes)!=Some(metadata.mime.as_str()) {continue}
            let candidate_id=hash(&format!("{}|{}",metadata.source_url,candidates.len()));
            candidates.push(Candidate {id:candidate_id,saved:metadata,bytes});
        }
        let list:Vec<_>=candidates.iter().map(|c|json!({
            "id":c.id,"title":c.saved.title,"author":c.saved.author,
            "license":c.saved.license,"sourceUrl":c.saved.source_url,
            "dataUrl":data_url(&c.bytes)
        })).collect();
        self.sessions.retain(|_,s|s.started.elapsed()<Duration::from_secs(SEARCH_VALID_SECS));
        if self.sessions.len()>5 {self.sessions.clear();}
        self.sessions.insert(device.id.clone(),SearchSession { started:Instant::now(),device_key:key(device),items:candidates });
        Ok(json!({"provider":"Wikimedia Commons","query":model,"candidates":list,
            "hint":"图片可能不是确切型号，请自行核对后选择；授权与署名信息会随缓存保存。"}))
    }
    pub(crate) fn choose(&mut self, device:&Device, candidate_id:&str) -> Result<Value,String> {
        let session=self.sessions.get(&device.id).ok_or("候选图片已过期，请重新搜索")?;
        if session.started.elapsed()>Duration::from_secs(SEARCH_VALID_SECS) ||
            session.device_key!=key(device) {return Err("候选设备已改变，请重新搜索".into());}
        let selected=session.items.iter().find(|c|c.id==candidate_id)
            .ok_or("未找到所选择的候选图片")?;
        let k=key(device);
        if self.saved.len()>=MAX_SAVED && !self.saved.contains_key(&k) {
            return Err("本地图片缓存已达到 60 个设备上限".into());
        }
        let extension=if selected.saved.mime=="image/png"{"png"}else{"jpg"};
        let filename=format!("{k}.{extension}");
        let dir=self.directory()?;
        fs::create_dir_all(dir).map_err(|_|"图片目录不可写")?;
        // Never build a path from user-supplied URLs, titles, or device names.
        let tmp=dir.join(format!(".photo-{}-{}.tmp",k,now()));
        let mut f=OpenOptions::new().create_new(true).write(true)
            .open(&tmp).map_err(|_|"缓存图片创建失败")?;
        if let Err(error)=f.write_all(&selected.bytes).and_then(|_|f.sync_all()) {
            let _=fs::remove_file(&tmp);return Err(format!("图片保存失败：{error}"));
        }
        fs::rename(&tmp,dir.join(&filename)).map_err(|_|"保存图片失败")?;
        let mut next=self.saved.clone();
        let mut entry=selected.saved.clone();
        entry.file=filename.clone();
        next.insert(k.clone(),entry);
        self.persist(&next)?;
        self.saved=next;
        self.sessions.remove(&device.id);
        self.get(device)
    }
    pub(crate) fn remove(&mut self, device:&Device) -> Result<Value,String> {
        let mut next=self.saved.clone();
        let previous=next.remove(&key(device));
        self.persist(&next)?;
        self.saved=next;
        if let (Some(dir),Some(item))=(&self.dir,previous) {
            if valid_file(&item.file) {let _=fs::remove_file(dir.join(item.file));}
        }
        Ok(json!({"deviceId":device.id,"removed":true}))
    }
}
fn now()->u128 {SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()}
fn valid_file(name:&str)->bool {
    (name.ends_with(".png")||name.ends_with(".jpg")) &&
    name.len()==20 && name.as_bytes()[..16].iter().all(u8::is_ascii_hexdigit)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn device_named(name:&str)->Device {
        Device {id:"bt-001".into(), name:name.into(), category:"bluetooth".into(),
            kind:"headphones".into(), detail:String::new(), status:"connected".into(),
            battery:None,vendor:None,product_id:None, display_connection:None,
            pixel_resolution:None,logical_resolution:None,refresh_rate:None,native_display_id:None}
    }
    #[test]
    fn only_wikimedia_thumbnail_urls_are_downloadable() {
        assert!(allowed_url("https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/AirPods.jpg/160px-AirPods.jpg"));
        for s in ["http://upload.wikimedia.org/wikipedia/commons/a.jpg",
            "https://upload.wikimedia.org.evil.com/wikipedia/commons/a.jpg",
            "https://upload.wikimedia.org@127.0.0.1/wikipedia/commons/a.jpg",
            "https://upload.wikimedia.org/wikipedia/commons/a.jpg?redirect=https://bad",
            "https://upload.wikimedia.org/wikipedia/commons/%2fetc",
            "https://127.0.0.1/image.jpg"]
        {assert!(!allowed_url(s),"{s}");}
    }
    #[test]
    fn restrictive_license_variants_and_unapproved_downloads_are_rejected() {
        for license in [
            "CC BY NC 4.0", "CC BY-SA NC 4.0", "CC BY-SA 4.0 ND",
            "CC BY-NC 4.0", "CC BY-ND 3.0", "CC0 - noncommercial",
            "CC BY 5.0", "CC BY-SA 4.0; all rights reserved"
        ] {
            assert!(!allowed_license(license), "{license}");
        }
        for url in [
            "https://other.example.test/image.jpg",
            "http://commons.wikimedia.org/w/api.php",
            "https://upload.wikimedia.org.evil.test/wikipedia/commons/a.jpg",
            "https://127.0.0.1/a.png"
        ] {
            assert!(curl(url, MAX_IMAGE, 1).is_err(), "{url}");
        }
    }
    #[test]
    fn unknown_or_nonfree_licenses_are_rejected() {
        for license in ["All rights reserved","Fair use","","CC BY-NC 4.0","CC BY-ND 4.0"] {
            assert!(!allowed_license(license),"{license}");
        }
        for license in ["CC0","CC BY 4.0","CC BY-SA 4.0","Public Domain"] {
            assert!(allowed_license(license),"{license}");
        }
    }
    #[test]
    fn parse_catalog_requires_license_author_and_allowed_source() {
        let raw=json!({"query":{"pages":[
            {"title":"File:Mouse photo.jpg","imageinfo":[{
                "thumburl":"https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Mouse.jpg/160px-Mouse.jpg",
                "thumbmime":"image/jpeg","descriptionurl":"https://commons.wikimedia.org/wiki/File:Mouse_photo.jpg",
                "extmetadata":{"LicenseShortName":{"value":"CC BY-SA 4.0"},"Artist":{"value":"<span>Alice &amp; Bob</span>"}}}]},
            {"title":"File:Paid photo.jpg","imageinfo":[{
                "thumburl":"https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Paid.jpg/160px-Paid.jpg",
                "thumbmime":"image/jpeg","descriptionurl":"https://commons.wikimedia.org/wiki/File:Paid_photo.jpg",
                "extmetadata":{"LicenseShortName":{"value":"All rights reserved"},"Artist":{"value":"Alice"}}}]}
        ]}});
        let rows=json_catalog(&raw);
        assert_eq!(rows.len(),1);
        assert_eq!(rows[0].0.author,"Alice & Bob");
    }
    #[test]
    fn image_validation_and_base64_are_bounded() {
        assert_eq!(base64(b"Man"),"TWFu");
        assert_eq!(base64(b"M"),"TQ==");
        assert_eq!(base64(b"Ma"),"TWE=");
        assert!(sniff_image(b"<svg onload='evil'>").is_none());
        assert!(sniff_image(b"GIF89a").is_none());
        assert!(sniff_image(&[0xff,0xd8,0xff,0x00,0xff,0xd9]).is_some());
    }
    #[test]
    fn device_model_search_rejects_likely_identifiers() {
        for name in ["ABCDEF1234567890", "Serial SN 12345678901",
            "Jeff@Home", "AA:BB:CC:DD:EE:FF"] {
            assert!(search_model(name).is_err(),"{name}");
        }
        for name in ["DELL P2419H", "AirPods Pro 2", "Xiaomi Earphones Explore"] {
            assert!(search_model(name).is_ok(),"{name}");
        }
    }
    #[test]
    fn cache_data_url_reads_only_selected_png_and_keeps_attribution() {
        let folder=std::env::temp_dir().join(format!("flowhub-device-image-test-{}-{}",std::process::id(),now()));
        fs::create_dir_all(&folder).unwrap();
        let d=device_named("AirPods Pro 2");
        let k=key(&d);
        let filename=format!("{k}.png");
        let png=b"\x89PNG\r\n\x1a\nmock_thumbnail_data";
        fs::write(folder.join(&filename),png).unwrap();
        let record=SavedImage{file:filename,title:"Sample image".into(),author:"Alice".into(),
            license:"CC BY-SA 4.0".into(),source_url:"https://commons.wikimedia.org/wiki/File:Sample.png".into(),
            mime:"image/png".into()};
        let mut store=ImageStore{dir:Some(folder.clone()), saved:BTreeMap::new(), sessions:HashMap::new()};
        let mut entries=BTreeMap::new();
        entries.insert(k,record);
        store.persist(&entries).unwrap();
        store.saved=entries;
        let output=store.get(&d).unwrap();
        assert!(output["dataUrl"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(output["author"],"Alice");
        assert!(fs::read(folder.join("mapping.json")).unwrap().len()>20);
        let _=fs::remove_dir_all(folder);
    }
    #[test]
    fn choosing_and_removing_a_photo_works_offline_end_to_end() {
        let folder=std::env::temp_dir().join(format!("flowhub-image-choice-{}-{}",std::process::id(),now()));
        fs::create_dir_all(&folder).unwrap();
        let d=device_named("Magic Mouse");
        let chosen=Candidate {
            id:"0123456789abcdef".into(),
            saved:SavedImage{file:String::new(),title:"Magic Mouse.jpg".into(),
                author:"Alice".into(),license:"CC BY 4.0".into(),
                source_url:"https://commons.wikimedia.org/wiki/File:Magic_Mouse.jpg".into(),
                mime:"image/png".into()},
            bytes:b"\x89PNG\r\n\x1a\nmock_uploaded_image".to_vec()
        };
        let mut store=ImageStore {dir:Some(folder.clone()),
            saved:BTreeMap::new(), sessions:HashMap::new()};
        store.sessions.insert(d.id.clone(),SearchSession {
            started:Instant::now(),device_key:key(&d),items:vec![chosen]
        });
        let selected=store.choose(&d,"0123456789abcdef").unwrap();
        assert!(selected["dataUrl"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(selected["license"],"CC BY 4.0");
        assert_eq!(store.list(&[d.clone()])["selected"].as_array().unwrap().len(),1);
        store.remove(&d).unwrap();
        assert!(store.get(&d).unwrap()["dataUrl"].is_null());
        assert!(store.list(&[d])["selected"].as_array().unwrap().is_empty());
        let _=fs::remove_dir_all(folder);
    }
    #[test]
    fn photo_key_follows_model_not_usb_port_id() {
        let mut a=device_named("AirPods Pro 2");
        let mut b=a.clone();
        a.id="bluetooth-123".into(); b.id="bluetooth-789".into();
        assert_eq!(key(&a),key(&b));
        b.name="AirPods Pro 3".into();
        assert_ne!(key(&a),key(&b));
    }
}
