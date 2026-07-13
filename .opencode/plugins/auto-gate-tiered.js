// auto-gate-tiered.js — pure multi-leaf aggregation core for a tiered
// auto-classifier gate (Phase 1 of the multi-tier pilot).
//
// This module is a LIBRARY of pure functions. It has NO OpenCode coupling: no
// `server()` export, no hooks, no I/O, no config disk reads, no side effects.
// It mirrors the auto-gate-verdict.js / auto-gate-live.js / auto-gate-scrub.js
// precedent (pure decision/substrate modules that the plugin imports, and that
// OpenCode tolerates as non-plugins under .opencode/plugins/ because each has a
// NON-FUNCTION export — this module's is `LEAF` below — NOT merely because they
// lack `server`; a module whose exports are ALL functions crashes the loader
// (see auto-gate-scrub.js's loader-guard comment for the full rule). Phase 1 is
// NOT wired into auto-tool-gate.js or any live
// hook — the default single-call behavior stays byte-identical. The
// dispatch/wiring/live-call parts are Phase 2 (out of scope here).
//
// WHAT THIS ADDS
//
// A "leaf" in the tier model = one classifier call that resolves to a
// normalized ALLOW / DENY / FAIL. This module defines that normalization
// (normalizeLeafOutcome) and the unanimous-allow aggregation policy over an
// array of such leaf outcomes (aggregateLeafOutcomes). The design brief
// (already produced via solution-brief) recommended a 2-leaf consensus
// cascade: two cheap classifier leaves run in parallel; UNANIMOUS-ALLOW is
// the ONLY path to grant. Phase 1 builds just the pure aggregation + its
// tests.
//
// THE SAFETY CORE (unanimous-allow, fail-closed dominant)
//
//   any FAIL present      -> decision "deny", incomplete true
//                            (an incomplete tier is uncertain -> deny)
//   no FAIL, any DENY     -> decision "deny"
//                            (if any ALLOW also present -> disagreement true)
//   no FAIL, no DENY,
//     all ALLOW, non-empty-> decision "allow"   (the ONLY grant path)
//   empty array           -> decision "deny"    (no leaves = no unanimous allow)
//   unknown outcome value -> treated as FAIL    (data resilience -> deny)
//
// The function NEVER returns decision "allow" unless EVERY leaf is ALLOW and
// there is at least one leaf. It never throws on bad DATA (unknown outcome
// strings map to FAIL -> deny); it throws ONLY on a non-array input, which is
// a programmer-error assertion (the caller's fail-closed boundary catches it).
//
// Naming: all identifiers GENERIC (auto-gate-tiered / leaf / aggregate). The
// upstream is referred to only as "the reference agent system" — never by
// product name.
//
// DUAL-PURPOSE SELF-TEST: like auto-gate-verdict.js, running this file directly
// (`node auto-gate-tiered.js` or `node --test auto-gate-tiered.js`) executes
// the node:test suite at the bottom; importing it as a module runs NO tests.
// The __isMain guard uses an explicit __filename comparison so an accidental
// import cannot fire the suite.

import { fileURLToPath } from "node:url";
import path from "node:path";
// Static imports (no top-level await) so the self-test registers synchronously
// when run directly. These two built-ins are INERT on the import path:
// importing them does not start a test runner and registers nothing — only
// the `test()` CALLS do, and those are guarded behind __isMain.
import { test } from "node:test";
import { strict as assert } from "node:assert";

// ---------------------------------------------------------------------------
// Leaf outcome constants + type.
//
// A normalized leaf outcome is one of these three strings. The set is frozen
// so a stray mutation cannot widen the allow path. ALLOW is the ONLY grant
// signal; DENY and FAIL both deny (FAIL additionally marks the tier
// incomplete).
// ---------------------------------------------------------------------------
export const LEAF = Object.freeze({
    ALLOW: "allow",
    DENY: "deny",
    FAIL: "fail",
});

// _VALID_OUTCOMES — the membership set used by _coerceOutcome. Kept as a Set
// for O(1) validation; mirrors the frozen LEAF values exactly.
const _VALID_OUTCOMES = new Set([LEAF.ALLOW, LEAF.DENY, LEAF.FAIL]);

// ---------------------------------------------------------------------------
// normalizeLeafOutcome — map a single leaf's RAW result to a normalized
// LEAF.* outcome. Pure, never throws.
//
// Input shapes (covering the existing parseVerdict / decidePermission /
// decideLive contracts + their failure modes):
//
//   {decision:"allow"}            (or {status:"allow"})     -> ALLOW
//   {decision:"block", reason}    (or {status:"deny"})      -> DENY
//   null / undefined              (unparseable / missing)   -> FAIL
//   a thrown Error object         (caller may pass a caught)-> FAIL
//   anything else                 (malformed / unknown)     -> FAIL
//
// Be CONSERVATIVE: only a STRICTLY valid allow -> ALLOW; only a strictly
// valid block/deny -> DENY; everything uncertain -> FAIL. This never throws —
// a leaf that cannot be classified is, by definition, a FAIL (uncertain), and
// the aggregate layer maps FAIL -> deny (fail-closed).
//
// The decision/status key precedence: `decision` is checked first (the
// parseVerdict contract), then `status` (the decidePermission / decideLive
// contract). Only the string literals "allow"/"block"/"deny" are recognized;
// any other value (e.g. "ask", "maybe", a number) -> FAIL.
export function normalizeLeafOutcome(raw) {
    // null / undefined -> FAIL (missing verdict).
    if (raw === null || raw === undefined) {
        return LEAF.FAIL;
    }
    // A thrown Error passed in by the caller -> FAIL (the caller caught it and
    // is handing us the failure shape). instanceof Error covers subclasses.
    if (raw instanceof Error) {
        return LEAF.FAIL;
    }
    // Non-object primitives (string / number / boolean / bigint / symbol) are
    // not valid raw leaf results -> FAIL. (A bare string is NOT accepted here
    // because the raw contract is an object verdict or null; a string would be
    // a caller bug. The aggregate layer accepts bare LEAF.* strings directly
    // via _coerceOutcome, but normalizeLeafOutcome's job is the RAW -> enum
    // mapping, which expects a verdict object.)
    if (typeof raw !== "object") {
        return LEAF.FAIL;
    }
    // Try the `decision` key first (parseVerdict shape).
    const dec = raw.decision;
    if (dec === "allow") return LEAF.ALLOW;
    if (dec === "block") return LEAF.DENY;
    // Then the `status` key (decidePermission / decideLive shape).
    const st = raw.status;
    if (st === "allow") return LEAF.ALLOW;
    if (st === "deny") return LEAF.DENY;
    // Anything else: malformed object, missing decision/status, unknown status
    // string like "ask"/"maybe", or a non-string decision/status -> FAIL.
    return LEAF.FAIL;
}

// ---------------------------------------------------------------------------
// _coerceOutcome — internal: extract a validated LEAF.* from one element of
// the aggregate input array. Accepts BOTH a bare LEAF.* string AND a
// {outcome, leafId} pair (the pair form lets a caller attach a leaf label for
// audit/debugging without changing the policy). An unknown string or a
// malformed element maps to FAIL (data resilience -> deny, never throws).
//
//   "allow" | "deny" | "fail"                      -> that value
//   "ask" | "maybe" | <any other string>           -> FAIL
//   {outcome:"allow", leafId:"x"}                  -> ALLOW
//   {outcome:"maybe"}                              -> FAIL
//   {outcome:123} | {} | <non-string outcome>      -> FAIL
//   number / boolean / null / undefined element    -> FAIL
function _coerceOutcome(el) {
    if (typeof el === "string") {
        return _VALID_OUTCOMES.has(el) ? el : LEAF.FAIL;
    }
    if (el && typeof el === "object" && typeof el.outcome === "string") {
        return _VALID_OUTCOMES.has(el.outcome) ? el.outcome : LEAF.FAIL;
    }
    return LEAF.FAIL;
}

// ---------------------------------------------------------------------------
// aggregateLeafOutcomes — apply the unanimous-allow policy over an array of
// normalized leaf outcomes. Pure: does not mutate its input. Returns a plain
// {decision, audit, disagreement, incomplete} object.
//
// INPUT
//   outcomes: an array whose elements are each EITHER a bare LEAF.* string
//             OR a {outcome, leafId} pair. Unknown outcome values are treated
//             as FAIL (data resilience). Mixed forms are tolerated.
//   opts:     { tierId?, leafIds? } — optional audit labeling. tierId is
//             interpolated into the audit string (a short operator label);
//             leafIds values are NOT interpolated (they could carry operator
//             content and would break the constant-shaped audit invariant) —
//             only their COUNT is used.
//
// OUTPUT
//   {
//     decision:    "allow" | "deny",   // the aggregate verdict; NEVER else
//     audit:       string,             // scrubbed, single-line, constant-shaped
//     disagreement:boolean,            // true iff (no FAIL) AND (ALLOW+DENY mix)
//     incomplete:  boolean,            // true iff any FAIL present
//   }
//
// POLICY (fail-closed dominant — implemented EXACTLY):
//   empty array                  -> deny (no leaves = no unanimous allow)
//   any FAIL present             -> deny, incomplete true
//   no FAIL, any DENY present    -> deny (disagreement true if any ALLOW too)
//   no FAIL, no DENY, all ALLOW  -> allow (the ONLY grant path; needs >=1 leaf)
//   unknown outcome value        -> treated as FAIL -> deny
//
// NON-ARRAY INPUT THROWS. This is a programmer-error assertion, not a data
// path: a non-array means the caller did not build the tier correctly, and the
// brief's "aggregate returns deny or throws into the existing fail-closed
// path" guidance is satisfied by letting the throw propagate to the caller's
// fail-closed boundary. Bad DATA (unknown strings, malformed elements) never
// throws — it maps to FAIL -> deny.
export function aggregateLeafOutcomes(outcomes, opts = {}) {
    // Defensive assertion: a non-array input is a programmer error. We throw
    // rather than silently deny so a wiring bug surfaces loudly at the
    // caller's fail-closed boundary instead of masking as a perpetual deny.
    if (!Array.isArray(outcomes)) {
        throw new TypeError(
            "aggregateLeafOutcomes: outcomes must be an array (got " +
                typeof outcomes +
                ")",
        );
    }

    const tierId =
        opts && typeof opts.tierId === "string" && opts.tierId.length > 0
            ? opts.tierId
            : "";
    const tidLabel = tierId ? ` tier=${tierId}` : "";

    const n = outcomes.length;

    // Empty array -> deny (no leaves = no unanimous allow). Distinct audit so
    // an operator can tell a configured-but-empty tier from a real verdict.
    if (n === 0) {
        return {
            decision: "deny",
            audit: `tier-aggregate: deny (reason=no-leaves leaves=0${tidLabel})`,
            disagreement: false,
            incomplete: false,
        };
    }

    // Tally the (coerced) outcomes. We iterate ONCE, counting allows/denies/
    // fails. _coerceOutcome maps unknown/malformed elements to FAIL here, so
    // the data-resilience rule (unknown -> FAIL -> deny) is enforced at the
    // coercion boundary, not as a special case below.
    let allows = 0;
    let denies = 0;
    let fails = 0;
    for (const el of outcomes) {
        const o = _coerceOutcome(el);
        if (o === LEAF.ALLOW) allows++;
        else if (o === LEAF.DENY) denies++;
        else fails++;
    }

    // ANY FAIL present -> incomplete -> deny. disagreement is FALSE here even
    // if both ALLOW and DENY are present, because the dominant reason is
    // incompleteness (a FAIL means an uncertain leaf, which is the load-
    // bearing signal). This matches the 2-leaf matrix: every FAIL-bearing row
    // has disagreement false regardless of the sibling leaf.
    if (fails > 0) {
        return {
            decision: "deny",
            audit: `tier-aggregate: deny (reason=incomplete leaves=${n} fails=${fails} allows=${allows} denies=${denies}${tidLabel})`,
            disagreement: false,
            incomplete: true,
        };
    }

    // No FAIL from here on. Any DENY -> deny. If any ALLOW is also present
    // -> disagreement true (ALLOW+DENY ambiguity among valid leaves = deny).
    if (denies > 0) {
        const disagreement = allows > 0;
        return {
            decision: "deny",
            audit: disagreement
                ? `tier-aggregate: deny (reason=disagreement leaves=${n} allows=${allows} denies=${denies}${tidLabel})`
                : `tier-aggregate: deny (reason=unanimous-deny leaves=${n} denies=${denies}${tidLabel})`,
            disagreement,
            incomplete: false,
        };
    }

    // No FAIL, no DENY -> all ALLOW (allows === n, and n >= 1). This is the
    // ONLY grant path. (allows cannot be 0 here because n >= 1 and the three
    // counts sum to n; with fails=0 and denies=0, allows must equal n >= 1.)
    return {
        decision: "allow",
        audit: `tier-aggregate: allow (leaves=${n} allows=${allows}${tidLabel})`,
        disagreement: false,
        incomplete: false,
    };
}

// ===========================================================================
// DUAL-PURPOSE SELF-TEST.
// Run directly (`node auto-gate-tiered.js` or `node --test auto-gate-tiered.js`)
// to execute the suite. Import as a module -> NO tests run. The guard is an
// explicit __filename comparison so an accidental import cannot fire the
// suite.
//
// No top-level await: tests register SYNCHRONOUSLY inside the guard so the
// module works under any loader (raw Node ESM, Bun, or a CJS-transpiling
// bundler). node:test + node:assert are imported statically at the top of the
// file; importing them is inert (the test runner only activates when `test()`
// is called or `--test` is passed).
// ===========================================================================
const __filename = fileURLToPath(import.meta.url);
const __isMain = path.resolve(process.argv[1] ?? "") === __filename;

if (__isMain) {
    // ===== LEAF constants =====

    test("LEAF: frozen enum with allow/deny/fail", () => {
        assert.equal(LEAF.ALLOW, "allow");
        assert.equal(LEAF.DENY, "deny");
        assert.equal(LEAF.FAIL, "fail");
        assert.throws(() => {
            "use strict";
            LEAF.ALLOW = "x";
        }, /read only|cannot set|assign/);
    });

    // ===== normalizeLeafOutcome — RAW -> enum mapping =====

    test("normalize: {decision:'allow'} -> ALLOW", () => {
        assert.equal(
            normalizeLeafOutcome({ decision: "allow", reason: "" }),
            LEAF.ALLOW,
        );
    });

    test("normalize: {decision:'block', reason} -> DENY", () => {
        assert.equal(
            normalizeLeafOutcome({ decision: "block", reason: "[x] y" }),
            LEAF.DENY,
        );
    });

    test("normalize: {status:'allow'} -> ALLOW (decidePermission shape)", () => {
        assert.equal(
            normalizeLeafOutcome({ status: "allow", reason: "" }),
            LEAF.ALLOW,
        );
    });

    test("normalize: {status:'deny'} -> DENY (decideLive shape)", () => {
        assert.equal(
            normalizeLeafOutcome({ status: "deny", audit: "blocked: x" }),
            LEAF.DENY,
        );
    });

    test("normalize: null -> FAIL (missing verdict)", () => {
        assert.equal(normalizeLeafOutcome(null), LEAF.FAIL);
    });

    test("normalize: undefined -> FAIL", () => {
        assert.equal(normalizeLeafOutcome(undefined), LEAF.FAIL);
    });

    test("normalize: Error instance -> FAIL (caught error passed in)", () => {
        assert.equal(normalizeLeafOutcome(new Error("boom")), LEAF.FAIL);
        // Error subclass also maps to FAIL.
        assert.equal(
            normalizeLeafOutcome(new TypeError("type boom")),
            LEAF.FAIL,
        );
    });

    test("normalize: malformed object (no decision/status) -> FAIL", () => {
        assert.equal(normalizeLeafOutcome({}), LEAF.FAIL);
        assert.equal(normalizeLeafOutcome({ foo: "bar" }), LEAF.FAIL);
        assert.equal(
            normalizeLeafOutcome({ decision: "allow", status: "deny" }),
            LEAF.ALLOW,
        ); // decision key takes precedence
    });

    test("normalize: unknown status 'ask' -> FAIL", () => {
        assert.equal(
            normalizeLeafOutcome({ status: "ask" }),
            LEAF.FAIL,
        );
    });

    test("normalize: unknown status 'maybe' -> FAIL", () => {
        assert.equal(
            normalizeLeafOutcome({ status: "maybe" }),
            LEAF.FAIL,
        );
    });

    test("normalize: non-object primitives -> FAIL", () => {
        // A bare string is NOT a valid RAW leaf result (the raw contract is a
        // verdict object or null); strings, numbers, booleans all fail.
        assert.equal(normalizeLeafOutcome("allow"), LEAF.FAIL);
        assert.equal(normalizeLeafOutcome(123), LEAF.FAIL);
        assert.equal(normalizeLeafOutcome(true), LEAF.FAIL);
    });

    test("normalize: decision key precedence over status", () => {
        // When BOTH are present, decision wins (parseVerdict contract).
        assert.equal(
            normalizeLeafOutcome({ decision: "block", status: "allow" }),
            LEAF.DENY,
        );
    });

    // ===== Exhaustive 2-leaf matrix (ALLOW/DENY/FAIL x ALLOW/DENY/FAIL) =====
    //
    // The canonical 9-combination table. disagreement is TRUE only for the
    // ALLOW+DENY / DENY+ALLOW rows (no FAIL, both dispositions present).
    // incomplete is TRUE for every row with a FAIL. The ONLY allow row is
    // ALLOW+ALLOW.
    const MATRIX = [
        // [l1, l2, expectedDecision, expectedDisagreement, expectedIncomplete]
        [LEAF.ALLOW, LEAF.ALLOW, "allow", false, false],
        [LEAF.ALLOW, LEAF.DENY, "deny", true, false],
        [LEAF.ALLOW, LEAF.FAIL, "deny", false, true],
        [LEAF.DENY, LEAF.ALLOW, "deny", true, false],
        [LEAF.DENY, LEAF.DENY, "deny", false, false],
        [LEAF.DENY, LEAF.FAIL, "deny", false, true],
        [LEAF.FAIL, LEAF.ALLOW, "deny", false, true],
        [LEAF.FAIL, LEAF.DENY, "deny", false, true],
        [LEAF.FAIL, LEAF.FAIL, "deny", false, true],
    ];

    for (const [l1, l2, exp, expDis, expInc] of MATRIX) {
        const name = `matrix(2-leaf): ${l1} + ${l2} -> decision=${exp} disagreement=${expDis} incomplete=${expInc}`;
        test(name, () => {
            const r = aggregateLeafOutcomes([l1, l2]);
            assert.equal(r.decision, exp, `decision for ${l1}+${l2}`);
            assert.equal(
                r.disagreement,
                expDis,
                `disagreement for ${l1}+${l2}`,
            );
            assert.equal(
                r.incomplete,
                expInc,
                `incomplete for ${l1}+${l2}`,
            );
        });
    }

    // ===== Edge / fail-closed =====

    test("edge: empty array -> deny (no leaves), not incomplete", () => {
        const r = aggregateLeafOutcomes([]);
        assert.equal(r.decision, "deny");
        assert.equal(r.incomplete, false);
        assert.equal(r.disagreement, false);
        assert.match(r.audit, /no-leaves/);
    });

    test("edge: single ALLOW -> allow (1-leaf tier is a valid grant path)", () => {
        const r = aggregateLeafOutcomes([LEAF.ALLOW]);
        assert.equal(r.decision, "allow");
        assert.equal(r.disagreement, false);
        assert.equal(r.incomplete, false);
    });

    test("edge: single DENY -> deny", () => {
        const r = aggregateLeafOutcomes([LEAF.DENY]);
        assert.equal(r.decision, "deny");
        assert.equal(r.disagreement, false);
        assert.equal(r.incomplete, false);
        assert.match(r.audit, /unanimous-deny/);
    });

    test("edge: single FAIL -> deny, incomplete", () => {
        const r = aggregateLeafOutcomes([LEAF.FAIL]);
        assert.equal(r.decision, "deny");
        assert.equal(r.incomplete, true);
        assert.equal(r.disagreement, false);
        assert.match(r.audit, /incomplete/);
    });

    test("edge: 3-leaf unanimous allow -> allow", () => {
        const r = aggregateLeafOutcomes([LEAF.ALLOW, LEAF.ALLOW, LEAF.ALLOW]);
        assert.equal(r.decision, "allow");
        assert.equal(r.disagreement, false);
        assert.equal(r.incomplete, false);
    });

    test("edge: 3-leaf with one deny mixed in -> deny, disagreement", () => {
        const r = aggregateLeafOutcomes([LEAF.ALLOW, LEAF.ALLOW, LEAF.DENY]);
        assert.equal(r.decision, "deny");
        assert.equal(r.disagreement, true);
        assert.equal(r.incomplete, false);
        assert.match(r.audit, /disagreement/);
    });

    test("edge: 3-leaf with one fail -> deny, incomplete", () => {
        const r = aggregateLeafOutcomes([LEAF.ALLOW, LEAF.ALLOW, LEAF.FAIL]);
        assert.equal(r.decision, "deny");
        assert.equal(r.incomplete, true);
        // disagreement is false even though 2 allows are present, because the
        // FAIL dominates (incomplete is the load-bearing signal).
        assert.equal(r.disagreement, false);
        assert.match(r.audit, /incomplete/);
    });

    test("edge: ALLOW + DENY + FAIL (3-way mix) -> deny, incomplete, disagreement false", () => {
        // Both a fail AND an allow/deny mix. incomplete dominates; the
        // disagreement flag is only set under no-FAIL (per the matrix rule).
        const r = aggregateLeafOutcomes([LEAF.ALLOW, LEAF.DENY, LEAF.FAIL]);
        assert.equal(r.decision, "deny");
        assert.equal(r.incomplete, true);
        assert.equal(r.disagreement, false);
    });

    // ===== {outcome, leafId} pair input form =====

    test("pair-form: {outcome:'allow'} elements aggregate like bare strings", () => {
        const r = aggregateLeafOutcomes([
            { outcome: LEAF.ALLOW, leafId: "leaf-1" },
            { outcome: LEAF.ALLOW, leafId: "leaf-2" },
        ]);
        assert.equal(r.decision, "allow");
    });

    test("pair-form: mixed bare + pair works (unanimous allow)", () => {
        const r = aggregateLeafOutcomes([
            LEAF.ALLOW,
            { outcome: LEAF.ALLOW, leafId: "x" },
        ]);
        assert.equal(r.decision, "allow");
    });

    // ===== Data resilience: unknown outcome values treated as FAIL =====

    test("resilience: unknown outcome string 'ask' in array -> treated as FAIL -> deny", () => {
        const r = aggregateLeafOutcomes([LEAF.ALLOW, "ask"]);
        assert.equal(r.decision, "deny");
        assert.equal(r.incomplete, true, "unknown string must count as FAIL");
    });

    test("resilience: unknown outcome string 'maybe' -> FAIL -> deny", () => {
        const r = aggregateLeafOutcomes(["maybe"]);
        assert.equal(r.decision, "deny");
        assert.equal(r.incomplete, true);
    });

    test("resilience: malformed element (number) -> FAIL -> deny", () => {
        const r = aggregateLeafOutcomes([LEAF.ALLOW, 42]);
        assert.equal(r.decision, "deny");
        assert.equal(r.incomplete, true);
    });

    test("resilience: malformed element ({outcome:123}) -> FAIL -> deny", () => {
        const r = aggregateLeafOutcomes([LEAF.ALLOW, { outcome: 123 }]);
        assert.equal(r.decision, "deny");
        assert.equal(r.incomplete, true);
    });

    test("resilience: {outcome:'allow'} with unknown sibling outcome -> deny", () => {
        const r = aggregateLeafOutcomes([
            { outcome: LEAF.ALLOW, leafId: "a" },
            { outcome: "wat", leafId: "b" },
        ]);
        assert.equal(r.decision, "deny");
        assert.equal(r.incomplete, true);
    });

    // ===== Non-array input -> throws (programmer-error assertion) =====

    test("assertion: non-array input throws TypeError (null)", () => {
        assert.throws(
            () => aggregateLeafOutcomes(null),
            (err) => err instanceof TypeError && /must be an array/.test(err.message),
        );
    });

    test("assertion: non-array input throws TypeError (undefined)", () => {
        assert.throws(
            () => aggregateLeafOutcomes(undefined),
            TypeError,
        );
    });

    test("assertion: non-array input throws TypeError (string)", () => {
        assert.throws(
            () => aggregateLeafOutcomes("allow"),
            TypeError,
        );
    });

    test("assertion: non-array input throws TypeError (object)", () => {
        assert.throws(
            () => aggregateLeafOutcomes({ outcome: LEAF.ALLOW }),
            TypeError,
        );
    });

    // ===== Purity / idempotency =====

    test("purity: aggregateLeafOutcomes does not mutate its input", () => {
        const input = [LEAF.ALLOW, LEAF.DENY, LEAF.FAIL];
        const snapshot = [input[0], input[1], input[2]];
        aggregateLeafOutcomes(input);
        assert.deepEqual(input, snapshot);
        assert.equal(input.length, 3);
    });

    test("purity: same input yields identical output (idempotent)", () => {
        const input = [LEAF.ALLOW, LEAF.ALLOW];
        const a = aggregateLeafOutcomes(input);
        const b = aggregateLeafOutcomes(input);
        assert.deepEqual(a, b);
    });

    // ===== opts.tierId audit labeling =====

    test("opts: tierId appears in audit when set", () => {
        const r = aggregateLeafOutcomes([LEAF.ALLOW], { tierId: "pilot" });
        assert.equal(r.decision, "allow");
        assert.match(r.audit, /tier=pilot/);
    });

    test("opts: no tierId -> audit has no tier= label", () => {
        const r = aggregateLeafOutcomes([LEAF.ALLOW]);
        assert.doesNotMatch(r.audit, /tier=/);
    });

    test("opts: leafIds values are NOT interpolated into audit (constant shape)", () => {
        // leafId values could carry operator content; only their COUNT may
        // surface (via the leaves=N tally), never the raw strings.
        const r = aggregateLeafOutcomes([
            { outcome: LEAF.ALLOW, leafId: "SECRET-LEAF-LABEL" },
        ]);
        assert.equal(
            r.audit.includes("SECRET-LEAF-LABEL"),
            false,
            "leafId value must not leak into the audit string",
        );
    });

    // ===== ONLY-allow-path invariant (meta-test over generated combos) =====
    //
    // For every combination of outcomes up to length 4 over the alphabet
    // {ALLOW, DENY, FAIL}, decision === "allow" IFF the array is non-empty AND
    // every element is ALLOW. This is the single safety invariant the whole
    // module exists to enforce; this meta-test pins it generically so a
    // future regression in the policy branches cannot sneak a spurious allow.

    test("invariant: decision==='allow' iff (non-empty AND all ALLOW) over all combos len 0..4", () => {
        const alpha = [LEAF.ALLOW, LEAF.DENY, LEAF.FAIL];
        // Enumerate all combos of length 0..4 (3^0 + 3^1 + 3^2 + 3^3 + 3^4 = 121).
        let checked = 0;
        for (let len = 0; len <= 4; len++) {
            // Iterate all len-tuples over alpha via a base-3 counter.
            const total = Math.pow(alpha.length, len);
            for (let code = 0; code < total; code++) {
                const combo = [];
                let c = code;
                for (let i = 0; i < len; i++) {
                    combo.push(alpha[c % alpha.length]);
                    c = Math.floor(c / alpha.length);
                }
                const r = aggregateLeafOutcomes(combo);
                const allAllow =
                    combo.length > 0 && combo.every((x) => x === LEAF.ALLOW);
                if (allAllow) {
                    assert.equal(
                        r.decision,
                        "allow",
                        `expected allow for all-ALLOW combo ${JSON.stringify(combo)}`,
                    );
                    assert.equal(r.incomplete, false);
                    assert.equal(r.disagreement, false);
                } else {
                    assert.equal(
                        r.decision,
                        "deny",
                        `expected deny for non-unanimous-allow combo ${JSON.stringify(combo)}`,
                    );
                }
                checked++;
            }
        }
        // Sanity: we actually enumerated (not a no-op loop).
        assert.ok(checked > 0, "meta-test must enumerate at least one combo");
    });
}
