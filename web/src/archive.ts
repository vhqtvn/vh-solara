// Archive overlay client. Archived sessions are excluded from the live tree;
// they're browsed on demand (paginated + lazy by subtree) so a project with
// thousands of archived sessions never overloads the browser.
import type { Session } from "./types";
import { openSession, selectedId, setSelectedId, pruneSessionDeleted, projectDir } from "./sync";
import { clearReadAnchors } from "./lib/scroll";
import { clearQueueCache } from "./queue";
import { markRead } from "./notify";

export interface ArchivedLevel {
  sessions: Session[];
  childCounts: Record<string, number>;
  total: number;
  offset: number;
  limit: number;
}

// ArchiveDriftError is thrown by archiveSession on a 409 (descendants_changed):
// the affected session set's MEMBERSHIP changed between preview and commit (a
// spawn, delete, or reparent in/out of the subtree). Carries the server's
// current affected set + fingerprint. The caller (SessionContextMenu.doArchive)
// re-fetches descendants and re-shows the confirmation dialog against the
// current set — it does NOT auto-retry (the operator must re-consent).
export class ArchiveDriftError extends Error {
  readonly currentAffected: string[];
  readonly currentFingerprint: string;
  constructor(currentAffected: string[], currentFingerprint: string) {
    super(
      "archive drifted: the affected session set changed between preview and commit",
    );
    this.name = "ArchiveDriftError";
    this.currentAffected = currentAffected;
    this.currentFingerprint = currentFingerprint;
  }
}

// Archive a session and all its subsessions. Returns the affected ids. If the
// currently-selected session was archived, the selection is cleared.
//
// C5 drift fence: expectedFingerprint is the subtree-id-set fingerprint the
// preview (GET /vh/session/:id/descendants) returned. When present, the server
// recomputes it from the live affected set at commit and rejects with 409
// (descendants_changed) if the set's membership changed between preview and
// commit — a spawn, delete, or reparent in/out of the subtree. On 409 this
// throws ArchiveDriftError so the caller can re-fetch + re-show the
// confirmation dialog WITHOUT auto-retrying (the operator must re-consent to
// the new set). Absent expectedFingerprint → no fence (backward-compat for
// programmatic / legacy callers).
export async function archiveSession(
  id: string,
  expectedFingerprint?: string,
): Promise<string[]> {
  const res = await fetch("/vh/archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionID: id, expectedFingerprint }),
  });
  // C5: 409 is the drift signal — throw a typed error so the caller can
  // distinguish "the set changed, re-preview" from a transport/server failure.
  if (res.status === 409) {
    const j = await res.json().catch(() => ({}));
    const cur = ((j && j.current) || {}) as {
      fingerprint?: string;
      affected?: string[];
    };
    throw new ArchiveDriftError(cur.affected ?? [], cur.fingerprint ?? "");
  }
  // Surface failures instead of mapping any error to `affected: []`, which
  // would make a broken archive look like an empty success to callers. The
  // archive HTTP path itself works (a finite timestamp is accepted), so this
  // only surfaces transport/server errors. Mirrors unarchiveSession below.
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `archive failed (${res.status}): ${body || res.statusText}`,
    );
  }
  const j = await res.json().catch(() => ({}));
  const affected: string[] = j.affected || [];
  // Archived sessions leave the live tree for good — the backend deletes their
  // queue state server-side (handleArchive clears .vh-solara/sessions/<id>/queue.json
  // for each affected session). Here we just prune the local cache so the UI
  // drops them immediately; this is NOT a write to queue authority.
  if (affected.length) {
    clearReadAnchors(affected);
    clearQueueCache(affected);
    // Archived sessions are gone from the live tree — ack any notifications for
    // them (finished, waiting, etc.) so they don't linger as unread.
    markRead((n) => affected.includes(n.sessionID || ""));
    // Eagerly prune the affected sessions from the client tree. The server's
    // RemoveSessions emits session.delete events that drive this normally, but
    // a session that isn't in the server's live store (e.g. an orphan pruned
    // server-side by a prior cascade or demotion) generates no delete event —
    // so the client must prune it here based on the authoritative archive
    // response. Idempotent: a later session.delete for the same id is a no-op.
    for (const id of affected) pruneSessionDeleted(id);
  }
  if (selectedId() && affected.includes(selectedId()!)) setSelectedId(null);
  return affected;
}

// DeleteDriftError is thrown by deleteSession on a 409 (descendants_changed):
// the affected session set's MEMBERSHIP changed between preview and commit. Same
// shape + contract as ArchiveDriftError (the caller re-fetches descendants and
// re-shows the confirmation dialog WITHOUT auto-retrying — the operator must
// re-consent, which is doubly important for a destructive, irreversible op).
// Kept as a distinct type so a dialog can branch on delete-vs-archive semantics.
export class DeleteDriftError extends Error {
  readonly currentAffected: string[];
  readonly currentFingerprint: string;
  constructor(currentAffected: string[], currentFingerprint: string) {
    super("delete drifted: the affected session set changed between preview and commit");
    this.name = "DeleteDriftError";
    this.currentAffected = currentAffected;
    this.currentFingerprint = currentFingerprint;
  }
}

// Delete a session and all its subsessions. DESTRUCTIVE and IRREVERSIBLE — there
// is no undelete. Returns the affected ids. Mirrors archiveSession (same C5
// drift fence via expectedFingerprint, same prune tail). If the currently-
// selected session was deleted, the selection is cleared.
export async function deleteSession(
  id: string,
  expectedFingerprint?: string,
): Promise<string[]> {
  const res = await fetch("/vh/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionID: id, expectedFingerprint }),
  });
  // C5: 409 is the drift signal — throw a typed error so the caller can
  // distinguish "the set changed, re-preview" from a transport/server failure.
  if (res.status === 409) {
    const j = await res.json().catch(() => ({}));
    const cur = ((j && j.current) || {}) as {
      fingerprint?: string;
      affected?: string[];
    };
    throw new DeleteDriftError(cur.affected ?? [], cur.fingerprint ?? "");
  }
  // Surface failures instead of mapping any error to `affected: []`.
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`delete failed (${res.status}): ${body || res.statusText}`);
  }
  const j = await res.json().catch(() => ({}));
  const affected: string[] = j.affected || [];
  // Deleted sessions are permanently gone — the backend deletes their queue
  // state server-side (handleDelete clears .vh-solara/sessions/<id>/queue.json
  // for each affected session). Prune the local cache so the UI drops them
  // immediately (same tail as archiveSession).
  if (affected.length) {
    clearReadAnchors(affected);
    clearQueueCache(affected);
    markRead((n) => affected.includes(n.sessionID || ""));
    for (const id of affected) pruneSessionDeleted(id);
  }
  if (selectedId() && affected.includes(selectedId()!)) setSelectedId(null);
  return affected;
}

export async function unarchiveSession(id: string): Promise<string[]> {
  const res = await fetch("/vh/unarchive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionID: id }),
  });
  // Surface failures instead of mapping any error to `affected: []`, which
  // previously made a broken unarchive look like an empty success to callers
  // (and hid the underlying PATCH-400 bug for months). The server returns the
  // backend's error text on failure (e.g. the schema-drift refusal from the
  // direct-DB writer), so throw it for the UI to present.
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `unarchive failed (${res.status}): ${body || res.statusText}`,
    );
  }
  const j = await res.json().catch(() => ({}));
  return j.affected || [];
}

export async function fetchArchived(parent = "", offset = 0, limit = 50): Promise<ArchivedLevel> {
  const u = `/vh/archived?parent=${encodeURIComponent(parent)}&offset=${offset}&limit=${limit}`;
  const res = await fetch(u);
  return res.json();
}

// SessionSummary is the FE projection of the server's
// pkg/state.SessionSummary (id + title + parentID) for the archive-impact
// descendant list. Mirrors the P4 endpoint's data.descendants[] element shape.
export interface SessionSummary {
  id: string;
  title?: string;
  parentID?: string;
}

// DescendantsResp is the Q3 revisioned envelope returned by
// GET /vh/session/:id/descendants. revision is advisory (for stale-response
// suppression / cache validation); it is NOT required to equal the latest live
// tree revision. The first element of data.descendants (if any) is always the
// requested id itself (the affected root). data.fingerprint (C5) is the
// stateless subtree-id-set fingerprint the FE echoes back as
// expectedFingerprint on POST /vh/archive; the server 409-rejects on mismatch.
export interface DescendantsResp {
  epoch: string;
  revision: number;
  data: {
    sessionId: string;
    descendants: SessionSummary[];
    fingerprint: string;
  };
}

// fetchDescendants reads the server-authoritative descendant list for the
// archive-impact preview (P4). Replaces the FE resident-map walk
// (SessionContextMenu.relatedSessions), which omitted unloaded descendants of
// collapsed frontier nodes. The server walks the authoritative topology.
// Passes ?dir= mirroring fetchMessagePage (stream.ts) so a multi-project
// deployment resolves the correct aggregator. Throws on non-2xx so the caller
// can fall back to an optimistic single-item list (the target itself is always
// in the affected set).
export async function fetchDescendants(id: string): Promise<DescendantsResp> {
  const u =
    `/vh/session/${encodeURIComponent(id)}/descendants?dir=` +
    encodeURIComponent(projectDir());
  const res = await fetch(u);
  if (!res.ok) {
    throw new Error(`descendants fetch failed (${res.status})`);
  }
  return res.json();
}

// Restore a session to the live tree and open it.
export async function restoreAndOpen(id: string) {
  await unarchiveSession(id);
  setSelectedId(id);
  void openSession(id);
}
