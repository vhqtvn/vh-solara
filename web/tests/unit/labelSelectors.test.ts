// labelSelectors — pure partition of active root sessions into
// pinned / groups / ungrouped sections with tag AND-filtering (slice 5).
//
// These cover the NEW label selectors added to treeSelectors.ts:
// selectLabeledSections, groupOfRoot, tagsOfRoot, matchesAllTags,
// effectiveExpanded, pinnedRootsWithGroupHintFrom, plus the facade-reading
// wrappers groupOf / tagsOf / pinnedRootsWithGroupHint.
//
// Pure-logic tests in the node environment (no jsdom). The facade wrappers are
// smoke-tested by setting state via applyLabelsSnapshot + __resetLabelsForTest.
import { afterEach, describe, expect, it } from "vitest";
import { seedTree } from "../../src/sync/treeMap";
import type { TreeNode, TreeFlatMap } from "../../src/sync/treeMap";
import type { LabelGroup, LabelsDoc } from "../../src/labels";
import { applyLabelsSnapshot, __resetLabelsForTest } from "../../src/labels";
import {
  selectLabeledSections,
  groupOfRoot,
  tagsOfRoot,
  matchesAllTags,
  effectiveExpanded,
  pinnedRootsWithGroupHintFrom,
  groupOf,
  tagsOf,
  pinnedRootsWithGroupHint,
} from "../../src/sync/treeSelectors";

function node(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: "n",
    parentId: null,
    title: "N",
    activity: "idle",
    childCount: 0,
    loaded: true,
    flags: {
      pendingInput: false,
      subtreeNeedsInput: false,
      permission: false,
      archived: false,
      orphan: false,
    },
    updatedMs: 1,
    ...overrides,
  };
}

// A flat tree of independent roots R1..R5 + a nested chain (R → A → B → C) for
// the d_F1 / nested-pin cases.
function sampleMap(): TreeFlatMap {
  return seedTree([
    node({ id: "R1", title: "Root1", updatedMs: 10 }),
    node({ id: "R2", title: "Root2", updatedMs: 20 }),
    node({ id: "R3", title: "Root3", updatedMs: 30 }),
    node({ id: "R4", title: "Root4", updatedMs: 40 }),
    node({ id: "R5", title: "Root5", updatedMs: 50 }),
    // nested chain for d_F1 / deep-pin cases (labels are root-only, but pins
    // may point at nested nodes):
    node({ id: "R", title: "Chain root", updatedMs: 5 }),
    node({ id: "A", parentId: "R", title: "A", updatedMs: 6 }),
    node({ id: "B", parentId: "A", title: "B", updatedMs: 7 }),
    node({ id: "C", parentId: "B", title: "C-deep", updatedMs: 8 }),
  ]);
}

function grp(overrides: Partial<LabelGroup> = {}): LabelGroup {
  return {
    id: "g",
    name: "G",
    color: "#abc",
    collapsed: false,
    orderedRootSessionIds: [],
    ...overrides,
  };
}

// Build a LabelsDoc from pieces (revision + groups + tags + assignments).
function doc(
  groups: LabelGroup[],
  tagIdsByRootSessionId: Record<string, string[]> = {},
  tags: { id: string; name: string; color: string }[] = [],
): LabelsDoc {
  return { revision: 1, groups, tags, tagIdsByRootSessionId };
}

// rankedRoots in a FIXED presentation-rank order (front-first). treeRoots()
// would return roots sorted by shell-owned rank; here we pass an explicit order
// so the ungrouped-order test is deterministic without reading rank state.
function rankedRoots(map: TreeFlatMap, ids: string[]): TreeNode[] {
  return ids.map((id) => map.get(id)!).filter((n) => n != null);
}

// Reset facade signals between cases so the wrapper smoke tests don't leak.
afterEach(() => {
  __resetLabelsForTest();
});

describe("selectLabeledSections — disjoint partition", () => {
  it("no filter, no pins, no groups → all roots ungrouped in ranked order", () => {
    const map = sampleMap();
    const out = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R5", "R3", "R1", "R4", "R2"]),
      pinnedOrder: [],
      doc: doc([]),
      selectedTagIds: [],
    });
    expect(out.pinned).toEqual([]);
    expect(out.groups).toEqual([]);
    expect(out.ungrouped.map((n) => n.id)).toEqual(["R5", "R3", "R1", "R4", "R2"]);
  });

  it("EXCLUSIVE: a root claimed by two groups (malformed doc) lands in only the FIRST group", () => {
    const map = sampleMap();
    const d = doc([
      grp({ id: "g1", orderedRootSessionIds: ["R1", "R2"] }),
      grp({ id: "g2", orderedRootSessionIds: ["R2", "R3"] }), // R2 also here (malformed)
    ]);
    const out = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R2", "R3", "R4", "R5"]),
      pinnedOrder: [],
      doc: d,
      selectedTagIds: [],
    });
    // R2 appears in g1 only.
    expect(out.groups[0].group.id).toBe("g1");
    expect(out.groups[0].roots.map((n) => n.id)).toEqual(["R1", "R2"]);
    expect(out.groups[1].group.id).toBe("g2");
    expect(out.groups[1].roots.map((n) => n.id)).toEqual(["R3"]);
    // R2 is NOT ungrouped (it is claimed by a group).
    expect(out.ungrouped.map((n) => n.id)).toEqual(["R4", "R5"]);
    // Disjointness: no id appears twice across all sections.
    const all = [
      ...out.pinned.map((p) => p.node.id),
      ...out.groups.flatMap((g) => g.roots.map((n) => n.id)),
      ...out.ungrouped.map((n) => n.id),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it("EXCLUSIVE: no root appears in two of {pinned, any group, ungrouped}", () => {
    const map = sampleMap();
    const d = doc([
      grp({ id: "g1", orderedRootSessionIds: ["R1"] }),
      grp({ id: "g2", orderedRootSessionIds: ["R2"] }),
    ]);
    // R1 is in a group AND pinned; R3 is ungrouped AND pinned.
    const out = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R2", "R3", "R4", "R5"]),
      pinnedOrder: ["R1", "R3"],
      doc: d,
      selectedTagIds: [],
    });
    const pinnedIds = new Set(out.pinned.map((p) => p.node.id));
    const groupIds = new Set(out.groups.flatMap((g) => g.roots.map((n) => n.id)));
    const ungroupedIds = new Set(out.ungrouped.map((n) => n.id));
    // R1 + R3 are pinned.
    expect(pinnedIds.has("R1")).toBe(true);
    expect(pinnedIds.has("R3")).toBe(true);
    // Pinned roots are absent from groups + ungrouped.
    expect(groupIds.has("R1")).toBe(false);
    expect(ungroupedIds.has("R3")).toBe(false);
    // g2's R2 survives in its group.
    expect(groupIds.has("R2")).toBe(true);
  });
});

describe("selectLabeledSections — ordering", () => {
  it("groups render in doc.groups array order; roots in each group's orderedRootSessionIds", () => {
    const map = sampleMap();
    const d = doc([
      grp({ id: "gB", name: "B", orderedRootSessionIds: ["R3", "R1"] }),
      grp({ id: "gA", name: "A", orderedRootSessionIds: ["R4", "R2"] }),
    ]);
    const out = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R2", "R3", "R4", "R5"]),
      pinnedOrder: [],
      doc: d,
      selectedTagIds: [],
    });
    expect(out.groups.map((g) => g.group.id)).toEqual(["gB", "gA"]);
    expect(out.groups[0].roots.map((n) => n.id)).toEqual(["R3", "R1"]);
    expect(out.groups[1].roots.map((n) => n.id)).toEqual(["R4", "R2"]);
  });

  it("ungrouped roots render in the passed rankedRoots order (presentation rank reused)", () => {
    const map = sampleMap();
    const d = doc([grp({ id: "g1", orderedRootSessionIds: ["R2"] })]);
    // Deliberately NOT updatedMs-desc to prove no re-sort happens.
    const out = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R4", "R1", "R5", "R3"]),
      pinnedOrder: [],
      doc: d,
      selectedTagIds: [],
    });
    // R2 is grouped; the rest keep their passed order verbatim.
    expect(out.ungrouped.map((n) => n.id)).toEqual(["R4", "R1", "R5", "R3"]);
  });
});

describe("selectLabeledSections — graceful handling of incomplete state", () => {
  it("nonresident ids in a group's ordered list are skipped (reconciliation incomplete)", () => {
    const map = sampleMap();
    // R1 + GHOST are listed; GHOST is not in the map.
    const d = doc([grp({ id: "g1", orderedRootSessionIds: ["R1", "GHOST", "R2"] })]);
    const out = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R2", "R3"]),
      pinnedOrder: [],
      doc: d,
      selectedTagIds: [],
    });
    expect(out.groups[0].roots.map((n) => n.id)).toEqual(["R1", "R2"]);
    // GHOST being nonresident does not demote it to ungrouped (it is claimed).
    expect(out.ungrouped.map((n) => n.id)).toEqual(["R3"]);
  });

  it("a nonresident claimed root is neither grouped nor ungrouped (not invented)", () => {
    const map = sampleMap();
    const d = doc([grp({ id: "g1", orderedRootSessionIds: ["ONLY_GHOST"] })]);
    const out = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R2"]),
      pinnedOrder: [],
      doc: d,
      selectedTagIds: [],
    });
    // The group still renders (no filter → empty groups kept) with no roots.
    expect(out.groups[0].roots).toEqual([]);
    expect(out.ungrouped.map((n) => n.id)).toEqual(["R1", "R2"]);
  });
});

describe("selectLabeledSections — pin / group exactly-once + d_F1 preserved", () => {
  it("a grouped root that is ALSO pinned renders ONLY in the pinned section", () => {
    const map = sampleMap();
    const d = doc([grp({ id: "g1", orderedRootSessionIds: ["R1", "R2"] })]);
    const out = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R2", "R3"]),
      pinnedOrder: ["R1"], // R1 pinned AND in g1
      doc: d,
      selectedTagIds: [],
    });
    expect(out.pinned.map((p) => p.node.id)).toEqual(["R1"]);
    // g1 retains R2 only; R1 is suppressed (pinned wins).
    expect(out.groups[0].roots.map((n) => n.id)).toEqual(["R2"]);
    expect(out.ungrouped.map((n) => n.id)).toEqual(["R3"]);
  });

  it("d_F1 preserved in the labeled context: a pinned descendant of a pinned ancestor is deduped (pinned top-level keeps only the ancestor)", () => {
    const map = sampleMap(); // chain R → A → B → C
    const d = doc([]); // no groups: just exercising the pinned forest
    const out = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R"]),
      pinnedOrder: ["R", "C"], // both R (ancestor) and C (deep descendant) pinned
      doc: d,
      selectedTagIds: [],
    });
    // selectPinnedNodes excludes C (it has pinned ancestor R) → only R surfaces.
    expect(out.pinned.map((p) => p.node.id)).toEqual(["R"]);
    expect(new Set(out.pinned.map((p) => p.node.id)).size).toBe(out.pinned.length);
    // C is not a root, so it never appears in groups/ungrouped regardless.
    expect(out.ungrouped.map((n) => n.id)).toEqual(["R1"]);
  });

  it("a deep pin (no pinned ancestor) still surfaces in the pinned section with its group hint", () => {
    const map = sampleMap(); // chain R → A → B → C
    // C is nested; pin it alone. It is not a root, so no group claims it.
    const d = doc([grp({ id: "g1", orderedRootSessionIds: ["R1"] })]);
    const out = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R"]),
      pinnedOrder: ["C"],
      doc: d,
      selectedTagIds: [],
    });
    expect(out.pinned.map((p) => p.node.id)).toEqual(["C"]);
    expect(out.pinned[0].group).toBeNull(); // C is not a root → no group
  });

  // F1 (filter×pin matrix): a pinned NON-root (deep pin) is DROPPED from the
  // pinned section under an active tag filter. Labels are root-only, so a deep
  // pin can never carry a tag assignment and cannot match a non-empty filter —
  // selectLabeledSections skips it (parentId !== null → continue). With NO
  // filter it still surfaces (the case above); the drop is filter-gated. This
  // is the deterministic proof of the contract the slice-6 e2e also exercises
  // (the e2e is brittle to set up because a non-root must be expanded into the
  // tree map first; the selector logic is fully covered here).
  it("F1: a deep (non-root) pin is dropped from the pinned section under an active filter", () => {
    const map = sampleMap(); // chain R → A → B → C
    const tags = [{ id: "t1", name: "T1", color: "#" }];
    // R (a root) carries t1 so the filter has a matching root; C is the deep pin.
    const d = doc([], { R: ["t1"] }, tags);
    // No filter: C surfaces in pinned.
    const noFilter = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R"]),
      pinnedOrder: ["C"],
      doc: d,
      selectedTagIds: [],
    });
    expect(noFilter.pinned.map((p) => p.node.id)).toEqual(["C"]);
    // Under filter: C (parentId !== null) is dropped from pinned.
    const filtered = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R"]),
      pinnedOrder: ["C"],
      doc: d,
      selectedTagIds: ["t1"],
    });
    expect(filtered.pinned).toEqual([]);
  });
});

describe("selectLabeledSections — AND tag filtering", () => {
  it("a root must carry ALL selected tags (intersection); subset is filtered out", () => {
    const map = sampleMap();
    const tags = [
      { id: "t1", name: "T1", color: "#" },
      { id: "t2", name: "T2", color: "#" },
    ];
    const assign = {
      R1: ["t1"],
      R2: ["t1", "t2"], // carries BOTH → matches
      R3: ["t2"],
      R4: [], // no tags
    };
    const d = doc([], assign, tags);
    const out = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R2", "R3", "R4", "R5"]),
      pinnedOrder: [],
      doc: d,
      selectedTagIds: ["t1", "t2"],
    });
    // Only R2 carries both t1+t2.
    expect(out.ungrouped.map((n) => n.id)).toEqual(["R2"]);
    expect(out.groups).toEqual([]); // no groups defined
  });

  it("empty selectedTagIds = no filter (everything matches)", () => {
    const map = sampleMap();
    const out = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R2"]),
      pinnedOrder: [],
      doc: doc([], { R1: ["t1"] }),
      selectedTagIds: [],
    });
    expect(out.ungrouped.map((n) => n.id)).toEqual(["R1", "R2"]);
  });

  it("a selected tag id no root carries → empty result", () => {
    const map = sampleMap();
    const out = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R2"]),
      pinnedOrder: [],
      doc: doc([], { R1: ["t1"] }, [{ id: "t1", name: "T1", color: "#" }]),
      selectedTagIds: ["t9"], // nobody has t9
    });
    expect(out.ungrouped).toEqual([]);
  });

  it("under filter, a grouped root matching the filter stays in its group (not demoted to ungrouped)", () => {
    const map = sampleMap();
    const tags = [{ id: "t1", name: "T1", color: "#" }];
    const assign = { R1: ["t1"], R2: ["t1"] };
    const d = doc([grp({ id: "g1", orderedRootSessionIds: ["R1", "R2"] })], assign, tags);
    const out = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R2", "R3"]),
      pinnedOrder: [],
      doc: d,
      selectedTagIds: ["t1"],
    });
    expect(out.groups[0].roots.map((n) => n.id)).toEqual(["R1", "R2"]);
    // R3 has no t1 → filtered out of ungrouped entirely (not just hidden).
    expect(out.ungrouped).toEqual([]);
  });
});

describe("selectLabeledSections — empty-group suppression under filter", () => {
  it("under filter, a group with NO matching roots is hidden; without filter the same group is shown", () => {
    const map = sampleMap();
    const tags = [{ id: "t1", name: "T1", color: "#" }];
    // g1 holds R1 (has t1) + R2 (no tags). Under [t1] filter only R1 matches.
    const d = doc([grp({ id: "g1", orderedRootSessionIds: ["R1", "R2"] })], { R1: ["t1"] }, tags);

    const filtered = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R2", "R3"]),
      pinnedOrder: [],
      doc: d,
      selectedTagIds: ["t1"],
    });
    expect(filtered.groups).toHaveLength(1); // g1 retained (R1 matches)
    expect(filtered.groups[0].roots.map((n) => n.id)).toEqual(["R1"]);

    // Now a group with ZERO matching roots (g2 holds only R3, which has no t1).
    const d2 = doc(
      [
        grp({ id: "g1", orderedRootSessionIds: ["R1"] }),
        grp({ id: "g2", orderedRootSessionIds: ["R3"] }),
      ],
      { R1: ["t1"] },
      tags,
    );
    const filtered2 = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R2", "R3"]),
      pinnedOrder: [],
      doc: d2,
      selectedTagIds: ["t1"],
    });
    // g2 suppressed (no matching roots); g1 retained.
    expect(filtered2.groups.map((g) => g.group.id)).toEqual(["g1"]);

    // Same doc WITHOUT filter → both groups shown (empty groups kept).
    const unfiltered = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R2", "R3"]),
      pinnedOrder: [],
      doc: d2,
      selectedTagIds: [],
    });
    expect(unfiltered.groups.map((g) => g.group.id)).toEqual(["g1", "g2"]);
    expect(unfiltered.groups[1].roots).toEqual(["R3"].map((id) => map.get(id)!));
  });
});

describe("effectiveExpanded — temporary unfold under filter", () => {
  const expandedGroup = grp({ id: "g", collapsed: false });
  const collapsedGroup = grp({ id: "g", collapsed: true });

  it("no filter → reflects stored collapse state", () => {
    expect(effectiveExpanded(expandedGroup, false)).toBe(true);
    expect(effectiveExpanded(collapsedGroup, false)).toBe(false);
  });

  it("active filter → ALWAYS expanded (temporary unfold), even when stored collapsed=true", () => {
    expect(effectiveExpanded(expandedGroup, true)).toBe(true);
    expect(effectiveExpanded(collapsedGroup, true)).toBe(true);
  });

  it("does NOT mutate the stored collapsed value (pure — unfold is render-time only)", () => {
    const g = grp({ id: "g", collapsed: true });
    expect(effectiveExpanded(g, true)).toBe(true);
    // The stored value is untouched.
    expect(g.collapsed).toBe(true);
  });
});

describe("selectLabeledSections + pinnedRootsWithGroupHintFrom — group hint", () => {
  it("pinned roots carry their group (color/id) so the UI can show where they return on unpin", () => {
    const map = sampleMap();
    const d = doc([
      grp({ id: "gRed", color: "#f00", orderedRootSessionIds: ["R1"] }),
      grp({ id: "gBlue", color: "#00f", orderedRootSessionIds: ["R2"] }),
    ]);
    // R1 + R2 pinned (and grouped); R3 pinned but ungrouped.
    const out = selectLabeledSections({
      map,
      rankedRoots: rankedRoots(map, ["R1", "R2", "R3"]),
      pinnedOrder: ["R1", "R2", "R3"],
      doc: d,
      selectedTagIds: [],
    });
    const byId = new Map(out.pinned.map((p) => [p.node.id, p.group]));
    expect(byId.get("R1")?.id).toBe("gRed");
    expect(byId.get("R1")?.color).toBe("#f00");
    expect(byId.get("R2")?.id).toBe("gBlue");
    expect(byId.get("R3")).toBeNull(); // ungrouped
  });

  it("pinnedRootsWithGroupHintFrom attaches the hint and is filter-agnostic", () => {
    const map = sampleMap();
    const groups = [
      grp({ id: "g1", orderedRootSessionIds: ["R1"] }),
    ];
    const out = pinnedRootsWithGroupHintFrom(map, ["R1", "R3"], groups);
    expect(out.map((p) => p.node.id)).toEqual(["R1", "R3"]);
    expect(out[0].group?.id).toBe("g1");
    expect(out[1].group).toBeNull();
  });

  it("pinnedRootsWithGroupHintFrom preserves d_F1 (delegates to selectPinnedNodes)", () => {
    const map = sampleMap(); // chain R → A → B → C
    const out = pinnedRootsWithGroupHintFrom(map, ["R", "C"], []);
    expect(out.map((p) => p.node.id)).toEqual(["R"]); // C deduped (pinned ancestor R)
  });
});

// ---- pure helpers ----------------------------------------------------------

describe("groupOfRoot / tagsOfRoot / matchesAllTags — pure helpers", () => {
  it("groupOfRoot returns the FIRST group claiming the root, or null", () => {
    const groups = [
      grp({ id: "g1", orderedRootSessionIds: ["R1", "R2"] }),
      grp({ id: "g2", orderedRootSessionIds: ["R3"] }),
    ];
    expect(groupOfRoot(groups, "R1")?.id).toBe("g1");
    expect(groupOfRoot(groups, "R3")?.id).toBe("g2");
    expect(groupOfRoot(groups, "RX")).toBeNull();
  });

  it("tagsOfRoot returns the assignment or empty; does not expose a shared empty ref", () => {
    const assign = { R1: ["t1", "t2"] };
    expect(tagsOfRoot(assign, "R1")).toEqual(["t1", "t2"]);
    const none = tagsOfRoot(assign, "RX");
    expect(none).toEqual([]);
    // Mutating the unknown-root result must not affect a subsequent call.
    none.push("dirty");
    expect(tagsOfRoot(assign, "RX")).toEqual([]);
  });

  it("matchesAllTags is the AND filter (empty selection = match)", () => {
    const assign = { R1: ["t1", "t2"] };
    expect(matchesAllTags(assign, "R1", [])).toBe(true);
    expect(matchesAllTags(assign, "R1", ["t1"])).toBe(true);
    expect(matchesAllTags(assign, "R1", ["t1", "t2"])).toBe(true);
    expect(matchesAllTags(assign, "R1", ["t1", "t3"])).toBe(false);
    expect(matchesAllTags(assign, "RX", ["t1"])).toBe(false);
    expect(matchesAllTags(assign, "RX", [])).toBe(true);
  });
});

// ---- input immutability ----------------------------------------------------

describe("immutability — selectors never mutate their inputs", () => {
  it("selectLabeledSections does not mutate map / rankedRoots / pinnedOrder / doc / selectedTagIds", () => {
    const map = sampleMap();
    const ranked = rankedRoots(map, ["R1", "R2", "R3", "R4", "R5"]);
    const rankedSnap = ranked.map((n) => ({ ...n }));
    const pinnedOrder = ["R1"];
    const pinnedOrderSnap = [...pinnedOrder];
    const d = doc(
      [grp({ id: "g1", collapsed: true, orderedRootSessionIds: ["R2", "R3"] })],
      { R2: ["t1"] },
      [{ id: "t1", name: "T1", color: "#" }],
    );
    const docSnap: LabelsDoc = {
      revision: d.revision,
      groups: d.groups.map((g) => ({ ...g, orderedRootSessionIds: [...g.orderedRootSessionIds] })),
      tags: [...d.tags],
      tagIdsByRootSessionId: { ...d.tagIdsByRootSessionId },
    };
    const selected = ["t1"];
    const selectedSnap = [...selected];

    selectLabeledSections({
      map,
      rankedRoots: ranked,
      pinnedOrder,
      doc: d,
      selectedTagIds: selected,
    });

    // rankedRoots array + each node identity untouched.
    expect(ranked.map((n) => n.id)).toEqual(rankedSnap.map((n) => n.id));
    // pinnedOrder untouched.
    expect(pinnedOrder).toEqual(pinnedOrderSnap);
    // doc untouched (incl. nested orderedRootSessionIds + collapsed).
    expect(d.revision).toBe(docSnap.revision);
    expect(d.groups).toEqual(docSnap.groups);
    expect(d.groups[0].collapsed).toBe(true);
    expect(d.groups[0].orderedRootSessionIds).toEqual(["R2", "R3"]);
    expect(d.tagIdsByRootSessionId).toEqual(docSnap.tagIdsByRootSessionId);
    // selectedTagIds untouched.
    expect(selected).toEqual(selectedSnap);
    // map node identities unchanged (no node swapped/added/removed).
    const mapIds = [...map.values()].map((n) => n.id).sort();
    const snapIds = [
      "R1", "R2", "R3", "R4", "R5", "R", "A", "B", "C",
    ].sort();
    expect(mapIds).toEqual(snapIds);
  });

  it("groupOfRoot / tagsOfRoot do not mutate their inputs", () => {
    const groups = [grp({ id: "g1", orderedRootSessionIds: ["R1"] })];
    const groupsSnap = groups.map((g) => ({ ...g, orderedRootSessionIds: [...g.orderedRootSessionIds] }));
    const assign = { R1: ["t1"] };
    const assignSnap = { R1: [...assign.R1] };

    groupOfRoot(groups, "R1");
    tagsOfRoot(assign, "R1");
    matchesAllTags(assign, "R1", ["t1"]);

    expect(groups).toEqual(groupsSnap);
    expect(assign).toEqual(assignSnap);
  });
});

// ---- facade-reading wrappers (smoke) ---------------------------------------

describe("groupOf / tagsOf / pinnedRootsWithGroupHint — facade wrappers (smoke)", () => {
  it("groupOf / tagsOf read the live labels facade", () => {
    applyLabelsSnapshot({
      revision: 1,
      groups: [
        { id: "g1", name: "G1", color: "#f00", collapsed: false, orderedRootSessionIds: ["R1"] },
      ],
      tags: [{ id: "t1", name: "T1", color: "#" }],
      tagIdsByRootSessionId: { R1: ["t1"] },
    });
    expect(groupOf("R1")?.id).toBe("g1");
    expect(groupOf("R1")?.color).toBe("#f00");
    expect(groupOf("RX")).toBeNull();
    expect(tagsOf("R1")).toEqual(["t1"]);
    expect(tagsOf("RX")).toEqual([]);
  });

  it("pinnedRootsWithGroupHint reads labelsGroups() and attaches the hint", () => {
    applyLabelsSnapshot({
      revision: 2,
      groups: [
        { id: "g1", name: "G1", color: "#00f", collapsed: false, orderedRootSessionIds: ["R1"] },
      ],
      tags: [],
      tagIdsByRootSessionId: {},
    });
    const map = sampleMap();
    const out = pinnedRootsWithGroupHint(map, ["R1", "R3"]);
    expect(out.map((p) => p.node.id)).toEqual(["R1", "R3"]);
    expect(out[0].group?.id).toBe("g1");
    expect(out[1].group).toBeNull();
  });

  it("returns empty / null before any snapshot is adopted (facade not connected)", () => {
    // __resetLabelsForTest ran in afterEach; state is the empty default here.
    const map = sampleMap();
    expect(groupOf("R1")).toBeNull();
    expect(tagsOf("R1")).toEqual([]);
    expect(pinnedRootsWithGroupHint(map, ["R1"])).toHaveLength(1);
    expect(pinnedRootsWithGroupHint(map, ["R1"])[0].group).toBeNull();
  });
});
