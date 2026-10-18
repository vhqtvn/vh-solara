// @vitest-environment jsdom
//
// E-ink live-escape follow regression (e2e scroll-follow.spec.ts test 21 —
// "live-escape (Show live) content growth keeps the tail glued", the CI
// failure after the Playwright 1.64.1 / Firefox 157 bump, reproducing on the
// PW 1.60 / Firefox 150 runner generation too):
//
//   CI evidence (failed-attempt video + failure screenshot): after the REAL
//   click on the Show-live escape, the viewport ends up parked a small gap
//   (~10-15% of the viewport, BELOW the busy→idle recovery's 200px band)
//   off the tail with the "↓ Latest" button present and the paging toolbar
//   reading 3/4 — and it NEVER re-glues: neither the busy→idle geometric
//   recovery (gap < 200 would yank) nor the e-ink settle-lifecycle glue
//   (onEinkSettleEvent) fires. Both are vetoed by `inputBackedAway`, the
//   DURABLE input-provenance veto — so the failure requires that veto to be
//   armed, and the ONLY physical input in the test is the Show-live TAP.
//
//   Mechanism under test (unit-modelled deterministically here):
//     1. A pointerdown lands on .chat-main (the Show-live tap — Playwright's
//        click is mousemove+down+up) → ChatView's Approach-A sensor stamps
//        `pendingInputAt` (ChatView.tsx onPointerDown). A button tap is NOT
//        scroll input, but the stamp cannot tell.
//     2. The escape swaps the held-back EinkWorking chip for the live
//        .md-stream; on a slow machine the swap's layout churn produces a
//        scroll frame whose residual classifies as `user-scroll-up` (the
//        churn guards in lib/scroll.ts are DOWN-only / viewport-bounded —
//        an up-residual is unabsorbed by construction).
//     3. onScrolled's user-scroll-away branch sees "fresh" input (the tap,
//        <300ms) → arms inputBackedAway=true + readingParked=true — a
//        DURABLE park that vetoes every recovery (busy→idle, settle-glue,
//        RO re-pins). The escaped reader strands off-tail.
//
//   The contract this pins: the escape's own churn must stay a TRANSIENT,
//   non-input-backed following drop — exactly the class the settle-lifecycle
//   glue exists to re-glue (e2e test 23's contract). The genuine-reader
//   protection (real wheel → never yanked, e2e test 22) is untouched: wheel
//   listeners still stamp, and only the ESCAPE clears its own tap's stamp.
//
// Fixture pattern follows ChatViewScrollResize.test.tsx (jsdom + controllable
// ResizeObserver / scroll geometry / requestAnimationFrame; following()
// observed via the "↓ Latest" jump pill) and ChatViewPartlessMessage.test.tsx
// (setState message seeding — here WITH a streaming text part so Part.tsx's
// real e-ink hold-back path, EinkWorking chip, Show-live button, and settle
// seam all run for real).

// jsdom lacks window.matchMedia (read at module-load time by layout.ts via
// ChatView's transitive deps). Import the shared stub BEFORE any import that
// triggers layout.ts — see _matchMedia.ts.
import "./_matchMedia";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

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

// --- Controllable ResizeObserver (ChatViewScrollResize.test.tsx idiom) -----
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

// --- Geometry model (jsdom has no layout engine) ---------------------------
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

// Import the components/state AFTER the mocks are registered.
import ChatView from "../../src/components/ChatView";
import { setState } from "../../src/sync/store";
import { setEinkProfile } from "../../src/prefs";
import { clearReadAnchor } from "../../src/lib/scroll";

const SID = "s1";
const MID = "m1";

// One assistant message with a SINGLE streaming text part (no
// info.time.completed → unsettled → newest → Part renders the e-ink
// hold-back path once the profile is on).
const seedStreamingTextPart = (): void => {
  setState("messages", SID, {
    order: [MID],
    byId: {
      [MID]: {
        id: MID,
        info: { id: MID, sessionID: SID, role: "assistant", time: { created: 1000 } },
        partOrder: ["p1"],
        parts: {
          p1: { id: "p1", sessionID: SID, messageID: MID, type: "text", text: "streaming body text" },
        },
      },
    },
  });
  setState("messagesDelivered", SID, true);
};
// Flip the message to settled (authoritative completion) — Part's
// `on(() => props.settled)` effect fires emitEinkSettle → ChatView's
// onEinkSettleEvent (the settle-lifecycle glue under test).
const settleMessage = (): void => {
  setState("messages", SID, "byId", MID, "info", "time", "completed", 2000);
};

// Tail geometry: pinned at the bottom after maybeRestore (jsdom does not
// clamp, so pin() leaves scrollTop = scrollHeight = SH, the established
// harness quirk), then the swap-churn frame grows content (+200) while the
// browser's anchoring moves the viewport UP by 60px past the clamped
// expectation — residual −60, no viewport delta, and the churn guards in
// classifyScrollDelta are DOWN-only → `user-scroll-up` by construction.
const SH = 1000;
const PORT = 400;
const CHURN_SH = 1200;
const CHURN_TOP = 740; // expected clampTop(SH, CHURN_SH-PORT)=800; residual −60

describe("e-ink live-escape: the swap's churn must not arm the durable input-backed park", () => {
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
    // jsdom lacks PointerEvent (ChatViewScrollResize.test.tsx idiom).
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
    // The e-ink profile ON before render: the streaming part holds back and
    // the real EinkWorking chip + Show-live button mount.
    setEinkProfile(true);
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
    setEinkProfile(false);
  });

  it("Show-live tap → swap-churn scroll-away → settle re-glues (the tap is not scroll provenance)", async () => {
    const { container } = render(() => <ChatView sessionId={SID} />);
    seedStreamingTextPart();
    const scroll = () => container.querySelector(".chat-scroll") as HTMLDivElement;
    const chatMain = () => container.querySelector(".chat-main") as HTMLDivElement;

    await flushMicro();
    expect(scroll()).toBeTruthy();

    // Initial geometry NOT at the bottom, then run maybeRestore (rAF
    // fallback) → ready + following + pin (scrollTop → SH).
    setGeom(scroll(), { scrollTop: 0, scrollHeight: SH, clientHeight: PORT });
    flushRaf();
    await flushMicro();
    expect(scroll().scrollTop).toBe(SH);
    expect(container.querySelector(".jump")).toBeNull(); // following engaged

    // The held-back chip + escape affordance are mounted for real.
    const showLive = () => container.querySelector('[data-eink="show-live"]') as HTMLButtonElement | null;
    expect(container.querySelector('[data-eink="working"]')).toBeTruthy();
    expect(showLive()).toBeTruthy();

    // 1. THE TAP: pointerdown over .chat-main (the real sensor stamps
    //    pendingInputAt), then the click that escapes the part to live.
    showLive()!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    showLive()!.click();
    await flushMicro();

    // The escape ran: the chip is gone and the live .md-stream path mounted.
    expect(container.querySelector('[data-eink="working"]')).toBeNull();
    expect(container.querySelector(".md-stream")).toBeTruthy();

    // 2. THE SWAP CHURN: content grew (+200) while the anchored viewport
    //    moved UP past the clamped expectation (residual −60 → the
    //    unabsorbed up-residual class) → onScrolled classifies
    //    user-scroll-away and drops following. This drop itself is EXPECTED
    //    in both worlds (the classifier's guard coverage is not under test
    //    here); the question is whether it is a TRANSIENT drop the settle
    //    can heal, or a DURABLE input-backed park.
    setGeom(scroll(), { scrollTop: CHURN_TOP, scrollHeight: CHURN_SH });
    scroll().dispatchEvent(new Event("scroll"));
    await flushMicro();
    expect(container.querySelector(".jump")).toBeTruthy(); // following dropped
    // The churn left a small (~60px) gap: inside the busy→idle recovery's
    // geometric band, so ONLY the input veto (or its absence) decides.
    expect(CHURN_SH - CHURN_TOP - PORT).toBeLessThan(200);

    // 3. THE SETTLE: the part completes → emitEinkSettle → the settle-
    //    lifecycle glue must re-engage + pin (the tap was not scroll input;
    //    the drop was system churn). With the bug, the tap's stamp armed
    //    inputBackedAway and the glue vetoes forever → .jump stays.
    settleMessage();
    await flushMicro();

    expect(container.querySelector(".jump"), "settle-glue vetoed: the Show-live tap's pointerdown stamp armed the durable input-backed park").toBeNull();
    expect(scroll().scrollTop).toBe(CHURN_SH); // re-pinned at the tail
  });
});
