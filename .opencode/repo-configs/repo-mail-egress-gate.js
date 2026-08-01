// repo-mail-egress-gate.js — GENERIC DOMAIN-FREE fail-closed egress gate over
// CANONICAL MESSAGE BYTES (platform_managed).
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ OWNERSHIP: platform_managed (generic core contract + logic).               │
// │ This file ships with the harness starter and is fully owned by it. It is    │
// │ DOMAIN-FREE: no vendor, no repo identity, no transport name, no endpoint.   │
// │ A consuming project MUST NOT edit this file — extend via the private deny-  │
// │ rules injected through the integration overlay (private config), never here.│
// └──────────────────────────────────────────────────────────────────────────┘
//
// ANONYMIZATION GUARANTEE (true strength): this gate is SHAPE-FAIL-CLOSED
// (URL / git-remote / email / path shapes are refused automatically) and checks
// STRUCTURED identifier fields for opaque-format compliance. It does NOT
// auto-anonymize free-text prose — a repo/org/person name, scheme-less host, or
// relative path in a body scalar is NOT caught here. Anonymizing arbitrary prose
// is NLP-hard. Per the protocol's per-channel sensitivity policy, prose-bearing
// or sensitive sends require operator-approve-send, which is enforced by the
// SENDER (not this gate). This gate is the automatic shape floor; it is not, and
// does not claim to be, the prose anonymizer.
//
// WHAT THIS IS — a fail-closed egress gate over canonical message bytes.
//
// The existing `forbidden-patterns` machinery (./forbidden-patterns.core.js +
// ./forbidden-patterns.project.js + ./forbidden-patterns.js aggregator) is
// COMMAND-ORIENTED: each rule is `{ id, re, allowIf, why }` where `re` tests a
// command string and `allowIf` carves out benign INSPECTOR forms (grep/echo/cat
// in command position). That carve-out is meaningless and dangerous over
// arbitrary message scalars — a URL or credential buried in a message body has
// no "inspector form" to excuse it. This module is the DOMAIN-FREE matcher
// EXTENSION over arbitrary message scalars (not just command strings): it runs
// deny-rules over the CANONICAL MESSAGE BYTES (deterministic serialization) and
// every scalar within. It performs these MECHANISMS (these are what the gate
// actually does — NOT "the anonymization guarantee"; see the ANONYMIZATION
// GUARANTEE block above for the true-strength statement):
//
//   1. shape-fail-closed detection (forbidden-patterns, generic + private-ext):
//      domain-free SHAPE deny-rules (endpoint-URL, git-remote, email-address,
//      absolute-path shapes) + the project's private identity shapes, run over
//      every scalar AND the canonical serialization. No allowIf carve-out —
//      every match on a message scalar is dangerous.
//   2. scrubCredentials any-mutation = REJECT: the shared scrub helper is used
//      as a DETECTOR, not a cleaner. If applying it would change a scalar, the
//      scalar carries credential-shaped content → REJECT. Transform-and-send is
//      PROHIBITED.
//   3. identifier-format checks on STRUCTURED fields only: the STRUCTURED
//      identifier fields (sender/recipient channel-id, channel-class, key-id)
//      may carry ONLY opaque-token identity — unknown field, invalid identifier
//      class, or readable-slug identifier → REJECT. This does NOT scan
//      free-text bodies (claims, limitations, evidence_refs prose, etc.) for
//      identifiers — those are prose and need operator-approve-send on
//      sensitive channels (see the ANONYMIZATION GUARANTEE block above).
//   4. fail-closed: any uncertainty (missing scrubCredentials dependency,
//      canonicalization failure, uncertain classification) → REJECT.
//
// THE LOAD-BEARING INVARIANT — REJECT-not-transform (the spine):
//
//   A message carrying a repo identifier / credential / endpoint is REFUSED,
//   never scrubbed-and-sent. The gate NEVER calls scrubCredentials to transform
//   the message; it uses it ONLY as a detector. The canonical bytes returned on
//   a PASS are the ORIGINAL unmodified serialization — byte-identity preserved.
//   On a REJECT, nothing is sent.
//
// This module has NO OpenCode coupling: no `server()`, no hooks, no I/O, no
// config reads, no side effects. It is a pure library imported by an
// integration overlay pack. It sits under repo-configs/ (NOT plugins/) so the
// OpenCode plugin loader does NOT scan it; it is loaded only via explicit
// import. The forbidden-patterns.* system — the matcher composition this
// extends — lives in the same directory.
//
// `scrubCredentials` is a DEPENDENCY-INJECTED function (not imported here) so
// this module stays domain-free AND layer-pure: templates/core/ never imports
// from an overlay pack (that would be a layering violation — overlays are
// optional and project-specific). The integration overlay injects the real
// scrubCredentials (from the shared scrub helper); the gate's self-test injects
// a stub for isolation.
//
// NON-ACTUATION BY CONSTRUCTION: this gate is a pure validator (pass/reject).
// It introduces NO actuation vocabulary — no delivery-rule schema, no
// session/task/work verbs. It only canonicalizes, detects, and renders a
// verdict.
//
// Naming: all identifiers GENERIC. No repo name, vendor, transport, or endpoint
// appears anywhere in this file.
//
// DUAL-PURPOSE SELF-TEST: like the shared scrub/verdict libraries, running this
// file directly (`node repo-mail-egress-gate.js` or
// `node --test repo-mail-egress-gate.js`) executes the node:test suite at the
// bottom; importing it as a module runs NO tests.

import { fileURLToPath } from "node:url";
import path from "node:path";
// node:test + node:assert imported STATICALLY (not dynamically) so the self-test
// registers SYNCHRONOUSLY when run directly, without any top-level await. INERT
// on the import path: importing them does not start a test runner — only the
// test() CALLS do, guarded behind __isMain so a consumer import never fires them.
import { test } from "node:test";
import { strict as assert } from "node:assert";

// ---------------------------------------------------------------------------
// Canonical serialization — deterministic bytes for digest/authenticator binding.
//
// The gate runs AFTER canonicalization and BEFORE any adapter. The digest +
// authenticator (bound elsewhere) bind to the EXACT bytes this produces.
// Determinism: recursively sorted object keys, no whitespace, stable across
// implementations. Node's JSON.stringify emits UTF-8 by default.
//
// sortKeysDeep is recursive: arrays preserve order (they ARE ordered sequences),
// objects get sorted keys. A non-finite number (NaN/Infinity) would serialize
// to `null` (JSON), which is acceptable — such values have no place in a
// message envelope anyway.
// ---------------------------------------------------------------------------

function sortKeysDeep(value) {
    if (Array.isArray(value)) return value.map(sortKeysDeep);
    if (value !== null && typeof value === "object") {
        const out = {};
        for (const k of Object.keys(value).sort()) {
            out[k] = sortKeysDeep(value[k]);
        }
        return out;
    }
    return value;
}

export function canonicalSerialize(message) {
    return JSON.stringify(sortKeysDeep(message));
}

// ---------------------------------------------------------------------------
// Scalar collection — every leaf string value in the message tree.
//
// The deny-rules and the scrubCredentials-mutation-check run over EACH scalar in
// isolation (in addition to the full canonical bytes). This catches a value
// whose dangerous content might be split, escaped, or contextualized across the
// JSON structure. Numbers and booleans are coerced to string so a numeric
// identifier is still scanned; null and undefined contribute nothing.
// ---------------------------------------------------------------------------

export function collectScalars(value, out = []) {
    if (typeof value === "string") {
        out.push(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
        out.push(String(value));
    } else if (Array.isArray(value)) {
        for (const v of value) collectScalars(v, out);
    } else if (value !== null && typeof value === "object") {
        for (const k of Object.keys(value)) collectScalars(value[k], out);
    }
    return out;
}

// ---------------------------------------------------------------------------
// GENERIC DOMAIN-FREE deny-rules — identity-leak SHAPE detectors.
//
// These detect GENERIC classes of identity leakage (endpoint URLs, git remotes,
// email addresses, filesystem paths revealing user/repo layout). They name NO
// specific repo, vendor, endpoint, or transport — only SHAPES. The PRIVATE
// extension (injected by the integration overlay from private config) adds the
// project's own repo name, feature names, and specific endpoints.
//
// RULE SHAPE (deliberately distinct from the command-oriented forbidden-patterns
// `{re, allowIf}` shape): `{ id, test: (text) => boolean, why }`. There is NO
// allowIf carve-out — over arbitrary message scalars, every match is dangerous.
// `test` is a predicate (not a raw regex) so a rule may compose multiple checks
// or carry precompiled regexes without exposing engine details.
//
// Residual risk: previously unknown aliases, encoded identity, or contextual
// descriptions may evade heuristic matching. A bare readable repo name (e.g.
// "myproject") with no URL/path/email context is NOT caught generically — the
// private extension exists for exactly that case. This is best-effort, not a
// proof.
// ---------------------------------------------------------------------------

const RE_ENDPOINT_URL = /\b(https?|ftp|wss?):\/\/\S+/i;
const RE_GIT_REMOTE_SSH = /\bgit@[^\s:]+:[^\s]/i;
// user@host:path — the SCP-like / git-SSH remote form. Must NOT match a bare
// email (no path after the host colon). The trailing `:[^\s]` requires a
// non-space after the colon (a path component), distinguishing git@host:repo
// from a bare user@host (no colon = not a remote).
const RE_SCP_LIKE_REMOTE = /\b[A-Za-z][A-Za-z0-9._-]*@[^\s:/]+:[^\s]/;
const RE_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
// /home/<user>/..., /Users/<user>/..., /root/<dir>... — reveals a system
// username and likely a repo location. Requires at least ONE path component
// after the home root (catches /Users/alice and /root/.config, not just deep
// paths). The leading boundary `(^|[^\w.])` avoids matching inside a longer
// word token (e.g. `myhome/bob`). `/workspace/...` does NOT match because
// `workspace` is not in the alternation.
const RE_HOME_DIR_PATH = /(^|[^\w.])\/(?:home|Users|root)\/[^\s/]+/;
const RE_WINDOWS_ABS_PATH = /\b[A-Za-z]:\\[^\s]/;

export const GENERIC_DENY_RULES = [
    {
        id: "endpoint-url",
        test: (text) => RE_ENDPOINT_URL.test(text),
        why:
            "Endpoint URL in message scalar — reveals a network endpoint " +
            "(anonymization binding-constraint #1 violation).",
    },
    {
        id: "git-remote-ssh",
        test: (text) => RE_GIT_REMOTE_SSH.test(text),
        why:
            "Git SSH remote (git@host:path) — reveals a repository endpoint " +
            "and likely a repo identity.",
    },
    {
        id: "scp-like-remote",
        test: (text) => RE_SCP_LIKE_REMOTE.test(text),
        why:
            "user@host:path remote form — reveals a repository/user endpoint " +
            "(SCP / git-SSH shape).",
    },
    {
        id: "email-address",
        test: (text) => RE_EMAIL.test(text),
        why:
            "Email address — identifies a person, which can re-identify a repo " +
            "or participant.",
    },
    {
        id: "home-dir-path",
        test: (text) => RE_HOME_DIR_PATH.test(text),
        why:
            "Absolute home-dir path — reveals a system username and likely a " +
            "repo location on disk.",
    },
    {
        id: "windows-abs-path",
        test: (text) => RE_WINDOWS_ABS_PATH.test(text),
        why:
            "Windows absolute path — reveals a filesystem layout that can " +
            "re-identify a repo or operator machine.",
    },
];

// ---------------------------------------------------------------------------
// Identifier allow-list — the closed envelope field set + opaque-identifier
// format constraints.
//
// The canonical envelope field schema defines a CLOSED top-level field set. Any
// field NOT in that set is an UNKNOWN FIELD → REJECT. The
// identifier-bearing fields (channel_id, channel_class, key_id) may carry ONLY
// opaque-token-shaped identity; a readable slug (e.g. a repo name in kebab-case)
// is an INVALID IDENTIFIER CLASS → REJECT.
//
// This is the anonymization-relevant SUBSET of the envelope schema. Full schema
// publication (required-field enforcement, kind semantics, claim-verification
// enums) is a separate concern; this gate validates PRESENT fields' formats and
// rejects UNKNOWN fields, but does not require presence of any field (a partial
// message under construction is still gate-checkable).
//
// IDENTIFIER FORMATS (domain-free, conservative):
//   - channel_id / key_id: opaque token — alnum/underscore/hyphen, 4–128 chars.
//     ADDITIONALLY rejected if it matches a READABLE MULTI-WORD SLUG
//     (^[a-z]+(-[a-z]+)+$, e.g. "my-cool-project") — that is the canonical repo-
//     name shape and is NOT opaque. A single-word lowercase token ("report") or
//     a token with digits/underscores/mixed-case ("ch_01", "ChAbC") passes.
//   - channel_class: a capability-class token — lowercase kebab/snake OK (it is
//     a TYPE, not an instance identity). No slug rejection here.
// ---------------------------------------------------------------------------

export const ALLOWED_TOP_LEVEL = Object.freeze(
    new Set([
        "schema_version",
        "message_id",
        "kind",
        "thread_id",
        "correlation_id",
        "in_reply_to",
        "provenance_class",
        "sender",
        "recipient",
        "contract_version_range",
        "issued_at",
        "expires_at",
        "sequence",
        "claims",
        "premises",
        "evidence_refs",
        "contradictions",
        "limitations",
        "presentation_request",
        "scrub",
        "integrity",
    ]),
);

export const ALLOWED_SENDER_FIELDS = Object.freeze(
    new Set(["channel_id", "channel_class", "key_id"]),
);
export const ALLOWED_RECIPIENT_FIELDS = Object.freeze(
    new Set(["channel_id", "channel_class"]),
);
export const ALLOWED_SCRUB_FIELDS = Object.freeze(
    new Set(["policy_version", "result"]),
);
export const ALLOWED_INTEGRITY_FIELDS = Object.freeze(
    new Set(["content_digest", "authenticator"]),
);

export const ALLOWED_KINDS = Object.freeze(
    new Set(["report", "reply", "design-question/RFC", "handoff"]),
);

// Opaque-token formats for instance identifiers.
export const IDENTIFIER_FORMATS = Object.freeze({
    channel_id: {
        re: /^[A-Za-z0-9_-]{4,128}$/,
        // A readable multi-word slug is the canonical repo-name shape — NOT opaque.
        slugRe: /^[a-z]+(-[a-z]+)+$/,
    },
    key_id: {
        re: /^[A-Za-z0-9_-]{4,128}$/,
        slugRe: /^[a-z]+(-[a-z]+)+$/,
    },
    // channel_class is a TYPE token (readable kebab OK — it is not instance identity).
    channel_class: {
        re: /^[a-z][a-z0-9_-]{0,63}$/,
        slugRe: null,
    },
});

// Validate a single identifier field value against its format. Returns a reason
// string on failure, or null on pass.
function validateIdentifier(fieldName, value) {
    const fmt = IDENTIFIER_FORMATS[fieldName];
    if (!fmt) return null; // not an identifier-bearing field — nothing to check
    if (typeof value !== "string") {
        return `identifier "${fieldName}" must be a string, got ${typeof value}`;
    }
    if (!fmt.re.test(value)) {
        return `identifier "${fieldName}" has invalid opaque-token format (must be ${fmt.re})`;
    }
    if (fmt.slugRe && fmt.slugRe.test(value)) {
        return `identifier "${fieldName}" is a readable slug ("${value}"), not an opaque token — resembles a repo name`;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Identifier allow-list check — structural validation of the message.
//
// Walks the message object and rejects:
//   - unknown top-level fields (not in ALLOWED_TOP_LEVEL),
//   - unknown sub-fields of sender/recipient/scrub/integrity,
//   - identifier fields (channel_id/channel_class/key_id) in invalid format,
//   - a `kind` value outside the closed ALLOWED_KINDS set,
//   - a missing or non-"passed" scrub.result (the send-authorization
//     attestation — see the scrub.result check at the end of this function).
//
// Returns an array of reason strings (empty = structurally clean). The gate is
// a PURE VALIDATOR: it does NOT set/stamp scrub.result. The sender supplies
// scrub.result="passed" as the send-authorization attestation; the gate
// REQUIRES it on the accept path.
// ---------------------------------------------------------------------------

function checkIdentifierAllowList(message) {
    const reasons = [];
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
        reasons.push("message root must be a plain object");
        return reasons;
    }
    for (const key of Object.keys(message)) {
        if (!ALLOWED_TOP_LEVEL.has(key)) {
            reasons.push(`unknown top-level field "${key}"`);
        }
    }
    // Nested object field-set checks + identifier format checks.
    const subSchemas = [
        ["sender", message.sender, ALLOWED_SENDER_FIELDS],
        ["recipient", message.recipient, ALLOWED_RECIPIENT_FIELDS],
        ["scrub", message.scrub, ALLOWED_SCRUB_FIELDS],
        ["integrity", message.integrity, ALLOWED_INTEGRITY_FIELDS],
    ];
    for (const [label, node, allowed] of subSchemas) {
        if (node === undefined) continue;
        if (node === null || typeof node !== "object" || Array.isArray(node)) {
            reasons.push(`field "${label}" must be a plain object`);
            continue;
        }
        for (const key of Object.keys(node)) {
            if (!allowed.has(key)) {
                reasons.push(`unknown sub-field "${label}.${key}"`);
            }
        }
    }
    // Identifier format validation.
    if (message.sender && typeof message.sender === "object") {
        for (const f of ["channel_id", "channel_class", "key_id"]) {
            if (message.sender[f] !== undefined) {
                const r = validateIdentifier(f, message.sender[f]);
                if (r) reasons.push(`sender.${r}`);
            }
        }
    }
    if (message.recipient && typeof message.recipient === "object") {
        for (const f of ["channel_id", "channel_class"]) {
            if (message.recipient[f] !== undefined) {
                const r = validateIdentifier(f, message.recipient[f]);
                if (r) reasons.push(`recipient.${r}`);
            }
        }
    }
    // kind closed-set.
    if (message.kind !== undefined && !ALLOWED_KINDS.has(message.kind)) {
        reasons.push(`kind "${message.kind}" not in closed set {report,reply,design-question/RFC,handoff}`);
    }
    // scrub.result send-authorization attestation: scrub.result must be
    // "passed"; absence or uncertainty prevents sending. The gate is a PURE
    // VALIDATOR — it does NOT stamp scrub.result. The sender supplies
    // scrub.result="passed"; the gate REQUIRES it on the accept path. This
    // composes with the ALLOWED_SCRUB_FIELDS sub-field check above (which
    // restricts scrub's keys to {policy_version, result}); it adds the VALUE
    // check for `result`. Absent scrub, non-object scrub, or any value other
    // than the exact string "passed" → REJECT.
    if (message.scrub === undefined) {
        reasons.push(
            `scrub.result must be "passed" for send authorization; got scrub absent`,
        );
    } else if (
        message.scrub === null ||
        typeof message.scrub !== "object" ||
        Array.isArray(message.scrub)
    ) {
        // The sub-field check above already pushed "field scrub must be a plain
        // object"; this adds the send-authorization framing so the rejection
        // cause is unambiguous.
        reasons.push(
            `scrub.result must be "passed" for send authorization; got scrub non-object`,
        );
    } else if (message.scrub.result !== "passed") {
        const got =
            message.scrub.result === undefined
                ? "absent"
                : JSON.stringify(message.scrub.result);
        reasons.push(
            `scrub.result must be "passed" for send authorization; got ${got}`,
        );
    }
    return reasons;
}

// ---------------------------------------------------------------------------
// THE GATE — gateEgressMessage(message, deps).
//
// Enforce order:
//   canonicalize → forbidden-patterns → scrubCredentials-mutation-check
//                → identifier-allow-list (incl. scrub.result="passed"
//                  send-authorization attestation) → pass/REJECT
//
// `deps`:
//   - scrubCredentials: function(text:string) => string. The shared scrub helper
//     (auto-gate-scrub.js), INJECTED by the integration overlay. Used as a
//     DETECTOR only: if scrubCredentials(scalar) !== scalar, the scalar carries
//     credential-shaped content → REJECT. The message is NEVER transformed.
//   - privateDenyRules: array of {id, test, why} — the project's private deny-
//     rules (repo name, feature names, specific endpoints). Composed on top of
//     GENERIC_DENY_RULES. Empty array is valid (generic-only).
//
// Returns:
//   {
//     verdict: "passed" | "rejected",
//     canonicalBytes: string | null,   // the deterministic serialization (null on canonicalization failure)
//     reasons: string[],               // empty on pass; each rejection cause on reject
//   }
//
// FAIL-CLOSED: every indeterminate path → rejected. A missing/non-function
// scrubCredentials dependency → rejected (the gate CANNOT verify without it).
// A canonicalization failure → rejected. ANY rule match, ANY scrub-mutation,
// ANY unknown field, ANY malformed deny-rule entry, OR a missing/non-"passed"
// scrub.result → rejected.
//
// VERIFY MODEL (scrub.result): the gate is a PURE
// VALIDATOR. It does NOT set/stamp scrub.result. The sender supplies
// scrub.result="passed" as the send-authorization attestation; the gate
// REQUIRES it (exact string) on the accept path. Absence or uncertainty
// prevents sending. The gate never mutates the message.
//
// REJECT-not-transform: on a PASS, canonicalBytes is the EXACT serialization of
// the unmodified message — byte-identity preserved to the adapter boundary. On
// a REJECT, the caller sends nothing. canonicalBytes is computed ONCE before
// the scrub check and is NEVER rewritten.
//
// All checks run to completion (reasons are COLLECTED, not short-circuited) so
// diagnostics are complete and the fail-closed guarantee holds even if one
// check has a bug — any single reason rejects. The reasons array order reflects
// the enforce priority (forbidden-patterns first, scrub-mutation second,
// allow-list third) for diagnostic clarity.
//
// NO-THROW GUARANTEE (structural — ONE outer fail-closed boundary): the entire
// gateEgressMessage body is wrapped in a single try/catch whose catch observes
// NOTHING off the thrown value (no err.message, no String(err), no property
// access) and returns a STATIC result {verdict:"rejected", canonicalBytes:null,
// reasons:["gate-internal-anomaly"]}. Any throw from anywhere inside evaluation
// (rule.test throw, getter throw, an inner catch that itself throws) → REJECT by
// construction. The catch's static-ness means a hostile thrown value
// (Proxy/Symbol.toPrimitive bomb, throwing getter on the error object) cannot
// make the catch itself throw — it observes nothing. Hostile-error-object
// hardening is OUT OF SCOPE: the boundary rejects regardless of what any error
// says or does. The gate's inputs are trusted-authoring messages + operator-
// config rules (malformable, NOT adversarial Proxy bombs); the inner try/catches
// below give PRECISE reasons on NORMAL failure modes, and if any of them itself
// throws on a hostile input, the outer boundary catches it. canonicalBytes:null
// on the anomaly path is correct (an anomaly = could not fully scrub = nothing
// sendable); the normal reject path still returns the original canonicalBytes
// (REJECT-not-transform preserved).
// ---------------------------------------------------------------------------

export function gateEgressMessage(message, deps) {
    // OUTER FAIL-CLOSED BOUNDARY — the load-bearing guarantee: the gate never
    // emits a message it could not fully scrub; any anomaly = REJECT. See the
    // NO-THROW GUARANTEE header above. The catch observes NOTHING off the thrown
    // value. The inner try/catches below give PRECISE reasons on normal failure
    // modes; if any of them itself throws on a hostile input, this outer boundary
    // catches it.
    try {
        const reasons = [];

        // --- Validate deps ---
        const scrubCredentials =
            deps && typeof deps.scrubCredentials === "function"
                ? deps.scrubCredentials
                : null;
        if (!scrubCredentials) {
            reasons.push(
                "scrubCredentials dependency not provided or not a function (cannot verify credential content — fail-closed)",
            );
        }
        const privateDenyRules =
            deps && Array.isArray(deps.privateDenyRules) ? deps.privateDenyRules : [];
        if (deps && deps.privateDenyRules !== undefined && !Array.isArray(deps.privateDenyRules)) {
            reasons.push("privateDenyRules must be an array if provided");
        }

        // --- 1. Canonicalize ---
        let canonicalBytes = null;
        try {
            canonicalBytes = canonicalSerialize(message);
        } catch (err) {
            reasons.push(
                `canonicalization failed: ${(err && err.message) || String(err)}`,
            );
            // Cannot run content checks without canonical bytes; return early.
            return { verdict: "rejected", canonicalBytes: null, reasons };
        }

        // Collect all scalars once (shared by forbidden-patterns + scrub-check).
        let scalars;
        try {
            scalars = collectScalars(message);
        } catch (err) {
            reasons.push(
                `scalar collection failed: ${(err && err.message) || String(err)}`,
            );
            scalars = [];
        }

        // --- 2. forbidden-patterns (generic + private) over canonical bytes + scalars ---
        //
        // Entry STRUCTURAL validation: a malformed entry (null / non-object
        // / missing `.test` / missing `.id`) → "malformed deny-rule entry" reason
        // and continue (never invoked). A throwing/stateful getter on an entry's
        // `.test`/`.id` simply throws → the outer fail-closed boundary catches
        // it (no inner hardening around the typeof checks). The per-rule
        // try/catch wraps the rule.test(text) call so a normally-throwing test
        // (e.g. a buggy predicate) is treated as a match → REJECT.
        const denyRules = [...GENERIC_DENY_RULES, ...privateDenyRules];
        const textsToScan = [canonicalBytes, ...scalars];
        for (const text of textsToScan) {
            if (typeof text !== "string") continue;
            for (const rule of denyRules) {
                if (
                    rule === null ||
                    typeof rule !== "object" ||
                    typeof rule.test !== "function" ||
                    typeof rule.id !== "string"
                ) {
                    const desc =
                        rule === null
                            ? "null"
                            : typeof rule !== "object"
                              ? typeof rule
                              : Array.isArray(rule)
                                ? "array"
                                : `object with keys [${Object.keys(rule).join(",")}]`;
                    reasons.push(
                        `malformed deny-rule entry: expected {id:string, test:function, why}, got ${desc} (fail-closed)`,
                    );
                    continue;
                }
                let matched = false;
                try {
                    matched = rule.test(text);
                } catch (err) {
                    reasons.push(
                        `deny-rule "${rule.id}" threw: ${(err && err.message) || String(err)} (treated as match — fail-closed)`,
                    );
                    matched = true; // a throwing rule is uncertain → treat as dirty
                }
                if (matched) {
                    reasons.push(`deny-rule "${rule.id}" matched`);
                }
            }
        }

        // --- 3. scrubCredentials mutation-check (DETECTOR only, never transform) ---
        if (scrubCredentials) {
            for (const scalar of scalars) {
                if (typeof scalar !== "string") continue;
                let scrubbed;
                try {
                    scrubbed = scrubCredentials(scalar);
                } catch (err) {
                    reasons.push(
                        `scrubCredentials threw on a scalar: ${(err && err.message) || String(err)} (treated as mutation — fail-closed)`,
                    );
                    continue; // a throwing scrubber is uncertain → reject (reason already added)
                }
                if (scrubbed !== scalar) {
                    reasons.push(
                        "scrubCredentials mutation detected — a scalar carries credential-shaped content (REJECT, not transform-and-send)",
                    );
                }
            }
        }

        // --- 4. identifier allow-list (structural) ---
        reasons.push(...checkIdentifierAllowList(message));

        // --- 5. verdict ---
        const verdict = reasons.length === 0 ? "passed" : "rejected";
        return { verdict, canonicalBytes, reasons };
    } catch (_err) {
        // OUTER FAIL-CLOSED BOUNDARY — the load-bearing guarantee.
        // This catch observes NOTHING off the error (no err.message, no String(err),
        // no property access) so a hostile thrown value (Proxy/Symbol.toPrimitive bomb,
        // throwing getter on the error object) cannot make this catch itself throw.
        // Hostile-error-object hardening is OUT OF SCOPE: the fail-closed boundary
        // rejects regardless of what any error says or does. Any anomaly inside
        // evaluation (rule.test throw, getter throw, an inner catch that itself
        // throws) → REJECT by construction.
        return {
            verdict: "rejected",
            canonicalBytes: null,
            reasons: ["gate-internal-anomaly"],
        };
    }
}

// ===========================================================================
// DUAL-PURPOSE SELF-TEST.
// Run directly (`node repo-mail-egress-gate.js` or
// `node --test repo-mail-egress-gate.js`) to execute the suite. Import as a
// module -> NO tests run. Guard is an explicit __filename comparison so an
// accidental import cannot fire the suite.
//
// These tests prove BOTH directions of the behavioral closure:
//   - DIRTY → rejected (repo id, credential, endpoint, unknown field, uncertain).
//   - CLEAN → passes (byte-identity of canonical bytes preserved on pass).
//
// They inject a STUB scrubCredentials (mirroring the real auto-gate-scrub.js
// contract: returns input unchanged for clean text; returns a different string
// when it detects credential shapes). The integration overlay's self-test
// proves the same directions with the REAL scrubCredentials.
// ===========================================================================
const __filename = fileURLToPath(import.meta.url);
const __isMain = path.resolve(process.argv[1] ?? "") === __filename;

// Stub scrubCredentials mirroring the REAL helper's contract for the
// mutation-check: clean text → unchanged (no mutation); credential-shaped text
// → different string (mutation detected). This stub is intentionally SIMPLER
// than the real one (it only needs to demonstrate the detector semantics); the
// integration self-test uses the real helper.
function stubScrub(text) {
    if (typeof text !== "string") return "";
    // Mirror the real helper's Bearer/api_key/high-entropy detection at a
    // minimal level sufficient to exercise the mutation-check.
    if (/\bBearer\s+\S+/i.test(text)) return text.replace(/\bBearer\s+\S+/i, "Bearer [redacted]");
    if (/api[_-]?key\s*[:=]\s*\S+/i.test(text)) return text.replace(/api[_-]?key\s*[:=]\s*\S+/i, "api_key=[redacted]");
    if (/[0-9a-f]{32,}/i.test(text)) return text.replace(/[0-9a-f]{32,}/i, "[redacted]");
    return text;
}

if (__isMain) {
    // ===== canonicalSerialize + collectScalars =====

    test("canonicalSerialize: sorted keys, no whitespace, stable", () => {
        const a = canonicalSerialize({ b: 2, a: 1, c: { z: 9, y: 8 } });
        const b = canonicalSerialize({ c: { y: 8, z: 9 }, a: 1, b: 2 });
        assert.equal(a, b, "key-order-independent inputs must produce identical bytes");
        assert.equal(a, `{"a":1,"b":2,"c":{"y":8,"z":9}}`);
    });

    test("canonicalSerialize: arrays preserve order", () => {
        assert.equal(canonicalSerialize({ x: [3, 1, 2] }), `{"x":[3,1,2]}`);
    });

    test("collectScalars: string leaves collected, numbers coerced", () => {
        const out = collectScalars({ a: "hi", b: 42, c: true, d: ["x", null, { e: "y" }] });
        assert.deepEqual(out, ["hi", "42", "true", "x", "y"]);
    });

    // ===== GENERIC_DENY_RULES: domain-free shape detectors =====

    test("deny-rule endpoint-url: detects http/https/ftp/wss URLs", () => {
        const rule = GENERIC_DENY_RULES.find((r) => r.id === "endpoint-url");
        assert.equal(rule.test("see https://api.example.com/v1"), true);
        assert.equal(rule.test("ftp://host/path"), true);
        assert.equal(rule.test("wss://socket.host/ws"), true);
        assert.equal(rule.test("plain text no url"), false);
    });

    test("deny-rule git-remote-ssh: detects git@host:path", () => {
        const rule = GENERIC_DENY_RULES.find((r) => r.id === "git-remote-ssh");
        assert.equal(rule.test("clone git@host.example:owner/repo.git"), true);
        assert.equal(rule.test("plain text"), false);
    });

    test("deny-rule scp-like-remote: detects user@host:path", () => {
        const rule = GENERIC_DENY_RULES.find((r) => r.id === "scp-like-remote");
        assert.equal(rule.test("deploy via bob@host:srv/app"), true);
        assert.equal(rule.test("email-only@example.com"), false, "bare email (no colon-path) is not a remote");
    });

    test("deny-rule email-address: detects email", () => {
        const rule = GENERIC_DENY_RULES.find((r) => r.id === "email-address");
        assert.equal(rule.test("contact alice@example.com please"), true);
        assert.equal(rule.test("no email here"), false);
    });

    test("deny-rule home-dir-path: detects /home/<user>/...", () => {
        const rule = GENERIC_DENY_RULES.find((r) => r.id === "home-dir-path");
        assert.equal(rule.test("log at /home/bob/repos/x"), true);
        assert.equal(rule.test("/Users/alice/code"), true);
        assert.equal(rule.test("/root/.config"), true);
        assert.equal(rule.test("/workspace/tmp/x"), false, "workspace/tmp is not home");
    });

    test("deny-rule windows-abs-path: detects C:\\...", () => {
        const rule = GENERIC_DENY_RULES.find((r) => r.id === "windows-abs-path");
        assert.equal(rule.test("built at C:\\Users\\bob\\code"), true);
        assert.equal(rule.test("no path"), false);
    });

    // ===== gateEgressMessage — DIRTY → rejected (the closeout crux, both directions) =====

    test("DIRTY (a) repo identifier as readable slug in channel_id → rejected", () => {
        const msg = {
            message_id: "msg_01",
            kind: "report",
            sender: { channel_id: "my-cool-project", channel_class: "report" },
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "rejected");
        assert.ok(
            res.reasons.some((r) => r.includes("channel_id") && r.includes("slug")),
            `reasons should name the slug identifier: ${JSON.stringify(res.reasons)}`,
        );
    });

    test("DIRTY (b) credential/API-key in a claim scalar → rejected (NOT scrubbed-and-sent)", () => {
        const msg = {
            message_id: "msg_02",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
            claims: [{ statement: "used api_key=sk-abcdefghijklmnopqrstuvwxyz123456 to verify" }],
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "rejected");
        // The mutation-check MUST fire: the scalar carries credential content.
        assert.ok(
            res.reasons.some((r) => r.includes("scrubCredentials mutation")),
            `reasons should include the scrub-mutation reason: ${JSON.stringify(res.reasons)}`,
        );
        // REJECT-not-transform proof: the returned canonical bytes are the
        // ORIGINAL serialization, unscrubbed. The credential is STILL in the
        // bytes (the message was refused, not cleaned).
        assert.ok(
            res.canonicalBytes.includes("sk-abcdefghijklmnopqrstuvwxyz123456"),
            "on REJECT the credential must remain in the (unsent) canonical bytes — proving REJECT-not-transform",
        );
    });

    test("DIRTY (b') Bearer token in a claim → rejected", () => {
        const msg = {
            message_id: "msg_02b",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
            claims: [{ statement: "header had Bearer eyJ0b2tlbj4.signature.payload" }],
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "rejected");
        assert.ok(res.reasons.some((r) => r.includes("scrubCredentials mutation")));
    });

    test("DIRTY (c) endpoint URL in a message scalar → rejected", () => {
        const msg = {
            message_id: "msg_03",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
            claims: [{ statement: "fetched https://internal.svc.example.net/debug" }],
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "rejected");
        assert.ok(
            res.reasons.some((r) => r.includes("endpoint-url")),
            `reasons should include the endpoint-url rule: ${JSON.stringify(res.reasons)}`,
        );
    });

    test("DIRTY (d) unknown/extra top-level field → rejected", () => {
        const msg = {
            message_id: "msg_04",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
            repo_full_name: "owner/secret-repo", // unknown field
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "rejected");
        assert.ok(
            res.reasons.some((r) => r.includes("unknown top-level field") && r.includes("repo_full_name")),
            `reasons should name the unknown field: ${JSON.stringify(res.reasons)}`,
        );
    });

    test("DIRTY (d') unknown sub-field under sender → rejected", () => {
        const msg = {
            message_id: "msg_04b",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report", real_email: "bob@x.com" },
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "rejected");
        assert.ok(res.reasons.some((r) => r.includes("sender.real_email")));
    });

    test("DIRTY (e) uncertain classification — missing scrubCredentials dependency → rejected (fail-closed)", () => {
        const msg = {
            message_id: "msg_05",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
        };
        // NO scrubCredentials provided — the gate cannot verify → fail-closed.
        const res = gateEgressMessage(msg, {});
        assert.equal(res.verdict, "rejected");
        assert.ok(
            res.reasons.some((r) => r.includes("scrubCredentials dependency not provided")),
            `reasons should name the missing dependency: ${JSON.stringify(res.reasons)}`,
        );
    });

    test("DIRTY (e') uncertain — scrubCredentials that throws on a scalar → rejected (fail-closed)", () => {
        const throwingScrub = () => { throw new Error("scrubber crash"); };
        const msg = {
            message_id: "msg_05b",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
            claims: [{ statement: "some text" }],
        };
        const res = gateEgressMessage(msg, { scrubCredentials: throwingScrub });
        assert.equal(res.verdict, "rejected");
        assert.ok(res.reasons.some((r) => r.includes("scrubCredentials threw")));
    });

    test("DIRTY — private deny-rule (repo name) match → rejected", () => {
        const msg = {
            message_id: "msg_06",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
            claims: [{ statement: "the secretrepo project has a bug" }],
        };
        const privateRules = [
            {
                id: "private-repo-name",
                test: (t) => /secretrepo/i.test(t),
                why: "private: project repo name",
            },
        ];
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub, privateDenyRules: privateRules });
        assert.equal(res.verdict, "rejected");
        assert.ok(res.reasons.some((r) => r.includes("private-repo-name")));
    });

    test("DIRTY — git SSH remote in evidence_refs → rejected", () => {
        const msg = {
            message_id: "msg_07",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
            evidence_refs: [{ ref: "git@host.example:owner/name.git" }],
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "rejected");
        assert.ok(
            res.reasons.some((r) => r.includes("git-remote-ssh") || r.includes("scp-like-remote")),
        );
    });

    test("DIRTY — invalid kind enum → rejected", () => {
        const msg = {
            message_id: "msg_08",
            kind: "execute-command", // not in the closed set
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "rejected");
        assert.ok(res.reasons.some((r) => r.includes("kind") && r.includes("execute-command")));
    });

    test("DIRTY — message root not an object → rejected", () => {
        const res = gateEgressMessage("not an object", { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "rejected");
        assert.ok(res.reasons.some((r) => r.includes("root must be a plain object")));
    });

    // ===== gateEgressMessage — CLEAN → passes (byte-identity preserved) =====

    test("CLEAN — well-formed anonymized message PASSES (byte-identity preserved on pass)", () => {
        const msg = {
            schema_version: "1",
            message_id: "msg_ok_01",
            kind: "report",
            thread_id: "thr_01",
            correlation_id: "corr_01",
            provenance_class: "ci",
            sender: { channel_id: "ch_abc123def", channel_class: "report", key_id: "key_01" },
            recipient: { channel_id: "ch_xyz789ghi", channel_class: "report" },
            contract_version_range: ">=1.0",
            issued_at: "2026-07-27T00:00:00Z",
            claims: [{ statement: "build passed with no identity-leaking content", confidence: "high" }],
            contradictions: ["none detected in checked scope"],
            limitations: ["sample size small"],
            presentation_request: { notify: true, priority: "normal" },
            scrub: { result: "passed" },
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "passed");
        assert.deepEqual(res.reasons, []);
        // Byte-identity proof: the canonical bytes returned by the gate are the
        // EXACT serialization of the unmodified message. The caller sends these
        // bytes unchanged to the adapter boundary.
        assert.equal(res.canonicalBytes, canonicalSerialize(msg));
        // And re-serializing produces the same bytes (deterministic).
        assert.equal(res.canonicalBytes, canonicalSerialize(JSON.parse(res.canonicalBytes)));
    });

    test("CLEAN — design-question/RFC kind with channel-class only passes", () => {
        const msg = {
            message_id: "msg_ok_02",
            kind: "design-question/RFC",
            sender: { channel_class: "rfc-channel" },
            recipient: { channel_class: "rfc-channel" },
            claims: [{ statement: "what is the canonical envelope for a reply?" }],
            scrub: { result: "passed" },
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "passed");
        assert.deepEqual(res.reasons, []);
    });

    test("CLEAN — reply with in_reply_to passes", () => {
        const msg = {
            message_id: "msg_ok_03",
            kind: "reply",
            in_reply_to: "msg_orig_01",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
            recipient: { channel_id: "ch_xyz789ghi", channel_class: "report" },
            claims: [{ statement: "confirmed — no identity leak" }],
            scrub: { result: "passed" },
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "passed");
    });

    test("CLEAN — minimal message (few fields) passes", () => {
        const msg = { message_id: "m", kind: "handoff", scrub: { result: "passed" } };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "passed");
        assert.deepEqual(res.reasons, []);
    });

    test("CLEAN — opaque channel_id with mixed case + digits passes (not a slug)", () => {
        const msg = {
            message_id: "msg_ok_04",
            kind: "report",
            sender: { channel_id: "ChAbC123def", channel_class: "report" },
            scrub: { result: "passed" },
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "passed");
    });

    // ===== REJECT-not-transform invariant — explicit proof =====

    test("REJECT-not-transform: a dirty message is REFUSED, never scrubbed-and-sent", () => {
        // A credential in a claim: scrubCredentials WOULD redact it, but the gate
        // uses that as REJECT evidence, never as a cleaner. The proof:
        //   1. verdict === "rejected" (refused).
        //   2. the canonical bytes still contain the ORIGINAL credential (not
        //      scrubbed) — proving the gate did NOT transform-and-forward.
        const credential = "api_key=sk-abcdefghijklmnopqrstuvwxyz123456";
        const msg = {
            message_id: "msg_rnt",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
            claims: [{ statement: `verified with ${credential}` }],
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "rejected");
        // The credential survives UNMODIFIED in the (unsent) canonical bytes.
        assert.ok(res.canonicalBytes.includes(credential));
        // The scrubbed form does NOT appear (the gate did not apply it).
        assert.ok(!res.canonicalBytes.includes("[redacted]"));
    });

    // ===== fail-closed edge cases =====

    test("fail-closed: non-function scrubCredentials → rejected", () => {
        const msg = { message_id: "m", kind: "report", sender: { channel_id: "ch_abc123def" } };
        const res = gateEgressMessage(msg, { scrubCredentials: "not a function" });
        assert.equal(res.verdict, "rejected");
        assert.ok(res.reasons.some((r) => r.includes("not a function")));
    });

    test("fail-closed: circular reference in message → rejected (canonicalize throws)", () => {
        const msg = { message_id: "m", kind: "report" };
        msg.self = msg; // circular
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "rejected");
        assert.equal(res.canonicalBytes, null);
        assert.ok(res.reasons.some((r) => r.includes("canonicalization failed")));
    });

    test("privateDenyRules not an array → rejected (fail-closed)", () => {
        const msg = { message_id: "m", kind: "report" };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub, privateDenyRules: "bad" });
        assert.equal(res.verdict, "rejected");
        assert.ok(res.reasons.some((r) => r.includes("privateDenyRules must be an array")));
    });

    // ===== fail-closed: malformed privateDenyRules ENTRIES =====
    //
    // The array-level deps check validates privateDenyRules IS an array but does
    // NOT reach into each entry. A malformed entry (null / non-object / missing
    // `.test` / missing `.id`) must NOT throw out of the gate — tier-1 entry
    // validation rejects it and contributes to the verdict. These tests prove NO
    // input can cause an exception to propagate: the test body itself would throw
    // if gateEgressMessage threw, so reaching the assertions is the no-throw proof.

    test("fail-closed: malformed privateDenyRules entry [null] → rejected, NO throw", () => {
        const msg = {
            message_id: "m_g1a",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub, privateDenyRules: [null] });
        assert.equal(res.verdict, "rejected");
        assert.ok(
            res.reasons.some((r) => r.includes("malformed deny-rule entry") && r.includes("null")),
            `reasons should name the malformed null entry: ${JSON.stringify(res.reasons)}`,
        );
    });

    test("fail-closed: malformed privateDenyRules entry [{id:'x'}] (missing .test) → rejected, NO throw", () => {
        const msg = {
            message_id: "m_g1b",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub, privateDenyRules: [{ id: "x" }] });
        assert.equal(res.verdict, "rejected");
        assert.ok(
            res.reasons.some((r) => r.includes("malformed deny-rule entry") && r.includes("object with keys [id]")),
            `reasons should name the malformed {id} entry: ${JSON.stringify(res.reasons)}`,
        );
    });

    test("fail-closed: malformed privateDenyRules entry [42] (non-object) → rejected, NO throw", () => {
        const msg = {
            message_id: "m_g1c",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub, privateDenyRules: [42] });
        assert.equal(res.verdict, "rejected");
        assert.ok(
            res.reasons.some((r) => r.includes("malformed deny-rule entry") && r.includes("number")),
            `reasons should name the malformed number entry: ${JSON.stringify(res.reasons)}`,
        );
    });

    // ===== OUTER BOUNDARY behavioral closure (no-throw-out proof) =====
    //
    // The no-throw guarantee is structural: ONE outer fail-closed try/catch
    // around the entire gateEgressMessage body, whose catch observes NOTHING off
    // the thrown value and returns a static {verdict:"rejected",
    // canonicalBytes:null, reasons:["gate-internal-anomaly"]}. These two tests
    // prove the behavioral crux: (a) a normally-throwing rule.test → REJECT (not
    // a throw-out); (d) a hostile thrown value (Proxy bomb) → REJECT, no
    // throw-out (proves the catch observes nothing and cannot be defeated by a
    // hostile error object). The test body reaching its assertions IS the
    // no-throw proof.

    test("outer boundary (a): rule.test throws → REJECT (not throw-out)", () => {
        const msg = {
            message_id: "m_ob_a",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
            scrub: { result: "passed" },
        };
        // A well-formed entry whose test() throws at call time. The per-rule
        // try/catch treats this as a match → REJECT with a precise reason.
        const res = gateEgressMessage(msg, {
            scrubCredentials: stubScrub,
            privateDenyRules: [{ id: "throwing-test", test: () => { throw new Error("test boom"); } }],
        });
        assert.equal(res.verdict, "rejected");
        assert.ok(
            res.reasons.some((r) => r.includes("throwing-test") && r.includes("threw")),
            `reasons should name the throwing rule: ${JSON.stringify(res.reasons)}`,
        );
    });

    test("outer boundary (d): hostile Proxy-bomb thrown value → REJECT, NO throw-out (catch observes nothing)", () => {
        const msg = {
            message_id: "m_ob_d",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
            scrub: { result: "passed" },
        };
        // A Proxy bomb: a value whose OWN property access re-throws. If the
        // outer catch observed anything off the thrown value (err.message,
        // String(err), etc.), accessing the bomb would re-throw and escape the
        // gate. The static catch (observes nothing) returns cleanly. The entry's
        // `.test` is a getter that throws the bomb at typeof-check time, so the
        // throw originates INSIDE evaluation and is caught by the outer boundary.
        const bomb = new Proxy({}, { get() { throw new Proxy({}, { get() { throw new Error("bomb"); } }); } });
        const entry = Object.defineProperty({ id: "bomb-rule" }, "test", { get() { throw bomb; } });
        const res = gateEgressMessage(msg, {
            scrubCredentials: stubScrub,
            privateDenyRules: [entry],
        });
        // KEY: the call returned (no throw-out). The static anomaly verdict.
        assert.equal(res.verdict, "rejected");
        assert.equal(res.canonicalBytes, null);
        assert.deepEqual(res.reasons, ["gate-internal-anomaly"]);
    });

    // ===== scrub.result send-authorization attestation =====
    //
    // The gate is a PURE VALIDATOR (verify model): it does NOT stamp scrub.result.
    // The sender supplies scrub.result="passed"; the gate REQUIRES it (exact
    // string) on the accept path. Absence or any other value → REJECT. These
    // tests prove the accept-path requirement and that the gate does NOT mutate
    // the message (verify model — canonicalBytes are the original, unmodified
    // serialization; no scrub.result is ever stamped by the gate).

    test("scrub.result send-authorization: absent scrub → rejected (required on accept path)", () => {
        const msg = {
            message_id: "m_f1a",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
            // scrub deliberately ABSENT — the gate must NOT auto-pass.
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "rejected");
        assert.ok(
            res.reasons.some((r) => r.includes("scrub.result must be") && r.includes("scrub absent")),
            `reasons should name the absent scrub: ${JSON.stringify(res.reasons)}`,
        );
        // VERIFY MODEL: the gate did NOT stamp scrub.result onto the message —
        // the canonical bytes are the EXACT original serialization (no scrub
        // field added). Proves the gate is a pure validator, not a mutator.
        assert.equal(res.canonicalBytes, canonicalSerialize(msg));
        assert.ok(!res.canonicalBytes.includes("scrub"));
    });

    test("scrub.result send-authorization: result=\"rejected\" → rejected", () => {
        const msg = {
            message_id: "m_f1b",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
            scrub: { result: "rejected" },
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "rejected");
        assert.ok(
            res.reasons.some((r) => r.includes("scrub.result must be") && r.includes('"rejected"')),
            `reasons should name the non-passed result: ${JSON.stringify(res.reasons)}`,
        );
    });

    test("scrub.result send-authorization: result=\"unknown\" → rejected", () => {
        const msg = {
            message_id: "m_f1c",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
            scrub: { result: "unknown" },
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "rejected");
        assert.ok(
            res.reasons.some((r) => r.includes("scrub.result must be") && r.includes('"unknown"')),
            `reasons should name the non-passed result: ${JSON.stringify(res.reasons)}`,
        );
    });

    test("scrub.result send-authorization: result key absent (scrub present) → rejected", () => {
        const msg = {
            message_id: "m_f1d",
            kind: "report",
            sender: { channel_id: "ch_abc123def", channel_class: "report" },
            scrub: { policy_version: "v1" }, // result key absent
        };
        const res = gateEgressMessage(msg, { scrubCredentials: stubScrub });
        assert.equal(res.verdict, "rejected");
        assert.ok(
            res.reasons.some((r) => r.includes("scrub.result must be") && r.includes("absent")),
            `reasons should name the absent result: ${JSON.stringify(res.reasons)}`,
        );
    });

    // ===== ABSOLUTE NO-THROW GUARANTEE section removed =====
    // The adversarial-getter tests (stateful getters, throwing getters on message
    // fields, Proxy deps, Proxy iterators) tested inner defenses that no longer
    // exist after the collapse to the single outer static-catch boundary. The
    // outer-boundary behavioral closure is now proven by tests (a) and (d) in
    // the OUTER BOUNDARY section above: (a) rule.test throws → REJECT; (d) a
    // hostile Proxy-bomb thrown value → static anomaly REJECT (proving the catch
    // observes nothing). All structural DIRTY/CLEAN/REJECT-not-transform tests
    // above are retained.
}
