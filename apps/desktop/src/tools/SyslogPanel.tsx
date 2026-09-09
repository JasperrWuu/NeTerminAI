import { useEffect, useRef, useState } from "react";
import { Select } from "../ui/Select";
import { CopyButton } from "../ui/CopyButton";
import { systemApi } from "../ipc/system";
import { syslogApi, type SyslogEntry, type SyslogSnapshot } from "../ipc/syslog";
import { readSyslogDraft, persistSyslogDraft, syslogPort } from "./syslogDraft";
import "./syslog.css";

function time(value: number) {
  const date = new Date(value);
  return `${date.toLocaleTimeString("zh-CN", { hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

export function SyslogPanel() {
  const [draft, setDraft] = useState(readSyslogDraft);
  const [adapters, setAdapters] = useState<{ name: string; address: string }[]>([]);
  const [snapshot, setSnapshot] = useState<SyslogSnapshot | null>(null);
  const [logs, setLogs] = useState<SyslogEntry[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const cursor = useRef(0);
  const revision = useRef(0);
  const busy = useRef(false);
  const follow = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const apply = (value: SyslogSnapshot, replace: boolean) => {
    cursor.current = value.cursor; setSnapshot(value);
    setLogs((current) => {
      const entries = replace ? value.entries : [...current, ...value.entries];
      // Same bounded window as the backend; never persist live log text.
      let bytes = 0; let start = entries.length;
      while (start > 0 && entries.length - start < 2000) {
        const size = entries[start - 1].message.length * 2;
        if (bytes + size > 2 * 1024 * 1024) break;
        bytes += size; start--;
      }
      return entries.slice(start);
    });
  };
  useEffect(() => {
    let cancelled = false;
    void systemApi.listLocalIpv4().then((items) => {
      if (cancelled) return;
      setAdapters(items);
      setDraft((current) => current.adapter || !items.length ? current : { ...current, adapter: `${items[0].name}|${items[0].address}` });
    }).catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { try { persistSyslogDraft(draft); } catch { setError("无法保存 SYSLOG 参数，请检查本地存储。"); } }, [draft]);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = revision.current;
      try {
        if (!busy.current) {
          const value = await syslogApi.read(cursor.current);
          if (!cancelled && version === revision.current) apply(value, false);
        }
      } catch (reason) { if (!cancelled) setError(String(reason)); }
      if (!cancelled) timer = setTimeout(() => void poll(), 250);
    };
    void poll();
    return () => { cancelled = true; alive.current = false; clearTimeout(timer); };
  }, []);
  useEffect(() => { if (scroll.current && follow.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [logs]);
  const selected = adapters.find((item) => `${item.name}|${item.address}` === draft.adapter);
  const port = syslogPort(draft.port);
  const action = async (operation: () => Promise<SyslogSnapshot>) => {
    if (busy.current) return;
    busy.current = true; revision.current++; setPending(true); setError("");
    try { const value = await operation(); if (alive.current) apply(value, true); }
    catch (reason) { if (alive.current) setError(String(reason)); }
    finally { busy.current = false; if (alive.current) setPending(false); }
  };
  return <section className="syslog-tool" aria-label="SYSLOG 服务器">
    <header><h2>SYSLOG 服务器</h2><p>接收网络设备日志 · UDP</p></header>
    <div className="syslog-fields">
      <label className="form-field"><span>服务器</span>
        <Select ariaLabel="本地网卡 IPv4" value={draft.adapter} disabled={pending || snapshot?.running}
          options={adapters.map((item) => ({ value: `${item.name}|${item.address}`, label: `${item.name} · ${item.address}` }))}
          placeholder={draft.adapter ? "已保存网卡不可用，请重新选择" : "选择本地网卡"} emptyLabel="没有可用的本地 IPv4"
          onChange={(adapter) => setDraft({ ...draft, adapter })} />
      </label>
      <label className="form-field"><span>端口</span><input className="settings-text-input" inputMode="numeric" value={draft.port}
        disabled={pending || snapshot?.running} aria-invalid={!port} onChange={(event) => setDraft({ ...draft, port: event.target.value })} />
        {!port && <small role="alert">请输入 1–65535</small>}
      </label>
    </div>
    <div className="syslog-actions">
      <span role="status" className="syslog-status" data-running={snapshot?.running}>{snapshot?.running ? `● 运行中 · ${selected?.name ?? ""} · ${snapshot.address}` : "未启动"}</span>
      <button className={snapshot?.running ? "secondary-button" : "primary-button"} type="button"
        disabled={pending || (!snapshot?.running && (!selected || !port || !snapshot))}
        onClick={() => void action(() => snapshot?.running ? syslogApi.stop() : syslogApi.start(selected!.address, port!))}>
        {pending ? "处理中…" : snapshot?.running ? "停止" : "启动服务器"}
      </button>
    </div>
    {(error || snapshot?.error) && <p className="syslog-error" role="alert">{error || snapshot?.error}</p>}
    <div className="syslog-log-heading"><h3>日志 <small>{logs.length}</small></h3><div>
      <CopyButton label="日志" value={logs.map((entry) => `${time(entry.timestamp)}  ${entry.source}  ${entry.message}`).join("\n")} onError={setError} />
      <button className="secondary-button" disabled={pending || !logs.length} type="button" onClick={() => void action(syslogApi.clear)}>清空</button>
    </div></div>
    <div className="syslog-output" ref={scroll} tabIndex={0} aria-label="收到的 SYSLOG 日志" onScroll={(event) => {
      const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
    }}>
      {!logs.length && <p className="syslog-empty">{snapshot?.running ? "等待设备日志…" : "启动服务器后，设备日志会显示在这里。"}</p>}
      {logs.map((entry) => <div className="syslog-entry" key={entry.id}><span className="syslog-meta">{time(entry.timestamp)}  {entry.source}</span><pre>{entry.message}</pre></div>)}
    </div>
    <p className="syslog-note">仅保留最近 2,000 条 / 2 MiB 日志，较早内容会移出显示。{snapshot?.discarded ? ` 已移出 ${snapshot.discarded} 条。` : ""}</p>
  </section>;
}
