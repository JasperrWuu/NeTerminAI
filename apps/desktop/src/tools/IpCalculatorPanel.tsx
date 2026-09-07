import { useEffect, useId, useRef, useState } from "react";
import { SegmentedControl } from "../ui/SegmentedControl";
import { CopyButton } from "../ui/CopyButton";
import { calculateIpv4, calculateIpv6, numberToIpv6, parseIpv4, parseIpv4MaskOrPrefix, parseIpv6, parsePrefix } from "./ipCalculator";
import { readIpDraft, persistIpDraft } from "./ipCalculatorDraft";
import "./ipCalculator.css";

function errorFor(action: () => unknown): string {
  try { action(); return ""; } catch (error) { return error instanceof Error ? error.message : "输入无效"; }
}
export function IpCalculatorPanel() {
  const [draft, setDraft] = useState(readIpDraft);
  const [feedback, setFeedback] = useState("");
  const [saveError, setSaveError] = useState(false);
  const [, recalculate] = useState(0);
  const latest = useRef(draft); latest.current = draft;
  useEffect(() => {
    const timer = setTimeout(() => setSaveError(!persistIpDraft(draft)), 400);
    return () => clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    const flush = () => { persistIpDraft(latest.current); };
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush); window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => { flush(); window.removeEventListener("pagehide", flush); window.removeEventListener("beforeunload", flush); document.removeEventListener("visibilitychange", hidden); };
  }, []);
  const is4 = draft.tab === "ipv4";
  const address = is4 ? draft.address4 : draft.address6;
  const prefix = is4 ? draft.mask : draft.prefix6;
  const addressError = errorFor(() => is4 ? parseIpv4(address) : parseIpv6(address));
  const prefixError = errorFor(() => is4 ? parseIpv4MaskOrPrefix(prefix) : parsePrefix(prefix, 128));
  const ipv4 = is4 && !addressError && !prefixError ? calculateIpv4(address, prefix) : null;
  const ipv6 = !is4 && !addressError && !prefixError ? calculateIpv6(address, prefix) : null;
  const numberError = draft.number ? errorFor(() => numberToIpv6(draft.number)) : "";
  const converted = draft.number && !numberError ? numberToIpv6(draft.number) : null;
  const results: { label: string; value: string; wide?: boolean }[] = ipv4 ? [
    { label: "输入地址", value: ipv4.address, wide: true },
    { label: "网络地址", value: ipv4.network }, { label: "广播地址", value: ipv4.broadcast },
    { label: "子网掩码", value: ipv4.mask }, { label: "前缀长度", value: String(ipv4.prefix) },
    { label: "可用地址范围", value: `${ipv4.first} – ${ipv4.last}`, wide: true },
    { label: "地址总数", value: ipv4.total }, { label: "可用主机数", value: ipv4.usable },
  ] : ipv6 ? [
    { label: "网络地址", value: ipv6.network }, { label: "Prefix", value: String(ipv6.prefix) },
    { label: "地址范围", value: `${ipv6.first} – ${ipv6.last}`, wide: true },
    { label: "压缩格式", value: ipv6.compressed, wide: true }, { label: "完整展开格式", value: ipv6.expanded, wide: true },
    { label: "十进制整数", value: ipv6.decimal, wide: true }, { label: "地址总数", value: ipv6.total, wide: true },
  ] : [];
  return <section className="ip-calculator" aria-label="IP 地址计算器">
    <header><h2>IP 地址计算器</h2><p>查看子网范围与地址信息</p></header>
    <SegmentedControl ariaLabel="地址协议" items={[{ value: "ipv4", label: "IPv4" }, { value: "ipv6", label: "IPv6" }] as const}
      value={draft.tab} onChange={(tab) => { setDraft({ ...draft, tab }); setFeedback(""); }} />
    <form noValidate onSubmit={(event) => { event.preventDefault(); recalculate((value) => value + 1); }}>
      <div className="ip-input-grid">
        <IpField label={is4 ? "IP 地址" : "IPv6 地址"} value={address} error={addressError}
          onChange={(value) => setDraft({ ...draft, [is4 ? "address4" : "address6"]: value })} />
        <IpField label={is4 ? "Mask / Prefix" : "Prefix"} value={prefix} error={prefixError} numeric={!is4}
          onChange={(value) => setDraft({ ...draft, [is4 ? "mask" : "prefix6"]: value })} />
      </div>
      <button type="submit" hidden>计算</button>
    </form>
    {results.length > 0 && <dl className="ip-result-grid">{results.map((result) => <IpResult key={`${draft.tab}-${result.label}`} {...result} onError={setFeedback} />)}</dl>}
    {ipv4 && ipv4.prefix >= 31 && <p className="ip-helper">前缀 31 按点到点链路计算，前缀 32 按单个主机地址计算。</p>}
    {!is4 && <section className="ip-number-section" aria-label="十进制整数转 IPv6">
      <h3>十进制整数 → IPv6</h3>
      <IpField label="十进制整数" value={draft.number} error={numberError} numeric placeholder="输入非负整数"
        onChange={(number) => setDraft({ ...draft, number })} />
      {converted && <dl className="ip-result-grid"><IpResult label="压缩格式" value={converted.compressed} wide onError={setFeedback} /><IpResult label="完整展开格式" value={converted.expanded} wide onError={setFeedback} /></dl>}
    </section>}
    {saveError && <p className="field-error" role="status">暂时无法保存输入，请检查本地存储权限。</p>}
    {feedback && <p className="field-error" role="alert">{feedback}</p>}
  </section>;
}
function IpField({ label, value, error, onChange, numeric, placeholder }: {
  label: string; value: string; error: string; onChange: (value: string) => void; numeric?: boolean; placeholder?: string;
}) {
  const id = useId();
  return <label className="ip-field" htmlFor={id}><span>{label}</span>
    <input id={id} className="settings-text-input" type="text" inputMode={numeric ? "numeric" : "text"} autoComplete="off" spellCheck={false}
      value={value} maxLength={128} placeholder={placeholder} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
      onChange={(event) => onChange(event.target.value)} />
    {error && <small className="field-error" id={`${id}-error`}>{error}</small>}
  </label>;
}
function IpResult({ label, value, wide, onError }: { label: string; value: string; wide?: boolean; onError: (message: string) => void }) {
  return <div className="ip-result" data-wide={wide}><dt>{label}</dt><dd><span>{value}</span><CopyButton label={label} value={value} onError={onError} /></dd></div>;
}
