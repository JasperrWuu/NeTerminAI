import type {
  TerminalConnectionError,
  TerminalConnectionState,
  TerminalConnectionType,
  TerminalDisconnectReason,
} from "../../ipc/types";
import type { TerminalSnapshot } from "../../terminal/TerminalSnapshot";

export interface TerminalContextTarget {
  tabId: string;
  sessionId: string;
}

export type TerminalConnectionMetadata =
  | { kind: "local"; shell: string }
  | { kind: "telnet"; host: string; port: number }
  | { kind: "ssh"; host: string; port: number }
  | { kind: "serial"; portName: string; baudRate: number };

/**
 * A bounded, on-demand context object for future AI consumers. It contains
 * runtime identity and safe connection metadata, never credentials or input.
 */
export interface TerminalContextSnapshot {
  version: 1;
  capturedAt: number;
  tabId: string;
  paneId?: string;
  sessionId: string;
  title: string;
  connectionKind: TerminalConnectionType;
  connectionState: TerminalConnectionState;
  disconnectReason?: TerminalDisconnectReason;
  error?: TerminalConnectionError;
  message?: string;
  target: TerminalContextTarget;
  connection: TerminalConnectionMetadata;
  terminal: TerminalSnapshot;
}
