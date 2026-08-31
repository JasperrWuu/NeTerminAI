export type TerminalClipboardAction = "copy" | "paste";

type ClipboardKeyEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">;

export function resolveTerminalClipboardAction(
  event: ClipboardKeyEvent,
  hasSelection: boolean,
): TerminalClipboardAction | null {
  const key = event.key.toLowerCase();
  const primaryModifier = event.ctrlKey || event.metaKey;

  if (!event.altKey && primaryModifier && key === "c") {
    return hasSelection ? "copy" : null;
  }
  if (!event.altKey && primaryModifier && key === "v") return "paste";
  if (!event.altKey && event.ctrlKey && key === "insert") {
    return hasSelection ? "copy" : null;
  }
  if (!event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && key === "insert") {
    return "paste";
  }
  return null;
}

