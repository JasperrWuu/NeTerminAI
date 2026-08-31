use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Arc<Mutex<TerminalSession>>>>,
}

#[derive(Clone, Copy, Deserialize)]
pub enum TerminalProfile {
    #[serde(rename = "powershell")]
    PowerShell,
    #[serde(rename = "commandPrompt")]
    CommandPrompt,
    #[serde(rename = "gitBash")]
    GitBash,
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
}

impl TerminalManager {
    pub fn create(
        &self,
        app: AppHandle,
        session_id: String,
        profile: TerminalProfile,
        columns: u16,
        rows: u16,
    ) -> Result<(), String> {
        self.create_command(
            app,
            session_id,
            shell_command(profile),
            columns,
            rows,
            "terminal",
            "本地终端",
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_ssh(
        &self,
        app: AppHandle,
        session_id: String,
        host: String,
        port: u16,
        username: String,
        identity_file: String,
        columns: u16,
        rows: u16,
    ) -> Result<(), String> {
        if host.trim().is_empty() || port == 0 {
            return Err("SSH 主机地址或端口无效".to_owned());
        }
        self.create_command(
            app,
            session_id,
            ssh_command(&host, port, &username, &identity_file),
            columns,
            rows,
            "ssh",
            "SSH 终端",
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn create_command(
        &self,
        app: AppHandle,
        session_id: String,
        mut command: CommandBuilder,
        columns: u16,
        rows: u16,
        event_prefix: &'static str,
        label: &str,
    ) -> Result<(), String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("无法创建{label}：{error}"))?;
        command.env("TERM", "xterm-256color");

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("无法启动{label}：{error}"))?;

        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("无法读取终端输出：{error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("无法写入终端：{error}"))?;

        self.sessions
            .lock()
            .map_err(|_| "终端会话状态不可用".to_owned())?
            .insert(
                session_id.clone(),
                Arc::new(Mutex::new(TerminalSession {
                    master: pair.master,
                    writer,
                    child,
                })),
            );

        spawn_output_reader(app, session_id, reader, event_prefix);
        Ok(())
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let session = self.session(session_id)?;
        let mut session = session
            .lock()
            .map_err(|_| "终端会话状态不可用".to_owned())?;

        session
            .writer
            .write_all(data)
            .and_then(|_| session.writer.flush())
            .map_err(|error| format!("终端输入失败：{error}"))
    }

    pub fn resize(&self, session_id: &str, columns: u16, rows: u16) -> Result<(), String> {
        let session = self.session(session_id)?;
        let session = session
            .lock()
            .map_err(|_| "终端会话状态不可用".to_owned())?;

        session
            .master
            .resize(PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("调整终端尺寸失败：{error}"))
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "终端会话状态不可用".to_owned())?
            .remove(session_id);
        drop(session);
        Ok(())
    }

    fn session(&self, session_id: &str) -> Result<Arc<Mutex<TerminalSession>>, String> {
        self.sessions
            .lock()
            .map_err(|_| "终端会话状态不可用".to_owned())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "终端会话不存在".to_owned())
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_output_reader(
    app: AppHandle,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    event_prefix: &'static str,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let output_event = format!("{event_prefix}:output");
        let exit_event = format!("{event_prefix}:exit");

        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(length) => {
                    let output = TerminalOutput {
                        session_id: session_id.clone(),
                        data: STANDARD.encode(&buffer[..length]),
                    };

                    if app.emit(&output_event, output).is_err() {
                        break;
                    }
                }
            }
        }

        let _ = app.emit(
            &exit_event,
            TerminalExit {
                session_id: session_id.clone(),
            },
        );
        let _ = app.state::<TerminalManager>().close(&session_id);
    });
}

#[cfg(target_os = "windows")]
fn ssh_command(host: &str, port: u16, username: &str, identity_file: &str) -> CommandBuilder {
    let mut command = CommandBuilder::new(ssh_executable());
    command.arg("-p");
    command.arg(port.to_string());
    command.args(["-o", "ConnectTimeout=10"]);
    command.args(["-o", "ServerAliveInterval=15"]);
    command.args(["-o", "ServerAliveCountMax=3"]);
    command.args(["-o", "TCPKeepAlive=yes"]);
    command.arg("-tt");
    if !identity_file.is_empty() {
        command.args(["-i", identity_file]);
    }
    command.arg(if username.is_empty() {
        host.to_owned()
    } else {
        format!("{username}@{host}")
    });
    command
}

#[cfg(target_os = "windows")]
fn ssh_executable() -> std::path::PathBuf {
    std::env::var_os("WINDIR")
        .map(|root| std::path::PathBuf::from(root).join("System32/OpenSSH/ssh.exe"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| std::path::PathBuf::from("ssh.exe"))
}

#[cfg(not(target_os = "windows"))]
fn ssh_command(host: &str, port: u16, username: &str, identity_file: &str) -> CommandBuilder {
    let mut command = CommandBuilder::new("ssh");
    command.arg("-p");
    command.arg(port.to_string());
    command.args(["-o", "ConnectTimeout=10"]);
    command.args(["-o", "ServerAliveInterval=15"]);
    command.args(["-o", "ServerAliveCountMax=3"]);
    command.args(["-o", "TCPKeepAlive=yes"]);
    command.arg("-tt");
    if !identity_file.is_empty() {
        command.args(["-i", identity_file]);
    }
    command.arg(if username.is_empty() {
        host.to_owned()
    } else {
        format!("{username}@{host}")
    });
    command
}

#[cfg(target_os = "windows")]
fn shell_command(profile: TerminalProfile) -> CommandBuilder {
    match profile {
        TerminalProfile::PowerShell => {
            let mut command = CommandBuilder::new("powershell.exe");
            command.arg("-NoLogo");
            command
        }
        TerminalProfile::CommandPrompt => CommandBuilder::new("cmd.exe"),
        TerminalProfile::GitBash => {
            let mut command = CommandBuilder::new(git_bash_executable());
            command.arg("--login");
            command.arg("-i");
            command
        }
    }
}

#[cfg(target_os = "windows")]
fn git_bash_executable() -> std::path::PathBuf {
    let candidates = [
        std::env::var_os("ProgramFiles")
            .map(|root| std::path::PathBuf::from(root).join("Git/bin/bash.exe")),
        std::env::var_os("ProgramFiles(x86)")
            .map(|root| std::path::PathBuf::from(root).join("Git/bin/bash.exe")),
        std::env::var_os("LOCALAPPDATA")
            .map(|root| std::path::PathBuf::from(root).join("Programs/Git/bin/bash.exe")),
    ];

    candidates
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
        .unwrap_or_else(|| std::path::PathBuf::from("bash.exe"))
}

#[cfg(not(target_os = "windows"))]
fn shell_command(_profile: TerminalProfile) -> CommandBuilder {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned());
    CommandBuilder::new(shell)
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn local_profiles_map_to_distinct_shells() {
        let powershell = shell_command(TerminalProfile::PowerShell);
        let command_prompt = shell_command(TerminalProfile::CommandPrompt);
        let git_bash = shell_command(TerminalProfile::GitBash);

        assert_eq!(powershell.get_argv()[0].to_string_lossy(), "powershell.exe");
        assert_eq!(command_prompt.get_argv()[0].to_string_lossy(), "cmd.exe");
        assert!(
            git_bash.get_argv()[0]
                .to_string_lossy()
                .ends_with("bash.exe")
        );
        assert_eq!(git_bash.get_argv()[1].to_string_lossy(), "--login");
        assert_eq!(git_bash.get_argv()[2].to_string_lossy(), "-i");
    }

    #[test]
    fn ssh_command_preserves_security_and_keepalive_options() {
        let command = ssh_command("server.example", 2222, "operator", "C:\\keys\\id_ed25519");
        let arguments = command
            .get_argv()
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(arguments[0].ends_with("ssh.exe"));
        assert!(arguments.windows(2).any(|pair| pair == ["-p", "2222"]));
        assert!(
            arguments
                .windows(2)
                .any(|pair| pair == ["-o", "ConnectTimeout=10"])
        );
        assert!(
            arguments
                .windows(2)
                .any(|pair| pair == ["-o", "ServerAliveInterval=15"])
        );
        assert!(
            arguments
                .windows(2)
                .any(|pair| pair == ["-i", "C:\\keys\\id_ed25519"])
        );
        assert_eq!(
            arguments.last().map(String::as_str),
            Some("operator@server.example")
        );
    }
}
