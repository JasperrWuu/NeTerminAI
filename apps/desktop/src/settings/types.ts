export type AppearanceTheme = "dark" | "light";
export type TerminalCursorStyle = "block" | "bar" | "underline";
export type TerminalColorScheme = "adaptive" | "graphite" | "paper";
export type TerminalFontWeight = 400 | 500 | 600;

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
}

export interface ApplicationSettings {
  appearance: AppearanceSettings;
  terminal: TerminalSettings;
}
