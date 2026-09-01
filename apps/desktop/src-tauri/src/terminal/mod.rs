use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Sender},
    },
    thread,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, TerminalSessionState>>,
}

enum TerminalSessionState {
    Connecting(Arc<AtomicBool>),
    Connected {
        cancellation: Arc<AtomicBool>,
        session: Arc<Mutex<TerminalSession>>,
    },
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
    writer: Sender<TerminalWriterMessage>,
    child: Box<dyn Child + Send + Sync>,
}

enum TerminalWriterMessage {
    Bytes(Vec<u8>),
    Shutdown,
}

struct TerminalResources {
    reader: Box<dyn Read + Send>,
    session: Arc<Mutex<TerminalSession>>,
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
    pub fn begin(&self, session_id: &str) -> Result<Arc<AtomicBool>, String> {
        let cancellation = Arc::new(AtomicBool::new(false));
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "终端会话状态不可用".to_owned())?;
        match sessions.entry(session_id.to_owned()) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(TerminalSessionState::Connecting(Arc::clone(&cancellation)));
            }
            std::collections::hash_map::Entry::Occupied(_) => {
                return Err("终端会话已存在".to_owned());
            }
        }
        Ok(cancellation)
    }

    pub fn create(
        &self,
        app: AppHandle,
        session_id: String,
        profile: TerminalProfile,
        columns: u16,
        rows: u16,
        cancellation: Arc<AtomicBool>,
    ) -> Result<(), String> {
        self.create_command(
            app,
            session_id,
            shell_command(profile),
            columns,
            rows,
            "terminal",
            "本地终端",
            cancellation,
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
        cancellation: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let host = host.trim();
        let username = username.trim();
        if host.is_empty() || port == 0 {
            self.remove_if_connecting(&session_id, &cancellation);
            return Err("SSH 主机地址或端口无效".to_owned());
        }
        if host.contains(['\r', '\n']) || username.contains(['\r', '\n']) {
            self.remove_if_connecting(&session_id, &cancellation);
            return Err("SSH 主机地址或账号包含无效换行符".to_owned());
        }
        self.create_command(
            app,
            session_id,
            ssh_command(host, port, username, &identity_file),
            columns,
            rows,
            "ssh",
            "SSH 终端",
            cancellation,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn create_command(
        &self,
        app: AppHandle,
        session_id: String,
        command: CommandBuilder,
        columns: u16,
        rows: u16,
        event_prefix: &'static str,
        label: &str,
        cancellation: Arc<AtomicBool>,
    ) -> Result<(), String> {
        if cancellation.load(Ordering::Acquire) {
            self.remove_if_connecting(&session_id, &cancellation);
            return Err(format!("{label}启动已取消"));
        }

        let resources = self.open_command_resources(command, columns, rows, label);
        let TerminalResources { reader, session } = match resources {
            Ok(resources) => resources,
            Err(error) => {
                self.remove_if_connecting(&session_id, &cancellation);
                return Err(error);
            }
        };

        if cancellation.load(Ordering::Acquire) {
            self.remove_if_connecting(&session_id, &cancellation);
            return Err(format!("{label}启动已取消"));
        }

        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "终端会话状态不可用".to_owned())?;
            match sessions.get(&session_id) {
                Some(TerminalSessionState::Connecting(current))
                    if Arc::ptr_eq(current, &cancellation) =>
                {
                    sessions.insert(
                        session_id.clone(),
                        TerminalSessionState::Connected {
                            cancellation: Arc::clone(&cancellation),
                            session,
                        },
                    );
                }
                _ => return Err(format!("{label}启动已取消")),
            }
        }

        spawn_output_reader(app, session_id, reader, event_prefix, cancellation);
        Ok(())
    }

    fn open_command_resources(
        &self,
        mut command: CommandBuilder,
        columns: u16,
        rows: u16,
        label: &str,
    ) -> Result<TerminalResources, String> {
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
        let (writer_sender, writer_receiver) = mpsc::channel();
        spawn_input_writer(writer, writer_receiver);

        Ok(TerminalResources {
            reader,
            session: Arc::new(Mutex::new(TerminalSession {
                master: pair.master,
                writer: writer_sender,
                child,
            })),
        })
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let session = self.session(session_id)?;
        let writer = session
            .lock()
            .map_err(|_| "终端会话状态不可用".to_owned())?
            .writer
            .clone();
        writer
            .send(TerminalWriterMessage::Bytes(data.to_vec()))
            .map_err(|_| "终端输入通道已关闭".to_owned())
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
        let state = self
            .sessions
            .lock()
            .map_err(|_| "终端会话状态不可用".to_owned())?
            .remove(session_id);
        match &state {
            Some(TerminalSessionState::Connecting(cancellation))
            | Some(TerminalSessionState::Connected { cancellation, .. }) => {
                cancellation.store(true, Ordering::Release);
            }
            None => {}
        }
        drop(state);
        Ok(())
    }

    fn session(&self, session_id: &str) -> Result<Arc<Mutex<TerminalSession>>, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "终端会话状态不可用".to_owned())?;
        match sessions.get(session_id) {
            Some(TerminalSessionState::Connected { session, .. }) => Ok(Arc::clone(session)),
            Some(TerminalSessionState::Connecting(_)) => Err("终端仍在启动中".to_owned()),
            None => Err("终端会话不存在".to_owned()),
        }
    }

    fn remove_if_connecting(&self, session_id: &str, cancellation: &Arc<AtomicBool>) {
        if let Ok(mut sessions) = self.sessions.lock()
            && matches!(
                sessions.get(session_id),
                Some(TerminalSessionState::Connecting(current)) if Arc::ptr_eq(current, cancellation)
            )
        {
            sessions.remove(session_id);
        }
    }

    fn close_if_current(
        &self,
        session_id: &str,
        cancellation: &Arc<AtomicBool>,
    ) -> Result<(), String> {
        let state = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "终端会话状态不可用".to_owned())?;
            let is_current = matches!(
                sessions.get(session_id),
                Some(TerminalSessionState::Connecting(current)) if Arc::ptr_eq(current, cancellation)
            ) || matches!(
                sessions.get(session_id),
                Some(TerminalSessionState::Connected { cancellation: current, .. })
                    if Arc::ptr_eq(current, cancellation)
            );
            is_current.then(|| sessions.remove(session_id)).flatten()
        };
        if state.is_some() {
            cancellation.store(true, Ordering::Release);
        }
        drop(state);
        Ok(())
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = self.writer.send(TerminalWriterMessage::Shutdown);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_input_writer(
    mut writer: Box<dyn Write + Send>,
    receiver: mpsc::Receiver<TerminalWriterMessage>,
) {
    thread::spawn(move || {
        while let Ok(message) = receiver.recv() {
            match message {
                TerminalWriterMessage::Bytes(bytes) => {
                    if writer
                        .write_all(&bytes)
                        .and_then(|_| writer.flush())
                        .is_err()
                    {
                        break;
                    }
                }
                TerminalWriterMessage::Shutdown => break,
            }
        }
    });
}

fn spawn_output_reader(
    app: AppHandle,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    event_prefix: &'static str,
    cancellation: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let output_event = format!("{event_prefix}:output");
        let exit_event = format!("{event_prefix}:exit");

        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(length) => {
                    if cancellation.load(Ordering::Acquire) {
                        break;
                    }
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
        let _ = app
            .state::<TerminalManager>()
            .close_if_current(&session_id, &cancellation);
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
    command.arg("--");
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
    command.arg("--");
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
        assert_eq!(arguments[arguments.len() - 2], "--");
        assert_eq!(
            arguments.last().map(String::as_str),
            Some("operator@server.example")
        );
    }

    #[test]
    fn connecting_terminal_can_be_cancelled_immediately() {
        let manager = TerminalManager::default();
        let cancellation = manager.begin("pending").expect("begin session");

        manager.close("pending").expect("close session");

        assert!(cancellation.load(Ordering::Acquire));
        assert!(manager.sessions.lock().expect("read sessions").is_empty());
    }

    #[test]
    fn duplicate_terminal_session_id_is_rejected() {
        let manager = TerminalManager::default();
        manager.begin("duplicate").expect("begin session");

        assert!(manager.begin("duplicate").is_err());
    }

    #[test]
    fn stale_terminal_attempt_cannot_remove_a_newer_session() {
        let manager = TerminalManager::default();
        let current = manager.begin("current").expect("begin session");
        let stale = Arc::new(AtomicBool::new(false));

        manager
            .close_if_current("current", &stale)
            .expect("ignore stale close");

        assert!(
            manager
                .sessions
                .lock()
                .expect("read sessions")
                .contains_key("current")
        );
        manager.close("current").expect("close session");
        assert!(current.load(Ordering::Acquire));
    }
}
