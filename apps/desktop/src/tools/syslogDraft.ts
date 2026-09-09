const KEY = "neterminai.syslog.v1";
export interface SyslogDraft { adapter: string; port: string; protocol: "udp" }
export function normalizeSyslogDraft(value: unknown): SyslogDraft {
  const saved = value && typeof value === "object" ? value : {};
  return { adapter: "adapter" in saved && typeof saved.adapter === "string" ? saved.adapter : "",
    port: "port" in saved && typeof saved.port === "string" ? saved.port : "514", protocol: "udp" };
}
export function readSyslogDraft(): SyslogDraft {
  try { return normalizeSyslogDraft(JSON.parse(localStorage.getItem(KEY) ?? "null")); }
  catch { return normalizeSyslogDraft(null); }
}
export function persistSyslogDraft(draft: SyslogDraft) {
  localStorage.setItem(KEY, JSON.stringify(normalizeSyslogDraft(draft)));
}
export function syslogPort(value: string): number | null {
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? Number(value) : null;
}
