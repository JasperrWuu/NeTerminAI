mod engine;
mod packet;
#[cfg(test)]
mod tests;

use engine::{CodeKind, Engine};
use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    collections::VecDeque,
    net::{IpAddr, SocketAddr, UdpSocket},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    ip: String,
    port: u16,
    code_kind: CodeKind,
    code_length: u8,
}
#[derive(Clone, Serialize)]
pub struct Entry {
    id: u64,
    timestamp: u64,
    source: String,
    message: String,
}
#[derive(Default)]
struct Logs {
    entries: VecDeque<Entry>,
    sequence: u64,
    error: Option<String>,
}
impl Logs {
    fn add(&mut self, source: String, message: String) {
        self.sequence += 1;
        self.entries.push_back(Entry {
            id: self.sequence,
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            source,
            message,
        });
        if self.entries.len() > 1000 {
            self.entries.pop_front();
        }
    }
}
struct Server {
    address: String,
    stop: Arc<AtomicBool>,
    worker: JoinHandle<()>,
}
#[derive(Default)]
pub struct RadiusManager {
    server: Mutex<Option<Server>>,
    logs: Arc<Mutex<Logs>>,
}
#[derive(Serialize)]
pub struct Snapshot {
    running: bool,
    address: Option<String>,
    entries: Vec<Entry>,
    cursor: u64,
    error: Option<String>,
}
fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|e| e.into_inner())
}
impl RadiusManager {
    fn start(&self, config: Config) -> Result<(), String> {
        let mut server = lock(&self.server);
        if server.as_ref().is_some_and(|s| !s.worker.is_finished()) {
            return Err("RADIUS 服务器已在运行".into());
        }
        if let Some(old) = server.take() {
            let _ = old.worker.join();
        }
        let ip: IpAddr = config.ip.parse().map_err(|_| "请输入有效 IPv4 / IPv6")?;
        if ip.is_multicast() || ip == IpAddr::V4(std::net::Ipv4Addr::BROADCAST) {
            return Err("不能监听广播或组播地址".into());
        }
        if !(1..=32).contains(&config.code_length) {
            return Err("挑战码长度必须为 1–32".into());
        }
        // Fail before claiming Running if the OS random source is unavailable.
        let mut probe = [0; 1];
        getrandom::fill(&mut probe).map_err(|e| e.to_string())?;
        let address = SocketAddr::new(ip, config.port);
        let socket = Socket::new(
            if ip.is_ipv6() {
                Domain::IPV6
            } else {
                Domain::IPV4
            },
            Type::DGRAM,
            Some(Protocol::UDP),
        )
        .map_err(|e| e.to_string())?;
        if ip.is_ipv6() {
            socket.set_only_v6(true).map_err(|e| e.to_string())?;
        }
        socket
            .bind(&address.into())
            .map_err(|e| format!("无法绑定 {address}：{e}"))?;
        let socket: UdpSocket = socket.into();
        socket
            .set_read_timeout(Some(Duration::from_millis(50)))
            .map_err(|e| e.to_string())?;
        socket
            .set_write_timeout(Some(Duration::from_millis(250)))
            .map_err(|e| e.to_string())?;
        let address = socket.local_addr().map_err(|e| e.to_string())?.to_string();
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let logs = self.logs.clone();
        let worker = thread::Builder::new()
            .name("radius-udp".into())
            .spawn(move || {
                let mut engine = Engine::new(config.code_kind, config.code_length);
                let mut bytes = vec![0; 65535];
                while !flag.load(Ordering::Acquire) {
                    match socket.recv_from(&mut bytes) {
                        Ok((size, peer)) => {
                            if flag.load(Ordering::Acquire) {
                                break;
                            }
                            match engine.handle(&bytes[..size], peer, Instant::now()) {
                                Ok((reply, message)) => {
                                    if let Some(reply) = reply
                                        && let Err(e) = socket.send_to(&reply, peer)
                                    {
                                        lock(&logs)
                                            .add(peer.to_string(), format!("SEND ERROR · {e}"));
                                        continue;
                                    }
                                    // Deliberately exclude passwords, shared secret, State and challenge values.
                                    lock(&logs).add(peer.to_string(), message.into());
                                }
                                Err(e) => {
                                    lock(&logs).add(peer.to_string(), format!("ERROR · {e}"));
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
                            lock(&logs).error = Some(format!("接收失败：{e}"));
                            break;
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let mut logs = lock(&self.logs);
        logs.error = None;
        logs.add(address.clone(), "SYSTEM · 服务已启动".into());
        *server = Some(Server {
            address,
            stop,
            worker,
        });
        Ok(())
    }
    pub fn stop(&self) {
        let mut server = lock(&self.server);
        if let Some(s) = server.take() {
            s.stop.store(true, Ordering::Release);
            let _ = s.worker.join();
            lock(&self.logs).add(s.address, "SYSTEM · 服务已停止".into());
        }
    }
    fn snapshot(&self, after: u64) -> Snapshot {
        let server = lock(&self.server);
        let logs = lock(&self.logs);
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
            error: logs.error.clone(),
        }
    }
}
impl Drop for RadiusManager {
    fn drop(&mut self) {
        self.stop();
    }
}
#[tauri::command]
pub async fn start_radius(
    state: tauri::State<'_, RadiusManager>,
    config: Config,
) -> Result<Snapshot, String> {
    if config.port == 0 {
        return Err("端口必须为 1–65535".into());
    }
    state.start(config)?;
    Ok(state.snapshot(0))
}
#[tauri::command]
pub async fn stop_radius(state: tauri::State<'_, RadiusManager>) -> Result<Snapshot, String> {
    state.stop();
    Ok(state.snapshot(0))
}
#[tauri::command]
pub fn read_radius(state: tauri::State<'_, RadiusManager>, after: u64) -> Snapshot {
    state.snapshot(after)
}
