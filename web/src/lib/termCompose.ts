// Terminal compose buffer — send-net-resilience slice 4b.
//
// While the terminal pane's private ws (/vh/term/ws) is down — closed,
// reconnecting, or SUSPECTED half-open (socket reads OPEN but no keepalive for
// TERM_STALE_MS) — typed input must not vanish. Text routes into a visible,
// editable compose buffer shown as NOT SENT; it reaches the PTY only through
// an explicit user send (Send button / Enter-on-buffer), NEVER automatically.
// Binding decision (tmp/agent-runs/send-design/debate-2.md Q4): queue-and-
// replay of raw PTY input means later blind execution of stale keystrokes —
// worse than loss. An explicit, reviewed, one-tap send is the only flush path.
//
// Control-sequence gestures (ESC, TAB, arrows, Ctrl+letter, ^C, DEL) are NOT
// buffered: they are not reviewable text, and deferring them for later
// execution is exactly the prohibited replay hazard. The pane's visibly-held
// state (badge + strip + status dot) is the honest "input is going nowhere"
// surface for them.
//
// The buffer store is deliberately in-memory module state keyed (dir, termId):
// TerminalDock keys each pane on dir+tab, so switching tabs (or closing and
// reopening the dock) REMOUNTS TerminalPane — a pane-local signal would
// silently drop held text on that casual gesture. The store survives
// remounts within the SPA session. It is NOT persisted to storage: reload
// loses it (known limit, honest by visibility — whenever the buffer is
// non-empty the strip is on screen, so there is no window where the user
// believes held text was sent).

/** No-traffic window while the socket still reads OPEN that marks a SUSPECTED
 *  half-open link. The server sends an app-level keepalive every 15s
 *  (pkg/web/terminal.go keepalivePeriod); two missed keepalives + slack means
 *  the link is almost certainly dead while the browser cannot know. Kept
 *  BELOW the pane's 45s LIVENESS_MS force-reconnect so input is held BEFORE
 *  the watchdog tears the link down. Reuses the pane's existing lastRecv
 *  watchdog signal — no parallel health system (research-packet.md §E). */
export const TERM_STALE_MS = 32_000;

export type TermInputKind = "text" | "gesture";

/** A string is holdable compose TEXT iff every character is printable or a
 *  newline — i.e. text the user can see, edit, and consciously send. Anything
 *  containing other control bytes (ESC sequences, TAB, ^C, DEL) is a gesture:
 *  invisible in a textarea, unreviewable, and unsafe to defer. */
export function classifyTermInput(s: string): TermInputKind {
  if (s.length === 0) return "gesture";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 10 || c === 13) continue; // \n \r
    if (c < 0x20 || c === 0x7f) return "gesture";
  }
  return "text";
}

/** PTY wire text → visible compose text: CR (and CRLF) become LF so Enter
 *  renders as a line break in the buffer the user reviews. */
export function toComposeText(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/** Visible compose text → PTY wire text: xterm sends \r for Enter, so map LF
 *  back to CR — a line the user typed offline executes exactly like a line
 *  typed live, at the moment THEY choose to send it. */
export function toWireText(s: string): string {
  return s.replace(/\n/g, "\r");
}

/** Half-open suspicion: derived purely from the pane's existing lastRecv
 *  watchdog bookkeeping. `open` is the pane's live socket state — staleness
 *  only means something while the socket claims to be healthy. */
export function isStaleInput(open: boolean, lastRecvMs: number, nowMs: number): boolean {
  return open && lastRecvMs > 0 && nowMs - lastRecvMs > TERM_STALE_MS;
}

/** Strip visibility. Rules:
 *  - hidden while connected (not stale) with nothing held — the live typing
 *    path gains zero friction (debate-2 Q4 point 4);
 *  - visible whenever text is held, whatever the state — held text survives
 *    reconnect and waits for the explicit send;
 *  - visible-but-empty whenever input would be buffered (the affordance that
 *    says "typing lands here, not sent"), EXCEPT the pane's initial connect,
 *    where an empty "held" strip would be noise on every dock open. */
export function composeStripVisible(
  hasText: boolean,
  status: "connecting" | "open" | "reconnecting" | "disconnected",
  stale: boolean,
): boolean {
  const buffering = stale || status !== "open";
  return hasText || (buffering && status !== "connecting");
}

// --- Buffer store (survives pane remounts; in-memory only) -------------------

const buffers = new Map<string, string>();

function storeKey(dir: string | null | undefined, termId: string | undefined): string {
  // Mirror the pane/server default id ("shared") so the same shell maps to the
  // same buffer whichever way it is addressed.
  return `${dir ?? ""}\u0000${termId || "shared"}`;
}

export function loadTermCompose(dir: string | null | undefined, termId: string | undefined): string {
  return buffers.get(storeKey(dir, termId)) ?? "";
}

export function saveTermCompose(dir: string | null | undefined, termId: string | undefined, text: string): void {
  const k = storeKey(dir, termId);
  if (text) buffers.set(k, text);
  else buffers.delete(k);
}
