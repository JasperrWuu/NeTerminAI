import type { AiSettings, AppearanceTheme, KeybindingPatch, KeybindingSettings, SettingsSection, TerminalSettings } from "./types";
import { AiSettingsView } from "./AiSettingsView";
import { KeyboardShortcutsView } from "./KeyboardShortcutsView";
import { TerminalSettingsView } from "./TerminalSettingsView";

interface SettingsPageProps {
  appearanceTheme: AppearanceTheme;
  keybindings: KeybindingSettings;
  onChangeKeybindings: (settings: KeybindingPatch) => void;
  onChangeTerminal: (settings: Partial<TerminalSettings>) => void;
  ai: AiSettings;
  onChangeAi: (settings: Partial<AiSettings>) => void;
  onResetAi: () => void;
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
  ai,
  onChangeAi,
  onResetAi,
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
        ) : section === "keyboard" ? (
          <KeyboardShortcutsView
            onChange={onChangeKeybindings}
            onReset={onResetKeybindings}
            settings={keybindings}
          />
        ) : (
          <AiSettingsView onChange={onChangeAi} onReset={onResetAi} settings={ai} />
        )}
      </div>
    </section>
  );
}
