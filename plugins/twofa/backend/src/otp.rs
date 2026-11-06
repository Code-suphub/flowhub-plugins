use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use totp_rs::{Algorithm, Builder, Secret, Totp};

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Debug)]
pub enum OtpAlgorithm {
    #[default]
    #[serde(rename = "SHA1")]
    Sha1,
    #[serde(rename = "SHA256")]
    Sha256,
    #[serde(rename = "SHA512")]
    Sha512,
}
impl OtpAlgorithm {
    fn native(self) -> Algorithm { match self { Self::Sha1=>Algorithm::SHA1,Self::Sha256=>Algorithm::SHA256,Self::Sha512=>Algorithm::SHA512 } }
}
fn default_digits()->u8 {6}
fn default_period()->u64 {30}
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Debug)]
pub struct Parameters {pub algorithm:OtpAlgorithm,pub digits:u8,pub period:u64}
impl Default for Parameters {fn default()->Self {Self{algorithm:OtpAlgorithm::Sha1,digits:6,period:30}}}
impl Parameters {
    pub fn validate(self)->Result<Self,String>{
        if !(6..=8).contains(&self.digits) || !(15..=120).contains(&self.period){return Err("仅支持 6–8 位验证码、15–120 秒周期".into());}
        Ok(self)
    }
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Entry {
    pub name:String,pub secret:String,pub issuer:Option<String>,
    #[serde(default)] pub algorithm:OtpAlgorithm,
    #[serde(default="default_digits")] pub digits:u8,
    #[serde(default="default_period")] pub period:u64,
}
impl Entry {
    pub fn new(name:String,issuer:Option<String>,secret:String,params:Parameters)->Self {Self{name,issuer,secret,algorithm:params.algorithm,digits:params.digits,period:params.period}}
    pub fn parameters(&self)->Parameters {Parameters{algorithm:self.algorithm,digits:self.digits,period:self.period}}
    pub fn metadata(&self)->Value {json!({"name":self.name,"issuer":self.issuer,"algorithm":self.algorithm,"digits":self.digits,"period":self.period})}
}
pub fn valid_name(value:&str)->bool {!value.is_empty() && value.len()<=80 && !value.chars().any(char::is_control)}
pub fn valid_issuer(value:Option<&str>)->bool {value.is_none_or(|value|value.chars().count()<=120 && !value.chars().any(char::is_control))}

// Preserve the old accepted separators, padding and final partial bits. Existing
// encrypted accounts must generate the same bytes, including 80-bit secrets.
pub fn legacy_secret(value:&str)->Result<Vec<u8>,String>{
    let mut bits=0u32;let mut remaining=0u8;let mut bytes=Vec::new();
    for c in value.chars().filter(|c|*c!='-' && *c!=' ' && *c!='='){
        let upper=c.to_ascii_uppercase();let digit=match upper {'A'..='Z'=>upper as u8-b'A','2'..='7'=>upper as u8-b'2'+26,_=>return Err("TOTP 密钥必须是 Base32".into())};
        bits=(bits<<5)|u32::from(digit);remaining+=5;
        if remaining>=8{remaining-=8;bytes.push((bits>>remaining) as u8);}
    }
    if bytes.len()<10{return Err("TOTP 密钥过短".into());}Ok(bytes)
}
pub fn generate(entry:&Entry,at:u64)->Result<(String,u64),String>{
    let params=entry.parameters().validate()?;
    let secret=Secret::from(legacy_secret(&entry.secret)?);
    // Bounds and nonempty secret are validated above. The relaxed builder keeps
    // legacy 80-bit keys working instead of imposing a new storage migration.
    let totp=Builder::new().with_secret(secret).with_algorithm(params.algorithm.native()).with_digits(params.digits).with_step_duration(params.period).build_noncompliant();
    Ok((totp.generate(at).to_string(),params.period-at%params.period))
}
pub fn parameters(payload:&Value,previous:Option<&Entry>)->Result<Parameters,String>{
    let mut value=previous.map(Entry::parameters).unwrap_or_default();
    if let Some(algorithm)=payload.get("algorithm"){value.algorithm=serde_json::from_value(algorithm.clone()).map_err(|_|"仅支持 SHA1、SHA256、SHA512")?;}
    if let Some(digits)=payload.get("digits"){value.digits=digits.as_u64().and_then(|value|u8::try_from(value).ok()).ok_or("验证码位数无效")?;}
    if let Some(period)=payload.get("period"){value.period=period.as_u64().ok_or("验证码周期无效")?;}
    value.validate()
}
pub fn parse_import(raw:&str)->Result<Entry,String>{
    let invalid=||"验证器链接无效，请检查 TOTP 类型、账户、密钥和参数".to_string();
    let raw=raw.trim();
    if raw.len()>8192 || raw.chars().any(|c|c.is_control() || c.is_whitespace()){return Err(invalid());}
    let bytes=raw.as_bytes();
    for (index,byte) in bytes.iter().enumerate(){if *byte==b'%' && (index+2>=bytes.len() || !bytes[index+1].is_ascii_hexdigit() || !bytes[index+2].is_ascii_hexdigit()){return Err(invalid());}}
    let url=url::Url::parse(raw).map_err(|_|invalid())?;
    if url.scheme()!="otpauth" || url.host_str()!=Some("totp") || !url.username().is_empty() || url.password().is_some() || url.port().is_some() || url.fragment().is_some(){return Err(invalid());}
    let mut seen=HashSet::new();
    for (key,_) in url.query_pairs(){if !matches!(key.as_ref(),"secret"|"issuer"|"algorithm"|"digits"|"period") || !seen.insert(key.into_owned()){return Err(invalid());}}
    // Never forward upstream error strings: they may contain the input URI.
    let totp=Totp::from_url_unchecked(raw).map_err(|_|invalid())?;
    let algorithm=match totp.algorithm(){Algorithm::SHA1=>OtpAlgorithm::Sha1,Algorithm::SHA256=>OtpAlgorithm::Sha256,Algorithm::SHA512=>OtpAlgorithm::Sha512,_=>return Err(invalid())};
    let params=Parameters{algorithm,digits:totp.digits(),period:totp.step()}.validate()?;
    let name=totp.account_name().trim();let issuer=totp.issuer().map(str::trim).filter(|value|!value.is_empty());
    if !valid_name(name) || name.contains(':') || !valid_issuer(issuer) || issuer.is_some_and(|value|value.contains(':')){return Err(invalid());}
    let secret=totp.secret().to_base32();legacy_secret(&secret).map_err(|_|invalid())?;
    Ok(Entry::new(name.into(),issuer.map(str::to_owned),secret,params))
}
