import type { RadiusCodeKind } from "../ipc/radius";
export interface RadiusDraft { ip: string; port: string; codeKind: RadiusCodeKind; codeLength: string }
export const radiusCodeOptions: { value: RadiusCodeKind; label: string }[] = [
  { value: "letters", label: "纯字母 · Aa" }, { value: "digits", label: "纯数字 · 0–9" },
  { value: "uppercase", label: "大写字母 · A–Z" }, { value: "lowercase", label: "小写字母 · a–z" },
  { value: "mixed", label: "全组合 · 大小写字母 + 数字" },
];
export function normalizeRadiusDraft(value: unknown): RadiusDraft {
  const data = value && typeof value === "object" ? value as Partial<RadiusDraft> : {};
  return { ip: typeof data.ip === "string" ? data.ip : "0.0.0.0", port: typeof data.port === "string" ? data.port : "1812",
    codeKind: radiusCodeOptions.some((o) => o.value === data.codeKind) ? data.codeKind! : "mixed",
    codeLength: typeof data.codeLength === "string" ? data.codeLength : "6" };
}
const key = "neterminai.radius.v1";
export function readRadiusDraft(): RadiusDraft {
  try { return normalizeRadiusDraft(JSON.parse(localStorage.getItem(key) ?? "null")); } catch { return normalizeRadiusDraft(null); }
}
export function persistRadiusDraft(value: RadiusDraft) { localStorage.setItem(key, JSON.stringify(normalizeRadiusDraft(value))); }
export function radiusInteger(value: string, maximum: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
}
