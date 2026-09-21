// Send/dispatch controller — the prompt/shell send + queue-dispatch cluster,
// extracted from ChatView (mirroring createQueueDrainer / createQueueSync /
// createQueueRecovery / createAttachments). The factory owns the send
// orchestration (buildParts, captureConfig, sendText, dispatchSend, runShell,
// send) and the public surface the drainer/retry path call into
// (send, resendText, dispatchQueuedItem). It owns NO network/localStorage
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
  findReusableSendAttempt,
  finishSendAttempt,
  getSendAction,
  mintSendAttempt,
  sendActionsFor,
  transferOwnerSendAttempts,
  updateSendAction,
  type PreparedSendPayload,
} from "../../lib/sendActionStatus";
import type { Attachment } from "./createAttachments";
import { EnqueueError, type QueuedMessage } from "../../queue";
import type { DrainOutcome } from "../../queueDrain";
import type { Notification } from "../../notify";

// Model/agent/variant a prompt is sent with (captured at queue time too).
type QueueConfig = { providerID?: string; modelID?: string; variant?: string; agent?: string };

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

export type SendDependencies = {
  // session
  sessionId: Accessor<string>;
  draft: Accessor<boolean>;
  ensureSession: () => Promise<string | null>;
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
    },
  ) => Promise<unknown>;
  // Authoritative queue list (queue.ts fetchQueue) — injected for the
  // reconcile-first recovery path when an enqueue response is lost
  // (send-reliability slice 2).
  fetchQueue: (id: string) => Promise<QueuedMessage[]>;
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

export type SendController = {
  send(): Promise<void>;
  // Guarded SendStatus row-retry entry (sending-UX O2 defect fix): verbatim
  // same-attempt replay of a retained uncertain admission — never silently
  // sends edited composer contents. See retrySameMessage below for the exact
  // eligibility/refusal semantics.
  retrySameMessage(): Promise<void>;
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
  type SendAttemptRef = {
    attemptId: string;
    tapText: string;
    reuse?: PreparedSendPayload;
  };

  // Typed admission-failure classification (send-reliability slice 2). The OLD
  // "nothing was persisted" assumption after a failed enqueue is UNSAFE under
  // response loss: a timeout/network failure (or an ambiguous 2xx) may have
  // been admitted server-side. So: definitive HTTP errors classify by code,
  // and response-less failures RECONCILE FIRST (an authoritative list showing
  // an item admitted under our attemptId proves custody after all) before
  // being recorded as outcome-unknown.
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
      // flow; surface it if state ever diverges.
      updateSendAction(attempt.attemptId, {
        stage: "conflict", certainty: "definitive", recovery: "check",
        detail: `admission conflict: ${err.message}`,
        conflictSource: "admission",
      });
      log.error("send", "enqueue admission conflict", { id, err: err.message });
      deps.pushNotification({
        kind: "error", sessionID: id, title: "Message not queued — admission conflict",
        detail: "The queue reports a conflicting admission for this message; open the session queue to check before sending again.",
      });
      return false;
    }
    if (attempt && err?.code === "queue_admission_full") {
      // 429 = hard user-visible error, no retry.
      updateSendAction(attempt.attemptId, {
        stage: "rejected", certainty: "definitive", recovery: "restore", detail: err.message,
      });
      log.error("send", "enqueue rejected: queue full", { id, err: err.message });
      deps.pushNotification({
        kind: "error", sessionID: id, title: "Message not queued — queue is full",
        detail: "This session's queue is at capacity; remove queued messages before sending again.",
      });
      return false;
    }
    if (attempt && err && err.status !== undefined) {
      // Any other non-2xx WITH a response from the local worker server is a
      // definitive rejection (this is NOT the /oc upstream proxy).
      updateSendAction(attempt.attemptId, {
        stage: "rejected", certainty: "definitive", recovery: "restore", detail: err.message,
      });
      log.error("send", "enqueue failed", { id, err: err.message });
      deps.pushNotification({
        kind: "error", sessionID: id, title: "Could not queue message", detail: composedText.slice(0, 120),
      });
      return false;
    }
    if (attempt) {
      // Response-less failure (timeout / network / ambiguous 2xx): the
      // admission outcome is UNKNOWN — never "failed, safe to resend".
      // Reconcile-first: a fresh authoritative list showing an item admitted
      // under our attemptId proves durable custody after all.
      let confirmed = false;
      try {
        const items = await deps.fetchQueue(id);
        confirmed = items.some((it) => it.attemptId === attempt.attemptId);
      } catch {
        /* list unavailable — stay uncertain */
      }
      if (confirmed) {
        finishSendAttempt(attempt.attemptId); // admitted after all; the item is authority
        return true;
      }
      updateSendAction(attempt.attemptId, {
        stage: "uncertain", certainty: "unknown", recovery: "retry-same",
        detail: err?.message ?? String(e),
      });
      log.error("send", "enqueue outcome unknown (reconcile did not confirm)", { id, err: String(e) });
      deps.pushNotification({
        kind: "error", sessionID: id, title: "Queue confirmation unknown",
        detail: "The message may or may not be queued. Check the session queue before sending again; pressing Send again re-sends the same message.",
      });
      return false;
    }
    // No attempt context: preserve the legacy contract exactly.
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
    const atts = ownedNow();
    if ((!text && atts.length === 0) || !id) return false;
    // An existing-session prompt MUST carry an agent: the SENDER stamps it and
    // every later message inherits it. An empty/omitted agent would let
    // opencode resolve the omitted field to its config default_agent server-
    // side — the silent-flip path (2026-08-16 / 2026-08-26 incidents). Refuse
    // loudly instead; the caller keeps the composed text.
    if (!agent) {
      log.error("send", "sendText refused: no resolved agent", { id });
      deps.pushNotification({
        kind: "error", sessionID: id, title: "Not sent — agent unresolved",
        detail: "No agent evidence for this session; pick an agent before sending.",
      });
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
          },
        });
      }
    }
    if (attempt) updateSendAction(attempt.attemptId, { stage: "admitting" });
    try {
      await deps.enqueue(
        id,
        attempt ? { ...input, attemptId: attempt.attemptId } : input,
      );
    } catch (e) {
      // Enqueue failed or its response was lost — typed classification with
      // reconcile-first (see classifyAdmissionFailure). The composed text +
      // attachments are preserved by the caller (no silent loss).
      return classifyAdmissionFailure(e, id, attempt, text);
    }
    // Durable custody confirmed — the queue item is now the authority. Drop
    // the action record (Slice 3 renders the chip, not the action).
    if (attempt) finishSendAttempt(attempt.attemptId);
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
  async function dispatchQueuedItem(
    id: string,
    item: QueuedMessage,
    signal: AbortSignal,
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
        deps.pushNotification({
          kind: "error", sessionID: id, title: "Queued message not sent — agent unresolved", detail: msg,
        });
        return { state: "failed", detail: msg };
      }
      config = captureConfig(id, ag.agent);
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
        const msg = detail || "proxy 502";
        log.error("send", "queued POST hit proxy 502 (outcome unknown)", { id, itemId: item.id, detail: msg });
        deps.pushNotification({
          kind: "error", sessionID: id, title: "Queued message send outcome unknown",
          detail: `${msg} — the message may still have been delivered; check the transcript before resending.`,
        });
        return { state: "unknown", detail: `proxy 502 (outcome unknown): ${msg}` };
      }
      const msg = detail || `HTTP ${res.status}`;
      log.error("send", "queued POST rejected", { id, itemId: item.id, status: res.status, detail: msg });
      deps.pushNotification({ kind: "error", sessionID: id, title: "Queued message failed to send", detail: msg });
      return { state: "failed", detail: msg };
    } catch (e) {
      // Abort/timeout or network interruption — ambiguous, NEVER repend. The
      // POST may have reached OpenCode (a late/non-response socket looks
      // identical to one that never accepted the bytes), so re-dispatch risks
      // a duplicate and is explicitly forbidden by the operator's no-retry
      // policy. Classify as `unknown`; the queue chip persists the text +
      // attachment metadata until the operator dismisses it.
      const aborted = signal.aborted || (e instanceof DOMException && e.name === "AbortError");
      const msg = aborted ? "dispatch timed out" : String(e);
      const title = aborted ? "Queued message send timed out" : "Queued message send interrupted";
      log.error("send", "queued POST threw", { id, itemId: item.id, aborted, err: msg });
      deps.pushNotification({ kind: "error", sessionID: id, title, detail: msg });
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
          deps.pushNotification({ kind: "error", sessionID: id, title: failTitle, detail: detail || `HTTP ${res.status}` });
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

  async function send() {
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
    const ownedText = deps.input();
    const ownedAtts = deps.attachments();
    const owned = new Set<Attachment>(ownedAtts);
    const text = ownedText.trim();
    if (!text && ownedAtts.length === 0) return;
    // F2: ONE agent capture at tap, through the SAME resolver the composer's
    // agent Select renders. `tapAgent` is either the evidence-backed value
    // the composer DISPLAYED at the tap — sent EXACTLY, never re-resolved,
    // so a later evidence change cannot flip the send — or undefined
    // (pending / unavailable / empty at tap → the bounded gate inside
    // admission waits for the FIRST valid resolution; the composer's
    // pending→resolved transition displays that same first value once it
    // lands). For a DRAFT this snapshot is the config-default policy
    // (legitimate for a genuinely new session) and is ADOPTED as the
    // materialized session's first evidence below.
    const wasDraft = deps.draft();
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
    if (deps.working() && !deps.queueMode()) {
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
          const ownerKey = wasDraft ? "draft" : deps.sessionId();
          const reusable = findReusableSendAttempt(ownerKey, text);
          // attachmentsSubsetOfPayload (NOT a raw includes): the store proxies
          // the retained payload on read, so an inline identity includes is
          // always false for attachment-bearing payloads — see the helper.
          if (reusable?.payload && attachmentsSubsetOfPayload(ownedAtts, reusable.payload)) {
            return { attemptId: reusable.attemptId, tapText: text, reuse: reusable.payload };
          }
          return { attemptId: mintSendAttempt(ownerKey).attemptId, tapText: text };
        })();
    // Send-reliability slice 3: a reused attempt IS a retry of a retained
    // uncertain admission — flag it so the status surface renders
    // "Retrying queue confirmation…" instead of a plain "Sending…" while the
    // same attemptId replays.
    if (attempt?.reuse) {
      updateSendAction(attempt.attemptId, { retry: true });
    }

    // ADMISSION (F4): everything from here on runs inside the per-session
    // send single-flight, engaged at TAP time — a re-tap during the (up to
    // 10s) agent gate wait is DROPPED (IGNORED) instead of spawning a
    // parallel waiter with duplicate history/enqueue side effects. The
    // history push/reset side effects live INSIDE admission so dropped
    // re-taps never duplicate them. The composer stays EDITABLE throughout
    // (F1's ownership snapshot protects edits made during any wait).
    const admission = async (id: string): Promise<void> => {
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
          deps.pushNotification({
            kind: "error", sessionID: id, title: "Not sent — agent unresolved",
            detail: "No agent selected for the new session; pick an agent before sending.",
          });
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
          deps.pushNotification({
            kind: "error", sessionID: id, title: "Not sent — agent unresolved",
            detail: `Agent evidence did not arrive (${ag.reason}); nothing was sent. Retry shortly or pick an agent.`,
          });
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
          });
        }
        deps.pushNotification({
          kind: "error", sessionID: id, title: "Not sent — attachment still uploading",
          detail: "Wait for the upload to finish, then send again.",
        });
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
          });
        }
        deps.pushNotification({
          kind: "error", sessionID: id, title: "Not sent — attachment upload failed",
          detail: `${ownedFailedUploads.length} attachment(s) failed to upload and the message was not queued. Remove or retry them, then send again.`,
        });
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
            });
          }
          deps.pushNotification({
            kind: "error", sessionID: id, title: "Not sent — attachment upload failed",
            detail: `${r.failedIds.length} inline attachment(s) failed to upload and the message was not queued. Remove or retry them, then send again.`,
          });
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
        attempt ? { attemptId: attempt.attemptId, tapText: attempt.tapText, reuse: attempt.reuse } : undefined,
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
        // proxy 502 — the session may exist; a re-send may create a SECOND
        // session, so the operator is told to check). A definitive failure
        // leaves the attempt in preparing → rejected here. Either way the
        // text is kept for retry — but only where we still own it (edits
        // made during the createSession wait survive, F1).
        const act = attempt ? getSendAction(attempt.attemptId) : undefined;
        if (act?.stage === "uncertain") {
          deps.pushNotification({
            kind: "error", sessionID: deps.sessionId(), title: "Session creation outcome unknown",
            detail: `${act.detail || "The create request may have succeeded."} Check the session list before sending again — sending again may create another session.`,
          });
        } else {
          if (attempt) {
            updateSendAction(attempt.attemptId, {
              stage: "rejected", certainty: "definitive", recovery: "restore",
              detail: "createSession failed (no session id)",
            });
          }
          deps.pushNotification({
            kind: "error", sessionID: deps.sessionId(), title: "Could not create session",
            detail: "The message was kept in the composer; press Send again to retry.",
          });
        }
        if (deps.input() === ownedText) deps.setInput(text);
        return;
      }
      // EXPLICIT draft→live ownership transfer (send-reliability slice 2,
      // widened to an owner SWEEP by the slice-3 F2 review finding): records
      // minted under the "draft" key (no session existed at tap) are re-keyed
      // to the live id now that it is known — the two single-flight keys are
      // distinct by design, so the transfer must be explicit. Slice 2
      // transferred only the IN-FLIGHT attempt; retained records from EARLIER
      // draft taps (the reachable case: a create-outcome-unknown uncertain
      // record, marked by ChatView.ensureSession) stayed stranded under
      // "draft" — invisible in the destination session (SendStatus reads
      // ownerKey = session id; findReusableSendAttempt is owner-scoped) and
      // stale in the NEXT draft view. The sweep re-keys every
      // still-draft-owned record: at materialization that is exactly the
      // in-flight attempt plus retained uncertain records (mint-supersede
      // already finished earlier preparing/blocked/rejected ones). Residual
      // limitation (accepted): materializing WITHOUT a re-tap (the create
      // landed; the operator clicks the session in the list) strands such
      // records under "draft" — nothing links them to that session absent a
      // create-time idempotency key (out of scope, brief §8).
      transferOwnerSendAttempts("draft", id);
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

  // Guarded row-retry entry (sending-UX O2 defect fix, bounded bug-fix slice).
  //
  // DEFECT being fixed: the SendStatus "Queue confirmation unknown." row's
  // Retry send button routes through the GENERIC composer send (its prop
  // signature is `() => Promise<void>` — no record identity), so an operator
  // who EDITED the composer after the uncertain record appeared would silently
  // enqueue their EDITED draft as a fresh message under a fresh attemptId —
  // while the row's payload preview ("Will send: '<stored text>'") advertised
  // a verbatim replay of the ORIGINAL (and the original admission stayed
  // unknown, so BOTH messages could deliver). ChatView/Composer wire THIS
  // method as the row's send entry; the composer's own Send button / Enter
  // key keep the raw send(). Semantics:
  //   (a) the composer still matches a retained uncertain retry-same attempt
  //       (tapText equal + live attachments a subset of the payload's, per
  //       identity — the SAME pure selection send() applies at its reuse
  //       gate) → delegate to send(): today's behavior exactly (same
  //       attemptId + verbatim payload; the tap-owned composer state clears
  //       on success as always).
  //   (b) the composer diverged from EVERY retained retry-same record (text
  //       edited, or an attachment ADDED): the row's displayed payload is the
  //       authority — replay the STORED verbatim payload under the SAME
  //       attemptId and leave the composer UNTOUCHED (the operator's edit
  //       stays visible for a fresh send under a fresh attemptId; nothing is
  //       silently overwritten or swallowed). With MORE THAN ONE such record
  //       the no-arg entry cannot know which row was tapped — refuse
  //       (notification, no enqueue) rather than silently send a record the
  //       operator did not select. With NONE, delegate to send() (stale-row
  //       fallback: today's behavior).
  // Subset-semantics coherence (slice-2 advisory): a chip the operator
  // REMOVED after the attempt still passes the subset gate → (a) → the
  // verbatim replay re-includes it, exactly as before; a chip ADDED after the
  // attempt fails the subset gate → (b) → the replay sends the stored payload
  // WITHOUT the added chip and the composer keeps it. In every branch what is
  // sent is the STORED payload — composer additions never silently ride
  // along.
  // The replay reuses sendText's reuse branch (same classification on a
  // second lost response: reconcile-first, the record stays uncertain and
  // retryable) and runs inside the per-session single-flight, so a concurrent
  // composer send drops it (IGNORED) exactly like a re-tap.
  async function retrySameMessage(): Promise<void> {
    if (deps.draft()) return send();
    // Retry-same records live under live session ids (the draft→live owner
    // sweep runs before the first enqueue ever resolves uncertainly), so a
    // draft owner has nothing to guard — today's path unchanged.
    const ownerKey = deps.sessionId();
    const liveText = deps.input().trim();
    const liveAtts = deps.attachments();
    const reusable = findReusableSendAttempt(ownerKey, liveText);
    if (reusable?.payload && attachmentsSubsetOfPayload(liveAtts, reusable.payload)) {
      return send(); // (a) composer-matching retry: today's decision, unchanged
    }
    const candidates = sendActionsFor(ownerKey).filter(
      (a) => a.stage === "uncertain" && a.recovery === "retry-same" && a.payload,
    );
    if (candidates.length === 0) return send(); // nothing to guard — today's behavior
    if (candidates.length > 1) {
      deps.pushNotification({
        kind: "error", sessionID: ownerKey, title: "Retry unavailable — multiple unresolved sends",
        detail: "More than one message has an unknown queue confirmation. Restore the exact text of the message you want to retry into the composer, or check the session queue.",
      });
      return;
    }
    const rec = candidates[0];
    const payload = rec.payload!;
    const attempt: SendAttemptRef = { attemptId: rec.attemptId, tapText: payload.tapText, reuse: payload };
    // A reused attempt IS a retry — flag it so the status surface renders
    // "Retrying queue confirmation…" (same as send()'s reuse branch).
    updateSendAction(rec.attemptId, { retry: true });
    await runSendSingleFlight(ownerKey, async () => {
      // Agent: the payload's captured agent is the exact evidence-gated value
      // the first attempt carried (sender-stamped, never re-resolved — F2
      // snapshot semantics); the evidence gate is only a defensive fallback
      // for a payload whose captured config lost it.
      let agent = payload.sendConfig?.agent;
      if (!agent) {
        const ag = await deps.awaitAgent(ownerKey);
        if (!ag.ok) {
          log.error("send", "guarded retry aborted: agent unresolved", { id: ownerKey, reason: ag.reason });
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
      // NONE of the composer state: the operator's edited draft survives
      // intact for a fresh send.
      await sendText(payload.text, ownerKey, agent, new Set(), attempt);
    });
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

  return { send, retrySameMessage, resendText, dispatchQueuedItem };
}
