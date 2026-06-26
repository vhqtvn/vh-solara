/**
 * Verification harness for the collect-all validation behavior introduced in
 * state-lib.js. Confirms that validators which previously threw on the first
 * problem now collect and report EVERY problem in a single StateError.
 *
 * Invoke via:
 *   vh-agent-harness exec node .opencode/scripts/verify-state-validation.js
 *
 * The aggregation contract under test:
 *   - A payload with N independent problems throws exactly ONE StateError.
 *   - That error's message contains each original per-problem sentence as a
 *     substring (so existing substring-based assertions keep passing).
 */
import fs from "fs";
import path from "path";
import {
    StateError,
    ensureCoordinationTaskCoreFields,
    saveCoordinationTask,
    reviewCoordinationTask,
    bindSessionName,
    repoRoot,
} from "./state-lib.js";

function removeIfExists(targetPath) {
    if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, {
            recursive: true,
            force: true,
        });
    }
}

function cleanupArtifacts(taskIDs) {
    for (const taskID of taskIDs) {
        removeIfExists(
            path.join(
                repoRoot(),
                ".local",
                "coordinator",
                "tasks",
                `${taskID}.json`,
            ),
        );
        removeIfExists(
            path.join(
                repoRoot(),
                ".local",
                "coordinator",
                "reports",
                taskID,
            ),
        );
    }
}

/**
 * Run fn() and assert it throws exactly one StateError whose message contains
 * EVERY fragment in `fragments` (substring match). This is the aggregation
 * contract: a single throw carries all collected reasons.
 */
function expectAggregatedStateError(fn, fragments) {
    let thrown = null;
    try {
        fn();
    } catch (error) {
        thrown = error;
    }
    if (!(thrown instanceof StateError)) {
        throw new StateError(
            `Expected a single StateError, but got ${thrown ? thrown.constructor.name : "no error"}.`,
        );
    }
    const message = String(thrown.message || "");
    const missing = fragments.filter(
        (fragment) => !message.includes(fragment),
    );
    if (missing.length) {
        throw new StateError(
            `Expected error message to contain all of:\n${fragments.map((f) => `  - ${f}`).join("\n")}\nbut got:\n${message}\nMissing:\n${missing.map((f) => `  - ${f}`).join("\n")}`,
        );
    }
}

/**
 * Run fn() and assert it does NOT throw. Used to confirm a previously-failing
 * shape still passes once corrected (negative control).
 */
function expectNoError(fn) {
    try {
        fn();
    } catch (error) {
        throw new StateError(
            `Expected no error, but got: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * Regression guard for the single-invalid-enum contract: a payload with
 * exactly ONE genuine problem must throw exactly ONE StateError whose message
 * is the RAW problem text verbatim — NOT a numbered aggregate and NOT a
 * duplicate "required" error derived from the same root cause.
 *
 * Asserts:
 *   - fn() throws a StateError
 *   - the message CONTAINS `expectedFragment` (the raw enum message)
 *   - the message does NOT contain `forbiddenFragment` (the derived
 *     "X is required." text that the enum-cascade bug used to add)
 *   - the message is NOT a numbered aggregate (i.e. formatAggregatedErrors
 *     returned list[0] verbatim because exactly one error was collected)
 *
 * @param {Function} fn
 * @param {string} expectedFragment
 * @param {string} forbiddenFragment
 */
function expectSingleRawStateError(fn, expectedFragment, forbiddenFragment) {
    let thrown = null;
    try {
        fn();
    } catch (error) {
        thrown = error;
    }
    if (!(thrown instanceof StateError)) {
        throw new StateError(
            `Expected a single StateError, but got ${thrown ? thrown.constructor.name : "no error"}.`,
        );
    }
    const message = String(thrown.message || "");
    if (!message.includes(expectedFragment)) {
        throw new StateError(
            `Expected raw error to contain ${JSON.stringify(expectedFragment)}, but got:\n${message}`,
        );
    }
    if (forbiddenFragment && message.includes(forbiddenFragment)) {
        throw new StateError(
            `Single-invalid-enum payload leaked a derived duplicate error. Message must NOT contain ${JSON.stringify(forbiddenFragment)}, but got:\n${message}`,
        );
    }
    if (/^\d+ validation problems:/.test(message)) {
        throw new StateError(
            `Single-invalid-enum payload must emit the raw message verbatim, not a numbered aggregate. Got:\n${message}`,
        );
    }
}

/**
 * Build an otherwise-valid saveCoordinationTask payload, overriding a single
 * field. Used so every single-enum regression case shares one known-good base.
 */
function validSavePayload(overrides) {
    return {
        title: "Single-enum regression probe",
        task_type: "implementation",
        coordination_mode: "short",
        primary_lane: "build",
        files_in_scope: ["tests/fixtures/example-pkg/"],
        success_criteria: ["It works."],
        validation_plan: ["Run the verify harness."],
        ...overrides,
    };
}

function main() {
    const args = process.argv.slice(2);
    let prefix = "verify-state-validation";
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--prefix") {
            prefix = args[index + 1] || prefix;
            index += 1;
            continue;
        }
        throw new StateError(`Unexpected argument: ${args[index]}`);
    }

    const coordinatorSessionID = `${prefix}-coordinator-session`;
    const createdTaskIDs = [];

    try {
        bindSessionName(coordinatorSessionID, `${prefix}-coord`, {
            cwd: "/verification",
        });

        // ------------------------------------------------------------------
        // Test 1: ensureCoordinationTaskCoreFields collects every required
        // field violation for a bare empty task object.
        // ------------------------------------------------------------------
        expectAggregatedStateError(
            () => ensureCoordinationTaskCoreFields({}),
            [
                "Task title is required.",
                "task_type is required.",
                "coordination_mode is required.",
                "primary_lane is required.",
                "status is required.",
                "report_envelope is required.",
                "files_in_scope must contain at least one path.",
                "success_criteria must contain at least one requirement.",
                "validation_plan must contain at least one verification step.",
            ],
        );

        // Negative control: a fully-populated valid task must NOT throw.
        expectNoError(() =>
            ensureCoordinationTaskCoreFields({
                title: "Probe task",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "build",
                status: "ready",
                report_envelope: "standard",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["It works."],
                validation_plan: ["Run the verify harness."],
            }),
        );

        // Single-error path: exactly one missing field yields the raw message
        // (no numbered-bullet wrapper), preserving backward-compat text.
        expectAggregatedStateError(
            () =>
                ensureCoordinationTaskCoreFields({
                    title: "Probe task",
                    task_type: "implementation",
                    coordination_mode: "short",
                    primary_lane: "build",
                    status: "ready",
                    report_envelope: "standard",
                    files_in_scope: ["tests/fixtures/example-pkg/"],
                    success_criteria: ["It works."],
                    // validation_plan missing -> single error
                }),
            ["validation_plan must contain at least one verification step."],
        );

        // ------------------------------------------------------------------
        // Test 2: saveCoordinationTask aggregates bad-enum errors AND
        // core-field errors into a single throw. A created task with several
        // invalid enum values and missing required lists must report all of
        // them at once.
        // ------------------------------------------------------------------
        expectAggregatedStateError(
            () =>
                saveCoordinationTask(
                    coordinatorSessionID,
                    {
                        title: "Multi-error aggregation probe",
                        coordination_mode: "bogus-mode",
                        status: "bogus-status",
                        report_envelope: "bogus-envelope",
                    },
                    { cwd: "/verification" },
                ),
            [
                "coordination_mode must be one of:",
                "status must be one of:",
                "report_envelope must be one of:",
                "files_in_scope must contain at least one path.",
                "success_criteria must contain at least one requirement.",
                "validation_plan must contain at least one verification step.",
            ],
        );

        // ------------------------------------------------------------------
        // Test 3: reviewCoordinationTask aggregates multiple independent
        // guards. Review a ready task (not reviewable) with no report, an
        // empty body, and a bad task_status option. All four problems should
        // surface in a single StateError.
        // ------------------------------------------------------------------
        const probe = saveCoordinationTask(
            coordinatorSessionID,
            {
                title: "Review aggregation probe",
                task_type: "implementation",
                coordination_mode: "short",
                primary_lane: "build",
                files_in_scope: ["tests/fixtures/example-pkg/"],
                success_criteria: ["It works."],
                validation_plan: ["Run the verify harness."],
            },
            { cwd: "/verification" },
        );
        createdTaskIDs.push(probe.task.task_id);

        expectAggregatedStateError(
            () =>
                reviewCoordinationTask(
                    coordinatorSessionID,
                    probe.task.task_id,
                    {
                        body: "",
                        taskStatus: "bogus-status",
                    },
                    { cwd: "/verification" },
                ),
            [
                "is not ready for coordinator review.",
                "has no saved closeout report to review.",
                "Task review body is required.",
                "task_status must be one of:",
            ],
        );

        // ------------------------------------------------------------------
        // Regression: single-invalid-enum payloads must throw exactly ONE
        // error (the raw enum message verbatim). Before the fix, the enum
        // normalizer blanked the field and the core-field checker then added
        // a derived "X is required." error, producing a 2-problem numbered
        // aggregate instead of the single raw message. Each case below uses
        // an otherwise-valid payload with exactly ONE bad enum field.
        // ------------------------------------------------------------------
        // status: bogus
        expectSingleRawStateError(
            () =>
                saveCoordinationTask(
                    coordinatorSessionID,
                    validSavePayload({ status: "bogus-status" }),
                    { cwd: "/verification" },
                ),
            "status must be one of:",
            "status is required.",
        );
        // coordination_mode: bogus
        expectSingleRawStateError(
            () =>
                saveCoordinationTask(
                    coordinatorSessionID,
                    validSavePayload({ coordination_mode: "bogus-mode" }),
                    { cwd: "/verification" },
                ),
            "coordination_mode must be one of:",
            "coordination_mode is required.",
        );
        // task_type: bogus
        expectSingleRawStateError(
            () =>
                saveCoordinationTask(
                    coordinatorSessionID,
                    validSavePayload({ task_type: "bogus-type" }),
                    { cwd: "/verification" },
                ),
            "task_type must be one of:",
            "task_type is required.",
        );

        console.log("verification: ok");
        console.log(`probe_task_id: ${probe.task.task_id}`);
        console.log("aggregated_errors_confirmed: 3");
        console.log("single_enum_regression_confirmed: 3");
    } finally {
        cleanupArtifacts(createdTaskIDs);
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
