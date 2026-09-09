use base64::Engine;
pub(crate) fn verify(data: &[u8], signature: &str, pubkey: &str) -> Result<(), String> {
    let decode = |s: &str| String::from_utf8(base64::engine::general_purpose::STANDARD.decode(s.trim()).map_err(|e|e.to_string())?).map_err(|e|e.to_string());
    let key = minisign_verify::PublicKey::decode(&decode(pubkey)?).map_err(|e|e.to_string())?;
    let signature = minisign_verify::Signature::decode(&decode(signature)?).map_err(|e|e.to_string())?;
    key.verify(data,&signature,true).map_err(|e|e.to_string())
}
