import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import { ackSession, createSession, currentVerb, isSending, loadOlder, markSessionIdle, openSession, rootOf, sessionWorking, setSelectedId, setSending, state } from "../sync";
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
import { highlightInput } from "../lib/composerHighlight";
import { chooseVariant, findModel, loadModels, migrateModelPick, models, selectionFor } from "../models";
import { loadVersioned, saveVersioned } from "../lib/store";
import { activeAgent, agentForSession, agents, selectAgentForSession, selectedAgent } from "../agents";
import { claimQueued, enqueue, fetchQueue, hasQueueState, migrateLegacyQueue, queueFor, queueMode, removeQueued, resolveQueued } from "../queue";
import { createQueueDrainer } from "../queueDrain";
import { historyAt, historyLen, pushHistory } from "../history";
import { type AcItem, commandSuggestions, fileSuggestions } from "../lib/complete";
import { harvestPastedFiles } from "../lib/paste";
import {
  effectiveInline,
  modelHasVision,
  inlineAttachForced,
  attachMarkdownRef,
  insertAtCaret,
  inlineAttachUrl,
  INLINE_LOCALID_PREFIX,
  isInlineChipUrl,
  resolveInlineAttachments,
  scanInlineTokens,
  inlineLocalIdFromUrl,
  isInlineChipOrphan,
  type ResolvedAttachment,
} from "../lib/inlineAttach";
import { IGNORED, isSendInFlight, runSendSingleFlight } from "../lib/sendSingleFlight";
import ModelDialog from "./ModelDialog";
import PartView, { ActivityGroup } from "./Part";
import { Deferred } from "./Deferred";
import ChatTasksStatus from "./ChatTasksStatus";

// Eager-mount the last N message rows (the tail you see on open + where new
// messages and the live stream land), so scroll-to-bottom and streaming stay
// correct; older rows mount lazily as they near the viewport (see Deferred).
const EAGER_TAIL = 30;
import QuestionCard from "./QuestionCard";
import PermissionCard from "./PermissionCard";
import PendingInput from "./PendingInput";
import { QueueChip } from "./QueueChip";
import Icon from "./Icon";
import Spinner from "./Spinner";
import { isDesktop } from "../layout";
import BrandMark from "./BrandMark";
import { pushNotification } from "../notify";
import { log } from "../lib/log";
import RelTime from "./RelTime";
import Select from "./Select";
import { agentDisplay } from "../projectSettings";
import { fmtTurnStats, turnStats } from "../usage";
import { msgTextOnly, msgTextWithThinking } from "../lib/msgText";
import { classifyHold, shouldSkipAfterContextmenu } from "../lib/copyHold";
import type { MessageView } from "../types";
import { agentLabel, costLabel, messageError, modelLabel, roleLabel } from "./chat/messageMeta";
import { MessageParts, groupParts } from "./chat/MessageParts";

const draftKey = (sid: string) => "vh.draft." + sid;

// Model/agent/variant a prompt is sent with (captured at queue time too).
type QueueConfig = { providerID?: string; modelID?: string; variant?: string; agent?: string };

// The agent label in a message head — plain @name. The COLORED per-agent badge
// (agentStyles) lives on the session-list rows, not here (deliberately keeping
// the transcript quiet).
function MsgAgent(props: { info: any }) {
  const name = () => agentLabel(props.info);
  return (
    <Show when={name()}>
      <span class="msg-agent" data-tip={`Agent: ${name()}`}>@{name()}</span>
    </Show>
  );
}

// Per-turn performance (tok/s · TTFT) for a SETTLED assistant turn, behind a
// hover ⓘ icon so the footer stays clean. Memoized — turnStats only walks parts
// for a completed assistant message (gated at the call site on role+completed),
// so it never runs for in-flight turns and never touches the streaming hot loop.
// The hover surface is a plain delegated `data-tip` tooltip (static text), so it
// is cheap to render and free of the GPU-punishing patterns (no backdrop-filter,
// mask-image, or contain) called out for the chat surface.
function MsgPerf(props: { m: MessageView }) {
  const tip = createMemo(() => {
    const s = turnStats(props.m);
    return s ? fmtTurnStats(s) : "";
  });
  return (
    <Show when={tip()}>
      <span class="msg-perf" data-tip={tip()} tabindex="0" aria-label="Turn performance">
        <Icon name="info" size={12} />
      </span>
    </Show>
  );
}

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
  // Pending attachments (file parts) to send with the next message.
  // `file` is set ONLY for draft-queued attachments (no server session yet):
  // the raw File is held locally and uploaded at send time, then `file` is
  // dropped and a real `url` takes its place (see flushPendingAttachments).
  interface Attachment { url: string; filename: string; mime: string; file?: File; path?: string }
  const [attachments, setAttachments] = createSignal<Attachment[]>([]);
  const [uploading, setUploading] = createSignal(false);
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
  const delivered = () => !!state.messagesLoaded[props.sessionId];
  // messageFailed: the active-session background hydration emitted
  // messages.error and the daemon left the session UNLOADED (it retries on next
  // selection/reconnect). The reveal gate falls back to this so a failed
  // hydration reveals whatever partial content was streamed instead of wedging
  // forever on a blank loading state (messages.loaded never arrives on failure).
  const messageFailed = () => !!state.messagesError[props.sessionId];
  // revealed: the VISUAL transcript reveal gate. This is the O2 fix for the
  // "transcript grows top-down" symptom: a large session's Slice-C async
  // hydration streams a PARTIAL snapshot (messagesLoaded=false) followed by
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
  // (messagesLoaded=false during a cold re-snapshot); the latch only protected
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
  // (applySessionSnapshot sets messagesLoaded=false on a cold re-snapshot). The
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
  // (Defined after `messages` — createMemo runs eagerly, so it must not read it
  // before init.)
  const userTurns = createMemo(() => messages().filter((m: any) => m.info?.role === "user"));
  const turnText = (m: any) => {
    const pid = (m.partOrder || []).find((id: string) => m.parts[id]?.type === "text");
    const t = (pid && m.parts[pid]?.text) || "";
    return t.replace(/\s+/g, " ").trim().slice(0, 140) || "(message)";
  };
  const cssEsc = (id: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id);
  const jumpToMsg = (id: string) => {
    scrollEl?.querySelector(`[data-mid="${cssEsc(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // Navigator highlight: the user turn currently at the top of the viewport, plus
  // a hover-preview bubble. Recomputed on scroll (rAF-throttled) — desktop only.
  const [activeTurn, setActiveTurn] = createSignal<string>("");
  const [navPreview, setNavPreview] = createSignal<{ text: string; y: number } | null>(null);
  let navRaf = 0;
  function updateActiveTurn() {
    navRaf = 0;
    if (!scrollEl) return;
    const turns = userTurns();
    if (!turns.length) return;
    const cTop = scrollEl.getBoundingClientRect().top;
    let active = turns[0].id;
    for (const m of turns) {
      const el = scrollEl.querySelector(`[data-mid="${cssEsc(m.id)}"]`) as HTMLElement | null;
      if (!el) continue;
      if (el.getBoundingClientRect().top - cTop <= 8) active = m.id;
      else break; // turns are in order; first one below the fold ends the scan
    }
    setActiveTurn(active);
  }
  function scheduleActiveTurn() {
    if (!navRaf) navRaf = requestAnimationFrame(updateActiveTurn);
  }
  // How many ticks fit at the fixed spacing (4px dot + 5px gap), leaving room for
  // the two indicators. Recomputed on resize.
  const [navCap, setNavCap] = createSignal(15);
  function measureNavCap() {
    if (!scrollEl) return;
    const usable = scrollEl.clientHeight - 20 /*insets*/ - 28 /*indicators*/;
    setNavCap(Math.max(5, Math.floor(usable / 9)));
  }
  // The visible window of ticks, centred on the active turn. When the whole set
  // fits (N <= cap) this is just all of them (identical to the old minimap).
  const navWindow = createMemo(() => {
    const turns = userTurns();
    const N = turns.length;
    const cap = Math.max(3, Math.min(navCap(), N));
    const ai = Math.max(0, turns.findIndex((t: any) => t.id === activeTurn()));
    let start = Math.max(0, Math.min(ai - Math.floor(cap / 2), N - cap));
    const end = Math.min(N, start + cap);
    return { items: turns.slice(start, end), start, end, total: N };
  });

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
      // delivered() gate (pre-select-hydration race fix): if messagesLoaded has
      // already flipped true while the order is STILL empty, there is nothing
      // left to wait for — either the session is genuinely empty (the stale-
      // anchor branch below pins to bottom + setReady, revealing the empty
      // state), or the batch already staged before the gate flip (pendingBatch
      // coordination in stream.ts guarantees messagesLoaded flips AFTER the batch
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
      navDebounce = window.setTimeout(scheduleActiveTurn, 150);
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
    measureNavCap();
    if (!scrollEl) return;
    const ro = new ResizeObserver(() => {
      measureNavCap();
      // Viewport resized (window resize, mobile keyboard toggle, composer
      // grow/shrink, layout shift). When following, re-glue to the bottom: a
      // viewport SHRINK leaves scrollTop ~unchanged while the bottom edge moves
      // DOWN, so without this re-pin we'd sit "Live" but not at the tail. Gated
      // on ready() so initial scroll-restore (maybeRestore) owns positioning.
      //
      // When NOT following but the resize landed us at the bottom, re-engage:
      // a pure clientHeight GROW (composer shrinking back) fires NO scroll
      // event, so onScrolled can't recover — this is the "stuck on ↓ Latest"
      // path. nearBottom() (not pinnedGeom-dependent) gates it so a reader
      // scrolled up mid-history is never yanked.
      if (!scrollEl || !ready()) return;
      if (following()) {
        pin();
      } else if (nearBottom()) {
        setFollowing(true);
        setUserScrolledUp(false);
        pin();
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
    scheduleActiveTurn();
  }

  const [focusMode, setFocusMode] = createSignal(false);

  // Auto-grow the composer up to a cap, then scroll; keep the highlight mirror
  // scrolled in lockstep.
  let taRef: HTMLTextAreaElement | undefined;
  // Prompt-history navigation. Two recall scopes share one cursor:
  //   - histMode "session" = plain Up, reads the per-session store (prompts sent
  //     in THIS session; a fresh draft recalls the "__new__" store).
  //   - histMode "global"  = Ctrl/Cmd+Up, reads the global store (any session,
  //     including legacy pre-split data).
  //   - "none" = editing the live draft. histIdx -1 = live draft; >=0 = recalled
  //     entry. histDraft is the live-input snapshot captured on the first step
  //     of a walk, restored when Down steps past zero. Switching scopes
  //     (Up↔Ctrl+Up) starts a fresh walk so the two stores never share an index.
  let histMode: "none" | "session" | "global" = "none";
  let histIdx = -1;
  let histDraft = "";
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
  const [caret, setCaret] = createSignal(0);
  const [acItems, setAcItems] = createSignal<AcItem[]>([]);
  const [acIndex, setAcIndex] = createSignal(0);
  const acOpen = () => acItems().length > 0;
  let acReq = 0; // race guard for async (file) fetches

  // The token under the caret that drives suggestions: a leading "/command", or
  // an "@mention" with no whitespace between the @ and the caret.
  function activeToken(): { type: "command" | "mention"; query: string; start: number; end: number } | null {
    const text = input();
    const c = caret();
    if (text.startsWith("/")) {
      const sp = text.indexOf(" ");
      if (sp === -1 || c <= sp) return { type: "command", query: text.slice(1, c), start: 0, end: c };
    }
    const upto = text.slice(0, c);
    const at = upto.lastIndexOf("@");
    if (at >= 0 && !/\s/.test(upto.slice(at + 1))) {
      return { type: "mention", query: upto.slice(at + 1), start: at, end: c };
    }
    return null;
  }

  // Recompute suggestions whenever the input or caret moves.
  createEffect(() => {
    input();
    caret();
    const tok = activeToken();
    if (!tok || props.draft && tok.type === "command") {
      setAcItems([]);
      return;
    }
    const req = ++acReq;
    setAcIndex(0);
    if (tok.type === "command") {
      void commandSuggestions(tok.query).then((items) => req === acReq && setAcItems(items));
    } else {
      const q = tok.query.toLowerCase();
      const agentItems: AcItem[] = agents()
        .filter((a) => a.name.toLowerCase().includes(q))
        .slice(0, 5)
        .map((a) => ({ kind: "agent", label: "@" + a.name, detail: a.description, insert: "@" + a.name + " " }));
      // Show agents immediately; merge in file matches when they arrive.
      setAcItems(agentItems);
      if (tok.query.length >= 1) {
        void fileSuggestions(tok.query).then((files) => req === acReq && setAcItems([...agentItems, ...files]));
      }
    }
  });

  function applyAc(item: AcItem) {
    const tok = activeToken();
    if (!tok) return;
    const text = input();
    const before = text.slice(0, tok.start);
    const after = text.slice(tok.end);
    setInput(before + item.insert + after);
    const pos = (before + item.insert).length;
    setAcItems([]);
    histMode = "none";
    histIdx = -1;
    queueMicrotask(() => {
      if (taRef) {
        taRef.focus();
        taRef.selectionStart = taRef.selectionEnd = pos;
        setCaret(pos);
      }
    });
  }
  const syncCaret = () => taRef && setCaret(taRef.selectionStart ?? 0);

  // Paste clipboard text into the composer. For mobile / no-physical-keyboard
  // where ⌘/Ctrl+V isn't handy; image/file paste still goes through the
  // textarea's onPaste. Reads via the async Clipboard API (needs a user gesture
  // + permission — the tap/hold is the gesture); silently no-ops if
  // denied/unsupported.
  //   - "replace": overwrite the whole composer (the plain tap)
  //   - "insert":  insert at the caret, replacing any selection (long-press)
  async function pasteFromClipboard(mode: "replace" | "insert") {
    let text = "";
    try {
      text = (await navigator.clipboard?.readText()) ?? "";
    } catch {
      taRef?.focus(); // permission denied / unsupported — leave the field focused so ⌘V works
      return;
    }
    if (!text) {
      taRef?.focus();
      return;
    }
    let pos: number;
    if (mode === "replace") {
      setInput(text);
      pos = text.length;
    } else {
      const cur = input();
      const start = taRef?.selectionStart ?? cur.length;
      const end = taRef?.selectionEnd ?? cur.length;
      const before = cur.slice(0, start);
      setInput(before + text + cur.slice(end));
      pos = before.length + text.length;
    }
    histMode = "none";
    histIdx = -1;
    queueMicrotask(() => {
      if (taRef) {
        taRef.focus();
        taRef.selectionStart = taRef.selectionEnd = pos;
        setCaret(pos);
      }
    });
  }

  // Tap vs hold on the paste button: a plain tap replaces the whole composer; a
  // long-press (>=HOLD_THRESHOLD_MS between pointerdown and click) inserts at
  // the caret. Classification goes through the shared classifyHold helper
  // (../lib/copyHold, same one the Copy button uses), so the two hold
  // affordances share one threshold and one load-independent rationale: a
  // previous timer+flag scheme misclassified as "replace" when main-thread jank
  // stalled the event loop past the threshold (CI load, throttled devices),
  // because the timer callback raced the click handler. classifyHold also
  // returns "tap" for keyboard activation (Enter/Space on the focused button
  // fires click with no preceding pointerdown → pasteDownAt stays 0 → the
  // downAt===0 sentinel), giving keyboard users the documented "replaces all"
  // default instead of the hold branch. The insert runs in the click handler,
  // which is still inside the transient-activation window opened by pointerdown
  // (lasts several seconds), so clipboard read works.
  //
  // SolidJS no-rerender note: SolidJS is NOT React — component bodies and JSX
  // run once at mount, so this `let pasteDownAt` closure persists for the whole
  // ChatView instance lifetime (it even survives session switches via the
  // non-keyed <Show when={selectedId()}> at App.tsx:367). Without an explicit
  // reset, a single pointer gesture (downAt set to a real timestamp T) would
  // leave the closure stale, and a LATER keyboard activation of the same
  // focused button would classify as "hold" (T is old → elapsed >= threshold)
  // → wrong branch. We close this edge two ways: (1) onBlur resets pasteDownAt
  // to 0 when focus leaves the button (focus leaving = gesture context ended;
  // pointer→click→blur ordering means the click already ran with the correct
  // timestamp, so blur-side reset does not break pointer-hold detection); and
  // (2) the click handler resets pasteDownAt to 0 AFTER classifyHold consumed
  // it, closing the narrow residual "pointer-press then immediate Enter on the
  // same focused button without focus moving away" hole. Both resets return
  // the closure to the downAt===0 sentinel so the next activation (pointer or
  // keyboard) starts clean.
  let pasteDownAt = 0;
  const onPasteDown = () => {
    pasteDownAt = Date.now();
  };
  const onPasteUp = () => {}; // no-op; elapsed check on click makes hold load-independent
  const onPasteClick = () => {
    if (classifyHold(pasteDownAt, Date.now()) === "hold") {
      pasteDownAt = 0; // reset AFTER classifyHold consumed it — closes the
                       // "pointer then immediate Enter on the same focused
                       // button" residual (see comment above).
      void pasteFromClipboard("insert");
      return;
    }
    pasteDownAt = 0; // same reset on the tap branch.
    void pasteFromClipboard("replace");
  };

  // The popup is portaled to <body> (fixed, above the composer) so chat content
  // can't paint over it. Anchored to the composer's rect; recomputed as items
  // change (which happens as you type, when the composer may have grown).
  let composerEl: HTMLDivElement | undefined;
  const acStyle = (): Record<string, string> => {
    acItems(); // recompute when the list changes
    if (!composerEl) return {};
    const r = composerEl.getBoundingClientRect();
    return {
      position: "fixed",
      left: `${Math.round(r.left)}px`,
      width: `${Math.round(r.width)}px`,
      bottom: `${Math.round(window.innerHeight - r.top + 6)}px`,
    };
  };
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
        histMode = "none";
        histIdx = -1;
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

  // Upload one file into the project's .vh-solara attachments dir; returns the
  // server-backed Attachment (with a real url) or null on failure.
  async function uploadFile(file: File, id: string): Promise<Attachment | null> {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/vh/attach?session=${encodeURIComponent(id)}`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) return null;
    const part = await res.json();
    if (!part?.url) return null;
    // Thread the project-relative attachment path returned by attach.go through
    // into the FE Attachment (and onward into the queue via QueuedAttachment).
    // S1 only carries the field; it is not yet used to build the dispatched
    // part (buildParts). `path` may be absent on older backends → undefined.
    return { url: part.url, filename: part.filename, mime: part.mime, path: part.path };
  }

  // Synthetic key for a draft-queued attachment (no server session yet). Real
  // uploads get a server url; pending ones get this so removeAttachment (which
  // keys on url) still works on the chip before send.
  let pendingSeq = 0;
  const pendingKey = () => `pending:${++pendingSeq}`;

  // --- S3: inline-mode attachment token <-> File <-> text --------------------
  //
  // When effectiveInline(...) is ON (non-vision model, OR vision + user-forced
  // pref), an attached/pasted file is NOT uploaded. Instead we hold the raw
  // File locally keyed by a stable localId, set a synthetic chip whose url is
  // vh-attach:<localId>, and insert a markdown reference at the textarea caret.
  // The markdown ref in the textarea text is the SOURCE OF TRUTH for "this
  // attachment exists"; the chip is a secondary UI affordance for removal.
  //
  // localId shape: INLINE_LOCALID_PREFIX + <N> (e.g. "inl3"), where <N> draws
  // from the SAME pendingSeq counter above so inline localIds never collide
  // with pending:N draft keys. The url is built by the pure inlineAttachUrl().
  //
  // The held File lives in `inlineFiles` (a Map<localId, File>), NOT on
  // Attachment.file. flushPendingAttachments (the existing draft-lazy seam
  // below) filters attachments by `.file` and would double-handle inline chips
  // if they carried it; inline chips set file: undefined, so that existing path
  // skips them untouched. `inlineFiles` survives until send (S4 will scan the
  // textarea text for vh-attach:<localId> tokens and resolve each via this Map).
  const inlineFiles = new Map<string, File>();
  const nextInlineLocalId = () => `${INLINE_LOCALID_PREFIX}${++pendingSeq}`;

  // S5: the set of inline localIds whose markdown ref is STILL PRESENT in the
  // composer text. Reactive over input(): when the user types/deletes, this set
  // recomputes and each inline chip's orphan flag (its token absent from the
  // text) updates. This makes the markdown ref the visible source of truth in
  // the chip strip: a chip whose ref was deleted is shown as an orphan (dimmed,
  // "won't be sent", with a re-insert control). Non-inline chips are unaffected
  // (isInlineChipOrphan returns false for non vh-attach: urls).
  const presentInlineIds = createMemo(() => new Set(scanInlineTokens(input())));

  // Upload any draft-queued (pending) attachments now that a session exists,
  // replacing their synthetic keys with real server urls. Called right after
  // createSession() in send(). A no-op for live sessions, whose attachments
  // upload immediately in addFiles.
  async function flushPendingAttachments(id: string) {
    const pending = attachments().filter((a) => a.file);
    if (pending.length === 0) return;
    setUploading(true);
    try {
      const resolved: Attachment[] = [];
      for (const a of pending) {
        const r = await uploadFile(a.file!, id);
        if (r) resolved.push(r);
      }
      // Keep already-uploaded entries; replace pending ones with resolved urls.
      setAttachments((prev) => [...prev.filter((a) => !a.file), ...resolved]);
    } finally {
      setUploading(false);
    }
  }

  // Queue a file as an attachment for the next message. For a LIVE session the
  // upload happens now (chip shows a server-backed url immediately). For a DRAFT
  // there is no session yet — never create one on paste/pick just to upload:
  // createSession() navigates away from the draft hero and this component-local
  // attachment state is lost on the remount. Instead queue the raw File locally
  // (chip shows from filename) and upload it at send time, once the session
  // exists (see flushPendingAttachments in send()).
  async function addFiles(files: FileList | File[] | null) {
    if (!files || files.length === 0) return;
    // Snapshot the files BEFORE clearing the input: e.currentTarget.files is a
    // LIVE FileList tied to the <input>, so setting fileInputRef.value = ""
    // empties it. Materializing the array first means the upload still sees the
    // picked files. (The paste path passes standalone File objects not tied to
    // the input, so it was never affected.)
    const arr = Array.from(files);
    if (fileInputRef) fileInputRef.value = "";
    // S3: inline mode (non-vision model, OR vision model + user-forced pref)
    // — DO NOT upload. Hold the raw File keyed by localId in `inlineFiles`,
    // set a synthetic chip whose url is vh-attach:<localId>, and insert a
    // markdown ref at the textarea caret. The text ref is the SOURCE OF TRUTH
    // for "this attachment exists"; the chip is a secondary removal affordance.
    // Applies to BOTH draft and live sessions — inline mode is orthogonal to
    // session lifecycle (it is about whether we upload at all). The non-inline
    // path below (draft pending-key / live eager upload) is byte-for-byte
    // unchanged.
    if (effectiveInline(modelHasVision(curModel()), inlineAttachForced())) {
      const ta = taRef;
      if (ta) ta.focus();
      for (const file of arr) {
        const localId = nextInlineLocalId();
        inlineFiles.set(localId, file);
        // Chip: url is the synthetic vh-attach:<localId> (so removeAttachment,
        // which keys on url, still works). file: is deliberately UNSET — see
        // the inlineFiles comment above (flushPendingAttachments filters by
        // .file and must skip inline chips).
        setAttachments((a) => [
          ...a,
          { url: inlineAttachUrl(localId), filename: file.name, mime: file.type },
        ]);
        if (ta) {
          insertAtCaret(
            ta,
            attachMarkdownRef(file.name, file.type.startsWith("image/"), localId),
          );
          // Mirror the helper's DOM mutation into the input() signal so
          // SolidJS's controlled value={input()} stays in sync. Assigning the
          // identical string is a DOM no-op, so the caret the helper just
          // advanced persists (no microtask needed, unlike pasteFromClipboard
          // which computes the splice on the signal and must wait for render).
          setInput(ta.value);
          setCaret(ta.selectionStart ?? 0);
        }
      }
      histMode = "none";
      histIdx = -1;
      return;
    }
    if (props.draft) {
      for (const file of arr) {
        setAttachments((a) => [...a, { url: pendingKey(), filename: file.name, mime: file.type, file }]);
      }
      return;
    }
    const id = props.sessionId;
    if (!id) return;
    setUploading(true);
    try {
      for (const file of arr) {
        const uploaded = await uploadFile(file, id);
        if (uploaded) setAttachments((a) => [...a, uploaded]);
      }
    } finally {
      setUploading(false);
    }
  }
  const removeAttachment = (url: string) => {
    // S5: deleting an inline chip (vh-attach:<localId>) must ALSO drop its held
    // File from inlineFiles — otherwise the bytes linger for the ChatView
    // lifetime even though the chip (and its token) are gone. Non-inline chips
    // (real file:// uploads) have no inlineFiles entry; inlineLocalIdFromUrl
    // returns null and the delete is skipped.
    const localId = inlineLocalIdFromUrl(url);
    if (localId !== null) inlineFiles.delete(localId);
    setAttachments((a) => a.filter((x) => x.url !== url));
  };

  // S5: re-insert an orphaned inline chip's markdown ref back into the composer
  // at the textarea caret, restoring its token so the chip returns to normal
  // (no longer orphaned — the lazy upload will pick it up at send). Mirrors the
  // addFiles inline insert path (insertAtCaret + attachMarkdownRef + mirror into
  // input()). No-op for a non-inline chip (no localId to re-insert).
  const reinsertInlineChip = (a: Attachment) => {
    const localId = inlineLocalIdFromUrl(a.url);
    if (localId === null) return;
    const ta = taRef;
    const ref = attachMarkdownRef(a.filename, a.mime.startsWith("image/"), localId);
    if (ta) {
      ta.focus();
      insertAtCaret(ta, ref);
      // Mirror the helper's DOM mutation into input() so the controlled
      // value={input()} stays in sync (assigning the identical string is a DOM
      // no-op, so the caret the helper advanced persists — same property the
      // addFiles inline insert path relies on).
      setInput(ta.value);
      setCaret(ta.selectionStart ?? 0);
    } else {
      // No textarea ref (should not happen in the composer): append to the
      // signal so the token is at least present (caret positioning best-effort).
      setInput(input() + ref);
    }
    histMode = "none";
    histIdx = -1;
  };

  function buildParts(text: string, atts?: Attachment[]): any[] {
    // `atts` is optional in practice: the backend serializes QueueItem.Attachments
    // with `omitempty`, so a queued item with no attachments arrives with
    // attachments === undefined. Iterating undefined throws TypeError, which
    // rejects the drain's dispatch promise and strands the item at `dispatching`.
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
    const s = selectionFor(id);
    return { providerID: s?.providerID, modelID: s?.modelID, variant: s?.variant, agent: activeAgent(props.sessionId) || undefined };
  }

  // Build + POST a prompt with explicit parts and send config (shared by direct
  // sends and queued auto-sends). prompt_async forks the turn and returns 204 at
  // once, so a send can never hang — the reply/failure arrive via the event feed.
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
  // The drainer (createQueueDrainer below) later claims + dispatches the
  // enqueued item through dispatchQueuedItem and owns the `isSending` guard for
  // the duration of that dispatch — so this function MUST NOT touch setSending
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
    const atts = attachments();
    if ((!text && atts.length === 0) || !id) return false;
    // Always capture a model. OpenCode rejects a prompt with no model. If models
    // haven't loaded, fetch once before enqueue so the persisted queue item
    // carries a valid sendConfig.
    if (!selectionFor(id) && models().length === 0) await loadModels();
    const config = captureConfig(id);
    try {
      await enqueue(id, { text, attachments: atts, sendConfig: config });
    } catch (e) {
      // Enqueue failed (offline / non-2xx / ambiguous 2xx-without-item) —
      // preserve the composed text + attachments (no silent loss) and warn.
      // Nothing was persisted, so a reconnect must NOT auto-send: there is no
      // pending item for the drainer to pick up. The operator re-presses Send.
      log.error("send", "enqueue failed", { id, err: String(e) });
      pushNotification({ kind: "error", sessionID: id, title: "Could not queue message", detail: text.slice(0, 120) });
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
  async function dispatchQueuedItem(
    id: string,
    text: string,
    attachments: { url: string; filename: string; mime: string }[],
    config: QueueConfig,
    itemId: string,
    signal: AbortSignal,
  ): Promise<{ state: "sent" | "failed" | "unknown"; detail: string }> {
    const body: any = { parts: buildParts(text, attachments) };
    if (config.agent) body.agent = config.agent;
    if (config.providerID && config.modelID) {
      body.model = { providerID: config.providerID, modelID: config.modelID };
      if (config.variant) body.variant = config.variant;
    }
    if (!userScrolledUp()) jumpToLatest();
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
      log.error("send", "queued POST rejected", { id, itemId, status: res.status, detail: msg });
      pushNotification({ kind: "error", sessionID: id, title: "Queued message failed to send", detail: msg });
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
      log.error("send", "queued POST threw", { id, itemId, aborted, err: msg });
      pushNotification({ kind: "error", sessionID: id, title, detail: msg });
      return { state: "unknown", detail: msg };
    }
  }
  // Wire the extracted drain state machine to ChatView's closures. The drainer
  // owns the `draining` flag + sending-guard lifecycle; dispatch/claim/resolve
  // stay here (config capture, POST, outcome classification, refresh).
  const queueDrainer = createQueueDrainer({
    canDrain: () => !props.draft && !working(),
    getId: () => props.sessionId,
    claim: claimQueued,
    dispatch: (id, claimed, signal) => {
      const config = claimed.sendConfig?.providerID && claimed.sendConfig?.modelID
        ? (claimed.sendConfig as QueueConfig)
        : captureConfig(id);
      return dispatchQueuedItem(id, claimed.text, claimed.attachments, config, claimed.id, signal);
    },
    resolve: resolveQueued,
    setSending,
    isSending,
    onResolved: (id) => void fetchQueue(id),
  });
  // Fires on busy→idle (turn finished) and on opening an idle session that still
  // has a queue (its turn finished while elsewhere). Reads queue length + working
  // reactively; the guards above keep it single-flight. pendingCount counts only
  // items the FE may still dispatch (pending) — dispatching/terminal items stay
  // visible but don't re-trigger a drain.
  createEffect(() => {
    void props.sessionId;
    const idle = !working();
    const items = !props.draft ? queueFor(props.sessionId) : [];
    const pending = items.filter((q) => q.state === "pending").length;
    if (idle && pending > 0) queueMicrotask(() => void queueDrainer.drain());
  });
  // Pull-based sync: refresh the selected session's queue on open, on stream
  // reconnect (status live-after-reconnecting), on window focus/visibility, and
  // poll ~5s while the selected session has any queue state. Correctness never
  // depends on a push channel (/vh/stream is a reconnect trigger only).
  createEffect(() => {
    const id = props.sessionId;
    if (props.draft || !id) return;
    // Session open: migrate any legacy local queue into the backend, then fetch.
    void (async () => {
      await migrateLegacyQueue(id);
      void fetchQueue(id);
    })();
  });
  createEffect(() => {
    // Reconnect trigger: when the stream goes live after a reconnect, refresh.
    const st = state.status;
    void st; // track status transitions
    if (st === "live" && !props.draft && props.sessionId) {
      void fetchQueue(props.sessionId);
    }
  });
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  createEffect(() => {
    const id = props.sessionId;
    const has = !props.draft && id ? hasQueueState(id) : false;
    // Restart the poll whenever the has-state signal changes.
    clearInterval(pollTimer);
    pollTimer = undefined;
    if (has) {
      pollTimer = setInterval(() => {
        if (!props.draft && props.sessionId && document.visibilityState === "visible") {
          void fetchQueue(props.sessionId);
        }
      }, 5000);
    }
  });
  onMount(() => {
    const onFocus = () => {
      if (!props.draft && props.sessionId) void fetchQueue(props.sessionId);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    onCleanup(() => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      clearInterval(pollTimer);
    });
  });

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
          pushNotification({ kind: "error", sessionID: id, title: failTitle, detail: detail || `HTTP ${res.status}` });
          return false;
        }
        log.debug("send", "accepted", { id, url });
        return true;
      })
      .catch((e) => {
        log.error("send", "POST threw", { id, url, err: String(e) });
        pushNotification({ kind: "error", sessionID: id, title: failTitle, detail: String(e) });
        return false;
      })
      .finally(() => setSending(key, false));

    // Race the request against a short grace period. A fast settle (error, or a
    // quick turn) resolves first and we honor it; otherwise the turn is running
    // — treat it as accepted, free the composer, and let `post` finish later.
    const ACCEPTED_AFTER_MS = 2500;
    return Promise.race([
      post,
      new Promise<boolean>((resolve) =>
        setTimeout(() => {
          setSending(key, false);
          resolve(true);
        }, ACCEPTED_AFTER_MS),
      ),
    ]);
  }

  // Leading "!" runs a shell command in the session instead of prompting.
  async function runShell(command: string, id: string): Promise<boolean> {
    const key = props.sessionId || "draft";
    if (!command || !id || isSending(key)) return false;
    setSending(key, true);
    const body: any = { command };
    const ag = activeAgent(props.sessionId);
    if (ag) body.agent = ag; // never fall back to a hardcoded "build" that may be disabled
    const s = selectionFor(id);
    if (s) body.model = { providerID: s.providerID, modelID: s.modelID };
    // Same intent-latch gate as sendParts above: don't yank a reader who
    // deliberately scrolled up. Gated on !userScrolledUp() (the intent latch),
    // not following(), so a transient following=false from a content-shrink
    // clamp still re-glues — only a genuine scroll-up read is preserved (10b).
    if (!userScrolledUp()) jumpToLatest();
    return dispatchSend(key, id, `/oc/session/${encodeURIComponent(id)}/shell`, body, "Shell command failed");
  }

  async function send() {
    const text = input().trim();
    if (!text && attachments().length === 0) return;
    // Gate before any state change: if agents/models aren't loaded yet, a send
    // would route through the leak-prone fallback chain (empty agent list) and
    // likely fail. Surface it and preserve the typed text (do NOT clear input).
    // Covers both the Enter-key path and the button click.
    if (!readyToSend()) {
      pushNotification({ kind: "info", sessionID: props.sessionId, title: "Still loading…" });
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
    if (working() && !queueMode()) {
      pushNotification({ kind: "info", sessionID: props.sessionId, title: "Busy — turn in progress" });
      return;
    }
    if (text) pushHistory(text, props.sessionId || "__new__"); // plain Up (session) + Ctrl+Up (global)
    histMode = "none";
    histIdx = -1;
    // /undo /redo only make sense for an existing session.
    if (!props.draft && text === "/undo") { setInput(""); return void undo(); }
    if (!props.draft && text === "/redo") { setInput(""); return void redo(); }
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
    if (props.draft) {
      const r = await runSendSingleFlight("draft", ensureSession);
      if (r === IGNORED) return; // re-tap during createSession dropped; in-flight send owns the composer
      id = r; // string | null (null = createSession failed)
    } else {
      id = await ensureSession();
    }
    if (!id) {
      setInput(text); // session creation failed; keep the text for retry
      return;
    }
    // A draft is materialized into a real session on first send. The composer's
    // explicit model/variant pick was made under the draft key (props.sessionId
    // ""), but captureConfig/sendText below read the live id — carry the pick
    // (and its explicit-pick intent) over so it isn't lost and an agent-declared
    // model can't override it post-migration. No-op for a non-draft send
    // (props.sessionId === id).
    migrateModelPick(props.sessionId, id);
    // A draft may have queued attachments locally (no session existed at paste
    // time). Now that we have an id, upload them so buildParts sees real urls.
    await flushPendingAttachments(id);
    // Shell commands (leading "!") dispatch directly against the live session —
    // they are NOT enqueued (they only make sense against a live shell). Clear
    // the composer text; on failure restore it so a silent noop never loses what
    // the user typed. (Out of scope for the send-loss fix — dispatchSend's
    // accepted-by-time race stays for shell only.)
    if (text.startsWith("!")) {
      setInput("");
      const ok = await runShell(text.slice(1).trim(), id);
      if (!ok) setInput(text);
      else if (props.draft) localStorage.removeItem(draftKey("__new__"));
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
    if (effectiveInline(modelHasVision(curModel()), inlineAttachForced())) {
      const r = await resolveInlineAttachments(
        text,
        inlineFiles,
        (f) => uploadFile(f, id),
        modelHasVision(curModel()),
      );
      resolvedText = r.resolvedText;
      // Vision-only image file parts carry real file:// urls; add them to the
      // chip list BEFORE the ownership snapshot below so buildParts (at dispatch)
      // emits them and the success-clear still fires. The synthetic vh-attach:
      // chips already in the list are excluded by buildParts (isInlineChipUrl).
      if (r.imageParts.length > 0) {
        appendedImageParts = r.imageParts;
        setAttachments((a) => [...a, ...r.imageParts]);
      }
    }
    await runSendSingleFlight(id, async () => {
      const snapText = input();
      const snapAtts = attachments();
      const ok = await sendText(resolvedText, id);
      if (!ok) {
        setInput(text);
        // dF2/b-F1: remove ONLY the imageParts the resolve block appended so a
        // retry re-resolves from the same baseline (no stacking) WITHOUT
        // discarding an operator-added chip during the await window. Reference
        // identity (includes) isolates exactly our parts; everything else in the
        // live attachments() list is preserved. Non-inline -> no-op.
        if (appendedImageParts) {
          const ours = appendedImageParts;
          setAttachments((a) => a.filter((x) => !ours.includes(x)));
        }
        return;
      }
      // Durable custody confirmed. Clear the composer ONLY if it still owns the
      // submitted snapshot. If the operator typed a new draft or changed
      // attachments during the enqueue wait, that newer state survives.
      if (input() === snapText && attachments() === snapAtts) {
        setInput("");
        setAttachments([]);
        // S5 dF1: a successful inline send consumed every held File (lazy
        // upload resolved all present tokens, and the chips are now cleared).
        // Clear inlineFiles so the raw bytes do not linger for the ChatView
        // lifetime. Inside the snapshot guard so a composer the operator changed
        // during the wait keeps its (new) chips and their held bytes intact.
        inlineFiles.clear();
      }
      // For a draft, the draft->live transition (ensureSession -> createSession
      // -> setSelectedId) unmounts this ChatView in App.tsx, which disposes the
      // draft-save createEffect above BEFORE the setInput("") just fired can
      // re-run it — so the persisted vh.draft.__new__ slot would survive and
      // re-inflate the composer on the next New session. Clear it explicitly at
      // the moment of success, before the unmount races it.
      if (props.draft) localStorage.removeItem(draftKey("__new__"));
    });
    // A re-tap during the in-flight enqueue returns IGNORED and the body above
    // never runs — the composer is left untouched, which is correct (the
    // in-flight send owns clearing on its own success).
  }

  // Copy / Retry text extraction lives in ../lib/msgText (pure, unit-tested).
  // Retry uses msgTextOnly (thinking is never valid to re-send as a user
  // prompt). Copy has THREE coexisting paths: a tap (elapsed < HOLD_THRESHOLD_MS)
  // copies text-only (msgTextOnly); a long-press (elapsed >= HOLD_THRESHOLD_MS)
  // and a right-click both copy msgTextWithThinking (wraps each contiguous
  // reasoning run in <think>…</think>). The tap-vs-hold classifier is in
  // ../lib/copyHold (classifyHold, pure, unit-tested) — the single threshold
  // source of truth shared with the paste button.
  const copyMessage = (m: any) => void navigator.clipboard?.writeText(msgTextOnly(m));
  const copyMessageWithThinking = (m: any) =>
    void navigator.clipboard?.writeText(msgTextWithThinking(m));
  const retry = (m: any) => void sendText(msgTextOnly(m), props.sessionId);

  // Inspect: tokens / cost / raw message JSON.
  const [inspectId, setInspectId] = createSignal<string | null>(null);
  const toggleInspect = (id: string) => setInspectId(inspectId() === id ? null : id);
  function inspectText(m: any): string {
    const i = m.info || {};
    const summary: any = {
      role: i.role,
      model: i.model ?? (i.providerID ? { providerID: i.providerID, modelID: i.modelID } : undefined),
      agent: i.agent,
      cost: i.cost,
      tokens: i.tokens,
      time: i.time,
    };
    return JSON.stringify({ summary, parts: m.partOrder.map((pid: string) => m.parts[pid]) }, null, 2);
  }

  // One-click fork from a turn.
  async function fork(messageID: string) {
    const res = await fetch(`/oc/session/${encodeURIComponent(props.sessionId)}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageID }),
    });
    const s = await res.json().catch(() => null);
    if (s?.id) {
      setSelectedId(s.id);
      void openSession(s.id);
    }
  }

  // /undo and /redo map to revert / unrevert of the latest turn.
  async function undo() {
    const sm = state.messages[props.sessionId];
    const lastId = sm?.order[sm.order.length - 1];
    if (!lastId) return;
    await fetch(`/oc/session/${encodeURIComponent(props.sessionId)}/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageID: lastId }),
    });
  }
  async function redo() {
    await fetch(`/oc/session/${encodeURIComponent(props.sessionId)}/unrevert`, { method: "POST" });
  }

  async function abort() {
    // Clear the working indicator immediately — OpenCode doesn't reliably emit
    // an idle event on abort, so without this the spinner/shimmer would linger.
    markSessionIdle(props.sessionId);
    // /vh/abort (not the /oc passthrough) also marks the session idle
    // authoritatively server-side, so a stream-reconnect snapshot can't re-arm
    // the working indicator on this stopped turn.
    await fetch("/vh/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: props.sessionId }),
    });
  }

  function onKeyDown(e: KeyboardEvent) {
    const ta = taRef;
    // Autocomplete owns the keys while its popup is open.
    if (acOpen()) {
      if (e.key === "ArrowDown") { e.preventDefault(); setAcIndex((i) => Math.min(i + 1, acItems().length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setAcIndex((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyAc(acItems()[acIndex()]); return; }
      if (e.key === "Escape") { e.preventDefault(); setAcItems([]); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
      return;
    }
    // Shell-style history recall, split by scope:
    //   - Plain Up with the caret at the very start (so multi-line editing isn't
    //     hijacked) → walk the PER-SESSION store — only prompts sent in THIS
    //     session. A fresh draft session (no server id) recalls the shared
    //     "__new__" store, matching the draft-key convention.
    //   - Ctrl/Cmd+Up from ANY caret position → walk the GLOBAL store — prompts
    //     sent in ANY session, including legacy data written before this split.
    //     The more discoverable global recall skips the caret-start gate.
    // Down steps back toward the live draft in whichever mode is active. One
    // index + an active-mode flag: switching scopes (Up↔Ctrl+Up) starts a fresh
    // walk so the two stores never cross-contaminate by index.
    const ctrl = e.ctrlKey || e.metaKey;
    const histSid = props.sessionId || "__new__";
    if (e.key === "ArrowUp" && ta && (ctrl || (ta.selectionStart === 0 && ta.selectionEnd === 0))) {
      const mode: "session" | "global" = ctrl ? "global" : "session";
      const len = mode === "global" ? historyLen() : historyLen(histSid);
      if (len > 0) {
        // Capture the live draft exactly once — when starting a walk from the
        // idle state. Switching scopes mid-walk (Up↔Ctrl+Up) resets the index
        // but must NOT overwrite the captured draft with a recalled value, or
        // Down-past-zero would restore the wrong text.
        const wasIdle = histMode === "none";
        if (histMode !== mode) {
          histMode = mode;
          histIdx = -1;
        }
        const next = Math.min(histIdx + 1, len - 1);
        const v = mode === "global" ? historyAt(next) : historyAt(next, histSid);
        if (v !== undefined) {
          e.preventDefault();
          if (wasIdle && histIdx === -1) histDraft = input();
          histIdx = next;
          setInput(v);
          queueMicrotask(() => ta && (ta.selectionStart = ta.selectionEnd = 0));
        }
      }
    } else if (e.key === "ArrowDown" && histMode !== "none" && histIdx >= 0) {
      e.preventDefault();
      histIdx -= 1;
      if (histIdx < 0) {
        histMode = "none";
        setInput(histDraft);
      } else {
        setInput(histMode === "global" ? historyAt(histIdx) ?? "" : historyAt(histIdx, histSid) ?? "");
      }
    }
  }

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
            {(m, i) => {
              // Per-message hold state for the Copy button: a long-press
              // (>=HOLD_THRESHOLD_MS) copies thinking, a tap copies text-only,
              // right-click copies thinking. State is per-row (captured in this
              // For closure) so two messages' gestures can't race a shared
              // timestamp; only one button is pressed at a time anyway.
              // thinkingJustCopied dedupes the Android-Chrome touch
              // double-fire (contextmenu then a synthesized click) — see
              // shouldSkipAfterContextmenu in ../lib/copyHold.
              //
              // SolidJS no-rerender note (same as the paste button): SolidJS
              // is NOT React — the <For> row callback runs ONCE per row at
              // mount, so these `let`s persist for the whole ChatView lifetime
              // (closure even survives session switches via the non-keyed
              // <Show when={selectedId()}> at App.tsx:367). Without an explicit
              // reset, a single pointer gesture (copyDownAt set to a real
              // timestamp T) would leave the closure stale, and a LATER
              // keyboard activation of the same focused Copy button would
              // classify as "hold" → wrong branch (thinking-or-skip instead of
              // text-only). We close this edge two ways: (1) onBlur resets
              // copyDownAt (and thinkingJustCopied, defensively) to their
              // initial values when focus leaves the button (focus leaving =
              // gesture context ended; pointer→click→blur ordering means the
              // click already ran with the correct timestamp, so blur-side
              // reset does not break pointer-hold detection); and (2) the
              // click handler resets copyDownAt to 0 AFTER classifyHold
              // consumed it, closing the narrow residual "pointer-press then
              // immediate Enter on the same focused button without focus
              // moving away" hole. Note: when copyDownAt===0, classifyHold
              // returns "tap", and shouldSkipAfterContextmenu is short-circuited
              // because it requires cls==="hold" — so a lingering stale
              // thinkingJustCopied=true cannot suppress a keyboard tap;
              // resetting it anyway is harmless and keeps state clean.
              let copyDownAt = 0;
              let thinkingJustCopied = false;
              return (
              <div class="msg" data-mid={m.id} classList={{ user: m.info.role === "user", assistant: m.info.role === "assistant" }}>
                <div class="msg-head">
                  <span class="msg-role">{roleLabel(m.info.role)}</span>
                  <MsgAgent info={m.info} />
                  <Show when={modelLabel(m.info)}>
                    <span class="msg-model" data-tip={modelLabel(m.info)}>{modelLabel(m.info)}</span>
                  </Show>
                  <RelTime class="msg-time" mode="ago" ms={m.info.time?.created} />
                  <Show when={costLabel(m.info)}>
                    <span class="msg-cost">{costLabel(m.info)}</span>
                  </Show>
                  <Show when={m.info.role === "assistant" && m.info.time?.completed}>
                    <MsgPerf m={m} />
                  </Show>
                  <div class="msg-actions">
                    <button
                      type="button"
                      class="msg-copy"
                      data-tip="Copy · hold or right-click for thinking"
                      aria-label="Copy message text; hold or right-click to include reasoning"
                      onPointerDown={() => {
                        // Fresh gesture: record the press time (mouse-hold and
                        // touch-hold unified via Pointer Events, same reasoning
                        // as the paste button) and clear the contextmenu-dedupe
                        // flag for a new cycle.
                        copyDownAt = Date.now();
                        thinkingJustCopied = false;
                      }}
                      onClick={() => {
                        const cls = classifyHold(copyDownAt, Date.now());
                        // Reset AFTER classifyHold consumed the value — closes
                        // the narrow residual "pointer-press then immediate
                        // Enter on the same focused button without focus
                        // moving away" hole (see the SolidJS no-rerender note
                        // above). Safe because classifyHold already read the
                        // value; the next pointerdown of a fresh gesture will
                        // set it again.
                        copyDownAt = 0;
                        if (cls === "hold") {
                          // Android-Chrome touch long-press synthesizes a click
                          // AFTER the contextmenu that already copied thinking;
                          // skip the duplicate. Mouse-hold and iOS (no touch
                          // contextmenu) copy thinking here.
                          if (shouldSkipAfterContextmenu(thinkingJustCopied, cls)) {
                            thinkingJustCopied = false;
                            return;
                          }
                          copyMessageWithThinking(m);
                        } else {
                          copyMessage(m);
                        }
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        // Flag that thinking was already copied so the
                        // synthesized click in the same touch long-press
                        // gesture is deduped (deterministic: contextmenu is
                        // guaranteed to precede the click).
                        thinkingJustCopied = true;
                        copyMessageWithThinking(m);
                      }}
                      onBlur={() => {
                        // Focus leaving the button = gesture context ended.
                        // Return the per-row closure to its initial state so
                        // the NEXT keyboard activation (Enter/Space on this
                        // focused Copy button) classifies as "tap" (text-only)
                        // instead of misclassifying from a stale pointer
                        // timestamp. See the SolidJS no-rerender note above
                        // the per-row classifier. Resetting copyDownAt alone
                        // is sufficient for keyboard parity (a downAt===0
                        // classifyHold result is "tap", which bypasses
                        // shouldSkipAfterContextmenu entirely); we reset
                        // thinkingJustCopied too for cleanliness/symmetry.
                        copyDownAt = 0;
                        thinkingJustCopied = false;
                      }}
                    >
                      <Icon name="copy" size={14} />
                    </button>
                    <button type="button" data-tip="Inspect" aria-label="Inspect" onClick={() => toggleInspect(m.id)}>
                      <Icon name="info" size={14} />
                    </button>
                    <button type="button" data-tip="Fork from here" aria-label="Fork" onClick={() => fork(m.id)}>
                      <Icon name="fork" size={14} />
                    </button>
                    <Show when={m.info.role === "user"}>
                      <button type="button" data-tip="Retry" aria-label="Retry" onClick={() => retry(m)}>
                        <Icon name="retry" size={14} />
                      </button>
                    </Show>
                  </div>
                </div>
                <Deferred
                  class="msg-parts"
                  eager={i() >= messages().length - EAGER_TAIL}
                  root={() => scrollEl}
                  minHeight={48}
                >
                  <MessageParts
                    m={m}
                    isLastMessage={() => i() === messages().length - 1}
                    lastActivityKey={lastActivityKey}
                    failed={messageFailed}
                  />
                </Deferred>
                <Show when={messageError(m.info)}>
                  <div class="msg-error">⚠ {messageError(m.info)}</div>
                </Show>
                <Show when={inspectId() === m.id}>
                  <pre class="msg-inspect">{inspectText(m)}</pre>
                </Show>
              </div>
              );
            }}
          </For>
          {/* Transcript-level states: a loading hint while the first snapshot
              is in flight (slot reserved but not yet delivered), an empty hint
              once delivered-and-empty, or a failure hint if the background
              hydration errored. openSession pre-reserves a truthy-but-empty
              slot, so we key off `delivered` (messagesLoaded) / `messageFailed`,
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
        <Show when={isDesktop() && userTurns().length > 1}>
          <div class="chat-nav" aria-label="Jump to a turn">
            <Show when={navWindow().start > 0}>
              <button
                type="button"
                class="chat-nav-more up"
                title={`${navWindow().start} earlier turn${navWindow().start > 1 ? "s" : ""}`}
                aria-label={`${navWindow().start} earlier turns`}
                onClick={() => jumpToMsg(userTurns()[Math.max(0, navWindow().start - 1)].id)}
              >
                <Icon name="chevronDown" size={11} />
              </button>
            </Show>
            <For each={navWindow().items}>
              {(m) => (
                <button
                  type="button"
                  class="chat-nav-dot"
                  classList={{ active: activeTurn() === m.id }}
                  aria-label={turnText(m)}
                  aria-current={activeTurn() === m.id ? "true" : undefined}
                  onClick={() => jumpToMsg(m.id)}
                  onMouseEnter={(e) => setNavPreview({ text: turnText(m), y: e.currentTarget.offsetTop + e.currentTarget.offsetHeight / 2 })}
                  onMouseLeave={() => setNavPreview(null)}
                  onFocus={(e) => setNavPreview({ text: turnText(m), y: e.currentTarget.offsetTop + e.currentTarget.offsetHeight / 2 })}
                  onBlur={() => setNavPreview(null)}
                />
              )}
            </For>
            <Show when={navWindow().end < navWindow().total}>
              <button
                type="button"
                class="chat-nav-more"
                title={`${navWindow().total - navWindow().end} more turn${navWindow().total - navWindow().end > 1 ? "s" : ""}`}
                aria-label={`${navWindow().total - navWindow().end} more turns`}
                onClick={() => jumpToMsg(userTurns()[Math.min(navWindow().total - 1, navWindow().end)].id)}
              >
                <Icon name="chevronDown" size={11} />
              </button>
            </Show>
            <Show when={navPreview()}>
              {(pv) => <div class="chat-nav-bubble" style={{ top: `${pv().y}px` }}>{pv().text}</div>}
            </Show>
          </div>
        </Show>
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

      <div class="composer-wrap">
        <Show
          when={!isChild()}
          fallback={
            <div class="composer-child-note">
              <span>Prompting is disabled for subagent sessions.</span>
              <Show when={parentId()}>
                <button type="button" class="composer-child-back" onClick={openParent}>
                  Back to parent session →
                </button>
              </Show>
              {/* A stuck subagent can still be stopped from here. */}
              <Show when={working()}>
                <button type="button" class="composer-child-stop" onClick={abort}>
                  <Icon name="stop" size={13} /> Stop
                </button>
              </Show>
            </div>
          }
        >
        <div class="composer" classList={{ focus: focusMode() }} ref={composerEl}>
          {/* Autocomplete popup (@file / @agent / /command). Portaled to body so
              chat content can't paint over it; positioned above the composer. */}
          <Show when={acOpen()}>
            <Portal>
              <div class="ac-pop" style={acStyle()}>
                <For each={acItems()}>
                  {(it, i) => (
                    <button
                      type="button"
                      class="ac-item"
                      classList={{ active: i() === acIndex() }}
                      onMouseDown={(e) => { e.preventDefault(); applyAc(it); }}
                      onMouseEnter={() => setAcIndex(i())}
                    >
                      <span class="ac-kind" classList={{ [it.kind]: true }}>{it.kind === "command" ? "/" : it.kind === "agent" ? "@" : "⎘"}</span>
                      <span class="ac-label">{it.label}</span>
                      <Show when={it.detail}><span class="ac-detail">{it.detail}</span></Show>
                    </button>
                  )}
                </For>
              </div>
            </Portal>
          </Show>
          {/* Queue chips reflect the backend-authoritative per-session queue.
              pending → removable (cancel before dispatch); dispatching → in
              flight, NOT removable (the state machine owns the transition to
              terminal); terminal `failed`/`unknown` → dismissable
              (FIX-QUEUE-GC-4 flipped DELETE from pending-only to "pending +
              terminal; not dispatching"). `sent` is filtered from the visible
              queue upstream (queueFor), so it needs no dismiss surface. See
              QueueChip.tsx for the per-state dismissal wiring. */}
          <Show when={!props.draft && queueFor(props.sessionId).length > 0}>
            <div class="queue-row">
              <span class="queue-label" data-tip="Sent automatically when the current turn finishes">
                Queued
              </span>
              <For each={queueFor(props.sessionId)}>
                {(q) => (
                  <QueueChip
                    q={q}
                    onRemove={(id) => void removeQueued(props.sessionId, id)}
                  />
                )}
              </For>
            </div>
          </Show>
          <Show when={attachments().length > 0 || uploading()}>
            <div class="attach-row">
              <For each={attachments()}>
                {(a) => {
                  // S5: an inline chip (vh-attach:<localId>) is an ORPHAN when
                  // its token is absent from the composer text (the user deleted
                  // the markdown ref). Its held File will NOT be uploaded at
                  // send (lazy upload skips absent tokens); show it dimmed with
                  // a "won't be sent" badge + a re-insert control that splices
                  // the ref back at the caret. Non-inline chips (real file://
                  // uploads) are never orphans. presentInlineIds is a memo over
                  // scanInlineTokens(input()) so this re-evaluates on every
                  // keystroke.
                  //
                  // a-F1: orphan is a DERIVED ACCESSOR, not a captured boolean.
                  // SolidJS <For> callbacks run ONCE per item in a NON-tracking
                  // scope, so a captured `const orphan = isInlineChipOrphan(...)`
                  // would freeze at item-creation and never react to
                  // presentInlineIds() changes — the dim/badge/re-insert button
                  // would NOT appear/disappear as the user edits the composer
                  // text, defeating S5. Reading orphan() inside JSX props/class
                  // /Show lets the Solid compiler wrap each read in a reactive
                  // effect so the orphan UI tracks the live present-token set.
                  const orphan = () => isInlineChipOrphan(a.url, presentInlineIds());
                  return (
                    <span
                      class="attach-chip"
                      classList={{ orphan: orphan() }}
                      data-tip={orphan() ? `${a.filename} (ref removed — won't be sent)` : a.filename}
                    >
                      <Icon name="paperclip" size={12} />
                      <span class="attach-name">{a.filename}</span>
                      <Show when={orphan()}>
                        <span
                          class="attach-orphan-badge"
                          title="Reference removed from message — won't be uploaded or sent. Re-insert to restore."
                        >
                          ref removed
                        </span>
                        <button
                          type="button"
                          aria-label={`Re-insert ${a.filename} into message`}
                          title="Re-insert into message"
                          onClick={() => reinsertInlineChip(a)}
                        >
                          <Icon name="retry" size={11} />
                        </button>
                      </Show>
                      <button type="button" aria-label="Remove attachment" onClick={() => removeAttachment(a.url)}>
                        <Icon name="x" size={11} />
                      </button>
                    </span>
                  );
                }}
              </For>
              <Show when={uploading()}>
                <span class="attach-chip uploading">Uploading…</span>
              </Show>
            </div>
          </Show>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => void addFiles(e.currentTarget.files)}
          />
          <div
            class="composer-field"
            classList={{ shell: input().startsWith("!"), command: input().startsWith("/") }}
          >
            <div ref={mirrorRef} class="composer-mirror" aria-hidden="true" innerHTML={highlightInput(input())} />
            <textarea
              ref={taRef}
              class="composer-text"
              value={input()}
              onInput={(e) => (setInput(e.currentTarget.value), setCaret(e.currentTarget.selectionStart ?? 0), (histMode = "none"), (histIdx = -1))}
              onClick={syncCaret}
              onKeyUp={syncCaret}
              onBlur={() => setTimeout(() => setAcItems([]), 150)}
              onScroll={(e) => mirrorRef && (mirrorRef.scrollTop = e.currentTarget.scrollTop)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                // Paste an image/file (e.g. a screenshot) straight into the
                // composer as an attachment; plain-text paste falls through.
                // Many browsers expose pasted files ONLY via clipboardData.items
                // (getAsFile) while .files stays empty, so harvest both and
                // prefer items (see lib/paste.ts).
                const cd = e.clipboardData;
                const harvested = harvestPastedFiles(
                  cd?.files ? Array.from(cd.files) : null,
                  cd?.items ? Array.from(cd.items) : null,
                );
                if (harvested.length > 0) {
                  e.preventDefault();
                  void addFiles(harvested);
                }
              }}
              placeholder={"Message…   (! = shell, /undo /redo)"}
              rows={1}
            />
          </div>
          <div class="composer-bar">
            <Show when={agents().length > 0} fallback={<span class="bar-loading">Loading agents…</span>}>
              <Select
                class="bar-select agent-select"
                ariaLabel="Agent"
                value={agentForSession(props.sessionId)}
                options={agents().map((a) => ({ value: a.name, label: `@${a.name}`, swatch: agentDisplay(a.name)?.color, sub: a.description }))}
                onChange={(v) => selectAgentForSession(props.sessionId, v)}
              />
            </Show>
            <Show when={models().length > 0}>
              <button type="button" class="bar-btn model-btn" aria-label="Model" onClick={() => setModelDialog(true)}>
                <span class="model-btn-name">{curModel()?.name || "Select model"}</span>
                <span class="model-btn-caret"><Icon name="chevronDown" size={14} /></span>
              </button>
              <Show when={(curModel()?.variants?.length ?? 0) > 0}>
                <Select
                  class="bar-select variant-select"
                  ariaLabel="Variant"
                  value={curVariant()}
                  options={[
                    { value: "", label: "default" },
                    ...curModel()!.variants.map((v) => ({ value: v, label: v })),
                  ]}
                  onChange={(v) => chooseVariant(props.sessionId, v || undefined)}
                />
              </Show>
            </Show>
            <span class="bar-spacer" />
            <button
              type="button"
              class="bar-icon"
              aria-label="Paste (hold to insert at cursor)"
              data-tip="Paste — replaces all · hold to insert at cursor"
              onClick={onPasteClick}
              onPointerDown={onPasteDown}
              onPointerUp={onPasteUp}
              onPointerLeave={onPasteUp}
              onPointerCancel={onPasteUp}
              onBlur={() => {
                // Focus leaving the button = gesture context ended. Return
                // the closure to the downAt===0 sentinel so the NEXT keyboard
                // activation (Enter/Space on this focused button) classifies
                // as "tap" (documented "replaces all" default) instead of
                // misclassifying from a stale pointer timestamp. See the
                // SolidJS no-rerender note above the paste classifier.
                pasteDownAt = 0;
              }}
            >
              <Icon name="clipboard" />
            </button>
            <button
              type="button"
              class="bar-icon"
              aria-label="Attach file"
              data-tip="Attach file"
              disabled={uploading()}
              onClick={() => fileInputRef?.click()}
            >
              <Icon name="paperclip" />
            </button>
            <button
              type="button"
              class="bar-icon"
              aria-label="Focus mode"
              data-tip="Expand / focus"
              onClick={() => setFocusMode((v) => !v)}
            >
              <Icon name="maximize" />
            </button>
            <Show
              when={working()}
              fallback={
                <button
                  type="button"
                  class="send-btn"
                  classList={{ sending: sendInFlight() }}
                  aria-label={sendInFlight() ? "Sending…" : "Send"}
                  onClick={send}
                  disabled={sending() || sendInFlight() || !readyToSend()}
                >
                  <Icon name="send" />
                </button>
              }
            >
              {/* Busy: Stop aborts the running turn; a Queue button appears once
                  you've typed something (Enter queues too). */}
              <Show when={queueMode() && input().trim().length > 0}>
                <button
                  type="button"
                  class="send-btn queue"
                  classList={{ sending: sendInFlight() }}
                  aria-label={sendInFlight() ? "Queueing…" : "Queue"}
                  data-tip="Queue — sends when the current turn finishes"
                  disabled={sendInFlight() || !readyToSend()}
                  onClick={send}
                >
                  <Icon name="plus" />
                </button>
              </Show>
              <button type="button" class="send-btn stop" aria-label="Stop" onClick={abort}>
                <Icon name="stop" />
              </button>
            </Show>
          </div>
          <Show when={modelDialog()}>
            <ModelDialog sessionId={props.sessionId} onClose={() => setModelDialog(false)} />
          </Show>
        </div>
        </Show>
      </div>
    </div>
  );
}
