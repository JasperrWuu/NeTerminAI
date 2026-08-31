use tauri::{AppHandle, State};

use crate::terminal::TerminalManager;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_ssh(
    app: AppHandle,
    manager: State<'_, TerminalManager>,
    session_id: String,
    host: String,
    port: u16,
    username: String,
    identity_file: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    manager.create_ssh(
        app,
        session_id,
        host,
        port,
        username,
        identity_file,
        columns,
        rows,
    )
}

#[tauri::command]
pub fn write_ssh(
    manager: State<'_, TerminalManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    manager.write(&session_id, data.as_bytes())
}

#[tauri::command]
pub fn resize_ssh(
    manager: State<'_, TerminalManager>,
    session_id: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&session_id, columns, rows)
}

#[tauri::command]
pub fn close_ssh(manager: State<'_, TerminalManager>, session_id: String) -> Result<(), String> {
    manager.close(&session_id)
}
