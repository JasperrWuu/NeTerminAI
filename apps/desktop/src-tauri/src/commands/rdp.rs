use tauri::{AppHandle, Manager, State};

use crate::rdp::{RdpBounds, RdpManager, RdpRuntimeStatus};

use super::run_blocking;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_rdp(
    app: AppHandle,
    state: State<'_, RdpManager>,
    session_id: String,
    host: String,
    port: u16,
    username: String,
    admin_session: bool,
    bounds: RdpBounds,
) -> Result<(), String> {
    let manager = state.inner().clone();
    let cancellation = manager.begin(&session_id)?;
    let cleanup_manager = manager.clone();
    let cleanup_session_id = session_id.clone();
    let cleanup_cancellation = cancellation.clone();
    let result = on_main_thread(app, "RDP 创建", move |app| {
        #[cfg(windows)]
        {
            let window = app.get_webview_window("main").ok_or("找不到主窗口")?;
            let parent = window
                .hwnd()
                .map_err(|error| format!("无法读取主窗口：{error}"))?;
            let scale = window
                .scale_factor()
                .map_err(|error| format!("无法读取窗口缩放：{error}"))?;
            manager.create(
                parent,
                session_id,
                &host,
                port,
                &username,
                admin_session,
                bounds.physical(scale),
                cancellation,
            )
        }
        #[cfg(not(windows))]
        {
            let _ = (
                app,
                session_id,
                host,
                port,
                username,
                admin_session,
                bounds,
                cancellation,
            );
            manager.unsupported()
        }
    })
    .await;
    if result.is_err() {
        cleanup_manager.cancel_connecting(&cleanup_session_id, &cleanup_cancellation);
    }
    result
}

#[tauri::command]
pub async fn resize_rdp(
    app: AppHandle,
    state: State<'_, RdpManager>,
    session_id: String,
    bounds: RdpBounds,
    visible: bool,
) -> Result<(), String> {
    let manager = state.inner().clone();
    on_main_thread(app, "RDP 调整", move |app| {
        #[cfg(windows)]
        {
            let window = app.get_webview_window("main").ok_or("找不到主窗口")?;
            let scale = window
                .scale_factor()
                .map_err(|error| format!("无法读取窗口缩放：{error}"))?;
            manager.resize(&session_id, bounds.physical(scale), visible)
        }
        #[cfg(not(windows))]
        {
            let _ = (app, session_id, bounds, visible);
            manager.unsupported()
        }
    })
    .await
}

#[tauri::command]
pub async fn get_rdp_status(
    app: AppHandle,
    state: State<'_, RdpManager>,
    session_id: String,
) -> Result<RdpRuntimeStatus, String> {
    let manager = state.inner().clone();
    on_main_thread(app, "RDP 状态读取", move |_app| {
        #[cfg(windows)]
        {
            manager.status(&session_id)
        }
        #[cfg(not(windows))]
        {
            let _ = session_id;
            manager.unsupported()?;
            unreachable!()
        }
    })
    .await
}

#[tauri::command]
pub async fn close_rdp(
    app: AppHandle,
    state: State<'_, RdpManager>,
    session_id: String,
) -> Result<(), String> {
    let manager = state.inner().clone();
    on_main_thread(app, "RDP 关闭", move |_app| {
        #[cfg(windows)]
        {
            manager.close(&session_id)
        }
        #[cfg(not(windows))]
        {
            let _ = session_id;
            manager.unsupported()
        }
    })
    .await
}

async fn on_main_thread<T, F>(
    app: AppHandle,
    label: &'static str,
    operation: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
{
    run_blocking(label, move || {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let task_app = app.clone();
        app.run_on_main_thread(move || {
            let _ = sender.send(operation(task_app));
        })
        .map_err(|error| format!("无法调度{label}：{error}"))?;
        receiver
            .recv()
            .map_err(|_| format!("{label}没有返回结果"))?
    })
    .await
}
