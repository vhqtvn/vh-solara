import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildCoordinationHintMessages } from "./coordination-hints-lib.js";

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

function main() {
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
                    file: "tests/fixtures/example-pkg/large_hint_target.py",
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
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
