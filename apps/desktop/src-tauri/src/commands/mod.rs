pub mod fonts;
pub mod rdp;
pub mod serial;
pub mod ssh;
pub mod telnet;
pub mod terminal;

pub(crate) async fn run_blocking<T, F>(label: &'static str, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("{label}任务异常结束：{error}"))?
}
