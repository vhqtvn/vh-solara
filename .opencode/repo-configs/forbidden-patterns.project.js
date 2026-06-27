// Project-specific deny-pattern overlay — PROJECT-OWNED SCAFFOLD.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ OWNERSHIP: project_owned.                                                  │
// │ The harness seeds this blank scaffold on first install and then LEAVES IT │
// │ ALONE on every update — your edits here are preserved forever. Fill it in  │
// │ with your project's deny-rules.                                            │
// └──────────────────────────────────────────────────────────────────────────┘
//
// This file is OPTIONAL. The rule aggregator `forbidden-patterns.js` loads it
// if present and merges it on top of the generic core:
//     final = [ ...coreRules, ...yourProjectRules ]
//
// IMPORTANT — no double-merge: export ONLY your project's own rules here. Do
// NOT re-import or re-spread forbidden-patterns.core.js — the aggregator
// already prepends the core array. Re-merging core here duplicates every core
// rule in the final list.
//
// See: vh-agent-harness example .opencode/repo-configs/forbidden-patterns.project.js  (prints ready-to-adapt rule templates)
// (host fingerprints, secret env-vars, infra lifecycle bans, DB-table bans) and
// the shared inspector-allowIf builder.
//
// Each deny rule is an object with at minimum { pattern, why, alternative }:
//     { pattern: "my-project-rule", why: "why this is denied", alternative: "canonical form" }
// Drop completed rules into the array below. Empty by default (only the generic
// core rules apply) so the file stays schema-valid until you add a rule.

// Your project rules go here. Empty by default (only generic core rules apply).
export const FORBIDDEN_PATTERNS = [];
