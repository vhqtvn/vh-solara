import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
    StateError,
    buildCompactionContext,
    ensureSessionBinding,
} from "../scripts/state-lib.js";

export const id = "session-state";

// ---------------------------------------------------------------------------
// Skill-freshness sentinel (CC borrowable #3)
//
// opencode caches the rendered-skill list per-process at startup. After
// `vh-agent-harness update` adds or changes skills under .opencode/skills/, a
// RUNNING opencode session will NOT see them until the process restarts. This
// sentinel closes that restart-gap: it fingerprints the on-disk skills at
// plugin/process init (the closest hook to process-start available to a server
// plugin) and re-fingerprints on every session.created; if the aggregate
// differs it emits ONE truthful restart-required notice.
//
// Semantics mirror internal/cli/corpus_freshness.go:
//   - DIFFERENCE-ONLY: never asserts direction ("newer"/"older"), only
//     "changed". A byte/hash comparison proves difference, not chronology.
//   - TRUTHFUL REMEDIATION: tells the user to restart; never claims automatic
//     reload (the sentinel can observe on-disk files, not opencode's in-memory
//     cache, so "on-disk changed since baseline" is the proxy for "the running
//     process's cached skill list is likely stale").
//   - ERROR != DIFFERS: an unreadable/corrupt skill scan is a distinct error
//     notice, never conflated with a content difference.
//
// Scope is PER-DIRECTORY (matches InstanceState's directory key — server()
// runs once per directory). Each project's .opencode/skills/ gets its own
// baseline. Dedup is PER-(directory, result-key) for the process: one notice
// per distinct changed aggregate, so concurrent session.created events in the
// same directory do not double-fire. Complements (does not duplicate)
// `dev-stale-embed`: doctor is an on-demand CLI check; this is the
// session-lifecycle signal.
//
// The on-disk walk mirrors internal/cli/skill.go's renderedSkillNames
// (.opencode/skills/*/SKILL.md); a skill dir without SKILL.md is skipped on
// BOTH baseline and compare, so a half-deleted skill does not register as a
// change by itself (consistent with skill.go's "SKILL.md must be present"
// filter for the list path).

const SKILLS_REL = path.join(".opencode", "skills");
const SKILL_MD = "SKILL.md";

/**
 * Deterministic aggregate of sorted <relative-path, hash> pairs. Sorting makes
 * the digest readdir-order-independent, so any add/remove/rename/modify of a
 * skill is captured by a changed digest. Mirrors corpus_freshness.go's lexical
 * walk + bytes.Equal compare.
 *
 * @param {Array<[string, string]>} pairs - [relativePath, sha256Hex]
 * @returns {string} sha256Hex of the canonicalized pair stream
 */
export function hashSkillAggregate(pairs) {
    const sorted = pairs
        .slice()
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const h = crypto.createHash("sha256");
    for (const [rel, hash] of sorted) {
        h.update(rel, "utf8");
        h.update("\0");
        h.update(hash, "utf8");
        h.update("\0");
    }
    return h.digest("hex");
}

/**
 * Walk <directory>/.opencode/skills/<name>/SKILL.md, SHA-256 each complete file,
 * compute a deterministic aggregate digest of sorted <relative-path, hash>
 * pairs.
 *
 * Returns { status, aggregate, detail }:
 *   - status "fresh": scan succeeded; aggregate is the current fingerprint
 *     (empty-sha when no skills exist). detail is a short count summary.
 *   - status "error": a skill file (or the skills root) was unreadable/corrupt.
 *     aggregate is null. detail names the failing path. NEVER conflate "broken"
 *     with "changed" (mirrors corpus_freshness.go's freshnessError vs
 *     freshnessDiffers split).
 *
 * A missing .opencode/skills/ directory is a valid fresh state (a project with
 * no skills rendered), not an error. A skill directory present without a
 * SKILL.md is skipped on both baseline and compare (mirrors skill.go's
 * renderedSkillNames filter), so it does not register as a change by itself.
 *
 * @param {string} directory - project root (the plugin's `directory`)
 * @returns {{status: "fresh"|"error", aggregate: string|null, detail: string}}
 */
export function computeSkillFingerprint(directory) {
    const skillsRoot = path.join(directory, SKILLS_REL);
    let entries;
    try {
        entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
    } catch (error) {
        if (error.code === "ENOENT") {
            return {
                status: "fresh",
                aggregate: hashSkillAggregate([]),
                detail: "no .opencode/skills directory",
            };
        }
        return {
            status: "error",
            aggregate: null,
            detail: `read skills root ${path.relative(directory, skillsRoot) || SKILLS_REL}: ${error.message}`,
        };
    }
    const pairs = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        // entry.name may be a symlink target; use it directly. A symlinked
        // skill dir resolves through readFileSync (os-level follow), matching
        // how opencode itself would read the skill.
        const skillMd = path.join(skillsRoot, entry.name, SKILL_MD);
        let bytes;
        try {
            bytes = fs.readFileSync(skillMd);
        } catch (error) {
            if (error.code === "ENOENT") {
                // Skill dir present but SKILL.md absent: skip consistently on
                // baseline and compare (mirrors renderedSkillNames).
                continue;
            }
            return {
                status: "error",
                aggregate: null,
                detail: `read skill ${path.relative(directory, skillMd)}: ${error.message}`,
            };
        }
        const rel = path.relative(directory, skillMd).replace(/\\/g, "/");
        const hash = crypto.createHash("sha256").update(bytes).digest("hex");
        pairs.push([rel, hash]);
    }
    return {
        status: "fresh",
        aggregate: hashSkillAggregate(pairs),
        detail: `${pairs.length} skill(s)`,
    };
}

/**
 * Compare a baseline fingerprint result against the current scan. Returns a
 * notice descriptor or null (no notice).
 *
 *   - baseline null (first session, no prior baseline): null — establish
 *     silently. (The plugin captures baseline at server() init, so the first
 *     session.created naturally compares same-vs-same; this null branch is the
 *     explicit guard for a caller that defers baseline capture.)
 *   - both fresh, same aggregate: null (unchanged).
 *   - both fresh, different aggregate: { kind: "changed", aggregate }.
 *   - current error: { kind: "error", detail } — distinct from "changed".
 *   - baseline error + current fresh: { kind: "error", detail } — refuse to
 *     claim a content diff from a broken baseline.
 *
 * Difference-only: never asserts direction, only "changed".
 *
 * @param {{status: string, aggregate: string|null, detail: string}|null} baseline
 * @param {{status: string, aggregate: string|null, detail: string}} current
 * @returns {{kind: "changed"|"error", aggregate?: string, detail?: string}|null}
 */
export function compareSkillFingerprint(baseline, current) {
    if (!baseline) {
        return null;
    }
    if (current.status === "error") {
        return { kind: "error", detail: current.detail };
    }
    if (baseline.status === "error") {
        return { kind: "error", detail: baseline.detail };
    }
    if (current.aggregate === baseline.aggregate) {
        return null;
    }
    return { kind: "changed", aggregate: current.aggregate };
}

/**
 * Per-(directory, result-key) dedup Set for the process. One notice per
 * distinct changed aggregate (or one error notice per directory). The key is
 * reserved SYNCHRONOUSLY before the toast await so concurrent session.created
 * events in the same directory do not double-fire — the same publish-before-
 * await Anti-spam discipline coordination-hints.js uses.
 */
const noticedSkillKeys = new Set();

function skillNoticeKey(directory, notice) {
    // Changed-aggregate notices dedup by the aggregate; error notices dedup
    // per-directory (a repeated error adds no information; a later "changed"
    // after a fix gets its own key and still fires).
    return `${directory}\0${notice.kind === "changed" ? notice.aggregate : "error"}`;
}

async function showSkillNoticeToast(client, directory, notice) {
    if (notice.kind === "changed") {
        await client.tui.showToast({
            query: { directory },
            body: {
                title: "Skills changed",
                message:
                    "OpenCode skills changed since this process started. Restart OpenCode to reload them.",
                variant: "warning",
                duration: 5000,
            },
        });
        return;
    }
    await client.tui.showToast({
        query: { directory },
        body: {
            title: "Skill scan failed",
            message: `Could not read skill files; skills may be stale. ${notice.detail}`,
            variant: "error",
            duration: 5000,
        },
    });
}

export const server = async ({ client, directory }) => {
    // Capture the process-start baseline for this directory. server() runs once
    // per InstanceState (per-directory), so this executes once near process
    // startup — the closest hook to when opencode populates its in-process
    // skill cache. The first session.created then compares same-vs-same (no
    // notice), establishing the baseline silently.
    const skillBaseline = computeSkillFingerprint(directory);

    return {
        event: async ({ event }) => {
            if (event.type !== "session.created") {
                return;
            }
            const info = event.properties.info;
            ensureSessionBinding(info.id, {
                cwd: info.directory || directory,
                parentSessionID: info.parentID || null,
            });

            // Skill-freshness sentinel. Isolated in its own try/catch so an
            // advisory-signal failure (toast transport error, unexpected scan
            // fault) never disrupts the session.created handler — the next
            // session.created retries the comparison. ensureSessionBinding above
            // is intentionally OUTSIDE this guard so its errors still surface.
            let reservedKey = null;
            try {
                const current = computeSkillFingerprint(directory);
                const notice = compareSkillFingerprint(skillBaseline, current);
                if (!notice) {
                    return;
                }
                const noticeKey = skillNoticeKey(directory, notice);
                if (noticedSkillKeys.has(noticeKey)) {
                    return;
                }
                // Reserve SYNCHRONOUSLY before the await (Anti-spam): under
                // fire-and-forget event dispatch a second session.created
                // re-entering the handler during the toast RPC would otherwise
                // read a Set that still lacks the key and fire a duplicate.
                noticedSkillKeys.add(noticeKey);
                reservedKey = noticeKey;
                await showSkillNoticeToast(client, directory, notice);
            } catch (_error) {
                // Fail-open: the sentinel is advisory. Swallow so the plugin
                // host does not log a spurious error for a transport glitch.
                // If a key was reserved for this event, release it so a later
                // session.created can RETRY the toast — the synchronous
                // reservation prevents a duplicate fire under concurrent
                // re-entry, but a rejected publish must not permanently
                // consume the key and silence the notice for this
                // (directory, aggregate) for the rest of the process. (A
                // throw before reservation leaves reservedKey null, so there
                // is nothing to roll back.)
                if (reservedKey !== null) {
                    noticedSkillKeys.delete(reservedKey);
                }
            }
        },
        "shell.env": async (input, output) => {
            if (input.sessionID) {
                output.env.OPENCODE_SESSION_ID = input.sessionID;
                output.env.OPENCODE_CWD = directory;
            }
        },
        "experimental.session.compacting": async (input, output) => {
            try {
                const todoResponse = await client.session.todo({
                    sessionID: input.sessionID,
                    directory,
                });
                const todos =
                    todoResponse && !todoResponse.error
                        ? todoResponse.data || []
                        : [];
                output.context.push(
                    ...buildCompactionContext(input.sessionID, todos),
                );
            } catch (error) {
                if (error instanceof StateError) {
                    output.context.push("Session alias: (unbound)");
                    output.context.push(error.message);
                    return;
                }
                throw error;
            }
        },
    };
};

export default {
    id,
    server,
};
