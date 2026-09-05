import type { TerminalContextProvider } from "../context/TerminalContextProvider";
import type { AiContextSelection } from "../context/selection";
import type { TerminalContextSnapshot } from "../context/types";
import type {
  ContextCompressionInput,
  ContextCompressionUpdate,
  ContextCompressor,
  MultiSessionContextAssembly,
  NormalizedSessionContext,
  SessionContextMemory,
  StructuredSessionContext,
} from "./types";

const MAX_MEMORY_FACTS = 24;
const MAX_MEMORY_EVENTS = 24;
const MAX_MEMORY_ENTRY_CHARS = 512;
const MAX_SUMMARY_CHARS = 2 * 1024;
const MAX_NORMALIZED_CHARS = 32 * 1024;

export function normalizeContextSnapshot(snapshot: TerminalContextSnapshot): NormalizedSessionContext {
  return {
    target: snapshot.target,
    title: snapshot.title,
    connectionKind: snapshot.connectionKind,
    connectionState: snapshot.connectionState,
    connection: snapshot.connection,
    recentOutput: normalizeTerminalText(snapshot.terminal.recentText),
    ...(snapshot.terminal.selection ? { selection: redactSensitive(snapshot.terminal.selection) } : {}),
    ...(snapshot.disconnectReason ? { disconnectReason: snapshot.disconnectReason } : {}),
    ...(snapshot.error ? { error: snapshot.error } : {}),
  };
}

/** Keeps per-tab memory isolated and resets it when a tab receives a new runtime. */
export class SessionContextMemoryStore {
  private readonly memories = new Map<string, SessionContextMemory>();

  get(tabId: string) {
    return this.memories.get(tabId);
  }

  prepare(context: NormalizedSessionContext): SessionContextMemory {
    const existing = this.memories.get(context.target.tabId);
    if (existing?.sessionId === context.target.sessionId) return cloneMemory(existing);
    return {
      tabId: context.target.tabId,
      sessionId: context.target.sessionId,
      summary: "",
      importantFacts: [],
      recentEvents: [],
      lastUpdatedAt: 0,
      stale: Boolean(existing),
    };
  }

  commit(memory: SessionContextMemory) {
    this.memories.set(memory.tabId, {
      ...memory,
      summary: truncateUnicode(memory.summary, MAX_SUMMARY_CHARS),
      importantFacts: boundedEntries(memory.importantFacts, MAX_MEMORY_FACTS),
      recentEvents: boundedEntries(memory.recentEvents, MAX_MEMORY_EVENTS),
    });
  }

  reconcile(openTabIds: readonly string[]) {
    const open = new Set(openTabIds);
    for (const tabId of this.memories.keys()) {
      if (!open.has(tabId)) this.memories.delete(tabId);
    }
  }

  clear() {
    this.memories.clear();
  }
}

/** A deterministic baseline compressor that works even when no AI provider is configured. */
export class DeterministicContextCompressor implements ContextCompressor {
  compress({ normalized, previous }: ContextCompressionInput): ContextCompressionUpdate {
    const state = `状态：${normalized.connectionState}`;
    const reason = normalized.disconnectReason ? `，原因：${normalized.disconnectReason}` : "";
    const summary = truncateUnicode(`${normalized.title}（${normalized.connectionKind}）${state}${reason}`, MAX_SUMMARY_CHARS);
    const recentLines = normalized.recentOutput
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .slice(-3)
      .map((line) => `最近输出：${line}`);
    const stateFacts = [`连接状态：${normalized.connectionState}`, ...recentLines];
    if (normalized.error) stateFacts.push(`错误类别：${normalized.error}`);
    if (normalized.disconnectReason) stateFacts.push(`断开原因：${normalized.disconnectReason}`);
    return {
      summary,
      importantFacts: unique([...previous.importantFacts, ...stateFacts]),
      recentEvents: unique([
        ...previous.recentEvents,
        ...(normalized.disconnectReason ? [`${normalized.title}：${normalized.disconnectReason}`] : []),
        ...(normalized.error ? [`${normalized.title}：${normalized.error}`] : []),
      ]),
    };
  }
}

export class ContextProcessingPipeline {
  private readonly provider: TerminalContextProvider;
  private readonly memoryStore: SessionContextMemoryStore;
  private readonly compressor: ContextCompressor;

  constructor(
    provider: TerminalContextProvider,
    memoryStore = new SessionContextMemoryStore(),
    compressor: ContextCompressor = new DeterministicContextCompressor(),
  ) {
    this.provider = provider;
    this.memoryStore = memoryStore;
    this.compressor = compressor;
  }

  capture(selection: AiContextSelection): MultiSessionContextAssembly {
    const sessions = this.provider.getContexts(selection).map((snapshot) => this.processSnapshot(snapshot));
    this.memoryStore.reconcile(this.provider.listSessions().map((session) => session.tabId));
    const active = this.provider.getActiveContext();
    return {
      version: 1,
      capturedAt: Date.now(),
      ...(active ? { activeTabId: active.tabId } : {}),
      sessions,
    };
  }

  private processSnapshot(snapshot: TerminalContextSnapshot): StructuredSessionContext {
    const normalized = normalizeContextSnapshot(snapshot);
    const previous = this.memoryStore.prepare(normalized);
    const update = this.compressor.compress({ normalized, previous });
    const memory: SessionContextMemory = {
      ...previous,
      ...update,
      lastUpdatedAt: Date.now(),
      stale: false,
    };
    this.memoryStore.commit(memory);
    return {
      target: normalized.target,
      title: normalized.title,
      connectionKind: normalized.connectionKind,
      connectionState: normalized.connectionState,
      connection: normalized.connection,
      memory,
      recentOutput: normalized.recentOutput,
      ...(normalized.selection ? { selection: normalized.selection } : {}),
      ...(normalized.disconnectReason ? { disconnectReason: normalized.disconnectReason } : {}),
      ...(normalized.error ? { error: normalized.error } : {}),
    };
  }
}

function normalizeTerminalText(value: string) {
  const lines = value.split("\n").map((line) => redactSensitive(line.replace(/[ \t]+$/u, "")));
  const collapsed: string[] = [];
  let previous = "";
  let repeatCount = 0;
  for (const line of lines) {
    if (line && line === previous) {
      repeatCount += 1;
      if (repeatCount <= 3) collapsed.push(line);
      continue;
    }
    if (repeatCount > 3) collapsed.push(`[重复输出 x${repeatCount}]`);
    previous = line;
    repeatCount = line ? 1 : 0;
    collapsed.push(line);
  }
  if (repeatCount > 3) collapsed.push(`[重复输出 x${repeatCount}]`);
  return truncateUnicode(collapsed.join("\n"), MAX_NORMALIZED_CHARS);
}

function redactSensitive(value: string) {
  return value
    .replace(/\b(password|passwd|secret)\s*[:=]\s*\S+/giu, "$1: [redacted]")
    .replace(/(密码|口令)\s*[:：=]\s*\S+/gu, "$1：[已隐藏]");
}

function boundedEntries(values: readonly string[], maximum: number) {
  return unique(values)
    .map((value) => truncateUnicode(value, MAX_MEMORY_ENTRY_CHARS))
    .slice(-maximum);
}

function unique(values: readonly string[]) {
  return [...new Set(values)];
}

function cloneMemory(memory: SessionContextMemory): SessionContextMemory {
  return {
    ...memory,
    importantFacts: [...memory.importantFacts],
    recentEvents: [...memory.recentEvents],
  };
}

function truncateUnicode(value: string, maximum: number) {
  const points = Array.from(value);
  if (points.length <= maximum) return value;
  if (maximum <= 1) return "…";
  return `…${points.slice(-(maximum - 1)).join("")}`;
}
