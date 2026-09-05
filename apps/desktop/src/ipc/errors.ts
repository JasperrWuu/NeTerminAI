export type IpcErrorCode =
  | "session_not_found"
  | "invalid_state"
  | "backpressure"
  | "connection_failed"
  | "timeout"
  | "invalid_argument"
  | "io_error"
  | "invalid_response"
  | "ai_cancelled"
  | "ai_timeout"
  | "ai_process"
  | "ai_provider"
  | "ai_not_found"
  | "internal";

export class IpcError extends Error {
  readonly code: IpcErrorCode;
  readonly cause: unknown;

  constructor(code: IpcErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "IpcError";
    this.code = code;
    this.cause = cause;
  }
}

export function normalizeIpcError(error: unknown): IpcError {
  if (error instanceof IpcError) return error;
  if (typeof error === "string") return new IpcError(classifyMessage(error), error, error);
  if (isRecord(error)) {
    const message = typeof error.message === "string" ? error.message : "IPC 请求失败";
    const code = isIpcErrorCode(error.code) ? error.code : classifyMessage(message);
    return new IpcError(code, message, error);
  }
  return new IpcError("internal", "IPC 请求失败", error);
}

export function invalidResponse(message: string) {
  return new IpcError("invalid_response", message);
}

function classifyMessage(message: string): IpcErrorCode {
  if (/队列繁忙|backpressure/i.test(message)) return "backpressure";
  if (/ai_cancelled|AI 请求已停止|已取消/i.test(message)) return "ai_cancelled";
  if (/ai_timeout|AI 请求超时/i.test(message)) return "ai_timeout";
  if (/ai_not_found|AI 请求不存在/i.test(message)) return "ai_not_found";
  if (/ai_process|AI 进程/i.test(message)) return "ai_process";
  if (/超时|timeout/i.test(message)) return "timeout";
  if (/不存在|session not found|unknown session|session/i.test(message)) return "session_not_found";
  if (/已关闭|仍在连接|正在连接|closing|closed/i.test(message)) return "invalid_state";
  if (/参数|地址无效|端口无效|invalid|无效/i.test(message)) return "invalid_argument";
  if (/连接|connect|Telnet|串口|终端/i.test(message)) return "connection_failed";
  if (/写入|读取|IO|I\/O|通道/i.test(message)) return "io_error";
  return "internal";
}

function isIpcErrorCode(value: unknown): value is IpcErrorCode {
  return typeof value === "string" && [
    "session_not_found",
    "invalid_state",
    "backpressure",
    "connection_failed",
    "timeout",
    "invalid_argument",
    "io_error",
    "invalid_response",
    "ai_cancelled",
    "ai_timeout",
    "ai_process",
    "ai_provider",
    "ai_not_found",
    "internal",
  ].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
