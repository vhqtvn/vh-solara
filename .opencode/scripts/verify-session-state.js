import fs from "fs";
import path from "path";
import {
    StateError,
    adoptPlan,
    approveDraft,
    appendWorkstreamNote,
    appendDecision,
    buildCompactionContext,
    clearWorkstream,
    cleanupArtifacts,
    ensureSessionBinding,
    getCurrentSessionContext,
    getSessionMemoryOverview,
    getWorkstreamOverview,
    initSessionMemory,
    initWorkstreamMemory,
    listPlans,
    readTaskContract,
    readCheckpoint,
    recordArtifact,
    recordArtifacts,
    resolvePaths,
    repoRoot,
    resolvePlan,
    saveHandoff,
    saveCheckpoint,
    saveTaskContract,
    writeWorkstreamFile,
    bindSessionName,
    saveDraft,
} from "./state-lib.js";

function runForSession(sessionID, sessionName, slug, body) {
    ensureSessionBinding(sessionID, { cwd: "/verification" });
    bindSessionName(sessionID, sessionName, { cwd: "/verification" });
    const draft = saveDraft(sessionID, slug, body, "");
    const saved = approveDraft(sessionID, slug, { cwd: "/verification" });
    const taskContract = saveTaskContract(
        sessionID,
        [
            "# Task Contract",
            "",
            "## Mission",
            "",
            `Verify persisted task contracts for ${sessionName}.`,
            "",
            "## User Requirements",
            "",
            "Preserve the original request across compaction and checkpoint reopen.",
            "",
            "## Must Read",
            "",
            "- docs/planning/backlog.md",
            "- docs/ai/opencode-session-workflow.md",
            "",
            "## Must Do",
            "",
            "- Save the contract before checkpoints.",
            "- Reopen the contract during recovery.",
            "",
            "## Required Outputs",
            "",
            `- docs/checkpoints/${sessionName}-checkpoint.md`,
            "",
            "## Final Response Format",
            "",
            "Return:",
            "1. changed files",
            "2. verification run",
            "3. open risks",
            "4. artifacts cleaned",
            "5. preserved outputs",
            "6. recommended next prompt",
            "",
            "## Required Commands",
            "",
            "- /session-start",
            "- /checkpoint-save",
            "",
            "## Completion Checklist",
            "",
            "- Contract persisted",
            "- Contract visible in compaction",
            "",
        ].join("\n"),
        { cwd: "/verification" },
    );
    const workstream = initWorkstreamMemory(
        sessionID,
        `${sessionName}-initiative`,
        {
            briefBody: [
                `Cross-session investigation for ${sessionName}.`,
                "",
                "- Scope: keep stable learning separate from task execution state.",
                "- Use this workstream only for durable theme-level context.",
            ].join("\n"),
            nextSliceBody:
                "- Wire workstream context into compaction.\n- Reopen this theme in a later session.",
            openQuestionsBody:
                "- Which session should own the next migration slice?",
            rejectedOptionsBody:
                "- Do not turn the workstream into baseline always-loaded instructions.",
            linksBody:
                "- docs/ai/opencode-session-workflow.md\n- .opencode/README-session-state.md",
            cwd: "/verification",
        },
    );
    writeWorkstreamFile(
        sessionID,
        "next_slice",
        "- Verify child-session inheritance.\n- Keep the workstream summary concise.",
        "",
        { cwd: "/verification" },
    );
    initSessionMemory(sessionID, {
        briefBody: `Goal: verify session memory for ${sessionName}.`,
        resolvedContextBody: "- exact: docs/planning/backlog.md",
        openQuestionsBody: "- (none)",
        cwd: "/verification",
    });
    appendDecision(
        sessionID,
        "Session memory initialization is active and should survive compaction.",
        "Verification bootstrap",
        { cwd: "/verification" },
    );
    const checkpoint = saveCheckpoint(
        sessionID,
        "kickoff",
        "1. Bound the session alias.\n2. Initialized memory.\n3. Saved the kickoff checkpoint.",
        "Kickoff",
        {
            cwd: "/verification",
            goal: `Verify ${sessionName}`,
            nextStep: "Record and clean a temp artifact.",
        },
    );
    const handoff = saveHandoff(
        sessionID,
        "follow-up",
        "Goal: resume from the saved checkpoint without re-reading the full conversation.",
        "Follow-up Handoff",
        {
            cwd: "/verification",
            targetAgent: "repo-explorer",
            nextStep: "Open the latest checkpoint and inspect the tracked artifact state.",
        },
    );
    const artifactPath = path.join(
        repoRoot(),
        "tmp",
        "agent-runs",
        sessionName,
        "scratch",
        `${slug}.txt`,
    );
    fs.writeFileSync(artifactPath, "verification artifact\n", "utf8");
    recordArtifact(sessionID, artifactPath, {
        kind: "verification_artifact",
        retention: "delete_on_success",
        notes: "Created by verify-session-state.js",
        cwd: "/verification",
    });
    return {
        session_id: sessionID,
        session_name: sessionName,
        draft_path: draft.path,
        plan_id: saved.plan.id,
        contract_version: taskContract.version,
        checkpoint_id: checkpoint.id,
        handoff_path: handoff.path,
        artifact_path: artifactPath,
        workstream_name: workstream.active_workstream,
        workstream_dir: workstream.workstream_dir,
    };
}

function main() {
    try {
        const args = process.argv.slice(2);
        let prefix = "verify-opencode";

        for (let index = 0; index < args.length; index += 1) {
            if (args[index] === "--prefix") {
                prefix = args[index + 1] || prefix;
                index += 1;
            } else {
                throw new StateError(`Unexpected argument: ${args[index]}`);
            }
        }

        const alpha = runForSession(
            `${prefix}-session-alpha`,
            `${prefix}-alias-a`,
            "manifest-fix",
            "1. Update manifests.\n2. Verify routing.",
        );
        const beta = runForSession(
            `${prefix}-session-beta`,
            `${prefix}-alias-b`,
            "subagent-cleanup",
            "1. Clean subagent paths.\n2. Verify retries.",
        );

        const adopted = adoptPlan(alpha.session_id, alpha.plan_id);
        const resolvedAlpha = resolvePlan(alpha.session_id, "");
        const resolvedBeta = resolvePlan(beta.session_id, "");
        const betaList = listPlans(beta.session_id);
        const alphaContract = readTaskContract(alpha.session_id, {
            cwd: "/verification",
        });
        const alphaCheckpoint = readCheckpoint(alpha.session_id, "", {
            cwd: "/verification",
        });
        const alphaWorkstreamReopen = initWorkstreamMemory(
            alpha.session_id,
            alpha.workstream_name,
            {
                briefBody: "This replacement should be preserved instead of applied.",
                nextSliceBody:
                    "- This replacement should not clobber the saved next slice.",
                openQuestionsBody:
                    "- This replacement should not clobber the saved open question.",
                cwd: "/verification",
            },
        );
        appendWorkstreamNote(
            alpha.session_id,
            "open_questions",
            "- Which package should own the next migration slice?",
            "",
            {
                cwd: "/verification",
                title: "Follow-up",
            },
        );
        const alphaMemory = getSessionMemoryOverview(alpha.session_id, {
            cwd: "/verification",
        });
        const alphaWorkstream = getWorkstreamOverview(alpha.session_id, "", {
            cwd: "/verification",
        });
        const alphaChildSessionID = `${prefix}-session-alpha-child`;
        ensureSessionBinding(alphaChildSessionID, {
            cwd: "/verification",
            parentSessionID: alpha.session_id,
        });
        const alphaChildContext = getCurrentSessionContext(alphaChildSessionID, {
            cwd: "/verification",
            parentSessionID: alpha.session_id,
        });
        const alphaWorkstreamAfterChild = getWorkstreamOverview(
            alpha.session_id,
            alpha.workstream_name,
            {
                cwd: "/verification",
            },
        );
        const betaWorkstreamReset = initWorkstreamMemory(
            beta.session_id,
            beta.workstream_name,
            {
                briefBody: "Reset beta brief intentionally.",
                replaceExisting: true,
                cwd: "/verification",
            },
        );
        const betaWorkstreamAfterReset = getWorkstreamOverview(
            beta.session_id,
            "",
            {
                cwd: "/verification",
            },
        );
        const emptySessionID = `${prefix}-session-empty`;
        const emptySessionName = `${prefix}-alias-empty`;
        ensureSessionBinding(emptySessionID, { cwd: "/verification" });
        bindSessionName(emptySessionID, emptySessionName, {
            cwd: "/verification",
        });
        initWorkstreamMemory(emptySessionID, `${emptySessionName}-empty-theme`, {
            cwd: "/verification",
        });
        const legacySessionID = `${prefix}-session-legacy`;
        const legacySessionName = `${prefix}-alias-legacy`;
        ensureSessionBinding(legacySessionID, { cwd: "/verification" });
        bindSessionName(legacySessionID, legacySessionName, {
            cwd: "/verification",
        });
        const legacyContractSaved = saveTaskContract(
            legacySessionID,
            [
                "# Task Contract",
                "",
                "## Mission",
                "",
                `Verify task-contract backfill for ${legacySessionName}.`,
                "",
                "## Final Response Format",
                "",
                "Return:",
                "1. exact return list survives",
                "2. cached json backfills missing closeout schema",
                "",
            ].join("\n"),
            { cwd: "/verification" },
        );
        const legacyContractJsonPath = path.join(
            repoRoot(),
            legacyContractSaved.json_path,
        );
        const legacyContractJson = JSON.parse(
            fs.readFileSync(legacyContractJsonPath, "utf8"),
        );
        delete legacyContractJson.final_response_format;
        fs.writeFileSync(
            legacyContractJsonPath,
            `${JSON.stringify(legacyContractJson, null, 2)}\n`,
            "utf8",
        );
        const legacyContract = readTaskContract(legacySessionID, {
            cwd: "/verification",
        });
        const legacyContractJsonReloaded = JSON.parse(
            fs.readFileSync(legacyContractJsonPath, "utf8"),
        );
        const emptyWorkstreamOverview = getWorkstreamOverview(emptySessionID, "", {
            cwd: "/verification",
        });
        const alphaCompaction = buildCompactionContext(alpha.session_id, [
            {
                content: "Keep task contract visible in compaction.",
                priority: "high",
                status: "in_progress",
            },
        ]);
        const alphaClear = clearWorkstream(alpha.session_id, {
            cwd: "/verification",
        });
        const alphaContextAfterClear = getCurrentSessionContext(alpha.session_id, {
            cwd: "/verification",
        });
        const alphaMemoryAfterClear = getSessionMemoryOverview(alpha.session_id, {
            cwd: "/verification",
        });
        const alphaCleanup = cleanupArtifacts(alpha.session_id, {
            cwd: "/verification",
        });
        if (!alphaContract.summary.includes("Required Outputs")) {
            throw new StateError("Task contract summary did not capture outputs.");
        }
        if (!alphaContract.summary.includes("Final response format")) {
            throw new StateError(
                "Task contract summary did not capture the final response format.",
            );
        }
        if (
            !alphaContract.contract.final_response_format.includes(
                "6. recommended next prompt",
            )
        ) {
            throw new StateError(
                "Task contract did not retain the exact final response format.",
            );
        }
        if (
            !alphaMemory.task_contract.final_response_format.includes(
                "1. changed files",
            )
        ) {
            throw new StateError(
                "Memory overview did not retain the final response format.",
            );
        }
        if (
            Number(alphaCheckpoint.frontmatter.task_contract_version || 0) !==
            alpha.contract_version
        ) {
            throw new StateError(
                "Checkpoint frontmatter did not retain the active contract version.",
            );
        }
        if (alphaCheckpoint.frontmatter.active_workstream !== alpha.workstream_name) {
            throw new StateError(
                "Checkpoint frontmatter did not retain the active workstream.",
            );
        }
        if (
            !alphaWorkstreamReopen.preserved_targets.includes("brief") ||
            !alphaWorkstreamReopen.preserved_targets.includes("next_slice") ||
            !alphaWorkstreamReopen.preserved_targets.includes("open_questions")
        ) {
            throw new StateError(
                "Non-destructive workstream reopen did not preserve existing meaningful files.",
            );
        }
        if (
            !alphaCompaction.some((line) =>
                line.includes("Task contract summary:"),
            )
        ) {
            throw new StateError(
                "Compaction context did not include the task contract summary.",
            );
        }
        if (
            !alphaCompaction.some((line) =>
                line.includes("Final response format:"),
            )
        ) {
            throw new StateError(
                "Compaction context did not include the final response format block.",
            );
        }
        if (
            !alphaCompaction.some((line) =>
                line.includes("6. recommended next prompt"),
            )
        ) {
            throw new StateError(
                "Compaction context did not preserve the exact final response format.",
            );
        }
        if (
            !alphaCompaction.some((line) =>
                line.includes(`docs/checkpoints/${alpha.session_name}-checkpoint.md`),
            )
        ) {
            throw new StateError(
                "Compaction context did not include the required output from the task contract.",
            );
        }
        if (
            !alphaCompaction.some((line) =>
                line.includes(`Active workstream: ${alpha.workstream_name}`),
            )
        ) {
            throw new StateError(
                "Compaction context did not include the active workstream name.",
            );
        }
        if (
            !alphaCompaction.some((line) =>
                line.includes("Workstream brief:"),
            )
        ) {
            throw new StateError(
                "Compaction context did not include the workstream brief.",
            );
        }
        if (!alphaWorkstream.initialized) {
            throw new StateError("Active workstream did not initialize.");
        }
        if (
            alphaWorkstream.summaries.brief.includes(
                "This replacement should be preserved instead of applied.",
            )
        ) {
            throw new StateError(
                "Non-destructive workstream reopen overwrote the saved brief.",
            );
        }
        if (
            !alphaWorkstream.summaries.open_questions.includes(
                "Which package should own the next migration slice?",
            )
        ) {
            throw new StateError(
                "Appended workstream open question did not appear in the overview.",
            );
        }
        if (alphaChildContext.session_name !== alpha.session_name) {
            throw new StateError(
                "Child session did not inherit the parent session alias.",
            );
        }
        if (alphaChildContext.active_workstream !== alpha.workstream_name) {
            throw new StateError(
                "Child session did not inherit the parent active workstream.",
            );
        }
        if (
            !alphaWorkstreamAfterChild.linked_sessions.ids.includes(
                alphaChildSessionID,
            )
        ) {
            throw new StateError(
                "Workstream overview did not record the inherited child session.",
            );
        }
        if (!betaWorkstreamReset.replaced_targets.includes("brief")) {
            throw new StateError(
                "Explicit workstream replace did not report the replaced brief.",
            );
        }
        if (
            !betaWorkstreamAfterReset.summaries.brief.includes(
                "Reset beta brief intentionally.",
            )
        ) {
            throw new StateError(
                "Explicit workstream replace did not update the saved brief.",
            );
        }
        if (emptyWorkstreamOverview.summaries.brief) {
            throw new StateError(
                "Empty workstream brief leaked low-signal summary content.",
            );
        }
        if (emptyWorkstreamOverview.summaries.next_slice) {
            throw new StateError(
                "Empty workstream next-slice leaked low-signal summary content.",
            );
        }
        if (emptyWorkstreamOverview.summaries.open_questions) {
            throw new StateError(
                "Default open-questions placeholder leaked into the summary.",
            );
        }
        if (
            !legacyContract.contract.final_response_format.includes(
                "2. cached json backfills missing closeout schema",
            )
        ) {
            throw new StateError(
                "Reading a legacy task-contract json did not backfill the final response format from markdown.",
            );
        }
        if (
            !String(
                legacyContractJsonReloaded.final_response_format || "",
            ).includes("Return:")
        ) {
            throw new StateError(
                "Backfilled task-contract json did not persist the final response format.",
            );
        }
        if (alphaClear.previous_workstream !== alpha.workstream_name) {
            throw new StateError(
                "Clearing the active workstream did not report the previous binding.",
            );
        }
        if (alphaContextAfterClear.active_workstream !== null) {
            throw new StateError(
                "Clearing the active workstream did not update current session state.",
            );
        }
        if (
            alphaMemoryAfterClear.active_workstream !== null ||
            alphaMemoryAfterClear.workstream !== null
        ) {
            throw new StateError(
                "Clearing the active workstream did not remove workstream context from memory_overview.",
            );
        }
        if (fs.existsSync(alpha.artifact_path)) {
            throw new StateError(
                `Artifact cleanup failed for ${alpha.artifact_path}`,
            );
        }

        // resolvePaths verification
        const resolvedPaths = resolvePaths(alpha.session_id, [
            "docs/ai/architecture-brief.md",
            "nonexistent/path/should-be-missing.txt",
            ".opencode/scripts/state-lib.js",
        ], { cwd: "/verification" });
        if (resolvedPaths.total !== 3) {
            throw new StateError(
                `resolvePaths expected 3 results, got ${resolvedPaths.total}`,
            );
        }
        const exactCount = resolvedPaths.results.filter(
            (r) => r.status === "exact",
        ).length;
        const missingCount = resolvedPaths.results.filter(
            (r) => r.status === "missing",
        ).length;
        if (exactCount !== 2) {
            throw new StateError(
                `resolvePaths expected 2 exact paths, got ${exactCount}`,
            );
        }
        if (missingCount !== 1) {
            throw new StateError(
                `resolvePaths expected 1 missing path, got ${missingCount}`,
            );
        }
        if (!resolvedPaths.resolved_context_path) {
            throw new StateError("resolvePaths did not return resolved_context_path");
        }
        const resolvedContextFile = path.join(
            repoRoot(),
            resolvedPaths.resolved_context_path,
        );
        const resolvedContextContent = fs.readFileSync(resolvedContextFile, "utf8");
        if (!resolvedContextContent.includes("Path Resolution")) {
            throw new StateError(
                "resolvePaths did not write a structured section to resolved-context.md",
            );
        }
        if (!resolvedContextContent.includes("exact")) {
            throw new StateError(
                "resolvePaths did not record exact status in resolved-context.md",
            );
        }
        if (!resolvedContextContent.includes("missing")) {
            throw new StateError(
                "resolvePaths did not record missing status in resolved-context.md",
            );
        }

        // recordArtifacts verification
        const batchArtifactDir = path.join(
            repoRoot(),
            "tmp",
            "agent-runs",
            alpha.session_name,
            "batch-test",
        );
        fs.mkdirSync(batchArtifactDir, { recursive: true });
        const batchFiles = ["batch-a.txt", "batch-b.txt"];
        for (const f of batchFiles) {
            fs.writeFileSync(path.join(batchArtifactDir, f), "batch test\n", "utf8");
        }
        const batchResult = recordArtifacts(
            alpha.session_id,
            batchFiles.map((f) => ({
                path: path.join(batchArtifactDir, f),
                kind: "batch_test",
                retention: "delete_on_success",
                notes: `Batch artifact ${f}`,
            })),
            { cwd: "/verification" },
        );
        if (batchResult.total !== 2) {
            throw new StateError(
                `recordArtifacts expected 2 total, got ${batchResult.total}`,
            );
        }
        if (batchResult.recorded !== 2) {
            throw new StateError(
                `recordArtifacts expected 2 recorded, got ${batchResult.recorded}`,
            );
        }
        if (batchResult.errors !== 0) {
            throw new StateError(
                `recordArtifacts expected 0 errors, got ${batchResult.errors}`,
            );
        }

        // recordArtifacts with mixed valid and invalid
        const mixedResult = recordArtifacts(
            alpha.session_id,
            [
                { path: path.join(batchArtifactDir, "batch-a.txt"), kind: "duplicate_test" },
                { path: "", kind: "empty_path" },
            ],
            { cwd: "/verification" },
        );
        if (mixedResult.recorded !== 1) {
            throw new StateError(
                `recordArtifacts mixed expected 1 recorded, got ${mixedResult.recorded}`,
            );
        }
        if (mixedResult.errors !== 1) {
            throw new StateError(
                `recordArtifacts mixed expected 1 error, got ${mixedResult.errors}`,
            );
        }

        console.log("verification: ok");
        console.log(
            `session_alpha: ${alpha.session_id} -> ${alpha.session_name}`,
        );
        console.log(`session_beta: ${beta.session_id} -> ${beta.session_name}`);
        console.log(
            `alpha_plan: ${adopted.plan.id} (resolved via ${resolvedAlpha.resolved_via})`,
        );
        console.log(
            `beta_plan: ${resolvedBeta.plan.id} (resolved via ${resolvedBeta.resolved_via})`,
        );
        console.log(`alpha_draft: ${alpha.draft_path}`);
        console.log(`beta_draft: ${beta.draft_path}`);
        console.log(`alpha_contract_version: ${alphaContract.version}`);
        console.log(
            `alpha_final_response_format_lines: ${alphaContract.contract.final_response_format.split("\n").filter(Boolean).length}`,
        );
        console.log(`alpha_checkpoint: ${alphaCheckpoint.checkpoint.id}`);
        console.log(`alpha_handoff: ${alpha.handoff_path}`);
        console.log(`alpha_workstream: ${alpha.workstream_name}`);
        console.log("legacy_contract_backfill: ok");
        console.log(
            `alpha_memory: initialized=${alphaMemory.initialized} latest_checkpoint=${alphaMemory.latest_checkpoint ? alphaMemory.latest_checkpoint.id : "(none)"}`,
        );
        console.log(
            `alpha_workstream_summary: ${alphaWorkstream.summaries.brief || "(none)"}`,
        );
        console.log(
            `alpha_workstream_reopen_preserved: ${alphaWorkstreamReopen.preserved_targets.join(", ") || "(none)"}`,
        );
        console.log(
            `alpha_child: ${alphaChildSessionID} -> alias=${alphaChildContext.session_name} workstream=${alphaChildContext.active_workstream || "(none)"}`,
        );
        console.log(
            `beta_workstream_reset: replaced=${betaWorkstreamReset.replaced_targets.join(", ") || "(none)"}`,
        );
        console.log(
            `empty_workstream_summary: brief=${emptyWorkstreamOverview.summaries.brief || "(none)"} next_slice=${emptyWorkstreamOverview.summaries.next_slice || "(none)"}`,
        );
        console.log(
            `alpha_clear: previous=${alphaClear.previous_workstream || "(none)"} current=${alphaContextAfterClear.active_workstream || "(none)"}`,
        );
        console.log(
            `alpha_cleanup_deleted: ${alphaCleanup.deleted.join(", ") || "(none)"}`,
        );
        console.log(
            `resolve_paths: total=${resolvedPaths.total} exact=${resolvedPaths.exact} missing=${resolvedPaths.missing}`,
        );
        console.log(
            `record_artifacts: total=${batchResult.total} recorded=${batchResult.recorded} errors=${batchResult.errors}`,
        );
        console.log(
            `record_artifacts_mixed: recorded=${mixedResult.recorded} errors=${mixedResult.errors}`,
        );
        console.log("beta_list:");
        for (const line of betaList.plans.map(
            (plan) => `- ${plan.id} [${plan.status}] ${plan.title}`,
        )) {
            console.log(line);
        }
        return 0;
    } catch (error) {
        if (error instanceof StateError) {
            console.error(error.message);
            return 1;
        }
        throw error;
    }
}

process.exitCode = main();
