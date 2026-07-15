import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
    buildCoordinationHintMessages,
    buildRepetitionHint,
    normalizeCommandIdentity,
} from "./coordination-hints-lib.js";
import { server } from "../plugins/coordination-hints.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, "tmp");

function ensureDir(targetPath) {
    fs.mkdirSync(targetPath, {
        recursive: true,
    });
}

function writeLines(targetPath, count) {
    const lines = [];
    for (let index = 0; index < count; index += 1) {
        lines.push(`# line ${index + 1}`);
    }
    fs.writeFileSync(targetPath, `${lines.join("\n")}\n`, "utf8");
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

// Pure predicate coverage for the C10 command-repetition signal trigger.
// Mirrors the plugin's per-session counting + Anti-spam Set dedup without
// requiring the OpenCode runtime.
function verifyRepetitionHints() {
    // (a) under-threshold: count < 3 -> no hint
    assert(
        buildRepetitionHint("pytest <path>", 2) === null,
        "Under-threshold command count should not produce a repetition hint.",
    );
    assert(
        buildRepetitionHint("pytest <path>", 0) === null,
        "Zero command count should not produce a repetition hint.",
    );

    // (b) threshold: count === 3 -> hint fires
    const atThreshold = buildRepetitionHint("pytest <path>", 3);
    assert(
        atThreshold !== null,
        "Threshold (3) command count should produce a repetition hint.",
    );
    assert(
        atThreshold.key.startsWith("command-repetition:"),
        "Repetition hint key should be namespaced.",
    );
    assert(
        atThreshold.variant === "warning",
        "Repetition hint should be a warning variant.",
    );

    // (c) normalization: pytest a.py (2x) + pytest b.py (1x) collapse to 3
    const samples = [
        { name: "pytest", arguments: "tests/unit/test_foo.py" },
        { name: "pytest", arguments: "tests/unit/test_foo.py" },
        { name: "pytest", arguments: "tests/unit/test_bar.py" },
    ];
    const counts = new Map();
    for (const sample of samples) {
        const identity = normalizeCommandIdentity(sample.name, sample.arguments);
        counts.set(identity, (counts.get(identity) || 0) + 1);
    }
    const identities = [...counts.keys()];
    assert(
        identities.length === 1,
        `Expected normalized identities to collapse to one, got: ${identities.join(", ")}`,
    );
    const collapsedHint = buildRepetitionHint(identities[0], counts.get(identities[0]));
    assert(
        collapsedHint !== null,
        "Collapsed normalized command at threshold should fire a repetition hint.",
    );

    // distinct command shapes do not collapse, so they do not reach threshold
    const distinct = [
        { name: "pytest", arguments: "tests/unit/test_foo.py" },
        { name: "git", arguments: "status" },
        { name: "node", arguments: "--version" },
    ];
    const distinctCounts = new Map();
    for (const sample of distinct) {
        const identity = normalizeCommandIdentity(sample.name, sample.arguments);
        distinctCounts.set(identity, (distinctCounts.get(identity) || 0) + 1);
    }
    for (const [identity, count] of distinctCounts) {
        assert(
            buildRepetitionHint(identity, count) === null,
            `Distinct command "${identity}" should not reach repetition threshold.`,
        );
    }

    // (d) Anti-spam preserved: same identity yields a STABLE key across counts
    // 3..5, so the plugin's per-session Set dedup keeps exactly one entry.
    const seenKeys = new Set();
    for (let count = 3; count <= 5; count += 1) {
        const hint = buildRepetitionHint("pytest <path>", count);
        assert(hint !== null, `Repetition hint should fire at count ${count}.`);
        seenKeys.add(hint.key);
    }
    assert(
        seenKeys.size === 1,
        `Repetition hint key must be stable across threshold counts for Anti-spam dedup; got: ${[...seenKeys].join(", ")}`,
    );

    // (e) array-form arguments collapse the same as string-form
    const arrayForm = normalizeCommandIdentity("pytest", ["tests/unit/test_foo.py"]);
    const stringForm = normalizeCommandIdentity("pytest", "tests/unit/test_foo.py");
    assert(
        arrayForm === stringForm,
        `Array-form and string-form arguments must normalize identically (got "${arrayForm}" vs "${stringForm}").`,
    );

    console.log("repetition verification: ok");
}

// Mechanical proof of the publish-before-await Anti-spam discipline (the F1
// fix from commit 73cdd89). verifyRepetitionHints() above mirrors the plugin's
// counting + dedup logic but is structurally blind to the TEMPORAL ordering of
// `seen.add()` vs `await showHintToast()`: a refactor that moves the
// reservation after the await would reintroduce the duplicate-toast race and
// still pass the pure-predicate coverage. This case instantiates the real
// plugin with a mock client whose `showToast` suspends on a manually-resolved
// deferred, so two `command.executed` events interleave deterministically
// across the await point with no timers.
async function verifyAsyncReentrancy() {
    // Counting mock: every `showToast` call records its payload, then suspends
    // on a shared manual deferred until `release()` resolves it. This pins the
    // first threshold-crossing event at the await point so the re-entrant rival
    // re-enters a handler that — under the regression — has NOT yet published
    // its reservation, and so fires a second toast.
    const makeCountingClient = () => {
        const calls = [];
        let releaseToast;
        const pending = new Promise((resolve) => {
            releaseToast = resolve;
        });
        const client = {
            tui: {
                showToast: async (payload) => {
                    calls.push(payload);
                    await pending;
                },
            },
        };
        return { client, calls, release: () => releaseToast() };
    };

    const { client, calls, release } = makeCountingClient();
    const handler = (await server({ client, directory: "/sandbox" })).event;

    // Distinct sessionID isolates this case from the module-global maps.
    const SID = "async-race-cmd";
    // Four file paths that all normalize to ONE identity ("pytest <path>"), so
    // counts accumulate across them: events 1..2 stay under the threshold
    // (sync early return), event 3 crosses it and suspends at the toast await,
    // and event 4 is the re-entrant rival that must hit the dedup short-circuit.
    const ev = (args) => ({
        event: {
            type: "command.executed",
            properties: { sessionID: SID, name: "pytest", arguments: args },
        },
    });

    await handler(ev("tests/unit/a.py")); // count 1 -> no hint, sync return
    await handler(ev("tests/unit/b.py")); // count 2 -> no hint, sync return
    const p3 = handler(ev("tests/unit/c.py")); // count 3 -> hint -> SUSPENDS at await
    const p4 = handler(ev("tests/unit/d.py")); // count 4 -> must dedup (key reserved by p3)
    release(); // resolve the suspended toast RPC
    await Promise.all([p3, p4]);

    assert(
        calls.length === 1,
        `command.executed re-entrancy must fire exactly one toast; got ${calls.length}`,
    );

    // Hygiene: clear this session's entries from the module-global maps.
    await handler({
        event: {
            type: "session.deleted",
            properties: { info: { id: SID } },
        },
    });

    console.log("async re-entrancy verification: ok");
}

async function main() {
    verifyRepetitionHints();
    await verifyAsyncReentrancy();
    ensureDir(TMP_ROOT);
    const sandbox = fs.mkdtempSync(
        path.join(TMP_ROOT, "verify-coordination-hints-"),
    );

    try {
        ensureDir(path.join(sandbox, "apps", "api", "src"));
        ensureDir(path.join(sandbox, "docs", "coordination"));
        ensureDir(path.join(sandbox, "docs", "planning"));
        ensureDir(path.join(sandbox, "tmp", "agent-runs"));

        writeLines(
            path.join(sandbox, "apps", "api", "src", "large_hint_target.py"),
            380,
        );
        fs.writeFileSync(
            path.join(sandbox, "docs", "coordination", "README.md"),
            "# Coordination\n",
            "utf8",
        );
        fs.writeFileSync(
            path.join(sandbox, "docs", "planning", "backlog.md"),
            "# Backlog\n",
            "utf8",
        );
        fs.writeFileSync(
            path.join(sandbox, "tmp", "agent-runs", "scratch.py"),
            "print('ignore')\n",
            "utf8",
        );

        const hints = buildCoordinationHintMessages({
            directory: sandbox,
            diffFiles: [
                {
                    file: "docs/coordination/README.md",
                    additions: 8,
                    deletions: 0,
                },
                {
                    file: "docs/planning/backlog.md",
                    additions: 3,
                    deletions: 0,
                },
                {
                    file: "apps/api/src/large_hint_target.py",
                    additions: 12,
                    deletions: 1,
                },
                {
                    file: "tmp/agent-runs/scratch.py",
                    additions: 20,
                    deletions: 0,
                },
            ],
        });

        const keys = hints.map((hint) => hint.key).sort();
        assert(
            keys.includes("backlog-cleanup-reminder"),
            "Expected backlog reminder hint.",
        );
        assert(
            keys.includes("coordination-surface-reminder"),
            "Expected coordination-surface reminder hint.",
        );
        assert(
            keys.includes("cross-boundary-slice-warning"),
            "Expected cross-boundary warning hint.",
        );
        assert(
            keys.some((key) => key.startsWith("large-file-warning:")),
            "Expected large-file hint.",
        );
        assert(
            !hints.some((hint) => hint.message.includes("tmp/agent-runs/scratch.py")),
            "Ignored scratch paths should not leak into hint messages.",
        );

        console.log("verification: ok");
        console.log(`hint_keys: ${keys.join(",")}`);
    } finally {
        fs.rmSync(sandbox, {
            recursive: true,
            force: true,
        });
    }
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
