// @vitest-environment jsdom
// shapeTier — the Phase 3 S2a height-tier signal (short-pane defense).
// Pins: threshold classification (short <= 520 visual px, tiny <= 400),
// hysteresis (entering is immediate, leaving needs +16px), zoom normalization
// (RO measures the LOCAL zoom-divided box; thresholds are VISUAL px =
// local x uiZoom()), rAF coalescing (latest height in a frame wins), the
// explicit "normal" attribute after the first observation, cleanup reset, and
// the persisted kill-switch (vh.prefs.shapeTier.v1 = "off" -> no observer,
// no attribute, stale attribute cleared).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyHeightTier,
  heightTier,
  installShapeTier,
  SHORT_TIER_PX,
  TIER_HYST_PX,
  TINY_TIER_PX,
} from "../../src/shapeTier";

// --- controllable ResizeObserver (repo pattern; see ChatViewNavigator) ------
// jsdom lacks ResizeObserver. Records every (element, callback) registration
// and every constructed instance so tests can both fire observations at a
// chosen element and assert that the kill-switch constructs NO observer.
type ROCb = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void;
const roRegistrations: { el: Element; cb: ROCb; inst: FakeRO }[] = [];

class FakeRO {
  disconnected = false;
  private cb: ROCb;
  constructor(cb: ROCb) {
    this.cb = cb;
  }
  observe(el: Element): void {
    roRegistrations.push({ el, cb: this.cb, inst: this });
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeRO;

function fireRO(el: Element, localHeight: number): void {
  const reg = roRegistrations.find((r) => r.el === el && !r.inst.disconnected);
  if (!reg) throw new Error(`no live RO registration for ${el}`);
  const entry = { contentRect: { height: localHeight } } as unknown as ResizeObserverEntry;
  reg.cb([entry], {} as ResizeObserver);
}

// The module applies observations in a rAF; awaiting one frame from the test
// side runs after the module's scheduled flush.
const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

function setUiZoom(v: string): void {
  document.documentElement.style.setProperty("--ui-zoom", v);
}

beforeEach(() => {
  localStorage.clear();
  setUiZoom("1");
});

afterEach(() => {
  document.documentElement.style.removeProperty("--ui-zoom");
});

describe("classifyHeightTier — pure thresholds", () => {
  it("normal above the short threshold", () => {
    expect(classifyHeightTier(SHORT_TIER_PX + 1, "normal")).toBe("normal");
    expect(classifyHeightTier(3000, "normal")).toBe("normal");
  });

  it("enters short at <= 520 visual px", () => {
    expect(classifyHeightTier(SHORT_TIER_PX, "normal")).toBe("short");
    expect(classifyHeightTier(SHORT_TIER_PX - 1, "normal")).toBe("short");
  });

  it("enters tiny at <= 400 visual px", () => {
    expect(classifyHeightTier(TINY_TIER_PX, "normal")).toBe("tiny");
    expect(classifyHeightTier(TINY_TIER_PX - 1, "short")).toBe("tiny"); // immediate downgrade
    expect(classifyHeightTier(TINY_TIER_PX + 1, "normal")).toBe("short");
  });
});

describe("classifyHeightTier — hysteresis (leaving needs +buffer)", () => {
  it("short is held until 536, then left", () => {
    expect(classifyHeightTier(SHORT_TIER_PX + TIER_HYST_PX - 1, "short")).toBe("short");
    expect(classifyHeightTier(SHORT_TIER_PX + TIER_HYST_PX, "short")).toBe("normal");
  });

  it("tiny is held until 416 (then relaxes to short, not normal)", () => {
    expect(classifyHeightTier(TINY_TIER_PX + TIER_HYST_PX - 1, "tiny")).toBe("tiny");
    expect(classifyHeightTier(TINY_TIER_PX + TIER_HYST_PX, "tiny")).toBe("short");
  });

  it("entering is NOT buffered (no hysteresis toward the more defensive tier)", () => {
    // A pane growing normal->535 would be short if leaving were the rule;
    // from normal, 535 (> 520) stays normal. Only the CURRENT tier is held.
    expect(classifyHeightTier(SHORT_TIER_PX + TIER_HYST_PX - 1, "normal")).toBe("normal");
    expect(classifyHeightTier(TINY_TIER_PX + TIER_HYST_PX - 1, "normal")).toBe("short");
  });

  it("a jump that skips a tier leaves directly (tiny -> normal)", () => {
    expect(classifyHeightTier(900, "tiny")).toBe("normal");
  });
});

describe("installShapeTier — observer wiring", () => {
  it("sets an explicit data-h-tier on the first observation (normal included)", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = installShapeTier(el);
    fireRO(el, 700);
    await nextFrame();
    expect(el.getAttribute("data-h-tier")).toBe("normal");
    expect(heightTier()).toBe("normal");
    cleanup();
  });

  it("classifies by measured height at zoom 1 (480 -> short, 380 -> tiny)", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = installShapeTier(el);
    fireRO(el, 480);
    await nextFrame();
    expect(el.getAttribute("data-h-tier")).toBe("short");
    fireRO(el, 380);
    await nextFrame();
    expect(el.getAttribute("data-h-tier")).toBe("tiny");
    cleanup();
  });

  it("hysteresis at the live boundary: short holds at 535, leaves at 536", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = installShapeTier(el);
    fireRO(el, 480);
    await nextFrame();
    expect(el.getAttribute("data-h-tier")).toBe("short");
    fireRO(el, SHORT_TIER_PX + TIER_HYST_PX - 1);
    await nextFrame();
    expect(el.getAttribute("data-h-tier")).toBe("short"); // buffered hold
    fireRO(el, SHORT_TIER_PX + TIER_HYST_PX);
    await nextFrame();
    expect(el.getAttribute("data-h-tier")).toBe("normal");
    fireRO(el, SHORT_TIER_PX); // re-enter immediately at the boundary
    await nextFrame();
    expect(el.getAttribute("data-h-tier")).toBe("short");
    cleanup();
  });

  it("coalesces multiple observations within one frame (latest wins)", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = installShapeTier(el);
    fireRO(el, 480); // first observation this frame…
    fireRO(el, 330); // …superseded before the rAF flush
    await nextFrame();
    // 330 -> tiny; if the first height had won it would be "short".
    expect(el.getAttribute("data-h-tier")).toBe("tiny");
    expect(heightTier()).toBe("tiny");
    cleanup();
  });

  it("cleanup disconnects the observer and resets tier + attribute", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = installShapeTier(el);
    fireRO(el, 380);
    await nextFrame();
    expect(heightTier()).toBe("tiny");
    const reg = roRegistrations.find((r) => r.el === el)!;
    cleanup();
    expect(reg.inst.disconnected).toBe(true);
    expect(heightTier()).toBe("normal");
    expect(el.hasAttribute("data-h-tier")).toBe(false);
  });
});

describe("installShapeTier — zoom normalization (visual px = local x uiZoom)", () => {
  it("uiZoom 1.25: 416 local px = 520 visual -> short (boundary)", async () => {
    setUiZoom("1.25");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = installShapeTier(el);
    fireRO(el, 416);
    await nextFrame();
    expect(el.getAttribute("data-h-tier")).toBe("short");
    cleanup();
  });

  it("uiZoom 1.25: 424 local px = 530 visual -> normal (raw local px would say short)", async () => {
    setUiZoom("1.25");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = installShapeTier(el);
    fireRO(el, 424);
    await nextFrame();
    // Without the multiply, 424 <= 520 would classify "short" — this pins
    // that the normalization is actually applied, not bypassed.
    expect(el.getAttribute("data-h-tier")).toBe("normal");
    cleanup();
  });

  it("uiZoom 1.25: 330 local px = 412.5 visual -> short (raw local px would over-report tiny)", async () => {
    setUiZoom("1.25");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = installShapeTier(el);
    fireRO(el, 330);
    await nextFrame();
    expect(el.getAttribute("data-h-tier")).toBe("short");
    cleanup();
  });
});

describe("installShapeTier — persisted kill-switch", () => {
  it('vh.prefs.shapeTier.v1 = "off": no observer, no attribute, stale attribute cleared', async () => {
    // The flag is read once at module init (persistedSignal hydrates from
    // localStorage at import), so set storage BEFORE re-importing the module.
    localStorage.setItem("vh.prefs.shapeTier.v1", JSON.stringify({ v: 1, data: "off" }));
    vi.resetModules();
    const mod = await import("../../src/shapeTier");

    const el = document.createElement("div");
    document.body.appendChild(el);
    el.setAttribute("data-h-tier", "short"); // stale state from an earlier run
    const roCountBefore = roRegistrations.length;

    const cleanup = mod.installShapeTier(el);
    expect(el.getAttribute("data-h-tier")).toBe(null); // cleared, never set
    expect(roRegistrations.length).toBe(roCountBefore); // no observer constructed
    expect(mod.heightTier()).toBe("normal");
    cleanup(); // no-op disposal
    expect(mod.heightTier()).toBe("normal");
  });

  it("a foreign stored flag value does NOT enable the module (only exactly \"on\" does)", async () => {
    localStorage.setItem("vh.prefs.shapeTier.v1", JSON.stringify({ v: 1, data: 42 }));
    vi.resetModules();
    const mod = await import("../../src/shapeTier");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = mod.installShapeTier(el);
    expect(roRegistrations.some((r) => r.el === el)).toBe(false); // no observer
    expect(el.hasAttribute("data-h-tier")).toBe(false);
    cleanup();
  });
});
