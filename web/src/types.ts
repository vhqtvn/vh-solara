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

export interface Snapshot {
  seq: number;
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
  [k: string]: any;
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

