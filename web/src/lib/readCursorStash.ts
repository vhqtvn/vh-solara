// P1-WEB-004 — arm-time stash for the read-cursor session-switch flush.
//
// Extracted from ChatView.tsx so the throttle + capture + flush-on-switch state
// machine can be unit-tested in isolation (no component / reactive harness).
// Pure: no Solid imports, no DOM access, no module-level state. The clock is
// injected as a `now` arg to arm(); the read-position producer is injected as a
// `read` callback. All side effects (setReadAnchor, the 400ms debounce timer)
// stay in the component — this module owns ONLY the throttle bookkeeping, the
// stashed capture, and the monotonic flush decision.
//
// Why it exists: the read cursor is persisted on scroll-idle via a 400ms
// debounce (flushReadCursor in ChatView). When the user switches sessions inside
// that 400ms window the debounce is cancelled — measuring geometry then would
// record the WRONG (entering) session — so the OUTGOING session's last-known
// read position would be lost. This stash captures that position on a throttled
// leading edge (≤5/sec at the default 200ms) as the user scrolls, and the
// session-switch effect (on(props.sessionId)) flushes it under a monotonic guard
// (orderAhead against the OUTGOING session's message order) before clearing. The
// leading-edge first arm fires immediately (lastArmMs starts at 0), making the
// <400ms switch case deterministic.
//
// This is a CPU layout-read at ≤5/sec, reads-only, idle during streaming —
// categorically distinct from the per-frame GPU re-raster heat saga called out
// in AGENTS.md "Web frontend performance".

import { orderAhead } from "./scroll";

/** A stashed (session, read-candidate) capture awaiting a switch flush. */
export interface StashEntry {
  sid: string;
  cand: string;
}

/** Inputs to a throttled arm. All pure — no DOM, no signals. */
export interface ArmInput {
  /** Logical clock (Date.now() in the component). Injected for testability. */
  now: number;
  /** Draft sessions never persist a read cursor — arm is a no-op. */
  draft: boolean;
  /** Whether the scroll viewport exists. Without it there is nothing to read. */
  hasViewport: boolean;
  /** The session currently in view (the OUTGOING session at switch time). */
  sessionId: string;
  /**
   * Produces the current read-through candidate (bottommostReadFromDom in the
   * component). A falsy result means "nothing read past the top yet" — no
   * capture is recorded, but the throttle is still advanced (mirrors the
   * inlined original: `lastArmMs = now` ran before the read, unconditionally
   * inside the time-guard branch).
   */
  read: () => string | undefined;
}

/** Monotonic flush decision for the OUTGOING session on switch. */
export interface FlushDecision {
  /** Whether the caller should write the candidate as the outgoing read anchor. */
  write: boolean;
  /** The candidate to write (present iff `write` is true). */
  cand?: string;
}

export interface ReadCursorStash {
  /**
   * Throttled leading-edge capture. At most one capture per `throttleMs`; the
   * first arm after create/consume fires immediately (lastArmMs starts at 0).
   */
  arm(input: ArmInput): void;
  /**
   * Pure monotonic flush decision for the OUTGOING session on switch. Does NOT
   * mutate the stash — call `consume` afterwards to clear + reset the throttle.
   * `currentAnchor` is the stored read anchor for prevId (getReadAnchor);
   * `order` is the outgoing session's message order (state.messages[prevId]).
   * Returns {write:false} when prevId is falsy, no stash is held, or the held
   * stash belongs to a different session.
   */
  flushForOutgoing(
    prevId: string | undefined,
    currentAnchor: string | undefined,
    order: string[],
  ): FlushDecision;
  /**
   * Drop the stash when it belongs to `sid` (used at the caught-up sites:
   * flushReadCursor nearBottom branch + onScrolled reached-bottom branch).
   * No-op when `sid` does not match or there is no stash.
   */
  invalidateIfSession(sid: string): void;
  /**
   * Clear the stash and reset the throttle so the entering session re-arms on
   * its own scroll (leading edge). Called on every session switch after the
   * flush decision has been applied.
   */
  consume(): void;
  /** Diagnostics: the currently stashed entry (or undefined). */
  peek(): StashEntry | undefined;
}

/**
 * Build a single-flight arm-time stash. One stash per ChatView instance owns the
 * throttle cursor + the stashed capture; the read-anchor store (lib/scroll) is
 * owned by the caller and threaded into flushForOutgoing.
 */
export function createReadCursorStash(opts: { throttleMs?: number } = {}): ReadCursorStash {
  const throttleMs = opts.throttleMs ?? 200;
  let armed: StashEntry | undefined;
  let lastArmMs = 0;
  return {
    arm(input) {
      if (input.draft || !input.hasViewport) return;
      if (input.now - lastArmMs < throttleMs) return;
      // Advance the throttle BEFORE the read, even when read() returns nothing
      // — mirrors the inlined original (lastArmMs = now ran unconditionally
      // inside the time-guard branch, ahead of bottommostReadFromDom).
      lastArmMs = input.now;
      const cand = input.read();
      if (cand) armed = { sid: input.sessionId, cand };
    },
    flushForOutgoing(prevId, currentAnchor, order) {
      if (prevId && armed && armed.sid === prevId) {
        if (orderAhead(armed.cand, currentAnchor, order)) {
          return { write: true, cand: armed.cand };
        }
      }
      return { write: false };
    },
    invalidateIfSession(sid) {
      if (armed?.sid === sid) armed = undefined;
    },
    consume() {
      armed = undefined;
      lastArmMs = 0;
    },
    peek() {
      return armed;
    },
  };
}
