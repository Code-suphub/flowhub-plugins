use base64::{engine::general_purpose::STANDARD,Engine as _};
use serde_json::{json,Value};
use std::{fs,io::Read,os::unix::fs::{DirBuilderExt,PermissionsExt},path::PathBuf,process::{Command,Stdio},time::{Duration,Instant}};
use ring::rand::{SecureRandom,SystemRandom};

// Base64 + JSON stays below the host's 4 MiB response limit.
const LIMIT:usize=2*1024*1024;
struct Capture(PathBuf);
impl Capture {
    fn new()->Result<Self,String>{
        let mut bytes=[0u8;16];SystemRandom::new().fill(&mut bytes).map_err(|_|"无法准备屏幕框选")?;
        let name=bytes.iter().map(|b|format!("{b:02x}")).collect::<String>();let path=std::env::temp_dir().join(format!("flowhub-qr-{name}"));
        fs::DirBuilder::new().mode(0o700).create(&path).map_err(|_|"无法准备屏幕框选")?;Ok(Self(path))
    }
    fn file(&self)->PathBuf{self.0.join("selection.png")}
}
impl Drop for Capture {fn drop(&mut self){let _=fs::remove_file(self.file());let _=fs::remove_dir(&self.0);}}
fn encoded(bytes:&[u8])->Result<String,String>{
    if bytes.len()>LIMIT{return Err("框选图片过大，请只框选二维码区域，或使用截图后粘贴".into());}
    if bytes.len()<24 || bytes[..8]!=[137,80,78,71,13,10,26,10]{return Err("无法读取框选图片，请重试或截图后粘贴".into());}
    let width=u32::from_be_bytes(bytes[16..20].try_into().unwrap());let height=u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width==0 || height==0 || width>8192 || height>8192 || u64::from(width)*u64::from(height)>20_000_000{return Err("框选范围过大，请缩小到二维码区域".into());}
    Ok(STANDARD.encode(bytes))
}
#[cfg(target_os="macos")]
fn permission()->bool{
    #[link(name="CoreGraphics",kind="framework")]
    extern "C" {fn CGPreflightScreenCaptureAccess()->bool;fn CGRequestScreenCaptureAccess()->bool;}
    unsafe{CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()}
}
pub fn capture(p:&Value)->Result<Value,String>{
    if p["confirmed"]!=true{return Err("请点击扫描屏幕并确认框选区域".into());}
    #[cfg(not(target_os="macos"))]
    return Err("屏幕框选仅支持 macOS，请截图后粘贴".into());
    #[cfg(target_os="macos")]
    {
        if !permission(){return Err("需要 macOS 屏幕录制权限。请在系统设置中允许 FlowHub 后重试，或先截图再粘贴图片".into());}
        let capture=Capture::new()?;let file=capture.file();
        let mut child=Command::new("/usr/sbin/screencapture").args(["-i","-s","-x","-t","png"]).arg(&file).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_|"无法启动系统框选，请截图后粘贴")?;
        let started=Instant::now();let status=loop{
            match child.try_wait(){Ok(Some(status))=>break status,Ok(None)=>{},Err(_)=>{let _=child.kill();let _=child.wait();return Err("无法读取系统框选结果，请重试".into());}}
            if started.elapsed()>Duration::from_secs(75){let _=child.kill();let _=child.wait();return Err("框选已超时，请重试".into());}
            std::thread::sleep(Duration::from_millis(40));
        };
        if !file.exists(){return Ok(json!({"cancelled":true}));}
        if !status.success(){return Err("系统框选未完成，请重试或截图后粘贴".into());}
        let meta=fs::symlink_metadata(&file).map_err(|_|"无法读取框选结果")?;
        if !meta.is_file() || meta.len()>LIMIT as u64{return Err("框选图片过大，请缩小到二维码区域".into());}
        fs::set_permissions(&file,fs::Permissions::from_mode(0o600)).map_err(|_|"无法保护框选图片")?;
        let mut bytes=Vec::new();fs::File::open(&file).and_then(|f|f.take((LIMIT+1) as u64).read_to_end(&mut bytes)).map_err(|_|"无法读取框选结果")?;
        Ok(json!({"image":encoded(&bytes)?}))
    }
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn requires_explicit_capture_without_touching_system_ui(){assert!(capture(&json!({})).unwrap_err().contains("点击"));}
    #[test]fn image_transport_limits_and_dimensions_are_checked(){
        let mut png=vec![0;24];png[..8].copy_from_slice(&[137,80,78,71,13,10,26,10]);png[16..20].copy_from_slice(&300u32.to_be_bytes());png[20..24].copy_from_slice(&300u32.to_be_bytes());
        assert_eq!(STANDARD.decode(encoded(&png).unwrap()).unwrap(),png);png[16..20].copy_from_slice(&9000u32.to_be_bytes());assert!(encoded(&png).is_err());assert!(encoded(&vec![0;LIMIT+1]).is_err());assert!(encoded(b"PRIVATE_BAD_IMAGE").is_err());
    }
    #[test]fn temporary_capture_directory_is_private_and_cleaned_on_error(){let folder;{let c=Capture::new().unwrap();folder=c.0.clone();assert_eq!(fs::metadata(&folder).unwrap().permissions().mode()&0o777,0o700);fs::write(c.file(),b"test").unwrap();}assert!(!folder.exists());}
}
