import { tool } from "@opencode-ai/plugin";
import {
    StateError,
    approveDraft,
    appendWorkstreamNote,
    appendDecision,
    bindSessionName,
    bindWorkstream,
    clearWorkstream,
    cleanupArtifacts,
    getCurrentSessionContext,
    getSessionMemoryOverview,
    getWorkstreamOverview,
    initSessionMemory,
    initWorkstreamMemory,
    listPlans,
    readTaskContract,
    readCheckpoint,
    readDraft,
    readCoordinationTask,
    listCoordinationTasks,
    recordArtifact,
    recordArtifacts,
    readyCoordinationTask,
    updateCoordinationTaskMetadata,
    repairCoordinationTask,
    reviewCoordinationTask,
    resolvePaths,
    resolvePlan,
    saveCoordinationTask,
    saveCoordinationTaskCloseout,
    saveDraft,
    saveHandoff,
    saveCheckpoint,
    savePlan,
    saveTaskContract,
    activateCoordinationTask,
    adoptPlan,
    writeSessionMemoryFile,
    writeWorkstreamFile,
} from "../scripts/state-lib.js";

function parseJsonArray(raw, fieldName) {
    const text = String(raw || "").trim();
    if (!text) {
        return [];
    }
    try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) {
            throw new Error(`${fieldName} must be a JSON array`);
        }
        return parsed;
    } catch (err) {
        throw new Error(
            `Invalid JSON for ${fieldName}: ${err.message}`,
        );
    }
}

function parseJsonObject(raw, fieldName) {
    const text = String(raw || "").trim();
    if (!text) {
        return {};
    }
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error(`${fieldName} must be a JSON object`);
        }
        return parsed;
    } catch (err) {
        throw new Error(
            `Invalid JSON for ${fieldName}: ${err.message}`,
        );
    }
}

function render(result) {
    return JSON.stringify(result, null, 2);
}

export const planStateTool = tool({
    description:
        "Manage OpenCode session-scoped plan and memory state using the real OpenCode sessionID. Use this for binding a human-readable session alias, managing active workstreams for cross-session themes, clearing or rebinding workstream context, drafting plans under .opencode/plans/<session-name>/, approving session plans, listing/adopting/resolving approved plans, initializing session and workstream memory, appending or replacing targeted workstream files, saving and reopening the stable task contract, saving checkpoints and handoffs, recording artifacts, cleaning disposable outputs, reading the current session state, and maintaining the local coordination task registry under .local/coordinator/.",
    args: {
        operation: tool.schema
            .enum([
                "bind_session_name",
                "bind_workstream",
                "clear_workstream",
                "current_session",
                "memory_overview",
                "workstream_overview",
                "save_plan",
                "list_plans",
                "adopt_plan",
                "resolve_plan",
                "save_draft",
                "read_draft",
                "approve_draft",
                "init_session_memory",
                "init_workstream_memory",
                "save_task_contract",
                "read_task_contract",
                "write_memory_file",
                "write_workstream_file",
                "append_workstream_note",
                "append_decision",
                "save_checkpoint",
                "read_checkpoint",
                "save_handoff",
                "save_coordination_task",
                "read_coordination_task",
                "list_coordination_tasks",
                "activate_coordination_task",
                "ready_coordination_task",
                "update_coordination_task",
                "repair_coordination_task",
                "save_coordination_task_closeout",
                "review_coordination_task",
                "record_artifact",
                "record_artifacts",
                "resolve_paths",
                "cleanup_artifacts",
            ])
            .describe("Plan-state operation to execute."),
        session_name: tool.schema
            .string()
            .optional()
            .describe("Human-readable session alias for bind_session_name."),
        workstream_name: tool.schema
            .string()
            .optional()
            .describe(
                "Workstream slug for bind_workstream, workstream_overview, init_workstream_memory, write_workstream_file, or append_workstream_note.",
            ),
        target: tool.schema
            .enum(["brief", "resolved_context", "open_questions"])
            .optional()
            .describe("Session memory target for write_memory_file."),
        workstream_target: tool.schema
            .enum([
                "brief",
                "next_slice",
                "open_questions",
                "rejected_options",
                "links",
            ])
            .optional()
            .describe(
                "Workstream memory target for write_workstream_file or append_workstream_note.",
            ),
        slug: tool.schema
            .string()
            .optional()
            .describe(
                "Slug for save_plan, save_draft, save_checkpoint, or save_handoff.",
            ),
        title: tool.schema
            .string()
            .optional()
            .describe("Optional human title for saved plans, drafts, or notes."),
        body: tool.schema
            .string()
            .optional()
            .describe("Markdown body for saved plans, drafts, or notes."),
        brief_body: tool.schema
            .string()
            .optional()
            .describe("Optional markdown body for session brief initialization."),
        resolved_context_body: tool.schema
            .string()
            .optional()
            .describe(
                "Optional markdown body for resolved-context initialization.",
            ),
        open_questions_body: tool.schema
            .string()
            .optional()
            .describe("Optional markdown body for open-questions initialization."),
        next_slice_body: tool.schema
            .string()
            .optional()
            .describe("Optional markdown body for workstream next-slice initialization."),
        rejected_options_body: tool.schema
            .string()
            .optional()
            .describe(
                "Optional markdown body for workstream rejected-options initialization.",
            ),
        links_body: tool.schema
            .string()
            .optional()
            .describe("Optional markdown body for workstream links initialization."),
        replace_existing: tool.schema
            .boolean()
            .optional()
            .describe(
                "For init_workstream_memory only. When true, replace existing workstream files instead of preserving meaningful content.",
            ),
        selector: tool.schema
            .string()
            .optional()
            .describe(
                "Explicit plan id or unique prefix for adopt_plan, resolve_plan, or read_checkpoint.",
            ),
        include_body: tool.schema
            .boolean()
            .optional()
            .describe(
                "When resolving a plan or checkpoint, include the full markdown body in the output.",
            ),
        goal: tool.schema
            .string()
            .optional()
            .describe("Optional goal for checkpoint frontmatter."),
        next_step: tool.schema
            .string()
            .optional()
            .describe("Optional next step for checkpoint or handoff frontmatter."),
        target_agent: tool.schema
            .string()
            .optional()
            .describe("Optional target agent name for handoff frontmatter."),
        artifact_path: tool.schema
            .string()
            .optional()
            .describe("Artifact path to record."),
        kind: tool.schema
            .string()
            .optional()
            .describe("Artifact kind."),
        retention: tool.schema
            .string()
            .optional()
            .describe("Artifact retention policy."),
        notes: tool.schema
            .string()
            .optional()
            .describe("Optional artifact notes."),
        retentions_csv: tool.schema
            .string()
            .optional()
            .describe(
                "Comma-separated retention policies to delete during cleanup_artifacts.",
            ),
        path_refs: tool.schema
            .string()
            .optional()
            .describe(
                "JSON array of path strings to resolve for resolve_paths.",
            ),
        artifact_list: tool.schema
            .string()
            .optional()
            .describe(
                "JSON array of {path, kind?, retention?, notes?} objects for record_artifacts.",
            ),
        task_id: tool.schema
            .string()
            .optional()
            .describe(
                "Task id for local coordination task registry operations.",
            ),
        task_payload: tool.schema
            .string()
            .optional()
            .describe(
                "JSON object payload for save_coordination_task, ready_coordination_task, update_coordination_task, or repair_coordination_task.",
            ),
        task_status: tool.schema
            .string()
            .optional()
            .describe(
                "Task status for coordination-task closeout or review operations.",
            ),
        task_statuses_csv: tool.schema
            .string()
            .optional()
            .describe(
                "Comma-separated coordination-task statuses to filter list_coordination_tasks.",
            ),
        report_envelope: tool.schema
            .string()
            .optional()
            .describe(
                "Report envelope override for coordination-task closeout.",
            ),
        promotion_recommended: tool.schema
            .boolean()
            .optional()
            .describe(
                "Whether a coordination-task closeout recommends promotion into durable repo canon.",
            ),
        next_action: tool.schema
            .string()
            .optional()
            .describe(
                "Next recommended action for coordination-task closeout or review.",
            ),
        force_takeover: tool.schema
            .boolean()
            .optional()
            .describe(
                "Allow activate_coordination_task to take over a working task owned by another session alias.",
            ),
    },
    async execute(args, context) {
        try {
            context.metadata({
                title: "plan-state",
                metadata: {
                    operation: args.operation,
                    sessionID: context.sessionID,
                },
            });

            switch (args.operation) {
                case "bind_session_name":
                    return render(
                        bindSessionName(
                            context.sessionID,
                            args.session_name || "",
                            {
                                cwd: context.directory,
                            },
                        ),
                    );
                case "bind_workstream":
                    return render(
                        bindWorkstream(
                            context.sessionID,
                            args.workstream_name || "",
                            {
                                cwd: context.directory,
                            },
                        ),
                    );
                case "clear_workstream":
                    return render(
                        clearWorkstream(context.sessionID, {
                            cwd: context.directory,
                        }),
                    );
                case "current_session":
                    return render(
                        getCurrentSessionContext(context.sessionID, {
                            cwd: context.directory,
                        }),
                    );
                case "memory_overview":
                    return render(
                        getSessionMemoryOverview(context.sessionID, {
                            cwd: context.directory,
                        }),
                    );
                case "workstream_overview":
                    return render(
                        getWorkstreamOverview(
                            context.sessionID,
                            args.workstream_name || "",
                            {
                                cwd: context.directory,
                            },
                        ),
                    );
                case "save_plan":
                    return render(
                        savePlan(
                            context.sessionID,
                            args.slug || "",
                            args.body || "",
                            args.title || "",
                            { cwd: context.directory },
                        ),
                    );
                case "list_plans":
                    return render(
                        listPlans(context.sessionID, {
                            cwd: context.directory,
                        }),
                    );
                case "adopt_plan":
                    return render(
                        adoptPlan(context.sessionID, args.selector || "", {
                            cwd: context.directory,
                        }),
                    );
                case "resolve_plan": {
                    const resolved = resolvePlan(
                        context.sessionID,
                        args.selector || "",
                        {
                            cwd: context.directory,
                        },
                    );
                    if (!args.include_body) {
                        delete resolved.body;
                    }
                    return render(resolved);
                }
                case "save_draft":
                    return render(
                        saveDraft(
                            context.sessionID,
                            args.slug || "",
                            args.body || "",
                            args.title || "",
                            { cwd: context.directory },
                        ),
                    );
                case "read_draft":
                    return render(
                        readDraft(context.sessionID, args.slug || "", {
                            cwd: context.directory,
                        }),
                    );
                case "approve_draft":
                    return render(
                        approveDraft(context.sessionID, args.slug || "", {
                            cwd: context.directory,
                        }),
                    );
                case "init_session_memory":
                    return render(
                        initSessionMemory(context.sessionID, {
                            cwd: context.directory,
                            briefBody: args.brief_body,
                            resolvedContextBody: args.resolved_context_body,
                            openQuestionsBody: args.open_questions_body,
                        }),
                    );
                case "init_workstream_memory":
                    return render(
                        initWorkstreamMemory(
                            context.sessionID,
                            args.workstream_name || "",
                            {
                                cwd: context.directory,
                                briefBody: args.brief_body,
                                nextSliceBody: args.next_slice_body,
                                openQuestionsBody: args.open_questions_body,
                                rejectedOptionsBody:
                                    args.rejected_options_body,
                                linksBody: args.links_body,
                                replaceExisting: args.replace_existing,
                            },
                        ),
                    );
                case "save_task_contract":
                    return render(
                        saveTaskContract(
                            context.sessionID,
                            args.body || "",
                            {
                                cwd: context.directory,
                            },
                        ),
                    );
                case "read_task_contract": {
                    const resolved = readTaskContract(context.sessionID, {
                        cwd: context.directory,
                    });
                    if (!args.include_body) {
                        delete resolved.body;
                    }
                    return render(resolved);
                }
                case "write_memory_file":
                    return render(
                        writeSessionMemoryFile(
                            context.sessionID,
                            args.target || "",
                            args.body || "",
                            {
                                cwd: context.directory,
                            },
                        ),
                    );
                case "write_workstream_file":
                    return render(
                        writeWorkstreamFile(
                            context.sessionID,
                            args.workstream_target || "",
                            args.body || "",
                            args.workstream_name || "",
                            {
                                cwd: context.directory,
                            },
                        ),
                    );
                case "append_workstream_note":
                    return render(
                        appendWorkstreamNote(
                            context.sessionID,
                            args.workstream_target || "",
                            args.body || "",
                            args.workstream_name || "",
                            {
                                cwd: context.directory,
                                title: args.title || "",
                            },
                        ),
                    );
                case "append_decision":
                    return render(
                        appendDecision(
                            context.sessionID,
                            args.body || "",
                            args.title || "",
                            {
                                cwd: context.directory,
                            },
                        ),
                    );
                case "save_checkpoint":
                    return render(
                        saveCheckpoint(
                            context.sessionID,
                            args.slug || "",
                            args.body || "",
                            args.title || "",
                            {
                                cwd: context.directory,
                                goal: args.goal || "",
                                nextStep: args.next_step || "",
                            },
                        ),
                    );
                case "read_checkpoint": {
                    const resolved = readCheckpoint(
                        context.sessionID,
                        args.selector || "",
                        {
                            cwd: context.directory,
                        },
                    );
                    if (!args.include_body) {
                        delete resolved.body;
                    }
                    return render(resolved);
                }
                case "save_handoff":
                    return render(
                        saveHandoff(
                            context.sessionID,
                            args.slug || "",
                            args.body || "",
                            args.title || "",
                            {
                                cwd: context.directory,
                                targetAgent: args.target_agent || "",
                                nextStep: args.next_step || "",
                            },
                        ),
                    );
                case "save_coordination_task": {
                    const taskPayload = parseJsonObject(
                        args.task_payload,
                        "task_payload",
                    );
                    if (args.task_id && !taskPayload.task_id) {
                        taskPayload.task_id = args.task_id;
                    }
                    return render(
                        saveCoordinationTask(
                            context.sessionID,
                            taskPayload,
                            {
                                cwd: context.directory,
                            },
                        ),
                    );
                }
                case "read_coordination_task": {
                    const resolved = readCoordinationTask(
                        context.sessionID,
                        args.task_id || "",
                        {
                            cwd: context.directory,
                            includeBody: args.include_body,
                        },
                    );
                    return render(resolved);
                }
                case "list_coordination_tasks":
                    return render(
                        listCoordinationTasks(context.sessionID, {
                            cwd: context.directory,
                            statuses: String(args.task_statuses_csv || "")
                                .split(",")
                                .map((value) => value.trim())
                                .filter(Boolean),
                        }),
                    );
                case "activate_coordination_task":
                    return render(
                        activateCoordinationTask(
                            context.sessionID,
                            args.task_id || "",
                            {
                                cwd: context.directory,
                                forceTakeover: Boolean(args.force_takeover),
                            },
                        ),
                    );
                case "ready_coordination_task": {
                    const taskPayload = parseJsonObject(
                        args.task_payload,
                        "task_payload",
                    );
                    return render(
                        readyCoordinationTask(
                            context.sessionID,
                            args.task_id || "",
                            taskPayload,
                            {
                                cwd: context.directory,
                            },
                        ),
                    );
                }
                case "update_coordination_task": {
                    const taskPayload = parseJsonObject(
                        args.task_payload,
                        "task_payload",
                    );
                    return render(
                        updateCoordinationTaskMetadata(
                            context.sessionID,
                            args.task_id || "",
                            taskPayload,
                            {
                                cwd: context.directory,
                            },
                        ),
                    );
                }
                case "repair_coordination_task": {
                    const taskPayload = parseJsonObject(
                        args.task_payload,
                        "task_payload",
                    );
                    return render(
                        repairCoordinationTask(
                            context.sessionID,
                            args.task_id || "",
                            taskPayload,
                            {
                                cwd: context.directory,
                            },
                        ),
                    );
                }
                case "save_coordination_task_closeout":
                    return render(
                        saveCoordinationTaskCloseout(
                            context.sessionID,
                            args.task_id || "",
                            {
                                cwd: context.directory,
                                title: args.title || "",
                                body: args.body || "",
                                taskStatus: args.task_status || "",
                                reportEnvelope: args.report_envelope || "",
                                promotionRecommended:
                                    args.promotion_recommended,
                                nextAction: args.next_action,
                            },
                        ),
                    );
                case "review_coordination_task":
                    return render(
                        reviewCoordinationTask(
                            context.sessionID,
                            args.task_id || "",
                            {
                                cwd: context.directory,
                                title: args.title || "",
                                body: args.body || "",
                                taskStatus: args.task_status || "",
                                nextAction: args.next_action,
                            },
                        ),
                    );
                case "record_artifact":
                    return render(
                        recordArtifact(
                            context.sessionID,
                            args.artifact_path || "",
                            {
                                cwd: context.directory,
                                kind: args.kind || "",
                                retention: args.retention || "",
                                notes: args.notes || "",
                            },
                        ),
                    );
                case "record_artifacts": {
                    const artifactList = parseJsonArray(
                        args.artifact_list,
                        "artifact_list",
                    );
                    return render(
                        recordArtifacts(context.sessionID, artifactList, {
                            cwd: context.directory,
                        }),
                    );
                }
                case "resolve_paths": {
                    const pathRefs = parseJsonArray(args.path_refs, "path_refs");
                    return render(
                        resolvePaths(context.sessionID, pathRefs, {
                            cwd: context.directory,
                        }),
                    );
                }
                case "cleanup_artifacts":
                    return render(
                        cleanupArtifacts(context.sessionID, {
                            cwd: context.directory,
                            retentions: String(args.retentions_csv || "")
                                .split(",")
                                .map((value) => value.trim())
                                .filter(Boolean),
                        }),
                    );
                default:
                    throw new StateError(
                        `Unsupported plan-state operation: ${args.operation}`,
                    );
            }
        } catch (error) {
            if (error instanceof StateError) {
                throw new Error(error.message);
            }
            throw error;
        }
    },
});
