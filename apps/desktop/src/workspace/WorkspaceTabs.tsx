import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { motion, prefersReducedMotion } from "../ui/motion";
import type { WorkspaceTab } from "./types";

interface WorkspaceTabsProps {
  paneId: string;
  paneActive: boolean;
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  synchronizedTabIds: ReadonlySet<string>;
  onActivate: (paneId: string, tabId: string) => void;
  onClose: (paneId: string, tabId: string) => void;
  onClosePane: (paneId: string) => void;
  onTabPointerDown: (event: ReactPointerEvent<HTMLButtonElement>, paneId: string, tab: WorkspaceTab) => void;
  canClosePane: boolean;
}

export function WorkspaceTabs({
  paneId,
  paneActive,
  tabs,
  activeTabId,
  synchronizedTabIds,
  onActivate,
  onClose,
  onClosePane,
  onTabPointerDown,
  canClosePane,
}: WorkspaceTabsProps) {
  const tabListRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const activeIndicatorRef = useRef<HTMLDivElement>(null);

  const positionActiveIndicator = useCallback((animated: boolean) => {
    const activeTab = activeTabId ? tabRefs.current.get(activeTabId) : undefined;
    const tabList = tabListRef.current;
    const indicator = activeIndicatorRef.current;
    if (!activeTab || !indicator || !tabList) {
      if (indicator) indicator.dataset.visible = "false";
      return;
    }

    const visibleStart = tabList.scrollLeft;
    const visibleEnd = visibleStart + tabList.clientWidth;
    const tabStart = activeTab.offsetLeft;
    const tabEnd = tabStart + activeTab.offsetWidth;
    let scrolled = false;
    if (tabStart < visibleStart) {
      tabList.scrollTo({ left: tabStart, behavior: "auto" });
      scrolled = true;
    } else if (tabEnd > visibleEnd) {
      tabList.scrollTo({ left: tabEnd - tabList.clientWidth, behavior: "auto" });
      scrolled = true;
    }

    const nextTransform = `translateX(${activeTab.offsetLeft}px)`;
    const currentTransform = getComputedStyle(indicator).transform;
    indicator.getAnimations().forEach((animation) => animation.cancel());
    indicator.style.width = `${activeTab.offsetWidth}px`;
    indicator.style.height = `${activeTab.offsetHeight}px`;
    indicator.style.top = `${activeTab.offsetTop}px`;
    indicator.style.transform = nextTransform;
    indicator.dataset.visible = "true";

    if (animated && !scrolled && !prefersReducedMotion() && currentTransform !== "none") {
      indicator.animate(
        [{ transform: currentTransform }, { transform: nextTransform }],
        { duration: motion.duration.standard, easing: motion.easing.inOut },
      );
    }
  }, [activeTabId]);

  useLayoutEffect(() => {
    positionActiveIndicator(true);
  }, [positionActiveIndicator, tabs]);

  useEffect(() => {
    const tabList = tabListRef.current;
    if (!tabList) return;
    const observer = new ResizeObserver(() => positionActiveIndicator(false));
    observer.observe(tabList);
    return () => observer.disconnect();
  }, [positionActiveIndicator]);

  return (
    <div className="tabbar" data-active-pane={paneActive}>
      <div className="tab-list" ref={tabListRef} role="tablist" aria-label="工作区标签">
        <div aria-hidden="true" className="tab-active-indicator" ref={activeIndicatorRef} />
        {tabs.map((tab) => (
          <div
            className="tab"
            data-active={activeTabId === tab.id}
            key={tab.id}
            ref={(element) => {
              if (element) tabRefs.current.set(tab.id, element);
              else tabRefs.current.delete(tab.id);
            }}
          >
            <button
              aria-selected={activeTabId === tab.id}
              className="tab-select"
              onClick={() => onActivate(paneId, tab.id)}
              onPointerDown={(event) => onTabPointerDown(event, paneId, tab)}
              role="tab"
              type="button"
            >
              <WorkspaceTabIcon kind={tab.kind} />
              <span className="tab-title">{tab.title}</span>
            </button>
            {synchronizedTabIds.has(tab.id) && (
              <span className="tab-sync-mark" aria-label="同步输入已开启" title="同步输入已开启">
                <i /><i />
              </span>
            )}
            <button
              aria-label={`关闭 ${tab.title}`}
              className="tab-close"
              onClick={() => onClose(paneId, tab.id)}
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 16 16">
                <path d="m4.5 4.5 7 7m0-7-7 7" />
              </svg>
            </button>
          </div>
        ))}
        {tabs.length === 0 && (
          <span className="pane-session-label">
            <WorkspaceTabIcon kind={tabs.find((tab) => tab.id === activeTabId)?.kind ?? "localTerminal"} />
            <span>{tabs.find((tab) => tab.id === activeTabId)?.title ?? "独立终端分区"}</span>
          </span>
        )}
      </div>
      {canClosePane && (
        <button
          aria-label="关闭当前分区"
          className="pane-close"
          onClick={() => onClosePane(paneId)}
          title="关闭当前分区"
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4.5 4.5 7 7m0-7-7 7" /></svg>
        </button>
      )}
    </div>
  );
}

function WorkspaceTabIcon({ kind }: { kind: WorkspaceTab["kind"] }) {
  return (
    <span className={`tab-glyph ${kind}-tab-icon`} aria-hidden="true">
      {kind === "localTerminal" || kind === "telnet" ? (
        <svg viewBox="0 0 20 20"><path d="m4.5 6 3.5 4-3.5 4M10 14h5.5" /></svg>
      ) : kind === "serial" ? (
        <svg viewBox="0 0 20 20"><path d="M6 5.5h8v4a4 4 0 0 1-8 0v-4ZM8 3.5v2m4-2v2M10 13.5v3" /></svg>
      ) : (
        <svg viewBox="0 0 20 20"><path d="M4 6h8m3 0h1M4 10h2m3 0h7M4 14h6m3 0h3" /><circle cx="13.5" cy="6" r="1.5" /><circle cx="7.5" cy="10" r="1.5" /><circle cx="11.5" cy="14" r="1.5" /></svg>
      )}
    </span>
  );
}
