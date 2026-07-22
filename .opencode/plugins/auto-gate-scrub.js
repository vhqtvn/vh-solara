// auto-gate-scrub.js — SHARED credential scrubber for ALL auto-gate egress paths.
//
// This is the SINGLE SOURCE OF TRUTH for credential scrubbing. It is imported
// by BOTH egress surfaces so they use the IDENTICAL scrubber with no drift:
//
//   auto-gate-live.js   — HTTP egress: serializeTranscript POSTs the scrubbed
//                         transcript to an external classifier model endpoint.
//   auto-tool-gate.js   — audit/stderr-log egress: summarizeArgs (tool.execute
//                         .before audit line) + the permission.ask audit lines
//                         write scrubbed tool-call-derived content to stderr.
//
// Why a shared module exists: the same credential-leak class was found on two
// different surfaces independently. The root cause was DRIFT — each surface had
// its own truncate-only handler. Centralizing the scrubber here means a future
// egress surface imports it once and cannot silently regress to truncate-only.
//
// It has NO OpenCode coupling: no `server()`, no hooks, no I/O, no config reads,
// no side effects. It mirrors the auto-gate-verdict.js precedent (a pure module
// that OpenCode tolerates as a non-plugin under .opencode/plugins/ because it
// has a NON-FUNCTION export — the `__autoGateLibrary` sentinel below — NOT
// merely because it lacks `server`; a module whose exports are ALL functions
// crashes the loader, see the loader-guard comment below for the full rule).
//
// Naming: all identifiers GENERIC. The upstream is referred to only as "the
// reference agent system" — never by product name.
//
// DUAL-PURPOSE SELF-TEST: like auto-gate-verdict.js / auto-gate-live.js, running
// this file directly (`node auto-gate-scrub.js` or `node --test auto-gate-scrub.js`)
// executes the node:test suite at the bottom; importing it as a module runs NO
// tests. The __isMain guard uses an explicit __filename comparison so an
// accidental import cannot fire the suite.

import { fileURLToPath } from "node:url";
import path from "node:path";
// node:test + node:assert imported STATICALLY (not dynamically) so the self-test
// registers SYNCHRONOUSLY when run directly, without any top-level await. These
// built-ins are INERT on the import path: importing them does not start a test
// runner and registers nothing — only the `test()` CALLS do, guarded behind
// __isMain so the consumer import path never fires them.
import { test } from "node:test";
import { strict as assert } from "node:assert";

// ---------------------------------------------------------------------------
// OpenCode plugin-loader guard — DO NOT REMOVE.
//
// OpenCode auto-loads EVERY module under .opencode/plugins/ and treats it as a
// plugin. A module with no `server` but whose exports are ALL functions gets
// each function invoked as a plugin factory; they return non-hook values and
// OpenCode then crashes calling `config`/`event`/`dispose` on them ("null is
// not an object") — a FATAL server error that stops OpenCode from starting.
// A single NON-FUNCTION export trips the loader's "export is not a function"
// guard, so the whole file is skipped as a non-plugin (non-fatal). The sibling
// pure-library modules (auto-gate-tiered.js `LEAF`, auto-gate-live.js prompt-key
// consts) are tolerated only because they happen to have such an export; this
// one's exports were all functions, so it needs an explicit sentinel.
export const __autoGateLibrary = "scrub";

// ---------------------------------------------------------------------------
// truncate(value, max) — plain truncation helper shared by both surfaces.
//
// Coerces non-strings to string. Appends "..." when the value exceeds max.
// Pure, no I/O. This is byte-identical to the former txTruncate (live) and
// truncate (tool-gate) helpers, now unified so both surfaces truncate the same
// way.
export function truncate(value, max) {
    if (typeof value !== "string") value = String(value);
    if (value.length <= max) return value;
    return value.slice(0, max) + "...";
}

// ---------------------------------------------------------------------------
// scrubCredentials(text) — pure credential-scrubber for in-transit text.
//
// Removes credential-shaped VALUES while preserving surrounding sentence
// context (a transcript-based classifier NEEDS conversation context to judge
// actions — scope-creep, injection). It does NOT redact text to nothing; it
// swaps matched secret values for [redacted] and leaves the surrounding words
// intact. Conservative by design: prefers false-positive redaction over
// false-negative leakage — a safety layer that redacts too much is acceptable;
//    one that leaks a credential is not.
//
// HEURISTIC LIMITS — this scrubber is a BEST-EFFORT heuristic, NOT a complete
// secret detector. It catches common secret-bearing shapes (Bearer tokens,
// key=value / key: value pairs, whitespace-separated secret CLI flags incl.
// quoted/escaped values, standalone high-entropy blobs) but CANNOT catch
// every secret-bearing input. Known gaps include base64-encoded secret
// payloads, secrets referenced only by env-var name, and custom/non-standard
// flag names outside the recognized set. Remaining narrow edge cases are
// ACCEPTED heuristic limits, not bugs. For environments requiring stronger
// guarantees, operators should avoid audit mode for secret-bearing commands
// or route them through `promptFile` instead.
//
// Patterns (applied in order, each a global case-insensitive replace):
//   1. Bearer tokens — `Bearer <token>` (covers header-style
//      `Authorization: Bearer ...`) -> `Bearer [redacted]`.
//   2. Key=value / Key: value where the key names a secret (api_key / apikey /
//      api-key / access_key / access_token / secret / password / passwd / pwd /
//      token / authorization / auth) and the value is secret-shaped — a quoted
//      string (any length) or a 12+ char run of alnum/_-./+=, or an
//      sk-/AKIA-prefixed token. The VALUE is redacted; the key name + separator
//      is kept so surrounding context survives.
//   3. Whitespace-separated secret-bearing CLI flags — `--password hunter2`,
//      `--token xyz`, `--api-key abc`, `-p secret`, etc. The flag name is kept
//      and the following whitespace-separated VALUE token is redacted. Runs
//      BEFORE the standalone-blob rules so a flag whose value is itself a
//      high-entropy blob (e.g. `--password <40-hex>`) is caught here as
//      `--password [redacted]` (flag survives) rather than being reduced to a
//      bare `[redacted]` by the blob rules.
//   4. Standalone high-entropy blobs — 32+ hex chars, 40+ base64-ish chars
//      (alnum + / + +, optional =padding), or bare sk-/AKIA-prefixed keys.
//      -> [redacted].
//
// Pure, no I/O. Composed with truncate as scrub-then-truncate (scrubTruncate
// below) so a secret split across the truncation boundary is still caught.
export function scrubCredentials(text) {
    if (typeof text !== "string") return "";
    let out = text;

    // 1. Bearer <token> — keep the word "Bearer", redact the token after it.
    //    Covers `Authorization: Bearer ...` and a bare `Bearer ...`.
    out = out.replace(/\b(bearer)\s+(\S+)/gi, "$1 [redacted]");

    // 2. Key=value / Key: value where the key names a secret.
    const secretKey =
        "api[_-]?key|apikey|access[_-]?(?:key|token)|secret|password|passwd|pwd|token|authorization|auth";
    // 2a. Quoted values (any length — conservative): key="..." / key: '...'
    out = out.replace(
        new RegExp(`(${secretKey})\\s*[:=]\\s*("[^"]*"|'[^']*')`, "gi"),
        "$1=[redacted]",
    );
    // 2b. Unquoted secret-shaped values: a 12+ char alnum run, or an
    //     sk-/AKIA-prefixed token.
    out = out.replace(
        new RegExp(
            `(${secretKey})\\s*[:=]\\s*([A-Za-z0-9][A-Za-z0-9_.\\-/+=]{11,}|sk-[A-Za-z0-9_\\-]{8,}|AKIA[0-9A-Z]{8,})`,
            "gi",
        ),
        "$1=[redacted]",
    );

    // 3. Whitespace-separated secret-bearing CLI flags: --password hunter2,
    //    --token xyz, --api-key abc, -p secret, etc. Keep the flag name; redact
    //    the following value. The value capture tries a COMPLETELY-QUOTED value
    //    ("hunter two" or 'secret value') FIRST — capturing the whole quoted
    //    run including its internal spaces — and only falls back to a bare
    //    \S+ token when there is no leading quote. This is essential: a naive
    //    \S+-only capture would stop at the first space and leak the post-space
    //    tail of a quoted credential (e.g. `--password "hunter two"` would
    //    become `--password [redacted] two"`, leaking `two"`).
    //
    //    ESCAPE-AWARE QUOTED MATCHING: the quoted alternatives use
    //    "(?:[^"\\]|\\.)*" / '(?:[^'\\]|\\.)*' so an escaped quote INSIDE a
    //    quoted value (`\"` / `\'`) is consumed as an escaped pair rather than
    //    treated as the closing delimiter. Without this, `--password
    //    "secret\"tail value"` would match only `"secret\"` and leak
    //    `tail value"`. The body `(?:[^"\\]|\\.)*` matches either a non-quote
    //    non-backslash char OR a backslash-escaped pair (any char following a
    //    backslash, including `\"` / `\\`).
    //
    //    BARE-VALUE NEGATIVE LOOKAHEAD (bare alternative ONLY): the bare
    //    alternative is `(?!-{1,2})\S+` — a negative lookahead that REJECTS a
    //    bare value beginning with `-` or `--`. Without it, a bare `\S+` would
    //    happily consume the NEXT flag as though it were the preceding flag's
    //    value: `--token --api-key sk_live_abc` would eat `--api-key` as
    //    `--token`'s value, leaving `sk_live_abc` UNREDACTED (the `sk_` form
    //    is not matched by the standalone sk-/AKIA/blob rules below because it
    //    uses an underscore, not a dash). With the lookahead, the bare match
    //    fails at `--api-key`, the regex moves on, and `--api-key` is then
    //    recognized as a flag in its own right with `sk_live_abc` redacted as
    //    its value. CRITICAL: the lookahead is confined to the bare alternative
    //    ONLY — it is NOT placed ahead of the quoted alternatives, so a quoted
    //    value that legitimately begins with dashes (e.g. `--token
    //    "--dashed-value"`) is still redacted by the quoted branch.
    //
    //    The `--?` (one or two dashes) is wrapped in a non-capturing group
    //    with the name alternation so it applies to EVERY alternative —
    //    without it, alternation precedence would bind `--?` only to
    //    `password`, leaving `--token`/`--api-key`/`-p` to match as bare
    //    names with the dashes orphaned as prefix text. The short form `p`
    //    is listed LAST so the longer `pass`/`passwd`/`pwd` alternatives are
    //    tried first (ordered alternation + backtracking). A regex LITERAL is
    //    used (not `new RegExp(string)`) so the backslashes in the escape-aware
    //    value group are single-escaped (engine-native) rather than
    //    double-escaped (string-then-regex), avoiding the `\\\\` readability
    //    hazard. Placed BEFORE the standalone-blob rules below so a flag value
    //    that is itself a 32+ hex / 40+ base64 / sk- / AKIA blob is caught here
    //    (flag name survives) rather than being reduced to a bare `[redacted]`
    //    by the blob rules.
    out = out.replace(
        /(--?(?:password|pass|passwd|pwd|token|api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|auth|authorization|credential|private[_-]?key|p))\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?!-{1,2})\S+)/gi,
        "$1 [redacted]",
    );

    // 4. Standalone high-entropy blobs (not preceded by a recognized key).
    //    32+ hex chars.
    out = out.replace(/[0-9a-f]{32,}/gi, "[redacted]");
    //    40+ base64-ish chars (alnum + / + +, optional = padding).
    out = out.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[redacted]");
    //    Bare sk-prefixed keys.
    out = out.replace(/\bsk-[A-Za-z0-9_\-]{8,}/g, "[redacted]");
    //    Bare AKIA-prefixed AWS keys.
    out = out.replace(/\bAKIA[0-9A-Z]{12,}/g, "[redacted]");

    return out;
}

// ---------------------------------------------------------------------------
// scrubTruncate(value, max) — scrub-then-truncate. Secrets are removed BEFORE
// truncation so a value split across the truncation boundary cannot survive in
// part. This is the egress-safe form: every field that lands on an external
// surface (HTTP POST to a model, OR a stderr/log write) passes through
// scrubTruncate, NOT truncate alone.
//
// Byte-identical to the former live-module txScrub (scrubCredentials then
// txTruncate). Both egress surfaces now share this ONE implementation.
export function scrubTruncate(value, max) {
    return truncate(scrubCredentials(value), max);
}

// ===========================================================================
// DUAL-PURPOSE SELF-TEST.
// Run directly (`node auto-gate-scrub.js` or `node --test auto-gate-scrub.js`)
// to execute the suite. Import as a module -> NO tests run. Guard is an
// explicit __filename comparison so an accidental import cannot fire the suite.
// ===========================================================================
const __filename = fileURLToPath(import.meta.url);
const __isMain = path.resolve(process.argv[1] ?? "") === __filename;

if (__isMain) {
    // ===== scrubCredentials: pure exported function =====

    test("scrub: non-string returns empty string", () => {
        assert.equal(scrubCredentials(123), "");
        assert.equal(scrubCredentials(null), "");
        assert.equal(scrubCredentials(undefined), "");
        assert.equal(scrubCredentials({}), "");
    });

    test("scrub: no secrets -> unchanged", () => {
        assert.equal(scrubCredentials("no secrets here"), "no secrets here");
        assert.equal(scrubCredentials("rm -rf tmp/"), "rm -rf tmp/");
    });

    test("scrub: Bearer token -> Bearer [redacted]", () => {
        assert.equal(
            scrubCredentials("Bearer eyJ0b2tlbj4.signature"),
            "Bearer [redacted]",
        );
    });

    test("scrub: api_key=value -> api_key=[redacted]", () => {
        assert.equal(
            scrubCredentials("api_key=sk-abcdefghijklmnopqrstuvwxyz123456"),
            "api_key=[redacted]",
        );
    });

    test("scrub: bearer case-insensitive", () => {
        assert.equal(
            scrubCredentials("bearer abc123def456ghi789jkl012mno345pqr789"),
            "bearer [redacted]",
        );
    });

    test("scrub: secret key:value with colon separator", () => {
        assert.equal(
            scrubCredentials("password: hunter2supersecretvalue1234567890"),
            "password=[redacted]",
        );
    });

    test("scrub: quoted value redacted (any length, conservative)", () => {
        assert.equal(
            scrubCredentials('token="short"'),
            "token=[redacted]",
        );
    });

    test("scrub: 40+ char hex blob -> [redacted]", () => {
        const hex = "0123456789abcdef0123456789abcdef01234567";
        assert.equal(
            scrubCredentials(`blob ${hex}`),
            "blob [redacted]",
        );
    });

    test("scrub: bare sk-prefixed key -> [redacted]", () => {
        assert.equal(
            scrubCredentials("sk-abcdefghijklmnopqrstuvwxyz123456"),
            "[redacted]",
        );
    });

    test("scrub: bare AKIA AWS key -> [redacted]", () => {
        assert.equal(
            scrubCredentials("AKIAABCDEFGHIJKLMNOP"),
            "[redacted]",
        );
    });

    test("scrub: surrounding context preserved", () => {
        const out = scrubCredentials(
            "ran curl with header Authorization: Bearer sk-deadbeefcafef00dbaadf00dcafebabe1234 against the api",
        );
        assert.match(out, /Bearer \[redacted\]/);
        assert.match(out, /against the api/);
    });

    test("scrub: idempotent (scrubbing scrubbed output is a no-op)", () => {
        const once = scrubCredentials(
            "api_key=sk-abcdefghijklmnopqrstuvwxyz123456 and Bearer jwt1234567890jwt1234567890jwt1234567890",
        );
        const twice = scrubCredentials(once);
        assert.equal(once, twice);
    });

    // ===== scrubCredentials: whitespace-separated CLI flag form =====

    test("scrub: --password flag form redacted", () => {
        const out = scrubCredentials("curl --password hunter2 https://x");
        assert.match(out, /--password \[redacted\]/);
        assert.equal(out.includes("hunter2"), false);
    });

    test("scrub: --token flag form redacted", () => {
        const out = scrubCredentials("--token abc-123-xyz");
        assert.equal(out, "--token [redacted]");
        assert.equal(out.includes("abc-123-xyz"), false);
    });

    test("scrub: --api-key flag form redacted", () => {
        const out = scrubCredentials("--api-key sk_live_abc");
        assert.equal(out, "--api-key [redacted]");
        assert.equal(out.includes("sk_live_abc"), false);
    });

    test('scrub: --password "hunter two" (quoted whitespace value) fully redacted', () => {
        const out = scrubCredentials('--password "hunter two"');
        assert.match(out, /--password \[redacted\]/);
        assert.equal(out.includes('two"'), false);
        assert.equal(out.includes("hunter"), false);
    });

    test("scrub: --token 'secret value' (single-quoted) fully redacted", () => {
        const out = scrubCredentials("--token 'secret value'");
        assert.match(out, /--token \[redacted\]/);
        assert.equal(out.includes("value"), false);
        assert.equal(out.includes("secret"), false);
    });

    test('scrub: --password "secret\\"tail value" (escaped double-quote) fully redacted', () => {
        const out = scrubCredentials('--password "secret\\"tail value"');
        assert.match(out, /--password \[redacted\]/);
        assert.equal(out.includes("tail value"), false);
        assert.equal(out.includes("secret"), false);
    });

    test("scrub: --token 'a\\'b c' (escaped single-quote) fully redacted", () => {
        const out = scrubCredentials("--token 'a\\'b c'");
        assert.match(out, /--token \[redacted\]/);
        assert.equal(out.includes("b c"), false);
        assert.equal(out.includes("\\'"), false);
    });

    test("scrub: short flag -p (single dash) redacted", () => {
        const out = scrubCredentials("-p secret123");
        assert.equal(out, "-p [redacted]");
        assert.equal(out.includes("secret123"), false);
    });

    test("scrub: flag value that is ALSO a high-entropy blob -> flag rule wins (flag kept, value redacted)", () => {
        const out = scrubCredentials(
            "--password 0123456789abcdef0123456789abcdef01234567",
        );
        // The flag name MUST survive (not reduced to a bare [redacted]).
        assert.match(out, /--password \[redacted\]/);
        assert.notEqual(out, "[redacted]");
        assert.equal(
            out.includes("0123456789abcdef0123456789abcdef01234567"),
            false,
        );
    });

    test("scrub: non-secret flag NOT redacted (regression)", () => {
        // --verbose is not in the secret-flag set; value must survive unchanged.
        const out = scrubCredentials("--verbose output.txt");
        assert.equal(out, "--verbose output.txt");
    });

    // ===== scrubCredentials: bare-value negative lookahead (consecutive flags) =====
    //
    // The bare-value alternative carries `(?!-{1,2})` so a following flag is NOT
    // mis-consumed as the preceding flag's value (which would leak the real
    // value). These cases pin that behavior.

    test("scrub: consecutive long secret flags -- next flag not consumed as value", () => {
        // Without the bare-value negative lookahead, `--api-key` would be eaten
        // as `--token`'s value, leaving `sk_live_abc` UNREDACTED (the `sk_`
        // underscore form is not matched by the standalone sk-/AKIA/blob rules
        // below).
        const out = scrubCredentials("--token --api-key sk_live_abc");
        assert.match(out, /--api-key \[redacted\]/);
        assert.equal(out.includes("sk_live_abc"), false);
    });

    test("scrub: consecutive short/long flags -- next flag not consumed as value", () => {
        // `-p --password hunter2`: `--password` must NOT be consumed as `-p`'s
        // value; `hunter2` must be redacted.
        const out = scrubCredentials("-p --password hunter2");
        assert.match(out, /--password \[redacted\]/);
        assert.equal(out.includes("hunter2"), false);
    });

    test("scrub: multiple secret flags with ordinary values (regression control)", () => {
        // `--token plain --api-key sk_live_abc`: both values redacted as before.
        const out = scrubCredentials("--token plain --api-key sk_live_abc");
        assert.match(out, /--token \[redacted\]/);
        assert.match(out, /--api-key \[redacted\]/);
        assert.equal(out.includes("plain"), false);
        assert.equal(out.includes("sk_live_abc"), false);
    });

    test("scrub: quoted dashed value still redacted (lookahead is bare-only)", () => {
        // The negative lookahead lives on the BARE alternative ONLY; a quoted
        // value that legitimately begins with dashes MUST still be redacted by
        // the quoted branch.
        const out = scrubCredentials('--token "--dashed-value"');
        assert.match(out, /--token \[redacted\]/);
        assert.equal(out.includes("--dashed-value"), false);
    });

    test("scrub: consecutive-flag scrubbing is idempotent", () => {
        const inputs = [
            "--token --api-key sk_live_abc",
            "-p --password hunter2",
            "--token plain --api-key sk_live_abc",
            '--token "--dashed-value"',
        ];
        for (const input of inputs) {
            const once = scrubCredentials(input);
            const twice = scrubCredentials(once);
            assert.equal(once, twice, "must be idempotent for: " + input);
        }
    });

    test("scrub: flag-form rules are idempotent and pure (input not mutated)", () => {
        const inputs = [
            "curl --password hunter2 https://x",
            "--token abc-123-xyz",
            "--api-key sk_live_abc",
            "-p secret123",
            "--password 0123456789abcdef0123456789abcdef01234567",
            "--verbose output.txt",
            "--token --api-key sk_live_abc",
            "-p --password hunter2",
            "--token plain --api-key sk_live_abc",
            '--token "--dashed-value"',
        ];
        for (const input of inputs) {
            const snapshot = input; // strings are immutable; capture for clarity
            const once = scrubCredentials(input);
            const twice = scrubCredentials(once);
            assert.equal(once, twice, "must be idempotent for: " + input);
            assert.equal(input, snapshot, "input must not be mutated: " + input);
        }
    });

    // ===== truncate =====

    test("truncate: short value unchanged", () => {
        assert.equal(truncate("hi", 10), "hi");
    });

    test("truncate: long value cut with ellipsis", () => {
        assert.equal(truncate("abcdefghij", 5), "abcde...");
    });

    test("truncate: non-string coerced to string", () => {
        assert.equal(truncate(123, 10), "123");
    });

    test("truncate: exact length unchanged", () => {
        assert.equal(truncate("abcde", 5), "abcde");
    });

    // ===== scrubTruncate: scrub-then-truncate (egress-safe form) =====

    test("scrubTruncate: secret removed before truncation (boundary-safe)", () => {
        // A long secret-bearing string: the secret must NOT survive even in part
        // across the truncation boundary.
        const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
        const cmd = `curl -H "Authorization: Bearer ${secret}" https://api.example/v1/long/path`;
        const out = scrubTruncate(cmd, 30);
        assert.equal(
            out.includes(secret),
            false,
            "secret must not survive scrubTruncate",
        );
    });

    test("scrubTruncate: non-secret long value truncated (not redacted)", () => {
        const phrase = "the quick brown fox jumps over the lazy dog";
        const out = scrubTruncate(phrase, 10);
        assert.equal(out, "the quick ...");
    });

    test("scrubTruncate: Bearer jwt in a command is redacted", () => {
        const jwt =
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
        const out = scrubTruncate(
            `curl -H "Authorization: Bearer ${jwt}" https://api.example/v1`,
            240,
        );
        assert.equal(out.includes(jwt), false, "jwt must not survive");
        assert.match(out, /Bearer \[redacted\]/);
    });

    test("scrubTruncate: api_key in a command is redacted", () => {
        const key = "sk-abcdefghij1234567890qrstuvwxyz";
        const out = scrubTruncate(`export api_key=${key} && deploy`, 160);
        assert.equal(out.includes(key), false, "api_key must not survive");
        assert.match(out, /api_key=\[redacted\]/);
    });

    test("scrubTruncate: no false-positive over-redaction on a safe command", () => {
        const cmd = "rm -rf tmp/ && make build";
        const out = scrubTruncate(cmd, 160);
        assert.equal(out, cmd, "safe command must be unchanged");
    });

    test("scrubTruncate: no false-positive on a normal file path", () => {
        const fp = "src/internal/runtime/substrate.go";
        const out = scrubTruncate(fp, 240);
        assert.equal(out, fp, "normal path must be unchanged");
    });
}
