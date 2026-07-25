// verify-f3-design-readiness.js — table-driven tests for the F3 pure validator.
//
// Tests the F3_PASS + F3_HAZARD_RESOLVED predicates against the closed-vocab
// reason codes, the honesty ceiling, and the falsifying-test table from the
// F3 design-gate mechanism decision memo.
//
// The headline fixture is the GENERIC equivalent of the demonstrated day-0
// failure: a named ownership hazard + a HIGH/resolved self-assertion + NO
// resolution package. Per the falsifying-test table, the authority-mark sense
// (a), evidence-alone sense (b), and adversarial-alone sense (c) are ALL
// insufficient and must FAIL. Only the full conjunction (d) passes. This file
// is DOMAIN-FREE: no project-specific literals — the fixture is a generic
// named-but-unresolved ownership hazard, not a shipped brand.
//
// Run: vh-agent-harness exec node .opencode/scripts/verify-f3-design-readiness.js

import {
    validateF3DesignReadiness,
    computeDesignDigest,
    F3_REASON_CODES,
} from "./f3-design-readiness.js";

// ---------------------------------------------------------------------------
// Fixture builders. Centralized so every test composes from the same canonical
// "structurally complete" shape, then mutates one clause to falsify it.
// ---------------------------------------------------------------------------

const CURRENT_DESIGN = {
    task_id: "task-fixture-design-a",
    title: "Fixture design A",
    task_type: "implementation",
    primary_lane: "fixture-lane",
    files_in_scope: ["src/fixture/a.go", "src/fixture/b.go"],
    success_criteria: ["fixture outcome observed"],
    constraints: ["fixture constraint"],
    non_goals: ["fixture non-goal"],
    validation_plan: ["fixture verifier"],
};
const CURRENT_DIGEST = computeDesignDigest(CURRENT_DESIGN);

function completeCounterCase(overrides = {}) {
    return {
        counter_case_id: "cc-1",
        preconditions: "fixture precondition",
        competing_or_missing_event: "fixture competing event",
        expected_authoritative_owner: "fixture-authoritative-owner",
        expected_state_or_outcome: "fixture expected outcome",
        forbidden_state_or_outcome: "fixture forbidden outcome",
        resolution_mapping: "fixture resolution mapping",
        evidence_refs: ["ev-1"],
        ...overrides,
    };
}

function completeEvidenceRecord(overrides = {}) {
    return {
        evidence_id: "ev-1",
        summary: "fixture evidence",
        provenance: { kind: "captured", at: "2026-07-25T00:00:00Z", by: "fixture-author" },
        ...overrides,
    };
}

function completeSourceRecord(overrides = {}) {
    return {
        source_id: "src-1",
        provenance: "identified in fixture design review 2026-07-25",
        ...overrides,
    };
}

function completeResolution(overrides = {}) {
    return {
        authoritative_owner: "fixture-authoritative-owner",
        secondary_authority_disposition: "delegated_to_authoritative_owner",
        mechanism_mapping: "fixture mechanism: authority A owns the boundary, B delegates",
        evidence_records: [completeEvidenceRecord()],
        design_digest: CURRENT_DIGEST,
        declared_by: "fixture-design-author",
        declared_at: "2026-07-25T00:00:00Z",
        blocking_limitations: [],
        minimum_counter_case: completeCounterCase(),
        ...overrides,
    };
}

function completeAdversarial(overrides = {}) {
    return {
        review_id: "adv-1",
        hazard_id: "hazard-ownership-a",
        design_digest: CURRENT_DIGEST,
        reviewer_identity: "fixture-adversarial-reviewer",
        reviewer_provenance: "distinct adversarial lane",
        counter_cases: [completeCounterCase({ counter_case_id: "adv-cc-1" })],
        evidence_checked: ["ev-1"],
        verdict: "resolution_supported",
        weakest_supported_claim: "fixture weakest claim",
        limitations: [],
        ...overrides,
    };
}

function completeHazard(overrides = {}) {
    const baseHazardId = overrides.hazard_id || "hazard-ownership-a";
    return {
        hazard_id: baseHazardId,
        hazard_class: "ownership",
        hazard_statement: "two authorities claim ownership of the fixture boundary",
        affected_boundary: "src/fixture/a.go",
        competing_authorities: ["fixture-authority-a", "fixture-authority-b"],
        failure_mode: "divergent ownership causes inconsistent fixture state",
        source_records: [completeSourceRecord()],
        resolution: completeResolution(),
        adversarial_review: completeAdversarial({ hazard_id: baseHazardId }),
        ...overrides,
        // Re-sync the adversarial review's hazard_id if overrides changed the
        // hazard_id but did not explicitly override the adversarial review.
        // Keeps the default fixture internally consistent (an adversarial
        // record must bind to its own hazard). Tests that intend a
        // cross-binding override adversarial_review explicitly.
        adversarial_review:
            overrides.adversarial_review !== undefined
                ? overrides.adversarial_review
                : completeAdversarial({ hazard_id: baseHazardId }),
    };
}

function completeEnvelope(overrides = {}) {
    return {
        design_digest: CURRENT_DIGEST,
        ownership_hazards: [completeHazard()],
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tiny test harness (matches the verify-*.js convention).
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(label, condition) {
    if (condition) {
        passed += 1;
    } else {
        failed += 1;
        console.error(`FAIL: ${label}`);
    }
}

function expectPass(label, result) {
    check(`${label}: passed`, result.passed === true);
    if (result.passed) {
        check(
            `${label}: honesty ceiling — says "structurally satisfied"`,
            /structurally satisfied/i.test(result.detail),
        );
        check(
            `${label}: honesty ceiling — never says "proven solved"`,
            !/proven solved/i.test(result.detail),
        );
        check(
            `${label}: honesty ceiling — never says "design is correct"`,
            !/design is (correct|good|true)/i.test(result.detail),
        );
    }
}

function expectBlock(label, result, expectedReason) {
    check(`${label}: blocked`, result.passed === false);
    if (!result.passed) {
        check(
            `${label}: reason ${expectedReason}`,
            result.reasonCode === expectedReason,
        );
        check(
            `${label}: reason code in closed vocab`,
            F3_REASON_CODES.includes(result.reasonCode),
        );
        check(`${label}: detail non-empty`, typeof result.detail === "string" && result.detail.length > 0);
    } else {
        console.error(`FAIL: ${label}: expected block but got pass`);
    }
}

// ---------------------------------------------------------------------------
// Test cases (the mission's Slice-1 verify table)
// ---------------------------------------------------------------------------

function runCases() {
    // --- Envelope-level ---

    expectBlock(
        "absent envelope",
        validateF3DesignReadiness({
            envelope: null,
            currentDesignDigest: CURRENT_DIGEST,
            transitionKind: "task_ready",
        }),
        "missing_envelope",
    );

    expectBlock(
        "undefined envelope",
        validateF3DesignReadiness({
            envelope: undefined,
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "missing_envelope",
    );

    expectBlock(
        "envelope without ownership_hazards field (omission)",
        validateF3DesignReadiness({
            envelope: { schema_version: 1 },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "missing_envelope",
    );

    expectBlock(
        "no currentDesignDigest supplied (caller bug)",
        validateF3DesignReadiness({
            envelope: completeEnvelope(),
            currentDesignDigest: "",
        }),
        "stale_design_digest",
    );

    // --- Explicit-empty inventory: the honesty-caveated pass ---

    expectPass(
        "explicit-empty inventory passes (current design_digest)",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
    );

    // --- b-F1 pinned regression: explicit-empty + STALE design_digest FAILS ---
    // An explicit-empty envelope authored against design v1 must NOT survive a
    // transition to design v2 — the new design may have introduced a hazard the
    // v1 survey did not cover. The top-level envelope.design_digest is the
    // freshness binding for this case (there are no per-hazard digests to bind).
    expectBlock(
        "b-F1 regression: explicit-empty + stale design_digest FAILS",
        validateF3DesignReadiness({
            envelope: {
                design_digest: computeDesignDigest({ ...CURRENT_DESIGN, title: "design v2 (changed)" }),
                ownership_hazards: [],
            },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "stale_design_digest",
    );

    // --- b-F1 companion: explicit-empty + MISSING top-level design_digest FAILS ---
    expectBlock(
        "b-F1 regression: explicit-empty + missing design_digest FAILS",
        validateF3DesignReadiness({
            envelope: { ownership_hazards: [] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "malformed_envelope",
    );

    // --- b-F1 companion: non-empty + MISSING top-level design_digest FAILS ---
    expectBlock(
        "non-empty envelope + missing top-level design_digest FAILS",
        validateF3DesignReadiness({
            envelope: { ownership_hazards: [completeHazard()] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "malformed_envelope",
    );

    // --- b-F1 companion: non-empty + STALE top-level design_digest FAILS ---
    // Defense-in-depth: even if per-hazard digests were current, a stale
    // top-level digest fails closed (F3_PASS clause 2 is enforced at this level).
    expectBlock(
        "non-empty envelope + stale top-level design_digest FAILS",
        validateF3DesignReadiness({
            envelope: completeEnvelope({
                design_digest: computeDesignDigest({ ...CURRENT_DESIGN, title: "stale top-level" }),
            }),
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "stale_design_digest",
    );

    // --- The crux fixture: named hazard + authority/HIGH self-assertion + NO resolution ---

    // This is the generic equivalent of the demonstrated day-0 failure: the
    // ownership seam was named as "the core blocker" and the lane declared
    // BUILD-READY/HIGH with a contract-solved assertion. The hazard was named;
    // the resolution was never adjudicated. F3 must refuse this. A free-form
    // author `status: resolved` (or HIGH confidence) does NOT control the
    // transition.
    const namedButUnresolvedEnvelope = {
        design_digest: CURRENT_DIGEST,
        ownership_hazards: [
            {
                hazard_id: "hazard-named-but-unresolved",
                hazard_class: "ownership",
                hazard_statement: "the core blocker: two merge rules apply to one snapshot",
                affected_boundary: "src/fixture/projection",
                competing_authorities: ["client-merge-rule-a", "client-merge-rule-b"],
                failure_mode: "stale/leaky state under concurrent structural change",
                source_records: [
                    { source_id: "src-prompt", provenance: "build-readiness gate prompt, fixture date" },
                ],
                // The author's HIGH/resolved self-assertion — the demonstrated
                // failure shape. It must NOT control the transition.
                author_self_assertion: { readiness: "BUILD-READY", confidence: "HIGH", status: "resolved" },
                // NO resolution record. NO adversarial_review. This is the gap.
            },
        ],
    };
    const cruxResult = validateF3DesignReadiness({
        envelope: namedButUnresolvedEnvelope,
        currentDesignDigest: CURRENT_DIGEST,
        transitionKind: "task_ready",
    });
    expectBlock("named-but-unresolved crux (no resolution)", cruxResult, "missing_resolution");
    // The block verdict IS the proof the author self-assertion was not honored.
    // (The detail text legitimately explains the general principle — "a HIGH/
    // self-asserted status is NOT a resolution" — which is correct pedagogy,
    // not an echo of the fixture's specific claim. The verdict, not the prose,
    // is load-bearing.)

    // --- Falsifying-test table: senses (a)(b)(c) all insufficient ---

    // (a) authority / resolved mark alone — the hazard carries a resolution
    // with authoritative_owner + a status:resolved flag but no evidence, no
    // counter-case, no adversarial record.
    const authorityMarkOnly = {
        ...completeHazard(),
        resolution: {
            authoritative_owner: "fixture-authoritative-owner",
            design_digest: CURRENT_DIGEST,
            declared_by: "fixture-design-author",
            declared_at: "2026-07-25T00:00:00Z",
            status: "resolved", // author flag — must NOT control the verdict
        },
        adversarial_review: undefined,
    };
    expectBlock(
        "sense (a) authority-mark alone",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [authorityMarkOnly] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "missing_resolution",
    );

    // (b) evidence-bearing resolution alone (no counter-case, no adversarial)
    const evidenceOnly = {
        ...completeHazard(),
        resolution: {
            ...completeResolution(),
            minimum_counter_case: undefined,
        },
        adversarial_review: undefined,
    };
    expectBlock(
        "sense (b) evidence alone (no counter-case, no adversarial)",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [evidenceOnly] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "missing_counter_case",
    );

    // (c) adversarial review alone (no resolution record)
    const adversarialOnly = {
        ...completeHazard(),
        resolution: undefined,
        adversarial_review: completeAdversarial(),
    };
    expectBlock(
        "sense (c) adversarial alone (no resolution)",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [adversarialOnly] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "missing_resolution",
    );

    // --- Stale design digest ---

    const staleDigestHazard = completeHazard({
        resolution: completeResolution({
            design_digest: computeDesignDigest({ ...CURRENT_DESIGN, title: "changed" }),
        }),
        adversarial_review: completeAdversarial({
            design_digest: computeDesignDigest({ ...CURRENT_DESIGN, title: "changed" }),
        }),
    });
    expectBlock(
        "stale design digest (resolution + adversarial bound to old design)",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [staleDigestHazard] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "stale_design_digest",
    );

    // resolution current but adversarial stale
    const halfStaleHazard = completeHazard({
        adversarial_review: completeAdversarial({
            design_digest: computeDesignDigest({ ...CURRENT_DESIGN, title: "changed" }),
        }),
    });
    expectBlock(
        "adversarial stale while resolution current",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [halfStaleHazard] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "stale_design_digest",
    );

    // --- Provenance failures ---

    const unprovenancedSource = completeHazard({
        source_records: [{ source_id: "src-1", provenance: "" }],
    });
    expectBlock(
        "hazard source_record without provenance",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [unprovenancedSource] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "invalid_provenance",
    );

    const unprovenancedEvidence = completeHazard({
        resolution: completeResolution({
            evidence_records: [completeEvidenceRecord({ provenance: null })],
        }),
    });
    expectBlock(
        "resolution evidence_record without provenance",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [unprovenancedEvidence] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "invalid_provenance",
    );

    const noSourceRecords = completeHazard({ source_records: [] });
    expectBlock(
        "hazard with no source_records",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [noSourceRecords] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "invalid_provenance",
    );

    // --- Counter-case failures ---

    const missingMinimumCounterCase = completeHazard({
        resolution: completeResolution({ minimum_counter_case: undefined }),
    });
    expectBlock(
        "resolution missing minimum_counter_case",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [missingMinimumCounterCase] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "missing_counter_case",
    );

    const malformedMinimumCounterCase = completeHazard({
        resolution: completeResolution({
            minimum_counter_case: completeCounterCase({
                expected_authoritative_owner: "",
            }),
        }),
    });
    expectBlock(
        "minimum_counter_case missing required field",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [malformedMinimumCounterCase] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "missing_counter_case",
    );

    const adversarialNoCounterCases = completeHazard({
        adversarial_review: completeAdversarial({ counter_cases: [] }),
    });
    expectBlock(
        "adversarial with no counter_cases",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [adversarialNoCounterCases] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "missing_counter_case",
    );

    // --- Reviewer identity collision ---

    const identityCollision = completeHazard({
        adversarial_review: completeAdversarial({
            reviewer_identity: "fixture-design-author", // same as resolution.declared_by
        }),
    });
    expectBlock(
        "reviewer identity collides with resolution producer",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [identityCollision] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "reviewer_identity_collision",
    );

    // --- Adversarial verdict failures ---

    const refutedVerdict = completeHazard({
        adversarial_review: completeAdversarial({ verdict: "refuted" }),
    });
    expectBlock(
        "adversarial verdict refuted",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [refutedVerdict] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "review_refuted",
    );

    const inconclusiveVerdict = completeHazard({
        adversarial_review: completeAdversarial({ verdict: "inconclusive" }),
    });
    expectBlock(
        "adversarial verdict inconclusive",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [inconclusiveVerdict] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "review_inconclusive",
    );

    // --- Blocking limitations ---

    const resolutionBlockingLimitation = completeHazard({
        resolution: completeResolution({
            blocking_limitations: ["one subsystem unverified"],
        }),
    });
    expectBlock(
        "resolution carries blocking_limitations",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [resolutionBlockingLimitation] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "blocking_limitation",
    );

    const adversarialBlockingLimitation = completeHazard({
        adversarial_review: completeAdversarial({
            limitations: [
                { note: "could not verify X", blocking: true },
                { note: "minor caveat", blocking: false },
            ],
        }),
    });
    expectBlock(
        "adversarial carries a blocking limitation",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [adversarialBlockingLimitation] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "blocking_limitation",
    );

    // Non-blocking reviewer limitations are EXPECTED and must NOT block.
    const adversarialNonBlockingLimitation = completeHazard({
        adversarial_review: completeAdversarial({
            limitations: [
                { note: "minor caveat", blocking: false },
                "free-form non-blocking limitation string",
            ],
        }),
    });
    expectPass(
        "adversarial non-blocking limitations do not block",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [adversarialNonBlockingLimitation] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
    );

    // --- Fail-closed on non-array safety fields (the silent-pass regression) ---
    // A present-but-non-array value on blocking_limitations / limitations must
    // NOT silently pass as "no blocking limitations." isNonEmptyArray() returns
    // false for a non-array, so a bare guard would let it through — this
    // regression pins the explicit type check.
    const nonArrayResolutionBlocking = completeHazard({
        resolution: completeResolution({
            blocking_limitations: "authority boundary unverified",
        }),
    });
    expectBlock(
        "non-array resolution.blocking_limitations fails closed (not silent pass)",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [nonArrayResolutionBlocking] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "malformed_envelope",
    );

    const nonArrayAdversarialLimitations = completeHazard({
        adversarial_review: completeAdversarial({
            limitations: "reviewer could not verify subsystem X",
        }),
    });
    expectBlock(
        "non-array adversarial.limitations fails closed (not silent pass)",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [nonArrayAdversarialLimitations] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "malformed_envelope",
    );

    // Absent blocking_limitations / limitations still passes (default none).
    const absentBlockingResolution = completeHazard({
        resolution: (() => {
            const r = completeResolution();
            delete r.blocking_limitations;
            return r;
        })(),
    });
    expectPass(
        "absent resolution.blocking_limitations passes (default none)",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [absentBlockingResolution] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
    );

    // --- B-F1 regression: non-array evidence_refs on a counter-case fails closed ---
    // evidence_refs is a documented array field; a non-array truthy value (e.g.
    // a string "ev-1") must NOT silently pass as "present."
    const nonArrayEvidenceRefsMinimum = completeHazard({
        resolution: completeResolution({
            minimum_counter_case: completeCounterCase({ evidence_refs: "ev-1" }),
        }),
    });
    expectBlock(
        "non-array evidence_refs on minimum counter-case fails closed",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [nonArrayEvidenceRefsMinimum] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "missing_counter_case",
    );

    const nonArrayEvidenceRefsAdversarial = completeHazard({
        adversarial_review: completeAdversarial({
            counter_cases: [
                completeCounterCase({ counter_case_id: "adv-cc-1", evidence_refs: "ev-1" }),
            ],
        }),
    });
    expectBlock(
        "non-array evidence_refs on adversarial counter-case fails closed",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [nonArrayEvidenceRefsAdversarial] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "missing_counter_case",
    );

    const emptyEvidenceRefsMinimum = completeHazard({
        resolution: completeResolution({
            minimum_counter_case: completeCounterCase({ evidence_refs: [] }),
        }),
    });
    expectBlock(
        "empty evidence_refs on minimum counter-case fails closed",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [emptyEvidenceRefsMinimum] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "missing_counter_case",
    );

    // --- B-F2 regression: evidence_checked required + array-typed ---
    // The memo requires adversarial evidence_checked[] (what the reviewer
    // examined). Omission, empty array, and non-array all fail closed.
    const absentEvidenceChecked = completeHazard({
        adversarial_review: (() => {
            const a = completeAdversarial();
            delete a.evidence_checked;
            return a;
        })(),
    });
    expectBlock(
        "absent adversarial evidence_checked fails closed",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [absentEvidenceChecked] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "malformed_envelope",
    );

    const emptyEvidenceChecked = completeHazard({
        adversarial_review: completeAdversarial({ evidence_checked: [] }),
    });
    expectBlock(
        "empty adversarial evidence_checked fails closed",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [emptyEvidenceChecked] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "malformed_envelope",
    );

    const nonArrayEvidenceChecked = completeHazard({
        adversarial_review: completeAdversarial({ evidence_checked: "ev-1" }),
    });
    expectBlock(
        "non-array adversarial evidence_checked fails closed",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [nonArrayEvidenceChecked] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "malformed_envelope",
    );

    // --- Unknown enums fail closed ---

    const unknownHazardClass = completeHazard({ hazard_class: "performance" });
    expectBlock(
        "unknown hazard_class fails closed",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [unknownHazardClass] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "malformed_envelope",
    );

    const unknownDisposition = completeHazard({
        resolution: completeResolution({
            secondary_authority_disposition: "shared",
        }),
    });
    expectBlock(
        "unknown secondary_authority_disposition fails closed",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [unknownDisposition] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "malformed_envelope",
    );

    const unknownVerdict = completeHazard({
        adversarial_review: completeAdversarial({ verdict: "probably_ok" }),
    });
    expectBlock(
        "unknown adversarial verdict fails closed",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [unknownVerdict] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "malformed_envelope",
    );

    // --- Declaration-incomplete ---

    const missingFailureMode = { ...completeHazard(), failure_mode: "" };
    expectBlock(
        "hazard declaration missing failure_mode",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [missingFailureMode] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "malformed_envelope",
    );

    const missingCompetingAuthorities = {
        ...completeHazard(),
        competing_authorities: [],
    };
    expectBlock(
        "hazard with no competing_authorities",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [missingCompetingAuthorities] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "malformed_envelope",
    );

    // --- The structurally complete current-digest package PASSES ---

    expectPass(
        "structurally complete current-digest package passes (task_ready)",
        validateF3DesignReadiness({
            envelope: completeEnvelope(),
            currentDesignDigest: CURRENT_DIGEST,
            transitionKind: "task_ready",
        }),
    );

    expectPass(
        "structurally complete current-digest package passes (plan_approve)",
        validateF3DesignReadiness({
            envelope: completeEnvelope(),
            currentDesignDigest: CURRENT_DIGEST,
            transitionKind: "plan_approve",
        }),
    );

    // Multiple hazards: first failure short-circuits.
    const multiHazardEnvelope = {
        design_digest: CURRENT_DIGEST,
        ownership_hazards: [
            completeHazard({ hazard_id: "hazard-ok" }),
            completeHazard({
                hazard_id: "hazard-bad",
                adversarial_review: completeAdversarial({
                    hazard_id: "hazard-bad",
                    verdict: "refuted",
                }),
            }),
        ],
    };
    expectBlock(
        "multi-hazard: first failure short-circuits",
        validateF3DesignReadiness({
            envelope: multiHazardEnvelope,
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "review_refuted",
    );

    const multiHazardAllResolved = {
        design_digest: CURRENT_DIGEST,
        ownership_hazards: [
            completeHazard({ hazard_id: "hazard-a" }),
            completeHazard({
                hazard_id: "hazard-b",
                resolution: completeResolution(),
                adversarial_review: completeAdversarial({ hazard_id: "hazard-b" }),
            }),
        ],
    };
    expectPass(
        "multi-hazard all resolved passes (each adversarial bound to its own hazard)",
        validateF3DesignReadiness({
            envelope: multiHazardAllResolved,
            currentDesignDigest: CURRENT_DIGEST,
        }),
    );

    // Regression: an adversarial review bound to a DIFFERENT hazard_id must
    // BLOCK even if it is otherwise complete + current. Without this equality
    // check two hazards sharing a design digest could cross-satisfy each other
    // (a review for hazard-b placed under hazard-a).
    const crossBoundAdversarial = completeHazard({
        hazard_id: "hazard-a",
        adversarial_review: completeAdversarial({ hazard_id: "hazard-b" }),
    });
    expectBlock(
        "adversarial bound to a different hazard_id (cross-binding) blocks",
        validateF3DesignReadiness({
            envelope: { design_digest: CURRENT_DIGEST, ownership_hazards: [crossBoundAdversarial] },
            currentDesignDigest: CURRENT_DIGEST,
        }),
        "malformed_envelope",
    );

    // --- computeDesignDigest determinism ---

    const d1 = computeDesignDigest(CURRENT_DESIGN);
    const d2 = computeDesignDigest({ ...CURRENT_DESIGN });
    const d3 = computeDesignDigest(JSON.parse(JSON.stringify(CURRENT_DESIGN)));
    check("digest deterministic across key order (same insertion)", d1 === d2);
    check("digest deterministic across deep clone", d1 === d3);
    const dChanged = computeDesignDigest({
        ...CURRENT_DESIGN,
        files_in_scope: ["src/fixture/a.go", "src/fixture/c.go"],
    });
    check("digest sensitive to files_in_scope change", d1 !== dChanged);
    const dReorderedKeys = computeDesignDigest({
        success_criteria: ["fixture outcome observed"],
        task_id: "task-fixture-design-a",
        title: "Fixture design A",
    });
    const dReorderedKeysCanonical = computeDesignDigest({
        task_id: "task-fixture-design-a",
        title: "Fixture design A",
        success_criteria: ["fixture outcome observed"],
    });
    check(
        "digest canonical (key-order independent)",
        dReorderedKeys === dReorderedKeysCanonical,
    );
    check(
        "digest is a 64-char hex string",
        /^[0-9a-f]{64}$/.test(d1),
    );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
    runCases();
    if (failed > 0) {
        console.error(`verification: FAILED (${failed} failure(s), ${passed} passed)`);
        process.exit(1);
    }
    console.log(`verification: ok (${passed} assertions passed)`);
} catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
}
