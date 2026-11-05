use super::*;

fn name(p: &Value) -> Result<&str, String> {
    let name = p["name"].as_str().unwrap_or("");
    if (2..=128).contains(&name.len())
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b)) {
        Ok(name)
    } else { Err("名称需为 2–128 位字母、数字、点、下划线或连字符，并以字母或数字开头".into()) }
}
fn network_id(p: &Value) -> Result<&str, String> { id(p).map_err(|_| "请使用完整的网络 ID".into()) }
fn confirmation(method: &str, p: &Value) -> Result<(), String> {
    if method.ends_with("_create") || method.ends_with("_remove") {
        if p["confirmed"] != true { return Err("请先确认资源操作".into()); }
        name(p)?;
        if method.ends_with("_remove") && p["typedName"] != p["name"] { return Err("请完整输入资源名称确认删除".into()); }
    }
    if method.ends_with("_create") && (p.get("options").is_some() || p.get("driver").is_some()) {
        return Err("新建仅使用本地默认驱动，不接受自定义驱动参数".into());
    }
    Ok(())
}
async fn inventory(context: &str) -> Result<Vec<Value>, String> {
    let rows = lines(&docker(context, &["ps", "-a", "--no-trunc", "--format", r#"{"id":{{json .ID}}}"#]).await?)?;
    let mut result = Vec::new();
    for batch in rows.chunks(128) {
        // Only mount and network references, never Config.Env or arbitrary labels.
        let format = r#"{"id":{{json .Id}},"name":{{json .Name}},"state":{{json .State.Status}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}},"project":{{json (index .Config.Labels "com.docker.compose.project")}}}"#;
        let mut args = vec!["inspect", "--type", "container", "--format", format];
        for row in batch { args.push(id(row)?); }
        let inspected = lines(&docker(context, &args).await?)?;
        if inspected.len() != batch.len() || batch.iter().any(|row| !inspected.iter().any(|info| info["id"] == row["id"])) {
            return Err("容器引用信息不完整，请刷新后重试".into());
        }
        if inspected.iter().any(|row| !row["mounts"].is_array() || !row["networks"].is_object() || !row["state"].is_string()) {
            return Err("容器引用信息无效，请刷新后重试".into());
        }
        result.extend(inspected);
    }
    Ok(result)
}
fn references(inventory: &[Value], kind: &str, key: &str) -> Vec<Value> {
    inventory.iter().filter_map(|row| {
        let volume = row["mounts"].as_array().and_then(|mounts| mounts.iter().find(|mount| mount["Type"] == "volume" && mount["Name"] == key));
        let attached = if kind == "volume" { volume.is_some() } else {
            row["networks"].as_object().is_some_and(|networks| networks.iter().any(|(name,network)| name == key || network["NetworkID"] == key))
        };
        attached.then(|| json!({"id":row["id"],"name":row["name"].as_str().unwrap_or("").trim_start_matches('/'),"state":row["state"],"project":row["project"],"destination":volume.map(|mount| &mount["Destination"]),"readOnly":volume.map(|mount| mount["RW"] == false)}))
    }).collect()
}
fn network_references(rows: &[Value], info: &Value) -> Vec<Value> {
    let mut result = references(rows,"network",info["id"].as_str().unwrap_or(""));
    for row in references(rows,"network",info["name"].as_str().unwrap_or("")) {
        if !result.iter().any(|current| current["id"] == row["id"]) { result.push(row); }
    }
    result
}
async fn volume_info(context: &str, name: &str) -> Result<Value, String> {
    let format = r#"{"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"createdAt":{{json .CreatedAt}},"mountpoint":{{json .Mountpoint}},"project":{{json (index .Labels "com.docker.compose.project")}}}"#;
    let raw = docker(context, &["volume", "inspect", "--format", format, name]).await?;
    serde_json::from_str(raw.trim()).map_err(|_| "卷信息无效，请刷新后重试".into())
}
fn volume_identity(info: &Value) -> Value {
    json!({"name":info["name"],"driver":info["driver"],"scope":info["scope"],"createdAt":info["createdAt"],"mountpoint":info["mountpoint"]})
}
fn volume_deletable(info: &Value) -> bool {
    info["driver"] == "local" && info["scope"] == "local"
        && info["createdAt"].as_str().is_some_and(|v| !v.is_empty())
        && info["mountpoint"].as_str().is_some_and(|v| !v.is_empty())
}
async fn volume_names(context: &str) -> Result<Vec<Value>, String> {
    lines(&docker(context, &["volume", "ls", "--format", r#"{"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}}}"#]).await?)
}
async fn network_infos(context: &str) -> Result<Vec<Value>, String> {
    let rows = lines(&docker(context, &["network", "ls", "--no-trunc", "--format", r#"{"id":{{json .ID}}}"#]).await?)?;
    let mut result = Vec::new();
    for batch in rows.chunks(64) {
        let format = r#"{"id":{{json .Id}},"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"internal":{{json .Internal}},"ipv6":{{json .EnableIPv6}},"createdAt":{{json .Created}},"ingress":{{json .Ingress}},"ipam":{{json .IPAM.Config}},"project":{{json (index .Labels "com.docker.compose.project")}}}"#;
        let mut args = vec!["network", "inspect", "--format", format];
        for row in batch { args.push(network_id(row)?); }
        let mut inspected = lines(&docker(context, &args).await?)?;
        if inspected.len() != batch.len() || batch.iter().any(|row| !inspected.iter().any(|info| info["id"] == row["id"])) {
            return Err("网络信息不完整，请刷新后重试".into());
        }
        for row in &mut inspected {
            row["ipam"] = json!(row["ipam"].as_array().into_iter().flatten().map(|ipam| json!({"subnet":ipam["Subnet"],"gateway":ipam["Gateway"],"range":ipam["IPRange"]})).collect::<Vec<_>>());
        }
        result.extend(inspected);
    }
    Ok(result)
}
fn network_deletable(info: &Value) -> bool {
    info["driver"] == "bridge" && info["scope"] == "local" && info["ingress"] == false
        && !matches!(info["name"].as_str(), Some("bridge" | "host" | "none"))
}
pub async fn dispatch(method: &str, p: &Value) -> Result<Value, String> {
    if !["volumes","volume_detail","volume_create","volume_remove","networks","network_detail","network_create","network_remove"].contains(&method) { return Err("不支持的资源操作".into()); }
    confirmation(method, p)?;
    if method == "volume_detail" { name(p)?; }
    if method == "network_detail" || method == "network_remove" { network_id(p)?; }
    let _guard = COLLECT_LOCK.lock().await;
    let context = local_context().await?;
    if p["context"].as_str() != Some(context.as_str()) { return Err("Docker 环境已变化，请刷新后重新确认".into()); }
    match method {
        "volumes" => {
            let mut rows = volume_names(&context).await?;
            let inventory = inventory(&context).await?;
            for row in &mut rows { row["references"] = json!(references(&inventory,"volume",row["name"].as_str().ok_or("卷名称缺失")?).len()); }
            Ok(json!({"context":context,"volumes":rows}))
        }
        "volume_detail" => {
            let mut info = volume_info(&context,name(p)?).await?;
            info["identity"] = volume_identity(&info);
            info["removable"] = json!(volume_deletable(&info));
            info["containers"] = json!(references(&inventory(&context).await?,"volume",name(p)?));
            Ok(info)
        }
        "volume_create" => {
            let name = name(p)?;
            if volume_names(&context).await?.iter().any(|row| row["name"] == name) { return Err("同名卷已存在，请使用其他名称".into()); }
            let marker = uuid::Uuid::new_v4().to_string();
            docker(&context,&["volume","create","--driver","local","--label",&format!("io.flowhub.creation={marker}"),name]).await?;
            let created = docker(&context,&["volume","inspect","--format",r#"{{index .Labels "io.flowhub.creation"}}"#,name]).await?;
            if created.trim() != marker { return Err("同名卷已由其他操作创建，请刷新核实；未覆盖已有卷".into()); }
            Ok(json!({"ok":true,"name":name}))
        }
        "volume_remove" => {
            let name = name(p)?;
            let info = volume_info(&context,name).await?;
            if !volume_deletable(&info) || volume_identity(&info) != p["identity"] { return Err("卷身份已变化或无法核对，请重新打开详情后确认".into()); }
            if !references(&inventory(&context).await?,"volume",name).is_empty() { return Err("卷仍被容器引用（包括已停止容器），不能删除".into()); }
            if volume_identity(&volume_info(&context,name).await?) != p["identity"] { return Err("卷身份已变化，请重新确认".into()); }
            // No force or prune; Docker also rejects a newly attached volume.
            docker(&context,&["volume","rm",name]).await?;
            if volume_names(&context).await?.iter().any(|row| row["name"] == name) { return Err("删除结果尚未确认，请刷新核实".into()); }
            Ok(json!({"ok":true}))
        }
        "networks" | "network_detail" => {
            let mut rows = network_infos(&context).await?;
            let inventory = inventory(&context).await?;
            for row in &mut rows {
                let refs = network_references(&inventory,row);
                row["references"] = json!(refs.len());row["removable"] = json!(network_deletable(row));row["containers"] = json!(refs);
            }
            if method == "networks" { Ok(json!({"context":context,"networks":rows})) }
            else { rows.into_iter().find(|row| row["id"] == p["id"]).ok_or("网络已不存在，请刷新".into()) }
        }
        "network_create" => {
            let name = name(p)?;
            if network_infos(&context).await?.iter().any(|row| row["name"] == name) { return Err("同名网络已存在，请使用其他名称".into()); }
            let raw = docker(&context,&["network","create","--driver","bridge",name]).await?;
            let result = json!({"id":raw.trim()});network_id(&result)?;
            Ok(json!({"ok":true,"id":result["id"],"name":name}))
        }
        "network_remove" => {
            let nid = network_id(p)?;
            let info = network_infos(&context).await?.into_iter().find(|row| row["id"] == nid).ok_or("网络已不存在，请刷新")?;
            if info["name"] != p["name"] || !network_deletable(&info) { return Err("默认网络、非本地 bridge 网络或身份变化的网络不能删除".into()); }
            if !network_references(&inventory(&context).await?,&info).is_empty() { return Err("网络仍被容器引用（包括已停止容器），不能删除".into()); }
            docker(&context,&["network","rm",nid]).await?;
            if network_infos(&context).await?.iter().any(|row| row["id"] == nid) { return Err("删除结果尚未确认，请刷新核实".into()); }
            Ok(json!({"ok":true}))
        }
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn reject_bad_names_and_unconfirmed_writes_before_process_access() {
        for method in ["volume_create","network_create","volume_remove","network_remove"] {
            assert!(dispatch(method,&json!({})).await.unwrap_err().contains("确认"));
            for value in ["", "a", "--help", "/tmp/data", "good;rm", "a\nb", "../data"] {
                assert!(dispatch(method,&json!({"confirmed":true,"name":value,"typedName":value})).await.is_err());
            }
        }
        assert!(name(&json!({"name":"db_data-01.prod"})).is_ok());
        assert!(confirmation("volume_remove",&json!({"confirmed":true,"name":"data","typedName":"other"})).is_err());
        assert!(confirmation("volume_create",&json!({"confirmed":true,"name":"data","options":{}})).is_err());
        assert!(dispatch("network_detail",&json!({"id":"abc"})).await.unwrap_err().contains("完整"));
    }
    #[test]
    fn references_include_stopped_containers_and_exclude_bind_mounts_and_private_metadata() {
        let rows = vec![json!({"id":"a","name":"/db","state":"exited","project":"demo","mounts":[{"Type":"volume","Name":"data","Destination":"/db","RW":false},{"Type":"bind","Name":"ignored"}],"networks":{"demo":{"NetworkID":"network"}},"Env":["PRIVATE"]})];
        let refs = references(&rows,"volume","data");assert_eq!(refs.len(),1);assert_eq!(refs[0]["state"],"exited");assert_eq!(refs[0]["name"],"db");assert_eq!(refs[0]["readOnly"],true);assert!(!refs[0].to_string().contains("PRIVATE"));
        assert!(references(&rows,"volume","ignored").is_empty());assert_eq!(references(&rows,"network","network").len(),1);
        let stopped=vec![json!({"id":"b","name":"/stopped","state":"exited","mounts":[],"networks":{"demo":{"NetworkID":""}}})];
        assert_eq!(network_references(&stopped,&json!({"id":"new-network-id","name":"demo"})).len(),1);
    }
    #[test]
    fn protected_resources_and_volume_identity_fail_closed() {
        let mut volume=json!({"name":"data","driver":"local","scope":"local","createdAt":"2026-11-06T01:00:00Z","mountpoint":"/volumes/data"});
        assert!(volume_deletable(&volume));let previous=volume_identity(&volume);volume["createdAt"]=json!("2026-11-06T02:00:00Z");assert_ne!(volume_identity(&volume),previous);volume["createdAt"]=Value::Null;assert!(!volume_deletable(&volume));
        for value in ["bridge","host","none"] {assert!(!network_deletable(&json!({"name":value,"driver":"bridge","scope":"local","ingress":false})));}
        assert!(network_deletable(&json!({"name":"demo_default","driver":"bridge","scope":"local","ingress":false})));
        assert!(!network_deletable(&json!({"name":"demo","driver":"overlay","scope":"swarm","ingress":false})));
    }
}
