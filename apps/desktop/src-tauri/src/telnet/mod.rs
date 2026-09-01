use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    net::{Shutdown, TcpStream, ToSocketAddrs},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Sender},
    },
    thread,
    time::Duration,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
const BINARY: u8 = 0;
const ECHO: u8 = 1;
const SUPPRESS_GO_AHEAD: u8 = 3;
const TERMINAL_TYPE: u8 = 24;
const NAWS: u8 = 31;

const OUTPUT_EVENT: &str = "telnet:output";
const EXIT_EVENT: &str = "telnet:exit";

#[derive(Default)]
pub struct TelnetManager {
    sessions: Mutex<HashMap<String, SessionState>>,
}

enum SessionState {
    Connecting(Arc<AtomicBool>),
    Connected(TelnetSession),
}

struct TelnetSession {
    writer: Sender<WriterMessage>,
    control: TcpStream,
    cancellation: Arc<AtomicBool>,
    window_size_enabled: Arc<AtomicBool>,
}

struct LoginCredentials {
    username: String,
    password: String,
}

struct TerminalGeometry {
    columns: u16,
    rows: u16,
    window_size_enabled: Arc<AtomicBool>,
}

enum WriterMessage {
    Bytes(Vec<u8>),
    Shutdown,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TelnetOutput {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TelnetExit {
    session_id: String,
}

impl TelnetManager {
    pub fn begin(&self, session_id: &str) -> Result<Arc<AtomicBool>, String> {
        let cancellation = Arc::new(AtomicBool::new(false));
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Telnet 会话状态不可用".to_owned())?;
        match sessions.entry(session_id.to_owned()) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(SessionState::Connecting(Arc::clone(&cancellation)));
            }
            std::collections::hash_map::Entry::Occupied(_) => {
                return Err("Telnet 会话已存在".to_owned());
            }
        }
        Ok(cancellation)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        app: AppHandle,
        session_id: String,
        host: String,
        port: u16,
        username: String,
        password: String,
        columns: u16,
        rows: u16,
        cancellation: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let connection = connect(&host, port);
        if cancellation.load(Ordering::Acquire) {
            if let Ok(stream) = connection {
                let _ = stream.shutdown(Shutdown::Both);
            }
            return Err("Telnet 连接已取消".to_owned());
        }
        let stream = match connection {
            Ok(stream) => stream,
            Err(error) => {
                self.remove_if_connecting(&session_id, &cancellation);
                return Err(error);
            }
        };
        let reader = match stream.try_clone() {
            Ok(reader) => reader,
            Err(error) => {
                self.remove_if_connecting(&session_id, &cancellation);
                return Err(format!("无法读取 Telnet 连接：{error}"));
            }
        };
        let control = match stream.try_clone() {
            Ok(control) => control,
            Err(error) => {
                self.remove_if_connecting(&session_id, &cancellation);
                return Err(format!("无法管理 Telnet 连接：{error}"));
            }
        };
        let (writer, receiver) = mpsc::channel();
        let window_size_enabled = Arc::new(AtomicBool::new(false));

        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Telnet 会话状态不可用".to_owned())?;
            match sessions.get(&session_id) {
                Some(SessionState::Connecting(current)) if Arc::ptr_eq(current, &cancellation) => {
                    sessions.insert(
                        session_id.clone(),
                        SessionState::Connected(TelnetSession {
                            writer: writer.clone(),
                            control,
                            cancellation: Arc::clone(&cancellation),
                            window_size_enabled: Arc::clone(&window_size_enabled),
                        }),
                    );
                }
                _ => {
                    let _ = stream.shutdown(Shutdown::Both);
                    return Err("Telnet 连接已取消".to_owned());
                }
            }
        }

        spawn_writer(stream, receiver);
        spawn_reader(
            app,
            session_id,
            reader,
            writer,
            LoginCredentials { username, password },
            TerminalGeometry {
                columns,
                rows,
                window_size_enabled,
            },
            cancellation,
        );
        Ok(())
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        self.send(session_id, WriterMessage::Bytes(escape_iac(data)))
    }

    pub fn resize(&self, session_id: &str, columns: u16, rows: u16) -> Result<(), String> {
        let writer = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "Telnet 会话状态不可用".to_owned())?;
            match sessions.get(session_id) {
                Some(SessionState::Connected(session)) => {
                    if !session.window_size_enabled.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    session.writer.clone()
                }
                Some(SessionState::Connecting(_)) => return Ok(()),
                None => return Err("Telnet 会话不存在".to_owned()),
            }
        };
        writer
            .send(WriterMessage::Bytes(window_size_message(columns, rows)))
            .map_err(|_| "Telnet 连接已关闭".to_owned())
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "Telnet 会话状态不可用".to_owned())?
            .remove(session_id);

        stop_session(session);
        Ok(())
    }

    fn close_if_current(
        &self,
        session_id: &str,
        cancellation: &Arc<AtomicBool>,
    ) -> Result<(), String> {
        let session = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Telnet 会话状态不可用".to_owned())?;
            let is_current = matches!(
                sessions.get(session_id),
                Some(SessionState::Connecting(current)) if Arc::ptr_eq(current, cancellation)
            ) || matches!(
                sessions.get(session_id),
                Some(SessionState::Connected(session))
                    if Arc::ptr_eq(&session.cancellation, cancellation)
            );
            is_current.then(|| sessions.remove(session_id)).flatten()
        };
        stop_session(session);
        Ok(())
    }

    fn send(&self, session_id: &str, message: WriterMessage) -> Result<(), String> {
        let writer = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "Telnet 会话状态不可用".to_owned())?;
            match sessions.get(session_id) {
                Some(SessionState::Connected(session)) => session.writer.clone(),
                Some(SessionState::Connecting(_)) => {
                    return Err("Telnet 仍在连接中".to_owned());
                }
                None => return Err("Telnet 会话不存在".to_owned()),
            }
        };
        writer
            .send(message)
            .map_err(|_| "Telnet 连接已关闭".to_owned())
    }

    fn remove_if_connecting(&self, session_id: &str, cancellation: &Arc<AtomicBool>) {
        if let Ok(mut sessions) = self.sessions.lock()
            && matches!(
                sessions.get(session_id),
                Some(SessionState::Connecting(current)) if Arc::ptr_eq(current, cancellation)
            )
        {
            sessions.remove(session_id);
        }
    }
}

fn stop_session(session: Option<SessionState>) {
    match session {
        Some(SessionState::Connecting(cancellation)) => {
            cancellation.store(true, Ordering::Release);
        }
        Some(SessionState::Connected(session)) => {
            session.cancellation.store(true, Ordering::Release);
            let _ = session.control.shutdown(Shutdown::Both);
            let _ = session.writer.send(WriterMessage::Shutdown);
        }
        None => {}
    }
}

fn connect(host: &str, port: u16) -> Result<TcpStream, String> {
    let host = host.trim();
    if host.is_empty() || port == 0 {
        return Err("Telnet 主机地址或端口无效".to_owned());
    }
    let address = format!("{host}:{port}");
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("无法解析 Telnet 地址：{error}"))?;
    let mut last_error = None;

    for socket_address in addresses {
        match TcpStream::connect_timeout(&socket_address, Duration::from_secs(5)) {
            Ok(stream) => {
                stream
                    .set_nodelay(true)
                    .map_err(|error| format!("无法配置 Telnet 连接：{error}"))?;
                stream
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .map_err(|error| format!("无法配置 Telnet 写入超时：{error}"))?;
                return Ok(stream);
            }
            Err(error) => last_error = Some(error),
        }
    }

    Err(last_error.map_or_else(
        || "没有找到可用的 Telnet 地址".to_owned(),
        |error| format!("无法连接到 {address}：{error}"),
    ))
}

fn spawn_writer(mut stream: TcpStream, receiver: mpsc::Receiver<WriterMessage>) {
    thread::spawn(move || {
        while let Ok(message) = receiver.recv() {
            match message {
                WriterMessage::Bytes(bytes) => {
                    if stream
                        .write_all(&bytes)
                        .and_then(|_| stream.flush())
                        .is_err()
                    {
                        break;
                    }
                }
                WriterMessage::Shutdown => break,
            }
        }
        let _ = stream.shutdown(Shutdown::Both);
    });
}

fn spawn_reader(
    app: AppHandle,
    session_id: String,
    mut reader: TcpStream,
    writer: Sender<WriterMessage>,
    credentials: LoginCredentials,
    geometry: TerminalGeometry,
    cancellation: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let mut protocol = TelnetProtocol::new(
            geometry.columns,
            geometry.rows,
            geometry.window_size_enabled,
        );
        let mut prompt = String::new();
        let mut username_sent = credentials.username.is_empty();
        let mut password_sent = credentials.password.is_empty();

        loop {
            if cancellation.load(Ordering::Acquire) {
                break;
            }
            let length = match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(length) => length,
            };
            let frame = protocol.decode(&buffer[..length]);
            for response in frame.responses {
                if writer.send(WriterMessage::Bytes(response)).is_err() {
                    break;
                }
            }
            if frame.output.is_empty() {
                continue;
            }

            append_prompt_text(&mut prompt, &frame.output);
            if !username_sent && (prompt.contains("login:") || prompt.contains("username:")) {
                let _ = writer.send(WriterMessage::Bytes(line_message(&credentials.username)));
                username_sent = true;
                prompt.clear();
            } else if username_sent && !password_sent && prompt.contains("password:") {
                let _ = writer.send(WriterMessage::Bytes(line_message(&credentials.password)));
                password_sent = true;
                prompt.clear();
            }

            let event = TelnetOutput {
                session_id: session_id.clone(),
                data: STANDARD.encode(frame.output),
            };
            if app.emit(OUTPUT_EVENT, event).is_err() {
                break;
            }
        }

        let _ = app.emit(
            EXIT_EVENT,
            TelnetExit {
                session_id: session_id.clone(),
            },
        );
        let _ = app
            .state::<TelnetManager>()
            .close_if_current(&session_id, &cancellation);
    });
}

#[derive(Default)]
enum ParseState {
    #[default]
    Data,
    Command,
    Negotiation(u8),
    SubNegotiation(Vec<u8>),
    SubNegotiationCommand(Vec<u8>),
}

#[derive(Default)]
struct ProtocolFrame {
    output: Vec<u8>,
    responses: Vec<Vec<u8>>,
}

struct TelnetProtocol {
    state: ParseState,
    columns: u16,
    rows: u16,
    remote_enabled: HashSet<u8>,
    remote_rejected: HashSet<u8>,
    local_enabled: HashSet<u8>,
    local_rejected: HashSet<u8>,
    window_size_enabled: Arc<AtomicBool>,
}

impl TelnetProtocol {
    fn new(columns: u16, rows: u16, window_size_enabled: Arc<AtomicBool>) -> Self {
        Self {
            state: ParseState::Data,
            columns,
            rows,
            remote_enabled: HashSet::new(),
            remote_rejected: HashSet::new(),
            local_enabled: HashSet::new(),
            local_rejected: HashSet::new(),
            window_size_enabled,
        }
    }

    fn decode(&mut self, input: &[u8]) -> ProtocolFrame {
        let mut frame = ProtocolFrame {
            output: Vec::with_capacity(input.len()),
            responses: Vec::new(),
        };
        for &byte in input {
            self.state = match std::mem::take(&mut self.state) {
                ParseState::Data if byte == IAC => ParseState::Command,
                ParseState::Data => {
                    frame.output.push(byte);
                    ParseState::Data
                }
                ParseState::Command if byte == IAC => {
                    frame.output.push(IAC);
                    ParseState::Data
                }
                ParseState::Command if matches!(byte, WILL | WONT | DO | DONT) => {
                    ParseState::Negotiation(byte)
                }
                ParseState::Command if byte == SB => ParseState::SubNegotiation(Vec::new()),
                ParseState::Command => ParseState::Data,
                ParseState::Negotiation(command) => {
                    self.negotiate(command, byte, &mut frame.responses);
                    ParseState::Data
                }
                ParseState::SubNegotiation(bytes) if byte == IAC => {
                    ParseState::SubNegotiationCommand(bytes)
                }
                ParseState::SubNegotiation(mut bytes) => {
                    bytes.push(byte);
                    ParseState::SubNegotiation(bytes)
                }
                ParseState::SubNegotiationCommand(bytes) if byte == SE => {
                    if let Some(response) = terminal_type_response(&bytes) {
                        frame.responses.push(response);
                    }
                    ParseState::Data
                }
                ParseState::SubNegotiationCommand(mut bytes) if byte == IAC => {
                    bytes.push(IAC);
                    ParseState::SubNegotiation(bytes)
                }
                ParseState::SubNegotiationCommand(bytes) => ParseState::SubNegotiation(bytes),
            };
        }
        frame
    }

    fn negotiate(&mut self, command: u8, option: u8, responses: &mut Vec<Vec<u8>>) {
        match command {
            WILL if matches!(option, ECHO | SUPPRESS_GO_AHEAD | BINARY) => {
                if self.remote_enabled.insert(option) {
                    responses.push(vec![IAC, DO, option]);
                }
            }
            WILL => {
                if self.remote_rejected.insert(option) {
                    responses.push(vec![IAC, DONT, option]);
                }
            }
            DO if matches!(option, SUPPRESS_GO_AHEAD | BINARY | TERMINAL_TYPE | NAWS) => {
                if self.local_enabled.insert(option) {
                    responses.push(vec![IAC, WILL, option]);
                    if option == NAWS {
                        self.window_size_enabled.store(true, Ordering::Release);
                        responses.push(window_size_message(self.columns, self.rows));
                    }
                }
            }
            DO => {
                if self.local_rejected.insert(option) {
                    responses.push(vec![IAC, WONT, option]);
                }
            }
            WONT => {
                self.remote_enabled.remove(&option);
            }
            DONT => {
                self.local_enabled.remove(&option);
                if option == NAWS {
                    self.window_size_enabled.store(false, Ordering::Release);
                }
            }
            _ => {}
        }
    }
}

fn terminal_type_response(bytes: &[u8]) -> Option<Vec<u8>> {
    if !bytes.starts_with(&[TERMINAL_TYPE, 1]) {
        return None;
    }
    let mut response = vec![IAC, SB, TERMINAL_TYPE, 0];
    response.extend_from_slice(b"XTERM-256COLOR");
    response.extend_from_slice(&[IAC, SE]);
    Some(response)
}

fn window_size_message(columns: u16, rows: u16) -> Vec<u8> {
    let mut message = vec![IAC, SB, NAWS];
    message.extend(escape_iac(&columns.to_be_bytes()));
    message.extend(escape_iac(&rows.to_be_bytes()));
    message.extend_from_slice(&[IAC, SE]);
    message
}

fn escape_iac(data: &[u8]) -> Vec<u8> {
    let mut escaped = Vec::with_capacity(data.len());
    for &byte in data {
        escaped.push(byte);
        if byte == IAC {
            escaped.push(IAC);
        }
    }
    escaped
}

fn line_message(value: &str) -> Vec<u8> {
    let mut bytes = escape_iac(value.as_bytes());
    bytes.extend_from_slice(b"\r\n");
    bytes
}

fn append_prompt_text(prompt: &mut String, output: &[u8]) {
    prompt.extend(output.iter().map(|byte| {
        if byte.is_ascii() {
            byte.to_ascii_lowercase() as char
        } else {
            ' '
        }
    }));
    if prompt.len() > 512 {
        prompt.drain(..prompt.len() - 512);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn protocol() -> TelnetProtocol {
        TelnetProtocol::new(80, 24, Arc::new(AtomicBool::new(false)))
    }

    #[test]
    fn user_input_escapes_telnet_command_byte() {
        assert_eq!(escape_iac(&[b'a', IAC, b'b']), vec![b'a', IAC, IAC, b'b']);
    }

    #[test]
    fn protocol_separates_display_data_from_negotiation() {
        let mut protocol = protocol();
        let frame = protocol.decode(&[b'h', b'i', IAC, WILL, ECHO, b'!']);

        assert_eq!(frame.output, b"hi!");
        assert_eq!(frame.responses, vec![vec![IAC, DO, ECHO]]);
    }

    #[test]
    fn negative_negotiation_does_not_create_a_response_loop() {
        let mut protocol = protocol();
        let frame = protocol.decode(&[IAC, WONT, ECHO, IAC, DONT, NAWS]);

        assert!(frame.output.is_empty());
        assert!(frame.responses.is_empty());
    }

    #[test]
    fn repeated_negotiation_is_acknowledged_only_once() {
        let mut protocol = protocol();
        let first = protocol.decode(&[IAC, WILL, ECHO]);
        let repeated = protocol.decode(&[IAC, WILL, ECHO]);

        assert_eq!(first.responses, vec![vec![IAC, DO, ECHO]]);
        assert!(repeated.responses.is_empty());
    }

    #[test]
    fn window_size_updates_require_server_negotiation() {
        let enabled = Arc::new(AtomicBool::new(false));
        let mut protocol = TelnetProtocol::new(80, 24, Arc::clone(&enabled));

        protocol.decode(&[IAC, DO, NAWS]);
        assert!(enabled.load(Ordering::Acquire));

        protocol.decode(&[IAC, DONT, NAWS]);
        assert!(!enabled.load(Ordering::Acquire));
    }

    #[test]
    fn connecting_session_can_be_cancelled_immediately() {
        let manager = TelnetManager::default();
        let cancellation = manager.begin("pending").expect("begin session");

        manager.close("pending").expect("close session");

        assert!(cancellation.load(Ordering::Acquire));
        assert!(manager.sessions.lock().expect("read sessions").is_empty());
    }

    #[test]
    fn failed_connection_releases_its_session_id() {
        let manager = TelnetManager::default();
        let cancellation = manager.begin("failed").expect("begin session");

        manager.remove_if_connecting("failed", &cancellation);

        assert!(manager.sessions.lock().expect("read sessions").is_empty());
        manager.begin("failed").expect("reuse released session id");
    }

    #[test]
    fn stale_connection_attempt_cannot_remove_a_newer_session() {
        let manager = TelnetManager::default();
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

    #[test]
    fn prompt_scanner_handles_non_ascii_output_without_invalid_string_boundaries() {
        let mut prompt = String::new();
        let output = "设备登录提示".repeat(200);

        append_prompt_text(&mut prompt, output.as_bytes());

        assert_eq!(prompt.len(), 512);
        assert!(prompt.is_ascii());
    }
}
