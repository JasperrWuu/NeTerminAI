const V4_MAX = (1n << 32n) - 1n;
const V6_MAX = (1n << 128n) - 1n;

export function parseIpv4(address: string): bigint {
  const parts = address.trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) {
    throw new Error("请输入有效的 IPv4 地址");
  }
  return parts.reduce((value, part) => (value << 8n) | BigInt(part), 0n);
}
function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => ((value >> shift) & 255n).toString()).join(".");
}
export function parsePrefix(value: string, max: number): number {
  const text = value.trim();
  if (!/^\d{1,3}$/.test(text) || Number(text) > max) throw new Error(`请输入 0–${max} 的纯数字前缀`);
  return Number(text);
}
export function parseIpv4MaskOrPrefix(value: string): number {
  if (!value.includes(".")) return parsePrefix(value, 32);
  let mask: bigint;
  try { mask = parseIpv4(value); } catch { throw new Error("请输入有效的子网掩码或 0–32 的前缀"); }
  const inverse = V4_MAX ^ mask;
  if ((inverse & (inverse + 1n)) !== 0n) throw new Error("子网掩码中的 1 必须连续");
  return mask.toString(2).replaceAll("0", "").length;
}
export function calculateIpv4(address: string, maskOrPrefix: string) {
  const ip = parseIpv4(address);
  const prefix = parseIpv4MaskOrPrefix(maskOrPrefix);
  const total = 1n << BigInt(32 - prefix);
  const mask = V4_MAX ^ (total - 1n);
  const network = ip & mask;
  const broadcast = network + total - 1n;
  // Point-to-point (31) and host routes (32) have no reserved end addresses.
  const usable = prefix >= 31 ? total : total - 2n;
  return { address: formatIpv4(ip), network: formatIpv4(network), mask: formatIpv4(mask), prefix,
    broadcast: formatIpv4(broadcast), first: formatIpv4(prefix >= 31 ? network : network + 1n),
    last: formatIpv4(prefix >= 31 ? broadcast : broadcast - 1n), total: total.toString(), usable: usable.toString() };
}

export function parseIpv6(address: string): bigint {
  let text = address.trim();
  const invalid = () => new Error("请输入有效的 IPv6 地址");
  if (!text || text.length > 45 || /[%/\s]/.test(text)) throw invalid();
  if (text.includes(".")) {
    const split = text.lastIndexOf(":");
    if (split < 0) throw invalid();
    let v4: bigint;
    try { v4 = parseIpv4(text.slice(split + 1)); } catch { throw invalid(); }
    text = `${text.slice(0, split + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 65535n).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) throw invalid();
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const count = left.length + right.length;
  if (halves.length === 1 ? count !== 8 : count >= 8) throw invalid();
  const groups = [...left, ...Array<string>(8 - count).fill("0"), ...right];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) throw invalid();
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}
function ipv6Formats(value: bigint) {
  const groups = Array.from({ length: 8 }, (_, i) => ((value >> BigInt((7 - i) * 16)) & 65535n).toString(16));
  let bestStart = -1; let bestLength = 1;
  for (let i = 0; i < groups.length;) {
    if (groups[i] !== "0") { i++; continue; }
    const start = i;
    while (i < groups.length && groups[i] === "0") i++;
    if (i - start > bestLength) { bestStart = start; bestLength = i - start; }
  }
  const compressed = bestStart < 0 ? groups.join(":")
    : `${groups.slice(0, bestStart).join(":")}::${groups.slice(bestStart + bestLength).join(":")}`;
  return { compressed, expanded: groups.map((part) => part.padStart(4, "0")).join(":"), decimal: value.toString() };
}
export function numberToIpv6(input: string) {
  const text = input.trim();
  if (!/^\d{1,39}$/.test(text)) throw new Error("请输入有效的非负十进制整数（最多 39 位）");
  const value = BigInt(text);
  if (value > V6_MAX) throw new Error(`最大值为 ${V6_MAX}`);
  return ipv6Formats(value);
}
export function calculateIpv6(address: string, prefixText: string) {
  const value = parseIpv6(address);
  const prefix = parsePrefix(prefixText, 128);
  const total = 1n << BigInt(128 - prefix);
  const network = value & (V6_MAX ^ (total - 1n));
  return { ...ipv6Formats(value), prefix, network: ipv6Formats(network).compressed,
    first: ipv6Formats(network).compressed, last: ipv6Formats(network + total - 1n).compressed, total: total.toString() };
}
