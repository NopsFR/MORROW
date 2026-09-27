//! Supervises the MORROW agent runtime (a Node.js process) and talks to it with
//! newline-delimited JSON-RPC 2.0 over stdio.
//!
//! The bridge is transport, not policy: it forwards requests the UI makes and
//! events the runtime emits. Method names are syntax-checked here, but the runtime
//! is the authority on which methods exist and what they may do.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{Mutex as AsyncMutex, oneshot};

/// How to launch the runtime process.
#[derive(Debug, Clone)]
pub struct RuntimeLaunch {
    /// Node.js executable.
    pub node: PathBuf,
    /// Bundled runtime entry (agent/dist/morrow-runtime.mjs).
    pub script: PathBuf,
    /// Directory for MORROW's persistent data (database).
    pub data_dir: PathBuf,
    /// Drizzle migrations directory; the runtime has a default if omitted.
    pub migrations_dir: Option<PathBuf>,
    pub request_timeout: Duration,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RuntimeStatus {
    NotStarted,
    Starting,
    Running { pid: Option<u32> },
    Exited { code: Option<i32> },
    /// The runtime could not be launched at all (missing Node, missing bundle...).
    Unavailable { reason: String },
}

#[derive(Debug, Clone, Serialize, thiserror::Error, PartialEq)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BridgeError {
    #[error("agent runtime is not running: {reason}")]
    NotRunning { reason: String },
    #[error("request timed out after {ms} ms")]
    Timeout { ms: u64 },
    #[error("invalid method name")]
    InvalidMethod,
    #[error("{message}")]
    Rpc { code: i64, message: String, data: Option<Value> },
    #[error("i/o error: {message}")]
    Io { message: String },
}

/// Things the bridge reports to its host (the Tauri app).
#[derive(Debug, Clone)]
pub enum BridgeNotice {
    /// A persisted MORROW event pushed by the runtime.
    Event(Value),
    Status(RuntimeStatus),
    /// A line the runtime wrote to stderr.
    Log(String),
}

pub type NoticeSink = Arc<dyn Fn(BridgeNotice) + Send + Sync>;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, BridgeError>>>>>;

pub struct RuntimeBridge {
    stdin: AsyncMutex<Option<ChildStdin>>,
    pending: Pending,
    next_id: AtomicU64,
    status: Arc<Mutex<RuntimeStatus>>,
    kill: Mutex<Option<oneshot::Sender<()>>>,
    request_timeout: Duration,
}

/// Method names look like `task.create`: lowercase namespace, dot, camelCase name.
pub fn is_valid_method(method: &str) -> bool {
    let Some((ns, name)) = method.split_once('.') else { return false };
    !ns.is_empty()
        && !name.is_empty()
        && method.len() <= 64
        && ns.chars().all(|c| c.is_ascii_lowercase())
        && name.chars().all(|c| c.is_ascii_alphanumeric())
}

fn set_status(status: &Arc<Mutex<RuntimeStatus>>, sink: &NoticeSink, next: RuntimeStatus) {
    *status.lock().expect("status lock") = next.clone();
    sink(BridgeNotice::Status(next));
}

impl RuntimeBridge {
    /// Launch the runtime. Never fails: if launching is impossible the bridge is
    /// returned in the `Unavailable` state and every request reports why.
    pub fn start(launch: RuntimeLaunch, sink: NoticeSink) -> Arc<Self> {
        let status = Arc::new(Mutex::new(RuntimeStatus::Starting));
        sink(BridgeNotice::Status(RuntimeStatus::Starting));
        let bridge = Arc::new(Self {
            stdin: AsyncMutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            status: status.clone(),
            kill: Mutex::new(None),
            request_timeout: launch.request_timeout,
        });

        if !launch.script.is_file() {
            set_status(
                &status,
                &sink,
                RuntimeStatus::Unavailable {
                    reason: format!("Runtime bundle not found at {} (run `pnpm build:runtime`)", launch.script.display()),
                },
            );
            return bridge;
        }

        let mut command = Command::new(&launch.node);
        command
            .arg(&launch.script)
            .env("MORROW_DATA_DIR", &launch.data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(dir) = &launch.migrations_dir {
            command.env("MORROW_MIGRATIONS_DIR", dir);
        }
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                set_status(
                    &status,
                    &sink,
                    RuntimeStatus::Unavailable {
                        reason: format!("Could not start Node.js ({}): {error}", launch.node.display()),
                    },
                );
                return bridge;
            }
        };

        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let pid = child.id();
        // Stdin is installed synchronously: we are not yet shared, so try_lock always succeeds.
        *bridge.stdin.try_lock().expect("fresh bridge") = stdin;
        set_status(&status, &sink, RuntimeStatus::Running { pid });

        // stdout: responses and notifications.
        {
            let pending = bridge.pending.clone();
            let sink = sink.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    handle_line(&line, &pending, &sink);
                }
            });
        }
        // stderr: logs.
        {
            let sink = sink.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    sink(BridgeNotice::Log(line));
                }
            });
        }
        // Process lifetime.
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        *bridge.kill.lock().expect("kill lock") = Some(kill_tx);
        {
            let status = status.clone();
            let pending = bridge.pending.clone();
            let sink = sink.clone();
            tokio::spawn(async move {
                let code = tokio::select! {
                    result = child.wait() => result.ok().and_then(|s| s.code()),
                    _ = kill_rx => {
                        let _ = child.kill().await;
                        child.wait().await.ok().and_then(|s| s.code())
                    }
                };
                for (_, tx) in pending.lock().expect("pending lock").drain() {
                    let _ = tx.send(Err(BridgeError::NotRunning { reason: "runtime exited".into() }));
                }
                set_status(&status, &sink, RuntimeStatus::Exited { code });
            });
        }
        bridge
    }

    pub fn status(&self) -> RuntimeStatus {
        self.status.lock().expect("status lock").clone()
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, BridgeError> {
        if !is_valid_method(method) {
            return Err(BridgeError::InvalidMethod);
        }
        match self.status() {
            RuntimeStatus::Running { .. } => {}
            RuntimeStatus::Unavailable { reason } => return Err(BridgeError::NotRunning { reason }),
            other => return Err(BridgeError::NotRunning { reason: format!("{other:?}") }),
        }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().expect("pending lock").insert(id, tx);

        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let mut line = serde_json::to_string(&message).map_err(|e| BridgeError::Io { message: e.to_string() })?;
        line.push('\n');
        {
            let mut stdin = self.stdin.lock().await;
            let Some(writer) = stdin.as_mut() else {
                self.pending.lock().expect("pending lock").remove(&id);
                return Err(BridgeError::NotRunning { reason: "stdin closed".into() });
            };
            if let Err(e) = writer.write_all(line.as_bytes()).await {
                self.pending.lock().expect("pending lock").remove(&id);
                return Err(BridgeError::Io { message: e.to_string() });
            }
            let _ = writer.flush().await;
        }

        match tokio::time::timeout(self.request_timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(BridgeError::NotRunning { reason: "runtime exited".into() }),
            Err(_) => {
                self.pending.lock().expect("pending lock").remove(&id);
                Err(BridgeError::Timeout { ms: self.request_timeout.as_millis() as u64 })
            }
        }
    }

    /// Graceful stop: close stdin so the runtime finishes in-flight work and exits;
    /// force-kill if it has not exited within `grace`.
    pub async fn shutdown(&self, grace: Duration) {
        self.stdin.lock().await.take();
        let deadline = tokio::time::Instant::now() + grace;
        while tokio::time::Instant::now() < deadline {
            if matches!(self.status(), RuntimeStatus::Exited { .. } | RuntimeStatus::Unavailable { .. }) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        if let Some(kill) = self.kill.lock().expect("kill lock").take() {
            let _ = kill.send(());
        }
    }
}

fn handle_line(line: &str, pending: &Pending, sink: &NoticeSink) {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        sink(BridgeNotice::Log(format!("unparseable runtime output: {line}")));
        return;
    };
    if message.get("method").and_then(Value::as_str) == Some("event") {
        if let Some(params) = message.get("params") {
            sink(BridgeNotice::Event(params.clone()));
        }
        return;
    }
    let Some(id) = message.get("id").and_then(Value::as_u64) else {
        if let Some(error) = message.get("error") {
            sink(BridgeNotice::Log(format!("runtime rejected a message: {error}")));
        }
        return;
    };
    let Some(tx) = pending.lock().expect("pending lock").remove(&id) else { return };
    let outcome = if let Some(error) = message.get("error") {
        Err(BridgeError::Rpc {
            code: error.get("code").and_then(Value::as_i64).unwrap_or(-32603),
            message: error.get("message").and_then(Value::as_str).unwrap_or("runtime error").to_string(),
            data: error.get("data").cloned(),
        })
    } else {
        Ok(message.get("result").cloned().unwrap_or(Value::Null))
    };
    let _ = tx.send(outcome);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_method_names() {
        assert!(is_valid_method("task.create"));
        assert!(is_valid_method("permission.listPending"));
        assert!(!is_valid_method("task"));
        assert!(!is_valid_method("task.create;rm"));
        assert!(!is_valid_method("Task.create"));
        assert!(!is_valid_method("a.b.c"));
    }

    #[test]
    fn status_serialises_with_state_tag() {
        let v = serde_json::to_value(RuntimeStatus::Running { pid: Some(7) }).unwrap();
        assert_eq!(v, json!({ "state": "RUNNING", "pid": 7 }));
        let v = serde_json::to_value(RuntimeStatus::Unavailable { reason: "x".into() }).unwrap();
        assert_eq!(v, json!({ "state": "UNAVAILABLE", "reason": "x" }));
    }
}
