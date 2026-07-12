// Archive overlay client. Archived sessions are excluded from the live tree;
// they're browsed on demand (paginated + lazy by subtree) so a project with
// thousands of archived sessions never overloads the browser.
import type { Session } from "./types";
import { openSession, selectedId, setSelectedId } from "./sync";
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

// Archive a session and all its subsessions. Returns the affected ids. If the
// currently-selected session was archived, the selection is cleared.
export async function archiveSession(id: string): Promise<string[]> {
  const res = await fetch("/vh/archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionID: id }),
  });
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

// Restore a session to the live tree and open it.
export async function restoreAndOpen(id: string) {
  await unarchiveSession(id);
  setSelectedId(id);
  void openSession(id);
}
