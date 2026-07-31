// @vitest-environment jsdom
//
// Navigator characterization (P1-WEB-0xx): pins the behavior of the right-edge
// user-turn jump strip in ChatView (~ChatView.tsx L242-293 logic + L1537-1581
// JSX) BEFORE it is extracted into `<ChatNavigator>` + `createNavigator()`.
// These are characterization tests: they mount the REAL ChatView and assert the
// navigator's observable invariants so a future extraction that silently
// changes behavior is caught.
//
// Navigator concern under test (lines re-derived from current ChatView.tsx):
//   - userTurns()         L242  messages().filter(role === "user")
//   - turnText(m)         L243  first text-part text, ws-collapsed, slice 140
//   - jumpToMsg(id)       L249  scrollEl.querySelector([data-mid=id])
//                               .scrollIntoView({behavior:"smooth",block:"start"})
//   - activeTurn signal   L254  "" until updateActiveTurn runs
//   - navPreview signal   L255  {text,y}|null — HOVER/FOCUS lifecycle only
//   - updateActiveTurn()  L257  cTop=scrollEl.rect.top; for each turn in order,
//                               if el.rect.top - cTop <= 8 → active=el.id else
//                               break; setActiveTurn(active)
//   - scheduleActiveTurn  L272  rAF-COALESCED: if(!navRaf) navRaf=rAF(update)
//   - navCap / measureNavCap L277  init 15; usable=clientHeight-48;
//                               setNavCap(max(5,floor(usable/9)))
//   - navWindow memo      L285  cap=max(3,min(navCap,N)); center on activeTurn
//   - render gate (JSX)   L1537 <Show when={isDesktop() && userTurns().length>1}>
//
// NOTE on navPreview: the task brief's "navPreview clears after jump" does NOT
// match the real code — onClick calls jumpToMsg only and never touches
// navPreview. navPreview is set on mouseenter/focus and cleared on
// mouseleave/blur (L1559-1562). These tests characterize the REAL lifecycle.
//
// Fixture pattern mirrors ChatViewScrollResize.test.tsx (jsdom + controllable
// ResizeObserver / scroll geometry / requestAnimationFrame + setState seeding).
// jsdom has no layout engine: scrollHeight/clientHeight/scrollTop are writable
// own props, and getBoundingClientRect (read by updateActiveTurn) is shadowed
// per-element to model turn positions. The desktop render gate requires
// isDesktop()=true; layout.ts reads window.matchMedia at MODULE-LOAD time, so a
// desktop-true matchMedia stub is installed via vi.hoisted BEFORE any component
// import is evaluated (the shared _matchMedia.ts returns matches:false for ALL
// queries, which would hide the navigator — it is intentionally NOT used here).

// Install a desktop-true matchMedia BEFORE the component import graph loads.
// vi.hoisted runs ahead of static ESM imports, so layout.ts's module-load
// `matchMedia("(min-width: 721px)").matches` reads `true`. The desktop query
// contains "721"; pointer/display-mode queries (also probed at runtime) do not,
// so they read false — only isDesktop() is flipped true here.
vi.hoisted(() => {
  const w = globalThis as unknown as { matchMedia?: unknown };
  w.matchMedia = (query: string) => ({
    matches: /721/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

// ChatView reads agents()/models() during render (composer bar). Provide minimal
// fixtures (same shape as ChatViewPartlessMessage.test.tsx) so the component
// mounts without real network calls. send() is never exercised, so sync/queue
// stay real.
vi.mock("../../src/agents", () => ({
  agents: () => [{ name: "build", description: "build agent", mode: "primary" }],
  selectedAgent: () => "build",
  agentForSession: () => "build",
  activeAgent: () => "build",
  selectAgentForSession: vi.fn(),
  loadAgents: vi.fn(),
  setSelectedAgent: vi.fn(),
}));

vi.mock("../../src/models", () => ({
  models: () => [{
    providerID: "test",
    modelID: "m1",
    provider: "Test",
    name: "M1",
    label: "Test / M1",
    variants: [],
  }],
  selectionFor: () => null,
  findModel: () => undefined,
  chooseVariant: vi.fn(),
  chooseModel: vi.fn(),
  applyModel: vi.fn(),
  loadModels: vi.fn(),
}));

// --- Controllable ResizeObserver -------------------------------------------
// Records every (element, callback) pair from .observe() and exposes a static
// .trigger(target) that invokes ONLY the callback registered for `target`. Not
// directly driven by these tests (navigator geometry comes from
// getBoundingClientRect), but ChatView registers two ROs in onMount and the
// controllable form keeps them dormant so mount stays deterministic.
type ROCb = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void;
const roRegistrations: { el: Element; cb: ROCb }[] = [];
const FAKE_RO: ResizeObserver = {} as ResizeObserver;

class ControllableRO {
  private cb: ROCb;
  constructor(cb: ROCb) {
    this.cb = cb;
  }
  observe(el: Element): void {
    roRegistrations.push({ el, cb: this.cb });
  }
  unobserve(): void {}
  disconnect(): void {}
  static trigger(target: Element): void {
    for (const r of roRegistrations) {
      if (r.el === target) r.cb([], FAKE_RO);
    }
  }
}

// --- Controllable requestAnimationFrame ------------------------------------
// ChatView's session-switch effect schedules `rAF(() => { if (!ready())
// maybeRestore(); })` to position the viewport + flip ready(); the navigator's
// scheduleActiveTurn() also routes updateActiveTurn through rAF. Replacing rAF
// with a manual queue makes BOTH fire only on an explicit flushRaf(), so the
// test controls exactly when ready flips and when activeTurn recomputes.
const rafQueue: FrameRequestCallback[] = [];
const flushRaf = (): void => {
  // Drain in batches; callbacks may queue further rAFs. Bounded to avoid an
  // accidental infinite loop from a component that re-schedules every frame.
  let guard = 0;
  while (rafQueue.length && guard < 50) {
    const batch = rafQueue.splice(0);
    const t = performance.now();
    for (const cb of batch) cb(t);
    guard++;
  }
};

// Solid flushes reactive DOM updates via microtasks; a 0ms setTimeout returns
// only after the microtask queue drains.
const flushMicro = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// --- Geometry model --------------------------------------------------------
// jsdom has no layout engine: native scrollHeight/clientHeight/scrollTop are
// constant 0. Install configurable, WRITABLE own properties on .chat-scroll so
// pin()/maybeRestore read controlled values AND pin()'s scrollTop assignment
// lands. updateActiveTurn reads getBoundingClientRect().top on the scroll
// container and each [data-mid] row — those are shadowed per-element via
// stubRect() to model turn positions.
type Geom = { scrollTop?: number; scrollHeight?: number; clientHeight?: number };
function setGeom(el: HTMLElement, g: Geom): void {
  for (const key of Object.keys(g) as (keyof Geom)[]) {
    Object.defineProperty(el, key, {
      configurable: true,
      writable: true,
      value: g[key],
    });
  }
}

// Shadow getBoundingClientRect on a single element with a fixed top. Only
// `.top` is read by updateActiveTurn, so the stub returns just that.
function stubRect(el: Element, top: number): void {
  el.getBoundingClientRect = (() => ({ top } as DOMRect)) as typeof el.getBoundingClientRect;
}

// Import ChatView AFTER the mocks + matchMedia stub are registered.
import ChatView from "../../src/components/ChatView";
import { setState } from "../../src/sync/store";
// lib/scroll's read-anchor `cache` is a MODULE-level map loaded from localStorage
// once at import. ChatView's onCleanup runs flushReadCursor() on unmount, which
// writes that in-memory cache; localStorage.clear() does NOT reset the
// already-loaded cache, so it leaks across tests and flips maybeRestore onto its
// anchor branch. clearReadAnchor(SID) in beforeEach wipes it for a clean restore.
import { clearReadAnchor } from "../../src/lib/scroll";

const SID = "s1";

// Seed a conversation of `n` interleaved user/assistant turns. Each user turn
// ("u{i}", role "user") carries one text part `Turn {i}` so turnText() resolves
// to that label; each assistant turn ("a{i}", role "assistant") is partless so
// MessageRow mounts cleanly without rendering any Part. The resulting
// userTurns() is exactly [u0..u{n-1}] in order.
function seedConversation(n: number): void {
  const order: string[] = [];
  const byId: Record<string, any> = {};
  for (let i = 0; i < n; i++) {
    const uid = `u${i}`;
    order.push(uid);
    byId[uid] = {
      id: uid,
      info: { role: "user", time: { created: 1000 + i, completed: 2000 + i } },
      partOrder: ["p0"],
      parts: { p0: { type: "text", text: `Turn ${i}` } },
    };
    const aid = `a${i}`;
    order.push(aid);
    byId[aid] = {
      id: aid,
      info: { role: "assistant", time: { created: 3000 + i, completed: 4000 + i } },
      partOrder: [],
      parts: {},
    };
  }
  setState("messages", SID, { order, byId });
  setState("messagesDelivered", SID, true);
}

const SH = 1000; // scrollHeight (tall content)
const PORT = 400; // clientHeight (modest viewport)

// Shared mount: renders ChatView, seeds `n` user turns, runs the maybeRestore
// rAF fallback so ready()=true + following()=true + pin()'d at the bottom
// (scrollTop=SH). measureNavCap() runs in scrollEl onMount during the first
// flushMicro with jsdom clientHeight=0, so navCap()=5 deterministically
// (max(5, floor((0-48)/9)) = 5) — this is the capacity Test 3 relies on.
async function mountNav(n: number) {
  const { container } = render(() => <ChatView sessionId={SID} />);
  seedConversation(n);
  await flushMicro(); // onMount effects register + run (measureNavCap -> navCap=5)
  const scroll = () => container.querySelector(".chat-scroll") as HTMLDivElement;
  expect(scroll()).toBeTruthy();
  // Initial geometry: scrollTop=0 (NOT the bottom) so the post-flush assertion
  // DISTINGUISHES "maybeRestore ran pin()" from "maybeRestore never ran".
  setGeom(scroll(), { scrollTop: 0, scrollHeight: SH, clientHeight: PORT });
  flushRaf(); // switch rAF -> maybeRestore -> ready, pin (scrollTop=SH), following=true
  await flushMicro();
  // Precondition: pin() ran. If this fails, onScrolled's ready() guard rejects
  // every scroll below, so all navigator driver tests are moot.
  expect(scroll().scrollTop).toBe(SH);
  return { container, scroll };
}

// Model turn positions: the scroll container sits at top=0, and each user-turn
// row [data-mid="u{i}"] sits at tops[i]. updateActiveTurn marks turns whose
// (row.top - cTop) <= 8 active, breaking at the first turn past that fold.
function layoutTurns(scroll: HTMLElement, tops: number[]): void {
  stubRect(scroll, 0);
  for (let i = 0; i < tops.length; i++) {
    const el = scroll.querySelector(`[data-mid="u${i}"]`);
    if (el) stubRect(el, tops[i]);
  }
}

// Drive scheduleActiveTurn via the real onScrolled handler bound to .chat-scroll
// (ChatView.tsx ~L958, onScroll at ~L1413). Moving scrollTop >1px from the
// pinned baseline bypasses the own-pin early-return so onScrolled reaches its
// terminal scheduleActiveTurn() call. updateActiveTurn then runs on flushRaf().
function driveActiveViaScroll(scroll: HTMLElement, scrollTop: number): void {
  setGeom(scroll, { scrollTop });
  scroll.dispatchEvent(new Event("scroll"));
}

// jsdom does not implement Element.scrollIntoView, so jumpToMsg() (onClick of
// every navigator dot) throws "scrollIntoView is not a function" when a click is
// dispatched. Install a no-op shim on Element.prototype so click-driven jumps
// are observable (Test 4 spies an own property that shadows this) without
// crashing. Saved/restored per file; isolate=true keeps it file-scoped.
const savedScrollIntoView = Element.prototype.scrollIntoView;

describe("ChatView navigator (characterization)", () => {
  let rafSaved: typeof window.requestAnimationFrame;

  beforeEach(() => {
    Element.prototype.scrollIntoView = (() => {}) as typeof Element.prototype.scrollIntoView;
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    })) as any;
    (globalThis as any).IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
    (globalThis as any).PointerEvent = class extends MouseEvent {
      pointerId = 0;
      pointerType = "";
    };
    (globalThis as any).ResizeObserver = ControllableRO;
    rafSaved = window.requestAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    }) as typeof window.requestAnimationFrame;
    localStorage.clear();
    clearReadAnchor(SID);
  });

  afterEach(() => {
    cleanup();
    (globalThis as any).fetch = undefined;
    window.requestAnimationFrame = rafSaved;
    Element.prototype.scrollIntoView = savedScrollIntoView;
    roRegistrations.length = 0;
    rafQueue.length = 0;
    setState("messages", SID, undefined as any);
    setState("messagesDelivered", SID, undefined as any);
    clearReadAnchor(SID);
    localStorage.clear();
  });

  it("activeTurn tracks the scroll position: the turn at the top of the viewport is marked aria-current", async () => {
    // 3 user turns. Position u1 at the top of the fold (tops[1]=5<=8) and u2
    // below it (tops[2]=300>8): updateActiveTurn should mark u1 active.
    const { container, scroll } = await mountNav(3);
    layoutTurns(scroll(), [0, 5, 300]);

    // Initially activeTurn is "" — no scroll has driven updateActiveTurn yet, so
    // NO dot carries aria-current. This baseline makes the post-scroll assertion
    // mutation-observable (it FAILS if updateActiveTurn never runs / never reads
    // the rect positions).
    const activeDot = () => container.querySelector('.chat-nav-dot[aria-current="true"]');
    expect(activeDot()).toBeNull();

    // Scroll up off the pinned baseline so onScrolled reaches scheduleActiveTurn.
    driveActiveViaScroll(scroll(), SH - 100);
    flushRaf(); // updateActiveTurn runs: scans tops, marks u1 active
    await flushMicro();

    // u1 is the topmost turn within the fold -> it is the active turn.
    expect(activeDot()).toBeTruthy();
    expect((activeDot() as HTMLElement).getAttribute("aria-label")).toBe("Turn 1");
  });

  it("the navigator renders exactly one dot per user turn, in message order", async () => {
    // 3 user turns interleaved with 3 assistant turns. The navigator must show
    // one dot per USER turn (not per message) and in transcript order.
    const { container } = await mountNav(3);

    const dots = () => [...container.querySelectorAll(".chat-nav-dot")] as HTMLButtonElement[];
    expect(dots().length).toBe(3);
    // Labels follow userTurns() order ([u0,u1,u2] -> "Turn 0","Turn 1","Turn 2"),
    // NOT the interleaved message order. Pins against a future extraction that
    // maps dots to all messages or reverses the order.
    expect(dots().map((d) => d.getAttribute("aria-label"))).toEqual([
      "Turn 0",
      "Turn 1",
      "Turn 2",
    ]);
  });

  it("navWindow centers on the active turn and reveals up/down chevrons when turns exceed capacity", async () => {
    // 8 user turns but navCap()=5 (jsdom mount default), so the visible window
    // is a 5-wide slice centered on the active turn. navWindow centers via
    // start = max(0, min(ai - floor(cap/2), N-cap)); with cap=5, floor(cap/2)=2,
    // so an active index of 4 (u4) yields start=2, end=7 (items u2..u6) with u4
    // at window-offset 2 (the middle of 5). Position u4 at the top of the fold
    // (tops[4]=8<=8) and u5 below it (tops[5]=300>8) so updateActiveTurn marks
    // u4 active, and BOTH chevrons appear (start>0 AND end<total).
    const { container, scroll } = await mountNav(8);
    layoutTurns(scroll(), [0, 2, 4, 6, 8, 300, 400, 500]);
    driveActiveViaScroll(scroll(), SH - 100);
    flushRaf(); // updateActiveTurn -> active = u4
    await flushMicro();

    // Capacity is honored: exactly 5 dots rendered (not 8).
    const dots = () => [...container.querySelectorAll(".chat-nav-dot")] as HTMLButtonElement[];
    expect(dots().length).toBe(5);
    // The window is the centered slice [u2,u3,u4,u5,u6].
    expect(dots().map((d) => d.getAttribute("aria-label"))).toEqual([
      "Turn 2",
      "Turn 3",
      "Turn 4",
      "Turn 5",
      "Turn 6",
    ]);
    // Active dot is the centered u4.
    const activeDot = container.querySelector('.chat-nav-dot[aria-current="true"]');
    expect(activeDot).toBeTruthy();
    expect((activeDot as HTMLElement).getAttribute("aria-label")).toBe("Turn 4");

    // Up-chevron (earlier turns exist) and down-chevron (later turns exist) both
    // render. The up button carries the "up" class; the down button does NOT.
    expect(container.querySelector(".chat-nav-more.up")).toBeTruthy();
    expect(container.querySelector(".chat-nav-more:not(.up)")).toBeTruthy();
  });

  it("clicking a dot jumps to that turn's message via scrollIntoView", async () => {
    const { container, scroll } = await mountNav(3);

    // The dot labelled "Turn 1" corresponds to user turn u1. jumpToMsg("u1")
    // resolves scrollEl.querySelector([data-mid="u1"]).scrollIntoView(...). Spy
    // on that row's scrollIntoView to observe the jump without relying on jsdom's
    // (absent) scrolling behavior.
    const target = scroll().querySelector('[data-mid="u1"]') as HTMLElement;
    expect(target).toBeTruthy();
    const spy = vi.fn();
    target.scrollIntoView = spy as typeof target.scrollIntoView;

    const dot = ([...container.querySelectorAll(".chat-nav-dot")] as HTMLButtonElement[]).find(
      (d) => d.getAttribute("aria-label") === "Turn 1",
    );
    expect(dot).toBeTruthy();
    fireEvent.click(dot!);

    // jumpToMsg invoked scrollIntoView with the smooth+start options. Pins the
    // click-to-jump wiring against a future extraction that drops the call or
    // changes the scroll options.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  it("navPreview is a hover/focus bubble: shown on enter/focus, cleared on leave/blur (click does NOT clear it)", async () => {
    // Characterizes the REAL navPreview lifecycle (L1559-1562): set on
    // mouseenter/onFocus, cleared on mouseleave/onBlur. onClick (jumpToMsg)
    // does NOT touch navPreview, so a jump alone leaves the bubble in whatever
    // hover/focus state it was in.
    const { container, scroll } = await mountNav(3);
    void scroll;
    const bubble = () => container.querySelector(".chat-nav-bubble");

    // Baseline: no bubble.
    expect(bubble()).toBeNull();

    const dots = () => [...container.querySelectorAll(".chat-nav-dot")] as HTMLButtonElement[];

    // --- hover lifecycle ---
    fireEvent.mouseEnter(dots()[1]); // u1
    await flushMicro();
    expect(bubble()).toBeTruthy();
    expect((bubble() as HTMLElement).textContent).toBe("Turn 1");

    // Leaving the dot clears the bubble.
    fireEvent.mouseLeave(dots()[1]);
    await flushMicro();
    expect(bubble()).toBeNull();

    // --- focus lifecycle ---
    fireEvent.focus(dots()[2]); // u2
    await flushMicro();
    expect(bubble()).toBeTruthy();
    expect((bubble() as HTMLElement).textContent).toBe("Turn 2");

    fireEvent.blur(dots()[2]);
    await flushMicro();
    expect(bubble()).toBeNull();

    // --- click does NOT manage the bubble ---
    // Re-arm the bubble via hover, then click the SAME dot: jumpToMsg fires but
    // navPreview is untouched, so the bubble persists. (If a future extraction
    // made click clear the bubble, that is a behavior change these tests flag.)
    fireEvent.mouseEnter(dots()[0]); // u0
    await flushMicro();
    expect(bubble()).toBeTruthy();
    expect((bubble() as HTMLElement).textContent).toBe("Turn 0");
    fireEvent.click(dots()[0]);
    await flushMicro();
    expect(bubble()).toBeTruthy(); // still present — click did not clear it
  });

  it("scheduleActiveTurn rAF-coalesces: many scroll events queue exactly one updateActiveTurn", async () => {
    const { container, scroll } = await mountNav(3);
    layoutTurns(scroll(), [0, 5, 300]);
    const activeDot = () => container.querySelector('.chat-nav-dot[aria-current="true"]');

    // After mount the rAF queue is drained. Capture the baseline length, then
    // fire three scroll events in rapid succession. The first (following=true,
    // delta>1) bypasses the own-pin bail and calls scheduleActiveTurn, which
    // queues updateActiveTurn and sets navRaf. The next two (following now
    // false) also reach scheduleActiveTurn but navRaf is already set, so they
    // are COALESCED — no further rAF is queued.
    const before = rafQueue.length;
    driveActiveViaScroll(scroll(), SH - 100);
    driveActiveViaScroll(scroll(), SH - 110);
    driveActiveViaScroll(scroll(), SH - 120);

    // Exactly ONE rAF was queued across the three scrolls.
    expect(rafQueue.length - before).toBe(1);

    // Flushing it runs updateActiveTurn exactly once: activeTurn resolves to u1
    // (tops[1]=5 within the fold, tops[2]=300 past it).
    flushRaf();
    await flushMicro();
    expect(activeDot()).toBeTruthy();
    expect((activeDot() as HTMLElement).getAttribute("aria-label")).toBe("Turn 1");
  });
});
