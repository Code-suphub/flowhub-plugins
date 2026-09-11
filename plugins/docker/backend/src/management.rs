use super::*;

fn image_id(p: &Value) -> Result<&str, String> {
    let value = p["id"].as_str().unwrap_or("");
    let hash = value.strip_prefix("sha256:").unwrap_or("");
    if hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(value)
    } else {
        Err("无效的镜像 ID".into())
    }
}
fn removable(state: &str) -> bool {
    matches!(state, "exited" | "created" | "dead")
}
async fn image_info(context: &str, iid: &str) -> Result<Value, String> {
    let format = r#"{"id":{{json .Id}},"tags":{{json .RepoTags}},"digests":{{json .RepoDigests}},"created":{{json .Created}},"size":{{json .Size}},"os":{{json .Os}},"architecture":{{json .Architecture}}}"#;
    let raw = docker(context, &["image", "inspect", "--format", format, iid]).await?;
    serde_json::from_str(raw.trim()).map_err(|e| e.to_string())
}
pub async fn dispatch(method: &str, p: &Value) -> Result<Value, String> {
    let deleting = matches!(method, "container_remove" | "image_remove");
    match method {
        "container_remove" => {
            id(p)?;
        }
        "image_detail" | "image_remove" => {
            image_id(p)?;
        }
        "images" => {}
        _ => return Err("不支持的管理操作".into()),
    }
    if deleting && p["confirmed"] != true {
        return Err("请先确认删除操作".into());
    }
    let _guard = COLLECT_LOCK.lock().await;
    let context = local_context().await?;
    if p["context"].as_str() != Some(context.as_str()) {
        return Err("Docker 环境已变化，请刷新后重新确认".into());
    }
    match method {
        "images" => {
            let raw = docker(
                &context,
                &["image", "ls", "--no-trunc", "--format", "{{json .}}"],
            )
            .await?;
            Ok(json!({"context":context,"images":lines(&raw)?}))
        }
        "image_detail" => {
            let iid = image_id(p)?;
            let mut info = image_info(&context, iid).await?;
            let raw = docker(
                &context,
                &[
                    "ps",
                    "-a",
                    "--no-trunc",
                    "--filter",
                    &format!("ancestor={iid}"),
                    "--format",
                    r#"{"id":{{json .ID}},"name":{{json .Names}},"state":{{json .State}}}"#,
                ],
            )
            .await?;
            info["containers"] = json!(lines(&raw)?);
            Ok(info)
        }
        "container_remove" => {
            let cid = id(p)?;
            let list = list_in_context(&context).await?;
            let row = list["containers"]
                .as_array()
                .and_then(|rows| rows.iter().find(|r| r["id"] == cid))
                .ok_or("容器已不存在，请刷新")?;
            if !removable(row["state"].as_str().unwrap_or("")) {
                return Err("请先停止容器，再确认删除；不会强制删除运行中的容器".into());
            }
            // No --force or --volumes: keep persistent data and let the engine guard races.
            docker(&context, &["container", "rm", cid]).await?;
            let after = list_in_context(&context).await?;
            *cache().write().unwrap() = status_data(&after, now());
            if after["containers"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|r| r["id"] == cid))
            {
                return Err("删除结果尚未确认，请刷新核实".into());
            }
            Ok(json!({"ok":true}))
        }
        "image_remove" => {
            let iid = image_id(p)?;
            let info = image_info(&context, iid).await?;
            let reference = p["reference"].as_str().ok_or("请选择镜像标签")?;
            let known_tag = info["tags"]
                .as_array()
                .is_some_and(|tags| tags.iter().any(|t| t == reference));
            let untagged = info["tags"].as_array().is_none_or(|tags| tags.is_empty());
            if !(known_tag || (untagged && reference == iid)) {
                return Err("镜像标签已变化，请刷新后重新确认".into());
            }
            let used = docker(
                &context,
                &["ps", "-a", "-q", "--filter", &format!("ancestor={iid}")],
            )
            .await?;
            if !used.trim().is_empty() {
                return Err("镜像仍被容器引用（包括已停止容器），不能删除".into());
            }
            if image_info(&context, reference).await?["id"] != iid {
                return Err("镜像标签指向已变化，请重新确认".into());
            }
            docker(&context, &["image", "rm", "--no-prune", reference]).await?;
            Ok(json!({"ok":true,"reference":reference}))
        }
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn deletion_requires_confirmation_and_full_identity() {
        for method in ["container_remove", "image_remove"] {
            assert!(dispatch(method, &json!({"id":"--force","confirmed":true}))
                .await
                .is_err());
            let iid = if method == "image_remove" {
                format!("sha256:{}", "a".repeat(64))
            } else {
                "a".repeat(64)
            };
            assert!(dispatch(method, &json!({"id":iid}))
                .await
                .unwrap_err()
                .contains("确认"));
        }
        assert!(!removable("running"));
        assert!(!removable("paused"));
        assert!(removable("exited"));
    }
}
