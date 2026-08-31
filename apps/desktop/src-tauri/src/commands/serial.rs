use tauri::{AppHandle, Manager, State};

use crate::serial::{SerialFlowControl, SerialManager, SerialParity};

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_serial(
    app: AppHandle,
    session_id: String,
    port_name: String,
    baud_rate: u32,
    data_bits: u8,
    stop_bits: u8,
    parity: SerialParity,
    flow_control: SerialFlowControl,
) -> Result<(), String> {
    let cancellation = app.state::<SerialManager>().begin(&session_id)?;
    let state_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        state_app.state::<SerialManager>().create(
            app,
            session_id,
            port_name,
            baud_rate,
            data_bits,
            stop_bits,
            parity,
            flow_control,
            cancellation,
        )
    })
    .await
    .map_err(|error| format!("串口连接任务异常结束：{error}"))?
}

#[tauri::command]
pub fn write_serial(
    manager: State<'_, SerialManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    manager.write(&session_id, data.as_bytes())
}

#[tauri::command]
pub fn close_serial(manager: State<'_, SerialManager>, session_id: String) -> Result<(), String> {
    manager.close(&session_id)
}

#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<String>, String> {
    crate::serial::available_ports()
}
