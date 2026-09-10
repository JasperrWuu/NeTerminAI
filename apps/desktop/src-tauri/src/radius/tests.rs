use super::*;
use packet::{Request, SECRET, md5_parts};

fn pap(password: &[u8], state: Option<&[u8]>, id: u8) -> Vec<u8> {
    let mut out = vec![1, id, 0, 0];
    out.extend_from_slice(&[id; 16]);
    out.extend_from_slice(&[32, 5, b'n', b'a', b's', 1, 3, b'u']);
    let mut plain = password.to_vec();
    plain.resize(plain.len().max(1).div_ceil(16) * 16, 0);
    let mut previous = vec![id; 16];
    let mut cipher = Vec::new();
    for part in plain.chunks(16) {
        let digest = md5_parts(&[SECRET, &previous]);
        previous = part.iter().zip(digest).map(|(a, b)| a ^ b).collect();
        cipher.extend_from_slice(&previous);
    }
    out.extend_from_slice(&[2, (cipher.len() + 2) as u8]);
    out.extend(cipher);
    if let Some(state) = state {
        out.extend_from_slice(&[24, (state.len() + 2) as u8]);
        out.extend_from_slice(state);
    }
    let length = (out.len() as u16).to_be_bytes();
    out[2..4].copy_from_slice(&length);
    out
}
fn attrs(bytes: &[u8], kind: u8) -> Vec<u8> {
    let mut i = 20;
    while i < bytes.len() {
        let len = bytes[i + 1] as usize;
        if bytes[i] == kind {
            return bytes[i + 2..i + len].to_vec();
        }
        i += len;
    }
    panic!("missing attribute {kind}");
}
#[test]
fn challenge_is_bound_one_time_expiring_and_retransmission_safe() {
    let now = Instant::now();
    let peer = "127.0.0.1:30000".parse().unwrap();
    let mut engine = Engine::new(CodeKind::Digits, 6);
    let first = pap(b"Admin@123", None, 1);
    let reply = engine.handle(&first, peer, now).unwrap().0.unwrap();
    assert_eq!(reply[0], 11);
    assert_eq!(engine.handle(&first, peer, now).unwrap().0.unwrap(), reply);
    let state = attrs(&reply, 24);
    let message = attrs(&reply, 18);
    let code = &message[message.len() - 6..];
    assert!(code.iter().all(u8::is_ascii_digit));
    let response = pap(code, Some(&state), 2);
    assert_eq!(
        engine
            .handle(&response, "127.0.0.2:30000".parse().unwrap(), now)
            .unwrap()
            .0
            .unwrap()[0],
        3
    );
    assert_eq!(
        engine.handle(&response, peer, now).unwrap().0.unwrap()[0],
        2
    );
    assert_eq!(
        engine.handle(&response, peer, now).unwrap().0.unwrap()[0],
        2
    ); // lost Accept retransmission
    assert_eq!(
        engine
            .handle(&pap(code, Some(&state), 3), peer, now)
            .unwrap()
            .0
            .unwrap()[0],
        3
    );
    let reply = engine
        .handle(&pap(b"Admin@123", None, 4), peer, now)
        .unwrap()
        .0
        .unwrap();
    let state = attrs(&reply, 24);
    let message = attrs(&reply, 18);
    assert_eq!(
        engine
            .handle(
                &pap(&message[message.len() - 6..], Some(&state), 5),
                peer,
                now + Duration::from_secs(121)
            )
            .unwrap()
            .0
            .unwrap()[0],
        3
    );
}
#[test]
fn packet_validation_padding_and_chained_pap() {
    let password = b"0123456789abcdef0123456789abcdef-tail";
    let request = pap(password, None, 7);
    assert_eq!(
        Request::parse(&request).unwrap().password().unwrap(),
        password
    );
    let mut padding = request.clone();
    padding.extend_from_slice(&[0xff; 10]);
    assert_eq!(Request::parse(&padding).unwrap().bytes, request);
    assert!(Request::parse(&request[..request.len() - 1]).is_none());
    let mut bad = request.clone();
    bad[21] = 1;
    assert!(Request::parse(&bad).is_none());
    let mut bad = request.clone();
    bad.extend_from_slice(&[3, 19]);
    bad.extend_from_slice(&[0; 17]);
    let len = (bad.len() as u16).to_be_bytes();
    bad[2..4].copy_from_slice(&len);
    assert!(Request::parse(&bad).is_none());
    for kind in [
        CodeKind::Letters,
        CodeKind::Digits,
        CodeKind::Uppercase,
        CodeKind::Lowercase,
        CodeKind::Mixed,
    ] {
        for _ in 0..10 {
            let code = engine::random_code(kind, 6).unwrap();
            assert_eq!(code.len(), 6);
            assert!(code.iter().all(|b| kind.alphabet().contains(b)));
        }
    }
}
#[test]
fn wildcard_udp_ipv4_ipv6_stop_and_rebind() {
    for ip in ["0.0.0.0", "::"] {
        let manager = RadiusManager::default();
        let config = Config {
            ip: ip.into(),
            port: 0,
            code_kind: CodeKind::Mixed,
            code_length: 6,
        };
        manager.start(config.clone()).unwrap();
        assert!(manager.start(config).is_err());
        let address: SocketAddr = manager.snapshot(0).address.unwrap().parse().unwrap();
        let local = if ip == "::" { "[::1]:0" } else { "127.0.0.1:0" };
        let client = UdpSocket::bind(local).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let target = SocketAddr::new(client.local_addr().unwrap().ip(), address.port());
        client.send_to(&pap(b"admin@123", None, 8), target).unwrap();
        let mut bytes = [0; 4096];
        let (n, _) = client.recv_from(&mut bytes).unwrap();
        assert_eq!(bytes[0], 2);
        assert!(n >= 20);
        manager.stop();
        assert!(!manager.snapshot(0).running);
        assert!(UdpSocket::bind(address).is_ok());
    }
}
#[test]
#[ignore = "Requires Python for independent hashlib/HMAC UDP integration"]
fn python_radius_client() {
    for ip in ["0.0.0.0", "::"] {
        let manager = RadiusManager::default();
        manager
            .start(Config {
                ip: ip.into(),
                port: 0,
                code_kind: CodeKind::Mixed,
                code_length: 6,
            })
            .unwrap();
        let address: SocketAddr = manager.snapshot(0).address.unwrap().parse().unwrap();
        let result = std::process::Command::new("python")
            .args([
                "-c",
                include_str!("client_test.py"),
                if ip == "::" { "::1" } else { "127.0.0.1" },
                &address.port().to_string(),
            ])
            .output()
            .unwrap();
        manager.stop();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        println!("{}", String::from_utf8_lossy(&result.stdout));
    }
}
