import fs from "fs";
import path from "path";
import {
    countLines as complexityCountLines,
    loadPolicy as loadComplexityPolicy,
    eligible as complexityEligible,
} from "./complexity-signal-lib.js";

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

// Product-prefix source: coordination-hints resolves the product-code surface
// from .vh-agent-harness/product-prefixes.json (a project-owned, committed
// override) so non-monorepo projects can declare their own layout. The file is
// absent on most projects (the monorepo default below applies); loadProductPrefixes
// returns null when absent or malformed, and callers fall back to the default.
// Dedicated file rather than project.config.json: that file has a contract-closed
// 4-field set consumed only by the Go render seam (see its //_fields comment),
// and vh-harness-profile.yml rejects unknown top-level keys — neither is an
// extensible host for this runtime-consumed field.
const DEFAULT_PRODUCT_PREFIXES = [
    "apps/",
    "packages/",
];

// parseProductPrefixes is the pure parser/normalizer for the product-prefixes
// config. Accepts the raw file text, returns a de-duplicated array of normalized
// (forward-slash) string prefixes, or null when the content is missing, not
// valid JSON, lacks a non-empty product_prefixes array, or any member is not a
// non-empty string. Mirrors the loadComplexityPolicy parse/load split so parsing
// stays directly unit-testable; a null return means "use the monorepo default".
function parseProductPrefixes(text) {
    if (!text) {
        return null;
    }
    let doc;
    try {
        doc = JSON.parse(text);
    } catch {
        return null;
    }
    const raw = doc && Array.isArray(doc.product_prefixes) ? doc.product_prefixes : null;
    if (!raw || !raw.length) {
        return null;
    }
    const normalized = [];
    const seen = new Set();
    for (const entry of raw) {
        if (typeof entry !== "string") {
            return null;
        }
        const norm = entry.replaceAll("\\", "/").trim();
        if (!norm) {
            return null;
        }
        if (!seen.has(norm)) {
            seen.add(norm);
            normalized.push(norm);
        }
    }
    return normalized;
}

// loadProductPrefixes reads .vh-agent-harness/product-prefixes.json under
// directory and returns the parsed/normalized prefix list, or null when the file
// is absent/malformed/invalid (callers fall back to DEFAULT_PRODUCT_PREFIXES).
// Mirrors complexity-signal-lib.js :: loadPolicy (read + parse, null on absent).
function loadProductPrefixes(directory) {
    const filePath = path.join(directory, ".vh-agent-harness", "product-prefixes.json");
    let text;
    try {
        text = fs.readFileSync(filePath, "utf8");
    } catch {
        return null;
    }
    return parseProductPrefixes(text);
}

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

function isProductSurface(relativePath, productPrefixes = DEFAULT_PRODUCT_PREFIXES) {
    // Slash-correct comparison: a product-prefix entry denotes a DIRECTORY
    // boundary, so the startsWith match must be directory-bounded regardless
    // of whether the entry carries a trailing slash. A slash-less entry such
    // as "apps" must match "apps/x" (a file under apps/) but NOT "appsfoo/"
    // (an unrelated directory) — a raw startsWith would over-match the latter.
    // Normalizing each prefix to end with "/" makes the bound explicit. The
    // shipped defaults (["apps/", "packages/"]) already carry the slash, so
    // behavior is unchanged for them; this hardens against an adopter
    // .vh-agent-harness/product-prefixes.json entry written without one.
    return productPrefixes.some((prefix) => {
        const bounded = prefix.endsWith("/") ? prefix : `${prefix}/`;
        return relativePath.startsWith(bounded);
    });
}

function supportsLargeFileHint(relativePath) {
    return LARGE_FILE_EXTENSIONS.has(path.extname(relativePath));
}

function countLines(directory, relativePath) {
    try {
        const absolute = path.join(directory, relativePath);
        const text = fs.readFileSync(absolute, "utf8");
        // Delegate to the shared complexity line-counter, which implements the
        // canonical semantics: empty=0, terminal newline does not create a
        // phantom line, CRLF==LF.
        return complexityCountLines(text);
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
        `${entry.relative_path} (${entry.line_count} lines, threshold ${entry.threshold})`
    );
    return `${previewList(items)} ${largeFiles.length === 1 ? "is" : "are"} above the complexity threshold after this edit. Consider extracting helpers or reviewing the boundary's cohesion; record a disposition (accept-as-cohesive or split-defer) if it is intentionally cohesive.`;
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

    const productPrefixes = loadProductPrefixes(directory) ?? DEFAULT_PRODUCT_PREFIXES;

    const hints = [];
    const touchedPaths = normalized.map((entry) => entry.relative_path);
    const coordinationTouched = touchedPaths.filter(isCoordinationSurface);
    const productTouched = touchedPaths.filter((p) => isProductSurface(p, productPrefixes));

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

    // Large-file hint: load the complexity policy so the threshold and
    // supported extensions come from .vh-agent-harness/complexity-policy.yml
    // (adds .go, respects per-language overrides and event exclusions) rather
    // than the fixed constants. Falls back to the constants when the policy is
    // absent (pre-install / greenfield). When enabled:false, the complexity
    // hint is disabled entirely (matches the Go doctor tierSkip).
    const rawPolicy = loadComplexityPolicy(directory);
    const complexityExplicitlyDisabled = rawPolicy !== null && rawPolicy.enabled === false;
    const complexityPolicy = rawPolicy && rawPolicy.enabled !== false ? rawPolicy : null;
    const largeFiles = complexityExplicitlyDisabled ? [] : normalized
        .filter((entry) => entry.additions > 0)
        .filter((entry) => {
            if (complexityPolicy) {
                return complexityEligible(complexityPolicy, entry.relative_path, "post_edit");
            }
            return supportsLargeFileHint(entry.relative_path);
        })
        .map((entry) => {
            const lineCount = countLines(directory, entry.relative_path);
            const threshold = resolveEventThreshold(complexityPolicy, entry.relative_path, lineThreshold);
            return { ...entry, line_count: lineCount, threshold };
        })
        .filter((entry) => entry.line_count > entry.threshold);

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

// resolveEventThreshold returns the event-time threshold for a file: the policy's
// per-language override (or default event_file_lines) when available, else the
// caller-supplied fallback (input.lineThreshold or the LARGE_FILE_LINE_THRESHOLD
// constant).
function resolveEventThreshold(policy, relativePath, fallback) {
    if (!policy) {
        return Number(fallback) || LARGE_FILE_LINE_THRESHOLD;
    }
    const ext = path.extname(relativePath);
    const ov = policy.perLanguage && policy.perLanguage[ext];
    if (ov && ov.eventFileLines != null) {
        return ov.eventFileLines;
    }
    if (policy.defaults && policy.defaults.eventFileLines) {
        return policy.defaults.eventFileLines;
    }
    return Number(fallback) || LARGE_FILE_LINE_THRESHOLD;
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
    DEFAULT_PRODUCT_PREFIXES,
    LARGE_FILE_LINE_THRESHOLD,
    buildCoordinationHintMessages,
    buildRepetitionHint,
    isCoordinationSurface,
    isIgnoredHintPath,
    isProductSurface,
    normalizeCommandIdentity,
    normalizeRepoRelativePath,
    parseProductPrefixes,
};

export default {
    COMMAND_REPETITION_THRESHOLD,
    DEFAULT_PRODUCT_PREFIXES,
    LARGE_FILE_LINE_THRESHOLD,
    buildCoordinationHintMessages,
    buildRepetitionHint,
    isCoordinationSurface,
    isIgnoredHintPath,
    isProductSurface,
    normalizeCommandIdentity,
    normalizeRepoRelativePath,
    parseProductPrefixes,
};
