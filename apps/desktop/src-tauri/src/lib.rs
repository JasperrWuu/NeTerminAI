use tauri::Manager;

pub(crate) mod ai_process;
mod commands;
pub(crate) mod connection_state;
pub(crate) mod io_pump;
#[allow(dead_code)]
pub(crate) mod lifecycle;
mod serial;
mod shutdown;
mod telnet;
mod terminal;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(terminal::TerminalManager::default())
        .manage(telnet::TelnetManager::default())
        .manage(serial::SerialManager::default())
        .manage(ai_process::AiProcessManager::default())
        .manage(shutdown::ShutdownCoordinator::default())
        .invoke_handler(tauri::generate_handler![
            commands::ai::run_ai_process,
            commands::ai::cancel_ai_process,
            commands::terminal::create_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            commands::telnet::create_telnet,
            commands::telnet::write_telnet,
            commands::telnet::resize_telnet,
            commands::telnet::close_telnet,
            commands::serial::create_serial,
            commands::serial::write_serial,
            commands::serial::close_serial,
            commands::serial::list_serial_ports,
            commands::fonts::list_system_fonts,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build NeTerminAI")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let coordinator = app.state::<shutdown::ShutdownCoordinator>();
                if coordinator.begin() {
                    api.prevent_exit();
                    coordinator.start(app.clone());
                } else if coordinator.is_running() {
                    api.prevent_exit();
                }
            }
        });
}
