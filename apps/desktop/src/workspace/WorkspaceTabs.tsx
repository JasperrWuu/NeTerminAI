import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { localTerminalProfiles } from "../terminal/profiles";
import type { LocalTerminalProfileId } from "../terminal/profiles";
import type { WorkspaceTab } from "./types";

interface WorkspaceTabsProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCreateTerminal: (profileId: LocalTerminalProfileId) => void;
  onCreateTelnet: () => void;
  onCreateSerial: () => void;
  onCreateSsh: () => void;
  onCreateRdp: () => void;
}

export function WorkspaceTabs({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onCreateTerminal,
  onCreateTelnet,
  onCreateSerial,
  onCreateSsh,
  onCreateRdp,
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

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (animated && !reduceMotion && currentTransform !== "none") {
      indicator.animate(
        [{ transform: currentTransform }, { transform: nextTransform }],
        { duration: 220, easing: "cubic-bezier(0.77, 0, 0.175, 1)" },
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
              onClick={() => onActivate(tab.id)}
              role="tab"
              type="button"
            >
              <span className={`${tab.kind}-tab-icon`}>
                {workspaceTabIcon(tab.kind)}
              </span>
              <span className="tab-title">{tab.title}</span>
            </button>
            <button
              aria-label={`关闭 ${tab.title}`}
              className="tab-close"
              onClick={() => onClose(tab.id)}
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

function workspaceTabIcon(kind: WorkspaceTab["kind"]) {
  const icons: Record<WorkspaceTab["kind"], string> = {
    localTerminal: "›_",
    telnet: "TN",
    serial: "COM",
    ssh: "SSH",
    rdp: "RDP",
    settings: "Aa",
  };
  return icons[kind];
}
