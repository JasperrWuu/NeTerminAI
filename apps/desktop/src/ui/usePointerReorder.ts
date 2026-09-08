import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/** Reorder by stable rows; mutate only drag presentation until release. */
export function usePointerReorder(onMove: (from: number, to: number) => void) {
  const cleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cleanup.current?.(), []);
  return (event: ReactPointerEvent<HTMLElement>, index: number) => {
    if (event.button !== 0 || !event.isPrimary) return;
    cleanup.current?.();
    const handle = event.currentTarget;
    const row = handle.closest<HTMLElement>("[data-reorder-row]");
    if (!row?.parentElement) return;
    const rows = Array.from(row.parentElement.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
    const bounds = rows.map((item) => item.getBoundingClientRect());
    const start = event.clientY;
    let destination = index;
    handle.setPointerCapture(event.pointerId);
    row.dataset.dragging = "true";
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      const delta = Math.max(bounds[0].top - bounds[index].top,
        Math.min(next.clientY - start, bounds.at(-1)!.bottom - bounds[index].bottom));
      row.style.transform = `translateY(${delta}px)`;
      const center = (bounds[index].top + bounds[index].bottom) / 2 + delta;
      destination = bounds.reduce((best, rect, i) => Math.abs((rect.top + rect.bottom) / 2 - center)
        < Math.abs((bounds[best].top + bounds[best].bottom) / 2 - center) ? i : best, index);
      rows.forEach((item, i) => { item.dataset.dropTarget = String(i === destination && i !== index); });
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      row.style.transform = "";
      delete row.dataset.dragging;
      rows.forEach((item) => { delete item.dataset.dropTarget; });
      cleanup.current = undefined;
    };
    const up = () => { finish(); if (destination !== index) onMove(index, destination); };
    const cancel = () => finish();
    cleanup.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
    window.addEventListener("blur", cancel, { once: true });
  };
}
