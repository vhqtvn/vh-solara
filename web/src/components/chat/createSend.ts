// Send/dispatch controller — the prompt/shell send + queue-dispatch cluster,
// extracted from ChatView (mirroring createQueueDrainer / createQueueSync /
// createQueueRecovery / createAttachments). The factory owns the send
// orchestration (buildParts, captureConfig, sendText, dispatchSend, runShell,
// send) and the public surface the drainer/retry path call into
// (send, retrySameMessage, retryQueuedItem, resendText, dispatchQueuedItem). It owns NO network/localStorage
// directly except the documented globals (fetch, localStorage, setTimeout,
// Promise) — all session/composer/queue/transport state is INJECTED as deps
// so the cluster is unit-testable in isolation.
//
// Behavior-preserving extraction: bodies moved verbatim from ChatView; the
// only edits are `this.X` → `deps.X()` / local refs — EXCEPT the agent
// evidence gate (sendText/dispatchQueuedItem/runShell/send/resendText
// resolving the agent through deps.awaitAgent/resolveAgent instead of a
// single eagerly-read selected-agent string): a deliberate behavior change
// fixing the silent agent-flip incidents (see src/agents.ts' evidence
// ladder). The drainer's
// dispatch
// closure config-fallback (the `item.sendConfig?.providerID && ... ?
// ... : captureConfig(id)` ternary that lived in ChatView's queueDrainer wire-
// up) moved INTO the public dispatchQueuedItem so the drainer wire-up is a
// plain forward `(id, claimed, signal) => dispatchQueuedItem(id, claimed,
// signal)` matching queueDrain.ts's `dispatch` signature exactly.

import type { Accessor, Setter } from "solid-js";
import { log } from "../../lib/log";
import type { DispatchMode } from "../../lib/queueDispatchMode";
import {
  effectiveInline,
  inlineAttachForced,
  isInlineChipUrl,
  modelHasVision,
  resolveInlineAttachments,
  type ResolvedAttachment,
} from "../../lib/inlineAttach";
import { IGNORED, runSendSingleFlight } from "../../lib/sendSingleFlight";
import {
  attachmentsSubsetOfPayload,
  draftOwnerKey,
  findReusableSendAttempt,
  finishSendAttempt,
  getSendAction,
  mintSendAttempt,
  transferCreateOpRecords,
  transferOwnerSendAttempts,
  updateSendAction,
  type PreparedSendPayload,
} from "../../lib/sendActionStatus";
import { modernCreateTransferTarget } from "../../lib/sessionCreateStatus";
import { projectDir } from "../../sync/store";
import type { Attachment } from "./createAttachments";
import { EnqueueError, type EscalateQueuedOutcome, type QueuedMessage } from "../../queue";
import type { DrainOutcome } from "../../queueDrain";
import type { Notification } from "../../notify";
import type { OutboxContextHead, OutboxPayload, OutboxSaveResult } from "../../lib/outbox";

// Model/agent/variant a prompt is sent with (captured at queue time too).
type QueueConfig = { providerID?: string; modelID?: string; variant?: string; agent?: string };

// Send-net-resilience slice 3: the outbox seam (BLK-A3 + debate-4 finding 7,
// amended 2026-10-09 — compare at resume/replacement, not admission).
// Injected so this factory owns NO IndexedDB (mirroring the no-network/
// no-localStorage discipline); ChatView binds lib/outbox. OPTIONAL: absent
// keeps the pre-slice behavior byte-intact for minimal unit harnesses — the
// production wiring always passes it.
export interface SendOutboxDeps {
  // Persist the gesture; `{ok:true}` resolves strictly AFTER the IDB
  // transaction committed (the only legitimate origin of a "locally saved"
  // claim). On failure the caller MUST abort the send (blocking persistent
  // "not saved — copy your text" state; the composer keeps the text).
  save: (input: {
    intentId: string;
    sessionId: string;
    payload: OutboxPayload;
    capturedHead: OutboxContextHead | null;
  }) => Promise<OutboxSaveResult>;
  // Admission confirmed: link the queue item to the durable gesture record.
  markAdmitted: (intentId: string, queueItemId: string) => Promise<void>;
  // The live context-head for a session (transcript tail), or null when
  // unknowable (never fabricates staleness). Captured ONCE at tap and
  // persisted with the gesture — the RESUME/replacement stale gates read it.
  captureHead: (sessionId: string) => OutboxContextHead | null;
}

// F5 (review): bound on the LEGACY agent-less queued item's re-resolve gate
// inside the drainer's dispatch window. The drainer bounds a whole dispatch
// with a 12s AbortController (DEFAULT_DISPATCH_TIMEOUT_MS, queueDrain.ts);
// letting the gate wait the full AGENT_RESOLVE_TIMEOUT_MS (10s) would leave
// only ~2s of POST headroom and, on timeout, classify the item with the
// POST-ambiguous `unknown` even though no POST was ever attempted. 5s caps
// the wait so a resolution — or a pre-POST failure classification — settles
// with ≥7s of the dispatch budget still available for the actual
// prompt_async POST.
const QUEUED_DISPATCH_GATE_TIMEOUT_MS = 5_000;

// Slice 3 (intent recovery): the down-tied failure copy — EXACT string, the
// S4 manual check quotes it. Used as the queue item detail (the QueueChip's
// visible .queue-detail-note) while the lifecycle snapshot says OpenCode is
// down. The notification title variant lives at the call site.
const DOWN_NOT_SENT_DETAIL = "OpenCode is down — message not sent";

export type SendDependencies = {
  // session
  sessionId: Accessor<string>;
  draft: Accessor<boolean>;
  ensureSession: () => Promise<string | null>;
  // Create-certainty Slice 2 (§3.3 navigation sequencing): materialize the
  // draft's server session — setSelectedId + openSession. Extracted FROM the
  // low-level create action (which no longer navigates) so ownership/receipt
  // transfer runs FIRST and the uninterrupted send navigates AT MOST ONCE,
  // after the transfer, before the admission tail.
  materializeSession: (id: string) => void;
  // composer
  input: Accessor<string>;
  setInput: Setter<string>;
  // send gates
  readyToSend: Accessor<boolean>;
  working: Accessor<boolean>;
  queueMode: Accessor<boolean>;
  // model/agent selection
  selectionFor: (id: string) => { providerID?: string; modelID?: string; variant?: string } | null | undefined;
  // Agent resolution (src/agents.ts). `awaitAgent` is the bounded evidence
  // gate: for an existing session with no local agent evidence it WAITS for
  // hydration (message window, lastAgent.set facet, snapshot) up to
  // opts.timeoutMs (default AGENT_RESOLVE_TIMEOUT_MS), then fails with
  // ok:false (reason timeout | unavailable | hydration-error) — it NEVER
  // substitutes the config/global default. `resolveAgent` is the synchronous
  // resolver (the SAME one the composer's agent Select renders); send()
  // snapshots it ONCE at tap — a resolved tap sends that exact displayed
  // value, a pending tap waits (awaitAgent) for the FIRST valid resolution
  // (the same pending→resolved transition the composer's reactive display
  // follows). `adoptDraftAgent` records a draft's displayed agent as the
  // materialized session's first evidence.
  awaitAgent: (
    sessionId: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<{ ok: true; agent: string } | { ok: false; reason: string }>;
  resolveAgent: (
    sessionId: string,
  ) => { state: "agent"; agent: string } | { state: "pending" } | { state: "unavailable"; agent: string };
  adoptDraftAgent: (sessionID: string, agent: string) => void;
  models: Accessor<unknown[]>;
  loadModels: () => Promise<void>;
  migrateModelPick: (fromId: string, toId: string) => void;
  curModel: Accessor<{ vision?: boolean } | undefined>;
  // queue
  enqueue: (
    id: string,
    input: {
      text: string;
      attachments: Attachment[];
      sendConfig: QueueConfig;
      attemptId?: string;
      intentId?: string;
      // Queue-policy B2: the gesture's tap-captured dispatch policy,
      // threaded onto the admission request (absent = no explicit policy).
      dispatchPolicy?: SendDispatchPolicy;
    },
  ) => Promise<{ id?: string } | unknown>;
  // Authoritative queue list (queue.ts fetchQueue) — injected for the
  // reconcile-first recovery path when an enqueue response is lost
  // (send-reliability slice 2). Resolves null when the list could not be
  // fetched in time (queue.ts bounds the GET; hygiene micro-slice §8 6a) —
  // null means "list unavailable", never "empty list".
  fetchQueue: (id: string) => Promise<QueuedMessage[] | null>;
  // Slice 3 (intent recovery, 2026-10-03 incident): true while the lifecycle
  // snapshot says OpenCode is DOWN (down_since set — the daemon OBSERVED the
  // death; web/src/opencode-lifecycle.ts, S1/S2 down-state knowledge). While
  // down, a /oc proxy 502 is explained by the death, so the failure copy says
  // so instead of a generic upstream error. Optional on purpose: absent (or
  // false) keeps every failure path byte-identical to the pre-slice behavior
  // (regression-pinned by the non-down tests).
  opencodeDown?: Accessor<boolean>;
  // Slice 3 (intent recovery): records a terminal outcome for a RETRIED queue
  // item — same shape as the drainer's resolve dep (queue.resolveQueued).
  // Optional: absent refuses the retry loudly (nothing would record the
  // outcome of the re-dispatch).
  resolveQueued?: (
    sessionId: string,
    itemId: string,
    state: "sent" | "failed" | "unknown",
    detail: string,
  ) => Promise<unknown>;
  // G2 custody-bypass fix (2026-10-27, annex-2 §2 + b-F1): the
  // dispatch-ownership TRI-STATE read (lib/queueDispatchMode's dispatchMode —
  // the same two switches as the drainer's observeOnly gate, read as
  // "modern" | "legacy-confirmed" | "unknown"). "modern" = a live daemon
  // custody owner holds this project's queue → the browser must NEVER
  // direct-POST prompt_async around it. "legacy-confirmed" = the last
  // completed /vh/version probe returned a parseable body and no switch says
  // modern (including the capability-ABSENT shape — a genuine legacy daemon)
  // → the retry proceeds. "unknown" = the mode could not be established
  // (every probe failed, or none completed yet) → NOT permission to POST
  // (b-F1: false capability is absence of evidence, not legacy evidence).
  // OPTIONAL: absent keeps the retry path byte-identical to the pre-fix
  // behavior (minimal harnesses; legacy daemon-off servers).
  dispatchMode?: () => DispatchMode;
  // Paired LIVE refresh of the ownership signal (lib/queueDispatchMode's
  // refreshDispatchMode — same signature as createQueueSync's dep). Awaited
  // INSIDE the retry window before any dispatch: the capability probe can
  // still be in flight at click time (boot race), so the click-time snapshot
  // alone could read a stale value — the refresh + tri-state re-check closes
  // that window AND refuses when the refresh itself cannot establish the
  // mode (a failed probe downgrades dispatchMode() to "unknown"). OPTIONAL
  // (absent = no refresh; the tri-state read is then only as fresh as the
  // last completed probe).
  refreshDispatchMode?: () => Promise<void>;
  // Queue-policy slice B2 (2026-10-29 amendment): true while the server
  // advertises queueDispatchPolicyVersion (the policy scheduler is ACTIVE —
  // the same enablement as daemon dispatch). Gates the gesture policy
  // capture: under the capability a BUSY gesture carries an explicit
  // dispatchPolicy ("now" from the Send now button / chip escalation,
  // "queue" from the Queue button or the Enter safe default) and the busy
  // composer's queueMode gate is superseded by the explicit button table
  // (amendment §2). Absent (or false) keeps every legacy behavior
  // byte-for-byte — no policy member is ever stamped without the capability.
  // OPTIONAL: minimal harnesses omit it (reads as not-capable).
  queuePolicyCapable?: () => boolean;
  // Queue-policy B2: the pending-chip Send-now escalation seam (queue.ts
  // escalateQueued — POST /vh/queue/{itemId}/escalate). The controller owns
  // the gesture guard + error mapping; this dep keeps the factory free of
  // network state (the enqueue/fetchQueue discipline). OPTIONAL: absent
  // refuses the escalation loudly (nothing to call).
  escalate?: (sessionId: string, itemId: string) => Promise<EscalateQueuedOutcome>;
  // Send-net-resilience slice 3: the IndexedDB outbox seam (see
  // SendOutboxDeps). Optional — absent keeps the pre-slice admission path
  // byte-intact (minimal unit harnesses); production ChatView always wires
  // lib/outbox's real implementation.
  outbox?: SendOutboxDeps;
  // True while an attachment upload is in flight (createAttachments'
  // `uploading`) — admission blocks on it (no partial send).
  uploading: Accessor<boolean>;
  // sending guard (sync store)
  isSending: (key: string) => boolean;
  setSending: (key: string, v: boolean) => void;
  // scroll intent latch
  userScrolledUp: Accessor<boolean>;
  jumpToLatest: () => void;
  // prompt history
  pushHistory: (text: string, sessionId: string) => void;
  resetHistory: () => void;
  // notifications
  pushNotification: (n: Omit<Notification, "id" | "time" | "read">) => void;
  // /undo /redo (existing-session turn revert/unrevert)
  undo: () => void;
  redo: () => void;
  // attachments (from the createAttachments controller)
  attachments: Accessor<Attachment[]>;
  setAttachments: Setter<Attachment[]>;
  flushPendingAttachments: (id: string) => Promise<{ failed: Attachment[] }>;
  inlineFiles: Map<string, File>;
  uploadFile: (file: File, id: string) => Promise<Attachment | null>;
  // draft-persistence key helper (pure; injected so the factory owns no ChatView-local symbol)
  draftKey: (sid: string) => string;
};

// Queue-policy B2 (amendment §3): the per-item dispatch policy captured from
// an explicit gesture. "now" = deliberate immediate dispatch (bypasses the
// S2 subtree-idle gate at the DAEMON; custody/fencing/journaling unchanged);
// "queue" = strictly respects the interim gate. Absence (undefined) = the
// pre-policy default — idle gestures and every legacy-mode gesture.
export type SendDispatchPolicy = "now" | "queue";

export type SendController = {
  send(): Promise<void>;
  // Queue-policy B2: the busy composer's explicit-gesture entry (Queue /
  // Send now buttons). The policy is captured BEFORE any async preparation
  // (snapshot-once, like the agent resolution) and threaded through the
  // prepared payload, the outbox gesture save, and the admission request.
  // Refuses loudly when the capability is absent (never a silent now→queue
  // degradation — the G3 posture applied to the FE gesture).
  sendPolicy(policy: SendDispatchPolicy): Promise<void>;
  // Queue-policy B2: the pending-chip Send-now escalation (the amendment's
  // one policy-immutability exception; the server cancel+re-admits under a
  // FRESH id). Explicit user action only.
  escalateQueuedItem(sessionId: string, item: QueuedMessage): Promise<void>;
  // Guarded SendStatus row-retry entry (sending-UX O2 defect fix, RECORD-
  // ADDRESSED per the O2 slice-1 review A-F1): takes the DISPLAYED row's
  // attemptId, revalidates that exact record at click time, and replays ITS
  // stored verbatim payload under ITS attemptId — or refuses loudly. See
  // retrySameMessage below for the exact eligibility/refusal semantics.
  retrySameMessage(attemptId: string): Promise<void>;
  // Slice 3 (intent recovery): guarded QUEUE-ITEM retry — re-POSTs an
  // outcome-UNKNOWN item's IDENTICAL dispatch payload under its claim-minted
  // opencodeMsgID (caller-id-wins on opencode ≥ 1.17.18: no duplicate persist
  // if the first dispatch landed), then records the outcome (the resolve
  // matrix's allowed unknown→sent edge). `failed` items are refused. Explicit
  // user-driven only (QueueChip Retry button); NEVER automatic.
  retryQueuedItem(sessionId: string, item: QueuedMessage): Promise<void>;
  resendText(text: string, sessionId: string): Promise<boolean>;
  dispatchQueuedItem(
    sessionId: string,
    item: QueuedMessage,
    signal: AbortSignal,
  ): Promise<DrainOutcome>;
};

export function createSend(deps: SendDependencies): SendController {
  // buildParts reads the Attachment type + isInlineChipUrl from the inline-
  // attach lib. The attachment STATE + the pipeline (addFiles/remove/reinsert/
  // flush/upload) live in createAttachments; send()/sendText() read them via
  // the injected `attachments`/`setAttachments` deps here.
  function buildParts(text: string, atts?: Attachment[]): any[] {
    // The backend ALWAYS serializes QueueItem.Attachments as an array:
    // pkg/web/queue.go declares the field non-omitempty
    // (`json:"attachments"`), Enqueue normalizes nil→[] before persist, and
    // legacy on-disk items with nil/omitted attachments are normalized to [] on
    // load. So a queued item arrives with attachments as an array (possibly
    // empty), never `undefined`. The `atts ?? []` below is now defensive only —
    // kept because the param is optional and the guard costs nothing, not
    // because the queue contract can deliver undefined.
    const parts: any[] = [];
    if (text) parts.push({ type: "text", text });
    for (const a of atts ?? []) {
      // S4: EXCLUDE synthetic inline chips (url = vh-attach:<localId>). Inline
      // attachments are represented in the TEXT (their token was substituted
      // with the real path at send); emitting them here would double-send a
      // bogus file part whose url is not a real file:// path. Real uploaded
      // inline images (vision mode) were added to attachments() at send with
      // real file:// urls, so they pass this guard and become file parts.
      if (isInlineChipUrl(a.url)) continue;
      parts.push({ type: "file", url: a.url, filename: a.filename, mime: a.mime });
    }
    return parts;
  }

  // The model/agent/variant to send with — the per-session selection, captured
  // so a queued message keeps the config it was composed with. The agent is
  // threaded in EXPLICITLY (never re-read here): the caller resolved it ONCE
  // (send() snapshots the tap-time display value, or the first valid
  // resolution for a pending tap; the queued legacy path re-gates), and this
  // snapshot is the exact agent the composer displayed at send time.
  function captureConfig(id: string, agent?: string): QueueConfig {
    const s = deps.selectionFor(id);
    return { providerID: s?.providerID, modelID: s?.modelID, variant: s?.variant, agent: agent || undefined };
  }

  // Build + POST a prompt with explicit parts and send config (shared by direct
  // sends and queued auto-sends). prompt_async forks the turn and returns 204 at
  // once, so prompt ACCEPTANCE is asynchronous — the caller is never blocked on
  // a reply. This is NOT a "can never hang" guarantee: on the queued path the
  // drainer bounds each dispatch with a 12s AbortController
  // (DEFAULT_DISPATCH_TIMEOUT_MS, web/src/queueDrain.ts); on timeout the claimed
  // item is classified `unknown` (never auto-retried — the POST may have reached
  // OpenCode). Outcomes arrive via the event feed, not the POST response.
  // NOTE: normal prompts are now enqueued first (sendText) and dispatched by the
  // drainer via dispatchQueuedItem; only shell still uses dispatchSend directly.

  // Send a normal prompt via the backend-authoritative durable queue
  // (enqueue-first). This function ONLY acquires durable custody: it enqueues
  // (bounded wait) and returns true on confirmation, false on failure. It MUST
  // NOT clear the composer — clearing is the caller's responsibility, subject to
  // an ownership guard. This separation fixes two reachable bugs:
  //   (1) retry() reuses sendText() to resend an OLD message; if sendText
  //       cleared the composer it would erase a NEW draft the operator is
  //       typing. retry()'s caller does not own the composer, so it simply
  //       does not clear.
  //   (2) A slow enqueue (up to 12s) leaves the composer editable; if sendText
  //       unconditionally cleared after the await it could erase text/attachments
  //       entered AFTER Send was pressed. send() captures an ownership snapshot
  //       before calling and clears ONLY if the composer still holds that exact
  //       state (see send()).
  // The drainer (createQueueDrainer) later claims + dispatches the enqueued
  // item through dispatchQueuedItem and owns the `isSending` guard for the
  // duration of that dispatch — so this function MUST NOT touch setSending
  // here (setting it during enqueue would block the drain effect, stalling the
  // just-enqueued item in `pending` until a later queueFor/working transition
  // re-arms the drain). Duplicate enqueue on a rapid re-tap is PREVENTED one
  // layer up: send() runs its WHOLE admission (agent gate + uploads + this
  // call) inside runSendSingleFlight (per-session single-flight, engaged at
  // tap), so a re-tap during that window is dropped instead of spawning a
  // parallel enqueue. The no-loss invariant is preserved either way — a
  // visible duplicate was always preferred over any chance of silent loss
  // (operator policy); single-flight removes the duplicate without ever
  // risking loss.
  // D1 (round 2): the enqueued attachment set is OWNERSHIP-decided, never a
  // bare live-array read. The caller threads a per-object identity set
  // (send(): the tap-time set; resendText(): empty — a retry is text-only by
  // construction), and the enqueue carries exactly the owned objects STILL
  // PRESENT at enqueue time (intersection with the live array, computed as
  // late as possible). Attachments added during the agent-gate/flush/upload
  // waits are therefore excluded from the send, and an explicit operator
  // removal during those waits is honored — the removed object is simply no
  // longer present to intersect.
  // One logical send attempt's thread-through: stable identity + (on retry)
  // the retained payload to reuse verbatim. `tapText` is the raw tap-time
  // composer text (the retry-matching key recorded in the payload snapshot).
  // `policy` (queue-policy B2) is the tap-captured dispatch policy threaded
  // into the payload snapshot, the outbox gesture save, and the admission
  // request — retries reuse it via the retained payload (fingerprint-stable).
  type SendAttemptRef = {
    attemptId: string;
    tapText: string;
    reuse?: PreparedSendPayload;
    policy?: SendDispatchPolicy;
  };

  // Typed admission-failure classification (send-reliability slice 2). The OLD
  // "nothing was persisted" assumption after a failed enqueue is UNSAFE under
  // response loss: a timeout/network failure (or an ambiguous 2xx) may have
  // been admitted server-side. So: definitive HTTP errors classify by code,
  // and response-less failures RECONCILE FIRST (an authoritative list showing
  // an item admitted under our attemptId proves custody after all) before
  // being recorded as outcome-unknown.
  //
  // NOTIFICATION DEDUP (sending-UX O2 slice 1 — single-owner rule): every
  // typed-attempt branch below FIRST writes the durable-for-this-view action
  // record (with a typed `reason` where the O2 copy matrix defines
  // reason-specific row copy), and the matching notification-history entry is
  // SUPPRESSED — the SendStatus row is the one persistent owner of the fact.
  // The no-attempt legacy branch keeps its notification (no retained owner
  // exists to adopt the fact). Honesty rule: a covered notification is removed
  // ONLY after its unique reason/advice is readable in the owning row.
  async function classifyAdmissionFailure(
    e: unknown,
    id: string,
    attempt: SendAttemptRef | undefined,
    composedText: string,
  ): Promise<boolean> {
    const err = e instanceof EnqueueError ? e : undefined;
    if (attempt && err?.code === "queue_admission_conflict") {
      // Same attemptId, changed payload — an explicit conflict state, never
      // retry-forever. Immutable attempts make this unreachable in the normal
      // flow; surface it if state ever diverges. The row copy ("Queue status
      // conflict — check the queue.") carries the check-queue advice, so no
      // duplicate notification (O2 dedup).
      updateSendAction(attempt.attemptId, {
        stage: "conflict", certainty: "definitive", recovery: "check",
        detail: `admission conflict: ${err.message}`,
        conflictSource: "admission",
      });
      log.error("send", "enqueue admission conflict", { id, err: err.message });
      return false;
    }
    if (attempt && err?.code === "queue_admission_full") {
      // 429 = hard user-visible error, no retry. The row's queue-full reason
      // copy carries the capacity/removal advice ("Remove a queued message
      // before trying again.") — the notification would duplicate it (O2 dedup).
      updateSendAction(attempt.attemptId, {
        stage: "rejected", certainty: "definitive", recovery: "restore", detail: err.message,
        reason: "queue-full",
      });
      log.error("send", "enqueue rejected: queue full", { id, err: err.message });
      return false;
    }
    if (attempt && err && err.status !== undefined) {
      // Any other non-2xx WITH a response from the local worker server is a
      // definitive rejection (this is NOT the /oc upstream proxy). The typed
      // attempt's rejected row (detail tooltip + fallback copy) owns the fact;
      // only the no-attempt legacy branch below still notifies (O2 dedup).
      updateSendAction(attempt.attemptId, {
        stage: "rejected", certainty: "definitive", recovery: "restore", detail: err.message,
      });
      log.error("send", "enqueue failed", { id, err: err.message });
      return false;
    }
    if (attempt) {
      // Response-less failure (timeout / network / ambiguous 2xx): the
      // admission outcome is UNKNOWN — never "failed, safe to resend".
      // Reconcile-first: a fresh authoritative list showing an item admitted
      // under our gesture id (either wire alias — slice-1 servers echo
      // attemptId, slice-3 sends the same value as intentId) proves durable
      // custody after all.
      let confirmed: QueuedMessage | undefined;
      try {
        const items = await deps.fetchQueue(id);
        // items === null: the bounded list GET timed out / failed — no answer.
        // Stay uncertain (confirmed stays undefined); never treat null as an
        // empty authoritative list.
        confirmed = items?.find((it) => it.attemptId === attempt.attemptId || it.intentId === attempt.attemptId);
      } catch {
        /* list unavailable — stay uncertain */
      }
      if (confirmed) {
        finishSendAttempt(attempt.attemptId); // admitted after all; the item is authority
        if (confirmed.id && deps.outbox) void deps.outbox.markAdmitted(attempt.attemptId, confirmed.id);
        return true;
      }
      updateSendAction(attempt.attemptId, {
        stage: "uncertain", certainty: "unknown", recovery: "retry-same",
        detail: err?.message ?? String(e),
      });
      log.error("send", "enqueue outcome unknown (reconcile did not confirm)", { id, err: String(e) });
      // The row owns the fact: "Queue confirmation unknown." + the guarded
      // Retry-same-message affordance + its guidance. The old notification's
      // blanket "pressing Send again re-sends the same message" instruction
      // was too broad after composer edits — the guarded row action is the
      // honest replacement (O2 dedup).
      return false;
    }
    // No attempt context: preserve the legacy contract exactly — there is no
    // retained row to own the fact, so the notification STAYS (uncovered
    // fallback; currently defensive-only, every caller threads an attempt).
    log.error("send", "enqueue failed", { id, err: String(e) });
    deps.pushNotification({
      kind: "error", sessionID: id, title: "Could not queue message", detail: composedText.slice(0, 120),
    });
    return false;
  }

  async function sendText(
    text: string,
    id: string,
    agent?: string,
    owned?: Set<Attachment>,
    attempt?: SendAttemptRef,
  ): Promise<boolean> {
    const ownedNow = () =>
      owned ? deps.attachments().filter((a) => owned.has(a)) : deps.attachments();
    // Admission guard: refuse an EMPTY send. REUSE-AWARE (O2 deferred C-F1/
    // D-F1 fix): the guarded row-retry (retrySameMessage branch b) threads an
    // EMPTY ownership set — it deliberately owns none of the composer state —
    // so the live intersection is empty BY CONSTRUCTION and an attachment-only
    // stored payload (empty text) tripped this guard: the Retry was silently
    // inert (no enqueue, no notification). When a reuse payload is present,
    // emptiness is decided against THE PAYLOAD's attachments (the verbatim
    // replay set — exactly what the next line enqueues), never the live
    // composer read. The non-reuse path is unchanged.
    const atts = attempt?.reuse ? attempt.reuse.attachments : ownedNow();
    if ((!text && atts.length === 0) || !id) return false;
    // An existing-session prompt MUST carry an agent: the SENDER stamps it and
    // every later message inherits it. An empty/omitted agent would let
    // opencode resolve the omitted field to its config default_agent server-
    // side — the silent-flip path (2026-08-16 / 2026-08-26 incidents). Refuse
    // loudly instead; the caller keeps the composed text. With a typed attempt
    // the rejected row (reason "agent-unresolved") owns the refusal — the
    // notification survives only for the no-attempt caller (O2 dedup).
    if (!agent) {
      log.error("send", "sendText refused: no resolved agent", { id });
      if (attempt) {
        updateSendAction(attempt.attemptId, {
          stage: "rejected", certainty: "definitive", recovery: "restore",
          detail: "no resolved agent", reason: "agent-unresolved",
        });
      } else {
        deps.pushNotification({
          kind: "error", sessionID: id, title: "Not sent — agent unresolved",
          detail: "No agent evidence for this session; pick an agent before sending.",
        });
      }
      return false;
    }
    // IMMUTABLE PREPARED ATTEMPT (send-reliability slice 2): a retry of an
    // uncertain admission reuses the RETAINED payload verbatim (same text,
    // same attachment objects, same captured config) under the SAME attemptId
    // — no re-captured config, no re-resolved text, no re-upload. A fresh
    // attempt captures its payload ONCE here (as late as possible, honoring
    // D1) and records it on the action store so a later retry can reuse it.
    let input: { text: string; attachments: Attachment[]; sendConfig: QueueConfig };
    if (attempt?.reuse) {
      input = {
        text: attempt.reuse.text,
        attachments: attempt.reuse.attachments,
        // Captured payloads always carry a config (captureConfig is total);
        // `|| {}` only satisfies the enqueue input's non-optional field.
        sendConfig: attempt.reuse.sendConfig || {},
      };
    } else {
      // Always capture a model. OpenCode rejects a prompt with no model. If models
      // haven't loaded, fetch once before enqueue so the persisted queue item
      // carries a valid sendConfig.
      if (!deps.selectionFor(id) && deps.models().length === 0) await deps.loadModels();
      const config = captureConfig(id, agent);
      // Recompute the intersection AFTER the loadModels await: "still present
      // at enqueue" is decided as late as possible (D1).
      input = { text, attachments: ownedNow(), sendConfig: config };
      if (attempt) {
        updateSendAction(attempt.attemptId, {
          payload: {
            tapText: attempt.tapText,
            text: input.text,
            attachments: input.attachments,
            sendConfig: input.sendConfig,
            files: input.attachments.map((a) => a.filename).filter(Boolean),
            // Queue-policy B2: the tap-captured policy joins the immutable
            // prepared attempt (retry-same replays it — fingerprint-stable).
            dispatchPolicy: attempt.policy,
          },
        });
      }
    }
    if (attempt) updateSendAction(attempt.attemptId, { stage: "admitting" });
    // OUTBOX GATE (slice 3, BLK-A3 + debate-4 finding 7, amended 2026-10-09):
    // the gesture is made locally durable BEFORE the admission POST, gated on
    // the IDB transaction COMMIT. Only a committed save may proceed; a storage
    // failure blocks the send (persistent "not saved — copy your text" state,
    // text retained in the composer). The captured head's stale gate runs at
    // RESUME/replacement — see the capture note below (a save-window compare
    // would false-positive on hydration catch-up).
    // Skipped when no attempt context (defensive legacy callers) or no outbox
    // seam (minimal harnesses) — byte-identical to the pre-slice path.
    if (attempt && deps.outbox) {
      const ob = deps.outbox;
      const intentId = attempt.attemptId;
      // Capture ONCE AT TAP (debate-4 finding 7, as amended 2026-10-09: the
      // context the OPERATOR saw when composing) and persist it with the
      // gesture. The COMPARE runs at RESUME (the outbox reconcile's
      // re-admission gate — where the message actually sat unsent while the
      // conversation could move on; a changed head surfaces a visible blocked
      // row, never an auto-send) and for replacement sends (the chip's inline
      // confirmation + the controller's re-verify); NOT inside this one
      // continuous gesture: a save-window compare would trip on innocent
      // hydration catch-up (the agent-gate parked-send class — the transcript
      // legitimately fills in during the async window; that is not "the
      // conversation moved on"). An unknowable tap head (transcript not yet
      // resident) never fabricates staleness downstream.
      const tapHead = ob.captureHead(id);
      const save = await ob.save({
        intentId,
        sessionId: id,
        payload: {
          text: input.text,
          attachments: input.attachments.map((a) => ({
            url: a.url,
            filename: a.filename,
            mime: a.mime,
            path: a.path,
          })),
          sendConfig: input.sendConfig,
          // Queue-policy B2: the durable gesture carries the tap-captured
          // policy so IDB replay / reconcile / failed-save recovery re-admits
          // under the SAME policy (the admission fingerprint includes it).
          dispatchPolicy: attempt.policy,
        },
        capturedHead: tapHead,
      });
      if (!save.ok) {
        // BLK-A3: NEVER proceed on an uncommitted local save — block before
        // admission. The outbox module armed the blocking banner with the
        // retained payload; the caller keeps the composer text (this returns
        // false before any composer change).
        updateSendAction(intentId, {
          stage: "blocked", certainty: "definitive", recovery: "restore",
          detail: `outbox save failed: ${save.reason}`, reason: "storage-unavailable",
        });
        log.error("send", "outbox save failed — send blocked before admission", { id, reason: save.reason });
        return false;
      }
    }
    let admittedItem: { id?: string } | unknown;
    try {
      admittedItem = await deps.enqueue(
        id,
        attempt
          ? {
              ...input,
              attemptId: attempt.attemptId,
              intentId: attempt.attemptId,
              // Queue-policy B2: the gesture's dispatch policy on the
              // admission request (JSON drops undefined — legacy/Idle
              // gestures carry no member, wire bytes unchanged).
              dispatchPolicy: attempt.policy,
            }
          : input,
      );
    } catch (e) {
      // Enqueue failed or its response was lost — typed classification with
      // reconcile-first (see classifyAdmissionFailure). The composed text +
      // attachments are preserved by the caller (no silent loss).
      return classifyAdmissionFailure(e, id, attempt, text);
    }
    // Durable custody confirmed — the queue item is now the authority. Drop
    // the action record (Slice 3 renders the chip, not the action) and link
    // the outbox gesture to its item (best-effort; a failed link write never
    // fails the send — the server owns custody now).
    if (attempt) {
      finishSendAttempt(attempt.attemptId);
      const itemId = (admittedItem as { id?: string } | null | undefined)?.id;
      if (itemId && deps.outbox) void deps.outbox.markAdmitted(attempt.attemptId, itemId);
    }
    // The caller decides whether to clear the composer (and only if it still
    // owns the submitted state). This function does not touch
    // setInput/setAttachments.
    return true;
  }

  // Auto-drain the queue: when the session is idle and has queued messages,
  // CLAIM the oldest pending item (the atomic cross-client boundary — only one
  // browser wins), send it, then RESOLVE the outcome. The single-flight
  // `draining` flag and the per-session sending-guard lifecycle live in the
  // extracted createQueueDrainer so they can be unit-tested in isolation
  // (the setSending-leak regression: the finally MUST release the sending guard
  // or items 2..N stall in pending). No silent retry: a definitive rejection is
  // recorded as `failed`; an ambiguous interruption as `unknown`. Neither ever
  // returns to `pending`.
  //
  // dispatchQueuedItem (below) holds the actual POST + outcome classification +
  // scroll/notification side effects; the drainer only owns the lifecycle shell.
  // The config-fallback (use the item's captured sendConfig when it is complete
  // — provider + model + AGENT — else re-resolve through the agent evidence
  // gate and re-capture from the live selection) lives HERE now — it was
  // previously in ChatView's drainer dispatch closure; moving it in aligns
  // this method's signature with queueDrain.ts's `dispatch` dep
  // `(id, item, signal) => Promise<DrainOutcome>`.
  // The internal 4th parameter (prePostGuard) is the G2 custody-bypass seam:
  // evaluated AFTER every await in this function (the agent-evidence gate is
  // the only one) and IMMEDIATELY before the prompt_async POST. It exists so
  // retryQueuedItem can abort a retry whose dispatch ownership flipped to the
  // daemon mid-await — the drainer never passes it (absent = byte-identical
  // legacy dispatch; the exported SendController type keeps the 3-arg
  // signature, so this stays a createSend-internal seam).
  async function dispatchQueuedItem(
    id: string,
    item: QueuedMessage,
    signal: AbortSignal,
    prePostGuard?: () => boolean,
  ): Promise<DrainOutcome> {
    // The item's captured sendConfig is honored only when COMPLETE (provider +
    // model + agent). A LEGACY item persisted without an agent (or a capture
    // that lost it) must NOT dispatch with an omitted agent — opencode would
    // resolve the omission to its config default (the silent flip). Instead
    // re-resolve through the evidence gate. A PRE-POST gate failure (timeout /
    // no evidence) never terminally classifies the item `unknown`: nothing was
    // POSTed, so it is NOT POST-ambiguous — it fails with an explicit
    // pre-POST detail (dismissable / retract-to-compose; `failed` never
    // repends, so there is no auto-retry risk). The wrong-agent protections
    // are untouched: the gate still refuses to send without evidence.
    const captured =
      item.sendConfig?.providerID && item.sendConfig?.modelID && item.sendConfig?.agent
        ? (item.sendConfig as QueueConfig)
        : null;
    let config: QueueConfig;
    if (captured) {
      config = captured;
    } else {
      // Bounded well under the drainer's 12s AbortController budget so a
      // settled gate leaves real POST headroom (QUEUED_DISPATCH_GATE_TIMEOUT_MS).
      const ag = await deps.awaitAgent(id, { signal, timeoutMs: QUEUED_DISPATCH_GATE_TIMEOUT_MS });
      if (!ag.ok) {
        const msg = `pre-POST gate: agent unresolved (${ag.reason}) — nothing was sent`;
        log.error("send", "queued dispatch aborted: agent unresolved", { id, itemId: item.id, reason: ag.reason });
        // O2 single-owner dedup: the item is terminally classified `failed`
        // with this detail and the QueueChip renders the cause VISIBLY (the
        // .queue-detail-note) — the notification-history entry would be a
        // second persistent claim of the same fact.
        return { state: "failed", detail: msg };
      }
      config = captureConfig(id, ag.agent);
    }
    // G2 custody guard, LAST check: runs after every await above (the agent
    // gate is the only one) and immediately before the POST. A capability
    // flip that landed during that await must not produce a POST from the
    // caller's stale legacy snapshot. guardRefused marks the outcome as
    // "nothing was sent, do not resolve" — the retry caller refuses loudly
    // instead of recording a dispatch that never happened.
    if (prePostGuard && !prePostGuard()) {
      const msg = "pre-POST custody guard: queue dispatch is daemon-owned — nothing was sent";
      log.error("send", "queued dispatch aborted: custody flipped to the daemon pre-POST", { id, itemId: item.id });
      return { state: "failed", detail: msg, guardRefused: true };
    }
    const body: any = { parts: buildParts(item.text, item.attachments) };
    // Unconditional: every dispatched prompt carries an explicit agent string
    // (the gate above guarantees a non-empty one) — never omitted.
    body.agent = config.agent;
    if (config.providerID && config.modelID) {
      body.model = { providerID: config.providerID, modelID: config.modelID };
      if (config.variant) body.variant = config.variant;
    }
    // Thread the backend-minted OpenCode correlation id (Slice 5) into the
    // prompt_async body as `messageID`. On v1.17.18 this is caller-id-wins
    // (input.messageID ?? MessageID.ascending()): OpenCode persists the
    // dispatched user message with this EXACT id, so a later exact
    // GET /session/:sid/message/:mid can reconcile delivered-but-stuck items.
    // Including it is safe (optional field); only set when present so legacy
    // in-flight items without it dispatch unchanged.
    if (item.opencodeMsgID) body.messageID = item.opencodeMsgID;
    if (!deps.userScrolledUp()) deps.jumpToLatest();
    try {
      const res = await fetch(`/oc/session/${encodeURIComponent(id)}/prompt_async`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (res.ok) return { state: "sent", detail: "" };
      // Definitive rejection (non-2xx) — failed, never re-enqueue. EXCEPT the
      // proxy-502 shape (send-reliability slice 2): the catch-all /oc proxy
      // answers 502 on TRANSPORT failure to OpenCode (pkg/web/server.go), so
      // a 502 does NOT prove the dispatch failed to reach the upstream — the
      // POST may have been applied. Classify outcome-unknown, never failed:
      // "failed" is reserved for rejections that prove non-delivery.
      let detail = "";
      try { detail = (await res.text()).slice(0, 300); } catch {}
      if (res.status === 502) {
        if (deps.opencodeDown?.()) {
          // Slice 3 (intent recovery, 2026-10-03 incident): the daemon
          // OBSERVED the OpenCode death (down_since set), so this 502 is
          // explained by the down state — say so instead of the generic
          // proxy error. State stays `unknown` (NOT `failed`): (a) the
          // dying-mid-POST corner means delivery cannot be strictly
          // excluded, and (b) the server resolve matrix only allows
          // unknown→sent (pkg/web/queue.go Resolve) — a `failed` item could
          // never record the retry's success.
          //
          // PROMINENCE EXCEPTION (deliberate O2 single-owner deviation, incident
          // finding): the quiet unknown chip ALONE was missed during the
          // incident, so the down-tied failure ALSO fires ONE notification per
          // failed dispatch. The chip remains the durable owner of the fact
          // (Retry / mark-sent / dismiss live there); the notification is the
          // attention cue only. Non-down 502s keep the suppressed chip-only
          // behavior byte-for-byte.
          log.error("send", "queued POST hit proxy 502 while OpenCode down", { id, itemId: item.id, detail });
          deps.pushNotification({
            kind: "error", sessionID: id,
            title: "Message not sent — OpenCode is down",
            detail: `${DOWN_NOT_SENT_DETAIL}. Retry it after OpenCode recovers.`,
          });
          return { state: "unknown", detail: DOWN_NOT_SENT_DETAIL };
        }
        const msg = detail || "proxy 502";
        log.error("send", "queued POST hit proxy 502 (outcome unknown)", { id, itemId: item.id, detail: msg });
        // O2 single-owner dedup: the unknown QueueChip visibly carries the
        // detail AND the standing check-transcript instruction (the dispatch
        // may have been delivered) — the covered notification is suppressed.
        return { state: "unknown", detail: `proxy 502 (outcome unknown): ${msg}` };
      }
      const msg = detail || `HTTP ${res.status}`;
      log.error("send", "queued POST rejected", { id, itemId: item.id, status: res.status, detail: msg });
      // O2 single-owner dedup: the failed QueueChip visibly carries the cause
      // (.queue-detail-note) — no duplicate persistent claim in history.
      return { state: "failed", detail: msg };
    } catch (e) {
      // Abort/timeout or network interruption — ambiguous, NEVER repend. The
      // POST may have reached OpenCode (a late/non-response socket looks
      // identical to one that never accepted the bytes), so re-dispatch risks
      // a duplicate and is explicitly forbidden by the operator's no-retry
      // policy. Classify as `unknown`; the queue chip persists the text +
      // attachment metadata until the operator dismisses it (and visibly owns
      // the detail + check-transcript instruction — O2 single-owner dedup).
      const aborted = signal.aborted || (e instanceof DOMException && e.name === "AbortError");
      const msg = aborted ? "dispatch timed out" : String(e);
      log.error("send", "queued POST threw", { id, itemId: item.id, aborted, err: msg });
      return { state: "unknown", detail: msg };
    }
  }

  // POST a prompt/shell command and decide success WITHOUT waiting out the whole
  // turn. prompt_async returns 204 at once; /shell still buffers until the turn
  // *settles* — fast for a rejection (4xx/5xx arrive immediately) but possibly
  // minutes for a real turn, or never if it hangs. So: surface a fast failure
  // (caller restores the composer text), but once the request has clearly been
  // accepted, release the per-session guard and let the reply stream in via the
  // event feed — never freeze the composer on a long/hung turn. The fetch keeps
  // running in the background to clear the guard and
  // report any late error.
  function dispatchSend(
    key: string,
    id: string,
    url: string,
    body: any,
    failTitle: string,
  ): Promise<boolean> {
    const post = fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (!res.ok) {
          let detail = "";
          try {
            detail = (await res.text()).slice(0, 300);
          } catch {}
          log.error("send", "POST failed", { id, url, status: res.status, detail });
          // Slice 3 (intent recovery): while OpenCode is down (daemon-
          // observed, down_since set), a proxy 502 gets the down-tied copy
          // instead of the generic upstream error. The composer restore in
          // send()'s shell branch already preserves the text — re-sending
          // after recovery is the operator's explicit action (no auto-retry).
          const down = res.status === 502 && (deps.opencodeDown?.() ?? false);
          deps.pushNotification({
            kind: "error", sessionID: id, title: failTitle,
            detail: down ? "OpenCode is down — command not sent" : detail || `HTTP ${res.status}`,
          });
          return false;
        }
        log.debug("send", "accepted", { id, url });
        return true;
      })
      .catch((e) => {
        log.error("send", "POST threw", { id, url, err: String(e) });
        deps.pushNotification({ kind: "error", sessionID: id, title: failTitle, detail: String(e) });
        return false;
      })
      .finally(() => deps.setSending(key, false));

    // Race the request against a short grace period. A fast settle (error, or a
    // quick turn) resolves first and we honor it; otherwise the turn is running
    // — treat it as accepted, free the composer, and let `post` finish later.
    const ACCEPTED_AFTER_MS = 2500;
    return Promise.race([
      post,
      new Promise<boolean>((resolve) =>
        setTimeout(() => {
          deps.setSending(key, false);
          resolve(true);
        }, ACCEPTED_AFTER_MS),
      ),
    ]);
  }

  // Leading "!" runs a shell command in the session instead of prompting.
  // Shell turns stamp the agent too (sender-stamped, inherited by later
  // messages), so the SAME evidence gate applies: an existing session must
  // never run a shell under the config default. `agent` is normally threaded
  // in from send()'s already-gated resolution; the internal fallback covers
  // any direct call.
  async function runShell(command: string, id: string, agent?: string): Promise<boolean> {
    const key = deps.sessionId() || "draft";
    if (!command || !id || deps.isSending(key)) return false;
    let ag: string | undefined = agent;
    if (!ag) {
      const r = await deps.awaitAgent(deps.sessionId());
      if (r.ok) ag = r.agent;
    }
    if (!ag) {
      // Gate refused — abort before any state change; the caller restores the
      // composer text.
      log.error("send", "runShell aborted: agent unresolved", { id });
      deps.pushNotification({
        kind: "error", sessionID: id, title: "Not sent — agent unresolved",
        detail: "No agent evidence for this session; pick an agent before sending.",
      });
      return false;
    }
    deps.setSending(key, true);
    const body: any = { command };
    // Unconditional — never omit (opencode would fill the config default).
    body.agent = ag;
    const s = deps.selectionFor(id);
    if (s) body.model = { providerID: s.providerID, modelID: s.modelID };
    // Same intent-latch gate as sendParts above: don't yank a reader who
    // deliberately scrolled up. Gated on !userScrolledUp() (the intent latch),
    // not following(), so a transient following=false from a content-shrink
    // clamp still re-glues — only a genuine scroll-up read is preserved (10b).
    if (!deps.userScrolledUp()) deps.jumpToLatest();
    return dispatchSend(key, id, `/oc/session/${encodeURIComponent(id)}/shell`, body, "Shell command failed");
  }

  // Queue-policy B2: the implicit-entry send (Send button / Enter key). Enter
  // while busy under the policy capability defaults safely to QUEUE (the
  // amendment §2 button table's primary action); idle gestures are NEVER
  // stamped — the item admits with absent policy (≡ queue) and dispatches
  // immediately through the idle gate (a busy-race makes it WAIT: the
  // accepted safe default, never a retroactive "now").
  async function send(): Promise<void> {
    // POLICY CAPTURE (snapshot-once, amendment §3): decided from the tree
    // state AT TAP, before any async preparation — later busy/idle
    // transitions never reinterpret it. Without the capability the gesture
    // carries NO policy at all (legacy bytes byte-for-byte).
    const policy =
      deps.queuePolicyCapable?.() && deps.working() ? ("queue" as const) : undefined;
    return runGesture(policy);
  }

  // Queue-policy B2: the explicit-gesture entry (the busy composer's Queue /
  // Send now buttons). The captured policy is exactly the tapped gesture —
  // even if the tree went idle between render and tap (an explicit "now"
  // stays now; "queue" strictly respects the gate and dispatches on idle).
  async function sendPolicy(policy: SendDispatchPolicy): Promise<void> {
    if (!deps.queuePolicyCapable?.()) {
      // Render-gated in production (the buttons only exist under the
      // capability); reaching here means a wiring bug or a capability flip
      // mid-frame. Refuse loudly — never a silent now→queue degradation.
      log.error("send", "sendPolicy refused: queue policy capability absent", {});
      deps.pushNotification({
        kind: "error", sessionID: deps.sessionId(), title: "Not sent — queue policy unavailable",
        detail: "This server does not support Send-now/Queue policies right now; nothing was sent. Retry in a moment.",
      });
      return;
    }
    return runGesture(policy);
  }

  async function runGesture(explicitPolicy?: SendDispatchPolicy): Promise<void> {
    // F1: composer OWNERSHIP snapshot at TAP time — before ANY agent/session
    // wait. A send can spend up to AGENT_RESOLVE_TIMEOUT_MS (10s) in the
    // evidence gate; edits the operator makes during that wait must SURVIVE:
    // the tap-time text is what enqueues, and the composer's text is cleared
    // after enqueue ONLY if it still holds that exact value. Attachments are
    // owned as PER-OBJECT identity: `owned` is the tap-time set, re-
    // intersected with the live array at every decision point (sendText's
    // enqueue, the success clear). It grows ONLY across this send's OWN
    // documented mutations — the draft flush REPLACING pending chips (see the
    // D2 transfer below) and the inline-resolve appending image parts — never
    // across an operator edit: additions made during any wait stay in the
    // composer, and explicit removals are honored (not resurrected).
    const wasDraft = deps.draft();
    // TAP-TIME owner key: draft records are project-scoped (draftOwnerKey),
    // and the project at TAP time is the one this send's records are minted
    // and swept under — a project switch during the (up to 12s) create wait
    // must not strand the in-flight record under the new project's key.
    const tapOwnerKey = wasDraft ? draftOwnerKey(projectDir()) : deps.sessionId();
    const ownedText = deps.input();
    const ownedAtts = deps.attachments();
    const owned = new Set<Attachment>(ownedAtts);
    const text = ownedText.trim();
    // Queue-policy B2 fix (tier1_b-F1/F2, operator option A): shell input
    // ("!") must NEVER ride a policy gesture. A captured policy marks the
    // gesture as one of the three policy entries — the busy-table Queue /
    // Send now buttons (sendPolicy) or Enter-while-busy (send() stamps
    // "queue" exactly when capability + busy held at tap) — and shell input
    // can neither queue ("!" only makes sense against a live shell) nor run
    // while the session is busy. Refuse LOUDLY before ANY state change: one
    // error notice, zero network POSTs, the draft (text + attachments) fully
    // preserved, no attempt/outbox/queue record. Idle Send/Enter carries no
    // captured policy and keeps the historic immediate-shell semantics; with
    // the capability absent every gesture stays policy-free and the legacy
    // path (busy "!" + Enter → immediate shell) is byte-for-byte unchanged.
    if (explicitPolicy && text.startsWith("!")) {
      log.error("send", "policy gesture refused: shell input under the busy policy controls", {});
      deps.pushNotification({
        kind: "error", sessionID: deps.sessionId(),
        title: "Not sent — shell commands aren't available while the session is busy",
        detail:
          "Nothing was sent. \"!\" shell commands run only from the idle composer; wait for the current turn to finish, then send it again.",
      });
      return;
    }
    // O2 C-F1/D-F1 (attachments-only replay): an attachment-only RETRY of a
    // retained uncertain admission is NOT an empty send — the stored payload
    // carries the attachments, and the row's Retry affordance was tapped with
    // explicit intent. PURE lookup, and only in the otherwise-empty case: a
    // genuinely empty tap (no retained retry-same record under this owner)
    // still exits here before ANY state change, exactly as before.
    if (!text && ownedAtts.length === 0) {
      const earlyReuse = findReusableSendAttempt(tapOwnerKey, text);
      if (!earlyReuse?.payload) return;
    }
    // F2: ONE agent capture at tap, through the SAME resolver the composer's
    // agent Select renders. `tapAgent` is either the evidence-backed value
    // the composer DISPLAYED at the tap — sent EXACTLY, never re-resolved,
    // so a later evidence change cannot flip the send — or undefined
    // (pending / unavailable / empty at tap → the bounded gate inside
    // admission waits for the FIRST valid resolution; the composer's
    // pending→resolved transition displays that same first value once it
    // lands). For a DRAFT this snapshot is the config-default policy
    // (legitimate for a genuinely new session) and is ADOPTED as the
    // materialized session's first evidence below. (`wasDraft` was hoisted
    // above the emptiness guard for the O2 reuse-aware early exit.)
    const tapResolution = deps.resolveAgent(deps.sessionId());
    const tapAgent =
      tapResolution.state === "agent" && tapResolution.agent ? tapResolution.agent : undefined;
    // Gate before any state change: if agents/models aren't loaded yet, a send
    // would route through the leak-prone fallback chain (empty agent list) and
    // likely fail. Surface it and preserve the typed text (do NOT clear input).
    // Covers both the Enter-key path and the button click.
    if (!deps.readyToSend()) {
      deps.pushNotification({ kind: "info", sessionID: deps.sessionId(), title: "Still loading…" });
      return;
    }
    // Honor the "Queue messages while busy" setting (finding #4). When the
    // session is busy AND the operator has disabled busy-queuing, pressing
    // Enter (or clicking a stale Send button) must NOT enqueue — it is
    // rejected and the text is preserved, matching the setting's contract:
    // "Off: sending while busy is rejected." The Queue button only renders
    // when queueMode() is on, so this gate primarily catches the Enter-key
    // path that bypasses the button's visibility. With the setting On, a
    // busy send enqueues (the Queue button's purpose) and falls through.
    //
    // Queue-policy B2 (amendment §2): under the policy capability this gate
    // NO LONGER applies to busy sends — the busy composer renders the
    // explicit Queue / Send now button table and Enter defaults to Queue, so
    // the legacy setting no longer gates the busy composer (it stays fully
    // functional for legacy daemon-off deployments).
    if (deps.working() && !deps.queueMode() && !deps.queuePolicyCapable?.()) {
      deps.pushNotification({ kind: "info", sessionID: deps.sessionId(), title: "Busy — turn in progress" });
      return;
    }
    // /undo /redo only make sense for an existing session — synchronous local
    // commands that never enqueue, so they bypass send admission entirely.
    if (!deps.draft() && text === "/undo") { deps.setInput(""); return void deps.undo(); }
    if (!deps.draft() && text === "/redo") { deps.setInput(""); return void deps.redo(); }

    // IMMUTABLE ATTEMPT IDENTITY (send-reliability slice 2): every non-shell
    // send gets ONE stable attempt identity owned by the sendActionStatus
    // store (beside the single-flight guard). A re-tap whose text matches a
    // retained uncertain admission RETRIES that attempt — same attemptId +
    // verbatim payload; the server dedupes admission. Reuse additionally
    // requires the tap-time owned attachment set to be a subset of the
    // retained payload's (identity): an operator who added a chip is composing
    // a NEW message, not retrying. Shell commands ("!") dispatch directly and
    // carry no queue attempt.
    const isShell = text.startsWith("!");
    const attempt: SendAttemptRef | undefined = isShell
      ? undefined
      : (() => {
          const ownerKey = tapOwnerKey;
          const reusable = findReusableSendAttempt(ownerKey, text);
          // attachmentsSubsetOfPayload (NOT a raw includes): the store proxies
          // the retained payload on read, so an inline identity includes is
          // always false for attachment-bearing payloads — see the helper.
          if (reusable?.payload && attachmentsSubsetOfPayload(ownedAtts, reusable.payload)) {
            // Retry of a retained uncertain admission: the ORIGINAL payload's
            // dispatchPolicy rides along (a replay under a changed/missing
            // member would 409 the idempotent admission, never dedupe).
            return {
              attemptId: reusable.attemptId,
              tapText: text,
              reuse: reusable.payload,
              policy: reusable.payload.dispatchPolicy,
            };
          }
          return { attemptId: mintSendAttempt(ownerKey).attemptId, tapText: text, policy: explicitPolicy };
        })();
    // Send-reliability slice 3: a reused attempt IS a retry of a retained
    // uncertain admission — flagged INSIDE admission (moved from send()'s
    // pre-flight position, O2 review a-F1) so the "Retrying queue
    // confirmation…" copy only appears when the single-flight region was
    // actually ACQUIRED; an IGNORED re-tap (a flight already in progress)
    // must not flip the row when nothing is retrying.
    // ADMISSION (F4): everything from here on runs inside the per-session
    // send single-flight, engaged at TAP time — a re-tap during the (up to
    // 10s) agent gate wait is DROPPED (IGNORED) instead of spawning a
    // parallel waiter with duplicate history/enqueue side effects. The
    // history push/reset side effects live INSIDE admission so dropped
    // re-taps never duplicate them. The composer stays EDITABLE throughout
    // (F1's ownership snapshot protects edits made during any wait).
    const admission = async (id: string): Promise<void> => {
      if (attempt?.reuse) updateSendAction(attempt.attemptId, { retry: true });
      // D4 (round 2): pushHistory fires ONLY after successful admission —
      // enqueue confirmed (normal/draft→session path) or the shell POST
      // accepted (shell path); see the success sites below. A gate timeout,
      // an unavailable agent, an upload failure, or an enqueue rejection
      // writes NOTHING to history: the attempted text stays recallable by
      // being preserved in the composer, not by a history entry.
      deps.resetHistory();
      // AGENT EVIDENCE GATE (the silent-flip fix) — F2 snapshot-once:
      //   resolved at tap → send that EXACT displayed value; no re-resolution;
      //   pending at tap  → wait (bounded, AGENT_RESOLVE_TIMEOUT_MS) for the
      //                     FIRST valid resolution and send it;
      //   unavailable     → the gate refuses immediately (pick an agent).
      // On timeout / hydration error / unavailability abort LOUDLY — no
      // enqueue, the composer text is preserved (nothing has been cleared).
      // Drafts resolved synchronously at tap (above); their agent is adopted
      // as the new session's first evidence so the fresh id never pends.
      let sendAgent: string;
      if (wasDraft) {
        if (!tapAgent) {
          log.error("send", "draft send aborted: no agent resolved", { id });
          // POST-MINT TERMINAL DISPOSITION (O2 slice 1 + brief contradiction
          // list): this attempt was already minted, so a bare return would
          // strand its row in "preparing" forever (a stale "Sending…"). The
          // rejected row (reason "agent-unresolved" → "Not sent — choose an
          // agent.") owns the refusal — no duplicate notification. SHELL
          // commands carry NO attempt record, so their refusal keeps the
          // notification (nothing else owns the fact — never leave it
          // homeless).
          if (attempt) {
            updateSendAction(attempt.attemptId, {
              stage: "rejected", certainty: "definitive", recovery: "restore",
              detail: "no agent resolved for the new session", reason: "agent-unresolved",
            });
          } else {
            deps.pushNotification({
              kind: "error", sessionID: id, title: "Not sent — agent unresolved",
              detail: "No agent selected for the new session; pick an agent before sending.",
            });
          }
          return;
        }
        sendAgent = tapAgent;
        deps.adoptDraftAgent(id, sendAgent);
      } else if (tapAgent) {
        sendAgent = tapAgent;
      } else {
        // Bounded (AGENT_RESOLVE_TIMEOUT_MS) and deliberately NOT unmount-
        // cancelled: an orphaned waiter settles on its own timer (bounded,
        // acceptable — review out-of-scope note).
        const ag = await deps.awaitAgent(deps.sessionId());
        if (!ag.ok) {
          log.error("send", "send aborted: agent unresolved", { id, reason: ag.reason });
          // Same post-mint terminal disposition as the draft branch above —
          // the rejected row owns the refusal, never a stale preparing row
          // nor a duplicate notification (O2 single-owner rule). Shell sends
          // (no attempt record) keep the notification — no row exists to
          // adopt the fact.
          if (attempt) {
            updateSendAction(attempt.attemptId, {
              stage: "rejected", certainty: "definitive", recovery: "restore",
              detail: `agent evidence did not arrive (${ag.reason})`, reason: "agent-unresolved",
            });
          } else {
            deps.pushNotification({
              kind: "error", sessionID: id, title: "Not sent — agent unresolved",
              detail: `Agent evidence did not arrive (${ag.reason}); nothing was sent. Retry shortly or pick an agent.`,
            });
          }
          return;
        }
        sendAgent = ag.agent;
      }
      // A draft is materialized into a real session on first send. The composer's
      // explicit model/variant pick was made under the draft key (props.sessionId
      // ""), but captureConfig/sendText below read the live id — carry the pick
      // (and its explicit-pick intent) over so it isn't lost and an agent-declared
      // model can't override it post-migration. No-op for a non-draft send
      // (props.sessionId === id).
      deps.migrateModelPick(deps.sessionId(), id);
      // ATTACHMENT BLOCKING (send-reliability slice 2): an eager live upload
      // still in flight must not produce a partial send (the message would go
      // out without the file). Halt admission before any composer change; the
      // operator re-sends once the upload settles. (Checked BEFORE the flush:
      // the flush itself arms `uploading` while it runs.)
      if (deps.uploading()) {
        if (attempt) {
          updateSendAction(attempt.attemptId, {
            stage: "blocked", certainty: "definitive", recovery: "restore",
            detail: "an attachment upload is still in progress",
            reason: "attachments-uploading",
          });
        } else {
          // SHELL sends carry no attempt row (C-F1, O2 slice-1 review): the
          // blocked row owns the fact only for a typed attempt — a shell send
          // has no retained owner, so the notification is the one honest
          // surface (the agent-gate pattern: if(attempt) row else notify).
          deps.pushNotification({
            kind: "error", sessionID: id, title: "Not sent — attachment still uploading",
            detail: "Wait for the upload to finish, then send again.",
          });
        }
        // The blocked row's reason copy ("Not sent — attachments are still
        // uploading.") carries the wait instruction — no duplicate
        // notification (O2 single-owner rule).
        return;
      }
      // A draft may have queued attachments locally (no session existed at paste
      // time). Now that we have an id, upload them so buildParts sees real urls.
      // D2 (round 2): ownership across the flush is identity-guarded — NO
      // blanket re-baseline (the old unconditional `ownedAtts =
      // deps.attachments()` absorbed any edit made during the await). The real
      // flush (createAttachments.flushPendingAttachments) REPLACES tap-owned
      // pending chips (.file set) with fresh server-backed objects, so
      // ownership must TRANSFER across that replacement for those chips to
      // stay sent — but never across an operator edit. The transfer below
      // verifies the flush's documented output shape positionally
      // ([...prev.filter(a => !a.file), ...resolved]: preserved entries first
      // IN ORDER, fresh outputs at the tail) and adopts the tail ONLY when it
      // is within the replaced-chip count (tail.length <= |removedPending| —
      // the real flush emits at most one fresh object per replaced chip; an
      // uploadFile failure yields a SHORTER tail, never a longer one). ANY
      // ambiguity — unexpected shape, a non-fresh tail entry, an unowned
      // pending chip among the removed, MORE tail entries than replaced chips
      // (a post-tap addition after the flush's own write, e.g. [.., U1, A3]
      // against one removed chip) — adopts NOTHING: the transfer fails
      // closed, because adopting a post-tap addition is the forbidden
      // direction (D2), while dropping a transferred output only occurs in
      // states unreachable from the real controller (the draft composer is
      // unmounted during this await, and a live session's flush is a no-op).
      const preFlush = deps.attachments();
      const flushRes = await deps.flushPendingAttachments(id);
      const postFlush = deps.attachments();
      if (postFlush !== preFlush) {
        const preSet = new Set(preFlush);
        const postSet = new Set(postFlush);
        const preNoFile = preFlush.filter((a) => !a.file);
        let shapeOk = postFlush.length >= preNoFile.length;
        for (let i = 0; shapeOk && i < preNoFile.length; i++) {
          if (postFlush[i] !== preNoFile[i]) shapeOk = false;
        }
        const tail = postFlush.slice(preNoFile.length);
        const tailFresh = tail.every((a) => !preSet.has(a));
        const removedPending = preFlush.filter((a) => a.file && !postSet.has(a));
        const allRemovedOwned = removedPending.every((a) => owned.has(a));
        if (shapeOk && tailFresh && allRemovedOwned && tail.length > 0 && removedPending.length > 0 && tail.length <= removedPending.length) {
          // The bound holds, so the tail is exactly the flush's own
          // replacement set (at most one fresh object per removed chip):
          // adopt it in full.
          for (const a of tail) owned.add(a);
        }
      }
      // ATTACHMENT BLOCKING (send-reliability slice 2): owned pending chips
      // whose flush upload FAILED are retained in place (flagged
      // `uploadFailed`, never silently dropped) and BLOCK admission here —
      // the message must not be partially admitted without its files. The
      // chips stay in the composer; the operator removes or retries them.
      // (Unowned failed chips — an operator's concurrent paste — do not block
      // THIS send: they are not part of its payload.)
      const ownedFailedUploads = flushRes.failed.filter((a) => owned.has(a));
      if (ownedFailedUploads.length > 0) {
        if (attempt) {
          updateSendAction(attempt.attemptId, {
            stage: "blocked", certainty: "definitive", recovery: "restore",
            detail: `${ownedFailedUploads.length} attachment upload(s) failed`,
            reason: "attachments-failed",
          });
        } else {
          // SHELL sends carry no attempt row (C-F1): no retained owner exists
          // for the fact, so the notification surfaces it (agent-gate
          // pattern).
          deps.pushNotification({
            kind: "error", sessionID: id, title: "Not sent — attachment upload failed",
            detail: `${ownedFailedUploads.length} attachment(s) failed to upload and the message was not queued. Remove or retry them, then send again.`,
          });
        }
        // O2 single-owner dedup: the blocked row's reason copy ("Not sent —
        // attachment upload was not confirmed. Review the attachment controls
        // before trying again.") carries the advice; the attachment chips
        // themselves own the per-file repair markers (uploadFailed badge).
        return;
      }
      // Shell commands (leading "!") dispatch directly against the live session —
      // they are NOT enqueued (they only make sense against a live shell). Text-
      // only path (no attachments). D3 (round 2): the clear/restore are
      // ownership-guarded exactly like the prompt path — an edit made during
      // the gate/flush waits is never ERASED by the clear (clear only if the
      // composer still holds the tap-time text), and a newer edit made during
      // the shell request is never OVERWRITTEN by the failure-restore (restore
      // only if the composer is still holding — or was cleared of — the sent
      // text). On failure the text is preserved for retry; on success it is
      // recorded in prompt history (D4: success only).
      if (text.startsWith("!")) {
        if (deps.input() === ownedText) deps.setInput("");
        const ok = await runShell(text.slice(1).trim(), id, sendAgent);
        if (!ok) {
          if (deps.input() === "" || deps.input() === ownedText) deps.setInput(text);
        } else {
          if (text) deps.pushHistory(text, deps.sessionId() || "__new__"); // plain Up (session) + Ctrl+Up (global)
          if (deps.draft()) localStorage.removeItem(deps.draftKey("__new__"));
        }
        return;
      }
      // Normal prompt: enqueue-first for durability. sendText acquires durable
      // custody (bounded wait) and returns true on confirmation, false on
      // failure — it does NOT clear the composer. Clearing is this caller's
      // job, gated on the TAP-time ownership snapshot (F1) so a slow
      // gate/enqueue can never erase state entered AFTER Send was pressed.
      //
      // S4: resolve inline-mode attachment tokens in the composer text into real
      // server paths. In inline mode (non-vision model, OR vision + user-forced
      // pref) the text holds markdown refs whose link target is a synthetic
      // vh-attach:<localId> token. Upload ONLY tokens still present (a ref the
      // user deleted -> its held File is NEVER uploaded: lazy upload), substitute
      // each token with its real project-relative path, and (vision only) add one
      // image file part per referenced IMAGE attachment. Non-inline mode skips
      // this block entirely — byte-for-byte unchanged. NEVER emits literal
      // "@file <path>": substitution is the bare path inside the markdown ref.
      // Original `text` is preserved for the failure-restore setInput(text); only
      // the ENQUEUED text uses resolvedText.
      let resolvedText = text;
      // S5 dF2 (b-F1 targeted removal): track the imageParts the resolve block
      // appends so a send FAILURE removes ONLY those parts — NOT the whole list.
      // The prior UNCONDITIONAL snapshot restore (setAttachments(preResolveAtts))
      // would silently discard an operator-added chip (or real upload) appended to the
      // live list during the await resolveInlineAttachments / await sendText
      // window. resolveInlineAttachments returns a FRESH imageParts array per call
      // (selectInlineImageParts .filter), so reference identity (`includes`)
      // isolates exactly ours, and a failed-then-retried inline send still yields
      // NO duplicate image parts (the dF2 guarantee). Non-inline mode leaves this
      // null, so the failure path only restores the text.
      let appendedImageParts: ResolvedAttachment[] | null = null;
      if (attempt?.reuse) {
        // RETRY of an uncertain admission (send-reliability slice 2): the
        // prepared payload (already inline-resolved text + uploaded
        // attachments + captured config) is reused VERBATIM under the same
        // attemptId — no re-resolution, no re-upload, no new config. The
        // retained text/paths are the ones the first attempt enqueued.
        resolvedText = attempt.reuse.text;
      } else if (effectiveInline(modelHasVision(deps.curModel()), inlineAttachForced())) {
        const r = await resolveInlineAttachments(
          text,
          deps.inlineFiles,
          (f) => deps.uploadFile(f, id),
          modelHasVision(deps.curModel()),
        );
        // ATTACHMENT BLOCKING (send-reliability slice 2): present inline
        // tokens whose upload FAILED block admission — the message must not
        // be partially admitted with unresolved vh-attach: tokens left in
        // its text. (Previously failedIds was ignored, producing exactly
        // that partial send.) The failed token(s) stay in the composer text;
        // the operator removes or retries them.
        if (r.failedIds.length > 0) {
          if (attempt) {
            updateSendAction(attempt.attemptId, {
              stage: "blocked", certainty: "definitive", recovery: "restore",
              detail: `${r.failedIds.length} inline attachment upload(s) failed (${r.failedIds.join(", ")})`,
              reason: "attachments-failed",
            });
          } else {
            // Defensive mirror of the agent-gate pattern (C-F1): unreachable
            // today — shell commands return above, before inline resolution —
            // but a future no-attempt caller shape must not leave the fact
            // homeless.
            deps.pushNotification({
              kind: "error", sessionID: id, title: "Not sent — attachment upload failed",
              detail: `${r.failedIds.length} inline attachment(s) failed to upload and the message was not queued. Remove or retry them, then send again.`,
            });
          }
          // Same O2 single-owner dedup as the flush-failed gate above: the
          // blocked row's reason copy carries the review-attachments advice;
          // the inline chips keep their per-token repair affordances.
          if (deps.input() === ownedText) deps.setInput(text);
          return;
        }
        resolvedText = r.resolvedText;
        // Vision-only image file parts carry real file:// urls; add them to the
        // chip list BEFORE enqueue so buildParts (at dispatch) emits them and
        // the success-clear still fires. The synthetic vh-attach: chips already
        // in the list are excluded by buildParts (isInlineChipUrl). This is our
        // OWN append, so the parts join the per-object owned set — no array
        // re-baseline needed, and an operator's concurrent additions are
        // untouched (they are not in the set).
        if (r.imageParts.length > 0) {
          appendedImageParts = r.imageParts;
          deps.setAttachments((a) => [...a, ...r.imageParts]);
          for (const p of r.imageParts) owned.add(p);
        }
      }
      const ok = await sendText(
        resolvedText,
        id,
        sendAgent,
        owned,
        attempt
          ? {
              attemptId: attempt.attemptId,
              tapText: attempt.tapText,
              reuse: attempt.reuse,
              policy: attempt.policy,
            }
          : undefined,
      );
      if (!ok) {
        // Preserve the composed text for retry — but never OVER an edit made
        // during the wait (F1): if the operator diverged, their newer text
        // stays (the tap text remains recallable via prompt history).
        if (deps.input() === ownedText) deps.setInput(text);
        // dF2/b-F1: remove ONLY the imageParts the resolve block appended so a
        // retry re-resolves from the same baseline (no stacking) WITHOUT
        // discarding an operator-added chip during the await window. Reference
        // identity (includes) isolates exactly our parts; everything else in the
        // live attachments() list is preserved. Non-inline -> no-op.
        if (appendedImageParts) {
          const ours = appendedImageParts;
          deps.setAttachments((a) => a.filter((x) => !ours.includes(x)));
        }
        return;
      }
      // Durable custody confirmed. Record the successful send in prompt
      // history (D4: exactly ONE push per successful send — the normal path
      // and the draft→session path both land here exactly once, and every
      // failure return above pushes nothing).
      if (text) deps.pushHistory(text, deps.sessionId() || "__new__"); // plain Up (session) + Ctrl+Up (global)
      // Clear ONLY what this tap still owns (D1/F1): the TEXT by value (an
      // edit made during the gate/flush/upload/enqueue waits survives), the
      // ATTACHMENTS per object identity — the sent (still-present owned)
      // objects are removed; additions made during the waits survive, and a
      // tap-owned attachment the operator removed mid-wait is not resurrected.
      if (deps.input() === ownedText) deps.setInput("");
      const stillOwned = deps.attachments().filter((a) => owned.has(a));
      if (stillOwned.length > 0) {
        deps.setAttachments((cur) => cur.filter((a) => !owned.has(a)));
        // S5 dF1: a successful inline send consumed every held File (lazy
        // upload resolved all present tokens, and the owned chips are now
        // cleared). Clear inlineFiles so the raw bytes do not linger for the
        // ChatView lifetime. An operator's mid-wait additions (not owned) keep
        // their chips and their held bytes intact.
        deps.inlineFiles.clear();
      }
      // For a draft, the draft->live transition (ensureSession -> createSession
      // -> setSelectedId) unmounts this ChatView in App.tsx, which disposes the
      // draft-save createEffect above BEFORE the setInput("") just fired can
      // re-run it — so the persisted vh.draft.__new__ slot would survive and
      // re-inflate the composer on the next New session. Clear it explicitly at
      // the moment of success, before the unmount races it.
      if (deps.draft()) localStorage.removeItem(deps.draftKey("__new__"));
    };

    // Resolve the target session id. For a DRAFT this is the createSession POST,
    // which can lag — and the draft composer's sendInFlight memo reads
    // isSendInFlight("draft") (props.sessionId is ""), NOT the live id the
    // admission below engages. Without engaging "draft" here the draft Send
    // button shows no feedback during that lag. So for a draft, wrap
    // ensureSession in a "draft"-keyed single-flight:
    //   (a) the guard marks "draft" in-flight SYNCHRONOUSLY, before the await —
    //       the draft button pulses + disables on the same tap;
    //   (b) a re-tap during the createSession POST is dropped here (IGNORED)
    //       instead of spawning a parallel createSession.
    // The guard releases "draft" in finally as soon as ensureSession resolves —
    // by then the draft ChatView is unmounting and the live view's memo reads
    // the live id. The admission tail then engages the LIVE id via
    // runSendSingleFlight(id, …), which the live view's memo reads.
    if (wasDraft) {
      const r = await runSendSingleFlight("draft", deps.ensureSession);
      if (r === IGNORED) return; // re-tap during createSession dropped; in-flight send owns the composer
      const id = r; // string | null (null = createSession failed or outcome unknown)
      if (!id) {
        // Session creation did not produce an id. CERTAINTY matters
        // (send-reliability slice 2): ChatView.ensureSession marks the draft
        // attempt "uncertain" when the create's OUTCOME is unknown (timeout /
        // proxy 502 / modern 202-unknown / in-flight — the session may exist;
        // a re-send may create a SECOND session, so the operator is told to
        // check). A definitive failure leaves the attempt in preparing →
        // rejected here — UNLESS the modern flow already disposed of it
        // (create-certainty Slice 2: capability-unavailable and proven
        // pre-upstream rejections pre-mark their own terminal reason; the
        // generic mark must not clobber the specific copy). Either way the
        // text is kept for retry — but only where we still own it (edits
        // made during the createSession wait survive, F1).
        const act = attempt ? getSendAction(attempt.attemptId) : undefined;
        if (act && (act.stage === "uncertain" || act.stage === "rejected" || act.stage === "blocked")) {
          // Already disposed of by the create path (modern uncertain/rejected
          // pre-marks, or the legacy uncertain mark):
          // - uncertain + reason "session-create-unknown": the row copy
          //   ("Session creation unconfirmed. Check possible sessions before
          //   sending again; another send may create another session.") owns
          //   the duplicate-session warning (O2 single-owner dedup);
          // - rejected + "capability-unavailable"/modern rejection: the
          //   reason-specific copy owns the retry-safe advice.
        } else {
          if (attempt) {
            updateSendAction(attempt.attemptId, {
              stage: "rejected", certainty: "definitive", recovery: "restore",
              detail: "createSession failed (no session id)",
              reason: "session-create-failed",
            });
          } else {
            // SHELL sends carry no attempt row (C-F1): no retained owner
            // exists for the fact, so the notification surfaces it (agent-gate
            // pattern).
            deps.pushNotification({
              kind: "error", sessionID: deps.sessionId(), title: "Could not create session",
              detail: "The message was kept in the composer; press Send again to retry.",
            });
          }
          // The rejected row's reason copy ("Session could not be created.")
          // owns the create-specific cause — no duplicate notification (O2).
        }
        if (deps.input() === ownedText) deps.setInput(text);
        return;
      }
      // OWNERSHIP BEFORE NAVIGATION (create-certainty Slice 2, §3.3). The
      // receipt/ownership transfer runs BEFORE the draft materializes, at
      // most one navigation follows, and the admission tail runs under the
      // live id:
      //   - MODERN create (the operation resolved to exactly this id — fresh
      //     receipt, recovery lookup, or a re-tap of a linked operation): the
      //     OPERATION-SCOPED re-key — only this create operation's records
      //     follow the session; unrelated drafts'/operations' records stay
      //     untouched, finished records are never resurrected. The module
      //     already ran this transfer at resolution time; re-running it here
      //     is an idempotent sweep that catches the CURRENT tap's record.
      //   - LEGACY create (no operation identity): the broad draft sweep,
      //     unchanged (send-reliability slice 3, F2) — at materialization the
      //     retained draft-owned set is exactly the in-flight attempt plus
      //     uncertain records from earlier taps.
      const modernOp = modernCreateTransferTarget(id);
      if (modernOp) transferCreateOpRecords(modernOp, id);
      // LEGACY broad sweep runs under the TAP-TIME draft key — the records
      // being swept were minted under it, and this code runs AFTER the
      // (up to 12s) create await, by which time an in-app project switch may
      // have changed projectDir() (tapOwnerKey keeps mint/sweep symmetric).
      else transferOwnerSendAttempts(tapOwnerKey, id);
      // THEN navigation — exactly once, after ownership (the low-level create
      // action no longer navigates; the draft ChatView unmounts here and the
      // live view's memo reads the live id for the admission single-flight).
      deps.materializeSession(id);
      // A re-tap once the live id exists is dropped at the LIVE key (the live
      // ChatView's memo reads it); the in-flight admission owns clearing on
      // its own success.
      await runSendSingleFlight(id, () => admission(id));
    } else {
      // LIVE session: the id is known at tap, so the single-flight engages
      // SYNCHRONOUSLY here — the Send button disables + pulses on the same
      // tap (the memo reads this id), and the WHOLE admission (evidence gate
      // + uploads + enqueue) is one single-flight region (F4). The guard
      // releases in finally on BOTH success and failure so a genuine retry
      // still works after a timeout. Distinct from `sending` (the dispatch
      // guard) — see lib/sendSingleFlight.ts. ensureSession for a live
      // session returns props.sessionId (no draft-key wrapper needed).
      await runSendSingleFlight(deps.sessionId(), async () => {
        const id = await deps.ensureSession();
        if (!id) return;
        await admission(id);
      });
    }
    // A re-tap at any point above returns IGNORED and the admission body never
    // runs twice — the composer is left untouched, which is correct (the
    // in-flight send owns clearing on its own success).
  }

  // Guarded row-retry entry (sending-UX O2 defect fix; RECORD-ADDRESSED since
  // the O2 slice-1 review A-F1).
  //
  // DEFECT being fixed: the SendStatus "Queue confirmation unknown." row's
  // Retry button routed through the GENERIC composer send (its prop carried
  // no record identity), so an operator who EDITED the composer after the
  // uncertain record appeared silently enqueued their EDITED draft as a fresh
  // message — and with TWO retained uncertain records the live-composer-text
  // selection (findReusableSendAttempt) could replay the WRONG record's
  // payload under a preview of another (row A's button replaying record B).
  // ChatView/Composer wire THIS method as the row's send entry WITH the
  // displayed row's attemptId; the composer's own Send button / Enter key
  // keep the raw send() (their composer-text reuse semantics are unchanged).
  //
  // Record-addressed contract (revalidated AT CLICK TIME — the displayed
  // record is the authority, never the live composer text):
  //   valid   — a retained record for `attemptId` still exists, is still
  //             owned by the CURRENT ownerKey (draft view: the current
  //             project's draft key), is still stage "uncertain" with
  //             recovery "retry-same", and still carries its payload →
  //             replay THAT record's STORED verbatim payload under ITS
  //             attemptId (same classification on a second lost response:
  //             reconcile-first, the record stays uncertain and retryable);
  //   invalid — gone (finished/dismissed), re-owned, or no longer an
  //             unresolved retry-same admission → REFUSE LOUDLY
  //             (notification, no enqueue). Nothing is inferred from live
  //             composer text, so the wrong-record/multi-candidate
  //             ambiguity the no-arg entry suffered from cannot arise.
  // The composer is NEVER modified by a row retry: the replay is always
  // verbatim, and the operator's live draft (matching or edited) survives
  // untouched for a fresh send. A chip REMOVED after the attempt is
  // re-included by the verbatim replay (the row's payload preview advertises
  // exactly this); a chip ADDED after the attempt never rides along.
  // The replay runs inside the per-session single-flight, so a concurrent
  // composer send drops it (IGNORED) exactly like a re-tap.
  async function retrySameMessage(attemptId: string): Promise<void> {
    // Current owner key at CLICK time: the row being retried is the one the
    // CURRENT view displays (draft rows are project-scoped — draftOwnerKey).
    const ownerKey = deps.draft() ? draftOwnerKey(projectDir()) : deps.sessionId();
    const rec = getSendAction(attemptId);
    if (
      !rec ||
      rec.ownerKey !== ownerKey ||
      rec.stage !== "uncertain" ||
      rec.recovery !== "retry-same" ||
      !rec.payload
    ) {
      // PRESERVED (O2 dedup exception): the tapped row either no longer
      // exists or no longer represents an unresolved retry-same admission —
      // no retained row owns THIS refusal event, so an attention cue is the
      // only honest surface for it. Never fall through to a fresh composer
      // send from a row affordance.
      log.error("send", "guarded retry refused: record not retryable", { id: ownerKey, attemptId });
      deps.pushNotification({
        kind: "error", sessionID: ownerKey, title: "Retry unavailable — status changed",
        detail: "Nothing was sent. This message is no longer waiting on an unknown queue confirmation; check the session queue.",
      });
      return;
    }
    const payload = rec.payload;
    const attempt: SendAttemptRef = {
      attemptId,
      tapText: payload.tapText,
      reuse: payload,
      // Queue-policy B2: retry-same preserves the ORIGINAL gesture's policy
      // (the admission fingerprint includes it — a changed member is a 409,
      // never a silent degradation).
      policy: payload.dispatchPolicy,
    };
    await runSendSingleFlight(ownerKey, async () => {
      // A reused attempt IS a retry — flag it so the status surface renders
      // "Retrying queue confirmation…" (same as send()'s reuse branch).
      // INSIDE the flight region (O2 review a-F1, matching send()): an
      // IGNORED entry (a concurrent composer send holds the flight) must not
      // flip the row when no replay is running.
      updateSendAction(attemptId, { retry: true });
      // Agent: the payload's captured agent is the exact evidence-gated value
      // the first attempt carried (sender-stamped, never re-resolved — F2
      // snapshot semantics); the evidence gate is only a defensive fallback
      // for a payload whose captured config lost it.
      let agent = payload.sendConfig?.agent;
      if (!agent) {
        const ag = await deps.awaitAgent(ownerKey);
        if (!ag.ok) {
          log.error("send", "guarded retry aborted: agent unresolved", { id: ownerKey, reason: ag.reason });
          // PRESERVED (O2 dedup exception, stated deviation): the uncertain
          // row cannot own this refusal — marking it rejected would
          // misrepresent the ADMISSION state (still unknown, still retryable
          // once an agent resolves), and its "Queue confirmation unknown."
          // copy says nothing about why this replay attempt sent nothing.
          // The notification is the only honest surface for the event.
          deps.pushNotification({
            kind: "error", sessionID: ownerKey, title: "Not sent — agent unresolved",
            detail: `Agent evidence did not arrive (${ag.reason}); nothing was sent.`,
          });
          return;
        }
        agent = ag.agent;
      }
      // Verbatim replay under the SAME attemptId. sendText never touches the
      // composer (its documented contract) and this caller deliberately owns
      // NONE of the composer state: the operator's draft survives intact
      // for a fresh send.
      await sendText(payload.text, ownerKey, agent, new Set(), attempt);
    });
  }

  // Slice 3 (intent recovery): guarded QUEUE-ITEM retry. The ONLY trigger is
  // the QueueChip's explicit Retry button (wired through ChatView/Composer) —
  // there is NO timer, NO loop, NO drain-driven re-arm anywhere (the standing
  // operator no-auto-retry policy is a hard constraint). UNKNOWN-STATE items
  // only: the retry re-POSTs the IDENTICAL dispatch payload by reusing
  // dispatchQueuedItem verbatim — the item's claim-minted opencodeMsgID
  // (pkg/web/queue.go mints it at Claim via opencode.MintMessageID) is
  // threaded into prompt_async's `messageID` body field, so on opencode
  // ≥ 1.17.18 the resend is caller-id-wins idempotent — if the first POST
  // landed, OpenCode persists no duplicate; if it never landed, the retry
  // delivers it. On older OpenCode a resend may duplicate (the Retry tooltip
  // states this boundary). `failed` items are refused: failed proves
  // non-delivery AND the resolve matrix rejects failed→sent (a successful
  // retry could never be recorded — review t1b-F1/t1d-F1).
  //
  // Click-time revalidation (retrySameMessage's discipline, applied to queue
  // items): only a STILL-unknown item that retained its correlation id is
  // retryable — anything else refuses loudly, never falls through to a fresh
  // composer send. Once per click: a per-item in-flight latch swallows
  // further clicks on the SAME item while its POST is pending (each click
  // maps to at most one POST; no internal replay). A retry that fails again
  // re-surfaces via dispatchQueuedItem's classification (including the
  // down-tied copy + notification while down); the resolve stays inside the
  // matrix's monotonic rules (identical state+detail is a no-op; a
  // conflicting rewrite is surfaced by the queue layer, never silently
  // applied), and the item never double-pends.
  //
  // G2 custody-bypass guard (2026-10-27, annex-2 §2): this retry is the ONE
  // browser path that direct-POSTs prompt_async with NO arbitrated step in
  // front of it (claim/resolve custody refusals fire only AFTER a POST), so
  // in daemon-dispatch mode it must NEVER reach the upstream. Three checks:
  // (1) click-time ownership snapshot, (2) re-check after the capability
  // refresh await (the /vh/version probe can still be in flight at click —
  // a stale legacy snapshot must not produce a POST), (3) the pre-POST guard
  // inside dispatchQueuedItem (a flip during its agent-gate await). A
  // refused retry sends nothing, resolves nothing, enqueues nothing — an
  // existing server-held unknown item recovers ONLY through daemon
  // reconciliation/certified recovery, never through a browser redispatch
  // or an automatic duplicate admission (the operator's explicit recovery
  // affordances stay mark-sent / edit-again / dismiss on the chip). Legacy
  // (daemon-off) retry behavior is unchanged.
  const RETRY_DISPATCH_TIMEOUT_MS = 12_000; // mirrors the drainer's DEFAULT_DISPATCH_TIMEOUT_MS
  const retryInFlight = new Set<string>();
  // G2: the loud refusal for a custody-owned retry — one surface (the
  // attention-cue notification pattern; no retained row owns this event).
  const refuseRetryUnderCustody = (sessionId: string, itemId: string): void => {
    log.error("send", "guarded queue retry refused: dispatch is daemon-owned", { id: sessionId, itemId });
    deps.pushNotification({
      kind: "error", sessionID: sessionId, title: "Retry unavailable — dispatch is daemon-owned",
      detail:
        "Nothing was sent. The daemon owns dispatching this queue; this message recovers through daemon reconciliation. Use edit again or mark sent instead.",
    });
  };
  // G2 (b-F1): the loud refusal for an UNESTABLISHED dispatch mode — the
  // click-time /vh/version probe could not confirm the server's posture
  // (offline / non-OK / malformed). Same shape as the custody refusal: no
  // POST, no resolve — an unconfirmable mode is not permission to dispatch,
  // and the operator must learn why nothing happened.
  const refuseRetryModeUnverified = (sessionId: string, itemId: string): void => {
    log.error("send", "guarded queue retry refused: dispatch mode unverified (probe failed)", { id: sessionId, itemId });
    deps.pushNotification({
      kind: "error", sessionID: sessionId, title: "Retry unavailable — dispatch mode unverified",
      detail:
        "Nothing was sent. The queue dispatch mode could not be confirmed (the server status probe failed); nothing was sent or resolved. Try again in a moment, or use edit again / mark sent.",
    });
  };
  async function retryQueuedItem(sessionId: string, item: QueuedMessage): Promise<void> {
    if (item.state !== "unknown" || !item.opencodeMsgID) {
      // UNKNOWN-ONLY (review t1b-F1/t1d-F1): the queue resolve matrix
      // (pkg/web/queue.go Resolve) allows exactly unknown→sent — it REJECTS
      // failed→sent with errQueueResolveConflict. A `failed` item whose
      // retry re-POST SUCCEEDED would deliver the message but be unable to
      // record it: the resolve 409s, the client reverts to server truth, and
      // the chip re-renders `failed` with the STALE detail for a message
      // that just landed — inviting duplicate re-sends. `failed` also proves
      // non-delivery, so retract-to-compose (re-edit as a NEW message) is
      // its honest recovery. Legacy items (no claim-minted messageID)
      // likewise have no idempotent resend. Nothing was sent by this click.
      log.error("send", "guarded queue retry refused: item not retryable", { id: sessionId, itemId: item.id });
      deps.pushNotification({
        kind: "error", sessionID: sessionId, title: "Retry unavailable — status changed",
        detail: "Nothing was sent. This queued message can no longer be retried as-is; edit it again or dismiss it.",
      });
      return;
    }
    if (!deps.resolveQueued) {
      // Defensive: without a resolve seam the outcome of the re-dispatch
      // could never be recorded — refuse rather than fire a blind POST.
      deps.pushNotification({
        kind: "error", sessionID: sessionId, title: "Retry unavailable",
        detail: "Nothing was sent. The queue status recorder is not wired in this build.",
      });
      return;
    }
    // G2 custody guard, check 1 of 3 — the click-time ownership snapshot.
    // "modern" (capability advertised, or a custody refusal already latched)
    // means a live daemon-dispatch owner holds this queue and this browser
    // must never dispatch: the resolve matrix's 409 fires only AFTER a POST,
    // so there is no arbitrated step to catch us downstream — refuse before
    // anything is sent. "unknown" does NOT refuse here (b-F1): the boot
    // probe may still be in flight on a perfectly healthy legacy server, and
    // check 2's click-time refresh is the step that establishes the mode —
    // refusing pre-refresh would break the legacy boot-race retry.
    if (deps.dispatchMode?.() === "modern") {
      refuseRetryUnderCustody(sessionId, item.id);
      return;
    }
    if (retryInFlight.has(item.id)) return; // swallow re-clicks on an in-flight retry
    retryInFlight.add(item.id);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RETRY_DISPATCH_TIMEOUT_MS);
    try {
      // G2 custody guard, check 2 of 3 (b-F1): refresh the ownership signal
      // and re-read the TRI-STATE after the await. "modern" — the capability
      // landed during the refresh (the boot-race snapshot was stale) →
      // refuse. "unknown" — the refresh itself could not establish the mode
      // (fetch error / non-OK / malformed JSON; every probe failed) → refuse
      // LOUDLY with no POST and no resolve: an unestablishable mode is not
      // legacy evidence, and this is the exact window where a daemon-
      // dispatch server with failing probes would otherwise be raced (the
      // 409 fires only AFTER a POST). Only "legacy-confirmed" — a
      // successfully observed legacy capability response, including the
      // capability-ABSENT 200 — proceeds toward the dispatch.
      if (deps.refreshDispatchMode) {
        await deps.refreshDispatchMode();
        const mode = deps.dispatchMode?.();
        if (mode === "modern") {
          refuseRetryUnderCustody(sessionId, item.id);
          return;
        }
        if (mode === "unknown") {
          refuseRetryModeUnverified(sessionId, item.id);
          return;
        }
      }
      // Identical resend: dispatchQueuedItem builds the body from the item's
      // captured config/text/attachments and threads item.opencodeMsgID into
      // body.messageID — the EXACT id the original dispatch carried. The
      // prePostGuard (G2 check 3 of 3) re-reads the ownership tri-state
      // inside dispatchQueuedItem after its agent-gate await, immediately
      // before the POST — and REQUIRES "legacy-confirmed", the only mode
      // that is permission to POST (b-F1 round 2). "modern" (a custody flip
      // that landed during that await) refuses; "unknown" ALSO refuses: the
      // observation is last-completion-wins (queueDispatchMode's
      // refreshDispatchMode), so an OLDER probe (boot / session-open) still
      // pending at click can complete with a failure DURING the gate await —
      // after check 2 already confirmed legacy — downgrading the mode to
      // "unknown" at exactly this read. An unestablished mode is never
      // permission to POST. Wired only when the ownership read exists, so
      // legacy (daemon-off / unwired) dispatch is byte-identical.
      const custodyGuard = deps.dispatchMode
        ? () => deps.dispatchMode!() === "legacy-confirmed"
        : undefined;
      const outcome = await dispatchQueuedItem(sessionId, item, ctrl.signal, custodyGuard);
      if (outcome.guardRefused) {
        // Nothing was sent and nothing may be resolved. Route the loud
        // refusal by what the tri-state reads now: "modern" — the daemon
        // owns the item's outcome; leave the chip's state to daemon
        // reconciliation. Otherwise ("unknown" — downgraded mid-await by a
        // failed concurrent probe) — the unverified-mode refusal: equally
        // loud, equally resolve-free.
        if (deps.dispatchMode?.() === "modern") {
          refuseRetryUnderCustody(sessionId, item.id);
        } else {
          refuseRetryModeUnverified(sessionId, item.id);
        }
        return;
      }
      await deps.resolveQueued(sessionId, item.id, outcome.state, outcome.detail);
      // Refresh the cache so the chip reflects the resolved state (a
      // successful retry's `sent` clears it). Guarded (review t1d-F2): a
      // rejecting refresh must not surface as an unhandled rejection off
      // the click's promise chain — the resolve above already recorded the
      // outcome authoritatively.
      await deps.fetchQueue(sessionId).catch(() => {});
    } finally {
      clearTimeout(timer);
      retryInFlight.delete(item.id);
    }
  }

  // Queue-policy B2 (amendment §2 "Pending queue chip escalation"): the
  // guarded pending-chip Send-now action. The ONLY trigger is QueueChip's
  // explicit button (wired through ChatView/Composer) — no timer, no loop.
  // The server executes cancel + re-admit with policy "now" under a FRESH
  // backend id behind the custody fence (pkg/web/queue_escalate.go); the
  // daemon's drain loop owns the resulting dispatch (now-bypasses the
  // subtree-idle gate) — the FE NEVER direct-POSTs for this path (G2 stays
  // closed). Error mapping per the mission contract: 404 = the item was
  // already escalated/removed/consumed (the fresh-ID consequence — refresh +
  // gentle notice, NEVER a blind re-escalate, D-F4); 409 fenced = the custody
  // epoch changed under the request (retry-later notice); a lost response =
  // outcome-unknown (refresh + honest notice — the transition may have
  // committed server-side).
  const escalateInFlight = new Set<string>();
  const notifyEscalate = (sessionId: string, kind: "info" | "error", title: string, detail: string): void => {
    deps.pushNotification({ kind, sessionID: sessionId, title, detail });
  };
  async function escalateQueuedItem(sessionId: string, item: QueuedMessage): Promise<void> {
    if (item.state !== "pending") {
      // PENDING-ONLY: dispatching is owned by the custody state machine;
      // terminal states are outside the escalation contract. Loud refusal,
      // nothing fired.
      log.error("send", "chip escalation refused: item not pending", { sessionId, itemId: item.id, state: item.state });
      notifyEscalate(
        sessionId, "error", "Send now unavailable — status changed",
        "Nothing was sent. This queued message is no longer waiting; the queue was not changed.",
      );
      return;
    }
    if (!deps.queuePolicyCapable?.() || !deps.escalate) {
      // Render-gated in production (the chip action only exists under the
      // capability); reaching here is a wiring bug or a capability flip.
      log.error("send", "chip escalation refused: policy capability or escalate seam absent", { sessionId, itemId: item.id });
      notifyEscalate(
        sessionId, "error", "Send now unavailable",
        "Nothing was sent. The queue policy capability is not active on this server right now.",
      );
      return;
    }
    if (escalateInFlight.has(item.id)) return; // swallow re-clicks while pending
    escalateInFlight.add(item.id);
    try {
      const r = await deps.escalate!(sessionId, item.id);
      if (r.ok) {
        // The cache already holds the replacement (queue.ts escalateQueued
        // removed the old id + upserted the fresh now-item). Converge to
        // daemon truth — the now item typically claims+dispatches within one
        // 250ms drain tick. NO notification: the chip IS the surface.
        await deps.fetchQueue(sessionId).catch(() => {});
        return;
      }
      switch (r.code) {
        case "not-found": {
          // The fresh-ID consequence: already escalated (another tab), removed,
          // or consumed by the drain loop. Refresh so the UI reflects what
          // actually happened; gentle notice; NEVER a blind re-escalate.
          await deps.fetchQueue(sessionId).catch(() => {});
          notifyEscalate(
            sessionId, "info", "Queue updated",
            "This message was already sent, escalated, or removed — the queue view was refreshed.",
          );
          return;
        }
        case "fenced": {
          // Custody epoch changed under the request (a newer owner exists).
          // Unobtrusive retry-later notice; the queue state is untouched.
          notifyEscalate(
            sessionId, "info", "Send now not applied — try again in a moment",
            "Queue ownership changed while sending; the message is still queued. Tap Send now again if you still want it immediately.",
          );
          return;
        }
        case "not-escalatable": {
          await deps.fetchQueue(sessionId).catch(() => {});
          notifyEscalate(
            sessionId, "error", "Send now unavailable — status changed",
            "Nothing was sent. This queued message is no longer waiting; the queue view was refreshed.",
          );
          return;
        }
        case "requires-custody": {
          notifyEscalate(
            sessionId, "error", "Send now unavailable",
            "Nothing was sent. Immediate dispatch requires the daemon's queue policy scheduler.",
          );
          return;
        }
        default: {
          // timeout / network / unknown — the escalation's outcome is
          // UNKNOWN (the transition may have committed server-side; the old
          // id may already be gone). Refresh + honest notice; no auto-retry.
          await deps.fetchQueue(sessionId).catch(() => {});
          notifyEscalate(
            sessionId, "info", "Send now unconfirmed",
            "The escalation result could not be confirmed; the queue view was refreshed to show the current state.",
          );
        }
      }
    } finally {
      escalateInFlight.delete(item.id);
    }
  }

  // retry() reuses sendText() to resend an OLD message; named resendText on the
  // public surface so ChatView's retry closure can call it without reaching
  // into the private sendText. Same evidence gate as send(): the session
  // exists by definition, so the agent must come from the ladder — never the
  // config default.
  async function resendText(text: string, id: string): Promise<boolean> {
    const ag = await deps.awaitAgent(id);
    if (!ag.ok) {
      log.error("send", "resend aborted: agent unresolved", { id, reason: ag.reason });
      deps.pushNotification({
        kind: "error", sessionID: id, title: "Not sent — agent unresolved",
        detail: `Agent evidence did not arrive (${ag.reason}); nothing was sent.`,
      });
      return false;
    }
    // A retry is text-only by construction (createMessageActions extracts
    // the message's text part), so the resend owns NO composer attachments:
    // an empty identity set keeps sendText from reading the live composer
    // array (D1) — attachments staged for the NEXT message never ride along
    // with a resend.
    // Send-reliability slice 2: each operator-initiated resend is its own
    // logical attempt (one stable identity + payload captured once inside
    // sendText); if its confirmation is lost, the attempt's retained payload
    // still guarantees an idempotent re-enqueue under the same attemptId.
    const attemptId = mintSendAttempt(id).attemptId;
    return sendText(text, id, ag.agent, new Set(), { attemptId, tapText: text });
  }

  return { send, sendPolicy, escalateQueuedItem, retrySameMessage, retryQueuedItem, resendText, dispatchQueuedItem };
}
