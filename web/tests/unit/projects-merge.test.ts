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
// Covers: merge by dir, active-marker correctness, running-count assignment,
// and the sort order (running-first, then case-insensitive name).

const P = (directory: string, name?: string): Project => ({
  directory,
  name: name ?? directory,
});

const empty: ActivityMaps = { sessions: new Map(), running: new Map() };

describe("buildActivityMaps", () => {
  it("builds dir->count maps from both endpoints", () => {
    const maps = buildActivityMaps(
      [{ dir: "/a", sessions: 2 }, { dir: "/b", sessions: 5 }],
      { count: 1, workspaces: [{ dir: "/a", count: 1 }] },
    );
    expect(maps.sessions.get("/a")).toBe(2);
    expect(maps.sessions.get("/b")).toBe(5);
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

  it("uses live store counts for the active dir and endpoint counts for others", () => {
    const maps: ActivityMaps = {
      sessions: new Map([["/a", 9], ["/b", 4]]),
      running: new Map([["/a", 7], ["/b", 0]]),
    };
    // active = /b -> live values win (3/2), NOT the endpoint's 4/0.
    const rows = mergeProjectActivity([P("/a"), P("/b")], maps, "/b", 2, 3);
    const byDir = Object.fromEntries(rows.map((r) => [r.directory, r]));
    expect(byDir["/a"].sessions).toBe(9);
    expect(byDir["/a"].running).toBe(7);
    expect(byDir["/b"].sessions).toBe(3); // live, not 4
    expect(byDir["/b"].running).toBe(2); // live, not 0
    expect(byDir["/b"].active).toBe(true);
  });

  it("falls back to 0 when a dir has no endpoint data", () => {
    const rows = mergeProjectActivity([P("/unknown")], empty, "", 0, 0);
    expect(rows[0].sessions).toBe(0);
    expect(rows[0].running).toBe(0);
  });

  it("sorts running projects first, then by name case-insensitively", () => {
    const maps: ActivityMaps = {
      sessions: new Map(),
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
      sessions: new Map(),
      running: new Map([["/busy", 1]]),
    };
    const rows = mergeProjectActivity([P("/active", "active"), P("/busy", "busy")], maps, "/active", 0, 0);
    expect(rows[0].name).toBe("busy");
    expect(rows[0].active).toBe(false);
    expect(rows[1].name).toBe("active");
    expect(rows[1].active).toBe(true);
  });

  it("default project (empty dir) participates like any other row", () => {
    const maps: ActivityMaps = { sessions: new Map([["", 3]]), running: new Map() };
    const rows = mergeProjectActivity([P("", "Default project"), P("/x", "x")], maps, "", 0, 0);
    // active default uses live counts (0), not the endpoint's 3
    const def = rows.find((r) => r.directory === "")!;
    expect(def.active).toBe(true);
    expect(def.sessions).toBe(0);
    expect(def.running).toBe(0);
    // non-active x has no endpoint data -> 0
    expect(rows.find((r) => r.directory === "/x")!.sessions).toBe(0);
  });

  it("is case-insensitive on names but preserves the original display name", () => {
    const rows = mergeProjectActivity([P("/b", "Beta"), P("/a", "alpha")], empty, "", 0, 0);
    expect(rows.map((r) => r.name)).toEqual(["alpha", "Beta"]);
  });
});
