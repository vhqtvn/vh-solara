import fs from "fs";
import path from "path";
import {
    StateError,
    activateCoordinationTask,
    bindSessionName,
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

        const readied = readyCoordinationTask(
            coordinatorSessionID,
            draft.task.task_id,
            {
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
            },
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

        console.log("verification: ok");
        console.log(`primary_task_id: ${primary.task.task_id}`);
        console.log(`overlap_task_id: ${overlap.task.task_id}`);
        console.log(`draft_task_id: ${draft.task.task_id}`);
        console.log(`research_source_policy: ${primary.task.source_policy}`);
        console.log(`overlap_count: ${overlap.overlaps.length}`);
        console.log(`latest_report_path: ${closeout.report.path}`);
        console.log(`latest_review_path: ${reviewed.review.path}`);
        console.log(`review_status: ${reviewed.task.status}`);
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
