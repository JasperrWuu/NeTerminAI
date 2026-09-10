use super::packet::Request;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    time::{Duration, Instant},
};

const TTL: Duration = Duration::from_secs(120);
const LIMIT: usize = 512;
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeKind {
    Letters,
    Digits,
    Uppercase,
    Lowercase,
    Mixed,
}
impl CodeKind {
    pub fn alphabet(self) -> &'static [u8] {
        match self {
            Self::Letters => b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
            Self::Digits => b"0123456789",
            Self::Uppercase => b"ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            Self::Lowercase => b"abcdefghijklmnopqrstuvwxyz",
            Self::Mixed => b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
        }
    }
}
pub fn random_code(kind: CodeKind, length: u8) -> Result<Vec<u8>, String> {
    if !(1..=32).contains(&length) {
        return Err("挑战码长度必须为 1–32".into());
    }
    let alphabet = kind.alphabet();
    let ceiling = 256 - 256 % alphabet.len();
    let mut code = Vec::new();
    while code.len() < length as usize {
        let mut random = [0; 32];
        getrandom::fill(&mut random).map_err(|e| format!("系统随机数不可用：{e}"))?;
        for byte in random {
            if (byte as usize) < ceiling {
                code.push(alphabet[byte as usize % alphabet.len()]);
            }
            if code.len() == length as usize {
                break;
            }
        }
    }
    Ok(code)
}
struct Challenge {
    ip: IpAddr,
    username: Vec<u8>,
    nas: Vec<u8>,
    code: Vec<u8>,
    expires: Instant,
}
struct Cached {
    peer: SocketAddr,
    request: Vec<u8>,
    response: Vec<u8>,
    expires: Instant,
}
pub struct Engine {
    kind: CodeKind,
    length: u8,
    challenges: HashMap<Vec<u8>, Challenge>,
    cache: VecDeque<Cached>,
}
impl Engine {
    pub fn new(kind: CodeKind, length: u8) -> Self {
        Self {
            kind,
            length,
            challenges: HashMap::new(),
            cache: VecDeque::new(),
        }
    }
    pub fn handle(
        &mut self,
        bytes: &[u8],
        peer: SocketAddr,
        now: Instant,
    ) -> Result<(Option<Vec<u8>>, &'static str), String> {
        self.challenges.retain(|_, c| c.expires > now);
        self.cache.retain(|c| c.expires > now);
        let Some(request) = Request::parse(bytes) else {
            return Ok((None, "DISCARD · 无效报文或签名"));
        };
        if let Some(cached) = self
            .cache
            .iter()
            .find(|c| c.peer == peer && c.request == request.bytes)
        {
            return Ok((Some(cached.response.clone()), "RETRY · 重发原响应"));
        }
        let username = request.get(1).unwrap_or_default();
        let mut nas = Vec::new();
        for kind in [4, 32] {
            if let Some(value) = request.get(kind) {
                nas.extend_from_slice(&[kind, value.len() as u8]);
                nas.extend_from_slice(value);
            }
        }
        let password = request.password();
        let mut extra = Vec::new();
        let mut issued = None;
        let (code, label) = if request.get(79).is_some() {
            (3, "REJECT · 不支持 EAP")
        } else if let Some(state) = request.get(24) {
            let valid = self
                .challenges
                .get(state)
                .is_some_and(|c| c.ip == peer.ip() && c.username == username && c.nas == nas);
            if valid {
                let challenge = self.challenges.remove(state).unwrap();
                if password.as_deref() == Some(&challenge.code) {
                    (2, "ACCEPT · 挑战认证成功")
                } else {
                    (3, "REJECT · 挑战码错误")
                }
            } else {
                (3, "REJECT · 挑战状态无效或已过期")
            }
        } else if request.get(3).is_some() {
            // Explicit lab policy: NOT a cryptographic CHAP credential verification.
            (2, "ACCEPT · CHAP 测试放行（未校验凭据）")
        } else if password.as_deref() == Some(b"admin@123") {
            (2, "ACCEPT · PAP 认证成功")
        } else if password.as_deref() == Some(b"Admin@123") {
            if self.challenges.len() >= LIMIT {
                (3, "REJECT · 挑战容量已满")
            } else {
                let challenge = random_code(self.kind, self.length)?;
                let mut state = [0u8; 24];
                getrandom::fill(&mut state).map_err(|e| e.to_string())?;
                extra.push((
                    18,
                    [b"Enter challenge code: ".as_slice(), &challenge].concat(),
                ));
                extra.push((24, state.to_vec()));
                issued = Some((
                    state.to_vec(),
                    Challenge {
                        ip: peer.ip(),
                        username: username.to_vec(),
                        nas,
                        code: challenge,
                        expires: now + TTL,
                    },
                ));
                (11, "CHALLENGE · 已发送挑战（120 秒有效）")
            }
        } else {
            (3, "REJECT · PAP 凭据不匹配")
        };
        let reply = request
            .response(code, &extra)
            .or_else(|| request.response(3, &[]));
        if let Some(reply) = &reply {
            if reply[0] == 11
                && let Some((state, challenge)) = issued
            {
                self.challenges.insert(state, challenge);
            }
            if self.cache.len() >= LIMIT {
                self.cache.pop_front();
            }
            self.cache.push_back(Cached {
                peer,
                request: request.bytes.to_vec(),
                response: reply.clone(),
                expires: now + Duration::from_secs(30),
            });
        }
        let label = if reply.as_ref().is_some_and(|r| r[0] != code) {
            "REJECT · 响应属性超出长度限制"
        } else {
            label
        };
        Ok((reply, label))
    }
}
