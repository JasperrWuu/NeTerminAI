import type { KeyboardEvent, PointerEvent } from "react";

interface PanelResizeOptions {
  currentWidth: number;
  direction: "left" | "right";
  minimum: number;
  maximum: number;
  onResize: (width: number) => void;
}
function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function usePanelResize({
  currentWidth,
  direction,
  minimum,
  maximum,
  onResize,
}: PanelResizeOptions) {
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = currentWidth;

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const movement = moveEvent.clientX - startX;
      const nextWidth =
        direction === "left" ? startWidth + movement : startWidth - movement;
      onResize(clamp(nextWidth, minimum, maximum));
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.classList.remove("is-resizing");
    };

    document.body.classList.add("is-resizing");
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 12 : -12;
    const adjustedDelta = direction === "left" ? delta : -delta;
    onResize(clamp(currentWidth + adjustedDelta, minimum, maximum));
  };

  return { onPointerDown, onKeyDown };
}
