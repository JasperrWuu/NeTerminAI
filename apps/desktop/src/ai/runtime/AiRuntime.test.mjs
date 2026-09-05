import assert from "node:assert/strict";
import test from "node:test";
import { ApiAiProvider } from "./../providers/ApiAiProvider.ts";
import { ProcessAiProvider } from "./../providers/ProcessAiProvider.ts";
import { AiAssistant } from "./AiAssistant.ts";

function assembly() {
  const session = (tabId, title, recentOutput) => ({
    target: { tabId, sessionId: `${tabId}-session` },
    title,
    connectionKind: "telnet",
    connectionState: "connected",
    connection: { kind: "telnet", host: `${tabId}.example`, port: 23 },
    memory: { tabId, sessionId: `${tabId}-session`, summary: "", importantFacts: [], recentEvents: [], lastUpdatedAt: 0, stale: false },
    recentOutput,
  });
  return { version: 1, capturedAt: Date.now(), activeTabId: "fw1", sessions: [session("fw1", "FW1", "display version"), session("fw2", "FW2", "display route")] };
}

test("API provider maps separated session context and decodes streamed response", async () => {
  let request;
  const responseMock = async (_url, init) => {
    request = JSON.parse(init.body);
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '{"diagnosis":"FW2 down","evidence":[],"suggestedChecks":[],"proposals":[]}' } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    return { ok: true, status: 200, body: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }) };
  };
  const provider = new ApiAiProvider({ baseUrl: "https://example.test/v1", model: "test" }, responseMock);
  const tokens = [];
  const result = await provider.analyze({ context: assembly(), question: "compare", }, { onToken: (token) => tokens.push(token) });
  assert.equal(result.diagnosis, "FW2 down");
  assert.equal(tokens.length, 1);
  assert.match(request.messages.at(-1).content, /FW1/);
  assert.match(request.messages.at(-1).content, /FW2/);
});

test("process provider keeps process runner separate and maps stdin/stdout", async () => {
  const calls = [];
  const runner = {
    async run(request) { calls.push(request); return { stdout: '{"diagnosis":"ok","evidence":[],"suggestedChecks":[],"proposals":[]}', stderr: "diagnostic", exitCode: 0, cancelled: false, timedOut: false }; },
    async cancel() {},
  };
  const provider = new ProcessAiProvider({ mode: "process", preset: "custom", baseUrl: "", model: "", temperature: 0.2, executable: "tool.exe", scriptPath: "", arguments: ["--json"], cwd: "", timeoutMs: 10_000 }, runner);
  const result = await provider.analyze({ context: assembly(), question: "status" });
  assert.equal(result.diagnosis, "ok");
  assert.equal(calls[0].executable, "tool.exe");
  assert.deepEqual(calls[0].args, ["--json"]);
  assert.match(calls[0].stdin, /FW1/);
});

test("assistant captures latest selected contexts on every send", async () => {
  let output = "first";
  const providerContext = {
    listSessions: () => [{ tabId: "fw1", title: "FW1", connectionKind: "telnet", connectionState: "connected", connection: { kind: "telnet", host: "fw1", port: 23 } }, { tabId: "fw2", title: "FW2", connectionKind: "telnet", connectionState: "connected", connection: { kind: "telnet", host: "fw2", port: 23 } }],
    getActiveContext: () => null,
    getContexts: () => [{ target: { tabId: "fw1", sessionId: "s1" }, title: "FW1", connectionKind: "telnet", connectionState: "connected", connection: { kind: "telnet", host: "fw1", port: 23 }, terminal: { recentText: output } }],
  };
  const requests = [];
  const provider = { id: "fake", async analyze(request) { requests.push(request); return { diagnosis: "ok", evidence: [], suggestedChecks: [], proposals: [] }; } };
  const assistant = new AiAssistant(provider, providerContext, { dispatchInput: () => ({ ok: true }) });
  const selection = { scope: "selected", selectedTabIds: ["fw1"] };
  await assistant.send(selection, "first question");
  output = "second";
  await assistant.send(selection, "second question");
  assert.equal(requests.length, 2);
  assert.match(requests[0].context.sessions[0].recentOutput, /first/);
  assert.match(requests[1].context.sessions[0].recentOutput, /second/);
});

test("core AI gate blocks new requests and cancels an active request", async () => {
  const context = {
    listSessions: () => [],
    getActiveContext: () => null,
    getContexts: () => [],
  };
  let calls = 0;
  const provider = {
    id: "gate-test",
    analyze: (_request, options = {}) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(Object.assign(new Error("cancelled"), { code: "cancelled" }));
          return;
        }
        options.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("cancelled"), { code: "cancelled" }));
        }, { once: true });
      });
    },
  };
  const assistant = new AiAssistant(provider, context, { dispatchInput: () => ({ ok: true }) }, { enabled: false });
  const selection = { scope: "active", selectedTabIds: [] };
  assert.equal(await assistant.send(selection, "blocked"), null);
  assert.equal(calls, 0);

  assistant.setEnabled(true);
  const pending = assistant.send(selection, "running");
  assistant.setEnabled(false);
  await pending;
  assert.equal(assistant.getSnapshot().status, "cancelled");
  assert.equal(calls, 1);
});

test("API provider exposes auth and cancellation as provider errors", async () => {
  const unauthorized = new ApiAiProvider({ baseUrl: "https://example.test", model: "test" }, async () => ({ ok: false, status: 401 }));
  await assert.rejects(() => unauthorized.analyze({ context: assembly(), question: "x" }), (error) => error.code === "auth");
  const controller = new AbortController();
  const slow = new ApiAiProvider({ baseUrl: "https://example.test", model: "test" }, async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
  const pending = slow.analyze({ context: assembly() }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, (error) => error.code === "cancelled");
});

test("process provider surfaces nonzero exit and cancellation without terminal access", async () => {
  let cancelled = false;
  const runner = {
    async run() { return { stdout: "", stderr: "bad", exitCode: 2, cancelled: false, timedOut: false }; },
    async cancel() { cancelled = true; },
  };
  const provider = new ProcessAiProvider({ mode: "process", preset: "custom", baseUrl: "", model: "", temperature: 0.2, executable: "tool", scriptPath: "", arguments: [], cwd: "", timeoutMs: 1000 }, runner);
  await assert.rejects(() => provider.analyze({ context: assembly() }), (error) => error.code === "provider");
  const abortController = new AbortController();
  let resolveCancelled;
  const waitingRunner = {
    run: async () => new Promise((resolve) => { resolveCancelled = resolve; }),
    cancel: async () => { cancelled = true; resolveCancelled?.({ stdout: "", stderr: "", exitCode: null, cancelled: true, timedOut: false }); },
  };
  const waitingProvider = new ProcessAiProvider({ mode: "process", preset: "custom", baseUrl: "", model: "", temperature: 0.2, executable: "tool", scriptPath: "", arguments: [], cwd: "", timeoutMs: 1000 }, waitingRunner);
  const pending = waitingProvider.analyze({ context: assembly() }, { signal: abortController.signal });
  abortController.abort();
  assert.equal(cancelled, true);
  await assert.rejects(() => pending, (error) => error.code === "cancelled");
});
