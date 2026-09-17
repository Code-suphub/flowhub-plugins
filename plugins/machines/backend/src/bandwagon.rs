//! KiwiVM: query only getServiceInfo; never forward control actions or raw account data.
use serde_json::{json,Value};
fn number(v:&Value,key:&str)->Result<f64,String>{v[key].as_f64().or_else(||v[key].as_str()?.parse().ok()).filter(|n|n.is_finite()&&*n>=0.).ok_or_else(||format!("KiwiVM 返回的 {key} 无效"))}
fn normalize(data:&Value,veid:&str)->Result<Value,String>{
 if number(data,"error")?!=0.{return Err(format!("KiwiVM 查询失败（错误码 {}），请检查 VEID、API Key 或稍后重试",number(data,"error")?));}
 let multiplier=number(data,"monthly_data_multiplier")?;
 if multiplier<=0.{return Err("KiwiVM 流量倍率无效".into());}
 // KiwiVM reports both allowance and counter in raw accounting units.
 let total=number(data,"plan_monthly_data")?*multiplier;
 let used=number(data,"data_counter")?*multiplier;
 if total<=0.||!total.is_finite()||!used.is_finite(){return Err("KiwiVM 套餐流量无效".into());}
 let reset=number(data,"data_next_reset")?;
 let end=chrono::DateTime::from_timestamp(reset as i64,0).ok_or("KiwiVM 重置时间无效")?;
 Ok(json!({"provider":"bandwagon","at":chrono::Utc::now().to_rfc3339(),"rows":[{"InstanceId":veid,"TrafficPackageSet":[{"TrafficPackageTotal":total,"TrafficUsed":used,"TrafficPackageRemaining":(total-used).max(0.),"TrafficOverflow":(used-total).max(0.),"EndTime":end.to_rfc3339()}]}]}))
}
pub async fn query(config:&Value)->Result<Value,String>{
 let veid=config["veid"].as_str().ok_or("请保存 VEID")?;
 let key=config["apiKey"].as_str().ok_or("请保存 API Key")?;
 let body=url::form_urlencoded::Serializer::new(String::new()).append_pair("veid",veid).append_pair("api_key",key).finish();
 let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).build().map_err(|_|"无法创建 KiwiVM 客户端")?;
 let mut response=client.post("https://api.64clouds.com/v1/getServiceInfo").header("Content-Type","application/x-www-form-urlencoded").body(body).send().await.map_err(|_|"KiwiVM 请求失败，请检查网络")?.error_for_status().map_err(|e|format!("KiwiVM HTTP 错误：{}",e.status().map(|s|s.as_u16()).unwrap_or(0)))?;
 let mut bytes=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|_|"读取 KiwiVM 响应失败")?{if bytes.len()+chunk.len()>1048576{return Err("KiwiVM 响应过大".into());}bytes.extend_from_slice(&chunk);}
 let data:Value=serde_json::from_slice(&bytes).map_err(|_|"KiwiVM 响应不是有效 JSON")?;
 normalize(&data,veid)
}
#[cfg(test)]mod tests{use super::*;
 fn fixture()->Value{json!({"error":0,"plan_monthly_data":"1000","data_counter":250,"monthly_data_multiplier":0.5,"data_next_reset":4102444800i64,"email":"must-not-leak"})}
 #[test]fn allowance_and_usage_share_multiplier(){let v=normalize(&fixture(),"123").unwrap();let p=&v["rows"][0]["TrafficPackageSet"][0];assert_eq!(p["TrafficPackageTotal"],500.);assert_eq!(p["TrafficUsed"],125.);assert_eq!(p["TrafficPackageRemaining"],375.);assert!(!v.to_string().contains("must-not-leak"));}
 #[test]fn overflow_missing_fields_and_api_errors(){let mut v=fixture();v["data_counter"]=json!(1200);assert_eq!(normalize(&v,"1").unwrap()["rows"][0]["TrafficPackageSet"][0]["TrafficPackageRemaining"],0.);v["error"]=json!(1);v["message"]=json!("sensitive server message");assert!(!normalize(&v,"1").unwrap_err().contains("sensitive"));v=fixture();v["monthly_data_multiplier"]=Value::Null;assert!(normalize(&v,"1").is_err());}
}
