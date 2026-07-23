// Mirrors the subset of OpenCode's Session we need for the tree. Payloads are
// passed through by the daemon untouched, so extra fields are present but
// ignored here.
export interface Session {
  id: string;
  parentID?: string;
  projectID?: string;
  title?: string;
  directory?: string;
  // OpenCode persists the session's current model server-side; we read it
  // instead of keeping a client-side per-session model map. NOTE: session.model
  // names the model `id` (not `modelID`, which is what message.model uses).
  model?: { providerID: string; id?: string; modelID?: string; variant?: string };
  time?: { created?: number; updated?: number };
}

// Per-session gate facts the daemon stamps into the snapshot so the client can
// tell "this session's data is fully aggregated" from "still loading after a
// restart" WITHOUT opening it. `hydrated` mirrors Go's GateFacts.Hydrated
// (pkg/state/store.go): true once the session's messages are loaded. The daemon
// serves HTTP while still aggregating after a restart, so early snapshots have
// hydrated=false for sessions whose tail hasn't been pulled yet — the client
// uses that to show a loading hint instead of looking stale/empty.
export interface GateFacts {
  hydrated?: boolean;
  // messagesLoaded mirrors Go's GateFacts.MessagesLoaded (pkg/state/store.go):
  // the STRICT "daemon has fetched this session's FULL message history" memo,
  // distinct from `hydrated` (which is true once ANY message state exists —
  // including a partial live-event-only entry). On the async-hydration path the
  // Stream-2 first-open snapshot sends immediately WITHOUT waiting for the
  // upstream fetch, so the snapshot's gate carries messagesLoaded=false until
  // the background load completes; the client keeps its loading UI up until the
  // messages.loaded event (or a gate with messagesLoaded=true) lands.
  // NAMING NOTE: this server GateFacts field shares its JSON spelling with the
  // FE SyncState.messagesLoaded map (web/src/sync/store.ts) BY DESIGN — both
  // answer "is this session's message data complete" — but they are NOT the
  // same value: the gate field is the daemon-side fetch memo, the SyncState map
  // is the per-client "Stream 2 has delivered it to me" flag.
  messagesLoaded?: boolean;
  activity?: string;
  [k: string]: unknown;
}

// ProjectConstants (Phase 3 snapshot trim): when the client opts in via
// `?hoist=1`, the server strips the per-session model/projectID/directory
// fields (which are constant across all sessions in one project) and hoists
// them into this snapshot-level map. The client resolves a session's model
// via selectors.sessionModel, which falls back to projectConstants.model when
// the per-session field is absent. ADDITIVE/back-compat: old clients never
// send hoist=1, so they always get the per-session fields and never see this
// map; new clients send hoist=1 and read the map. All fields optional because
// the server only populates what it could hoist (and older daemons omit the
// map entirely). `model` mirrors Session.model's shape (a JSON object).
export interface ProjectConstants {
  model?: { providerID: string; id?: string; modelID?: string; variant?: string };
  projectID?: string;
  directory?: string;
}

export interface Snapshot {
  seq: number;
  // Daemon generation (pkg/state/store.go Snapshot.Epoch). Stable for the life
  // of a process; CHANGES across a restart. The client reads it (and/or the
  // X-VH-Epoch response header) to detect a server restart mid-connection and
  // merge-protect its caches against mid-aggregation snapshots. Optional for
  // back-compat with older daemons that didn't emit it.
  epoch?: string;
  // Per-session gate facts (hydrated state). Optional; older daemons omit it.
  gate?: Record<string, GateFacts>;
  sessions: Session[];
  messages?: Record<string, unknown[]>;
  // Per-session bounded-window metadata (Phase 1 server-side projection). When
  // present, each entry describes the tail that was shipped in `messages[id]`:
  // whether older messages exist beyond the window (`has_older`), the oldest
  // resident id (`oldest_loaded_id`), and the dual-bound that stopped the
  // projection (`count_limited`/`bytes_limited`). Older servers (pre-Phase-1)
  // omit this map AND ship the whole transcript, so absence is treated as
  // has_older=false (nothing to fetch). See MessageWindowMeta.
  messageWindows?: Record<string, MessageWindowMeta>;
  statuses?: Record<string, unknown>;
  activity?: Record<string, string>;
  permissions?: Record<string, Permission[]>;
  questions?: Record<string, Question[]>;
  unread?: string[];
  // Per-session todos. The daemon stores the raw `todo.updated` properties, so
  // each value is the ENVELOPE `{ sessionID, todos: [...] }`, not the bare array
  // (normalized on the client — see normalizeTodos in sync.ts).
  todos?: Record<string, unknown>;
  // Per-session agent name (of the most recent assistant turn), seeded by the
  // daemon from a lightweight message tail so the tree can render per-agent
  // chips on a COLD snapshot before any session is opened (the tree snapshot
  // carries no messages). A snapshot-only facet — NOT on the Session payload —
  // so it survives per-session upsert events. See sessionLastAgent.
  lastAgents?: Record<string, string>;
  // Per-session current-verb facet (raw tool primitive) so an UNOPENED
  // task-tool subagent's chat row can show rich activity ("Reading parser.go")
  // WITHOUT loading Tier-B (message) data. The daemon seeds this in the tree
  // snapshot (alongside lastAgents) and pushes live on tool transitions via the
  // activity.verb event; the client formats it through the EXISTING
  // toolVerb/toolSubject (Path B2 — Go does not replicate the per-tool target
  // picker). Empty tool = no active facet for that session.
  currentVerbs?: Record<string, VerbFacet>;
  // ProjectConstants (Phase 3 snapshot trim): present when the client opts
  // into `?hoist=1`. The server hoists the per-session model/projectID/
  // directory (constant across all sessions in a project) into this map and
  // strips them from each session's info. The client resolves via
  // selectors.sessionModel (fallback to projectConstants.model). Absent on
  // non-hoisted snapshots (old clients, legacy Snapshot path). See
  // ProjectConstants.
  projectConstants?: ProjectConstants;
}

// Tier-A "current verb" facet: the RAW tool part primitive the daemon emits so
// the client can render rich activity for an UNOPENED subagent. `state` carries
// only the salient fields (status/input/time.start) — Go trims output/error/
// metadata so the byte payload is stable across running-tool output growth
// (idempotent emission, no churn). The client never interprets this struct in
// Go; it feeds {tool, state} back into toolVerb/toolSubject verbatim.
export interface VerbFacet {
  tool: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    time?: { start?: number };
  };
}

// One agent todo (OpenCode's TodoWrite). The daemon passes the payload through
// untouched; we only read content/status. status is OpenCode's set:
// pending | in_progress | completed (| cancelled).
export interface TodoItem {
  id?: string;
  content?: string;
  status?: string;
  priority?: string;
  [k: string]: unknown;
}

// A pending question (OpenCode's interactive "ask the user" request). One
// request can carry several questions, each with selectable options and an
// optional free-text custom answer.
export interface QuestionOption {
  label: string;
  description?: string;
}
export interface QuestionItem {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}
export interface Question {
  id: string;
  sessionID: string;
  questions: QuestionItem[];
  tool?: string;
  [k: string]: unknown;
}

export type Activity = "idle" | "busy" | "retry" | "error";

export interface Permission {
  id: string;
  sessionID: string;
  type?: string;
  title?: string;
  // OpenCode's permission Request: the category (e.g. "bash"/"edit"), the
  // command/path patterns it covers, and tool metadata (often {command,...}).
  permission?: string;
  patterns?: string[];
  // The arity-prefix wildcard patterns OpenCode grants server-side when the
  // operator replies "always" (e.g. ["git diff *", "npm run build *"]). The
  // daemon relays the permission payload untouched (pkg/state/store.go), so
  // this field is already present at runtime — declaring it here lets
  // PermissionCard surface the "Always" grant set instead of approving it
  // blind. ["*"] is the single-catch-all special case.
  always?: string[];
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

export type ConnStatus = "connecting" | "live" | "reconnecting";

// Messages/parts are passed through raw; we only rely on a few envelope fields.
export interface MessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time?: { created?: number; completed?: number };
  [k: string]: unknown;
}

export interface Part {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  time?: { start?: number; end?: number };
  [k: string]: unknown;
}

export interface MessageView {
  id: string;
  info: MessageInfo;
  partOrder: string[];
  parts: Record<string, Part>;
}

export interface SessionMessages {
  order: string[];
  byId: Record<string, MessageView>;
}

// Server-side bounded-window metadata — mirrors Go's `state.WindowMeta` wire
// shape (pkg/state/store.go Phase 1). Carried alongside the bounded message
// tail in two places: (1) `Snapshot.messageWindows[id]` for the cold-load
// wholesale-replace path, and (2) the outer `messages.batch` payload's `window`
// field for the SSE cold-batch path. Every field is optional because older
// servers (pre-Phase-1) emit neither the map nor the field — the client treats
// absence as "unbounded server, nothing older to fetch" (has_older=false).
export interface MessageWindowMeta {
  // Oldest message id resident in the shipped window (top of the tail). Empty
  // when no messages shipped.
  oldest_loaded_id?: string;
  // Server reports there are STRICTLY OLDER messages beyond the window. Drives
  // the client's "Load older" affordance. False for an unbounded server.
  has_older?: boolean;
  // Diagnostic counts — present when a bound was hit, useful for telemetry /
  // operator-facing diagnostics.
  message_count?: number;
  serialized_bytes?: number;
  count_limited?: boolean;
  bytes_limited?: boolean;
  // Oversized-anchor diagnostics — set ONLY when a single message exceeded the
  // byte budget and was returned alone (the atomic-message guarantee).
  oversized_item?: boolean;
  actual_bytes?: number;
  budget_bytes?: number;
}

