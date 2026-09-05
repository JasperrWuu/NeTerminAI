import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AppearanceSettings,
  AiSettings,
  ApplicationSettings,
  KeybindingPatch,
  KeybindingSettings,
  TerminalSettings,
  WorkspacePreferences,
} from "./types";
import {
  createDefaultApplicationSettings,
  normalizeTerminalHighlightSelection,
  persistApplicationSettings,
  readApplicationSettings,
} from "./applicationSettings";

export interface ApplicationSettingsController extends ApplicationSettings {
  updateAppearance: (settings: Partial<AppearanceSettings>) => void;
  updateKeybindings: (settings: KeybindingPatch) => void;
  updateTerminal: (settings: Partial<TerminalSettings>) => void;
  updateAi: (settings: Partial<AiSettings>) => void;
  updateWorkspacePreferences: (settings: Partial<WorkspacePreferences>) => void;
  resetKeybindings: () => void;
  resetTerminal: () => void;
  resetAi: () => void;
  resetSettings: () => void;
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
      const terminal = { ...current.terminal, ...patch };
      const linkedTheme = patch.colorScheme === "paper"
        ? "light"
        : patch.colorScheme === "graphite"
          ? "dark"
          : current.appearance.theme;
      return {
        ...current,
        appearance: { ...current.appearance, theme: linkedTheme },
        terminal: {
          ...terminal,
          ...normalizeTerminalHighlightSelection(
            terminal.highlightSets,
            terminal.activeHighlightSetId,
          ),
        },
      };
    });
  }, []);

  const updateAi = useCallback((patch: Partial<AiSettings>) => {
    setSettings((current) => ({ ...current, ai: { ...current.ai, ...patch } }));
  }, []);

  const updateKeybindings = useCallback((patch: KeybindingPatch) => {
    setSettings((current) => ({
      ...current,
      keybindings: Object.fromEntries(
        Object.entries(current.keybindings).map(([id, binding]) => {
          const key = id as keyof KeybindingSettings;
          const next = patch[key];
          return [key, next ? { ...binding, ...next, id: binding.id } : binding];
        }),
      ) as KeybindingSettings,
    }));
  }, []);

  const updateWorkspacePreferences = useCallback((patch: Partial<WorkspacePreferences>) => {
    setSettings((current) => ({
      ...current,
      workspacePreferences: { ...current.workspacePreferences, ...patch },
    }));
  }, []);

  const resetKeybindings = useCallback(() => {
    setSettings((current) => ({
      ...current,
      keybindings: createDefaultApplicationSettings().keybindings,
    }));
  }, []);

  const resetTerminal = useCallback(() => {
    setSettings((current) => ({
      ...current,
      terminal: createDefaultApplicationSettings().terminal,
    }));
  }, []);

  const resetAi = useCallback(() => {
    setSettings((current) => ({ ...current, ai: createDefaultApplicationSettings().ai }));
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(createDefaultApplicationSettings());
  }, []);

  return useMemo(() => ({
    ...settings,
    updateAppearance,
    updateKeybindings,
    updateTerminal,
    updateAi,
    updateWorkspacePreferences,
    resetKeybindings,
    resetTerminal,
    resetAi,
    resetSettings,
  }), [
    resetKeybindings,
    resetTerminal,
    resetAi,
    resetSettings,
    settings,
    updateAppearance,
    updateKeybindings,
    updateTerminal,
    updateAi,
    updateWorkspacePreferences,
  ]);
}
