use super::*;

pub(super) fn image_id(p: &Value) -> Result<&str, String> {
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
fn valid_image_reference(info: &Value, iid: &str, reference: &str) -> bool {
    let references: Vec<&str> = ["tags", "digests"].iter()
        .flat_map(|key| info[*key].as_array().into_iter().flatten())
        .filter_map(Value::as_str).collect();
    references.contains(&reference) || (references.is_empty() && reference == iid)
}
async fn image_info(context: &str, iid: &str) -> Result<Value, String> {
    // Creation time is optional in OCI image metadata. Go template field access
    // fails on an omitted key, whereas index safely returns null.
    let format = r#"{"id":{{json .Id}},"tags":{{json (index . "RepoTags")}},"digests":{{json (index . "RepoDigests")}},"created":{{json (index . "Created")}},"size":{{json .Size}},"os":{{json (index . "Os")}},"architecture":{{json (index . "Architecture")}}}"#;
    let raw = docker(context, &["image", "inspect", "--format", format, iid]).await?;
    serde_json::from_str(raw.trim()).map_err(|e| e.to_string())
}
fn known_creation_time(value: &str) -> bool {
    value.trim().get(..4).and_then(|year| year.parse::<u16>().ok()).is_some_and(|year| year > 1970)
}

fn normalize_image_dates(images: &mut [Value]) {
    for image in images {
        if !known_creation_time(image["CreatedAt"].as_str().unwrap_or("")) {
            image["CreatedAt"] = Value::Null;
            image["CreatedSince"] = json!("未提供创建时间");
        }
    }
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
                &["image", "ls", "--digests", "--no-trunc", "--format", "{{json .}}"],
            )
            .await?;
            let mut images = lines(&raw)?;
            normalize_image_dates(&mut images);
            Ok(json!({"context":context,"images":images}))
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
            if !valid_image_reference(&info, iid, reference) {
                return Err("镜像标签或摘要引用已变化，请刷新后重新确认".into());
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
                return Err("镜像引用指向已变化，请重新确认".into());
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
    #[test]
    fn image_removal_accepts_real_digest_references_but_rejects_placeholder_tags() {
        let iid = format!("sha256:{}", "a".repeat(64));
        let digest = format!("nginx@{iid}");
        let info = json!({"tags":[],"digests":[digest]});
        assert!(valid_image_reference(&info, &iid, &digest));
        assert!(!valid_image_reference(&info, &iid, "nginx:<none>"));
        assert!(!valid_image_reference(&info, &iid, "nginx:latest"));
        assert!(!valid_image_reference(&info, &iid, &iid));
        assert!(valid_image_reference(&json!({"tags":null,"digests":null}), &iid, &iid));
        assert!(valid_image_reference(&json!({"tags":["nginx:latest"]}), &iid, "nginx:latest"));
    }
    #[test]
    fn missing_and_epoch_image_dates_are_not_presented_as_image_age() {
        let mut images = vec![
            json!({"ID":"missing","CreatedSince":"56 years ago"}),
            json!({"ID":"epoch","CreatedAt":"1970-01-01 08:00:00 +0800 CST","CreatedSince":"56 years ago"}),
            json!({"ID":"zero","CreatedAt":"0001-01-01T00:00:00Z"}),
            json!({"ID":"valid","CreatedAt":"2026-10-27 12:00:00 +0800 CST","CreatedSince":"8 days ago"}),
        ];
        normalize_image_dates(&mut images);
        for row in &images[..3] {
            assert_eq!(row["CreatedSince"], "未提供创建时间");
            assert!(row["CreatedAt"].is_null());
        }
        assert_eq!(images[3]["CreatedSince"], "8 days ago");
    }
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
