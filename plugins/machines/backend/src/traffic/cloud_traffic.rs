//! Per-machine cloud credentials are stored only in the existing encrypted vault.
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use ring::hmac;
use std::path::Path;
// Retain the original vault account so existing Tencent credentials migrate in place.
fn account(host:&str)->String{format!("tencent-traffic:{host}")}
fn load(root:&Path,host:&str)->Result<Value,String>{serde_json::from_slice(&crate::data::vault::read(root,&account(host))?).map_err(|_|"云流量配置损坏".into())}
pub fn read(root:&Path,host:&str)->Value{match load(root,host){Ok(v)=>{let mut result=json!({"configured":true,"provider":provider(&v),"revision":v["revision"]});for k in ["veid","region","instanceId","packageId","site","serverId","netdataId","limitGB"]{result[k]=v[k].clone();}result},Err(_)=>json!({"configured":false})}}
pub fn save(root:&Path,host:&str,p:&Value)->Result<Value,String>{
 let old=load(root,host).unwrap_or(Value::Null);
 let selected=p["provider"].as_str().unwrap_or("tencent");
 let keys:Vec<&str>=match selected {
 "tencent"|"aliyun"|"aws"=>vec!["secretId","secretKey","region","instanceId","token"],
 "bandwagon"=>vec!["veid","apiKey"],
 "huawei"=>vec!["secretId","secretKey","packageId","site"],
 "linode"=>vec!["apiKey","region"],
 "vultr"=>vec!["apiKey"],
 "zgocloud"=>vec!["apiToken","serverId","limitGB"],
 "zgocloudCookie"=>vec!["cookie","xsrfToken","serverId","limitGB"],
 "localNet"=>vec!["netdataId","limitGB"],
 _=>return Err("不支持的云服务商".into())};
 let mut v=json!({"provider":selected,"revision":chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default().to_string()});
 for k in keys{let input=p[k].as_str().unwrap_or("").trim();let secret=["secretId","secretKey","token","apiKey","apiToken","cookie","xsrfToken"].contains(&k);
  let same_instance=selected!="bandwagon" || k!="apiKey" || p["veid"]==old["veid"];
  v[k]=if input.is_empty()&&secret&&provider(&old)==selected&&same_instance{old[k].clone()}else{json!(input)};
 }
 if selected=="bandwagon"{
  if !v["veid"].as_str().is_some_and(|s|!s.is_empty()&&s.len()<=20&&s.bytes().all(|b|b.is_ascii_digit())){return Err("VEID 应为数字实例 ID".into());}
  if v["apiKey"].as_str().unwrap_or("").is_empty(){return Err("请填写该实例的 KiwiVM API Key".into());}
 }else if selected=="tencent" {
  if p["clearToken"]==true{v["token"]=json!("");}
  for k in ["secretId","secretKey","region","instanceId"]{if v[k].as_str().unwrap_or("").trim().is_empty(){return Err(format!("请填写 {k}"));}}
  if !v["instanceId"].as_str().unwrap().starts_with("lhins-"){return Err("请选择轻量实例 ID（lhins- 开头）".into());}
 }else if selected=="zgocloud" {
  if v["apiToken"].as_str().unwrap_or("").is_empty(){return Err("请填写 API Token".into());}
  let id=v["serverId"].as_str().unwrap_or("");
  if id.is_empty()||!id.bytes().all(|b|b.is_ascii_digit()){return Err("serverId 应为数字".into());}
 }else if selected=="zgocloudCookie" {
  if v["cookie"].as_str().unwrap_or("").is_empty(){return Err("请填写 Cookie".into());}
  if v["xsrfToken"].as_str().unwrap_or("").is_empty(){return Err("请填写 XSRF Token".into());}
  let id=v["serverId"].as_str().unwrap_or("");
  if id.is_empty()||!id.bytes().all(|b|b.is_ascii_digit()){return Err("serverId 应为数字".into());}
 }else if selected=="localNet" {
  if v["netdataId"].as_str().unwrap_or("").is_empty(){return Err("请填写 Netdata 节点 ID".into());}
 }else{if p["clearToken"]==true{v["token"]=json!("");}crate::traffic::cloud_providers::validate(&v)?;}
 if v.to_string().len()>16384{return Err("云流量配置过长".into());}
 crate::data::vault::save(root,&account(host),&serde_json::to_vec(&v).map_err(|e|e.to_string())?)?;
 Ok(read(root,host))
}
fn provider(v:&Value)->&str{v["provider"].as_str().unwrap_or("tencent")}
fn find_netdata_in_state(root:&Path,id:&str)->Result<crate::monitoring::netdata::Instance,String>{
 let path=root.join("state.json");
 let bytes=std::fs::read(&path).map_err(|_|"插件配置 state.json 不存在。请先在 FlowHub 机器管理中接入 Netdata 节点")?;
 let data:Value=serde_json::from_slice(&bytes).map_err(|_|"插件配置格式损坏")?;
 let arr=data["netdata"].as_array().ok_or("插件尚未配置任何 Netdata 节点")?;
 for inst in arr{if inst["id"].as_str()==Some(id){
   return serde_json::from_value(inst.clone()).map_err(|_|"Netdata 节点配置格式无效".into());
 }}
 Err(format!("Netdata 节点 {id} 不存在"))
}
async fn local_traffic_dispatch(root:&Path,v:&Value)->Result<Value,String>{
 let netdata_id=v["netdataId"].as_str().ok_or("缺少 Netdata 节点 ID")?;
 let instance=find_netdata_in_state(root,netdata_id)?;
 let limit_gb=v["limitGB"].as_f64()
  .or_else(||v["limitGB"].as_str().and_then(|s|s.trim().parse::<f64>().ok()))
  .filter(|n|n.is_finite()&&*n>0.0).unwrap_or(0.0);
 crate::traffic::local_traffic::query(&instance,limit_gb).await
}
fn mac(key:&[u8],text:&str)->Vec<u8>{hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256,key),text.as_bytes()).as_ref().to_vec()}
fn hash(s:&str)->String{format!("{:x}",Sha256::digest(s.as_bytes()))}
pub async fn query(root:&Path,host:&str)->Result<Value,String>{
 let v=load(root,host).map_err(|_|"请先保存云流量配置")?;
 if provider(&v)=="bandwagon"{return crate::traffic::bandwagon::query(&v).await;}
 if provider(&v)=="zgocloud"||provider(&v)=="zgocloudCookie"{return crate::traffic::zgocloud::query(&v).await;}
 if provider(&v)=="localNet"{return local_traffic_dispatch(root,&v).await;}
 if provider(&v)!="tencent"{return crate::traffic::cloud_providers::query(&v).await;}
 let now=chrono::Utc::now();let timestamp=now.timestamp();let date=now.format("%Y-%m-%d").to_string();
 let body=json!({"InstanceIds":[v["instanceId"]],"Limit":100}).to_string();
 let canonical=format!("POST\n/\n\ncontent-type:application/json\nhost:lighthouse.tencentcloudapi.com\n\ncontent-type;host\n{}",hash(&body));
 let scope=format!("{date}/lighthouse/tc3_request");
 let secret=format!("TC3{}",v["secretKey"].as_str().ok_or("缺少密钥")?);
 let key=mac(&mac(&mac(secret.as_bytes(),&date),"lighthouse"),"tc3_request");
 let signature=mac(&key,&format!("TC3-HMAC-SHA256\n{timestamp}\n{scope}\n{}",hash(&canonical))).iter().map(|b|format!("{b:02x}")).collect::<String>();
 let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).build().map_err(|e|e.to_string())?;
 let mut req=client.post("https://lighthouse.tencentcloudapi.com").header("Content-Type","application/json").header("X-TC-Action","DescribeInstancesTrafficPackages").header("X-TC-Version","2020-03-24").header("X-TC-Region",v["region"].as_str().unwrap_or("")).header("X-TC-Timestamp",timestamp.to_string()).header("Authorization",format!("TC3-HMAC-SHA256 Credential={}/{scope}, SignedHeaders=content-type;host, Signature={signature}",v["secretId"].as_str().unwrap_or("")));
 if let Some(token)=v["token"].as_str().filter(|s|!s.is_empty()){req=req.header("X-TC-Token",token);}
 let response=req.body(body).send().await.map_err(|_|"腾讯云请求失败，请检查网络")?.error_for_status().map_err(|e|format!("腾讯云 HTTP 错误：{}",e.status().map(|s|s.as_u16()).unwrap_or(0)))?;
 let bytes=response.bytes().await.map_err(|_|"读取腾讯云响应失败")?;
 let data:Value=serde_json::from_slice(&bytes).map_err(|_|"腾讯云响应格式错误")?;
 if !data["Response"]["Error"].is_null(){return Err(format!("腾讯云：{}",data["Response"]["Error"]["Code"].as_str().unwrap_or("未知错误")));}
 let rows=data["Response"]["InstanceTrafficPackageSet"].as_array().ok_or("响应缺少流量包数据")?;
 Ok(json!({"rows":rows,"at":now.to_rfc3339()}))
}
#[cfg(test)]mod tests{use super::*;#[test]fn credentials_survive_reopen_without_returning_secrets(){let dir=std::env::temp_dir().join(format!("tc-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));std::fs::create_dir_all(&dir).unwrap();let p=json!({"secretId":"fixture-id","secretKey":"fixture-secret","region":"ap-shanghai","instanceId":"lhins-test"});save(&dir,"host1",&p).unwrap();assert!(!read(&dir,"host1").to_string().contains("fixture"));save(&dir,"host1",&json!({"region":"ap-singapore","instanceId":"lhins-next"})).unwrap();assert_eq!(load(&dir,"host1").unwrap()["secretKey"],"fixture-secret");assert!(!read(&dir,"host2")["configured"].as_bool().unwrap());std::fs::remove_dir_all(dir).unwrap();}}

pub fn summary(data:&Value)->Value{
 if data["provider"]=="localNet"{
  let used=data["rows"].as_array().into_iter().flatten().flat_map(|row|row["TrafficPackageSet"].as_array().into_iter().flatten()).filter_map(|p|p["TrafficUsed"].as_f64()).filter(|n|n.is_finite()&&*n>=0.).sum::<f64>();
  let total=data["rows"].as_array().into_iter().flatten().flat_map(|row|row["TrafficPackageSet"].as_array().into_iter().flatten()).filter_map(|p|p["TrafficPackageTotal"].as_f64()).filter(|n|n.is_finite()&&*n>0.).sum::<f64>();
  if total<=0.{return json!({"mode":"usage","used":used,"at":data["at"]});}
  let remaining=data["rows"].as_array().into_iter().flatten().flat_map(|row|row["TrafficPackageSet"].as_array().into_iter().flatten()).filter_map(|p|p["TrafficPackageRemaining"].as_f64()).filter(|n|n.is_finite()&&*n>=0.).sum::<f64>();
  return json!({"remaining":remaining,"total":total,"at":data["at"]});
 }
 if data["summary"].is_object(){return data["summary"].clone();}
 let now=chrono::Utc::now();let mut remaining=0f64;let mut total=0f64;let mut count=0;
 for row in data["rows"].as_array().into_iter().flatten(){for p in row["TrafficPackageSet"].as_array().into_iter().flatten(){
  let within=|key:&str|p[key].as_str().and_then(|s|chrono::DateTime::parse_from_rfc3339(s).ok());
  if within("StartTime").is_some_and(|t|t>now)||within("EndTime").is_some_and(|t|t<now){continue;}
  if let (Some(r),Some(t))=(p["TrafficPackageRemaining"].as_f64(),p["TrafficPackageTotal"].as_f64()){if r>=0.&&t>0.{remaining+=r;total+=t;count+=1;}}
 }}
 if count==0{return json!({"error":"暂无有效流量包"});}
 json!({"remaining":remaining,"total":total,"at":data["at"]})
}

#[cfg(test)]mod summary_tests{use super::*;
#[test]fn excludes_expired_and_future_packages_but_keeps_exhausted(){let data=json!({"at":"test","rows":[{"TrafficPackageSet":[{"TrafficPackageRemaining":0,"TrafficPackageTotal":300},{"TrafficPackageRemaining":100,"TrafficPackageTotal":100,"EndTime":"2000-01-01T00:00:00Z"},{"TrafficPackageRemaining":100,"TrafficPackageTotal":100,"StartTime":"2999-01-01T00:00:00Z"}]}]});let s=summary(&data);assert_eq!(s["remaining"],0.0);assert_eq!(s["total"],300.0);assert!(summary(&json!({"rows":[]}))["error"].is_string());}
#[test]fn local_net_without_limit_still_reports_usage(){let s=summary(&json!({"provider":"localNet","at":"test","rows":[{"TrafficPackageSet":[{"TrafficUsed":123456789,"TrafficPackageTotal":0}]}]}));assert_eq!(s["mode"],"usage");assert_eq!(s["used"],123456789.0);}}
#[cfg(test)]mod provider_tests{use super::*;
#[test]fn bandwagon_credentials_are_private_and_cannot_follow_changed_instance(){let dir=std::env::temp_dir().join(format!("cloud-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));std::fs::create_dir_all(&dir).unwrap();save(&dir,"h",&json!({"provider":"bandwagon","veid":"123","apiKey":"fixture-private"})).unwrap();let first=read(&dir,"h");assert_eq!(first["provider"],"bandwagon");assert!(!first.to_string().contains("fixture-private"));save(&dir,"h",&json!({"provider":"bandwagon","veid":"123","apiKey":""})).unwrap();assert_ne!(read(&dir,"h")["revision"],first["revision"]);assert_eq!(load(&dir,"h").unwrap()["apiKey"],"fixture-private");assert!(save(&dir,"h",&json!({"provider":"bandwagon","veid":"456"})).is_err());assert_eq!(read(&dir,"h")["veid"],"123");assert!(save(&dir,"h",&json!({"provider":"other"})).is_err());std::fs::remove_dir_all(dir).unwrap();}
}

#[cfg(test)]mod multi_provider_storage_tests{
 use super::*;
 #[test]fn new_providers_persist_public_fields_without_exposing_credentials(){
  let dir=std::env::temp_dir().join(format!("cloud-providers-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));std::fs::create_dir_all(&dir).unwrap();
  for provider in ["aliyun","huawei","linode","vultr","aws"]{
   let mut p=json!({"provider":provider,"secretId":"private-id","secretKey":"private-secret","apiKey":"private-token","region":"us-east-1","instanceId":"instance1","packageId":"package1","site":"cn"});
   save(&dir,provider,&p).unwrap();let before=read(&dir,provider);
   assert_eq!(before["provider"],provider);assert!(!before.to_string().contains("private"));
   p["secretId"]=json!("");p["secretKey"]=json!("");p["apiKey"]=json!("");save(&dir,provider,&p).unwrap();
   let stored=load(&dir,provider).unwrap();let key=if ["linode","vultr"].contains(&provider){"apiKey"}else{"secretKey"};assert!(stored[key].as_str().unwrap().starts_with("private"));
   let next=if provider=="vultr"{"linode"}else{"vultr"};assert!(save(&dir,provider,&json!({"provider":next})).is_err());assert_eq!(read(&dir,provider)["provider"],provider);
  }
  std::fs::remove_dir_all(dir).unwrap();
 }
}
