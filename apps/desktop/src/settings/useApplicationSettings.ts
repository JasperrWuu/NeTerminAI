import { useEffect, useState } from "react";
import type {
  AppearanceSettings,
  ApplicationSettings,
  TerminalSettings,
} from "./types";

const STORAGE_KEY = "neterminai.application.settings.v1";

export const defaultApplicationSettings: ApplicationSettings = {
  appearance: {
    theme: "dark",
  },
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
};

function readSettings(): ApplicationSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return defaultApplicationSettings;

    const parsed = JSON.parse(stored) as Partial<ApplicationSettings>;
    const settings: ApplicationSettings = {
      appearance: {
        ...defaultApplicationSettings.appearance,
        ...parsed.appearance,
      },
      terminal: {
        ...defaultApplicationSettings.terminal,
        ...parsed.terminal,
        highlightRules: Array.isArray(parsed.terminal?.highlightRules)
          ? parsed.terminal.highlightRules
          : [],
      },
    };
    if (settings.terminal.colorScheme === "paper") settings.appearance.theme = "light";
    if (settings.terminal.colorScheme === "graphite") settings.appearance.theme = "dark";
    return settings;
  } catch {
    return defaultApplicationSettings;
  }
}

export interface ApplicationSettingsController extends ApplicationSettings {
  updateAppearance: (settings: Partial<AppearanceSettings>) => void;
  updateTerminal: (settings: Partial<TerminalSettings>) => void;
  resetTerminal: () => void;
}

export function useApplicationSettings(): ApplicationSettingsController {
  const [settings, setSettings] = useState<ApplicationSettings>(readSettings);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Keep the in-memory settings usable when browser storage is unavailable.
    }
  }, [settings]);

  return {
    ...settings,
    updateAppearance: (patch) =>
      setSettings((current) => {
        const nextTheme = patch.theme ?? current.appearance.theme;
        const linkedColorScheme =
          current.terminal.colorScheme === "adaptive"
            ? "adaptive"
            : nextTheme === "light" ? "paper" : "graphite";
        return {
          appearance: { ...current.appearance, ...patch },
          terminal: { ...current.terminal, colorScheme: linkedColorScheme },
        };
      }),
    updateTerminal: (patch) =>
      setSettings((current) => {
        const linkedTheme =
          patch.colorScheme === "paper"
            ? "light"
            : patch.colorScheme === "graphite"
              ? "dark"
              : current.appearance.theme;
        return {
          appearance: { ...current.appearance, theme: linkedTheme },
          terminal: { ...current.terminal, ...patch },
        };
      }),
    resetTerminal: () =>
      setSettings((current) => ({
        ...current,
        terminal: defaultApplicationSettings.terminal,
      })),
  };
}
