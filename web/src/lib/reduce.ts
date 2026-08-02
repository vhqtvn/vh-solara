// Pure, browser-free reducers for per-session message state. Kept separate
// from sync.ts (which owns the store, SSE, and storage) so the core logic is
// unit-testable. These functions mutate the plain objects passed in — sync.ts
// calls them inside Solid produce() drafts.
import type { MessageInfo, Part, SessionMessages } from "../types";

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

// Phase 4 — historical-page merge primitive. Merges a page/snapshot/batch of
// messages into a resident SessionMessages by INSERT-IF-NOT-PRESENT, with ONE
// safe upgrade exception for an already-resident id (see below). The default is
// still "never clobber a resident entry — live always wins": a page/reconnect
// snapshot is a stale point-in-time read; a live delta (a mid-stream tail
// message) that landed during the flight must not be overwritten by the stale
// snapshot copy.
//
// UPGRADE-ON-COMPLETED exception: an OpenCode message is TERMINAL and immutable
// once info.time.completed is set — a completed copy is the authoritative final
// form and can never lose a race against live data. So for an id that is ALREADY
// resident, if the INCOMING message is completed we UPGRADE the resident entry:
// replace its info and merge the incoming parts (add missing parts; for parts
// already present, Object.assign IN PLACE so the stored part KEEPS ITS
// REFERENCE — replacing the object recreates the chat row and flashes/loses
// scroll; same rationale as upsertPart). This repairs the "just-finished session
// re-activated shows a STALE PARTIAL message" bug: a warm Stream-2 snapshot (or
// cold batch) inlines the now-completed message, but the old insert-if-absent
// skipped it because its id was already resident (the partial cached while
// streaming), so the stale partial stayed on screen until a full reload. It also
// fills a resident message that the activity-idle path stamped time.completed on
// but that is MISSING parts. A NON-completed incoming copy still takes the
// insert-if-absent path (this is the live-streaming tail the guard protects) —
// so the fix does NOT reopen "a stale snapshot clobbers a live mid-stream
// message."
//
// Returns the count of messages actually INSERTED (an in-place upgrade is NOT
// counted — callers rely on the return meaning "newly inserted older messages"
// for oldestResident/hasOlder bookkeeping in history.ts). The final sortMessages
// handles prepend ordering naturally — new ids slot into their creation-time
// position relative to the existing tail.
export function prependMessagesIfAbsent(sm: SessionMessages, items: any[]): number {
  let added = 0;
  let upgraded = false;
  for (const it of items) {
    const info = it.info as MessageInfo;
    if (!info) continue;
    const resident = sm.byId[info.id];
    if (resident) {
      // Already resident. Upgrade ONLY if the incoming copy is completed
      // (terminal/immutable — safe against live); otherwise live always wins and
      // we NEVER touch the existing entry.
      if (info.time?.completed) {
        resident.info = info;
        for (const p of it.parts || []) {
          if (!resident.parts[p.id]) {
            resident.partOrder.push(p.id);
            resident.parts[p.id] = p;
          } else {
            // Merge in place — keep the part's object reference (chat row
            // identity + scroll), same as upsertPart.
            Object.assign(resident.parts[p.id], p);
          }
        }
        upgraded = true;
      }
      continue;
    }
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
  // Re-sort on an insert (prepend ordering) OR an upgrade (a completed copy may
  // carry a time.created the resident placeholder lacked, changing its slot). A
  // sort that yields the identical order is a no-op for reactivity.
  if (added || upgraded) sortMessages(sm);
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
