// store-merge-property.test.ts — merge-safety property suite over the PURE
// prependMessagesIfAbsent (web/src/lib/reduce.ts), card
// task-2026-11-07t15-07-21-store-merge-verify-first (verify-first stage 1).
// BINDING design basis: tmp/agent-runs/store-merge/eligibility.md (Q4's
// invariant is this suite's contract; Q3's fixture plan is its shape source).
//
// TEST-ONLY slice: ZERO production files are modified by this card. The module
// under test is imported DIRECTLY from production (no jsdom needed — reduce.ts
// is pure/browser-free by contract, its only ambient is TextEncoder).
//
// THE FOUR CLAUSES (eligibility Q4, stated over sm' = merge(sm, items)):
//   (a) NO-DROP — incoming absence never deletes a resident part/message:
//       ∀ m ∈ byId(sm): m ∈ byId(sm') ∧ parts(sm,m) ⊆ parts(sm',m)
//       ∧ order(sm) ⊆ order(sm').
//   (b) NO-CLOBBER — incoming content never overwrites resident content,
//       EXCEPT the completed-upgrade path (incoming(m).time.completed set →
//       terminal/immutable copy is authoritative): ∀ m,p resident before,
//       body(sm',m,p) = body(sm,m,p) unless the exception; likewise the KEYED
//       resident's info. (A keyless shadow's placeholder info MAY be adopted —
//       it holds no live content to clobber.)
//   (c) COMPLETED-AUTHORITY-MONOTONE — resident time.completed never regresses
//       once set: completed(sm,m) ⇒ completed(sm',m) (boolean), and — under
//       this suite's domain premise below — the VALUE is stable.
//   (d) ADMISSION-BOUND — every part that becomes resident comes from the
//       incoming snapshot's parts (new ⊆ incoming) and message order stays
//       created-sorted (order(sm') non-decreasing by info.time?.created, with
//       keyless entries sorting last — sortMessages' ?? Infinity semantics).
//
// DOMAIN PREMISES the generated inputs encode (wire-protocol facts, not test
// conveniences — eligibility Q1 receipts):
//   - time.created is IMMUTABLE per message id (every copy of an id that
//     carries a created carries the SAME created).
//   - time.completed is TERMINAL per message id: an OpenCode message is
//     terminal and immutable once completed (reduce.ts's own
//     upgrade-on-completed rationale), so the generator fixes ONE completed
//     value per id; copies either omit it (pre-completion capture) or carry
//     the canonical value. The (c) VALUE-stability assertion is scoped to
//     this premise; the BOOLEAN monotonicity assertion is not.
//   - part BODIES differ freely between the resident copy and the incoming
//     copy of the same part id (stale page vs live stream) — that divergence
//     is exactly what clause (b) polices.
//   - resident stores are created-sorted with byId-only keyless shadows
//     (upsertPart's placeholder shape: minimal info, never in order).
//
// SURVIVES ADMISSION: the suite is the ACCEPTANCE NET for the later admission
// slice (fill MISSING parts of keyed non-completed residents from the
// incoming copy). The four clauses hold under BOTH boundary shapes — under
// admission only WHICH parts are resident changes (absent → admitted-from-
// incoming), which (a)/(b)/(d) are written to tolerate and (c) never touches.
// The suite deliberately does NOT pin the CURRENT skip (the round-5b pin in
// session-cursor-persistence.test.ts owns that boundary pin and flips
// deliberately when admission lands).
//
// MUTANT DEMONSTRATION (the established test-local pattern — session-cursor-
// mutants.ts precedent; NEVER production edits): each clause has a test-local
// mutant merge (the real merge + one perturbation emulating the corresponding
// production-logic change) that MUST trip its clause — proving the property
// actually detects the violation class it names.
//
// Determinism: seeded mulberry32 PRNG (the in-repo hand-rolled pattern from
// session-cursor-property.test.ts — no new dependencies, no fast-check).
import { describe, expect, it } from "vitest";
import { prependMessagesIfAbsent } from "../../src/lib/reduce";
import type { MessageInfo, Part, SessionMessages } from "../../src/types";

// ── seeded PRNG (mulberry32 — deterministic, dependency-free) ───────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── the generated universe ───────────────────────────────────────────────────
const SID = "s";
const MSG_IDS = ["m0", "m1", "m2", "m3", "m4", "m5"];
const PART_IDS = ["p0", "p1", "p2", "p3"];
// Per-id immutable protocol facts (created / completed), fixed per SEED so a
// whole sweep case shares one coherent universe:
//   created:   a distinct ascending number, or ABSENT (keyless — sorts last).
//   completed: ABSENT (terminal) or a fixed value > created.
interface MsgFacts {
  created?: number;
  completed?: number;
}
function factsFor(rng: () => number): Record<string, MsgFacts> {
  const f: Record<string, MsgFacts> = {};
  MSG_IDS.forEach((id, i) => {
    const keyless = rng() < 0.15;
    const created = 10 * (i + 1) + Math.floor(rng() * 5);
    const done = rng() < 0.35;
    f[id] = keyless
      ? { created: undefined, completed: undefined }
      : { created, completed: done ? created + 100 + Math.floor(rng() * 50) : undefined };
  });
  return f;
}
function infoFor(id: string, f: MsgFacts, withCompleted: boolean): MessageInfo {
  const base: MessageInfo = { id, sessionID: SID, role: rng2role(id) , ...(f.created !== undefined ? { time: { created: f.created } } : {}) };
  if (withCompleted && f.completed !== undefined) {
    base.time = { ...(base.time ?? {}), completed: f.completed };
  }
  return base;
}
function rng2role(_id: string): "user" | "assistant" {
  return _id.charCodeAt(1) % 2 === 0 ? "user" : "assistant";
}
// Part bodies DIVERGE by copy origin (stale page vs live resident) — the
// clause-(b) hazard dimension. `origin` picks the text variant.
function partFor(msgID: string, partID: string, origin: "resident" | "incoming", variant: number): Part {
  return {
    id: partID,
    sessionID: SID,
    messageID: msgID,
    type: "text",
    text: `${origin}-body-${variant}`,
  } as Part;
}

// ── case generation ──────────────────────────────────────────────────────────
interface Case {
  before: SessionMessages;
  items: any[];
}
function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}
function subset<T>(rng: () => number, arr: T[]): T[] {
  return arr.filter(() => rng() < 0.5);
}
function genCase(rng: () => number): Case {
  const facts = factsFor(rng);
  const before: SessionMessages = { order: [], byId: {} };
  const residentIds = new Set(subset(rng, MSG_IDS));
  const keyed: string[] = [];
  for (const id of residentIds) {
    const f = facts[id];
    const pids = subset(rng, PART_IDS);
    const shadow = rng() < 0.3; // byId-only keyless shadow (upsertPart shape)
    if (shadow) {
      // Placeholder info: NO time fields of its own (nothing live to clobber).
      before.byId[id] = {
        id,
        info: { id, sessionID: SID, role: "assistant" },
        partOrder: [...pids],
        parts: Object.fromEntries(pids.map((p) => [p, partFor(id, p, "resident", 1)])),
      };
    } else {
      const withCompleted = f.completed !== undefined && rng() < 0.7;
      before.byId[id] = {
        id,
        info: infoFor(id, f, withCompleted),
        partOrder: [...pids],
        parts: Object.fromEntries(pids.map((p) => [p, partFor(id, p, "resident", 1)])),
      };
      keyed.push(id);
    }
  }
  // Resident order is created-sorted (keyless — none here, shadows never
  // enter order — mirrors sortMessages' semantics on any live store).
  keyed.sort((a, b) => {
    const ka = facts[a].created ?? Infinity;
    const kb = facts[b].created ?? Infinity;
    return ka === kb ? 0 : ka - kb;
  });
  before.order = keyed;

  const items: any[] = [];
  for (const id of subset(rng, MSG_IDS)) {
    const f = facts[id];
    const withCompleted = f.completed !== undefined && rng() < 0.6;
    const pids = subset(rng, PART_IDS);
    items.push({
      info: infoFor(id, f, withCompleted),
      parts: pids.map((p) => partFor(id, p, "incoming", 2)),
    });
    if (rng() < 0.12) {
      // Duplicate id with a different part subset (sequential merge state).
      const pids2 = subset(rng, PART_IDS);
      items.push({
        info: infoFor(id, f, f.completed !== undefined && rng() < 0.2),
        parts: pids2.map((p) => partFor(id, p, "incoming", 3)),
      });
    }
  }
  if (rng() < 0.2) items.push({}); // malformed item (no info) — reducer skips
  // shuffle item order
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return { before, items };
}

// ── the clause checker ───────────────────────────────────────────────────────
// Returns violation strings tagged "(a)".."(d)". Empty ⇔ merge-safe.
function checkMergeSafety(before: SessionMessages, items: any[], after: SessionMessages): string[] {
  const v: string[] = [];
  // Index incoming items: per id → list of items; completed-exception arming.
  const incomingById = new Map<string, any[]>();
  for (const it of items) {
    const info = it?.info;
    if (!info) continue;
    const arr = incomingById.get(info.id) ?? [];
    arr.push(it);
    incomingById.set(info.id, arr);
  }
  const exceptionArmed = (id: string): boolean =>
    (incomingById.get(id) ?? []).some((it) => !!it.info?.time?.completed);
  const incomingPartUnion = (id: string): Set<string> => {
    const s = new Set<string>();
    for (const it of incomingById.get(id) ?? []) {
      for (const p of it.parts || []) s.add(p.id);
    }
    return s;
  };

  // (a) NO-DROP: resident messages/parts/order membership never shrinks.
  for (const [id, mv] of Object.entries(before.byId)) {
    const afterMv = after.byId[id];
    if (!afterMv) {
      v.push(`(a) resident message ${id} dropped`);
      continue;
    }
    for (const pid of Object.keys(mv.parts)) {
      if (!afterMv.parts[pid]) v.push(`(a) resident part ${id}/${pid} dropped`);
    }
  }
  for (const id of before.order) {
    if (!after.order.includes(id)) v.push(`(a) ordered message ${id} left order`);
  }

  // (b) NO-CLOBBER: resident content preserved unless the completed-upgrade
  // exception is armed for that message.
  for (const [id, mv] of Object.entries(before.byId)) {
    if (!incomingById.has(id)) continue; // no incoming copy → untouched by merge
    if (exceptionArmed(id)) continue; // sanctioned upgrade path
    const afterMv = after.byId[id];
    if (!afterMv) continue; // already reported under (a)
    const wasKeyed = before.order.includes(id);
    if (wasKeyed) {
      if (JSON.stringify(mv.info) !== JSON.stringify(afterMv.info)) {
        v.push(`(b) keyed resident ${id} info clobbered`);
      }
    }
    for (const [pid, part] of Object.entries(mv.parts)) {
      const afterPart = afterMv.parts[pid];
      if (!afterPart) continue; // already reported under (a)
      if (JSON.stringify(part) !== JSON.stringify(afterPart)) {
        v.push(`(b) resident part body ${id}/${pid} clobbered`);
      }
    }
  }

  // (c) COMPLETED-AUTHORITY-MONOTONE: once completed, always completed — and
  // (domain premise: completed is terminal per id) the VALUE is stable.
  for (const [id, mv] of Object.entries(before.byId)) {
    const beforeDone = mv.info?.time?.completed;
    if (!beforeDone) continue;
    const afterDone = after.byId[id]?.info?.time?.completed;
    if (!afterDone) {
      v.push(`(c) completed resident ${id} regressed to non-completed`);
    } else if (afterDone !== beforeDone) {
      v.push(`(c) completed value ${id} changed ${beforeDone} → ${afterDone}`);
    }
  }

  // (d) ADMISSION-BOUND: new parts ⊆ incoming parts; order stays
  // created-sorted; partOrder integrity (no dups, set == parts keys).
  for (const [id, afterMv] of Object.entries(after.byId)) {
    const beforeParts = new Set(Object.keys(before.byId[id]?.parts ?? {}));
    const allowed = incomingPartUnion(id);
    for (const pid of Object.keys(afterMv.parts)) {
      if (!beforeParts.has(pid) && !allowed.has(pid)) {
        v.push(`(d) part ${id}/${pid} admitted from a non-incoming source`);
      }
    }
    const seen = new Set<string>();
    for (const pid of afterMv.partOrder) {
      if (seen.has(pid)) v.push(`(d) duplicate partOrder entry ${id}/${pid}`);
      seen.add(pid);
    }
    const keySet = new Set(Object.keys(afterMv.parts));
    if (seen.size !== keySet.size || [...seen].some((pid) => !keySet.has(pid))) {
      v.push(`(d) partOrder/part keys diverge for ${id}`);
    }
  }
  const keyOf = (id: string): number => after.byId[id]?.info?.time?.created ?? Infinity;
  for (let i = 1; i < after.order.length; i++) {
    if (keyOf(after.order[i - 1]) > keyOf(after.order[i])) {
      v.push(`(d) order not created-sorted at ${after.order[i - 1]} > ${after.order[i]}`);
    }
  }
  return v;
}

// ── mutants (test-local substitutions — NEVER production edits) ──────────────
type MergeFn = (sm: SessionMessages, items: any[]) => number;

// MUT-A ≙ a merge that treats the incoming copy's parts as the authoritative
// SET for already-resident messages — incoming ABSENCE deletes resident parts
// (the resurrection hazard inverted: what a delete-replaying source makes safe
// is precisely that the merge itself never deletes).
const mutAbsenceDeletes: MergeFn = (sm, items) => {
  const residentBefore = new Set(Object.keys(sm.byId));
  const added = prependMessagesIfAbsent(sm, items);
  for (const it of items) {
    const info = it?.info;
    if (!info) continue;
    const mv = sm.byId[info.id];
    if (!mv || !residentBefore.has(info.id)) continue;
    const keep = new Set<string>((it.parts || []).map((p: any) => p.id));
    for (const pid of Object.keys(mv.parts)) {
      if (!keep.has(pid)) delete mv.parts[pid];
    }
    mv.partOrder = mv.partOrder.filter((pid) => keep.has(pid));
  }
  return added;
};

// MUT-B ≙ removing the keyed-skip guard (reduce.ts:202-229) / forcing
// assignPresent=true: a NON-completed incoming copy overwrites the resident
// info + part bodies (stale page clobbers the live stream).
const mutStaleClobbersLive: MergeFn = (sm, items) => {
  const residentBefore = new Set(Object.keys(sm.byId));
  const added = prependMessagesIfAbsent(sm, items);
  for (const it of items) {
    const info = it?.info;
    if (!info || info.time?.completed) continue;
    const mv = sm.byId[info.id];
    if (!mv || !residentBefore.has(info.id)) continue;
    if (!sm.order.includes(info.id)) continue; // keyed residents only
    mv.info = info;
    for (const p of it.parts || []) {
      if (mv.parts[p.id]) Object.assign(mv.parts[p.id], p);
    }
  }
  return added;
};

// MUT-C ≙ letting a NON-completed incoming copy overwrite a completed KEYED
// resident's info (dropping the completed-authority guard) — time.completed
// regresses to unset.
const mutUncomplete: MergeFn = (sm, items) => {
  const added = prependMessagesIfAbsent(sm, items);
  for (const it of items) {
    const info = it?.info;
    if (!info || info.time?.completed) continue;
    const mv = sm.byId[info.id];
    if (!mv) continue;
    if (!mv.info?.time?.completed) continue; // only already-completed residents
    mv.info = info;
  }
  return added;
};

// MUT-D1 ≙ admission from a NON-incoming source: the merge fabricates a part
// no incoming copy carried.
const mutFabricatedPart: MergeFn = (sm, items) => {
  const added = prependMessagesIfAbsent(sm, items);
  const id = sm.order[0] ?? Object.keys(sm.byId)[0];
  if (id) {
    const mv = sm.byId[id];
    mv.parts["ghost-fabricated"] = {
      id: "ghost-fabricated",
      sessionID: SID,
      messageID: id,
      type: "text",
      text: "never-shipped",
    } as Part;
    mv.partOrder.push("ghost-fabricated");
  }
  return added;
};

// MUT-D2 ≙ dropping the sortMessages call (reduce.ts:244) after an insert:
// the first ordered id is left at the END → order not created-sorted.
const mutSkipResort: MergeFn = (sm, items) => {
  const added = prependMessagesIfAbsent(sm, items);
  if (sm.order.length >= 2) {
    sm.order.push(sm.order.shift() as string);
  }
  return added;
};

// ── the sweep ────────────────────────────────────────────────────────────────
const SEEDS = 250;
function sweepSquash(merge: MergeFn): { violations: string[]; dirtySeeds: number } {
  const all = new Set<string>();
  let dirty = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const c = genCase(mulberry32(seed));
    const draft = structuredClone(c.before);
    merge(draft, c.items);
    const v = checkMergeSafety(c.before, c.items, draft);
    if (v.length) dirty++;
    for (const x of v) all.add(x.replace(/m\d+|p\d+|→ -?\d+|\d+/g, "#").split(" ").slice(0, 4).join(" "));
  }
  return { violations: [...all], dirtySeeds: dirty };
}

describe("store-merge property suite — the CURRENT (keep-boundary) reducer is merge-safe (card task-2026-11-07t15-07-21-store-merge-verify-first)", () => {
  it("(a)+(b)+(c)+(d): the real prependMessagesIfAbsent satisfies all four clauses on every seed", () => {
    // KILL CRITERION guard: if this fails, a clause discovered a defect in the
    // CURRENT reducer — STOP and report (routes to a new card; do not fix here).
    const { violations, dirtySeeds } = sweepSquash(prependMessagesIfAbsent);
    expect(dirtySeeds).toBe(0);
    expect(violations).toEqual([]);
  });

  describe("mutant demonstrations — each clause's mutant trips it (attribution)", () => {
    // clause → mutant shape → the property that trips (the closeout table's
    // source of truth; each mutant must be DETECTED (≥1 dirty seed) and must
    // trip its INTENDED clause id).
    const table: Array<{ clause: string; mutant: MergeFn; name: string }> = [
      { clause: "(a)", mutant: mutAbsenceDeletes, name: "MUT-A absence-deletes (incoming parts treated as authoritative set)" },
      { clause: "(b)", mutant: mutStaleClobbersLive, name: "MUT-B stale-clobbers-live (keyed-skip guard removed)" },
      { clause: "(c)", mutant: mutUncomplete, name: "MUT-C un-complete (completed authority dropped)" },
      { clause: "(d)", mutant: mutFabricatedPart, name: "MUT-D1 fabricated part (admission from non-incoming source)" },
      { clause: "(d)", mutant: mutSkipResort, name: "MUT-D2 skip re-sort (order left unsorted after insert)" },
    ];
    for (const row of table) {
      it(`${row.name} trips ${row.clause}`, () => {
        const { violations, dirtySeeds } = sweepSquash(row.mutant);
        expect(dirtySeeds).toBeGreaterThan(0);
        expect(violations.some((x) => x.startsWith(row.clause))).toBe(true);
      });
    }
  });
});
