/** Preserve multiline payloads and an existing terminal line ending. */
export function executableQuickCommand(text: string): string {
  return !text || /[\r\n]$/.test(text) ? text : `${text}\r`;
}
