// auto-gate-live.js — live classifier substrate for the auto-gate (Phase 3b).
//
// This module holds the live-model path: the transcript serializer, the
// binary-served classifier system prompt (consumed via `vh-agent-harness
// sys-prompt`, no longer inlined here), and a provider-agnostic
// OpenAI-compatible HTTP completion adapter. It mirrors the auto-gate-verdict.js
// precedent (a pure decision/substrate module that the plugin imports, and that
// OpenCode tolerates as a non-plugin under .opencode/plugins/ because it does NOT
// export `server`).
//
// It is deliberately split from auto-gate-verdict.js so each module stays
// cohesive:
//   auto-gate-verdict.js = verdict PARSE + decision matrix (pure, model-agnostic,
//                          synchronous). Phase 2. Unchanged by Phase 3b.
//   auto-gate-live.js    = transcript SERIALIZE + system PROMPT (binary-served)
//                          + HTTP ADAPTER (the live-model substrate). Phase 3b+3c.
//
// The two compose at decideLive() (below), which is the single bridge the plugin
// calls for `mode:"live"`.
//
// Naming: all identifiers GENERIC (auto-gate-live / classifyLive / serializeTranscript).
// The upstream is referred to only as "the reference agent system" — never by
// product name. The system prompt (now served by the binary, not inlined here)
// is the harness's OWN domain-free wording; it was written from the STRUCTURE
// described in the source packet's prompt anatomy section, not copied or
// paraphrased from any proprietary bundle.
//
// DUAL-PURPOSE SELF-TEST: like auto-gate-verdict.js, running this file directly
// (`node auto-gate-live.js` or `node --test auto-gate-live.js`) executes the
// node:test suite at the bottom; importing it as a module runs NO tests. The
// __isMain guard uses an explicit __filename comparison so an accidental import
// cannot fire the suite.
//
// Design lineage (structure only, original wording throughout — nothing copied
// or paraphrased from any proprietary bundle):
//   - system-prompt anatomy (mirrored in STRUCTURE only)
//   - transcript serialization, text mode (User:/Assistant:/Tool: prefixes,
//     tool name + indented args; classifier sees tool INPUTS not results;
//     the LAST tool call is the action being judged)

import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
// Static imports (no top-level await) so the self-test registers synchronously.
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { decidePermission } from "./auto-gate-verdict.js";
import { scrubCredentials, scrubTruncate, truncate } from "./auto-gate-scrub.js";

// Re-export scrubCredentials so this module keeps its public scrubber surface
// (and its self-test references it). The implementation lives in the shared
// auto-gate-scrub.js so the HTTP-egress path (here) and the audit/stderr-log
// path (auto-tool-gate.js) use the IDENTICAL scrubber with no drift.
export { scrubCredentials };

// ---------------------------------------------------------------------------
// Classifier system prompt — served by the binary via `vh-agent-harness sys-prompt`.
//
// The prompt text is NO LONGER inlined in this module. It lives in the binary as
// an embedded asset (templates/sys-prompts/auto-gate-classifier.md) and is served
// on demand by `vh-agent-harness sys-prompt auto-gate-classifier`. This keeps a
// single source of truth (the binary), lets an overlay or operator override it by
// rendering .opencode/sys-prompts/auto-gate-classifier.md, and removes a large
// text blob from the plugin source.
//
// CLASSIFIER_PROMPT_KEY is the named sys-prompt key this plugin consumes.
export const CLASSIFIER_PROMPT_KEY = "auto-gate-classifier";

// HARNESS_CONTEXT_PROMPT_KEY is the named sys-prompt key for the harness-
// execution-context fragment (vh-agent-harness exec wrapper contract, the
// wrapper-is-context-not-bypass rule, the deny-list floor, git routing). It is
// COMPOSED after the base prompt at load time (see resolveSystemPrompt), unless
// config.harnessContext === false or config.promptFile is set (full override).
export const HARNESS_CONTEXT_PROMPT_KEY = "auto-gate-harness-context";

// Memoized cache of the binary-served prompt. Read-once per process — a prompt
// changes only on a binary or overlay update, never mid-session. Tests reset this
// via __resetCachedBinaryPrompt; a custom opts.runner bypasses the cache entirely
// (so tests stay isolated).
let _cachedBinaryPrompt = null;

// Separate memo for the harness-context fragment (same read-once-per-process
// contract as the base prompt). Tests reset via __resetCachedHarnessContextPrompt.
let _cachedHarnessContextPrompt = null;

// defaultSpawnPromptRunner shells out SYNCHRONOUSLY to
// `vh-agent-harness sys-prompt <name>` and returns {ok, stdout, reason}.
// spawnSync is available in both Node and Bun runtimes. Synchronous (not async)
// because resolveSystemPrompt must be callable from the synchronous
// decidePermission evaluator path. On any failure (spawn error, non-zero exit,
// empty stdout) it returns ok:false with a reason — the caller decides whether
// to throw.
export function defaultSpawnPromptRunner(name) {
    let r;
    try {
        r = spawnSync("vh-agent-harness", ["sys-prompt", name], {
            encoding: "utf8",
        });
    } catch (e) {
        return {
            ok: false,
            stdout: "",
            reason: `spawn threw: ${(e && e.message) || String(e)}`,
        };
    }
    if (r.error) {
        return {
            ok: false,
            stdout: "",
            reason: `spawn failed: ${r.error.message || r.error}`,
        };
    }
    if (r.status !== 0) {
        const stderr = (r.stderr || "").trim();
        return {
            ok: false,
            stdout: "",
            reason: `non-zero exit ${r.status}${stderr ? `: ${stderr}` : ""}`,
        };
    }
    const stdout = r.stdout || "";
    if (stdout.length === 0) {
        return { ok: false, stdout: "", reason: "empty stdout" };
    }
    return { ok: true, stdout, reason: "" };
}

// ---------------------------------------------------------------------------
// Transcript serialization — pure (no I/O), testable.
//
// Input: the SDK transcript (Array<{info:{role}, parts:Array<Part>}>) + the
// current permission payload. Output: a single text string in "text mode":
// User: / Assistant: / Tool: prefixes, tool name + a SHORT length-capped
// summary of args, the most recent permission request emphasized at the end.
//
// STAGE-1 RELAXATION: we surface the load-bearing IDENTIFYING fields of a
// tool's input (command / path / pattern / query / url / workdir), length-
// capped ONLY — NOT secret-scrubbed. The classifier needs the raw command to
// judge intent accurately. Tool RESULTS (state.output) are still intentionally
// omitted: per the source packet the classifier sees tool INPUTS, not results
// (results are large, untrusted, and lower-signal). See serializeTranscript's
// doc comment for the full relaxation rationale.
// ---------------------------------------------------------------------------

// Truncation limits for the serialized transcript. Bounded so the resulting
// user message stays well under typical model context budgets.
const TX_FIELD_LEN = 240; // identifying field value (command/path/pattern/...)
const TX_TEXT_LEN = 1200; // a single text part
const TX_MAX_MESSAGES = 40; // cap to the most recent N messages

// txTruncate — length-cap ONLY (no scrubbing). Under the STAGE-1 RELAXATION
// (operator directive), serializeTranscript sends FULL length-capped content
// to the classifier: the classifier needs the raw command/text to judge
// intent accurately, and it transits to the operator's own configured
// endpoint (trusted). Regex-based secret scrubbing is intentionally NOT
// applied here; an LLM-based secret-stripper layer may be added later. Used
// for the text / reasoning / delegation-description fields in
// serializeTranscript, the allowlisted tool-input fields in redactToolInput,
// AND the permission `pattern` field.
const txTruncate = truncate;

// txScrub — scrub-then-truncate (scrubCredentials then truncate), delegating
// to the SHARED scrubber (auto-gate-scrub.js) so this module and the
// audit/stderr-log egress path (auto-tool-gate.js) share the IDENTICAL
// scrubber with no drift. RETAINED but NOT used by serializeTranscript under
// the stage-1 relaxation — the STDERR audit path (auto-tool-gate.js) still
// imports scrubTruncate/scrubCredentials directly and applies the heuristic
// scrubber (best-effort, not in the classifier's hot path). Kept defined here
// so the live module's scrubber surface stays available for a future
// re-enablement or an LLM-based stripper fallback.
const txScrub = scrubTruncate;

// Allowlisted summary of a tool's input args. Mirrors the plugin's
// summarizeArgs identifying-field allowlist: we emit ONLY known load-bearing
// keys (length-capped via txTruncate) and NEVER dump the raw args object.
// Unknown tools get an arg-key count only. Tool RESULTS (state.output) are
// intentionally omitted: per the source packet the classifier sees tool
// INPUTS, not results (results are large, untrusted, and lower-signal).
//
// STAGE-1 RELAXATION: every field below passes through txTruncate (length-cap
// ONLY, NO scrubbing), NOT txScrub. A bare `command`/`path` string CAN carry
// secrets (e.g. `curl -H "Authorization: Bearer ..."`); under the operator
// directive these are sent to the classifier RAW (length-capped) so intent can
// be judged accurately. The allowlist itself is retained (unknown fields +
// state.output still never egress). An LLM-based secret-stripper layer may be
// added later.
function redactToolInput(input) {
    if (!input || typeof input !== "object") return "";
    const parts = [];
    if (typeof input.command === "string") {
        parts.push(`command=${txTruncate(input.command, TX_FIELD_LEN)}`);
    }
    const fp = input.filePath ?? input.path;
    if (typeof fp === "string") {
        parts.push(`path=${txTruncate(fp, TX_FIELD_LEN)}`);
    }
    if (typeof input.pattern === "string") {
        parts.push(`pattern=${txTruncate(input.pattern, TX_FIELD_LEN)}`);
    }
    if (typeof input.query === "string") {
        parts.push(`query=${txTruncate(input.query, TX_FIELD_LEN)}`);
    }
    if (typeof input.url === "string") {
        parts.push(`url=${txTruncate(input.url, TX_FIELD_LEN)}`);
    }
    if (typeof input.workdir === "string") {
        parts.push(`workdir=${txTruncate(input.workdir, TX_FIELD_LEN)}`);
    }
    if (parts.length === 0) {
        const keys = Object.keys(input);
        parts.push(`args=${keys.length}`);
    }
    return parts.join(" ");
}

function roleLabel(role) {
    if (role === "user") return "User";
    if (role === "assistant") return "Assistant";
    return role || "Unknown";
}

// serializeTranscript(messages, permission) -> string
//
// Pure. Never throws. An empty / non-array transcript yields a non-empty
// fallback string that still describes the permission payload (the action under
// evaluation), so the live path degrades gracefully when the transcript fetch
// fails: the model still gets the type+pattern to judge.
//
// STAGE-1 RELAXATION (operator directive): the classifier receives FULL
// (length-capped, NOT secret-scrubbed) content. The classifier needs the raw
// command to judge intent accurately, and it transits to the operator's own
// configured endpoint (trusted). Regex-based secret scrubbing is intentionally
// NOT applied here; an LLM-based secret-stripper layer may be added later.
// The STDERR audit path (auto-tool-gate.js) still applies the heuristic
// scrubber — that path is best-effort and not in the classifier's hot path.
export function serializeTranscript(messages, permission) {
    const lines = [];
    const list = Array.isArray(messages) ? messages : [];
    // Bound prompt size: keep only the most recent messages.
    const trimmed = list.slice(-TX_MAX_MESSAGES);
    if (trimmed.length > 0) lines.push("<transcript>");
    for (const entry of trimmed) {
        if (!entry || typeof entry !== "object") continue;
        const role = roleLabel(entry.info && entry.info.role);
        const parts = Array.isArray(entry.parts) ? entry.parts : [];
        if (parts.length === 0) {
            lines.push(`${role}: (no content)`);
            continue;
        }
        for (const part of parts) {
            if (!part || typeof part !== "object") continue;
            switch (part.type) {
                case "text": {
                    const txt = typeof part.text === "string" ? part.text : "";
                    if (txt.length === 0) break;
                    lines.push(`${role}: ${txTruncate(txt, TX_TEXT_LEN)}`);
                    break;
                }
                case "tool": {
                    const toolName =
                        typeof part.tool === "string" ? part.tool : "unknown";
                    const input =
                        part.state && part.state.input
                            ? part.state.input
                            : undefined;
                    const summary = redactToolInput(input);
                    lines.push(
                        summary
                            ? `Tool: ${toolName} ${summary}`
                            : `Tool: ${toolName}`,
                    );
                    break;
                }
                case "reasoning": {
                    // Assistant internal monologue: useful context for judging
                    // composite / scope actions, but heavily truncated and
                    // clearly marked so it is never mistaken for operator
                    // intent. Length-capped ONLY (txTruncate) under the stage-1
                    // relaxation — NOT credential-scrubbed.
                    const txt = typeof part.text === "string" ? part.text : "";
                    if (txt.length === 0) break;
                    lines.push(
                        `Assistant: [reasoning] ${txTruncate(txt, TX_FIELD_LEN)}`,
                    );
                    break;
                }
                case "agent":
                case "subtask": {
                    // Sub-agent delegation marker — the prompt cares about this.
                    // Description is length-capped ONLY (txTruncate) under the
                    // stage-1 relaxation — NOT credential-scrubbed.
                    const name = part.name || part.agent || "sub-agent";
                    const desc = part.description || part.prompt || "";
                    lines.push(
                        `Assistant: [delegates to ${name}] ${txTruncate(desc, TX_FIELD_LEN)}`,
                    );
                    break;
                }
                default:
                    // step-start / step-finish / snapshot / patch / retry /
                    // compaction / file: metadata noise — omitted to keep the
                    // prompt concise and free of large attachments.
                    break;
            }
        }
    }
    if (trimmed.length > 0) lines.push("</transcript>");

    // The action under evaluation — ALWAYS present, emphasized last. This is the
    // single most recent permission request, the thing being judged.
    // STAGE-1 RELAXATION: `pattern` is a command/path string that CAN carry
    // secrets (e.g. a Bearer header in a curl pattern, a connection string in a
    // db command). Under the operator directive it is sent to the classifier
    // RAW (length-capped via txTruncate, NOT scrubbed) so intent can be judged
    // accurately. `type` is a fixed enum ("bash"/"edit"/...) with no secret
    // risk, so it is left as-is.
    const type = (permission && permission.type) || "unknown";
    const pattern = txTruncate(
        (permission && permission.pattern) || "",
        TX_FIELD_LEN,
    );
    lines.push("=== ACTION UNDER EVALUATION ===");
    lines.push(`Permission request: type=${type} pattern=${pattern}`);
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// resolveSystemPrompt — choose AND COMPOSE the system prompt for the live call.
//
// Resolution order:
//   1. If config.promptFile is set and readable -> its contents VERBATIM
//      (operator full-override escape-hatch; COMPOSITION IS SKIPPED). This
//      preserves the Phase 3b behavior the e2e depends on.
//   2. Else -> COMPOSE at load time from fragments:
//        final = base_prompt                          # auto-gate-classifier
//              + harness_context_fragment             # auto-gate-harness-context
//              + adopter_guides                       # *.md from per-level dirs
//
// The base prompt is shell-out `vh-agent-harness sys-prompt auto-gate-classifier`
// (memoized read-once per process). The harness-context fragment is a SEPARATE
// shell-out `vh-agent-harness sys-prompt auto-gate-harness-context` (also
// memoized). Both are stable per-process (they change only on a binary/overlay
// update, never mid-session).
//
// The harness-context fragment is OMITTED when config.harnessContext === false.
// The adopter guides are OMITTED when config.guides === false OR no guide files
// exist. This makes the composition OPT-IN-extensible without breaking the
// default minimal prompt.
//
// FAILURE SEMANTICS:
//   - base prompt failure (spawn error, non-zero exit, empty stdout) -> THROW.
//     The base is REQUIRED; the caller (classifyLive -> decideLive ->
//     decidePermission) maps a thrown evaluator to DENY (fail-closed).
//   - harness-context fragment failure -> NON-FATAL (omit + warn). The fragment
//     is additive; the classifier functions without it. Throwing would fail-
//     close every live call on a missing optional fragment.
//   - guide read failure -> NON-FATAL (skip the unreadable file / empty dir).
//
// opts.runner is injectable so tests exercise the shell-out path without a real
// `vh-agent-harness` invocation. When a custom runner is passed the memoization
// cache is bypassed (so each test is fully isolated). opts.readFileFn is
// injectable so tests exercise the promptFile override without touching the
// filesystem. opts.projectGuideDir / opts.userGuideDir / opts.readDirFn /
// opts.guideReadFileFn are injectable so tests exercise guide composition
// without touching the real guide directories.
export function resolveSystemPrompt(config, opts = {}) {
    const readFileFn = opts.readFileFn || fs.readFileSync;
    const isTestRunner = !!opts.runner;
    const runner = opts.runner || defaultSpawnPromptRunner;

    // 1. Operator escape-hatch: explicit promptFile overrides everything
    //    VERBATIM. Composition is SKIPPED (full override).
    const pf = config && config.promptFile;
    if (typeof pf === "string" && pf.length > 0) {
        try {
            return readFileFn(pf, "utf8");
        } catch (_) {
            // Unreadable override file: fall through to the composition path.
            // A bad promptFile must NOT take down the permission hot path.
        }
    }

    // 2. Base prompt (REQUIRED — memoized on the production default path only).
    const basePrompt = _loadBasePrompt(runner, isTestRunner);

    // 3. Compose: base + harness-context (optional) + adopter guides (optional).
    const wantHarnessContext = !(config && config.harnessContext === false);
    const wantGuides = !(config && config.guides === false);

    let composed = basePrompt;

    if (wantHarnessContext) {
        const ctx = _loadHarnessContextPrompt(runner, isTestRunner);
        if (ctx) {
            // Delimiter-ONLY injection (matching how adopter guides are
            // injected). The harness-context fragment OWNS its heading
            // (`## Harness execution context`); prepending one here would
            // produce a double-H2 in the composed output.
            composed += "\n\n<!-- harness-context -->\n\n" + ctx;
        }
    }

    if (wantGuides) {
        const guideText = _loadAdopterGuides(opts);
        if (guideText) {
            composed += guideText;
        }
    }

    return composed;
}

// _loadBasePrompt shells out for the base classifier prompt (REQUIRED).
// Memoized read-once per process on the production path. Throws on failure
// (fail-closed — the base prompt is mandatory for the classifier to function).
function _loadBasePrompt(runner, isTestRunner) {
    if (!isTestRunner && _cachedBinaryPrompt !== null) {
        return _cachedBinaryPrompt;
    }
    const result = runner(CLASSIFIER_PROMPT_KEY);
    if (!result.ok) {
        const reason = result.reason || "unknown";
        console.error(
            `[auto-gate] failed to load classifier prompt via sys-prompt: ${reason}`,
        );
        throw new Error(
            `failed to load classifier prompt via sys-prompt: ${reason}`,
        );
    }
    if (!isTestRunner) {
        _cachedBinaryPrompt = result.stdout;
    }
    return result.stdout;
}

// _loadHarnessContextPrompt shells out for the harness-execution-context
// fragment (OPTIONAL additive). Memoized read-once per process. NON-FATAL on
// failure: returns "" (the fragment is omitted, the classifier still has the
// base prompt). A warning is logged so an operator notices a misconfigured
// fragment without every live call fail-closing.
function _loadHarnessContextPrompt(runner, isTestRunner) {
    if (!isTestRunner && _cachedHarnessContextPrompt !== null) {
        return _cachedHarnessContextPrompt;
    }
    const result = runner(HARNESS_CONTEXT_PROMPT_KEY);
    if (!result.ok) {
        console.error(
            `[auto-gate] failed to load harness-context prompt via sys-prompt: ${result.reason || "unknown"}; omitting fragment`,
        );
        return "";
    }
    const out = result.stdout || "";
    if (!isTestRunner) {
        _cachedHarnessContextPrompt = out;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Adopter guide directories + guide loader.
//
// Adopter guides are *.md files an operator drops into a per-level directory to
// extend the classifier system prompt with project-/user-specific guidance. The
// two directories mirror the three-level config layering:
//
//   PROJECT: <repoRoot>/.opencode/sys-prompts/auto-gate-classifier-guides/*.md
//   USER:    <userConfigDir>/vh-agent-harness/auto-gate-classifier-guides/*.md
//     where <userConfigDir> = <XDG_CONFIG_HOME>/.config (XDG spec) — same base
//     the plugin-config layering uses.
//
// ORDERING: user-level guides are concatenated FIRST, then project-level, each
// level sorted alphabetically by filename. This puts project guides LAST (closer
// to the user message in the final prompt) so they carry more contextual weight
// — mirroring the config precedence (project > user > default). The order is
// DETERMINISTIC: the same set of files always composes the same prompt.
//
// DELIMITERS: each guide is preceded by
//   <!-- adopter-guide: <level>/<filename> -->
// so the LLM sees distinct sections and an operator can grep for provenance.
//
// Non-fatal: a missing directory or an unreadable file is skipped silently
// (guides are optional). An empty result returns "" so the caller omits the
// section entirely.

const GUIDE_DIR_NAME = "auto-gate-classifier-guides";

function _userConfigBase() {
    return path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "vh-agent-harness",
    );
}

function _defaultProjectGuideDir() {
    // In production the plugin lives at <repoRoot>/.opencode/plugins/ so
    // resolving two levels up gives <repoRoot>, then into the guide dir.
    return path.resolve(
        __dirname,
        "..",
        "..",
        ".opencode",
        "sys-prompts",
        GUIDE_DIR_NAME,
    );
}

function _defaultUserGuideDir() {
    return path.join(_userConfigBase(), GUIDE_DIR_NAME);
}

// _readGuideLevel lists+reads the *.md files in one guide dir. Returns an array
// of {name, body} sorted alphabetically by filename. A missing/unreadable dir
// returns []. Uses injectable readDir/readFile for test isolation.
function _readGuideLevel(label, dir, readDirFn, readFileFn) {
    let names;
    try {
        names = readDirFn(dir);
    } catch (_) {
        return [];
    }
    const mdNames = names
        .filter((n) => n.endsWith(".md"))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const out = [];
    for (const n of mdNames) {
        try {
            const body = readFileFn(path.join(dir, n), "utf8");
            out.push({ name: n, body });
        } catch (_) {
            // Skip unreadable guide; guides are optional.
        }
    }
    return out;
}

// _loadAdopterGuides reads both guide levels and returns the concatenated
// delimited text, or "" if no guides were found.
function _loadAdopterGuides(opts) {
    const readDirFn = opts.readDirFn || fs.readdirSync;
    const guideReadFileFn = opts.guideReadFileFn || fs.readFileSync;
    const projectDir = opts.projectGuideDir || _defaultProjectGuideDir();
    const userDir = opts.userGuideDir || _defaultUserGuideDir();

    // User-level FIRST, then project-level (project-last = closer to user msg).
    const userGuides = _readGuideLevel("user", userDir, readDirFn, guideReadFileFn);
    const projectGuides = _readGuideLevel("project", projectDir, readDirFn, guideReadFileFn);

    const parts = [];
    for (const g of userGuides) {
        parts.push(`\n\n<!-- adopter-guide: user/${g.name} -->\n\n${g.body}`);
    }
    for (const g of projectGuides) {
        parts.push(`\n\n<!-- adopter-guide: project/${g.name} -->\n\n${g.body}`);
    }
    return parts.length > 0 ? parts.join("") : "";
}

// __resetCachedBinaryPrompt clears the memoized binary prompt. Test-only; used
// to keep resolveSystemPrompt tests isolated from each other.
export function __resetCachedBinaryPrompt() {
    _cachedBinaryPrompt = null;
}

// __setCachedBinaryPrompt sets the memoized binary prompt directly. Test-only;
// lets a memoization test prime the cache without spawning the real binary.
export function __setCachedBinaryPrompt(value) {
    _cachedBinaryPrompt = value;
}

// __resetCachedHarnessContextPrompt clears the memoized harness-context prompt.
// Test-only; keeps composition tests isolated from each other.
export function __resetCachedHarnessContextPrompt() {
    _cachedHarnessContextPrompt = null;
}

// __setCachedHarnessContextPrompt sets the memoized harness-context prompt
// directly. Test-only.
export function __setCachedHarnessContextPrompt(value) {
    _cachedHarnessContextPrompt = value;
}

// ---------------------------------------------------------------------------
// classifyLive — provider-agnostic OpenAI-compatible chat-completions adapter,
// with configurable retry on transient failure.
//
// Builds a standard OpenAI-compatible request against config.modelEndpoint (the
// FULL URL, e.g. https://api.provider.example/v1/chat/completions), with the system
// prompt + serialized transcript as the two messages. Returns the raw model text
// from choices[0].message.content — the SAME contract stubEvaluate satisfies, so
// it slots into decidePermission()'s evaluator slot.
//
// RETRY-ON-TRANSIENT-FAILURE: the fetch+response-parse is wrapped in a retry
// loop so a single transient hiccup (the symptom this fixes: a request that
// hangs idle / stalls) does not immediately fail-closed to deny. A request is
// RETRIED when it fails with:
//   - timeout       — AbortError / the AbortController fired (idle/stall case)
//   - network error — fetch threw before a response (ECONNRESET / DNS / dropped)
//   - 5xx response  — transient server error
//   - 2xx but empty/missing choices[0].message.content — transient model hiccup
// A request is NOT retried (fail immediately, do not spend another call) when:
//   - 4xx response  — bad request / auth / not-found (retrying won't help)
//   - malformed JSON — a non-retryable parse error
// After the final allowed attempt still fails, classifyLive THROWS the last
// error (preserving the fail-closed -> deny path). On success at any attempt it
// returns the content. Defaults are conservative (1 retry) so the common case
// costs at most one extra call.
//
// FAIL-CLOSED BY THROWING: every indeterminate path THROWS, because the caller
// (decideLive -> decidePermission) maps a thrown evaluator to deny. Throws on:
//   - endpoint resolves to empty / missing model  (misconfigured; NOT retried)
//   - API key resolves to empty              (no credentials; NOT retried)
//   - non-2xx HTTP status                     (4xx immediate; 5xx retried)
//   - malformed JSON body                     (NOT retried)
//   - missing choices[0].message.content      (retried — transient)
//   - fetch rejection / AbortError (timeout)  (retried — transient)
//
// ENDPOINT + API KEY are each resolved DUAL-FORM with LITERAL PREFERRED (see
// the resolution blocks in _classifyLiveCore): a non-empty literal in config
// wins; otherwise the named env var (modelEndpointEnv / apiKeyEnv) is consulted
// at call time; if neither yields a value the throw above fail-closes. A key
// VALUE in a literal apiKey lives in the gitignored LLM config file (safe for
// local setups); the env-var form (apiKeyEnv) remains recommended for
// CI/containers where secrets must not live on disk.
//
// fetchFn is injectable (default globalThis.fetch) so tests never make real
// network calls. runnerFn is injectable so tests never spawn a real
// `vh-agent-harness` process to load the system prompt. The plugin runtime is
// Bun-based, so global fetch + AbortController are available.
//
// config.maxRetries (default 1, normalized in auto-tool-gate.js) = number of
// ADDITIONAL attempts after the first (0 = single attempt, the pre-retry
// behavior). config.retryDelayMs (default 500) = base delay with LINEAR backoff:
// delay before attempt N (N>=2) = retryDelayMs * (N-1), so attempt 2 waits 1x,
// attempt 3 waits 2x, etc. Keeps latency bounded; cheap to reason about.
// _sleep — promise wrapper around setTimeout, used for linear backoff between
// retries. Kept as a named helper so the retry loop reads as straight-line code.
function _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// _isRetryable — classify a single-attempt error. Errors thrown by
// _attemptFetchParse carry an explicit `retryable` boolean flag, so this just
// reads the flag. Errors thrown before the loop (misconfiguration / prompt
// load) carry no flag and are correctly treated as non-retryable.
function _isRetryable(err) {
    if (!err) return false;
    if (typeof err.retryable === "boolean") return err.retryable;
    return false;
}

// _attemptFetchParse — ONE fetch + response-parse attempt. Throws a TAGGED
// error (carrying a `retryable` boolean + optional `status`) on every failure
// so the retry loop can classify it without string-matching. The message text
// matches the pre-retry wording so existing error-message assertions still
// hold. The AbortError name is preserved when the fetch rejection was an abort
// (timeout), so upstream handlers that inspect .name still see "AbortError".
async function _attemptFetchParse(fetchImpl, endpoint, apiKey, body, timeoutMs) {
    // AbortController + setTimeout gives a hard timeout. On abort the underlying
    // fetch rejects (AbortError) and this attempt throws — retryable.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
        res = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: ac.signal,
        });
    } catch (e) {
        // Transport error (ECONNRESET / DNS / dropped connection) OR timeout
        // (the AbortController fired — the idle/stall case this fixes). Both are
        // transient: retryable.
        const msg = (e && e.message) || String(e);
        const tagged = new Error(msg);
        tagged.name = e && e.name === "AbortError" ? "AbortError" : "TransportError";
        tagged.retryable = true;
        throw tagged;
    } finally {
        clearTimeout(timer);
    }

    if (
        !res ||
        typeof res.status !== "number" ||
        res.status < 200 ||
        res.status >= 300
    ) {
        const status =
            res && typeof res.status === "number" ? res.status : undefined;
        const tagged = new Error(
            `non-2xx response: ${status !== undefined ? status : "no-status"}`,
        );
        // 5xx (and a missing/untyped status) are transient server errors ->
        // retryable. 4xx (bad request / auth / not-found) are permanent ->
        // fail immediately, do not spend another call.
        tagged.retryable = status === undefined || status >= 500;
        if (status !== undefined) tagged.status = status;
        throw tagged;
    }

    let json;
    try {
        json = await res.json();
    } catch (e) {
        const tagged = new Error(
            `malformed JSON response: ${(e && e.message) || String(e)}`,
        );
        tagged.retryable = false; // parse error: not retryable
        throw tagged;
    }

    const content =
        json &&
        json.choices &&
        json.choices[0] &&
        json.choices[0].message &&
        json.choices[0].message.content;

    if (typeof content !== "string" || content.length === 0) {
        const tagged = new Error("missing choices[0].message.content");
        // 2xx but empty/missing content — a transient model hiccup: retryable.
        tagged.retryable = true;
        throw tagged;
    }
    return content;
}

// _classifyLiveCore — config validation + retry loop. Returns { content,
// retries } on success (retries = number of ADDITIONAL attempts taken beyond
// the first, for the audit line). Throws the last error on final failure
// (fail-closed -> deny). classifyLive() (public) wraps this and returns only
// .content so its string-return contract is unchanged; decideLive() calls this
// directly so it can surface the retry count in its result for the audit line.
async function _classifyLiveCore(config, serializedInput, fetchFn, runnerFn) {
    const fetchImpl = fetchFn || globalThis.fetch;
    if (typeof fetchImpl !== "function") {
        throw new Error("no fetch implementation available");
    }
    const model = config && config.model;
    if (typeof model !== "string" || model.length === 0) {
        throw new Error("missing model");
    }
    // Dual-form endpoint resolution (literal-preferred):
    //   - a NON-EMPTY literal `config.modelEndpoint` wins;
      //   - otherwise fall back to `config.modelEndpointEnv` (NAME of an env
    //     var) and read its value from process.env;
    //   - otherwise the endpoint resolves to "" -> fail-closed below.
    // The non-empty guard matters: DEFAULT_LLM_CONFIG.modelEndpoint is "" and
    // must NOT suppress the env fallback.
    const endpointLiteral =
        config && typeof config.modelEndpoint === "string"
            ? config.modelEndpoint
            : "";
    const endpointEnvName =
        config && typeof config.modelEndpointEnv === "string" && config.modelEndpointEnv
            ? config.modelEndpointEnv
            : "AUTO_GATE_MODEL_ENDPOINT";
    const endpoint = endpointLiteral.length > 0
        ? endpointLiteral
        : (process.env[endpointEnvName] || "");
    if (typeof endpoint !== "string" || endpoint.length === 0) {
        throw new Error("missing modelEndpoint");
    }
    // Dual-form key resolution (literal-preferred):
    //   - a NON-EMPTY literal `config.apiKey` (the value itself) wins;
    //   - otherwise fall back to `config.apiKeyEnv` (NAME of an env var) and
    //     read its value from process.env (the historical behavior);
    //   - otherwise the key resolves to "" -> fail-closed below.
    // The non-empty guard matters: DEFAULT_LLM_CONFIG.apiKey is "" and must
    // NOT suppress the env fallback.
    const apiKeyLiteral =
        config && typeof config.apiKey === "string"
            ? config.apiKey
            : "";
    const apiKeyEnv =
        config && typeof config.apiKeyEnv === "string" && config.apiKeyEnv
            ? config.apiKeyEnv
            : "AUTO_GATE_API_KEY";
    const apiKey = apiKeyLiteral.length > 0
        ? apiKeyLiteral
        : (process.env[apiKeyEnv] || "");
    if (!apiKey || typeof apiKey !== "string" || apiKey.length === 0) {
        throw new Error(`missing API key (literal apiKey or env ${apiKeyEnv})`);
    }
    const timeoutMs =
        config && typeof config.timeoutMs === "number" && config.timeoutMs > 0
            ? config.timeoutMs
            : 8000;
    // Retry policy. Mirrors the timeoutMs defaulting style so a direct call
    // (e.g. tests) without normalization still resolves the fields. Production
    // reads these from auto-gate-llm.json via normalizeLlmConfig.
    const maxRetries =
        typeof config.maxRetries === "number" &&
        Number.isInteger(config.maxRetries) &&
        config.maxRetries >= 0
            ? config.maxRetries
            : 1;
    const retryDelayMs =
        typeof config.retryDelayMs === "number" &&
        Number.isInteger(config.retryDelayMs) &&
        config.retryDelayMs >= 0
            ? config.retryDelayMs
            : 500;

    // Prompt + body are built ONCE: they are identical across attempts (a retry
    // is a fresh POST of the same payload). Building them outside the loop also
    // keeps a binary prompt-load failure non-retryable (it throws here, before
    // the loop, so _isRetryable never sees it).
    const prompt = resolveSystemPrompt(config, { runner: runnerFn });
    const body = {
        model,
        messages: [
            { role: "system", content: prompt },
            { role: "user", content: serializedInput },
        ],
        temperature: 1,
        max_tokens: 64,
        stream: false,
    };

    const maxAttempts = maxRetries + 1;
    let lastErr;
    let retries = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const content = await _attemptFetchParse(
                fetchImpl,
                endpoint,
                apiKey,
                body,
                timeoutMs,
            );
            return { content, retries };
        } catch (err) {
            lastErr = err;
            if (attempt < maxAttempts && _isRetryable(err)) {
                // LINEAR BACKOFF: delay before attempt N (N>=2) = retryDelayMs *
                // (N-1). The just-failed attempt is `attempt`, so the NEXT
                // attempt is `attempt + 1` and (N-1) = attempt. Thus attempt 2
                // waits 1x, attempt 3 waits 2x, ... keeps latency bounded.
                const delay = retryDelayMs * attempt;
                if (delay > 0) await _sleep(delay);
                retries++;
                continue;
            }
            // Non-retryable error OR no attempts left: throw the original error
            // (message/name preserved) so the fail-closed -> deny path and all
            // existing error-message assertions hold unchanged. STAMP the retry
            // count onto the error (mirroring the .retryable/.status tagging in
            // _attemptFetchParse) so the fail-closed path (decideLive) can
            // report accurate `retries=N` telemetry instead of losing it — the
            // locally-tracked `retries` would otherwise be discarded on throw.
            err.retries = retries;
            throw err;
        }
    }
    // Unreachable in practice (the loop returns or throws), but kept as a
    // defensive last-error throw for clarity. Stamp retries here too so the
    // invariant (every thrown error carries its .retries) holds unconditionally.
    if (lastErr) lastErr.retries = retries;
    throw lastErr;
}

export async function classifyLive(config, serializedInput, fetchFn, runnerFn) {
    const r = await _classifyLiveCore(config, serializedInput, fetchFn, runnerFn);
    return r.content;
}

// ---------------------------------------------------------------------------
// decideLive — the live-path composition bridge the plugin calls for mode:"live".
//
// Why this exists: decidePermission() (verdict module) is SYNCHRONOUS — it calls
// the evaluator and treats the return as raw verdict text. classifyLive() is
// inherently ASYNC (HTTP). So we cannot hand classifyLive directly to
// decidePermission as a synchronous evaluator. Instead decideLive:
//   1. awaits classifyLive (capturing success text OR error),
//   2. hands the result to decidePermission via a SYNCHRONOUS evaluator closure
//      that replays the outcome — returning the raw text on success, or THROWING
//      the captured error on failure so decidePermission's fail-closed matrix
//      maps it to "evaluator error -> deny".
//
// Net effect: the existing fail-closed matrix applies unchanged. classifyLive
// success+<block>no</block> -> allow; success+<block>yes</block> -> deny;
// success+unparseable -> deny; any throw (timeout / non-2xx / malformed /
// misconfigured / no key) -> deny. Latency is measured end-to-end for the audit
// line.
//
// fetchFn is injectable so tests drive the whole matrix with a fake transport
// and never touch the network. runnerFn is injectable so tests never spawn a
// real `vh-agent-harness` to load the system prompt.
export async function decideLive(config, serializedInput, fetchFn, runnerFn) {
    let liveError = null;
    let rawText = null;
    let retries = 0;
    const t0 = Date.now();
    try {
        // Call the core directly (not the public classifyLive wrapper) so the
        // retry count is available for the audit line below.
        const r = await _classifyLiveCore(config, serializedInput, fetchFn, runnerFn);
        rawText = r.content;
        retries = r.retries;
    } catch (err) {
        liveError = err;
        // _classifyLiveCore stamps .retries onto thrown errors produced inside
        // the retry loop (mirroring .retryable/.status). Pre-loop throws
        // (misconfiguration, prompt-load failure) carry no .retries, so the
        // fallback is 0 — which is correct: no retries occurred.
        retries = typeof err.retries === "number" ? err.retries : 0;
    }
    const latencyMs = Date.now() - t0;
    const result = decidePermission(config, () => {
        if (liveError) throw liveError;
        return rawText;
    });
    // `retries` flows up to the live-decision audit line (appended as
    // `retries=N` when > 0); it is a safe integer (no tool-call content).
    return { status: result.status, audit: result.audit, reason: result.reason, latencyMs, retries };
}

// ===========================================================================
// DUAL-PURPOSE SELF-TEST.
// Run directly (`node auto-gate-live.js` or `node --test auto-gate-live.js`) to
// execute the suite. Import as a module -> NO tests run. Guard is an explicit
// __filename comparison so an accidental import cannot fire the suite.
// ===========================================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __isMain = path.resolve(process.argv[1] ?? "") === __filename;

if (__isMain) {
    // ===== serializeTranscript =====

    test("serialize: empty transcript -> non-empty fallback naming the permission", () => {
        const out = serializeTranscript([], { type: "bash", pattern: "rm -rf x" });
        assert.ok(out.length > 0, "fallback must be non-empty");
        assert.match(out, /ACTION UNDER EVALUATION/);
        assert.match(out, /type=bash/);
        assert.match(out, /pattern=rm -rf x/);
        assert.doesNotMatch(out, /<transcript>/); // no transcript block when empty
    });

    test("serialize: non-array transcript -> non-empty fallback", () => {
        const out = serializeTranscript(undefined, { type: "edit" });
        assert.match(out, /type=edit/);
    });

    test("serialize: multi-message -> User/Assistant/Tool prefixes", () => {
        const msgs = [
            {
                info: { role: "user" },
                parts: [{ type: "text", text: "please clean the tmp dir" }],
            },
            {
                info: { role: "assistant" },
                parts: [
                    { type: "text", text: "sure" },
                    {
                        type: "tool",
                        tool: "bash",
                        state: { input: { command: "rm -rf tmp/" } },
                    },
                ],
            },
        ];
        const out = serializeTranscript(msgs, { type: "bash", pattern: "rm -rf tmp/" });
        assert.match(out, /<transcript>/);
        assert.match(out, /User: please clean the tmp dir/);
        assert.match(out, /Assistant: sure/);
        assert.match(out, /Tool: bash command=rm -rf tmp\//);
        assert.match(out, /ACTION UNDER EVALUATION/);
        assert.match(out, /<\/transcript>/);
    });

    test("serialize: long values are truncated (length-cap only)", () => {
        // A long NON-secret-shaped value (a repeated readable phrase) exercises
        // the length-cap (txTruncate) path specifically. Under the stage-1
        // relaxation NO scrubbing is applied, so a long value is truncated with
        // "..." and never redacted. (A high-entropy blob would likewise be
        // truncated, not redacted — the scrubber is off for the HTTP path.)
        const huge = "the quick brown fox jumps over the lazy dog. ".repeat(150);
        const msgs = [
            {
                info: { role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        tool: "write",
                        state: { input: { filePath: huge } },
                    },
                    { type: "text", text: huge },
                ],
            },
        ];
        const out = serializeTranscript(msgs, { type: "write", pattern: huge });
        // The huge value must NOT appear verbatim anywhere in the output.
        assert.equal(out.includes(huge), false, "huge value must be truncated");
        // Truncation marker present (length-cap applied; nothing redacted).
        assert.match(out, /\.\.\./);
    });

    test("serialize: tool results (state.output) are omitted", () => {
        const msgs = [
            {
                info: { role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        tool: "bash",
                        state: {
                            input: { command: "ls" },
                            output: "SECRET-LIVE-CREDenTIAL-VALUE",
                        },
                    },
                ],
            },
        ];
        const out = serializeTranscript(msgs, { type: "bash", pattern: "ls" });
        assert.equal(
            out.includes("SECRET-LIVE-CREDenTIAL-VALUE"),
            false,
            "tool output must not leak into the transcript",
        );
        assert.match(out, /Tool: bash command=ls/);
    });

    test("serialize: unknown tool input -> arg count, no raw dump", () => {
        const msgs = [
            {
                info: { role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        tool: "weird",
                        state: { input: { a: 1, b: 2, secret: "shh" } },
                    },
                ],
            },
        ];
        const out = serializeTranscript(msgs, { type: "weird" });
        assert.match(out, /Tool: weird args=3/);
        assert.equal(out.includes("shh"), false, "raw arg values must not leak");
    });

    test("serialize: sub-agent delegation is marked", () => {
        const msgs = [
            {
                info: { role: "assistant" },
                parts: [
                    {
                        type: "agent",
                        name: "builder",
                        description: "implement the feature",
                    },
                ],
            },
        ];
        const out = serializeTranscript(msgs, { type: "task" });
        assert.match(out, /\[delegates to builder\] implement the feature/);
    });

    test("serialize: permission payload always appears", () => {
        const out = serializeTranscript(
            [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }],
            { type: "webfetch", pattern: "https://evil.example/x" },
        );
        assert.match(out, /type=webfetch/);
        assert.match(out, /pattern=https:\/\/evil\.example\/x/);
    });

    // ===== full-content egress (STAGE-1 RELAXATION) =====
    //
    // In live mode the transcript travels to an external classifier endpoint.
    // Under the operator stage-1 directive the classifier receives FULL
    // (length-capped, NOT secret-scrubbed) content: the classifier needs the
    // raw command/text to judge intent accurately, and it transits to the
    // operator's own configured endpoint (trusted). These tests place
    // secret-shaped values in each field and assert the VALUE SURVIVES into the
    // serialized output (length-capped), documenting the relaxation. The
    // [redacted] marker is intentionally NOT produced here — the old
    // scrubbed-egress behavior is reverted. The STDERR audit path
    // (auto-tool-gate.js) still applies the heuristic scrubber.

    test("serialize: full text sent to classifier (stage-1 relax) — api_key value present", () => {
        const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
        const msgs = [
            {
                info: { role: "user" },
                parts: [
                    {
                        type: "text",
                        text: `here is my api_key=${secret} for you`,
                    },
                ],
            },
        ];
        const out = serializeTranscript(msgs, { type: "edit", pattern: "x" });
        // STAGE-1 RELAXATION: the raw text (length-capped) is sent to the
        // classifier UN-SCRUBBED, so the api_key value SURVIVES.
        assert.equal(
            out.includes(secret),
            true,
            "api_key value must survive into the transcript (stage-1 relax)",
        );
        // The [redacted] marker is intentionally NOT produced (scrubbing off).
        assert.doesNotMatch(out, /\[redacted\]/);
    });

    test("serialize: full reasoning sent to classifier (stage-1 relax) — Bearer jwt present", () => {
        const jwt =
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
        const msgs = [
            {
                info: { role: "assistant" },
                parts: [
                    {
                        type: "reasoning",
                        text: `I will use Bearer ${jwt} to authenticate`,
                    },
                ],
            },
        ];
        const out = serializeTranscript(msgs, { type: "edit", pattern: "x" });
        assert.equal(
            out.includes(jwt),
            true,
            "bearer token in reasoning must survive (stage-1 relax)",
        );
        assert.doesNotMatch(out, /\[redacted\]/);
    });

    test("serialize: full text sent to classifier (stage-1 relax) — hex blob present", () => {
        const hex = "0123456789abcdef0123456789abcdef01234567";
        const msgs = [
            {
                info: { role: "user" },
                parts: [{ type: "text", text: `token blob ${hex} right here` }],
            },
        ];
        const out = serializeTranscript(msgs, { type: "edit", pattern: "x" });
        assert.equal(
            out.includes(hex),
            true,
            "hex blob must survive into the transcript (stage-1 relax)",
        );
        assert.doesNotMatch(out, /\[redacted\]/);
    });

    test("serialize: full text sent to classifier (stage-1 relax) — password value present", () => {
        const secret = "hunter2supersecretvalue1234567890";
        const msgs = [
            {
                info: { role: "user" },
                parts: [
                    {
                        type: "text",
                        text: `login with password: ${secret} please`,
                    },
                ],
            },
        ];
        const out = serializeTranscript(msgs, { type: "edit", pattern: "x" });
        assert.equal(
            out.includes(secret),
            true,
            "password value must survive into the transcript (stage-1 relax)",
        );
        assert.doesNotMatch(out, /\[redacted\]/);
    });

    test("serialize: full text sent to classifier (stage-1 relax) — pasted Bearer header present", () => {
        const token = "sk-deadbeefcafef00dbaadf00dcafebabe1234";
        const msgs = [
            {
                info: { role: "assistant" },
                parts: [
                    {
                        type: "text",
                        text: `ran curl with header Authorization: Bearer ${token} against the api`,
                    },
                ],
            },
        ];
        const out = serializeTranscript(msgs, { type: "bash", pattern: "curl" });
        assert.equal(
            out.includes(token),
            true,
            "bearer token in pasted header must survive (stage-1 relax)",
        );
        assert.doesNotMatch(out, /\[redacted\]/);
    });

    test("serialize: full delegation description sent to classifier (stage-1 relax) — token present", () => {
        const secret = "sk-zyxwvutsrqponmlkjihgfedcba987654";
        const msgs = [
            {
                info: { role: "assistant" },
                parts: [
                    {
                        type: "agent",
                        name: "builder",
                        description: `use token=${secret} for the deploy`,
                    },
                ],
            },
        ];
        const out = serializeTranscript(msgs, { type: "task", pattern: "x" });
        assert.equal(
            out.includes(secret),
            true,
            "token in delegation description must survive (stage-1 relax)",
        );
        assert.doesNotMatch(out, /\[redacted\]/);
    });

    test("scrub: scrubCredentials is a pure exported function", () => {
        // Direct sanity check on the exported scrubber (idempotent + pure).
        assert.equal(
            scrubCredentials("api_key=sk-abcdefghijklmnopqrstuvwxyz123456"),
            "api_key=[redacted]",
        );
        assert.equal(
            scrubCredentials("Bearer eyJ0b2tlbj4.signature"),
            "Bearer [redacted]",
        );
        assert.equal(scrubCredentials("no secrets here"), "no secrets here");
        assert.equal(scrubCredentials(123), "");
    });

    test("scrub: tool-input allowlist redaction still works (no regression)", () => {
        // Tool inputs use redactToolInput (allowlist), NOT scrubCredentials.
        // An unknown tool with a secret arg value still collapses to an arg
        // count with no raw value dumped.
        const msgs = [
            {
                info: { role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        tool: "weird",
                        state: {
                            input: {
                                secret: "sk-leakshouldnotappear12345678",
                            },
                        },
                    },
                ],
            },
        ];
        const out = serializeTranscript(msgs, { type: "weird" });
        assert.match(out, /Tool: weird args=1/);
        assert.equal(
            out.includes("sk-leakshouldnotappear12345678"),
            false,
            "raw tool arg value must not leak",
        );
    });

    // ===== Full-content egress for tool-input + permission.pattern (stage-1 relax) =====
    //
    // These fields (command/path/pattern/query/url/workdir + permission.pattern)
    // now pass through txTruncate (length-cap ONLY, NO scrubbing) under the
    // operator stage-1 directive. These tests place secret-shaped values in
    // BOTH a tool `command` AND the permission `pattern` and assert the raw
    // secret SURVIVES into the serialized egress string (length-capped),
    // documenting that the F1 scrubbed-egress behavior is intentionally
    // reverted. The STDERR audit path (auto-tool-gate.js) still scrubs.

    test("serialize: full tool command sent to classifier (stage-1 relax) — Bearer jwt present", () => {
        // A Bearer <jwt> embedded in a judged `command` — the allowlisted
        // tool-input path. Under stage-1 relax this SURVIVES (length-capped).
        const jwt =
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
        const msgs = [
            {
                info: { role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        tool: "bash",
                        state: {
                            input: {
                                command: `curl -H "Authorization: Bearer ${jwt}" https://api.example/v1`,
                            },
                        },
                    },
                ],
            },
        ];
        const out = serializeTranscript(msgs, { type: "bash", pattern: "curl" });
        assert.equal(
            out.includes(jwt),
            true,
            "Bearer jwt in tool command must survive into egress payload (stage-1 relax)",
        );
        assert.doesNotMatch(out, /\[redacted\]/);
    });

    test("serialize: full permission pattern sent to classifier (stage-1 relax) — api_key present", () => {
        // A secret-shaped value in the permission `pattern` (the action under
        // evaluation). Under stage-1 relax this SURVIVES (length-capped).
        const secret = "sk-abcdefghij1234567890qrstuvwxyz";
        const out = serializeTranscript(
            [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }],
            { type: "bash", pattern: `export api_key=${secret} && deploy` },
        );
        assert.equal(
            out.includes(secret),
            true,
            "api_key value in permission pattern must survive into egress payload (stage-1 relax)",
        );
        assert.doesNotMatch(out, /\[redacted\]/);
    });

    test("serialize: full permission pattern sent to classifier (stage-1 relax) — connection-string password present", () => {
        // A connection-string-style secret in the permission `pattern`.
        // Under stage-1 relax the `password` value SURVIVES (length-capped).
        const secret = "supersecretpasswordvalue1234567890";
        const out = serializeTranscript(
            [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }],
            {
                type: "bash",
                pattern: `psql postgres://user:password=${secret}@db.example:5432/prod`,
            },
        );
        assert.equal(
            out.includes(secret),
            true,
            "password in connection string (permission pattern) must survive (stage-1 relax)",
        );
        assert.doesNotMatch(out, /\[redacted\]/);
    });

    test("serialize: full tool command + pattern sent to classifier (stage-1 relax) — both secrets present", () => {
        // Combined: both vectors present in a single egress payload. Under
        // stage-1 relax BOTH secrets SURVIVE (length-capped).
        const cmdToken =
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
        const patKey = "AKIAABCDEFGHIJKLMNOP";
        const msgs = [
            {
                info: { role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        tool: "bash",
                        state: {
                            input: {
                                command: `curl -H "Authorization: Bearer ${cmdToken}" https://api.example`,
                            },
                        },
                    },
                ],
            },
        ];
        const out = serializeTranscript(msgs, {
            type: "bash",
            pattern: `aws configure set aws_access_key_id ${patKey}`,
        });
        assert.equal(
            out.includes(cmdToken),
            true,
            "Bearer jwt in command must survive (stage-1 relax)",
        );
        assert.equal(
            out.includes(patKey),
            true,
            "AWS key in permission pattern must survive (stage-1 relax)",
        );
        assert.doesNotMatch(out, /\[redacted\]/);
    });

    // ===== resolveSystemPrompt =====
    //
    // resolveSystemPrompt now shells out to `vh-agent-harness sys-prompt
    // auto-gate-classifier` when promptFile is unset. An injectable opts.runner
    // keeps these tests free of any real vh-agent-harness invocation, and a
    // custom runner bypasses the memoization cache so tests stay isolated.

    const FAKE_PROMPT = "FAKE PROMPT FROM BINARY";
    // FAKE_CONTEXT mirrors the real fragment's shape: it opens with the H2
    // `## Harness execution context` (the heading the fragment OWNS). The
    // composer injects only the delimiter comment, so a realistic fake lets
    // the composition assertions check for the real heading rather than a
    // composer-injected one.
    const FAKE_CONTEXT = "## Harness execution context\n\nFAKE HARNESS CONTEXT";

    function fakeRunnerOk(stdout = FAKE_PROMPT) {
        return () => ({ ok: true, stdout, reason: "" });
    }

    // fakeRunnerMap returns a name-dispatching runner so composition tests can
    // fake DIFFERENT content for the base vs harness-context fragments.
    function fakeRunnerMap(map) {
        return (name) => {
            const stdout = map[name];
            if (stdout === undefined) {
                return { ok: false, stdout: "", reason: `no fake for ${name}` };
            }
            return { ok: true, stdout, reason: "" };
        };
    }

    function fakeRunnerFail(reason = "non-zero exit 1") {
        return () => ({ ok: false, stdout: "", reason });
    }

    test("resolveSystemPrompt: unset promptFile -> shells out for base + context, composes", () => {
        __resetCachedBinaryPrompt();
        __resetCachedHarnessContextPrompt();
        const called = [];
        const runner = (name) => {
            called.push(name);
            if (name === CLASSIFIER_PROMPT_KEY) {
                return { ok: true, stdout: FAKE_PROMPT, reason: "" };
            }
            if (name === HARNESS_CONTEXT_PROMPT_KEY) {
                return { ok: true, stdout: FAKE_CONTEXT, reason: "" };
            }
            return { ok: false, stdout: "", reason: "unknown" };
        };
        const out = resolveSystemPrompt({}, { runner });
        // Composition: base + harness-context delimiter + context body.
        assert.ok(out.startsWith(FAKE_PROMPT), "composed prompt starts with base");
        assert.ok(out.includes("<!-- harness-context -->"), "harness-context delimiter present");
        assert.ok(out.includes("## Harness execution context"), "harness-context heading present (fragment-owned, not composer-injected)");
        assert.ok(out.endsWith(FAKE_CONTEXT), "composed prompt ends with context body");
        // Both keys must be requested (base first, then context).
        assert.deepEqual(called, [CLASSIFIER_PROMPT_KEY, HARNESS_CONTEXT_PROMPT_KEY]);
    });

    test("resolveSystemPrompt: memoized on default path (no second shell-out)", () => {
        __resetCachedBinaryPrompt();
        __resetCachedHarnessContextPrompt();
        // Prime the cache directly (simulates a prior production call). This is
        // the only way to test memoization without spawning the real binary,
        // since a custom opts.runner bypasses the cache by design.
        __setCachedBinaryPrompt("CACHED-SENTINEL-777");
        // Call with the DEFAULT runner (no opts.runner). The cache MUST
        // short-circuit so the real binary is never spawned. If it were, the
        // real prompt (not "CACHED-SENTINEL-777") would be returned.
        // harnessContext:false isolates the BASE cache — without it the
        // harness-context fragment would shell out to the real binary.
        const out = resolveSystemPrompt({ harnessContext: false });
        assert.equal(out, "CACHED-SENTINEL-777");
        __resetCachedBinaryPrompt();
        __resetCachedHarnessContextPrompt();
    });

    test("resolveSystemPrompt: set+readable promptFile -> override (no shell-out)", () => {
        __resetCachedBinaryPrompt();
        let runnerCalls = 0;
        const fakeRead = (p) => `CUSTOM PROMPT from ${p}`;
        const out = resolveSystemPrompt(
            { promptFile: "/x/y.txt" },
            { readFileFn: fakeRead, runner: () => { runnerCalls++; return { ok: true, stdout: "X", reason: "" }; } },
        );
        assert.equal(out, "CUSTOM PROMPT from /x/y.txt");
        assert.equal(runnerCalls, 0, "must not shell out when promptFile is readable");
    });

    test("resolveSystemPrompt: unreadable promptFile -> falls through to binary", () => {
        __resetCachedBinaryPrompt();
        __resetCachedHarnessContextPrompt();
        const fakeRead = () => {
            throw new Error("ENOENT");
        };
        const out = resolveSystemPrompt(
            { promptFile: "/missing.txt", harnessContext: false },
            { readFileFn: fakeRead, runner: fakeRunnerOk() },
        );
        assert.equal(out, FAKE_PROMPT);
    });

    test("resolveSystemPrompt: binary failure -> throws", () => {
        __resetCachedBinaryPrompt();
        __resetCachedHarnessContextPrompt();
        assert.throws(
            () => resolveSystemPrompt({}, { runner: fakeRunnerFail("spawn failed: ENOENT") }),
            /failed to load classifier prompt via sys-prompt: spawn failed: ENOENT/,
        );
        __resetCachedBinaryPrompt();
        __resetCachedHarnessContextPrompt();
    });

    // ===== resolveSystemPrompt: TIER-1 COMPOSITION TESTS =====
    //
    // The final classifier prompt COMPOSES at load time:
    //   final = base + harness-context (optional) + adopter guides (optional)
    // The tests below use a guideOpts() helper that injects FAKE guide dirs +
    // readDir/readFile stubs so no real filesystem access is needed. The runner
    // is name-dispatching (fakeRunnerMap) so base and context fragments are
    // distinguishable.

    function guideOpts(userFiles, projectFiles) {
        const userDir = "/fake/user-guides";
        const projectDir = "/fake/project-guides";
        return {
            runner: fakeRunnerMap({
                [CLASSIFIER_PROMPT_KEY]: FAKE_PROMPT,
                [HARNESS_CONTEXT_PROMPT_KEY]: FAKE_CONTEXT,
            }),
            projectGuideDir: projectDir,
            userGuideDir: userDir,
            readDirFn: (dir) => {
                if (dir === projectDir) return Object.keys(projectFiles);
                if (dir === userDir) return Object.keys(userFiles);
                return [];
            },
            guideReadFileFn: (p) => {
                const base = path.basename(p);
                if (base in projectFiles) return projectFiles[base];
                if (base in userFiles) return userFiles[base];
                throw new Error(`ENOENT: ${p}`);
            },
        };
    }

    test("composition: base + harness-context + guides when all present", () => {
        __resetCachedBinaryPrompt();
        __resetCachedHarnessContextPrompt();
        const opts = guideOpts(
            { "a-user.md": "USER-A", "b-user.md": "USER-B" },
            { "z-proj.md": "PROJ-Z" },
        );
        const out = resolveSystemPrompt({}, opts);
        // Base prompt at the start.
        assert.ok(out.startsWith(FAKE_PROMPT), "starts with base prompt");
        // Harness-context delimiter + body.
        assert.ok(out.includes("<!-- harness-context -->"), "harness-context delimiter present");
        assert.ok(out.includes("## Harness execution context"), "harness-context heading present (fragment-owned, not composer-injected)");
        assert.ok(out.includes(FAKE_CONTEXT), "harness-context body present");
        // Guide delimiters + bodies.
        assert.ok(out.includes("<!-- adopter-guide: user/a-user.md -->"), "user guide a delimiter");
        assert.ok(out.includes("USER-A"), "user guide a body");
        assert.ok(out.includes("<!-- adopter-guide: user/b-user.md -->"), "user guide b delimiter");
        assert.ok(out.includes("<!-- adopter-guide: project/z-proj.md -->"), "project guide delimiter");
        assert.ok(out.includes("PROJ-Z"), "project guide body");
    });

    test("composition: harnessContext:false -> harness-context fragment absent", () => {
        __resetCachedBinaryPrompt();
        __resetCachedHarnessContextPrompt();
        const opts = guideOpts({}, {});
        const out = resolveSystemPrompt({ harnessContext: false }, opts);
        assert.equal(out, FAKE_PROMPT, "only base, no context, no guides (empty dirs)");
        assert.ok(!out.includes("<!-- harness-context -->"), "no context delimiter");
    });

    test("composition: harness-context load FAILS (base ok) -> non-fatal, base only, no context heading", () => {
        // F3: the path where the base prompt loads OK but the harness-context
        // load FAILS (runner returns !ok for HARNESS_CONTEXT_PROMPT_KEY). This
        // is the NON-FATAL branch: _loadHarnessContextPrompt returns "" and the
        // classifier keeps just the base prompt (guides are empty here too, so
        // the composed output is base-only). Other composition branches are
        // covered; this pins the base-ok/context-fail failure semantics.
        __resetCachedBinaryPrompt();
        __resetCachedHarnessContextPrompt();
        const runner = (name) => {
            if (name === CLASSIFIER_PROMPT_KEY) {
                return { ok: true, stdout: FAKE_PROMPT, reason: "" };
            }
            if (name === HARNESS_CONTEXT_PROMPT_KEY) {
                return { ok: false, stdout: "", reason: "simulated fragment load failure" };
            }
            return { ok: false, stdout: "", reason: "unknown key" };
        };
        const opts = {
            runner,
            projectGuideDir: "/fake/empty-proj",
            userGuideDir: "/fake/empty-user",
            readDirFn: () => [],
            guideReadFileFn: () => { throw new Error("no guides"); },
        };
        let out;
        // Non-fatal: the harness-context fragment is additive, so a load
        // failure must NOT take down the permission hot path.
        assert.doesNotThrow(() => {
            out = resolveSystemPrompt({}, opts);
        }, "harness-context load failure must be non-fatal (must not throw)");
        // Base prompt is still present.
        assert.ok(out.startsWith(FAKE_PROMPT), "base prompt must survive a harness-context load failure");
        // Harness-context contributed nothing: no fragment-owned heading, no
        // delimiter, no body. (The composer appends NOTHING when ctx is "".)
        assert.ok(!out.includes("## Harness execution context"), "no harness-context heading (load failed -> fragment omitted)");
        assert.ok(!out.includes("<!-- harness-context -->"), "no harness-context delimiter (load failed -> nothing appended)");
        assert.ok(!out.includes(FAKE_CONTEXT), "no harness-context body (load failed -> fragment omitted)");
    });

    test("composition: guides:false -> adopter guides absent", () => {
        __resetCachedBinaryPrompt();
        __resetCachedHarnessContextPrompt();
        const opts = guideOpts(
            { "a-user.md": "USER-A" },
            { "z-proj.md": "PROJ-Z" },
        );
        const out = resolveSystemPrompt({ guides: false }, opts);
        assert.ok(out.startsWith(FAKE_PROMPT), "starts with base");
        assert.ok(out.includes("<!-- harness-context -->"), "context still present");
        assert.ok(out.includes(FAKE_CONTEXT), "context body still present");
        assert.ok(!out.includes("<!-- adopter-guide:"), "no guide delimiters");
        assert.ok(!out.includes("USER-A"), "no user guide body");
        assert.ok(!out.includes("PROJ-Z"), "no project guide body");
    });

    test("composition: no guide files -> base + context only, no error", () => {
        __resetCachedBinaryPrompt();
        __resetCachedHarnessContextPrompt();
        const opts = guideOpts({}, {});
        const out = resolveSystemPrompt({}, opts);
        assert.ok(out.startsWith(FAKE_PROMPT), "starts with base");
        assert.ok(out.includes("<!-- harness-context -->"), "context present");
        assert.ok(out.includes(FAKE_CONTEXT), "context body present");
        assert.ok(!out.includes("<!-- adopter-guide:"), "no guide delimiters");
    });

    test("composition: promptFile set -> composition SKIPPED, file verbatim (regression guard)", () => {
        __resetCachedBinaryPrompt();
        __resetCachedHarnessContextPrompt();
        let runnerCalls = 0;
        const opts = {
            readFileFn: (p) => `CUSTOM from ${p}`,
            runner: () => {
                runnerCalls++;
                return { ok: true, stdout: "SHOULD-NOT-APPEAR", reason: "" };
            },
            // Guide dirs with files — must NOT be read when promptFile is set.
            projectGuideDir: "/fake/proj",
            userGuideDir: "/fake/user",
            readDirFn: () => {
                throw new Error("readDir must not be called when promptFile is set");
            },
            guideReadFileFn: () => {
                throw new Error("guideReadFile must not be called when promptFile is set");
            },
        };
        const out = resolveSystemPrompt({ promptFile: "/override.txt" }, opts);
        assert.equal(out, "CUSTOM from /override.txt");
        assert.equal(runnerCalls, 0, "runner must not be called when promptFile is readable");
    });

    test("composition: deterministic ordering (user-first, project-last, alphabetical)", () => {
        __resetCachedBinaryPrompt();
        __resetCachedHarnessContextPrompt();
        const opts = guideOpts(
            { "b-user.md": "B-USER", "a-user.md": "A-USER" },
            { "z-proj.md": "Z-PROJ", "a-proj.md": "A-PROJ" },
        );
        const out = resolveSystemPrompt({}, opts);
        const posAUser = out.indexOf("<!-- adopter-guide: user/a-user.md -->");
        const posBUser = out.indexOf("<!-- adopter-guide: user/b-user.md -->");
        const posAProj = out.indexOf("<!-- adopter-guide: project/a-proj.md -->");
        const posZProj = out.indexOf("<!-- adopter-guide: project/z-proj.md -->");
        // All four guides present.
        assert.ok(posAUser > -1 && posBUser > -1, "both user guides present");
        assert.ok(posAProj > -1 && posZProj > -1, "both project guides present");
        // User-level first, alphabetical within (a-user before b-user).
        assert.ok(posAUser < posBUser, "user a-user before b-user (alphabetical)");
        // Project-level after user-level, alphabetical within.
        assert.ok(posBUser < posAProj, "user level before project level");
        assert.ok(posAProj < posZProj, "project a-proj before z-proj (alphabetical)");
    });

    // ===== classifyLive (fake fetch; NO real network) =====

    const GOOD_CONFIG = {
        modelEndpoint: "https://provider.example/v1/chat/completions",
        model: "test-model",
        apiKeyEnv: "TEST_GATE_KEY",
        timeoutMs: 5000,
        // maxRetries:0 keeps the existing single-attempt failure tests fast and
        // semantically "one attempt". Retry behavior has its own dedicated tests
        // below that override these two fields explicitly.
        maxRetries: 0,
        retryDelayMs: 0,
    };

    function fakeFetchOk(content) {
        return async () => ({
            status: 200,
            json: async () => ({
                choices: [{ message: { content } }],
            }),
        });
    }

    // Save/restore the named env var around each classifyLive test so a key
    // left over from another test cannot leak in (and so the missing-key test
    // is deterministic).
    function withKey(fn) {
        return async () => {
            const name = GOOD_CONFIG.apiKeyEnv;
            const prev = process.env[name];
            process.env[name] = "test-key-value";
            try {
                await fn();
            } finally {
                if (prev === undefined) delete process.env[name];
                else process.env[name] = prev;
            }
        };
    }

    test("classifyLive: happy path returns choices[0].message.content", withKey(async () => {
        const out = await classifyLive(
            GOOD_CONFIG,
            "serialised input",
            fakeFetchOk("<block>no</block>"),
            fakeRunnerOk(),
        );
        assert.equal(out, "<block>no</block>");
    }));

    test("classifyLive: sends system + user messages, Bearer key, POST", withKey(async () => {
        let captured;
        const fake = async (url, init) => {
            captured = { url, init };
            return {
                status: 200,
                json: async () => ({
                    choices: [{ message: { content: "<block>no</block>" } }],
                }),
            };
        };
        await classifyLive(GOOD_CONFIG, "the input", fake, fakeRunnerOk());
        assert.equal(captured.url, GOOD_CONFIG.modelEndpoint);
        assert.equal(captured.init.method, "POST");
        assert.equal(
            captured.init.headers.Authorization,
            "Bearer test-key-value",
        );
        assert.equal(captured.init.headers["Content-Type"], "application/json");
        const body = JSON.parse(captured.init.body);
        assert.equal(body.model, "test-model");
        assert.equal(body.temperature, 1);
        assert.equal(body.max_tokens, 64);
        assert.equal(body.stream, false);
        assert.equal(body.messages.length, 2);
        assert.equal(body.messages[0].role, "system");
        assert.ok(
            body.messages[0].content.startsWith(FAKE_PROMPT),
            "system message begins with the base prompt (composition may append more)",
        );
        assert.equal(body.messages[1].role, "user");
        assert.equal(body.messages[1].content, "the input");
    }));

    test("classifyLive: non-2xx -> throws", withKey(async () => {
        const fake = async () => ({ status: 500, json: async () => ({}) });
        await assert.rejects(
            () => classifyLive(GOOD_CONFIG, "x", fake, fakeRunnerOk()),
            /non-2xx response: 500/,
        );
    }));

    test("classifyLive: malformed JSON -> throws", withKey(async () => {
        const fake = async () => ({
            status: 200,
            json: async () => {
                throw new Error("bad json");
            },
        });
        await assert.rejects(
            () => classifyLive(GOOD_CONFIG, "x", fake, fakeRunnerOk()),
            /malformed JSON response/,
        );
    }));

    test("classifyLive: missing choices -> throws", withKey(async () => {
        const fake = async () => ({ status: 200, json: async () => ({}) });
        await assert.rejects(
            () => classifyLive(GOOD_CONFIG, "x", fake, fakeRunnerOk()),
            /missing choices\[0\]\.message\.content/,
        );
    }));

    test("classifyLive: empty content string -> throws", withKey(async () => {
        const fake = async () => ({
            status: 200,
            json: async () => ({
                choices: [{ message: { content: "" } }],
            }),
        });
        await assert.rejects(
            () => classifyLive(GOOD_CONFIG, "x", fake, fakeRunnerOk()),
            /missing choices\[0\]\.message\.content/,
        );
    }));

    test("classifyLive: timeout/abort (fetch rejects with AbortError) -> throws", withKey(async () => {
        const fake = async () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            throw e;
        };
        await assert.rejects(
            () => classifyLive(GOOD_CONFIG, "x", fake, fakeRunnerOk()),
            /aborted/,
        );
    }));

    test("classifyLive: missing API key (env unset) -> throws", async () => {
        const name = GOOD_CONFIG.apiKeyEnv;
        const prev = process.env[name];
        delete process.env[name];
        try {
            await assert.rejects(
                () => classifyLive(GOOD_CONFIG, "x", fakeFetchOk("ok")),
                new RegExp(`missing API key.*${name}`),
            );
        } finally {
            if (prev !== undefined) process.env[name] = prev;
        }
    });

    test("classifyLive: missing modelEndpoint -> throws", withKey(async () => {
        await assert.rejects(
            () => classifyLive({ ...GOOD_CONFIG, modelEndpoint: "" }, "x", fakeFetchOk("ok")),
            /missing modelEndpoint/,
        );
    }));

    test("classifyLive: missing model -> throws", withKey(async () => {
        await assert.rejects(
            () => classifyLive({ ...GOOD_CONFIG, model: "" }, "x", fakeFetchOk("ok")),
            /missing model/,
        );
    }));

    test("classifyLive: default apiKeyEnv is AUTO_GATE_API_KEY", async () => {
        const name = "AUTO_GATE_API_KEY";
        const prev = process.env[name];
        process.env[name] = "default-env-key";
        try {
            const out = await classifyLive(
                { modelEndpoint: "https://x", model: "m" }, // no apiKeyEnv field
                "x",
                fakeFetchOk("<block>no</block>"),
                fakeRunnerOk(),
            );
            assert.equal(out, "<block>no</block>");
        } finally {
            if (prev === undefined) delete process.env[name];
            else process.env[name] = prev;
        }
    });

    // ===== DUAL-FORM endpoint + key resolution (literal-preferred) =====
    //
    // Both endpoint and API key support two forms: a literal value (modelEndpoint
    // URL / apiKey value) and an env-var NAME (modelEndpointEnv / apiKeyEnv).
    // When both forms are non-empty, the LITERAL wins. An empty literal (the
    // DEFAULT_LLM_CONFIG default) falls through to the env form. If neither
    // yields a value, classifyLive throws (fail-closed).

    // Helper: a fake fetch that captures the URL (and the headers) it was
    // called with, so tests can assert both the routed endpoint AND the
    // outbound Authorization header.
    function urlCapturingFetch(responseContent) {
        let calledUrl = null;
        let calledHeaders = null;
        const fn = async (url, init) => {
            calledUrl = url;
            calledHeaders = (init && init.headers) || null;
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [{ message: { content: responseContent } }],
                }),
            };
        };
        fn.getUrl = () => calledUrl;
        fn.getHeaders = () => calledHeaders;
        return fn;
    }

    // Helper: save/restore an env var around a test.
    function withEnv(name, value, fn) {
        return async () => {
            const prev = process.env[name];
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
            try {
                return await fn();
            } finally {
                if (prev === undefined) delete process.env[name];
                else process.env[name] = prev;
            }
        };
    }

    test("classifyLive: endpoint from modelEndpointEnv only (env holds URL)", withKey(async () => {
        const envName = "TEST_ENDPOINT_ENV";
        const envUrl = "https://from-env.example/v1/chat";
        const prev = process.env[envName];
        process.env[envName] = envUrl;
        try {
            const fetchFn = urlCapturingFetch("<block>no</block>");
            await classifyLive(
                { ...GOOD_CONFIG, modelEndpoint: "", modelEndpointEnv: envName },
                "x",
                fetchFn,
                fakeRunnerOk(),
            );
            assert.equal(fetchFn.getUrl(), envUrl, "endpoint must come from env var");
        } finally {
            if (prev === undefined) delete process.env[envName];
            else process.env[envName] = prev;
        }
    }));

    test("classifyLive: endpoint BOTH literal + env -> literal wins", withKey(async () => {
        const envName = "TEST_ENDPOINT_ENV";
        const envUrl = "https://from-env.example/v1/chat";
        const literalUrl = "https://from-literal.example/v1/chat";
        const prev = process.env[envName];
        process.env[envName] = envUrl;
        try {
            const fetchFn = urlCapturingFetch("<block>no</block>");
            await classifyLive(
                { ...GOOD_CONFIG, modelEndpoint: literalUrl, modelEndpointEnv: envName },
                "x",
                fetchFn,
                fakeRunnerOk(),
            );
            assert.equal(fetchFn.getUrl(), literalUrl, "literal endpoint must win over env");
            assert.notEqual(fetchFn.getUrl(), envUrl, "env endpoint must NOT be used");
        } finally {
            if (prev === undefined) delete process.env[envName];
            else process.env[envName] = prev;
        }
    }));

    test("classifyLive: endpoint neither literal nor env set -> throws", withKey(async () => {
        const envName = "TEST_ENDPOINT_UNSET_ENV";
        const prev = process.env[envName];
        delete process.env[envName];
        try {
            await assert.rejects(
                () => classifyLive(
                    { ...GOOD_CONFIG, modelEndpoint: "", modelEndpointEnv: envName },
                    "x",
                    fakeFetchOk("ok"),
                ),
                /missing modelEndpoint/,
            );
        } finally {
            if (prev !== undefined) process.env[envName] = prev;
        }
    }));

    test("classifyLive: key from literal apiKey (no env needed)", async () => {
        // No env var set — the literal apiKey in config is used directly.
        const fetchFn = urlCapturingFetch("<block>no</block>");
        const out = await classifyLive(
            {
                modelEndpoint: "https://x",
                model: "m",
                apiKey: "literal-key-value",
                apiKeyEnv: "UNSET_TEST_KEY_ENV",
            },
            "x",
            fetchFn,
            fakeRunnerOk(),
        );
        assert.equal(out, "<block>no</block>", "literal apiKey must work without env");
    });

    test("classifyLive: key BOTH literal apiKey + apiKeyEnv -> literal wins", async () => {
        const envName = "TEST_KEY_BOTH_ENV";
        // Distinct, obviously-different values so the header assertion is
        // unambiguous: the literal key is the only one that may appear in the
        // outbound Authorization header.
        const literalValue = "lit-key-value-123";
        const envValue = "env-key-value-456";
        const prev = process.env[envName];
        process.env[envName] = envValue;
        try {
            // The literal key is used; the env key is NOT consulted. We prove
            // this by capturing the outbound Authorization header and asserting
            // it carries ONLY the LITERAL key value — if the env-var form had
            // won, the header would carry envValue instead. The success
            // assertion is retained; the header assertions are added on top.
            const fetchFn = urlCapturingFetch("<block>no</block>");
            const out = await classifyLive(
                {
                    modelEndpoint: "https://x",
                    model: "m",
                    apiKey: literalValue,
                    apiKeyEnv: envName,
                },
                "x",
                fetchFn,
                fakeRunnerOk(),
            );
            assert.equal(out, "<block>no</block>", "call must succeed with literal key");
            const headers = fetchFn.getHeaders();
            const auth = headers && headers.Authorization;
            assert.equal(
                auth,
                `Bearer ${literalValue}`,
                "outbound Authorization must carry the LITERAL apiKey",
            );
            assert.ok(
                typeof auth === "string" && !auth.includes(envValue),
                "outbound Authorization must NOT contain the env-var key value",
            );
        } finally {
            if (prev === undefined) delete process.env[envName];
            else process.env[envName] = prev;
        }
    });

    test("classifyLive: key from apiKeyEnv only (env holds key) -> existing behavior", async () => {
        const envName = "TEST_KEY_ENV_ONLY";
        const prev = process.env[envName];
        process.env[envName] = "env-key-value";
        try {
            const out = await classifyLive(
                {
                    modelEndpoint: "https://x",
                    model: "m",
                    apiKey: "", // no literal key -> falls through to env
                    apiKeyEnv: envName,
                },
                "x",
                fakeFetchOk("<block>no</block>"),
                fakeRunnerOk(),
            );
            assert.equal(out, "<block>no</block>", "env-only key must work");
        } finally {
            if (prev === undefined) delete process.env[envName];
            else process.env[envName] = prev;
        }
    });

    test("classifyLive: key neither literal nor env set -> throws", async () => {
        const envName = "TEST_KEY_NEITHER_ENV";
        const prev = process.env[envName];
        delete process.env[envName];
        try {
            await assert.rejects(
                () => classifyLive(
                    {
                        modelEndpoint: "https://x",
                        model: "m",
                        apiKey: "",
                        apiKeyEnv: envName,
                    },
                    "x",
                    fakeFetchOk("ok"),
                ),
                /missing API key/,
            );
        } finally {
            if (prev !== undefined) process.env[envName] = prev;
        }
    });

    // ===== classifyLive retry loop (transient-failure recovery) =====
    //
    // These tests pin the retry policy: which failures retry, which fail
    // immediately, the attempt count, the retry count, and linear backoff.
    // retryDelayMs:0 keeps them fast (the backoff timing test uses a small
    // nonzero value with wall-clock slack). Each test uses a call-counting
    // fake fetch so the attempt count is asserted exactly — NO real network.

    // Helper: a fake fetch whose nth call behavior comes from a list of step
    // factories. A step is either { throw:"abort" } / { throw:"network", msg }
    // / { status, content } / { status } / { empty:true }. Calls past the last
    // step repeat the last step.
    function stepFetch(steps) {
        let calls = 0;
        const fn = async () => {
            const idx = Math.min(calls, steps.length - 1);
            const step = steps[idx];
            calls++;
            if (step && step.throw) {
                if (step.throw === "abort") {
                    const e = new Error(step.msg || "aborted");
                    e.name = "AbortError";
                    throw e;
                }
                throw new Error(step.msg || "ECONNRESET");
            }
            const status = (step && step.status) || 200;
            const content = step && Object.prototype.hasOwnProperty.call(step, "content")
                ? step.content
                : "<block>no</block>";
            const json = step && step.empty
                ? {}
                : { choices: [{ message: { content } }] };
            return { status, json: async () => json };
        };
        fn.callCount = () => calls;
        return fn;
    }

    test("retry (a): 1st attempt aborts, 2nd succeeds -> content, retries=1", withKey(async () => {
        const fake = stepFetch([{ throw: "abort" }, { content: "<block>no</block>" }]);
        const out = await classifyLive(
            { ...GOOD_CONFIG, maxRetries: 1, retryDelayMs: 0 },
            "x", fake, fakeRunnerOk(),
        );
        assert.equal(out, "<block>no</block>");
        assert.equal(fake.callCount(), 2, "must retry exactly once");
    }));

    test("retry (b): all attempts abort -> throws last error, deny path", withKey(async () => {
        const fake = stepFetch([{ throw: "abort" }]);
        await assert.rejects(
            () => classifyLive({ ...GOOD_CONFIG, maxRetries: 2, retryDelayMs: 0 }, "x", fake, fakeRunnerOk()),
            /aborted/,
        );
        assert.equal(fake.callCount(), 3, "1 initial + 2 retries = 3 attempts");
    }));

    test("retry (c): 4xx -> NOT retried, immediate throw (deny path)", withKey(async () => {
        const fake = stepFetch([{ status: 404 }]);
        await assert.rejects(
            () => classifyLive({ ...GOOD_CONFIG, maxRetries: 3, retryDelayMs: 0 }, "x", fake, fakeRunnerOk()),
            /non-2xx response: 404/,
        );
        assert.equal(fake.callCount(), 1, "4xx must NOT retry");
    }));

    test("retry (d): maxRetries:0 -> exactly one attempt even on retryable failure", withKey(async () => {
        const fake = stepFetch([{ throw: "abort" }]);
        await assert.rejects(
            () => classifyLive({ ...GOOD_CONFIG, maxRetries: 0, retryDelayMs: 0 }, "x", fake, fakeRunnerOk()),
            /aborted/,
        );
        assert.equal(fake.callCount(), 1, "maxRetries:0 = single attempt");
    }));

    test("retry: 5xx is retryable, exhausts attempts then throws", withKey(async () => {
        const fake = stepFetch([{ status: 503 }]);
        await assert.rejects(
            () => classifyLive({ ...GOOD_CONFIG, maxRetries: 1, retryDelayMs: 0 }, "x", fake, fakeRunnerOk()),
            /non-2xx response: 503/,
        );
        assert.equal(fake.callCount(), 2);
    }));

    test("retry: 2xx empty content is retryable", withKey(async () => {
        const fake = stepFetch([{ empty: true }]);
        await assert.rejects(
            () => classifyLive({ ...GOOD_CONFIG, maxRetries: 1, retryDelayMs: 0 }, "x", fake, fakeRunnerOk()),
            /missing choices\[0\]\.message\.content/,
        );
        assert.equal(fake.callCount(), 2);
    }));

    test("retry: transport error (ECONNRESET) is retryable, then success", withKey(async () => {
        const fake = stepFetch([{ throw: "network", msg: "ECONNRESET" }, { content: "<block>no</block>" }]);
        const out = await classifyLive(
            { ...GOOD_CONFIG, maxRetries: 1, retryDelayMs: 0 },
            "x", fake, fakeRunnerOk(),
        );
        assert.equal(out, "<block>no</block>");
        assert.equal(fake.callCount(), 2);
    }));

    test("retry: malformed JSON is NOT retryable", withKey(async () => {
        const fake = async () => ({
            status: 200,
            json: async () => { throw new Error("bad json"); },
        });
        let calls = 0;
        const counting = async (...a) => { calls++; return fake(...a); };
        await assert.rejects(
            () => classifyLive({ ...GOOD_CONFIG, maxRetries: 3, retryDelayMs: 0 }, "x", counting, fakeRunnerOk()),
            /malformed JSON/,
        );
        assert.equal(calls, 1, "malformed JSON must NOT retry");
    }));

    test("retry: defaults to maxRetries:1 when config omits the fields", withKey(async () => {
        // A config with NO maxRetries/retryDelayMs (and no GOOD_CONFIG spread)
        // must pick up the internal defaults: 1 retry. 1st abort -> 1 retry.
        const fake = stepFetch([{ throw: "abort" }, { content: "<block>no</block>" }]);
        const out = await classifyLive(
            { modelEndpoint: "https://x", model: "m", apiKeyEnv: "TEST_GATE_KEY", timeoutMs: 5000 },
            "x", fake, fakeRunnerOk(),
        );
        assert.equal(out, "<block>no</block>");
        assert.equal(fake.callCount(), 2, "default maxRetries=1 -> one retry");
    }));

    test("retry: linear backoff sleeps retryDelayMs*(N-1) before each retry", withKey(async () => {
        // attempt 1 aborts -> sleep retryDelayMs*1 -> attempt 2 succeeds.
        // Wall-clock assertion with slack (scheduler jitter). retryDelayMs is
        // small but nonzero so the sleep is observable without slowing the suite.
        const fake = stepFetch([{ throw: "abort" }, { content: "<block>no</block>" }]);
        const t0 = Date.now();
        await classifyLive(
            { ...GOOD_CONFIG, maxRetries: 1, retryDelayMs: 40 },
            "x", fake, fakeRunnerOk(),
        );
        const elapsed = Date.now() - t0;
        // delay before attempt 2 = 40*1 = 40ms. Allow a little slack downward.
        assert.ok(elapsed >= 30, `expected >=30ms backoff (40ms), got ${elapsed}ms`);
    }));

    test("retry: classifyLive returns content string (unchanged contract)", withKey(async () => {
        // classifyLive's PUBLIC contract is still the content string (not an
        // object); only decideLive surfaces the retry count.
        const fake = stepFetch([{ content: "<block>no</block>" }]);
        const out = await classifyLive(
            { ...GOOD_CONFIG, maxRetries: 2, retryDelayMs: 0 },
            "x", fake, fakeRunnerOk(),
        );
        assert.equal(typeof out, "string");
        assert.equal(out, "<block>no</block>");
        assert.equal(fake.callCount(), 1);
    }));

    // ===== decideLive — fail-closed wiring (fake transport) =====

    test("decideLive: happy <block>no</block> -> allow", withKey(async () => {
        const r = await decideLive(GOOD_CONFIG, "input", fakeFetchOk("<block>no</block>"), fakeRunnerOk());
        assert.equal(r.status, "allow");
        assert.equal(r.audit, "");
        assert.ok(typeof r.latencyMs === "number");
    }));

    test("decideLive: happy <block>yes</block> -> deny with reason", withKey(async () => {
        const r = await decideLive(
            GOOD_CONFIG,
            "input",
            fakeFetchOk("<block>yes</block><reason>[scope-creep] too broad</reason>"),
            fakeRunnerOk(),
        );
        assert.equal(r.status, "deny");
        assert.match(r.audit, /blocked:/);
        assert.equal(r.reason, "[scope-creep] too broad");
    }));

    test("decideLive: adapter throws (timeout) -> deny (fail-closed)", withKey(async () => {
        const fake = async () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            throw e;
        };
        const r = await decideLive(GOOD_CONFIG, "input", fake, fakeRunnerOk());
        assert.equal(r.status, "deny");
        assert.match(r.audit, /fail-closed: evaluator error/);
    }));

    test("decideLive: misconfigured (no modelEndpoint) -> deny (fail-closed)", withKey(async () => {
        const r = await decideLive(
            { ...GOOD_CONFIG, modelEndpoint: "" },
            "input",
            fakeFetchOk("<block>no</block>"),
        );
        assert.equal(r.status, "deny");
        assert.match(r.audit, /missing modelEndpoint/);
    }));

    test("decideLive: misconfigured (no model) -> deny (fail-closed)", withKey(async () => {
        const r = await decideLive(
            { ...GOOD_CONFIG, model: "" },
            "input",
            fakeFetchOk("<block>no</block>"),
        );
        assert.equal(r.status, "deny");
        assert.match(r.audit, /missing model/);
    }));

    test("decideLive: unparseable verdict -> deny (fail-closed)", withKey(async () => {
        const r = await decideLive(
            GOOD_CONFIG,
            "input",
            fakeFetchOk("no block tag here"),
            fakeRunnerOk(),
        );
        assert.equal(r.status, "deny");
        assert.equal(r.audit, "fail-closed: unparseable verdict");
    }));

    test("decideLive: missing API key -> deny (fail-closed)", async () => {
        const name = GOOD_CONFIG.apiKeyEnv;
        const prev = process.env[name];
        delete process.env[name];
        try {
            const r = await decideLive(GOOD_CONFIG, "input", fakeFetchOk("ok"));
            assert.equal(r.status, "deny");
            assert.match(r.audit, /missing API key/);
        } finally {
            if (prev !== undefined) process.env[name] = prev;
        }
    });

    test("decideLive: retry count surfaces in result.retries (telemetry)", withKey(async () => {
        // 1st attempt aborts (retryable), 2nd succeeds. decideLive must surface
        // retries=1 in its result so the live-decision audit line can append
        // `retries=N`. The audit-line string itself lives in auto-tool-gate.js;
        // this test pins the value that flows into it.
        const fake = stepFetch([{ throw: "abort" }, { content: "<block>no</block>" }]);
        const r = await decideLive(
            { ...GOOD_CONFIG, maxRetries: 1, retryDelayMs: 0 },
            "input", fake, fakeRunnerOk(),
        );
        assert.equal(r.status, "allow");
        assert.equal(r.retries, 1, "one retry must surface as retries=1");
    }));

    test("decideLive: no retries -> retries=0", withKey(async () => {
        const r = await decideLive(GOOD_CONFIG, "input", fakeFetchOk("<block>no</block>"), fakeRunnerOk());
        assert.equal(r.status, "allow");
        assert.equal(r.retries, 0);
    }));

    // ===== decideLive: retries telemetry on the THROW path (telemetry-fix regression) =====
    //
    // The retry count was previously LOST whenever _classifyLiveCore threw (on
    // a non-retryable error, or after exhausting all retry attempts): the
    // locally-tracked `retries` was discarded at the throw, so decideLive
    // reported retries=0 on EVERY fail-closed path. These tests pin the fix:
    // the surfaced `retries` must equal the number of retries that actually
    // occurred, across all throw shapes.
    //
    // Cross-check against the HTTP-level integration suite
    // (tests/integration/auto-gate-live-http/): that suite proves retries
    // HAPPEN via the mock's per-scenario request counter (count = attempts =
    // retries + 1). The unit-test `retries` value here must match that count
    // minus one. The integration suite is NOT modified by this fix.

    test("decideLive-telemetry: retries-exhausted -> deny surfaces retries=N (NOT 0)", withKey(async () => {
        // attempt 1 abort (retryable) -> retry
        // attempt 2 abort (retryable) -> retry
        // attempt 3 abort -> exhaust, throw last error -> fail-closed deny.
        // 2 retries occurred; telemetry must report retries=2.
        const fake = stepFetch([
            { throw: "abort" },
            { throw: "abort" },
            { throw: "abort" },
        ]);
        const r = await decideLive(
            { ...GOOD_CONFIG, maxRetries: 2, retryDelayMs: 0 },
            "input", fake, fakeRunnerOk(),
        );
        assert.equal(r.status, "deny");
        assert.match(r.audit, /fail-closed: evaluator error/);
        assert.equal(
            r.retries, 2,
            "2 retries occurred before the throw; telemetry must report retries=2, not 0 (the bug)",
        );
        assert.equal(fake.callCount(), 3, "1 initial + 2 retries = 3 attempts");
    }));

    test("decideLive-telemetry: non-retryable 4xx after a prior retry -> deny surfaces retries=N", withKey(async () => {
        // attempt 1 abort (retryable) -> retry (1 retry consumed)
        // attempt 2 4xx (non-retryable) -> immediate throw -> fail-closed deny.
        // 1 retry occurred before the 4xx; telemetry must report retries=1.
        const fake = stepFetch([{ throw: "abort" }, { status: 404 }]);
        const r = await decideLive(
            { ...GOOD_CONFIG, maxRetries: 3, retryDelayMs: 0 },
            "input", fake, fakeRunnerOk(),
        );
        assert.equal(r.status, "deny");
        assert.match(r.audit, /non-2xx response: 404/);
        assert.equal(
            r.retries, 1,
            "1 retry occurred before the non-retryable 4xx; telemetry must report retries=1, not 0 (the bug)",
        );
        assert.equal(fake.callCount(), 2, "1 initial + 1 retry = 2 attempts");
    }));

    test("decideLive-telemetry: immediate non-retryable 4xx (no prior retry) -> deny surfaces retries=0", withKey(async () => {
        // attempt 1 4xx (non-retryable) -> immediate throw, NO retries.
        // Pins the boundary: the fix must not inflate retries on a path where
        // zero retries occurred.
        const fake = stepFetch([{ status: 404 }]);
        const r = await decideLive(
            { ...GOOD_CONFIG, maxRetries: 3, retryDelayMs: 0 },
            "input", fake, fakeRunnerOk(),
        );
        assert.equal(r.status, "deny");
        assert.match(r.audit, /non-2xx response: 404/);
        assert.equal(r.retries, 0, "no retries occurred; telemetry must report retries=0");
        assert.equal(fake.callCount(), 1, "4xx must NOT retry");
    }));

    test("decideLive-telemetry: misconfiguration throw (no retries) -> deny surfaces retries=0", withKey(async () => {
        // Pre-loop throw (missing modelEndpoint) carries no .retries stamp;
        // the typeof fallback must yield 0. Pins that the fix correctly
        // distinguishes in-loop throws (stamped) from pre-loop throws (unstamped).
        const r = await decideLive(
            { ...GOOD_CONFIG, modelEndpoint: "" },
            "input",
            fakeFetchOk("<block>no</block>"),
        );
        assert.equal(r.status, "deny");
        assert.match(r.audit, /missing modelEndpoint/);
        assert.equal(r.retries, 0, "misconfiguration (pre-loop throw) must surface retries=0");
    }));

    // ===== Default posture: live path is OPT-IN =====

    test("default posture: classifyLive/decideLive are only reachable when explicitly invoked", () => {
        // The plugin gates the live path behind `config.mode === "live"`. audit
        // (default) and enforce branches never call into this module. The verdict
        // module's own suite covers that audit/enforce behavior is unchanged; this
        // test pins that the live composition surface is a pure function that does
        // nothing unless the plugin actually calls it — i.e. there is no module-
        // level side effect that could affect audit mode.
        // (No-op assertion: importing this module executes no hooks and no I/O.)
        assert.equal(typeof classifyLive, "function");
        assert.equal(typeof decideLive, "function");
        assert.equal(typeof serializeTranscript, "function");
    });
}
