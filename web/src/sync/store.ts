// The sync store core: the Solid store of sessions plus the per-tab selection /
// project / draft signals, their localStorage persistence, and the hydrate
// helpers. This is the leaf every other sync module reads from — it imports
// nothing from its siblings, so the rest of the decomposition hangs off it
// without a cycle. State is reconciled by id, never nuked.
import { createStore, produce, reconcile } from "solid-js/store";
import { createSignal } from "solid-js";
import type { ConnStatus, GateFacts, Permission, ProjectConstants, Question, Session, SessionMessages, VerbFacet } from "../types";
import { loadVersioned, saveVersioned } from "../lib/store";

const LS_CURSOR = "vh.cursor.v1";
const LS_ACTIVITY = "vh.activity.v1";
const LS_LASTAGENTS = "vh.lastagents.v1";
// Explicit per-session agent picks (the composer dropdown), persisted per
// project dir. NOT part of the debounced persist() batch — picks are written
// through explicitly at pick time (setSessionAgentPick), mirroring
// persistSelection()'s rationale (a reactive debounced write could race a
// switchProject and clobber the NEW project's saved picks with the OLD
// project's values).
const LS_SESSIONAGENTS = "vh.sessionagents.v1";
// Last-selected session id, persisted per project so the installed PWA reopens
// the same session after an OS-driven relaunch (which drops ?session=). NOT part
// of the debounced persist() batch — see persistSelection() for why.
const LS_SELECTED = "vh.selected.v1";
export const LS_PROJECT = "vh.project.dir";

// Persistence is keyed per project directory so each project hydrates its own
// tree instantly on switch. "" is the default project (OpenCode serve cwd).
// §11 (docs/design/server-owned-tree.md): the session TREE STRUCTURE is NEVER
// persisted to localStorage — that caused flatten-on-load (tree=2 re-fetches
// the frontier via tree.snapshot on connect). Only chat fast-path data
// (cursor/activity/lastAgents) and UI state (LS_PROJECT + LS_SELECTED) are persisted.
export const lsCursor = (dir: string) => `${LS_CURSOR}:${dir}`;
export const lsActivity = (dir: string) => `${LS_ACTIVITY}:${dir}`;
export const lsLastAgents = (dir: string) => `${LS_LASTAGENTS}:${dir}`;
export const lsSessionAgents = (dir: string) => `${LS_SESSIONAGENTS}:${dir}`;
export const lsSelected = (dir: string) => `${LS_SELECTED}:${dir}`;

export const loadCursor = (dir: string) =>
  loadVersioned<number>(lsCursor(dir), 1, 0, (o) => Number(o) || 0);
// Activity is persisted alongside sessions so a reload hydrates running state
// INSTANTLY. Without this, activity started empty on reload and — since the
// stream resumes from the saved cursor — an activity=busy that fired before that
// cursor was never replayed, so a busy session showed idle until the next event
// (the reported "~1min to recognize busy after reload"). The live stream then
// reconciles any change.
export function loadActivity(dir: string): Record<string, string> {
  return loadVersioned<Record<string, string>>(lsActivity(dir), 1, {}, (o) =>
    o && typeof o === "object" ? (o as Record<string, string>) : {},
  );
}
// Per-session agent names (for tree chips) are persisted alongside sessions so
// a reload renders the chips INSTANTLY — before the snapshot/stream arrive.
// Mirrors activity's persistence rationale. The live stream reconciles updates.
export function loadLastAgents(dir: string): Record<string, string> {
  return loadVersioned<Record<string, string>>(lsLastAgents(dir), 1, {}, (o) =>
    o && typeof o === "object" ? (o as Record<string, string>) : {},
  );
}

// One explicit per-session agent pick. `t` is the write time (Date.now()) —
// used ONLY to bound the store: when the map exceeds
// SESSION_AGENT_PICKS_CAP, the OLDEST picks are dropped. It is not a
// recency signal for resolution (an explicit pick is authoritative for its
// session until the session is removed or the agent becomes unavailable).
export interface SessionAgentPick {
  agent: string;
  t: number;
}

// Cap on the persisted pick map. Picks are tiny (~50B each), but the store is
// per-project localStorage seeded at module load and never server-pruned, so
// without a cap a long-lived install accumulates one entry per session ever
// picked in. 200 comfortably exceeds "sessions you actively switch agents
// between" while bounding the payload at ~10KiB.
export const SESSION_AGENT_PICKS_CAP = 200;

// Sanitize a foreign/corrupt payload: keep only entries whose shape is
// {agent: non-empty string, t: number}.
function sanitizePicks(o: unknown): Record<string, SessionAgentPick> {
  if (!o || typeof o !== "object" || Array.isArray(o)) return {};
  const out: Record<string, SessionAgentPick> = {};
  for (const [id, v] of Object.entries(o as Record<string, unknown>)) {
    if (!id || !v || typeof v !== "object") continue;
    const p = v as { agent?: unknown; t?: unknown };
    if (typeof p.agent !== "string" || !p.agent) continue;
    out[id] = { agent: p.agent, t: typeof p.t === "number" && Number.isFinite(p.t) ? p.t : 0 };
  }
  return out;
}

// Explicit per-session agent picks, persisted per project dir so an explicit
// composer dropdown choice SURVIVES a reload/PWA relaunch. Rationale (the
// 2026-08 silent-flip incidents): the previous in-memory map was lost on
// reload, and while hydration hadn't caught up the resolver fell back to the
// config default_agent — sending an existing session's prompt under the WRONG
// agent. A persisted pick is the top rung of the evidence ladder (see
// agents.ts resolveAgentForSession). Mirrors loadLastAgents' instant-rehydrate
// rationale; the live stream + session-removal prune keep it convergent.
export function loadSessionAgents(dir: string): Record<string, SessionAgentPick> {
  // Sanitize UNCONDITIONALLY, not just via loadVersioned's migrate hook:
  // loadVersioned returns env.data AS-IS when the envelope version matches
  // (no type validation — see loadSelected's note), so a foreign/corrupt
  // {v:1,data:<garbage>} payload would otherwise flow into the store raw.
  // There is no legacy format to migrate, so version-mismatch/corrupt-JSON
  // simply fall back to the empty map via loadVersioned's null fallback.
  return sanitizePicks(loadVersioned<unknown>(lsSessionAgents(dir), 1, null));
}

// Last-selected session id for this project — the localStorage counterpart to
// the URL's ?session= deep-link. On an OS-driven relaunch the installed PWA
// reopens start_url=/ (dropping ?session=), so without this fallback the
// selection was lost on every resume. The URL still WINS when ?session= is
// present (mirrors urlDir() — shareability + per-tab state preserved); this is
// the fallback ONLY when the URL omits it. Restore is OPTIMISTIC and mirrors
// the existing ?session= path (no existence check): a stale id (session
// deleted server-side, or belongs to a different project) leaves a ghost
// selection exactly as the URL path already does today — see closeout.
export function loadSelected(dir: string): string | null {
  // No migrate fn: this key has no legacy format to preserve, so a version
  // mismatch / corrupt-JSON / legacy-unversioned value all fall back to null.
  // loadVersioned returns env.data AS-IS when the envelope version matches
  // (no type validation), so re-check the type here to defend against a
  // foreign/corrupt {v:1,data:<non-string>} payload.
  const v = loadVersioned<unknown>(lsSelected(dir), 1, null);
  return typeof v === "string" && v ? v : null;
}

// Persist the current selection explicitly. Deliberately OUTSIDE the debounced
// persist(): switchProject calls setSelectedIdRaw(null) under the NEW
// projectDir, and a reactive debounced write would clobber the new project's
// saved id with null. Writing here only on actual selection (setSelectedId /
// startSync restore / popstate) — never on the switchProject/newSession nulls
// (those bypass setSelectedId via setSelectedIdRaw, correctly).
export function persistSelection(dir: string, id: string | null): void {
  saveVersioned(lsSelected(dir), 1, id);
}

// The workspace is the URL's source of truth (so each tab keeps its own across
// reload and is shareable); localStorage is only the fallback when the URL omits
// it. `?dir=` absent → default project (""); `?dir=` present (even empty) wins.
export function urlDir(): string | null {
  try {
    const u = new URLSearchParams(location.search);
    return u.has("dir") ? u.get("dir") || "" : null;
  } catch {
    return null;
  }
}
const initialDir =
  urlDir() ?? loadVersioned<string>(LS_PROJECT, 1, "", (o) => (typeof o === "string" ? o : ""));

// Per-session resident-window state (Phase 3 — client initial-window semantics;
// Phase 4 — historical-page load-older). Derived from the server's
// MessageWindowMeta whenever a bounded tail lands (messages.batch,
// applySessionSnapshot, refreshOpenSessions). Purely additive: no existing
// field changed semantics. Phase 4 adds the load-older transport flag
// (loadingOlder) + the sticky eviction flag (evictedHistory) — gap-marker /
// eviction-range tracking is intentionally minimal in this cut (eviction ORs
// a persistent evictedHistory into hasOlder so the Load-older button stays
// visible after eviction even if a later page reports has_older=false;
// bidirectional eviction is a documented follow-up).
export interface MessageWindowState {
  // Server says older messages exist beyond the resident tail. Drives the
  // "Load older" affordance. False (or absent) for an unbounded server. This
  // is the OR of the server's per-page has_older signal AND the eviction
  // signal (once we've evicted messages that are still on the server).
  hasOlder: boolean;
  // Oldest message id currently resident (top of the tail). Acts as the prepend
  // cursor for the Phase-4 historical-page fetch. Undefined when no messages
  // are resident (empty cold fetch) — the Phase-4 button is hidden in that case.
  oldestResidentID?: string;
  // Phase 4: a historical page request is in flight for this session. Drives
  // the button spinner + the IntersectionObserver guard (one page per signal).
  // Transport state surfaced through the store ONLY so the UI can react; the
  // authoritative single-flight state lives in stream.ts's pageInFlight map.
  loadingOlder?: boolean;
  // Phase 4: sticky eviction flag. Set true the first time evictIfOverCap
  // yanks messages from the oldest end, and never reset within the session
  // (cleared on session.delete/switchProject via the whole-window reset).
  // Forces hasOlder=true persistently because the evicted messages remain on
  // the server and re-fetchable — without this, a later end-of-history page
  // (has_older=false) would hide the Load-older button even though evicted
  // messages are still available. Reset only when the whole window state is
  // rebuilt (cold load, session switch, project switch).
  evictedHistory?: boolean;
}

export interface SyncState {
  sessions: Record<string, Session>;
  // Messages are held only for opened sessions, to bound memory.
  messages: Record<string, SessionMessages>;
  // Per-session bounded-window metadata (Phase 3 — client initial-window
  // semantics). Mirrors the server's window projection so the client knows
  // whether older messages exist beyond the resident tail (the "Load older"
  // affordance) and the oldest resident id (the prepend cursor). Populated by
  // the three tail-landing paths (messages.batch, applySessionSnapshot,
  // refreshOpenSessions) when a bounded tail lands; pruned on session.delete;
  // reset on switchProject. See MessageWindowState.
  //
  // DISTINCT from messagesDelivered (the boolean "initial window delivered" gate):
  // messagesDelivered tells the UI the transcript is ready to REVEAL;
  // messageWindows[id].hasOlder tells the UI a "Load older" button should SHOW.
  // The split lets the reveal gate and the windowing affordance evolve
  // independently (a warm reopen reveals instantly from cache while the window
  // state is re-asserted from the fresh snapshot).
  messageWindows: Record<string, MessageWindowState>;
  // Per-session flag: true once the active-session message snapshot (Stream 2)
  // or a refreshOpenSessions fetch has delivered the real message list. NOTE
  // (Phase 3): after server-side transcript windowing (Phase 1), this means
  // "the initial BOUNDED window delivered" — NOT "the whole transcript is
  // resident". A bounded server ships only the recent tail (default 100 msgs /
  // 1 MiB) and reports via `messageWindows[id].hasOlder` whether older
  // messages exist; older pages are lazy-loaded by the Phase-4 prepend path.
  // No existing consumer assumed whole-transcript-residency (the audit found
  // only boolean reveal gates: ChatView, SessionTree dots), so the semantic
  // shift is back-compat. See SyncState.messageWindows for the windowing map.
  // Why this exists: openSession() pre-reserves a truthy-but-empty {order:[],byId:{}}
  // slot the INSTANT a session is selected, so messages[id] is truthy BEFORE the
  // real snapshot arrives. Gating the transcript empty/loading state on that
  // truthiness shows "No messages" during the gap. This flag separates
  // "reserved-but-not-delivered" (→ loading) from "delivered-and-empty"
  // (→ genuinely no messages). See ChatView maybeRestore's order-length guard
  // and the transcript empty-state discriminator.
  messagesDelivered: Record<string, boolean>;
  // Per-session flag: the active-session background hydration FAILED (the daemon
  // emitted messages.error and left the session unloaded). Distinct from
  // messagesDelivered (which stays false on error): ChatView's visual-reveal gate
  // holds the transcript hidden until EITHER delivered OR errored, so a failed
  // hydration reveals whatever partial content we have (instead of wedging on a
  // blank loading state forever — messages.loaded never arrives on failure).
  // Cleared by a later messages.loaded / a successful Stream-2 snapshot, and
  // pruned on session.delete (mirrors messagesDelivered).
  messagesError: Record<string, boolean>;
  // Per-session flag: this session's Stream-2 (active-session) connection is
  // OPEN and its first authoritative snapshot has NOT arrived yet this
  // connection — i.e. we are showing cached/stale message state (a warm reopen
  // renders instantly from the in-memory transcript) while the fresh snapshot
  // is still in flight (the ~5s daemon-side serve). Distinct from
  // messagesDelivered (which flips true IMMEDIATELY on a warm snapshot, so it
  // cannot signal "cached, refresh pending") and from connLatency.session.hydrate
  // (a per-CONNECTION one-shot diagnostic, not a live per-session flag). Set
  // true when openSessionStream (re)opens the stream, cleared when that
  // connection's first snapshot lands (stream.ts) or the stream is
  // closed/switched away. Drives the per-row .dot.refreshing warm silent-swap
  // indicator. Ephemeral — NOT persisted, pruned on session.delete.
  refreshing: Record<string, boolean>;
  // Per-session activity (busy/idle/error) and pending permissions are kept for
  // ALL sessions so the sidebar/chat can surface status without opening them.
  activity: Record<string, string>;
  // Per-session agent name (most recent assistant turn) for ALL sessions, so the
  // tree can render per-agent chips on a cold tree before any session is opened.
  lastAgents: Record<string, string>;
  // Per-session current-verb facet (raw tool primitive) for ALL sessions, so an
  // UNOPENED task-tool subagent's chat row can show rich activity ("Reading
  // parser.go") WITHOUT loading Tier-B (message) data. Ephemeral and NOT
  // persisted: a stale verb on reload would be misleading (the agent may have
  // moved on), so this self-heals from the snapshot facet + the next live
  // activity.verb event within seconds — unlike lastAgents/activity, which ARE
  // persisted to render chips/state instantly on a cold reload.
  currentVerbs: Record<string, VerbFacet>;
  // Per-session gate facts — a live mirror of the server's GateFacts map
  // (pkg/state/store.go, snap.gate). Seeded authoritatively from the snapshot
  // in projectSnapshot and live-patched by the permission.blocked event
  // (projectMessageEvent) so an already-connected client reflects the false→true
  // permission-blocking transition WITHOUT a snapshot/reconnect — mirroring the
  // lastAgents snapshot-seed + live-patch pattern. Ephemeral — NOT persisted
  // (re-derived from the snapshot on every load, like every other gate fact);
  // pruned on session.delete so a deleted session's facts can't leak or
  // resurrect on id-reuse. The SPA does not yet RENDER from this field (the
  // store.go doc on KindPermissionBlocked documented the snapshot-only delivery
  // gap honestly); wiring it makes the live consumer land so convergence is
  // immediate and a future render reads the exact gate shape from here.
  gate: Record<string, GateFacts>;
  permissions: Record<string, Record<string, Permission>>;
  questions: Record<string, Record<string, Question>>;
  // Root sessions that finished and haven't been acknowledged (server-tracked,
  // cross-device) — drives the "finished/unread" indicator in the tree.
  unread: Record<string, boolean>;
  // ProjectConstants (Phase 3 snapshot trim): the hoisted per-session
  // model/projectID/directory from a projected snapshot emitted under
  // ?hoist=1. Absent/undefined when the server didn't hoist (old client,
  // legacy Snapshot path, or an old daemon). Ephemeral — NOT persisted (it's
  // re-derived on every projected snapshot). Cleared implicitly on project
  // switch (the fresh tree snapshot re-populates it for the new project). See
  // ProjectConstants (types.ts) and selectors.sessionModel (fallback).
  projectConstants?: ProjectConstants;
  status: ConnStatus;
  cursor: number;
  // authoritativeReady: Q5 convergence boundary. False while the current
  // connection's most recent tree+detail capture projections are still landing;
  // flips true when the server's `snapshot.complete` named SSE event arrives
  // (commit C1, pkg/web/server.go). The boundary is TRUTHFUL: the server emits
  // it only after BOTH projections of the SAME {epoch, seq} capture were
  // written (gated on treeOK && detailOK — no false atomicity). The FE cannot
  // correlate by arrival/decode order (tree.snapshot is gzip64-decoded async;
  // detail snapshot ships RAW sync), so this is the ONLY coherent-capture
  // signal. Reset to false on each new connection (connect()). Old daemons that
  // don't emit snapshot.complete leave this false — the existing
  // treeSnapDone / status==="live" signals remain the operational ready
  // indicator (backward-compatible degradation).
  authoritativeReady: boolean;
  // --- Connection-health diagnostics (FE-only) -----------------------------
  // lastSeen: ms-of-last-SSE-byte, mirrored from the stream's hot-path
  // module var (throttled to ~1 write/sec to avoid per-event reactive churn).
  // The authoritative staleness check lives in stream.ts (isStale), reading the
  // unthrottled module var; this field is for debug display only.
  lastSeen: number;
  // epoch: the daemon generation from the snapshot (or X-VH-Epoch header).
  // A change across a live connection means the server restarted.
  epoch: string;
  // epochChanged: latched true when an epoch transition is detected during a
  // live connection (NOT the first snapshot after load). Consumed + cleared by
  // the connection-health toast to surface "Server restarted — re-syncing…".
  epochChanged: boolean;
  // connLatency: per-stream connection-vs-first-snapshot latency diagnostics
  // (Feature 3). `open` = EventSource construction → onopen (pure connection
  // latency); `snap` = onopen → first snapshot event (end-to-end: server compute +
  // snapshot serialize + tunnel transport of the payload through the controller —
  // under refreshOpenSessions fan-out the transit dominates; server compute is
  // sub-20ms). Session stream also carries
  // `hydrate` = first snapshot arrival → messages.loaded arrival — the upstream
  // full-fetch wait that `snap` is blind to on a COLD session (the snapshot
  // ships instantly with gate.messagesLoaded=false, then the daemon fetches the
  // full history async; the client reveal gate holds until messages.loaded).
  // `"warm"` marks a session whose first snapshot already had
  // gate.messagesLoaded===true (no fetch needed → messages.loaded never comes);
  // undefined = cold and still waiting, OR no session stream open. The
  // warm-vs-number split is itself the diagnostic signal (warm switch = instant,
  // cold switch = the multi-second stall).
  //
  // `fetchMs`/`reconcileMs` split `hydrate` (a cold session that fired
  // messages.loaded): fetchMs = the upstream OpenCode GET round-trip,
  // reconcileMs = the daemon-side SetSessionMessages. Carried on the
  // messages.loaded payload; absent (undefined) for an older daemon, a warm
  // session (messages.loaded never fires), or while a cold fetch is still in
  // flight — the UI renders "—" then.
  connLatency: {
    tree: { open?: number; snap?: number };
    session: {
      open?: number;
      snap?: number;
      hydrate?: number | "warm";
      fetchMs?: number;
      reconcileMs?: number;
    };
  };
}

export const [state, setState] = createStore<SyncState>({
  sessions: {}, // §11: tree structure never persisted (tree=2 re-fetches on connect)
  messages: {},
  messageWindows: {},
  messagesDelivered: {},
  messagesError: {},
  refreshing: {},
  activity: loadActivity(initialDir),
  lastAgents: loadLastAgents(initialDir),
  currentVerbs: {},
  gate: {},
  permissions: {},
  questions: {},
  unread: {},
  status: "connecting",
  cursor: loadCursor(initialDir),
  authoritativeReady: false,
  lastSeen: 0,
  epoch: "",
  epochChanged: false,
  connLatency: { tree: {}, session: {} },
});

// In-flight sends, keyed by sessionID. OpenCode's POST /session/:id/message
// blocks until the turn *settles* — which can be minutes, or forever if the
// turn pauses on a permission or was interrupted mid-generation (a dangling
// assistant turn after a restart). This MUST be per-session: the chat component
// is reused across sessions, so a single shared "sending" flag meant one hung
// send silently gated the composer of EVERY other session ("only the first
// session after a restart works"). Keyed here, a stuck send only blocks its own
// session.
const [sendingState, setSendingState] = createStore<Record<string, boolean>>({});
export function isSending(id: string): boolean {
  return !!sendingState[id];
}
export function setSending(id: string, v: boolean): void {
  setSendingState(id, v);
}

// Explicit per-session agent picks (see SessionAgentPick). Seeded from the
// same initialDir as state, re-seeded on switchProject (resetSessionAgentPicks),
// pruned per-id on session removal (clearSessionAgentPick — mirrors the B2b
// lastAgents id-reuse guard in projectSessionRemoval's effect path).
const [sessionAgentPicks, setSessionAgentPicks] = createStore<Record<string, SessionAgentPick>>(
  loadSessionAgents(initialDir),
);
export { sessionAgentPicks };

// Enforce the cap + write through to localStorage for the CURRENT project dir.
// Sort by write time descending, keep the newest SESSION_AGENT_PICKS_CAP
// entries. Write-through (not debounced): a pick is a rare, explicit user
// action, and mirroring persistSelection's explicit-write rationale avoids a
// switchProject race clobbering the new project's persisted picks.
function persistPicks(): void {
  const dir = projectDir();
  const entries = Object.entries(sessionAgentPicks).sort((a, b) => b[1].t - a[1].t);
  const capped: Record<string, SessionAgentPick> = {};
  for (let i = 0; i < entries.length && i < SESSION_AGENT_PICKS_CAP; i++) capped[entries[i][0]] = entries[i][1];
  saveVersioned(lsSessionAgents(dir), 1, capped);
  // Reflect the cap in memory too, so the resolver can never resurrect a
  // dropped pick from the in-memory map. `reconcile` diffs the replacement
  // into the store so reactive readers only re-run for actually-dropped keys.
  setSessionAgentPicks(reconcile(capped));
}

// Record an explicit pick for a session (write-through, capped). Re-picking
// the same agent refreshes its write time (keeps active sessions alive under
// the cap).
export function setSessionAgentPick(id: string, agent: string): void {
  if (!id || !agent) return;
  setSessionAgentPicks(id, { agent, t: Date.now() });
  persistPicks();
}

// Drop a session's pick (session removed / id reused server-side). Prunes
// both memory and the persisted map. The delete MUST go through the setter
// (produce): the exported store value is a read proxy, and a bare
// `delete sessionAgentPicks[id]` on it is SILENTLY SWALLOWED — the entry
// survives in memory and persistPicks() below re-persists it, so the
// session-removed effect path left stale picks behind (exactly the id-reuse
// silent-flip guard this function exists for; pinned by
// deletionCascadeParity.test.ts).
export function clearSessionAgentPick(id: string): void {
  if (!(id in sessionAgentPicks)) return;
  setSessionAgentPicks(
    produce((m) => {
      delete m[id];
    }),
  );
  persistPicks();
}

// Swap the whole map on project switch (actions.ts switchProject): seed the
// new project dir's persisted picks, WITHOUT persisting (the new dir already
// owns its persisted copy — writing here would save the OLD map under the NEW
// dir's key).
export function resetSessionAgentPicks(next: Record<string, SessionAgentPick>): void {
  setSessionAgentPicks(reconcile(next));
}

// Current project directory ("" = default). Multi-project: snapshot/stream and
// /oc requests are scoped to this directory.
export const [projectDir, setProjectDirRaw] = createSignal(initialDir);

export const [selectedId, setSelectedIdRaw] = createSignal<string | null>(null);
// Draft (composing) mode: "New session" enters this WITHOUT creating a server
// session — the session is only created when the first message is sent.
export const [draft, setDraft] = createSignal(false);

let persistTimer: number | undefined;
export function persist() {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    const dir = projectDir();
    saveVersioned(lsCursor(dir), 1, state.cursor);
    saveVersioned(lsActivity(dir), 1, state.activity);
    saveVersioned(lsLastAgents(dir), 1, state.lastAgents);
  }, 250);
}
