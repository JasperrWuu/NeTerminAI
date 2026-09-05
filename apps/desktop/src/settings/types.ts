export type AppearanceTheme = "dark" | "light";
export type TerminalCursorStyle = "block" | "bar" | "underline";
export type TerminalColorScheme = "adaptive" | "graphite" | "paper";
export type TerminalFontWeight = 400 | 500 | 600;
export type TerminalHighlightMatchMode = "text" | "regex";
export type SettingsSection = "terminal" | "keyboard" | "ai";
export type AiProviderMode = "api" | "process";
export type AiProviderPreset = "openaiCompatible" | "claude" | "opencode" | "powershell" | "custom";
export type KeybindingCommandId =
  | "synchronizeVisibleTerminals"
  | "stopSynchronizedInput"
  | "focusNextSession"
  | "balanceWorkspace"
  | "collapseWorkspace";

export interface KeybindingSetting {
  id: KeybindingCommandId;
  binding: string;
  enabled: boolean;
}

export type KeybindingSettings = Record<KeybindingCommandId, KeybindingSetting>;
export type KeybindingPatch = Partial<Record<
  KeybindingCommandId,
  Partial<Pick<KeybindingSetting, "binding" | "enabled">>
>>;

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

export interface AiSettings {
  enabled: boolean;
  providerMode: AiProviderMode;
  providerPreset: AiProviderPreset;
  baseUrl: string;
  model: string;
  temperature: number;
  executable: string;
  scriptPath: string;
  arguments: string[];
  cwd: string;
  timeoutMs: number;
}

export interface WorkspacePreferences {
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
}

export interface TerminalSettings {
  fontFamilyLatin: string;
  fontFamilyCjk: string;
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
  schemaVersion: number;
  appearance: AppearanceSettings;
  terminal: TerminalSettings;
  keybindings: KeybindingSettings;
  ai: AiSettings;
  workspacePreferences: WorkspacePreferences;
}
