// complexity-signal-lib.js — shared complexity signal computation for the Node
// event-time projection. Mirrors internal/complexity (Go) so both adapters
// produce the SAME logical Signal from the SAME input vectors. A cross-language
// parity fixture (internal/complexity/testdata/complexity-vectors.json) verifies
// they agree.
//
// Design contract (staged advisory hybrid): complexity signals INFORM; they
// never gate. A Signal carries a nominated metric (file_loc observed >
// configured threshold) plus optional boundary diagnostics, but it has NO
// transition authority. Nothing here may turn a threshold breach into a FAIL or
// authorize a transition.
import fs from "fs";
import path from "path";

// countLines: shared line-count semantics. empty=0; single line no terminal
// newline=1; terminal newline does NOT create a phantom extra line; CRLF and LF
// produce equal counts. Mirrors complexity.CountLines (Go).
export function countLines(content) {
    if (!content || content.length === 0) {
        return 0;
    }
    let text = String(content);
    text = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const parts = text.split("\n");
    if (parts.length > 0 && parts[parts.length - 1] === "") {
        parts.pop();
    }
    return parts.length;
}

// DEFAULT_SUPPORTED_EXTENSIONS mirrors the v1 supported set (policy seeds all 10).
const DEFAULT_SUPPORTED_EXTENSIONS = new Set([
    ".go", ".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".py", ".ts", ".tsx",
]);

// loadPolicy reads .vh-agent-harness/complexity-policy.yml from a directory and
// returns a normalized Policy object. The YAML is platform-controlled and
// simple; this is a targeted line-oriented reader (no full YAML dependency).
// Returns null when the file is absent; callers treat null as "disabled".
export function loadPolicy(directory) {
    const policyPath = path.join(directory, ".vh-agent-harness", "complexity-policy.yml");
    let text;
    try {
        text = fs.readFileSync(policyPath, "utf8");
    } catch {
        return null;
    }
    return parsePolicy(text);
}

// parsePolicy parses a complexity-policy.yml text into a normalized Policy. This
// is a focused reader for the known v1 structure (version, enabled, defaults,
// per_language, exclude, doctor, recurrence). It is NOT a general YAML parser.
export function parsePolicy(text) {
    const policy = {
        version: 1,
        enabled: true,
        defaults: { eventFileLines: 350, snapshotFileLines: 500 },
        perLanguage: {},
        exclude: { eventPaths: [], snapshotPaths: [], snapshotSuffixes: [] },
        doctor: { maxCandidates: 10 },
        recurrence: { enabled: false },
    };
    const lines = text.split(/\r?\n/);
    let section = "";
    let currentLangKey = null;
    for (let raw of lines) {
        const line = raw.replace(/\s+$/, "");
        if (line.trim() === "" || line.trim().startsWith("#")) {
            continue;
        }
        const indent = line.length - line.trimStart().length;
        const trimmed = line.trim();
        if (indent === 0) {
            section = "";
            currentLangKey = null;
            const [key, val] = splitKV(trimmed);
            switch (key) {
                case "version":
                    policy.version = parseInt(val, 10) || 1;
                    break;
                case "enabled":
                    policy.enabled = parseBool(val);
                    break;
                case "defaults":
                    section = "defaults";
                    break;
                case "per_language":
                    section = "per_language";
                    break;
                case "exclude":
                    section = "exclude";
                    break;
                case "doctor":
                    section = "doctor";
                    break;
                case "recurrence":
                    section = "recurrence";
                    break;
            }
            continue;
        }
        switch (section) {
            case "defaults": {
                const [key, val] = splitKV(trimmed);
                if (key === "event_file_lines") policy.defaults.eventFileLines = parseInt(val, 10) || 0;
                if (key === "snapshot_file_lines") policy.defaults.snapshotFileLines = parseInt(val, 10) || 0;
                break;
            }
            case "per_language": {
                // A key like ".go": {} or ".go:" starts a language entry.
                // Only match extension-like keys (starting with ".") so block-
                // style override lines like "event_file_lines: 100" fall through
                // to the correct else-if branches below.
                const langMatch = trimmed.match(/^"?(\.[a-z0-9]+)"?\s*:(.*)$/);
                if (langMatch && !trimmed.startsWith("-")) {
                    currentLangKey = langMatch[1];
                    if (!policy.perLanguage[currentLangKey]) {
                        policy.perLanguage[currentLangKey] = {};
                    }
                    const rest = langMatch[2].trim();
                    if (rest && rest !== "{}") {
                        // inline override on the same line, e.g. ".js": { event_file_lines: 100 }
                        parseInlineOverride(rest, policy.perLanguage[currentLangKey]);
                    }
                } else if (currentLangKey && trimmed.startsWith("event_file_lines:")) {
                    const [, val] = splitKV(trimmed);
                    policy.perLanguage[currentLangKey].eventFileLines = parseInt(val, 10);
                } else if (currentLangKey && trimmed.startsWith("snapshot_file_lines:")) {
                    const [, val] = splitKV(trimmed);
                    policy.perLanguage[currentLangKey].snapshotFileLines = parseInt(val, 10);
                }
                break;
            }
            case "exclude": {
                if (trimmed === "event_paths:") { currentLangKey = "event_paths"; break; }
                if (trimmed === "snapshot_paths:") { currentLangKey = "snapshot_paths"; break; }
                if (trimmed === "snapshot_suffixes:") { currentLangKey = "snapshot_suffixes"; break; }
                if (trimmed.startsWith("-")) {
                    const val = trimmed.slice(1).trim().replace(/^["']|["']$/g, "");
                    if (currentLangKey === "event_paths") policy.exclude.eventPaths.push(val);
                    if (currentLangKey === "snapshot_paths") policy.exclude.snapshotPaths.push(val);
                    if (currentLangKey === "snapshot_suffixes") policy.exclude.snapshotSuffixes.push(val);
                }
                break;
            }
            case "doctor": {
                const [key, val] = splitKV(trimmed);
                if (key === "max_candidates") policy.doctor.maxCandidates = parseInt(val, 10) || 10;
                break;
            }
            case "recurrence": {
                const [key, val] = splitKV(trimmed);
                if (key === "enabled") policy.recurrence.enabled = parseBool(val);
                break;
            }
        }
    }
    return policy;
}

function splitKV(trimmed) {
    const idx = trimmed.indexOf(":");
    if (idx < 0) return [trimmed, ""];
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    return [key, val];
}

function parseBool(val) {
    return val === "true";
}

function parseInlineOverride(rest, target) {
    const inner = rest.replace(/[{}]/g, "").trim();
    if (!inner) return;
    for (const part of inner.split(",")) {
        const [k, v] = splitKV(part.trim());
        if (k === "event_file_lines") target.eventFileLines = parseInt(v, 10);
        if (k === "snapshot_file_lines") target.snapshotFileLines = parseInt(v, 10);
    }
}

// supportsExtension reports whether a language is supported by the policy.
function supportsExtension(policy, ext) {
    if (policy && policy.perLanguage && Object.prototype.hasOwnProperty.call(policy.perLanguage, ext)) {
        return true;
    }
    return DEFAULT_SUPPORTED_EXTENSIONS.has(ext);
}

// resolveThreshold returns the configured threshold for a language + projection.
function resolveThreshold(policy, ext, projection) {
    const ov = policy && policy.perLanguage ? policy.perLanguage[ext] : null;
    if (ov) {
        if (projection === "post_edit" && ov.eventFileLines != null) return ov.eventFileLines;
        if (projection === "repo_snapshot" && ov.snapshotFileLines != null) return ov.snapshotFileLines;
    }
    if (!policy || !policy.defaults) return 0;
    return projection === "post_edit" ? policy.defaults.eventFileLines : policy.defaults.snapshotFileLines;
}

// globMatch implements the v1 complexity glob grammar (** = zero-or-more
// segments). Mirrors complexity.globMatch (Go).
export function globMatch(pattern, name) {
    const patSegs = pattern.split("/");
    const nameSegs = name.split("/");
    return matchSegments(patSegs, nameSegs);
}

function matchSegments(patSegs, nameSegs) {
    if (patSegs.length === 0) return nameSegs.length === 0;
    if (patSegs[0] === "**") {
        const rest = patSegs.slice(1);
        for (let i = 0; i <= nameSegs.length; i++) {
            if (matchSegments(rest, nameSegs.slice(i))) return true;
        }
        return false;
    }
    if (nameSegs.length === 0) return false;
    if (!starMatch(patSegs[0], nameSegs[0])) return false;
    return matchSegments(patSegs.slice(1), nameSegs.slice(1));
}

function starMatch(pat, str) {
    let pi = 0, si = 0, star = -1, match = 0;
    while (si < str.length) {
        if (pi < pat.length && pat[pi] === "*") {
            star = pi;
            match = si;
            pi++;
        } else if (pi < pat.length && pat[pi] === str[si]) {
            pi++;
            si++;
        } else if (star !== -1) {
            pi = star + 1;
            match++;
            si = match;
        } else {
            return false;
        }
    }
    while (pi < pat.length && pat[pi] === "*") pi++;
    return pi === pat.length;
}

// isExcluded reports whether a path is excluded for the given projection.
export function isExcluded(policy, relPath, projection) {
    const patterns = projection === "post_edit"
        ? (policy.exclude.eventPaths || [])
        : (policy.exclude.snapshotPaths || []);
    for (const pat of patterns) {
        if (globMatch(pat, relPath)) return true;
    }
    if (projection === "repo_snapshot") {
        const base = path.basename(relPath);
        for (const suf of (policy.exclude.snapshotSuffixes || [])) {
            if (base.endsWith(suf)) return true;
        }
    }
    return false;
}

// eligible reports whether a path is eligible: supported extension AND not
// excluded. Mirrors complexity.Policy.Eligible (Go).
export function eligible(policy, relPath, projection) {
    const ext = path.extname(relPath);
    if (!supportsExtension(policy, ext)) return false;
    if (isExcluded(policy, relPath, projection)) return false;
    return true;
}

// computeSignal produces the shared Signal for one file. Mirrors
// complexity.ComputeSignal (Go). Nomination: observed > threshold (strict).
export function computeSignal(relPath, content, policy, projection) {
    relPath = relPath.replaceAll("\\", "/");
    const ext = path.extname(relPath);
    const threshold = resolveThreshold(policy, ext, projection);
    const observed = countLines(content);
    return {
        path: relPath,
        projection: projection,
        language: ext,
        metric: {
            kind: "file_loc",
            observed: observed,
            threshold: threshold,
            nominated: observed > threshold,
        },
        boundary_indicators: [],
    };
}

// sortSignals orders by descending observed LOC, then ascending path. Mirrors
// complexity.SortSignals (Go).
export function sortSignals(signals) {
    return signals.slice().sort((a, b) => {
        if (a.metric.observed !== b.metric.observed) {
            return b.metric.observed - a.metric.observed;
        }
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
}

// postEditAdvisoryMessage renders the event-time advisory. WARN-only: no
// FAIL/rejection/auto-split language.
export function postEditAdvisoryMessage(signal) {
    return `${signal.projection}: ${signal.path} is ${signal.metric.observed} lines (threshold ${signal.metric.threshold}) after this edit; consider extracting helpers or reviewing the boundary's cohesion`;
}

export { DEFAULT_SUPPORTED_EXTENSIONS };
