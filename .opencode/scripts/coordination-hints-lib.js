import fs from "fs";
import path from "path";

const LARGE_FILE_LINE_THRESHOLD = 350;
const LARGE_FILE_EXTENSIONS = new Set([
    ".cjs",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".mts",
    ".py",
    ".ts",
    ".tsx",
]);

const IGNORED_PREFIXES = [
    ".git/",
    ".opencode/state/",
    ".pytest_cache/",
    ".ruff_cache/",
    "node_modules/",
    "tmp/",
];

const COORDINATION_PREFIXES = [
    ".opencode/agents/",
    ".opencode/commands/",
    ".opencode/plugins/",
    ".opencode/tools/",
    "docs/coordination/",
];

const COORDINATION_EXACT_PATHS = new Set([
    ".local/AGENTS.md",
    ".opencode/README-session-state.md",
    ".opencode/scripts/state-lib.js",
    "AGENTS.md",
    "opencode.jsonc",
]);

// TODO(phase-later): read product prefixes from .vh-agent-harness/project.config.json
// (project.product_prefixes) at runtime so non-monorepo projects can override.
// Default kept as ["apps/", "packages/"] for monorepo compatibility.
const PRODUCT_PREFIXES = [
    "apps/",
    "packages/",
];

function normalizePath(value) {
    return String(value || "").replaceAll("\\", "/");
}

function normalizeRepoRelativePath(directory, filePath) {
    if (!filePath) {
        return "";
    }
    const base = path.resolve(directory);
    const raw = String(filePath);
    const absolute = path.isAbsolute(raw)
        ? raw
        : path.resolve(base, raw);
    return normalizePath(path.relative(base, absolute));
}

function isIgnoredHintPath(relativePath) {
    if (!relativePath || relativePath.startsWith("../")) {
        return true;
    }
    return IGNORED_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function isCoordinationSurface(relativePath) {
    if (COORDINATION_EXACT_PATHS.has(relativePath)) {
        return true;
    }
    return COORDINATION_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function isProductSurface(relativePath) {
    return PRODUCT_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function supportsLargeFileHint(relativePath) {
    return LARGE_FILE_EXTENSIONS.has(path.extname(relativePath));
}

function countLines(directory, relativePath) {
    try {
        const absolute = path.join(directory, relativePath);
        const text = fs.readFileSync(absolute, "utf8");
        if (!text.length) {
            return 0;
        }
        return text.split(/\r?\n/).length;
    } catch {
        return 0;
    }
}

function uniqueByPath(entries) {
    const seen = new Map();
    for (const entry of entries) {
        seen.set(entry.relative_path, entry);
    }
    return [...seen.values()];
}

function previewList(paths, maxItems = 3) {
    const shown = paths.slice(0, maxItems);
    if (paths.length <= maxItems) {
        return shown.join(", ");
    }
    return `${shown.join(", ")}, +${paths.length - maxItems} more`;
}

function largeFileMessage(largeFiles) {
    const items = largeFiles.map((entry) =>
        `${entry.relative_path} (${entry.line_count} lines)`
    );
    return `${previewList(items)} exceeded the ${LARGE_FILE_LINE_THRESHOLD}-line hint threshold after this edit. Consider extracting helpers or splitting the boundary before it grows further.`;
}

function buildCoordinationHintMessages(input) {
    const directory = path.resolve(String(input.directory || process.cwd()));
    const diffFiles = Array.isArray(input.diffFiles) ? input.diffFiles : [];
    const lineThreshold = Number(input.lineThreshold || LARGE_FILE_LINE_THRESHOLD);
    const normalized = uniqueByPath(
        diffFiles
            .map((entry) => {
                const relativePath = normalizeRepoRelativePath(
                    directory,
                    entry && entry.file,
                );
                return {
                    relative_path: relativePath,
                    additions: Number(entry && entry.additions ? entry.additions : 0),
                };
            })
            .filter((entry) =>
                entry.relative_path && !isIgnoredHintPath(entry.relative_path)
            ),
    );

    if (!normalized.length) {
        return [];
    }

    const hints = [];
    const touchedPaths = normalized.map((entry) => entry.relative_path);
    const coordinationTouched = touchedPaths.filter(isCoordinationSurface);
    const productTouched = touchedPaths.filter(isProductSurface);

    if (touchedPaths.includes("docs/planning/backlog.md")) {
        hints.push({
            key: "backlog-cleanup-reminder",
            title: "Backlog Reminder",
            variant: "info",
            message:
                "You edited docs/planning/backlog.md. If this closes or cancels work, run /backlog-cleanup before closeout and keep the checkpoint state aligned.",
        });
    }

    if (coordinationTouched.length) {
        hints.push({
            key: "coordination-surface-reminder",
            title: "Coordination Reminder",
            variant: "info",
            message:
                `You edited coordination surfaces (${previewList(coordinationTouched)}). If this changes durable workflow rules, pair it with the matching backlog row and a checkpoint.`,
        });
    }

    if (coordinationTouched.length && productTouched.length) {
        hints.push({
            key: "cross-boundary-slice-warning",
            title: "Cross-Boundary Slice",
            variant: "warning",
            message:
                `This turn touched both coordination surfaces (${previewList(coordinationTouched)}) and product code (${previewList(productTouched)}). Re-check whether the slice still belongs in one task or review packet.`,
        });
    }

    const largeFiles = normalized
        .filter((entry) => entry.additions > 0 && supportsLargeFileHint(entry.relative_path))
        .map((entry) => ({
            ...entry,
            line_count: countLines(directory, entry.relative_path),
        }))
        .filter((entry) => entry.line_count > lineThreshold);

    if (largeFiles.length) {
        hints.push({
            key: `large-file-warning:${largeFiles.map((entry) => entry.relative_path).sort().join("|")}`,
            title: "Large File Hint",
            variant: "warning",
            message: largeFileMessage(largeFiles),
        });
    }

    return hints;
}

// --- Command-repetition hints (signal-triggered, not path-triggered) ---------
// C10: `command.executed` events are tracked per session. When the same command
// SHAPE repeats >= COMMAND_REPETITION_THRESHOLD times, a non-blocking warning
// fires once per (session, key). This catches command-trajectory failures that
// produce NO file diff, which the session.diff path/content triggers are
// structurally blind to (coordination-hints.js handles this branch).
//
// Normalization strategy (START STRICT): collapse clearly-volatile tokens —
// file/path-like tokens, quoted payloads, and bare numbers — so the same command
// run against different files (e.g. `pytest tests/unit/a.py` vs `.../b.py`)
// normalizes to ONE identity. We prefer false-negatives over toast-spam: the
// threshold (>=3) bounds firing, and only obviously-volatile tokens collapse.
// Distinct commands keep their first meaningful tokens. Relax on observed
// misses, not speculation.
const COMMAND_REPETITION_THRESHOLD = 3;
const COMMAND_IDENTITY_MAX = 120;

function isVolatilePathToken(token) {
    if (!token) {
        return false;
    }
    if (token.includes("/") || token.includes("\\")) {
        return true;
    }
    if (/^\.\.?([\\/]|$)/.test(token)) {
        return true;
    }
    // ends with a short extension like .py, .ts, .json, .md
    if (/\.[a-z0-9]{1,6}$/i.test(token)) {
        return true;
    }
    return false;
}

function normalizeCommandToken(token) {
    const trimmed = String(token == null ? "" : token).trim();
    if (!trimmed) {
        return "";
    }
    // quoted payloads (single, double, backtick) — collapse the whole token
    if (/^["'`]/.test(trimmed)) {
        return "<quoted>";
    }
    if (isVolatilePathToken(trimmed)) {
        return "<path>";
    }
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        return "<num>";
    }
    return trimmed;
}

// Build a stable, normalized command identity from a `command.executed`
// {name, arguments} pair. `arguments` may be a string, an array of strings,
// or null/undefined. Returns a space-joined identity (never empty).
function normalizeCommandIdentity(name, args) {
    const segments = [];
    const nameStr = String(name == null ? "" : name).trim();
    if (nameStr) {
        segments.push(nameStr);
    }
    if (Array.isArray(args)) {
        for (const entry of args) {
            segments.push(String(entry == null ? "" : entry));
        }
    } else if (typeof args === "string") {
        const trimmed = args.trim();
        if (trimmed) {
            segments.push(trimmed);
        }
    } else if (args !== null && args !== undefined) {
        segments.push(String(args));
    }
    const joined = segments.join(" ");
    const normalized = joined
        .split(/\s+/)
        .map(normalizeCommandToken)
        .filter(Boolean)
        .join(" ");
    return normalized || "<empty>";
}

// Returns a repetition warning hint when `count` crosses the threshold, else
// null. The hint.key is STABLE for a given identity across all counts >=
// threshold, so the plugin's per-session Set dedup fires it exactly once.
function buildRepetitionHint(commandIdentity, count) {
    const numeric = Number(count) || 0;
    if (numeric < COMMAND_REPETITION_THRESHOLD) {
        return null;
    }
    const identity = String(commandIdentity || "<empty>").slice(0, COMMAND_IDENTITY_MAX);
    return {
        key: `command-repetition:${identity}`,
        title: "Repeated Command",
        variant: "warning",
        message:
            `A command shape ("${identity}") repeated ${numeric}x this session. ` +
            "If it isn't producing the changes you expect, re-check the sanctioned form or escalate instead of retrying.",
    };
}

export {
    COMMAND_REPETITION_THRESHOLD,
    LARGE_FILE_LINE_THRESHOLD,
    buildCoordinationHintMessages,
    buildRepetitionHint,
    isCoordinationSurface,
    isIgnoredHintPath,
    isProductSurface,
    normalizeCommandIdentity,
    normalizeRepoRelativePath,
};

export default {
    COMMAND_REPETITION_THRESHOLD,
    LARGE_FILE_LINE_THRESHOLD,
    buildCoordinationHintMessages,
    buildRepetitionHint,
    isCoordinationSurface,
    isIgnoredHintPath,
    isProductSurface,
    normalizeCommandIdentity,
    normalizeRepoRelativePath,
};
