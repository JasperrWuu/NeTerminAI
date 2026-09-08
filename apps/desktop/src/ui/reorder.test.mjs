import test from "node:test";
import assert from "node:assert/strict";
import { moveItem } from "./reorder.ts";
import { createDefaultApplicationSettings, migrateSettings } from "../settings/applicationSettings.ts";
test("reordering preserves objects, contents, enable state and persisted order", () => {
  const settings = createDefaultApplicationSettings();
  const rules = settings.terminal.highlightSets[0].rules;
  const reordered = moveItem(rules, 0, rules.length - 1);
  assert.equal(reordered.at(-1), rules[0]);
  assert.deepEqual(new Set(reordered), new Set(rules));
  settings.terminal.highlightSets[0].rules = reordered;
  assert.deepEqual(migrateSettings(JSON.parse(JSON.stringify(settings))).terminal.highlightSets[0].rules, reordered);
  assert.deepEqual(moveItem(rules, 0, -1), rules);
});
