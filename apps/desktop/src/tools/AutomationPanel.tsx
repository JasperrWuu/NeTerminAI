import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  automationApi,
  type AutomationOutputEvent,
  type AutomationSessionRunStatus,
  type AutomationStatusEvent,
  type AutomationTargetRequest,
} from "../ipc/automation";
import type { TerminalCapability, TerminalSessionDescriptor } from "../capabilities/terminal";
import { MultiSelect, type MultiSelectOption } from "../ui/MultiSelect";
import { Select, type SelectOption } from "../ui/Select";
import { ChevronIcon, CheckIcon, PlayIcon, StopIcon, TrashIcon } from "../workbench/icons";
import {
  createAutomationScript,
  type AutomationScriptDraft,
  type AutomationTarget,
} from "./automationDraft";
import { useAutomationDrafts } from "./useAutomationDrafts";
import { appendRunLog, bufferStdout, flushStdout, formatRunLog, runLogFilename, STDOUT_IDLE_MS, createRunLogs, logRunStatus, logSummary, type RunLogs } from "./automationLogs";

interface AutomationPanelProps {
  activeTabId: string | null;
  terminal: TerminalCapability;
}

interface SessionRunView {
  logs: RunLogs;
  title: string;
  tabId: string;
  sessionId: string | null;
  status: AutomationSessionRunStatus;
  message?: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

interface ScriptExecutionView {
  runId: string;
  status: "running" | "success" | "error" | "cancelled";
  runs: SessionRunView[];
}

const TARGET_MODE_OPTIONS: readonly SelectOption<AutomationTarget["mode"]>[] = [
  { value: "active", label: "当前活动终端" },
  { value: "sessions", label: "选择多个终端" },
];

const MAX_RUN_OUTPUT_CHARS = 200_000;

export function AutomationPanel({ activeTabId, terminal }: AutomationPanelProps) {
  const { scripts, setScripts } = useAutomationDrafts();
  const [executions, setExecutions] = useState<Record<string, ScriptExecutionView>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDeletion, setPendingDeletion] = useState<AutomationScriptDraft | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [, setTerminalRevision] = useState(0);
  const executionRef = useRef(executions);
  executionRef.current = executions;
  const mountedRef = useRef(true);
  const listenersReady = useRef<Promise<boolean>>(Promise.resolve(false));
  const pendingStarts = useRef(new Set<string>());

  const sessions = terminal.listSessions();
  const activeContext = activeTabId ? terminal.getContextForTab(activeTabId) : terminal.getActiveContext();
  const activeDescriptor = activeTabId
    ? sessions.find((session) => session.tabId === activeTabId)
    : activeContext
      ? sessions.find((session) => session.tabId === activeContext.tabId)
      : undefined;
  const activeTarget = activeContext?.target ?? descriptorTarget(activeDescriptor);

  const sessionOptions = useMemo<MultiSelectOption<string>[]>(
    () => sessions.map((session) => ({
      value: session.tabId,
      label: session.title,
      description: `${connectionSummary(session)}${session.connectionState !== "connected" ? " · 暂不可用" : ""}`,
      disabled: session.connectionState !== "connected" || !session.sessionId,
    })),
    [sessions],
  );

  useEffect(() => terminal.subscribe(() => setTerminalRevision((revision) => revision + 1)), [terminal]);

  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    let statusUnlisten: (() => void) | undefined;
    let outputUnlisten: (() => void) | undefined;
    const stdoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const statusReady = automationApi.subscribeStatus((event) => {
      if (!disposed) setExecutions((current) => reduceStatusEvent(current, event));
    }).then((cleanup) => {
      if (disposed) cleanup();
      else statusUnlisten = cleanup;
      return true;
    }).catch(() => {
      // Browser previews do not expose Tauri events; the start action reports that state.
      return false;
    });
    const outputReady = automationApi.subscribeOutput((event) => {
      if (disposed) return;
      setExecutions((current) => reduceOutputEvent(current, event));
      const key = JSON.stringify([event.runId, event.tabId, event.sessionId]);
      clearTimeout(stdoutTimers.get(key));
      stdoutTimers.delete(key);
      if (event.stream === "stdout") stdoutTimers.set(key, setTimeout(() => {
        stdoutTimers.delete(key);
        if (!disposed) setExecutions((current) => {
          const execution = current[event.scriptId];
          if (!execution || execution.runId !== event.runId) return current;
          return { ...current, [event.scriptId]: { ...execution, runs: execution.runs.map((run) =>
            run.tabId === event.tabId && run.sessionId === event.sessionId ? { ...run, logs: flushStdout(run.logs) } : run) } };
        });
      }, STDOUT_IDLE_MS));
    }).then((cleanup) => {
      if (disposed) cleanup();
      else outputUnlisten = cleanup;
      return true;
    }).catch(() => {
      // Browser previews do not expose Tauri events.
      return false;
    });
    listenersReady.current = Promise.all([statusReady, outputReady]).then((ready) => ready.every(Boolean));
    return () => {
      disposed = true;
      mountedRef.current = false;
      pendingStarts.current.clear();
      statusUnlisten?.();
      outputUnlisten?.();
      stdoutTimers.forEach(clearTimeout);
      Object.values(executionRef.current).forEach((execution) => {
        if (execution.status === "running") void automationApi.stop(execution.runId).catch(() => undefined);
      });
    };
  }, []);

  const updateScript = (scriptId: string, update: (script: AutomationScriptDraft) => AutomationScriptDraft) => {
    setScripts((current) => current.map((script) => script.id === scriptId ? update(script) : script));
  };

  const addScript = () => {
    setScripts((current) => [...current, createAutomationScript(current.length + 1)]);
  };

  const removeScript = async (script: AutomationScriptDraft) => {
    if (deleting) return;
    setDeleting(true);
    const execution = executions[script.id];
    try {
      if (execution?.status === "running" && !pendingStarts.current.delete(execution.runId)) await automationApi.stop(execution.runId);
    } catch (error) {
      setNotice(errorMessage(error));
      setDeleting(false);
      return;
    }
    setScripts((current) => {
      const next = current.filter((item) => item.id !== script.id);
      return next.length > 0 ? next : [createAutomationScript(1)];
    });
    setExecutions((current) => {
      const next = { ...current };
      delete next[script.id];
      return next;
    });
    setPendingDeletion(null);
    setDeleting(false);
  };

  const runScript = async (script: AutomationScriptDraft) => {
    const existing = executions[script.id];
    if (existing?.status === "running") return;
    if (!script.code.trim()) {
      setNotice("请先输入 Python 脚本。");
      return;
    }
    const targetTabIds = script.target.mode === "active"
      ? activeTarget ? [activeTarget.tabId] : []
      : script.target.tabIds;
    if (targetTabIds.length === 0) {
      setNotice("请选择至少一个目标终端。");
      return;
    }
    const targetRequests = targetTabIds.map((tabId): AutomationTargetRequest => {
      const descriptor = sessions.find((session) => session.tabId === tabId);
      const context = tabId === activeTarget?.tabId ? terminal.getContextForTab(tabId) : undefined;
      return {
        tabId,
        sessionId: context?.sessionId ?? descriptor?.sessionId ?? null,
        connectionType: context?.connectionKind ?? descriptor?.connectionKind ?? "local",
      };
    });
    const runId = createRunId();
    setNotice(null);
    setExecutions((current) => ({
      ...current,
      [script.id]: {
        runId,
        status: "running",
        runs: targetRequests.map((target) => ({
          logs: target.sessionId ? createRunLogs() : logRunStatus(createRunLogs(), "error", "目标终端已关闭或尚未建立连接"),
          title: sessions.find((session) => session.tabId === target.tabId)?.title ?? "不可用终端",
          tabId: target.tabId,
          sessionId: target.sessionId,
          status: target.sessionId ? "pending" : "error",
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          ...(target.sessionId ? {} : { message: "目标终端已关闭或尚未建立连接" }),
        })),
      },
    }));
    if (!targetRequests.some((target) => target.sessionId)) {
      setExecutions((current) => ({
        ...current,
        [script.id]: { runId, status: "error", runs: current[script.id]?.runs ?? [] },
      }));
      setNotice("没有可用的目标终端。");
      return;
    }
    try {
      pendingStarts.current.add(runId);
      if (!await listenersReady.current) throw new Error("无法订阅自动化运行日志，请重新打开应用后重试。");
      if (!mountedRef.current || !pendingStarts.current.delete(runId)) return;
      await automationApi.start({ runId, scriptId: script.id, code: script.code, targets: targetRequests });
    } catch (error) {
      pendingStarts.current.delete(runId);
      if (!mountedRef.current) return;
      setExecutions((current) => {
        const execution = current[script.id];
        if (!execution || execution.runId !== runId) return current;
        return { ...current, [script.id]: { ...execution, status: "error", runs: execution.runs.map((run) => run.status === "success" ? run : { ...run, status: "error", message: errorMessage(error), logs: logRunStatus(run.logs, "error", errorMessage(error)) }) } };
      });
      setNotice(errorMessage(error));
    }
  };

  const stopScript = async (scriptId: string) => {
    const execution = executions[scriptId];
    if (!execution || execution.status !== "running") return;
    try {
      if (!pendingStarts.current.delete(execution.runId)) await automationApi.stop(execution.runId);
      if (!mountedRef.current) return;
      setExecutions((current) => {
        const latest = current[scriptId];
        if (!latest || latest.runId !== execution.runId) return current;
        return {
          ...current,
          [scriptId]: {
            ...latest,
            status: "cancelled",
            runs: latest.runs.map((run) => run.status === "success" || run.status === "error" ? run : { ...run, status: "cancelled", message: "运行已停止", logs: logRunStatus(run.logs, "cancelled") }),
          },
        };
      });
    } catch (error) {
      if (mountedRef.current) setNotice(errorMessage(error));
    }
  };

  return (
    <div className="automation-panel">
      <header className="automation-heading">
        <div>
          <span className="automation-kicker">TOOLS</span>
          <h2>终端自动化</h2>
          <p>用轻量 Python 脚本把重复操作交给多个终端。</p>
        </div>
        <button aria-label="新建脚本" className="automation-add-button" onClick={addScript} title="新建脚本" type="button">
          <span>新建脚本</span>
          <span aria-hidden="true">＋</span>
        </button>
      </header>

      {notice && <p className="automation-notice" role="status">{notice}</p>}
      {pendingDeletion && (
        <div className="automation-delete-confirm" role="alert" onKeyDown={(event) => {
          if (event.key === "Escape" && !deleting) setPendingDeletion(null);
        }}>
          <div><strong>删除「{pendingDeletion.name}」？</strong><small>脚本无法恢复。正在运行的任务会先停止。</small></div>
          <div className="automation-confirm-actions">
            <button autoFocus className="secondary-button" disabled={deleting} onClick={() => setPendingDeletion(null)} type="button">取消</button>
            <button className="secondary-button automation-delete-action" disabled={deleting} onClick={() => void removeScript(pendingDeletion)} type="button">{deleting ? "正在删除…" : "删除脚本"}</button>
          </div>
        </div>
      )}
      <div className="automation-script-list">
        {scripts.map((script) => {
          const execution = executions[script.id];
          return (
            <AutomationScriptBlock
              activeDescriptor={activeDescriptor}
              activeTarget={activeTarget}
              execution={execution}
              key={script.id}
              onChange={(update) => updateScript(script.id, update)}
              onRemove={() => setPendingDeletion(script)}
              onRun={() => void runScript(script)}
              onStop={() => void stopScript(script.id)}
              script={script}
              sessionOptions={sessionOptions}
              sessions={sessions}
            />
          );
        })}
      </div>
    </div>
  );
}

function AutomationScriptBlock({
  activeDescriptor,
  activeTarget,
  execution,
  onChange,
  onRemove,
  onRun,
  onStop,
  script,
  sessionOptions,
  sessions,
}: {
  activeDescriptor?: TerminalSessionDescriptor;
  activeTarget?: { tabId: string; sessionId: string };
  execution?: ScriptExecutionView;
  onChange: (update: (script: AutomationScriptDraft) => AutomationScriptDraft) => void;
  onRemove: () => void;
  onRun: () => void;
  onStop: () => void;
  script: AutomationScriptDraft;
  sessionOptions: readonly MultiSelectOption<string>[];
  sessions: readonly TerminalSessionDescriptor[];
}) {
  const running = execution?.status === "running";
  const targetSummary = targetSummaryFor(script.target, sessions, activeDescriptor, activeTarget);
  return (
    <section className="automation-script" data-collapsed={script.collapsed}>
      <header className="automation-script-header">
        <button
          aria-controls={`automation-script-${script.id}`}
          aria-expanded={!script.collapsed}
          aria-label={`${script.collapsed ? "展开" : "折叠"}${script.name}`}
          className="automation-disclosure"
          onClick={() => onChange((current) => ({ ...current, collapsed: !current.collapsed }))}
          type="button"
        >
          <ChevronIcon />
        </button>
        <div className="automation-script-title">
          <input
            aria-label="脚本名称"
            className="automation-script-name"
            onChange={(event) => onChange((current) => ({ ...current, name: event.target.value }))}
            value={script.name}
          />
          <span>{targetSummary}</span>
        </div>
        <button
          aria-label={running ? `停止${script.name}` : `运行${script.name}`}
          className={`automation-run-button${running ? " is-running" : ""}`}
          onClick={running ? onStop : onRun}
          title={running ? "停止" : "运行"}
          type="button"
        >
          {running ? <StopIcon /> : <PlayIcon />}
        </button>
        <button aria-label={`删除${script.name}`} className="automation-delete-button" onClick={onRemove} title="删除脚本" type="button">
          <TrashIcon />
        </button>
      </header>

      {!script.collapsed && (
        <div className="automation-script-body" id={`automation-script-${script.id}`}>
          <PythonEditor code={script.code} onChange={(code) => onChange((current) => ({ ...current, code }))} onRun={onRun} />
          <details className="automation-send-help">
            <summary>send() 参数与用法</summary>
            <code>send(command, timeout=None, responses=None) → str</code>
            <dl>
              <dt>command</dt><dd>命令文本，自动回车；返回回显，不含最终提示符。</dd>
              <dt>timeout</dt><dd>整条命令的等待秒数，默认 30 秒；分页不会重置计时。</dd>
              <dt>responses</dt><dd>正则表达式与回答的配对列表；仅按明确规则回答确认，同一规则可匹配多次。More 自动按空格。</dd>
            </dl>
            <pre>{'output = send("display health", timeout=60)\nprint(output)\n\n# 仅在确定允许回答 y 时使用\noutput = send(command, responses=[(r"(?i).*\\[y\\s*/\\s*n\\]", "y")])'}</pre>
          </details>
          <div className="automation-target">
            <div className="automation-subheading">目标终端</div>
            <Select
              ariaLabel="目标终端模式"
              className="automation-mode-select"
              onChange={(mode) => onChange((current) => ({
                ...current,
                target: mode === "active" ? { mode: "active" } : current.target.mode === "sessions" ? current.target : { mode: "sessions", tabIds: [] },
              }))}
              options={TARGET_MODE_OPTIONS}
              value={script.target.mode}
            />
            {script.target.mode === "active" ? (
              <div className="automation-active-target">
                <strong>{activeDescriptor?.title ?? "暂无活动终端"}</strong>
                <span>{activeDescriptor ? connectionSummary(activeDescriptor) : "切换到已打开的终端后运行"}</span>
              </div>
            ) : (
              <MultiSelect
                ariaLabel="选择目标终端"
                className="automation-session-select"
                emptyLabel="暂无已打开的终端"
                onChange={(tabIds) => onChange((current) => ({ ...current, target: { mode: "sessions", tabIds } }))}
                options={sessionOptions}
                placeholder="请选择一个或多个终端"
                selectedLabel={targetSummary}
                values={script.target.tabIds}
              />
            )}
          </div>
          {execution && <ExecutionStatus execution={execution} sessions={sessions} scriptName={script.name} />}
        </div>
      )}
    </section>
  );
}

function ExecutionStatus({ execution, sessions, scriptName }: { execution: ScriptExecutionView; sessions: readonly TerminalSessionDescriptor[]; scriptName: string }) {
  const completed = execution.runs.filter((run) => run.status === "success" || run.status === "error" || run.status === "cancelled").length;
  return (
    <div className="automation-execution" aria-live="polite">
      <div className="automation-execution-heading">
        <span>运行状态</span>
        <small>{completed}/{execution.runs.length} 完成</small>
      </div>
      <div className="automation-run-list">
        {execution.runs.map((run) => {
          const session = sessions.find((candidate) => candidate.tabId === run.tabId);
          return (
            <div key={run.tabId}>
              <div className="automation-run-row">
                <span className={`automation-status-icon automation-status-${run.status}`}>
                  {run.status === "success" ? <CheckIcon /> : run.status === "running" ? <i /> : run.status === "error" ? "!" : run.status === "cancelled" ? "–" : "·"}
                </span>
                <span className="automation-run-name">{session?.title ?? run.title}</span>
                <span className="automation-run-state">{runStatusLabel(run.status)}</span>
                {run.message && <span className="automation-run-message" title={run.message}>{run.message}</span>}
              </div>
            </div>
          );
        })}
      </div>
      <details className="automation-logs-disclosure">
        <summary>日志 <small>{execution.runs.reduce((sum, run) => sum + run.logs.entries.length, 0)} 条</small></summary>
        {execution.runs.map((run) => <SessionRunLogs key={`${execution.runId}-${run.tabId}`} run={run} scriptName={scriptName} />)}
      </details>
    </div>
  );
}

function SessionRunLogs({ run, scriptName }: { run: SessionRunView; scriptName: string }) {
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [saveError, setSaveError] = useState("");
  const alive = useRef(true);
  const saving = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(saveTimer.current); }; }, []);
  const save = async () => {
    if (saving.current) return;
    saving.current = true; clearTimeout(saveTimer.current); setSaveState("saving"); setSaveError("");
    try {
      const saved = await automationApi.saveLog(runLogFilename(scriptName, run.title), formatRunLog(run.logs));
      if (!alive.current) return;
      setSaveState(saved ? "saved" : "idle");
      if (saved) saveTimer.current = setTimeout(() => setSaveState("idle"), 1500);
    } catch (error) {
      if (alive.current) { setSaveError(errorMessage(error)); setSaveState("idle"); }
    } finally { saving.current = false; }
  };
  const ref = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => { if (ref.current && follow.current) ref.current.scrollTop = ref.current.scrollHeight; }, [run.logs]);
  return <section className="automation-log-session"><header className="automation-log-heading"><h4>{run.title}</h4>
    <button type="button" className="secondary-button" disabled={saveState === "saving" || (!run.logs.entries.length && !run.logs.stdout)} onClick={() => void save()}>
      {saveState === "saved" && <CheckIcon />}{saveState === "saved" ? "已保存" : saveState === "saving" ? "正在保存…" : "保存日志"}
    </button></header>
    {saveError && <p className="field-error" role="alert">{saveError}</p>}
    {run.logs.truncated && <small className="automation-output-truncated">日志已达显示上限，仅保留最近内容。</small>}
    <div className="automation-log-lines" ref={ref} onScroll={(event) => {
      const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
    }}>
      {run.logs.entries.map((entry) => <div key={entry.id} className="automation-log-line" data-level={entry.level}>
        <time>{new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false })}</time><span className="automation-log-level">{entry.level.toUpperCase()}</span>
        {entry.level === "error" && entry.message.trimEnd().includes("\n")
          ? <details><summary>{logSummary(entry)}</summary><RunOutputBlock>{entry.message}</RunOutputBlock></details>
          : <span className="automation-log-message">{entry.message}</span>}
      </div>)}
    </div>
  </section>;
}

function RunOutputBlock({ children, className = "", truncated = false }: { children: string; className?: string; truncated?: boolean }) {
  const outputRef = useRef<HTMLPreElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const output = outputRef.current;
    if (output && stickToBottomRef.current) output.scrollTop = output.scrollHeight;
  }, [children]);

  return (
    <pre
      className={`automation-run-output${className ? ` ${className}` : ""}`}
      onScroll={(event) => {
        const output = event.currentTarget;
        stickToBottomRef.current = output.scrollHeight - output.scrollTop - output.clientHeight < 16;
      }}
      ref={outputRef}
    >
      {truncated && <span className="automation-output-truncated">输出过长，已截断，仅显示末尾内容。{"\n"}</span>}
      {children}
    </pre>
  );
}

function PythonEditor({ code, onChange, onRun }: { code: string; onChange: (code: string) => void; onRun: () => void }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [currentLine, setCurrentLine] = useState(0);
  const lines = Math.max(1, code.split("\n").length);

  const syncScroll = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (highlightRef.current) {
      highlightRef.current.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
    }
    if (gutterRef.current) gutterRef.current.style.transform = `translateY(${-textarea.scrollTop}px)`;
  };

  const syncCurrentLine = (position = textareaRef.current?.selectionStart ?? 0) => {
    setCurrentLine(code.slice(0, position).split("\n").length - 1);
  };

  const applyEdit = (next: string, start: number, end = start) => {
    onChange(next);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(start, end);
      syncCurrentLine(start);
    });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const textarea = event.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (event.ctrlKey && !event.shiftKey && event.key === "Enter") {
      event.preventDefault();
      onRun();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      if (event.shiftKey) {
        const range = lineRange(code, start, end);
        const selected = code.slice(range.start, range.end);
        const lines = selected.split("\n");
        let removedBeforeStart = 0;
        let removedTotal = 0;
        const nextLines = lines.map((line, index) => {
          const remove = Math.min(4, (line.match(/^ {1,4}/u)?.[0].length ?? 0));
          if (index === 0) removedBeforeStart = remove;
          removedTotal += remove;
          return line.slice(remove);
        });
        applyEdit(`${code.slice(0, range.start)}${nextLines.join("\n")}${code.slice(range.end)}`, Math.max(range.start, start - removedBeforeStart), Math.max(range.start, end - removedTotal));
      } else if (start !== end) {
        const range = lineRange(code, start, end);
        const lines = code.slice(range.start, range.end).split("\n");
        const next = lines.map((line) => `    ${line}`).join("\n");
        applyEdit(`${code.slice(0, range.start)}${next}${code.slice(range.end)}`, start + 4, end + lines.length * 4);
      } else {
        applyEdit(`${code.slice(0, start)}    ${code.slice(end)}`, start + 4);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const lineStart = code.lastIndexOf("\n", start - 1) + 1;
      const line = code.slice(lineStart, start);
      const indent = line.match(/^ */u)?.[0] ?? "";
      const extra = line.trimEnd().endsWith(":") ? "    " : "";
      const insertion = `\n${indent}${extra}`;
      applyEdit(`${code.slice(0, start)}${insertion}${code.slice(end)}`, start + insertion.length);
      return;
    }
    if (event.key === "Backspace" && start === end) {
      const lineStart = code.lastIndexOf("\n", start - 1) + 1;
      const prefix = code.slice(lineStart, start);
      if (/^ *$/u.test(prefix) && prefix.length > 0) {
        event.preventDefault();
        const remove = prefix.length % 4 || 4;
        applyEdit(`${code.slice(0, start - remove)}${code.slice(start)}`, start - remove);
      }
    }
  };

  return (
    <div className="automation-editor">
      <div className="automation-editor-toolbar"><span>Python</span><small>Ctrl + Enter 运行</small></div>
      <div className="automation-editor-body">
        <div aria-hidden="true" className="automation-line-numbers" ref={gutterRef}>{Array.from({ length: lines }, (_, index) => <span key={index}>{index + 1}</span>)}</div>
        <div className="automation-code-layer">
          <pre aria-hidden="true" className="automation-highlight" dangerouslySetInnerHTML={{ __html: highlightPython(code) }} ref={highlightRef} />
          <textarea
            aria-label="Python 脚本编辑器"
            className="automation-code-input"
            onChange={(event) => { onChange(event.target.value); syncCurrentLine(event.target.selectionStart); }}
            onClick={() => syncCurrentLine()}
            onKeyDown={handleKeyDown}
            onKeyUp={() => syncCurrentLine()}
            onScroll={syncScroll}
            ref={textareaRef}
            spellCheck={false}
            style={{
              "--automation-current-line-start": `${currentLine * 19}px`,
              "--automation-current-line-end": `${(currentLine + 1) * 19}px`,
            } as CSSProperties}
            value={code}
          />
        </div>
      </div>
    </div>
  );
}

export function highlightPython(source: string) {
  const pattern = /(#.*$|(?:[rubfRUBF]{0,2})(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(?:and|as|break|class|continue|def|elif|else|for|from|if|in|import|not|or|pass|return|True|False|None|while|with|yield)\b|\b\d+(?:\.\d+)?\b)/gm;
  let cursor = 0;
  let output = "";
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    output += escapeHtml(source.slice(cursor, index));
    const token = match[0];
    const kind = token.startsWith("#") ? "comment" : token.includes("\"") || token.includes("'") ? "string" : /^\d/u.test(token) ? "number" : "keyword";
    output += `<span class="python-token-${kind}">${escapeHtml(token)}</span>`;
    cursor = index + token.length;
  }
  return `${output}${escapeHtml(source.slice(cursor))}`;
}

function lineRange(value: string, start: number, end: number) {
  const rangeStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const nextNewline = value.indexOf("\n", end);
  return { start: rangeStart, end: nextNewline === -1 ? value.length : nextNewline };
}

function targetSummaryFor(target: AutomationTarget, sessions: readonly TerminalSessionDescriptor[], activeDescriptor?: TerminalSessionDescriptor, activeTarget?: { tabId: string; sessionId: string }) {
  if (target.mode === "active") return activeTarget ? `当前 · ${activeDescriptor?.title ?? "活动终端"}` : "暂无活动终端";
  const selected = target.tabIds.map((tabId) => sessions.find((session) => session.tabId === tabId)?.title).filter(Boolean) as string[];
  const unavailable = target.tabIds.length - selected.length;
  if (target.tabIds.length === 0) return "未选择终端";
  if (selected.length <= 2 && unavailable === 0) return selected.join(" · ");
  return `${target.tabIds.length} 个终端${unavailable > 0 ? ` · ${unavailable} 个不可用` : ""}`;
}

function descriptorTarget(descriptor?: TerminalSessionDescriptor) {
  return descriptor?.sessionId ? { tabId: descriptor.tabId, sessionId: descriptor.sessionId } : undefined;
}

function connectionSummary(session: TerminalSessionDescriptor) {
  if (session.connection.kind === "local") return `本地 · ${session.connection.shell}`;
  if (session.connection.kind === "serial") return `串口 · ${session.connection.portName}`;
  return `${session.connection.kind.toUpperCase()} · ${session.connection.host}:${session.connection.port}`;
}

function reduceStatusEvent(current: Record<string, ScriptExecutionView>, event: AutomationStatusEvent) {
  const execution = current[event.scriptId];
  if (!execution || execution.runId !== event.runId) return current;
  const runs = execution.runs.map((run) => run.tabId === event.tabId && run.sessionId === event.sessionId
    ? { ...run, status: event.status, logs: logRunStatus(run.logs, event.status, event.message, event.timestamp), ...(event.message ? { message: event.message } : {}) }
    : run);
  const status = aggregateStatus(runs);
  return { ...current, [event.scriptId]: { ...execution, runs, status } };
}

function reduceOutputEvent(current: Record<string, ScriptExecutionView>, event: AutomationOutputEvent) {
  const execution = current[event.scriptId];
  if (!execution || execution.runId !== event.runId) return current;
  const runs = execution.runs.map((run) => {
    if (run.tabId !== event.tabId
      || run.sessionId !== event.sessionId
    ) return run;
    const logs = event.stream === "stdout" ? bufferStdout(run.logs, event.data, event.timestamp)
      : appendRunLog(run.logs, event.stream === "send" ? "send" : "error", event.data, event.timestamp, event.stream === "stderr");
    if (event.stream === "send") return { ...run, logs };
    const key = event.stream === "stderr" ? "stderr" : "stdout";
    const nextOutput = `${run[key]}${event.data}`;
    const truncated = nextOutput.length > MAX_RUN_OUTPUT_CHARS;
    const truncatedKey = key === "stderr" ? "stderrTruncated" : "stdoutTruncated";
    return {
      ...run,
      logs,
      [key]: truncated ? nextOutput.slice(-MAX_RUN_OUTPUT_CHARS) : nextOutput,
      [truncatedKey]: run[truncatedKey] || truncated,
    };
  });
  return { ...current, [event.scriptId]: { ...execution, runs } };
}

function aggregateStatus(runs: readonly SessionRunView[]): ScriptExecutionView["status"] {
  if (runs.length > 0 && runs.every((run) => run.status === "success" || run.status === "error" || run.status === "cancelled")) {
    if (runs.every((run) => run.status === "success")) return "success";
    if (runs.some((run) => run.status === "error")) return "error";
    return "cancelled";
  }
  return "running";
}

function runStatusLabel(status: AutomationSessionRunStatus) {
  return status === "pending" ? "等待中" : status === "running" ? "运行中" : status === "success" ? "完成" : status === "cancelled" ? "已停止" : "失败";
}

function createRunId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `automation-run-${crypto.randomUUID()}`;
  return `automation-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "自动化运行失败，请检查 Python 与终端连接。";
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
