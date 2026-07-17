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
    expect(classifyHold(0, 449)).toBe("tap");
  });

  it("classifies exactly 450ms (at threshold) as a hold", () => {
    expect(classifyHold(0, 450)).toBe("hold");
  });

  it("classifies 1000ms as a hold", () => {
    expect(classifyHold(0, 1000)).toBe("hold");
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
