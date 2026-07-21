// The sync store core: the Solid store of sessions plus the per-tab selection /
// project / draft signals, their localStorage persistence, and the hydrate
// helpers. This is the leaf every other sync module reads from — it imports
// nothing from its siblings, so the rest of the decomposition hangs off it
// without a cycle. State is reconciled by id, never nuked.
import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";
import type { ConnStatus, Permission, Question, Session, SessionMessages, TodoItem, VerbFacet } from "../types";
import { loadVersioned, saveVersioned } from "../lib/store";

const LS_SESSIONS = "vh.sessions.v1";
const LS_CURSOR = "vh.cursor.v1";
const LS_ACTIVITY = "vh.activity.v1";
const LS_LASTAGENTS = "vh.lastagents.v1";
export const LS_PROJECT = "vh.project.dir";

// Persistence is keyed per project directory so each project hydrates its own
// tree instantly on switch. "" is the default project (OpenCode serve cwd).
export const lsSessions = (dir: string) => `${LS_SESSIONS}:${dir}`;
export const lsCursor = (dir: string) => `${LS_CURSOR}:${dir}`;
export const lsActivity = (dir: string) => `${LS_ACTIVITY}:${dir}`;
export const lsLastAgents = (dir: string) => `${LS_LASTAGENTS}:${dir}`;

export function loadSessions(dir: string): Record<string, Session> {
  return loadVersioned<Record<string, Session>>(lsSessions(dir), 1, {}, (o) =>
    o && typeof o === "object" ? (o as Record<string, Session>) : {},
  );
}
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
  // the three wholesale-replace paths (messages.batch, applySessionSnapshot,
  // refreshOpenSessions) when a bounded tail lands; pruned on session.delete;
  // reset on switchProject. See MessageWindowState.
  //
  // DISTINCT from messagesLoaded (the boolean "initial window delivered" gate):
  // messagesLoaded tells the UI the transcript is ready to REVEAL;
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
  messagesLoaded: Record<string, boolean>;
  // Per-session flag: the active-session background hydration FAILED (the daemon
  // emitted messages.error and left the session unloaded). Distinct from
  // messagesLoaded (which stays false on error): ChatView's visual-reveal gate
  // holds the transcript hidden until EITHER delivered OR errored, so a failed
  // hydration reveals whatever partial content we have (instead of wedging on a
  // blank loading state forever — messages.loaded never arrives on failure).
  // Cleared by a later messages.loaded / a successful Stream-2 snapshot, and
  // pruned on session.delete (mirrors messagesLoaded).
  messagesError: Record<string, boolean>;
  // Per-session flag: this session's Stream-2 (active-session) connection is
  // OPEN and its first authoritative snapshot has NOT arrived yet this
  // connection — i.e. we are showing cached/stale message state (a warm reopen
  // renders instantly from the in-memory transcript) while the fresh snapshot
  // is still in flight (the ~5s daemon-side serve). Distinct from
  // messagesLoaded (which flips true IMMEDIATELY on a warm snapshot, so it
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
  permissions: Record<string, Record<string, Permission>>;
  questions: Record<string, Record<string, Question>>;
  // Per-session agent todo list (OpenCode TodoWrite), kept for all sessions so
  // the "Tasks N active · M left" indicator works without opening them.
  todos: Record<string, TodoItem[]>;
  // Root sessions that finished and haven't been acknowledged (server-tracked,
  // cross-device) — drives the "finished/unread" indicator in the tree.
  unread: Record<string, boolean>;
  // Expanded branch IDs (Phase 2+ Gate A — collapsed-frontier projection): the
  // set of collapsed-branch stub IDs the user has manually expanded via lazy-
  // fetch. Tracked SEPARATELY from `sessions` (a stub is NOT a full session
  // object — it carries aggregateState/descendantCount, not model/directory).
  // Preserved across projected snapshots so an expansion survives re-projection;
  // cleared on epoch change (server restart invalidates all stubs) or project
  // switch. Ephemeral — NOT persisted (a reload re-projects from scratch, and a
  // stale expanded-set referencing dead stubs would be misleading). Populated
  // by Phase 4/5 (lazy-expand endpoint + Node branch-awareness); empty in Phase 2.
  expandedBranches: Record<string, boolean>;
  status: ConnStatus;
  cursor: number;
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
  sessions: loadSessions(initialDir),
  messages: {},
  messageWindows: {},
  messagesLoaded: {},
  messagesError: {},
  refreshing: {},
  activity: loadActivity(initialDir),
  lastAgents: loadLastAgents(initialDir),
  currentVerbs: {},
  permissions: {},
  questions: {},
  todos: {},
  unread: {},
  expandedBranches: {},
  status: "connecting",
  cursor: loadCursor(initialDir),
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
    saveVersioned(lsSessions(dir), 1, state.sessions);
    saveVersioned(lsCursor(dir), 1, state.cursor);
    saveVersioned(lsActivity(dir), 1, state.activity);
    saveVersioned(lsLastAgents(dir), 1, state.lastAgents);
  }, 250);
}
