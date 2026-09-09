import test from "node:test";
import assert from "node:assert/strict";
import { TerminalPresentation } from "./TerminalPresentation.ts";
import { executableQuickCommand } from "./quickCommand.ts";
import { compileTerminalHighlightRules, terminalHighlightRanges } from "./highlighting.ts";

const rule = { id: "up", name: "状态", enabled: true, matchMode: "text", pattern: "UP", color: "#112233", caseSensitive: true };

test("custom commands append exactly one Enter without rewriting multiline text", () => {
  for (const ending of ["\r", "\n", "\r\n"]) {
    const text = `system-view\n display health${ending}`;
    assert.equal(executableQuickCommand(text), text);
  }
  assert.equal(executableQuickCommand("display health"), "display health\r");
  assert.equal(executableQuickCommand("a\nb"), "a\nb\r");
  assert.equal(executableQuickCommand(""), "");
});

test("matching is repeatable after insertion/deletion/replacement and respects ordering", () => {
  const compiled = compileTerminalHighlightRules([rule]);
  for (const text of ["UP", "U", "UP", "DOWN", "UP"]) {
    assert.equal(terminalHighlightRanges(text, compiled).length, text === "UP" ? 1 : 0);
  }
  assert.equal(terminalHighlightRanges("UP", compileTerminalHighlightRules([{ ...rule, color: "#ABCDEF" }, rule]))[0].color, "#ABCDEF");
  assert.equal(terminalHighlightRanges("UP", compileTerminalHighlightRules([{ ...rule, enabled: false }])).length, 0);
});

test("changed rows replace decorations, stable rows do not repaint, and raw cells are untouched", () => {
  let nextFrame = 0;
  const frames = new Map();
  const element = () => ({ classList: { remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, replaceChildren() {}, remove() {}, style: {} });
  globalThis.document = { createElement: element, createDocumentFragment: element };
  globalThis.requestAnimationFrame = (fn) => { frames.set(++nextFrame, fn); return nextFrame; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const drain = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  const callbacks = {};
  let text = "UP";
  const decorations = [];
  const terminal = {
    rows: 1,
    buffer: { active: { type: "normal", baseY: 0, viewportY: 0, cursorY: 0,
      getLine: () => ({ length: text.length, translateToString: () => text, getCell: (x) => ({ getChars: () => text[x], getWidth: () => 1 }) }) } },
    onRender: fn => { callbacks.render = fn; return { dispose() {} }; },
    onLineFeed: fn => { callbacks.line = fn; return { dispose() {} }; },
    onScroll: fn => { callbacks.scroll = fn; return { dispose() {} }; },
    onWriteParsed: fn => { callbacks.write = fn; return { dispose() {} }; },
    registerMarker: (offset = 0) => ({ line: terminal.buffer.active.baseY + terminal.buffer.active.cursorY + offset, isDisposed: false, dispose() { this.isDisposed = true; } }),
    registerDecoration: options => { const entry = { ...options, disposed: false, dispose() { this.disposed = true; } }; decorations.push(entry); return entry; },
  };
  const display = new TerminalPresentation(terminal);
  display.setRules([rule]); drain();
  assert.equal(decorations.length, 1);
  callbacks.render(); drain();
  assert.equal(decorations.length, 1, "decoration-triggered render must not loop");
  text = "U"; callbacks.write(); drain();
  assert.equal(decorations[0].disposed, true);
  text = "UP"; callbacks.write(); drain();
  assert.equal(decorations.length, 2);
  assert.equal(decorations[1].width, 2);
  assert.equal(text, "UP");
  display.toggle(); callbacks.write(); drain();
  assert.equal(display.times.length, 0, "toggle must not timestamp history or current input");
  assert.equal(display.enabled, true, "toggle enables immediately without Enter");
  callbacks.write(); drain();
  assert.equal(display.times.length, 0, "toggle boundary excludes existing text");
  terminal.buffer.active.cursorY = 1;
  callbacks.write(); drain();
  assert.equal(display.times.length, 1);
  assert.equal(display.times[0].marker.line, 1);
  assert.match(display.times[0].time, /^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  callbacks.write(); drain();
  assert.equal(display.times.length, 1, "cursor redraw does not duplicate timestamps");
  display.toggle(); terminal.buffer.active.cursorY = 2; callbacks.write(); drain();
  assert.equal(display.times.length, 1, "disabled output is not stamped");
  display.toggle(); callbacks.write(); drain();
  assert.equal(display.times.length, 1, "re-enabling does not stamp old output");
  terminal.buffer.active.cursorY = 3; callbacks.write(); drain();
  assert.equal(display.times.length, 2, "new output immediately receives timestamps, without Enter");
  display.toggle();
  terminal.buffer.active.cursorY = 4; text = "";
  display.toggle();
  text = "new output without newline"; callbacks.write(); drain();
  assert.equal(display.times.length, 3, "an empty cursor row receives its first new output immediately");
  display.dispose();
  assert.equal(decorations[1].disposed, true);
  delete globalThis.document; delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame;
});
