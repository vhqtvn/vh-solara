// session-progress-policy.js — pure policy engine for session-progress-pilot.
//
// CONTRACT: NO I/O, NO clock, NO hidden state. Every exported function is
// pure over its explicit arguments (observations, config, `now`), so tests
// drive scenarios with synthetic times and the plugin owns ALL state and
// side effects. Sub-slice map: signature/observation/scrub primitives ship
// with sub-slice 2; exemption/spend/mechanical/lease/reason with sub-slice 3;
// semantic evaluation/packet/verdict validation with sub-slice 4.

// ---------------------------------------------------------------------------
// Canonical signature (EXACTNESS-PRESERVING — the safety-critical primitive).
//
// A signature stands for ONE exact invocation. Oversized or unsupported args
// are UNENFORCEABLE ("reject ... rather than truncating into a colliding
// signature"): the caller records the observation but never lets it ground a
// denial. Depth and node budget guard against pathological inputs.
// ---------------------------------------------------------------------------

const SIG_MAX_JSON = 4096; // canonical-JSON byte budget for args
const SIG_MAX_NODES = 10000; // structural budget (objects+arrays+leaves)
const SIG_MAX_DEPTH = 16;

function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

// canonicalStringify — deterministic JSON: object keys sorted, arrays in
// order, only JSON scalar types. Returns null when the value contains
// non-JSON types (undefined/function/symbol/bigint) or exceeds budget.
function canonicalStringify(value, depth, budget) {
    if (budget.n <= 0) return null;
    budget.n--;
    if (depth > SIG_MAX_DEPTH) return null;
    if (value === null) return "null";
    const t = typeof value;
    if (t === "string") return JSON.stringify(value);
    if (t === "boolean") return value ? "true" : "false";
    if (t === "number") {
        if (!Number.isFinite(value)) return null; // NaN/Infinity are not JSON
        return JSON.stringify(value);
    }
    if (t === "object") {
        if (Array.isArray(value)) {
            const parts = [];
            for (const el of value) {
                const s = canonicalStringify(el, depth + 1, budget);
                if (s === null) return null;
                parts.push(s);
            }
            return "[" + parts.join(",") + "]";
        }
        if (isPlainObject(value)) {
            const keys = Object.keys(value).sort();
            const parts = [];
            for (const k of keys) {
                if (budget.n <= 0) return null;
                const s = canonicalStringify(value[k], depth + 1, budget);
                if (s === null) return null;
                parts.push(JSON.stringify(k) + ":" + s);
            }
            return "{" + parts.join(",") + "}";
        }
        return null; // Map/Set/Date/... are not tool-arg shapes we can pin
    }
    return null; // undefined/function/symbol/bigint
}

// fnv1a32 — small deterministic 32-bit hash (hex, 8 chars). Two seeds are
// combined into a 16-hex-char signature: cheap, stable, adequate for a
// per-session pilot matcher (this is NOT a cryptographic claim).
function fnv1a32(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}

// computeSignature — {sig, canonical} on success; {unsupported, reason} when
// the invocation cannot be pinned exactly (never a truncated fallback).
export function computeSignature(tool, args) {
    if (typeof tool !== "string" || tool.length === 0 || tool.length > 128) {
        return { unsupported: true, reason: "tool" };
    }
    if (args === undefined || args === null || !isPlainObject(args)) {
        return { unsupported: true, reason: "args" };
    }
    const budget = { n: SIG_MAX_NODES };
    const json = canonicalStringify(args, 0, budget);
    if (json === null) return { unsupported: true, reason: "serialize" };
    if (json.length > SIG_MAX_JSON) return { unsupported: true, reason: "oversized" };
    const canonical = tool + "\u0000" + json;
    return { sig: fnv1a32(canonical, 0x811c9dc5) + fnv1a32(canonical, 0x9747b28c), canonical };
}

// shortId — the bounded display form of a signature (first 8 hex chars).
export function shortId(sig) {
    return typeof sig === "string" ? sig.slice(0, 8) : "????????";
}

// ---------------------------------------------------------------------------
// Outcome classes (the "safe tool adapter" surface).
//
// History enrichment maps each observed callID to an outcome:
//   {cls: "error"}     — ToolPart state.status === "error" (and NOT one of
//                        our own denials — own denials carry the marker and
//                        are excluded from repeated-failure evidence).
//   {cls: "exit-fail"} — completed `bash` call whose metadata.exit > 0 (the
//                        bash/shell tool completes with metadata.exit on
//                        non-zero exit rather than erroring — verified
//                        against refs/opencode/src/tool/shell.ts).
//   {cls: "ok"}        — completed with no adapter-known failure.
//   {cls: "unknown"}   — anything else (pending/running/unadaptable tool).
//
// MECHANICAL_ADAPTERS pins the tools with a verified safe adapter. `bash` is
// the only Phase-1 adapter: it knows metadata.exit semantics. Completed calls
// of UNADAPTED tools are "unknown" — exact successful reads and unknown
// outcomes are never enough to deny.
// ---------------------------------------------------------------------------

export const OWN_DENIAL_MARKER = "[session-progress]";

export const MECHANICAL_ADAPTERS = Object.freeze({ bash: true });

// classifyHistoryPart — map ONE opencode session-message ToolPart (schema
// E4) + our own observed callIDs into an outcome. Pure.
//   part: {type:"tool", callID, tool, state:{status, error?, metadata?}}
//   ownDenied: Set of callIDs denied by this plugin (excluded from evidence).
export function classifyHistoryPart(part, ownDenied) {
    if (!part || part.type !== "tool" || typeof part.callID !== "string") return null;
    if (ownDenied && ownDenied.has(part.callID)) {
        return { callID: part.callID, cls: "own-denial" };
    }
    const st = part.state || {};
    if (st.status === "error") {
        return { callID: part.callID, cls: "error", digest: fnv1a32(String(st.error || ""), 0x811c9dc5) };
    }
    if (st.status === "completed") {
        if (part.tool === "bash") {
            const exit = st.metadata && typeof st.metadata.exit === "number" ? st.metadata.exit : null;
            if (exit !== null && exit > 0) {
                const outDigest = fnv1a32(String(st.output || ""), 0x9747b28c);
                return { callID: part.callID, cls: "exit-fail", digest: exit + ":" + outDigest };
            }
            return { callID: part.callID, cls: "ok" };
        }
        return { callID: part.callID, cls: "unknown" };
    }
    return { callID: part.callID, cls: "unknown" };
}

// outcomesUnchangedAdverse — true when `outs` (non-empty) are pairwise
// UNCHANGED (same cls AND digest) and at least `minAdverse` are ADVERSE
// (error | exit-fail). This is the mechanical "repeated unchanged adverse
// results" test.
export function outcomesUnchangedAdverse(outs, minAdverse) {
    const real = outs.filter((o) => o && (o.cls === "error" || o.cls === "exit-fail"));
    if (real.length < minAdverse) return false;
    const first = real[0];
    return real.every((o) => o.cls === first.cls && o.digest === first.digest);
}

// ---------------------------------------------------------------------------
// Scrubbing — an ENGINEERING requirement, not a claim inherited from the
// classifier implementation (E7/E8: the existing scrubber is explicitly
// unsanitized; do not copy it). Everything that reaches diagnostics or the
// judge packet passes through scrubText.
// ---------------------------------------------------------------------------

const SECRETISH_KEY = /(key|token|secret|password|passwd|credential|auth|bearer|cookie)/i;
const LONG_RUN = /[A-Za-z0-9+/=_-]{40,}/g; // base64/hex/jwt-ish runs

// scrubText — collapse whitespace, mask secret-looking KEY=VALUE pairs, mask
// long token-ish runs, cap length. Pure; never throws.
export function scrubText(text, cap) {
    const limit = typeof cap === "number" && cap > 0 ? Math.min(cap, 2048) : 512;
    let s;
    try {
        s = String(text === null || text === undefined ? "" : text);
    } catch {
        return "";
    }
    s = s.replace(/\s+/g, " ").trim();
    s = s.replace(/([A-Za-z0-9_]+)=(("[^"]*")|('[^']*')|(\S+))/g, (m, k) =>
        SECRETISH_KEY.test(k) ? `${k}=***` : m);
    s = s.replace(LONG_RUN, (m) => (m.length >= 40 ? m.slice(0, 6) + "…" + "[masked]" : m));
    return s.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Ring bound — the serialized-evidence budget per session. Drops OLDEST
// observations until the serialized form fits. Pure.
// ---------------------------------------------------------------------------

export function boundRing(observations, maxEntries, maxBytes) {
    let ring = observations.length > maxEntries ? observations.slice(-maxEntries) : observations.slice();
    const size = () => {
        try {
            return JSON.stringify(ring).length;
        } catch {
            return Infinity;
        }
    };
    while (ring.length > 0 && size() > maxBytes) {
        ring = ring.slice(1);
    }
    return ring;
}

// ---------------------------------------------------------------------------
// Polling exemption (sub-slice 3) — EXACT documented grammar, nothing looser.
//
// Recognized (E10, .opencode/skills/bgshell-job/SKILL.md):
//   vh-agent-harness exec (python|python3) <bgshell_job.py path> status
//       (--job <name> | --job-dir <path>) [--lines <1..500>]
// --lines may appear before or after the target pair. ANY other token shape
// — chaining operators, other subcommands (launch/stop/resume/logs), extra
// flags, a second target — is NOT exempt. The whitespace split means a
// command containing `;`/`&&`/`|` produces extra tokens and fails the match.
// ---------------------------------------------------------------------------

const BGSHELL_SCRIPT = ".opencode/skills/bgshell-job/scripts/bgshell_job.py";

export function isPollingExemptCommand(command, cfg) {
    if (!cfg || !cfg.polling_exemptions || !cfg.polling_exemptions.bgshell_status) return false;
    if (typeof command !== "string" || command.length === 0) return false;
    const tokens = command.trim().split(/\s+/);
    const n = tokens.length;
    if (n < 7 || n > 9) return false;
    if (tokens[0] !== "vh-agent-harness" || tokens[1] !== "exec") return false;
    if (tokens[2] !== "python" && tokens[2] !== "python3") return false;
    if (tokens[3] !== BGSHELL_SCRIPT) return false;
    if (tokens[4] !== "status") return false;
    let hasTarget = false;
    let sawLines = false;
    let i = 5;
    while (i < n) {
        const t = tokens[i];
        if (t === "--job" || t === "--job-dir") {
            if (hasTarget) return false;
            const v = tokens[i + 1];
            if (!v || v.startsWith("--")) return false;
            hasTarget = true;
            i += 2;
        } else if (t === "--lines") {
            if (sawLines) return false;
            const v = tokens[i + 1];
            if (!v || !/^\d+$/.test(v)) return false;
            const ln = parseInt(v, 10);
            if (ln < 1 || ln > 500) return false;
            sawLines = true;
            i += 2;
        } else {
            return false; // chaining operators / other flags / extra words
        }
    }
    return hasTarget;
}

// ---------------------------------------------------------------------------
// Spend gate (sub-slice 3) — judge-spend throttling ONLY. Never a deny reason.
// `st` is the session state: {createdAt, spend:{lastAttempt, accrued}}.
// Both constraints (interval AND accrued new observations) must hold; the
// FIRST assessment waits for them from session observation start.
// ---------------------------------------------------------------------------

export function spendGateOpen(st, cfg, now) {
    if (!st || !st.spend) return false;
    const base = typeof st.spend.lastAttempt === "number" ? st.spend.lastAttempt : st.createdAt;
    if (typeof base !== "number") return false;
    const sinceMs = now - base;
    return (
        sinceMs >= cfg.cadence.min_interval_seconds * 1000 &&
        st.spend.accrued >= cfg.cadence.min_new_signatures
    );
}

// ---------------------------------------------------------------------------
// Leases (sub-slice 3/4) — narrow, short, deny-hit-capped. A lease is a PRIOR
// policy decision on ONE signature: while active with hits < maxHits it
// denies in enforce mode WITHOUT a new judge call; expired or capped leases
// allow and are forgotten. No rearm from the plugin's own denials — only
// fresh executed evidence (mechanical/semantic evaluation over non-own-denial
// observations) can arm a NEW lease.
// ---------------------------------------------------------------------------

export function leaseFor(leases, key) {
    return (leases && Object.prototype.hasOwnProperty.call(leases, key)) ? leases[key] : null;
}

// leaseDecision — pure: given one lease record and now, decide.
//   {action:"deny", lease} — active with remaining hits
//   {action:"none"}        — no lease
//   {action:"expired"}     — past expiry (caller drops it)
//   {action:"capped"}      — hits exhausted (caller drops it at expiry)
export function leaseDecision(lease, now) {
    if (!lease) return { action: "none" };
    if (now >= lease.expiresAt) return { action: "expired" };
    if (lease.hits >= lease.maxHits) return { action: "capped" };
    return { action: "deny", lease };
}

// leaseConsume — deny-side bookkeeping when a lease denies once more.
export function leaseConsume(lease) {
    lease.hits += 1;
    return lease;
}

// ---------------------------------------------------------------------------
// Mechanical fast path (sub-slice 3) — no LLM, no history fetch, adapter-gated.
//
// Fires only when ALL hold:
//   - cfg.mechanical.enabled AND the tool has a verified safe adapter (bash)
//   - an UNBROKEN trailing run (any other signature breaks it; exempt,
//     unsupported and own-denial observations neither count nor continue the
//     run) of >= repeat_threshold attempts of THIS exact signature
//   - the run started within window_seconds
//   - >= 2 prior run observations have RECORDED outcomes that are UNCHANGED
//     and ADVERSE (error / exit-fail)
// ---------------------------------------------------------------------------

export function evaluateMechanical(ring, tool, sig, cfg, now) {
    if (!cfg || !cfg.mechanical || !cfg.mechanical.enabled) return { fire: false, why: "disabled" };
    if (!MECHANICAL_ADAPTERS[tool]) return { fire: false, why: "no-adapter" };
    let i = ring.length - 1;
    while (
        i >= 0 &&
        ring[i].sig === sig &&
        !ring[i].exempt &&
        !ring[i].unsupported &&
        !ring[i].ownDenial
    ) {
        i--;
    }
    const runObs = ring.slice(i + 1);
    if (runObs.length < cfg.mechanical.repeat_threshold) {
        return { fire: false, why: "below-threshold", run: runObs.length };
    }
    const firstTs = runObs[0].ts;
    if (now - firstTs > cfg.mechanical.window_seconds * 1000) {
        return { fire: false, why: "window", run: runObs.length };
    }
    const priorObs = runObs.slice(0, -1); // everything before the current call
    const outs = priorObs.map((o) => o.outcome).filter(Boolean);
    // Enrichment-lag rule: the MOST RECENT prior's outcome is structurally
    // unavailable at this check (its history part appears only after it
    // completes, and the next enrichment runs at this call's own assessment —
    // after the mechanical check). Every OTHER prior must carry a recorded
    // outcome; a hole anywhere older means the evidence is incomplete or the
    // outcomes changed underneath us — do not fire on partial evidence.
    if (outs.length < priorObs.length - 1) {
        return { fire: false, why: "outcomes-lagging", run: runObs.length };
    }
    if (outs.length < 2) return { fire: false, why: "outcomes-unknown", run: runObs.length };
    if (!outcomesUnchangedAdverse(outs, 2)) {
        return { fire: false, why: "outcomes-changed", run: runObs.length };
    }
    const evidenceIds = priorObs
        .filter((o) => o.outcome && (o.outcome.cls === "error" || o.outcome.cls === "exit-fail"))
        .map((o) => o.seq);
    return { fire: true, rule: "mechanical", evidenceIds, run: runObs.length };
}

// ---------------------------------------------------------------------------
// Bounded deny reason (sub-slice 3). The ONLY string the model sees from a
// denial. Carries the own-denial marker so history enrichment can exclude our
// denials from repeated-failure evidence. Never instructs perturbation, never
// promises recovery, never exceeds 600 chars.
// ---------------------------------------------------------------------------

export function buildDenyReason({ tool, sigId, rule, evidenceIds, expiresAt, hitsLeft }) {
    const ev = (evidenceIds || []).slice(0, 6).map(String).join(", ");
    const until = new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z");
    const parts = [
        OWN_DENIAL_MARKER,
        `This exact \`${tool}\` invocation repeated unchanged adverse results` +
            (ev ? ` (observations ${ev}; signature ${sigId})` : ` (signature ${sigId})`) + ".",
        `This exact signature is temporarily denied until ${until} (rule ${rule}; ` +
            `${hitsLeft} deny${hitsLeft === 1 ? "" : "s"} remaining; other calls remain allowed).`,
        "Inspect the cited failures or test a different hypothesis before repeating this call.",
    ];
    const s = parts.join(" ");
    return s.length > 600 ? s.slice(0, 597) + "..." : s;
}

// ---------------------------------------------------------------------------
// Judge packet (sub-slice 4) — bounded, scrubbed. The ring stores hashed
// signature ids (never raw args); the assistant excerpt is scrubbed and
// capped at 512 chars. Pending/current outcomes are explicitly unknown.
// ---------------------------------------------------------------------------

export function buildJudgePacket({ ring, tool, sig, now, agentName, assessmentId }) {
    const observations = ring.map((o) => ({
        id: String(o.seq),
        tool: o.tool,
        sig_id: shortId(o.sig),
        current: o.sig === sig,
        ts_offset_ms: now - o.ts,
        executed: !o.ownDenial,
        exempt_poll: !!o.exempt,
        outcome: o.ownDenial ? "denied-by-detector" : o.outcome ? o.outcome.cls : "unknown",
    }));
    const distinctSigs = new Set(ring.map((o) => o.sig));
    return {
        assessment_id: assessmentId,
        generated_for: "session-progress-pilot v1 (looping tool-call detection)",
        current_tool: tool,
        current_signature: shortId(sig),
        window_ms: ring.length > 0 ? now - ring[0].ts : 0,
        distinct_signature_count: distinctSigs.size,
        agent: agentName ? scrubText(agentName, 64) : "unknown",
        observations,
    };
}

// attachAssistantExcerpt — the ≤512-char scrubbed last-assistant text excerpt.
export function attachAssistantExcerpt(packet, text) {
    packet.last_assistant_excerpt = scrubText(text, 512);
    return packet;
}

// ---------------------------------------------------------------------------
// Verdict validation (sub-slice 4) — STRICT 4-class schema. Unknown fields,
// wrong types, invalid enum, out-of-range confidence, dangling evidence
// references, or a deny-qualifying verdict with NO evidence => invalid
// (fail-open). Returns the normalized verdict or null.
// ---------------------------------------------------------------------------

export const VERDICT_CLASSES = Object.freeze({
    productive: true,
    looping: true,
    stuck: true,
    drifting: true,
});

const VERDICT_KEYS = Object.freeze(["verdict", "confidence", "reason", "evidence_refs"]);

export function validateVerdict(v, packet) {
    if (!isPlainObject(v)) return null;
    for (const k of Object.keys(v)) {
        if (!VERDICT_KEYS.includes(k)) return null; // strict: no extra fields
    }
    if (!VERDICT_CLASSES[v.verdict]) return null;
    if (typeof v.confidence !== "number" || !Number.isFinite(v.confidence)) return null;
    if (v.confidence < 0 || v.confidence > 1) return null;
    if (v.reason !== undefined && typeof v.reason !== "string") return null;
    if (!Array.isArray(v.evidence_refs)) return null;
    if (v.evidence_refs.length > 8) return null;
    const validIds = new Set((packet.observations || []).map((o) => String(o.id)));
    const ids = [];
    for (const r of v.evidence_refs) {
        if (typeof r !== "string" || r.length > 64) return null;
        if (!validIds.has(r)) return null; // dangling ref => invalid
        ids.push(r);
    }
    if (v.verdict === "looping" && ids.length === 0) return null;
    return {
        verdict: v.verdict,
        confidence: v.confidence,
        reason: scrubText(v.reason || "", 200),
        evidence_ids: ids,
    };
}

// ---------------------------------------------------------------------------
// Semantic evaluation (sub-slice 4) — the judge INFORMS; this deterministic
// policy alone decides. Only `looping` above the confidence floor, with
// valid packet evidence, AND independent local corroboration (>= prior_matches
// EXECUTED, non-exempt observations of THIS exact signature with UNCHANGED
// ADVERSE outcomes inside the semantic window) may fire. productive/stuck/
// drifting NEVER deny.
// ---------------------------------------------------------------------------

export function evaluateSemantic(vd, { ring, sig, cfg, now }) {
    if (!vd) return { fire: false, why: "no-verdict" };
    if (vd.verdict !== "looping") return { fire: false, why: vd.verdict };
    if (vd.confidence < cfg.judge.min_looping_confidence) {
        return { fire: false, why: "confidence" };
    }
    const winMs = cfg.semantic.window_seconds * 1000;
    const prior = ring.filter(
        (o) =>
            o.sig === sig &&
            !o.ownDenial &&
            !o.exempt &&
            o.outcome &&
            (o.outcome.cls === "error" || o.outcome.cls === "exit-fail") &&
            now - o.ts <= winMs,
    );
    if (prior.length < cfg.semantic.prior_matches) {
        return { fire: false, why: "prior-matches" };
    }
    if (!outcomesUnchangedAdverse(prior.map((o) => o.outcome), cfg.semantic.prior_matches)) {
        return { fire: false, why: "outcomes-changed" };
    }
    return {
        fire: true,
        rule: "semantic",
        evidenceIds: vd.evidence_ids.slice(),
        priorIds: prior.map((o) => o.seq),
    };
}
