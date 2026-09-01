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
const MAX_TRACKED_LINE_LENGTH = 512;

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

/**
 * Terminal transports may echo interactive input one character at a time. Keeping a
 * short view of the current line lets a rule match across transport chunk boundaries.
 * When a match completes across chunks, the already-rendered characters are repainted
 * in place without delaying the user's input.
 */
export class TerminalHighlightStream {
  private currentLine = "";
  private rules: CompiledHighlightRule[];

  constructor(rules: TerminalHighlightRule[]) {
    this.rules = compileTerminalHighlightRules(rules);
  }

  setRules(rules: TerminalHighlightRule[]) {
    this.rules = compileTerminalHighlightRules(rules);
  }

  write(data: string) {
    const previousLine = this.currentLine;
    const simpleAppend = isSimpleLineAppend(data);
    const nextLine = updateCurrentLine(previousLine, data);
    const highlighted = applyTerminalHighlights(data, this.rules);

    this.currentLine = nextLine;
    if (!simpleAppend || previousLine.length === 0 || this.rules.length === 0) {
      return highlighted;
    }

    const boundary = Math.max(0, nextLine.length - data.length);
    const repaint = repaintCrossChunkMatches(nextLine, boundary, this.rules);
    return repaint ? `${highlighted}${repaint}` : highlighted;
  }
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

function repaintCrossChunkMatches(
  line: string,
  boundary: number,
  rules: CompiledHighlightRule[],
) {
  const repaints: string[] = [];
  let unclaimed = [{ start: 0, end: line.length }];

  for (const rule of rules) {
    rule.expression.lastIndex = 0;
    for (const match of line.matchAll(rule.expression)) {
      const start = match.index;
      const end = start + match[0].length;
      const rangeIndex = unclaimed.findIndex((range) => start >= range.start && end <= range.end);
      if (rangeIndex === -1) continue;

      const range = unclaimed[rangeIndex];
      unclaimed = [
        ...unclaimed.slice(0, rangeIndex),
        ...(range.start < start ? [{ start: range.start, end: start }] : []),
        ...(end < range.end ? [{ start: end, end: range.end }] : []),
        ...unclaimed.slice(rangeIndex + 1),
      ];

      if (start >= boundary || end <= boundary || !isAscii(match[0])) continue;
      const distanceFromEnd = line.length - start;
      const suffixLength = line.length - end;
      const [red, green, blue] = hexToRgb(rule.color);
      repaints.push(
        `\x1b[${distanceFromEnd}D`,
        `\x1b[38;2;${red};${green};${blue}m${match[0]}\x1b[39m`,
        suffixLength > 0 ? `\x1b[${suffixLength}C` : "",
      );
    }
  }

  return repaints.join("");
}

function updateCurrentLine(previousLine: string, data: string) {
  const withoutAnsi = data.replace(ANSI_SEQUENCE, "");
  let line = previousLine;

  for (const character of withoutAnsi) {
    if (character === "\r" || character === "\n") {
      line = "";
    } else if (character === "\b" || character === "\x7f") {
      line = line.slice(0, -1);
    } else if (character === "\t") {
      line += " ";
    } else if (character >= " ") {
      line += character;
    }
  }

  return line.slice(-MAX_TRACKED_LINE_LENGTH);
}

function isSimpleLineAppend(data: string) {
  return data.length > 0 && !/[\x00-\x1f\x7f]/.test(data);
}

function isAscii(value: string) {
  return /^[\x20-\x7e]+$/.test(value);
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
