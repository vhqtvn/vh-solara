import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  bottommostRead as BottommostRead,
  clearReadAnchor as ClearReadAnchor,
  clearReadAnchors as ClearReadAnchors,
  getReadAnchor as GetReadAnchor,
  setReadAnchor as SetReadAnchor,
} from "../../src/lib/scroll";

// In-memory localStorage for the node test env. The store module reads its
// cache once on import (module load), so tests reset the module each time and
// control storage BEFORE re-importing — that way the import-time load + legacy
// cleanup run against a known state.
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
};

// `bottommostRead` is a pure function (no module state), so it can be imported
// statically and exercised directly.
import { bottommostRead } from "../../src/lib/scroll";

// Re-import the store (which holds module-level cache) fresh per test.
async function store() {
  vi.resetModules();
  const m = await import("../../src/lib/scroll");
  return {
    getReadAnchor: m.getReadAnchor as typeof GetReadAnchor,
    setReadAnchor: m.setReadAnchor as typeof SetReadAnchor,
    clearReadAnchor: m.clearReadAnchor as typeof ClearReadAnchor,
    clearReadAnchors: m.clearReadAnchors as typeof ClearReadAnchors,
  };
}

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  vi.resetModules();
});

describe("read-anchor store", () => {
  it("round-trips an anchor inside a {v,data} envelope", async () => {
    const s = await store();
    s.setReadAnchor("s1", "m5");
    expect(s.getReadAnchor("s1")).toBe("m5");
    // envelope shape is versioned (vh.scroll.v2)
    const env = JSON.parse(mem["vh.scroll.v2"]);
    expect(env).toEqual({ v: 1, data: { s1: "m5" } });
  });

  it("is sparse: a session with no entry reads as undefined (caught-up default)", async () => {
    const s = await store();
    expect(s.getReadAnchor("unknown")).toBeUndefined();
  });

  it("setReadAnchor is a no-op for a falsy messageID", async () => {
    const s = await store();
    s.setReadAnchor("s1", "");
    expect(s.getReadAnchor("s1")).toBeUndefined();
    expect(mem["vh.scroll.v2"]).toBeUndefined(); // nothing written
  });

  it("does not rewrite storage when the value is unchanged", async () => {
    const s = await store();
    s.setReadAnchor("s1", "m5");
    const before = mem["vh.scroll.v2"];
    s.setReadAnchor("s1", "m5"); // same value
    expect(mem["vh.scroll.v2"]).toBe(before);
  });

  it("clearReadAnchor drops one session and restores the sparse default", async () => {
    const s = await store();
    s.setReadAnchor("s1", "m5");
    s.setReadAnchor("s2", "m9");
    s.clearReadAnchor("s1");
    expect(s.getReadAnchor("s1")).toBeUndefined();
    expect(s.getReadAnchor("s2")).toBe("m9"); // others untouched
  });

  it("clearReadAnchor is a no-op when nothing is stored", async () => {
    const s = await store();
    s.clearReadAnchor("never");
    expect(mem["vh.scroll.v2"]).toBeUndefined();
  });

  it("clearReadAnchors drops many at once (archive prune)", async () => {
    const s = await store();
    s.setReadAnchor("s1", "m5");
    s.setReadAnchor("s2", "m9");
    s.setReadAnchor("s3", "m2");
    s.clearReadAnchors(["s1", "s3", "missing"]);
    expect(s.getReadAnchor("s1")).toBeUndefined();
    expect(s.getReadAnchor("s2")).toBe("m9");
    expect(s.getReadAnchor("s3")).toBeUndefined();
  });

  it("ignores + cleans up a legacy px-offset store (vh.scroll.v1) on load", async () => {
    // Seed a legacy px-offset value under the old key BEFORE the import-time
    // cleanup runs.
    mem["vh.scroll.v1"] = JSON.stringify({ v: 1, data: { s1: 12345 } });
    const s = await store(); // import triggers the legacy cleanup
    // A legacy px offset is meaningless as a message anchor → no anchor (bottom).
    expect(s.getReadAnchor("s1")).toBeUndefined();
    // The legacy key is cleaned up on load.
    expect(mem["vh.scroll.v1"]).toBeUndefined();
  });

  it("survives a corrupt legacy payload without throwing", async () => {
    mem["vh.scroll.v1"] = "{not json";
    const s = await store();
    expect(s.getReadAnchor("s1")).toBeUndefined();
    expect(mem["vh.scroll.v1"]).toBeUndefined(); // still removed
  });
});

describe("bottommostRead (pure geometry helper)", () => {
  it("returns undefined when nothing has scrolled past the top", () => {
    // All rows still below the viewport top (positive deltas).
    expect(bottommostRead([{ id: "m1", top: 40 }, { id: "m2", top: 200 }])).toBeUndefined();
  });

  it("returns the single row at/above the top", () => {
    expect(bottommostRead([{ id: "m1", top: -300 }])).toBe("m1");
  });

  it("returns the bottommost read-through row (the last with top <= 0)", () => {
    expect(
      bottommostRead([
        { id: "m1", top: -800 },
        { id: "m2", top: -400 },
        { id: "m3", top: 0 }, // pinned at the viewport top → counts as read
        { id: "m4", top: 160 }, // below the top → not read yet
      ]),
    ).toBe("m3");
  });

  it("treats a row exactly at the top (top === 0) as read-through", () => {
    expect(bottommostRead([{ id: "m1", top: 0 }, { id: "m2", top: 100 }])).toBe("m1");
  });

  it("stops at the first row below the top (document-order assumption)", () => {
    // The scan breaks at the first positive top; a later out-of-order <= 0 row
    // is never reached (rows are assumed in document order, which the caller
    // guarantees by iterating messages() in order).
    expect(
      bottommostRead([
        { id: "m1", top: -100 },
        { id: "m2", top: 50 }, // first below the top → stop
        { id: "m3", top: -10 }, // would-be match ignored (document order)
      ]),
    ).toBe("m1");
  });

  it("returns undefined for an empty list", () => {
    expect(bottommostRead([])).toBeUndefined();
  });
});
