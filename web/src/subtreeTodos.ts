// Client for GET /vh/session/:id/subtree-todos — the server-authoritative
// subtree todo rollup (P5). Replaces the FE resident-map walk
// (selectors.sessionTodos / sessionTodoCounts), which walked the resident tree
// map + childrenIndex and omitted unloaded descendants of collapsed frontier
// nodes. The server walks the authoritative topology (Store.sessions) and rolls
// up the per-session todos in subtree order.
import type { TodoItem } from "./types";
import { projectDir } from "./sync";

export interface SubtreeTodoTotals {
  active: number;
  left: number;
  total: number;
}

export interface SubtreeTodosResp {
  epoch: string;
  revision: number;
  data: {
    sessionId: string;
    items: TodoItem[];
    totals: SubtreeTodoTotals;
  };
}

// fetchSubtreeTodos reads the server-authoritative todo rollup for a session's
// subtree. revision is advisory (for stale-response suppression / cache
// validation); it is NOT required to equal the latest live tree revision.
// Passes ?dir= mirroring fetchMessagePage (stream.ts) / fetchDescendants
// (archive.ts) so a multi-project deployment resolves the correct aggregator.
// Throws on non-2xx so the caller can fall back to an empty list.
export async function fetchSubtreeTodos(id: string): Promise<SubtreeTodosResp> {
  const u =
    `/vh/session/${encodeURIComponent(id)}/subtree-todos?dir=` +
    encodeURIComponent(projectDir());
  const res = await fetch(u);
  if (!res.ok) {
    throw new Error(`subtree-todos fetch failed (${res.status})`);
  }
  return res.json();
}
