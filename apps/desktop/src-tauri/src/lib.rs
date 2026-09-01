mod commands;
mod rdp;
mod serial;
mod telnet;
mod terminal;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(terminal::TerminalManager::default())
        .manage(telnet::TelnetManager::default())
        .manage(serial::SerialManager::default())
        .manage(rdp::RdpManager::default())
        .invoke_handler(tauri::generate_handler![
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
            commands::ssh::create_ssh,
            commands::ssh::write_ssh,
            commands::ssh::resize_ssh,
            commands::ssh::close_ssh,
            commands::rdp::create_rdp,
            commands::rdp::get_rdp_status,
            commands::rdp::resize_rdp,
            commands::rdp::focus_rdp,
            commands::rdp::close_rdp,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run NeTerminAI");
}
