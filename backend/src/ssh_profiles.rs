//! OpenSSH is the source of truth; never store passwords or private-key contents.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
static SAVE_LOCK: Mutex<()> = Mutex::new(());
const HEADER: &str = "# FlowHub SSH profiles\nInclude flowhub.d/*.conf\nHost *\n";

// Discovery only reads config text. OpenSSH evaluates Host/Match when a user views
// a candidate or connects; scanning must never execute Match exec or contact hosts.
pub(crate) fn discover(root: &Path) -> serde_json::Value {
    use std::collections::{BTreeMap, HashSet};
    struct Scan<'a> {
        root: &'a Path,
        seen: HashSet<PathBuf>,
        hosts: BTreeMap<String, Vec<String>>,
        warnings: Vec<String>,
        bytes: usize,
        entries: usize,
    }
    impl Scan<'_> {
        fn read(&mut self, path: PathBuf, depth: usize) {
            if depth > 16 || self.seen.len() >= 128 || self.bytes >= 4 * 1024 * 1024 {
                if self.warnings.len() < 128 {
                    self.warnings
                        .push("已达到扫描上限（16 层、128 个文件、4 MiB）".into());
                }
                return;
            }
            let path = match path.canonicalize() {
                Ok(p) => p,
                Err(e) => {
                    self.warnings.push(format!("{}：{e}", path.display()));
                    return;
                }
            };
            if !self.seen.insert(path.clone()) {
                return;
            }
            let read = || -> Result<String, String> {
                let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
                if !metadata.is_file() || metadata.len() > 512 * 1024 {
                    return Err("非普通文件或超过 512 KiB".into());
                }
                let mut text = String::new();
                fs::File::open(&path)
                    .map_err(|e| e.to_string())?
                    .take(512 * 1024 + 1)
                    .read_to_string(&mut text)
                    .map_err(|e| e.to_string())?;
                if text.len() > 512 * 1024 {
                    return Err("文件超过读取上限".into());
                }
                Ok(text)
            };
            let text = match read() {
                Ok(t) => t,
                Err(e) => {
                    self.warnings.push(format!("{}：{e}", path.display()));
                    return;
                }
            };
            if self.bytes + text.len() > 4 * 1024 * 1024 {
                self.warnings
                    .push("配置总大小超过 4 MiB，已跳过文件".into());
                return;
            }
            self.bytes += text.len();
            for (line, value) in text.lines().enumerate() {
                let words = config_words(value);
                let Some(key) = words.first() else {
                    continue;
                };
                if key.eq_ignore_ascii_case("host") {
                    for alias in words.iter().skip(1) {
                        if alias.is_empty()
                            || alias.len() > 128
                            || alias.starts_with('-')
                            || !alias
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
                        {
                            continue;
                        }
                        if !self.hosts.contains_key(alias) && self.hosts.len() >= 500 {
                            continue;
                        }
                        self.hosts.entry(alias.clone()).or_default().push(format!(
                            "{}:{}",
                            path.display(),
                            line + 1
                        ));
                    }
                } else if key.eq_ignore_ascii_case("include") {
                    for pattern in words.iter().skip(1) {
                        let pattern = if let Some(rest) = pattern.strip_prefix("~/") {
                            self.root.parent().unwrap_or(self.root).join(rest)
                        } else {
                            self.root.join(pattern)
                        };
                        let matches = match glob::glob(&pattern.to_string_lossy()) {
                            Ok(g) => g,
                            Err(e) => {
                                self.warnings.push(format!("Include 模式无效：{e}"));
                                continue;
                            }
                        };
                        for included in matches {
                            self.entries += 1;
                            if self.entries > 2048 {
                                self.warnings
                                    .push("Include 匹配超过 2048 项，已停止".into());
                                return;
                            }
                            match included {
                                Ok(p) => self.read(p, depth + 1),
                                Err(e) => self.warnings.push(format!("Include 无法读取：{e}")),
                            }
                        }
                    }
                }
            }
        }
    }
    let mut scan = Scan {
        root,
        seen: HashSet::new(),
        hosts: BTreeMap::new(),
        warnings: Vec::new(),
        bytes: 0,
        entries: 0,
    };
    scan.read(root.join("config"), 0);
    serde_json::json!({"hosts": scan.hosts.into_iter().map(|(alias, sources)| serde_json::json!({"alias": alias, "sources": sources})).collect::<Vec<_>>(), "files": scan.seen.len(), "warnings": scan.warnings, "root": root.join("config").to_string_lossy()})
}
fn config_words(line: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut escaped = false;
    for c in line.chars() {
        if escaped {
            word.push(c);
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                word.push(c);
            }
            continue;
        }
        if c == '"' || c == '\'' {
            quote = Some(c);
            continue;
        }
        if c == '#' {
            break;
        }
        if c.is_whitespace()
            || (c == '=' && (words.is_empty() || words.len() == 1 && word.is_empty()))
        {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
        } else {
            word.push(c);
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Profile {
    pub alias: String,
    pub hostname: String,
    pub user: String,
    pub port: u16,
    pub identity_file: String,
    pub proxy_jump: String,
}
impl Profile {
    pub fn validate(&self) -> Result<(), String> {
        let token = |s: &str| {
            !s.is_empty()
                && s.len() <= 253
                && !s.starts_with('-')
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        };
        if !token(&self.alias)
            || self.alias.contains(':')
            || !token(&self.hostname)
            || !token(&self.user)
            || self.port == 0
        {
            return Err("别名、地址、用户名或端口无效".into());
        }
        if !self.proxy_jump.is_empty() && !token(&self.proxy_jump) {
            return Err("跳板机请填写本机 SSH 别名".into());
        }
        if !self.identity_file.is_empty()
            && (!(self.identity_file.starts_with('/') || self.identity_file.starts_with("~/"))
                || self.identity_file.len() > 1024
                || self
                    .identity_file
                    .chars()
                    .any(|c| c.is_control() || "\"\\%$".contains(c)))
        {
            return Err(
                "私钥路径需为绝对路径或 ~/ 路径，不能包含控制字符、引号、反斜杠或变量".into(),
            );
        }
        Ok(())
    }
    pub fn options(&self) -> Result<Vec<String>, String> {
        self.validate()?;
        let mut args = vec![
            "-o".into(),
            format!("HostName={}", self.hostname),
            "-o".into(),
            format!("User={}", self.user),
            "-p".into(),
            self.port.to_string(),
        ];
        if !self.identity_file.is_empty() {
            args.extend(["-i".into(), self.identity_file.clone()]);
        }
        if !self.proxy_jump.is_empty() {
            args.extend(["-J".into(), self.proxy_jump.clone()]);
        }
        Ok(args)
    }
    fn text(&self) -> String {
        let mut text = format!(
            "# Managed by FlowHub\nHost {}\n    HostName {}\n    User {}\n    Port {}\n",
            self.alias, self.hostname, self.user, self.port
        );
        if !self.identity_file.is_empty() {
            text += &format!("    IdentityFile \"{}\"\n", self.identity_file);
        }
        if !self.proxy_jump.is_empty() {
            text += &format!("    ProxyJump {}\n", self.proxy_jump);
        }
        text + "Host *\n"
    }
}
fn read(path: &Path) -> Result<String, String> {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e.to_string()),
    };
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("SSH 配置不是普通文件".into());
    }
    let mut bytes = Vec::new();
    file.take(1048577)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 1048576 {
        return Err("SSH 配置超过 1 MiB".into());
    }
    String::from_utf8(bytes).map_err(|e| e.to_string())
}
fn paths(root: &Path, alias: &str) -> Result<(PathBuf, PathBuf), String> {
    if alias.is_empty()
        || alias.starts_with('-')
        || alias.len() > 128
        || !alias
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err("图形化 SSH 别名仅支持字母、数字、点、下划线和连字符".into());
    }
    Ok((
        root.join("config"),
        root.join("flowhub.d").join(format!("{alias}.conf")),
    ))
}
pub(crate) fn revision(root: &Path, alias: &str) -> Result<String, String> {
    let (main, own) = paths(root, alias)?;
    Ok(format!(
        "{:x}",
        Sha256::digest(format!("{}\0{}", read(&main)?, read(&own)?).as_bytes())
    ))
}
pub(crate) fn managed(root: &Path, alias: &str) -> Result<Option<Profile>, String> {
    let (_, own) = paths(root, alias)?;
    let text = read(&own)?;
    if text.is_empty() {
        return Ok(None);
    }
    let mut p = Profile {
        alias: alias.into(),
        hostname: String::new(),
        user: String::new(),
        port: 22,
        identity_file: String::new(),
        proxy_jump: String::new(),
    };
    for line in text.lines() {
        let line = line.trim();
        if let Some((key, value)) = line.split_once(' ') {
            match key {
                "HostName" => p.hostname = value.trim().into(),
                "User" => p.user = value.trim().into(),
                "Port" => p.port = value.trim().parse().map_err(|_| "SSH 端口无效")?,
                "IdentityFile" => p.identity_file = value.trim().trim_matches('"').into(),
                "ProxyJump" => p.proxy_jump = value.trim().into(),
                _ => {}
            }
        }
    }
    p.validate()?;
    if p.text() != text {
        return Err(
            "FlowHub 管理的 SSH 文件已被手动修改，暂不自动覆盖；请保留修改并在终端编辑该文件"
                .into(),
        );
    }
    Ok(Some(p))
}
fn atomic(path: &Path, text: &str) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let temporary = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    ));
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes())
            .and_then(|_| f.sync_all())
            .map_err(|e| e.to_string())?;
        fs::rename(&temporary, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
pub(crate) fn save(root: &Path, profile: &Profile, expected: &str) -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;
    let _lock = SAVE_LOCK.lock().unwrap();
    profile.validate()?;
    let (main, own) = paths(root, &profile.alias)?;
    for path in [
        root.to_path_buf(),
        root.join("flowhub.d"),
        main.clone(),
        own.clone(),
    ] {
        if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("SSH 配置路径是符号链接，请在终端维护以避免替换链接".into());
        }
    }
    if revision(root, &profile.alias)? != expected {
        return Err("SSH 配置已被其他程序修改，请重新读取后保存".into());
    }
    managed(root, &profile.alias)?;
    let old = read(&main)?;
    if old.contains("# FlowHub SSH profiles") && !old.starts_with(HEADER) {
        return Err("FlowHub Include 位置已改变，请在终端检查 SSH 配置".into());
    }
    let new_dir = !root.exists();
    fs::create_dir_all(root.join("flowhub.d")).map_err(|e| e.to_string())?;
    if new_dir {
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    fs::set_permissions(root.join("flowhub.d"), fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    let added_include = !old.starts_with(HEADER);
    if added_include {
        if !old.is_empty() {
            atomic(
                &root.join(format!(
                    "config.flowhub-backup-{}",
                    chrono::Utc::now().timestamp_nanos_opt().unwrap()
                )),
                &old,
            )?;
        }
        if read(&main)? != old {
            return Err("SSH 主配置在保存时发生变化，请重新读取".into());
        }
        atomic(&main, &(HEADER.to_owned() + &old))?;
    }
    if let Err(error) = atomic(&own, &profile.text()) {
        if added_include && read(&main)? == HEADER.to_owned() + &old {
            atomic(&main, &old).map_err(|rollback| {
                format!("{error}；主配置恢复失败：{rollback}，请使用备份恢复")
            })?;
        }
        return Err(error);
    }
    revision(root, &profile.alias)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_follows_includes_without_execution_and_deduplicates() {
        let root = std::env::temp_dir().join(format!(
            "flowhub-discovery-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir_all(root.join("parts with spaces")).unwrap();
        fs::write(root.join("config"), "Host direct * !ignored\nInclude = \"parts with spaces/*.conf\"\nMatch exec \"touch should-not-run\"\nHost conditional\n").unwrap();
        fs::write(
            root.join("parts with spaces/a.conf"),
            "Host=\"included\" direct\nInclude config\nInclude missing*.conf\n",
        )
        .unwrap();
        fs::write(
            root.join("parts with spaces/b.conf"),
            "Host another\nInclude oversized.conf\n",
        )
        .unwrap();
        fs::write(root.join("oversized.conf"), vec![b'x'; 512 * 1024 + 1]).unwrap();
        let result = discover(&root);
        let hosts = result["hosts"].as_array().unwrap();
        assert_eq!(hosts.len(), 4);
        assert_eq!(
            hosts.iter().find(|h| h["alias"] == "direct").unwrap()["sources"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(hosts.iter().any(|h| h["alias"] == "included"));
        assert!(result["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w.as_str().unwrap().contains("512 KiB")));
        assert!(!root.join("should-not-run").exists());
        fs::remove_dir_all(&root).unwrap();
        assert!(!discover(&root)["warnings"].as_array().unwrap().is_empty());
    }
    #[test]
    fn preserves_original_and_rejects_stale_writes() {
        let root = std::env::temp_dir().join(format!(
            "flowhub-ssh-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let original =
            "ServerAliveInterval 9\nHost example\n  HostName old.example\n  User original\n";
        fs::write(root.join("config"), original).unwrap();
        let p = Profile {
            alias: "example".into(),
            hostname: "127.0.0.1".into(),
            user: "tester".into(),
            port: 2222,
            identity_file: "/tmp/key with spaces".into(),
            proxy_jump: String::new(),
        };
        let rev = revision(&root, &p.alias).unwrap();
        let next = save(&root, &p, &rev).unwrap();
        assert_eq!(
            read(&root.join("config")).unwrap(),
            HEADER.to_owned() + original
        );
        assert_eq!(
            managed(&root, "example").unwrap().unwrap().identity_file,
            p.identity_file
        );
        assert!(save(&root, &p, &rev).is_err());
        assert!(save(&root, &p, &next).is_ok());
        // Resolve using an isolated HOME-independent Include path; no SSH connection is made.
        let config = read(&root.join("config")).unwrap().replace(
            "flowhub.d/*.conf",
            &format!("{}/*.conf", root.join("flowhub.d").display()),
        );
        fs::write(root.join("test.conf"), config).unwrap();
        let output = std::process::Command::new("/usr/bin/ssh")
            .args(["-G", "-F"])
            .arg(root.join("test.conf"))
            .arg("example")
            .output()
            .unwrap();
        assert!(output.status.success());
        let out = String::from_utf8_lossy(&output.stdout);
        assert!(out.contains("hostname 127.0.0.1\n"));
        assert!(out.contains("user tester\n"));
        assert!(out.contains("serveraliveinterval 9\n"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_directive_injection() {
        let mut p = Profile {
            alias: "test".into(),
            hostname: "host".into(),
            user: "root".into(),
            port: 22,
            identity_file: String::new(),
            proxy_jump: String::new(),
        };
        p.user = "root\nProxyCommand evil".into();
        assert!(p.validate().is_err());
        p.user = "root".into();
        p.identity_file = "/tmp/a\"\nLocalCommand evil".into();
        assert!(p.validate().is_err());
        assert!(paths(Path::new("/tmp"), "../outside").is_err());
    }
}
