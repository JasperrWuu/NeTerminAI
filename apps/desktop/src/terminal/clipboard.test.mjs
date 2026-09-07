import test from "node:test";
import assert from "node:assert/strict";
import { resolveTerminalClipboardAction } from "./clipboard.ts";

const key = { key: "v", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
test("one Ctrl+V press has one paste action across xterm keydown/keyup callbacks", () => {
  const actions = ["keydown", "keyup"].map(type => resolveTerminalClipboardAction({ ...key, type }, false));
  assert.deepEqual(actions, ["paste", null]);
});
test("copy keeps selection semantics and alternate paste shortcuts", () => {
  assert.equal(resolveTerminalClipboardAction({ ...key, key: "c", type: "keydown" }, false), null);
  assert.equal(resolveTerminalClipboardAction({ ...key, key: "c", type: "keydown" }, true), "copy");
  assert.equal(resolveTerminalClipboardAction({ ...key, key: "Insert", ctrlKey: false, shiftKey: true, type: "keydown" }, false), "paste");
});
