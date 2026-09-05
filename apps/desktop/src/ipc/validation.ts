import type {
  TerminalConnectionStateEvent,
  TerminalCreateRequest,
  TerminalOutputEvent,
} from "./types";

export function createCommandArguments(request: TerminalCreateRequest): Record<string, unknown> {
  if (request.kind === "local") {
    return {
      sessionId: request.sessionId,
      profile: request.profile,
      columns: request.columns,
      rows: request.rows,
    };
  }
  if (request.kind === "telnet") {
    return {
      sessionId: request.sessionId,
      host: request.host,
      port: request.port,
      username: request.username,
      password: request.password,
      columns: request.columns,
      rows: request.rows,
    };
  }
  return {
    sessionId: request.sessionId,
    portName: request.portName,
    baudRate: request.baudRate,
    dataBits: request.dataBits,
    stopBits: request.stopBits,
    parity: request.parity,
    flowControl: request.flowControl,
  };
}

export function decodeOutputEvent(value: unknown): TerminalOutputEvent | null {
  if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.data !== "string") {
    return null;
  }
  return { sessionId: value.sessionId, data: value.data };
}

export function decodeConnectionStateEvent(value: unknown): TerminalConnectionStateEvent | null {
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    return null;
  }
  const state = toConnectionState(value.state);
  if (!state) return null;
  const reason = toDisconnectReason(value.reason);
  const error = toConnectionError(value.error);
  return {
    sessionId: value.sessionId,
    state,
    reason: reason ?? undefined,
    error: error ?? undefined,
    message: typeof value.message === "string" ? value.message : undefined,
  };
}

export function isCurrentSessionEvent(
  event: Pick<TerminalOutputEvent, "sessionId">,
  sessionId: string,
) {
  return event.sessionId === sessionId;
}

function toConnectionState(value: unknown): TerminalConnectionStateEvent["state"] | null {
  if (value === "connecting"
    || value === "connected"
    || value === "closing"
    || value === "disconnected"
    || value === "failed") return value;
  return null;
}

function toDisconnectReason(value: unknown): NonNullable<TerminalConnectionStateEvent["reason"]> | null {
  if (value === "userRequested"
    || value === "remoteClosed"
    || value === "processExited"
    || value === "connectionFailed"
    || value === "readFailed"
    || value === "writeFailed"
    || value === "timeout"
    || value === "protocolError"
    || value === "deviceDisconnected"
    || value === "applicationShutdown"
    || value === "unknown") return value;
  return null;
}

function toConnectionError(value: unknown): NonNullable<TerminalConnectionStateEvent["error"]> | null {
  if (value === "connection"
    || value === "transport"
    || value === "protocol"
    || value === "configuration") return value;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
