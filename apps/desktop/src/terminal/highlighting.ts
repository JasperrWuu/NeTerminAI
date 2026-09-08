import type { TerminalHighlightRule } from "../settings/types";

interface CompiledHighlightRule {
  color: string;
  expression: RegExp;
}

export function terminalHighlightRanges(text: string, rules: ReturnType<typeof compileTerminalHighlightRules>) {
  const ranges: { start: number; end: number; color: string }[] = [];
  for (const rule of rules) {
    rule.expression.lastIndex = 0;
    for (const match of text.matchAll(rule.expression)) {
      const start = match.index;
      const end = start + match[0].length;
      if (end > start && !ranges.some((range) => start < range.end && end > range.start)) {
        ranges.push({ start, end, color: rule.color });
      }
    }
  }
  return ranges;
}

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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
