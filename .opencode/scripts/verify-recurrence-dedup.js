/**
 * P1-MEMORY-001 Slice 3 — WRITE-PATH dedup crux verification.
 *
 * Exercises saveCoordinationTask end-to-end against the REAL Go binary
 * (`vh-agent-harness recurrence dedup`) to prove the producer correctly
 * applies the recurrence dedup decision at the task-writing boundary:
 *
 *   1. MERGE: an incoming card whose recurrence_id matches an existing
 *      canonical → the producer updates the canonical (count N→N+1,
 *      observation appended, ack held → unacknowledged) and does NOT spawn a
 *      new card.
 *   2. NEW CARD: an incoming card with a new recurrence_id → a new card is
 *      written normally.
 *   3. LEGACY: an incoming card with no recurrence block → written normally.
 *   4. VALIDATION: a malformed recurrence block (missing counts, ack-pair
 *      invariant violation, bad symptom_class_id pattern, numeric
 *      recurrence_id, unknown evidence property, non-boolean alias
 *      superseded) → REJECTED at the write boundary so no durable card
 *      carries an invalid block.
 *   5. NULL REMOVAL: saving a card with `recurrence: null` removes the
 *      recurrence property entirely (schema requires type:object; null
 *      is not a valid value) — no schema-invalid `recurrence: null`
 *      reaches disk.
 *   6. ALIAS PROMOTION: an incoming card whose recurrence_id differs from
 *      the canonical but declares an alias pointing at the canonical →
 *      merges (identity re-pointed), and a LATER repeat using the new id
 *      (no alias) still finds the SAME canonical (N→1 holds).
 *   7. BRIDGE FAILURE (fail-closed): when the Go binary is unavailable,
 *      saving a recurrence-bearing card THROWS instead of silently spawning
 *      a duplicate — N→1 invariant preserved even under bridge failure.
 *   8. TOCTOU RE-RESOLVE→THROW (deterministic guard exercise): a narrow
 *      per-call test seam (_testPreLockInterleave) fires ONE ordinary nested
 *      saveCoordinationTask at the after-decision/before-lock boundary that
 *      re-identifies + bumps the canonical in the scan→lock window; the outer
 *      repeat then acquires the real lock, reloads the changed canonical,
 *      re-resolves via the REAL Go binary, and THROWS before persisting — no
 *      stale outer write, no duplicate card, no lost observation. Exercises
 *      the producer's lock-time re-resolve guard wiring deterministically
 *      (closes the testable slice of defer-recurrence-toctou-race).
 *
 * Invoke via:
 *   vh-agent-harness exec node .opencode/scripts/verify-recurrence-dedup.js
 *
 * The binary is resolved/built automatically; set VH_AGENT_HARNESS_BIN to
 * override.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "node:child_process";
import {
    repoRoot,
    bindSessionName,
    saveCoordinationTask,
} from "./state-lib.js";

const REPO = repoRoot();
const BIN = path.join(REPO, "bin", "vh-agent-harness");
const TASKS_DIR = path.join(REPO, ".local", "coordinator", "tasks");

const SESSION_ID = "verify-recurrence-dedup-session";
const ALIAS = "verify-recurrence-dedup";

const PROBE_IDS = [
    "verify-recurrence-canonical",
    "verify-recurrence-repeat",
    "verify-recurrence-new",
    "verify-recurrence-legacy",
    "verify-recurrence-badcounts",
    "verify-recurrence-badpattern",
    "verify-recurrence-missingcounts",
    "verify-recurrence-numericrid",
    "verify-recurrence-extraevidence",
    "verify-recurrence-badalias",
    "verify-recurrence-removal",
    "verify-recurrence-alias-canonical",
    "verify-recurrence-alias-repeat1",
    "verify-recurrence-alias-repeat2",
    "verify-recurrence-bridgefail",
    "verify-recurrence-toctou-canon",
    "verify-recurrence-toctou-outer",
];

function taskPath(id) {
    return path.join(TASKS_DIR, `${id}.json`);
}

function ensureBinary() {
    const envBin = (process.env.VH_AGENT_HARNESS_BIN || "").trim();
    if (envBin) return envBin;
    if (fs.existsSync(BIN)) return BIN;
    // Build on demand so the verify script is self-sufficient.
    execFileSync("go", ["build", "-o", BIN, "./cmd/vh-agent-harness"], {
        cwd: REPO,
        stdio: "pipe",
    });
    return BIN;
}

function cleanup() {
    for (const id of PROBE_IDS) {
        const p = taskPath(id);
        if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(`FAIL: ${msg}`);
}

function readTask(id) {
    return JSON.parse(fs.readFileSync(taskPath(id), "utf8"));
}

function main() {
    const bin = ensureBinary();
    process.env.VH_AGENT_HARNESS_BIN = bin;

    bindSessionName(SESSION_ID, ALIAS, { cwd: "/verification" });
    cleanup();

    try {
        // === Scenario 1: MERGE (the WRITE-LAYER crux) ===
        // Create a canonical card with recurrence_id R1 (count=1, ack=1).
        const canonical = saveCoordinationTask(SESSION_ID, {
            task_id: "verify-recurrence-canonical",
            title: "Canonical recurrence card",
            task_type: "implementation",
            coordination_mode: "short",
            primary_lane: "substrate",
            files_in_scope: ["tmp/"],
            success_criteria: ["Canonical recurrence card exists."],
            validation_plan: ["Verify card on disk."],
            status: "ready",
            recurrence: {
                recurrence_id: "R1",
                symptom_class_id: "recurrence.v1/class-a",
                recurrence_count: 1,
                last_acknowledged_count: 1,
                evidence: [{ kind: "path", ref: "src/canonical.go" }],
                aliases: [],
            },
        });
        assert(canonical.created === true, "canonical should be created (new)");
        assert(
            canonical.task.recurrence.recurrence_count === 1,
            "canonical initial count = 1",
        );

        // Save a repeat: same recurrence_id R1, different task_id.
        const repeat = saveCoordinationTask(SESSION_ID, {
            task_id: "verify-recurrence-repeat",
            title: "Repeat of canonical",
            task_type: "implementation",
            coordination_mode: "short",
            primary_lane: "substrate",
            files_in_scope: ["tmp/"],
            success_criteria: ["Repeat merges into canonical."],
            validation_plan: ["Verify no new card spawned."],
            status: "ready",
            recurrence: {
                recurrence_id: "R1",
                symptom_class_id: "recurrence.v1/class-a",
                recurrence_count: 1,
                last_acknowledged_count: 1,
                evidence: [{ kind: "path", ref: "src/repeat.go" }],
                aliases: [],
            },
        });

        // --- Crux assertions (outcome-observed) ---
        assert(
            repeat.created === false,
            "MERGE: repeat must NOT spawn a new card (created=false)",
        );
        assert(
            repeat.merged_into === "verify-recurrence-canonical",
            `MERGE: merged_into must be the canonical id, got ${repeat.merged_into}`,
        );
        assert(
            repeat.task.recurrence.recurrence_count === 2,
            `MERGE: count must be 2 (1→N+1), got ${repeat.task.recurrence.recurrence_count}`,
        );
        assert(
            repeat.task.recurrence.last_acknowledged_count === 1,
            `MERGE: ack held at 1 (→ unacknowledged: 2 > 1), got ${repeat.task.recurrence.last_acknowledged_count}`,
        );

        // The repeat card must NOT exist on disk (no spawn).
        assert(
            !fs.existsSync(taskPath("verify-recurrence-repeat")),
            "MERGE: repeat card must NOT exist on disk (no spawn)",
        );

        // Canonical on disk: updated recurrence block.
        const canonicalOnDisk = readTask("verify-recurrence-canonical");
        assert(
            canonicalOnDisk.recurrence.recurrence_count === 2,
            `MERGE: canonical on disk count=2, got ${canonicalOnDisk.recurrence.recurrence_count}`,
        );
        assert(
            canonicalOnDisk.recurrence.last_acknowledged_count === 1,
            `MERGE: canonical on disk ack=1 (unacknowledged), got ${canonicalOnDisk.recurrence.last_acknowledged_count}`,
        );

        // The recurrence_observation evidence must be attributable to the repeat.
        const obsEvidence = canonicalOnDisk.recurrence.evidence.filter(
            (e) =>
                e.kind === "recurrence_observation" &&
                e.ref === "verify-recurrence-repeat",
        );
        assert(
            obsEvidence.length === 1,
            `MERGE: recurrence_observation ref=verify-recurrence-repeat expected 1 entry, got ${obsEvidence.length}`,
        );

        // The repeat's folded evidence (src/repeat.go) must be present.
        const hasFoldedEvidence = canonicalOnDisk.recurrence.evidence.some(
            (e) => e.kind === "path" && e.ref === "src/repeat.go",
        );
        assert(
            hasFoldedEvidence,
            "MERGE: incoming evidence (src/repeat.go) must fold into canonical",
        );

        // History must include a recurrence_merged event.
        const mergeEvents = canonicalOnDisk.history.filter(
            (h) => h.event === "recurrence_merged",
        );
        assert(
            mergeEvents.length === 1,
            `MERGE: recurrence_merged history event expected 1, got ${mergeEvents.length}`,
        );

        // === Scenario 2: NEW CARD (no match) ===
        const fresh = saveCoordinationTask(SESSION_ID, {
            task_id: "verify-recurrence-new",
            title: "New recurrence defect",
            task_type: "implementation",
            coordination_mode: "short",
            primary_lane: "substrate",
            files_in_scope: ["tmp/"],
            success_criteria: ["New recurrence card exists."],
            validation_plan: ["Verify card on disk."],
            status: "ready",
            recurrence: {
                recurrence_id: "R2",
                symptom_class_id: "recurrence.v1/class-b",
                recurrence_count: 1,
                last_acknowledged_count: 0,
            },
        });
        assert(
            fresh.created === true,
            "NEW CARD: new recurrence_id must create a new card",
        );
        assert(
            !fresh.merged_into,
            "NEW CARD: must not have merged_into",
        );
        assert(
            fresh.task.recurrence.recurrence_id === "R2",
            "NEW CARD: recurrence block persisted (R2)",
        );
        assert(
            fs.existsSync(taskPath("verify-recurrence-new")),
            "NEW CARD: card exists on disk",
        );

        // === Scenario 3: LEGACY (no recurrence block) ===
        const legacy = saveCoordinationTask(SESSION_ID, {
            task_id: "verify-recurrence-legacy",
            title: "Legacy card (no recurrence)",
            task_type: "implementation",
            coordination_mode: "short",
            primary_lane: "substrate",
            files_in_scope: ["tmp/"],
            success_criteria: ["Legacy card exists."],
            validation_plan: ["Verify card on disk."],
            status: "ready",
        });
        assert(
            legacy.created === true,
            "LEGACY: card without recurrence block must be created",
        );
        assert(
            !legacy.merged_into,
            "LEGACY: must not have merged_into",
        );
        assert(
            fs.existsSync(taskPath("verify-recurrence-legacy")),
            "LEGACY: card exists on disk",
        );

        // === Scenario 4: WRITE-BOUNDARY VALIDATION (reject malformed recurrence) ===
        // The producer must NOT persist a recurrence block that violates the
        // schema contract (task-card.schema.json:304-395). A partial or
        // invariant-violating block is rejected at the write boundary so no
        // durable card carries an invalid acknowledgement pair.

        // 4a: missing counts (only recurrence_id + symptom_class_id)
        let threwMissingCounts = false;
        try {
            saveCoordinationTask(SESSION_ID, {
                task_id: "verify-recurrence-missingcounts",
                title: "Bad recurrence (missing counts)",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "substrate",
                files_in_scope: ["tmp/"],
                success_criteria: ["Card rejected."],
                validation_plan: ["Verify no card on disk."],
                status: "ready",
                recurrence: {
                    recurrence_id: "R-BAD-MISSING",
                    symptom_class_id: "recurrence.v1/class-a",
                },
            });
        } catch (_) {
            threwMissingCounts = true;
        }
        assert(
            threwMissingCounts,
            "VALIDATION 4a: recurrence missing counts must be REJECTED at write boundary",
        );
        assert(
            !fs.existsSync(taskPath("verify-recurrence-missingcounts")),
            "VALIDATION 4a: rejected card must NOT exist on disk",
        );

        // 4b: recurrence_count < last_acknowledged_count (invariant violation)
        let threwBadCounts = false;
        try {
            saveCoordinationTask(SESSION_ID, {
                task_id: "verify-recurrence-badcounts",
                title: "Bad recurrence (count < ack)",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "substrate",
                files_in_scope: ["tmp/"],
                success_criteria: ["Card rejected."],
                validation_plan: ["Verify no card on disk."],
                status: "ready",
                recurrence: {
                    recurrence_id: "R-BAD-COUNTS",
                    symptom_class_id: "recurrence.v1/class-a",
                    recurrence_count: 1,
                    last_acknowledged_count: 3,
                },
            });
        } catch (_) {
            threwBadCounts = true;
        }
        assert(
            threwBadCounts,
            "VALIDATION 4b: recurrence_count < last_acknowledged_count must be REJECTED (ack-pair invariant)",
        );
        assert(
            !fs.existsSync(taskPath("verify-recurrence-badcounts")),
            "VALIDATION 4b: rejected card must NOT exist on disk",
        );

        // 4c: bad symptom_class_id pattern (does not match ^recurrence\.v1/.+$)
        let threwBadPattern = false;
        try {
            saveCoordinationTask(SESSION_ID, {
                task_id: "verify-recurrence-badpattern",
                title: "Bad recurrence (bad pattern)",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "substrate",
                files_in_scope: ["tmp/"],
                success_criteria: ["Card rejected."],
                validation_plan: ["Verify no card on disk."],
                status: "ready",
                recurrence: {
                    recurrence_id: "R-BAD-PATTERN",
                    symptom_class_id: "NOT-A-VALID-PATTERN",
                    recurrence_count: 1,
                    last_acknowledged_count: 0,
                },
            });
        } catch (_) {
            threwBadPattern = true;
        }
        assert(
            threwBadPattern,
            "VALIDATION 4c: bad symptom_class_id pattern must be REJECTED",
        );
        assert(
            !fs.existsSync(taskPath("verify-recurrence-badpattern")),
            "VALIDATION 4c: rejected card must NOT exist on disk",
        );

        // 4d: numeric recurrence_id (schema requires string; no type coercion)
        let threwNumericRid = false;
        try {
            saveCoordinationTask(SESSION_ID, {
                task_id: "verify-recurrence-numericrid",
                title: "Bad recurrence (numeric rid)",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "substrate",
                files_in_scope: ["tmp/"],
                success_criteria: ["Card rejected."],
                validation_plan: ["Verify no card on disk."],
                status: "ready",
                recurrence: {
                    recurrence_id: 7,
                    symptom_class_id: "recurrence.v1/class-a",
                    recurrence_count: 1,
                    last_acknowledged_count: 0,
                },
            });
        } catch (_) {
            threwNumericRid = true;
        }
        assert(
            threwNumericRid,
            "VALIDATION 4d: numeric recurrence_id must be REJECTED (schema requires string)",
        );
        assert(
            !fs.existsSync(taskPath("verify-recurrence-numericrid")),
            "VALIDATION 4d: rejected card must NOT exist on disk",
        );

        // 4e: unknown property on evidence item (additionalProperties: false)
        let threwExtraEvidence = false;
        try {
            saveCoordinationTask(SESSION_ID, {
                task_id: "verify-recurrence-extraevidence",
                title: "Bad recurrence (extra evidence key)",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "substrate",
                files_in_scope: ["tmp/"],
                success_criteria: ["Card rejected."],
                validation_plan: ["Verify no card on disk."],
                status: "ready",
                recurrence: {
                    recurrence_id: "R-BAD-EXTRA-EVID",
                    symptom_class_id: "recurrence.v1/class-a",
                    recurrence_count: 1,
                    last_acknowledged_count: 0,
                    evidence: [
                        { kind: "path", ref: "src/x.go", unexpected: true },
                    ],
                },
            });
        } catch (_) {
            threwExtraEvidence = true;
        }
        assert(
            threwExtraEvidence,
            "VALIDATION 4e: unknown evidence property must be REJECTED (additionalProperties: false)",
        );
        assert(
            !fs.existsSync(taskPath("verify-recurrence-extraevidence")),
            "VALIDATION 4e: rejected card must NOT exist on disk",
        );

        // 4f: non-boolean alias superseded (schema requires boolean)
        let threwBadAlias = false;
        try {
            saveCoordinationTask(SESSION_ID, {
                task_id: "verify-recurrence-badalias",
                title: "Bad recurrence (non-boolean superseded)",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "substrate",
                files_in_scope: ["tmp/"],
                success_criteria: ["Card rejected."],
                validation_plan: ["Verify no card on disk."],
                status: "ready",
                recurrence: {
                    recurrence_id: "R-BAD-ALIAS",
                    symptom_class_id: "recurrence.v1/class-a",
                    recurrence_count: 1,
                    last_acknowledged_count: 0,
                    aliases: [
                        { recurrence_id: "R-OLD", superseded: "true" },
                    ],
                },
            });
        } catch (_) {
            threwBadAlias = true;
        }
        assert(
            threwBadAlias,
            "VALIDATION 4f: non-boolean alias.superseded must be REJECTED (schema requires boolean)",
        );
        assert(
            !fs.existsSync(taskPath("verify-recurrence-badalias")),
            "VALIDATION 4f: rejected card must NOT exist on disk",
        );

        // === Scenario 5: NULL REMOVAL (regression for recurrence: null) ===
        // Create a card with a valid recurrence block, then save it again
        // with `recurrence: null`. The persisted card must NOT carry a
        // `recurrence` property at all (the schema requires type:object;
        // null is schema-invalid).
        const withRec = saveCoordinationTask(SESSION_ID, {
            task_id: "verify-recurrence-removal",
            title: "Card with recurrence to be removed",
            task_type: "implementation",
            coordination_mode: "short",
            primary_lane: "substrate",
            files_in_scope: ["tmp/"],
            success_criteria: ["Recurrence removed cleanly."],
            validation_plan: ["Verify no recurrence property on disk."],
            status: "ready",
            recurrence: {
                recurrence_id: "R-REMOVE",
                symptom_class_id: "recurrence.v1/class-a",
                recurrence_count: 1,
                last_acknowledged_count: 1,
            },
        });
        assert(
            withRec.task.recurrence !== undefined &&
                withRec.task.recurrence !== null,
            "NULL-REMOVAL 5a: card initially has a recurrence block",
        );
        // Now save the same card with recurrence: null (removal).
        const removed = saveCoordinationTask(SESSION_ID, {
            task_id: "verify-recurrence-removal",
            title: "Card with recurrence to be removed",
            task_type: "implementation",
            coordination_mode: "short",
            primary_lane: "substrate",
            files_in_scope: ["tmp/"],
            success_criteria: ["Recurrence removed cleanly."],
            validation_plan: ["Verify no recurrence property on disk."],
            status: "ready",
            recurrence: null,
        });
        // The returned task must not carry recurrence.
        assert(
            removed.task.recurrence === undefined,
            "NULL-REMOVAL 5b: returned task must NOT have recurrence (null = removal)",
        );
        // The on-disk JSON must not contain a `recurrence` key at all.
        const onDisk = readTask("verify-recurrence-removal");
        assert(
            !("recurrence" in onDisk),
            "NULL-REMOVAL 5c: on-disk JSON must NOT contain a `recurrence` key (schema-invalid if null)",
        );

        // === Scenario 6: ALIAS PROMOTION (re-point identity regression) ===
        // An incoming card with recurrence_id R3 and aliases:[{R4}] against
        // an existing canonical with R4 → merges, identity re-pointed to R3.
        // A later R3 repeat (no alias) must STILL merge into the same card.
        // This proves the N→1 invariant across a concrete write sequence.
        saveCoordinationTask(SESSION_ID, {
            task_id: "verify-recurrence-alias-canonical",
            title: "Alias-promotion canonical (R4)",
            task_type: "implementation",
            coordination_mode: "short",
            primary_lane: "substrate",
            files_in_scope: ["tmp/"],
            success_criteria: ["Alias promotion works."],
            validation_plan: ["Verify single canonical after all merges."],
            status: "ready",
            recurrence: {
                recurrence_id: "R4",
                symptom_class_id: "recurrence.v1/class-a",
                recurrence_count: 1,
                last_acknowledged_count: 1,
            },
        });
        // Repeat 1: R3 with alias R4 → merges, identity re-pointed to R3.
        const aliasMerge1 = saveCoordinationTask(SESSION_ID, {
            task_id: "verify-recurrence-alias-repeat1",
            title: "Alias-promotion repeat 1 (R3 aliases R4)",
            task_type: "implementation",
            coordination_mode: "short",
            primary_lane: "substrate",
            files_in_scope: ["tmp/"],
            success_criteria: ["Alias promotion works."],
            validation_plan: ["Verify single canonical."],
            status: "ready",
            recurrence: {
                recurrence_id: "R3",
                symptom_class_id: "recurrence.v1/class-a",
                recurrence_count: 1,
                last_acknowledged_count: 1,
                aliases: [{ recurrence_id: "R4" }],
            },
        });
        assert(
            aliasMerge1.created === false,
            "ALIAS-PROMO 6a: repeat 1 must merge (created=false), not spawn",
        );
        assert(
            aliasMerge1.task.recurrence.recurrence_id === "R3",
            "ALIAS-PROMO 6b: merged canonical recurrence_id re-pointed to R3",
        );
        assert(
            aliasMerge1.task.recurrence.recurrence_count === 2,
            "ALIAS-PROMO 6c: count = 2 (1→2 after first merge)",
        );
        // Repeat 2: R3 (no alias) → must STILL merge into the same canonical.
        const aliasMerge2 = saveCoordinationTask(SESSION_ID, {
            task_id: "verify-recurrence-alias-repeat2",
            title: "Alias-promotion repeat 2 (R3 no alias)",
            task_type: "implementation",
            coordination_mode: "short",
            primary_lane: "substrate",
            files_in_scope: ["tmp/"],
            success_criteria: ["Alias promotion works."],
            validation_plan: ["Verify single canonical."],
            status: "ready",
            recurrence: {
                recurrence_id: "R3",
                symptom_class_id: "recurrence.v1/class-a",
                recurrence_count: 1,
                last_acknowledged_count: 1,
            },
        });
        assert(
            aliasMerge2.created === false,
            "ALIAS-PROMO 6d: repeat 2 (R3 no alias) must merge, not spawn a 2nd card",
        );
        assert(
            aliasMerge2.task.recurrence.recurrence_count === 3,
            "ALIAS-PROMO 6e: count = 3 (2→3 after second merge)",
        );
        // No spawn: the repeat cards must NOT exist on disk.
        assert(
            !fs.existsSync(taskPath("verify-recurrence-alias-repeat1")),
            "ALIAS-PROMO 6f: repeat 1 card must NOT exist (merged, not spawned)",
        );
        assert(
            !fs.existsSync(taskPath("verify-recurrence-alias-repeat2")),
            "ALIAS-PROMO 6g: repeat 2 card must NOT exist (merged, not spawned)",
        );

        // === Scenario 7: BRIDGE FAILURE (fail-closed regression) ===
        // When the Go binary is unavailable, saving a recurrence-bearing card
        // must THROW instead of silently spawning a duplicate (fail-open to
        // new_card would violate N→1). Set VH_AGENT_HARNESS_BIN to a
        // non-existent path so execFileSync fails.
        const savedBin = process.env.VH_AGENT_HARNESS_BIN;
        process.env.VH_AGENT_HARNESS_BIN = "/nonexistent/vh-agent-harness";
        let bridgeThrew = false;
        try {
            saveCoordinationTask(SESSION_ID, {
                task_id: "verify-recurrence-bridgefail",
                title: "Bridge failure card",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "substrate",
                files_in_scope: ["tmp/"],
                success_criteria: ["Should not be saved."],
                validation_plan: ["Verify no card on disk."],
                status: "ready",
                recurrence: {
                    recurrence_id: "R-BRIDGE-FAIL",
                    symptom_class_id: "recurrence.v1/class-a",
                    recurrence_count: 1,
                    last_acknowledged_count: 1,
                },
            });
        } catch (_) {
            bridgeThrew = true;
        }
        // Restore the real binary for any subsequent operations.
        process.env.VH_AGENT_HARNESS_BIN = savedBin;
        assert(
            bridgeThrew,
            "BRIDGE-FAIL 7a: recurrence save with unavailable binary must THROW (fail-closed, not fail-open to new_card)",
        );
        assert(
            !fs.existsSync(taskPath("verify-recurrence-bridgefail")),
            "BRIDGE-FAIL 7b: no card must exist on disk (save aborted, not spawned as new_card)",
        );

        // === Scenario 8: TOCTOU re-resolve → throw guard (deterministic) ===
        // Closes the testable slice of defer-recurrence-toctou-race. The
        // lock-time re-resolve→throw guard (state-lib.js saveCoordinationTask
        // merge path) is structurally unreachable in single-threaded runs
        // because nothing mutates the canonical in the scan→lock window. A
        // narrow per-call test seam (_testPreLockInterleave) fires ONE
        // ordinary nested saveCoordinationTask (real producer, hook NOT
        // propagated) at the after-decision/before-lock boundary. The nested
        // save re-identifies + bumps the canonical's recurrence block
        // (count 1→2, R8→R8-OTHER) so the outer's lock-time state has
        // diverged from its pre-lock merged block. The outer then acquires
        // the real lock, reloads the changed canonical, re-resolves via the
        // REAL Go binary, and THROWS before atomicWriteJson (fail-closed: no
        // stale outer write, no duplicate, no lost observation).
        //
        // This exercises scan→lock→reload→re-resolve→throw deterministically.
        // It does NOT test scheduler fairness or real lock contention (out of
        // scope — those remain on the broader defer card).
        const toctouCanonId = "verify-recurrence-toctou-canon";
        const toctouOuterId = "verify-recurrence-toctou-outer";
        saveCoordinationTask(SESSION_ID, {
            task_id: toctouCanonId,
            title: "TOCTOU canonical (R8, count 1, ack 1)",
            task_type: "implementation",
            coordination_mode: "short",
            primary_lane: "substrate",
            files_in_scope: ["tmp/"],
            success_criteria: ["TOCTOU canonical exists."],
            validation_plan: ["Verify card on disk."],
            status: "ready",
            recurrence: {
                recurrence_id: "R8",
                symptom_class_id: "recurrence.v1/class-a",
                recurrence_count: 1,
                last_acknowledged_count: 1,
                evidence: [{ kind: "path", ref: "src/toctou-canon.go" }],
                aliases: [],
            },
        });

        // The interleaving: mutate the canonical via the REAL producer
        // (saveCoordinationTask) WITHOUT the hook option, so the nested
        // save cannot re-fire the seam (containment: the merge path never
        // recurses into saveCoordinationTask, and this nested call does not
        // pass _testPreLockInterleave). It re-identifies the canonical's
        // recurrence block to R8-OTHER and bumps the count to 2 — modeling a
        // concurrent writer that changed canonical identity + count in the
        // scan→lock window. The outer's pre-lock merged block (R8, count 2)
        // becomes stale AND its R8 incoming no longer matches the locked
        // canonical → re-resolve returns new_card → throw.
        let toctouHookInvoked = 0;
        const toctouInterleave = () => {
            toctouHookInvoked += 1;
            saveCoordinationTask(SESSION_ID, {
                task_id: toctouCanonId,
                title: "TOCTOU canonical (re-identified by interleaving writer)",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "substrate",
                files_in_scope: ["tmp/"],
                success_criteria: ["Canonical re-identified."],
                validation_plan: ["Verify re-identified block on disk."],
                status: "ready",
                recurrence: {
                    recurrence_id: "R8-OTHER",
                    symptom_class_id: "recurrence.v1/class-a",
                    recurrence_count: 2,
                    last_acknowledged_count: 0,
                },
            });
        };

        let toctouThrew = false;
        let toctouError = null;
        try {
            saveCoordinationTask(
                SESSION_ID,
                {
                    task_id: toctouOuterId,
                    title: "TOCTOU outer repeat (R8)",
                    task_type: "implementation",
                    coordination_mode: "short",
                    primary_lane: "substrate",
                    files_in_scope: ["tmp/"],
                    success_criteria: ["Outer should abort (stale snapshot)."],
                    validation_plan: ["Verify no stale write."],
                    status: "ready",
                    recurrence: {
                        recurrence_id: "R8",
                        symptom_class_id: "recurrence.v1/class-a",
                        recurrence_count: 1,
                        last_acknowledged_count: 1,
                        evidence: [{ kind: "path", ref: "src/toctou-outer.go" }],
                        aliases: [],
                    },
                },
                { _testPreLockInterleave: toctouInterleave },
            );
        } catch (e) {
            toctouThrew = true;
            toctouError = e instanceof Error ? e.message : String(e);
        }

        // --- TOCTOU outcome assertions (outcome-observed, not mechanism) ---
        assert(
            toctouHookInvoked === 1,
            `TOCTOU 8a: pre-lock interleave seam must fire exactly once, got ${toctouHookInvoked}`,
        );
        assert(
            toctouThrew,
            "TOCTOU 8b: outer repeat must THROW (stale lock-time snapshot → re-resolve new_card → abort before persist)",
        );
        assert(
            toctouError && /recurrence merge aborted/i.test(toctouError),
            `TOCTOU 8c: thrown error must be the recurrence merge-abort guard, got: ${toctouError}`,
        );
        // Canonical on disk MUST equal the legitimate nested-save result
        // (re-identified + bumped), NOT the outer's stale pre-lock block.
        const toctouCanonOnDisk = readTask(toctouCanonId);
        assert(
            toctouCanonOnDisk.recurrence.recurrence_id === "R8-OTHER",
            `TOCTOU 8d: canonical recurrence_id must be the nested R8-OTHER (not the outer's stale R8), got ${toctouCanonOnDisk.recurrence.recurrence_id}`,
        );
        assert(
            toctouCanonOnDisk.recurrence.recurrence_count === 2,
            `TOCTOU 8e: canonical count must be 2 (nested bump preserved), got ${toctouCanonOnDisk.recurrence.recurrence_count}`,
        );
        // NO stale outer recurrence_observation appended (outer aborted).
        // The canonical's evidence may be absent (the nested re-identify block
        // carried none); guard the access so absence is itself proof no outer
        // observation was appended.
        const toctouCanonEvidence =
            (toctouCanonOnDisk.recurrence &&
                toctouCanonOnDisk.recurrence.evidence) ||
            [];
        const toctouOuterObs = toctouCanonEvidence.filter(
            (e) =>
                e.kind === "recurrence_observation" &&
                e.ref === toctouOuterId,
        );
        assert(
            toctouOuterObs.length === 0,
            `TOCTOU 8f: NO stale outer recurrence_observation must be appended, got ${toctouOuterObs.length}`,
        );
        // NO stale outer recurrence_merged history event (outer aborted before persist).
        const toctouMergeEvents = toctouCanonOnDisk.history.filter(
            (h) =>
                h.event === "recurrence_merged" &&
                String(h.note || "").includes(toctouOuterId),
        );
        assert(
            toctouMergeEvents.length === 0,
            `TOCTOU 8g: NO stale outer recurrence_merged history event must be appended, got ${toctouMergeEvents.length}`,
        );
        // NO duplicate repeat card spawned (outer's requestedTaskID never persisted).
        assert(
            !fs.existsSync(taskPath(toctouOuterId)),
            "TOCTOU 8h: outer repeat card must NOT exist on disk (no duplicate spawn)",
        );

        console.log("verification: ok");
        console.log(
            "scenario 1 (merge): repeat R1 → canonical updated (count 1→2, ack held 1 = unacknowledged, observation appended, recurrence_merged history); NO spawn",
        );
        console.log(
            "scenario 2 (new card): R2 → new card created + persisted",
        );
        console.log(
            "scenario 3 (legacy): no recurrence block → card created normally",
        );
        console.log(
            "scenario 4 (validation): malformed recurrence (missing counts / count<ack / bad pattern / numeric rid / extra evidence key / non-boolean alias) rejected at write boundary; no durable invalid card",
        );
        console.log(
            "scenario 5 (null removal): recurrence: null removes the property entirely (no schema-invalid null reaches disk)",
        );
        console.log(
            "scenario 6 (alias promotion): R3 aliases R4 → re-pointed to R3; later R3 repeat (no alias) still merges → N→1 holds",
        );
        console.log(
            "scenario 7 (bridge failure): binary unavailable → save THROWS (fail-closed), no duplicate card spawned",
        );
        console.log(
            "scenario 8 (TOCTOU re-resolve→throw): interleaving writer mutates canonical in scan→lock window → outer re-resolves via real binary → THROWS before persist (no stale write, no duplicate)",
        );
        console.log(`binary: ${bin}`);
    } finally {
        cleanup();
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
