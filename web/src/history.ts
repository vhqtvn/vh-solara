// Sent-prompt history for up/down recall in the composer (shell-style). Two
// scopes, both persisted client-side via lib/store versioned-localStorage:
//   - GLOBAL (key vh.prompt.history.v1): recall with Ctrl/Cmd+Up. This is the
//     legacy store — prompts written before the per-session split remain
//     Ctrl+Up-recallable with NO migration. Most-recent first, de-duplicated,
//     capped at MAX.
//   - PER-SESSION (key vh.prompt.history.session.<sessionId>.v1): recall with
//     plain Up. Isolated per session. A DRAFT session (no server id yet) uses
//     the "__new__" pseudo-key, matching the draft-key convention in ChatView —
//     callers normalize an empty sessionId to "__new__" before calling.
// pushHistory(text, sid?) writes to BOTH stores when sid is given, so a prompt
// is recallable via both plain Up (per-session) and Ctrl+Up (global); the
// per-session store is always a subset of global. Without sid, only global is
// written (kept for direct/legacy callers).
import { loadVersioned, saveVersioned } from "./lib/store";

const KEY = "vh.prompt.history.v1";
const sessionKey = (sid: string) => `vh.prompt.history.session.${sid}.v1`;
const MAX = 100;

const arrCoerce = (o: unknown) => (Array.isArray(o) ? (o as string[]) : []);

let hist: string[] = loadVersioned<string[]>(KEY, 1, [], arrCoerce);

// Per-session caches, lazily loaded on first read/write. Keyed by the sessionId
// the caller passes in (ChatView passes props.sessionId || "__new__"). Kept in
// memory so repeated Up/Down walks don't re-parse localStorage each step.
const sessionHist = new Map<string, string[]>();
function sessionStore(sid: string): string[] {
  let s = sessionHist.get(sid);
  if (!s) {
    s = loadVersioned<string[]>(sessionKey(sid), 1, [], arrCoerce);
    sessionHist.set(sid, s);
  }
  return s;
}

// Most-recent first, de-duplicated, capped. Returns a fresh array.
function dedup(text: string, arr: string[]): string[] {
  return [text, ...arr.filter((x) => x !== text)].slice(0, MAX);
}

// Push to GLOBAL always; also push to the per-session store `sessionId`
// identifies when given (so the prompt is Up-recallable in this session AND
// Ctrl+Up-recallable globally). Draft sessions pass "__new__" as sessionId
// (normalized at the callsite).
export function pushHistory(text: string, sessionId?: string) {
  const t = text.trim();
  if (!t) return;
  hist = dedup(t, hist);
  saveVersioned(KEY, 1, hist);
  if (sessionId) {
    const next = dedup(t, sessionStore(sessionId));
    sessionHist.set(sessionId, next);
    saveVersioned(sessionKey(sessionId), 1, next);
  }
}

// 0 = most recent. Returns undefined past the ends. With `sessionId`, reads the
// PER-SESSION store (plain Up); without it, reads GLOBAL (Ctrl+Up).
export function historyAt(index: number, sessionId?: string): string | undefined {
  const arr = sessionId ? sessionStore(sessionId) : hist;
  return index >= 0 && index < arr.length ? arr[index] : undefined;
}

export function historyLen(sessionId?: string): number {
  const arr = sessionId ? sessionStore(sessionId) : hist;
  return arr.length;
}
