import type { TerminalSettings } from "../settings/types";

export function quoteFontFamilyName(value: string) {
  return `"${value.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function terminalFontStack(settings: Pick<TerminalSettings, "fontFamilyLatin" | "fontFamilyCjk">) {
  return [
    quoteFontFamilyName(settings.fontFamilyLatin),
    // Keep ASCII monospaced when the requested font is absent. A CJK font
    // such as YaHei also covers Latin glyphs and must not win that fallback.
    '"Consolas"',
    '"Courier New"',
    quoteFontFamilyName(settings.fontFamilyCjk),
    "monospace",
  ].join(", ");
}
