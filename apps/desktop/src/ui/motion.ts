export const motion = {
  duration: {
    fast: 120,
    selection: 180,
    standard: 220,
  },
  easing: {
    out: "cubic-bezier(0.23, 1, 0.32, 1)",
    inOut: "cubic-bezier(0.77, 0, 0.175, 1)",
  },
} as const;

export function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
