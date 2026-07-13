// Permission transform — PROJECT-OWNED SCAFFOLD (F-intent).
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ OWNERSHIP: project_owned.                                                  │
// │ The harness seeds this scaffold on first install and then LEAVES IT ALONE  │
// │ on every update — your edits here are preserved forever.                   │
// └──────────────────────────────────────────────────────────────────────────┘
//
// This file lets a consuming project contribute EXTRA bash permission entries
// per agent that the canonical permission-packs cannot express — for example
// granting `"./dev.sh *": "allow"` to a specific agent. The harness invokes
// this function at render time, VALIDATES the typed output, and feeds it to the
// canonical emitter (permconfig.Emit), which remains the SOLE writer of
// opencode.jsonc. The transform NEVER directly mutates the config file.
//
// ── STRICT CONTRACT ──────────────────────────────────────────────────────────
//
// INPUT:  { context: { packs, features, agents } }
//   - packs:    string[]      active overlay pack names
//   - features: {key: string} resolved feature values (e.g. {backlog: "true"})
//   - agents:   string[]      rendered agent names (core + active-pack)
//
//   NO ambient env. NO secrets. NO file paths. NO process state. The context
//   is a deterministic snapshot of the render — it does not leak the host.
//
// OUTPUT: { permissionPatches: [{ agent, bash: [{ pattern, decision }] }] }
//   - agent:     string         must be in context.agents (fail-closed otherwise)
//   - pattern:   string         bash glob, non-empty, must NOT collide with a
//                               protected key ("*", command-group commands,
//                               "vh-agent-harness *", backlog command)
//   - decision:  "allow"|"deny"|"ask"
//
//   Empty/absent permissionPatches = no-op (byte-identical to no-transform).
//
// ── TRUST MODEL ──────────────────────────────────────────────────────────────
//
// The transform is TRUSTED PROJECT-OWNED CODE — the same trust model as
// forbidden-patterns.project.js. If you can edit this file, you already have
// commit authority on the repo, so the transform has the same authority as any
// other project-owned source file. It is NOT sandboxed.
//
// The harness applies an ADVISORY source lint that rejects obvious host-API
// usage (process.env, require(), fs.*, http(s).request, child_process,
// Math.random, Date.now, …) as defense-in-depth. This lint is NOT a security
// boundary — it is trivially evaded via string concatenation, dynamic imports,
// etc. The REAL security boundary is Go validation of the typed output
// (ValidateTransformOutput), which runs AFTER the transform returns and
// rejects any malformed/invalid/non-JSON output LOUD (never silent).
//
// A hard 10s timeout kills hung transforms.
//
// ── SECURITY NOTE ────────────────────────────────────────────────────────────
//
// The transform CAN alter core-agent permissions (including the build agent),
// because it is trusted project-owned code (not sandboxed). Review every
// project transform as a SECURITY POLICY: a compromised transform could grant
// arbitrary bash access to any rendered agent. The Go validator
// (ValidateTransformOutput) enforces the output shape and rejects protected-key
// collisions, but the intent (which patterns to allow) is the project's
// responsibility. The advisory lint catches only obvious host-API misuse.
//
// ── TYPES ────────────────────────────────────────────────────────────────────
//
// Import types and helpers from the harness-owned support file:
//   import { Decision, allow, deny, ask } from "./config-transform.core.mjs";
//
// Run `vh-agent-harness example .vh-agent-harness/config-transform.mjs` for a
// ready-to-adapt example with the full type surface.

// Default: no-op. Edit this function body to return permission patches.
// When permissionPatches is empty, the transform has zero effect —
// opencode.jsonc is emitted byte-identically to the no-transform path.
export default function transform({ context }) {
  // Example (uncomment and edit):
  //
  // return {
  //   permissionPatches: [
  //     {
  //       agent: "build",
  //       bash: [
  //         { pattern: "./dev.sh *", decision: "allow" },
  //       ],
  //     },
  //   ],
  // };

  return { permissionPatches: [] };
}
