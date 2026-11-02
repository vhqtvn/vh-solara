import fs from "fs";
import path from "path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "url";
import {
    validateF3DesignReadiness,
    computeDesignDigest,
} from "./f3-design-readiness.js";
import {
    extractAllRewriteParityBlocks,
    validateRewriteParityCompletion,
} from "./rewrite-parity-validate.js";
import { readPauseState, formatRefusal } from "./pause-new-work.js";

const SCHEMA_VERSION = 1;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;
const STALE_LOCK_MS = 30000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Render-location guard (regression: F3 Slice-7 dogfood once ran THIS file
// from templates/core/.opencode/scripts/ — the unrendered SOURCE copy). The
// source copy still carries the literal coordinator-directory template token
// (resolved only at render time) and resolves repoRoot() to templates/core/,
// so running it wrote stray runtime artifacts into the template tree
// (the unresolved coordinator dir under .local/, plus
// .vh-agent-harness/coordinator-adoption.json) — and a template copy shipping
// adopted:true would break greenfield installs (dir-absent + marker-valid =
// FAIL). A rendered copy contains NO unrendered tokens; refuse to load an
// unrendered one so the wrong invocation fails loudly instead of silently
// corrupting the template tree. Run the RENDERED copy at
// <repo>/.opencode/scripts/state-lib.js instead.
//
// The token delimiter is built at runtime (not written literally in source)
// so the renderer never resolves it INSIDE this guard — otherwise the guard's
// own condition would be transformed by rendering and misfire on the very copy
// it protects. Char codes: 123 = open-brace, 125 = close-brace.
(function assertRenderedNotSource() {
    let selfSrc = "";
    try {
        selfSrc = fs.readFileSync(__filename, "utf8");
    } catch {
        return; // unreadable self — let the downstream error surface.
    }
    const OPEN = String.fromCharCode(123, 123); // open-brace, open-brace
    const CLOSE = String.fromCharCode(125, 125); // close-brace, close-brace
    const TOKEN = OPEN + "COORDINATOR_DIR" + CLOSE;
    if (selfSrc.includes(TOKEN)) {
        throw new Error(
            "REFUSING to load state-lib.js from an UNRENDERED templates/core/ " +
                "source copy (its bytes still contain the literal " +
                "coordinator-directory template token, which is resolved only " +
                "at render time). Running the source copy resolves repoRoot() " +
                "to templates/core/ and writes stray runtime artifacts (the " +
                "unresolved coordinator dir under .local/, plus " +
                ".vh-agent-harness/coordinator-adoption.json) into the " +
                "template tree. Run the RENDERED copy at " +
                "<repo>/.opencode/scripts/state-lib.js instead.",
        );
    }
})();

const MEMORY_TARGETS = Object.freeze({
    brief: {
        filename: "brief.md",
        title: "Session Brief",
    },
    resolved_context: {
        filename: "resolved-context.md",
        title: "Resolved Context",
    },
    open_questions: {
        filename: "open-questions.md",
        title: "Open Questions",
    },
});
const WORKSTREAM_TARGETS = Object.freeze({
    brief: {
        filename: "brief.md",
        title: "Workstream Brief",
    },
    next_slice: {
        filename: "next-slice.md",
        title: "Next Slice",
    },
    open_questions: {
        filename: "open-questions.md",
        title: "Open Questions",
    },
    rejected_options: {
        filename: "rejected-options.md",
        title: "Rejected Options",
    },
    links: {
        filename: "links.md",
        title: "Links",
    },
});
const SESSION_DOCUMENT_KINDS = Object.freeze({
    checkpoint: {
        dirName: "checkpoints",
        label: "Checkpoint",
    },
    handoff: {
        dirName: "handoffs",
        label: "Handoff",
    },
});
const COORDINATION_TASK_TYPES = Object.freeze([
    "implementation",
    "study",
    "research",
    "docs",
    "verification",
]);
const RESEARCH_SOURCE_POLICIES = Object.freeze([
    "repo_only",
    "web_repo",
    "restricted_sites",
]);
const RESEARCH_ARTIFACT_TYPES = Object.freeze(["sources", "decision"]);
const COORDINATION_MODES = Object.freeze(["short", "medium", "long"]);
const COORDINATION_REPORT_ENVELOPES = Object.freeze([
    "minimal",
    "standard",
    "synthesis",
]);
const COORDINATION_TASK_STATUSES = Object.freeze([
    "draft",
    "ready",
    "working",
    "reported",
    "blocked",
    "completed",
    "cancelled",
]);
const OPEN_COORDINATION_TASK_STATUSES = new Set([
    "draft",
    "ready",
    "working",
    "reported",
    "blocked",
]);
const COORDINATION_CLOSEOUT_STATUSES = new Set([
    "reported",
    "blocked",
    "completed",
]);
const COORDINATION_REVIEWABLE_STATUSES = new Set([
    "reported",
    "blocked",
    "completed",
]);
const COORDINATION_RESUMABLE_STATUSES = new Set([
    "ready",
    "working",
]);
const DEFAULT_REPORT_ENVELOPE_BY_MODE = Object.freeze({
    short: "minimal",
    medium: "standard",
    long: "synthesis",
});
const DEFAULT_CLEANUP_RETENTIONS = ["delete_on_success"];
const TASK_CONTRACT_LIST_FIELDS = new Set([
    "must_read",
    "must_do",
    "must_not_do",
    "required_outputs",
    "required_commands",
    "completion_checklist",
    "notes",
]);
const TASK_CONTRACT_TEXT_FIELDS = new Set([
    "mission",
    "user_requirements",
    "final_response_format",
]);
const TASK_CONTRACT_SECTION_ALIASES = Object.freeze({
    mission: "mission",
    "user requirements": "user_requirements",
    "exact user requirements": "user_requirements",
    "user request": "user_requirements",
    "must read": "must_read",
    "must do": "must_do",
    "must not do": "must_not_do",
    "must not": "must_not_do",
    "forbidden actions": "must_not_do",
    "required outputs": "required_outputs",
    "final response format": "final_response_format",
    "final output format": "final_response_format",
    "closeout expectations": "final_response_format",
    return: "final_response_format",
    "required commands": "required_commands",
    "completion checklist": "completion_checklist",
    notes: "notes",
});
const TASK_CONTRACT_SECTION_LABELS = Object.freeze({
    mission: "Mission",
    user_requirements: "User Requirements",
    must_read: "Must Read",
    must_do: "Must Do",
    must_not_do: "Must Not Do",
    required_outputs: "Required Outputs",
    final_response_format: "Final Response Format",
    required_commands: "Required Commands",
    completion_checklist: "Completion Checklist",
    notes: "Notes",
});
const TASK_CONTRACT_SECTION_ORDER = Object.freeze([
    "mission",
    "user_requirements",
    "must_read",
    "must_do",
    "must_not_do",
    "required_outputs",
    "final_response_format",
    "required_commands",
    "completion_checklist",
    "notes",
]);

export class StateError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = "StateError";
        // Optional causal chain. Attaching the original error preserves the
        // distinction a caller needs to classify a failure (e.g. a JSON.parse
        // SyntaxError vs a genuine filesystem error that surfaced inside the
        // same try block). Existing callers construct StateError with a single
        // message argument, so an absent cause changes nothing.
        if (cause !== undefined && cause !== null) {
            this.cause = cause;
        }
    }
}

/**
 * Build a single aggregated error message from a list of collected validation
 * problems. Returns null when there are no problems so callers can guard a
 * single `throw` with `if (message) throw new StateError(message)`.
 *
 * Message format:
 *   - 0 errors -> null
 *   - 1 error  -> the raw message (preserves exact backward-compat text for
 *                 single-problem payloads, including expectStateError substring
 *                 assertions in verify-task-registry.js)
 *   - N errors -> `${N} validation problems:\n1. ${a}\n2. ${b}\n...`
 *
 * Each collected message is emitted verbatim as a numbered bullet so existing
 * substring-based assertions still pass.
 *
 * @param {string[]|null|undefined} errors
 * @returns {string|null}
 */
function formatAggregatedErrors(errors) {
    if (!Array.isArray(errors)) {
        return null;
    }
    const list = errors.filter((line) => line !== null && line !== undefined && line !== "");
    if (!list.length) {
        return null;
    }
    if (list.length === 1) {
        return list[0];
    }
    const bullets = list
        .map((line, index) => `${index + 1}. ${line}`)
        .join("\n");
    return `${list.length} validation problems:\n${bullets}`;
}

/**
 * Throw a single aggregated StateError when `errors` contains at least one
 * non-empty message. No-op when the list is empty (or all entries are empty).
 *
 * @param {string[]|null|undefined} errors
 * @returns {void}
 * @throws {StateError}
 */
function throwCollectedErrors(errors) {
    const message = formatAggregatedErrors(errors);
    if (message) {
        throw new StateError(message);
    }
}

function repoRoot() {
    return path.resolve(__dirname, "..", "..");
}

function hostCwd() {
    return (
        (process.env.OPENCODE_CWD || "").trim() || process.cwd() || repoRoot()
    );
}

function opencodeRoot() {
    return path.join(repoRoot(), ".opencode");
}

function stateRoot() {
    const override = (process.env.OPENCODE_STATE_ROOT || "").trim();
    if (override) return override;
    return path.join(opencodeRoot(), "state");
}

function sessionBindingsRoot() {
    return path.join(stateRoot(), "session-bindings");
}

function sessionsRoot() {
    return path.join(stateRoot(), "sessions");
}

function workstreamsRoot() {
    return path.join(stateRoot(), "workstreams");
}

function draftsRoot() {
    return path.join(opencodeRoot(), "plans");
}

function draftsSessionDir(sessionName) {
    return path.join(draftsRoot(), sessionName);
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function ensureStateDirs() {
    ensureDir(sessionBindingsRoot());
    ensureDir(sessionsRoot());
    ensureDir(workstreamsRoot());
    ensureDir(draftsRoot());
}

function isoZ(date = new Date()) {
    const normalized = new Date(date.getTime());
    normalized.setMilliseconds(0);
    return normalized.toISOString().replace(".000Z", "Z");
}

function planTimestamp(date = new Date()) {
    const year = String(date.getUTCFullYear());
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const hour = String(date.getUTCHours()).padStart(2, "0");
    const minute = String(date.getUTCMinutes()).padStart(2, "0");
    const second = String(date.getUTCSeconds()).padStart(2, "0");
    return `${year}-${month}-${day}T${hour}-${minute}-${second}`;
}

function slugify(value) {
    const normalized = String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^[-._]+|[-._]+$/g, "");
    if (!normalized) {
        throw new StateError(
            "Provide a non-empty slug made of letters, numbers, dots, underscores, or dashes.",
        );
    }
    return normalized;
}

function normalizeSessionName(value) {
    return slugify(value);
}

function normalizeWorkstreamName(value) {
    return slugify(value);
}

function titleFromSlug(slug) {
    const words = String(slug || "")
        .trim()
        .split(/[-_.]+/)
        .filter(Boolean);
    if (!words.length) {
        return "Untitled Plan";
    }
    return words
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

function yamlScalar(value) {
    const text = String(value);
    return /^[A-Za-z0-9._/:+-]+$/.test(text) ? text : JSON.stringify(text);
}

function relativeToRepo(targetPath) {
    return path
        .relative(repoRoot(), path.resolve(targetPath))
        .replace(/\\/g, "/");
}

function sleep(ms) {
    const shared = new SharedArrayBuffer(4);
    const view = new Int32Array(shared);
    Atomics.wait(view, 0, 0, ms);
}

function atomicWriteText(targetPath, content) {
    ensureDir(path.dirname(targetPath));
    const tmpPath = path.join(
        path.dirname(targetPath),
        `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`,
    );
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, targetPath);
}

function atomicWriteJson(targetPath, payload) {
    atomicWriteText(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(targetPath, defaultValue) {
    if (!fs.existsSync(targetPath)) {
        if (defaultValue === undefined) {
            throw new StateError(`Missing state file: ${targetPath}`);
        }
        return defaultValue;
    }
    try {
        return JSON.parse(fs.readFileSync(targetPath, "utf8"));
    } catch (error) {
        // Preserve the original error as `.cause` so a caller can classify the
        // failure: a JSON.parse SyntaxError (corrupt JSON) vs a genuine
        // filesystem error (permission denied / IO) that surfaced inside this
        // try block. The thrown type (StateError) and message are unchanged, so
        // every existing caller behaves exactly as before; only callers that
        // opt into inspecting `.cause` see the new field.
        throw new StateError(`Malformed JSON state file: ${targetPath}`, error);
    }
}

function withLock(lockPath, fn) {
    ensureDir(path.dirname(lockPath));
    const startedAt = Date.now();
    let fd = null;

    while (fd === null) {
        try {
            fd = fs.openSync(lockPath, "wx");
            fs.writeFileSync(fd, `${process.pid} ${isoZ()}\n`, "utf8");
        } catch (error) {
            if (error.code !== "EEXIST") {
                throw error;
            }
            try {
                const stats = fs.statSync(lockPath);
                if (Date.now() - stats.mtimeMs > STALE_LOCK_MS) {
                    fs.unlinkSync(lockPath);
                    continue;
                }
            } catch (statError) {
                if (statError.code === "ENOENT") {
                    continue;
                }
                throw statError;
            }
            if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
                throw new StateError(
                    `Timed out waiting for session state lock: ${lockPath}`,
                );
            }
            sleep(LOCK_RETRY_MS);
        }
    }

    try {
        return fn();
    } finally {
        try {
            fs.closeSync(fd);
        } catch (error) {
            if (error.code !== "EBADF") {
                throw error;
            }
        }
        try {
            fs.unlinkSync(lockPath);
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
    }
}

function sessionBindingPath(sessionID) {
    return path.join(sessionBindingsRoot(), `${sessionID}.json`);
}

function sessionAliasDir(sessionName) {
    return path.join(sessionsRoot(), sessionName);
}

function workstreamDir(workstreamName) {
    return path.join(workstreamsRoot(), workstreamName);
}

function sessionPlansDir(sessionName) {
    return path.join(sessionAliasDir(sessionName), "plans");
}

function sessionIndexPath(sessionName) {
    return path.join(sessionAliasDir(sessionName), "index.json");
}

function sessionIndexLockPath(sessionName) {
    return path.join(sessionAliasDir(sessionName), ".index.json.lock");
}

function draftPath(sessionName, slug) {
    return path.join(draftsSessionDir(sessionName), `${slugify(slug)}.md`);
}

function sessionMemoryDir(sessionName) {
    return path.join(sessionAliasDir(sessionName), "memory");
}

function sessionMemoryLockPath(sessionName) {
    return path.join(sessionAliasDir(sessionName), ".memory.lock");
}

function sessionDocumentDir(sessionName, kind) {
    const config = SESSION_DOCUMENT_KINDS[kind];
    if (!config) {
        throw new StateError(`Unsupported session document kind: ${kind}`);
    }
    return path.join(sessionMemoryDir(sessionName), config.dirName);
}

function sessionMemoryFilePath(sessionName, target) {
    const config = MEMORY_TARGETS[target];
    if (!config) {
        throw new StateError(`Unsupported session memory target: ${target}`);
    }
    return path.join(sessionMemoryDir(sessionName), config.filename);
}

function sessionDecisionLogPath(sessionName) {
    return path.join(sessionMemoryDir(sessionName), "decision-log.md");
}

function sessionArtifactsIndexPath(sessionName) {
    return path.join(sessionMemoryDir(sessionName), "artifacts.json");
}

function sessionTaskContractPath(sessionName) {
    return path.join(sessionMemoryDir(sessionName), "task-contract.md");
}

function sessionTaskContractJsonPath(sessionName) {
    return path.join(sessionMemoryDir(sessionName), "task-contract.json");
}

/**
 * Base directory for session run artifacts.
 * Override with OPENCODE_RUN_ROOT for testing.
 */
function runRoot() {
    const override = (process.env.OPENCODE_RUN_ROOT || "").trim();
    if (override) return override;
    return path.join(repoRoot(), "tmp", "agent-runs");
}

function sessionRunDir(sessionName) {
    return path.join(runRoot(), sessionName);
}

function sessionRunSubdir(sessionName, name) {
    return path.join(sessionRunDir(sessionName), name);
}

function sessionRunManifestPath(sessionName) {
    return path.join(sessionRunDir(sessionName), "manifest.json");
}

function workstreamIndexPath(workstreamName) {
    return path.join(workstreamDir(workstreamName), "index.json");
}

function workstreamLockPath(workstreamName) {
    return path.join(workstreamDir(workstreamName), ".workstream.lock");
}

function workstreamFilePath(workstreamName, target) {
    const config = WORKSTREAM_TARGETS[target];
    if (!config) {
        throw new StateError(`Unsupported workstream memory target: ${target}`);
    }
    return path.join(workstreamDir(workstreamName), config.filename);
}

function localCoordinatorRoot() {
    // Opt-in isolation override (mirrors OPENCODE_STATE_ROOT / OPENCODE_RUN_ROOT):
    // when set, the ENTIRE .local/coordinator/ subtree (tasks + reports +
    // dashboards + scratch) resolves against this root instead of the real repo.
    // Used by verification scripts (verify-task-registry.js et al.) to redirect
    // their fixture cards to an isolated temp dir so a fixture can NEVER leak
    // into the real coordinator registry — even on interruption. Empty/absent
    // preserves the default repo-rooted behavior for every other caller.
    const override = (process.env.OPENCODE_LOCAL_COORDINATOR_ROOT || "").trim();
    if (override) return override;
    return path.join(repoRoot(), ".local", "coordinator");
}

function localCoordinatorTasksRoot() {
    return path.join(localCoordinatorRoot(), "tasks");
}

function localCoordinatorReportsRoot() {
    return path.join(localCoordinatorRoot(), "reports");
}

function localCoordinatorDashboardsRoot() {
    return path.join(localCoordinatorRoot(), "dashboards");
}

function localCoordinatorScratchRoot() {
    return path.join(localCoordinatorRoot(), "scratch");
}

/**
 * Returns the path to .local/cleared-assumptions.yaml.
 * Override with OPENCODE_CLEARED_ASSUMPTIONS_PATH for testing.
 */
function clearedAssumptionsPath() {
    const override = (process.env.OPENCODE_CLEARED_ASSUMPTIONS_PATH || "").trim();
    if (override) return override;
    return path.join(repoRoot(), ".local", "cleared-assumptions.yaml");
}

/**
 * Simple line-based parser for the constrained YAML shape.
 * Parses arrays of flat objects with keys: scope, claim, cleared_at, note
 * Returns array of objects, or empty array on any error.
 */
function parseClearedAssumptionsYaml(content) {
    if (!content || !content.trim()) return [];
    const lines = content.split("\n");
    const entries = [];
    let current = null;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        // Skip comments and empty lines
        if (!line || line.startsWith("#")) continue;

        if (line === "-") {
            // New item with no inline key — start new object
            if (current) entries.push(current);
            current = {};
            continue;
        }

        if (line.startsWith("- ")) {
            // New item with inline key: value
            if (current) entries.push(current);
            current = {};
            const rest = line.slice(2).trim();
            const colonIdx = rest.indexOf(":");
            if (colonIdx > 0) {
                const key = rest.slice(0, colonIdx).trim();
                const val = rest.slice(colonIdx + 1).trim();
                if (val.startsWith('"') && val.endsWith('"')) {
                    current[key] = val.slice(1, -1);
                } else {
                    current[key] = val;
                }
            }
            continue;
        }

        // Continuation key: value for current item
        if (current) {
            const colonIdx = line.indexOf(":");
            if (colonIdx > 0) {
                const key = line.slice(0, colonIdx).trim();
                const val = line.slice(colonIdx + 1).trim();
                if (val.startsWith('"') && val.endsWith('"')) {
                    current[key] = val.slice(1, -1);
                } else {
                    current[key] = val;
                }
            }
        }
    }
    if (current) entries.push(current);
    return entries.filter(e => e.scope && e.claim && e.cleared_at);
}

/**
 * Loads cleared assumptions from .local/cleared-assumptions.yaml.
 * Returns array of {scope, claim, cleared_at, note} or empty array.
 */
function loadClearedAssumptions() {
    const yamlPath = clearedAssumptionsPath();
    try {
        const content = fs.readFileSync(yamlPath, "utf-8");
        return parseClearedAssumptionsYaml(content);
    } catch {
        return [];
    }
}

/**
 * Merge existing cleared assumptions with canonical-source entries.
 * Canonical (YAML) entries take precedence by scope key.
 */
function mergeClearedAssumptions(existing, canonical) {
    if (!canonical || canonical.length === 0) return existing || [];
    if (!existing || existing.length === 0) return canonical;
    const byScope = new Map();
    for (const entry of existing) {
        if (entry.scope) byScope.set(entry.scope, entry);
    }
    for (const entry of canonical) {
        if (entry.scope) byScope.set(entry.scope, entry);
    }
    return Array.from(byScope.values());
}

function coordinationTaskPath(taskID) {
    return path.join(
        localCoordinatorTasksRoot(),
        `${normalizeCoordinationTaskId(taskID)}.json`,
    );
}

function coordinationTaskLockPath(taskID) {
    return path.join(
        localCoordinatorTasksRoot(),
        `.${normalizeCoordinationTaskId(taskID)}.lock`,
    );
}

function coordinationTaskReportDir(taskID) {
    return path.join(
        localCoordinatorReportsRoot(),
        normalizeCoordinationTaskId(taskID),
    );
}

function defaultBinding(sessionID, options = {}) {
    return {
        schema_version: SCHEMA_VERSION,
        session_id: sessionID,
        session_name: options.sessionName || null,
        active_workstream: options.activeWorkstream || null,
        parent_session_id: options.parentSessionID || null,
        cwd: options.cwd || hostCwd(),
        created_at: options.createdAt || isoZ(),
        updated_at: options.updatedAt || isoZ(),
        last_seen_at: isoZ(),
    };
}

function defaultSessionIndex(sessionName) {
    return {
        schema_version: SCHEMA_VERSION,
        session_name: sessionName,
        cwd: hostCwd(),
        created_at: isoZ(),
        updated_at: isoZ(),
        adopted_plan_id: null,
        session_ids: [],
        plans: [],
    };
}

function defaultWorkstreamIndex(workstreamName) {
    return {
        schema_version: SCHEMA_VERSION,
        workstream_name: workstreamName,
        created_at: isoZ(),
        updated_at: isoZ(),
        session_ids: [],
        session_names: [],
    };
}

function defaultArtifactsPayload(sessionName, manifestPath) {
    return {
        schema_version: SCHEMA_VERSION,
        session_name: sessionName,
        manifest_path: relativeToRepo(manifestPath),
        updated_at: isoZ(),
        artifacts: [],
    };
}

function defaultRunManifest(sessionName) {
    return {
        schema_version: SCHEMA_VERSION,
        session_name: sessionName,
        run_dir: relativeToRepo(sessionRunDir(sessionName)),
        updated_at: isoZ(),
        artifacts: [],
    };
}

function defaultTaskContractPayload(sessionName) {
    return {
        schema_version: SCHEMA_VERSION,
        session_name: sessionName,
        version: 0,
        created_at: null,
        updated_at: null,
        mission: "",
        user_requirements: "",
        must_read: [],
        must_do: [],
        must_not_do: [],
        required_outputs: [],
        final_response_format: "",
        required_commands: [],
        completion_checklist: [],
        notes: [],
        cleared_assumptions: [],
    };
}

function defaultCoordinationTaskPayload(taskID = "") {
    return {
        schema_version: SCHEMA_VERSION,
        task_id: taskID,
        title: "",
        task_type: "",
        coordination_mode: "",
        primary_lane: "",
        research_question: "",
        source_policy: null,
        source_allowlist: [],
        desired_artifact_type: null,
        target_artifact_path: null,
        rough_scope: [],
        open_questions: [],
        ready_criteria: [],
        files_in_scope: [],
        constraints: [],
        non_goals: [],
        success_criteria: [],
        validation_plan: [],
        report_envelope: "",
        backlog_id: null,
        workstream_slug: null,
        dependencies: [],
        owner_notes: [],
        status: "draft",
        session_aliases: [],
        active_session_alias: null,
        claimed_at: null,
        report_paths: [],
        review_paths: [],
        latest_report: null,
        f3_design_readiness: null,
        // Retention-preservation gate (owner-approved 2026-10-25; v3
        // item-enumerated 2026-10-27): the decision_record declared at
        // closeout — the BASELINE item inventory the retirement gate
        // verifies. null until the first closeout (legacy cards predating
        // the gate stay null and retire under the legacy compatibility
        // rule, not the new gate).
        decision_record: null,
        next_action: "",
        predicted_impact: null,
        measured_outcome: null,
        last_review: null,
        history: [],
        created_at: null,
        updated_at: null,
    };
}

function readTextIfExists(targetPath) {
    return fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
}

function defaultScopedMarkdown(targets, target) {
    if (target === "open_questions") {
        return "# Open Questions\n\n- (none)\n";
    }
    const config = targets[target];
    if (!config) {
        throw new StateError(`Unsupported memory target: ${target}`);
    }
    return `# ${config.title}\n\n`;
}

function renderScopedMarkdown(targets, target, body) {
    const normalizedBody = String(body || "").trim();
    if (!normalizedBody) {
        return defaultScopedMarkdown(targets, target);
    }
    if (normalizedBody.startsWith("#")) {
        return `${normalizedBody}\n`;
    }
    const config = targets[target];
    return `# ${config.title}\n\n${normalizedBody}\n`;
}

function defaultMemoryMarkdown(target) {
    return defaultScopedMarkdown(MEMORY_TARGETS, target);
}

function renderMemoryMarkdown(target, body) {
    return renderScopedMarkdown(MEMORY_TARGETS, target, body);
}

function defaultWorkstreamMarkdown(target) {
    return defaultScopedMarkdown(WORKSTREAM_TARGETS, target);
}

function renderWorkstreamMarkdown(target, body) {
    return renderScopedMarkdown(WORKSTREAM_TARGETS, target, body);
}

function stripScopedMarkdownContainer(targets, target, markdown) {
    const config = targets[target];
    if (!config) {
        throw new StateError(`Unsupported memory target: ${target}`);
    }
    const lines = stripFrontmatter(String(markdown || ""))
        .split("\n")
        .map((line) => line.trimEnd());
    const expectedHeading = `# ${config.title}`;

    while (lines.length && !String(lines[0] || "").trim()) {
        lines.shift();
    }
    if (String(lines[0] || "").trim() === expectedHeading) {
        lines.shift();
    }
    while (lines.length && !String(lines[0] || "").trim()) {
        lines.shift();
    }
    while (
        lines.length &&
        /^[-*]\s+\(none\)\s*$/i.test(String(lines[0] || "").trim())
    ) {
        lines.shift();
    }
    while (lines.length && !String(lines[0] || "").trim()) {
        lines.shift();
    }
    return lines.join("\n").trim();
}

function summarizeScopedMarkdown(targets, target, markdown, maxLines = 8) {
    return stripScopedMarkdownContainer(targets, target, markdown)
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .slice(0, maxLines)
        .join("\n")
        .trim();
}

function hasMeaningfulScopedMarkdown(targets, target, markdown) {
    return Boolean(stripScopedMarkdownContainer(targets, target, markdown));
}

function formatAppendedScopedMarkdownBlock(body, title = "") {
    const normalizedBody = stripFrontmatter(String(body || "")).trim();
    if (!normalizedBody) {
        throw new StateError(
            "Workstream append body is empty. Refuse to append an empty note.",
        );
    }
    const heading = String(title || "").trim();
    if (!heading) {
        return `${normalizedBody}\n`;
    }
    return `## ${heading}\n\n${normalizedBody}\n`;
}

function appendScopedMarkdown(targets, target, markdown, body, title = "") {
    const config = targets[target];
    if (!config) {
        throw new StateError(`Unsupported memory target: ${target}`);
    }
    const block = formatAppendedScopedMarkdownBlock(body, title).trimEnd();
    if (!hasMeaningfulScopedMarkdown(targets, target, markdown)) {
        return `# ${config.title}\n\n${block}\n`;
    }
    return `${String(markdown || "").trimEnd()}\n\n${block}\n`;
}

function defaultTaskContractMarkdown() {
    const lines = ["# Task Contract", ""];
    for (const field of TASK_CONTRACT_SECTION_ORDER) {
        lines.push(`## ${TASK_CONTRACT_SECTION_LABELS[field]}`);
        lines.push("");
        if (TASK_CONTRACT_LIST_FIELDS.has(field)) {
            lines.push("- (none)");
            lines.push("");
            continue;
        }
        lines.push("");
    }
    return `${lines.join("\n").trimEnd()}\n`;
}

function normalizeTaskContractHeading(label) {
    return (
        TASK_CONTRACT_SECTION_ALIASES[
            String(label || "")
                .trim()
                .toLowerCase()
        ] || null
    );
}

function normalizeTaskContractList(lines) {
    return (lines || [])
        .map((line) =>
            String(line || "")
                .replace(/^\s*[-*]\s+/, "")
                .replace(/^\s*\d+\.\s+/, "")
                .trim(),
        )
        .filter((line) => line && line !== "(none)");
}

function normalizeTaskContractSection(field, lines) {
    if (TASK_CONTRACT_LIST_FIELDS.has(field)) {
        return normalizeTaskContractList(lines);
    }
    return String((lines || []).join("\n").trim());
}

function taskContractHasContent(payload) {
    if (!payload) {
        return false;
    }
    return TASK_CONTRACT_SECTION_ORDER.some((field) => {
        if (TASK_CONTRACT_TEXT_FIELDS.has(field)) {
            return Boolean(payload[field]);
        }
        if (TASK_CONTRACT_LIST_FIELDS.has(field)) {
            return Array.isArray(payload[field]) && payload[field].length > 0;
        }
        return false;
    });
}

function parseTaskContractMarkdown(markdown) {
    const payload = defaultTaskContractPayload("");
    const body = stripFrontmatter(markdown);
    const lines = String(body || "").split("\n");
    let currentField = null;
    let buffer = [];

    const flush = () => {
        if (!currentField) {
            buffer = [];
            return;
        }
        payload[currentField] = normalizeTaskContractSection(
            currentField,
            buffer,
        );
        buffer = [];
    };

    for (const rawLine of lines) {
        const line = String(rawLine || "");
        if (/^#\s+Task Contract\b/i.test(line.trim())) {
            continue;
        }
        const headingMatch = line.match(/^##\s+(.+?)\s*$/);
        if (headingMatch) {
            flush();
            currentField = normalizeTaskContractHeading(headingMatch[1]);
            continue;
        }
        if (currentField) {
            buffer.push(line);
        }
    }
    flush();
    return payload;
}

function renderTaskContractBody(body) {
    const normalizedBody = stripFrontmatter(String(body || "")).trim();
    if (!normalizedBody) {
        throw new StateError(
            "Task contract body is empty. Refuse to save an empty task contract.",
        );
    }
    if (normalizedBody.startsWith("#")) {
        return `${normalizedBody}\n`;
    }
    return `# Task Contract\n\n${normalizedBody}\n`;
}

function formatTaskContractMarkdown({
    sessionName,
    version,
    createdAt,
    updatedAt,
    cwd,
    sessionID,
    body,
}) {
    return [
        "---",
        "kind: task_contract",
        `session_name: ${yamlScalar(sessionName)}`,
        `version: ${yamlScalar(version)}`,
        `created_at: ${yamlScalar(createdAt)}`,
        `updated_at: ${yamlScalar(updatedAt)}`,
        `cwd: ${yamlScalar(cwd)}`,
        `session_id: ${yamlScalar(sessionID)}`,
        "---",
        "",
        renderTaskContractBody(body).trimEnd(),
        "",
    ].join("\n");
}

function summarizeTextBlock(text, maxLines = 4) {
    return String(text || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, maxLines)
        .join("\n")
        .trim();
}

function summarizeStructuredTextBlock(text, maxLines = 8) {
    return String(text || "")
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.trim())
        .slice(0, maxLines)
        .join("\n")
        .trim();
}

function summarizeTaskContract(payload, options = {}) {
    if (!taskContractHasContent(payload)) {
        return "";
    }
    const maxListItems = options.maxListItems || 3;
    const sections = [];
    if (payload.mission) {
        sections.push(`Mission:\n${summarizeTextBlock(payload.mission, 4)}`);
    }
    if (payload.user_requirements) {
        sections.push(
            `User requirements:\n${summarizeTextBlock(payload.user_requirements, 5)}`,
        );
    }
    if (payload.final_response_format) {
        sections.push(
            `Final response format:\n${summarizeStructuredTextBlock(
                payload.final_response_format,
                12,
            )}`,
        );
    }
    for (const field of [
        "must_read",
        "must_do",
        "must_not_do",
        "required_outputs",
        "required_commands",
        "completion_checklist",
    ]) {
        const items = Array.isArray(payload[field]) ? payload[field] : [];
        if (!items.length) {
            continue;
        }
        sections.push(
            `${TASK_CONTRACT_SECTION_LABELS[field]}:\n${items
                .slice(0, maxListItems)
                .map((item) => `- ${item}`)
                .join("\n")}`,
        );
    }
    if (Array.isArray(payload.notes) && payload.notes.length) {
        sections.push(
            `Notes:\n${payload.notes
                .slice(0, maxListItems)
                .map((item) => `- ${item}`)
                .join("\n")}`,
        );
    }
    return sections.join("\n\n").trim();
}

function mergeMissingTaskContractFields(primary, fallback) {
    const merged = { ...primary };
    let changed = false;

    for (const field of TASK_CONTRACT_SECTION_ORDER) {
        if (TASK_CONTRACT_TEXT_FIELDS.has(field)) {
            const current = String(merged[field] || "").trim();
            const replacement = String(fallback[field] || "").trim();
            if (!current && replacement) {
                merged[field] = fallback[field];
                changed = true;
            }
            continue;
        }
        if (!TASK_CONTRACT_LIST_FIELDS.has(field)) {
            continue;
        }
        const currentItems = Array.isArray(merged[field]) ? merged[field] : [];
        const replacementItems = Array.isArray(fallback[field])
            ? fallback[field]
            : [];
        if (!currentItems.length && replacementItems.length) {
            merged[field] = [...replacementItems];
            changed = true;
        }
    }

    return { merged, changed };
}

function loadTaskContractPayload(sessionName) {
    const markdownPath = sessionTaskContractPath(sessionName);
    const fallbackPayload = fs.existsSync(markdownPath)
        ? parseTaskContractMarkdown(
              parseFrontmatter(fs.readFileSync(markdownPath, "utf8")).body,
          )
        : null;
    const jsonPath = sessionTaskContractJsonPath(sessionName);
    // Hoist: load canonical cleared assumptions once for all branches
    const cleared = loadClearedAssumptions();

    if (fs.existsSync(jsonPath)) {
        const payload = readJson(
            jsonPath,
            defaultTaskContractPayload(sessionName),
        );
        const normalized = {
            ...defaultTaskContractPayload(sessionName),
            ...payload,
            session_name: sessionName,
        };
        // Merge cleared assumptions (canonical YAML takes precedence by scope)
        normalized.cleared_assumptions = mergeClearedAssumptions(
            normalized.cleared_assumptions || [], cleared,
        );
        if (fallbackPayload) {
            const backfilled = mergeMissingTaskContractFields(
                normalized,
                fallbackPayload,
            );
            if (backfilled.changed) {
                atomicWriteJson(jsonPath, backfilled.merged);
            }
            return backfilled.merged;
        }
        return normalized;
    }
    if (fs.existsSync(markdownPath)) {
        const parsed = parseFrontmatter(fs.readFileSync(markdownPath, "utf8"));
        const payload = {
            ...defaultTaskContractPayload(sessionName),
            ...parseTaskContractMarkdown(parsed.body),
            session_name: sessionName,
            version: Number(parsed.frontmatter.version || 0) || 0,
            created_at: parsed.frontmatter.created_at || null,
            updated_at: parsed.frontmatter.updated_at || null,
        };
        // Merge cleared assumptions (canonical YAML takes precedence by scope)
        payload.cleared_assumptions = mergeClearedAssumptions(
            payload.cleared_assumptions || [], cleared,
        );
        atomicWriteJson(jsonPath, payload);
        return payload;
    }
    const def = defaultTaskContractPayload(sessionName);
    def.cleared_assumptions = cleared;
    return def;
}

function normalizeRepoPath(inputPath) {
    const text = String(inputPath || "").trim();
    if (!text) {
        throw new StateError("Path is required.");
    }
    if (path.isAbsolute(text)) {
        return text;
    }
    return path.join(repoRoot(), text);
}

function storePathForRepo(targetPath) {
    const absolute = path.resolve(targetPath);
    return absolute.startsWith(`${repoRoot()}${path.sep}`)
        ? relativeToRepo(absolute)
        : absolute;
}

function normalizeCoordinationTaskId(value) {
    return slugify(value);
}

function uniqueStrings(values) {
    const seen = new Set();
    const normalized = [];
    for (const value of values) {
        if (!seen.has(value)) {
            seen.add(value);
            normalized.push(value);
        }
    }
    return normalized;
}

function normalizeStringList(values) {
    if (values === undefined || values === null) {
        return [];
    }
    const list = Array.isArray(values) ? values : [values];
    return uniqueStrings(
        list
            .map((value) => String(value || "").trim())
            .filter(Boolean),
    );
}

function normalizeFileScope(values) {
    if (values === undefined || values === null) {
        return [];
    }
    const list = Array.isArray(values) ? values : [values];
    return uniqueStrings(
        list
            .map((value) => String(value || "").trim())
            .filter(Boolean)
            .map((value) => storePathForRepo(normalizeRepoPath(value))),
    );
}

function normalizeCoordinationEnum(rawValue, allowedValues, fieldName) {
    const value = String(rawValue || "")
        .trim()
        .toLowerCase();
    if (!value) {
        return "";
    }
    if (!allowedValues.includes(value)) {
        throw new StateError(
            `${fieldName} must be one of: ${allowedValues.join(", ")}.`,
        );
    }
    return value;
}

/**
 * Non-throwing variant of normalizeCoordinationEnum for use inside multi-field
 * collection blocks. On invalid input it pushes a single message into `errors`
 * (same text the throw path used) and returns "" so the surrounding object
 * construction can continue without short-circuiting.
 *
 * When the optional `enumInvalidFields` Set is supplied, an invalid-but-provided
 * value also records `fieldName` in it. Downstream core-field "required" checks
 * consult that set to avoid emitting a spurious derived "X is required." error
 * for a field whose real problem is an invalid enum value (a provided-but-invalid
 * field is NOT missing).
 *
 * @param {string} rawValue
 * @param {string[]} allowedValues
 * @param {string} fieldName
 * @param {string[]} errors - accumulator; mutated in place
 * @param {Set<string>} [enumInvalidFields] - optional accumulator; mutated in place
 * @returns {string} normalized value ("" when empty or invalid)
 */
function normalizeCoordinationEnumCollected(
    rawValue,
    allowedValues,
    fieldName,
    errors,
    enumInvalidFields,
) {
    const value = String(rawValue || "")
        .trim()
        .toLowerCase();
    if (!value) {
        return "";
    }
    if (!allowedValues.includes(value)) {
        errors.push(`${fieldName} must be one of: ${allowedValues.join(", ")}.`);
        if (enumInvalidFields && typeof enumInvalidFields.add === "function") {
            enumInvalidFields.add(fieldName);
        }
        return "";
    }
    return value;
}

function normalizeOptionalText(rawValue) {
    const value = String(rawValue || "").trim();
    return value || null;
}

function normalizeOptionalSlug(rawValue) {
    const value = String(rawValue || "").trim();
    return value ? slugify(value) : null;
}

function normalizeOptionalWorkstream(rawValue) {
    const value = String(rawValue || "").trim();
    return value ? normalizeWorkstreamName(value) : null;
}

function defaultReportEnvelopeForMode(mode) {
    return DEFAULT_REPORT_ENVELOPE_BY_MODE[mode] || "standard";
}

function generateCoordinationTaskId(title) {
    return `task-${planTimestamp()}-${slugify(title || "task")}`;
}

function ensureLocalCoordinatorNamespace() {
    ensureDir(localCoordinatorRoot());
    ensureDir(localCoordinatorTasksRoot());
    ensureDir(localCoordinatorReportsRoot());
    ensureDir(localCoordinatorDashboardsRoot());
    ensureDir(localCoordinatorScratchRoot());
    ensureDir(localCoordinatorSkillProposalsRoot());
}

function normalizeStoredCoordinationReview(
    sourceLastReview,
    reviewPaths,
    accumulators = {},
) {
    const raw =
        sourceLastReview && typeof sourceLastReview === "object"
            ? sourceLastReview
            : null;
    const explicitPath =
        raw && raw.path
            ? storePathForRepo(normalizeRepoPath(raw.path))
            : "";
    const fallbackPath = reviewPaths.length
        ? reviewPaths[reviewPaths.length - 1]
        : "";
    const storedPath = explicitPath || fallbackPath;
    let parsed = null;
    if (storedPath) {
        try {
            parsed = parseCoordinationReview(storedPath, {
                includeBody: false,
            });
        } catch {
            parsed = null;
        }
    }
    const sessionName =
        raw &&
        raw.session_name !== undefined &&
        raw.session_name !== null
            ? String(raw.session_name).trim()
            : parsed?.frontmatter?.session_name
              ? String(parsed.frontmatter.session_name).trim()
              : null;
    // Read-path enum normalization must be fault-tolerant: a bad stored
    // last_review.status coerces to "" (then null) instead of throwing, so a
    // single degraded review block cannot brick listCoordinationTasks() or
    // any load-based op. Collected messages flow into the caller-provided
    // accumulators when present (so the read-path scan can surface them as
    // quarantine diagnostics); the save path remains the strict authority
    // for INPUT and never passes accumulators here.
    const reviewEnumErrors = accumulators.enumErrors || [];
    const reviewEnumInvalidFields =
        accumulators.enumInvalidFields || new Set();
    const normalized = {
        path: storedPath,
        reviewed_at: (raw && raw.reviewed_at) || parsed?.reviewed_at || null,
        session_name: sessionName || null,
        title: String((raw && raw.title) || parsed?.title || "").trim(),
        status:
            normalizeCoordinationEnumCollected(
                (raw && raw.status) || parsed?.status,
                [
                    "ready",
                    "working",
                    "reported",
                    "blocked",
                    "completed",
                    "cancelled",
                ],
                "last_review.status",
                reviewEnumErrors,
                reviewEnumInvalidFields,
            ) || null,
        summary: String((raw && raw.summary) || parsed?.summary || "").trim(),
        next_action: String(
            (raw && raw.next_action) || parsed?.next_action || "",
        ).trim(),
    };
    if (
        !normalized.path &&
        !normalized.reviewed_at &&
        !normalized.title &&
        !normalized.status &&
        !normalized.summary &&
        !normalized.next_action
    ) {
        return null;
    }
    if (
        !normalized.path ||
        !normalized.reviewed_at ||
        !normalized.title ||
        !normalized.status
    ) {
        return null;
    }
    return normalized;
}

function normalizeCoordinationTaskRecord(payload, taskID = "", accumulators = {}) {
    const source = payload && typeof payload === "object" ? payload : {};
    const normalizedTaskID = normalizeCoordinationTaskId(
        source.task_id || taskID || "",
    );
    // Read/normalize path must be fault-tolerant where the save path is
    // strict: route every enum field through the collected (non-throwing)
    // validator so a single card with a bad stored enum value cannot brick
    // listCoordinationTasks() and every load-based op that depends on it
    // (read, activate, ready, update, repair, review, saveCloseout). A bad
    // value coerces to "" and the per-field default applies. Collected
    // messages and offending-field names flow into the caller-provided
    // accumulators when present (so the read-path scan can surface them as
    // quarantine diagnostics without re-reading the raw stored bytes); when
    // absent (every write-path caller) they are local throwaways and the
    // save path remains the authority that rejects bad INPUT — the read
    // path only tolerates what is on disk.
    const readEnumErrors = accumulators.enumErrors || [];
    const enumInvalidFields =
        accumulators.enumInvalidFields || new Set();
    let normalizedStatus =
        normalizeCoordinationEnumCollected(
            source.status,
            COORDINATION_TASK_STATUSES,
            "status",
            readEnumErrors,
            enumInvalidFields,
        ) || "draft";
    const sessionAliases = uniqueStrings(
        normalizeStringList(source.session_aliases).map((value) =>
            normalizeSessionName(value),
        ),
    );
    let activeSessionAlias = source.active_session_alias
        ? normalizeSessionName(source.active_session_alias)
        : null;
    let claimedAt = source.claimed_at || null;
    if (normalizedStatus === "working") {
        if (!activeSessionAlias && sessionAliases.length === 1) {
            activeSessionAlias = sessionAliases[0];
        }
        if (!claimedAt) {
            claimedAt = source.updated_at || source.created_at || null;
        }
        if (!activeSessionAlias || !claimedAt) {
            normalizedStatus = "ready";
            activeSessionAlias = null;
            claimedAt = null;
        }
    }
    const coordinationMode = normalizeCoordinationEnumCollected(
        source.coordination_mode,
        COORDINATION_MODES,
        "coordination_mode",
        readEnumErrors,
        enumInvalidFields,
    );
    const reportEnvelope =
        normalizeCoordinationEnumCollected(
            source.report_envelope,
            COORDINATION_REPORT_ENVELOPES,
            "report_envelope",
            readEnumErrors,
            enumInvalidFields,
        ) || defaultReportEnvelopeForMode(coordinationMode);
    return {
        ...defaultCoordinationTaskPayload(normalizedTaskID),
        ...source,
        task_id: normalizedTaskID,
        title: String(source.title || "").trim(),
        task_type: normalizeCoordinationEnumCollected(
            source.task_type,
            COORDINATION_TASK_TYPES,
            "task_type",
            readEnumErrors,
            enumInvalidFields,
        ),
        coordination_mode: coordinationMode,
        primary_lane: String(source.primary_lane || "").trim(),
        research_question: String(source.research_question || "").trim(),
        source_policy:
            normalizeCoordinationEnumCollected(
                source.source_policy,
                RESEARCH_SOURCE_POLICIES,
                "source_policy",
                readEnumErrors,
                enumInvalidFields,
            ) || null,
        source_allowlist: normalizeStringList(source.source_allowlist),
        desired_artifact_type:
            normalizeCoordinationEnumCollected(
                source.desired_artifact_type,
                RESEARCH_ARTIFACT_TYPES,
                "desired_artifact_type",
                readEnumErrors,
                enumInvalidFields,
            ) || null,
        target_artifact_path: normalizeOptionalText(source.target_artifact_path),
        rough_scope: normalizeStringList(source.rough_scope),
        open_questions: normalizeStringList(source.open_questions),
        ready_criteria: normalizeStringList(source.ready_criteria),
        files_in_scope: normalizeFileScope(source.files_in_scope),
        constraints: normalizeStringList(source.constraints),
        non_goals: normalizeStringList(source.non_goals),
        success_criteria: normalizeStringList(source.success_criteria),
        validation_plan: normalizeStringList(source.validation_plan),
        report_envelope: reportEnvelope,
        backlog_id: normalizeOptionalText(source.backlog_id),
        workstream_slug: normalizeOptionalWorkstream(source.workstream_slug),
        dependencies: normalizeStringList(source.dependencies),
        owner_notes: normalizeStringList(source.owner_notes),
        status: normalizedStatus,
        session_aliases: sessionAliases,
        active_session_alias: activeSessionAlias,
        claimed_at: claimedAt,
        report_paths: uniqueStrings(
            normalizeStringList(source.report_paths).map((value) =>
                storePathForRepo(normalizeRepoPath(value)),
            ),
        ),
        review_paths: uniqueStrings(
            normalizeStringList(source.review_paths).map((value) =>
                storePathForRepo(normalizeRepoPath(value)),
            ),
        ),
        latest_report:
            source.latest_report && typeof source.latest_report === "object"
                ? {
                      path: source.latest_report.path
                          ? storePathForRepo(
                                normalizeRepoPath(source.latest_report.path),
                            )
                          : "",
                      title: String(source.latest_report.title || "").trim(),
                      status:
                          normalizeCoordinationEnumCollected(
                              source.latest_report.status,
                              [...COORDINATION_CLOSEOUT_STATUSES],
                              "latest_report.status",
                              readEnumErrors,
                              enumInvalidFields,
                          ) || null,
                      report_envelope:
                          normalizeCoordinationEnumCollected(
                              source.latest_report.report_envelope,
                              COORDINATION_REPORT_ENVELOPES,
                              "latest_report.report_envelope",
                              readEnumErrors,
                              enumInvalidFields,
                          ) || null,
                      created_at: source.latest_report.created_at || null,
                      summary: String(source.latest_report.summary || "").trim(),
                      promotion_recommended: Boolean(
                          source.latest_report.promotion_recommended,
                      ),
                  }
                : null,
        f3_design_readiness:
            source.f3_design_readiness === null ||
            source.f3_design_readiness === undefined
                ? null
                : typeof source.f3_design_readiness === "object" &&
                    !Array.isArray(source.f3_design_readiness)
                  ? source.f3_design_readiness
                  : null,
        // Retention-preservation gate: lenient read-path normalization. A
        // stored decision_record must be an object carrying an entries array;
        // anything else (legacy cards have NO field at all → undefined →
        // null) coerces to null so the retirement path treats it as the
        // legacy compatibility case rather than crashing on a degraded shape.
        decision_record: normalizeStoredDecisionRecord(source.decision_record),
        next_action: String(source.next_action || "").trim(),
        predicted_impact: normalizeOptionalText(source.predicted_impact),
        measured_outcome: normalizeOptionalText(source.measured_outcome),
        last_review: normalizeStoredCoordinationReview(
            source.last_review,
            uniqueStrings(
                normalizeStringList(source.review_paths).map((value) =>
                    storePathForRepo(normalizeRepoPath(value)),
                ),
            ),
            {
                enumErrors: readEnumErrors,
                enumInvalidFields,
            },
        ),
        history: Array.isArray(source.history)
            ? source.history
                  .filter((entry) => entry && typeof entry === "object")
                  .map((entry) => ({ ...entry }))
            : [],
        created_at: source.created_at || null,
        updated_at: source.updated_at || null,
    };
}

/**
 * Collect every core-field validation problem for a coordination task record
 * without short-circuiting on the first failure. Preserves the exact same
 * rules and message text as the original fail-fast validator, only the
 * throw cadence changes (one collected throw at the end vs many throws).
 *
 * `options.enumInvalidFields` carries the set of field names whose value was
 * provided-but-invalid-enum. For those fields the "required"/"missing" check is
 * suppressed: a provided-but-invalid field is NOT missing, so a derived
 * "X is required." error would be a false duplicate of the enum error already
 * collected upstream. This keeps single-invalid-enum payloads at exactly one
 * error (the raw enum message) while multi-error aggregation still fires for
 * genuinely independent problems.
 *
 * `options.offendingFields`, when provided, is populated (mutated in place)
 * with the field names implicated by every problem collected here — both
 * missing-required fields and compound-condition fields. The read-path scan
 * uses this to build the quarantine entry's `offending_fields` list without
 * re-parsing the message strings. The save path never passes it.
 *
 * @param {object} task
 * @param {object} [options]
 * @param {boolean} [options.allowLegacyIncompleteResearch]
 * @param {Set<string>} [options.enumInvalidFields]
 * @param {Set<string>} [options.offendingFields]
 * @returns {string[]} collected error messages (empty when valid)
 */
function collectCoordinationTaskCoreFieldErrors(task, options = {}) {
    const errors = [];
    const enumInvalid = options.enumInvalidFields || new Set();
    const offendingFields = options.offendingFields || null;
    const markOffending = (...fieldNames) => {
        if (!offendingFields) {
            return;
        }
        for (const fieldName of fieldNames) {
            if (fieldName && typeof offendingFields.add === "function") {
                offendingFields.add(fieldName);
            }
        }
    };
    // True when the field has NO already-collected enum error of its own, i.e.
    // a missing/blank value here is a genuine missing-value problem rather
    // than a side effect of a failed enum normalization upstream.
    const isGenuinelyMissing = (field) => !enumInvalid.has(field);
    if (!task.title && isGenuinelyMissing("title")) {
        errors.push("Task title is required.");
        markOffending("title");
    }
    if (!task.task_type && isGenuinelyMissing("task_type")) {
        errors.push("task_type is required.");
        markOffending("task_type");
    }
    if (!task.coordination_mode && isGenuinelyMissing("coordination_mode")) {
        errors.push("coordination_mode is required.");
        markOffending("coordination_mode");
    }
    if (!task.primary_lane && isGenuinelyMissing("primary_lane")) {
        errors.push("primary_lane is required.");
        markOffending("primary_lane");
    }
    if (!task.status && isGenuinelyMissing("status")) {
        errors.push("status is required.");
        markOffending("status");
    }
    if (!task.report_envelope && isGenuinelyMissing("report_envelope")) {
        errors.push("report_envelope is required.");
        markOffending("report_envelope");
    }
    if (task.task_type === "research") {
        const missingResearchFields = missingResearchContractFields(task);
        const tolerateLegacyResearchGap =
            missingResearchFields.length &&
            options.allowLegacyIncompleteResearch === true;
        if (
            !tolerateLegacyResearchGap &&
            !task.research_question &&
            isGenuinelyMissing("research_question")
        ) {
            errors.push("Research tasks must define research_question.");
            markOffending("research_question");
        }
        if (
            !tolerateLegacyResearchGap &&
            !task.source_policy &&
            isGenuinelyMissing("source_policy")
        ) {
            errors.push("Research tasks must define source_policy.");
            markOffending("source_policy");
        }
        if (
            !tolerateLegacyResearchGap &&
            !task.desired_artifact_type &&
            isGenuinelyMissing("desired_artifact_type")
        ) {
            errors.push("Research tasks must define desired_artifact_type.");
            markOffending("desired_artifact_type");
        }
        if (
            !tolerateLegacyResearchGap &&
            !task.target_artifact_path &&
            isGenuinelyMissing("target_artifact_path")
        ) {
            errors.push("Research tasks must define target_artifact_path.");
            markOffending("target_artifact_path");
        }
    }
    if (task.status === "draft") {
        if (
            !(task.rough_scope || []).length &&
            !(task.open_questions || []).length &&
            !(task.ready_criteria || []).length
        ) {
            errors.push(
                "Draft tasks must capture rough_scope, open_questions, or ready_criteria before they can be saved.",
            );
            markOffending("rough_scope", "open_questions", "ready_criteria");
        }
        return errors;
    }
    if (task.status === "working") {
        if (!task.active_session_alias || !task.claimed_at) {
            errors.push(
                "Working tasks must record active_session_alias and claimed_at.",
            );
            markOffending("active_session_alias", "claimed_at");
        }
    }
    if (!(task.files_in_scope || []).length) {
        errors.push("files_in_scope must contain at least one path.");
        markOffending("files_in_scope");
    }
    if (!(task.success_criteria || []).length) {
        errors.push(
            "success_criteria must contain at least one requirement.",
        );
        markOffending("success_criteria");
    }
    if (!(task.validation_plan || []).length) {
        errors.push(
            "validation_plan must contain at least one verification step.",
        );
        markOffending("validation_plan");
    }
    if (task.latest_report) {
        if (
            !task.latest_report.path ||
            !task.latest_report.status ||
            !task.latest_report.report_envelope
        ) {
            errors.push(
                "latest_report is missing required path/status/report_envelope fields.",
            );
            markOffending("latest_report");
        }
    }
    if (task.last_review) {
        if (
            !task.last_review.path ||
            !task.last_review.reviewed_at ||
            !task.last_review.title ||
            !task.last_review.status
        ) {
            errors.push(
                "last_review is missing required path/reviewed_at/title/status fields.",
            );
            markOffending("last_review");
        }
    }
    return errors;
}

function ensureCoordinationTaskCoreFields(task, options = {}) {
    throwCollectedErrors(collectCoordinationTaskCoreFieldErrors(task, options));
}

// Canonical field-name ordering for quarantine diagnostics. Keeps the
// offending_fields list deterministic regardless of insertion order from
// the enum + core-field collectors, so two scans of the same degraded card
// produce byte-identical quarantine entries.
const COORDINATION_QUARANTINE_FIELD_ORDER = [
    "title",
    "task_type",
    "coordination_mode",
    "primary_lane",
    "status",
    "report_envelope",
    "research_question",
    "source_policy",
    "desired_artifact_type",
    "target_artifact_path",
    "source_allowlist",
    "rough_scope",
    "open_questions",
    "ready_criteria",
    "files_in_scope",
    "success_criteria",
    "validation_plan",
    "active_session_alias",
    "claimed_at",
    "latest_report",
    "latest_report.status",
    "latest_report.report_envelope",
    "last_review",
    "last_review.status",
];

function stableSortQuarantineFields(fieldNames) {
    const seen = new Set();
    const unique = [];
    for (const fieldName of fieldNames) {
        const value = String(fieldName || "");
        if (!value || seen.has(value)) {
            continue;
        }
        seen.add(value);
        unique.push(value);
    }
    return unique.sort((left, right) => {
        const leftRank = COORDINATION_QUARANTINE_FIELD_ORDER.indexOf(left);
        const rightRank = COORDINATION_QUARANTINE_FIELD_ORDER.indexOf(right);
        const leftIndex = leftRank === -1 ? COORDINATION_QUARANTINE_FIELD_ORDER.length : leftRank;
        const rightIndex = rightRank === -1 ? COORDINATION_QUARANTINE_FIELD_ORDER.length : rightRank;
        if (leftIndex !== rightIndex) {
            return leftIndex - rightIndex;
        }
        return left.localeCompare(right);
    });
}

/**
 * Normalize a coordination-task record AND preserve the validation findings
 * the read path used to discard. Returns a discriminated result alongside the
 * normalized record so callers (the scan boundary, the action boundary) can
 * surface degradation without mutating the persistent task DTO.
 *
 * `problems` is the deterministic union of enum-coercion messages and
 * core-field messages (enum first, in declaration order, then core-field in
 * validator order). `offendingFields` is the deduped, stably-sorted field-name
 * list a quarantine entry publishes. `degraded` is true iff `problems` is
 * non-empty.
 *
 * The fallback/coercion behavior of `normalizeCoordinationTaskRecord` is
 * UNCHANGED — a bad stored enum still coerces to "" (and the per-field default
 * applies) so read resilience is identical to before. This helper only stops
 * throwing away the evidence of the coercion.
 *
 * @param {object} payload - raw stored record (already JSON-parsed)
 * @param {string} [taskID]
 * @returns {{task: object, diagnostics: {problems: string[], offendingFields: string[], degraded: boolean}}}
 */
function normalizeCoordinationTaskRecordWithDiagnostics(payload, taskID = "") {
    const enumErrors = [];
    const enumInvalidFields = new Set();
    const task = normalizeCoordinationTaskRecord(payload, taskID, {
        enumErrors,
        enumInvalidFields,
    });
    const coreOffendingFields = new Set();
    const coreErrors = collectCoordinationTaskCoreFieldErrors(task, {
        allowLegacyIncompleteResearch: true,
        enumInvalidFields,
        offendingFields: coreOffendingFields,
    });
    const problems = [...enumErrors, ...coreErrors];
    const offendingFields = stableSortQuarantineFields([
        ...enumInvalidFields,
        ...coreOffendingFields,
    ]);
    return {
        task,
        diagnostics: {
            problems,
            offendingFields,
            degraded: problems.length > 0,
        },
    };
}

function coordinationActorContext(sessionID, options = {}) {
    const binding = ensureSessionBinding(sessionID, {
        cwd: options.cwd,
        allowUnbound: true,
    });
    return {
        session_id: sessionID,
        session_name: binding.session_name || null,
        active_workstream: binding.active_workstream || null,
        cwd: options.cwd || binding.cwd || hostCwd(),
    };
}

function scopePathsOverlap(left, right) {
    const normalizedLeft = String(left || "").replace(/\/+$/, "");
    const normalizedRight = String(right || "").replace(/\/+$/, "");
    if (!normalizedLeft || !normalizedRight) {
        return false;
    }
    return (
        normalizedLeft === normalizedRight ||
        normalizedLeft.startsWith(`${normalizedRight}/`) ||
        normalizedRight.startsWith(`${normalizedLeft}/`)
    );
}

function summarizeCoordinationTask(task) {
    return {
        task_id: task.task_id,
        title: task.title,
        task_type: task.task_type,
        coordination_mode: task.coordination_mode,
        primary_lane: task.primary_lane,
        research_question: task.research_question || "",
        source_policy: task.source_policy || null,
        source_allowlist: [...(task.source_allowlist || [])],
        desired_artifact_type: task.desired_artifact_type || null,
        target_artifact_path: task.target_artifact_path || null,
        status: task.status,
        report_envelope: task.report_envelope,
        backlog_id: task.backlog_id || null,
        workstream_slug: task.workstream_slug || null,
        rough_scope: [...(task.rough_scope || [])],
        open_questions: [...(task.open_questions || [])],
        ready_criteria: [...(task.ready_criteria || [])],
        files_in_scope: [...(task.files_in_scope || [])],
        session_aliases: [...(task.session_aliases || [])],
        active_session_alias: task.active_session_alias || null,
        claimed_at: task.claimed_at || null,
        report_count: (task.report_paths || []).length,
        review_count: (task.review_paths || []).length,
        latest_report: task.latest_report ? { ...task.latest_report } : null,
        last_review: task.last_review ? { ...task.last_review } : null,
        next_action: task.next_action || "",
        created_at: task.created_at || null,
        updated_at: task.updated_at || null,
    };
}

const RESEARCH_CONTRACT_FIELD_NAMES = [
    "research_question",
    "source_policy",
    "desired_artifact_type",
    "target_artifact_path",
];

const RESEARCH_REPAIRABLE_FIELD_NAMES = [
    "research_question",
    "source_policy",
    "source_allowlist",
    "desired_artifact_type",
    "target_artifact_path",
];

// Core identity/enum fields a DEGRADED card may need restored through
// /task-repair. This is the restorable identity/enum offender subset — the
// fields whose corruption degrades a card that the repair branch can fix in
// one request. The ordinary update allowlist
// (TASK_METADATA_UPDATE_*_FIELD_NAMES) deliberately never exposes
// task_type/status, so healthy-card task_type/status immutability is enforced
// elsewhere (by that allowlist). The repair carve-out is gated strictly on
// diagnostics.degraded === true AND restricted to fields that are CURRENTLY
// offending (restore-only — see repairDegradedCoordinationTaskCoreFields), so
// it cannot be used to move a healthy field (e.g. a non-offending status) and
// thereby bypass the lifecycle transition guard.
const DEGRADED_CORE_REPAIRABLE_FIELD_NAMES = [
    "task_type",
    "status",
    "coordination_mode",
    "report_envelope",
    "title",
    "primary_lane",
];

const TASK_METADATA_UPDATE_PRE_EXECUTION_FIELD_NAMES = [
    "title",
    "coordination_mode",
    "primary_lane",
    "research_question",
    "source_policy",
    "source_allowlist",
    "desired_artifact_type",
    "target_artifact_path",
    "rough_scope",
    "open_questions",
    "ready_criteria",
    "files_in_scope",
    "constraints",
    "non_goals",
    "success_criteria",
    "validation_plan",
    "report_envelope",
    "backlog_id",
    "workstream_slug",
    "dependencies",
    "owner_notes",
    "next_action",
    "predicted_impact",
];

const TASK_METADATA_UPDATE_WORKING_FIELD_NAMES = [
    "owner_notes",
    "next_action",
];

const TASK_METADATA_UPDATE_FOLLOW_UP_FIELD_NAMES = [
    "owner_notes",
    "next_action",
    "measured_outcome",
];

function missingResearchContractFields(task) {
    if (!task || task.task_type !== "research") {
        return [];
    }
    return RESEARCH_CONTRACT_FIELD_NAMES.filter((fieldName) => !task[fieldName]);
}

function unexpectedCoordinationTaskPayloadFields(payload, allowedFields) {
    return Object.keys(payload || {}).filter((key) => !allowedFields.includes(key));
}

/**
 * Collect (without throwing) the payload-field validation problem, if any.
 * Returns an array of 0 or 1 message so it composes with other collectors.
 *
 * @param {object} payload
 * @param {string[]} allowedFields
 * @param {string} operationName
 * @returns {string[]}
 */
function unexpectedCoordinationTaskPayloadFieldsErrors(payload, allowedFields, operationName) {
    const unexpected = unexpectedCoordinationTaskPayloadFields(
        payload,
        allowedFields,
    );
    if (unexpected.length) {
        return [
            `Unsupported fields for ${operationName}: ${unexpected.join(", ")}.`,
        ];
    }
    return [];
}

function assertAllowedCoordinationTaskPayloadFields(
    payload,
    allowedFields,
    operationName,
) {
    throwCollectedErrors(
        unexpectedCoordinationTaskPayloadFieldsErrors(
            payload,
            allowedFields,
            operationName,
        ),
    );
}

function allowedTaskMetadataUpdateFieldNamesForStatus(status) {
    switch (status) {
        case "draft":
        case "ready":
            return TASK_METADATA_UPDATE_PRE_EXECUTION_FIELD_NAMES;
        case "working":
            return TASK_METADATA_UPDATE_WORKING_FIELD_NAMES;
        case "reported":
        case "blocked":
            return TASK_METADATA_UPDATE_FOLLOW_UP_FIELD_NAMES;
        default:
            return [];
    }
}

function defaultCoordinationTaskNextAction(taskIDRaw, status) {
    const taskID = normalizeCoordinationTaskId(taskIDRaw);
    switch (status) {
        case "draft":
            return `Finish refinement and run /task-ready ${taskID}.`;
        case "ready":
            return `Open a fresh execution session and run /resume-task ${taskID}.`;
        case "working":
            return `Complete the owned execution slice and save /task-closeout ${taskID}.`;
        case "reported":
            return `Review the latest closeout and run /task-review ${taskID}.`;
        case "blocked":
            return `Review the blocker report and run /task-review ${taskID}.`;
        case "completed":
        case "cancelled":
            return "Open the task card if follow-up is needed; create a new task for additional work.";
        default:
            return "";
    }
}

function coordinationTaskRecommendation(
    task,
    actorSessionName = null,
    options = {},
) {
    // Degraded cards are quarantined: they are surfaced in listCoordinationTasks
    // with a diagnostics block and refused at the action boundary
    // (readyCoordinationTask). Recommend inspection/repair instead of any
    // lifecycle transition, so a degraded card (e.g. a bad stored status that
    // coerced to "draft") cannot be routed toward /task-ready through guidance.
    // The action-boundary refusal in readyCoordinationTask is the hard gate;
    // this is the soft (guidance) layer that keeps the coordinator from ever
    // proposing the transition in the first place.
    if (options.degraded) {
        return {
            command: `/task-open ${task.task_id}`,
            note: "This coordination-task card is degraded (a stored field failed validation). Inspect or repair it before any lifecycle transition — see the quarantine entry.",
        };
    }
    const missingResearchFields = missingResearchContractFields(task);
    if (missingResearchFields.length) {
        return {
            command: `/task-repair ${task.task_id}`,
            note: `This research task still needs: ${missingResearchFields.join(", ")}.`,
        };
    }
    switch (task.status) {
        case "draft":
            return {
                command: `/task-ready ${task.task_id}`,
                note: null,
            };
        case "ready":
            return {
                command: `/resume-task ${task.task_id}`,
                note: null,
            };
        case "working":
            if (task.active_session_alias) {
                return task.active_session_alias === actorSessionName
                    ? {
                          command: `/task-closeout ${task.task_id}`,
                          note: null,
                      }
                    : {
                          command: null,
                          note: `Continue this task in session ${task.active_session_alias} or explicitly take it over from a bound execution session.`,
                      };
            }
            return {
                command: `/resume-task ${task.task_id}`,
                note: null,
            };
        case "reported":
        case "blocked":
            return {
                command: `/task-review ${task.task_id}`,
                note: null,
            };
        default:
            return {
                command: `/task-open ${task.task_id}`,
                note: null,
            };
    }
}

function recommendedCoordinationTaskFields(
    task,
    actorSessionName = null,
    options = {},
) {
    const recommendation = coordinationTaskRecommendation(
        task,
        actorSessionName,
        options,
    );
    return {
        next_recommended_command: recommendation.command,
        next_recommended_note: recommendation.note,
    };
}

function ensureSessionMemoryNamespace(sessionName) {
    ensureSessionAliasNamespace(sessionName);
    ensureDir(sessionMemoryDir(sessionName));
    ensureDir(sessionDocumentDir(sessionName, "checkpoint"));
    ensureDir(sessionDocumentDir(sessionName, "handoff"));
    ensureDir(sessionRunDir(sessionName));
    for (const subdir of ["eval", "logs", "scratch", "exports"]) {
        ensureDir(sessionRunSubdir(sessionName, subdir));
    }

    for (const target of Object.keys(MEMORY_TARGETS)) {
        const targetPath = sessionMemoryFilePath(sessionName, target);
        if (!fs.existsSync(targetPath)) {
            atomicWriteText(targetPath, defaultMemoryMarkdown(target));
        }
    }
    if (!fs.existsSync(sessionDecisionLogPath(sessionName))) {
        atomicWriteText(sessionDecisionLogPath(sessionName), "# Decision Log\n\n");
    }
    if (!fs.existsSync(sessionArtifactsIndexPath(sessionName))) {
        atomicWriteJson(
            sessionArtifactsIndexPath(sessionName),
            defaultArtifactsPayload(
                sessionName,
                sessionRunManifestPath(sessionName),
            ),
        );
    }
    if (!fs.existsSync(sessionRunManifestPath(sessionName))) {
        atomicWriteJson(
            sessionRunManifestPath(sessionName),
            defaultRunManifest(sessionName),
        );
    }
    if (!fs.existsSync(sessionTaskContractPath(sessionName))) {
        atomicWriteText(
            sessionTaskContractPath(sessionName),
            formatTaskContractMarkdown({
                sessionName,
                version: 0,
                createdAt: isoZ(),
                updatedAt: isoZ(),
                cwd: hostCwd(),
                sessionID: "",
                body: defaultTaskContractMarkdown(),
            }),
        );
    }
    if (!fs.existsSync(sessionTaskContractJsonPath(sessionName))) {
        const createdAt = isoZ();
        atomicWriteJson(
            sessionTaskContractJsonPath(sessionName),
            {
                ...defaultTaskContractPayload(sessionName),
                created_at: createdAt,
                updated_at: createdAt,
            },
        );
    }
}

function ensureSessionAliasNamespace(sessionName) {
    ensureStateDirs();
    ensureDir(sessionAliasDir(sessionName));
    ensureDir(sessionPlansDir(sessionName));
    const indexPath = sessionIndexPath(sessionName);
    const lockPath = sessionIndexLockPath(sessionName);

    return withLock(lockPath, () => {
        const index = readJson(indexPath, defaultSessionIndex(sessionName));
        index.schema_version = SCHEMA_VERSION;
        index.session_name = sessionName;
        index.cwd = index.cwd || hostCwd();
        index.created_at = index.created_at || isoZ();
        index.updated_at = index.updated_at || isoZ();
        index.adopted_plan_id = index.adopted_plan_id || null;
        index.session_ids = Array.isArray(index.session_ids)
            ? index.session_ids
            : [];
        index.plans = Array.isArray(index.plans) ? index.plans : [];
        atomicWriteJson(indexPath, index);
        return index;
    });
}

function ensureWorkstreamNamespace(workstreamName) {
    ensureStateDirs();
    ensureDir(workstreamDir(workstreamName));
    const indexPath = workstreamIndexPath(workstreamName);
    const lockPath = workstreamLockPath(workstreamName);

    return withLock(lockPath, () => {
        const index = readJson(indexPath, defaultWorkstreamIndex(workstreamName));
        index.schema_version = SCHEMA_VERSION;
        index.workstream_name = workstreamName;
        index.created_at = index.created_at || isoZ();
        index.updated_at = index.updated_at || isoZ();
        index.session_ids = Array.isArray(index.session_ids)
            ? index.session_ids
            : [];
        index.session_names = Array.isArray(index.session_names)
            ? index.session_names
            : [];
        atomicWriteJson(indexPath, index);
        return index;
    });
}

function updateWorkstreamIndex(workstreamName, updateFn) {
    ensureWorkstreamNamespace(workstreamName);
    const indexPath = workstreamIndexPath(workstreamName);
    const lockPath = workstreamLockPath(workstreamName);

    return withLock(lockPath, () => {
        const current = readJson(
            indexPath,
            defaultWorkstreamIndex(workstreamName),
        );
        const updated = updateFn({
            ...current,
            session_ids: [...(current.session_ids || [])],
            session_names: [...(current.session_names || [])],
        });
        updated.schema_version = SCHEMA_VERSION;
        updated.workstream_name = workstreamName;
        updated.created_at = updated.created_at || current.created_at || isoZ();
        updated.updated_at = isoZ();
        updated.session_ids = [
            ...new Set((updated.session_ids || []).filter(Boolean)),
        ];
        updated.session_names = [
            ...new Set((updated.session_names || []).filter(Boolean)),
        ];
        atomicWriteJson(indexPath, updated);
        return updated;
    });
}

function ensureWorkstreamMemoryNamespace(workstreamName) {
    ensureWorkstreamNamespace(workstreamName);
    for (const target of Object.keys(WORKSTREAM_TARGETS)) {
        const targetPath = workstreamFilePath(workstreamName, target);
        if (!fs.existsSync(targetPath)) {
            atomicWriteText(
                targetPath,
                defaultWorkstreamMarkdown(target),
            );
        }
    }
}

function sortPlans(plans) {
    return [...(plans || [])].sort((left, right) => {
        const createdCompare = String(right.created_at || "").localeCompare(
            String(left.created_at || ""),
        );
        if (createdCompare !== 0) {
            return createdCompare;
        }
        return String(right.id || "").localeCompare(String(left.id || ""));
    });
}

function loadSessionIndex(sessionName) {
    ensureSessionAliasNamespace(sessionName);
    return readJson(
        sessionIndexPath(sessionName),
        defaultSessionIndex(sessionName),
    );
}

function updateSessionIndex(sessionName, updateFn) {
    ensureSessionAliasNamespace(sessionName);
    const indexPath = sessionIndexPath(sessionName);
    const lockPath = sessionIndexLockPath(sessionName);

    return withLock(lockPath, () => {
        const current = readJson(indexPath, defaultSessionIndex(sessionName));
        const updated = updateFn({
            ...current,
            session_ids: [...(current.session_ids || [])],
            plans: [...(current.plans || [])],
        });
        updated.schema_version = SCHEMA_VERSION;
        updated.session_name = sessionName;
        updated.cwd = updated.cwd || current.cwd || hostCwd();
        updated.created_at = updated.created_at || current.created_at || isoZ();
        updated.updated_at = isoZ();
        updated.adopted_plan_id = updated.adopted_plan_id || null;
        updated.session_ids = [
            ...new Set((updated.session_ids || []).filter(Boolean)),
        ];
        updated.plans = sortPlans(updated.plans || []);
        atomicWriteJson(indexPath, updated);
        return updated;
    });
}

function loadBinding(sessionID) {
    ensureStateDirs();
    return readJson(sessionBindingPath(sessionID), undefined);
}

function updateBinding(sessionID, updateFn, options = {}) {
    ensureStateDirs();
    const targetPath = sessionBindingPath(sessionID);
    const initial = defaultBinding(sessionID, options);
    const current = readJson(targetPath, initial);
    const updated = updateFn({ ...current });
    updated.schema_version = SCHEMA_VERSION;
    updated.session_id = sessionID;
    updated.active_workstream = updated.active_workstream || null;
    updated.cwd = updated.cwd || current.cwd || options.cwd || hostCwd();
    updated.created_at = updated.created_at || current.created_at || isoZ();
    updated.updated_at = isoZ();
    updated.last_seen_at = isoZ();
    atomicWriteJson(targetPath, updated);
    return updated;
}

function maybeLoadParentBinding(parentSessionID) {
    if (!parentSessionID) {
        return null;
    }
    try {
        return loadBinding(parentSessionID);
    } catch (error) {
        return null;
    }
}

function ensureSessionBinding(sessionID, options = {}) {
    ensureStateDirs();
    const targetPath = sessionBindingPath(sessionID);
    if (fs.existsSync(targetPath)) {
        const updated = updateBinding(
            sessionID,
            (binding) => ({
                ...binding,
                cwd: options.cwd || binding.cwd || hostCwd(),
                active_workstream:
                    binding.active_workstream || options.activeWorkstream || null,
                parent_session_id:
                    binding.parent_session_id ||
                    options.parentSessionID ||
                    null,
                }),
            options,
        );
        if (updated.session_name && updated.active_workstream) {
            attachSessionToWorkstream(
                updated.active_workstream,
                sessionID,
                updated.session_name,
            );
        }
        return updated;
    }

    const parentBinding = maybeLoadParentBinding(options.parentSessionID);
    const binding = defaultBinding(sessionID, {
        ...options,
        sessionName:
            options.sessionName ||
            (parentBinding && parentBinding.session_name) ||
            null,
        activeWorkstream:
            options.activeWorkstream ||
            (parentBinding && parentBinding.active_workstream) ||
            null,
    });
    atomicWriteJson(targetPath, binding);
    if (binding.session_name) {
        attachSessionToAlias(binding.session_name, sessionID);
        if (binding.active_workstream) {
            attachSessionToWorkstream(
                binding.active_workstream,
                sessionID,
                binding.session_name,
            );
        }
    }
    return binding;
}

function attachSessionToAlias(sessionName, sessionID) {
    updateSessionIndex(sessionName, (current) => ({
        ...current,
        session_ids: [...(current.session_ids || []), sessionID],
    }));
}

function attachSessionToWorkstream(workstreamName, sessionID, sessionName) {
    updateWorkstreamIndex(workstreamName, (current) => ({
        ...current,
        session_ids: [...(current.session_ids || []), sessionID],
        session_names: [
            ...(current.session_names || []),
            sessionName,
        ].filter(Boolean),
    }));
}

function bindSessionName(sessionID, sessionNameRaw, options = {}) {
    const sessionName = normalizeSessionName(sessionNameRaw);
    ensureSessionAliasNamespace(sessionName);
    attachSessionToAlias(sessionName, sessionID);
    const updated = updateBinding(
        sessionID,
        (binding) => ({
            ...binding,
            session_name: sessionName,
            cwd: options.cwd || binding.cwd || hostCwd(),
            active_workstream:
                binding.active_workstream || options.activeWorkstream || null,
            parent_session_id:
                binding.parent_session_id || options.parentSessionID || null,
        }),
        options,
    );
    if (updated.active_workstream) {
        attachSessionToWorkstream(
            updated.active_workstream,
            sessionID,
            sessionName,
        );
    }
    return updated;
}

function bindWorkstream(sessionID, workstreamNameRaw, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const workstreamName = normalizeWorkstreamName(workstreamNameRaw);
    ensureWorkstreamNamespace(workstreamName);
    const updated = updateBinding(
        sessionID,
        (current) => ({
            ...current,
            active_workstream: workstreamName,
            cwd: options.cwd || current.cwd || hostCwd(),
            parent_session_id:
                current.parent_session_id || options.parentSessionID || null,
        }),
        options,
    );
    const workstreamIndex = updateWorkstreamIndex(workstreamName, (current) => ({
        ...current,
        session_ids: [...(current.session_ids || []), sessionID],
        session_names: [
            ...(current.session_names || []),
            binding.session_name,
        ].filter(Boolean),
    }));
    return {
        session_id: sessionID,
        session_name: updated.session_name,
        active_workstream: workstreamName,
        workstream_dir: relativeToRepo(workstreamDir(workstreamName)),
        index_path: relativeToRepo(workstreamIndexPath(workstreamName)),
        linked_sessions: [...(workstreamIndex.session_names || [])],
    };
}

function clearWorkstream(sessionID, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const previousWorkstream = binding.active_workstream || null;
    const updated = updateBinding(
        sessionID,
        (current) => ({
            ...current,
            active_workstream: null,
            cwd: options.cwd || current.cwd || hostCwd(),
            parent_session_id:
                current.parent_session_id || options.parentSessionID || null,
        }),
        options,
    );
    return {
        session_id: sessionID,
        session_name: updated.session_name,
        previous_workstream: previousWorkstream,
        active_workstream: null,
    };
}

function currentSessionBinding(sessionID, options = {}) {
    const binding = ensureSessionBinding(sessionID, options);
    if (!binding.session_name && !options.allowUnbound) {
        throw new StateError(
            "No active OpenCode session alias is bound for this session. Run /session-name <name> first.",
        );
    }
    return binding;
}

function listPlans(sessionID, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const index = loadSessionIndex(binding.session_name);
    return {
        session_id: sessionID,
        session_name: binding.session_name,
        adopted_plan_id: index.adopted_plan_id || null,
        plans: sortPlans(index.plans || []),
    };
}

function uniquePlanId(slug, existingIds) {
    const base = `${planTimestamp()}-${slug}`;
    if (!existingIds.has(base)) {
        return base;
    }
    for (let suffix = 2; suffix < 100; suffix += 1) {
        const candidate = `${base}-${String(suffix).padStart(2, "0")}`;
        if (!existingIds.has(candidate)) {
            return candidate;
        }
    }
    throw new StateError(
        "Could not allocate a unique plan id after 99 attempts.",
    );
}

function formatPlanMarkdown({
    planId,
    title,
    sessionName,
    status,
    createdAt,
    cwd,
    sessionID,
    body,
    f3DesignReadiness,
}) {
    const normalizedBody = String(body || "").trim();
    if (!normalizedBody) {
        throw new StateError(
            "Plan body is empty. Refuse to save an empty plan.",
        );
    }
    const lines = [
        "---",
        `id: ${yamlScalar(planId)}`,
        `title: ${yamlScalar(title)}`,
        `session_name: ${yamlScalar(sessionName)}`,
        `status: ${yamlScalar(status)}`,
        `created_at: ${yamlScalar(createdAt)}`,
        `cwd: ${yamlScalar(cwd)}`,
        `session_id: ${yamlScalar(sessionID)}`,
    ];
    // F3 design-readiness envelope (copied from the draft on approval so the
    // dispatch backstop can re-read it without going back to the draft).
    // Double-JSON-encoded: the outer JSON.stringify wraps the value in quotes
    // + escapes inner quotes so parseFrontmatter's `"..."`-quote auto-unquote
    // path produces the JSON string; the reader JSON.parses once more to
    // recover the object. See readDraft's decodeEnvelopeFromFrontmatter.
    if (
        f3DesignReadiness !== null &&
        f3DesignReadiness !== undefined &&
        typeof f3DesignReadiness === "object"
    ) {
        lines.push(
            `f3_design_readiness: ${JSON.stringify(JSON.stringify(f3DesignReadiness))}`,
        );
    }
    lines.push("---", "", normalizedBody, "");
    return lines.join("\n");
}

function planRecordPath(planRecord) {
    return path.join(repoRoot(), planRecord.path);
}

function savePlan(sessionID, slugOrTitle, body, title, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const sessionName = binding.session_name;
    const slug = slugify(slugOrTitle);
    const planTitle = String(title || "").trim() || titleFromSlug(slug);
    const createdAt = isoZ();
    const cwd = options.cwd || binding.cwd || hostCwd();
    const f3DesignReadiness =
        options.f3DesignReadiness !== undefined
            ? options.f3DesignReadiness
            : null;
    let savedPlan = null;

    const index = updateSessionIndex(sessionName, (current) => {
        const existingIds = new Set(
            (current.plans || []).map((plan) => plan.id),
        );
        const planId = uniquePlanId(slug, existingIds);
        const planPath = path.join(
            sessionPlansDir(sessionName),
            `${planId}.md`,
        );
        const markdown = formatPlanMarkdown({
            planId,
            title: planTitle,
            sessionName,
            status: "approved",
            createdAt,
            cwd,
            sessionID,
            body,
            f3DesignReadiness,
        });
        atomicWriteText(planPath, markdown);
        savedPlan = {
            id: planId,
            title: planTitle,
            slug,
            status: "approved",
            created_at: createdAt,
            path: relativeToRepo(planPath),
            session_id: sessionID,
        };
        return {
            ...current,
            session_ids: [...(current.session_ids || []), sessionID],
            plans: [
                ...(current.plans || []).filter((plan) => plan.id !== planId),
                savedPlan,
            ],
        };
    });

    return {
        session_id: sessionID,
        session_name: sessionName,
        adopted_plan_id: index.adopted_plan_id || null,
        plan: savedPlan,
    };
}

function candidatePlanLines(plans) {
    const ordered = sortPlans(plans);
    if (!ordered.length) {
        return "No saved plans in this session.";
    }
    return ordered
        .map((plan) => `- ${plan.id} [${plan.status}] ${plan.title}`)
        .join("\n");
}

function resolvePlanRecord(index, selector) {
    const plans = sortPlans(index.plans || []);
    const normalizedSelector = String(selector || "").trim();

    if (normalizedSelector) {
        const exact = plans.filter((plan) => plan.id === normalizedSelector);
        if (exact.length === 1) {
            return { plan: exact[0], resolvedVia: "explicit" };
        }
        const prefixMatches = plans.filter((plan) =>
            String(plan.id || "").startsWith(normalizedSelector),
        );
        if (prefixMatches.length === 1) {
            return { plan: prefixMatches[0], resolvedVia: "explicit" };
        }
        if (prefixMatches.length > 1) {
            throw new StateError(
                `Plan id prefix is ambiguous. Candidates:\n${candidatePlanLines(plans)}`,
            );
        }
        throw new StateError(
            `No plan matched that id or prefix in the current session.\n${candidatePlanLines(plans)}`,
        );
    }

    const adoptedPlanId = String(index.adopted_plan_id || "").trim();
    if (adoptedPlanId) {
        const adopted = plans.find((plan) => plan.id === adoptedPlanId);
        if (adopted) {
            return { plan: adopted, resolvedVia: "adopted" };
        }
    }

    const latestApproved = plans.find((plan) => plan.status === "approved");
    if (latestApproved) {
        return { plan: latestApproved, resolvedVia: "latest_approved" };
    }

    throw new StateError(
        `No approved plan is available in the current session. Save one with /plan-save <slug>.\n${candidatePlanLines(plans)}`,
    );
}

function adoptPlan(sessionID, selector, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const sessionName = binding.session_name;
    const updated = updateSessionIndex(sessionName, (current) => {
        const resolved = resolvePlanRecord(current, selector);
        return {
            ...current,
            session_ids: [...(current.session_ids || []), sessionID],
            adopted_plan_id: resolved.plan.id,
        };
    });
    const resolved = resolvePlanRecord(updated, updated.adopted_plan_id);
    return {
        session_id: sessionID,
        session_name: sessionName,
        adopted_plan_id: updated.adopted_plan_id,
        resolved_via: resolved.resolvedVia,
        plan: resolved.plan,
    };
}

function resolvePlan(sessionID, selector, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const sessionName = binding.session_name;
    const index = loadSessionIndex(sessionName);
    const resolved = resolvePlanRecord(index, selector);
    const targetPath = planRecordPath(resolved.plan);
    if (!fs.existsSync(targetPath)) {
        throw new StateError(
            `Resolved plan file is missing on disk: ${targetPath}`,
        );
    }
    const body = fs.readFileSync(targetPath, "utf8");

    // F3 dispatch backstop (Slice 4). When a caller resolves an APPROVED plan
    // FOR DISPATCH (options.dispatchFreshnessCheck), re-verify the plan's F3
    // envelope is still bound to the current design before handing the body
    // to an executor. Catches:
    // (a) post-approval design drift — the plan body was edited after
    //     approval, invalidating the design digest the envelope was bound to;
    // (b) bypassed approval states — an approved plan whose envelope was
    //     stripped or never copied through.
    // BACKSTOP, not the primary gate — the primary gate is at approveDraft
    // (draft -> approved). Informational reads (session-context builder, plan
    // listing) pass no dispatchFreshnessCheck and are exempt: a stale plan
    // surfaces as a dispatch refusal only when an agent actually tries to
    // execute it, not when it is merely listed.
    if (
        options.dispatchFreshnessCheck &&
        resolved.plan.status === "approved"
    ) {
        const parsed = parseFrontmatter(body);
        const dispatchEnvelope = decodeEnvelopeFromFrontmatter(
            parsed.frontmatter.f3_design_readiness,
        );
        const dispatchDigest = computePlanDesignDigest(parsed.body);
        const dispatchF3 = validateF3DesignReadiness({
            envelope: dispatchEnvelope,
            currentDesignDigest: dispatchDigest,
            transitionKind: "plan_dispatch",
        });
        if (!dispatchF3.passed) {
            throw new StateError(
                `F3 dispatch backstop refused plan dispatch ` +
                    `for plan ${resolved.plan.id} ` +
                    `(reason: ${dispatchF3.reasonCode}). ` +
                    `${dispatchF3.detail} ` +
                    `The approved plan's design-readiness envelope is stale, ` +
                    `incomplete, or missing relative to the current plan body. ` +
                    `Re-approve with a current envelope before dispatch.`,
            );
        }
    }

    return {
        session_id: sessionID,
        session_name: sessionName,
        adopted_plan_id: index.adopted_plan_id || null,
        resolved_via: resolved.resolvedVia,
        plan: resolved.plan,
        path: targetPath,
        body,
    };
}

function humanPlanList(sessionName, index) {
    const adopted = index.adopted_plan_id || "(none)";
    const lines = [`session: ${sessionName}`, `adopted: ${adopted}`, "plans:"];
    const ordered = sortPlans(index.plans || []);
    if (!ordered.length) {
        lines.push("- (none)");
    } else {
        for (const plan of ordered) {
            const marker = plan.id === adopted ? "*" : "-";
            lines.push(`${marker} ${plan.id} [${plan.status}] ${plan.title}`);
        }
    }
    return lines.join("\n");
}

function stripFrontmatter(markdown) {
    const lines = String(markdown || "").split("\n");
    if (lines[0] !== "---") {
        return String(markdown || "").trim();
    }
    const closingIndex = lines.slice(1).findIndex((line) => line === "---");
    if (closingIndex === -1) {
        return String(markdown || "").trim();
    }
    return lines
        .slice(closingIndex + 2)
        .join("\n")
        .trim();
}

function parseFrontmatter(markdown) {
    const text = String(markdown || "");
    const lines = text.split("\n");
    if (lines[0] !== "---") {
        return {
            frontmatter: {},
            body: text.trim(),
        };
    }
    const closingIndex = lines.slice(1).findIndex((line) => line === "---");
    if (closingIndex === -1) {
        return {
            frontmatter: {},
            body: text.trim(),
        };
    }

    const frontmatter = {};
    for (const line of lines.slice(1, closingIndex + 1)) {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex === -1) {
            continue;
        }
        const key = line.slice(0, separatorIndex).trim();
        const rawValue = line.slice(separatorIndex + 1).trim();
        if (!key) {
            continue;
        }
        if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
            try {
                frontmatter[key] = JSON.parse(rawValue);
                continue;
            } catch (error) {
                // Fall through to raw string.
            }
        }
        frontmatter[key] = rawValue;
    }

    return {
        frontmatter,
        body: lines
            .slice(closingIndex + 2)
            .join("\n")
            .trim(),
    };
}

// Decode an F3 envelope stored as a double-JSON-encoded frontmatter value.
// parseFrontmatter's `"..."`-quote auto-unquote path already produced a JSON
// string; JSON.parse once more recovers the object. Returns null for missing,
// non-string, or unparseable values (fail-closed at the crossing).
function decodeEnvelopeFromFrontmatter(rawValue) {
    if (typeof rawValue !== "string" || rawValue === "") {
        return null;
    }
    try {
        const parsed = JSON.parse(rawValue);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
        }
        return null;
    } catch (error) {
        return null;
    }
}

function summarizePlanBody(markdown, maxLines = 16) {
    const body = stripFrontmatter(markdown);
    const lines = body.split("\n").filter(Boolean).slice(0, maxLines);
    return lines.join("\n").trim();
}

function summarizeTodos(todos, limit = 5) {
    return (todos || [])
        .filter(
            (todo) =>
                !["completed", "cancelled"].includes(
                    String(todo.status || "").toLowerCase(),
                ),
        )
        .sort((left, right) => {
            const priorityOrder = { high: 0, medium: 1, low: 2 };
            return (
                (priorityOrder[String(left.priority || "").toLowerCase()] ??
                    9) -
                (priorityOrder[String(right.priority || "").toLowerCase()] ?? 9)
            );
        })
        .slice(0, limit)
        .map((todo) => `- [${todo.status}] (${todo.priority}) ${todo.content}`);
}

function summarizeMarkdownExcerpt(markdown, maxLines = 8) {
    return stripFrontmatter(markdown)
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .slice(0, maxLines)
        .join("\n")
        .trim();
}

function summarizeDecisionLog(markdown, limit = 3) {
    const sections = String(markdown || "")
        .split(/^## /m)
        .slice(1)
        .map((section) => `## ${section.trim()}`)
        .filter(Boolean);
    return sections
        .slice(-limit)
        .map((section) => section.split("\n").slice(0, 4).join("\n").trim())
        .join("\n\n")
        .trim();
}

function listSessionDocuments(sessionName, kind) {
    ensureSessionMemoryNamespace(sessionName);
    return fs
        .readdirSync(sessionDocumentDir(sessionName, kind))
        .filter((name) => name.endsWith(".md"))
        .sort()
        .reverse()
        .map((name) => {
            const targetPath = path.join(sessionDocumentDir(sessionName, kind), name);
            const parsed = parseFrontmatter(fs.readFileSync(targetPath, "utf8"));
            const id = name.replace(/\.md$/, "");
            return {
                id,
                slug: parsed.frontmatter.slug || id,
                title:
                    parsed.frontmatter.title ||
                    titleFromSlug(parsed.frontmatter.slug || id),
                created_at: parsed.frontmatter.created_at || null,
                path: relativeToRepo(targetPath),
                kind,
            };
        });
}

function resolveSessionDocumentRecord(sessionName, kind, selector) {
    const records = listSessionDocuments(sessionName, kind);
    if (!records.length) {
        throw new StateError(
            `No ${kind} documents are available in the current session.`,
        );
    }
    const normalizedSelector = String(selector || "").trim();
    if (!normalizedSelector) {
        return {
            record: records[0],
            resolvedVia: "latest",
        };
    }

    const exact = records.filter(
        (record) =>
            record.id === normalizedSelector || record.slug === normalizedSelector,
    );
    if (exact.length === 1) {
        return {
            record: exact[0],
            resolvedVia: "explicit",
        };
    }

    const prefixMatches = records.filter(
        (record) =>
            record.id.startsWith(normalizedSelector) ||
            record.slug.startsWith(normalizedSelector),
    );
    if (prefixMatches.length === 1) {
        return {
            record: prefixMatches[0],
            resolvedVia: "explicit",
        };
    }
    if (prefixMatches.length > 1) {
        throw new StateError(
            `${kind} selector is ambiguous. Candidates:\n${prefixMatches
                .map((record) => `- ${record.id} ${record.title}`)
                .join("\n")}`,
        );
    }

    throw new StateError(
        `No ${kind} document matched that selector in the current session.`,
    );
}

function formatSessionDocumentMarkdown({
    kind,
    slug,
    title,
    sessionName,
    createdAt,
    cwd,
    sessionID,
    body,
    extraFrontmatter = {},
}) {
    const normalizedBody = String(body || "").trim();
    if (!normalizedBody) {
        throw new StateError(
            `${SESSION_DOCUMENT_KINDS[kind].label} body is empty. Refuse to save an empty ${kind}.`,
        );
    }
    const frontmatter = [
        ["slug", slug],
        ["title", title],
        ["kind", kind],
        ["session_name", sessionName],
        ["created_at", createdAt],
        ["cwd", cwd],
        ["session_id", sessionID],
    ];
    for (const [key, value] of Object.entries(extraFrontmatter)) {
        if (value === undefined || value === null || value === "") {
            continue;
        }
        frontmatter.push([key, value]);
    }

    return [
        "---",
        ...frontmatter.map(([key, value]) => `${key}: ${yamlScalar(value)}`),
        "---",
        "",
        normalizedBody,
        "",
    ].join("\n");
}

function initSessionMemory(sessionID, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const sessionName = binding.session_name;
    ensureSessionMemoryNamespace(sessionName);

    if (options.briefBody !== undefined) {
        atomicWriteText(
            sessionMemoryFilePath(sessionName, "brief"),
            renderMemoryMarkdown("brief", options.briefBody),
        );
    }
    if (options.resolvedContextBody !== undefined) {
        atomicWriteText(
            sessionMemoryFilePath(sessionName, "resolved_context"),
            renderMemoryMarkdown(
                "resolved_context",
                options.resolvedContextBody,
            ),
        );
    }
    if (options.openQuestionsBody !== undefined) {
        atomicWriteText(
            sessionMemoryFilePath(sessionName, "open_questions"),
            renderMemoryMarkdown("open_questions", options.openQuestionsBody),
        );
    }

    return {
        session_id: sessionID,
        session_name: sessionName,
        memory_dir: relativeToRepo(sessionMemoryDir(sessionName)),
        run_dir: relativeToRepo(sessionRunDir(sessionName)),
        artifact_manifest_path: relativeToRepo(
            sessionRunManifestPath(sessionName),
        ),
        files: {
            brief: relativeToRepo(sessionMemoryFilePath(sessionName, "brief")),
            task_contract: relativeToRepo(sessionTaskContractPath(sessionName)),
            task_contract_json: relativeToRepo(
                sessionTaskContractJsonPath(sessionName),
            ),
            resolved_context: relativeToRepo(
                sessionMemoryFilePath(sessionName, "resolved_context"),
            ),
            open_questions: relativeToRepo(
                sessionMemoryFilePath(sessionName, "open_questions"),
            ),
            decision_log: relativeToRepo(sessionDecisionLogPath(sessionName)),
            artifacts_index: relativeToRepo(
                sessionArtifactsIndexPath(sessionName),
            ),
        },
    };
}

function saveTaskContract(sessionID, body, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const sessionName = binding.session_name;
    ensureSessionMemoryNamespace(sessionName);
    const targetPath = sessionTaskContractPath(sessionName);
    const jsonPath = sessionTaskContractJsonPath(sessionName);
    const existing = loadTaskContractPayload(sessionName);
    const now = isoZ();
    const version = Number(existing.version || 0) + 1;
    const parsed = parseTaskContractMarkdown(body);
    const payload = {
        ...defaultTaskContractPayload(sessionName),
        ...parsed,
        session_name: sessionName,
        version,
        created_at: existing.created_at || now,
        updated_at: now,
    };
    // Materialize operator-cleared assumptions from canonical YAML
    payload.cleared_assumptions = mergeClearedAssumptions(
        payload.cleared_assumptions || [],
        loadClearedAssumptions(),
    );
    const markdown = formatTaskContractMarkdown({
        sessionName,
        version,
        createdAt: payload.created_at,
        updatedAt: now,
        cwd: options.cwd || binding.cwd || hostCwd(),
        sessionID,
        body,
    });
    atomicWriteText(targetPath, markdown);
    atomicWriteJson(jsonPath, payload);
    return {
        session_id: sessionID,
        session_name: sessionName,
        version,
        path: relativeToRepo(targetPath),
        json_path: relativeToRepo(jsonPath),
        summary: summarizeTaskContract(payload),
    };
}

function readTaskContract(sessionID, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const sessionName = binding.session_name;
    ensureSessionMemoryNamespace(sessionName);
    const targetPath = sessionTaskContractPath(sessionName);
    const jsonPath = sessionTaskContractJsonPath(sessionName);
    const parsed = parseFrontmatter(fs.readFileSync(targetPath, "utf8"));
    const payload = loadTaskContractPayload(sessionName);
    return {
        session_id: sessionID,
        session_name: sessionName,
        version: Number(payload.version || 0) || 0,
        path: relativeToRepo(targetPath),
        json_path: relativeToRepo(jsonPath),
        frontmatter: parsed.frontmatter,
        contract: payload,
        summary: summarizeTaskContract(payload),
        body: parsed.body,
    };
}

function writeSessionMemoryFile(sessionID, target, body, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const sessionName = binding.session_name;
    ensureSessionMemoryNamespace(sessionName);
    const targetPath = sessionMemoryFilePath(sessionName, target);
    atomicWriteText(targetPath, renderMemoryMarkdown(target, body));
    return {
        session_id: sessionID,
        session_name: sessionName,
        target,
        path: relativeToRepo(targetPath),
    };
}

function appendDecision(sessionID, body, title, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const sessionName = binding.session_name;
    const normalizedBody = String(body || "").trim();
    if (!normalizedBody) {
        throw new StateError(
            "Decision body is empty. Refuse to append an empty decision entry.",
        );
    }
    ensureSessionMemoryNamespace(sessionName);
    const targetPath = sessionDecisionLogPath(sessionName);
    const current = readTextIfExists(targetPath).trimEnd();
    const entryTitle = String(title || "").trim() || "Decision";
    const createdAt = isoZ();
    const nextContent = [
        current || "# Decision Log",
        "",
        `## ${createdAt} - ${entryTitle}`,
        "",
        normalizedBody,
        "",
    ].join("\n");
    atomicWriteText(targetPath, `${nextContent}\n`);
    return {
        session_id: sessionID,
        session_name: sessionName,
        title: entryTitle,
        created_at: createdAt,
        path: relativeToRepo(targetPath),
    };
}

function saveSessionDocument(
    sessionID,
    kind,
    slugOrTitle,
    body,
    title,
    options = {},
) {
    const binding = currentSessionBinding(sessionID, options);
    const sessionName = binding.session_name;
    ensureSessionMemoryNamespace(sessionName);
    const slug = slugify(slugOrTitle);
    const documentTitle = String(title || "").trim() || titleFromSlug(slug);
    const createdAt = isoZ();
    const targetPath = path.join(
        sessionDocumentDir(sessionName, kind),
        `${planTimestamp()}-${slug}.md`,
    );
    const markdown = formatSessionDocumentMarkdown({
        kind,
        slug,
        title: documentTitle,
        sessionName,
        createdAt,
        cwd: options.cwd || binding.cwd || hostCwd(),
        sessionID,
        body,
        extraFrontmatter: options.extraFrontmatter || {},
    });
    atomicWriteText(targetPath, markdown);
    return {
        session_id: sessionID,
        session_name: sessionName,
        kind,
        id: path.basename(targetPath, ".md"),
        slug,
        title: documentTitle,
        created_at: createdAt,
        path: relativeToRepo(targetPath),
    };
}

function saveCheckpoint(sessionID, slugOrTitle, body, title, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const sessionName = binding.session_name;
    const contract = loadTaskContractPayload(sessionName);
    return saveSessionDocument(sessionID, "checkpoint", slugOrTitle, body, title, {
        ...options,
        extraFrontmatter: {
            goal: options.goal || "",
            next_step: options.nextStep || "",
            active_workstream: binding.active_workstream || "",
            artifact_manifest:
                options.artifactManifest ||
                relativeToRepo(sessionRunManifestPath(sessionName)),
            task_contract: relativeToRepo(sessionTaskContractPath(sessionName)),
            task_contract_version: Number(contract.version || 0) || 0,
        },
    });
}

function readCheckpoint(sessionID, selector, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const resolved = resolveSessionDocumentRecord(
        binding.session_name,
        "checkpoint",
        selector,
    );
    const targetPath = path.join(repoRoot(), resolved.record.path);
    const parsed = parseFrontmatter(fs.readFileSync(targetPath, "utf8"));
    return {
        session_id: sessionID,
        session_name: binding.session_name,
        resolved_via: resolved.resolvedVia,
        checkpoint: resolved.record,
        path: targetPath,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
    };
}

function saveHandoff(sessionID, slugOrTitle, body, title, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const sessionName = binding.session_name;
    const contract = loadTaskContractPayload(sessionName);
    return saveSessionDocument(sessionID, "handoff", slugOrTitle, body, title, {
        ...options,
        extraFrontmatter: {
            target_agent: options.targetAgent || "",
            next_step: options.nextStep || "",
            active_workstream: binding.active_workstream || "",
            artifact_manifest:
                options.artifactManifest ||
                relativeToRepo(sessionRunManifestPath(sessionName)),
            task_contract: relativeToRepo(sessionTaskContractPath(sessionName)),
            task_contract_version: Number(contract.version || 0) || 0,
        },
    });
}

function updateArtifactStores(sessionName, updateFn) {
    ensureSessionMemoryNamespace(sessionName);
    const lockPath = sessionMemoryLockPath(sessionName);
    return withLock(lockPath, () => {
        const currentIndex = readJson(
            sessionArtifactsIndexPath(sessionName),
            defaultArtifactsPayload(sessionName, sessionRunManifestPath(sessionName)),
        );
        const currentManifest = readJson(
            sessionRunManifestPath(sessionName),
            defaultRunManifest(sessionName),
        );
        const updated = updateFn({
            index: {
                ...currentIndex,
                artifacts: [...(currentIndex.artifacts || [])],
            },
            manifest: {
                ...currentManifest,
                artifacts: [...(currentManifest.artifacts || [])],
            },
        });
        updated.index.schema_version = SCHEMA_VERSION;
        updated.index.session_name = sessionName;
        updated.index.manifest_path = relativeToRepo(
            sessionRunManifestPath(sessionName),
        );
        updated.index.updated_at = isoZ();
        updated.manifest.schema_version = SCHEMA_VERSION;
        updated.manifest.session_name = sessionName;
        updated.manifest.run_dir = relativeToRepo(sessionRunDir(sessionName));
        updated.manifest.updated_at = isoZ();
        atomicWriteJson(sessionArtifactsIndexPath(sessionName), updated.index);
        atomicWriteJson(sessionRunManifestPath(sessionName), updated.manifest);
        return updated;
    });
}

function recordArtifact(sessionID, artifactPath, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const sessionName = binding.session_name;
    const createdAt = isoZ();
    const storedPath = storePathForRepo(normalizeRepoPath(artifactPath));
    const retention = String(options.retention || "delete_on_success").trim();
    const artifact = {
        path: storedPath,
        kind: String(options.kind || "generic").trim() || "generic",
        retention,
        notes: String(options.notes || "").trim(),
        status: "active",
        created_at: createdAt,
        updated_at: createdAt,
    };
    const updated = updateArtifactStores(sessionName, ({ index, manifest }) => {
        const existing = [...(index.artifacts || []), ...(manifest.artifacts || [])]
            .find((entry) => entry.path === storedPath);
        const nextArtifact = existing
            ? {
                  ...existing,
                  ...artifact,
                  created_at: existing.created_at || createdAt,
                  updated_at: createdAt,
              }
            : artifact;
        const nextArtifacts = [
            ...(index.artifacts || []).filter((entry) => entry.path !== storedPath),
            nextArtifact,
        ].sort((left, right) =>
            String(left.path || "").localeCompare(String(right.path || "")),
        );
        return {
            index: {
                ...index,
                artifacts: nextArtifacts,
            },
            manifest: {
                ...manifest,
                artifacts: nextArtifacts,
            },
        };
    });
    return {
        session_id: sessionID,
        session_name: sessionName,
        artifact: updated.index.artifacts.find((entry) => entry.path === storedPath),
        manifest_path: relativeToRepo(sessionRunManifestPath(sessionName)),
    };
}

function resolvePaths(sessionID, pathRefs, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const sessionName = binding.session_name;
    ensureSessionMemoryNamespace(sessionName);
    const refs = Array.isArray(pathRefs) ? pathRefs : [pathRefs];
    const root = repoRoot();
    const results = refs.map((ref) => {
        const raw = typeof ref === "string" ? ref : String(ref.path || ref || "");
        const abs = normalizeRepoPath(raw);
        const exists = fs.existsSync(abs);
        const status = exists ? "exact" : "missing";
        return {
            path: relativeToRepo(abs),
            status,
            replacement: null,
            note: exists ? "File exists" : "File not found",
        };
    });
    const resolvedContextPath = sessionMemoryFilePath(sessionName, "resolved_context");
    const existing = readTextIfExists(resolvedContextPath).trimEnd();
    const timestamp = isoZ();
    const entries = results
        .map((r) => `- \`${r.path}\` → ${r.status}${r.note ? ` (${r.note})` : ""}`)
        .join("\n");
    const section = [
        "",
        `## Path Resolution — ${timestamp}`,
        "",
        entries,
        "",
    ].join("\n");
    const updated = existing
        ? `${existing}\n${section}`
        : `# Resolved Context\n${section}`;
    atomicWriteText(resolvedContextPath, `${updated}\n`);
    return {
        session_id: sessionID,
        session_name: sessionName,
        resolved_context_path: relativeToRepo(resolvedContextPath),
        results,
        total: results.length,
        exact: results.filter((r) => r.status === "exact").length,
        missing: results.filter((r) => r.status === "missing").length,
    };
}

function recordArtifacts(sessionID, artifactList, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const sessionName = binding.session_name;
    const items = Array.isArray(artifactList) ? artifactList : [artifactList];
    const recorded = [];
    const errors = [];
    for (const item of items) {
        try {
            const artifactPath = typeof item === "string" ? item : item.path || "";
            const itemOptions = {
                cwd: options.cwd,
                kind: (item.kind || "").trim(),
                retention: (item.retention || "").trim(),
                notes: (item.notes || "").trim(),
            };
            const result = recordArtifact(sessionID, artifactPath, itemOptions);
            recorded.push(result);
        } catch (err) {
            errors.push({
                path: typeof item === "string" ? item : item.path || "",
                error: err.message || String(err),
            });
        }
    }
    return {
        session_id: sessionID,
        session_name: sessionName,
        total: items.length,
        recorded: recorded.length,
        errors: errors.length,
        error_details: errors.length ? errors : undefined,
        manifest_path: relativeToRepo(sessionRunManifestPath(sessionName)),
    };
}

function cleanupArtifacts(sessionID, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const sessionName = binding.session_name;
    const retentions =
        Array.isArray(options.retentions) && options.retentions.length
            ? options.retentions
            : DEFAULT_CLEANUP_RETENTIONS;
    const tmpRoot = path.join(repoRoot(), "tmp");
    const summary = {
        session_id: sessionID,
        session_name: sessionName,
        retentions,
        deleted: [],
        missing: [],
        skipped: [],
        kept: [],
        manifest_path: relativeToRepo(sessionRunManifestPath(sessionName)),
    };

    updateArtifactStores(sessionName, ({ index, manifest }) => {
        const sourceArtifacts = (index.artifacts || []).length
            ? [...(index.artifacts || [])]
            : [...(manifest.artifacts || [])];
        const nextArtifacts = sourceArtifacts.map((artifact) => {
            const nextArtifact = { ...artifact };
            if (!retentions.includes(String(nextArtifact.retention || ""))) {
                summary.kept.push(nextArtifact.path);
                return nextArtifact;
            }
            if (["deleted", "missing"].includes(String(nextArtifact.status || ""))) {
                summary.kept.push(nextArtifact.path);
                return nextArtifact;
            }
            const absolutePath = normalizeRepoPath(nextArtifact.path);
            const safePrefix = `${tmpRoot}${path.sep}`;
            if (
                absolutePath !== tmpRoot &&
                !absolutePath.startsWith(safePrefix)
            ) {
                nextArtifact.cleanup_status = "skipped";
                nextArtifact.cleanup_reason = "outside_repo_tmp";
                nextArtifact.updated_at = isoZ();
                summary.skipped.push(nextArtifact.path);
                return nextArtifact;
            }
            const existed = fs.existsSync(absolutePath);
            if (existed) {
                fs.rmSync(absolutePath, {
                    recursive: true,
                    force: true,
                });
            }
            nextArtifact.status = existed ? "deleted" : "missing";
            nextArtifact.cleaned_at = isoZ();
            nextArtifact.updated_at = nextArtifact.cleaned_at;
            if (existed) {
                summary.deleted.push(nextArtifact.path);
            } else {
                summary.missing.push(nextArtifact.path);
            }
            return nextArtifact;
        });
        return {
            index: {
                ...index,
                artifacts: nextArtifacts,
            },
            manifest: {
                ...manifest,
                artifacts: nextArtifacts,
            },
        };
    });

    return summary;
}

function loadCoordinationTask(taskIDRaw, options = {}) {
    ensureLocalCoordinatorNamespace();
    const taskID = normalizeCoordinationTaskId(taskIDRaw);
    const targetPath = coordinationTaskPath(taskID);
    if (!fs.existsSync(targetPath)) {
        if (options.required === false) {
            return {
                task_id: taskID,
                path: targetPath,
                payload: defaultCoordinationTaskPayload(taskID),
                exists: false,
                diagnostics: {
                    problems: [],
                    offendingFields: [],
                    degraded: false,
                },
            };
        }
        throw new StateError(
            `Coordination task does not exist: ${relativeToRepo(targetPath)}`,
        );
    }
    // Read-path fault tolerance: COLLECT (do not throw) every validation
    // problem so a degraded card — a bad stored enum coerced to "" upstream,
    // or a legacy-incomplete record — does not brick listCoordinationTasks()
    // and every load-based op. The collected problems are now SURFACED as
    // `diagnostics` (previously discarded) so the scan boundary can route
    // degraded cards into `quarantine[]` and the action boundary
    // (readyCoordinationTask) can refuse them. The save path
    // (updateCoordinationTask and friends) keeps the strict throwing
    // ensureCoordinationTaskCoreFields call, so only the read path tolerates
    // already-stored data. This closes the read/write asymmetry: writes
    // reject bad INPUT, reads tolerate bad STORED data — and now REPORT it.
    const { task: payload, diagnostics } =
        normalizeCoordinationTaskRecordWithDiagnostics(
            readJson(targetPath, defaultCoordinationTaskPayload(taskID)),
            taskID,
        );
    return {
        task_id: taskID,
        path: targetPath,
        payload,
        exists: true,
        diagnostics,
    };
}

// Internal scan boundary: read every card in the registry and preserve the
// per-card diagnostics (degradation evidence) alongside the normalized task.
// This is the single read-path point that knows a card is degraded; the
// public listCoordinationTasks() publishes it as `quarantine[]` and the
// action boundary (readyCoordinationTask) refuses degraded cards. Each entry
// carries the repo-relative path so a quarantine row is safe to display
// without leaking absolute operator-local paths.
//
// Syntax-invalid quarantine: a SINGLE corrupt `.json` file used to brick the
// whole scan, because readJson() throws on a JSON.parse failure and
// loadCoordinationTask() propagated that throw. Different scanner contract
// from the semantic-degradation quarantine (which has a normalized task object
// to report offending_fields against): a syntax-corrupt file cannot be parsed
// at all, so there is no task_id and no offending_fields to report — only the
// filename is recoverable. Here we catch the JSON.parse failure PER CARD,
// emit a filename-level quarantine entry, and CONTINUE scanning the rest.
// Genuine filesystem errors (permission denied, missing directory, IO) are
// RETHROWN so they surface loudly instead of being silently swallowed as a
// "quarantined card" — only JSON parse failures are reported-and-continue.
// This mirrors the normalizeCoordinationEnum -> normalizeCoordinationEnumCollected
// split: the throw lives at readJson (every direct caller), the fault tolerance
// lives at this scan boundary (the only place that scans a whole directory and
// must not let one bad file poison the rest).
function scanCoordinationTaskCards() {
    ensureLocalCoordinatorNamespace();
    const files = fs.existsSync(localCoordinatorTasksRoot())
        ? fs.readdirSync(localCoordinatorTasksRoot())
        : [];
    const scanned = files
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
            const taskID = name.replace(/\.json$/, "");
            const targetPath = coordinationTaskPath(taskID);
            try {
                const loaded = loadCoordinationTask(taskID);
                return {
                    taskID,
                    path: relativeToRepo(loaded.path),
                    task: loaded.payload,
                    diagnostics: loaded.diagnostics,
                    degraded: Boolean(loaded.diagnostics && loaded.diagnostics.degraded),
                };
            } catch (error) {
                // Catch JSON.parse failures ONLY. readJson attaches the
                // original error as `.cause`, so a genuine SyntaxError
                // (corrupt JSON) is distinguishable from a filesystem error
                // (permission denied / missing / IO) that surfaced inside
                // readJson's try block. Genuine fs errors are rethrown.
                if (!isCoordinationCardSyntaxError(error)) {
                    throw error;
                }
                return {
                    taskID,
                    path: relativeToRepo(targetPath),
                    // No task object is recoverable from an unparseable file;
                    // null keeps the array consumers (listCoordinationTaskCards,
                    // resolveRecurrenceDedup, listCoordinationTasks) honest —
                    // they must treat a syntax entry as "not a card" and route
                    // it into quarantine[] only.
                    task: null,
                    diagnostics: null,
                    degraded: true,
                    syntaxError: true,
                    problems: [coordinationCardSyntaxMessage(error)],
                };
            }
        });
    return scanned.sort((left, right) => {
        const leftTask = left && left.task ? left.task : null;
        const rightTask = right && right.task ? right.task : null;
        const leftUpdated = String(
            (leftTask && (leftTask.updated_at || leftTask.created_at)) || "",
        );
        const rightUpdated = String(
            (rightTask && (rightTask.updated_at || rightTask.created_at)) || "",
        );
        return rightUpdated.localeCompare(leftUpdated);
    });
}

/**
 * Classify an error thrown while scanning a single coordination-task card as a
 * JSON.parse (syntax) failure. Returns true ONLY when the error is the
 * StateError readJson emits for malformed JSON AND its `.cause` is a genuine
 * SyntaxError — the signature of JSON.parse rejecting corrupt input. Any other
 * error (a filesystem SystemError with `.code`, a missing-file StateError from
 * a TOCTOU race, anything without a SyntaxError cause) returns false so the
 * scan boundary rethrows it instead of swallowing a real failure as a
 * "quarantined card".
 *
 * @param {*} error
 * @returns {boolean}
 */
function isCoordinationCardSyntaxError(error) {
    if (!(error instanceof StateError)) {
        return false;
    }
    const message = String(error.message || "");
    if (!message.startsWith("Malformed JSON state file:")) {
        return false;
    }
    return error.cause instanceof SyntaxError;
}

/**
 * Extract a stable, human-readable message from a JSON.parse failure caught at
 * the scan boundary. Prefers the original SyntaxError's message (the parser's
 * own positioning text) so a quarantine row points the operator at the defect;
 * falls back to a generic label if the cause is unexpectedly absent.
 *
 * @param {*} error
 * @returns {string}
 */
function coordinationCardSyntaxMessage(error) {
    const cause = error && error.cause;
    const text =
        cause && typeof cause.message === "string" && cause.message.trim()
            ? cause.message.trim()
            : "Invalid JSON (parse failure).";
    return text;
}

// Trusted projection: every NON-degraded card's normalized task. Degraded
// cards are excluded so a defaulted/empty status or core field cannot
// produce false overlap findings or otherwise contaminate a consumer that
// trusts the listed cards as healthy. The two pre-slice consumers were
// detectCoordinationTaskOverlaps (wants healthy only) and listCoordinationTasks
// (now uses scanCoordinationTaskCards directly so it can keep degraded cards
// in tasks[] for compat while still excluding them from healthy_* counts).
// Callers that need degraded cards MUST use scanCoordinationTaskCards.
function listCoordinationTaskCards() {
    return scanCoordinationTaskCards()
        .filter((entry) => !entry.degraded)
        .map((entry) => entry.task);
}

function updateCoordinationTask(taskIDRaw, updateFn) {
    ensureLocalCoordinatorNamespace();
    const taskID = normalizeCoordinationTaskId(taskIDRaw);
    const targetPath = coordinationTaskPath(taskID);
    const lockPath = coordinationTaskLockPath(taskID);
    return withLock(lockPath, () => {
        const current = loadCoordinationTask(taskID, {
            required: false,
        }).payload;
        const updated = normalizeCoordinationTaskRecord(
            updateFn({
                ...current,
                latest_report: current.latest_report
                    ? { ...current.latest_report }
                    : null,
                last_review: current.last_review
                    ? { ...current.last_review }
                    : null,
                history: Array.isArray(current.history)
                    ? current.history.map((entry) => ({ ...entry }))
                    : [],
            }) || current,
            taskID,
        );
        updated.schema_version = SCHEMA_VERSION;
        updated.task_id = taskID;
        updated.created_at = updated.created_at || current.created_at || isoZ();
        updated.updated_at = isoZ();
        ensureCoordinationTaskCoreFields(updated);
        atomicWriteJson(targetPath, updated);
        // defer-003: any successful canonical coordinator-task WRITE (create,
        // update, ready, closeout, review, repair, activate — every public op
        // routes through this single chokepoint) seeds the committed
        // coordinator-adoption marker (unmanaged — runtime-created,
        // template-less, never renderer-seeded; idempotent
        // create-if-absent — NEVER overwrite an existing marker). A WRITE is
        // the act of adoption (matrix row-2 semantics); mere file presence is
        // not. Its presence flips the release gate's defer-liveness check from
        // SKIP (greenfield) to authoritative: a later whole-directory loss of
        // .local/coordinator/tasks/ then FAILs (fail-closed) instead of
        // silently SKIPping. Wrapped in try/catch so a marker write failure can
        // never break a task save that has already succeeded — the marker is a
        // gate signal, not a correctness precondition for the save itself.
        try {
            const markerPath = path.join(repoRoot(), ".vh-agent-harness", "coordinator-adoption.json");
            if (!fs.existsSync(markerPath)) {
                ensureDir(path.dirname(markerPath));
                fs.writeFileSync(
                    markerPath,
                    JSON.stringify({ version: 1, adopted: true }, null, 2) + "\n",
                    "utf8",
                );
            }
        } catch (_markerErr) {
            // Non-fatal: see comment above.
        }
        return updated;
    });
}

/**
 * Collect (without throwing) the status-transition validation problem, if any.
 * Returns an array of 0 or 1 message so it composes with other collectors.
 *
 * @param {string} currentStatus
 * @param {string} nextStatus
 * @param {object} [options]
 * @param {boolean} [options.created]
 * @returns {string[]}
 */
function coordinationTaskStatusTransitionErrors(currentStatus, nextStatus, options = {}) {
    const current = String(currentStatus || "").trim() || "draft";
    const next = String(nextStatus || "").trim() || current;
    if (options.created) {
        if (!["draft", "ready"].includes(next)) {
            return ["New task cards must start in draft or ready."];
        }
        return [];
    }
    if (current !== next) {
        return [
            `Use dedicated lifecycle commands to move coordination tasks from ${current} to ${next}.`,
        ];
    }
    return [];
}

function assertSaveCoordinationTaskStatusTransition(
    currentStatus,
    nextStatus,
    options = {},
) {
    throwCollectedErrors(
        coordinationTaskStatusTransitionErrors(currentStatus, nextStatus, options),
    );
}

function detectCoordinationTaskOverlaps(taskID, filesInScope) {
    if (!filesInScope.length) {
        return [];
    }
    const currentFiles = normalizeFileScope(filesInScope);
    return listCoordinationTaskCards()
        .filter((task) => task.task_id !== taskID)
        .filter((task) => OPEN_COORDINATION_TASK_STATUSES.has(task.status))
        .map((task) => {
            const shared_paths = [];
            for (const left of currentFiles) {
                for (const right of task.files_in_scope || []) {
                    if (scopePathsOverlap(left, right)) {
                        shared_paths.push(left === right ? left : `${left} <> ${right}`);
                    }
                }
            }
            if (!shared_paths.length) {
                return null;
            }
            return {
                task_id: task.task_id,
                title: task.title,
                status: task.status,
                shared_paths: uniqueStrings(shared_paths),
            };
        })
        .filter(Boolean);
}

function formatCoordinationReportMarkdown({
    taskID,
    title,
    status,
    reportEnvelope,
    coordinationMode,
    primaryLane,
    sessionName,
    createdAt,
    cwd,
    sessionID,
    body,
    backlogID,
    workstreamSlug,
    promotionRecommended,
}) {
    const normalizedBody = String(body || "").trim();
    if (!normalizedBody) {
        throw new StateError(
            "Coordination report body is empty. Refuse to save an empty closeout report.",
        );
    }
    const frontmatter = [
        ["kind", "coordination_report"],
        ["report_kind", "closeout"],
        ["task_id", taskID],
        ["title", title],
        ["status", status],
        ["report_envelope", reportEnvelope],
        ["coordination_mode", coordinationMode],
        ["primary_lane", primaryLane],
        ["session_name", sessionName || ""],
        ["created_at", createdAt],
        ["cwd", cwd],
        ["session_id", sessionID],
        ["backlog_id", backlogID || ""],
        ["workstream_slug", workstreamSlug || ""],
        ["promotion_recommended", promotionRecommended ? "true" : "false"],
    ];
    return [
        "---",
        ...frontmatter
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => `${key}: ${yamlScalar(value)}`),
        "---",
        "",
        normalizedBody,
        "",
    ].join("\n");
}

function formatCoordinationReviewMarkdown({
    taskID,
    title,
    status,
    sessionName,
    createdAt,
    cwd,
    sessionID,
    body,
    nextAction,
}) {
    const normalizedBody = String(body || "").trim();
    if (!normalizedBody) {
        throw new StateError(
            "Coordination review body is empty. Refuse to save an empty review artifact.",
        );
    }
    const frontmatter = [
        ["kind", "coordination_report"],
        ["report_kind", "review"],
        ["task_id", taskID],
        ["title", title],
        ["status", status],
        ["session_name", sessionName || ""],
        ["created_at", createdAt],
        ["cwd", cwd],
        ["session_id", sessionID],
        ["next_action", nextAction || ""],
    ];
    return [
        "---",
        ...frontmatter
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => `${key}: ${yamlScalar(value)}`),
        "---",
        "",
        normalizedBody,
        "",
    ].join("\n");
}

function parseCoordinationReport(reportPath, options = {}) {
    const targetPath = normalizeRepoPath(reportPath);
    const parsed = parseFrontmatter(fs.readFileSync(targetPath, "utf8"));
    const summary = summarizeMarkdownExcerpt(parsed.body, 8);
    const result = {
        id: path.basename(targetPath, ".md"),
        path: relativeToRepo(targetPath),
        frontmatter: parsed.frontmatter,
        title:
            parsed.frontmatter.title ||
            titleFromSlug(path.basename(targetPath, ".md")),
        status: parsed.frontmatter.status || null,
        report_envelope: parsed.frontmatter.report_envelope || null,
        created_at: parsed.frontmatter.created_at || null,
        summary,
    };
    if (options.includeBody) {
        result.body = parsed.body;
    }
    return result;
}

function parseCoordinationReview(reviewPath, options = {}) {
    const targetPath = normalizeRepoPath(reviewPath);
    const parsed = parseFrontmatter(fs.readFileSync(targetPath, "utf8"));
    const summary = summarizeMarkdownExcerpt(parsed.body, 8);
    const result = {
        id: path.basename(targetPath, ".md"),
        path: relativeToRepo(targetPath),
        frontmatter: parsed.frontmatter,
        title:
            parsed.frontmatter.title ||
            titleFromSlug(path.basename(targetPath, ".md")),
        status: parsed.frontmatter.status || null,
        reviewed_at: parsed.frontmatter.created_at || null,
        next_action: parsed.frontmatter.next_action || "",
        summary,
    };
    if (options.includeBody) {
        result.body = parsed.body;
    }
    return result;
}


// resolveHarnessBinary picks the vh-agent-harness binary to invoke for the
// recurrence dedup bridge. Resolution order:
//   1. env VH_AGENT_HARNESS_BIN (explicit override; tests use this)
//   2. repo-relative bin/vh-agent-harness (dev/dogfood: freshly built)
//   3. "vh-agent-harness" on PATH (consumer install)
// Returns null only if no explicit override and no repo bin exists and the
// bare name is not on PATH (checked lazily by execFileSync later).
function resolveHarnessBinary() {
    const envBin = (process.env.VH_AGENT_HARNESS_BIN || "").trim();
    if (envBin) return envBin;
    const repoBin = path.join(repoRoot(), "bin", "vh-agent-harness");
    if (fs.existsSync(repoBin)) return repoBin;
    return "vh-agent-harness"; // PATH fallback; execFileSync searches PATH
}

// resolveRecurrenceDedup consults the Go derivation via `vh-agent-harness
// recurrence dedup` to decide whether an incoming recurrence-bearing card is a
// REPEAT of a known canonical (merge → the producer updates the canonical
// instead of spawning) or a new defect (new_card → write fresh).
//
// FAIL-CLOSED: if the binary is unavailable, the scan errors, or the response
// is malformed, this THROWS rather than returning a new_card decision. A
// fail-open to new_card would silently spawn a SECOND card for one
// effective_recurrence_id, violating the slice's defining N→1 invariant.
// Fail-closed forces the caller to see the error and retry; the release gate
// (Slice 5) provides additional fail-closed enforcement on unadjudicated
// recurrences.
//
// @param {{task_id: string, recurrence: object}} incomingCard
// @returns {{action: string, effective_id: string, canonical_task_id: string, merged: ?object}}
// @throws {Error} if the bridge scan, binary execution, or response parsing fails
function resolveRecurrenceDedup(incomingCard) {
    // Scan existing recurrence-bearing cards (exclude the incoming card itself
    // so an update to an existing card does not "merge" it with itself).
    let existingCards;
    try {
        const scanned = scanCoordinationTaskCards();
        existingCards = scanned
            .filter(
                (entry) =>
                    !entry.degraded &&
                    entry.task &&
                    entry.task.recurrence &&
                    entry.taskID !== incomingCard.task_id,
            )
            .map((entry) => ({
                task_id: entry.taskID,
                recurrence: entry.task.recurrence,
            }));
    } catch (e) {
        throw new Error(
            `recurrence dedup scan failed (cannot determine merge target; fail-closed): ${e && e.message ? e.message : e}`,
        );
    }

    const bin = resolveHarnessBinary();
    let raw;
    try {
        raw = execFileSync(
            bin,
            ["recurrence", "dedup"],
            {
                input: JSON.stringify({
                    incoming: {
                        task_id: incomingCard.task_id,
                        recurrence: incomingCard.recurrence,
                    },
                    existing: existingCards,
                }),
                encoding: "utf8",
                timeout: 10000,
                stdio: ["pipe", "pipe", "ignore"],
            },
        );
    } catch (e) {
        throw new Error(
            `recurrence dedup bridge failed — binary unavailable or timed out (cannot determine merge target; fail-closed): ${e && e.message ? e.message : e}`,
        );
    }

    let decision;
    try {
        decision = JSON.parse(raw);
    } catch (e) {
        throw new Error(
            `recurrence dedup bridge returned malformed JSON (fail-closed): ${e && e.message ? e.message : e}`,
        );
    }

    if (decision && decision.action === "new_card") {
        return decision; // valid: bridge ran successfully, no match
    }
    if (
        decision &&
        decision.action === "merge" &&
        decision.merged &&
        typeof decision.merged === "object" &&
        decision.canonical_task_id
    ) {
        return decision; // valid: bridge ran successfully, match found
    }
    // Unknown action or structurally incomplete merge decision.
    throw new Error(
        `recurrence dedup bridge returned unexpected response (fail-closed): ${raw.slice(0, 200)}`,
    );
}

// normalizeRecurrenceBlockForWrite validates an incoming recurrence block
// against the task-card schema contract (task-card.schema.json, the
// top-level `recurrence` property — cited by NAME, not line range; the
// decision_record subschema above it shifts lines as the schema evolves)
// BEFORE it reaches the persisted record. The schema requires:
//   - string recurrence_id (minLength 1) — NO type coercion
//   - string symptom_class_id (^recurrence.v1/.+$)
//   - integer recurrence_count >= 0, last_acknowledged_count >= 0
//   - ack-pair invariant recurrence_count >= last_acknowledged_count
//   - additionalProperties:false at block, evidence[], and aliases[] levels
//
// This is WRITE-BOUNDARY validation (producer convenience), NOT gate-wired
// schema enforcement (defer-018, Slice 5). It prevents a caller from
// persisting a malformed recurrence block that would violate the schema.
// On success, returns a FRESHLY-CONSTRUCTED conforming object (only known
// properties, so no unexpected keys leak to disk). On failure, throws an
// Error listing every validation problem.
//
// @param {object} recurrence
// @returns {object} a schema-conforming recurrence block
// @throws {Error} if the block violates the schema contract
function normalizeRecurrenceBlockForWrite(recurrence) {
    if (
        typeof recurrence !== "object" ||
        recurrence === null ||
        Array.isArray(recurrence)
    ) {
        throw new Error("recurrence must be an object");
    }
    const problems = [];

    // --- Top-level type checks (strict — no String() coercion) ---
    if (
        typeof recurrence.recurrence_id !== "string" ||
        recurrence.recurrence_id.trim() === ""
    ) {
        problems.push(
            "recurrence_id must be a non-empty string.",
        );
    }
    if (
        typeof recurrence.symptom_class_id !== "string" ||
        !/^recurrence\.v1\/.+$/.test(recurrence.symptom_class_id)
    ) {
        problems.push(
            "symptom_class_id must be a string matching ^recurrence.v1/<class>.",
        );
    }
    if (
        !Number.isInteger(recurrence.recurrence_count) ||
        recurrence.recurrence_count < 0
    ) {
        problems.push("recurrence_count must be a non-negative integer.");
    }
    if (
        !Number.isInteger(recurrence.last_acknowledged_count) ||
        recurrence.last_acknowledged_count < 0
    ) {
        problems.push(
            "last_acknowledged_count must be a non-negative integer.",
        );
    }
    if (
        Number.isInteger(recurrence.recurrence_count) &&
        Number.isInteger(recurrence.last_acknowledged_count) &&
        recurrence.recurrence_count < recurrence.last_acknowledged_count
    ) {
        problems.push(
            "ack-pair invariant violated: recurrence_count < last_acknowledged_count.",
        );
    }

    // --- Top-level additionalProperties: false ---
    const BLOCK_ALLOWED = new Set([
        "recurrence_id",
        "symptom_class_id",
        "recurrence_count",
        "last_acknowledged_count",
        "evidence",
        "aliases",
    ]);
    for (const key of Object.keys(recurrence)) {
        if (!BLOCK_ALLOWED.has(key))
            problems.push(
                `unknown property "${key}" (additionalProperties: false).`,
            );
    }

    // --- evidence[] items (additionalProperties: false on each item) ---
    const EVIDENCE_ALLOWED = new Set([
        "kind",
        "ref",
        "note",
        "capability",
        "outcome",
        "commit_subject",
        "commit_range",
    ]);
    if (recurrence.evidence !== undefined) {
        if (!Array.isArray(recurrence.evidence)) {
            problems.push("evidence must be an array.");
        } else {
            recurrence.evidence.forEach((e, i) => {
                if (
                    typeof e !== "object" ||
                    e === null ||
                    Array.isArray(e)
                ) {
                    problems.push(`evidence[${i}] must be an object.`);
                    return;
                }
                if (typeof e.kind !== "string" || e.kind.trim() === "")
                    problems.push(
                        `evidence[${i}].kind must be a non-empty string.`,
                    );
                if (typeof e.ref !== "string" || e.ref.trim() === "")
                    problems.push(
                        `evidence[${i}].ref must be a non-empty string.`,
                    );
                for (const opt of [
                    "note",
                    "capability",
                    "outcome",
                    "commit_subject",
                    "commit_range",
                ]) {
                    if (e[opt] !== undefined && typeof e[opt] !== "string")
                        problems.push(
                            `evidence[${i}].${opt} must be a string if present.`,
                        );
                }
                for (const key of Object.keys(e)) {
                    if (!EVIDENCE_ALLOWED.has(key))
                        problems.push(
                            `evidence[${i}] unknown property "${key}" (additionalProperties: false).`,
                        );
                }
            });
        }
    }

    // --- aliases[] items (additionalProperties: false on each item) ---
    const ALIAS_ALLOWED = new Set(["recurrence_id", "superseded", "note"]);
    if (recurrence.aliases !== undefined) {
        if (!Array.isArray(recurrence.aliases)) {
            problems.push("aliases must be an array.");
        } else {
            recurrence.aliases.forEach((a, i) => {
                if (
                    typeof a !== "object" ||
                    a === null ||
                    Array.isArray(a)
                ) {
                    problems.push(`aliases[${i}] must be an object.`);
                    return;
                }
                if (
                    typeof a.recurrence_id !== "string" ||
                    a.recurrence_id.trim() === ""
                )
                    problems.push(
                        `aliases[${i}].recurrence_id must be a non-empty string.`,
                    );
                if (
                    a.superseded !== undefined &&
                    typeof a.superseded !== "boolean"
                )
                    problems.push(
                        `aliases[${i}].superseded must be a boolean if present.`,
                    );
                if (a.note !== undefined && typeof a.note !== "string")
                    problems.push(
                        `aliases[${i}].note must be a string if present.`,
                    );
                for (const key of Object.keys(a)) {
                    if (!ALIAS_ALLOWED.has(key))
                        problems.push(
                            `aliases[${i}] unknown property "${key}" (additionalProperties: false).`,
                        );
                }
            });
        }
    }

    if (problems.length) {
        throw new Error(
            `recurrence validation failed: ${problems.length} problem(s):\n${problems.map((p, i) => `${i + 1}. ${p}`).join("\n")}`,
        );
    }

    // Return a FRESHLY-CONSTRUCTED conforming object so no unexpected
    // properties from the input leak to the persisted record.
    const out = {
        recurrence_id: recurrence.recurrence_id,
        symptom_class_id: recurrence.symptom_class_id,
        recurrence_count: recurrence.recurrence_count,
        last_acknowledged_count: recurrence.last_acknowledged_count,
    };
    if (recurrence.evidence !== undefined) {
        out.evidence = recurrence.evidence.map((e) => {
            const eo = { kind: e.kind, ref: e.ref };
            for (const opt of [
                "note",
                "capability",
                "outcome",
                "commit_subject",
                "commit_range",
            ]) {
                if (e[opt] !== undefined) eo[opt] = e[opt];
            }
            return eo;
        });
    }
    if (recurrence.aliases !== undefined) {
        out.aliases = recurrence.aliases.map((a) => {
            const ao = { recurrence_id: a.recurrence_id };
            if (a.superseded !== undefined) ao.superseded = a.superseded;
            if (a.note !== undefined) ao.note = a.note;
            return ao;
        });
    }
    return out;
}

function saveCoordinationTask(sessionID, taskPayload, options = {}) {
    const actor = coordinationActorContext(sessionID, options);
    const input = taskPayload && typeof taskPayload === "object" ? taskPayload : {};
    const explicitNextAction =
        input.next_action !== undefined
            ? String(input.next_action || "").trim()
            : null;
    const explicitTaskID = String(input.task_id || "").trim();
    const requestedTaskID = explicitTaskID
        ? normalizeCoordinationTaskId(explicitTaskID)
        : generateCoordinationTaskId(input.title || "task");

    // --- Write-boundary recurrence validation ---
    // Validate the recurrence block BEFORE any dedup processing so no durable
    // card carries an invalid acknowledgement pair (schema contract:
    // task-card.schema.json, the top-level `recurrence` property). This is
    // producer convenience, NOT
    // gate-wired schema enforcement (defer-018, Slice 5). A recurrence block
    // that is undefined or null passes through unchanged (legacy / remove).
    let validatedRecurrence = input.recurrence;
    if (input.recurrence !== undefined && input.recurrence !== null) {
        validatedRecurrence = normalizeRecurrenceBlockForWrite(input.recurrence);
    }

    // --- Recurrence dedup (P1-MEMORY-001 Slice 3, WRITE-LAYER crux) ---
    // If the incoming card carries a recurrence block, consult the Go
    // derivation to decide whether it is a repeat of a known canonical (merge
    // → update the canonical instead of spawning) or a new defect (new_card →
    // write fresh). On merge, the write is redirected to the canonical task_id
    // so NO new card is spawned; the canonical's recurrence block is updated
    // with the merged block (count bumped, observation appended, ack held →
    // unacknowledged). The producer APPLIES this convenience; the release gate
    // (Slice 5) is the transition authority.
    let dedup = null;
    let taskID = requestedTaskID;
    if (
        validatedRecurrence &&
        typeof validatedRecurrence === "object" &&
        String(validatedRecurrence.recurrence_id || "").trim()
    ) {
        dedup = resolveRecurrenceDedup({
            task_id: requestedTaskID,
            recurrence: validatedRecurrence,
        });
        if (dedup.action === "merge" && dedup.canonical_task_id) {
            taskID = dedup.canonical_task_id; // redirect to canonical
        }
    }
    const isMerge = Boolean(dedup && dedup.action === "merge" && dedup.canonical_task_id);

    const existing = loadCoordinationTask(taskID, { required: false });
    const created = !existing.exists;

    // MERGE PATH (recurrence repeat): update the canonical's recurrence block
    // + append a recurrence_merged history event. The canonical's
    // non-recurrence fields (title, status, scope, …) are AUTHORITY — the
    // repeat's identity folds in ONLY via the merged recurrence block
    // (count bumped, observation appended, ack held → unacknowledged). No
    // new card is spawned; the incoming requestedTaskID is intentionally
    // NOT persisted as a separate card.
    //
    // TOCTOU guard: the dedup decision (which canonical) is stable, but the
    // merged block's recurrence_count was computed from a scan OUTSIDE the
    // per-card lock. If a concurrent save bumped the canonical's count between
    // the scan and lock acquisition, re-resolve from the lock-time state
    // inside the callback. This narrows (does not eliminate) the race window;
    // full concurrency integrity is the Slice 5 release-gate authority (the
    // producer is convenience, not authority — see DEFER card
    // defer-recurrence-toctou-race).
    if (isMerge) {
        // --- TEST-ONLY pre-lock interleaving seam (TOCTOU guard exercise) ---
        // The dedup decision (which canonical) and the merged block were
        // computed from a scan OUTSIDE the per-card lock acquired inside
        // updateCoordinationTask below — the TOCTOU window this producer's
        // lock-time re-resolve guard narrows. This optional, per-call,
        // synchronous callback fires exactly once at the after-decision /
        // before-lock boundary so a verifier can mutate the canonical via
        // the real producer (saveCoordinationTask) and exercise the
        // lock-time re-resolve → throw wiring deterministically.
        //
        // Containment contract (enforced by construction):
        //  - per-call: passed via the options arg only; NOT an env var.
        //  - inert by default: every production + existing-test caller omits it.
        //  - synchronous, invoked at most once (single merge path, single call).
        //  - NOT propagated: the merge path calls updateCoordinationTask
        //    (lock+persist), never saveCoordinationTask; the only nested
        //    saveCoordinationTask is one the callback itself issues, and the
        //    caller controls whether to pass this option there.
        //  - CANNOT override the dedup result, suppress locking, authorize
        //    persistence, or override a thrown guard: the callback only
        //    provides the interleaving opportunity; the re-resolve guard
        //    below remains the sole authority and may still throw.
        if (typeof options._testPreLockInterleave === "function") {
            options._testPreLockInterleave({
                canonical_task_id: dedup.canonical_task_id,
                requested_task_id: requestedTaskID,
            });
        }
        const mergedSaved = updateCoordinationTask(taskID, (current) => {
            let mergedBlock = dedup.merged;
            const currentBlock = current.recurrence;
            if (
                currentBlock &&
                mergedBlock &&
                currentBlock.recurrence_count !==
                    mergedBlock.recurrence_count - 1
            ) {
                // Stale scan: a concurrent save bumped the canonical's count
                // OR changed which card is canonical. Re-resolve from the
                // lock-time state so the count and observations reflect all
                // prior merges. The re-resolve must confirm BOTH a merge AND
                // the same canonical we hold the lock on — if a concurrent
                // writer established a different card as the new canonical,
                // adopting its merged block here would persist a foreign
                // identity into the locked card (identity/history corruption).
                const reDecision = resolveRecurrenceDedup({
                    task_id: requestedTaskID,
                    recurrence: validatedRecurrence,
                });
                if (
                    reDecision.action === "merge" &&
                    reDecision.merged &&
                    reDecision.canonical_task_id === taskID
                ) {
                    mergedBlock = reDecision.merged;
                } else {
                    // Re-resolution did not confirm a merge for THIS canonical.
                    // This can happen when the bridge fails-open (action=
                    // new_card on binary timeout/error), when a genuine state
                    // change means the incoming is no longer a repeat, or when
                    // a concurrent writer established a DIFFERENT card as the
                    // new canonical. ABORT the write instead of persisting the
                    // stale pre-lock mergedBlock, which could overwrite a
                    // concurrent merge and silently lose an observation or
                    // corrupt recurrence identity. atomicWriteJson is never
                    // reached because the callback throws before returning.
                    // The caller can retry the operation.
                    throw new Error(
                        "recurrence merge aborted: lock-time re-resolution could not confirm merge " +
                        "for the locked canonical (possible concurrent write, canonical-identity change, " +
                        "or bridge failure); retry the operation.",
                    );
                }
            }
            return {
                ...current,
                recurrence: mergedBlock,
                history: [
                    ...(current.history || []),
                    {
                        at: isoZ(),
                        event: "recurrence_merged",
                        session_name: actor.session_name,
                        status: current.status,
                        note:
                            `Recurrence repeat merged into canonical from incoming ${requestedTaskID} ` +
                            `(count ${mergedBlock.recurrence_count}, disposition now unacknowledged: count > ack).`,
                    },
                ],
            };
        });
        const mergedOverlaps = detectCoordinationTaskOverlaps(
            mergedSaved.task_id,
            mergedSaved.files_in_scope,
        );
        return {
            ...actor,
            created: false,
            merged_into: dedup.canonical_task_id,
            path: relativeToRepo(coordinationTaskPath(mergedSaved.task_id)),
            task: mergedSaved,
            summary: summarizeCoordinationTask(mergedSaved),
            overlaps: mergedOverlaps,
            ...recommendedCoordinationTaskFields(
                mergedSaved,
                actor.session_name || null,
            ),
        };
    }

    const saved = updateCoordinationTask(taskID, (current) => {
        // Collect every validation problem in this callback before throwing.
        // We never want to partially mutate `next` and then throw, so we
        // accumulate into `errors` and bail once at the very end.
        const errors = [];
        // Tracks enum fields whose provided value was invalid. The core-field
        // "required" checker consults this set so a provided-but-invalid enum
        // field does NOT also emit a false derived "X is required." error
        // (which would turn a single-error payload into a numbered aggregate).
        const enumInvalidFields = new Set();
        const coordinationMode =
            input.coordination_mode !== undefined
                ? normalizeCoordinationEnumCollected(
                      input.coordination_mode,
                      COORDINATION_MODES,
                      "coordination_mode",
                      errors,
                      enumInvalidFields,
                  )
                : current.coordination_mode;
        const reportEnvelope =
            input.report_envelope !== undefined
                ? normalizeCoordinationEnumCollected(
                      input.report_envelope,
                      COORDINATION_REPORT_ENVELOPES,
                      "report_envelope",
                      errors,
                      enumInvalidFields,
                  )
                : current.report_envelope || defaultReportEnvelopeForMode(coordinationMode);
        const nextStatus =
            input.status !== undefined
                ? normalizeCoordinationEnumCollected(
                      input.status,
                      COORDINATION_TASK_STATUSES,
                      "status",
                      errors,
                      enumInvalidFields,
                  )
                : created
                  ? "ready"
                  : current.status || "ready";
        const next = {
            ...current,
            task_id: taskID,
            title:
                input.title !== undefined
                    ? String(input.title || "").trim()
                    : current.title,
            task_type:
                input.task_type !== undefined
                    ? normalizeCoordinationEnumCollected(
                          input.task_type,
                          COORDINATION_TASK_TYPES,
                          "task_type",
                          errors,
                          enumInvalidFields,
                      )
                    : current.task_type,
            coordination_mode: coordinationMode,
            primary_lane:
                input.primary_lane !== undefined
                    ? String(input.primary_lane || "").trim()
                    : current.primary_lane,
            research_question:
                input.research_question !== undefined
                    ? String(input.research_question || "").trim()
                    : current.research_question,
            source_policy:
                input.source_policy !== undefined
                    ? normalizeCoordinationEnumCollected(
                          input.source_policy,
                          RESEARCH_SOURCE_POLICIES,
                          "source_policy",
                          errors,
                          enumInvalidFields,
                      ) || null
                    : current.source_policy,
            source_allowlist:
                input.source_allowlist !== undefined
                    ? normalizeStringList(input.source_allowlist)
                    : current.source_allowlist,
            desired_artifact_type:
                input.desired_artifact_type !== undefined
                    ? normalizeCoordinationEnumCollected(
                          input.desired_artifact_type,
                          RESEARCH_ARTIFACT_TYPES,
                          "desired_artifact_type",
                          errors,
                          enumInvalidFields,
                      ) || null
                    : current.desired_artifact_type,
            target_artifact_path:
                input.target_artifact_path !== undefined
                    ? normalizeOptionalText(input.target_artifact_path)
                    : current.target_artifact_path,
            rough_scope:
                input.rough_scope !== undefined
                    ? normalizeStringList(input.rough_scope)
                    : current.rough_scope,
            open_questions:
                input.open_questions !== undefined
                    ? normalizeStringList(input.open_questions)
                    : current.open_questions,
            ready_criteria:
                input.ready_criteria !== undefined
                    ? normalizeStringList(input.ready_criteria)
                    : current.ready_criteria,
            files_in_scope:
                input.files_in_scope !== undefined
                    ? normalizeFileScope(input.files_in_scope)
                    : current.files_in_scope,
            constraints:
                input.constraints !== undefined
                    ? normalizeStringList(input.constraints)
                    : current.constraints,
            non_goals:
                input.non_goals !== undefined
                    ? normalizeStringList(input.non_goals)
                    : current.non_goals,
            success_criteria:
                input.success_criteria !== undefined
                    ? normalizeStringList(input.success_criteria)
                    : current.success_criteria,
            validation_plan:
                input.validation_plan !== undefined
                    ? normalizeStringList(input.validation_plan)
                    : current.validation_plan,
            report_envelope: reportEnvelope,
            backlog_id:
                input.backlog_id !== undefined
                    ? normalizeOptionalText(input.backlog_id)
                    : current.backlog_id,
            workstream_slug:
                input.workstream_slug !== undefined
                    ? normalizeOptionalWorkstream(input.workstream_slug)
                    : current.workstream_slug,
            dependencies:
                input.dependencies !== undefined
                    ? normalizeStringList(input.dependencies)
                    : current.dependencies,
            owner_notes:
                input.owner_notes !== undefined
                    ? normalizeStringList(input.owner_notes)
                    : current.owner_notes,
            recurrence:
                validatedRecurrence !== undefined
                    ? validatedRecurrence
                    : current.recurrence,
            status: nextStatus,
            next_action:
                explicitNextAction !== null
                    ? explicitNextAction
                    : created || nextStatus !== current.status
                      ? defaultCoordinationTaskNextAction(taskID, nextStatus)
                      : current.next_action ||
                        defaultCoordinationTaskNextAction(taskID, nextStatus),
            history: [
                ...(current.history || []),
                {
                    at: isoZ(),
                    event: created ? "task_created" : "task_updated",
                    session_name: actor.session_name,
                    status: nextStatus,
                    note: created
                        ? "Created local coordination task card."
                        : "Updated local coordination task card.",
                },
            ],
        };
        // Only check lifecycle transition when status is a recognized enum
        // value; otherwise the enum check above already covered it and we
        // would otherwise double-report the same root cause.
        if (COORDINATION_TASK_STATUSES.includes(next.status)) {
            errors.push(
                ...coordinationTaskStatusTransitionErrors(current.status, next.status, {
                    created,
                }),
            );
        }
        if (!next.report_envelope && next.coordination_mode) {
            next.report_envelope = defaultReportEnvelopeForMode(
                next.coordination_mode,
            );
        }
        errors.push(
            ...collectCoordinationTaskCoreFieldErrors(next, {
                enumInvalidFields,
            }),
        );
        throwCollectedErrors(errors);
        // null recurrence = explicit removal: delete the property entirely
        // so the persisted card does not carry a schema-invalid
        // `recurrence: null` (the schema requires type:object; nullable
        // fields elsewhere use [type,null] — recurrence does not).
        if (validatedRecurrence === null) {
            delete next.recurrence;
        }
        return next;
    });
    const overlaps = detectCoordinationTaskOverlaps(
        saved.task_id,
        saved.files_in_scope,
    );
    return {
        ...actor,
        created,
        path: relativeToRepo(coordinationTaskPath(saved.task_id)),
        task: saved,
        summary: summarizeCoordinationTask(saved),
        overlaps,
        ...recommendedCoordinationTaskFields(saved, actor.session_name || null),
    };
}

function readCoordinationTask(sessionID, taskIDRaw, options = {}) {
    const actor = coordinationActorContext(sessionID, options);
    const loaded = loadCoordinationTask(taskIDRaw);
    const latestReport = loaded.payload.latest_report &&
        loaded.payload.latest_report.path
        ? parseCoordinationReport(loaded.payload.latest_report.path, {
              includeBody: Boolean(options.includeBody),
          })
        : null;
    const lastReview = loaded.payload.last_review &&
        loaded.payload.last_review.path
        ? parseCoordinationReview(loaded.payload.last_review.path, {
              includeBody: Boolean(options.includeBody),
          })
        : null;
    const degraded = Boolean(loaded.diagnostics && loaded.diagnostics.degraded);
    // Map internal diagnostics to public-facing field names so the
    // single-card read is consistent with the quarantine entries in
    // listCoordinationTasks (offending_fields, problems — snake_case).
    const diagnostics = loaded.diagnostics
        ? {
              degraded: loaded.diagnostics.degraded,
              offending_fields: [...loaded.diagnostics.offendingFields],
              problems: [...loaded.diagnostics.problems],
          }
        : {
              degraded: false,
              offending_fields: [],
              problems: [],
          };
    return {
        ...actor,
        path: relativeToRepo(loaded.path),
        task: loaded.payload,
        summary: summarizeCoordinationTask(loaded.payload),
        degraded,
        diagnostics,
        latest_report: latestReport,
        last_review: lastReview,
        overlaps: detectCoordinationTaskOverlaps(
            loaded.payload.task_id,
            loaded.payload.files_in_scope,
        ),
        ...recommendedCoordinationTaskFields(
            loaded.payload,
            actor.session_name || null,
            { degraded },
        ),
    };
}

function listCoordinationTasks(sessionID, options = {}) {
    const actor = coordinationActorContext(sessionID, options);
    const statuses = normalizeStringList(options.statuses || []).map((value) =>
        normalizeCoordinationEnum(
            value,
            COORDINATION_TASK_STATUSES,
            "task_statuses",
        ),
    );
    // Scan preserves per-card degradation diagnostics. The public response
    // keeps degraded cards in `tasks` (compat — no data disappears) while
    // also surfacing them in `quarantine` and excluding them from the
    // `healthy_*` counts. The status filter applies to the NORMALIZED status
    // (a degraded status coerces to "draft"), matching the pre-slice filter
    // semantics; the safeguard against acting on a degraded card is the
    // action-boundary refusal in readyCoordinationTask plus the degraded flag
    // on the task representation, not omission from the list.
    //
    // Syntax-invalid (unparseable) files carry no task object — they are
    // excluded from the status filter (there is no status to match), from
    // `tasks`, and from every count, but they ARE surfaced in `quarantine[]`
    // with error_type:"syntax" so a single corrupt `.json` no longer bricks
    // the scan AND is still reported. The status filter intentionally does
    // NOT gate syntax entries: a corrupt file is a problem regardless of any
    // requested status subset.
    const scanned = scanCoordinationTaskCards();
    const syntaxEntries = scanned.filter((entry) => entry.syntaxError);
    const filteredScanned = scanned.filter((entry) => {
        if (!entry.task) {
            return false;
        }
        return statuses.length ? statuses.includes(entry.task.status) : true;
    });
    const tasks = filteredScanned.map((entry) => entry.task);
    const counts = {};
    for (const task of tasks) {
        counts[task.status] = (counts[task.status] || 0) + 1;
    }
    // Healthy (non-degraded) projection for the additive counts. Degraded
    // cards are excluded so a dashboard reading healthy_status_counts cannot
    // mistake a coerced-to-draft degraded card for a genuine draft.
    const healthyTasks = filteredScanned
        .filter((entry) => !entry.degraded)
        .map((entry) => entry.task);
    const healthyCounts = {};
    for (const task of healthyTasks) {
        healthyCounts[task.status] = (healthyCounts[task.status] || 0) + 1;
    }
    // Semantic quarantine: degraded-but-parseable cards (bad stored enum or
    // missing core field). Unchanged from the report-and-continue contract —
    // each carries offending_fields from the normalized task's diagnostics.
    const semanticQuarantine = filteredScanned
        .filter((entry) => entry.degraded)
        .map((entry) => ({
            // card_id comes from the parsed card when the task_id is
            // trustworthy (it always is here — the id is derived from the
            // filename, not from the possibly-corrupt card body); fall back
            // to the filename stem otherwise. Both equal entry.taskID today.
            card_id: entry.task.task_id || entry.taskID,
            path: entry.path,
            error_type: "semantic",
            offending_fields: [...entry.diagnostics.offendingFields],
            problems: [...entry.diagnostics.problems],
        }));
    // Syntax quarantine: unparseable files. No normalized task exists, so
    // there is no card_id recoverable from the body and no offending_fields
    // to report — the filename stem is the only stable key and the parse
    // error message is the only diagnostic. error_type:"syntax" lets a
    // consumer render these differently from semantic-degraded cards.
    const syntaxQuarantine = syntaxEntries.map((entry) => ({
        card_id: entry.taskID,
        path: entry.path,
        error_type: "syntax",
        offending_fields: [],
        problems: [...entry.problems],
    }));
    const quarantine = [...semanticQuarantine, ...syntaxQuarantine];
    return {
        ...actor,
        // Existing counts are UNCHANGED (compat): they cover every card that
        // passed the status filter, degraded or not.
        total: tasks.length,
        status_counts: counts,
        tasks: filteredScanned.map((entry) => ({
            ...summarizeCoordinationTask(entry.task),
            degraded: entry.degraded,
            ...recommendedCoordinationTaskFields(entry.task, actor.session_name || null, {
                degraded: entry.degraded,
            }),
        })),
        // Additive quarantine fields (new). Consumers that never read them
        // behave exactly as before; consumers that want a trusted projection
        // read healthy_total / healthy_status_counts instead of total /
        // status_counts.
        quarantine,
        degraded_count: quarantine.length,
        healthy_total: healthyTasks.length,
        healthy_status_counts: healthyCounts,
    };
}

// =============================================================================
// Landing-proof verifier for completed-card retirement (m0141 Slice 2)
// =============================================================================
// A `completed` transport card may be retired as done ONLY when a reachable
// commit carrying the exact `Task-Card: <card-id>` trailer is present — the
// landing-proof contract (docs/coordination/RECORD_LIFECYCLE.md). The verifier
// is a REACHABILITY check (per the closure-verifier reachability rule,
// researches/decisions/2026-08-04-binding-regression-unification-audit.md
// Addendum): `git log --branches` walks ALL local branch tips (refs/heads/*),
// branch-GENERIC with no hardcoded `main` (mirrors doctor #24's
// `git rev-list --branches`), so a match proves BOTH that the work landed AND
// that it is reachable from a branch — never object existence (`git show` /
// `git cat-file`), which an orphaned or reflog-only commit satisfies while
// being absent from every branch.
//
// The verifier READS git history only (agent-allowed per the git_readonly
// allowlist). It does NOT trust any model-supplied SHA/branch field; the
// card-id↔commit JOIN is provided by the worker-authored `Task-Card:` trailer
// and proven independently by the git-log reachability query. (A gate-appended
// trailer / gate-ledger card-id→commit join is documented future-hardening,
// NOT this slice.) Misattribution (a commit claiming card-X did card-Y's work)
// is a review/correctness concern, not a landing-proof concern — the commit
// still LANDED; out of scope for this verifier.
//
// Fail-closed: if git history cannot be read (not a git repo, git missing,
// timeout), the verifier reports landing NOT confirmed so a completed card is
// never silently retired on an unverifiable surface. The remedy is identical to
// the no-trailer case (add a reachable trailer, or use `force` for genuine
// legacy/emergency cleanup).

// Landing-proof repo root. The production verifier is ALWAYS rooted at
// repoRoot() (the real repo whose branch history proves landing) — there is NO
// ambient override. The retirement test suite redirects the query at a hermetic
// scratch git repo by passing an explicit `repoOverride` argument (via the
// `landingProofRepo` option on deleteCoordinationTask) that the test injects by
// importing state-lib directly; plan-state.js does NOT forward `landingProofRepo`
// from the tool args, so production plan_state calls cannot configure it and an
// ambient process env var cannot redirect the verifier. This is deliberately a
// function-parameter seam (not an env var) so the landing gate — a security gate
// on destructive retirement — is not bypassable via ambient env.

// Verify the landing-proof contract for a completed card. Returns
// { proven, reason, query, commits, detail }. `proven` is true iff ≥1 reachable
// commit carries the exact `Task-Card: <taskID>` trailer line. `reason`
// distinguishes the not-proven cases: "no_trailer_match" (git ran, 0 exact
// matches) vs "verifier_unavailable" (git could not read history). Never throws
// — the caller maps a not-proven result to a structured landing_not_confirmed
// refusal. `repoOverride` is a test-only injection point (see above); production
// omits it and the query runs against repoRoot().
function verifyLandingProof(taskID, repoOverride) {
    const repo = repoOverride || repoRoot();
    const trailerLine = `Task-Card: ${taskID}`;
    // Two-stage EXACT match (the `Task-Card:` trailer is a machine-query key,
    // so the match must be an exact trailer LINE, not a substring — otherwise a
    // commit carrying `Task-Card: alpha-next` would falsely satisfy card
    // `alpha`, since `Task-Card: alpha` is a substring of that line).
    //   stage 1: `--fixed-strings --grep=Task-Card: <id>` narrows to commits
    //            whose message contains the substring (a cheap pre-filter that
    //            may still include prefix collisions like alpha / alpha-next).
    //   stage 2: parse each candidate's full body and require a line whose
    //            trimmed value is EXACTLY the trailer (rejects prefix/substring
    //            collisions).
    // `--branches` walks ALL local branch tips (refs/heads/*) — branch-GENERIC,
    // no hardcoded `main` (mirrors doctor #24's `git rev-list --branches`); a
    // match proves BOTH landing AND reachability, never object existence.
    // Record separators: %x1e (RS) between commits, %x1f (US) between SHA and
    // body — control chars that never cause a false positive (a split fragment
    // lacking the exact line is excluded; one carrying it is included).
    const args = [
        "log",
        "--branches",
        "--fixed-strings",
        `--grep=Task-Card: ${taskID}`,
        "--format=%H%x1f%B%x1e",
    ];
    const query = `git log --branches --fixed-strings --grep=Task-Card: ${taskID} (each candidate post-filtered to an exact "Task-Card: ${taskID}" trailer line)`;
    let stdout = "";
    try {
        stdout = execFileSync("git", args, {
            cwd: repo,
            encoding: "utf8",
            timeout: 10000,
            stdio: ["ignore", "pipe", "ignore"],
        });
    } catch (error) {
        const why =
            error && error.code === "ENOENT"
                ? "git executable not found"
                : error && error.message
                  ? error.message
                  : "git failed";
        return {
            proven: false,
            reason: "verifier_unavailable",
            query,
            commits: [],
            detail: `the landing-proof verifier could not read git history (${why})`,
        };
    }
    const exactCommits = [];
    for (const record of stdout.split("\x1e")) {
        const rec = record.trim();
        if (!rec) continue;
        const sep = rec.indexOf("\x1f");
        const sha = (sep >= 0 ? rec.slice(0, sep) : rec).trim();
        const body = sep >= 0 ? rec.slice(sep + 1) : "";
        const matched = body
            .split(/\r?\n/)
            .some((line) => line.trim() === trailerLine);
        if (matched && sha) {
            exactCommits.push(sha);
        }
    }
    if (exactCommits.length > 0) {
        return {
            proven: true,
            reason: "trailer_reachable",
            query,
            commits: exactCommits,
            detail: `${exactCommits.length} reachable commit(s) carry the exact "Task-Card: ${taskID}" trailer line`,
        };
    }
    return {
        proven: false,
        reason: "no_trailer_match",
        query,
        commits: [],
        detail: `no reachable commit carries the exact "Task-Card: ${taskID}" trailer line`,
    };
}

// =============================================================================
// Retention-preservation gate (decision records) — v3, item-enumerated
// =============================================================================
// Owner-approved 2026-10-25 (gate), 2026-10-26 (v2 coverage + review
// classification), 2026-10-27 (v3 item-enumerated replacement). The
// landing-proof contract above proves the work LANDED; it says nothing
// about whether decision-class knowledge (owner authorizations,
// materially-rejected alternatives, review verdicts, measured outcomes)
// SURVIVES retirement. Retiring a completed card deletes the card AND its
// report directory — the last local copy of that knowledge.
//
// V3 CONTRACT (replaces v2's excerpt-coverage; owner-approved bounded
// replacement): the decision_record declares ONE SLOT PER DECISION ITEM —
// every owner note, every non-empty open question, the measured outcome,
// and every NON-PROCESS review signal (C2 classification survives) is its
// own item with a stable identity, a disposition, a carrier, and a
// per-item representation handle:
//
//   - identity: CONTENT-BOUND (the B-F1 fix, 2026-10-27 fix round):
//     owner_notes[fnv1a:<hash>] | open_questions[fnv1a:<hash>] |
//     measured_outcome[fnv1a:<hash>] | last_review[fnv1a:<hash>] |
//     task_reviewed[fnv1a:<hash>] — duplicate identical items within one
//     field carry a per-content occurrence suffix (.2, .3, ...).
//     <hash> is a dependency-free FNV-1a content digest (two 32-bit
//     passes, 16 hex chars) over the item's own text; the suffix
//     disambiguates duplicates by per-content occurrence (NOT array
//     position). Identity follows CONTENT, never position: rewriting an
//     item's text in place (e.g. /task-update replacing an owner note)
//     mints a NEW id, so the retirement baseline sees the old item as
//     removed (kept-slot, its carrier still verified) and the new content
//     as undeclared (mismatch -> refusal) — a sanctioned rewrite can no
//     longer recycle a stored slot onto different content. Reordering
//     items loses nothing (the id SET is order-independent) and is not a
//     mismatch.
//   - disposition: verbatim | curated | sanitized.
//   - carrier: {kind:"commit",revision?} | {kind:"artifact",path,revision?}
//     — there is deliberately NO inline carrier; content only in the local
//     closeout report is not durable.
//   - handle: for verbatim slots, a verbatim single line drawn from THAT
//     item's own content (the excerpt containment core is the one piece of
//     v2 machinery retained); for curated/sanitized slots, EXACTLY the
//     canonical label `decision-item: <task-id>#<item-id> (<disposition>)`
//     — the label-scoped representation. The label embeds the card id and
//     the item id, so it is unique per item and can never satisfy two
//     slots; the disposition inside the label keeps the recovered record
//     honest about what it is carrying.
//   - provenance: REQUIRED for owner-note items and sanitized items — who,
//     when, where recorded. For curated/sanitized it must be a CITED
//     reference, never an invented or AI-paraphrased owner statement.
//
// A carrier satisfies an item ONLY if the committed, branch-reachable
// carrier contains BOTH the card-id ANCHOR (findability from the card id)
// AND that item's handle. A commit whose body contains only the card id
// satisfies NOTHING (owner condition 1).
//
// INVENTORY BASELINE (owner condition 2): the stored record IS the baseline
// item inventory. At closeout, every decision item currently on the card
// must be declared (no missing slots, no surplus slots) and verbatim
// handles must bind to their own item's text. A RE-closeout is the
// sanctioned ADD-ONLY amendment: previously stored slots must be carried
// forward verbatim (dropping or rewriting a stored slot is refused); only
// new items get fresh slots. At retirement, every declared slot's carrier
// must resolve, and any decision item present on the card but NOT in the
// record is a new-item mismatch (refusal). Items REMOVED from card fields
// do not remove their slots — the baseline cannot be laundered by deletion.
// Routine tasks (no decision items, clean review) declare an empty items
// array and retire with zero ceremony.
//
// Honest limits (documented, NOT enforced — no semantic engine):
//   - item enumeration is MECHANICAL over the recognized card state
//     (owner_notes, measured_outcome, open_questions, last_review,
//     history.task_reviewed); decision content left in an unlisted home is
//     invisible to the classifier, and no gate defends against a hostile
//     editor of the gitignored card JSON — the goal is sanctioned-path
//     honesty;
//   - for verbatim slots the gate proves a length-floored line drawn from
//     the item's own text survived in an anchored committed carrier;
//     whether that line carries the SUBSTANCE of the item is author +
//     reviewer judgment;
//   - for curated/sanitized slots the gate proves ONLY that the labeled
//     item handle is present in an anchored committed carrier — that the
//     content next to the label is a USEFUL, faithful curation (what was
//     decided/rejected, why it mattered, key constraints, where authority
//     came from, what was deliberately omitted) is author + reviewer
//     judgment. A mechanically valid representation is NEVER proof the
//     meaning was preserved;
//   - verification proves LOCAL-repository reachability only. Cross-machine
//     availability comes from the normal push/release flow; the gate
//     performs no network operations and claims nothing about remotes.

const DECISION_RECORD_FENCE = "decision-record";
const DECISION_RECORD_VERSION = 3;
const DECISION_DISPOSITIONS = Object.freeze([
    "verbatim",
    "curated",
    "sanitized",
]);
// Per-slot allowed keys, mirroring the decision_record item variants in
// docs/coordination/schemas/task-card.schema.json EXACTLY (every variant
// carries additionalProperties:false). The closeout gate and the schema are
// ONE contract: a key set the schema would reject is refused here too — the
// schema is never relaxed to match a lax gate, and the gate is never looser
// than the schema.
const DECISION_SLOT_KEYS = Object.freeze([
    "id",
    "disposition",
    "carrier",
    "handle",
    "provenance",
    "note",
]);
// The immutable core of a retained slot: a re-closeout (the sanctioned
// add-only amendment) may not drop or rewrite any of these on a slot that
// is already stored. `note` stays free so an amendment can explain itself.
const DECISION_SLOT_IMMUTABLE_KEYS = Object.freeze([
    "id",
    "disposition",
    "carrier",
    "handle",
    "provenance",
]);
const DECISION_CARRIER_KINDS = Object.freeze(["commit", "artifact"]);
const DECISION_CARRIER_KEYS_BY_KIND = Object.freeze({
    commit: Object.freeze(["kind", "revision"]),
    artifact: Object.freeze(["kind", "path", "revision"]),
});
const DECISION_RECORD_KEYS = Object.freeze(["version", "items", "note"]);
// Verbatim-handle guards: the handle must be a single line, at least this
// many characters (trimmed), and must not equal the card id — a trivially
// short or id-shaped "handle" could satisfy the carrier check by accident
// without carrying any real decision content.
const DECISION_HANDLE_MIN_LENGTH = 24;
// Canonical label-scoped representation for curated/sanitized slots. The
// label is DERIVED (task id + item id + disposition), never free-typed, so
// it is unique per (task, item, disposition) and cannot be shared across
// slots. The disposition inside the label keeps recovery honest: what a
// fresh session recovers is labeled curated/sanitized, never silently
// presented as verbatim.
const DECISION_ITEM_LABEL_PREFIX = "decision-item: ";
// Review classification (owner-approved 2026-10-26, concern C2): a review
// that resolved the card to one of these statuses is a PROCESS record, not
// decision-class — an ordinary clean approve is not engineering knowledge,
// and routine tasks must retire after a normal review without promotion
// burden. Any other recorded verdict (blocked / ready / reported /
// cancelled / unknown) changed the card's trajectory and IS decision-class.
// Owner decisions recorded at review time belong in owner_notes (always
// decision-class) — the verdict shape is the smallest honest mechanical
// distinction the actual last_review/task_reviewed field shapes support
// (their `status` is the TASK LIFECYCLE status the review resolved to).
const DECISION_RECORD_PROCESS_REVIEW_STATUSES = Object.freeze(["completed"]);
// Search-mode walk cap: `git log --branches -- <path>` on a long-lived repo
// can return thousands of revisions; the carrier is expected near the top of
// the history of the declared durable path. The cap bounds retirement latency
// without weakening the declared-revision path (which checks exactly one
// revision).
const DECISION_RECORD_SEARCH_CAP = 200;

function decisionItemLabel(taskID, itemId, disposition) {
    return `${DECISION_ITEM_LABEL_PREFIX}${taskID}#${itemId} (${disposition})`;
}

// --- content-bound item identity (the B-F1 fix) ----------------------------
//
// Item ids used to be POSITIONAL (owner_notes[i]); position is a recyclable
// handle, and a sanctioned laundering chain exploited exactly that: closeout
// declared a slot for the note at index 0, /task-update later REPLACED that
// note's content, /task-review resolved the card to completed without
// re-closeout, and retirement matched the replacement to the stored slot by
// POSITION alone while the carrier check validated the ORIGINAL note's
// committed handle — the replacement decision (never preserved) was
// destroyed with the card. Identity now derives from the item's CONTENT:
//
//   <source>[fnv1a:<16-hex-content-digest>.<occurrence>]
//
// - fnv1a digest: two dependency-free 32-bit FNV-1a passes with different
//   offset bases over the item's trimmed text (UTF-16 code units — stable
//   across runs and Node versions; ids never leave this corpus), concatenated
//   as 16 hex chars. The 32-bit birthday bound across any realistic item
//   count is negligible, and a same-source collision of DIFFERENT contents
//   fails CLOSED (the duplicate-id structural refusal), never open.
// - occurrence: a per-content counter for duplicate identical items within
//   one field (the second identical copy = `.2`, the third = `.3`, ...; the
//   FIRST copy carries no discriminator) so duplicates each keep a distinct
//   stable id WITHOUT reintroducing array position. Reordering a field
//   permutes which physical slot carries which copy but never changes the
//   id SET — nothing is lost by reordering, so it passes. Replacing one of
//   two identical copies with different text mints a new id (mismatch,
//   refused) while the removed copy's slot is kept and still verified.
const DECISION_ITEM_HASH_TAG = "fnv1a:";

function fnv1a32Hex(text, offsetBasis) {
    let h = offsetBasis >>> 0;
    const s = String(text === undefined || text === null ? "" : text);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}

function decisionItemContentHash(content) {
    // Two independent FNV-1a passes (standard offset basis 0x811c9dc5, plus
    // a rotated basis 0x9dc5811c) — a 64-bit-strength content digest with
    // no BigInt and no dependencies.
    return fnv1a32Hex(content, 0x811c9dc5) + fnv1a32Hex(content, 0x9dc5811c);
}

// The canonical item-id factory. Array-backed sources pass an occurrence
// discriminator (the FIRST copy of a content carries NO discriminator —
// `owner_notes[fnv1a:<hash>]`; the second identical copy carries `.2`, the
// third `.3`, ...); singleton sources (measured_outcome, last_review) and
// an omitted occurrence emit no discriminator. Exported so tests and
// tooling derive EXACTLY the ids the gate enumerates — the fixtures cannot
// drift from the grammar.
function decisionItemId(source, content, occurrence) {
    const hash = decisionItemContentHash(content);
    const n =
        Number.isInteger(occurrence) && occurrence > 1 ? `.${occurrence}` : "";
    return `${source}[${DECISION_ITEM_HASH_TAG}${hash}${n}]`;
}

// Extract every fenced ```decision-record JSON block from closeout markdown.
// Returns [{ record, error }] like extractAllRewriteParityBlocks.
function extractAllDecisionRecordBlocks(markdown) {
    const text = String(markdown || "");
    const results = [];
    const re = new RegExp(
        "```" + DECISION_RECORD_FENCE + "[ \\t]*\\n([\\s\\S]*?)\\n```",
        "g",
    );
    let m;
    while ((m = re.exec(text)) !== null) {
        try {
            results.push({ record: JSON.parse(m[1]), error: null });
        } catch (e) {
            results.push({
                record: null,
                error:
                    "decision-record fence found but its JSON is malformed: " +
                    e.message,
            });
        }
    }
    return results;
}

// Lenient stored-shape normalization for the read path (see
// normalizeCoordinationTaskRecord). Structural authority for NEW records is
// the closeout gate (collectDecisionRecordStructuralErrors); this only keeps
// a plausible object shape and coerces anything else to null. Both the v3
// shape ({version:3, items}) and the legacy v1/v2 shape ({version:1,
// entries}) pass through so in-flight legacy cards remain readable; the
// retirement gate branches on the RAW version anyway.
function normalizeStoredDecisionRecord(source) {
    if (
        source &&
        typeof source === "object" &&
        !Array.isArray(source) &&
        Array.isArray(source.items)
    ) {
        return {
            version: source.version,
            items: source.items.map((slot) =>
                slot && typeof slot === "object" && !Array.isArray(slot)
                    ? { ...slot }
                    : slot,
            ),
            ...(typeof source.note === "string" ? { note: source.note } : {}),
        };
    }
    if (
        source &&
        typeof source === "object" &&
        !Array.isArray(source) &&
        Array.isArray(source.entries)
    ) {
        return {
            version: source.version,
            entries: source.entries.map((entry) =>
                entry && typeof entry === "object" && !Array.isArray(entry)
                    ? { ...entry }
                    : entry,
            ),
        };
    }
    return null;
}

// Structural validation of a v3 decision_record as declared at closeout (and
// re-checked on the stored shape at retirement). Returns collected error
// strings (empty = structurally valid). Mirrors the decision_record
// subschema of docs/coordination/schemas/task-card.schema.json EXACTLY —
// per-slot allowed keys with undeclared keys refused, like the schema's
// additionalProperties:false in every variant. There is deliberately no
// "inline" carrier kind — content only in the local closeout report is not
// durable. `revision`/`handle`/`id` must not start with "-": the verifier
// hands these strings to git (rev-parse positional, git grep -e, log
// --grep=), and closing the option-injection class structurally (not just
// at the git call sites) means no user string that git could parse as an
// option ever reaches a positional slot.
function collectDecisionRecordStructuralErrors(record, taskID) {
    const errors = [];
    const where = `decision_record for ${taskID}`;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
        return [
            `${where} must be a JSON object with version and items (the item-enumerated contract; see CLOSEOUT_TEMPLATE.md).`,
        ];
    }
    Object.keys(record).forEach((key) => {
        if (!DECISION_RECORD_KEYS.includes(key)) {
            errors.push(
                `${where}: unknown key "${key}" — a decision_record object carries exactly version, items${key === "entries" ? " (the v2 entries shape was replaced by items; migrate by closing out again)" : ""} (task-card.schema.json).`,
            );
        }
    });
    if (record.version !== DECISION_RECORD_VERSION) {
        errors.push(
            `${where}: version must be ${DECISION_RECORD_VERSION} — the item-enumerated contract. A stored version-1 (v1/v2) record is legacy-honored at retirement but can no longer be DECLARED at closeout; re-declare under v3.`,
        );
    }
    if (!Array.isArray(record.items)) {
        errors.push(
            `${where}: items must be an array of slots (possibly EMPTY — an empty inventory is the routine attestation, valid exactly when the card carries no decision items).`,
        );
        return errors;
    }
    const seenIds = new Set();
    record.items.forEach((slot, idx) => {
        const at = `${where} item #${idx + 1}`;
        if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
            errors.push(`${at} must be an object (one slot per decision item).`);
            return;
        }
        const unknownKeys = Object.keys(slot).filter(
            (key) => !DECISION_SLOT_KEYS.includes(key),
        );
        if (unknownKeys.length > 0) {
            errors.push(
                `${at}: unknown key(s) ${unknownKeys.map((k) => `"${k}"`).join(", ")} — a slot carries exactly ${DECISION_SLOT_KEYS.join(" | ")} (provenance/note optional; task-card.schema.json).`,
            );
        }
        // Item identity.
        const id = typeof slot.id === "string" ? slot.id.trim() : "";
        if (id === "") {
            errors.push(
                `${at}: id is required — the stable CONTENT-BOUND item identity within the task (owner_notes[fnv1a:<hash>] | open_questions[fnv1a:<hash>] | measured_outcome[fnv1a:<hash>] | last_review[fnv1a:<hash>] | task_reviewed[fnv1a:<hash>]; duplicates of identical content carry .2/.3/… — derived from the item's own text, never its array position).`,
            );
        } else if (id.includes("\n")) {
            errors.push(`${at}: id must be a single line.`);
        } else if (id.startsWith("-")) {
            errors.push(
                `${at}: id must not start with "-" — the id is embedded in the carrier label the verifier searches for, and no user string that git could parse as an option may reach a search position (option injection).`,
            );
        } else if (id.includes("#")) {
            errors.push(
                `${at}: id must not contain "#" — the carrier label format is ${DECISION_ITEM_LABEL_PREFIX}<task-id>#<item-id> (<disposition>); a "#" inside the id would blur the split.`,
            );
        } else if (seenIds.has(id)) {
            errors.push(
                `${at}: duplicate id "${id}" — ONE slot per item; two slots for one item is an ambiguous inventory.`,
            );
        } else {
            seenIds.add(id);
        }
        // Disposition.
        const dispositionOk = DECISION_DISPOSITIONS.includes(slot.disposition);
        if (!dispositionOk) {
            errors.push(
                `${at}: disposition must be one of ${DECISION_DISPOSITIONS.join(" | ")} (got ${JSON.stringify(slot.disposition)}).`,
            );
        }
        // Carrier.
        const carrier = slot.carrier;
        if (!carrier || typeof carrier !== "object" || Array.isArray(carrier)) {
            errors.push(
                `${at}: carrier is required — {kind:"commit",revision?} or {kind:"artifact",path,revision?}. There is deliberately no "inline" carrier: content only in the local closeout report is not durable.`,
            );
        } else if (!DECISION_CARRIER_KINDS.includes(carrier.kind)) {
            errors.push(
                `${at}: carrier.kind must be one of ${DECISION_CARRIER_KINDS.join(" | ")} (got ${JSON.stringify(carrier.kind)}).`,
            );
        } else {
            const allowedKeys = DECISION_CARRIER_KEYS_BY_KIND[carrier.kind];
            const carrierUnknown = Object.keys(carrier).filter(
                (key) => !allowedKeys.includes(key),
            );
            if (carrierUnknown.length > 0) {
                const hints = [];
                if (carrierUnknown.includes("marker")) {
                    hints.push(
                        "v3 has no marker — the anchor is always the card id, and the per-item representation is the handle",
                    );
                }
                if (carrier.kind === "commit" && carrierUnknown.includes("path")) {
                    hints.push(
                        "commit carriers take no path — declare an artifact carrier for file-located content",
                    );
                }
                errors.push(
                    `${at}: carrier unknown key(s) ${carrierUnknown.map((k) => `"${k}"`).join(", ")} — ${carrier.kind} carriers allow exactly ${allowedKeys.join(" | ")}${hints.length > 0 ? `; ${hints.join("; ")}` : ""}.`,
                );
            }
            if (carrier.kind === "artifact") {
                const p =
                    typeof carrier.path === "string" ? carrier.path.trim() : "";
                if (p === "") {
                    errors.push(
                        `${at}: artifact carriers require path — the durable file (docs/checkpoints/, researches/decisions/, researches/sources/, docs/planning/) that will carry the card-id anchor and this item's representation.`,
                    );
                } else if (path.isAbsolute(p) || p.includes("..")) {
                    errors.push(
                        `${at}: carrier path must be repo-relative and physically contained (no absolute paths, no "..").`,
                    );
                }
            }
            if (carrier.revision !== undefined) {
                const rev =
                    typeof carrier.revision === "string"
                        ? carrier.revision.trim()
                        : "";
                if (rev === "") {
                    errors.push(
                        `${at}: carrier revision, when present, must be a non-empty string (a commit sha or resolvable revision).`,
                    );
                } else if (/\s/.test(rev)) {
                    errors.push(
                        `${at}: carrier revision must be a single revision token.`,
                    );
                } else if (rev.startsWith("-")) {
                    errors.push(
                        `${at}: carrier revision must not start with "-" — the verifier passes the revision to git as a positional, and a leading dash is how a user string could be parsed as a git OPTION (option injection). No resolvable revision (sha, ref, @{...}) ever starts with a dash.`,
                    );
                }
            }
        }
        // Handle: the per-item representation.
        const handle = slot.handle;
        if (typeof handle !== "string" || handle.trim() === "") {
            errors.push(
                `${at}: handle is required — the per-item representation: for verbatim slots a verbatim single line drawn from the item's own content; for curated/sanitized slots EXACTLY the canonical label.`,
            );
        } else if (handle.includes("\n")) {
            errors.push(
                `${at}: handle must be a single line — the verifier matches it as one line in the committed carrier.`,
            );
        } else if (dispositionOk && slot.disposition === "verbatim") {
            const trimmed = handle.trim();
            if (trimmed.startsWith("-")) {
                errors.push(
                    `${at}: handle must not start with "-" — the same option-injection class refused for ids/revisions is refused for every user string in a carrier-checking position.`,
                );
            } else if (trimmed.length < DECISION_HANDLE_MIN_LENGTH) {
                errors.push(
                    `${at}: a verbatim handle must be at least ${DECISION_HANDLE_MIN_LENGTH} characters (trimmed) — a trivially short or generic string could verify against unrelated content by accident and is not evidence the item's content survived (got ${trimmed.length}: "${trimmed.slice(0, 40)}").`,
                );
            } else if (trimmed === taskID) {
                errors.push(
                    `${at}: handle must not equal the card id — the card id is the landing trailer's anchor, exactly the presence-only string that must NOT satisfy an item's representation.`,
                );
            }
        } else if (dispositionOk) {
            const canonical = decisionItemLabel(
                taskID,
                id,
                slot.disposition,
            );
            if (handle.trim() !== canonical) {
                errors.push(
                    `${at}: a ${slot.disposition} slot's handle must be EXACTLY the canonical item label "${canonical}" — the label-scoped representation is derived from the task id, item id, and disposition (never free-typed), so it is unique per item and the recovered record stays honestly labeled.`,
                );
            }
        }
        // Provenance: required for owner-decision items and sanitized items.
        const ownerOrigin = id.startsWith("owner_notes[");
        const sanitized = dispositionOk && slot.disposition === "sanitized";
        if (slot.provenance !== undefined && typeof slot.provenance !== "string") {
            errors.push(`${at}: provenance, when present, must be a string.`);
        } else if (
            (ownerOrigin || sanitized) &&
            (slot.provenance === undefined ||
                String(slot.provenance).trim() === "")
        ) {
            errors.push(
                `${at}: provenance is required${ownerOrigin ? " for owner-decision items (who decided, when, where recorded)" : ""}${sanitized && !ownerOrigin ? " for sanitized items (what was withheld and where the authority for withholding is recorded)" : ""} — for curated/sanitized representations it must be a CITED reference, never an invented or AI-paraphrased owner statement.`,
            );
        }
        if (slot.note !== undefined && typeof slot.note !== "string") {
            errors.push(`${at}: note, when present, must be a string.`);
        }
    });
    return errors;
}

// Mechanical decision-ITEM enumeration (v3, owner-approved 2026-10-27; the
// C2 review classification survives from 2026-10-26; content-bound identity
// from the 2026-10-27 B-F1 fix round). A decision item is EACH owner note,
// EACH non-empty open question, the measured outcome, and EACH non-process
// review signal — enumerated with a CONTENT-BOUND stable identity (see the
// decisionItemId factory above):
//   owner_notes[fnv1a:<hash>]          — one per non-empty note; duplicate
//                                        identical notes carry a per-content
//                                        occurrence suffix (.2, .3, ...),
//                                        NOT array position
//   open_questions[fnv1a:<hash>]       — same shape, per question
//   measured_outcome[fnv1a:<hash>]     — singleton (no discriminator)
//   last_review[fnv1a:<hash>]          — only when its status did NOT
//                                        resolve the card to a process
//                                        status ("completed" = ordinary
//                                        clean approve = process record)
//   task_reviewed[fnv1a:<hash>]        — per non-process history event
//                                        (identical duplicate events carry
//                                        .2, .3, ...), scanned PER EVENT: a later clean
//                                        approve does not launder an earlier
//                                        non-completed review
// Identity is CONTENT, so a hand-REORDER of items (including history
// events) does not shift any id — reordering loses nothing and passes; a
// content REPLACEMENT in place mints a new id, surfaces at retirement as an
// undeclared item, and refuses (fail-closed, honest). Returns
// [{ id, source, detail, content }] — content is the item's own text, the
// binding source for verbatim handles. SEMANTIC honesty (which content is
// actually important) is deliberately NOT evaluated.
function collectDecisionItems(task, incoming = {}) {
    const items = [];
    const pushItem = (source, text, occurrence) => {
        items.push({
            id: decisionItemId(source, text, occurrence),
            source,
            detail: `"${text.slice(0, 80)}"`,
            content: text,
        });
    };
    const enumerateField = (values, source) => {
        const seen = new Map();
        (Array.isArray(values) ? values : []).forEach((value) => {
            const text = String(value || "").trim();
            if (text !== "") {
                const occurrence = (seen.get(text) || 0) + 1;
                seen.set(text, occurrence);
                pushItem(source, text, occurrence);
            }
        });
    };
    enumerateField(task && task.owner_notes, "owner_notes");
    const measuredOutcome =
        incoming.measuredOutcome !== undefined
            ? String(incoming.measuredOutcome || "").trim()
            : String((task && task.measured_outcome) || "").trim();
    if (measuredOutcome !== "") {
        pushItem("measured_outcome", measuredOutcome);
    }
    enumerateField(task && task.open_questions, "open_questions");
    if (
        task &&
        task.last_review &&
        typeof task.last_review === "object"
    ) {
        const reviewStatus = String(task.last_review.status || "").trim();
        if (!DECISION_RECORD_PROCESS_REVIEW_STATUSES.includes(reviewStatus)) {
            const content = [
                task.last_review.title,
                task.last_review.status,
                task.last_review.summary,
                task.last_review.next_action,
            ]
                .filter((part) => String(part || "").trim() !== "")
                .join("\n");
            items.push({
                id: decisionItemId("last_review", content),
                source: "last_review",
                detail: `review verdict recorded (status: ${reviewStatus || "unknown"}) — a review that did not resolve the card to ${DECISION_RECORD_PROCESS_REVIEW_STATUSES.join("/")} changed its trajectory`,
                content,
            });
        }
    }
    const history = Array.isArray(task && task.history) ? task.history : [];
    const seenReviewed = new Map();
    history.forEach((entry) => {
        if (
            entry &&
            typeof entry === "object" &&
            entry.event === "task_reviewed" &&
            !DECISION_RECORD_PROCESS_REVIEW_STATUSES.includes(
                String(entry.status || "").trim(),
            )
        ) {
            const content = [
                entry.note,
                entry.status ? `status: ${entry.status}` : "",
            ]
                .filter((part) => String(part || "").trim() !== "")
                .join("\n");
            const occurrence = (seenReviewed.get(content) || 0) + 1;
            seenReviewed.set(content, occurrence);
            items.push({
                id: decisionItemId("task_reviewed", content, occurrence),
                source: "history.task_reviewed",
                detail: `non-approve review event (status: ${String(entry.status || "unknown")}; content-bound identity)`,
                content,
            });
        }
    });
    return items;
}

// Whitespace normalization for verbatim-handle binding: runs of whitespace
// (including line wraps) collapse to single spaces on BOTH the item content
// and the handle, so a handle may span a wrap in the item's stored text
// while remaining a verbatim word-sequence. The carrier side applies the
// same normalization to text it reads in full (commit messages, committed
// blobs); tree-wide git grep -F checks are line-based by nature and require
// the handle on one line.
function normalizeExcerptText(value) {
    return String(value === undefined || value === null ? "" : value)
        .trim()
        .replace(/\s+/g, " ");
}

function normalizedTextContains(content, excerpt) {
    const haystack = normalizeExcerptText(content);
    const needle = normalizeExcerptText(excerpt);
    return needle !== "" && haystack.includes(needle);
}

// Inventory completeness + binding + add-only amendment (v3, owner
// conditions 1 and 2). Checked at closeout against the card as it stands
// (plus the incoming measured_outcome option) and — the missing-direction
// only — at retirement. Returns [{ code, id, detail }] with codes:
//   missing_item     — a decision item on the card has NO slot (owner
//                      condition 1: enumeration alone is insufficient; one
//                      slot per item, and a carrier containing only the
//                      card id satisfies nothing)
//   unknown_item     — a declared slot matches no current item AND no
//                      previously stored slot (a fabricated/stale inventory
//                      is refused at declaration; at retirement the
//                      baseline direction is EXPECTED for vanished items and
//                      is not re-checked there)
//   unbound_handle   — a verbatim handle not drawn from ITS OWN item's
//                      content (per-item binding — the concern-1 fix)
//   amendment_drop   — a re-closeout DROPPED a previously stored slot; the
//                      stored record is the baseline and may only grow
//   amendment_rewrite— a re-closeout REWROTE an immutable field of a
//                      retained slot; baseline slots are carried forward
//                      verbatim
function collectDecisionInventoryProblems(
    task,
    record,
    incoming = {},
    storedRecord = null,
) {
    const problems = [];
    const items = collectDecisionItems(task, incoming);
    const itemById = new Map(items.map((item) => [item.id, item]));
    const slots =
        record && Array.isArray(record.items)
            ? record.items.filter(
                  (slot) =>
                      slot &&
                      typeof slot === "object" &&
                      typeof slot.id === "string",
              )
            : [];
    const slotById = new Map(slots.map((slot) => [slot.id.trim(), slot]));
    items.forEach((item) => {
        if (!slotById.has(item.id)) {
            problems.push({
                code: "missing_item",
                id: item.id,
                detail: `item ${item.id} (${item.source}): ${item.detail} — present on the card with NO slot. One slot per decision item; a carrier containing only the card id satisfies nothing.`,
            });
        }
    });
    const storedIds =
        storedRecord &&
        typeof storedRecord === "object" &&
        Array.isArray(storedRecord.items)
            ? new Set(
                  storedRecord.items
                      .filter(
                          (slot) =>
                              slot &&
                              typeof slot === "object" &&
                              typeof slot.id === "string",
                      )
                      .map((slot) => slot.id.trim()),
              )
            : new Set();
    slotById.forEach((slot, id) => {
        const item = itemById.get(id);
        if (!item) {
            if (!storedIds.has(id)) {
                problems.push({
                    code: "unknown_item",
                    id,
                    detail: `slot "${id}" matches no decision item on the card and no previously stored slot — the inventory must enumerate real items (content-bound identities: owner_notes[fnv1a:<hash>] | open_questions[fnv1a:<hash>] | measured_outcome[fnv1a:<hash>] | last_review[fnv1a:<hash>] | task_reviewed[fnv1a:<hash>]; duplicates of identical content carry .2/.3/…).`,
                });
            }
            return;
        }
        if (
            slot.disposition === "verbatim" &&
            typeof slot.handle === "string"
        ) {
            if (!normalizedTextContains(item.content, slot.handle)) {
                problems.push({
                    code: "unbound_handle",
                    id,
                    detail: `slot ${id} declares a verbatim handle that is NOT drawn from that item's own content — the per-item representation must be the item's text ("${String(slot.handle).slice(0, 60)}…")`,
                });
            }
        }
    });
    // Sanctioned amendment: add-only vs the stored v3 baseline. A re-closeout
    // may ADD slots for new items (e.g. a post-closeout blocked review) but
    // may never drop or rewrite a stored slot — removal from the card fields
    // does not remove a slot, and a rewritten slot could quietly trade a real
    // representation for a trivial one.
    if (
        storedRecord &&
        typeof storedRecord === "object" &&
        storedRecord.version === DECISION_RECORD_VERSION &&
        Array.isArray(storedRecord.items)
    ) {
        storedRecord.items.forEach((storedSlot) => {
            if (
                !storedSlot ||
                typeof storedSlot !== "object" ||
                typeof storedSlot.id !== "string"
            ) {
                return;
            }
            const id = storedSlot.id.trim();
            const next = slotById.get(id);
            if (!next) {
                problems.push({
                    code: "amendment_drop",
                    id,
                    detail: `previously stored slot "${id}" was DROPPED — the stored record is the baseline inventory; a re-closeout is the sanctioned ADD-ONLY amendment (removing an item from the card never removes its slot).`,
                });
                return;
            }
            DECISION_SLOT_IMMUTABLE_KEYS.forEach((key) => {
                const before =
                    storedSlot[key] === undefined ? null : storedSlot[key];
                const after = next[key] === undefined ? null : next[key];
                if (JSON.stringify(before) !== JSON.stringify(after)) {
                    problems.push({
                        code: "amendment_rewrite",
                        id,
                        detail: `retained slot "${id}" was REWRITTEN ("${key}" changed) — a baseline slot is carried forward verbatim; only NEW items get fresh declarations.`,
                    });
                }
            });
        });
    }
    return problems;
}

// --- git verification helpers (spawnSync so expected non-zero exits like a
// miss from `git grep` are distinguishable from spawn failures) ------------

function gitSpawn(repo, args) {
    try {
        const res = spawnSync("git", args, {
            cwd: repo,
            encoding: "utf8",
            timeout: 10000,
        });
        if (res.error) {
            return { status: null, stdout: "", stderr: String(res.error.message || "") };
        }
        return {
            status: res.status,
            stdout: String(res.stdout || ""),
            stderr: String(res.stderr || ""),
        };
    } catch (error) {
        return {
            status: null,
            stdout: "",
            stderr: String((error && error.message) || error),
        };
    }
}

// Resolve a declared revision to a full commit sha (null when unresolvable).
function resolveCommitRevision(repo, revision) {
    const res = gitSpawn(repo, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${revision}^{commit}`,
    ]);
    if (res.status !== 0) {
        return null;
    }
    const sha = res.stdout.trim();
    return sha === "" ? null : sha;
}

// Branch-generic reachability (mirrors verifyLandingProof's --branches
// semantic): true iff some local branch tip has the commit as an ancestor.
function isCommitReachableFromBranches(repo, sha) {
    const res = gitSpawn(repo, [
        "branch",
        "--contains",
        sha,
        "--format=%(refname)",
    ]);
    if (res.status !== 0) {
        return false;
    }
    return res.stdout.trim() !== "";
}

// Tri-state commit-message read: { available, contains, stderr }. A failed
// read (spawn failure, non-zero exit) is UNAVAILABLE — never a clean
// "does not contain" — so the call site maps it to verifier_unavailable
// instead of silently falling through to the tree search on a false
// negative. (Pre-tri-state this returned a bare false on ANY git failure.)
function commitMessageContains(repo, sha, marker) {
    const res = gitSpawn(repo, ["log", "-1", "--format=%B", sha]);
    if (res.status !== 0) {
        return {
            available: false,
            contains: false,
            stderr: res.stderr || `git log exited ${res.status}`,
        };
    }
    return {
        available: true,
        contains: res.stdout.includes(marker),
        stderr: "",
    };
}

// Fixed-string search of the whole tree AT a committed revision. git grep
// exits 0 on match and 1 on no-match (both expected); ANY other exit
// (including a spawn failure) is UNAVAILABLE — a failed read is never
// reported as marker-not-found (fail-closed either way; the diagnosis must
// be honest). Working-tree content is never consulted. The marker is bound
// with an EXPLICIT `-e`: as a bare positional, a marker with a leading dash
// (e.g. "-v" = --invert-match) was consumed by git as an OPTION — the sha
// became the pattern, no revision was searched, git scanned the WORKING
// TREE inverted and exited 0, and the gate read contains:true (option
// injection → fail-open deletion). `-e` consumes the next argument as the
// pattern whatever it starts with; the structural gate additionally
// refuses dash-prefixed markers at declaration AND retirement.
function treeAtRevisionContains(repo, sha, marker) {
    const res = gitSpawn(repo, [
        "grep",
        "-F",
        "--quiet",
        "-e",
        marker,
        sha,
        "--",
    ]);
    if (res.status === 0) {
        return { available: true, contains: true, stderr: "" };
    }
    if (res.status === 1) {
        return { available: true, contains: false, stderr: "" };
    }
    return {
        available: false,
        contains: false,
        stderr: res.stderr || `git grep exited ${res.status}`,
    };
}

// Reachable commits whose tree touched the path, newest first (capped).
function reachableCommitsTouchingPath(repo, targetPath) {
    const res = gitSpawn(repo, [
        "log",
        "--branches",
        "--format=%H",
        "--",
        targetPath,
    ]);
    if (res.status !== 0) {
        return null;
    }
    return res.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .slice(0, DECISION_RECORD_SEARCH_CAP);
}

// Tri-state committed-blob read: { available, tracked, blob, stderr,
// missReason }. Reads the COMMITTED blob — never the worktree.
// `available:false` means the READ failed (spawn failure, corrupt/missing
// object) and is mapped by the caller to verifier_unavailable — never
// overstated as path-not-tracked; `available:true, tracked:false` is a
// DETERMINATE miss (no file blob at that path in that tree), carrying
// `missReason` when the path resolves to a directory so the caller can
// NAME that problem instead of a generic not-tracked diagnosis.
//
// Classification ALWAYS runs an explicit `git ls-tree <rev> -- <path>`
// object-type probe BEFORE any content read (the `--` keeps the
// user-supplied path on the pathspec side — it can never parse as an
// option), on the success path too, because `git show`'s exits cannot
// separate the shapes:
//   - `git show <rev>:<dir>` exits 0 and prints the directory LISTING, so
//     a success-path content read alone cannot tell a file blob from a
//     directory — and a listing whose FILENAMES happen to contain the
//     marker would falsely verify (round-3 blocker b-F1: the default
//     marker is the card-id, and an id-named FILENAME inside the listed
//     directory made retirement destroy the card unread);
//   - `git show`'s non-zero exits do not distinguish "path absent from
//     the tree" from genuine read failures.
// The probe entry's path must also equal the declared path EXACTLY: a
// directory-shaped pathspec (e.g. a trailing slash) makes ls-tree answer
// with CHILD entries — a directory declaration in disguise.
function committedBlobAt(repo, sha, targetPath) {
    const probe = gitSpawn(repo, ["ls-tree", sha, "--", targetPath]);
    if (probe.status !== 0) {
        return {
            available: false,
            tracked: null,
            blob: null,
            stderr: probe.stderr || `git ls-tree exited ${probe.status}`,
        };
    }
    const firstLine = (probe.stdout.split(/\r?\n/)[0] || "").trim();
    if (firstLine === "") {
        // Determinate miss: nothing at that path in that tree.
        return { available: true, tracked: false, blob: null, stderr: "" };
    }
    const entry = /^([0-7]+) (\w+) ([0-9a-f]+)\t(.*)$/.exec(firstLine);
    if (!entry) {
        // Cannot classify the probe output — report a failed read, never
        // a guess.
        return {
            available: false,
            tracked: null,
            blob: null,
            stderr: `unparseable git ls-tree output: ${firstLine.slice(0, 120)}`,
        };
    }
    const entryType = entry[2];
    const entryPath = entry[4];
    if (entryType === "tree" || entryType === "commit") {
        // Determinate miss, honestly named: the path is a directory
        // (submodules are the `commit` shape — `git show` exits 0 on both
        // and prints a listing). A listing is not blob content, and
        // filenames inside it must never verify a marker.
        return {
            available: true,
            tracked: false,
            blob: null,
            stderr: "",
            missReason: `"${targetPath}" at commit ${sha} is a directory, not a file blob — declare the durable file, not its containing directory (a directory listing is not content; filenames in it never verify a marker)`,
        };
    }
    if (entryPath !== targetPath.replace(/^(?:\.\/)+/, "")) {
        // Determinate miss, honestly named: the pathspec matched OTHER
        // paths (a directory-shaped declaration, e.g. a trailing slash,
        // makes ls-tree answer with child entries) — no file blob exists
        // at exactly the declared path.
        return {
            available: true,
            tracked: false,
            blob: null,
            stderr: "",
            missReason: `"${targetPath}" at commit ${sha} matched directory contents, not a file blob — declare the durable file itself (a directory listing is not content; filenames in it never verify a marker)`,
        };
    }
    const blob = gitSpawn(repo, ["show", `${sha}:${targetPath}`]);
    if (blob.status !== 0) {
        // The path IS a tracked blob yet `git show` failed — a genuine
        // read failure (e.g. corrupt or missing object), never a
        // determinate miss.
        return {
            available: false,
            tracked: true,
            blob: null,
            stderr: blob.stderr || `git show exited ${blob.status}`,
        };
    }
    return { available: true, tracked: true, blob: blob.stdout, stderr: "" };
}

// Verify every declared slot of a v3 decision_record against committed,
// branch-reachable state in `repo` (owner condition 1 — the core binding).
// Per slot, a carrier satisfies the item ONLY if the SAME committed carrier
// contains BOTH:
//   (a) the card-id ANCHOR — so a fresh session knowing only the card id can
//       find the carrier after the card is destroyed; and
//   (b) that item's HANDLE — for verbatim slots a whitespace-normalized
//       verbatim line of the item's own content (the retained containment
//       core); for curated/sanitized slots the canonical item label, whose
//       presence means labeled content sits in the carrier (the label-scoped
//       check — semantic fidelity of that content is author + reviewer,
//       never this verifier).
// A commit whose body contains only the card id satisfies NOTHING. Each
// slot names its own carrier; multiple slots may share one carrier and are
// each verified independently. Returns
// { ok, problems: [{ index, id, kind, locator, code, detail }], verified }.
// Never throws — the caller maps problems to a structured refusal naming
// each missing/uncommitted/unreachable item.
function verifyDecisionRecordForRetirement(taskID, record, repoOverride) {
    const repo = repoOverride || repoRoot();
    const problems = [];
    const verified = [];
    // A degraded record (missing, non-object, or carrying no items array) is
    // NOT verified: iterating zero items proves nothing and must never read
    // as "every carrier resolved". Refuse with an honest diagnosis instead
    // of trusting an empty inventory (the retirement call site additionally
    // runs the full structural check, so a wrong-version or junk-key shape
    // is refused there with the specific structural problems; this guard
    // keeps the verifier itself fail-closed for any caller).
    if (
        !record ||
        typeof record !== "object" ||
        Array.isArray(record) ||
        !Array.isArray(record.items)
    ) {
        problems.push({
            index: 0,
            kind: "record",
            id: "",
            locator: "",
            code: "record_degraded",
            detail:
                "the stored decision_record is degraded (missing, non-object, or carrying no items array) — it is not a verifiable inventory",
        });
        return { ok: false, problems, verified };
    }
    record.items.forEach((slot, idx) => {
        const index = idx + 1;
        if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
            problems.push({
                index,
                kind: "item",
                id: "",
                locator: "",
                code: "slot_malformed",
                detail: "slot is not an object",
            });
            return;
        }
        const id =
            typeof slot.id === "string" && slot.id.trim() !== ""
                ? slot.id.trim()
                : `<slot #${index}>`;
        const handle = typeof slot.handle === "string" ? slot.handle : "";
        const carrier =
            slot.carrier && typeof slot.carrier === "object"
                ? slot.carrier
                : null;
        if (!carrier) {
            problems.push({
                index,
                kind: "item",
                id,
                locator: "",
                code: "slot_malformed",
                detail: `item "${id}" declares no carrier`,
            });
            return;
        }
        const disposition =
            typeof slot.disposition === "string" ? slot.disposition : "?";
        const handleKind =
            disposition === "verbatim"
                ? "verbatim handle"
                : `${disposition} item label`;
        if (carrier.kind === "commit") {
            const declaredRev = String(carrier.revision || "").trim();
            if (declaredRev !== "") {
                // Pinned-revision commit carrier: resolve, reachability, then
                // anchor + handle in the MESSAGE (whitespace-normalized) or
                // any blob at that committed revision (git grep -F -e —
                // line-based, and handles are single lines by structure).
                const sha = resolveCommitRevision(repo, declaredRev);
                if (sha === null) {
                    problems.push({
                        index,
                        kind: "item",
                        id,
                        locator: declaredRev,
                        code: "revision_not_resolvable",
                        detail: `item "${id}": carrier revision "${declaredRev}" does not resolve to a commit`,
                    });
                    return;
                }
                if (!isCommitReachableFromBranches(repo, sha)) {
                    problems.push({
                        index,
                        kind: "item",
                        id,
                        locator: declaredRev,
                        code: "revision_not_reachable",
                        detail: `item "${id}": carrier commit ${sha} exists but is not reachable from any local branch (reflog-only/orphaned commits do not count)`,
                    });
                    return;
                }
                const msg = gitSpawn(repo, ["log", "-1", "--format=%B", sha]);
                if (msg.status !== 0) {
                    problems.push({
                        index,
                        kind: "item",
                        id,
                        locator: declaredRev,
                        code: "verifier_unavailable",
                        detail: `item "${id}": git could not read the commit message at ${sha}: ${msg.stderr || `git log exited ${msg.status}`}`,
                    });
                    return;
                }
                const treeHit = (needle) =>
                    treeAtRevisionContains(repo, sha, needle);
                let anchorOk = msg.stdout.includes(taskID);
                if (!anchorOk) {
                    const anchorTree = treeHit(taskID);
                    if (!anchorTree.available) {
                        problems.push({
                            index,
                            kind: "item",
                            id,
                            locator: declaredRev,
                            code: "verifier_unavailable",
                            detail: `item "${id}": git could not search the tree at commit ${sha}: ${anchorTree.stderr}`,
                        });
                        return;
                    }
                    anchorOk = anchorTree.contains;
                }
                let handleOk = normalizedTextContains(msg.stdout, handle);
                if (!handleOk) {
                    const handleTree = treeHit(handle);
                    if (!handleTree.available) {
                        problems.push({
                            index,
                            kind: "item",
                            id,
                            locator: declaredRev,
                            code: "verifier_unavailable",
                            detail: `item "${id}": git could not search the tree at commit ${sha}: ${handleTree.stderr}`,
                        });
                        return;
                    }
                    handleOk = handleTree.contains;
                }
                if (anchorOk && handleOk) {
                    verified.push({
                        index,
                        kind: "item",
                        id,
                        locator: sha,
                        how: `card-id anchor + ${handleKind} for "${id}" present at the declared revision`,
                    });
                    return;
                }
                if (!anchorOk) {
                    problems.push({
                        index,
                        kind: "item",
                        id,
                        locator: declaredRev,
                        code: "anchor_missing",
                        detail: `item "${id}": carrier commit ${sha} carries the card-id anchor "${taskID}" neither in its message nor in any blob at that committed revision — every carrier must be discoverable from the card id after retirement`,
                    });
                }
                if (!handleOk) {
                    problems.push({
                        index,
                        kind: "item",
                        id,
                        locator: declaredRev,
                        code: "handle_not_in_carrier",
                        detail: `item "${id}": carrier commit ${sha} does not contain the ${handleKind} ("${String(handle).slice(0, 60)}…") in its message or any blob at that committed revision — the declared carrier does not contain THIS item's representation`,
                    });
                }
                return;
            }
            // Search mode: the landing-commit body pattern — the carrier
            // commit cannot be sha-pinned at closeout time. One reachable
            // commit MESSAGE must carry the card-id anchor AND the handle
            // together; an anchored message without the handle satisfies
            // nothing, and a handle in an un-anchored message satisfies
            // nothing.
            const res = gitSpawn(repo, [
                "log",
                "--branches",
                "--fixed-strings",
                `--grep=${taskID}`,
                "--format=%H%x1f%B%x1e",
            ]);
            if (res.status !== 0) {
                // `git log` exits 0 even on NO match, so ANY non-zero exit
                // (spawn failure included) is a failed read, not a miss.
                problems.push({
                    index,
                    kind: "item",
                    id,
                    locator: "<reachable history>",
                    code: "verifier_unavailable",
                    detail: `item "${id}": git could not read history: ${res.stderr || `exit ${res.status}`}`,
                });
                return;
            }
            let anchorSeen = false;
            let hit = null;
            for (const record_ of res.stdout.split("\x1e")) {
                const rec = record_.trim();
                if (!rec) continue;
                const sep = rec.indexOf("\x1f");
                const sha = (sep >= 0 ? rec.slice(0, sep) : rec).trim();
                const body = sep >= 0 ? rec.slice(sep + 1) : "";
                if (!sha || !body.includes(taskID)) {
                    continue;
                }
                anchorSeen = true;
                if (normalizedTextContains(body, handle)) {
                    hit = sha;
                    break;
                }
            }
            if (hit) {
                verified.push({
                    index,
                    kind: "item",
                    id,
                    locator: hit,
                    how: `card-id anchor + ${handleKind} for "${id}" present in the same reachable commit message`,
                });
                return;
            }
            if (!anchorSeen) {
                problems.push({
                    index,
                    kind: "item",
                    id,
                    locator: "<reachable history>",
                    code: "anchor_missing",
                    detail: `item "${id}": no reachable commit message carries the card-id anchor "${taskID}" — every carrier must be discoverable from the card id after retirement (the landing trailer makes the landing commit body the natural carrier)`,
                });
                return;
            }
            problems.push({
                index,
                kind: "item",
                id,
                locator: "<reachable history>",
                code: "handle_not_in_carrier",
                detail: `item "${id}": no card-id-anchored reachable commit message carries the ${handleKind} ("${String(handle).slice(0, 60)}…") — the declared carrier does not contain THIS item's representation`,
            });
            return;
        }
        if (carrier.kind === "artifact") {
            const targetPath = String(carrier.path || "").trim();
            const declaredRev = String(carrier.revision || "").trim();
            // One committed blob must carry the card-id anchor AND the
            // handle together (whitespace-normalized, so wrapped doc lines
            // still verify).
            const checkBlob = (sha, how) => {
                const read = committedBlobAt(repo, sha, targetPath);
                if (!read.available) {
                    // A failed read is NEVER overstated as
                    // path-not-tracked / handle-not-in-blob.
                    return {
                        code: "verifier_unavailable",
                        detail: `item "${id}": git could not read "${targetPath}" at commit ${sha}: ${read.stderr}`,
                    };
                }
                if (read.blob === null) {
                    if (read.missReason) {
                        return {
                            code: "path_is_directory_not_file_blob",
                            detail: `item "${id}": ${read.missReason}`,
                        };
                    }
                    return {
                        code: "path_not_tracked_at_revision",
                        detail: `item "${id}": "${targetPath}" is not tracked as a file blob at commit ${sha}`,
                    };
                }
                const anchorOk = read.blob.includes(taskID);
                const handleOk = normalizedTextContains(read.blob, handle);
                if (anchorOk && handleOk) {
                    verified.push({
                        index,
                        kind: "item",
                        id,
                        locator: `${sha}:${targetPath}`,
                        how,
                    });
                    return null;
                }
                return {
                    code: "carrier_blob_incomplete",
                    anchorOk,
                    handleOk,
                    sha,
                };
            };
            const incompleteProblems = (miss, locator) => {
                const list = [];
                if (!miss.anchorOk) {
                    list.push({
                        code: "anchor_missing",
                        detail: `item "${id}": the committed blob of "${targetPath}" at commit ${miss.sha} does not contain the card-id anchor "${taskID}" — every carrier must be discoverable from the card id after retirement (the documented back-reference convention)`,
                    });
                }
                if (!miss.handleOk) {
                    list.push({
                        code: "handle_not_in_carrier",
                        detail: `item "${id}": the committed blob of "${targetPath}" at commit ${miss.sha} does not contain the ${handleKind} ("${String(handle).slice(0, 60)}…") — the declared carrier does not contain THIS item's representation`,
                    });
                }
                return list.map((problem) => ({
                    index,
                    kind: "item",
                    id,
                    locator,
                    ...problem,
                }));
            };
            if (declaredRev !== "") {
                const sha = resolveCommitRevision(repo, declaredRev);
                if (sha === null) {
                    problems.push({
                        index,
                        kind: "item",
                        id,
                        locator: `${declaredRev}:${targetPath}`,
                        code: "revision_not_resolvable",
                        detail: `item "${id}": carrier revision "${declaredRev}" does not resolve to a commit`,
                    });
                    return;
                }
                if (!isCommitReachableFromBranches(repo, sha)) {
                    problems.push({
                        index,
                        kind: "item",
                        id,
                        locator: `${declaredRev}:${targetPath}`,
                        code: "revision_not_reachable",
                        detail: `item "${id}": carrier commit ${sha} exists but is not reachable from any local branch`,
                    });
                    return;
                }
                const miss = checkBlob(
                    sha,
                    `card-id anchor + ${handleKind} for "${id}" present in the committed blob at the declared revision`,
                );
                if (miss === null) {
                    return;
                }
                if (miss.code !== "carrier_blob_incomplete") {
                    problems.push({
                        index,
                        kind: "item",
                        id,
                        locator: `${declaredRev}:${targetPath}`,
                        ...miss,
                    });
                    return;
                }
                problems.push(
                    ...incompleteProblems(miss, `${declaredRev}:${targetPath}`),
                );
                return;
            }
            // Search mode: walk reachable commits that touched the path,
            // newest first — the home of post-landing material (review
            // verdicts, curated summaries, measured outcomes) promoted to a
            // durable file after closeout declared it. Unavailable reads
            // keep b-F2 semantics (an incomplete negative search is never a
            // confident miss); directory paths keep b-F1 naming; anchor in
            // one revision + handle in another is a TERMINAL scatter
            // diagnosis (review F1, 2026-10-27) — split evidence is never
            // a silent pass, because no single committed blob would carry
            // the item's representation next to its discoverability anchor.
            const revs = reachableCommitsTouchingPath(repo, targetPath);
            if (revs === null) {
                problems.push({
                    index,
                    kind: "item",
                    id,
                    locator: targetPath,
                    code: "verifier_unavailable",
                    detail: `item "${id}": git could not read history for the path`,
                });
                return;
            }
            if (revs.length === 0) {
                problems.push({
                    index,
                    kind: "item",
                    id,
                    locator: targetPath,
                    code: "path_never_committed",
                    detail: `item "${id}": no reachable commit carries "${targetPath}" — the durable file was never committed (local-only files never count)`,
                });
                return;
            }
            let unavailableDetail = null;
            let directoryDetail = null;
            let anchorEver = false;
            let handleEver = false;
            // First (newest) revision bearing each half, so the scatter
            // diagnosis can NAME where each side actually lives.
            let anchorRev = null;
            let handleRev = null;
            for (const sha of revs) {
                const read = committedBlobAt(repo, sha, targetPath);
                if (!read.available) {
                    if (unavailableDetail === null) {
                        unavailableDetail = `item "${id}": git could not read "${targetPath}" at commit ${sha}: ${read.stderr}`;
                    }
                    continue;
                }
                if (read.blob === null) {
                    if (read.missReason && directoryDetail === null) {
                        directoryDetail = `item "${id}": ${read.missReason}`;
                    }
                    continue;
                }
                const anchorOk = read.blob.includes(taskID);
                const handleOk = normalizedTextContains(read.blob, handle);
                if (anchorOk && handleOk) {
                    verified.push({
                        index,
                        kind: "item",
                        id,
                        locator: `${sha}:${targetPath}`,
                        how: `card-id anchor + ${handleKind} for "${id}" present in the committed blob at reachable revision ${sha}`,
                    });
                    return;
                }
                if (anchorOk) {
                    anchorEver = true;
                    if (anchorRev === null) {
                        anchorRev = sha;
                    }
                }
                if (handleOk) {
                    handleEver = true;
                    if (handleRev === null) {
                        handleRev = sha;
                    }
                }
            }
            if (unavailableDetail !== null) {
                problems.push({
                    index,
                    kind: "item",
                    id,
                    locator: targetPath,
                    code: "verifier_unavailable",
                    detail: `no reachable revision verified "${targetPath}" for item "${id}" and at least one committed-blob read was unavailable — content absence is NOT established: ${unavailableDetail}`,
                });
                return;
            }
            if (directoryDetail !== null) {
                problems.push({
                    index,
                    kind: "item",
                    id,
                    locator: targetPath,
                    code: "path_is_directory_not_file_blob",
                    detail: directoryDetail,
                });
                return;
            }
            // An unsuccessful walk is ALWAYS terminal. anchorEver and
            // handleEver are per-revision accumulators, so "each half seen
            // somewhere" is NOT "both seen together": anchor-alone in
            // revision X + handle-alone in revision Y used to fall through
            // with zero problems and read as ok:true (review F1 — the
            // fail-open the deleted v2 scatter pin was guarding). Fail
            // closed with a diagnosis naming both revisions.
            if (!anchorEver) {
                problems.push({
                    index,
                    kind: "item",
                    id,
                    locator: targetPath,
                    code: "anchor_missing",
                    detail: `item "${id}": no reachable revision of "${targetPath}" carries the card-id anchor "${taskID}" in its committed blob — every carrier must be discoverable from the card id after retirement (the documented back-reference convention)`,
                });
            }
            if (!handleEver) {
                problems.push({
                    index,
                    kind: "item",
                    id,
                    locator: targetPath,
                    code: "handle_not_in_carrier",
                    detail: `item "${id}": no reachable revision of "${targetPath}" carries the ${handleKind} ("${String(handle).slice(0, 60)}…") in its committed blob — the declared carrier does not contain THIS item's representation`,
                });
            }
            if (anchorEver && handleEver) {
                problems.push({
                    index,
                    kind: "item",
                    id,
                    locator: targetPath,
                    code: "anchor_handle_scattered",
                    detail: `item "${id}": no single reachable revision of "${targetPath}" carries the card-id anchor "${taskID}" AND the ${handleKind} together — the anchor was found at commit ${anchorRev} and the ${handleKind} at commit ${handleRev}, but never in the same committed blob. Split evidence across revisions is not a same-carrier representation: a fresh session recovering from the anchor-bearing revision finds no item representation there. Reunite both in one committed, branch-reachable carrier (or pin the revision that carries both).`,
                });
            }
            return;
        }
        problems.push({
            index,
            kind: "item",
            id,
            locator: "",
            code: "slot_malformed",
            detail: `item "${id}": carrier.kind must be one of ${DECISION_CARRIER_KINDS.join(" | ")}`,
        });
    });
    return { ok: problems.length === 0, problems, verified };
}

// Destructive-warning inventory for the FORCE path (and pre-removal audit):
// what decision-class content is about to be destroyed. Items are the
// CURRENT decision items enumerated from the card; slots are the declared
// (baseline) inventory — verified or not. Best-effort — a force never blocks
// on this.
function decisionRecordDestructionInventory(task) {
    const items = collectDecisionItems(task || {});
    const record = task && task.decision_record;
    const slots =
        record &&
        typeof record === "object" &&
        Array.isArray(record.items)
            ? record.items.map((slot, i) => ({
                  index: i + 1,
                  id: slot && slot.id,
                  disposition: slot && slot.disposition,
                  carrier: slot && slot.carrier,
              }))
            : [];
    return { items, slots };
}

function deleteCoordinationTask(sessionID, taskIDRaw, options = {}) {
    const actor = coordinationActorContext(sessionID, options);
    const forced = options.force === true;

    // 1. Exact single-ID normalization. Batch is OUT of scope — this is a
    //    single-card destructive op. Reject any selector/wildcard/path-like
    //    hint BEFORE filesystem mutation so the refusal is honest about
    //    intent (the normalized slug form would silently rewrite "*foo" into
    //    "foo", hiding a probable batch attempt). Arrays / non-strings are
    //    rejected as missing input.
    if (typeof taskIDRaw !== "string" || taskIDRaw.trim() === "") {
        throw new StateError(
            "delete_coordination_task requires a non-empty task_id.",
        );
    }
    const rawTrimmed = taskIDRaw.trim();
    // Whitespace inside a trimmed task id is a strong multiple-token / paste
    // signal: slugify collapses runs of [^a-z0-9._-] (incl. spaces) to "-", so
    // "alpha beta" would silently become "alpha-beta" — a DIFFERENT single id
    // than either token the operator typed. Reject it before normalization so
    // the refusal is honest, the same way "*" is rejected above.
    if (/\s/.test(rawTrimmed)) {
        throw new StateError(
            `delete_coordination_task requires an exact single task_id; whitespace-separated input is not accepted ("${rawTrimmed}").`,
        );
    }
    if (
        rawTrimmed.includes("*") ||
        rawTrimmed.includes("?") ||
        rawTrimmed.includes(",") ||
        rawTrimmed.includes("[") ||
        rawTrimmed.includes("]") ||
        rawTrimmed.includes("/") ||
        rawTrimmed.includes("\\") ||
        rawTrimmed.includes("..")
    ) {
        throw new StateError(
            `delete_coordination_task requires an exact single task_id; wildcards, selectors, comma-lists, and path-like input are not accepted ("${rawTrimmed}").`,
        );
    }
    // Normalize through the existing ID seam, but surface any refusal with a
    //    stable delete-prefixed message: slugify throws an UN-prefixed error
    //    for inputs that reduce to an empty slug (e.g. a lone "."), so wrap it
    //    so every refusal from this op carries the tag.
    let taskID;
    try {
        taskID = normalizeCoordinationTaskId(rawTrimmed);
    } catch (error) {
        throw new StateError(
            `delete_coordination_task requires an exact single task_id; "${rawTrimmed}" is not acceptable (${error instanceof StateError ? error.message : "normalization failed"}).`,
        );
    }
    if (!taskID || taskID.trim() === "") {
        throw new StateError(
            `delete_coordination_task requires an exact single task_id; "${rawTrimmed}" normalizes to an empty slug.`,
        );
    }

    // 2. Transport-only path construction + PHYSICAL containment. Derive the
    //    targets ONLY from the normalized id through the existing helpers,
    //    then assert each target is physically contained inside its transport
    //    root. Containment is PHYSICAL, not lexical: we resolve the transport
    //    ancestor, the roots, and any present candidate via fs.realpathSync
    //    and REFUSE any symlink that would redirect a recursive rmSync out of
    //    transport (e.g. a reports root or report dir symlinked at docs/). A
    //    purely lexical path.resolve + startsWith check would pass a symlinked
    //    root and let rmSync delete through it into a committed location.
    //    Never accept arbitrary paths; never address docs/,
    //    docs/planning/backlog.md, or any committed location.
    const isStrictlyInside = (candidate, root) =>
        candidate !== root && candidate.startsWith(`${root}${path.sep}`);

    // Resolve a path to its real (symlink-dereferenced) location, REFUSING if
    //    the path is a symlink (realpath differs from the lexical path).
    //    Returns null when the path does not exist (the caller falls back to a
    //    lexical check against an already-real root — there is no symlink to
    //    follow on a non-existent leaf).
    const resolveRealRefusingSymlink = (lexical) => {
        if (!fs.existsSync(lexical)) {
            return null;
        }
        let resolved;
        try {
            resolved = fs.realpathSync(lexical);
        } catch (_error) {
            throw new StateError(
                `delete_coordination_task: failed to resolve the real path of "${relativeToRepo(lexical)}"; refusing to delete.`,
            );
        }
        if (resolved !== lexical) {
            throw new StateError(
                `delete_coordination_task: path "${relativeToRepo(lexical)}" resolves to a different physical location (symlink detected at "${resolved}"); refusing to delete.`,
            );
        }
        return resolved;
    };

    // Canonical transport ancestor (.local/<coord>/). Refuse if it is itself a
    //    symlink or absent — a missing transport means nothing was ever
    //    created there, so there is nothing to delete.
    const transportLexical = path.resolve(localCoordinatorRoot());
    const transportReal = resolveRealRefusingSymlink(transportLexical);
    if (transportReal === null) {
        throw new StateError(
            `delete_coordination_task: coordinator transport root is not present; nothing to delete.`,
        );
    }

    // Each transport root must not be a symlink and must sit strictly inside
    //    the (real) transport ancestor. A missing root returns null and is
    //    checked lexically against the real transport ancestor (no candidate
    //    can exist under a missing root, but we still fence the lexical path).
    const fenceRoot = (rootLexical, label) => {
        const rootReal = resolveRealRefusingSymlink(rootLexical);
        const effective = rootReal !== null ? rootReal : rootLexical;
        if (!isStrictlyInside(effective, transportReal)) {
            throw new StateError(
                `delete_coordination_task: ${label} transport root resolves outside the coordinator transport area ("${effective}"); refusing to delete.`,
            );
        }
        return effective;
    };
    const tasksRootReal = fenceRoot(
        path.resolve(localCoordinatorTasksRoot()),
        "tasks",
    );
    const reportsRootReal = fenceRoot(
        path.resolve(localCoordinatorReportsRoot()),
        "reports",
    );

    // Each candidate must be physically contained inside its (real) root. A
    //    candidate that exists is realpath-resolved and refused if it is a
    //    symlink or escapes the root; a missing leaf is checked lexically
    //    against the real root (no symlink to follow on a non-existent path).
    const fenceCandidate = (candidateAny, rootReal, label) => {
        const candidateLexical = path.resolve(candidateAny);
        const candidateReal = resolveRealRefusingSymlink(candidateLexical);
        const effective =
            candidateReal !== null ? candidateReal : candidateLexical;
        if (!isStrictlyInside(effective, rootReal)) {
            throw new StateError(
                `delete_coordination_task: resolved ${label} is not strictly inside the ${label} transport root; refusing to delete "${effective}".`,
            );
        }
    };
    const cardPath = coordinationTaskPath(taskID);
    const reportDir = coordinationTaskReportDir(taskID);
    fenceCandidate(cardPath, tasksRootReal, "card");
    fenceCandidate(reportDir, reportsRootReal, "report directory");

    // 3. Lenient-load. Read the exact card path directly; if it parses,
    //    extract best-effort summary fields. Do NOT require core-field
    //    validation — degraded and malformed cards are precisely the cards an
    //    operator may need to retire, so strict validation here would brick
    //    the retire path. A missing file is a not-found refusal; a parse
    //    failure is classified as malformed and removal proceeds.
    if (!fs.existsSync(cardPath)) {
        throw new StateError(
            `delete_coordination_task: card not found for task_id "${taskID}" (expected at ${relativeToRepo(cardPath)}).`,
        );
    }
    let parsedCard = null;
    let malformed = false;
    try {
        const readBack = JSON.parse(fs.readFileSync(cardPath, "utf8"));
        if (!readBack || typeof readBack !== "object" || Array.isArray(readBack)) {
            malformed = true;
            parsedCard = null;
        } else {
            parsedCard = readBack;
        }
    } catch (_error) {
        malformed = true;
        parsedCard = null;
    }

    // Honest best-effort summary. No validation, no refusal on a missing
    // field — the summary's job is to report what was there. A non-object or
    // unparseable card surfaces null title + "degraded" status + null owner.
    const summaryTitle =
        parsedCard &&
        typeof parsedCard.title === "string" &&
        parsedCard.title.trim()
            ? parsedCard.title
            : null;
    const summaryStatus =
        parsedCard &&
        typeof parsedCard.status === "string" &&
        parsedCard.status.trim()
            ? parsedCard.status
            : "degraded";
    const summaryOwner =
        parsedCard &&
        typeof parsedCard.active_session_alias === "string" &&
        parsedCard.active_session_alias.trim()
            ? parsedCard.active_session_alias
            : null;

    // 4. Active-owner guard. Refuse an actively-owned working card unless the
    //    caller passed force. This MUST run before any fs mutation. Degraded
    //    tolerance is preserved: a malformed card (parsedCard === null) gets
    //    status "degraded" + null owner, so it does not trip this guard — only
    //    a genuinely working + actively-owned card is protected.
    const isActiveWorking = summaryStatus === "working" && Boolean(summaryOwner);
    if (isActiveWorking && !forced) {
        return {
            ...actor,
            ok: false,
            operation: "delete_coordination_task",
            refusal: {
                code: "active_working_task",
                task_id: taskID,
                status: "working",
                active_session_alias: summaryOwner,
                force_required: true,
                message: `Task ${taskID} is currently active in session ${summaryOwner}. Re-run with an explicit force only if you intend to destroy an in-flight task's local card and report directory. This does not mark the task cancelled and does not bypass review or closeout.`,
            },
        };
    }

    // 4b. In-flight lifecycle guard. A card that has entered the active
    //     lifecycle — working without an active owner (stale/abandoned),
    //     reported, or blocked — carries a closeout report or work evidence
    //     that a coordinator gate (/task-review, /task-closeout) may still need
    //     to consume. Refuse deletion without an explicit force so this retire
    //     wrapper cannot bypass a pending review or closeout gate by destroying
    //     the evidence first. Only pre-work / terminal-gate-passed statuses
    //     (draft, ready, cancelled) are freely disposable. Degraded tolerance
    //     is preserved: a malformed card (parsedCard === null) gets status
    //     "degraded", which is not in the protected set.
    //
    //     `completed` is NOT in this set: it enters the landing-gated
    //     retirement path in step 4c (a completed card WITH a reachable
    //     Task-Card trailer IS retireable). Critically, this in-flight
    //     protection for working/reported/blocked is NOT weakened by the
    //     completed-retirement path — it runs FIRST and refuses EVEN IF a
    //     landing commit appears, because their report evidence may still be
    //     needed by a coordinator gate regardless of any commit.
    const PROTECTED_INFLIGHT_STATUSES = new Set([
        "working",
        "reported",
        "blocked",
    ]);
    if (PROTECTED_INFLIGHT_STATUSES.has(summaryStatus) && !forced) {
        const lifecycleMessage =
            summaryStatus === "working"
                ? `Task ${taskID} is 'working' (no active owner; possibly stale) and may carry in-progress work artifacts in its report directory. Refusing deletion without explicit force.`
                : `Task ${taskID} is '${summaryStatus}' and has entered the review/closeout pipeline; its report directory carries evidence /task-review or /task-closeout may still need to consume. Refusing deletion without explicit force so the retire wrapper cannot bypass a pending coordinator gate. This does not mark the task cancelled.`;
        return {
            ...actor,
            ok: false,
            operation: "delete_coordination_task",
            refusal: {
                code: "lifecycle_state_protected",
                task_id: taskID,
                status: summaryStatus,
                force_required: true,
                message: lifecycleMessage,
            },
        };
    }

    // 4c. Landing-gated retirement path for `completed` cards. A completed card
    //     may be retired as done ONLY when a reachable commit carrying the exact
    //     `Task-Card: <card-id>` trailer is present (the landing-proof contract,
    //     RECORD_LIFECYCLE.md; the 2026-08-07 lesson: a card deleted on review
    //     approval alone while the commit later failed to land). The verifier is
    //     a REACHABILITY check (git log --branches over all branch tips, never
    //     object existence). `force` overrides this as an explicit emergency
    //     path — NOT the ordinary completed-cleanup route. In-flight statuses
    //     (working/reported/blocked) were already handled in 4b and never reach
    //     here. Degraded tolerance: a malformed card surfaces status "degraded"
    //     (not "completed"), so it bypasses this path and stays freely
    //     disposable (4b does not protect it either).
    if (summaryStatus === "completed" && !forced) {
        const landing = verifyLandingProof(taskID, options.landingProofRepo);
        if (!landing.proven) {
            const remedy = `Ensure the work landed on a branch under the exact "Task-Card: ${taskID}" trailer, or re-run with explicit force ONLY for genuine legacy/emergency cleanup (force bypasses the landing check and destroys the card + report directory, not transitioned).`;
            return {
                ...actor,
                ok: false,
                operation: "delete_coordination_task",
                refusal: {
                    code: "landing_not_confirmed",
                    task_id: taskID,
                    status: "completed",
                    reason: landing.reason,
                    query: landing.query,
                    force_required: true,
                    message: `Task ${taskID} is 'completed' but its landing is not confirmed: ${landing.detail}. The retirement path requires a reachable commit carrying the exact "Task-Card: ${taskID}" trailer. ${remedy}`,
                },
            };
        }
        // 4c-2. Retention-preservation gate (owner-approved 2026-10-25; v3
        //     item-enumerated replacement owner-approved 2026-10-27).
        //     Landing proven ≠ knowledge preserved: retirement deletes the
        //     card AND its report dir — the last local copy of decision-class
        //     content. Before removal, the v3 gate checks, in order:
        //       (1) the stored record is structurally sound (RAW shape);
        //       (2) INVENTORY BASELINE: every decision item currently on the
        //           card has a declared slot (a post-closeout addition —
        //           e.g. a blocked review — is a new-item mismatch and
        //           refuses; removals do NOT remove their slots — the stored
        //           record is the baseline and cannot be laundered by
        //           deletion);
        //       (3) every declared slot's carrier resolves against COMMITTED,
        //           branch-reachable state and carries the card-id anchor AND
        //           that item's handle.
        //     Legacy treatment: a card with NO decision_record follows the
        //     compatibility rule (refused only when decision items are
        //     non-empty); a stored version-1 (v1/v2) record is honored as
        //     legacy under exactly the same rule — the routine case retires,
        //     a decision-bearing legacy record must re-closeout under v3 (or
        //     force). Never weakens the guards above: this runs AFTER landing
        //     proof, completed-only, and force bypasses it as an explicit
        //     emergency.
        // Structural authority is the RAW stored record. The read-path
        // normalizeStoredDecisionRecord rebuilds {version, items}, so
        // checking AFTER normalization would silently strip record-level
        // junk from a hand-edited stored record and never name it (F2);
        // slot-level keys were never at risk (items are copied verbatim).
        // The raw pre-check refuses and names the exact structural problems;
        // only a record that is ABSENT (null or undefined — the legacy path
        // below) skips it — any other value that fails the shape check
        // (string, number, array, empty object) is degraded garbage and is
        // refused, not treated as "no record".
        const rawRecord = parsedCard ? parsedCard.decision_record : null;
        const record =
            rawRecord === null || rawRecord === undefined
                ? null
                : normalizeStoredDecisionRecord(rawRecord);
        const currentItems = collectDecisionItems(parsedCard);
        const isLegacyVersionOneRecord =
            rawRecord !== null &&
            rawRecord !== undefined &&
            typeof rawRecord === "object" &&
            !Array.isArray(rawRecord) &&
            rawRecord.version === 1;
        if (rawRecord !== null && rawRecord !== undefined && !isLegacyVersionOneRecord) {
            // 4c-2a. A stored v3 record must be STRUCTURALLY sound before its
            //     inventory is trusted. A degraded record (wrong version,
            //     missing items array, undeclared keys — checked on the RAW
            //     shape, pre-normalization) is NOT verified: a broken
            //     inventory proves nothing. Fail closed with
            //     decision_record_unresolved naming the structural problem,
            //     and name the current decision items so treatment is at
            //     least as strong as the legacy null-record path.
            const structuralProblems = collectDecisionRecordStructuralErrors(
                rawRecord,
                taskID,
            );
            if (structuralProblems.length > 0) {
                const namedStructural = structuralProblems
                    .map((detail) => `  - ${detail}`)
                    .join("\n");
                const namedItems = currentItems
                    .map((c) => `  - ${c.id} (${c.source}): ${c.detail}`)
                    .join("\n");
                return {
                    ...actor,
                    ok: false,
                    operation: "delete_coordination_task",
                    refusal: {
                        code: "decision_record_unresolved",
                        task_id: taskID,
                        status: "completed",
                        problems: structuralProblems.map((detail) => ({
                            index: 0,
                            kind: "record",
                            id: "",
                            locator: "",
                            code: "record_degraded",
                            detail,
                        })),
                        items: currentItems.map((c) => c.id),
                        force_required: true,
                        message:
                            `Task ${taskID} is 'completed' and landed, but its stored decision_record is invalid/degraded and is NOT treated as verified:\n${namedStructural}\n` +
                            (currentItems.length > 0
                                ? `Decision items currently on the card (the same check as a legacy card with no decision_record):\n${namedItems}\n`
                                : "") +
                            `Repair or re-declare the decision_record (close out again under the current v3 gate), or re-run with explicit force ONLY for genuine emergency cleanup — force destroys the card, the report directory, AND the unpreserved decision-class content.`,
                    },
                };
            }
        }
        if (record !== null && !isLegacyVersionOneRecord) {
            // INVENTORY BASELINE — new-item mismatch (owner condition 2):
            // every decision item on the card AS IT NOW STANDS must have a
            // declared slot. Items may appear after closeout through
            // sanctioned ops (a non-approve review via /task-review adds
            // last_review + a task_reviewed history event); such an item has
            // no slot and retirement refuses naming it. The sanctioned
            // remedy is the ADD-ONLY amendment: re-closeout declaring the
            // stored slots verbatim plus a fresh slot for the new item.
            // Removals need no check here — the baseline slots are verified
            // below regardless of what the card's fields now contain.
            {
                const declaredIds = new Set(
                    Array.isArray(record.items)
                        ? record.items
                              .filter(
                                  (slot) =>
                                      slot &&
                                      typeof slot === "object" &&
                                      typeof slot.id === "string",
                              )
                              .map((slot) => slot.id.trim())
                        : [],
                );
                const mismatched = currentItems.filter(
                    (item) => !declaredIds.has(item.id),
                );
                if (mismatched.length > 0) {
                    const named = mismatched
                        .map((m) => `  - ${m.id} (${m.source}): ${m.detail}`)
                        .join("\n");
                    const isRoutineInventory =
                        Array.isArray(record.items) && record.items.length === 0;
                    return {
                        ...actor,
                        ok: false,
                        operation: "delete_coordination_task",
                        refusal: {
                            code: "decision_content_unpromoted",
                            task_id: taskID,
                            status: "completed",
                            items: mismatched.map((m) => m.id),
                            force_required: true,
                            message:
                                (isRoutineInventory
                                    ? `Task ${taskID} carries a routine decision_record (empty inventory — nothing decision-class to preserve) but decision items are present on the card:\n${named}\n`
                                    : `Task ${taskID} declares a decision_record that does not enumerate every decision item currently on the card:\n${named}\n`) +
                                `These items have no preserved representation — a carrier containing only the card id satisfies nothing. The sanctioned amendment is a re-closeout declaring the stored slots VERBATIM plus a fresh slot for each new item (add-only; dropped or rewritten stored slots are refused at closeout), or re-run with explicit force ONLY for genuine emergency cleanup — force destroys it.`,
                        },
                    };
                }
            }
            // Per-slot carrier verification (owner condition 1): every
            // declared slot's carrier must be committed, branch-reachable,
            // card-id-anchored, and carrying THAT item's handle.
            const decision = verifyDecisionRecordForRetirement(
                taskID,
                record,
                options.landingProofRepo,
            );
            if (!decision.ok) {
                const named = decision.problems
                    .map(
                        (p) =>
                            `  - slot #${p.index}${p.id ? ` (${p.id})` : ""} (${p.kind}${p.locator ? ` ${p.locator}` : ""}): ${p.code} — ${p.detail}`,
                    )
                    .join("\n");
                return {
                    ...actor,
                    ok: false,
                    operation: "delete_coordination_task",
                    refusal: {
                        code: "decision_record_unresolved",
                        task_id: taskID,
                        status: "completed",
                        problems: decision.problems,
                        force_required: true,
                        message:
                            `Task ${taskID} is 'completed' and landed, but its decision_record does not resolve against committed, branch-reachable git state. ` +
                            `Retirement is refused so the last local copy of decision-class content is not destroyed:\n${named}\n` +
                            `Promote the content to a reachable commit or a committed durable file carrying the card-id anchor and the item's representation, or re-run with explicit force ONLY for genuine emergency cleanup — force destroys the card, the report directory, AND the unpreserved decision-class content.`,
                    },
                };
            }
            // Landing proven + baseline complete + every carrier resolved:
            // retire.
        } else if (isLegacyVersionOneRecord) {
            // Legacy v1/v2 record (stored under the 2026-10-25/26 gates):
            // honored as LEGACY under the same rule as a card with no
            // decision_record — retire routinely when the card carries no
            // decision items (the routine case, including a v2 routine
            // attestation); refuse when decision items are present, with
            // re-closeout under v3 as the remedy. This never weakens
            // preservation (it refuses more than v2 did, never less); the
            // v2 excerpt machinery itself is retired (owner-approved
            // simplification) and is NOT run for legacy records.
            if (currentItems.length > 0) {
                const named = currentItems
                    .map((c) => `  - ${c.id} (${c.source}): ${c.detail}`)
                    .join("\n");
                return {
                    ...actor,
                    ok: false,
                    operation: "delete_coordination_task",
                    refusal: {
                        code: "decision_content_unpromoted",
                        task_id: taskID,
                        status: "completed",
                        items: currentItems.map((c) => c.id),
                        force_required: true,
                        message:
                            `Task ${taskID} carries a legacy version-1 decision_record (declared under the retired v1/v2 gate) and decision items are present on the card:\n${named}\n` +
                            `Legacy records are honored only in the routine case. Re-declare under the current v3 gate — close out again declaring one slot per item — or re-run with explicit force ONLY for genuine emergency cleanup.`,
                    },
                };
            }
        } else {
            // Legacy compatibility (owner condition 5): no decision_record.
            // Refuse ONLY when decision items are present (nothing durable
            // was declared for them — retiring would destroy the last
            // copy); otherwise retire routinely.
            if (currentItems.length > 0) {
                const named = currentItems
                    .map((c) => `  - ${c.id} (${c.source}): ${c.detail}`)
                    .join("\n");
                return {
                    ...actor,
                    ok: false,
                    operation: "delete_coordination_task",
                    refusal: {
                        code: "decision_content_unpromoted",
                        task_id: taskID,
                        status: "completed",
                        items: currentItems.map((c) => c.id),
                        force_required: true,
                        message:
                            `Task ${taskID} is a legacy completed card with no decision_record, and decision items are present on the card:\n${named}\n` +
                            `Ordinary retirement would destroy the last local copy. Promote the content to a reachable commit or a committed durable file (close out again with a decision_record under the current gate), or re-run with explicit force ONLY for genuine emergency cleanup.`,
                    },
                };
            }
        }
        // Landing proven (+ decision record resolved where declared): fall
        // through to the removal sequence below.
    }

    // 5. Pre-removal summary. Built BEFORE any fs mutation; emitted to the
    //    beforeRemove hook so a caller can log or audit. The same summary
    //    (plus removal results) is returned post-removal.
    const summary = {
        task_id: taskID,
        title: summaryTitle,
        status: summaryStatus,
        active_session_alias: summaryOwner,
        malformed,
        card_path: relativeToRepo(cardPath),
        report_dir: relativeToRepo(reportDir),
        forced,
    };
    // 5b. Destructive warning for a FORCED completed retirement (owner
    //     condition: the force path survives with UNCHANGED semantics, but
    //     the warning must NAME the decision-class content about to be
    //     destroyed — current items and declared slots — not boilerplate).
    //     The force itself is not blocked by this inventory (best-effort).
    let decisionContentDestroyed = null;
    if (forced && summaryStatus === "completed") {
        decisionContentDestroyed =
            decisionRecordDestructionInventory(parsedCard);
        const hasItems = decisionContentDestroyed.items.length > 0;
        const hasSlots = decisionContentDestroyed.slots.length > 0;
        if (hasItems || hasSlots) {
            const itemLines = decisionContentDestroyed.items
                .map((f) => `  - card item ${f.id} (${f.source}): ${f.detail}`)
                .join("\n");
            const slotLines = decisionContentDestroyed.slots
                .map((s) => {
                    const carrier = s.carrier || {};
                    const locator =
                        carrier.kind === "artifact"
                            ? carrier.path
                            : carrier.kind === "commit"
                              ? carrier.revision || "<reachable history>"
                              : "";
                    return `  - decision_record slot #${s.index} (${s.id}${s.disposition ? `, ${s.disposition}` : ""}${locator ? `; carrier: ${locator}` : ""})`;
                })
                .join("\n");
            summary.destructive_warning =
                `force is destroying the LAST LOCAL COPY of decision-class content for ${taskID}:\n` +
                (hasItems ? `${itemLines}\n` : "") +
                (hasSlots ? `${slotLines}\n` : "") +
                `This content will NOT be recoverable from the card, the report directory, or (unless independently promoted) git history.`;
            summary.decision_content_destroyed = decisionContentDestroyed;
        }
    }
    if (typeof options.beforeRemove === "function") {
        options.beforeRemove(summary);
    }

    // 6. Removal sequence (removeIfExists idiom). Exact card JSON first, then
    //    the exact report dir recursively. Verify each is gone. Do NOT read
    //    fields again after deletion.
    let cardRemoved = false;
    if (fs.existsSync(cardPath)) {
        fs.rmSync(cardPath, { recursive: true, force: true });
        cardRemoved = !fs.existsSync(cardPath);
    }
    let reportDirRemoved = false;
    if (fs.existsSync(reportDir)) {
        fs.rmSync(reportDir, { recursive: true, force: true });
        reportDirRemoved = !fs.existsSync(reportDir);
    }

    return {
        ...actor,
        ok: true,
        operation: "delete_coordination_task",
        removed: {
            task_id: taskID,
            title: summaryTitle,
            status: summaryStatus,
            malformed,
            forced,
            card_removed: cardRemoved,
            report_dir_removed: reportDirRemoved,
            ...(decisionContentDestroyed
                ? {
                      decision_content_destroyed: decisionContentDestroyed,
                      destructive_warning: summary.destructive_warning,
                  }
                : {}),
        },
    };
}

// =============================================================================
// Skill-authoring proposal transport (CC borrowable #4, N11+R4)
// =============================================================================
// A dedicated, LIGHTER-WEIGHT sibling of the coordination-task registry. Like
// task cards, proposals are gitignored LOCAL CANDIDATE TRANSPORT under
// .local/coordinator/skill-proposals/ — transport, not truth. Unlike
// task cards, a proposal has no lifecycle state machine beyond
// draft → accepted | rejected, no closeout, no review cascade, no recurrence
// dedup, and no report envelope: it is pure intake. The value is a structured
// card that survives compaction so a model-discovered reusable workflow can be
// captured for human review instead of lost in chat.
//
// Candidate-vs-authority boundary (non-negotiable): a proposal is NEVER
// authority. It cannot install a skill, write a canonical SKILL.md, alter a
// promotion state, or bypass the S2 overlay-pilot-then-promote gate.
// Acceptance (`status: accepted`) ONLY marks a proposal human-approved for
// SEPARATELY AUTHORIZED overlay authoring under
// .vh-agent-harness/overlays/<pack>/skills/; it creates nothing. The /init
// direct-write path (a model writing SKILL.md directly into .opencode/skills/)
// is REJECTED by design — this transport is the sanctioned intake surface
// instead. Provenance is enforced at the write layer: nested
// metadata.proposal-origin MUST equal "model-session", and a top-level
// created_by field is REFUSED (the intake debate explicitly rejected the
// top-level authority-adjacent tag). See AGENTS.core.md → "Skill-authoring
// proposal intake".

const SKILL_PROPOSAL_STATUSES = ["draft", "accepted", "rejected"];
const SKILL_PROPOSAL_ORIGIN = "model-session";
const SKILL_PROPOSAL_SCHEMA_VERSION = 1;

function localCoordinatorSkillProposalsRoot() {
    return path.join(localCoordinatorRoot(), "skill-proposals");
}

function skillProposalPath(proposalID) {
    return path.join(
        localCoordinatorSkillProposalsRoot(),
        `${normalizeSkillProposalId(proposalID)}.json`,
    );
}

function skillProposalLockPath(proposalID) {
    return path.join(
        localCoordinatorSkillProposalsRoot(),
        `.${normalizeSkillProposalId(proposalID)}.lock`,
    );
}

function normalizeSkillProposalId(value) {
    const normalized = slugify(value);
    return normalized.startsWith("skill-propose-")
        ? normalized
        : `skill-propose-${normalized}`;
}

function generateSkillProposalId(skillSlug) {
    // Pre-normalize so the returned proposal_id matches the on-disk filename
    // stem (skillProposalPath also normalizes via slugify, which lowercases
    // planTimestamp()'s capital "T"). Without this, a fresh create's returned
    // proposal_id diverged in case from the filename until a re-normalizing
    // update converged them. D2 fix.
    return normalizeSkillProposalId(
        `skill-propose-${planTimestamp()}-${slugify(skillSlug || "skill")}`,
    );
}

function defaultSkillProposalMetadata() {
    return {
        "proposal-origin": SKILL_PROPOSAL_ORIGIN,
        proposing_session_id: null,
        proposing_session_name: null,
    };
}

function defaultSkillProposalPayload(proposalID) {
    return {
        schema_version: SKILL_PROPOSAL_SCHEMA_VERSION,
        proposal_id: proposalID,
        skill_slug: "",
        skill_name: "",
        description: "",
        trigger: "",
        proposed_pack: null,
        rationale: "",
        evidence_refs: [],
        proposed_skill_content: "",
        metadata: defaultSkillProposalMetadata(),
        status: "draft",
        accepted_at: null,
        rejected_at: null,
        rejection_reason: "",
        created_at: null,
        updated_at: null,
        history: [],
    };
}

// Enforce the candidate-vs-authority provenance contract at the write layer.
// Collects every problem and throws one aggregated StateError (same collect-all
// contract as ensureCoordinationTaskCoreFields). A proposal MUST carry nested
// metadata.proposal-origin === "model-session" (the only admitted origin), and
// MUST NOT carry a top-level created_by field — the intake debate explicitly
// rejected the top-level tag because it reads as authority.
function ensureSkillProposalCoreFields(payload) {
    const problems = [];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new StateError("Skill proposal payload must be a JSON object.");
    }
    if (
        Object.prototype.hasOwnProperty.call(payload, "created_by") &&
        payload.created_by !== undefined &&
        payload.created_by !== null &&
        payload.created_by !== ""
    ) {
        problems.push(
            'Skill proposal must NOT carry a top-level "created_by" field; provenance is nested under metadata.proposal-origin (the top-level tag was explicitly rejected as authority-adjacent).',
        );
    }
    const requiredStrings = {
        skill_slug: "skill slug",
        skill_name: "skill name",
        description: "description",
        trigger: "trigger (when to use the skill)",
    };
    for (const [field, label] of Object.entries(requiredStrings)) {
        if (!String(payload[field] || "").trim()) {
            problems.push(`Skill proposal missing required field: ${label}.`);
        }
    }
    const metadata =
        payload.metadata &&
        typeof payload.metadata === "object" &&
        !Array.isArray(payload.metadata)
            ? payload.metadata
            : null;
    if (!metadata) {
        problems.push(
            'Skill proposal missing required nested "metadata" object (provenance lives under metadata.proposal-origin, never top-level).',
        );
    } else {
        const origin = String(metadata["proposal-origin"] || "").trim();
        if (origin !== SKILL_PROPOSAL_ORIGIN) {
            problems.push(
                `Skill proposal metadata.proposal-origin must be exactly "${SKILL_PROPOSAL_ORIGIN}" (got "${origin || "<empty>"}"). Only model-session proposals are admitted by the intake.`,
            );
        }
    }
    throwCollectedErrors(problems);
}

// The human gate. draft → accepted | rejected only; terminal states
// (accepted, rejected) are closed and cannot reopen or re-transition. This is
// the candidate-vs-authority control: once a human has decided, a model cannot
// resurrect or relabel the proposal. save_skill_proposal never moves status.
function skillProposalStatusTransitionErrors(
    currentStatus,
    nextStatus,
    options = {},
) {
    const current = String(currentStatus || "").trim() || "draft";
    const next = String(nextStatus || "").trim().toLowerCase();
    if (options.created) {
        if (next !== "draft") {
            return ["New skill proposals must start in status draft."];
        }
        return [];
    }
    if (!next) {
        return ["set_skill_proposal_status requires a target status."];
    }
    if (!SKILL_PROPOSAL_STATUSES.includes(next)) {
        return [
            `Skill proposal status must be one of ${SKILL_PROPOSAL_STATUSES.join(", ")} (got "${next}").`,
        ];
    }
    if (current === next) {
        return [
            `Skill proposal is already in status ${current}; set_skill_proposal_status requires a transition.`,
        ];
    }
    const permitted = { draft: ["accepted", "rejected"] }[current];
    if (!permitted || !permitted.includes(next)) {
        return [
            `Skill proposal status ${current} cannot transition to ${next}. Only draft → accepted | rejected is allowed; accepted and rejected are terminal.`,
        ];
    }
    return [];
}

function loadSkillProposal(proposalIDRaw, options = {}) {
    ensureLocalCoordinatorNamespace();
    const proposalID = normalizeSkillProposalId(proposalIDRaw);
    const targetPath = skillProposalPath(proposalID);
    if (!fs.existsSync(targetPath)) {
        if (options.required === false) {
            return {
                proposal_id: proposalID,
                path: targetPath,
                payload: defaultSkillProposalPayload(proposalID),
                exists: false,
            };
        }
        throw new StateError(
            `Skill proposal does not exist: ${relativeToRepo(targetPath)}`,
        );
    }
    const raw = readJson(targetPath, defaultSkillProposalPayload(proposalID));
    const payload = {
        ...defaultSkillProposalPayload(proposalID),
        ...raw,
        metadata: {
            ...defaultSkillProposalMetadata(),
            ...((raw && raw.metadata) || {}),
        },
        proposal_id:
            raw && raw.proposal_id ? raw.proposal_id : proposalID,
        evidence_refs: Array.isArray(raw && raw.evidence_refs)
            ? raw.evidence_refs
            : [],
        history: Array.isArray(raw && raw.history) ? raw.history : [],
    };
    return { proposal_id: proposalID, path: targetPath, payload, exists: true };
}

// Internal scan boundary: read every card in the registry. Report-and-continue
// on a per-card parse failure (mirrors scanCoordinationTaskCards' syntax
// quarantine) so one corrupt .json does not brick the whole scan.
function scanSkillProposalCards() {
    ensureLocalCoordinatorNamespace();
    const root = localCoordinatorSkillProposalsRoot();
    const files = fs.existsSync(root) ? fs.readdirSync(root) : [];
    return files
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
            const proposalID = name.replace(/\.json$/, "");
            try {
                const loaded = loadSkillProposal(proposalID);
                return {
                    proposalID,
                    path: relativeToRepo(loaded.path),
                    proposal: loaded.payload,
                    parseError: null,
                };
            } catch (error) {
                return {
                    proposalID,
                    path: relativeToRepo(skillProposalPath(proposalID)),
                    proposal: null,
                    parseError:
                        error instanceof StateError
                            ? error.message
                            : String(error),
                };
            }
        });
}

function summarizeSkillProposal(proposal) {
    return {
        proposal_id: proposal.proposal_id,
        skill_slug: proposal.skill_slug,
        skill_name: proposal.skill_name,
        description: proposal.description,
        trigger: proposal.trigger,
        proposed_pack: proposal.proposed_pack || null,
        status: proposal.status,
        "proposal-origin":
            proposal.metadata && proposal.metadata["proposal-origin"]
                ? proposal.metadata["proposal-origin"]
                : null,
        created_at: proposal.created_at || null,
        updated_at: proposal.updated_at || null,
        accepted_at: proposal.accepted_at || null,
        rejected_at: proposal.rejected_at || null,
    };
}

function saveSkillProposal(sessionID, proposalPayload, options = {}) {
    const actor = coordinationActorContext(sessionID, options);
    const input =
        proposalPayload && typeof proposalPayload === "object"
            ? proposalPayload
            : {};
    // REFUSE a top-level authority-adjacent tag before any other work. The
    // intake debate explicitly rejected created_by; enforcing it at the write
    // layer makes the convention impossible to forget rather than a convention.
    if (
        input.created_by !== undefined &&
        input.created_by !== null &&
        input.created_by !== ""
    ) {
        throw new StateError(
            'Skill proposals must NOT carry a top-level "created_by" field; provenance is nested under metadata.proposal-origin.',
        );
    }
    const explicitID = String(input.proposal_id || "").trim();
    const skillSlug = String(
        input.skill_slug || input.skill_name || "skill",
    ).trim();
    const proposalID = explicitID
        ? normalizeSkillProposalId(explicitID)
        : generateSkillProposalId(skillSlug);
    // Enforced provenance: nested metadata stamped from the REAL session
    // context. A caller cannot forge a different origin; the transport owns
    // this field. proposing_session_* record who proposed, not authority.
    const metadata = {
        "proposal-origin": SKILL_PROPOSAL_ORIGIN,
        proposing_session_id: actor.session_id || null,
        proposing_session_name: actor.session_name || null,
    };
    const candidateFields = {
        skill_slug: String(input.skill_slug || "").trim(),
        skill_name: String(input.skill_name || "").trim(),
        description: String(input.description || "").trim(),
        trigger: String(input.trigger || "").trim(),
        proposed_pack: input.proposed_pack
            ? String(input.proposed_pack).trim() || null
            : null,
        rationale: String(input.rationale || "").trim(),
        evidence_refs: normalizeStringList(input.evidence_refs),
        proposed_skill_content: String(input.proposed_skill_content || ""),
    };
    const lockPath = skillProposalLockPath(proposalID);
    const result = withLock(lockPath, () => {
        const existing = loadSkillProposal(proposalID, { required: false });
        const created = !existing.exists;
        // save NEVER moves status. Create is draft-only; updates preserve the
        // existing status. A terminal-state proposal (accepted/rejected) is
        // frozen — re-editing would bypass the human gate's finality. The
        // operator who changed their mind opens a NEW proposal.
        const currentStatus = existing.exists ? existing.payload.status : null;
        if (existing.exists && currentStatus !== "draft") {
            throw new StateError(
                `Skill proposal ${proposalID} is in terminal status ${currentStatus}; open a new proposal instead of editing a decided one.`,
            );
        }
        // save NEVER moves status. Route ONLY the create case through the
        // transition validator (draft-only-create: a brand-new proposal must
        // start in draft). Do NOT route a status-preserving UPDATE of an
        // existing draft through it: the validator's current===next branch
        // treats draft->draft as a non-transition and throws, even though
        // preserving draft is exactly the intended behavior on an update.
        // The preceding currentStatus !== "draft" guard already freezes
        // terminal cards (accepted/rejected), and the merged.status:"draft"
        // assignment below hardcodes draft for every save — together they
        // enforce the candidate-vs-authority invariant without mis-routing a
        // preservation save through a transition validator.
        // (B1 regression: before this was scoped to creates, every
        // existing-draft update deterministically threw, breaking /skill-propose
        // create on an existing proposal_id entirely.)
        if (created) {
            throwCollectedErrors(
                skillProposalStatusTransitionErrors(null, "draft", {
                    created: true,
                }),
            );
        }
        const base = existing.exists
            ? existing.payload
            : defaultSkillProposalPayload(proposalID);
        const merged = {
            ...base,
            ...candidateFields,
            schema_version: SKILL_PROPOSAL_SCHEMA_VERSION,
            proposal_id: proposalID,
            metadata,
            status: "draft",
            created_at: base.created_at || isoZ(),
            updated_at: isoZ(),
            accepted_at: base.accepted_at || null,
            rejected_at: base.rejected_at || null,
            rejection_reason: base.rejection_reason || "",
            history: Array.isArray(base.history)
                ? base.history.map((entry) => ({ ...entry }))
                : [],
        };
        merged.history.push({
            at: isoZ(),
            event: created ? "proposal_created" : "proposal_updated",
            session_name: actor.session_name || null,
            status: "draft",
            note: created
                ? "Model-originated skill proposal captured as a draft candidate."
                : "Draft proposal content updated.",
        });
        ensureSkillProposalCoreFields(merged);
        atomicWriteJson(skillProposalPath(proposalID), merged);
        return { proposal: merged, created };
    });
    return {
        ...actor,
        path: relativeToRepo(skillProposalPath(proposalID)),
        proposal: result.proposal,
        summary: summarizeSkillProposal(result.proposal),
        created: result.created,
    };
}

function readSkillProposal(sessionID, proposalIDRaw, options = {}) {
    const actor = coordinationActorContext(sessionID, options);
    const loaded = loadSkillProposal(proposalIDRaw);
    return {
        ...actor,
        path: relativeToRepo(loaded.path),
        proposal: loaded.payload,
        summary: summarizeSkillProposal(loaded.payload),
    };
}

function listSkillProposals(sessionID, options = {}) {
    const actor = coordinationActorContext(sessionID, options);
    const statuses = normalizeStringList(options.statuses).map((value) =>
        String(value || "").trim().toLowerCase(),
    );
    const scanned = scanSkillProposalCards();
    const quarantine = scanned
        .filter((entry) => entry.parseError)
        .map((entry) => ({
            proposal_id: entry.proposalID,
            path: entry.path,
            problems: [entry.parseError],
        }));
    const matching = scanned
        .filter((entry) => entry.proposal)
        .filter((entry) =>
            statuses.length
                ? statuses.includes(entry.proposal.status)
                : true,
        );
    const counts = {};
    for (const entry of matching) {
        counts[entry.proposal.status] =
            (counts[entry.proposal.status] || 0) + 1;
    }
    return {
        ...actor,
        total: matching.length,
        status_counts: counts,
        proposals: matching.map((entry) => ({
            ...summarizeSkillProposal(entry.proposal),
            path: entry.path,
        })),
        quarantine,
    };
}

// The human accept/reject gate. This is the load-bearing transition that makes
// the intake safe: a model proposal advances ONLY when a human (driving a build
// session) moves it from draft to accepted or rejected. Acceptance does NOT
// create a skill — it only marks the proposal human-approved for SEPARATELY
// AUTHORIZED overlay authoring. Rejection is terminal and may carry a reason.
//
// ENFORCEMENT MODEL (B2): the human gate is DOCUMENTATION-ENFORCED, not
// code-enforced — identical to the task-card promotion pattern
// (saveCoordinationTask likewise accepts a model-supplied status:"ready"; the
// rule forbidding a model from promoting its own task out of draft lives in
// AGENTS.core.md, not in code). opencode's plan-state tool surface is ONE tool
// with an operation enum and cannot distinguish human-initiated from
// model-initiated calls, so set_skill_proposal_status cannot be scoped out of
// agent-reachable plan-state. The model-facing prohibition ("a model must not
// accept/reject its own proposal") lives in AGENTS.core.md. The mechanical
// gates that hold REGARDLESS of who calls this are DOWNSTREAM:
//   (1) overlay authoring requires human file writes under
//       .vh-agent-harness/overlays/<pack>/skills/<name>/SKILL.md;
//   (2) the S2 hold gates overlay->core promotion on real-repo pilot evidence;
//   (3) core promotion requires human approval.
// A model that self-accepts still cannot self-author an overlay, self-promote
// through S2, or self-promote to core. Acceptance is "human-approved to START
// overlay authoring", not promotion. Do not claim this gate is code-enforced.
function setSkillProposalStatus(
    sessionID,
    proposalIDRaw,
    nextStatus,
    options = {},
) {
    const actor = coordinationActorContext(sessionID, options);
    const proposalID = normalizeSkillProposalId(proposalIDRaw);
    const target = String(nextStatus || "").trim().toLowerCase();
    const rejectionReason = String(options.rejectionReason || "").trim();
    const lockPath = skillProposalLockPath(proposalID);
    const result = withLock(lockPath, () => {
        const loaded = loadSkillProposal(proposalID, { required: false });
        if (!loaded.exists) {
            throw new StateError(
                `Skill proposal does not exist: ${relativeToRepo(loaded.path)}`,
            );
        }
        const current = loaded.payload;
        throwCollectedErrors(
            skillProposalStatusTransitionErrors(current.status, target),
        );
        const now = isoZ();
        const updated = {
            ...current,
            status: target,
            updated_at: now,
            accepted_at:
                target === "accepted"
                    ? now
                    : current.accepted_at || null,
            rejected_at:
                target === "rejected"
                    ? now
                    : current.rejected_at || null,
            rejection_reason:
                target === "rejected"
                    ? rejectionReason || current.rejection_reason || ""
                    : current.rejection_reason || "",
            history: (
                Array.isArray(current.history) ? current.history : []
            ).map((entry) => ({ ...entry })),
        };
        updated.history.push({
            at: now,
            event: `proposal_${target}`,
            session_name: actor.session_name || null,
            status: target,
            note:
                target === "accepted"
                    ? "Human accepted the proposal for separately authorized overlay authoring (no skill is created by acceptance)."
                    : `Human rejected the proposal${rejectionReason ? `: ${rejectionReason}` : "."}`,
        });
        ensureSkillProposalCoreFields(updated);
        atomicWriteJson(loaded.path, updated);
        return updated;
    });
    return {
        ...actor,
        path: relativeToRepo(skillProposalPath(proposalID)),
        proposal: result,
        summary: summarizeSkillProposal(result),
    };
}

// Sanctioned single-card retire path. Mirrors deleteCoordinationTask's
// single-ID + physical-containment discipline but lighter (no report dir, no
// lifecycle gate): a skill proposal is gitignored disposable transport, so
// removing an unpromoted card loses nothing durable. This is NOT a lifecycle
// status and must NOT be used to bypass the accept/reject gate — it retires
// transport, it does not decide the proposal.
function deleteSkillProposal(sessionID, proposalIDRaw, options = {}) {
    const actor = coordinationActorContext(sessionID, options);
    if (typeof proposalIDRaw !== "string" || proposalIDRaw.trim() === "") {
        throw new StateError(
            "delete_skill_proposal requires a non-empty proposal_id.",
        );
    }
    const rawTrimmed = proposalIDRaw.trim();
    if (
        /\s/.test(rawTrimmed) ||
        rawTrimmed.includes("*") ||
        rawTrimmed.includes("?") ||
        rawTrimmed.includes(",") ||
        rawTrimmed.includes("[") ||
        rawTrimmed.includes("]") ||
        rawTrimmed.includes("/") ||
        rawTrimmed.includes("\\") ||
        rawTrimmed.includes("..")
    ) {
        throw new StateError(
            `delete_skill_proposal requires an exact single proposal_id; wildcards, selectors, comma-lists, and path-like input are not accepted ("${rawTrimmed}").`,
        );
    }
    let proposalID;
    try {
        proposalID = normalizeSkillProposalId(rawTrimmed);
    } catch (error) {
        throw new StateError(
            `delete_skill_proposal requires an exact single proposal_id; "${rawTrimmed}" is not acceptable (${error instanceof StateError ? error.message : "normalization failed"}).`,
        );
    }
    const targetPath = skillProposalPath(proposalID);
    const root = path.resolve(localCoordinatorSkillProposalsRoot());
    const resolved = fs.existsSync(targetPath)
        ? path.resolve(fs.realpathSync(targetPath))
        : path.resolve(targetPath);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new StateError(
            "delete_skill_proposal target escapes the transport root; refusing.",
        );
    }
    const existed = fs.existsSync(targetPath);
    if (existed) {
        fs.rmSync(targetPath, { force: true });
    }
    const lockPath = skillProposalLockPath(proposalID);
    if (fs.existsSync(lockPath)) {
        try {
            fs.rmSync(lockPath, { force: true });
        } catch (_lockErr) {
            // Non-fatal: a stale lock for a deleted card is harmless.
        }
    }
    return {
        ...actor,
        ok: true,
        operation: "delete_skill_proposal",
        removed: {
            proposal_id: proposalID,
            card_removed: existed && !fs.existsSync(targetPath),
        },
    };
}

function activateCoordinationTask(sessionID, taskIDRaw, options = {}) {
    const actor = coordinationActorContext(sessionID, options);
    const loaded = loadCoordinationTask(taskIDRaw);
    // Pause-on-new-work gate (memo-4). This is the coord-task dispatch seam.
    // Gate ONLY the ready -> working transition (NEW dispatch): that is the
    // moment a prepared task begins executing. A working -> working resume /
    // reclaim / takeover is CONTINUATION of in-flight work and MUST remain
    // available under an engaged pause — the contract is "in-flight work is
    // never touched", and re-entering an already-active task is not new work.
    // The gate fires after load (so the status is known) but BEFORE
    // error-collection and before any mutation, so a ready-task refusal is
    // surfaced cleanly. In-flight child sessions already spawned are NOT
    // signalled or cancelled — see the plugin (pause-new-work.js) for the
    // TaskTool seam.
    if (loaded.payload.status === "ready") {
        const pauseState = readPauseState();
        if (pauseState.engaged) {
            throw new StateError(
                formatRefusal(
                    `coordination task activation (ready -> working for task ${loaded.payload.task_id}).`,
                ),
            );
        }
    }
    const errors = [];
    const missingResearchFields = missingResearchContractFields(loaded.payload);
    if (missingResearchFields.length) {
        const recommendation = coordinationTaskRecommendation(
            loaded.payload,
            actor.session_name || null,
        );
        errors.push(
            `Task ${loaded.payload.task_id} is missing research contract fields (${missingResearchFields.join(", ")}). ${recommendation.command ? `Use ${recommendation.command} before resuming execution.` : recommendation.note || "Repair the research contract before resuming execution."}`,
        );
    }
    if (!COORDINATION_RESUMABLE_STATUSES.has(loaded.payload.status)) {
        errors.push(
            `Task ${loaded.payload.task_id} is ${loaded.payload.status} and cannot be resumed directly. Use /task-ready for drafts or /task-review for reported/blocked work.`,
        );
    }
    const currentOwner = loaded.payload.active_session_alias || null;
    const actorSessionName = actor.session_name || null;
    if (!actorSessionName) {
        errors.push(
            `Task ${loaded.payload.task_id} requires a bound session alias before it can be resumed.`,
        );
    }
    const isTakeover =
        loaded.payload.status === "working" &&
        Boolean(currentOwner) &&
        currentOwner !== actorSessionName;
    if (loaded.payload.status === "working" && currentOwner && isTakeover && !options.forceTakeover) {
        errors.push(
            `Task ${loaded.payload.task_id} is already active in session ${currentOwner}. Re-run /resume-task only if you are continuing there, or explicitly request a takeover.`,
        );
    }
    throwCollectedErrors(errors);

    // F3 dispatch backstop (Slice 4). Re-verify the design-readiness envelope
    // is still current before ready -> working dispatch. This catches:
    // (a) post-crossing design drift — the design changed after draft -> ready
    //     but before the task is activated for execution; and
    // (b) bypassed ready states — e.g. a task created-as-ready via
    //     saveCoordinationTask (which skips readyCoordinationTask's primary
    //     F3 gate) lands at ready without an envelope.
    // BACKSTOP, not the primary gate — the primary gate is at
    // readyCoordinationTask (draft -> ready, inside the updateCoordinationTask
    // lock). A working -> working resume/reclaim/takeover is already past
    // dispatch and is exempt from the freshness re-check. This backstop runs
    // outside the lock: the worst-case race is a design change between this
    // check and the locked write, which only delays catching the staleness
    // until the next activation — acceptable for a backstop.
    if (loaded.payload.status === "ready") {
        const dispatchDigest = computeTaskDesignDigest(loaded.payload, {});
        const dispatchF3 = validateF3DesignReadiness({
            envelope: loaded.payload.f3_design_readiness,
            currentDesignDigest: dispatchDigest,
            transitionKind: "task_dispatch",
        });
        if (!dispatchF3.passed) {
            throw new StateError(
                `F3 dispatch backstop refused ready -> working ` +
                    `for task ${loaded.payload.task_id} ` +
                    `(reason: ${dispatchF3.reasonCode}). ` +
                    `${dispatchF3.detail} ` +
                    `The task's design-readiness envelope is stale, incomplete, ` +
                    `or missing relative to the current design. Re-ready the ` +
                    `task with a current envelope before dispatch.`,
            );
        }
    }

    const isReclaim =
        loaded.payload.status === "working" && !currentOwner;
    const recommendedSessionName = normalizeSessionName(loaded.payload.task_id);
    const claimedAt = isoZ();
    const saved = updateCoordinationTask(loaded.payload.task_id, (current) => ({
        ...current,
        status: "working",
        workstream_slug:
            current.workstream_slug || actor.active_workstream || null,
        session_aliases: actor.session_name
            ? uniqueStrings([...(current.session_aliases || []), actor.session_name])
            : current.session_aliases,
        active_session_alias: actorSessionName,
        claimed_at: claimedAt,
        next_action:
            current.status === "ready"
                ? defaultCoordinationTaskNextAction(current.task_id, "working")
                : String(current.next_action || "").trim() ||
                  defaultCoordinationTaskNextAction(current.task_id, "working"),
        history: [
            ...(current.history || []),
            {
                at: claimedAt,
                event: isTakeover
                    ? "task_taken_over"
                    : isReclaim
                      ? "task_reclaimed"
                      : "task_resumed",
                session_name: actor.session_name,
                status: "working",
                note: isTakeover
                    ? `Taken over by session ${actor.session_name} from ${currentOwner}.`
                    : isReclaim
                      ? `Reclaimed ownerless working task into session ${actor.session_name}.`
                    : actor.session_name
                      ? `Resumed from session ${actor.session_name}.`
                      : "Resumed without a bound session alias.",
            },
        ],
    }));
    return {
        ...actor,
        path: relativeToRepo(coordinationTaskPath(saved.task_id)),
        task: saved,
        summary: summarizeCoordinationTask(saved),
        took_over: isTakeover,
        previous_active_session_alias: isTakeover ? currentOwner : null,
        recommended_session_name: recommendedSessionName,
        ...recommendedCoordinationTaskFields(saved, actor.session_name || null),
    };
}

function resolveTaskDesignFields(currentPayload, incomingChanges) {
    const p =
        incomingChanges && typeof incomingChanges === "object"
            ? incomingChanges
            : {};
    return {
        task_id: currentPayload.task_id,
        title:
            p.title !== undefined
                ? String(p.title || "").trim()
                : currentPayload.title,
        task_type:
            p.task_type !== undefined
                ? String(p.task_type || "").trim().toLowerCase()
                : currentPayload.task_type,
        primary_lane:
            p.primary_lane !== undefined
                ? String(p.primary_lane || "").trim()
                : currentPayload.primary_lane,
        files_in_scope:
            p.files_in_scope !== undefined
                ? normalizeFileScope(p.files_in_scope)
                : currentPayload.files_in_scope,
        success_criteria:
            p.success_criteria !== undefined
                ? normalizeStringList(p.success_criteria)
                : currentPayload.success_criteria,
        constraints:
            p.constraints !== undefined
                ? normalizeStringList(p.constraints)
                : currentPayload.constraints,
        non_goals:
            p.non_goals !== undefined
                ? normalizeStringList(p.non_goals)
                : currentPayload.non_goals,
        validation_plan:
            p.validation_plan !== undefined
                ? normalizeStringList(p.validation_plan)
                : currentPayload.validation_plan,
    };
}

function computeTaskDesignDigest(currentPayload, incomingChanges) {
    return computeDesignDigest(
        resolveTaskDesignFields(currentPayload, incomingChanges),
    );
}

function readyCoordinationTask(sessionID, taskIDRaw, input = {}, options = {}) {
    const actor = coordinationActorContext(sessionID, options);
    const loaded = loadCoordinationTask(taskIDRaw);
    // ACTION BOUNDARY (load-bearing). A degraded card has at least one stored
    // field that failed read-path validation — most dangerously a stored
    // status that normalized to "draft" only because the original value was
    // invalid and coerced. Letting such a card through to the status guard
    // below would let it pass (coerced status === "draft") and promote a
    // malformed card to "ready", reproducing the exact hazard this slice
    // exists to close. Refuse BEFORE the status guard, regardless of the
    // coerced status, so direct-API promotion is blocked even if a caller
    // never reads listCoordinationTasks() guidance. The soft guidance layer
    // (coordinationTaskRecommendation with {degraded}) keeps the coordinator
    // from proposing the transition; this hard gate keeps every other caller
    // honest.
    if (loaded.diagnostics && loaded.diagnostics.degraded) {
        const fields = loaded.diagnostics.offendingFields.length
            ? loaded.diagnostics.offendingFields.join(", ")
            : "(unspecified)";
        throw new StateError(
            `Task ${loaded.payload.task_id} is degraded ` +
                `(offending fields: ${fields}) and cannot be prepared for ` +
                `execution. Inspect or repair the stored card first; a ` +
                `degraded card is refused at the action boundary regardless ` +
                `of its normalized status.`,
        );
    }
    if (!["draft", "ready"].includes(loaded.payload.status)) {
        throw new StateError(
            `Task ${loaded.payload.task_id} is ${loaded.payload.status} and cannot be prepared for execution.`,
        );
    }
    // --- TEST-ONLY pre-lock interleaving seam (lifecycle-TOCTOU exercise) ---
    // The locked current.status re-check inside updateCoordinationTask below
    // defends a TOCTOU window: between this pre-lock status guard (which read
    // loaded.payload.status) and lock acquisition inside updateCoordinationTask,
    // a concurrent caller may have transitioned the task (e.g., activated it
    // to "working"). This optional, per-call, synchronous callback fires
    // exactly once at the after-status-check / before-lock boundary so a
    // verifier can transition the task via the real lifecycle (ready +
    // activate, both through their own locked writes) and exercise the
    // locked re-check -> throw wiring deterministically.
    //
    // Containment contract (enforced by construction, mirroring the merge-path
    // _testPreLockInterleave seam):
    //  - per-call: passed via the options arg only; NOT an env var.
    //  - inert by default: every production + existing-test caller omits it.
    //  - synchronous, invoked at most once.
    //  - NOT propagated: readyCoordinationTask calls updateCoordinationTask
    //    (lock+persist), whose signature is (taskIDRaw, updateFn) with no
    //    options arg — the seam callback cannot reach it.
    //  - CANNOT override the status guard, suppress locking, authorize
    //    persistence, or override a thrown guard: the callback only provides
    //    the interleaving opportunity; the locked re-check inside
    //    updateCoordinationTask remains the sole authority and may still throw.
    if (typeof options._testPreLockInterleave === "function") {
        options._testPreLockInterleave({
            task_id: loaded.payload.task_id,
        });
    }
    const payload = input && typeof input === "object" ? input : {};
    const explicitNextAction =
        payload.next_action !== undefined
            ? String(payload.next_action || "").trim()
            : null;

    const saved = updateCoordinationTask(loaded.payload.task_id, (current) => {
        // Locked lifecycle re-check: the pre-lock status guard above read
        // loaded.payload.status. Between that read and this locked callback,
        // a concurrent caller may have transitioned the task (e.g.,
        // activated it to "working"). Re-check current.status before writing
        // to prevent a stale ready request from silently downgrading an
        // active worker's lifecycle claim.
        if (!["draft", "ready"].includes(current.status)) {
            throw new StateError(
                `Task ${current.task_id} is ${current.status} and cannot be prepared for execution.`,
            );
        }

        const wasDraft = current.status === "draft";

        // F3 design-readiness gate (sole BLOCKS family). Two firing modes:
        //
        // 1. draft -> ready BUILD-READY crossing (authoritative primary
        //    gate): validates the effective envelope — supplied or already
        //    persisted. Fail-closed: a task whose design names an ownership
        //    hazard but lacks a complete, current-digest-bound resolution
        //    package is refused — the task stays draft and no task_readied
        //    event is emitted.
        //
        // 2. ready -> ready envelope refresh (validate-when-supplied): a
        //    ready -> ready metadata refresh that does NOT touch
        //    f3_design_readiness crosses no BUILD-READY boundary and stays
        //    exempt, but a refresh that SUPPLIES an envelope is validated
        //    BEFORE the persist (which is otherwise unconditional). Without
        //    this, any supplied value — null -> anything, malformed, stale
        //    — persisted unvalidated on a ready card. Refusal keeps the
        //    task ready with its previously persisted envelope; nothing is
        //    persisted. Honesty ceiling: this closes the structural hole,
        //    not authorship forgery — a forged complete current-digest
        //    envelope still passes.
        //
        // Runs INSIDE the updateCoordinationTask lock so the digest is
        // computed from the locked `current` record, not a pre-load
        // snapshot. This prevents a TOCTOU race where a concurrent draft
        // metadata update changes a digest-bearing design field between
        // the check and the locked write.
        const f3Envelope =
            payload.f3_design_readiness !== undefined
                ? payload.f3_design_readiness
                : current.f3_design_readiness;
        const designDigest = computeTaskDesignDigest(current, payload);
        if (wasDraft) {
            const f3Result = validateF3DesignReadiness({
                envelope: f3Envelope,
                currentDesignDigest: designDigest,
                transitionKind: "task_ready",
            });
            if (!f3Result.passed) {
                throw new StateError(
                    `F3 design-readiness gate refused draft -> ready ` +
                        `(reason: ${f3Result.reasonCode}). ` +
                        `${f3Result.detail} ` +
                        `The task remains draft. Supply a complete ` +
                        `f3_design_readiness envelope bound to the current ` +
                        `design digest, or declare ownership_hazards: [] if ` +
                        `no hazard was named.`,
                );
            }
        } else if (payload.f3_design_readiness !== undefined) {
            // Validate-when-supplied on ready -> ready: the envelope a
            // refresh carries must pass the same transition-agnostic
            // predicate before the unconditional persist below applies it.
            const f3Result = validateF3DesignReadiness({
                envelope: f3Envelope,
                currentDesignDigest: designDigest,
                transitionKind: "task_ready_refresh",
            });
            if (!f3Result.passed) {
                throw new StateError(
                    `F3 design-readiness gate refused ready -> ready ` +
                        `envelope refresh (reason: ${f3Result.reasonCode}). ` +
                        `${f3Result.detail} ` +
                        `The task remains ready with its existing ` +
                        `f3_design_readiness envelope; the supplied ` +
                        `envelope was not persisted.`,
                );
            }
        }

        // Collect every enum-validation problem before throwing so a payload
        // with several bad enum fields reports all of them at once.
        const errors = [];
        const sourcePolicy =
            payload.source_policy !== undefined
                ? normalizeCoordinationEnumCollected(
                      payload.source_policy,
                      RESEARCH_SOURCE_POLICIES,
                      "source_policy",
                      errors,
                  ) || null
                : current.source_policy;
        const desiredArtifactType =
            payload.desired_artifact_type !== undefined
                ? normalizeCoordinationEnumCollected(
                      payload.desired_artifact_type,
                      RESEARCH_ARTIFACT_TYPES,
                      "desired_artifact_type",
                      errors,
                  ) || null
                : current.desired_artifact_type;
        const reportEnvelope =
            payload.report_envelope !== undefined
                ? normalizeCoordinationEnumCollected(
                      payload.report_envelope,
                      COORDINATION_REPORT_ENVELOPES,
                      "report_envelope",
                      errors,
                  ) || current.report_envelope
                : current.report_envelope;
        const next = {
            ...current,
            title:
                payload.title !== undefined
                    ? String(payload.title || "").trim()
                    : current.title,
            task_type:
                payload.task_type !== undefined
                    ? payload.task_type
                    : current.task_type,
            coordination_mode:
                payload.coordination_mode !== undefined
                    ? payload.coordination_mode
                    : current.coordination_mode,
            primary_lane:
                payload.primary_lane !== undefined
                    ? String(payload.primary_lane || "").trim()
                    : current.primary_lane,
            research_question:
                payload.research_question !== undefined
                    ? String(payload.research_question || "").trim()
                    : current.research_question,
            source_policy: sourcePolicy,
            source_allowlist:
                payload.source_allowlist !== undefined
                    ? normalizeStringList(payload.source_allowlist)
                    : current.source_allowlist,
            desired_artifact_type: desiredArtifactType,
            target_artifact_path:
                payload.target_artifact_path !== undefined
                    ? normalizeOptionalText(payload.target_artifact_path)
                    : current.target_artifact_path,
            rough_scope:
                payload.rough_scope !== undefined
                    ? normalizeStringList(payload.rough_scope)
                    : current.rough_scope,
            open_questions:
                payload.open_questions !== undefined
                    ? normalizeStringList(payload.open_questions)
                    : current.open_questions,
            ready_criteria:
                payload.ready_criteria !== undefined
                    ? normalizeStringList(payload.ready_criteria)
                    : current.ready_criteria,
            files_in_scope:
                payload.files_in_scope !== undefined
                    ? normalizeFileScope(payload.files_in_scope)
                    : current.files_in_scope,
            constraints:
                payload.constraints !== undefined
                    ? normalizeStringList(payload.constraints)
                    : current.constraints,
            non_goals:
                payload.non_goals !== undefined
                    ? normalizeStringList(payload.non_goals)
                    : current.non_goals,
            success_criteria:
                payload.success_criteria !== undefined
                    ? normalizeStringList(payload.success_criteria)
                    : current.success_criteria,
            validation_plan:
                payload.validation_plan !== undefined
                    ? normalizeStringList(payload.validation_plan)
                    : current.validation_plan,
            report_envelope: reportEnvelope,
            backlog_id:
                payload.backlog_id !== undefined
                    ? normalizeOptionalText(payload.backlog_id)
                    : current.backlog_id,
            workstream_slug:
                payload.workstream_slug !== undefined
                    ? normalizeOptionalWorkstream(payload.workstream_slug)
                    : current.workstream_slug,
            dependencies:
                payload.dependencies !== undefined
                    ? normalizeStringList(payload.dependencies)
                    : current.dependencies,
            owner_notes:
                payload.owner_notes !== undefined
                    ? normalizeStringList(payload.owner_notes)
                    : current.owner_notes,
            predicted_impact:
                payload.predicted_impact !== undefined
                    ? normalizeOptionalText(payload.predicted_impact)
                    : current.predicted_impact,
            f3_design_readiness:
                payload.f3_design_readiness !== undefined
                    ? payload.f3_design_readiness
                    : current.f3_design_readiness,
            status: "ready",
            next_action:
                explicitNextAction !== null
                    ? explicitNextAction
                    : wasDraft
                      ? defaultCoordinationTaskNextAction(current.task_id, "ready")
                      : current.next_action ||
                        defaultCoordinationTaskNextAction(current.task_id, "ready"),
            history: [
                ...(current.history || []),
                {
                    at: isoZ(),
                    event: wasDraft ? "task_readied" : "task_ready_updated",
                    session_name: actor.session_name,
                    status: "ready",
                    note: wasDraft
                        ? "Promoted draft task into ready execution state."
                        : "Updated ready task details before execution.",
                },
            ],
        };
        throwCollectedErrors(errors);
        return next;
    });
    return {
        ...actor,
        path: relativeToRepo(coordinationTaskPath(saved.task_id)),
        task: saved,
        summary: summarizeCoordinationTask(saved),
        ...recommendedCoordinationTaskFields(saved, actor.session_name || null),
    };
}

function updateCoordinationTaskMetadata(
    sessionID,
    taskIDRaw,
    input = {},
    options = {},
) {
    const actor = coordinationActorContext(sessionID, options);
    const loaded = loadCoordinationTask(taskIDRaw);
    const payload = input && typeof input === "object" ? input : {};
    const errors = [];
    const missingResearchFields = missingResearchContractFields(loaded.payload);
    if (loaded.payload.task_type === "research" && missingResearchFields.length) {
        errors.push(
            `Task ${loaded.payload.task_id} is still missing research contract fields (${missingResearchFields.join(", ")}). Use /task-repair to complete the research contract before broader metadata updates.`,
        );
    }
    if (["completed", "cancelled"].includes(loaded.payload.status)) {
        errors.push(
            `Task ${loaded.payload.task_id} is ${loaded.payload.status} and no longer accepts metadata updates. Reopen it with /task-review or create a new task.`,
        );
    }
    const allowedFields = allowedTaskMetadataUpdateFieldNamesForStatus(
        loaded.payload.status,
    );
    // Only run the allowedFields-dependent checks when the status actually
    // supports metadata updates; otherwise the entry guards above already
    // explained why the task is not updatable.
    if (allowedFields.length) {
        if (loaded.payload.status === "working") {
            const activeOwner = loaded.payload.active_session_alias || null;
            if (!activeOwner) {
                errors.push(
                    `Task ${loaded.payload.task_id} must have an active owner before /task-update can run while it is working.`,
                );
            } else if (!actor.session_name || actor.session_name !== activeOwner) {
                errors.push(
                    `Task ${loaded.payload.task_id} is currently owned by session ${activeOwner}; only that active session can update working-task metadata.`,
                );
            }
        }
        errors.push(
            ...unexpectedCoordinationTaskPayloadFieldsErrors(
                payload,
                allowedFields,
                `task metadata update while ${loaded.payload.status}`,
            ),
        );
        const providedFields = Object.keys(payload).filter((key) =>
            allowedFields.includes(key),
        );
        if (!providedFields.length) {
            errors.push(
                `Task ${loaded.payload.task_id} did not receive any supported metadata-update fields.`,
            );
        }
    } else if (!["completed", "cancelled"].includes(loaded.payload.status)) {
        // Defense-in-depth: the entry guards above cover the known terminal
        // statuses (completed/cancelled). If a future status enum value is
        // added without a matching switch case in
        // allowedTaskMetadataUpdateFieldNamesForStatus, allowedFields is empty
        // and we must still surface an explicit error instead of silently
        // no-oping the update.
        errors.push(
            `Task ${loaded.payload.task_id} is ${loaded.payload.status} and cannot be updated through /task-update.`,
        );
    }
    throwCollectedErrors(errors);
    const providedFields = Object.keys(payload).filter((key) =>
        allowedFields.includes(key),
    );
    const explicitNextAction =
        payload.next_action !== undefined
            ? String(payload.next_action || "").trim()
            : null;
    const saved = updateCoordinationTask(loaded.payload.task_id, (current) => ({
        ...current,
        title:
            payload.title !== undefined
                ? String(payload.title || "").trim()
                : current.title,
        coordination_mode:
            payload.coordination_mode !== undefined
                ? payload.coordination_mode
                : current.coordination_mode,
        primary_lane:
            payload.primary_lane !== undefined
                ? String(payload.primary_lane || "").trim()
                : current.primary_lane,
        research_question:
            payload.research_question !== undefined
                ? String(payload.research_question || "").trim()
                : current.research_question,
        source_policy:
            payload.source_policy !== undefined
                ? normalizeCoordinationEnum(
                      payload.source_policy,
                      RESEARCH_SOURCE_POLICIES,
                      "source_policy",
                  ) || null
                : current.source_policy,
        source_allowlist:
            payload.source_allowlist !== undefined
                ? normalizeStringList(payload.source_allowlist)
                : current.source_allowlist,
        desired_artifact_type:
            payload.desired_artifact_type !== undefined
                ? normalizeCoordinationEnum(
                      payload.desired_artifact_type,
                      RESEARCH_ARTIFACT_TYPES,
                      "desired_artifact_type",
                  ) || null
                : current.desired_artifact_type,
        target_artifact_path:
            payload.target_artifact_path !== undefined
                ? normalizeOptionalText(payload.target_artifact_path)
                : current.target_artifact_path,
        rough_scope:
            payload.rough_scope !== undefined
                ? normalizeStringList(payload.rough_scope)
                : current.rough_scope,
        open_questions:
            payload.open_questions !== undefined
                ? normalizeStringList(payload.open_questions)
                : current.open_questions,
        ready_criteria:
            payload.ready_criteria !== undefined
                ? normalizeStringList(payload.ready_criteria)
                : current.ready_criteria,
        files_in_scope:
            payload.files_in_scope !== undefined
                ? normalizeFileScope(payload.files_in_scope)
                : current.files_in_scope,
        constraints:
            payload.constraints !== undefined
                ? normalizeStringList(payload.constraints)
                : current.constraints,
        non_goals:
            payload.non_goals !== undefined
                ? normalizeStringList(payload.non_goals)
                : current.non_goals,
        success_criteria:
            payload.success_criteria !== undefined
                ? normalizeStringList(payload.success_criteria)
                : current.success_criteria,
        validation_plan:
            payload.validation_plan !== undefined
                ? normalizeStringList(payload.validation_plan)
                : current.validation_plan,
        report_envelope:
            payload.report_envelope !== undefined
                ? normalizeCoordinationEnum(
                      payload.report_envelope,
                      COORDINATION_REPORT_ENVELOPES,
                      "report_envelope",
                  ) || current.report_envelope
                : current.report_envelope,
        backlog_id:
            payload.backlog_id !== undefined
                ? normalizeOptionalText(payload.backlog_id)
                : current.backlog_id,
        workstream_slug:
            payload.workstream_slug !== undefined
                ? normalizeOptionalWorkstream(payload.workstream_slug)
                : current.workstream_slug,
        dependencies:
            payload.dependencies !== undefined
                ? normalizeStringList(payload.dependencies)
                : current.dependencies,
        owner_notes:
            payload.owner_notes !== undefined
                ? normalizeStringList(payload.owner_notes)
                : current.owner_notes,
        predicted_impact:
            payload.predicted_impact !== undefined
                ? normalizeOptionalText(payload.predicted_impact)
                : current.predicted_impact,
        measured_outcome:
            payload.measured_outcome !== undefined
                ? normalizeOptionalText(payload.measured_outcome)
                : current.measured_outcome,
        next_action:
            explicitNextAction !== null
                ? explicitNextAction
                : current.next_action,
        history: [
            ...(current.history || []),
            {
                at: isoZ(),
                event: "task_metadata_updated",
                session_name: actor.session_name,
                status: current.status,
                note: `Updated task metadata without changing lifecycle state (${providedFields.join(", ")}).`,
            },
        ],
    }));
    return {
        ...actor,
        path: relativeToRepo(coordinationTaskPath(saved.task_id)),
        task: saved,
        summary: summarizeCoordinationTask(saved),
        ...recommendedCoordinationTaskFields(saved, actor.session_name || null),
    };
}

// Degraded-core repair branch of repairCoordinationTask. Restores the CURRENT
// core-offender subset (offendingFields ∩ DEGRADED_CORE_REPAIRABLE_FIELD_NAMES)
// on a degraded card in one atomic request — restore-only, never an edit of
// non-offending fields. Dispatched STRICTLY on diagnostics.degraded === true
// (a healthy card never reaches here), so the task_type/status carve-out does
// not weaken healthy-card immutability — which the ordinary update allowlist
// (TASK_METADATA_UPDATE_*_FIELD_NAMES, never including task_type/status)
// enforces elsewhere. Repair routes through updateCoordinationTask (the
// canonical writer), which re-runs collectCoordinationTaskCoreFieldErrors +
// throws BEFORE atomicWriteJson, so a partial/invalid repair never lands.
function repairDegradedCoordinationTaskCoreFields(actor, loaded, payload) {
    const offendingFields = loaded.diagnostics
        ? [...loaded.diagnostics.offendingFields]
        : [];
    const errors = [];
    const enumInvalidFields = new Set();
    // RESTORE-ONLY: a degraded-card repair may touch ONLY fields that are
    // currently offending. The allowed payload set is the intersection of the
    // core-offender field set and THIS card's offendingFields — NOT the full
    // repairable set. This closes a transition-guard bypass: if status were
    // accepted on a card degraded by a NON-status corruption (e.g. title), the
    // repair could move a healthy status to a terminal value (completed) via
    // updateCoordinationTask, which re-runs only enum-validity
    // (collectCoordinationTaskCoreFieldErrors), never the lifecycle transition
    // legality guard (coordinationTaskStatusTransitionErrors, enforced only on
    // the save path). Restricting to offenders keeps the carve-out a pure
    // "restore corrupted fields" exit; legitimate status recovery (where status
    // itself is the corrupted offender) remains allowed.
    const repairableOffenders = offendingFields.filter((field) =>
        DEGRADED_CORE_REPAIRABLE_FIELD_NAMES.includes(field),
    );
    errors.push(
        ...unexpectedCoordinationTaskPayloadFieldsErrors(
            payload,
            repairableOffenders,
            "degraded task repair",
        ),
    );
    const providedRepairFields = Object.keys(payload).filter((key) =>
        repairableOffenders.includes(key),
    );
    // Residual risk #1: the repair must cover EVERY offending field this
    // branch can repair (the core enum/identity offenders). Status-conditional
    // offenders (rough_scope/open_questions/ready_criteria when status coerces
    // to "draft"; active_session_alias/claimed_at for "working") VANISH once
    // status is corrected; list-field offenders (files_in_scope etc.) are
    // outside this branch (caught by the canonical save-path throw as
    // backstop). So the partial-repair check considers only repairable
    // offenders uncovered by the payload — keeping the save-path throw a
    // backstop, not the primary diagnostic.
    const uncoveredFields = repairableOffenders.filter(
        (field) => !providedRepairFields.includes(field),
    );
    if (uncoveredFields.length) {
        errors.push(
            `Task ${loaded.payload.task_id} is degraded (repairable offending fields: ${repairableOffenders.join(", ")}). Provide a repair value for every repairable offending field; still missing: ${uncoveredFields.join(", ")}.`,
        );
    }
    // Pre-normalize provided enum values so a bogus replacement yields a
    // precise error BEFORE the canonical writer takes the lock.
    const repairedTaskType =
        payload.task_type !== undefined
            ? normalizeCoordinationEnumCollected(
                  payload.task_type,
                  COORDINATION_TASK_TYPES,
                  "task_type",
                  errors,
                  enumInvalidFields,
              )
            : null;
    const repairedStatus =
        payload.status !== undefined
            ? normalizeCoordinationEnumCollected(
                  payload.status,
                  COORDINATION_TASK_STATUSES,
                  "status",
                  errors,
                  enumInvalidFields,
              )
            : null;
    const repairedCoordinationMode =
        payload.coordination_mode !== undefined
            ? normalizeCoordinationEnumCollected(
                  payload.coordination_mode,
                  COORDINATION_MODES,
                  "coordination_mode",
                  errors,
                  enumInvalidFields,
              )
            : null;
    const repairedReportEnvelope =
        payload.report_envelope !== undefined
            ? normalizeCoordinationEnumCollected(
                  payload.report_envelope,
                  COORDINATION_REPORT_ENVELOPES,
                  "report_envelope",
                  errors,
                  enumInvalidFields,
              )
            : null;
    const repairedTitle =
        payload.title !== undefined
            ? String(payload.title || "").trim()
            : null;
    const repairedPrimaryLane =
        payload.primary_lane !== undefined
            ? String(payload.primary_lane || "").trim()
            : null;
    throwCollectedErrors(errors);

    // Fields actually written by this repair. With restore-only,
    // providedRepairFields == repairableOffenders (the partial-repair check
    // above guarantees every repairable offender is covered, and the
    // unexpected-field check forbids any non-offender). Scope the history note
    // and return value to these, not the full offending set (which may also
    // carry status-conditional / list-field offenders this branch never wrote).
    const repairedFields = uniqueStrings(providedRepairFields);
    const saved = updateCoordinationTask(loaded.payload.task_id, (current) => ({
        ...current,
        task_type:
            repairedTaskType !== null ? repairedTaskType : current.task_type,
        status: repairedStatus !== null ? repairedStatus : current.status,
        coordination_mode:
            repairedCoordinationMode !== null
                ? repairedCoordinationMode
                : current.coordination_mode,
        report_envelope:
            repairedReportEnvelope !== null
                ? repairedReportEnvelope
                : current.report_envelope,
        title: repairedTitle !== null ? repairedTitle : current.title,
        primary_lane:
            repairedPrimaryLane !== null
                ? repairedPrimaryLane
                : current.primary_lane,
        history: [
            ...(current.history || []),
            {
                at: isoZ(),
                event: "task_repaired",
                session_name: actor.session_name,
                status: current.status,
                note: `Repaired degraded core fields (${repairedFields.join(", ")}).`,
            },
        ],
    }));
    return {
        ...actor,
        path: relativeToRepo(coordinationTaskPath(saved.task_id)),
        task: saved,
        summary: summarizeCoordinationTask(saved),
        repaired_fields: repairedFields,
        ...recommendedCoordinationTaskFields(saved, actor.session_name || null),
    };
}

function repairCoordinationTask(sessionID, taskIDRaw, input = {}, options = {}) {
    const actor = coordinationActorContext(sessionID, options);
    const loaded = loadCoordinationTask(taskIDRaw);
    const payload = input && typeof input === "object" ? input : {};

    // DISPATCH: a DEGRADED card (diagnostics.degraded === true — authoritative,
    // recorded pre-coercion by normalizeCoordinationTaskRecordWithDiagnostics)
    // takes the degraded-core repair branch, which can restore the core
    // enum/identity fields that the ordinary update allowlist never exposes. A
    // HEALTHY research card whose contract is missing-but-tolerated
    // (allowLegacyIncompleteResearch) is NOT degraded and falls through to the
    // preserved research-contract repair branch below.
    if (loaded.diagnostics && loaded.diagnostics.degraded === true) {
        return repairDegradedCoordinationTaskCoreFields(actor, loaded, payload);
    }

    // Research-contract repair branch (preserved).
    const errors = [];
    if (loaded.payload.task_type !== "research") {
        errors.push(
            `Task ${loaded.payload.task_id} is ${loaded.payload.task_type} and does not use the research repair flow.`,
        );
    }
    const missingResearchFields = missingResearchContractFields(loaded.payload);
    if (loaded.payload.task_type === "research") {
        if (!missingResearchFields.length) {
            errors.push(
                `Task ${loaded.payload.task_id} already has a complete research contract. Use /task-update for broader metadata changes.`,
            );
        } else {
            // Task is research + has missing fields: collect payload-side
            // problems so a single /task-repair reports all of them at once.
            errors.push(
                ...unexpectedCoordinationTaskPayloadFieldsErrors(
                    payload,
                    RESEARCH_REPAIRABLE_FIELD_NAMES,
                    "research task repair",
                ),
            );
            const providedRepairFields = Object.keys(payload).filter((key) =>
                RESEARCH_REPAIRABLE_FIELD_NAMES.includes(key),
            );
            if (!providedRepairFields.length) {
                errors.push(
                    `Task ${loaded.payload.task_id} is missing research contract fields (${missingResearchFields.join(", ")}). Provide one or more repair fields through /task-repair.`,
                );
            }
        }
    }
    throwCollectedErrors(errors);
    const providedRepairFields = Object.keys(payload).filter((key) =>
        RESEARCH_REPAIRABLE_FIELD_NAMES.includes(key),
    );
    const repairedFields = uniqueStrings([
        ...missingResearchFields,
        ...providedRepairFields,
    ]);
    const saved = updateCoordinationTask(loaded.payload.task_id, (current) => ({
        ...current,
        research_question:
            payload.research_question !== undefined
                ? String(payload.research_question || "").trim()
                : current.research_question,
        source_policy:
            payload.source_policy !== undefined
                ? normalizeCoordinationEnum(
                      payload.source_policy,
                      RESEARCH_SOURCE_POLICIES,
                      "source_policy",
                  ) || null
                : current.source_policy,
        source_allowlist:
            payload.source_allowlist !== undefined
                ? normalizeStringList(payload.source_allowlist)
                : current.source_allowlist,
        desired_artifact_type:
            payload.desired_artifact_type !== undefined
                ? normalizeCoordinationEnum(
                      payload.desired_artifact_type,
                      RESEARCH_ARTIFACT_TYPES,
                      "desired_artifact_type",
                  ) || null
                : current.desired_artifact_type,
        target_artifact_path:
            payload.target_artifact_path !== undefined
                ? normalizeOptionalText(payload.target_artifact_path)
                : current.target_artifact_path,
        history: [
            ...(current.history || []),
            {
                    at: isoZ(),
                    event: "task_repaired",
                    session_name: actor.session_name,
                    status: current.status,
                    note: `Repaired missing research contract fields (${repairedFields.join(", ")}).`,
                },
            ],
    }));
    return {
        ...actor,
        path: relativeToRepo(coordinationTaskPath(saved.task_id)),
        task: saved,
        summary: summarizeCoordinationTask(saved),
        repaired_fields: repairedFields,
        ...recommendedCoordinationTaskFields(saved, actor.session_name || null),
    };
}

function saveCoordinationTaskCloseout(sessionID, taskIDRaw, options = {}) {
    const actor = coordinationActorContext(sessionID, options);
    const loaded = loadCoordinationTask(taskIDRaw);
    const errors = [];
    if (loaded.payload.status !== "working") {
        errors.push(
            `Task ${loaded.payload.task_id} must be working before a closeout can be saved.`,
        );
    }
    const activeOwner = loaded.payload.active_session_alias || null;
    if (!activeOwner) {
        errors.push(
            `Task ${loaded.payload.task_id} must be resumed into an active session before a closeout can be saved.`,
        );
    } else if (!actor.session_name || actor.session_name !== activeOwner) {
        errors.push(
            `Task ${loaded.payload.task_id} is currently owned by session ${activeOwner}; only that active session can save the closeout.`,
        );
    }
    const taskStatus =
        normalizeCoordinationEnumCollected(
            options.taskStatus || "reported",
            COORDINATION_TASK_STATUSES,
            "task_status",
            errors,
        ) || "reported";
    // Only check the closeout-status whitelist when taskStatus is a recognized
    // enum value; otherwise the enum check above already covered it.
    if (
        COORDINATION_TASK_STATUSES.includes(taskStatus) &&
        !COORDINATION_CLOSEOUT_STATUSES.has(taskStatus)
    ) {
        errors.push(
            "task_closeout status must be one of: reported, blocked, completed.",
        );
    }
    const reportEnvelope =
        normalizeCoordinationEnumCollected(
            options.reportEnvelope || loaded.payload.report_envelope,
            COORDINATION_REPORT_ENVELOPES,
            "report_envelope",
            errors,
        ) || loaded.payload.report_envelope;
    // Rewrite-parity Stage 2 (closeout transition). The gate is OPT-IN: it
    // fires ONLY when the closeout body carries an explicitly-declared
    // ```rewrite-parity contract (mode: deletion_replacement |
    // modification_only_rewrite). Ordinary closeouts carry no such block and
    // bear zero rewrite-parity burden. When status=completed AND a contract
    // is declared, every behavior must be proven with a non-empty receipt
    // (structural completeness); the tree-binding honesty is author + reviewer
    // planned/failed/skipped/not-demonstrable/missing-receipt refuse
    // completion (not-demonstrable routes to defer). Mirrors behavioral-
    // closure's authority split (a structurally-complete contract can still
    // carry weak evidence; the verifier/receipt honesty is author + reviewer).
    if (taskStatus === "completed") {
        const rpBlocks = extractAllRewriteParityBlocks(options.body || "");
        rpBlocks.forEach((blk, idx) => {
            if (blk.error) {
                errors.push(
                    "rewrite-parity contract #" + (idx + 1) + " in closeout body " +
                    "could not be parsed: " + blk.error,
                );
                return;
            }
            const rpErrors = validateRewriteParityCompletion(blk.contract);
            for (const e of rpErrors) {
                errors.push(
                    "rewrite-parity contract #" + (idx + 1) +
                    " failed completion validation (status=completed requires " +
                    "every behavior proven with a receipt): " + e,
                );
            }
        });
    }
    // Decision-record gate (retention preservation, owner-approved
    // 2026-10-25; v3 item-enumerated contract owner-approved 2026-10-27).
    // EVERY closeout saved under the current gate must declare how
    // decision-class knowledge (owner authorizations, materially-rejected
    // alternatives, review verdicts, measured outcomes) survives retirement —
    // retiring a completed card deletes the card AND its report dir, the last
    // local copy. The v3 record declares ONE SLOT PER DECISION ITEM
    // (identity, disposition verbatim|curated|sanitized, carrier, per-item
    // handle, provenance for owner decisions); an EMPTY items array is the
    // routine attestation, valid exactly when the card carries no decision
    // items (zero ceremony for routine work). There is deliberately NO
    // "inline" carrier — content only in this local closeout report is NOT
    // durable and never satisfies the gate (owner condition 1). Verification
    // is deferred to retirement (the landing/durable commits usually do not
    // exist yet at closeout time); here we enforce structure, inventory
    // completeness, per-item binding, and the add-only amendment rule.
    let decisionRecord = null;
    const drBlocks = extractAllDecisionRecordBlocks(options.body || "");
    if (drBlocks.length === 0) {
        errors.push(
            `Task ${loaded.payload.task_id} closeout requires a decision_record block: a fenced ` +
                "```decision-record JSON block with one slot per decision item (items may be empty — the routine attestation) " +
                "(see docs/coordination/CLOSEOUT_TEMPLATE.md).",
        );
    } else if (drBlocks.length > 1) {
        errors.push(
            `Task ${loaded.payload.task_id} closeout declares ${drBlocks.length} decision-record blocks; declare exactly ONE (merge the items).`,
        );
    } else if (drBlocks[0].error) {
        errors.push(
            `Task ${loaded.payload.task_id} decision-record block could not be parsed: ${drBlocks[0].error}`,
        );
    } else {
        decisionRecord = drBlocks[0].record;
        errors.push(
            ...collectDecisionRecordStructuralErrors(
                decisionRecord,
                loaded.payload.task_id,
            ),
        );
        // Guard: a JSON body of `null` (or a primitive/array — JSON allows
        // all of them at top level) parses WITHOUT a parse error, and the
        // structural collector already refuses it above. The inventory probe
        // below must not dereference it — that raised a raw TypeError
        // instead of the collected StateError. Only probe a plausible object
        // shape.
        const plausibleRecord =
            decisionRecord !== null &&
            typeof decisionRecord === "object" &&
            !Array.isArray(decisionRecord) &&
            Array.isArray(decisionRecord.items);
        if (plausibleRecord) {
            // INVENTORY COMPLETENESS + PER-ITEM BINDING + ADD-ONLY
            // AMENDMENT (owner conditions 1 and 2): every decision item on
            // the card (plus the incoming measured_outcome) must have a
            // declared slot; no surplus slots; verbatim handles must be
            // drawn from their OWN item's content; and a re-closeout must
            // carry every previously stored slot forward verbatim (the
            // sanctioned amendment is ADD-ONLY — the stored record is the
            // baseline inventory, so removing an item from the card never
            // removes its slot).
            const inventory = collectDecisionInventoryProblems(
                loaded.payload,
                decisionRecord,
                { measuredOutcome: options.measuredOutcome },
                loaded.payload.decision_record,
            );
            if (inventory.length > 0) {
                const named = inventory
                    .map((p) => `  - [${p.code}] ${p.detail}`)
                    .join("\n");
                const isRoutineInventory = decisionRecord.items.length === 0;
                errors.push(
                    (isRoutineInventory
                        ? `Task ${loaded.payload.task_id} declares a routine decision_record (empty inventory — nothing decision-class to preserve) but decision items are present on the card:\n${named}\n`
                        : `Task ${loaded.payload.task_id} declares a decision_record whose slots do not enumerate the card's decision items exactly:\n${named}\n`) +
                    "Declare one slot per decision item: { \"id\": \"owner_notes[fnv1a:<content-hash>]\" (content-bound — ids derive from each item's own text via the exported collectDecisionItems classifier, never its array position), \"disposition\": \"verbatim|curated|sanitized\", \"carrier\": {…}, \"handle\": \"…\", \"provenance\": \"…\" }. " +
                    "A verbatim handle is a single line from that item's own content; a curated/sanitized handle is EXACTLY the canonical label \"decision-item: <task-id>#<item-id> (<disposition>)\" labeling the curated content in the carrier. " +
                    "Sensitive content that genuinely cannot be represented must not be faked — leave the item undeclared (retirement will refuse and surface it) and use the documented operator force path, never a hollow declaration.",
                );
            }
        }
    }
    throwCollectedErrors(errors);
    const createdAt = isoZ();
    const reportTitle =
        String(options.title || "").trim() || titleFromSlug(`${taskStatus}-closeout`);
    const reportPath = path.join(
        coordinationTaskReportDir(loaded.payload.task_id),
        `${planTimestamp()}-closeout.md`,
    );
    atomicWriteText(
        reportPath,
        formatCoordinationReportMarkdown({
            taskID: loaded.payload.task_id,
            title: reportTitle,
            status: taskStatus,
            reportEnvelope,
            coordinationMode: loaded.payload.coordination_mode,
            primaryLane: loaded.payload.primary_lane,
            sessionName: actor.session_name,
            createdAt,
            cwd: actor.cwd,
            sessionID,
            body: options.body || "",
            backlogID: loaded.payload.backlog_id,
            workstreamSlug: loaded.payload.workstream_slug,
            promotionRecommended: Boolean(options.promotionRecommended),
        }),
    );
    const storedReportPath = relativeToRepo(reportPath);
    const reportSummary = parseCoordinationReport(storedReportPath, {
        includeBody: false,
    });
    const explicitNextAction =
        options.nextAction !== undefined
            ? String(options.nextAction || "").trim()
            : null;
    const measuredOutcome =
        options.measuredOutcome !== undefined
            ? normalizeOptionalText(options.measuredOutcome)
            : null;
    const saved = updateCoordinationTask(loaded.payload.task_id, (current) => ({
        ...current,
        status: taskStatus,
        report_envelope: reportEnvelope,
        // Retention-preservation gate: persist the declared decision_record so
        // the retirement path can resolve every slot against committed git
        // state before deleting the card + report dir. decisionRecord is
        // non-null here (a missing/invalid block refused the closeout above)
        // and structurally valid v3 (wrong versions refused at declaration),
        // so the stored baseline is exactly the declared item inventory.
        decision_record:
            decisionRecord !== null
                ? {
                      version: DECISION_RECORD_VERSION,
                      items: decisionRecord.items,
                      ...(typeof decisionRecord.note === "string"
                          ? { note: decisionRecord.note }
                          : {}),
                  }
                : current.decision_record,
        session_aliases: actor.session_name
            ? uniqueStrings([...(current.session_aliases || []), actor.session_name])
            : current.session_aliases,
        active_session_alias: null,
        claimed_at: null,
        report_paths: uniqueStrings([
            ...(current.report_paths || []),
            storedReportPath,
        ]),
        latest_report: {
            path: storedReportPath,
            title: reportTitle,
            status: taskStatus,
            report_envelope: reportEnvelope,
            created_at: createdAt,
            summary: reportSummary.summary,
            promotion_recommended: Boolean(options.promotionRecommended),
        },
        next_action:
            explicitNextAction !== null
                ? explicitNextAction
                : defaultCoordinationTaskNextAction(current.task_id, taskStatus),
        measured_outcome:
            measuredOutcome !== null
                ? measuredOutcome
                : current.measured_outcome,
        history: [
            ...(current.history || []),
            {
                at: isoZ(),
                event: "task_closeout_saved",
                session_name: actor.session_name,
                status: taskStatus,
                note: `Saved ${reportEnvelope} closeout to ${storedReportPath}.`,
            },
        ],
    }));
    return {
        ...actor,
        path: relativeToRepo(coordinationTaskPath(saved.task_id)),
        task: saved,
        summary: summarizeCoordinationTask(saved),
        report: reportSummary,
        promotion_recommended: Boolean(options.promotionRecommended),
        ...recommendedCoordinationTaskFields(saved, actor.session_name || null),
    };
}

function reviewCoordinationTask(sessionID, taskIDRaw, options = {}) {
    const actor = coordinationActorContext(sessionID, options);
    const loaded = loadCoordinationTask(taskIDRaw);
    const errors = [];
    if (!COORDINATION_REVIEWABLE_STATUSES.has(loaded.payload.status)) {
        errors.push(
            `Task ${loaded.payload.task_id} is ${loaded.payload.status} and is not ready for coordinator review.`,
        );
    }
    if (!loaded.payload.latest_report || !loaded.payload.latest_report.path) {
        errors.push(
            `Task ${loaded.payload.task_id} has no saved closeout report to review.`,
        );
    }
    const reviewBody = String(options.body || "").trim();
    if (!reviewBody) {
        errors.push("Task review body is required.");
    }
    const taskStatus =
        normalizeCoordinationEnumCollected(
            options.taskStatus || loaded.payload.status,
            COORDINATION_TASK_STATUSES,
            "task_status",
            errors,
        ) || loaded.payload.status;
    if (["draft", "working"].includes(taskStatus)) {
        errors.push(
            "task_review should resolve to ready, reported, blocked, completed, or cancelled.",
        );
    }
    throwCollectedErrors(errors);
    const reviewTitle =
        String(options.title || "").trim() || "Coordinator Review";
    const explicitNextAction =
        options.nextAction !== undefined
            ? String(options.nextAction || "").trim()
            : null;
    const reviewedAt = isoZ();
    const summary = summarizeMarkdownExcerpt(reviewBody, 6);
    const reviewPath = path.join(
        coordinationTaskReportDir(loaded.payload.task_id),
        `${planTimestamp()}-review.md`,
    );
    atomicWriteText(
        reviewPath,
        formatCoordinationReviewMarkdown({
            taskID: loaded.payload.task_id,
            title: reviewTitle,
            status: taskStatus,
            sessionName: actor.session_name,
            createdAt: reviewedAt,
            cwd: actor.cwd,
            sessionID,
            body: reviewBody,
            nextAction:
                explicitNextAction !== null
                    ? explicitNextAction
                    : defaultCoordinationTaskNextAction(
                          loaded.payload.task_id,
                          taskStatus,
                      ),
        }),
    );
    const storedReviewPath = relativeToRepo(reviewPath);
    const saved = updateCoordinationTask(loaded.payload.task_id, (current) => ({
        ...current,
        status: taskStatus,
        next_action:
            explicitNextAction !== null
                ? explicitNextAction
                : defaultCoordinationTaskNextAction(current.task_id, taskStatus),
        active_session_alias: null,
        claimed_at: null,
        review_paths: uniqueStrings([
            ...(current.review_paths || []),
            storedReviewPath,
        ]),
        last_review: {
            path: storedReviewPath,
            reviewed_at: reviewedAt,
            session_name: actor.session_name,
            title: reviewTitle,
            status: taskStatus,
            summary,
            next_action:
                explicitNextAction !== null
                    ? explicitNextAction
                    : defaultCoordinationTaskNextAction(
                          current.task_id,
                          taskStatus,
                      ),
        },
        history: [
            ...(current.history || []),
            {
                at: reviewedAt,
                event: "task_reviewed",
                session_name: actor.session_name,
                status: taskStatus,
                note: summary || reviewTitle,
            },
        ],
    }));
    return {
        ...actor,
        path: relativeToRepo(coordinationTaskPath(saved.task_id)),
        task: saved,
        summary: summarizeCoordinationTask(saved),
        review: {
            title: reviewTitle,
            path: storedReviewPath,
            status: taskStatus,
            summary,
            next_action:
                explicitNextAction !== null
                    ? explicitNextAction
                    : saved.next_action,
            reviewed_at: reviewedAt,
        },
        ...recommendedCoordinationTaskFields(saved, actor.session_name || null),
    };
}

function resolveActiveWorkstreamName(binding, workstreamNameRaw, options = {}) {
    const explicit = String(workstreamNameRaw || "").trim();
    if (explicit) {
        return normalizeWorkstreamName(explicit);
    }
    if (binding.active_workstream) {
        return binding.active_workstream;
    }
    if (options.allowMissing) {
        return null;
    }
    throw new StateError(
        "No active workstream is bound for this session. Bind one first.",
    );
}

function getWorkstreamOverview(sessionID, workstreamNameRaw, options = {}) {
    const binding = ensureSessionBinding(sessionID, {
        ...options,
        allowUnbound: true,
    });
    const workstreamName = resolveActiveWorkstreamName(
        binding,
        workstreamNameRaw,
        {
            allowMissing: true,
        },
    );
    if (!workstreamName) {
        return {
            session_id: sessionID,
            session_name: binding.session_name || null,
            active_workstream: null,
            initialized: false,
        };
    }
    const initialized = fs.existsSync(workstreamDir(workstreamName));
    if (!initialized) {
        return {
            session_id: sessionID,
            session_name: binding.session_name || null,
            active_workstream: workstreamName,
            initialized: false,
        };
    }
    ensureWorkstreamMemoryNamespace(workstreamName);
    const index = readJson(
        workstreamIndexPath(workstreamName),
        defaultWorkstreamIndex(workstreamName),
    );
    const files = {};
    const summaries = {};
    for (const target of Object.keys(WORKSTREAM_TARGETS)) {
        const targetPath = workstreamFilePath(workstreamName, target);
        files[target] = relativeToRepo(targetPath);
        summaries[target] = summarizeScopedMarkdown(
            WORKSTREAM_TARGETS,
            target,
            readTextIfExists(targetPath),
            8,
        );
    }
    return {
        session_id: sessionID,
        session_name: binding.session_name || null,
        active_workstream: workstreamName,
        initialized: true,
        workstream_dir: relativeToRepo(workstreamDir(workstreamName)),
        index_path: relativeToRepo(workstreamIndexPath(workstreamName)),
        files,
        summaries,
        linked_sessions: {
            ids: [...(index.session_ids || [])],
            names: [...(index.session_names || [])],
        },
    };
}

function initWorkstreamMemory(sessionID, workstreamNameRaw, options = {}) {
    const bound = bindWorkstream(sessionID, workstreamNameRaw, options);
    const workstreamName = bound.active_workstream;
    ensureWorkstreamMemoryNamespace(workstreamName);
    const replaceExisting = Boolean(options.replaceExisting);
    const initializedTargets = [];
    const replacedTargets = [];
    const preservedTargets = [];
    const targetBodies = {
        brief: options.briefBody,
        next_slice: options.nextSliceBody,
        open_questions: options.openQuestionsBody,
        rejected_options: options.rejectedOptionsBody,
        links: options.linksBody,
    };

    for (const [target, body] of Object.entries(targetBodies)) {
        if (body === undefined) {
            continue;
        }
        const targetPath = workstreamFilePath(workstreamName, target);
        const existing = readTextIfExists(targetPath);
        const hadMeaningfulContent = hasMeaningfulScopedMarkdown(
            WORKSTREAM_TARGETS,
            target,
            existing,
        );
        if (hadMeaningfulContent && !replaceExisting) {
            preservedTargets.push(target);
            continue;
        }
        atomicWriteText(
            targetPath,
            renderWorkstreamMarkdown(target, body),
        );
        if (hadMeaningfulContent) {
            replacedTargets.push(target);
        } else {
            initializedTargets.push(target);
        }
    }

    return {
        ...bound,
        replace_existing: replaceExisting,
        files: Object.fromEntries(
            Object.keys(WORKSTREAM_TARGETS).map((target) => [
                target,
                relativeToRepo(workstreamFilePath(workstreamName, target)),
            ]),
        ),
        initialized_targets: initializedTargets,
        replaced_targets: replacedTargets,
        preserved_targets: preservedTargets,
    };
}

function writeWorkstreamFile(sessionID, target, body, workstreamNameRaw, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const workstreamName = resolveActiveWorkstreamName(binding, workstreamNameRaw);
    ensureWorkstreamMemoryNamespace(workstreamName);
    const targetPath = workstreamFilePath(workstreamName, target);
    atomicWriteText(targetPath, renderWorkstreamMarkdown(target, body));
    updateWorkstreamIndex(workstreamName, (current) => ({
        ...current,
        session_ids: [...(current.session_ids || []), sessionID],
        session_names: [
            ...(current.session_names || []),
            binding.session_name,
        ],
    }));
    return {
        session_id: sessionID,
        session_name: binding.session_name,
        active_workstream: workstreamName,
        target,
        path: relativeToRepo(targetPath),
    };
}

function appendWorkstreamNote(
    sessionID,
    target,
    body,
    workstreamNameRaw,
    options = {},
) {
    if (!["next_slice", "open_questions", "rejected_options", "links"].includes(target)) {
        throw new StateError(
            `Append is only supported for next_slice, open_questions, rejected_options, or links. Received: ${target}`,
        );
    }
    const binding = currentSessionBinding(sessionID, options);
    const workstreamName = resolveActiveWorkstreamName(binding, workstreamNameRaw);
    ensureWorkstreamMemoryNamespace(workstreamName);
    const targetPath = workstreamFilePath(workstreamName, target);
    const nextMarkdown = appendScopedMarkdown(
        WORKSTREAM_TARGETS,
        target,
        readTextIfExists(targetPath),
        body,
        options.title || "",
    );
    atomicWriteText(targetPath, nextMarkdown);
    updateWorkstreamIndex(workstreamName, (current) => ({
        ...current,
        session_ids: [...(current.session_ids || []), sessionID],
        session_names: [
            ...(current.session_names || []),
            binding.session_name,
        ],
    }));
    return {
        session_id: sessionID,
        session_name: binding.session_name,
        active_workstream: workstreamName,
        target,
        path: relativeToRepo(targetPath),
    };
}

function getSessionMemoryOverview(sessionID, options = {}) {
    const binding = ensureSessionBinding(sessionID, {
        ...options,
        allowUnbound: true,
    });
    if (!binding.session_name) {
        return {
            session_id: sessionID,
            session_name: null,
            active_workstream: null,
            initialized: false,
        };
    }
    const sessionName = binding.session_name;
    const workstreamOverview = getWorkstreamOverview(sessionID, "", {
        ...options,
        allowUnbound: true,
    });
    const initialized = fs.existsSync(sessionMemoryDir(sessionName));
    if (!initialized) {
        return {
            session_id: sessionID,
            session_name: sessionName,
            active_workstream: workstreamOverview.active_workstream || null,
            workstream: workstreamOverview.initialized ? workstreamOverview : null,
            initialized: false,
        };
    }
    ensureSessionMemoryNamespace(sessionName);
    const briefPath = sessionMemoryFilePath(sessionName, "brief");
    const taskContractPath = sessionTaskContractPath(sessionName);
    const taskContractJsonPath = sessionTaskContractJsonPath(sessionName);
    const resolvedContextPath = sessionMemoryFilePath(
        sessionName,
        "resolved_context",
    );
    const openQuestionsPath = sessionMemoryFilePath(
        sessionName,
        "open_questions",
    );
    const decisionLogPath = sessionDecisionLogPath(sessionName);
    const artifacts = readJson(
        sessionArtifactsIndexPath(sessionName),
        defaultArtifactsPayload(sessionName, sessionRunManifestPath(sessionName)),
    );
    const taskContract = loadTaskContractPayload(sessionName);
    const taskContractSummary = summarizeTaskContract(taskContract);
    const latestCheckpoint = listSessionDocuments(sessionName, "checkpoint")[0] || null;
    const latestCheckpointSummary = latestCheckpoint
        ? summarizeMarkdownExcerpt(
              fs.readFileSync(path.join(repoRoot(), latestCheckpoint.path), "utf8"),
              8,
          )
        : "";
    return {
        session_id: sessionID,
        session_name: sessionName,
        active_workstream: workstreamOverview.active_workstream || null,
        initialized: true,
        memory_dir: relativeToRepo(sessionMemoryDir(sessionName)),
        run_dir: relativeToRepo(sessionRunDir(sessionName)),
        artifact_manifest_path: relativeToRepo(sessionRunManifestPath(sessionName)),
        files: {
            brief: relativeToRepo(briefPath),
            task_contract: relativeToRepo(taskContractPath),
            task_contract_json: relativeToRepo(taskContractJsonPath),
            resolved_context: relativeToRepo(resolvedContextPath),
            open_questions: relativeToRepo(openQuestionsPath),
            decision_log: relativeToRepo(decisionLogPath),
            artifacts_index: relativeToRepo(sessionArtifactsIndexPath(sessionName)),
        },
        summaries: {
            brief: summarizeScopedMarkdown(
                MEMORY_TARGETS,
                "brief",
                readTextIfExists(briefPath),
                8,
            ),
            task_contract: taskContractSummary,
            resolved_context: summarizeScopedMarkdown(
                MEMORY_TARGETS,
                "resolved_context",
                readTextIfExists(resolvedContextPath),
                8,
            ),
            open_questions: summarizeScopedMarkdown(
                MEMORY_TARGETS,
                "open_questions",
                readTextIfExists(openQuestionsPath),
                8,
            ),
            recent_decisions: summarizeDecisionLog(
                readTextIfExists(decisionLogPath),
                3,
            ),
            latest_checkpoint: latestCheckpointSummary,
        },
        task_contract: taskContractHasContent(taskContract)
            ? {
                  version: Number(taskContract.version || 0) || 0,
                  updated_at: taskContract.updated_at || null,
                  summary: taskContractSummary,
                  final_response_format: taskContract.final_response_format || "",
                  required_outputs: [...(taskContract.required_outputs || [])],
                  required_commands: [...(taskContract.required_commands || [])],
              }
            : null,
        latest_checkpoint: latestCheckpoint
            ? {
                  ...latestCheckpoint,
                  summary: latestCheckpointSummary,
              }
            : null,
        workstream: workstreamOverview.initialized ? workstreamOverview : null,
        artifact_summary: {
            tracked: (artifacts.artifacts || []).length,
            active: (artifacts.artifacts || []).filter(
                (artifact) => String(artifact.status || "active") === "active",
            ).length,
        },
    };
}

function formatDraftMarkdown({
    slug,
    title,
    sessionName,
    createdAt,
    updatedAt,
    cwd,
    sessionID,
    body,
    f3DesignReadiness,
}) {
    const normalizedBody = String(body || "").trim();
    if (!normalizedBody) {
        throw new StateError(
            "Draft body is empty. Refuse to save an empty draft.",
        );
    }
    const lines = [
        "---",
        `slug: ${yamlScalar(slug)}`,
        `title: ${yamlScalar(title)}`,
        `session_name: ${yamlScalar(sessionName)}`,
        "status: draft",
        `created_at: ${yamlScalar(createdAt)}`,
        `updated_at: ${yamlScalar(updatedAt)}`,
        `cwd: ${yamlScalar(cwd)}`,
        `session_id: ${yamlScalar(sessionID)}`,
    ];
    // F3 design-readiness envelope (authored by the design lane per Slice 5).
    // Double-JSON-encoded; see formatPlanMarkdown + decodeEnvelopeFromFrontmatter.
    if (
        f3DesignReadiness !== null &&
        f3DesignReadiness !== undefined &&
        typeof f3DesignReadiness === "object"
    ) {
        lines.push(
            `f3_design_readiness: ${JSON.stringify(JSON.stringify(f3DesignReadiness))}`,
        );
    }
    lines.push("---", "", normalizedBody, "");
    return lines.join("\n");
}

function saveDraft(sessionID, slugOrTitle, body, title, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const sessionName = binding.session_name;
    const slug = slugify(slugOrTitle);
    const draftTitle = String(title || "").trim() || titleFromSlug(slug);
    ensureDir(draftsSessionDir(sessionName));
    const targetPath = draftPath(sessionName, slug);
    const existing = fs.existsSync(targetPath)
        ? parseFrontmatter(fs.readFileSync(targetPath, "utf8"))
        : null;
    const createdAt = (existing && existing.frontmatter.created_at) || isoZ();
    const updatedAt = isoZ();
    const f3DesignReadiness =
        options.f3DesignReadiness !== undefined
            ? options.f3DesignReadiness
            : existing
              ? decodeEnvelopeFromFrontmatter(existing.frontmatter.f3_design_readiness)
              : null;
    const markdown = formatDraftMarkdown({
        slug,
        title: draftTitle,
        sessionName,
        createdAt,
        updatedAt,
        cwd: options.cwd || binding.cwd || hostCwd(),
        sessionID,
        body,
        f3DesignReadiness,
    });
    atomicWriteText(targetPath, markdown);
    return {
        session_id: sessionID,
        session_name: sessionName,
        slug,
        title: draftTitle,
        status: "draft",
        created_at: createdAt,
        updated_at: updatedAt,
        path: relativeToRepo(targetPath),
    };
}

function readDraft(sessionID, slugOrTitle, options = {}) {
    const binding = currentSessionBinding(sessionID, options);
    const sessionName = binding.session_name;
    const targetPath = draftPath(sessionName, slugOrTitle);
    if (!fs.existsSync(targetPath)) {
        throw new StateError(
            `Draft plan does not exist: ${relativeToRepo(targetPath)}`,
        );
    }
    const parsed = parseFrontmatter(fs.readFileSync(targetPath, "utf8"));
    return {
        session_id: sessionID,
        session_name: sessionName,
        slug: slugify(slugOrTitle),
        path: relativeToRepo(targetPath),
        title: parsed.frontmatter.title || titleFromSlug(slugOrTitle),
        status: parsed.frontmatter.status || "draft",
        created_at: parsed.frontmatter.created_at || null,
        updated_at: parsed.frontmatter.updated_at || null,
        body: parsed.body,
        f3_design_readiness: decodeEnvelopeFromFrontmatter(
            parsed.frontmatter.f3_design_readiness,
        ),
    };
}

// Compute the design digest for a draft/approved plan. Per the Slice-0 digest
// scope, the design prose IS the design: the digest is over the
// frontmatter-stripped, trimmed plan body. Title/slug are excluded (identity,
// not design). The caller passes the already-stripped body that readDraft /
// parseFrontmatter produce.
function computePlanDesignDigest(planBody) {
    return computeDesignDigest(String(planBody || "").trim());
}

function approveDraft(sessionID, slugOrTitle, options = {}) {
    const draft = readDraft(sessionID, slugOrTitle, options);

    // F3 design-readiness gate (sole BLOCKS family). This is the SECOND
    // BUILD-READY crossing (draft-plan → approved) and uses the SAME shared
    // validator as the task-card route (Slice 2). The gate fires between
    // readDraft and savePlan: on block, the approved-plan artifact is NEVER
    // created (savePlan is not called) and the session index is untouched.
    //
    // The design digest is over the draft's frontmatter-stripped body (the
    // design prose). The envelope is loaded from the draft's frontmatter
    // (authored by the design lane per Slice 5).
    const designDigest = computePlanDesignDigest(draft.body);
    const f3Result = validateF3DesignReadiness({
        envelope: draft.f3_design_readiness,
        currentDesignDigest: designDigest,
        transitionKind: "plan_approve",
    });
    if (!f3Result.passed) {
        throw new StateError(
            `F3 design-readiness gate refused draft-plan -> approved ` +
                `(reason: ${f3Result.reasonCode}). ` +
                `${f3Result.detail} ` +
                `The plan remains a draft. Supply a complete ` +
                `f3_design_readiness envelope bound to the current design ` +
                `digest, or declare ownership_hazards: [] if no hazard was named.`,
        );
    }

    const saved = savePlan(
        sessionID,
        draft.slug,
        draft.body,
        draft.title,
        { ...options, f3DesignReadiness: draft.f3_design_readiness },
    );
    return {
        ...saved,
        draft_path: draft.path,
    };
}

function getCurrentSessionContext(sessionID, options = {}) {
    const binding = ensureSessionBinding(sessionID, options);
    const alias = binding.session_name;
    if (!alias) {
        return {
            session_id: sessionID,
            session_name: null,
            active_workstream: binding.active_workstream || null,
            adopted_plan_id: null,
            latest_plan_id: null,
            plans: [],
        };
    }
    const index = loadSessionIndex(alias);
    const plans = sortPlans(index.plans || []);
    return {
        session_id: sessionID,
        session_name: alias,
        active_workstream: binding.active_workstream || null,
        adopted_plan_id: index.adopted_plan_id || null,
        latest_plan_id: plans[0] ? plans[0].id : null,
        plans,
    };
}

function buildCompactionContext(sessionID, todos = []) {
    const binding = ensureSessionBinding(sessionID, { allowUnbound: true });
    const context = [];
    if (!binding.session_name) {
        context.push("Session alias: (unbound)");
        return context;
    }

    const sessionState = getCurrentSessionContext(sessionID);
    context.push(`Session alias: ${binding.session_name}`);
    if (binding.active_workstream) {
        context.push(`Active workstream: ${binding.active_workstream}`);
    }
    const memoryOverview = getSessionMemoryOverview(sessionID, {
        allowUnbound: true,
    });
    if (memoryOverview.initialized && memoryOverview.task_contract) {
        context.push(
            `Task contract: v${memoryOverview.task_contract.version} (${memoryOverview.files.task_contract})`,
        );
        if (memoryOverview.task_contract.summary) {
            context.push(
                `Task contract summary:\n${memoryOverview.task_contract.summary}`,
            );
        }
        if (memoryOverview.task_contract.final_response_format) {
            context.push(
                `Final response format:\n${summarizeStructuredTextBlock(
                    memoryOverview.task_contract.final_response_format,
                    20,
                )}`,
            );
        }
    }

    try {
        const resolved = resolvePlan(sessionID, "");
        context.push(
            `Active plan: ${resolved.plan.id} [${resolved.plan.status}] ${resolved.plan.title} (${resolved.resolved_via})`,
        );
        const excerpt = summarizePlanBody(resolved.body, 14);
        if (excerpt) {
            context.push(`Active plan summary:\n${excerpt}`);
        }
    } catch (error) {
        if (!(error instanceof StateError)) {
            throw error;
        }
        if (sessionState.plans.length) {
            context.push(
                `Saved plans:\n${candidatePlanLines(sessionState.plans)}`,
            );
        } else {
            context.push("Saved plans: none");
        }
    }

    if (memoryOverview.initialized) {
        context.push(`Session memory: ${memoryOverview.memory_dir}`);
        if (memoryOverview.workstream) {
            context.push(`Workstream memory: ${memoryOverview.workstream.workstream_dir}`);
            if (memoryOverview.workstream.summaries.brief) {
                context.push(
                    `Workstream brief:\n${memoryOverview.workstream.summaries.brief}`,
                );
            }
            if (memoryOverview.workstream.summaries.next_slice) {
                context.push(
                    `Workstream next slice:\n${memoryOverview.workstream.summaries.next_slice}`,
                );
            }
        }
        if (memoryOverview.summaries.brief) {
            context.push(`Session brief:\n${memoryOverview.summaries.brief}`);
        }
        if (memoryOverview.latest_checkpoint) {
            context.push(
                `Latest checkpoint: ${memoryOverview.latest_checkpoint.id} ${memoryOverview.latest_checkpoint.title}`,
            );
            if (memoryOverview.latest_checkpoint.summary) {
                context.push(
                    `Latest checkpoint summary:\n${memoryOverview.latest_checkpoint.summary}`,
                );
            }
        }
        if (memoryOverview.summaries.resolved_context) {
            context.push(
                `Resolved context:\n${memoryOverview.summaries.resolved_context}`,
            );
        }
        if (memoryOverview.summaries.recent_decisions) {
            context.push(
                `Recent decisions:\n${memoryOverview.summaries.recent_decisions}`,
            );
        }
        if (
            memoryOverview.summaries.open_questions &&
            !memoryOverview.summaries.open_questions.includes("(none)")
        ) {
            context.push(
                `Open questions:\n${memoryOverview.summaries.open_questions}`,
            );
        }
        if (memoryOverview.artifact_summary.tracked) {
            context.push(
                `Artifacts: ${memoryOverview.artifact_summary.active}/${memoryOverview.artifact_summary.tracked} active (${memoryOverview.artifact_manifest_path})`,
            );
        }
    }

    const todoSummary = summarizeTodos(todos, 5);
    if (todoSummary.length) {
        context.push(`Top todos:\n${todoSummary.join("\n")}`);
    }

    // Include operator-cleared assumptions in compaction context
    const clearedAssumptions = loadClearedAssumptions();
    if (clearedAssumptions.length > 0) {
        context.push("## Cleared Assumptions (operator state)");
        context.push("The following premises have been cleared by the operator and must NOT be re-raised as blockers:");
        for (const entry of clearedAssumptions) {
            context.push(`- [${entry.scope}] ${entry.claim} (cleared ${entry.cleared_at}${entry.note ? "; " + entry.note : ""})`);
        }
    }

    return context;
}

function printJson(payload) {
    console.log(JSON.stringify(payload, null, 2));
}

function resolveCliSessionID(args) {
    const cleaned = [];
    let sessionID = "";
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--session-id") {
            sessionID = args[index + 1] || "";
            index += 1;
        } else {
            cleaned.push(arg);
        }
    }
    sessionID = sessionID || (process.env.OPENCODE_SESSION_ID || "").trim();
    if (!sessionID) {
        throw new StateError(
            "No OpenCode sessionID provided. Pass --session-id <id> or set OPENCODE_SESSION_ID.",
        );
    }
    return {
        sessionID,
        args: cleaned,
    };
}

export {
    SCHEMA_VERSION,
    repoRoot,
    opencodeRoot,
    stateRoot,
    sessionBindingsRoot,
    sessionsRoot,
    workstreamsRoot,
    draftsRoot,
    normalizeSessionName,
    normalizeWorkstreamName,
    bindSessionName,
    bindWorkstream,
    clearWorkstream,
    currentSessionBinding,
    getCurrentSessionContext,
    getSessionMemoryOverview,
    getWorkstreamOverview,
    ensureSessionBinding,
    savePlan,
    loadSessionIndex,
    listPlans,
    humanPlanList,
    adoptPlan,
    resolvePlan,
    buildCompactionContext,
    initSessionMemory,
    initWorkstreamMemory,
    saveTaskContract,
    readTaskContract,
    writeSessionMemoryFile,
    writeWorkstreamFile,
    appendWorkstreamNote,
    appendDecision,
    saveCheckpoint,
    readCheckpoint,
    saveHandoff,
    saveCoordinationTask,
    readCoordinationTask,
    listCoordinationTasks,
    ensureCoordinationTaskCoreFields,
    activateCoordinationTask,
    readyCoordinationTask,
    updateCoordinationTaskMetadata,
    repairCoordinationTask,
    saveCoordinationTaskCloseout,
    reviewCoordinationTask,
    deleteCoordinationTask,
    // Read-only decision-record verifier (retention-preservation gate).
    // Exported as a TEST SEAM so tests can exercise git-failure mapping
    // (verifier_unavailable) directly, without fabricating a repo where
    // landing proof succeeds but later git reads fail.
    verifyDecisionRecordForRetirement,
    // Mechanical decision-item enumeration (the authoring aid behind the v3
    // inventory): tooling and tests enumerate a card's decision items to
    // build/verify a decision_record without re-implementing the classifier.
    collectDecisionItems,
    // Content-bound item-id factory (the B-F1 fix): tests and tooling derive
    // EXACTLY the ids collectDecisionItems mints, so fixtures cannot drift
    // from the gate's identity grammar.
    decisionItemId,
    // Tri-state git read helpers behind that verifier, exported as TEST
    // SEAMS for the same reason: repo corruption cannot selectively fail
    // `git log -1` / `git show` while letting the earlier rev-parse /
    // reachability reads succeed, so their unavailable branches are
    // injected directly (non-git directory).
    commitMessageContains,
    committedBlobAt,
    saveSkillProposal,
    readSkillProposal,
    listSkillProposals,
    setSkillProposalStatus,
    deleteSkillProposal,
    recordArtifact,
    recordArtifacts,
    resolvePaths,
    cleanupArtifacts,
    saveDraft,
    approveDraft,
    readDraft,
    printJson,
    resolveCliSessionID,
    clearedAssumptionsPath,
    parseClearedAssumptionsYaml,
    loadClearedAssumptions,
    mergeClearedAssumptions,
    computeTaskDesignDigest,
    computePlanDesignDigest,
};

export default {
    SCHEMA_VERSION,
    StateError,
    repoRoot,
    opencodeRoot,
    stateRoot,
    sessionBindingsRoot,
    sessionsRoot,
    workstreamsRoot,
    draftsRoot,
    normalizeSessionName,
    normalizeWorkstreamName,
    bindSessionName,
    bindWorkstream,
    clearWorkstream,
    currentSessionBinding,
    getCurrentSessionContext,
    getSessionMemoryOverview,
    getWorkstreamOverview,
    ensureSessionBinding,
    savePlan,
    loadSessionIndex,
    listPlans,
    humanPlanList,
    adoptPlan,
    resolvePlan,
    buildCompactionContext,
    initSessionMemory,
    initWorkstreamMemory,
    saveTaskContract,
    readTaskContract,
    writeSessionMemoryFile,
    writeWorkstreamFile,
    appendWorkstreamNote,
    appendDecision,
    saveCheckpoint,
    readCheckpoint,
    saveHandoff,
    saveCoordinationTask,
    readCoordinationTask,
    listCoordinationTasks,
    ensureCoordinationTaskCoreFields,
    activateCoordinationTask,
    readyCoordinationTask,
    updateCoordinationTaskMetadata,
    repairCoordinationTask,
    saveCoordinationTaskCloseout,
    reviewCoordinationTask,
    deleteCoordinationTask,
    // Read-only decision-record verifier (retention-preservation gate).
    // Exported as a TEST SEAM so tests can exercise git-failure mapping
    // (verifier_unavailable) directly, without fabricating a repo where
    // landing proof succeeds but later git reads fail.
    verifyDecisionRecordForRetirement,
    // Mechanical decision-item enumeration (the authoring aid behind the v3
    // inventory): tooling and tests enumerate a card's decision items to
    // build/verify a decision_record without re-implementing the classifier.
    collectDecisionItems,
    // Content-bound item-id factory (the B-F1 fix): tests and tooling derive
    // EXACTLY the ids collectDecisionItems mints, so fixtures cannot drift
    // from the gate's identity grammar.
    decisionItemId,
    // Tri-state git read helpers behind that verifier, exported as TEST
    // SEAMS for the same reason: repo corruption cannot selectively fail
    // `git log -1` / `git show` while letting the earlier rev-parse /
    // reachability reads succeed, so their unavailable branches are
    // injected directly (non-git directory).
    commitMessageContains,
    committedBlobAt,
    saveSkillProposal,
    readSkillProposal,
    listSkillProposals,
    setSkillProposalStatus,
    deleteSkillProposal,
    recordArtifact,
    recordArtifacts,
    resolvePaths,
    cleanupArtifacts,
    saveDraft,
    approveDraft,
    readDraft,
    printJson,
    resolveCliSessionID,
    clearedAssumptionsPath,
    parseClearedAssumptionsYaml,
    loadClearedAssumptions,
    mergeClearedAssumptions,
    computeTaskDesignDigest,
    computePlanDesignDigest,
};
