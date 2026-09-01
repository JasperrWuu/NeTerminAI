use tauri::{AppHandle, Manager};

use super::run_blocking;
use crate::terminal::{SshAuthentication, TerminalManager};

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_ssh(
    app: AppHandle,
    session_id: String,
    host: String,
    port: u16,
    username: String,
    authentication: SshAuthentication,
    identity_file: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    let cancellation = app.state::<TerminalManager>().begin(&session_id)?;
    let state_app = app.clone();
    run_blocking("SSH 启动", move || {
        state_app.state::<TerminalManager>().create_ssh(
            app,
            session_id,
            host,
            port,
            username,
            authentication,
            identity_file,
            columns,
            rows,
            cancellation,
        )
    })
    .await
}

#[tauri::command]
pub async fn write_ssh(app: AppHandle, session_id: String, data: String) -> Result<(), String> {
    run_blocking("SSH 输入", move || {
        app.state::<TerminalManager>()
            .write(&session_id, data.as_bytes())
    })
    .await
}

#[tauri::command]
pub async fn resize_ssh(
    app: AppHandle,
    session_id: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    run_blocking("SSH 尺寸调整", move || {
        app.state::<TerminalManager>()
            .resize(&session_id, columns, rows)
    })
    .await
}

#[tauri::command]
pub async fn close_ssh(app: AppHandle, session_id: String) -> Result<(), String> {
    run_blocking("SSH 关闭", move || {
        app.state::<TerminalManager>().close(&session_id)
    })
    .await
}
