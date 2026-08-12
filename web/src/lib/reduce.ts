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

// === Slice 3: part.append suffix streaming (pure apply) =====================
//
// part.append {sessionID, messageID, partID, field, start, text} is the
// negotiated suffix wire frame (slice 2 server-side — see
// docs/ai/wire-protocols/part-append-streaming.md). `start` is a UTF-8 BYTE
// offset into the resident field's accumulated value (NOT a UTF-16 code-unit
// index, NOT a rune count). The FE MUST validate currentFieldByteLen == start
// before applying; a mismatch means the local field diverged (a lost suffix,
// a snapshot base that differs) and the client must NOT byte-splice — it
// triggers a cursorless re-snapshot (handled by the transport layer).
//
// appendPartSuffix is the PURE projection (no store coupling, no transport):
// it mutates the passed SessionMessages draft in place and returns the outcome.
// The transport layer (session-stream.ts flushAppends) calls this inside a
// single setState(produce(...)) batch for frame-batching.
export interface PartAppendPayload {
  sessionID: string;
  messageID: string;
  partID: string;
  // v1 allowlist (spec §5): "text" or "reasoning" only. The server enforces
  // this; the FE does not re-filter (trusting the contract) but the field is
  // read/written as a flat top-level key on the Part — same shape the legacy
  // full-upsert path (upsertPart Object.assign) writes.
  field: string;
  // UTF-8 byte offset where `text` is to be appended.
  start: number;
  // The appended bytes (a valid suffix of the field; already a correct JS
  // string from JSON parse, so concat is safe).
  text: string;
}

// utf8ByteLength returns the UTF-8 BYTE length of a JS (UTF-16) string. This is
// the critical offset-comparison metric: `start` is bytes, not code units. Uses
// TextEncoder (a WebIDL standard, globally available in Node ≥ 11 and browsers —
// NOT a DOM API, so this stays compatible with the "browser-free" reduce.ts
// contract). Hoisted encoder: TextEncoder is stateless and reusable, and this
// runs on the streaming hot path (once per suffix).
const utf8Encoder = new TextEncoder();
export function utf8ByteLength(s: string): number {
  return utf8Encoder.encode(s).length;
}

// The outcome of a suffix application, consumed by the transport layer to decide
// whether to trigger a cursorless re-snapshot (mismatch) or silently continue
// (applied / skipped).
export type PartAppendResult = "applied" | "mismatch" | "skipped";

// appendPartSuffix — the pure suffix-apply projection. Mutates `sm` in place
// (preserves the resident Part object's identity — reactive consumers keyed on
// the part see no churn, mirroring upsertPart's Object.assign-in-place pattern).
// Returns:
//   - "applied": start matched the resident field's UTF-8 byte length; text was
//     appended (string concat) onto the field.
//   - "mismatch": the resident field's byte length disagrees with start (or the
//     message/part is not resident) — the caller MUST NOT byte-splice and SHOULD
//     trigger a cursorless re-snapshot to realign (defense in depth + the genuine
//     reconnect case; the server-side snapshot-offset coherence makes this rare).
//   - "skipped": the resident message is completed (terminal/immutable —
//     upgrade-on-completed: a completed part wins over a streaming suffix). The
//     suffix is stale; silently dropped (the completed state is authoritative).
//
// SEMANTICS PRESERVED (mirrors part.upsert's apply today):
//   - Object identity: the resident Part object is mutated in place (never
//     replaced), so chat-row components keyed by part identity don't churn.
//   - Merge-if-absent: a suffix EXTENDS a streaming field (never replaces a
//     resident value wholesale); an unset field is seeded from start===0.
//   - Upgrade-on-completed: a suffix for a completed (terminal) message is
//     dropped — the completed snapshot is the authoritative final form.
export function appendPartSuffix(
  sm: SessionMessages,
  payload: PartAppendPayload,
): PartAppendResult {
  const msg = sm.byId[payload.messageID];
  if (!msg) return "mismatch"; // message not resident → can't validate offset
  // Upgrade-on-completed (defense in depth): a completed message is terminal.
  // The server's discardPartDeltaLocked drops buffered deltas on completion, so
  // a suffix arriving after completion is stale; dropping it preserves the
  // authoritative completed field. No re-snapshot (the completed state is correct).
  if (msg.info.time?.completed) return "skipped";
  const part = msg.parts[payload.partID];
  if (!part) return "mismatch"; // part not resident → can't validate offset
  const field = payload.field;
  const current = (part as Record<string, unknown>)[field];
  // CRITICAL: UTF-8 byte length, NOT JS .length (UTF-16 code units). A field
  // containing multi-byte chars (é, 日本語, emoji) has byteLen > .length; using
  // .length would falsely mismatch a correct server-side byte offset.
  const currentByteLen =
    typeof current === "string" ? utf8ByteLength(current) : 0;
  if (payload.start !== currentByteLen) return "mismatch";
  // Append in place — preserve the Part object's identity. String concat is the
  // unavoidable JS string-accumulation cost (same order-per-frame as the legacy
  // full-field assignment: both process O(fieldLen) bytes per frame).
  (part as Record<string, unknown>)[field] =
    (typeof current === "string" ? current : "") + payload.text;
  return "applied";
}

// Phase 4 — approximate resident serialized bytes. Sums JSON.stringify length
// over each message's info + parts. Approximate (omits wire envelope framing)
// but deterministic and cheap enough to run after each page merge. Used by
// the eviction gate alongside MAX_RESIDENT_MESSAGES. Mirrors the server's
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
