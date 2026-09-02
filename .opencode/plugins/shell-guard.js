// shell-guard.js — OpenCode plugin wrapper around the extracted shell-guard
// decision engine (shell-guard-core.js).
//
// Classification (slice 4b): the bash-branch decision body that lived inline
// here has moved to shell-guard-core.js so the Go permission bridge's node
// CLI shim (shell-guard/eval.js) imports the SAME source of truth. This file
// now holds ONLY the OpenCode coupling:
//   - the `server()` factory returning the `tool.execute.before` handler,
//   - the `read`-tool branch (OpenCode-specific: it inspects output.args and
//     short-circuits non-existent paths — stays plugin-only),
//   - a thin bash branch that delegates to `evaluate` and re-translates the
//     {action,reason} verdict back to the OpenCode verbs (throw=deny,
//     console.error+return=ask-passthrough, return=allow), and
//   - the static deny-time grant-naming suffix (unreachableGrantNotice): on
//     deny, lists configured allow/ask grants matching the denied command —
//     they cannot rescue it because the throw happens before per-agent
//     evaluation. Static config attribution only; no session/agent identity.
//
// Global-flag detect/parse (git -C / --no-pager / etc.): the wrapper delegates
// to `evaluate(output.args.command, commandCwd)` for the allow/deny/ask
// DECISION only. It NEVER mutates output.args.command — the engine's parse
// (walkGitGlobals) extracts the verb past leading git global flags and
// classifies any `-C` path so the security decisions (mutation-slip guard,
// relative-`-C` deny+notice, external-`-C` routing, info-flag allow) fire
// correctly. There is no command rewrite: a detector has a safe fallback
// ("I don't know -> ask") but a rewriter does not, and real agent commands
// (pipelines, sequences, subshells) make a safe whole-command rewrite
// unprovable. opencode's path-blind L2 matcher still sees the ORIGINAL command
// text, so in-project `git -C <cwd> <ro>` and `--paginate`/`-p`/`-P` readonly
// forms will prompt (accepted tradeoff; the load-bearing prompt-free path for
// `git --no-pager <sub>` is the config-table `git --no-pager <sub> *` L2
// rules, NOT a rewrite).
//
// commandCwd: derived from output.args.workdir (the command's real cwd,
// resolved to absolute), falling back to repoRoot() when workdir is absent.
// evaluate needs it to classify `-C` paths (in-project vs external vs
// relative).
//
// Back-compat: this module re-exports the prior public API surface so anything
// that imported the primitives from "shell-guard.js" keeps working. The
// canonical home for those primitives is now shell-guard-core.js.

import fs from "node:fs";
import path from "node:path";
import {
    evaluate,
    repoRoot,
    resolveReadPath,
    walkGitGlobals,
    // Re-exported for back-compat (canonical home is shell-guard-core.js).
    id,
    SKIP_COMMIT_GATE_RE,
    shouldSuppressForbidden,
    stripLeadingEnvVars,
    stripLeadingEnvVarsFromString,
    unquoteToken,
    isGateWrapperInDevShExec,
    isEnvPrefixedDevShExec,
} from "./shell-guard-core.js";

// ---------------------------------------------------------------------------
// Static deny-time grant naming (misconfigured-grant visibility).
//
// The engine (evaluate) denies BEFORE OpenCode consults the per-agent
// permission table (the wrapper throws on deny), so a configured
// permission.bash grant that matches the denied command can never rescue it.
// On deny, this wrapper enriches the thrown message with a STATIC listing of
// those matching configured grants, read from the repo's opencode.jsonc.
//
// Wording contract:
//   - The text says the grants are CONFIGURED and cannot rescue THIS command.
//     It NEVER attributes anything to an actively-executing agent: the hook
//     input exposes sessionID only, there is no session->agent resolution
//     here, and none may be inferred.
//   - Remediation names ONLY: remove the grant, downgrade the grant, or route
//     the command through `vh-agent-harness exec ...` where the verb family is
//     supported. It must NEVER suggest engine-allowlist addition via overlay —
//     no allow-side project seam exists (ALLOWED_PATTERNS is closed over the
//     generated tables; only forbidden-patterns.project.js is project-
//     extensible, and it is deny-side).
//   - Multiple matching grants list deterministically (agent, pattern, action
//     sort order).
//
// Pattern matching models the canonical trailing-" *" table shapes
// (token-prefix semantics, mirroring the engine's allowlist matcher); richer
// glob forms simply fail to match, which is message-only impact — the deny
// itself always stands. A bare "*" catch-all grant compiles to zero tokens
// and is deliberately never listed (naming it on every deny would be pure
// noise).
//
// Fail-open by design: if opencode.jsonc is absent, unreadable, or not JSON
// (the canonical emitter's output always is), there is simply no suffix — the
// plain engine deny stands unchanged. Evaluation semantics and engine-over-
// table precedence are NOT touched; only the deny MESSAGE is enriched.
// ---------------------------------------------------------------------------

// compileGrantPattern tokenizes one permission.bash pattern the same way the
// engine compiles ALLOWED_PATTERNS entries: a trailing " *" (or "*") becomes
// a wildcard over additional tokens; everything else is an exact token match.
// A bare "*" compiles to zero tokens (see the header note: never listed).
function compileGrantPattern(pattern) {
    const trimmed = pattern.trim();
    const wildcard = trimmed.endsWith("*");
    const prefix = wildcard ? trimmed.replace(/\s*\*$/, "") : trimmed;
    return { tokens: prefix.split(/\s+/).filter(Boolean), wildcard };
}

// grantMatchesCommand reports whether the configured grant pattern matches
// the command under token-prefix semantics (the shared shape of the engine's
// allowlist matcher and OpenCode's bash patterns).
function grantMatchesCommand(grant, commandTokens) {
    if (grant.tokens.length === 0) return false;
    if (commandTokens.length < grant.tokens.length) return false;
    for (let i = 0; i < grant.tokens.length; i++) {
        if (commandTokens[i] !== grant.tokens[i]) return false;
    }
    return grant.wildcard || commandTokens.length === grant.tokens.length;
}

// loadConfiguredRescueGrants reads the repo's opencode.jsonc and returns the
// configured allow/ask permission.bash grants (the rescue promises) as
// {agent, pattern, action} triples: the top-level block (agent "default") plus
// every agent block. Returns null on ANY read/parse/shape failure (fail-open).
function loadConfiguredRescueGrants() {
    try {
        const cfgPath = path.join(repoRoot(), "opencode.jsonc");
        const raw = fs.readFileSync(cfgPath, "utf8");
        const cfg = JSON.parse(raw);
        const grants = [];
        const pushBlock = (agent, block) => {
            if (!block || typeof block !== "object") return;
            for (const [pattern, action] of Object.entries(block)) {
                if (action === "allow" || action === "ask") {
                    grants.push({ agent, pattern, action });
                }
            }
        };
        pushBlock("default", cfg?.permission?.bash);
        const agents = cfg?.agent;
        if (agents && typeof agents === "object") {
            for (const [name, def] of Object.entries(agents)) {
                pushBlock(name, def?.permission?.bash);
            }
        }
        return grants;
    } catch {
        return null; // absent/unreadable/not-JSON: no suffix, plain deny stands
    }
}

// unreachableGrantNotice composes the static grant-naming suffix for a denied
// command, or null when no configured grant matches (the common case — the
// plain engine deny message stands unchanged).
function unreachableGrantNotice(command) {
    const grants = loadConfiguredRescueGrants();
    if (!grants) return null;
    const commandTokens = String(command).trim().split(/\s+/).filter(Boolean);
    const matches = grants
        .filter((g) => grantMatchesCommand(compileGrantPattern(g.pattern), commandTokens))
        .sort((a, b) =>
            a.agent < b.agent ? -1 : a.agent > b.agent ? 1 :
            a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 :
            a.action < b.action ? -1 : a.action > b.action ? 1 : 0);
    if (matches.length === 0) return null;
    const listed = matches
        .map((g) => `agent "${g.agent}" pattern "${g.pattern}" (${g.action})`)
        .join("; ");
    return (
        "Denied before per-agent grants are evaluated. Matching configured" +
        " grants that cannot rescue this command: " + listed + "." +
        " Remedies: (1) remove the grant, (2) downgrade the grant, or (3)" +
        " route the command through vh-agent-harness exec where the verb" +
        " family is supported."
    );
}

// Re-export the full prior public API for back-compat. Nothing in the corpus
// imports the rule helpers today (grep-verified), but keeping the export shape
// stable means an external consumer's `import { repoRoot } from "shell-guard.js"`
// keeps resolving. (validateGitCPath / normalizeGitC were removed when the
// registry-driven walker replaced the bespoke -C normalizer; walkGitGlobals is
// the replacement and is exported for test reuse.)
export {
    id,
    SKIP_COMMIT_GATE_RE,
    shouldSuppressForbidden,
    stripLeadingEnvVars,
    stripLeadingEnvVarsFromString,
    repoRoot,
    resolveReadPath,
    unquoteToken,
    walkGitGlobals,
    isGateWrapperInDevShExec,
    isEnvPrefixedDevShExec,
};

// Resolve the command's working directory to an absolute path, falling back to
// repoRoot() when workdir is absent (the common case). Mirrors the cwd-robust
// pattern in repoRoot(): never uses process.cwd() (unreliable in the plugin
// server context). Used as the no-op reference for `-C <abs path>` stripping.
function commandCwdFrom(workdir) {
    if (!workdir || typeof workdir !== "string") return repoRoot();
    return path.isAbsolute(workdir) ? workdir : path.resolve(repoRoot(), workdir);
}

export const server = async () => {
    return {
        "tool.execute.before": async (input, output) => {
            if (input.tool === "read") {
                // Non-existent target -> not-found error now, no permission
                // prompt (operator-accepted existence leak). Existing paths
                // fall through to opencode's normal permission handling.
                const fp = output?.args?.filePath ?? output?.args?.path;
                const resolved = resolveReadPath(fp, repoRoot());
                if (resolved && !fs.existsSync(resolved)) {
                    throw new Error(
                        `File not found: ${fp}. The read was aborted instead of` +
                        ` raising a permission prompt for a path that does not` +
                        ` exist. Check the path — if you meant an in-repo file,` +
                        ` use a repo-relative path (e.g. tmp/...), not a` +
                        ` hardcoded absolute home dir.`,
                    );
                }
                return;
            }

            if (input.tool === "bash") {
                // Delegate to the shared engine for the DECISION only. The
                // wrapper NEVER mutates output.args.command — a detector has a
                // safe fallback (ask) but a rewriter does not, and real agent
                // commands (pipelines, sequences, subshells) make a safe
                // whole-command rewrite unprovable. Translate the {action,
                // reason} verdict to the OpenCode verbs:
                //   deny  -> throw (OpenCode treats thrown errors as a block)
                //   ask   -> console.error(hint) + bare return (passthrough to
                //            opencode's per-agent permission table)
                //   allow -> bare return (passthrough; L2 sees the original)
                const commandCwd = commandCwdFrom(output?.args?.workdir);
                const r = await evaluate(output.args.command, commandCwd);
                if (r.action === "deny") {
                    // Static grant naming: when configured allow/ask
                    // grants match this denied command, list them — they can
                    // never rescue it because this throw happens before the
                    // per-agent table is evaluated. Null when nothing matches
                    // (the plain engine deny stands unchanged).
                    const notice = unreachableGrantNotice(output.args.command);
                    throw new Error(notice ? r.reason + "\n" + notice : r.reason);
                }
                if (r.action === "ask") {
                    console.error(r.reason);
                    return; // let opencode's permission table decide
                }
                return; // allow: passthrough; no command mutation
            }
        },
    };
};

export const ShellGuardPlugin = server;

export default {
    id,
    server,
};
