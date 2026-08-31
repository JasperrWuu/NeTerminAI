import { useEffect, useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

type DimensionLimit = number | (() => number);

interface PanelResizeOptions {
  currentWidth: number;
  cssVariable: `--${string}`;
  direction: "left" | "right";
  minimum: DimensionLimit;
  maximum: DimensionLimit;
  onResize: (width: number) => void;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function resolveLimit(limit: DimensionLimit) {
  return typeof limit === "function" ? limit() : limit;
}

export function usePanelResize({
  currentWidth,
  cssVariable,
  direction,
  minimum,
  maximum,
  onResize,
}: PanelResizeOptions) {
  const cancelActiveResize = useRef<() => void>(() => undefined);

  useEffect(() => () => cancelActiveResize.current(), []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    event.preventDefault();
    cancelActiveResize.current();

    const handle = event.currentTarget;
    const workbench = handle.closest<HTMLElement>(".workbench");
    if (!workbench) return;

    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Window-level listeners still keep the resize usable.
    }

    const startX = event.clientX;
    const startWidth = currentWidth;
    let latestWidth = currentWidth;
    let animationFrame = 0;

    const paintWidth = () => {
      animationFrame = 0;
      workbench.style.setProperty(cssVariable, `${latestWidth}px`);
      handle.setAttribute("aria-valuenow", String(Math.round(latestWidth)));
    };

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const movement = moveEvent.clientX - startX;
      const nextWidth =
        direction === "left" ? startWidth + movement : startWidth - movement;
      latestWidth = clamp(
        nextWidth,
        resolveLimit(minimum),
        resolveLimit(maximum),
      );

      if (!animationFrame) animationFrame = requestAnimationFrame(paintWidth);
    };

    const finishResize = (commit: boolean) => {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        paintWidth();
      }
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("blur", handleWindowBlur);
      document.body.classList.remove("is-resizing");

      if (commit) {
        onResize(latestWidth);
      } else {
        workbench.style.setProperty(cssVariable, `${currentWidth}px`);
        handle.setAttribute("aria-valuenow", String(Math.round(currentWidth)));
      }

      cancelActiveResize.current = () => undefined;
    };

    const handlePointerUp = () => finishResize(true);
    const handlePointerCancel = () => finishResize(false);
    const handleWindowBlur = () => finishResize(true);

    document.body.classList.add("is-resizing");
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("blur", handleWindowBlur);
    cancelActiveResize.current = () => finishResize(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 12 : -12;
    const adjustedDelta = direction === "left" ? delta : -delta;
    onResize(
      clamp(
        currentWidth + adjustedDelta,
        resolveLimit(minimum),
        resolveLimit(maximum),
      ),
    );
  };

  return { onPointerDown, onKeyDown };
}
