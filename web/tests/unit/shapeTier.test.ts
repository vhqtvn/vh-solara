// @vitest-environment jsdom
// shapeTier — the Phase 3 shape-tier signal (S2a heights + S2b widths).
// Pins: threshold classification (short <= 520 / tiny <= 400 visual px; narrow
// < 560 / rail 560–720 / wide > 720), hysteresis (entering is immediate,
// leaving needs +16px), zoom normalization (RO measures the LOCAL zoom-divided
// box; thresholds are VISUAL px = local x uiZoom()), rAF coalescing (latest
// box in a frame wins), the explicit "normal" attribute after the first
// observation, BOTH tier attributes landing from ONE observer, cleanup reset,
// and the persisted kill-switch (vh.prefs.shapeTier.v1 = "off" -> no observer,
// NO attribute on either axis, stale attributes cleared).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyHeightTier,
  classifyWidthTier,
  heightTier,
  installShapeTier,
  widthTier,
  SHORT_TIER_PX,
  TIER_HYST_PX,
  TINY_TIER_PX,
  W_TIER_RAIL_MIN,
  W_TIER_WIDE,
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

function fireRO(el: Element, localHeight: number, localWidth: number = localHeight): void {
  const reg = roRegistrations.find((r) => r.el === el && !r.inst.disconnected);
  if (!reg) throw new Error(`no live RO registration for ${el}`);
  const entry = { contentRect: { height: localHeight, width: localWidth } } as unknown as ResizeObserverEntry;
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

describe("classifyWidthTier — pure thresholds (S2b rail band)", () => {
  it("wide above the band", () => {
    expect(classifyWidthTier(W_TIER_WIDE + 1, "wide")).toBe("wide");
    expect(classifyWidthTier(3000, "wide")).toBe("wide");
  });

  it("rail spans 560–720 inclusive (the exact boundaries)", () => {
    expect(classifyWidthTier(559, "wide")).toBe("narrow"); // narrow is < 560 STRICT
    expect(classifyWidthTier(W_TIER_RAIL_MIN, "wide")).toBe("rail");
    expect(classifyWidthTier(W_TIER_WIDE, "wide")).toBe("rail");
    expect(classifyWidthTier(W_TIER_WIDE + 1, "wide")).toBe("wide"); // > 720 wide
  });

  it("narrow below 560", () => {
    expect(classifyWidthTier(W_TIER_RAIL_MIN - 1, "rail")).toBe("narrow");
    expect(classifyWidthTier(200, "rail")).toBe("narrow"); // immediate compacting
  });
});

describe("classifyWidthTier — hysteresis (leaving needs +buffer)", () => {
  it("narrow is held until 575, left at 576", () => {
    expect(classifyWidthTier(W_TIER_RAIL_MIN + TIER_HYST_PX - 1, "narrow")).toBe("narrow");
    expect(classifyWidthTier(W_TIER_RAIL_MIN + TIER_HYST_PX, "narrow")).toBe("rail");
  });

  it("rail is held through 736, left at 737", () => {
    expect(classifyWidthTier(W_TIER_WIDE + TIER_HYST_PX, "rail")).toBe("rail");
    expect(classifyWidthTier(W_TIER_WIDE + TIER_HYST_PX + 1, "rail")).toBe("wide");
  });

  it("entering is NOT buffered (no hysteresis toward the more compact tier)", () => {
    // From wide, 719 is rail directly (no buffer toward compact); from rail,
    // 559 is narrow directly.
    expect(classifyWidthTier(W_TIER_WIDE - 1, "wide")).toBe("rail");
    expect(classifyWidthTier(W_TIER_RAIL_MIN - 1, "rail")).toBe("narrow");
  });

  it("a jump that skips a tier leaves directly (narrow -> wide)", () => {
    expect(classifyWidthTier(1280, "narrow")).toBe("wide");
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
    expect(widthTier()).toBe(null); // width resets to the inert sentinel
    expect(el.hasAttribute("data-w-tier")).toBe(false);
  });

  it("widthTier() is null before the first observation lands (inert sentinel)", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = installShapeTier(el);
    expect(widthTier()).toBe(null);
    cleanup();
  });

  it("width tiers classify live: 500 narrow, 640 rail, 1280 wide", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = installShapeTier(el);
    fireRO(el, 800, 500);
    await nextFrame();
    expect(el.getAttribute("data-w-tier")).toBe("narrow");
    expect(widthTier()).toBe("narrow");
    fireRO(el, 800, 640);
    await nextFrame();
    expect(el.getAttribute("data-w-tier")).toBe("rail");
    fireRO(el, 800, 1280);
    await nextFrame();
    expect(el.getAttribute("data-w-tier")).toBe("wide");
    expect(widthTier()).toBe("wide");
    cleanup();
  });

  it("BOTH attributes land from ONE observer (640x700 -> h normal + w rail)", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const roCountBefore = roRegistrations.length;
    const cleanup = installShapeTier(el);
    // Exactly one registration for this element — the width axis reuses the
    // height observer; a second RO would have added a second registration.
    expect(roRegistrations.filter((r) => r.el === el)).toHaveLength(1);
    fireRO(el, 700, 640);
    await nextFrame();
    expect(el.getAttribute("data-h-tier")).toBe("normal");
    expect(el.getAttribute("data-w-tier")).toBe("rail");
    expect(roRegistrations.length).toBe(roCountBefore + 1);
    cleanup();
  });

  it("width hysteresis at the live boundary: rail holds at 736, left at 737", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = installShapeTier(el);
    fireRO(el, 800, 640);
    await nextFrame();
    expect(el.getAttribute("data-w-tier")).toBe("rail");
    fireRO(el, 800, W_TIER_WIDE + TIER_HYST_PX); // 736 — inside the buffer
    await nextFrame();
    expect(el.getAttribute("data-w-tier")).toBe("rail"); // held
    fireRO(el, 800, W_TIER_WIDE + TIER_HYST_PX + 1); // 737 — clear of it
    await nextFrame();
    expect(el.getAttribute("data-w-tier")).toBe("wide");
    fireRO(el, 800, W_TIER_WIDE); // re-enter the band immediately at 720
    await nextFrame();
    expect(el.getAttribute("data-w-tier")).toBe("rail");
    cleanup();
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

describe("installShapeTier — width zoom normalization (visual px = local x uiZoom)", () => {
  it("uiZoom 1.25: 448 local px = 560 visual -> rail (band entry boundary)", async () => {
    setUiZoom("1.25");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = installShapeTier(el);
    fireRO(el, 800, 448);
    await nextFrame();
    expect(el.getAttribute("data-w-tier")).toBe("rail");
    cleanup();
  });

  it("uiZoom 1.25: 576 local px = 720 visual -> rail (band exit boundary)", async () => {
    setUiZoom("1.25");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = installShapeTier(el);
    fireRO(el, 800, 576);
    await nextFrame();
    expect(el.getAttribute("data-w-tier")).toBe("rail");
    cleanup();
  });

  it("uiZoom 1.25: 577 local px = 721.25 visual -> wide (raw local px would say rail)", async () => {
    setUiZoom("1.25");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = installShapeTier(el);
    fireRO(el, 800, 577);
    await nextFrame();
    // Without the multiply, 577 <= 720 would classify "rail" — this pins that
    // the normalization is applied to the width axis, not bypassed.
    expect(el.getAttribute("data-w-tier")).toBe("wide");
    cleanup();
  });

  it("uiZoom 1.25: 447 local px = 558.75 visual -> narrow (raw local px would say rail)", async () => {
    setUiZoom("1.25");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = installShapeTier(el);
    fireRO(el, 800, 447);
    await nextFrame();
    expect(el.getAttribute("data-w-tier")).toBe("narrow");
    cleanup();
  });
});

describe("installShapeTier — persisted kill-switch", () => {
  it('vh.prefs.shapeTier.v1 = "off": no observer, no attribute (either axis), stale attributes cleared', async () => {
    // The flag is read once at module init (persistedSignal hydrates from
    // localStorage at import), so set storage BEFORE re-importing the module.
    localStorage.setItem("vh.prefs.shapeTier.v1", JSON.stringify({ v: 1, data: "off" }));
    vi.resetModules();
    const mod = await import("../../src/shapeTier");

    const el = document.createElement("div");
    document.body.appendChild(el);
    el.setAttribute("data-h-tier", "short"); // stale state from an earlier run
    el.setAttribute("data-w-tier", "rail");
    const roCountBefore = roRegistrations.length;

    const cleanup = mod.installShapeTier(el);
    expect(el.getAttribute("data-h-tier")).toBe(null); // cleared, never set
    expect(el.getAttribute("data-w-tier")).toBe(null); // cleared, never set
    expect(roRegistrations.length).toBe(roCountBefore); // no observer constructed
    expect(mod.heightTier()).toBe("normal");
    expect(mod.widthTier()).toBe(null); // inert sentinel — the legacy fallback key
    cleanup(); // no-op disposal
    expect(mod.heightTier()).toBe("normal");
    expect(mod.widthTier()).toBe(null);
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
    expect(el.hasAttribute("data-w-tier")).toBe(false);
    expect(mod.widthTier()).toBe(null);
    cleanup();
  });

  it("BARE legacy string \"off\" (no envelope) DISABLES the module — the kill-switch footgun fix", async () => {
    // The footgun: writing the raw string "off" (not JSON, no {v,data}
    // envelope) used to fall back to "on" — silently re-enabling the tiers
    // the operator tried to disable. The migrate at the persistedSignal call
    // site must accept it. Both storage spellings route there: the raw
    // 3-char value (JSON.parse throws → migrate(raw)) and the JSON-encoded
    // string "\"off\"" (parses to a non-envelope → migrate(parsed)).
    for (const stored of ["off", JSON.stringify("off")]) {
      localStorage.setItem("vh.prefs.shapeTier.v1", stored);
      vi.resetModules();
      const mod = await import("../../src/shapeTier");
      const el = document.createElement("div");
      document.body.appendChild(el);
      el.setAttribute("data-h-tier", "short"); // stale attrs must clear
      const roCountBefore = roRegistrations.length;
      const cleanup = mod.installShapeTier(el);
      expect(roRegistrations.length).toBe(roCountBefore); // no observer
      expect(el.getAttribute("data-h-tier")).toBe(null);
      expect(el.getAttribute("data-w-tier")).toBe(null);
      expect(mod.widthTier()).toBe(null);
      cleanup();
    }
  });

  it("BARE legacy string \"on\" (no envelope) still enables the module", async () => {
    localStorage.setItem("vh.prefs.shapeTier.v1", "on");
    vi.resetModules();
    const mod = await import("../../src/shapeTier");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = mod.installShapeTier(el);
    const reg = roRegistrations.find((r) => r.el === el);
    expect(reg, "observer constructed (module enabled)").toBeTruthy();
    fireRO(el, 480);
    await nextFrame();
    expect(el.getAttribute("data-h-tier")).toBe("short");
    cleanup();
  });

  it("any other bare junk falls back to the default \"on\" (enabled)", async () => {
    localStorage.setItem("vh.prefs.shapeTier.v1", "nonsense");
    vi.resetModules();
    const mod = await import("../../src/shapeTier");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = mod.installShapeTier(el);
    expect(roRegistrations.some((r) => r.el === el)).toBe(true);
    cleanup();
  });
});
