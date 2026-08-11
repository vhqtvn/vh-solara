// rewrite-parity-validate.js — structural + stage validator for the
// rewrite-parity contract gate (OPT-D two-stage hybrid gate), JS mirror.
//
// This module is the JS mirror of rewrite-parity-validate.py (the REFERENCE
// implementation). The three implementations (python commit-gate, JS closeout,
// Go doctor) aim for structural-rule-equivalence against one frozen v1 schema.
// This JS mirror is pinned to all 9 golden fixtures under
// tests/fixtures/rewrite-parity/; the python reference and Go mirror cover the
// same structural rules via inline test cases. Cross-language fixture-driver
// parity is a tracked follow-up (defer-rp-fixture-parity), not a present claim.
//
// Pure module: NO filesystem access, NO network, NO side effects. It is a
// deterministic function of (contract, stage, context). That purity is
// load-bearing — it makes the closeout gate inspectable and testable in
// isolation. The integration glue (parse the closeout body, invoke, refuse or
// permit the transition) lives at the call site in state-lib.js.
//
// TWO STAGES (mirrors behavioral-closure's authority split):
//   Stage 1 (commit-gate, precommit): mechanical precheck with the tree in
//     hand. Implemented in PYTHON (commit-gate.sh invokes the .py); this JS
//     module ships validateRewriteParityPrecommit for test parity only.
//   Stage 2 (closeout transition, completion): every behavior proven with a
//     non-empty receipt (structural completeness; tree-binding honesty is
//     author + reviewer). This is what state-lib.js invokes to refuse
//     completion on planned/failed/skipped/not-demonstrable/missing-receipt.
//
// not-demonstrable -> inconclusive -> blocks completed (aligns behavioral-
// closure): a behavior whose verified seam cannot observe the outcome is
// not-demonstrable, which fails the completion gate and routes to defer.

const VALID_MODES = Object.freeze([
    "deletion_replacement",
    "modification_only_rewrite",
]);

const VALID_RESULTS = Object.freeze([
    "planned",
    "proven",
    "failed",
    "skipped",
    "not-demonstrable",
]);

// Matches a fenced ```rewrite-parity block, capturing the JSON body. The
// python reference uses the same DOTALL pattern.
const FENCE_RE = /```rewrite-parity[ \t]*\n([\s\S]*?)\n```/;

function neStr(x) {
    return typeof x === "string" && x.trim() !== "";
}

/**
 * Extract a contract from raw text. Tries raw JSON first, then the first
 * fenced ```rewrite-parity block. Returns { contract, error }.
 *
 * Mirrors extract_contract() in rewrite-parity-validate.py (the cross-language
 * binding is established by TestRewriteParityCrossLanguageConformance in Go).
 */
export function extractRewriteParityContract(rawText) {
    const raw = String(rawText || "").trim();
    if (raw === "") {
        return { contract: null, error: "empty contract input" };
    }
    // Try raw JSON.
    try {
        const obj = JSON.parse(raw);
        if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
            return { contract: obj, error: null };
        }
        return {
            contract: null,
            error:
                "contract JSON is not an object (got " +
                (Array.isArray(obj) ? "array" : typeof obj) +
                ")",
        };
    } catch (_e) {
        // Not raw JSON — fall through to fenced-block extraction.
    }
    const m = FENCE_RE.exec(raw);
    if (m) {
        try {
            return { contract: JSON.parse(m[1]), error: null };
        } catch (e) {
            return {
                contract: null,
                error:
                    "rewrite-parity fence found but its JSON is malformed: " +
                    e.message,
            };
        }
    }
    return {
        contract: null,
        error:
            "no rewrite-parity contract found (input is neither raw JSON nor a ```rewrite-parity fence)",
    };
}

/**
 * Extract ALL fenced ```rewrite-parity blocks from markdown text. Returns an
 * array of { contract, error } results, one per block found. Used by the
 * closeout transition to validate every contract declared in the closeout
 * body.
 */
export function extractAllRewriteParityBlocks(markdown) {
    const text = String(markdown || "");
    const results = [];
    // global regex to find every ```rewrite-parity block.
    const re = /```rewrite-parity[ \t]*\n([\s\S]*?)\n```/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        try {
            results.push({ contract: JSON.parse(m[1]), error: null });
        } catch (e) {
            results.push({
                contract: null,
                error:
                    "rewrite-parity fence found but its JSON is malformed: " +
                    e.message,
            });
        }
    }
    return results;
}

/**
 * Shared structural core (all stages). Returns an array of error strings.
 * Mirrors validate_structural() in rewrite-parity-validate.py.
 */
export function validateRewriteParityStructural(contract) {
    const errors = [];
    if (contract === null || typeof contract !== "object" || Array.isArray(contract)) {
        return ["contract must be a JSON object"];
    }

    if (contract.version !== 1) {
        errors.push("version must be 1 (got " + repr(contract.version) + ")");
    }
    if (!neStr(contract.applies)) {
        errors.push("applies must be a non-empty string");
    }
    if (!VALID_MODES.includes(contract.mode)) {
        errors.push(
            "mode must be one of " + JSON.stringify([...VALID_MODES]) +
            " (got " + repr(contract.mode) + ")",
        );
    }

    const ps = contract.prior_surface;
    if (ps === null || typeof ps !== "object" || Array.isArray(ps)) {
        errors.push("prior_surface must be an object");
    } else {
        if (!neStr(ps.id)) {
            errors.push("prior_surface.id must be a non-empty string");
        }
        if (!neStr(ps.revision)) {
            errors.push("prior_surface.revision must be a non-empty string");
        }
        const paths = ps.paths;
        if (!Array.isArray(paths) || paths.length === 0) {
            errors.push("prior_surface.paths must be a non-empty array");
        } else if (!paths.every((p) => neStr(p))) {
            errors.push("prior_surface.paths must be an array of non-empty strings");
        }
        if (typeof ps.inventory_complete !== "boolean") {
            errors.push("prior_surface.inventory_complete must be a boolean");
        }
    }

    let behaviors = contract.behaviors;
    if (!Array.isArray(behaviors) || behaviors.length === 0) {
        errors.push("behaviors must be a non-empty array");
        behaviors = [];
    }
    const seen = new Set();
    behaviors.forEach((b, i) => {
        const pfx = "behaviors[" + i + "]";
        if (b === null || typeof b !== "object" || Array.isArray(b)) {
            errors.push(pfx + " must be an object");
            return;
        }
        const bid = b.id;
        if (!neStr(bid)) {
            errors.push(pfx + ".id must be a non-empty string");
        } else if (seen.has(bid)) {
            errors.push(pfx + ".id " + JSON.stringify(bid) + " is duplicated within this contract");
        } else {
            seen.add(bid);
        }
        if (!neStr(b.description)) {
            errors.push(pfx + ".description must be a non-empty string");
        }
        const pe = b.prior_evidence;
        if (!Array.isArray(pe) || pe.length === 0) {
            errors.push(pfx + ".prior_evidence must be a non-empty array");
        } else if (!pe.every((e) => neStr(e))) {
            errors.push(pfx + ".prior_evidence must be an array of non-empty strings");
        }
        const ver = b.verifier;
        if (ver === null || typeof ver !== "object" || Array.isArray(ver)) {
            errors.push(pfx + ".verifier must be an object");
        } else {
            if (!neStr(ver.kind)) {
                errors.push(pfx + ".verifier.kind must be a non-empty string");
            }
            if (!neStr(ver.locator)) {
                errors.push(pfx + ".verifier.locator must be a non-empty string");
            }
        }
        const res = b.result;
        if (res === null || typeof res !== "object" || Array.isArray(res)) {
            errors.push(pfx + ".result must be an object");
        } else {
            if (!VALID_RESULTS.includes(res.status)) {
                errors.push(
                    pfx + ".result.status must be one of " +
                    JSON.stringify([...VALID_RESULTS]) +
                    " (got " + repr(res.status) + ")",
                );
            }
            for (const k of ["receipt", "note"]) {
                const v = res[k];
                if (v !== undefined && v !== null && !neStr(v)) {
                    errors.push(pfx + ".result." + k + " must be a non-empty string when present");
                }
            }
        }
    });
    return errors;
}

/**
 * Stage 2 (completion): structural + every-behavior-proven + receipt-present.
 * Mirrors validate_completion() in rewrite-parity-validate.py.
 */
export function validateRewriteParityCompletion(contract) {
    const errors = validateRewriteParityStructural(contract);
    if (errors.length) {
        return errors;
    }
    contract.behaviors.forEach((b, i) => {
        const pfx = "behaviors[" + i + "]";
        const res = b.result || {};
        const st = res.status;
        if (st !== "proven") {
            errors.push(
                pfx + ".result.status is " + JSON.stringify(st) +
                "; completion (status=completed) requires every behavior proven " +
                "(planned/failed/skipped/not-demonstrable block completion — " +
                "not-demonstrable routes to defer)",
            );
            return;
        }
        if (!neStr(res.receipt)) {
            errors.push(
                pfx + ".result.status is proven but result.receipt is missing or " +
                "empty (a non-empty receipt locator is required for a proven " +
                "behavior at completion; the tree-binding honesty is author + " +
                "reviewer, mirroring behavioral-closure)",
            );
        }
    });
    return errors;
}

/**
 * From [{status, path}] compute { removed: Set, modified: Set }.
 * removed = status D, or R-source (rename old path). modified = status M.
 * Renames arrive as status "Rxxx" with path "old\\tnew".
 * Mirrors _diff_sets() in rewrite-parity-validate.py.
 */
function diffSets(diffFiles) {
    const removed = new Set();
    const modified = new Set();
    for (const entry of diffFiles || []) {
        const s = String((entry && entry.status) || "");
        const p = String((entry && entry.path) || "");
        if (s.startsWith("R")) {
            const parts = p.split("\t", 1);
            if (parts.length && parts[0].trim()) {
                removed.add(parts[0].trim());
            }
        } else if (s === "D") {
            if (p.trim()) removed.add(p.trim());
        } else if (s === "M") {
            if (p.trim()) modified.add(p.trim());
        }
    }
    return { removed, modified };
}

/**
 * Stage 1 (precommit): structural + revision-binding + tree-bound cross-check.
 * Mirrors validate_precommit() in rewrite-parity-validate.py. Shipped for
 * test parity; the commit-gate invokes the python implementation directly.
 */
export function validateRewriteParityPrecommit(contract, diffFiles, headAtAcquire) {
    const errors = validateRewriteParityStructural(contract);
    if (errors.length) {
        return errors;
    }
    const ps = contract.prior_surface;
    const mode = contract.mode;
    const inv = ps.inventory_complete;
    const declared = new Set(ps.paths.map((p) => String(p).trim()));

    if (headAtAcquire && ps.revision && ps.revision !== headAtAcquire) {
        errors.push(
            "prior_surface.revision " + JSON.stringify(ps.revision) +
            " does not match head_at_acquire " + JSON.stringify(headAtAcquire),
        );
    }

    if (diffFiles !== undefined && diffFiles !== null) {
        const { removed, modified } = diffSets(diffFiles);
        const target = mode === "deletion_replacement" ? removed : modified;
        const label = mode === "deletion_replacement" ? "deleted" : "modified";
        if (inv) {
            const undeclared = [...target].filter((x) => !declared.has(x));
            const nontarget = [...declared].filter((x) => !target.has(x));
            if (undeclared.length) {
                errors.push(
                    "inventory_complete=true but " + undeclared.length + " " +
                    label + " path(s) are absent from prior_surface.paths " +
                    "(undeclared): " + JSON.stringify(undeclared.sort()),
                );
            }
            if (nontarget.length) {
                errors.push(
                    "inventory_complete=true but " + nontarget.length +
                    " declared prior_surface.path(s) are not " + label + ": " +
                    JSON.stringify(nontarget.sort()),
                );
            }
        } else {
            const nontarget = [...declared].filter((x) => !target.has(x));
            if (nontarget.length) {
                errors.push(
                    nontarget.length + " declared prior_surface.path(s) are not " +
                    label + ": " + JSON.stringify(nontarget.sort()),
                );
            }
        }
    }
    return errors;
}

// JSON.stringify-like repr for error messages (matches the python %r flavor).
function repr(v) {
    if (v === undefined) return "undefined";
    if (v === null) return "null";
    return JSON.stringify(v);
}

// Frozen vocab exports for tests and downstream consumers.
export const REWRITE_PARITY_VALID_MODES = Object.freeze([...VALID_MODES]);
export const REWRITE_PARITY_VALID_RESULTS = Object.freeze([...VALID_RESULTS]);
