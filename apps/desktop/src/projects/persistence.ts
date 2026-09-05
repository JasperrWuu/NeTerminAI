import {
  DEFAULT_CONTEXT_SELECTION,
  type ContextSelection,
} from "../capabilities/terminal";
import type { WorkspaceLayoutNode } from "../workspace/types";
import {
  PROJECT_SCHEMA_VERSION,
  type Project,
  type ProjectContext,
  type ProjectDeviceRef,
  type ProjectLayoutState,
  type ProjectRuntimeState,
  type ProjectSessionRef,
  type ProjectSessionSource,
  type ProjectStore,
} from "./types";

export const PROJECT_STORAGE_KEY = "neterminai.projects.v1";

const EMPTY_LAYOUT: ProjectLayoutState = {
  layout: null,
  activePaneId: null,
  activeTabId: null,
};

export function createDefaultProject(now = Date.now()): Project {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: createId("project"),
    name: "默认工作区",
    createdAt: now,
    updatedAt: now,
    devices: [],
    sessions: [],
    layout: cloneLayoutState(EMPTY_LAYOUT),
    context: createEmptyProjectContext(now),
    runtime: createDefaultProjectRuntime(),
  };
}

export function createProject(name: string, now = Date.now()): Project {
  const trimmed = name.trim();
  const project = createDefaultProject(now);
  return {
    ...project,
    name: trimmed || "未命名项目",
  };
}

export function createEmptyProjectContext(now = Date.now()): ProjectContext {
  return {
    goal: "",
    topology: "",
    keyConfigurations: [],
    confirmedFacts: [],
    progress: "",
    issues: [],
    conclusions: [],
    nextSteps: [],
    updatedAt: now,
  };
}

export function createDefaultProjectRuntime(): ProjectRuntimeState {
  return {
    activeTabId: null,
    aiContextSelection: { ...DEFAULT_CONTEXT_SELECTION, selectedTabIds: [] },
  };
}

export function readProjectStore(): ProjectStore {
  const fallback = createFallbackStore();
  const storage = getStorage();
  if (!storage) return fallback;

  try {
    const raw = storage.getItem(PROJECT_STORAGE_KEY);
    if (!raw) return fallback;
    const value = asRecord(JSON.parse(raw));
    if (!value || !Array.isArray(value.projects)) return fallback;
    const projects = value.projects.flatMap(normalizeProject);
    if (projects.length === 0) return fallback;
    const requestedActive = typeof value.activeProjectId === "string" ? value.activeProjectId : "";
    return {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      activeProjectId: projects.some((project) => project.id === requestedActive)
        ? requestedActive
        : projects[0].id,
      projects,
    };
  } catch {
    return fallback;
  }
}

export function persistProjectStore(store: ProjectStore) {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Keep the in-memory project store usable if browser storage is unavailable.
  }
}

export function normalizeProject(value: unknown): Project[] {
  const root = asRecord(value);
  if (!root) return [];
  const id = stringValue(root.id);
  if (!id) return [];
  const now = Date.now();
  const name = stringValue(root.name) || "未命名项目";
  const sessions = Array.isArray(root.sessions) ? root.sessions.flatMap(normalizeSessionRef) : [];
  const devices = Array.isArray(root.devices) ? root.devices.flatMap(normalizeDeviceRef) : [];
  return [{
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id,
    name,
    createdAt: finiteNumber(root.createdAt) ?? now,
    updatedAt: finiteNumber(root.updatedAt) ?? now,
    devices,
    sessions,
    layout: normalizeLayoutState(root.layout, sessions),
    context: normalizeProjectContext(root.context, now),
    runtime: normalizeProjectRuntime(root.runtime),
  }];
}

function createFallbackStore(): ProjectStore {
  const project = createDefaultProject();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    activeProjectId: project.id,
    projects: [project],
  };
}

function normalizeDeviceRef(value: unknown): ProjectDeviceRef[] {
  const root = asRecord(value);
  if (!root || typeof root.connectionId !== "string" || !root.connectionId) return [];
  return [{
    connectionId: root.connectionId,
    ...(typeof root.alias === "string" && root.alias.trim() ? { alias: root.alias.trim() } : {}),
    addedAt: finiteNumber(root.addedAt) ?? Date.now(),
  }];
}

function normalizeSessionRef(value: unknown): ProjectSessionRef[] {
  const root = asRecord(value);
  if (!root || typeof root.tabId !== "string" || !root.tabId || typeof root.title !== "string") return [];
  const source = normalizeSessionSource(root.source);
  if (!source) return [];
  return [{ tabId: root.tabId, title: root.title, source }];
}

function normalizeSessionSource(value: unknown): ProjectSessionSource | null {
  const root = asRecord(value);
  if (!root || typeof root.kind !== "string") return null;
  if (root.kind === "local" && typeof root.profileId === "string") {
    return { kind: "local", profileId: root.profileId };
  }
  if (root.kind === "savedConnection" && typeof root.connectionId === "string" && root.connectionId) {
    return { kind: "savedConnection", connectionId: root.connectionId };
  }
  if (root.kind === "transient"
    && (root.connectionKind === "local"
      || root.connectionKind === "telnet"
      || root.connectionKind === "serial"
      || root.connectionKind === "ssh"
      || root.connectionKind === "rdp")) {
    return { kind: "transient", connectionKind: root.connectionKind };
  }
  return null;
}

function normalizeLayoutState(value: unknown, sessions: readonly ProjectSessionRef[]): ProjectLayoutState {
  const root = asRecord(value);
  const sessionIds = new Set(sessions.map((session) => session.tabId));
  const layout = normalizeLayout(root?.layout, sessionIds);
  return {
    layout,
    activePaneId: typeof root?.activePaneId === "string" ? root.activePaneId : null,
    activeTabId: typeof root?.activeTabId === "string" && sessionIds.has(root.activeTabId)
      ? root.activeTabId
      : sessions[0]?.tabId ?? null,
  };
}

function normalizeLayout(value: unknown, sessionIds: ReadonlySet<string>): WorkspaceLayoutNode | null {
  const root = asRecord(value);
  if (!root || typeof root.type !== "string" || typeof root.id !== "string") return null;
  if (root.type === "pane") {
    if (!Array.isArray(root.tabIds)) return null;
    const tabIds = root.tabIds.filter((tabId): tabId is string => typeof tabId === "string" && sessionIds.has(tabId));
    if (tabIds.length === 0) return null;
    const activeTabId = typeof root.activeTabId === "string" && tabIds.includes(root.activeTabId)
      ? root.activeTabId
      : tabIds[0];
    return { type: "pane", id: root.id, tabIds, activeTabId };
  }
  if (root.type !== "split" || (root.direction !== "row" && root.direction !== "column")) return null;
  const first = normalizeLayout(root.first, sessionIds);
  const second = normalizeLayout(root.second, sessionIds);
  if (!first) return second;
  if (!second) return first;
  const ratio = finiteNumber(root.ratio);
  return {
    type: "split",
    id: root.id,
    direction: root.direction,
    ...(ratio === undefined ? {} : { ratio: Math.min(1, Math.max(0, ratio)) }),
    first,
    second,
  };
}

function normalizeProjectContext(value: unknown, now: number): ProjectContext {
  const root = asRecord(value);
  return {
    goal: stringValue(root?.goal),
    topology: stringValue(root?.topology),
    keyConfigurations: stringArray(root?.keyConfigurations),
    confirmedFacts: stringArray(root?.confirmedFacts),
    progress: stringValue(root?.progress),
    issues: stringArray(root?.issues),
    conclusions: stringArray(root?.conclusions),
    nextSteps: stringArray(root?.nextSteps),
    updatedAt: finiteNumber(root?.updatedAt) ?? now,
  };
}

function normalizeProjectRuntime(value: unknown): ProjectRuntimeState {
  const root = asRecord(value);
  const selection = asRecord(root?.aiContextSelection);
  const scope = selection?.scope === "visible" || selection?.scope === "selected"
    ? selection.scope
    : "active";
  return {
    // activeSessionId was historically populated with a tabId. Read it once
    // for compatibility, then persist the semantically correct activeTabId.
    activeTabId: typeof root?.activeTabId === "string"
      ? root.activeTabId
      : typeof root?.activeSessionId === "string"
        ? root.activeSessionId
        : null,
    aiContextSelection: {
      scope,
      selectedTabIds: stringArray(selection?.selectedTabIds),
    } satisfies ContextSelection,
  };
}

function cloneLayoutState(value: ProjectLayoutState): ProjectLayoutState {
  return {
    layout: value.layout ? cloneLayout(value.layout) : null,
    activePaneId: value.activePaneId,
    activeTabId: value.activeTabId,
  };
}

function cloneLayout(node: WorkspaceLayoutNode): WorkspaceLayoutNode {
  if (node.type === "pane") {
    return { ...node, tabIds: [...node.tabIds] };
  }
  return { ...node, first: cloneLayout(node.first), second: cloneLayout(node.second) };
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(-64)
    : [];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function createId(prefix: string) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
