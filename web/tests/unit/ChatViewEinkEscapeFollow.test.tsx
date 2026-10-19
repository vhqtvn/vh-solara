// @vitest-environment jsdom
//
// E-ink live-escape follow regression (e2e scroll-follow.spec.ts test 21 —
// "live-escape (Show live) content growth keeps the tail glued").
//
// ROUND 1 (commit 6184f53): the Show-live TAP's pointerdown stamp made the
// swap churn arm the DURABLE inputBackedAway park → settle-glue vetoed
// forever. Fix: the escape binding clears pendingInputAt. Pinned by test 3's
// veto assertion (genuine wheel still parks) + test 1's settle path.
//
// ROUND 2 (the CI failure at :1973, run 39302084770, firefox only): trace
// forensics + a taskset-pinned local repro showed the NEXT layer — with the
// veto no longer armed, the churn frame's following-drop STILL strands the
// reader for the whole turn:
//
//   Mechanism (timeline r4, deterministic under `taskset -c 0,1`):
//     1. Escape tap → chip unmount SHRINKS content (browser clamps scrollTop
//        down) and the first live-flush REGROW (+px) coalesce into ONE
//        rendering update on a contended machine.
//     2. The compound scroll event reports net contentDelta ≈ 0 with
//        scrollTop sitting the clamp below the expected value — an UP
//        residual that NEITHER churn guard in classifyScrollDelta absorbs
//        (viewport-guard needs a viewport delta; the insert-guard is
//        DOWN-only + grow-only) → classified `user-scroll-up` with NO input
//        provenance.
//     3. onScrolled's user-scroll-away branch drops following AND clears
//        contentROArmedLatch — the one dead-end state: the content RO
//        no-ops while !following, so the escaped live stream grows below
//        the fold for the WHOLE turn (~30+ off-tail samples = the CI red)
//        until settle-glue re-engages at turn end.
//
//   Fix under test: the escape binding stamps `einkEscapeAt`, and for
//   EINK_ESCAPE_CHURN_MS (500ms) afterwards onScrolled treats a
//   NO-PROVENANCE scroll-up/down as the swap's own churn — re-engage +
//   re-pin (the onEinkSettleEvent idiom) instead of dropping. Gates keep
//   every genuine-reader protection intact (see test 3).
//
// Fixture pattern follows ChatViewScrollResize.test.tsx (jsdom +
// controllable ResizeObserver / scroll geometry / requestAnimationFrame;
// following() observed via the "↓ Latest" jump pill) and
// ChatViewPartlessMessage.test.tsx (setState message seeding — here WITH a
// streaming text part so Part.tsx's real e-ink hold-back path, EinkWorking
// chip, Show-live button, and settle seam all run for real).

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
// hold-back path once the profile is on). partId is per-test UNIQUE: Part's
// eink live-escape store (einkLiveParts) is module-global and keyed by
// partId — a shared id would leak test 1's escape into the later tests.
const seedStreamingTextPart = (partId: string): void => {
  setState("messages", SID, {
    order: [MID],
    byId: {
      [MID]: {
        id: MID,
        info: { id: MID, sessionID: SID, role: "assistant", time: { created: 1000 } },
        partOrder: [partId],
        parts: {
          [partId]: { id: partId, sessionID: SID, messageID: MID, type: "text", text: "streaming body text" },
        },
      },
    },
  });
  setState("messagesDelivered", SID, true);
};
// Flip the message to settled (authoritative completion) — Part's
// `on(() => props.settled)` effect fires emitEinkSettle → ChatView's
// onEinkSettleEvent (the settle-lifecycle glue).
const settleMessage = (): void => {
  setState("messages", SID, "byId", MID, "info", "time", "completed", 2000);
};

// Tail geometry: pinned at the bottom after maybeRestore (jsdom does not
// clamp, so pin() leaves scrollTop = scrollHeight = SH, the established
// harness quirk), then the swap-churn frame grows content (+200) while the
// browser's anchoring moves the viewport UP by 60px past the clamped
// expectation — residual −60, no viewport delta, and the churn guards in
// classifyScrollDelta are DOWN-only → `user-scroll-up` by construction (the
// exact compound-frame class from the CI trace).
const SH = 1000;
const PORT = 400;
const CHURN_SH = 1200;
const CHURN_TOP = 740; // expected clampTop(SH, CHURN_SH-PORT)=800; residual −60

describe("e-ink live-escape: the swap's churn must keep the tail glued (absorbed at source)", () => {
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

  it("Show-live tap → swap-churn scroll-away is ABSORBED: following never drops, tail re-pinned instantly, settle keeps it glued", async () => {
    const { container } = render(() => <ChatView sessionId={SID} />);
    seedStreamingTextPart("p1");
    const scroll = () => container.querySelector(".chat-scroll") as HTMLDivElement;

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
    //    pendingInputAt), then the click that escapes the part to live. The
    //    escape binding clears the stamp (round 1) and stamps einkEscapeAt
    //    (round 2 — opens the churn-absorption window).
    showLive()!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    showLive()!.click();
    await flushMicro();

    // The escape ran: the chip is gone and the live .md-stream path mounted.
    expect(container.querySelector('[data-eink="working"]')).toBeNull();
    expect(container.querySelector(".md-stream")).toBeTruthy();

    // 2. THE SWAP CHURN (the CI compound frame): content grew (+200) while
    //    the anchored viewport moved UP past the clamped expectation
    //    (residual −60 → the unabsorbed up-residual class). Round 2's
    //    contract: within the escape window with NO input provenance this is
    //    the swap's OWN churn — following must NOT drop (no .jump), and the
    //    tail is re-pinned IMMEDIATELY (the whole-turn stranding below the
    //    fold was the CI red: 30+ consecutive off-tail samples).
    setGeom(scroll(), { scrollTop: CHURN_TOP, scrollHeight: CHURN_SH });
    scroll().dispatchEvent(new Event("scroll"));
    await flushMicro();
    expect(container.querySelector(".jump"), "escape churn dropped following: the compound frame stranded the live stream below the fold for the whole turn (CI :1973)").toBeNull();
    expect(scroll().scrollTop).toBe(CHURN_SH); // instant re-pin at the tail

    // 3. THE SETTLE: the part completes → emitEinkSettle → settle-glue runs
    //    with following already engaged (no-op re-engage) — still glued.
    settleMessage();
    await flushMicro();
    expect(container.querySelector(".jump")).toBeNull();
    expect(scroll().scrollTop).toBe(CHURN_SH);
  });

  it("no escape: the SAME churn frame still drops following (no drive-by behavior change)", async () => {
    const { container } = render(() => <ChatView sessionId={SID} />);
    seedStreamingTextPart("p2");
    const scroll = () => container.querySelector(".chat-scroll") as HTMLDivElement;

    await flushMicro();
    setGeom(scroll(), { scrollTop: 0, scrollHeight: SH, clientHeight: PORT });
    flushRaf();
    await flushMicro();
    expect(scroll().scrollTop).toBe(SH);
    expect(container.querySelector(".jump")).toBeNull();

    // No escape tapped: the chip stays held back and einkEscapeAt stays 0 —
    // the absorption window NEVER opens. The identical up-residual frame
    // must keep its round-0 semantics: a real following drop (transient —
    // no input veto, so the settle can heal it).
    expect(container.querySelector('[data-eink="working"]')).toBeTruthy();
    setGeom(scroll(), { scrollTop: CHURN_TOP, scrollHeight: CHURN_SH });
    scroll().dispatchEvent(new Event("scroll"));
    await flushMicro();
    expect(container.querySelector(".jump"), "no-escape churn must still drop following — the absorption window is escape-scoped only").toBeTruthy();

    // Transient (not input-backed): the settle-glue re-engages.
    settleMessage();
    await flushMicro();
    expect(container.querySelector(".jump")).toBeNull();
    expect(scroll().scrollTop).toBe(CHURN_SH);
  });

  it("genuine wheel within the escape window still drops + parks (the provenance gate keeps real reader intent)", async () => {
    const { container } = render(() => <ChatView sessionId={SID} />);
    seedStreamingTextPart("p3");
    const scroll = () => container.querySelector(".chat-scroll") as HTMLDivElement;
    const chatMain = () => container.querySelector(".chat-main") as HTMLDivElement;

    await flushMicro();
    setGeom(scroll(), { scrollTop: 0, scrollHeight: SH, clientHeight: PORT });
    flushRaf();
    await flushMicro();
    expect(scroll().scrollTop).toBe(SH);
    expect(container.querySelector(".jump")).toBeNull();

    const showLive = () => container.querySelector('[data-eink="show-live"]') as HTMLButtonElement | null;
    expect(showLive()).toBeTruthy();

    // Escape, then a GENUINE wheel over the chat viewport — physical input
    // INSIDE the 500ms absorption window. The provenance gate (fresh
    // pendingInputAt) must keep the REAL drop path: absorption is for
    // no-provenance churn only. A reader who wheels away after tapping Show
    // live still parks (e2e test 22's contract, round 1's protections).
    showLive()!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    showLive()!.click();
    await flushMicro();
    expect(container.querySelector(".md-stream")).toBeTruthy();

    chatMain().dispatchEvent(new Event("wheel", { bubbles: true })); // stamps pendingInputAt (fresh)

    setGeom(scroll(), { scrollTop: CHURN_TOP, scrollHeight: CHURN_SH });
    scroll().dispatchEvent(new Event("scroll"));
    await flushMicro();
    expect(container.querySelector(".jump"), "fresh wheel input within the escape window must still drop following (no yank)").toBeTruthy();

    // And the drop is DURABLE (inputBackedAway armed — Approach A): even the
    // settle-glue must not yank a genuine reader back (round 1's veto,
    // preserved by round 2).
    settleMessage();
    await flushMicro();
    expect(container.querySelector(".jump"), "settle-glue vetoed: the genuine wheel armed the durable input-backed park").toBeTruthy();
  });
});
