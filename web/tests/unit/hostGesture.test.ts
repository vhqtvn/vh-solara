// @vitest-environment jsdom
//
// Host gesture recognizer (web/src/hostGesture.ts).
//
// Pins the desktop double-Ctrl + mobile triple-tap recognizers, the embed gate,
// the inbound source-guard, the captured-origin outbound targeting (never '*'),
// the closed outbound payload (exactly {type:"host-gesture", gesture:"layout-
// overlay-request"}, no extra fields), and the keyboard-focus-mode suppression
// of triple-tap (driven by the host's {type:'host-mode'} message). Uses fake
// timers (the recognizer keys its windows on Date.now()).
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

/** Send a keydown with the given props (jsdom's KeyboardEvent does not expose
 *  repeat/isComposing/keyCode via the constructor for all keys, so set them). */
function sendKey(props: {
  key: string;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): void {
  const ev = new KeyboardEvent("keydown", {
    key: props.key,
    bubbles: true,
    cancelable: true,
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

interface TapOpts {
  x?: number;
  y?: number;
  isPrimary?: boolean;
  target?: Element;
}

/** Send a pointerdown on `target` (bubbles to window). jsdom's PointerEvent may
 *  not exist or may not accept isPrimary via the constructor, so define it on
 *  the instance. Returns a preventDefault spy so a test asserts the 3rd-tap-only
 *  preventDefault. */
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
  Object.defineProperty(ev, "target", { value: target, configurable: true });
  ev.preventDefault = preventDefault;
  target.dispatchEvent(ev);
  return { preventDefault };
}

/** Gesture message count captured to the parent (the closed outbound payload). */
function gestureCount(posted: Posted[]): number {
  return posted.filter((p) => p.msg.type === "host-gesture").length;
}

// ---------------------------------------------------------------------------
// DESKTOP: double bare-Ctrl
// ---------------------------------------------------------------------------

describe("host gesture — desktop double-Ctrl", () => {
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

  it("two bare-Ctrl within the window → posts one overlay-request", () => {
    sendKey({ key: "Control" });
    sendKey({ key: "Control" });
    expect(gestureCount(posted), "recognized → exactly one post").toBe(1);
    const msg = posted[0].msg;
    expect(msg.type, "closed type").toBe("host-gesture");
    expect(msg.gesture, "closed gesture value").toBe("layout-overlay-request");
  });

  it("targets the captured host origin (never '*')", () => {
    sendKey({ key: "Control" });
    sendKey({ key: "Control" });
    expect(posted[0].origin, "origin-bound to handshake origin").toBe(HOST_ORIGIN);
  });

  it("posts a CLOSED payload — no extra fields leak", () => {
    sendKey({ key: "Control" });
    sendKey({ key: "Control" });
    expect(posted.length).toBe(1);
    expect(Object.keys(posted[0].msg).sort(), "exactly {type, gesture}").toEqual([
      "gesture",
      "type",
    ]);
  });

  it("two bare-Ctrl OUTSIDE the window (slow) → no recognition", () => {
    sendKey({ key: "Control" });
    // 600ms later (> 450ms window): the chain expired, this is a fresh first press.
    vi.advanceTimersByTime(600);
    sendKey({ key: "Control" });
    expect(gestureCount(posted), "outside window → no recognition").toBe(0);
    // A third quick press now completes a NEW chain (second+third within window).
    sendKey({ key: "Control" });
    expect(gestureCount(posted), "new chain completes").toBe(1);
  });

  it("auto-repeated Control does not advance the chain", () => {
    sendKey({ key: "Control" });
    // An auto-repeat keydown (held Control): ignored, does not count as the 2nd.
    sendKey({ key: "Control", repeat: true });
    expect(gestureCount(posted), "repeat ignored").toBe(0);
    // A real (non-repeat) second press still completes within the window.
    sendKey({ key: "Control" });
    expect(gestureCount(posted), "real second press completes").toBe(1);
  });

  it("an intervening NON-modifier key resets the chain (Ctrl+C does not trigger)", () => {
    sendKey({ key: "Control" });
    // The 'c' (Ctrl+C) is a non-modifier keydown → resets the chain.
    sendKey({ key: "c" });
    sendKey({ key: "Control" });
    expect(gestureCount(posted), "intervening letter reset → no recognition").toBe(0);
  });

  it("an intervening modifier key (Shift/Alt/Meta) does NOT reset the chain", () => {
    sendKey({ key: "Control" });
    sendKey({ key: "Shift" });
    sendKey({ key: "Control" });
    expect(gestureCount(posted), "modifier between does not reset").toBe(1);
  });

  it("IME composition active resets the chain", () => {
    sendKey({ key: "Control" });
    // A composing keydown resets.
    sendKey({ key: "a", isComposing: true });
    sendKey({ key: "Control" });
    expect(gestureCount(posted), "composition reset → no recognition").toBe(0);
  });

  it("the legacy keyCode 229 composition sentinel resets the chain", () => {
    sendKey({ key: "Control" });
    sendKey({ key: "x", keyCode: 229 });
    sendKey({ key: "Control" });
    expect(gestureCount(posted), "keyCode 229 reset → no recognition").toBe(0);
  });

  it("works while an editable element is focused (no host-focus suppression)", () => {
    // The desktop gesture is NOT suppressed by editable focus (a physical
    // keyboard is attached). A double-Ctrl while typing still opens the overlay.
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    sendKey({ key: "Control" });
    sendKey({ key: "Control" });
    expect(gestureCount(posted), "editable focus does not suppress double-Ctrl").toBe(1);
    input.remove();
  });

  it("no preventDefault/stopPropagation is called on the desktop gesture keys", () => {
    // The recognizer must never disturb typing/shortcuts. Spy on the event.
    const ev = new KeyboardEvent("keydown", { key: "Control", bubbles: true, cancelable: true });
    const pd = vi.spyOn(ev, "preventDefault");
    const sp = vi.spyOn(ev, "stopPropagation");
    window.dispatchEvent(ev);
    expect(pd, "no preventDefault").not.toHaveBeenCalled();
    expect(sp, "no stopPropagation").not.toHaveBeenCalled();
  });

  it("idempotent-on-recognition: a rapid triple-Ctrl posts twice (no stacking within one pair)", () => {
    // A double-Ctrl recognizes and resets; a second double-Ctrl recognizes again.
    sendKey({ key: "Control" });
    sendKey({ key: "Control" });
    sendKey({ key: "Control" });
    sendKey({ key: "Control" });
    expect(gestureCount(posted), "two distinct recognitions").toBe(2);
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
    sendKey({ key: "Control" });
    sendKey({ key: "Control" });
    expect(gestureCount(posted), "no post before handshake").toBe(0);
    // After the handshake lands, a new recognition posts.
    sendFromParent(parent, { type: "vh-host-handshake", nonce: "n" });
    sendKey({ key: "Control" });
    sendKey({ key: "Control" });
    expect(gestureCount(posted), "posts after handshake").toBe(1);
    dispose?.();
  });

  it("ignores a handshake / host-mode from a non-parent source", () => {
    vi.useFakeTimers();
    const { parent, posted } = makeFakeParent();
    Object.defineProperty(window, "parent", { configurable: true, get: () => parent });
    const dispose = startHostGesture();
    // An alien source claims to be the host handshake → ignored (no origin
    // captured), so a subsequent double-Ctrl still cannot post.
    const alien = {} as Window;
    sendFromParent(alien, { type: "vh-host-handshake", nonce: "x" });
    sendKey({ key: "Control" });
    sendKey({ key: "Control" });
    expect(gestureCount(posted), "alien handshake ignored → no captured origin").toBe(0);
    dispose?.();
  });
});

// ---------------------------------------------------------------------------
// MOBILE: triple-tap
// ---------------------------------------------------------------------------

describe("host gesture — mobile triple-tap", () => {
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
    // Clear any selection a test may have left.
    window.getSelection()?.removeAllRanges();
    Object.defineProperty(window, "parent", { configurable: true, value: window });
  });

  it("three primary taps in place within the window → posts once", () => {
    sendTap();
    sendTap();
    const { preventDefault } = sendTap();
    expect(gestureCount(posted), "recognized → exactly one post").toBe(1);
    expect(preventDefault, "preventDefault ONLY on the 3rd tap").toHaveBeenCalled();
  });

  it("preventDefault is NOT called on the 1st or 2nd tap", () => {
    const a = sendTap();
    const b = sendTap();
    expect(a.preventDefault, "1st tap not default-prevented").not.toHaveBeenCalled();
    expect(b.preventDefault, "2nd tap not default-prevented").not.toHaveBeenCalled();
  });

  it("taps too slow (> 600ms window) → the chain expires, no recognition", () => {
    sendTap(); // first (T=0)
    sendTap(); // second (T=0, chains)
    vi.advanceTimersByTime(700); // exceed the 600ms window
    // A third tap now is OUTSIDE the window → starts a NEW chain (becomes its
    // first), so the original triple never completes.
    sendTap();
    expect(gestureCount(posted), "slow sequence does not complete").toBe(0);
  });

  it("movement beyond MAX_MOVEMENT_PX (> 12px) resets", () => {
    sendTap({ x: 0, y: 0 });
    sendTap({ x: 5, y: 5 }); // within 12px (≈7px)
    sendTap({ x: 100, y: 0 }); // far outside → resets, this becomes a new first
    sendTap({ x: 100, y: 0 });
    sendTap({ x: 100, y: 0 });
    expect(gestureCount(posted), "movement reset → later in-place taps complete").toBe(1);
  });

  it("a tap on an interactive element resets (button)", () => {
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    sendTap();
    sendTap();
    // A tap on a button resets the chain.
    sendTap({ target: btn });
    // Subsequent in-place taps would now need three fresh ones.
    sendTap();
    sendTap();
    expect(gestureCount(posted), "button tap reset → no recognition").toBe(0);
    btn.remove();
  });

  it("a tap on an ARIA-interactive element resets (role=button)", () => {
    const el = document.createElement("div");
    el.setAttribute("role", "button");
    document.body.appendChild(el);
    sendTap();
    sendTap();
    sendTap({ target: el });
    sendTap();
    sendTap();
    expect(gestureCount(posted), "ARIA-button tap reset → no recognition").toBe(0);
    el.remove();
  });

  it("multi-touch (a non-primary pointer) cancels an in-flight sequence", () => {
    sendTap();
    sendTap();
    // A second finger (non-primary) cancels.
    sendTap({ isPrimary: false });
    sendTap();
    sendTap();
    expect(gestureCount(posted), "multi-touch cancelled → no recognition").toBe(0);
  });

  it("a non-collapsed text selection cancels", () => {
    // Fake a non-collapsed selection: mock window.getSelection to report one.
    const real = window.getSelection?.bind(window);
    const fakeSel = {
      rangeCount: 1,
      isCollapsed: false,
      toString: () => "selected",
      removeAllRanges: () => {},
    };
    vi.spyOn(window, "getSelection").mockReturnValue(fakeSel as unknown as Selection);
    sendTap();
    sendTap();
    sendTap();
    expect(gestureCount(posted), "selection active → no recognition").toBe(0);
    vi.restoreAllMocks();
    void real;
  });

  it("keyboard-focus-mode ACTIVE suppresses triple-tap", () => {
    sendFromParent(parent, { type: "host-mode", mode: "keyboard-focus" });
    sendTap();
    sendTap();
    sendTap();
    expect(gestureCount(posted), "keyboard-focus active → suppressed").toBe(0);
  });

  it("keyboard-focus-mode going NORMAL re-enables triple-tap", () => {
    sendFromParent(parent, { type: "host-mode", mode: "keyboard-focus" });
    sendTap();
    sendTap();
    sendTap();
    expect(gestureCount(posted)).toBe(0);
    sendFromParent(parent, { type: "host-mode", mode: "normal" });
    sendTap();
    sendTap();
    const { preventDefault } = sendTap();
    expect(gestureCount(posted), "normal mode → recognized").toBe(1);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("ignores a host-mode from a non-parent source", () => {
    // An alien source cannot toggle keyboard-focus suppression.
    const alien = {} as Window;
    sendFromParent(alien, { type: "host-mode", mode: "keyboard-focus" });
    sendTap();
    sendTap();
    sendTap();
    expect(gestureCount(posted), "alien host-mode ignored → still recognized").toBe(1);
  });
});
