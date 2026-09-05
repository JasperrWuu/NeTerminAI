use tauri::{AppHandle, Manager};

use super::run_blocking;
use crate::ai_process::{AiProcessManager, AiProcessRequest, AiProcessResult};

#[tauri::command]
pub async fn run_ai_process(
    app: AppHandle,
    request: AiProcessRequest,
) -> Result<AiProcessResult, String> {
    let process_app = app.clone();
    let manager = app.state::<AiProcessManager>().clone();
    let cancellation = manager.register(&request.request_id)?;
    let request_id = request.request_id.clone();
    let result = run_blocking("AI 进程执行", move || {
        crate::ai_process::run(request, cancellation, Some(process_app))
    })
    .await;
    manager.remove(&request_id);
    result
}

#[tauri::command]
pub fn cancel_ai_process(app: AppHandle, request_id: String) -> Result<(), String> {
    if app.state::<AiProcessManager>().cancel(&request_id) {
        Ok(())
    } else {
        Err("[ai_not_found] AI 请求不存在".to_owned())
    }
}
