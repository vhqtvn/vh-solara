// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_DIAG_AGE_MS,
  MAX_DIAG_ENTRIES,
  _resetDiagForTest,
  captureDiagEntry,
  diagEntries,
  diagLogEnabled,
  diagLogOn,
  enforceCaps,
  entryLine,
  noteCascadeBoundary,
  noteConnGradeTransition,
  setDiagLogOn,
  type ColdOpenEntry,
} from "../../src/sync/diaglog";

// jsdom provides a real localStorage + window.setTimeout; clear between tests so
// each starts from the default-off, empty-buffer state.
beforeEach(() => {
  localStorage.clear();
  _resetDiagForTest();
});

const e = (ts: number, sid = "s1"): ColdOpenEntry => ({
  kind: "cold-open",
  ts,
  sessionId: sid,
  open: 10,
  snap: 20,
  hydrate: 30,
  fetchMs: 40,
  reconcileMs: 50,
});

describe("diaglog — default OFF = no capture", () => {
  it("is off by default", () => {
    expect(diagLogOn("default")).toBe(false);
    expect(diagLogEnabled()).toBe(false);
  });

  it("captureDiagEntry is a complete no-op when off (no buffer write, no persist)", () => {
    captureDiagEntry(e(1000));
    expect(diagEntries()).toEqual([]);
    expect(localStorage.getItem("vh.diaglog.entries:")).toBeNull();
  });
});

describe("diaglog — enable/disable toggle persists", () => {
  it("setDiagLogOn(true) flips the signal and writes a versioned envelope", () => {
    setDiagLogOn(true);
    expect(diagLogEnabled()).toBe(true);
    expect(diagLogOn("")).toBe(true);
    expect(JSON.parse(localStorage.getItem("vh.diaglog.on:")!)).toEqual({ v: 1, data: true });
  });

  it("setDiagLogOn(false) flips it back and persists", () => {
    setDiagLogOn(true);
    setDiagLogOn(false);
    expect(diagLogEnabled()).toBe(false);
    expect(diagLogOn("")).toBe(false);
    expect(JSON.parse(localStorage.getItem("vh.diaglog.on:")!)).toEqual({ v: 1, data: false });
  });

  it("toggling on then capturing actually appends (end-to-end)", () => {
    setDiagLogOn(true);
    captureDiagEntry(e(1000));
    captureDiagEntry(e(2000, "s2"));
    // (The DiagEntry union also carries stream diag kinds without sessionId;
    // narrow to cold-open for the field read.)
    expect(
      diagEntries().map((x) => [x.ts, x.kind === "cold-open" ? x.sessionId : undefined]),
    ).toEqual([
      [1000, "s1"],
      [2000, "s2"],
    ]);
  });
});

describe("diaglog — max-time eviction", () => {
  it("enforceCaps drops entries older than MAX_DIAG_AGE_MS", () => {
    const now = 1_000_000;
    const fresh = e(now);
    const stale = e(now - MAX_DIAG_AGE_MS - 1);
    expect(enforceCaps([stale, fresh], now)).toEqual([fresh]);
  });

  it("keeps an entry exactly at the age boundary", () => {
    const now = 1_000_000;
    const edge = e(now - MAX_DIAG_AGE_MS);
    expect(enforceCaps([edge], now)).toEqual([edge]);
  });

  it("capture evicts by the entry's own timestamp (age is wall-clock)", () => {
    setDiagLogOn(true);
    captureDiagEntry(e(1000));
    captureDiagEntry(e(2000));
    // A new capture far in the future ages the prior two out.
    const futureTs = 2000 + MAX_DIAG_AGE_MS + 1;
    captureDiagEntry(e(futureTs, "s3"));
    expect(diagEntries().map((x) => (x.kind === "cold-open" ? x.sessionId : undefined))).toEqual(["s3"]);
  });
});

describe("diaglog — max-size eviction", () => {
  it("enforceCaps keeps only the newest MAX_DIAG_ENTRIES", () => {
    const now = 5_000;
    const arr = Array.from({ length: MAX_DIAG_ENTRIES + 3 }, (_, i) => e(now + i, `s${i}`));
    const out = enforceCaps(arr, now + 100_000);
    expect(out.length).toBe(MAX_DIAG_ENTRIES);
    // Oldest three dropped, newest MAX retained, order preserved.
    expect(out[0]).toEqual(arr[3]);
    expect(out[out.length - 1]).toEqual(arr[arr.length - 1]);
  });

  it("capture enforces the size cap on the live buffer", () => {
    setDiagLogOn(true);
    for (let i = 0; i < MAX_DIAG_ENTRIES + 5; i++) captureDiagEntry(e(3000 + i, `s${i}`));
    expect(diagEntries().length).toBe(MAX_DIAG_ENTRIES);
    // Newest survived; oldest evicted.
    const newest = diagEntries()[diagEntries().length - 1];
    expect(newest.kind === "cold-open" && newest.sessionId).toBe(`s${MAX_DIAG_ENTRIES + 4}`);
  });
});

describe("diaglog — foreign / migrated persisted payload recovery", () => {
  it("filters malformed entries out of a legacy (unversioned) buffer on rescope", () => {
    // loadVersioned only runs migrate on a version-skew/legacy payload (a raw
    // non-envelope array), not on a same-version {v,data} envelope (that is
    // trusted verbatim, like store.ts trusts its own sessions payload). So plant
    // a legacy raw array to exercise the validator.
    localStorage.setItem(
      "vh.diaglog.entries:",
      JSON.stringify([
        { bad: true }, // not a diag entry
        { kind: "cold-open", ts: 5, sessionId: "x" }, // valid
        { kind: "cold-open", ts: "no", sessionId: "y" }, // bad ts type
      ]),
    );
    _resetDiagForTest();
    expect(diagEntries().length).toBe(1);
    const kept = diagEntries()[0];
    expect(kept.kind === "cold-open" && kept.sessionId).toBe("x");
  });

  it("an unversioned/foreign entries blob falls back to empty", () => {
    localStorage.setItem("vh.diaglog.entries:", JSON.stringify({ notOurShape: true }));
    _resetDiagForTest();
    expect(diagEntries()).toEqual([]);
  });
});

// entryLine renders the operator-facing diag log line. The previous shape used
// `open=` for the pure-transport field, which read as "total session-open time"
// and sent investigations down the wrong path (16.5s transport was mistaken for
// 16.5s total). The line now leads with `total=` (sum of conn+snap+hydrate for
// cold opens) and labels the transport field `conn=` to match ServersPanel.
describe("diaglog — entryLine rendering", () => {
  it("renders total + conn (not open) and the breakdown fields", () => {
    const line = entryLine({
      kind: "cold-open",
      ts: Date.UTC(2026, 6, 18, 14, 36, 0, 808),
      sessionId: "ses_092bcefffffettkRlJjenuBUOX",
      open: 16540,
      snap: 1,
      hydrate: 4969,
      fetchMs: 4900,
      reconcileMs: 60,
    });
    // total is the sum (16540 + 1 + 4969 = 21510), NOT the misread 16540.
    expect(line).toContain("total=21510");
    // Transport-only field is labeled `conn`, matching ServersPanel; the old
    // `open=` label is GONE so future operators can't misread it as total.
    expect(line).toContain("conn=16540");
    expect(line).not.toMatch(/\bopen=/);
    expect(line).toContain("snap=1");
    expect(line).toContain("hydrate=4969");
    expect(line).toContain("fetch=4900");
    expect(line).toContain("recon=60");
    expect(line).toContain("sess=ses_092bcefffffettkRlJjenuBUOX");
  });

  it("renders — for missing optional fields and omits total when not computable", () => {
    // hydrate missing → total can't be summed (defensive against partial
    // captures); the breakdown fields still render so the operator sees what
    // IS measured.
    const line = entryLine({
      kind: "cold-open",
      ts: 1000,
      sessionId: "s1",
      open: 50,
      snap: 5,
    });
    expect(line).toContain("total=—");
    expect(line).toContain("conn=50");
    expect(line).toContain("hydrate=—");
    expect(line).toContain("fetch=—");
    expect(line).toContain("recon=—");
  });

  it("renders — across the board for a near-empty entry", () => {
    const line = entryLine({ kind: "cold-open", ts: 1, sessionId: "s" });
    expect(line).toContain("total=—");
    expect(line).toContain("conn=—");
    expect(line).toContain("snap=—");
    expect(line).toContain("hydrate=—");
    expect(line).toContain("fetch=—");
    expect(line).toContain("recon=—");
  });

  it("renders — for non-finite numbers (NaN/Infinity), not 'NaN'", () => {
    // A malformed timing value must not leak through as "NaN"/"Infinity" — the
    // operator reads "—" as "no signal", and "NaN" reads as garbage. Guards
    // against typeof === "number" returning true for NaN.
    const line = entryLine({
      kind: "cold-open",
      ts: 1,
      sessionId: "s",
      open: Number.NaN,
      snap: Number.POSITIVE_INFINITY,
      hydrate: -42, // finite but the other legs aren't → total undefinable
      fetchMs: Number.NaN,
      reconcileMs: 5,
    });
    expect(line).toContain("conn=—");
    expect(line).toContain("snap=—");
    expect(line).toContain("total=—"); // NaN + Infinity + (-42) → not finite → —
    expect(line).toContain("fetch=—");
    expect(line).toContain("recon=5"); // finite reconcile still renders
    expect(line).not.toMatch(/\bNaN\b/);
    expect(line).not.toMatch(/\bInfinity\b/);
  });
});

// ── capture-2 stamp kinds (card task-2026-10-29t06-06-05) ───────────────────
// conn-grade (connstatus grade transitions) + cascade (pass-lifecycle
// boundaries) ride the same default-off ring, caps, and validation as the
// b2d3d62 kinds. These tests pin the three ring contracts for them: the
// rendered line, the bounded-emitter gating, and persisted-payload
// validation.
describe("diaglog — conn-grade + cascade kinds (capture-2 stamps)", () => {
  it("entryLine renders grade transitions (init baseline, reasons)", () => {
    // from=null renders as `init` (the observer's baseline evaluation — the
    // helper is safe to call with it even though the observer never stamps it).
    const line = entryLine({ kind: "conn-grade", ts: 1, from: null, to: "live", reasons: [] });
    expect(line).toContain("conn-grade init→live");
    expect(line).not.toContain("reason=");
    const withReason = entryLine({
      kind: "conn-grade",
      ts: 1,
      from: "live",
      to: "reconnecting",
      reasons: ["convergence-pending"],
    });
    expect(withReason).toContain("conn-grade live→reconnecting reason=convergence-pending");
    const multi = entryLine({ kind: "conn-grade", ts: 1, from: "reconnecting", to: "degraded", reasons: ["tree-stale", "fetch-failure-spike"] });
    expect(multi).toContain("reason=tree-stale+fetch-failure-spike");
  });

  it("entryLine renders cascade boundaries (stream/reasons/pending/elapsed)", () => {
    const timeout = entryLine({
      kind: "cascade",
      ts: 1,
      event: "pass-timeout",
      reasons: ["tree-seq-gap"],
      pending: ["tree"],
      elapsedMs: 15000,
    });
    expect(timeout).toContain("cascade event=pass-timeout");
    expect(timeout).toContain("reasons=tree-seq-gap");
    expect(timeout).toContain("pending=tree");
    expect(timeout).toContain("elapsed=15000");
    const step = entryLine({ kind: "cascade", ts: 1, event: "step-converged", stream: "session" });
    expect(step).toContain("cascade event=step-converged stream=session");
    // elapsed renders human-compact like the other diag lines (fmtMs).
    const human = entryLine({ kind: "cascade", ts: 1, event: "pass-converged", reasons: ["x"], elapsedMs: 2400 });
    expect(human).toMatch(/elapsed=/);
  });

  it("the bounded emitters capture when on, no-op when off, and skip vacuous transitions", () => {
    setDiagLogOn(true);
    noteConnGradeTransition("live", "reconnecting", ["socket-reconnecting"]);
    noteConnGradeTransition("reconnecting", "reconnecting", []); // vacuous — skipped
    noteCascadeBoundary("pass-start", { reasons: ["tree-seq-gap"], pending: ["tree"] });
    expect(diagEntries()).toHaveLength(2);
    expect(diagEntries().map((x) => x.kind)).toEqual(["conn-grade", "cascade"]);

    setDiagLogOn(false);
    noteConnGradeTransition("reconnecting", "live", []);
    noteCascadeBoundary("pass-converged", {});
    expect(diagEntries()).toHaveLength(2); // no writes while off
  });

  it("persisted-payload validation accepts the new kinds and drops malformed ones", () => {
    // loadVersioned only runs the isDiagEntry filter on a LEGACY raw array
    // (same-version envelopes are trusted verbatim) — plant one.
    localStorage.setItem(
      "vh.diaglog.entries:",
      JSON.stringify([
        { kind: "conn-grade", ts: 5, from: "live", to: "degraded", reasons: ["tree-stale"] },
        { kind: "cascade", ts: 6, event: "pass-timeout", reasons: ["x"], pending: ["tree"], elapsedMs: 15 },
        { kind: "conn-grade", ts: 7 }, // malformed: no `to`
        { kind: "cascade", ts: 8 }, // malformed: no `event`
      ]),
    );
    _resetDiagForTest();
    expect(diagEntries()).toHaveLength(2);
    expect(diagEntries()[0].kind).toBe("conn-grade");
    expect(diagEntries()[1].kind).toBe("cascade");
  });
});
