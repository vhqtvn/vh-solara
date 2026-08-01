import fs from "fs";
import path from "path";
import {
    StateError,
    activateCoordinationTask,
    bindSessionName,
    computeTaskDesignDigest,
    listCoordinationTasks,
    repairCoordinationTask,
    readyCoordinationTask,
    readCoordinationTask,
    repoRoot,
    reviewCoordinationTask,
    saveCoordinationTask,
    saveCoordinationTaskCloseout,
    updateCoordinationTaskMetadata,
} from "./state-lib.js";

function removeIfExists(targetPath) {
    if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, {
            recursive: true,
            force: true,
        });
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
        removeIfExists(
            path.join(
                repoRoot(),
                ".local",
                "coordinator",
                "reports",
                taskID,
            ),
        );
    }
}

function taskCardPath(taskID) {
    return path.join(
        repoRoot(),
        ".local",
        "coordinator",
        "tasks",
        `${taskID}.json`,
    );
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
            `Expected StateError containing "${expectedFragment}", but got ${thrown ? thrown.constructor.name : "no error"}.`,
        );
    }
    if (!String(thrown.message || "").includes(expectedFragment)) {
        throw new StateError(
            `Expected error containing "${expectedFragment}", got "${thrown.message}".`,
        );
    }
}

function main() {
    const args = process.argv.slice(2);
    let prefix = "verify-task-registry";
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--prefix") {
            prefix = args[index + 1] || prefix;
            index += 1;
            continue;
        }
        throw new StateError(`Unexpected argument: ${args[index]}`);
    }

    const coordinatorSessionID = `${prefix}-coordinator-session`;
    const subagentSessionID = `${prefix}-subagent-session`;
    const secondSubagentSessionID = `${prefix}-subagent-session-2`;
    const unboundSessionID = `${prefix}-unbound-session`;
    const createdTaskIDs = [];

    try {
        bindSessionName(coordinatorSessionID, `${prefix}-coord`, {
            cwd: "/verification",
        });
        bindSessionName(subagentSessionID, `${prefix}-subagent`, {
            cwd: "/verification",
        });
        bindSessionName(secondSubagentSessionID, `${prefix}-subagent-2`, {
            cwd: "/verification",
        });

        const primary = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Audit queue retry coordination flow",
                task_type: "research",
                coordination_mode: "medium",
                primary_lane: "queueing",
                research_question:
                    "What retry and backpressure coordination rules should queueing follow?",
                source_policy: "web_repo",
                source_allowlist: [
                    "docs.anthropic.com",
                    "openai.github.io",
                ],
                desired_artifact_type: "sources",
                target_artifact_path:
                    "researches/sources/2026-04-30-queueing-retry-coordination-sources.md",
                files_in_scope: [
                    "tests/fixtures/example-pkg/",
                    "docs/planning/backlog.md",
                ],
                constraints: [
                    "Keep backlog and checkpoints as the only committed truth.",
                ],
                non_goals: [
                    "Do not change deployment code in this slice.",
                ],
                success_criteria: [
                    "Task card persists under the local coordinator registry.",
                    "A subagent session can resume and close the task cleanly.",
                ],
                validation_plan: [
                    "Run verify-task-registry.js end to end.",
                ],
                backlog_id: "P0-REPO-060",
                workstream_slug: `${prefix}-queueing`,
                next_action: "Resume in a subagent session.",
            },
            {
                cwd: "/verification",
            },
        );
        createdTaskIDs.push(primary.task.task_id);
        if (primary.task.source_policy !== "web_repo") {
            throw new StateError(
                "Expected research source_policy to persist on the task card.",
            );
        }
        if (
            primary.task.target_artifact_path !==
            "researches/sources/2026-04-30-queueing-retry-coordination-sources.md"
        ) {
            throw new StateError(
                "Expected research target_artifact_path to persist on the task card.",
            );
        }
        const updatedPrimary = updateCoordinationTaskMetadata(
            coordinatorSessionID,
            primary.task.task_id,
            {
                constraints: [
                    "Keep the metadata-update flow explicit.",
                ],
                next_action:
                    "Review the refreshed research metadata before subagent handoff.",
            },
            {
                cwd: "/verification",
            },
        );
        if (updatedPrimary.task.status !== primary.task.status) {
            throw new StateError(
                "Expected /task-update to preserve the current lifecycle status.",
            );
        }
        if (
            updatedPrimary.task.next_action !==
            "Review the refreshed research metadata before subagent handoff."
        ) {
            throw new StateError(
                "Expected /task-update to persist broader metadata changes.",
            );
        }
        // F3 dispatch backstop (Slice 4): stamp an explicit-empty envelope so
        // the create-as-ready task can pass the ready -> working freshness
        // re-check. Placed AFTER updateCoordinationTaskMetadata (which changes
        // constraints — a design-digest field) so the digest reflects the
        // final design state. saveCoordinationTask defaults new tasks to
        // "ready" without going through readyCoordinationTask's primary F3
        // gate; the dispatch backstop catches the bypass unless an envelope is
        // present. Explicit-empty = "author surveyed, named nothing."
        const primaryReloaded = readCoordinationTask(
            coordinatorSessionID,
            primary.task.task_id,
            { cwd: "/verification" },
        );
        const primaryDigest = computeTaskDesignDigest(primaryReloaded.task, {});
        const primaryPath = taskCardPath(primary.task.task_id);
        const primaryData = JSON.parse(
            fs.readFileSync(primaryPath, "utf8"),
        );
        primaryData.f3_design_readiness = {
            ownership_hazards: [],
            design_digest: primaryDigest,
        };
        fs.writeFileSync(primaryPath, JSON.stringify(primaryData, null, 2));

        expectStateError(
            () =>
                saveCoordinationTask(
                    coordinatorSessionID,
                    {
                        title: "Missing research question",
                        task_type: "research",
                        coordination_mode: "short",
                        primary_lane: "research",
                        source_policy: "web_repo",
                        desired_artifact_type: "sources",
                        target_artifact_path:
                            "researches/sources/2026-05-01-missing-research-question.md",
                        files_in_scope: ["researches/README.md"],
                        constraints: ["Verifier-only invalid fixture."],
                        non_goals: ["No durable save expected."],
                        success_criteria: ["Must fail before persistence."],
                        validation_plan: [
                            "Assert the state layer rejects incomplete research tasks.",
                        ],
                    },
                    {
                        cwd: "/verification",
                    },
                ),
            "Research tasks must define research_question",
        );

        expectStateError(
            () =>
                saveCoordinationTask(
                    coordinatorSessionID,
                    {
                        title: "Missing research source policy",
                        task_type: "research",
                        coordination_mode: "short",
                        primary_lane: "research",
                        research_question:
                            "Which source-policy defaults should research tasks use?",
                        desired_artifact_type: "sources",
                        target_artifact_path:
                            "researches/sources/2026-05-01-missing-source-policy.md",
                        files_in_scope: ["researches/README.md"],
                        constraints: ["Verifier-only invalid fixture."],
                        non_goals: ["No durable save expected."],
                        success_criteria: ["Must fail before persistence."],
                        validation_plan: [
                            "Assert the state layer rejects research tasks without source_policy.",
                        ],
                    },
                    {
                        cwd: "/verification",
                    },
                ),
            "Research tasks must define source_policy",
        );

        expectStateError(
            () =>
                saveCoordinationTask(
                    coordinatorSessionID,
                    {
                        title: "Missing research artifact type",
                        task_type: "research",
                        coordination_mode: "short",
                        primary_lane: "research",
                        research_question:
                            "Which durable artifact type should this research produce?",
                        source_policy: "repo_only",
                        target_artifact_path:
                            "researches/sources/2026-05-01-missing-artifact-type.md",
                        files_in_scope: ["researches/README.md"],
                        constraints: ["Verifier-only invalid fixture."],
                        non_goals: ["No durable save expected."],
                        success_criteria: ["Must fail before persistence."],
                        validation_plan: [
                            "Assert the state layer rejects research tasks without desired_artifact_type.",
                        ],
                    },
                    {
                        cwd: "/verification",
                    },
                ),
            "Research tasks must define desired_artifact_type",
        );

        expectStateError(
            () =>
                saveCoordinationTask(
                    coordinatorSessionID,
                    {
                        title: "Missing research artifact path",
                        task_type: "research",
                        coordination_mode: "short",
                        primary_lane: "research",
                        research_question:
                            "Where should this research land durably?",
                        source_policy: "repo_only",
                        desired_artifact_type: "sources",
                        files_in_scope: ["researches/README.md"],
                        constraints: ["Verifier-only invalid fixture."],
                        non_goals: ["No durable save expected."],
                        success_criteria: ["Must fail before persistence."],
                        validation_plan: [
                            "Assert the state layer rejects research tasks without target_artifact_path.",
                        ],
                    },
                    {
                        cwd: "/verification",
                    },
                ),
            "Research tasks must define target_artifact_path",
        );

        expectStateError(
            () =>
                activateCoordinationTask(unboundSessionID, primary.task.task_id, {
                    cwd: "/verification",
                }),
            "requires a bound session alias before it can be resumed",
        );

        expectStateError(
            () =>
                saveCoordinationTaskCloseout(
                    subagentSessionID,
                    primary.task.task_id,
                    {
                        cwd: "/verification",
                        title: "Illegal closeout",
                        body: "Should fail before the task is working.",
                    },
                ),
            "must be working before a closeout can be saved",
        );

        expectStateError(
            () =>
                reviewCoordinationTask(
                    coordinatorSessionID,
                    primary.task.task_id,
                    {
                        cwd: "/verification",
                        title: "Illegal review",
                        body: "Should fail before a closeout exists.",
                        taskStatus: "reported",
                    },
                ),
            "is not ready for coordinator review",
        );

        const overlap = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Check queueing overlap detection",
                task_type: "study",
                coordination_mode: "short",
                primary_lane: "queueing",
                files_in_scope: [
                    "tests/fixtures/example-pkg/",
                ],
                constraints: [
                    "This task exists only to verify overlap reporting.",
                ],
                non_goals: [
                    "No implementation work.",
                ],
                success_criteria: [
                    "Overlap with the primary queueing task is detected.",
                ],
                validation_plan: [
                    "Assert at least one overlap is returned.",
                ],
            },
            {
                cwd: "/verification",
            },
        );
        createdTaskIDs.push(overlap.task.task_id);

        if (!overlap.overlaps || !overlap.overlaps.length) {
            throw new StateError(
                "Expected overlap detection to report the queueing path collision.",
            );
        }

        const draft = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Refine queue backpressure study",
                status: "draft",
                task_type: "study",
                coordination_mode: "short",
                primary_lane: "queueing",
                rough_scope: [
                    "Compare retry and backpressure handling around queue saturation.",
                ],
                open_questions: [
                    "Which queueing files should become the actual execution scope?",
                ],
                ready_criteria: [
                    "Name the file set and concrete validation steps before starting work.",
                ],
                constraints: [
                    "Do not start implementation from the draft itself.",
                ],
                non_goals: [
                    "No behavior changes during refinement.",
                ],
            },
            {
                cwd: "/verification",
            },
        );
        createdTaskIDs.push(draft.task.task_id);

        expectStateError(
            () =>
                activateCoordinationTask(subagentSessionID, draft.task.task_id, {
                    cwd: "/verification",
                }),
            "Use /task-ready for drafts",
        );

        const readyPayload = {
            files_in_scope: [
                "tests/fixtures/example-pkg/",
                "docs/planning/backlog.md",
            ],
            success_criteria: [
                "Draft task can be promoted into execution-ready state.",
            ],
            validation_plan: [
                "Run verify-task-registry.js end to end.",
            ],
            next_action: "Resume the promoted task in a subagent session.",
        };
        readyPayload.f3_design_readiness = {
            ownership_hazards: [],
            design_digest: computeTaskDesignDigest(draft.task, readyPayload),
        };
        const readied = readyCoordinationTask(
            coordinatorSessionID,
            draft.task.task_id,
            readyPayload,
            {
                cwd: "/verification",
            },
        );
        if (readied.task.status !== "ready") {
            throw new StateError("Expected promoted draft task status to be ready.");
        }

        const resumed = activateCoordinationTask(
            subagentSessionID,
            primary.task.task_id,
            {
                cwd: "/verification",
            },
        );
        if (resumed.task.status !== "working") {
            throw new StateError("Expected resumed task status to be working.");
        }
        if (!resumed.task.session_aliases.includes(`${prefix}-subagent`)) {
            throw new StateError(
                "Expected subagent session alias to be attached to the task card.",
            );
        }
        if (resumed.task.active_session_alias !== `${prefix}-subagent`) {
            throw new StateError(
                "Expected resumed task to record the active subagent session alias.",
            );
        }
        if (
            resumed.task.next_action !==
            `Complete the owned execution slice and save /task-closeout ${primary.task.task_id}.`
        ) {
            throw new StateError(
                "Expected ready -> working resume to replace stale pre-execution next_action with the execution closeout step.",
            );
        }

        expectStateError(
            () =>
                activateCoordinationTask(
                    secondSubagentSessionID,
                    primary.task.task_id,
                    {
                        cwd: "/verification",
                    },
                ),
            "already active in session",
        );

        const takenOver = activateCoordinationTask(
            secondSubagentSessionID,
            primary.task.task_id,
            {
                cwd: "/verification",
                forceTakeover: true,
            },
        );
        if (!takenOver.took_over) {
            throw new StateError(
                "Expected second subagent resume to report an explicit takeover.",
            );
        }
        if (takenOver.task.active_session_alias !== `${prefix}-subagent-2`) {
            throw new StateError(
                "Expected takeover to update the active subagent session alias.",
            );
        }
        expectStateError(
            () =>
                updateCoordinationTaskMetadata(
                    coordinatorSessionID,
                    primary.task.task_id,
                    {
                        next_action:
                            "Coordinator should not be able to edit a subagent-owned task mid-flight.",
                    },
                    {
                        cwd: "/verification",
                    },
                ),
            "only that active session can update working-task metadata",
        );
        expectStateError(
            () =>
                updateCoordinationTaskMetadata(
                    secondSubagentSessionID,
                    primary.task.task_id,
                    {
                        files_in_scope: [
                            "tests/fixtures/example-pkg/",
                            "docs/planning/backlog.md",
                        ],
                    },
                    {
                        cwd: "/verification",
                    },
                ),
            "Unsupported fields for task metadata update while working",
        );
        const updatedWhileWorking = updateCoordinationTaskMetadata(
            secondSubagentSessionID,
            primary.task.task_id,
            {
                next_action:
                    "Finish the closeout from the active owner session after the last verification pass.",
            },
            {
                cwd: "/verification",
            },
        );
        if (
            updatedWhileWorking.task.next_action !==
            "Finish the closeout from the active owner session after the last verification pass."
        ) {
            throw new StateError(
                "Expected active owner to update next_action while the task is working.",
            );
        }
        if (takenOver.next_recommended_command !== `/task-closeout ${primary.task.task_id}`) {
            throw new StateError(
                "Expected the active owner session to be told to close out the claimed working task.",
            );
        }

        const coordinatorViewWhileClaimed = readCoordinationTask(
            coordinatorSessionID,
            primary.task.task_id,
            {
                cwd: "/verification",
            },
        );
        if (coordinatorViewWhileClaimed.next_recommended_command !== null) {
            throw new StateError(
                "Expected coordinator view of a foreign claimed working task to suppress direct closeout recommendations.",
            );
        }
        if (
            !String(
                coordinatorViewWhileClaimed.next_recommended_note || "",
            ).includes(`${prefix}-subagent-2`)
        ) {
            throw new StateError(
                "Expected coordinator view of a foreign claimed working task to explain which session currently owns it.",
            );
        }

        const coordinatorInboxWhileClaimed = listCoordinationTasks(
            coordinatorSessionID,
            {
                cwd: "/verification",
                statuses: ["working"],
            },
        );
        const inboxClaimedTask = coordinatorInboxWhileClaimed.tasks.find(
            (task) => task.task_id === primary.task.task_id,
        );
        if (!inboxClaimedTask) {
            throw new StateError(
                "Expected coordinator inbox to include the claimed working task.",
            );
        }
        if (inboxClaimedTask.next_recommended_command !== null) {
            throw new StateError(
                "Expected coordinator inbox entry for a foreign claimed task to suppress direct closeout recommendations.",
            );
        }
        if (
            !String(inboxClaimedTask.next_recommended_note || "").includes(
                `${prefix}-subagent-2`,
            )
        ) {
            throw new StateError(
                "Expected coordinator inbox entry for a foreign claimed task to name the active owner session.",
            );
        }

        expectStateError(
            () =>
                saveCoordinationTaskCloseout(
                    subagentSessionID,
                    primary.task.task_id,
                    {
                        cwd: "/verification",
                        title: "Illegal stale-owner closeout",
                        body: "The previous subagent should not be allowed to close the task.",
                    },
                ),
            "only that active session can save the closeout",
        );

        const firstCloseout = saveCoordinationTaskCloseout(
            secondSubagentSessionID,
            primary.task.task_id,
            {
                cwd: "/verification",
                title: "Queueing task closeout",
                body: [
                    "1. Verified that local task cards persist under `.local/coordinator/tasks/`.",
                    "2. Verified that subagent sessions can reopen the task and attach their session alias.",
                    "3. Verified that closeout reports land under the task-specific local report directory.",
                ].join("\n"),
                taskStatus: "reported",
                reportEnvelope: "standard",
                promotionRecommended: true,
                nextAction: "Coordinator should review and decide whether to promote docs.",
            },
        );
        if (firstCloseout.task.status !== "reported") {
            throw new StateError("Expected closeout to move the task into reported.");
        }
        if (firstCloseout.task.active_session_alias !== null) {
            throw new StateError(
                "Expected closeout to clear the active subagent session alias.",
            );
        }
        const updatedReported = updateCoordinationTaskMetadata(
            coordinatorSessionID,
            primary.task.task_id,
            {
                next_action:
                    "Coordinator should review the reported task and decide whether to reopen or finalize it.",
            },
            {
                cwd: "/verification",
            },
        );
        if (updatedReported.task.status !== "reported") {
            throw new StateError(
                "Expected /task-update to preserve reported status on follow-up updates.",
            );
        }
        if (
            updatedReported.task.next_action !==
            "Coordinator should review the reported task and decide whether to reopen or finalize it."
        ) {
            throw new StateError(
                "Expected coordinator follow-up update to persist next_action on a reported task.",
            );
        }
        expectStateError(
            () =>
                updateCoordinationTaskMetadata(
                    coordinatorSessionID,
                    primary.task.task_id,
                    {
                        workstream_slug: "should-not-change-after-execution-starts",
                    },
                    {
                        cwd: "/verification",
                    },
                ),
            "Unsupported fields for task metadata update while reported",
        );

        expectStateError(
            () =>
                activateCoordinationTask(subagentSessionID, primary.task.task_id, {
                    cwd: "/verification",
                }),
            "Use /task-ready for drafts or /task-review for reported/blocked work",
        );

        const reopened = readCoordinationTask(
            coordinatorSessionID,
            primary.task.task_id,
            {
                cwd: "/verification",
                includeBody: true,
            },
        );
        if (!reopened.latest_report || !reopened.latest_report.body) {
            throw new StateError("Expected task-open to include the latest report body.");
        }

        expectStateError(
            () =>
                reviewCoordinationTask(
                    coordinatorSessionID,
                    primary.task.task_id,
                    {
                        cwd: "/verification",
                        title: "Illegal working review",
                        body: "Coordinator review should reopen work to ready, not directly to working.",
                        taskStatus: "working",
                    },
                ),
            "task_review should resolve to ready, reported, blocked, completed, or cancelled",
        );

        const reviewedReady = reviewCoordinationTask(
            coordinatorSessionID,
            primary.task.task_id,
            {
                cwd: "/verification",
                title: "Coordinator requests follow-up",
                body: [
                    "The slice is directionally correct, but another pass is still required.",
                    "Return this task to ready so the next execution session can claim it explicitly.",
                ].join("\n\n"),
                taskStatus: "ready",
                nextAction: "Resume the task for the final follow-up pass.",
            },
        );
        if (reviewedReady.task.status !== "ready") {
            throw new StateError("Expected coordinator review to reopen the task into ready.");
        }
        if (reviewedReady.task.active_session_alias !== null) {
            throw new StateError(
                "Expected ready review to keep the task unclaimed until a subagent resumes it.",
            );
        }

        const resumedAfterReview = activateCoordinationTask(
            secondSubagentSessionID,
            primary.task.task_id,
            {
                cwd: "/verification",
            },
        );
        if (resumedAfterReview.task.status !== "working") {
            throw new StateError(
                "Expected ready-reviewed task to become working when resumed again.",
            );
        }

        const closeout = saveCoordinationTaskCloseout(
            secondSubagentSessionID,
            primary.task.task_id,
            {
                cwd: "/verification",
                title: "Queueing task final closeout",
                body: [
                    "1. Reopened task resumed cleanly from ready into a fresh working claim.",
                    "2. Final pass completed without violating the active-owner guard.",
                    "3. Local report history remains durable across multiple closeout cycles.",
                ].join("\n"),
                taskStatus: "reported",
                reportEnvelope: "standard",
                promotionRecommended: true,
                nextAction: "Coordinator can finalize the task after this final report.",
            },
        );

        const reviewed = reviewCoordinationTask(
            coordinatorSessionID,
            primary.task.task_id,
            {
                cwd: "/verification",
                title: "Coordinator review",
                body: [
                    "Closeout is sufficient for the local workflow.",
                    "Keep the local registry private and only promote the durable operating guidance.",
                ].join("\n\n"),
                taskStatus: "completed",
                nextAction: "Promote only durable guidance into tracked docs.",
            },
        );
        if (reviewed.task.status !== "completed") {
            throw new StateError("Expected coordinator review to mark the task completed.");
        }
        if (!reviewed.review.path) {
            throw new StateError("Expected coordinator review to persist a review artifact path.");
        }
        if (reviewed.task.active_session_alias !== null) {
            throw new StateError(
                "Expected coordinator review to leave no active subagent session alias.",
            );
        }
        expectStateError(
            () =>
                updateCoordinationTaskMetadata(
                    coordinatorSessionID,
                    primary.task.task_id,
                    {
                        next_action:
                            "This should fail because completed tasks are frozen.",
                    },
                    {
                        cwd: "/verification",
                    },
                ),
            "no longer accepts metadata updates",
        );

        const legacyTaskPath = taskCardPath(primary.task.task_id);
        const legacyPayload = JSON.parse(fs.readFileSync(legacyTaskPath, "utf8"));
        legacyPayload.last_review = {
            ...(legacyPayload.last_review || {}),
        };
        delete legacyPayload.last_review.path;
        fs.writeFileSync(legacyTaskPath, JSON.stringify(legacyPayload, null, 2));

        const reopenedAfterReview = readCoordinationTask(
            coordinatorSessionID,
            primary.task.task_id,
            {
                cwd: "/verification",
                includeBody: true,
            },
        );
        if (
            !reopenedAfterReview.last_review ||
            !reopenedAfterReview.last_review.body
        ) {
            throw new StateError(
                "Expected task-open to include the latest review body.",
            );
        }
        if (reopenedAfterReview.last_review.path !== reviewed.review.path) {
            throw new StateError(
                "Expected legacy last_review entries to backfill the stored review artifact path.",
            );
        }

        const legacyResearch = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Legacy research task missing new contract fields",
                task_type: "research",
                coordination_mode: "short",
                primary_lane: "research",
                research_question:
                    "How should legacy research task cards behave after contract hardening?",
                source_policy: "repo_only",
                desired_artifact_type: "sources",
                target_artifact_path:
                    "researches/sources/2026-05-01-legacy-research-task-compat.md",
                files_in_scope: ["researches/README.md"],
                constraints: ["Compatibility fixture only."],
                non_goals: ["No durable migration output."],
                success_criteria: [
                    "Legacy incomplete research cards remain readable.",
                ],
                validation_plan: ["Mutate fixture and reopen it."],
            },
            {
                cwd: "/verification",
            },
        );
        createdTaskIDs.push(legacyResearch.task.task_id);
        const legacyResearchPath = taskCardPath(legacyResearch.task.task_id);
        const legacyResearchPayload = JSON.parse(
            fs.readFileSync(legacyResearchPath, "utf8"),
        );
        legacyResearchPayload.research_question = "";
        legacyResearchPayload.source_policy = null;
        legacyResearchPayload.desired_artifact_type = null;
        delete legacyResearchPayload.target_artifact_path;
        // F3 dispatch backstop (Slice 4): stamp an explicit-empty envelope so
        // the create-as-ready legacy task can pass the ready -> working
        // freshness re-check after repair restores its research contract
        // fields. The digest covers design fields only (research_question
        // etc. are NOT design-digest scope), so the envelope survives the
        // contract mutation + repair without going stale.
        legacyResearchPayload.f3_design_readiness = {
            ownership_hazards: [],
            design_digest: computeTaskDesignDigest(legacyResearchPayload, {}),
        };
        fs.writeFileSync(
            legacyResearchPath,
            JSON.stringify(legacyResearchPayload, null, 2),
        );
        const reopenedLegacyResearch = readCoordinationTask(
            coordinatorSessionID,
            legacyResearch.task.task_id,
            {
                cwd: "/verification",
            },
        );
        if (reopenedLegacyResearch.task.task_type !== "research") {
            throw new StateError(
                "Expected legacy incomplete research task to remain readable as a research task.",
            );
        }
        if (reopenedLegacyResearch.task.status !== "ready") {
            throw new StateError(
                "Expected legacy incomplete research task to remain readable without lifecycle drift.",
            );
        }
        if (
            reopenedLegacyResearch.next_recommended_command !==
            `/task-repair ${legacyResearch.task.task_id}`
        ) {
            throw new StateError(
                "Expected legacy incomplete research task to recommend /task-repair.",
            );
        }
        if (
            !String(reopenedLegacyResearch.next_recommended_note || "").includes(
                "research_question",
            ) ||
            !String(reopenedLegacyResearch.next_recommended_note || "").includes(
                "source_policy",
            ) ||
            !String(reopenedLegacyResearch.next_recommended_note || "").includes(
                "desired_artifact_type",
            ) ||
            !String(reopenedLegacyResearch.next_recommended_note || "").includes(
                "target_artifact_path",
            )
        ) {
            throw new StateError(
                "Expected legacy incomplete research task to explain which contract fields are missing.",
            );
        }
        expectStateError(
            () =>
                activateCoordinationTask(subagentSessionID, legacyResearch.task.task_id, {
                    cwd: "/verification",
                }),
            "Use /task-repair",
        );
        expectStateError(
            () =>
                updateCoordinationTaskMetadata(
                    coordinatorSessionID,
                    legacyResearch.task.task_id,
                    {
                        next_action: "Should fail until the research contract is repaired.",
                    },
                    {
                        cwd: "/verification",
                    },
                ),
            "Use /task-repair",
        );
        const repairedLegacyResearch = repairCoordinationTask(
            coordinatorSessionID,
            legacyResearch.task.task_id,
            {
                research_question:
                    "How should legacy research task cards be repaired after contract hardening?",
                source_policy: "repo_only",
                desired_artifact_type: "sources",
                target_artifact_path:
                    "researches/sources/2026-05-01-legacy-research-task-compat.md",
            },
            {
                cwd: "/verification",
            },
        );
        if (
            repairedLegacyResearch.task.research_question !==
            "How should legacy research task cards be repaired after contract hardening?"
        ) {
            throw new StateError(
                "Expected /task-repair to persist research_question on the legacy research task.",
            );
        }
        if (repairedLegacyResearch.task.desired_artifact_type !== "sources") {
            throw new StateError(
                "Expected /task-repair to persist desired_artifact_type on the legacy research task.",
            );
        }
        expectStateError(
            () =>
                repairCoordinationTask(
                    coordinatorSessionID,
                    repairedLegacyResearch.task.task_id,
                    {
                        research_question:
                            "This should now fail because the card is already complete.",
                    },
                    {
                        cwd: "/verification",
                    },
                ),
            "Use /task-update",
        );
        if (
            repairedLegacyResearch.next_recommended_command !==
            `/resume-task ${legacyResearch.task.task_id}`
        ) {
            throw new StateError(
                "Expected repaired legacy research task to recommend /resume-task.",
            );
        }
        const resumedLegacyResearch = activateCoordinationTask(
            subagentSessionID,
            legacyResearch.task.task_id,
            {
                cwd: "/verification",
            },
        );
        if (resumedLegacyResearch.task.status !== "working") {
            throw new StateError(
                "Expected repaired legacy research task to resume into working state.",
            );
        }

        const legacySingleAlias = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Legacy ownerless working task with single alias",
                task_type: "study",
                coordination_mode: "short",
                primary_lane: "queueing",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                constraints: ["Compatibility fixture only."],
                non_goals: ["No implementation work."],
                success_criteria: ["Single-alias legacy owner can be backfilled."],
                validation_plan: ["Mutate fixture and reopen it."],
            },
            {
                cwd: "/verification",
            },
        );
        createdTaskIDs.push(legacySingleAlias.task.task_id);
        const legacySingleAliasPath = taskCardPath(legacySingleAlias.task.task_id);
        const legacySingleAliasPayload = JSON.parse(
            fs.readFileSync(legacySingleAliasPath, "utf8"),
        );
        legacySingleAliasPayload.status = "working";
        legacySingleAliasPayload.active_session_alias = null;
        legacySingleAliasPayload.claimed_at = null;
        legacySingleAliasPayload.session_aliases = ["legacy-single-owner"];
        fs.writeFileSync(
            legacySingleAliasPath,
            JSON.stringify(legacySingleAliasPayload, null, 2),
        );
        const reopenedLegacySingleAlias = readCoordinationTask(
            coordinatorSessionID,
            legacySingleAlias.task.task_id,
            {
                cwd: "/verification",
            },
        );
        if (reopenedLegacySingleAlias.task.status !== "working") {
            throw new StateError(
                "Expected single-alias legacy working task to remain working after compatibility backfill.",
            );
        }
        if (
            reopenedLegacySingleAlias.task.active_session_alias !==
            "legacy-single-owner"
        ) {
            throw new StateError(
                "Expected single-alias legacy working task to backfill active owner from session_aliases.",
            );
        }

        const legacyAmbiguous = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Legacy ownerless working task with ambiguous aliases",
                task_type: "study",
                coordination_mode: "short",
                primary_lane: "queueing",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                constraints: ["Compatibility fixture only."],
                non_goals: ["No implementation work."],
                success_criteria: ["Ambiguous legacy ownerless task downgrades to ready."],
                validation_plan: ["Mutate fixture and reopen it."],
            },
            {
                cwd: "/verification",
            },
        );
        createdTaskIDs.push(legacyAmbiguous.task.task_id);
        const legacyAmbiguousPath = taskCardPath(legacyAmbiguous.task.task_id);
        const legacyAmbiguousPayload = JSON.parse(
            fs.readFileSync(legacyAmbiguousPath, "utf8"),
        );
        legacyAmbiguousPayload.status = "working";
        legacyAmbiguousPayload.active_session_alias = null;
        legacyAmbiguousPayload.claimed_at = null;
        legacyAmbiguousPayload.session_aliases = ["legacy-a", "legacy-b"];
        fs.writeFileSync(
            legacyAmbiguousPath,
            JSON.stringify(legacyAmbiguousPayload, null, 2),
        );
        const reopenedLegacyAmbiguous = readCoordinationTask(
            coordinatorSessionID,
            legacyAmbiguous.task.task_id,
            {
                cwd: "/verification",
            },
        );
        if (reopenedLegacyAmbiguous.task.status !== "ready") {
            throw new StateError(
                "Expected ambiguous ownerless legacy working task to downgrade into ready.",
            );
        }
        if (reopenedLegacyAmbiguous.task.active_session_alias !== null) {
            throw new StateError(
                "Expected ambiguous ownerless legacy task to stay unclaimed after downgrade.",
            );
        }

        const listed = listCoordinationTasks(coordinatorSessionID, {
            cwd: "/verification",
            statuses: ["completed", "ready", "draft", "working"],
        });
        if (!listed.tasks.find((task) => task.task_id === primary.task.task_id)) {
            throw new StateError("Expected completed task to be visible in filtered list.");
        }
        if (!listed.tasks.find((task) => task.task_id === draft.task.task_id)) {
            throw new StateError("Expected promoted draft task to be visible in filtered list.");
        }
        if (!listed.tasks.find((task) => task.task_id === legacyResearch.task.task_id)) {
            throw new StateError(
                "Expected legacy incomplete research task to remain visible in filtered list.",
            );
        }
        if (!listed.tasks.find((task) => task.task_id === primary.task.task_id)) {
            throw new StateError(
                "Expected legacy-compatible completed task to remain listable after last_review backfill.",
            );
        }

        // ------------------------------------------------------------------
        // Resilience: a card with a bad STORED enum value (written directly
        // to the task store, bypassing the validating save path) must NOT
        // brick listCoordinationTasks(). Before the fix, a single bad enum
        // threw inside normalizeCoordinationTaskRecord (and again inside
        // loadCoordinationTask's throwing ensureCoordinationTaskCoreFields)
        // and aborted the ENTIRE list plus every load-based op. After the
        // fix the bad value coerces to "" (per-field default applies) and
        // the good cards are still returned — blast radius contained.
        // ------------------------------------------------------------------
        const resilienceSentinel = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Resilience sentinel good card",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "resilience",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                constraints: ["Resilience fixture only."],
                non_goals: ["No implementation work."],
                success_criteria: [
                    "List stays healthy when a sibling card has a bad stored enum.",
                ],
                validation_plan: [
                    "Inject a bad enum on a sibling card and re-list.",
                ],
            },
            {
                cwd: "/verification",
            },
        );
        createdTaskIDs.push(resilienceSentinel.task.task_id);

        const resilienceBadEnum = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Resilience bad-enum card",
                task_type: "study",
                coordination_mode: "short",
                primary_lane: "resilience",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                constraints: ["Resilience fixture only."],
                non_goals: ["No implementation work."],
                success_criteria: [
                    "Bad stored enum coerces; never bricks the registry.",
                ],
                validation_plan: [
                    "Mutate task_type/status/mode/envelope on disk and re-list.",
                ],
            },
            {
                cwd: "/verification",
            },
        );
        createdTaskIDs.push(resilienceBadEnum.task.task_id);

        // Corrupt the stored card directly on disk, bypassing the save path
        // (the realistic way a bad enum reaches the store: a prior schema
        // version, a manual edit, or a code regression).
        const resilienceBadEnumPath = taskCardPath(
            resilienceBadEnum.task.task_id,
        );
        const resilienceBadEnumPayload = JSON.parse(
            fs.readFileSync(resilienceBadEnumPath, "utf8"),
        );
        resilienceBadEnumPayload.task_type = "bogus-type";
        resilienceBadEnumPayload.status = "bogus-status";
        resilienceBadEnumPayload.coordination_mode = "bogus-mode";
        resilienceBadEnumPayload.report_envelope = "bogus-envelope";
        resilienceBadEnumPayload.source_policy = "bogus-policy";
        resilienceBadEnumPayload.desired_artifact_type = "bogus-artifact";
        fs.writeFileSync(
            resilienceBadEnumPath,
            JSON.stringify(resilienceBadEnumPayload, null, 2),
        );

        // CRUX assertion: list must NOT throw and must still return the good
        // sentinel card (blast radius contained to the degraded card).
        let resilienceListError = null;
        let resilienceListed = null;
        try {
            resilienceListed = listCoordinationTasks(coordinatorSessionID, {
                cwd: "/verification",
            });
        } catch (error) {
            resilienceListError = error;
        }
        if (resilienceListError) {
            throw new StateError(
                `Expected listCoordinationTasks() NOT to throw when a sibling card has a bad stored enum; got: ${resilienceListError instanceof Error ? resilienceListError.message : String(resilienceListError)}`,
            );
        }
        if (
            !resilienceListed.tasks.find(
                (task) => task.task_id === resilienceSentinel.task.task_id,
            )
        ) {
            throw new StateError(
                "Expected good sentinel card to remain listable despite a sibling card's bad stored enum.",
            );
        }
        const coercedBadEnum = resilienceListed.tasks.find(
            (task) => task.task_id === resilienceBadEnum.task.task_id,
        );
        if (!coercedBadEnum) {
            throw new StateError(
                "Expected bad-enum card itself to remain listable (coerced), proving the blast radius is contained.",
            );
        }
        // Bad stored values must NOT propagate verbatim into the listed
        // output. task_type has no default → coerces to ""; bad status
        // coerces to the "draft" default.
        if (coercedBadEnum.task_type !== "") {
            throw new StateError(
                `Expected bad task_type to coerce to "", got "${coercedBadEnum.task_type}".`,
            );
        }
        if (coercedBadEnum.status !== "draft") {
            throw new StateError(
                `Expected bad status to coerce to default "draft", got "${coercedBadEnum.status}".`,
            );
        }

        // ------------------------------------------------------------------
        // Positive coverage: the widened task_type enum now accepts docs and
        // verification without the save path throwing.
        // ------------------------------------------------------------------
        const docsTask = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Docs task type accepted after enum widening",
                task_type: "docs",
                coordination_mode: "short",
                primary_lane: "docs",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                constraints: ["Enum widening fixture only."],
                non_goals: ["No implementation work."],
                success_criteria: ["saveCoordinationTask accepts task_type=docs."],
                validation_plan: ["Save and read back."],
            },
            {
                cwd: "/verification",
            },
        );
        createdTaskIDs.push(docsTask.task.task_id);
        if (docsTask.task.task_type !== "docs") {
            throw new StateError(
                `Expected task_type "docs" to round-trip, got "${docsTask.task.task_type}".`,
            );
        }

        const verificationTask = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Verification task type accepted after enum widening",
                task_type: "verification",
                coordination_mode: "short",
                primary_lane: "verification",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                constraints: ["Enum widening fixture only."],
                non_goals: ["No implementation work."],
                success_criteria: [
                    "saveCoordinationTask accepts task_type=verification.",
                ],
                validation_plan: ["Save and read back."],
            },
            {
                cwd: "/verification",
            },
        );
        createdTaskIDs.push(verificationTask.task.task_id);
        if (verificationTask.task.task_type !== "verification") {
            throw new StateError(
                `Expected task_type "verification" to round-trip, got "${verificationTask.task.task_type}".`,
            );
        }

        // ------------------------------------------------------------------
        // Quarantine reporting: degraded cards (bad stored enum or missing
        // core field) must be surfaced in a structured quarantine[] field,
        // excluded from healthy counts, refused at the action boundary, and
        // kept out of overlap detection — NOT silently coerced into a
        // plausible healthy state. This is the report-and-continue contract:
        // list still returns degraded cards in tasks[] (compat) but marks
        // them degraded:true and routes them into quarantine[]; the
        // safeguard is the action-boundary refusal + projection exclusion.
        // ------------------------------------------------------------------
        const quarantineScope = "tests/fixtures/quarantine-scope/";

        // Healthy sentinel — must stay out of quarantine and in healthy counts.
        const quarantineSentinel = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Quarantine sentinel healthy card",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "quarantine",
                files_in_scope: [quarantineScope],
                constraints: ["Quarantine fixture only."],
                non_goals: ["No implementation work."],
                success_criteria: [
                    "Healthy sentinel lists and reads while siblings are degraded.",
                ],
                validation_plan: [
                    "Corrupt sibling cards on disk and re-list + re-read.",
                ],
            },
            { cwd: "/verification" },
        );
        createdTaskIDs.push(quarantineSentinel.task.task_id);

        // Case 1: invalid stored status (otherwise valid) → quarantine.
        const quarantineBadStatus = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Quarantine bad-status card",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "quarantine",
                files_in_scope: [quarantineScope],
                constraints: ["Quarantine fixture only."],
                non_goals: ["No implementation work."],
                success_criteria: ["Bad stored status surfaces in quarantine."],
                validation_plan: ["Mutate status on disk and re-list."],
            },
            { cwd: "/verification" },
        );
        createdTaskIDs.push(quarantineBadStatus.task.task_id);
        const qBadStatusPath = taskCardPath(quarantineBadStatus.task.task_id);
        const qBadStatusPayload = JSON.parse(
            fs.readFileSync(qBadStatusPath, "utf8"),
        );
        qBadStatusPayload.status = "totally-bogus-status";
        fs.writeFileSync(
            qBadStatusPath,
            JSON.stringify(qBadStatusPayload, null, 2),
        );

        // Case 2: missing required core field → quarantine.
        const quarantineMissingField = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Quarantine missing-field card",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "quarantine",
                files_in_scope: [quarantineScope],
                constraints: ["Quarantine fixture only."],
                non_goals: ["No implementation work."],
                success_criteria: ["Missing core field surfaces in quarantine."],
                validation_plan: ["Delete primary_lane on disk and re-list."],
            },
            { cwd: "/verification" },
        );
        createdTaskIDs.push(quarantineMissingField.task.task_id);
        const qMissingPath = taskCardPath(quarantineMissingField.task.task_id);
        const qMissingPayload = JSON.parse(
            fs.readFileSync(qMissingPath, "utf8"),
        );
        delete qMissingPayload.primary_lane;
        fs.writeFileSync(qMissingPath, JSON.stringify(qMissingPayload, null, 2));

        // Case 3: multiple bad fields → ONE combined quarantine entry.
        const quarantineMultiBad = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Quarantine multi-bad card",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "quarantine",
                files_in_scope: [quarantineScope],
                constraints: ["Quarantine fixture only."],
                non_goals: ["No implementation work."],
                success_criteria: ["Multiple bad fields → one combined entry."],
                validation_plan: ["Mutate status+task_type on disk and re-list."],
            },
            { cwd: "/verification" },
        );
        createdTaskIDs.push(quarantineMultiBad.task.task_id);
        const qMultiPath = taskCardPath(quarantineMultiBad.task.task_id);
        const qMultiPayload = JSON.parse(fs.readFileSync(qMultiPath, "utf8"));
        qMultiPayload.status = "bogus";
        qMultiPayload.task_type = "bogus";
        fs.writeFileSync(qMultiPath, JSON.stringify(qMultiPayload, null, 2));

        // ------------------------------------------------------------------
        // List and assert the quarantine contract.
        // ------------------------------------------------------------------
        const quarantineList = listCoordinationTasks(coordinatorSessionID, {
            cwd: "/verification",
        });

        // Case 1: bad-status card in quarantine with correct shape.
        const qBadStatusEntry = quarantineList.quarantine.find(
            (entry) => entry.card_id === quarantineBadStatus.task.task_id,
        );
        if (!qBadStatusEntry) {
            throw new StateError(
                "Case 1: expected bad-status card to appear in quarantine[].",
            );
        }
        if (qBadStatusEntry.error_type !== "semantic") {
            throw new StateError(
                `Case 1: expected error_type "semantic", got "${qBadStatusEntry.error_type}".`,
            );
        }
        if (!qBadStatusEntry.offending_fields.includes("status")) {
            throw new StateError(
                `Case 1: expected offending_fields to include "status", got [${qBadStatusEntry.offending_fields.join(", ")}].`,
            );
        }
        if (!qBadStatusEntry.problems.length) {
            throw new StateError(
                "Case 1: expected at least one deterministic problem message.",
            );
        }
        if (
            !qBadStatusEntry.path ||
            qBadStatusEntry.path.startsWith("/")
        ) {
            throw new StateError(
                "Case 1: expected repo-relative path (not absolute) in quarantine entry.",
            );
        }

        // Case 1 compat: degraded card still in tasks[] with degraded flag.
        const qBadStatusInTasks = quarantineList.tasks.find(
            (task) => task.task_id === quarantineBadStatus.task.task_id,
        );
        if (!qBadStatusInTasks) {
            throw new StateError(
                "Case 1 compat: expected degraded card to remain in tasks[].",
            );
        }
        if (!qBadStatusInTasks.degraded) {
            throw new StateError(
                "Case 1 compat: expected degraded card to carry degraded:true in tasks[].",
            );
        }

        // Case 2: missing-field card in quarantine.
        const qMissingEntry = quarantineList.quarantine.find(
            (entry) => entry.card_id === quarantineMissingField.task.task_id,
        );
        if (!qMissingEntry) {
            throw new StateError(
                "Case 2: expected missing-field card to appear in quarantine[].",
            );
        }
        if (!qMissingEntry.offending_fields.includes("primary_lane")) {
            throw new StateError(
                `Case 2: expected offending_fields to include "primary_lane", got [${qMissingEntry.offending_fields.join(", ")}].`,
            );
        }

        // Case 3: multiple bad fields → exactly ONE combined entry.
        const qMultiEntries = quarantineList.quarantine.filter(
            (entry) => entry.card_id === quarantineMultiBad.task.task_id,
        );
        if (qMultiEntries.length !== 1) {
            throw new StateError(
                `Case 3: expected exactly ONE quarantine entry for multi-bad card, got ${qMultiEntries.length}.`,
            );
        }
        if (
            !qMultiEntries[0].offending_fields.includes("status") ||
            !qMultiEntries[0].offending_fields.includes("task_type")
        ) {
            throw new StateError(
                `Case 3: expected combined offending_fields to include both status and task_type, got [${qMultiEntries[0].offending_fields.join(", ")}].`,
            );
        }

        // Case 4: valid sentinel in tasks + healthy counts, NOT degraded, NOT quarantined.
        const qSentinelInTasks = quarantineList.tasks.find(
            (task) => task.task_id === quarantineSentinel.task.task_id,
        );
        if (!qSentinelInTasks) {
            throw new StateError(
                "Case 4: expected healthy sentinel to remain in tasks[].",
            );
        }
        if (qSentinelInTasks.degraded) {
            throw new StateError(
                "Case 4: expected healthy sentinel to NOT be degraded.",
            );
        }
        const qSentinelInQuarantine = quarantineList.quarantine.find(
            (entry) => entry.card_id === quarantineSentinel.task.task_id,
        );
        if (qSentinelInQuarantine) {
            throw new StateError(
                "Case 4: expected healthy sentinel to NOT appear in quarantine[].",
            );
        }

        // Case 4: degraded_count invariant.
        if (
            quarantineList.degraded_count !== quarantineList.quarantine.length
        ) {
            throw new StateError(
                `Case 4: expected degraded_count === quarantine.length, got ${quarantineList.degraded_count} vs ${quarantineList.quarantine.length}.`,
            );
        }

        // Case 4: healthy_total is a positive number (sentinel exists).
        if (
            typeof quarantineList.healthy_total !== "number" ||
            quarantineList.healthy_total < 1
        ) {
            throw new StateError(
                `Case 4: expected healthy_total >= 1, got ${quarantineList.healthy_total}.`,
            );
        }
        if (typeof quarantineList.healthy_status_counts !== "object") {
            throw new StateError(
                "Case 4: expected healthy_status_counts to be an object.",
            );
        }

        // Case 6: degraded card gets NO /task-ready recommendation.
        if (
            qBadStatusInTasks.next_recommended_command ===
            `/task-ready ${quarantineBadStatus.task.task_id}`
        ) {
            throw new StateError(
                "Case 6: expected degraded card to NOT recommend /task-ready.",
            );
        }

        // Case 6: degraded card excluded from overlap detection. The sentinel
        // shares quarantineScope with all three degraded cards; if overlap
        // detection ran on degraded cards, the sentinel's overlaps would list
        // them. After the fix, listCoordinationTaskCards returns healthy-only
        // and the degraded siblings must NOT appear.
        const sentinelRead = readCoordinationTask(
            coordinatorSessionID,
            quarantineSentinel.task.task_id,
            { cwd: "/verification" },
        );
        const degradedIDs = new Set([
            quarantineBadStatus.task.task_id,
            quarantineMissingField.task.task_id,
            quarantineMultiBad.task.task_id,
        ]);
        for (const overlap of sentinelRead.overlaps) {
            if (degradedIDs.has(overlap.task_id)) {
                throw new StateError(
                    `Case 6: expected degraded card ${overlap.task_id} to be EXCLUDED from overlap detection.`,
                );
            }
        }

        // Case 7: CRUX — readyCoordinationTask REFUSES a degraded card at the
        // action boundary. This is the load-bearing safety assertion: even
        // though the degraded status coerced to "draft" (which would normally
        // pass the status guard), the action-boundary refusal fires first.
        let readyRefusalError = null;
        try {
            readyCoordinationTask(
                coordinatorSessionID,
                quarantineBadStatus.task.task_id,
                {},
                { cwd: "/verification" },
            );
        } catch (error) {
            readyRefusalError = error;
        }
        if (!readyRefusalError) {
            throw new StateError(
                "Case 7 CRUX: expected readyCoordinationTask to REFUSE a degraded card (action boundary must close).",
            );
        }
        const readyRefusalMsg =
            readyRefusalError instanceof Error
                ? readyRefusalError.message
                : String(readyRefusalError);
        if (!/degraded/i.test(readyRefusalMsg)) {
            throw new StateError(
                `Case 7 CRUX: expected refusal message to mention "degraded", got: ${readyRefusalMsg}`,
            );
        }

        // Case 5: reading/operating on a valid card still succeeds when
        // another is degraded. The sentinel read above already proves this
        // (it returned without throwing despite three degraded siblings).
        // Reinforce: the sentinel's single-card read also carries degraded:false.
        if (sentinelRead.degraded) {
            throw new StateError(
                "Case 5: expected healthy sentinel read to carry degraded:false.",
            );
        }

        // Case 9: a degraded card's single-card read surfaces the degradation.
        const degradedRead = readCoordinationTask(
            coordinatorSessionID,
            quarantineBadStatus.task.task_id,
            { cwd: "/verification" },
        );
        if (!degradedRead.degraded) {
            throw new StateError(
                "Case 9: expected degraded card single-card read to carry degraded:true.",
            );
        }
        if (
            !degradedRead.diagnostics ||
            !degradedRead.diagnostics.offending_fields.includes("status")
        ) {
            throw new StateError(
                "Case 9: expected degraded card read to surface offending field 'status' in diagnostics.",
            );
        }

        // ------------------------------------------------------------------
        // Syntax-invalid quarantine (filename-level): a SINGLE corrupt `.json`
        // file used to brick the whole registry scan (readJson throws on a
        // JSON.parse failure and loadCoordinationTask propagated it). The fix
        // catches the parse failure per card, emits a filename-level quarantine
        // entry (no normalized task — no offending_fields), and CONTINUES. The
        // scan must NOT swallow genuine filesystem errors — but a corrupt-JSON
        // sibling must not poison a healthy sentinel.
        // ------------------------------------------------------------------
        const syntaxScope = "tests/fixtures/syntax-quarantine-scope/";

        // Healthy sentinel — must still list and read despite a corrupt sibling.
        const syntaxSentinel = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Syntax quarantine sentinel healthy card",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "quarantine",
                files_in_scope: [syntaxScope],
                constraints: ["Syntax quarantine fixture only."],
                non_goals: ["No implementation work."],
                success_criteria: [
                    "Healthy sentinel lists and reads while a sibling is syntax-corrupt.",
                ],
                validation_plan: [
                    "Write a corrupt sibling .json to disk and re-list + re-read.",
                ],
            },
            { cwd: "/verification" },
        );
        createdTaskIDs.push(syntaxSentinel.task.task_id);

        // Corrupt sibling: invalid JSON that JSON.parse rejects (the exact
        // defect that used to brick the scan). Written directly to the tasks
        // dir; tracked for cleanup via createdTaskIDs (cleanupArtifacts removes
        // `<taskID>.json`).
        const syntaxCorruptID =
            "verification-syntax-corrupt-fixture-card";
        const syntaxCorruptPath = taskCardPath(syntaxCorruptID);
        fs.writeFileSync(syntaxCorruptPath, "{ not valid json,,, ");
        createdTaskIDs.push(syntaxCorruptID);

        // CRUX: the scan does NOT throw despite one corrupt sibling.
        let syntaxList = null;
        try {
            syntaxList = listCoordinationTasks(coordinatorSessionID, {
                cwd: "/verification",
            });
        } catch (error) {
            throw new StateError(
                `Syntax CRUX: listCoordinationTasks threw on a corrupt sibling: ${error && error.message ? error.message : error}`,
            );
        }

        // The healthy sentinel is still returned in tasks[] and is NOT degraded.
        const syntaxSentinelInTasks = syntaxList.tasks.find(
            (task) => task.task_id === syntaxSentinel.task.task_id,
        );
        if (!syntaxSentinelInTasks) {
            throw new StateError(
                "Syntax CRUX: expected healthy sentinel to remain in tasks[] despite a corrupt sibling.",
            );
        }
        if (syntaxSentinelInTasks.degraded) {
            throw new StateError(
                "Syntax CRUX: expected healthy sentinel to NOT be degraded.",
            );
        }

        // The corrupt file appears in quarantine[] keyed by filename stem, with
        // error_type "syntax" and empty offending_fields (no normalized task).
        const syntaxEntry = syntaxList.quarantine.find(
            (entry) => entry.card_id === syntaxCorruptID,
        );
        if (!syntaxEntry) {
            throw new StateError(
                "Syntax CRUX: expected corrupt file to appear in quarantine[] keyed by filename stem.",
            );
        }
        if (syntaxEntry.error_type !== "syntax") {
            throw new StateError(
                `Syntax CRUX: expected error_type "syntax", got "${syntaxEntry.error_type}".`,
            );
        }
        if (syntaxEntry.offending_fields.length !== 0) {
            throw new StateError(
                `Syntax CRUX: expected offending_fields [] (no normalized task), got [${syntaxEntry.offending_fields.join(", ")}].`,
            );
        }
        if (!syntaxEntry.problems.length) {
            throw new StateError(
                "Syntax CRUX: expected at least one parse-error problem message.",
            );
        }
        if (!syntaxEntry.path || syntaxEntry.path.startsWith("/")) {
            throw new StateError(
                "Syntax CRUX: expected repo-relative path (not absolute) in quarantine entry.",
            );
        }

        // The corrupt file must NOT appear in tasks[] (there is no parseable
        // task to show) and must NOT be counted in total/healthy_total.
        const syntaxCorruptInTasks = syntaxList.tasks.find(
            (task) => task.task_id === syntaxCorruptID,
        );
        if (syntaxCorruptInTasks) {
            throw new StateError(
                "Syntax CRUX: expected corrupt file to NOT appear in tasks[].",
            );
        }

        // Semantic + syntax quarantine coexist: the degraded semantic siblings
        // from the earlier block (bad-status / missing-field / multi-bad) are
        // still reported with error_type "semantic", while the corrupt file is
        // error_type "syntax". Both error_type values must be present.
        const semanticEntries = syntaxList.quarantine.filter(
            (entry) => entry.error_type === "semantic",
        );
        const syntaxEntries = syntaxList.quarantine.filter(
            (entry) => entry.error_type === "syntax",
        );
        if (!semanticEntries.length) {
            throw new StateError(
                "Syntax coexistence: expected at least one semantic quarantine entry to survive alongside the syntax entry.",
            );
        }
        if (syntaxEntries.length !== 1) {
            throw new StateError(
                `Syntax coexistence: expected exactly ONE syntax quarantine entry, got ${syntaxEntries.length}.`,
            );
        }

        // degraded_count invariant still holds across both error types.
        if (syntaxList.degraded_count !== syntaxList.quarantine.length) {
            throw new StateError(
                `Syntax coexistence: expected degraded_count === quarantine.length, got ${syntaxList.degraded_count} vs ${syntaxList.quarantine.length}.`,
            );
        }

        // Case 10: degraded-core repair branch (lifecycle-exit recovery).
        // A degraded non-research card can be repaired in place via repair; a
        // healthy card's task_type/status stay immutable; the research-repair
        // path is unchanged; research->degraded overlap and tolerated-contract
        // dispatch are handled explicitly. (Save-path bogus-enum throw is
        // preserved in verify-state-validation.js.)
        function degradeCard(taskID, mutator) {
            const cardPath = taskCardPath(taskID);
            const data = JSON.parse(fs.readFileSync(cardPath, "utf8"));
            mutator(data);
            fs.writeFileSync(cardPath, JSON.stringify(data, null, 2));
        }

        // 10a. Degraded non-research repair succeeds.
        const degradedImpl = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Degraded impl repair recovery",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "build",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["Card is valid again."],
                validation_plan: ["Read back non-degraded."],
            },
            { cwd: "/verification" },
        );
        createdTaskIDs.push(degradedImpl.task.task_id);
        degradeCard(degradedImpl.task.task_id, (data) => {
            data.task_type = "";
        });
        const degradedImplRead = readCoordinationTask(
            coordinatorSessionID,
            degradedImpl.task.task_id,
            { cwd: "/verification" },
        );
        if (!degradedImplRead.degraded) {
            throw new StateError("Case 10a: expected degraded card after clearing task_type.");
        }
        if (!degradedImplRead.diagnostics.offending_fields.includes("task_type")) {
            throw new StateError("Case 10a: expected task_type in offending fields.");
        }
        repairCoordinationTask(
            coordinatorSessionID,
            degradedImpl.task.task_id,
            { task_type: "implementation" },
            { cwd: "/verification" },
        );
        const repairedImplRead = readCoordinationTask(
            coordinatorSessionID,
            degradedImpl.task.task_id,
            { cwd: "/verification" },
        );
        if (repairedImplRead.degraded) {
            throw new StateError("Case 10a: expected card non-degraded after repair.");
        }
        if (repairedImplRead.task.task_type !== "implementation") {
            throw new StateError("Case 10a: expected task_type restored to implementation.");
        }

        // 10b. Atomic multi-field recovery: partial repair rejected, no write;
        // complete repair succeeds atomically.
        const degradedMulti = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Degraded multi-field atomic recovery",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "build",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["Atomic recovery."],
                validation_plan: ["Partial must not write."],
            },
            { cwd: "/verification" },
        );
        createdTaskIDs.push(degradedMulti.task.task_id);
        degradeCard(degradedMulti.task.task_id, (data) => {
            data.task_type = "";
            data.coordination_mode = "";
        });
        expectStateError(
            () =>
                repairCoordinationTask(
                    coordinatorSessionID,
                    degradedMulti.task.task_id,
                    { task_type: "implementation" },
                    { cwd: "/verification" },
                ),
            "still missing",
        );
        const partialRead = readCoordinationTask(
            coordinatorSessionID,
            degradedMulti.task.task_id,
            { cwd: "/verification" },
        );
        if (!partialRead.degraded) {
            throw new StateError("Case 10b: partial repair must NOT have written (card still degraded).");
        }
        // No-write proof: the supplied repair value (task_type) must NOT have
        // persisted, and the still-corrupted field (coordination_mode) must
        // remain empty. An impl that wrote task_type before rejecting would
        // leave the card degraded but with task_type restored -- hiding the
        // atomicity claim.
        if (partialRead.task.task_type !== "") {
            throw new StateError("Case 10b: partial repair must not persist the supplied task_type (no-write violated).");
        }
        if (partialRead.task.coordination_mode !== "") {
            throw new StateError("Case 10b: still-corrupted coordination_mode must remain unchanged (no-write violated).");
        }
        repairCoordinationTask(
            coordinatorSessionID,
            degradedMulti.task.task_id,
            { task_type: "implementation", coordination_mode: "short" },
            { cwd: "/verification" },
        );
        const multiRepairedRead = readCoordinationTask(
            coordinatorSessionID,
            degradedMulti.task.task_id,
            { cwd: "/verification" },
        );
        if (multiRepairedRead.degraded) {
            throw new StateError("Case 10b: complete repair must clear degraded.");
        }

        // 10c. Healthy-card immutability: a HEALTHY (non-degraded) card cannot
        // change task_type/status via repair (carve-out is degraded-only).
        const healthyImpl = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Healthy immutability sentinel",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "build",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["task_type/status immutable."],
                validation_plan: ["Refused with no mutation."],
            },
            { cwd: "/verification" },
        );
        createdTaskIDs.push(healthyImpl.task.task_id);
        const healthyRead = readCoordinationTask(
            coordinatorSessionID,
            healthyImpl.task.task_id,
            { cwd: "/verification" },
        );
        if (healthyRead.degraded) {
            throw new StateError("Case 10c: sentinel card must be healthy (non-degraded).");
        }
        expectStateError(
            () =>
                repairCoordinationTask(
                    coordinatorSessionID,
                    healthyImpl.task.task_id,
                    { task_type: "research" },
                    { cwd: "/verification" },
                ),
            "does not use the research repair flow",
        );
        expectStateError(
            () =>
                repairCoordinationTask(
                    coordinatorSessionID,
                    healthyImpl.task.task_id,
                    { status: "completed" },
                    { cwd: "/verification" },
                ),
            "does not use the research repair flow",
        );
        const healthyAfter = readCoordinationTask(
            coordinatorSessionID,
            healthyImpl.task.task_id,
            { cwd: "/verification" },
        );
        if (healthyAfter.task.task_type !== "implementation" || healthyAfter.task.status !== "ready") {
            throw new StateError("Case 10c: healthy card task_type/status unchanged after refused repair.");
        }

        // 10d. Research->degraded overlap (residual risk #2): a research card
        // whose task_type is corrupted surfaces as non-research degraded; the
        // degraded branch restores the core field and the intact research
        // contract survives.
        const overlapResearch = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Research degraded overlap sentinel",
                task_type: "research",
                coordination_mode: "medium",
                primary_lane: "queueing",
                research_question: "How should overlap repair behave?",
                source_policy: "repo_only",
                desired_artifact_type: "sources",
                target_artifact_path: "researches/sources/overlap.md",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["task_type restored to research."],
                validation_plan: ["Read back research + contract intact."],
            },
            { cwd: "/verification" },
        );
        createdTaskIDs.push(overlapResearch.task.task_id);
        const overlapBefore = readCoordinationTask(
            coordinatorSessionID,
            overlapResearch.task.task_id,
            { cwd: "/verification" },
        );
        if (overlapBefore.degraded) {
            throw new StateError("Case 10d: research card must be healthy before corruption.");
        }
        degradeCard(overlapResearch.task.task_id, (data) => {
            data.task_type = "";
        });
        const overlapDegraded = readCoordinationTask(
            coordinatorSessionID,
            overlapResearch.task.task_id,
            { cwd: "/verification" },
        );
        if (!overlapDegraded.degraded) {
            throw new StateError("Case 10d: research card with cleared task_type must be degraded.");
        }
        if (!overlapDegraded.diagnostics.offending_fields.includes("task_type")) {
            throw new StateError("Case 10d: expected task_type in offending fields.");
        }
        repairCoordinationTask(
            coordinatorSessionID,
            overlapResearch.task.task_id,
            { task_type: "research" },
            { cwd: "/verification" },
        );
        const overlapRepaired = readCoordinationTask(
            coordinatorSessionID,
            overlapResearch.task.task_id,
            { cwd: "/verification" },
        );
        if (overlapRepaired.degraded) {
            throw new StateError("Case 10d: overlap repair must clear degraded.");
        }
        if (overlapRepaired.task.task_type !== "research") {
            throw new StateError("Case 10d: expected task_type restored to research.");
        }
        if (overlapRepaired.task.research_question !== "How should overlap repair behave?") {
            throw new StateError("Case 10d: research contract must survive the core-field repair.");
        }

        // 10e. Research tolerated-contract gap must NOT enter the degraded
        // branch (residual risk #3): missing-but-tolerated research contract
        // fields leave the card degraded:false, routing to research-repair.
        const toleratedResearch = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Research tolerated gap sentinel",
                task_type: "research",
                coordination_mode: "medium",
                primary_lane: "queueing",
                research_question: "Initial tolerated question?",
                source_policy: "repo_only",
                desired_artifact_type: "sources",
                target_artifact_path: "researches/sources/tolerated.md",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["Routes to research branch, not degraded."],
                validation_plan: ["degraded stays false."],
            },
            { cwd: "/verification" },
        );
        createdTaskIDs.push(toleratedResearch.task.task_id);
        degradeCard(toleratedResearch.task.task_id, (data) => {
            data.research_question = "";
        });
        const toleratedRead = readCoordinationTask(
            coordinatorSessionID,
            toleratedResearch.task.task_id,
            { cwd: "/verification" },
        );
        if (toleratedRead.degraded) {
            throw new StateError("Case 10e: research tolerated-contract gap must NOT be degraded.");
        }
        if (toleratedRead.task.task_type !== "research") {
            throw new StateError("Case 10e: tolerated research card must still read as research.");
        }
        repairCoordinationTask(
            coordinatorSessionID,
            toleratedResearch.task.task_id,
            { research_question: "Re-supplied contract question?" },
            { cwd: "/verification" },
        );
        const toleratedRepaired = readCoordinationTask(
            coordinatorSessionID,
            toleratedResearch.task.task_id,
            { cwd: "/verification" },
        );
        if (toleratedRepaired.task.research_question !== "Re-supplied contract question?") {
            throw new StateError("Case 10e: tolerated research card must route to research-repair (contract updated).");
        }

        // 10f. Bogus replacement enum rejected via strict canonical validation.
        const bogusEnumCard = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Bogus enum replacement sentinel",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "build",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["Bogus enum rejected."],
                validation_plan: ["Strict canonical validation."],
            },
            { cwd: "/verification" },
        );
        createdTaskIDs.push(bogusEnumCard.task.task_id);
        degradeCard(bogusEnumCard.task.task_id, (data) => {
            data.task_type = "";
        });
        expectStateError(
            () =>
                repairCoordinationTask(
                    coordinatorSessionID,
                    bogusEnumCard.task.task_id,
                    { task_type: "bogus-type" },
                    { cwd: "/verification" },
                ),
            "task_type must be one of",
        );

        // 10g. Status-conditional offender handling: corrupting status coerces
        // on read, expanding the offending set with status-conditional offenders
        // (rough_scope/open_questions/ready_criteria when coerced to draft).
        // Those VANISH when status is corrected, so the partial-repair check
        // scopes to repairable offenders only.
        const statusDegraded = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Degraded status-conditional sentinel",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "build",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["Status-conditional offenders vanish."],
                validation_plan: ["Repair status to ready."],
            },
            { cwd: "/verification" },
        );
        createdTaskIDs.push(statusDegraded.task.task_id);
        degradeCard(statusDegraded.task.task_id, (data) => {
            data.task_type = "";
            data.status = "bogus-status";
        });
        const statusDegradedRead = readCoordinationTask(
            coordinatorSessionID,
            statusDegraded.task.task_id,
            { cwd: "/verification" },
        );
        if (!statusDegradedRead.degraded) {
            throw new StateError("Case 10g: expected degraded after status corruption.");
        }
        if (!statusDegradedRead.diagnostics.offending_fields.includes("status")) {
            throw new StateError("Case 10g: expected status in offending fields.");
        }
        expectStateError(
            () =>
                repairCoordinationTask(
                    coordinatorSessionID,
                    statusDegraded.task.task_id,
                    { task_type: "implementation" },
                    { cwd: "/verification" },
                ),
            "still missing",
        );
        repairCoordinationTask(
            coordinatorSessionID,
            statusDegraded.task.task_id,
            { task_type: "implementation", status: "ready" },
            { cwd: "/verification" },
        );
        const statusRepairedRead = readCoordinationTask(
            coordinatorSessionID,
            statusDegraded.task.task_id,
            { cwd: "/verification" },
        );
        if (statusRepairedRead.degraded) {
            throw new StateError("Case 10g: complete repair must clear degraded despite status-conditional offenders.");
        }

        // 10h. Ordinary update unchanged: task_type still rejected by ordinary
        // update on a healthy card (carve-out is degraded-repair-only).
        expectStateError(
            () =>
                updateCoordinationTaskMetadata(
                    coordinatorSessionID,
                    healthyImpl.task.task_id,
                    { task_type: "research" },
                    { cwd: "/verification" },
                ),
            "Unsupported fields",
        );

        // 10i. Restore-only (transition-guard bypass closed): a card degraded in
        // a NON-status field (title) cannot have its healthy status moved via
        // repair — status is repairable ONLY when it is itself an offender.
        // This blocks repairCoordinationTask({title, status:"completed"}) from
        // landing a terminal lifecycle state through updateCoordinationTask,
        // which never calls coordinationTaskStatusTransitionErrors.
        const titleDegraded = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Restore-only transition guard sentinel",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "build",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["status not movable via repair."],
                validation_plan: ["Restore-only enforced."],
            },
            { cwd: "/verification" },
        );
        createdTaskIDs.push(titleDegraded.task.task_id);
        degradeCard(titleDegraded.task.task_id, (data) => {
            data.title = "";
        });
        const titleDegradedRead = readCoordinationTask(
            coordinatorSessionID,
            titleDegraded.task.task_id,
            { cwd: "/verification" },
        );
        if (!titleDegradedRead.degraded) {
            throw new StateError("Case 10i: expected degraded after clearing title.");
        }
        if (titleDegradedRead.diagnostics.offending_fields.includes("status")) {
            throw new StateError("Case 10i: status must NOT be an offender (title-only degradation).");
        }
        // Attempt to smuggle a terminal status through repair alongside the
        // title restore -> rejected (status is not an offending field).
        expectStateError(
            () =>
                repairCoordinationTask(
                    coordinatorSessionID,
                    titleDegraded.task.task_id,
                    { title: "Restored title", status: "completed" },
                    { cwd: "/verification" },
                ),
            "Unsupported fields",
        );
        // Restore-only repair (title only) succeeds and leaves status untouched.
        repairCoordinationTask(
            coordinatorSessionID,
            titleDegraded.task.task_id,
            { title: "Restored title" },
            { cwd: "/verification" },
        );
        const titleRestoredRead = readCoordinationTask(
            coordinatorSessionID,
            titleDegraded.task.task_id,
            { cwd: "/verification" },
        );
        if (titleRestoredRead.degraded) {
            throw new StateError("Case 10i: restore-only repair must clear degraded.");
        }
        if (titleRestoredRead.task.status !== "ready") {
            throw new StateError("Case 10i: status must remain 'ready' (restore-only cannot move a non-offending status).");
        }
        if (titleRestoredRead.task.title !== "Restored title") {
            throw new StateError("Case 10i: title must be restored.");
        }

        console.log("verification: ok");
        console.log(`primary_task_id: ${primary.task.task_id}`);
        console.log(`overlap_task_id: ${overlap.task.task_id}`);
        console.log(`draft_task_id: ${draft.task.task_id}`);
        console.log(`research_source_policy: ${primary.task.source_policy}`);
        console.log(`overlap_count: ${overlap.overlaps.length}`);
        console.log(`latest_report_path: ${closeout.report.path}`);
        console.log(`latest_review_path: ${reviewed.review.path}`);
        console.log(`review_status: ${reviewed.task.status}`);
        console.log(
            `quarantine_degraded_count: ${quarantineList.degraded_count}`,
        );
        console.log(
            `quarantine_healthy_total: ${quarantineList.healthy_total}`,
        );
    } finally {
        cleanupArtifacts(createdTaskIDs);
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
