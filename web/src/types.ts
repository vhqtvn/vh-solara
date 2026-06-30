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
  activity?: string;
  [k: string]: unknown;
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

