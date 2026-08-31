import { useEffect, useRef, useState } from "react";
import { FolderIcon } from "../workbench/icons";
import type { ConnectionFolder } from "./types";

export function FolderPicker({ folders, folderId, onChange, onCreateFolder }: {
  folders: ConnectionFolder[];
  folderId: string;
  onChange: (folderId: string) => void;
  onCreateFolder: (name: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedName = folders.find((folder) => folder.id === folderId)?.name ?? "未分组";

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const createFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    const newFolderId = onCreateFolder(name);
    onChange(newFolderId);
    setNewFolderName("");
    setOpen(false);
  };

  return (
    <div className="form-field session-folder-field" ref={menuRef}>
      <span>保存到分区</span>
      <button aria-expanded={open} aria-haspopup="listbox" className="folder-picker-trigger" onClick={() => setOpen((value) => !value)} type="button">
        <span className="folder-picker-icon"><FolderIcon /></span>
        <span>{selectedName}</span>
        <i aria-hidden="true" />
      </button>
      {open && (
        <div className="folder-picker-menu" role="dialog" aria-label="选择或新建会话分区">
          <div className="folder-picker-options" role="listbox" aria-label="保存到分区">
            <FolderOption label="未分组" selected={!folderId} onSelect={() => { onChange(""); setOpen(false); }} />
            {folders.map((folder) => (
              <FolderOption key={folder.id} label={folder.name} selected={folderId === folder.id} onSelect={() => { onChange(folder.id); setOpen(false); }} />
            ))}
          </div>
          <div className="folder-picker-create">
            <input
              aria-label="新分区名称"
              onChange={(event) => setNewFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  createFolder();
                }
              }}
              placeholder="新分区名称"
              value={newFolderName}
            />
            <button disabled={!newFolderName.trim()} onClick={createFolder} type="button">创建</button>
          </div>
        </div>
      )}
    </div>
  );
}

function FolderOption({ label, selected, onSelect }: { label: string; selected: boolean; onSelect: () => void }) {
  return (
    <button aria-selected={selected} className="folder-picker-option" onClick={onSelect} role="option" type="button">
      <span className="folder-picker-option-check">{selected ? "✓" : ""}</span>
      <span>{label}</span>
    </button>
  );
}
