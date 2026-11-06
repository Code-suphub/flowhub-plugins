use super::*;
use otp::{OtpAlgorithm,Parameters};
use std::sync::atomic::{AtomicU64,Ordering};
static NEXT_TEMP:AtomicU64=AtomicU64::new(0);

const SECRET:&str="GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const URI:&str="otpauth://totp/Example:demo%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example&algorithm=SHA256&digits=8&period=60";
struct Temp(PathBuf);
impl Temp {fn new()->Self {Self(std::env::temp_dir().join(format!("flowhub-twofa-test-{}-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),NEXT_TEMP.fetch_add(1,Ordering::Relaxed))))}}
impl Drop for Temp {fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
fn account(secret:String,algorithm:OtpAlgorithm)->Entry {Entry::new("test".into(),None,secret,Parameters{algorithm,digits:8,period:30})}

#[test]
fn rfc6238_appendix_b_vectors_cover_all_algorithms_and_leading_zeroes(){
    // RFC 6238 Appendix B, public reference secrets; never user credentials.
    let rows=[
        (59,["94287082","46119246","90693936"]),
        (1_111_111_109,["07081804","68084774","25091201"]),
        (1_111_111_111,["14050471","67062674","99943326"]),
        (1_234_567_890,["89005924","91819424","93441116"]),
        (2_000_000_000,["69279037","90698825","38618901"]),
        (20_000_000_000,["65353130","77737706","47863826"]),
    ];
    for (algorithm,size,index) in [(OtpAlgorithm::Sha1,20,0),(OtpAlgorithm::Sha256,32,1),(OtpAlgorithm::Sha512,64,2)] {
        let bytes=b"1234567890".iter().copied().cycle().take(size).collect::<Vec<_>>();
        let entry=account(totp_rs::Secret::from(bytes).to_base32(),algorithm);
        for (at,expected) in rows{let (code,remaining)=generate(&entry,at).unwrap();assert_eq!(code,expected[index]);assert_eq!(remaining,30-at%30);}
    }
}
#[test]
fn legacy_json_defaults_and_secret_separators_keep_existing_codes(){
    let entry:Entry=serde_json::from_value(json!({"name":"legacy","secret":SECRET.to_lowercase()+"= =","issuer":null})).unwrap();
    assert_eq!(entry.parameters(),Parameters::default());assert_eq!(generate(&entry,59).unwrap(),("287082".into(),1));
    let short=Entry::new("short".into(),None,"AAAAAAAAAAAAAAAA".into(),Parameters::default());
    assert_eq!(legacy_secret(&short.secret).unwrap().len(),10);assert_eq!(generate(&short,59).unwrap().0.len(),6);
    assert!(legacy_secret("no!").is_err());assert!(legacy_secret("AAAA").is_err());
}
#[test]
fn uri_preview_has_only_metadata_and_creates_no_files(){
    let root=Temp::new();let result=dispatch_in(&root.0,"preview_import",&json!({"uri":URI})).unwrap();
    assert_eq!(result,json!({"name":"demo@example.com","issuer":"Example","algorithm":"SHA256","digits":8,"period":60}));
    assert!(!root.0.exists());assert!(!result.to_string().contains(SECRET));assert!(result.get("secret").is_none());
    let default=parse_import(&format!("otpauth://totp/Example%3Auser%252Fname?secret={SECRET}&issuer=Example")).unwrap();
    assert_eq!(default.name,"user%2Fname");assert_eq!(default.parameters(),Parameters::default());
}
#[test]
fn invalid_or_ambiguous_uris_are_rejected_without_echoing_secrets(){
    let inputs=[
        URI.replace("otpauth:","https:"),URI.replace("//totp/","//hotp/"),URI.replace("//totp/","//user:pass@totp/"),
        format!("{URI}#fragment"),format!("{URI}&secret=OTHERSECRET"),format!("{URI}&counter=1"),
        URI.replace("SHA256","MD5"),URI.replace("digits=8","digits=10"),URI.replace("period=60","period=0"),URI.replace("period=60","period=121"),
        URI.replace("issuer=Example","issuer=Another"),URI.replace(SECRET,"ABC"),URI.replace("%40","%ZZ"),URI.replace("%40","%00"),
        URI.replace("Example:demo","Example:bad\nname"),"x".repeat(8193),
    ];
    for input in inputs {let error=parse_import(&input).err().expect("must reject invalid URI");assert!(!error.contains(SECRET));assert!(!error.contains("otpauth://"));}
}
#[test]
fn import_is_encrypted_duplicates_never_overwrite_and_rename_preserves_parameters(){
    let root=Temp::new();dispatch_in(&root.0,"import",&json!({"uri":URI,"name":"Work"})).unwrap();
    let before=fs::read(root.0.join("twofa.secrets")).unwrap();let key_before=fs::read(root.0.join("twofa.key")).unwrap();
    assert!(!before.windows(SECRET.len()).any(|bytes|bytes==SECRET.as_bytes()));
    for file in ["twofa.key","twofa.secrets"]{assert_eq!(fs::metadata(root.0.join(file)).unwrap().permissions().mode()&0o777,0o600);}
    for (method,payload) in [("import",json!({"uri":URI,"name":"Work"})),("save",json!({"name":"Work","secret":SECRET}))] {assert!(dispatch_in(&root.0,method,&payload).is_err());assert_eq!(fs::read(root.0.join("twofa.secrets")).unwrap(),before);}
    dispatch_in(&root.0,"save",&json!({"name":"Renamed","previous":"Work","secret":"","issuer":"Example"})).unwrap();
    let entries=load(&root.0).unwrap();assert_eq!(entries.len(),1);assert_eq!(entries[0].name,"Renamed");assert_eq!(entries[0].period,60);assert_eq!(entries[0].digits,8);assert_eq!(entries[0].algorithm,OtpAlgorithm::Sha256);assert_eq!(entries[0].secret,SECRET);
    assert_eq!(fs::read(root.0.join("twofa.key")).unwrap(),key_before);
    let response=dispatch_in(&root.0,"code",&json!({"name":"Renamed"})).unwrap();assert_eq!(response["code"].as_str().unwrap().len(),8);assert_eq!(response["period"],60);
    let listed=dispatch_in(&root.0,"list",&json!({})).unwrap();assert!(!listed.to_string().contains(SECRET));assert!(listed["accounts"][0].get("secret").is_none());
    assert!(dispatch_in(&root.0,"save",&json!({"name":"X","previous":"missing","secret":SECRET})).is_err());
}
#[test]
fn an_existing_v1_encrypted_file_loads_without_rewriting_and_keeps_its_key(){
    let root=Temp::new();fs::create_dir_all(&root.0).unwrap();let key=key(&root.0,true).unwrap();
    let mut cipher=format!(r#"[{{"name":"Legacy","secret":"{SECRET}","issuer":"Old"}}]"#).into_bytes();
    key.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key([7;12]),aead::Aad::from(b"flowhub-twofa-v1"),&mut cipher).unwrap();
    let path=root.0.join("twofa.secrets");let bytes=[vec![7;12],cipher].concat();let mut file=OpenOptions::new().create_new(true).write(true).mode(0o600).open(&path).unwrap();file.write_all(&bytes).unwrap();drop(file);
    let entry=load(&root.0).unwrap().remove(0);assert_eq!(generate(&entry,59).unwrap().0,"287082");assert_eq!(entry.parameters(),Parameters::default());assert_eq!(fs::read(path).unwrap(),bytes);
}
#[test]
fn invalid_save_parameters_do_not_create_data_and_invalid_stored_parameters_cannot_panic(){
    let root=Temp::new();
    for invalid in [json!({"digits":10}),json!({"period":0}),json!({"period":"30"}),json!({"algorithm":"MD5"})]{let mut payload=json!({"name":"test","secret":SECRET});payload.as_object_mut().unwrap().extend(invalid.as_object().unwrap().clone());assert!(dispatch_in(&root.0,"save",&payload).is_err());}
    assert!(!root.0.exists());
    let mut entry=Entry::new("test".into(),None,SECRET.into(),Parameters::default());entry.period=0;assert!(generate(&entry,59).is_err());entry.period=30;entry.digits=10;assert!(generate(&entry,59).is_err());
}
