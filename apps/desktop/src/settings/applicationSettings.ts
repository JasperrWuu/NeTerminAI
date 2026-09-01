import type { ApplicationSettings, KeybindingSettings, TerminalHighlightRule } from "./types";

const STORAGE_KEY = "neterminai.application.settings.v1";

export const defaultApplicationSettings: ApplicationSettings = {
  appearance: { theme: "dark" },
  terminal: {
    fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
    fontSize: 14,
    fontWeight: 400,
    lineHeight: 1.18,
    cursorStyle: "bar",
    cursorBlink: true,
    scrollback: 10_000,
    colorScheme: "adaptive",
    highlightRules: [],
  },
  keybindings: {
    synchronizeVisibleTerminals: "Ctrl+Alt+I",
    stopSynchronizedInput: "Ctrl+Alt+Shift+I",
    focusNextSession: "Ctrl+Tab",
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

  return {
    appearance: {
      theme: appearance?.theme === "light" || appearance?.theme === "dark"
        ? appearance.theme
        : defaults.appearance.theme,
    },
    terminal: {
      fontFamily: nonEmptyString(terminal?.fontFamily) ?? defaults.terminal.fontFamily,
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
      highlightRules: Array.isArray(terminal?.highlightRules)
        ? terminal.highlightRules.flatMap(normalizeHighlightRule)
        : defaults.terminal.highlightRules,
    },
    keybindings: normalizeKeybindings(keybindings),
  };
}

function normalizeKeybindings(value: Record<string, unknown> | null): KeybindingSettings {
  const defaults = defaultApplicationSettings.keybindings;
  const settings = {
    synchronizeVisibleTerminals: stringValue(value?.synchronizeVisibleTerminals)
      ?? defaults.synchronizeVisibleTerminals,
    stopSynchronizedInput: stringValue(value?.stopSynchronizedInput)
      ?? defaults.stopSynchronizedInput,
    focusNextSession: stringValue(value?.focusNextSession) ?? defaults.focusNextSession,
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

function finiteNumberInRange(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}
