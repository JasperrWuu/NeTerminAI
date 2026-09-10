//! RADIUS Access-Request framing, PAP hiding and response authenticators.
use hmac::{Hmac, Mac};
use md5::{Digest, Md5};

pub const SECRET: &[u8] = b"admin@123";
pub struct Request<'a> {
    pub bytes: &'a [u8],
    pub attrs: Vec<(u8, &'a [u8])>,
    pub message_authenticator: bool,
}
impl<'a> Request<'a> {
    pub fn parse(bytes: &'a [u8]) -> Option<Self> {
        if bytes.len() < 20 || bytes[0] != 1 {
            return None;
        }
        let length = u16::from_be_bytes([bytes[2], bytes[3]]) as usize;
        if !(20..=4096).contains(&length) || length > bytes.len() {
            return None;
        }
        // RFC 2865: bytes outside Length are padding, not attributes.
        let bytes = &bytes[..length];
        let mut attrs = Vec::new();
        let mut offset = 20;
        let mut ma = None;
        while offset < length {
            if offset + 2 > length {
                return None;
            }
            let kind = bytes[offset];
            let size = bytes[offset + 1] as usize;
            if kind == 0 || size < 2 || offset + size > length {
                return None;
            }
            let value = &bytes[offset + 2..offset + size];
            if matches!(kind, 1 | 2 | 3 | 4 | 5 | 24 | 32 | 60 | 61 | 80)
                && attrs.iter().any(|(t, _)| *t == kind)
            {
                return None;
            }
            let valid = match kind {
                1 | 24 | 32 | 33 | 60 => !value.is_empty(),
                2 => (16..=128).contains(&value.len()) && value.len().is_multiple_of(16),
                3 => value.len() == 17,
                4..=10 | 12 | 13 | 15 | 16 | 23 | 27..=29 | 37 | 38 | 61 | 62 => value.len() == 4,
                80 => value.len() == 16,
                _ => true,
            };
            if !valid {
                return None;
            }
            if kind == 80 {
                ma = Some(offset + 2);
            }
            attrs.push((kind, value));
            offset += size;
        }
        if let Some(at) = ma {
            let mut signed = bytes.to_vec();
            signed[at..at + 16].fill(0);
            let mut hmac = <Hmac<Md5> as Mac>::new_from_slice(SECRET).ok()?;
            Mac::update(&mut hmac, &signed);
            if hmac.verify_slice(&bytes[at..at + 16]).is_err() {
                return None;
            }
        }
        let request = Self {
            bytes,
            attrs,
            message_authenticator: ma.is_some(),
        };
        // EAP is not implemented. Never process an unauthenticated EAP packet.
        if request.get(79).is_some() && !request.message_authenticator {
            return None;
        }
        if request.get(4).is_none() && request.get(32).is_none() {
            return None;
        }
        if request.get(2).is_some() && request.get(3).is_some() {
            return None;
        }
        Some(request)
    }
    pub fn get(&self, kind: u8) -> Option<&'a [u8]> {
        self.attrs.iter().find(|(t, _)| *t == kind).map(|(_, v)| *v)
    }
    pub fn password(&self) -> Option<Vec<u8>> {
        let cipher = self.get(2)?;
        let mut previous = &self.bytes[4..20];
        let mut plain = Vec::with_capacity(cipher.len());
        for block in cipher.as_chunks::<16>().0 {
            let hash = md5_parts(&[SECRET, previous]);
            plain.extend(block.iter().zip(hash).map(|(a, b)| a ^ b));
            previous = block;
        }
        while plain.last() == Some(&0) {
            plain.pop();
        }
        Some(plain)
    }
    pub fn response(&self, code: u8, extra: &[(u8, Vec<u8>)]) -> Option<Vec<u8>> {
        let mut reply = vec![code, self.bytes[1], 0, 0];
        reply.extend_from_slice(&self.bytes[4..20]);
        // Message-Authenticator precedes Proxy-State; MAC uses request authenticator.
        let ma = if self.message_authenticator {
            reply.extend_from_slice(&[80, 18]);
            let at = reply.len();
            reply.extend_from_slice(&[0; 16]);
            Some(at)
        } else {
            None
        };
        for (kind, value) in extra
            .iter()
            .map(|(t, v)| (*t, v.as_slice()))
            .chain(self.attrs.iter().filter(|(t, _)| *t == 33).copied())
        {
            if value.is_empty() || value.len() > 253 {
                return None;
            }
            reply.extend_from_slice(&[kind, (value.len() + 2) as u8]);
            reply.extend_from_slice(value);
        }
        if reply.len() > 4096 {
            return None;
        }
        let length = (reply.len() as u16).to_be_bytes();
        reply[2..4].copy_from_slice(&length);
        if let Some(at) = ma {
            let mut hmac = <Hmac<Md5> as Mac>::new_from_slice(SECRET).ok()?;
            Mac::update(&mut hmac, &reply);
            reply[at..at + 16].copy_from_slice(&hmac.finalize().into_bytes());
        }
        let signature = md5_parts(&[&reply, SECRET]);
        reply[4..20].copy_from_slice(&signature);
        Some(reply)
    }
}
pub fn md5_parts(parts: &[&[u8]]) -> [u8; 16] {
    let mut digest = Md5::new();
    for part in parts {
        Digest::update(&mut digest, part);
    }
    digest.finalize().into()
}
