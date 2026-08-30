mod commands;
mod telnet;
mod terminal;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(terminal::TerminalManager::default())
        .manage(telnet::TelnetManager::default())
        .invoke_handler(tauri::generate_handler![
            commands::terminal::create_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            commands::telnet::create_telnet,
            commands::telnet::write_telnet,
            commands::telnet::resize_telnet,
            commands::telnet::close_telnet,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run NeTerminAI");
}
