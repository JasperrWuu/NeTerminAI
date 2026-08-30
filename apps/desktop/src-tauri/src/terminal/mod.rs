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

const OUTPUT_EVENT: &str = "terminal:output";
const EXIT_EVENT: &str = "terminal:exit";

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
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("无法创建本地终端：{error}"))?;

        let mut command = shell_command(profile);
        command.env("TERM", "xterm-256color");

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("无法启动 PowerShell：{error}"))?;

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

        spawn_output_reader(app, session_id, reader);
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

fn spawn_output_reader(app: AppHandle, session_id: String, mut reader: Box<dyn Read + Send>) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(length) => {
                    let output = TerminalOutput {
                        session_id: session_id.clone(),
                        data: STANDARD.encode(&buffer[..length]),
                    };

                    if app.emit(OUTPUT_EVENT, output).is_err() {
                        break;
                    }
                }
            }
        }

        let _ = app.emit(
            EXIT_EVENT,
            TerminalExit {
                session_id: session_id.clone(),
            },
        );
        let _ = app.state::<TerminalManager>().close(&session_id);
    });
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
    }
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

        assert_eq!(powershell.get_argv()[0].to_string_lossy(), "powershell.exe");
        assert_eq!(command_prompt.get_argv()[0].to_string_lossy(), "cmd.exe");
    }
}
