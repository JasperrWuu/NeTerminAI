import assert from "node:assert/strict";
import test from "node:test";
import { createProject, normalizeProject } from "./persistence.ts";
import { projectSessionsFromTabs, restoreProjectWorkspace } from "./workspace.ts";

test("project persistence model keeps credentials out of session references", () => {
  const project = createProject("NAT64 测试", 100);
  const tabs = [{
    id: "telnet-tab",
    projectId: project.id,
    kind: "telnet",
    title: "FW1",
    connectionId: "saved-fw1",
    connection: { name: "FW1", host: "192.0.2.1", port: 23, username: "admin", password: "secret" },
  }];
  const sessions = projectSessionsFromTabs(tabs, project.id);
  assert.deepEqual(sessions, [{
    tabId: "telnet-tab",
    title: "FW1",
    source: { kind: "savedConnection", connectionId: "saved-fw1" },
  }]);
  assert.equal(JSON.stringify(sessions).includes("secret"), false);
});

test("project workspace restore keeps layout and active tab references", () => {
  const project = createProject("BGP", 100);
  project.sessions = [
    { tabId: "one", title: "FW1", source: { kind: "transient", connectionKind: "telnet" } },
    { tabId: "two", title: "FW2", source: { kind: "transient", connectionKind: "telnet" } },
  ];
  project.layout = {
    layout: {
      type: "split", id: "split", direction: "row", ratio: 0.5,
      first: { type: "pane", id: "left", tabIds: ["one"], activeTabId: "one" },
      second: { type: "pane", id: "right", tabIds: ["two"], activeTabId: "two" },
    },
    activePaneId: "right",
    activeTabId: "two",
  };
  project.runtime.activeTabId = "two";
  const restored = restoreProjectWorkspace(project, [
    { id: "one", projectId: project.id, kind: "localTerminal", profileId: "powershell", title: "PowerShell" },
    { id: "two", projectId: project.id, kind: "localTerminal", profileId: "powershell", title: "PowerShell 2" },
  ]);
  assert.equal(restored.activePaneId, "right");
  assert.deepEqual(restored.layout.type, "split");
});

test("malformed project records are normalized without affecting valid records", () => {
  const [project] = normalizeProject({
    id: "safe",
    name: "Safe",
    sessions: [
      { tabId: "valid", title: "FW", source: { kind: "savedConnection", connectionId: "fw" } },
      { tabId: "broken", source: { kind: "savedConnection", connectionId: "fw" } },
    ],
  });
  assert.equal(project.name, "Safe");
  assert.deepEqual(project.sessions.map((session) => session.tabId), ["valid"]);
});

test("legacy runtime activeSessionId is migrated to the correctly named activeTabId", () => {
  const [project] = normalizeProject({
    id: "legacy",
    name: "Legacy",
    runtime: { activeSessionId: "tab-1", aiContextSelection: { scope: "active", selectedTabIds: [] } },
  });
  assert.equal(project.runtime.activeTabId, "tab-1");
  assert.equal("activeSessionId" in project.runtime, false);
});
