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
    label: "瓷砖排列会话",
    description: "将当前已打开的会话排列为平衡的左右与上下分区，不创建新会话。",
  },
  {
    id: "collapseWorkspace",
    label: "合并所有分区",
    description: "将所有会话收回到一个分区，保留会话标签。",
  },
];

export function keyboardEventToShortcut(event: KeyboardEvent | ReactKeyboardEvent) {
  if (isModifierKey(event.key)) return null;
  const plusKey = isPlusKey(event);
  const equalKey = event.code === "Equal" && (event.key === "=" || event.key === "+");
  const key = equalKey ? "Equal" : normalizeKey(plusKey ? "+" : event.key);
  if (!key) return null;

  const modifiers = [
    event.ctrlKey ? "Ctrl" : null,
    // Preserve the physical Equal key for the tile command. It remains
    // distinct from a user-assigned plus or numpad shortcut.
    event.shiftKey && !plusKey ? "Shift" : null,
    event.altKey ? "Alt" : null,
    event.metaKey ? "Meta" : null,
  ].filter(Boolean);
  if (modifiers.length === 0 && !/^F(?:[1-9]|1[0-2])$/.test(key)) return null;
  return [...modifiers, key].join("+");
}

export function matchesKeyboardShortcut(event: KeyboardEvent, shortcut: string) {
  const parts = shortcutParts(shortcut);
  const key = parts.at(-1);
  if (!key || !hasMatchingModifiers(event, parts)) return false;
  return key === "+" ? isPlusKey(event)
    : key === "-" ? isMinusKey(event)
      : key === "Equal" ? event.code === "Equal"
      : normalizeKey(event.key) === key;
}

export function resolveKeyboardShortcut(event: KeyboardEvent, settings: KeybindingSettings) {
  return keybindingCommands.find((command) => {
    const setting = settings[command.id];
    return setting.enabled && matchesKeyboardShortcut(event, setting.binding);
  }) ?? null;
}

export function shortcutParts(shortcut: string) {
  if (!shortcut) return [];
  // A plus key is also the delimiter, so legacy `Ctrl++` needs one small
  // piece of parsing instead of a plain split (which would drop the key).
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
    (command) => command.id !== commandId
      && settings[command.id].enabled
      && settings[command.id].binding === shortcut,
  ) ?? null;
}

function isModifierKey(key: string) {
  return key === "Control" || key === "Shift" || key === "Alt" || key === "Meta";
}

function hasMatchingModifiers(event: KeyboardEvent, parts: string[]) {
  // Shift is a physical requirement for the main keyboard's `+`, not a
  // separate modifier from the user's point of view. Equal is likewise
  // matched by physical code so keyboard layouts remain predictable.
  const usesPlusKey = parts.at(-1) === "+" && isPlusKey(event);
  const usesEqualKey = parts.at(-1) === "Equal" && event.code === "Equal";
  const expectedShift = parts.includes("Shift");
  const matchesShift = expectedShift ? event.shiftKey : usesPlusKey || usesEqualKey || !event.shiftKey;
  return event.ctrlKey === parts.includes("Ctrl")
    && matchesShift
    && event.altKey === parts.includes("Alt")
    && event.metaKey === parts.includes("Meta");
}

function isPlusKey(event: KeyboardEvent | ReactKeyboardEvent) {
  return event.key === "+"
    || event.key === "Add"
    || event.code === "NumpadAdd"
    || (event.key === "=" && event.shiftKey && event.code === "Equal");
}

function isMinusKey(event: KeyboardEvent) {
  return event.key === "-" || event.key === "Subtract" || event.code === "NumpadSubtract";
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
