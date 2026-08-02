// @vitest-environment jsdom
//
// Focus: the cross-project count-staleness fix + the P2 single-source change.
// fetchProjectActivity feeds the project-switch dialog's per-project root/
// running counts; counts must reflect CURRENT backend state at dialog-open
// time, not a stale browser/intermediary HTTP cache. This pins (1) the SINGLE
// endpoint it hits (/vh/projects — P2 made it the authoritative source for BOTH
// roots and running per project, replacing the former /vh/projects +
// /vh/running-sessions pair) and (2) the cache:'no-store' option on the fetch —
// the client-side belt-and-suspenders guard that complements the server's
// Cache-Control:no-store header.
//
// The pure merge/sort logic is covered by projects-merge.test.ts; this file
// covers ONLY the fetch-options / no-store behavior of fetchProjectActivity and
// that the running map is populated from the /vh/projects payload.
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchProjectActivity } from "../../src/projects";

function jsonResp(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => "" };
}

describe("fetchProjectActivity — single-source /vh/projects (P2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hits ONLY /vh/projects (no longer fetches /vh/running-sessions)", async () => {
    // P2: per-project running now comes from /vh/projects itself. The switcher
    // no longer fetches /vh/running-sessions (that endpoint still serves the
    // cross-fleet restart warning — RestartOpenCode/OpenCodeHealthPanel — which
    // are separate consumers and fetch it themselves).
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/vh/projects"))
        return Promise.resolve(jsonResp([{ dir: "/a", roots: 1, running: 0, runningRoots: 0, unreadRoots: 0 }]));
      return Promise.resolve(jsonResp(null, false, 404));
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchProjectActivity();

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("/vh/projects"))).toBe(true);
    expect(urls.some((u) => u.includes("/vh/running-sessions"))).toBe(false);
    expect(urls).toHaveLength(1); // exactly one fetch
  });

  it("passes cache:'no-store' on /vh/projects (defeats stale browser cache)", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/vh/projects")) {
        // The assertion lives here so a future caller that drops the option is
        // caught at the exact call site.
        expect((init as RequestInit | undefined)?.cache).toBe("no-store");
        return Promise.resolve(jsonResp([{ dir: "/a", roots: 1, running: 0, runningRoots: 0, unreadRoots: 0 }]));
      }
      return Promise.resolve(jsonResp(null, false, 404));
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchProjectActivity();
    // Sanity: the /vh/projects call actually happened (otherwise the inline
    // expect above never ran and the test would silently pass).
    expect(
      fetchMock.mock.calls.some(([u]) => (u as string).includes("/vh/projects")),
    ).toBe(true);
  });

  it("populates BOTH roots and running maps from the /vh/projects payload", async () => {
    // P2: /vh/projects is the single authoritative source for both counts per
    // dir. The running map must reflect each dir's running value verbatim.
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResp([
          { dir: "/a", roots: 5, running: 2, runningRoots: 2, unreadRoots: 1 },
          { dir: "/b", roots: 3, running: 0, runningRoots: 0, unreadRoots: 0 },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const maps = await fetchProjectActivity();
    expect(maps.roots.get("/a")).toBe(5);
    expect(maps.roots.get("/b")).toBe(3);
    expect(maps.running.get("/a")).toBe(2);
    expect(maps.running.get("/b")).toBe(0);
    // unread map mirrors the payload verbatim (subset of roots − running).
    expect(maps.unread.get("/a")).toBe(1);
    expect(maps.unread.get("/b")).toBe(0);
  });

  it("never throws — returns empty maps on fetch failure (dialog still renders)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );

    const maps = await fetchProjectActivity();
    expect(maps.roots.size).toBe(0);
    expect(maps.running.size).toBe(0);
  });
});
