import { describe, expect, it } from "vitest";
import {
  classifyHold,
  shouldSkipAfterContextmenu,
  HOLD_THRESHOLD_MS,
} from "../../src/lib/copyHold";

describe("classifyHold", () => {
  it("uses a 450ms threshold", () => {
    expect(HOLD_THRESHOLD_MS).toBe(450);
  });

  it("classifies a 0ms elapsed press as a tap", () => {
    expect(classifyHold(1000, 1000)).toBe("tap");
  });

  it("classifies 449ms (just under threshold) as a tap", () => {
    expect(classifyHold(1000, 1449)).toBe("tap");
  });

  it("classifies exactly 450ms (at threshold) as a hold", () => {
    expect(classifyHold(1000, 1450)).toBe("hold");
  });

  it("classifies 1000ms as a hold", () => {
    expect(classifyHold(1000, 2000)).toBe("hold");
  });

  // downAt === 0 is the sentinel for "no pointerdown recorded this gesture"
  // (keyboard Enter/Space activation, or any programmatic .click()). Keyboard
  // activation has no hold intent, so it must classify as "tap" (text-only)
  // regardless of nowMs — including very large epoch values like a real
  // Date.now(), which would otherwise make Date.now() - 0 >= 450 always true
  // and misclassify as "hold".
  describe("downAt === 0 (keyboard / programmatic activation)", () => {
    it("returns tap when nowMs is below the threshold elapsed from epoch", () => {
      expect(classifyHold(0, 449)).toBe("tap");
    });

    it("returns tap when nowMs equals the threshold elapsed from epoch", () => {
      expect(classifyHold(0, 450)).toBe("tap");
    });

    it("returns tap when nowMs would be a hold if 0 were a real timestamp", () => {
      expect(classifyHold(0, 1000)).toBe("tap");
    });

    it("returns tap for a realistic large epoch nowMs (Date.now()-like)", () => {
      // A representative near-current epoch ms (roughly 2024). Date.now() - 0
      // is always >= 450, so this is the exact keyboard-activation misclass-
      // ification case the sentinel fixes.
      expect(classifyHold(0, 1_700_000_000_000)).toBe("tap");
    });
  });
});

describe("shouldSkipAfterContextmenu", () => {
  it("skips when contextmenu already copied and the click is a hold (the Android double-fire)", () => {
    expect(shouldSkipAfterContextmenu(true, "hold")).toBe(true);
  });

  it("does not skip a hold when no contextmenu copy happened (mouse-hold / iOS path)", () => {
    expect(shouldSkipAfterContextmenu(false, "hold")).toBe(false);
  });

  it("does not skip a tap even if a contextmenu copy flag is set", () => {
    expect(shouldSkipAfterContextmenu(true, "tap")).toBe(false);
  });

  it("does not skip a plain tap with no contextmenu", () => {
    expect(shouldSkipAfterContextmenu(false, "tap")).toBe(false);
  });
});
