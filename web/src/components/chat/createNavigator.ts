// Chat navigator controller — the right-edge user-turn jump strip, extracted
// from ChatView (mirroring the other create... controller factories:
// createComposerAutocomplete / createAttachments / createComposerPaste /
// createPromptHistory / createQueueSync / createQueueRecovery / createSend /
// createMessageActions).
//
// The factory owns the navigator's reactive state + scheduling discipline:
//   - userTurns():  the user-role subset of the transcript (one dot each)
//   - turnText(m):  the dot's tooltip / preview-bubble label (first text part)
//   - jumpToMsg(id): scrollIntoView the [data-mid=id] row (click-to-jump)
//   - activeTurn:   the user turn currently at the top of the viewport
//   - navPreview:   the hover/focus preview bubble ({text,y}|null)
//   - navCap / navWindow: how many ticks fit + the centered visible window
//   - scheduleActiveTurn(): rAF-COALESCED recompute of activeTurn — ChatView's
//     scroll/content-RO callbacks call this; the rAF guard (navRaf) is the
//     navigator's INTERNAL scheduling discipline and stays here.
//   - measureNavCap(): recompute capacity from scrollEl.clientHeight — ChatView's
//     scrollEl ResizeObserver + onMount call this.
//
// Behavior-preserving extraction: bodies moved verbatim from ChatView, only
// `scrollEl` → `deps.scrollEl()` and `cssEsc` → `deps.cssEsc()` accessor
// threading. cssEsc is shared with ChatView's own [data-mid] scroll/anchor
// logic, so it stays owned by ChatView and is injected here (single source of
// truth — see rule #5 of the navigator extraction brief).

import { createMemo, createSignal, type Accessor } from "solid-js";
import type { MessageView } from "../../types";

export interface NavigatorDeps {
  // The full transcript (userTurns() filters to role === "user"). Defined after
  // `messages` in ChatView — createMemo runs eagerly, so it must not read it
  // before init.
  messages: Accessor<MessageView[]>;
  // The .chat-scroll element: jumpToMsg, updateActiveTurn, and measureNavCap all
  // resolve [data-mid] rows / geometry through it. Passed as an accessor because
  // ChatView owns it as a ref `let` populated at mount.
  scrollEl: Accessor<HTMLElement | undefined>;
  // Shared pure CSS.escape helper (also used by ChatView's scroll/anchor logic);
  // injected rather than duplicated.
  cssEsc: (id: string) => string;
}

export interface NavigatorController {
  // One dot per user turn, in transcript order.
  userTurns: Accessor<MessageView[]>;
  // Dot label / preview text: first text part, ws-collapsed, sliced to 140.
  turnText: (m: any) => string;
  // Click-to-jump: scrollIntoView the turn's [data-mid] row.
  jumpToMsg: (id: string) => void;
  // The user turn currently at the top of the viewport ("" until first update).
  activeTurn: Accessor<string>;
  // Hover/focus preview bubble; lifecycle is enter/focus → set, leave/blur →
  // null. Click (jumpToMsg) does NOT touch it.
  navPreview: Accessor<{ text: string; y: number } | null>;
  setNavPreview: (v: { text: string; y: number } | null) => void;
  // How many ticks fit at the fixed spacing (4px dot + 5px gap).
  navCap: Accessor<number>;
  // The visible window of ticks, centred on the active turn.
  navWindow: Accessor<{ items: MessageView[]; start: number; end: number; total: number }>;
  // rAF-coalesced recompute of activeTurn — called from ChatView's scroll/content
  // callbacks. The navRaf guard is internal to this controller.
  scheduleActiveTurn: () => void;
  // Recompute capacity from scrollEl.clientHeight — called from ChatView's
  // scrollEl ResizeObserver + onMount.
  measureNavCap: () => void;
}

export function createNavigator(deps: NavigatorDeps): NavigatorController {
  const userTurns = createMemo(() => deps.messages().filter((m: any) => m.info?.role === "user"));
  const turnText = (m: any) => {
    const pid = (m.partOrder || []).find((id: string) => m.parts[id]?.type === "text");
    const t = (pid && m.parts[pid]?.text) || "";
    return t.replace(/\s+/g, " ").trim().slice(0, 140) || "(message)";
  };
  const jumpToMsg = (id: string) => {
    deps.scrollEl()?.querySelector(`[data-mid="${deps.cssEsc(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // Navigator highlight: the user turn currently at the top of the viewport, plus
  // a hover-preview bubble. Recomputed on scroll (rAF-throttled) — desktop only.
  const [activeTurn, setActiveTurn] = createSignal<string>("");
  const [navPreview, setNavPreview] = createSignal<{ text: string; y: number } | null>(null);
  let navRaf = 0;
  function updateActiveTurn() {
    navRaf = 0;
    const scrollEl = deps.scrollEl();
    if (!scrollEl) return;
    const turns = userTurns();
    if (!turns.length) return;
    const cTop = scrollEl.getBoundingClientRect().top;
    let active = turns[0].id;
    for (const m of turns) {
      const el = scrollEl.querySelector(`[data-mid="${deps.cssEsc(m.id)}"]`) as HTMLElement | null;
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
    const scrollEl = deps.scrollEl();
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

  return {
    userTurns,
    turnText,
    jumpToMsg,
    activeTurn,
    navPreview,
    setNavPreview,
    navCap,
    navWindow,
    scheduleActiveTurn,
    measureNavCap,
  };
}
