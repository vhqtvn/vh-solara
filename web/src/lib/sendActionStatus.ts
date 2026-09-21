// Per-action send status store — send-reliability slice 2.
//
// Sits BESIDE the send admission guard (lib/sendSingleFlight.ts), NOT inside
// it, and does NOT repurpose sync/store.ts's dispatch guard (per the accepted
// send-reliability brief §4.3): the single-flight answers "is a send already
// in-flight for this key?" (a boolean latch), while THIS store answers "what
// happened to THIS logical send attempt, how certain is that, and what can the
// operator do about it?" Queue items remain authoritative for server custody
// once admission is confirmed; this store owns pre-admission progress and
// post-dispatch status-recording state.
//
// Core typed distinction (brief §4.4): every terminal-ish stage carries a
// CERTAINTY — "definitive" (the server told us; safe to act on) vs "unknown"
// (transport hang / response loss / proxy 502 — the outcome is NOT proof of
// failure and must never be presented as "safe to resend"). The distinction is
// a TYPE here, not prose; Slice 3 renders it.
//
// Lifecycle of an action record:
//
//   preparing → admitting → admitted     (record REMOVED — the queue item is
//                                         now the authority; the chip shows it)
//   preparing → blocked                  (attachments failed; retained)
//   preparing → uncertain                (admission/session-create outcome
//                                         unknown; retained, retry-same)
//   admitting → conflict | rejected      (definitive 409/429-style; retained)
//   any linked item → conflict           (resolve write hit
//                                         queue_resolve_conflict; retained)
//
// Retained records are the recovery surface: `payload` keeps the immutable
// prepared attempt (verbatim enqueue input + tap-time text) so a retry reuses
// the SAME attemptId + payload (server dedupes admission), and `recovery`
// names the operator action Slice 3 will render.
//
// Ownership: an attempt starts under ownerKey "draft" (a draft send mints it
// before the session exists) and is EXPLICITLY transferred to the live session
// id once createSession resolves (createSend's draft→live single-flight handoff
// — the two single-flight keys are distinct by design, so the transfer must be
// explicit). The handoff sweeps EVERY still-draft-owned record, not just the
// in-flight attempt (transferOwnerSendAttempts): retained records from earlier
// draft taps must follow the user into the session too (F2, slice-3 review).
// All reads/writes are keyed by attemptId; UI queries by ownerKey.
//
// In-memory only (module singleton, like sendSingleFlight): a reload re-fetches
// server truth; unconfirmed browser attempts are NOT part of the durability
// guarantee (explicitly out of scope per the brief).
import { createStore, produce, unwrap } from "solid-js/store";

// How certain a recorded outcome is. "unknown" means outcome-unknown (transport
// hang, response loss, proxy 502) — NEVER "failed, safe to resend".
export type SendCertainty = "definitive" | "unknown";

// Lifecycle stage of one logical send attempt.
export type SendStage =
  | "preparing" // admission begun: agent gate / session create / uploads
  | "admitting" // the enqueue POST is in flight
  | "admitted" // server receipt confirmed (record is then finished/removed)
  | "uncertain" // outcome unknown (response loss / timeout / proxy 502); retained
  | "conflict" // definitive 409 (admission or resolve conflict); retained
  | "rejected" // definitive non-2xx rejection (incl. 429 queue_admission_full)
  | "blocked" // attachment failure halted admission before any send; retained
  // Send-reliability slice 3: the DISPATCH already produced a known terminal
  // outcome, but the resolve WRITE (the status record) failed its bounded
  // retries — "Message outcome recorded; status not saved." The message is NOT
  // resendable from here; only the status save is retryable (a record, never a
  // dispatch).
  | "unsaved";

// The operator-facing recovery action this record affords (Slice 3 renders it).
//   retry-same — re-send the IDENTICAL prepared attempt (same attemptId +
//               payload; the server dedupes admission). Only for uncertain
//               ENQUEUE outcomes where the dedupe contract makes it safe.
//   restore    — the payload is retained for restore-to-composer.
//   check      — outcome unknown AND not safely retryable (e.g. session-create
//               ambiguity): check before sending again.
//   retry-save — stage "unsaved": retry the STATUS-SAVE write only (resolveQueued
//               with the same terminal (state, detail) — a record, NOT a resend).
//   none       — nothing to do (transient/preparing).
export type SendRecovery = "none" | "retry-same" | "restore" | "check" | "retry-save";

// The immutable prepared attempt: the EXACT enqueue input captured once at
// first preparation. Every retry reuses it verbatim — no re-captured config,
// no re-resolved text, no fresh attachment array.
export interface PreparedSendPayload {
  // Raw TAP-time composer text (pre inline-resolution) — the retry-matching key
  // (a re-tap with the same text is a retry of the same logical attempt).
  tapText: string;
  // The exact text enqueued (inline tokens already substituted).
  text: string;
  // The exact attachment array enqueued (server-backed urls).
  attachments: { url: string; filename: string; mime: string; path?: string }[];
  // The exact captured send config.
  sendConfig?: { providerID?: string; modelID?: string; variant?: string; agent?: string };
  // Retained file references (filenames of files involved in this attempt) —
  // diagnostics for Slice 3's recovery affordances.
  files?: string[];
}

export interface SendAction {
  attemptId: string;
  // "draft" or the live session id. Transferred explicitly on draft→live.
  ownerKey: string;
  stage: SendStage;
  certainty: SendCertainty;
  detail?: string;
  // Retained immutable payload (present from first enqueue preparation).
  payload?: PreparedSendPayload;
  recovery: SendRecovery;
  updatedAt: number;
  // Send-reliability slice 3: true when this in-flight attempt is a RETRY of a
  // retained uncertain admission (reused attemptId + verbatim payload) — the
  // status surface renders "Retrying queue confirmation…" instead of a plain
  // "Sending…". Set once by createSend at the reuse decision.
  retry?: boolean;
  // Stage "conflict" provenance: "admission" (409 queue_admission_conflict —
  // a conflicting admission exists; check the queue before sending again) vs
  // "resolve" (409 queue_resolve_conflict — the queue cache has been
  // refreshed to SERVER truth). Drives the operator-facing copy in
  // SendStatus; undefined keeps the generic conflict copy.
  conflictSource?: "admission" | "resolve";
  // Stage "unsaved" only: what the Retry-status-save affordance re-records —
  // the exact terminal (state, detail) of the dispatch outcome plus the queue
  // item id. resolveQueued(idempotent record) consumes this verbatim.
  retrySave?: { itemId: string; state: "sent" | "failed" | "unknown"; detail: string };
  // A1 create-linkage (send-defers study): for a create-outcome-unknown record
  // (markOwnerSessionCreateUnknown), the [start, end] CLIENT-clock window (ms)
  // during which the session-create POST was in flight (start = when the POST
  // was armed — CreateSessionOutcome.startedAt; end = when unknown was marked).
  // A session whose WORKER-stamped time.created falls inside this window ±
  // CREATE_LINK_CLOCK_SKEW_MS is a linkage CANDIDATE — timing is the only
  // correlation signal (the create POST body is "{}"; no client id is echoed
  // back by OpenCode). Consumed ONLY by the operator-confirmed linkage
  // affordance in SendStatus; records are NEVER auto-re-keyed on it.
  createAttempt?: { start: number; end: number };
}

// Reactive store keyed by attemptId. Reads via sendActionsFor(ownerKey) are
// reactive (bind inside a Solid computation for Slice 3 rendering).
const [actions, setActions] = createStore<Record<string, SendAction>>({});

// Insertion counter per attemptId — a deterministic newest-first tie-break
// when two actions land in the same Date.now() millisecond.
const mintedSeq = new Map<string, number>();
let seq = 0;
function newAttemptId(): string {
  const c: Crypto | undefined = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === "function") return `att-${c.randomUUID()}`;
  return `att-${Date.now().toString(36)}-${++seq}`;
}

function patch(attemptId: string, p: Partial<SendAction>): void {
  setActions(
    produce((map) => {
      const cur = map[attemptId];
      if (!cur) return; // finished/unknown id — writes are no-ops
      Object.assign(cur, p, { updatedAt: Date.now() });
    }),
  );
}

/** Mint a new send attempt under `ownerKey` (stage "preparing"). Superseded
 *  non-uncertain retained records for the same owner (blocked/rejected/
 *  preparing leftovers from earlier taps) are finished so one owner shows at
 *  most one live recovery record plus any still-uncertain ones. */
export function mintSendAttempt(ownerKey: string): SendAction {
  // Finish superseded records (uncertain ones are kept — they are reusable).
  for (const id of Object.keys(actions)) {
    const a = actions[id];
    if (a.ownerKey === ownerKey && (a.stage === "preparing" || a.stage === "blocked" || a.stage === "rejected")) {
      finishSendAttempt(id);
    }
  }
  const action: SendAction = {
    attemptId: newAttemptId(),
    ownerKey,
    stage: "preparing",
    certainty: "unknown",
    recovery: "none",
    updatedAt: Date.now(),
  };
  mintedSeq.set(action.attemptId, ++seq);
  setActions(action.attemptId, action);
  return action;
}

/** Explicit draft→live ownership transfer (the single-flight keys are distinct
 *  by design; this is the only way an attempt changes owner). No-op for an
 *  unknown/finished attempt. */
export function transferSendAttempt(attemptId: string, newOwnerKey: string): void {
  patch(attemptId, { ownerKey: newOwnerKey });
}

/** F2 (slice-3 review): re-key EVERY retained record owned by `fromOwnerKey`
 *  to `toOwnerKey` — the draft→live materialization sweep. Slice 2's
 *  per-attempt transferSendAttempt re-keyed only the IN-FLIGHT attempt;
 *  retained records from EARLIER draft taps (a create-outcome-unknown
 *  uncertain/check record is the reachable case) stayed stranded under
 *  "draft": invisible in the destination session (SendStatus queries by the
 *  session-id owner key) and stale in the NEXT draft view. At materialization
 *  the retained draft-owned set is exactly the in-flight attempt plus
 *  uncertain records — mint-supersede already finished earlier
 *  preparing/blocked/rejected ones — so sweeping everything is safe. Residual
 *  limitation (accepted): when the operator materializes the session WITHOUT
 *  re-tapping (the create landed; they click the session in the list), no
 *  client code observes the draft→session linkage — re-keying that arc needs
 *  a session-create idempotency key (out of scope, brief §8). Returns the
 *  number of records transferred. */
export function transferOwnerSendAttempts(fromOwnerKey: string, toOwnerKey: string): number {
  let n = 0;
  setActions(
    produce((map) => {
      for (const a of Object.values(map)) {
        if (a.ownerKey === fromOwnerKey) {
          a.ownerKey = toOwnerKey;
          a.updatedAt = Date.now();
          n++;
        }
      }
    }),
  );
  return n;
}

/** Read one action (undefined once finished). */
export function getSendAction(attemptId: string): SendAction | undefined {
  return actions[attemptId];
}

/** All retained actions owned by `ownerKey` (newest first). Reactive read —
 *  safe inside Solid computations (Slice 3's status surface). */
export function sendActionsFor(ownerKey: string): SendAction[] {
  return Object.values(actions)
    .filter((a) => a.ownerKey === ownerKey)
    .sort((a, b) => (b.updatedAt - a.updatedAt) || ((mintedSeq.get(b.attemptId) ?? 0) - (mintedSeq.get(a.attemptId) ?? 0)));
}

/** Stage/certainty/recovery/detail transition. Recording the retained payload
 *  is additive (sendText snapshots it right before the enqueue POST). */
export function updateSendAction(
  attemptId: string,
  p: { stage?: SendStage; certainty?: SendCertainty; recovery?: SendRecovery; detail?: string; payload?: PreparedSendPayload; retry?: boolean; conflictSource?: "admission" | "resolve" },
): void {
  patch(attemptId, p);
}

/** Remove a record. Called when admission is CONFIRMED (admitted) — the queue
 *  item is the authority now — or when a retained record is superseded. */
export function finishSendAttempt(attemptId: string): void {
  mintedSeq.delete(attemptId);
  setActions(
    produce((map) => {
      delete map[attemptId];
    }),
  );
}

/** Find a reusable uncertain attempt: same owner, stage "uncertain", recovery
 *  "retry-same", and a retained payload whose tapText matches `tapText`
 *  exactly. This is the retry-the-same-prepared-attempt linkage: the re-tap
 *  reuses the attemptId + payload verbatim and the server dedupes admission.
 *  Caller additionally verifies the composer's current attachment set is a
 *  subset of the retained payload's (identity) before reusing. */
export function findReusableSendAttempt(ownerKey: string, tapText: string): SendAction | undefined {
  return sendActionsFor(ownerKey).find(
    (a) => a.stage === "uncertain" && a.recovery === "retry-same" && a.payload?.tapText === tapText,
  );
}

/** Identity-subset gate for the reuse paths: is every LIVE composer attachment
 *  (raw objects, from the composer signal) one of the STORED payload's
 *  attachments (per-object identity)? A chip REMOVED after the attempt still
 *  passes (the stored superset replays verbatim); a chip ADDED after the
 *  attempt fails (the operator is composing a new message).
 *
 *  WHY a helper instead of `payload.attachments.includes(live)` inline: the
 *  store wraps nested objects in reactive proxies ON READ, so a proxied
 *  element NEVER compares === to the raw live chip — the inline includes is
 *  ALWAYS false for a payload with attachments (probe-confirmed; the reuse
 *  gate in createSend silently never matched, minting fresh attemptIds for
 *  attachment-bearing retries). unwrap() recovers the raw stored refs the
 *  live chips are compared against; it is a no-op on a raw (non-store)
 *  payload. */
export function attachmentsSubsetOfPayload(
  live: readonly unknown[],
  payload: PreparedSendPayload,
): boolean {
  const stored = unwrap(payload).attachments as unknown[];
  return live.every((a) => stored.includes(a));
}

/** ChatView.ensureSession calls this when createSession fails with UNKNOWN
 *  certainty (timeout / proxy 502): the session may exist. Marks the (single,
 *  single-flight-guaranteed) preparing action owned by `ownerKey` (="draft")
 *  as uncertain with check-before-resending recovery.
 *
 *  A1 create-linkage: when `createStartedAt` is supplied (the POST-armed
 *  timestamp from CreateSessionOutcome.startedAt), the create-attempt window
 *  [createStartedAt, Date.now()] is recorded on the patched record so
 *  SendStatus's operator-confirmed linkage affordance can correlate it with a
 *  session that later appears (createLinkCandidates). */
export function markOwnerSessionCreateUnknown(ownerKey: string, detail: string, createStartedAt?: number): void {
  for (const id of Object.keys(actions)) {
    const a = actions[id];
    if (a.ownerKey === ownerKey && a.stage === "preparing") {
      patch(id, {
        stage: "uncertain",
        certainty: "unknown",
        recovery: "check",
        detail,
        createAttempt: createStartedAt != null ? { start: createStartedAt, end: Date.now() } : undefined,
      });
    }
  }
}

// A1 create-linkage (send-defers study): how far the WORKER clock (which stamps
// a session's time.created) may sit from the CLIENT clock (which stamps the
// create-attempt window) before a candidate match is refused. Generous on
// purpose: a false NEGATIVE hides the real session (the stranding defect
// persists), while a false positive costs the operator one glance at an
// affordance they can decline — and the re-key NEVER happens without that
// click. Named + exported so tests can reason about (and override) it.
export const CREATE_LINK_CLOCK_SKEW_MS = 5 * 60_000;

/** Minimal session shape the A1 linkage matcher consumes (the sync store's
 *  Session type satisfies this structurally). */
export interface CreateLinkSessionInfo {
  id: string;
  title?: string;
  time?: { created?: number };
}

/** A candidate linkage target the draft-view affordance offers the operator. */
export interface CreateLinkCandidate {
  id: string;
  title?: string;
  created: number;
}

/** A1 linkage candidates: sessions whose worker-stamped time.created falls
 *  within the create-attempt window (± `skewMs`) of ANY retained
 *  uncertain/check record in `records` (the draft-owned create-unknown shape —
 *  only markOwnerSessionCreateUnknown mints that combination). Pure function —
 *  SendStatus binds it to the sync store's sessions map reactively. Returns
 *  newest-created first; a session matching several windows is listed once. */
export function createLinkCandidates(
  sessions: CreateLinkSessionInfo[],
  records: SendAction[],
  skewMs: number = CREATE_LINK_CLOCK_SKEW_MS,
): CreateLinkCandidate[] {
  const windows = records
    .filter((r) => r.stage === "uncertain" && r.recovery === "check" && !!r.createAttempt)
    .map((r) => r.createAttempt!);
  if (windows.length === 0) return [];
  const out: CreateLinkCandidate[] = [];
  for (const s of sessions) {
    const created = s.time?.created;
    if (!created) continue;
    const inWindow = windows.some((w) => created >= w.start - skewMs && created <= w.end + skewMs);
    if (inWindow) out.push({ id: s.id, title: s.title, created });
  }
  return out.sort((a, b) => b.created - a.created);
}

/** queue.resolveQueued calls this when the resolve WRITE hits a 409
 *  queue_resolve_conflict: the server holds a DIFFERENT terminal state for the
 *  item than our locally-known outcome. The queue cache is refreshed to server
 *  truth separately; this records the explicit conflict on the linked attempt
 *  (item.attemptId) so the operator-visible state is expressible.
 *
 *  UPSERT: an admitted attempt's record is normally FINISHED by the time the
 *  drainer resolves it (createSend drops it on confirmed custody), so the id
 *  may not be retained here — in that case a minimal conflict record is
 *  created under `ownerKey` (the session id) so the conflict is still
 *  renderable (Slice 3). */
export function markSendAttemptResolveConflict(attemptId: string, ownerKey: string, detail: string): void {
  if (getSendAction(attemptId)) {
    patch(attemptId, { stage: "conflict", certainty: "definitive", recovery: "check", detail, conflictSource: "resolve" });
    return;
  }
  setActions(attemptId, {
    attemptId,
    ownerKey,
    stage: "conflict",
    certainty: "definitive",
    detail,
    recovery: "check",
    conflictSource: "resolve",
    updatedAt: Date.now(),
  });
  mintedSeq.set(attemptId, ++seq);
}

/** queue.resolveQueued calls this when the resolve WRITE exhausts its bounded
 *  retries (unrecorded): the dispatch already produced a KNOWN terminal outcome
 *  that is visible locally (optimistic terminal), but the backend never
 *  received the record. The message is NOT resendable from here — only the
 *  status save is retryable (a record, never a dispatch).
 *
 *  UPSERT (same shape as markSendAttemptResolveConflict): an admitted attempt's
 *  record is normally FINISHED by the time the drainer resolves it, so the id
 *  may not be retained — in that case a minimal unsaved record is created
 *  under `ownerKey` (the session id) so the "Retry status save" affordance is
 *  still renderable (Slice 3). */
export function markSendAttemptStatusUnsaved(
  attemptId: string,
  ownerKey: string,
  save: { itemId: string; state: "sent" | "failed" | "unknown"; detail: string },
): void {
  if (getSendAction(attemptId)) {
    patch(attemptId, { stage: "unsaved", certainty: "definitive", recovery: "retry-save", retrySave: save });
    return;
  }
  setActions(attemptId, {
    attemptId,
    ownerKey,
    stage: "unsaved",
    certainty: "definitive",
    detail: "queue status write failed after bounded retries",
    recovery: "retry-save",
    retrySave: save,
    updatedAt: Date.now(),
  });
  mintedSeq.set(attemptId, ++seq);
}

/** Test-only: drop every retained action. */
export function __resetSendActionStatusForTests(): void {
  mintedSeq.clear();
  setActions(
    produce((map) => {
      for (const k of Object.keys(map)) delete map[k];
    }),
  );
}
