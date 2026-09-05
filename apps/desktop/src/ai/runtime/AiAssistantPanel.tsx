import { useState, useSyncExternalStore } from "react";
import type { AiAssistant } from "./AiAssistant.ts";
import type { AiContextSelection } from "../context/selection.ts";
import type { TerminalCommandProposal } from "../analysis/types.ts";
import type { AiProviderMode, AiProviderPreset } from "../providers/types.ts";

interface AiAssistantPanelProps {
  assistant: AiAssistant;
  selection: AiContextSelection;
  contextCount: number;
  providerMode: AiProviderMode;
  providerPreset: AiProviderPreset;
  enabled: boolean;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
}

export function AiAssistantPanel({ assistant, selection, contextCount, providerMode, providerPreset, enabled, apiKey, onApiKeyChange }: AiAssistantPanelProps) {
  const snapshot = useSyncExternalStore(assistant.subscribe, assistant.getSnapshot, assistant.getSnapshot);
  const [question, setQuestion] = useState("");
  const [proposalState, setProposalState] = useState<Record<string, "executed" | "rejected">>({});
  const proposals = snapshot.response?.proposals ?? [];
  const scopeText = selection.scope === "active" ? "活动会话" : selection.scope === "visible" ? "可见会话" : selection.scope === "selected" ? "手动选择" : "全部会话";
  const answer = snapshot.status === "running" ? snapshot.streamedText : snapshot.response?.diagnosis ?? "";

  const send = () => {
    if (!question.trim() || snapshot.status === "running") return;
    const value = question;
    setQuestion("");
    void assistant.send(selection, value);
  };

  const runProposal = (proposal: TerminalCommandProposal) => {
    const result = assistant.getActionExecutor().execute(proposal, true);
    setProposalState((current) => ({ ...current, [proposal.id]: result.status === "executed" ? "executed" : "rejected" }));
  };

  return (
    <section className="ai-assistant-panel" aria-label="AI 对话">
      <div className="ai-assistant-meta"><span>{scopeText} · {contextCount} 个会话</span><span>{providerMode === "api" ? "兼容 API" : presetLabel(providerPreset)}</span></div>
      {providerMode === "api" && <label className="ai-runtime-key"><span>本次运行 API Key</span><input onChange={(event) => onApiKeyChange(event.target.value)} placeholder="不会保存到设置" type="password" value={apiKey} /></label>}
      {!enabled && <div className="ai-assistant-error">AI 助手已在设置中停用。</div>}
      <div className="ai-assistant-transcript" aria-live="polite">
        {snapshot.status === "idle" && <p className="ai-assistant-hint">选择会话后，问问设备状态、异常原因或下一步检查。</p>}
        {snapshot.question && <div className="ai-message ai-message-user">{snapshot.question}</div>}
        {answer && <div className="ai-message ai-message-assistant"><div className="ai-answer">{answer}</div>{snapshot.status === "running" && <span className="ai-streaming-dot" aria-label="正在生成" />}</div>}
        {snapshot.error && <div className="ai-assistant-error">{snapshot.error}</div>}
        {snapshot.status === "completed" && proposals.length > 0 && <div className="ai-proposals"><div className="ai-proposals-heading">建议执行（需你确认）</div>{proposals.map((proposal) => <div className="ai-proposal" key={proposal.id}><code>{proposal.command}</code><p>{proposal.explanation}</p><div><button disabled={proposalState[proposal.id] === "executed"} onClick={() => runProposal(proposal)} type="button">{proposalState[proposal.id] === "executed" ? "已执行" : "运行"}</button><button className="ai-proposal-reject" disabled={Boolean(proposalState[proposal.id])} onClick={() => setProposalState((current) => ({ ...current, [proposal.id]: "rejected" }))} type="button">{proposalState[proposal.id] === "rejected" ? "已拒绝" : "拒绝"}</button></div></div>)}</div>}
      </div>
      <div className="ai-assistant-composer"><textarea disabled={!enabled || snapshot.status === "running"} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); } }} placeholder="向 AI 提问…（Ctrl+Enter 发送）" rows={3} value={question} />{snapshot.status === "running" ? <button className="ai-stop-button" onClick={() => assistant.stop()} type="button">停止</button> : <button className="ai-send-button" disabled={!enabled || !question.trim() || contextCount === 0} onClick={send} type="button">发送</button>}</div>
      {(snapshot.status === "error" || snapshot.status === "cancelled" || snapshot.status === "completed") && <div className="ai-assistant-actions"><button onClick={() => void assistant.retry()} type="button">重试</button><button onClick={() => assistant.resetConversation()} type="button">清空对话</button>{snapshot.context && <span>基于 {snapshot.context.sessions.length} 个会话 · {new Date(snapshot.context.capturedAt).toLocaleTimeString()}</span>}</div>}
    </section>
  );
}

function presetLabel(preset: AiProviderPreset) {
  return preset === "claude" ? "Claude CLI" : preset === "opencode" ? "OpenCode CLI" : preset === "powershell" ? "PowerShell" : "本地 CLI";
}
