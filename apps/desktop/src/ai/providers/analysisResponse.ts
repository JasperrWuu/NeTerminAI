import type { ContextAnalysisResult, TerminalCommandProposal } from "../analysis/types";

export function parseAnalysisResponse(text: string): ContextAnalysisResult {
  const trimmed = text.trim();
  const candidate = extractJson(trimmed);
  if (candidate) {
    const value = safeJson(candidate);
    if (value && isAnalysis(value)) return value;
  }
  return {
    diagnosis: trimmed || "AI 未返回可显示的分析结果。",
    evidence: [],
    suggestedChecks: [],
    proposals: [],
  };
}

function extractJson(value: string) {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fenced?.[1]) return fenced[1].trim();
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  return start >= 0 && end > start ? value.slice(start, end + 1) : null;
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function isAnalysis(value: unknown): value is ContextAnalysisResult {
  if (!value || typeof value !== "object") return false;
  const root = value as Record<string, unknown>;
  return typeof root.diagnosis === "string"
    && Array.isArray(root.evidence)
    && root.evidence.every((item) => isEvidence(item))
    && Array.isArray(root.suggestedChecks)
    && root.suggestedChecks.every((item) => typeof item === "string")
    && Array.isArray(root.proposals)
    && root.proposals.every((item) => isProposal(item));
}

function isEvidence(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const root = value as Record<string, unknown>;
  return isTarget(root.target) && typeof root.detail === "string";
}

function isProposal(value: unknown): value is TerminalCommandProposal {
  if (!value || typeof value !== "object") return false;
  const root = value as Record<string, unknown>;
  return typeof root.id === "string"
    && isTarget(root.target)
    && typeof root.command === "string"
    && typeof root.explanation === "string";
}

function isTarget(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const root = value as Record<string, unknown>;
  return typeof root.tabId === "string" && typeof root.sessionId === "string";
}
