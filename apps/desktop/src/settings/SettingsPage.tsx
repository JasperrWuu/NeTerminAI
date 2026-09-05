import type { AppearanceTheme, KeybindingPatch, KeybindingSettings, SettingsSection, TerminalSettings } from "./types";
import { KeyboardShortcutsView } from "./KeyboardShortcutsView";
import { TerminalSettingsView } from "./TerminalSettingsView";

interface SettingsPageProps {
  appearanceTheme: AppearanceTheme;
  keybindings: KeybindingSettings;
  onChangeKeybindings: (settings: KeybindingPatch) => void;
  onChangeTerminal: (settings: Partial<TerminalSettings>) => void;
  onResetKeybindings: () => void;
  onResetTerminal: () => void;
  section: SettingsSection;
  terminal: TerminalSettings;
}

export function SettingsPage({
  appearanceTheme,
  keybindings,
  onChangeKeybindings,
  onChangeTerminal,
  onResetKeybindings,
  onResetTerminal,
  section,
  terminal,
}: SettingsPageProps) {
  return (
    <section aria-label="设置" className="settings-page">
      <div className="settings-page-content" key={section}>
        {section === "terminal" ? (
          <TerminalSettingsView
            appearanceTheme={appearanceTheme}
            onChange={onChangeTerminal}
            onReset={onResetTerminal}
            settings={terminal}
          />
        ) : (
          <KeyboardShortcutsView
            onChange={onChangeKeybindings}
            onReset={onResetKeybindings}
            settings={keybindings}
          />
        )}
      </div>
    </section>
  );
}
