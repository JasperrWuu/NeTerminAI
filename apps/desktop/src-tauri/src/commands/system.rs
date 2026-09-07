use std::{cmp::Ordering, net::Ipv4Addr, process::Command};

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
        Ok(select_usg_ipv4().map(|address| address.to_string()))
    })
    .await
}

fn select_usg_ipv4() -> Option<Ipv4Addr> {
    #[cfg(windows)]
    {
        query_ipconfig_adapter_ipv4(PPP_ADAPTER_PREFIX)
    }

    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(windows)]
fn query_ipconfig_adapter_ipv4(interface_alias: &str) -> Option<Ipv4Addr> {
    let mut command = Command::new("ipconfig.exe");
    command.arg("/all");
    // `ipconfig.exe` is a console-subsystem process.  A GUI build must not
    // briefly create a console window merely to read the adapter inventory.
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
    let output = command.output().ok()?;
    parse_ipconfig_adapter_ipv4(&output.stdout, interface_alias)
}

fn parse_ipconfig_adapter_ipv4(output: &[u8], interface_alias: &str) -> Option<Ipv4Addr> {
    let target_prefix = interface_alias.trim().to_ascii_lowercase();
    let mut current: Option<(String, Vec<Ipv4Addr>)> = None;
    let mut candidates = Vec::<(String, Vec<Ipv4Addr>)>::new();
    for line in String::from_utf8_lossy(output).lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        if is_adapter_heading(&lower) {
            if let Some((alias, addresses)) = current.take()
                && alias.starts_with(&target_prefix)
            {
                candidates.push((alias, addresses));
            }
            current = lower
                .strip_suffix(':')
                .and_then(|heading| heading.split_whitespace().last())
                .map(|alias| (alias.to_owned(), Vec::new()));
            continue;
        }
        let Some((alias, addresses)) = current.as_mut() else {
            continue;
        };
        if !alias.starts_with(&target_prefix) {
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
                addresses.push(address);
            }
        }
    }
    if let Some((alias, addresses)) = current
        && alias.starts_with(&target_prefix)
    {
        candidates.push((alias, addresses));
    }
    candidates.sort_by(|left, right| compare_usg_alias(&left.0, &right.0));
    candidates
        .into_iter()
        .find_map(|(_, addresses)| addresses.into_iter().next())
}

fn is_adapter_heading(line: &str) -> bool {
    line.ends_with(':') && !line.contains('.') && !line.contains("ipv4") && !line.contains("ipv6")
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

    #[test]
    fn matches_all_usg_adapters_and_uses_natural_numeric_order() {
        assert_eq!(
            parse_ipconfig_adapter_ipv4(
                b"PPP adapter usg10:\r\n    IPv4 Address. . . : 100.64.10.10\r\n\r\nPPP adapter USG2:\r\n    IPv4 Address. . . : 100.64.2.2\r\n\r\nPPP adapter usg1:\r\n    IPv4 Address. . . : 100.64.1.1\r\n",
                "usg",
            ),
            Some("100.64.1.1".parse().unwrap()),
        );
    }
}
