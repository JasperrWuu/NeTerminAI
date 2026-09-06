export const AUTOMATION_DRAFT_KEY = "neterminai.automation.v1";
const AUTOMATION_SCHEMA_VERSION = 1;
const DEFAULT_CODE = `for _ in range(3):
    output = send("display health")
    print(output)
`;

export type AutomationTarget =
  | { mode: "active" }
  | { mode: "sessions"; tabIds: string[] };

export interface AutomationScriptDraft {
  id: string;
  name: string;
  code: string;
  target: AutomationTarget;
  collapsed: boolean;
}

export function createAutomationScript(index = 1): AutomationScriptDraft {
  return {
    id: createId("automation"),
    name: `脚本 ${index}`,
    code: DEFAULT_CODE,
    target: { mode: "active" },
    collapsed: false,
  };
}

export function readAutomationScripts(): AutomationScriptDraft[] {
  try {
    const raw = typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(AUTOMATION_DRAFT_KEY);
    const root = raw ? JSON.parse(raw) : null;
    const values = Array.isArray(root) ? root : record(root).scripts;
    const scripts = Array.isArray(values) ? values.flatMap(normalizeScript) : [];
    return scripts.length > 0 ? scripts : [createAutomationScript()];
  } catch {
    return [createAutomationScript()];
  }
}

export function persistAutomationScripts(scripts: readonly AutomationScriptDraft[]) {
  try {
    localStorage.setItem(AUTOMATION_DRAFT_KEY, JSON.stringify({
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      scripts: scripts.map(normalizeScriptValue),
    }));
    return true;
  } catch {
    return false;
  }
}

export function normalizeAutomationTarget(value: unknown): AutomationTarget {
  const root = record(value);
  if (root.mode === "sessions") {
    const persistedIds = Array.isArray(root.tabIds)
      ? root.tabIds
      : Array.isArray(root.sessionIds)
        ? root.sessionIds
        : [];
    const tabIds = uniqueStrings(persistedIds).slice(0, 64);
    return { mode: "sessions", tabIds };
  }
  // Older drafts used sessionIds. Treat them as logical tab identities when
  // reading once, so a reconnect can still resolve the current runtime ID.
  if (Array.isArray(root.sessionIds)) {
    return { mode: "sessions", tabIds: uniqueStrings(root.sessionIds).slice(0, 64) };
  }
  return { mode: "active" };
}

function normalizeScript(value: unknown): AutomationScriptDraft[] {
  const root = record(value);
  if (typeof root.id !== "string" || !root.id.trim()) return [];
  return [{
    id: root.id,
    name: typeof root.name === "string" && root.name.trim() ? root.name.trim() : "未命名脚本",
    code: typeof root.code === "string" ? root.code : DEFAULT_CODE,
    target: normalizeAutomationTarget(root.target),
    collapsed: typeof root.collapsed === "boolean" ? root.collapsed : false,
  }];
}

function normalizeScriptValue(script: AutomationScriptDraft) {
  return {
    id: script.id,
    name: script.name.trim() || "未命名脚本",
    code: script.code,
    target: script.target.mode === "active"
      ? { mode: "active" }
      : { mode: "sessions", tabIds: uniqueStrings(script.target.tabIds).slice(0, 64) },
    collapsed: script.collapsed,
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function uniqueStrings(value: unknown[]) {
  return [...new Set(value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim()))];
}

function createId(prefix: string) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
