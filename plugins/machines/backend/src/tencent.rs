//! Per-machine Lighthouse credentials are stored only in the existing encrypted vault.
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use ring::hmac;
use std::path::Path;
fn account(host:&str)->String{format!("tencent-traffic:{host}")}
fn load(root:&Path,host:&str)->Result<Value,String>{serde_json::from_slice(&crate::vault::read(root,&account(host))?).map_err(|_|"腾讯云配置损坏".into())}
pub fn read(root:&Path,host:&str)->Value{match load(root,host){Ok(v)=>json!({"configured":true,"region":v["region"],"instanceId":v["instanceId"]}),Err(_)=>json!({"configured":false})}}
pub fn save(root:&Path,host:&str,p:&Value)->Result<Value,String>{
 let mut v=p.clone(); let old=load(root,host).unwrap_or(Value::Null);
 for k in ["secretId","secretKey","token"]{if v[k].as_str().unwrap_or("").is_empty(){v[k]=old[k].clone();}}
 if p["clearToken"]==true{v["token"]=json!("");}
 for k in ["secretId","secretKey","region","instanceId"]{if v[k].as_str().unwrap_or("").trim().is_empty(){return Err(format!("请填写 {k}"));}}
 if !v["instanceId"].as_str().unwrap().starts_with("lhins-"){return Err("请选择轻量实例 ID（lhins- 开头）".into());}
 if v.to_string().len()>16384{return Err("腾讯云配置过长".into());}
 crate::vault::save(root,&account(host),&serde_json::to_vec(&v).map_err(|e|e.to_string())?)?;
 Ok(read(root,host))
}
fn mac(key:&[u8],text:&str)->Vec<u8>{hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256,key),text.as_bytes()).as_ref().to_vec()}
fn hash(s:&str)->String{format!("{:x}",Sha256::digest(s.as_bytes()))}
pub async fn query(root:&Path,host:&str)->Result<Value,String>{
 let v=load(root,host).map_err(|_|"请先保存腾讯云配置")?;
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
#[test]fn excludes_expired_and_future_packages_but_keeps_exhausted(){let data=json!({"at":"test","rows":[{"TrafficPackageSet":[{"TrafficPackageRemaining":0,"TrafficPackageTotal":300},{"TrafficPackageRemaining":100,"TrafficPackageTotal":100,"EndTime":"2000-01-01T00:00:00Z"},{"TrafficPackageRemaining":100,"TrafficPackageTotal":100,"StartTime":"2999-01-01T00:00:00Z"}]}]});let s=summary(&data);assert_eq!(s["remaining"],0.0);assert_eq!(s["total"],300.0);assert!(summary(&json!({"rows":[]}))["error"].is_string());}}
