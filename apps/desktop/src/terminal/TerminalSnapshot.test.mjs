import assert from "node:assert/strict";
import test from "node:test";
import {
  captureTerminalSnapshot,
  captureTerminalText,
} from "./TerminalSnapshot.ts";

function fakeBuffer(lines) {
  return {
    length: lines.length,
    getLine(index) {
      const line = lines[index];
      return line ? {
        isWrapped: line.wrapped ?? false,
        translateToString: () => line.text,
      } : undefined;
    },
  };
}

test("snapshot extraction preserves blank lines and joins wrapped rows", () => {
  const buffer = fakeBuffer([
    { text: "first" },
    { text: "hello ", wrapped: false },
    { text: "world", wrapped: true },
    { text: "" },
    { text: "last" },
  ]);
  assert.equal(captureTerminalText(buffer), "first\nhello world\n\nlast");
});

test("snapshot extraction keeps the newest bounded logical lines", () => {
  const buffer = fakeBuffer([
    { text: "one" },
    { text: "two" },
    { text: "three" },
    { text: "four" },
  ]);
  assert.equal(captureTerminalText(buffer, { maxLines: 2, maxChars: 100 }), "three\nfour");
});

test("snapshot extraction truncates by Unicode code points and keeps the tail", () => {
  assert.equal(
    captureTerminalText(fakeBuffer([{ text: "old 😀 newest" }]), { maxLines: 5, maxChars: 6 }),
    "…ewest",
  );
  assert.equal(
    captureTerminalText(fakeBuffer([{ text: "ab😀cd" }]), { maxLines: 5, maxChars: 4 }),
    "…😀cd",
  );
});

test("terminal snapshot includes size and optional selection without mutating the terminal", () => {
  let selectionReads = 0;
  const snapshot = captureTerminalSnapshot({
    cols: 120,
    rows: 40,
    buffer: { active: fakeBuffer([{ text: "output" }]) },
    getSelection: () => {
      selectionReads += 1;
      return "selected";
    },
  }, "session-1");
  assert.deepEqual(snapshot, {
    sessionId: "session-1",
    cols: 120,
    rows: 40,
    recentText: "output",
    selection: "selected",
  });
  assert.equal(selectionReads, 1);
});
