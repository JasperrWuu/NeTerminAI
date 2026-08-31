import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { localTerminalProfiles } from "../terminal/profiles";
import type { LocalTerminalProfileId } from "../terminal/profiles";
import { motion, prefersReducedMotion } from "../ui/motion";
import type { WorkspaceTab } from "./types";

interface WorkspaceTabsProps {
  paneId: string;
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onActivate: (paneId: string, tabId: string) => void;
  onClose: (paneId: string, tabId: string) => void;
  onTabPointerDown: (event: ReactPointerEvent<HTMLButtonElement>, paneId: string, tab: WorkspaceTab) => void;
  onCreateTerminal: (profileId: LocalTerminalProfileId) => void;
  onCreateTelnet: () => void;
  onCreateSerial: () => void;
  onCreateSsh: () => void;
  onCreateRdp: () => void;
}

export function WorkspaceTabs({
  paneId,
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onCreateTerminal,
  onCreateTelnet,
  onCreateSerial,
  onCreateSsh,
  onCreateRdp,
  onTabPointerDown,
}: WorkspaceTabsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const activeIndicatorRef = useRef<HTMLDivElement>(null);

  const positionActiveIndicator = useCallback((animated: boolean) => {
    const activeTab = activeTabId ? tabRefs.current.get(activeTabId) : undefined;
    const indicator = activeIndicatorRef.current;
    if (!activeTab || !indicator) {
      if (indicator) indicator.dataset.visible = "false";
      return;
    }

    const nextTransform = `translateX(${activeTab.offsetLeft}px)`;
    const currentTransform = getComputedStyle(indicator).transform;
    indicator.getAnimations().forEach((animation) => animation.cancel());
    indicator.style.width = `${activeTab.offsetWidth}px`;
    indicator.style.height = `${activeTab.offsetHeight}px`;
    indicator.style.top = `${activeTab.offsetTop}px`;
    indicator.style.transform = nextTransform;
    indicator.dataset.visible = "true";

    if (animated && !prefersReducedMotion() && currentTransform !== "none") {
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

  useEffect(() => {
    if (!menuOpen) return;

    const closeMenu = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", closeMenu);
    return () => window.removeEventListener("pointerdown", closeMenu);
  }, [menuOpen]);

  return (
    <div className="tabbar">
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
            <button
              aria-label={`关闭 ${tab.title}`}
              className="tab-close"
              onClick={() => onClose(paneId, tab.id)}
              type="button"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="new-tab-control" ref={menuRef}>
        <button
          aria-label="新建 PowerShell 终端"
          className="new-tab-button"
          onClick={() => onCreateTerminal("powershell")}
          type="button"
        >
          +
        </button>
        <button
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label="选择新标签类型"
          className="new-tab-menu-button"
          onClick={() => setMenuOpen((open) => !open)}
          type="button"
        >
          ‹
        </button>

        {menuOpen && (
          <div className="terminal-profile-menu" role="menu">
            <div className="terminal-profile-menu-label">本地终端</div>
            {localTerminalProfiles.map((profile) => (
              <button
                className="terminal-profile-option"
                key={profile.id}
                onClick={() => {
                  onCreateTerminal(profile.id);
                  setMenuOpen(false);
                }}
                role="menuitem"
                type="button"
              >
                <span className="profile-icon">{profile.shortName}</span>
                <span>{profile.name}</span>
              </button>
            ))}
            <div className="terminal-profile-menu-label menu-section-label">远程连接</div>
            <button
              className="terminal-profile-option"
              onClick={() => {
                onCreateTelnet();
                setMenuOpen(false);
              }}
              role="menuitem"
              type="button"
            >
              <span className="profile-icon telnet-profile-icon">TN</span>
              <span>Telnet</span>
            </button>
            <button className="terminal-profile-option" onClick={() => { onCreateSsh(); setMenuOpen(false); }} role="menuitem" type="button">
              <span className="profile-icon ssh-profile-icon">SSH</span><span>SSH</span>
            </button>
            <button
              className="terminal-profile-option"
              onClick={() => {
                onCreateSerial();
                setMenuOpen(false);
              }}
              role="menuitem"
              type="button"
            >
              <span className="profile-icon serial-profile-icon">COM</span>
              <span>串口</span>
            </button>
            <button className="terminal-profile-option" onClick={() => { onCreateRdp(); setMenuOpen(false); }} role="menuitem" type="button">
              <span className="profile-icon rdp-profile-icon">RDP</span><span>远程桌面</span>
            </button>
          </div>
        )}
      </div>

      <div className="tabbar-spacer" />
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
      ) : kind === "ssh" ? (
        <svg viewBox="0 0 20 20"><rect x="4.5" y="8" width="11" height="8" rx="2" /><path d="M7 8V6.5a3 3 0 0 1 6 0V8" /></svg>
      ) : kind === "rdp" ? (
        <svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="10" rx="2" /><path d="M7 17h6m-3-3v3" /></svg>
      ) : (
        <svg viewBox="0 0 20 20"><path d="M4 6h8m3 0h1M4 10h2m3 0h7M4 14h6m3 0h3" /><circle cx="13.5" cy="6" r="1.5" /><circle cx="7.5" cy="10" r="1.5" /><circle cx="11.5" cy="14" r="1.5" /></svg>
      )}
    </span>
  );
}
