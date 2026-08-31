import type { TerminalHighlightRule } from "../settings/types";

interface CompiledHighlightRule {
  color: string;
  expression: RegExp;
}

interface HighlightSegment {
  color?: string;
  text: string;
}

const ANSI_SEQUENCE = /(\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)))/g;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function compileTerminalHighlightRules(
  rules: TerminalHighlightRule[],
): CompiledHighlightRule[] {
  return rules.flatMap((rule) => {
    if (!rule.enabled || !rule.pattern || !HEX_COLOR.test(rule.color)) return [];
    try {
      const source = rule.matchMode === "text" ? escapeRegExp(rule.pattern) : rule.pattern;
      const expression = new RegExp(source, rule.caseSensitive ? "g" : "gi");
      if (expression.test("")) return [];
      expression.lastIndex = 0;
      return [{ color: rule.color.toUpperCase(), expression }];
    } catch {
      return [];
    }
  });
}

export function applyTerminalHighlights(data: string, rules: CompiledHighlightRule[]) {
  if (rules.length === 0 || !data) return data;
  return data
    .split(ANSI_SEQUENCE)
    .map((part) => part.startsWith("\x1b") ? part : highlightPlainText(part, rules))
    .join("");
}

function highlightPlainText(text: string, rules: CompiledHighlightRule[]) {
  let segments: HighlightSegment[] = [{ text }];
  for (const rule of rules) {
    segments = segments.flatMap((segment) => (
      segment.color ? [segment] : splitSegment(segment.text, rule)
    ));
  }
  return segments.map((segment) => {
    if (!segment.color) return segment.text;
    const [red, green, blue] = hexToRgb(segment.color);
    return `\x1b[38;2;${red};${green};${blue}m${segment.text}\x1b[39m`;
  }).join("");
}

function splitSegment(text: string, rule: CompiledHighlightRule): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  rule.expression.lastIndex = 0;
  for (const match of text.matchAll(rule.expression)) {
    const index = match.index;
    if (index > cursor) segments.push({ text: text.slice(cursor, index) });
    segments.push({ color: rule.color, text: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments.length > 0 ? segments : [{ text }];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hexToRgb(color: string): [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}
