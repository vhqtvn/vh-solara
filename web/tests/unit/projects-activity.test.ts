// @vitest-environment jsdom
//
// Focus: the cross-project count-staleness fix. fetchProjectActivity feeds the
// project-switch dialog's per-project session/root counts; counts must reflect
// CURRENT backend state at dialog-open time, not a stale browser/intermediary
// HTTP cache. This pins both the (1) endpoint pair it hits and (2) the
// cache:'no-store' option on each fetch — the client-side belt-and-suspenders
// guard that complements the server's Cache-Control:no-store header.
//
// The pure merge/sort logic is covered by projects-merge.test.ts; this file
// covers ONLY the fetch-options / no-store behavior of fetchProjectActivity.
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchProjectActivity } from "../../src/projects";

function jsonResp(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => "" };
}

describe("fetchProjectActivity — cross-project count staleness fix", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hits BOTH /vh/projects AND /vh/running-sessions", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/vh/projects"))
        return Promise.resolve(jsonResp([{ dir: "/a", roots: 1 }]));
      if (url.includes("/vh/running-sessions"))
        return Promise.resolve(jsonResp({ count: 0, workspaces: [] }));
      return Promise.resolve(jsonResp(null, false, 404));
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchProjectActivity();

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("/vh/projects"))).toBe(true);
    expect(urls.some((u) => u.includes("/vh/running-sessions"))).toBe(true);
  });

  it("passes cache:'no-store' on /vh/projects (defeats stale browser cache)", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/vh/projects")) {
        // The assertion lives here so a future caller that drops the option is
        // caught at the exact call site.
        expect((init as RequestInit | undefined)?.cache).toBe("no-store");
        return Promise.resolve(jsonResp([{ dir: "/a", roots: 1 }]));
      }
      return Promise.resolve(jsonResp({ count: 0, workspaces: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchProjectActivity();
    // Sanity: the /vh/projects call actually happened (otherwise the inline
    // expect above never ran and the test would silently pass).
    expect(
      fetchMock.mock.calls.some(([u]) =>
        (u as string).includes("/vh/projects"),
      ),
    ).toBe(true);
  });

  it("passes cache:'no-store' on /vh/running-sessions (defeats stale browser cache)", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/vh/running-sessions")) {
        expect((init as RequestInit | undefined)?.cache).toBe("no-store");
        return Promise.resolve(
          jsonResp({ count: 0, workspaces: [] }),
        );
      }
      return Promise.resolve(jsonResp([{ dir: "/a", roots: 1 }]));
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchProjectActivity();
    expect(
      fetchMock.mock.calls.some(([u]) =>
        (u as string).includes("/vh/running-sessions"),
      ),
    ).toBe(true);
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
