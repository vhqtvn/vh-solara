// Archive overlay client. Archived sessions are excluded from the live tree;
// they're browsed on demand (paginated + lazy by subtree) so a project with
// thousands of archived sessions never overloads the browser.
import type { Session } from "./types";
import { openSession, selectedId, setSelectedId } from "./sync";
import { clearScroll } from "./lib/scroll";
import { clearQueue } from "./queue";

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
  const j = await res.json().catch(() => ({}));
  const affected: string[] = j.affected || [];
  // Archived sessions leave the live tree for good — drop their saved scroll
  // offsets and any queued messages so the persistent stores stay minimal.
  if (affected.length) {
    clearScroll(affected);
    clearQueue(affected);
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
