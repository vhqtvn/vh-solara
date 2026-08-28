// @vitest-environment jsdom
//
// ChatView scroll-restore read-anchor math under UI zoom (zoom-drift cousin
// of fc2ef59d): two seams in ChatView mix viewport px with zoomed-layout px
// (CSS `zoom` on :root; see lib/zoom).
//
//  1. maybeRestore's anchor branch (~:735): delta = anchorRow.gBCR.top −
//     scrollEl.gBCR.top is viewport px, but `scrollEl.scrollTop +=` is a
//     zoomed-layout-px write — the fix converts once via layoutPx.
//  2. anchorContentOffset (~:526): a gBCR difference (viewport px) was added
//     to scrollTop (layout px); the fix converts the difference so the
//     content RO's anchorDelta correction is layout px.
//
// jsdom has no layout engine and cannot apply CSS zoom. The seam under test is
// the restore/correction arithmetic on stubbed geometry: writable own-property
// scrollTop/scrollHeight/clientHeight on .chat-scroll (pattern of
// ChatViewScrollResize.test.tsx) + per-element gBCR stubs that model the
// browser's zoom scaling (a row whose top edge sits `off − scrollTop` layout
// px inside the container reports z·(off − scrollTop) viewport px).
//
// Hand-derived expectations (ANCHOR_OFF = 400 layout px, viewport origin at
// the container's top, initial scrollTop = 0):
//
//   restore (delta = z·(400 − 0) viewport px):
//     zoom 1.00 → gBCR delta 400 → scrollTop = layoutPx(400)     = 400
//     zoom 1.25 → gBCR delta 500 → scrollTop = layoutPx(500)     = 400  (raw: 500)
//     zoom 0.80 → gBCR delta 320 → scrollTop = layoutPx(320)     = 400  (raw: 320)
//
//   anchor correction (300 layout px grow ABOVE the anchor, scrollTop frozen
//   at 400, so the row reports z·(700 − 400) viewport px below the top):
//     zoom 1.00 → off = 300 + 400 = 700, delta 300 → scrollTop 700  (raw: 700)
//     zoom 1.25 → off = 300 + 400 = 700, delta 300 → scrollTop 700  (raw: 375 + 400 = 775)
//     zoom 0.80 → off = 300 + 400 = 700, delta 300 → scrollTop 700  (raw: 240 + 400 = 640)
import "./_matchMedia";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

// ChatView reads agents()/models() during render (the composer bar). Provide
// minimal fixtures (same shape as ChatViewScrollResize.test.tsx) so the
// component mounts without the real loaders' network calls.
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

// --- Controllable ResizeObserver (ChatViewScrollResize.test.tsx pattern) ----
// Records every (element, callback) pair from .observe(); .trigger(target)
// invokes ONLY the callback registered for `target`, so the test can fire the
// contentEl RO (the anchor-correction branch) in isolation.
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

// --- Controllable requestAnimationFrame -------------------------------------
// The session-switch effect schedules a rAF maybeRestore fallback; replacing
// rAF with a manual queue makes it fire ONLY on an explicit flushRaf(), so the
// test controls exactly when the anchor restore runs — after the geometry and
// gBCR stubs are installed.
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

// --- Geometry model (writable own properties — ScrollResize pattern) --------
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

// Minimal DOMRect-shaped object (only `top` is consumed by the seams here).
function rect(top: number): DOMRect {
  return { top, left: 0, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

// Import ChatView AFTER the mocks are registered.
import ChatView from "../../src/components/ChatView";
import { setState } from "../../src/sync/store";
// lib/scroll's read-anchor cache is a MODULE-level map loaded once at import;
// localStorage.clear() alone does not reset it (ScrollResize's import note).
import { clearReadAnchor, setReadAnchor } from "../../src/lib/scroll";

const SID = "sz1";
const SH = 1000; // initial scrollHeight (layout px)
const PORT = 400; // clientHeight (layout px)
const ANCHOR_OFF = 400; // m2's top edge in content coordinates (layout px)
const GROW = 300; // content added ABOVE the anchor (layout px)

// Per-test gBCR stub state (reset in beforeEach):
let zoom = 1;
let anchorContentOff = ANCHOR_OFF; // m2's content offset (layout px)
let scrollEl: HTMLDivElement | undefined;
let anchorRow: HTMLElement | undefined;

// Model the browser's zoom scaling: a row whose top edge sits
// (anchorContentOff − scrollTop) layout px inside the container reports
// z·(anchorContentOff − scrollTop) viewport px from gBCR.
function installRectStubs(): void {
  scrollEl!.getBoundingClientRect = () => rect(0);
  anchorRow!.getBoundingClientRect = () => rect(zoom * (anchorContentOff - scrollEl!.scrollTop));
}

// Seed 3 partless user rows (m1..m3) WITHOUT flipping messagesDelivered: the
// delivered-flip effect then never re-fires maybeRestore on its own, so the
// rAF fallback (flushRaf) is the sole, controlled positioning trigger.
function seedAnchorSession(): void {
  const byId: Record<string, any> = {};
  for (const id of ["m1", "m2", "m3"]) {
    byId[id] = { id, info: { role: "user", time: { created: 1000 } }, partOrder: [], parts: {} };
  }
  setState("messages", SID, { order: Object.keys(byId), byId });
}

function setUiZoom(v: string) {
  document.documentElement.style.setProperty("--ui-zoom", v);
}

// Mount + restore: renders ChatView, seeds the anchored session, installs the
// geometry/gBCR stubs, then flushRaf()s the session-switch fallback so
// maybeRestore's anchor branch positions m2's top at the viewport top.
// Returns the container + the .chat-content element (contentEl RO target).
async function mountRestored(z: number): Promise<{ container: HTMLElement; contentEl: HTMLDivElement }> {
  zoom = z;
  anchorContentOff = ANCHOR_OFF;
  setUiZoom(String(z));
  setReadAnchor(SID, "m2");
  const { container } = render(() => <ChatView sessionId={SID} />);
  seedAnchorSession();
  await flushMicro();

  scrollEl = container.querySelector(".chat-scroll") as HTMLDivElement;
  expect(scrollEl).toBeTruthy();
  const contentEl = container.querySelector(".chat-content") as HTMLDivElement;
  expect(contentEl).toBeTruthy();
  anchorRow = scrollEl.querySelector('[data-mid="m2"]') as HTMLElement;
  expect(anchorRow).not.toBeNull();

  installRectStubs();
  setGeom(scrollEl, { scrollTop: 0, scrollHeight: SH, clientHeight: PORT });

  flushRaf();
  await flushMicro();
  return { container, contentEl };
}

describe("ChatView read-anchor scroll restore under UI zoom", () => {
  let rafSaved: typeof window.requestAnimationFrame;

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
    rafSaved = window.requestAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    }) as typeof window.requestAnimationFrame;
    localStorage.clear();
    clearReadAnchor(SID);
    zoom = 1;
    anchorContentOff = ANCHOR_OFF;
    scrollEl = undefined;
    anchorRow = undefined;
  });

  afterEach(() => {
    cleanup();
    (globalThis as any).fetch = undefined;
    window.requestAnimationFrame = rafSaved;
    roRegistrations.length = 0;
    rafQueue.length = 0;
    setState("messages", SID, undefined as any);
    clearReadAnchor(SID);
    localStorage.clear();
    document.documentElement.style.removeProperty("--ui-zoom");
  });

  it("zoom 1 is the identity: anchor restore lands m2's top at the viewport top (scrollTop 0 → 400)", async () => {
    const { container } = await mountRestored(1);
    // The anchor branch ran (not the bottom-pin): following dropped → jump pill.
    expect(container.querySelector(".jump")).toBeTruthy();
    expect(scrollEl!.scrollTop).toBe(400);
  });

  it("125%: the gBCR delta (500 viewport px) converts to layout px — scrollTop 400, not the raw 500", async () => {
    await mountRestored(1.25);
    expect(scrollEl!.scrollTop).toBe(400);
  });

  it("80%: the gBCR delta (320 viewport px) converts to layout px — scrollTop 400, not the raw 320", async () => {
    await mountRestored(0.8);
    expect(scrollEl!.scrollTop).toBe(400);
  });

  it("zoom 1 is the identity: a 300px grow above the anchor is fully corrected (scrollTop 400 → 700)", async () => {
    const { contentEl } = await mountRestored(1);
    anchorContentOff = ANCHOR_OFF + GROW; // content prepended above m2
    setGeom(scrollEl!, { scrollHeight: SH + GROW }); // scrollTop stays 400 (frozen)
    ControllableRO.trigger(contentEl);
    await flushMicro();
    expect(scrollEl!.scrollTop).toBe(700);
  });

  it("125%: the anchor correction is measured in layout px — scrollTop 700, not the raw-drifted 775", async () => {
    const { contentEl } = await mountRestored(1.25);
    anchorContentOff = ANCHOR_OFF + GROW;
    setGeom(scrollEl!, { scrollHeight: SH + GROW });
    ControllableRO.trigger(contentEl);
    await flushMicro();
    expect(scrollEl!.scrollTop).toBe(700);
  });

  it("80%: the anchor correction is measured in layout px — scrollTop 700, not the raw-drifted 640", async () => {
    const { contentEl } = await mountRestored(0.8);
    anchorContentOff = ANCHOR_OFF + GROW;
    setGeom(scrollEl!, { scrollHeight: SH + GROW });
    ControllableRO.trigger(contentEl);
    await flushMicro();
    expect(scrollEl!.scrollTop).toBe(700);
  });
});
