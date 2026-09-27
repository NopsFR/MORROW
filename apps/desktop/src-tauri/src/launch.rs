//! Where the agent runtime and its data live.
//!
//! - Data: the OS app-data directory for this app (never a hard-coded user path).
//! - Runtime bundle + migrations: in development, resolved relative to this crate's
//!   source location at compile time. Overridable with MORROW_RUNTIME_SCRIPT /
//!   MORROW_MIGRATIONS_DIR. Packaging them as installer resources is not done yet;
//!   a release build without them reports the runtime as unavailable.
//! - Node.js: MORROW_NODE if set, otherwise `node` on PATH.

use std::path::PathBuf;
use std::time::Duration;

use morrow_runtime_bridge::RuntimeLaunch;
use tauri::{AppHandle, Manager};

fn repo_root() -> PathBuf {
    // apps/desktop/src-tauri → repository root
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..")
}

pub fn resolve(app: &AppHandle) -> Result<RuntimeLaunch, Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;

    let script = std::env::var_os("MORROW_RUNTIME_SCRIPT")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root().join("agent").join("dist").join("morrow-runtime.mjs"));
    let migrations_dir = std::env::var_os("MORROW_MIGRATIONS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root().join("database").join("migrations"));
    let node = std::env::var_os("MORROW_NODE").map(PathBuf::from).unwrap_or_else(|| "node".into());

    Ok(RuntimeLaunch {
        node,
        script,
        data_dir,
        migrations_dir: Some(migrations_dir),
        request_timeout: Duration::from_secs(30),
    })
}
