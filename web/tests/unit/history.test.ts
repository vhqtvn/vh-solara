// Pure-API coverage for the session-aware prompt-history store (slice B).
//
// history.ts keeps module-level caches (the global `hist` array and a per-
// session Map) that load once at import time via loadVersioned. To isolate each
// case we clear the in-memory localStorage and reset the module registry in
// beforeEach, then dynamically re-import so history.ts re-runs its module-level
// loadVersioned against the clean store.
//
// Contract under test (see the header comment in src/history.ts):
//   - GLOBAL store (vh.prompt.history.v1): Ctrl/Cmd+Up recall. Legacy data
//     written before the split stays Ctrl+Up-recallable with NO migration.
//   - PER-SESSION store (vh.prompt.history.session.<sid>.v1): plain Up recall,
//     isolated per session. Draft sessions use the "__new__" pseudo-key.
//   - pushHistory(text, sid?) writes to BOTH stores when sid is given, so the
//     per-session store is always a subset of global.

import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory localStorage for the node test env (history.ts → loadVersioned/
// saveVersioned read/write here).
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

type HistoryMod = typeof import("../../src/history");
let H: HistoryMod;

beforeEach(async () => {
  for (const k of Object.keys(mem)) delete mem[k];
  vi.resetModules();
  H = await import("../../src/history");
});

const GKEY = "vh.prompt.history.v1";
const skey = (sid: string) => `vh.prompt.history.session.${sid}.v1`;
const envelope = (data: unknown) => JSON.stringify({ v: 1, data });

describe("prompt history — global vs per-session split", () => {
  it("pushHistory(text) without sessionId writes GLOBAL only", () => {
    H.pushHistory("hello");
    expect(H.historyLen()).toBe(1);
    expect(H.historyAt(0)).toBe("hello");
    // No per-session store touched.
    expect(H.historyLen("s1")).toBe(0);
    expect(H.historyAt(0, "s1")).toBeUndefined();
    expect(mem[skey("s1")]).toBeUndefined();
  });

  it("pushHistory(text, sid) writes BOTH global and the named session", () => {
    H.pushHistory("hi", "s1");
    expect(H.historyLen()).toBe(1); // global
    expect(H.historyAt(0)).toBe("hi");
    expect(H.historyLen("s1")).toBe(1); // session
    expect(H.historyAt(0, "s1")).toBe("hi");
    // The session store is persisted under its own versioned key.
    expect(mem[skey("s1")]).toEqual(envelope(["hi"]));
    expect(mem[GKEY]).toEqual(envelope(["hi"]));
  });

  it("per-session stores are isolated across sessions", () => {
    H.pushHistory("a1", "s1");
    H.pushHistory("b1", "s2");
    // s1 has only a1; s2 has only b1.
    expect(H.historyLen("s1")).toBe(1);
    expect(H.historyAt(0, "s1")).toBe("a1");
    expect(H.historyLen("s2")).toBe(1);
    expect(H.historyAt(0, "s2")).toBe("b1");
    // Global has both (pushHistory always writes global), most-recent first.
    expect(H.historyLen()).toBe(2);
    expect(H.historyAt(0)).toBe("b1");
    expect(H.historyAt(1)).toBe("a1");
  });

  it("the per-session store is a subset of global (global-only pushes don't reach a session)", () => {
    H.pushHistory("shared", "s1");
    H.pushHistory("global-only"); // no sid → global only
    // s1 has just "shared"; global has both, most-recent first.
    expect(H.historyLen("s1")).toBe(1);
    expect(H.historyAt(0, "s1")).toBe("shared");
    expect(H.historyLen()).toBe(2);
    expect(H.historyAt(0)).toBe("global-only");
    expect(H.historyAt(1)).toBe("shared");
  });

  it("a draft session uses the '__new__' pseudo-key, distinct from a real session", () => {
    H.pushHistory("draft-prompt", "__new__");
    H.pushHistory("real-prompt", "session-real");
    expect(H.historyLen("__new__")).toBe(1);
    expect(H.historyAt(0, "__new__")).toBe("draft-prompt");
    expect(H.historyLen("session-real")).toBe(1);
    expect(H.historyAt(0, "session-real")).toBe("real-prompt");
    // The two stores live under separate keys.
    expect(mem[skey("__new__")]).toEqual(envelope(["draft-prompt"]));
    expect(mem[skey("session-real")]).toEqual(envelope(["real-prompt"]));
  });

  it("dedups, orders most-recent-first, and caps at MAX (100) in both stores", () => {
    for (let i = 0; i < 105; i++) H.pushHistory(`p${i}`, "s1");
    // Both stores capped at 100; the first five (p0..p4) were trimmed.
    expect(H.historyLen("s1")).toBe(100);
    expect(H.historyLen()).toBe(100);
    expect(H.historyAt(0, "s1")).toBe("p104");
    expect(H.historyAt(99, "s1")).toBe("p5");
    expect(H.historyAt(0)).toBe("p104");
    // Re-pushing an existing entry moves it to the front without growing.
    H.pushHistory("p100", "s1");
    expect(H.historyLen("s1")).toBe(100);
    expect(H.historyAt(0, "s1")).toBe("p100");
  });

  it("ignores empty / whitespace-only text", () => {
    H.pushHistory("   ", "s1");
    H.pushHistory("");
    expect(H.historyLen()).toBe(0);
    expect(H.historyLen("s1")).toBe(0);
    expect(mem[GKEY]).toBeUndefined();
    expect(mem[skey("s1")]).toBeUndefined();
  });

  it("historyAt returns undefined for out-of-range and negative indices", () => {
    H.pushHistory("only", "s1");
    expect(H.historyAt(-1)).toBeUndefined();
    expect(H.historyAt(1)).toBeUndefined();
    expect(H.historyAt(-1, "s1")).toBeUndefined();
    expect(H.historyAt(1, "s1")).toBeUndefined();
  });

  it("legacy global data (pre-split) remains Ctrl+Up-recallable with NO migration", async () => {
    // Simulate a pre-split install: only the global key exists, with two prompts.
    mem[GKEY] = envelope(["legacy-1", "legacy-2"]);
    vi.resetModules();
    const h: HistoryMod = await import("../../src/history");
    // Global reads the legacy data back as-is.
    expect(h.historyLen()).toBe(2);
    expect(h.historyAt(0)).toBe("legacy-1");
    expect(h.historyAt(1)).toBe("legacy-2");
    // Per-session stores start empty — old global prompts are NOT copied into
    // any session store (no migration, by design).
    expect(h.historyLen("s1")).toBe(0);
    expect(h.historyLen("__new__")).toBe(0);
  });

  it("persists per-session data across a module reload (re-hydration from localStorage)", async () => {
    H.pushHistory("persisted", "s1");
    expect(mem[skey("s1")]).toEqual(envelope(["persisted"]));
    // Re-load the module: the session cache re-hydrates from localStorage on
    // first access (sessionStore is lazy).
    vi.resetModules();
    const h: HistoryMod = await import("../../src/history");
    expect(h.historyLen("s1")).toBe(1);
    expect(h.historyAt(0, "s1")).toBe("persisted");
    // Global re-hydrates too (it loads eagerly at module top-level).
    expect(h.historyLen()).toBe(1);
    expect(h.historyAt(0)).toBe("persisted");
  });
});
