use std::{net::Ipv4Addr, process::Command};

use super::run_blocking;

const PPP_ADAPTER_ALIAS: &str = "usg";

/// Returns the IPv4 address assigned to the `PPP adapter usg` connection.
///
/// This intentionally does not use the default route: a machine can have a
/// normal Ethernet/Wi-Fi route and a separate PPP address at the same time,
/// while the network tools that consume this shortcut need the latter.
#[tauri::command]
pub async fn get_local_ipv4() -> Result<Option<String>, String> {
    run_blocking("读取本机 IPv4", || {
        Ok(select_usg_ipv4().map(|address| address.to_string()))
    })
    .await
}

fn select_usg_ipv4() -> Option<Ipv4Addr> {
    #[cfg(windows)]
    {
        query_ipconfig_adapter_ipv4(PPP_ADAPTER_ALIAS)
    }

    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(windows)]
fn query_ipconfig_adapter_ipv4(interface_alias: &str) -> Option<Ipv4Addr> {
    let output = Command::new("ipconfig.exe").arg("/all").output().ok()?;
    parse_ipconfig_adapter_ipv4(&output.stdout, interface_alias)
}

fn parse_ipconfig_adapter_ipv4(output: &[u8], interface_alias: &str) -> Option<Ipv4Addr> {
    let target_suffix = format!("{}:", interface_alias.trim().to_ascii_lowercase());
    let mut in_target_adapter = false;
    for line in String::from_utf8_lossy(output).lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        if lower.ends_with(&target_suffix) && !lower.contains('.') {
            in_target_adapter = true;
            continue;
        }
        if in_target_adapter && lower.ends_with(':') && !lower.contains('.') {
            break;
        }
        if !in_target_adapter {
            continue;
        }
        if !lower.contains("ipv4") {
            continue;
        }
        for token in
            trimmed.split(|character: char| !character.is_ascii_digit() && character != '.')
        {
            let Ok(address) = token.parse::<Ipv4Addr>() else {
                continue;
            };
            if is_usable_ipv4(address) {
                return Some(address);
            }
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
    use super::{is_usable_ipv4, parse_ipconfig_adapter_ipv4};

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

    #[test]
    fn parses_the_ipv4_from_the_usg_adapter_block() {
        assert_eq!(
            parse_ipconfig_adapter_ipv4(
                b"Ethernet adapter Ethernet:\r\n    IPv4 Address. . . . . . : 192.168.1.20\r\n\r\nPPP adapter usg:\r\n    IPv4 Address. . . . . . : 169.254.1.2\r\n    IPv4 Address. . . . . . : 100.64.20.7 (Preferred)\r\n\r\n",
                "usg",
            ),
            Some("100.64.20.7".parse().unwrap()),
        );
    }

    #[test]
    fn parses_the_localized_usg_adapter_heading() {
        assert_eq!(
            parse_ipconfig_adapter_ipv4(
                "PPP 适配器 usg:\r\n    IPv4 地址 . . . . . . . . . . : 100.64.20.8(首选)\r\n"
                    .as_bytes(),
                "usg",
            ),
            Some("100.64.20.8".parse().unwrap()),
        );
    }
}
