use tauri::{AppHandle, Manager, State};

use crate::telnet::{TelnetLoginMode, TelnetManager};

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_telnet(
    app: AppHandle,
    session_id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    login_mode: TelnetLoginMode,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    let cancellation = app.state::<TelnetManager>().begin(&session_id)?;
    let state_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        state_app.state::<TelnetManager>().create(
            app,
            session_id,
            host,
            port,
            username,
            password,
            login_mode,
            columns,
            rows,
            cancellation,
        )
    })
    .await
    .map_err(|error| format!("Telnet 连接任务异常结束：{error}"))?
}

#[tauri::command]
pub fn write_telnet(
    manager: State<'_, TelnetManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    manager.write(&session_id, data.as_bytes())
}

#[tauri::command]
pub fn resize_telnet(
    manager: State<'_, TelnetManager>,
    session_id: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&session_id, columns, rows)
}

#[tauri::command]
pub fn close_telnet(manager: State<'_, TelnetManager>, session_id: String) -> Result<(), String> {
    manager.close(&session_id)
}
