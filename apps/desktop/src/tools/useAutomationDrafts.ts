import { useEffect, useRef, useState } from "react";
import { persistAutomationScripts, readAutomationScripts, type AutomationScriptDraft } from "./automationDraft";

export function useAutomationDrafts() {
  const [scripts, setScripts] = useState<AutomationScriptDraft[]>(readAutomationScripts);
  const latest = useRef(scripts);
  latest.current = scripts;

  useEffect(() => {
    const timer = window.setTimeout(() => persistAutomationScripts(scripts), 400);
    return () => window.clearTimeout(timer);
  }, [scripts]);

  useEffect(() => {
    const flush = () => { persistAutomationScripts(latest.current); };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return { scripts, setScripts };
}
