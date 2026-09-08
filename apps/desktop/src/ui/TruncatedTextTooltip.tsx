import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useNativeSurfaceOcclusion } from "./nativeSurfaceOcclusion";

/** Delegated, measurement-based support for existing ellipsis labels. No wrapper
 * is added to controls, so flex sizing and their hit targets remain unchanged. */
export function TruncatedTextTooltip() {
  const id = useId();
  const [tip, setTip] = useState<{ text: string; x: number; y: number; top: number } | null>(null);
  useNativeSurfaceOcclusion(tip !== null);
  useEffect(() => {
    let anchor: HTMLElement | null = null;
    let timer: number | undefined;
    const close = () => {
      window.clearTimeout(timer);
      if (anchor?.getAttribute("aria-describedby") === id) anchor.removeAttribute("aria-describedby");
      anchor = null;
      setTip(null);
    };
    const enter = (event: Event) => {
      let node = event.target instanceof HTMLElement ? event.target : null;
      while (node && node !== document.body) {
        if (getComputedStyle(node).textOverflow === "ellipsis" && node.scrollWidth > node.clientWidth) break;
        node = node.parentElement;
      }
      if (node === anchor) return;
      close();
      if (!node || node === document.body || node.closest(".xterm")) return;
      anchor = node;
      timer = window.setTimeout(() => {
        if (!anchor?.isConnected || anchor.scrollWidth <= anchor.clientWidth) return;
        const rect = anchor.getBoundingClientRect();
        anchor.setAttribute("aria-describedby", id);
        setTip({ text: anchor.textContent ?? "", x: Math.max(8, Math.min(rect.left, window.innerWidth - 328)), y: rect.bottom + 6, top: rect.top });
      }, 350);
    };
    const leave = (event: PointerEvent) => {
      if (anchor && !(event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))) close();
    };
    document.addEventListener("pointerover", enter);
    document.addEventListener("pointerout", leave);
    document.addEventListener("focusin", enter);
    document.addEventListener("focusout", close);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      close();
      document.removeEventListener("pointerover", enter);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusin", enter);
      document.removeEventListener("focusout", close);
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [id]);
  return tip && createPortal(<div ref={(node) => {
    if (node && tip.y + node.offsetHeight > window.innerHeight - 8) {
      node.style.top = `${Math.max(8, tip.top - node.offsetHeight - 6)}px`;
    }
  }} className="truncated-text-tooltip" id={id} role="tooltip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>, document.body);
}
