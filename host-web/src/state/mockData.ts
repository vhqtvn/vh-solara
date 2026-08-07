import type { ViewKind } from "../dockview/types";

// The mock "fleet": each entry stands in for a real vh-solara server whose SPA
// would be embedded cross-origin. Real wiring (the server-side --frame-ancestors
// CSP change + real servers) is a deferred follow-up; these power the testable
// shell + the survival gate.

export interface ServerDef {
  /** full server label shown in headers/tabs */
  label: string;
}

export const SERVERS: ServerDef[] = [
  { label: "srv-A.my-root-domain" },
  { label: "srv-B.my-root-domain" },
];

// The four mock views, each seeded into its own pane so the shell demonstrates
// a multi-server, multi-view tiled layout.
export const INITIAL_PANES: Array<{ server: string; view: ViewKind }> = [
  { server: "srv-A.my-root-domain", view: "chat" },
  { server: "srv-A.my-root-domain", view: "terminal" },
  { server: "srv-B.my-root-domain", view: "diff" },
  { server: "srv-B.my-root-domain", view: "sessions" },
];

// Cross-origin iframe content origin. In dev/test the iframe page is served on
// :5174 (a distinct origin from the host on :5173 by port). Override via
// VITE_IFRAME_ORIGIN when wiring real servers.
export const IFRAME_ORIGIN: string =
  (import.meta.env.VITE_IFRAME_ORIGIN as string | undefined) ??
  "http://127.0.0.1:5174";

/** Build the cross-origin iframe URL for a (server, view) pair. */
export function iframeUrl(server: string, view: ViewKind): string {
  const q = new URLSearchParams({ server, view });
  return `${IFRAME_ORIGIN}/?${q.toString()}`;
}

let paneSeq = 0;
/** Stable-ish pane id generator (unique within a session). */
export function nextPaneId(): string {
  paneSeq += 1;
  return `pane-${paneSeq}`;
}

// The next mock (server, view) to add when the user hits "+". Cycles views so
// repeated "+" spreads across views.
let addCursor = 0;
const ALL_VIEWS: ViewKind[] = ["chat", "terminal", "diff", "sessions"];
export function nextMockPane(): { server: string; view: ViewKind } {
  const view = ALL_VIEWS[addCursor % ALL_VIEWS.length];
  const server = SERVERS[addCursor % SERVERS.length].label;
  addCursor += 1;
  return { server, view };
}
