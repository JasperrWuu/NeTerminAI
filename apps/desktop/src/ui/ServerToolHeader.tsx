import type { ComponentType } from "react";
import "./serverTool.css";
export function ServerToolHeader({ icon: Icon, title, subtitle }: { icon: ComponentType; title: string; subtitle: string }) {
  return <header className="server-heading"><span className="server-heading-icon"><Icon /></span><div><h2>{title}</h2><p>{subtitle}</p></div></header>;
}
