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
  background: "#fbfbfc", foreground: "#26272a", cursor: "#1769d2", cursorAccent: "#fbfbfc",
  selectionBackground: "#1769d233", black: "#34363a", red: "#b83b42", green: "#287947",
  yellow: "#8b6700", blue: "#1769d2", magenta: "#7949a3", cyan: "#13777a", white: "#e4e5e7",
  brightBlack: "#75777c", brightRed: "#d44c53", brightGreen: "#319258", brightYellow: "#a47a00",
  brightBlue: "#2d7fe8", brightMagenta: "#9363ba", brightCyan: "#168f93", brightWhite: "#ffffff",
};

export function resolveTerminalTheme(colorScheme: TerminalColorScheme, appearanceTheme: AppearanceTheme) {
  if (colorScheme === "graphite") return graphiteTheme;
  if (colorScheme === "paper") return paperTheme;
  return appearanceTheme === "dark" ? graphiteTheme : paperTheme;
}
