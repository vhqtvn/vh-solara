// f3-design-readiness.js — the F3 design-gate pure validator (BUILD-READY
// refusal on a named-but-unresolved ownership hazard).
//
// SAFETY-LAYER RESIDENCE. F3 is the ONLY family in the F1/F2/F3 operator-
// visibility set whose authority is BLOCKS (every other participant INFORMS).
// It fires pre-code, at the BUILD-READY crossing (draft → ready for task cards;
// draft → approved for plans), immediately before the lifecycle mutation. This
// module is the PURE predicate; the integration glue (load envelope, derive the
// current design digest, invoke, refuse or permit the mutation) lives at the
// call sites in state-lib.js (readyCoordinationTask, approveDraft) and the
// dispatch backstops (activateCoordinationTask, plan execution).
//
// This module performs NO lifecycle mutation, NO network, NO filesystem access.
// It is a deterministic function of (envelope, currentDesignDigest, transition).
// That purity is load-bearing: it makes the gate inspectable, testable in
// isolation, and immune to side-effect ordering.
//
// THE HONESTY CEILING (structural-validation-≠-truth). F3 CAN verify that the
// envelope exists, that hazards are in the known schema, that each hazard has a
// resolution record, that resolutions name exactly one authority + dispose
// every secondary, that evidence/provenance fields are present + internally
// consistent, that a distinct adversarial record exists + is bound to the
// current design, that the verdict is `resolution_supported`, and that no
// refutation / inconclusive / stale-digest / blocking-limitation remains. F3
// CANNOT verify that the design is good, that the chosen authority model works
// in production, that a cited source is truthful, that the reviewer reasoned
// competently, or that a structurally complete resolution is substantively
// true. A PASS therefore says: "the required F3 resolution process is
// structurally satisfied" — NEVER "the ownership hazard is proven solved."
//
// Design basis: the F3 design-gate mechanism decision memo (record-of-decision
// fixing the F3 safety-layer mechanism: the "resolved" predicate, the authority
// line, the honesty ceiling). The F3_PASS + F3_HAZARD_RESOLVED predicates below
// are the verbatim articulation of that memo's Decision 1 (the "resolved"
// predicate, hybrid F3-O4). This module localizes the memo's open build
// questions (digest scope, provenance semantics, reviewer-identity check) to
// the strongest deterministic representation available at this layer.

import crypto from "crypto";

// ---------------------------------------------------------------------------
// Closed vocabularies (frozen). Unknown input values in these sets fail closed.
// ---------------------------------------------------------------------------

const HAZARD_CLASSES = Object.freeze(["ownership"]);

const SECONDARY_AUTHORITY_DISPOSITIONS = Object.freeze([
    "removed",
    "prohibited",
    "delegated_to_authoritative_owner",
]);

const ADVERSARIAL_VERDICTS = Object.freeze([
    "resolution_supported",
    "refuted",
    "inconclusive",
]);

// Reason codes the validator emits. The semantic-failure vocabulary is fixed by
// the build spec; `malformed_envelope` is the build-localization code for a
// schema-invalid envelope (unknown enum, missing required declaration field,
// wrong shape) — distinct from `missing_envelope` (absent / omission) so a
// diagnosable structural failure is not conflated with "no envelope supplied."
const REASON_CODES = Object.freeze([
    "missing_envelope",
    "malformed_envelope",
    "missing_resolution",
    "stale_design_digest",
    "invalid_provenance",
    "missing_counter_case",
    "reviewer_identity_collision",
    "review_refuted",
    "review_inconclusive",
    "blocking_limitation",
]);

// ---------------------------------------------------------------------------
// Required-field sets per record type. Mirrors the named-hazard input schema
// in the memo (hazard declaration, resolution record, adversarial record,
// counter-case). A record missing any required field is malformed.
// ---------------------------------------------------------------------------

const HAZARD_DECLARATION_REQUIRED = Object.freeze([
    "hazard_id",
    "hazard_class",
    "hazard_statement",
    "affected_boundary",
    "failure_mode",
]);

const RESOLUTION_REQUIRED = Object.freeze([
    "authoritative_owner",
    "secondary_authority_disposition",
    "mechanism_mapping",
    "design_digest",
    "declared_by",
    "declared_at",
    // `minimum_counter_case` is validated by the dedicated counter-case clause
    // of F3_HAZARD_RESOLVED (which emits `missing_counter_case`, not the
    // generic `missing_resolution`). It is intentionally NOT in this set so a
    // missing counter-case surfaces under its specific reason code. This also
    // matches the memo's resolution-record table (which does not enumerate it).
]);

const ADVERSARIAL_REQUIRED = Object.freeze([
    "review_id",
    "hazard_id",
    "design_digest",
    "reviewer_identity",
    "reviewer_provenance",
    "evidence_checked",
    "verdict",
    "weakest_supported_claim",
]);

const COUNTER_CASE_REQUIRED = Object.freeze([
    "counter_case_id",
    "preconditions",
    "competing_or_missing_event",
    "expected_authoritative_owner",
    "expected_state_or_outcome",
    "forbidden_state_or_outcome",
    "resolution_mapping",
    "evidence_refs",
]);

// Fields documented as array-typed (`[]` in the memo schema). For these,
// missingRequiredFields rejects a NON-ARRAY value (e.g. a truthy string) as
// malformed, not just empty — this closes the fail-closed gap where a non-array
// truthy value on a documented array field silently passed as "present."
const COUNTER_CASE_ARRAY_FIELDS = Object.freeze(["evidence_refs"]);
const ADVERSARIAL_ARRAY_FIELDS = Object.freeze(["evidence_checked"]);

// ---------------------------------------------------------------------------
// Design digest (Open question 3 localization). The digest binds a resolution
// + adversarial record to the CURRENT design. It must be deterministic,
// reproducible from ground truth, and sensitive to every field whose change
// should invalidate the resolution. The caller derives designFields from
// current ground truth (task-card design fields OR the plan body) and passes
// them in; the validator receives the resulting digest as a parameter, keeping
// it pure + side-effect-free.
// ---------------------------------------------------------------------------

/**
 * Canonical JSON serialization: recursively sorts object keys so the output is
 * deterministic regardless of insertion order. Arrays preserve order (order is
 * semantically meaningful in a list of fields/hazards).
 *
 * @param {*} value
 * @returns {string}
 */
function canonicalJson(value) {
    if (value === null) {
        return "null";
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (typeof value === "object") {
        const keys = Object.keys(value).sort();
        return `{${keys
            .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

/**
 * Compute a SHA-256 hex digest over the canonical serialization of the supplied
 * design fields. Intended input: a plain object carrying the design-bearing
 * fields of a task card (task_id, title, task_type, primary_lane, files_in_scope,
 * success_criteria, constraints, non_goals, validation_plan) OR the frontmatter-
 * stripped plan body string. The caller chooses the scope; the digest is the
 * binding token.
 *
 * @param {*} designFields
 * @returns {string} 64-char lowercase hex digest
 */
export function computeDesignDigest(designFields) {
    const canonical = canonicalJson(designFields);
    return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Small structural helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "";
}

function isNonEmptyArray(value) {
    return Array.isArray(value) && value.length > 0;
}

/**
 * Structural provenance check (Open question 6 localization). At this pure
 * layer a record is provenance-valid when it carries a non-empty `provenance`
 * field (string or object) declaring where it came from. Existence-checking or
 * digest-checking a cited locator is out of scope for the pure validator (would
 * require filesystem/network); the optional doctor audit (Slice 6) may layer
 * that on. This records the limitation honestly in the honesty ceiling.
 *
 * @param {object} record
 * @returns {boolean}
 */
function hasValidProvenance(record) {
    if (!record || typeof record !== "object") {
        return false;
    }
    const provenance = record.provenance;
    if (isNonEmptyString(provenance)) {
        return true;
    }
    if (
        provenance &&
        typeof provenance === "object" &&
        Object.keys(provenance).length > 0
    ) {
        return true;
    }
    return false;
}

/**
 * Structural identity-distinctness check (Open question 5 localization).
 * `reviewer_identity` must differ nominally from the resolution's `declared_by`.
 * String-inequality is the strongest deterministic representation available at
 * this layer. It is ONLY nominal separation — genuine independence cannot be
 * verified structurally (the honesty ceiling carries this explicitly). A
 * collision (equal strings, case-sensitive) fails closed.
 *
 * @param {string} reviewerIdentity
 * @param {string} declaredBy
 * @returns {boolean}
 */
function isReviewerDistinct(reviewerIdentity, declaredBy) {
    return (
        isNonEmptyString(reviewerIdentity) &&
        isNonEmptyString(declaredBy) &&
        reviewerIdentity !== declaredBy
    );
}

function missingRequiredFields(record, requiredFields, arrayFields = []) {
    if (!record || typeof record !== "object") {
        return [...requiredFields];
    }
    // A required field is missing when it is absent, null, an empty string,
    // an empty array, or an empty object. For a field documented as array-
    // typed, a NON-ARRAY value (e.g. a truthy string) is ALSO missing/malformed
    // — it must not silently pass as "present and valid." This closes the
    // fail-closed gap where a non-array truthy value slipped through the
    // string branch. `undefined` (absent) always counts as missing.
    const arrayFieldSet = arrayFields.length ? new Set(arrayFields) : null;
    return requiredFields.filter((field) => {
        const value = record[field];
        if (arrayFieldSet && arrayFieldSet.has(field)) {
            return !Array.isArray(value) || value.length === 0;
        }
        if (value === undefined || value === null) {
            return true;
        }
        if (Array.isArray(value)) {
            return value.length === 0;
        }
        if (typeof value === "object") {
            return Object.keys(value).length === 0;
        }
        return !isNonEmptyString(value);
    });
}

// ---------------------------------------------------------------------------
// The F3_PASS predicate (memo, verbatim articulation)
// ---------------------------------------------------------------------------
//
//   F3_PASS := envelope present + schema-valid
//     AND design_digest matches current design
//     AND every named ownership hazard satisfies F3_HAZARD_RESOLVED
//
//   F3_HAZARD_RESOLVED := declaration complete
//     AND hazard sources have valid provenance
//     AND resolution bound to current design digest
//     AND exactly one authoritative owner declared
//     AND every competing secondary authority has explicit permitted disposition
//     AND mechanism mapping present + complete
//     AND resolution evidence present + provenance-valid
//     AND deterministic minimum counter-case complete
//     AND adversarial record present + bound to same current design digest
//     AND reviewer identity structurally distinct from resolution producer
//     AND adversarial verdict == resolution_supported
//     AND no counter-case refuted
//     AND no blocking limitation remains
//
// Fail-closed on: missing, malformed, unknown value, stale (different digest),
// internally contradictory, unprovenanced, identity-colliding, refuted, or
// inconclusive. Every failure produces a structured BLOCK with a reason code.
// ---------------------------------------------------------------------------

/**
 * Validate a single named ownership hazard against F3_HAZARD_RESOLVED.
 * Returns `{ passed: true }` or `{ passed: false, reasonCode, detail }`.
 *
 * @param {object} hazard
 * @param {string} currentDesignDigest
 * @returns {{passed: true} | {passed: false, reasonCode: string, detail: string}}
 */
function validateHazardResolved(hazard, currentDesignDigest) {
    // --- declaration complete ---
    const missingDecl = missingRequiredFields(hazard, HAZARD_DECLARATION_REQUIRED);
    if (missingDecl.length) {
        return block(
            "malformed_envelope",
            `Hazard ${safeId(hazard)} declaration is missing required field(s): ${missingDecl.join(", ")}.`,
        );
    }
    if (!HAZARD_CLASSES.includes(hazard.hazard_class)) {
        return block(
            "malformed_envelope",
            `Hazard ${safeId(hazard)} has unknown hazard_class "${hazard.hazard_class}" (expected one of: ${HAZARD_CLASSES.join(", ")}).`,
        );
    }
    if (!isNonEmptyArray(hazard.competing_authorities)) {
        return block(
            "malformed_envelope",
            `Hazard ${safeId(hazard)} must list at least one competing_authorities entry (an ownership hazard requires the authorities in conflict).`,
        );
    }

    // --- hazard sources have valid provenance ---
    const sourceRecords = Array.isArray(hazard.source_records)
        ? hazard.source_records
        : [];
    if (!sourceRecords.length) {
        return block(
            "invalid_provenance",
            `Hazard ${safeId(hazard)} must carry at least one source_record with provenance (where the hazard was identified).`,
        );
    }
    const unprovenancedSource = sourceRecords.find((r) => !hasValidProvenance(r));
    if (unprovenancedSource) {
        return block(
            "invalid_provenance",
            `Hazard ${safeId(hazard)} has a source_record without provenance (every source must declare where the hazard was identified).`,
        );
    }

    // --- resolution record present ---
    const resolution = hazard.resolution;
    if (!resolution || typeof resolution !== "object") {
        return block(
            "missing_resolution",
            `Hazard ${safeId(hazard)} has no resolution record (an authority-mark or HIGH/self-asserted status is NOT a resolution; the resolution package is a derived F3 verdict from the structural clauses).`,
        );
    }
    const missingRes = missingRequiredFields(resolution, RESOLUTION_REQUIRED);
    if (missingRes.length) {
        return block(
            "missing_resolution",
            `Hazard ${safeId(hazard)} resolution is missing required field(s): ${missingRes.join(", ")}.`,
        );
    }

    // --- exactly one authoritative owner + every secondary disposed ---
    if (!isNonEmptyString(resolution.authoritative_owner)) {
        return block(
            "missing_resolution",
            `Hazard ${safeId(hazard)} resolution must name exactly one authoritative_owner (the authority the resolution binds to).`,
        );
    }
    if (
        !SECONDARY_AUTHORITY_DISPOSITIONS.includes(
            resolution.secondary_authority_disposition,
        )
    ) {
        return block(
            "malformed_envelope",
            `Hazard ${safeId(hazard)} resolution has unknown secondary_authority_disposition "${resolution.secondary_authority_disposition}" (expected one of: ${SECONDARY_AUTHORITY_DISPOSITIONS.join(", ")}).`,
        );
    }

    // --- mechanism mapping present + complete ---
    if (!isNonEmptyString(resolution.mechanism_mapping)) {
        return block(
            "missing_resolution",
            `Hazard ${safeId(hazard)} resolution mechanism_mapping must explain how the resolution is realized in the design.`,
        );
    }

    // --- resolution bound to current design digest ---
    if (resolution.design_digest !== currentDesignDigest) {
        return block(
            "stale_design_digest",
            `Hazard ${safeId(hazard)} resolution is bound to a stale design digest (resolution's design_digest does not match the current design). A design change requires a new resolution bound to the current digest.`,
        );
    }

    // --- resolution evidence present + provenance-valid ---
    const evidenceRecords = Array.isArray(resolution.evidence_records)
        ? resolution.evidence_records
        : [];
    if (!evidenceRecords.length) {
        return block(
            "invalid_provenance",
            `Hazard ${safeId(hazard)} resolution must carry at least one evidence_record with provenance (a model-fabricated artifact with no provenance is more dangerous than prose; F3 inherits the captured-or-verified ceiling).`,
        );
    }
    const unprovenancedEvidence = evidenceRecords.find(
        (r) => !hasValidProvenance(r),
    );
    if (unprovenancedEvidence) {
        return block(
            "invalid_provenance",
            `Hazard ${safeId(hazard)} resolution has an evidence_record without provenance (every evidence record must declare how it was captured or verified).`,
        );
    }

    // --- deterministic minimum counter-case complete ---
    const minimumCounterCase = resolution.minimum_counter_case;
    if (
        !minimumCounterCase ||
        typeof minimumCounterCase !== "object"
    ) {
        return block(
            "missing_counter_case",
            `Hazard ${safeId(hazard)} resolution must carry a minimum_counter_case (the falsifying probe the author cannot skip — forces the author to state how the resolution fails).`,
        );
    }
    const missingCc = missingRequiredFields(
        minimumCounterCase,
        COUNTER_CASE_REQUIRED,
        COUNTER_CASE_ARRAY_FIELDS,
    );
    if (missingCc.length) {
        return block(
            "missing_counter_case",
            `Hazard ${safeId(hazard)} minimum_counter_case is missing required field(s): ${missingCc.join(", ")}.`,
        );
    }

    // --- no blocking limitation on the resolution side ---
    // A present-but-non-array value FAILS CLOSED. Using isNonEmptyArray() as
    // the sole guard here would silently pass a non-array truthy value (e.g. a
    // string "authority unverified") through to { passed: true } — a fail-closed
    // violation on a safety field of the sole BLOCKS family. The type must be
    // checked explicitly before the emptiness check.
    if (
        resolution.blocking_limitations !== undefined &&
        resolution.blocking_limitations !== null
    ) {
        if (!Array.isArray(resolution.blocking_limitations)) {
            return block(
                "malformed_envelope",
                `Hazard ${safeId(hazard)} resolution.blocking_limitations must be an array when present (got ${typeof resolution.blocking_limitations}); a non-array value on a safety field fails closed.`,
            );
        }
        if (resolution.blocking_limitations.length > 0) {
            return block(
                "blocking_limitation",
                `Hazard ${safeId(hazard)} resolution still carries blocking_limitation(s) (${resolution.blocking_limitations.length}). A blocking limitation prevents the resolution_supported verdict.`,
            );
        }
    }

    // --- adversarial record present + bound to same current design digest ---
    const adversarial = hazard.adversarial_review;
    if (!adversarial || typeof adversarial !== "object") {
        return block(
            "missing_resolution",
            `Hazard ${safeId(hazard)} has no distinct adversarial_review record (the author's own review cannot be re-used; a distinct adversarial record is required).`,
        );
    }
    const missingAdv = missingRequiredFields(
        adversarial,
        ADVERSARIAL_REQUIRED,
        ADVERSARIAL_ARRAY_FIELDS,
    );
    if (missingAdv.length) {
        return block(
            "malformed_envelope",
            `Hazard ${safeId(hazard)} adversarial_review is missing required field(s): ${missingAdv.join(", ")}.`,
        );
    }
    // The adversarial record's hazard_id MUST bind to the hazard under review
    // (memo schema L186-189: hazard_id "binds to the hazard under review"). A
    // review written for a DIFFERENT hazard cannot satisfy this hazard even if
    // it is otherwise complete + current — without this equality check two
    // hazards sharing a design digest could cross-satisfy each other.
    if (adversarial.hazard_id !== hazard.hazard_id) {
        return block(
            "malformed_envelope",
            `Hazard ${safeId(hazard)} adversarial_review is bound to hazard_id "${adversarial.hazard_id}", which does not match the hazard under review ("${hazard.hazard_id}"). An adversarial record must bind to the SAME hazard it adjudicates.`,
        );
    }
    if (adversarial.design_digest !== currentDesignDigest) {
        return block(
            "stale_design_digest",
            `Hazard ${safeId(hazard)} adversarial_review is bound to a stale design digest (must match the same current design digest as the resolution).`,
        );
    }

    // --- reviewer identity structurally distinct from resolution producer ---
    if (
        !isReviewerDistinct(adversarial.reviewer_identity, resolution.declared_by)
    ) {
        return block(
            "reviewer_identity_collision",
            `Hazard ${safeId(hazard)} adversarial_review reviewer_identity collides with the resolution's declared_by (string-inequality is only nominal separation — genuine independence cannot be verified structurally, but a nominal collision is a hard failure).`,
        );
    }

    // --- adversarial verdict (closed enum) ---
    if (!ADVERSARIAL_VERDICTS.includes(adversarial.verdict)) {
        return block(
            "malformed_envelope",
            `Hazard ${safeId(hazard)} adversarial_review has unknown verdict "${adversarial.verdict}" (expected one of: ${ADVERSARIAL_VERDICTS.join(", ")}).`,
        );
    }
    if (adversarial.verdict === "refuted") {
        return block(
            "review_refuted",
            `Hazard ${safeId(hazard)} adversarial_review verdict is refuted (only resolution_supported can contribute to a pass).`,
        );
    }
    if (adversarial.verdict === "inconclusive") {
        return block(
            "review_inconclusive",
            `Hazard ${safeId(hazard)} adversarial_review verdict is inconclusive (only resolution_supported can contribute to a pass).`,
        );
    }

    // --- adversarial counter-cases (≥1, schema-valid) ---
    const counterCases = Array.isArray(adversarial.counter_cases)
        ? adversarial.counter_cases
        : [];
    if (!counterCases.length) {
        return block(
            "missing_counter_case",
            `Hazard ${safeId(hazard)} adversarial_review must carry at least one counter_case (the reviewer validates/strengthens/adds to the author's minimum counter-case).`,
        );
    }
    const malformedCounterCase = counterCases.find(
        (cc) =>
            missingRequiredFields(cc, COUNTER_CASE_REQUIRED, COUNTER_CASE_ARRAY_FIELDS)
                .length > 0,
    );
    if (malformedCounterCase) {
        const missing = missingRequiredFields(
            malformedCounterCase,
            COUNTER_CASE_REQUIRED,
            COUNTER_CASE_ARRAY_FIELDS,
        );
        return block(
            "missing_counter_case",
            `Hazard ${safeId(hazard)} adversarial_review has a counter_case missing required field(s): ${missing.join(", ")}.`,
        );
    }

    // --- no blocking limitation on the adversarial side ---
    // Same fail-closed-on-non-array discipline as the resolution side: a
    // present-but-non-array limitations value must not silently pass.
    if (
        adversarial.limitations !== undefined &&
        adversarial.limitations !== null
    ) {
        if (!Array.isArray(adversarial.limitations)) {
            return block(
                "malformed_envelope",
                `Hazard ${safeId(hazard)} adversarial_review.limitations must be an array when present (got ${typeof adversarial.limitations}); a non-array value on a safety field fails closed.`,
            );
        }
        // Reviewer limitations are expected (they record what the reviewer could
        // not verify); only a limitation explicitly flagged `blocking` blocks.
        const blocking = adversarial.limitations.filter(
            (lim) =>
                lim &&
                typeof lim === "object" &&
                lim.blocking === true,
        );
        if (blocking.length) {
            return block(
                "blocking_limitation",
                `Hazard ${safeId(hazard)} adversarial_review still carries ${blocking.length} blocking limitation(s) (a blocking limitation prevents the resolution_supported verdict).`,
            );
        }
    }

    return { passed: true };
}

function safeId(hazard) {
    return isNonEmptyString(hazard && hazard.hazard_id)
        ? `"${hazard.hazard_id}"`
        : "(no hazard_id)";
}

function block(reasonCode, detail) {
    return { passed: false, reasonCode, detail };
}

/**
 * Validate an F3 design-readiness envelope against F3_PASS.
 *
 * Pure: no filesystem, no network, no lifecycle mutation. Returns a structured
 * verdict the caller acts on (the call site in state-lib.js refuses the
 * transition on `{ passed: false }` and applies the existing transition on
 * `{ passed: true }`).
 *
 * @param {object} params
 * @param {object|null|undefined} params.envelope - the f3_design_readiness envelope
 * @param {string} params.currentDesignDigest - the digest derived from current ground truth
 * @param {string} [params.transitionKind] - diagnostic free string. Accepted vocabulary: "task_ready" | "task_ready_refresh" | "plan_approve" | "plan_dispatch" | "task_dispatch". The predicate is transition-agnostic — one shared gate, all call sites. Only a subset of known kinds get a non-empty transitionLabel (task_ready, task_ready_refresh, plan_approve); the other known kinds and any unknown kind fall through to "".
 * @returns {{passed: true, detail: string} | {passed: false, reasonCode: string, detail: string}}
 */
export function validateF3DesignReadiness({
    envelope,
    currentDesignDigest,
    transitionKind,
} = {}) {
    // --- envelope present ---
    if (!envelope || typeof envelope !== "object") {
        return block(
            "missing_envelope",
            `F3 design-readiness envelope is absent at this BUILD-READY crossing${transitionLabel(transitionKind)}. Omission fails closed (an envelope with ownership_hazards: [] is the explicit-empty pass path; no envelope is not the same as an empty inventory).`,
        );
    }

    // --- ownership_hazards field present (omission ≠ empty) ---
    if (!Array.isArray(envelope.ownership_hazards)) {
        return block(
            "missing_envelope",
            `F3 envelope is missing the ownership_hazards[] field. Omission fails closed (the field must be present; an empty array is the explicit "no named hazard" pass, an absent field is a structural failure).`,
        );
    }

    // --- current design digest supplied by caller ---
    if (!isNonEmptyString(currentDesignDigest)) {
        return block(
            "stale_design_digest",
            `F3 validator was not supplied a current design digest${transitionLabel(transitionKind)}. The digest binds the resolution + adversarial record to the current design; without it no binding can be current. (Caller bug — the crossing must derive the digest from current ground truth.)`,
        );
    }

    // --- envelope-level design_digest binding (F3_PASS clause 2: "design_digest
    // matches current design"). This binds the WHOLE envelope to the current
    // design — the freshness binding for the explicit-empty case (which carries
    // no per-hazard digests), and a defense-in-depth re-binding for the
    // hazard-bearing case (per-hazard resolution.design_digest +
    // adversarial.design_digest bind the hazard paths; this clause re-binds the
    // survey itself). Fires BEFORE the explicit-empty early-return so both paths
    // are covered. (b-F1 resolution: an explicit-empty envelope authored against
    // design v1 must NOT survive a transition to design v2 — the new design may
    // have introduced a hazard the v1 survey did not cover.)
    if (!isNonEmptyString(envelope.design_digest)) {
        return block(
            "malformed_envelope",
            `F3 envelope is missing the top-level design_digest field${transitionLabel(transitionKind)}. The envelope design_digest binds the whole package (resolution records, adversarial records, and the explicit-empty "no hazard named" survey) to the current design; an envelope without it cannot be freshness-checked. (Author must supply design_digest = the digest over the current design-bearing fields at authoring time.)`,
        );
    }
    if (envelope.design_digest !== currentDesignDigest) {
        return block(
            "stale_design_digest",
            `F3 envelope is bound to a stale design digest${transitionLabel(transitionKind)}: envelope.design_digest does not match the current design. A design change requires a fresh envelope re-bound to the current digest — the prior survey (including an explicit-empty "no hazard named" survey) was against the prior design and must be re-adjudicated against the new one.`,
        );
    }

    // --- explicit-empty inventory: the honesty-caveated pass ---
    if (envelope.ownership_hazards.length === 0) {
        return {
            passed: true,
            detail:
                `F3 design-readiness envelope present with an explicit-empty ownership_hazards inventory${transitionLabel(transitionKind)}: the design author surveyed the current design (envelope design_digest verified current) and named no ownership hazard at this crossing. The required F3 resolution process is structurally satisfied. CAVEAT: this records "no hazard named," not "no hazard exists" — completeness of hazard discovery is outside F3's structural ceiling (an empty inventory is an author attestation, not a gate-derived guarantee).`,
        };
    }

    // --- every named hazard satisfies F3_HAZARD_RESOLVED ---
    for (const hazard of envelope.ownership_hazards) {
        const result = validateHazardResolved(hazard, currentDesignDigest);
        if (!result.passed) {
            return result;
        }
    }

    return {
        passed: true,
        detail:
            `F3 design-readiness envelope passed${transitionLabel(transitionKind)}: every named ownership hazard is structurally resolved against the current design digest. The required F3 resolution process is structurally satisfied. This is a structural validation, NOT proof of design correctness — the resolution, evidence, and adversarial record are internally consistent and current; their substantive truth is outside F3's ceiling.`,
    };
}

function transitionLabel(transitionKind) {
    if (transitionKind === "task_ready") {
        return " (task-card draft → ready)";
    }
    if (transitionKind === "task_ready_refresh") {
        return " (task-card ready → ready envelope refresh)";
    }
    if (transitionKind === "plan_approve") {
        return " (draft-plan → approved)";
    }
    return "";
}

// ---------------------------------------------------------------------------
// Exports for downstream consumers (Slice 5 authoring surfaces, Slice 6 doctor
// audit, tests). Frozen so the closed vocabularies cannot be mutated at runtime.
// ---------------------------------------------------------------------------

export const F3_REASON_CODES = Object.freeze([...REASON_CODES]);
export const F3_HAZARD_CLASSES = Object.freeze([...HAZARD_CLASSES]);
export const F3_SECONDARY_AUTHORITY_DISPOSITIONS = Object.freeze([
    ...SECONDARY_AUTHORITY_DISPOSITIONS,
]);
export const F3_ADVERSARIAL_VERDICTS = Object.freeze([...ADVERSARIAL_VERDICTS]);
export const F3_REQUIRED_FIELDS = Object.freeze({
    hazard_declaration: [...HAZARD_DECLARATION_REQUIRED],
    resolution: [...RESOLUTION_REQUIRED],
    adversarial_review: [...ADVERSARIAL_REQUIRED],
    counter_case: [...COUNTER_CASE_REQUIRED],
});
