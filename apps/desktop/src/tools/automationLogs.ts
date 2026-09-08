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
}
export const createRunLogs = (): RunLogs => ({ entries: [], nextId: 1, truncated: false });
const MAX_CHARS = 200_000;
const MAX_ENTRIES = 2_000;

export function appendRunLog(logs: RunLogs, level: AutomationLogEntry["level"], message: string, timestamp = Date.now(), coalesceError = false): RunLogs {
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
