import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AppearanceSettings,
  ApplicationSettings,
  KeybindingSettings,
  TerminalSettings,
} from "./types";
import {
  defaultApplicationSettings,
  persistApplicationSettings,
  readApplicationSettings,
} from "./applicationSettings";

export interface ApplicationSettingsController extends ApplicationSettings {
  updateAppearance: (settings: Partial<AppearanceSettings>) => void;
  updateKeybindings: (settings: Partial<KeybindingSettings>) => void;
  updateTerminal: (settings: Partial<TerminalSettings>) => void;
  resetKeybindings: () => void;
  resetTerminal: () => void;
}

export function useApplicationSettings(): ApplicationSettingsController {
  const [settings, setSettings] = useState<ApplicationSettings>(readApplicationSettings);

  useEffect(() => {
    persistApplicationSettings(settings);
  }, [settings]);

  const updateAppearance = useCallback((patch: Partial<AppearanceSettings>) => {
    setSettings((current) => {
      const nextTheme = patch.theme ?? current.appearance.theme;
      const linkedColorScheme = current.terminal.colorScheme === "adaptive"
        ? "adaptive"
        : nextTheme === "light" ? "paper" : "graphite";
      return {
        ...current,
        appearance: { ...current.appearance, ...patch },
        terminal: { ...current.terminal, colorScheme: linkedColorScheme },
      };
    });
  }, []);

  const updateTerminal = useCallback((patch: Partial<TerminalSettings>) => {
    setSettings((current) => {
      const linkedTheme = patch.colorScheme === "paper"
        ? "light"
        : patch.colorScheme === "graphite"
          ? "dark"
          : current.appearance.theme;
      return {
        ...current,
        appearance: { ...current.appearance, theme: linkedTheme },
        terminal: { ...current.terminal, ...patch },
      };
    });
  }, []);

  const updateKeybindings = useCallback((patch: Partial<KeybindingSettings>) => {
    setSettings((current) => ({
      ...current,
      keybindings: { ...current.keybindings, ...patch },
    }));
  }, []);

  const resetKeybindings = useCallback(() => {
    setSettings((current) => ({
      ...current,
      keybindings: defaultApplicationSettings.keybindings,
    }));
  }, []);

  const resetTerminal = useCallback(() => {
    setSettings((current) => ({
      ...current,
      terminal: defaultApplicationSettings.terminal,
    }));
  }, []);

  return useMemo(() => ({
    ...settings,
    updateAppearance,
    updateKeybindings,
    updateTerminal,
    resetKeybindings,
    resetTerminal,
  }), [
    resetKeybindings,
    resetTerminal,
    settings,
    updateAppearance,
    updateKeybindings,
    updateTerminal,
  ]);
}
