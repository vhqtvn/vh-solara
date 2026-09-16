import { afterEach, describe, expect, it, vi } from "vitest";
import { Project, fetchRecentProjects, unionBridgedProjects } from "../../src/projects";

// Pure-logic tests for the recents UNION (unionBridgedProjects) + the two-leg
// fetchRecentProjects wiring. Mission: any dir bridged by ANY client of this
// worker (GET /vh/projects, dir verbatim) must appear in every other client's
// "Recent (OpenCode)" list even when OpenCode itself never recorded a project
// row (GET /oc/project, keyed by worktree — a zero-commit repo like vy-homestay
// buckets to the "global" projectID and gets NO row). The union must never
// duplicate recorded rows (exact match + the worktree-containment mismatch: a
// bridged SUBDIR of a listed worktree), must skip the daemon's synthetic
// default (dir ""), and each leg must degrade independently. No DOM needed:
// the union is pure, and the fetch legs are exercised with a stubbed global
// fetch (node env, matching projects-merge.test.ts's import of src/projects).

const P = (directory: string, name?: string): Project => ({
  directory,
  name: name ?? directory,
});

function resp(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => "",
  } as unknown as Response;
}

describe("unionBridgedProjects", () => {
  it("appends bridged-but-unrecorded dirs AFTER the recorded recents, alphabetical", () => {
    // Recorded recents arrive most-recent-first; bridged-only rows have no
    // updated timestamp, so they go after them in a deterministic (alpha) order.
    const out = unionBridgedProjects([P("/rec/zeta"), P("/rec/alpha")], ["/b/yy", "/b/mm"]);
    expect(out.map((p) => p.directory)).toEqual(["/rec/zeta", "/rec/alpha", "/b/mm", "/b/yy"]);
  });

  it("vy-homestay repro: a bridged dir OpenCode never recorded becomes a Recent row", () => {
    // Zero-commit repo → no /oc/project row → invisible pre-union. The union
    // guarantees cross-client visibility from the /vh/projects leg alone.
    const out = unionBridgedProjects([], ["/home/you/vy-homestay"]);
    expect(out).toEqual([{ directory: "/home/you/vy-homestay", name: "vy-homestay" }]);
  });

  it("names bridged-only rows by basename(dir)", () => {
    const out = unionBridgedProjects([], ["/work/deep/nested/proj"]);
    expect(out[0].name).toBe("proj");
  });

  it("no duplicate for an exact dir match (after trailing-slash normalization)", () => {
    // /vh/projects carries the bridged dir verbatim; /oc/project keys by
    // worktree. "/w/repo/" and "/w/repo" are the same target — one row.
    const out = unionBridgedProjects([P("/w/repo")], ["/w/repo", "/w/repo/"]);
    expect(out).toHaveLength(1);
    expect(out[0].directory).toBe("/w/repo");
  });

  it("no near-duplicate for a bridged SUBDIR of a recorded worktree (containment)", () => {
    // The named dedupe hazard: /oc/project lists the worktree /w/monorepo,
    // a client bridged /w/monorepo/packages/web. The recorded row already
    // covers that tree — the bridged subdir must not add a second row.
    const out = unionBridgedProjects([P("/w/monorepo")], ["/w/monorepo/packages/web"]);
    expect(out).toEqual([P("/w/monorepo")]);
  });

  it("containment is directory-boundary-aware: a sibling sharing the prefix is NOT a duplicate", () => {
    // "/w/repo-2" shares the "/w/repo" prefix but is a SIBLING, not a child.
    const out = unionBridgedProjects([P("/w/repo")], ["/w/repo-2"]);
    expect(out.map((p) => p.directory)).toEqual(["/w/repo", "/w/repo-2"]);
  });

  it("keeps a bridged ANCESTOR of a recorded recent (documented rule)", () => {
    // Reverse containment is NOT skipped: a bridged dir that CONTAINS a listed
    // worktree is a genuinely broader scope OpenCode never recorded — hiding it
    // would re-create the visibility gap this union exists to close.
    const out = unionBridgedProjects([P("/w/mono/pkg/web")], ["/w/mono"]);
    expect(out.map((p) => p.directory)).toEqual(["/w/mono/pkg/web", "/w/mono"]);
  });

  it("skips the daemon's synthetic default (dir \"\")", () => {
    const out = unionBridgedProjects([], ["", "/w/real"]);
    expect(out.map((p) => p.directory)).toEqual(["/w/real"]);
  });

  it("dedupes within the bridged payload itself", () => {
    const out = unionBridgedProjects([], ["/a/x", "/a/x/", "/a/y"]);
    expect(out.map((p) => p.directory)).toEqual(["/a/x", "/a/y"]);
  });

  it("degrades to the recorded list unchanged on an empty/missing bridged payload", () => {
    // Daemon-restart window: /vh/projects is empty (or the leg failed → []).
    // Recents render exactly as pre-union.
    const recents = [P("/r/a"), P("/r/b")];
    expect(unionBridgedProjects(recents, [])).toEqual(recents);
    expect(unionBridgedProjects(recents, undefined as unknown as string[])).toEqual(recents);
    expect(unionBridgedProjects(recents, null as unknown as string[])).toEqual(recents);
  });

  it("skips malformed entries in the bridged payload (non-string dir)", () => {
    const out = unionBridgedProjects([], [42 as unknown as string, "/w/ok"]);
    expect(out.map((p) => p.directory)).toEqual(["/w/ok"]);
  });
});

describe("fetchRecentProjects (two legs + union)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("unions bridged dirs into the recorded recents", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/projects"))
          return Promise.resolve(
            resp([
              { dir: "/home/you/vy-homestay", roots: 1, running: 0, runningRoots: 0, unreadRoots: 0 },
              { dir: "/rec/alpha", roots: 0, running: 0, runningRoots: 0, unreadRoots: 0 },
            ]),
          );
        if (url.includes("/oc/project"))
          return Promise.resolve(resp([{ worktree: "/rec/alpha", name: "alpha" }]));
        return Promise.resolve(resp({}, false, 404));
      }),
    );
    const out = await fetchRecentProjects();
    // Recorded row first (durable leg), bridged-only row appended; the bridged
    // copy of /rec/alpha must NOT duplicate the recorded row.
    expect(out).toEqual([
      { directory: "/rec/alpha", name: "alpha" },
      { directory: "/home/you/vy-homestay", name: "vy-homestay" },
    ]);
  });

  it("/vh/projects failure degrades to the recorded recents alone (pre-union behavior)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/projects")) return Promise.reject(new Error("daemon restarting"));
        if (url.includes("/oc/project"))
          return Promise.resolve(resp([{ worktree: "/rec/a", name: "a" }]));
        return Promise.resolve(resp({}, false, 404));
      }),
    );
    const out = await fetchRecentProjects();
    expect(out).toEqual([{ directory: "/rec/a", name: "a" }]);
  });

  it("/vh/projects non-OK / non-array degrades to the recorded recents alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/vh/projects") return Promise.resolve(resp({}, false, 500));
        if (url.includes("/oc/project"))
          return Promise.resolve(resp([{ worktree: "/rec/a", name: "a" }]));
        return Promise.resolve(resp({}, false, 404));
      }),
    );
    expect(await fetchRecentProjects()).toEqual([{ directory: "/rec/a", name: "a" }]);
  });

  it("/oc/project failure still surfaces bridged dirs (the mission leg stands alone)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/projects"))
          return Promise.resolve(resp([{ dir: "/home/you/vy-homestay", roots: 0 }]));
        if (url.includes("/oc/project")) return Promise.resolve(resp({}, false, 500));
        return Promise.resolve(resp({}, false, 404));
      }),
    );
    const out = await fetchRecentProjects();
    expect(out).toEqual([{ directory: "/home/you/vy-homestay", name: "vy-homestay" }]);
  });
});
