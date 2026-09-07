import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultHighlightSets } from "./defaultHighlightSets.ts";
import { migrateSettings } from "./applicationSettings.ts";

test("dark and light presets share six semantic rules with distinct palettes", () => {
  const [dark, light] = createDefaultHighlightSets();
  assert.equal(dark.rules.length, 6);
  assert.deepEqual(dark.rules.map(r => r.pattern), light.rules.map(r => r.pattern));
  for (let i = 0; i < 6; i++) {
    assert.notEqual(dark.rules[i].color, light.rules[i].color);
    assert.ok(!new RegExp(dark.rules[i].pattern).test(""));
  }
  assert.ok(new RegExp(dark.rules[0].pattern, "i").test("Interface DOWN"));
  assert.ok(new RegExp(dark.rules[3].pattern).test("90.32.106.121"));
});
test("pristine empty default upgrades; existing custom rules survive", () => {
  const upgraded = migrateSettings({ schemaVersion: 4, terminal: { activeHighlightSetId: "default-highlight-set", highlightSets: [{ id: "default-highlight-set", name: "默认突显集", enabled: true, rules: [] }] } });
  assert.equal(upgraded.terminal.highlightSets.length, 2);
  assert.equal(upgraded.terminal.activeHighlightSetId, "builtin-dark");
  const custom = { id: "mine", name: "我的", enabled: true, rules: [] };
  const settings = migrateSettings({ schemaVersion: 4, terminal: { activeHighlightSetId: "mine", highlightSets: [custom] } });
  assert.deepEqual(settings.terminal.highlightSets[0], custom);
  assert.equal(settings.terminal.activeHighlightSetId, "mine");
  settings.terminal.highlightSets = [custom];
  assert.equal(migrateSettings(settings).terminal.highlightSets.length, 1, "deleted presets must not be reinserted on every load");
});
