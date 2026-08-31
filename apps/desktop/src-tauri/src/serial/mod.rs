use std::{
    collections::HashMap,
    io::{ErrorKind, Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Sender},
    },
    thread,
    time::Duration,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, StopBits};
use tauri::{AppHandle, Emitter, Manager};

const OUTPUT_EVENT: &str = "serial:output";
const EXIT_EVENT: &str = "serial:exit";

#[derive(Default)]
pub struct SerialManager {
    sessions: Mutex<HashMap<String, SessionState>>,
}

enum SessionState {
    Connecting(Arc<AtomicBool>),
    Connected(SerialSession),
}

struct SerialSession {
    writer: Sender<WriterMessage>,
    cancellation: Arc<AtomicBool>,
}

enum WriterMessage {
    Bytes(Vec<u8>),
    Shutdown,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SerialParity {
    None,
    Odd,
    Even,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SerialFlowControl {
    None,
    Software,
    Hardware,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialOutput {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialExit {
    session_id: String,
}

impl SerialManager {
    pub fn begin(&self, session_id: &str) -> Result<Arc<AtomicBool>, String> {
        let cancellation = Arc::new(AtomicBool::new(false));
        let mut sessions = self.sessions.lock().map_err(|_| "串口会话状态不可用".to_owned())?;
        if sessions.contains_key(session_id) {
            return Err("串口会话已存在".to_owned());
        }
        sessions.insert(session_id.to_owned(), SessionState::Connecting(Arc::clone(&cancellation)));
        Ok(cancellation)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        app: AppHandle,
        session_id: String,
        port_name: String,
        baud_rate: u32,
        data_bits: u8,
        stop_bits: u8,
        parity: SerialParity,
        flow_control: SerialFlowControl,
        cancellation: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let data_bits = match map_data_bits(data_bits) {
            Ok(value) => value,
            Err(error) => {
                self.remove_if_connecting(&session_id, &cancellation);
                return Err(error);
            }
        };
        let stop_bits = match map_stop_bits(stop_bits) {
            Ok(value) => value,
            Err(error) => {
                self.remove_if_connecting(&session_id, &cancellation);
                return Err(error);
            }
        };
        let port = match serialport::new(&port_name, baud_rate)
            .data_bits(data_bits)
            .stop_bits(stop_bits)
            .parity(map_parity(parity))
            .flow_control(map_flow_control(flow_control))
            .timeout(Duration::from_millis(100))
            .open()
        {
            Ok(port) => port,
            Err(error) => {
                self.remove_if_connecting(&session_id, &cancellation);
                return Err(format!("无法打开串口 {port_name}：{error}"));
            }
        };

        if cancellation.load(Ordering::Acquire) {
            return Err("串口连接已取消".to_owned());
        }

        let reader = match port.try_clone() {
            Ok(reader) => reader,
            Err(error) => {
                self.remove_if_connecting(&session_id, &cancellation);
                return Err(format!("无法读取串口 {port_name}：{error}"));
            }
        };
        let (writer, receiver) = mpsc::channel();
        {
            let mut sessions = self.sessions.lock().map_err(|_| "串口会话状态不可用".to_owned())?;
            match sessions.get(&session_id) {
                Some(SessionState::Connecting(current)) if Arc::ptr_eq(current, &cancellation) => {
                    sessions.insert(session_id.clone(), SessionState::Connected(SerialSession {
                        writer: writer.clone(),
                        cancellation: Arc::clone(&cancellation),
                    }));
                }
                _ => return Err("串口连接已取消".to_owned()),
            }
        }

        spawn_writer(port, receiver, Arc::clone(&cancellation));
        spawn_reader(app, session_id, reader, cancellation);
        Ok(())
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let writer = {
            let sessions = self.sessions.lock().map_err(|_| "串口会话状态不可用".to_owned())?;
            match sessions.get(session_id) {
                Some(SessionState::Connected(session)) => session.writer.clone(),
                Some(SessionState::Connecting(_)) => return Err("串口仍在连接中".to_owned()),
                None => return Err("串口会话不存在".to_owned()),
            }
        };
        writer.send(WriterMessage::Bytes(data.to_vec())).map_err(|_| "串口连接已关闭".to_owned())
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let session = self.sessions.lock().map_err(|_| "串口会话状态不可用".to_owned())?.remove(session_id);
        match session {
            Some(SessionState::Connecting(cancellation)) => cancellation.store(true, Ordering::Release),
            Some(SessionState::Connected(session)) => {
                session.cancellation.store(true, Ordering::Release);
                let _ = session.writer.send(WriterMessage::Shutdown);
            }
            None => {}
        }
        Ok(())
    }

    fn remove_if_connecting(&self, session_id: &str, cancellation: &Arc<AtomicBool>) {
        if let Ok(mut sessions) = self.sessions.lock()
            && matches!(sessions.get(session_id), Some(SessionState::Connecting(current)) if Arc::ptr_eq(current, cancellation))
        {
            sessions.remove(session_id);
        }
    }
}

fn spawn_writer(
    mut port: Box<dyn serialport::SerialPort>,
    receiver: mpsc::Receiver<WriterMessage>,
    cancellation: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        while let Ok(message) = receiver.recv() {
            match message {
                WriterMessage::Bytes(bytes) => {
                    if port.write_all(&bytes).and_then(|_| port.flush()).is_err() {
                        cancellation.store(true, Ordering::Release);
                        break;
                    }
                }
                WriterMessage::Shutdown => break,
            }
        }
    });
}

fn spawn_reader(app: AppHandle, session_id: String, mut reader: Box<dyn serialport::SerialPort>, cancellation: Arc<AtomicBool>) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        while !cancellation.load(Ordering::Acquire) {
            match reader.read(&mut buffer) {
                Ok(0) => {}
                Ok(length) => {
                    if app.emit(OUTPUT_EVENT, SerialOutput { session_id: session_id.clone(), data: STANDARD.encode(&buffer[..length]) }).is_err() { break; }
                }
                Err(error) if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::Interrupted) => {}
                Err(_) => break,
            }
        }
        let _ = app.emit(EXIT_EVENT, SerialExit { session_id: session_id.clone() });
        let _ = app.state::<SerialManager>().close(&session_id);
    });
}

fn map_data_bits(value: u8) -> Result<DataBits, String> {
    match value {
        5 => Ok(DataBits::Five),
        6 => Ok(DataBits::Six),
        7 => Ok(DataBits::Seven),
        8 => Ok(DataBits::Eight),
        _ => Err("数据位仅支持 5、6、7 或 8".to_owned()),
    }
}

fn map_stop_bits(value: u8) -> Result<StopBits, String> {
    match value {
        1 => Ok(StopBits::One),
        2 => Ok(StopBits::Two),
        _ => Err("停止位仅支持 1 或 2".to_owned()),
    }
}

fn map_parity(value: SerialParity) -> Parity {
    match value { SerialParity::None => Parity::None, SerialParity::Odd => Parity::Odd, SerialParity::Even => Parity::Even }
}

fn map_flow_control(value: SerialFlowControl) -> FlowControl {
    match value { SerialFlowControl::None => FlowControl::None, SerialFlowControl::Software => FlowControl::Software, SerialFlowControl::Hardware => FlowControl::Hardware }
}

pub fn available_ports() -> Result<Vec<String>, String> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(|port| port.port_name).collect())
        .map_err(|error| format!("无法读取串口列表：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_serial_word_size() {
        assert!(matches!(map_data_bits(8), Ok(DataBits::Eight)));
        assert!(map_data_bits(9).is_err());
        assert!(matches!(map_stop_bits(1), Ok(StopBits::One)));
    }

    #[test]
    fn connecting_serial_session_can_be_cancelled() {
        let manager = SerialManager::default();
        let cancellation = manager.begin("pending").expect("begin session");

        manager.close("pending").expect("close session");

        assert!(cancellation.load(Ordering::Acquire));
        assert!(manager.sessions.lock().expect("read sessions").is_empty());
    }
}
