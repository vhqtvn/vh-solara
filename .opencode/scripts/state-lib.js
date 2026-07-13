import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const SCHEMA_VERSION = 1;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;
const STALE_LOCK_MS = 30000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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
    constructor(message) {
        super(message);
        this.name = "StateError";
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
        throw new StateError(`Malformed JSON state file: ${targetPath}`);
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
}

function normalizeStoredCoordinationReview(sourceLastReview, reviewPaths) {
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
    const normalized = {
        path: storedPath,
        reviewed_at: (raw && raw.reviewed_at) || parsed?.reviewed_at || null,
        session_name: sessionName || null,
        title: String((raw && raw.title) || parsed?.title || "").trim(),
        status:
            normalizeCoordinationEnum(
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

function normalizeCoordinationTaskRecord(payload, taskID = "") {
    const source = payload && typeof payload === "object" ? payload : {};
    const normalizedTaskID = normalizeCoordinationTaskId(
        source.task_id || taskID || "",
    );
    let normalizedStatus =
        normalizeCoordinationEnum(
            source.status,
            COORDINATION_TASK_STATUSES,
            "status",
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
    const coordinationMode = normalizeCoordinationEnum(
        source.coordination_mode,
        COORDINATION_MODES,
        "coordination_mode",
    );
    const reportEnvelope =
        normalizeCoordinationEnum(
            source.report_envelope,
            COORDINATION_REPORT_ENVELOPES,
            "report_envelope",
        ) || defaultReportEnvelopeForMode(coordinationMode);
    return {
        ...defaultCoordinationTaskPayload(normalizedTaskID),
        ...source,
        task_id: normalizedTaskID,
        title: String(source.title || "").trim(),
        task_type: normalizeCoordinationEnum(
            source.task_type,
            COORDINATION_TASK_TYPES,
            "task_type",
        ),
        coordination_mode: coordinationMode,
        primary_lane: String(source.primary_lane || "").trim(),
        research_question: String(source.research_question || "").trim(),
        source_policy:
            normalizeCoordinationEnum(
                source.source_policy,
                RESEARCH_SOURCE_POLICIES,
                "source_policy",
            ) || null,
        source_allowlist: normalizeStringList(source.source_allowlist),
        desired_artifact_type:
            normalizeCoordinationEnum(
                source.desired_artifact_type,
                RESEARCH_ARTIFACT_TYPES,
                "desired_artifact_type",
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
                          normalizeCoordinationEnum(
                              source.latest_report.status,
                              [...COORDINATION_CLOSEOUT_STATUSES],
                              "latest_report.status",
                          ) || null,
                      report_envelope:
                          normalizeCoordinationEnum(
                              source.latest_report.report_envelope,
                              COORDINATION_REPORT_ENVELOPES,
                              "latest_report.report_envelope",
                          ) || null,
                      created_at: source.latest_report.created_at || null,
                      summary: String(source.latest_report.summary || "").trim(),
                      promotion_recommended: Boolean(
                          source.latest_report.promotion_recommended,
                      ),
                  }
                : null,
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
 * @param {object} task
 * @param {object} [options]
 * @param {boolean} [options.allowLegacyIncompleteResearch]
 * @param {Set<string>} [options.enumInvalidFields]
 * @returns {string[]} collected error messages (empty when valid)
 */
function collectCoordinationTaskCoreFieldErrors(task, options = {}) {
    const errors = [];
    const enumInvalid = options.enumInvalidFields || new Set();
    // True when the field has NO already-collected enum error of its own, i.e.
    // a missing/blank value here is a genuine missing-value problem rather
    // than a side effect of a failed enum normalization upstream.
    const isGenuinelyMissing = (field) => !enumInvalid.has(field);
    if (!task.title && isGenuinelyMissing("title")) {
        errors.push("Task title is required.");
    }
    if (!task.task_type && isGenuinelyMissing("task_type")) {
        errors.push("task_type is required.");
    }
    if (!task.coordination_mode && isGenuinelyMissing("coordination_mode")) {
        errors.push("coordination_mode is required.");
    }
    if (!task.primary_lane && isGenuinelyMissing("primary_lane")) {
        errors.push("primary_lane is required.");
    }
    if (!task.status && isGenuinelyMissing("status")) {
        errors.push("status is required.");
    }
    if (!task.report_envelope && isGenuinelyMissing("report_envelope")) {
        errors.push("report_envelope is required.");
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
        }
        if (
            !tolerateLegacyResearchGap &&
            !task.source_policy &&
            isGenuinelyMissing("source_policy")
        ) {
            errors.push("Research tasks must define source_policy.");
        }
        if (
            !tolerateLegacyResearchGap &&
            !task.desired_artifact_type &&
            isGenuinelyMissing("desired_artifact_type")
        ) {
            errors.push("Research tasks must define desired_artifact_type.");
        }
        if (
            !tolerateLegacyResearchGap &&
            !task.target_artifact_path &&
            isGenuinelyMissing("target_artifact_path")
        ) {
            errors.push("Research tasks must define target_artifact_path.");
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
        }
        return errors;
    }
    if (task.status === "working") {
        if (!task.active_session_alias || !task.claimed_at) {
            errors.push(
                "Working tasks must record active_session_alias and claimed_at.",
            );
        }
    }
    if (!(task.files_in_scope || []).length) {
        errors.push("files_in_scope must contain at least one path.");
    }
    if (!(task.success_criteria || []).length) {
        errors.push(
            "success_criteria must contain at least one requirement.",
        );
    }
    if (!(task.validation_plan || []).length) {
        errors.push(
            "validation_plan must contain at least one verification step.",
        );
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
        }
    }
    return errors;
}

function ensureCoordinationTaskCoreFields(task, options = {}) {
    throwCollectedErrors(collectCoordinationTaskCoreFieldErrors(task, options));
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

function coordinationTaskRecommendation(task, actorSessionName = null) {
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

function recommendedCoordinationTaskFields(task, actorSessionName = null) {
    const recommendation = coordinationTaskRecommendation(task, actorSessionName);
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
}) {
    const normalizedBody = String(body || "").trim();
    if (!normalizedBody) {
        throw new StateError(
            "Plan body is empty. Refuse to save an empty plan.",
        );
    }
    return [
        "---",
        `id: ${yamlScalar(planId)}`,
        `title: ${yamlScalar(title)}`,
        `session_name: ${yamlScalar(sessionName)}`,
        `status: ${yamlScalar(status)}`,
        `created_at: ${yamlScalar(createdAt)}`,
        `cwd: ${yamlScalar(cwd)}`,
        `session_id: ${yamlScalar(sessionID)}`,
        "---",
        "",
        normalizedBody,
        "",
    ].join("\n");
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
    return {
        session_id: sessionID,
        session_name: sessionName,
        adopted_plan_id: index.adopted_plan_id || null,
        resolved_via: resolved.resolvedVia,
        plan: resolved.plan,
        path: targetPath,
        body: fs.readFileSync(targetPath, "utf8"),
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
            };
        }
        throw new StateError(
            `Coordination task does not exist: ${relativeToRepo(targetPath)}`,
        );
    }
    const payload = normalizeCoordinationTaskRecord(
        readJson(targetPath, defaultCoordinationTaskPayload(taskID)),
        taskID,
    );
    ensureCoordinationTaskCoreFields(payload, {
        allowLegacyIncompleteResearch: true,
    });
    return {
        task_id: taskID,
        path: targetPath,
        payload,
        exists: true,
    };
}

function listCoordinationTaskCards() {
    ensureLocalCoordinatorNamespace();
    const files = fs.existsSync(localCoordinatorTasksRoot())
        ? fs.readdirSync(localCoordinatorTasksRoot())
        : [];
    return files
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
            const taskID = name.replace(/\.json$/, "");
            return loadCoordinationTask(taskID).payload;
        })
        .sort((left, right) => {
            const leftUpdated = String(left.updated_at || left.created_at || "");
            const rightUpdated = String(right.updated_at || right.created_at || "");
            return rightUpdated.localeCompare(leftUpdated);
        });
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

function saveCoordinationTask(sessionID, taskPayload, options = {}) {
    const actor = coordinationActorContext(sessionID, options);
    const input = taskPayload && typeof taskPayload === "object" ? taskPayload : {};
    const explicitNextAction =
        input.next_action !== undefined
            ? String(input.next_action || "").trim()
            : null;
    const explicitTaskID = String(input.task_id || "").trim();
    const taskID = explicitTaskID
        ? normalizeCoordinationTaskId(explicitTaskID)
        : generateCoordinationTaskId(input.title || "task");
    const existing = loadCoordinationTask(taskID, { required: false });
    const created = !existing.exists;
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
    return {
        ...actor,
        path: relativeToRepo(loaded.path),
        task: loaded.payload,
        summary: summarizeCoordinationTask(loaded.payload),
        latest_report: latestReport,
        last_review: lastReview,
        overlaps: detectCoordinationTaskOverlaps(
            loaded.payload.task_id,
            loaded.payload.files_in_scope,
        ),
        ...recommendedCoordinationTaskFields(
            loaded.payload,
            actor.session_name || null,
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
    const tasks = listCoordinationTaskCards().filter((task) =>
        statuses.length ? statuses.includes(task.status) : true,
    );
    const counts = {};
    for (const task of tasks) {
        counts[task.status] = (counts[task.status] || 0) + 1;
    }
    return {
        ...actor,
        total: tasks.length,
        status_counts: counts,
        tasks: tasks.map((task) => ({
            ...summarizeCoordinationTask(task),
            ...recommendedCoordinationTaskFields(
                task,
                actor.session_name || null,
            ),
        })),
    };
}

function activateCoordinationTask(sessionID, taskIDRaw, options = {}) {
    const actor = coordinationActorContext(sessionID, options);
    const loaded = loadCoordinationTask(taskIDRaw);
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

function readyCoordinationTask(sessionID, taskIDRaw, input = {}, options = {}) {
    const actor = coordinationActorContext(sessionID, options);
    const loaded = loadCoordinationTask(taskIDRaw);
    if (!["draft", "ready"].includes(loaded.payload.status)) {
        throw new StateError(
            `Task ${loaded.payload.task_id} is ${loaded.payload.status} and cannot be prepared for execution.`,
        );
    }
    const payload = input && typeof input === "object" ? input : {};
    const explicitNextAction =
        payload.next_action !== undefined
            ? String(payload.next_action || "").trim()
            : null;
    const wasDraft = loaded.payload.status === "draft";
    const saved = updateCoordinationTask(loaded.payload.task_id, (current) => {
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

function repairCoordinationTask(sessionID, taskIDRaw, input = {}, options = {}) {
    const actor = coordinationActorContext(sessionID, options);
    const loaded = loadCoordinationTask(taskIDRaw);
    const errors = [];
    if (loaded.payload.task_type !== "research") {
        errors.push(
            `Task ${loaded.payload.task_id} is ${loaded.payload.task_type} and does not use the research repair flow.`,
        );
    }
    const payload = input && typeof input === "object" ? input : {};
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
}) {
    const normalizedBody = String(body || "").trim();
    if (!normalizedBody) {
        throw new StateError(
            "Draft body is empty. Refuse to save an empty draft.",
        );
    }
    return [
        "---",
        `slug: ${yamlScalar(slug)}`,
        `title: ${yamlScalar(title)}`,
        `session_name: ${yamlScalar(sessionName)}`,
        "status: draft",
        `created_at: ${yamlScalar(createdAt)}`,
        `updated_at: ${yamlScalar(updatedAt)}`,
        `cwd: ${yamlScalar(cwd)}`,
        `session_id: ${yamlScalar(sessionID)}`,
        "---",
        "",
        normalizedBody,
        "",
    ].join("\n");
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
    const markdown = formatDraftMarkdown({
        slug,
        title: draftTitle,
        sessionName,
        createdAt,
        updatedAt,
        cwd: options.cwd || binding.cwd || hostCwd(),
        sessionID,
        body,
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
    };
}

function approveDraft(sessionID, slugOrTitle, options = {}) {
    const draft = readDraft(sessionID, slugOrTitle, options);
    const saved = savePlan(
        sessionID,
        draft.slug,
        draft.body,
        draft.title,
        options,
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
};
