# Streaming pagination, native NIC lookup and terminal font fallback

## Verification boundary

This work does not establish the cause of a physical Huawei device stopping at
its fifth pager. No device capture was available. All stream fixtures are
constructed schedules, not Huawei captures or an emulator.

## Automated verification

- Fast paged output: 4/5/6/10/50 pages through OutputHub, CommandCollector,
  bounded input queue, production PTY/SSH writer and a recording Write endpoint.
- Telnet: the same stream passes through the production TCP writer and an actual
  loopback TCP peer. A separate writer test checks exact bytes for 4/5/6/10/50.
- Serial: 10/50 pages, interleaved 1/2/3/5/7-byte chunks, paced by explicit
  acknowledgements, through the production serial write loop. Only the OS Write
  endpoint is substituted; no physical serial port is required.
- Burst plus slow writer: first flush is held behind a synchronization gate until
  the fifth pager has been consumed and enqueued. No sleep establishes correctness.
- Each occurrence has one request, admission, dequeue, successful write and flush;
  endpoint payload is exactly `[0x20]`, with no CR/LF. Flush failure is tested.
- Split UTF-8/ANSI/pager/prompt, no pager newline, erase/CR/backspace and ordered
  business lines are preserved. Near-cap streaming exceeds 90% of the 4 MiB cap.
- Synthetic-clock timeout test retains the absolute deadline under continuous
  output; scoped subscription/command lock release allows another consumer.
- NIC selection covers usg prefix/case/whitespace/natural numeric order and
  invalid/absent IPv4. Font stack tests preserve the selected font and place
  Windows monospace fallbacks before CJK.

No four-action budget was found: pagination limit 512, scripted interaction
limit 32, normal input queue 64. Frontend's 200,000-character limit only slices
displayed Python output, not the backend collector or pagination lifecycle.

## Measurements on this host (not acceptance timing thresholds)

- Hidden ipconfig query, 20 samples: median 24.64 ms, worst 31.91 ms.
- Native GetAdaptersAddresses query, 20 samples: median 0.90 ms, worst 3.18 ms.
  These exclude GUI shortcut/IPC/input latency. No NIC cache is introduced.
- Near-cap constructed streaming test: 12.66 s before and 2.19 s after removing
  per-byte compact/lowercase String allocations from the pager detector (debug).
- Detection remains bounded to 128 ASCII bytes; prompt normalization to 8 KiB.
  Full result normalization runs only at completion, not for each chunk.
- Burst consumer lag was transient (up to 147 chunks in an observed run);
  final lag was zero. Serial handshaked runs had zero backlog. Timing and maximum
  backlog values are observations, not flaky millisecond test assertions.

## Rendering finding and minimal change

xterm 6 constructs DomRenderer; no Canvas/WebGL addon is loaded. Installed-font
registry inspection found Consolas regular/bold, Courier New regular/bold and
Microsoft YaHei on this host, but not Cascadia Mono. Previously the default
family list was Cascadia Mono, Microsoft YaHei, monospace: missing Cascadia
allowed proportional CJK-font Latin glyphs to win before the generic monospace.
Consolas and Courier New now precede the configured CJK fallback. The user's
chosen first font, font weight and all layout settings remain unchanged.

Defaults are 14 px, weight 400, lineHeight 1.18, Cascadia Mono / Microsoft YaHei.
These are defaults, not measured per-glyph WebView2 resolved fonts. No claim is
made about synthetic weight, actual DPR, fractional positions or visual quality
without inspecting the running application. No smoothing, filter, shadow,
transform or arbitrary offset was added.

## Opt-in diagnostics

- Debug build only: `NETERMINAI_PAGINATION_TRACE=1` reports transaction/session,
  occurrence, budget, RX cursor/backlog and dequeue/write/flush stages. Writes
  contain only the known control payload marker `20`, never ordinary input,
  credentials or terminal output. Queue admission is not transport success;
  PTY write success is not proof that a remote SSH peer consumed the byte.
- Frontend development only: `VITE_TERMINAL_RENDER_DIAGNOSTICS=1` reports one
  metadata snapshot after fonts are ready: renderer element, configured/computed
  family list, sizes/weights, DPR, container and ancestor rectangles/transforms.
  It never reads terminal text. A computed family list is not per-glyph proof.

## Manual verification required

- Huawei FW/AR over SSH/Telnet/Serial: >10 actual pages through final prompt.
- GUI Ctrl+I ×20: selected IP, focus, no extra sessions/windows/characters.
- Windows WebView2 at 100/125/150%: startup versus resize, sidebar drag/F11/tab
  switch, physical pixel positions and actual rendered ASCII/CJK fonts.

Native GUI control was unavailable in this agent environment. No GUI/DPI test or
physical Huawei success is claimed. AI/RDP/Workspace/CFG/F11 behavior is unchanged.
