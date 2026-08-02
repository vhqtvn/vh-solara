/**
 * Verification harness for check-defer-triggers.js PROMOTER-mode status filter.
 *
 * Regression coverage for the false-READY root cause: a DEFER/p2/follow-up card
 * whose trigger predicates are met BUT whose `status` is a terminal/discharge
 * value (completed/cancelled) must NOT resurface as `[READY] ready-for-dor`
 * just because its trigger file was later re-touched by unrelated churn.
 *
 * This harness imports `evaluateCandidate` directly and unit-tests it against
 * SYNTHETIC fixture bodies + a synthetic changed-paths set — NO git invocation,
 * fully hermetic. It follows the repo's verify-* self-test convention (throw on
 * fail; try/catch + process.exit(1); "verification: ok" on success) used by the
 * sibling verify-*.js harnesses.
 *
 * Invoke via:
 *   vh-agent-harness exec /usr/bin/node .opencode/scripts/verify-check-defer-triggers.js
 *
 * (Bare `node` mis-resolves under exec-sandbox to a nonexistent
 * /usr/local/bin/node; /usr/bin/node is the working surface.)
 */
import { evaluateCandidate, readCardStatus, PROMOTER_DISCHARGE_STATUSES } from "./check-defer-triggers.js";

// A synthetic changed-paths set. evaluateCandidate checks `changedPaths.has()`
// for path_touched — it does NOT call git for path_touched predicates — so this
// fixture makes `path_touched(src/touched.go)` MET and any other path NOT met,
// deterministically and without touching the repo's git state.
const MET_PATH = "src/touched.go";
const MET_PATHS = new Set([MET_PATH]);
const MET_TRIGGER = `trigger:path_touched(${MET_PATH})`;
const UNMET_TRIGGER = "trigger:path_touched(src/NOT-touched.go)";

let checks = 0;
function assert(cond, msg) {
    checks++;
    if (!cond) throw new Error(`FAIL: ${msg}`);
}
function assertEq(actual, expected, msg) {
    checks++;
    if (actual !== expected) {
        throw new Error(
            `FAIL: ${msg}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(actual)}`,
        );
    }
}

// Build a synthetic task-card body. `statusOpt` controls the status field:
//   undefined -> the status key is OMITTED entirely (backward-compat case)
//   null      -> status: null (readCardStatus returns "")
//   ""        -> status: ""   (readCardStatus returns "")
//   string    -> status: <string>
// When `trigger` is null/undefined the card has NO trigger line.
function makeBody(task_id, statusOpt, trigger) {
    const owner_notes = trigger == null ? [] : [trigger];
    const body = { task_id, owner_notes };
    if (statusOpt !== undefined) body.status = statusOpt;
    return body;
}

// Evaluate a synthetic body in PROMOTER mode. `since` is unused by
// evaluateCandidate for path_touched predicates; pass a harmless placeholder.
function evalCard(body, fileBase) {
    return evaluateCandidate(`/synthetic/${fileBase}.json`, body, "HEAD~32", MET_PATHS);
}

function main() {
    // ---- readCardStatus + PROMOTER_DISCHARGE_STATUSES sanity -----------------
    assertEq(readCardStatus({ status: "completed" }), "completed", "readCardStatus reads string status");
    assertEq(readCardStatus({}), "", "readCardStatus returns '' for missing status");
    assertEq(readCardStatus({ status: null }), "", "readCardStatus returns '' for null status");
    assertEq(readCardStatus({ status: 123 }), "", "readCardStatus returns '' for non-string status");
    assertEq(readCardStatus(null), "", "readCardStatus returns '' for null body");
    assert(PROMOTER_DISCHARGE_STATUSES.has("completed"), "discharge set has completed");
    assert(PROMOTER_DISCHARGE_STATUSES.has("cancelled"), "discharge set has cancelled");
    assert(!PROMOTER_DISCHARGE_STATUSES.has("staged"), "discharge set does NOT have staged (distinct from release-prep)");
    assert(!PROMOTER_DISCHARGE_STATUSES.has("draft"), "discharge set does NOT have draft");

    // ---- CRUX: completed + trigger-met => DISCHARGED (not READY) -------------
    {
        const r = evalCard(makeBody("crux-completed", "completed", MET_TRIGGER), "crux-completed");
        assertEq(r.met, true, "crux completed: trigger is met (raw truth preserved)");
        assertEq(r.discharged, true, "crux completed: discharged === true");
        assert(r.note.startsWith("discharged: status:completed"),
            `crux completed: note cites discharge; got: ${JSON.stringify(r.note)}`);
        // READY = met && !discharged — the completed card must NOT count as ready.
        const ready = r.met && !r.discharged;
        assertEq(ready, false, "crux completed: does NOT count toward READY-for-DoR");
    }

    // ---- cancelled + trigger-met => DISCHARGED ------------------------------
    {
        const r = evalCard(makeBody("crux-cancelled", "cancelled", MET_TRIGGER), "crux-cancelled");
        assertEq(r.met, true, "crux cancelled: trigger is met");
        assertEq(r.discharged, true, "crux cancelled: discharged === true");
        assert(r.note.startsWith("discharged: status:cancelled"),
            `crux cancelled: note cites discharge; got: ${JSON.stringify(r.note)}`);
    }

    // ---- POSITIVE: active status + trigger-met => READY ---------------------
    for (const active of ["draft", "ready", "working"]) {
        const r = evalCard(makeBody(`active-${active}`, active, MET_TRIGGER), `active-${active}`);
        assertEq(r.met, true, `active ${active}: trigger is met`);
        assertEq(r.discharged, false, `active ${active}: discharged === false`);
        assertEq(r.note, "ready-for-dor", `active ${active}: note is ready-for-dor`);
        const ready = r.met && !r.discharged;
        assertEq(ready, true, `active ${active}: counts toward READY-for-DoR`);
    }

    // ---- LENIENT: no status field + trigger-met => READY (backward-compat) ---
    {
        const r = evalCard(makeBody("no-status-field", undefined, MET_TRIGGER), "no-status-field");
        assert(r.status === "", "no-status-field: status read as ''");
        assertEq(r.met, true, "no-status-field: trigger is met");
        assertEq(r.discharged, false, "no-status-field: discharged === false (backward-compat)");
        assertEq(r.note, "ready-for-dor", "no-status-field: note is ready-for-dor (exactly as before)");
    }

    // ---- LENIENT: empty / null / non-string status => READY -----------------
    {
        const r1 = evalCard(makeBody("empty-status", "", MET_TRIGGER), "empty-status");
        assertEq(r1.discharged, false, "empty '': discharged false (lenient)");
        assertEq(r1.note, "ready-for-dor", "empty '': ready-for-dor");

        const r2 = evalCard(makeBody("null-status", null, MET_TRIGGER), "null-status");
        assertEq(r2.discharged, false, "null status: discharged false (lenient)");
        assertEq(r2.note, "ready-for-dor", "null status: ready-for-dor");

        const r3 = evalCard(makeBody("nonstring-status", 123, MET_TRIGGER), "nonstring-status");
        assertEq(r3.discharged, false, "non-string status: discharged false (lenient — never throws)");
        assertEq(r3.note, "ready-for-dor", "non-string status: ready-for-dor");
    }

    // ---- LENIENT: unknown status value => ACTIVE (not discharged) -----------
    {
        const r = evalCard(makeBody("unknown-status", "weird-future-status", MET_TRIGGER), "unknown-status");
        assertEq(r.met, true, "unknown status: trigger is met");
        assertEq(r.discharged, false, "unknown status: treated as ACTIVE (lenient — never discharged)");
        assertEq(r.note, "ready-for-dor", "unknown status: ready-for-dor");
    }

    // ---- Case-insensitive: "COMPLETED" / "Cancelled" => discharged ----------
    {
        const r1 = evalCard(makeBody("upper-completed", "COMPLETED", MET_TRIGGER), "upper-completed");
        assertEq(r1.discharged, true, "COMPLETED (uppercase): discharged (case-insensitive)");

        const r2 = evalCard(makeBody("mixed-cancelled", "Cancelled", MET_TRIGGER), "mixed-cancelled");
        assertEq(r2.discharged, true, "Cancelled (mixed case): discharged (case-insensitive)");
    }

    // ---- trigger-NOT-met + completed => hold, NOT discharged ----------------
    // Discharge only applies when triggers are MET. A not-met card with a
    // terminal status stays on the trigger-not-met path (unchanged output).
    {
        const r = evalCard(makeBody("notmet-completed", "completed", UNMET_TRIGGER), "notmet-completed");
        assertEq(r.met, false, "not-met + completed: trigger not met");
        assertEq(r.discharged, false, "not-met + completed: NOT discharged (discharge requires met)");
        assertEq(r.note, "trigger-not-met", "not-met + completed: note is trigger-not-met (unchanged path)");
    }

    // ---- no-trigger-line + completed => hold, unchanged ---------------------
    {
        const r = evalCard(makeBody("notrigger-completed", "completed", null), "notrigger-completed");
        assertEq(r.met, false, "no-trigger + completed: met false");
        assertEq(r.discharged, false, "no-trigger + completed: not discharged");
        assertEq(r.note, "no-trigger-line", "no-trigger + completed: note is no-trigger-line (unchanged path)");
    }

    // ---- OR-group (any(...)) with one met predicate -------------------------
    // Mirrors a real card shape: trigger:any(path_touched(src/touched.go),
    // always_before(release)). The met path_touched satisfies the OR even though
    // always_before is an unknown predicate (evaluates false). A completed card
    // with a met OR-group must still discharge.
    {
        const body = makeBody("or-completed", "completed",
            "trigger:any(path_touched(src/touched.go), always_before(release))");
        const r = evalCard(body, "or-completed");
        assertEq(r.met, true, "OR-group: met via the touched path_touched branch");
        assertEq(r.discharged, true, "OR-group + completed: discharged");
        assert(r.note.startsWith("discharged: status:completed"), "OR-group + completed: discharge note");
    }

    // ---- object-shape consistency: every report carries status + discharged --
    {
        const samples = [
            evalCard(makeBody("shape-ready", "draft", MET_TRIGGER), "shape-ready"),
            evalCard(makeBody("shape-notmet", "draft", UNMET_TRIGGER), "shape-notmet"),
            evalCard(makeBody("shape-notrigger", "draft", null), "shape-notrigger"),
            evalCard(makeBody("shape-discharged", "completed", MET_TRIGGER), "shape-discharged"),
        ];
        for (const r of samples) {
            assert(typeof r.status === "string", `${r.id}: status field present (string)`);
            assert(typeof r.discharged === "boolean", `${r.id}: discharged field present (boolean)`);
            assert(typeof r.met === "boolean", `${r.id}: met field present (boolean)`);
        }
    }

    console.log("verification: ok");
    console.log(`checks: ${checks}`);
    console.log("contract: PROMOTER-mode status filter — trigger-met + terminal status => discharged (not READY); lenient on missing/unknown status; release/release-prep modes unchanged");
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
