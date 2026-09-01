import type {
  ApplicationSettings,
  KeybindingSettings,
  TerminalHighlightRule,
  TerminalHighlightSet,
} from "./types";

const STORAGE_KEY = "neterminai.application.settings.v1";

export const defaultApplicationSettings: ApplicationSettings = {
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
    activeHighlightSetId: "default-highlight-set",
    highlightSets: [{
      id: "default-highlight-set",
      name: "默认突显集",
      enabled: true,
      rules: [],
    }],
  },
  keybindings: {
    synchronizeVisibleTerminals: "Ctrl+Alt+I",
    stopSynchronizedInput: "Ctrl+Alt+Shift+I",
    focusNextSession: "Ctrl+Tab",
    balanceWorkspace: "Ctrl++",
    collapseWorkspace: "Ctrl+-",
  },
};

export function readApplicationSettings(): ApplicationSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return defaultApplicationSettings;

    const settings = normalizeSettings(JSON.parse(stored));
    if (settings.terminal.colorScheme === "paper") {
      return { ...settings, appearance: { theme: "light" } };
    }
    if (settings.terminal.colorScheme === "graphite") {
      return { ...settings, appearance: { theme: "dark" } };
    }
    return settings;
  } catch {
    return defaultApplicationSettings;
  }
}

export function persistApplicationSettings(settings: ApplicationSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Keep the in-memory settings usable when browser storage is unavailable.
  }
}

function normalizeSettings(value: unknown): ApplicationSettings {
  const root = asRecord(value);
  const appearance = asRecord(root?.appearance);
  const terminal = asRecord(root?.terminal);
  const keybindings = asRecord(root?.keybindings);
  const defaults = defaultApplicationSettings;

  const highlightSelection = normalizeTerminalHighlightSelection(
    normalizeHighlightSets(terminal, defaults.terminal.highlightSets),
    stringValue(terminal?.activeHighlightSetId),
  );

  return {
    appearance: {
      theme: appearance?.theme === "light" || appearance?.theme === "dark"
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
      colorScheme: terminal?.colorScheme === "adaptive"
        || terminal?.colorScheme === "graphite"
        || terminal?.colorScheme === "paper"
        ? terminal.colorScheme
        : defaults.terminal.colorScheme,
      ...highlightSelection,
    },
    keybindings: normalizeKeybindings(keybindings),
  };
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

function normalizeKeybindings(value: Record<string, unknown> | null): KeybindingSettings {
  const defaults = defaultApplicationSettings.keybindings;
  const settings = {
    synchronizeVisibleTerminals: stringValue(value?.synchronizeVisibleTerminals)
      ?? defaults.synchronizeVisibleTerminals,
    stopSynchronizedInput: stringValue(value?.stopSynchronizedInput)
      ?? defaults.stopSynchronizedInput,
    focusNextSession: stringValue(value?.focusNextSession) ?? defaults.focusNextSession,
    balanceWorkspace: stringValue(value?.balanceWorkspace) ?? defaults.balanceWorkspace,
    collapseWorkspace: stringValue(value?.collapseWorkspace) ?? defaults.collapseWorkspace,
  };

  const usesLegacyTerminalControlDefaults = settings.synchronizeVisibleTerminals === "Ctrl+L"
    && settings.stopSynchronizedInput === "Ctrl+Shift+L";
  return usesLegacyTerminalControlDefaults
    ? {
        ...settings,
        synchronizeVisibleTerminals: defaults.synchronizeVisibleTerminals,
        stopSynchronizedInput: defaults.stopSynchronizedInput,
      }
    : settings;
}

function normalizeHighlightRule(value: unknown): TerminalHighlightRule[] {
  const rule = asRecord(value);
  if (!rule || typeof rule.id !== "string" || typeof rule.pattern !== "string") return [];
  if (rule.matchMode !== "text" && rule.matchMode !== "regex") return [];
  if (typeof rule.color !== "string" || !/^#[0-9a-f]{6}$/i.test(rule.color)) return [];
  return [{
    id: rule.id,
    enabled: typeof rule.enabled === "boolean" ? rule.enabled : true,
    matchMode: rule.matchMode,
    pattern: rule.pattern,
    color: rule.color.toUpperCase(),
    caseSensitive: typeof rule.caseSensitive === "boolean" ? rule.caseSensitive : false,
  }];
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
