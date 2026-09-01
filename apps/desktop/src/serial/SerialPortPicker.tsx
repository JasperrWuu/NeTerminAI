import { useEffect, useRef, useState } from "react";

interface SerialPortPickerProps {
  loading: boolean;
  onChange: (port: string) => void;
  onRefresh: () => void;
  ports: string[];
  value: string;
}

export function SerialPortPicker({ loading, onChange, onRefresh, ports, value }: SerialPortPickerProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = ports.findIndex((port) => port === value);
    setActiveIndex(Math.max(0, selectedIndex));
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open, ports, value]);

  const selectPort = (port: string) => {
    onChange(port);
    setOpen(false);
    inputRef.current?.focus();
  };

  return (
    <div className="serial-port-picker" ref={rootRef}>
      <div className="serial-port-control" data-open={open}>
        <span className="serial-port-leading" aria-hidden="true">
          <svg viewBox="0 0 18 18"><path d="M5 3.5v3M13 3.5v3M4 6.5h10v2.2A5 5 0 0 1 9 13.7a5 5 0 0 1-5-5z" /><path d="M9 13.7v1.8" /></svg>
        </span>
        <input
          aria-autocomplete="list"
          aria-controls="serial-port-listbox"
          aria-expanded={open}
          aria-label="串口"
          autoComplete="off"
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          onClick={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) setOpen(true);
              else if (ports.length > 0) {
                const delta = event.key === "ArrowDown" ? 1 : -1;
                setActiveIndex((current) => (current + delta + ports.length) % ports.length);
              }
            } else if (event.key === "Enter" && open && ports[activeIndex]) {
              event.preventDefault();
              selectPort(ports[activeIndex]);
            } else if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }
          }}
          placeholder="COM1"
          ref={inputRef}
          required
          role="combobox"
          spellCheck={false}
          value={value}
        />
        <button aria-label={open ? "收起串口列表" : "展开串口列表"} onClick={() => setOpen((current) => !current)} type="button">
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m5.5 6.5 2.5 2.5 2.5-2.5" /></svg>
        </button>
      </div>

      {open && (
        <div className="serial-port-menu">
          <header>
            <span><strong>可用串口</strong><small>{loading ? "正在读取设备" : `${ports.length} 个设备`}</small></span>
            <button disabled={loading} onClick={onRefresh} type="button">{loading ? "检测中" : "刷新"}</button>
          </header>
          <div className="serial-port-options" id="serial-port-listbox" role="listbox" aria-label="可用串口">
            {ports.length > 0 ? ports.map((port, index) => (
              <button
                aria-selected={value === port}
                className="serial-port-option"
                data-active={activeIndex === index}
                key={port}
                onClick={() => selectPort(port)}
                onPointerEnter={() => setActiveIndex(index)}
                role="option"
                type="button"
              >
                <span className="serial-port-option-icon">COM</span>
                <span><strong>{port}</strong><small>本机串口设备</small></span>
                <span className="serial-port-option-check">{value === port ? "✓" : ""}</span>
              </button>
            )) : (
              <div className="serial-port-empty">
                <strong>没有检测到串口</strong>
                <small>仍可在上方直接输入 COM 端口名称。</small>
              </div>
            )}
          </div>
        </div>
      )}
      <small aria-live="polite" className="field-hint">
        {loading ? "正在读取设备…" : ports.length > 0 ? "选择检测到的设备，也可以手动输入" : "未检测到设备，可以手动输入端口"}
      </small>
    </div>
  );
}
