import type {
  TerminalConnectionError,
  TerminalConnectionState,
  TerminalConnectionStateEvent,
  TerminalConnectionType,
  TerminalDisconnectReason,
} from "../ipc/types";

/**
 * The renderer-neutral terminal data contract shared by Core and AI.
 * Implementations may use xterm, PTY, sockets or serial ports internally;
 * none of those details cross this boundary.
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

export interface TerminalTarget {
  tabId: string;
  sessionId: string;
}

/** Text-terminal kinds only; native views such as RDP never cross this boundary. */
export type TerminalConnectionKind = Exclude<TerminalConnectionType, "rdp">;

export type TerminalConnectionMetadata =
  | { kind: "local"; shell: string }
  | { kind: "telnet"; host: string; port: number }
  | { kind: "ssh"; host: string; port: number }
  | { kind: "serial"; portName: string; baudRate: number };

export interface TerminalContextSnapshot {
  version: 1;
  capturedAt: number;
  tabId: string;
  paneId?: string;
  sessionId: string;
  title: string;
  connectionKind: TerminalConnectionKind;
  connectionState: TerminalConnectionState;
  disconnectReason?: TerminalDisconnectReason;
  error?: TerminalConnectionError;
  message?: string;
  target: TerminalTarget;
  connection: TerminalConnectionMetadata;
  terminal: TerminalSnapshot;
}

export interface TerminalSessionDescriptor {
  tabId: string;
  title: string;
  connectionKind: TerminalConnectionKind;
  connection: TerminalConnectionMetadata;
  sessionId?: string;
  connectionState: TerminalConnectionState;
  disconnectReason?: TerminalDisconnectReason;
}

export type TerminalContextScope = "active" | "visible" | "selected";

/** Selection uses logical tab identity; snapshots resolve it to a real sessionId. */
export interface ContextSelection {
  scope: TerminalContextScope;
  selectedTabIds: string[];
}

export const DEFAULT_CONTEXT_SELECTION: Readonly<ContextSelection> = {
  scope: "active",
  selectedTabIds: [],
};

export function resolveContextSelection(
  selection: ContextSelection,
  availableTabIds: readonly string[],
  visibleTabIds: readonly string[],
  activeTabId: string | null,
): string[] {
  const available = new Set(availableTabIds);
  if (selection.scope === "selected") {
    return unique(selection.selectedTabIds.filter((tabId) => available.has(tabId)));
  }
  if (selection.scope === "visible") {
    return unique(visibleTabIds.filter((tabId) => available.has(tabId)));
  }
  return activeTabId && available.has(activeTabId) ? [activeTabId] : [];
}

export function reconcileContextSelection(
  selection: ContextSelection,
  availableTabIds: readonly string[],
): ContextSelection {
  const available = new Set(availableTabIds);
  const selectedTabIds = selection.selectedTabIds.filter((tabId) => available.has(tabId));
  return selectedTabIds.length === selection.selectedTabIds.length
    ? selection
    : { ...selection, selectedTabIds };
}

export interface TerminalQueryCapability {
  getActiveContext(): TerminalContextSnapshot | undefined;
  getContextForTab(tabId: string, limits?: TerminalSnapshotLimits): TerminalContextSnapshot | undefined;
  getContexts(selection: ContextSelection): TerminalContextSnapshot[];
  getVisibleContexts(): TerminalContextSnapshot[];
  listSessions(): TerminalSessionDescriptor[];
  /** Logical identities still owned by the Core, including sessions not visible in the current pane. */
  listOwnedTerminalIds?(): string[];
  subscribe(listener: () => void): () => void;
  getRevision(): number;
}

export interface TerminalContextCapability extends TerminalQueryCapability {}

export type TerminalInputDispatchResult =
  | { ok: true }
  | { ok: false; code: "stale_session" | "unavailable" };

export interface TerminalInputCapability {
  dispatchInput(target: TerminalTarget, data: string): TerminalInputDispatchResult;
}

export type TerminalCapability = TerminalContextCapability & TerminalInputCapability;

export type {
  TerminalConnectionError,
  TerminalConnectionState,
  TerminalConnectionStateEvent,
  TerminalConnectionType,
  TerminalDisconnectReason,
};

function unique(values: readonly string[]) {
  return [...new Set(values)];
}
