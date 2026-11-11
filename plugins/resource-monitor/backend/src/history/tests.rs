use super::*;
use crate::model::{group_processes, Process};

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("flowhub-history-{}", uuid::Uuid::new_v4())))
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn rows(
    at: u64,
    cpu: Option<f64>,
    footprint: Option<u64>,
    rss: Option<u64>,
    segment: u64,
) -> Batch {
    Batch {
        at,
        rows: vec![Sample {
            key: key("fixture-one"),
            cpu,
            footprint,
            rss,
            segment,
        }],
    }
}
fn snapshot(at: u64, pid: i32) -> Snapshot {
    let p:Process=serde_json::from_value(json!({"pid":pid,"started":1,"uid":501,"executable":"/fixture/worker","ppid":1,"parentName":"launchd","name":"worker","memory":100,"footprint":200,"cpu":2.5,"cwd":"","role":"fixture","avd":"","protected":false,"protection":"","groupId":"","attribution":"fixture"})).unwrap();
    Snapshot::new(at, group_processes(vec![p], 501), json!({}))
}
fn settled(history: &History, count: u64) {
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        if history.status().unwrap()["points"] == count {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "writer did not settle"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn persisted_metrics_are_isolated_bounded_and_private() {
    let dir = Directory::new();
    let (mut db, path, hours, run) = initialize(&dir.0).unwrap();
    assert_eq!(hours, 48);
    let at = crate::now();
    write(
        &mut db,
        rows(at, Some(245.5), Some(4096), Some(2048), 1),
        run,
        hours,
    )
    .unwrap();
    write(
        &mut db,
        Batch {
            at,
            rows: vec![Sample {
                key: key("fixture-two"),
                cpu: Some(6.),
                footprint: None,
                rss: Some(512),
                segment: 2,
            }],
        },
        run,
        hours,
    )
    .unwrap();
    let first = read_report(&path, &key("fixture-one"), "fixture-one", hours, at, None).unwrap();
    assert_eq!(first["points"][0]["cpu"], 245.5);
    assert_eq!(first["points"][0]["footprint"], 4096);
    assert_eq!(first["points"][0]["rss"], 2048);
    let second = read_report(&path, &key("fixture-two"), "fixture-two", hours, at, None).unwrap();
    assert_eq!(second["points"][0]["cpu"], 6.);
    assert!(second["points"][0]["footprint"].is_null());
    assert_eq!(
        read_report(&path, &key("missing"), "missing", hours, at, None).unwrap()["points"],
        json!([])
    );
    assert_eq!(
        fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let keys = db
        .prepare("SELECT key FROM series")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(keys.iter().all(|value| valid_key(value)));
    assert!(!keys.iter().any(|value| value.contains("fixture")));
    // Each minute is stored once, even if explicitly refreshed many times.
    write(&mut db, rows(at, Some(999.), None, None, 3), run, hours).unwrap();
    assert_eq!(
        read_report(&path, &key("fixture-one"), "fixture-one", hours, at, None).unwrap()["points"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    drop(db);
    let (_, _, _, next_run) = initialize(&dir.0).unwrap();
    assert_ne!(run, next_run);
    assert_eq!(
        read_report(&path, &key("fixture-one"), "fixture-one", hours, at, None).unwrap()["points"],
        first["points"]
    );
}

#[test]
fn retention_survives_restart_and_shortening_prunes_all_groups() {
    let dir = Directory::new();
    let (mut db, path, _, run) = initialize(&dir.0).unwrap();
    let at = crate::now();
    for hours in [170, 72, 1] {
        write(
            &mut db,
            rows(at - hours * 3_600_000, Some(1.), None, None, 1),
            run,
            168,
        )
        .unwrap();
    }
    assert_eq!(status(&path, None).unwrap()["points"], 2);
    drop(db);
    let history = History::open(Some(dir.0.clone()));
    assert!(history
        .retention(&json!({"groupId":"fixture-one","hours":24}))
        .is_err());
    assert!(history.retention(&json!({"hours":168})).is_err());
    assert_eq!(history.status().unwrap()["hours"], 48);
    let report = history
        .retention(&json!({"groupId":"fixture-one","hours":168}))
        .unwrap();
    assert_eq!(report["points"].as_array().unwrap().len(), 2);
    let (_, _, saved, _) = initialize(&dir.0).unwrap();
    assert_eq!(saved, 168);
    let report = history
        .retention(&json!({"groupId":"fixture-one","hours":48}))
        .unwrap();
    assert_eq!(report["points"].as_array().unwrap().len(), 1);
    assert_eq!(status(&path, None).unwrap()["points"], 1);
}

#[test]
fn collector_tracks_lifetimes_and_never_turns_missing_metrics_into_zero() {
    let dir = Directory::new();
    let history = History::open(Some(dir.0.clone()));
    let at = crate::now();
    let first = snapshot(at, 101);
    let id = first.groups[0].id.clone();
    history.observe(&first);
    settled(&history, 1);
    history.observe(&first);
    assert_eq!(history.status().unwrap()["points"], 1);
    let mut second = snapshot(at + INTERVAL, 101);
    let groups = Arc::make_mut(&mut second.groups);
    groups[0].footprint_incomplete = true;
    groups[0].incomplete = true;
    groups[0].processes[0].cpu = None;
    history.observe(&second);
    settled(&history, 2);
    // A failed snapshot breaks continuity without recording stale readings.
    let mut failed = second.clone();
    failed.error = Some("fixture".into());
    history.observe(&failed);
    history.observe(&snapshot(at + 2 * INTERVAL, 101));
    settled(&history, 3);
    // PID reuse/new process identity must also begin a new segment.
    let mut last = snapshot(at + 3 * INTERVAL, 101);
    Arc::make_mut(&mut last.groups)[0].processes[0]
        .identity
        .started = 2;
    history.observe(&last);
    settled(&history, 4);
    let report = history
        .report(&json!({"groupId":id}), at + 4 * INTERVAL)
        .unwrap();
    let points = report["points"].as_array().unwrap();
    assert_eq!(points[0]["segment"], points[1]["segment"]);
    assert_ne!(points[1]["segment"], points[2]["segment"]);
    assert_ne!(points[2]["segment"], points[3]["segment"]);
    assert!(points[1]["cpu"].is_null());
    assert!(points[1]["footprint"].is_null());
    assert!(points[1]["rss"].is_null());
    let mut stale = snapshot(at.saturating_sub(30_000), 101);
    history.observe(&stale);
    stale.at = 0;
    history.observe(&stale);
    assert_eq!(history.status().unwrap()["points"], 4);
}

#[test]
fn seven_day_series_fits_reader_limit_and_returns_ascending_times() {
    let dir = Directory::new();
    let (mut db, path, _, run) = initialize(&dir.0).unwrap();
    let at = crate::now();
    let tx = db.transaction().unwrap();
    tx.execute("INSERT INTO series(key) VALUES(?1)", [key("fixture-one")])
        .unwrap();
    {
        let mut q = tx
            .prepare("INSERT INTO samples VALUES(1,?1,1,2,3,?2,1)")
            .unwrap();
        for i in 0..10_080 {
            q.execute(params![(at - i * INTERVAL) as i64, run]).unwrap();
        }
    }
    tx.commit().unwrap();
    let report = read_report(&path, &key("fixture-one"), "fixture-one", 168, at, None).unwrap();
    let points = report["points"].as_array().unwrap();
    assert_eq!(points.len(), 10_080);
    assert_eq!(report["truncated"], false);
    assert!(points
        .windows(2)
        .all(|p| p[0]["at"].as_u64() < p[1]["at"].as_u64()));
    assert!(report.to_string().len() < 4 * 1024 * 1024);
}

#[test]
fn read_only_cli_does_not_start_sampler_or_rewrite_database() {
    let dir = Directory::new();
    let (mut db, path, hours, run) = initialize(&dir.0).unwrap();
    write(
        &mut db,
        rows(crate::now(), Some(3.), None, None, 1),
        run,
        hours,
    )
    .unwrap();
    drop(db);
    let before = fs::read(&path).unwrap();
    let args = |parts: &[&str]| {
        parts
            .iter()
            .map(|p| p.to_string())
            .chain(["--data".to_string(), dir.0.to_string_lossy().into_owned()])
            .collect::<Vec<_>>()
    };
    assert_eq!(cli(&args(&["history", "status"])).unwrap()["points"], 1);
    let list = cli(&args(&["history", "list"])).unwrap();
    assert_eq!(list["groups"][0]["key"], key("fixture-one"));
    assert_eq!(
        cli(&args(&["history", "show", &key("fixture-one")])).unwrap()["points"][0]["cpu"],
        3.
    );
    assert!(cli(&args(&["history", "show", "../invalid"])).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(History::unavailable()
        .report(&json!({"groupId":"fixture"}), crate::now())
        .is_err());
}
