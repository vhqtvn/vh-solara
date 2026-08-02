// Labels facade (web/src/labels.ts) — unit coverage of the data/transport layer.
//
// Pure logic + fetch mocking; no DOM, so this runs in the node environment (the
// vitest default). Mirrors the sidebar-pins.test.ts harness shape (jsonRes,
// flush, vi.stubGlobal("fetch")). Covers: coerceLabelsDoc repair/reject,
// confirmed-doc adoption + revision monotonicity, optimistic mutation + rollback,
// the one bounded 409/400 retry, 400-body adoption, stale-ref self-heal, and the
// no-stale-replay (rebased reorder) guarantee.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLabelsForTest,
  addRootTag,
  applyLabelsSnapshot,
  applyLabelsUpdated,
  clearLabelsError,
  coerceLabelsDoc,
  createGroup,
  createTag,
  deleteGroup,
  deleteTag,
  dropLabelRoot,
  labelTagIdsByRootSessionId,
  labelsConnected,
  labelsGroups,
  labelsLastError,
  labelsPending,
  labelsRevision,
  labelsTags,
  moveRootToGroup,
  removeRootTag,
  renameGroup,
  reorderGroup,
  resetLabelsScope,
  setGroupColor,
  toggleGroupCollapse,
  type LabelGroup,
  type LabelTag,
} from "../../src/labels";

// Minimal Response-like object the fetch mock returns. The facade reads .status
// and calls .json(); installCsrf is not installed in tests so the raw stub is
// what the facade's fetch call hits.
function jsonRes(body: unknown, status = 200): Response {
  return { ok: status === 200, status, json: async () => body } as Response;
}

// A structured 400 body (mirrors pkg/web/labels_http.go labelsRejectionResp):
// error/message/ids ALONGSIDE the promoted LabelsDoc fields (revision/groups/
// tags/tagIdsByRootSessionId). The embedded doc IS the self-healed authority.
function rejection400(
  authority: {
    revision: number;
    groups: LabelGroup[];
    tags: LabelTag[];
    tagIdsByRootSessionId: Record<string, string[]>;
  },
  opts: { error?: string; message?: string; ids?: string[] } = {},
): Response {
  return jsonRes(
    {
      error: opts.error ?? "unknown_root",
      message: opts.message ?? "rejected",
      ids: opts.ids,
      revision: authority.revision,
      groups: authority.groups,
      tags: authority.tags,
      tagIdsByRootSessionId: authority.tagIdsByRootSessionId,
    },
    400,
  );
}

// Doc builders (the wire shape — same field names the server emits).
function grp(
  id: string,
  opts: { name?: string; color?: string; collapsed?: boolean; roots?: string[] } = {},
): LabelGroup {
  return {
    id,
    name: opts.name ?? id,
    color: opts.color ?? "blue",
    collapsed: opts.collapsed ?? false,
    orderedRootSessionIds: opts.roots ?? [],
  };
}
function tag(id: string, opts: { name?: string; color?: string } = {}): LabelTag {
  return { id, name: opts.name ?? id, color: opts.color ?? "blue" };
}
function doc(
  revision: number,
  groups: LabelGroup[] = [],
  tags: LabelTag[] = [],
  tagIdsByRootSessionId: Record<string, string[]> = {},
): { revision: number; groups: LabelGroup[]; tags: LabelTag[]; tagIdsByRootSessionId: Record<string, string[]> } {
  return { revision, groups, tags, tagIdsByRootSessionId };
}

// Flush pending microtasks (the PUT chains are async even when fetch resolves
// synchronously — they cross several awaits).
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  __resetLabelsForTest();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// === coerceLabelsDoc ========================================================
describe("coerceLabelsDoc", () => {
  it("parses a well-formed doc", () => {
    const d = doc(3, [grp("g1", { roots: ["r1", "r2"] })], [tag("t1")], { r1: ["t1"] });
    expect(coerceLabelsDoc(d)).toEqual(d);
  });

  it("defaults missing scalars and empty collections", () => {
    expect(coerceLabelsDoc({ revision: 7 })).toEqual({
      revision: 7,
      groups: [],
      tags: [],
      tagIdsByRootSessionId: {},
    });
  });

  it("returns null for non-object input", () => {
    expect(coerceLabelsDoc(null)).toBeNull();
    expect(coerceLabelsDoc("nope")).toBeNull();
    expect(coerceLabelsDoc(42)).toBeNull();
    expect(coerceLabelsDoc(undefined)).toBeNull();
  });

  it("keeps the FIRST occurrence of a duplicate group id (drops later)", () => {
    const out = coerceLabelsDoc(
      doc(1, [
        grp("g1", { name: "first", roots: ["r1"] }),
        grp("g1", { name: "second", roots: ["r2"] }),
      ]),
    );
    expect(out?.groups).toHaveLength(1);
    expect(out?.groups[0]).toEqual(grp("g1", { name: "first", roots: ["r1"] }));
  });

  it("keeps the FIRST occurrence of a duplicate tag id (drops later)", () => {
    const out = coerceLabelsDoc(doc(1, [], [tag("t1", { name: "first" }), tag("t1", { name: "second" })]));
    expect(out?.tags).toHaveLength(1);
    expect(out?.tags[0]).toEqual(tag("t1", { name: "first" }));
  });

  it("drops dangling tag refs in tagIdsByRootSessionId", () => {
    const out = coerceLabelsDoc(
      doc(1, [], [tag("t1")], { r1: ["t1", "ghost", "t1"], r2: ["onlyGhost"] }),
    );
    expect(out?.tagIdsByRootSessionId).toEqual({ r1: ["t1"] }); // r2 dropped (empty after cleanup)
  });

  it("dedupes a duplicate root WITHIN a group's ordered list", () => {
    const out = coerceLabelsDoc(doc(1, [grp("g1", { roots: ["r1", "r2", "r1", "r3"] })]));
    expect(out?.groups[0].orderedRootSessionIds).toEqual(["r1", "r2", "r3"]);
  });

  it("keeps a root in ONLY the first group that claims it (exclusive)", () => {
    const out = coerceLabelsDoc(
      doc(1, [grp("gA", { roots: ["shared", "a1"] }), grp("gB", { roots: ["shared", "b1"] })]),
    );
    expect(out?.groups[0].orderedRootSessionIds).toEqual(["shared", "a1"]);
    expect(out?.groups[1].orderedRootSessionIds).toEqual(["b1"]); // "shared" dropped from gB
  });

  it("filters non-string entries and drops empty-string roots/keys", () => {
    const out = coerceLabelsDoc({
      revision: 1,
      groups: [
        { id: "g1", name: "n", color: "blue", collapsed: false, orderedRootSessionIds: ["r1", 7, "", null, "r2"] },
      ],
      tags: [{ id: "t1", name: "n", color: "blue" }],
      tagIdsByRootSessionId: { "": ["t1"], r1: ["t1", 9, ""] },
    });
    expect(out?.groups[0].orderedRootSessionIds).toEqual(["r1", "r2"]);
    expect(out?.tagIdsByRootSessionId).toEqual({ r1: ["t1"] });
  });
});

// === Confirmed-doc adoption + revision monotonicity =========================
describe("applyLabelsSnapshot — bootstrap reset (always adopted)", () => {
  it("adopts the server doc and flips connected", () => {
    applyLabelsSnapshot(doc(5, [grp("g1", { roots: ["r1"] })], [tag("t1")], { r1: ["t1"] }));
    expect(labelsConnected()).toBe(true);
    expect(labelsRevision()).toBe(5);
    expect(labelsGroups()).toEqual([grp("g1", { roots: ["r1"] })]);
    expect(labelsTags()).toEqual([tag("t1")]);
    expect(labelTagIdsByRootSessionId()).toEqual({ r1: ["t1"] });
  });

  it("a later snapshot at a LOWER revision still adopts (bootstrap is exempt from the guard)", () => {
    applyLabelsSnapshot(doc(5, [grp("g1")]));
    applyLabelsSnapshot(doc(2, [grp("g2")])); // reconnect re-bootstrap
    expect(labelsRevision()).toBe(2);
    expect(labelsGroups()).toEqual([grp("g2")]);
  });

  it("clears a prior advisory error on a confirmed doc", async () => {
    applyLabelsSnapshot(doc(1, [grp("g1")]));
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("net"))));
    await renameGroup("g1", "newname"); // fails → labels-network
    expect(labelsLastError()).toBe("labels-network");
    applyLabelsSnapshot(doc(2, [grp("g1", { name: "from-server" })]));
    expect(labelsLastError()).toBeNull();
    expect(labelsGroups()[0].name).toBe("from-server");
  });

  it("drops a malformed snapshot (null coerce) without touching state", () => {
    applyLabelsSnapshot(doc(5, [grp("g1")]));
    applyLabelsSnapshot("not-json-compatible");
    expect(labelsRevision()).toBe(5);
    expect(labelsGroups()).toEqual([grp("g1")]);
  });
});

describe("applyLabelsUpdated — revision-monotonicity guard (F1)", () => {
  it("drops a live update whose revision is older than the last-applied", () => {
    applyLabelsSnapshot(doc(5, [grp("g1")]));
    applyLabelsUpdated(doc(4, [grp("g2")])); // stale → dropped
    expect(labelsGroups()).toEqual([grp("g1")]);
    expect(labelsRevision()).toBe(5);
  });

  it("adopts an update whose revision is newer", () => {
    applyLabelsSnapshot(doc(5, [grp("g1")]));
    applyLabelsUpdated(doc(6, [grp("g2"), grp("g3")]));
    expect(labelsGroups()).toEqual([grp("g2"), grp("g3")]);
    expect(labelsRevision()).toBe(6);
  });

  it("allows an equal-revision update through (idempotent re-adopt)", () => {
    applyLabelsSnapshot(doc(5, [grp("g1")]));
    applyLabelsUpdated(doc(5, [grp("g1")])); // same rev, same doc
    expect(labelsGroups()).toEqual([grp("g1")]);
    expect(labelsRevision()).toBe(5);
  });
});

// === Optimistic mutation + rollback =========================================
describe("optimistic mutation — immediate reflect + rollback on failure", () => {
  it("createGroup mints an lg- prefixed id, reflects optimistically, PUTs the full doc", async () => {
    applyLabelsSnapshot(doc(1, [grp("g1")]));
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonRes(doc(2, [grp("g1"), grp("lg-AAA", { name: "New", color: "red" })]))),
    );
    vi.stubGlobal("fetch", fetchMock);

    const p = createGroup("New", "red");
    // Optimistic: the new group is present BEFORE the PUT resolves.
    expect(labelsGroups()).toHaveLength(2);
    expect(labelsGroups()[1].name).toBe("New");
    expect(labelsGroups()[1].id.startsWith("lg-")).toBe(true);

    await p;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.baseRevision).toBe(1);
    expect(body.groups).toHaveLength(2);
    expect(body.groups[1]).toMatchObject({ name: "New", color: "red", collapsed: false, orderedRootSessionIds: [] });
  });

  it("rolls back the optimistic update on network failure", async () => {
    applyLabelsSnapshot(doc(1, [grp("g1")]));
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("net"))));

    await renameGroup("g1", "changed"); // optimistic rename → rolled back

    expect(labelsGroups()[0].name).toBe("g1"); // original restored
    expect(labelsRevision()).toBe(1);
    expect(labelsLastError()).toBe("labels-network");
  });

  it("is a no-op (no PUT) when the intent changes nothing", async () => {
    applyLabelsSnapshot(doc(1, [grp("g1", { name: "same" })]));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await renameGroup("g1", "same"); // same name → contentEqual → no PUT

    expect(fetchMock).not.toHaveBeenCalled();
    expect(labelsLastError()).toBeNull();
  });
});

// === Exactly one bounded retry (409 + 400) ==================================
describe("bounded retry — 409 conflict", () => {
  it("on 409 adopts authority, rebases the SAME intent, retries once (200)", async () => {
    applyLabelsSnapshot(doc(1, [grp("gA", { roots: ["r1"] })]));
    // Concurrent PUT added r2 to gA; our addRootTag(r2,t1) is stale → 409, then
    // the rebased retry wins.
    const t1 = tag("t1");
    const seq = [
      jsonRes(doc(1, [grp("gA", { roots: ["r1", "r2"] })], [t1]), 409),
      jsonRes(doc(2, [grp("gA", { roots: ["r1", "r2"] })], [t1], { r2: ["t1"] })),
    ];
    let i = 0;
    const fetchMock = vi.fn(() => Promise.resolve(seq[i++]));
    vi.stubGlobal("fetch", fetchMock);

    // Seed t1 exists, then assign it to r2.
    applyLabelsSnapshot(doc(1, [grp("gA", { roots: ["r1"] })], [t1]));
    await addRootTag("r2", "t1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Retry body derived from the adopted doc: assign t1 to r2.
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(retryBody).toMatchObject({ baseRevision: 1, tagIdsByRootSessionId: { r2: ["t1"] } });
    expect(labelTagIdsByRootSessionId()).toEqual({ r2: ["t1"] });
    expect(labelsRevision()).toBe(2);
    expect(labelsLastError()).toBeNull();
  });

  it("on a SECOND 409 stops, surfaces, leaves the authoritative doc in place", async () => {
    applyLabelsSnapshot(doc(1, [grp("gA")]));
    const seq = [
      jsonRes(doc(1, [grp("gA"), grp("gB")]), 409), // concurrent added gB
      jsonRes(doc(2, [grp("gA"), grp("gB"), grp("gC")]), 409), // another beat the retry
    ];
    let i = 0;
    const fetchMock = vi.fn(() => Promise.resolve(seq[i++]));
    vi.stubGlobal("fetch", fetchMock);

    await createGroup("Mine", "red");

    expect(fetchMock).toHaveBeenCalledTimes(2); // first + one retry, then stop
    expect(labelsGroups().map((g) => g.id)).toEqual(["gA", "gB", "gC"]); // final authority
    expect(labelsLastError()).toBe("labels-conflict");
  });

  it("does NOT issue a retry PUT when the adopted doc already satisfies the intent", async () => {
    // addRootTag is idempotent (unlike a toggle): if the adopted authority shows
    // the tag already assigned, re-applying the intent is a no-op → no retry.
    applyLabelsSnapshot(doc(1, [grp("gA")], [tag("t1")])); // t1 exists, not yet assigned
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonRes(doc(1, [grp("gA")], [tag("t1")], { r1: ["t1"] }), 409)),
    );
    vi.stubGlobal("fetch", fetchMock);

    await addRootTag("r1", "t1"); // intent: assign t1 to r1 — already done concurrently

    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry — already assigned
    expect(labelTagIdsByRootSessionId()).toEqual({ r1: ["t1"] });
    expect(labelsLastError()).toBeNull();
  });
});

describe("bounded retry — 400 self-heal adoption", () => {
  it("adopts the embedded self-healed doc from a structured 400", async () => {
    // Client holds a doc; a mutation 400s (e.g. over-cap). The 400 body embeds
    // the authoritative current doc — the facade adopts it.
    applyLabelsSnapshot(doc(5, [grp("gA")], [tag("t1")]));
    const authority = doc(5, [grp("gA")], [tag("t1")]); // unchanged (rejected Replace)
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(rejection400(authority, { error: "too_many_groups" }))));

    await createGroup("Excess", "red");

    // Adopted the 400's embedded doc; rebased intent (createGroup) against it
    // produced [gA, Excess] → retry. But the mock returns the SAME 400 again, so
    // the retry also 400s → second conflict → adopt final, stop.
    expect(labelsLastError()).toBe("labels-conflict");
    expect(labelsGroups()).toEqual([grp("gA")]); // authority (Excess not persisted)
    expect(labelsRevision()).toBe(5);
  });

  it("a malformed/missing-baseRevision 400 (text, no JSON doc) is a generic labels-error", async () => {
    applyLabelsSnapshot(doc(1, [grp("gA")]));
    // Simulate a text/plain 400: .json() resolves to a non-doc → coerce null.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonRes("baseRevision required", 400))));

    await renameGroup("gA", "x");

    expect(labelsGroups()[0].name).toBe("gA"); // optimistic rolled back
    expect(labelsLastError()).toBe("labels-error");
  });
});

// === Stale-reference correction (server self-heals dangling root/tag) =======
describe("stale-ref correction — 400 self-heal + rebased retry converges", () => {
  it("server drops a stale root from a group; client adopts + rebases the intent + succeeds", async () => {
    // Client doc carries a stale (archived) root in gA. The user toggles gA's
    // collapse. The PUT ships the doc WITH the stale root; the server 400s with
    // the self-healed doc (stale root removed), then the rebased retry wins.
    const t1 = tag("t1");
    const healed = doc(1, [grp("gA", { roots: ["live"] })], [t1]);
    applyLabelsSnapshot(doc(1, [grp("gA", { roots: ["live", "stale"] })], [t1]));
    const seq = [
      rejection400(healed, { error: "unknown_root", ids: ["stale"] }), // self-healed: stale dropped
      jsonRes(doc(2, [grp("gA", { roots: ["live"], collapsed: true })], [t1])), // rebased retry wins
    ];
    let i = 0;
    const fetchMock = vi.fn(() => Promise.resolve(seq[i++]));
    vi.stubGlobal("fetch", fetchMock);

    await toggleGroupCollapse("gA"); // intent: flip collapse

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First PUT shipped the stale root (full doc as the client held it).
    const firstBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(firstBody.groups[0].orderedRootSessionIds).toEqual(["live", "stale"]);
    // Retry PUT shipped the REBASED intent against the healed doc (stale gone,
    // collapse flipped) — NOT the stale [live,stale] permutation.
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(retryBody.baseRevision).toBe(1); // 400 did not advance the server doc
    expect(retryBody.groups[0]).toMatchObject({ id: "gA", collapsed: true, orderedRootSessionIds: ["live"] });
    // Final: stale root gone, collapse applied, no error.
    expect(labelsGroups()[0].orderedRootSessionIds).toEqual(["live"]);
    expect(labelsGroups()[0].collapsed).toBe(true);
    expect(labelsLastError()).toBeNull();
    expect(labelsRevision()).toBe(2);
  });

  it("deleteTag self-heals: server strips dangling refs; client adopts the cleaned doc", async () => {
    // Client thinks t2 exists; it was deleted concurrently. deleteTag("t2")
    // ships a doc still referencing t2 in assignments; server 400s with the
    // self-healed doc (t2 gone everywhere), rebased retry wins.
    applyLabelsSnapshot(doc(1, [grp("gA")], [tag("t1"), tag("t2")], { r1: ["t1", "t2"] }));
    const healed = doc(1, [grp("gA")], [tag("t1")], { r1: ["t1"] }); // t2 already gone server-side
    const seq = [
      rejection400(healed, { error: "dangling_tag_ref", ids: ["r1", "t2"] }),
      jsonRes(doc(2, [grp("gA")], [tag("t1")], { r1: ["t1"] })),
    ];
    let i = 0;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(seq[i++])));

    await deleteTag("t2");

    expect(labelsTags()).toEqual([tag("t1")]);
    expect(labelTagIdsByRootSessionId()).toEqual({ r1: ["t1"] });
    expect(labelsLastError()).toBeNull();
  });
});

// === No stale replay of an obsolete reorder (rebased against authority) ======
describe("reorderGroup — rebased retry, NOT a blind replay", () => {
  it("on 409 the retry recomputes the reorder against the adopted doc (preserves concurrent additions)", async () => {
    // Initial groups [A, B, C] at rev1. User moves C to index 0 → [C, A, B].
    // Concurrent winner added D → adopted [A, B, C, D] at rev2. The rebased
    // retry moves C to index 0 in the ADOPTED doc → [C, A, B, D] (NOT [C,A,B],
    // which would have dropped D). Verifies the intent is recomputed, not the
    // stale permutation blindly replayed.
    applyLabelsSnapshot(doc(1, [grp("A"), grp("B"), grp("C")]));
    const seq = [
      jsonRes(doc(2, [grp("A"), grp("B"), grp("C"), grp("D")]), 409), // concurrent added D
      jsonRes(doc(3, [grp("C"), grp("A"), grp("B"), grp("D")])), // rebased retry wins
    ];
    let i = 0;
    const fetchMock = vi.fn(() => Promise.resolve(seq[i++]));
    vi.stubGlobal("fetch", fetchMock);

    await reorderGroup("C", 0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First PUT shipped the stale-base reorder [C, A, B].
    const firstBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(firstBody.groups.map((g: LabelGroup) => g.id)).toEqual(["C", "A", "B"]);
    // Retry PUT shipped the REBASED reorder against [A,B,C,D] → [C, A, B, D].
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(retryBody.baseRevision).toBe(2); // adopted authority's revision
    expect(retryBody.groups.map((g: LabelGroup) => g.id)).toEqual(["C", "A", "B", "D"]);
    // Final: rebased order, D preserved, no error.
    expect(labelsGroups().map((g) => g.id)).toEqual(["C", "A", "B", "D"]);
    expect(labelsLastError()).toBeNull();
    expect(labelsRevision()).toBe(3);
  });
});

// === Intent semantics (a representative sweep of the public ops) ============
describe("intent semantics — full-doc transforms", () => {
  it("deleteGroup removes the group; roots become ungrouped; tags/assignments untouched", async () => {
    applyLabelsSnapshot(doc(1, [grp("gA", { roots: ["r1"] }), grp("gB")], [tag("t1")], { r1: ["t1"] }));
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonRes(doc(2, [grp("gB")], [tag("t1")], { r1: ["t1"] })))));

    await deleteGroup("gA");

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.groups).toEqual([grp("gB")]); // gA gone
    expect(body.tagIdsByRootSessionId).toEqual({ r1: ["t1"] }); // assignment preserved (root r1 still tagged)
    expect(labelsGroups()).toEqual([grp("gB")]);
  });

  it("moveRootToGroup is EXCLUSIVE: root leaves all other groups, joins the target", async () => {
    applyLabelsSnapshot(doc(1, [grp("gA", { roots: ["r1", "r2"] }), grp("gB", { roots: ["r3"] })]));
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonRes(doc(2, [
      grp("gA", { roots: ["r1"] }),
      grp("gB", { roots: ["r3", "r2"] }),
    ])))));

    await moveRootToGroup("r2", "gB");

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.groups[0].orderedRootSessionIds).toEqual(["r1"]); // r2 left gA
    expect(body.groups[1].orderedRootSessionIds).toEqual(["r3", "r2"]); // r2 appended to gB
  });

  it("moveRootToGroup(null) ungroups the root from every group", async () => {
    applyLabelsSnapshot(doc(1, [grp("gA", { roots: ["r1"] })]));
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonRes(doc(2, [grp("gA", { roots: [] })])))));

    await moveRootToGroup("r1", null);

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.groups[0].orderedRootSessionIds).toEqual([]);
  });

  it("createTag mints an lt- prefixed id and appends", async () => {
    applyLabelsSnapshot(doc(1, []));
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonRes(doc(2, [tag("lt-X", { name: "Bug", color: "red" })])))));

    const p = createTag("Bug", "red");
    expect(labelsTags()[0].id.startsWith("lt-")).toBe(true);
    expect(labelsTags()[0].name).toBe("Bug");
    await p;
  });

  it("deleteTag strips the tag from assignments; a root with only that tag loses its entry", async () => {
    applyLabelsSnapshot(doc(1, [grp("gA")], [tag("t1"), tag("t2")], { r1: ["t1", "t2"], r2: ["t2"] }));
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonRes(doc(2, [grp("gA")], [tag("t1")], { r1: ["t1"] })))));

    await deleteTag("t2");

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.tags).toEqual([tag("t1")]);
    expect(body.tagIdsByRootSessionId).toEqual({ r1: ["t1"] }); // r2 dropped (had only t2)
  });

  it("addRootTag is a no-op if the tag is unknown or already assigned", async () => {
    applyLabelsSnapshot(doc(1, [grp("gA")], [tag("t1")], { r1: ["t1"] }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await addRootTag("r1", "ghost"); // unknown tag
    await addRootTag("r1", "t1"); // already assigned
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removeRootTag drops the assignment entry when the last tag is removed", async () => {
    applyLabelsSnapshot(doc(1, [grp("gA")], [tag("t1")], { r1: ["t1"] }));
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonRes(doc(2, [grp("gA")], [tag("t1")], {})))));

    await removeRootTag("r1", "t1");

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.tagIdsByRootSessionId).toEqual({});
  });
});

// === setGroupColor — color-swatch handler (parity with renameGroup) ==========
// setGroupColor is a pure intent over the SAME engine as renameGroup
// (performMutation): optimistic apply, one bounded 409/400 retry, network
// rollback, and the stale-frame guards. These mirror the renameGroup cases that
// already pin that engine — closing the slice-6 review DEFER that flagged the
// TS-only color-swatch handler as untested.
describe("setGroupColor — change a group's color token", () => {
  it("changes the color optimistically, PUTs the full doc with the new color, bumps revision on 200", async () => {
    applyLabelsSnapshot(doc(1, [grp("g1", { name: "G1", color: "blue" })]));
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonRes(doc(2, [grp("g1", { name: "G1", color: "red" })]))),
    );
    vi.stubGlobal("fetch", fetchMock);

    const p = setGroupColor("g1", "red");
    // Optimistic: color flips to red BEFORE the PUT resolves (no rev bump yet).
    expect(labelsGroups()[0].color).toBe("red");
    expect(labelsRevision()).toBe(1); // optimistic apply does not bump revision

    await p;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.baseRevision).toBe(1);
    expect(body.groups[0]).toMatchObject({ id: "g1", name: "G1", color: "red" });
    expect(labelsGroups()[0].color).toBe("red");
    expect(labelsRevision()).toBe(2);
    expect(labelsLastError()).toBeNull();
  });

  it("is a no-op (no PUT) when the color is unchanged (contentEqual)", async () => {
    applyLabelsSnapshot(doc(1, [grp("g1", { color: "blue" })]));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await setGroupColor("g1", "blue"); // same color → doc identical → no PUT

    expect(fetchMock).not.toHaveBeenCalled();
    expect(labelsLastError()).toBeNull();
    expect(labelsRevision()).toBe(1);
  });

  it("is a no-op (no PUT) when the group id is unknown", async () => {
    // Mirrors setGroupColor's documented "no-op if the id is unknown" clause: the
    // intent returns the doc unchanged → contentEqual → no PUT.
    applyLabelsSnapshot(doc(1, [grp("g1", { color: "blue" })]));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await setGroupColor("ghost", "red");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(labelsLastError()).toBeNull();
    expect(labelsGroups()[0].color).toBe("blue");
  });

  it("on 409 adopts authority, rebases the SAME recolor intent, retries once (200)", async () => {
    // Client holds g1 (blue) @ rev1. A concurrent winner renamed g1 to "Renamed"
    // @ rev2. setGroupColor(g1, red) is stale → 409; the facade adopts the
    // authority [g1 "Renamed" blue] @ rev2, rebases the recolor onto it
    // ([g1 "Renamed" red]), and the single retry wins @ rev3. This proves the
    // recolor rebases like renameGroup (find-by-id re-applies cleanly), NOT a
    // blind replay that would clobber the concurrent rename.
    applyLabelsSnapshot(doc(1, [grp("g1", { name: "G1", color: "blue" })]));
    const seq = [
      jsonRes(doc(2, [grp("g1", { name: "Renamed", color: "blue" })]), 409),
      jsonRes(doc(3, [grp("g1", { name: "Renamed", color: "red" })])),
    ];
    let i = 0;
    const fetchMock = vi.fn(() => Promise.resolve(seq[i++]));
    vi.stubGlobal("fetch", fetchMock);

    await setGroupColor("g1", "red");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Retry body derived from the ADOPTED authority: recolor applied on top of
    // the concurrent rename (name preserved, color flipped), baseRevision bumped.
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(retryBody).toMatchObject({ baseRevision: 2 });
    expect(retryBody.groups[0]).toMatchObject({ id: "g1", name: "Renamed", color: "red" });
    expect(labelsGroups()[0]).toMatchObject({ name: "Renamed", color: "red" });
    expect(labelsRevision()).toBe(3);
    expect(labelsLastError()).toBeNull();
  });

  it("rolls back the optimistic recolor on network failure", async () => {
    applyLabelsSnapshot(doc(1, [grp("g1", { color: "blue" })]));
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("net"))));

    await setGroupColor("g1", "red"); // optimistic recolor → rolled back

    expect(labelsGroups()[0].color).toBe("blue"); // original restored
    expect(labelsRevision()).toBe(1);
    expect(labelsLastError()).toBe("labels-network");
  });

  it("a labels.updated landing during a failed recolor PUT is left intact (rollback guard)", async () => {
    // setGroupColor issues a PUT that stays pending; a labels.updated frame (rev5)
    // lands DURING the round-trip and is adopted. The PUT then fails non-409.
    // serverRevision() (5) !== baseRev (1), so the rollback is skipped and the
    // fresher frame's doc is left intact (mirrors the renameGroup F1 case).
    applyLabelsSnapshot(doc(1, [grp("g1", { name: "G1", color: "blue" })]));
    let rejectPut!: (e: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_, rej) => (rejectPut = rej))));

    const p = setGroupColor("g1", "red");
    await flush(); // optimistic applied; PUT pending
    expect(labelsGroups()[0].color).toBe("red");

    applyLabelsUpdated(doc(5, [grp("g1", { name: "G1", color: "purple" })])); // fresher frame
    expect(labelsRevision()).toBe(5);
    expect(labelsGroups()[0].color).toBe("purple");

    rejectPut(new Error("net")); // PUT fails non-409
    await p;

    expect(labelsGroups()[0].color).toBe("purple"); // NOT rolled back to blue/red
    expect(labelsRevision()).toBe(5);
    expect(labelsLastError()).toBe("labels-network");
  });

  it("a 200 recolor response older than the held revision is dropped (F1 on the success path)", async () => {
    // setGroupColor issues a PUT (baseRev1). DURING the round-trip a labels.updated
    // (rev5) lands and is adopted. The PUT's 200 returns an OLDER revision (rev2).
    // adoptPutResponse drops it (2 < 5), leaving the fresher doc intact.
    applyLabelsSnapshot(doc(1, [grp("g1", { name: "G1", color: "blue" })]));
    let resolvePut!: (v: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (resolvePut = r))));

    const p = setGroupColor("g1", "red");
    await flush(); // PUT issued, pending

    applyLabelsUpdated(doc(5, [grp("g1", { name: "G1", color: "green" })]));
    expect(labelsGroups()[0].color).toBe("green");

    resolvePut(jsonRes(doc(2, [grp("g1", { name: "G1", color: "red" })]))); // stale 200
    await p;

    expect(labelsGroups()[0].color).toBe("green"); // NOT regressed to red
    expect(labelsRevision()).toBe(5);
    expect(labelsLastError()).toBeNull();
  });
});

// === labelsPending + clearLabelsError + dropLabelRoot =======================
describe("labelsPending — reflects in-flight PUTs", () => {
  it("is true while a PUT is in flight, false after it settles", async () => {
    applyLabelsSnapshot(doc(1, [grp("gA")]));
    let resolveFetch!: (v: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (resolveFetch = r))));

    const p = renameGroup("gA", "x");
    expect(labelsPending()).toBe(true);

    resolveFetch(jsonRes(doc(2, [grp("gA", { name: "x" })])));
    await p;
    expect(labelsPending()).toBe(false);
  });
});

describe("clearLabelsError", () => {
  it("clears a surfaced labels error", async () => {
    applyLabelsSnapshot(doc(1, [grp("gA")]));
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("net"))));
    await renameGroup("gA", "x");
    expect(labelsLastError()).toBe("labels-network");
    clearLabelsError();
    expect(labelsLastError()).toBeNull();
  });
});

describe("dropLabelRoot — proactive local drop on archive/delete (no PUT)", () => {
  it("strips a root from every group + drops its tag assignments, no PUT", () => {
    applyLabelsSnapshot(doc(5, [grp("gA", { roots: ["live", "stale"] }), grp("gB", { roots: ["stale2"] })], [tag("t1")], { stale: ["t1"], live: ["t1"] }));
    dropLabelRoot("stale");
    expect(labelsGroups()[0].orderedRootSessionIds).toEqual(["live"]);
    expect(labelTagIdsByRootSessionId()).toEqual({ live: ["t1"] }); // "stale" key gone
    expect(labelsRevision()).toBe(5); // unchanged — no PUT
  });

  it("is a no-op for a root referenced nowhere", () => {
    applyLabelsSnapshot(doc(5, [grp("gA", { roots: ["live"] })]));
    dropLabelRoot("ghost");
    expect(labelsGroups()[0].orderedRootSessionIds).toEqual(["live"]);
    expect(labelsRevision()).toBe(5);
  });

  it("is a no-op before the first snapshot (not connected)", () => {
    expect(labelsConnected()).toBe(false);
    dropLabelRoot("anything"); // must not throw
    expect(labelsGroups()).toEqual([]);
  });
});

// === Concurrency DEFER regressions (mirror pins' F1 + rollback guards) ======
describe("concurrency — fresher frame during PUT is not clobbered", () => {
  it("a labels.updated landing during a failed PUT is left intact (rollback guard)", async () => {
    // renameGroup issues a PUT that stays pending; a labels.updated frame (rev5)
    // lands DURING the round-trip and is adopted. The PUT then fails non-409.
    // serverRevision() (5) !== baseRev (1), so the rollback is skipped and the
    // fresher frame's doc is left intact.
    applyLabelsSnapshot(doc(1, [grp("gA", { name: "orig" })]));
    let rejectPut!: (e: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_, rej) => (rejectPut = rej))));

    const p = renameGroup("gA", "changed");
    await flush(); // optimistic applied; PUT pending
    expect(labelsGroups()[0].name).toBe("changed");

    applyLabelsUpdated(doc(5, [grp("gA", { name: "from-server" })])); // fresher frame
    expect(labelsRevision()).toBe(5);
    expect(labelsGroups()[0].name).toBe("from-server");

    rejectPut(new Error("net")); // PUT fails non-409
    await p;

    expect(labelsGroups()[0].name).toBe("from-server"); // NOT rolled back to "orig"/"changed"
    expect(labelsRevision()).toBe(5);
    expect(labelsLastError()).toBe("labels-network");
  });

  it("a 200-PUT response older than the held revision is dropped (F1 on the success path)", async () => {
    // renameGroup issues a PUT (baseRev1). DURING the round-trip a labels.updated
    // (rev5) lands and is adopted. The PUT's 200 returns an OLDER revision (rev2).
    // adoptPutResponse drops it (2 < 5), leaving the fresher doc intact.
    applyLabelsSnapshot(doc(1, [grp("gA", { name: "orig" })]));
    let resolvePut!: (v: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (resolvePut = r))));

    const p = renameGroup("gA", "changed");
    await flush(); // PUT issued, pending

    applyLabelsUpdated(doc(5, [grp("gA", { name: "fresher" })]));
    expect(labelsGroups()[0].name).toBe("fresher");

    resolvePut(jsonRes(doc(2, [grp("gA", { name: "stale-response" })]))); // stale 200
    await p;

    expect(labelsGroups()[0].name).toBe("fresher"); // NOT regressed
    expect(labelsRevision()).toBe(5);
    expect(labelsLastError()).toBeNull();
  });
});

// === Per-project scope (commit 23efd32 cutover) =============================
// Labels are now per-project server-side: each project has its own revision/CAS
// domain, its own labels.snapshot bootstrap, and its own labels.updated fanout.
// The facade mirrors this with resetLabelsScope() (called from switchProject on
// every project switch + the no-project teardown) and a scope-generation guard
// inside performMutation that drops any late PUT result from a switched-AWAY
// project. These tests pin the lifecycle directly against the facade: the
// full switchProject→connect wiring is covered separately in
// labelsProjectScope.test.ts (jsdom + MockEventSource).
describe("per-project scope — resetLabelsScope + scope-gen guard", () => {
  it("resetLabelsScope clears ALL signals (A's labels gone immediately)", () => {
    applyLabelsSnapshot(doc(7, [grp("gA", { roots: ["r1"] })], [tag("t1")], { r1: ["t1"] }));
    expect(labelsConnected()).toBe(true);
    expect(labelsGroups()).toHaveLength(1);

    resetLabelsScope(); // project switch A → B

    expect(labelsConnected()).toBe(false);
    expect(labelsGroups()).toEqual([]);
    expect(labelsTags()).toEqual([]);
    expect(labelTagIdsByRootSessionId()).toEqual({});
    expect(labelsRevision()).toBe(0);
  });

  it("resetLabelsScope clears labelsPending + labelsLastError (no latch onto B)", async () => {
    applyLabelsSnapshot(doc(1, [grp("gA")]));
    let resolveFetch!: (v: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (resolveFetch = r))));

    const p = renameGroup("gA", "x");
    expect(labelsPending()).toBe(true); // PUT in flight on project A

    resetLabelsScope(); // switch away mid-PUT
    expect(labelsPending()).toBe(false); // pending latched OFF — B starts clean
    expect(labelsLastError()).toBeNull();

    // The orphaned PUT resolves; the gen guard drops it (no adoption, no error).
    resolveFetch(jsonRes(doc(2, [grp("gA", { name: "x" })])));
    await p;
    expect(labelsPending()).toBe(false);
    expect(labelsLastError()).toBeNull(); // A's failure does NOT surface on B
  });

  it("F1-web: a dropped A PUT does not steal the decrement from B's in-flight mutation", async () => {
    // The overlap case the gen-guard fixes: while project A has a PUT in flight,
    // switch to B (resetLabelsScope zeroes pending) and start a mutation on B
    // (pending latched true again for B). Now settle A's orphaned PUT. The
    // scope-gen guard correctly DROPS A's result, but BEFORE F1-web the shared
    // finally still ran decPending() — and since resetLabelsScope zeroed
    // pendingCount, that decrement stole B's lone pending slot and cleared B's
    // labelsPending latch early (B's PUT was still in flight). After F1-web the
    // dropped path skips decPending, so B's labelsPending stays true until B's
    // own PUT settles. (Labels DATA is correct either way — the dropped A PUT
    // never adopts — only the advisory pending latch was briefly wrong.)
    applyLabelsSnapshot(doc(1, [grp("gA", { name: "A" })]));

    // Two independent PUTs in flight; capture each resolver separately. The
    // first fetch() is A's PUT, the second is B's PUT.
    let resolveA!: (v: Response) => void;
    let resolveB!: (v: Response) => void;
    let aCall = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        if (aCall) {
          aCall = false;
          return new Promise<Response>((r) => (resolveA = r));
        }
        return new Promise<Response>((r) => (resolveB = r));
      }),
    );

    // 1. Start project-A mutation (PUT in flight, labelsPending true).
    const pA = renameGroup("gA", "renamed-A");
    await flush(); // optimistic applied; A's PUT issued + pending
    expect(labelsPending()).toBe(true);

    // 2. resetLabelsScope (A → B) — zeroes pending + bumps labelsScopeGen.
    resetLabelsScope();
    expect(labelsPending()).toBe(false); // B starts clean

    // Establish B's doc (B's snapshot, delivered on B's stream).
    applyLabelsSnapshot(doc(1, [grp("gB", { name: "B" })]));

    // 3. Start project-B mutation (pending true again).
    const pB = renameGroup("gB", "renamed-B");
    await flush(); // B's optimistic applied; B's PUT issued + pending
    expect(labelsPending()).toBe(true);

    // 4. Settle the orphaned project-A PUT (the gen-guard dropped path).
    resolveA(jsonRes(doc(2, [grp("gA", { name: "renamed-A" })])));
    await pA; // A's gen-guard return fires; F1-web finally skips decPending.

    // 5a. B's labelsPending stays TRUE until B's own PUT settles.
    //    (Before F1-web, A's finally decPending() had cleared it here.)
    expect(labelsPending()).toBe(true);
    // B's doc must NOT be clobbered by A's dropped response.
    expect(labelsGroups()).toEqual([grp("gB", { name: "renamed-B" })]); // B's optimistic
    expect(labelsLastError()).toBeNull();

    // 5b. Settle B's own PUT — now labelsPending clears.
    resolveB(jsonRes(doc(2, [grp("gB", { name: "renamed-B" })])));
    await pB;
    expect(labelsPending()).toBe(false);
    expect(labelsGroups()).toEqual([grp("gB", { name: "renamed-B" })]);
    expect(labelsRevision()).toBe(2);
    expect(labelsLastError()).toBeNull();
  });

  it("F2-web: a dropped A RETRY-PUT does not steal the decrement from B's in-flight mutation", async () => {
    // Companion to the F1-web case above, exercising gen-guard SITE #2 (the
    // retry-PUT drop). A's first PUT 409s → performMutation adopts the server
    // authority, rebases the intent, and issues the retry PUT. That retry stays
    // pending across a switch to B. While B has its OWN mutation in flight, A's
    // retry PUT resolves 200. The SECOND scope-gen early-return (after the retry
    // await) must set dropped=true so the shared finally skips decPending —
    // resetLabelsScope already zeroed pendingCount, so an unguarded decrement
    // would steal B's lone pending slot and clear B's labelsPending latch early
    // (B's PUT still in flight). Site #1 (first-PUT drop) is covered above; this
    // pins the retry-PUT drop served by the SAME finally.
    applyLabelsSnapshot(doc(1, [grp("gA", { name: "A" })]));

    // Three fetch calls in order: A's first PUT (409, immediate), A's retry PUT
    // (pending → resolveARetry), B's PUT (pending → resolveB).
    let resolveARetry!: (v: Response) => void;
    let resolveB!: (v: Response) => void;
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call++;
        if (call === 1) {
          // A's first PUT → 409: a concurrent winner added gConcurrent to A's doc.
          return Promise.resolve(jsonRes(doc(1, [grp("gA", { name: "A" }), grp("gConcurrent")]), 409));
        }
        if (call === 2) {
          // A's retry PUT → stays pending across the switch to B.
          return new Promise<Response>((r) => (resolveARetry = r));
        }
        // call === 3: B's PUT → pending.
        return new Promise<Response>((r) => (resolveB = r));
      }),
    );

    // 1. Start project-A mutation: first PUT 409s → adopt authority → rebase →
    //    retry PUT issued + pending.
    const pA = renameGroup("gA", "renamed-A");
    await flush(); // A's first PUT resolved (409 adopted + rebased), retry issued
    expect(labelsPending()).toBe(true); // A's retry in flight

    // 2. resetLabelsScope (A → B) — zeroes pendingCount, bumps labelsScopeGen.
    resetLabelsScope();
    expect(labelsPending()).toBe(false); // B starts clean

    // 3. B's snapshot establishes B's state.
    applyLabelsSnapshot(doc(1, [grp("gB", { name: "B" })]));

    // 4. Start project-B mutation (pending latched true again for B).
    const pB = renameGroup("gB", "renamed-B");
    await flush(); // B's optimistic applied; B's PUT issued + pending
    expect(labelsPending()).toBe(true);

    // 5. Settle A's orphaned RETRY PUT (gen-guard site #2 dropped path).
    resolveARetry(jsonRes(doc(2, [grp("gA", { name: "renamed-A" }), grp("gConcurrent")])));
    await pA; // A's retry gen-guard return fires; F2-web finally skips decPending.

    // 6a. B's labelsPending stays TRUE — the dropped A retry did NOT steal the
    //     decrement. (Without dropped=true at site #2, A's finally decPending()
    //     would have zeroed pendingCount and cleared B's latch while B's PUT was
    //     still in flight — this is the assertion that catches the regression.)
    expect(labelsPending()).toBe(true);
    // B's doc must NOT be clobbered by A's dropped retry response.
    expect(labelsGroups()).toEqual([grp("gB", { name: "renamed-B" })]); // B's optimistic
    expect(labelsLastError()).toBeNull();

    // 6b. Settle B's own PUT — now labelsPending clears.
    resolveB(jsonRes(doc(2, [grp("gB", { name: "renamed-B" })])));
    await pB;
    expect(labelsPending()).toBe(false);
    expect(labelsGroups()).toEqual([grp("gB", { name: "renamed-B" })]);
    expect(labelsRevision()).toBe(2);
    expect(labelsLastError()).toBeNull();
  });

  it("after reset, B's labels.snapshot establishes B's state", () => {
    applyLabelsSnapshot(doc(7, [grp("from-A", { roots: ["ra"] })]));
    resetLabelsScope();
    // B's snapshot arrives on B's stream (transport treeGen-guarantees it is B's,
    // not a stale A frame) and is adopted unconditionally as the bootstrap.
    applyLabelsSnapshot(doc(3, [grp("from-B", { roots: ["rb"] })], [tag("tb")], { rb: ["tb"] }));
    expect(labelsConnected()).toBe(true);
    expect(labelsRevision()).toBe(3); // B's own revision domain (3 < A's 7 is fine)
    expect(labelsGroups()).toEqual([grp("from-B", { roots: ["rb" ]})]);
    expect(labelTagIdsByRootSessionId()).toEqual({ rb: ["tb"] });
  });

  it("a late 200 PUT response from A cannot overwrite B (scope-gen guard)", async () => {
    // Project A loaded. User starts a rename; the PUT stays pending. The user
    // switches to B (resetLabelsScope) and B's snapshot establishes B. A's PUT
    // response then resolves — WITHOUT the guard, adoptPutResponse would write
    // A's doc into B's signals. The scope-gen check drops it.
    applyLabelsSnapshot(doc(1, [grp("gA", { name: "A" })]));
    let resolvePut!: (v: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (resolvePut = r))));

    const p = renameGroup("gA", "renamed-A");
    await flush(); // optimistic applied on A; PUT pending
    expect(labelsGroups()[0].name).toBe("renamed-A");

    resetLabelsScope(); // A → B
    applyLabelsSnapshot(doc(4, [grp("gB", { name: "B" })])); // B's snapshot
    expect(labelsGroups()).toEqual([grp("gB", { name: "B" })]);
    expect(labelsRevision()).toBe(4);

    resolvePut(jsonRes(doc(2, [grp("gA", { name: "renamed-A" })]))); // A's late 200
    await p;

    // B intact — A's response was dropped by the scope-gen guard.
    expect(labelsGroups()).toEqual([grp("gB", { name: "B" })]);
    expect(labelsRevision()).toBe(4);
    expect(labelsLastError()).toBeNull();
  });

  it("a late FAILED PUT from A cannot roll back B (scope-gen guard on rollback)", async () => {
    // Same shape, but A's PUT fails (network). Without the guard,
    // rollbackDocIfUnchanged would write A's baseline doc into B's signals.
    applyLabelsSnapshot(doc(1, [grp("gA", { name: "A" })]));
    let rejectPut!: (e: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_, rej) => (rejectPut = rej))));

    const p = renameGroup("gA", "renamed-A");
    await flush();

    resetLabelsScope(); // A → B
    applyLabelsSnapshot(doc(4, [grp("gB", { name: "B" })]));
    expect(labelsGroups()).toEqual([grp("gB", { name: "B" })]);

    rejectPut(new Error("net")); // A's PUT fails after the switch
    await p;

    // B intact — A's rollback was dropped. (No error surfaced either: the late
    // failure belongs to A, not B.)
    expect(labelsGroups()).toEqual([grp("gB", { name: "B" })]);
    expect(labelsRevision()).toBe(4);
    expect(labelsLastError()).toBeNull();
  });

  it("a late 409→retry sequence from A cannot overwrite B (scope-gen guard on retry)", async () => {
    // Project A: a mutation 409s, the facade adopts the 409 authority and issues
    // a retry. The retry stays pending across a switch to B. Both the first-PUT
    // adoption and the retry must be dropped once the scope advanced.
    applyLabelsSnapshot(doc(1, [grp("gA")]));
    let resolveRetry!: (v: Response) => void;
    let firstCall = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        if (firstCall) {
          firstCall = false;
          return Promise.resolve(jsonRes(doc(1, [grp("gA"), grp("gConcurrent")]), 409));
        }
        return new Promise<Response>((r) => (resolveRetry = r));
      }),
    );

    const p = createGroup("Mine", "red"); // 409 → adopt → retry pending
    await flush(); // first PUT resolved (409 adopted), retry issued + pending

    resetLabelsScope(); // A → B (retry still pending)
    applyLabelsSnapshot(doc(4, [grp("gB", { name: "B" })]));
    expect(labelsGroups()).toEqual([grp("gB", { name: "B" })]);

    resolveRetry(jsonRes(doc(2, [grp("gA"), grp("gConcurrent"), grp("lg-x", { name: "Mine" })]))); // A's late retry 200
    await p;

    // B intact — A's retry adoption was dropped by the scope-gen guard.
    expect(labelsGroups()).toEqual([grp("gB", { name: "B" })]);
    expect(labelsRevision()).toBe(4);
    expect(labelsLastError()).toBeNull();
  });

  it("a mutation started AFTER the reset adopts onto the new project's scope", async () => {
    // Sanity: the guard drops only results whose captured gen is STALE. A
    // mutation started on B (after the reset) captures the NEW gen and adopts
    // normally — the guard must not over-fire and block legitimate B mutations.
    applyLabelsSnapshot(doc(1, [grp("gA")]));
    resetLabelsScope(); // A → B
    applyLabelsSnapshot(doc(1, [grp("gB", { name: "B" })]));

    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonRes(doc(2, [grp("gB", { name: "B2" })])))));
    await renameGroup("gB", "B2");

    expect(labelsGroups()).toEqual([grp("gB", { name: "B2" })]);
    expect(labelsRevision()).toBe(2);
  });
});
