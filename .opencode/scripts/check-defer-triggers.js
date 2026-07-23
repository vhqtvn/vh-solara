// check-defer-triggers.js — predicate evaluator for DEFER / p2 / follow-up
// candidates held in .local/coordinator/tasks/.
//
// TWO MODES, ONE EVALUATOR. The predicate primitives (repoRoot, resolveSince,
// changedPathsSince, isSafeRef, tagExists, parsePredicate, evaluatePredicate,
// extractTriggers) are shared. Mode selects the surface contract:
//
//   PROMOTER MODE (default; no --mode flag, or --mode=promoter)
//     - The R6 "mechanized lightly" piece of the curation model (composition
//       O1). DEFER / p2 / follow-up findings land in the holding area as
//       conditional candidates with a Notes provenance block, including a
//       `trigger:` line describing the condition under which the candidate
//       becomes real work. This script reads those candidates and reports
//       which ones' triggers are currently met, so the promoter can apply the
//       Definition of Ready during a promotion cycle.
//     - PROMOTER-USE-ONLY. Run by the promoter during a promotion cycle.
//     - NEVER wired into a commit hook.
//     - NEVER blocking. It prints a human-readable report and exits 0; it does
//       not gate commits, edits, releases, or any other agent action.
//     - Lenient: unknown predicates report as `unknown-predicate` and never
//       throw. This preserves backward compatibility with existing cards whose
//       trigger grammar predates the strict release contract.
//
//   RELEASE MODE (--mode=release)
//     - Strict releasetime evaluator. Consumed by the authorized release
//       wrapper (hard refusal) AND by the advisory readiness surface. ONE
//       evaluator so the two surfaces cannot drift.
//     - Emits STRUCTURED JSON (single object) and returns NONZERO for blocker
//       or evaluator-error classifications.
//     - SINGLE input mode: MANIFEST AUTHORITY. Reads the committed manifest at
//       .vh-agent-harness/release-defer-dispositions.json ONLY. Performs NO
//       .local/ access whatsoever. The committed manifest is the release
//       truth; .local/ stays promoter/provenance transport. (The legacy
//       .local/-scan release path has been retired; manifest authority is the
//       sole release-authority mode.)
//     - Fail-closed: missing/malformed manifest, unsupported schema_version,
//       unknown enum values, duplicate IDs, unsorted records, handshake
//       mismatch (evaluated_commit/manifest_parent_commit/HEAD^,
//       evaluated_tree/HEAD^{tree}, diff != [manifest path only]),
//       release_base kind=tag with no reachable prior tag (release_base.value
//       is DERIVED on read from git and is authoritative; a stale attested
//       value is a non-fatal advisory, not fail-closed), empty records without
//       reconciliation.zero_records_confirmed, and any disposition-matrix
//       refusal ALL produce blocker or evaluator-error. The handshake (sacred — do not weaken) prevents the
//       manifest from being weakened after its claimed evaluation.
//     - TWO distinct failure classes (the wrapper surfaces both explicitly):
//       (a) The manifest itself is missing/malformed/stale → evaluator-error
//           (exit 2). Remedy: repair the COMMITTED manifest. The override
//           ceremony CANNOT cure this class — override only applies to
//           override_required records, and a missing/malformed manifest has no
//           records to override.
//       (b) A release-relevant finding requires disposition → blocker (exit 1).
//           Remedy: resolve the finding OR use the override ceremony (when the
//           record disposition is override_required and the operator supplies
//           --override-release-version + --override-manifest-sha to the
//           wrapper, which forwards --override-confirmed-version here).
//
// This is a deliberately tiny predicate engine, not a full rules system:
//   path_touched(<path>)   true if <path> appears in `git diff --name-only`
//                          since <since>. EXACT path match in release mode —
//                          no glob, no directory-prefix. <path> ending in `/`
//                          is a directory operand and is evaluator-error in
//                          release mode.
//                          Promoter default <since>: the most recent tag, or
//                          HEAD~32 if no tag exists (bounded fallback so a
//                          fresh repo still produces useful output).
//   after_tag(<tag>)       true if <tag> exists.
//
// A candidate may carry multiple `trigger:` lines (AND semantics in both
// modes) or a single `trigger: any(...)` line (OR of the inner predicates).
// In PROMOTER mode, unknown predicates evaluate to false and are reported as
// `unknown-predicate`, never thrown. In RELEASE mode, unknown predicates are
// evaluator-error (fail closed).
//
// The Notes provenance block this script reads looks like:
//   source:review-defer
//   trigger:path_touched(src/auth/login.go)
//   studied:2026-04-30
//
// USAGE:
//   # Promoter mode (human-readable, always exit 0)
//   node .opencode/scripts/check-defer-triggers.js [--since <ref>] [--tasks <dir>]
//
//   # Release mode — MANIFEST AUTHORITY (reads committed manifest ONLY)
//   node .opencode/scripts/check-defer-triggers.js --mode=release \
//       [--release-version <vX.Y.Z>] [--override-confirmed-version <vX.Y.Z>]
//
//   --override-confirmed-version is supplied by the authorized release wrapper
//   ONLY after the operator-side override ceremony succeeds
//   (--override-release-version + --override-manifest-sha agree with the
//   requested version and the actual manifest blob SHA). It is the
//   transition-authority signal for Layer B (operator live intent). Layer A
//   (object validity + version match) is verifiable from the committed manifest
//   alone and is enforced with or without the flag; the wrapper adds a post-
//   evaluator gate so an override accepted by Layer A still refuses at tag
//   time when the operator did not supply the ceremony flags. CI verifies
//   Layer A from the committed manifest and accepts a well-formed override
//   without the flag (CI is defense-in-depth, not operator-intent re-enforcement).
//   Model/reviewer surfaces (the advisory readiness surface) cannot supply
//   this flag.
//
// Promoter-mode failures (missing git, unreadable dir) print a warning line
// and degrade to "no candidates". Release-mode failures fail closed.

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
// instead of imported, so this MVP predicate checker stays self-contained and
// does not couple to a larger module for one helper.
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

// Split `--flag=value` into [`--flag`, `value`] while leaving `--flag value`
// (two argv slots) untouched. Both forms are accepted for every flag.
function splitLongFlag(a) {
    const idx = a.indexOf("=");
    if (idx > 2 && a.startsWith("--")) {
        return [a.slice(0, idx), a.slice(idx + 1)];
    }
    return [a, null];
}

function parseArgs(argv) {
    const options = {
        since: null, // ref/tag to diff against; null = auto (latest tag or HEAD~32)
        tasksDir: null, // override the tasks dir; null = defaultTasksDir()
        mode: null, // null|'promoter' = human-readable (default); 'release' = JSON + strict
        releaseVersion: null, // release version being tagged (manifest authority: override binding)
        overrideConfirmedVersion: null, // operator-confirmed version (wrapper ceremony); honors override_required
    };
    for (let i = 2; i < argv.length; i++) {
        const raw = argv[i];
        const [a, inlineValue] = splitLongFlag(raw);
        // --flag=value form: consume the inline value; --flag value form: consume next argv slot.
        const takeValue = (fallbackNext) => {
            if (inlineValue !== null) return inlineValue;
            if (fallbackNext && i + 1 < argv.length) return argv[++i];
            return null;
        };
        if (a === "--since") {
            const v = takeValue(true);
            if (v !== null) options.since = v;
        } else if (a === "--tasks") {
            const v = takeValue(true);
            if (v !== null) options.tasksDir = v;
        } else if (a === "--mode") {
            const v = takeValue(true);
            if (v !== null) options.mode = v;
        } else if (a === "--release-version") {
            const v = takeValue(true);
            if (v !== null) options.releaseVersion = v;
        } else if (a === "--override-confirmed-version") {
            const v = takeValue(true);
            if (v !== null) options.overrideConfirmedVersion = v;
        } else if (a === "--help" || a === "-h") {
            process.stdout.write(
                "usage: check-defer-triggers.js [--mode promoter|release] [--since <ref>] [--tasks <dir>]\n" +
                "                                  [--release-version <vX.Y.Z>]\n" +
                "                                  [--override-confirmed-version <vX.Y.Z>]\n" +
                "  Predicate evaluator for DEFER/p2/follow-up candidates.\n" +
                "  Default (promoter) mode: human-readable report, never blocking, exit 0.\n" +
                "  --mode=release: strict JSON release evaluation; nonzero on blocker or\n" +
                "    evaluator-error. Reads the committed manifest at\n" +
                "    .vh-agent-harness/release-defer-dispositions.json ONLY (no .local/ access).\n" +
                "    --release-version binds the release being tagged.\n" +
                "    --override-confirmed-version is the operator-side wrapper confirmation\n" +
                "    signal: an override_required record is honored only when\n" +
                "    override.release_version == --release-version == --override-confirmed-version.\n" +
                "  Two failure classes: missing/malformed/stale manifest → evaluator-error\n" +
                "    (repair the committed manifest; override cannot cure it);\n" +
                "    release-relevant finding requires disposition → blocker (resolve OR\n" +
                "    use the override ceremony via the wrapper).\n",
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
// unrecognized shapes (caller reports unknown-predicate). PROMOTER-mode
// parser: lenient greedy match so `path_touched(a)||path_touched(b)` reports
// unknown-predicate rather than throwing. Release mode no longer parses
// task-card trigger grammar — it reads committed manifest dispositions only.
// The promoter remains on this lenient parser.
function parsePredicate(trigger) {
    const t = (trigger || "").trim();
    let m = t.match(/^path_touched\((.+)\)$/);
    if (m) return { kind: "path_touched", arg: m[1].trim() };
    m = t.match(/^after_tag\((.+)\)$/);
    if (m) return { kind: "after_tag", arg: m[1].trim() };
    return null;
}

// Evaluate one parsed predicate against the current repo state. Returns
// { met: bool, note: string }. Generic predicate evaluator; currently called only by the promoter path (via evaluateCandidate).
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
// parsed from the comma-separated inner text. PROMOTER-mode extractor: pairs
// with the lenient parsePredicate.
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

// Evaluate one candidate (PROMOTER mode). Returns a report object. `body` is
// the PARSED JSON task-card object (not the raw file text): task_id and
// owner_notes are read natively so DEFER/p2-followup cards (.json produced
// by /write-task) are honored. The Notes-prefix trigger grammar is fed
// UNMODIFIED to extractTriggers as the owner_notes[] text joined by newlines
// — the existing `^trigger:` regex + predicate parser are unchanged.
function evaluateCandidate(file, body, since, changedPaths) {
    const id = (body && typeof body.task_id === "string" && body.task_id)
        || path.basename(file, ".json");
    const notesText = (body && Array.isArray(body.owner_notes))
        ? body.owner_notes.join("\n")
        : "";
    const trig = extractTriggers(notesText);
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

// ---- Release-mode primitives (strict) -------------------------------------

// Lexicographic comparator for deterministic finding/ID ordering.
function lexCompare(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

// Emit the release-mode JSON envelope and exit with the classification's
// canonical exit code: clear/advisory → 0; blocker → 1; evaluator-error → 2.
function emitReleaseResult(payload) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    const code = payload.classification === "blocker" ? 1
        : payload.classification === "evaluator-error" ? 2 : 0;
    process.exit(code);
}

// ---- Release-mode manifest-authority primitives ----------------------------
//
// Release mode reads the committed manifest at <repoRoot>/.vh-agent-harness/
// release-defer-dispositions.json ONLY and performs NO .local/ access. The
// committed manifest is the release truth. This eliminates the fail-open defect
// where absent .local/ was treated as "clear" and could not protect fresh
// checkouts.
//
// The manifest carries the operator/promoter's attested disposition for each
// DEFER finding in the declared release arc. The evaluator verifies the
// freshness handshake (manifest commits only itself on top of the evaluated
// commit), validates schema v1, and applies the disposition matrix.

// Release manifest runtime path. This is the harness-conventional config dir
// (stable across installs — not a project domain literal), so it is safe to
// hardcode in templates/core/. The MANIFEST CONTENT is project-owned; the
// PATH is harness convention. Forward-slash form matches git diff output.
const RELEASE_MANIFEST_REL = ".vh-agent-harness/release-defer-dispositions.json";
const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
const RELEASE_RELEVANCE_VALUES = new Set(["yes", "no", "unknown"]);
const RELEASE_DISPOSITION_VALUES = new Set(["block", "disclose", "override_required"]);
const RELEASE_METADATA_VALUES = new Set(["valid", "stale", "invalid"]);

function releaseManifestAbsPath() {
    return path.join(repoRoot(), RELEASE_MANIFEST_REL);
}

// Full 40-char lowercase hex SHA validator.
function isFullSha(s) {
    return typeof s === "string" && /^[0-9a-f]{40}$/.test(s);
}

// Read the bytes of a path AS COMMITTED AT HEAD via `git show HEAD:<path>`.
// This is the manifest-authority contract: the bytes evaluated equal the bytes
// a fresh checkout (and CI) will see — NOT the worktree, which may carry
// uncommitted edits that would otherwise let a dirty edit flip a `block`
// record to `disclose+valid` while leaving the handshake SHAs intact. Returns
// the file content as a UTF-8 string, or null if git fails (typically because
// the path is not tracked at HEAD).
function gitShowHeadBlob(relPath) {
    try {
        return execFileSync(
            "git", ["show", `HEAD:${relPath}`],
            { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
    } catch (_) {
        return null;
    }
}

// Compute the git blob SHA of `HEAD:<relPath>` via `git rev-parse`. Returns the
// 40-char lowercase hex blob SHA the committed tree carries, or null on
// failure. The SHA is the override-binding token: it MUST be derived from the
// committed blob (what CI sees), NEVER from a `git hash-object` of the worktree
// path (which a dirty edit could swap out from under the ceremony).
function gitHeadBlobSha(relPath) {
    try {
        const sha = execFileSync(
            "git", ["rev-parse", `HEAD:${relPath}`],
            { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    } catch (_) {
        return null;
    }
}

// Resolve HEAD^ to a full commit SHA. Returns null if HEAD^ does not exist
// (single-commit repo) or git is unusable.
function gitHeadParent() {
    try {
        const sha = execFileSync(
            "git", ["rev-parse", "--verify", "--quiet", "HEAD^"],
            { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        return isFullSha(sha) ? sha : null;
    } catch (_) {
        return null;
    }
}

// Resolve HEAD^^{tree} to the tree SHA of HEAD^ (the evaluated commit P).
// NB: `HEAD^{tree}` would be the tree of HEAD itself (the manifest commit M);
// we need the tree of HEAD^ (P), so the ref is `HEAD^^{tree}` (parent of HEAD,
// peeled to its tree). Forward brace — argv form, no shell, so `^{}` is safe.
function gitHeadParentTree() {
    try {
        const sha = execFileSync(
            "git", ["rev-parse", "--verify", "--quiet", "HEAD^^{tree}"],
            { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        return isFullSha(sha) ? sha : null;
    } catch (_) {
        return null;
    }
}

// Sorted array of files changed in HEAD^..HEAD, or null on failure. Forward
// slashes (git's output convention) for cross-platform comparability.
function gitDiffHeadRange() {
    try {
        const out = execFileSync(
            "git", ["diff", "--name-only", "HEAD^..HEAD"],
            { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        return out.split("\n").map((l) => l.trim()).filter(Boolean).sort(lexCompare);
    } catch (_) {
        return null;
    }
}

// The most recent reachable tag, or null if none exists. Used to DERIVE the
// authoritative release_base.value (kind=tag) on read. The manifest's attested
// release_base.value is advisory; this derived value is authoritative.
//
// When `excludeVersion` is supplied (CI post-tag recheck forwards the just-cut
// release tag via --release-version), that exact version is excluded from the
// lookup so the function returns the PRIOR tag. The wrapper's pre-tag
// invocation also forwards --release-version, but the new tag does not exist
// yet at that point, so the exclusion is a no-op there and the bare describe
// path remains equivalent.
function gitLatestTag(excludeVersion) {
    try {
        if (excludeVersion) {
            // List tags REACHABLE from HEAD in descending version order and
            // return the first that is not the excluded version. The
            // `--merged HEAD` filter is the reachability guarantee: only tags
            // whose commits are ancestors of (or equal to) HEAD are listed.
            // Without it, a maintenance-branch release (e.g. v1.0.2 declaring
            // release_base v1.0.0) would incorrectly select an unrelated
            // higher mainline tag (v1.1.0 on main, unreachable from the
            // maintenance branch HEAD) and DERIVE the wrong release base.
            // `--sort=-v:refname` is version-aware so v0.10.0 > v0.9.0 as
            // expected. This handles both the linear CI post-tag case (the
            // just-cut release tag is now the most recent reachable tag and
            // release_base must resolve to the prior reachable release) and the
            // branched maintenance-release case.
            const out = execFileSync(
                "git", ["tag", "--merged", "HEAD", "--sort=-v:refname"],
                { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
            );
            for (const line of out.split("\n")) {
                const t = line.trim();
                if (t && t !== excludeVersion) {
                    return t;
                }
            }
            return null;
        }
        const tag = execFileSync(
            "git", ["describe", "--tags", "--abbrev=0"],
            { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        return tag || null;
    } catch (_) {
        return null;
    }
}

// Validate a manifest override object. Returns {ok:true} or {ok:false,error}.
function validateOverrideObject(o, idx) {
    const where = `records[${idx}].override`;
    if (!o || typeof o !== "object" || Array.isArray(o)) {
        return { ok: false, error: `${where} must be an object` };
    }
    if (typeof o.release_version !== "string" || !o.release_version) {
        return { ok: false, error: `${where}.release_version must be a non-empty string` };
    }
    if (typeof o.approved_by !== "string" || !o.approved_by) {
        return { ok: false, error: `${where}.approved_by must be a non-empty string` };
    }
    if (typeof o.approved_at !== "string" || !o.approved_at) {
        return { ok: false, error: `${where}.approved_at must be a non-empty string` };
    }
    if (typeof o.reason !== "string" || !o.reason) {
        return { ok: false, error: `${where}.reason must be a non-empty string` };
    }
    return { ok: true };
}

// Validate the parsed manifest object against schema v1. Returns {ok:true} or
// {ok:false,error:"..."}. Checks schema_version, release_base SHAPE (kind +
// well-formed value; the value is ADVISORY for kind=tag and is re-derived
// authoritatively later in mainRelease step 6), evaluated_*,
// manifest_parent_commit, reconciliation, per-record shape + enums + sort +
// duplicate IDs + empty-records rule.
function validateReleaseManifest(obj) {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        return { ok: false, error: "manifest root must be a JSON object" };
    }
    if (obj.schema_version !== RELEASE_MANIFEST_SCHEMA_VERSION) {
        return { ok: false, error: `unsupported schema_version: ${JSON.stringify(obj.schema_version)}` };
    }
    const rb = obj.release_base;
    if (!rb || typeof rb !== "object" || Array.isArray(rb)) {
        return { ok: false, error: "release_base must be an object" };
    }
    if (rb.kind !== "root" && rb.kind !== "tag") {
        return { ok: false, error: `release_base.kind must be root|tag; got ${JSON.stringify(rb.kind)}` };
    }
    if (rb.kind === "root") {
        if (rb.value !== null && rb.value !== undefined) {
            return { ok: false, error: "release_base.kind=root requires value null" };
        }
    } else {
        if (typeof rb.value !== "string" || !rb.value) {
            return { ok: false, error: "release_base.kind=tag requires non-empty string value" };
        }
    }
    if (!isFullSha(obj.evaluated_commit)) {
        return { ok: false, error: "evaluated_commit must be a 40-char lowercase hex SHA" };
    }
    if (!isFullSha(obj.evaluated_tree)) {
        return { ok: false, error: "evaluated_tree must be a 40-char lowercase hex SHA" };
    }
    if (!isFullSha(obj.manifest_parent_commit)) {
        return { ok: false, error: "manifest_parent_commit must be a 40-char lowercase hex SHA" };
    }
    const rec = obj.reconciliation;
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
        return { ok: false, error: "reconciliation must be an object" };
    }
    if (typeof rec.status !== "string" || !rec.status) {
        return { ok: false, error: "reconciliation.status must be a non-empty string" };
    }
    if (typeof rec.scope !== "string" || !rec.scope) {
        return { ok: false, error: "reconciliation.scope must be a non-empty string" };
    }
    if (typeof rec.zero_records_confirmed !== "boolean") {
        return { ok: false, error: "reconciliation.zero_records_confirmed must be boolean" };
    }
    if (!Array.isArray(obj.records)) {
        return { ok: false, error: "records must be an array" };
    }
    if (obj.records.length === 0 && !rec.zero_records_confirmed) {
        return { ok: false, error: "empty records require reconciliation.zero_records_confirmed=true" };
    }
    const seenIds = new Set();
    for (let i = 0; i < obj.records.length; i++) {
        const r = obj.records[i];
        const where = `records[${i}]`;
        if (!r || typeof r !== "object" || Array.isArray(r)) {
            return { ok: false, error: `${where} must be an object` };
        }
        if (typeof r.defer_id !== "string" || !r.defer_id) {
            return { ok: false, error: `${where}.defer_id must be a non-empty string` };
        }
        if (seenIds.has(r.defer_id)) {
            return { ok: false, error: `duplicate defer_id: ${r.defer_id}` };
        }
        seenIds.add(r.defer_id);
        if (!RELEASE_RELEVANCE_VALUES.has(r.release_relevance)) {
            return { ok: false, error: `${where}.release_relevance invalid: ${JSON.stringify(r.release_relevance)}` };
        }
        if (!RELEASE_DISPOSITION_VALUES.has(r.disposition)) {
            return { ok: false, error: `${where}.disposition invalid: ${JSON.stringify(r.disposition)}` };
        }
        if (!RELEASE_METADATA_VALUES.has(r.metadata_state)) {
            return { ok: false, error: `${where}.metadata_state invalid: ${JSON.stringify(r.metadata_state)}` };
        }
        if (typeof r.summary !== "string" || !r.summary) {
            return { ok: false, error: `${where}.summary must be a non-empty string` };
        }
        if (typeof r.reason !== "string" || !r.reason) {
            return { ok: false, error: `${where}.reason must be a non-empty string` };
        }
        if (typeof r.source_ref !== "string" || !r.source_ref) {
            return { ok: false, error: `${where}.source_ref must be a non-empty string (provenance text; never dereferenced)` };
        }
        if (typeof r.studied_at !== "string" || !r.studied_at) {
            return { ok: false, error: `${where}.studied_at must be a non-empty string` };
        }
        if (typeof r.reviewed_at !== "string" || !r.reviewed_at) {
            return { ok: false, error: `${where}.reviewed_at must be a non-empty string` };
        }
        if (r.override !== null && r.override !== undefined) {
            const ov = validateOverrideObject(r.override, i);
            if (!ov.ok) return ov;
        }
    }
    // Sort check: records must already be in lexical order by defer_id. This
    // forces deterministic authoring and prevents reorderings from masking a
    // duplicate or a sneaked-in record.
    const ids = obj.records.map((r) => r.defer_id);
    const sorted = ids.slice().sort(lexCompare);
    for (let i = 0; i < ids.length; i++) {
        if (ids[i] !== sorted[i]) {
            return { ok: false, error: `records not sorted lexically by defer_id at index ${i}: ${ids[i]} before ${sorted[i]}` };
        }
    }
    return { ok: true };
}

// Apply the disposition matrix to one record. Returns:
//   { result: "allow", disclose: true, overrideAccepted?: true, why: "..." }
//   { result: "refuse", why: "..." }
// `releaseVersion` is the version being released (from --release-version).
// `overrideConfirmedVersion` is the operator-side wrapper confirmation
// (--override-confirmed-version). Override verification is split into two
// layers so the SAME evaluator serves both the pre-tag wrapper invocation
// and the post-tag CI recheck:
//   - Layer A (object validity): override object is present and well-formed,
//     override.release_version matches releaseVersion. Verifiable from the
//     committed manifest alone. Both the wrapper and CI verify this layer.
//   - Layer B (operator live intent): when --override-confirmed-version IS
//     supplied (wrapper mode), it MUST equal releaseVersion exactly. When it
//     is NOT supplied (CI defense-in-depth recheck), Layer A alone is
//     sufficient — the committed override object IS the attestation at that
//     point, and the wrapper already enforced Layer B before forwarding the
//     flag. The wrapper adds a post-evaluator gate so that an override
//     accepted by Layer A still refuses at tag time when the operator did not
//     supply the ceremony flags (--override-release-version +
//     --override-manifest-sha). This keeps wrapper enforcement whole without
//     weakening CI's verification role.
function applyDisposition(record, releaseVersion, overrideConfirmedVersion) {
    const rel = record.release_relevance;
    const disp = record.disposition;
    const meta = record.metadata_state;
    const override = record.override;
    if (rel === "yes") {
        if (disp === "block") {
            return { result: "refuse", why: "release_relevance=yes disposition=block: hard block; override cannot cure" };
        }
        if (disp === "disclose") {
            if (meta === "valid") {
                return { result: "allow", disclose: true, why: "release_relevance=yes disposition=disclose metadata_state=valid: disclosed" };
            }
            return { result: "refuse", why: `release_relevance=yes disposition=disclose requires metadata_state=valid; got ${meta}` };
        }
        if (disp === "override_required") {
            // Layer A (object validity) — both wrapper and CI verify.
            if (!override) {
                return { result: "refuse", why: "disposition=override_required but override object is absent" };
            }
            if (!releaseVersion) {
                return { result: "refuse", why: `override_required record requires --release-version; override declares ${override.release_version}` };
            }
            if (override.release_version !== releaseVersion) {
                return { result: "refuse", why: `override.release_version=${override.release_version} != release_version=${releaseVersion}` };
            }
            // Layer B (operator live intent) — wrapper mode only. When the
            // flag is supplied, it must match exactly. When absent (CI mode),
            // Layer A alone is sufficient; the wrapper's post-evaluator gate
            // enforces ceremony at tag time.
            if (overrideConfirmedVersion && overrideConfirmedVersion !== releaseVersion) {
                return { result: "refuse", why: `override-confirmed-version=${overrideConfirmedVersion} != release_version=${releaseVersion}` };
            }
            return {
                result: "allow", disclose: true, overrideAccepted: true,
                why: `override accepted for release ${releaseVersion} (approved_by=${override.approved_by})`,
            };
        }
        return { result: "refuse", why: `unhandled disposition for release_relevance=yes: ${disp}` };
    }
    if (rel === "no") {
        if (disp === "disclose") {
            return { result: "allow", disclose: true, why: `release_relevance=no disposition=disclose metadata_state=${meta}: disclosed as non-release-relevant` };
        }
        return { result: "refuse", why: `policy error: release_relevance=no is incompatible with disposition=${disp} (use disclose)` };
    }
    // rel === "unknown"
    return { result: "refuse", why: "release_relevance=unknown must be resolved to yes|no before release" };
}

// Emit the manifest-authority release envelope and exit. clear|disclose → 0;
// blocker → 1; evaluator-error → 2. emitReleaseResult already maps
// disclose → 0.

// RELEASE-mode entrypoint (manifest authority — the sole release mode).
// Strict schema-v1 + handshake + matrix.
function mainRelease(options) {
    const manifestPath = releaseManifestAbsPath();
    const releaseVersion = options.releaseVersion || null;
    const overrideConfirmedVersion = options.overrideConfirmedVersion || null;

    const envelope = {
        mode: "release",
        manifest_authority: true,
        manifest_path: manifestPath,
        manifest_sha: null,
        release_version: releaseVersion,
        override_confirmed_version: overrideConfirmedVersion,
        release_base: null,
        evaluated_commit: null,
        evaluated_tree: null,
        manifest_parent_commit: null,
        head_parent: null,
        head_parent_tree: null,
        reconciliation: null,
        records: [],
        disclosures: [],
        accepted_overrides: [],
        refusals: [],
        blocking_ids: [],
        disclose_ids: [],
        evaluator_error_ids: [],
        advisories: [],
        classification: "evaluator-error",
        error: null,
    };

    // 1. Read manifest bytes FROM THE COMMITTED HEAD BLOB (never the worktree).
    //
    // This is the manifest-authority contract: the bytes evaluated MUST equal
    // the bytes a fresh checkout (and CI) will see. Reading the worktree file
    // would let a dirty edit flip a committed `block` record to
    // `disclose+valid` while leaving the handshake SHAs intact — the wrapper's
    // subsequent HEAD^..HEAD path-list check would still pass (the manifest
    // path is unchanged), but the bytes evaluated would not be the bytes
    // committed at HEAD. Reading from `HEAD:<path>` makes that bypass
    // impossible: the evaluator and CI see the same bytes by construction.
    //
    // `manifestPath` is still computed (above) for the envelope's
    // `manifest_path` field, but the bytes themselves come from git, not fs.
    const raw = gitShowHeadBlob(RELEASE_MANIFEST_REL);
    if (raw === null) {
        envelope.error = `release manifest missing from HEAD: ${RELEASE_MANIFEST_REL} (must be committed, not just on worktree)`;
        emitReleaseResult(envelope);
        return;
    }

    // 2. Parse JSON.
    let obj;
    try {
        obj = JSON.parse(raw);
    } catch (e) {
        envelope.error = `release manifest malformed JSON: ${(e && e.message) || "parse error"}`;
        emitReleaseResult(envelope);
        return;
    }

    // 3. Manifest blob SHA FROM THE SAME COMMITTED BLOB (override binding +
    // echo). Computed via `git rev-parse HEAD:<path>` so it equals what CI
    // will also see — a dirty worktree cannot swap this SHA under the
    // override ceremony.
    envelope.manifest_sha = gitHeadBlobSha(RELEASE_MANIFEST_REL);
    if (!envelope.manifest_sha) {
        envelope.error = `release manifest unreadable from HEAD: ${RELEASE_MANIFEST_REL} (git rev-parse HEAD:<path> failed)`;
        emitReleaseResult(envelope);
        return;
    }

    // 4. Schema validation (v1; enums; sort; duplicates; per-record shape).
    const v = validateReleaseManifest(obj);
    if (!v.ok) {
        envelope.error = `manifest schema invalid: ${v.error}`;
        emitReleaseResult(envelope);
        return;
    }
    envelope.release_base = obj.release_base;
    envelope.evaluated_commit = obj.evaluated_commit;
    envelope.evaluated_tree = obj.evaluated_tree;
    envelope.manifest_parent_commit = obj.manifest_parent_commit;
    envelope.reconciliation = obj.reconciliation;
    envelope.records = obj.records;

    // 5. Freshness handshake (sacred — do not weaken).
    const headParent = gitHeadParent();
    const headParentTree = gitHeadParentTree();
    envelope.head_parent = headParent;
    envelope.head_parent_tree = headParentTree;
    if (!headParent || !headParentTree) {
        envelope.error = "handshake failed: HEAD^ does not exist (need at least 2 commits)";
        emitReleaseResult(envelope);
        return;
    }
    if (obj.evaluated_commit !== headParent) {
        envelope.error = `handshake failed: evaluated_commit=${obj.evaluated_commit} != HEAD^=${headParent}`;
        emitReleaseResult(envelope);
        return;
    }
    if (obj.manifest_parent_commit !== headParent) {
        envelope.error = `handshake failed: manifest_parent_commit=${obj.manifest_parent_commit} != HEAD^=${headParent}`;
        emitReleaseResult(envelope);
        return;
    }
    if (obj.evaluated_tree !== headParentTree) {
        envelope.error = `handshake failed: evaluated_tree=${obj.evaluated_tree} != tree(HEAD^)=${headParentTree}`;
        emitReleaseResult(envelope);
        return;
    }
    const diff = gitDiffHeadRange();
    if (diff === null) {
        envelope.error = "handshake failed: cannot compute HEAD^..HEAD diff";
        emitReleaseResult(envelope);
        return;
    }
    if (diff.length !== 1 || diff[0] !== RELEASE_MANIFEST_REL) {
        envelope.error = `handshake failed: HEAD^..HEAD must change only the manifest (${RELEASE_MANIFEST_REL}); got [${diff.join(", ")}]`;
        emitReleaseResult(envelope);
        return;
    }

    // 6. Release base: DERIVE-ON-READ (authoritative). release_base.value (when
    //    kind=tag) is the last reachable tag — a mechanically-derivable fact the
    //    evaluator already computes — so the DERIVED value is authoritative and
    //    the manifest's attested value is ADVISORY. If the attested value
    //    disagrees with the derived value, a non-fatal advisory is recorded (so
    //    the operator can refresh the cosmetic field) but the release is NOT
    //    blocked: the field can never go stale in a load-bearing way and
    //    self-heals the current stale state with NO manifest write. kind
    //    (root|tag) stays operator-attested (a genuine first-release vs
    //    incremental-arc judgment); for kind=root no value is derived (whole
    //    history is in scope regardless). This preserves INVARIANT #2 (the
    //    evaluator is read-only — it writes nothing).
    const advisories = [];
    if (obj.release_base.kind === "tag") {
        // When --release-version is supplied (CI post-tag recheck), exclude
        // the just-cut release tag from the lookup so release_base resolves to
        // the PRIOR tag. Pre-tag wrapper invocations also forward
        // --release-version, but the new tag does not exist yet so the
        // exclusion is a no-op there.
        const derived = gitLatestTag(releaseVersion);
        if (derived === null) {
            // kind=tag declares a prior-tag release, but no tag is reachable
            // from HEAD (after excluding the release version). That is a
            // genuine malformed-manifest state (a tag release with no prior
            // tag), NOT a stale value — fail closed.
            envelope.error = `release_base kind=tag but no prior tag reachable from HEAD (release_version=${releaseVersion || "<none>"}); a tag release requires a discoverable prior tag`;
            emitReleaseResult(envelope);
            return;
        }
        // The DERIVED value is authoritative; echo it in the envelope so
        // consumers see the truth, not the (possibly stale) attested field.
        envelope.release_base = { kind: "tag", value: derived };
        if (derived !== obj.release_base.value) {
            advisories.push({
                field: "release_base.value",
                severity: "advisory",
                attested: obj.release_base.value,
                derived: derived,
                note: "attested release_base.value is stale; evaluator derived the authoritative prior tag from git on read. The field is advisory (cannot block release); refresh it for cleanliness.",
            });
        }
    }
    envelope.advisories = advisories;
    // kind=root: first release. Whole history is in scope; the manifest attests
    // relevance for that whole-history arc. No HEAD~32 fallback in manifest mode.

    // 7. Disposition matrix per record.
    const disclosures = [];
    const acceptedOverrides = [];
    const refusals = [];
    for (const record of obj.records) {
        const r = applyDisposition(record, releaseVersion, overrideConfirmedVersion);
        if (r.result === "allow" && r.disclose) {
            disclosures.push({
                defer_id: record.defer_id,
                release_relevance: record.release_relevance,
                disposition: record.disposition,
                metadata_state: record.metadata_state,
                summary: record.summary,
                reason: record.reason,
                source_ref: record.source_ref,
                override: record.override || null,
                why: r.why,
            });
            if (r.overrideAccepted) {
                const o = record.override;
                acceptedOverrides.push({
                    defer_id: record.defer_id,
                    release_version: o.release_version,
                    approved_by: o.approved_by,
                    approved_at: o.approved_at,
                    reason: o.reason,
                });
            }
        } else if (r.result === "refuse") {
            refusals.push({ defer_id: record.defer_id, why: r.why });
        }
    }
    envelope.disclosures = disclosures;
    envelope.accepted_overrides = acceptedOverrides;
    envelope.refusals = refusals;

    // 8. Aggregate classification.
    // Records-driven refusals → blocker (manifest is well-formed; release is
    // blocked pending resolution or override). Schema/handshake problems were
    // caught above and already returned as evaluator-error.
    if (refusals.length > 0) {
        envelope.classification = "blocker";
        envelope.blocking_ids = refusals.map((r) => r.defer_id).sort(lexCompare);
        envelope.disclose_ids = disclosures.map((d) => d.defer_id).sort(lexCompare);
        // Include each refusal's `why` so the operator can see exactly which
        // check failed (override confirmation missing, version mismatch, etc.)
        // without having to drill into refusals[].
        const detail = refusals
            .slice()
            .sort((a, b) => lexCompare(a.defer_id, b.defer_id))
            .map((r) => `${r.defer_id}: ${r.why}`)
            .join("; ");
        envelope.error = `${refusals.length} blocking release-defer record(s): ${detail}`;
    } else if (disclosures.length > 0) {
        envelope.classification = "disclose";
        envelope.disclose_ids = disclosures.map((d) => d.defer_id).sort(lexCompare);
        envelope.error = null;
    } else {
        envelope.classification = "clear";
        envelope.error = null;
    }

    emitReleaseResult(envelope);
}

// ---- Promoter-mode entrypoint (UNCHANGED behavior) -----------------------

function mainPromoter(options) {
    const tasksDir = options.tasksDir ? path.resolve(options.tasksDir) : defaultTasksDir();
    const since = resolveSince(options);

    let files = [];
    try {
        files = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith(".json"))
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
        let body = null;
        try {
            const raw = fs.readFileSync(f, "utf8");
            body = JSON.parse(raw);
        } catch (_) {
            body = null;
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

// Dispatcher: --mode=release routes to the strict JSON evaluator; anything
// else (null, "promoter", or a typo) routes to the lenient human-readable
// promoter mode. An unknown --mode value is treated as promoter with a stderr
// note (NEVER as release — release semantics must be opt-in).
function main() {
    const options = parseArgs(process.argv);
    if (options.mode === "release") {
        mainRelease(options);
        return;
    }
    if (options.mode !== null && options.mode !== "promoter") {
        process.stderr.write(
            `check-defer-triggers: unknown --mode '${options.mode}', falling back to promoter mode.\n`,
        );
    }
    mainPromoter(options);
}

main();
