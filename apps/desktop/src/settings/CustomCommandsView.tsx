import { useState } from "react";
import { shortcutParts } from "./keybindings";
import type { KeybindingSettings } from "./types";

export function CustomCommandsView({ texts, keybindings, onChange }: {
  texts: string[];
  keybindings: KeybindingSettings;
  onChange: (texts: string[]) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  return <section className="settings-view" aria-label="自定义命令">
    <div className="settings-scroll-area">
      <header className="settings-heading"><div>
        <p className="settings-eyebrow">操作与效率</p><h1>自定义命令</h1>
        <p>发送到当前聚焦的终端，自动补齐末尾回车。支持多行，修改自动保存。</p>
      </div></header>
      <div className="custom-command-list">
        {texts.map((text, index) => {
          const shortcut = keybindings[`quickText${index}` as keyof KeybindingSettings];
          return <label className="custom-command-row" key={index}>
            <span className="custom-command-meta">
              <span className="shortcut-keys">{shortcutParts(shortcut.binding).map((part) => <kbd key={part}>{part}</kbd>)}</span>
              <small>{editing === index ? "编辑中" : !shortcut.enabled ? "快捷键已停用" : text ? "已设置" : "未设置"}</small>
            </span>
            <textarea className="settings-text-input" rows={2} spellCheck={false}
              aria-label={`自定义命令 Alt + ${index}`} value={text} placeholder="输入命令…"
              onFocus={() => setEditing(index)} onBlur={() => setEditing(null)}
              onChange={(event) => onChange(texts.map((value, i) => i === index ? event.target.value : value))} />
          </label>;
        })}
      </div>
    </div>
  </section>;
}
