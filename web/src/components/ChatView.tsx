import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import { ackSession, createSession, currentVerb, isSending, markSessionIdle, openSession, respondPermission, rootOf, sessionTodoCounts, sessionTodos, sessionWorking, setSelectedId, setSending, state } from "../sync";
import { bottommostRead, clearReadAnchor, getReadAnchor, setReadAnchor } from "../lib/scroll";
import { highlightInput } from "../lib/composerHighlight";
import { chooseVariant, findModel, loadModels, models, selectionFor } from "../models";
import { loadVersioned, saveVersioned } from "../lib/store";
import { activeAgent, agentForSession, agents, selectAgentForSession, selectedAgent } from "../agents";
import { dequeue, enqueue, queueFor, queueMode, removeQueued } from "../queue";
import { historyAt, historyLen, pushHistory } from "../history";
import { type AcItem, commandSuggestions, fileSuggestions } from "../lib/complete";
import ModelDialog from "./ModelDialog";
import PartView, { ActivityGroup } from "./Part";
import { Deferred } from "./Deferred";

// Eager-mount the last N message rows (the tail you see on open + where new
// messages and the live stream land), so scroll-to-bottom and streaming stay
// correct; older rows mount lazily as they near the viewport (see Deferred).
const EAGER_TAIL = 30;
import QuestionCard from "./QuestionCard";
import Icon from "./Icon";
import Spinner from "./Spinner";
import { isDesktop } from "../layout";
import BrandMark from "./BrandMark";
import { pushNotification } from "../notify";
import { log } from "../lib/log";
import RelTime from "./RelTime";
import Select from "./Select";
import { agentDisplay } from "../projectSettings";

const draftKey = (sid: string) => "vh.draft." + sid;

// Model/agent/variant a prompt is sent with (captured at queue time too).
type QueueConfig = { providerID?: string; modelID?: string; variant?: string; agent?: string };


function roleLabel(role?: string): string {
  if (role === "user") return "You";
  if (role === "assistant") return "Assistant";
  return role || "";
}

// The agent/subagent that produced an assistant message (e.g. "build", "plan",
// or a custom subagent). Empty for user messages or when none was recorded.
function agentLabel(info: any): string {
  if (info?.role !== "assistant") return "";
  const a = info.agent ?? info.mode;
  return typeof a === "string" ? a.trim() : "";
}

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

function messageError(info: any): string | null {
  const e = info?.error;
  if (!e) return null;
  return e.data?.message || e.name || "error";
}

// The model that produced an assistant message, resolved to its display name
// (falling back to the raw id). Empty for non-assistant messages or when the
// message carries no model. message.model uses `modelID`; older/flat envelopes
// put it directly on the info — accept either.
function modelLabel(info: any): string {
  if (info?.role !== "assistant") return "";
  const providerID = info.providerID ?? info.model?.providerID;
  const modelID = info.modelID ?? info.model?.modelID;
  if (!modelID) return "";
  const name = (providerID ? findModel(providerID, modelID)?.name : undefined) || modelID;
  const variant = info.variant ?? info.model?.variant;
  return variant && variant !== "default" ? `${name} · ${variant}` : name;
}

// Assistant cost/token summary, shown once the turn has completed.
function costLabel(info: any): string {
  if (info?.role !== "assistant" || !info?.time?.completed) return "";
  const parts: string[] = [];
  if (typeof info.cost === "number" && info.cost > 0) parts.push(`$${info.cost.toFixed(4)}`);
  const tok = (info.tokens?.input || 0) + (info.tokens?.output || 0);
  if (tok > 0) parts.push(tok >= 1000 ? `${(tok / 1000).toFixed(1)}k tok` : `${tok} tok`);
  return parts.join(" · ");
}

// A permission request's category (e.g. "bash", "edit") for the card header.
function permLabel(p: any): string {
  return String(p?.permission || p?.type || p?.title || "").trim();
}
// The concrete thing being requested — the command / file / description — so the
// user knows what they're approving (OpenCode's payload puts it in metadata or
// the patterns; title/type are usually empty, which is why it read blank).
function permDetail(p: any): string {
  const m = (p?.metadata || {}) as Record<string, any>;
  const cand = m.command ?? m.cmd ?? m.filePath ?? m.path ?? m.description ?? m.title;
  if (typeof cand === "string" && cand.trim()) return cand.trim();
  if (Array.isArray(p?.patterns)) {
    const ps = p.patterns.filter((x: any) => typeof x === "string" && x && x !== "*");
    if (ps.length) return ps.join("\n");
  }
  return "";
}

// Group a message's parts for rendering: consecutive tool/reasoning parts fold
// into one compact "Activity" timeline; text/file parts (and a lone reasoning
// with no tools) render inline as before. Preserves part order.
// RenderItem carries a `key` derived from the part-id composition. The key only
// changes when a part is ADDED/REMOVED — not when a part's text grows — so a
// streaming turn keeps the same keys token-to-token, letting MessageParts reuse
// the row components (parts mutate in place; see upsertPart) instead of
// recreating them every token.
type RenderItem = { kind: "part"; part: any; key: string } | { kind: "activity"; parts: any[]; key: string };
function groupParts(m: any): RenderItem[] {
  const items: RenderItem[] = [];
  let run: any[] = [];
  const flush = () => {
    if (!run.length) return;
    const hasTool = run.some((p) => p?.type === "tool");
    if (run.length === 1 && !hasTool) items.push({ kind: "part", part: run[0], key: "p:" + run[0].id });
    else items.push({ kind: "activity", parts: run, key: "a:" + run.map((p) => p.id).join(",") });
    run = [];
  };
  for (const pid of m.partOrder || []) {
    const p = m.parts[pid];
    if (!p) continue;
    if (p.type === "tool" || p.type === "reasoning") run.push(p);
    else {
      flush();
      items.push({ kind: "part", part: p, key: "p:" + p.id });
    }
  }
  flush();
  return items;
}

// Renders one message's parts. Memoizes the render-items and REUSES the wrapper
// object for an unchanged key, so the row components persist across streaming
// tokens (no flashing/jumping) and update reactively via the in-place part refs.
function MessageParts(props: { m: any; isLastMessage: () => boolean; lastActivityKey: () => string | null }) {
  let cache = new Map<string, RenderItem>();
  const items = createMemo(() => {
    const fresh = groupParts(props.m);
    const next = new Map<string, RenderItem>();
    const out = fresh.map((it) => {
      const reused = cache.get(it.key) ?? it;
      next.set(it.key, reused);
      return reused;
    });
    cache = next;
    return out;
  });
  const settled = () => props.m.info.role === "user" || !!props.m.info.time?.completed;
  const tailId = () =>
    !settled() && props.isLastMessage() ? props.m.partOrder[props.m.partOrder.length - 1] : null;
  return (
    <For each={items()}>
      {(it) =>
        it.kind === "activity" ? (
          <ActivityGroup
            parts={it.parts}
            settled={settled()}
            tailId={tailId()}
            isLast={it.parts[0]?.id === props.lastActivityKey()}
          />
        ) : (
          <PartView part={it.part} settled={settled()} tail={it.part.id === tailId()} />
        )
      }
    </For>
  );
}

export default function ChatView(props: { sessionId: string; draft?: boolean }) {
  let scrollEl: HTMLDivElement | undefined;
  let contentEl: HTMLDivElement | undefined;
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
  // Hide the transcript until it's positioned for the current session, so the
  // initial scroll jump (top → restored/bottom) is never painted — switching
  // sessions reveals the content already in place instead of flashing.
  const [ready, setReady] = createSignal(false);
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
  interface Attachment { url: string; filename: string; mime: string }
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
  const revealed = createMemo(() => ready() && (delivered() || messageFailed()));
  const messages = createMemo(() => {
    const s = sm();
    return s ? s.order.map((id) => s.byId[id]) : [];
  });
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
  // always agree). See sessionWorking() for the activity + last-message logic.
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
  // its pre-hidden value, the queued RO guard below sees scrollTop<pinnedTop
  // (clamped) with !shrank (net grew) and mis-classifies it as a genuine user
  // scroll-up — setFollowing(false)+latch armed — which the self-heal cannot
  // recover (it needs a working() edge or a cleared latch). Live would stay dead
  // until manual scroll-back / Latest click / a new turn.
  //
  // visibilitychange dispatches before the rendering step where the queued RO
  // delivers, so re-pin here to refresh pinnedTop/pinnedScrollHeight to the
  // CURRENT post-hidden state first: the guard then sees scrollTop===pinnedTop
  // and re-pins cleanly instead of tripping on the stale pre-hidden baseline.
  // Gated on ready() + !userScrolledUp() to mirror the self-heal (won't yank a
  // genuine reader who deliberately scrolled up during/after backgrounding).
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
  // Agent todo list (OpenCode TodoWrite) → "Tasks N active · M left" pill.
  const todoCounts = createMemo(() => sessionTodoCounts(props.sessionId));
  const todoItems = createMemo(() => sessionTodos(props.sessionId));
  const [todosOpen, setTodosOpen] = createSignal(false);
  let tasksBarEl: HTMLDivElement | undefined;
  let tasksPopupEl: HTMLDivElement | undefined;
  // The popover is anchored bottom-right, so resizing means changing its size
  // (it grows up/left). A top-left grip drags it; size persists. Restore on open.
  // The grip lives on the popup shell (not the inner scroller) so it stays put
  // when the task list is scrolled.
  const TASKS_SIZE_KEY = "vh.prefs.tasksSize.v1";
  const restoreTasksSize = (el: HTMLElement) => {
    try {
      const s = JSON.parse(localStorage.getItem(TASKS_SIZE_KEY) || "null");
      if (s?.w) el.style.width = s.w;
      if (s?.h) { el.style.height = s.h; el.style.maxHeight = s.h; }
    } catch {
      /* ignore */
    }
  };
  const startTasksResize = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = tasksPopupEl;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY, sw = r.width, sh = r.height;
    const move = (ev: PointerEvent) => {
      const w = Math.max(220, Math.min(560, sw + (sx - ev.clientX))); // drag left → wider
      const h = Math.max(120, Math.min(window.innerHeight * 0.72, sh + (sy - ev.clientY))); // drag up → taller
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.maxHeight = `${h}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(TASKS_SIZE_KEY, JSON.stringify({ w: el.style.width, h: el.style.height }));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // Close the overlay popover on outside click. Listener lives only while open;
  // onCleanup re-runs when todosOpen flips false, so nothing leaks.
  createEffect(() => {
    if (!todosOpen()) return;
    const onDoc = (e: MouseEvent) => {
      if (tasksBarEl && !e.composedPath().includes(tasksBarEl)) setTodosOpen(false);
    };
    const id = setTimeout(() => document.addEventListener("click", onDoc), 0);
    onCleanup(() => {
      clearTimeout(id);
      document.removeEventListener("click", onDoc);
    });
  });

  function nearBottom() {
    return scrollEl
      ? scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 24
      : true;
  }
  // Position we last set programmatically. A scroll event whose offset matches it
  // is our own pin (not the user), so onScrolled can skip its work — otherwise
  // each streamed pin fires a scroll event that re-runs nearBottom/ack/navigator
  // every frame (a feedback loop that burned CPU during streaming).
  let pinnedTop = -1;
  // Content height captured at the last pin(). Companion to pinnedTop: a shrink
  // (reasoning/tool block collapsing on de-tail, or the raw→rendered-HTML swap
  // landing shorter) clamps scrollTop below pinnedTop with NO user intent — the
  // RO re-pin guard must distinguish that from a real user scroll-up.
  let pinnedScrollHeight = -1;
  function pin() {
    if (!scrollEl) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
    pinnedTop = scrollEl.scrollTop; // clamped value the scroll event will report
    pinnedScrollHeight = scrollEl.scrollHeight; // content size at pin time
  }
  function jumpToLatest() {
    setFollowing(true);
    setUserScrolledUp(false); // user explicitly chose to follow again
    pin();
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
  function scheduleReadCursor() {
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
      return;
    }
    const cand = bottommostReadFromDom();
    if (!cand) return;
    if (isCursorAhead(cand, getReadAnchor(sid))) setReadAnchor(sid, cand);
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
    const found = bottommostRead(rows);
    if (found) return found;
    // Nothing scrolled strictly past the container top. This is the scroll-origin
    // case: the user scrolled all the way UP (e.g. scrollTop=0) to re-read from
    // the top. .chat-scroll has `padding: 16px` (styles.css), so the first row's
    // top is measured at +16px — above the `<= 0` threshold — and bottommostRead
    // returns undefined. But the first row is visibly in-view and IS the topmost
    // read message, so it must be the anchor; otherwise no anchor is written,
    // flushReadCursor no-ops, and reopening the session falls through to the
    // bottom-pin branch in maybeRestore (losing the read position + clearing the
    // unread dot for an uncaught-up session). rows[0] is the topmost row (rows
    // are document-ordered and the sweep stops at the first row below the top).
    // Only reachable when not at the bottom — flushReadCursor's nearBottom guard
    // returns before calling this once the tail is back in view.
    return rows[0]?.id;
  }
  // Is `cand` ahead of (or equal-and-newer than) the stored anchor in message
  // order? Drives the monotonic guard. A missing/stale stored anchor is treated
  // as behind, so the first write always lands.
  function isCursorAhead(cand: string, stored: string | undefined): boolean {
    if (!stored) return true;
    if (cand === stored) return false;
    const order = sm()?.order ?? [];
    return order.indexOf(cand) > order.indexOf(stored);
  }
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
      if (!sm()?.order?.length) return false;
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
      if (!order.includes(anchor) && !delivered()) return false;
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
      if (!props.draft) ackSession(props.sessionId);
    }
    setReady(true); // positioned — safe to reveal
    return true;
  }
  // When the (reused) view switches sessions, arm a restore for the new one and
  // hide it until that restore positions it. The leaving session's read cursor is
  // written on scroll-idle by the debounced observer; we cancel any pending
  // debounce here because measuring geometry now would record the WRONG session —
  // by the time this effect runs the memo/DOM have already flipped to the entering
  // session. The gap: a scroll made <400ms before switching is not persisted.
  //   - If the leaving session's anchor was already set, this is benign: the
  //     monotonic guard (isCursorAhead) keeps the last-flushed anchor, so
  //     reopening lands a little ahead of where the user was.
  //   - If the leaving session was at the BOTTOM (anchor cleared / caught-up) and
  //     the user scrolled up to read older messages, the cancelled flush leaves
  //     the anchor cleared — reopening lands at the newest message, losing the
  //     scroll-up position. This is a known edge case; a perf-safe synchronous
  //     snapshot on switch (see backlog P1-WEB-004) would close it. Measuring per
  //     scroll frame is NOT an option — it reintroduces the per-frame layout sweep
  //     behind the Firefox/WebRender heat saga (AGENTS.md "Web frontend performance").
  createEffect(
    on(
      () => props.sessionId,
      (id, prevId) => {
        if (prevId) clearTimeout(readCursorTimer);
        // Reset the self-pin sentinel: it's stale from the leaving session, and
        // an anchor restore doesn't pin to refresh it — so without this reset the
        // slice-a RO guard (scrollTop < pinnedTop) could mis-trigger against a
        // stale-large value when the user later reaches a shorter session's
        // bottom. -1 is the "no valid pin yet" sentinel (scrollTop >= -1 always
        // holds, so the first real pin after switch proceeds normally).
        pinnedTop = -1;
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
  // Drive the switch → ready loading overlay (above). Reads `revealed()` + the
  // draft flag; writes `showLoading`. The write never becomes a dependency (this
  // effect never reads showLoading), so there's no re-trigger loop. `revealed`
  // (not bare `ready()`) is the right gate here: the overlay must stay up for
  // the WHOLE partial-hydration window (messagesLoaded=false → deltas →
  // loaded), not just the positioning window, so the transcript never visibly
  // populates behind a transparent overlay.
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
      if (following()) {
        // Guard the RO re-pin path (the "↓ Latest" race). While following, a
        // growing transcript used to re-pin unconditionally — but if the user
        // scrolled UP since our last pin, that pin() would overwrite their
        // in-flight position AND re-arm pinnedTop to the new bottom, so the
        // onScrolled self-pin guard then mis-classified the override as our own
        // pin and setFollowing(false) never ran (the button never appeared).
        // Fix (Option B): only re-pin when the user hasn't moved up from the last
        // pin (scrollTop >= pinnedTop). Otherwise they scrolled up — let that
        // win: drop following and do NOT pin. (pinnedTop starts at -1, and
        // scrollTop >= -1 always holds, so the very first pin is unaffected.)
        //
        // BUT a content SHRINK also yields scrollTop < pinnedTop with no user
        // intent: when content above/around the viewport shrinks, the browser
        // clamps scrollTop down to the new (smaller) max bottom. Known triggers
        // — a reasoning/thinking block collapsing the instant it stops being the
        // tail (expanded only while tail, body up to 320px), a tool part
        // collapsing on de-tail (same !!props.tail pattern), or the
        // raw→rendered-HTML swap landing shorter than the raw stream. Those are
        // layout changes we should FOLLOW, not abandon. So only treat the dip as
        // user intent when content did NOT shrink since the last pin; otherwise
        // re-pin to the new (smaller) bottom and keep following (Live preserved).
        if (scrollEl) {
          const shrank = pinnedScrollHeight > 0 && scrollEl.scrollHeight < pinnedScrollHeight;
          if (scrollEl.scrollTop < pinnedTop && !shrank) {
            setFollowing(false);
            setUserScrolledUp(true); // genuine scroll-up since last pin (not a shrink clamp)
          } else {
            pin();
          }
        }
      }
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
      // Viewport resized (window resize, mobile keyboard toggle, layout shift).
      // When following, re-glue to the bottom: a viewport SHRINK leaves scrollTop
      // unchanged while the bottom edge (scrollHeight - clientHeight) moves down,
      // so without this we'd sit "Live" but not actually at the tail — no scroll
      // event fires on a shrink (no clamp), so onScrolled never runs to correct it
      // and the contentEl RO doesn't fire (content height unchanged). A viewport
      // GROW self-corrects via the clamp scroll event, but re-pinning there too is
      // harmless and cheaper than special-casing. Gated on ready() so initial
      // scroll-restore (maybeRestore) owns positioning until it completes.
      if (following() && ready()) pin();
    });
    ro.observe(scrollEl);
    onCleanup(() => ro.disconnect());
  });

  // Scroll handling: track follow state, advance the read cursor (debounced),
  // and mark the session read (ack) when its bottom is reached.
  function onScrolled() {
    // Our own pin() while following — not a user scroll. Skip the work;
    // following/ack/navigator are already correct (glued to the bottom).
    // NOTE the && following(): a user who scrolled up (following=false) and then
    // scrolls back to the bottom lands on the same scrollTop as the last pin (no
    // new content since → scrollHeight unchanged → same clamp); we must NOT bail
    // there or setFollowing(true) never runs and the Latest button never flips
    // back to the Live pill. pinnedTop is only ever -1 or a bottom clamp (set in
    // pin() after scrollTop=scrollHeight), so when following is false and
    // scrollTop===pinnedTop, nearBottom() is necessarily true → safe to follow.
    if (scrollEl && scrollEl.scrollTop === pinnedTop && following()) return;
    const atBottom = nearBottom();
    // Intent latch: a real user scroll-away from the bottom arms the latch so
    // the self-heal effect does NOT yank them on the next busy edge. Distinguish
    // genuine intent from a content-shrink clamp: when content above the
    // viewport shrinks (reasoning/tool block collapse, raw→rendered-HTML swap),
    // the browser clamps scrollTop down and nearBottom() can transiently flip
    // false with NO user intent — arming the latch there would suppress self-
    // heal for the rest of a settling turn. So only arm when content did NOT
    // shrink since the last pin. The own-pin bail above already returned for
    // our programmatic pins, so reaching here with atBottom=false is either a
    // user wheel/touch/drag or a system clamp — the shrink guard splits them.
    const shrank = scrollEl && pinnedScrollHeight > 0 && scrollEl.scrollHeight < pinnedScrollHeight;
    setFollowing(atBottom);
    if (atBottom) {
      setUserScrolledUp(false); // back at the bottom — re-engage intent reset
    } else if (!shrank) {
      setUserScrolledUp(true); // genuine scroll-away (not a content-shrink clamp)
    }
    if (!props.draft) {
      if (atBottom) {
        // Caught up: cursor == lastMessageID, stored as the sparse no-entry
        // default. Ack unread state now that the tail is in view.
        clearReadAnchor(props.sessionId);
        ackSession(props.sessionId);
      } else {
        // Scrolled away from the tail: schedule a debounced geometry sweep +
        // monotonic cursor write. NEVER per frame (see flushReadCursor).
        scheduleReadCursor();
      }
    }
    scheduleActiveTurn();
  }

  const [focusMode, setFocusMode] = createSignal(false);

  // Auto-grow the composer up to a cap, then scroll; keep the highlight mirror
  // scrolled in lockstep.
  let taRef: HTMLTextAreaElement | undefined;
  // Prompt-history navigation: -1 = editing the live draft; >=0 = recalled entry.
  let histIdx = -1;
  let histDraft = "";
  let mirrorRef: HTMLDivElement | undefined;
  // Command-palette "Focus composer" action.
  const onFocusComposer = () => taRef?.focus();
  onMount(() => window.addEventListener("vh:focus-composer", onFocusComposer));
  onCleanup(() => window.removeEventListener("vh:focus-composer", onFocusComposer));

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
  // long-press inserts at the caret. The hold fires from a timer (still inside
  // the Clipboard API's transient-activation window) and suppresses the click
  // that follows the release.
  let pasteHoldTimer: number | undefined;
  let pasteDidHold = false;
  const onPasteDown = () => {
    pasteDidHold = false;
    clearTimeout(pasteHoldTimer);
    pasteHoldTimer = window.setTimeout(() => {
      pasteDidHold = true;
      void pasteFromClipboard("insert");
    }, 450);
  };
  const onPasteUp = () => clearTimeout(pasteHoldTimer);
  const onPasteClick = () => {
    clearTimeout(pasteHoldTimer);
    if (pasteDidHold) {
      pasteDidHold = false;
      return; // the long-press already inserted
    }
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
    if (focusMode()) {
      ta.style.height = "100%";
    } else {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, MAX_COMPOSER_PX) + "px";
    }
    if (mirrorRef) mirrorRef.scrollTop = ta.scrollTop;
  }
  // Re-measure after any value change (typing, draft restore, send-clear).
  createEffect(() => {
    input();
    focusMode();
    queueMicrotask(autosize);
  });

  // Reset to bottom + restore this session's saved draft when switching sessions.
  createEffect(
    on(
      () => props.sessionId,
      () => {
        setFollowing(true);
        setUserScrolledUp(false); // entering a session = fresh follow intent
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
  // Persist the draft per session as it changes.
  createEffect(() => {
    const v = input();
    const sid = props.sessionId || "__new__";
    if (v) saveVersioned(draftKey(sid), 1, v);
    else localStorage.removeItem(draftKey(sid));
  });

  // In draft mode, materialize the server session on first send; otherwise use
  // the current session id.
  async function ensureSession(): Promise<string | null> {
    if (props.draft) return await createSession();
    return props.sessionId;
  }

  // Upload a file into the project's .vh-solara attachments dir and queue it
  // as a file part for the next message. Drafts get a real session first so the
  // attachment lands under sessions/<id>/.
  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const id = await ensureSession();
    if (!id) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(`/vh/attach?session=${encodeURIComponent(id)}`, {
          method: "POST",
          body: fd,
        });
        if (!res.ok) continue;
        const part = await res.json();
        if (part?.url) setAttachments((a) => [...a, { url: part.url, filename: part.filename, mime: part.mime }]);
      }
    } finally {
      setUploading(false);
      if (fileInputRef) fileInputRef.value = "";
    }
  }
  const removeAttachment = (url: string) => setAttachments((a) => a.filter((x) => x.url !== url));

  function buildParts(text: string, atts: Attachment[]): any[] {
    const parts: any[] = [];
    if (text) parts.push({ type: "text", text });
    for (const a of atts) parts.push({ type: "file", url: a.url, filename: a.filename, mime: a.mime });
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
  function sendParts(key: string, id: string, parts: any[], config: QueueConfig): Promise<boolean> {
    const body: any = { parts };
    if (config.agent) body.agent = config.agent; // only a live, enabled agent
    if (config.providerID && config.modelID) {
      body.model = { providerID: config.providerID, modelID: config.modelID };
      if (config.variant) body.variant = config.variant; // PromptInput.variant is top-level
    }
    jumpToLatest();
    return dispatchSend(key, id, `/oc/session/${encodeURIComponent(id)}/prompt_async`, body, "Message failed to send");
  }

  async function sendText(text: string, id: string): Promise<boolean> {
    const key = props.sessionId || "draft"; // guard keyed to this view, not the turn
    const atts = attachments();
    if ((!text && atts.length === 0) || !id || isSending(key)) return false;
    setSending(key, true);
    const parts = buildParts(text, atts);
    // Always send a model. OpenCode rejects a prompt with no model (brand-new
    // sessions with no model history). If models haven't loaded, fetch once.
    if (!selectionFor(id) && models().length === 0) await loadModels();
    const s = selectionFor(id);
    const config: QueueConfig = {
      providerID: s?.providerID || models()[0]?.providerID,
      modelID: s?.modelID || models()[0]?.modelID,
      variant: s?.variant,
      agent: activeAgent(props.sessionId) || undefined,
    };
    setAttachments([]);
    return sendParts(key, id, parts, config);
  }

  // Auto-drain the queue: when the session is idle and has queued messages, send
  // the next one (FIFO, one per turn — the send makes it busy again, and the
  // next idle drains the following). Guarded so concurrent effect runs can't
  // double-send.
  let draining = false;
  async function drainQueue() {
    const id = props.sessionId;
    if (props.draft || !id || draining || isSending(id) || working()) return;
    const next = dequeue(id);
    if (!next) return;
    draining = true;
    try {
      setSending(id, true);
      const config = next.sendConfig?.providerID && next.sendConfig?.modelID ? (next.sendConfig as QueueConfig) : captureConfig(id);
      await sendParts(id, id, buildParts(next.text, next.attachments), config);
    } finally {
      draining = false;
    }
  }
  // Fires on busy→idle (turn finished) and on opening an idle session that still
  // has a queue (its turn finished while elsewhere). Reads queue length + working
  // reactively; the guards above keep it single-flight.
  createEffect(() => {
    void props.sessionId;
    const idle = !working();
    const pending = !props.draft && props.sessionId ? queueFor(props.sessionId).length : 0;
    if (idle && pending > 0) queueMicrotask(() => void drainQueue());
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
    jumpToLatest();
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
    if (text) pushHistory(text); // recall with Up/Down later
    histIdx = -1;
    // Queue instead of sending while the session is busy — OpenCode rejects a
    // concurrent prompt, so we hold it and auto-send when the turn finishes.
    // (Shell/undo/redo aren't queueable — they only run against a live session.)
    if (queueMode() && !props.draft && props.sessionId && working() && !text.startsWith("!") && text !== "/undo" && text !== "/redo") {
      enqueue(props.sessionId, { text, attachments: attachments(), sendConfig: captureConfig(props.sessionId) });
      setInput("");
      setAttachments([]);
      return;
    }
    setInput("");
    // /undo /redo only make sense for an existing session.
    if (!props.draft && text === "/undo") return void undo();
    if (!props.draft && text === "/redo") return void redo();
    const id = await ensureSession();
    if (!id) {
      setInput(text); // session creation failed; keep the text for retry
      return;
    }
    // On failure, restore the composer text so a silent noop never loses what
    // the user typed (they can edit/retry instead of re-typing).
    const ok = text.startsWith("!")
      ? await runShell(text.slice(1).trim(), id)
      : await sendText(text, id);
    if (!ok) setInput(text);
  }

  // Concatenate a message's text/reasoning parts (the copyable/retryable text).
  function msgText(m: { partOrder: string[]; parts: Record<string, any> }) {
    return m.partOrder
      .map((pid) => m.parts[pid])
      .filter((p) => p && (p.type === "text" || p.type === "reasoning"))
      .map((p) => p.text || "")
      .join("\n")
      .trim();
  }
  const copyMessage = (m: any) => void navigator.clipboard?.writeText(msgText(m));
  const retry = (m: any) => void sendText(msgText(m), props.sessionId);

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
    // Shell-style history recall: Up when the caret is at the very start (so
    // multi-line editing isn't hijacked); Down steps back toward the live draft.
    if (e.key === "ArrowUp" && ta && ta.selectionStart === 0 && ta.selectionEnd === 0 && historyLen() > 0) {
      const next = Math.min(histIdx + 1, historyLen() - 1);
      const v = historyAt(next);
      if (v !== undefined) {
        e.preventDefault();
        if (histIdx === -1) histDraft = input();
        histIdx = next;
        setInput(v);
        queueMicrotask(() => ta && (ta.selectionStart = ta.selectionEnd = 0));
      }
    } else if (e.key === "ArrowDown" && histIdx >= 0) {
      e.preventDefault();
      histIdx -= 1;
      setInput(histIdx < 0 ? histDraft : historyAt(histIdx) ?? "");
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
      <div class="chat-main">
      <div class="chat-scroll" ref={scrollEl} onScroll={onScrolled}>
        <div class="chat-content" ref={contentEl} classList={{ ready: revealed() }}>
          <For each={messages()}>
            {(m, i) => (
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
                  <div class="msg-actions">
                    <button type="button" data-tip="Copy" aria-label="Copy" onClick={() => copyMessage(m)}>
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
                  />
                </Deferred>
                <Show when={messageError(m.info)}>
                  <div class="msg-error">⚠ {messageError(m.info)}</div>
                </Show>
                <Show when={inspectId() === m.id}>
                  <pre class="msg-inspect">{inspectText(m)}</pre>
                </Show>
              </div>
            )}
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

        <Show when={!following() && !focusMode() && messages().length > 0}>
          <button type="button" class="jump" onClick={jumpToLatest}>
            <Icon name="arrowDown" size={14} /> Latest
          </button>
        </Show>
      </div>
      </Show>

      <Show when={pendingQuestions().length > 0}>
        <div class="perms">
          <For each={pendingQuestions()}>{(q) => <QuestionCard question={q as any} />}</For>
        </div>
      </Show>

      <Show when={pendingPermissions().length > 0}>
        <div class="perms">
          <For each={pendingPermissions()}>
            {(p) => (
              <div class="perm-card">
                <div class="perm-title">
                  🔒 Permission requested<Show when={permLabel(p)}>: <strong>{permLabel(p)}</strong></Show>
                </div>
                <Show when={permDetail(p)}>
                  <pre class="perm-detail">{permDetail(p)}</pre>
                </Show>
                <div class="perm-actions">
                  <button type="button" onClick={() => respondPermission(props.sessionId, p.id, "once")}>
                    Allow once
                  </button>
                  <button type="button" onClick={() => respondPermission(props.sessionId, p.id, "always")}>
                    Always
                  </button>
                  <button type="button" class="reject" onClick={() => respondPermission(props.sessionId, p.id, "reject")}>
                    Reject
                  </button>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Status row pinned above the composer (out of the scroll area, so it
          never scrolls away): Working on the left, the Tasks pill on the right
          when there are open tasks. */}
      <Show when={working() || todoCounts().left > 0}>
        <div class="chat-status">
          <Show when={working()}>
            <div class="working" role="status" aria-live="polite" aria-label={workingAriaLabel()}>
              <svg class="vh-inline-mark" viewBox="440 212 136 136" aria-hidden="true">
                <g class="vh-base">
                  <path d="M440,236L483,325L498,326L541,237L526,237L493,307L490,309L455,236Z" />
                  <path d="M563,236L563,272L561,274L533,274L528,286L562,286L563,326L576,326L576,236Z" />
                  <path d="M518,229L513,229L496,266L501,266Z" />
                  <path d="M535,300L535,305L547,313L535,321L536,326L554,316L554,311Z" />
                  <path d="M490,235L471,246L471,250L490,261L490,255L478,248L490,240Z" />
                  <path d="M530,295L524,296L508,331L513,331Z" />
                </g>
                <path class="vh-current" d="M449 236L486 318L493 309L535 237M569 236L569 277L533 280L568 282L569 326" />
                <path class="vh-current hot" d="M449 236L486 318L493 309L535 237M569 236L569 277L533 280L568 282L569 326" />
              </svg>
              {/* Verb + (optional subject) + animated ellipsis + elapsed. The dots
                  sit at the END of the activity description (right before the
                  timer) so "Reading parser.go... · 4s" and "Thinking... · 3s"
                  stay consistent; subject truncates with ellipsis like .tool-subject. */}
              <span class="working-text">
                <span class="working-verb">{verb()?.verb ?? "Working"}</span>
                <Show when={verb()?.subject}>
                  {(s) => <span class="working-subject">{s()}</span>}
                </Show>
                <span class="working-dots" aria-hidden="true" />
                <Show when={verbElapsed()}>
                  {(e) => <span class="working-elapsed" aria-hidden="true"> · {e()}</span>}
                </Show>
              </span>
            </div>
          </Show>
          <Show when={todoCounts().left > 0}>
        <div class="tasks-bar" classList={{ open: todosOpen() }} ref={tasksBarEl}>
          <button type="button" class="tasks-pill" onClick={() => setTodosOpen((v) => !v)} aria-expanded={todosOpen()}>
            <span class="tasks-label">Tasks</span>
            <span class="tasks-count">{todoCounts().active} active</span>
            <span class="tasks-sep">·</span>
            <span class="tasks-count">{todoCounts().left} left</span>
            <span class="tasks-chev" classList={{ rot: todosOpen() }}><Icon name="chevronDown" size={12} /></span>
          </button>
          <Show when={todosOpen()}>
            <div class="tasks-popup" ref={(el) => { tasksPopupEl = el; restoreTasksSize(el); }}>
              {/* Top-left grip: drag to resize (grows up/left from the anchor).
                  On the shell, not the scroller, so it's always reachable. */}
              <span class="tasks-resize" title="Drag to resize" onPointerDown={startTasksResize} />
              <ul class="tasks-list">
                <For each={todoItems()}>
                  {(t) => (
                    <li class="tasks-item" classList={{ done: t.status === "completed", active: t.status === "in_progress", cancelled: t.status === "cancelled" }}>
                      <span class="tasks-item-ico">
                        <Switch fallback={<span class="tasks-pending" />}>
                          <Match when={t.status === "in_progress"}><Spinner size={13} /></Match>
                          <Match when={t.status === "completed"}><Icon name="check" size={13} /></Match>
                          <Match when={t.status === "cancelled"}><Icon name="x" size={12} /></Match>
                        </Switch>
                      </span>
                      <span class="tasks-item-text">{t.content || "(untitled)"}</span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
        </div>
          </Show>
        </div>
      </Show>

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
          {/* Queued messages waiting for the running turn to finish. */}
          <Show when={!props.draft && queueFor(props.sessionId).length > 0}>
            <div class="queue-row">
              <span class="queue-label" data-tip="Sent automatically when the current turn finishes">
                Queued
              </span>
              <For each={queueFor(props.sessionId)}>
                {(q) => (
                  <span class="queue-chip" data-tip={q.text}>
                    <span class="queue-text">{q.text || "(attachment)"}</span>
                    <button type="button" aria-label="Remove queued message" onClick={() => removeQueued(props.sessionId, q.id)}>
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                )}
              </For>
            </div>
          </Show>
          <Show when={attachments().length > 0 || uploading()}>
            <div class="attach-row">
              <For each={attachments()}>
                {(a) => (
                  <span class="attach-chip" data-tip={a.filename}>
                    <Icon name="paperclip" size={12} />
                    <span class="attach-name">{a.filename}</span>
                    <button type="button" aria-label="Remove attachment" onClick={() => removeAttachment(a.url)}>
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                )}
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
              onInput={(e) => (setInput(e.currentTarget.value), setCaret(e.currentTarget.selectionStart ?? 0), (histIdx = -1))}
              onClick={syncCaret}
              onKeyUp={syncCaret}
              onBlur={() => setTimeout(() => setAcItems([]), 150)}
              onScroll={(e) => mirrorRef && (mirrorRef.scrollTop = e.currentTarget.scrollTop)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                // Paste an image/file (e.g. a screenshot) straight into the
                // composer as an attachment; plain-text paste falls through.
                const files = e.clipboardData?.files;
                if (files && files.length > 0) {
                  e.preventDefault();
                  void addFiles(files);
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
                <button type="button" class="send-btn" aria-label="Send" onClick={send} disabled={sending() || !readyToSend()}>
                  <Icon name="send" />
                </button>
              }
            >
              {/* Busy: Stop aborts the running turn; a Queue button appears once
                  you've typed something (Enter queues too). */}
              <Show when={queueMode() && input().trim().length > 0}>
                <button type="button" class="send-btn queue" aria-label="Queue" data-tip="Queue — sends when the current turn finishes" disabled={!readyToSend()} onClick={send}>
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
