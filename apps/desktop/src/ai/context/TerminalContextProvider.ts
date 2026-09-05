import type { TerminalConnectionType } from "../../ipc/types";
import {
  DEFAULT_TERMINAL_SNAPSHOT_LIMITS,
  type TerminalSnapshot,
  type TerminalSnapshotLimits,
} from "../../terminal/TerminalSnapshot.ts";
import type { TerminalSessionRuntimeSnapshot } from "../../terminal/TerminalSessionRuntime";
import { findPane, findPaneContainingTab } from "../../workspace/layout.ts";
import type { WorkspaceLayoutNode, WorkspaceTab } from "../../workspace/types";
import type { TerminalContextSnapshot, TerminalConnectionMetadata } from "./types";
import {
  resolveContextSelection,
  type AiContextSelection,
} from "./selection.ts";

export interface TerminalContextWorkspace {
  tabs: readonly WorkspaceTab[];
  layout: WorkspaceLayoutNode;
  activePaneId: string;
  activeTabId: string | null;
}

export interface TerminalContextSessionDescriptor {
  tabId: string;
  title: string;
  connectionKind: TerminalConnectionType;
  connection: TerminalConnectionMetadata;
  sessionId?: string;
  connectionState: ReturnType<RuntimeContextReader["getSnapshot"]>["state"];
  disconnectReason?: ReturnType<RuntimeContextReader["getSnapshot"]>["reason"];
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
    const activeTabId = activeTabForWorkspace(workspace);
    if (!activeTabId) return undefined;
    return this.getContextForTab(activeTabId);
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

  getContexts(selection: AiContextSelection): TerminalContextSnapshot[] {
    const workspace = this.getWorkspace();
    const tabIds = resolveContextSelection(
      selection,
      workspace.tabs,
      workspace.layout,
      workspace.activePaneId,
    );
    const activeTabId = activeTabForWorkspace(workspace);
    const orderedIds = activeTabId && tabIds.includes(activeTabId)
      ? [activeTabId, ...tabIds.filter((tabId) => tabId !== activeTabId)]
      : tabIds;
    const contexts: TerminalContextSnapshot[] = [];
    let remainingChars = MAX_VISIBLE_CHARS;
    for (const tabId of orderedIds.slice(0, MAX_VISIBLE_CONTEXTS)) {
      if (remainingChars <= 0) break;
      const requested = tabId === activeTabId
        ? DEFAULT_TERMINAL_SNAPSHOT_LIMITS
        : VISIBLE_CONTEXT_LIMITS;
      const context = this.getContextForTab(tabId, {
        maxLines: requested.maxLines,
        maxChars: Math.min(requested.maxChars, remainingChars),
      });
      if (!context) continue;
      contexts.push(context);
      remainingChars -= context.terminal.recentText.length
        + (context.terminal.selection?.length ?? 0);
    }
    return contexts;
  }

  listSessions(): TerminalContextSessionDescriptor[] {
    const workspace = this.getWorkspace();
    return workspace.tabs.map((tab) => {
      const runtime = this.registry.get(tab.id);
      const runtimeSnapshot = runtime?.getSnapshot();
      return {
        tabId: tab.id,
        title: tab.title,
        connectionKind: connectionKindForTab(tab),
        connection: connectionMetadataForTab(tab),
        ...(runtimeSnapshot ? { sessionId: runtimeSnapshot.sessionId } : {}),
        connectionState: runtimeSnapshot?.state ?? "connecting",
        ...(runtimeSnapshot?.reason ? { disconnectReason: runtimeSnapshot.reason } : {}),
      };
    });
  }

  /**
   * Captures currently visible active tabs with a shared character budget.
   * The active tab receives the larger snapshot; metadata for other visible
   * panes remains available until the bounded budget is exhausted.
   */
  getVisibleContexts(): TerminalContextSnapshot[] {
    return this.getContexts({ scope: "visible", selectedTabIds: [] });
  }
}

function activeTabForWorkspace(workspace: TerminalContextWorkspace) {
  const activePane = findPane(workspace.layout, workspace.activePaneId);
  return activePane?.activeTabId ?? workspace.activeTabId;
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
