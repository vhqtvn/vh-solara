import { describe, expect, it } from "vitest";
import {
  ActivityMaps,
  mergeProjectActivity,
  Project,
  withActiveProject,
} from "../../src/projects";

// Pure-logic tests for withActiveProject — the helper that injects the active
// project into the pinned list when it isn't pinned. No DOM, no signals: the
// inputs are the pinned Project[] and the active dir string. Covers: the
// synthesized-row case (active not pinned), the no-op cases (empty active dir,
// already-pinned active), the synthesized name = basename(activeDir), trailing-
// slash normalization, and that the input array is returned by reference in the
// no-op cases (callers can rely on identity when nothing changed).
//
// This is the unit-test layer for the regression fix where the Project Switcher
// trigger + dialog dropped a unpinned active project (introduced when the
// synthetic DEFAULT project was removed; the old `|| projects()[0]` fallback
// stopped resolving once the default was gone). The companion assertion that
// mergeProjectActivity then marks the synthesized row active lives in
// projects-merge.test.ts (the merge is unchanged — it just sees a longer pinned
// list — so its existing "marks exactly the active directory as active" test
// already covers the marking path).

const P = (directory: string, name?: string): Project => ({
  directory,
  name: name ?? directory,
});

describe("withActiveProject", () => {
  it("injects a synthesized entry when the active dir is NOT pinned", () => {
    const out = withActiveProject([P("/a"), P("/b")], "/c");
    expect(out.map((p) => p.directory)).toEqual(["/a", "/b", "/c"]);
    // Synthesized at the END (not sorted in — the switcher's merge + sort runs
    // downstream and decides order; this helper only shapes the list).
    expect(out[2]).toEqual({ directory: "/c", name: "c" });
  });

  it("derives the synthesized name from basename(activeDir)", () => {
    // basename strips trailing slashes for the NAME only. The DIRECTORY is
    // preserved as-is so downstream lookups (current()'s
    // `p.directory === projectDir()`, mergeProjectActivity's exact-dir active
    // marker) still match — withActiveProject does NOT normalize the dir
    // (callers' normalize step, or its absence, is honored).
    const out = withActiveProject([], "/home/you/solara/");
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ directory: "/home/you/solara/", name: "solara" });
  });

  it("returns pinned UNCHANGED (by reference) when active dir is empty", () => {
    // The no-project state: projectDir("") must NOT synthesize a row, otherwise
    // we'd reintroduce the synthetic-cwd-bridge that the DEFAULT removal fixed.
    const pinned = [P("/a")];
    expect(withActiveProject(pinned, "")).toBe(pinned);
    expect(withActiveProject([], "")).toEqual([]);
  });

  it("returns pinned UNCHANGED (by reference) when active dir is already pinned", () => {
    // No duplicate row when the active project is in the pinned list — the
    // common case (user opened the switcher from a pinned project).
    const pinned = [P("/a"), P("/b")];
    expect(withActiveProject(pinned, "/a")).toBe(pinned);
    expect(withActiveProject(pinned, "/b")).toBe(pinned);
  });

  it("does not duplicate when the active dir matches a pinned dir up to trailing slashes", () => {
    // addProject normalizes trailing slashes on pin ("/x" not "/x/"), and
    // switchProject persists projectDir via the same normalize path, so a pinned
    // "/a" should suppress synthesis for activeDir "/a". (If a caller ever
    // passed an un-normalized active dir, we'd get a duplicate — but that's a
    // caller bug, not this helper's job to paper over. This test pins the
    // contract: exact-string compare, no normalization on the lookup.)
    const pinned = [P("/a")];
    expect(withActiveProject(pinned, "/a")).toBe(pinned);
    // Un-normalized activeDir with a trailing slash does NOT match "/a" here —
    // it synthesizes a new row. Documented behavior; callers normalize first.
    const out = withActiveProject(pinned, "/a/");
    expect(out).toHaveLength(2);
  });

  it("handles a single-segment path (no slashes) by returning it as the basename", () => {
    // basename("solara") === "solara"; the synthesized name is the dir itself.
    const out = withActiveProject([], "solara");
    expect(out[0]).toEqual({ directory: "solara", name: "solara" });
  });

  it("does not mutate the input pinned array", () => {
    const pinned = [P("/a")];
    const out = withActiveProject(pinned, "/b");
    // Input is untouched; the result is a NEW array (concat-style spread).
    expect(pinned).toEqual([P("/a")]);
    expect(pinned).toHaveLength(1);
    expect(out).not.toBe(pinned);
  });

  it("end-to-end: a unpinned active project becomes a row that mergeProjectActivity marks active", () => {
    // The reason this helper exists: shape the pinned list so the downstream
    // merge (which marks `p.directory === activeDir` as active) sees the
    // synthesized row. Re-asserting the merge contract here would duplicate
    // projects-merge.test.ts; instead we verify the SHAPE that makes the merge
    // mark the synthesized row active: the active dir is present in the output,
    // then the merge marks it active.
    const shaped = withActiveProject([], "/home/you/solara");
    const empty: ActivityMaps = { roots: new Map(), running: new Map() };
    const rows = mergeProjectActivity(shaped, empty, "/home/you/solara", 0, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].directory).toBe("/home/you/solara");
    expect(rows[0].name).toBe("solara");
    expect(rows[0].active).toBe(true);
  });
});
