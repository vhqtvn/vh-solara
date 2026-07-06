// shell-guard.js — OpenCode plugin wrapper around the extracted shell-guard
// decision engine (shell-guard-core.js).
//
// Classification (slice 4b): the bash-branch decision body that lived inline
// here has moved to shell-guard-core.js so the Go permission bridge's node
// CLI shim (shell-guard/eval.js) imports the SAME source of truth. This file
// now holds ONLY the OpenCode coupling:
//   - the `server()` factory returning the `tool.execute.before` handler,
//   - the `read`-tool branch (OpenCode-specific: it inspects output.args and
//     short-circuits non-existent paths — stays plugin-only), and
//   - a thin bash branch that delegates to `evaluate` and re-translates the
//     {action,reason} verdict back to the OpenCode verbs (throw=deny,
//     console.error+return=ask-passthrough, return=allow).
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
                if (r.action === "deny") throw new Error(r.reason);
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
