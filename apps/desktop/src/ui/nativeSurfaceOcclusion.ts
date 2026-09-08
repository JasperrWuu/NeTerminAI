import { useLayoutEffect } from "react";

// Native child HWNDs cannot participate in WebView CSS stacking. Suspend their
// presentation while an app floating layer is open, without touching sessions.
let layers = 0;
const listeners = new Set<() => void>();
export const nativeSurfaceOcclusion = {
  get blocked() { return layers > 0; },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
export function acquireNativeSurfaceOcclusion() {
  let released = false;
  layers += 1;
  listeners.forEach((listener) => listener());
  return () => {
    if (released) return;
    released = true;
    layers -= 1;
    listeners.forEach((listener) => listener());
  };
}
export function useNativeSurfaceOcclusion(open: boolean) {
  useLayoutEffect(() => {
    if (!open) return;
    return acquireNativeSurfaceOcclusion();
  }, [open]);
}
