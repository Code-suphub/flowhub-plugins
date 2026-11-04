use super::*;
use std::collections::{BTreeMap, BTreeSet};

fn size_bytes(value: &str) -> Option<u64> {
    let split = value.find(|c: char| c.is_ascii_alphabetic())?;
    let size = value[..split].trim().parse::<f64>().ok()?;
    let multiplier = match value[split..].trim() {
        "B" => 1.,
        "kB" | "KB" => 1_000.,
        "MB" => 1_000_000.,
        "GB" => 1_000_000_000.,
        "TB" => 1_000_000_000_000.,
        _ => return None,
    };
    (size.is_finite() && size >= 0.).then_some((size * multiplier) as u64)
}

fn targets(usage: &[Value], images: &[Value]) -> Result<Vec<Value>, String> {
    let mut rows = BTreeMap::<String, (u64, String)>::new();
    for row in usage {
        let iid = management::image_id(&json!({"id":row["ID"]}))?.to_string();
        let containers = row["Containers"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok())
            .ok_or("无法核对镜像的容器引用数量，请刷新重试")?;
        let size = row["Size"].as_str().unwrap_or("未知").to_string();
        rows.entry(iid)
            .and_modify(|(count, _)| *count = (*count).max(containers))
            .or_insert((containers, size));
    }
    let mut result = Vec::new();
    for (iid, (containers, size)) in rows {
        if containers != 0 {
            continue;
        }
        let mut references = BTreeSet::new();
        for image in images.iter().filter(|row| row["ID"] == iid) {
            let repository = image["Repository"].as_str().unwrap_or("");
            let tag = image["Tag"].as_str().unwrap_or("");
            if repository.is_empty() || repository == "<none>" {
                continue;
            }
            if !tag.is_empty() && tag != "<none>" {
                references.insert(format!("{repository}:{tag}"));
            }
            if let Some(digest) = image["Digest"]
                .as_str()
                .filter(|s| s.starts_with("sha256:"))
            {
                references.insert(format!("{repository}@{digest}"));
            }
        }
        // A missing row can indicate an image was removed between the two reads.
        if !images.iter().any(|row| row["ID"] == iid) {
            return Err("镜像列表已变化，请重新预览清理目标".into());
        }
        result.push(json!({"id":iid,"references":references,"size":size}));
    }
    Ok(result)
}

async fn images(context: &str) -> Result<Vec<Value>, String> {
    lines(
        &docker(
            context,
            &[
                "image",
                "ls",
                "--all",
                "--digests",
                "--no-trunc",
                "--format",
                "{{json .}}",
            ],
        )
        .await?,
    )
}

async fn preview(context: &str) -> Result<Value, String> {
    // Ask the engine for counts including stopped containers, without reading
    // container configuration, volume metadata or build cache details.
    let raw = docker(
        context,
        &["system", "df", "--verbose", "--format", "{{json .Images}}"],
    )
    .await?;
    let usage: Option<Vec<Value>> =
        serde_json::from_str(raw.trim()).map_err(|_| "无法读取镜像空间与引用信息")?;
    let usage = usage.unwrap_or_default();
    let targets = targets(&usage, &images(context).await?)?;
    let total = targets.iter().try_fold(0_u64, |sum, row| {
        sum.checked_add(size_bytes(row["size"].as_str()?)?)
    });
    Ok(json!({"context":context,"targets":targets,"totalBytes":total}))
}

fn valid_confirmation(p: &Value) -> bool {
    let Some(targets) = p["targets"].as_array().filter(|rows| !rows.is_empty()) else {
        return false;
    };
    let ids: BTreeSet<_> = targets
        .iter()
        .filter_map(|row| management::image_id(row).ok())
        .collect();
    ids.len() == targets.len()
}

pub async fn dispatch(method: &str, p: &Value) -> Result<Value, String> {
    let execute = method == "image_prune_confirm";
    if execute && p["confirmed"] != true {
        return Err("请先确认清理未使用镜像".into());
    }
    if execute && !valid_confirmation(p) {
        return Err("无效的清理目标，请重新预览".into());
    }
    let _guard = COLLECT_LOCK.lock().await;
    let context = local_context().await?;
    if p["context"].as_str() != Some(context.as_str()) {
        return Err("Docker 环境已变化，请重新预览清理目标".into());
    }
    let plan = preview(&context).await?;
    if !execute {
        return Ok(plan);
    }
    if plan["targets"] != p["targets"] {
        return Err("清理目标或镜像引用已变化，请取消后重新预览".into());
    }
    // --force only skips Docker's interactive prompt. The engine still protects
    // images referenced by any container, including containers created meanwhile.
    let output = docker(&context, &["image", "prune", "--all", "--force"]).await?;
    let after = images(&context)
        .await
        .map_err(|e| format!("清理已提交，但结果无法核实，请刷新：{e}"))?;
    let targets = plan["targets"].as_array().unwrap();
    let remaining = targets
        .iter()
        .filter(|target| after.iter().any(|row| row["ID"] == target["id"]))
        .count();
    let reclaimed = output
        .lines()
        .find_map(|line| line.strip_prefix("Total reclaimed space:"))
        .map(str::trim);
    Ok(json!({"removed":targets.len() - remaining,"remaining":remaining,"reclaimed":reclaimed}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn iid(c: char) -> String {
        format!("sha256:{}", c.to_string().repeat(64))
    }
    #[test]
    fn protects_container_references_and_groups_tags_by_full_image_id() {
        let usage = vec![
            json!({"ID":iid('a'),"Containers":"0","Size":"1.2GB"}),
            json!({"ID":iid('a'),"Containers":"0","Size":"1.2GB"}),
            json!({"ID":iid('b'),"Containers":"1","Size":"10MB"}),
        ];
        let rows = vec![
            json!({"ID":iid('a'),"Repository":"test","Tag":"one","Digest":"<none>"}),
            json!({"ID":iid('a'),"Repository":"test","Tag":"two","Digest":"<none>"}),
            json!({"ID":iid('b'),"Repository":"used","Tag":"latest"}),
        ];
        let plan = targets(&usage, &rows).unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0]["references"], json!(["test:one", "test:two"]));
        assert_eq!(size_bytes("1.2GB"), Some(1_200_000_000));
        assert_eq!(size_bytes("0B"), Some(0));
        assert_eq!(size_bytes("N/A"), None);
        assert_eq!(size_bytes("-1MB"), None);
    }
    #[test]
    fn unknown_counts_or_missing_images_cannot_be_treated_as_unused() {
        assert!(targets(&[json!({"ID":iid('a'),"Containers":"N/A"})], &[]).is_err());
        assert!(targets(&[json!({"ID":iid('a'),"Containers":"0"})], &[]).is_err());
        let plan = targets(
            &[json!({"ID":iid('a'),"Containers":"0"})],
            &[json!({"ID":iid('a'),"Repository":"nginx","Tag":"<none>","Digest":iid('b')})],
        )
        .unwrap();
        assert_eq!(
            plan[0]["references"],
            json!([format!("nginx@{}", iid('b'))])
        );
        assert!(!valid_confirmation(&json!({"targets":[]})));
        assert!(!valid_confirmation(&json!({"targets":[{"id":"--all"}]})));
        assert!(!valid_confirmation(
            &json!({"targets":[{"id":iid('a')},{"id":iid('a')}]})
        ));
    }
    #[tokio::test]
    async fn confirmation_is_required_before_contacting_docker() {
        assert!(dispatch("image_prune_confirm", &json!({}))
            .await
            .unwrap_err()
            .contains("确认"));
        assert!(dispatch("image_prune_confirm", &json!({"confirmed":true}))
            .await
            .unwrap_err()
            .contains("目标"));
    }
}
