export interface FtpDraft { adapter: string; ip: string; port: string; root: string; username: string; password: string; autoStart: boolean }
const KEY = "neterminai.ftp.v1";
export function normalizeFtpDraft(value: unknown): FtpDraft {
  const saved = value && typeof value === "object" ? value : {};
  const text = (key: string, fallback: string) => key in saved && typeof Reflect.get(saved, key) === "string" ? String(Reflect.get(saved, key)) : fallback;
  return { adapter: text("adapter", ""), ip: text("ip", ""), port: text("port", "21"), root: text("root", ""), username: text("username", "admin"), password: text("password", ""), autoStart: "autoStart" in saved && saved.autoStart === true };
}
export function readFtpDraft(): FtpDraft {
  try { return normalizeFtpDraft(JSON.parse(localStorage.getItem(KEY) ?? "null")); } catch { return normalizeFtpDraft(null); }
}
export function persistFtpDraft(draft: FtpDraft) { localStorage.setItem(KEY, JSON.stringify(normalizeFtpDraft(draft))); }
export function ftpPort(value: string) { return /^\d+$/.test(value) && +value >= 1 && +value <= 65535 ? +value : null; }
