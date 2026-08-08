import type { ViewKind } from "../dockview/types";

// The host's pane model is decoupled from any concrete content page: each pane
// is just a `{ url, label }` (see dockview/types.ts PaneParams). This module is
// the MOCK source of truth + the fleet resolver that decides, at seed time,
// whether the host embeds the mock content page (default) or REAL vh-solara
// servers declared via `VITE_SERVERS`.
//
// The mock content page (served on :5174, see vite.iframe.config.ts) reads
// `?server=&view=` query params, captures survival identity, opens a WS echo,
// and heartbeats to its parent — it powers the testable shell + the survival
// gate. Real servers are NOT instrumented to heartbeat; the host already handles
// `survivalFor() === undefined` gracefully (no crash), so embedding a real
// server is a display-only pane until the real SPA is instrumented (deferred).

export interface ServerDef {
  /** full server label shown in headers/tabs */
  label: string;
}

// The mock "fleet": each entry stands in for a real vh-solara server whose SPA
// would be embedded cross-origin. Used for the Statusbar server count + as the
// source of mock pane labels.
export const SERVERS: ServerDef[] = [
  { label: "srv-A.my-root-domain" },
  { label: "srv-B.my-root-domain" },
];

// The four mock views, each seeded into its own pane so the shell demonstrates
// a multi-server, multi-view tiled layout. (Internal: the public seed surface
// is resolveFleet()/mockFleet(), which turn these into {url,label} panes.)
const INITIAL: Array<{ server: string; view: ViewKind }> = [
  { server: "srv-A.my-root-domain", view: "chat" },
  { server: "srv-A.my-root-domain", view: "terminal" },
  { server: "srv-B.my-root-domain", view: "diff" },
  { server: "srv-B.my-root-domain", view: "sessions" },
];

// Cross-origin iframe content origin. In dev/test the iframe page is served on
// :5174 (a distinct origin from the host on :5173 by port). Override via
// VITE_IFRAME_ORIGIN when wiring real servers (legacy single-origin override;
// VITE_SERVERS is the preferred multi-server path now).
export const IFRAME_ORIGIN: string =
  (import.meta.env.VITE_IFRAME_ORIGIN as string | undefined) ??
  "http://127.0.0.1:5174";

/**
 * Build the mock content-page URL for a (server, view) pair. Byte-identical to
 * the legacy `iframeUrl(server, view)`: the mock content page needs BOTH
 * `?server=&view=` query params to label itself + heartbeat them. The default
 * mock-fleet path MUST keep producing these exact urls so the survival gate
 * (which asserts on the mock page's heartbeat identity) stays green.
 */
export function mockUrl(server: string, view: ViewKind): string {
  const q = new URLSearchParams({ server, view });
  return `${IFRAME_ORIGIN}/?${q.toString()}`;
}

let paneSeq = 0;
/** Stable-ish pane id generator (unique within a session). */
export function nextPaneId(): string {
  paneSeq += 1;
  return `pane-${paneSeq}`;
}

/**
 * Advance the pane-id counter past `n` so the next nextPaneId() never collides
 * with ids restored from a saved layout. fromJSON recreates panels with their
 * SAVED ids verbatim (dockview's deserializer uses panelData.id), while the
 * module counter resets to 0 on a cold page load — so without this seeding a
 * post-reload "+" / split would regenerate `pane-1` and collide with a restored
 * `pane-1`. The cold-restore path seeds this with the max restored numeric
 * suffix; new splits then continue past the restored range.
 */
export function seedPaneSeq(n: number): void {
  if (Number.isFinite(n) && n > paneSeq) paneSeq = n;
}

// The next mock (server, view) to add when the user hits "+" in MOCK mode. Cycles
// views so repeated "+" spreads across views. (In real-fleet mode the "+"/split
// path clones the focused pane instead — see hostController.newPaneParams.)
let addCursor = 0;
const ALL_VIEWS: ViewKind[] = ["chat", "terminal", "diff", "sessions"];
export function nextMockPane(): { server: string; view: ViewKind } {
  const view = ALL_VIEWS[addCursor % ALL_VIEWS.length];
  const server = SERVERS[addCursor % SERVERS.length].label;
  addCursor += 1;
  return { server, view };
}

// ---- fleet resolver (the ONLY real/mock branch) ---------------------------
// resolveFleet() is called once at seed time (DockviewHost.seedInitialPanes).
// It returns REAL {url,label} pairs when VITE_SERVERS is a non-empty JSON array
// of such pairs; otherwise it returns the mock fleet (the DEFAULT). Parsing is
// defensive: any invalid/empty/unparseable value falls back to the mock fleet
// and NEVER throws (the host must not crash on a bad config).
//
// VITE_SERVERS format (a JSON array STRING, set in the dev/build environment):
//   VITE_SERVERS='[{"url":"https://srv-a.my-root-domain","label":"srv-a"},
//                  {"url":"https://srv-B.my-root-domain","label":"srv-B"}]'
// The `url` is the FULL iframe src the pane will load (set once, never mutated).
// The `label` is the single display string for header/tab/tray. A real server's
// url is typically its root origin; the real SPA authenticates via its own
// SameSite=Lax cookie and runs its SSE same-origin (proven by the Phase-0 spike).

export interface FleetEntry {
  url: string;
  label: string;
}

/** The default mock fleet as {url,label} panes (identical urls/labels to before). */
export function mockFleet(): FleetEntry[] {
  return INITIAL.map(({ server, view }) => ({
    url: mockUrl(server, view),
    label: `${server} · ${view}`,
  }));
}

// Exported (not just used internally by resolveFleet) because the layout-
// persistence cold-restore path REUSES this exact guard to validate pane urls
// read back from localStorage — restored urls go to an UNSANDBOXED iframe.src,
// so the same http/https protocol requirement + reject-on-malformed stance
// applies. Never weaken this; both surfaces (fleet config + saved layout) must
// agree on what a trustworthy {url,label} is.
export function isFleetEntry(v: unknown): v is FleetEntry {
  if (
    typeof v !== "object" ||
    v === null ||
    typeof (v as FleetEntry).url !== "string" ||
    typeof (v as FleetEntry).label !== "string"
  ) {
    return false;
  }
  // SECURITY: the url is assigned to an UNSANDBOXED iframe.src (iframeRenderer),
  // so a `javascript:` (or `data:`/opaque) value would execute same-origin
  // against the host shell. Require an absolute http/https url; reject on a
  // parse failure or any other protocol. The entry falls out of the fleet, and
  // if that empties it resolveFleet falls back to the mock fleet (never throws).
  let protocol: string;
  try {
    protocol = new URL((v as FleetEntry).url).protocol;
  } catch {
    return false;
  }
  return protocol === "http:" || protocol === "https:";
}

/** True when VITE_SERVERS is set to a non-empty JSON array of {url,label}. */
export function hasRealFleetEnv(): boolean {
  const raw = import.meta.env.VITE_SERVERS;
  if (typeof raw !== "string" || raw.trim().length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.filter(isFleetEntry).length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the startup fleet. REAL servers from VITE_SERVERS when valid+non-empty;
 * else the mock fleet (DEFAULT). Pure + side-effect-free; reads the (static,
 * build-time-baked) VITE_SERVERS env. Memoized so the mode is decided once and
 * stays stable for the session.
 */
let fleetCache: FleetEntry[] | null = null;
export function resolveFleet(): FleetEntry[] {
  if (fleetCache) return fleetCache;
  let fleet: FleetEntry[] = [];
  if (hasRealFleetEnv()) {
    try {
      const parsed: unknown = JSON.parse(import.meta.env.VITE_SERVERS as string);
      if (Array.isArray(parsed)) fleet = parsed.filter(isFleetEntry);
    } catch {
      fleet = []; // fall back to mock
    }
  }
  if (fleet.length === 0) fleet = mockFleet();
  fleetCache = fleet;
  return fleet;
}

/**
 * Whether the session is in real-fleet mode. Decided from the same env as
 * resolveFleet() (stable for the build/session). Used by the "+"/split path to
 * decide whether to clone a focused pane (real) or cycle a mock pane (mock).
 */
export function isRealFleet(): boolean {
  return hasRealFleetEnv();
}
