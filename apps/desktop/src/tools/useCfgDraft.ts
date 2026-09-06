import { useEffect, useRef, useState } from "react";
import { persistCfgDraft, readCfgDraft } from "./cfgDraft";

export function useCfgDraft() {
  const [draft, setDraft] = useState(readCfgDraft);
  const [saveError, setSaveError] = useState(false);
  const latest = useRef(draft);
  latest.current = draft;

  useEffect(() => {
    const timer = window.setTimeout(() => setSaveError(!persistCfgDraft(draft)), 400);
    return () => window.clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    const flush = () => { persistCfgDraft(latest.current); };
    const onHidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []);
  return { draft, setDraft, saveError };
}
