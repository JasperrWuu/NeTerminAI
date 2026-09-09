use serde::Serialize;
use std::{
    collections::VecDeque,
    net::{Ipv4Addr, SocketAddrV4, UdpSocket},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_ENTRIES: usize = 2000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: u64,
    timestamp: u64,
    source: String,
    message: String,
}

#[derive(Default)]
struct LogBuffer {
    entries: VecDeque<Entry>,
    bytes: usize,
    sequence: u64,
    discarded: u64,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    running: bool,
    address: Option<String>,
    entries: Vec<Entry>,
    cursor: u64,
    discarded: u64,
    error: Option<String>,
}

struct Server {
    address: String,
    stop: Arc<AtomicBool>,
    worker: JoinHandle<()>,
}

#[derive(Default)]
pub struct SyslogManager {
    server: Mutex<Option<Server>>,
    logs: Arc<Mutex<LogBuffer>>,
}

impl SyslogManager {
    fn start(&self, ip: Ipv4Addr, port: u16) -> Result<(), String> {
        let mut server = self.server.lock().unwrap_or_else(|e| e.into_inner());
        if server.as_ref().is_some_and(|s| !s.worker.is_finished()) {
            return Err("SYSLOG 服务器已在运行，请先停止。".into());
        }
        if let Some(old) = server.take() {
            let _ = old.worker.join();
        }
        let socket = UdpSocket::bind(SocketAddrV4::new(ip, port))
            .map_err(|e| format!("无法绑定 {ip}:{port}：{e}"))?;
        socket
            .set_read_timeout(Some(Duration::from_millis(50)))
            .map_err(|e| e.to_string())?;
        let address = socket.local_addr().map_err(|e| e.to_string())?.to_string();
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let logs = self.logs.clone();
        logs.lock().unwrap_or_else(|e| e.into_inner()).error = None;
        let worker = thread::Builder::new()
            .name("syslog-udp".into())
            .spawn(move || {
                let mut bytes = vec![0u8; 65535];
                while !flag.load(Ordering::Acquire) {
                    match socket.recv_from(&mut bytes) {
                        Ok((length, peer)) => {
                            if flag.load(Ordering::Acquire) {
                                break;
                            }
                            let message = String::from_utf8_lossy(&bytes[..length]).into_owned();
                            let mut buffer = logs.lock().unwrap_or_else(|e| e.into_inner());
                            buffer.sequence += 1;
                            let id = buffer.sequence;
                            buffer.bytes += message.len();
                            buffer.entries.push_back(Entry {
                                id,
                                timestamp: SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis() as u64,
                                source: peer.ip().to_string(),
                                message,
                            });
                            while buffer.bytes > MAX_BYTES || buffer.entries.len() > MAX_ENTRIES {
                                if let Some(old) = buffer.entries.pop_front() {
                                    buffer.bytes -= old.message.len();
                                    buffer.discarded += 1;
                                }
                            }
                        }
                        Err(e)
                            if matches!(
                                e.kind(),
                                std::io::ErrorKind::WouldBlock
                                    | std::io::ErrorKind::TimedOut
                                    | std::io::ErrorKind::Interrupted
                            ) => {}
                        Err(e) => {
                            logs.lock().unwrap_or_else(|e| e.into_inner()).error =
                                Some(format!("接收 SYSLOG 失败：{e}"));
                            break;
                        }
                    }
                }
            })
            .map_err(|e| format!("无法启动 SYSLOG 接收线程：{e}"))?;
        *server = Some(Server {
            address,
            stop,
            worker,
        });
        Ok(())
    }

    pub fn stop(&self) {
        let mut server = self.server.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(server) = server.take() {
            server.stop.store(true, Ordering::Release);
            // Join guarantees the socket is released before Stop returns.
            let _ = server.worker.join();
        }
    }

    fn snapshot(&self, after: u64) -> Snapshot {
        let server = self.server.lock().unwrap_or_else(|e| e.into_inner());
        let logs = self.logs.lock().unwrap_or_else(|e| e.into_inner());
        Snapshot {
            running: server.as_ref().is_some_and(|s| !s.worker.is_finished()),
            address: server.as_ref().map(|s| s.address.clone()),
            entries: logs
                .entries
                .iter()
                .filter(|e| e.id > after)
                .cloned()
                .collect(),
            cursor: logs.sequence,
            discarded: logs.discarded,
            error: logs.error.clone(),
        }
    }
}

impl Drop for SyslogManager {
    fn drop(&mut self) {
        self.stop();
    }
}

#[tauri::command]
pub async fn start_syslog(
    state: tauri::State<'_, SyslogManager>,
    ip: String,
    port: u16,
) -> Result<Snapshot, String> {
    if port == 0 {
        return Err("端口必须在 1–65535 之间。".into());
    }
    let ip = ip
        .parse::<Ipv4Addr>()
        .map_err(|_| "服务器 IP 必须是本地 IPv4 地址。")?;
    if ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() {
        return Err("请选择具体的本地网卡 IPv4。".into());
    }
    state.start(ip, port)?;
    Ok(state.snapshot(0))
}

#[tauri::command]
pub async fn stop_syslog(state: tauri::State<'_, SyslogManager>) -> Result<Snapshot, String> {
    state.stop();
    Ok(state.snapshot(0))
}

#[tauri::command]
pub fn read_syslog(state: tauri::State<'_, SyslogManager>, after: u64) -> Snapshot {
    state.snapshot(after)
}

#[tauri::command]
pub fn clear_syslog(state: tauri::State<'_, SyslogManager>) -> Snapshot {
    {
        let mut logs = state.logs.lock().unwrap_or_else(|e| e.into_inner());
        logs.entries.clear();
        logs.bytes = 0;
        logs.discarded = 0;
    }
    state.snapshot(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn udp_receive_preserves_text_and_stop_releases_port() {
        let manager = SyslogManager::default();
        manager.start(Ipv4Addr::LOCALHOST, 0).unwrap();
        let address = manager.snapshot(0).address.unwrap();
        assert!(manager.start(Ipv4Addr::LOCALHOST, 0).is_err());
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        let text = "<134>华为日志\r\n  details\n";
        sender.send_to(text.as_bytes(), &address).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while manager.snapshot(0).entries.is_empty() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        let snapshot = manager.snapshot(0);
        assert!(snapshot.running);
        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(snapshot.entries[0].message, text);
        assert_eq!(snapshot.entries[0].source, "127.0.0.1");
        assert!(manager.snapshot(snapshot.cursor).entries.is_empty());
        manager.stop();
        assert!(!manager.snapshot(0).running);
        let rebound = UdpSocket::bind(address).unwrap();
        drop(rebound);
    }

    #[test]
    fn occupied_port_fails_and_drop_releases_socket() {
        let occupied = UdpSocket::bind("127.0.0.1:0").unwrap();
        let manager = SyslogManager::default();
        assert!(
            manager
                .start(Ipv4Addr::LOCALHOST, occupied.local_addr().unwrap().port())
                .is_err()
        );
        assert!(!manager.snapshot(0).running);
        manager.start(Ipv4Addr::LOCALHOST, 0).unwrap();
        let address = manager.snapshot(0).address.unwrap();
        drop(manager);
        assert!(UdpSocket::bind(address).is_ok());
    }
}
