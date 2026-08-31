use serde::Deserialize;
use std::{fs, path::PathBuf, process::Command, thread};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RdpDisplayMode {
    Windowed,
    Fullscreen,
    Multimon,
}

#[tauri::command]
pub fn open_rdp(
    session_id: String,
    host: String,
    port: u16,
    username: String,
    display_mode: RdpDisplayMode,
    admin_session: bool,
) -> Result<(), String> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("RDP 会话标识无效".to_owned());
    }
    if host.trim().is_empty() || port == 0 {
        return Err("RDP 主机地址或端口无效".to_owned());
    }
    validate_rdp_field("主机地址", &host)?;
    validate_rdp_field("账号", &username)?;
    let config_path = write_rdp_file(&session_id, &host, port, &username)?;
    let mut command = Command::new("mstsc.exe");
    command.arg(&config_path).arg("/prompt");
    match display_mode {
        RdpDisplayMode::Windowed => {}
        RdpDisplayMode::Fullscreen => {
            command.arg("/f");
        }
        RdpDisplayMode::Multimon => {
            command.arg("/multimon");
        }
    }
    if admin_session {
        command.arg("/admin");
    }

    match command.spawn() {
        Ok(mut child) => {
            thread::spawn(move || {
                let _ = child.wait();
                let _ = fs::remove_file(config_path);
            });
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(config_path);
            Err(format!("无法启动 Windows 远程桌面：{error}"))
        }
    }
}

fn validate_rdp_field(label: &str, value: &str) -> Result<(), String> {
    if value.contains(['\r', '\n']) {
        return Err(format!("{label}包含无效换行符"));
    }
    Ok(())
}

fn write_rdp_file(
    session_id: &str,
    host: &str,
    port: u16,
    username: &str,
) -> Result<PathBuf, String> {
    let directory = std::env::temp_dir().join("NeTerminAI").join("rdp");
    fs::create_dir_all(&directory).map_err(|error| format!("无法准备 RDP 临时目录：{error}"))?;
    let path = directory.join(format!("{session_id}.rdp"));
    let config = format!(
        "full address:s:{host}:{port}\r\nusername:s:{username}\r\nprompt for credentials:i:1\r\nauthentication level:i:2\r\n"
    );
    let mut bytes = vec![0xff, 0xfe];
    bytes.extend(config.encode_utf16().flat_map(u16::to_le_bytes));
    fs::write(&path, bytes).map_err(|error| format!("无法创建 RDP 配置：{error}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_rdp_configuration_injection() {
        assert!(validate_rdp_field("主机地址", "server\r\nredirectclipboard:i:1").is_err());
        assert!(validate_rdp_field("账号", "DOMAIN\\user").is_ok());
    }

    #[test]
    fn writes_utf16_rdp_configuration_without_a_password() {
        let path = write_rdp_file("rdp-test", "server.example", 3390, "DOMAIN\\user")
            .expect("write config");
        let bytes = fs::read(&path).expect("read config");
        let (chunks, remainder) = bytes[2..].as_chunks::<2>();
        assert!(remainder.is_empty());
        let words = chunks
            .iter()
            .map(|chunk| u16::from_le_bytes(*chunk))
            .collect::<Vec<_>>();
        let config = String::from_utf16(&words).expect("decode config");

        assert!(config.contains("full address:s:server.example:3390"));
        assert!(config.contains("username:s:DOMAIN\\user"));
        assert!(!config.to_lowercase().contains("password"));
        let _ = fs::remove_file(path);
    }
}
