// Orphaned sessions: subsessions whose parent isn't in the live tree (its root
// was archived but the subsession itself wasn't — OpenCode's cascade-archive
// doesn't always reach late/active children). They're kept out of the tree so
// they don't flood it, but surfaced via a banner so they can be cleaned up.
import { sessionWorking, state } from "./sync";
import type { Session } from "./types";

// Idle orphans only: a running orphan already surfaces in the tree (and is
// active work you wouldn't bulk-archive), so the banner targets the stale,
// idle leftovers.
export function orphanSessions(): Session[] {
  return Object.values(state.sessions).filter(
    (s) => s.parentID && !state.sessions[s.parentID] && !sessionWorking(s.id),
  );
}

export interface RootInfo {
  id: string;
  title: string;
  archived: boolean;
}

// Parents are archived (not in the live store), so resolve them from OpenCode.
// Cached, since many orphans share the same ancestor chain.
const cache = new Map<string, any>();
async function fetchSession(id: string): Promise<any | null> {
  if (cache.has(id)) return cache.get(id);
  let val: any = null;
  try {
    const r = await fetch(`/oc/session/${encodeURIComponent(id)}`);
    if (r.ok) val = await r.json();
  } catch {
    /* leave null */
  }
  cache.set(id, val);
  return val;
}

// Walk parentID up to the root, returning its id/title/archived. Bounded.
export async function rootInfoFor(parentID: string): Promise<RootInfo | null> {
  let cur: string | undefined = parentID;
  let last: any = null;
  for (let guard = 0; cur && guard < 50; guard++) {
    const s = await fetchSession(cur);
    if (!s) break;
    last = s;
    cur = s.parentID || undefined;
  }
  if (!last) return null;
  return { id: last.id, title: last.title || last.id, archived: !!last.time?.archived };
}
