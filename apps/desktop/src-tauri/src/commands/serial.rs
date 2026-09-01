use tauri::{AppHandle, Manager};

use super::run_blocking;
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
    run_blocking("串口连接", move || {
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
}

#[tauri::command]
pub fn write_serial(app: AppHandle, session_id: String, data: String) -> Result<(), String> {
    app.state::<SerialManager>()
        .write(&session_id, data.as_bytes())
}

#[tauri::command]
pub async fn close_serial(app: AppHandle, session_id: String) -> Result<(), String> {
    run_blocking("串口关闭", move || {
        app.state::<SerialManager>().close(&session_id)
    })
    .await
}

#[tauri::command]
pub async fn list_serial_ports() -> Result<Vec<String>, String> {
    run_blocking("串口检测", crate::serial::available_ports).await
}
