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
import type { Attachment } from "./createAttachments";
import type { QueuedMessage } from "../../queue";
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
    input: { text: string; attachments: Attachment[]; sendConfig: QueueConfig },
  ) => Promise<unknown>;
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
  flushPendingAttachments: (id: string) => Promise<void>;
  inlineFiles: Map<string, File>;
  uploadFile: (file: File, id: string) => Promise<Attachment | null>;
  // draft-persistence key helper (pure; injected so the factory owns no ChatView-local symbol)
  draftKey: (sid: string) => string;
};

export type SendController = {
  send(): Promise<void>;
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
  async function sendText(text: string, id: string, agent?: string, owned?: Set<Attachment>): Promise<boolean> {
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
    // Always capture a model. OpenCode rejects a prompt with no model. If models
    // haven't loaded, fetch once before enqueue so the persisted queue item
    // carries a valid sendConfig.
    if (!deps.selectionFor(id) && deps.models().length === 0) await deps.loadModels();
    const config = captureConfig(id, agent);
    try {
      // Recompute the intersection AFTER the loadModels await: "still present
      // at enqueue" is decided as late as possible (D1).
      await deps.enqueue(id, { text, attachments: ownedNow(), sendConfig: config });
    } catch (e) {
      // Enqueue failed (offline / non-2xx / ambiguous 2xx-without-item) —
      // preserve the composed text + attachments (no silent loss) and warn.
      // Nothing was persisted, so a reconnect must NOT auto-send: there is no
      // pending item for the drainer to pick up. The operator re-presses Send.
      log.error("send", "enqueue failed", { id, err: String(e) });
      deps.pushNotification({ kind: "error", sessionID: id, title: "Could not queue message", detail: text.slice(0, 120) });
      return false;
    }
    // Durable custody confirmed. The caller decides whether to clear the
    // composer (and only if it still owns the submitted state). This function
    // does not touch setInput/setAttachments.
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
      // Definitive rejection (non-2xx) — failed, never re-enqueue.
      let detail = "";
      try { detail = (await res.text()).slice(0, 300); } catch {}
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
      await deps.flushPendingAttachments(id);
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
      if (effectiveInline(modelHasVision(deps.curModel()), inlineAttachForced())) {
        const r = await resolveInlineAttachments(
          text,
          deps.inlineFiles,
          (f) => deps.uploadFile(f, id),
          modelHasVision(deps.curModel()),
        );
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
      const ok = await sendText(resolvedText, id, sendAgent, owned);
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
      const id = r; // string | null (null = createSession failed)
      if (!id) {
        // Session creation failed; keep the text for retry — but only where we
        // still own it (edits made during the createSession wait survive, F1).
        if (deps.input() === ownedText) deps.setInput(text);
        return;
      }
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
    return sendText(text, id, ag.agent, new Set());
  }

  return { send, resendText, dispatchQueuedItem };
}
