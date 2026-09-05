import assert from "node:assert/strict";
import test from "node:test";
import {
  ContextProcessingPipeline,
  SessionContextMemoryStore,
  normalizeContextSnapshot,
} from "./contextPipeline.ts";

function snapshot(tabId, sessionId, recentText, state = "connected") {
  return {
    version: 1,
    capturedAt: 1,
    tabId,
    sessionId,
    title: tabId.toUpperCase(),
    connectionKind: "telnet",
    connectionState: state,
    target: { tabId, sessionId },
    connection: { kind: "telnet", host: `192.0.2.${tabId === "a" ? 1 : 2}`, port: 23 },
    terminal: { sessionId, cols: 100, rows: 30, recentText },
  };
}

test("normalization trims terminal padding, preserves prompt and redacts obvious secrets", () => {
  const normalized = normalizeContextSnapshot(snapshot(
    "a",
    "s1",
    "prompt>\npassword: super-secret   \nERROR: failed   ",
  ));
  assert.equal(normalized.recentOutput, "prompt>\npassword: [redacted]\nERROR: failed");
});

test("memory is isolated by tab and resets on a new runtime identity", () => {
  const store = new SessionContextMemoryStore();
  const first = store.prepare(normalizeContextSnapshot(snapshot("a", "s1", "one")));
  store.commit({ ...first, summary: "old facts", stale: false });
  const reconnect = store.prepare(normalizeContextSnapshot(snapshot("a", "s2", "new")));
  assert.equal(reconnect.sessionId, "s2");
  assert.equal(reconnect.stale, true);
  assert.deepEqual(reconnect.importantFacts, []);
  store.reconcile(["b"]);
  assert.equal(store.get("a"), undefined);
});

test("memory facts and events remain bounded", () => {
  const store = new SessionContextMemoryStore();
  const context = normalizeContextSnapshot(snapshot("a", "s1", "output"));
  const initial = store.prepare(context);
  store.commit({
    ...initial,
    summary: "x".repeat(3000),
    importantFacts: Array.from({ length: 40 }, (_, index) => `fact-${index}`),
    recentEvents: Array.from({ length: 40 }, (_, index) => `event-${index}`),
  });
  const bounded = store.get("a");
  assert.equal(bounded.importantFacts.length, 24);
  assert.equal(bounded.recentEvents.length, 24);
  assert.ok(bounded.summary.length <= 2048);
});

test("pipeline returns labeled structured sessions instead of concatenating terminals", () => {
  const contexts = [snapshot("a", "s1", "FW1 output"), snapshot("b", "s2", "FW2 output")];
  const fakeProvider = {
    getContexts: () => contexts,
    getActiveContext: () => contexts[0],
    listSessions: () => [{ tabId: "a" }, { tabId: "b" }],
    listOwnedTerminalIds: () => ["a", "b"],
  };
  const pipeline = new ContextProcessingPipeline(fakeProvider);
  const result = pipeline.capture({ scope: "selected", selectedTabIds: ["a", "b"] });
  assert.equal(result.version, 1);
  assert.equal(result.activeTabId, "a");
  assert.deepEqual(result.sessions.map((session) => session.target), [
    { tabId: "a", sessionId: "s1" },
    { tabId: "b", sessionId: "s2" },
  ]);
  assert.equal(result.sessions[0].recentOutput, "FW1 output");
  assert.equal(result.sessions[1].recentOutput, "FW2 output");
  assert.notEqual(result.sessions[0].memory, result.sessions[1].memory);
});

test("pipeline carries the active project's persistent context", () => {
  const contexts = [snapshot("a", "s1", "FW1 output")];
  const fakeProvider = {
    getContexts: () => contexts,
    getActiveContext: () => contexts[0],
    listSessions: () => [{ tabId: "a" }],
    listOwnedTerminalIds: () => ["a"],
  };
  const projectContext = {
    goal: "验证 NAT64",
    topology: "PC6 → FW1",
    keyConfigurations: [],
    confirmedFacts: [],
    progress: "进行中",
    issues: [],
    conclusions: [],
    nextSteps: ["验证 TCP"],
    updatedAt: 100,
  };
  const pipeline = new ContextProcessingPipeline(fakeProvider, undefined, undefined, () => projectContext);
  assert.deepEqual(pipeline.capture({ scope: "active", selectedTabIds: [] }).projectContext, projectContext);
});
