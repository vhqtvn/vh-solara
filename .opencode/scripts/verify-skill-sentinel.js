// Skill-freshness sentinel verification (CC borrowable #3).
//
// This is the plugin-testing seam for the skill-freshness sentinel added to
// plugins/session-state.js. It mirrors verify-coordination-hints.js: it covers
// the PURE fingerprint/compare helpers directly (no plugin runtime needed), AND
// it exercises the plugin's session.created orchestration through server() with
// a mock client whose client.tui.showToast records payloads.
//
// Run: `node .opencode/scripts/verify-skill-sentinel.js` (rendered tree).
//
// All 10 behavioral cases are covered:
//   1. Unchanged: skills identical -> no notice.
//   2. Changed: one skill modified -> one restart-required notice.
//   3. Multi-skill-change: 3 skills change -> ONE notice (aggregate-level).
//   4. First-session: no prior baseline -> establish silently, no notice.
//   5. Read-error: skill unreadable -> distinct error notice.
//   6. Dedup: two sessions, same directory, same changed aggregate -> one notice.
//   7. Cross-directory: two projects -> independent baselines/notices.
//   8. Fail-open: toast rejects -> handler swallows (session.created not disrupted).
//   9. Selectivity: a second distinct changed aggregate fires a new notice.
//  10. Retry-after-rejection: a rejected toast releases the reserved dedup key;
//      a later session.created for the SAME aggregate retries the notice.
import fs from "node:fs";
import path from "node:path";
import {
    computeSkillFingerprint,
    compareSkillFingerprint,
    hashSkillAggregate,
    server,
} from "../plugins/session-state.js";

const TMP_ROOT = path.resolve(
    path.dirname(new URL(".", import.meta.url).pathname),
    "..",
    "..",
    "tmp",
);

function ensureDir(targetPath) {
    fs.mkdirSync(targetPath, { recursive: true });
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function sandbox(prefix) {
    return fs.mkdtempSync(path.join(TMP_ROOT, `verify-skill-sentinel-${prefix}-`));
}

// Build <root>/.opencode/skills/<name>/SKILL.md with the given body.
function writeSkill(root, name, body) {
    const dir = path.join(root, ".opencode", "skills", name);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, "SKILL.md"), body, "utf8");
}

// A session.created event shaped like the real opencode payload.
function sessionCreated(sessionID, directory) {
    return {
        event: {
            type: "session.created",
            properties: { info: { id: sessionID, directory } },
        },
    };
}

// Mock client: every showToast call records its payload. Returns the client,
// the calls list, and counters by variant.
function mockClient() {
    const calls = [];
    const client = {
        tui: {
            showToast: async (payload) => {
                calls.push(payload);
            },
        },
    };
    return { client, calls };
}

function warningCount(calls) {
    return calls.filter((c) => c.body && c.body.variant === "warning").length;
}

function errorCount(calls) {
    return calls.filter((c) => c.body && c.body.variant === "error").length;
}

// ---------------------------------------------------------------------------
// PURE-FUNCTION COVERAGE (no plugin runtime, no filesystem-state pollution).

function verifyHashAggregate() {
    // Empty -> stable, non-null digest.
    const empty = hashSkillAggregate([]);
    assert(typeof empty === "string" && empty.length === 64, "empty aggregate must be a sha256 hex");

    // Order-independent: same pairs in different order -> same digest.
    const a = hashSkillAggregate([["a/SKILL.md", "h1"], ["b/SKILL.md", "h2"]]);
    const b = hashSkillAggregate([["b/SKILL.md", "h2"], ["a/SKILL.md", "h1"]]);
    assert(a === b, "hashSkillAggregate must be readdir-order-independent");

    // Content-sensitive: any change flips the digest.
    const c = hashSkillAggregate([["a/SKILL.md", "h1"], ["b/SKILL.md", "hX"]]);
    assert(a !== c, "hashSkillAggregate must change when a hash changes");

    // Path-sensitive: a renamed path flips the digest.
    const d = hashSkillAggregate([["a/RENAMED.md", "h1"], ["b/SKILL.md", "h2"]]);
    assert(a !== d, "hashSkillAggregate must change when a path changes");

    console.log("hashSkillAggregate: ok");
}

function verifyComputeFingerprint() {
    const root = sandbox("fp");
    try {
        // (a) No .opencode/skills -> fresh, empty aggregate, not an error.
        const missing = computeSkillFingerprint(root);
        assert(missing.status === "fresh", "missing skills dir must be fresh, not error");
        assert(missing.aggregate === hashSkillAggregate([]), "missing skills dir -> empty aggregate");

        // (b) Two skills -> fresh, non-empty, content-bound aggregate.
        writeSkill(root, "alpha", "# Alpha\n");
        writeSkill(root, "beta", "# Beta\n");
        const two = computeSkillFingerprint(root);
        assert(two.status === "fresh", "two skills must scan fresh");
        assert(two.aggregate !== hashSkillAggregate([]), "two skills -> non-empty aggregate");
        assert(/2 skill\(s\)/.test(two.detail), `detail should count 2 skills; got "${two.detail}"`);

        // (c) Same bytes on re-scan -> identical aggregate (deterministic).
        const twoAgain = computeSkillFingerprint(root);
        assert(twoAgain.aggregate === two.aggregate, "fingerprint must be deterministic");

        // (d) Modify one skill -> aggregate changes.
        writeSkill(root, "alpha", "# Alpha (changed)\n");
        const changed = computeSkillFingerprint(root);
        assert(changed.aggregate !== two.aggregate, "modified skill must change aggregate");

        // (e) Skill dir without SKILL.md is skipped (mirrors skill.go), does
        // not register as an error or change the count of hashed skills.
        writeSkill(root, "alpha", "# Alpha\n"); // restore
        ensureDir(path.join(root, ".opencode", "skills", "nodebug")); // no SKILL.md
        const withPartial = computeSkillFingerprint(root);
        assert(withPartial.status === "fresh", "skill dir without SKILL.md must not error");
        assert(/2 skill\(s\)/.test(withPartial.detail), "partial skill dir is skipped; still 2 hashed");

        // (f) Read error: SKILL.md is a directory -> EISDIR -> status "error".
        fs.mkdirSync(path.join(root, ".opencode", "skills", "alpha", "SKILL.md-corrupt"));
        // Replace the real SKILL.md with a directory named SKILL.md to force a
        // read error deterministically regardless of the running user (chmod
        // tricks are unreliable under root; EISDIR is portable).
        fs.unlinkSync(path.join(root, ".opencode", "skills", "alpha", "SKILL.md"));
        fs.mkdirSync(path.join(root, ".opencode", "skills", "alpha", "SKILL.md"));
        const errored = computeSkillFingerprint(root);
        assert(errored.status === "error", "unreadable SKILL.md must surface as error status");
        assert(errored.aggregate === null, "error status must carry null aggregate");
        assert(
            /read skill/.test(errored.detail),
            `error detail should name the failing skill; got "${errored.detail}"`,
        );

        console.log("computeSkillFingerprint: ok");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function verifyCompareFingerprint() {
    const fresh = (aggregate) => ({ status: "fresh", aggregate, detail: "x" });
    const err = (detail) => ({ status: "error", aggregate: null, detail });

    // (a) First-session: null baseline -> null notice (establish silently).
    assert(compareSkillFingerprint(null, fresh("a")) === null, "null baseline must produce no notice");

    // (b) Unchanged: same aggregate -> null.
    assert(compareSkillFingerprint(fresh("a"), fresh("a")) === null, "same aggregate -> no notice");

    // (c) Changed: different aggregate -> { kind: "changed" }.
    const changed = compareSkillFingerprint(fresh("a"), fresh("b"));
    assert(changed && changed.kind === "changed", "different aggregate -> changed notice");
    assert(changed.aggregate === "b", "changed notice carries the current aggregate");

    // (d) Current error -> { kind: "error" } (distinct from changed).
    const curErr = compareSkillFingerprint(fresh("a"), err("boom"));
    assert(curErr && curErr.kind === "error", "current error -> error notice");
    assert(curErr.detail === "boom", "error notice carries current detail");

    // (e) Baseline error + current fresh -> error notice (refuse to claim diff
    // from a broken baseline).
    const baseErr = compareSkillFingerprint(err("base-broken"), fresh("a"));
    assert(baseErr && baseErr.kind === "error", "broken baseline -> error notice (not changed)");
    assert(baseErr.detail === "base-broken", "broken-baseline notice carries baseline detail");

    console.log("compareSkillFingerprint: ok");
}

// ---------------------------------------------------------------------------
// PLUGIN ORCHESTRATION (server() with mock client; the full session.created
// handler including the try/catch isolation). OPENCODE_STATE_ROOT is redirected
// to a sandbox so ensureSessionBinding (which runs first in the handler) writes
// no repo-state pollution.

async function withStateRoot(root, fn) {
    const prev = process.env.OPENCODE_STATE_ROOT;
    process.env.OPENCODE_STATE_ROOT = root;
    try {
        return await fn();
    } finally {
        if (prev === undefined) {
            delete process.env.OPENCODE_STATE_ROOT;
        } else {
            process.env.OPENCODE_STATE_ROOT = prev;
        }
    }
}

async function fire(handler, sessionID, directory) {
    await handler(sessionCreated(sessionID, directory));
}

// Case 1: unchanged skills -> no notice on any session.
async function verifyUnchanged() {
    const root = sandbox("unchanged");
    const stateRoot = sandbox("unchanged-state");
    try {
        writeSkill(root, "alpha", "# Alpha\n");
        const { client, calls } = mockClient();
        const handler = (await server({ client, directory: root })).event;

        await withStateRoot(stateRoot, () => fire(handler, "ses-unchanged-1", root));
        await withStateRoot(stateRoot, () => fire(handler, "ses-unchanged-2", root));

        assert(calls.length === 0, `unchanged skills must not fire a notice; got ${calls.length}`);
        console.log("case 1 (unchanged): ok");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

// Case 2: one skill modified between sessions -> exactly one warning notice.
async function verifyChanged() {
    const root = sandbox("changed");
    const stateRoot = sandbox("changed-state");
    try {
        writeSkill(root, "alpha", "# Alpha\n");
        const { client, calls } = mockClient();
        const handler = (await server({ client, directory: root })).event;

        await withStateRoot(stateRoot, () => fire(handler, "ses-changed-1", root));
        assert(calls.length === 0, "first session (baseline) must not fire");

        writeSkill(root, "alpha", "# Alpha (modified)\n");
        await withStateRoot(stateRoot, () => fire(handler, "ses-changed-2", root));

        assert(calls.length === 1, `one modified skill must fire exactly one notice; got ${calls.length}`);
        assert(warningCount(calls) === 1, "changed-skill notice must be a warning");
        const msg = calls[0].body.message;
        assert(/restart/i.test(msg), `changed notice must tell user to restart; got "${msg}"`);
        assert(
            !/reload(ed)? automatically|auto-reload/i.test(msg),
            "changed notice must NOT claim automatic reload (truthful remediation)",
        );

        console.log("case 2 (changed): ok");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

// Case 3: three skills change at once -> ONE aggregate-level notice (not three).
async function verifyMultiSkillChange() {
    const root = sandbox("multi");
    const stateRoot = sandbox("multi-state");
    try {
        writeSkill(root, "alpha", "# Alpha\n");
        writeSkill(root, "beta", "# Beta\n");
        writeSkill(root, "gamma", "# Gamma\n");
        const { client, calls } = mockClient();
        const handler = (await server({ client, directory: root })).event;

        await withStateRoot(stateRoot, () => fire(handler, "ses-multi-1", root));
        writeSkill(root, "alpha", "# Alpha v2\n");
        writeSkill(root, "beta", "# Beta v2\n");
        writeSkill(root, "gamma", "# Gamma v2\n");
        await withStateRoot(stateRoot, () => fire(handler, "ses-multi-2", root));

        assert(
            calls.length === 1,
            `three simultaneous skill changes must fire ONE aggregate notice; got ${calls.length}`,
        );
        assert(warningCount(calls) === 1, "multi-change notice must be a single warning");

        console.log("case 3 (multi-skill-change): ok");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

// Case 4: first session after process start -> no notice (baseline established
// silently at server() init; first session.created compares same-vs-same).
async function verifyFirstSession() {
    const root = sandbox("first");
    const stateRoot = sandbox("first-state");
    try {
        writeSkill(root, "alpha", "# Alpha\n");
        const { client, calls } = mockClient();
        const handler = (await server({ client, directory: root })).event;

        // The very first session.created after process start: no prior change
        // could have happened (baseline captured at server() init moments ago),
        // so no notice.
        await withStateRoot(stateRoot, () => fire(handler, "ses-first-1", root));
        assert(calls.length === 0, `first session must establish baseline silently; got ${calls.length}`);

        console.log("case 4 (first-session): ok");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

// Case 5: skill file unreadable -> distinct ERROR notice (not a "changed"
// content-diff notice).
async function verifyReadError() {
    const root = sandbox("error");
    const stateRoot = sandbox("error-state");
    try {
        writeSkill(root, "alpha", "# Alpha\n");
        const { client, calls } = mockClient();
        const handler = (await server({ client, directory: root })).event;

        await withStateRoot(stateRoot, () => fire(handler, "ses-error-1", root));
        assert(calls.length === 0, "pre-change session must not fire");

        // Force a deterministic read error: replace SKILL.md with a directory
        // (EISDIR), portable regardless of the running user (chmod is unreliable
        // under root).
        fs.unlinkSync(path.join(root, ".opencode", "skills", "alpha", "SKILL.md"));
        fs.mkdirSync(path.join(root, ".opencode", "skills", "alpha", "SKILL.md"));

        await withStateRoot(stateRoot, () => fire(handler, "ses-error-2", root));

        assert(calls.length === 1, `unreadable skill must fire exactly one notice; got ${calls.length}`);
        assert(errorCount(calls) === 1, "read-error notice must be variant error, not warning");
        assert(
            !/changed/i.test(calls[0].body.message),
            "read-error notice must NOT say 'changed' (never conflate broken with changed)",
        );

        console.log("case 5 (read-error): ok");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

// Case 6: dedup — two sessions in the same directory with the same changed
// aggregate fire exactly ONE notice total (process-scoped Set).
async function verifyDedup() {
    const root = sandbox("dedup");
    const stateRoot = sandbox("dedup-state");
    try {
        writeSkill(root, "alpha", "# Alpha\n");
        const { client, calls } = mockClient();
        const handler = (await server({ client, directory: root })).event;

        await withStateRoot(stateRoot, () => fire(handler, "ses-dedup-1", root));
        writeSkill(root, "alpha", "# Alpha (changed)\n");

        // First post-change session -> fires.
        await withStateRoot(stateRoot, () => fire(handler, "ses-dedup-2", root));
        // Second post-change session, SAME aggregate (no further change) -> deduped.
        await withStateRoot(stateRoot, () => fire(handler, "ses-dedup-3", root));

        assert(
            calls.length === 1,
            `same changed aggregate must dedup to one notice across sessions; got ${calls.length}`,
        );

        console.log("case 6 (dedup): ok");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

// Case 7: cross-directory — two projects in the same process get independent
// baselines and independent notices.
async function verifyCrossDirectory() {
    const rootA = sandbox("cross-a");
    const rootB = sandbox("cross-b");
    const stateRoot = sandbox("cross-state");
    try {
        writeSkill(rootA, "alpha", "# Alpha\n");
        writeSkill(rootB, "beta", "# Beta\n");

        const { client, calls } = mockClient();
        const handlerA = (await server({ client, directory: rootA })).event;
        const handlerB = (await server({ client, directory: rootB })).event;

        await withStateRoot(stateRoot, () => fire(handlerA, "ses-cross-a1", rootA));
        await withStateRoot(stateRoot, () => fire(handlerB, "ses-cross-b1", rootB));
        assert(calls.length === 0, "neither project changed yet");

        // Change A only: A's handler fires; B's handler (called next) stays silent
        // because B's baseline still matches B's disk.
        writeSkill(rootA, "alpha", "# Alpha v2\n");
        await withStateRoot(stateRoot, () => fire(handlerA, "ses-cross-a2", rootA));
        await withStateRoot(stateRoot, () => fire(handlerB, "ses-cross-b2", rootB));

        assert(calls.length === 1, `only the changed project must fire; got ${calls.length}`);
        assert(
            calls[0].query.directory === rootA,
            "cross-directory notice must target the changed project's directory",
        );

        console.log("case 7 (cross-directory): ok");
    } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
        fs.rmSync(rootB, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

// Case 8 (bonus, fail-open): if client.tui.showToast rejects, the handler must
// swallow it so the session.created path (which also runs ensureSessionBinding)
// is not disrupted. The sentinel is advisory.
async function verifyFailOpenOnToastError() {
    const root = sandbox("failopen");
    const stateRoot = sandbox("failopen-state");
    try {
        writeSkill(root, "alpha", "# Alpha\n");
        let toastCalls = 0;
        const failingClient = {
            tui: {
                showToast: async () => {
                    toastCalls += 1;
                    throw new Error("transport down");
                },
            },
        };
        const handler = (await server({ client: failingClient, directory: root })).event;

        writeSkill(root, "alpha", "# Alpha (changed)\n");
        // Must NOT throw despite the toast rejection.
        await withStateRoot(stateRoot, () => fire(handler, "ses-failopen-1", root));
        assert(toastCalls === 1, "toast must be attempted once despite failure");

        console.log("case 8 (fail-open on toast error): ok");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

// Case 9 (selectivity): a SECOND, DISTINCT changed aggregate fires a NEW
// notice even after the first changed aggregate was deduped. This pins the
// per-aggregate granularity of the dedup key (skillNoticeKey includes the
// aggregate at session-state.js). A future "simplification" that collapsed
// the key to per-directory-only would silently suppress legitimate
// second-change notices and this case would catch it.
async function verifyDistinctAggregateRefires() {
    const root = sandbox("distinct");
    const stateRoot = sandbox("distinct-state");
    try {
        writeSkill(root, "alpha", "# Alpha\n");
        const { client, calls } = mockClient();
        const handler = (await server({ client, directory: root })).event;

        // Baseline session: no notice.
        await withStateRoot(stateRoot, () => fire(handler, "ses-distinct-1", root));
        assert(calls.length === 0, "baseline session must not fire");

        // First change -> fires exactly one notice.
        writeSkill(root, "alpha", "# Alpha (changed)\n");
        await withStateRoot(stateRoot, () => fire(handler, "ses-distinct-2", root));
        assert(calls.length === 1, "first changed aggregate must fire once");

        // Same aggregate, re-fire with no further change -> deduped (bridges
        // to case 6, proves the dedup Set is still active for this key).
        await withStateRoot(stateRoot, () => fire(handler, "ses-distinct-3", root));
        assert(calls.length === 1, "same changed aggregate must dedup across sessions");

        // SECOND distinct change -> different aggregate -> different key ->
        // new notice fires (this is the selectivity assertion).
        writeSkill(root, "alpha", "# Alpha (changed again)\n");
        await withStateRoot(stateRoot, () => fire(handler, "ses-distinct-4", root));
        assert(
            calls.length === 2,
            `a second distinct changed aggregate must fire a new notice; got ${calls.length}`,
        );
        assert(warningCount(calls) === 2, "both distinct-aggregate notices must be warnings");

        console.log("case 9 (distinct-aggregate re-fire): ok");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

// Case 10 (retry after rejection): when client.tui.showToast rejects, the
// reserved dedup key MUST be released so a subsequent session.created for the
// SAME aggregate retries the toast. This is the rollback path for the
// publish-before-await dedup discipline. Without the release, the key would
// be permanently consumed and the second fire would be deduped away — the
// OUTCOME under test is that the notice fires on retry, not merely that the
// key was deleted.
async function verifyRetryAfterRejection() {
    const root = sandbox("retry");
    const stateRoot = sandbox("retry-state");
    try {
        writeSkill(root, "alpha", "# Alpha\n");
        let toastCalls = 0;
        let shouldFail = true;
        const flakyClient = {
            tui: {
                showToast: async () => {
                    toastCalls += 1;
                    if (shouldFail) {
                        throw new Error("transport down");
                    }
                },
            },
        };
        const handler = (await server({ client: flakyClient, directory: root })).event;

        writeSkill(root, "alpha", "# Alpha (changed)\n");
        // First session.created: toast rejects. Must NOT throw (fail-open),
        // and the reserved key must be released so a retry is possible.
        await withStateRoot(stateRoot, () => fire(handler, "ses-retry-1", root));
        assert(toastCalls === 1, `first attempt must be made despite failure; got ${toastCalls}`);

        // Second session.created, SAME aggregate: with the fix the released
        // key allows a retry and the notice fires. Without the fix the
        // permanently-consumed key would suppress this and toastCalls would
        // stay at 1.
        shouldFail = false;
        await withStateRoot(stateRoot, () => fire(handler, "ses-retry-2", root));
        assert(
            toastCalls === 2,
            `retry after rejection must re-fire the notice for the same aggregate; got ${toastCalls}`,
        );

        console.log("case 10 (retry after rejection): ok");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

async function main() {
    ensureDir(TMP_ROOT);
    verifyHashAggregate();
    verifyComputeFingerprint();
    verifyCompareFingerprint();
    await verifyUnchanged();
    await verifyChanged();
    await verifyMultiSkillChange();
    await verifyFirstSession();
    await verifyReadError();
    await verifyDedup();
    await verifyCrossDirectory();
    await verifyFailOpenOnToastError();
    await verifyDistinctAggregateRefires();
    await verifyRetryAfterRejection();
    console.log("skill-sentinel verification: ok");
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
