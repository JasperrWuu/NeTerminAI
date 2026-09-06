import assert from "node:assert/strict";
import test from "node:test";
import {
  createAutomationScript,
  normalizeAutomationTarget,
  readAutomationScripts,
} from "./automationDraft.ts";

test("automation drafts default to an active terminal and usable Python", () => {
  const script = createAutomationScript(2);
  assert.equal(script.name, "脚本 2");
  assert.deepEqual(script.target, { mode: "active" });
  assert.match(script.code, /send\(/u);
  assert.match(script.code, /print\(output\)/u);
});

test("automation target drafts keep logical tab identities and remove duplicates", () => {
  assert.deepEqual(
    normalizeAutomationTarget({ mode: "sessions", tabIds: ["tab-1", " tab-1 ", "tab-2", 42] }),
    { mode: "sessions", tabIds: ["tab-1", "tab-2"] },
  );
  assert.deepEqual(
    normalizeAutomationTarget({ mode: "sessions", sessionIds: ["legacy-tab"] }),
    { mode: "sessions", tabIds: ["legacy-tab"] },
  );
});

test("malformed or unavailable storage falls back to one safe draft", () => {
  assert.equal(readAutomationScripts().length, 1);
  assert.equal(readAutomationScripts()[0].target.mode, "active");
});
