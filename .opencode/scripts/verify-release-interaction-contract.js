// verify-release-interaction-contract.js
//
// Release-interaction-contract regression guard (STRUCTURAL, text-contract).
//
// Asserts the operator-interaction contract landed in the rendered release-flow
// agent prompts and that the superseded "human explicitly approves" /
// approval-round phrasing is gone. This is the contract encoded by releaser
// Invariant 8 (the three-class contract: core rule = operator initiation IS the
// authorization, green gate = proceed; STOP-AND-ASK only on the six named
// conditions; NEVER-ASK for the standard ceremony; AUTO-RECOVER for a red gate
// whose recovery is mechanical, known-safe, and named in the closed recipe
// list) plus the handoff-field binding any readiness reporter must satisfy
// (authorized_by:"operator-initiation", no separate confirmation round).
//
// HONEST FRAMING — READ BEFORE TRUSTING A PASS:
//   This is a STRUCTURAL contract-content regression guard. It proves:
//     (a) the contract text (the three-class contract — STOP-AND-ASK,
//         NEVER-ASK, AUTO-RECOVER — plus operator-initiation authorization and
//         the do-not-run-confirmation-rounds rule) is PRESENT in the rendered
//         releaser prompt; AND
//     (b) any rendered agent that populates a release handoff field binds it to
//         authorized_by:"operator-initiation" and names the confirmation-round
//         anti-pattern; AND
//     (c) the superseded "human explicitly approves" / "approved_by_human"
//         phrasing is ABSENT from every rendered agent prompt.
//   It does NOT prove the runtime green-gate -> proceed behavioral outcome.
//   That outcome needs an agent-runtime harness that drives a live releaser /
//   readiness session through a green ceremony and asserts no confirmation
//   round is emitted — such a runtime harness does not exist in this repo.
//   A pass here is "result: proven" for the text-presence / text-absence
//   assertion ONLY; it is "not-demonstrable" for the runtime outcome.
//
// DOMAIN-NEUTRAL DESIGN (this script ships under templates/core/ to consumers):
//   This verifier names NO project-specific or overlay-pack-specific agent. It
//   asserts against the shipped `releaser` agent (a release-overlay artifact
//   that renders wherever the release overlay is selected, the same way the
//   sibling verify-f3-authoring-surfaces.js asserts against the shipped `build`
//   agent). The handoff-binding rule is expressed structurally — "any rendered
//   agent carrying the release handoff field must satisfy the binding" — so it
//   fires on whichever reporter renders in a given tree without naming it. An
//   agent render that does not exist in a tree contributes nothing (and cannot
//   regress), so it is correctly excluded.
//
// INVOCATION PATTERN:
//   This script follows the STANDALONE verifier convention used by every
//   sibling verify-*.js under .opencode/scripts/ (verify-f3-authoring-surfaces,
//   verify-no-unrendered-paths, verify-no-source-tree-only-paths). None of the
//   sibling verifiers are wired into a Makefile target, a doctor check, or a
//   release-prep runner; each is invoked manually as:
//     vh-agent-harness exec node .opencode/scripts/verify-release-interaction-contract.js
//   (See the v0.17.0 migration note: "Standalone verify-script, consistent with
//   the sibling verifier pattern; NOT wired into doctor in this slice.") If a
//   shared invocation point is later added, this script should join it alongside
//   its siblings; until then it runs standalone like they do.
//
//   NOTE: always run the RENDERED copy at .opencode/scripts/ (tokens resolved).
//   The templates/core/.opencode/scripts/ source copy is the embed source only.
//
// Pass signal: "verification: ok (<N> assertions)".
// Fail signal: process.exit(1) with the failing assertion label on stderr.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agent = (...p) => join(__dirname, "..", "agents", ...p);
const read = (p) => readFileSync(p, "utf8");

let assertions = 0;
function expect(condition, label) {
  assertions++;
  if (!condition) {
    throw new Error(`Assertion failed: ${label}`);
  }
}

// --- Load the rendered releaser agent (existence-gated) ---
//
// The releaser is a release-overlay artifact: it renders at
// .opencode/agents/releaser.md wherever the release overlay is selected. A
// tree without the release overlay has no releaser to verify; that is noted to
// stderr (visible skip, never a silent pass) and the handoff-binding +
// negative assertions below still run over whatever agents DID render.
const releaserPath = agent("releaser.md");
const releaserExists = existsSync(releaserPath);

if (!releaserExists) {
  console.error(
    "verify-release-interaction-contract: .opencode/agents/releaser.md absent — " +
      "releaser contract assertions SKIPPED (release overlay not rendered in this tree).",
  );
}

const releaser = releaserExists ? read(releaserPath) : "";

// =============================================================================
// Contract 1 — releaser carries the operator-interaction contract (Invariant 8)
// =============================================================================
//
// Robust anchors chosen to survive minor rewording while genuinely proving the
// three-class contract landed: the STOP-AND-ASK heading, the NEVER-ASK heading,
// the confirmation-round anti-pattern name, the operator-initiation core rule,
// and the AUTO-RECOVER class (its heading, the closed recipe-list marker, and
// the seeded make-build recipe #1). The AUTO-RECOVER anchors guard the class
// added to all three contract surfaces against silent removal.

if (releaserExists) {
  const releaserName = "releaser.md";
  // The STOP-AND-ASK list is present.
  expect(
    /STOP AND ASK/i.test(releaser),
    `${releaserName} must carry the STOP-AND-ASK list (Invariant 8)`,
  );
  // The NEVER-ASK list is present.
  expect(
    /NEVER ask to confirm/i.test(releaser),
    `${releaserName} must carry the NEVER-ASK list (Invariant 8)`,
  );
  // The confirmation-round anti-pattern is named (do not run confirmation rounds).
  expect(
    /confirmation round/i.test(releaser),
    `${releaserName} must name the confirmation-round anti-pattern it kills`,
  );
  // The core rule: operator initiation IS the authorization.
  expect(
    /operator initiation/i.test(releaser),
    `${releaserName} must state the operator-initiation authorization core rule`,
  );
  // The AUTO-RECOVER class (the third interaction class, complement to
  // STOP-AND-ASK #1): a self-recoverable red gate. Guarded so the class cannot
  // be silently removed from the rendered contract.
  expect(
    /AUTO-RECOVER/i.test(releaser),
    `${releaserName} must carry the AUTO-RECOVER class heading (Invariant 8)`,
  );
  expect(
    /closed recipe list/i.test(releaser),
    `${releaserName} must mark the closed recipe list (AUTO-RECOVER is whitelist-only)`,
  );
  expect(
    /make build/i.test(releaser),
    `${releaserName} must name recipe #1 (make build) for the seeded AUTO-RECOVER recovery`,
  );
}

// =============================================================================
// Contract 2 — any release-handoff agent binds the handoff to operator-
// initiation and names the no-confirmation-round rule (domain-neutral)
// =============================================================================
//
// Domain-free structural rule: every rendered agent that carries the release
// handoff field MUST bind it to authorized_by:"operator-initiation" and MUST
// reference the confirmation-round anti-pattern (the round it refuses to run).
// This targets whichever release-readiness reporter rendered in this tree
// without naming any project-specific agent, so the rule is portable across
// the shipped release overlay and any project-local reporter that adopts the
// same handoff contract. An agent that does not carry the handoff field is not
// in scope and contributes no assertion.

const agentsDir = agent();
let agents = [];
try {
  agents = readdirSync(agentsDir)
    .filter((n) => n.endsWith(".md"))
    .map((n) => [n, read(agent(n))]);
} catch {
  agents = [];
}

let handoffAgentsChecked = 0;
for (const [name, body] of agents) {
  if (!body.includes("handoff_to_releaser")) continue;
  handoffAgentsChecked++;
  // The handoff is bound to the operator-initiation authorization.
  expect(
    body.includes("authorized_by"),
    `${name} must bind handoff_to_releaser to the authorized_by field`,
  );
  expect(
    body.includes("operator-initiation"),
    `${name} must bind handoff_to_releaser to authorized_by:"operator-initiation"`,
  );
  // The reporter refuses to run a separate confirmation round.
  expect(
    /confirmation round/i.test(body),
    `${name} must state the handoff proceeds WITHOUT a separate confirmation round`,
  );
}
if (handoffAgentsChecked === 0) {
  console.error(
    "verify-release-interaction-contract: no rendered agent carries " +
      "handoff_to_releaser — handoff-binding assertions SKIPPED " +
      "(no release-readiness reporter rendered in this tree).",
  );
}

// At least one release-flow surface must exist to verify the contract against.
expect(
  releaserExists || handoffAgentsChecked > 0,
  "at least one release-flow agent render (releaser or a handoff-carrying reporter) must exist to verify the contract against",
);

// =============================================================================
// Contract 3 — the superseded approval-round phrasing is GONE from every render
// =============================================================================
//
// Negative assertions: no rendered agent prompt may carry the old "human
// explicitly approves" edge label or the "approved_by_human" field. If either
// phrase recurs in any rendered agent, the contract was partially reverted and
// this guard fires. Applied to every rendered agent uniformly.

for (const [name, body] of agents) {
  expect(
    !body.includes("approved_by_human"),
    `${name} must NOT carry the superseded approved_by_human field`,
  );
  expect(
    !body.includes("human explicitly approves"),
    `${name} must NOT carry the superseded "human explicitly approves" edge label`,
  );
}

console.log(`verification: ok (${assertions} assertions)`);
