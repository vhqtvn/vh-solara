// F3 design-readiness gate — approved-plan BUILD-READY integration test (Slice 3 crux).
//
// Exercises the REAL approveDraft mutation (draft-plan -> approved) against the
// SAME F3 design-readiness gate used by the task-card route (Slice 2). This is
// the second acceptance crossing: a draft plan carrying a named ownership hazard
// + BUILD-READY/HIGH-style self-assertion but NO qualifying resolution package
// is REFUSED approval (no approved-plan artifact created); a complete
// current-digest-bound package permits approval AND copies the envelope into the
// approved-plan frontmatter (for the Slice 4 dispatch backstop).
//
// Run: vh-agent-harness exec node .opencode/scripts/verify-f3-plan-approve.js [--prefix <tag>]

import fs from "fs";
import path from "path";
import {
    StateError,
    approveDraft,
    bindSessionName,
    computePlanDesignDigest,
    ensureSessionBinding,
    listPlans,
    readDraft,
    repoRoot,
    saveDraft,
} from "./state-lib.js";

let prefix = "f3-plan-verify";
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--prefix") {
        prefix = args[index + 1] || prefix;
        index += 1;
        continue;
    }
    throw new StateError(`Unexpected argument: ${args[index]}`);
}

const coordinatorSessionID = `${prefix}-coordinator-session`;
const sessionAlias = `${prefix}-session`;
const createdSlugs = [];

function removeIfExists(targetPath) {
    if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
    }
}

function cleanupArtifacts() {
    // Remove draft plans for this session.
    removeIfExists(
        path.join(repoRoot(), ".opencode", "plans", sessionAlias),
    );
    // Remove the session state dir (approved plans + index).
    removeIfExists(
        path.join(
            repoRoot(),
            ".opencode",
            "state",
            "sessions",
            sessionAlias,
        ),
    );
    // Remove the session binding.
    const bindingDir = path.join(
        repoRoot(),
        ".opencode",
        "state",
        "session-bindings",
    );
    if (fs.existsSync(bindingDir)) {
        for (const entry of fs.readdirSync(bindingDir)) {
            if (entry.startsWith(coordinatorSessionID)) {
                removeIfExists(path.join(bindingDir, entry));
            }
        }
    }
}

function expectF3Block(fn, expectedReasonCode) {
    let thrown = null;
    try {
        fn();
    } catch (error) {
        thrown = error;
    }
    if (!(thrown instanceof StateError)) {
        throw new StateError(
            `Expected StateError with F3 reason ${expectedReasonCode}, but got ${
                thrown ? thrown.constructor.name : "no error"
            }.`,
        );
    }
    const message = String(thrown.message || "");
    if (!message.includes("F3 design-readiness gate refused")) {
        throw new StateError(
            `Expected an F3 gate refusal, got: "${message}".`,
        );
    }
    if (!message.includes(`reason: ${expectedReasonCode}`)) {
        throw new StateError(
            `Expected F3 reason code ${expectedReasonCode}, got: "${message}".`,
        );
    }
}

// A plan body (the design prose). The digest is over the trimmed,
// frontmatter-stripped body — the design IS the prose.
const PLAN_BODY = [
    "## Goal",
    "",
    "Fixture plan: project the canonical ownership boundary onto the",
    "fixture-projection surface without leaking stale state.",
    "",
    "## Files in scope",
    "",
    "- tests/fixtures/example-pkg/projection.go",
    "",
    "## Success criteria",
    "",
    "- Projection is single-owner under fixture-authority-a.",
    "",
    "## Validation",
    "",
    "- Run the fixture projection test suite.",
].join("\n");

// A named-but-unresolved envelope: the hazard is named (ownership seam is "the
// core blocker"), the author self-asserts BUILD-READY/HIGH, but there is NO
// resolution record, NO adversarial review. This is the SAME generic shape the
// task-card route (Slice 2) refuses. The plan route must refuse it equivalently.
function buildNamedButUnresolvedEnvelope(designDigest) {
    return {
        design_digest: designDigest,
        ownership_hazards: [
            {
                hazard_id: "hazard-plan-named-but-unresolved",
                hazard_class: "ownership",
                hazard_statement:
                    "the core blocker: two merge rules apply to one snapshot",
                affected_boundary: "tests/fixtures/example-pkg/projection.go",
                competing_authorities: [
                    "client-merge-rule-a",
                    "client-merge-rule-b",
                ],
                failure_mode:
                    "stale/leaky state under concurrent structural change",
                source_records: [
                    { provenance: "build-readiness gate prompt, fixture date" },
                ],
                author_self_assertion: {
                    readiness: "BUILD-READY",
                    confidence: "HIGH",
                    status: "resolved",
                },
            },
        ],
    };
}

// A complete, structurally valid F3 envelope: one ownership hazard with a full
// resolution package + a distinct adversarial review bound to the same design
// digest. This must PASS the gate.
function buildCompleteEnvelope(designDigest) {
    return {
        design_digest: designDigest,
        ownership_hazards: [
            {
                hazard_id: "hazard-plan-ownership-a",
                hazard_class: "ownership",
                hazard_statement:
                    "Ownership seam for fixture-projection has competing authorities.",
                affected_boundary: "tests/fixtures/example-pkg/projection.go",
                competing_authorities: [
                    "fixture-authority-a",
                    "fixture-authority-b",
                ],
                failure_mode:
                    "Without a resolution, both authorities may issue contradictory edits.",
                source_records: [{ provenance: "fixture-source-a" }],
                resolution: {
                    authoritative_owner: "fixture-authority-a",
                    secondary_authority_disposition:
                        "delegated_to_authoritative_owner",
                    mechanism_mapping:
                        "fixture-authority-a owns the boundary; fixture-authority-b delegates all writes.",
                    evidence_records: [{ provenance: "fixture-evidence-a" }],
                    design_digest: designDigest,
                    declared_by: "fixture-plan-author",
                    declared_at: "2026-07-25T00:00:00Z",
                    blocking_limitations: [],
                    minimum_counter_case: {
                        counter_case_id: "plan-min-case-a",
                        preconditions:
                            "Both authorities attempt concurrent writes.",
                        competing_or_missing_event:
                            "fixture-authority-b issues a write outside the delegation.",
                        expected_authoritative_owner: "fixture-authority-a",
                        expected_state_or_outcome:
                            "fixture-authority-a write wins; fixture-authority-b is rejected.",
                        forbidden_state_or_outcome:
                            "Corrupted shared state from interleaved writes.",
                        resolution_mapping:
                            "The ownership delegation serializes through fixture-authority-a.",
                        evidence_refs: ["fixture-evidence-a"],
                    },
                },
                adversarial_review: {
                    review_id: "plan-fixture-review-a",
                    hazard_id: "hazard-plan-ownership-a",
                    design_digest: designDigest,
                    reviewer_identity: "fixture-plan-reviewer-a",
                    reviewer_provenance: {
                        source: "fixture-plan-adversarial-source",
                    },
                    counter_cases: [
                        {
                            counter_case_id: "plan-counter-case-a",
                            preconditions:
                                "Both authorities attempt concurrent writes.",
                            competing_or_missing_event:
                                "fixture-authority-b issues a write outside the delegation.",
                            expected_authoritative_owner: "fixture-authority-a",
                            expected_state_or_outcome:
                                "fixture-authority-a write wins; fixture-authority-b is rejected.",
                            forbidden_state_or_outcome:
                                "Corrupted shared state from interleaved writes.",
                            resolution_mapping:
                                "The ownership delegation serializes through fixture-authority-a.",
                            evidence_refs: ["fixture-evidence-a"],
                        },
                    ],
                    evidence_checked: ["fixture-evidence-a"],
                    verdict: "resolution_supported",
                    weakest_supported_claim:
                        "The boundary has a single authoritative owner.",
                    limitations: [],
                },
            },
        ],
    };
}

function createDraftPlan(slugSuffix, envelope) {
    const slug = `${prefix}-${slugSuffix}`;
    createdSlugs.push(slug);
    saveDraft(
        coordinatorSessionID,
        slug,
        PLAN_BODY,
        `Fixture plan ${slugSuffix}`,
        { cwd: "/verification", f3DesignReadiness: envelope },
    );
    return slug;
}

let passed = 0;

try {
    cleanupArtifacts();
    ensureSessionBinding(coordinatorSessionID, { cwd: "/verification" });
    bindSessionName(coordinatorSessionID, sessionAlias, {
        cwd: "/verification",
    });

    const designDigest = computePlanDesignDigest(PLAN_BODY);

    // === Crux 1: named-but-unresolved hazard REFUSED at plan approval ===
    // The SAME generic fixture the task-card route (Slice 2) refuses must also
    // be refused on the plan route. One shared gate, two call sites.
    {
        const slug = createDraftPlan(
            "named-but-unresolved",
            buildNamedButUnresolvedEnvelope(designDigest),
        );
        expectF3Block(
            () =>
                approveDraft(coordinatorSessionID, slug, {
                    cwd: "/verification",
                }),
            "missing_resolution",
        );
        passed += 1;
    }

    // === Crux 2: complete current-digest package PERMITS approval ===
    {
        const slug = createDraftPlan(
            "complete",
            buildCompleteEnvelope(designDigest),
        );
        const approved = approveDraft(coordinatorSessionID, slug, {
            cwd: "/verification",
        });
        if (!approved.plan || approved.plan.status !== "approved") {
            throw new StateError(
                `Expected plan to be approved, got ${JSON.stringify(approved.plan || null)}.`,
            );
        }
        passed += 1;
    }

    // === Crux 3: missing envelope REFUSED (fail-closed on omission) ===
    {
        const slug = createDraftPlan("missing-envelope", null);
        expectF3Block(
            () =>
                approveDraft(coordinatorSessionID, slug, {
                    cwd: "/verification",
                }),
            "missing_envelope",
        );
        passed += 1;
    }

    // === Crux 4: explicit-empty inventory PERMITS (current design_digest) ===
    {
        const slug = createDraftPlan("explicit-empty", {
            design_digest: designDigest,
            ownership_hazards: [],
        });
        const approved = approveDraft(coordinatorSessionID, slug, {
            cwd: "/verification",
        });
        if (!approved.plan || approved.plan.status !== "approved") {
            throw new StateError(
                `Expected explicit-empty plan to be approved, got ${JSON.stringify(approved.plan || null)}.`,
            );
        }
        passed += 1;
    }

    // === Crux 5: stale explicit-empty REFUSED (design moved to v2) ===
    // b-F1 regression on the plan route: an explicit-empty envelope authored
    // against design v1 must NOT survive approval after the body changed.
    {
        const slug = createDraftPlan("stale-explicit-empty", {
            design_digest: computePlanDesignDigest(`${PLAN_BODY}\n\n## Changed`),
            ownership_hazards: [],
        });
        expectF3Block(
            () =>
                approveDraft(coordinatorSessionID, slug, {
                    cwd: "/verification",
                }),
            "stale_design_digest",
        );
        passed += 1;
    }

    // === Crux 6: blocked approval leaves NO approved-plan artifact ===
    // A refused approval must not create any plan file or index entry.
    {
        const slug = createDraftPlan(
            "no-artifact",
            buildNamedButUnresolvedEnvelope(designDigest),
        );
        expectF3Block(
            () =>
                approveDraft(coordinatorSessionID, slug, {
                    cwd: "/verification",
                }),
            "missing_resolution",
        );
        passed += 1;

        // The plans list must not contain an entry for this slug (no approved
        // artifact was created).
        const ctx = listPlans(coordinatorSessionID, {
            cwd: "/verification",
        });
        const plans = (ctx && ctx.plans) || [];
        for (const plan of plans) {
            if (plan.slug === slugify(slug)) {
                throw new StateError(
                    `Expected NO approved-plan artifact for refused slug ${slug}, but found ${plan.id}.`,
                );
            }
        }
        passed += 1;
    }

    // === Crux 7: direct approveDraft invocation cannot bypass F3 ===
    // Confirms the gate is in the function itself, not in a route handler.
    {
        const slug = createDraftPlan(
            "direct-bypass",
            buildNamedButUnresolvedEnvelope(designDigest),
        );
        expectF3Block(
            () =>
                approveDraft(coordinatorSessionID, slug, {
                    cwd: "/verification",
                }),
            "missing_resolution",
        );
        passed += 1;
    }

    // === Crux 8: envelope is copied to the approved-plan frontmatter ===
    // The dispatch backstop (Slice 4) re-reads the envelope from the approved
    // plan. approveDraft must copy it through.
    {
        const slug = createDraftPlan(
            "envelope-copied",
            buildCompleteEnvelope(designDigest),
        );
        const approved = approveDraft(coordinatorSessionID, slug, {
            cwd: "/verification",
        });
        if (!approved.plan) {
            throw new StateError(
                `Expected plan approval to succeed for envelope-copy check.`,
            );
        }
        passed += 1;

        // Read the approved plan back from its file. The envelope must be
        // present in the frontmatter, decoded back to an object.
        const approvedPath = path.join(repoRoot(), approved.plan.path);
        if (!fs.existsSync(approvedPath)) {
            throw new StateError(
                `Expected approved-plan file at ${approved.plan.path}, not found.`,
            );
        }
        // readDraft also works on approved plans (same frontmatter format).
        const reRead = readDraft(coordinatorSessionID, approved.plan.slug || approved.plan.id, {
            cwd: "/verification",
        });
        // The slug lookup may resolve via the session's drafts dir; instead,
        // read the file directly and parse frontmatter.
        const rawContent = fs.readFileSync(approvedPath, "utf8");
        const hasEnvelopeKey = /^f3_design_readiness:/m.test(rawContent);
        if (!hasEnvelopeKey) {
            throw new StateError(
                `Expected approved plan ${approved.plan.path} to carry f3_design_readiness frontmatter.`,
            );
        }
        passed += 1;
    }

    console.log(`verification: ok (${passed} assertions passed)`);
} catch (error) {
    if (error instanceof StateError) {
        console.error(`verification: FAIL — ${error.message}`);
    } else {
        console.error(`verification: FAIL — unexpected error`);
        console.error(error);
    }
    process.exitCode = 1;
} finally {
    cleanupArtifacts();
}

// Tiny local helper to mirror state-lib's slugify for the artifact check.
function slugify(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
