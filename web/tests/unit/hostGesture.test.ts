// @vitest-environment jsdom
//
// Host gesture recognizer (web/src/hostGesture.ts).
//
// Pins the desktop triple COMPLETED bare-Ctrl + mobile 3-finger-tap
// (lift-distance-gated) recognizers, the embed gate, the inbound source-guard,
// the captured-origin outbound targeting (never '*'), the closed outbound
// payload (exactly {type:"host-gesture", gesture:"layout-overlay-request"},
// no extra fields), and the keyboard-focus-mode suppression (driven by the
// host's {type:'host-mode'} message). Uses fake timers (the recognizer keys
// its windows on Date.now()).
//
// Desktop contract (release-qualified triple): a TAP is one full Control
// down→up cycle with no other key and no other live modifier involved; the
// recognizer fires ONLY on the THIRD qualifying keyup. Any other keydown —
// Shift/Alt/Meta INCLUDED (an intentional tightening over the old recognizer,
// which was inert toward them) — resets the chain AND abandons a pending
// press (its later keyup is an orphan and counts nothing). The 450ms window
// is the max gap from one qualifying RELEASE to the next Control keydown (per
// gap, not a whole-triple deadline). NO hold-duration cap: a long isolated
// hold still counts as one completed press (pinned below deliberately).
//
// The 3-finger-tap recognizer fires on ALL-LIFTED with per-finger movement
// gating: 3 simultaneous touch pointers down → all 3 up, each within
// THREE_FINGER_TAP_MAX_MOVEMENT_PX of its landing position, within
// THREE_FINGER_TAP_WINDOW_MS of the first down. A swipe (any finger beyond
// tolerance) must NOT fire; <3 or >3 simultaneous pointers must NOT fire.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startHostGesture } from "../../src/hostGesture";

const HOST_ORIGIN = "https://host.example";

interface Posted {
  msg: { type?: string; gesture?: string } & Record<string, unknown>;
  origin: string;
}

function makeFakeParent(): { parent: Window; posted: Posted[] } {
  const posted: Posted[] = [];
  const parent = {
    postMessage: (msg: unknown, origin: string) => {
      posted.push({ msg: msg as Posted["msg"], origin });
    },
  } as unknown as Window;
  return { parent, posted };
}

/** Dispatch the host→SPA handshake (or a host-mode signal) on window with a
 *  programmatically-set `source` (jsdom does not preserve it across the
 *  MessageEvent constructor; see heartbeatRouteEmit.test.ts). */
function sendFromParent(
  source: Window,
  data: Record<string, unknown>,
  origin = HOST_ORIGIN,
): void {
  const ev = new MessageEvent("message", { data, origin });
  Object.defineProperty(ev, "source", { value: source, writable: false, configurable: true });
  window.dispatchEvent(ev);
}

/** Send a keydown/keyup with the given props (jsdom's KeyboardEvent does not
 *  expose repeat/isComposing/keyCode via the constructor for all keys, so set
 *  them; shift/alt/metaKey ARE constructor-settable modifier flags). */
function sendKey(props: {
  key: string;
  type?: "keydown" | "keyup";
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}): void {
  const ev = new KeyboardEvent(props.type ?? "keydown", {
    key: props.key,
    bubbles: true,
    cancelable: true,
    shiftKey: props.shiftKey ?? false,
    altKey: props.altKey ?? false,
    metaKey: props.metaKey ?? false,
  });
  if (props.repeat !== undefined) {
    Object.defineProperty(ev, "repeat", { value: props.repeat, configurable: true });
  }
  if (props.isComposing !== undefined) {
    Object.defineProperty(ev, "isComposing", { value: props.isComposing, configurable: true });
  }
  if (props.keyCode !== undefined) {
    Object.defineProperty(ev, "keyCode", { value: props.keyCode, configurable: true });
  }
  window.dispatchEvent(ev);
}

/** One COMPLETED bare-Ctrl tap: a full Control down→up cycle, dispatched at
 *  the same fake-time instant (release→next-keydown gap 0ms — well inside the
 *  450ms per-gap window). */
function ctrlTap(): void {
  sendKey({ key: "Control" });
  sendKey({ key: "Control", type: "keyup" });
}

/** A full recognized desktop gesture: three completed bare-Ctrl taps. */
function ctrlTriple(): void {
  ctrlTap();
  ctrlTap();
  ctrlTap();
}

interface TapOpts {
  x?: number;
  y?: number;
  isPrimary?: boolean;
  target?: Element;
  pointerType?: string;
  pointerId?: number;
}

/** Send a pointerdown on `target` (bubbles to window). jsdom's PointerEvent may
 *  not exist or may not accept isPrimary/pointerType/pointerId via the
 *  constructor, so define them on the instance. Returns a preventDefault spy. */
function sendTap(opts: TapOpts = {}): { preventDefault: ReturnType<typeof vi.fn> } {
  const target = opts.target ?? document.body;
  const preventDefault = vi.fn();
  const ctor: typeof PointerEvent =
    typeof PointerEvent !== "undefined" ? PointerEvent : (MouseEvent as unknown as typeof PointerEvent);
  const ev = new ctor("pointerdown", {
    clientX: opts.x ?? 0,
    clientY: opts.y ?? 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(ev, "isPrimary", {
    value: opts.isPrimary ?? true,
    configurable: true,
  });
  if (opts.pointerType !== undefined) {
    Object.defineProperty(ev, "pointerType", { value: opts.pointerType, configurable: true });
  }
  // Distinct pointerId per contact is required for the 3-finger recognizer's
  // active-pointer Map (jsdom defaults pointerId to 0, collapsing all fingers).
  Object.defineProperty(ev, "pointerId", { value: opts.pointerId ?? 1, configurable: true });
  Object.defineProperty(ev, "target", { value: target, configurable: true });
  ev.preventDefault = preventDefault;
  target.dispatchEvent(ev);
  return { preventDefault };
}

interface FingerSpec {
  id: number;
  isPrimary?: boolean;
  /** landing position (defaults spread three fingers across ~80px). */
  x?: number;
  y?: number;
  /** lift position (defaults: the landing position + a realistic <=3px drift). */
  ux?: number;
  uy?: number;
}

function fingerDown(spec: FingerSpec, target: Element = document.body): ReturnType<typeof vi.fn> {
  return sendTap({
    x: spec.x ?? 0,
    y: spec.y ?? 0,
    isPrimary: spec.isPrimary ?? spec.id === 10,
    pointerType: "touch",
    pointerId: spec.id,
    target,
  }).preventDefault;
}

/** Send a pointerup for `pointerId` at (x,y) (bubbles to window — real browser
 *  pointerups bubble; the recognizer's lift handler measures the finger's
 *  down→up distance from the tracked landing position). */
function fingerUp(
  spec: { id: number; x?: number; y?: number },
  type: "pointerup" | "pointercancel" = "pointerup",
  target: Element = document.body,
): void {
  const ctor: typeof PointerEvent =
    typeof PointerEvent !== "undefined" ? PointerEvent : (MouseEvent as unknown as typeof PointerEvent);
  const ev = new ctor(type, {
    clientX: spec.x ?? 0,
    clientY: spec.y ?? 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(ev, "pointerId", { value: spec.id, configurable: true });
  Object.defineProperty(ev, "pointerType", { value: "touch", configurable: true });
  target.dispatchEvent(ev);
}

/** Default 3-finger-tap: fingers 10/11/12 land spread ~80px apart (inter-finger
 *  spread is FINE — tolerance is per-finger down→up drift, not inter-finger
 *  distance), each lifts within 3px of its own landing position. Returns the
 *  preventDefault spies of the three pointerdowns. */
const FINGERS: FingerSpec[] = [
  { id: 10, isPrimary: true, x: 0, y: 0, ux: 1, uy: 1 },
  { id: 11, isPrimary: false, x: 40, y: 5, ux: 41, uy: 3 },
  { id: 12, isPrimary: false, x: 80, y: 0, ux: 79, uy: 2 },
];

function threeFingerDowns(specs: FingerSpec[] = FINGERS): ReturnType<typeof vi.fn>[] {
  return specs.map((s) => fingerDown(s));
}
function threeFingerUps(specs: FingerSpec[] = FINGERS): void {
  for (const s of specs) fingerUp({ id: s.id, x: s.ux ?? s.x ?? 0, y: s.uy ?? s.y ?? 0 });
}

/** Overlay-request message count captured to the parent. Filters to the
 *  `layout-overlay-request` gesture value so the activate-forward messages
 *  (which also fire on pointerdown/focus) do not inflate the overlay counts. */
function overlayCount(posted: Posted[]): number {
  return posted.filter(
    (p) => p.msg.type === "host-gesture" && p.msg.gesture === "layout-overlay-request",
  ).length;
}
/** Activate message count captured to the parent (the pane-activate forward). */
function activateCount(posted: Posted[]): number {
  return posted.filter(
    (p) => p.msg.type === "host-gesture" && p.msg.gesture === "pane-activate",
  ).length;
}

// ---------------------------------------------------------------------------
// DESKTOP: triple COMPLETED bare-Ctrl (fires on the THIRD qualifying release)
// ---------------------------------------------------------------------------

describe("host gesture — desktop triple bare-Ctrl", () => {
  let parent: Window;
  let posted: Posted[];
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    const fake = makeFakeParent();
    parent = fake.parent;
    posted = fake.posted;
    Object.defineProperty(window, "parent", { configurable: true, get: () => parent });
    dispose = startHostGesture();
    expect(dispose, "embedded → disposer returned").toBeDefined();
    // Establish the host origin so recognitions can post.
    sendFromParent(parent, { type: "vh-host-handshake", nonce: "n" });
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    Object.defineProperty(window, "parent", { configurable: true, value: window });
  });

  it("three completed bare-Ctrl presses → posts one overlay-request", () => {
    ctrlTriple();
    expect(overlayCount(posted), "recognized → exactly one post").toBe(1);
    const msg = posted[0].msg;
    expect(msg.type, "closed type").toBe("host-gesture");
    expect(msg.gesture, "closed gesture value").toBe("layout-overlay-request");
  });

  it("two completed presses → NO activation (the reported abandon-repress accident)", () => {
    ctrlTap();
    ctrlTap();
    expect(overlayCount(posted), "exactly two presses can never fire").toBe(0);
  });

  it("the third keydown ALONE does not fire; the third qualifying RELEASE fires once", () => {
    ctrlTap();
    ctrlTap();
    sendKey({ key: "Control" });
    expect(overlayCount(posted), "third keydown alone → no fire (release-qualified)").toBe(0);
    sendKey({ key: "Control", type: "keyup" });
    expect(overlayCount(posted), "third release → exactly one post").toBe(1);
  });

  it("targets the captured host origin (never '*')", () => {
    ctrlTriple();
    expect(posted[0].origin, "origin-bound to handshake origin").toBe(HOST_ORIGIN);
  });

  it("posts a CLOSED payload — no extra fields leak", () => {
    ctrlTriple();
    expect(posted.length).toBe(1);
    expect(Object.keys(posted[0].msg).sort(), "exactly {type, gesture}").toEqual([
      "gesture",
      "type",
    ]);
  });

  it("a fresh sequence is required for a second activation (a 4th press starts over)", () => {
    ctrlTriple();
    expect(overlayCount(posted), "first triple recognized").toBe(1);
    ctrlTap(); // press #4 — a fresh sequence's tap 1, NOT an instant re-fire
    expect(overlayCount(posted), "4th press alone does not re-fire").toBe(1);
    ctrlTap();
    ctrlTap();
    expect(overlayCount(posted), "fresh triple recognized again").toBe(2);
  });

  it("gap window: release→next-keydown gap of exactly 450ms chains; 451ms starts a fresh sequence", () => {
    ctrlTap(); // release at t=0
    vi.advanceTimersByTime(450);
    ctrlTap(); // keydown at t=450 → gap 450 <= 450 → chains (tap 2)
    vi.advanceTimersByTime(451);
    ctrlTap(); // gap 451 > 450 → EXPIRED → this is fresh tap 1
    expect(overlayCount(posted), "expired chain: only 1 completed fresh tap").toBe(0);
    ctrlTap();
    ctrlTap(); // fresh taps 2 + 3
    expect(overlayCount(posted), "fresh sequence completes after expiry").toBe(1);
  });

  it("auto-repeated Control neither advances nor resets (held Ctrl repeats are ignored)", () => {
    ctrlTap();
    ctrlTap();
    // An auto-repeat keydown between completed taps: ignored entirely.
    sendKey({ key: "Control", repeat: true });
    expect(overlayCount(posted), "repeat does not count as the 3rd press").toBe(0);
    ctrlTap();
    expect(overlayCount(posted), "real third press still completes").toBe(1);

    // Auto-repeat DURING a held press: the press stays tracked and completes.
    sendKey({ key: "Control" });
    sendKey({ key: "Control", repeat: true }); // repeat while held — no corruption
    sendKey({ key: "Control", type: "keyup" }); // fresh-sequence tap 1
    ctrlTap();
    ctrlTap();
    expect(overlayCount(posted), "held press with repeats completed normally").toBe(2);
  });

  it("an intervening NON-modifier key resets the chain AND abandons a pending press (Ctrl+C never triggers)", () => {
    ctrlTap(); // tap 1
    sendKey({ key: "Control" }); // press 2 down
    sendKey({ key: "c" }); // Ctrl+C chord: letter resets + abandons the pending press
    sendKey({ key: "Control", type: "keyup" }); // must be an ORPHAN — counts nothing
    ctrlTap(); // fresh tap 1
    ctrlTap(); // fresh tap 2
    // Correct: only 2 completed taps since the reset → no fire. A buggy impl
    // that counted the chord's Ctrl release as a completed tap would fire here.
    expect(overlayCount(posted), "chord release orphaned → only 2 fresh taps → no fire").toBe(0);
  });

  it("a third press completed by a CHORD is invalidated (letter down before Ctrl up)", () => {
    ctrlTap();
    ctrlTap(); // taps 1, 2
    sendKey({ key: "Control" }); // 3rd press down
    sendKey({ key: "s" }); // chord letter lands BEFORE the Ctrl release → reset
    sendKey({ key: "Control", type: "keyup" }); // orphan — not a third qualifying release
    expect(overlayCount(posted), "chord-completed press invalidated → no activation").toBe(0);
  });

  it.each(["Shift", "Alt", "Meta"] as const)(
    "an intervening %s keydown RESETS the chain (deliberate tightening: the old recognizer was inert)",
    (mod) => {
      ctrlTap();
      ctrlTap();
      sendKey({ key: mod });
      ctrlTap(); // fresh tap 1 (if %s were inert this would be tap 3 → fire)
      expect(overlayCount(posted), `${mod} between presses resets → no fire`).toBe(0);
    },
  );

  it("a modifier pressed DURING a pending press resets the chain (the chorded release is an orphan)", () => {
    ctrlTap();
    ctrlTap();
    sendKey({ key: "Control" }); // 3rd press down (tracked)
    sendKey({ key: "Shift" }); // modifier during the press → reset + abandon
    sendKey({ key: "Control", type: "keyup" }); // orphan — must NOT count as tap 3
    expect(overlayCount(posted), "modifier-during-press invalidated").toBe(0);
    ctrlTap();
    ctrlTap();
    expect(overlayCount(posted), "two more taps = only fresh taps 1+2 → still no fire").toBe(0);
    ctrlTap();
    expect(overlayCount(posted), "a full fresh triple fires").toBe(1);
  });

  it("held modifier flags on the Ctrl KEYDOWN itself are rejected (Ctrl+Shift pressed as one chord)", () => {
    ctrlTap();
    ctrlTap();
    sendKey({ key: "Control", shiftKey: true }); // not a BARE press → reset
    sendKey({ key: "Control", type: "keyup", shiftKey: true }); // orphan either way
    expect(overlayCount(posted), "chord-flagged keydown rejected").toBe(0);
    ctrlTap();
    expect(overlayCount(posted), "chain was reset → this is only fresh tap 2").toBe(0);
  });

  it("modifier flags on the Ctrl KEYUP disqualify the release (press not isolated at lift)", () => {
    ctrlTap();
    ctrlTap();
    sendKey({ key: "Control" }); // clean keydown (tracked)
    sendKey({ key: "Control", type: "keyup", altKey: true }); // Alt still held → disqualify
    expect(overlayCount(posted), "modifier-flagged release does not complete tap 3").toBe(0);
    ctrlTriple(); // recognizer not wedged — a full fresh triple fires
    expect(overlayCount(posted), "fresh triple after disqualification").toBe(1);
  });

  it("overlapping Ctrl (second down before the first up) is rejected", () => {
    ctrlTap();
    ctrlTap();
    sendKey({ key: "Control" }); // down #3a (tracked)
    sendKey({ key: "Control" }); // down #3b while #3a held → overlap → reset + abandon
    sendKey({ key: "Control", type: "keyup" }); // orphan
    sendKey({ key: "Control", type: "keyup" }); // orphan
    expect(overlayCount(posted), "overlapping Ctrl never completes isolated taps").toBe(0);
  });

  it("an orphan keyup (up without a tracked down) is ignored — neither counts nor resets", () => {
    ctrlTap();
    ctrlTap();
    sendKey({ key: "Control", type: "keyup" }); // orphan release
    expect(overlayCount(posted), "orphan keyup does not count as the 3rd tap").toBe(0);
    ctrlTap(); // if the orphan had RESET the chain this could not fire
    expect(overlayCount(posted), "orphan did not reset — third real tap fires").toBe(1);
  });

  it("IME composition active resets the chain", () => {
    ctrlTap();
    ctrlTap();
    sendKey({ key: "a", isComposing: true });
    ctrlTap();
    expect(overlayCount(posted), "composition reset → no recognition").toBe(0);
  });

  it("the legacy keyCode 229 composition sentinel resets the chain", () => {
    ctrlTap();
    ctrlTap();
    sendKey({ key: "x", keyCode: 229 });
    ctrlTap();
    expect(overlayCount(posted), "keyCode 229 reset → no recognition").toBe(0);
  });

  it("window blur resets the chain (an abandoned mid-sequence chain cannot complete later)", () => {
    ctrlTap();
    ctrlTap();
    window.dispatchEvent(new Event("blur"));
    ctrlTap(); // fresh tap 1 — the pre-blur taps are gone
    expect(overlayCount(posted), "blur reset → no recognition").toBe(0);
    ctrlTap();
    ctrlTap();
    expect(overlayCount(posted), "a full fresh triple after blur fires").toBe(1);
  });

  it("a LONG isolated hold still counts as one completed press (NO duration cap — pinned residual risk)", () => {
    // The contract deliberately has no hold-duration threshold. A 5s held Ctrl
    // that lifts cleanly is a completed tap; future tuning must be deliberate
    // (changing this test), not accidental.
    sendKey({ key: "Control" });
    vi.advanceTimersByTime(5000);
    sendKey({ key: "Control", type: "keyup" }); // tap 1 despite the hold
    ctrlTap();
    ctrlTap();
    expect(overlayCount(posted), "long hold counts → triple completes").toBe(1);
  });

  it("works while an editable element is focused (no host-focus suppression)", () => {
    // The desktop gesture is NOT suppressed by editable focus (a physical
    // keyboard is attached). A triple-Ctrl while typing still opens the overlay.
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    ctrlTriple();
    expect(overlayCount(posted), "editable focus does not suppress triple-Ctrl").toBe(1);
    input.remove();
  });

  it("no preventDefault/stopPropagation is called on any desktop gesture key event", () => {
    // The recognizer must never disturb typing/shortcuts. Spy on both the
    // keydown and the keyup of a full tap.
    const kd = new KeyboardEvent("keydown", { key: "Control", bubbles: true, cancelable: true });
    const ku = new KeyboardEvent("keyup", { key: "Control", bubbles: true, cancelable: true });
    const pd1 = vi.spyOn(kd, "preventDefault");
    const sp1 = vi.spyOn(kd, "stopPropagation");
    const pd2 = vi.spyOn(ku, "preventDefault");
    const sp2 = vi.spyOn(ku, "stopPropagation");
    window.dispatchEvent(kd);
    window.dispatchEvent(ku);
    expect(pd1, "no preventDefault on keydown").not.toHaveBeenCalled();
    expect(sp1, "no stopPropagation on keydown").not.toHaveBeenCalled();
    expect(pd2, "no preventDefault on keyup").not.toHaveBeenCalled();
    expect(sp2, "no stopPropagation on keyup").not.toHaveBeenCalled();
  });

  it("the disposer removes the keydown, keyup AND blur listeners", () => {
    const rm = vi.spyOn(window, "removeEventListener");
    dispose?.();
    dispose = undefined;
    expect(rm).toHaveBeenCalledWith("keydown", expect.any(Function), false);
    expect(rm).toHaveBeenCalledWith("keyup", expect.any(Function), false);
    expect(rm).toHaveBeenCalledWith("blur", expect.any(Function));
    rm.mockRestore();
    // Functional: a full triple after dispose posts nothing.
    ctrlTriple();
    window.dispatchEvent(new Event("blur")); // removed blur listener must not crash
    expect(overlayCount(posted), "disposed recognizer is inert").toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DESKTOP: embed gate + uncaptured origin
// ---------------------------------------------------------------------------

describe("host gesture — embed gate + uncaptured origin", () => {
  afterEach(() => {
    Object.defineProperty(window, "parent", { configurable: true, value: window });
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("returns undefined when window.parent === window (standalone)", () => {
    vi.useFakeTimers();
    // jsdom default: window.parent === window.
    const dispose = startHostGesture();
    expect(dispose, "standalone → no-op (undefined)").toBeUndefined();
    dispose?.();
  });

  it("does not post before the host handshake landed (uncaptured origin)", () => {
    vi.useFakeTimers();
    const { parent, posted } = makeFakeParent();
    Object.defineProperty(window, "parent", { configurable: true, get: () => parent });
    const dispose = startHostGesture();
    // NO handshake sent → hostOrigin is null → recognitions are dropped.
    ctrlTriple();
    threeFingerDowns();
    threeFingerUps();
    expect(overlayCount(posted), "no post before handshake").toBe(0);
    // After the handshake lands, a new recognition posts.
    sendFromParent(parent, { type: "vh-host-handshake", nonce: "n" });
    ctrlTriple();
    expect(overlayCount(posted), "posts after handshake").toBe(1);
    dispose?.();
  });

  it("ignores a handshake / host-mode from a non-parent source", () => {
    vi.useFakeTimers();
    const { parent, posted } = makeFakeParent();
    Object.defineProperty(window, "parent", { configurable: true, get: () => parent });
    const dispose = startHostGesture();
    // An alien source claims to be the host handshake → ignored (no origin
    // captured), so a subsequent triple-Ctrl still cannot post.
    const alien = {} as Window;
    sendFromParent(alien, { type: "vh-host-handshake", nonce: "x" });
    ctrlTriple();
    expect(overlayCount(posted), "alien handshake ignored → no captured origin").toBe(0);
    dispose?.();
  });
});

// ---------------------------------------------------------------------------
// PANE-ACTIVATE FORWARD (cross-origin activation bridge)
// ---------------------------------------------------------------------------
// The SPA forwards a `{type:"host-gesture", gesture:"pane-activate"}` signal
// when it gains focus / receives a pointerdown so the host can call focusPane
// (a tap inside a cross-origin iframe does not bubble to the host, so Dockview's
// native onDidActivePanelChange never fires). Forwarding is UNCONDITIONAL (no
// once-per-focus-session throttle — that throttle's window.blur reset was
// cross-origin-unreliable on real touch, m0317; the host dedupes when the pane
// is already focused); closed payload; captured-origin targeting (never '*');
// source-guard on the handshake. Mirrors the gesture recognizer's security model.

describe("host gesture — pane-activate forward", () => {
  let parent: Window;
  let posted: Posted[];
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    const fake = makeFakeParent();
    parent = fake.parent;
    posted = fake.posted;
    Object.defineProperty(window, "parent", { configurable: true, get: () => parent });
    dispose = startHostGesture();
    sendFromParent(parent, { type: "vh-host-handshake", nonce: "n" });
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    Object.defineProperty(window, "parent", { configurable: true, value: window });
  });

  it("window focus → posts exactly one pane-activate", () => {
    window.dispatchEvent(new Event("focus"));
    expect(activateCount(posted), "focus → one activate").toBe(1);
  });

  it("document pointerdown → posts exactly one pane-activate (mobile-reliable path)", () => {
    sendTap();
    expect(activateCount(posted), "pointerdown → one activate").toBe(1);
  });

  // REGRESSION (operator report): "clicking on the input text box [composer]
  // sometimes failed to make the target pane focus." Root cause: the document
  // pointerdown listener was registered in the BUBBLE phase (the `false` 3rd
  // arg). An element- / library- / browser-level handler that calls
  // e.stopPropagation() on pointerdown's bubble path BLOCKS the document bubble
  // listener → no pane-activate forward. (SolidJS delegates `pointerdown` to
  // `document`, and component/library/browser gesture handling can stop
  // propagation to keep a gesture local.) In a pane whose window is ALREADY
  // focused, window.focus does not fire either (it fires only on window-level
  // focus gain, not on clicks within an already-focused window), so NEITHER
  // path forwards → the host never re-activates → the focus indicator stays
  // stuck on the stale pane. The fix registers the document pointerdown listener
  // in the CAPTURE phase, which fires BEFORE any target/bubble-phase
  // stopPropagation can block it. This is the deterministic red for that bug.
  it("REGRESSION: a pointerdown whose bubble path calls stopPropagation STILL forwards (capture phase)", () => {
    const input = document.createElement("input");
    // Element-level bubble-phase handler that swallows the event — models a
    // component/library/browser handler that stops propagation to keep the
    // gesture local. On the BUGGY (bubble-phase) document listener this blocks
    // the forward; on the FIXED (capture-phase) listener it does not.
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.appendChild(input);
    sendTap({ target: input });
    expect(
      activateCount(posted),
      "capture-phase listener survives an element-level stopPropagation",
    ).toBe(1);
    input.remove();
  });

  it("REGRESSION: focusin on any element forwards (the reliable element-focus path)", () => {
    // window.focus fires ONLY on window-level focus gain — it does NOT fire
    // when focus moves between elements WITHIN an already-focused window (e.g.
    // clicking the composer in a pane whose window already had focus). focusin
    // BUBBLES natively (focus does not) and fires on every element focus gain,
    // so it is the reliable element-focus signal. Registered in capture phase
    // so an element-level stopPropagation cannot block it (same defense as
    // pointerdown). Together with the capture-phase pointerdown, this covers
    // every activation path: a re-tap on an already-focused composer fires
    // pointerdown (no focus change → no focusin), while a focus-into-composer
    // fires focusin (and pointerdown); window.focus catches the cross-window
    // case. At least one always fires.
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(activateCount(posted), "focusin → one activate").toBe(1);
    input.remove();
  });

  it("REGRESSION: a focusin whose bubble path calls stopPropagation STILL forwards (capture phase)", () => {
    // Same capture-phase defense as the pointerdown regression, applied to the
    // focusin path: an element/library/browser handler that stops focusin
    // propagation cannot suppress the forward.
    const input = document.createElement("input");
    input.addEventListener("focusin", (e) => e.stopPropagation());
    document.body.appendChild(input);
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(
      activateCount(posted),
      "capture-phase focusin survives an element-level stopPropagation",
    ).toBe(1);
    input.remove();
  });

  it("posts a CLOSED payload — exactly {type, gesture:pane-activate}, no extras", () => {
    sendTap();
    const activates = posted.filter(
      (p) => p.msg.type === "host-gesture" && p.msg.gesture === "pane-activate",
    );
    expect(activates.length).toBe(1);
    expect(Object.keys(activates[0].msg).sort(), "exactly {type, gesture}").toEqual([
      "gesture",
      "type",
    ]);
    expect(activates[0].msg.gesture, "closed gesture value").toBe("pane-activate");
  });

  it("targets the captured host origin (never '*')", () => {
    window.dispatchEvent(new Event("focus"));
    const activates = posted.filter(
      (p) => p.msg.type === "host-gesture" && p.msg.gesture === "pane-activate",
    );
    expect(activates[0].origin, "origin-bound to handshake origin").toBe(HOST_ORIGIN);
  });

  it("every focus forwards (no session throttle — host dedupes the duplicate)", () => {
    // The OLD once-per-focus-session throttle suppressed repeated focuses until a
    // (cross-origin-unreliable) window.blur reset it. Removed (m0317): forwarding
    // is now unconditional; the host no-ops when the pane is already focused.
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    expect(activateCount(posted), "each focus forwards").toBe(3);
  });

  it("every pointerdown forwards (no session throttle — host dedupes)", () => {
    sendTap();
    sendTap();
    sendTap();
    sendTap();
    expect(activateCount(posted), "each tap forwards").toBe(4);
  });

  it("blur is a no-op: forwarding is unconditional (no blur reset, no debounce)", () => {
    // Pins two invariants at once: (1) window.blur no longer participates in
    // activation logic, so a future refactor cannot silently re-introduce the
    // cross-origin-unreliable reset; (2) there is no time-based debounce either
    // (a debounce's expire signal would be no more reliable cross-origin than
    // window.blur, and could drop a genuine activation). An immediate refocus
    // forwards unconditionally.
    window.dispatchEvent(new Event("focus"));
    expect(activateCount(posted)).toBe(1);
    window.dispatchEvent(new Event("blur")); // no effect on forwarding
    expect(activateCount(posted), "blur did not change the count").toBe(1);
    window.dispatchEvent(new Event("focus"));
    expect(activateCount(posted), "refocus forwards unconditionally").toBe(2);
  });

  it("does not post before the host handshake landed (uncaptured origin)", () => {
    // Fresh recognizer with NO handshake: hostOrigin stays null → activate drops.
    dispose?.();
    posted.length = 0;
    const fake = makeFakeParent();
    parent = fake.parent;
    posted = fake.posted;
    Object.defineProperty(window, "parent", { configurable: true, get: () => parent });
    dispose = startHostGesture();
    window.dispatchEvent(new Event("focus"));
    sendTap();
    expect(activateCount(posted), "no post before handshake").toBe(0);
    sendFromParent(parent, { type: "vh-host-handshake", nonce: "n2" });
    window.dispatchEvent(new Event("focus"));
    expect(activateCount(posted), "posts after handshake").toBe(1);
  });

  it("ignores a handshake from a non-parent source (no captured origin → no post)", () => {
    // Fresh recognizer: an alien claims the handshake → ignored, hostOrigin null.
    dispose?.();
    posted.length = 0;
    const fake = makeFakeParent();
    parent = fake.parent;
    posted = fake.posted;
    Object.defineProperty(window, "parent", { configurable: true, get: () => parent });
    dispose = startHostGesture();
    const alien = {} as Window;
    sendFromParent(alien, { type: "vh-host-handshake", nonce: "x" });
    window.dispatchEvent(new Event("focus"));
    sendTap();
    expect(activateCount(posted), "alien handshake → no captured origin → no post").toBe(0);
  });

  it("coexists with 3-finger-tap: each down forwards one activate (host dedupes), overlay fires on the lift", () => {
    // A 3-finger tap = 3 pointerdowns (each forwards ONE activate — forwarding
    // is unconditional; the host dedupes when the pane is already focused) +
    // ONE overlay-request on the last lift. The two listeners do not conflict.
    threeFingerDowns();
    threeFingerUps();
    expect(activateCount(posted), "one activate per finger-down (host dedupes)").toBe(3);
    expect(overlayCount(posted), "3-finger-tap recognized (single overlay)").toBe(1);
  });

  it("fires on an interactive-element pointerdown (tapping a button activates the pane)", () => {
    // The activate listener deliberately does NOT filter interactive elements:
    // tapping a button in pane X means pane X should be active.
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    sendTap({ target: btn });
    expect(activateCount(posted), "button tap → activate posted").toBe(1);
    btn.remove();
  });

  it("NOT suppressed by keyboard-focus mode (the operator is interacting with this pane)", () => {
    // Unlike 3-finger-tap (suppressed while typing so a stray tap doesn't yank the
    // layout), activate fires regardless: even with the soft keyboard up, the
    // operator tapping into this pane means this pane should be the active one.
    sendFromParent(parent, { type: "host-mode", mode: "keyboard-focus" });
    sendTap();
    expect(activateCount(posted), "keyboard-focus active → activate still fires").toBe(1);
  });

  // REGRESSION (operator report m0317): "i focused to a panel but root's focus
  // doesn't change to the new pane, but at rare chance." The OLD once-per-focus-
  // session throttle (activatePosted) reset ONLY on window.blur. The cross-origin
  // window.blur is NOT reliably delivered on real touch (Edge Android) when focus
  // moves between sibling iframes, so a pane previously activated kept
  // activatePosted stuck true → its NEXT tap forwarded nothing → the host never
  // re-activated it → focusedId stayed on the stale pane. Headless jsdom models
  // "no blur delivered" by simply NOT firing blur — which is exactly the on-device
  // failure condition. This is the deterministic red for that bug.
  it("REGRESSION (m0317): re-activation WITHOUT an intervening blur still forwards", () => {
    // First activation (a tap into this pane from elsewhere): forwards.
    sendTap();
    expect(activateCount(posted), "first activation forwards").toBe(1);
    // NO blur event is fired here — modeling the cross-origin blur-suppression
    // that happens on real Edge Android when focus moved away and back.
    // The SECOND activation MUST still forward (the host dedupes if this pane is
    // already focused; the SPA must not pre-suppress it).
    sendTap();
    expect(activateCount(posted), "no-blur re-activation still forwards (no throttle)").toBe(2);
  });
});

// ---------------------------------------------------------------------------
// MOBILE: 3-finger-tap — the ONLY mobile recognizer, HARDENED with lift-distance
// gating (fires on ALL-LIFTED; a swipe must NOT fire). Covers the tap path, the
// swipe rejection, the pointer-count edges, and both time windows.
// ---------------------------------------------------------------------------

describe("host gesture — mobile 3-finger-tap (lift-distance gated)", () => {
  let parent: Window;
  let posted: Posted[];
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    const fake = makeFakeParent();
    parent = fake.parent;
    posted = fake.posted;
    Object.defineProperty(window, "parent", { configurable: true, get: () => parent });
    dispose = startHostGesture();
    sendFromParent(parent, { type: "vh-host-handshake", nonce: "n" });
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    Object.defineProperty(window, "parent", { configurable: true, value: window });
  });

  it("3 fingers down → 3 up, minimal per-finger movement → recognized", () => {
    threeFingerDowns();
    threeFingerUps();
    expect(overlayCount(posted), "3-finger-tap → recognized").toBe(1);
  });

  it("fires on the LAST lift, NOT on the 3rd pointerdown (swipe-safe arming)", () => {
    // The v0 recognizer fired on the 3rd pointerdown — before it could know
    // whether the fingers would swipe. The hardened recognizer must stay
    // silent until every finger has lifted.
    threeFingerDowns();
    expect(overlayCount(posted), "3 downs alone → no fire (lift-gated)").toBe(0);
    fingerUp({ id: 10, x: 1, y: 1 });
    fingerUp({ id: 11, x: 41, y: 3 });
    expect(overlayCount(posted), "2 of 3 lifted → still no fire").toBe(0);
    fingerUp({ id: 12, x: 79, y: 2 });
    expect(overlayCount(posted), "last lift → fire").toBe(1);
  });

  it("no preventDefault on the pointerdowns (the fire happens on lift; downs keep native behavior)", () => {
    const pds = threeFingerDowns();
    threeFingerUps();
    for (const [i, pd] of pds.entries()) {
      expect(pd, `pointerdown #${i + 1} not default-prevented`).not.toHaveBeenCalled();
    }
  });

  it("3-finger SWIPE does NOT fire (one finger moves > tolerance between down and up)", () => {
    // Finger 12 lands at (80,0) but lifts at (200,40) — a deliberate swipe
    // distance (> 15px). The gesture must reset, not fire.
    threeFingerDowns();
    fingerUp({ id: 10, x: 1, y: 1 });
    fingerUp({ id: 11, x: 41, y: 3 });
    fingerUp({ id: 12, x: 200, y: 40 });
    expect(overlayCount(posted), "swipe → no fire").toBe(0);
  });

  it("swipe detection triggers on the FIRST out-of-tolerance lift (mid-gesture reset)", () => {
    // The out-of-tolerance finger lifts FIRST — the gesture resets immediately
    // so the remaining in-place lifts cannot salvage a recognition.
    threeFingerDowns();
    fingerUp({ id: 11, x: 500, y: 0 }); // finger 11 swiped far
    fingerUp({ id: 10, x: 1, y: 1 });
    fingerUp({ id: 12, x: 79, y: 2 });
    expect(overlayCount(posted), "early swipe lift → gesture reset → no fire").toBe(0);
  });

  it("a finger exactly AT the tolerance boundary does not reject (<= gate)", () => {
    // 15px drift is exactly THREE_FINGER_TAP_MAX_MOVEMENT_PX — within (<=).
    const specs: FingerSpec[] = [
      { id: 10, isPrimary: true, x: 0, y: 0, ux: 9, uy: 12 }, // 15.0 exactly
      { id: 11, isPrimary: false, x: 40, y: 5, ux: 41, uy: 3 },
      { id: 12, isPrimary: false, x: 80, y: 0, ux: 79, uy: 2 },
    ];
    threeFingerDowns(specs);
    threeFingerUps(specs);
    expect(overlayCount(posted), "15px drift is at-tolerance → recognized").toBe(1);
  });

  it("inter-finger SPREAD is not movement: fingers 80px apart that each lift in place still fire", () => {
    // The tolerance is per-finger down→up drift, NOT the distance between
    // fingers. Three fingers naturally land spread across the screen.
    const specs: FingerSpec[] = [
      { id: 10, isPrimary: true, x: 0, y: 0, ux: 2, uy: 1 },
      { id: 11, isPrimary: false, x: 150, y: 30, ux: 148, uy: 31 },
      { id: 12, isPrimary: false, x: 300, y: 0, ux: 301, uy: 2 },
    ];
    threeFingerDowns(specs);
    threeFingerUps(specs);
    expect(overlayCount(posted), "spread-but-stationary fingers → recognized").toBe(1);
  });

  it("2-finger tap does NOT fire (never reaches 3 simultaneous pointers)", () => {
    fingerDown({ id: 10, isPrimary: true, x: 0, y: 0 });
    fingerDown({ id: 11, isPrimary: false, x: 40, y: 5 });
    fingerUp({ id: 10, x: 1, y: 1 });
    fingerUp({ id: 11, x: 41, y: 4 });
    expect(overlayCount(posted), "2-finger tap → no fire").toBe(0);
  });

  it("a 4th pointer cancels the gesture (unambiguous non-3-finger intent)", () => {
    threeFingerDowns(); // armed
    fingerDown({ id: 13, isPrimary: false, x: 200, y: 200 }); // 4th finger
    // All four lift in place — the 4th-pointer reset must hold.
    fingerUp({ id: 10, x: 1, y: 1 });
    fingerUp({ id: 11, x: 41, y: 3 });
    fingerUp({ id: 12, x: 79, y: 2 });
    fingerUp({ id: 13, x: 200, y: 200 });
    expect(overlayCount(posted), "4th pointer → cancel → no fire").toBe(0);
  });

  it("ARM-time window expiry: the 3rd finger landing too slowly disarms", () => {
    fingerDown({ id: 10, isPrimary: true, x: 0, y: 0 });
    vi.advanceTimersByTime(400); // > THREE_FINGER_TAP_WINDOW_MS (300)
    fingerDown({ id: 11, isPrimary: false, x: 40, y: 5 });
    fingerDown({ id: 12, isPrimary: false, x: 80, y: 0 });
    threeFingerUps();
    expect(overlayCount(posted), "slow 3rd landing → no fire").toBe(0);
  });

  it("FIRE-time window expiry: slow lifts past the total window do not fire", () => {
    threeFingerDowns(); // armed quickly
    vi.advanceTimersByTime(400); // lifts land > 300ms after the first down
    fingerUp({ id: 10, x: 1, y: 1 });
    fingerUp({ id: 11, x: 41, y: 3 });
    fingerUp({ id: 12, x: 79, y: 2 });
    expect(overlayCount(posted), "total elapsed > window → no fire").toBe(0);
  });

  it("a pointercancel counts as the finger's lift (movement measured from landing)", () => {
    // Real touch fires pointercancel (scroll/ Gesture takeover) instead of
    // pointerup; an in-place cancel must not break an otherwise-valid tap.
    threeFingerDowns();
    fingerUp({ id: 10, x: 1, y: 1 }, "pointercancel");
    fingerUp({ id: 11, x: 41, y: 3 });
    fingerUp({ id: 12, x: 79, y: 2 });
    expect(overlayCount(posted), "in-place pointercancel → still recognized").toBe(1);
  });

  it("a pointercancel WITH swipe-scale movement rejects (same lift-distance gate)", () => {
    threeFingerDowns();
    fingerUp({ id: 10, x: 1, y: 1 });
    fingerUp({ id: 11, x: 41, y: 3 });
    fingerUp({ id: 12, x: 300, y: 100 }, "pointercancel");
    expect(overlayCount(posted), "far pointercancel → swipe → no fire").toBe(0);
  });

  it("posts the SAME closed overlay-request payload (no contract widening)", () => {
    threeFingerDowns();
    threeFingerUps();
    const ov = posted.filter((p) => p.msg.gesture === "layout-overlay-request");
    expect(ov.length, "exactly one overlay-request").toBe(1);
    expect(ov[0].msg.type, "closed type").toBe("host-gesture");
    expect(ov[0].msg.gesture, "closed gesture value").toBe("layout-overlay-request");
    expect(Object.keys(ov[0].msg).sort(), "exactly {type, gesture}").toEqual(["gesture", "type"]);
  });

  it("targets the captured host origin (never '*')", () => {
    threeFingerDowns();
    threeFingerUps();
    const ov = posted.filter((p) => p.msg.gesture === "layout-overlay-request");
    expect(ov[0].origin, "origin-bound to handshake origin").toBe(HOST_ORIGIN);
  });

  it("suppresses while keyboard-focus-mode is active", () => {
    sendFromParent(parent, { type: "host-mode", mode: "keyboard-focus" });
    threeFingerDowns();
    threeFingerUps();
    expect(overlayCount(posted), "keyboard-focus active → suppressed").toBe(0);
  });

  it("keyboard-focus-mode going NORMAL re-enables the gesture", () => {
    sendFromParent(parent, { type: "host-mode", mode: "keyboard-focus" });
    threeFingerDowns();
    threeFingerUps();
    expect(overlayCount(posted)).toBe(0);
    sendFromParent(parent, { type: "host-mode", mode: "normal" });
    threeFingerDowns();
    threeFingerUps();
    expect(overlayCount(posted), "normal mode → recognized").toBe(1);
  });

  it("ignores a host-mode from a non-parent source", () => {
    // An alien source cannot toggle keyboard-focus suppression.
    const alien = {} as Window;
    sendFromParent(alien, { type: "host-mode", mode: "keyboard-focus" });
    threeFingerDowns();
    threeFingerUps();
    expect(overlayCount(posted), "alien host-mode ignored → still recognized").toBe(1);
  });

  it("re-arms after a completed gesture (no double-fire within one, next gesture fires again)", () => {
    threeFingerDowns();
    threeFingerUps();
    threeFingerDowns();
    threeFingerUps();
    expect(overlayCount(posted), "exactly one per gesture (no double-fire)").toBe(2);
  });

  it("does not post before the host handshake landed (uncaptured origin)", () => {
    dispose?.();
    posted.length = 0;
    const fake = makeFakeParent();
    parent = fake.parent;
    posted = fake.posted;
    Object.defineProperty(window, "parent", { configurable: true, get: () => parent });
    dispose = startHostGesture();
    threeFingerDowns();
    threeFingerUps();
    expect(overlayCount(posted), "no handshake → gesture dropped").toBe(0);
  });

  it("a non-touch (mouse) 3-pointer multi-click does NOT trigger the recognizer", () => {
    // 3-finger-tap is touch-only; a mouse can't have 3 simultaneous touch
    // pointers. Three sequential mouse clicks (distinct ids, spread positions)
    // must not fire — and neither must their ups.
    for (const id of [10, 11, 12]) {
      sendTap({ x: id * 10, y: 0, pointerType: "mouse", pointerId: id, isPrimary: id === 10 });
    }
    for (const id of [10, 11, 12]) {
      fingerUp({ id, x: id * 10, y: 0 });
    }
    expect(overlayCount(posted), "mouse multi-click → no fire").toBe(0);
  });

  it("real-touch imperfection: a palm brush DURING the gesture is the 4th-pointer cancel (strict, but unambiguous)", () => {
    // Real touch routinely registers an incidental palm/thumb edge. With the
    // sequential recognizer gone, a 4th contact is treated as unambiguous
    // non-3-finger intent: the gesture resets. (The operator retries the
    // gesture — a deliberate 3-finger-tap rarely lands with a palm.)
    threeFingerDowns();
    sendTap({ pointerType: "touch", isPrimary: false, pointerId: 99, x: 250, y: 250 }); // palm
    threeFingerUps();
    expect(overlayCount(posted), "palm brush (4th pointer) → cancel").toBe(0);
  });
});
