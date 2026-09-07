import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, FolderIcon } from "../workbench/icons";
import { MAX_DIAGNOSTIC_BYTES, type DiagnosticDocument } from "./diagnosticParser";
import "./diagnostic.css";

// Reader pages bound DOM work while Copy always includes the complete section.
const PAGE_CHARS = 64_000;
export function DiagnosticPanel() {
  const [document, setDocument] = useState<DiagnosticDocument | null>(null);
  const [filename, setFilename] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const worker = useRef<Worker | null>(null);
  const generation = useRef(0);
  const copyGeneration = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { generation.current++; copyGeneration.current++; worker.current?.terminate(); clearTimeout(copyTimer.current); }, []);
  const filtered = useMemo(() => document?.sections.filter((section) => section.command.toLowerCase().includes(query.trim().toLowerCase())) ?? [], [document, query]);
  const section = document?.sections.find((item) => item.id === selected);
  const output = section && document ? document.text.slice(section.start, section.end) : "";
  const pages = Math.max(1, Math.ceil(output.length / PAGE_CHARS));
  const choose = (id: string) => { copyGeneration.current++; setSelected(id); setPage(0); setCopied(false); clearTimeout(copyTimer.current); };

  const load = async (file: File) => {
    const current = ++generation.current;
    copyGeneration.current++; clearTimeout(copyTimer.current);
    worker.current?.terminate(); worker.current = null;
    setLoading(true); setError(""); setCopied(false);
    try {
      if (file.size > MAX_DIAGNOSTIC_BYTES) throw new Error("文件超过 32 MB，请先拆分后导入。");
      const buffer = await file.arrayBuffer();
      if (current !== generation.current) return;
      const parser = new Worker(new URL("./diagnosticWorker.ts", import.meta.url), { type: "module" });
      worker.current = parser;
      const finish = () => { parser.terminate(); worker.current = null; setLoading(false); };
      parser.onmessage = (event: MessageEvent<{ document?: DiagnosticDocument; error?: string }>) => {
        if (current !== generation.current) return;
        finish();
        if (!event.data.document) { setError(event.data.error ?? "解析失败"); return; }
        const result = event.data.document;
        setDocument(result); setFilename(file.name); setQuery(""); setPage(0);
        setSelected(result.sections[0]?.id ?? null);
        if (!result.sections.length) setError("未识别到命令片段。请检查 display 命令上下是否有等号分隔行。");
      };
      parser.onerror = () => { if (current === generation.current) { finish(); setError("解析失败，请检查文件格式后重试。"); } };
      parser.postMessage(buffer, [buffer]);
    } catch (cause) {
      if (current === generation.current) { setLoading(false); setError(cause instanceof Error ? cause.message : "读取失败"); }
    }
  };
  const copy = async () => {
    if (!section) return;
    const current = ++copyGeneration.current;
    try {
      await navigator.clipboard.writeText(`${section.command}\n${output}`);
      if (current !== copyGeneration.current) return;
      setCopied(true); clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch { if (current === copyGeneration.current) setError("复制失败，请检查剪贴板权限后重试。"); }
  };
  return <section className="diagnostic-panel" aria-label="诊断信息检查">
    <header className="diagnostic-heading"><h2>诊断信息检查</h2><p>导入 TXT，按命令阅读设备回显。</p>
      <input ref={input} hidden type="file" accept=".txt,text/plain" onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ""; if (file) void load(file);
      }} />
      <button className="secondary-button" type="button" onClick={() => input.current?.click()}><FolderIcon />{loading ? "重新选择文件" : "导入诊断 TXT"}</button>
      <small role="status">{loading ? "正在解析…" : document ? `${filename} · ${document.sections.length} 条命令 · ${document.encoding}` : "仅在本机读取，不上传文件 · 最大 32 MB"}</small>
    </header>
    {error && <p className="field-error" role="alert">{error}</p>}
    {document && document.sections.length > 0 && <div className="diagnostic-layout" aria-busy={loading}>
      <nav className="diagnostic-navigation" aria-label="诊断命令">
        <input className="settings-text-input" type="search" aria-label="搜索 display 命令" placeholder="搜索命令…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="diagnostic-commands">{filtered.map((item) => <button key={item.id} type="button" aria-current={selected === item.id ? "true" : undefined} onClick={() => choose(item.id)}>
          <span>{item.command}</span><small>源文件第 {item.line} 行</small>
        </button>)}{!filtered.length && <p>没有匹配的命令</p>}</div>
      </nav>
      <section className="diagnostic-reader" aria-label="命令输出">
        <header><strong>{section?.command}</strong><button className="secondary-button" type="button" onClick={() => void copy()} disabled={!section || loading}>{copied && <CheckIcon />}{copied ? "已复制" : "复制片段"}</button></header>
        {pages > 1 && <div className="diagnostic-paging"><button type="button" className="secondary-button" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><small>{page + 1} / {pages} · 复制含完整片段</small><button type="button" className="secondary-button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>下一页</button></div>}
        <pre key={`${selected}-${page}`} tabIndex={0}>{output.slice(page * PAGE_CHARS, (page + 1) * PAGE_CHARS) || "（无输出）"}</pre>
      </section>
    </div>}
  </section>;
}
