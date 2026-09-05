import assert from "node:assert/strict";
import test from "node:test";
import { TerminalContextProvider } from "./TerminalContextProvider.ts";

const localTab = { id: "local-tab", kind: "localTerminal", profileId: "powershell", title: "PowerShell" };
const telnetTab = {
  id: "telnet-tab",
  kind: "telnet",
  title: "Firewall",
  connection: { name: "Firewall", host: "192.0.2.10", port: 23, username: "admin", password: "secret" },
};
const serialTab = {
  id: "serial-tab",
  kind: "serial",
  title: "Console",
  connection: {
    name: "Console", portName: "COM1", baudRate: 9600, dataBits: 8, stopBits: 1,
    parity: "none", flowControl: "none",
  },
};

function pane(id, tabIds, activeTabId) {
  return { type: "pane", id, tabIds, activeTabId };
}

function runtime(kind, sessionId, state = "connected", text = "output") {
  return {
    connectionType: kind,
    getSnapshot: () => ({
      sessionId,
      state,
      reason: state === "disconnected" ? "remoteClosed" : undefined,
      error: state === "failed" ? "connection" : undefined,
    }),
    getTerminalSnapshot: (limits) => ({
      sessionId,
      cols: 100,
      rows: 30,
      recentText: text.slice(-(limits?.maxChars ?? 32768)),
    }),
  };
}

function providerWith(workspace, runtimeMap) {
  return new TerminalContextProvider({ get: (tabId) => runtimeMap.get(tabId) }, () => workspace);
}

test("active context follows workspace identity and excludes credentials", () => {
  const provider = providerWith({
    tabs: [localTab, telnetTab],
    layout: pane("pane-a", ["local-tab", "telnet-tab"], "telnet-tab"),
    activePaneId: "pane-a",
    activeTabId: "telnet-tab",
  }, new Map([["telnet-tab", runtime("telnet", "session-t1")]]));

  const context = provider.getActiveContext();
  assert.ok(context);
  assert.equal(typeof context.capturedAt, "number");
  const { capturedAt: _capturedAt, ...stableContext } = context;
  assert.deepEqual(stableContext, {
    version: 1,
    tabId: "telnet-tab",
    paneId: "pane-a",
    sessionId: "session-t1",
    title: "Firewall",
    connectionKind: "telnet",
    connectionState: "connected",
    target: { tabId: "telnet-tab", sessionId: "session-t1" },
    connection: { kind: "telnet", host: "192.0.2.10", port: 23 },
    terminal: { sessionId: "session-t1", cols: 100, rows: 30, recentText: "output" },
  });
});

test("provider returns visible pane contexts in bounded order", () => {
  const workspace = {
    tabs: [localTab, telnetTab, serialTab],
    layout: {
      type: "split", id: "split", direction: "row", ratio: 0.5,
      first: pane("pane-a", ["local-tab"], "local-tab"),
      second: pane("pane-b", ["telnet-tab", "serial-tab"], "serial-tab"),
    },
    activePaneId: "pane-b",
    activeTabId: "serial-tab",
  };
  const provider = providerWith(workspace, new Map([
    ["local-tab", runtime("local", "session-l")],
    ["telnet-tab", runtime("telnet", "session-t")],
    ["serial-tab", runtime("serial", "session-s")],
  ]));
  assert.deepEqual(provider.getVisibleContexts().map((context) => context.tabId), [
    "serial-tab", "local-tab",
  ]);
});

test("failed and disconnected runtimes remain readable, while closed tabs do not", () => {
  const workspace = {
    tabs: [localTab, telnetTab],
    layout: pane("pane-a", ["local-tab", "telnet-tab"], "local-tab"),
    activePaneId: "pane-a",
    activeTabId: "local-tab",
  };
  const runtimes = new Map([
    ["local-tab", runtime("local", "session-f", "failed", "spawn failed")],
    ["telnet-tab", runtime("telnet", "session-d", "disconnected")],
  ]);
  const provider = providerWith(workspace, runtimes);
  assert.equal(provider.getActiveContext()?.connectionState, "failed");
  assert.equal(provider.getActiveContext()?.error, "connection");
  assert.equal(provider.getContextForTab("telnet-tab")?.disconnectReason, "remoteClosed");
  workspace.tabs = [localTab];
  assert.equal(provider.getContextForTab("telnet-tab"), undefined);
});

test("reconnect uses the current runtime session identity and rejects a stale kind", () => {
  const workspace = {
    tabs: [localTab],
    layout: pane("pane-a", ["local-tab"], "local-tab"),
    activePaneId: "pane-a",
    activeTabId: "local-tab",
  };
  const runtimes = new Map([["local-tab", runtime("local", "session-new")]]);
  const provider = providerWith(workspace, runtimes);
  assert.equal(provider.getActiveContext()?.sessionId, "session-new");
  runtimes.set("local-tab", runtime("telnet", "stale"));
  assert.equal(provider.getActiveContext(), undefined);
});
