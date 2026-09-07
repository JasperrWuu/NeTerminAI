import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultApplicationSettings, migrateSettings } from "./applicationSettings.ts";
import {
  findKeybindingConflict,
  resolveKeyboardShortcut,
} from "./keybindings.ts";

function keyEvent({ key, code = key, ctrlKey = false, shiftKey = false, altKey = false, metaKey = false }) {
  return { key, code, ctrlKey, shiftKey, altKey, metaKey };
}

test("Telnet and close use distinct customizable default shortcuts", () => {
  const { keybindings } = createDefaultApplicationSettings();
  assert.equal(resolveKeyboardShortcut(keyEvent({ key: "n", ctrlKey: true }), keybindings)?.id, "newTelnetSession");
  assert.equal(resolveKeyboardShortcut(keyEvent({ key: "N", ctrlKey: true, shiftKey: true }), keybindings)?.id, "closeCurrentSession");
  assert.equal(findKeybindingConflict(keybindings, "newTelnetSession", "Ctrl+N"), null);
  const migrated = migrateSettings({ schemaVersion: 5, keybindings: {
    insertLocalIpv4: { binding: "Ctrl+N", enabled: true },
  } });
  assert.equal(migrated.keybindings.newTelnetSession.enabled, false);
  assert.equal(resolveKeyboardShortcut(keyEvent({ key: "n", ctrlKey: true }), migrated.keybindings)?.id, "insertLocalIpv4");
  assert.equal(migrateSettings({ keybindings: { newTelnetSession: { binding: "Ctrl+Alt+T", enabled: true } } }).keybindings.newTelnetSession.binding, "Ctrl+Alt+T");
});

test("enabled Ctrl+Equal resolves to tile layout", () => {
  const settings = createDefaultApplicationSettings();
  const command = resolveKeyboardShortcut(
    keyEvent({ key: "=", code: "Equal", ctrlKey: true }),
    settings.keybindings,
  );
  assert.equal(command?.id, "balanceWorkspace");
});

test("default synchronized input shortcuts resolve without conflict", () => {
  const settings = createDefaultApplicationSettings();
  assert.equal(
    resolveKeyboardShortcut(keyEvent({ key: "l", code: "KeyL", ctrlKey: true }), settings.keybindings)?.id,
    "synchronizeVisibleTerminals",
  );
  assert.equal(
    resolveKeyboardShortcut(keyEvent({ key: "l", code: "KeyL", ctrlKey: true, shiftKey: true }), settings.keybindings)?.id,
    "stopSynchronizedInput",
  );
  assert.equal(
    resolveKeyboardShortcut(keyEvent({ key: "i", code: "KeyI", ctrlKey: true }), settings.keybindings)?.id,
    "insertLocalIpv4",
  );
});

test("disabled shortcut keeps its binding but is not resolved", () => {
  const settings = createDefaultApplicationSettings();
  settings.keybindings.balanceWorkspace.enabled = false;
  assert.equal(settings.keybindings.balanceWorkspace.binding, "Ctrl+Equal");
  assert.equal(
    resolveKeyboardShortcut(keyEvent({ key: "=", code: "Equal", ctrlKey: true }), settings.keybindings),
    null,
  );
});

test("terminal Ctrl+C is not consumed by application shortcuts", () => {
  const settings = createDefaultApplicationSettings();
  assert.equal(
    resolveKeyboardShortcut(keyEvent({ key: "c", code: "KeyC", ctrlKey: true }), settings.keybindings),
    null,
  );
});

test("conflicts only consider enabled shortcuts", () => {
  const settings = createDefaultApplicationSettings();
  settings.keybindings.balanceWorkspace.enabled = false;
  assert.equal(
    findKeybindingConflict(settings.keybindings, "collapseWorkspace", "Ctrl+Equal"),
    null,
  );
  settings.keybindings.balanceWorkspace.enabled = true;
  assert.equal(
    findKeybindingConflict(settings.keybindings, "collapseWorkspace", "Ctrl+Equal")?.id,
    "balanceWorkspace",
  );
});
