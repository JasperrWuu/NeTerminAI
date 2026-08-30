use tauri::{AppHandle, State};

use crate::terminal::{TerminalManager, TerminalProfile};

#[tauri::command]
pub fn create_terminal(
    app: AppHandle,
    manager: State<'_, TerminalManager>,
    session_id: String,
    profile: TerminalProfile,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    manager.create(app, session_id, profile, columns, rows)
}

#[tauri::command]
pub fn write_terminal(
    manager: State<'_, TerminalManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    manager.write(&session_id, data.as_bytes())
}

#[tauri::command]
pub fn resize_terminal(
    manager: State<'_, TerminalManager>,
    session_id: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&session_id, columns, rows)
}

#[tauri::command]
pub fn close_terminal(
    manager: State<'_, TerminalManager>,
    session_id: String,
) -> Result<(), String> {
    manager.close(&session_id)
}
