import type { Terminal } from "@xterm/xterm";

/** Opt-in startup snapshot only; never reads terminal text or session data. */
export function reportTerminalRendering(terminal: Terminal, container: HTMLElement) {
  const rect = container.getBoundingClientRect();
  const row = container.querySelector<HTMLElement>(".xterm-rows");
  const style = getComputedStyle(row ?? container);
  const ancestors = [];
  for (let element: HTMLElement | null = container; element; element = element.parentElement) {
    const computed = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    ancestors.push({
      tag: element.tagName, x: bounds.x, y: bounds.y,
      width: bounds.width, height: bounds.height,
      transform: computed.transform, zoom: computed.zoom,
    });
  }
  console.debug("[terminal-render]", {
    renderer: row ? "DOM" : "DOM rows not attached yet",
    fontFamily: terminal.options.fontFamily,
    computedFontFamily: style.fontFamily,
    fontSize: terminal.options.fontSize,
    fontWeight: terminal.options.fontWeight,
    fontWeightBold: terminal.options.fontWeightBold,
    lineHeight: terminal.options.lineHeight,
    letterSpacing: terminal.options.letterSpacing,
    devicePixelRatio: window.devicePixelRatio,
    container: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    ancestors,
    // CSS family lists do not establish the actual font used for each glyph.
    glyphFallback: "verify with WebView2 rendered-font inspection",
  });
}
