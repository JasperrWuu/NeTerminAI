export type AppearanceTheme = "dark" | "light";
export type TerminalCursorStyle = "block" | "bar" | "underline";
export type TerminalColorScheme = "adaptive" | "graphite" | "paper";
export type TerminalFontWeight = 400 | 500 | 600;
export type TerminalHighlightMatchMode = "text" | "regex";
export type SettingsSection = "terminal" | "keyboard";
export type KeybindingCommandId =
  | "synchronizeVisibleTerminals"
  | "stopSynchronizedInput"
  | "focusNextSession"
  | "balanceWorkspace"
  | "collapseWorkspace";

export type KeybindingSettings = Record<KeybindingCommandId, string>;

export interface TerminalHighlightRule {
  id: string;
  enabled: boolean;
  matchMode: TerminalHighlightMatchMode;
  pattern: string;
  color: string;
  caseSensitive: boolean;
}

export interface TerminalHighlightSet {
  id: string;
  name: string;
  enabled: boolean;
  rules: TerminalHighlightRule[];
}

export interface AppearanceSettings {
  theme: AppearanceTheme;
}
export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  fontWeight: TerminalFontWeight;
  lineHeight: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  colorScheme: TerminalColorScheme;
  activeHighlightSetId: string | null;
  highlightSets: TerminalHighlightSet[];
}

export interface ApplicationSettings {
  appearance: AppearanceSettings;
  terminal: TerminalSettings;
  keybindings: KeybindingSettings;
}
