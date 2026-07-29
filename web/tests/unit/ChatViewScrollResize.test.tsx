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
//        else if (nearBottom()) {      // <-- P1-WEB-042 branch
//          setFollowing(true);
//          setUserScrolledUp(false);
//          pin();
//        }
//      This fires when a pure clientHeight GROW (composer shrink, window resize,
//      mobile keyboard dismiss) resizes the scroll viewport but NO scroll event
//      is dispatched — so onScrolled can't recover the "stuck on ↓ Latest" case.
//      The branch re-engages `following` when the resized viewport lands within
//      nearBottom() (scrollHeight - scrollTop - clientHeight < 24).
//
// REGRESSION under test: the branch consults BARE nearBottom(), bypassing the
// dual-axis classifyScrollDelta reducer that onScrolled uses. It can therefore
// yank a reader to the tail on a viewport resize that merely HAPPENS to land
// near the bottom. This characterization test PINS the current behavior at the
// observer seam so a future change (routing the branch through the reducer, or
// removing it) is detected.
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
  // the bottom, then scrolls the viewport up to establish following()=false
  // with a material gap from the bottom. Returns handles to the DOM.
  async function mountScrolledUp() {
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

    // Scroll the viewport up to a mid-history position with a material gap
    // (SH - UP_TOP - PORT = 300px >> nearBottom's 24px threshold). The dual-axis
    // reducer in onScrolled classifies this as a genuine user-scroll-up ->
    // following drops, userScrolledUp arms.
    setGeom(scroll(), { scrollTop: UP_TOP });
    scroll().dispatchEvent(new Event("scroll"));
    await flushMicro();

    // onScrolled dropped following -> the jump pill is now present.
    expect(container.querySelector(".jump")).toBeTruthy();

    return { container, scroll };
  }

  it("positive: a viewport resize that lands within nearBottom() re-engages following and pins to the bottom", async () => {
    const { container, scroll } = await mountScrolledUp();

    // Count dispatched scroll events across the remainder of the test.
    let scrollCount = 0;
    scroll().addEventListener("scroll", () => {
      scrollCount++;
    });

    // Simulate a pure clientHeight GROW (composer shrink / keyboard dismiss):
    // the viewport now places within nearBottom(). Crucially this is a
    // programmatic geometry change — NO scroll event is dispatched.
    // gap = SH - UP_TOP - grownPort = 1000 - 300 - 720 = -20 < 24 -> nearBottom.
    const GROWN_PORT = 720;
    setGeom(scroll(), { clientHeight: GROWN_PORT });
    expect(scroll().scrollTop).toBe(UP_TOP); // unchanged by the geometry write
    expect(scrollCount).toBe(0); // and no scroll event fired for it

    // Trigger ONLY the scrollEl ResizeObserver (contentEl RO stays dormant).
    ControllableRO.trigger(scroll());
    await flushMicro();

    // P1-WEB-042 branch fired: following re-engaged (jump pill gone) and pin()
    // aligned scrollTop to the bottom (scrollTop = scrollHeight = SH).
    expect(container.querySelector(".jump")).toBeNull();
    expect(scroll().scrollTop).toBe(SH);
    // Isolation: the re-engagement did NOT come from a scroll event.
    expect(scrollCount).toBe(0);
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

  it("isolation: the positive re-engagement is caused by the observer callback, not a synthetic scroll event", async () => {
    const { container, scroll } = await mountScrolledUp();

    let scrollCount = 0;
    scroll().addEventListener("scroll", () => {
      scrollCount++;
    });

    // Step 1 — apply the geometry change to a near-bottom viewport, but DO NOT
    // trigger the observer yet. The geometry change alone must NOT re-engage
    // following: there is no scroll event for onScrolled to handle, and no
    // other path flips following on without the RO firing.
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
});
