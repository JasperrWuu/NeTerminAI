import type { TerminalHighlightSet } from "./types";

/** Semantic accents only: leave most CLI text in its original foreground. */
export function createDefaultHighlightSets(): TerminalHighlightSet[] {
  const patterns = [
    ["failure", "\\b(?:error|failed|failure|down|denied|unreachable)\\b"],
    ["warning", "\\b(?:warning|warn|pending|idle|disabled)\\b"],
    ["success", "\\b(?:up|normal|success|succeeded|established|enabled)\\b"],
    ["address", "\\b(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\b"],
    ["interface", "\\b(?:GE|XGE|GigabitEthernet|Eth-Trunk|MEth|Vlanif)[0-9]+(?:/[0-9]+)*\\b"],
    ["pager", "----\\s*More\\s*----|\\[Y\\s*/\\s*N\\]"],
  ];
  patterns.push(
    ["mac", "\\b(?:[0-9a-f]{4}-){2}[0-9a-f]{4}\\b|\\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\\b"],
    ["protocol", "\\b(?:OSPF|BGP|BFD|VRRP|IPSec|IKE|TCP|UDP|ICMP|HTTP|HTTPS|SSH|SNMP|NETCONF|LLDP)\\b"],
    ["time", "\\b(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\b"],
    ["percentage", "\\b\\d+(?:\\.\\d+)?%"],
    ["capacity", "\\b\\d+(?:\\.\\d+)?\\s*(?:Gbps|Mbps|Kbps|GB|MB|KB)\\b"],
    ["version", "\\bV\\d{3}R\\d{3}(?:C\\d{2})?(?:SPC\\d+)?\\b"],
  );
  const names = ["故障与拒绝", "告警与等待", "正常与已连接", "IPv4 地址", "接口与聚合链路", "分页与确认", "MAC 地址", "网络协议", "时间", "利用率", "速率与容量", "系统版本"];
  return [
    { id: "builtin-dark", name: "墨夜 · 网络诊断", enabled: true, colors: ["#E68A8A", "#D9B77A", "#88C5A5", "#91B9E8", "#B7A4D9", "#D9B77A"] },
    { id: "builtin-light", name: "云纸 · 网络诊断", enabled: false, colors: ["#A83F46", "#805A13", "#276B48", "#285F9B", "#705295", "#805A13"] },
  ].map(({ colors, ...set }) => ({
    ...set,
    rules: patterns.map(([id, pattern], index) => ({
      id: `${set.id}-${id}`, name: names[index], pattern,
      color: colors[[0, 1, 2, 3, 4, 5, 3, 4, 3, 1, 3, 4][index]],
      matchMode: "regex", enabled: true, caseSensitive: false,
    })),
  }));
}
