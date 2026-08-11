import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
    StateError,
    activateCoordinationTask,
    bindSessionName,
    computeTaskDesignDigest,
    deleteCoordinationTask,
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

// Validate an untrusted --prefix (argv) before it flows into isolatedRoot, which
// removeIfExists() deletes recursively at startup and in finally. Without this,
// `--prefix ../../.local/coordinator` would resolve isolatedRoot to the
// REAL registry and the startup removal would delete it (path traversal). A
// valid prefix is a single path segment (no separators, no `.`/`..`, no NUL),
// and the resolved isolatedRoot MUST stay contained under tmp/verify-isolated/.
function validateIsolatedRoot(prefix, baseRoot) {
    if (!prefix || prefix.trim() === "") {
        throw new StateError(
            "Invalid --prefix: must be a non-empty value.",
        );
    }
    if (prefix.includes("\0")) {
        throw new StateError("Invalid --prefix: NUL byte is not allowed.");
    }
    // A single path segment: no forward or back separators. Rejecting separators
    // also rejects `..` traversal in the normal case, but check `.`/`..`
    // explicitly too so a literal `--prefix ..` is refused even though it has no
    // separator.
    if (prefix.includes("/") || prefix.includes("\\")) {
        throw new StateError(
            `Invalid --prefix '${prefix}': must be a single path segment (no '/' or '\\').`,
        );
    }
    if (prefix === "." || prefix === "..") {
        throw new StateError(
            `Invalid --prefix '${prefix}': must not be '.' or '..'.`,
        );
    }
    const root = baseRoot || repoRoot();
    const canonicalParent = path.resolve(root, "tmp", "verify-isolated");
    const candidate = path.resolve(canonicalParent, prefix);
    // LEXICAL containment (independent guard): candidate must be strictly UNDER
    // the canonical parent (starts with parent + separator). This is the first
    // line of defense: even if the segment check above is weakened later, this
    // assertion independently refuses any resolved path that escapes
    // tmp/verify-isolated/.
    if (candidate !== canonicalParent && !candidate.startsWith(canonicalParent + path.sep)) {
        throw new StateError(
            `Invalid --prefix '${prefix}': resolved isolated root '${candidate}' escapes the allowed parent '${canonicalParent}'.`,
        );
    }
    if (candidate === canonicalParent) {
        throw new StateError(
            `Invalid --prefix '${prefix}': must resolve to a child of 'tmp/verify-isolated', not the parent itself.`,
        );
    }

    // PHYSICAL containment (defense-in-depth against symlink redirection).
    // path.resolve is LEXICAL — it does NOT dereference symlinks — so a
    // pre-planted symlink on the isolation path (e.g. tmp/verify-isolated ->
    // .local/coordinator, or the candidate leaf itself symlinked out)
    // passes the lexical check above, yet fs.rmSync({recursive:true}) follows
    // the OS-resolved intermediate/leaf symlink and recursively deletes through
    // it into the REAL coordinator registry. Mirror state-lib's
    // resolveRealRefusingSymlink: if a path exists and its realpath differs
    // from its lexical path, it is or traverses a symlink — refuse. This gates
    // BOTH the startup self-heal removal and the finally wholesale removal
    // (they reuse this same validated binding). A non-existent path has no
    // symlink to follow, so the lexical check above still governs it; once the
    // path exists it must be physical and contained.
    const resolveRealRefusingSymlink = (lexical) => {
        if (!fs.existsSync(lexical)) {
            return null;
        }
        let resolved;
        try {
            resolved = fs.realpathSync(lexical);
        } catch (_error) {
            throw new StateError(
                `Invalid --prefix: failed to resolve the real path of the isolated path '${lexical}'; refusing.`,
            );
        }
        if (resolved !== lexical) {
            throw new StateError(
                `Invalid --prefix: the isolated path '${lexical}' resolves to a different physical location '${resolved}' (symlink detected); refusing to use it for recursive removal.`,
            );
        }
        return resolved;
    };
    const parentReal = resolveRealRefusingSymlink(canonicalParent);
    const candidateReal = resolveRealRefusingSymlink(candidate);
    if (candidateReal !== null) {
        const effectiveParent = parentReal !== null ? parentReal : canonicalParent;
        if (candidateReal !== effectiveParent && !candidateReal.startsWith(effectiveParent + path.sep)) {
            throw new StateError(
                `Invalid --prefix '${prefix}': physical isolated root '${candidateReal}' escapes the physical parent '${effectiveParent}'.`,
            );
        }
    }
    return candidate;
}

// Mirror state-lib's localCoordinatorRoot(): when OPENCODE_LOCAL_COORDINATOR_ROOT
// is set (by the isolation setup in main()), resolve every coordinator path
// against the isolated root so fixture cards NEVER touch the real
// .local/coordinator/ registry. This MUST stay byte-for-byte consistent
// with state-lib's resolution — a divergence between the verifier's own path
// helpers (direct disk writes for syntax/degraded/malformed fixtures) and
// state-lib's storage root (saveCoordinationTask writes) is exactly the leak
// vector this slice closes. Empty/absent env falls back to the real repo root,
// preserving the default for any non-isolated invocation.
function coordinatorRoot() {
    const override = (process.env.OPENCODE_LOCAL_COORDINATOR_ROOT || "").trim();
    return override || path.join(repoRoot(), ".local", "coordinator");
}

function cleanupArtifacts(taskIDs) {
    for (const taskID of taskIDs) {
        removeIfExists(
            path.join(coordinatorRoot(), "tasks", `${taskID}.json`),
        );
        removeIfExists(
            path.join(coordinatorRoot(), "reports", taskID),
        );
    }
}

function taskCardPath(taskID) {
    return path.join(coordinatorRoot(), "tasks", `${taskID}.json`);
}

function taskReportDir(taskID) {
    return path.join(coordinatorRoot(), "reports", taskID);
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
    // PID-scoped default so two concurrent no-arg runs (e.g. a test and an
    // operator invocation) get DISTINCT isolated roots — the second run's
    // startup self-heal must not remove the first run's in-flight isolated dir.
    let prefix = `verify-task-registry-${process.pid}`;
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--prefix") {
            prefix = args[index + 1] || prefix;
            index += 1;
            continue;
        }
        throw new StateError(`Unexpected argument: ${args[index]}`);
    }

    // ------------------------------------------------------------------
    // Fixture isolation (the leak this verifier used to have).
    //
    // Before isolation, every fixture card saved here landed in the REAL
    // .local/coordinator/tasks/ registry because state-lib's
    // localCoordinatorTasksRoot() resolves to repoRoot() and the {cwd:
    // "/verification"} option is actor metadata only — it never redirected
    // storage. The finally-block cleanup removed the CURRENT run's recorded
    // IDs, but any interruption (crash, SIGKILL) before finally left fixture
    // cards orphaned in the real registry indefinitely (the root cause of the
    // historical P0-REPO-060 orphan). Redirecting ALL coordinator state to an
    // isolated temp dir means a fixture can NEVER touch the real registry —
    // not during the run, not on interruption — and cleanup is a wholesale
    // dir removal (no per-ID fragility). The isolated dir is prefix-scoped so
    // concurrent runs with different --prefix values do not collide, and
    // removeIfExists at startup self-heals any leftover from a prior
    // interrupted run. tmp/ is gitignored, so an interrupted run's leftover
    // never reaches git either.
    //
    // SECURITY: prefix is untrusted argv. It flows into isolatedRoot, which
    // removeIfExists() deletes recursively at startup AND in finally. Without
    // validation, `--prefix ../../.local/coordinator` would resolve
    // isolatedRoot to the REAL registry and the startup removal would delete
    // it before the env override is even set. validateIsolatedRoot() rejects
    // any prefix that is not a single path segment, asserts the resolved
    // isolatedRoot stays LEXICALLY contained under tmp/verify-isolated/, AND
    // refuses any symlink on the isolation path (PHYSICAL containment via
    // fs.realpathSync) so a pre-planted symlink cannot redirect the recursive
    // removal into the real registry — gating every removal against the same
    // validated binding.
    // ------------------------------------------------------------------
    const isolatedRoot = validateIsolatedRoot(prefix);
    removeIfExists(isolatedRoot);
    fs.mkdirSync(path.join(isolatedRoot, "tasks"), { recursive: true });
    fs.mkdirSync(path.join(isolatedRoot, "reports"), { recursive: true });
    process.env.OPENCODE_LOCAL_COORDINATOR_ROOT = isolatedRoot;

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

        // ------------------------------------------------------------------
        // Baseline: an empty / all-healthy registry reports NO quarantine and
        // ZERO degraded cards. Under fixture isolation this baseline is the
        // genuinely-empty isolated registry (no real defer/transport cards
        // leak in), so the assertion is robust regardless of real-registry
        // state; it guards against a regression where a healthy registry is
        // misreported as degraded, and anchors the degraded_count===
        // quarantine.length invariant at the empty-quarantine boundary.
        // ------------------------------------------------------------------
        const baselineList = listCoordinationTasks(coordinatorSessionID, {
            cwd: "/verification",
        });
        if (baselineList.quarantine.length !== 0) {
            throw new StateError(
                `Baseline: expected empty quarantine on an all-healthy registry, got ${baselineList.quarantine.length} entries: ${baselineList.quarantine.map((entry) => entry.card_id).join(", ")}.`,
            );
        }
        if (baselineList.degraded_count !== 0) {
            throw new StateError(
                `Baseline: expected degraded_count 0 on an all-healthy registry, got ${baselineList.degraded_count}.`,
            );
        }
        if (baselineList.degraded_count !== baselineList.quarantine.length) {
            throw new StateError(
                "Baseline: degraded_count must equal quarantine.length (both 0 here).",
            );
        }

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

        // ------------------------------------------------------------------
        // D1. readCoordinationTask(<corrupt id>) must propagate the
        // SyntaxError-wrapped StateError. A corrupt-id read is NOT a bulk
        // scan, so it has no quarantine safety net — it must surface the
        // underlying parse failure so a caller can distinguish a missing card
        // from a corrupt one. The error is a StateError whose message is
        // prefixed "Malformed JSON state file:" and whose cause is the
        // original SyntaxError.
        // ------------------------------------------------------------------
        let d1Threw = false;
        let d1Error = null;
        try {
            readCoordinationTask(
                coordinatorSessionID,
                syntaxCorruptID,
                { cwd: "/verification" },
            );
        } catch (error) {
            d1Threw = true;
            d1Error = error;
        }
        if (!d1Threw) {
            throw new StateError(
                "Case D1: expected readCoordinationTask to throw on a corrupt card id.",
            );
        }
        if (!(d1Error instanceof StateError)) {
            throw new StateError(
                `Case D1: expected StateError, got ${d1Error && d1Error.constructor ? d1Error.constructor.name : d1Error}.`,
            );
        }
        if (!String(d1Error.message || "").startsWith("Malformed JSON state file:")) {
            throw new StateError(
                `Case D1: expected message to start with "Malformed JSON state file:", got "${d1Error.message}".`,
            );
        }
        if (!(d1Error.cause instanceof SyntaxError)) {
            throw new StateError(
                "Case D1: expected StateError.cause to be a SyntaxError (the wrapped parse failure).",
            );
        }

        // ------------------------------------------------------------------
        // D2. A NON-SyntaxError filesystem error must THROW, not quarantine
        // (rethrow guarantee). isCoordinationCardSyntaxError returns false
        // when the cause is not a SyntaxError, so the scan rethrows instead
        // of emitting a quarantine entry. We trigger a real fs error by
        // creating a DIRECTORY at a `<id>.json` card path: readFileSync then
        // throws EISDIR (POSIX; root-proof — unlike EACCES, root cannot bypass
        // EISDIR). EACCES/ENOENT/TOCTOU follow the identical non-SyntaxError
        // path. Cleanup is inline (try/finally) so a failing assertion cannot
        // poison the rest of the suite, and the id is tracked in
        // createdTaskIDs as belt-and-suspenders.
        // ------------------------------------------------------------------
        const d2DirID = "verification-d2-fs-error-fixture-card";
        const d2DirPath = taskCardPath(d2DirID);
        createdTaskIDs.push(d2DirID);
        fs.mkdirSync(d2DirPath, { recursive: true });
        let d2Threw = false;
        let d2Error = null;
        try {
            try {
                listCoordinationTasks(coordinatorSessionID, {
                    cwd: "/verification",
                });
            } catch (error) {
                d2Threw = true;
                d2Error = error;
            }
            if (!d2Threw) {
                throw new StateError(
                    "Case D2: expected listCoordinationTasks to THROW on a non-SyntaxError fs error (directory-as-card), but it did not throw.",
                );
            }
            if (!(d2Error instanceof StateError)) {
                throw new StateError(
                    `Case D2: expected StateError (rethrow guarantee), got ${d2Error && d2Error.constructor ? d2Error.constructor.name : d2Error}.`,
                );
            }
            // The discriminator: the cause must NOT be a SyntaxError. This is
            // exactly what keeps the error out of quarantine and forces the
            // rethrow.
            if (d2Error.cause instanceof SyntaxError) {
                throw new StateError(
                    "Case D2: cause must NOT be a SyntaxError (fs errors must rethrow, not quarantine).",
                );
            }
            // Confirm it is a genuine fs error: EISDIR is the POSIX code for
            // "directory where a file was expected" (portable across the dev
            // environment; this is what the directory-as-card fixture raises).
            if (!d2Error.cause || d2Error.cause.code !== "EISDIR") {
                throw new StateError(
                    `Case D2: expected cause.code "EISDIR" (directory-as-card fs error), got ${d2Error.cause && d2Error.cause.code}.`,
                );
            }
        } finally {
            removeIfExists(d2DirPath);
        }

        // Recovery: after removing the directory, the scan works again and
        // the fixture does not linger in quarantine (it never produced a
        // quarantine entry — it threw).
        const d2Recovery = listCoordinationTasks(coordinatorSessionID, {
            cwd: "/verification",
        });
        const d2Lingering = d2Recovery.quarantine.find(
            (entry) => entry.card_id === d2DirID,
        );
        if (d2Lingering) {
            throw new StateError(
                "Case D2: directory fixture must NOT linger in quarantine after cleanup.",
            );
        }

        // ------------------------------------------------------------------
        // F1. Null-safety of listCoordinationTaskCards /
        // resolveRecurrenceDedup against task:null syntax entries. Both
        // helpers share the same `!entry.degraded && entry.task` short-circuit
        // filter (a syntax entry is degraded:true / task:null and is excluded
        // before any .map(e => e.task) projection). They are not exported, so
        // null-safety is asserted indirectly through listCoordinationTasks:
        // with the corrupt sibling on disk, tasks[] must contain ZERO
        // null/undefined slots and every returned task must carry a
        // non-empty string task_id. (resolveRecurrenceDedup's identical
        // short-circuit is covered structurally — a binary-dependent live
        // recurrence test would be fragile.)
        // ------------------------------------------------------------------
        for (const task of syntaxList.tasks) {
            if (task === null || task === undefined) {
                throw new StateError(
                    "Case F1: tasks[] must contain no null/undefined slots (syntax entry projected out).",
                );
            }
            if (typeof task.task_id !== "string" || !task.task_id.length) {
                throw new StateError(
                    "Case F1: every task in tasks[] must carry a non-empty string task_id.",
                );
            }
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

        // 10j. Non-core-only list-field degradation: a card degraded EXCLUSIVELY
        // via a list field (files_in_scope=[]) has NO repairable offender
        // (files_in_scope/success_criteria/validation_plan are outside
        // DEGRADED_CORE_REPAIRABLE_FIELD_NAMES — the degraded branch is
        // intentionally core-identity/enum-only). This pins the two documented
        // diagnostics a non-core-only-degraded card surfaces, catching
        // regressions in either the refusal path or the backstop:
        //   (10j-1) REFUSED-UP-FRONT: supplying a core field the card is NOT
        //     offending on (task_type is valid here) is rejected by the
        //     restore-only payload gate, because repairableOffenders
        //     (offenders ∩ DEGRADED_CORE_REPAIRABLE_FIELD_NAMES) is empty and
        //     every supplied key is therefore "unexpected".
        //   (10j-2) SAVE-PATH BACKSTOP: a no-op repair {} cannot be refused by
        //     the restore-only gate (nothing unexpected, no uncovered
        //     repairable offender), so it falls through to
        //     updateCoordinationTask, whose ensureCoordinationTaskCoreFields
        //     re-runs collectCoordinationTaskCoreFieldErrors and throws
        //     "files_in_scope must contain at least one path" BEFORE
        //     atomicWriteJson — the load-bearing backstop that keeps a
        //     non-core-only-degraded card from silently no-op-writing a
        //     spurious task_repaired history entry. (residual risk #1 in
        //     repairDegradedCoordinationTaskCoreFields explicitly names this
        //     save-path throw as the backstop for list-field offenders.)
        // NON-GOAL: do NOT expand DEGRADED_CORE_REPAIRABLE_FIELD_NAMES to
        // include list fields — the save-path throw is the intended backstop,
        // not a list-field repair.
        const listFieldDegraded = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Non-core-only list-field degradation sentinel",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "build",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["files_in_scope offender surfaces via save-path backstop."],
                validation_plan: ["Degrade files_in_scope only; assert both diagnostics."],
            },
            { cwd: "/verification" },
        );
        createdTaskIDs.push(listFieldDegraded.task.task_id);
        degradeCard(listFieldDegraded.task.task_id, (data) => {
            data.files_in_scope = [];
        });
        const listFieldDegradedRead = readCoordinationTask(
            coordinatorSessionID,
            listFieldDegraded.task.task_id,
            { cwd: "/verification" },
        );
        if (!listFieldDegradedRead.degraded) {
            throw new StateError("Case 10j: expected degraded card after clearing files_in_scope.");
        }
        if (!listFieldDegradedRead.diagnostics.offending_fields.includes("files_in_scope")) {
            throw new StateError("Case 10j: expected files_in_scope in offending fields.");
        }
        // The card is degraded via a NON-core field only — all 6 core
        // identity/enum fields stay valid. This is what distinguishes 10j from
        // 10a/10b/10g (core-field offenders) and is the precondition for the
        // empty repairableOffenders set that drives both diagnostics below.
        const CORE_IDENTITY_ENUM_FIELDS = [
            "title",
            "task_type",
            "coordination_mode",
            "primary_lane",
            "status",
            "report_envelope",
        ];
        for (const coreField of CORE_IDENTITY_ENUM_FIELDS) {
            if (listFieldDegradedRead.diagnostics.offending_fields.includes(coreField)) {
                throw new StateError(
                    `Case 10j: core field ${coreField} must NOT be an offender (non-core-only degradation).`,
                );
            }
        }
        // 10j-1: REFUSED-UP-FRONT. Supplying task_type (a valid core field the
        // card is NOT offending on) is rejected because repairableOffenders is
        // empty — task_type is unexpected under the restore-only payload gate.
        // This is the primary diagnostic a user hits when they try to repair
        // the wrong field on a non-core-only-degraded card.
        expectStateError(
            () =>
                repairCoordinationTask(
                    coordinatorSessionID,
                    listFieldDegraded.task.task_id,
                    { task_type: "implementation" },
                    { cwd: "/verification" },
                ),
            "Unsupported fields for degraded task repair",
        );
        // 10j-2: SAVE-PATH BACKSTOP. A no-op repair {} passes the restore-only
        // gate (no unexpected field, no uncovered repairable offender) and
        // reaches updateCoordinationTask, whose ensureCoordinationTaskCoreFields
        // re-throws the files_in_scope core-field error BEFORE atomicWriteJson.
        // This is the documented backstop for list-field offenders and MUST
        // throw rather than silently no-op-write.
        expectStateError(
            () =>
                repairCoordinationTask(
                    coordinatorSessionID,
                    listFieldDegraded.task.task_id,
                    {},
                    { cwd: "/verification" },
                ),
            "files_in_scope must contain at least one path",
        );
        // No-write proof: the card remains degraded with files_in_scope empty
        // AND no spurious task_repaired history entry was appended. A
        // regression that swallowed the save-path throw and wrote anyway would
        // leave a task_repaired entry on a still-degraded card — this is the
        // load-bearing backstop assertion.
        const listFieldAfterAttempt = readCoordinationTask(
            coordinatorSessionID,
            listFieldDegraded.task.task_id,
            { cwd: "/verification" },
        );
        if (!listFieldAfterAttempt.degraded) {
            throw new StateError("Case 10j: card must remain degraded (no repair succeeded).");
        }
        const listFieldCardRaw = JSON.parse(
            fs.readFileSync(taskCardPath(listFieldDegraded.task.task_id), "utf8"),
        );
        const spuriousRepairedEntries = (listFieldCardRaw.history || []).filter(
            (entry) => entry && entry.event === "task_repaired",
        );
        if (spuriousRepairedEntries.length !== 0) {
            throw new StateError(
                `Case 10j: save-path backstop must NOT append a task_repaired history entry (found ${spuriousRepairedEntries.length}).`,
            );
        }

        // ------------------------------------------------------------------
        // Case 10 (recovery re-scan): a degraded card repaired in place must
        // LEAVE quarantine[] on the next listCoordinationTasks scan, and
        // degraded_count must drop by exactly one. Case 10a proved repair
        // restores the single-card read; this proves the quarantine ledger
        // tracks the recovery on re-enumeration (the closed loop:
        // quarantine -> repairCoordinationTask -> re-scan).
        // ------------------------------------------------------------------
        const recoveryCard = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Quarantine recovery re-scan card",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "build",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["Card leaves quarantine after repair."],
                validation_plan: ["List before and after repair."],
            },
            { cwd: "/verification" },
        );
        createdTaskIDs.push(recoveryCard.task.task_id);

        // Snapshot the quarantine baseline for this case BEFORE degrading.
        const recoveryBeforeDegrade = listCoordinationTasks(coordinatorSessionID, {
            cwd: "/verification",
        });
        const recoveryBaselineDegraded = recoveryBeforeDegrade.degraded_count;

        // Degrade -> the card must appear in quarantine[] on re-scan and
        // degraded_count must rise by exactly one.
        degradeCard(recoveryCard.task.task_id, (data) => {
            data.task_type = "";
        });
        const recoveryAfterDegrade = listCoordinationTasks(coordinatorSessionID, {
            cwd: "/verification",
        });
        const recoveryEntryBefore = recoveryAfterDegrade.quarantine.find(
            (entry) => entry.card_id === recoveryCard.task.task_id,
        );
        if (!recoveryEntryBefore) {
            throw new StateError(
                "Case 10 (recovery): expected degraded card to appear in quarantine[] before repair.",
            );
        }
        if (recoveryAfterDegrade.degraded_count !== recoveryBaselineDegraded + 1) {
            throw new StateError(
                `Case 10 (recovery): expected degraded_count to rise by one after degrade (${recoveryBaselineDegraded} -> ${recoveryBaselineDegraded + 1}), got ${recoveryAfterDegrade.degraded_count}.`,
            );
        }

        // Repair -> the card must LEAVE quarantine[] on re-scan and
        // degraded_count must drop back to the baseline.
        repairCoordinationTask(
            coordinatorSessionID,
            recoveryCard.task.task_id,
            { task_type: "implementation" },
            { cwd: "/verification" },
        );
        const recoveryAfterRepair = listCoordinationTasks(coordinatorSessionID, {
            cwd: "/verification",
        });
        const recoveryEntryAfter = recoveryAfterRepair.quarantine.find(
            (entry) => entry.card_id === recoveryCard.task.task_id,
        );
        if (recoveryEntryAfter) {
            throw new StateError(
                "Case 10 (recovery): expected repaired card to LEAVE quarantine[] after re-scan.",
            );
        }
        if (recoveryAfterRepair.degraded_count !== recoveryBaselineDegraded) {
            throw new StateError(
                `Case 10 (recovery): expected degraded_count to drop back to baseline (${recoveryBaselineDegraded}) after repair, got ${recoveryAfterRepair.degraded_count}.`,
            );
        }

        // Case 11: deleteCoordinationTask — destructive single-card removal.
        // Exercises (11a) ordinary draft, (11b) cancelled (terminal, gate-
        // passed), (11c) degraded valid-JSON, (11d) malformed, (11e) active-
        // working refusal without force, (11f) forced active-working deletion,
        // (11g) enumeration health, (11h) single-ID safety, (11i) transport-
        // root confinement, (11j) cleanup compatibility, (11k) symlink-escape
        // refusal (physical confinement — a symlinked report target is refused
        // and the external sentinel survives), (11l) reported lifecycle-guard
        // refusal + forced override, and (11m/11o) blocked and stale-working
        // lifecycle-guard refusals proving card + report evidence survive
        // intact when a pending coordinator gate owns the card.
        //
        // `completed` is NOT in this block: it enters the landing-gated
        // retirement path (4c in deleteCoordinationTask — completed + a
        // reachable `Task-Card:` trailer → deleted; otherwise a structured
        // landing_not_confirmed refusal). That path needs a git fixture, so it
        // is covered by the dedicated hermetic suite
        // tests/scripts/task-delete-retirement.test.js rather than here.
        //
        // Every fixture id is pushed to createdTaskIDs so the finally-block
        // cleanupArtifacts runs over ids whose card + report dir were already
        // removed by deleteCoordinationTask — that is the (11j) compatibility
        // assertion (removeIfExists must be idempotent and must not affect
        // surviving siblings).
        const assertAbsent = (taskID, label) => {
            // 11g (woven through every successful deletion class): enumeration
            // must not crash, the deleted id must be absent from both tasks[]
            // and quarantine[], and the primary sibling must remain present.
            const snap = listCoordinationTasks(coordinatorSessionID, {
                cwd: "/verification",
            });
            if (snap.tasks.some((task) => task.task_id === taskID)) {
                throw new StateError(
                    `${label}: deleted id "${taskID}" must not appear in tasks[].`,
                );
            }
            if (snap.quarantine.some((entry) => entry.card_id === taskID)) {
                throw new StateError(
                    `${label}: deleted id "${taskID}" must not linger in quarantine[].`,
                );
            }
            if (!snap.tasks.some((task) => task.task_id === primary.task.task_id)) {
                throw new StateError(
                    `${label}: the unrelated primary sibling must remain present.`,
                );
            }
        };

        // 11a. Ordinary draft card + report dir + sentinel: removed cleanly,
        //      summary carries the original id/title/status.
        const deleteDraft = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Delete test draft card",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "build",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["Card is removable."],
                validation_plan: ["Read back gone."],
            },
            { cwd: "/verification" },
        );
        const deleteDraftID = deleteDraft.task.task_id;
        createdTaskIDs.push(deleteDraftID);
        fs.mkdirSync(taskReportDir(deleteDraftID), { recursive: true });
        fs.writeFileSync(
            path.join(taskReportDir(deleteDraftID), "sentinel.md"),
            "# draft report sentinel\n",
        );
        const deleteDraftResult = deleteCoordinationTask(
            coordinatorSessionID,
            deleteDraftID,
            { cwd: "/verification" },
        );
        if (!deleteDraftResult.ok || deleteDraftResult.operation !== "delete_coordination_task") {
            throw new StateError("Case 11a: expected ok delete_coordination_task result.");
        }
        if (deleteDraftResult.removed.task_id !== deleteDraftID) {
            throw new StateError("Case 11a: removed.task_id must match the fixture id.");
        }
        if (deleteDraftResult.removed.title !== "Delete test draft card") {
            throw new StateError("Case 11a: removed.title must carry the original title.");
        }
        if (deleteDraftResult.removed.status !== deleteDraft.task.status) {
            throw new StateError(
                `Case 11a: removed.status must carry the fixture's original status (got "${deleteDraftResult.removed.status}", expected "${deleteDraft.task.status}").`,
            );
        }
        if (deleteDraftResult.removed.malformed) {
            throw new StateError("Case 11a: a valid card must not be reported malformed.");
        }
        if (deleteDraftResult.removed.forced) {
            throw new StateError("Case 11a: forced must be false without the force option.");
        }
        if (!deleteDraftResult.removed.card_removed || !deleteDraftResult.removed.report_dir_removed) {
            throw new StateError("Case 11a: card and report dir must both be removed.");
        }
        if (fs.existsSync(taskCardPath(deleteDraftID))) {
            throw new StateError("Case 11a: card JSON must be gone after deletion.");
        }
        if (fs.existsSync(taskReportDir(deleteDraftID))) {
            throw new StateError("Case 11a: report dir must be gone after deletion.");
        }
        assertAbsent(deleteDraftID, "Case 11a");

        // 11b. Cancelled (terminal, gate-already-passed) card: removed without
        //      force. 'cancelled' is terminal — /task-review already ran and
        //      decided — so it is freely disposable transport cleanup, not a
        //      gate bypass.
        const deleteCancelled = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Delete test cancelled card",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "build",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["Card is removable."],
                validation_plan: ["Read back gone."],
            },
            { cwd: "/verification" },
        );
        const deleteCancelledID = deleteCancelled.task.task_id;
        createdTaskIDs.push(deleteCancelledID);
        degradeCard(deleteCancelledID, (data) => {
            data.status = "cancelled";
        });
        fs.mkdirSync(taskReportDir(deleteCancelledID), { recursive: true });
        const deleteCancelledResult = deleteCoordinationTask(
            coordinatorSessionID,
            deleteCancelledID,
            { cwd: "/verification" },
        );
        if (!deleteCancelledResult.ok) {
            throw new StateError("Case 11b: cancelled card must be removable without force.");
        }
        if (deleteCancelledResult.removed.status !== "cancelled") {
            throw new StateError("Case 11b: removed.status must carry 'cancelled'.");
        }
        if (!deleteCancelledResult.removed.card_removed || !deleteCancelledResult.removed.report_dir_removed) {
            throw new StateError("Case 11b: card and report dir must both be removed.");
        }
        if (fs.existsSync(taskCardPath(deleteCancelledID)) || fs.existsSync(taskReportDir(deleteCancelledID))) {
            throw new StateError("Case 11b: card and report dir must be gone.");
        }
        assertAbsent(deleteCancelledID, "Case 11b");

        // 11c. Degraded valid-JSON card (missing core fields): no strict
        //      validation blocks the retire; summary uses honest fallback
        //      values (null title, "degraded" status, not malformed).
        const degradedID = "delete-test-degraded-card";
        const degradedCardFile = taskCardPath(degradedID);
        createdTaskIDs.push(degradedID);
        fs.mkdirSync(path.dirname(degradedCardFile), { recursive: true });
        fs.writeFileSync(
            degradedCardFile,
            JSON.stringify({ note: "no core fields here" }, null, 2),
        );
        fs.mkdirSync(taskReportDir(degradedID), { recursive: true });
        const degradedResult = deleteCoordinationTask(
            coordinatorSessionID,
            degradedID,
            { cwd: "/verification" },
        );
        if (!degradedResult.ok) {
            throw new StateError(
                "Case 11c: degraded card must be removable without strict validation blocking.",
            );
        }
        if (degradedResult.removed.malformed) {
            throw new StateError("Case 11c: valid-JSON card must not be reported malformed.");
        }
        if (degradedResult.removed.title !== null) {
            throw new StateError("Case 11c: missing title must surface as null, not fabricated.");
        }
        if (degradedResult.removed.status !== "degraded") {
            throw new StateError("Case 11c: missing status must surface as 'degraded'.");
        }
        if (!degradedResult.removed.card_removed || !degradedResult.removed.report_dir_removed) {
            throw new StateError("Case 11c: card and report dir must both be removed.");
        }
        if (fs.existsSync(degradedCardFile) || fs.existsSync(taskReportDir(degradedID))) {
            throw new StateError("Case 11c: card and report dir must be gone.");
        }
        assertAbsent(degradedID, "Case 11c");

        // 11d. Malformed (syntactically invalid JSON) card: both card + report
        //      dir removed; result reports malformed: true; title null;
        //      status "degraded".
        const malformedID = "delete-test-malformed-card";
        const malformedCardFile = taskCardPath(malformedID);
        createdTaskIDs.push(malformedID);
        fs.mkdirSync(path.dirname(malformedCardFile), { recursive: true });
        fs.writeFileSync(malformedCardFile, "{ not valid json ,,, ");
        fs.mkdirSync(taskReportDir(malformedID), { recursive: true });
        const malformedResult = deleteCoordinationTask(
            coordinatorSessionID,
            malformedID,
            { cwd: "/verification" },
        );
        if (!malformedResult.ok) {
            throw new StateError("Case 11d: malformed card must be removable.");
        }
        if (!malformedResult.removed.malformed) {
            throw new StateError("Case 11d: unparseable card must be reported malformed.");
        }
        if (malformedResult.removed.title !== null) {
            throw new StateError("Case 11d: malformed card title must surface as null.");
        }
        if (malformedResult.removed.status !== "degraded") {
            throw new StateError("Case 11d: malformed card status must surface as 'degraded'.");
        }
        if (!malformedResult.removed.card_removed || !malformedResult.removed.report_dir_removed) {
            throw new StateError("Case 11d: card and report dir must both be removed.");
        }
        if (fs.existsSync(malformedCardFile) || fs.existsSync(taskReportDir(malformedID))) {
            throw new StateError("Case 11d: card and report dir must be gone.");
        }
        assertAbsent(malformedID, "Case 11d");

        // 11e. Active working refusal: status:working + non-empty
        //      active_session_alias, called WITHOUT force → structured
        //      active_working_task refusal; card + report dir unchanged.
        const deleteWorking = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Delete test working card",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "build",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["Card is guarded."],
                validation_plan: ["Read back unchanged on refusal."],
            },
            { cwd: "/verification" },
        );
        const workingID = deleteWorking.task.task_id;
        createdTaskIDs.push(workingID);
        degradeCard(workingID, (data) => {
            data.status = "working";
            data.active_session_alias = `${prefix}-subagent`;
        });
        fs.mkdirSync(taskReportDir(workingID), { recursive: true });
        const workingRefusal = deleteCoordinationTask(
            coordinatorSessionID,
            workingID,
            { cwd: "/verification" },
        );
        if (workingRefusal.ok) {
            throw new StateError(
                "Case 11e: actively-owned working card must be refused without force.",
            );
        }
        if (workingRefusal.operation !== "delete_coordination_task") {
            throw new StateError("Case 11e: refusal must carry the operation name.");
        }
        if (!workingRefusal.refusal || workingRefusal.refusal.code !== "active_working_task") {
            throw new StateError("Case 11e: refusal must carry code active_working_task.");
        }
        if (workingRefusal.refusal.task_id !== workingID) {
            throw new StateError("Case 11e: refusal must carry the task id.");
        }
        if (workingRefusal.refusal.status !== "working") {
            throw new StateError("Case 11e: refusal must report status 'working'.");
        }
        if (workingRefusal.refusal.active_session_alias !== `${prefix}-subagent`) {
            throw new StateError("Case 11e: refusal must report the active owner alias.");
        }
        if (!workingRefusal.refusal.force_required) {
            throw new StateError("Case 11e: refusal must indicate force is required.");
        }
        if (!fs.existsSync(taskCardPath(workingID))) {
            throw new StateError("Case 11e: card must NOT be removed on refusal.");
        }
        if (!fs.existsSync(taskReportDir(workingID))) {
            throw new StateError("Case 11e: report dir must NOT be removed on refusal.");
        }

        // 11f. Forced active working deletion: same fixture with {force:true}
        //      → card + report dir removed; forced:true; original status
        //      "working" carried in the summary.
        const workingForcedResult = deleteCoordinationTask(
            coordinatorSessionID,
            workingID,
            { cwd: "/verification", force: true },
        );
        if (!workingForcedResult.ok) {
            throw new StateError(
                "Case 11f: forced deletion of an active working card must succeed.",
            );
        }
        if (!workingForcedResult.removed.forced) {
            throw new StateError("Case 11f: removed.forced must be true when force was supplied.");
        }
        if (workingForcedResult.removed.status !== "working") {
            throw new StateError("Case 11f: removed.status must carry the original 'working'.");
        }
        if (!workingForcedResult.removed.card_removed || !workingForcedResult.removed.report_dir_removed) {
            throw new StateError("Case 11f: card and report dir must both be removed.");
        }
        if (fs.existsSync(taskCardPath(workingID)) || fs.existsSync(taskReportDir(workingID))) {
            throw new StateError("Case 11f: card and report dir must be gone after forced deletion.");
        }
        assertAbsent(workingID, "Case 11f");

        // 11g consolidated re-check: every deleted id absent, primary present.
        const consolidated = listCoordinationTasks(coordinatorSessionID, {
            cwd: "/verification",
        });
        const consolidatedIDs = consolidated.tasks.map((task) => task.task_id);
        for (const goneID of [deleteDraftID, deleteCancelledID, degradedID, malformedID, workingID]) {
            if (consolidatedIDs.includes(goneID)) {
                throw new StateError(
                    `Case 11g: deleted id "${goneID}" must not appear in the consolidated list.`,
                );
            }
        }
        if (!consolidatedIDs.includes(primary.task.task_id)) {
            throw new StateError("Case 11g: the primary sibling must remain present.");
        }

        // 11h. Single-ID safety: wildcards, path-like input, comma-lists,
        //      whitespace-separated tokens, and multiple-id (array / empty)
        //      input are refused BEFORE any filesystem mutation. A real fixture
        //      card is created first so we can prove it survives every invalid
        //      attempt unchanged.
        const safetyFixture = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Delete test safety card",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "build",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["Card survives invalid attempts."],
                validation_plan: ["Read back present."],
            },
            { cwd: "/verification" },
        );
        const safetyID = safetyFixture.task.task_id;
        createdTaskIDs.push(safetyID);
        const safetyCardBefore = fs.readFileSync(taskCardPath(safetyID), "utf8");
        const invalidInputs = [
            "*",
            "?",
            "*.json",
            "[a-z]",
            "a,b",
            "../escape",
            "foo/bar",
            "foo\\bar",
            "..",
            "alpha beta",
            "a\tb",
        ];
        for (const invalid of invalidInputs) {
            expectStateError(
                () => deleteCoordinationTask(coordinatorSessionID, invalid, { cwd: "/verification" }),
                "delete_coordination_task",
            );
        }
        expectStateError(
            () => deleteCoordinationTask(coordinatorSessionID, ["array"], { cwd: "/verification" }),
            "delete_coordination_task",
        );
        expectStateError(
            () => deleteCoordinationTask(coordinatorSessionID, "   ", { cwd: "/verification" }),
            "delete_coordination_task",
        );
        const safetyCardAfter = fs.readFileSync(taskCardPath(safetyID), "utf8");
        if (safetyCardAfter !== safetyCardBefore) {
            throw new StateError(
                "Case 11h: fixture card must be unchanged after invalid-input refusals.",
            );
        }

        // 11h (cont). Whitespace-collision survival: the exact scenario the
        //      whitespace guard exists to prevent. slugify collapses
        //      "alpha beta" -> "alpha-beta", so WITHOUT the guard the input
        //      "alpha beta" would be silently normalized to "alpha-beta" and,
        //      if such a card existed, deleted. Plant a real draft card at the
        //      collision id, then prove the whitespace input is REJECTED and
        //      the collision card survives byte-identical.
        const collisionID = "alpha-beta";
        const collisionCard = {
            id: collisionID,
            title: "whitespace collision sibling",
            task_type: "implementation",
            coordination_mode: "short",
            status: "draft",
        };
        fs.writeFileSync(
            taskCardPath(collisionID),
            JSON.stringify(collisionCard, null, 2),
        );
        createdTaskIDs.push(collisionID);
        const collisionBefore = fs.readFileSync(taskCardPath(collisionID), "utf8");
        expectStateError(
            () => deleteCoordinationTask(coordinatorSessionID, "alpha beta", { cwd: "/verification" }),
            "delete_coordination_task",
        );
        expectStateError(
            () => deleteCoordinationTask(coordinatorSessionID, "alpha\tbeta", { cwd: "/verification" }),
            "delete_coordination_task",
        );
        if (!fs.existsSync(taskCardPath(collisionID))) {
            throw new StateError(
                "Case 11h: whitespace input 'alpha beta' silently normalized to 'alpha-beta' and deleted the collision card.",
            );
        }
        const collisionAfter = fs.readFileSync(taskCardPath(collisionID), "utf8");
        if (collisionAfter !== collisionBefore) {
            throw new StateError(
                "Case 11h: collision card must be byte-identical after whitespace-input refusals.",
            );
        }

        // 11i. Transport-root confinement: sentinels in an unrelated local
        //      sibling dir and a committed tracked file are recorded before
        //      deletion and must be unchanged after; only the exact card +
        //      report targets move.
        const confinementFixture = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Delete test confinement card",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "build",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["Confinement holds."],
                validation_plan: ["Read back unchanged siblings."],
            },
            { cwd: "/verification" },
        );
        const confinementID = confinementFixture.task.task_id;
        createdTaskIDs.push(confinementID);
        const siblingDir = path.join(
            coordinatorRoot(),
            "dashboards",
        );
        fs.mkdirSync(siblingDir, { recursive: true });
        const siblingSentinel = path.join(siblingDir, "delete-test-sentinel.md");
        fs.writeFileSync(siblingSentinel, "# sibling sentinel — must survive\n");
        const siblingBefore = fs.readFileSync(siblingSentinel, "utf8");
        const committedFile = path.join(repoRoot(), "Makefile");
        const committedBefore = fs.readFileSync(committedFile, "utf8");
        fs.mkdirSync(taskReportDir(confinementID), { recursive: true });
        const confinementResult = deleteCoordinationTask(
            coordinatorSessionID,
            confinementID,
            { cwd: "/verification" },
        );
        if (!confinementResult.ok) {
            throw new StateError("Case 11i: confinement fixture must be removable.");
        }
        if (fs.existsSync(taskCardPath(confinementID)) || fs.existsSync(taskReportDir(confinementID))) {
            throw new StateError("Case 11i: exact card + report targets must be gone.");
        }
        if (fs.readFileSync(siblingSentinel, "utf8") !== siblingBefore) {
            throw new StateError(
                "Case 11i: unrelated local sibling sentinel must be unchanged.",
            );
        }
        if (fs.readFileSync(committedFile, "utf8") !== committedBefore) {
            throw new StateError("Case 11i: committed tracked file must be unchanged.");
        }
        // Clean up the sibling sentinel we created (it is not a task card).
        removeIfExists(siblingSentinel);

        // 11j. Cleanup compatibility: the finally-block cleanupArtifacts runs
        //      over createdTaskIDs and must be safe (idempotent) for ids
        //      whose card + report dir were already removed earlier in this
        //      run. Calling it here explicitly over the already-removed ids
        //      must not throw and must not disturb surviving tasks.
        const survivingBefore = listCoordinationTasks(coordinatorSessionID, {
            cwd: "/verification",
        }).tasks.length;
        cleanupArtifacts([
            deleteDraftID,
            deleteCancelledID,
            degradedID,
            malformedID,
            workingID,
            confinementID,
        ]);
        const survivingAfter = listCoordinationTasks(coordinatorSessionID, {
            cwd: "/verification",
        }).tasks.length;
        if (survivingAfter !== survivingBefore) {
            throw new StateError(
                "Case 11j: cleanup over already-removed ids must not affect surviving tasks.",
            );
        }

        // 11k. Symlink-escape refusal (physical confinement): a symlinked
        //      DELETION TARGET (this card's report dir repointed at an
        //      external sentinel) MUST be refused before any filesystem
        //      mutation. This is the boundary a purely lexical path.resolve +
        //      startsWith check would miss — rmSync would follow the symlink
        //      and delete the sentinel subtree. Prove the op refuses, the card
        //      survives byte-identical, and the sentinel + its marker are
        //      untouched.
        const symlinkFixture = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Delete test symlink-escape card",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "build",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["Symlink escape refused."],
                validation_plan: ["Sentinel untouched."],
            },
            { cwd: "/verification" },
        );
        const symlinkID = symlinkFixture.task.task_id;
        createdTaskIDs.push(symlinkID);
        // External sentinel OUTSIDE the reports root but inside the
        // gitignored transport tree (under dashboards/), with a marker file
        // whose contents we will prove survive.
        const escapeSentinelDir = path.join(
            coordinatorRoot(),
            "dashboards",
            "delete-symlink-sentinel",
        );
        removeIfExists(escapeSentinelDir);
        fs.mkdirSync(escapeSentinelDir, { recursive: true });
        const escapeMarker = path.join(escapeSentinelDir, "marker.txt");
        const escapeMarkerContent =
            "# escape sentinel — MUST survive a delete op\n";
        fs.writeFileSync(escapeMarker, escapeMarkerContent);
        // Replace THIS card's own report dir with a symlink at the sentinel.
        // (We touch only this fixture's report dir, never the shared reports
        // root, so other fixtures stay intact.)
        const symlinkReportDir = taskReportDir(symlinkID);
        removeIfExists(symlinkReportDir);
        fs.symlinkSync(escapeSentinelDir, symlinkReportDir);
        const cardByteBefore = fs.readFileSync(
            taskCardPath(symlinkID),
            "utf8",
        );
        // The op must refuse because the report candidate is now a symlink
        // (realpath differs from its lexical path).
        expectStateError(
            () =>
                deleteCoordinationTask(coordinatorSessionID, symlinkID, {
                    cwd: "/verification",
                }),
            "delete_coordination_task",
        );
        if (!fs.existsSync(taskCardPath(symlinkID))) {
            throw new StateError(
                "Case 11k: card must survive a symlink-escape refusal.",
            );
        }
        if (
            fs.readFileSync(taskCardPath(symlinkID), "utf8") !== cardByteBefore
        ) {
            throw new StateError(
                "Case 11k: card must be byte-identical after a symlink-escape refusal.",
            );
        }
        if (
            !fs.existsSync(escapeSentinelDir) ||
            !fs.existsSync(escapeMarker)
        ) {
            throw new StateError(
                "Case 11k: external sentinel must survive a symlink-escape refusal.",
            );
        }
        if (fs.readFileSync(escapeMarker, "utf8") !== escapeMarkerContent) {
            throw new StateError(
                "Case 11k: external sentinel contents must be unchanged.",
            );
        }
        // Cleanup the symlink we planted and the sentinel so neither leaks.
        removeIfExists(symlinkReportDir);
        removeIfExists(escapeSentinelDir);

        // 11l. Reported card (pending /task-review): lifecycle_state_protected
        //      refusal without force — the report dir carries the closeout
        //      evidence a coordinator review needs; destroying it would bypass
        //      the review gate. Card + report dir + sentinel must survive
        //      intact. An explicit force then removes both.
        const reportedFixture = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Delete test reported card",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "build",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["Reported card is guarded."],
                validation_plan: ["Read back intact on refusal."],
            },
            { cwd: "/verification" },
        );
        const reportedID = reportedFixture.task.task_id;
        createdTaskIDs.push(reportedID);
        degradeCard(reportedID, (data) => {
            data.status = "reported";
            data.active_session_alias = null;
        });
        const reportedReportDir = taskReportDir(reportedID);
        fs.mkdirSync(reportedReportDir, { recursive: true });
        const reportedMarker = path.join(reportedReportDir, "closeout.md");
        const reportedMarkerContent = "# reported closeout — review evidence\n";
        fs.writeFileSync(reportedMarker, reportedMarkerContent);
        const reportedCardBefore = fs.readFileSync(
            taskCardPath(reportedID),
            "utf8",
        );
        const reportedRefusal = deleteCoordinationTask(
            coordinatorSessionID,
            reportedID,
            { cwd: "/verification" },
        );
        if (reportedRefusal.ok) {
            throw new StateError(
                "Case 11l: reported card must be refused without force.",
            );
        }
        if (
            !reportedRefusal.refusal ||
            reportedRefusal.refusal.code !== "lifecycle_state_protected"
        ) {
            throw new StateError(
                "Case 11l: refusal must carry code lifecycle_state_protected.",
            );
        }
        if (reportedRefusal.refusal.status !== "reported") {
            throw new StateError(
                "Case 11l: refusal must report status 'reported'.",
            );
        }
        if (!reportedRefusal.refusal.force_required) {
            throw new StateError(
                "Case 11l: refusal must indicate force is required.",
            );
        }
        if (!fs.existsSync(taskCardPath(reportedID))) {
            throw new StateError(
                "Case 11l: card must survive a lifecycle refusal.",
            );
        }
        if (
            fs.readFileSync(taskCardPath(reportedID), "utf8") !==
            reportedCardBefore
        ) {
            throw new StateError(
                "Case 11l: card must be byte-identical after a lifecycle refusal.",
            );
        }
        if (
            !fs.existsSync(reportedMarker) ||
            fs.readFileSync(reportedMarker, "utf8") !== reportedMarkerContent
        ) {
            throw new StateError(
                "Case 11l: report evidence must survive a lifecycle refusal.",
            );
        }
        // Explicit force overrides the pending-gate guard and removes both.
        const reportedForced = deleteCoordinationTask(
            coordinatorSessionID,
            reportedID,
            { cwd: "/verification", force: true },
        );
        if (!reportedForced.ok || !reportedForced.removed.forced) {
            throw new StateError(
                "Case 11l: forced deletion of a reported card must succeed with forced:true.",
            );
        }
        if (
            fs.existsSync(taskCardPath(reportedID)) ||
            fs.existsSync(reportedReportDir)
        ) {
            throw new StateError(
                "Case 11l: card + report dir must be gone after forced deletion.",
            );
        }
        assertAbsent(reportedID, "Case 11l");

        // 11m/11o. Blocked and stale-working (no active owner) cards: each is
        //      protected by the in-flight lifecycle guard (4b). A blocked card
        //      awaits a coordinator decision; a stale working card (no active
        //      owner) may carry in-progress artifacts. `completed` is NOT in
        //      this set — it enters the landing-gated retirement path (4c:
        //      verifyLandingProof — completed + reachable Task-Card trailer →
        //      deleted; otherwise landing_not_confirmed), covered by the
        //      dedicated hermetic suite
        //      tests/scripts/task-delete-retirement.test.js. Each refusal here
        //      must leave the card + report dir + sentinel byte-identical and
        //      intact.
        const lifecycleStatusFixtures = [
            { label: "11m", status: "blocked", title: "Delete test blocked card" },
            { label: "11o", status: "working", title: "Delete test stale-working card" },
        ];
        for (const spec of lifecycleStatusFixtures) {
            const fixture = saveCoordinationTask(
                coordinatorSessionID,
                {
                    title: spec.title,
                    task_type: "implementation",
                    coordination_mode: "short",
                    primary_lane: "build",
                    files_in_scope: ["tests/fixtures/example-pkg/"],
                    success_criteria: ["Lifecycle guard holds."],
                    validation_plan: ["Read back intact on refusal."],
                },
                { cwd: "/verification" },
            );
            const lifecycleID = fixture.task.task_id;
            createdTaskIDs.push(lifecycleID);
            degradeCard(lifecycleID, (data) => {
                data.status = spec.status;
                data.active_session_alias = null;
            });
            const lifecycleReportDir = taskReportDir(lifecycleID);
            fs.mkdirSync(lifecycleReportDir, { recursive: true });
            const lifecycleMarker = path.join(
                lifecycleReportDir,
                "closeout.md",
            );
            const lifecycleMarkerContent = `# ${spec.status} evidence — must survive\n`;
            fs.writeFileSync(lifecycleMarker, lifecycleMarkerContent);
            const lifecycleCardBefore = fs.readFileSync(
                taskCardPath(lifecycleID),
                "utf8",
            );
            const lifecycleRefusal = deleteCoordinationTask(
                coordinatorSessionID,
                lifecycleID,
                { cwd: "/verification" },
            );
            if (lifecycleRefusal.ok) {
                throw new StateError(
                    `Case ${spec.label}: ${spec.status} card must be refused without force.`,
                );
            }
            if (
                !lifecycleRefusal.refusal ||
                lifecycleRefusal.refusal.code !== "lifecycle_state_protected"
            ) {
                throw new StateError(
                    `Case ${spec.label}: refusal must carry code lifecycle_state_protected.`,
                );
            }
            if (lifecycleRefusal.refusal.status !== spec.status) {
                throw new StateError(
                    `Case ${spec.label}: refusal must report status '${spec.status}'.`,
                );
            }
            if (!lifecycleRefusal.refusal.force_required) {
                throw new StateError(
                    `Case ${spec.label}: refusal must indicate force is required.`,
                );
            }
            if (!fs.existsSync(taskCardPath(lifecycleID))) {
                throw new StateError(
                    `Case ${spec.label}: card must survive a lifecycle refusal.`,
                );
            }
            if (
                fs.readFileSync(taskCardPath(lifecycleID), "utf8") !==
                lifecycleCardBefore
            ) {
                throw new StateError(
                    `Case ${spec.label}: card must be byte-identical after a lifecycle refusal.`,
                );
            }
            if (
                !fs.existsSync(lifecycleMarker) ||
                fs.readFileSync(lifecycleMarker, "utf8") !==
                    lifecycleMarkerContent
            ) {
                throw new StateError(
                    `Case ${spec.label}: report evidence must survive a lifecycle refusal.`,
                );
            }
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
        // Wholesale removal of the isolated coordinator root: this is the
        // leak-proof guarantee. Even if cleanupArtifacts missed an id (an
        // interrupted earlier branch, a directly-written fixture, or a future
        // edit that forgets to track a new fixture), the entire isolated tree
        // is removed here, so nothing can reach the real registry. Paired with
        // the per-id cleanup above for clarity and the 11j idempotency path.
        removeIfExists(isolatedRoot);
        delete process.env.OPENCODE_LOCAL_COORDINATOR_ROOT;
    }
}

// Exposed for adversarial unit testing of the path-traversal / symlink
// containment guard (validateIsolatedRoot accepts an optional baseRoot so a test
// can drive it against a throwaway temp tree without touching the real repo).
export { validateIsolatedRoot };

// Only invoke main() when this file is the entry point (node .../verify-task-registry.js),
// not when it is imported (e.g. by the isolation regression tests importing
// validateIsolatedRoot). ESM has no require.main === module, so compare the
// resolved entry path against this module's own URL.
const __entryPath =
    process.argv[1] !== undefined ? path.resolve(process.argv[1]) : "";
const __modulePath = fileURLToPath(import.meta.url);
if (__entryPath === __modulePath) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
