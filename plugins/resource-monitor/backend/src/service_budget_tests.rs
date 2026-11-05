use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

#[test]
fn subprocesses_share_one_deadline_and_never_join_an_inherited_pipe() {
    let start = Instant::now();
    let deadline = start + Duration::from_millis(60);
    for _ in 0..4 {
        assert!(command("/bin/sleep", &["1"], deadline).is_none());
    }
    assert!(start.elapsed() < Duration::from_millis(400));
    // The fixture shell exits but its own short-lived child inherits stdout.
    let start = Instant::now();
    assert!(command(
        "/bin/sh",
        &["-c", "/bin/sleep 0.3 & printf fixture"],
        start + Duration::from_millis(40)
    )
    .is_none());
    assert!(start.elapsed() < Duration::from_millis(250));
}
#[test]
fn optional_work_has_one_total_budget_one_inflight_worker_and_no_late_publication() {
    let mut groups = crate::model::group_processes(
        vec![crate::model::tests::process(999, 1, "/tmp/fixture")],
        501,
    );
    let original = serde_json::to_value(&groups).unwrap();
    let mut catalog = Catalog::default();
    let (release, blocked) = mpsc::channel();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let start = Instant::now();
    catalog.enrich_with(&mut groups, Duration::from_millis(30), move |groups, _| {
        count.fetch_add(1, Ordering::SeqCst);
        groups[0].name = "late annotation".into();
        blocked.recv().unwrap();
    });
    assert!(start.elapsed() < Duration::from_millis(250));
    assert_eq!(serde_json::to_value(&groups).unwrap(), original);
    let count = calls.clone();
    catalog.enrich_with(&mut groups, Duration::from_millis(30), move |_, _| {
        count.fetch_add(100, Ordering::SeqCst);
    });
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(serde_json::to_value(&groups).unwrap(), original);
    release.send(()).unwrap();
    // Wait for this test's own worker to return its late data, then ensure it is
    // discarded rather than applied to the next collection generation.
    let pending = catalog.pending.take().unwrap();
    let late = pending.recv_timeout(Duration::from_secs(1)).unwrap();
    let (send, receive) = mpsc::channel();
    send.send(late).unwrap();
    catalog.pending = Some(receive);
    catalog.enrich_with(&mut groups, Duration::from_millis(100), |_, _| {});
    assert_eq!(serde_json::to_value(&groups).unwrap(), original);
}
