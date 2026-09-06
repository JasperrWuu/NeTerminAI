import { useEffect, useRef, useState } from "react";
import { ChevronIcon } from "../workbench/icons";
import { toolRegistry, type ToolProps } from "./toolRegistry";

export function ToolsView(props: ToolProps) {
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [openedTools, setOpenedTools] = useState<readonly string[]>([]);
  const entryRefs = useRef(new Map<string, HTMLButtonElement>());
  const backRef = useRef<HTMLButtonElement>(null);
  const previousTool = useRef<string | null>(null);

  useEffect(() => {
    if (selectedTool) backRef.current?.focus();
    else if (previousTool.current) entryRefs.current.get(previousTool.current)?.focus();
    previousTool.current = selectedTool;
  }, [selectedTool]);

  const openTool = (id: string) => {
    setOpenedTools((current) => current.includes(id) ? current : [...current, id]);
    setSelectedTool(id);
  };

  return (
    <div className="tools-view">
      <div className="tool-library" hidden={selectedTool !== null}>
        <p className="tool-library-description">常用的网络与设备辅助工具</p>
        <div className="tool-library-list">
          {toolRegistry.map(({ id, name, description, icon: Icon }) => (
            <button
              className="tool-entry"
              key={id}
              onClick={() => openTool(id)}
              ref={(element) => {
                if (element) entryRefs.current.set(id, element);
                else entryRefs.current.delete(id);
              }}
              type="button"
            >
              <span className="tool-entry-icon"><Icon /></span>
              <span className="tool-entry-copy"><strong>{name}</strong><small>{description}</small></span>
              <ChevronIcon />
            </button>
          ))}
        </div>
      </div>
      {selectedTool && (
        <button
          className="tool-back"
          ref={backRef}
          onClick={() => setSelectedTool(null)}
          type="button"
        ><ChevronIcon />工具</button>
      )}
      {toolRegistry.filter((tool) => openedTools.includes(tool.id)).map(({ id, component: Component }) => (
        // Keep visited tools mounted so drafts and preview survive Back/Open.
        <div className="tool-detail" hidden={selectedTool !== id} key={id}>
          <Component {...props} />
        </div>
      ))}
    </div>
  );
}
