import type { TerminalSettings } from "../settings/types";

export function quoteFontFamilyName(value: string) {
  return `"${value.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function terminalFontStack(settings: Pick<TerminalSettings, "fontFamilyLatin" | "fontFamilyCjk">) {
  return [
    quoteFontFamilyName(settings.fontFamilyLatin),
    quoteFontFamilyName(settings.fontFamilyCjk),
    "monospace",
  ].join(", ");
}
