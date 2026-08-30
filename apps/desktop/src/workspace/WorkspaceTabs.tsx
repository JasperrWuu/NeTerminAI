import { useEffect, useRef, useState } from "react";
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
}

export function WorkspaceTabs({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onCreateTerminal,
  onCreateTelnet,
}: WorkspaceTabsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
      <div className="tab-list" role="tablist" aria-label="工作区标签">
        {tabs.map((tab) => (
          <div className="tab" data-active={activeTabId === tab.id} key={tab.id}>
            <button
              aria-selected={activeTabId === tab.id}
              className="tab-select"
              onClick={() => onActivate(tab.id)}
              role="tab"
              type="button"
            >
              <span className={`${tab.kind}-tab-icon`}>
                {tab.kind === "localTerminal" ? "›_" : tab.kind === "telnet" ? "TN" : "Aa"}
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
          </div>
        )}
      </div>

      <div className="tabbar-spacer" />
    </div>
  );
}
