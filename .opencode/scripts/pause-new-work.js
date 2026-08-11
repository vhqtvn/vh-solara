// pause-new-work.js — canonical sentinel contract for the repo-scoped pause
// on NEW work across enumerated harness and OpenCode dispatch entrypoints.
//
// SHARED STATE CONTRACT (the ONE contract every consumer implements):
//
//   sentinel absent                 -> disengaged (permit; ordinary operation)
//   sentinel present + valid        -> engaged   (refuse covered new work)
//   sentinel present + malformed/   -> engaged   (fail-safe)
//   sentinel present + unreadable   -> engaged   (fail-safe)
//   indeterminate FS check failure  -> engaged   + report DEGRADED
//
// Effectively: the sentinel file EXISTS -> engaged, regardless of content.
// The content is advisory metadata (engaged_at, reason) only; existence is the
// authority. This is why ABSENT means disengaged (ordinary operation has no
// sentinel file) rather than hermes's fail-safe-engaged model — here
// "missing=engaged" would make disengagement impossible.
//
// NAMING HONESTY (load-bearing): this is NOT 'global ESTOP', NOT 'pause every
// agent', NOT an agent-loop interlock, NOT an abort/kill switch. It is a
// repo-scoped pause on NEW work across ENUMERATED dispatch entrypoints. Covered
// admissions are refused; IN-FLIGHT work is never touched. The name
// `pause-new-work` must never drift back toward an unsupported 'global pause'
// claim.
//
// Consumers (all implement this ONE contract — JS ones import this module, the
// Python bgshell port carries an inline copy kept in lockstep):
//   - state-lib.js activateCoordinationTask gate (JS, imports this)
//   - pause-new-work.js OpenCode plugin (JS, imports this)
//   - bgshell_job.py command_launch/command_resume gate (Python, inline port)
//
// The sentinel lives under stateRoot() (<repo>/.opencode/state or
// OPENCODE_STATE_ROOT). That subtree is ALREADY drift-exempt —
// internal/drift/drift.go managedSubtreesToSkip includes .opencode/state — so
// creating/removing the sentinel never trips managed-drift.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Sentinel filename. Lives at <stateRoot>/pause-new-work.json.
export const PAUSE_SENTINEL_FILENAME = "pause-new-work.json";

// repoRoot resolves the same way state-lib.js does: this module sits at
// <repo>/.opencode/scripts/, so two parents up is the repo root. Kept LOCAL
// (not imported from state-lib.js) so this module has no dependency on
// state-lib.js — both files live in the same directory and resolve identically.
export function repoRoot() {
    return path.resolve(__dirname, "..", "..");
}

export function opencodeRoot() {
    return path.join(repoRoot(), ".opencode");
}

export function stateRoot() {
    const override = (process.env.OPENCODE_STATE_ROOT || "").trim();
    if (override) return override;
    return path.join(opencodeRoot(), "state");
}

export function sentinelPath() {
    return path.join(stateRoot(), PAUSE_SENTINEL_FILENAME);
}

// readPauseState reads the sentinel and returns { engaged, degraded, meta }.
//
// A SINGLE readFileSync is both the existence check and the content read
// (avoids a stat-then-read TOCTOU where a file deleted between the two calls
// would be misclassified). ENOENT from readFileSync = absent = disengaged;
// any OTHER thrown error = indeterminate filesystem failure = engaged +
// degraded; a successful read = present = engaged (content parsed
// defensively: malformed/empty stays engaged but is NOT degraded, because
// content is advisory and existence is the contract).
export function readPauseState() {
    const sp = sentinelPath();
    let raw;
    try {
        raw = fs.readFileSync(sp, "utf8");
    } catch (e) {
        if (e && e.code === "ENOENT") {
            return { engaged: false, degraded: false, meta: null };
        }
        // EACCES / EIO / other indeterminate FS failure -> fail safe + flag
        // degraded so the operator-facing message points at recovery.
        return {
            engaged: true,
            degraded: true,
            meta: null,
            error: String((e && e.message) || e),
        };
    }
    // Present. Parse the advisory metadata defensively.
    let meta = null;
    try {
        if (raw && raw.trim()) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                meta = parsed;
            }
        }
    } catch {
        // Malformed content: still engaged (fail-safe), NOT degraded. Content
        // is advisory; existence is the authority.
        meta = null;
    }
    return { engaged: true, degraded: false, meta };
}

// formatRefusal returns the operator-facing message shown when covered new
// work is refused. `detail` names the refused operation (e.g. "task
// activation", "bgshell launch", "TaskTool dispatch").
export function formatRefusal(detail) {
    const state = readPauseState();
    const when =
        state.meta && state.meta.engaged_at
            ? ` at ${state.meta.engaged_at}`
            : "";
    const reason =
        state.meta && state.meta.reason
            ? `\n  reason: ${state.meta.reason}`
            : "";
    const degraded = state.degraded
        ? `\n  (DEGRADED: the pause sentinel could not be read cleanly; ` +
          `refusing covered new work as a precaution. Recover with ` +
          `'vh-agent-harness pause-new-work status' or ` +
          `'vh-agent-harness pause-new-work disengage'.)`
        : "";
    return (
        `Pause on new work is ENGAGED${when}.${reason}${degraded}\n` +
        `  refused: ${detail}\n` +
        `  This is a repo-scoped pause on NEW work across enumerated ` +
        `dispatch entrypoints. In-flight work is NOT affected. Disengage ` +
        `with 'vh-agent-harness pause-new-work disengage'.`
    );
}

// engage writes the sentinel. reason is optional operator context. Returns the
// written metadata + path.
export function engage(reason) {
    const sp = sentinelPath();
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    const trimmed =
        typeof reason === "string" && reason.trim() ? reason.trim() : null;
    const meta = {
        engaged_at: new Date().toISOString(),
        reason: trimmed,
    };
    fs.writeFileSync(sp, JSON.stringify(meta, null, 2) + "\n", "utf8");
    return { engaged: true, path: sp, meta };
}

// disengage removes the sentinel. Absent sentinel is a clean no-op (already
// disengaged). Returns whether a sentinel existed.
export function disengage() {
    const sp = sentinelPath();
    let existed = false;
    try {
        fs.unlinkSync(sp);
        existed = true;
    } catch (e) {
        if (e && e.code === "ENOENT") {
            existed = false;
        } else {
            throw e;
        }
    }
    return { engaged: false, path: sp, existed };
}

// status returns the current state for reporting.
export function status() {
    const state = readPauseState();
    return { ...state, path: sentinelPath() };
}

// The set of OpenCode dispatch commands blocked when engaged (the
// "begin new delegated work" class). Exported so the plugin and tests share
// one list. Everything else (session-start, checkpoint-*, task-list/open/
// review/closeout, docs-sync, ship-review, commit-review, coordination,
// repo-map, read-files, skill-propose, write-task, plans, plan-*,
// workstream-*, task-ready/update/delete, resume-task, harness) is deliberately
// NOT blocked — it is state/utility/diagnosis/review/planning/continuation, not
// new-work dispatch. /write-task in particular MUST stay available: it creates
// candidate transport, it does not begin execution. /resume-task is ALSO
// deliberately NOT command-level blocked: it is the entry point for BOTH
// ready->working (new dispatch — gated precisely by activateCoordinationTask)
// AND working->working continuation (in-flight — must stay available). A
// blanket command block would forbid continuation under a pause, violating the
// "in-flight work is never touched" contract; the JS ready->working gate is
// the precise seam instead.
export const PAUSE_BLOCKED_DISPATCH_COMMANDS = Object.freeze([
    "implement",
    "implement-goal",
    "research",
    "solution-brief",
]);

// isBlockedDispatchCommand returns true when a command name is in the
// new-work-dispatch blocklist. Tolerates a leading slash.
export function isBlockedDispatchCommand(name) {
    if (typeof name !== "string") return false;
    const trimmed = name.trim().replace(/^\/+/, "");
    return PAUSE_BLOCKED_DISPATCH_COMMANDS.includes(trimmed);
}
