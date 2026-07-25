// F3 design-readiness gate — task-card BUILD-READY integration test (Slice 2 crux).
//
// Exercises the REAL readyCoordinationTask mutation (draft -> ready) against the
// F3 design-readiness gate. This is the acceptance test: a draft carrying a
// named ownership hazard + BUILD-READY/HIGH-style self-assertion but NO
// qualifying resolution package REMAINS draft (transition refused); a complete
// current-digest-bound package permits the transition.
//
// Run: vh-agent-harness exec node .opencode/scripts/verify-f3-task-ready.js [--prefix <tag>]

import fs from "fs";
import path from "path";
import {
    StateError,
    bindSessionName,
    computeTaskDesignDigest,
    readyCoordinationTask,
    readCoordinationTask,
    repoRoot,
    saveCoordinationTask,
} from "./state-lib.js";

let prefix = "f3-verify";
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--prefix") {
        prefix = args[index + 1] || prefix;
        index += 1;
        continue;
    }
    throw new StateError(`Unexpected argument: ${args[index]}`);
}

const coordinatorSessionID = `${prefix}-coordinator-session`;
const createdTaskIDs = [];

function removeIfExists(targetPath) {
    if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
    }
}

function cleanupArtifacts(taskIDs) {
    for (const taskID of taskIDs) {
        removeIfExists(
            path.join(
                repoRoot(),
                ".local",
                "coordinator",
                "tasks",
                `${taskID}.json`,
            ),
        );
    }
}

function expectF3Block(fn, expectedReasonCode) {
    let thrown = null;
    try {
        fn();
    } catch (error) {
        thrown = error;
    }
    if (!(thrown instanceof StateError)) {
        throw new StateError(
            `Expected StateError with F3 reason ${expectedReasonCode}, but got ${
                thrown ? thrown.constructor.name : "no error"
            }.`,
        );
    }
    const message = String(thrown.message || "");
    if (!message.includes("F3 design-readiness gate refused")) {
        throw new StateError(
            `Expected an F3 gate refusal, got: "${message}".`,
        );
    }
    if (!message.includes(`reason: ${expectedReasonCode}`)) {
        throw new StateError(
            `Expected F3 reason code ${expectedReasonCode}, got: "${message}".`,
        );
    }
}

function expectStateError(fn, expectedFragment) {
    let thrown = null;
    try {
        fn();
    } catch (error) {
        thrown = error;
    }
    if (!(thrown instanceof StateError)) {
        throw new StateError(
            `Expected StateError containing "${expectedFragment}", but got ${
                thrown ? thrown.constructor.name : "no error"
            }.`,
        );
    }
    if (!String(thrown.message || "").includes(expectedFragment)) {
        throw new StateError(
            `Expected error containing "${expectedFragment}", got "${thrown.message}".`,
        );
    }
}

// ---------------------------------------------------------------------------
// F3 envelope fixture builders (domain-free).
// ---------------------------------------------------------------------------

/**
 * The generic equivalent of the demonstrated day-0 failure: an ownership seam
 * is NAMED as a core blocker, the design author self-asserts resolved/HIGH, but
 * NO resolution package exists — no evidence, no adversarial review, no
 * counter-case. The F3 gate must refuse this at BUILD-READY.
 */
function buildNamedButUnresolvedEnvelope(designDigest) {
    return {
        ownership_hazards: [
            {
                hazard_id: "hazard-ownership-a",
                hazard_class: "ownership",
                hazard_statement:
                    "Ownership seam for fixture-boundary-a is the core blocker.",
                affected_boundary: "fixture-boundary-a",
                competing_authorities: [
                    "fixture-authority-a",
                    "fixture-authority-b",
                ],
                failure_mode:
                    "Without a resolution, both authorities may issue contradictory edits.",
                source_records: [{ provenance: "fixture-source-a" }],
                // NO resolution record. The hazard is named but structurally
                // unresolved — the gap the F3 gate exists to catch.
            },
        ],
        design_digest: designDigest,
    };
}

/**
 * A complete, structurally valid F3 envelope: one ownership hazard with a full
 * resolution package (authoritative owner, evidence, counter-case) + a distinct
 * adversarial review bound to the same design digest. This must PASS the gate.
 */
function buildCompleteEnvelope(designDigest) {
    return {
        ownership_hazards: [
            {
                hazard_id: "hazard-ownership-a",
                hazard_class: "ownership",
                hazard_statement:
                    "Ownership seam for fixture-boundary-a has competing authorities.",
                affected_boundary: "fixture-boundary-a",
                competing_authorities: [
                    "fixture-authority-a",
                    "fixture-authority-b",
                ],
                failure_mode:
                    "Without a resolution, both authorities may issue contradictory edits.",
                source_records: [{ provenance: "fixture-source-a" }],
                resolution: {
                    authoritative_owner: "fixture-authority-a",
                    secondary_authority_disposition:
                        "delegated_to_authoritative_owner",
                    mechanism_mapping:
                        "fixture-authority-a owns the boundary; fixture-authority-b delegates all writes.",
                    evidence_records: [{ provenance: "fixture-evidence-a" }],
                    design_digest: designDigest,
                    declared_by: "fixture-author-a",
                    declared_at: "2026-07-25T00:00:00Z",
                    blocking_limitations: [],
                    minimum_counter_case: {
                        counter_case_id: "resolution-min-case-a",
                        preconditions:
                            "Both authorities attempt concurrent writes.",
                        competing_or_missing_event:
                            "fixture-authority-b issues a write outside the delegation.",
                        expected_authoritative_owner: "fixture-authority-a",
                        expected_state_or_outcome:
                            "fixture-authority-a write wins; fixture-authority-b is rejected.",
                        forbidden_state_or_outcome:
                            "Corrupted shared state from interleaved writes.",
                        resolution_mapping:
                            "The ownership delegation serializes through fixture-authority-a.",
                        evidence_refs: ["fixture-evidence-a"],
                    },
                },
                adversarial_review: {
                    review_id: "fixture-review-a",
                    hazard_id: "hazard-ownership-a",
                    design_digest: designDigest,
                    reviewer_identity: "fixture-reviewer-a",
                    reviewer_provenance: {
                        source: "fixture-adversarial-source",
                    },
                    counter_cases: [
                        {
                            counter_case_id: "counter-case-a",
                            preconditions:
                                "Both authorities attempt concurrent writes.",
                            competing_or_missing_event:
                                "fixture-authority-b issues a write outside the delegation.",
                            expected_authoritative_owner: "fixture-authority-a",
                            expected_state_or_outcome:
                                "fixture-authority-a write wins; fixture-authority-b is rejected.",
                            forbidden_state_or_outcome:
                                "Corrupted shared state from interleaved writes.",
                            resolution_mapping:
                                "The ownership delegation serializes through fixture-authority-a.",
                            evidence_refs: ["fixture-evidence-a"],
                        },
                    ],
                    evidence_checked: ["fixture-evidence-a"],
                    verdict: "resolution_supported",
                    weakest_supported_claim:
                        "The boundary has a single authoritative owner.",
                    limitations: [],
                },
            },
        ],
        design_digest: designDigest,
    };
}

function createDraftTask(taskIDSuffix, overrides = {}) {
    const draft = saveCoordinationTask(
        coordinatorSessionID,
        {
            title: `F3 gate test ${taskIDSuffix}`,
            task_type: "implementation",
            coordination_mode: "short",
            primary_lane: "fixture-lane-a",
            files_in_scope: ["tests/fixtures/example-pkg/"],
            constraints: ["Keep fixtures domain-free."],
            non_goals: ["Do not touch unrelated modules."],
            ready_criteria: [
                "F3 design-readiness envelope is structurally complete.",
            ],
            success_criteria: [
                "F3 gate blocks named-but-unresolved hazards at draft -> ready.",
            ],
            validation_plan: [
                "Run verify-f3-task-ready.js end to end.",
            ],
            status: "draft",
            next_action: "Ready the task for execution.",
            ...overrides,
        },
        { cwd: "/verification" },
    );
    createdTaskIDs.push(draft.task.task_id);
    return draft;
}

// ---------------------------------------------------------------------------
// Test body.
// ---------------------------------------------------------------------------

let passed = 0;

try {
    bindSessionName(coordinatorSessionID, `${prefix}-coord`, {
        cwd: "/verification",
    });

    // === Crux 1: named-but-unresolved hazard BLOCKS draft -> ready ===
    // The generic equivalent of: ownership hazard named as "core blocker" +
    // design claims resolved/HIGH + NO resolution package = transition refused.
    {
        const draft = createDraftTask("named-unresolved");
        const designDigest = computeTaskDesignDigest(draft.task, {});
        const envelope = buildNamedButUnresolvedEnvelope(designDigest);

        expectF3Block(
            () =>
                readyCoordinationTask(
                    coordinatorSessionID,
                    draft.task.task_id,
                    { f3_design_readiness: envelope },
                    { cwd: "/verification" },
                ),
            "missing_resolution",
        );
        passed += 1;

        // The task MUST remain draft (state preserved, no mutation).
        const reloaded = readCoordinationTask(
            coordinatorSessionID,
            draft.task.task_id,
            { cwd: "/verification" },
        );
        if (reloaded.task.status !== "draft") {
            throw new StateError(
                `Expected task to remain draft after F3 refusal, got ${reloaded.task.status}.`,
            );
        }
        passed += 1;

        // No task_readied event must be in the history.
        const readiedEvents = (reloaded.task.history || []).filter(
            (event) => event.event === "task_readied",
        );
        if (readiedEvents.length !== 0) {
            throw new StateError(
                `Expected zero task_readied events after F3 refusal, got ${readiedEvents.length}.`,
            );
        }
        passed += 1;
    }

    // === Crux 2: complete current-digest package PERMITS draft -> ready ===
    {
        const draft = createDraftTask("complete-package");
        const designDigest = computeTaskDesignDigest(draft.task, {});
        const envelope = buildCompleteEnvelope(designDigest);

        const readied = readyCoordinationTask(
            coordinatorSessionID,
            draft.task.task_id,
            { f3_design_readiness: envelope },
            { cwd: "/verification" },
        );
        if (readied.task.status !== "ready") {
            throw new StateError(
                `Expected task to reach ready with a complete F3 package, got ${readied.task.status}.`,
            );
        }
        passed += 1;

        // A task_readied event MUST be in the history.
        const readiedEvents = (readied.task.history || []).filter(
            (event) => event.event === "task_readied",
        );
        if (readiedEvents.length !== 1) {
            throw new StateError(
                `Expected exactly one task_readied event, got ${readiedEvents.length}.`,
            );
        }
        passed += 1;

        // The envelope MUST be persisted on the readied task card.
        if (!readied.task.f3_design_readiness) {
            throw new StateError(
                "Expected f3_design_readiness to persist on the readied task card.",
            );
        }
        passed += 1;
    }

    // === Crux 3: missing envelope (omission) BLOCKS ===
    // A draft with no f3_design_readiness at all is refused (fail-closed on omission).
    {
        const draft = createDraftTask("missing-envelope");

        expectF3Block(
            () =>
                readyCoordinationTask(
                    coordinatorSessionID,
                    draft.task.task_id,
                    {},
                    { cwd: "/verification" },
                ),
            "missing_envelope",
        );
        passed += 1;

        const reloaded = readCoordinationTask(
            coordinatorSessionID,
            draft.task.task_id,
            { cwd: "/verification" },
        );
        if (reloaded.task.status !== "draft") {
            throw new StateError(
                `Expected task to remain draft after missing-envelope refusal, got ${reloaded.task.status}.`,
            );
        }
        passed += 1;
    }

    // === Crux 4: explicit-empty inventory PERMITS ===
    // ownership_hazards: [] is the "author surveyed, named nothing" pass.
    {
        const draft = createDraftTask("explicit-empty");
        const designDigest = computeTaskDesignDigest(draft.task, {});

        const readied = readyCoordinationTask(
            coordinatorSessionID,
            draft.task.task_id,
            {
                f3_design_readiness: {
                    ownership_hazards: [],
                    design_digest: designDigest,
                },
            },
            { cwd: "/verification" },
        );
        if (readied.task.status !== "ready") {
            throw new StateError(
                `Expected explicit-empty envelope to reach ready, got ${readied.task.status}.`,
            );
        }
        passed += 1;
    }

    // === Crux 5: stale digest BLOCKS ===
    // A complete package bound to a WRONG digest is refused.
    {
        const draft = createDraftTask("stale-digest");
        const staleDigest = "0".repeat(64);
        const envelope = buildCompleteEnvelope(staleDigest);

        expectF3Block(
            () =>
                readyCoordinationTask(
                    coordinatorSessionID,
                    draft.task.task_id,
                    { f3_design_readiness: envelope },
                    { cwd: "/verification" },
                ),
            "stale_design_digest",
        );
        passed += 1;

        const reloaded = readCoordinationTask(
            coordinatorSessionID,
            draft.task.task_id,
            { cwd: "/verification" },
        );
        if (reloaded.task.status !== "draft") {
            throw new StateError(
                `Expected task to remain draft after stale-digest refusal, got ${reloaded.task.status}.`,
            );
        }
        passed += 1;
    }

    // === Crux 6: design-change invalidates the digest ===
    // A package bound to the ORIGINAL design digest is refused when the
    // task-ready payload CHANGES design-bearing fields (files_in_scope).
    {
        const draft = createDraftTask("design-change");
        const originalDigest = computeTaskDesignDigest(draft.task, {});
        const envelope = buildCompleteEnvelope(originalDigest);

        // Add a new file to the scope — the design digest will change.
        expectF3Block(
            () =>
                readyCoordinationTask(
                    coordinatorSessionID,
                    draft.task.task_id,
                    {
                        files_in_scope: [
                            "tests/fixtures/example-pkg/",
                            "tests/fixtures/NEW-SCOPE/",
                        ],
                        f3_design_readiness: envelope,
                    },
                    { cwd: "/verification" },
                ),
            "stale_design_digest",
        );
        passed += 1;

        // With the CORRECT digest (re-computed over the new scope), it passes.
        const updatedDigest = computeTaskDesignDigest(draft.task, {
            files_in_scope: [
                "tests/fixtures/example-pkg/",
                "tests/fixtures/NEW-SCOPE/",
            ],
        });
        const correctedEnvelope = buildCompleteEnvelope(updatedDigest);
        const readied = readyCoordinationTask(
            coordinatorSessionID,
            draft.task.task_id,
            {
                files_in_scope: [
                    "tests/fixtures/example-pkg/",
                    "tests/fixtures/NEW-SCOPE/",
                ],
                f3_design_readiness: correctedEnvelope,
            },
            { cwd: "/verification" },
        );
        if (readied.task.status !== "ready") {
            throw new StateError(
                `Expected task to reach ready with corrected digest, got ${readied.task.status}.`,
            );
        }
        passed += 1;
    }

    // === Crux 7: ready -> ready metadata refresh is EXEMPT from F3 ===
    // A task already in "ready" can be updated without an F3 envelope.
    {
        const draft = createDraftTask("ready-refresh");
        const designDigest = computeTaskDesignDigest(draft.task, {});

        // First, ready the task with explicit-empty.
        readyCoordinationTask(
            coordinatorSessionID,
            draft.task.task_id,
            {
                f3_design_readiness: {
                    ownership_hazards: [],
                    design_digest: designDigest,
                },
            },
            { cwd: "/verification" },
        );

        // Now update it again (ready -> ready). No f3_design_readiness in the
        // payload — this should NOT trigger the F3 gate.
        const refreshed = readyCoordinationTask(
            coordinatorSessionID,
            draft.task.task_id,
            {
                next_action: "Updated next action for the ready task.",
            },
            { cwd: "/verification" },
        );
        if (refreshed.task.status !== "ready") {
            throw new StateError(
                `Expected ready -> ready refresh to succeed, got ${refreshed.task.status}.`,
            );
        }
        passed += 1;

        // The event should be task_ready_updated (not task_readied).
        const lastEvent = refreshed.task.history[refreshed.task.history.length - 1];
        if (lastEvent.event !== "task_ready_updated") {
            throw new StateError(
                `Expected task_ready_updated event, got ${lastEvent.event}.`,
            );
        }
        passed += 1;
    }

    // === Crux 8: direct readyCoordinationTask invocation cannot bypass F3 ===
    // Confirms the gate is in the function itself, not in a route handler.
    {
        const draft = createDraftTask("direct-bypass");
        const designDigest = computeTaskDesignDigest(draft.task, {});
        const envelope = buildNamedButUnresolvedEnvelope(designDigest);

        // Even calling the function directly (no plan-state.js route), the
        // gate fires.
        expectF3Block(
            () =>
                readyCoordinationTask(
                    coordinatorSessionID,
                    draft.task.task_id,
                    { f3_design_readiness: envelope },
                    { cwd: "/verification" },
                ),
            "missing_resolution",
        );
        passed += 1;
    }

    // === Crux 9 (b-F1 pinned regression): stale explicit-empty envelope FAILS ===
    // An explicit-empty envelope authored against design v1 must NOT cross
    // draft -> ready after the design has moved to v2. The top-level
    // envelope.design_digest is the freshness binding for the explicit-empty
    // case (there are no per-hazard digests to bind). The "no hazard named"
    // survey was against v1; v2 might have introduced a hazard the survey did
    // not cover. (This is the b-F1 contract gap surfaced during Slice 2's
    // first full 4-leaf commit-review and resolved by adding the top-level
    // envelope.design_digest check — see the F3 memo Addendum
    // 2026-07-25-b-F1-resolution.)
    {
        const draft = createDraftTask("stale-explicit-empty");
        const v1Digest = computeTaskDesignDigest(draft.task, {});

        // The design moves to v2: a new file is added to files_in_scope.
        // The v1 explicit-empty envelope is now stale.
        expectF3Block(
            () =>
                readyCoordinationTask(
                    coordinatorSessionID,
                    draft.task.task_id,
                    {
                        files_in_scope: [
                            "tests/fixtures/example-pkg/",
                            "tests/fixtures/NEW-SCOPE-v2/",
                        ],
                        f3_design_readiness: {
                            design_digest: v1Digest,
                            ownership_hazards: [],
                        },
                    },
                    { cwd: "/verification" },
                ),
            "stale_design_digest",
        );
        passed += 1;

        // The task must remain draft (no partial mutation).
        const reloaded = readCoordinationTask(
            coordinatorSessionID,
            draft.task.task_id,
            { cwd: "/verification" },
        );
        if (reloaded.task.status !== "draft") {
            throw new StateError(
                `Expected task to remain draft after stale-explicit-empty refusal, got ${reloaded.task.status}.`,
            );
        }
        passed += 1;

        // Sanity: with the CORRECT v2 digest, the explicit-empty envelope passes.
        const v2Digest = computeTaskDesignDigest(draft.task, {
            files_in_scope: [
                "tests/fixtures/example-pkg/",
                "tests/fixtures/NEW-SCOPE-v2/",
            ],
        });
        const readied = readyCoordinationTask(
            coordinatorSessionID,
            draft.task.task_id,
            {
                files_in_scope: [
                    "tests/fixtures/example-pkg/",
                    "tests/fixtures/NEW-SCOPE-v2/",
                ],
                f3_design_readiness: {
                    design_digest: v2Digest,
                    ownership_hazards: [],
                },
            },
            { cwd: "/verification" },
        );
        if (readied.task.status !== "ready") {
            throw new StateError(
                `Expected task to reach ready with corrected v2 explicit-empty envelope, got ${readied.task.status}.`,
            );
        }
        passed += 1;
    }

    console.log(`verification: ok (${passed} assertions passed)`);
} catch (error) {
    if (error instanceof StateError) {
        console.error(`verification: FAIL — ${error.message}`);
    } else {
        console.error(`verification: FAIL — unexpected error`);
        console.error(error);
    }
    cleanupArtifacts(createdTaskIDs);
    process.exit(1);
}

cleanupArtifacts(createdTaskIDs);
