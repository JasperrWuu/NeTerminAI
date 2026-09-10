use super::*;
use std::io::{BufRead, BufReader};

#[test]
fn file_bytes_survive_default_binary_and_overwrite() {
    let (manager, root, address) = setup();
    let mut client = Client::new(&address);
    client.command("USER admin - 测试", 331);
    client.command("PASS  pass word ", 230);
    let mut bytes = vec![b'x'; 65535];
    bytes.extend_from_slice(b"\r\n\r\0\n\r\r\n");
    bytes.extend((0..=255).cycle().take(150000));
    bytes.extend_from_slice("中文\n尾部\r".as_bytes());
    for (round, payload) in [&bytes[..], &bytes[..17], &b""[..]].iter().enumerate() {
        // First round deliberately sends no TYPE; later rounds overwrite a larger file.
        if round == 1 {
            client.command("TYPE I", 200);
        }
        if round == 2 {
            client.command("TYPE L 8", 200);
        }
        let listener = client.endpoint(round % 2 == 0);
        client.send("STOR exact.bin");
        client.reply(150);
        let (mut data, _) = listener.accept().unwrap();
        for chunk in payload.chunks(3) {
            data.write_all(chunk).unwrap();
        }
        data.shutdown(Shutdown::Write).unwrap();
        drop(data);
        client.reply(226);
        assert_eq!(std::fs::read(root.join("exact.bin")).unwrap(), *payload);
        let listener = client.endpoint(round % 2 != 0);
        client.send("RETR exact.bin");
        client.reply(150);
        let (mut data, _) = listener.accept().unwrap();
        let mut received = Vec::new();
        data.read_to_end(&mut received).unwrap();
        client.reply(226);
        assert_eq!(received, *payload);
        client.command("NOOP", 200);
    }
    std::fs::write(root.join("exact.bin"), &bytes).unwrap();
    client.command("TYPE A", 200);
    client.command("STOR exact.bin", 504);
    client.command("RETR exact.bin", 504);
    assert_eq!(std::fs::read(root.join("exact.bin")).unwrap(), bytes);
    client.command("NOOP", 200);
    manager.stop();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "Requires Python standard-library ftplib"]
fn python_active_client_integration() {
    let (manager, root, address) = setup();
    std::fs::create_dir(root.join("sub")).unwrap();
    let endpoint: SocketAddr = address.parse().unwrap();
    let output = std::process::Command::new("python")
        .args([
            "-c",
            include_str!("client_test.py"),
            "127.0.0.1",
            &endpoint.port().to_string(),
        ])
        .arg(&root)
        .output()
        .unwrap();
    manager.stop();
    std::fs::remove_dir_all(root).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    println!("{}", String::from_utf8_lossy(&output.stdout));
}

fn setup() -> (FtpManager, PathBuf, String) {
    static ID: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "neterminai-ftp-test-{}-{}",
        std::process::id(),
        ID.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).unwrap();
    let manager = FtpManager::default();
    manager
        .start(Config {
            ip: "127.0.0.1".into(),
            port: 0,
            root: root.to_string_lossy().into(),
            username: "admin - 测试".into(),
            password: " pass word ".into(),
        })
        .unwrap();
    let address = manager.snapshot(0).address.unwrap();
    (manager, root, address)
}
struct Client {
    stream: TcpStream,
    reader: BufReader<TcpStream>,
}
impl Client {
    fn new(address: &str) -> Self {
        let stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        let mut result = Self {
            reader: BufReader::new(stream.try_clone().unwrap()),
            stream,
        };
        result.reply(220);
        result
    }
    fn reply(&mut self, code: u16) -> String {
        let mut line = String::new();
        self.reader.read_line(&mut line).unwrap();
        assert!(
            line.starts_with(&code.to_string()),
            "expected {code}, got {line}"
        );
        line
    }
    fn send(&mut self, command: &str) {
        write!(self.stream, "{command}\r\n").unwrap();
    }
    fn command(&mut self, command: &str, code: u16) {
        self.send(command);
        self.reply(code);
    }
    fn login(&mut self) {
        self.command("USER admin - 测试", 331);
        self.command("PASS  pass word ", 230);
        self.command("TYPE I", 200);
    }
    fn endpoint(&mut self, eprt: bool) -> TcpListener {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        self.command(
            &if eprt {
                format!("EPRT |1|127.0.0.1|{port}|")
            } else {
                format!("PORT 127,0,0,1,{},{}", port / 256, port % 256)
            },
            200,
        );
        listener
    }
}
#[test]
fn active_get_put_completion_and_client_isolation() {
    let (manager, root, address) = setup();
    let mut first = Client::new(&address);
    let mut second = Client::new(&address);
    first.command("RETR missing", 530);
    first.login();
    first.command("PASV", 502);
    first.command("EPSV", 502);
    first.command("NOOP", 200);
    second.command("RETR upload.bin", 530);
    second.command("USER wrong", 530);
    second.command("PASS wrong", 530);
    let bytes: Vec<_> = (0..250000).map(|n| (n % 251) as u8).collect();
    for round in 0..3 {
        let listener = first.endpoint(round % 2 == 0);
        first.send("STOR upload.bin");
        first.reply(150);
        let (mut data, _) = listener.accept().unwrap();
        data.write_all(&bytes).unwrap();
        data.shutdown(Shutdown::Write).unwrap();
        drop(data);
        first.reply(226);
        assert_eq!(std::fs::read(root.join("upload.bin")).unwrap(), bytes);
        first.command("RETR upload.bin", 425);
        let listener = first.endpoint(round % 2 != 0);
        first.send("RETR upload.bin");
        first.reply(150);
        let (mut data, _) = listener.accept().unwrap();
        let mut received = Vec::new();
        data.read_to_end(&mut received).unwrap();
        drop(data);
        first.reply(226);
        assert_eq!(received, bytes);
        first.command("NOOP", 200);
    }
    first.command("PORT 127,0,0,2,200,1", 501);
    first.command("EPRT |1|127.0.0.1|21|", 501);
    let listener = first.endpoint(false);
    drop(listener);
    first.send("RETR upload.bin");
    first.reply(150);
    first.reply(425);
    first.command("NOOP", 200);
    let _listener = first.endpoint(false);
    first.command("RETR ../outside", 550);
    first.command("CWD /", 250);
    first.command("CDUP", 550);
    first.command("QUIT", 221);
    second.command("QUIT", 221);
    manager.stop();
    assert!(TcpListener::bind(&address).is_ok());
    assert!(
        !manager
            .snapshot(0)
            .logs
            .iter()
            .any(|e| e.message.contains("pass word"))
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn root_rejects_escape_links_and_device_paths() {
    let (manager, root, _) = setup();
    let canonical = std::fs::canonicalize(&root).unwrap();
    for name in [
        "../outside",
        "a/../../outside",
        "C:/Windows/win.ini",
        "\\\\server\\file",
        "NUL",
        "file:stream",
        "directory. /file",
    ] {
        assert!(
            paths::resolve(&canonical, &[], name, true).is_err(),
            "{name}"
        );
    }
    std::fs::create_dir(root.join("sub")).unwrap();
    assert_eq!(
        paths::resolve(&canonical, &["sub".into()], "../ok", true)
            .unwrap()
            .0,
        canonical.join("ok")
    );
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(std::env::temp_dir(), root.join("link")).is_ok() {
            assert!(paths::resolve(&canonical, &[], "link/escape", true).is_err());
            std::fs::remove_dir(root.join("link")).unwrap();
        }
    }
    manager.stop();
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn stop_closes_control_and_active_upload() {
    let (manager, root, address) = setup();
    let mut client = Client::new(&address);
    client.login();
    let listener = client.endpoint(true);
    client.send("STOR pending");
    client.reply(150);
    let (mut data, _) = listener.accept().unwrap();
    data.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    data.write_all(b"partial").unwrap();
    manager.stop();
    assert!(matches!(data.read(&mut [0u8; 1]), Ok(0) | Err(_)));
    let mut line = String::new();
    let _ = client.reader.read_line(&mut line);
    assert!(!line.starts_with("226"));
    assert!(TcpListener::bind(&address).is_ok());
    std::fs::remove_dir_all(root).unwrap();
}
