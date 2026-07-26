/**
 * Regression guard: forbid unrendered-token leakage into the working tree.
 *
 * Background: the F3 Slice-7 dogfood once ran the SOURCE copies of the
 * coordinator scripts from templates/core/.opencode/scripts/ (tokens
 * UNRESOLVED) instead of the rendered <repo>/.opencode/scripts/ copies
 * (tokens resolved). The source scripts resolve repoRoot() to templates/core/
 * and write runtime state to literal unrendered paths, polluting the template
 * tree with .local/coordinator/ and
 * .vh-agent-harness/coordinator-adoption.json artifacts. A coordinator
 * path shipping into go:embed would render broken consumer trees; a
 * templates/core/.../coordinator-adoption.json carrying adopted:true would
 * break greenfield coordinator-adoption checks (dir-absent + marker-valid).
 *
 * Two invariants enforced on the working tree:
 *   1. NO path (file or directory NAME) anywhere may contain the literal "{{"
 *      -- an unrendered token must never become a filesystem entry. Template
 *      SOURCE files legitimately contain "{{" in their CONTENT (resolved at
 *      render time); content is NOT scanned, only path names.
 *   2. NO adoption/marker JSON may live under templates/ -- marker files are
 *      runtime state (the legitimate one is
 *      <repo>/.vh-agent-harness/coordinator-adoption.json), never template
 *      source.
 *
 * Self-contained: does NOT import state-lib.js (so it is not blocked by the
 * render-location guard in that module) and runs from either the SOURCE or
 * RENDERED copy. Repo root is found by walking up from __dirname to the
 * nearest directory containing `.git` (polyglot: every consumer render is a
 * git repo, regardless of language; see findRepoRoot).
 *
 * Invoke via the RENDERED copy:
 *   vh-agent-harness exec node .opencode/scripts/verify-no-unrendered-paths.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directories never scanned: version control and third-party deps. Everything
// else in the working tree is in scope, including tmp/ (agent scratch), .local/
// (runtime coordinator state), and .opencode/ (rendered corpus).
const SKIP_DIRS = new Set([".git", "node_modules"]);

function findRepoRoot(start) {
    // Polyglot repo-root detection.
    //
    // ORIGINAL DEFECT (TA-2, class: source-checkout-only assumption): the walk
    // anchored on `go.mod` -- a Go-SPECIFIC manifest. A non-Go consumer (Python
    // or Node) with no go.mod anywhere in the ancestor chain returned null and
    // the script exited 1. This guard is itself the unrendered-paths guard
    // (commit 186ba26); it leaked the very class it guards by assuming the
    // source checkout's own Go layout inside the script meant to catch
    // source-only paths.
    //
    // FIX: anchor on `.git` instead. Every consumer render lives inside a
    // version-controlled checkout, so `.git` is a language-agnostic anchor that
    // resolves identically in Go, Python, Node, and mixed consumers, and stops
    // at the consumer's OWN root rather than walking past it into a parent
    // repo. `.git` may be a directory (normal clone) or a file (submodule /
    // worktree gitdir pointer); both count.
    //
    // Defensive secondary: if no `.git` is reachable (e.g. an unpacked tarball
    // that is not a checkout), fall back to the nearest project manifest
    // (go.mod / pyproject.toml / package.json) so the guard does not exit 1
    // gratuitously on a manifest-rooted but non-git tree.
    const MANIFEST_FILES = ["go.mod", "pyproject.toml", "package.json"];
    let dir = start;
    let manifestRoot = null;
    for (;;) {
        if (fs.existsSync(path.join(dir, ".git"))) {
            return dir; // primary anchor: every consumer render is a git repo.
        }
        if (manifestRoot === null) {
            for (const m of MANIFEST_FILES) {
                if (fs.existsSync(path.join(dir, m))) {
                    manifestRoot = dir; // secondary: remember nearest manifest.
                    break;
                }
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return manifestRoot; // filesystem root reached; manifest fallback (maybe null).
        }
        dir = parent;
    }
}

function scanForViolations(repoRoot) {
    const tokenPaths = [];
    const markerPaths = [];

    function walk(dir, relDir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return; // unreadable directory -- skip silently.
        }
        for (const ent of entries) {
            if (SKIP_DIRS.has(ent.name)) {
                continue;
            }
            const full = path.join(dir, ent.name);
            const rel =
                relDir === "" ? ent.name : `${relDir}/${ent.name}`;

            // Invariant 1: no unrendered token in any path segment.
            if (rel.includes("{{")) {
                tokenPaths.push(rel);
            }

            // Invariant 2: no adoption marker JSON under templates/.
            if (
                (rel === "templates" || rel.startsWith("templates/")) &&
                /adoption/i.test(ent.name) &&
                ent.name.endsWith(".json")
            ) {
                markerPaths.push(rel);
            }

            if (ent.isDirectory()) {
                walk(full, rel);
            }
        }
    }

    walk(repoRoot, "");
    return { tokenPaths, markerPaths };
}

function main() {
    const repoRoot = findRepoRoot(__dirname);
    if (!repoRoot) {
        console.error(
            "FAIL: could not locate repo root (no `.git` and no project " +
                "manifest go.mod/pyproject.toml/package.json found walking " +
                `up from ${__dirname}).`,
        );
        process.exit(1);
    }

    const { tokenPaths, markerPaths } = scanForViolations(repoRoot);

    const failures = [];
    if (tokenPaths.length > 0) {
        failures.push(
            `unrendered token "{{" found in ${tokenPaths.length} path name(s):\n` +
                "  " +
                tokenPaths.join("\n  "),
        );
    }
    if (markerPaths.length > 0) {
        failures.push(
            `adoption marker JSON found under templates/ in ` +
                `${markerPaths.length} path(s):\n  ` +
                markerPaths.join("\n  "),
        );
    }

    if (failures.length > 0) {
        console.error(
            "FAIL: working tree violates the unrendered-path / template-marker " +
                "invariants.\n" +
                "An unrendered token ({{...}}) must never become a filesystem path " +
                "name, and a runtime marker JSON must never live under templates/. " +
                "Run the RENDERED copies of the coordinator scripts at " +
                "<repo>/.opencode/scripts/, never the source copies at " +
                "templates/core/.opencode/scripts/.\n\n" +
                failures.join("\n\n"),
        );
        process.exit(1);
    }

    console.log("verification: ok (2 invariants)");
    console.log(`repo: ${repoRoot}`);
    console.log("invariant 1: no path name contains literal '{{'");
    console.log("invariant 2: no adoption marker JSON under templates/");
}

main();
