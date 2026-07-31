// @vitest-environment jsdom
//
// Phase-4 "load-older anchor" characterization for ChatView.tsx (the historical-
// page prepend sub-seam — the cleanest scroll sub-seam after the Composer +
// Navigator extractions). The concern spans these current line ranges in
// ChatView.tsx (1565 LOC):
//
//   • State refs ............. L73-74  (topSentinelEl, loadMoreObserver)
//   • Derived signals ........ L454-456 (win / hasOlder / loadingOlder)
//   • captureAnchorBeforeLoadOlder .. L462-471
//   • onLoadOlder ............ L472-476 (capture -> single-flight -> loadOlder)
//   • Sentinel IO onMount .... L1002-1012 (root: scrollEl, rootMargin "600px 0px 0px 0px")
//     onCleanup .............. L1013-1017 (disconnect + clear refs)
//   • Load-more JSX .......... L1377-1399 (<Show hasOlder && len>0 && !draft>
//                                          button + spinner + .load-more-sentinel)
//
// This concern READS scroll/anchor geometry (capture) but the actual anchor
// RESTORE after a prepend is applied mechanically by the contentEl ResizeObserver's
// read-mode `restoredAnchorId` branch (ChatView.tsx ~L813-828) — it computes the
// anchor's content-offset shift (anchorDelta) and routes it through the pure
// classifyScrollDelta("read") so a viewport that didn't track the anchor through
// the prepend is corrected instead of mistaken for user intent. So "prepend
// preserves anchor" is characterized by observing scrollTop track the anchor by
// exactly the prepend shift — the load-older concern's end-to-end contract.
//
// TESTS-ONLY: no production source is modified. We mount the REAL ChatView and
// drive it through its public surface: the store (messageWindows + messages), the
// sentinel IntersectionObserver, the contentEl ResizeObserver, and the load-more
// button. The only mock is `loadOlder` (sync/history.ts has its own unit + e2e
// coverage for the fetch/merge/gate); here we substitute a faithful signal-drive
// stand-in so the ChatView concern is exercised in isolation.
//
// Pattern follows ChatViewScrollResize.test.tsx (controllable ResizeObserver +
// controllable requestAnimationFrame + synthetic scroll geometry — jsdom has no
// layout engine) and ChatViewDeferredRow.test.tsx / _chatRowHarness (controllable
// IntersectionObserver). jsdom's getBoundingClientRect is spoofed per-element to
// model a prepended message pushing the anchor down in content coordinates.

import "./_matchMedia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { produce } from "solid-js/store";
import { setState, state } from "../../src/sync/store";
import { clearReadAnchor } from "../../src/lib/scroll";

// --- hoisted mock handles ---------------------------------------------------
// `loadOlder` is the single sync surface the load-older concern calls. We keep
// the WHOLE sync module real (ChatView reads ackSession/openSession/state/... from
// the same barrel) and override only loadOlder with a controllable fn whose
// default implementation faithfully drives the `loadingOlder` store signal
// (mirroring sync/history.ts: set true on entry, false on resolve) and optionally
// blocks on a gate so single-flight is exercisable through the public signal.
const H = vi.hoisted(() => ({
  loadOlder: vi.fn(),
  gate: null as null | { promise: Promise<void>; resolve: () => void },
}));

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

vi.mock("../../src/sync", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, loadOlder: H.loadOlder };
});

// Faithful default: drive the loadingOlder signal exactly like history.ts and,
// when H.gate is set, block on it (so a second call observes loadingOlder=true).
function defaultLoadOlderImpl(sid: string): Promise<void> {
  const win = (state as any).messageWindows[sid];
  setState("messageWindows", sid, { ...(win || { hasOlder: true }), loadingOlder: true });
  const gate = H.gate;
  return (gate ? gate.promise : Promise.resolve()).then(() => {
    const post = (state as any).messageWindows[sid];
    if (post) setState("messageWindows", sid, { ...post, loadingOlder: false });
  });
}

// Import ChatView AFTER the mocks are registered.
import ChatView from "../../src/components/ChatView";

// --- controllable IntersectionObserver (sentinel) --------------------------
// Records every constructed observer; fireIntersect(target) invokes the callback
// for the observer watching `target` with an intersecting entry.
interface IORecord {
  cb: IntersectionObserverCallback;
  opts: IntersectionObserverInit;
  root: Element | Document | null;
  target: Element | null;
  disconnected: boolean;
}
const ioRecords: IORecord[] = [];
class ControllableIO {
  cb: IntersectionObserverCallback;
  opts: any;
  root: Element | Document | null;
  target: Element | null = null;
  disconnected = false;
  constructor(cb: IntersectionObserverCallback, opts: any) {
    this.cb = cb;
    this.opts = opts || {};
    this.root = this.opts.root ?? null;
    ioRecords.push(this as unknown as IORecord);
  }
  observe(t: Element) {
    this.target = t;
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  takeRecords() {
    return [];
  }
}
function fireIntersect(target: Element, isIntersecting = true): IORecord {
  const rec = ioRecords.find((r) => r.target === target);
  if (!rec) throw new Error("fireIntersect: no observer recorded for target");
  rec.cb(
    [{ isIntersecting } as unknown as IntersectionObserverEntry],
    { disconnect: () => {} } as unknown as IntersectionObserver,
  );
  return rec;
}

// --- controllable ResizeObserver (contentEl / scrollEl) --------------------
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

// --- controllable requestAnimationFrame ------------------------------------
// The session-restore fallback schedules maybeRestore on rAF; a manual queue lets
// the test control exactly when ready() flips (onScrolled + the RO branches
// early-return while !ready()).
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
const flushMicro = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// --- geometry model (jsdom has no layout engine) ---------------------------
type Geom = { scrollTop?: number; scrollHeight?: number; clientHeight?: number };
function setGeom(el: HTMLElement, g: Geom): void {
  for (const key of Object.keys(g) as (keyof Geom)[]) {
    Object.defineProperty(el, key, { configurable: true, writable: true, value: g[key] });
  }
}
// Spoof a row's viewport-relative top (jsdom getBoundingClientRect is all zeros).
// `top` is the element's top edge relative to the scroll container's top edge.
function setRectTop(el: HTMLElement, top: number): void {
  el.getBoundingClientRect = () =>
    ({ top, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 } as DOMRect);
}

// --- constants -------------------------------------------------------------
const SID = "s1";
const SH = 1000; // scrollHeight (tall content)
const PORT = 400; // clientHeight (modest viewport)
const READ_TOP = 200; // scrollTop after scroll-up (mid-history read position)
const PREPEND_PX = 300; // height of the prepended older page
// After restore the anchor must have tracked the prepend: READ_TOP + PREPEND_PX.
const EXPECTED_RESTORED_TOP = READ_TOP + PREPEND_PX;

// Minimal partless assistant row (cheap; mounts a [data-mid] shell with no parts).
function seedSingleMessage(): void {
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
}

/** Mark the session as having older history (renders the affordance + sentinel). */
function setHasOlder(v: boolean): void {
  const win = (state as any).messageWindows[SID];
  setState("messageWindows", SID, { ...(win || {}), hasOlder: v, oldestResidentID: "m1" });
}

/** Mount ChatView, seed one message + hasOlder, flush onMount, then settle ready
 *  (maybeRestore bottom-pin) so onScrolled/RO branches are live. Returns DOM
 *  handles. The view starts in TAIL mode (following=true). */
async function mountWithOlder() {
  const utils = render(() => <ChatView sessionId={SID} />);
  seedSingleMessage();
  setHasOlder(true);
  await flushMicro();
  const scroll = () => utils.container.querySelector(".chat-scroll") as HTMLDivElement;
  const content = () => utils.container.querySelector(".chat-content") as HTMLDivElement;
  setGeom(scroll(), { scrollTop: 0, scrollHeight: SH, clientHeight: PORT });
  // maybeRestore rAF fallback -> ready=true, following=true, pin() at scrollTop=SH.
  flushRaf();
  await flushMicro();
  return { ...utils, scroll, content };
}

/** From the tail-pinned mount, scroll UP into mid-history to drop following() and
 *  establish the read-mode anchor baseline (pinnedGeom = READ_TOP geometry). */
async function scrollUpForRead(container: HTMLElement, scroll: () => HTMLDivElement) {
  setGeom(scroll(), { scrollTop: READ_TOP });
  scroll().dispatchEvent(new Event("scroll"));
  await flushMicro();
  // Precondition: following dropped (the "↓ Latest" jump pill is the DOM proxy).
  expect(container.querySelector(".jump")).toBeTruthy();
}

// The older page prepended by the mocked loadOlder (a partless user row above m1).
function prependOlderPage(): void {
  setState(
    "messages",
    SID,
    produce((sm: any) => {
      sm.order.unshift("m0");
      sm.byId["m0"] = {
        id: "m0",
        info: { role: "user", time: { created: 500 } },
        partOrder: [],
        parts: {},
      };
    }),
  );
}

let rafSaved: typeof window.requestAnimationFrame;

beforeEach(() => {
  (globalThis as any).fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "",
  })) as any;
  (globalThis as any).IntersectionObserver = ControllableIO;
  (globalThis as any).ResizeObserver = ControllableRO;
  (globalThis as any).PointerEvent = class extends MouseEvent {
    pointerId = 0;
    pointerType = "";
  };
  rafSaved = window.requestAnimationFrame;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  }) as typeof window.requestAnimationFrame;
  ioRecords.length = 0;
  roRegistrations.length = 0;
  rafQueue.length = 0;
  H.gate = null;
  H.loadOlder.mockReset();
  H.loadOlder.mockImplementation(defaultLoadOlderImpl);
  localStorage.clear();
  clearReadAnchor(SID);
});

afterEach(() => {
  cleanup();
  (globalThis as any).fetch = undefined;
  window.requestAnimationFrame = rafSaved;
  setState("messages", SID, undefined as any);
  setState("messagesDelivered", SID, undefined as any);
  setState("messagesError", SID, undefined as any);
  setState("messageWindows", SID, undefined as any);
  clearReadAnchor(SID);
  localStorage.clear();
});

describe("Phase-4 load-older — affordance visibility contract", () => {
  it("renders the Load-older affordance (button + sentinel) iff hasOlder && messages().length>0 && !draft", async () => {
    const { container } = await mountWithOlder();

    // hasOlder=true + one resident message + non-draft -> affordance present.
    expect(container.querySelector(".load-more-top")).toBeTruthy();
    expect(container.querySelector(".load-more-btn")).toBeTruthy();
    expect(container.querySelector(".load-more-sentinel")).toBeTruthy();
    expect(
      (container.querySelector(".load-more-btn") as HTMLButtonElement).textContent,
    ).toContain("Load older");

    // Toggle hasOlder off -> affordance disappears entirely.
    setHasOlder(false);
    await flushMicro();
    expect(container.querySelector(".load-more-top")).toBeNull();
    expect(container.querySelector(".load-more-sentinel")).toBeNull();

    // MUTATION OBSERVED: if an extraction re-keyed the <Show> on a different
    // signal (e.g. only messages().length), toggling hasOlder would NOT hide it.
    setHasOlder(true);
    await flushMicro();
    expect(container.querySelector(".load-more-top")).toBeTruthy();
  });
});

describe("Phase-4 load-older — sentinel IntersectionObserver contract + triggers", () => {
  it("the sentinel observer is rooted at .chat-scroll with rootMargin '600px 0px 0px 0px'", async () => {
    const { container, scroll } = await mountWithOlder();

    const sentinel = container.querySelector(".load-more-sentinel") as HTMLElement;
    expect(sentinel).toBeTruthy();
    const obs = ioRecords.find((r) => r.target === sentinel);
    expect(obs).toBeTruthy();
    // MUTATION OBSERVED (root): if an extraction dropped the root: scrollEl opt,
    // the observer would fall back to the viewport (null) instead of the scroll
    // container -> obs.root would be null, not scrollEl.
    expect(obs!.root).toBe(scroll());
    // MUTATION OBSERVED (rootMargin): the 600px top rootMargin is what lets the
    // load fire BEFORE the sentinel reaches the very top (prefetch band). A
    // regression to rootMargin "" would change this exact string.
    expect(String(obs!.opts.rootMargin || "")).toBe("600px 0px 0px 0px");
  });

  it("firing the sentinel intersection calls loadOlder exactly once (IO is a load trigger)", async () => {
    const { container } = await mountWithOlder();

    const sentinel = container.querySelector(".load-more-sentinel") as HTMLElement;
    fireIntersect(sentinel, true);
    await flushMicro();

    // MUTATION OBSERVED: if the onMount IO callback stopped forwarding to
    // onLoadOlder (or gated on the wrong signal), loadOlder would not be called.
    expect(H.loadOlder).toHaveBeenCalledTimes(1);
    expect(H.loadOlder).toHaveBeenCalledWith(SID);
  });

  it("clicking the Load-older button calls loadOlder exactly once (manual fallback trigger)", async () => {
    const { container } = await mountWithOlder();

    (container.querySelector(".load-more-btn") as HTMLButtonElement).click();
    await flushMicro();

    // MUTATION OBSERVED: if the button's onClick stopped calling onLoadOlder
    // (e.g. extraction rewired it to the IO only), the manual/touch fallback path
    // would be dead.
    expect(H.loadOlder).toHaveBeenCalledTimes(1);
    expect(H.loadOlder).toHaveBeenCalledWith(SID);
  });
});

describe("Phase-4 load-older — single-flight guard", () => {
  it("a second trigger while a load is in flight is rejected (no double-fetch)", async () => {
    const { container } = await mountWithOlder();

    // Hold the in-flight load open so loadingOlder() stays true between fires.
    let releaseGate!: () => void;
    H.gate = {
      promise: new Promise<void>((r) => {
        releaseGate = r;
      }),
      resolve: () => releaseGate(),
    };

    const sentinel = container.querySelector(".load-more-sentinel") as HTMLElement;
    // 1st intersection: loadingOlder false -> onLoadOlder -> loadOlder (in flight).
    fireIntersect(sentinel, true);
    await flushMicro();
    expect(H.loadOlder).toHaveBeenCalledTimes(1);
    // The loadingOlder signal is now true (faithful mock drove it) -> the button
    // reflects the in-flight state.
    expect(
      (container.querySelector(".load-more-btn") as HTMLButtonElement).disabled,
    ).toBe(true);

    // 2nd intersection while still in flight: the IO callback + onLoadOlder both
    // guard on loadingOlder() -> loadOlder must NOT be called a second time.
    fireIntersect(sentinel, true);
    await flushMicro();
    // MUTATION OBSERVED (defense-in-depth): single-flight is enforced by TWO
    // layered guards — the IO-callback guard (ChatView.tsx L1006) AND the
    // onLoadOlder guard (L473). Verified by mutation: removing EITHER guard alone
    // still passes (the other catches the duplicate); this assertion fails (count
    // becomes 2) only when BOTH are removed. So this test pins the OBSERVABLE
    // no-double-fetch invariant, not any single guard. The third layer is the
    // button's `disabled={loadingOlder()}` (jsdom does not dispatch click on a
    // disabled button), making the onLoadOlder guard unreachable in isolation
    // through the public surface — see "Honest gaps" in the closeout.
    expect(H.loadOlder).toHaveBeenCalledTimes(1);

    // Resolve the in-flight load; a subsequent intersection now loads again.
    releaseGate();
    await flushMicro();
    expect(
      (container.querySelector(".load-more-btn") as HTMLButtonElement).disabled,
    ).toBe(false);
    fireIntersect(sentinel, true);
    await flushMicro();
    expect(H.loadOlder).toHaveBeenCalledTimes(2);
  });

  it("while in flight the button is disabled + shows the spinner + 'Loading…'; on resolve it recovers", async () => {
    const { container } = await mountWithOlder();

    let releaseGate!: () => void;
    H.gate = {
      promise: new Promise<void>((r) => {
        releaseGate = r;
      }),
      resolve: () => releaseGate(),
    };

    (container.querySelector(".load-more-btn") as HTMLButtonElement).click();
    await flushMicro();

    // In-flight UI contract.
    const btn = container.querySelector(".load-more-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Loading…");
    expect(container.querySelector(".load-more-spinner")).toBeTruthy();

    releaseGate();
    await flushMicro();

    // Resolved UI contract.
    const btnAfter = container.querySelector(".load-more-btn") as HTMLButtonElement;
    expect(btnAfter.disabled).toBe(false);
    expect(btnAfter.textContent).toContain("Load older");
    // MUTATION OBSERVED: if loadingOlder were never cleared on resolve (the
    // finally in history.ts), the spinner would persist here.
    expect(container.querySelector(".load-more-spinner")).toBeNull();
  });
});

describe("Phase-4 load-older — anchor capture + preservation through prepend (read mode)", () => {
  it("capture + prepend + ResizeObserver restore keeps the anchor at its viewport position (scrollTop tracks the prepend)", async () => {
    // READ MODE: following()=false so captureAnchorBeforeLoadOlder records the
    // current anchor (its content offset) BEFORE the fetch.
    const { container, scroll, content } = await mountWithOlder();
    await scrollUpForRead(container, scroll);

    // Override the mock so loadOlder ALSO prepends an older page (m0) in place
    // (produce keeps m1's object reference -> <For> preserves m1's DOM element).
    H.loadOlder.mockImplementation(async (sid: string) => {
      const win = (state as any).messageWindows[sid];
      setState("messageWindows", sid, { ...win, loadingOlder: true });
      prependOlderPage();
      await Promise.resolve();
      const post = (state as any).messageWindows[sid];
      if (post) setState("messageWindows", sid, { ...post, loadingOlder: false });
    });

    // Trigger load-older. captureAnchorBeforeLoadOlder runs SYNCHRONOUSLY first,
    // reading m1's CURRENT geometry (rect top 0, scrollTop READ_TOP) -> records
    // restoredAnchorId="m1", restoredAnchorOffset = 0 - 0 + READ_TOP = READ_TOP.
    (container.querySelector(".load-more-btn") as HTMLButtonElement).click();
    await flushMicro();
    expect(H.loadOlder).toHaveBeenCalledTimes(1);
    // Two resident messages now (m0 prepended above m1).
    expect((state as any).messages[SID].order).toEqual(["m0", "m1"]);

    // Model the prepend's geometry effect: content grew above the anchor by
    // PREPEND_PX, so scrollHeight grows and m1 is pushed down in content coords.
    // The browser keeps the numeric scrollTop fixed through the content mutation.
    setGeom(scroll(), { scrollTop: READ_TOP, scrollHeight: SH + PREPEND_PX, clientHeight: PORT });
    const m1 = scroll().querySelector('[data-mid="m1"]') as HTMLElement;
    // m1's viewport-relative top is now PREPEND_PX (it was pushed down by the
    // prepended content while scrollTop stayed at READ_TOP).
    setRectTop(m1, PREPEND_PX);

    // Fire the contentEl ResizeObserver -> the read-mode `restoredAnchorId`
    // branch measures the anchor's content-offset shift (anchorDelta=PREPEND_PX)
    // and routes it through classifyScrollDelta("read"), which corrects scrollTop
    // to track the anchor.
    ControllableRO.trigger(content());
    await flushMicro();

    // OUTCOME OBSERVED: scrollTop advanced by exactly the prepend shift, keeping
    // m1 pinned at the top of the viewport (the reader does not jump).
    //   anchorContentOffset(m1) after = PREPEND_PX - 0 + READ_TOP = READ_TOP + PREPEND_PX
    //   anchorDelta = (READ_TOP + PREPEND_PX) - READ_TOP = PREPEND_PX
    //   newScrollTop = clampTop(READ_TOP + PREPEND_PX, maxBottom) = EXPECTED_RESTORED_TOP
    expect(scroll().scrollTop).toBe(EXPECTED_RESTORED_TOP);

    // MUTATION OBSERVED: removing captureAnchorBeforeLoadOlder (or the restore
    // branch) leaves restoredAnchorId undefined in read mode -> the restore
    // branch is skipped -> scrollTop stays at READ_TOP (200), NOT the tracked
    // EXPECTED_RESTORED_TOP (500). This assertion is what fails.
    expect(scroll().scrollTop).not.toBe(READ_TOP);
  });
});
