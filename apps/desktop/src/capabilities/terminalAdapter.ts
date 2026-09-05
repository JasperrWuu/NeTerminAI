import type { TerminalSessionRuntimeSnapshot } from "../terminal/TerminalSessionRuntime";
import {
  DEFAULT_TERMINAL_SNAPSHOT_LIMITS,
  type ContextSelection,
  type TerminalCapability,
  type TerminalConnectionKind,
  type TerminalConnectionMetadata,
  type TerminalContextSnapshot,
  type TerminalInputDispatchResult,
  type TerminalSessionDescriptor,
  type TerminalSnapshot,
  type TerminalSnapshotLimits,
  type TerminalTarget,
  resolveContextSelection,
} from "./terminal";
import { collectVisibleTabIds, findPane, findPaneContainingTab } from "../workspace/layout";
import type { WorkspaceLayoutNode, WorkspaceTab } from "../workspace/types";

const MAX_VISIBLE_CHARS = 64 * 1024;
const VISIBLE_CONTEXT_LIMITS: Readonly<TerminalSnapshotLimits> = {
  maxLines: 80,
  maxChars: 8 * 1024,
};

export interface TerminalCapabilityWorkspace {
  tabs: readonly WorkspaceTab[];
  layout: WorkspaceLayoutNode;
  activePaneId: string;
  activeTabId: string | null;
  projectId?: string;
}

interface RuntimeContextReader {
  readonly connectionType: TerminalConnectionKind;
  getSnapshot(): TerminalSessionRuntimeSnapshot;
  getTerminalSnapshot(limits?: TerminalSnapshotLimits): TerminalSnapshot;
}

type AiTerminalTab = Exclude<WorkspaceTab, { kind: "rdp" }>;

interface RuntimeSource {
  get(tabId: string): RuntimeContextReader | undefined;
  dispatchInput(tabId: string, sessionId: string, data: string): TerminalInputDispatchResult;
  subscribe(listener: () => void): () => void;
  getRevision(): number;
}

/**
 * Composition-root adapter. It is the only layer that knows how workspace
 * tabs/layouts and TerminalSessionRegistry map to the neutral AI contract.
 * RDP tabs are deliberately excluded here because they are native views, not
 * text terminals.
 */
export class TerminalCapabilityAdapter implements TerminalCapability {
  constructor(
    private readonly registry: RuntimeSource,
    private readonly getWorkspace: () => TerminalCapabilityWorkspace,
  ) {}

  getActiveContext(): TerminalContextSnapshot | undefined {
    const workspace = scopedWorkspace(this.getWorkspace());
    const activeTabId = activeTabForWorkspace(workspace);
    return activeTabId ? this.getContextForTab(activeTabId) : undefined;
  }

  getContextForTab(
    tabId: string,
    limits: TerminalSnapshotLimits = DEFAULT_TERMINAL_SNAPSHOT_LIMITS,
  ): TerminalContextSnapshot | undefined {
    const workspace = scopedWorkspace(this.getWorkspace());
    const tab = workspace.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || !isAiCapableTab(tab)) return undefined;

    const runtime = this.registry.get(tabId);
    if (!runtime || runtime.connectionType !== connectionKindForTab(tab)) return undefined;
    const runtimeSnapshot = runtime.getSnapshot();
    const captured = runtime.getTerminalSnapshot(limits);
    const terminal = {
      ...captured,
      recentText: redactSensitive(captured.recentText),
      ...(captured.selection ? { selection: redactSensitive(captured.selection) } : {}),
    };
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
      ...(runtimeSnapshot.message ? { message: redactSensitive(runtimeSnapshot.message) } : {}),
      target: { tabId, sessionId: runtimeSnapshot.sessionId },
      connection: connectionMetadataForTab(tab),
      terminal,
    };
  }

  getContexts(selection: ContextSelection): TerminalContextSnapshot[] {
    const workspace = scopedWorkspace(this.getWorkspace());
    const availableTabIds = workspace.tabs.map((tab) => tab.id);
    const visibleTabIds = collectVisibleTabIds(workspace.layout);
    const tabIds = resolveContextSelection(
      selection,
      availableTabIds,
      visibleTabIds,
      activeTabForWorkspace(workspace),
    );
    const activeTabId = activeTabForWorkspace(workspace);
    const orderedIds = activeTabId && tabIds.includes(activeTabId)
      ? [activeTabId, ...tabIds.filter((tabId) => tabId !== activeTabId)]
      : tabIds;
    const contexts: TerminalContextSnapshot[] = [];
    let remainingChars = MAX_VISIBLE_CHARS;
    for (const tabId of orderedIds) {
      const requested = tabId === activeTabId
        ? DEFAULT_TERMINAL_SNAPSHOT_LIMITS
        : VISIBLE_CONTEXT_LIMITS;
      const context = this.getContextForTab(tabId, {
        maxLines: requested.maxLines,
        maxChars: Math.min(requested.maxChars, remainingChars),
      });
      if (!context) continue;
      contexts.push(context);
      remainingChars = Math.max(
        0,
        remainingChars
          - context.terminal.recentText.length
          - (context.terminal.selection?.length ?? 0),
      );
    }
    return contexts;
  }

  getVisibleContexts() {
    return this.getContexts({ scope: "visible", selectedTabIds: [] });
  }

  listSessions(): TerminalSessionDescriptor[] {
    const workspace = scopedWorkspace(this.getWorkspace());
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

  listOwnedTerminalIds() {
    return scopedWorkspace(this.getWorkspace()).tabs.map((tab) => tab.id);
  }

  dispatchInput(target: TerminalTarget, data: string) {
    const workspace = this.getWorkspace();
    const tab = workspace.tabs.find((candidate) => candidate.id === target.tabId);
    if (!tab || !isAiCapableTab(tab)) {
      return { ok: false as const, code: "stale_session" as const };
    }
    return this.registry.dispatchInput(target.tabId, target.sessionId, data);
  }

  subscribe(listener: () => void) {
    return this.registry.subscribe(listener);
  }

  getRevision() {
    return this.registry.getRevision();
  }
}

function scopedWorkspace(workspace: TerminalCapabilityWorkspace): Omit<TerminalCapabilityWorkspace, "tabs"> & { tabs: AiTerminalTab[] } {
  const projectTabs = workspace.projectId
    ? workspace.tabs.filter((tab) => tab.projectId === workspace.projectId)
    : workspace.tabs;
  return { ...workspace, tabs: projectTabs.filter(isAiCapableTab) };
}

function activeTabForWorkspace(workspace: TerminalCapabilityWorkspace) {
  const activePane = findPane(workspace.layout, workspace.activePaneId);
  const activeTabId = activePane?.activeTabId ?? workspace.activeTabId;
  return activeTabId && workspace.tabs.some((tab) => tab.id === activeTabId) ? activeTabId : null;
}

function isAiCapableTab(tab: WorkspaceTab): tab is AiTerminalTab {
  return tab.kind !== "rdp";
}

function connectionKindForTab(tab: AiTerminalTab) {
  return tab.kind === "localTerminal" ? "local" as const : tab.kind;
}

function connectionMetadataForTab(tab: AiTerminalTab): TerminalConnectionMetadata {
  if (tab.kind === "localTerminal") return { kind: "local", shell: tab.profileId };
  if (tab.kind === "telnet") return { kind: "telnet", host: tab.connection.host, port: tab.connection.port };
  if (tab.kind === "ssh") return { kind: "ssh", host: tab.connection.host, port: tab.connection.port };
  return { kind: "serial", portName: tab.connection.portName, baudRate: tab.connection.baudRate };
}

function redactSensitive(value: string) {
  return value
    .replace(/\b(password|passwd|secret)\s*[:=]\s*\S+/giu, "$1: [redacted]")
    .replace(/(密码|口令)\s*[:：=]\s*\S+/gu, "$1：[已隐藏]");
}
