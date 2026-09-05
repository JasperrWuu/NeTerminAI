import type { TerminalConnectionType } from "../../ipc/types";
import {
  DEFAULT_TERMINAL_SNAPSHOT_LIMITS,
  type TerminalSnapshot,
  type TerminalSnapshotLimits,
} from "../../terminal/TerminalSnapshot.ts";
import type { TerminalSessionRuntimeSnapshot } from "../../terminal/TerminalSessionRuntime";
import { collectVisibleTabIds, findPaneContainingTab } from "../../workspace/layout.ts";
import type { WorkspaceLayoutNode, WorkspaceTab } from "../../workspace/types";
import type { TerminalContextSnapshot, TerminalConnectionMetadata } from "./types";

export interface TerminalContextWorkspace {
  tabs: readonly WorkspaceTab[];
  layout: WorkspaceLayoutNode;
  activePaneId: string;
  activeTabId: string | null;
}

interface RuntimeContextSource {
  get(tabId: string): RuntimeContextReader | undefined;
}

interface RuntimeContextReader {
  readonly connectionType: TerminalConnectionType;
  getSnapshot(): TerminalSessionRuntimeSnapshot;
  getTerminalSnapshot(limits?: TerminalSnapshotLimits): TerminalSnapshot;
}

const MAX_VISIBLE_CONTEXTS = 8;
const MAX_VISIBLE_CHARS = 64 * 1024;
const VISIBLE_CONTEXT_LIMITS: Readonly<TerminalSnapshotLimits> = {
  maxLines: 80,
  maxChars: 8 * 1024,
};

/**
 * Resolves active or visible workspace context without touching DOM focus,
 * React component state, or xterm internals. The workspace getter keeps the
 * provider independent from React render lifetimes and always reads current
 * tab/pane identity at capture time.
 */
export class TerminalContextProvider {
  private readonly registry: RuntimeContextSource;
  private readonly getWorkspace: () => TerminalContextWorkspace;

  constructor(
    registry: RuntimeContextSource,
    getWorkspace: () => TerminalContextWorkspace,
  ) {
    this.registry = registry;
    this.getWorkspace = getWorkspace;
  }

  getActiveContext(): TerminalContextSnapshot | undefined {
    const workspace = this.getWorkspace();
    if (!workspace.activeTabId) return undefined;
    return this.getContextForTab(workspace.activeTabId);
  }

  getContextForTab(
    tabId: string,
    limits: TerminalSnapshotLimits = DEFAULT_TERMINAL_SNAPSHOT_LIMITS,
  ): TerminalContextSnapshot | undefined {
    const workspace = this.getWorkspace();
    const tab = workspace.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return undefined;

    const runtime = this.registry.get(tabId);
    if (!runtime || runtime.connectionType !== connectionKindForTab(tab)) return undefined;
    const runtimeSnapshot = runtime.getSnapshot();
    const terminal = runtime.getTerminalSnapshot(limits);
    const pane = findPaneContainingTab(workspace.layout, tabId);
    return {
      version: 1,
      capturedAt: Date.now(),
      tabId,
      ...(pane ? { paneId: pane.id } : {}),
      sessionId: runtimeSnapshot.sessionId,
      title: tab.title,
      connectionKind: runtime.connectionType,
      connectionState: runtimeSnapshot.state,
      ...(runtimeSnapshot.reason ? { disconnectReason: runtimeSnapshot.reason } : {}),
      ...(runtimeSnapshot.error ? { error: runtimeSnapshot.error } : {}),
      ...(runtimeSnapshot.message ? { message: runtimeSnapshot.message } : {}),
      target: { tabId, sessionId: runtimeSnapshot.sessionId },
      connection: connectionMetadataForTab(tab),
      terminal,
    };
  }

  /**
   * Captures currently visible active tabs with a shared character budget.
   * The active tab receives the larger snapshot; metadata for other visible
   * panes remains available until the bounded budget is exhausted.
   */
  getVisibleContexts(): TerminalContextSnapshot[] {
    const workspace = this.getWorkspace();
    const visibleIds = unique(collectVisibleTabIds(workspace.layout));
    const orderedIds = workspace.activeTabId && visibleIds.includes(workspace.activeTabId)
      ? [workspace.activeTabId, ...visibleIds.filter((id) => id !== workspace.activeTabId)]
      : visibleIds;
    const contexts: TerminalContextSnapshot[] = [];
    let remainingChars = MAX_VISIBLE_CHARS;

    for (const tabId of orderedIds.slice(0, MAX_VISIBLE_CONTEXTS)) {
      if (remainingChars <= 0) break;
      const active = tabId === workspace.activeTabId;
      const requested = active ? DEFAULT_TERMINAL_SNAPSHOT_LIMITS : VISIBLE_CONTEXT_LIMITS;
      const limits: TerminalSnapshotLimits = {
        maxLines: requested.maxLines,
        maxChars: Math.min(requested.maxChars, remainingChars),
      };
      const context = this.getContextForTab(tabId, limits);
      if (!context) continue;
      contexts.push(context);
      remainingChars -= context.terminal.recentText.length
        + (context.terminal.selection?.length ?? 0);
    }
    return contexts;
  }
}

function connectionKindForTab(tab: WorkspaceTab): TerminalConnectionType {
  if (tab.kind === "localTerminal") return "local";
  return tab.kind;
}

function connectionMetadataForTab(tab: WorkspaceTab): TerminalConnectionMetadata {
  if (tab.kind === "localTerminal") {
    return { kind: "local", shell: tab.profileId };
  }
  if (tab.kind === "telnet") {
    return { kind: "telnet", host: tab.connection.host, port: tab.connection.port };
  }
  return {
    kind: "serial",
    portName: tab.connection.portName,
    baudRate: tab.connection.baudRate,
  };
}

function unique(values: readonly string[]) {
  return [...new Set(values)];
}
