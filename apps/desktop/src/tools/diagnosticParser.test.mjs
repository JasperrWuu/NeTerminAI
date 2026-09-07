import test from "node:test";
import assert from "node:assert/strict";
import { parseDiagnosticText, decodeDiagnostic, MAX_DIAGNOSTIC_BYTES } from "./diagnosticParser.ts";

const block = (command, body) => `================\n${command}\n===============\n${body}`;
test("headers split commands, preserve duplicate occurrences and all body text", () => {
  const source = "preamble\n" + block("display device", "设备正常\n\n") + block("display version", "V600\n") + block("display device", "last output");
  const sections = parseDiagnosticText(source);
  assert.deepEqual(sections.map(s => s.command), ["display device", "display version", "display device"]);
  assert.equal(new Set(sections.map(s => s.id)).size, 3);
  assert.deepEqual(sections.map(s => source.slice(s.start, s.end)), ["设备正常\n\n", "V600\n", "last output"]);
  assert.equal(sections[0].line, 3);
});
test("CRLF and BOM; ordinary display lines do not split output", () => {
  const source = "\ufeff" + block("display current-configuration", "display this\ntext\n===\nnot a command\n===\n").replaceAll("\n", "\r\n");
  const sections = parseDiagnosticText(source);
  assert.equal(sections.length, 1);
  assert.match(source.slice(sections[0].start), /display this\r\ntext/);
});
test("empty, malformed and empty output are explicit", () => {
  assert.deepEqual(parseDiagnosticText(""), []);
  assert.deepEqual(parseDiagnosticText("display device\noutput"), []);
  assert.deepEqual(parseDiagnosticText("===\ndisplay device\nnot separator"), []);
  assert.equal(parseDiagnosticText(block("display device", ""))[0].start, block("display device", "").length);
});
test("UTF-8, UTF-16 and GB18030 files decode locally", () => {
  const text = block("display device", "中文");
  assert.equal(decodeDiagnostic(new TextEncoder().encode(text).buffer).text, text);
  const utf16 = new Uint8Array(2 + text.length * 2); utf16.set([255, 254]);
  const view = new DataView(utf16.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), true);
  assert.equal(decodeDiagnostic(utf16.buffer).text, text);
  assert.equal(decodeDiagnostic(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]).buffer).text, "中文");
});
test("large output is indexed without truncation and oversize input is rejected", () => {
  const body = "Interface UP\n".repeat(100000);
  const text = block("display interface", body);
  const [section] = parseDiagnosticText(text);
  assert.equal(text.slice(section.start, section.end), body);
  assert.throws(() => decodeDiagnostic(new ArrayBuffer(MAX_DIAGNOSTIC_BYTES + 1)), /32 MB/);
});
