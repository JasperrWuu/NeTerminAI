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
          return <div className="custom-command-row" data-editing={editing === index} key={index} onClick={() => { if (editing !== index) setEditing(index); }}>
            <span className="custom-command-meta">
              <span className="shortcut-keys">{shortcutParts(shortcut.binding).map((part) => <kbd key={part}>{part}</kbd>)}</span>
              {!shortcut.enabled && <small>已停用</small>}
            </span>
            {editing === index ? <textarea className="settings-text-input" rows={Math.max(2, text.split("\n").length)} spellCheck={false} autoFocus
              aria-label={`自定义命令 Alt + ${index}`} value={text} placeholder="输入命令…"
              onBlur={() => setEditing(null)} onKeyDown={(event) => { if (event.key === "Escape") setEditing(null); }}
              onChange={(event) => onChange(texts.map((value, i) => i === index ? event.target.value : value))} />
              : <button type="button" className="custom-command-preview" onClick={() => setEditing(index)} aria-label={`编辑 Alt + ${index} 命令`}>
                <span data-empty={!text}>{text.split(/\r?\n/)[0] || "添加命令…"}</span><small>{text.includes("\n") ? `${text.split("\n").length} 行 · 编辑` : "编辑"}</small>
              </button>}
          </div>;
        })}
      </div>
    </div>
  </section>;
}
