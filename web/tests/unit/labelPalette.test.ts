// Pure-logic unit tests for the slice-6 label palette helpers
// (web/src/components/labelPalette.ts). No DOM, so this stays in the default
// node environment (no jsdom docblock) — the helpers are pure functions with
// no Solid, no signals, no DOM access.
import { describe, expect, it } from "vitest";
import {
  LABEL_COLORS,
  abbreviate,
  defaultColorForIndex,
  labelColorVar,
  visibleTagChips,
} from "../../src/components/labelPalette";

describe("labelColorVar", () => {
  it("maps each palette token to its --label-<color> var", () => {
    for (const c of LABEL_COLORS) {
      expect(labelColorVar(c)).toBe(`var(--label-${c})`);
    }
  });

  it("falls back to --label-gray for an off-palette / empty / null color", () => {
    expect(labelColorVar("pink")).toBe("var(--label-gray)");
    expect(labelColorVar("")).toBe("var(--label-gray)");
    expect(labelColorVar(undefined)).toBe("var(--label-gray)");
    expect(labelColorVar(null)).toBe("var(--label-gray)");
  });
});

describe("defaultColorForIndex", () => {
  it("returns the palette token at the given index", () => {
    expect(defaultColorForIndex(0)).toBe("blue");
    expect(defaultColorForIndex(1)).toBe("green");
    expect(defaultColorForIndex(2)).toBe("amber");
  });

  it("wraps via modulo so every index is in range and is a valid token", () => {
    const n = LABEL_COLORS.length;
    expect(defaultColorForIndex(n)).toBe(LABEL_COLORS[0]);
    expect(defaultColorForIndex(n + 3)).toBe(LABEL_COLORS[3]);
    // negative index wraps correctly (defensive — should not happen in practice)
    expect(defaultColorForIndex(-1)).toBe(LABEL_COLORS[n - 1]);
    // every result is a known token
    for (let i = 0; i < n * 3; i++) {
      expect(LABEL_COLORS).toContain(defaultColorForIndex(i));
    }
  });
});

describe("abbreviate", () => {
  it("takes the first alphanumeric word's leading chars, lowercased", () => {
    expect(abbreviate("Backend")).toBe("ba");
    expect(abbreviate("backend-api")).toBe("ba");
    expect(abbreviate("Urgent")).toBe("ur");
    expect(abbreviate("API")).toBe("ap");
  });

  it("returns '' for a name with no leading alphanumeric char", () => {
    expect(abbreviate("---")).toBe("");
    expect(abbreviate("")).toBe("");
    expect(abbreviate("   ")).toBe("");
  });

  it("honors a custom max length", () => {
    expect(abbreviate("Backend", 3)).toBe("bac");
    expect(abbreviate("backend-api", 3)).toBe("bac");
  });
});

describe("visibleTagChips", () => {
  const tags = [
    { id: "lt-1", name: "alpha", color: "red" },
    { id: "lt-2", name: "beta", color: "green" },
    { id: "lt-3", name: "gamma", color: "blue" },
    { id: "lt-4", name: "delta", color: "amber" },
  ];

  it("returns all chips unchanged when at or under the max (no overflow)", () => {
    expect(visibleTagChips(tags.slice(0, 1))).toEqual(tags.slice(0, 1));
    expect(visibleTagChips(tags.slice(0, 2))).toEqual(tags.slice(0, 2));
    // empty input → empty output
    expect(visibleTagChips([])).toEqual([]);
  });

  it("caps to max and appends a synthetic +N overflow chip (no color dot)", () => {
    const out = visibleTagChips(tags); // default max=2, 4 tags → +2
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(tags[0]);
    expect(out[1]).toEqual(tags[1]);
    const over = out[2];
    expect(over.overflow).toBe(true);
    expect(over.name).toBe("+2");
    expect(over.id).toBe("__label-overflow");
  });

  it("respects a custom max and computes overflow against it", () => {
    // max=3, 4 tags → +1
    const out = visibleTagChips(tags, 3);
    expect(out).toHaveLength(4);
    expect(out[3].overflow).toBe(true);
    expect(out[3].name).toBe("+1");
  });

  it("does not mutate the input array (returns shallow copies)", () => {
    const input = tags.slice(0, 2);
    const out = visibleTagChips(input, 2);
    expect(out).not.toBe(input); // a new array
    expect(out[0]).toEqual(input[0]); // same content
    // overflow chip is a fresh object, not an alias of any input tag
    const withOverflow = visibleTagChips(tags, 1);
    expect(withOverflow[0]).toEqual(tags[0]);
    expect(withOverflow[1].overflow).toBe(true);
  });

  it("input order is preserved in the visible prefix", () => {
    const out = visibleTagChips(tags, 2);
    expect(out[0].id).toBe("lt-1");
    expect(out[1].id).toBe("lt-2");
  });
});
