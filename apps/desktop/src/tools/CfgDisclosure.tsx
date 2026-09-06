import { useId, useState } from "react";
import type { ReactNode } from "react";
import { ChevronIcon } from "../workbench/icons";

/** Enable and disclosure are independent sibling controls; neither nests inside the other. */
export function CfgDisclosure({ title, subtitle, enabled, onEnable, children }: {
  title: string; subtitle: string; enabled: boolean; onEnable: () => void; children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <section className="cfg-disclosure">
    <div className="cfg-disclosure-row">
      <button className="cfg-disclosure-title" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)} type="button">
        <span className="cfg-summary-copy"><strong>{title}</strong><span>{subtitle}</span></span>
      </button>
      <button className="switch" role="switch" aria-label={`启用${title}`} aria-checked={enabled} data-active={enabled} onClick={onEnable} type="button"><span /></button>
      <button className="cfg-disclosure-chevron" aria-label={`${expanded ? "折叠" : "展开"}${title}`} aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)} type="button"><ChevronIcon /></button>
    </div>
    <div id={id} hidden={!expanded}>{children}</div>
  </section>;
}
