import { describe, expect, it } from "vitest";
import {
  ActivityMaps,
  Project,
  buildActivityMaps,
  mergeProjectActivity,
} from "../../src/projects";

// Pure-logic tests for the project switcher's merge + sort. No DOM: the inputs
// are the locally-pinned list and the two backend activity payloads (which key
// by exact project directory), plus live store counts for the active project.
// Covers: merge by dir, active-marker correctness, running/idle assignment
// (idle = max(0, roots − running), root-scoped), the idle-never-negative guard,
// the active project using live root/running counts, and the sort order
// (running-first, then case-insensitive name).

const P = (directory: string, name?: string): Project => ({
  directory,
  name: name ?? directory,
});

const empty: ActivityMaps = { roots: new Map(), running: new Map() };

describe("buildActivityMaps", () => {
  it("builds dir->count maps from both endpoints", () => {
    const maps = buildActivityMaps(
      [{ dir: "/a", roots: 2 }, { dir: "/b", roots: 5 }],
      { count: 1, workspaces: [{ dir: "/a", count: 1 }] },
    );
    expect(maps.roots.get("/a")).toBe(2);
    expect(maps.roots.get("/b")).toBe(5);
    expect(maps.running.get("/a")).toBe(1);
    expect(maps.running.has("/b")).toBe(false); // idle dirs absent
  });

  it("omits zero/negative running counts from the running map", () => {
    const maps = buildActivityMaps([], {
      count: 2,
      workspaces: [{ dir: "/x", count: 0 }, { dir: "/y", count: 2 }, { dir: "/z", count: 3 }],
    });
    expect(maps.running.has("/x")).toBe(false);
    expect(maps.running.get("/y")).toBe(2);
    expect(maps.running.get("/z")).toBe(3);
  });

  it("tolerates missing/malformed payloads (empty maps, never throws)", () => {
    expect(buildActivityMaps([] as any, { count: 0, workspaces: [] })).toEqual(empty);
    expect(buildActivityMaps(null as any, null as any)).toEqual(empty);
    expect(buildActivityMaps(undefined as any, { count: 0 } as any)).toEqual(empty);
  });
});

describe("mergeProjectActivity", () => {
  it("marks exactly the active directory as active", () => {
    const rows = mergeProjectActivity([P("/a"), P("/b"), P("/c")], empty, "/b", 0, 0);
    const active = rows.filter((r) => r.active);
    expect(active).toHaveLength(1);
    expect(active[0].directory).toBe("/b");
  });

  it("derives idle = roots − running (root-scoped) for non-active rows", () => {
    // /a: 5 roots, 2 running → idle 3. /b: 1 root, 0 running → idle 1.
    const maps: ActivityMaps = {
      roots: new Map([["/a", 5], ["/b", 1]]),
      running: new Map([["/a", 2]]),
    };
    const rows = mergeProjectActivity([P("/a"), P("/b")], maps, "/not-active", 0, 0);
    const byDir = Object.fromEntries(rows.map((r) => [r.directory, r]));
    expect(byDir["/a"].running).toBe(2);
    expect(byDir["/a"].idle).toBe(3);
    expect(byDir["/b"].running).toBe(0);
    expect(byDir["/b"].idle).toBe(1);
  });

  it("never reports a negative idle when running > roots (transient endpoint race)", () => {
    // /a claims 1 root but 3 running (a race between /vh/projects and
    // /vh/running-sessions). idle must clamp to 0, never -2.
    const maps: ActivityMaps = {
      roots: new Map([["/a", 1]]),
      running: new Map([["/a", 3]]),
    };
    const rows = mergeProjectActivity([P("/a")], maps, "/x", 0, 0);
    expect(rows[0].running).toBe(3);
    expect(rows[0].idle).toBe(0);
  });

  it("uses live store counts for the active dir and endpoint counts for others", () => {
    const maps: ActivityMaps = {
      roots: new Map([["/a", 9], ["/b", 4]]),
      running: new Map([["/a", 7], ["/b", 0]]),
    };
    // active = /b -> live values win (running 2, roots 3 → idle 1), NOT the
    // endpoint's 4 roots / 0 running (which would give idle 4).
    const rows = mergeProjectActivity([P("/a"), P("/b")], maps, "/b", 2, 3);
    const byDir = Object.fromEntries(rows.map((r) => [r.directory, r]));
    expect(byDir["/a"].running).toBe(7);
    expect(byDir["/a"].idle).toBe(2); // 9 − 7
    expect(byDir["/b"].running).toBe(2); // live, not 0
    expect(byDir["/b"].idle).toBe(1); // live roots 3 − running 2, not 4
    expect(byDir["/b"].active).toBe(true);
  });

  it("falls back to 0/0 when a dir has no endpoint data (roots unknown)", () => {
    const rows = mergeProjectActivity([P("/unknown")], empty, "", 0, 0);
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
      0,
      0,
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
    const rows = mergeProjectActivity([P("/active", "active"), P("/busy", "busy")], maps, "/active", 0, 0);
    expect(rows[0].name).toBe("busy");
    expect(rows[0].active).toBe(false);
    expect(rows[1].name).toBe("active");
    expect(rows[1].active).toBe(true);
  });

  it("default project (empty dir) participates like any other row", () => {
    const maps: ActivityMaps = { roots: new Map([["", 3]]), running: new Map() };
    const rows = mergeProjectActivity([P("", "Default project"), P("/x", "x")], maps, "", 0, 0);
    // active default uses live counts (0 roots, 0 running → idle 0), not the
    // endpoint's 3 roots.
    const def = rows.find((r) => r.directory === "")!;
    expect(def.active).toBe(true);
    expect(def.running).toBe(0);
    expect(def.idle).toBe(0);
    // non-active x has no endpoint data -> 0/0
    expect(rows.find((r) => r.directory === "/x")!.idle).toBe(0);
  });

  it("is case-insensitive on names but preserves the original display name", () => {
    const rows = mergeProjectActivity([P("/b", "Beta"), P("/a", "alpha")], empty, "", 0, 0);
    expect(rows.map((r) => r.name)).toEqual(["alpha", "Beta"]);
  });

  it("does not expose a sessions field (dropped from the shape)", () => {
    const rows = mergeProjectActivity([P("/a")], empty, "", 0, 0);
    expect((rows[0] as any).sessions).toBeUndefined();
  });
});
