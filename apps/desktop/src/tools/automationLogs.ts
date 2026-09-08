export interface AutomationLogEntry {
  id: number;
  timestamp: number;
  level: "system" | "info" | "send" | "error";
  message: string;
}
export interface RunLogs {
  entries: AutomationLogEntry[];
  nextId: number;
  truncated: boolean;
  startedAt?: number;
  finished?: string;
  stdout?: { message: string; timestamp: number };
}
export const createRunLogs = (): RunLogs => ({ entries: [], nextId: 1, truncated: false });
const MAX_CHARS = 200_000;
const MAX_ENTRIES = 2_000;
export const STDOUT_IDLE_MS = 75;

export function bufferStdout(logs: RunLogs, message: string, timestamp = Date.now()): RunLogs {
  if (!message) return logs;
  const text = (logs.stdout?.message ?? "") + message;
  return { ...logs, stdout: { message: text.slice(-MAX_CHARS), timestamp: logs.stdout?.timestamp ?? timestamp }, truncated: logs.truncated || text.length > MAX_CHARS };
}
export function flushStdout(logs: RunLogs): RunLogs {
  if (!logs.stdout) return logs;
  const { stdout, ...rest } = logs;
  return appendRunLog(rest, "info", stdout.message, stdout.timestamp);
}

export function appendRunLog(logs: RunLogs, level: AutomationLogEntry["level"], message: string, timestamp = Date.now(), coalesceError = false): RunLogs {
  if (logs.stdout) logs = flushStdout(logs);
  if (!message) return logs;
  let entries = [...logs.entries];
  let nextId = logs.nextId;
  const last = entries.at(-1);
  if (coalesceError && last?.level === "error") {
    entries[entries.length - 1] = { ...last, message: last.message + message };
  } else entries.push({ id: nextId++, timestamp, level, message });
  let truncated = logs.truncated;
  if (entries.length > MAX_ENTRIES) { entries = entries.slice(-MAX_ENTRIES); truncated = true; }
  let length = entries.reduce((sum, entry) => sum + entry.message.length, 0);
  while (entries.length > 1 && length > MAX_CHARS) { length -= entries.shift()!.message.length; truncated = true; }
  if (entries[0]?.message.length > MAX_CHARS) {
    entries[0] = { ...entries[0], message: entries[0].message.slice(-MAX_CHARS) }; truncated = true;
  }
  return { ...logs, entries, nextId, truncated };
}
export function logRunStatus(logs: RunLogs, status: string, message?: string, timestamp = Date.now()): RunLogs {
  logs = flushStdout(logs);
  if (status === "running") {
    if (logs.startedAt !== undefined || logs.finished) return logs;
    return { ...appendRunLog(logs, "system", "开始执行", timestamp), startedAt: timestamp };
  }
  if (!["success", "error", "cancelled"].includes(status) || logs.finished) return logs;
  const duration = logs.startedAt === undefined ? "" : ` · ${(Math.max(0, timestamp - logs.startedAt) / 1000).toFixed(2)}s`;
  const text = status === "success" ? `执行完成${duration}` : status === "cancelled" ? `用户停止${duration}` : message ?? "Runner 异常";
  return { ...appendRunLog(logs, status === "error" ? "error" : "system", text, timestamp), finished: status };
}
export function logSummary(entry: AutomationLogEntry): string {
  return entry.message.trimEnd().split(/\r?\n/).at(-1) || entry.message;
}

function localTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}
export function formatRunLog(logs: RunLogs): string {
  const ready = flushStdout(logs);
  return (ready.truncated ? "[注意：日志已达显示上限，仅导出当前保留的内容。]\n" : "") + ready.entries.map((entry) => {
    const prefix = `${localTimestamp(entry.timestamp)}  ${entry.level.toUpperCase().padEnd(6)}  `;
    // Preserve message content, including blank lines and indentation, without repeating metadata.
    const body = entry.message.replace(/\n(?=.)/g, `\n${" ".repeat(prefix.length)}`);
    return prefix + body + (body.endsWith("\n") ? "" : "\n");
  }).join("");
}
export function runLogFilename(scriptName: string, sessionName: string, timestamp = Date.now()): string {
  const clean = (text: string) => text.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 60) || "run";
  return `${clean(scriptName)}-${clean(sessionName)}-${localTimestamp(timestamp).replace(/[: ]/g, "-")}.log`;
}
