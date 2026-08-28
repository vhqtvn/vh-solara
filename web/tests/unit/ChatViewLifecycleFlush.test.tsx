// @vitest-environment jsdom
//
// Resume-state preservation (slice 2): the scroll read-anchor (vh.scroll.v2)
// is flushed on page-lifecycle suspension so the last scroll position
// survives an OS-driven eviction/resume. The 400ms debounced scheduleReadCursor
// can be pending when the OS suspends the page (mobile PWA backgrounded →
// evicted); pagehide/freeze are the last reliable pre-suspend signals and
// visibilitychange→hidden is the iOS Safari backstop (iOS does not fire freeze).
//
// These are MECHANISM assertions (the lifecycle listeners fire flushReadCursor
// synchronously + cancel the pending debounce), NOT outcome proofs: the
// load-bearing outcome (scroll position survives a real OS eviction) is not
// reproducible in any CI lane here (headless Playwright cannot drive OS-level
// standalone-PWA eviction) and requires the operator's manual on-device test.
// See the slice closeout's behavioral-closure section.
//
// Fixture pattern follows ChatViewScrollResize.test.tsx (jsdom + controllable
// ResizeObserver / scroll geometry / requestAnimationFrame + partless message
// seeding). lib/scroll is mocked so the read-anchor writes are observable
// spies; the geometry is set to near-bottom so flushReadCursor takes the
// clearReadAnchor path (geometry-only, no DOM-row-rendering dependency).

// jsdom lacks window.matchMedia (read at module-load time by layout.ts via
// ChatView's transitive deps). Import the shared stub BEFORE any import that
// triggers layout.ts — see _matchMedia.ts.
import "./_matchMedia";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

// ChatView reads agents()/models() during render (the composer bar). Provide
// minimal fixtures so the component mounts without the real loaders' network
// calls (same shape as ChatViewScrollResize.test.tsx).
vi.mock("../../src/agents", () => ({
  agents: () => [{ name: "build", description: "build agent", mode: "primary" }],
  selectedAgent: () => "build",
  agentForSession: () => "build",
  awaitSendAgent: async () => ({ ok: true, agent: "build" }),
  resolveAgentForSession: () => ({ state: "agent", agent: "build" }),
  adoptDraftAgent: vi.fn(),
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

// Spy on the read-anchor writes so we can prove flushReadCursor ran. The pure
// helpers (classifyScrollDelta, bottommostReadWithFallback, orderAhead) pass
// through from the real module. getReadAnchor returns undefined so maybeRestore
// takes its bottom-pin branch (no stored anchor → pin at bottom → following).
vi.mock("../../src/lib/scroll", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/scroll")>();
  return {
    ...real,
    clearReadAnchor: vi.fn(),
    setReadAnchor: vi.fn(),
    getReadAnchor: vi.fn(() => undefined),
  };
});

// --- Controllable ResizeObserver (records observe() calls; static trigger) ---
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

// --- Controllable requestAnimationFrame (manual queue; flushRaf drains it) ---
const rafQueue: FrameRequestCallback[] = [];
const flushRaf = (): void => {
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

// --- Geometry model (jsdom has no layout engine; install writable own props) ---
type Geom = { scrollTop?: number; scrollHeight?: number; clientHeight?: number };
function setGeom(el: HTMLElement, g: Geom): void {
  for (const key of Object.keys(g) as (keyof Geom)[]) {
    Object.defineProperty(el, key, { configurable: true, writable: true, value: g[key] });
  }
}

// Import ChatView + the spied read-anchor fns AFTER the mocks are registered.
import ChatView from "../../src/components/ChatView";
import { setState } from "../../src/sync/store";
import { clearReadAnchor, setReadAnchor } from "../../src/lib/scroll";

// A completed assistant message with ZERO resident parts — mounts cleanly in
// jsdom (no Part.tsx / markdown rendering) while satisfying messages().length>0.
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

const SH = 1000; // scrollHeight (tall content)
const PORT = 400; // clientHeight (modest viewport)
const UP_TOP = 300; // a scrolled-up position: gap = SH - UP_TOP - PORT = 300 (>> 24)
// A near-bottom scrollTop: gap = SH - NEAR_BOTTOM - PORT = 10 (< 24, nearBottom true)
// so flushReadCursor takes the clearReadAnchor (caught-up) path — observable via
// the spy, with NO DOM-row-rendering dependency.
const NEAR_BOTTOM = 590;

beforeEach(() => {
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
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  }) as typeof window.requestAnimationFrame;
  localStorage.clear();
  vi.mocked(clearReadAnchor).mockClear();
  vi.mocked(setReadAnchor).mockClear();
});

afterEach(() => {
  cleanup();
  (globalThis as any).fetch = undefined;
  roRegistrations.length = 0;
  rafQueue.length = 0;
  setState("messages", SID, undefined as any);
  setState("messagesDelivered", SID, undefined as any);
  localStorage.clear();
});

// Shared mount: renders ChatView, seeds one partless message, sets initial
// geometry, runs the maybeRestore rAF fallback so ready()=true + following()=true
// + pin()'d at the bottom. Returns handles to the DOM.
async function mountAtBottom() {
  const { container } = render(() => <ChatView sessionId={SID} />);
  seedPartless();
  const scroll = () => container.querySelector(".chat-scroll") as HTMLDivElement;

  await flushMicro();
  expect(scroll()).toBeTruthy();

  // Initial geometry: scrollTop 0 so the post-flush assertion DISTINGUISHES
  // "pin ran" from "pin never ran".
  setGeom(scroll(), { scrollTop: 0, scrollHeight: SH, clientHeight: PORT });

  // maybeRestore rAF fallback -> ready=true, following=true, pin sets scrollTop=SH.
  flushRaf();
  await flushMicro();

  // Precondition: pin ran (scrollTop moved 0 -> SH) and following is on.
  expect(scroll().scrollTop).toBe(SH);
  return { container, scroll };
}

// Arm the 400ms read-cursor debounce: scroll UP (genuine user-scroll-up →
// scheduleReadCursor arms readCursorTimer), then return geometry to near-bottom
// (so flushReadCursor takes the clearReadAnchor path) WITHOUT dispatching
// another scroll (so the timer stays armed, following stays false).
async function mountWithArmedTimer() {
  const { container, scroll } = await mountAtBottom();
  setGeom(scroll(), { scrollTop: UP_TOP });
  scroll().dispatchEvent(new Event("scroll"));
  await flushMicro();
  // following dropped (user scrolled up) → the jump pill is present.
  expect(container.querySelector(".jump")).toBeTruthy();
  // Now set near-bottom geometry for the flush path (no scroll dispatch).
  setGeom(scroll(), { scrollTop: NEAR_BOTTOM });
  return { container, scroll };
}

describe("page-lifecycle read-cursor flush", () => {
  it("pagehide flushes the read cursor SYNCHRONOUSLY and CANCELS the pending 400ms debounce", async () => {
    const { scroll } = await mountWithArmedTimer();

    // Precondition: no flush has happened yet (the debounce is pending).
    expect(clearReadAnchor).not.toHaveBeenCalled();

    // Dispatch pagehide — flushReadCursorOnSuspend must clear the timer + call
    // flushReadCursor synchronously (no debounce). nearBottom geometry → the
    // clearReadAnchor (caught-up) path fires immediately.
    window.dispatchEvent(new Event("pagehide"));
    expect(clearReadAnchor).toHaveBeenCalledTimes(1);
    expect(clearReadAnchor).toHaveBeenCalledWith(SID);

    // The pending 400ms debounce MUST have been cancelled: advancing PAST its
    // fire window does NOT trigger a second flush. (Had clearTimeout not run in
    // flushReadCursorOnSuspend, the armed timer's callback would call
    // flushReadCursor → clearReadAnchor a second time here.)
    await new Promise((r) => setTimeout(r, 450));
    expect(clearReadAnchor).toHaveBeenCalledTimes(1);
  });

  it("freeze flushes the read cursor synchronously (last-reliable pre-suspend signal)", async () => {
    const { scroll } = await mountWithArmedTimer();
    expect(clearReadAnchor).not.toHaveBeenCalled();

    document.dispatchEvent(new Event("freeze"));
    expect(clearReadAnchor).toHaveBeenCalledTimes(1);
    expect(clearReadAnchor).toHaveBeenCalledWith(SID);
    // No second flush after the debounce window (cancelled).
    await new Promise((r) => setTimeout(r, 450));
    expect(clearReadAnchor).toHaveBeenCalledTimes(1);
    void scroll;
  });

  it("visibilitychange→hidden flushes (iOS Safari backstop); →visible does NOT", async () => {
    const { container, scroll } = await mountWithArmedTimer();
    void container;
    void scroll;
    // Default jsdom visibilityState is "visible" → a visibilitychange to
    // visible (no-op here) must NOT flush.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(clearReadAnchor).not.toHaveBeenCalled();

    // Flip to hidden and dispatch → the backstop flushes.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(clearReadAnchor).toHaveBeenCalledTimes(1);
    expect(clearReadAnchor).toHaveBeenCalledWith(SID);
  });

  it("removes the lifecycle listeners on unmount (no flush after cleanup)", async () => {
    const { container } = await mountWithArmedTimer();
    void container;

    // Unmount runs ChatView's onCleanup hooks, which (a) flush once via the
    // existing unmount-flush and (b) remove the pagehide/freeze/visibilitychange
    // listeners. Reset the spy so we only observe post-unmount dispatches.
    cleanup();
    vi.mocked(clearReadAnchor).mockClear();

    // After unmount, dispatching pagehide must NOT flush (listener removed).
    window.dispatchEvent(new Event("pagehide"));
    document.dispatchEvent(new Event("freeze"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(clearReadAnchor).not.toHaveBeenCalled();
  });
});
