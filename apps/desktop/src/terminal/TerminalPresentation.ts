import type { Terminal, IMarker, IDecoration, IDisposable } from "@xterm/xterm";
import type { TerminalHighlightRule } from "../settings/types";
import { compileTerminalHighlightRules, terminalHighlightRanges } from "./highlighting.ts";

interface PaintedRow { marker: IMarker; text: string; decorations: IDecoration[] }
interface TimedRow { marker: IMarker; time: string }

/** Display-only metadata. Neither highlights nor timestamps alter buffer text,
 * transport bytes, terminal cursor state or the Automation output stream. */
export class TerminalPresentation {
  private rules = compileTerminalHighlightRules([]);
  private rulesKey = "";
  private painted: PaintedRow[] = [];
  private times: TimedRow[] = [];
  private subscriptions: IDisposable[];
  private gutter = document.createElement("div");
  private enabled = false;
  private boundary: IMarker | undefined;
  private frame: number | undefined;
  private terminal: Terminal;
  constructor(terminal: Terminal) {
    this.terminal = terminal;
    this.gutter.className = "terminal-timestamp-gutter";
    this.gutter.setAttribute("aria-hidden", "true");
    this.subscriptions = [terminal.onRender(() => this.schedule()), terminal.onScroll(() => this.schedule()),
      terminal.onLineFeed(() => this.recordLine(-1)),
      terminal.onWriteParsed(() => { this.recordTimes(); this.schedule(); })];
  }
  setRules(rules: TerminalHighlightRule[]) {
    const key = JSON.stringify(rules);
    if (key === this.rulesKey) return;
    this.rulesKey = key;
    this.rules = compileTerminalHighlightRules(rules);
    this.clearPaint();
    this.schedule();
  }
  attach(container: HTMLElement) {
    this.gutter.parentElement?.classList.remove("terminal-with-timestamps");
    container.appendChild(this.gutter);
    container.classList.toggle("terminal-with-timestamps", this.enabled);
    this.schedule();
  }
  toggle() {
    this.enabled = !this.enabled;
    this.boundary?.dispose();
    const buffer = this.terminal.buffer.active;
    const currentHasText = Boolean(buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true));
    this.boundary = this.enabled ? this.terminal.registerMarker(currentHasText ? 0 : -1) : undefined;
    this.gutter.parentElement?.classList.toggle("terminal-with-timestamps", this.enabled);
    this.gutter.hidden = !this.enabled;
    this.schedule();
  }
  dispose() {
    this.subscriptions.forEach((subscription) => subscription.dispose());
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.clearPaint();
    this.times.forEach((row) => row.marker.dispose());
    this.boundary?.dispose();
    this.gutter.parentElement?.classList.remove("terminal-with-timestamps");
    this.gutter.remove();
  }
  private recordTimes() {
    const buffer = this.terminal.buffer.active;
    if (!this.enabled || buffer.type !== "normal") return;
    const unique = new Map<number, TimedRow>();
    for (const row of this.times) {
      if (row.marker.isDisposed) continue;
      if (unique.has(row.marker.line)) row.marker.dispose();
      else unique.set(row.marker.line, row);
    }
    this.times = [...unique.values()];
    this.recordLine(0);
  }
  private recordLine(offset: number) {
    const buffer = this.terminal.buffer.active;
    if (!this.enabled || buffer.type !== "normal") return;
    const index = buffer.baseY + buffer.cursorY + offset;
    if (this.boundary && !this.boundary.isDisposed && index <= this.boundary.line) return;
    const line = buffer.getLine(index);
    if (!line || !line.translateToString(true) || line.isWrapped || this.times.some((row) => !row.marker.isDisposed && row.marker.line === index)) return;
    const marker = this.terminal.registerMarker(offset);
    if (!marker) return;
    const date = new Date();
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}.${String(date.getMilliseconds()).padStart(3, "0")}`;
    this.times.push({ marker, time });
  }
  private schedule() {
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => { this.frame = undefined; this.render(); });
  }
  private clearPaint() {
    this.painted.forEach((row) => { row.decorations.forEach((item) => item.dispose()); row.marker.dispose(); });
    this.painted = [];
  }
  private render() {
    const terminal = this.terminal;
    const buffer = terminal.buffer.active;
    const start = buffer.viewportY;
    this.painted = this.painted.filter((row) => {
      if (!row.marker.isDisposed && buffer.type === "normal" && row.marker.line >= start && row.marker.line < start + terminal.rows) return true;
      row.decorations.forEach((item) => item.dispose()); row.marker.dispose(); return false;
    });
    for (let y = 0; y < terminal.rows && buffer.type === "normal"; y += 1) {
      const index = start + y;
      const line = buffer.getLine(index);
      if (!line) continue;
      const text = line.translateToString(true);
      const previous = this.painted.find((row) => row.marker.line === index);
      if (previous?.text === text) continue;
      if (previous) {
        previous.decorations.forEach((item) => item.dispose()); previous.marker.dispose();
        this.painted = this.painted.filter((row) => row !== previous);
      }
      const marker = terminal.registerMarker(index - buffer.baseY - buffer.cursorY);
      if (!marker) continue;
      const cells: { start: number; end: number; x: number; width: number }[] = [];
      let offset = 0;
      for (let x = 0; x < line.length; x += 1) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        const length = (cell.getChars() || " ").length;
        cells.push({ start: offset, end: offset + length, x, width: cell.getWidth() });
        offset += length;
      }
      const decorations: IDecoration[] = [];
      for (const range of terminalHighlightRanges(text, this.rules)) {
        const first = cells.find((cell) => cell.end > range.start);
        const last = [...cells].reverse().find((cell) => cell.start < range.end);
        if (!first || !last) continue;
        const decoration = terminal.registerDecoration({ marker, x: first.x, width: last.x + last.width - first.x, foregroundColor: range.color });
        if (decoration) decorations.push(decoration);
      }
      this.painted.push({ marker, text, decorations });
    }
    this.gutter.hidden = !this.enabled;
    if (!this.enabled) return;
    const rowElement = terminal.element?.querySelector<HTMLElement>(".xterm-rows > div");
    const height = rowElement?.getBoundingClientRect().height ?? 0;
    const times = new Map(this.times.filter((row) => !row.marker.isDisposed).map((row) => [row.marker.line, row.time]));
    const fragment = document.createDocumentFragment();
    for (let y = 0; y < terminal.rows; y += 1) {
      const label = document.createElement("div");
      label.style.height = `${height}px`;
      label.style.lineHeight = `${height}px`;
      label.textContent = buffer.type === "normal" ? times.get(start + y) ?? "" : "";
      fragment.appendChild(label);
    }
    this.gutter.replaceChildren(fragment);
  }
}
