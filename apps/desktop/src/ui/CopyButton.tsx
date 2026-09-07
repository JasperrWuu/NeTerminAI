import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "../workbench/icons";
import "./copyButton.css";

/** Uses the same system clipboard API as the existing tool copy actions. */
export function CopyButton({ value, label, onError }: { value: string; label: string; onError: (message: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    generation.current++; setCopied(false); setPending(false);
    return () => { generation.current++; clearTimeout(timer.current); };
  }, [value]);
  const copy = async () => {
    const current = generation.current; setPending(true);
    try {
      await navigator.clipboard.writeText(value);
      if (current !== generation.current) return;
      setCopied(true); clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch { if (current === generation.current) onError("复制失败，请检查剪贴板权限后重试。"); }
    finally { if (current === generation.current) setPending(false); }
  };
  return <button className="copy-result-button" data-copied={copied} aria-label={copied ? "已复制" : `复制${label}`}
    title={copied ? "已复制" : `复制${label}`} type="button" disabled={pending} onClick={() => void copy()}>
    {copied ? <CheckIcon /> : <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M15 8V4H4v11h4" /></svg>}
    <span className="copy-result-status" role="status">{copied ? "已复制" : ""}</span>
  </button>;
}
