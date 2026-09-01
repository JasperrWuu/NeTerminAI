import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { countWorkspacePanes, resolveWorkspaceDropZone } from "./layout";
import type {
  WorkspaceDropZone,
  WorkspaceLayoutNode,
  WorkspacePaneNode,
  WorkspaceTab,
} from "./types";

interface WorkspaceAreaProps {
  activePaneId: string;
  layout: WorkspaceLayoutNode;
  tabs: WorkspaceTab[];
  synchronizedTabIds: ReadonlySet<string>;
  onActivatePane: (paneId: string) => void;
  onActivateTab: (paneId: string, tabId: string) => void;
  onCloseTab: (paneId: string, tabId: string) => void;
  onClosePane: (paneId: string) => void;
  onMoveTab: (tabId: string, sourcePaneId: string, targetPaneId: string, zone: WorkspaceDropZone) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
  onDraggingChange?: (dragging: boolean) => void;
  renderTab: (tab: WorkspaceTab, active: boolean, paneId: string) => ReactNode;
}

interface DraggedTab {
  sourcePaneId: string;
  tabId: string;
  title: string;
  x: number;
  y: number;
}

interface DropTarget {
  paneId: string;
  zone: WorkspaceDropZone;
}

interface PaneBounds {
  height: number;
  width: number;
  x: number;
  y: number;
}

export function WorkspaceArea(props: WorkspaceAreaProps) {
  const { onDraggingChange, onMoveTab } = props;
  const [draggedTab, setDraggedTab] = useState<DraggedTab | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [paneBounds, setPaneBounds] = useState<Record<string, PaneBounds>>({});
  const layoutRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);

  const updateDropTarget = useCallback((clientX: number, clientY: number) => {
    const next = resolveDropTarget(clientX, clientY);
    const current = dropTargetRef.current;
    if (current?.paneId === next?.paneId && current?.zone === next?.zone) return;
    dropTargetRef.current = next;
    setDropTarget(next);
  }, []);

  const beginTabDrag = useCallback((
    event: ReactPointerEvent<HTMLButtonElement>,
    sourcePaneId: string,
    tab: WorkspaceTab,
  ) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const element = event.currentTarget;
    const tabElement = element.closest<HTMLElement>(".tab");
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    let dragging = false;

    try {
      element.setPointerCapture(pointerId);
    } catch {
      // Synthetic automation events do not own a native pointer; real pointer input does.
    }

    const move = (pointerEvent: PointerEvent) => {
      const distance = Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY);
      if (!dragging && distance < 8) return;
      if (!dragging) {
        dragging = true;
        tabElement?.setAttribute("data-dragging", "true");
        document.body.classList.add("is-dragging-tab");
        onDraggingChange?.(true);
        setDraggedTab({
          sourcePaneId,
          tabId: tab.id,
          title: tab.title,
          x: pointerEvent.clientX,
          y: pointerEvent.clientY,
        });
        element.addEventListener("click", suppressClick, { capture: true, once: true });
      }
      if (previewRef.current) {
        previewRef.current.style.transform = `translate3d(${pointerEvent.clientX + 12}px, ${pointerEvent.clientY + 12}px, 0)`;
      }
      updateDropTarget(pointerEvent.clientX, pointerEvent.clientY);
    };

    const finish = (pointerEvent: PointerEvent, commit: boolean) => {
      const wasDragging = dragging;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerCancel);
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      tabElement?.removeAttribute("data-dragging");
      document.body.classList.remove("is-dragging-tab");
      if (wasDragging) onDraggingChange?.(false);

      if (wasDragging && commit) {
        const target = dropTargetRef.current;
        if (target) onMoveTab(tab.id, sourcePaneId, target.paneId, target.zone);
      }
      dragging = false;
      dropTargetRef.current = null;
      setDropTarget(null);
      setDraggedTab(null);
      if (wasDragging) {
        pointerEvent.preventDefault();
        window.setTimeout(() => element.removeEventListener("click", suppressClick, true), 0);
      }
    };

    const pointerUp = (pointerEvent: PointerEvent) => finish(pointerEvent, true);
    const pointerCancel = (pointerEvent: PointerEvent) => finish(pointerEvent, false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerCancel);
  }, [onDraggingChange, onMoveTab, updateDropTarget]);

  const tabsById = new Map(props.tabs.map((tab) => [tab.id, tab]));
  const tabPlacements = collectTabPlacements(props.layout);

  useLayoutEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    let frame: number | undefined;
    const updateBounds = () => {
      const layoutRect = layout.getBoundingClientRect();
      const next: Record<string, PaneBounds> = {};
      layout.querySelectorAll<HTMLElement>("[data-workspace-pane-content]").forEach((content) => {
        const bounds = content.getBoundingClientRect();
        const paneId = content.dataset.workspacePaneContent;
        if (paneId) {
          next[paneId] = {
            x: bounds.left - layoutRect.left,
            y: bounds.top - layoutRect.top,
            width: bounds.width,
            height: bounds.height,
          };
        }
      });
      setPaneBounds((current) => sameBounds(current, next) ? current : next);
    };
    const scheduleMeasure = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        updateBounds();
      });
    };
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(layout);
    layout.querySelectorAll<HTMLElement>("[data-workspace-pane-content]").forEach((content) => {
      observer.observe(content);
    });
    window.addEventListener("resize", scheduleMeasure);
    updateBounds();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [props.layout]);

  return (
    <div className="workspace-layout" ref={layoutRef}>
      <LayoutNode
        {...props}
        dropTarget={dropTarget}
        node={props.layout}
        onTabPointerDown={beginTabDrag}
        tabsById={tabsById}
      />
      <div className="workspace-view-layer">
        {props.tabs.map((tab) => {
          const placement = tabPlacements.get(tab.id);
          if (!placement) return null;
          const bounds = placement ? paneBounds[placement.paneId] : undefined;
          const active = Boolean(bounds && placement?.active);
          const style = bounds ? {
            height: bounds.height,
            transform: `translate3d(${bounds.x}px, ${bounds.y}px, 0)`,
            width: bounds.width,
          } as CSSProperties : undefined;
          return (
            <div
              className="workspace-tab-slot"
              data-active={active}
              key={tab.id}
              style={style}
            >
              {props.renderTab(tab, active, placement?.paneId ?? "")}
            </div>
          );
        })}
      </div>
      {draggedTab && (
        <div
          aria-hidden="true"
          className="tab-drag-preview"
          ref={previewRef}
          style={{ transform: `translate3d(${draggedTab.x + 12}px, ${draggedTab.y + 12}px, 0)` }}
        >
          <span className="tab-drag-dot" />
          <span>{draggedTab.title}</span>
        </div>
      )}
    </div>
  );
}

interface LayoutNodeProps extends WorkspaceAreaProps {
  dropTarget: DropTarget | null;
  node: WorkspaceLayoutNode;
  onTabPointerDown: (
    event: ReactPointerEvent<HTMLButtonElement>,
    paneId: string,
    tab: WorkspaceTab,
  ) => void;
  tabsById: Map<string, WorkspaceTab>;
}

function LayoutNode({ node, ...props }: LayoutNodeProps) {
  if (node.type === "split") {
    const ratio = node.ratio ?? 0.5;
    return (
      <div className="workspace-split" data-direction={node.direction}>
        <div className="workspace-split-child" style={{ flexBasis: `${ratio * 100}%` }}>
          <LayoutNode {...props} node={node.first} />
        </div>
        <SplitResizeHandle direction={node.direction} onResize={props.onResizeSplit} splitId={node.id} />
        <div className="workspace-split-child">
          <LayoutNode {...props} node={node.second} />
        </div>
      </div>
    );
  }
  return <WorkspacePane {...props} node={node} />;
}

function WorkspacePane({ node, ...props }: Omit<LayoutNodeProps, "node"> & { node: WorkspacePaneNode }) {
  const tabs = node.tabIds.flatMap((tabId) => {
    const tab = props.tabsById.get(tabId);
    return tab ? [tab] : [];
  });
  const targetZone = props.dropTarget?.paneId === node.id ? props.dropTarget.zone : null;

  return (
    <section
      className="workspace-pane"
      data-active={props.activePaneId === node.id}
      data-workspace-pane-id={node.id}
      onPointerDown={() => props.onActivatePane(node.id)}
    >
      <WorkspaceTabs
        activeTabId={node.activeTabId}
        paneActive={props.activePaneId === node.id}
        synchronizedTabIds={props.synchronizedTabIds}
        onActivate={props.onActivateTab}
        onClose={props.onCloseTab}
        onClosePane={props.onClosePane}
        onTabPointerDown={props.onTabPointerDown}
        paneId={node.id}
        canClosePane={countWorkspacePanes(props.layout) > 1}
        tabs={tabs}
      />
      <div className="workspace-pane-content" data-workspace-pane-content={node.id}>
        {tabs.length === 0 && (
          <div className="empty-pane">
            <span>空白分区</span>
            <small>将其他会话标签拖到这里</small>
          </div>
        )}
      </div>
      {targetZone && (
        <div className="workspace-drop-overlay" aria-hidden="true">
          <div className="workspace-drop-preview" data-zone={targetZone}>
            <span>{dropZoneLabel(targetZone)}</span>
          </div>
        </div>
      )}
    </section>
  );
}

function SplitResizeHandle({
  direction,
  onResize,
  splitId,
}: {
  direction: "row" | "column";
  onResize: (splitId: string, ratio: number) => void;
  splitId: string;
}) {
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const split = handle.parentElement;
    const first = handle.previousElementSibling as HTMLElement | null;
    if (!split || !first) return;
    const splitBounds = split.getBoundingClientRect();
    const firstBounds = first.getBoundingClientRect();
    const axisStart = direction === "row" ? event.clientX : event.clientY;
    const total = direction === "row" ? splitBounds.width : splitBounds.height;
    const firstSize = direction === "row" ? firstBounds.width : firstBounds.height;
    if (total <= 0) return;
    const pointerId = event.pointerId;
    try { handle.setPointerCapture(pointerId); } catch { /* synthetic pointer */ }
    const move = (pointerEvent: PointerEvent) => {
      const delta = (direction === "row" ? pointerEvent.clientX : pointerEvent.clientY) - axisStart;
      onResize(splitId, (firstSize + delta) / total);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      try { handle.releasePointerCapture(pointerId); } catch { /* already released */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  };
  return (
    <div
      aria-label="调整分区大小"
      className="workspace-split-handle"
      data-direction={direction}
      onPointerDown={handlePointerDown}
      role="separator"
      tabIndex={0}
    />
  );
}

function collectTabPlacements(node: WorkspaceLayoutNode) {
  const placements = new Map<string, { active: boolean; paneId: string }>();
  const visit = (item: WorkspaceLayoutNode) => {
    if (item.type === "split") {
      visit(item.first);
      visit(item.second);
      return;
    }
    item.tabIds.forEach((tabId) => {
      placements.set(tabId, { active: tabId === item.activeTabId, paneId: item.id });
    });
  };
  visit(node);
  return placements;
}

function sameBounds(current: Record<string, PaneBounds>, next: Record<string, PaneBounds>) {
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  if (currentKeys.length !== nextKeys.length) return false;
  return nextKeys.every((key) => {
    const left = current[key];
    const right = next[key];
    return left && left.x === right.x && left.y === right.y
      && left.width === right.width && left.height === right.height;
  });
}

function resolveDropTarget(clientX: number, clientY: number): DropTarget | null {
  const pane = Array.from(
    document.querySelectorAll<HTMLElement>("[data-workspace-pane-id]"),
  ).find((candidate) => {
    const bounds = candidate.getBoundingClientRect();
    return clientX >= bounds.left && clientX <= bounds.right
      && clientY >= bounds.top && clientY <= bounds.bottom;
  });
  if (!pane) return null;
  const bounds = pane.getBoundingClientRect();
  const tabBarBounds = pane.querySelector<HTMLElement>(".tabbar")?.getBoundingClientRect();
  const overTabBar = Boolean(
    tabBarBounds
      && clientX >= tabBarBounds.left
      && clientX <= tabBarBounds.right
      && clientY >= tabBarBounds.top
      && clientY <= tabBarBounds.bottom,
  );
  return {
    paneId: pane.dataset.workspacePaneId ?? "",
    zone: resolveWorkspaceDropZone(bounds, clientX, clientY, overTabBar),
  };
}

function dropZoneLabel(zone: WorkspaceDropZone) {
  const labels: Record<WorkspaceDropZone, string> = {
    center: "移动到此分区",
    left: "左侧分屏",
    right: "右侧分屏",
    top: "上方分屏",
    bottom: "下方分屏",
  };
  return labels[zone];
}

function suppressClick(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}
