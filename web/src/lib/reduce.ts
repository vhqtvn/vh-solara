// Pure, browser-free reducers for the session tree and per-session message
// state. Kept separate from sync.ts (which owns the store, SSE, and storage) so
// the core logic is unit-testable. These functions mutate the plain objects
// passed in — sync.ts calls them inside Solid produce() drafts.
import type { MessageInfo, Part, Session, SessionMessages } from "../types";

// Group sessions by parentID ("" = roots), each list sorted newest-updated
// first. The subsession tree derives entirely from Session.parentID.
// `surfaceOrphan` decides whether a subsession whose parent is absent from the
// set (e.g. the parent root is archived but the child isn't) should be promoted
// to a root so it stays visible. Default: keep it hidden — promoting ALL such
// orphans floods the tree with stale leftovers. Callers pass a predicate (e.g.
// "is it running") to surface only the ones that matter.
export function buildChildrenIndex(
  sessions: Record<string, Session>,
  surfaceOrphan?: (s: Session) => boolean,
): Record<string, Session[]> {
  const byParent: Record<string, Session[]> = {};
  for (const s of Object.values(sessions)) {
    let key = s.parentID || "";
    if (s.parentID && !sessions[s.parentID]) {
      // Orphan (parent not in the tree). Surface as a root only if asked;
      // otherwise leave it grouped under the missing parent, where it won't
      // render (no node for that parent).
      key = surfaceOrphan && surfaceOrphan(s) ? "" : s.parentID;
    }
    (byParent[key] ||= []).push(s);
  }
  for (const key in byParent) {
    byParent[key].sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));
  }
  return byParent;
}

// True if any descendant (child, grandchild, …) of `sessionID` satisfies
// `isWorking`. Keeps a parent/root node spinning while its subagent (delegate)
// session is still generating — opencode's /session/status marks only the child
// busy, so the parent would otherwise look idle. `seen` guards against cycles.
export function anyDescendantWorking(
  sessions: Record<string, Session>,
  activity: Record<string, string>,
  sessionID: string,
  isWorking: (act?: string) => boolean,
): boolean {
  const stack = [sessionID];
  const seen = new Set<string>([sessionID]);
  const all = Object.values(sessions);
  while (stack.length) {
    const id = stack.pop()!;
    for (const s of all) {
      if (s.parentID === id && !seen.has(s.id)) {
        if (isWorking(activity[s.id])) return true;
        seen.add(s.id);
        stack.push(s.id);
      }
    }
  }
  return false;
}

export function sortMessages(sm: SessionMessages): void {
  sm.order.sort(
    (a, b) => (sm.byId[a].info.time?.created || 0) - (sm.byId[b].info.time?.created || 0),
  );
}

export function upsertMessage(sm: SessionMessages, info: MessageInfo): void {
  const existing = sm.byId[info.id];
  if (existing) {
    existing.info = info;
  } else {
    sm.byId[info.id] = { id: info.id, info, partOrder: [], parts: {} };
    sm.order.push(info.id);
    sortMessages(sm);
  }
}

export function deleteMessage(sm: SessionMessages, messageID: string): void {
  if (!sm.byId[messageID]) return;
  delete sm.byId[messageID];
  sm.order = sm.order.filter((id) => id !== messageID);
}

export function upsertPart(sm: SessionMessages, part: Part): void {
  let msg = sm.byId[part.messageID];
  if (!msg) {
    // A part can arrive before its message.updated; create a placeholder.
    msg = {
      id: part.messageID,
      info: { id: part.messageID, sessionID: part.sessionID, role: "assistant" },
      partOrder: [],
      parts: {},
    };
    sm.byId[part.messageID] = msg;
    sm.order.push(part.messageID);
  }
  if (!msg.parts[part.id]) {
    msg.partOrder.push(part.id);
    msg.parts[part.id] = part;
  } else {
    // Merge in place so the stored part KEEPS ITS REFERENCE. The chat groups
    // parts into row components keyed by identity; replacing the object each
    // streaming token would recreate the row (the Thinking block flashing empty
    // and losing scroll). Mutating fields updates them reactively instead.
    Object.assign(msg.parts[part.id], part);
  }
}

export function deletePart(sm: SessionMessages, messageID: string, partID: string): void {
  const msg = sm.byId[messageID];
  if (!msg || !msg.parts[partID]) return;
  delete msg.parts[partID];
  msg.partOrder = msg.partOrder.filter((id) => id !== partID);
}

// Build a SessionMessages from OpenCode's GET /session/:id/message item shape
// ([{ info, parts }]).
export function buildMessages(items: any[]): SessionMessages {
  const sm: SessionMessages = { order: [], byId: {} };
  for (const it of items) {
    const info = it.info as MessageInfo;
    const parts: Record<string, Part> = {};
    const partOrder: string[] = [];
    for (const p of it.parts || []) {
      parts[p.id] = p;
      partOrder.push(p.id);
    }
    sm.byId[info.id] = { id: info.id, info, partOrder, parts };
    sm.order.push(info.id);
  }
  sortMessages(sm);
  return sm;
}

// Phase 4 — historical-page merge primitive. Merges a page of older messages
// into a resident SessionMessages by INSERT-IF-NOT-PRESENT only. NEVER touches
// an existing byId entry — live always wins (a page snapshot is a stale
// point-in-time read; a live delta that landed during the page flight must not
// be overwritten by the stale snapshot copy). Returns the count of messages
// actually inserted (callers use this to decide whether to update oldestResident
// and whether to update the hasOlder signal). The final sortMessages handles
// prepend ordering naturally — the new ids slot into their creation-time
// position relative to the existing tail.
export function prependMessagesIfAbsent(sm: SessionMessages, items: any[]): number {
  let added = 0;
  for (const it of items) {
    const info = it.info as MessageInfo;
    if (!info || sm.byId[info.id]) continue; // live always wins — NEVER touch existing
    const parts: Record<string, Part> = {};
    const partOrder: string[] = [];
    for (const p of it.parts || []) {
      parts[p.id] = p;
      partOrder.push(p.id);
    }
    sm.byId[info.id] = { id: info.id, info, partOrder, parts };
    sm.order.push(info.id);
    added++;
  }
  if (added) sortMessages(sm);
  return added;
}

// Phase 4 — resident-cache eviction from the OLDEST end (top of order). Used
// after a page merge to keep resident message count + approximate bytes under
// the operator-tunable cap. Evicting from the oldest end preserves the live
// tail (newest messages, at the bottom of order) which is what an active
// session streams into. Returns the count actually removed. Does NOT touch
// the last `protectTail` messages (default 1) so an in-flight assistant turn
// at the tail is never yanked. Bidirectional eviction (tail-end when reading
// history) is a documented follow-up — this minimal cut covers the OOM risk
// for the common live-session case.
export function deleteMessagesFromTop(sm: SessionMessages, count: number, protectTail = 1): number {
  if (count <= 0) return 0;
  const removable = sm.order.length - protectTail;
  if (removable <= 0) return 0;
  const n = Math.min(count, removable);
  const removed = sm.order.slice(0, n);
  sm.order = sm.order.slice(n);
  for (const id of removed) delete sm.byId[id];
  return n;
}

// Phase 4 — approximate resident serialized bytes. Sums JSON.stringify length
// over each message's info + parts. Approximate (omits wire envelope framing)
// but deterministic and cheap enough to run after each page merge. Used by the
// eviction gate alongside MAX_RESIDENT_MESSAGES. Mirrors the server's
// messageSerializedBytes() rationale (per-part 1 MiB cap is the hard OOM
// guardrail; the aggregate cap is an approximate content budget).
export function approxResidentBytes(sm: SessionMessages): number {
  let total = 0;
  for (const id of sm.order) {
    const msg = sm.byId[id];
    if (!msg) continue;
    total += msg.info ? JSON.stringify(msg.info).length : 0;
    for (const pid of msg.partOrder) {
      const p = msg.parts[pid];
      if (p) total += JSON.stringify(p).length;
    }
  }
  return total;
}
