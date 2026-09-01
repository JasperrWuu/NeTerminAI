import type { SettingsSection } from "./types";
import { KeyboardIcon, SettingsIcon } from "../workbench/icons";

interface SettingsSidebarProps {
  section: SettingsSection;
  onSelect: (section: SettingsSection) => void;
}

export function SettingsSidebar({ section, onSelect }: SettingsSidebarProps) {
  return (
    <nav aria-label="设置选项" className="settings-sidebar">
      <p className="settings-sidebar-label">工作台</p>
      <button
        aria-current={section === "terminal" ? "page" : undefined}
        className="settings-nav-item"
        data-active={section === "terminal"}
        onClick={() => onSelect("terminal")}
        type="button"
      >
        <SettingsIcon />
        <span><strong>终端</strong><small>字体、光标与颜色</small></span>
      </button>
      <button
        aria-current={section === "keyboard" ? "page" : undefined}
        className="settings-nav-item"
        data-active={section === "keyboard"}
        onClick={() => onSelect("keyboard")}
        type="button"
      >
        <KeyboardIcon />
        <span><strong>键盘快捷键</strong><small>操作与效率</small></span>
      </button>
    </nav>
  );
}
