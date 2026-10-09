// Ambiguous replacement controller — the one-tap "Send new message" flow off
// an AmbiguousDelivery chip (send-net-resilience slice 3, debate-4 B1).
//
// A replacement is a NEW gesture by construction: it mints a NEW intentId
// (never reuses the original's — an intentional repeat, safe because the
// duplicate risk is user-authorized by the verbatim warning), captures the
// context-head AT TAP, and persists the gesture through the same BLK-A3
// outbox gate as a composer send (blocking "not saved" state on storage
// failure — nothing sends without a committed local save). The ORIGINAL item
// is marked ambiguous_replacement_requested (the FE-owned overlay the chip
// renders as "Replacement requested"); the server item stays
// unknown+ambiguousDelivery, and if the original arrives later BOTH messages
// display truthfully.
//
// The VISIBLE stale-context confirmation lives in AmbiguousChip (the first
// tap flips the chip into an inline "conversation moved on — send anyway?"
// confirm when the original gesture's captured head no longer matches). This
// controller arms a pending-confirm entry carrying the LIVE head at that
// first tap and RE-VERIFIES at execution against THAT head
// (compare-at-REPLACEMENT, debate-4 finding 7 amended 2026-10-09): the live
// head still equals the first-tap head → the operator acknowledged exactly
// this drift → PROCEED; the head moved during the confirm window → refuse
// loudly. Re-verifying against the ORIGINAL gesture's captured head instead
// (the pre-amendment bug) re-refused every "Send anyway" forever — nothing
// rewrites that capture between taps, so the amended flow could never run.
import type { Accessor } from "solid-js";
import { log } from "../../lib/log";
import { mintSendAttempt, finishSendAttempt, updateSendAction } from "../../lib/sendActionStatus";
import {
  capturedHeadFor,
  headIsStale,
  markAdmitted,
  requestReplacement,
  saveGesture,
} from "../../lib/outbox";
import type { OutboxContextHead, OutboxPayload } from "../../lib/outbox";
import { EnqueueError, type QueuedMessage } from "../../queue";
import type { Notification } from "../../notify";

export interface AmbiguousReplacementDeps {
  sessionId: Accessor<string>;
  // The real queue enqueue (admission). Returns the created item.
  enqueue: (
    sessionId: string,
    input: OutboxPayload & { intentId: string },
  ) => Promise<QueuedMessage>;
  // The live context-head for the stale gate.
  captureHead: (sessionId: string) => OutboxContextHead | null;
  // Non-fatal operator notices.
  notify: (n: Omit<Notification, "id" | "time" | "read">) => void;
}

export interface AmbiguousReplacement {
  /** First tap of "Send new message": the eligibility + stale-context check
   *  that decides whether the chip may send immediately or must first show
   *  its inline "conversation moved on — send anyway?" confirmation. Pure
   *  with respect to stores (no outbox/queue writes); a "stale-confirm"
   *  verdict arms the controller-LOCAL pending-confirm entry (the first-tap
   *  head the operator will confirm against — memory state only, refreshed
   *  by the next tap); "refused" already notified. */
  tap: (q: QueuedMessage) => Promise<"confirmed" | "stale-confirm" | "refused">;
  /** Execute the replacement gesture for an ambiguous item. Refuses loudly
   *  (notification, no enqueue) for ineligible items, a moved-on context
   *  head nobody confirmed (no pending confirm: the ORIGINAL predicate), a
   *  head that moved again DURING the stale-confirm window (pending
   *  confirm: compare-at-REPLACEMENT), or an uncommittable local save.
   *  Resolves true when the new gesture was admitted. A tap while a
   *  replacement for the SAME item is still in flight is DROPPED (returns
   *  false; no second gesture, no enqueue — c-F3 double-tap guard). */
  replace: (q: QueuedMessage) => Promise<boolean>;
}

export function createAmbiguousReplacement(deps: AmbiguousReplacementDeps): AmbiguousReplacement {
  const eligible = (q: QueuedMessage): boolean =>
    q.state === "unknown" && !!q.ambiguousDelivery;

  // c-F3 (review): per-item in-flight guard for `replace`. A fast second tap
  // during the admission window (outbox save → enqueue → overlay) would
  // otherwise mint a SECOND replacement gesture — two new intentIds, two
  // enqueues: the core duplicate-harm class. Keyed by queue item id, acquired
  // BEFORE any await, cleared on settle — so a LATER explicit re-tap (e.g.
  // the uncertain row's retry-same after a failed admission) still works.
  const replacing = new Set<string>();

  // Compare-at-REPLACEMENT (debate-4 finding 7, amended 2026-10-09 — review
  // C1/C2): when tap() reports "stale-confirm", remember the LIVE head the
  // operator saw and acknowledged at that first tap, per item. runReplace
  // re-verifies the live head against THIS entry (not the original gesture's
  // captured head — nothing rewrites that capture between taps, so the old
  // identical-predicate re-verify refused every "Send anyway" forever).
  // Controller-local memory only — never a store write. Lifecycle: armed by
  // the tap that enters stale-confirm, refreshed by any later tap, consumed
  // (deleted) by the runReplace that reads it, and cleared on any settle.
  const pendingConfirm = new Map<string, { firstTapHead: OutboxContextHead | null; armedAt: number }>();

  async function tap(q: QueuedMessage): Promise<"confirmed" | "stale-confirm" | "refused"> {
    const sid = deps.sessionId();
    if (!eligible(q)) {
      pendingConfirm.delete(q.id); // item can no longer send — nothing to confirm
      deps.notify({
        kind: "error", sessionID: sid, title: "Replacement unavailable — status changed",
        detail: "Nothing was sent. This message is no longer in the unconfirmed-delivery state.",
      });
      return "refused";
    }
    // The stale gate: the ORIGINAL gesture's captured head (at its local
    // save) vs the live head now. A moved-on conversation requires the
    // inline visible confirmation before the replacement may send. Legacy
    // items without an intentId have no captured head — never fabricate
    // staleness (the verbatim warning was already acknowledged by the tap).
    if (q.intentId) {
      const captured = await capturedHeadFor(q.intentId);
      const live = deps.captureHead(sid);
      if (headIsStale(captured, live)) {
        // Arm the confirmation baseline: the operator is about to
        // acknowledge drift up to THIS head. runReplace compares against
        // it — the drift the operator saw is exactly the drift approved.
        pendingConfirm.set(q.id, { firstTapHead: live, armedAt: Date.now() });
        return "stale-confirm";
      }
    }
    pendingConfirm.delete(q.id); // fresh context (or a rollback to fresh): nothing to confirm
    return "confirmed";
  }

  async function replace(q: QueuedMessage): Promise<boolean> {
    if (replacing.has(q.id)) {
      // Double-tap during the admission window: DROP the second tap (no
      // second gesture minted, no notification — the in-flight replacement
      // owns the item; same posture as the composer send single-flight).
      log.warn("ambiguous-replace", "dropped: replacement already in flight for this item", {
        itemId: q.id,
      });
      return false;
    }
    replacing.add(q.id);
    try {
      return await runReplace(q);
    } finally {
      replacing.delete(q.id); // cleared on settle — a later explicit re-tap works
    }
  }

  async function runReplace(q: QueuedMessage): Promise<boolean> {
    const sid = deps.sessionId();
    if (!eligible(q)) {
      log.error("ambiguous-replace", "refused: item not ambiguous-eligible", { sid, itemId: q.id });
      deps.notify({
        kind: "error", sessionID: sid, title: "Replacement unavailable — status changed",
        detail: "Nothing was sent. This message is no longer in the unconfirmed-delivery state.",
      });
      return false;
    }
    // Stale-context TOCTOU re-verify at execution — compare-at-REPLACEMENT
    // (debate-4 finding 7, amended 2026-10-09). Two bases:
    //  - PENDING confirm (tap() reported "stale-confirm" and the operator
    //    tapped "Send anyway"): verify the live head against the FIRST-TAP
    //    head the operator acknowledged. Unchanged → the operator confirmed
    //    exactly this drift → PROCEED. Moved since the first tap (drift
    //    during the confirm window) → refuse loudly (fresh confirmation).
    //  - NO pending confirm (the fresh single-tap path, or a direct call):
    //    the ORIGINAL gesture's captured head vs the live head — a moved-on
    //    conversation nobody confirmed → refuse loudly.
    const pending = pendingConfirm.get(q.id);
    if (pending) pendingConfirm.delete(q.id); // consumed by this attempt — any settle clears
    if (q.intentId) {
      if (pending) {
        if (headIsStale(pending.firstTapHead, deps.captureHead(sid))) {
          log.warn("ambiguous-replace", "refused: head moved during the stale-confirm window", {
            sid, itemId: q.id, armedAt: pending.armedAt,
          });
          deps.notify({
            kind: "error", sessionID: sid, title: "Conversation moved on",
            detail: "Nothing was sent. The conversation changed again — check it and tap Send new message once more.",
          });
          return false;
        }
      } else {
        const captured = await capturedHeadFor(q.intentId);
        if (headIsStale(captured, deps.captureHead(sid))) {
          deps.notify({
            kind: "error", sessionID: sid, title: "Conversation moved on",
            detail: "Nothing was sent. The conversation changed again — check it and tap Send new message once more.",
          });
          return false;
        }
      }
    }
    // NEW gesture: fresh intentId (mintSendAttempt's repo pattern — also
    // gives the status row its identity).
    const action = mintSendAttempt(sid);
    const newIntentId = action.attemptId;
    const payload: OutboxPayload = {
      text: q.text,
      attachments: q.attachments.map((a) => ({ url: a.url, filename: a.filename, mime: a.mime, path: a.path })),
      sendConfig: q.sendConfig,
    };
    // BLK-A3 outbox gate (same contract as a composer send): capture at tap,
    // commit before admission, block visibly on storage failure.
    const save = await saveGesture({
      intentId: newIntentId,
      sessionId: sid,
      payload,
      capturedHead: deps.captureHead(sid),
    });
    if (!save.ok) {
      updateSendAction(newIntentId, {
        stage: "blocked", certainty: "definitive", recovery: "restore",
        detail: `outbox save failed: ${save.reason}`, reason: "storage-unavailable",
      });
      log.error("ambiguous-replace", "outbox save failed — replacement blocked", { sid, reason: save.reason });
      return false;
    }
    updateSendAction(newIntentId, { stage: "admitting" });
    try {
      const item = await deps.enqueue(sid, { ...payload, intentId: newIntentId });
      finishSendAttempt(newIntentId);
      await markAdmitted(newIntentId, item.id);
      // The replacement is admitted: mark the ORIGINAL gesture's overlay
      // (ambiguous_replacement_requested). Server truth for the original is
      // untouched — both messages display truthfully if both land.
      if (q.intentId) await requestReplacement(q.intentId, newIntentId);
      return true;
    } catch (e) {
      // Definitive rejections surface on the row; response-less failures stay
      // retry-same under the NEW intentId (the daemon dedupes by value — the
      // row's Retry re-admits the same replacement gesture safely).
      if (e instanceof EnqueueError) {
        const definitive =
          e.code === "queue_admission_conflict" || e.code === "queue_admission_full" || e.status !== undefined;
        if (definitive) {
          updateSendAction(newIntentId, {
            stage: "rejected",
            certainty: "definitive", recovery: "restore",
            detail: e.message, reason: e.code === "queue_admission_full" ? "queue-full" : undefined,
          });
          return false;
        }
      }
      updateSendAction(newIntentId, {
        stage: "uncertain", certainty: "unknown", recovery: "retry-same",
        detail: `replacement admission: ${String(e)}`,
        payload: { tapText: q.text, ...payload },
      });
      // The overlay is armed even on uncertain admission: the operator took
      // the replacement decision; the row's retry-same finishes the gesture.
      if (q.intentId) await requestReplacement(q.intentId, newIntentId);
      return false;
    }
  }

  return { tap, replace };
}
