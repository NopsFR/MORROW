//! MORROW native layer (Tauri 2).
//!
//! Responsibilities:
//! - own the window and the IPC surface exposed to the UI,
//! - probe the host (morrow-system),
//! - launch and supervise the agent runtime (morrow-runtime-bridge),
//! - forward runtime events to the UI.
//!
//! It deliberately exposes a small command surface. The UI cannot run programs,
//! touch files or call tools through it; it can only make runtime requests, which
//! the runtime validates against its own protocol.

mod commands;
mod launch;

use std::sync::Arc;
use std::time::Duration;

use morrow_runtime_bridge::{BridgeNotice, RuntimeBridge};
use tauri::{Emitter, Manager, RunEvent};

pub const EVENT_RUNTIME_EVENT: &str = "morrow://runtime-event";
pub const EVENT_RUNTIME_STATUS: &str = "morrow://runtime-status";

pub struct AppState {
    pub bridge: Arc<RuntimeBridge>,
}

pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let launch = launch::resolve(&handle)?;
            let sink_handle = handle.clone();
            let sink = Arc::new(move |notice: BridgeNotice| match notice {
                BridgeNotice::Event(event) => {
                    let _ = sink_handle.emit(EVENT_RUNTIME_EVENT, event);
                }
                BridgeNotice::Status(status) => {
                    let _ = sink_handle.emit(EVENT_RUNTIME_STATUS, status);
                }
                BridgeNotice::Log(line) => eprintln!("{line}"),
            });
            let bridge = tauri::async_runtime::block_on(async move { RuntimeBridge::start(launch, sink) });
            app.manage(AppState { bridge });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::runtime_status,
            commands::runtime_request,
            commands::system_report,
            commands::native_init_checks,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build MORROW");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let bridge = handle.state::<AppState>().bridge.clone();
            tauri::async_runtime::block_on(bridge.shutdown(Duration::from_secs(3)));
        }
    });
}
