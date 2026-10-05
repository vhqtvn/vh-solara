// session-progress-config.js — operator-owned configuration loader for the
// session-progress-pilot plugin.
//
// CONTRACT (Phase 1, pinned by the v2 brief):
//   - ONE optional config file: <repoRoot>/.opencode/repo-configs/
//     session-progress.local.json (operator-owned, gitignored by convention).
//   - Absent file -> safe defaults (every agent OFF — the plugin is fully
//     inert until configured) SILENTLY (absence is the normal state; no
//     stderr spam).
//   - Present-but-invalid (unreadable / bad JSON / non-object) -> defaults +
//     ONE deduplicated stderr notice. NEVER throws.
//   - Read on every hook invocation behind an mtime cache: an unchanged file
//     costs one statSync; a changed file re-reads and re-normalizes on the
//     next tool call. No restart, no plugin reload.
//   - Judge target values resolve via a DUAL form (operator decision
//     2026-10-05, mirroring auto-gate's literal-preferred pattern):
//     literal VALUES (`judge.endpoint` / `judge.model` / `judge.api_key`)
//     and a user-level JSON file
//     (<XDG_CONFIG_HOME|~/.config>/vh-agent-harness/session-progress-llm.json,
//     schema {endpoint, model, apiKey}) are preferred; env var NAMES
//     (`judge.*_env`) remain the fallback. Literals belong ONLY in gitignored
//     repo-local config and the user-level file — TRACKED files (including
//     these DEFAULTS) stay env-name-only, no literal secrets.
//   - Every field is normalized/clamped; wrong-typed values fall back to
//     defaults; unknown fields are ignored. The result is ALWAYS a fully
//     materialized, valid config (callers never see partial shapes).
//
// This module is deliberately I/O-bounded (one stat + at most one read per
// changed mtime, per file — repo config AND user-level judge file) and never
// touches the network, the clock, or plugin state.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Defaults — the shipped, fail-open posture. OFF for everyone (operator
// decision 2026-10-04: fully opt-in — no observation, no records, no
// diagnostics, no judge spend until config names an agent or "*" as
// audit/enforce), semantic judge dual-form with EMPTY literals — the default
// posture is env-referenced (unset env = unavailable = allow), narrow leases.
// Judge literals (`endpoint` / `model` / `api_key`) default to EMPTY — the
// literal sources are the gitignored repo-local config and the user-level
// file only; tracked files never carry literal secrets. An empty literal
// means "unspecified" and falls through to the next source (it never
// suppresses a lower layer — auto-gate's non-empty-guard rule).
// ---------------------------------------------------------------------------

export const DEFAULTS = Object.freeze({
    enabled: true,
    agents: Object.freeze({ "*": "off" }),
    judge: Object.freeze({
        endpoint: "",
        model: "",
        api_key: "",
        model_env: "SESSION_PROGRESS_JUDGE_MODEL",
        endpoint_env: "SESSION_PROGRESS_JUDGE_ENDPOINT",
        api_key_env: "SESSION_PROGRESS_JUDGE_API_KEY",
        // Empty = the default user-level path (defaultUserJudgeConfigPath).
        user_config_path: "",
        timeout_ms: 20000,
        retries: 0,
        min_looping_confidence: 0.9,
    }),
    cadence: Object.freeze({
        min_interval_seconds: 60,
        // NOTE: counts NEW CALL OBSERVATIONS (new callIDs), NOT distinct
        // signature values. The name is historical and deliberately
        // documented as misleading (brief: "document this potentially
        // misleading name explicitly").
        min_new_signatures: 8,
    }),
    mechanical: Object.freeze({
        enabled: true,
        repeat_threshold: 4,
        window_seconds: 30,
        lease_seconds: 20,
        max_denials: 1,
    }),
    semantic: Object.freeze({
        prior_matches: 3,
        window_seconds: 90,
        lease_seconds: 45,
        max_denials: 2,
    }),
    polling_exemptions: Object.freeze({ bgshell_status: true }),
    state: Object.freeze({
        max_sessions: 128,
        idle_ttl_seconds: 1800,
        ring_entries: 32,
        ring_bytes: 16384,
    }),
    concurrency: Object.freeze({ per_session: 1, global: 4 }),
    diagnostics: Object.freeze({ enabled: true }),
});

// AGENT_MODES — closed vocabulary. Anything else is dropped at normalization.
const AGENT_MODES = new Set(["off", "audit", "enforce"]);

// ---------------------------------------------------------------------------
// Field-level coercion helpers. Each returns a VALID value or the fallback —
// never NaN, never out-of-range, never a wrong type.
// ---------------------------------------------------------------------------

function boolOr(v, fallback) {
    return typeof v === "boolean" ? v : fallback;
}

function intIn(v, fallback, min, max) {
    if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) return fallback;
    return Math.min(max, Math.max(min, v));
}

function numIn(v, fallback, min, max) {
    if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
}

function strOr(v, fallback) {
    return typeof v === "string" && v.length > 0 ? v : fallback;
}

function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

// normalizeAgents — accepts the object form ({"*":"audit", "build":"off"}) or
// the string shorthand ("audit" == {"*":"audit"}). Invalid per-key values are
// dropped (those agents fall back to the wildcard); an invalid/missing
// wildcard falls back to "off" — the inert fail-open default. A completely
// invalid shape yields {"*":"off"}.
export function normalizeAgents(raw) {
    const out = {};
    if (typeof raw === "string") {
        if (AGENT_MODES.has(raw)) out["*"] = raw;
        else out["*"] = "off";
        return out;
    }
    if (isPlainObject(raw)) {
        for (const [k, v] of Object.entries(raw)) {
            if (typeof k === "string" && k.length > 0 && AGENT_MODES.has(v)) {
                out[k] = v;
            }
        }
    }
    if (!AGENT_MODES.has(out["*"])) out["*"] = "off";
    return out;
}

// normalizeConfig — pure: any unknown input -> a fully materialized valid
// config. Wrong-typed fields fall back field-by-field to DEFAULTS.
export function normalizeConfig(raw) {
    const src = isPlainObject(raw) ? raw : {};
    const d = DEFAULTS;
    const judgeSrc = isPlainObject(src.judge) ? src.judge : {};
    const cadenceSrc = isPlainObject(src.cadence) ? src.cadence : {};
    const mechSrc = isPlainObject(src.mechanical) ? src.mechanical : {};
    const semSrc = isPlainObject(src.semantic) ? src.semantic : {};
    const pollSrc = isPlainObject(src.polling_exemptions) ? src.polling_exemptions : {};
    const stateSrc = isPlainObject(src.state) ? src.state : {};
    const concSrc = isPlainObject(src.concurrency) ? src.concurrency : {};
    const diagSrc = isPlainObject(src.diagnostics) ? src.diagnostics : {};
    return {
        enabled: boolOr(src.enabled, d.enabled),
        agents: normalizeAgents(src.agents),
        judge: {
            // Literal judge target values (dual form, literal-preferred). All
            // three default "" — "unspecified", never a suppressing value.
            endpoint: strOr(judgeSrc.endpoint, d.judge.endpoint),
            model: strOr(judgeSrc.model, d.judge.model),
            api_key: strOr(judgeSrc.api_key, d.judge.api_key),
            model_env: strOr(judgeSrc.model_env, d.judge.model_env),
            endpoint_env: strOr(judgeSrc.endpoint_env, d.judge.endpoint_env),
            api_key_env: strOr(judgeSrc.api_key_env, d.judge.api_key_env),
            // Optional override of the user-level judge-file path (empty =
            // the XDG default). Primarily a test-injection seam.
            user_config_path: strOr(judgeSrc.user_config_path, d.judge.user_config_path),
            // Deadline remains a SAFETY PROPERTY — finite, bounded, and
            // configurable DOWN only from the 20000 ms ceiling, never up
            // (the documented "deadline hit (<=20000 ms total incl. retry)
            // -> allow" invariant). Operator decision 2026-10-05: the
            // ceiling is set from measured real-gateway latency — no
            // sampled model answers in <6 s (the configured kimi judge
            // ~11 s), so the old 2000 ms pin guaranteed fail-open for
            // every real judge. Judged calls are cadence-gated: at most
            // one assessment per 60 seconds per session when the
            // new-observation condition is also met.
            timeout_ms: intIn(judgeSrc.timeout_ms, d.judge.timeout_ms, 250, 20000),
            retries: intIn(judgeSrc.retries, d.judge.retries, 0, 1),
            min_looping_confidence: numIn(
                judgeSrc.min_looping_confidence, d.judge.min_looping_confidence, 0.5, 1),
        },
        cadence: {
            min_interval_seconds: intIn(
                cadenceSrc.min_interval_seconds, d.cadence.min_interval_seconds, 1, 3600),
            min_new_signatures: intIn(
                cadenceSrc.min_new_signatures, d.cadence.min_new_signatures, 1, 1000),
        },
        mechanical: {
            enabled: boolOr(mechSrc.enabled, d.mechanical.enabled),
            repeat_threshold: intIn(
                mechSrc.repeat_threshold, d.mechanical.repeat_threshold, 2, 10),
            window_seconds: intIn(
                mechSrc.window_seconds, d.mechanical.window_seconds, 5, 300),
            lease_seconds: intIn(
                mechSrc.lease_seconds, d.mechanical.lease_seconds, 5, 300),
            max_denials: intIn(mechSrc.max_denials, d.mechanical.max_denials, 1, 5),
        },
        semantic: {
            prior_matches: intIn(semSrc.prior_matches, d.semantic.prior_matches, 1, 10),
            window_seconds: intIn(
                semSrc.window_seconds, d.semantic.window_seconds, 10, 600),
            lease_seconds: intIn(
                semSrc.lease_seconds, d.semantic.lease_seconds, 5, 300),
            max_denials: intIn(semSrc.max_denials, d.semantic.max_denials, 1, 5),
        },
        polling_exemptions: {
            bgshell_status: boolOr(pollSrc.bgshell_status, d.polling_exemptions.bgshell_status),
        },
        state: {
            max_sessions: intIn(stateSrc.max_sessions, d.state.max_sessions, 8, 1024),
            idle_ttl_seconds: intIn(
                stateSrc.idle_ttl_seconds, d.state.idle_ttl_seconds, 60, 86400),
            ring_entries: intIn(stateSrc.ring_entries, d.state.ring_entries, 8, 128),
            ring_bytes: intIn(stateSrc.ring_bytes, d.state.ring_bytes, 4096, 131072),
        },
        concurrency: {
            // per_session is pinned to 1 by the brief ("Busy (one in-flight
            // per session ...)"). The config surface keeps the key for shape
            // stability but clamps to exactly 1.
            per_session: 1,
            global: intIn(concSrc.global, d.concurrency.global, 1, 16),
        },
        diagnostics: {
            enabled: boolOr(diagSrc.enabled, d.diagnostics.enabled),
        },
    };
}

// ---------------------------------------------------------------------------
// Mode resolution + attribution safety.
// ---------------------------------------------------------------------------

// resolveModeForAgent — the effective mode for one agent name under a
// normalized config: the specific entry wins, else the wildcard.
export function resolveModeForAgent(cfg, agentName) {
    const agents = (cfg && cfg.agents) || {};
    if (agentName && Object.prototype.hasOwnProperty.call(agents, agentName)) {
        return agents[agentName];
    }
    return agents["*"] || "off";
}

// needsAgentAttribution — true when any SPECIFIC (non-wildcard) agent key is
// configured. Then the acting agent's identity changes the effective mode, so
// an UNATTRIBUTED call can never be denied (unknown attribution must not
// inherit another agent's enforce setting). With only the wildcard key the
// mode is unambiguous without attribution.
export function needsAgentAttribution(cfg) {
    const agents = (cfg && cfg.agents) || {};
    return Object.keys(agents).some((k) => k !== "*");
}

// ---------------------------------------------------------------------------
// Cached file loading (the only I/O here).
// ---------------------------------------------------------------------------

// configRelPath — the operator-owned config location, repo-relative.
export const configRelPath = ".opencode/repo-configs/session-progress.local.json";

// _cache: path -> {mtimeMs, size, cfg}. _warnState: path -> last state string
// ("ok" | "missing" | "invalid:<sig>") so a PERSISTENT failure warns exactly
// once and a TRANSITION re-warns (mirrors auto-gate's dedup contract).
const _cache = new Map();
const _warnState = new Map();

function warnOnce(pathStr, state, detail) {
    const prev = _warnState.get(pathStr);
    if (prev === state) return; // persistent failure: already warned
    _warnState.set(pathStr, state);
    console.error(
        `[session-progress] config ${state} at ${pathStr}` +
            (detail ? ` (${detail})` : "") +
            `; using safe defaults (agents off)`,
    );
}

// statKey — the cache invalidation key. mtimeMs+size catches edits; a missing
// file is "missing" (the silent default state).
function statKey(stat) {
    return stat ? `${stat.mtimeMs}:${stat.size}` : "missing";
}

// readAndNormalize — one uncached read+normalize of a config file. Exported
// for tests. NEVER throws: returns {cfg, state} where state is
// "ok" | "missing" | "invalid".
export function readAndNormalize(filePath) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, "utf8");
    } catch {
        return { cfg: normalizeConfig(null), state: "missing" };
    }
    try {
        const parsed = JSON.parse(raw);
        if (!isPlainObject(parsed)) throw new Error("not a JSON object");
        return { cfg: normalizeConfig(parsed), state: "ok" };
    } catch (e) {
        return {
            cfg: normalizeConfig(null),
            state: "invalid",
            detail: (e && e.message) || String(e),
        };
    }
}

// loadConfig — the plugin's per-call entry. mtime-cached; absent = silent
// defaults; invalid = defaults + one deduped warn. NEVER throws.
export function loadConfig(repoRoot) {
    const filePath = path.join(repoRoot || ".", configRelPath);
    let key;
    try {
        key = statKey(fs.statSync(filePath));
    } catch {
        key = "missing";
    }
    const cached = _cache.get(filePath);
    if (cached && cached.key === key) return cached.cfg;
    let out;
    if (key === "missing") {
        // Absent file = the normal operator state: silent defaults, no warn.
        out = normalizeConfig(null);
    } else {
        const r = readAndNormalize(filePath);
        out = r.cfg;
        // Warn ONLY on invalid files (deduped). A valid file is the normal
        // configured state — never a warning.
        if (r.state === "invalid") warnOnce(filePath, `invalid`, r.detail);
    }
    _cache.set(filePath, { key, cfg: out });
    return out;
}

// __resetConfigCacheForTest — test seam: drops caches and warn-dedup state.
export function __resetConfigCacheForTest() {
    _cache.clear();
    _warnState.clear();
    _userJudgeCache.clear();
}

// ---------------------------------------------------------------------------
// User-level judge file (operator decision 2026-10-05 — the auto-gate mirror).
//
//   <XDG_CONFIG_HOME || ~/.config>/vh-agent-harness/session-progress-llm.json
//
// Schema: { "endpoint": "<url>", "model": "<id>", "apiKey": "<key>" }. The
// auto-gate field spellings are accepted as aliases so an operator can copy a
// leaf of auto-gate-llm.json shape-for-shape: `modelEndpoint` ~ `endpoint`,
// `api_key` ~ `apiKey`. Values are LITERALS (this file is user-level,
// explicitly NOT tracked — the only sanctioned literal-secret homes are this
// file and the gitignored repo-local config).
//
//   - Absent file -> empty values, SILENT (the normal no-user-config state).
//   - Present-but-invalid (unreadable / bad JSON / non-object) -> empty
//     values + ONE deduplicated stderr notice, then re-warns only on a state
//     transition (same dedup contract as the repo config). NEVER throws.
//   - mtime-cached exactly like the repo config: one statSync per unchanged
//     call; a changed file re-reads on the next tool call. No restart.
//
// Resolution order (per-field, first-non-empty-wins — auto-gate's shallow
// per-field layering): repo-config literal -> user-file value -> env var
// (by NAME from `judge.*_env`). A partial mix is therefore legitimate
// (e.g. endpoint+model from the user file, key from env): each of the three
// fields resolves independently, and the judge is AVAILABLE only when all
// three resolve non-empty (see session-progress-judge.js judgeTarget).
// ---------------------------------------------------------------------------

// judgeUserConfigFileName — the fixed filename inside the user config dir.
export const judgeUserConfigFileName = "session-progress-llm.json";

// defaultUserJudgeConfigPath — <XDG_CONFIG_HOME || ~/.config>/vh-agent-harness/
// session-progress-llm.json (same base dir as auto-gate-llm.json). `env` is
// injectable for tests; defaults to process.env.
export function defaultUserJudgeConfigPath(env) {
    const e = env || process.env;
    const base = typeof e.XDG_CONFIG_HOME === "string" && e.XDG_CONFIG_HOME
        ? e.XDG_CONFIG_HOME
        : path.join(os.homedir(), ".config");
    return path.join(base, "vh-agent-harness", judgeUserConfigFileName);
}

// normalizeUserJudgeConfig — pure. Any input -> {endpoint, model, apiKey}
// with "" for every missing/wrong-typed field. Never throws.
export function normalizeUserJudgeConfig(raw) {
    const src = isPlainObject(raw) ? raw : {};
    return {
        // `endpoint` is primary; `modelEndpoint` is the auto-gate spelling.
        endpoint: strOr(src.endpoint, strOr(src.modelEndpoint, "")),
        model: strOr(src.model, ""),
        // `apiKey` is primary; `api_key` is the repo-config spelling.
        apiKey: strOr(src.apiKey, strOr(src.api_key, "")),
    };
}

const EMPTY_USER_JUDGE = Object.freeze({ endpoint: "", model: "", apiKey: "" });

// readUserJudgeConfig — one uncached read+normalize of the user-level file.
// Exported for tests. NEVER throws: returns {values, state} where state is
// "ok" | "missing" | "invalid".
export function readUserJudgeConfig(filePath) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, "utf8");
    } catch {
        return { values: EMPTY_USER_JUDGE, state: "missing" };
    }
    try {
        const parsed = JSON.parse(raw);
        if (!isPlainObject(parsed)) throw new Error("not a JSON object");
        return { values: normalizeUserJudgeConfig(parsed), state: "ok" };
    } catch (e) {
        return {
            values: EMPTY_USER_JUDGE,
            state: "invalid",
            detail: (e && e.message) || String(e),
        };
    }
}

// _userJudgeCache: path -> {key, values} (the same statKey invalidation as
// the repo config). _userWarnState: path -> last state string for the
// deduped warn contract.
const _userJudgeCache = new Map();
const _userWarnState = new Map();

function warnUserJudgeOnce(pathStr, state, detail) {
    const prev = _userWarnState.get(pathStr);
    if (prev === state) return; // persistent failure: already warned
    _userWarnState.set(pathStr, state);
    console.error(
        `[session-progress] judge user config ${state} at ${pathStr}` +
            (detail ? ` (${detail})` : "") +
            `; ignoring user-level judge values (env fallback applies)`,
    );
}

// judgeUserConfigPath — the effective user-level file path for a normalized
// config: the `judge.user_config_path` override, else the XDG default.
export function judgeUserConfigPath(cfg, env) {
    const override = cfg && cfg.judge && cfg.judge.user_config_path;
    if (typeof override === "string" && override.length > 0) return override;
    return defaultUserJudgeConfigPath(env);
}

// loadUserJudgeConfig — the plugin's per-call entry for the user-level file.
// mtime-cached; absent = silent empty values; invalid = empty values + one
// deduped warn. NEVER throws.
export function loadUserJudgeConfig(cfg, env) {
    const filePath = judgeUserConfigPath(cfg, env);
    let key;
    try {
        key = statKey(fs.statSync(filePath));
    } catch {
        key = "missing";
    }
    const cached = _userJudgeCache.get(filePath);
    if (cached && cached.key === key) return cached.values;
    let out;
    if (key === "missing") {
        // Absent = the normal no-user-config state: silent empties, no warn.
        out = EMPTY_USER_JUDGE;
    } else {
        const r = readUserJudgeConfig(filePath);
        out = r.values;
        // Warn ONLY on invalid files (deduped). A valid file is the normal
        // configured state — never a warning.
        if (r.state === "invalid") warnUserJudgeOnce(filePath, "invalid", r.detail);
    }
    _userJudgeCache.set(filePath, { key, values: out });
    return out;
}

// mergeUserJudgeConfig — pure per-field fill of the judge literal fields from
// the user-level values. A non-empty repo-config literal wins per field; an
// empty one ("unspecified") is filled from the user file. Everything else in
// cfg is passed through unchanged (same references — cheap spread).
export function mergeUserJudgeConfig(cfg, user) {
    const j = (cfg && cfg.judge) || {};
    const u = isPlainObject(user) ? user : {};
    return {
        ...cfg,
        judge: {
            ...j,
            endpoint: strOr(j.endpoint, strOr(u.endpoint, "")),
            model: strOr(j.model, strOr(u.model, "")),
            api_key: strOr(j.api_key, strOr(u.apiKey, "")),
        },
    };
}
