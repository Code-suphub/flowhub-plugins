use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs,
    io::{self, Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn read<T: DeserializeOwned>(root: &Path, filename: &str, limit: u64) -> io::Result<Option<T>> {
    let path = root.join(filename);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() || metadata.len() > limit {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid preference file"));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "preference file too large"));
    }
    Ok(Some(serde_json::from_slice(&bytes)?))
}

pub fn write(root: &Path, filename: &str, value: &impl Serialize) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if !root.exists() {
        fs::DirBuilder::new().recursive(true).mode(0o700).create(root)?;
    }
    let path = root.join(filename);
    if !fs::symlink_metadata(root)?.is_dir()
        || fs::symlink_metadata(&path).is_ok_and(|metadata| !metadata.is_file())
    {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid preference path"));
    }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let temporary = root.join(format!(".{filename}-{}-{stamp}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary)?;
    let result = file.write_all(&bytes).and_then(|_| file.sync_all()).and_then(|_| fs::rename(&temporary, &path));
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
