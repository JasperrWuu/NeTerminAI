import { listen } from "@tauri-apps/api/event";
import { normalizeIpcError } from "./errors";
import type {
  TerminalConnectionError,
  TerminalConnectionState,
  TerminalConnectionStateEvent,
  TerminalDisconnectReason,
} from "./types";

const STATE_EVENT = "connection:state";
type Unlisten = () => void;

export const connectionStateApi = {
  subscribe(onEvent: (event: TerminalConnectionStateEvent) => void): Promise<Unlisten> {
    return listen<unknown>(STATE_EVENT, ({ payload }) => {
      const event = decodeStateEvent(payload);
      if (event) onEvent(event);
    }).catch((error: unknown) => {
      throw normalizeIpcError(error);
    });
  },
};

function decodeStateEvent(value: unknown): TerminalConnectionStateEvent | null {
  if (!isRecord(value)
    || typeof value.sessionId !== "string"
    || !isConnectionState(value.state)) {
    return null;
  }
  return {
    sessionId: value.sessionId,
    state: value.state,
    reason: isDisconnectReason(value.reason) ? value.reason : undefined,
    error: isConnectionError(value.error) ? value.error : undefined,
    message: typeof value.message === "string" ? value.message : undefined,
  };
}

function isConnectionState(value: unknown): value is TerminalConnectionState {
  return value === "connecting"
    || value === "connected"
    || value === "closing"
    || value === "disconnected"
    || value === "failed";
}

function isDisconnectReason(value: unknown): value is TerminalDisconnectReason {
  return value === "userRequested"
    || value === "remoteClosed"
    || value === "processExited"
    || value === "connectionFailed"
    || value === "readFailed"
    || value === "writeFailed"
    || value === "timeout"
    || value === "protocolError"
    || value === "deviceDisconnected"
    || value === "applicationShutdown"
    || value === "unknown";
}

function isConnectionError(value: unknown): value is TerminalConnectionError {
  return value === "connection"
    || value === "transport"
    || value === "protocol"
    || value === "configuration";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
