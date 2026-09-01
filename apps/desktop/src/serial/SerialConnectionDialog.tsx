import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderPicker } from "../connections/FolderPicker";
import { emptySerialConnection } from "../connections/types";
import type {
  ConnectionFolder,
  SavedSerialSession,
  SerialConnection,
  SerialDataBits,
  SerialFlowControl,
  SerialParity,
  SerialStopBits,
} from "../connections/types";
import { SegmentedControl } from "../ui/SegmentedControl";
import { SerialPortPicker } from "./SerialPortPicker";

interface SerialConnectionDialogProps {
  folders: ConnectionFolder[];
  initialSession?: SavedSerialSession;
  onCancel: () => void;
  onCreateFolder: (name: string) => string;
  onSubmit: (connection: SerialConnection, save: boolean, folderId: string | null) => void;
}

export function SerialConnectionDialog({ folders, initialSession, onCancel, onCreateFolder, onSubmit }: SerialConnectionDialogProps) {
  const editing = Boolean(initialSession);
  const [connection, setConnection] = useState<SerialConnection>(() => initialSession ? { ...initialSession } : { ...emptySerialConnection });
  const [save, setSave] = useState(editing);
  const [folderId, setFolderId] = useState(initialSession?.folderId ?? "");
  const [ports, setPorts] = useState<string[]>([]);
  const [portsLoading, setPortsLoading] = useState(true);

  const loadPorts = useCallback(async () => {
    setPortsLoading(true);
    try {
      setPorts(await invoke<string[]>("list_serial_ports"));
    } catch {
      setPorts([]);
    } finally {
      setPortsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPorts();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [loadPorts, onCancel]);

  const setField = <K extends keyof SerialConnection>(key: K, value: SerialConnection[K]) => {
    setConnection((current) => ({ ...current, [key]: value }));
  };
  const valid = connection.portName.trim().length > 0 && connection.baudRate > 0;

  return (
    <div className="dialog-scrim" role="presentation" onPointerDown={onCancel}>
      <form aria-labelledby="serial-dialog-title" className="connection-dialog serial-dialog" onPointerDown={(event) => event.stopPropagation()} onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSubmit({ ...connection, portName: connection.portName.trim() }, editing || save, folderId || null);
      }}>
        <header className="connection-dialog-header">
          <div className="dialog-protocol-icon serial-dialog-icon">COM</div>
          <div><h2 id="serial-dialog-title">{editing ? "编辑串口会话" : "新建串口连接"}</h2><p>直接连接本机串口；默认采用常见的 9600 · 8 · 1 · 无 · 无。</p></div>
        </header>

        <div className="connection-form-grid">
          <label className="form-field form-field-wide"><span>会话名称</span><input onChange={(event) => setField("name", event.target.value)} placeholder="例如：防火墙 Console" value={connection.name} /></label>
          <div className="form-field">
            <span>串口</span>
            <SerialPortPicker
              loading={portsLoading}
              onChange={(portName) => setField("portName", portName)}
              onRefresh={() => void loadPorts()}
              ports={ports}
              value={connection.portName}
            />
          </div>
          <label className="form-field"><span>波特率</span><input inputMode="numeric" min={1} onChange={(event) => setField("baudRate", Number(event.target.value))} required type="number" value={connection.baudRate} /></label>
          <OptionField label="数据位"><SegmentedControl compact items={[5, 6, 7, 8].map((value) => ({ value: value as SerialDataBits, label: String(value) }))} onChange={(value) => setField("dataBits", value)} value={connection.dataBits} /></OptionField>
          <OptionField label="停止位"><SegmentedControl compact items={[1, 2].map((value) => ({ value: value as SerialStopBits, label: String(value) }))} onChange={(value) => setField("stopBits", value)} value={connection.stopBits} /></OptionField>
          <OptionField label="奇偶校验" wide><SegmentedControl items={([['none', '无'], ['odd', '奇'], ['even', '偶']] as const).map(([value, label]) => ({ value: value as SerialParity, label }))} onChange={(value) => setField("parity", value)} value={connection.parity} /></OptionField>
          <OptionField label="流控制" wide><SegmentedControl items={([['none', '无'], ['software', '软件'], ['hardware', '硬件']] as const).map(([value, label]) => ({ value: value as SerialFlowControl, label }))} onChange={(value) => setField("flowControl", value)} value={connection.flowControl} /></OptionField>
        </div>

        <div className="connection-save-options">
          {!editing && <label className="check-row"><input checked={save} onChange={(event) => setSave(event.target.checked)} type="checkbox" /><span><strong>保存会话</strong><small>保留串口参数，下次双击即可连接</small></span></label>}
          {(editing || save) && <FolderPicker folders={folders} folderId={folderId} onChange={setFolderId} onCreateFolder={onCreateFolder} />}
        </div>

        <footer className="connection-dialog-actions">
          <button className="secondary-button" onClick={onCancel} type="button">取消</button>
          <button className="primary-button" disabled={!valid} type="submit">{editing ? "保存" : "连接"}</button>
        </footer>
      </form>
    </div>
  );
}

function OptionField({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return <fieldset className={`form-field option-field ${wide ? "form-field-wide" : ""}`}><legend>{label}</legend>{children}</fieldset>;
}
