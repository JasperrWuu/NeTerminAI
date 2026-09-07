import type {
  ApplicationSettings,
  KeybindingCommandId,
  KeybindingSettings,
  TerminalHighlightRule,
  TerminalHighlightSet,
  WorkspacePreferences,
} from "./types";

import { createDefaultHighlightSets } from "./defaultHighlightSets.ts";

export const CURRENT_SETTINGS_SCHEMA_VERSION = 6;
export const SETTINGS_STORAGE_KEY = "neterminai.application.settings.v2";
export const LEGACY_SETTINGS_STORAGE_KEY = "neterminai.application.settings.v1";
export const LEGACY_WORKBENCH_STORAGE_KEY = "neterminai.workbench.preferences.v2";

const KEYBINDING_IDS: readonly KeybindingCommandId[] = [
  "newTelnetSession",
  "closeCurrentSession",
  "synchronizeVisibleTerminals",
  "stopSynchronizedInput",
  "insertLocalIpv4",
  "focusNextSession",
  "balanceWorkspace",
  "collapseWorkspace",
  "toggleImmersiveMode",
];

export const defaultApplicationSettings = createDefaultApplicationSettings();

export function createDefaultApplicationSettings(): ApplicationSettings {
  return {
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    appearance: { theme: "dark" },
    terminal: {
      fontFamilyLatin: "Cascadia Mono",
      fontFamilyCjk: "Microsoft YaHei",
      fontSize: 14,
      fontWeight: 400,
      lineHeight: 1.18,
      cursorStyle: "bar",
      cursorBlink: true,
      scrollback: 10_000,
      colorScheme: "adaptive",
      activeHighlightSetId: "builtin-dark",
      highlightSets: createDefaultHighlightSets(),
    },
    keybindings: {
      newTelnetSession: { id: "newTelnetSession", binding: "Ctrl+N", enabled: true },
      closeCurrentSession: { id: "closeCurrentSession", binding: "Ctrl+Shift+N", enabled: true },
      synchronizeVisibleTerminals: {
        id: "synchronizeVisibleTerminals",
        binding: "Ctrl+L",
        enabled: true,
      },
      stopSynchronizedInput: {
        id: "stopSynchronizedInput",
        binding: "Ctrl+Shift+L",
        enabled: true,
      },
      insertLocalIpv4: {
        id: "insertLocalIpv4",
        binding: "Ctrl+I",
        enabled: true,
      },
      focusNextSession: {
        id: "focusNextSession",
        binding: "Ctrl+Tab",
        enabled: true,
      },
      balanceWorkspace: {
        id: "balanceWorkspace",
        binding: "Ctrl+Equal",
        enabled: true,
      },
      collapseWorkspace: {
        id: "collapseWorkspace",
        binding: "Ctrl+-",
        enabled: true,
      },
      toggleImmersiveMode: {
        id: "toggleImmersiveMode",
        binding: "F11",
        enabled: true,
      },
    },
    ai: {
      enabled: true,
      providerMode: "api",
      providerPreset: "openaiCompatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      temperature: 0.2,
      executable: "",
      scriptPath: "",
      arguments: [],
      cwd: "",
      runAsAdministrator: true,
      timeoutMs: 60_000,
    },
    workspacePreferences: {
      leftSidebarOpen: true,
      rightSidebarOpen: false,
      leftSidebarWidth: 260,
      rightSidebarWidth: 320,
    },
  };
}

/** Converts persisted data from any supported schema into the current model. */
export function migrateSettings(
  value: unknown,
  legacyWorkspacePreferences?: unknown,
): ApplicationSettings {
  const root = asRecord(value);
  const defaults = createDefaultApplicationSettings();
  const appearance = asRecord(root?.appearance);
  const terminal = asRecord(root?.terminal);
  const keybindings = asRecord(root?.keybindings);
  const ai = asRecord(root?.ai);
  let highlightSets = normalizeHighlightSets(terminal, defaults.terminal.highlightSets);
  if (typeof root?.schemaVersion === "number" && root.schemaVersion < 5) {
    const pristine = highlightSets.length === 1 && highlightSets[0].id === "default-highlight-set"
      && highlightSets[0].name === "默认突显集" && highlightSets[0].rules.length === 0;
    if (pristine) {
      const enabled = highlightSets[0].enabled;
      highlightSets = createDefaultHighlightSets().map((set) => ({
        ...set, enabled: enabled && set.id === (appearance?.theme === "light" ? "builtin-light" : "builtin-dark"),
      }));
    } else {
      highlightSets = [...highlightSets, ...createDefaultHighlightSets()
        .filter((preset) => !highlightSets.some((set) => set.id === preset.id))
        .map((set) => ({ ...set, enabled: false }))];
    }
  }
  if (typeof root?.schemaVersion === "number" && root.schemaVersion < 6) {
    const presets = createDefaultHighlightSets();
    highlightSets = highlightSets.map((set) => {
      const preset = presets.find((item) => item.id === set.id);
      if (!preset) return set;
      return {
        ...set,
        name: ["夜色 · 暗色", "日光 · 亮色"].includes(set.name) ? preset.name : set.name,
        rules: [...set.rules, ...preset.rules.filter((rule) => !set.rules.some((existing) => existing.id === rule.id))],
      };
    });
  }
  const highlightSelection = normalizeTerminalHighlightSelection(
    highlightSets,
    stringValue(terminal?.activeHighlightSetId),
  );
  const workspaceValue = root?.workspacePreferences ?? legacyWorkspacePreferences;
  const colorScheme = normalizeColorScheme(terminal?.colorScheme, defaults.terminal.colorScheme);

  return {
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    appearance: {
      theme: colorScheme === "paper"
        ? "light"
        : colorScheme === "graphite"
          ? "dark"
          : appearance?.theme === "light" || appearance?.theme === "dark"
            ? appearance.theme
            : defaults.appearance.theme,
    },
    terminal: {
      fontFamilyLatin: nonEmptyString(terminal?.fontFamilyLatin)
        ?? legacyFontFamily(terminal?.fontFamily)
        ?? defaults.terminal.fontFamilyLatin,
      fontFamilyCjk: nonEmptyString(terminal?.fontFamilyCjk) ?? defaults.terminal.fontFamilyCjk,
      fontSize: finiteNumberInRange(terminal?.fontSize, 11, 22) ?? defaults.terminal.fontSize,
      fontWeight: terminal?.fontWeight === 400 || terminal?.fontWeight === 500 || terminal?.fontWeight === 600
        ? terminal.fontWeight
        : defaults.terminal.fontWeight,
      lineHeight: finiteNumberInRange(terminal?.lineHeight, 1, 1.5) ?? defaults.terminal.lineHeight,
      cursorStyle: terminal?.cursorStyle === "block"
        || terminal?.cursorStyle === "bar"
        || terminal?.cursorStyle === "underline"
        ? terminal.cursorStyle
        : defaults.terminal.cursorStyle,
      cursorBlink: typeof terminal?.cursorBlink === "boolean"
        ? terminal.cursorBlink
        : defaults.terminal.cursorBlink,
      scrollback: terminal?.scrollback === 1_000
        || terminal?.scrollback === 5_000
        || terminal?.scrollback === 10_000
        || terminal?.scrollback === 50_000
        ? terminal.scrollback
        : defaults.terminal.scrollback,
      colorScheme,
      ...highlightSelection,
    },
    keybindings: normalizeKeybindings(keybindings, defaults.keybindings),
    ai: normalizeAiSettings(ai, defaults.ai),
    workspacePreferences: normalizeWorkspacePreferences(workspaceValue, defaults.workspacePreferences),
  };
}

function normalizeAiSettings(value: Record<string, unknown> | null, defaults: ApplicationSettings["ai"]): ApplicationSettings["ai"] {
  const providerMode = value?.providerMode === "process" ? "process" : "api";
  const preset = value?.providerPreset === "claude"
    || value?.providerPreset === "opencode"
    || value?.providerPreset === "powershell"
    || value?.providerPreset === "custom"
    ? value.providerPreset
    : "openaiCompatible";
  const args = Array.isArray(value?.arguments)
    ? value.arguments.filter((item): item is string => typeof item === "string").slice(0, 32)
    : defaults.arguments;
  return {
    enabled: typeof value?.enabled === "boolean" ? value.enabled : defaults.enabled,
    providerMode,
    providerPreset: preset,
    baseUrl: nonEmptyString(value?.baseUrl) ?? defaults.baseUrl,
    model: nonEmptyString(value?.model) ?? defaults.model,
    temperature: finiteNumberInRange(value?.temperature, 0, 2) ?? defaults.temperature,
    executable: typeof value?.executable === "string" ? value.executable : defaults.executable,
    scriptPath: typeof value?.scriptPath === "string" ? value.scriptPath : defaults.scriptPath,
    arguments: args,
    cwd: typeof value?.cwd === "string" ? value.cwd : defaults.cwd,
    runAsAdministrator: typeof value?.runAsAdministrator === "boolean"
      ? value.runAsAdministrator
      : defaults.runAsAdministrator,
    timeoutMs: finiteNumberInRange(value?.timeoutMs, 1_000, 600_000) ?? defaults.timeoutMs,
  };
}

export function readApplicationSettings(): ApplicationSettings {
  const storage = getStorage();
  if (!storage) return createDefaultApplicationSettings();

  const currentRaw = safeGet(storage, SETTINGS_STORAGE_KEY);
  const legacyRaw = safeGet(storage, LEGACY_SETTINGS_STORAGE_KEY);
  const parsedCurrent = parseJson(currentRaw);
  const parsedLegacy = parseJson(legacyRaw);
  const settingsValue = parsedCurrent ?? parsedLegacy;
  const legacyWorkspace = parseJson(safeGet(storage, LEGACY_WORKBENCH_STORAGE_KEY));

  return migrateSettings(settingsValue, legacyWorkspace);
}

export function persistApplicationSettings(settings: ApplicationSettings) {
  const storage = getStorage();
  if (!storage) return;

  try {
    const normalized = migrateSettings(settings);
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
    storage.removeItem(LEGACY_SETTINGS_STORAGE_KEY);
    storage.removeItem(LEGACY_WORKBENCH_STORAGE_KEY);
  } catch {
    // Keep the in-memory settings usable when browser storage is unavailable.
  }
}

export function normalizeTerminalHighlightSelection(
  highlightSets: TerminalHighlightSet[],
  requestedHighlightSetId: string | null,
) {
  const activeHighlightSetId = highlightSets.some((set) => set.id === requestedHighlightSetId)
    ? requestedHighlightSetId
    : highlightSets.find((set) => set.enabled)?.id ?? null;
  return {
    activeHighlightSetId,
    highlightSets: highlightSets.map((set) => ({
      ...set,
      enabled: set.id === activeHighlightSetId,
    })),
  };
}

function normalizeColorScheme(value: unknown, fallback: ApplicationSettings["terminal"]["colorScheme"]) {
  return value === "adaptive" || value === "graphite" || value === "paper" ? value : fallback;
}

function normalizeHighlightSets(
  terminal: Record<string, unknown> | null,
  defaults: TerminalHighlightSet[],
) {
  if (Array.isArray(terminal?.highlightSets)) {
    return terminal.highlightSets.flatMap(normalizeHighlightSet);
  }

  if (Array.isArray(terminal?.highlightRules)) {
    const legacyRules = terminal.highlightRules.flatMap(normalizeHighlightRule);
    return [{
      id: "migrated-highlight-set",
      name: "我的突显集",
      enabled: true,
      rules: legacyRules,
    }];
  }

  return defaults;
}

function normalizeHighlightSet(value: unknown): TerminalHighlightSet[] {
  const set = asRecord(value);
  if (!set || typeof set.id !== "string") return [];
  const name = nonEmptyString(set.name);
  if (!name || !Array.isArray(set.rules)) return [];
  return [{
    id: set.id,
    name,
    enabled: typeof set.enabled === "boolean" ? set.enabled : true,
    rules: set.rules.flatMap(normalizeHighlightRule),
  }];
}

function normalizeKeybindings(
  value: Record<string, unknown> | null,
  defaults: KeybindingSettings,
): KeybindingSettings {
  const settings = Object.fromEntries(KEYBINDING_IDS.map((id) => {
    const stored = asRecord(value?.[id]);
    const legacyBinding = typeof value?.[id] === "string" ? value[id] : null;
    const binding = stringValue(stored?.binding) ?? legacyBinding ?? defaults[id].binding;
    return [id, {
      id,
      binding: normalizeBalanceWorkspaceShortcut(binding, id),
      enabled: typeof stored?.enabled === "boolean" ? stored.enabled : true,
    }];
  })) as KeybindingSettings;

  // A stored binding is treated as a user choice. Defaults only fill missing
  // commands, so changing defaults never overwrites an existing customization.
  for (const id of ["newTelnetSession", "closeCurrentSession"] as const) {
    if (value?.[id] !== undefined) continue;
    if (KEYBINDING_IDS.some((other) => other !== id && value?.[other] !== undefined
      && settings[other].enabled && settings[other].binding.toLowerCase() === settings[id].binding.toLowerCase())) {
      settings[id].enabled = false;
    }
  }
  return settings;
}

function normalizeBalanceWorkspaceShortcut(value: string, id: KeybindingCommandId) {
  if (id !== "balanceWorkspace") return value;
  return value === "Ctrl++" || value === "Ctrl+=" ? "Ctrl+Equal" : value;
}

function normalizeWorkspacePreferences(
  value: unknown,
  defaults: WorkspacePreferences,
): WorkspacePreferences {
  const root = asRecord(value);
  return {
    leftSidebarOpen: typeof root?.leftSidebarOpen === "boolean"
      ? root.leftSidebarOpen
      : defaults.leftSidebarOpen,
    rightSidebarOpen: typeof root?.rightSidebarOpen === "boolean"
      ? root.rightSidebarOpen
      : defaults.rightSidebarOpen,
    leftSidebarWidth: finiteNumberInRange(root?.leftSidebarWidth, 180, 1200)
      ?? defaults.leftSidebarWidth,
    rightSidebarWidth: finiteNumberInRange(root?.rightSidebarWidth, 240, 1200)
      ?? defaults.rightSidebarWidth,
  };
}

function normalizeHighlightRule(value: unknown): TerminalHighlightRule[] {
  const rule = asRecord(value);
  if (!rule || typeof rule.id !== "string" || typeof rule.pattern !== "string") return [];
  if (rule.matchMode !== "text" && rule.matchMode !== "regex") return [];
  if (typeof rule.color !== "string" || !/^#[0-9a-f]{6}$/i.test(rule.color)) return [];
  return [{
    id: rule.id,
    name: typeof rule.name === "string" ? rule.name : createDefaultHighlightSets()
      .flatMap((set) => set.rules).find((preset) => preset.id === rule.id)?.name ?? "自定义匹配",
    enabled: typeof rule.enabled === "boolean" ? rule.enabled : true,
    matchMode: rule.matchMode,
    pattern: rule.pattern,
    color: rule.color.toUpperCase(),
    caseSensitive: typeof rule.caseSensitive === "boolean" ? rule.caseSensitive : false,
  }];
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function safeGet(storage: Storage, key: string) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
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
  return typeof value === "string" ? value : null;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function legacyFontFamily(value: unknown) {
  const family = nonEmptyString(value);
  if (!family) return null;
  const first = family.match(/^\s*"([^"]+)"|^\s*([^,]+)/);
  return (first?.[1] ?? first?.[2])?.trim() || null;
}

function finiteNumberInRange(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}
