import { describe, expect, it } from "vitest";
import {
  ActivityMaps,
  Project,
  buildActivityMaps,
  mergeProjectActivity,
} from "../../src/projects";

// Pure-logic tests for the project switcher's merge + sort. No DOM: the inputs
// are the locally-pinned list and the single backend activity payload (/vh/
// projects, which keys by exact project directory and now carries BOTH roots +
// running per dir). Covers: map build from the one endpoint, active-marker
// correctness, running/idle assignment (idle = max(0, roots − running),
// root-scoped), the idle-never-negative guard, the uniform (no active special-
// case) count source after P2, and the sort order (running-first, then case-
// insensitive name).

const P = (directory: string, name?: string): Project => ({
  directory,
  name: name ?? directory,
});

const empty: ActivityMaps = { roots: new Map(), running: new Map() };

describe("buildActivityMaps", () => {
  it("builds dir->count maps from the /vh/projects payload (roots + running)", () => {
    const maps = buildActivityMaps([
      { dir: "/a", roots: 2, running: 1 },
      { dir: "/b", roots: 5, running: 0 },
    ]);
    expect(maps.roots.get("/a")).toBe(2);
    expect(maps.roots.get("/b")).toBe(5);
    expect(maps.running.get("/a")).toBe(1);
    expect(maps.running.get("/b")).toBe(0); // kept verbatim, including 0
  });

  it("keeps every dir's running value verbatim (including 0, no omission)", () => {
    // P2: running now comes from /vh/projects per-dir, not /vh/running-sessions
    // (which omitted idle dirs). Every dir present in the payload lands in the
    // running map with its true count, including 0.
    const maps = buildActivityMaps([
      { dir: "/x", roots: 1, running: 0 },
      { dir: "/y", roots: 2, running: 2 },
      { dir: "/z", roots: 3, running: 3 },
    ]);
    expect(maps.running.get("/x")).toBe(0);
    expect(maps.running.get("/y")).toBe(2);
    expect(maps.running.get("/z")).toBe(3);
  });

  it("tolerates missing/malformed payloads (empty maps, never throws)", () => {
    expect(buildActivityMaps([])).toEqual(empty);
    expect(buildActivityMaps(null as any)).toEqual(empty);
    expect(buildActivityMaps(undefined as any)).toEqual(empty);
  });
});

describe("mergeProjectActivity", () => {
  it("marks exactly the active directory as active", () => {
    const rows = mergeProjectActivity([P("/a"), P("/b"), P("/c")], empty, "/b");
    const active = rows.filter((r) => r.active);
    expect(active).toHaveLength(1);
    expect(active[0].directory).toBe("/b");
  });

  it("derives idle = roots − running (root-scoped) for every row", () => {
    // /a: 5 roots, 2 running → idle 3. /b: 1 root, 0 running → idle 1.
    const maps: ActivityMaps = {
      roots: new Map([["/a", 5], ["/b", 1]]),
      running: new Map([["/a", 2], ["/b", 0]]),
    };
    const rows = mergeProjectActivity([P("/a"), P("/b")], maps, "/not-active");
    const byDir = Object.fromEntries(rows.map((r) => [r.directory, r]));
    expect(byDir["/a"].running).toBe(2);
    expect(byDir["/a"].idle).toBe(3);
    expect(byDir["/b"].running).toBe(0);
    expect(byDir["/b"].idle).toBe(1);
  });

  it("never reports a negative idle when running > roots (transient endpoint race)", () => {
    // /a claims 1 root but 3 running (a race between successive /vh/projects
    // GETs, or a count that briefly inverts). idle must clamp to 0, never -2.
    const maps: ActivityMaps = {
      roots: new Map([["/a", 1]]),
      running: new Map([["/a", 3]]),
    };
    const rows = mergeProjectActivity([P("/a")], maps, "/x");
    expect(rows[0].running).toBe(3);
    expect(rows[0].idle).toBe(0);
  });

  it("uses server-authoritative endpoint counts UNIFORMLY (active project NOT special-cased)", () => {
    // P2: the active project no longer re-derives counts from the live client
    // store. EVERY row — active included — reads roots/running from the
    // /vh/projects maps. Active /b uses the endpoint's 4 roots / 0 running
    // (idle 4), exactly like non-active /a uses 9 roots / 7 running (idle 2).
    const maps: ActivityMaps = {
      roots: new Map([["/a", 9], ["/b", 4]]),
      running: new Map([["/a", 7], ["/b", 0]]),
    };
    const rows = mergeProjectActivity([P("/a"), P("/b")], maps, "/b");
    const byDir = Object.fromEntries(rows.map((r) => [r.directory, r]));
    expect(byDir["/a"].running).toBe(7);
    expect(byDir["/a"].idle).toBe(2); // 9 − 7
    expect(byDir["/b"].running).toBe(0); // endpoint value, not a live-store override
    expect(byDir["/b"].idle).toBe(4); // endpoint roots 4 − running 0
    expect(byDir["/b"].active).toBe(true);
  });

  it("falls back to 0/0 when a dir has no endpoint data (roots unknown)", () => {
    const rows = mergeProjectActivity([P("/unknown")], empty, "");
    expect(rows[0].running).toBe(0);
    expect(rows[0].idle).toBe(0);
  });

  it("sorts running projects first, then by name case-insensitively", () => {
    const maps: ActivityMaps = {
      roots: new Map(),
      running: new Map([
        ["/apple", 1],
        ["/zebra", 1],
      ]),
    };
    const rows = mergeProjectActivity(
      [
        P("/banana", "Banana"),
        P("/apple", "apple"),
        P("/zebra", "zebra"),
        P("/cherry", "cherry"),
        P("/Delta", "Delta"),
      ],
      maps,
      "/banana",
    );
    // Running first (apple < zebra), then non-running by case-insensitive name
    // (banana < cherry < delta). The active project (Banana) sorts on its name,
    // not pinned to the top.
    expect(rows.map((r) => r.name)).toEqual(["apple", "zebra", "Banana", "cherry", "Delta"]);
  });

  it("keeps the active marker wherever the active project lands in the sort", () => {
    // Active is quiet but a running project exists -> active is NOT first.
    const maps: ActivityMaps = {
      roots: new Map(),
      running: new Map([["/busy", 1]]),
    };
    const rows = mergeProjectActivity([P("/active", "active"), P("/busy", "busy")], maps, "/active");
    expect(rows[0].name).toBe("busy");
    expect(rows[0].active).toBe(false);
    expect(rows[1].name).toBe("active");
    expect(rows[1].active).toBe(true);
  });

  it("default project (empty dir) participates like any other row", () => {
    // P2: the active default reads its counts from the endpoint like every
    // other row (3 roots, 0 running → idle 3), NOT a live-store 0/0 override.
    const maps: ActivityMaps = { roots: new Map([["", 3]]), running: new Map([["", 0]]) };
    const rows = mergeProjectActivity([P("", "Default project"), P("/x", "x")], maps, "");
    const def = rows.find((r) => r.directory === "")!;
    expect(def.active).toBe(true);
    expect(def.running).toBe(0);
    expect(def.idle).toBe(3); // endpoint roots 3 − running 0
    // non-active x has no endpoint data -> 0/0
    expect(rows.find((r) => r.directory === "/x")!.idle).toBe(0);
  });

  it("is case-insensitive on names but preserves the original display name", () => {
    const rows = mergeProjectActivity([P("/b", "Beta"), P("/a", "alpha")], empty, "");
    expect(rows.map((r) => r.name)).toEqual(["alpha", "Beta"]);
  });

  it("does not expose a sessions field (dropped from the shape)", () => {
    const rows = mergeProjectActivity([P("/a")], empty, "");
    expect((rows[0] as any).sessions).toBeUndefined();
  });
});
