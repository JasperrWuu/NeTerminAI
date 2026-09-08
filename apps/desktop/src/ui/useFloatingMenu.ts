import { useCallback, useLayoutEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useNativeSurfaceOcclusion } from "./nativeSurfaceOcclusion";

interface FloatingMenuAnchor {
  current: HTMLElement | null;
}

export function useFloatingMenu(open: boolean, anchorRef: FloatingMenuAnchor) {
  useNativeSurfaceOcclusion(open);
  const [style, setStyle] = useState<CSSProperties>({});

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === "undefined") return;
    const rect = anchor.getBoundingClientRect();
    const gap = 6;
    const viewportPadding = 8;
    const availableBelow = Math.max(0, window.innerHeight - rect.bottom - gap - viewportPadding);
    const availableAbove = Math.max(0, rect.top - gap - viewportPadding);
    const opensAbove = availableBelow < 180 && availableAbove > availableBelow;
    const availableHeight = Math.max(120, Math.min(320, opensAbove ? availableAbove : availableBelow));
    const top = opensAbove
      ? Math.max(viewportPadding, rect.top - gap - availableHeight)
      : Math.min(window.innerHeight - viewportPadding - availableHeight, rect.bottom + gap);
    setStyle({
      left: Math.round(rect.left),
      maxHeight: Math.round(availableHeight),
      top: Math.round(top),
      width: Math.round(rect.width),
    });
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const schedule = () => updatePosition();
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    return () => {
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
    };
  }, [open, updatePosition]);

  return style;
}
