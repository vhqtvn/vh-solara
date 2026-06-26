// Project-specific deny-pattern overlay — EXAMPLE (platform_managed docs).
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ OWNERSHIP: platform_managed (shipped as reference documentation).          │
// │ This is an EXAMPLE showing how a consuming project appends its own         │
// │ rules on top of forbidden-patterns.core.js. Copy this file to              │
// │ `forbidden-patterns.project.js`, then EDIT THAT COPY (project_owned) and   │
// │ fill in your project's specifics. The harness never overwrites your        │
// │ `forbidden-patterns.project.js`.                                            │
// └──────────────────────────────────────────────────────────────────────────┘
//
// IMPORTANT — no double-merge: the rule aggregator `forbidden-patterns.js`
// already merges core + project:
//     final = [ ...coreRules, ...projectRules ]
// So your `forbidden-patterns.project.js` must export ONLY your project's own
// rules — do NOT re-import or re-spread the core array here, or the core rules
// will be duplicated in the final list.
//
// A consuming project typically adds rules in three categories:
//   1. Host fingerprints — deny commands targeting a specific demo or
//      production host from inside the dev container.
//   2. Project secret env-vars — deny passing a known-secret env-var on the
//      command line (shell history / transcript exfiltration risk).
//   3. Project-specific infra lifecycle bans — e.g. deny mutating
//      Terraform-managed cloud resources (provider services / registries / IAM)
//      or enumerating project auth/identity DB tables via psql. The generic core
//      does NOT carry these because they assume project-managed infra.
//
// The values below are GENERIC PLACEHOLDERS. Replace them with your project's
// actual values when you copy this file to forbidden-patterns.project.js.

// Reusable inspector-allowIf carve-outs. The generic engine
// (forbidden-patterns.core.js) EXPORTS these builders so project rules can reuse
// the exact same carve-out semantics instead of re-implementing them:
//   - ALLOW_IF_INSPECTOR_FULL       — exempt read-only inspectors incl. file readers
//   - ALLOW_IF_INSPECTOR_EXISTENCE  — exempt existence/metadata probes only
//   - inspectorAllowIf(group)       — build a custom carve-out for a verb group
// (This is a NAMED import of public builders, NOT a re-spread of the core rule
// array — the aggregator already prepends the core rules.)
import {
    ALLOW_IF_INSPECTOR_FULL,
} from "./forbidden-patterns.core.js";

// ── 1. Host fingerprint ─────────────────────────────────────────────────────
// Match commands that ssh/scp into your specific demo or prod host. Replace the
// regex with your actual hostnames / IPs.
const VPS_HOST_PATTERN = /\b(ubuntu@your-demo-host\.example\.com)\b/;

// ── 2. Project JWT-secret env-var on the command line ───────────────────────
// Replace YOUR_PROJECT_SLUG with your uppercased project slug.
const _jwtSecretRule = {
    id: "jwt-secret-on-cli",
    // Anchored to `<SLUG>_JWT_SECRET=<16+ hex>` on the command line. The
    // allowIf exempts echo/printf/grep references (e.g. docs that quote the
    // env-var name with a placeholder hex value).
    re: /\bYOUR_PROJECT_SLUG_JWT_SECRET\s*=\s*[A-Fa-f0-9]{16,}/,
    allowIf: ALLOW_IF_INSPECTOR_FULL,
    why:
        "Do not pass YOUR_PROJECT_SLUG_JWT_SECRET on the command line. It ends" +
        " up in shell history, opencode's transcript DB, and any ssh log. Mount" +
        " it via an env file or read it inside the container that already has" +
        " it.",
};

// ── 3. Project-specific infra lifecycle ban ─────────────────────────────────
// Example: deny mutating Terraform-managed cloud resources. The generic core
// does NOT carry these because they assume a specific project-managed infra
// stack. Adapt the provider, services, and verbs to your stack (the literal
// `<provider>` / `<service-a>` placeholders below are intentionally generic).
const _terraformManagedCloudRule = {
    id: "terraform-managed-cloud-mutate",
    re: /\b<provider>\s+(<service-a>|<service-b>)\s+(create|delete|update|stop|start|put|set|attach|detach)-/,
    allowIf: ALLOW_IF_INSPECTOR_FULL,
    why:
        "These cloud resources are Terraform-managed. Use terraform for" +
        " lifecycle changes on the host where the state lives, not the cloud CLI.",
};

// ── 4. Project auth/identity DB-table enumeration ban ───────────────────────
// Example: deny enumerating project auth/identity tables via psql. Replace the
// table alternation with YOUR project's auth/identity table names.
const _authTableReadRule = {
    id: "psql-auth-table-read",
    re: /\bpsql\b[^|;&\n]+-c\s+["'][^"']*\bSELECT\b[^"']*\bFROM\s+(your_users_table|your_sessions_table)\b/i,
    allowIf: ALLOW_IF_INSPECTOR_FULL,
    why:
        "Do not enumerate auth/identity tables via psql. Go through the signup" +
        " flow or seeds, do not pull identifiers out of the DB to forge tokens.",
};

// ── Export ONLY your project rules (the aggregator merges core on top) ──────
export const FORBIDDEN_PATTERNS = [
    _jwtSecretRule,
    _terraformManagedCloudRule,
    _authTableReadRule,
    // Add more project-specific rules here.
];

// Optional: export VPS_HOST_PATTERN if your shell-guard wiring consumes it.
export { VPS_HOST_PATTERN };
