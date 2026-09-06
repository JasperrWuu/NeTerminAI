use tauri::{AppHandle, Manager};

use crate::automation::{AutomationManager, AutomationRunRequest};

#[tauri::command]
pub fn start_automation(app: AppHandle, request: AutomationRunRequest) -> Result<(), String> {
    app.clone().state::<AutomationManager>().start(app, request)
}

#[tauri::command]
pub fn stop_automation(app: AppHandle, run_id: String) -> Result<(), String> {
    app.state::<AutomationManager>().stop(&run_id)
}
