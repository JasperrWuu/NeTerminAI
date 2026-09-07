import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultHighlightSets } from "./defaultHighlightSets.ts";
import { migrateSettings } from "./applicationSettings.ts";

test("dark and light presets share twelve named semantic rules with distinct palettes", () => {
  const [dark, light] = createDefaultHighlightSets();
  assert.equal(dark.rules.length, 12);
  assert.deepEqual(dark.rules.map(r => r.pattern), light.rules.map(r => r.pattern));
  for (let i = 0; i < dark.rules.length; i++) {
    assert.ok(dark.rules[i].name.length > 0);
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

test("v5 rules acquire names and additional fields without losing user edits", () => {
  const [dark] = createDefaultHighlightSets();
  const old = { ...dark, name: "夜色 · 暗色", rules: dark.rules.slice(0, 6).map(({ name, ...rule }) => rule) };
  old.rules[0].color = "#ABCDEF";
  const result = migrateSettings({ schemaVersion: 5, terminal: { highlightSets: [old], activeHighlightSetId: old.id } });
  const upgraded = result.terminal.highlightSets[0];
  assert.equal(upgraded.name, "墨夜 · 网络诊断");
  assert.equal(upgraded.rules.length, 12);
  assert.equal(upgraded.rules[0].color, "#ABCDEF");
  assert.equal(upgraded.rules[0].name, "故障与拒绝");
  upgraded.rules[0].name = "链路告警";
  upgraded.rules.pop();
  const restored = migrateSettings(result).terminal.highlightSets[0];
  assert.equal(restored.rules[0].name, "链路告警");
  assert.equal(restored.rules.length, 11);
});

test("extended fields match Huawei output without painting ordinary prose", () => {
  const rules = createDefaultHighlightSets()[0].rules;
  for (const [suffix, sample] of [["mac", "00e0-fc12-3456"], ["protocol", "BGP"], ["time", "23:59:01"], ["percentage", "45.5%"], ["capacity", "1000 Mbps"], ["version", "V600R007C20SPC100"]]) {
    const rule = rules.find(r => r.id.endsWith(`-${suffix}`));
    assert.ok(new RegExp(rule.pattern, "i").test(sample));
    assert.equal(new RegExp(rule.pattern, "i").test("ordinary output"), false);
  }
});
