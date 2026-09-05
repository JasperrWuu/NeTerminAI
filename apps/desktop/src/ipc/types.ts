import type { SerialConnection, TelnetConnection } from "../connections/types";
import type { LocalTerminalProfileId } from "../terminal/profiles";

export type TerminalConnectionType = "local" | "telnet" | "serial";

export type TerminalConnectionState =
  | "connecting"
  | "connected"
  | "closing"
  | "disconnected"
  | "failed";

export type TerminalDisconnectReason =
  | "userRequested"
  | "remoteClosed"
  | "processExited"
  | "connectionFailed"
  | "readFailed"
  | "writeFailed"
  | "timeout"
  | "protocolError"
  | "deviceDisconnected"
  | "applicationShutdown"
  | "unknown";

export type TerminalConnectionError = "connection" | "transport" | "protocol" | "configuration";

export interface TerminalConnectionStateEvent {
  sessionId: string;
  state: TerminalConnectionState;
  reason?: TerminalDisconnectReason;
  error?: TerminalConnectionError;
  message?: string;
}

export interface TerminalOutputEvent {
  sessionId: string;
  data: string;
}

export interface TerminalSize {
  columns: number;
  rows: number;
}

export type TerminalCreateRequest =
  | ({ kind: "local"; profile: LocalTerminalProfileId } & SessionSize)
  | ({ kind: "telnet" } & Omit<TelnetConnection, "name"> & SessionSize)
  | ({ kind: "serial" } & Omit<SerialConnection, "name"> & SessionIdentity);

export type TerminalWriteRequest = {
  kind: TerminalConnectionType;
  sessionId: string;
  data: string;
};

export type TerminalResizeRequest = {
  kind: TerminalConnectionType;
  sessionId: string;
  size: TerminalSize;
};

export type TerminalCloseRequest = {
  kind: TerminalConnectionType;
  sessionId: string;
};

interface SessionIdentity {
  sessionId: string;
}

interface SessionSize extends SessionIdentity, TerminalSize {}
