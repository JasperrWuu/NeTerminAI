import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBalancedWorkspaceLayout,
  collectTabIds,
  countWorkspacePanes,
  reorderPaneTabs,
  workspaceDragRegion,
} from "./layout.ts";

test("drag mode follows actual tab/content geometry in both directions", () => {
  const bar = { left: 100, right: 700, top: 20, bottom: 60, width: 600, height: 40 };
  const content = { ...bar, top: 60, bottom: 500, height: 440 };
  for (const x of [101, 300, 699]) {
    assert.equal(workspaceDragRegion(bar, content, x, 40), "reorder");
    assert.equal(workspaceDragRegion(bar, content, x, 60), "split");
    assert.equal(workspaceDragRegion(bar, content, x, 300), "split");
    assert.equal(workspaceDragRegion(bar, content, x, 59), "reorder");
  }
  assert.equal(workspaceDragRegion(bar, content, 50, 40), null);
  assert.equal(workspaceDragRegion(bar, undefined, 300, 90), null);
});

test("tab reorder changes order only, including end drops and split pane identity", () => {
  const pane = { type: "pane", id: "pane-a", tabIds: ["ssh", "rdp", "serial"], activeTabId: "rdp" };
  const next = reorderPaneTabs(pane, "serial", "ssh");
  assert.deepEqual(next.tabIds, ["serial", "ssh", "rdp"]);
  assert.equal(next.id, pane.id);
  assert.equal(next.activeTabId, "rdp");
  assert.deepEqual(reorderPaneTabs(next, "serial", null), pane);
  assert.equal(reorderPaneTabs(pane, "missing", null), pane);
  assert.equal(reorderPaneTabs(pane, "ssh", "missing"), pane);
  assert.deepEqual(pane.tabIds, ["ssh", "rdp", "serial"]);
});

function leafCount(node) {
  return node.type === "pane" ? 1 : leafCount(node.first) + leafCount(node.second);
}

function assertRow(node, expectedLeaves) {
  assert.equal(node.type, expectedLeaves === 1 ? "pane" : "split");
  assert.equal(leafCount(node), expectedLeaves);
  if (node.type === "split") assert.equal(node.direction, "row");
}

test("balanced workspace layout preserves sessions and forms an even grid", () => {
  for (let count = 1; count <= 10; count += 1) {
    const tabIds = Array.from({ length: count }, (_, index) => `tab-${index + 1}`);
    const layout = buildBalancedWorkspaceLayout(tabIds);
    assert.equal(countWorkspacePanes(layout), count);
    assert.deepEqual(collectTabIds(layout), tabIds);
  }
});

test("grid rows distribute remainder tabs across the first rows", () => {
  const three = buildBalancedWorkspaceLayout(["1", "2", "3"]);
  assert.equal(three.type, "split");
  assert.equal(three.direction, "column");
  assertRow(three.first, 2);
  assertRow(three.second, 1);

  const five = buildBalancedWorkspaceLayout(["1", "2", "3", "4", "5"]);
  assert.equal(five.type, "split");
  assert.equal(five.direction, "column");
  assertRow(five.first, 3);
  assertRow(five.second, 2);

  const six = buildBalancedWorkspaceLayout(["1", "2", "3", "4", "5", "6"]);
  assert.equal(six.type, "split");
  assert.equal(six.direction, "column");
  assertRow(six.first, 3);
  assertRow(six.second, 3);
});
