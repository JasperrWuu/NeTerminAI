export interface IpCalculatorDraft {
  version: 1;
  tab: "ipv4" | "ipv6";
  address4: string;
  mask: string;
  address6: string;
  prefix6: string;
  number: string;
}
export const IP_DRAFT_KEY = "neterminai.ip-calculator.v1";
export function normalizeIpDraft(value: unknown): IpCalculatorDraft {
  const saved = typeof value === "object" && value !== null ? value : {};
  const field = (key: string, fallback: string) => key in saved && typeof Reflect.get(saved, key) === "string"
    ? String(Reflect.get(saved, key)).slice(0, 128) : fallback;
  return { version: 1, tab: "tab" in saved && saved.tab === "ipv6" ? "ipv6" : "ipv4",
    address4: field("address4", "192.168.1.10"), mask: field("mask", "24"),
    address6: field("address6", "2001:db8::1"), prefix6: field("prefix6", "64"), number: field("number", "") };
}
export function readIpDraft(): IpCalculatorDraft {
  try { return normalizeIpDraft(JSON.parse(localStorage.getItem(IP_DRAFT_KEY) ?? "null")); }
  catch { return normalizeIpDraft(null); }
}
export function persistIpDraft(draft: IpCalculatorDraft): boolean {
  try { localStorage.setItem(IP_DRAFT_KEY, JSON.stringify(normalizeIpDraft(draft))); return true; }
  catch { return false; }
}
