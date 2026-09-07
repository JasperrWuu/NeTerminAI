export interface DiagnosticSection {
  id: string;
  command: string;
  line: number;
  start: number;
  end: number;
}
export interface DiagnosticDocument {
  text: string;
  encoding: string;
  sections: DiagnosticSection[];
}
export const MAX_DIAGNOSTIC_BYTES = 32 * 1024 * 1024;

/** Offsets reference one source string; command bodies are not duplicated. */
export function parseDiagnosticText(text: string): DiagnosticSection[] {
  const sections: DiagnosticSection[] = [];
  let previous: { start: number; separator: boolean } | undefined;
  let pending: { command: string; line: number; headerStart: number } | undefined;
  let offset = 0;
  let line = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const end = newline < 0 ? text.length : newline;
    const next = newline < 0 ? text.length : newline + 1;
    const value = text.slice(offset, end).trim();
    const separator = /^\\?={3,}$/.test(value);
    line++;
    if (pending && separator) {
      if (sections.length) sections[sections.length - 1].end = pending.headerStart;
      sections.push({ id: `command-${pending.headerStart}`, command: pending.command,
        line: pending.line, start: next, end: text.length });
    }
    pending = previous?.separator && /^display\s+\S/i.test(value)
      ? { command: value, line, headerStart: previous.start } : undefined;
    previous = { start: offset, separator };
    offset = next;
  }
  return sections;
}

export function decodeDiagnostic(buffer: ArrayBuffer): DiagnosticDocument {
  if (buffer.byteLength > MAX_DIAGNOSTIC_BYTES) throw new Error("文件超过 32 MB，请先拆分后导入。");
  const bytes = new Uint8Array(buffer);
  let encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch {
    if (encoding !== "utf-8") throw new Error("文件编码无法读取。");
    encoding = "gb18030";
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  }
  return { text, encoding, sections: parseDiagnosticText(text) };
}
