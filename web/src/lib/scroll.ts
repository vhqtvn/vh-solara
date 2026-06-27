import { loadVersioned, saveVersioned } from "./store";

// Per-session read-position anchor: the messageID this session is "read through"
// (a monotonic read-up-to cursor). Reopening a session returns to that anchor —
// or the bottom if none is stored (the common caught-up case needs no entry).
// Entries are pruned when a session is archived. Sparse by design: a session
// caught up to its last message stores NO entry (cursor == lastMessageID is
// implicit). Draft sessions never persist.
//
// This is the LOCAL store only (S1+S2 of the O3 design). The server-sync half
// (S3) is deferred; the shape is sync-ready — a flat Record<sessionID, messageID>
// is exactly what a cross-device merge would exchange. `following` is deliberately
// NOT folded in (it stays per-device): this cursor is pure content progress.
//
// Replaces the legacy px-offset store (vh.scroll.v1). A px offset is meaningless
// as a message anchor, so the old key is ignored and cleaned up on load — legacy
// sessions restore to the bottom, which is the safe default.
const KEY = "vh.scroll.v2";
const LEGACY_KEY = "vh.scroll.v1";
type Anchors = Record<string, string>;

let cache: Anchors = loadVersioned<Anchors>(KEY, 1, {}, (o) =>
  o && typeof o === "object" ? (o as Anchors) : {},
);
// One-time cleanup of the legacy px-offset store. loadVersioned already ignores
// it (we read a different key); this just frees the stale bytes.
try {
  if (localStorage.getItem(LEGACY_KEY) != null) localStorage.removeItem(LEGACY_KEY);
} catch {
  /* private mode / unavailable — ignore */
}

// The stored read-up-to messageID for a session, or undefined when the session
// is caught up / new (no anchor → bottom default).
export function getReadAnchor(id: string): string | undefined {
  return cache[id];
}

// Record that a session is read through `messageId`. The caller is responsible
// for monotonicity (only advance forward); the store just persists what it's
// told. A falsy id is a no-op.
export function setReadAnchor(id: string, messageId: string) {
  if (!messageId) return;
  if (cache[id] === messageId) return;
  cache[id] = messageId;
  saveVersioned(KEY, 1, cache);
}

// Drop a single session's anchor (used when the user reaches the bottom — caught
// up — restoring the sparse "no entry" default).
export function clearReadAnchor(id: string) {
  if (cache[id] === undefined) return;
  delete cache[id];
  saveVersioned(KEY, 1, cache);
}

// Drop many at once (used when sessions are archived: they leave the live tree
// for good, so their read cursors should not linger).
export function clearReadAnchors(ids: string[]) {
  let changed = false;
  for (const id of ids) {
    if (cache[id] !== undefined) {
      delete cache[id];
      changed = true;
    }
  }
  if (changed) saveVersioned(KEY, 1, cache);
}

// Pure geometry helper: given message rows in document order with their TOP edge
// relative to the scroll container's top (<=0 means the top has scrolled to/past
// the container top, i.e. the row has been read past), returns the id of the
// bottommost read-through message — the last row whose top is at/above the top.
// Undefined when no row has scrolled past the very top (everything still in view
// below it). This is a READ-THROUGH cursor (not topmost-visible): the row pinned
// at the viewport top counts as read, so restoring to it re-lands exactly where
// the user was. The caller enforces monotonic advance against the stored cursor.
export function bottommostRead(rows: { id: string; top: number }[]): string | undefined {
  let found: string | undefined;
  for (const r of rows) {
    if (r.top <= 0) found = r.id;
    else break; // rows are in order; first one below the top ends the scan
  }
  return found;
}
