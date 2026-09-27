//! Integration tests: run the bridge against a small stand-in runtime written in
//! JavaScript, exercising the real process, pipes and framing.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use morrow_runtime_bridge::{BridgeError, BridgeNotice, RuntimeBridge, RuntimeLaunch, RuntimeStatus};
use serde_json::{Value, json};

const STAND_IN: &str = r#"
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.method === 'test.emit') send({ jsonrpc: '2.0', method: 'event', params: { type: 'TEST', n: req.params.n } });
  if (req.method === 'test.fail') return send({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'nope', data: { code: 'NOPE' } } });
  if (req.method === 'test.silent') return;
  send({ jsonrpc: '2.0', id: req.id, result: { method: req.method, params: req.params } });
});
rl.on('close', () => process.exit(0));
process.stderr.write('stand-in ready\n');
"#;

fn node_available() -> bool {
    std::process::Command::new("node").arg("--version").output().is_ok()
}

fn launch(dir: &std::path::Path, timeout: Duration) -> RuntimeLaunch {
    let script = dir.join("stand-in.cjs");
    std::fs::write(&script, STAND_IN).unwrap();
    RuntimeLaunch {
        node: "node".into(),
        script,
        data_dir: dir.to_path_buf(),
        migrations_dir: None,
        request_timeout: timeout,
    }
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("morrow-bridge-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn request_response_events_and_shutdown() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let dir = temp_dir("rr");
    let notices: Arc<Mutex<Vec<BridgeNotice>>> = Arc::default();
    let sink_notices = notices.clone();
    let bridge = RuntimeBridge::start(
        launch(&dir, Duration::from_secs(5)),
        Arc::new(move |n| sink_notices.lock().unwrap().push(n)),
    );
    assert!(matches!(bridge.status(), RuntimeStatus::Running { .. }));

    let result = bridge.request("task.create", json!({ "objective": "x" })).await.unwrap();
    assert_eq!(result["method"], "task.create");
    assert_eq!(result["params"]["objective"], "x");

    let error = bridge.request("test.fail", json!({})).await.unwrap_err();
    assert!(matches!(error, BridgeError::Rpc { code: -32000, .. }));

    bridge.request("test.emit", json!({ "n": 3 })).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let events: Vec<Value> = notices
        .lock()
        .unwrap()
        .iter()
        .filter_map(|n| if let BridgeNotice::Event(v) = n { Some(v.clone()) } else { None })
        .collect();
    assert_eq!(events, vec![json!({ "type": "TEST", "n": 3 })]);

    assert_eq!(bridge.request("bad method", json!({})).await.unwrap_err(), BridgeError::InvalidMethod);

    bridge.shutdown(Duration::from_secs(3)).await;
    assert!(matches!(bridge.status(), RuntimeStatus::Exited { .. }));
    assert!(bridge.request("task.list", json!({})).await.is_err());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn times_out_when_the_runtime_does_not_answer() {
    if !node_available() {
        return;
    }
    let dir = temp_dir("timeout");
    let bridge = RuntimeBridge::start(launch(&dir, Duration::from_millis(300)), Arc::new(|_| {}));
    let error = bridge.request("test.silent", json!({})).await.unwrap_err();
    assert_eq!(error, BridgeError::Timeout { ms: 300 });
    bridge.shutdown(Duration::from_secs(3)).await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn reports_unavailable_instead_of_failing_when_bundle_missing() {
    let dir = temp_dir("missing");
    let bridge = RuntimeBridge::start(
        RuntimeLaunch {
            node: "node".into(),
            script: dir.join("does-not-exist.mjs"),
            data_dir: dir.clone(),
            migrations_dir: None,
            request_timeout: Duration::from_secs(1),
        },
        Arc::new(|_| {}),
    );
    assert!(matches!(bridge.status(), RuntimeStatus::Unavailable { .. }));
    assert!(matches!(bridge.request("task.list", json!({})).await, Err(BridgeError::NotRunning { .. })));
    let _ = std::fs::remove_dir_all(dir);
}
