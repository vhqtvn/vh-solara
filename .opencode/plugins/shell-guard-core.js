// shell-guard-core.js — the pure shell-guard decision engine, extracted from
// shell-guard.js so BOTH the OpenCode plugin AND the Go permission bridge's
// node CLI shim (shell-guard/eval.js) import ONE source of truth for the rules.
//
// This module holds NO OpenCode coupling: no `server()`, no `tool.execute.before`
// handler, no input/output objects. It takes a command string and returns a
// verdict object `{ action, reason }`. The OpenCode-specific `read`-tool branch
// stays in shell-guard.js (it needs OpenCode's tool args + repoRoot + fs).
//
// DRY invariant: shell-guard.js and shell-guard/eval.js both import `evaluate`
// from here. There is exactly ONE rule-load path:
//   shell-guard-core.js -> ../repo-configs/forbidden-patterns.js (aggregator)
//                                            -> forbidden-patterns.core.js
//                                            -> forbidden-patterns.project.js (opt)
//
// Classification (slice 4b): the bash-branch decision body that lived inline in
// the plugin's `tool.execute.before` handler is ported here VERBATIM, with the
// three OpenCode verbs translated to a plain return contract:
//   throw new Error(msg)        -> return { action:"deny",  reason: msg }
//   console.error(hint); return -> return { action:"ask",   reason: hint }
//   bare return (all checks ok) -> return { action:"allow", reason: "" }
// evaluate NEVER throws on a deny — it returns it. It throws ONLY on an engine
// fault (WASM load failure, rule-import fault) so the caller (eval.js / the Go
// hook) fails safe.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../repo-configs/allowed-commands.js";
import { FORBIDDEN_PATTERNS } from "../repo-configs/forbidden-patterns.js";
// NOTE: web-tree-sitter is imported LAZILY inside getBashParser() (dynamic
// import), so the engine loads even when the optional WASM parser is absent.
// parseCommands() then degrades to a naive tokenizer (see fallbackParse). The
// forbidden-pattern regex scan + allowlist still enforce; only AST-level
// precision is lost until the parser is installed. Auto-upgrades when present.
import { createRequire } from "node:module";

// ESM does not provide __dirname; derive it the same way state-lib.js does.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const id = "shell-guard";

// Exported for test reuse — mirrors the inline regex used in the
// tool.execute.before handler to recognise the operator escape hatch.
export const SKIP_COMMIT_GATE_RE = /^\s*SKIP_COMMIT_GATE\s*=\s*1(\s|$)/;

function denyByForbiddenPatterns(command) {
    for (const rule of FORBIDDEN_PATTERNS) {
        if (!rule.re.test(command)) continue;
        if (rule.allowIf && rule.allowIf.test(command)) continue;
        return rule;
    }
    return null;
}

// Exported for test reuse.  Hard deny: always returns false.
// SKIP_COMMIT_GATE=1 suppression was never implemented for agents — the operator
// escape hatch is enforced at the gate-script level (commit-gate.sh), not here.
// Keeping the export so test-13 can assert the "always deny" contract.
export function shouldSuppressForbidden(command, forbiddenId) {
    return false;
}

function trimEndStar(cmd) {
    return cmd.replace(/\s*\*?$/, "");
}

// Read-only commands and gate commands pass through without restriction.
// Git mutation commands (add, commit, push, etc.) are blocked by the
// git-mutation-bypass forbidden pattern.  The committer agent is the sole
// git-write agent and uses the commit-gate wrapper.  See
// .opencode/docs/git-execution-routing.md.
const ALLOWED_PATTERNS = COMMANDS.readonly
    .concat(COMMANDS.git_readonly)
    .concat(COMMANDS.gate)
    .concat(["vh-agent-harness *"])
    .map((pattern) => {
        const prefix = trimEndStar(pattern);
        return {
            pattern,
            tokens: prefix.split(/\s+/).filter(Boolean),
            wildcard: pattern.trim().endsWith("*"),
        };
    });

// Set of read-only git subcommands for fast lookup when generating routing hints.
const GIT_READONLY_SUBCOMMANDS = new Set(
    COMMANDS.git_readonly.map((c) => {
        const parts = trimEndStar(c).split(/\s+/);
        return parts.length >= 2 ? parts[1] : null;
    }).filter(Boolean),
);

const require = createRequire(import.meta.url);

let bashParserPromise;

async function getBashParser() {
    if (!bashParserPromise) {
        bashParserPromise = (async () => {
            const { Parser, Language } = await import("web-tree-sitter");
            await Parser.init({
                locateFile() {
                    return require.resolve("web-tree-sitter/tree-sitter.wasm");
                },
            });
            const parser = new Parser();
            parser.setLanguage(
                await Language.load(
                    require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"),
                ),
            );
            return parser;
        })();
    }

    return bashParserPromise;
}

function commandParts(node) {
    const out = [];
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        if (child.type === "command_elements") {
            for (let j = 0; j < child.childCount; j++) {
                const item = child.child(j);
                if (
                    !item ||
                    item.type === "command_argument_sep" ||
                    item.type === "redirection"
                ) {
                    continue;
                }
                out.push(item.text);
            }
            continue;
        }
        if (
            child.type !== "command_name" &&
            child.type !== "command_name_expr" &&
            child.type !== "word" &&
            child.type !== "string" &&
            child.type !== "raw_string" &&
            child.type !== "concatenation"
        ) {
            continue;
        }
        out.push(child.text);
    }
    return out;
}

async function parseCommands(command) {
    let parser;
    try {
        parser = await getBashParser();
    } catch (err) {
        // web-tree-sitter / tree-sitter-bash unavailable: degrade to a naive
        // tokenizer so the gate REMAINS FUNCTIONAL (allowlist + forbidden
        // patterns still enforce) without the optional WASM binary. This keeps
        // `vh-agent-harness exec` working on a freshly-installed generic harness where
        // the parser npm deps are not vendored. The forbidden-pattern regex
        // scan (run earlier on the raw string) is unaffected; only AST-level
        // precision (subshells, process substitution, redirect targets) is
        // lost. Auto-upgrades to the AST path when the parser is installed.
        return fallbackParse(command);
    }
    const tree = parser.parse(command);
    if (!tree) {
        throw new Error("Failed to parse command.");
    }

    return tree.rootNode
        .descendantsOfType("command")
        .map(commandParts)
        .filter((tokens) => tokens.length > 0);
}

// fallbackParse is the naive tokenizer used when the WASM bash parser is
// unavailable. It splits the command on shell separators (;, &&, ||, newlines,
// pipes) into individual commands, then tokenizes each by whitespace with
// surrounding-quote stripping. This mirrors commandParts() for the simple
// command case. It is CONSERVATIVE: complex constructs that it mis-tokenizes
// are more likely to fail the allowlist (false deny, safe) than to falsely
// pass, and the forbidden-pattern regex scan already ran on the raw string.
function fallbackParse(command) {
    return command
        .split(/(?:\r?\n|;|&&|\|\||\|)/)
        .map((seg) => seg.trim())
        .filter((seg) => seg.length > 0)
        .map((seg) =>
            seg
                .split(/\s+/)
                .map((tok) => {
                    if (
                        (tok.startsWith('"') && tok.endsWith('"')) ||
                        (tok.startsWith("'") && tok.endsWith("'"))
                    ) {
                        return tok.slice(1, -1);
                    }
                    return tok;
                })
                .filter((tok) => tok.length > 0),
        )
        .filter((tokens) => tokens.length > 0);
}

function matchesPattern(tokens, pattern) {
    if (tokens.length < pattern.tokens.length) {
        return false;
    }

    for (let i = 0; i < pattern.tokens.length; i++) {
        if (tokens[i] !== pattern.tokens[i]) {
            return false;
        }
    }

    return pattern.wildcard || tokens.length === pattern.tokens.length;
}

// Strip leading env-var assignments (e.g. "SKIP_COMMIT_GATE=1") from parsed
// tokens so that commands like `SKIP_COMMIT_GATE=1 .opencode/scripts/commit-gate.sh acquire ...`
// match the gate allowlist patterns.  Env-var prefixes are transparent to the
// actual command being executed in bash.
const ENV_VAR_ASSIGNMENT_RE = /^[A-Z_][A-Z_0-9]*=/;

export function stripLeadingEnvVars(tokens) {
    let i = 0;
    while (i < tokens.length && ENV_VAR_ASSIGNMENT_RE.test(tokens[i])) {
        i++;
    }
    return tokens.slice(i);
}

// Strip leading env-var assignments from a raw command string (not parsed
// tokens).  Used to normalize commands like `FOO=1 vh-agent-harness exec ...` so
// that the harness branch fires even when prefixed by env vars.
const LEADING_ENV_VARS_FROM_STRING_RE = /^(\s*[A-Za-z_][A-Za-z0-9_]*=\S+\s*)+/;

export function stripLeadingEnvVarsFromString(cmd) {
    return cmd.replace(LEADING_ENV_VARS_FROM_STRING_RE, "");
}

// ---------------------------------------------------------------------------
// Optional `git -C <path>` support.
//
// Background: the `git_readonly` allowlist matches bare `git <subcommand>` token
// sequences, and the `git-mutation-bypass` forbidden regex matches
// `\bgit\s+(add|commit|...)\b`. Neither fires when a `-C <path>` is inserted
// between `git` and the subcommand, so:
//   - `git -C <valid> log` falls through to opencode's permission gate (prompt),
//     instead of being cleanly allowed like `git log`.
//   - `git -C <valid> commit` slips PAST `git-mutation-bypass` (a real hole).
//
// Fix: after parseCommands + env-var strip, if the token sequence is
// `git -C <path> <rest...>` with a SINGLE, well-formed, in-project <path>, strip
// the `-C <path>` so both downstream checks see the normalized `git ...` form.
// Mutations are then re-caught by re-running denyByForbiddenPatterns on the
// stripped reconstruction (single source of truth for mutation verbs — we do
// NOT duplicate the verb list), and readonly subcommands match the allowlist.
//
// Anything out-of-project, malformed, multiple, or a symlink escape is a hard
// deny. Non-git commands and git commands without `-C` are returned unchanged.
// ---------------------------------------------------------------------------

// Repo root derived from this file's location (.opencode/plugins/shell-guard-core.js
// -> two levels up). Mirrors the proven repoRoot() in state-lib.js. We compute
// it locally instead of importing the 5000-line state-lib.js into the engine.
// Do NOT use process.cwd() — the plugin runs in opencode server context where
// cwd is unreliable. (cwd-robustness is exactly why the Go bridge spawns node
// with an explicit cwd = HarnessRoot.)
export function repoRoot() {
    return path.resolve(__dirname, "..", "..");
}

// ---------------------------------------------------------------------------
// `read` tool: short-circuit NON-EXISTENT paths to a not-found error instead
// of letting opencode raise a permission prompt.
//
// WHY: agents sometimes hallucinate an absolute path (e.g. a wrong home dir
// `/home/<operator-typo>/...`). Out-of-project paths prompt for confirmation, and a
// hallucinated path that doesn't exist would also fail the read AFTER the
// operator approves — pure friction. Operator decision (2026-06-15): for a
// read of a path that does NOT exist, raise "not found" immediately (no
// prompt). The tradeoff — leaking existence (not-found vs prompt) — is
// accepted in exchange for killing the confirmation noise. Existing paths
// (in- or out-of-project) still fall through to the normal permission table.
//
// Resolve relative paths against the repo root (NOT process.cwd(), unreliable
// in the plugin server context — mirrors validateGitCPath).
// ---------------------------------------------------------------------------
export function resolveReadPath(filePath, root) {
    if (!filePath || typeof filePath !== "string") return null;
    return path.isAbsolute(filePath)
        ? filePath
        : path.resolve(root || repoRoot(), filePath);
}

// Remove a single layer of surrounding single or double quotes from a token's
// raw .text (tree-sitter keeps the quotes). `git -C "sub dir" log` parses the
// path token as `"sub dir"`.
export function unquoteToken(text) {
    if (text.length >= 2) {
        const first = text[0];
        const last = text[text.length - 1];
        if (
            (first === '"' && last === '"') ||
            (first === "'" && last === "'")
        ) {
            return text.slice(1, -1);
        }
    }
    return text;
}

// Two-tier in-project path validation for `git -C <path>`.
//
// Tier 1 (lexical, no fs): resolve relative to repoRoot and confirm the target
//   is the repo root itself or beneath it. Catches `..` escapes and absolute
//   paths outside the repo immediately; works for non-existent paths too.
// Tier 2 (symlink, fs): if the lexical target exists, realpath both the target
//   and the repo root and re-confirm containment on the realpaths. Catches
//   symlink escapes. If the path does not yet exist, Tier 1 is authoritative
//   (a non-existent path cannot yet be a symlink escape).
//
// Returns { ok: true } or { ok: false, reason }.
export function validateGitCPath(unquotedPath, root) {
    const repoRootPath = root || repoRoot();
    let target;
    try {
        target = path.resolve(repoRootPath, unquotedPath);
    } catch (e) {
        return {
            ok: false,
            reason: `git -C path could not be resolved: ${unquotedPath}`,
        };
    }
    const inProject =
        target === repoRootPath ||
        target.startsWith(repoRootPath + path.sep);
    if (!inProject) {
        return {
            ok: false,
            reason: `git -C path escapes repo root: ${unquotedPath}`,
        };
    }
    if (fs.existsSync(target)) {
        let realTarget;
        let realRoot;
        try {
            realTarget = fs.realpathSync(target);
            realRoot = fs.realpathSync(repoRootPath);
        } catch (e) {
            return {
                ok: false,
                reason: `git -C path could not be resolved (realpath): ${unquotedPath}`,
            };
        }
        const realInProject =
            realTarget === realRoot ||
            realTarget.startsWith(realRoot + path.sep);
        if (!realInProject) {
            return {
                ok: false,
                reason: `git -C path is a symlink escaping repo root: ${unquotedPath}`,
            };
        }
    }
    return { ok: true };
}

// Validate and strip a SINGLE leading `git -C <path>` from env-stripped tokens.
//
// Input tokens MUST already have leading env-var assignments removed
// (stripLeadingEnvVars). Returns:
//   { tokens, deny: null }           — normalized (or unchanged if no -C)
//   { tokens, deny: "<reason>" }     — malformed / out-of-project / symlink escape
//
// The returned `tokens` always has length >= 1 when input does. On deny, the
// caller throws before any allowlist check runs.
export function normalizeGitC(tokens, root) {
    if (tokens.length === 0 || tokens[0] !== "git") {
        return { tokens, deny: null };
    }
    // Only a single optional leading `-C <path>` before the subcommand.
    if (tokens.length < 2 || tokens[1] !== "-C") {
        return { tokens, deny: null };
    }
    // tokens[1] === "-C" from here on.
    // Need at least `git -C <path> <subcommand>` (4 tokens).
    if (tokens.length < 4) {
        return {
            tokens,
            deny: "git -C requires a path and a subcommand",
        };
    }
    const pathToken = tokens[2];
    // The path argument must not itself be a flag (e.g. `git -C --git-dir log`).
    if (pathToken.startsWith("-")) {
        return {
            tokens,
            deny: `git -C path argument looks like a flag: ${pathToken}`,
        };
    }
    // Reject multiple `-C` (e.g. `git -C a -C b log`).
    if (tokens.length >= 5 && tokens[3] === "-C") {
        return {
            tokens,
            deny: "multiple git -C flags are not allowed",
        };
    }
    const unquoted = unquoteToken(pathToken);
    const validation = validateGitCPath(unquoted, root);
    if (!validation.ok) {
        return { tokens, deny: validation.reason };
    }
    // Strip `-C` and the path, keep `git` + the rest.
    return {
        tokens: [tokens[0], ...tokens.slice(3)],
        deny: null,
    };
}

// Detect whether a command string is a vh-agent-harness exec invocation that
// attempts to reach commit-gate.sh.  Used by the engine and exported for
// test reuse.
export function isGateWrapperInDevShExec(cmd) {
    const normalized = stripLeadingEnvVarsFromString(cmd).trim();
    if (!normalized.startsWith("vh-agent-harness ")) return false;
    // Use includes (not startsWith) to catch nested invocations like:
    // vh-agent-harness exec bash -c '.opencode/scripts/commit-gate.sh ...'
    // False positives here are safe (over-blocking) vs under-blocking (bypass)
    return normalized.includes("commit-gate.sh");
}

// Detect `ENV1=x ENV2=y vh-agent-harness exec ...` (one or more leading env-var
// assignments directly before vh-agent-harness exec). A host-shell env prefix sets
// vars on the HOST and never reaches the container — they must go inside:
//   vh-agent-harness exec bash -c 'ENV=value your-cmd'
//
// Uses stripLeadingEnvVarsFromString (NOT the token-based stripLeadingEnvVars)
// because commandParts() skips tree-sitter `variable_assignment` nodes, so the
// parsed-token path cannot see the prefix. The string normalizer is the same
// helper the harness branch relies on.
export function isEnvPrefixedDevShExec(cmd) {
    const trimmed = cmd.trim();
    const stripped = stripLeadingEnvVarsFromString(trimmed);
    if (stripped === trimmed) return false; // no leading env-var prefix
    const PREFIX = "vh-agent-harness exec";
    return stripped === PREFIX || stripped.startsWith(PREFIX + " ");
}

function isAllowedCommand(tokens) {
    const stripped = stripLeadingEnvVars(tokens);
    if (stripped.length === 0) return false;
    return ALLOWED_PATTERNS.some((pattern) => matchesPattern(stripped, pattern));
}

// ---------------------------------------------------------------------------
// evaluate(command) — the single decision entrypoint.
//
// Ported VERBATIM from the bash branch of the plugin's tool.execute.before
// handler (the procedural body that ran on every `bash` tool invocation). The
// OpenCode verbs are translated to a plain { action, reason } return:
//   throw new Error(msg)        -> { action:"deny",  reason: msg }
//   console.error(hint); return -> { action:"ask",   reason: hint }
//   bare return (all checks ok) -> { action:"allow", reason: "" }
//
// contract:
//   - NEVER throws on a deny — returns it.
//   - Throws ONLY on an engine fault (WASM/parser/rule-import) so eval.js and
//     the Go hook fail safe (exit 2 / Deny).
//   - Empty / null / whitespace command -> { action:"deny", reason:"empty command" }.
//   - command is a STRING (mirrors output.args.command). The Go bridge joins
//     argv with single spaces before calling node.
// ---------------------------------------------------------------------------
export async function evaluate(command) {
    // Empty / null / whitespace command guard.
    if (command == null || (typeof command === "string" && command.trim() === "")) {
        return { action: "deny", reason: "empty command" };
    }

    const forbidden = denyByForbiddenPatterns(command);
    if (forbidden) {
        // shouldSuppressForbidden is a hard deny (always false).
        // The operator escape hatch is handled at the gate-script
        // level; shell-guard never suppresses forbidden patterns.
        if (!shouldSuppressForbidden(command, forbidden.id)) {
            return {
                action: "deny",
                reason:
                    `Blocked by shell-guard rule '${forbidden.id}': ${forbidden.why}` +
                    " (See docs/ai/shell-execution.md → 'Forbidden patterns'." +
                    " If you believe this is a false positive, surface the" +
                    " command to the operator instead of working around it.)",
            };
        }
    }

    // Reject host-shell env-var prefixes before vh-agent-harness exec. They set vars on
    // the HOST and never reach the container; they must go inside bash -c '...'.
    if (isEnvPrefixedDevShExec(command)) {
        return {
            action: "deny",
            reason:
                "Env vars before vh-agent-harness exec run on the host and don't reach the container. " +
                "Put them inside: vh-agent-harness exec bash -c 'ENV=value your-cmd'",
        };
    }

    if (command.trim().startsWith("vh-agent-harness git ")) {
        return {
            action: "deny",
            reason: "Git commands must be run directly, not through vh-agent-harness.",
        };
    }

    // Normalize by stripping leading env vars so that
    // `FOO=1 vh-agent-harness exec ...` is handled the same as
    // `vh-agent-harness exec ...`.
    const normalizedCmd = stripLeadingEnvVarsFromString(command.trim());

    if (normalizedCmd.startsWith("vh-agent-harness git ")) {
        return {
            action: "deny",
            reason: "Git commands must be run directly, not through vh-agent-harness.",
        };
    }

    if (normalizedCmd.startsWith("vh-agent-harness ")) {
        // Inspect vh-agent-harness exec payloads for gate-wrapper invocations.
        // Non-committer agents must not reach commit-gate.sh through the wrapper.
        if (isGateWrapperInDevShExec(command.trim())) {
            return {
                action: "deny",
                reason:
                    "Gate wrapper (commit-gate.sh) must be invoked directly, not through vh-agent-harness exec. " +
                    "Only the committer agent can use the gate wrapper. " +
                    "Blessed form: .opencode/scripts/commit-gate.sh acquire " +
                    "--paths-file .git/commit-gate/paths-${UUID} " +
                    "--message-file .git/commit-gate/msg-${UUID} " +
                    "--session-alias ALIAS",
            };
        }

        // harness branch passed: allow (mirrors the plugin's bare `return;`).
        return { action: "allow", reason: "" };
    }

    let commands;
    try {
        commands = await parseCommands(command);
    } catch {
        return {
            action: "deny",
            reason:
                "Commands outside the read-only inspection surface must run through" +
                " vh-agent-harness. This command could not be parsed safely for" +
                " read-only validation.",
        };
    }

    // Normalize optional leading `git -C <path>` into `git ...` so
    // that BOTH downstream layers see the bare form:
    //   - forbidden re-scan (below) re-catches mutations routed
    //     through `-C` via the existing git-mutation-bypass regex;
    //   - the allowlist (isAllowedCommand) re-matches readonly
    //     subcommands without hitting the permission prompt.
    // A validated, single, in-project `-C <path>` is stripped;
    // anything out-of-project, malformed, multiple, or a symlink
    // escape is a hard deny here. Non-git commands and git commands
    // without `-C` pass through unchanged (no regression).
    const normalizedCommands = [];
    for (const tokens of commands) {
        const envStripped = stripLeadingEnvVars(tokens);
        const cResult = normalizeGitC(envStripped);
        if (cResult.deny) {
            return {
                action: "deny",
                reason:
                    "Blocked by shell-guard: " +
                    cResult.deny +
                    ". (git -C only accepts a single in-project" +
                    " path. See docs/ai/shell-execution.md.)",
            };
        }
        normalizedCommands.push(cResult.tokens);
    }

    // Re-run the forbidden-pattern scan on the stripped-token
    // reconstruction for git commands. This reuses
    // git-mutation-bypass as the single source of truth for
    // mutation verbs (we do NOT duplicate the verb list), so
    // `git -C <valid> commit` -> stripped `git commit` -> denied.
    for (const tokens of normalizedCommands) {
        if (tokens.length > 0 && tokens[0] === "git") {
            const reconstruction = tokens.join(" ");
            const strippedForbidden =
                denyByForbiddenPatterns(reconstruction);
            if (strippedForbidden) {
                return {
                    action: "deny",
                    reason:
                        `Blocked by shell-guard rule '${strippedForbidden.id}': ${strippedForbidden.why}` +
                        " (See docs/ai/shell-execution.md → 'Forbidden patterns'." +
                        " If you believe this is a false positive, surface the" +
                        " command to the operator instead of working around it.)",
                };
            }
        }
    }

    const blocked = normalizedCommands.find(
        (tokens) => !isAllowedCommand(tokens),
    );
    if (!blocked) {
        // Every parsed command matched the read-only allowlist: allow.
        return { action: "allow", reason: "" };
    }

    // Git non-read-only routing hint — O3 hint-only design (no agent identity).
    if (blocked[0] === "git" && (blocked.length < 2 ||
        !GIT_READONLY_SUBCOMMANDS.has(blocked[1]))) {
        // Non-blocking: pass through (ask) so the caller's permission layer
        // can apply ask/deny. The routing hint is the reason. (Mirrors the
        // plugin's `console.error(hint); return;` passthrough.)
        return {
            action: "ask",
            reason:
                "[shell-guard] Non-read-only or unrecognized git command detected: " +
                JSON.stringify(blocked) +
                ". Only the committer agent may execute git mutations," +
                " through the commit-gate wrapper. See" +
                " .opencode/docs/git-execution-routing.md." +
                " Passing through to permission gate.",
        };
    }

    return {
        action: "deny",
        reason:
            "Commands outside the read-only inspection surface must run through" +
            " vh-agent-harness (read docs/ai/shell-execution.md if not familiar)." +
            " Direct read-only commands are " +
            COMMANDS.readonly.map(trimEndStar).join(", ") +
            ". The following command is not allowed: " +
            JSON.stringify(blocked),
    };
}
