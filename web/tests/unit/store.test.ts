import { beforeEach, describe, expect, it } from "vitest";
import { loadVersioned, saveVersioned } from "../../src/lib/store";

// In-memory localStorage for the node test env.
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

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
});

describe("versioned localStorage", () => {
  it("round-trips data inside a {v,data} envelope", () => {
    saveVersioned("k", 1, { a: 1 });
    expect(JSON.parse(mem["k"])).toEqual({ v: 1, data: { a: 1 } });
    expect(loadVersioned("k", 1, null)).toEqual({ a: 1 });
  });

  it("returns the fallback when the key is missing", () => {
    expect(loadVersioned("missing", 1, "fb")).toBe("fb");
  });

  it("migrates a legacy plain-string value (fromVersion 0)", () => {
    mem["theme"] = "light"; // legacy raw string, not JSON
    const got = loadVersioned("theme", 1, "dark", (old, from) =>
      from === 0 && typeof old === "string" ? old : "dark",
    );
    expect(got).toBe("light");
  });

  it("migrates a legacy unversioned JSON value (fromVersion 0)", () => {
    mem["m"] = JSON.stringify({ foo: 1 });
    expect(loadVersioned("m", 1, null, (old) => old)).toEqual({ foo: 1 });
  });

  it("runs migrate across schema versions, else falls back", () => {
    mem["s"] = JSON.stringify({ v: 1, data: "old" });
    expect(loadVersioned("s", 2, "fb")).toBe("fb"); // no migrate fn → fallback
    expect(loadVersioned("s", 2, "fb", (old, from) => (from === 1 ? `${old}-migrated` : "fb"))).toBe(
      "old-migrated",
    );
  });

  it("falls back on corrupt JSON with no migrate", () => {
    mem["bad"] = "{not json"; // unparseable
    expect(loadVersioned("bad", 1, 42)).toBe(42);
  });
});
