// session-progress-judge.js — bounded LLM judge for session-progress-pilot.
//
// CONTRACT (Phase 1, pinned by the v2 brief):
//   - ONE total deadline (default 20000 ms, provided by the caller as
//     deadlineAt) shared by ALL attempts including the optional single
//     retry. At deadline -> fail-open ("timeout"); the caller returns allow.
//   - The plugin may abort ITS OWN judge fetch (AbortController scoped to
//     OUR HTTP request). It NEVER aborts the SDK/tool request — no handle to
//     it exists here and none may be taken.
//   - Availability is dual-form (operator decision 2026-10-05, mirroring
//     auto-gate's literal-preferred pattern), resolved PER FIELD,
//     first-non-empty-wins: config literal (`judge.endpoint` / `judge.model`
//     / `judge.api_key` — already merged with the user-level
//     session-progress-llm.json by the config module) -> env var (NAME from
//     `judge.*_env`, VALUE from env at call time). Missing any -> {
//     status: "unavailable" } (semantic judging disabled; allow; recorded).
//     A partial mix (e.g. endpoint+model literal, key from env) is
//     legitimate per-field layering — auto-gate's shallow per-field rule.
//   - STRICT 4-class output schema is validated by policy.validateVerdict.
//     This module only EXTRACTS a candidate JSON object from the model text;
//     validation (and the fail-open on invalid) lives in policy so both the
//     plugin and tests share one source of truth.
//   - The response body is byte-capped before parsing (64 KiB).
//   - A verdict resolving after deadlineAt is STALE: the caller discards it
//     (late answers cannot arm or renew denials). runJudge itself also drops
//     stale results so a late retry never masks the deadline.
//
// No state, no clock reads beyond the caller-provided now/deadlineAt: pure
// over its explicit arguments (fetchImpl/env injectable for tests).

import { validateVerdict } from "./session-progress-policy.js";

const BODY_BYTE_CAP = 64 * 1024;

// judgeTarget — resolve endpoint/model/key PER FIELD via the dual form:
// a non-empty config LITERAL wins; an empty literal ("unspecified") falls
// through to the env var (by NAME) value. Returns null when ANY of the three
// resolves empty (=> "unavailable"). Pure over cfg+env; never reads files
// (the user-level file has already been merged into cfg.judge literals by
// the config module's mergeUserJudgeConfig).
function literalOrEnv(literal, envName, env) {
    if (typeof literal === "string" && literal.length > 0) return literal;
    if (typeof envName === "string" && envName.length > 0) {
        const v = env[envName];
        if (typeof v === "string" && v.length > 0) return v;
    }
    return "";
}

export function judgeTarget(cfg, env) {
    const e = env || process.env;
    const j = (cfg && cfg.judge) || {};
    const endpoint = literalOrEnv(j.endpoint, j.endpoint_env, e);
    const model = literalOrEnv(j.model, j.model_env, e);
    const apiKey = literalOrEnv(j.api_key, j.api_key_env, e);
    if (endpoint.length === 0 || model.length === 0 || apiKey.length === 0) return null;
    return { endpoint, model, apiKey };
}

// extractJsonCandidate — pull the first balanced {...} JSON object out of
// model text (models wrap JSON in prose/fences despite instructions). The
// candidate is then STRICTLY validated by policy.validateVerdict; a prose
// lookalike fails there. Returns the parsed object or null.
export function extractJsonCandidate(text) {
    if (typeof text !== "string" || text.length === 0) return null;
    const start = text.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length && i - start < BODY_BYTE_CAP; i++) {
        const c = text[i];
        if (inStr) {
            if (c === "\\") i++;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) {
                try {
                    const parsed = JSON.parse(text.slice(start, i + 1));
                    return typeof parsed === "object" && parsed !== null ? parsed : null;
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

// buildJudgeMessages — the judge prompt. The model must reply with ONE JSON
// object, nothing else. The 4-class vocabulary and the confidence scale are
// stated explicitly; "completed is not necessarily success" and "unknown is
// not no-progress" guard the model's reading of outcome classes.
export function buildJudgeMessages(packet) {
    const system =
        "You are a precise activity classifier for AI coding-agent tool calls. " +
        "You receive a JSON packet of recent tool-call observations from one session. " +
        "Classify the CURRENT (marked) call's activity pattern:\n" +
        '- "productive": the call plausibly advances the task (including deliberate retries with changed arguments).\n' +
        '- "looping": the SAME exact invocation is being repeated unchanged after adverse results, with no new information between attempts.\n' +
        '- "stuck": work is blocked on something external (permission, missing dependency, unavailable resource).\n' +
        '- "drifting": activity continues but the goal appears abandoned or unreferenced.\n' +
        "Facts about the packet: outcome \"exit-fail\" means the command ran and exited non-zero; " +
        "\"error\" means the call failed; \"unknown\" means no recorded outcome (NOT success and NOT failure); " +
        "\"denied-by-detector\" observations are this detector's own denials and are NOT agent failures; " +
        "exempt_poll observations are legitimate status polling.\n" +
        "Reply with EXACTLY ONE JSON object and no other text:\n" +
        '{"verdict":"productive|looping|stuck|drifting","confidence":<number 0..1>,' +
        '"reason":"<short string>","evidence_refs":["<observation ids from the packet>"]}\n' +
        "A looping verdict MUST cite at least one packet observation id in evidence_refs.";
    const user = JSON.stringify(packet);
    return [
        { role: "system", content: system },
        { role: "user", content: user },
    ];
}

// oneAttempt — a single bounded fetch+parse. Never resolves with a verdict
// after deadlineAt (stale -> rejects with class "stale"). Our own
// AbortController bounds the fetch; aborting it touches ONLY our request.
// `now` is the CALLER-PROVIDED clock (tests use a synthetic one) — never mix
// Date.now() in here.
async function oneAttempt(target, packet, fetchImpl, deadlineAt, now) {
    const remaining = deadlineAt - now();
    if (remaining <= 0) {
        const e = new Error("deadline exhausted before attempt");
        e.judgeClass = "timeout";
        throw e;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), remaining); // OUR fetch only
    let res;
    try {
        res = await fetchImpl(target.endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${target.apiKey}`,
            },
            body: JSON.stringify({
                model: target.model,
                messages: buildJudgeMessages(packet),
                temperature: 0,
                stream: false,
            }),
            signal: ac.signal,
        });
    } catch (e) {
        const err = new Error((e && e.message) || String(e));
        err.judgeClass = e && e.name === "AbortError" ? "timeout" : "network";
        throw err;
    } finally {
        clearTimeout(timer);
    }
    if (!res || typeof res.status !== "number" || res.status < 200 || res.status >= 300) {
        const status = res && typeof res.status === "number" ? res.status : -1;
        const err = new Error(`non-2xx response: ${status}`);
        // 5xx is transient (retryable); 4xx is permanent.
        err.judgeClass = status === -1 || status >= 500 ? "http-5xx" : "http-4xx";
        throw err;
    }
    // Byte-capped body read: content-length first, then a capped text read.
    const clen = parseInt(res.headers && res.headers.get ? res.headers.get("content-length") : "", 10);
    if (Number.isFinite(clen) && clen > BODY_BYTE_CAP) {
        const err = new Error(`response too large: ${clen}`);
        err.judgeClass = "oversize";
        throw err;
    }
    let text;
    try {
        text = await res.text();
    } catch (e) {
        const err = new Error((e && e.message) || String(e));
        err.judgeClass = "network";
        throw err;
    }
    if (text.length > BODY_BYTE_CAP) {
        const err = new Error("response body exceeds cap");
        err.judgeClass = "oversize";
        throw err;
    }
    if (now() > deadlineAt) {
        // A delayed body cannot evade the total deadline: the answer is stale.
        const err = new Error("stale: body arrived after deadline");
        err.judgeClass = "stale";
        throw err;
    }
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        const err = new Error("malformed JSON response");
        err.judgeClass = "malformed";
        throw err;
    }
    const content =
        json && json.choices && json.choices[0] && json.choices[0].message
            ? json.choices[0].message.content
            : undefined;
    if (typeof content !== "string" || content.length === 0) {
        const err = new Error("missing choices[0].message.content");
        err.judgeClass = "malformed";
        throw err;
    }
    const candidate = extractJsonCandidate(content);
    const verdict = candidate ? validateVerdict(candidate, packet) : null;
    if (!verdict) {
        const err = new Error("verdict failed strict schema validation");
        err.judgeClass = "invalid-verdict";
        throw err;
    }
    return verdict;
}

// runJudge — the plugin's only entry.
//   {status:"verdict", verdict}          — a schema-VALID verdict, in time
//   {status:"unavailable"}               — endpoint/model/key not configured
//   {status:"timeout"|"error", class, message} — fail-open outcomes
// The optional single retry (cfg.judge.retries <= 1) runs INSIDE the same
// deadlineAt and only for transient classes (network/timeout/malformed/5xx).
export async function runJudge(cfg, packet, opts) {
    const o = opts || {};
    const fetchImpl = o.fetchImpl || (typeof fetch === "function" ? fetch : null);
    const env = o.env || process.env;
    const now = typeof o.now === "function" ? o.now : Date.now;
    const target = judgeTarget(cfg, env);
    if (!target) return { status: "unavailable" };
    if (!fetchImpl) return { status: "error", class: "no-fetch", message: "no fetch implementation" };
    const timeoutMs = (cfg && cfg.judge && cfg.judge.timeout_ms) || 20000;
    // The caller may pass ONE shared slow-path deadlineAt (the plugin's
    // history+judge budget). Without it, the judge owns its own timeout_ms.
    const deadlineAt = typeof o.deadlineAt === "number" ? o.deadlineAt : now() + timeoutMs;
    const retries = cfg && cfg.judge ? Math.min(1, Math.max(0, cfg.judge.retries)) : 0;
    const retryable = new Set(["network", "timeout", "malformed", "http-5xx"]);
    let attemptErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (now() >= deadlineAt) {
            return { status: "timeout", class: "timeout", message: "deadline exhausted" };
        }
        try {
            const verdict = await oneAttempt(target, packet, fetchImpl, deadlineAt, now);
            return { status: "verdict", verdict };
        } catch (e) {
            attemptErr = e;
            const cls = e && e.judgeClass ? e.judgeClass : "error";
            if (now() >= deadlineAt) {
                return { status: "timeout", class: "timeout", message: cls };
            }
            if (attempt === retries || !retryable.has(cls)) {
                return { status: "error", class: cls, message: (e && e.message) || String(e) };
            }
            // retry immediately; the deadline still bounds everything
        }
    }
    return {
        status: "error",
        class: attemptErr && attemptErr.judgeClass ? attemptErr.judgeClass : "error",
        message: (attemptErr && attemptErr.message) || "unreachable",
    };
}
