import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { KeybindingCommandId, KeybindingSettings } from "./types";

export interface KeybindingCommand {
  id: KeybindingCommandId;
  label: string;
  description: string;
}

export const keybindingCommands: KeybindingCommand[] = [
  {
    id: "synchronizeVisibleTerminals",
    label: "开启可见终端同步输入",
    description: "将当前输入同时发送到所有分区中可见的字符终端。",
  },
  {
    id: "stopSynchronizedInput",
    label: "关闭同步输入",
    description: "停止广播输入，并将输入焦点交还当前终端。",
  },
  {
    id: "focusNextSession",
    label: "切换到下一个会话",
    description: "按照会话创建顺序循环切换当前会话。",
  },
  {
    id: "balanceWorkspace",
    label: "均衡分布所有会话",
    description: "将所有会话均匀铺开，并交替使用左右与上下分区。",
  },
  {
    id: "collapseWorkspace",
    label: "合并所有分区",
    description: "将所有会话收回到一个分区，保留会话标签。",
  },
];

export function keyboardEventToShortcut(event: KeyboardEvent | ReactKeyboardEvent) {
  if (isModifierKey(event.key)) return null;
  const plusKey = event.key === "+"
    || event.key === "Add"
    || event.code === "NumpadAdd"
    || (event.key === "=" && event.shiftKey && event.code === "Equal");
  const key = normalizeKey(plusKey ? "+" : event.key);
  if (!key) return null;

  const modifiers = [
    event.ctrlKey ? "Ctrl" : null,
    // On most keyboards `+` is produced with Shift+`=`, but users think of
    // that gesture as Ctrl++. Keep the recorded shortcut compact and make it
    // work for both the main keyboard and the numpad plus key.
    event.shiftKey && !plusKey ? "Shift" : null,
    event.altKey ? "Alt" : null,
    event.metaKey ? "Meta" : null,
  ].filter(Boolean);
  if (modifiers.length === 0 && !/^F(?:[1-9]|1[0-2])$/.test(key)) return null;
  return [...modifiers, key].join("+");
}

export function matchesKeyboardShortcut(event: KeyboardEvent, shortcut: string) {
  const normalized = keyboardEventToShortcut(event);
  return Boolean(shortcut && normalized === shortcut);
}

export function shortcutParts(shortcut: string) {
  if (!shortcut) return [];
  // A plus key is also the delimiter, so `Ctrl++` needs one small piece of
  // parsing instead of a plain split (which would drop the final key).
  if (shortcut.endsWith("+")) {
    return [...shortcut.slice(0, -1).split("+").filter(Boolean), "+"];
  }
  return shortcut.split("+").filter(Boolean);
}

export function isTerminalControlShortcut(shortcut: string) {
  const parts = shortcutParts(shortcut);
  const key = parts.at(-1) ?? "";
  return parts.includes("Ctrl")
    && !parts.includes("Alt")
    && !parts.includes("Meta")
    && /^[A-Z]$/.test(key);
}

export function findKeybindingConflict(
  settings: KeybindingSettings,
  commandId: KeybindingCommandId,
  shortcut: string,
) {
  if (!shortcut) return null;
  return keybindingCommands.find(
    (command) => command.id !== commandId && settings[command.id] === shortcut,
  ) ?? null;
}

function isModifierKey(key: string) {
  return key === "Control" || key === "Shift" || key === "Alt" || key === "Meta";
}

function normalizeKey(key: string) {
  const names: Record<string, string> = {
    " ": "Space",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    ArrowUp: "Up",
    Esc: "Escape",
  };
  if (names[key]) return names[key];
  return key.length === 1 ? key.toUpperCase() : key;
}
