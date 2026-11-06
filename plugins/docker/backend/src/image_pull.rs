use crate::{docker,docker_path,local_context,now};
use serde_json::{json,Value};
use std::{process::Stdio,sync::{Mutex,OnceLock},time::Duration};
use tokio::{io::{AsyncRead,AsyncReadExt},sync::watch};

struct Entry {value:Value,cancel:watch::Sender<bool>}
static JOB:OnceLock<Mutex<Option<Entry>>>=OnceLock::new();
static START:tokio::sync::Mutex<()>=tokio::sync::Mutex::const_new(());
fn jobs()->&'static Mutex<Option<Entry>>{JOB.get_or_init(||Mutex::new(None))}
fn update(id:&str,change:impl FnOnce(&mut Value)){if let Some(job)=jobs().lock().unwrap().as_mut(){if job.value["id"]==id{change(&mut job.value);job.value["updatedAt"]=json!(now());}}}

fn valid_path(part:&str)->bool {
    if part.is_empty() || !part.as_bytes()[0].is_ascii_alphanumeric() || !part.as_bytes()[part.len()-1].is_ascii_alphanumeric(){return false;}
    part.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b"._-".contains(&b)) && !part.contains("..")
}
fn reference(p:&Value)->Result<&str,String>{
    let value=p["reference"].as_str().unwrap_or("");
    if value.len()>255 || value.is_empty() || !value.is_ascii(){return Err("请填写带标签或 sha256 摘要的镜像名称".into());}
    let repository=if let Some((repo,digest))=value.split_once('@'){
        let hex=digest.strip_prefix("sha256:").unwrap_or("");if hex.len()!=64 || !hex.bytes().all(|b|b.is_ascii_hexdigit()){return Err("镜像摘要必须是完整的 sha256 值".into());}repo
    }else{
        let (repo,tag)=value.rsplit_once(':').ok_or("请明确填写镜像标签，例如 nginx:stable")?;
        if tag.is_empty() || tag.len()>128 || !tag.as_bytes()[0].is_ascii_alphanumeric() && tag.as_bytes()[0]!=b'_' || !tag.bytes().all(|b|b.is_ascii_alphanumeric()||b"_.-".contains(&b)){return Err("镜像标签无效".into());}repo
    };
    let parts:Vec<_>=repository.split('/').collect();
    if parts.iter().enumerate().any(|(index,part)|{
        if index==0 && parts.len()>1 && part.contains(':'){
            let Some((host,port))=part.split_once(':') else{return true;};!valid_path(host)||port.parse::<u16>().ok().filter(|p|*p>0).is_none()
        }else{!valid_path(part)}
    }){return Err("镜像名称无效，不接受网址、凭据或命令参数".into());}
    Ok(value)
}
fn platform(p:&Value)->Result<&str,String>{match p["platform"].as_str().unwrap_or(""){value @ (""|"linux/arm64"|"linux/amd64"|"linux/arm/v7")=>Ok(value),_=>Err("不支持的镜像平台".into())}}
fn status_line(line:&str)->Option<(String,String)>{
    let (layer,status)=line.trim().split_once(": ")?;
    if !(layer.len()==12 && layer.bytes().all(|b|b.is_ascii_hexdigit())){return None;}
    let label=if status.starts_with("Downloading"){"正在下载"}else if status.starts_with("Extracting"){"正在解压"}else{match status{"Pulling fs layer"=>"准备下载","Waiting"=>"等待中","Verifying Checksum"=>"校验中","Download complete"=>"下载完成","Pull complete"=>"拉取完成","Already exists"=>"本地已存在",_=>return None}};
    let detail=if status.starts_with("Downloading")||status.starts_with("Extracting") {status.split_whitespace().skip(1).filter(|value|value.len()<100 && value.bytes().all(|b|b.is_ascii_alphanumeric()||b"./[]=>%+-".contains(&b))).collect::<Vec<_>>().join(" ")}else{String::new()};
    Some((layer.into(),format!("{label} {detail}").trim().into()))
}
async fn progress(id:&str,mut stream:impl AsyncRead+Unpin)->Result<String,std::io::Error>{
    let mut chunk=[0u8;4096];let mut line=Vec::new();let mut errors=String::new();let mut overflow=false;
    loop {let count=stream.read(&mut chunk).await?;if count==0{break;}
        for byte in &chunk[..count]{
            if *byte==b'\n'||*byte==b'\r'{
                if !overflow {let text=String::from_utf8_lossy(&line);if let Some((layer,label))=status_line(&text){update(id,|job|{let rows=job["layers"].as_array_mut().unwrap();if let Some(row)=rows.iter_mut().find(|row|row["id"]==layer){row["status"]=json!(label);}else if rows.len()<32{rows.push(json!({"id":layer,"status":label}));}});}
                    errors.push_str(&text.to_ascii_lowercase());if errors.len()>8192{let start=errors.char_indices().find(|(index,_)|*index>=errors.len()-4096).map(|(i,_)|i).unwrap_or(0);errors.drain(..start);}}
                line.clear();overflow=false;
            }else if line.len()<2048{line.push(*byte);}else{overflow=true;}
        }
    }
    Ok(errors)
}
fn failure(text:&str)->&'static str {
    if text.contains("unauthorized")||text.contains("denied")||text.contains("authentication"){"镜像仓库拒绝访问，请先在终端登录该仓库后重试"}
    else if text.contains("not found")||text.contains("manifest unknown"){"镜像、标签或指定平台不存在，请核对后重试"}
    else {"镜像拉取失败，请检查引擎、仓库连接及可用磁盘空间后重试"}
}
async fn execute(id:String,context:String,reference:String,mut child:tokio::process::Child,mut cancelled:watch::Receiver<bool>){
    let stdout=child.stdout.take().unwrap();let stderr=child.stderr.take().unwrap();
    let outcome={let process=async{tokio::join!(child.wait(),progress(&id,stdout),progress(&id,stderr))};
        tokio::select!{result=process=>Some(result),_=cancelled.changed()=>None,_=tokio::time::sleep(Duration::from_secs(1800))=>None}};
    match outcome {
        None=>{let _=child.kill().await;let _=child.wait().await;let stopped=*cancelled.borrow();update(&id,|job|{job["state"]=json!(if stopped{"cancelled"}else{"failed"});job["error"]=json!(if stopped{"已停止本次 CLI 请求；引擎可能保留已下载的层，请刷新核对"}else{"拉取超过 30 分钟，已停止等待；请刷新核实引擎状态"});});}
        Some((Ok(status),Ok(out),Ok(err))) if status.success()=>{
            let result=docker(&context,&["image","inspect","--format","{{.Id}}",&reference]).await;
            let image=result.as_ref().ok().map(|s|s.trim()).filter(|s|s.starts_with("sha256:") && s.len()==71 && s[7..].bytes().all(|b|b.is_ascii_hexdigit()));
            update(&id,|job|{job["state"]=json!(if image.is_some(){"succeeded"}else{"failed"});job["imageId"]=json!(image);if image.is_none(){job["error"]=json!("拉取命令已结束，但无法核实本地镜像，请刷新核对");}});
            drop((out,err));
        }
        Some((_,out,err))=>{let message=format!("{} {}",out.unwrap_or_default(),err.unwrap_or_default());update(&id,|job|{job["state"]=json!("failed");job["error"]=json!(failure(&message));});}
    }
}
pub async fn dispatch(method:&str,p:&Value)->Result<Value,String>{
    if method=="image_pull_start"{
        let reference=reference(p)?.to_string();let platform=platform(p)?.to_string();if p["confirmed"]!=true{return Err("请先确认镜像拉取目标与影响".into());}
        let _guard=START.lock().await;
        if jobs().lock().unwrap().as_ref().is_some_and(|j|j.value["state"]=="running"){return Err("已有镜像拉取任务进行中，请先查看或停止该任务".into());}
        let context=local_context().await?;if p["context"].as_str()!=Some(&context){return Err("Docker 环境已变化，请刷新后重新确认".into());}
        let mut command=tokio::process::Command::new(docker_path()?);command.args(["--context",&context,"image","pull"]);
        if !platform.is_empty(){command.args(["--platform",&platform]);}
        let child=command.args(["--",&reference]).env_remove("DOCKER_HOST").env_remove("DOCKER_CONTEXT").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn().map_err(|_|"无法启动 Docker 拉取请求")?;
        let id=uuid::Uuid::new_v4().to_string();let (cancel,receiver)=watch::channel(false);
        let value=json!({"id":id,"context":context,"reference":reference,"platform":platform,"state":"running","layers":[],"error":null,"imageId":null,"updatedAt":now()});
        *jobs().lock().unwrap()=Some(Entry{value:value.clone(),cancel});tokio::spawn(execute(id,context,reference,child,receiver));return Ok(json!({"job":value}));
    }
    if !["image_pull_status","image_pull_cancel"].contains(&method){return Err("未知镜像拉取方法".into());}
    let mut guard=jobs().lock().unwrap();let Some(job)=guard.as_mut() else{return Ok(json!({"job":null}));};
    if p["context"]!=job.value["context"]{return if method=="image_pull_status" && p["id"].is_null(){Ok(json!({"job":null}))}else{Err("任务不属于当前 Docker 环境".into())};}
    if p["id"].is_string() && p["id"]!=job.value["id"]{return Err("拉取任务已变化，请重新打开任务".into());}
    if method=="image_pull_cancel"{if p["confirmed"]!=true || p["id"]!=job.value["id"]{return Err("请确认要停止的拉取任务".into());}if job.value["state"]=="running"{let _=job.cancel.send(true);}}
    Ok(json!({"job":job.value}))
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn references_and_platforms_are_explicit_and_not_shell_arguments(){
        for value in ["nginx:stable","ghcr.io/team/app:v1","localhost:5000/app:dev",&format!("ubuntu@sha256:{}","a".repeat(64))]{assert!(reference(&json!({"reference":value})).is_ok(),"{value}");}
        for value in ["nginx","--all-tags","https://registry/app:tag","user:password@registry/app:tag","app:tag;echo","App:tag","a/../app:tag","a:bad/tag"]{assert!(reference(&json!({"reference":value})).is_err(),"{value}");}
        assert!(platform(&json!({"platform":"--help"})).is_err());
    }
    #[test]fn progress_only_exposes_known_layer_metadata(){assert!(status_line("secret: credentials").is_none());assert!(status_line("aaaaaaaaaaaa: secret=PRIVATE").is_none());assert_eq!(status_line("aaaaaaaaaaaa: Pull complete").unwrap().1,"拉取完成");assert!(!failure("token=PRIVATE denied").contains("PRIVATE"));}
    #[tokio::test]async fn start_rejects_missing_confirmation_without_engine_access(){assert!(dispatch("image_pull_start",&json!({"reference":"nginx:stable"})).await.unwrap_err().contains("确认"));}
}
