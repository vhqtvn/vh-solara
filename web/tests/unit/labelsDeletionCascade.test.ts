// @vitest-environment jsdom
// A-F2 (slice 6 fold-in): the session.delete SSE cascade must eagerly evict the
// deleted root from the LOCAL labels doc (groups + tag assignments) WITHOUT a
// PUT — mirroring dropPinnedSession's parity in the same interpretEffects
// `session-removed` branch (web/src/sync/reconcile.ts). The server's own
// lifecycle layer (slice 3) does the authoritative RemoveRootIDs + fans out
// labels.updated; this drop is the eager client-side eviction so the stale root
// id does not linger in the rendered groups/chips until that broadcast lands.
//
// The contract under test: driving applySessionEvent("session.delete", ...) for
// a root that belongs to a group AND carries tag assignments removes it from
// BOTH labelsGroups() and labelTagIdsByRootSessionId() synchronously, and the
// S2 400 self-heal PUT is NOT fired by the cascade (the drop is local-only,
// like dropPinnedSession).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import { applySessionEvent } from "../../src/sync/reconcile";
import { setState } from "../../src/sync/store";
import {
  __resetLabelsForTest,
  applyLabelsSnapshot,
  labelTagIdsByRootSessionId,
  labelsGroups,
} from "../../src/labels";

describe("A-F2: session.delete cascade evicts the root from labels without a PUT", () => {
  beforeEach(() => {
    __resetLabelsForTest();
    // Seed a labels doc where root "r1" is in group "lg-1" and carries tags
    // "lt-a" + "lt-b". applyLabelsSnapshot is the bootstrap path — it flips
    // connected (the gate dropLabelRoot requires) and installs the doc without
    // any network.
    applyLabelsSnapshot({
      revision: 7,
      groups: [
        {
          id: "lg-1",
          name: "Backend",
          color: "blue",
          collapsed: false,
          orderedRootSessionIds: ["r1", "r2"],
        },
      ],
      tags: [
        { id: "lt-a", name: "urgent", color: "red" },
        { id: "lt-b", name: "backend", color: "teal" },
      ],
      tagIdsByRootSessionId: { r1: ["lt-a", "lt-b"], r2: ["lt-b"] },
    });
    // The store's session table must hold r1 so projectSessionRemoval resolves
    // it (the cascade emits session-removed only for a session the store knew).
    setState("sessions", reconcile({}));
    setState("sessions", "r1", { id: "r1", title: "Root one" } as any);
  });

  afterEach(() => {
    __resetLabelsForTest();
    vi.unstubAllGlobals();
  });

  it("removes the deleted root from its group's ordered list + drops its tag assignments", () => {
    // Sanity: r1 is seeded in both structures before the delete.
    expect(labelsGroups()[0].orderedRootSessionIds).toContain("r1");
    expect(labelTagIdsByRootSessionId()["r1"]).toEqual(["lt-a", "lt-b"]);

    applySessionEvent("session.delete", 99, { id: "r1" });

    // r1 evicted from the group; r2 (untouched) remains. Group definition +
    // tag definitions survive (store invariant #7).
    const g = labelsGroups()[0];
    expect(g.id).toBe("lg-1");
    expect(g.orderedRootSessionIds).toEqual(["r2"]);
    // r1's tag-assignment entry is gone entirely.
    expect(labelTagIdsByRootSessionId()["r1"]).toBeUndefined();
    // r2's assignments are untouched.
    expect(labelTagIdsByRootSessionId()["r2"]).toEqual(["lt-b"]);
  });

  it("does NOT issue a PUT (the drop is a local correction, not a mutation)", () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ revision: 8, groups: [], tags: [], tagIdsByRootSessionId: {} }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    applySessionEvent("session.delete", 99, { id: "r1" });

    // The cascade must NOT round-trip a PUT /vh/labels — the eviction is local,
    // mirroring dropPinnedSession (no PUT on the pin path either). The server's
    // own lifecycle broadcast is the durable authority.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is idempotent: deleting an unknown root is a safe no-op (no throw, no PUT)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => applySessionEvent("session.delete", 100, { id: "neverexisted" })).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    // Seeded state is untouched.
    expect(labelsGroups()[0].orderedRootSessionIds).toEqual(["r1", "r2"]);
  });
});
