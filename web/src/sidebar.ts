// Sidebar UI state: the session-search query and pinned sessions (kept out of
// the sync store; pins are a local preference, persisted). Pinned ROOT sessions
// are additionally orderable by drag-to-reorder; that order is persisted here
// too, alongside (not instead of) the membership set.
import { createSignal } from "solid-js";
import { loadVersioned, saveVersioned } from "./lib/store";
import { reorderRelative } from "./lib/dragReorder";

const [searchQuery, setSearchQuery] = createSignal("");
export { searchQuery, setSearchQuery };

const LS_PINNED = "vh.pinned.v1";
// Separate key for the pinned display order. Membership (vh.pinned.v1, a Set)
// stays the source of truth; this array only governs the render order within
// the pinned group. Kept as its own key so existing v1 users migrate lazily:
// with no order array present, reconciledPinnedOrder() falls back to the set's
// natural order (unchanged visuals) until the user first reorders.
const LS_ORDER = "vh.pinned-order.v1";

const coerceStringArray = (o: unknown): string[] =>
  Array.isArray(o) ? o.filter((x): x is string => typeof x === "string") : [];

const [pinned, setPinnedSig] = createSignal<Set<string>>(
  new Set(loadVersioned<string[]>(LS_PINNED, 1, [], coerceStringArray)),
);
const [pinnedOrder, setPinnedOrderSig] = createSignal<string[]>(
  loadVersioned<string[]>(LS_ORDER, 1, [], coerceStringArray),
);

export { pinned };
export const isPinned = (id: string) => pinned().has(id);

function persistPinned(next: Set<string>) {
  setPinnedSig(next);
  saveVersioned(LS_PINNED, 1, [...next]);
}
function persistOrder(next: string[]) {
  setPinnedOrderSig(next);
  saveVersioned(LS_ORDER, 1, next);
}

export function togglePin(id: string) {
  const cur = pinned();
  if (cur.has(id)) {
    // Unpin: drop from BOTH membership and order so a later re-pin appends fresh
    // (newly pinned → end) rather than reviving a stale position.
    const nextSet = new Set(cur);
    nextSet.delete(id);
    persistPinned(nextSet);
    persistOrder(pinnedOrder().filter((x) => x !== id));
  } else {
    // Pin: append to the end of the order (the pinned-group convention).
    const nextSet = new Set(cur);
    nextSet.add(id);
    persistPinned(nextSet);
    if (!pinnedOrder().includes(id)) persistOrder([...pinnedOrder(), id]);
  }
}

// The persisted order array reconciled against the CURRENT pinned membership:
// drops ids that are no longer pinned (stale) and appends any pinned members
// not yet tracked (newly pinned, or a legacy v1-only user with no order array)
// at the end, preserving their relative order. Pure derivation; does NOT
// persist — togglePin/movePinnedTo own writes, this is the read-side safety net
// that makes unpin/re-pin corruption-proof.
export function reconciledPinnedOrder(): string[] {
  const set = pinned();
  const order = pinnedOrder();
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    if (set.has(id) && !seen.has(id)) {
      kept.push(id);
      seen.add(id);
    }
  }
  for (const id of set) {
    if (!seen.has(id)) {
      kept.push(id);
      seen.add(id);
    }
  }
  return kept;
}

// Apply a drag-reorder: drop `draggedId` before/after `targetId` within the
// reconciled order and persist the result. No-op-equivalent writes are skipped
// (same content) to avoid a pointless localStorage round-trip.
export function movePinnedTo(draggedId: string, targetId: string, pos: "before" | "after") {
  const order = reconciledPinnedOrder();
  const next = reorderRelative(order, draggedId, targetId, pos);
  const changed = next.length !== order.length || next.some((id, i) => id !== order[i]);
  if (changed) persistOrder(next);
}

// Test-only: reset the module-level signals from localStorage so cases don't
// leak pinned/order state across each other (mirrors __resetTreeForTest).
export function __resetPinnedForTest() {
  setPinnedSig(new Set(loadVersioned<string[]>(LS_PINNED, 1, [], coerceStringArray)));
  setPinnedOrderSig(loadVersioned<string[]>(LS_ORDER, 1, [], coerceStringArray));
}
