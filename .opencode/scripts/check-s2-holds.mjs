// check-s2-holds.mjs — deterministic S2-hold evaluator for the release-tag
// wrapper's G6 gate. ONE MODE: release (fail-closed, structured JSON).
//
// Reads COMMITTED state ONLY (never the worktree), bound to a specific revision
// (HEAD_SHA when invoked by the wrapper). Derives G6 itself from two committed
// primary surfaces joined by a STABLE HOLD ID:
//
//   BACKLOG ROW (the hold)    docs/planning/backlog.md (active, ALL sections)
//                             + docs/planning/archive/backlog-archive-*.md.
//                             Notes column carries `s2-hold: S2-<skill>-001`.
//                             Links column carries the evidence-packet path
//                             (repo-relative researches/sources/<file>.md).
//
//   EVIDENCE RECORD (verdict) researches/sources/*.md.
//                             `### S2 hold: S2-<skill>-001` heading +
//                             `- Verdict: PENDING | SATISFIED | WITHDRAWN`
//                             `- Skill: <skill-slug>`  (must equal the <skill>
//                                                       encoded in the hold ID)
//                             `- Pilot: <repo> (retrospective)` ← or (forward)
//
// The wrapper DERIVES G6 from committed primary state; the readiness agent's
// G6 model verdict is NOT consumed (model output is never transition
// authority). This mirrors the G7 two-tier model (check-defer-triggers.mjs):
// the same surface contract is consumed ADVISORY by the readiness agent and
// AUTHORITATIVELY here.
//
// Classification (top-level): clear | blocker | evaluator-error
//   clear            — no holds, or every hold resolved
//                      (done+SATISFIED, or cancelled+WITHDRAWN).
//   blocker          — structurally VALID inputs, legitimate no-release:
//                      a PENDING hold, or a valid-join verdict disagreement
//                      (the two surfaces disagree on resolution state).
//                      Remedy: resolve the hold. NO override cures this.
//   evaluator-error  — structurally INVALID inputs: evidence missing/
//                      malformed/duplicate/unreadable; backlog token
//                      malformed; unknown verdict; join ambiguous (zero/>1);
//                      cancelled+s2-hold unresolved; SATISFIED missing
//                      required fields. Remedy: REPAIR records; NO override
//                      cures this.
//
// Exit codes: 0 clear, 1 blocker, 2 evaluator-error. Both nonzero force
// ready:no and refuse `git tag -a` BEFORE the mutation. The wrapper
// cross-checks exit + classification.
//
// Determinism: outputs are sorted; hold IDs are case-sensitive; reads HEAD:
// only so worktree changes cannot affect the verdict.
//
// Git is invoked via spawnSync with a FILE-BACKED stdout descriptor and an
// all-ignore status variant (mirrors check-defer-triggers.mjs) so the
// evaluator runs under the strict exec sandbox's NetDeny filter — libuv's
// pipe-based stdio uses socketpair(AF_UNIX), which NetDeny blocks; a numeric
// regular-file FD is inherited via dup2 with no pipe allocation.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GIT = "git";

// ESM has no global __dirname; derive it from import.meta.url so repoRoot()
// is cwd-robust when node is spawned by the opencode plugin server / Go
// bridge with an explicit cwd.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// repoRoot() is inlined (zero-dep, mirrors state-lib.js) so this evaluator
// stays self-contained and does not couple to a larger module for one helper.
function repoRoot() {
    return path.resolve(__dirname, "..", "..");
}

// Git subprocess env. See check-defer-triggers.mjs for the full rationale:
// under the strict sandbox $HOME is outside the read profile, so git probes
// several config files outside the profile and fatals. GIT_CONFIG_COUNT/KEY/
// VALUE overrides the three $HOME-rooted config paths to /dev/null (readable,
// empty) WITHOUT changing the read operations' results (ls-tree/show are
// config-independent). Scoped to the git subprocess only.
export function gitEnv() {
    return {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "core.excludesFile",
        GIT_CONFIG_VALUE_0: "/dev/null",
        GIT_CONFIG_KEY_1: "core.attributesFile",
        GIT_CONFIG_VALUE_1: "/dev/null",
    };
}

// Allocate a uniquely-named EXCLUSIVE capture directory under <root>/tmp (the
// sole writable path in the sandbox DefaultProfile). The EXCLUSIVE mkdir
// (recursive:false) is the real collision/symlink defense; randomUUID alone
// is not. `root` localizes the capture base to the repo being evaluated so a
// direct unit-test import — evaluate(scratchRoot) → gitCapture(args, scratchRoot)
// → allocCaptureDir(scratchRoot) — writes capture dirs under the SCRATCH repo's
// tmp/ instead of spilling into the real repo's tmp/ (the production CLI path
// and the test-path both pass cwd through gitCapture). Defaults to repoRoot()
// for the standalone CLI path (behavior-preserving). Exported for unit testing.
export function allocCaptureDir(root) {
    const base = path.join(root || repoRoot(), "tmp");
    fs.mkdirSync(base, { recursive: true });
    for (let attempt = 0; attempt < 8; attempt++) {
        const dir = path.join(base, `s2-git-${process.pid}-${randomUUID()}`);
        try {
            fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
            return dir;
        } catch (e) {
            if (e.code !== "EEXIST") throw e;
        }
    }
    throw new Error("gitCapture: could not allocate exclusive capture dir after retries");
}

function rmCaptureDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
}

// Capture git's RAW UNTRIMMED stdout via a regular-file descriptor. spawnSync
// with stdio:["ignore", fd, "ignore"] passes the numeric FD to the git child
// via dup2 — NO pipe/socketpair is allocated, so this works under the strict
// sandbox's NetDeny filter. THROWS on a nonzero git exit or spawn-level error.
// Exported for unit testing.
export function gitCapture(args, cwd) {
    const dir = allocCaptureDir(cwd);
    const capFile = path.join(dir, "out");
    let fd;
    try {
        fd = fs.openSync(capFile, "w");
        const r = spawnSync(GIT, args, { cwd, stdio: ["ignore", fd, "ignore"], env: gitEnv() });
        if (r.error) throw r.error;
        if (r.status !== 0) {
            const e = new Error(`git ${args.join(" ")} exited ${r.status}`);
            e.code = "GIT_NONZERO";
            e.status = r.status;
            throw e;
        }
        fs.closeSync(fd);
        fd = undefined;
        return fs.readFileSync(capFile, "utf8");
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* best-effort */ } }
        rmCaptureDir(dir);
    }
}

// Read a committed blob at a given revision. Returns the UTF-8 string, or null
// if the path does not exist at that revision (a missing backlog / evidence
// tree simply holds no holds → classification clear; it is NOT an
// evaluator-error). `rev` binds the read to a specific commit so the wrapper
// can pin G6 to the exact commit it will tag (HEAD_SHA), eliminating the
// moving-HEAD race. Defaults to "HEAD" for standalone use.
function gitShowHeadBlob(relPath, rev, cwd) {
    try {
        return gitCapture(["show", `${rev}:${relPath}`], cwd);
    } catch (_) {
        return null;
    }
}

// Enumerate committed files under a directory at a revision, filtered by
// basename regex (archive pattern or .md extension).
function gitListTree(dir, nameRe, rev, cwd) {
    let out;
    try {
        out = gitCapture(["ls-tree", "-r", "--name-only", rev, dir], cwd);
    } catch (_) {
        return [];
    }
    return out.split("\n").map((s) => s.trim()).filter(Boolean).filter((f) => nameRe.test(path.basename(f)));
}

// --- hold-ID + record grammar ----------------------------------------------

// Stable hold ID shape: S2-<skill-slug>-<NNN>. <skill-slug> is lowercase
// [a-z0-9-]+ starting with a letter; NNN is exactly three digits. Declared as
// documentation of the canonical shape; the two enforcement regexes below
// carry the boundary anchors.
const HOLD_ID_SHAPE = "S2-<slug>-NNN";
// Token in a backlog Notes cell. CASE-SENSITIVE (`s2-hold:` lowercase prefix,
// ID capital S2) — see the determinism contract. The trailing `(?![A-Za-z0-9-])`
// boundary is load-bearing: without it, `s2-hold: S2-cleared-001junk` would
// match as the valid ID `S2-cleared-001` (truncating the suffix) and could
// resolve to a false clear. A Notes cell that contains `s2-hold:` but whose ID
// does not match this shape (boundary-inclusive) is a malformed token.
const HOLD_TOKEN_RE = /s2-hold:\s*(S2-[a-z][a-z0-9-]*-[0-9]{3})(?![A-Za-z0-9-])/;
// Evidence record heading discovery anchor (heading-level parser key). The
// trailing `\s*$` is the equivalent boundary for the heading form.
const EVIDENCE_HEADING_RE = /^###\s+S2 hold:\s+(S2-[a-z][a-z0-9-]*-[0-9]{3})\s*$/;
// LINE-LEVEL evidence discovery helpers: a line that STARTS like an S2-hold
// heading but is not canonical (EVIDENCE_HEADING_RE) is a malformed heading
// that must fail closed, not be silently skipped. START matches the heading
// prefix (any trailing, including empty/garbage); LOOSE_ID captures a valid ID
// prefix plus any trailing content so a suffixed heading can be attributed to
// its attempted hold ID (and participate in the per-ID conflict check).
const EVIDENCE_HEADING_START_RE = /^###\s+S2 hold:/;
const EVIDENCE_HEADING_LOOSE_ID_RE = /^###\s+S2 hold:\s+(S2-[a-z][a-z0-9-]*-[0-9]{3})(.*)$/;
// Fenced-code-block tracking (CommonMark semantics). extractEvidenceRecords
// tracks open/close state so a ``` quoted EXAMPLE record (heading + fields)
// inside a cited packet is NOT parsed as real evidence — otherwise an author
// quoting a contradictory PENDING record inside a fence alongside a real
// SATISFIED record could construct a spurious evaluator-error (fail-closed
// NOISE, not a release-safety bypass). This is robustness; it does NOT relax
// the fail-closed discipline (real records outside a fence parse unchanged).
//
// Closing-fence rules (per CommonMark): a closing fence line carries NO info
// string and its backtick run is at least as long as the opening run. So a
// ```js info-string line does NOT close a fence (it is content), and a
// 3-backtick line does not close a 4-backtick fence. Honoring these prevents
// a malformed "close" from silently re-entering normal parsing and swallowing a
// subsequent real record (a fail-closed->clear regression the EOF guard, which
// only fires when inFence is still true, would not catch).
//
// Opening-fence rule (per CommonMark §4.5): a BACKTICK fence's info string may
// NOT contain any backtick characters. So a line like "``` ```" (3 backticks,
// space, 3 backticks) is NOT a valid opener — it is paragraph text. Without
// this rule the parser would open a fence on it, swallow a subsequent real
// PENDING record, then close cleanly on a trailing bare "```" -> false clear.
// Restricting the info string to [^`] (no backticks) keeps the malformed line
// in normal parsing so the real second record surfaces -> duplicate/conflict
// -> fail-closed evaluator-error.
function updateFenceState(line, state) {
    if (!state.inFence) {
        const open = line.match(/^\s{0,3}(`{3,})([^`]*)$/);
        if (open) return { inFence: true, fenceLen: open[1].length };
        return state;
    }
    const close = line.match(/^\s{0,3}(`{3,})[\t ]*$/);
    if (close && close[1].length >= state.fenceLen) {
        return { inFence: false, fenceLen: 0 };
    }
    return state;
}
// Verdict field (closed enum).
const VERDICT_RE = /^-\s*Verdict:\s*(PENDING|SATISFIED|WITHDRAWN)\s*$/;
const SKILL_RE = /^-\s*Skill:\s*(.+?)\s*$/;
const PILOT_RE = /^-\s*Pilot:\s*(.+?)\s*$/;
const PILOT_SHAPE_RE = /^.+\s+\((retrospective|forward)\)$/;
// Evidence-packet path in a backlog Links cell (repo-relative).
const LINKS_PATH_RE = /researches\/sources\/[^\s)|]+\.md/;
const VERDICT_SET = new Set(["PENDING", "SATISFIED", "WITHDRAWN"]);

const ACTIVE_STATUSES = new Set(["todo", "in_progress", "blocked"]);
const RESOLVED_STATUSES = new Set(["done"]);
const CANCELLED_STATUSES = new Set(["cancelled"]);
const ARCHIVE_FILE_RE = /^backlog-archive-(?:\d{4}-q[1-4]|undated)\.md$/;

const ACTIVE_BACKLOG = "docs/planning/backlog.md";
const ARCHIVE_DIR = "docs/planning/archive";
const EVIDENCE_DIR = "researches/sources";

// --- backlog row parsing ----------------------------------------------------

// Split a markdown table row on UNESCAPED "|" only, then unescape "\|" → "|"
// in each cell. Mirrors normalize-backlog.js's splitMarkdownRow +
// unescapeTableCell exactly: the canonical backlog format REQUIRES in-cell
// pipes to be written as the escape "\|", so a naive split("|") misaligns
// columns whenever a Notes/Links cell carries an escaped pipe (e.g. a quoted
// command `grep a\|b`). An escape-aware split is load-bearing — without it, a
// held row whose Notes cell precedes the token with an escaped pipe would be
// silently skipped and its committed evidence orphaned → false clear.
function splitRowEscapeAware(line) {
    const cells = [];
    let current = "";
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        const prev = i > 0 ? line[i - 1] : "";
        if (ch === "|" && prev !== "\\") {
            cells.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    cells.push(current);
    return cells.map((c) => c.replace(/\\\|/g, "|").trim());
}

// Parse a markdown table data row into 7 cells (ID..Links) or null if the line
// is not a valid 7-cell data row. Mirrors the backlog column layout
// (TABLE_HEADER in normalize-backlog.js): ID | Status | Area | Task | Owner |
// Notes | Links.
export function parseBacklogRow(line) {
    if (typeof line !== "string") return null;
    if (!line.includes("|")) return null;
    const cells = splitRowEscapeAware(line);
    // Expect: ["", c1..c7, ""] → length 9 for a full row (the wrapping pipes
    // produce empty leading/trailing entries). Require >= 9 so all 7 cells
    // exist; a short row is not a valid data row.
    if (cells.length < 9) return null;
    const data = cells.slice(1, 8);
    const id = data[0];
    if (!id) return null;
    if (id === "ID") return null; // header row
    if (/^-+$/.test(id)) return null; // divider row
    return data; // [ID, Status, Area, Task, Owner, Notes, Links]
}

// Extract backlog holds from a backlog file blob. Hold discovery is LINE-LEVEL
// (the raw line must carry `s2-hold:`) with a Notes-cell consistency check:
// if the token is present in the line but NOT in the parsed Notes cell (column
// misalignment from any source) the row is a tokenError, NEVER a silent skip.
// This closes the whole "bury a hold by misaligning its row" bypass family —
// a committed PENDING hold cannot be made invisible. Returns holds[] +
// tokenErrors[].
export function extractBacklogHolds(blob, file) {
    const holds = [];
    const tokenErrors = [];
    const lines = blob.split("\n");
    lines.forEach((line, idx) => {
        // LINE-LEVEL discovery: detect the token anywhere in the raw line, so
        // the row is never silently skipped just because column parsing
        // shifted the token out of the Notes cell.
        const lineTokenCount = (line.match(/s2-hold:/g) || []).length;
        if (lineTokenCount === 0) return; // not a held line
        const cells = parseBacklogRow(line);
        if (!cells) {
            tokenErrors.push({
                id: null,
                file,
                line: idx + 1,
                reason: `raw line carries an s2-hold: token but the row did not parse to a 7-cell backlog row (column structure malformed)`,
            });
            return;
        }
        const notes = cells[5];
        // RECONCILIATION: every line-level token MUST land in the Notes cell. A
        // token in another column (Task/Area/Owner/Links) would be invisible to
        // the Notes-scoped extraction, burying a hold → false clear. Count
        // tokens in the line vs in Notes and fail closed on any mismatch
        // (covers both "token outside Notes" and column misalignment).
        const notesTokenCount = (notes.match(/s2-hold:/g) || []).length;
        if (notesTokenCount !== lineTokenCount) {
            tokenErrors.push({
                id: null,
                file,
                line: idx + 1,
                reason: `s2-hold token(s) present outside the Notes cell (line has ${lineTokenCount}, Notes has ${notesTokenCount}); a held row must keep ALL its tokens in the Notes column`,
            });
            return;
        }
        // All tokens are in Notes. A single backlog row must carry EXACTLY ONE
        // s2-hold: token — two would let the (non-global) HOLD_TOKEN_RE match
        // only the first, burying the second.
        if (notesTokenCount > 1) {
            tokenErrors.push({
                id: null,
                file,
                line: idx + 1,
                reason: `backlog row has ${notesTokenCount} s2-hold tokens in its Notes cell (expected exactly one); a row may hold at most one skill`,
            });
            return;
        }
        const m = notes.match(HOLD_TOKEN_RE);
        if (!m) {
            tokenErrors.push({ id: null, file, line: idx + 1, reason: `malformed s2-hold token in Notes (expected shape S2-<skill>-NNN): ${notes.slice(0, 80)}` });
            return;
        }
        holds.push({
            id: m[1],
            status: cells[1],
            file,
            line: idx + 1,
            evidence_path: (cells[6].match(LINKS_PATH_RE) || [""])[0],
        });
    });
    return { holds, tokenErrors };
}

// --- evidence record parsing ------------------------------------------------

// Extract evidence records from a packet blob. Returns records[] (structurally
// valid) + errors[] (heading present but structurally bad: duplicate fields,
// missing/unknown Verdict, missing Skill, Skill not matching the held skill
// derived from the ID, SATISFIED missing/malformed Pilot, malformed Pilot).
export function extractEvidenceRecords(blob, file) {
    const records = [];
    const errors = [];
    const lines = blob.split("\n");
    let i = 0;
    // Fenced-code-block toggle, tracked across the WHOLE scan (main discovery
    // loop + record-body loop) so a ``` quoted example record is never parsed
    // as real evidence. A fenced heading is NOT recognized (no cascade); a
    // fenced field-like line does NOT count and does NOT break the open record.
    // Real records outside a fence parse unchanged — this is robustness against
    // fail-closed NOISE, NOT a relaxation of the fail-closed discipline.
    let inFence = false;
    let fenceLen = 0;
    while (i < lines.length) {
        const wasInFence = inFence;
        const st = updateFenceState(lines[i], { inFence, fenceLen });
        inFence = st.inFence;
        fenceLen = st.fenceLen;
        if (inFence !== wasInFence || inFence) {
            i += 1;
            continue; // fence delimiter line, or content inside an open fence
        }
        const hm = lines[i].match(EVIDENCE_HEADING_RE);
        if (!hm) {
            // LINE-LEVEL evidence discovery: a line that STARTS like an S2-hold
            // heading but is NOT canonical must NOT be silently skipped — a
            // suffixed heading (e.g. "### S2 hold: S2-x-001 extra") would
            // otherwise hide a committed PENDING record and let a valid
            // SATISFIED record for the same ID clear. Emit a malformed entry
            // keyed by the attempted ID so it participates in the join's
            // single-record conflict check.
            const loose = lines[i].match(EVIDENCE_HEADING_LOOSE_ID_RE);
            if (loose) {
                errors.push({
                    id: loose[1],
                    file,
                    line: i + 1,
                    reason: `malformed evidence heading for ${loose[1]}: trailing content after the hold ID (${JSON.stringify(loose[2].trim())}); expected "### S2 hold: ${loose[1]}" with nothing trailing`,
                });
            } else if (EVIDENCE_HEADING_START_RE.test(lines[i])) {
                errors.push({
                    id: null,
                    file,
                    line: i + 1,
                    reason: `malformed evidence heading (no valid S2-<skill>-NNN hold ID): ${lines[i].slice(0, 80)}`,
                });
            }
            i += 1;
            continue;
        }
        const id = hm[1];
        const headingLine = i + 1;
        let verdict = null;
        let skill = null;
        let pilot = null;
        let verdictCount = 0;
        let skillCount = 0;
        let pilotCount = 0;
        let j = i + 1;
        while (j < lines.length) {
            const ln = lines[j];
            const wasInFence = inFence;
            const st = updateFenceState(ln, { inFence, fenceLen });
            inFence = st.inFence;
            fenceLen = st.fenceLen;
            if (inFence !== wasInFence || inFence) {
                j += 1;
                continue; // fence delimiter, or content inside an open fence
            }
            if (/^#{1,6}\s/.test(ln)) break; // next heading ends the record
            const v = ln.match(VERDICT_RE);
            if (v) { verdictCount += 1; verdict = v[1]; }
            const sk = ln.match(SKILL_RE);
            if (sk) { skillCount += 1; skill = sk[1]; }
            const pl = ln.match(PILOT_RE);
            if (pl) { pilotCount += 1; pilot = pl[1]; }
            j += 1;
        }
        // Single-record / single-verdict invariant: each field may appear at
        // most once. A record with two Verdict lines (e.g. PENDING then
        // SATISFIED) is contradictory → evaluator-error (the parser used to
        // silently keep the last value).
        if (verdictCount > 1 || skillCount > 1 || pilotCount > 1) {
            errors.push({
                id,
                file,
                line: headingLine,
                reason: `evidence record for ${id} has duplicate field(s) (Verdict=${verdictCount}, Skill=${skillCount}, Pilot=${pilotCount}); each field may appear at most once`,
            });
            i = j;
            continue;
        }
        if (verdict === null) {
            errors.push({ id, file, line: headingLine, reason: `evidence record for ${id} missing -Verdict: field` });
        } else if (!VERDICT_SET.has(verdict)) {
            errors.push({ id, file, line: headingLine, reason: `evidence record for ${id} has unknown verdict ${JSON.stringify(verdict)}` });
        } else if (skill === null) {
            errors.push({ id, file, line: headingLine, reason: `evidence record for ${id} missing -Skill: field` });
        } else {
            // The held skill is encoded in the stable hold ID (S2-<skill>-NNN).
            // The record's Skill field MUST identify that same held skill — a
            // mismatch means the evidence is about a different skill than the
            // held one (the join key agrees but the semantics do not).
            const expectedSkill = id.slice(3, id.length - 4);
            if (skill !== expectedSkill) {
                errors.push({
                    id,
                    file,
                    line: headingLine,
                    reason: `evidence record for ${id} Skill ${JSON.stringify(skill)} does not match the held skill ${JSON.stringify(expectedSkill)} derived from the hold ID`,
                });
            } else if (verdict === "SATISFIED" && pilot === null) {
                errors.push({ id, file, line: headingLine, reason: `SATISFIED evidence record for ${id} missing required -Pilot: field` });
            } else if (verdict === "SATISFIED" && !PILOT_SHAPE_RE.test(pilot)) {
                errors.push({ id, file, line: headingLine, reason: `SATISFIED evidence record for ${id} has malformed Pilot ${JSON.stringify(pilot)} (expected "<repo> (retrospective)" or "<repo> (forward)")` });
            } else if (pilot !== null && !PILOT_SHAPE_RE.test(pilot)) {
                errors.push({ id, file, line: headingLine, reason: `evidence record for ${id} has malformed Pilot ${JSON.stringify(pilot)} (expected "<repo> (retrospective)" or "<repo> (forward)")` });
            } else {
                records.push({ id, verdict, skill, pilot: pilot || "", file, line: headingLine });
            }
        }
        i = j;
    }
    // An UNCLOSED fenced code block is malformed markdown: past the opening ```
    // the parser cannot reliably tell a quoted example record from real
    // evidence, so a stray unclosed fence could swallow a subsequent real record
    // (e.g. a real PENDING after an unclosed fence would be skipped → only the
    // earlier SATISFIED survives → a spurious clear). Fail closed
    // (evaluator-error) rather than risk a silent clear — this preserves the
    // fail-closed discipline the fence toggle exists to protect.
    if (inFence) {
        errors.push({
            id: null,
            structural: true,
            file,
            line: lines.length,
            reason: `malformed evidence: an unclosed fenced code block (\`\`\`) reaches end-of-file — close the fence so a quoted example record can be told apart from real evidence`,
        });
    }
    return { records, errors };
}

// --- classification ---------------------------------------------------------

// Classify a hold by (backlog status, evidence verdict). cancelled+WITHDRAWN
// and done+SATISFIED are clear; PENDING or a status/verdict disagreement is a
// blocker; cancelled with a non-WITHDRAWN verdict is evaluator-error.
export function classifyHold(status, verdict) {
    if (CANCELLED_STATUSES.has(status)) {
        if (verdict === "WITHDRAWN") return { classification: "clear", reason: "cancelled hold resolved by WITHDRAWN evidence" };
        return {
            classification: "evaluator-error",
            reason: `cancelled+s2-hold unresolved: cancelled backlog row with verdict ${verdict} (resolve by removing the s2-hold token OR a Verdict: WITHDRAWN record)`,
        };
    }
    if (RESOLVED_STATUSES.has(status)) {
        if (verdict === "SATISFIED") return { classification: "clear", reason: "resolved hold: done + SATISFIED" };
        return { classification: "blocker", reason: `verdict disagreement: backlog row done but evidence ${verdict}` };
    }
    if (ACTIVE_STATUSES.has(status)) {
        if (verdict === "PENDING") return { classification: "blocker", reason: "PENDING hold (pilot not yet landed)" };
        return { classification: "blocker", reason: `verdict disagreement: backlog row open but evidence ${verdict}` };
    }
    return { classification: "evaluator-error", reason: `unknown backlog status ${JSON.stringify(status)}` };
}

// --- emit -------------------------------------------------------------------

const EXIT_BY_CLASSIFICATION = { clear: 0, blocker: 1, "evaluator-error": 2 };

// Emit the release-mode JSON envelope and exit with the classification's
// canonical exit code (mirrors check-defer-triggers.mjs emitReleaseResult).
// The write() callback fires only after the entire chunk is flushed to the OS
// (drain-safe for pipes/files/TTYs).
export function emitResult(payload) {
    const code = EXIT_BY_CLASSIFICATION[payload.classification];
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n", () => process.exit(code));
}

// --- evaluate ---------------------------------------------------------------

// Evaluate the committed S2-hold state. `root` is the repo to evaluate
// (defaults to repoRoot()); tests pass a scratch-repo path. `commit` binds all
// reads to a specific revision (defaults to "HEAD") so the wrapper can pin G6
// to the EXACT commit it will tag (HEAD_SHA) — eliminating the moving-HEAD race
// where a concurrent commit changes the evaluated state vs. the tagged state.
export function evaluate(root, commit) {
    const cwd = root || repoRoot();
    const rev = commit || "HEAD";

    // Git-health gate (#7 robustness): prove git works AND the revision
    // resolves before reading any path. After this, a null from gitShowHeadBlob
    // / gitListTree is trustworthy as "path absent at this revision" rather
    // than "git broken" — so a git outage cannot collapse to a false clear. A
    // failure here throws and is caught by main() → evaluator-error.
    gitCapture(["rev-parse", "--verify", `${rev}^{commit}`], cwd);

    // 1. Discover backlog files (committed): active + archive.
    const backlogFiles = [];
    if (gitShowHeadBlob(ACTIVE_BACKLOG, rev, cwd) !== null) backlogFiles.push(ACTIVE_BACKLOG);
    for (const f of gitListTree(ARCHIVE_DIR, ARCHIVE_FILE_RE, rev, cwd)) backlogFiles.push(f);

    // 2. Extract backlog holds + token errors.
    const backlogHolds = [];
    const tokenErrors = [];
    for (const f of backlogFiles) {
        const blob = gitShowHeadBlob(f, rev, cwd);
        if (blob === null) {
            // Listed by ls-tree but unreadable at rev (race) → evaluator-error.
            tokenErrors.push({ id: null, file: f, line: 0, reason: `committed backlog file ${f} unreadable at ${rev}` });
            continue;
        }
        const { holds, tokenErrors: te } = extractBacklogHolds(blob, f);
        backlogHolds.push(...holds);
        tokenErrors.push(...te);
    }

    // 3. Discover + extract evidence records (committed).
    const evidenceRecords = [];
    const evidenceErrors = [];
    for (const f of gitListTree(EVIDENCE_DIR, /\.md$/, rev, cwd)) {
        const blob = gitShowHeadBlob(f, rev, cwd);
        if (blob === null) {
            evidenceErrors.push({ id: null, file: f, line: 0, reason: `committed evidence packet ${f} unreadable at ${rev}` });
            continue;
        }
        const { records, errors } = extractEvidenceRecords(blob, f);
        evidenceRecords.push(...records);
        evidenceErrors.push(...errors);
    }

    // 4. Build per-hold evaluation over the UNION (active + archive backlog,
    //    joined to evidence by stable hold ID).
    const records = [];
    const blockingIds = new Set();
    const allIds = new Set();

    // Surface malformed-token backlog rows (no valid ID to join on).
    for (const e of tokenErrors) {
        const key = e.id || `__backlog:${e.file}:${e.line}`;
        records.push({
            hold_id: key,
            classification: "evaluator-error",
            backlog: { found: true, file: e.file, line: e.line },
            evidence: null,
            reason: e.reason,
        });
        if (e.id) allIds.add(e.id);
    }

    // Group backlog holds by id; flag duplicates (single-record invariant).
    const backlogById = new Map();
    for (const h of backlogHolds) {
        if (!backlogById.has(h.id)) backlogById.set(h.id, []);
        backlogById.get(h.id).push(h);
    }
    // Group valid + malformed evidence by id (consult malformed during join).
    const evidenceById = new Map();
    for (const r of evidenceRecords) {
        if (!evidenceById.has(r.id)) evidenceById.set(r.id, []);
        evidenceById.get(r.id).push(r);
    }
    const malformedById = new Map();
    for (const e of evidenceErrors) {
        if (!e.id) continue; // unreadable packet (no id) — surfaced below if cited
        if (!malformedById.has(e.id)) malformedById.set(e.id, []);
        malformedById.get(e.id).push(e);
    }

    // Track cited-but-unreadable packets so a cited missing path is visible.
    const unreadablePackets = new Set(evidenceErrors.filter((e) => !e.id).map((e) => e.file));

    // Evaluate each backlog hold id (a hold is defined by a backlog row).
    for (const id of [...backlogById.keys()].sort()) {
        allIds.add(id);
        const rows = backlogById.get(id);
        const ev = evidenceById.get(id) || [];
        const malformed = malformedById.get(id) || [];
        const backlog = rows[0];
        const universe = backlog.file === ACTIVE_BACKLOG ? "active" : "archive";

        const base = {
            hold_id: id,
            classification: "evaluator-error",
            backlog: null,
            evidence: null,
            reason: "",
        };

        // Duplicate backlog rows for the same id (single-record invariant).
        if (rows.length > 1) {
            records.push({
                ...base,
                backlog: {
                    found: true,
                    status: rows.map((r) => r.status).join(","),
                    file: backlog.file,
                    line: backlog.line,
                    universe,
                    duplicate_rows: rows.map((r) => `${r.file}:${r.line}`),
                },
                reason: `duplicate backlog rows for hold ${id} (${rows.length}: ${rows.map((r) => `${r.file}:${r.line}`).join(", ")})`,
            });
            continue;
        }

        // Evidence path required in Links.
        if (!backlog.evidence_path) {
            records.push({
                ...base,
                backlog: { found: true, status: backlog.status, file: backlog.file, line: backlog.line, universe },
                reason: `hold ${id} backlog row has no evidence-packet reference in Links (expected researches/sources/<file>.md)`,
            });
            continue;
        }

        // Join: exactly one VALID evidence record.
        if (ev.length === 0) {
            // Distinguish malformed-cited-record from missing record.
            if (malformed.length > 0) {
                records.push({
                    ...base,
                    backlog: { found: true, status: backlog.status, file: backlog.file, line: backlog.line, universe, evidence_path: backlog.evidence_path },
                    evidence: { found: true, malformed: true, file: malformed[0].file, line: malformed[0].line },
                    reason: malformed[0].reason,
                });
            } else {
                const unreadable = unreadablePackets.has(backlog.evidence_path);
                records.push({
                    ...base,
                    backlog: { found: true, status: backlog.status, file: backlog.file, line: backlog.line, universe, evidence_path: backlog.evidence_path },
                    evidence: { found: false, unreadable },
                    reason: unreadable
                        ? `hold ${id}: cited evidence packet ${backlog.evidence_path} unreadable at ${rev}`
                        : `hold ${id}: no evidence record with heading "### S2 hold: ${id}" in researches/sources/ (cited ${backlog.evidence_path})`,
                });
            }
            continue;
        }
        if (ev.length > 1) {
            records.push({
                ...base,
                backlog: { found: true, status: backlog.status, file: backlog.file, line: backlog.line, universe, evidence_path: backlog.evidence_path },
                evidence: { found: true, duplicate: true, files: ev.map((r) => `${r.file}:${r.line}`) },
                reason: `hold ${id}: duplicate evidence records (${ev.length}: ${ev.map((r) => `${r.file}:${r.line}`).join(", ")})`,
            });
            continue;
        }

        // Single-record invariant: a VALID record AND a MALFORMED record for
        // the same hold ID is a conflict (two records, one structurally bad).
        // Without this, one valid SATISFIED record plus a second malformed
        // record (same heading/ID) would clear via the valid one — defeating
        // the single-record / single-verdict invariant.
        if (ev.length >= 1 && malformed.length >= 1) {
            records.push({
                ...base,
                backlog: { found: true, status: backlog.status, file: backlog.file, line: backlog.line, universe, evidence_path: backlog.evidence_path },
                evidence: {
                    found: true,
                    conflict: true,
                    valid: ev.map((r) => `${r.file}:${r.line}`),
                    malformed: malformed.map((m) => `${m.file}:${m.line}`),
                },
                reason: `hold ${id}: conflicting evidence — ${ev.length} valid + ${malformed.length} malformed record(s) for the same hold ID (single-record invariant violated)`,
            });
            continue;
        }

        const record = ev[0];
        // The single evidence record must be at the cited Links path.
        if (record.file !== backlog.evidence_path) {
            records.push({
                ...base,
                backlog: { found: true, status: backlog.status, file: backlog.file, line: backlog.line, universe, evidence_path: backlog.evidence_path },
                evidence: { found: true, verdict: record.verdict, skill: record.skill, pilot: record.pilot, file: record.file, line: record.line },
                reason: `hold ${id}: evidence record found in ${record.file} but backlog Links cites ${backlog.evidence_path}`,
            });
            continue;
        }

        // Classify by status + verdict.
        const { classification, reason } = classifyHold(backlog.status, record.verdict);
        records.push({
            hold_id: id,
            classification,
            backlog: { found: true, status: backlog.status, file: backlog.file, line: backlog.line, universe, evidence_path: backlog.evidence_path },
            evidence: { found: true, verdict: record.verdict, skill: record.skill, pilot: record.pilot, file: record.file, line: record.line },
            reason,
        });
        if (classification === "blocker") blockingIds.add(id);
    }

    // A packet with a STRUCTURAL parse defect (e.g. an unclosed fenced code
    // block) makes the whole parse unreliable — valid records extracted before
    // the defect opened may have survived, but the parser could not tell quoted
    // example records from real evidence past the opening ```. Surface every
    // structural defect as an UNCONDITIONAL evaluator-error so the aggregate
    // classification fails closed (never a silent clear), regardless of whether
    // valid records were also extracted from the same packet.
    for (const e of evidenceErrors) {
        if (!e.structural) continue;
        records.push({
            hold_id: `__evidence:${e.file}`,
            classification: "evaluator-error",
            backlog: null,
            evidence: { found: true, malformed: true, structural: true, file: e.file, line: e.line },
            reason: e.reason,
        });
    }

    // Deterministic ordering.
    records.sort((a, b) => (a.hold_id < b.hold_id ? -1 : a.hold_id > b.hold_id ? 1 : 0));

    // Aggregate classification: evaluator-error dominates blocker dominates clear.
    let classification = "clear";
    if (records.some((r) => r.classification === "evaluator-error")) classification = "evaluator-error";
    else if (records.some((r) => r.classification === "blocker")) classification = "blocker";

    const holdIds = [...allIds].sort();
    const blockingIdsSorted = [...blockingIds].sort();
    const errorIds = records.filter((r) => r.classification === "evaluator-error").map((r) => r.hold_id);

    return {
        mode: "release",
        classification,
        hold_ids: holdIds,
        blocking_ids: blockingIdsSorted,
        records,
        error: classification === "clear"
            ? null
            : `${classification}: ${[].concat(classification === "blocker" ? blockingIdsSorted : errorIds).join(", ")}`,
    };
}

// Parse the minimal CLI surface: `--commit <SHA>` (or `--commit=<SHA>`) pins
// the evaluation to a specific commit. The wrapper passes HEAD_SHA so G6 is
// bound to the exact commit it will tag. Defaults to "HEAD" for standalone use.
function parseCliArgs(argv) {
    let commit = null;
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--commit" && i + 1 < argv.length) {
            commit = argv[i + 1];
            i += 1;
        } else if (a.startsWith("--commit=")) {
            commit = a.slice("--commit=".length);
        }
    }
    return { commit };
}

function main() {
    const opts = parseCliArgs(process.argv.slice(2));
    try {
        emitResult(evaluate(undefined, opts.commit));
    } catch (e) {
        // Uncaught (e.g. git-health gate failure, spawn error) → evaluator-error
        // (fail-closed). Never collapse to clear.
        emitResult({
            mode: "release",
            classification: "evaluator-error",
            hold_ids: [],
            blocking_ids: [],
            records: [],
            error: `evaluator error: ${e && e.stack ? e.stack : String(e)}`,
        });
    }
}

// Run as a CLI only when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main();
}
