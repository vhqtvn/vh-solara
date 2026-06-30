import { describe, expect, it } from "vitest";
import { mergeLastAgents, epochChanged } from "../../src/sync/stream";

// The agent-label regression fix (Feature 1 / S3). After a server restart the
// daemon serves HTTP while still aggregating session tails, so a mid-hydrate
// tree snapshot carries an INCOMPLETE lastAgents map. The old wholesale-replace
// (`s.lastAgents = {...snap.lastAgents}`) erased correct labels until the next
// FULL snapshot landed. mergeLastAgents keeps any FE entry the incoming
// snapshot omits/empties, so a mid-aggregation snapshot can only ADD/UPDATE
// labels, never wipe them — while a genuine incoming value still wins.

describe("mergeLastAgents (S3 agent-label merge-protect)", () => {
  it("keeps FE entries the incoming snapshot omits (mid-aggregation)", () => {
    // FE already knows "build" for s1; the mid-hydrate snapshot omits s1.
    const merged = mergeLastAgents({ s1: "build", s2: "plan" }, { s2: "plan" });
    expect(merged).toEqual({ s1: "build", s2: "plan" });
  });

  it("incoming non-empty values win over stale FE cache", () => {
    // Aggregation complete: the snapshot now carries the real label for s1.
    const merged = mergeLastAgents({ s1: "build" }, { s1: "ship" });
    expect(merged).toEqual({ s1: "ship" });
  });

  it("treats an empty incoming string as missing (keep FE entry)", () => {
    // A mid-hydrate snapshot may ship `""` rather than omitting the key.
    const merged = mergeLastAgents({ s1: "build" }, { s1: "" });
    expect(merged).toEqual({ s1: "build" });
  });

  it("does not resurrect a session the FE never knew about", () => {
    const merged = mergeLastAgents({ s1: "build" }, { s2: "plan" });
    expect(merged).toEqual({ s1: "build", s2: "plan" });
  });

  it("drops FE entries whose own value is empty (no stale-blank resurrection)", () => {
    const merged = mergeLastAgents({ s1: "", s2: "plan" }, {});
    expect(merged).toEqual({ s2: "plan" });
  });

  it("handles both maps empty", () => {
    expect(mergeLastAgents({}, {})).toEqual({});
  });
});

// Epoch-transition detection (Feature 1 / S3). A changed epoch across a LIVE
// connection means the daemon restarted. The first snapshot after a page load
// (empty prevEpoch) is NOT a transition.

describe("epochChanged (S3 server-restart detection)", () => {
  it("is false when there was no previous epoch (first snapshot after load)", () => {
    expect(epochChanged("", "abc123")).toBe(false);
  });

  it("is false when the incoming epoch is empty (older daemon / omitted)", () => {
    expect(epochChanged("abc123", "")).toBe(false);
  });

  it("is false when both are empty", () => {
    expect(epochChanged("", "")).toBe(false);
  });

  it("is false when the epoch is unchanged (same process)", () => {
    expect(epochChanged("abc123", "abc123")).toBe(false);
  });

  it("is true when a live connection observes a different epoch (restart)", () => {
    expect(epochChanged("abc123", "def456")).toBe(true);
  });
});
