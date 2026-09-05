import assert from "node:assert/strict";
import test from "node:test";
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  LEGACY_SETTINGS_STORAGE_KEY,
  LEGACY_WORKBENCH_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  createDefaultApplicationSettings,
  migrateSettings,
  persistApplicationSettings,
  readApplicationSettings,
} from "./applicationSettings.ts";

class MemoryStorage {
  #values = new Map();

  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
}

test("defaults expose one versioned settings model", () => {
  const settings = createDefaultApplicationSettings();
  assert.equal(settings.keybindings.synchronizeVisibleTerminals.binding, "Ctrl+L");
  assert.equal(settings.keybindings.stopSynchronizedInput.binding, "Ctrl+Shift+L");
  assert.equal(settings.keybindings.insertLocalIpv4.binding, "Ctrl+I");
  assert.equal(settings.schemaVersion, CURRENT_SETTINGS_SCHEMA_VERSION);
  assert.equal(settings.keybindings.balanceWorkspace.binding, "Ctrl+Equal");
  assert.equal(settings.keybindings.balanceWorkspace.enabled, true);
  assert.deepEqual(settings.workspacePreferences, {
    leftSidebarOpen: true,
    rightSidebarOpen: false,
    leftSidebarWidth: 260,
    rightSidebarWidth: 320,
  });
});

test("legacy settings migrate bindings, workspace preferences and partial fields", () => {
  const settings = migrateSettings({
    appearance: { theme: "light" },
    terminal: {
      fontSize: "bad",
      fontFamily: '"JetBrains Mono", monospace',
      colorScheme: "paper",
    },
    keybindings: {
      synchronizeVisibleTerminals: "Ctrl+L",
      stopSynchronizedInput: "Ctrl+Shift+L",
      balanceWorkspace: "Ctrl++",
      collapseWorkspace: { binding: "Ctrl+-", enabled: false },
    },
  }, {
    leftSidebarOpen: false,
    leftSidebarWidth: 410,
  });

  assert.equal(settings.schemaVersion, CURRENT_SETTINGS_SCHEMA_VERSION);
  assert.equal(settings.terminal.fontFamilyLatin, "JetBrains Mono");
  assert.equal(settings.terminal.fontSize, 14);
  assert.equal(settings.keybindings.synchronizeVisibleTerminals.binding, "Ctrl+L");
  assert.equal(settings.keybindings.synchronizeVisibleTerminals.enabled, true);
  assert.equal(settings.keybindings.stopSynchronizedInput.binding, "Ctrl+Shift+L");
  assert.equal(settings.keybindings.insertLocalIpv4.binding, "Ctrl+I");
  assert.equal(settings.keybindings.balanceWorkspace.binding, "Ctrl+Equal");
  assert.equal(settings.keybindings.collapseWorkspace.enabled, false);
  assert.equal(settings.workspacePreferences.leftSidebarOpen, false);
  assert.equal(settings.workspacePreferences.leftSidebarWidth, 410);
  assert.equal(settings.workspacePreferences.rightSidebarWidth, 320);
});

test("migration preserves explicit shortcut customizations", () => {
  const settings = migrateSettings({
    keybindings: {
      synchronizeVisibleTerminals: { binding: "Alt+L", enabled: false },
      stopSynchronizedInput: { binding: "Alt+Shift+L" },
      insertLocalIpv4: { binding: "Ctrl+Alt+I" },
    },
  });
  assert.equal(settings.keybindings.synchronizeVisibleTerminals.binding, "Alt+L");
  assert.equal(settings.keybindings.synchronizeVisibleTerminals.enabled, false);
  assert.equal(settings.keybindings.stopSynchronizedInput.binding, "Alt+Shift+L");
  assert.equal(settings.keybindings.insertLocalIpv4.binding, "Ctrl+Alt+I");
});

test("migration is deterministic and safe for malformed or unknown data", () => {
  const first = migrateSettings({
    schemaVersion: 999,
    unknown: { value: true },
    terminal: { highlightSets: [{ id: "bad", rules: [] }] },
  });
  assert.deepEqual(first, migrateSettings(first));
  assert.equal(migrateSettings("not an object").schemaVersion, CURRENT_SETTINGS_SCHEMA_VERSION);
  assert.equal(migrateSettings(null).terminal.fontSize, 14);
});

test("read and persist migrate storage without touching connection library keys", () => {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_SETTINGS_STORAGE_KEY, JSON.stringify({
    terminal: { fontSize: 18 },
    keybindings: { collapseWorkspace: "Ctrl+-" },
  }));
  storage.setItem(LEGACY_WORKBENCH_STORAGE_KEY, JSON.stringify({ rightSidebarOpen: true }));
  storage.setItem("neterminai.connection-library.v3", "keep me");
  globalThis.localStorage = storage;

  const loaded = readApplicationSettings();
  assert.equal(loaded.terminal.fontSize, 18);
  assert.equal(loaded.workspacePreferences.rightSidebarOpen, true);
  loaded.keybindings.collapseWorkspace.enabled = false;
  persistApplicationSettings(loaded);

  assert.ok(storage.getItem(SETTINGS_STORAGE_KEY));
  assert.equal(storage.getItem(LEGACY_SETTINGS_STORAGE_KEY), null);
  assert.equal(storage.getItem(LEGACY_WORKBENCH_STORAGE_KEY), null);
  assert.equal(storage.getItem("neterminai.connection-library.v3"), "keep me");
  assert.equal(readApplicationSettings().keybindings.collapseWorkspace.enabled, false);
});
