// verify-no-source-tree-only-paths.js
//
// Regression guard (defect class: source-checkout-only path assumptions in
// consumer renders). A shipped file (under .opencode/ in a consumer render)
// that references a path or heuristic resolving ONLY in the harness's own
// source checkout is BROKEN in a non-Go consumer render: the path ENOENTs,
// the heuristic returns the wrong root, the citation dangles. Three confirmed
// instances (TA-1/TA-2/TA-3) were fixed in commit b69fb1f; this guard prevents
// the class from recurring by scanning the RENDERED .opencode/ tree.
//
// DEFECT CLASS, ONE SENTENCE: a consumer render that references a path or
// heuristic valid only in the source checkout (templates/core/, corpus.go,
// go.mod-at-root assumptions). The source checkout dogfoods itself (it carries
// corpus.go + templates/core at the repo root); a consumer render does NOT.
//
// This is a STATIC SCAN (verify-script), not a render-pipeline change. It
// reuses the two primitives fixed in b69fb1f:
//   - isHarnessSourceCheckout: corpus.go regular-file + templates/core dir at
//     the resolved root (reuses the EXACT predicate from
//     internal/cli/corpus_freshness.go::isSourceCheckout).
//   - findRepoRoot: .git primary anchor (every consumer render is a git repo),
//     go.mod/pyproject.toml/package.json defensive manifest fallback.
// Do NOT reinvent these tests.
//
// === DETECTION (consumer-render mode only; isHarnessSourceCheckout === false) ===
//
// SCOPE: scans the SHIPPED corpus under .opencode/ — agents/, commands/,
// scripts/, skills/, plugins/, docs/, config/, sys-scripts/, tools/, and
// top-level files. It SKIPS runtime-state subtrees (state/, plans/,
// repo-configs/) that hold session memory / generated recon data created at
// runtime and do NOT ship as load-bearing corpus (see RUNTIME_STATE_DIRS). It
// also skips its own file (the guard's documentation legitimately names
// templates/core). The defect class lives entirely in the shipped corpus.
//
//
// PART A — literal "templates/core" path references in rendered .opencode/ files.
//   A reference is ALLOWED if either:
//     (1) COMMENT AUTO-ALLOW — the file is a code file (.js/.mjs/.cjs/.ts/.tsx/
//         .jsx/.sh/.bash/.zsh/.py/.go) AND the trimmed line starts with a
//         line-comment marker for that language (//, /*, *, #). Comments are
//         definitionally non-load-bearing: they are never resolved, read, or
//         walked by a consumer, so a templates/core mention inside a comment
//         cannot break a consumer render. This covers the bulk of legitimate
//         refs (heuristic explanations, background docs, rationale notes) with
//         zero maintenance burden.
//     (2) EXPLICIT ALLOWLIST — the line matches an entry below (file + anchor
//         substring + rationale). This covers the legitimate NON-comment refs:
//         string-literal error/recovery messages that NAME templates/core for
//         the maintainer, docstrings, the deliberate source-tree-exclusion
//         guard in init_skill.py (which DETECTS the source tree rather than
//         consuming a path under it), and descriptive .md prose about harness
//         development. A new legitimate ref of these shapes requires a new
//         allowlist entry — this is the intentional maintenance signal that
//         keeps the gate honest. A new BROKEN ref (load-bearing path read,
//         instructional citation a consumer would resolve) is NOT in the
//         allowlist and is FLAGGED.
//   Otherwise FLAGGED. (markdown/.md has no comment syntax, so EVERY templates/
//   core mention in a .md file is explicit-allowlist-only — this is where the
//   TA-3 citation class lives, so .md cannot be structurally auto-allowed.)
//
// PART B — Go-only repo-root heuristic (TA-2 pattern). A script under
//   .opencode/scripts/ (.js/.sh/.py) that references the Go-SPECIFIC manifest
//   "go.mod" WITHOUT also referencing ".git" (the polyglot primary anchor) is
//   making a source-checkout-only root assumption. FLAGGED. (Every script in the
//   current tree that mentions go.mod also mentions .git — the polyglot fix —
//   so this has zero false positives today and catches the exact TA-2
//   regression shape.)
//
// === MODES ===
//   In SOURCE-CHECKOUT mode (isHarnessSourceCheckout === true), all references
//   are ALLOWED — they resolve against the dev tree that carries them. The
//   guard is a no-op (exit 0) there. The guard is MEANT to run in a consumer
//   render; the source checkout is where it is authored, not where it bites.
//
// === EXIT ===
//   0 if clean (or source-checkout mode); 1 if a disallowed source-tree-only
//   reference is found in consumer-render mode. Each violation prints the
//   offending file:line, the line content, and the suggested fix shape.
//
// Invocation (run the RENDERED copy):
//   vh-agent-harness exec node .opencode/scripts/verify-no-source-tree-only-paths.js
//
// Limitations (honest):
//   - Trailing comments after code (e.g. `foo(); // templates/core`) are NOT
//     auto-allowed (the trimmed line starts with code, not a marker). Such a
//     ref would be flagged until added to the allowlist. None exist today.
//   - Multiline /* ... */ block-comment interiors whose lines do not start with
//     `*` are not auto-allowed. No current corpus instance triggers this.
//   - OVERLAY-CONTRIBUTED FILES: the allowlist references only CORE files
//     (domain-free). An overlay-contributed file that carries a descriptive
//     templates/core ref (e.g. the shipped `release` overlay's releaser.md) will
//     be flagged as a false positive for consumers that select that overlay.
//     This is a known, bounded surface: the core allowlist cannot name overlay
//     files without coupling core to non-core content. Resolution belongs to the
//     overlay (rewrite the ref to a non-literal form) or to a future overlay-
//     aware allowlist mechanism — NOT to core. Base consumers (no overlays) are
//     false-positive-free.
//   - Detection is narrow and literal (no fuzzy/semantic matching). A
//     genuinely-new shape of source-tree-only assumption not expressible as a
//     "templates/core" token or a "go.mod without .git" heuristic would not be
//     caught by this guard; it would need its own detector.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directories never scanned by name (matched at any depth): version control,
// deps, bytecode caches.
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".pytest_cache"]);

// RUNTIME-STATE subtrees under .opencode/ that are NOT shipped corpus. These
// hold session memory, dated plans, and generated recon data created AT RUNTIME
// by repos that run OpenCode sessions (this dev repo dogfoods itself, so it
// accumulates session notes that legitimately reference the source tree). They
// do NOT ship as load-bearing corpus to a fresh consumer render, and the
// shipped fixtures that do live under them carry no consumer-resolved paths
// (verified: zero templates/core refs under templates/core/.opencode/
// {state,plans,repo-configs}). Scanning them would false-positive on dev notes;
// skipping them scopes the guard to the corpus a consumer actually receives and
// resolves — agents/commands/scripts/skills/plugins/docs content. The defect
// class (TA-1/TA-2/TA-3) lives entirely in that shipped corpus.
const RUNTIME_STATE_DIRS = new Set(["state", "plans", "repo-configs"]);

// --- Repo root (polyglot; reused from b69fb1f, do not reinvent) ---
//
// Anchors on ".git" (every consumer render is a git repo, language-agnostic)
// with go.mod/pyproject.toml/package.json as a defensive manifest fallback for
// an unpacked-tarball-style tree that is not a checkout. ".git" may be a
// directory (normal clone) or a file (submodule / worktree gitdir pointer).
function findRepoRoot(start) {
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
            return manifestRoot; // filesystem root; manifest fallback (maybe null).
        }
        dir = parent;
    }
}

// --- Source-checkout identity (reused from b69fb1f, do not reinvent) ---
//
// Mirrors internal/cli/corpus_freshness.go::isSourceCheckout (the dev-stale-
// embed guard): a target is the harness's OWN source checkout iff a REGULAR
// FILE corpus.go AND a DIRECTORY templates/core both sit at the resolved root.
// NOTE: the path is built from separate join segments ("templates","core") so
// this script's own source never matches its TOKEN_RE (no literal "templates/
// core" string appears in this executable predicate).
function isHarnessSourceCheckout(repoRoot) {
    if (!repoRoot) {
        return false;
    }
    let corpusStat = null;
    try {
        corpusStat = fs.statSync(path.join(repoRoot, "corpus.go"));
    } catch {
        corpusStat = null;
    }
    if (!corpusStat || !corpusStat.isFile()) {
        return false;
    }
    let tmplStat = null;
    try {
        tmplStat = fs.statSync(path.join(repoRoot, "templates", "core"));
    } catch {
        tmplStat = null;
    }
    return !!tmplStat && tmplStat.isDirectory();
}

// --- Token + comment detection ---
//
// TOKEN_RE matches "templates/core" not followed by a word char, so it catches
// templates/core/, templates/core., templates/core" / templates/core` / EOL, but
// NOT templates/coreXYZ (a different identifier). Narrow and literal.
const TOKEN_RE = /templates\/core(?![A-Za-z0-9_])/;

// Line-comment markers per code extension. A line whose trim() starts with one
// of its file's markers is a comment → auto-allowed (non-load-bearing). markdown
// and other prose formats have NO entry here → every templates/core mention in
// them is explicit-allowlist-only.
const CODE_COMMENT_MARKERS = {
    ".js": ["//", "/*", "*"],
    ".mjs": ["//", "/*", "*"],
    ".cjs": ["//", "/*", "*"],
    ".ts": ["//", "/*", "*"],
    ".tsx": ["//", "/*", "*"],
    ".jsx": ["//", "/*", "*"],
    ".go": ["//", "/*", "*"],
    ".sh": ["#"],
    ".bash": ["#"],
    ".zsh": ["#"],
    ".py": ["#"],
};

function lineIsComment(relPath, trimmedLine) {
    const ext = path.extname(relPath);
    const markers = CODE_COMMENT_MARKERS[ext];
    if (!markers) {
        return false; // prose/no-extension → no comment auto-allow.
    }
    for (const m of markers) {
        if (trimmedLine.startsWith(m)) {
            return true;
        }
    }
    return false;
}

// --- Explicit allowlist (NON-comment legitimate templates/core refs) ---
//
// Each entry: { file, anchor, why }. `file` is repo-relative. A non-comment
// line containing the token is ALLOWED iff an entry for that file has
// `line.includes(entry.anchor)`. `why` documents WHY the ref is legitimate so a
// future maintainer knows the ref is intentional (not a regression). Adding a
// new legitimate non-comment ref requires a new entry here — the maintenance
// signal that keeps false positives off the gate.
//
// Categories of legitimate non-comment refs allowlisted below:
//   (a) string-literal error/recovery messages that NAME templates/core for the
//       maintainer reading the message (state-lib.js render-location guard,
//       verify-no-unrendered-paths.js recovery hint);
//   (b) docstrings / warning text in init_skill.py;
//   (c) the deliberate source-tree-EXCLUSION guard in init_skill.py (it DETECTS
//       the source tree via a string membership test — it never reads a path
//       UNDER templates/core; it is the guard, not a consumer of the path);
//   (d) descriptive .md prose in CORE skill docs (describe WHERE the harness
//       source lives or HOW to develop it — never an instructional citation a
//       consumer would resolve).
//
// DOMAIN-FREE DISCIPLINE: the allowlist references ONLY files that ship via
// templates/core/ (the core corpus). It MUST NOT name overlay-contributed or
// dogfood-only files (e.g. release-overlay agents, dogfood-only readiness
// docs): those are not core, and embedding their paths here would violate the
// domain-free rule and couple core to non-core content. See LIMITATIONS below
// for the known false-positive surface this creates on overlay-contributed
// files that carry descriptive templates/core refs.
const ALLOWLIST = [
    {
        file: ".opencode/scripts/state-lib.js",
        anchor: "REFUSING to load state-lib.js from an UNRENDERED",
        why: "Render-location guard error message: names templates/core to tell the maintainer the source (unrendered) copy was invoked instead of the rendered one. Non-load-bearing text.",
    },
    {
        file: ".opencode/scripts/state-lib.js",
        anchor: "writes stray runtime artifacts",
        why: "Continuation of the same render-location guard error message; describes the consequence of running the source copy. Non-load-bearing text.",
    },
    {
        file: ".opencode/scripts/verify-no-unrendered-paths.js",
        anchor: ".opencode/scripts/.\\n\\n",
        why: "Recovery-hint string literal in the FAIL message: tells the maintainer to run the RENDERED copies at <repo>/.opencode/scripts/, never the source copies at templates/core/.opencode/scripts/. Names the source path to redirect away from it. Non-load-bearing text.",
    },
    {
        file: ".opencode/skills/skill-creator/scripts/init_skill.py",
        anchor: "to develop the harness itself",
        why: "Module docstring: documents that the .opencode/skills default is correct ONLY when editing the source tree to develop the harness. Descriptive prose, not a path read.",
    },
    {
        file: ".opencode/skills/skill-creator/scripts/init_skill.py",
        anchor: "harness-development source tree",
        why: "Function docstring: documents the deliberate EXCLUSION of the source tree from the generated-target check. Descriptive prose.",
    },
    {
        file: ".opencode/skills/skill-creator/scripts/init_skill.py",
        anchor: '" in s:',
        why: "Deliberate source-tree-EXCLUSION guard: `if \"templates/core/.opencode\" in s: return False`. This DETECTS the source tree (so the generated-skills warning stays silent when developing the harness) — it never reads a file UNDER templates/core. It is the guard, not a consumer of the path.",
    },
    {
        file: ".opencode/skills/skill-creator/scripts/init_skill.py",
        anchor: "ONLY when developing the harness itself",
        why: "Warning-message format string: tells the operator to edit the generated tree only when developing the harness. Non-load-bearing text.",
    },
    {
        file: ".opencode/skills/skill-creator/references/skill-lifecycle.md",
        anchor: "how new core skills reach",
        why: "Skill-lifecycle doc: describes the boundary by which new core skills reach templates/core/. Descriptive.",
    },
    {
        file: ".opencode/skills/skill-creator/references/skill-lifecycle.md",
        anchor: "promotion to",
        why: "Skill-lifecycle S2 rule: a new core skill must pilot before promotion to templates/core/. Descriptive process rule.",
    },
    {
        file: ".opencode/skills/skill-creator/references/skill-lifecycle.md",
        anchor: "ships into every consumer's baseline context-load",
        why: "Rationale for S2: templates/core ships into every consumer's context. Descriptive justification.",
    },
    {
        file: ".opencode/skills/skill-creator/SKILL.md",
        anchor: "i.e. developing the harness itself",
        why: "Skill guidance: the .opencode/skills path is correct only when developing the harness (editing templates/core/). Descriptive scope rule.",
    },
    {
        file: ".opencode/skills/skill-creator/SKILL.md",
        anchor: "to develop the harness itself",
        why: "Skill guidance: load the skill only when editing templates/core/ to develop the harness. Descriptive scope rule.",
    },
    {
        file: ".opencode/skills/skill-creator/SKILL.md",
        anchor: "are developing the harness itself",
        why: "Skill guidance: the skill is for developing the harness itself (templates/core/). Descriptive scope rule.",
    },
    {
        file: ".opencode/skills/harness-operator/SKILL.md",
        anchor: "in the working tree?** Run",
        why: "Operator guidance: editing templates/core/ in the working tree requires make update. Descriptive workflow rule.",
    },
    {
        file: ".opencode/skills/harness-operator/SKILL.md",
        anchor: "target carrying both",
        why: "dev-stale-embed guard doc: describes the source-checkout marker (corpus.go + templates/core/). Descriptive.",
    },
    {
        file: ".opencode/skills/harness-operator/SKILL.md",
        anchor: "(rebuild first)",
        why: "dev-stale-embed recovery: make update rebuilds first because the embedded corpus must match templates/core/. Descriptive.",
    },
    {
        file: ".opencode/skills/harness-operator/SKILL.md",
        anchor: "target without both",
        why: "dev-stale-embed scope: a consumer (no corpus.go + templates/core/) is unaffected by the guard. Descriptive.",
    },
];

// Index the allowlist by file for O(1) per-line lookup.
const ALLOWLIST_BY_FILE = new Map();
for (const e of ALLOWLIST) {
    if (!ALLOWLIST_BY_FILE.has(e.file)) {
        ALLOWLIST_BY_FILE.set(e.file, []);
    }
    ALLOWLIST_BY_FILE.get(e.file).push(e);
}

function lineIsAllowlisted(relPath, line) {
    const entries = ALLOWLIST_BY_FILE.get(relPath);
    if (!entries) {
        return false;
    }
    for (const e of entries) {
        if (line.includes(e.anchor)) {
            return true;
        }
    }
    return false;
}

// --- Part B: Go-only repo-root heuristic (TA-2 pattern) ---
//
// A script under .opencode/scripts/ whose CODE (non-comment lines) references
// the Go-SPECIFIC manifest "go.mod" WITHOUT also referencing ".git" (the
// polyglot primary anchor) in code is making a source-checkout-only root
// assumption. Comment-only mentions of .git (e.g. a TODO to add a polyglot
// anchor) do NOT count as the anchor — only code does. Returns the list of
// offending repo-relative script paths.
const PART_B_EXTS = new Set([".js", ".mjs", ".cjs", ".sh", ".bash", ".zsh", ".py"]);

function findGoModOnlyScripts(scriptsDir, repoRoot) {
    const offenders = [];
    let entries;
    try {
        entries = fs.readdirSync(scriptsDir, { withFileTypes: true });
    } catch {
        return offenders; // no scripts dir — nothing to check.
    }
    for (const ent of entries) {
        if (!ent.isFile()) {
            continue;
        }
        if (!PART_B_EXTS.has(path.extname(ent.name))) {
            continue;
        }
        const full = path.join(scriptsDir, ent.name);
        const relPath = path.relative(repoRoot, full);
        let src;
        try {
            src = fs.readFileSync(full, "utf8");
        } catch {
            continue;
        }
        // Non-comment line analysis: go.mod in code without .git in code.
        const lines = src.split(/\r?\n/);
        let goModInCode = false;
        let gitInCode = false;
        for (const line of lines) {
            if (lineIsComment(relPath, line.trim())) {
                continue;
            }
            if (line.includes("go.mod")) {
                goModInCode = true;
            }
            if (line.includes(".git")) {
                gitInCode = true;
            }
        }
        if (goModInCode && !gitInCode) {
            offenders.push(relPath);
        }
    }
    return offenders;
}

// --- Part A scan: walk .opencode/, flag disallowed templates/core refs ---
function scanForSourceTreeRefs(opencodeDir, repoRoot) {
    const violations = [];

    function walk(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return; // unreadable — skip silently.
        }
        for (const ent of entries) {
            if (SKIP_DIRS.has(ent.name) || RUNTIME_STATE_DIRS.has(ent.name)) {
                continue;
            }
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                walk(full);
                continue;
            }
            if (!ent.isFile()) {
                continue;
            }
            // Self-skip: this guard's own allowlist rationale strings and
            // messages legitimately name templates/core to document the defect
            // class they guard against. The script's executable predicate
            // (isHarnessSourceCheckout) builds its path from separate join
            // segments and never carries the literal token, so a load-bearing
            // self-reference cannot sneak in via the predicate.
            if (path.resolve(full) === __filename) {
                continue;
            }
            const relPath = path.relative(repoRoot, full);
            let src;
            try {
                src = fs.readFileSync(full, "utf8");
            } catch {
                continue;
            }
            const lines = src.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!TOKEN_RE.test(line)) {
                    continue;
                }
                const trimmed = line.trim();
                // (1) comment auto-allow for code files.
                if (lineIsComment(relPath, trimmed)) {
                    continue;
                }
                // (2) explicit allowlist.
                if (lineIsAllowlisted(relPath, line)) {
                    continue;
                }
                violations.push({
                    part: "A",
                    file: relPath,
                    lineNo: i + 1,
                    line: trimmed,
                });
            }
        }
    }

    walk(opencodeDir);
    return violations;
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

    // Source-checkout mode: refs resolve against the dev tree — no-op.
    if (isHarnessSourceCheckout(repoRoot)) {
        console.log("verification: ok (source-checkout mode — refs resolve; guard is a no-op here)");
        console.log(`repo: ${repoRoot}`);
        return;
    }

    // Consumer-render mode: scan the rendered .opencode/ tree.
    const opencodeDir = path.join(repoRoot, ".opencode");
    if (!fs.existsSync(opencodeDir)) {
        console.error(
            `FAIL: no .opencode/ directory at ${repoRoot}; nothing to scan.`,
        );
        process.exit(1);
    }

    const violations = scanForSourceTreeRefs(opencodeDir, repoRoot);

    // Part B: Go-only repo-root heuristic in .opencode/scripts/.
    const scriptsDir = path.join(opencodeDir, "scripts");
    for (const f of findGoModOnlyScripts(scriptsDir, repoRoot)) {
        violations.push({
            part: "B",
            file: f,
            lineNo: 0,
            line: "(file references go.mod without the polyglot .git anchor)",
        });
    }

    if (violations.length > 0) {
        const parts = violations.map((v) => {
            if (v.part === "A") {
                return (
                    `[A] ${v.file}:${v.lineNo}\n` +
                    `      ${v.line}\n` +
                    `      -> disallowed source-tree-only "templates/core" reference in a consumer render.\n` +
                    `         Fix: rewrite to a consumer-relative path (resolves under .opencode/), or gate\n` +
                    `         the reference behind isHarnessSourceCheckout, or move the mention into a comment.\n` +
                    `         If the ref is legitimately non-load-bearing, add an ALLOWLIST entry with a rationale.`
                );
            }
            return (
                `[B] ${v.file}\n` +
                `      ${v.line}\n` +
                `      -> Go-only repo-root heuristic (TA-2 pattern): references go.mod without the\n` +
                `         polyglot .git anchor. Fix: anchor findRepoRoot on .git (every consumer render is a\n` +
                `         git repo) with go.mod/pyproject.toml/package.json as a defensive manifest fallback.`
            );
        });
        console.error(
            "FAIL: " +
                violations.length +
                " source-tree-only reference(s) found in consumer-render mode.\n" +
                "A shipped file under .opencode/ must not reference a path or heuristic that only\n" +
                "resolves in the harness source checkout (templates/core/, corpus.go, go.mod-at-root).\n" +
                "Such a reference silently breaks (ENOENT / wrong-root / dangling citation) in every\n" +
                "non-Go consumer render.\n\n" +
                parts.join("\n\n"),
        );
        process.exit(1);
    }

    console.log("verification: ok (consumer-render mode — no source-tree-only paths)");
    console.log(`repo: ${repoRoot}`);
    console.log("part A: no disallowed templates/core references in rendered .opencode/");
    console.log("part B: no Go-only repo-root heuristics in .opencode/scripts/");
}

main();
