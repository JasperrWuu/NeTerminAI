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
  return [
    { id: "builtin-dark", name: "夜色 · 暗色", enabled: true, colors: ["#E68A8A", "#D9B77A", "#88C5A5", "#91B9E8", "#B7A4D9", "#D9B77A"] },
    { id: "builtin-light", name: "日光 · 亮色", enabled: false, colors: ["#A83F46", "#805A13", "#276B48", "#285F9B", "#705295", "#805A13"] },
  ].map(({ colors, ...set }) => ({
    ...set,
    rules: patterns.map(([id, pattern], index) => ({
      id: `${set.id}-${id}`, pattern, color: colors[index],
      matchMode: "regex", enabled: true, caseSensitive: false,
    })),
  }));
}
