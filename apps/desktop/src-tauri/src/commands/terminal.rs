use tauri::{AppHandle, Manager};

use super::run_blocking;
use crate::terminal::{TerminalManager, TerminalProfile};

#[tauri::command]
pub async fn create_terminal(
    app: AppHandle,
    session_id: String,
    profile: TerminalProfile,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    let state_app = app.clone();
    run_blocking("本地终端启动", move || {
        state_app
            .state::<TerminalManager>()
            .create(app, session_id, profile, columns, rows)
    })
    .await
}

#[tauri::command]
pub async fn write_terminal(
    app: AppHandle,
    session_id: String,
    data: String,
) -> Result<(), String> {
    run_blocking("本地终端输入", move || {
        app.state::<TerminalManager>()
            .write(&session_id, data.as_bytes())
    })
    .await
}

#[tauri::command]
pub async fn resize_terminal(
    app: AppHandle,
    session_id: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    run_blocking("本地终端尺寸调整", move || {
        app.state::<TerminalManager>()
            .resize(&session_id, columns, rows)
    })
    .await
}

#[tauri::command]
pub async fn close_terminal(app: AppHandle, session_id: String) -> Result<(), String> {
    run_blocking("本地终端关闭", move || {
        app.state::<TerminalManager>().close(&session_id)
    })
    .await
}
