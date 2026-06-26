// Rule aggregator for shell-guard — GENERIC (managed).
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ OWNERSHIP: managed (generated aggregator).                                 │
// │ This file exists SOLELY so the shell-guard plugin (and the Go permission   │
// │ bridge's eval.js shim) can do a STATIC named import:                       │
// │   import { FORBIDDEN_PATTERNS } from "../repo-configs/forbidden-patterns.js"│
// │ The two rule sources are:                                                  │
// │   1. forbidden-patterns.core.js   — managed generic core rules (always on) │
// │   2. forbidden-patterns.project.js — OPTIONAL project overlay              │
// │ This file concatenates them into a single exported FORBIDDEN_PATTERNS.     │
// │                                                                            │
// │ A consuming project MUST NOT edit this file. To add project-specific       │
// │ rules, edit forbidden-patterns.project.js (run `vh-agent-harness example    │
// │ .opencode/repo-configs/forbidden-patterns.project.js` for templates). The   │
// │ merge pattern is core first, then project.                                 │
// └──────────────────────────────────────────────────────────────────────────┘
//
// The project overlay is OPTIONAL: if forbidden-patterns.project.js does not
// exist (the fresh-install default — only the .example.js ships), the overlay is
// treated as an empty list and only the core rules apply. Any OTHER import
// failure (syntax error in a real overlay, permission error, ...) is re-thrown
// so a broken overlay faults loudly instead of silently weakening the rules.

import { FORBIDDEN_PATTERNS as _CORE } from "./forbidden-patterns.core.js";

// Attempt to load the OPTIONAL project overlay. Absent-overlay is benign; a
// present-but-broken overlay must fail loudly (do not swallow syntax/runtime
// errors — only the module-not-found codes).
let _project = [];
try {
    const mod = await import("./forbidden-patterns.project.js");
    _project = Array.isArray(mod?.FORBIDDEN_PATTERNS)
        ? mod.FORBIDDEN_PATTERNS
        : [];
} catch (err) {
    const code = err && typeof err.code === "string" ? err.code : "";
    if (
        code !== "ERR_MODULE_NOT_FOUND" &&
        code !== "MODULE_NOT_FOUND"
    ) {
        // Real overlay present but broken — surface it, do not silently weaken.
        throw err;
    }
    // No project overlay installed: overlay contributes nothing.
}

// Merge: core rules first, then project-specific rules. This matches the merge
// pattern documented via `vh-agent-harness example .opencode/repo-configs/forbidden-patterns.project.js`.
export const FORBIDDEN_PATTERNS = [..._CORE, ..._project];
