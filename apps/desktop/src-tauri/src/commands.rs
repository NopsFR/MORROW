//! The complete IPC surface available to the UI.

use morrow_runtime_bridge::{BridgeError, RuntimeStatus};
use morrow_system::{InitCheck, SystemReport};
use serde_json::Value;
use tauri::State;

use crate::AppState;

#[tauri::command]
pub fn runtime_status(state: State<'_, AppState>) -> RuntimeStatus {
    state.bridge.status()
}

/// Forward one request to the agent runtime. The runtime validates the method
/// and its params against the shared protocol; there is no tool-execution method.
#[tauri::command]
pub async fn runtime_request(
    state: State<'_, AppState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, BridgeError> {
    let bridge = state.bridge.clone();
    bridge.request(&method, params.unwrap_or(Value::Object(Default::default()))).await
}

#[tauri::command]
pub async fn system_report() -> SystemReport {
    tauri::async_runtime::spawn_blocking(morrow_system::probe)
        .await
        .expect("system probe panicked")
}

/// ENVIRONMENT and COMPUTER checks, which only the native layer can answer.
#[tauri::command]
pub async fn native_init_checks() -> Vec<InitCheck> {
    let report = tauri::async_runtime::spawn_blocking(morrow_system::probe)
        .await
        .expect("system probe panicked");
    vec![morrow_system::environment_check(&report), morrow_system::computer_check()]
}
