/**
 * The small, renderer-neutral view of a terminal that an AI consumer may
 * inspect. It intentionally contains no xterm or DOM types.
 */
export interface TerminalSnapshotLimits {
  maxLines: number;
  maxChars: number;
}

export const DEFAULT_TERMINAL_SNAPSHOT_LIMITS: Readonly<TerminalSnapshotLimits> = {
  maxLines: 300,
  maxChars: 32 * 1024,
};

export interface TerminalSnapshot {
  sessionId: string;
  cols: number;
  rows: number;
  recentText: string;
  selection?: string;
}

/** The public line surface used by xterm.js buffer lines. */
export interface TerminalBufferLineLike {
  isWrapped?: boolean;
  translateToString(trimRight?: boolean): string;
}

/** The public active-buffer surface used by xterm.js. */
export interface TerminalBufferLike {
  length: number;
  getLine(index: number): TerminalBufferLineLike | undefined;
}

export interface TerminalLike {
  cols: number;
  rows: number;
  buffer: { active: TerminalBufferLike };
  getSelection?: () => string;
}

/**
 * Reads the newest logical lines from a terminal buffer. Wrapped physical
 * rows are joined without inserting a newline, while blank logical lines are
 * retained. Only xterm's public buffer API is used.
 */
export function captureTerminalText(
  buffer: TerminalBufferLike,
  limits: TerminalSnapshotLimits = DEFAULT_TERMINAL_SNAPSHOT_LIMITS,
): string {
  const maxLines = normalizeLimit(limits.maxLines);
  const maxChars = normalizeLimit(limits.maxChars);
  if (maxLines === 0 || maxChars === 0 || buffer.length === 0) return "";

  // Walk backwards to the beginning of the newest logical lines. This avoids
  // cutting off a very long wrapped line merely because it spans more rows
  // than a fixed physical-tail heuristic would allow.
  const start = findLogicalTailStart(buffer, maxLines);
  const logicalLines: string[] = [];
  let current = "";
  let hasCurrent = false;

  for (let index = start; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && hasCurrent) {
      current += text;
      continue;
    }
    if (hasCurrent) logicalLines.push(current);
    current = text;
    hasCurrent = true;
  }
  if (hasCurrent) logicalLines.push(current);

  const recentLines = logicalLines.slice(-maxLines);
  return truncateUnicode(recentLines.join("\n"), maxChars);
}

export function captureTerminalSnapshot(
  terminal: TerminalLike,
  sessionId: string,
  limits: TerminalSnapshotLimits = DEFAULT_TERMINAL_SNAPSHOT_LIMITS,
): TerminalSnapshot {
  const selection = terminal.getSelection?.() ?? "";
  const selectionLimit = Math.min(normalizeLimit(limits.maxChars), 8 * 1024);
  return {
    sessionId,
    cols: terminal.cols,
    rows: terminal.rows,
    recentText: captureTerminalText(terminal.buffer.active, limits),
    ...(selection && selectionLimit > 0
      ? { selection: truncateUnicode(selection, selectionLimit) }
      : {}),
  };
}

function normalizeLimit(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function findLogicalTailStart(buffer: TerminalBufferLike, maxLines: number) {
  let logicalLines = 0;
  let index = buffer.length - 1;
  while (index >= 0 && logicalLines < maxLines) {
    const line = buffer.getLine(index);
    if (line && !line.isWrapped) logicalLines += 1;
    index -= 1;
  }
  return Math.max(0, index + 1);
}

/** Truncate by Unicode code points so a surrogate pair is never split. */
function truncateUnicode(value: string, maxChars: number) {
  const codePoints = Array.from(value);
  if (codePoints.length <= maxChars) return value;
  if (maxChars === 1) return "…";
  return `…${codePoints.slice(-(maxChars - 1)).join("")}`;
}
