import { useState } from "react";
import type { KeyboardEvent } from "react";
import {
  findKeybindingConflict,
  isTerminalControlShortcut,
  keyboardEventToShortcut,
  keybindingCommands,
  shortcutParts,
} from "./keybindings";
import type { KeybindingCommandId, KeybindingSettings } from "./types";
import { CloseIcon } from "../workbench/icons";

interface KeyboardShortcutsViewProps {
  settings: KeybindingSettings;
  onChange: (settings: Partial<KeybindingSettings>) => void;
  onOpenTerminalSettings: () => void;
  onReset: () => void;
}

interface KeybindingMessage {
  text: string;
  tone: "error" | "warning";
}

export function KeyboardShortcutsView({
  settings,
  onChange,
  onOpenTerminalSettings,
  onReset,
}: KeyboardShortcutsViewProps) {
  const [recording, setRecording] = useState<KeybindingCommandId | null>(null);
  const [messages, setMessages] = useState<Partial<Record<KeybindingCommandId, KeybindingMessage>>>({});

  const recordShortcut = (commandId: KeybindingCommandId, event: KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      setRecording(null);
      setMessages((current) => ({ ...current, [commandId]: undefined }));
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete")
      && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
      onChange({ [commandId]: "" });
      setRecording(null);
      setMessages((current) => ({ ...current, [commandId]: undefined }));
      return;
    }

    const shortcut = keyboardEventToShortcut(event);
    if (!shortcut) {
      setMessages((current) => ({
        ...current,
        [commandId]: { text: "请使用带修饰键的组合键，或 F1–F12。", tone: "error" },
      }));
      return;
    }
    const conflict = findKeybindingConflict(settings, commandId, shortcut);
    if (conflict) {
      setMessages((current) => ({
        ...current,
        [commandId]: { text: `已用于“${conflict.label}”。`, tone: "error" },
      }));
      return;
    }

    onChange({ [commandId]: shortcut });
    setRecording(null);
    setMessages((current) => ({
      ...current,
      [commandId]: isTerminalControlShortcut(shortcut)
        ? { text: "会覆盖远端终端的同名 Ctrl 控制输入。", tone: "warning" }
        : undefined,
    }));
  };

  return (
    <section className="settings-view" aria-label="键盘快捷键">
      <div className="settings-scroll-area">
        <header className="settings-heading">
          <div>
            <p className="settings-eyebrow">操作与效率</p>
            <h1>键盘快捷键</h1>
            <p>为工作台命令录制自己的组合键。点击快捷键后直接按下新的组合键。</p>
          </div>
          <div className="settings-heading-actions">
            <button className="secondary-button" onClick={onOpenTerminalSettings} type="button">终端设置</button>
            <button className="secondary-button" onClick={onReset} type="button">恢复默认</button>
          </div>
        </header>

        <div className="settings-layout">
          <section className="settings-group">
            <h2>工作台命令</h2>
            <div className="settings-card keybinding-list">
              {keybindingCommands.map((command) => {
                const shortcut = settings[command.id];
                const isRecording = recording === command.id;
                return (
                  <div className="keybinding-row" key={command.id}>
                    <span className="keybinding-command-copy">
                      <strong>{command.label}</strong>
                      <small>{command.description}</small>
                    </span>
                    <div className="keybinding-editor">
                      <button
                        aria-label={`修改${command.label}`}
                        className="keybinding-recorder"
                        data-keybinding-recorder="true"
                        data-recording={isRecording}
                        onBlur={() => setRecording((current) => current === command.id ? null : current)}
                        onClick={() => {
                          setRecording(command.id);
                          setMessages((current) => ({ ...current, [command.id]: undefined }));
                        }}
                        onKeyDown={(event) => recordShortcut(command.id, event)}
                        type="button"
                      >
                        {isRecording ? (
                          <span className="keybinding-recording-label"><i />请按下组合键</span>
                        ) : shortcut ? (
                          <ShortcutKeys shortcut={shortcut} />
                        ) : (
                          <span className="keybinding-empty-label">未分配</span>
                        )}
                      </button>
                      <button
                        aria-label={`清除${command.label}快捷键`}
                        className="keybinding-clear-button"
                        disabled={!shortcut}
                        onClick={() => {
                          onChange({ [command.id]: "" });
                          setMessages((current) => ({ ...current, [command.id]: undefined }));
                        }}
                        type="button"
                      ><CloseIcon /></button>
                      {messages[command.id] && (
                        <small
                          aria-live="polite"
                          className="keybinding-message"
                          data-tone={messages[command.id]?.tone}
                        >
                          {messages[command.id]?.text}
                        </small>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="keybinding-help">
              录制时按 Esc 取消，按 Backspace 或 Delete 清除。单独的 Ctrl + 字母通常属于远端终端，请谨慎覆盖。
            </p>
          </section>
        </div>
      </div>
    </section>
  );
}

function ShortcutKeys({ shortcut }: { shortcut: string }) {
  return (
    <span className="shortcut-keys">
      {shortcutParts(shortcut).map((part) => <kbd key={part}>{part}</kbd>)}
    </span>
  );
}
