// Permission transform types + helpers — GENERIC CORE ENGINE (platform_managed).
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ OWNERSHIP: platform_managed (generic core engine).                        │
// │ This file ships with the harness starter and is fully owned by it.        │
// │ A consuming project MUST NOT edit this file — extend instead via          │
// │ `config-transform.mjs` (project_owned).                                    │
// └──────────────────────────────────────────────────────────────────────────┘
//
// This file provides JSDoc type definitions, Decision constants, and optional
// builder helpers for the project-owned transform (`config-transform.mjs`). It
// is intentionally free of project-specific logic.
//
// Import from your project transform:
//   import { Decision, allow, deny, ask } from "./config-transform.core.mjs";
//
// The type definitions below are compatible with `// @ts-check` in JS files
// and with TypeScript's JSDoc inference.

// ── Decision enum ────────────────────────────────────────────────────────────
//
// Mirrors the Go Decision type (internal/permconfig/model.go). The lockstep
// test (internal/permconfig/transform_lockstep_test.go) asserts these string
// values match the Go enum exactly. Do NOT change the values without updating
// both sides.

/**
 * Permission decision enum. Matches Go's permconfig.Decision.
 * @readonly
 * @enum {string}
 */
export const Decision = Object.freeze({
    ALLOW: "allow",
    DENY: "deny",
    ASK: "ask",
});

// ── Type definitions ─────────────────────────────────────────────────────────

/**
 * One bash permission entry contributed by the transform.
 * @typedef {Object} BashEntry
 * @property {string} pattern - Bash glob pattern (e.g. "./dev.sh *"). Non-empty.
 *   Must NOT collide with a protected key ("*", command-group commands,
 *   "vh-agent-harness *", backlog command).
 * @property {"allow"|"deny"|"ask"} decision - Permission decision for this pattern.
 */

/**
 * A patch targeting one agent's bash block.
 * @typedef {Object} PermissionPatch
 * @property {string} agent - Agent name. Must be in context.agents (rendered roster).
 * @property {BashEntry[]} bash - Extra bash entries for this agent.
 */

/**
 * The render context passed to the transform. Contains NO ambient env, NO
 * secrets, NO file paths — only a deterministic snapshot of the active render.
 * @typedef {Object} TransformContext
 * @property {string[]} packs - Active overlay pack names (filename stems).
 * @property {Object<string, string>} features - Resolved feature values (e.g. {backlog: "true"}).
 * @property {string[]} agents - Rendered agent names (core + active-pack).
 */

/**
 * The top-level argument passed to the transform function.
 * @typedef {Object} TransformInput
 * @property {TransformContext} context - The render context.
 */

/**
 * The expected return value of the transform function.
 * @typedef {Object} PermissionTransformResult
 * @property {PermissionPatch[]} permissionPatches - Patches to apply. Empty = no-op.
 */

// ── Builder helpers (optional) ───────────────────────────────────────────────
//
// Convenience builders for bash entries. Using these ensures the decision value
// is always a valid enum member. Import as needed:
//   import { allow, deny, ask } from "./config-transform.core.mjs";

/**
 * Build an allow entry for the given pattern.
 * @param {string} pattern - Bash glob pattern.
 * @returns {BashEntry}
 */
export function allow(pattern) {
    return { pattern, decision: Decision.ALLOW };
}

/**
 * Build a deny entry for the given pattern.
 * @param {string} pattern - Bash glob pattern.
 * @returns {BashEntry}
 */
export function deny(pattern) {
    return { pattern, decision: Decision.DENY };
}

/**
 * Build an ask entry for the given pattern.
 * @param {string} pattern - Bash glob pattern.
 * @returns {BashEntry}
 */
export function ask(pattern) {
    return { pattern, decision: Decision.ASK };
}
