// auto-tool-gate.js — dual-surface plugin: audit + fail-closed enforce + live
// (Phases 1–3b pilot).
//
// This is the opt-in pilot for an auto-classifier-style tool-call gate. It
// hooks BOTH permission surfaces. Behavior is selected by the live config
// `mode` field (default `audit`):
//
//   mode "audit"   (Phase 1, default) — observability only. Both hooks log to
//                  stderr with a verdict PLACEHOLDER. No model call, no real
//                  verdict, no status mutation, no blocking. Zero behavior
//                  change.
//   mode "enforce" (Phase 2)          — permission.ask runs the decision path
//                  (stubEvaluate -> parseVerdict -> matrix) and sets
//                  output.status. Fail-closed: ANY uncertainty (parse failure,
//                  evaluator error, thrown exception) -> deny, NEVER silent
//                  allow. tool.execute.before stays an OBSERVER in every mode.
//                  The Phase 2 evaluator is a DETERMINISTIC STUB, not a real
//                  classifier model.
//   mode "live"    (Phase 3b)         — permission.ask fetches the real
//                  transcript, serializes it to a redacted text-mode string,
//                  and calls a provider-agnostic OpenAI-compatible HTTP
//                  completion endpoint (see ./auto-gate-live.js). The returned
//                  verdict text is fed through the SAME parseVerdict -> decision
//                  matrix as enforce, so the existing fail-closed matrix
//                  applies: any transport error / timeout / non-2xx / malformed
//                  / missing-choices / misconfigured-endpoint / missing-API-key
//                  -> deny, NEVER silent allow. tool.execute.before stays an
//                  OBSERVER. The API key is read from the named env var at call
//                  time; it NEVER lives in the (commitable) config file.
//
// THREE HOOKS, ONE ENFORCEMENT SURFACE (verified against @opencode-ai/plugin
// + sdk types + the upstream's shipped ACP / CLI / TUI reference impls):
//
//   1. tool.execute.before  (input:{tool,sessionID,callID}, output:{args})
//      AUDIT-ONLY observer. Sees EVERY tool call — including ones the
//      permission table auto-allows (those never reach permission.asked).
//      Powers: block (throw) or passthrough (bare return) ONLY. Cannot
//      force-allow or force-ask. We use it purely to observe the full
//      tool-call stream and capture the arg summary. It stays an OBSERVER
//      in EVERY mode — it must NOT throw or block in the new model; the
//      event hook owns enforcement.
//
//   2. permission.ask  (input:Permission, output:{status})
//      DORMANT — OpenCode does not fire `permission.ask` in any stock
//      release as of the studied version. The hook is RETAINED as a RESERVE
//      in case upstream wires it (preserves the Phase 2/3b investment).
//      Do NOT rely on it. No claim of auto-approval rests on this hook.
//
//   3. event  ({ event }) — the PRIMARY ENFORCEMENT SURFACE.
//      Receives EVERY bus event. Acts only on `permission.asked` — the event
//      OpenCode publishes when its ruleset routes a tool call to "ask". The
//      event payload is the Request {id, sessionID, permission, patterns,
//      metadata, always, tool}. The hook classifies it and REPLIES via the
//      SDK client: client.postSessionIdPermissionsPermissionId({path:{id,
//      permissionID}, body:{response}}) → resolves the Deferred Permission.ask
//      is awaiting → tool proceeds (allow) or is blocked (reject). This is
//      the SAME mechanism the upstream ships in its ACP agent,
//      `--dangerously-skip-permissions`, and TUI.
//
//      CRITICAL HEADLESS: if NO ONE replies to permission.asked, the Deferred
//      never resolves and the tool call HANGS. In autonomous modes (enforce/
//      live) the hook MUST reply. Audit mode (observe-only) and
//      onUncertain:"passthrough" (interactive only) are the only no-reply
//      paths.
//
// HARD-FLOOR INVARIANT: the event hook fires ONLY for ask-routed calls
// (table-allow fast-paths past the bus event; table-deny / shell-guard blocks
// before it). The classifier can NEVER override a static deny. It only ever
// decides the ask-routed subset. The static permission table is the first
// gate; the classifier runs strictly after it.
//
// Phase status:
//   Phase 3b (implemented here) — live classifier model wired into
//             permission.ask behind mode:"live" (replaces the enforce stub with
//             a real OpenAI-compatible HTTP call via ./auto-gate-live.js).
//   Phase 4   (later slice)     — promotion review (core-template /
//             README.agent.md).
// Reconciliation rule those phases must preserve: static deny wins; static
// failure denies; LLM allow only valid when no lower layer denied; LLM
// failure/timeout/malformed blocks.
//
// Naming: all identifiers here are GENERIC (auto-tool-gate / auto-gate-audit).
// The upstream mechanism is referred to only as "the reference agent system" /
// "a security-monitor classifier" — never by product name.
//
// Plugin contract (mirrors .opencode/plugins/shell-guard.js + session-state.js):
//   export const server = async ({ client, directory }) => ({
//       // The factory receives the full PluginInput; we close over `client` (the
//       // OpenCode SDK client, used in mode:"live" to fetch the session
//       // transcript) and `directory` (the repo dir, used as the SDK query
//       // param). Same pattern session-state.js uses for client.session.todo().
//       "tool.execute.before": async (input, output) => {
//           // input.tool  → tool name (string)
//           // output.args → { command, workdir, filePath, path, pattern, ... }
//           // throw new Error(reason)        → BLOCKS the tool call
//           // console.error(reason); return; → ASK (passthrough to perm table)
//           // return;                        → ALLOW / passthrough (do nothing)
//       },
//       "permission.ask": async (input, output) => {
//           // input  → Permission {id, type, pattern, sessionID, messageID,
//           //                       callID?, title, metadata:{}, time:{created}}
//           // output → {status:"ask"|"deny"|"allow"} (default "ask")
//           // output.status = "allow" → GRANT + skip user prompt
//           // output.status = "deny"  → BLOCK
//           // output.status = "ask"   → trigger interactive prompt (default)
//           // bare return             → leave status unchanged (Phase 1)
//       }
//   });
//
// OpenCode auto-discovers plugins from .opencode/plugins/*.js — no
// registration in opencode.jsonc is required (confirmed: shell-guard.js,
// session-state.js, and maxoutputtokens.js all load with no "plugins" key).
// This file renders from the auto-classifier-pilot overlay pack's
// plugins/auto-tool-gate.js unit into .opencode/plugins/auto-tool-gate.js.
//
// ---------------------------------------------------------------------------
// Live hot-config substrate (reload-free).
//
// Auto-mode is configurable WITHOUT restarting OpenCode: each hook invocation
// reads a small operator-owned JSON config file from disk, gated by an mtime
// cache so an unchanged file costs only a single `statSync` per call. Editing
// the file takes effect on the NEXT tool call. The OpenCode plugin SDK has no
// native hot-reload config API (the `config` hook and `PluginOptions` are
// load-time, set at server start; env vars are frozen at process start), but
// plugins CAN do file I/O at runtime — same pattern shell-guard.js uses
// (node:fs + node:path, per-call statSync/readFile). See readConfig() below
// and the README's "Live configuration" section.
//
// Fail-safe: a missing / unreadable / invalid config file NEVER throws — the
// plugin falls back to built-in defaults ({enabled:true, mode:"audit"}) and
// emits one console.error audit line per failure-state transition.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// node:test + node:assert imported STATICALLY so the self-test registers
// SYNCHRONOUSLY when run directly (no top-level await). INERT on the import
// path: importing them does not start a test runner — only the test() CALLS do,
// guarded behind __isMain so the plugin-loader path (OpenCode importing this
// module for its `server` export) never fires the suite.
import { test } from "node:test";
import { strict as assert } from "node:assert";

// Pure verdict-parse + decision layer (Phase 2). Mirrors the shell-guard.js ->
// shell-guard-core.js pattern: the plugin imports ONE decision module and
// never re-implements parsing. decidePermission(config) composes
// stubEvaluate(config) -> parseVerdict(raw) -> decision matrix, fail-closed to
// deny on any uncertainty. See ./auto-gate-verdict.js for the contract.
import { decidePermission } from "./auto-gate-verdict.js";

// Live classifier substrate (Phase 3b): transcript serializer + generic
// domain-free system prompt + OpenAI-compatible HTTP adapter + the decideLive
// bridge. Only reachable when config.mode === "live". The audit and enforce
// branches below do NOT touch this module, so they are unchanged by Phase 3b.
import { decideLive, serializeTranscript } from "./auto-gate-live.js";

// Shared credential scrubber (egress-safe): auto-tool-gate.js is the
// AUDIT/STDERR-LOG egress surface. Every tool-call-derived value that reaches a
// console.error line (summarizeArgs output + the permission.ask `pattern`)
// passes through scrubTruncate (scrubCredentials then truncate), NOT truncate
// alone, so a credential embedded in a `command`/`pattern` cannot survive into
// the stderr log. The IDENTICAL scrubber is shared with the HTTP-egress path
// (auto-gate-live.js) via this module — no drift.
import { scrubTruncate } from "./auto-gate-scrub.js";

// Tiered-consensus aggregation core (Phase 2): normalizes each leaf outcome
// (the SAME {status, audit, reason, latencyMs, retries} shape decideLive
// returns — no adapter needed) and applies the unanimous-allow policy. Only
// reachable when config.mode === "live-tiered". The audit/enforce/live branches
// below do NOT touch this module, so they are unchanged by Phase 2. The core
// is pure and behavior-frozen (its own 47-test suite covers the policy); here
// we only IMPORT and USE it.
import {
    normalizeLeafOutcome,
    aggregateLeafOutcomes,
} from "./auto-gate-tiered.js";

export const id = "auto-tool-gate";

// ESM does not provide __dirname (the OpenCode plugin runtime loads these as
// ES modules). Derive it the same way shell-guard-core.js / state-lib.js do,
// so repoRoot() + CONFIG_PATH resolve correctly at module-load time.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Maximum length of any single argument value in the audit summary. Long
// command strings, file bodies, or structured payloads are truncated so the
// audit line stays a one-liner suitable for stderr log scraping.
const MAX_ARG_LEN = 160;

// Build a short, REDACTED argument summary for the audit line. We deliberately
// surface only the load-bearing IDENTIFYING fields (command, path, pattern,
// query, url, workdir) and NEVER dump the full args object — tool inputs can
// carry large file bodies, edit diffs, or sensitive payloads that have no
// place in a one-line audit log. Unknown / unhandled tools get an arg-key
// count summary only, so the audit still records that the tool was called
// without leaking its payload.
//
// SECURITY: every allowlisted field value passes through scrubTruncate
// (scrubCredentials THEN truncate, from the shared auto-gate-scrub.js), NOT
// truncate alone. This audit line lands on stderr — which the OpenCode/server
// process writes to its stderr log — so a Bearer token / API key / DB
// connection string embedded in a judged `command` or `pattern` MUST be
// scrubbed the same way the HTTP-egress path scrubs it. Before this fix a
// `curl -H "Authorization: Bearer <token>"` command leaked the token verbatim
// into the stderr log (truncate-only). Now the token is [redacted] before the
// audit line is ever written.
function summarizeArgs(args) {
    if (!args || typeof args !== "object") return "";
    const parts = [];
    // bash / shell tool: the command string is the identifying input.
    if (typeof args.command === "string") {
        parts.push(`command=${scrubTruncate(args.command, MAX_ARG_LEN)}`);
    }
    // read / edit / write / glob / grep: the target path identifies the call.
    const fp = args.filePath ?? args.path;
    if (typeof fp === "string") {
        parts.push(`path=${scrubTruncate(fp, MAX_ARG_LEN)}`);
    }
    // glob / grep: the pattern/query scopes the call.
    if (typeof args.pattern === "string") {
        parts.push(`pattern=${scrubTruncate(args.pattern, MAX_ARG_LEN)}`);
    }
    if (typeof args.query === "string") {
        parts.push(`query=${scrubTruncate(args.query, MAX_ARG_LEN)}`);
    }
    // webfetch: the url identifies the call.
    if (typeof args.url === "string") {
        parts.push(`url=${scrubTruncate(args.url, MAX_ARG_LEN)}`);
    }
    // workdir disambiguates cwd-sensitive tools (bash).
    if (typeof args.workdir === "string") {
        parts.push(`workdir=${scrubTruncate(args.workdir, MAX_ARG_LEN)}`);
    }
    // If nothing load-bearing matched, emit only an arg-key count so the line
    // still records that the tool was called with structured input.
    if (parts.length === 0) {
        const keys = Object.keys(args);
        parts.push(`args=${keys.length}`);
    }
    return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Hot-config reader.
//
// Resolves the operator-owned config file relative to the repo root, the same
// way shell-guard-core.js derives repoRoot() (from this file's location —
// .opencode/plugins/auto-tool-gate.js -> two levels up). Never uses
// process.cwd() (unreliable in the plugin server context). No hardcoded
// absolute paths.
function repoRoot() {
    return path.resolve(__dirname, "..", "..");
}

// ---------------------------------------------------------------------------
// Two-file live config model (reload-free).
//
// Config is split across TWO sibling files so that LLM secrets-adjacent
// settings can NEVER be committed while plugin behavior MAY be committed (or
// not) at the adopter's choice:
//
//   1. Plugin config → auto-gate-config.json (EXISTING path, kept).
//      Holds the plugin-BEHAVIOR fields: {enabled, mode, stubVerdict, promptFile,
//      replyMode, onUncertain}. Committability: ADOPTER'S CHOICE — a team may
//      commit a shared default (e.g. {"mode":"enforce"}). NOT gitignored.
//      Fail-safe defaults: missing/invalid → {enabled:true, mode:"audit",
//      stubVerdict:"block", promptFile:"", replyMode:"once", onUncertain:"reject"}.
//
//   2. LLM config    → auto-gate-llm.json  (sibling file).
//      Holds the LLM fields: {modelEndpoint, modelEndpointEnv, model, apiKey,
//      apiKeyEnv, timeoutMs, maxRetries, retryDelayMs, leaves}. Committability:
//      NEVER — gitignored in the dogfood repo (adopters add the pattern to their
//      own .gitignore). Fail-safe defaults: missing/invalid → {modelEndpoint:"",
//      modelEndpointEnv:"AUTO_GATE_MODEL_ENDPOINT", model:"", apiKey:"",
//      apiKeyEnv:"AUTO_GATE_API_KEY", timeoutMs:8000, maxRetries:1,
//      retryDelayMs:500, leaves:[]}. A MISSING LLM file is NORMAL (only needed
//      for live mode) and is SILENT — no audit spam; audit/enforce modes must
//      NOT fail because the LLM file is absent. In live mode a missing/empty
//      modelEndpoint/model fail-closes to deny via the existing decision path.
//      Endpoint + key each support a DUAL form, literal-preferred (see
//      DEFAULT_LLM_CONFIG below for the resolution rule).
//
// THREE-LEVEL LAYERED LOADING (defaults ← user ← project):
//
//   Each config TYPE (plugin, LLM) is loaded from up to TWO files and merged
//   field-by-field (shallow merge). Precedence is PROJECT > USER > DEFAULT:
//
//     - PROJECT-level (the existing files under .opencode/repo-configs/) —
//       per-repo override. The committability rules above apply here.
//     - USER-level (under <XDG_CONFIG_HOME>/vh-agent-harness/) — a shared
//       base across ALL of an operator's projects. Filenames MIRROR the
//       project-level names (auto-gate-config.json / auto-gate-llm.json) so the
//       override relationship is obvious: "same file, user-level base,
//       project-level override." A user-level file is OPTIONAL — its absence is
//       the normal case (most operators have only project-level config) and is
//       SILENT (no audit spam), exactly like a missing project-level LLM file.
//       Only a PRESENT-but-invalid user-level file emits an audit line (labeled
//       with the level: "plugin/user", "llm/user").
//     - DEFAULTS — the hardcoded fail-safe fallbacks below.
//
//   Both-missing (user AND project) for a type → fail-safe defaults, exactly
//   today's behavior: the project-level "missing" audit line fires for the
//   plugin config (existing behavior), and both levels are silent for the LLM
//   config (its missing file is the normal no-live-setup case).
//
// Backward-compat (CLEAN CUT): an operator may still have LLM fields in the
// OLD auto-gate-config.json. They are IGNORED entirely — readConfig() returns
// ONLY the six plugin-behavior fields. This is a freshly-shipped pilot with
// no real install base, so a clean cut (no deprecation fallback) is safe and
// keeps the two files strictly disjoint. LLM fields MUST come from
// auto-gate-llm.json.
//
// The API key supports a DUAL form, literal-preferred: a literal `apiKey`
// value OR an `apiKeyEnv` env-var NAME (default AUTO_GATE_API_KEY). The literal
// wins when both are non-empty; otherwise the value is read from
// process.env[apiKeyEnv] at call time inside classifyLive. The endpoint mirrors
// this: a literal `modelEndpoint` URL OR a `modelEndpointEnv` env-var NAME
// (default AUTO_GATE_MODEL_ENDPOINT), literal-preferred.
//
// Merge point: the live branch builds ONE merged object
// ({...readConfig(), ...readLlmConfig()}) so downstream decideLive /
// classifyLive / resolveSystemPrompt see a single config as before. The audit
// and enforce branches only need readConfig() (plugin behavior). Each of those
// readers already returns the fully three-level-merged result for its type.
// ---------------------------------------------------------------------------

// Plugin-config PROJECT-level path, repo-relative. The `repo-configs/` dir is
// where the harness already keeps operator-facing config-like data
// (allowed-commands.js, forbidden-patterns.js, forbidden-patterns.core.js,
// repo-recon-data.yml). The overlay does NOT render or seed this file — its
// absence is the documented fail-safe default.
const CONFIG_PATH = path.resolve(
    repoRoot(),
    ".opencode",
    "repo-configs",
    "auto-gate-config.json",
);

// LLM-config PROJECT-level path — a sibling file. Same repo-configs/ dir.
// NEVER committed (gitignored); only needed for live mode.
const LLM_CONFIG_PATH = path.resolve(
    repoRoot(),
    ".opencode",
    "repo-configs",
    "auto-gate-llm.json",
);

// User-config dir: <XDG_CONFIG_HOME>/vh-agent-harness (NOT ~/.config/opencode/...
// — config is owned by vh-agent-harness, which ships the plugin + defines the
// schema; OpenCode already owns ~/.config/opencode/ for its own schema).
// XDG_CONFIG_HOME resolves per the spec: env var if set, else ~/.config.
function userConfigDir() {
    return path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "vh-agent-harness",
    );
}

// USER-level paths — mirror the project-level filenames so the override
// relationship is obvious (same file, user-level base, project-level override).
const USER_CONFIG_PATH = path.join(userConfigDir(), "auto-gate-config.json");
const USER_LLM_CONFIG_PATH = path.join(userConfigDir(), "auto-gate-llm.json");

// Plugin-behavior fail-safe defaults (auto-gate-config.json). `enabled` is the
// master live kill-switch; `mode` is the behavior selector (`audit` = Phase 1
// log-only; `enforce` = Phase 2 stub decision path; `live` = Phase 3b real-
// model decision path). `stubVerdict` drives the deterministic stub evaluator
// in enforce mode. `promptFile` optionally overrides the classifier system
// prompt (consulted only in live mode via resolveSystemPrompt, but lives in
// the plugin-config file so it MAY be committed as a shared default).
const DEFAULT_PLUGIN_CONFIG = Object.freeze({
    enabled: true,
    mode: "audit",
    stubVerdict: "block",
    promptFile: "",
    replyMode: "once", // event hook: "once" | "always" — the reply disposition on an allow verdict
    onUncertain: "reject", // event hook: "reject" | "passthrough" — failure/uncertainty disposition
    harnessContext: true, // compose the harness-context sys-prompt fragment into the live classifier prompt
    guides: true, // compose adopter-supplied guide files into the live classifier prompt
});

// LLM fail-safe defaults (auto-gate-llm.json). `modelEndpoint` and `model`
// default to empty (so a live call with no endpoint/model fail-closes to deny
// instead of hitting a garbage URL). The endpoint + API key each support a
// DUAL form, literal-preferred:
//   - `modelEndpoint` (literal URL) OR `modelEndpointEnv` (NAME of an env var
//     holding the URL) — literal wins when both are non-empty;
//   - `apiKey` (literal key value) OR `apiKeyEnv` (NAME of an env var holding
//     the key) — literal wins when both are non-empty.
// A non-empty literal suppresses the env fallback; an empty literal (the
// default) is treated as "unspecified" and falls through to env. The env-var
// NAME fields (`modelEndpointEnv`, `apiKeyEnv`) never carry the value.
// `timeoutMs` is a conservative bound. `maxRetries` / `retryDelayMs` configure
// retry-on-transient-failure INSIDE classifyLive (timeout / network error /
// 5xx / 2xx-empty). Defaults are conservative: 1 retry, 500ms base — enough to
// recover from a single stall without unbounded token cost (each retry is a
// fresh API call).
const DEFAULT_LLM_CONFIG = Object.freeze({
    modelEndpoint: "", // literal URL for live; empty -> fall back to modelEndpointEnv
    modelEndpointEnv: "AUTO_GATE_MODEL_ENDPOINT", // NAME of env var holding the URL (never the value)
    model: "", // required for live; empty -> fail-closed deny
    apiKey: "", // literal key value for live; empty -> fall back to apiKeyEnv
    apiKeyEnv: "AUTO_GATE_API_KEY", // NAME of the env var only (never the value)
    timeoutMs: 8000, // hard timeout for the model HTTP call
    maxRetries: 1, // ADDITIONAL attempts after the first (0 = single attempt)
    retryDelayMs: 500, // base delay; LINEAR backoff (see classifyLive)
    leaves: [], // Phase 2: per-leaf configs for live-tiered consensus (empty = no tier)
});

// mtime cache: stores the last successful parse plus a fallback-warning latch
// so a persistent failure (missing / invalid file) emits exactly ONE stderr
// audit line per failure STATE instead of spamming every tool call. A state
// transition (missing -> present -> invalid) re-warns once. Module-level on
// purpose — survives across hook invocations within one server process.
//
// THREE-LEVEL LAYERED LOADING needs to track BOTH files (user + project) per
// config type. The cache is therefore split into:
//
//   - per-(level × type) SINGLE-FILE sub-caches (4 total): each owns the mtime
//     cache + deduped fallback latch for ONE file, and is the cache argument
//     to _readRawJsonConfig (contract: {mtime, rawParsed, fallbackReason}).
//     The cached value is the RAW parsed object (NOT normalized) so the
//     layered reader can merge raws field-by-field before normalizing once.
//     The per-file fallback latch lives here so a failure state transition
//     re-warns independently per file (e.g. user file invalid warns once with
//     label "plugin/user"; project file missing warns once with label
//     "plugin/project").
//   - per-type TOP-LEVEL MERGE caches (2 total): hold the last-merged result +
//     the last-seen mtimes for BOTH levels, so the steady-state fast path
//     (both files unchanged) returns the cached merged object after just two
//     statSyncs, with no re-read / re-parse / re-merge.
//
// All six are held as MUTABLE const objects (properties reassigned, never the
// binding) so the readers can update them without rebinding module-level
// `let`s.
const pluginUserConfigCache = {
    mtime: null,
    rawParsed: null,
    fallbackReason: null,
};
const pluginProjectConfigCache = {
    mtime: null,
    rawParsed: null,
    fallbackReason: null,
};
const llmUserConfigCache = {
    mtime: null,
    rawParsed: null,
    fallbackReason: null,
};
const llmProjectConfigCache = {
    mtime: null,
    rawParsed: null,
    fallbackReason: null,
};

// Top-level merge caches. `merged` is null until the first successful merge.
// `userMtime` / `projectMtime` are the mtimeMs seen at the last merge (null if
// that file was missing); both matching the current stat is the fast-path hit.
const pluginConfigCache = {
    userMtime: null,
    projectMtime: null,
    merged: null,
};
const llmConfigCache = {
    userMtime: null,
    projectMtime: null,
    merged: null,
};

// Normalize a parsed plugin-config object over defaults (field-by-field so a
// partial config like {"enabled": false} still resolves every field). LLM
// fields present in this file are IGNORED (clean cut) — they MUST come from
// auto-gate-llm.json.
function normalizePluginConfig(parsed) {
    return {
        enabled:
            typeof parsed.enabled === "boolean"
                ? parsed.enabled
                : DEFAULT_PLUGIN_CONFIG.enabled,
        mode:
            parsed.mode === "audit" ||
            parsed.mode === "enforce" ||
            parsed.mode === "live" ||
            parsed.mode === "live-tiered"
                ? parsed.mode
                : DEFAULT_PLUGIN_CONFIG.mode,
        stubVerdict:
            parsed.stubVerdict === "allow" ||
            parsed.stubVerdict === "block" ||
            parsed.stubVerdict === "fail"
                ? parsed.stubVerdict
                : DEFAULT_PLUGIN_CONFIG.stubVerdict,
        promptFile:
            typeof parsed.promptFile === "string"
                ? parsed.promptFile
                : DEFAULT_PLUGIN_CONFIG.promptFile,
        replyMode:
            parsed.replyMode === "once" || parsed.replyMode === "always"
                ? parsed.replyMode
                : DEFAULT_PLUGIN_CONFIG.replyMode,
        onUncertain:
            parsed.onUncertain === "reject" ||
            parsed.onUncertain === "passthrough"
                ? parsed.onUncertain
                : DEFAULT_PLUGIN_CONFIG.onUncertain,
        harnessContext:
            typeof parsed.harnessContext === "boolean"
                ? parsed.harnessContext
                : DEFAULT_PLUGIN_CONFIG.harnessContext,
        guides:
            typeof parsed.guides === "boolean"
                ? parsed.guides
                : DEFAULT_PLUGIN_CONFIG.guides,
    };
}

// Normalize a parsed LLM-config object over defaults. Each field is fail-safe-
// normalized: an invalid type falls back to the default, which for
// endpoint/model is empty (so a misconfigured live call fail-closes to deny,
// not to a garbage request). The API key VALUE is never read here — only the
// env-var NAME, looked up at call time inside classifyLive.
//
// _normNonNegInt — coerce a value to a non-negative integer, else return the
// default. Accepts a finite non-negative number (floored) or a numeric string;
// anything else (negative, NaN, boolean, object, empty) falls back. Used by
// maxRetries / retryDelayMs so an operator typo can never break the live path.
function _normNonNegInt(v, dflt) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        return Math.floor(v);
    }
    if (typeof v === "string" && /^\d+$/.test(v.trim())) {
        return Math.floor(Number(v));
    }
    return dflt;
}

function normalizeLlmConfig(parsed) {
    const base = {
        modelEndpoint:
            typeof parsed.modelEndpoint === "string"
                ? parsed.modelEndpoint
                : DEFAULT_LLM_CONFIG.modelEndpoint,
        modelEndpointEnv:
            typeof parsed.modelEndpointEnv === "string" && parsed.modelEndpointEnv
                ? parsed.modelEndpointEnv
                : DEFAULT_LLM_CONFIG.modelEndpointEnv,
        model:
            typeof parsed.model === "string"
                ? parsed.model
                : DEFAULT_LLM_CONFIG.model,
        apiKey:
            typeof parsed.apiKey === "string"
                ? parsed.apiKey
                : DEFAULT_LLM_CONFIG.apiKey,
        apiKeyEnv:
            typeof parsed.apiKeyEnv === "string" && parsed.apiKeyEnv
                ? parsed.apiKeyEnv
                : DEFAULT_LLM_CONFIG.apiKeyEnv,
        timeoutMs:
            typeof parsed.timeoutMs === "number" && parsed.timeoutMs > 0
                ? parsed.timeoutMs
                : DEFAULT_LLM_CONFIG.timeoutMs,
        maxRetries: _normNonNegInt(parsed.maxRetries, DEFAULT_LLM_CONFIG.maxRetries),
        retryDelayMs: _normNonNegInt(parsed.retryDelayMs, DEFAULT_LLM_CONFIG.retryDelayMs),
    };
    // Phase 2: optional `leaves` array for live-tiered consensus mode. Each
    // leaf is normalized through the SAME field rules as the top-level config
    // (a leaf IS a full leaf-config object). A non-array or empty array is
    // preserved as-is ([]) so the dispatch-time validator can fail-closed on
    // it — we do NOT silently fabricate a leaf here (that would mask a
    // misconfiguration). Only live-tiered reads this field; single-leaf live
    // ignores it entirely.
    let leaves = [];
    if (Array.isArray(parsed.leaves)) {
        leaves = parsed.leaves.map((leaf) =>
            normalizeLlmConfig(
                leaf && typeof leaf === "object" ? leaf : {},
            ),
        );
    }
    return { ...base, leaves };
}

// Private RAW-reading core: stat → (cache fast-path) → read → parse →
// shape-guard → cache-latch. NEVER throws. Returns the RAW parsed object (the
// JSON.parse result, shape-guarded to be a plain object) on success, or `null`
// on missing / unreadable / invalid. Does NOT normalize — the layered reader
// merges raw objects field-by-field FIRST and normalizes ONCE at the end, so a
// partial file contributes ONLY the fields it actually specifies (not the
// defaults a normalize-on-read would fabricate for every key).
//
// Side effect: emits at most one console.error audit line per failure-state
// transition (de-duped via cache.fallbackReason), UNLESS silentOnMissing is
// true (a missing file is then the normal case and emits NOTHING). `label`
// prefixes the audit line so the operator knows WHICH file failed.
//
// The per-file sub-cache holds {mtime, rawParsed, fallbackReason}: the RAW
// parse (never normalized), so it composes cleanly with field-by-field merge.
//
// `targetPath` is injectable (the public readers default it to the production
// repo-configs path) so the self-tests can point the readers at temp files
// under tmp/ without touching the real config location.
function _readRawJsonConfig(targetPath, cache, silentOnMissing, label) {
    let st;
    try {
        st = fs.statSync(targetPath);
    } catch (_) {
        // Missing / unreadable metadata: ENOENT / EACCES / etc.
        if (!silentOnMissing) {
            if (cache.fallbackReason !== "missing") {
                console.error(
                    `[auto-gate-audit] ${label} config not found at ${targetPath}; ` +
                    `using fail-safe defaults ` +
                    `(create the file to override).`,
                );
            }
            cache.fallbackReason = "missing";
        }
        // silentOnMissing: a missing file is the NORMAL case (e.g. no live
        // mode set up). Do NOT spam, do NOT latch a fallback state.
        return null;
    }

    const mtimeMs = st.mtimeMs;
    // Fast path: unchanged since last successful parse AND not currently in a
    // fallback state — return the cached RAW object (single statSync cost).
    if (cache.rawParsed && cache.mtime === mtimeMs && !cache.fallbackReason) {
        return cache.rawParsed;
    }

    let raw;
    try {
        raw = fs.readFileSync(targetPath, "utf8");
    } catch (_) {
        if (cache.fallbackReason !== "unreadable") {
            console.error(
                `[auto-gate-audit] ${label} config unreadable at ${targetPath}; ` +
                `using fail-safe defaults.`,
            );
            cache.fallbackReason = "unreadable";
        }
        return null;
    }

    let parsed;
    // `invalidReason` is set when the JSON is structurally unusable as config
    // (a parse failure OR a successful parse of a non-object — see F3 below).
    // Both flow through the SAME deduped "invalid" fallback path so the operator
    // sees one audit line per failure state, never a throw.
    let invalidReason = null;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        invalidReason = "invalid JSON";
    }
    // Fail-safe (F3): a parse that SUCCEEDED but did not yield a plain object
    // (literal `null`, an array, or a bare primitive/string/number/boolean)
    // must NEVER reach the merger — it would contribute garbage keys. Treat it
    // exactly like invalid JSON: return null via the same "invalid"
    // fallbackReason + deduped audit line.
    if (
        invalidReason === null &&
        (parsed === null ||
            typeof parsed !== "object" ||
            Array.isArray(parsed))
    ) {
        invalidReason = "invalid JSON shape (expected a config object)";
    }
    if (invalidReason !== null) {
        if (cache.fallbackReason !== "invalid") {
            console.error(
                `[auto-gate-audit] ${label} config ${invalidReason} at ${targetPath}; ` +
                `using fail-safe defaults.`,
            );
            cache.fallbackReason = "invalid";
        }
        return null;
    }

    // Successful parse of a plain object: cache the RAW object, latch the mtime,
    // clear any prior fallback state. Do NOT normalize here — the layered
    // reader merges raws field-by-field, then normalizes once.
    cache.mtime = mtimeMs;
    cache.rawParsed = parsed;
    cache.fallbackReason = null;
    return parsed;
}

// _statMtime — return the file's mtimeMs, or null if missing/unreadable.
// Used by the layered readers' top-level fast path to check BOTH files' mtimes
// in one cheap pass (two statSyncs, no data read) before deciding whether to
// re-read/re-merge.
function _statMtime(targetPath) {
    try {
        return fs.statSync(targetPath).mtimeMs;
    } catch (_) {
        return null;
    }
}

// _readLayeredConfig — the three-level merge core shared by readConfig /
// readLlmConfig. Reads the user-level file and the project-level file (each via
// the raw-reading core _readRawJsonConfig, with its OWN per-file sub-cache +
// deduped audit latch), then merges RAW field-by-field and normalizes ONCE at
// the end. Precedence: project > user > default. The merge is SHALLOW (both
// config objects are flat key→value; a `leaves` array is a single key whose
// value is replaced wholesale by the project array, not concatenated).
//
// SEMANTICS (the critical correctness property): this is a TRUE field-by-field
// merge of the RAW parsed objects, NOT an all-or-nothing-per-file merge.
//   - Each layer contributes ONLY the fields its file actually specifies. A
//     missing/invalid file contributes NO fields (null → spread of `{}` → no
//     keys). A present-but-PARTIAL file contributes only its specified keys.
//   - Precedence is per FIELD: a field the project file specifies → project
//     wins; a field only the user file specifies → user wins; a field neither
//     specifies → default (filled by the single final normalize over defaults).
//   - The reference-identity trick the OLD all-or-nothing merge used (returning
//     `defaults` from the reader and testing `!== defaults`) is GONE: it was
//     both unnecessary and the source of the wrong semantics, because a
//     successfully-parsed-but-normalized object carried ALL keys (default-
//     filled) and so overrode the other layer on every field.
// This makes the feature's PRIMARY use case correct: an operator sets the LLM
// endpoint/key ONCE at user level, and a project specializes just the model;
// the user's endpoint/key survive a partial project file.
//
// Top-level fast path: statSync both files; if BOTH mtimes match the cached
// mtimes (the last successful merge), return the cached merged object without
// re-reading or re-merging. A missing file has mtime null; a transition
// present↔missing changes the mtime (number↔null), so the cache invalidates
// correctly on file creation/deletion too.
//
// Audit / silent rules (per the layered model):
//   - USER-level file missing → SILENT (its absence is the normal case; most
//     operators have only project-level config). Only a PRESENT-but-invalid
//     user file emits an audit line, labeled with the level (e.g. "plugin/user").
//   - PROJECT-level file — same silentOnMissing flag the caller supplies, so
//     the project-level plugin file keeps its existing "missing warns once"
//     behavior and the project-level LLM file keeps its existing "silent on
//     missing" behavior.
// This makes both-missing for a type behave EXACTLY as the old single-file
// model: plugin both-missing → one project-level "missing" line + defaults
// (user silent); LLM both-missing → fully silent + defaults.
function _readLayeredConfig(
    projectPath,
    userPath,
    projectCache,
    userCache,
    mergeCache,
    defaults,
    normalize,
    projectSilentOnMissing,
    projectLabel,
    userLabel,
) {
    // Steady-state fast path: both mtimes unchanged → return cached merged.
    const userMtime = _statMtime(userPath);
    const projectMtime = _statMtime(projectPath);
    if (
        mergeCache.merged !== null &&
        mergeCache.userMtime === userMtime &&
        mergeCache.projectMtime === projectMtime
    ) {
        return mergeCache.merged;
    }

    // At least one file changed (or first read). Read both RAW (each handles its
    // own mtime sub-cache + deduped audit latch). The user-level file is ALWAYS
    // silent on missing (optional layer); the project-level file inherits the
    // caller's silentOnMissing so existing per-type behavior is preserved
    // exactly. Each read returns the RAW parsed object (null on missing /
    // unreadable / invalid).
    const userRaw = _readRawJsonConfig(
        userPath,
        userCache,
        true, // user-missing is ALWAYS silent
        userLabel,
    );
    const projectRaw = _readRawJsonConfig(
        projectPath,
        projectCache,
        projectSilentOnMissing,
        projectLabel,
    );

    // TRUE field-by-field merge of the RAW objects: project keys win per-key,
    // user keys fill the rest, a missing/invalid layer (null) contributes NO
    // keys (spread of `{}`). Then normalize ONCE, over defaults so fields
    // absent from BOTH layers take their default. No reference-identity test
    // is needed — null spreads to nothing, so a missing file can never clobber
    // the other layer's values.
    const mergedRaw = { ...(userRaw || {}), ...(projectRaw || {}) };
    const merged = normalize({ ...defaults, ...mergedRaw });

    mergeCache.userMtime = userMtime;
    mergeCache.projectMtime = projectMtime;
    mergeCache.merged = merged;
    return merged;
}

// Read the PLUGIN-BEHAVIOR config with three-level merge (project > user >
// default). Returns {enabled, mode, stubVerdict, promptFile, replyMode,
// onUncertain} on every call — never throws. Emits one console.error audit
// line per failure-state transition per file (user-level failures are labeled
// "plugin/user"; project-level failures are labeled "plugin/project"). LLM
// fields in either file are IGNORED.
//
// `projectPath` / `userPath` are injectable for the self-test; production
// callers omit them (they default to the repo-configs path and the
// <XDG_CONFIG_HOME>/vh-agent-harness path respectively). Existing call sites
// that pass one positional arg pass the PROJECT path (backward-compatible
// signature extension).
export function readConfig(projectPath = CONFIG_PATH, userPath = USER_CONFIG_PATH) {
    return _readLayeredConfig(
        projectPath,
        userPath,
        pluginProjectConfigCache,
        pluginUserConfigCache,
        pluginConfigCache,
        DEFAULT_PLUGIN_CONFIG,
        normalizePluginConfig,
        false, // project-missing is NOT silent (existing behavior: warns once)
        "plugin/project",
        "plugin/user",
    );
}

// Read the LLM config with three-level merge (project > user > default).
// Returns {modelEndpoint, modelEndpointEnv, model, apiKey, apiKeyEnv, timeoutMs,
// maxRetries, retryDelayMs, leaves} on every call — never throws. A MISSING
// file at EITHER level is SILENT (no audit spam) — it is the normal case when
// live mode is not set up; audit/enforce modes must NOT fail because the LLM
// file is absent. Only a PRESENT-but-invalid file emits an audit line, labeled
// with the level ("llm/project", "llm/user").
//
// `projectPath` / `userPath` are injectable for the self-test; production
// callers omit them.
export function readLlmConfig(
    projectPath = LLM_CONFIG_PATH,
    userPath = USER_LLM_CONFIG_PATH,
) {
    return _readLayeredConfig(
        projectPath,
        userPath,
        llmProjectConfigCache,
        llmUserConfigCache,
        llmConfigCache,
        DEFAULT_LLM_CONFIG,
        normalizeLlmConfig,
        true, // project-missing is SILENT (existing behavior: no live setup = no spam)
        "llm/project",
        "llm/user",
    );
}

// Test-only: reset ALL config caches (4 per-file raw sub-caches + 2 top-level
// merge caches) so the self-test's filesystem tests are isolated from each
// other and from any prior production read. Mirrors the
// __resetCachedBinaryPrompt helper pattern in auto-gate-live.js.
export function __resetConfigCaches() {
    for (const c of [
        pluginUserConfigCache,
        pluginProjectConfigCache,
        llmUserConfigCache,
        llmProjectConfigCache,
    ]) {
        c.mtime = null;
        c.rawParsed = null;
        c.fallbackReason = null;
    }
    for (const c of [pluginConfigCache, llmConfigCache]) {
        c.userMtime = null;
        c.projectMtime = null;
        c.merged = null;
    }
}

// The factory receives the full PluginInput ({client, project, directory,
// worktree, serverUrl, $}) — same contract session-state.js relies on for
// client.session.todo(). We close over `client` (the OpenCode SDK client, used
// in mode:"live" to fetch the session transcript + in mode:"enforce"/"live" of
// the event hook to reply to permission.asked) and `directory` (the repo dir,
// passed as the SDK query param for transcript fetch). The audit and
// enforce branches never touch either.
//
// `configPath` / `llmConfigPath` are optional test-injection points for the
// PROJECT-level files: production callers omit them (the hooks default to the
// production repo-configs paths). `userConfigPath` / `userLlmConfigPath` are
// the optional test-injection points for the USER-level files: production
// callers omit them too (they default to the <XDG_CONFIG_HOME>/vh-agent-harness
// paths). The self-tests pass temp-file paths under tmp/ for ALL four to
// isolate the filesystem (the user-level paths point at non-existent temp
// files so the silent user-missing path is exercised deterministically,
// independent of the dev machine's real user config).
export const server = async ({
    client,
    directory,
    configPath,
    llmConfigPath,
    userConfigPath = USER_CONFIG_PATH,
    userLlmConfigPath = USER_LLM_CONFIG_PATH,
} = {}) => {
    return {
        "tool.execute.before": async (input, output) => {
            // Live config — read on every call (mtime-cached, single statSync
            // in steady state). The operator can live-disable the plugin by
            // setting `enabled: false` in the config file; no OpenCode
            // restart, no re-render required.
            const config = readConfig(configPath, userConfigPath);
            if (config.enabled === false) {
                // Operator kill-switch: the plugin is fully inert (no audit,
                // no behavior change). This is the only branch that short-
                // circuits before the audit log.
                return;
            }
            // AUDIT ONLY — permanently, in EVERY mode. Capture tool name + arg
            // summary + verdict PLACEHOLDER on stderr. Never throw, never block,
            // never mutate. The bare `return` is an unconditional ALLOW /
            // passthrough; this hook changes zero tool-call behavior.
            //
            // This hook sees EVERY tool call — including ones the permission
            // table auto-allows (those never reach permission.ask). That makes
            // it the right place to capture the arg summary, and the
            // complementary surface to permission.ask for the dual-hook audit.
            //
            // WHY THIS HOOK STAYS AN OBSERVER EVEN IN ENFORCE MODE: it can ONLY
            // block (throw) or passthrough (bare return) — it cannot force-allow
            // or force-ask. Because it fires for ALL calls (not just ask-routed
            // ones), running a classifier verdict here would either block calls
            // the table already allowed (wrong) or be redundant with
            // permission.ask. So only permission.ask owns the authoritative
            // decision (Phase 2+); this hook is always an observer.
            const tool = (input && input.tool) || "unknown";
            const summary = summarizeArgs(output && output.args);
            console.error(
                `[auto-gate-audit] tool=${tool} ${summary} verdict=AUDIT_ONLY`,
            );
            return;
        },

        "permission.ask": async (input, output) => {
            // DORMANT — OpenCode does not fire `permission.ask` in any stock
            // release as of the studied version. The `event` hook (below) is the
            // ACTIVE enforcement surface: it receives the `permission.asked`
            // bus event and replies via the SDK client
            // (postSessionIdPermissionsPermissionId). This hook is RETAINED as
            // a RESERVE in case upstream wires permission.ask in a future
            // release — do NOT rely on it, but keep the investment intact.
            // Live config — read on every call (mtime-cached).
            const config = readConfig(configPath, userConfigPath);
            if (config.enabled === false) {
                // Operator kill-switch: fully inert, no audit, no behavior
                // change. output.status is left at its default so opencode's
                // normal interactive ask still fires.
                return;
            }

            if (config.mode === "enforce") {
                // ENFORCE (Phase 2): run the verdict decision path.
                //
                // HARD-FLOOR INVARIANT: permission.ask fires ONLY for calls
                // opencode's permission table routes to `ask`. Table-`allow`
                // fast-paths past this hook; table-`deny` / shell-guard blocks
                // BEFORE this hook. Therefore the classifier decision below
                // can only ever lift an `ask` to `allow`/`deny` — it can NEVER
                // override a static deny, because a statically-denied call
                // never reaches this hook. The classifier only ever decides
                // the ask-routed subset.
                //
                // Phase 2 uses a STUB evaluator (stubEvaluate inside
                // decidePermission), NOT a real classifier model. Do NOT run
                // enforce mode against real traffic until Phase 3 wires a live
                // model. The decision path fail-closes to deny on ANY
                // uncertainty (parse failure, evaluator error, thrown
                // exception).
                const type = (input && input.type) || "unknown";
                const pattern = scrubTruncate((input && input.pattern) || "", MAX_ARG_LEN);
                console.error(
                    `[auto-gate] permission.ask type=${type} pattern=${pattern} mode=enforce (deciding)`,
                );
                // Decision path. decidePermission(config) composes
                // stubEvaluate(config) -> parseVerdict(raw) -> decision matrix
                // and NEVER throws (it catches evaluator errors internally and
                // returns a fail-closed deny). We wrap defensively anyway so a
                // future regression fail-closes to deny rather than crashing
                // the hook.
                let result;
                try {
                    result = decidePermission(config);
                } catch (err) {
                    const msg = (err && err.message) || String(err);
                    console.error(
                        `[auto-gate] fail-closed: decision error: ${msg}`,
                    );
                    output.status = "deny";
                    return;
                }
                if (result.audit) {
                    console.error(`[auto-gate] ${result.audit}`);
                }
                output.status = result.status; // "allow" | "deny"
                return;
            }

            if (config.mode === "live") {
                // LIVE (Phase 3b): run the REAL classifier model decision path.
                //
                // The same hard-floor invariant holds: permission.ask only
                // fires for ask-routed calls, so this can only lift an `ask` to
                // allow/deny — never override a static deny. The decision path
                // uses the SAME parseVerdict -> decision matrix as enforce, fed
                // by a real model verdict instead of the stub. The matrix is
                // fail-closed, so the live path inherits that posture:
                // transport error / timeout / non-2xx / malformed / missing-
                // choices / unparseable verdict -> deny, NEVER silent allow.
                //
                // Transcript fetch degrades GRACEFULLY: if the SDK call fails
                // (no client, error wrapper, missing data), we fall back to the
                // permission payload ALONE (serializeTranscript([], input))
                // rather than fail-closed. The model still gets the type+pattern
                // to judge. Only the model-call / decision layer fail-closes.
                const type = (input && input.type) || "unknown";
                const pattern = scrubTruncate((input && input.pattern) || "", MAX_ARG_LEN);
                console.error(
                    `[auto-gate] permission.ask type=${type} pattern=${pattern} mode=live (deciding)`,
                );

                // MERGE POINT: build ONE config object for the live path by
                // merging the plugin-behavior config (already read above into
                // `config` as {enabled, mode, stubVerdict, promptFile}) with the
                // LLM config (auto-gate-llm.json → {modelEndpoint,
                // modelEndpointEnv, model, apiKey, apiKeyEnv, timeoutMs}). A missing LLM file is SILENT here:
                // readLlmConfig() returns empty-string defaults, which flow
                // straight into the fail-closed validation below. Downstream
                // decideLive / classifyLive / resolveSystemPrompt see a single
                // merged object exactly as before the two-file split.
                const liveConfig = { ...config, ...readLlmConfig(llmConfigPath, userLlmConfigPath) };

                // (1) Validate live config up front so a misconfigured live
                // mode fail-closes to deny with a CLEAR audit line instead of a
                // cryptic adapter error. Dual-form endpoint: either a literal
                // modelEndpoint OR a modelEndpointEnv name must be present (the
                // resolved env VALUE is checked by classifyLive at call time;
                // here we only confirm the config specifies at least one form).
                if (!liveConfig.modelEndpoint && !liveConfig.modelEndpointEnv) {
                    console.error(
                        "[auto-gate] live mode misconfigured: no modelEndpoint; fail-closed deny",
                    );
                    output.status = "deny";
                    return;
                }
                if (!liveConfig.model) {
                    console.error(
                        "[auto-gate] live mode misconfigured: no model; fail-closed deny",
                    );
                    output.status = "deny";
                    return;
                }

                // (2) Fetch the session transcript. Graceful degradation on any
                // failure: use the permission payload alone. SDK calls return a
                // RequestResult wrapper — read payload via .data and check
                // .error (proven in .opencode/plugins/session-state.js).
                let transcript = [];
                try {
                    if (
                        client &&
                        client.session &&
                        typeof client.session.messages === "function" &&
                        input &&
                        input.sessionID
                    ) {
                        const r = await client.session.messages({
                            path: { id: input.sessionID },
                            query: { directory },
                        });
                        if (r && r.error) throw r.error;
                        if (r && Array.isArray(r.data)) {
                            transcript = r.data;
                        }
                    } else {
                        // No client threaded into the plugin, or no sessionID on
                        // the input: degrade to permission-payload-only. (This
                        // is a soft degradation, NOT a fail-closed condition.)
                        throw new Error("client/session unavailable");
                    }
                } catch (err) {
                    const msg = (err && err.message) || String(err);
                    console.error(
                        `[auto-gate] transcript fetch failed (${msg}); using permission payload only`,
                    );
                    transcript = [];
                }

                // (3) Serialize the transcript to a redacted text-mode string.
                const serialized = serializeTranscript(transcript, input);

                // (4) Run the live model decision path. decideLive() awaits the
                // HTTP adapter and hands the raw verdict text to the SAME
                // synchronous decidePermission() decision matrix (so the
                // existing fail-closed matrix applies unchanged). It returns
                // {status, audit, reason, latencyMs} and never throws.
                let result;
                try {
                    result = await decideLive(liveConfig, serialized);
                } catch (err) {
                    // Defensive: decideLive itself does not throw, but a future
                    // regression must fail-closed rather than crash the hook.
                    const msg = (err && err.message) || String(err);
                    console.error(
                        `[auto-gate] fail-closed: live decision error: ${msg}`,
                    );
                    output.status = "deny";
                    return;
                }
                if (result.audit) {
                    console.error(`[auto-gate] ${result.audit}`);
                }
                // Telemetry: surface the retry count when retries occurred
                // (result.retries is a safe integer; no tool-call content).
                // Egress discipline unchanged — this is the existing audit
                // surface, no new console site.
                const retryTag = result.retries > 0 ? ` retries=${result.retries}` : "";
                console.error(
                    `[auto-gate] live decision status=${result.status} latencyMs=${result.latencyMs}${retryTag}`,
                );
                output.status = result.status; // "allow" | "deny"
                return;
            }

            // AUDIT ONLY (Phase 1, byte-for-byte unchanged). Log the
            // permission-decision request WITHOUT changing the outcome. This
            // hook fires only when opencode's permission table resolves to
            // `ask` or no-match: table-`allow` calls fast-path past it, and
            // table-`deny`/shell-guard blocks before it. We record the request
            // and leave output.status at its default so the normal interactive
            // ask still fires.
            //
            // CRITICAL: this audit branch MUST NOT mutate output.status.
            // Setting it to "allow" would grant + skip the prompt (the enforce
            // branch above does that); setting it to "deny" would block. The
            // audit branch leaves it untouched — audit only, zero behavior
            // change. This is the default mode (`mode: "audit"`).
            const type = (input && input.type) || "unknown";
            const pattern = scrubTruncate((input && input.pattern) || "", MAX_ARG_LEN);
            const incoming = (output && output.status) || "(unset)";
            console.error(
                `[auto-gate-audit] permission.ask type=${type} pattern=${pattern} incoming=${incoming} verdict=AUDIT_ONLY`,
            );
            return; // do NOT set output.status — audit only
        },

        // ===================================================================
        // EVENT HOOK — the PRIMARY enforcement surface.
        //
        // This hook receives EVERY bus event. The only event type it acts on
        // is `permission.asked`, which OpenCode publishes when its ruleset
        // routes a tool call to "ask". The event payload (event.properties)
        // is the Request: {id, sessionID, permission, patterns, metadata,
        // always, tool}. The hook classifies it and REPLIES via the SDK
        // client: client.postSessionIdPermissionsPermissionId({path:{id,
        // permissionID}, body:{response}}). This resolves the Deferred that
        // Permission.ask is awaiting, which unblocks the tool call (allow) or
        // blocks it (reject). This is the SAME mechanism the upstream ships in
        // its ACP agent, `--dangerously-skip-permissions`, and TUI.
        //
        // CRITICAL HEADLESS BEHAVIOR: if NO ONE replies to permission.asked,
        // the Deferred never resolves and the tool call HANGS. In autonomous
        // modes (enforce/live) the hook MUST reply. The only mode that does
        // NOT reply is audit (observe-only, a human is expected to be present
        // to click the prompt) or onUncertain:"passthrough" (interactive
        // only — documented hang risk).
        //
        // EGRESS: event.properties (patterns, metadata) is tool-call-derived
        // and MUST be scrubbed before landing in any audit/log line.
        // ===================================================================
        "event": async ({ event } = {}) => {
            // Early-return on non-permission.asked events — the hook receives
            // EVERY bus event but only acts on this one type.
            if (!event || event.type !== "permission.asked") return;

            const req = event.properties;
            if (!req || !req.id || !req.sessionID) return;

            // Kill-switch: same live-disable as the other two hooks.
            const config = readConfig(configPath, userConfigPath);
            if (config.enabled === false) return;

            // Scrubbed audit summary of the event payload. `patterns` and
            // `metadata` are tool-call-derived and MUST pass through the
            // shared scrubber before landing in the log line.
            //
            // PERMISSION-TYPE SHAPE: the SDK wire type for permission.asked
            // carries `permission` as the permission NAME STRING (e.g.
            // "bash"), not as an object with a `.type` field. The earlier
            // `req.permission && req.permission.type` form collapsed to
            // "unknown" on every real event, losing the tool-type signal
            // (fail-closed still fired, but the audit/serialized input said
            // type=unknown). Normalize defensively to accept BOTH the string
            // shape (today's wire type) and the object shape (a hedge against
            // an upstream change).
            const rawPerm = req && req.permission;
            const permType =
                typeof rawPerm === "string"
                    ? rawPerm
                    : ((rawPerm &&
                          typeof rawPerm === "object" &&
                          rawPerm.type) ||
                          "unknown");
            const patternsSummary = Array.isArray(req.patterns)
                ? req.patterns
                      .map((p) => scrubTruncate(String(p), MAX_ARG_LEN))
                      .join(",")
                : "";

            // --- Reply helper (shared by all decision branches) ---
            // Wraps the SDK call so every branch logs r.error uniformly.
            //
            // MUST NEVER THROW. The outer catch path routes failures to
            // handleUncertain -> reply("reject"); if THIS helper could throw
            // (a thrown transport error, or a missing client), the throw
            // inside the catch would reject the hook promise, surface an error
            // to OpenCode, and leave the permission.asked Deferred unresolved
            // -> HEADLESS HANG. So: guard the client, wrap the call in
            // try/catch, and log on any failure. The only residual hang case
            // is a fundamentally-broken transport (then nothing can resolve
            // the Deferred — inherent, now logged rather than crashing).
            // `reason` is OPTIONAL and only meaningful for `responseMode ===
            // "reject"`. When a non-empty reason string is supplied on a reject,
            // the reply routes through the v2 permission-reply endpoint
            // (POST /permission/:requestID/reply) which forwards `message` to
            // the permission service. Upstream that switches the Deferred
            // failure from RejectedError (which kills the WHOLE agent turn
            // under default config — one block ends the session) to
            // CorrectedError (which fails only THIS tool call and surfaces the
            // reason to the model as errorText next step, so it can adapt and
            // retry). That makes the gate a TRUE per-call gate instead of a
            // binary let-it-run / kill-session switch.
            //
            // The v2 endpoint is reached via the SAME in-process transport the
            // v1 SDK methods use (the underlying openapi-fetch client on
            // `client._client`), so it works in BOTH run mode (in-process fetch,
            // no HTTP listener — nothing listens on the loopback port) and serve
            // mode (real HTTP listener). Raw globalThis.fetch to /permission/...
            // would fail in run mode; this does not. Allow (once/always) and
            // reject-without-message keep the v1 endpoint, which carries only
            // the reply literal and never a message.
            //
            // MUST NEVER THROW (see F2 hardening note above). Guard the client,
            // guard the transport, wrap every call in try/catch, and log on any
            // failure. A reject-with-reason whose v2 transport is unavailable
            // degrades to a v1 reject (kills the turn under default config) —
            // fail-closed, not silent.
            const reply = async (responseMode, reason) => {
                const rejectWithReason =
                    responseMode === "reject" &&
                    typeof reason === "string" &&
                    reason.length > 0;
                try {
                    if (rejectWithReason) {
                        const transport = client && client._client;
                        if (transport && typeof transport.post === "function") {
                            const r2 = await transport.post({
                                url:
                                    "/permission/" +
                                    encodeURIComponent(req.id) +
                                    "/reply",
                                body: { reply: "reject", message: reason },
                                headers: {
                                    "Content-Type": "application/json",
                                },
                            });
                            if (r2 && r2.error) {
                                // F1 hardening: a v2 server-error must NOT leave
                                // the permission Deferred unresolved (the tool's
                                // ctx.ask would hang indefinitely). Fall through
                                // to the v1 bare reject below (kill-switch — turn
                                // ends — but no hang). A hang is strictly worse
                                // than a kill-switch.
                                console.error(
                                    `[auto-gate] permission reply (v2) ` +
                                    `failed: ` +
                                    `${(r2.error && r2.error.message) || "unknown"}; ` +
                                    `falling back to v1 reject (kill-switch)`,
                                );
                            } else {
                                // v2 succeeded — do NOT also call v1 (would
                                // double-reply). Done.
                                return;
                            }
                        }
                        // No v2 transport available — fall through to the v1
                        // reject below (turn-killing under default config; logged
                        // rather than silent). Degrades fail-closed.
                    }
                    if (
                        !client ||
                        typeof client.postSessionIdPermissionsPermissionId !==
                            "function"
                    ) {
                        console.error(
                            `[auto-gate] permission reply unavailable: ` +
                            `no client (responseMode=${responseMode})`,
                        );
                        return;
                    }
                    const r =
                        await client.postSessionIdPermissionsPermissionId({
                            path: { id: req.sessionID, permissionID: req.id },
                            body: { response: responseMode },
                        });
                    if (r && r.error) {
                        console.error(
                            `[auto-gate] permission reply failed: ` +
                            `${(r.error && r.error.message) || "unknown"}`,
                        );
                    }
                } catch (e) {
                    console.error(
                        `[auto-gate] permission reply threw: ` +
                        `${(e && e.message) || "unknown"} ` +
                        `(responseMode=${responseMode})`,
                    );
                }
            };

            // --- Uncertainty/failure helper ---
            // Fail-closed default (reject). `passthrough` = no reply — ONLY
            // for interactive mode where a human is present to click the
            // prompt; in headless/autonomous mode passthrough HANGS the tool
            // call (documented risk).
            const handleUncertain = async (reason) => {
                if (config.onUncertain === "passthrough") {
                    console.error(
                        `[auto-gate] uncertain: ${reason}; ` +
                        `onUncertain=passthrough (no reply — interactive only)`,
                    );
                    return;
                }
                console.error(
                    `[auto-gate] uncertain: ${reason}; ` +
                    `onUncertain=reject (fail-closed)`,
                );
                await reply("reject", `[auto-gate] fail-closed: ${reason}`);
            };

            // =============== AUDIT mode (default, observe-only) ===============
            if (config.mode === "audit") {
                console.error(
                    `[auto-gate-audit] permission.asked type=${permType} ` +
                    `patterns=${patternsSummary} verdict=AUDIT_ONLY (no reply)`,
                );
                return; // do NOT reply — the human decides
            }

            // =============== ENFORCE mode (stub classifier) ===================
            if (config.mode === "enforce") {
                console.error(
                    `[auto-gate] permission.asked type=${permType} ` +
                    `mode=enforce (deciding)`,
                );
                let result;
                try {
                    result = decidePermission(config);
                } catch (err) {
                    const msg = (err && err.message) || String(err);
                    await handleUncertain(`decision error: ${msg}`);
                    return;
                }
                if (result.audit) console.error(`[auto-gate] ${result.audit}`);
                if (result.status === "allow") {
                    await reply(config.replyMode); // "once" | "always"
                } else {
                    await reply(
                        "reject",
                        result.reason ||
                            result.audit ||
                            "[auto-gate] blocked by stub verdict",
                    );
                }
                return;
            }

            // =============== LIVE mode (real classifier model) ================
            if (config.mode === "live") {
                console.error(
                    `[auto-gate] permission.asked type=${permType} ` +
                    `mode=live (deciding)`,
                );
                const liveConfig = { ...config, ...readLlmConfig(llmConfigPath, userLlmConfigPath) };

                // (1) Validate live config — missing endpoint/model fail-closes.
                // Dual-form endpoint: either a literal modelEndpoint OR a
                // modelEndpointEnv name must be present (the resolved env VALUE
                // is checked by classifyLive at call time; here we only confirm
                // the config specifies at least one form).
                if (!liveConfig.modelEndpoint && !liveConfig.modelEndpointEnv) {
                    await handleUncertain("no modelEndpoint");
                    return;
                }
                if (!liveConfig.model) {
                    await handleUncertain("no model");
                    return;
                }

                // (2) Fetch the session transcript. Graceful degradation: on
                // any failure, use the permission payload alone (the model
                // still gets type+patterns to judge). The model-call / decision
                // layer owns the fail-closed decision; transcript fetch is soft.
                let transcript = [];
                try {
                    if (
                        client &&
                        client.session &&
                        typeof client.session.messages === "function"
                    ) {
                        const r = await client.session.messages({
                            path: { id: req.sessionID },
                            query: { directory },
                        });
                        if (r && r.error) throw r.error;
                        if (r && Array.isArray(r.data)) transcript = r.data;
                    } else {
                        throw new Error("client/session unavailable");
                    }
                } catch (err) {
                    const msg = (err && err.message) || String(err);
                    console.error(
                        `[auto-gate] transcript fetch failed (${msg}); ` +
                        `using permission payload only`,
                    );
                    transcript = [];
                }

                // (3) Serialize to a redacted text-mode string. Build a
                // permission-like object from the Request payload for the
                // serializer (it reads .type and .pattern).
                const permForSerializer = {
                    type: permType,
                    pattern: Array.isArray(req.patterns)
                        ? req.patterns.join(" ")
                        : "",
                };
                const serialized = serializeTranscript(
                    transcript,
                    permForSerializer,
                );

                // (4) Run the live model decision path. decideLive awaits the
                // HTTP adapter and feeds the raw verdict through the SAME
                // fail-closed decision matrix as enforce.
                let result;
                try {
                    result = await decideLive(liveConfig, serialized);
                } catch (err) {
                    const msg = (err && err.message) || String(err);
                    await handleUncertain(`live decision error: ${msg}`);
                    return;
                }
                if (result.audit) console.error(`[auto-gate] ${result.audit}`);
                const retryTag =
                    result.retries > 0 ? ` retries=${result.retries}` : "";
                console.error(
                    `[auto-gate] live decision status=${result.status} ` +
                    `latencyMs=${result.latencyMs}${retryTag}`,
                );
                if (result.status === "allow") {
                    await reply(config.replyMode); // "once" | "always"
                } else {
                    await reply(
                        "reject",
                        result.reason ||
                            result.audit ||
                            "[auto-gate] blocked by live classifier",
                    );
                }
                return;
            }

            // =========== LIVE-TIERED mode (Phase 2 multi-leaf consensus) =====
            //
            // Opt-in consensus mode. Dispatches decideLive for EACH configured
            // leaf IN PARALLEL (each leaf may point at a DIFFERENT endpoint/
            // model — independent classifiers), normalizes each outcome via
            // normalizeLeafOutcome (the SAME {status} shape decideLive returns
            // — no adapter), and aggregates via aggregateLeafOutcomes with the
            // unanimous-allow policy: ALLOW+ALLOW (>=1) is the ONLY grant;
            // any DENY/FAIL/empty/misconfig -> deny. The transcript is fetched
            // ONCE and shared (leaves differ in LLM endpoint/model, not in
            // what they see). Misconfig -> fail-closed via onUncertain.
            //
            // RUN-MODE RACE: multi-leaf (parallel classifyLive) loses the reply
            // race under `opencode run` WORSE than single-leaf live (more
            // latency). Phase 2 consensus enforcement is effectively SERVE-ONLY
            // — document, do not attempt to fix. Enforce/stub still wins
            // run-mode (synchronous).
            if (config.mode === "live-tiered") {
                console.error(
                    `[auto-gate] permission.asked type=${permType} ` +
                    `mode=live-tiered (deciding consensus)`,
                );
                const llmConfig = readLlmConfig(llmConfigPath, userLlmConfigPath);

                // (1) Validate the leaves array. A well-formed leaf provides a
                // model AND at least one endpoint form — a literal modelEndpoint
                // (URL) OR a modelEndpointEnv env-var name (mirrors single-leaf
                // live validation after the dual-form endpoint change). Malformed
                // -> fail-closed via onUncertain. NEVER fall back to permissive.
                const leaves = Array.isArray(llmConfig.leaves)
                    ? llmConfig.leaves
                    : [];
                const wellFormedLeaves = leaves.filter(
                    (leaf) =>
                        leaf &&
                        typeof leaf === "object" &&
                        // Dual-form endpoint: the leaf must specify at least one
                        // form (literal URL OR env-var name). We do NOT resolve
                        // the env value here — classifyLive does that at call
                        // time; validation only checks the config is well-formed.
                        typeof leaf.modelEndpoint === "string" &&
                        (leaf.modelEndpoint ||
                            (typeof leaf.modelEndpointEnv === "string" && leaf.modelEndpointEnv)) &&
                        typeof leaf.model === "string" &&
                        leaf.model,
                );
                if (wellFormedLeaves.length === 0) {
                    console.error(
                        "[auto-gate] live-tiered misconfigured: no leaves",
                    );
                    await handleUncertain("live-tiered misconfigured: no leaves");
                    return;
                }

                // (2) Fetch the session transcript ONCE (shared across all
                // leaves). Graceful degradation: on any failure, use the
                // permission payload alone. The per-leaf model call / decision
                // layer owns the fail-closed decision; transcript fetch is soft.
                let transcript = [];
                try {
                    if (
                        client &&
                        client.session &&
                        typeof client.session.messages === "function"
                    ) {
                        const r = await client.session.messages({
                            path: { id: req.sessionID },
                            query: { directory },
                        });
                        if (r && r.error) throw r.error;
                        if (r && Array.isArray(r.data)) transcript = r.data;
                    } else {
                        throw new Error("client/session unavailable");
                    }
                } catch (err) {
                    const msg = (err && err.message) || String(err);
                    console.error(
                        `[auto-gate] transcript fetch failed (${msg}); ` +
                        `using permission payload only`,
                    );
                    transcript = [];
                }

                // (3) Serialize ONCE. Each leaf sees the SAME redacted text.
                const permForSerializer = {
                    type: permType,
                    pattern: Array.isArray(req.patterns)
                        ? req.patterns.join(" ")
                        : "",
                };
                const serialized = serializeTranscript(
                    transcript,
                    permForSerializer,
                );

                // (4) Parallel per-leaf dispatch. Each leaf gets its OWN
                // endpoint/model/apiKeyEnv/timeoutMs/retries; the shared
                // promptFile + transcript apply to all. decideLive already
                // catches internally and returns {status:"deny"} on error, but
                // we wrap defensively so a throwing leaf becomes a FAIL
                // outcome rather than aborting the whole tier.
                const leafPromises = wellFormedLeaves.map((leaf) =>
                    (async () => {
                        try {
                            const leafConfig = { ...config, ...leaf };
                            return await decideLive(leafConfig, serialized);
                        } catch (err) {
                            // Defensive: decideLive should not throw, but if it
                            // does, surface a deny-on-error so normalize maps
                            // it to DENY (not FAIL), keeping the tier honest.
                            return {
                                status: "deny",
                                audit: null,
                                reason: `leaf threw: ${(err && err.message) || String(err)}`,
                                latencyMs: 0,
                                retries: 0,
                            };
                        }
                    })(),
                );
                const results = await Promise.all(leafPromises);

                // (5) Normalize each leaf outcome via the tiered core (maps
                // {status:"allow"}->ALLOW, {status:"deny"}->DENY, else FAIL).
                const normalized = results.map((r) => normalizeLeafOutcome(r));

                // (6) Aggregate via the unanimous-allow policy.
                const agg = aggregateLeafOutcomes(normalized, {
                    tierId: "consensus",
                });

                // (7) EGRESS-DISCIPLINED audit line. agg.audit is already
                // constant-shaped (tierId + integer counts + normalized-outcome
                // enums ONLY — NEVER leaf endpoint/model/apiKeyEnv values). We
                // log agg.audit directly plus the aggregate decision flags,
                // and a per-leaf scrubbed outcome summary (integer retries/
                // latency + enum outcomes — NO endpoint/model interpolation).
                console.error(`[auto-gate] ${agg.audit}`);
                const perLeafSummary = results
                    .map(
                        (r, i) =>
                            `leaf#${i}=${normalized[i]}` +
                            ` retries=${(r && r.retries) || 0}` +
                            ` latencyMs=${(r && r.latencyMs) || 0}`,
                    )
                    .join(" ");
                console.error(
                    `[auto-gate] live-tiered decision=${agg.decision} ` +
                    `disagreement=${agg.disagreement} ` +
                    `incomplete=${agg.incomplete} ${perLeafSummary}`,
                );

                // (8) Reply based on the aggregate decision.
                if (agg.decision === "allow") {
                    await reply(config.replyMode); // "once" | "always"
                } else {
                    await reply(
                        "reject",
                        `[auto-gate] blocked by consensus: ${agg.audit}`,
                    );
                }
                return;
            }

            // =============== Unknown mode — fail-closed =======================
            await handleUncertain(`unknown mode: ${config.mode}`);
        },
    };
};

export const AutoToolGatePlugin = server;

export default {
    id,
    server,
};

// ===========================================================================
// DUAL-PURPOSE SELF-TEST — stderr/audit-egress credential-leak regression.
//
// Run directly (`node auto-tool-gate.js` or `node --test auto-tool-gate.js`) to
// execute the suite. Import as a module -> NO tests run. Guard is an explicit
// __filename comparison so an accidental import (the plugin-loader path) cannot
// fire the suite.
//
// These tests prove a credential embedded in a tool-call-derived value CANNOT
// survive into the stderr audit line. console.error writes to stderr, which the
// OpenCode/server process writes to its stderr log — so we test the PURE
// helpers (summarizeArgs + the pattern-audit value expression) directly rather
// than capturing stderr. Each assert: the secret is ABSENT from the helper
// output, and (where applicable) a safe value is UNCHANGED (no false-positive
// over-redaction).
// ===========================================================================
const __isMain = path.resolve(process.argv[1] ?? "") === __filename;

if (__isMain) {
    // ===== summarizeArgs: tool.execute.before audit-line helper =====

    test("summarizeArgs: Bearer jwt in a Bash command is absent", () => {
        const jwt =
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
        const out = summarizeArgs({
            command: `curl -H "Authorization: Bearer ${jwt}" https://api.example/v1`,
        });
        assert.equal(
            out.includes(jwt),
            false,
            "Bearer jwt in command must not survive into the audit line",
        );
        assert.match(out, /Bearer \[redacted\]/);
    });

    test("summarizeArgs: api_key in a Bash command is absent", () => {
        const secret = "sk-abcdefghij1234567890qrstuvwxyz";
        const out = summarizeArgs({
            command: `export api_key=${secret} && deploy`,
        });
        assert.equal(
            out.includes(secret),
            false,
            "api_key in command must not survive into the audit line",
        );
        assert.match(out, /api_key=\[redacted\]/);
    });

    test("summarizeArgs: secret in each of the 6 allowlisted fields is absent", () => {
        // A context-independent secret shape: a 40-hex-char blob is caught by
        // the standalone high-entropy rule ([0-9a-f]{32,}) regardless of the
        // surrounding field context. This proves the scrubber is APPLIED to
        // every allowlisted field (the regression under test), independent of
        // field-specific context matching.
        const hex = "0123456789abcdef0123456789abcdef01234567";
        const out = summarizeArgs({
            command: `echo ${hex}`,
            filePath: hex,
            pattern: hex,
            query: hex,
            url: `https://api.example/v1?t=${hex}`,
            workdir: hex,
        });
        assert.equal(
            out.includes(hex),
            false,
            "hex blob must be absent from every field in the audit summary",
        );
        assert.match(out, /\[redacted\]/);
    });

    test("summarizeArgs: secret in `path` field (filePath alias) is absent", () => {
        const secret = "sk-zyxwvutsrqponmlkjihgfedcba987654";
        const out = summarizeArgs({
            path: `token=${secret}`,
        });
        assert.equal(
            out.includes(secret),
            false,
            "secret in path field must not survive into the audit line",
        );
        assert.match(out, /token=\[redacted\]/);
    });

    test("summarizeArgs: safe command with no secret is unchanged (no over-redaction)", () => {
        const out = summarizeArgs({
            command: "rm -rf tmp/ && make build",
            workdir: ".",
        });
        assert.match(out, /command=rm -rf tmp\/ && make build/);
        assert.match(out, /workdir=\./);
    });

    test("summarizeArgs: normal file path is unchanged (no false-positive)", () => {
        const fp = "src/internal/runtime/substrate.go";
        const out = summarizeArgs({ filePath: fp });
        assert.equal(out, `path=${fp}`);
    });

    test("summarizeArgs: empty / non-object args -> empty string", () => {
        assert.equal(summarizeArgs(null), "");
        assert.equal(summarizeArgs(undefined), "");
        assert.equal(summarizeArgs({}), "args=0");
    });

    test("summarizeArgs: unknown tool with secret arg -> arg count only, no raw value", () => {
        const out = summarizeArgs({
            secret: "sk-leakshouldnotappear12345678",
            other: "Bearer xyz123abc456def789ghi012jkl345",
        });
        assert.match(out, /args=2/);
        assert.equal(
            out.includes("sk-leakshouldnotappear12345678"),
            false,
            "raw unknown-arg value must not be dumped",
        );
    });

    // ===== permission.ask pattern-audit value (enforce / live / audit branches) =====
    //
    // All three permission.ask branches build the audit line with the SAME
    // expression: scrubTruncate((input && input.pattern) || "", MAX_ARG_LEN).
    // We test that expression directly (it is the value interpolated into the
    // `pattern=${pattern}` field of the stderr audit line) so a secret in a
    // permission pattern cannot survive into any of the three audit lines.

    test("permission pattern: Bearer jwt is absent from the audit value", () => {
        const jwt =
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
        const input = { type: "bash", pattern: `curl -H "Authorization: Bearer ${jwt}"` };
        // The exact expression the three permission.ask branches interpolate.
        const patternVal = scrubTruncate(
            (input && input.pattern) || "",
            MAX_ARG_LEN,
        );
        assert.equal(
            patternVal.includes(jwt),
            false,
            "Bearer jwt in permission pattern must not survive into the audit line",
        );
        assert.match(patternVal, /Bearer \[redacted\]/);
    });

    test("permission pattern: api_key is absent from the audit value", () => {
        const secret = "sk-abcdefghij1234567890qrstuvwxyz";
        const input = { type: "bash", pattern: `export api_key=${secret}` };
        const patternVal = scrubTruncate(
            (input && input.pattern) || "",
            MAX_ARG_LEN,
        );
        assert.equal(patternVal.includes(secret), false);
        assert.match(patternVal, /api_key=\[redacted\]/);
    });

    test("permission pattern: safe pattern with no secret is unchanged", () => {
        const input = { type: "bash", pattern: "rm -rf tmp/" };
        const patternVal = scrubTruncate(
            (input && input.pattern) || "",
            MAX_ARG_LEN,
        );
        assert.equal(patternVal, "rm -rf tmp/");
    });

    test("permission pattern: missing input -> empty string (no crash)", () => {
        assert.equal(scrubTruncate((null && null.pattern) || "", MAX_ARG_LEN), "");
        assert.equal(scrubTruncate((undefined && undefined.pattern) || "", MAX_ARG_LEN), "");
    });

    // ===== Config readers: three-level layered model (project > user > default) =====
    //
    // Filesystem tests for readConfig() (plugin-behavior) and readLlmConfig()
    // (LLM). Each test writes temp file(s) under tmp/auto-gate-config-test/,
    // resets ALL caches via __resetConfigCaches(), and asserts fail-safe +
    // layered-merge behavior. The readers accept injectable PROJECT and USER
    // paths (defaulting to the production repo-configs + <XDG_CONFIG_HOME>
    // paths) so tests never touch the real config locations. Capture
    // console.error to assert audit-spam / audit-line behavior.

    const TEST_CONFIG_DIR = path.resolve(
        repoRoot(),
        "tmp",
        "auto-gate-config-test",
    );

    function writeTestConfig(name, objOrString) {
        const body =
            typeof objOrString === "string"
                ? objOrString
                : JSON.stringify(objOrString);
        fs.writeFileSync(path.join(TEST_CONFIG_DIR, name), body, "utf8");
    }

    function testConfigPath(name) {
        return path.join(TEST_CONFIG_DIR, name);
    }

    // Non-existent USER-level paths for the existing single-file tests: they
    // exercise the "user-level missing → SILENT → only project applies" path,
    // so those tests stay semantically identical to the pre-layered behavior
    // (a missing user file contributes nothing to the merge). Using a
    // dedicated non-existent path ALSO keeps the tests deterministic
    // independent of the dev machine's real user-level config (which the
    // production default USER_*_PATH would otherwise read).
    const NO_USER_PLUGIN = testConfigPath("no-such-user-plugin.json");
    const NO_USER_LLM = testConfigPath("no-such-user-llm.json");

    // Ensure the test dir exists for the reader tests below (idempotent).
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });

    // Silence + capture console.error so a missing-file / invalid-JSON audit
    // line does not pollute test output, and so we can assert it fired (or not).
    function captureErrors(fn) {
        const errors = [];
        const orig = console.error;
        console.error = (msg) => errors.push(msg);
        try {
            fn(errors);
        } finally {
            console.error = orig;
        }
    }

    test("readConfig (plugin): missing file -> fail-safe defaults {enabled:true, mode:audit}", () => {
        __resetConfigCaches();
        const cfg = readConfig(testConfigPath("no-such-plugin.json"), NO_USER_PLUGIN);
        assert.deepEqual(cfg, {
            enabled: true,
            mode: "audit",
            stubVerdict: "block",
            promptFile: "",
            replyMode: "once",
            onUncertain: "reject",
            harnessContext: true,
            guides: true,
        });
    });

    test("readConfig (plugin): valid partial -> merged over defaults", () => {
        __resetConfigCaches();
        writeTestConfig("plugin-partial.json", { mode: "enforce" });
        const cfg = readConfig(testConfigPath("plugin-partial.json"), NO_USER_PLUGIN);
        assert.deepEqual(cfg, {
            enabled: true,
            mode: "enforce",
            stubVerdict: "block",
            promptFile: "",
            replyMode: "once",
            onUncertain: "reject",
            harnessContext: true,
            guides: true,
        });
    });

    test("readConfig (plugin): ignores LLM fields entirely (clean cut)", () => {
        __resetConfigCaches();
        writeTestConfig("plugin-with-llm.json", {
            enabled: true,
            mode: "live",
            modelEndpoint: "https://should-be-ignored.example",
            model: "ignored",
            apiKeyEnv: "IGNORED_KEY",
            timeoutMs: 9999,
        });
        const cfg = readConfig(testConfigPath("plugin-with-llm.json"), NO_USER_PLUGIN);
        // Returns ONLY the 4 plugin-behavior fields; LLM keys absent.
        assert.deepEqual(cfg, {
            enabled: true,
            mode: "live",
            stubVerdict: "block",
            promptFile: "",
            replyMode: "once",
            onUncertain: "reject",
            harnessContext: true,
            guides: true,
        });
        assert.equal(
            "modelEndpoint" in cfg,
            false,
            "LLM fields must not appear in plugin config",
        );
    });

    test("readConfig (plugin): invalid JSON -> defaults + audit line", () => {
        __resetConfigCaches();
        writeTestConfig("plugin-invalid.json", "{ not valid json");
        captureErrors((errors) => {
            const cfg = readConfig(testConfigPath("plugin-invalid.json"), NO_USER_PLUGIN);
            assert.deepEqual(cfg, {
                enabled: true,
                mode: "audit",
                stubVerdict: "block",
                promptFile: "",
                replyMode: "once",
                onUncertain: "reject",
                harnessContext: true,
                guides: true,
            });
            assert.equal(errors.length, 1, "present-but-invalid must warn once");
            assert.match(errors[0], /invalid JSON/);
        });
    });

    // ===== F3 fail-safe: a JSON parse that does NOT yield a plain object =====
    //
    // A file containing the literal `null` (or an array, or a bare primitive)
    // parses successfully but is not a config object — the normalizer would
    // throw on property access (e.g. `parsed.enabled` on null). The reader must
    // return fail-safe defaults, never throw, and use the SAME deduped "invalid"
    // audit path as a syntactically broken file.

    test("readConfig (plugin): literal null -> defaults, no throw + ONE deduped audit line", () => {
        __resetConfigCaches();
        writeTestConfig("plugin-null.json", "null");
        captureErrors((errors) => {
            const a = readConfig(testConfigPath("plugin-null.json"), NO_USER_PLUGIN);
            const b = readConfig(testConfigPath("plugin-null.json"), NO_USER_PLUGIN);
            assert.deepEqual(a, {
                enabled: true,
                mode: "audit",
                stubVerdict: "block",
                promptFile: "",
                replyMode: "once",
                onUncertain: "reject",
                harnessContext: true,
                guides: true,
            });
            assert.deepEqual(b, a, "second read of same bad file still returns defaults");
            // Dedup contract (same as invalid JSON): one audit line across both reads.
            assert.equal(errors.length, 1, "non-object parse must warn once (deduped)");
            assert.match(errors[0], /invalid JSON/);
        });
    });

    test("readConfig (plugin): array / primitive shapes -> defaults, no throw", () => {
        for (const body of ["[]", "42", "\"oops\"", "true"]) {
            __resetConfigCaches();
            writeTestConfig("plugin-shape.json", body);
            captureErrors((errors) => {
                const cfg = readConfig(testConfigPath("plugin-shape.json"), NO_USER_PLUGIN);
                assert.deepEqual(cfg, {
                    enabled: true,
                    mode: "audit",
                    stubVerdict: "block",
                    promptFile: "",
                    replyMode: "once",
                    onUncertain: "reject",
                    harnessContext: true,
                    guides: true,
                });
                assert.equal(errors.length, 1, `body ${body} must warn once`);
            });
        }
    });

    test("readLlmConfig: missing file -> defaults, NO throw, NO audit spam", () => {
        __resetConfigCaches();
        captureErrors((errors) => {
            const cfg = readLlmConfig(testConfigPath("no-such-llm.json"), NO_USER_LLM);
            assert.deepEqual(cfg, {
                modelEndpoint: "",
                modelEndpointEnv: "AUTO_GATE_MODEL_ENDPOINT",
                model: "",
                apiKey: "",
                apiKeyEnv: "AUTO_GATE_API_KEY",
                timeoutMs: 8000,
                maxRetries: 1,
                retryDelayMs: 500,
                leaves: [],
            });
            assert.equal(
                errors.length,
                0,
                "missing LLM file is normal — must NOT emit audit spam",
            );
        });
    });

    test("readLlmConfig: valid file -> merged fields", () => {
        __resetConfigCaches();
        writeTestConfig("llm-valid.json", {
            modelEndpoint: "https://provider.example/v1/chat/completions",
            model: "test-model",
            apiKeyEnv: "MY_GATE_KEY",
            timeoutMs: 4000,
            maxRetries: 3,
            retryDelayMs: 250,
        });
        const cfg = readLlmConfig(testConfigPath("llm-valid.json"), NO_USER_LLM);
        assert.deepEqual(cfg, {
            modelEndpoint: "https://provider.example/v1/chat/completions",
            modelEndpointEnv: "AUTO_GATE_MODEL_ENDPOINT",
            model: "test-model",
            apiKey: "",
            apiKeyEnv: "MY_GATE_KEY",
            timeoutMs: 4000,
            maxRetries: 3,
            retryDelayMs: 250,
            leaves: [],
        });
    });

    test("readLlmConfig: partial config merges over defaults", () => {
        __resetConfigCaches();
        writeTestConfig("llm-partial.json", { modelEndpoint: "https://x" });
        const cfg = readLlmConfig(testConfigPath("llm-partial.json"), NO_USER_LLM);
        assert.deepEqual(cfg, {
            modelEndpoint: "https://x",
            modelEndpointEnv: "AUTO_GATE_MODEL_ENDPOINT",
            model: "",
            apiKey: "",
            apiKeyEnv: "AUTO_GATE_API_KEY",
            timeoutMs: 8000,
            maxRetries: 1,
            retryDelayMs: 500,
            leaves: [],
        });
    });

    test("readLlmConfig: invalid JSON -> defaults + ONE audit line", () => {
        __resetConfigCaches();
        writeTestConfig("llm-invalid.json", "{ broken json");
        captureErrors((errors) => {
            const cfg = readLlmConfig(testConfigPath("llm-invalid.json"), NO_USER_LLM);
            assert.deepEqual(cfg, {
                modelEndpoint: "",
                modelEndpointEnv: "AUTO_GATE_MODEL_ENDPOINT",
                model: "",
                apiKey: "",
                apiKeyEnv: "AUTO_GATE_API_KEY",
                timeoutMs: 8000,
                maxRetries: 1,
                retryDelayMs: 500,
                leaves: [],
            });
            assert.equal(
                errors.length,
                1,
                "present-but-invalid LLM file must emit ONE audit line",
            );
            assert.match(errors[0], /invalid JSON/);
        });
    });

    // ===== F3 fail-safe (LLM side): non-object parse results =====

    test("readLlmConfig: literal null -> defaults, no throw + ONE deduped audit line", () => {
        __resetConfigCaches();
        writeTestConfig("llm-null.json", "null");
        captureErrors((errors) => {
            const a = readLlmConfig(testConfigPath("llm-null.json"), NO_USER_LLM);
            const b = readLlmConfig(testConfigPath("llm-null.json"), NO_USER_LLM);
            assert.deepEqual(a, {
                modelEndpoint: "",
                modelEndpointEnv: "AUTO_GATE_MODEL_ENDPOINT",
                model: "",
                apiKey: "",
                apiKeyEnv: "AUTO_GATE_API_KEY",
                timeoutMs: 8000,
                maxRetries: 1,
                retryDelayMs: 500,
                leaves: [],
            });
            assert.deepEqual(b, a, "second read of same bad file still returns defaults");
            // A PRESENT-but-non-object file is not the normal "no live setup" case,
            // so it must emit the audit line once (deduped across both reads).
            assert.equal(errors.length, 1, "non-object parse must warn once (deduped)");
            assert.match(errors[0], /invalid JSON/);
        });
    });

    test("readLlmConfig: array / primitive shapes -> defaults, no throw", () => {
        for (const body of ["[]", "42", "\"oops\"", "true"]) {
            __resetConfigCaches();
            writeTestConfig("llm-shape.json", body);
            captureErrors((errors) => {
                const cfg = readLlmConfig(testConfigPath("llm-shape.json"), NO_USER_LLM);
                assert.deepEqual(cfg, {
                    modelEndpoint: "",
                    modelEndpointEnv: "AUTO_GATE_MODEL_ENDPOINT",
                    model: "",
                    apiKey: "",
                    apiKeyEnv: "AUTO_GATE_API_KEY",
                    timeoutMs: 8000,
                    maxRetries: 1,
                    retryDelayMs: 500,
                    leaves: [],
                });
                assert.equal(errors.length, 1, `body ${body} must warn once`);
            });
        }
    });

    test("readLlmConfig: apiKeyEnv default is AUTO_GATE_API_KEY", () => {
        __resetConfigCaches();
        writeTestConfig("llm-no-env.json", {
            modelEndpoint: "https://x",
            model: "m",
        });
        const cfg = readLlmConfig(testConfigPath("llm-no-env.json"), NO_USER_LLM);
        assert.equal(cfg.apiKeyEnv, "AUTO_GATE_API_KEY");
    });

    // ===== Dual-form normalize tests (modelEndpointEnv, apiKey) =====

    test("readLlmConfig: modelEndpointEnv defaults to AUTO_GATE_MODEL_ENDPOINT when absent", () => {
        __resetConfigCaches();
        writeTestConfig("llm-no-endpoint-env.json", {
            modelEndpoint: "https://x",
            model: "m",
        });
        const cfg = readLlmConfig(testConfigPath("llm-no-endpoint-env.json"), NO_USER_LLM);
        assert.equal(cfg.modelEndpointEnv, "AUTO_GATE_MODEL_ENDPOINT");
    });

    test("readLlmConfig: modelEndpointEnv preserved when specified", () => {
        __resetConfigCaches();
        writeTestConfig("llm-custom-endpoint-env.json", {
            modelEndpoint: "https://x",
            modelEndpointEnv: "MY_CUSTOM_ENDPOINT_VAR",
            model: "m",
        });
        const cfg = readLlmConfig(testConfigPath("llm-custom-endpoint-env.json"), NO_USER_LLM);
        assert.equal(cfg.modelEndpointEnv, "MY_CUSTOM_ENDPOINT_VAR");
    });

    test("readLlmConfig: apiKey defaults to empty string when absent", () => {
        __resetConfigCaches();
        writeTestConfig("llm-no-apikey.json", {
            modelEndpoint: "https://x",
            model: "m",
        });
        const cfg = readLlmConfig(testConfigPath("llm-no-apikey.json"), NO_USER_LLM);
        assert.equal(cfg.apiKey, "");
    });

    test("readLlmConfig: apiKey preserved when specified (literal key value)", () => {
        __resetConfigCaches();
        writeTestConfig("llm-literal-apikey.json", {
            modelEndpoint: "https://x",
            model: "m",
            apiKey: "sk-literal-key-12345",
        });
        const cfg = readLlmConfig(testConfigPath("llm-literal-apikey.json"), NO_USER_LLM);
        assert.equal(cfg.apiKey, "sk-literal-key-12345");
    });

    test("readLlmConfig: PARTIAL override — project sets only modelEndpointEnv, user fills the rest", () => {
        __resetConfigCaches();
        writeTestConfig("layered-llm-user-endpoint-env.json", {
            modelEndpoint: "http://u",
            model: "user-model",
            apiKeyEnv: "USER_KEY",
            timeoutMs: 9000,
        });
        writeTestConfig("layered-llm-proj-endpoint-env.json", {
            modelEndpointEnv: "PROJ_ENDPOINT_VAR",
        });
        const merged = readLlmConfig(
            testConfigPath("layered-llm-proj-endpoint-env.json"),
            testConfigPath("layered-llm-user-endpoint-env.json"),
        );
        // Project overrides ONLY modelEndpointEnv; user fills every other field.
        assert.equal(merged.modelEndpointEnv, "PROJ_ENDPOINT_VAR", "project modelEndpointEnv must apply");
        assert.equal(merged.modelEndpoint, "http://u", "user modelEndpoint must survive");
        assert.equal(merged.model, "user-model", "user model must survive");
        assert.equal(merged.apiKeyEnv, "USER_KEY", "user apiKeyEnv must survive");
        assert.equal(merged.apiKey, "", "absent apiKey must default to empty");
        assert.equal(merged.timeoutMs, 9000, "user timeoutMs must survive");
    });

    test("readLlmConfig: invalid types fall back to defaults", () => {
        __resetConfigCaches();
        // Wrong types: modelEndpoint as number, model as null, apiKeyEnv empty,
        // timeoutMs as negative number, maxRetries as negative, retryDelayMs as
        // a non-numeric string. Each must normalize to its default.
        writeTestConfig("llm-badtypes.json", {
            modelEndpoint: 123,
            model: null,
            apiKeyEnv: "",
            timeoutMs: -5,
            maxRetries: -2,
            retryDelayMs: "fast",
        });
        const cfg = readLlmConfig(testConfigPath("llm-badtypes.json"), NO_USER_LLM);
        assert.deepEqual(cfg, {
            modelEndpoint: "",
            modelEndpointEnv: "AUTO_GATE_MODEL_ENDPOINT",
            model: "",
            apiKey: "",
            apiKeyEnv: "AUTO_GATE_API_KEY",
            timeoutMs: 8000,
            maxRetries: 1,
            retryDelayMs: 500,
            leaves: [],
        });
    });

    test("readLlmConfig: mtime cache returns SAME object on unchanged file", () => {
        __resetConfigCaches();
        writeTestConfig("llm-cache.json", { model: "cached-model" });
        const a = readLlmConfig(testConfigPath("llm-cache.json"), NO_USER_LLM);
        const b = readLlmConfig(testConfigPath("llm-cache.json"), NO_USER_LLM);
        assert.equal(
            a,
            b,
            "unchanged file (same mtime) must return the SAME cached object",
        );
    });

    test("readLlmConfig: re-read after file change sees new content", (t, done) => {
        __resetConfigCaches();
        writeTestConfig("llm-mutate.json", { model: "first" });
        const a = readLlmConfig(testConfigPath("llm-mutate.json"), NO_USER_LLM);
        assert.equal(a.model, "first");
        // Bump mtime by writing new content, then ensure a fresh mtime
        // (statSync resolution is ms-level; nudge with a tiny delay).
        setTimeout(() => {
            writeTestConfig("llm-mutate.json", { model: "second" });
            const b = readLlmConfig(testConfigPath("llm-mutate.json"), NO_USER_LLM);
            assert.equal(b.model, "second", "changed file must re-read");
            done();
        }, 20);
    });

    test("merged call-site: {...readConfig(), ...readLlmConfig()} yields all 15 fields", () => {
        __resetConfigCaches();
        writeTestConfig("merge-plugin.json", {
            enabled: true,
            mode: "live",
            promptFile: "/x",
        });
        writeTestConfig("merge-llm.json", {
            modelEndpoint: "https://x",
            model: "m",
            apiKeyEnv: "K",
            timeoutMs: 3000,
            maxRetries: 2,
            retryDelayMs: 750,
        });
        const merged = {
            ...readConfig(testConfigPath("merge-plugin.json"), NO_USER_PLUGIN),
            ...readLlmConfig(testConfigPath("merge-llm.json"), NO_USER_LLM),
        };
        assert.deepEqual(merged, {
            enabled: true,
            mode: "live",
            stubVerdict: "block",
            promptFile: "/x",
            replyMode: "once",
            onUncertain: "reject",
            harnessContext: true,
            guides: true,
            modelEndpoint: "https://x",
            modelEndpointEnv: "AUTO_GATE_MODEL_ENDPOINT",
            model: "m",
            apiKey: "",
            apiKeyEnv: "K",
            timeoutMs: 3000,
            maxRetries: 2,
            retryDelayMs: 750,
            leaves: [],
        });
    });

    // ===== maxRetries / retryDelayMs reader tests (new fields) =====

    test("readLlmConfig: missing maxRetries/retryDelayMs default to 1/500", () => {
        __resetConfigCaches();
        writeTestConfig("llm-no-retry.json", {
            modelEndpoint: "https://x",
            model: "m",
        });
        const cfg = readLlmConfig(testConfigPath("llm-no-retry.json"), NO_USER_LLM);
        assert.equal(cfg.maxRetries, 1, "default maxRetries is 1");
        assert.equal(cfg.retryDelayMs, 500, "default retryDelayMs is 500");
    });

    test("readLlmConfig: maxRetries:0 is preserved (NOT coerced to default)", () => {
        // 0 is a valid, meaningful value (single attempt, the pre-retry
        // behavior). It must NOT be normalized to the default 1.
        __resetConfigCaches();
        writeTestConfig("llm-no-retry-zero.json", {
            modelEndpoint: "https://x",
            model: "m",
            maxRetries: 0,
            retryDelayMs: 0,
        });
        const cfg = readLlmConfig(testConfigPath("llm-no-retry-zero.json"), NO_USER_LLM);
        assert.equal(cfg.maxRetries, 0, "maxRetries:0 must be preserved");
        assert.equal(cfg.retryDelayMs, 0, "retryDelayMs:0 must be preserved");
    });

    test("readLlmConfig: numeric-string maxRetries/retryDelayMs are coerced to ints", () => {
        __resetConfigCaches();
        writeTestConfig("llm-retry-str.json", {
            modelEndpoint: "https://x",
            model: "m",
            maxRetries: "5",
            retryDelayMs: "1200",
        });
        const cfg = readLlmConfig(testConfigPath("llm-retry-str.json"), NO_USER_LLM);
        assert.equal(cfg.maxRetries, 5);
        assert.equal(cfg.retryDelayMs, 1200);
    });

    test("readLlmConfig: float maxRetries/retryDelayMs are floored", () => {
        __resetConfigCaches();
        writeTestConfig("llm-retry-float.json", {
            modelEndpoint: "https://x",
            model: "m",
            maxRetries: 2.9,
            retryDelayMs: 500.7,
        });
        const cfg = readLlmConfig(testConfigPath("llm-retry-float.json"), NO_USER_LLM);
        assert.equal(cfg.maxRetries, 2);
        assert.equal(cfg.retryDelayMs, 500);
    });

    test("readLlmConfig: retry fields merge into the live call-site config", () => {
        // The production merge is `{...config, ...readLlmConfig()}`. This pins
        // that maxRetries/retryDelayMs survive the spread (the LLM spread wins
        // over plugin config, and these fields only exist on the LLM side).
        __resetConfigCaches();
        writeTestConfig("merge-plugin2.json", {
            enabled: true,
            mode: "live",
        });
        writeTestConfig("merge-llm2.json", {
            modelEndpoint: "https://x",
            model: "m",
            apiKeyEnv: "K",
            timeoutMs: 3000,
            maxRetries: 4,
            retryDelayMs: 1000,
        });
        const liveConfig = {
            ...readConfig(testConfigPath("merge-plugin2.json"), NO_USER_PLUGIN),
            ...readLlmConfig(testConfigPath("merge-llm2.json"), NO_USER_LLM),
        };
        assert.equal(liveConfig.maxRetries, 4, "maxRetries must reach the live config");
        assert.equal(liveConfig.retryDelayMs, 1000, "retryDelayMs must reach the live config");
        // The two config sources must not collide: plugin config has 8 fields,
        // LLM config has 9 (8 scalar + the leaves array); the merged object has
        // all 17 (8 plugin + 9 LLM).
        assert.equal(Object.keys(liveConfig).length, 17);
    });

    // ===================================================================
    // THREE-LEVEL LAYERED CONFIG TESTS (user-level base, project-level override)
    //
    // Precedence: defaults <- user <- project (project wins per field).
    // The tests inject BOTH paths via the 2-arg signature; production callers
    // omit the second arg (defaults to <XDG_CONFIG_HOME>/vh-agent-harness/...).
    // ===================================================================

    test("readConfig: user-level missing -> project applies (existing behavior)", () => {
        __resetConfigCaches();
        writeTestConfig("layered-proj-1.json", { mode: "enforce" });
        const cfg = readConfig(
            testConfigPath("layered-proj-1.json"),
            NO_USER_PLUGIN, // non-existent user file (silent missing)
        );
        assert.deepEqual(cfg, {
            enabled: true,
            mode: "enforce",
            stubVerdict: "block",
            promptFile: "",
            replyMode: "once",
            onUncertain: "reject",
            harnessContext: true,
            guides: true,
        });
    });

    test("readConfig: user-level present, project missing -> user applies", () => {
        __resetConfigCaches();
        writeTestConfig("layered-user-2.json", { mode: "enforce", stubVerdict: "allow" });
        const cfg = readConfig(
            testConfigPath("no-such-plugin.json"), // non-existent project file
            testConfigPath("layered-user-2.json"),
        );
        assert.deepEqual(cfg, {
            enabled: true,
            mode: "enforce",
            stubVerdict: "allow",
            promptFile: "",
            replyMode: "once",
            onUncertain: "reject",
            harnessContext: true,
            guides: true,
        });
    });

    test("readConfig: BOTH present -> project overrides user field-by-field", () => {
        __resetConfigCaches();
        writeTestConfig("layered-user-3.json", { mode: "enforce" });
        writeTestConfig("layered-proj-3.json", { mode: "live" });
        const cfg = readConfig(
            testConfigPath("layered-proj-3.json"),
            testConfigPath("layered-user-3.json"),
        );
        // True field-by-field merge: project specifies ONLY mode, so it wins on
        // mode; every other field is absent from both → defaults. (Both files
        // here are single-field, so this is the same as full-file override —
        // see the PARTIAL-override tests below for the discriminating case.)
        assert.equal(cfg.mode, "live", "project mode must override user mode");
    });

    test("readConfig: BOTH missing -> defaults", () => {
        __resetConfigCaches();
        const cfg = readConfig(
            testConfigPath("no-such-plugin.json"),
            NO_USER_PLUGIN,
        );
        assert.deepEqual(cfg, {
            enabled: true,
            mode: "audit",
            stubVerdict: "block",
            promptFile: "",
            replyMode: "once",
            onUncertain: "reject",
            harnessContext: true,
            guides: true,
        });
    });

    test("readConfig: user invalid -> project applies + deduped audit (label includes level)", () => {
        __resetConfigCaches();
        writeTestConfig("layered-user-invalid-5.json", "{ not valid json");
        writeTestConfig("layered-proj-5.json", { mode: "enforce" });
        captureErrors((errors) => {
            const cfg = readConfig(
                testConfigPath("layered-proj-5.json"),
                testConfigPath("layered-user-invalid-5.json"),
            );
            assert.equal(cfg.mode, "enforce", "project must apply when user is invalid");
            assert.equal(
                errors.length,
                1,
                "present-but-invalid user file must warn exactly once",
            );
            assert.match(errors[0], /plugin\/user/, "audit label must include the user level");
        });
    });

    test("readLlmConfig: user present, project missing -> user applies (silent on user-missing)", () => {
        __resetConfigCaches();
        writeTestConfig("layered-llm-user-6.json", { model: "test-model" });
        const cfg = readLlmConfig(
            testConfigPath("no-such-llm.json"), // non-existent project file
            testConfigPath("layered-llm-user-6.json"),
        );
        assert.equal(cfg.model, "test-model", "user model must apply when project is missing");
    });

    test("readLlmConfig: BOTH present -> project overrides user", () => {
        __resetConfigCaches();
        writeTestConfig("layered-llm-user-7.json", { model: "user-model" });
        writeTestConfig("layered-llm-proj-7.json", { model: "project-model" });
        const cfg = readLlmConfig(
            testConfigPath("layered-llm-proj-7.json"),
            testConfigPath("layered-llm-user-7.json"),
        );
        // True field-by-field merge: both files specify ONLY model, so project
        // wins on model; the other fields are absent from both → defaults.
        // (Full-file override is a special case of field-by-field — see the
        // PARTIAL-override tests below for the discriminating case.)
        assert.equal(cfg.model, "project-model", "project model must override user model");
    });

    test("mtime cache: BOTH files unchanged -> single merged result reused", () => {
        __resetConfigCaches();
        writeTestConfig("layered-user-cache-8.json", { mode: "enforce" });
        writeTestConfig("layered-proj-cache-8.json", { mode: "live" });
        const a = readConfig(
            testConfigPath("layered-proj-cache-8.json"),
            testConfigPath("layered-user-cache-8.json"),
        );
        const b = readConfig(
            testConfigPath("layered-proj-cache-8.json"),
            testConfigPath("layered-user-cache-8.json"),
        );
        assert.equal(
            a,
            b,
            "both files unchanged must return the SAME cached merged object",
        );
    });

    test("mtime cache: EITHER file changed -> re-read + re-merge", (t, done) => {
        __resetConfigCaches();
        writeTestConfig("layered-user-mut-9.json", { mode: "enforce" });
        writeTestConfig("layered-proj-mut-9.json", { mode: "live" });
        const a = readConfig(
            testConfigPath("layered-proj-mut-9.json"),
            testConfigPath("layered-user-mut-9.json"),
        );
        assert.equal(a.mode, "live", "initial read: project mode=live");
        // Bump mtime by writing new content to the USER file, then re-read.
        // statSync resolution is ms-level; nudge with a tiny delay.
        setTimeout(() => {
            writeTestConfig("layered-user-mut-9.json", { mode: "audit" });
            const b = readConfig(
                testConfigPath("layered-proj-mut-9.json"),
                testConfigPath("layered-user-mut-9.json"),
            );
            // Project still wins (mode=live), but the cache must have been
            // invalidated by the user-file mtime change — b is a NEW object.
            assert.notEqual(
                a,
                b,
                "user file changed -> cache invalidated -> new merged object",
            );
            assert.equal(b.mode, "live", "project still overrides user after re-merge");
            done();
        }, 20);
    });

    // -----------------------------------------------------------------
    // PARTIAL-OVERRIDE REGRESSION GUARDS (the feature's primary use case).
    //
    // These are DISCRIMINATING tests: they FAIL on the OLD all-or-nothing-per-
    // FILE merge (where a successfully-parsed project file normalized to a full
    // object and, spread last, clobbered every user-level field with default-
    // filled values) and PASS on the fixed field-by-field merge. They are the
    // canonical regression guard for the raw-merge-then-normalize-once fix.
    //
    // The concrete failure the fix repairs: an operator sets the LLM endpoint/
    // key ONCE at user level, a project specializes just the model — under the
    // old code the user's endpoint/key were silently destroyed (project's
    // default-filled modelEndpoint="" won), fail-closing live mode to deny.
    // -----------------------------------------------------------------

    test("readLlmConfig: PARTIAL project overrides ONLY specified field; user fills the rest", () => {
        __resetConfigCaches();
        writeTestConfig("layered-llm-user-partial.json", {
            modelEndpoint: "http://u",
            model: "user-model",
            apiKeyEnv: "USER_KEY",
            timeoutMs: 9000,
            maxRetries: 2,
            retryDelayMs: 400,
        });
        writeTestConfig("layered-llm-proj-partial.json", { model: "proj-model" }); // ONLY model
        const merged = readLlmConfig(
            testConfigPath("layered-llm-proj-partial.json"),
            testConfigPath("layered-llm-user-partial.json"),
        );
        // Project overrides ONLY model; user fills every other field. OLD code
        // would have set modelEndpoint="" and apiKeyEnv="AUTO_GATE_API_KEY"
        // (project's default-filled keys winning).
        assert.equal(merged.modelEndpoint, "http://u", "user modelEndpoint must survive (NOT default '')");
        assert.equal(merged.model, "proj-model", "project model must override user model");
        assert.equal(merged.apiKeyEnv, "USER_KEY", "user apiKeyEnv must survive (NOT default)");
        assert.equal(merged.timeoutMs, 9000, "user timeoutMs must survive");
        assert.equal(merged.maxRetries, 2, "user maxRetries must survive");
        assert.equal(merged.retryDelayMs, 400, "user retryDelayMs must survive");
    });

    test("readConfig: PARTIAL project overrides ONLY specified field; user fills the rest", () => {
        __resetConfigCaches();
        writeTestConfig("layered-user-partial.json", {
            enabled: true,
            mode: "live",
            stubVerdict: "allow",
            promptFile: "/x",
            replyMode: "once",
            onUncertain: "reject",
            harnessContext: true,
            guides: true,
        });
        writeTestConfig("layered-proj-partial.json", { mode: "enforce" }); // ONLY mode
        const merged = readConfig(
            testConfigPath("layered-proj-partial.json"),
            testConfigPath("layered-user-partial.json"),
        );
        // Project overrides ONLY mode; user fills every other field. OLD code
        // would have reset the user's stubVerdict/promptFile/replyMode/onUncertain
        // to defaults (project's default-filled keys winning).
        assert.equal(merged.mode, "enforce", "project mode must override user mode");
        assert.equal(merged.enabled, true, "user enabled must survive");
        assert.equal(merged.stubVerdict, "allow", "user stubVerdict must survive (NOT default 'block')");
        assert.equal(merged.promptFile, "/x", "user promptFile must survive (NOT default '')");
        assert.equal(merged.replyMode, "once", "user replyMode must survive");
        assert.equal(merged.onUncertain, "reject", "user onUncertain must survive");
        assert.equal(merged.harnessContext, true, "default harnessContext must survive (NOT set by either level)");
        assert.equal(merged.guides, true, "default guides must survive (NOT set by either level)");
    });

    test("readLlmConfig: PARTIAL user + missing project -> user fields apply, absent fields default", () => {
        __resetConfigCaches();
        writeTestConfig("layered-llm-user-only-model.json", { model: "only-model" }); // ONLY model
        const merged = readLlmConfig(
            testConfigPath("no-such-llm.json"), // non-existent project file
            testConfigPath("layered-llm-user-only-model.json"),
        );
        // User's single field applies; fields the user omits take defaults.
        assert.equal(merged.model, "only-model", "user model must apply");
        assert.equal(merged.modelEndpoint, "", "absent modelEndpoint must default to ''");
        assert.equal(merged.apiKeyEnv, "AUTO_GATE_API_KEY", "absent apiKeyEnv must default");
    });

    // ===================================================================
    // EVENT HOOK TESTS — the PRIMARY enforcement surface.
    //
    // Each test builds hooks via server({client, directory, configPath,
    // llmConfigPath}), invokes hooks["event"]({event}) with a fake
    // permission.asked event, and asserts the reply call args on the fake
    // client's postSessionIdPermissionsPermissionId.
    // ===================================================================

    // Helper: fake SDK client recording permission replies.
    function makeEventClient(opts = {}) {
        const replies = [];
        const transcript =
            opts.transcript ||
            [
                {
                    info: { role: "user" },
                    parts: [{ type: "text", text: "hello world" }],
                },
                {
                    info: { role: "assistant" },
                    parts: [{ type: "text", text: "hi there" }],
                },
            ];
        const client = {
            postSessionIdPermissionsPermissionId: async (args) => {
                replies.push({ ...args, _route: "v1" });
                return opts.replyError
                    ? {
                          data: undefined,
                          error: { message: "stub reply error" },
                      }
                    : { data: {}, error: undefined };
            },
            // Underlying openapi-fetch transport used by the v2 permission-reply
            // route (POST /permission/:requestID/reply). Records a v1-compatible
            // normalized entry so existing `replies[i].body.response` assertions
            // still pass, while new tests can assert `replies[i].body.message`
            // and `replies[i]._route`.
            _client: {
                post: async (args) => {
                    const m = String((args && args.url) || "").match(
                        /\/permission\/([^/]+)\/reply/,
                    );
                    const body = (args && args.body) || {};
                    replies.push({
                        path: { permissionID: m ? m[1] : undefined },
                        body: {
                            response: body.reply,
                            message: body.message,
                        },
                        _route: "v2",
                    });
                    return opts.replyError
                        ? {
                              data: undefined,
                              error: { message: "stub reply error" },
                          }
                        : { data: {}, error: undefined };
                },
            },
            session: {
                messages: async () => ({
                    data: transcript,
                    error: undefined,
                }),
            },
        };
        return { client, replies };
    }

    // Helper: fake permission.asked bus event.
    // `rawPermission` (if set) overrides the `permission` field verbatim — used
    // to exercise the SDK wire shape where `permission` is a STRING name (e.g.
    // "bash") rather than an object with a `.type`. When unset, the helper
    // builds the legacy object shape { type: permType }.
    function makeAskedEvent(opts = {}) {
        return {
            type: "permission.asked",
            properties: {
                id: opts.id || "req-evt-1",
                sessionID: opts.sessionID || "sess-evt-1",
                permission:
                    opts.rawPermission !== undefined
                        ? opts.rawPermission
                        : { type: opts.permType || "bash" },
                patterns: opts.patterns || ["ls -la"],
                metadata: opts.metadata || {},
                always: false,
                tool: "bash",
            },
        };
    }

    // Helper: write configs, reset caches, build hooks + client holder.
    async function setupEventTest(pluginCfg, llmCfg, clientOpts) {
        const tag = Math.random().toString(36).slice(2, 8);
        const pName = `evt-p-${tag}.json`;
        const lName = `evt-l-${tag}.json`;
        writeTestConfig(pName, pluginCfg);
        if (llmCfg) writeTestConfig(lName, llmCfg);
        __resetConfigCaches();
        const holder = makeEventClient(clientOpts || {});
        const hooks = await server({
            client: holder.client,
            directory: TEST_CONFIG_DIR,
            configPath: testConfigPath(pName),
            llmConfigPath: testConfigPath(
                llmCfg ? lName : "no-such-llm.json",
            ),
            // Inject non-existent USER-level paths so the event-hook tests are
            // deterministic independent of the dev machine's real user config
            // (user-missing is silent → only the project path above applies).
            userConfigPath: NO_USER_PLUGIN,
            userLlmConfigPath: NO_USER_LLM,
        });
        return { hooks, replies: holder.replies };
    }

    // Mock globalThis.fetch to return a fixed verdict. Returns a restore fn.
    function mockFetchVerdict(verdictText) {
        const orig = globalThis.fetch;
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: verdictText } }],
            }),
        });
        return () => {
            globalThis.fetch = orig;
        };
    }

    // Mock globalThis.fetch to throw. Returns a restore fn.
    function mockFetchThrow(msg) {
        const orig = globalThis.fetch;
        globalThis.fetch = async () => {
            throw new Error(msg);
        };
        return () => {
            globalThis.fetch = orig;
        };
    }

    // Mock globalThis.fetch to capture the request body (the JSON-stringified
    // OpenAI-compatible payload) while returning a fixed verdict. Used to
    // assert what the live path actually SERIALIZES to the model. Returns a
    // restore fn. The captured array receives each request's `body` string.
    function mockFetchCapture(captured, verdictText = "<block>no</block>") {
        const orig = globalThis.fetch;
        globalThis.fetch = async (_url, opts) => {
            if (opts && typeof opts.body === "string") captured.push(opts.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [{ message: { content: verdictText } }],
                }),
            };
        };
        return () => {
            globalThis.fetch = orig;
        };
    }

    // One-time setup for live tests: prompt file + API key env.
    writeTestConfig("evt-classifier-prompt.txt", "You are a classifier.");
    const _origApiKey = process.env.AUTO_GATE_API_KEY;
    process.env.AUTO_GATE_API_KEY = "test-key-for-events";

    // --- audit mode ---

    test("event: audit mode → no reply call", async () => {
        const { hooks, replies } = await setupEventTest({ mode: "audit" });
        await hooks["event"]({ event: makeAskedEvent() });
        assert.equal(replies.length, 0, "audit mode must NOT reply");
    });

    // --- enforce mode ---

    test("event: enforce stubVerdict:allow → reply once (default)", async () => {
        const { hooks, replies } = await setupEventTest({
            mode: "enforce",
            stubVerdict: "allow",
        });
        await hooks["event"]({ event: makeAskedEvent() });
        assert.equal(replies.length, 1);
        assert.equal(replies[0].body.response, "once");
        // Verify path args are threaded correctly.
        assert.equal(replies[0].path.id, "sess-evt-1");
        assert.equal(replies[0].path.permissionID, "req-evt-1");
        // Allow routes through the v1 endpoint and carries NO message.
        assert.equal(replies[0]._route, "v1");
        assert.equal(replies[0].body.message, undefined);
    });

    test("event: enforce stubVerdict:allow + replyMode:always → reply always", async () => {
        const { hooks, replies } = await setupEventTest({
            mode: "enforce",
            stubVerdict: "allow",
            replyMode: "always",
        });
        await hooks["event"]({ event: makeAskedEvent() });
        assert.equal(replies.length, 1);
        assert.equal(replies[0].body.response, "always");
        assert.equal(replies[0]._route, "v1");
        assert.equal(replies[0].body.message, undefined);
    });

    test("event: enforce stubVerdict:block → reply reject", async () => {
        const { hooks, replies } = await setupEventTest({
            mode: "enforce",
            stubVerdict: "block",
        });
        await hooks["event"]({ event: makeAskedEvent() });
        assert.equal(replies.length, 1);
        assert.equal(replies[0].body.response, "reject");
        // Reject now routes through the v2 endpoint with a reason message so
        // the model sees why (per-call gate via CorrectedError).
        assert.equal(replies[0]._route, "v2");
        assert.ok(
            typeof replies[0].body.message === "string" &&
                replies[0].body.message.length > 0,
            "reject must carry a non-empty reason message",
        );
    });

    test("event: enforce stubVerdict:fail → reply reject (fail-closed)", async () => {
        const { hooks, replies } = await setupEventTest({
            mode: "enforce",
            stubVerdict: "fail",
        });
        await hooks["event"]({ event: makeAskedEvent() });
        assert.equal(replies.length, 1);
        assert.equal(replies[0].body.response, "reject");
        assert.equal(replies[0]._route, "v2");
        assert.ok(
            typeof replies[0].body.message === "string" &&
                replies[0].body.message.length > 0,
            "fail-closed reject must carry a reason message",
        );
    });

    // --- live mode ---

    test("event: live allow → reply once", async () => {
        const { hooks, replies } = await setupEventTest(
            {
                mode: "live",
                promptFile: testConfigPath("evt-classifier-prompt.txt"),
            },
            {
                modelEndpoint: "http://mock-llm",
                model: "test-model",
                maxRetries: 0,
            },
        );
        const restore = mockFetchVerdict("<block>no</block>");
        try {
            await hooks["event"]({ event: makeAskedEvent() });
        } finally {
            restore();
        }
        assert.equal(replies.length, 1);
        assert.equal(replies[0].body.response, "once");
    });

    test("event: live deny → reply reject", async () => {
        const { hooks, replies } = await setupEventTest(
            {
                mode: "live",
                promptFile: testConfigPath("evt-classifier-prompt.txt"),
            },
            {
                modelEndpoint: "http://mock-llm",
                model: "test-model",
                maxRetries: 0,
            },
        );
        const restore = mockFetchVerdict("<block>yes</block>");
        try {
            await hooks["event"]({ event: makeAskedEvent() });
        } finally {
            restore();
        }
        assert.equal(replies.length, 1);
        assert.equal(replies[0].body.response, "reject");
        assert.equal(replies[0]._route, "v2");
        assert.ok(
            typeof replies[0].body.message === "string" &&
                replies[0].body.message.length > 0,
            "live reject must carry a reason message",
        );
    });

    test("event: live misconfig (no modelEndpoint) → reply reject", async () => {
        const { hooks, replies } = await setupEventTest(
            {
                mode: "live",
                promptFile: testConfigPath("evt-classifier-prompt.txt"),
            },
            { modelEndpoint: "", model: "test-model" },
        );
        await hooks["event"]({ event: makeAskedEvent() });
        assert.equal(replies.length, 1);
        assert.equal(replies[0].body.response, "reject");
        assert.equal(replies[0]._route, "v2");
        assert.ok(
            typeof replies[0].body.message === "string" &&
                replies[0].body.message.length > 0,
            "live misconfig reject must carry a reason message",
        );
    });

    test("event: live fetch throw → reply reject (fail-closed)", async () => {
        const { hooks, replies } = await setupEventTest(
            {
                mode: "live",
                promptFile: testConfigPath("evt-classifier-prompt.txt"),
            },
            {
                modelEndpoint: "http://mock-llm",
                model: "test-model",
                maxRetries: 0,
            },
        );
        const restore = mockFetchThrow("network down");
        try {
            await hooks["event"]({ event: makeAskedEvent() });
        } finally {
            restore();
        }
        assert.equal(replies.length, 1);
        assert.equal(replies[0].body.response, "reject");
        assert.equal(replies[0]._route, "v2");
        assert.ok(
            typeof replies[0].body.message === "string" &&
                replies[0].body.message.length > 0,
            "live fetch-throw reject must carry a reason message",
        );
    });

    // --- onUncertain behavior ---

    test("event: onUncertain:passthrough + live misconfig → NO reply", async () => {
        // Uses a MODEL misconfig (not endpoint) so it triggers the pre-check
        // → handleUncertain → passthrough (no reply). An endpoint misconfig
        // (empty modelEndpoint + unset modelEndpointEnv) now goes through the
        // runtime deny→reject chain (classifyLive throws → decideLive deny →
        // reply reject), which does NOT route through handleUncertain and so
        // does NOT respect onUncertain. That asymmetry is pre-existing.
        const { hooks, replies } = await setupEventTest(
            {
                mode: "live",
                onUncertain: "passthrough",
                promptFile: testConfigPath("evt-classifier-prompt.txt"),
            },
            { modelEndpoint: "https://x", model: "" },
        );
        await hooks["event"]({ event: makeAskedEvent() });
        assert.equal(
            replies.length,
            0,
            "passthrough must NOT reply on misconfig failure",
        );
    });

    test("event: default onUncertain:reject + live misconfig → reply reject", async () => {
        const { hooks, replies } = await setupEventTest(
            {
                mode: "live",
                onUncertain: "reject",
                promptFile: testConfigPath("evt-classifier-prompt.txt"),
            },
            { modelEndpoint: "", model: "test-model" },
        );
        await hooks["event"]({ event: makeAskedEvent() });
        assert.equal(replies.length, 1);
        assert.equal(replies[0].body.response, "reject");
        assert.equal(replies[0]._route, "v2");
        assert.ok(
            typeof replies[0].body.message === "string" &&
                replies[0].body.message.length > 0,
            "onUncertain reject must carry a reason message",
        );
    });

    // --- per-call gate: v2 route URL form + transport-missing degradation ---

    test("event: reject routes through v2 endpoint at /permission/:id/reply with reason", async () => {
        // Use a custom client that captures the RAW _client.post args so we can
        // assert the exact v2 URL form + body shape (independent of the
        // normalized recording in makeEventClient).
        const tag = Math.random().toString(36).slice(2, 8);
        const pName = `evt-v2url-p-${tag}.json`;
        writeTestConfig(pName, { mode: "enforce", stubVerdict: "block" });
        __resetConfigCaches();
        const v2Calls = [];
        const client = {
            postSessionIdPermissionsPermissionId: async () => ({
                data: {},
                error: undefined,
            }),
            _client: {
                post: async (args) => {
                    v2Calls.push(args);
                    return { data: {}, error: undefined };
                },
            },
            session: {
                messages: async () => ({ data: [], error: undefined }),
            },
        };
        const hooks = await server({
            client,
            directory: TEST_CONFIG_DIR,
            configPath: testConfigPath(pName),
            llmConfigPath: testConfigPath("no-such-llm.json"),
            userConfigPath: NO_USER_PLUGIN,
            userLlmConfigPath: NO_USER_LLM,
        });
        await hooks["event"]({
            event: makeAskedEvent({ id: "req-v2-1" }),
        });
        assert.equal(v2Calls.length, 1, "reject must hit the v2 transport once");
        assert.match(
            v2Calls[0].url,
            /^\/permission\/req-v2-1\/reply$/,
            "v2 URL must be /permission/<encoded-id>/reply",
        );
        assert.equal(v2Calls[0].body.reply, "reject");
        assert.ok(
            typeof v2Calls[0].body.message === "string" &&
                v2Calls[0].body.message.length > 0,
            "v2 reject body must carry a non-empty message",
        );
        assert.equal(
            (v2Calls[0].headers || {})["Content-Type"],
            "application/json",
        );
    });

    test("event: reject with no v2 transport → degrades to v1 reject (fail-closed, no throw)", async () => {
        // Client has v1 but NO _client.post. A reject-with-reason must fall
        // through to the v1 reject path (which kills the turn under default
        // config, but never throws — F2 hardening preserved).
        const tag = Math.random().toString(36).slice(2, 8);
        const pName = `evt-nov2-p-${tag}.json`;
        writeTestConfig(pName, { mode: "enforce", stubVerdict: "block" });
        __resetConfigCaches();
        const v1Calls = [];
        const client = {
            postSessionIdPermissionsPermissionId: async (args) => {
                v1Calls.push(args);
                return { data: {}, error: undefined };
            },
            session: {
                messages: async () => ({ data: [], error: undefined }),
            },
        };
        const hooks = await server({
            client,
            directory: TEST_CONFIG_DIR,
            configPath: testConfigPath(pName),
            llmConfigPath: testConfigPath("no-such-llm.json"),
            userConfigPath: NO_USER_PLUGIN,
            userLlmConfigPath: NO_USER_LLM,
        });
        await hooks["event"]({ event: makeAskedEvent() });
        assert.equal(
            v1Calls.length,
            1,
            "reject must fall back to v1 when no v2 transport",
        );
        assert.equal(v1Calls[0].body.response, "reject");
        assert.equal(
            v1Calls[0].body.message,
            undefined,
            "v1 reject carries no message (kills the turn — documented)",
        );
    });

    test("event: allow does NOT touch the v2 transport", async () => {
        // Allow (once/always) must route exclusively through v1 — never the v2
        // endpoint (which would carry a message needlessly and, semantically,
        // only makes sense for reject-with-reason).
        const tag = Math.random().toString(36).slice(2, 8);
        const pName = `evt-allownov2-p-${tag}.json`;
        writeTestConfig(pName, { mode: "enforce", stubVerdict: "allow" });
        __resetConfigCaches();
        const v2Calls = [];
        const v1Calls = [];
        const client = {
            postSessionIdPermissionsPermissionId: async (args) => {
                v1Calls.push(args);
                return { data: {}, error: undefined };
            },
            _client: {
                post: async (args) => {
                    v2Calls.push(args);
                    return { data: {}, error: undefined };
                },
            },
            session: {
                messages: async () => ({ data: [], error: undefined }),
            },
        };
        const hooks = await server({
            client,
            directory: TEST_CONFIG_DIR,
            configPath: testConfigPath(pName),
            llmConfigPath: testConfigPath("no-such-llm.json"),
            userConfigPath: NO_USER_PLUGIN,
            userLlmConfigPath: NO_USER_LLM,
        });
        await hooks["event"]({ event: makeAskedEvent() });
        assert.equal(v1Calls.length, 1, "allow must hit v1 once");
        assert.equal(v1Calls[0].body.response, "once");
        assert.equal(
            v2Calls.length,
            0,
            "allow must NOT touch the v2 transport",
        );
    });

    // --- F1 hardening: v2 server-error must fall back to v1 (no hang) ---

    test("reply F1: v2 transport returns error -> falls back to v1 reject (v1 method called)", async () => {
        // The v2 transport resolves with an error object (server-error
        // response). The helper MUST fall through to the v1 bare reject so the
        // permission Deferred resolves (kill-switch, not a hang).
        const tag = Math.random().toString(36).slice(2, 8);
        const pName = `evt-f1v2err-p-${tag}.json`;
        writeTestConfig(pName, { mode: "enforce", stubVerdict: "block" });
        __resetConfigCaches();
        const v1Calls = [];
        const v2Calls = [];
        const client = {
            postSessionIdPermissionsPermissionId: async (args) => {
                v1Calls.push(args);
                return { data: {}, error: undefined };
            },
            _client: {
                post: async (args) => {
                    v2Calls.push(args);
                    return { data: undefined, error: { message: "server error" } };
                },
            },
            session: {
                messages: async () => ({ data: [], error: undefined }),
            },
        };
        const hooks = await server({
            client,
            directory: TEST_CONFIG_DIR,
            configPath: testConfigPath(pName),
            llmConfigPath: testConfigPath("no-such-llm.json"),
            userConfigPath: NO_USER_PLUGIN,
            userLlmConfigPath: NO_USER_LLM,
        });
        await hooks["event"]({ event: makeAskedEvent() });
        assert.equal(
            v2Calls.length,
            1,
            "reject-with-reason must attempt the v2 transport once",
        );
        assert.equal(
            v1Calls.length,
            1,
            "F1: v2 server-error MUST fall back to v1 reject (Deferred must resolve)",
        );
        assert.equal(
            v1Calls[0].body.response,
            "reject",
            "fallback must be a bare reject (kill-switch)",
        );
        assert.equal(
            v1Calls[0].body.message,
            undefined,
            "v1 fallback carries no message (per-call-gate degrades to kill-switch)",
        );
    });

    test("reply F1: v2 transport returns error -> helper completes (no throw)", async () => {
        // Same v2-error setup; assert the event hook resolves cleanly rather
        // than propagating a rejection (F2 hardening preserved on the F1 path).
        const tag = Math.random().toString(36).slice(2, 8);
        const pName = `evt-f1nothow-p-${tag}.json`;
        writeTestConfig(pName, { mode: "enforce", stubVerdict: "block" });
        __resetConfigCaches();
        const client = {
            postSessionIdPermissionsPermissionId: async () => ({
                data: {},
                error: undefined,
            }),
            _client: {
                post: async () => ({
                    data: undefined,
                    error: { message: "server error" },
                }),
            },
            session: {
                messages: async () => ({ data: [], error: undefined }),
            },
        };
        const hooks = await server({
            client,
            directory: TEST_CONFIG_DIR,
            configPath: testConfigPath(pName),
            llmConfigPath: testConfigPath("no-such-llm.json"),
            userConfigPath: NO_USER_PLUGIN,
            userLlmConfigPath: NO_USER_LLM,
        });
        // The hook MUST resolve normally (no rejection thrown to the caller).
        await hooks["event"]({ event: makeAskedEvent() });
        assert.ok(true, "event hook completed without throwing on v2 server-error");
    });

    test("reply: v2 transport succeeds -> v1 NOT called (no double reply)", async () => {
        // REGRESSION for the F1 fix: on the v2 success path the helper MUST
        // still return without calling v1 (do not break the happy path /
        // per-call-gate).
        const tag = Math.random().toString(36).slice(2, 8);
        const pName = `evt-v2ok-p-${tag}.json`;
        writeTestConfig(pName, { mode: "enforce", stubVerdict: "block" });
        __resetConfigCaches();
        const v1Calls = [];
        const v2Calls = [];
        const client = {
            postSessionIdPermissionsPermissionId: async (args) => {
                v1Calls.push(args);
                return { data: {}, error: undefined };
            },
            _client: {
                post: async (args) => {
                    v2Calls.push(args);
                    return { data: {}, error: undefined };
                },
            },
            session: {
                messages: async () => ({ data: [], error: undefined }),
            },
        };
        const hooks = await server({
            client,
            directory: TEST_CONFIG_DIR,
            configPath: testConfigPath(pName),
            llmConfigPath: testConfigPath("no-such-llm.json"),
            userConfigPath: NO_USER_PLUGIN,
            userLlmConfigPath: NO_USER_LLM,
        });
        await hooks["event"]({ event: makeAskedEvent() });
        assert.equal(
            v2Calls.length,
            1,
            "reject-with-reason must hit the v2 transport once",
        );
        assert.equal(
            v1Calls.length,
            0,
            "v2 success MUST NOT also call v1 (no double reply)",
        );
    });

    // --- early-return paths ---

    test("event: non-permission.asked event → early return, no reply", async () => {
        const { hooks, replies } = await setupEventTest({
            mode: "enforce",
            stubVerdict: "allow",
        });
        await hooks["event"]({
            event: { type: "session.created", properties: {} },
        });
        assert.equal(replies.length, 0, "non-asked events must be ignored");
    });

    test("event: enabled:false → early return, no reply", async () => {
        const { hooks, replies } = await setupEventTest({
            enabled: false,
            mode: "enforce",
            stubVerdict: "allow",
        });
        await hooks["event"]({ event: makeAskedEvent() });
        assert.equal(replies.length, 0, "disabled plugin must not reply");
    });

    // --- egress: credential-leak regression ---

    test("event: egress — secret in patterns[0] absent from audit line", async () => {
        const jwt =
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
        const { hooks } = await setupEventTest({ mode: "audit" });
        const errors = [];
        const orig = console.error;
        console.error = (msg) => errors.push(msg);
        try {
            await hooks["event"]({
                event: makeAskedEvent({
                    patterns: [
                        `curl -H "Authorization: Bearer ${jwt}" https://api`,
                    ],
                }),
            });
        } finally {
            console.error = orig;
        }
        const combined = errors.join("\n");
        assert.equal(
            combined.includes(jwt),
            false,
            "jwt must NOT survive into the event audit line",
        );
        assert.match(combined, /\[redacted\]/);
    });

    // --- reply error logging ---

    test("event: reply r.error → logged, does not throw", async () => {
        const { hooks, replies } = await setupEventTest(
            { mode: "enforce", stubVerdict: "allow" },
            null,
            { replyError: true },
        );
        const errors = [];
        const orig = console.error;
        console.error = (msg) => errors.push(msg);
        try {
            // Must NOT throw despite the reply error return.
            await hooks["event"]({ event: makeAskedEvent() });
        } finally {
            console.error = orig;
        }
        assert.equal(replies.length, 1, "reply was still attempted");
        assert.equal(
            errors.some((e) => /permission reply failed/.test(e)),
            true,
            "r.error must be logged",
        );
    });

    // --- new config fields: normalization tests ---

    test("readConfig (plugin): invalid replyMode → default once", () => {
        __resetConfigCaches();
        writeTestConfig("evt-bad-reply.json", { replyMode: "forever" });
        const cfg = readConfig(testConfigPath("evt-bad-reply.json"), NO_USER_PLUGIN);
        assert.equal(cfg.replyMode, "once");
    });

    test("readConfig (plugin): invalid onUncertain → default reject", () => {
        __resetConfigCaches();
        writeTestConfig("evt-bad-uncertain.json", { onUncertain: "maybe" });
        const cfg = readConfig(testConfigPath("evt-bad-uncertain.json"), NO_USER_PLUGIN);
        assert.equal(cfg.onUncertain, "reject");
    });

    test("readConfig (plugin): replyMode:always + onUncertain:passthrough preserved", () => {
        __resetConfigCaches();
        writeTestConfig("evt-valid-new.json", {
            replyMode: "always",
            onUncertain: "passthrough",
        });
        const cfg = readConfig(testConfigPath("evt-valid-new.json"), NO_USER_PLUGIN);
        assert.equal(cfg.replyMode, "always");
        assert.equal(cfg.onUncertain, "passthrough");
    });

    // ===================================================================
    // FOLLOW-UP FIXES (commit 82e37c89 reviewer findings):
    //   F1 — permission-type shape: the SDK wire type carries `permission` as
    //        a STRING name, not an object with `.type`. The defensive
    //        normalizer must yield the real type (not "unknown").
    //   F2 — reply robustness: a thrown reply (or a missing client) must NOT
    //        propagate out of the event hook (which would hang headless mode).
    // ===================================================================

    // F1 — string permission shape (today's real SDK wire type). Asserts BOTH
    // the audit/log line AND the live-mode serialized egress carry the real
    // type (not the collapsed "unknown").
    test("F1: string permission \"bash\" -> audit line + serialized live input carry type=bash", async () => {
        // (a) audit mode: the audit/log line carries type=bash, not unknown.
        {
            const { hooks } = await setupEventTest({ mode: "audit" });
            const errors = [];
            const orig = console.error;
            console.error = (msg) => errors.push(msg);
            try {
                await hooks["event"]({
                    event: makeAskedEvent({ rawPermission: "bash" }),
                });
            } finally {
                console.error = orig;
            }
            const line = errors.find((e) => /permission\.asked/.test(e));
            assert.ok(line, "audit line must be emitted");
            assert.match(line, /type=bash/);
            assert.equal(
                /type=unknown/.test(line),
                false,
                "string permission must NOT collapse to unknown",
            );
        }
        // (b) live mode: the serialized input that egresses to the model carries type=bash.
        {
            const { hooks } = await setupEventTest(
                {
                    mode: "live",
                    promptFile: testConfigPath("evt-classifier-prompt.txt"),
                },
                {
                    modelEndpoint: "http://mock-llm",
                    model: "test-model",
                    maxRetries: 0,
                },
            );
            const captured = [];
            const restore = mockFetchCapture(captured);
            try {
                await hooks["event"]({
                    event: makeAskedEvent({ rawPermission: "bash" }),
                });
            } finally {
                restore();
            }
            assert.ok(captured.length >= 1, "fetch must have been called");
            const body = JSON.parse(captured[0]);
            const userMsg = body.messages.find((m) => m.role === "user");
            assert.ok(userMsg, "user message must be present in the live request");
            assert.match(
                userMsg.content,
                /type=bash/,
                "serialized live input must carry type=bash",
            );
            assert.equal(
                /type=unknown/.test(userMsg.content),
                false,
                "serialized live input must NOT carry type=unknown",
            );
        }
    });

    // F1 — object permission shape (defensive hedge against an upstream change).
    test("F1: object permission {type:\"edit\"} -> audit line type=edit", async () => {
        const { hooks } = await setupEventTest({ mode: "audit" });
        const errors = [];
        const orig = console.error;
        console.error = (msg) => errors.push(msg);
        try {
            await hooks["event"]({
                event: makeAskedEvent({ rawPermission: { type: "edit" } }),
            });
        } finally {
            console.error = orig;
        }
        const line = errors.find((e) => /permission\.asked/.test(e));
        assert.ok(line, "audit line must be emitted");
        assert.match(line, /type=edit/);
    });

    // F1 — missing permission field -> type=unknown, no crash.
    test("F1: missing permission field -> audit line type=unknown", async () => {
        const { hooks } = await setupEventTest({ mode: "audit" });
        const errors = [];
        const orig = console.error;
        console.error = (msg) => errors.push(msg);
        try {
            const ev = makeAskedEvent();
            delete ev.properties.permission;
            await hooks["event"]({ event: ev });
        } finally {
            console.error = orig;
        }
        const line = errors.find((e) => /permission\.asked/.test(e));
        assert.ok(line, "audit line must be emitted");
        assert.match(line, /type=unknown/);
    });

    // F2 — a THROWN reply is caught + logged; the hook completes cleanly
    // (no unhandled rejection, no headless hang).
    test("F2: throwing reply client -> hook completes, throw logged", async () => {
        const tag = Math.random().toString(36).slice(2, 8);
        const pName = `evt-throw-${tag}.json`;
        writeTestConfig(pName, { mode: "enforce", stubVerdict: "allow" });
        __resetConfigCaches();
        const throwingClient = {
            postSessionIdPermissionsPermissionId: async () => {
                throw new Error("transport boom");
            },
            session: { messages: async () => ({ data: [], error: undefined }) },
        };
        const hooks = await server({
            client: throwingClient,
            directory: TEST_CONFIG_DIR,
            configPath: testConfigPath(pName),
            llmConfigPath: testConfigPath("no-such-llm.json"),
            userConfigPath: NO_USER_PLUGIN,
            userLlmConfigPath: NO_USER_LLM,
        });
        const errors = [];
        const orig = console.error;
        console.error = (msg) => errors.push(msg);
        try {
            // Must NOT throw — the reply helper catches the transport throw.
            await hooks["event"]({ event: makeAskedEvent() });
        } finally {
            console.error = orig;
        }
        assert.equal(
            errors.some((e) => /permission reply threw/.test(e)),
            true,
            "thrown reply must be logged",
        );
        assert.equal(
            errors.some((e) => /transport boom/.test(e)),
            true,
            "the thrown error message must appear in the log",
        );
    });

    // F2 — missing client entirely -> hook completes, "reply unavailable" logged.
    test("F2: no client -> hook completes, reply-unavailable logged", async () => {
        const tag = Math.random().toString(36).slice(2, 8);
        const pName = `evt-noclient-${tag}.json`;
        writeTestConfig(pName, { mode: "enforce", stubVerdict: "allow" });
        __resetConfigCaches();
        // No `client` threaded into the server factory.
        const hooks = await server({
            directory: TEST_CONFIG_DIR,
            configPath: testConfigPath(pName),
            llmConfigPath: testConfigPath("no-such-llm.json"),
            userConfigPath: NO_USER_PLUGIN,
            userLlmConfigPath: NO_USER_LLM,
        });
        const errors = [];
        const orig = console.error;
        console.error = (msg) => errors.push(msg);
        try {
            // Must NOT throw — the reply helper guards the missing client.
            await hooks["event"]({ event: makeAskedEvent() });
        } finally {
            console.error = orig;
        }
        assert.equal(
            errors.some((e) =>
                /permission reply unavailable: no client/.test(e),
            ),
            true,
            "missing client must log reply unavailable",
        );
    });

    // ===================================================================
    // PHASE 2 — live-tiered consensus mode self-tests.
    //
    // These exercise the event hook's live-tiered branch: parallel per-leaf
    // decideLive dispatch -> normalizeLeafOutcome -> aggregateLeafOutcomes ->
    // reply. They use injected fake clients + mock globalThis.fetch. No real
    // network. Leaves point at DIFFERENT endpoints so the mock can dispatch by
    // URL (deterministic regardless of parallel call order).
    // ===================================================================

    // Mock globalThis.fetch dispatching by the request URL endpoint. Each key
    // is matched as a substring of the URL; the matching verdict is returned.
    // A key mapping to null THROWS (simulates a leaf network failure). Used to
    // give leaf-A and leaf-B DIFFERENT verdicts deterministically even though
    // Promise.all runs them in parallel. Returns a restore fn.
    function mockFetchByEndpoint(map) {
        const orig = globalThis.fetch;
        globalThis.fetch = async (url, _opts) => {
            const u = typeof url === "string" ? url : String(url);
            for (const [key, verdict] of Object.entries(map)) {
                if (u.includes(key)) {
                    if (verdict === null) {
                        throw new Error(`mock leaf failure for ${key}`);
                    }
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            choices: [{ message: { content: verdict } }],
                        }),
                    };
                }
            }
            // Fallback: return a generic allow so an unmatched leaf does not
            // silently hang the test.
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [{ message: { content: "<block>no</block>" } }],
                }),
            };
        };
        return () => {
            globalThis.fetch = orig;
        };
    }

    // Helper: build a 2-leaf LLM config pointing at two distinct endpoints.
    function twoLeafLlmConfig(verdictA, verdictB, extra = {}) {
        return {
            leaves: [
                {
                    modelEndpoint: "http://leaf-a-endpoint",
                    model: "leaf-a-model",
                    apiKeyEnv: "AUTO_GATE_API_KEY",
                    maxRetries: 0,
                    ...extra,
                },
                {
                    modelEndpoint: "http://leaf-b-endpoint",
                    model: "leaf-b-model",
                    apiKeyEnv: "AUTO_GATE_API_KEY",
                    maxRetries: 0,
                    ...extra,
                },
            ],
        };
    }

    // --- live-tiered: consensus allow (2 leaves both allow) -> reply once ---

    test("live-tiered: unanimous allow (2 leaves both allow) -> reply once", async () => {
        const { hooks, replies } = await setupEventTest(
            {
                mode: "live-tiered",
                promptFile: testConfigPath("evt-classifier-prompt.txt"),
            },
            twoLeafLlmConfig(),
        );
        const restore = mockFetchByEndpoint({
            "leaf-a-endpoint": "<block>no</block>", // allow
            "leaf-b-endpoint": "<block>no</block>", // allow
        });
        try {
            await hooks["event"]({ event: makeAskedEvent() });
        } finally {
            restore();
        }
        assert.equal(replies.length, 1, "consensus allow must reply once");
        assert.equal(replies[0].body.response, "once");
    });

    // --- live-tiered: one deny -> reply reject (disagreement) ---

    test("live-tiered: one deny -> reply reject (disagreement)", async () => {
        const { hooks, replies } = await setupEventTest(
            {
                mode: "live-tiered",
                promptFile: testConfigPath("evt-classifier-prompt.txt"),
            },
            twoLeafLlmConfig(),
        );
        const restore = mockFetchByEndpoint({
            "leaf-a-endpoint": "<block>no</block>", // allow
            "leaf-b-endpoint": "<block>yes</block>", // deny
        });
        try {
            await hooks["event"]({ event: makeAskedEvent() });
        } finally {
            restore();
        }
        assert.equal(replies.length, 1, "disagreement must reply (reject)");
        assert.equal(replies[0].body.response, "reject");
        assert.equal(replies[0]._route, "v2");
        assert.ok(
            typeof replies[0].body.message === "string" &&
                replies[0].body.message.length > 0,
            "tiered disagreement reject must carry a reason message",
        );
    });

    // --- live-tiered: one fail -> reply reject (incomplete) ---

    test("live-tiered: one fail (leaf throws) -> reply reject (incomplete)", async () => {
        const { hooks, replies } = await setupEventTest(
            {
                mode: "live-tiered",
                promptFile: testConfigPath("evt-classifier-prompt.txt"),
            },
            twoLeafLlmConfig(),
        );
        const restore = mockFetchByEndpoint({
            "leaf-a-endpoint": "<block>no</block>", // allow
            "leaf-b-endpoint": null, // throws -> decideLive returns deny-on-error
        });
        try {
            await hooks["event"]({ event: makeAskedEvent() });
        } finally {
            restore();
        }
        assert.equal(replies.length, 1, "incomplete must reply (reject)");
        assert.equal(replies[0].body.response, "reject");
        assert.equal(replies[0]._route, "v2");
        assert.ok(
            typeof replies[0].body.message === "string" &&
                replies[0].body.message.length > 0,
            "tiered incomplete reject must carry a reason message",
        );
    });

    // --- live-tiered: empty/malformed leaves -> fail-closed reject ---

    test("live-tiered: empty leaves config -> fail-closed reject (onUncertain:reject)", async () => {
        const { hooks, replies } = await setupEventTest(
            {
                mode: "live-tiered",
                promptFile: testConfigPath("evt-classifier-prompt.txt"),
            },
            { leaves: [] },
        );
        await hooks["event"]({ event: makeAskedEvent() });
        assert.equal(replies.length, 1, "empty leaves must fail-closed");
        assert.equal(replies[0].body.response, "reject");
        assert.equal(replies[0]._route, "v2");
        assert.ok(
            typeof replies[0].body.message === "string" &&
                replies[0].body.message.length > 0,
            "tiered empty-leaves reject must carry a reason message",
        );
    });

    test("live-tiered: missing leaves key -> fail-closed reject", async () => {
        const { hooks, replies } = await setupEventTest(
            {
                mode: "live-tiered",
                promptFile: testConfigPath("evt-classifier-prompt.txt"),
            },
            { modelEndpoint: "http://x", model: "m" }, // no leaves key
        );
        await hooks["event"]({ event: makeAskedEvent() });
        assert.equal(replies.length, 1);
        assert.equal(replies[0].body.response, "reject");
        assert.equal(replies[0]._route, "v2");
        assert.ok(
            typeof replies[0].body.message === "string" &&
                replies[0].body.message.length > 0,
            "tiered missing-leaves reject must carry a reason message",
        );
    });

    // --- live-tiered: onUncertain:passthrough + misconfig -> NO reply ---

    test("live-tiered: onUncertain:passthrough + misconfig -> NO reply", async () => {
        const { hooks, replies } = await setupEventTest(
            {
                mode: "live-tiered",
                onUncertain: "passthrough",
                promptFile: testConfigPath("evt-classifier-prompt.txt"),
            },
            { leaves: [] },
        );
        await hooks["event"]({ event: makeAskedEvent() });
        assert.equal(
            replies.length,
            0,
            "passthrough must NOT reply on misconfig",
        );
    });

    // --- live-tiered: transcript fetch shared (called once, not N times) ---

    test("live-tiered: transcript fetch shared (session.messages called once, not N times)", async () => {
        const tag = Math.random().toString(36).slice(2, 8);
        const pName = `evt-tiered-tx-${tag}.json`;
        const lName = `evt-tiered-tx-l-${tag}.json`;
        writeTestConfig(pName, {
            mode: "live-tiered",
            promptFile: testConfigPath("evt-classifier-prompt.txt"),
        });
        writeTestConfig(lName, twoLeafLlmConfig());
        __resetConfigCaches();
        let messagesCallCount = 0;
        const client = {
            postSessionIdPermissionsPermissionId: async (args) => {
                return { data: {}, error: undefined };
            },
            session: {
                messages: async () => {
                    messagesCallCount++;
                    return {
                        data: [
                            {
                                info: { role: "user" },
                                parts: [{ type: "text", text: "hello" }],
                            },
                        ],
                        error: undefined,
                    };
                },
            },
        };
        const hooks = await server({
            client,
            directory: TEST_CONFIG_DIR,
            configPath: testConfigPath(pName),
            llmConfigPath: testConfigPath(lName),
            userConfigPath: NO_USER_PLUGIN,
            userLlmConfigPath: NO_USER_LLM,
        });
        const restore = mockFetchByEndpoint({
            "leaf-a-endpoint": "<block>no</block>",
            "leaf-b-endpoint": "<block>no</block>",
        });
        try {
            await hooks["event"]({ event: makeAskedEvent() });
        } finally {
            restore();
        }
        assert.equal(
            messagesCallCount,
            1,
            "transcript must be fetched ONCE regardless of leaf count",
        );
    });

    // --- live-tiered: egress — no leaf endpoint/model/value in audit line ---

    test("live-tiered: egress — no leaf endpoint/model/secret in audit line", async () => {
        // Inject a leaf config with a secret-shaped model name and a Bearer-
        // bearing endpoint. Neither must survive into the stderr audit line.
        const secretModel = "sk-secretleakmodel1234567890abcdefghijklmnop";
        const secretEndpoint = "Bearer eyJleGFtcGxl.qm9o.signature";
        const { hooks } = await setupEventTest(
            {
                mode: "live-tiered",
                promptFile: testConfigPath("evt-classifier-prompt.txt"),
            },
            {
                leaves: [
                    {
                        modelEndpoint: `http://leaf-a-${secretEndpoint}`,
                        model: secretModel,
                        apiKeyEnv: "AUTO_GATE_API_KEY",
                        maxRetries: 0,
                    },
                    {
                        modelEndpoint: "http://leaf-b-endpoint",
                        model: "leaf-b-model",
                        apiKeyEnv: "AUTO_GATE_API_KEY",
                        maxRetries: 0,
                    },
                ],
            },
        );
        const errors = [];
        const orig = console.error;
        console.error = (msg) => errors.push(msg);
        const restore = mockFetchByEndpoint({
            "leaf-a": "<block>no</block>",
            "leaf-b": "<block>no</block>",
        });
        try {
            await hooks["event"]({ event: makeAskedEvent() });
        } finally {
            restore();
            console.error = orig;
        }
        const combined = errors.join("\n");
        assert.equal(
            combined.includes(secretModel),
            false,
            "leaf model value must NOT survive into the audit line",
        );
        assert.equal(
            combined.includes(secretEndpoint),
            false,
            "leaf endpoint secret must NOT survive into the audit line",
        );
        // The aggregate audit line must be present (proves the tiered path ran).
        assert.ok(
            errors.some((e) => /tier-aggregate/.test(e)),
            "aggregate audit line must be emitted",
        );
    });

    // --- live-tiered: 3-leaf mix (allow+deny+fail) -> deny incomplete ---

    test("live-tiered: 3-leaf mix (allow+deny+fail) -> deny incomplete", async () => {
        const { hooks, replies } = await setupEventTest(
            {
                mode: "live-tiered",
                promptFile: testConfigPath("evt-classifier-prompt.txt"),
            },
            {
                leaves: [
                    {
                        modelEndpoint: "http://leaf-a-endpoint",
                        model: "m",
                        apiKeyEnv: "AUTO_GATE_API_KEY",
                        maxRetries: 0,
                    },
                    {
                        modelEndpoint: "http://leaf-b-endpoint",
                        model: "m",
                        apiKeyEnv: "AUTO_GATE_API_KEY",
                        maxRetries: 0,
                    },
                    {
                        modelEndpoint: "http://leaf-c-endpoint",
                        model: "m",
                        apiKeyEnv: "AUTO_GATE_API_KEY",
                        maxRetries: 0,
                    },
                ],
            },
        );
        const restore = mockFetchByEndpoint({
            "leaf-a": "<block>no</block>", // allow
            "leaf-b": "<block>yes</block>", // deny
            "leaf-c": null, // fail
        });
        try {
            await hooks["event"]({ event: makeAskedEvent() });
        } finally {
            restore();
        }
        assert.equal(replies.length, 1, "mix must reply (reject)");
        assert.equal(replies[0].body.response, "reject");
        assert.equal(replies[0]._route, "v2");
        assert.ok(
            typeof replies[0].body.message === "string" &&
                replies[0].body.message.length > 0,
            "tiered 3-mix reject must carry a reason message",
        );
    });

    // --- live-tiered: consensus deny (2 leaves both deny) -> reply reject ---

    test("live-tiered: unanimous deny (2 leaves both deny) -> reply reject", async () => {
        const { hooks, replies } = await setupEventTest(
            {
                mode: "live-tiered",
                promptFile: testConfigPath("evt-classifier-prompt.txt"),
            },
            twoLeafLlmConfig(),
        );
        const restore = mockFetchByEndpoint({
            "leaf-a-endpoint": "<block>yes</block>", // deny
            "leaf-b-endpoint": "<block>yes</block>", // deny
        });
        try {
            await hooks["event"]({ event: makeAskedEvent() });
        } finally {
            restore();
        }
        assert.equal(replies.length, 1);
        assert.equal(replies[0].body.response, "reject");
        assert.equal(replies[0]._route, "v2");
        assert.ok(
            typeof replies[0].body.message === "string" &&
                replies[0].body.message.length > 0,
            "tiered unanimous-deny reject must carry a reason message",
        );
    });

    // --- config normalization: mode live-tiered accepted ---

    test("readConfig (plugin): mode live-tiered accepted", () => {
        __resetConfigCaches();
        writeTestConfig("evt-tiered-mode.json", { mode: "live-tiered" });
        const cfg = readConfig(testConfigPath("evt-tiered-mode.json"), NO_USER_PLUGIN);
        assert.equal(cfg.mode, "live-tiered");
    });

    // --- config normalization: leaves array validated in LLM config ---

    test("readLlmConfig: leaves array normalized (each leaf field-safe)", () => {
        __resetConfigCaches();
        writeTestConfig("evt-tiered-leaves.json", {
            leaves: [
                {
                    modelEndpoint: "http://a",
                    model: "ma",
                    apiKeyEnv: "KEY_A",
                    timeoutMs: 5000,
                    maxRetries: 2,
                    retryDelayMs: 300,
                },
                {
                    modelEndpoint: "http://b",
                    model: "mb",
                    // missing fields -> defaults per leaf
                },
            ],
        });
        const cfg = readLlmConfig(testConfigPath("evt-tiered-leaves.json"), NO_USER_LLM);
        assert.ok(Array.isArray(cfg.leaves), "leaves must be an array");
        assert.equal(cfg.leaves.length, 2);
        assert.equal(cfg.leaves[0].modelEndpoint, "http://a");
        assert.equal(cfg.leaves[0].maxRetries, 2);
        assert.equal(cfg.leaves[1].modelEndpoint, "http://b");
        assert.equal(cfg.leaves[1].apiKeyEnv, "AUTO_GATE_API_KEY", "default");
        assert.equal(cfg.leaves[1].timeoutMs, 8000, "default");
    });

    test("readLlmConfig: non-array leaves -> empty array (no throw)", () => {
        __resetConfigCaches();
        writeTestConfig("evt-tiered-badleaves.json", {
            leaves: "not-an-array",
        });
        const cfg = readLlmConfig(testConfigPath("evt-tiered-badleaves.json"), NO_USER_LLM);
        assert.ok(Array.isArray(cfg.leaves));
        assert.equal(cfg.leaves.length, 0);
    });

    // Restore the API key env after the live tests.
    process.env.AUTO_GATE_API_KEY = _origApiKey;
}
