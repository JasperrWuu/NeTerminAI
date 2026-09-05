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

  // A wrapped logical line can occupy several physical rows. Read a bounded
  // tail with a little reconstruction headroom instead of scanning the whole
  // scrollback on every context request.
  const physicalTail = Math.min(buffer.length, Math.max(1, maxLines * 8 + 1));
  const start = buffer.length - physicalTail;
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
  return {
    sessionId,
    cols: terminal.cols,
    rows: terminal.rows,
    recentText: captureTerminalText(terminal.buffer.active, limits),
    ...(selection ? { selection } : {}),
  };
}

function normalizeLimit(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/** Truncate by Unicode code points so a surrogate pair is never split. */
function truncateUnicode(value: string, maxChars: number) {
  const codePoints = Array.from(value);
  if (codePoints.length <= maxChars) return value;
  if (maxChars === 1) return "…";
  return `…${codePoints.slice(-(maxChars - 1)).join("")}`;
}
