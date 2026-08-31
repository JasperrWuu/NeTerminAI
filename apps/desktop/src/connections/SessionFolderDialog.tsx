import { useEffect, useRef, useState } from "react";
import { FolderIcon } from "../workbench/icons";
import type { ConnectionFolder } from "./types";

export function SessionFolderDialog({ folder, onCancel, onSave }: {
  folder?: ConnectionFolder;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(folder?.name ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onCancel]);

  return (
    <div className="dialog-scrim" role="presentation" onPointerDown={onCancel}>
      <form
        className="connection-dialog folder-dialog"
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); if (name.trim()) onSave(name.trim()); }}
      >
        <header className="connection-dialog-header">
          <div className="dialog-protocol-icon folder-dialog-icon"><FolderIcon /></div>
          <div><h2>{folder ? "重命名分区" : "新建会话分区"}</h2><p>像文件夹一样整理数量较多的连接会话。</p></div>
        </header>
        <div className="folder-dialog-body">
          <label className="form-field"><span>分区名称</span><input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} /></label>
        </div>
        <footer className="connection-dialog-actions">
          <button className="secondary-button" onClick={onCancel} type="button">取消</button>
          <button className="primary-button" disabled={!name.trim()} type="submit">{folder ? "重命名" : "创建"}</button>
        </footer>
      </form>
    </div>
  );
}
