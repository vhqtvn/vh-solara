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
//
// Global-flag detect/parse (git -C / --no-pager / etc.): evaluate(command,
// commandCwd) walks leading git global flags via a registry-driven walker to
// extract the verb past them and classify any `-C` path. This powers the
// security DECISIONS and NOTHING else — evaluate NEVER returns a command
// rewrite and the plugin wrapper (shell-guard.js) NEVER mutates
// output.args.command:
//   - mutation-slip guard: verb in GIT_MUTATION_VERBS past any leading flag
//     -> deny (covers `git -C <ext> commit`, `git --git-dir=/x commit`,
//     `git --no-pager commit`).
//   - relative `-C` (`.`, `..`, subdir) -> deny + actionable notice.
//   - external `-C` readonly -> ask; external `-C` mutation -> deny (via the
//     mutation-slip guard above).
//   - info flags (`--help`/`--version`/...) with no verb -> allow.
// For the internal allowlist check, when every consumed flag is execution-safe
// to drop (paging flags, or `-C <abs commandCwd>` that is a no-op), evaluate
// matches the STRIPPED token form so `git --no-pager diff x` is recognized as
// the readonly `git diff x`. This classification is INTERNAL to the decision —
// it does not escape as a rewrite. eval.js emits `{action, reason}` only.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, GIT_MUTATION_VERBS } from "../repo-configs/allowed-commands.js";
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

// === G4: inert-literal classifier for rg/grep pattern operands ============
//
// The raw forbidden-pattern scanner sees forbidden literals (e.g. `/tmp`
// matching `system-tmp-access`) ANYWHERE in the command string, including
// inside search-pattern operands of `rg`/`grep`. `rg -F '/tmp' docs` is a
// literal-string SEARCH, not a filesystem access — but the raw scanner cannot
// tell. This bounded classifier proves — using the EXISTING bash parser —
// that a forbidden regex match appears ONLY in the search-pattern operand of
// a single simple `rg`/`grep` command, and ONLY then may the match be
// disregarded. Everything else fails closed: the original deny stands.
//
// Safety invariants (load-bearing):
//   1. Does NOT replace raw scanning. evaluate() still runs
//      denyByForbiddenPatterns() FIRST; this helper only consults on whether
//      a CONFIRMED match applies.
//   2. Fail closed. If the parser is unavailable, parsing fails, OR the
//      command shape is anything other than the closed grammar below, return
//      false → the original deny stands.
//   3. Single simple command ONLY. Pipelines, chains, redirections,
//      substitution, control flow, executor wrappers, variable assignments,
//      and ANY node type outside the closed allow-set fail closed.
//   4. Closed command registry: `rg` and `grep` ONLY. No other families.
//   5. Closed flag whitelist: `-F` and `--fixed-strings` ONLY (no-value flags
//      common to both tools). Combined short flags (`-Fi`) and value-taking
//      flags (`-e`, `-A`, `-f`) fail closed because classifying them would
//      require a growing option parser.
//   6. The forbidden regex must match the PATTERN token's text AND must NOT
//      match the command name, any flag, or any path operand. This prevents
//      `rg /tmp /tmp` (real /tmp access on the path operand) from being
//      suppressed.
//
// Grammar (closed, no growing parser):
//   <rg|grep> <flag>* [--] PATTERN PATH+
//     command_name : exactly "rg" or "grep"
//     flag         : word with text in {"-F", "--fixed-strings"}
//     --           : optional POSIX options terminator (word with text "--")
//     PATTERN      : first positional operand (word | raw_string | string)
//     PATH+        : one or more path operands after PATTERN
//                    (word | raw_string | string)
//
// Allowed named node types (across all descendants):
//   {program, command, command_name, word, raw_string, string, string_content}
// Any other named node type ANYWHERE → fail closed. This single rule rejects
// redirection, command_substitution, process_substitution, subshell,
// simple_expansion, concatenation, variable_assignment, pipeline, list, and
// all control-flow / compound-statement forms.
const INERT_COMMAND_NAMES = new Set(["rg", "grep"]);
const INERT_FLAG_WHITELIST = new Set(["-F", "--fixed-strings"]);
const INERT_ALLOWED_NODE_TYPES = new Set([
    "program",
    "command",
    "command_name",
    "word",
    "raw_string",
    "string",
    "string_content",
]);

// tryGetBashParser returns the lazy bash parser or null on unavailable. It is
// DISTINCT from parseCommands(): parseCommands swallows the load error and
// falls back to a naive tokenizer (correct for allowlist matching, unsafe for
// inert-literal proof). The inert classifier MUST refuse to suppress when the
// parser is unavailable; it must NOT consult the fallback tokenizer.
async function tryGetBashParser() {
    try {
        return await getBashParser();
    } catch {
        return null;
    }
}

// hasOnlyAllowedNamedNodes walks a SyntaxNode's named descendants and returns
// false if ANY named node's type is outside the closed allow-set. Anonymous
// punctuation (`"`, `'`, `$`, `(`, ...) is intentionally ignored — those do
// not change the structural shape.
function hasOnlyAllowedNamedNodes(root) {
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node || !INERT_ALLOWED_NODE_TYPES.has(node.type)) {
            return false;
        }
        for (let i = 0; i < node.namedChildCount; i++) {
            stack.push(node.namedChild(i));
        }
    }
    return true;
}

// classifyCommandTokens walks a `command` node's named children and returns an
// ordered list of {text, type} tokens for the structural types only. Any
// other named child type (e.g. variable_assignment, file_redirect) → null.
function classifyCommandTokens(commandNode) {
    const tokens = [];
    for (let i = 0; i < commandNode.namedChildCount; i++) {
        const child = commandNode.namedChild(i);
        if (!child) continue;
        const t = child.type;
        if (
            t !== "command_name" &&
            t !== "word" &&
            t !== "raw_string" &&
            t !== "string"
        ) {
            return null;
        }
        tokens.push({ text: child.text, type: t });
    }
    return tokens;
}

// parseInertRgGrepShape takes the token list (after the root/structure/node-
// type checks have passed) and returns the pattern token text plus arrays of
// flag texts and path texts. Returns null on any deviation from the closed
// grammar (unknown flag, missing pattern, missing path, ambiguous layout).
function parseInertRgGrepShape(tokens) {
    if (tokens.length === 0) return null;
    // tokens[0] is command_name (verified by the caller); the structural
    // walk below treats tokens[1..] as the option/operand sequence.
    const rest = tokens.slice(1);
    const flags = [];
    let i = 0;

    // Optional whitelist flags (must all be in INERT_FLAG_WHITELIST) and an
    // optional `--` terminator. A `--` ends option parsing.
    for (; i < rest.length; i++) {
        const tok = rest[i];
        if (tok.type !== "word") break;
        if (tok.text === "--") {
            // POSIX options terminator: positional operands follow.
            i++;
            break;
        }
        if (INERT_FLAG_WHITELIST.has(tok.text)) {
            flags.push(tok.text);
            continue;
        }
        // Unknown flag (e.g. -Fi, -e, -A, --foo) → fail closed. Classifying
        // value-bearing or combined-short flags would require a growing
        // option parser, which the design explicitly forbids.
        return null;
    }

    // Positional operands from here on. Need at least PATTERN PATH: a bare
    // `rg PATTERN` reading stdin is rejected as ambiguous (no way to prove
    // pattern vs path role).
    const positionals = rest.slice(i);
    if (positionals.length < 2) {
        return null;
    }

    // First positional = PATTERN, rest = PATH+. Types are already restricted
    // to {word, raw_string, string} by classifyCommandTokens.
    const patternToken = positionals[0];
    const pathTokens = positionals.slice(1);

    return {
        flags,
        pattern: patternToken.text,
        paths: pathTokens.map((t) => t.text),
        commandName: tokens[0].text,
    };
}

// isInertRgGrepMatch returns true ONLY when the parser can PROVE that the
// forbidden regex match appears in the search-pattern operand of a single
// simple rg/grep command and nowhere else (command name, flags, paths). On
// any doubt (parser unavailable, parse failure, non-rg/grep command, complex
// shell construct, ambiguous operand layout), it returns false so the
// original deny stands. Exported for test reuse.
export async function isInertRgGrepMatch(command, forbiddenRule) {
    // Defensive: this helper must never throw — fail closed on any fault.
    try {
        const parser = await tryGetBashParser();
        if (!parser) return false;

        const tree = parser.parse(command);
        if (!tree) return false;
        const root = tree.rootNode;
        if (!root) return false;

        // Root structure: program > command (exactly one command, no list /
        // pipeline / redirected_statement / subshell / control-flow).
        if (root.type !== "program") return false;
        if (root.namedChildCount !== 1) return false;
        const commandNode = root.namedChild(0);
        if (!commandNode || commandNode.type !== "command") return false;

        // Closed allow-set check across ALL named descendants. Rejects any
        // redirection / substitution / expansion / assignment / compound form.
        if (!hasOnlyAllowedNamedNodes(root)) return false;

        // Collect structural tokens; any non-{command_name, word, raw_string,
        // string} named child of the command → fail closed.
        const tokens = classifyCommandTokens(commandNode);
        if (!tokens || tokens.length === 0) return false;
        if (tokens[0].type !== "command_name") return false;
        if (!INERT_COMMAND_NAMES.has(tokens[0].text)) return false;

        // Classify operand roles per the closed grammar.
        const shape = parseInertRgGrepShape(tokens);
        if (!shape) return false;

        // Per-token regex test. The forbidden regex is non-global (stateless
        // .test). It MUST match the pattern token and MUST NOT match the
        // command name, any flag, or any path operand.
        const re = forbiddenRule && forbiddenRule.re;
        if (!re) return false;
        if (!re.test(shape.pattern)) return false;
        if (re.test(shape.commandName)) return false;
        for (const f of shape.flags) {
            if (re.test(f)) return false;
        }
        for (const p of shape.paths) {
            if (re.test(p)) return false;
        }
        return true;
    } catch {
        return false;
    }
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
// Generic git global-flag detect/parse (registry-driven walker).
//
// Background: opencode's permission matcher is path-blind glob over the raw
// command text (`git diff *` matches `git diff x`, but NOT `git -C <root> diff`
// or `git --no-pager diff`). shell-guard's `tool.execute.before` hook DOES NOT
// rewrite the command — a detector has a safe fallback (ask) but a rewriter
// does not, and real agent commands (pipelines, sequences, subshells) make a
// safe whole-command rewrite unprovable. Instead the walker POWERS THE
// DECISION: it extracts the verb past leading global flags and classifies any
// `-C` path so the security verdicts (mutation-slip guard, relative-`-C`
// deny+notice, external-`-C` routing, info-flag allow) fire correctly. For
// shell-guard's INTERNAL allowlist check only, when every consumed flag is
// execution-safe to drop the stripped token form is matched so a readonly
// `git --no-pager diff` is recognized; this classification never escapes as a
// command rewrite.
//
// Droppable-vs-keep classification (decision-internal; what EXECUTES is never
// changed):
//   - paging flags (`-p`,`--paginate`,`-P`,`--no-pager`)        -> always safe
//   - `-C <abs path>` where path === commandCwd                  -> no-op (cwd)
//   - everything else (config/repo-location/behavior flags, or a
//     `-C` pointing elsewhere)                                   -> KEEP (prompt)
//
// The walker also powers the UNIFORM mutation-slip guard: it extracts the verb
// PAST any leading global flags and tests it against GIT_MUTATION_VERBS, so a
// mutation hidden behind `-C`/`--git-dir`/an unknown flag is DENIED regardless
// of adjacency — closing `git -C <ext> commit`, `git --git-dir=/x commit`, and
// `git --no-pager commit` without re-scanning a stripped reconstruction.
//
// `commandCwd` is the command's real working directory (the plugin wrapper
// derives it from output.args.workdir, falling back to repoRoot()). A `-C`
// path equal to it is the in-project no-op reference; anything else is
// in-project-subdir or external.
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
// in the plugin server context — same cwd-robustness rationale as repoRoot()).
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

// ---------------------------------------------------------------------------
// Git global-flag registry + walker.
//
// The registry is the spec for every git global flag that may sit between
// `git` and the subcommand (sourced from `git --help`'s usage line). Each entry
// declares how the flag consumes its value (valueForm) and whether dropping it
// is an execution no-op (stripPolicy):
//
//   valueForm:
//     "next"        — consumes the NEXT token as its value (e.g. `-C <path>`)
//     "eq"          — value attached via `=` in the SAME token (`--git-dir=/x`)
//     "optional-eq" — value optional via `=` (`--exec-path` / `--exec-path=/x`)
//                     IMPORTANT: never consumes a separate next token
//     "none"        — boolean flag, no value (`--no-pager`)
//
//   stripPolicy:
//     "always"      — display-only; safe to DROP from the internal stripped
//                     form (paging)
//     "conditional" — drop only if a predicate holds (only `-C`: strip iff the
//                     path is absolute AND === commandCwd)
//     "never"       — skip PAST it for verb-reach but NEVER drop it from the
//                     internal stripped form (config / repo-location / behavior
//                     flags)
//     "info"        — terminal read-only info request (`--help`/`--version`);
//                     no verb follows; allow without an allowlist match
// ---------------------------------------------------------------------------

const GIT_GLOBAL_FLAG_REGISTRY = [
    { flags: ["-C"], valueForm: "next", stripPolicy: "conditional" },
    { flags: ["-c"], valueForm: "next", stripPolicy: "never" },
    { flags: ["--git-dir"], valueForm: "eq", stripPolicy: "never" },
    { flags: ["--work-tree"], valueForm: "eq", stripPolicy: "never" },
    { flags: ["--namespace"], valueForm: "eq", stripPolicy: "never" },
    { flags: ["--config-env"], valueForm: "eq", stripPolicy: "never" },
    { flags: ["--exec-path"], valueForm: "optional-eq", stripPolicy: "never" },
    // Paging flags — display-only, always safe to drop. NOTE: `--paging=no` is
    // NOT a real git flag (absent from `git --help`); the prior
    // GIT_SAFE_GLOBAL_FLAGS listed it by mistake. The canonical set is
    // -p/--paginate/-P/--no-pager.
    {
        flags: ["-p", "--paginate", "-P", "--no-pager"],
        valueForm: "none",
        stripPolicy: "always",
    },
    { flags: ["--no-replace-objects", "--bare"], valueForm: "none", stripPolicy: "never" },
    // Terminal info requests — read-only, no verb follows.
    {
        flags: ["-v", "--version", "-h", "--help", "--html-path", "--man-path", "--info-path"],
        valueForm: "none",
        stripPolicy: "info",
    },
];

// Lookup a token in the registry. Returns { entry, valueAttached } or null.
//   - exact token match (none / next / optional-eq-without-value forms)
//   - `--flag=value` split (eq / optional-eq-with-value forms)
// A token that starts with `-` but matches nothing is returned as null so the
// walker can treat it as an unknown never-strip boolean (see walkGitGlobals).
function lookupGitGlobalFlag(token) {
    if (token === "-" || token === "--" || !token.startsWith("-")) return null;
    // Exact match first.
    for (const entry of GIT_GLOBAL_FLAG_REGISTRY) {
        if (entry.flags.includes(token)) {
            return { entry, valueAttached: null };
        }
    }
    // `--flag=value` split for eq / optional-eq forms.
    const eqIdx = token.indexOf("=");
    if (eqIdx > 2) {
        // > 2 so bare `-x` (no flag name) is not mistaken; only `--…=…`/`-C=…`.
        const flagPart = token.slice(0, eqIdx);
        const valuePart = token.slice(eqIdx + 1);
        for (const entry of GIT_GLOBAL_FLAG_REGISTRY) {
            if (
                entry.flags.includes(flagPart) &&
                (entry.valueForm === "eq" || entry.valueForm === "optional-eq")
            ) {
                return { entry, valueAttached: valuePart };
            }
        }
    }
    return null;
}

// walkGitGlobals — consume leading git global flags starting at tokens[1]
// (tokens[0] MUST === "git"; the caller guards this). Returns:
//   {
//     verb: string|null,          // first non-flag token, or null if none
//     rewrittenTokens: string[],  // stripped token list (globals removed per
//                                 // stripPolicy); used for INTERNAL allowlist
//                                 // matching only — NEVER emitted as a rewrite
//     fullyStrippable: bool,      // true ONLY if every consumed flag was "always"
//                                 // or a satisfied "conditional" AND no
//                                 // "never"/"info"/unsatisfied-conditional flag
//                                 // was consumed (i.e. the stripped form is
//                                 // semantically equivalent for the decision)
//     deny: string|null,          // set when a relative `-C` is seen
//     infoOnly: bool,             // true when an "info" flag was consumed and
//                                 // no verb followed (e.g. `git --help`)
//   }
//
// Unknown flags starting with `-` (len > 1, not bare `-`/`--`) are treated as
// never-strip booleans (consume exactly 1 token) so a mutation hidden behind an
// unrecognized flag is STILL caught: the verb is extracted past it and tested
// against GIT_MUTATION_VERBS by evaluate(). This is conservative — an unknown
// flag yields a non-strippable classification, so the original form prompts.
export function walkGitGlobals(tokens, commandCwd) {
    const out = ["git"]; // rebuilt token list
    let fullyStrippable = true;
    let infoOnly = false;
    let i = 1;

    while (i < tokens.length) {
        const tok = tokens[i];

        // Verb boundary: bare `-`, `--` (options terminator), or a non-flag token.
        if (tok === "-" || tok === "--" || !tok.startsWith("-")) {
            const verb = tok === "--" ? (tokens[i + 1] ?? null) : tok;
            return {
                verb: verb ?? null,
                rewrittenTokens: out.concat(tokens.slice(i + (tok === "--" ? 1 : 0))),
                fullyStrippable: fullyStrippable && !infoOnly,
                deny: null,
                infoOnly,
            };
        }

        const lookup = lookupGitGlobalFlag(tok);
        if (!lookup) {
            // Unknown flag: never-strip boolean, consume 1 token. Keeps the verb
            // reachable for the mutation guard while guaranteeing no rewrite.
            out.push(tok);
            fullyStrippable = false;
            i++;
            continue;
        }

        const { entry, valueAttached } = lookup;
        const { valueForm, stripPolicy } = entry;
        let valueToken = null;

        if (valueForm === "next") {
            if (i + 1 >= tokens.length) {
                // Flag needs a value but none follows — malformed; stop here,
                // no verb. Conservatively not strippable.
                return {
                    verb: null,
                    rewrittenTokens: out.concat(tokens.slice(i)),
                    fullyStrippable: false,
                    deny: null,
                    infoOnly,
                };
            }
            valueToken = tokens[i + 1];
            i += 2;
        } else if (valueForm === "eq") {
            // Value attached via `=`; git also accepts a space-separated value,
            // so consume the next token defensively when no `=` is present.
            if (valueAttached === null) {
                if (i + 1 >= tokens.length) {
                    return {
                        verb: null,
                        rewrittenTokens: out.concat(tokens.slice(i)),
                        fullyStrippable: false,
                        deny: null,
                        infoOnly,
                    };
                }
                valueToken = tokens[i + 1];
                i += 2;
            } else {
                i += 1;
            }
        } else {
            // "optional-eq" (never consumes a next token) and "none".
            i += 1;
        }

        // Apply the strip policy to decide whether the flag survives the
        // internal stripped form.
        if (stripPolicy === "always") {
            continue; // drop (do not push)
        }
        if (stripPolicy === "info") {
            infoOnly = true;
            fullyStrippable = false;
            if (valueForm === "next") out.push(tok, valueToken);
            else out.push(tok);
            continue;
        }
        if (stripPolicy === "never") {
            fullyStrippable = false;
            if (valueForm === "next") out.push(tok, valueToken);
            else out.push(tok);
            continue;
        }
        // stripPolicy === "conditional" (only `-C <path>`).
        const rawPath = unquoteToken(valueToken);
        if (!path.isAbsolute(rawPath)) {
            // Relative `-C` (`.`, `..`, `subdir/...`) — deny with an actionable
            // notice. Relative paths defeat the `=== commandCwd` no-op test
            // (normalization / symlink / `..` hazards), so they are refused
            // outright rather than auto-resolved.
            return {
                verb: null,
                rewrittenTokens: out.concat([tok, valueToken]).concat(tokens.slice(i)),
                fullyStrippable: false,
                deny: "relative -C paths are not auto-normalized; use an absolute path equal to the working directory or drop -C",
                infoOnly: false,
            };
        }
        const resolvedC = path.resolve(rawPath);
        const cwdNorm = path.resolve(commandCwd);
        if (resolvedC === cwdNorm) {
            continue; // absolute and === commandCwd: no-op, strip it
        }
        // Absolute in-project subdir OR external: KEEP (no internal strip).
        // The verb is still extracted past it for the mutation guard and the
        // routing hint (handled by evaluate).
        fullyStrippable = false;
        out.push(tok, valueToken);
    }

    // Consumed only flags, no verb followed.
    return {
        verb: null,
        rewrittenTokens: out,
        fullyStrippable: fullyStrippable && !infoOnly,
        deny: null,
        infoOnly,
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

// F1: detect a WRAPPED git mutation routed through `vh-agent-harness exec` (or
// exec-ro) with a global flag between `git` and the verb — e.g.
// `vh-agent-harness exec git --no-pager commit`, `exec git -C /x push`,
// `exec git --git-dir=/x commit`. The bare adjacency regex
// (`git-mutation-bypass` in forbidden-patterns) cannot match this form because
// the flag breaks `\bgit\s+<verb>` adjacency, so a wrapped mutation slips past
// the harness branch's allow. This guard closes that bypass for WRAPPED
// payloads ONLY:
//   - It does NOT touch direct `vh-agent-harness git …` (already denied at the
//     startsWith("vh-agent-harness git ") branch above evaluate's harness
//     branch — no double-deny, no conflict).
//   - It does NOT touch non-wrapped git (handled by the per-command walker
//     later in evaluate).
//   - It does NOT surface walkGitGlobals' relative-`-C` deny or path
//     classification here: exec is a TRUST layer meant to allow arbitrary
//     non-git commands; this guard plugs the mutation hole ONLY.
//
// Reuses walkGitGlobals (verb extraction past global flags) and
// GIT_MUTATION_VERBS (single source of truth) — NO new parser, NO regex, NO
// local verb copy. Returns a `{ action, reason }` deny object or null (caller
// falls through to the existing allow on null).
//
// Wrapper-flag semantics mirror cobra's exec flag table in
// internal/cli/exec_shell.go (SetInterspersed(false) stops flag parsing at the
// first positional, so wrapper flags must precede the payload):
//   --service <v> | --service=<v>           (StringVar)
//   --workdir <v> | --workdir=<v> | -w <v> | -w<v>  (StringVarP)
//   --tty | -t                               (BoolVarP)
//   --                                       (options terminator)
// exec-ro accepts only an optional `--` (no service/workdir/tty flags).
export function detectWrappedGitMutation(normalizedCmd, cwd) {
    const commands = fallbackParse(normalizedCmd);
    if (commands.length === 0) return null;
    const tokens = commands[0];
    if (tokens.length < 2) return null;
    if (tokens[0] !== "vh-agent-harness") return null;
    const wrapper = tokens[1];
    if (wrapper !== "exec" && wrapper !== "exec-ro") return null;

    let i = 2;
    if (wrapper === "exec") {
        // Skip harness wrapper flags before the payload command. An
        // unrecognized token is treated as the start of the payload (cobra
        // stops flag parsing at the first positional).
        while (i < tokens.length) {
            const tok = tokens[i];
            if (tok === "--") { i++; break; }
            if (tok === "--service" || tok === "--workdir" || tok === "-w") {
                // Value in the NEXT token.
                i += 2;
                continue;
            }
            if (tok.startsWith("--service=") || tok.startsWith("--workdir=")) {
                i += 1;
                continue;
            }
            if (tok.startsWith("-w") && tok.length > 2) {
                // Stuck form `-w<value>`.
                i += 1;
                continue;
            }
            if (tok === "--tty" || tok === "-t") {
                i += 1;
                continue;
            }
            // Not a recognized wrapper flag: payload starts here.
            break;
        }
    } else {
        // exec-ro: skip an optional options terminator only.
        if (tokens[i] === "--") i++;
    }

    const payload = tokens.slice(i);
    if (payload.length === 0 || payload[0] !== "git") return null;

    const w = walkGitGlobals(payload, cwd);
    // Mutation-slip guard ONLY. Do NOT surface w.deny (relative -C) or
    // path-classify here — exec is a trust layer; this plugs the mutation
    // hole only. Read-only git verbs and non-git payloads fall through.
    if (w.verb && GIT_MUTATION_VERBS.includes(w.verb)) {
        return {
            action: "deny",
            reason:
                "Blocked by shell-guard rule 'git-mutation-bypass': " +
                "Git mutations must go through the commit-gate wrapper. " +
                "Only the committer agent (C) may execute git writes, " +
                "and only through `.opencode/scripts/commit-gate.sh`. " +
                "See .opencode/docs/git-execution-routing.md." +
                " (Wrapped `vh-agent-harness " + wrapper + " git …` routed verb '" +
                w.verb + "' past a global flag.)",
        };
    }
    return null;
}

function isAllowedCommand(tokens) {
    const stripped = stripLeadingEnvVars(tokens);
    if (stripped.length === 0) return false;
    return ALLOWED_PATTERNS.some((pattern) => matchesPattern(stripped, pattern));
}

// ---------------------------------------------------------------------------
// evaluate(command, commandCwd) — the single decision entrypoint.
//
// Ported VERBATIM from the bash branch of the plugin's tool.execute.before
// handler (the procedural body that ran on every `bash` tool invocation). The
// OpenCode verbs are translated to a plain { action, reason } return:
//   throw new Error(msg)        -> { action:"deny",  reason: msg }
//   console.error(hint); return -> { action:"ask",   reason: hint }
//   bare return (all checks ok) -> { action:"allow", reason: "" }
//
// commandCwd is the command's real working directory (the plugin wrapper
// derives it from output.args.workdir, falling back to repoRoot()). It is the
// reference for classifying `-C <abs path>`: a `-C` equal to it is an
// in-project no-op; anything else is in-project-subdir or external. It
// defaults to repoRoot() when omitted (eval.js / the Go bridge have no
// workdir, so they use repoRoot).
//
// Return shape: { action:"allow"|"deny"|"ask", reason:"..." }. evaluate NEVER
// returns a `rewrite` field and the plugin wrapper NEVER mutates the command —
// detection/parse drives the DECISION only (see the file header). When every
// consumed git global flag is execution-safe to drop, the STRIPPED token form
// is matched against the internal allowlist so a readonly `git --no-pager
// diff` is recognized as allow; this classification is internal and does not
// escape as a command rewrite.
//
// contract:
//   - NEVER throws on a deny — returns it.
//   - Throws ONLY on an engine fault (WASM/parser/rule-import) so eval.js and
//     the Go hook fail safe (exit 2 / Deny).
//   - Empty / null / whitespace command -> { action:"deny", reason:"empty command" }.
//   - command is a STRING (mirrors output.args.command). The Go bridge joins
//     argv with single spaces before calling node.
// ---------------------------------------------------------------------------
export async function evaluate(command, commandCwd) {
    const cwd = commandCwd || repoRoot();
    // Empty / null / whitespace command guard.
    if (command == null || (typeof command === "string" && command.trim() === "")) {
        return { action: "deny", reason: "empty command" };
    }

    const forbidden = denyByForbiddenPatterns(command);
    if (forbidden) {
        // G4: a confirmed forbidden match may be disregarded ONLY when the
        // bash parser proves the match appears in the search-pattern operand
        // of a single simple rg/grep command (and nowhere else). The
        // classifier fails closed: parser unavailable, parse failure, any
        // complex shell construct, or any ambiguous operand layout keeps the
        // deny. Raw deny-before-allowlist scanning is preserved — this only
        // consults on whether a CONFIRMED match applies; it never replaces
        // the raw safety backstop.
        const suppress =
            shouldSuppressForbidden(command, forbidden.id) ||
            (await isInertRgGrepMatch(command, forbidden));
        if (!suppress) {
            return {
                action: "deny",
                reason:
                    `Blocked by shell-guard rule '${forbidden.id}': ${forbidden.why}` +
                    " (See docs/ai/shell-execution.md → 'Forbidden patterns'." +
                    " If you believe this is a false positive, surface the" +
                    " command to the operator instead of working around it.)",
            };
        }
        // else: classifier proved the match is in an rg/grep search-pattern
        // operand. Fall through to the allowlist check unchanged. An
        // allowlist entry never overrides a real deny; it merely authorizes
        // the (now-inert-pattern) rg/grep form.
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
                    "Blessed form: committer authors the message with the Write tool at " +
                    "tmp/commit-gate-message/msg-${UUID}, then runs the single-line " +
                    ".opencode/scripts/commit-gate.sh acquire --paths '<JSON>' " +
                    "--message-file tmp/commit-gate-message/msg-${UUID} --session-alias ALIAS",
            };
        }

        // F1: detect a WRAPPED git mutation routed past a global flag
        // (`vh-agent-harness exec git --no-pager commit`,
        // `exec git -C /x push`, `exec git --git-dir=/x commit`). The adjacency
        // regex cannot match a flag between `git` and the verb; this guard
        // closes the bypass for WRAPPED payloads only. Reuses walkGitGlobals +
        // GIT_MUTATION_VERBS — no regex, no local verb copy. Read-only git and
        // non-git payloads fall through to the existing allow.
        const wrappedMutation = detectWrappedGitMutation(normalizedCmd, cwd);
        if (wrappedMutation) {
            return wrappedMutation;
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

    // Per-command git global-flag detect/parse via the registry walker.
    //
    // The walker consumes leading git global flags (value-form aware) and
    // produces the verb + a rebuilt token list. Outcomes per command:
    //   - deny (relative `-C`)                  -> hard deny + actionable notice
    //   - infoOnly (e.g. `git --help`)          -> read-only info, auto-allow
    //                                              this command (skip the
    //                                              allowlist check below)
    //   - verb in GIT_MUTATION_VERBS            -> hard deny (UNIFORM
    //                                              mutation-slip guard — covers
    //                                              external `-C`, `--git-dir`,
    //                                              unknown flags; the verb is
    //                                              extracted PAST any leading
    //                                              flag so adjacency no longer
    //                                              matters)
    //   - readonly + fullyStrippable            -> push STRIPPED tokens so the
    //                                              internal allowlist matches
    //                                              the bare `git <verb> ...`
    //                                              form (decision-internal; NO
    //                                              command rewrite is produced)
    //   - otherwise                             -> push ORIGINAL env-stripped
    //                                              tokens (allowlist sees the
    //                                              original -> prompt if unmatched)
    //
    // Each entry carries the walker-extracted verb so the routing hint below
    // reasons about the REAL verb (e.g. `log` in `git --no-pager log`) rather
    // than `blocked[1]`, which can be a polluted flag token (`--no-pager` is in
    // GIT_READONLY_SUBCOMMANDS as a side effect of the `git --no-pager <sub> *`
    // config entries). `autoAllow` marks info-only commands that skip the
    // allowlist.
    const normalizedCommands = [];
    for (const tokens of commands) {
        const envStripped = stripLeadingEnvVars(tokens);

        if (envStripped.length > 0 && envStripped[0] === "git") {
            const w = walkGitGlobals(envStripped, cwd);
            if (w.deny) {
                return {
                    action: "deny",
                    reason:
                        "Blocked by shell-guard: " + w.deny +
                        ". (See docs/ai/shell-execution.md.)",
                };
            }
            if (w.infoOnly) {
                // Terminal read-only info request (`git --help`/`git --version`).
                // Auto-allow this command without an allowlist match; no rewrite.
                normalizedCommands.push({ tokens: envStripped, verb: w.verb, autoAllow: true });
                continue;
            }
            // UNIFORM mutation-slip guard: the walker extracted the verb PAST
            // any leading global flag, so `git -C <ext> commit`,
            // `git --git-dir=/x commit`, and `git --no-pager commit` are all
            // denied here regardless of flag adjacency. This reuses
            // GIT_MUTATION_VERBS (the single source of truth that builds the
            // git-mutation-bypass regex) — no verb-list duplication.
            if (w.verb && GIT_MUTATION_VERBS.includes(w.verb)) {
                return {
                    action: "deny",
                    reason:
                        "Blocked by shell-guard rule 'git-mutation-bypass': " +
                        "Git mutations must go through the commit-gate wrapper. " +
                        "Only the committer agent (C) may execute git writes, " +
                        "and only through `.opencode/scripts/commit-gate.sh`. " +
                        "See .opencode/docs/git-execution-routing.md." +
                        " (Verb '" + w.verb + "' routed past a global flag.)",
                };
            }
            if (w.fullyStrippable) {
                // Execution-safe to drop every consumed flag. Match the
                // STRIPPED token form against the internal allowlist so a
                // readonly `git --no-pager diff x` is recognized as
                // `git diff x` (matches `git diff *`). This classification is
                // INTERNAL to the allow/deny/ask decision — it does NOT produce
                // a rewrite and the plugin wrapper does NOT mutate the command.
                // opencode's L2 matcher still sees the ORIGINAL command text;
                // prompt-free coverage for `git --no-pager <sub>` comes from
                // the config-table `git --no-pager <sub> *` L2 rules, not a
                // rewrite.
                normalizedCommands.push({ tokens: w.rewrittenTokens, verb: w.verb, autoAllow: false });
                continue;
            }
            // Not fully strippable (a `never`/`info` flag present, or `-C`
            // pointing elsewhere): the allowlist sees the ORIGINAL tokens
            // below, so the command prompts as before. The walker verb is
            // still carried for the routing hint.
            normalizedCommands.push({ tokens: envStripped, verb: w.verb, autoAllow: false });
            continue;
        }

        normalizedCommands.push({ tokens: envStripped, verb: null, autoAllow: false });
    }

    const blocked = normalizedCommands.find(
        (c) => !c.autoAllow && !isAllowedCommand(c.tokens),
    );
    if (!blocked) {
        // Every parsed command was auto-allowed (info) or matched the read-only
        // allowlist: allow. NO rewrite is returned — the plugin wrapper never
        // mutates the command (detect/parse for the decision only).
        return { action: "allow", reason: "" };
    }

    // Git routing hint — O3 hint-only design (no agent identity).
    //
    // By this point every git MUTATION has already been denied by the
    // mutation-slip guard above. So any git command reaching the allowlist-
    // failure is either a recognized readonly verb in an un-allowlisted flag
    // form (e.g. `git --no-pager --paging=no log`, `git -C <ext> diff`,
    // `git --git-dir=/x diff`) OR an unrecognized non-mutation verb. Both route
    // to `ask` (prompt) — NOT a hard deny — so opencode's per-agent permission
    // table decides. This uses the WALKER verb (blocked.verb), not blocked[1],
    // so the `--no-pager` pollution of GIT_READONLY_SUBCOMMANDS cannot invert
    // the decision. Non-git blocked commands still hard-deny.
    if (blocked.tokens[0] === "git") {
        return {
            action: "ask",
            reason:
                "[shell-guard] Non-read-only or unrecognized git command detected: " +
                JSON.stringify(blocked.tokens) +
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
