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
// only edits are `this.X` → `deps.X()` / local refs. The drainer's dispatch
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
  activeAgent: (sessionId: string) => string;
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
  // so a queued message keeps the config it was composed with.
  function captureConfig(id: string): QueueConfig {
    const s = deps.selectionFor(id);
    return { providerID: s?.providerID, modelID: s?.modelID, variant: s?.variant, agent: deps.activeAgent(deps.sessionId()) || undefined };
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
  // layer up: send() wraps this call in runSendSingleFlight (per-session
  // single-flight), so a re-tap during the (up to 12s) enqueue window is
  // dropped instead of spawning a parallel enqueue. The no-loss invariant is
  // preserved either way — a visible duplicate was always preferred over any
  // chance of silent loss (operator policy); single-flight removes the
  // duplicate without ever risking loss.
  async function sendText(text: string, id: string): Promise<boolean> {
    const atts = deps.attachments();
    if ((!text && atts.length === 0) || !id) return false;
    // Always capture a model. OpenCode rejects a prompt with no model. If models
    // haven't loaded, fetch once before enqueue so the persisted queue item
    // carries a valid sendConfig.
    if (!deps.selectionFor(id) && deps.models().length === 0) await deps.loadModels();
    const config = captureConfig(id);
    try {
      await deps.enqueue(id, { text, attachments: atts, sendConfig: config });
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
  // The config-fallback (use the item's captured sendConfig when it has both
  // provider+model, else re-capture from the live selection) lives HERE now —
  // it was previously in ChatView's drainer dispatch closure; moving it in
  // aligns this method's signature with queueDrain.ts's `dispatch` dep
  // `(id, item, signal) => Promise<DrainOutcome>`.
  async function dispatchQueuedItem(
    id: string,
    item: QueuedMessage,
    signal: AbortSignal,
  ): Promise<DrainOutcome> {
    const config = item.sendConfig?.providerID && item.sendConfig?.modelID
      ? (item.sendConfig as QueueConfig)
      : captureConfig(id);
    const body: any = { parts: buildParts(item.text, item.attachments) };
    if (config.agent) body.agent = config.agent;
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
  async function runShell(command: string, id: string): Promise<boolean> {
    const key = deps.sessionId() || "draft";
    if (!command || !id || deps.isSending(key)) return false;
    deps.setSending(key, true);
    const body: any = { command };
    const ag = deps.activeAgent(deps.sessionId());
    if (ag) body.agent = ag; // never fall back to a hardcoded "build" that may be disabled
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
    const text = deps.input().trim();
    if (!text && deps.attachments().length === 0) return;
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
    if (text) deps.pushHistory(text, deps.sessionId() || "__new__"); // plain Up (session) + Ctrl+Up (global)
    deps.resetHistory();
    // /undo /redo only make sense for an existing session.
    if (!deps.draft() && text === "/undo") { deps.setInput(""); return void deps.undo(); }
    if (!deps.draft() && text === "/redo") { deps.setInput(""); return void deps.redo(); }
    // Resolve the target session id. For a DRAFT this is the createSession POST,
    // which can lag — and the draft composer's sendInFlight memo reads
    // isSendInFlight("draft") (props.sessionId is ""), NOT the live id the
    // enqueue below engages. Without engaging "draft" here the draft Send button
    // shows no feedback during that lag (the bug: pulse/disabled only appeared
    // once the live id was known, i.e. after the draft→live unmount). So for a
    // draft, wrap ensureSession in a "draft"-keyed single-flight:
    //   (a) the guard marks "draft" in-flight SYNCHRONOUSLY, before the await —
    //       the draft button pulses + disables on the same tap, before the live
    //       id is known / before backend custody;
    //   (b) a re-tap during the createSession POST is dropped here (IGNORED)
    //       instead of spawning a parallel createSession.
    // The guard releases "draft" in finally as soon as ensureSession resolves —
    // by then the draft ChatView is unmounting (createSession → setSelectedId)
    // and the live view's memo reads the live id, so holding "draft" longer
    // would only risk a NEW draft inheriting this send's in-flight state
    // (per-session invariant). The enqueue tail below then engages the LIVE id
    // via runSendSingleFlight(id, …), which the live view's memo reads. For a
    // LIVE session ensureSession returns props.sessionId synchronously — no
    // draft-key wrapper needed (the memo already reads that id).
    let id: string | null;
    if (deps.draft()) {
      const r = await runSendSingleFlight("draft", deps.ensureSession);
      if (r === IGNORED) return; // re-tap during createSession dropped; in-flight send owns the composer
      id = r; // string | null (null = createSession failed)
    } else {
      id = await deps.ensureSession();
    }
    if (!id) {
      deps.setInput(text); // session creation failed; keep the text for retry
      return;
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
    await deps.flushPendingAttachments(id);
    // Shell commands (leading "!") dispatch directly against the live session —
    // they are NOT enqueued (they only make sense against a live shell). Clear
    // the composer text; on failure restore it so a silent noop never loses what
    // the user typed. (Out of scope for the send-loss fix — dispatchSend's
    // accepted-by-time race stays for shell only.)
    if (text.startsWith("!")) {
      deps.setInput("");
      const ok = await runShell(text.slice(1).trim(), id);
      if (!ok) deps.setInput(text);
      else if (deps.draft()) localStorage.removeItem(deps.draftKey("__new__"));
      return;
    }
    // Normal prompt: enqueue-first for durability. sendText acquires durable
    // custody (bounded wait) and returns true on confirmation, false on failure
    // — it does NOT clear the composer. Clearing is this caller's job, gated on
    // an ownership snapshot so a slow enqueue can never erase state entered
    // AFTER Send was pressed (finding #2): the enqueue can take up to 12s, and
    // the composer stays editable during that window. We capture the exact text
    // + attachment array right before enqueue and clear ONLY if the composer
    // still holds that identical state when custody confirms. Reference
    // identity on the array catches any add/remove (setAttachments always
    // produces a new array); value equality on text catches any keystroke. On
    // enqueue failure the text + attachments are preserved and the operator
    // can re-press Send.
    //
    // Single-flight (the duplicate-send-on-slow-network bug): on a weak/hung
    // network the enqueue POST can take up to 12s, during which the composer
    // text is NOT cleared and no chip appears yet — so the operator sees no
    // feedback and re-taps Send, each re-tap spawning a PARALLEL enqueue that
    // lands as a duplicate once the network settles. runSendSingleFlight drops
    // re-taps while one enqueue is in-flight for this session (keyed by the
    // live session id). For a LIVE session this is ALSO the synchronous tap-time
    // engagement (the memo reads this id, so the Send button disables + the
    // animation shows IMMEDIATELY, before backend custody confirms). For a DRAFT
    // the tap-time pulse is already provided by the "draft"-keyed wrapper above
    // (the live id isn't known until ensureSession resolves); this inner guard
    // then engages the live id so the LIVE ChatView — mounted after the
    // draft→live transition — keeps showing the sending state, and a re-tap
    // during the enqueue is dropped. The guard releases in finally on BOTH
    // success and failure so a genuine retry still works after a timeout.
    // Distinct from `sending` (the dispatch guard) — see lib/sendSingleFlight.ts.
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
    // would silently discard an operator-added chip (or real upload) appended to
    // the live list during the await resolveInlineAttachments / await sendText
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
      // chip list BEFORE the ownership snapshot below so buildParts (at dispatch)
      // emits them and the success-clear still fires. The synthetic vh-attach:
      // chips already in the list are excluded by buildParts (isInlineChipUrl).
      if (r.imageParts.length > 0) {
        appendedImageParts = r.imageParts;
        deps.setAttachments((a) => [...a, ...r.imageParts]);
      }
    }
    await runSendSingleFlight(id, async () => {
      const snapText = deps.input();
      const snapAtts = deps.attachments();
      const ok = await sendText(resolvedText, id);
      if (!ok) {
        deps.setInput(text);
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
      // Durable custody confirmed. Clear the composer ONLY if it still owns the
      // submitted snapshot. If the operator typed a new draft or changed
      // attachments during the enqueue wait, that newer state survives.
      if (deps.input() === snapText && deps.attachments() === snapAtts) {
        deps.setInput("");
        deps.setAttachments([]);
        // S5 dF1: a successful inline send consumed every held File (lazy
        // upload resolved all present tokens, and the chips are now cleared).
        // Clear inlineFiles so the raw bytes do not linger for the ChatView
        // lifetime. Inside the snapshot guard so a composer the operator changed
        // during the wait keeps its (new) chips and their held bytes intact.
        deps.inlineFiles.clear();
      }
      // For a draft, the draft->live transition (ensureSession -> createSession
      // -> setSelectedId) unmounts this ChatView in App.tsx, which disposes the
      // draft-save createEffect above BEFORE the setInput("") just fired can
      // re-run it — so the persisted vh.draft.__new__ slot would survive and
      // re-inflate the composer on the next New session. Clear it explicitly at
      // the moment of success, before the unmount races it.
      if (deps.draft()) localStorage.removeItem(deps.draftKey("__new__"));
    });
    // A re-tap during the in-flight enqueue returns IGNORED and the body above
    // never runs — the composer is left untouched, which is correct (the
    // in-flight send owns clearing on its own success).
  }

  // retry() reuses sendText() to resend an OLD message; named resendText on the
  // public surface so ChatView's retry closure can call it without reaching
  // into the private sendText.
  async function resendText(text: string, id: string): Promise<boolean> {
    return sendText(text, id);
  }

  return { send, resendText, dispatchQueuedItem };
}
