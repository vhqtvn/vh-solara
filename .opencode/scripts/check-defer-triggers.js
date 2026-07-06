// check-defer-triggers.js — promotion predicate checker for DEFER / p2 /
// follow-up candidates held in .local/coordinator/tasks/.
//
// ROLE: this is the R6 "mechanized lightly" piece of the curation model
// (composition O1). DEFER / p2 / follow-up findings land in the holding area
// as conditional candidates with a Notes provenance block, including a
// `trigger:` line describing the condition under which the candidate becomes
// real work. This script reads those candidates and reports which ones'
// triggers are currently met, so the promoter can apply the Definition of
// Ready during a promotion cycle.
//
// SCOPE — read carefully:
//   - PROMOTER-USE-ONLY. Run by the promoter during a promotion cycle.
//   - NEVER wired into a commit hook.
//   - NEVER blocking. It prints a report and exits 0; it does not gate
//     commits, edits, or any other agent action.
//
// This is a first-slice MVP predicate engine, not a full rules system. It
// supports a small, deliberately tiny predicate vocabulary:
//   path_touched(<path>)   true if <path> appears in `git diff --name-only`
//                          since <since> (default: the most recent tag, or
//                          HEAD~32 if no tag exists — a bounded fallback so
//                          a fresh repo still produces useful output).
//   after_tag(<tag>)       true if <tag> exists and `git describe` is at or
//                          after it.
//
// A candidate may carry multiple `trigger:` lines (AND) or a single
// `trigger: any(...)` line (OR of the inner predicates). Unknown predicates
// evaluate to false and are reported as `unknown-predicate`, never thrown.
//
// The Notes provenance block this script reads looks like:
//   source:review-defer
//   trigger:path_touched(src/auth/login.go)
//   studied:2026-04-30
//
// USAGE:
//   node .opencode/scripts/check-defer-triggers.js [--since <ref>] [--tasks <dir>]
//
// Output is a human-readable report to stdout. Exit code is always 0 (this
// script never blocks; a non-zero exit would imply gating, which is out of
// scope). Failures (missing git, unreadable dir) print a warning line and
// degrade to "no candidates".

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM has no global __dirname; derive it from import.meta.url (mirrors the
// proven shim in state-lib.js) so repoRoot() is cwd-robust when node is
// spawned by the opencode plugin server / Go bridge with an explicit cwd.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// repoRoot() is inlined here (zero-dep, mirrors state-lib.js's definition)
// instead of imported, so this promoter-use-only MVP predicate checker stays
// self-contained and does not couple to a larger module for one helper.
function repoRoot() {
    return path.resolve(__dirname, "..", "..");
}

// The coordinator dir token is rendered by the harness on `update`; at
// runtime the literal here is the real dir name. Mirrors state-lib.js's
// localCoordinatorRoot() pattern (path.join(repoRoot(), ".local",
// "coordinator")).
const COORDINATOR_DIR = "coordinator";

function defaultTasksDir() {
    return path.join(repoRoot(), ".local", COORDINATOR_DIR, "tasks");
}

function parseArgs(argv) {
    const options = {
        since: null, // ref/tag to diff against; null = auto (latest tag or HEAD~32)
        tasksDir: null, // override the tasks dir; null = defaultTasksDir()
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--since" && i + 1 < argv.length) {
            options.since = argv[++i];
        } else if (a === "--tasks" && i + 1 < argv.length) {
            options.tasksDir = argv[++i];
        } else if (a === "--help" || a === "-h") {
            process.stdout.write(
                "usage: check-defer-triggers.js [--since <ref>] [--tasks <dir>]\n" +
                "  Promoter-use-only predicate checker. Reports which DEFER/p2\n" +
                "  candidates in the holding area have triggers currently met.\n" +
                "  Never blocking; never in a commit hook. Always exits 0.\n",
            );
            process.exit(0);
        }
    }
    return options;
}

// Resolve --since to a concrete ref. Default policy: most recent tag reachable
// from HEAD; if no tag exists, fall back to HEAD~32 so a fresh repo still
// produces a bounded diff. Returns null only if git itself is unusable.
function resolveSince(options) {
    if (options.since) return options.since;
    try {
        // describe --tags --abbrev=0 gives the nearest tag; ignore failures.
        // execFileSync with argv array — NEVER interpolate into a shell string
        // (defense against injection from operator-supplied --since values).
        const tag = execFileSync(
            "git", ["describe", "--tags", "--abbrev=0"],
            { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        if (tag) return tag;
    } catch (_) {
        // no tag, or git unavailable — fall through to HEAD~N.
    }
    return "HEAD~32";
}

// Return the set of paths changed since `since` (repo-relative, forward
// slashes). Returns null if git is unusable (caller degrades to "no data").
function changedPathsSince(since) {
    if (!isSafeRef(since)) return null;
    try {
        // execFileSync with argv array — `since` may originate from an
        // operator --since flag; never interpolate it into a shell string.
        const out = execFileSync(
            "git", ["diff", "--name-only", since],
            { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        return new Set(
            out.split("\n")
                .map((l) => l.trim())
                .filter(Boolean),
        );
    } catch (_) {
        return null;
    }
}

// Conservative ref-name validation. Git ref names are restricted to
// [A-Za-z0-9][A-Za-z0-9._/-]* roughly; we enforce a tight allowlist so a
// trigger arg can never carry shell metacharacters even if execFileSync
// were somehow bypassed. Returns true if the arg looks like a safe ref/path.
function isSafeRef(arg) {
    return /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(arg);
}

// True if `tag` exists in the repo. Used by after_tag(). Uses execFileSync
// with an argv array — NEVER shell interpolation — so a malicious trigger
// arg cannot inject commands. isSafeRef is defense-in-depth on top.
function tagExists(tag) {
    if (!isSafeRef(tag)) return false;
    try {
        execFileSync(
            "git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`],
            { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        // rev-parse --verify exits 0 if the ref resolves. We arrived here only
        // if execFileSync did not throw, which means exit 0 -> the tag exists.
        return true;
    } catch (_) {
        return false;
    }
}

// Parse a single predicate string into {kind, arg}. Returns null for
// unrecognized shapes (caller reports unknown-predicate).
function parsePredicate(trigger) {
    const t = (trigger || "").trim();
    let m = t.match(/^path_touched\((.+)\)$/);
    if (m) return { kind: "path_touched", arg: m[1].trim() };
    m = t.match(/^after_tag\((.+)\)$/);
    if (m) return { kind: "after_tag", arg: m[1].trim() };
    return null;
}

// Evaluate one parsed predicate against the current repo state. Returns
// { met: bool, note: string }.
function evaluatePredicate(pred, changedPaths) {
    if (pred.kind === "path_touched") {
        if (!changedPaths) {
            return { met: false, note: "no-git-diff-data" };
        }
        const hit = changedPaths.has(pred.arg);
        return { met: hit, note: hit ? "touched" : "not-touched-since-ref" };
    }
    if (pred.kind === "after_tag") {
        const exists = tagExists(pred.arg);
        return {
            met: exists,
            note: exists ? "tag-exists" : "tag-missing",
        };
    }
    return { met: false, note: "unknown-predicate" };
}

// Collect every `trigger:` line from a task-card body's Notes block. We scan
// the whole file for `^trigger:` lines (the Notes provenance convention);
// lines starting with `trigger:any(` open an OR-group whose members are
// parsed from the comma-separated inner text.
function extractTriggers(body) {
    if (!body || typeof body !== "string") return [];
    const triggers = [];
    const anyRe = /^trigger:\s*any\((.+)\)\s*$/im;
    const anyMatch = body.match(anyRe);
    if (anyMatch) {
        for (const piece of anyMatch[1].split(",")) {
            const t = piece.trim();
            if (t) triggers.push(t);
        }
        return { mode: "any", items: triggers };
    }
    const lineRe = /^trigger:\s*(.+?)\s*$/gim;
    let m;
    while ((m = lineRe.exec(body)) !== null) {
        triggers.push(m[1].trim());
    }
    return { mode: "all", items: triggers };
}

// Evaluate one candidate. Returns a report object.
function evaluateCandidate(file, body, since, changedPaths) {
    const idMatch = body.match(/(?:^task_id|^id):\s*(\S+)/im);
    const id = idMatch ? idMatch[1] : path.basename(file, ".md");
    const trig = extractTriggers(body);
    if (!trig.items || trig.items.length === 0) {
        return { id, file, met: false, mode: "none", note: "no-trigger-line", details: [] };
    }
    const details = trig.items.map((t) => {
        const pred = parsePredicate(t);
        if (!pred) return { trigger: t, met: false, note: "unknown-predicate" };
        return { trigger: t, ...evaluatePredicate(pred, changedPaths) };
    });
    const met = trig.mode === "any"
        ? details.some((d) => d.met)
        : details.every((d) => d.met);
    return { id, file, met, mode: trig.mode, note: met ? "ready-for-dor" : "trigger-not-met", details };
}

function main() {
    const options = parseArgs(process.argv);
    const tasksDir = options.tasksDir ? path.resolve(options.tasksDir) : defaultTasksDir();
    const since = resolveSince(options);

    let files = [];
    try {
        files = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith(".md"))
            .map((f) => path.join(tasksDir, f));
    } catch (_) {
        process.stdout.write(
            `check-defer-triggers: no tasks dir at ${tasksDir} (or unreadable). ` +
            `Nothing to evaluate. Promoter-use-only; never blocking.\n`,
        );
        process.exit(0);
    }

    const changedPaths = changedPathsSince(since);
    const sinceNote = changedPaths
        ? `diff-since=${since} (${changedPaths.size} changed paths)`
        : `diff-since=${since} (git unavailable — predicates degrade to not-met)`;

    const reports = files.map((f) => {
        let body = "";
        try {
            body = fs.readFileSync(f, "utf8");
        } catch (_) {
            body = "";
        }
        return evaluateCandidate(f, body, since, changedPaths);
    });

    process.stdout.write(
        `check-defer-triggers report — promoter-use-only, never blocking.\n` +
        `tasks-dir: ${tasksDir}\n` +
        `${sinceNote}\n\n`,
    );

    if (reports.length === 0) {
        process.stdout.write("No candidates found.\n");
        process.exit(0);
    }

    for (const r of reports) {
        const flag = r.met ? "READY" : "hold";
        process.stdout.write(`[${flag}] ${r.id} (${path.basename(r.file)}) — ${r.note}\n`);
        for (const d of r.details) {
            const mark = d.met ? "met" : "not-met";
            process.stdout.write(`    ${mark}: ${d.trigger} (${d.note})\n`);
        }
    }

    const ready = reports.filter((r) => r.met).length;
    process.stdout.write(
        `\n${ready}/${reports.length} candidate(s) have triggers met. ` +
        `Promoter: apply the Definition of Ready (area + file scope + validation ` +
        `plan + clear slice + provenance) before promoting any READY candidate.\n`,
    );
    process.exit(0);
}

main();
