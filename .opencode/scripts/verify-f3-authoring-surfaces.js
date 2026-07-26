// verify-f3-authoring-surfaces.js
//
// Slice 5 contract verifier: confirms the F3 authoring surfaces (command +
// agent templates under templates/core/.opencode/) faithfully carry the F3
// design-readiness contract from the decision memo
// (researches/decisions/2026-07-25-f3-design-gate-mechanism.md).
//
// What this verifies (the Slice 5 contract):
//   1. The two BUILD-READY crossing commands (task-ready, approve-plan) carry
//      the F3 envelope authoring step with the required payload key, the
//      ownership-hazards inventory, the design-digest freshness binding, and
//      the closed adversarial-verdict vocabulary.
//   2. The design-author agent (build.md.tmpl in the source checkout;
//      build.md in a consumer render) carries the authority split
//      (INFORMS, not BLOCKS), the honesty ceiling (structural-not-truth), the
//      fabricated-evidence prohibition, and the explicit-empty discipline.
//   3. No authoring surface claims coordinator/reviewer/adversarial-lane
//      blocking authority over a BUILD-READY crossing (only the gate BLOCKS).
//   4. No authoring surface offers an F1/F2 artifact as an F3 substitute.
//   5. The validator's exported schema (F3_REQUIRED_FIELDS + closed
//      vocabularies) is live, frozen, and internally consistent — the
//      authoring surfaces reference a real schema, not a phantom.
//
// This is a TEXT-CONTRACT verifier (reads template prose, asserts key terms).
// It does NOT mutate the filesystem or exercise any lifecycle transition.
// The transition-blocking crux lives in verify-f3-task-ready.js +
// verify-f3-plan-approve.js + verify-f3-dispatch-backstop.js (Slices 2-4).
//
// Pass signal: "verification: ok (<N> assertions)".
// Fail signal: process.exit(1) with the failing assertion label on stderr.
//
// Invocation:
//   vh-agent-harness exec node .opencode/scripts/verify-f3-authoring-surfaces.js
//
// NOTE: always run the RENDERED copy at .opencode/scripts/ (tokens resolved).
// Never run the templates/core/.opencode/scripts/ source copy directly — its
// repoRoot() resolves to templates/core/ and (for state-writing scripts) it
// produces stray runtime artifacts in the template tree. state-lib.js refuses
// to load from an unrendered source copy; this text-contract verifier is
// read-only but follows the same convention for consistency.
//
// CONSUMER-RENDER MODE: in a tree that is NOT the harness source checkout
// (no corpus.go + templates/core/ at the repo root — i.e. every consumer),
// the build-agent surface is the resolved `agents/build.md`, NOT the
// source-tree-only `build.md.tmpl`. This script detects which via the
// source-checkout identity heuristic (see isHarnessSourceCheckout) and reads
// the authoritative surface for the tree, so it no longer ENOENT-exits on the
// .tmpl read in a consumer render (defect TA-1).

import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  F3_REQUIRED_FIELDS,
  F3_ADVERSARIAL_VERDICTS,
  F3_HAZARD_CLASSES,
  F3_SECONDARY_AUTHORITY_DISPOSITIONS,
  F3_REASON_CODES,
} from "./f3-design-readiness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cmd = (...p) => join(__dirname, "..", "commands", ...p);
const agent = (...p) => join(__dirname, "..", "agents", ...p);
const read = (p) => readFileSync(p, "utf8");

// --- Repo root + source-checkout identity (polyglot, no go.mod assumption) ---
//
// findRepoRoot anchors on `.git` (every consumer render is a git repo,
// regardless of language). isHarnessSourceCheckout REUSES the EXACT identity
// heuristic from internal/cli/corpus_freshness.go::isSourceCheckout (the
// dev-stale-embed guard): a target is the harness's OWN source checkout iff a
// REGULAR FILE `corpus.go` AND a DIRECTORY `templates/core/` both sit at the
// repo root. Do not reinvent this test.
//
// Why this matters here: `build.md.tmpl` is a SOURCE-TREE-ONLY artifact. It
// exists under templates/core/.opencode/agents/ in the source checkout but is
// NEVER shipped to a consumer render (the render resolves it to `build.md`,
// dropping the .tmpl suffix). Reading `agents/build.md.tmpl` from a rendered
// copy therefore ENOENT-exits in every consumer (defect TA-1). We gate the
// read: source checkout verifies the authoritative .tmpl source; a consumer
// render verifies the resolved build.md surface -- the F3 contract text is
// literal in both, so the same assertions apply.
function findRepoRoot(start) {
    let dir = start;
    for (;;) {
        if (existsSync(join(dir, ".git"))) {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
}

function isHarnessSourceCheckout(repoRoot) {
    if (!repoRoot) {
        return false;
    }
    // Mirrors corpus_freshness.go: regular-file corpus.go + dir templates/core.
    let corpusStat = null;
    try {
        corpusStat = statSync(join(repoRoot, "corpus.go"));
    } catch {
        corpusStat = null;
    }
    if (!corpusStat || !corpusStat.isFile()) {
        return false;
    }
    let tmplStat = null;
    try {
        tmplStat = statSync(join(repoRoot, "templates", "core"));
    } catch {
        tmplStat = null;
    }
    return !!tmplStat && tmplStat.isDirectory();
}

let assertions = 0;
function expect(condition, label) {
  assertions++;
  if (!condition) {
    throw new Error(`Assertion failed: ${label}`);
  }
}

// --- Load authoring surfaces ---
const taskReady = read(cmd("task-ready.md"));
const approvePlan = read(cmd("approve-plan.md"));
const writeTask = read(cmd("write-task.md"));
const draftPlan = read(cmd("draft-plan.md"));

// Gate the build-agent surface on the source-checkout identity (see
// isHarnessSourceCheckout above). `build.md.tmpl` is source-tree-only; a
// consumer render ships the resolved `build.md`. The F3 contract text being
// asserted is literal (no {{...}} tokens) in both, so the same assertions hold
// against whichever surface is authoritative for this tree.
const repoRoot = findRepoRoot(__dirname);
const isSourceCheckout = isHarnessSourceCheckout(repoRoot);
const buildAgentName = isSourceCheckout
    ? "build.md.tmpl (source checkout)"
    : "build.md (consumer render)";
const buildAgentPath = isSourceCheckout
    ? join(repoRoot, "templates", "core", ".opencode", "agents", "build.md.tmpl")
    : agent("build.md");
const buildAgent = read(buildAgentPath);

const crossingCmds = [
  ["task-ready.md", taskReady],
  ["approve-plan.md", approvePlan],
];
const allSurfaces = [
  ["task-ready.md", taskReady],
  ["approve-plan.md", approvePlan],
  ["write-task.md", writeTask],
  ["draft-plan.md", draftPlan],
  [buildAgentName, buildAgent],
];

// =============================================================================
// Contract 1 — Crossing commands carry the F3 envelope authoring step
// =============================================================================

// Crux 1: both crossing commands reference the f3_design_readiness payload key.
for (const [name, body] of crossingCmds) {
  expect(
    body.includes("f3_design_readiness"),
    `${name} must reference the f3_design_readiness payload/frontmatter key`,
  );
}

// Crux 2: both crossing commands name the ownership_hazards inventory field.
for (const [name, body] of crossingCmds) {
  expect(
    body.includes("ownership_hazards"),
    `${name} must name the ownership_hazards inventory field`,
  );
}

// Crux 3: both crossing commands name the design_digest freshness binding.
for (const [name, body] of crossingCmds) {
  expect(
    body.includes("design_digest"),
    `${name} must name the design_digest freshness binding`,
  );
}

// Crux 4: both crossing commands reference the only passing adversarial verdict.
for (const [name, body] of crossingCmds) {
  expect(
    body.includes("resolution_supported"),
    `${name} must reference resolution_supported (the only passing adversarial verdict)`,
  );
}

// Crux 5: both crossing commands state the explicit-empty discipline.
// (ownership_hazards: [] passes; omission fails closed).
for (const [name, body] of crossingCmds) {
  const mentionsEmpty = body.includes("ownership_hazards[]") || body.includes("[]");
  const mentionsOmissionFails =
    /omission|omitting|missing_envelope/i.test(body);
  expect(
    mentionsEmpty && mentionsOmissionFails,
    `${name} must state the explicit-empty discipline ([] passes, omission fails closed)`,
  );
}

// =============================================================================
// Contract 2 — Design-author agent carries authority + honesty guidance
// =============================================================================

// Crux 6: build agent states the INFORMS authority level.
expect(
  buildAgent.includes("INFORMS"),
  `${buildAgentName} must state the INFORMS authority level for the design author`,
);

// Crux 7: build agent states the structural-not-truth honesty ceiling.
expect(
  /structural/i.test(buildAgent) && /truth/i.test(buildAgent),
  `${buildAgentName} must state the structural-not-truth honesty ceiling`,
);

// Crux 8: build agent prohibits fabricated evidence.
expect(
  /fabricat/i.test(buildAgent),
  `${buildAgentName} must prohibit fabricated evidence`,
);

// Crux 9: build agent states the explicit-empty discipline.
expect(
  buildAgent.includes("ownership_hazards") && buildAgent.includes("[]"),
  `${buildAgentName} must state the explicit-empty discipline`,
);

// Crux 10: build agent states the F1/F2-not-substitute rule.
expect(
  /F1.*F2|F2.*F1/i.test(buildAgent) && /substitute/i.test(buildAgent),
  `${buildAgentName} must state that F1/F2 artifacts are NOT F3 substitutes`,
);

// =============================================================================
// Contract 3 — No non-gate participant claims blocking authority
// =============================================================================

// Crux 11: no authoring surface claims the coordinator/reviewer/agent blocks
// BUILD-READY. The gate alone BLOCKS.
for (const [name, body] of allSurfaces) {
  const claimsBlock =
    /coordinator\s+(blocks|decides|adjudicates)/i.test(body) ||
    /reviewer\s+(blocks|decides|adjudicates)\s+(build|the)/i.test(body);
  expect(
    !claimsBlock,
    `${name} must not claim coordinator/reviewer blocking authority over BUILD-READY`,
  );
}

// Crux 12: crossing commands state that the envelope INFORMS the gate
// (does not itself decide/block).
for (const [name, body] of crossingCmds) {
  expect(
    /INFORMS/i.test(body),
    `${name} must state that the envelope INFORMS the safety-layer gate`,
  );
}

// =============================================================================
// Contract 4 — No F1/F2 artifact offered as an F3 substitute
// =============================================================================

// Crux 13: no surface offers F1/F2 as satisfying or substituting for F3.
for (const [name, body] of allSurfaces) {
  const offersSubstitute =
    /F1\s+(satisfies|substitutes|replaces)\s+F3/i.test(body) ||
    /F2\s+(satisfies|substitutes|replaces)\s+F3/i.test(body);
  expect(
    !offersSubstitute,
    `${name} must not offer an F1/F2 artifact as an F3 substitute`,
  );
}

// =============================================================================
// Contract 5 — Validator's exported schema is live + internally consistent
// =============================================================================

// Crux 14: the required-field schema is non-empty for every record type.
expect(
  F3_REQUIRED_FIELDS.hazard_declaration.length > 0,
  "F3_REQUIRED_FIELDS.hazard_declaration must be non-empty",
);
expect(
  F3_REQUIRED_FIELDS.resolution.length > 0,
  "F3_REQUIRED_FIELDS.resolution must be non-empty",
);
expect(
  F3_REQUIRED_FIELDS.adversarial_review.length > 0,
  "F3_REQUIRED_FIELDS.adversarial_review must be non-empty",
);
expect(
  F3_REQUIRED_FIELDS.counter_case.length > 0,
  "F3_REQUIRED_FIELDS.counter_case must be non-empty",
);

// Crux 15: the closed vocabularies are frozen + carry the expected values.
expect(
  F3_ADVERSARIAL_VERDICTS.includes("resolution_supported") &&
    F3_ADVERSARIAL_VERDICTS.includes("refuted") &&
    F3_ADVERSARIAL_VERDICTS.includes("inconclusive"),
  "F3_ADVERSARIAL_VERDICTS must include resolution_supported, refuted, inconclusive",
);
expect(
  F3_HAZARD_CLASSES.includes("ownership"),
  'F3_HAZARD_CLASSES must include "ownership"',
);
expect(
  F3_SECONDARY_AUTHORITY_DISPOSITIONS.includes("removed") &&
    F3_SECONDARY_AUTHORITY_DISPOSITIONS.includes("prohibited"),
  "F3_SECONDARY_AUTHORITY_DISPOSITIONS must include removed + prohibited",
);
expect(
  F3_REASON_CODES.includes("missing_envelope") &&
    F3_REASON_CODES.includes("stale_design_digest") &&
    F3_REASON_CODES.includes("review_refuted"),
  "F3_REASON_CODES must include missing_envelope, stale_design_digest, review_refuted",
);

// Crux 16: the authoring surfaces reference the canonical schema module
// (so producers + parsers agree on field names).
expect(
  buildAgent.includes("f3-design-readiness.js") ||
    buildAgent.includes("F3_REQUIRED_FIELDS"),
  `${buildAgentName} must reference the canonical schema module (f3-design-readiness.js / F3_REQUIRED_FIELDS)`,
);

console.log(`verification: ok (${assertions} assertions)`);
