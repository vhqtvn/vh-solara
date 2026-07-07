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

// Is `cand` ahead of (newer than) the stored read anchor in message order? Drives
// the monotonic read-cursor guard: the stored anchor only ever advances forward,
// never backward (scrolling up to re-read never lowers it). A missing/stale
// stored anchor is treated as behind, so the first write always lands.
//
// Pure: no signals, no DOM, no closure captures. The message `order` array
// (newest-known message order from the session store) is passed explicitly so
// this is unit-testable in isolation. Extracted verbatim from the former private
// `isCursorAhead` closure in ChatView — same short-circuit order, same return
// values, only the `order` capture became a parameter.
export function orderAhead(
  cand: string,
  stored: string | undefined,
  order: string[],
): boolean {
  if (!stored) return true;
  if (cand === stored) return false;
  return order.indexOf(cand) > order.indexOf(stored);
}

// ---------------------------------------------------------------------------
// Dual-axis scroll geometry reducer (option A_plus).
//
// Root defect being fixed: the chat-scroll sentinel previously recorded only
// `scrollTop` + `scrollHeight` and classified layout mutation with a single
// boolean ("did content shrink?"). Content-resize and viewport-resize
// routinely happen in the SAME frame (typing during a live stream grows the
// composer → viewport shrinks while a block appends → content grows; mobile
// keyboard toggle; hydration + composer grow; paste/recall), so a single-axis
// classifier is structurally inadequate and either deadlocks autoscroll or
// yanks a preserved read position.
//
// The fix decomposes BOTH axes (content delta + viewport delta) and treats
// genuine user scroll-intent as the RESIDUAL after content+viewport movement
// AND the scroll-range clamp are accounted for. A residual within epsilon is
// layout churn (do nothing / re-glue); a residual outside epsilon is real
// user intent (drop following / re-engage / preserve anchor).
//
// Read mode additionally accepts an `anchorDelta` (measured shift of the
// logical `data-mid` anchor) so a grow-ABOVE-viewport or shrink-ABOVE that
// the browser's `overflow-anchor:auto` failed to track can be corrected
// mechanically instead of being mistaken for user intent.
// ---------------------------------------------------------------------------

export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export type ScrollMode = "tail" | "read";

export type ScrollIntent =
  | "none"
  | "user-scroll-up"
  | "user-scroll-down"
  | "reached-bottom";

export interface ScrollDecision {
  // Should the caller apply a programmatic scrollTop write this cycle?
  shouldScroll: boolean;
  // The target scrollTop to write (only meaningful when shouldScroll is true).
  newScrollTop?: number;
  // The scrollTop the browser SHOULD be reporting after content+viewport delta
  // + clamp, assuming NO user intent. residualUserDelta is measured against it.
  expectedScrollTop: number;
  // current.scrollTop - expectedScrollTop. Within ±epsilon == layout churn;
  // outside == real user scroll-intent.
  residualUserDelta: number;
  // current.scrollHeight - previous.scrollHeight (content axis).
  contentDelta: number;
  // current.clientHeight - previous.clientHeight (viewport axis).
  viewportDelta: number;
  // Classified intent derived from the residual (+ tail/reached-bottom logic).
  intent: ScrollIntent;
}

export interface ClassifyScrollDeltaArgs {
  previous: ScrollGeometry;
  current: ScrollGeometry;
  mode: ScrollMode;
  following: boolean;
  // Measured shift of the logical data-mid anchor (read mode only). Positive =
  // content grew above the anchor (anchor pushed down); negative = shrank
  // above. When non-zero in read mode the expected scrollTop tracks the anchor
  // so a browser that did NOT keep the anchor pinned is corrected instead of
  // being read as user intent.
  anchorDelta?: number;
  // Absorb sub-pixel / clamp churn. Default ~1px.
  epsilon?: number;
}

const DEFAULT_EPSILON = 1;

function clampTop(value: number, maxBottom: number): number {
  if (value < 0) return 0;
  if (value > maxBottom) return maxBottom;
  return value;
}

// Classify a scroll-area geometry transition into an intent + programmatic
// scroll decision. Pure: no DOM, no signals, no side effects — fully unit
// testable in isolation.
export function classifyScrollDelta(
  args: ClassifyScrollDeltaArgs,
): ScrollDecision {
  const eps = args.epsilon ?? DEFAULT_EPSILON;
  const anchorDelta = args.anchorDelta ?? 0;
  const prev = args.previous;
  const curr = args.current;

  const contentDelta = curr.scrollHeight - prev.scrollHeight;
  const viewportDelta = curr.clientHeight - prev.clientHeight;
  const maxBottomCurr = Math.max(0, curr.scrollHeight - curr.clientHeight);

  // Expected scrollTop model: the browser keeps the scrollTop numeric value
  // fixed through content/viewport mutation, then clamps it to the new scroll
  // range. In read mode, when the logical anchor shifted, the expected value
  // tracks the anchor so an unfrozen viewport is corrected mechanically.
  const expectedScrollTop =
    args.mode === "read" && anchorDelta !== 0
      ? clampTop(prev.scrollTop + anchorDelta, maxBottomCurr)
      : clampTop(prev.scrollTop, maxBottomCurr);

  const residualUserDelta = curr.scrollTop - expectedScrollTop;
  const distFromBottom =
    curr.scrollHeight - curr.scrollTop - curr.clientHeight;
  const atBottom = distFromBottom <= eps;

  let intent: ScrollIntent = "none";
  let shouldScroll = false;
  let newScrollTop: number | undefined;

  // READ-mode compensation failure: the logical anchor moved but the browser
  // did NOT move scrollTop to track it (overflow-anchor:auto unreliable during
  // hydration / load-more). Correct it mechanically. Detected by: anchor
  // shifted, but scrollTop barely moved relative to PREVIOUS (so it wasn't a
  // user scroll) yet the residual against the anchor-tracked expectation is
  // large. Covers both grow-above-froze (residual negative) and
  // shrink-above-froze (residual positive), unified by abs().
  if (
    args.mode === "read" &&
    anchorDelta !== 0 &&
    Math.abs(curr.scrollTop - prev.scrollTop) <= eps &&
    Math.abs(residualUserDelta) > eps
  ) {
    intent = "none";
    shouldScroll = true;
    newScrollTop = expectedScrollTop;
  } else if (atBottom) {
    intent = "reached-bottom";
  } else if (residualUserDelta < -eps) {
    intent = "user-scroll-up";
  } else if (residualUserDelta > eps) {
    intent = "user-scroll-down";
  } else {
    intent = "none";
  }

  // TAIL-mode re-glue: while following, any non-user-scroll-up transition is
  // layout churn we must absorb by re-pinning to the bottom. Epsilon-guard the
  // write so a no-op frame doesn't churn RO/onScroll.
  if (args.mode === "tail" && args.following && intent !== "user-scroll-up") {
    const target = maxBottomCurr;
    if (Math.abs(curr.scrollTop - target) > eps) {
      shouldScroll = true;
      newScrollTop = target;
    }
  }

  return {
    shouldScroll,
    newScrollTop,
    expectedScrollTop,
    residualUserDelta,
    contentDelta,
    viewportDelta,
    intent,
  };
}
