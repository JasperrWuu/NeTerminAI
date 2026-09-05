import { useCallback, useSyncExternalStore } from "react";
import type { TerminalContextProvider, TerminalContextSessionDescriptor } from "./TerminalContextProvider";
import type { AiContextSelection } from "./selection";
import type { TerminalSessionRegistry } from "../../terminal/TerminalSessionRegistry";

interface AiContextSelectorProps {
  activeTabId: string | null;
  provider: TerminalContextProvider;
  registry: TerminalSessionRegistry;
  selection: AiContextSelection;
  visibleTabIds: readonly string[];
  onSelectActive: () => void;
  onSelectVisible: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  onToggle: (tabId: string, checked: boolean) => void;
}

export function AiContextSelector({
  activeTabId,
  provider,
  registry,
  selection,
  visibleTabIds,
  onSelectActive,
  onSelectVisible,
  onSelectAll,
  onClear,
  onToggle,
}: AiContextSelectorProps) {
  const subscribe = useCallback((listener: () => void) => registry.subscribe(listener), [registry]);
  const getRevision = useCallback(() => registry.getRevision(), [registry]);
  useSyncExternalStore(subscribe, getRevision, getRevision);

  const sessions = provider.listSessions();
  const contextIds = new Set(provider.getContexts(selection).map((context) => context.tabId));
  const visible = new Set(visibleTabIds);
  const count = contextIds.size;

  return (
    <section className="ai-context-selector" aria-label="AI 上下文会话">
      <div className="ai-context-heading">
        <div>
          <span className="ai-context-kicker">AI CONTEXT</span>
          <h2>上下文 · {count} 个会话</h2>
        </div>
        <span className="ai-context-scope">{scopeLabel(selection)}</span>
      </div>
      <div className="ai-context-actions" role="toolbar" aria-label="上下文范围">
        <ScopeButton active={selection.scope === "active"} label="活动" onClick={onSelectActive} />
        <ScopeButton active={selection.scope === "visible"} label="可见" onClick={onSelectVisible} />
        <ScopeButton active={selection.scope === "selected" && contextIds.size === sessions.length} label="全部" onClick={onSelectAll} />
        <ScopeButton active={selection.scope === "selected" && selection.selectedTabIds.length === 0} label="清空" onClick={onClear} />
      </div>
      <div className="ai-context-list">
        {sessions.map((session) => {
          const checked = contextIds.has(session.tabId);
          const modeDriven = selection.scope !== "selected";
          return (
            <label className="ai-context-session" data-selected={checked} key={session.tabId}>
              <input
                checked={checked}
                onChange={(event) => onToggle(session.tabId, event.target.checked)}
                type="checkbox"
              />
              <span className="ai-context-session-copy">
                <span className="ai-context-session-title">
                  <span className="ai-context-status-dot" data-state={session.connectionState} />
                  <strong>{session.title}</strong>
                  {session.tabId === activeTabId && <em>活动</em>}
                </span>
                <span className="ai-context-session-meta">{describeSession(session)}</span>
              </span>
              {modeDriven && visible.has(session.tabId) && <span className="ai-context-visible-mark">可见</span>}
            </label>
          );
        })}
        {sessions.length === 0 && <p className="ai-context-empty">当前没有可用的终端会话</p>}
      </div>
    </section>
  );
}

function ScopeButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button className="ai-context-scope-button" data-active={active} onClick={onClick} type="button">{label}</button>;
}

function scopeLabel(selection: AiContextSelection) {
  if (selection.scope === "active") return "活动会话";
  if (selection.scope === "visible") return "可见会话";
  return "手动选择";
}

function describeSession(session: TerminalContextSessionDescriptor) {
  const connection = session.connection.kind === "local"
    ? shellLabel(session.connection.shell)
    : session.connection.kind === "telnet"
      ? `Telnet · ${session.connection.host}:${session.connection.port}`
      : `Serial · ${session.connection.portName} · ${session.connection.baudRate}`;
  return `${connection} · ${stateLabel(session.connectionState)}`;
}

function shellLabel(shell: string) {
  if (shell === "powershell") return "PowerShell";
  if (shell === "commandPrompt") return "CMD";
  if (shell === "gitBash") return "Git Bash";
  return shell;
}

function stateLabel(state: TerminalContextSessionDescriptor["connectionState"]) {
  if (state === "connected") return "已连接";
  if (state === "connecting") return "连接中";
  if (state === "closing") return "关闭中";
  if (state === "disconnected") return "已断开";
  return "失败";
}
