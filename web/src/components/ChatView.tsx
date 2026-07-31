import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
import { ackSession, createSession, currentVerb, isSending, loadOlder, openSession, rootOf, sessionWorking, setSelectedId, setSending, state } from "../sync";
import {
  bottommostReadWithFallback,
  classifyScrollDelta,
  clearReadAnchor,
  getReadAnchor,
  orderAhead,
  setReadAnchor,
} from "../lib/scroll";
import type { ScrollGeometry } from "../lib/scroll";
import { createReadCursorStash } from "../lib/readCursorStash";
import { findModel, loadModels, migrateModelPick, models, selectionFor } from "../models";
import { loadVersioned, saveVersioned } from "../lib/store";
import { activeAgent, agents, selectAgentForSession, selectedAgent } from "../agents";
import { claimQueued, enqueue, fetchQueue, hasQueueState, migrateLegacyQueue, queueFor, queueMode, removeQueued, resolveQueued } from "../queue";
import { createQueueDrainer } from "../queueDrain";
import { pushHistory } from "../history";
import {
  effectiveInline,
  modelHasVision,
  inlineAttachForced,
} from "../lib/inlineAttach";
import { isSendInFlight } from "../lib/sendSingleFlight";
import PartView, { ActivityGroup } from "./Part";
import ChatTasksStatus from "./ChatTasksStatus";

// scrollEl ResizeObserver "stuck on ↓ Latest" recovery admission window: the
// largest PRE-resize (pinnedGeom) gap-from-bottom for which a pure clientHeight
// GROW (composer shrink / keyboard dismiss) is allowed to re-engage `following`.
// Distinct from nearBottom()'s 24px (which is the strict am-I-at-bottom line)
// and from classifyScrollDelta's 1px epsilon (sub-pixel churn absorb): this is a
// "was the reader still at the tail?" band, deliberately WIDER than nearBottom
// because onScrolled advances pinnedGeom to the post-scroll geometry, so a
// deliberate ~30px one-line scroll-up (just past the 24px line — bug-2b) leaves a
// ~30px baseline gap that 24px would wrongly reject. 64 ≈ a few text lines:
// comfortably admits bug-2b's deterministic 30px nudge (+ the ~10px isolation
// case), comfortably rejects a mid-history reader (~300px — P1-WEB-042 no-yank).
// Absolute (not a viewport fraction): the e2e viewport is intentionally tiny
// (~70px chat-scroll), so a fraction would collapse below the 30px admission.
const RECOVERY_TAIL_GAP = 64;
import QuestionCard from "./QuestionCard";
import PermissionCard from "./PermissionCard";
import PendingInput from "./PendingInput";
import Icon from "./Icon";
import Spinner from "./Spinner";
import BrandMark from "./BrandMark";
import { pushNotification } from "../notify";
import { groupParts } from "./chat/MessageParts";
import { MessageRow } from "./chat/MessageRow";
import { createComposerAutocomplete } from "./chat/createComposerAutocomplete";
import { createPromptHistory } from "./chat/createPromptHistory";
import { createComposerPaste } from "./chat/createComposerPaste";
import { createQueueSync } from "./chat/createQueueSync";
import { createAttachments } from "./chat/createAttachments";
import { createQueueRecovery } from "./chat/createQueueRecovery";
import { createSend } from "./chat/createSend";
import { createMessageActions, type MessageActions } from "./chat/createMessageActions";
import { createNavigator } from "./chat/createNavigator";
import { ChatNavigator } from "./chat/ChatNavigator";
import { Composer } from "./chat/Composer";

const draftKey = (sid: string) => "vh.draft." + sid;

export default function ChatView(props: { sessionId: string; draft?: boolean }) {
  let scrollEl: HTMLDivElement | undefined;
  let contentEl: HTMLDivElement | undefined;
  let chatMainEl: HTMLDivElement | undefined;
  // Phase-4 load-older UI: a top sentinel observed by an IntersectionObserver
  // (root: scrollEl) + a "Load older" button fallback. The IO is created in
  // onMount; refs fire before onMount, so the sentinel uses a ref callback that
  // observes itself if the IO already exists. See `onLoadOlder`.
  let topSentinelEl: HTMLDivElement | undefined;
  let loadMoreObserver: IntersectionObserver | undefined;
  const [following, setFollowing] = createSignal(true);
  // Intent latch for the auto-follow self-heal. `following()` flips false for
  // several reasons — a genuine user scroll-up (drop Live, show "↓ Latest"), a
  // content-shrink clamp (system), or a programmatic reposition (restore). Only
  // the first is real user intent to read history. The latch is armed ONLY at
  // the genuine-scroll-away false-flip sites and cleared at every "re-engage"
  // site (jumpToLatest, scroll back to bottom, session switch, restore-to-bottom).
  // The self-heal effect (working() busy edge) then re-engages Live UNLESS the
  // latch is set — so a new turn re-glues a user who happened to lose Live for
  // any non-intent reason, but does NOT yank a deliberate reader.
  //
  // DELIBERATELY NOT cleared on the busy edge itself: "scroll up, then a new
  // turn starts" must keep the reader in place (the stated lifecycle). Clearing
  // on turn-start would re-yank them, defeating the latch.
  const [userScrolledUp, setUserScrolledUp] = createSignal(false);
  // Interaction-scoped follow hold (Approach E). While the operator is actively
  // interacting with the PendingInput blocker card (hover/press/focus/popup-
  // open/pinned-reveal), PendingInput reports `held=true` via onHoldChange and
  // we suppress ONLY the programmatic content-resize re-glue-to-bottom write in
  // the content ResizeObserver below. This is SEPARATE transient state from
  // `following` / `userScrolledUp`: the scroll classifier, the viewport-resize
  // RO, composer grow/shrink handling, and onScrolled are all untouched. The
  // hold is safe because while scrollTop is held steady and content grows, the
  // classifier sees residualUserDelta=0 → intent "none" (never user-scroll-up),
  // so skipping the write does NOT arm userScrolledUp; on release the next cycle
  // still classifies shouldScroll=true and a single re-pin lands cleanly.
  const [holdActive, setHoldActive] = createSignal(false);
  // Hide the transcript until it's positioned for the current session, so the
  // initial scroll jump (top → restored/bottom) is never painted — switching
  // sessions reveals the content already in place instead of flashing.
  const [ready, setReady] = createSignal(false);
  // Bumped each time the content ResizeObserver re-pins to the bottom while
  // following. The reactive ack effect (below) reads this so it re-evaluates
  // nearBottom() after a RO re-pin — otherwise a transient nearBottom()==false
  // at the moment unread is armed (lazy-hydration growing the transcript past
  // the last pin) makes the effect bail, and since nearBottom() is a plain DOM
  // read (not a signal) the effect never re-runs even after the RO re-glues.
  const [repinTick, setRepinTick] = createSignal(0);
  // Loading overlay for the switch → ready window (large sessions): a non-draft
  // session whose transcript is still being positioned hides `.chat-content`
  // (opacity:0 until `ready`), so a heavy render leaves a blank area. This shows
  // a cheap spinner sibling instead. Delayed ~150ms so a near-instant switch
  // (ready flips within a frame or two) never flashes the indicator; the timer
  // is cancelled whenever `ready` flips back to true.
  const [showLoading, setShowLoading] = createSignal(false);
  const [input, setInput] = createSignal("");
  // Per-session in-flight guard (lives in the sync store, not this reused
  // component) so a send that hangs on one session never blocks another.
  const sending = createMemo(() => isSending(props.sessionId || "draft"));
  // Enqueue-in-flight guard — DISTINCT from `sending` above (the DISPATCH guard
  // in the sync store, owned by queueDrain/shell). True ONLY while the enqueue
  // POST for this session is pending (up to 12s on a slow/hung network), NOT
  // while an agent turn or queue dispatch is running. Drives the Send button's
  // `disabled` + the sending animation so the operator sees the tap register
  // immediately and re-taps are dropped (per-session single-flight).
  //
  // Keying: for a LIVE session the memo reads the live id (=== props.sessionId)
  // and the guard in send() engages that same id. For a DRAFT (props.sessionId
  // === "") the memo reads "draft" — and because the live id isn't known until
  // ensureSession() resolves, send() ALSO engages "draft" synchronously at tap
  // time (wrapping ensureSession in runSendSingleFlight("draft", …)) so the
  // draft button pulses the INSTANT Send is tapped, then transitions to the
  // live id for the enqueue (see send()). See lib/sendSingleFlight.ts —
  // sendText must NOT touch the sync store's setSending (it would stall the
  // drain effect), so this is a separate signal.
  const sendInFlight = createMemo(() => isSendInFlight(props.sessionId || "draft"));
  // Whether send() can resolve an agent + model right now — the single hinge for
  // the disabled Send button AND the send() guard. agents() must be loaded
  // (activeAgent falls back to a leak-prone chain when empty), and a model must
  // be resolvable for this session — mirroring sendText's own check
  // (selectionFor(id) present, else the catalog must be loaded so models()[0]
  // exists). Once agents/models load this clears automatically: the grayed-out
  // Send re-enables with no extra wiring.
  const readyToSend = createMemo(() =>
    agents().length > 0 && (models().length > 0 || !!selectionFor(props.sessionId)),
  );
  // The hidden file-picker <input> ref. Bound in JSX below and passed to the
  // createAttachments factory (C6) as an accessor so addFiles can clear it
  // after a pick (re-pick of the same file). The attachment signals/state moved
  // to createAttachments; ChatView keeps this DOM ref because JSX owns it.
  let fileInputRef: HTMLInputElement | undefined;

  // Load (or switch to) this session's history (drafts have no server session).
  createEffect(() => {
    if (!props.draft && props.sessionId) void openSession(props.sessionId);
  });

  // In a draft, keep the model synced to the selected agent's configured model
  // so a new session starts on the agent's model (applies to "" = the default).
  // Track only the inputs that should re-apply it (the draft flag, the selected
  // agent, and the agent list finishing its load); run the apply UNTRACKED so its
  // internal signal reads (notably pushRecent, which reads AND writes recentKeys)
  // don't become dependencies — that read→write on a fresh array each run made
  // the effect retrigger itself into a stack overflow.
  createEffect(() => {
    if (!props.draft) return;
    const agent = selectedAgent();
    agents(); // re-apply once the agent list (and its model) has loaded
    untrack(() => selectAgentForSession("", agent));
  });

  const sm = () => state.messages[props.sessionId];
  // True once the real message snapshot has been delivered for this session.
  // openSession pre-reserves a truthy-but-empty slot, so sm() truthiness alone
  // can't tell "still loading" from "genuinely empty" — this flag does. Mirrors
  // maybeRestore's order-length guard below (~:591-595) and drives the
  // transcript empty/loading discriminator at the bottom of the render.
  const delivered = () => !!state.messagesDelivered[props.sessionId];
  // messageFailed: the active-session background hydration emitted
  // messages.error and the daemon left the session UNLOADED (it retries on next
  // selection/reconnect). The reveal gate falls back to this so a failed
  // hydration reveals whatever partial content was streamed instead of wedging
  // forever on a blank loading state (messages.loaded never arrives on failure).
  const messageFailed = () => !!state.messagesError[props.sessionId];
  // revealed: the VISUAL transcript reveal gate. This is the O2 fix for the
  // "transcript grows top-down" symptom: a large session's Slice-C async
  // hydration streams a PARTIAL snapshot (messagesDelivered=false) followed by
  // message.*/part.* deltas and finally messages.loaded. Without this gate the
  // transcript populated progressively while already visible. `revealed` holds
  // the .chat-content opacity:hidden + loading overlay up until the transcript
  // is BOTH positioned (ready, for scroll-restore geometry) AND fully delivered
  // (delivered) — or the fetch failed (messageFailed), in which case we show
  // the partial content with an error hint rather than hanging on loading.
  // `ready()` semantics are intentionally left UNTOUCHED (it still drives
  // scroll-restore, self-heal, and ack timing); `revealed` is a separate,
  // purely-visual gate layered on top.
  // Transient tail-drop guard on the rendered LIST. openSession pre-reserves a
  // truthy-but-empty messages[id] slot (delivered()=false) the instant a session
  // is selected, so switching to a never-viewed session makes this memo compute
  // [] for one frame → the <For> below unmounts the OUTGOING transcript's rows.
  // That sub-frame empty flash is flagged as a tail "drop" by the
  // session-completion e2e's strict sampler (it polls every mutation). This is
  // the SAME cold-open gap the revealedOnce opacity latch above was built for
  // (messagesDelivered=false during a cold re-snapshot); the latch only protected
  // the .ready opacity class, not the rendered rows. This extends the same hold
  // to the <For> list: while the entering session is still cold-opening (not
  // delivered, not failed) and the computed list is empty, KEEP the previous
  // transcript mounted instead of flashing to empty. Released the instant the
  // new session delivers/errors; stays [] for a genuinely-empty settled session
  // or when there was no prior transcript (first-ever cold-open).
  const messages = createMemo((prev: any[] | undefined) => {
    const s = sm();
    const next = s ? s.order.map((id) => s.byId[id]) : [];
    if (next.length > 0 || delivered() || messageFailed() || !prev?.length) return next;
    return prev;
  });
  // P1-WEB reveal-gate latch (O1 collapsed-frontier): once a session has
  // LEGITIMATELY revealed (positioned + delivered/failed), keep it revealed
  // while it stays positioned and populated even if delivered() transiently
  // drops — which happens when a resync/reconnect re-snapshots the session
  // (applySessionSnapshot sets messagesDelivered=false on a cold re-snapshot). The
  // base gate below is what FIRST reveals; the latch only prevents a transient
  // delivered drop from re-stranding an already-shown transcript behind the
  // opacity:0 overlay. It is per-session (set only when base fires for THIS sid)
  // and gated on ready() AND a non-empty order, so it never fires during the
  // slow-session partial-hydration window the reveal-gate.spec e2e guards
  // (there the base gate is false for ~900ms → the latch stays empty → the
  // overlay stays up). Armed by the latch effect near the switch effect.
  const [revealedOnce, setRevealedOnce] = createSignal<string>("");
  const revealed = createMemo(
    () =>
      (ready() && (delivered() || messageFailed())) ||
      (revealedOnce() === props.sessionId && ready() && messages().length > 0),
  );
  // Chat navigator: a faint strip of markers (one per user turn) on the right
  // edge — click to jump. Cheap: just markers + a tooltip, no rendered minimap.
  // Logic lives in ./chat/createNavigator and is rendered by <ChatNavigator>;
  // the controller exposes scheduleActiveTurn / measureNavCap, which this view
  // calls from its scroll / content-RO / scrollEl-RO callbacks below. cssEsc is
  // shared with this view's own [data-mid] scroll/anchor logic, so it stays here
  // and is injected into the controller (single source of truth).
  const cssEsc = (id: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id);
  const navigator = createNavigator({ messages, scrollEl: () => scrollEl, cssEsc });

  const pendingPermissions = createMemo(() => Object.values(state.permissions[props.sessionId] || {}));
  const pendingQuestions = createMemo(() => Object.values(state.questions[props.sessionId] || {}));
  // True when there is any active blocker (question OR permission) for this
  // session. The blocker jump pill (PendingInput) wins over the "↓ Latest" pill
  // — "↓ Latest" is suppressed while a blocker is active so the two never
  // coexist. In practice an OpenCode session blocks on one item at a time, so
  // this is usually exactly one card.
  const blockerActive = createMemo(() => pendingQuestions().length + pendingPermissions().length > 0);

  // A child/subagent session (spawned by a `task` tool) cannot be prompted
  // directly — like opencode web, we disable the composer and offer a jump back
  // to the parent session.
  const parentId = createMemo(() => (props.draft ? undefined : state.sessions[props.sessionId]?.parentID));
  const isChild = createMemo(() => !!parentId());
  function openParent() {
    const pid = parentId();
    if (pid) {
      setSelectedId(pid);
      void openSession(pid);
    }
  }

  // Model selection (per session) + its variants.
  const sel = createMemo(() => selectionFor(props.sessionId));
  const curModel = createMemo(() => {
    const s = sel();
    if (!s) return undefined;
    // Show the selected model even if it isn't in the connected catalog (e.g. a
    // provider that's configured but whose list we don't have) — fall back to a
    // minimal ref showing the model id, so it never reads "Select model" when a
    // model is in fact selected.
    return (
      findModel(s.providerID, s.modelID) ?? {
        providerID: s.providerID,
        modelID: s.modelID,
        provider: s.providerID,
        name: s.modelID,
        label: `${s.providerID} / ${s.modelID}`,
        variants: [],
      }
    );
  });
  const [modelDialog, setModelDialog] = createSignal(false);
  // Variant dropdown value, normalized: "" (the "default" option) unless the
  // session's persisted variant is actually one this model offers — otherwise a
  // stale/literal variant (e.g. "default") matched no option and the control
  // read "Select…" instead of auto-selecting the model default.
  const curVariant = createMemo(() => {
    const v = sel()?.variant;
    return v && curModel()?.variants?.includes(v) ? v : "";
  });

  // "Working" = the session is busy (shared with the sidebar spinner so they
  // always agree). See sessionWorking() — it trusts the server's subtreeBusy
  // facet for resident tree nodes, with a self-only activity fallback otherwise.
  const working = createMemo(() => sessionWorking(props.sessionId));
  // Honest verb for the Working pill ("Reading parser.go · 4s", "Thinking · 3s",
  // "Waiting for approval · 8s"). Derived in selectors (currentVerb) so the
  // sidebar can reuse it later; the selector is clock-free, so the elapsed
  // timer ticks here (1s, mirroring ReasoningPart) and only while the pill shows.
  const verb = createMemo(() => currentVerb(props.sessionId));
  const [verbNow, setVerbNow] = createSignal(Date.now());
  createEffect(() => {
    if (!working() || !verb()) return;
    const t = setInterval(() => setVerbNow(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });
  // Self-heal: when a new turn starts or a busy session resumes (working() goes
  // false→true), re-engage Live and re-glue to the bottom — UNLESS the user
  // deliberately scrolled up to read history (intent latch). Before this, any
  // Live loss was permanent until manual scroll-back: following() had no engage
  // site on turn-start/resume (only open/switch/Latest/scroll-back/maybeRestore
  // engaged it), so a coincident content-shrink clamp or RO guard trip during
  // reasoning/tool-block settling dropped Live for the rest of the turn.
  //
  // Edge tracking uses a hand-rolled prev cursor (not Solid's on(prev)) so we
  // can hold the cursor until ready(): during initial scroll-restore working()
  // may already be true (a resumed busy session) and we must NOT re-pin before
  // maybeRestore has positioned the viewport. Returning before updating
  // prevWorking means the first ready() flip still delivers the busy edge.
  // Gated on ready() (reads it as a dep) to mirror the viewport-shrink re-pin.
  let prevWorking = false;
  createEffect(() => {
    const w = working();
    if (!ready()) return; // hold edge cursor until positioned
    const edge = !prevWorking && w;
    prevWorking = w;
    if (edge && !userScrolledUp()) {
      setFollowing(true);
      pin();
    }
  });
  // Resume re-engage: while the tab is hidden the browser throttles timers but
  // Solid reactivity + layout still run, so a turn can settle (raw md-stream →
  // compact MarkdownHtml swap, a shrink) and new content can regrow it. RO
  // callbacks are NOT delivered while hidden — they queue and coalesce, then
  // deliver a single one on resume. If an intermediate settle-shrink clamped
  // scrollTop DOWN and content then regrew so the NET scrollHeight is back near
  // its pre-hidden value, the queued RO below would measure against a stale
  // baseline and mis-classify the clamp as a genuine user scroll-up —
  // setFollowing(false)+latch armed — which the self-heal cannot recover (it
  // needs a working() edge or a cleared latch). Live would stay dead until
  // manual scroll-back / Latest click / a new turn.
  //
  // visibilitychange dispatches before the rendering step where the queued RO
  // delivers, so re-pin here to refresh the geometry baseline (pinnedGeom) to
  // the CURRENT post-hidden state first: the reducer then sees residual within
  // epsilon and re-pins cleanly instead of tripping on the stale pre-hidden
  // baseline. Gated on ready() + !userScrolledUp() to mirror the self-heal
  // (won't yank a genuine reader who deliberately scrolled up during/after
  // backgrounding).
  const onVisibleReengage = () => {
    if (document.visibilityState !== "visible") return;
    if (!ready() || userScrolledUp()) return;
    setFollowing(true);
    pin();
  };
  document.addEventListener("visibilitychange", onVisibleReengage);
  onCleanup(() => document.removeEventListener("visibilitychange", onVisibleReengage));
  const verbElapsed = createMemo(() => {
    const v = verb();
    if (!v || !v.startMs) return "";
    const secs = Math.max(0, Math.round((verbNow() - v.startMs) / 1000));
    return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  });
  // Verb-only (stable) label for the live region's aria-label. Intentionally
  // excludes the elapsed timer: the .working element is aria-live="polite", so
  // mutating its accessible name once per second (the verbNow 1s ticker) would
  // announce every tick. Announcing only on verb transitions keeps screen
  // readers quiet between meaningful state changes; the ticking elapsed span is
  // aria-hidden in the markup below.
  const workingAriaLabel = createMemo(() => {
    const v = verb();
    if (!v) return "Working";
    const subj = v.subject ? ` ${v.subject}` : "";
    return `${v.verb}${subj}`;
  });
  // Key (first part id) of the LAST activity group in the whole conversation —
  // that one renders expanded by default, all earlier ones collapsed.
  const lastActivityKey = createMemo(() => {
    const msgs = messages();
    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const items = groupParts(msgs[mi]);
      for (let k = items.length - 1; k >= 0; k--) {
        if (items[k].kind === "activity") return (items[k] as any).parts[0]?.id ?? null;
      }
    }
    return null;
  });

  function nearBottom() {
    return scrollEl
      ? scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 24
      : true;
  }
  // Dual-axis scroll geometry snapshot at the last programmatic position.
  // Records scrollTop + scrollHeight + clientHeight so classifyScrollDelta can
  // decompose content-delta + viewport-delta + clamp and treat genuine user
  // scroll-intent as the RESIDUAL. The single-axis "shrank" boolean it replaces
  // mis-classified the composer grow/shrink autoscroll deadlock (typing grows
  // the textarea → viewport shrinks in the same frame content grows). Sentinel
  // {-1,-1,-1} means "no valid snapshot yet".
  let pinnedGeom: ScrollGeometry = { scrollTop: -1, scrollHeight: -1, clientHeight: -1 };
  // Read-mode logical anchor tracking: the data-mid id we restored to and its
  // content-coordinate offset at restore/pin time, so a grow/shrink ABOVE the
  // viewport that overflow-anchor:auto failed to track can be corrected
  // mechanically (measured anchorDelta) instead of being mistaken for user
  // intent during hydration / load-more.
  let restoredAnchorId: string | undefined;
  let restoredAnchorOffset = -1;
  function geom(el: HTMLElement | undefined): ScrollGeometry {
    if (!el) return { scrollTop: -1, scrollHeight: -1, clientHeight: -1 };
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }
  // Anchor's top edge in content (scroll) coordinates. Shifts exactly by the
  // amount of content added/removed above it → the read-mode anchorDelta.
  function anchorContentOffset(el: HTMLElement): number {
    if (!scrollEl) return -1;
    return el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
  }
  function pin() {
    if (!scrollEl) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
    pinnedGeom = geom(scrollEl); // clamped value + content/viewport size at pin time
  }
  function jumpToLatest() {
    setFollowing(true);
    setUserScrolledUp(false); // user explicitly chose to follow again
    pin();
  }

  // ── Phase-4 load-older (historical page prepend) ─────────────────────────
  // The server (Phase 1-3) ships only a bounded recent tail of a session's
  // transcript; an older page is fetched on demand from
  // GET /vh/session/{id}/messages?before=<oldestResidentID>. The merge happens
  // via insert-if-not-present in `prependMessagesIfAbsent` (reduce.ts); the
  // Contract-B response gate (sesGen/epoch/dirty-retry) lives in `loadOlder`
  // (stream.ts). This view's only responsibilities are: (a) render a Load-
  // older affordance at the top of `.chat-content` when the server says there
  // is older content (`hasOlder`); (b) fire `loadOlder` on click OR on a
  // top-sentinel IntersectionObserver trip (one page per signal — `loadingOlder`
  // prevents chaining); (c) preserve the visible anchor through the prepend by
  // capturing `restoredAnchorId`/`restoredAnchorOffset` BEFORE the fetch so the
  // existing read-mode ResizeObserver branch (line ~940) corrects scrollTop
  // mechanically via `anchorDelta` — NO new scroll code here.
  const win = () => state.messageWindows[props.sessionId];
  const hasOlder = () => !!win()?.hasOlder;
  const loadingOlder = () => !!win()?.loadingOlder;
  // Capture the visible logical anchor before a prepend. If we're following
  // (tail mode), there is no anchor to preserve — the prepend lands above the
  // viewport and the user stays at the tail. If we're reading up, capture the
  // current top-visible message (or the first resident as a fallback) so the
  // RO's anchorDelta branch keeps it in view through the prepend.
  function captureAnchorBeforeLoadOlder() {
    if (!scrollEl) return;
    if (following()) return; // tail mode: nothing to preserve
    const cand = bottommostReadFromDom() || messages()[0]?.id;
    if (!cand) return;
    const el = scrollEl.querySelector(`[data-mid="${cssEsc(cand)}"]`) as HTMLElement | null;
    if (!el) return;
    restoredAnchorId = cand;
    restoredAnchorOffset = anchorContentOffset(el);
  }
  async function onLoadOlder() {
    if (loadingOlder()) return; // single-flight guard (mirrors pageInFlight)
    captureAnchorBeforeLoadOlder();
    await loadOlder(props.sessionId);
  }

  // Scroll restore: reopening a session returns to its read-up-to anchor (the
  // last message scrolled past), else the bottom. `restoredFor` tracks which
  // session we've positioned. The anchor is a monotonic messageID cursor
  // (lib/scroll); `following` stays per-device and is NOT part of the cursor.
  let restoredFor = "";
  // Debounced read-cursor write: computing the bottommost-read message forces a
  // layout sweep (getBoundingClientRect over rows), so it must NOT run per
  // scroll frame. We schedule it on scroll-idle (~400ms quiet) and flush on
  // unmount. localStorage is written at most once per idle period — never per
  // frame (Firefox/WebRender perf: see AGENTS.md "Web frontend performance").
  let readCursorTimer: number | undefined;
  // P1-WEB-004: throttled arm-time stash for the read-cursor switch flush.
  // Extracted to lib/readCursorStash (pure: clock + read producer injected) so
  // the throttle / capture / flush-on-switch state machine is unit-tested. The
  // 400ms debounce + all side effects (setReadAnchor) stay here in the component.
  const readStash = createReadCursorStash();
  function scheduleReadCursor() {
    // P1-WEB-004: throttled arm-time capture so the session-switch flush has the
    // OUTGOING session's last-known read position (leading-edge: first arm fires
    // immediately, making the <400ms switch case deterministic). The pure
    // throttle / capture state lives in lib/readCursorStash; bottommostReadFromDom
    // is the injected read producer (reads-only, one flush), idle during
    // streaming — not the GPU re-raster heat-saga class.
    readStash.arm({
      now: Date.now(),
      draft: !!props.draft,
      hasViewport: !!scrollEl,
      sessionId: props.sessionId,
      read: bottommostReadFromDom,
    });
    clearTimeout(readCursorTimer);
    readCursorTimer = window.setTimeout(() => flushReadCursor(props.sessionId), 400);
  }
  // Compute + persist the current read cursor for `sid` right now. Monotonic:
  // only advances forward (scrolling up to re-read never lowers the stored
  // anchor). At the bottom → caught up → drop the anchor (sparse default).
  function flushReadCursor(sid: string) {
    clearTimeout(readCursorTimer);
    readCursorTimer = undefined;
    if (props.draft || !scrollEl || !sid) return;
    if (nearBottom()) {
      clearReadAnchor(sid);
      readStash.invalidateIfSession(sid);
      return;
    }
    const cand = bottommostReadFromDom();
    if (!cand) return;
    if (orderAhead(cand, getReadAnchor(sid), sm()?.order ?? [])) setReadAnchor(sid, cand);
  }
  // Read-through cursor from live geometry: the bottommost message whose top has
  // scrolled to/past the container top. Stops measuring at the first row below
  // the top (rows are in order), so it's ~O(rows above the fold) per sweep.
  function bottommostReadFromDom(): string | undefined {
    if (!scrollEl) return undefined;
    const cTop = scrollEl.getBoundingClientRect().top;
    const rows: { id: string; top: number }[] = [];
    for (const m of messages()) {
      const el = scrollEl.querySelector(`[data-mid="${cssEsc(m.id)}"]`) as HTMLElement | null;
      if (!el) continue; // unmounted (lazy) — can't measure; skip
      const top = el.getBoundingClientRect().top - cTop;
      rows.push({ id: m.id, top });
      if (top > 0) break; // first row below the top ends the sweep
    }
    return bottommostReadWithFallback(rows);
  }
  // Is `cand` ahead of (or equal-and-newer than) the stored anchor in message
  // order? Drives the monotonic guard. A missing/stale stored anchor is treated
  // as behind, so the first write always lands. Extracted as the pure
  // `orderAhead` helper in lib/scroll (the `order` array is threaded explicitly
  // at the call site above so the helper has no closure captures and is unit-
  // tested in tests/unit/scroll.test.ts).
  function maybeRestore() {
    if (restoredFor === props.sessionId || !scrollEl) return false;
    const anchor = props.draft ? undefined : getReadAnchor(props.sessionId);
    if (anchor) {
      // Defer until the session's message snapshot has arrived (order non-empty).
      // On a fresh page reload, the rAF fallback / an early RO can fire before
      // the network delivers messages — without this guard the anchor row
      // wouldn't exist yet, we'd fall to the bottom, mark restoredFor, and lose
      // the anchor for good. Returning false (without setting restoredFor) lets
      // the next RO (fired when messages land and contentEl grows) retry the
      // restore. NOTE: keyed off order LENGTH, not object truthiness — openSession
      // (sync/actions.ts) pre-initializes the message slot to a truthy-but-empty
      // {order:[],byId:{}} the instant a session is selected, so sm() is truthy
      // BEFORE the real snapshot arrives; an empty order means "not delivered yet".
      //
      // delivered() gate (pre-select-hydration race fix): if messagesDelivered has
      // already flipped true while the order is STILL empty, there is nothing
      // left to wait for — either the session is genuinely empty (the stale-
      // anchor branch below pins to bottom + setReady, revealing the empty
      // state), or the batch already staged before the gate flip (pendingBatch
      // coordination in stream.ts guarantees messagesDelivered flips AFTER the batch
      // resolves). Without this gate the empty-order defer returned false
      // FOREVER for a stored anchor → ready() never set → revealed() false →
      // the pre-selected session stayed blank until a manual switch-away+back.
      if (!sm()?.order?.length && !delivered() && !messageFailed()) return false;
      // Defer until the seeded ANCHOR specifically has arrived — not just any
      // message. The length guard above only blocks the empty-order window. Lazy
      // hydration then streams a PARTIAL snapshot: the store's
      // reconcileMessagesLocked emits one message.upsert per message in a loop,
      // so order grows one id at a time BEFORE messages.loaded flips delivered()
      // (~:254). An RO can fire when order=["m1"] (length truthy → guard passes)
      // but the seeded anchor (e.g. m4) isn't in it yet. Restoring then would
      // miss the anchor, fall into the stale-anchor pin below, and — restoredFor
      // already set — lock out every later retry, yanking the reader to the live
      // tail and losing their read position. Defer (return false, no restoredFor)
      // until EITHER the anchor lands in order OR delivery completes.
      //
      // The !delivered() gate is what keeps a GENUINELY-stale anchor (post
      // full-delivery the id is simply absent — deleted/truncated history) from
      // wedging the view: once delivered() is true (and per-message upserts are
      // all processed before messages.loaded, the anchor is guaranteed in order
      // if it exists at all) we stop deferring and fall through to the pin
      // below. restoredFor is set only AFTER this check so a no-op deferral
      // never locks out retries.
      const order = sm()?.order ?? [];
      if (!order.includes(anchor) && !delivered() && !messageFailed()) return false;
      restoredFor = props.sessionId;
      // Position the anchor at the top of the viewport (instant — no smooth
      // flash on restore). The message ROW ([data-mid]) always exists in the
      // DOM; only its heavy parts are lazy-mounted (Deferred), so this works
      // even for a mid-conversation anchor — the parts mount as they near the
      // viewport right after, and browser scroll-anchoring (overflow-anchor:
      // auto) absorbs the off-screen height changes as deferred content fills in.
      const el = scrollEl.querySelector(`[data-mid="${cssEsc(anchor)}"]`) as HTMLElement | null;
      if (el && order.includes(anchor)) {
        setFollowing(false);
        // Restored to a mid-history anchor = genuine read intent (we land away
        // from the bottom). Arm the latch like the scroll-away arm (~:812) so
        // the busy-edge self-heal effect (~:390, edge && !userScrolledUp()) does
        // NOT yank the reader off this anchor to the tail on reopen of a busy
        // session. The stale/no-anchor branches below arm false because they
        // land AT the bottom (system restore = follow intent reset).
        setUserScrolledUp(true);
        const delta = el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
        scrollEl.scrollTop += delta;
        // Record the logical anchor + baseline geometry so the content RO can
        // measure anchorDelta on later hydration/load-more and correct a
        // frozen viewport mechanically (overflow-anchor:auto is assist-only).
        restoredAnchorId = anchor;
        restoredAnchorOffset = anchorContentOffset(el);
        pinnedGeom = geom(scrollEl);
      } else {
        // Stale anchor (message since deleted) — fall back to the bottom.
        setFollowing(true);
        setUserScrolledUp(false); // system restore to bottom — not user intent
        pin();
      }
    } else {
      restoredFor = props.sessionId;
      setFollowing(true);
      setUserScrolledUp(false); // opened at the bottom — not user intent
      pin();
      // Pinned to the bottom on open — no scroll event fires for a programmatic
      // position, so onScrolled/ackSession never runs (and even a synthetic
      // scroll from pin() is skipped by the self-pin sentinel in onScrolled).
      // Ack explicitly so the finished-unread dot clears immediately when a
      // finished session is opened already at the bottom. The anchor branch
      // above deliberately does NOT ack — a restored mid-history anchor means
      // the user had NOT read to the bottom.
      if (!props.draft) ackSession(props.sessionId, { force: true });
    }
    setReady(true); // positioned — safe to reveal
    return true;
  }
  // When the (reused) view switches sessions, arm a restore for the new one and
  // hide it until that restore positions it. The leaving session's read cursor is
  // written on scroll-idle by the debounced observer; we cancel any pending
  // debounce here because measuring geometry now would record the WRONG session —
  // by the time this effect runs the memo/DOM have already flipped to the entering
  // session.
  //
  // P1-WEB-004 — the <400ms switch gap is closed via an arm-time stash.
  // scheduleReadCursor captures (sid, bottommostReadFromDom) on a throttled
  // leading edge (≤5/sec) as the user scrolls, so the OUTGOING session's
  // last-known read position survives even when the 400ms debounce is still
  // pending at switch time. The effect body below flushes that stash (monotonic
  // guard against the OUTGOING session's order, NOT sm()?.order — that's already
  // the entering session here) BEFORE clearing the pending debounce. Measuring per
  // scroll FRAME was NOT an option — the throttled leading edge is a CPU
  // layout-read (reads-only, one flush) at ≤5/sec, idle during streaming,
  // categorically distinct from the per-frame GPU re-raster heat saga
  // (AGENTS.md "Web frontend performance").
  //
  // The stash is invalidated at every anchor-clear site (flushReadCursor
  // nearBottom branch + onScrolled atBottom branch): a scroll-up →
  // return-to-bottom → switch sequence must NOT re-apply a stale mid-history
  // anchor on switch.
  createEffect(
    on(
      () => props.sessionId,
      (id, prevId) => {
        // P1-WEB-004: flush the arm-time stash for the OUTGOING session before the
        // debounce is cancelled. Monotonic guard against the outgoing session's order
        // (NOT sm()?.order — that's the entering session at this point).
        // P1-WEB-004: flush the arm-time stash for the OUTGOING session before the
        // debounce is cancelled. Monotonic guard against the outgoing session's order
        // (NOT sm()?.order — that's the entering session at this point). The peek
        // guard defers the anchor/order reads to the matching-stash path, matching
        // the inlined original (both reads are pure; on() untracks this body too).
        const stashed = readStash.peek();
        if (prevId && stashed && stashed.sid === prevId) {
          const order = state.messages[prevId]?.order ?? [];
          const decision = readStash.flushForOutgoing(prevId, getReadAnchor(prevId), order);
          if (decision.write && decision.cand) setReadAnchor(prevId, decision.cand);
        }
        readStash.consume(); // consumed; entering session re-arms on its own scroll
        if (prevId) clearTimeout(readCursorTimer);
        // Reset the geometry baseline: it's stale from the leaving session, and
        // an anchor restore doesn't pin to refresh it — so without this reset the
        // content RO delta could be measured against a stale-large value when the
        // user later reaches a shorter session's bottom. {-1,-1,-1} is the "no
        // valid snapshot yet" sentinel, so the first real pin after switch
        // proceeds normally.
        pinnedGeom = { scrollTop: -1, scrollHeight: -1, clientHeight: -1 };
        restoredAnchorId = undefined;
        restoredAnchorOffset = -1;
        restoredFor = "";
        setReady(false);
        // Fallback reveal: if no content change fires the ResizeObserver (so
        // maybeRestore never runs), position + reveal on the next frame anyway.
        requestAnimationFrame(() => {
          if (!ready()) maybeRestore();
        });
        void id;
      },
    ),
  );
  // P1-WEB reveal-gate self-heal (O1 collapsed-frontier): the cold-stub load
  // delivers a session in TWO SSE frames — messages.batch grows the DOM (a
  // content ResizeObserver fires maybeRestore, but if the user's stored read
  // anchor isn't in the partial order yet, maybeRestore defers at ~:792 WITHOUT
  // setting ready), then messages.loaded flips delivered()=true but adds NO DOM
  // → the ResizeObserver does NOT re-fire → maybeRestore never runs again →
  // ready stays false → revealed() false → the transcript is stuck at
  // opacity:0 forever (switch-away+back worked because on the 2nd visit the
  // messages were resident AND delivered, so the ~:792 defer was bypassed). This
  // effect re-runs maybeRestore precisely when delivered()/messageFailed()
  // flip: with delivered() now true the ~:792 defer condition is false, so
  // maybeRestore proceeds and sets ready. Safe + idempotent: maybeRestore
  // early-returns once restoredFor===sid (set exactly when ready flips true), so
  // this is a no-op once the view is restored. `on(...)` limits re-runs to the
  // delivered/messageFailed signals only — NOT to the many reads inside
  // maybeRestore (order, geometry) — so this can't hot-loop on streaming.
  createEffect(
    on(
      () => delivered() || messageFailed(),
      () => {
        if (!ready()) maybeRestore();
      },
    ),
  );
  // P1-WEB reveal-gate latch arming: whenever the BASE reveal condition
  // (positioned + delivered/failed) becomes true for THIS session — via ANY
  // maybeRestore entry path (ResizeObserver, the rAF fallback, or the
  // delivered-flip self-heal above) — record the session id in the latch so a
  // later transient delivered() drop can't re-strand the shown transcript. Reads
  // only reactive signals (no DOM), so it re-runs exactly on those flips.
  createEffect(() => {
    if (ready() && (delivered() || messageFailed())) setRevealedOnce(props.sessionId);
  });
  createEffect(() => {
    const hidden = !props.draft && !revealed();
    if (!hidden) {
      setShowLoading(false);
      return;
    }
    const t = window.setTimeout(() => setShowLoading(true), 150);
    onCleanup(() => clearTimeout(t));
  });
  // Reactive ack: covers "session finished WHILE the user was already glued to
  // the bottom watching it". The server sends an unread.set event → the dot
  // appears — but no scroll event fires (the viewport didn't move), so
  // onScrolled/ackSession never runs and the dot sticks until a manual scroll.
  // This effect acks when unread is set AND we're following AND at the bottom.
  // Reactivity keys off unread/following/ready (signals), NOT off nearBottom()
  // (a live DOM geometry read) — so it re-runs only when those signals change,
  // never per scroll frame. The unread gate keys off the ROOT id (rootOf), not
  // the raw session id: state.unread is keyed by root server-side, so a
  // subsession viewer glued to its bottom also sees its root's dot clear
  // (matching onScrolled's ackSession, which resolves to root internally — the
  // ackSession call below still takes the raw id for the same reason). Loop-
  // safety: ackSession clears the very signal this effect tracks
  // (setState("unread", root, undefined)) and early-returns when
  // !state.unread[root], so it can't re-trigger. (attendingNow() only governs
  // notification markRead, not the unread clear.)
  createEffect(() => {
    // Re-evaluate when the RO re-pins to the bottom (repinTick) — see decl. The
    // signal reads below are what make this effect reactive; repinTick closes
    // the gap where nearBottom() is a non-reactive DOM read.
    repinTick();
    if (props.draft || !ready() || !following()) return;
    if (!state.unread[rootOf(props.sessionId)]) return;
    if (!nearBottom()) return;
    ackSession(props.sessionId);
  });
  // Re-pin through every height change (new message, streaming tokens, and the
  // raw→rendered-HTML swap) — but only while following. Restore first if pending.
  onMount(() => {
    if (!contentEl) return;
    // The navigator highlight is an O(turns) getBoundingClientRect sweep; running
    // it on every streamed height change is wasteful. Debounce it so it recomputes
    // once content settles. `pin()` stays per-fire (cheap) so following stays glued
    // — a trailing debounce there would stop auto-scroll during a continuous stream.
    let navDebounce: number | undefined;
    const ro = new ResizeObserver(() => {
      if (maybeRestore()) return;
      if (!scrollEl) return;
      const current = geom(scrollEl);
      // Single scroll-action gate per cycle: tail-follow XOR read-anchor, never
      // both. following() picks the axis; maybeRestore already returned above if
      // it owned this cycle. The dual-axis reducer decomposes content-delta +
      // viewport-delta + clamp and treats genuine user scroll-intent as the
      // RESIDUAL — replacing the single-axis `scrollTop < pinnedTop && !shrank`
      // guard that deadlocked on simultaneous content-grow + viewport-shrink
      // (typing during a live stream / composer grow).
      if (following()) {
        const d = classifyScrollDelta({ previous: pinnedGeom, current, mode: "tail", following: true });
        if (d.intent === "user-scroll-up") {
          // Genuine scroll-away since the last pin (residual outside epsilon
          // after content+viewport+clamp accounted). Let it win; do NOT pin.
          setFollowing(false);
          setUserScrolledUp(true);
        } else if (d.shouldScroll && d.newScrollTop !== undefined && !holdActive()) {
          // Layout churn (grow/shrink/viewport resize) while still following:
          // re-glue to the bottom. Epsilon-guarded inside the reducer against
          // no-op churn. SUPPRESSED while the operator is interacting with the
          // PendingInput blocker (holdActive) — see the signal's declaration
          // for the safety invariant. The classifier still runs (above) so
          // intent/gates advance normally; only this one write is skipped.
          scrollEl.scrollTop = d.newScrollTop;
        }
        // Nudge the reactive ack to re-check nearBottom() now that geometry
        // settled (closes the late-arm window described at repinTick's decl).
        setRepinTick((t) => t + 1);
      } else if (restoredAnchorId) {
        // Read mode: preserve the logical anchor through grow/shrink ABOVE the
        // viewport that overflow-anchor:auto failed to track (hydration,
        // load-more, reasoning-block fill-in). Measure the anchor's content-
        // coordinate shift and route it through the reducer; a frozen viewport
        // is corrected mechanically instead of mistaken for user intent.
        const ael = scrollEl.querySelector(`[data-mid="${cssEsc(restoredAnchorId)}"]`) as HTMLElement | null;
        if (ael) {
          const off = anchorContentOffset(ael);
          const anchorDelta = restoredAnchorOffset >= 0 ? off - restoredAnchorOffset : 0;
          const d = classifyScrollDelta({ previous: pinnedGeom, current, mode: "read", following: false, anchorDelta });
          if (d.shouldScroll && d.newScrollTop !== undefined) {
            scrollEl.scrollTop = d.newScrollTop;
          }
          restoredAnchorOffset = off; // advance measured baseline
        }
      }
      // Advance the geometry baseline to the settled state (after any write +
      // browser clamp) so the next RO computes an incremental delta.
      pinnedGeom = geom(scrollEl);
      clearTimeout(navDebounce);
      navDebounce = window.setTimeout(navigator.scheduleActiveTurn, 150);
    });
    ro.observe(contentEl);
    onCleanup(() => {
      ro.disconnect();
      clearTimeout(navDebounce);
      // Flush the current session's read cursor before the reused view unmounts
      // (e.g. navigating to settings). At unmount the DOM still reflects this
      // session, so the geometry sweep is valid here (unlike on session switch).
      clearTimeout(readCursorTimer);
      if (scrollEl && !props.draft) flushReadCursor(props.sessionId);
    });
  });

  // Track the scroll-area height to size the navigator window (how many ticks fit).
  onMount(() => {
    navigator.measureNavCap();
    if (!scrollEl) return;
    const ro = new ResizeObserver(() => {
      navigator.measureNavCap();
      // Viewport resized (window resize, mobile keyboard toggle, composer
      // grow/shrink, layout shift). When following, re-glue to the bottom: a
      // viewport SHRINK leaves scrollTop ~unchanged while the bottom edge moves
      // DOWN, so without this re-pin we'd sit "Live" but not at the tail. Gated
      // on ready() so initial scroll-restore (maybeRestore) owns positioning.
      //
      // When NOT following, re-engage ONLY for the genuine "stuck on ↓ Latest"
      // recovery: a pure clientHeight GROW (composer shrink / keyboard dismiss)
      // fires this RO but NO scroll event, so onScrolled can't recover it — the
      // RO must re-engage `following` when the grow lands a near-tail reader back
      // at the bottom. Two gates, BOTH required:
      //   (1) NOW at the bottom — nearBottom()'s 24px standard (the SAME
      //       definition onScrolled's reached-bottom re-glue and the jump pill
      //       use). NOT classifyScrollDelta's 1px atBottom: a composer-shrink
      //       recovery lands ~10px from the bottom — "at the bottom" by the
      //       user-facing 24px line, yet outside the reducer's strict 1px, so the
      //       reducer classifies it intent="none" and would skip it (bug-2b).
      //   (2) WAS near the tail pre-resize — the baseline (pinnedGeom) gap is
      //       within RECOVERY_TAIL_GAP. onScrolled advances pinnedGeom to the
      //       settled geometry on EVERY scroll, so a deliberate ~30px one-line
      //       scroll-up that dropped following leaves a ~30px baseline gap; this
      //       gate must be WIDER than nearBottom's 24px to admit that nudge.
      //
      // bug-2b vs P1-WEB-042 tension: bug-2b (scroll up ~30px, then composer
      // shrink lands at the bottom) MUST recover; P1-WEB-042 (a mid-history
      // reader ~300px up whose viewport merely GREW to overlap the bottom) must
      // NOT be yanked. The distinguishing signal is the pre-resize gap MAGNITUDE
      // (near-tail vs mid-history), NOT the grow size: both can carry a large
      // clientHeight grow, so a grow-magnitude or grow-explains-gap test cannot
      // separate them (a 320px grow closes both a 10px and a 300px gap). Only
      // the absolute baseline gap can — hence gate (2) is a gap threshold. See
      // RECOVERY_TAIL_GAP for the value rationale. contentDelta is structurally
      // ~0 here (the container's own height change moves clientHeight, not
      // scrollHeight — content changes fire the contentEl RO instead).
      if (!scrollEl || !ready()) return;
      if (following()) {
        pin();
      } else {
        if (!nearBottom()) return; // (1) resize left a material gap — nothing to recover
        const prev = pinnedGeom;
        // (2) pre-resize gap; {-1,-1,-1} sentinel (pre-first-pin) → never recover.
        const prevGap =
          prev.scrollHeight >= 0
            ? prev.scrollHeight - prev.scrollTop - prev.clientHeight
            : Infinity;
        if (prevGap < RECOVERY_TAIL_GAP) {
          setFollowing(true);
          setUserScrolledUp(false);
          pin();
        }
      }
    });
    ro.observe(scrollEl);
    onCleanup(() => ro.disconnect());
  });

  // Scroll handling: track follow state, advance the read cursor (debounced),
  // and mark the session read (ack) when its bottom is reached.
  function onScrolled() {
    if (!scrollEl) return;
    if (!ready()) return;
    const current = geom(scrollEl);
    // Own-pin bail (perf guard): a scroll event whose offset matches our last
    // programmatic pin is our own write, not user input — skip the per-frame
    // nearBottom/ack/navigator work. NOTE the && following(): this KEEPS
    // following true (just returns), which is the composer-grow deadlock fix —
    // the old code fell through and flipped following false because nearBottom()
    // was stale after the viewport moved. Tolerate ≤1px sub-pixel drift.
    if (following() && Math.abs(current.scrollTop - pinnedGeom.scrollTop) <= 1) return;
    // Classify the transition through the dual-axis reducer: content-delta +
    // viewport-delta + clamp are accounted for, and genuine user scroll-intent
    // is the RESIDUAL. This replaces the single-axis `shrank` guard that
    // mis-fired on simultaneous viewport-shrink + content-grow.
    const d = classifyScrollDelta({
      previous: pinnedGeom,
      current,
      mode: following() ? "tail" : "read",
      following: following(),
    });
    if (d.intent === "reached-bottom") {
      // Re-engage following (scroll-back-to-bottom, or a clamp that landed us
      // at the bottom). Clear the intent latch + ack unread.
      setFollowing(true);
      setUserScrolledUp(false);
      if (!props.draft) {
        clearReadAnchor(props.sessionId);
        readStash.invalidateIfSession(props.sessionId);
        ackSession(props.sessionId);
      }
    } else if (d.intent === "user-scroll-up" || d.intent === "user-scroll-down") {
      // Genuine scroll-away from the tail (residual outside epsilon). Drop
      // following + arm the latch so the busy-edge self-heal does NOT yank the
      // reader. Schedule a debounced read-cursor write.
      setFollowing(false);
      setUserScrolledUp(true);
      if (!props.draft) scheduleReadCursor();
    } else {
      // intent === "none": layout churn (content/viewport resize fully
      // accounted for, residual within epsilon). Do NOT flip following — that
      // flip was the deadlock root. While following, the tail branch already
      // targeted the bottom; apply it so a viewport shrink re-glues. While not
      // following, preserve position (schedule a cursor read).
      if (following() && d.shouldScroll && d.newScrollTop !== undefined) {
        scrollEl.scrollTop = d.newScrollTop;
      } else if (!props.draft) {
        scheduleReadCursor();
      }
    }
    // Advance the baseline to the settled geometry (after any write) so the
    // next scroll/RO event computes an incremental delta.
    pinnedGeom = geom(scrollEl);
    navigator.scheduleActiveTurn();
  }

  const [focusMode, setFocusMode] = createSignal(false);

  // Auto-grow the composer up to a cap, then scroll; keep the highlight mirror
  // scrolled in lockstep.
  let taRef: HTMLTextAreaElement | undefined;
  // --- prompt-history recall (C5) ------------------------------------------
  // Extracted to createPromptHistory (a SolidJS `create...` controller factory,
  // mirroring createComposerAutocomplete / createQueueDrainer). The factory owns
  // the walk state machine (histMode/histIdx/histDraft), the Up/Ctrl+Up/Down
  // keyboard handler, and resetHistory — the single reset seam every
  // invalidation site calls (autocomplete onApplied, onInput, paste, inline
  // attach, session switch, send). The shared onKeyDown dispatcher (ac.onAcKeyDown
  // FIRST → send → hist.onHistoryKey LAST, preserving the autocomplete → send →
  // history precedence) moved to the Composer component (./chat/Composer.tsx)
  // with the rest of the composer JSX.
  const hist = createPromptHistory({
    input,
    setInput,
    textarea: () => taRef,
    sessionId: () => props.sessionId,
  });
  let mirrorRef: HTMLDivElement | undefined;
  // Command-palette "Focus composer" action.
  const onFocusComposer = () => taRef?.focus();
  onMount(() => window.addEventListener("vh:focus-composer", onFocusComposer));
  onCleanup(() => window.removeEventListener("vh:focus-composer", onFocusComposer));

  // Phase-4 load-older IntersectionObserver: when the top sentinel scrolls
  // within `rootMargin` of the viewport AND there's no page in flight, fire
  // `onLoadOlder()`. The `loadingOlder()` signal is the single-flight guard
  // (mirrors `pageInFlight` in stream.ts) so one page lands per intersection
  // signal — no auto-chaining. The sentinel is observed via a ref callback
  // (refs fire before onMount) so a remount when `hasOlder` flips back to true
  // after eviction re-observes correctly.
  onMount(() => {
    if (!scrollEl) return;
    loadMoreObserver = new IntersectionObserver(
      (entries) => {
        if (loadingOlder()) return;
        if (entries.some((e) => e.isIntersecting)) void onLoadOlder();
      },
      { root: scrollEl, rootMargin: "600px 0px 0px 0px" }
    );
    if (topSentinelEl) loadMoreObserver.observe(topSentinelEl);
  });
  onCleanup(() => {
    loadMoreObserver?.disconnect();
    loadMoreObserver = undefined;
    topSentinelEl = undefined;
  });

  // --- composer autocomplete (@file / @agent / /command) ---------------------
  // Extracted to createComposerAutocomplete (a SolidJS `create...` controller
  // factory, mirroring createQueueDrainer). The factory owns the suggestion
  // state machine (caret-driven activeToken detection + agent filter + async
  // command/file fetch with a stale-request guard), keyboard navigation, and
  // applyAc. The presentational popover JSX + acStyle() positioning (reads the
  // composer rect) + the shared onKeyDown dispatcher moved to the Composer
  // component (./chat/Composer.tsx): ac.onAcKeyDown FIRST → send →
  // hist.onHistoryKey LAST (C5 hooks the prompt-history controller into that
  // dispatcher).
  //
  // onApplied is the C5 seam: it calls hist.resetHistory() (the prompt-history
  // controller's reset) whenever an item is applied, so an in-flight history
  // walk doesn't leak a recalled value onto a freshly-spliced token.
  const ac = createComposerAutocomplete({
    input,
    setInput,
    agents,
    textarea: () => taRef,
    sessionId: () => props.sessionId,
    draft: () => !!props.draft,
    onApplied: () => hist.resetHistory(),
  });
  // --- attachments (C6) -----------------------------------------------------
  // Extracted to createAttachments (a SolidJS `create...` controller factory,
  // mirroring createComposerAutocomplete / createPromptHistory /
  // createComposerPaste / createQueueSync). The factory owns the attachment
  // signals (attachments/uploading), the inline-mode token<->File<->text Map
  // (inlineFiles), the presentInlineIds orphan-truth memo, and the pipeline
  // (addFiles/remove/reinsert/flush/upload). This view keeps ONLY the
  // attachment-chip JSX (<For>, orphan accessor reads via presentInlineIds),
  // the send() flow's own orchestration (resolveInlineAttachments +
  // ownership-snapshot clear, which reads attachments()/setAttachments/
  // inlineFiles RETURNED here), and buildParts.
  //
  // syncCaret is the C3 seam (caret sync after an inline markdown-ref insert so
  // autocomplete token detection tracks the new caret). onInlineInsert is the C5
  // seam (reset prompt-history walk cursors: the inline insert bypasses the
  // textarea onInput that would reset history naturally). inlineActive is
  // precomputed here as effectiveInline(modelHasVision(curModel()),
  // inlineAttachForced()) so the factory owns NO model/vision/pref concern.
  const inlineActive = () => effectiveInline(modelHasVision(curModel()), inlineAttachForced());
  const att = createAttachments({
    input,
    setInput,
    textarea: () => taRef,
    sessionId: () => props.sessionId,
    draft: () => !!props.draft,
    fileInput: () => fileInputRef,
    inlineActive,
    syncCaret: () => ac.syncCaret(),
    onInlineInsert: () => hist.resetHistory(),
  });
  // --- composer paste/clipboard (C4) ---------------------------------------
  // Extracted to createComposerPaste (a SolidJS `create...` controller factory,
  // mirroring createComposerAutocomplete / createPromptHistory). The factory
  // owns the textarea onPaste (harvest pasted files/images → addFiles), the
  // paste button's async Clipboard-API read (pasteFromClipboard: insert-at-
  // caret vs replace-all), and the paste button's tap-vs-hold classification
  // (classifyHold from lib/copyHold). This view keeps ONLY the addFiles
  // IMPLEMENTATION (attachment rendering + geometry) + the presentational
  // button JSX: the factory returns the event handlers wired into that JSX.
  //
  // syncCaret is the C3 seam (caret sync after a clipboard-API text insert so
  // autocomplete token detection tracks the new caret). onTextInsert is the C5
  // seam (reset prompt-history walk cursors: the button bypasses the textarea,
  // so the natural onInput that would reset history never fires).
  const paste = createComposerPaste({
    input,
    setInput,
    textarea: () => taRef,
    syncCaret: () => ac.syncCaret(),
    addFiles: (files) => void att.addFiles(files),
    onTextInsert: () => hist.resetHistory(),
  });

  // --- queue recovery (retract-to-compose + mark-sent) ---------------------
  // Extracted to createQueueRecovery (a SolidJS `create...` controller factory,
  // mirroring createAttachments / createComposerAutocomplete / createPromptHistory
  // / createComposerPaste) so the recovery state machine (occupied-composer
  // guard → confirm-delete-first → restore text → filter attachments → reset
  // transient state → best-effort focus, plus the mark-sent resolve) is unit-
  // testable in isolation. This view keeps ONLY the wiring: it passes its own
  // signals/closures + the existing reset seams (ac.dismissAc, hist.resetHistory)
  // + the observable removeQueued (Slice 1) and the existing resolveQueued. The
  // recovery actions are exposed to QueueChip at the queue render site below.
  // INVARIANTS: retract NEVER enqueues/repends (it deletes + restores text; the
  // subsequent Send enqueues a NEW item). markSent NEVER enqueues/dispatches —
  // it only resolves an `unknown` item to terminal `sent`. dispatching stays
  // non-removable (retract confirms the DELETE before touching the composer).
  const recovery = createQueueRecovery({
    sessionId: () => props.sessionId,
    input,
    setInput,
    attachments: att.attachments,
    setAttachments: (next) => att.setAttachments(next),
    dismissAutocomplete: () => ac.dismissAc(),
    resetHistory: () => hist.resetHistory(),
    textarea: () => taRef,
    removeQueued,
    resolveQueued,
    notify: (n) => pushNotification({ ...n, sessionID: props.sessionId }),
  });

  const MAX_COMPOSER_PX = 200;
  function autosize() {
    const ta = taRef;
    if (!ta) return;
    // Capture the bottom-anchor state BEFORE resizing: growing/shrinking the
    // composer changes .chat-scroll's clientHeight (they share the flex column),
    // and the async scrollEl ResizeObserver that normally re-glues the tail can
    // land a frame late (visible jump) or be skipped when following()==false yet
    // the user is still near the bottom — leaving scrollTop fixed and tucking the
    // tail UNDER the composer. Pinning here, synchronously in the same frame as
    // the keystroke, keeps distFromBottom≈0 (latest content stays visible, no
    // transient) in BOTH idle and working states. `nearBottom()` is read against
    // the PRE-resize geometry so a grow that pushes distFromBottom past the
    // re-engage threshold is still corrected. ready() gates session-switch
    // scroll-restore (maybeRestore owns positioning during the switch→ready
    // window). The scrollEl RO re-confirms after layout (idempotent) and owns
    // non-typing resizes (window resize, mobile keyboard toggle).
    const stick = !!scrollEl && ready() && (following() || nearBottom());
    if (focusMode()) {
      ta.style.height = "100%";
    } else {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, MAX_COMPOSER_PX) + "px";
    }
    if (mirrorRef) mirrorRef.scrollTop = ta.scrollTop;
    // Re-pin so the tail stays visible. pin() (not a raw scrollTop write) so the
    // geometry baseline pinnedGeom advances in lockstep — otherwise the scroll
    // event from this pin fails onScrolled's own-pin bail (|Δ|>1 once streaming
    // content has grown the tail since the last baseline) and following is
    // mis-classified away. Cheap: one layout per keystroke, not per scroll frame.
    if (stick) pin();
  }
  // Re-measure after any value change (typing, draft restore, send-clear).
  // requestAnimationFrame (not queueMicrotask): autosize reads ta.scrollHeight,
  // which is layout-derived. On a session switch-back the draft-restore
  // setInput() fires this effect, but a microtask ran BEFORE the browser's
  // style-recalc/layout phase of the frame, so scrollHeight was stale (the
  // PREVIOUS session's content) and the composer collapsed toward rows=1 until
  // the next keystroke re-measured. rAF defers the measure past the layout
  // flush, so scrollHeight reflects the restored content. (jsdom has no layout
  // engine; covered by a faithful stale-scrollHeight contract test.)
  createEffect(() => {
    input();
    focusMode();
    requestAnimationFrame(autosize);
  });

  // Focus-mode toggle re-glue (test 110 / focus-toggle flake): toggling focus
  // resizes the composer dramatically (textarea → height:100%), firing scroll
  // events whose browser-anchor shift can spuriously drop following at the tail
  // before autosize's pin runs — leaving the reader "stuck on ↓ Latest" once the
  // turn finishes, with no recovery (the gap left by the resize exceeds the RO
  // recovery's nearBottom band). Preserve tail-following across the resize:
  // capture following() in the SAME reactive tick as the toggle (a signal read,
  // so NO layout reflow — the value is the PRE-toggle state, before any resize
  // scroll event has fired), then restore + re-pin after the layout settles
  // (rAF). Gated on wasFollowing so a reader who scrolled up is NOT yanked
  // (P1-WEB-042; test 5 toggles focus while scrolled-up and expects the Latest
  // button to stay suppressed). Complements the classifyScrollDelta viewport-
  // churn guard in lib/scroll.ts, which handles the common case but cannot cover
  // every anchor-shift magnitude under a large composer resize.
  createEffect(
    on(
      () => focusMode(),
      (_v, prev) => {
        if (prev === undefined || !scrollEl || !ready()) return;
        const wasFollowing = following();
        requestAnimationFrame(() => {
          if (!wasFollowing || !scrollEl || !ready()) return;
          setFollowing(true);
          setUserScrolledUp(false);
          pin();
        });
      },
    ),
  );

  // Reset to bottom + restore this session's saved draft when switching sessions.
  createEffect(
    on(
      () => props.sessionId,
      () => {
        setFollowing(true);
        setUserScrolledUp(false); // entering a session = fresh follow intent
        // Defense-in-depth (commit-review tier1_b/F1): PendingInput now releases
        // its hold on unmount, but if a prior session's card unmounted mid-
        // interaction AND its cleanup ran inside the session-switch transition,
        // a stale holdActive could survive. Reset it here alongside the other
        // transient scroll-state resets so a fresh session always starts unheld.
        setHoldActive(false);
        // Reset prompt-history walk cursors on session switch so an Up/Ctrl+Up
        // walk started in the previous session doesn't leak its index/mode into
        // the new session's recall.
        hist.resetHistory();
        setInput(loadVersioned<string>(draftKey(props.sessionId || "__new__"), 1, "", (o) => (typeof o === "string" ? o : "")));
        // Pin to bottom on the next frame — but only if we're still following.
        // This races the chat-scroll session-switch restore (maybeRestore): if the
        // restored session had a stored mid-history anchor, maybeRestore's anchor
        // branch runs between this effect and the rAF and sets following=false
        // (positioning the viewport at the anchor). An unconditional pin() here
        // would then yank the reader off the anchor to the live tail and clear the
        // seed. Guard on following() — every other pin() caller (self-heal, resume,
        // both ROs) already gates on it; this was the lone unguarded caller. When
        // maybeRestore restored an anchor (following=false) the pin is skipped; when
        // it pinned to bottom itself (no-anchor/stale branch) or hasn't run yet,
        // following stays true and the backstop pin proceeds unchanged.
        requestAnimationFrame(() => {
          if (following()) pin();
        });
      },
    ),
  );
  // Persist the draft per session as the buffer changes.
  //
  // WHY this effect keys off input() ONLY (via on(input, ...)) and NOT
  // props.sessionId: the draft-restore effect above reloads the target
  // session's draft into input() on a session switch. If THIS save effect
  // also depended on props.sessionId, a bare session-switch would re-run it
  // with the STALE buffer (the previous session's text, before the restore
  // effect's setInput has taken effect for the new id) under the NEW key —
  // clobbering the target session's persisted draft with the previous
  // session's text. On a rapid switch sequence (A->B->A->B, or any browser
  // timing that interleaves restore-across-sid-changes with save) this
  // corrupts both slots so neither session's draft restores. Keying off
  // input() alone means save only fires when the buffer ACTUALLY changes,
  // by which point restore has already set it to the current session's
  // draft — so every write lands under the correct, current key. (Regression
  // test: web/tests/unit/ChatViewDraftPerSession.test.tsx.)
  createEffect(on(input, (v) => {
    const sid = props.sessionId || "__new__";
    if (v) saveVersioned(draftKey(sid), 1, v);
    else localStorage.removeItem(draftKey(sid));
  }));

  // In draft mode, materialize the server session on first send; otherwise use
  // the current session id.
  async function ensureSession(): Promise<string | null> {
    if (props.draft) return await createSession();
    return props.sessionId;
  }

  // C8: the send/dispatch cluster (buildParts, captureConfig, sendText,
  // dispatchQueuedItem, dispatchSend, runShell, send) is extracted to
  // ./chat/createSend so it can be exercised in isolation. The factory owns NO
  // session/composer/queue/transport state — it is all injected as deps here.
  // retry() (in createMessageActions below) calls resendText; the drainer below
  // forwards to dispatchQueuedItem (config capture moved inside that method,
  // matching queueDrain.ts's `dispatch` signature). undo/redo are injected as
  // lazy closures: createSend needs them, but they live in createMessageActions
  // which needs resendText FROM createSend — a cycle. Both deps are consumed
  // lazily (undo/redo at send-time for "/undo" "/redo"; resendText at retry-
  // click-time), so a forward declaration bridges it. msgActions is assigned
  // synchronously right after createSend returns, before any user interaction.
  let msgActions: MessageActions;
  const { send, resendText, dispatchQueuedItem } = createSend({
    sessionId: () => props.sessionId,
    draft: () => !!props.draft,
    ensureSession,
    input,
    setInput,
    readyToSend,
    working,
    queueMode,
    selectionFor,
    activeAgent,
    models,
    loadModels,
    // migrateModelPick is referenced lazily (via this closure) rather than
    // passed by value: pre-extraction it was only read inside send(), so some
    // ChatView test files mock ../../src/models without exporting it. A direct
    // pass would dereference the binding at component-construction and trip
    // vitest's mock-proxy validation in those tests; the closure defers the
    // read to send()-time, preserving the original lazy-reference semantics.
    migrateModelPick: (from, to) => migrateModelPick(from, to),
    curModel,
    enqueue,
    isSending,
    setSending,
    userScrolledUp,
    jumpToLatest,
    pushHistory,
    resetHistory: () => hist.resetHistory(),
    pushNotification,
    undo: () => msgActions.undo(),
    redo: () => msgActions.redo(),
    attachments: att.attachments,
    setAttachments: att.setAttachments,
    flushPendingAttachments: att.flushPendingAttachments,
    inlineFiles: att.inlineFiles,
    uploadFile: att.uploadFile,
    draftKey,
  });
  msgActions = createMessageActions({
    sessionId: () => props.sessionId,
    resendText,
  });

  // Wire the extracted drain state machine to ChatView's closures. The drainer
  // owns the `draining` flag + sending-guard lifecycle; the actual POST +
  // outcome classification + scroll/notification side effects live in
  // createSend's dispatchQueuedItem — the dispatch closure is now a plain
  // forward (config capture + field unpacking moved into that method).
  const queueDrainer = createQueueDrainer({
    canDrain: () => !props.draft && !working(),
    getId: () => props.sessionId,
    claim: claimQueued,
    dispatch: (id, claimed, signal) => dispatchQueuedItem(id, claimed, signal),
    resolve: resolveQueued,
    setSending,
    isSending,
    onResolved: (id) => void fetchQueue(id),
  });
  // C7: the queue-synchronization effects (drain-trigger on busy→idle + idle-
  // open-with-queue, session-open migrate+fetch, stream-reconnect refresh, the
  // ~5s poll while there is queue state, and the focus/visibility refresh +
  // cleanup) are extracted to ./chat/createQueueSync so they can be exercised
  // in isolation. Side-effect-only — it returns nothing; the queue-rendering
  // JSX below reads the cache directly from ../queue. The drainer itself stays
  // here (above); this factory only arms it via the `drain` dep.
  createQueueSync({
    sessionId: () => props.sessionId,
    draft: () => !!props.draft,
    working,
    streamStatus: () => state.status,
    queueFor,
    hasQueueState,
    migrateLegacyQueue,
    fetchQueue,
    drain: () => queueDrainer.drain(),
  });

  return (
    <div class="chat" classList={{ draft: props.draft }}>
      <Show when={props.draft}>
        <div class="chat-hero">
          <BrandMark class="chat-hero-mark" />
          <h2 class="chat-hero-title">Start a new session</h2>
          <p class="chat-hero-sub">
            Type your first message below — the session is created when you send.
          </p>
        </div>
      </Show>
      <Show when={!props.draft}>
      <div class="chat-main" ref={chatMainEl}>
      <div class="chat-scroll" ref={scrollEl} onScroll={onScrolled}>
        <div class="chat-content" ref={contentEl} classList={{ ready: revealed() }}>
          {/* Phase-4 load-older affordance. Rendered only when the server says
              older messages exist (`hasOlder`) AND a resident transcript is
              present AND this is not a draft. The top sentinel is observed by
              `loadMoreObserver` (IntersectionObserver, root: scrollEl). The
              "Load older" button is a manual fallback for touch / no-IO-support
              / when the user prefers an explicit signal. NO mask-image /
              backdrop-filter / contain / content-visibility on this surface
              (WebRender heat risk on always-present scroll containers). */}
          <Show when={hasOlder() && messages().length > 0 && !props.draft}>
            <div class="load-more-top">
              <Show when={loadingOlder()}>
                <span class="load-more-spinner"><Spinner size={14} /></span>
              </Show>
              <button
                type="button"
                class="load-more-btn"
                onClick={() => void onLoadOlder()}
                disabled={loadingOlder()}
              >
                {loadingOlder() ? "Loading…" : "Load older"}
              </button>
              <div
                ref={(el: HTMLDivElement) => {
                  topSentinelEl = el;
                  if (loadMoreObserver) loadMoreObserver.observe(el);
                }}
                class="load-more-sentinel"
                aria-hidden="true"
              />
            </div>
          </Show>
          <For each={messages()}>
            {(m, i) => (
              <MessageRow
                message={m}
                index={i}
                messageCount={() => messages().length}
                scrollRoot={() => scrollEl}
                lastActivityKey={lastActivityKey}
                messageFailed={messageFailed}
                inspected={() => msgActions.inspectId() === m.id}
                onToggleInspect={() => msgActions.toggleInspect(m.id)}
                onCopyText={() => msgActions.copyMessage(m)}
                onCopyWithThinking={() => msgActions.copyMessageWithThinking(m)}
                onFork={() => msgActions.fork(m.id)}
                onRetry={() => msgActions.retry(m)}
                inspectText={() => msgActions.inspectText(m)}
              />
            )}
          </For>
          {/* Transcript-level states: a loading hint while the first snapshot
              is in flight (slot reserved but not yet delivered), an empty hint
              once delivered-and-empty, or a failure hint if the background
              hydration errored. openSession pre-reserves a truthy-but-empty
              slot, so we key off `delivered` (messagesDelivered) / `messageFailed`,
              NOT sm() truthiness — otherwise "No messages" flashes before the
              snapshot lands. Per-message errors render inline above.

              Note on `messageFailed`: the reveal gate (`revealed()`) already
              unhides the transcript on failure so partial content is visible.
              This empty-state hint only renders when messages().length === 0 —
              so a FAILED fetch with NO partial content surfaces an explicit
              error rather than a blank/ambiguous "Loading…" that would never
              resolve (messages.loaded never arrives on failure). A non-empty
              failed transcript shows the streamed content; the inline role=alert
              is omitted there to avoid covering real messages. */}
          <Show when={messages().length === 0 && !working()}>
            <Switch>
              <Match when={messageFailed()}>
                <div class="chat-empty chat-error" role="alert">
                  Couldn’t load this conversation. Select it again to retry.
                </div>
              </Match>
              <Match when={delivered()}>
                <div class="chat-empty">No messages in this session yet.</div>
              </Match>
              <Match when={true}>
                <div class="chat-empty" role="status" aria-live="polite">Loading conversation…</div>
              </Match>
            </Switch>
          </Show>
          {/*
            Pending-input surfaces (QuestionCard / PermissionCard) render as the
            LAST item inside the chat-stream content container, not in a fixed
            bottom `.perms` strip. The PendingInput host owns the in-stream
            placement, the IntersectionObserver-driven jump pill (root =
            .chat-scroll), and is payload-agnostic — QuestionCard and
            PermissionCard plug in as children (composition, not a generic
            single-renderer). Questions render before permissions (arrival order
            is hard to track across two collections, but a session blocks on one
            item at a time in practice).
          */}
          <Show when={blockerActive() && !focusMode()}>
            <PendingInput
              scrollRoot={() => scrollEl}
              pillMount={() => chatMainEl}
              pillLabel={() => (pendingQuestions().length > 0 ? "Answer needed" : "Permission requested")}
              onJump={jumpToLatest}
              onHoldChange={(h) => setHoldActive(h)}
            >
              <For each={pendingQuestions()}>{(q) => <QuestionCard question={q as any} />}</For>
              <For each={pendingPermissions()}>{(p) => <PermissionCard sessionID={props.sessionId} perm={p} />}</For>
            </PendingInput>
          </Show>
        </div>
      </div>
        {/*
          Switch → ready loading overlay (sibling of .chat-scroll inside
          .chat-main — deliberately NOT inside .chat-content, which is hidden by
          the `ready` class). Covers the heavy-render window for a large session
          and hides the instant `revealed` flips. Gated on `revealed()` (not bare
          `ready()`) so the overlay stays up for the WHOLE partial-hydration
          window — without this the transcript would visibly populate behind a
          transparent overlay. See .chat-loading styles for the GPU-cheap
          rationale (no mask/backdrop-filter/contain/content-visibility).
        */}
        <Show when={!props.draft && !revealed() && showLoading()}>
          <div class="chat-loading" role="status" aria-live="polite">
            <Spinner size={20} />
            <span class="chat-loading-text">Loading…</span>
          </div>
        </Show>
        <ChatNavigator navigator={navigator} />
        {/*
          Local "following latest" cue (slice b). The only tail-anchored signal
          used to be the ABSENCE of the "↓ Latest" button. This adds a subtle
          positive indicator when the viewport is live-anchored to the tail.
          `following` is per-device (NOT synced), so this is a purely local cue.
          It's the complement of the jump button below: following() shows the live
          indicator; !following() shows "↓ Latest" — the two never render together,
          so they share the same anchor spot without conflict. Gated off drafts (a
          draft has no transcript to be "live" on). GPU-cheap: a tiny static pill
          with a slow opacity/scale pulse on a 7px dot only (no backdrop-filter,
          mask-image, or per-element contain/content-visibility — see AGENTS.md).

          Anchor: these are children of .chat-main (the scroll viewport), not of
          .chat (the whole column incl. the composer), so position:absolute bottom
          is measured from the scroll-area bottom — the pill sits just above where
          the composer begins, never on the textarea. See .jump/.chat-live styles.
        */}
        <Show when={following() && working() && !focusMode() && messages().length > 0}>
          <div class="chat-live" role="status" aria-label="Following latest">
            <span class="chat-live-dot" aria-hidden="true" />
            <span class="chat-live-text">Live</span>
          </div>
        </Show>

        <Show when={!following() && !focusMode() && messages().length > 0 && !blockerActive()}>
          <button type="button" class="jump" onClick={jumpToLatest}>
            <Icon name="arrowDown" size={14} /> Latest
          </button>
        </Show>
      </div>
      </Show>

      <ChatTasksStatus
        sessionId={props.sessionId}
        draft={props.draft}
        working={working}
        verb={verb}
        verbElapsed={verbElapsed}
        workingAriaLabel={workingAriaLabel}
      />

      <Composer
        draft={() => !!props.draft}
        sessionId={() => props.sessionId}
        isChild={isChild}
        parentId={parentId}
        onOpenParent={openParent}
        input={input}
        setInput={setInput}
        focusMode={focusMode}
        setFocusMode={setFocusMode}
        working={working}
        sending={sending}
        sendInFlight={sendInFlight}
        readyToSend={readyToSend}
        curModel={curModel}
        curVariant={curVariant}
        modelDialog={modelDialog}
        setModelDialog={setModelDialog}
        ac={ac}
        att={att}
        paste={paste}
        hist={hist}
        recovery={recovery}
        send={send}
        abort={msgActions.abort}
        refTa={(el) => (taRef = el)}
        refMirror={(el) => (mirrorRef = el)}
        refFileInput={(el) => (fileInputRef = el)}
        onPickFile={() => fileInputRef?.click()}
      />
    </div>
  );
}
