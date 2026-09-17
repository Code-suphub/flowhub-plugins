//! OpenSSH is the source of truth; never store passwords or private-key contents.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

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
        if !token(&self.alias) || self.alias.contains(':') {return Err("SSH 别名无效：仅支持字母、数字、点、下划线和连字符，不能以连字符开头".into());}
        if self.hostname.is_empty() {return Err("请填写主机地址".into());}
        if !token(&self.hostname) {return Err("主机地址无效：请填写 IP 或主机名，不要填写协议或端口".into());}
        if self.user.is_empty() {return Err("请填写登录用户名，例如 root 或 ubuntu；输入框中的示例不是已填写的值".into());}
        if !token(&self.user) {return Err("登录用户名无效：不能包含空格或特殊符号".into());}
        if self.port == 0 {return Err("SSH 端口必须在 1–65535 之间".into());}
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
    fn managed_reads_only_untouched_flowhub_files() {
        let root = std::env::temp_dir().join(format!(
            "flowhub-managed-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir_all(root.join("flowhub.d")).unwrap();
        let profile = Profile {
            alias: "example".into(),
            hostname: "127.0.0.1".into(),
            user: "tester".into(),
            port: 2222,
            identity_file: "/tmp/key with spaces".into(),
            proxy_jump: String::new(),
        };
        assert!(managed(&root, "example").unwrap().is_none());
        let own = root.join("flowhub.d").join("example.conf");
        fs::write(&own, profile.text()).unwrap();
        let read_back = managed(&root, "example").unwrap().unwrap();
        assert_eq!(read_back.hostname, profile.hostname);
        assert_eq!(read_back.user, profile.user);
        assert_eq!(read_back.port, profile.port);
        assert_eq!(read_back.identity_file, profile.identity_file);
        // 手工改过的文件不能被静默覆盖，必须报错。
        fs::write(&own, format!("{}# hand edited\n", profile.text())).unwrap();
        assert!(managed(&root, "example").is_err());
        fs::remove_dir_all(&root).unwrap();
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
