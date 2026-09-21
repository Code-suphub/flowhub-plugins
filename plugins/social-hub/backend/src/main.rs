use serde_json::{json,Value};
use std::{io::{self,BufRead},time::{SystemTime,UNIX_EPOCH}};
fn now()->u64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()}
fn conversations()->Vec<Value>{vec![json!({"id":"xhs-demo","platform":"xiaohongshu","platformName":"小红书","account":"演示账号","title":"关于商品尺码的咨询","contact":"林先生","preview":"请问这款还有其他颜色吗？","unread":2,"updatedAt":now()-180}),json!({"id":"goofish-demo","platform":"goofish","platformName":"闲鱼","account":"演示账号","title":"Mac mini 配置确认","contact":"买家小王","preview":"可以今天发货吗？","unread":1,"updatedAt":now()-720}),json!({"id":"douyin-demo","platform":"douyin","platformName":"抖音","account":"演示账号","title":"直播间私信","contact":"小陈","preview":"已收到，谢谢！","unread":0,"updatedAt":now()-3600})]}
fn dispatch(method:&str,p:&Value)->Value{match method{"health"=>json!({"protocol":1,"name":"social-hub","version":"0.1.0"}),"connectors"=>json!({"items":[{"id":"xiaohongshu","name":"小红书","mode":"待授权","available":false},{"id":"goofish","name":"闲鱼","mode":"通知/跳转","available":false},{"id":"douyin","name":"抖音","mode":"待配置 Client Key","available":true}]}),"authorize_url"=>{if p["platform"].as_str()!=Some("douyin"){return json!({"ok":false,"reason":"当前仅支持抖音官方 OAuth"})}let key=p["clientKey"].as_str().unwrap_or("").trim();let redirect=p["redirectUri"].as_str().unwrap_or("").trim();if key.is_empty()||redirect.is_empty(){return json!({"ok":false,"reason":"请填写 Client Key 和回调地址"})}let state=format!("flowhub-{}",now());json!({"ok":true,"url":format!("https://open.douyin.com/platform/oauth/connect/?client_key={}&response_type=code&scope=user_info&redirect_uri={}&state={}",urlencoding::encode(key),urlencoding::encode(redirect),state),"state":state})},"conversations"=>{let q=p["query"].as_str().unwrap_or("").to_lowercase();json!(conversations().into_iter().filter(|x|q.is_empty()||x.to_string().to_lowercase().contains(&q)).collect::<Vec<_>>())},"messages"=>json!({"conversationId":p["conversationId"],"items":[{"id":"m1","direction":"in","author":"对方","text":"你好，我想咨询一下商品详情。","createdAt":now()-300},{"id":"m2","direction":"out","author":"我","text":"可以的，我把详细信息发给你。","createdAt":now()-240}]}),"send"=>json!({"ok":false,"reason":"当前连接器未授权，已保留发送接口"}),_=>json!({"error":"未知操作"})}}
fn main(){for line in io::stdin().lock().lines().flatten(){if let Ok(req)=serde_json::from_str::<Value>(&line){let result=dispatch(req["method"].as_str().unwrap_or(""),&req["params"]);println!("{}",json!({"id":req["id"],"result":result}));}}}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_contract_is_explicit_and_send_stays_disabled() {
        let conversations = dispatch("conversations", &json!({"query": ""}));
        assert!(conversations.as_array().is_some_and(|items| !items.is_empty()));
        assert_eq!(conversations[0]["account"], "演示账号");

        let messages = dispatch("messages", &json!({"conversationId": "xhs-demo"}));
        assert_eq!(messages["conversationId"], "xhs-demo");
        assert!(messages["items"].as_array().is_some_and(|items| !items.is_empty()));

        let send = dispatch("send", &json!({"conversationId": "xhs-demo", "text": "不会发送"}));
        assert_eq!(send["ok"], false);
        assert!(send["reason"].as_str().is_some_and(|reason| reason.contains("未授权")));
    }

    #[test]
    fn only_douyin_authorization_returns_an_official_https_url() {
        let result = dispatch("authorize_url", &json!({
            "platform": "douyin",
            "clientKey": "demo",
            "redirectUri": "https://example.com/callback"
        }));
        assert_eq!(result["ok"], true);
        let url = result["url"].as_str().unwrap();
        assert!(url.starts_with("https://open.douyin.com/platform/oauth/connect/"));
        assert_eq!(dispatch("authorize_url", &json!({
            "platform": "xiaohongshu",
            "clientKey": "demo",
            "redirectUri": "https://example.com/callback"
        }))["ok"], false);
    }
}
