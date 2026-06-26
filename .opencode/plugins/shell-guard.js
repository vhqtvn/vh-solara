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
// Back-compat: this module re-exports the prior public API surface so anything
// that imported the primitives from "shell-guard.js" keeps working. The
// canonical home for those primitives is now shell-guard-core.js.

import fs from "node:fs";
import {
    evaluate,
    repoRoot,
    resolveReadPath,
    // Re-exported for back-compat (canonical home is shell-guard-core.js).
    id,
    SKIP_COMMIT_GATE_RE,
    shouldSuppressForbidden,
    stripLeadingEnvVars,
    stripLeadingEnvVarsFromString,
    unquoteToken,
    validateGitCPath,
    normalizeGitC,
    isGateWrapperInDevShExec,
    isEnvPrefixedDevShExec,
} from "./shell-guard-core.js";

// Re-export the full prior public API for back-compat. Nothing in the corpus
// imports the rule helpers today (grep-verified), but keeping the export shape
// stable means an external consumer's `import { repoRoot } from "shell-guard.js"`
// keeps resolving.
export {
    id,
    SKIP_COMMIT_GATE_RE,
    shouldSuppressForbidden,
    stripLeadingEnvVars,
    stripLeadingEnvVarsFromString,
    repoRoot,
    resolveReadPath,
    unquoteToken,
    validateGitCPath,
    normalizeGitC,
    isGateWrapperInDevShExec,
    isEnvPrefixedDevShExec,
};

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
                // Delegate to the shared engine. Translate the {action,reason}
                // verdict back to the OpenCode verbs the plugin must emit:
                //   deny  -> throw (OpenCode treats thrown errors as a block)
                //   ask   -> console.error(hint) + bare return (passthrough to
                //            opencode's per-agent permission table)
                //   allow -> bare return
                const r = await evaluate(output.args.command);
                if (r.action === "deny") throw new Error(r.reason);
                if (r.action === "ask") {
                    console.error(r.reason);
                    return; // let opencode's permission table decide
                }
                return;
            }
        },
    };
};

export const ShellGuardPlugin = server;

export default {
    id,
    server,
};
