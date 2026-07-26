// @vitest-environment jsdom
//
// C5 — archiveSession drift contract (FE unit).
//
// archiveSession (web/src/archive.ts) accepts an optional expectedFingerprint
// and, on a 409 (descendants_changed), throws a typed ArchiveDriftError
// carrying the server's current affected set + fingerprint. The caller
// (SessionContextMenu.doArchive) catches it to re-fetch + re-show the
// confirmation dialog. The function itself does NOT auto-retry (exactly one
// fetch). Absent expectedFingerprint → the body omits the field (backward-compat
// for legacy / programmatic callers).
//
// The component-level re-preview path (doArchive catches ArchiveDriftError →
// re-fetches + re-shows the dialog, no auto-retry) is covered by
// SessionContextMenuArchiveDrift.test.tsx.
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveSession, ArchiveDriftError } from "../../src/archive";

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("archiveSession — C5 drift (409 → ArchiveDriftError)", () => {
  it("throws ArchiveDriftError on 409 carrying the server's current set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(409, {
        ok: false,
        error: "descendants_changed",
        current: { fingerprint: "cur-fp", affected: ["s1", "c1", "c2"] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const err = await archiveSession("s1", "stale-fp").catch((e) => e);

    expect(err).toBeInstanceOf(ArchiveDriftError);
    expect((err as ArchiveDriftError).currentAffected).toEqual([
      "s1",
      "c1",
      "c2",
    ]);
    expect((err as ArchiveDriftError).currentFingerprint).toBe("cur-fp");
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

    await archiveSession("s1", "fp-123");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.sessionID).toBe("s1");
    expect(body.expectedFingerprint).toBe("fp-123");
  });

  it("omits expectedFingerprint from the body when absent (backward-compat)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(200, { ok: true, affected: ["s1"] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await archiveSession("s1");

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

    const err = (await archiveSession("s1", "fp").catch((e) => e)) as ArchiveDriftError;
    expect(err).toBeInstanceOf(ArchiveDriftError);
    expect(err.currentAffected).toEqual([]);
    expect(err.currentFingerprint).toBe("");
  });

  it("does NOT throw ArchiveDriftError on a non-409 failure (surfaces a generic Error)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(502, "bad gateway"));
    vi.stubGlobal("fetch", fetchMock);

    const err = await archiveSession("s1", "fp").catch((e) => e);
    expect(err).not.toBeInstanceOf(ArchiveDriftError);
    expect(String((err as Error).message)).toMatch(/502/);
  });
});
