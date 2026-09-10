mod paths;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::File,
    io::{self, Read, Seek, Write},
    net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Deserialize)]
pub struct Config {
    pub ip: String,
    pub port: u16,
    pub root: String,
    pub username: String,
    pub password: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Log {
    id: u64,
    timestamp: u64,
    level: String,
    message: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    client: String,
    file: String,
    direction: String,
    bytes: u64,
    total: Option<u64>,
    seconds: f64,
    bytes_per_second: f64,
}
#[derive(Default)]
struct Shared {
    stop: AtomicBool,
    sequence: AtomicU64,
    logs: Mutex<VecDeque<Log>>,
    sockets: Mutex<HashMap<u64, (TcpStream, Option<TcpStream>)>>,
    transfers: Mutex<HashMap<u64, Progress>>,
    paths: Mutex<HashSet<String>>,
    error: Mutex<Option<String>>,
}
struct PathLease {
    shared: Arc<Shared>,
    key: String,
}
impl Drop for PathLease {
    fn drop(&mut self) {
        lock(&self.shared.paths).remove(&self.key);
    }
}
fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|e| e.into_inner())
}
impl Shared {
    fn log(&self, level: &str, message: impl Into<String>) {
        let mut logs = lock(&self.logs);
        logs.push_back(Log {
            id: self.sequence.fetch_add(1, Ordering::Relaxed) + 1,
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            level: level.into(),
            message: message.into().chars().take(2048).collect(),
        });
        while logs.len() > 2000 {
            logs.pop_front();
        }
    }
    fn close(&self) {
        self.stop.store(true, Ordering::Release);
        for (control, data) in lock(&self.sockets).values() {
            let _ = control.shutdown(Shutdown::Both);
            if let Some(data) = data {
                let _ = data.shutdown(Shutdown::Both);
            }
        }
    }
}
struct Server {
    address: String,
    worker: JoinHandle<()>,
}
#[derive(Default)]
pub struct FtpManager {
    server: Mutex<Option<Server>>,
    shared: Arc<Shared>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    running: bool,
    address: Option<String>,
    logs: Vec<Log>,
    transfers: Vec<Progress>,
    cursor: u64,
    error: Option<String>,
}

impl FtpManager {
    fn start(&self, config: Config) -> Result<(), String> {
        let mut server = lock(&self.server);
        if server.as_ref().is_some_and(|s| !s.worker.is_finished()) {
            return Err("FTP 服务器已运行，请先停止。".into());
        }
        if let Some(old) = server.take() {
            let _ = old.worker.join();
        }
        let root = std::fs::canonicalize(&config.root).map_err(|e| format!("共享目录无效：{e}"))?;
        if !root.is_dir() {
            return Err("共享目录不是文件夹。".into());
        }
        let ip = config
            .ip
            .parse::<Ipv4Addr>()
            .map_err(|_| "请选择本地 IPv4")?;
        if ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() {
            return Err("请选择具体的本机 IPv4。".into());
        }
        let listener =
            TcpListener::bind((ip, config.port)).map_err(|e| format!("FTP 绑定失败：{e}"))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let address = listener
            .local_addr()
            .map_err(|e| e.to_string())?
            .to_string();
        self.shared.stop.store(false, Ordering::Release);
        *lock(&self.shared.error) = None;
        let shared = self.shared.clone();
        let worker = thread::Builder::new()
            .name("ftp-accept".into())
            .spawn(move || {
                let mut workers: Vec<JoinHandle<()>> = Vec::new();
                let mut next = 0;
                while !shared.stop.load(Ordering::Acquire) {
                    let mut pending = Vec::new();
                    for worker in workers.drain(..) {
                        if worker.is_finished() {
                            let _ = worker.join();
                        } else {
                            pending.push(worker);
                        }
                    }
                    workers = pending;
                    match listener.accept() {
                        Ok((mut control, peer)) => {
                            if shared.stop.load(Ordering::Acquire) {
                                break;
                            }
                            if workers.len() >= 32 {
                                let _ = control.write_all(b"421 Too many clients\r\n");
                                continue;
                            }
                            if control
                                .set_read_timeout(Some(Duration::from_millis(250)))
                                .is_err()
                                || control
                                    .set_write_timeout(Some(Duration::from_secs(2)))
                                    .is_err()
                            {
                                continue;
                            }
                            next += 1;
                            let id = next;
                            let Ok(copy) = control.try_clone() else {
                                continue;
                            };
                            lock(&shared.sockets).insert(id, (copy, None));
                            let state = shared.clone();
                            let config = config.clone();
                            let root = root.clone();
                            match thread::Builder::new()
                                .name(format!("ftp-client-{id}"))
                                .spawn(move || {
                                    state.log("CONNECT", peer.to_string());
                                    let mut session = Session {
                                        control,
                                        peer,
                                        id,
                                        shared: state.clone(),
                                        config,
                                        root,
                                        cwd: vec![],
                                        endpoint: None,
                                        user_ok: false,
                                        authenticated: false,
                                        binary: true,
                                    };
                                    if let Err(e) = session.run() {
                                        state.log("ERROR", format!("{peer} · {e}"));
                                    }
                                    lock(&state.transfers).remove(&id);
                                    lock(&state.sockets).remove(&id);
                                    state.log("DISCONNECT", peer.to_string());
                                }) {
                                Ok(worker) => workers.push(worker),
                                Err(e) => {
                                    lock(&shared.sockets).remove(&id);
                                    shared.log("ERROR", e.to_string());
                                }
                            }
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                            thread::park_timeout(Duration::from_millis(20))
                        }
                        Err(e) => {
                            *lock(&shared.error) = Some(format!("FTP 接收连接失败：{e}"));
                            break;
                        }
                    }
                }
                shared.close();
                drop(listener);
                for worker in workers {
                    let _ = worker.join();
                }
            })
            .map_err(|e| e.to_string())?;
        self.shared
            .log("SYSTEM", format!("Server started · {address} · Active FTP"));
        *server = Some(Server { address, worker });
        Ok(())
    }
    pub fn stop(&self) {
        let mut server = lock(&self.server);
        if let Some(server) = server.take() {
            self.shared.close();
            server.worker.thread().unpark();
            let _ = server.worker.join();
            self.shared.log("SYSTEM", "Server stopped");
        }
    }
    fn snapshot(&self, after: u64) -> Snapshot {
        let server = lock(&self.server);
        let logs = lock(&self.shared.logs);
        Snapshot {
            running: server.as_ref().is_some_and(|s| !s.worker.is_finished()),
            address: server.as_ref().map(|s| s.address.clone()),
            logs: logs.iter().filter(|l| l.id > after).cloned().collect(),
            cursor: self.shared.sequence.load(Ordering::Relaxed),
            transfers: lock(&self.shared.transfers).values().cloned().collect(),
            error: lock(&self.shared.error).clone(),
        }
    }
}
impl Drop for FtpManager {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Session {
    control: TcpStream,
    peer: SocketAddr,
    id: u64,
    shared: Arc<Shared>,
    config: Config,
    root: PathBuf,
    cwd: Vec<String>,
    endpoint: Option<SocketAddr>,
    user_ok: bool,
    authenticated: bool,
    binary: bool,
}
impl Session {
    fn reply(&mut self, code: u16, message: &str) -> io::Result<()> {
        self.shared
            .log(&code.to_string(), format!("{} · {message}", self.peer));
        write!(self.control, "{code} {message}\r\n")?;
        self.control.flush()
    }
    fn run(&mut self) -> io::Result<()> {
        self.reply(220, "NeTerminAI Active FTP ready")?;
        let mut pending = Vec::new();
        let mut bytes = [0u8; 4096];
        let mut last = Instant::now();
        while !self.shared.stop.load(Ordering::Acquire) {
            match self.control.read(&mut bytes) {
                Ok(0) => break,
                Ok(n) => {
                    last = Instant::now();
                    pending.extend_from_slice(&bytes[..n]);
                    while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                        if end > 16384 {
                            self.reply(500, "Command too long")?;
                            return Ok(());
                        }
                        let mut line: Vec<_> = pending.drain(..=end).collect();
                        line.pop();
                        if line.last() == Some(&b'\r') {
                            line.pop();
                        }
                        let Ok(line) = std::str::from_utf8(&line) else {
                            self.reply(501, "Use UTF-8 commands")?;
                            continue;
                        };
                        let (verb, arg) = line.split_once(' ').unwrap_or((line, ""));
                        if !self.command(&verb.to_ascii_uppercase(), arg)? {
                            return Ok(());
                        }
                    }
                    if pending.len() > 16384 {
                        self.reply(500, "Command too long")?;
                        break;
                    }
                }
                Err(e) if timeout(&e) => {
                    if last.elapsed() > Duration::from_secs(300) {
                        self.reply(421, "Control timeout")?;
                        break;
                    }
                }
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
    fn command(&mut self, verb: &str, arg: &str) -> io::Result<bool> {
        match verb {
            "QUIT" => {
                self.reply(221, "Goodbye")?;
                return Ok(false);
            }
            "USER" => {
                self.authenticated = false;
                self.endpoint = None;
                self.user_ok = arg == self.config.username;
                self.shared.log("USER", format!("{} · {arg}", self.peer));
                self.reply(
                    if self.user_ok { 331 } else { 530 },
                    if self.user_ok {
                        "Password required"
                    } else {
                        "Login incorrect"
                    },
                )?;
            }
            "PASS" => {
                self.authenticated = self.user_ok && arg == self.config.password;
                self.shared.log(
                    "AUTH",
                    format!(
                        "{} · Login {}",
                        self.peer,
                        if self.authenticated {
                            "successful"
                        } else {
                            "failed"
                        }
                    ),
                );
                self.reply(
                    if self.authenticated { 230 } else { 530 },
                    if self.authenticated {
                        "Login successful"
                    } else {
                        "Login incorrect"
                    },
                )?;
            }
            "SYST" => self.reply(215, "UNIX Type: L8")?,
            "NOOP" => self.reply(200, "OK")?,
            "FEAT" => self.reply(211, "UTF8 EPRT SIZE; Active mode only")?,
            "PASV" | "EPSV" => self.reply(502, "Passive mode not supported; use PORT or EPRT")?,
            _ if !self.authenticated => self.reply(530, "Please login")?,
            "TYPE" => {
                if matches!(arg, "I" | "A" | "L 8") {
                    self.binary = arg != "A";
                    self.reply(200, "Transfer type set")?;
                } else {
                    self.reply(504, "Type not supported")?;
                }
            }
            "OPTS" if arg.eq_ignore_ascii_case("UTF8 ON") => self.reply(200, "UTF8 enabled")?,
            "PWD" | "XPWD" => self.reply(
                257,
                &format!("\"/{}\"", self.cwd.join("/").replace('"', "\"\"")),
            )?,
            "CWD" | "CDUP" => {
                let path = if verb == "CDUP" { ".." } else { arg };
                match paths::resolve(&self.root, &self.cwd, path, false) {
                    Ok((target, cwd)) if target.is_dir() => {
                        self.cwd = cwd;
                        self.reply(250, "Directory changed")?;
                    }
                    _ => self.reply(550, "Directory unavailable")?,
                }
            }
            "PORT" | "EPRT" => {
                self.endpoint = None;
                match active_endpoint(verb, arg, self.peer.ip()) {
                    Some(endpoint) => {
                        self.endpoint = Some(endpoint);
                        self.shared.log(verb, format!("{} · {endpoint}", self.peer));
                        self.reply(200, "Active data endpoint set")?;
                    }
                    None => self.reply(
                        501,
                        "Invalid active endpoint; use client IP and port >= 1024",
                    )?,
                }
            }
            "SIZE" => match paths::resolve(&self.root, &self.cwd, arg, false)
                .ok()
                .and_then(|(p, _)| File::open(p).ok())
                .and_then(|f| f.metadata().ok())
                .filter(|m| m.is_file())
            {
                Some(meta) => self.reply(213, &meta.len().to_string())?,
                None => self.reply(550, "File unavailable")?,
            },
            "RETR" | "STOR" | "LIST" | "NLST" => self.transfer(verb, arg)?,
            _ => self.reply(502, "Command not supported")?,
        }
        Ok(true)
    }
    fn transfer(&mut self, verb: &str, arg: &str) -> io::Result<()> {
        // Device archives and firmware must never undergo text conversion.
        // TYPE A remains usable for listings, but not for file payloads.
        if !self.binary && matches!(verb, "RETR" | "STOR") {
            return self.reply(504, "File transfers require binary mode; use TYPE I");
        }
        let Some(endpoint) = self.endpoint.take() else {
            return self.reply(425, "Use PORT or EPRT first");
        };
        let arg = if matches!(verb, "LIST" | "NLST") && matches!(arg, "-a" | "-l" | "-al") {
            ""
        } else {
            arg
        };
        let Ok((path, _)) = paths::resolve(&self.root, &self.cwd, arg, verb == "STOR") else {
            return self.reply(550, "Path unavailable or outside root");
        };
        let _lease = if matches!(verb, "STOR" | "RETR") {
            let key = path.to_string_lossy().into_owned();
            #[cfg(windows)]
            let key = key.to_lowercase();
            if !lock(&self.shared.paths).insert(key.clone()) {
                return self.reply(450, "File is already being transferred; retry later");
            }
            Some(PathLease {
                shared: self.shared.clone(),
                key,
            })
        } else {
            None
        };
        let mut file = None;
        let mut staged = None;
        let mut listing = None;
        let prepared: io::Result<()> = (|| {
            match verb {
                "RETR" => {
                    let f = File::open(&path)?;
                    if !f.metadata()?.is_file() {
                        return Err(io::Error::other("Not a file"));
                    }
                    file = Some(f);
                }
                "STOR" => {
                    if path.is_dir() || (path.exists() && path.metadata()?.permissions().readonly())
                    {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "Target is not writable",
                        ));
                    }
                    let temporary = tempfile::Builder::new()
                        .prefix(".neterminai-upload-")
                        .tempfile_in(
                            path.parent()
                                .ok_or_else(|| io::Error::other("Missing parent directory"))?,
                        )?;
                    file = Some(temporary.as_file().try_clone()?);
                    staged = Some(temporary);
                }
                _ => {
                    listing = Some(paths::listing(&self.root, &path, verb == "NLST")?);
                }
            }
            Ok(())
        })();
        if let Err(e) = prepared {
            self.shared
                .log("ERROR", format!("{} · {arg} · {e}", self.peer));
            return self.reply(550, "File unavailable or not writable");
        }
        let total = if verb == "RETR" {
            file.as_ref()
                .and_then(|f| f.metadata().ok())
                .map(|m| m.len())
        } else {
            listing.as_ref().map(|b| b.len() as u64)
        };
        self.shared.log(
            verb,
            format!(
                "{} · {arg} · {}",
                self.peer,
                total
                    .map(|n| format!("{n} bytes"))
                    .unwrap_or_else(|| "receiving".into())
            ),
        );
        self.reply(150, "Opening active data connection")?;
        let mut data = match TcpStream::connect_timeout(&endpoint, Duration::from_secs(2)) {
            Ok(data) => data,
            Err(e) => {
                self.shared
                    .log("DATA", format!("{} · Connect failed: {e}", self.peer));
                return self.reply(425, "Cannot open data connection");
            }
        };
        let setup = (|| -> io::Result<()> {
            data.set_read_timeout(Some(Duration::from_millis(500)))?;
            data.set_write_timeout(Some(Duration::from_millis(500)))?;
            if let Some(sockets) = lock(&self.shared.sockets).get_mut(&self.id) {
                sockets.1 = Some(data.try_clone()?);
            }
            Ok(())
        })();
        if let Err(e) = setup {
            let _ = data.shutdown(Shutdown::Both);
            self.shared
                .log("DATA", format!("{} · Setup failed: {e}", self.peer));
            return self.reply(425, "Cannot prepare data connection");
        }
        self.shared
            .log("DATA", format!("{} · Connected", self.peer));
        let start = Instant::now();
        let mut count = 0u64;
        let mut report = Instant::now();
        let mut activity = Instant::now();
        let mut source_bytes = 0u64;
        let mut digest = Sha256::new();
        let result: io::Result<()> = (|| {
            if verb == "STOR" {
                file.as_ref().unwrap().set_len(0)?;
            }
            let mut block = [0u8; 65536];
            let mut list = io::Cursor::new(listing.unwrap_or_default());
            loop {
                if self.shared.stop.load(Ordering::Acquire) {
                    return Err(io::Error::new(io::ErrorKind::Interrupted, "Server stopped"));
                }
                let size = if verb == "STOR" {
                    match data.read(&mut block) {
                        Ok(n) => n,
                        Err(e) if timeout(&e) && activity.elapsed() < Duration::from_secs(30) => {
                            continue;
                        }
                        Err(e) => return Err(e),
                    }
                } else if let Some(file) = file.as_mut() {
                    file.read(&mut block)?
                } else {
                    list.read(&mut block)?
                };
                let eof = size == 0;
                source_bytes += size as u64;
                let payload = &block[..size];
                if eof && payload.is_empty() {
                    break;
                }
                if verb == "STOR" {
                    file.as_mut().unwrap().write_all(payload)?;
                    digest.update(payload);
                    count += size as u64;
                } else {
                    let mut offset = 0;
                    while offset < payload.len() {
                        if self.shared.stop.load(Ordering::Acquire) {
                            return Err(io::Error::new(
                                io::ErrorKind::Interrupted,
                                "Server stopped",
                            ));
                        }
                        match data.write(&payload[offset..]) {
                            Ok(0) => {
                                return Err(io::Error::new(
                                    io::ErrorKind::WriteZero,
                                    "Data connection closed",
                                ));
                            }
                            Ok(n) => {
                                digest.update(&payload[offset..offset + n]);
                                offset += n;
                                count += n as u64;
                                activity = Instant::now();
                            }
                            Err(e)
                                if timeout(&e) && activity.elapsed() < Duration::from_secs(30) =>
                            {
                                continue;
                            }
                            Err(e) => return Err(e),
                        }
                    }
                }
                activity = Instant::now();
                if report.elapsed() >= Duration::from_millis(200) {
                    let seconds = start.elapsed().as_secs_f64();
                    lock(&self.shared.transfers).insert(
                        self.id,
                        Progress {
                            client: self.peer.to_string(),
                            file: arg.into(),
                            direction: verb.into(),
                            bytes: count,
                            total,
                            seconds,
                            bytes_per_second: count as f64 / seconds.max(0.001),
                        },
                    );
                    report = Instant::now();
                }
                if eof {
                    break;
                }
            }
            if verb == "RETR" && total.is_some_and(|size| size != source_bytes) {
                return Err(io::Error::other("Source file changed during transfer"));
            }
            if verb == "STOR" {
                let f = file.as_mut().unwrap();
                f.flush()?;
                f.sync_all()?;
                if f.metadata()?.len() != count {
                    return Err(io::Error::other("Stored byte count mismatch"));
                }
                f.rewind()?;
                let mut stored = Sha256::new();
                loop {
                    if self.shared.stop.load(Ordering::Acquire) {
                        return Err(io::Error::other("Server stopped"));
                    }
                    let n = f.read(&mut block)?;
                    if n == 0 {
                        break;
                    }
                    stored.update(&block[..n]);
                }
                if stored.finalize() != digest.clone().finalize() {
                    return Err(io::Error::other("Stored SHA-256 mismatch"));
                }
            }
            data.flush()?;
            Ok(())
        })();
        drop(file);
        let shutdown = data.shutdown(Shutdown::Both);
        lock(&self.shared.sockets)
            .get_mut(&self.id)
            .map(|s| s.1.take());
        drop(data);
        lock(&self.shared.transfers).remove(&self.id);
        self.shared
            .log("DATA", format!("{} · Closed · {count} bytes", self.peer));
        let mut result = result.and(shutdown);
        let seconds = start.elapsed().as_secs_f64();
        if self.shared.stop.load(Ordering::Acquire) {
            return Ok(());
        }
        if result.is_ok()
            && let Some(temporary) = staged.take()
        {
            result = paths::resolve(&self.root, &self.cwd, arg, true).and_then(|(target, _)| {
                if target != path {
                    return Err(io::Error::other("Target path changed"));
                }
                temporary.persist(&target).map(|_| ()).map_err(|e| e.error)
            });
        }
        if result.is_ok() && matches!(verb, "STOR" | "RETR") {
            self.shared.log(
                "SHA256",
                format!("{} · {arg} · {:x}", self.peer, digest.finalize()),
            );
        }
        match result {
            Ok(()) => self.reply(
                226,
                &format!(
                    "Transfer complete · {count} bytes · {:.2} MB/s · {seconds:.2}s",
                    count as f64 / seconds.max(0.001) / 1_000_000.0
                ),
            ),
            Err(e) => {
                self.shared
                    .log("ERROR", format!("{} · {arg} · {e}", self.peer));
                self.reply(426, "Transfer aborted")
            }
        }
    }
}
fn timeout(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
    )
}

fn active_endpoint(verb: &str, arg: &str, peer: IpAddr) -> Option<SocketAddr> {
    let endpoint = if verb == "PORT" {
        let parts: Vec<u8> = arg
            .split(',')
            .map(str::parse)
            .collect::<Result<_, _>>()
            .ok()?;
        if parts.len() != 6 {
            return None;
        }
        SocketAddr::new(
            Ipv4Addr::new(parts[0], parts[1], parts[2], parts[3]).into(),
            u16::from(parts[4]) * 256 + u16::from(parts[5]),
        )
    } else {
        let delimiter = arg.chars().next()?;
        let parts: Vec<_> = arg.split(delimiter).collect();
        if parts.len() != 5 || parts[1] != "1" || !parts[0].is_empty() || !parts[4].is_empty() {
            return None;
        }
        SocketAddr::new(
            parts[2].parse::<Ipv4Addr>().ok()?.into(),
            parts[3].parse().ok()?,
        )
    };
    (endpoint.ip() == peer && endpoint.port() >= 1024).then_some(endpoint)
}

#[tauri::command]
pub async fn start_ftp(
    state: tauri::State<'_, FtpManager>,
    config: Config,
) -> Result<Snapshot, String> {
    if config.port == 0 {
        return Err("端口必须为 1–65535。".into());
    }
    if let Err(error) = state.start(config) {
        state.shared.log("ERROR", &error);
        return Err(error);
    }
    Ok(state.snapshot(0))
}
#[tauri::command]
pub async fn stop_ftp(state: tauri::State<'_, FtpManager>) -> Result<Snapshot, String> {
    state.stop();
    Ok(state.snapshot(0))
}
#[tauri::command]
pub fn read_ftp(state: tauri::State<'_, FtpManager>, after: u64) -> Snapshot {
    state.snapshot(after)
}
