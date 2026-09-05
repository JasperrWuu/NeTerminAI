use std::net::{Ipv4Addr, SocketAddr, UdpSocket};

use super::run_blocking;

/// Returns the IPv4 address selected by Windows for the default network path.
/// UDP connect only asks the OS to choose a route; it does not send a packet.
#[tauri::command]
pub async fn get_local_ipv4() -> Result<Option<String>, String> {
    run_blocking("读取本机 IPv4", || {
        Ok(select_default_route_ipv4().map(|address| address.to_string()))
    })
    .await
}

fn select_default_route_ipv4() -> Option<Ipv4Addr> {
    // Connecting a UDP socket to a routable address lets the OS select the
    // source interface according to its current route metrics. The fallback
    // targets cover networks that filter one public DNS address.
    for endpoint in ["8.8.8.8:53", "1.1.1.1:53", "223.5.5.5:53"] {
        let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) else {
            continue;
        };
        if socket.connect(endpoint).is_err() {
            continue;
        }
        let Ok(SocketAddr::V4(local)) = socket.local_addr() else {
            continue;
        };
        if is_usable_ipv4(*local.ip()) {
            return Some(*local.ip());
        }
    }
    None
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
    use super::is_usable_ipv4;

    #[test]
    fn rejects_non_routable_ipv4_addresses() {
        assert!(!is_usable_ipv4("0.0.0.0".parse().unwrap()));
        assert!(!is_usable_ipv4("127.0.0.1".parse().unwrap()));
        assert!(!is_usable_ipv4("169.254.12.8".parse().unwrap()));
        assert!(!is_usable_ipv4("224.0.0.1".parse().unwrap()));
        assert!(!is_usable_ipv4("255.255.255.255".parse().unwrap()));
    }

    #[test]
    fn accepts_private_and_public_unicast_ipv4_addresses() {
        assert!(is_usable_ipv4("192.168.1.100".parse().unwrap()));
        assert!(is_usable_ipv4("10.0.0.8".parse().unwrap()));
        assert!(is_usable_ipv4("203.0.113.10".parse().unwrap()));
    }
}
