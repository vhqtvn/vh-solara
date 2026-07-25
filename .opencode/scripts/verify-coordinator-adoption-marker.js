/**
 * Verification harness for the defer-003 coordinator-adoption marker producer.
 *
 * Confirms that a NON-create coordinator write (any op routed through
 * updateCoordinationTask other than the initial save) seeds the committed
 * `.vh-agent-harness/coordinator-adoption.json` marker. This is the matrix
 * row-2 contract: a WRITE is the act of adoption, not mere file presence.
 *
 * Strategy: write a valid draft task fixture directly to disk (bypassing
 * saveCoordinationTask so this harness does not depend on the create path),
 * then exercise a genuine non-create op (`updateCoordinationTaskMetadata`)
 * which routes through `updateCoordinationTask` — the single write chokepoint
 * that now carries the relocated producer block.
 *
 * Invoke via:
 *   vh-agent-harness exec node .opencode/scripts/verify-coordinator-adoption-marker.js
 */
import fs from "fs";
import path from "path";
import {
    repoRoot,
    updateCoordinationTaskMetadata,
    bindSessionName,
} from "./state-lib.js";

const PROBE_TASK_ID = "probe-marker-verify-noncreate-write";
const MARKER_PATH = path.join(
    repoRoot(),
    ".vh-agent-harness",
    "coordinator-adoption.json",
);
const TASK_PATH = path.join(
    repoRoot(),
    ".local",
    "coordinator",
    "tasks",
    `${PROBE_TASK_ID}.json`,
);
const MARKER_CONTENT =
    JSON.stringify({ version: 1, adopted: true }, null, 2) + "\n";

function removeIfExists(targetPath) {
    if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
    }
}

function buildValidDraftFixture() {
    const now = new Date().toISOString();
    return {
        schema_version: 1,
        task_id: PROBE_TASK_ID,
        title: "Marker producer non-create-write probe",
        task_type: "implementation",
        coordination_mode: "short",
        primary_lane: "build",
        research_question: "",
        source_policy: null,
        source_allowlist: [],
        desired_artifact_type: null,
        target_artifact_path: null,
        rough_scope: ["probe fixture for adoption-marker verification"],
        open_questions: [],
        ready_criteria: [],
        files_in_scope: ["tmp/"],
        constraints: [],
        non_goals: [],
        success_criteria: ["The marker file appears after a non-create write."],
        validation_plan: [
            "Run this verify harness and confirm the marker is created.",
        ],
        report_envelope: "standard",
        backlog_id: null,
        workstream_slug: null,
        dependencies: [],
        owner_notes: [],
        status: "draft",
        session_aliases: [],
        active_session_alias: null,
        claimed_at: null,
        report_paths: [],
        review_paths: [],
        latest_report: null,
        last_review: null,
        history: [
            {
                at: now,
                event: "created",
                session_name: "probe-marker-verify",
                status: "draft",
                note: "fixture seeded directly for adoption-marker verification",
            },
        ],
        created_at: now,
        updated_at: now,
    };
}

function assertMarkerPresent(label) {
    if (!fs.existsSync(MARKER_PATH)) {
        throw new Error(
            `FAIL [${label}]: marker was NOT created at ${MARKER_PATH} after a non-create write through updateCoordinationTask.`,
        );
    }
    const content = fs.readFileSync(MARKER_PATH, "utf8");
    if (content !== MARKER_CONTENT) {
        throw new Error(
            `FAIL [${label}]: marker exists but content is wrong. Expected ${JSON.stringify(MARKER_CONTENT)}, got ${JSON.stringify(content)}.`,
        );
    }
}

function main() {
    const sessionID = "probe-marker-verify-session";
    bindSessionName(sessionID, "probe-marker-verify", { cwd: "/verification" });

    // Seed a valid draft task directly to disk (bypasses saveCoordinationTask).
    const fixture = buildValidDraftFixture();
    fs.writeFileSync(TASK_PATH, JSON.stringify(fixture, null, 2) + "\n", "utf8");

    try {
        // Remove the marker so we can prove the non-create op RE-creates it.
        // (If it was already absent, this is a no-op.)
        removeIfExists(MARKER_PATH);

        if (fs.existsSync(MARKER_PATH)) {
            throw new Error(
                "SETUP FAIL: could not remove marker before the non-create write.",
            );
        }

        // ---------------------------------------------------------------
        // Crux: exercise a genuine NON-create op. updateCoordinationTaskMetadata
        // routes through updateCoordinationTask (the single write chokepoint).
        // No saveCoordinationTask / create path is involved.
        // ---------------------------------------------------------------
        updateCoordinationTaskMetadata(sessionID, PROBE_TASK_ID, {
            owner_notes: ["probe: marker should be seeded by this write"],
        });

        assertMarkerPresent("non-create-write via updateCoordinationTaskMetadata");

        console.log("verification: ok");
        console.log(`op: updateCoordinationTaskMetadata (non-create)`);
        console.log(`marker: ${MARKER_PATH}`);
        console.log("contract: non-create coordinator WRITE seeds adoption marker");
    } finally {
        // Clean up the probe task fixture. Leave the marker in place — its
        // content is canonical and the repo benefits from its presence.
        removeIfExists(TASK_PATH);
        // Ensure marker exists after cleanup (restore if the test deleted it
        // but failed before the op re-created it).
        if (!fs.existsSync(MARKER_PATH)) {
            fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
            fs.writeFileSync(MARKER_PATH, MARKER_CONTENT, "utf8");
        }
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
