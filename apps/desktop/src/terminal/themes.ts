import type { ITheme } from "@xterm/xterm";
import type { AppearanceTheme, TerminalColorScheme } from "../settings/types";

const graphiteTheme: ITheme = {
  background: "#0d0e10", foreground: "#d9dadd", cursor: "#8bb5ff", cursorAccent: "#0d0e10",
  selectionBackground: "#5d86cc66", black: "#24262a", red: "#ef7777", green: "#72c991",
  yellow: "#d8b866", blue: "#78a8ff", magenta: "#b792e8", cyan: "#65c5c8", white: "#d9dadd",
  brightBlack: "#71747b", brightRed: "#ff9292", brightGreen: "#8adea6", brightYellow: "#edcd7c",
  brightBlue: "#96bdff", brightMagenta: "#caa7f5", brightCyan: "#82d9dc", brightWhite: "#ffffff",
};

const paperTheme: ITheme = {
  background: "#f7f4ed", foreground: "#2d2926", cursor: "#c96442", cursorAccent: "#f7f4ed",
  selectionBackground: "#c9644233", black: "#3a3531", red: "#b94a3d", green: "#4f7754",
  yellow: "#936d2d", blue: "#4d6d80", magenta: "#805a75", cyan: "#427579", white: "#e8e1d6",
  brightBlack: "#837a72", brightRed: "#d15f4b", brightGreen: "#668c68", brightYellow: "#aa813c",
  brightBlue: "#64859a", brightMagenta: "#987087", brightCyan: "#5d8d8f", brightWhite: "#fffdf8",
};

export function resolveTerminalTheme(colorScheme: TerminalColorScheme, appearanceTheme: AppearanceTheme) {
  if (colorScheme === "graphite") return graphiteTheme;
  if (colorScheme === "paper") return paperTheme;
  return appearanceTheme === "dark" ? graphiteTheme : paperTheme;
}
