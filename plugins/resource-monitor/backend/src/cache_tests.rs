use super::*;
use model::{Presentation, ServiceInfo, SourceOrigin};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    sync::{mpsc, Mutex},
};

fn process(pid: i32, parent: i32, executable: &str) -> Process {
    serde_json::from_value(json!({"pid":pid,"started":1000000000+pid,"uid":501,"executable":executable,
        "ppid":parent,"name":"raw-worker","displayName":"Registered Worker","launchExecutable":"/launch/component",
        "cwd":"/workspace/fixture","parentName":"fixture-parent","memory":100,"footprint":200,"cpu":1.5,
        "role":"worker","avd":"fixture-device","protected":false,"protection":"","groupId":"","attribution":"fixture",
        "runtimeProject":{"name":"fixture-project","root":"/project/root","entry":"/project/entry.mjs","evidence":"fixture"},
        "terminalOwner":{"pid":90,"started":90,"uid":501,"executable":"/owner/executable"}})).unwrap()
}
fn snapshot(at: u64) -> Snapshot {
    let mut p = process(101, 91, "/fixture/worker");
    // skip_deserializing fields can only be locally verified, as in production.
    p.launch_executable = Some("/launch/component".into());
    p.terminal_owner = Some(Identity {
        pid: 90,
        started: 90,
        uid: 501,
        executable: "/owner/executable".into(),
    });
    let mut separate = process(201, 1, "/separate/task");
    separate.runtime_project = None;
    let mut groups =
        model::group_processes(vec![p, process(102, 101, "/fixture/worker"), separate], 501);
    let group = groups
        .iter_mut()
        .find(|g| g.processes.iter().any(|p| p.identity.pid == 101))
        .unwrap();
    group.name = "Fixture App".into();
    group
        .processes
        .iter_mut()
        .find(|p| p.identity.pid == 101)
        .unwrap()
        .parent_name = "fixture-parent".into();
    group.presentation = Some(Presentation {
        name: Some("Fixture Service".into()),
        sources: vec![SourceOrigin {
            name: "Fixture Source".into(),
            app_path: Some("/Applications/Source.app".into()),
            evidence: "display only".into(),
        }],
        services: vec![ServiceInfo {
            name: "Registered Service".into(),
            label: "local.fixture.service-label".into(),
            evidence: "fixture".into(),
        }],
    });
    Snapshot::new(at, groups, json!({"totalMemory":1024}))
}

#[test]
fn ranking_and_desktop_card_share_persisted_view_preferences() {
    let path = std::env::temp_dir().join(format!("flowhub-view-{}.json", uuid::Uuid::new_v4()));
    let cache = Cache::with_preferences(Some(path.clone()));
    let mut sample = snapshot(now());
    let groups = Arc::make_mut(&mut sample.groups);
    groups[0].system = false;
    groups[1].system = true;
    let system_id = groups[1].id.clone();
    let sample = Snapshot::new(sample.at, groups.clone(), sample.system);
    cache.finish(Ok(sample.clone()));
    let assert_view = |cache: &Cache, visible: bool, sorting: Value| {
        let rank = rpc::read(cache, "ranking_snapshot", &json!({})).unwrap().unwrap();
        let card = rpc::read(cache, "widget_api", &json!({"action":"snapshot"})).unwrap().unwrap();
        let rows = |value: &Value, key: &str| value[key].as_array().unwrap().iter()
            .map(|row| row["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        assert_eq!(rank["includeSystem"], visible);
        assert_eq!(rank["sorting"], sorting);
        assert_eq!(card["sorting"], sorting);
        assert_eq!(rows(&rank, "groups"), rows(&card, "rows"));
        assert_eq!(rows(&card, "rows").contains(&system_id), visible);
        assert!(!rows(&cache.get().status(), "rows").contains(&system_id));
    };
    let default_sort = json!({"key":"cpu","order":"descend"});
    let custom_sort = json!({"key":"processCount","order":"ascend"});
    assert_view(&cache, false, default_sort);
    let before = cache.get().revision;
    cache.set_view_preferences(&json!({"includeSystem":true})).unwrap();
    assert_eq!(cache.get().revision, before + 1);
    cache.set_view_preferences(&json!({"sorting":custom_sort})).unwrap();
    assert_view(&cache, true, custom_sort.clone());
    assert!(cache.set_view_preferences(&json!({"sorting":{"key":"unknown","order":"ascend"}})).is_err());

    let reopened = Cache::with_preferences(Some(path.clone()));
    reopened.finish(Ok(sample));
    assert_view(&reopened, true, custom_sort.clone());
    reopened.set_view_preferences(&json!({"includeSystem":false})).unwrap();
    assert_view(&reopened, false, custom_sort);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn ranking_search_and_detail_preserve_metrics_identity_and_instance_boundaries() {
    let sample = snapshot(now());
    let full = sample.full();
    let ranking = sample.ranking(&json!({}));
    for group in full["groups"].as_array().unwrap() {
        let row = ranking["groups"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == group["id"])
            .unwrap();
        for field in [
            "memory",
            "footprint",
            "cpu",
            "incomplete",
            "footprintIncomplete",
            "canTerminate",
            "system",
        ] {
            assert_eq!(row[field], group[field]);
        }
        assert!(row.get("processes").is_none());
        assert!(row.get("instances").is_none());
        assert_eq!(
            row["processCount"],
            group["processes"].as_array().unwrap().len()
        );
        assert_eq!(
            row["instanceCount"],
            group["instances"].as_array().unwrap().len()
        );
        let detail = sample.detail(&json!({"groupId":group["id"]})).unwrap();
        assert_eq!(&detail["group"], group);
        assert!(detail.get("groups").is_none());
        assert!(detail["contextProcesses"].as_array().unwrap().is_empty());
    }
    let id = &full["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == "Fixture App")
        .unwrap()["id"];
    for query in [
        "fixture app",
        "RAW-WORKER",
        "Registered Worker",
        "102",
        "91",
        "fixture-parent",
        "/fixture/worker",
        "/launch/component",
        "/owner/executable",
        "/workspace/fixture",
        "fixture-project",
        "/project/root",
        "/project/entry.mjs",
        "fixture-device",
        "Fixture Source",
        "Source.app",
        "Registered Service",
        "service-label",
    ] {
        let matches = sample.ranking(&json!({"query":query}))["matchedGroupIds"].clone();
        assert!(
            matches.as_array().unwrap().contains(id),
            "missing search: {query}"
        );
    }
    let text = ranking.to_string();
    assert!(!text.contains("/workspace/fixture"));
    assert!(!text.contains("service-label"));
    assert!(!text.contains("executable"));
    let status = sample.status().to_string();
    for private in [
        "processes",
        "started",
        "service-label",
        "/workspace/fixture",
        "/fixture/worker",
    ] {
        assert!(!status.contains(private));
    }
}
#[test]
fn detail_checks_moved_full_identities_and_only_requested_cross_group_contexts() {
    let sample = snapshot(now());
    let target = sample
        .groups
        .iter()
        .find(|g| g.processes.iter().any(|p| p.identity.pid == 101))
        .unwrap();
    let detail = sample
        .detail(&json!({"groupId":target.id,"trackedPids":[201,999],"contextPids":[201]}))
        .unwrap();
    assert_eq!(detail["elsewhere"].as_array().unwrap().len(), 1);
    assert_eq!(detail["elsewhere"][0]["pid"], 201);
    assert_eq!(detail["elsewhere"][0]["executable"], "/separate/task");
    assert_eq!(detail["contextProcesses"].as_array().unwrap().len(), 1);
    assert!(sample
        .detail(&json!({"groupId":"gone","trackedPids":[101]}))
        .unwrap()["group"]
        .is_null());
    assert!(sample.detail(&json!({})).is_err());
    assert!(sample
        .detail(&json!({"groupId":target.id,"revision":sample.revision+1}))
        .unwrap_err()
        .contains("版本已更新"));
    let presence=sample.detail(&json!({"groupId":target.id,"revision":sample.revision,"includeGroup":false,"trackedPids":[201]})).unwrap();
    assert!(presence["group"].is_null());
    assert_eq!(presence["elsewhere"][0]["pid"], 201);
}
#[test]
fn failure_retains_sample_and_marks_error_age_and_sampling_with_monotonic_revision() {
    let mut monitor = Monitor::new();
    monitor
        .refresh_with(|_| Ok(snapshot(now() - 21000)))
        .unwrap();
    let old = monitor.cache.get();
    assert!(old.stale());
    let cache = monitor.cache.clone();
    monitor
        .refresh_with(|_| {
            let pending = cache.get();
            assert!(pending.sampling);
            assert!(pending.revision > old.revision);
            Err("controlled failure".into())
        })
        .unwrap_err();
    let failed = monitor.cache.get();
    assert_eq!(failed.at, old.at);
    assert!(Arc::ptr_eq(&failed.groups, &old.groups));
    assert_eq!(failed.error.as_deref(), Some("controlled failure"));
    assert!(!failed.sampling);
    assert!(failed.stale());
    assert!(failed.revision > old.revision);
    monitor.refresh_with(|_| Ok(snapshot(now()))).unwrap();
    let recovered = monitor.cache.get();
    assert!(recovered.error.is_none());
    assert!(!recovered.stale());
    assert!(!recovered.sampling);
    assert!(recovered.revision > failed.revision);
}
#[test]
fn slow_manual_and_background_sampling_do_not_block_read_rpcs_or_overwrite_newer_samples() {
    let monitor = Arc::new(Mutex::new(Monitor::new()));
    let cache = monitor.lock().unwrap().cache.clone();
    monitor
        .lock()
        .unwrap()
        .refresh_with(|_| Ok(snapshot(now())))
        .unwrap();
    let previous = cache.get().at;
    let (entered, started) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let background = monitor.clone();
    let background_thread = std::thread::spawn(move || {
        background.lock().unwrap().refresh_with(|_| {
            entered.send(()).unwrap();
            blocked.recv().unwrap();
            Ok(snapshot(previous + 1))
        })
    });
    started.recv().unwrap();
    let (client, server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    let writer = server.try_clone().unwrap();
    let worker_monitor = monitor.clone();
    let worker_cache = cache.clone();
    let server_thread = std::thread::spawn(move || {
        rpc::serve_with(
            worker_cache,
            BufReader::new(server),
            writer,
            false,
            move |_| {
                let mut monitor = worker_monitor.lock().unwrap();
                monitor.refresh_with(|_| Ok(snapshot(previous + 2)))?;
                Ok(monitor.snapshot.full())
            },
        )
    });
    let mut client = BufReader::new(client);
    // The manual refresh queues behind the deliberately blocked background sample.
    writeln!(client.get_mut(), "{}", json!({"id":1,"method":"refresh"})).unwrap();
    let start = Instant::now();
    for (id, method, params) in [
        (2, "status_snapshot", json!({})),
        (3, "snapshot", json!({})),
        (4, "ranking_snapshot", json!({"query":"worker"})),
        (5, "group_detail", json!({"groupId":"gone"})),
        (6, "widget_api", json!({"action":"snapshot"})),
        (
            7,
            "widget_api",
            json!({"action":"management","method":"ranking_snapshot"}),
        ),
    ] {
        writeln!(
            client.get_mut(),
            "{}",
            json!({"id":id,"method":method,"params":params})
        )
        .unwrap();
        let mut line = String::new();
        client
            .read_line(&mut line)
            .expect("cache RPC blocked on collection");
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["id"], id);
        assert_eq!(response["result"]["sampling"], true);
        assert_eq!(response["result"]["at"], previous);
    }
    let read_elapsed = start.elapsed();
    assert!(!background_thread.is_finished());
    release.send(()).unwrap();
    background_thread.join().unwrap().unwrap();
    let mut line = String::new();
    client.read_line(&mut line).unwrap();
    let manual: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(manual["id"], 1);
    assert_eq!(manual["result"]["at"], previous + 2);
    assert_eq!(cache.get().at, previous + 2);
    assert!(!cache.get().sampling);
    eprintln!(
        "controlled slow collector: six cache RPCs completed in {:?} before release",
        read_elapsed
    );
    client.get_ref().shutdown(std::net::Shutdown::Both).unwrap();
    server_thread.join().unwrap();
}
