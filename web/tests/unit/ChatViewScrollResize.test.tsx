// @vitest-environment jsdom
//
// P1-WEB-042 characterization: the scrollEl ResizeObserver's
// `else if (nearBottom())` re-engagement branch in ChatView's second onMount
// (ChatView.tsx ~L1098-1125 — the scrollEl RO; the branch itself is ~L1117-1121).
//
// ChatView registers two ResizeObservers in onMount:
//   1. contentEl RO — drives maybeRestore (scroll-position restore) + the
//      content-grow auto-follow path.
//   2. scrollEl RO  — re-glues to the bottom on viewport resize. Its body:
//        if (!scrollEl || !ready()) return;
//        if (following()) pin();
//        else {
//          if (!nearBottom()) return;                 // (1) NOW at bottom (24px)
//          const prevGap = ...;                        // pre-resize pinnedGeom gap
//          if (prevGap < RECOVERY_TAIL_GAP) {          // (2) WAS near the tail
//            setFollowing(true); setUserScrolledUp(false); pin();
//          }
//        }
//      This fires when a pure clientHeight GROW (composer shrink, window resize,
//      mobile keyboard dismiss) resizes the scroll viewport but NO scroll event
//      is dispatched — so onScrolled can't recover the "stuck on ↓ Latest" case.
//      The branch re-engages `following` only when the grow lands the reader at
//      the bottom (nearBottom()'s 24px) AND they were near the tail pre-resize.
//
// FIXED (dual gate — P1-WEB-042 no-yank + bug-2b recovery): two gates, both
// required. (1) nearBottom()'s 24px "now at the bottom" (the SAME standard
// onScrolled + the jump pill use — NOT classifyScrollDelta's 1px atBottom, which
// a composer-shrink recovery lands ~10px outside). (2) the pre-resize baseline
// (pinnedGeom) gap is within RECOVERY_TAIL_GAP (64px). onScrolled advances
// pinnedGeom to the settled geometry on every scroll, so a deliberate ~30px
// one-line scroll-up leaves a ~30px baseline gap; 64px admits that nudge
// (bug-2b) while rejecting a mid-history ~300px reader (P1-WEB-042 no-yank).
// The distinguishing signal is the pre-resize gap MAGNITUDE, not the grow size.
// These tests pin both invariants at the observer seam so a regression (bare
// nearBottom() yank, OR a too-strict baseline that drops the bug-2b recovery) is
// caught.
//
// Fixture pattern follows ChatViewAutosize.test.tsx (jsdom + controllable
// ResizeObserver / scroll geometry / requestAnimationFrame) and
// ChatViewPartlessMessage.test.tsx (setState message seeding). jsdom has NO
// layout engine, so scrollHeight / clientHeight / scrollTop are installed as
// configurable, WRITABLE own properties on the .chat-scroll element and mutated
// directly to model viewport changes. The following() signal is observed
// indirectly via the "↓ Latest" jump pill (rendered iff !following() &&
// messages().length > 0 — see ChatView.tsx ~L2674), which is why one partless
// message is seeded.

// jsdom lacks window.matchMedia (read at module-load time by layout.ts via
// ChatView's transitive deps). Install the stub BEFORE any import that triggers
// layout.ts — vi.hoisted runs before ESM imports.
vi.hoisted(() => {
  if (!(window as any).matchMedia) {
    (window as any).matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

// ChatView reads agents()/models() during render (the composer bar). Provide
// minimal fixtures (same shape as ChatViewPartlessMessage.test.tsx) so the
// component mounts without the real loaders' network calls. We never exercise
// send(), so sync/queue stay real.
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
// .trigger(target) that invokes ONLY the callback registered for `target`. This
// lets the test fire the scrollEl RO in isolation — the contentEl RO registered
// by the first onMount is never triggered here.
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
// The session-switch effect schedules `requestAnimationFrame(() => { if
// (!ready()) maybeRestore(); })` as the fallback that positions the viewport
// and flips `ready`. Replacing rAF with a manual queue makes that fallback fire
// ONLY on an explicit flushRaf(), so the test controls exactly when `ready`
// flips — a prerequisite for the scrollEl RO branch, which early-returns while
// `!ready()`.
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
// constant 0. Install configurable, WRITABLE own properties on the .chat-scroll
// element so nearBottom()/geom()/pin() read controlled values AND pin()'s
// `scrollEl.scrollTop = scrollEl.scrollHeight` assignment lands.
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

// Import ChatView AFTER the mocks are registered.
import ChatView from "../../src/components/ChatView";
import { setState } from "../../src/sync/store";
// lib/scroll's read-anchor `cache` is a MODULE-level map loaded from localStorage
// once at import. ChatView's onCleanup runs flushReadCursor() synchronously on
// unmount, which calls setReadAnchor(sid, cand) — writing that in-memory cache.
// localStorage.clear() does NOT reset the already-loaded cache, so the anchor
// leaks from one test into the next, flipping maybeRestore onto its anchor
// branch (scrollTop += delta; delta=0 in jsdom) instead of the bottom-pin else
// branch. clearReadAnchor(SID) in beforeEach wipes it for a clean restore.
import { clearReadAnchor } from "../../src/lib/scroll";

// A completed assistant message with ZERO resident parts — the minimal message
// shape that mounts cleanly in jsdom (no Part.tsx / markdown / streaming
// rendering) while satisfying messages().length > 0 so the "↓ Latest" jump pill
// (the DOM proxy for following()) can render.
const SID = "s1";
const seedPartless = (): void => {
  setState("messages", SID, {
    order: ["m1"],
    byId: {
      m1: {
        id: "m1",
        info: { role: "assistant", time: { created: 1000, completed: 2000 } },
        partOrder: [],
        parts: {},
      },
    },
  });
  setState("messagesDelivered", SID, true);
};

// Constants modelled on nearBottom()'s < 24px threshold.
const SH = 1000; // scrollHeight (tall content)
const PORT = 400; // clientHeight (modest viewport)
const UP_TOP = 300; // scrollTop after the scroll-up: gap = SH - UP_TOP - PORT = 300
// A NEAR-bottom scrollTop: gap = SH - NEAR_BOTTOM - PORT = 10 (< 24, so the
// reader is "near the bottom" while following()=false — the genuine "stuck on
// ↓ Latest" recovery case the branch exists for). The residual vs the post-pin
// baseline (scrollTop=SH, max=SH-PORT=600) is 590-600 = -10, outside epsilon,
// so onScrolled drops following on this scroll-up.
const NEAR_BOTTOM = 590;

// bug-2b (recovery must fire): a ~30px one-line scroll-up from the tail (gap =
// 30, JUST past nearBottom's 24px so following drops + ↓Latest appears), then a
// composer shrink (clientHeight GROWS +20px → PORT→420) landing gap_now = 10
// (< 24, back at the bottom). 30 < RECOVERY_TAIL_GAP(64) → the RO re-engages.
// Mirrors the e2e scroll-follow.spec.ts bug-2b case at the observer seam.
const BUG2B_SCROLL_UP = 570; // gap = SH - 570 - PORT = 30
const BUG2B_GROWN_PORT = 420; // +20px grow (one autosize row); gap_now = 10

describe("P1-WEB-042 — scrollEl ResizeObserver nearBottom() re-engagement", () => {
  let rafSaved: typeof window.requestAnimationFrame;

  beforeEach(() => {
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    })) as any;
    if (!(window as any).matchMedia) {
      (window as any).matchMedia = (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      });
    }
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
    // Wipe the module-level read-anchor cache (see clearReadAnchor import note):
    // the prior test's onCleanup wrote it synchronously at unmount.
    clearReadAnchor(SID);
  });

  afterEach(() => {
    cleanup();
    (globalThis as any).fetch = undefined;
    window.requestAnimationFrame = rafSaved;
    roRegistrations.length = 0;
    rafQueue.length = 0;
    setState("messages", SID, undefined as any);
    setState("messagesDelivered", SID, undefined as any);
    clearReadAnchor(SID);
    localStorage.clear();
  });

  // Shared mount: renders ChatView, seeds one partless message, runs the
  // maybeRestore rAF fallback so ready()=true + following()=true + pin()'d at
  // the bottom, then scrolls the viewport up to establish following()=false.
  // `scrollToTop` picks the post-scroll-up position: the default UP_TOP leaves
  // a 300px material gap (>> nearBottom's 24px threshold); NEAR_BOTTOM leaves a
  // <24px gap (the "stuck on ↓ Latest" recovery case). Returns handles to DOM.
  async function mountScrolledUp(scrollToTop: number = UP_TOP) {
    const { container } = render(() => <ChatView sessionId={SID} />);
    seedPartless();
    const scroll = () => container.querySelector(".chat-scroll") as HTMLDivElement;

    // Let onMount effects run (register both ResizeObservers).
    await flushMicro();
    expect(scroll()).toBeTruthy();

    // Initial geometry: scrollTop deliberately 0 (NOT the bottom) so the
    // post-flush assertion below DISTINGUISHES "maybeRestore ran pin()" from
    // "maybeRestore never ran". scrollHeight/clientHeight define the pin target
    // and the nearBottom() math.
    setGeom(scroll(), { scrollTop: 0, scrollHeight: SH, clientHeight: PORT });

    // maybeRestore rAF fallback -> ready=true, following=true, pin() sets
    // scrollTop = scrollHeight (= SH).
    flushRaf();
    await flushMicro();

    // Precondition: pin() ran (scrollTop moved 0 -> SH) AND following is on
    // (no jump pill). If this fails, the observer branch under test can never
    // execute (it early-returns while !ready()), so every case below is moot.
    expect(scroll().scrollTop).toBe(SH);
    expect(container.querySelector(".jump")).toBeNull();

    // Scroll the viewport up to `scrollToTop`. The dual-axis reducer in
    // onScrolled classifies any residual-outside-epsilon move as a genuine
    // user-scroll-up -> following drops, userScrolledUp arms.
    setGeom(scroll(), { scrollTop: scrollToTop });
    scroll().dispatchEvent(new Event("scroll"));
    await flushMicro();

    // onScrolled dropped following -> the jump pill is now present.
    expect(container.querySelector(".jump")).toBeTruthy();

    return { container, scroll };
  }

  it("positive (P1-WEB-042 fixed): a pure clientHeight GROW mid-transcript does NOT yank a mid-history reader to the tail", async () => {
    const { container, scroll } = await mountScrolledUp();

    // Count dispatched scroll events across the remainder of the test.
    let scrollCount = 0;
    scroll().addEventListener("scroll", () => {
      scrollCount++;
    });

    // Simulate a pure clientHeight GROW (composer shrink / keyboard dismiss)
    // on a reader scrolled up mid-history: gap = SH - UP_TOP - grownPort =
    // 1000 - 300 - 720 = -20, which trips bare nearBottom() even though the
    // reader was 300px from the bottom BEFORE the resize. Crucially this is a
    // programmatic geometry change — NO scroll event is dispatched.
    const GROWN_PORT = 720;
    setGeom(scroll(), { clientHeight: GROWN_PORT });
    expect(scroll().scrollTop).toBe(UP_TOP); // unchanged by the geometry write
    expect(scrollCount).toBe(0); // and no scroll event fired for it

    // Trigger ONLY the scrollEl ResizeObserver (contentEl RO stays dormant).
    ControllableRO.trigger(scroll());
    await flushMicro();

    // FIXED (P1-WEB-042): the branch consults the dual-axis baseline
    // (pinnedGeom: the reader was 300px from the bottom) and so does NOT
    // re-engage following and does NOT pin. The reader stays put mid-history;
    // the jump pill remains; zero scroll events.
    expect(container.querySelector(".jump")).toBeTruthy(); // following stays off
    expect(scroll().scrollTop).toBe(UP_TOP); // position preserved (no yank)
    expect(scrollCount).toBe(0); // no scroll event
  });

  it("negative: a viewport resize that leaves a material gap from the bottom does NOT force-follow or move the viewport", async () => {
    const { container, scroll } = await mountScrolledUp();

    let scrollCount = 0;
    scroll().addEventListener("scroll", () => {
      scrollCount++;
    });

    // Keep the material gap (no geometry change): SH - UP_TOP - PORT = 300 > 24.
    // Trigger the SAME scrollEl observer.
    ControllableRO.trigger(scroll());
    await flushMicro();

    // The branch's nearBottom() guard is false -> nothing fires: position is
    // preserved, following stays off (jump pill still present), no scroll event.
    expect(scroll().scrollTop).toBe(UP_TOP);
    expect(container.querySelector(".jump")).toBeTruthy();
    expect(scrollCount).toBe(0);
  });

  it("isolation: a legit near-bottom re-engagement is caused by the observer callback, not a synthetic scroll event", async () => {
    // Mount scrolled to a NEAR-bottom stuck position (following()=false but
    // only ~10px from the bottom — the genuine "stuck on ↓ Latest" recovery
    // case the branch exists for). A pure clientHeight GROW then lands the
    // reader AT the bottom; the fixed branch re-engages because the baseline
    // was near-bottom (contrast the positive case, where a 300px gap means no
    // re-engagement).
    const { container, scroll } = await mountScrolledUp(NEAR_BOTTOM);

    let scrollCount = 0;
    scroll().addEventListener("scroll", () => {
      scrollCount++;
    });

    // Step 1 — apply the geometry change but DO NOT trigger the observer yet.
    // The geometry change alone must NOT re-engage following: there is no
    // scroll event for onScrolled to handle, and no other path flips following
    // on without the RO firing.
    setGeom(scroll(), { clientHeight: 720 });
    await flushMicro();
    expect(scrollCount).toBe(0);
    expect(container.querySelector(".jump")).toBeTruthy(); // still not following

    // Step 2 — NOW trigger ONLY the scrollEl observer. With zero scroll events
    // throughout, the only possible cause of re-engagement is the callback.
    ControllableRO.trigger(scroll());
    await flushMicro();

    expect(container.querySelector(".jump")).toBeNull(); // following re-engaged
    expect(scroll().scrollTop).toBe(SH); // pin aligned to bottom
    expect(scrollCount).toBe(0); // zero scroll events total
  });

  it("bug-2b recovery: a ~30px scroll-up (one line) + a small composer-shrink grow re-engages following", async () => {
    // The e2e scroll-follow.spec.ts bug-2b case at the observer seam. A reader
    // essentially at the tail scrolls UP ~30px (one line — just past nearBottom's
    // 24px so following drops + ↓Latest appears), then shrinks the composer
    // (autosize → clientHeight GROWS ~20px), landing back within nearBottom. The
    // RO MUST re-engage — this is the genuine "stuck on ↓ Latest" recovery. It is
    // the motivating counter-case to the P1-WEB-042 no-yank test above: there the
    // reader is ~300px up (mid-history) and a grow must NOT yank; here the reader
    // is ~30px up (at the tail) and a grow MUST recover. The pinnedGeom baseline
    // gap is exactly the scroll-up distance (30px) because onScrolled advances
    // pinnedGeom to the settled geometry on every scroll — so this case fails the
    // OLD strict <24 baseline gate (30 > 24) and proves the RECOVERY_TAIL_GAP
    // widening is load-bearing, not decorative.
    const { container, scroll } = await mountScrolledUp(BUG2B_SCROLL_UP);

    let scrollCount = 0;
    scroll().addEventListener("scroll", () => {
      scrollCount++;
    });

    // Composer-shrink-magnitude grow: clientHeight +20px (one autosize row). New
    // gap = SH - BUG2B_SCROLL_UP - BUG2B_GROWN_PORT = 10 (< nearBottom 24); no
    // clamp (570 < newMax = SH - 420 = 580), so scrollTop is unchanged and NO
    // scroll event is dispatched for the geometry write.
    setGeom(scroll(), { clientHeight: BUG2B_GROWN_PORT });
    expect(scroll().scrollTop).toBe(BUG2B_SCROLL_UP); // unchanged by the geometry write
    expect(scrollCount).toBe(0); // and no scroll event fired for it

    // Trigger ONLY the scrollEl ResizeObserver (contentEl RO stays dormant).
    ControllableRO.trigger(scroll());
    await flushMicro();

    // Recovery: following re-engaged (↓Latest gone), pin aligned to the bottom,
    // and zero scroll events total (the RO branch recovered with no scroll event
    // — the path onScrolled cannot take).
    expect(container.querySelector(".jump")).toBeNull(); // following re-engaged
    expect(scroll().scrollTop).toBe(SH); // pin aligned to bottom
    expect(scrollCount).toBe(0); // zero scroll events total
  });

  it("bug-2b guardrail: a mid-history reader (~300px) is NOT yanked even though a large grow overlaps the bottom", async () => {
    // The P1-WEB-042 no-yank invariant restated as the bug-2b sibling: a reader
    // scrolled up mid-history (gap = 300, via UP_TOP) whose viewport GROWS enough
    // to OVERLAP the bottom (clientHeight → 720, gap_now = -20, clamped) must NOT
    // re-engage following. 300 > RECOVERY_TAIL_GAP(64) → no yank. This is the
    // case that distinguishes "near-tail recovery" (bug-2b, gap 30) from
    // "mid-history overlap" (P1-WEB-042, gap 300): same large grow, different
    // baseline gap — only the gap magnitude separates them.
    const { container, scroll } = await mountScrolledUp(UP_TOP);

    let scrollCount = 0;
    scroll().addEventListener("scroll", () => {
      scrollCount++;
    });

    // Large clientHeight grow that overlaps the bottom: gap_now = SH - UP_TOP -
    // 720 = -20 (clamped to 0 → nearBottom true), yet the reader was 300px up.
    setGeom(scroll(), { clientHeight: 720 });
    expect(scroll().scrollTop).toBe(UP_TOP); // unchanged by the geometry write
    expect(scrollCount).toBe(0);

    ControllableRO.trigger(scroll());
    await flushMicro();

    // No yank: following stays off (↓Latest present), position preserved, no
    // scroll event.
    expect(container.querySelector(".jump")).toBeTruthy(); // following stays off
    expect(scroll().scrollTop).toBe(UP_TOP); // position preserved (no yank)
    expect(scrollCount).toBe(0); // no scroll event
  });
});
