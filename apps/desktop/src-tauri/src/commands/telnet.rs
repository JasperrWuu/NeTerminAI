use tauri::{AppHandle, Manager};

use super::run_blocking;
use crate::telnet::TelnetManager;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_telnet(
    app: AppHandle,
    session_id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    let cancellation = app.state::<TelnetManager>().begin(&session_id)?;
    let state_app = app.clone();
    run_blocking("Telnet 连接", move || {
        state_app.state::<TelnetManager>().create(
            app,
            session_id,
            host,
            port,
            username,
            password,
            columns,
            rows,
            cancellation,
        )
    })
    .await
}

#[tauri::command]
pub fn write_telnet(app: AppHandle, session_id: String, data: String) -> Result<(), String> {
    app.state::<TelnetManager>()
        .write(&session_id, data.as_bytes())
}

#[tauri::command]
pub fn resize_telnet(
    app: AppHandle,
    session_id: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    app.state::<TelnetManager>()
        .resize(&session_id, columns, rows)
}

#[tauri::command]
pub async fn close_telnet(app: AppHandle, session_id: String) -> Result<(), String> {
    run_blocking("Telnet 关闭", move || {
        app.state::<TelnetManager>().close(&session_id)
    })
    .await
}
