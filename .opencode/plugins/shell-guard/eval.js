// eval.js — node CLI shim that exposes the shell-guard engine as a stable
// subprocess contract for the Go permission bridge (ShellGuardHook).
//
// Contract (MUST stay stable; the Go side parses action/reason exactly):
//   Invocation:  node <abs>/eval.js <argv...>
//                argv joined with single spaces = the command string
//                (mirrors opencode's output.args.command that the plugin sees).
//   stdout:      exactly ONE JSON line
//                {"action":"allow|deny|ask","reason":"..."}
//                The engine NEVER emits a `rewrite` field — detection/parse
//                drives the decision only; the plugin wrapper never mutates
//                the command (Option A).
//   stderr:      engine diagnostics only (never the decision).
//   exit 0:      a decision was emitted (action authoritative for ALL three:
//                allow / deny / ask). The Go hook maps each to its Action.
//   exit 2:      engine fault (empty stdout). The Go hook denies by default.
//
// NOTE: the subprocess contract has NO workdir (the Go bridge spawns node with
// cwd = HarnessRoot but passes no per-command workdir), so commandCwd defaults
// to repoRoot() inside evaluate(). The plugin wrapper (shell-guard.js) is the
// only caller that can supply the real output.args.workdir; this shim cannot,
// so the in-project `-C <repoRoot()>` classification (the conditional-strip
// case) resolves to the scratch install root.
//
// cwd: the caller (ShellGuardHook) sets cwd = the project root containing
// .opencode (the harness root). repoRoot() in the core derives the root from
// __dirname (plugins/ -> two up), so it is cwd-robust, but passing a sane cwd
// keeps any fs-based probe anchored.
//
// ESM: lives under the .opencode/ "type":"module" scope (W2). Top-level await
// is permitted; evaluate is async so the body is an async IIFE.

import { evaluate } from "../shell-guard-core.js";

main(process.argv.slice(2)).catch((err) => {
    // Engine fault: diagnostics to stderr, empty stdout, exit 2.
    // (evaluate itself returns denies rather than throwing; reaching this
    //  catch means the engine could not even produce a verdict — WASM load
    //  failure, rule-import fault, etc. The Go hook treats exit 2 as Deny.)
    process.stderr.write(
        `shell-guard eval: engine fault: ${err && err.stack ? err.stack : err}\n`,
    );
    process.exit(2);
});

async function main(argv) {
    // argv joined with single spaces = the command string the engine sees.
    // An empty argv (no args) -> "" -> evaluate returns {deny, "empty command"}.
    const command = argv.join(" ");

    let r;
    try {
        r = await evaluate(command);
    } catch (err) {
        // Engine fault inside evaluate (should not happen — evaluate returns
        // denies — but guard anyway). Diagnostics to stderr, exit 2.
        process.stderr.write(
            `shell-guard eval: engine fault: ${err && err.stack ? err.stack : err}\n`,
        );
        process.exit(2);
    }

    // Normalize: evaluate always returns {action, reason}; defend shape.
    const action =
        r && (r.action === "allow" || r.action === "deny" || r.action === "ask")
            ? r.action
            : "deny";
    const reason =
        r && typeof r.reason === "string" ? r.reason : "no reason provided";

    // Exactly ONE JSON line on stdout: {action, reason}. The engine NEVER
    // produces a `rewrite` field (detect/parse for the decision only — the
    // plugin wrapper never mutates the command). exit 0 = decision emitted.
    process.stdout.write(JSON.stringify({ action, reason }) + "\n");
    process.exit(0);
}
