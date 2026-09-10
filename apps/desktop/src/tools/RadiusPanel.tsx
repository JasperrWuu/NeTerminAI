import { useEffect, useRef, useState } from "react";
import { Select } from "../ui/Select";
import { CopyButton } from "../ui/CopyButton";
import { systemApi } from "../ipc/system";
import { radiusApi, type RadiusEntry, type RadiusSnapshot } from "../ipc/radius";
import { readRadiusDraft, persistRadiusDraft, radiusInteger, radiusCodeOptions } from "./radiusDraft";
import "./radius.css";
import { ServerLogView } from "../ui/ServerLogView";
import { ServerToolHeader } from "../ui/ServerToolHeader";
import { RadiusIcon } from "../workbench/icons";

const time = (timestamp: number) => `${new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false })}.${String(timestamp % 1000).padStart(3, "0")}`;
export function RadiusPanel() {
  const [draft, setDraft] = useState(readRadiusDraft);
  const [adapters, setAdapters] = useState<{ name: string; address: string }[]>([]);
  const [snapshot, setSnapshot] = useState<RadiusSnapshot | null>(null);
  const [entries, setEntries] = useState<RadiusEntry[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false); const revision = useRef(0); const cursor = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    let active = true;
    void systemApi.listLocalIpv4().then((items) => { if (active) setAdapters(items); }).catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, []);
  useEffect(() => { try { persistRadiusDraft(draft); } catch { setError("无法保存 RADIUS 参数"); } }, [draft]);
  const apply = (value: RadiusSnapshot, replace = false) => {
    cursor.current = value.cursor; setSnapshot(value);
    setEntries((current) => (replace ? value.entries : [...current, ...value.entries]).slice(-1000));
  };
  useEffect(() => {
    alive.current = true; let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = revision.current;
      try { if (!busy.current) { const value = await radiusApi.read(cursor.current); if (active && version === revision.current) apply(value); } }
      catch (e) { if (active) setError(String(e)); }
      if (active) timer = setTimeout(() => void poll(), 250);
    };
    void poll(); return () => { active = false; alive.current = false; clearTimeout(timer); };
  }, []);
  const action = async () => {
    if (busy.current) return;
    busy.current = true; revision.current++; setPending(true); setError("");
    try {
      const value = snapshot?.running ? await radiusApi.stop() : await radiusApi.start({ ip: draft.ip, port: port!, codeKind: draft.codeKind, codeLength: length! });
      if (alive.current) apply(value, true);
    } catch (e) { if (alive.current) setError(String(e)); }
    finally { busy.current = false; if (alive.current) setPending(false); }
  };
  const port = radiusInteger(draft.port, 65535); const length = radiusInteger(draft.codeLength, 32);
  const disabled = pending || Boolean(snapshot?.running);
  const options = [{ value: "0.0.0.0", label: "0.0.0.0 · 所有 IPv4" }, { value: "::", label: ":: · 所有 IPv6" },
    ...adapters.filter((item, i, all) => all.findIndex((a) => a.address === item.address) === i).map((item) => ({ value: item.address, label: `${item.name} · ${item.address}` }))];
  return <section className="radius-tool server-tool" aria-label="RADIUS 服务器">
    <ServerToolHeader icon={RadiusIcon} title="RADIUS 服务器" subtitle="认证联调 · PAP / CHAP" />
    <div className="radius-fields">
      <label className="form-field"><span>监听地址</span><Select ariaLabel="RADIUS 监听地址" value={draft.ip} options={options} disabled={disabled} onChange={(ip) => setDraft({ ...draft, ip })} placeholder="选择监听地址" /></label>
      <label className="form-field"><span>端口</span><input className="settings-text-input" inputMode="numeric" value={draft.port} disabled={disabled} aria-invalid={!port} onChange={(e) => setDraft({ ...draft, port: e.target.value })} />{!port && <small role="alert">1–65535</small>}</label>
    </div>
    <div className="radius-policy">
      <div><span>共享密钥</span><code>admin@123</code></div>
      <div><span>PAP · 任意用户名</span><span><code>admin@123</code> 通过<br /><code>Admin@123</code> 进入挑战</span></div>
      <div><span>CHAP</span><span>任意凭据通过 · 测试放行</span></div>
    </div>
    <div><h3>挑战码</h3><p className="radius-note">客户端输入收到的原码，120 秒内有效。大小写敏感。</p></div>
    <div className="radius-fields">
      <label className="form-field"><span>字符类型</span><Select ariaLabel="挑战码类型" value={draft.codeKind} options={radiusCodeOptions} disabled={disabled} onChange={(codeKind) => setDraft({ ...draft, codeKind: codeKind as typeof draft.codeKind })} /></label>
      <label className="form-field"><span>长度</span><input className="settings-text-input" inputMode="numeric" value={draft.codeLength} disabled={disabled} aria-invalid={!length} onChange={(e) => setDraft({ ...draft, codeLength: e.target.value })} />{!length && <small role="alert">1–32</small>}</label>
    </div>
    <p className="radius-note">仅用于隔离测试网络。CHAP 不校验凭据；本工具不是生产认证服务器。停止后会清除全部挑战状态。</p>
    <div className="radius-actions"><span role="status">{snapshot?.running ? `● 运行中 · ${snapshot.address}` : "未启动"}</span>
      <button type="button" className={snapshot?.running ? "secondary-button" : "primary-button"} disabled={pending || !snapshot || (!snapshot.running && (!port || !length || !options.some((o) => o.value === draft.ip)))} onClick={() => void action()}>{pending ? "处理中…" : snapshot?.running ? "停止" : "启动服务器"}</button>
    </div>
    {(error || snapshot?.error) && <p className="radius-error" role="alert">{error || snapshot?.error}</p>}
    <div className="radius-actions"><h3>认证日志</h3><CopyButton label="认证日志" value={entries.map((e) => `${time(e.timestamp)}  ${e.source}  ${e.message}`).join("\n")} onError={setError} /></div>
    <ServerLogView label="RADIUS 认证日志" empty="认证结果将显示在这里，不记录密码和挑战码。" entries={entries.map((e) => ({ ...e, metadata: e.source }))} />
    <p className="radius-note">保留最近 1,000 条记录；切换工具不会停止服务。</p>
  </section>;
}
