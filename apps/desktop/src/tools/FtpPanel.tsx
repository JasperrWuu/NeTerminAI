import { useEffect, useRef, useState } from "react";
import { Select } from "../ui/Select";
import { CopyButton } from "../ui/CopyButton";
import { acquireNativeSurfaceOcclusion } from "../ui/nativeSurfaceOcclusion";
import { systemApi } from "../ipc/system";
import { ftpApi, type FtpLog, type FtpSnapshot } from "../ipc/ftp";
import { readFtpDraft, persistFtpDraft, ftpPort } from "./ftpDraft";
import { startSavedFtp } from "./ftpStartup";
import "./ftp.css";
import { ServerLogView } from "../ui/ServerLogView";
import { ServerToolHeader } from "../ui/ServerToolHeader";
import { FtpIcon } from "../workbench/icons";
function stamp(value: number) { return `${new Date(value).toLocaleTimeString("zh-CN", { hour12: false })}.${String(value % 1000).padStart(3, "0")}`; }
function size(value: number) { return value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 ** 2).toFixed(2)} MiB`; }
export function FtpPanel() {
  const [draft, setDraft] = useState(readFtpDraft);
  const [adapters, setAdapters] = useState<{ name: string; address: string }[]>([]);
  const [snapshot, setSnapshot] = useState<FtpSnapshot | null>(null);
  const [logs, setLogs] = useState<FtpLog[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef(draft); latest.current = draft;
  const busy = useRef(false); const revision = useRef(0); const cursor = useRef(0);
  useEffect(() => {
    let active = true;
    void systemApi.listLocalIpv4().then((items) => { if (active) {
      setAdapters(items); setDraft((current) => current.ip || !items.length ? current : { ...current, ip: items[0].address, adapter: items[0].name });
    } }).catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, []);
  useEffect(() => { const timer = setTimeout(() => { try { persistFtpDraft(draft); } catch { setError("FTP 配置保存失败。"); } }, 400); return () => clearTimeout(timer); }, [draft]);
  useEffect(() => {
    const flush = () => { try { persistFtpDraft(latest.current); } catch { /* active effect reports failures */ } };
    window.addEventListener("pagehide", flush); window.addEventListener("beforeunload", flush);
    return () => { flush(); window.removeEventListener("pagehide", flush); window.removeEventListener("beforeunload", flush); };
  }, []);
  const apply = (value: FtpSnapshot, replace = false) => {
    cursor.current = value.cursor; setSnapshot(value);
    setLogs((current) => (replace ? value.logs : [...current, ...value.logs]).slice(-2000));
  };
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = revision.current;
      try { if (!busy.current) { const value = await ftpApi.read(cursor.current); if (active && version === revision.current) apply(value); } }
      catch (e) { if (active) setError(String(e)); }
      if (active) timer = setTimeout(() => void poll(), 250);
    };
    void startSavedFtp().then((failure) => { if (active) { if (failure) setError(failure); void poll(); } });
    return () => { active = false; clearTimeout(timer); };
  }, []);
  const action = async (operation: () => Promise<void>) => {
    if (busy.current) return; busy.current = true; revision.current++; setPending(true); setError("");
    try { await operation(); } catch (e) { setError(String(e)); } finally { busy.current = false; setPending(false); }
  };
  const port = ftpPort(draft.port); const disabled = pending || Boolean(snapshot?.running);
  return <section className="ftp-tool server-tool" aria-label="FTP 服务器">
    <ServerToolHeader icon={FtpIcon} title="FTP 服务器" subtitle="文件传输 · Active FTP" />
    <div className="ftp-fields">
      <label className="form-field"><span>服务器 IP</span><Select ariaLabel="FTP 监听网卡" value={`${draft.adapter}|${draft.ip}`} disabled={disabled}
        placeholder="选择本地网卡" emptyLabel="没有可用的本地 IPv4" options={adapters.map((item) => ({ value: `${item.name}|${item.address}`, label: `${item.name} · ${item.address}` }))}
        onChange={(value) => { const selected = adapters.find((item) => `${item.name}|${item.address}` === value)!; setDraft({ ...draft, adapter: selected.name, ip: selected.address }); }} /></label>
      <label className="form-field"><span>端口</span><input className="settings-text-input" inputMode="numeric" disabled={disabled} value={draft.port} aria-invalid={!port} onChange={(e) => setDraft({ ...draft, port: e.target.value })} /></label>
      <label className="form-field ftp-wide"><span>共享目录</span><span className="ftp-folder"><input className="settings-text-input" disabled={disabled} value={draft.root} onChange={(e) => setDraft({ ...draft, root: e.target.value })} />
        <button type="button" className="secondary-button" disabled={disabled} onClick={() => void action(async () => { const release = acquireNativeSurfaceOcclusion(); try { const root = await ftpApi.chooseRoot(); if (root) setDraft((current) => ({ ...current, root })); } finally { release(); } })}>选择</button></span></label>
      <label className="form-field"><span>用户名</span><input className="settings-text-input" autoComplete="off" disabled={disabled} value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} /></label>
      <label className="form-field"><span>密码</span><input className="settings-text-input" type="text" autoComplete="off" disabled={disabled} value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} /></label>
    </div>
    <div className="ftp-actions"><span>自动启动<small>下次打开应用时生效</small></span><button type="button" className="switch compact-switch" role="switch" aria-label="FTP 自动启动" aria-checked={draft.autoStart} data-active={draft.autoStart} onClick={() => setDraft({ ...draft, autoStart: !draft.autoStart })}><span /></button></div>
    <p className="ftp-note">FTP 不加密，账号密码保存在本机配置中。请仅用于可信网络。</p>
    <div className="ftp-actions"><span role="status">{snapshot?.running ? `● 运行中 · ${snapshot.address}` : "未启动"}</span>
      <button className={snapshot?.running ? "secondary-button" : "primary-button"} type="button" disabled={pending || !snapshot || (!snapshot.running && (!port || !draft.root || !draft.ip))}
        onClick={() => void action(async () => { if (snapshot?.running) apply(await ftpApi.stop(), true); else { persistFtpDraft(draft); apply(await ftpApi.start({ ip: draft.ip, port: port!, root: draft.root, username: draft.username, password: draft.password }), true); } })}>{pending ? "处理中…" : snapshot?.running ? "停止" : "启动服务器"}</button>
    </div>
    {(error || snapshot?.error) && <p className="ftp-error" role="alert">{error || snapshot?.error}</p>}
    {snapshot?.transfers.map((transfer) => <div className="ftp-progress" key={transfer.client}><strong>{transfer.direction} · {transfer.file}</strong><small>{transfer.client} · {size(transfer.bytes)}{transfer.total !== null ? ` / ${size(transfer.total)}` : ""} · {size(transfer.bytesPerSecond)}/s · {transfer.seconds.toFixed(1)}s</small></div>)}
    <div className="ftp-actions"><h3>日志</h3><CopyButton label="FTP 日志" onError={setError} value={logs.map((entry) => `${stamp(entry.timestamp)}  ${entry.level}  ${entry.message}`).join("\n")} /></div>
    <ServerLogView label="FTP 运行日志" empty="连接和传输记录会显示在这里。" entries={logs.map((e) => ({ ...e, metadata: e.level }))} />
    <p className="ftp-note">保留最近 2,000 条记录；密码不会写入日志。文件请使用 binary 模式；SHA-256 可与源文件核对。</p>
  </section>;
}
