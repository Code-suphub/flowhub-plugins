use std::path::Path;
pub(crate) fn write_json_atomic(path: &Path, value: &serde_json::Value) -> Result<(),String> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let temp = path.with_extension("tmp");
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&temp).map_err(|e|e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(value).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    file.sync_all().map_err(|e|e.to_string())?;
    std::fs::rename(temp,path).map_err(|e|e.to_string())
}
