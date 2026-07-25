// F3 design-readiness gate — dispatch backstop integration test (Slice 4 crux).
//
// Exercises the REAL activateCoordinationTask (ready -> working) and
// resolvePlan (plan dispatch) backstops. These are BACKSTOPS — the primary
// F3 gates are at readyCoordinationTask (draft -> ready, Slice 2) and
// approveDraft (draft -> approved, Slice 3). The backstops re-verify the
// design-readiness envelope is still current AT DISPATCH TIME, catching:
// (a) post-crossing design drift — the design changed between the crossing
//     and execution; and
// (b) bypassed ready/approved states — a task/plan that reached ready/approved
//     without going through the primary gate (e.g. saveCoordinationTask
//     create-as-ready, or a manually-stripped envelope).
//
// This is the Slice 4 acceptance test: BOTH routes refuse stale/bypassed
// readiness; an unchanged, current package proceeds normally.
//
// Run: vh-agent-harness exec node .opencode/scripts/verify-f3-dispatch-backstop.js [--prefix <tag>]

import fs from "fs";
import path from "path";
import {
    StateError,
    activateCoordinationTask,
    approveDraft,
    bindSessionName,
    computePlanDesignDigest,
    computeTaskDesignDigest,
    ensureSessionBinding,
    readyCoordinationTask,
    readCoordinationTask,
    repoRoot,
    resolvePlan,
    saveCoordinationTask,
    saveDraft,
} from "./state-lib.js";

let prefix = "f3-dispatch-verify";
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
const sessionAlias = `${prefix}-session`;
const createdTaskIDs = [];
const createdSlugs = [];

function removeIfExists(targetPath) {
    if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
    }
}

function cleanupTaskArtifacts(taskIDs) {
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

function cleanupPlanArtifacts() {
    removeIfExists(
        path.join(repoRoot(), ".opencode", "plans", sessionAlias),
    );
    removeIfExists(
        path.join(
            repoRoot(),
            ".opencode",
            "state",
            "sessions",
            sessionAlias,
        ),
    );
    const bindingDir = path.join(
        repoRoot(),
        ".opencode",
        "state",
        "session-bindings",
    );
    if (fs.existsSync(bindingDir)) {
        for (const entry of fs.readdirSync(bindingDir)) {
            if (entry.startsWith(coordinatorSessionID)) {
                removeIfExists(path.join(bindingDir, entry));
            }
        }
    }
}

function expectDispatchBlock(fn, expectedReasonCode) {
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
    if (!message.includes("F3 dispatch backstop refused")) {
        throw new StateError(
            `Expected an F3 dispatch backstop refusal, got: "${message}".`,
        );
    }
    if (!message.includes(`reason: ${expectedReasonCode}`)) {
        throw new StateError(
            `Expected F3 reason code ${expectedReasonCode}, got: "${message}".`,
        );
    }
}

function taskFilePath(taskID) {
    return path.join(
        repoRoot(),
        ".local",
        "coordinator",
        "tasks",
        `${taskID}.json`,
    );
}

// ---------------------------------------------------------------------------
// F3 envelope fixture builders (domain-free). Same shapes as the Slice 2/3
// verify scripts — the SAME generic named-but-unresolved / complete fixtures.
// ---------------------------------------------------------------------------

function buildCompleteEnvelope(designDigest) {
    return {
        design_digest: designDigest,
        ownership_hazards: [
            {
                hazard_id: "hazard-dispatch-ownership-a",
                hazard_class: "ownership",
                hazard_statement:
                    "Ownership seam for fixture-dispatch-boundary-a has competing authorities.",
                affected_boundary: "fixture-dispatch-boundary-a",
                competing_authorities: [
                    "fixture-authority-a",
                    "fixture-authority-b",
                ],
                failure_mode:
                    "Without a resolution, both authorities may issue contradictory edits.",
                source_records: [{ provenance: "fixture-dispatch-source-a" }],
                resolution: {
                    authoritative_owner: "fixture-authority-a",
                    secondary_authority_disposition:
                        "delegated_to_authoritative_owner",
                    mechanism_mapping:
                        "fixture-authority-a owns the boundary; fixture-authority-b delegates all writes.",
                    evidence_records: [
                        { provenance: "fixture-dispatch-evidence-a" },
                    ],
                    design_digest: designDigest,
                    declared_by: "fixture-dispatch-author",
                    declared_at: "2026-07-26T00:00:00Z",
                    blocking_limitations: [],
                    minimum_counter_case: {
                        counter_case_id: "dispatch-min-case-a",
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
                        evidence_refs: ["fixture-dispatch-evidence-a"],
                    },
                },
                adversarial_review: {
                    review_id: "dispatch-fixture-review-a",
                    hazard_id: "hazard-dispatch-ownership-a",
                    design_digest: designDigest,
                    reviewer_identity: "fixture-dispatch-reviewer-a",
                    reviewer_provenance: {
                        source: "fixture-dispatch-adversarial-source",
                    },
                    counter_cases: [
                        {
                            counter_case_id: "dispatch-counter-case-a",
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
                            evidence_refs: ["fixture-dispatch-evidence-a"],
                        },
                    ],
                    evidence_checked: ["fixture-dispatch-evidence-a"],
                    verdict: "resolution_supported",
                    weakest_supported_claim:
                        "The boundary has a single authoritative owner.",
                    limitations: [],
                },
            },
        ],
    };
}

function buildNamedButUnresolvedEnvelope(designDigest) {
    return {
        design_digest: designDigest,
        ownership_hazards: [
            {
                hazard_id: "hazard-dispatch-named-unresolved-a",
                hazard_class: "ownership",
                hazard_statement:
                    "Ownership seam for fixture-dispatch-boundary-b is the core blocker.",
                affected_boundary: "fixture-dispatch-boundary-b",
                competing_authorities: [
                    "fixture-authority-c",
                    "fixture-authority-d",
                ],
                failure_mode:
                    "Without a resolution, both authorities may issue contradictory edits.",
                source_records: [{ provenance: "fixture-dispatch-source-b" }],
                // NO resolution record — named but structurally unresolved.
            },
        ],
    };
}

function createDraftTask(taskIDSuffix, overrides = {}) {
    const draft = saveCoordinationTask(
        coordinatorSessionID,
        {
            title: `F3 dispatch test ${taskIDSuffix}`,
            task_type: "implementation",
            coordination_mode: "short",
            primary_lane: "fixture-dispatch-lane-a",
            files_in_scope: ["tests/fixtures/example-pkg/"],
            constraints: ["Keep fixtures domain-free."],
            non_goals: ["Do not touch unrelated modules."],
            ready_criteria: [
                "F3 dispatch backstop is structurally complete.",
            ],
            success_criteria: [
                "F3 dispatch backstop blocks stale/bypassed readiness.",
            ],
            validation_plan: [
                "Run verify-f3-dispatch-backstop.js end to end.",
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

function readyTaskWithEnvelope(taskID, envelope) {
    return readyCoordinationTask(
        coordinatorSessionID,
        taskID,
        { f3_design_readiness: envelope },
        { cwd: "/verification" },
    );
}

const PLAN_BODY = [
    "## Goal",
    "",
    "Fixture dispatch plan: project the canonical ownership boundary onto the",
    "fixture-dispatch-projection surface without leaking stale state.",
    "",
    "## Files in scope",
    "",
    "- tests/fixtures/example-pkg/projection.go",
    "",
    "## Success criteria",
    "",
    "- Projection is single-owner under fixture-authority-a.",
    "",
    "## Validation",
    "",
    "- Run the fixture dispatch test suite.",
].join("\n");

function createDraftPlan(slugSuffix, envelope) {
    const slug = `${prefix}-${slugSuffix}`;
    createdSlugs.push(slug);
    saveDraft(
        coordinatorSessionID,
        slug,
        PLAN_BODY,
        `Fixture dispatch plan ${slugSuffix}`,
        { cwd: "/verification", f3DesignReadiness: envelope },
    );
    return slug;
}

// ---------------------------------------------------------------------------
// Test body.
// ---------------------------------------------------------------------------

let passed = 0;

try {
    cleanupPlanArtifacts();
    ensureSessionBinding(coordinatorSessionID, { cwd: "/verification" });
    bindSessionName(coordinatorSessionID, sessionAlias, {
        cwd: "/verification",
    });

    // ====================================================================
    // PART A — Task-card dispatch backstop (activateCoordinationTask)
    // ====================================================================

    // === Crux 1: fresh complete envelope PERMITS ready -> working ===
    {
        const draft = createDraftTask("task-fresh");
        const designDigest = computeTaskDesignDigest(draft.task, {});
        const envelope = buildCompleteEnvelope(designDigest);
        readyTaskWithEnvelope(draft.task.task_id, envelope);

        const activated = activateCoordinationTask(
            coordinatorSessionID,
            draft.task.task_id,
            { cwd: "/verification" },
        );
        if (activated.task.status !== "working") {
            throw new StateError(
                `Expected fresh-envelope task to activate to working, got ${activated.task.status}.`,
            );
        }
        passed += 1;
    }

    // === Crux 2: stale envelope (design drifted) REFUSES ready -> working ===
    // A task readied with a valid envelope, then its design field changed
    // (files_in_scope) WITHOUT re-running F3 — the envelope is now stale.
    {
        const draft = createDraftTask("task-stale");
        const designDigest = computeTaskDesignDigest(draft.task, {});
        const envelope = buildCompleteEnvelope(designDigest);
        readyTaskWithEnvelope(draft.task.task_id, envelope);

        // Simulate post-crossing design drift: edit the task JSON directly to
        // add a new file to files_in_scope. The envelope's design_digest is
        // now stale relative to the current design.
        const taskPath = taskFilePath(draft.task.task_id);
        const taskData = JSON.parse(fs.readFileSync(taskPath, "utf8"));
        taskData.files_in_scope = [
            "tests/fixtures/example-pkg/",
            "tests/fixtures/DRIFTED-SCOPE/",
        ];
        fs.writeFileSync(taskPath, JSON.stringify(taskData, null, 2));

        expectDispatchBlock(
            () =>
                activateCoordinationTask(
                    coordinatorSessionID,
                    draft.task.task_id,
                    { cwd: "/verification" },
                ),
            "stale_design_digest",
        );
        passed += 1;

        // The task MUST remain ready (state preserved, no mutation).
        const reloaded = readCoordinationTask(
            coordinatorSessionID,
            draft.task.task_id,
            { cwd: "/verification" },
        );
        if (reloaded.task.status !== "ready") {
            throw new StateError(
                `Expected task to remain ready after dispatch backstop refusal, got ${reloaded.task.status}.`,
            );
        }
        passed += 1;
    }

    // === Crux 3: bypassed ready (no envelope) REFUSES ===
    // saveCoordinationTask create-as-ready lands at ready WITHOUT an envelope.
    // The primary F3 gate (in readyCoordinationTask) was never run. The
    // dispatch backstop catches this.
    {
        const bypassed = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: `F3 dispatch test task-bypass`,
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "fixture-dispatch-lane-b",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                constraints: ["Keep fixtures domain-free."],
                non_goals: ["Do not touch unrelated modules."],
                ready_criteria: ["Bypass test."],
                success_criteria: ["Dispatch backstop catches bypass."],
                validation_plan: ["Run verify-f3-dispatch-backstop.js."],
                status: "ready",
                next_action: "Activate the task.",
            },
            { cwd: "/verification" },
        );
        createdTaskIDs.push(bypassed.task.task_id);

        expectDispatchBlock(
            () =>
                activateCoordinationTask(
                    coordinatorSessionID,
                    bypassed.task.task_id,
                    { cwd: "/verification" },
                ),
            "missing_envelope",
        );
        passed += 1;
    }

    // === Crux 4: named-but-unresolved hazard REFUSES at dispatch ===
    // A ready task carrying a named-but-unresolved envelope (the hazard was
    // named but has no resolution). This cannot arise from the primary gate
    // (it would block at draft -> ready), but a bypassed state could carry it.
    {
        const draft = createDraftTask("task-named-unresolved");
        const designDigest = computeTaskDesignDigest(draft.task, {});
        const envelope = buildNamedButUnresolvedEnvelope(designDigest);

        // The primary gate MUST block this at draft -> ready.
        let primaryBlocked = false;
        try {
            readyTaskWithEnvelope(draft.task.task_id, envelope);
        } catch (error) {
            if (
                error instanceof StateError &&
                String(error.message).includes(
                    "F3 design-readiness gate refused",
                )
            ) {
                primaryBlocked = true;
            } else {
                throw error;
            }
        }
        if (!primaryBlocked) {
            throw new StateError(
                "Expected named-but-unresolved to be blocked at draft -> ready (primary gate).",
            );
        }
        passed += 1;

        // Verify the task is still draft.
        const reloaded = readCoordinationTask(
            coordinatorSessionID,
            draft.task.task_id,
            { cwd: "/verification" },
        );
        if (reloaded.task.status !== "draft") {
            throw new StateError(
                `Expected task to remain draft after primary gate refusal, got ${reloaded.task.status}.`,
            );
        }
        passed += 1;

        // Simulate a bypass: directly write the task to ready with the
        // unresolved envelope (skipping readyCoordinationTask's gate).
        const taskPath = taskFilePath(draft.task.task_id);
        const taskData = JSON.parse(fs.readFileSync(taskPath, "utf8"));
        taskData.status = "ready";
        taskData.f3_design_readiness = envelope;
        fs.writeFileSync(taskPath, JSON.stringify(taskData, null, 2));

        // Now the dispatch backstop must catch the unresolved hazard.
        expectDispatchBlock(
            () =>
                activateCoordinationTask(
                    coordinatorSessionID,
                    draft.task.task_id,
                    { cwd: "/verification" },
                ),
            "missing_resolution",
        );
        passed += 1;
    }

    // === Crux 5: working -> working resume is EXEMPT from the backstop ===
    // A task already at working does NOT re-check F3 on resume/reclaim.
    {
        const draft = createDraftTask("task-working-resume");
        const designDigest = computeTaskDesignDigest(draft.task, {});
        const envelope = buildCompleteEnvelope(designDigest);
        readyTaskWithEnvelope(draft.task.task_id, envelope);

        // Activate to working.
        activateCoordinationTask(
            coordinatorSessionID,
            draft.task.task_id,
            { cwd: "/verification" },
        );

        // Now simulate design drift on the working task (the backstop should
        // NOT fire because the task is already working, not ready).
        const taskPath = taskFilePath(draft.task.task_id);
        const taskData = JSON.parse(fs.readFileSync(taskPath, "utf8"));
        taskData.files_in_scope = [
            "tests/fixtures/example-pkg/",
            "tests/fixtures/POST-WORKING-DRIFT/",
        ];
        fs.writeFileSync(taskPath, JSON.stringify(taskData, null, 2));

        // Resume (working -> working) should succeed WITHOUT F3 re-check.
        const resumed = activateCoordinationTask(
            coordinatorSessionID,
            draft.task.task_id,
            { cwd: "/verification" },
        );
        if (resumed.task.status !== "working") {
            throw new StateError(
                `Expected working -> working resume to succeed (backstop exempt), got ${resumed.task.status}.`,
            );
        }
        passed += 1;
    }

    // ====================================================================
    // PART B — Plan dispatch backstop (resolvePlan)
    // ====================================================================

    const planDesignDigest = computePlanDesignDigest(PLAN_BODY);

    // === Crux 6: fresh complete envelope PERMITS plan dispatch ===
    {
        const slug = createDraftPlan(
            "plan-fresh",
            buildCompleteEnvelope(planDesignDigest),
        );
        const approved = approveDraft(coordinatorSessionID, slug, {
            cwd: "/verification",
        });

        const resolved = resolvePlan(
            coordinatorSessionID,
            approved.plan.id,
            { cwd: "/verification", dispatchFreshnessCheck: true },
        );
        if (!resolved.plan || resolved.plan.status !== "approved") {
            throw new StateError(
                `Expected fresh-envelope plan to dispatch-resolve, got ${JSON.stringify(resolved.plan || null)}.`,
            );
        }
        passed += 1;
    }

    // === Crux 7: stale plan body REFUSES dispatch ===
    // An approved plan whose body was edited after approval — the envelope's
    // design_digest is stale relative to the current body.
    {
        const slug = createDraftPlan(
            "plan-stale-body",
            buildCompleteEnvelope(planDesignDigest),
        );
        const approved = approveDraft(coordinatorSessionID, slug, {
            cwd: "/verification",
        });

        // Edit the approved plan file: append text to the body, changing the
        // design digest without updating the envelope.
        const approvedPath = path.join(repoRoot(), approved.plan.path);
        const rawContent = fs.readFileSync(approvedPath, "utf8");
        const editedContent = rawContent + "\n\n## Changed\n\nNew design requirement.\n";
        fs.writeFileSync(approvedPath, editedContent);

        expectDispatchBlock(
            () =>
                resolvePlan(
                    coordinatorSessionID,
                    approved.plan.id,
                    { cwd: "/verification", dispatchFreshnessCheck: true },
                ),
            "stale_design_digest",
        );
        passed += 1;
    }

    // === Crux 8: bypassed approved plan (no envelope) REFUSES dispatch ===
    // An approved plan whose envelope was stripped from the frontmatter.
    {
        const slug = createDraftPlan(
            "plan-no-envelope",
            buildCompleteEnvelope(planDesignDigest),
        );
        const approved = approveDraft(coordinatorSessionID, slug, {
            cwd: "/verification",
        });

        // Strip the f3_design_readiness line from the approved plan frontmatter.
        const approvedPath = path.join(repoRoot(), approved.plan.path);
        const rawContent = fs.readFileSync(approvedPath, "utf8");
        const strippedContent = rawContent.replace(
            /^f3_design_readiness:.*\n/m,
            "",
        );
        fs.writeFileSync(approvedPath, strippedContent);

        expectDispatchBlock(
            () =>
                resolvePlan(
                    coordinatorSessionID,
                    approved.plan.id,
                    { cwd: "/verification", dispatchFreshnessCheck: true },
                ),
            "missing_envelope",
        );
        passed += 1;
    }

    // === Crux 9: informational read WITHOUT dispatchFreshnessCheck is EXEMPT ===
    // resolvePlan called without the dispatch flag must NOT run the backstop.
    // (Session-context builder, plan listing — these are informational reads.)
    {
        const slug = createDraftPlan(
            "plan-info-read",
            buildCompleteEnvelope(planDesignDigest),
        );
        const approved = approveDraft(coordinatorSessionID, slug, {
            cwd: "/verification",
        });

        // Stale the body (as in Crux 7).
        const approvedPath = path.join(repoRoot(), approved.plan.path);
        const rawContent = fs.readFileSync(approvedPath, "utf8");
        const editedContent = rawContent + "\n\n## Changed\n\nNew design requirement.\n";
        fs.writeFileSync(approvedPath, editedContent);

        // Without dispatchFreshnessCheck, the resolve must SUCCEED
        // (informational read does not re-verify).
        const resolved = resolvePlan(
            coordinatorSessionID,
            approved.plan.id,
            { cwd: "/verification" },
        );
        if (!resolved.plan || resolved.plan.status !== "approved") {
            throw new StateError(
                `Expected informational resolve to succeed (no dispatch check), got ${JSON.stringify(resolved.plan || null)}.`,
            );
        }
        passed += 1;
    }

    // === Crux 10: named-but-unresolved plan REFUSES dispatch ===
    // An approved plan carrying a named-but-unresolved envelope. This cannot
    // arise through normal approval (the primary gate blocks it), so we
    // approve a COMPLETE plan, then swap its envelope to a named-but-
    // unresolved one (same design_digest, so it is NOT stale — just
    // structurally unresolved). The dispatch backstop runs the FULL validator
    // and must catch the missing resolution.
    {
        // Sanity: the primary gate blocks named-but-unresolved at approval.
        const blockedSlug = createDraftPlan(
            "plan-named-unresolved-blocked",
            buildNamedButUnresolvedEnvelope(planDesignDigest),
        );
        let approveBlocked = false;
        try {
            approveDraft(coordinatorSessionID, blockedSlug, {
                cwd: "/verification",
            });
        } catch (error) {
            if (
                error instanceof StateError &&
                String(error.message).includes("F3 design-readiness gate refused")
            ) {
                approveBlocked = true;
            } else {
                throw error;
            }
        }
        if (!approveBlocked) {
            throw new StateError(
                "Expected named-but-unresolved plan to be blocked at approval (primary gate).",
            );
        }
        passed += 1;

        // Approve a COMPLETE plan, then swap its envelope to unresolved.
        const slug = createDraftPlan(
            "plan-envelope-swapped",
            buildCompleteEnvelope(planDesignDigest),
        );
        const approved = approveDraft(coordinatorSessionID, slug, {
            cwd: "/verification",
        });

        // Replace the f3_design_readiness frontmatter line with a named-but-
        // unresolved envelope bound to the SAME design_digest (not stale —
        // just structurally unresolved).
        const approvedPath = path.join(repoRoot(), approved.plan.path);
        const rawContent = fs.readFileSync(approvedPath, "utf8");
        const unresolvedEnvelopeJson = JSON.stringify(
            JSON.stringify(
                buildNamedButUnresolvedEnvelope(planDesignDigest),
            ),
        );
        const swappedContent = rawContent.replace(
            /^f3_design_readiness:.*$/m,
            `f3_design_readiness: ${unresolvedEnvelopeJson}`,
        );
        if (swappedContent === rawContent) {
            throw new StateError(
                `Could not locate f3_design_readiness frontmatter line to swap in plan ${approved.plan.path}.`,
            );
        }
        fs.writeFileSync(approvedPath, swappedContent);

        expectDispatchBlock(
            () =>
                resolvePlan(
                    coordinatorSessionID,
                    approved.plan.id,
                    { cwd: "/verification", dispatchFreshnessCheck: true },
                ),
            "missing_resolution",
        );
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
    cleanupTaskArtifacts(createdTaskIDs);
    cleanupPlanArtifacts();
    process.exit(1);
}

cleanupTaskArtifacts(createdTaskIDs);
cleanupPlanArtifacts();
