// @vitest-environment jsdom
//
// deleteSession (web/src/archive.ts) — mirrors archiveSession: accepts an
// optional expectedFingerprint, on 409 (descendants_changed) throws a typed
// DeleteDriftError carrying the server's current set + fingerprint, and runs
// the same prune tail (clearReadAnchors/clearQueueCache/markRead/
// pruneSessionDeleted + clear selection). The function does NOT auto-retry
// (exactly one fetch). Delete is destructive + irreversible.
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteSession, DeleteDriftError } from "../../src/archive";

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("deleteSession — C5 drift (409 → DeleteDriftError)", () => {
  it("throws DeleteDriftError on 409 carrying the server's current set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(409, {
        ok: false,
        error: "descendants_changed",
        current: { fingerprint: "cur-fp", affected: ["s1", "c1", "c2"] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const err = await deleteSession("s1", "stale-fp").catch((e) => e);

    expect(err).toBeInstanceOf(DeleteDriftError);
    expect((err as DeleteDriftError).currentAffected).toEqual(["s1", "c1", "c2"]);
    expect((err as DeleteDriftError).currentFingerprint).toBe("cur-fp");
    // The function does NOT auto-retry — exactly one fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The body carried the stale fingerprint.
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).expectedFingerprint).toBe("stale-fp");
  });

  it("sends expectedFingerprint in the body when provided (200 path)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(200, { ok: true, affected: ["s1"] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await deleteSession("s1", "fp-123");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.sessionID).toBe("s1");
    expect(body.expectedFingerprint).toBe("fp-123");
  });

  it("POSTs to /vh/delete (not /vh/archive)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(200, { ok: true, affected: ["s1"] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await deleteSession("s1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/vh/delete");
    expect(init.method).toBe("POST");
  });

  it("omits expectedFingerprint from the body when absent (backward-compat)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(200, { ok: true, affected: ["s1"] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await deleteSession("s1");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.sessionID).toBe("s1");
    expect(body.expectedFingerprint).toBeUndefined();
  });

  it("tolerates a 409 body missing current.* (empty fallbacks, no throw on parse)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(409, { ok: false, error: "descendants_changed" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const err = (await deleteSession("s1", "fp").catch((e) => e)) as DeleteDriftError;
    expect(err).toBeInstanceOf(DeleteDriftError);
    expect(err.currentAffected).toEqual([]);
    expect(err.currentFingerprint).toBe("");
  });

  it("does NOT throw DeleteDriftError on a non-409 failure (surfaces a generic Error)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(502, "bad gateway"));
    vi.stubGlobal("fetch", fetchMock);

    const err = await deleteSession("s1", "fp").catch((e) => e);
    expect(err).not.toBeInstanceOf(DeleteDriftError);
    expect(String((err as Error).message)).toMatch(/502/);
  });
});
