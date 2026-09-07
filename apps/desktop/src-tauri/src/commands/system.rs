use std::{cmp::Ordering, net::Ipv4Addr};

use super::run_blocking;

const PPP_ADAPTER_PREFIX: &str = "usg";

/// Returns the IPv4 address assigned to the first usable `usg*` PPP adapter.
///
/// This intentionally does not use the default route: a machine can have a
/// normal Ethernet/Wi-Fi route and a separate PPP address at the same time,
/// while the network tools that consume this shortcut need the latter.
#[tauri::command]
pub async fn get_local_ipv4() -> Result<Option<String>, String> {
    run_blocking("读取本机 IPv4", || {
        select_usg_ipv4().map(|address| address.map(|value| value.to_string()))
    })
    .await
}

fn select_usg_ipv4() -> Result<Option<Ipv4Addr>, String> {
    #[cfg(windows)]
    {
        native_adapters().map(select_adapter_ipv4)
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

fn select_adapter_ipv4(mut adapters: Vec<(String, Vec<Ipv4Addr>)>) -> Option<Ipv4Addr> {
    adapters.retain(|(name, _)| {
        name.trim()
            .to_ascii_lowercase()
            .starts_with(PPP_ADAPTER_PREFIX)
    });
    adapters.sort_by(|a, b| compare_usg_alias(&a.0, &b.0));
    adapters
        .into_iter()
        .find_map(|(_, addresses)| addresses.into_iter().find(|ip| is_usable_ipv4(*ip)))
}

#[cfg(windows)]
fn native_adapters() -> Result<Vec<(String, Vec<Ipv4Addr>)>, String> {
    use windows::Win32::{
        Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_NO_DATA, NO_ERROR},
        NetworkManagement::{
            IpHelper::{
                GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST,
                GetAdaptersAddresses, IP_ADAPTER_ADDRESSES_LH,
            },
            Ndis::IfOperStatusUp,
        },
        Networking::WinSock::{AF_INET, SOCKADDR_IN},
    };
    let mut size = 15_000u32;
    for _ in 0..3 {
        // Typed allocation preserves the alignment required by the linked Win32 structures.
        let count = (size as usize).div_ceil(std::mem::size_of::<IP_ADAPTER_ADDRESSES_LH>());
        let mut storage = vec![IP_ADAPTER_ADDRESSES_LH::default(); count];
        let head = storage.as_mut_ptr();
        let status = unsafe {
            GetAdaptersAddresses(
                AF_INET.0 as u32,
                GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER,
                None,
                Some(head),
                &mut size,
            )
        };
        if status == ERROR_BUFFER_OVERFLOW.0 {
            continue;
        }
        if status == ERROR_NO_DATA.0 {
            return Ok(Vec::new());
        }
        if status != NO_ERROR.0 {
            return Err(format!("读取网络接口失败（Windows {status}）"));
        }
        let mut adapters = Vec::new();
        let mut next = head;
        while !next.is_null() {
            // All linked pointers belong to storage, which remains alive during traversal.
            let adapter = unsafe { &*next };
            next = adapter.Next;
            if adapter.OperStatus != IfOperStatusUp || adapter.FriendlyName.is_null() {
                continue;
            }
            let name =
                unsafe { adapter.FriendlyName.to_string() }.map_err(|_| "网卡名称编码无效")?;
            let mut addresses = Vec::new();
            let mut unicast = adapter.FirstUnicastAddress;
            while !unicast.is_null() {
                let item = unsafe { &*unicast };
                unicast = item.Next;
                if item.Address.lpSockaddr.is_null()
                    || item.Address.iSockaddrLength < std::mem::size_of::<SOCKADDR_IN>() as i32
                {
                    continue;
                }
                let socket = unsafe { &*item.Address.lpSockaddr.cast::<SOCKADDR_IN>() };
                if socket.sin_family == AF_INET {
                    let octets = unsafe { socket.sin_addr.S_un.S_addr }.to_ne_bytes();
                    addresses.push(Ipv4Addr::from(octets));
                }
            }
            adapters.push((name, addresses));
        }
        return Ok(adapters);
    }
    Err("网络接口正在变化，请重试".to_owned())
}

fn compare_usg_alias(left: &str, right: &str) -> Ordering {
    let left = left.trim().to_ascii_lowercase();
    let right = right.trim().to_ascii_lowercase();
    let left_suffix = left.strip_prefix(PPP_ADAPTER_PREFIX).unwrap_or(&left);
    let right_suffix = right.strip_prefix(PPP_ADAPTER_PREFIX).unwrap_or(&right);
    let left_number = if left_suffix.is_empty() {
        Some(0)
    } else {
        left_suffix.parse::<u32>().ok()
    };
    let right_number = if right_suffix.is_empty() {
        Some(0)
    } else {
        right_suffix.parse::<u32>().ok()
    };
    // Numeric aliases sort before any non-numeric `usg-*` alias; the latter
    // still match the prefix but use a stable lexical order.
    let left_rank = usize::from(left_number.is_none());
    let right_rank = usize::from(right_number.is_none());
    left_rank
        .cmp(&right_rank)
        .then_with(|| left_number.cmp(&right_number))
        .then_with(|| left.cmp(&right))
}

fn is_usable_ipv4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    !address.is_unspecified()
        && !address.is_loopback()
        && !address.is_multicast()
        && octets != [255, 255, 255, 255]
        && !(octets[0] == 169 && octets[1] == 254)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_non_routable_ipv4_addresses() {
        for address in [
            "0.0.0.0",
            "127.0.0.1",
            "169.254.12.8",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            assert!(!is_usable_ipv4(address.parse().unwrap()));
        }
    }

    #[test]
    fn accepts_private_and_public_unicast_ipv4_addresses() {
        for address in ["192.168.1.100", "10.0.0.8", "203.0.113.10"] {
            assert!(is_usable_ipv4(address.parse().unwrap()));
        }
    }

    #[test]
    fn native_selection_preserves_usg_rules() {
        for name in ["usg0", "usg1", "usg2", "usg10", " USG0 "] {
            assert_eq!(
                select_adapter_ipv4(vec![(name.into(), vec![Ipv4Addr::new(10, 1, 1, 1)])]),
                Some(Ipv4Addr::new(10, 1, 1, 1))
            );
        }
        assert_eq!(
            select_adapter_ipv4(vec![
                ("usg10".into(), vec![Ipv4Addr::new(10, 0, 0, 10)]),
                ("usg2".into(), vec![Ipv4Addr::new(10, 0, 0, 2)]),
                ("usg0".into(), vec![]),
                (
                    "usg1".into(),
                    vec![Ipv4Addr::LOCALHOST, Ipv4Addr::UNSPECIFIED]
                ),
                ("Ethernet".into(), vec![Ipv4Addr::new(10, 0, 0, 1)]),
            ]),
            Some(Ipv4Addr::new(10, 0, 0, 2))
        );
        for address in [
            "127.0.0.9",
            "0.0.0.0",
            "169.254.2.3",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            assert!(!is_usable_ipv4(address.parse().unwrap()));
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "local profiling; prints timing only, never adapter data"]
    fn profile_native_query() {
        let mut samples = Vec::new();
        for _ in 0..20 {
            let start = std::time::Instant::now();
            native_adapters().unwrap();
            samples.push(start.elapsed());
        }
        samples.sort();
        eprintln!(
            "native NIC query: samples=20 median={:?} worst={:?}",
            (samples[9] + samples[10]) / 2,
            samples[19]
        );
    }
}
