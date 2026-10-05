// session-progress.js — session-progress-pilot OpenCode plugin.
//
// CONTRACT (Phase 1, pinned by the v2 brief and the operator's hard
// constraints):
//   - ONE hook only: `tool.execute.before`. Deny = throw a bounded reason
//     (enforce mode ONLY). Allow = plain return. Audit mode NEVER throws.
//   - NO cancellation: the plugin never aborts the SDK/tool request. Any
//     deadline (<=20000 ms total slow path incl. retry, the operator-set
//     2026-10-05 ceiling — down-configurable, default 20000; <=5 ms local
//     path target) means RETURN ALLOW, never abort. The only AbortController
//     in this pack belongs to the judge's OWN HTTP fetch.
//   - Fail-open EVERYWHERE: the entire hook body is wrapped; any error in
//     config/state/attribution/history/judge/diagnostics -> allow.
//   - Cadence/time/rate gating throttles judge spend ONLY — never a deny
//     reason by itself.
//   - Never mutates output.args. No steps changes. No state persistence
//     across sessions (leases/counters are process memory; diagnostics are
//     write-only and never read back).
//
// Flow per tool call (numbers match the implementation order below):
//   1. exact signature (or `unsupported` -> unenforceable, allowed)
//   2. polling exemption -> allow, never deny, never accrue
//   3. resolve mode + attribution safety BEFORE recording — `off` agents
//      are never observed at all; unknown attribution can't deny
//   4. record the attempted observation (current call included)
//   5. existing lease on this exact signature -> deny (enforce) / would-deny
//   6. mechanical fast path (adapter-gated, no LLM, no history fetch)
//   7. spend gate + busy slots -> allow when closed
//   8. ONE slow-path deadline (history enrich -> judge -> semantic policy);
//      at deadline/error/invalid evidence -> allow
//
// Module layout: this is the ONLY OpenCode-coupled unit (auto-discovered
// from .opencode/plugins/). Pure logic lives in ../scripts/
// session-progress-policy.js, config in ../scripts/session-progress-config.js,
// the bounded judge in ../scripts/session-progress-judge.js.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
    loadConfig,
    loadUserJudgeConfig,
    mergeUserJudgeConfig,
    needsAgentAttribution,
    resolveModeForAgent,
} from "../scripts/session-progress-config.js";
import {
    OWN_DENIAL_MARKER,
    boundRing,
    buildDenyReason,
    buildJudgePacket,
    attachAssistantExcerpt,
    classifyHistoryPart,
    computeSignature,
    evaluateMechanical,
    evaluateSemantic,
    isPollingExemptCommand,
    leaseConsume,
    leaseDecision,
    shortId,
    spendGateOpen,
} from "../scripts/session-progress-policy.js";
import { judgeTarget, runJudge } from "../scripts/session-progress-judge.js";

export const id = "session-progress-pilot";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// repoRoot — the rendered plugin lives at <repoRoot>/.opencode/plugins/, so
// up-two is the project root. SESSION_PROGRESS_REPO_ROOT is a test/diagnostic
// override read at CALL time (never cached), mirroring the
// OPENCODE_STATE_ROOT convention. Never process.cwd() (unreliable in the
// plugin server context).
function repoRoot() {
    const env = process.env.SESSION_PROGRESS_REPO_ROOT;
    if (typeof env === "string" && env.length > 0) return env;
    return path.resolve(__dirname, "..", "..");
}

// _now — single clock seam (tests override via __test.setNow).
let _now = () => Date.now();

// ---------------------------------------------------------------------------
// Process-memory state. NEVER persisted; NEVER restored from diagnostics.
// ---------------------------------------------------------------------------

const _sessions = new Map(); // sessionID -> session state
let _globalInFlight = 0; // judge assessments in flight, process-wide

function newSessionState(now) {
    return {
        createdAt: now,
        lastSeen: now,
        seq: 0,
        ring: [], // observations, oldest -> newest
        ownDenied: new Set(), // callIDs this plugin denied
        leases: {}, // `${rule}:${sig}` -> {rule, sig, expiresAt, hits, maxHits}
        spend: { lastAttempt: null, accrued: 0 },
        inFlight: false,
        agentName: null,
        agentBoundAt: 0,
    };
}

// sessionState — lazy get-or-create with idle eviction at hook entry. Beyond
// the cap, idle sessions go first (oldest lastSeen), then the stale-most
// sessions until within cap. Eviction forgets detection history (never
// restored).
function sessionState(sessionID, cfg, now) {
    if (!_sessions.has(sessionID)) {
        const idleMs = cfg.state.idle_ttl_seconds * 1000;
        if (_sessions.size >= cfg.state.max_sessions) {
            const entries = [..._sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
            for (const [k, st] of entries) {
                if (_sessions.size < cfg.state.max_sessions) break;
                if (now - st.lastSeen > idleMs || _sessions.size >= cfg.state.max_sessions) {
                    _sessions.delete(k);
                }
            }
        }
        _sessions.set(sessionID, newSessionState(now));
    }
    const st = _sessions.get(sessionID);
    st.lastSeen = now;
    return st;
}

// ---------------------------------------------------------------------------
// Diagnostics — bounded, scrubbed, coalesced, single-flight, best-effort.
// NEVER awaited from the hook's decision path; failure NEVER turns allow
// into deny. Files (under <repoRoot>/tmp/agent-runs/session-progress-pilot/):
//   verdicts.jsonl (+ .1 rotation, <=256KiB each), status.json (<=64KiB).
// Nothing is ever read back for enforcement.
// ---------------------------------------------------------------------------

const VERDICTS_MAX_BYTES = 256 * 1024;
const STATUS_MAX_BYTES = 64 * 1024;

const _diag = {
    queue: [],
    writing: false,
    dropped: 0,
    lastStatusWrite: 0,
    totals: { records: 0, denied: 0, wouldDeny: 0, assessments: 0, judgeCalls: 0 },
};

function diagDir(root) {
    return path.join(root, "tmp", "agent-runs", "session-progress-pilot");
}

function diagRecord(root, rec) {
    // ALL diagnostic writing is gated on diagnostics.enabled (the documented
    // contract): false -> NEITHER verdicts.jsonl NOR status.json is ever
    // created. The config is read here (mtime-cached, never throws by the
    // config module's contract) so the gate covers every call site uniformly
    // — including the internal-error path where no cfg is in scope. A config
    // read failure fails diagnostics CLOSED (drop the record); the call
    // itself still fails open elsewhere.
    let diagCfg = null;
    try {
        diagCfg = loadConfig(root);
    } catch {
        return;
    }
    if (!diagCfg || !diagCfg.diagnostics || !diagCfg.diagnostics.enabled) return;
    _diag.queue.push(rec);
    _diag.totals.records += 1;
    if (rec.action === "deny") _diag.totals.denied += 1;
    if (rec.action === "would-deny") _diag.totals.wouldDeny += 1;
    if (rec.kind === "assessment") _diag.totals.assessments += 1;
    if (rec.judge === true) _diag.totals.judgeCalls += 1;
    // Bound the queue: coalescing drops OLDEST pending records under pressure.
    while (_diag.queue.length > 64) {
        _diag.queue.shift();
        _diag.dropped += 1;
    }
    if (!_diag.writing) {
        _diag.writing = true;
        // Async drain on the microtask/macrotask boundary — the hook never
        // awaits this.
        setTimeout(() => {
            drainDiagnostics(root).finally(() => {
                _diag.writing = false;
            });
        }, 0);
    }
}

function rotateIfNeeded(dir, name) {
    const f = path.join(dir, name);
    try {
        const st = fs.statSync(f);
        if (st.size >= VERDICTS_MAX_BYTES) {
            try {
                fs.rmSync(path.join(dir, name + ".1"));
            } catch {
                /* no prior rotation */
            }
            fs.renameSync(f, path.join(dir, name + ".1"));
        }
    } catch {
        /* absent file: nothing to rotate */
    }
}

function drainDiagnostics(root) {
    const batch = _diag.queue.splice(0, _diag.queue.length);
    return new Promise((resolve) => {
        try {
            const dir = diagDir(root);
            fs.mkdirSync(dir, { recursive: true });
            rotateIfNeeded(dir, "verdicts.jsonl");
            const lines =
                batch
                    .map((r) => {
                        try {
                            return JSON.stringify(r);
                        } catch {
                            return null;
                        }
                    })
                    .filter(Boolean)
                    .join("\n") + (batch.length ? "\n" : "");
            if (lines) fs.appendFileSync(path.join(dir, "verdicts.jsonl"), lines);
            const now = _now();
            if (now - _diag.lastStatusWrite >= 2000) {
                _diag.lastStatusWrite = now;
                const status = {
                    updated: new Date(now).toISOString(),
                    pid: process.pid,
                    sessions: _sessions.size,
                    global_in_flight: _globalInFlight,
                    dropped_records: _diag.dropped,
                    totals: _diag.totals,
                };
                const s = JSON.stringify(status);
                if (s.length <= STATUS_MAX_BYTES) {
                    fs.writeFileSync(path.join(dir, "status.json"), s);
                }
            }
        } catch {
            _diag.dropped += batch.length; // best effort only
        }
        resolve();
    });
}

// baseRec — the common scrubbed diagnostic shape (no raw args, no outputs).
function baseRec(st, cfg, now) {
    return {
        t: new Date(now).toISOString(),
        session: st ? st.__pid || (st.__pid = shortId("sess:" + Math.random())) : null,
        // NOTE: session pseudonym is per-state-object random, not derived
        // from the real sessionID — deliberately uncorrelatable from logs.
        agent: st && st.agentName ? st.agentName : null,
        mode: null,
    };
}

// ---------------------------------------------------------------------------
// Attribution + mode resolution.
// ---------------------------------------------------------------------------

const ATTRIBUTION_FRESH_MS = 90 * 1000;

function resolveMode(st, cfg, now) {
    if (!needsAgentAttribution(cfg)) {
        // Wildcard-only config: the mode is unambiguous without attribution.
        return { mode: cfg.agents["*"], attributionOk: true, agentName: null };
    }
    const fresh =
        typeof st.agentName === "string" &&
        st.agentName.length > 0 &&
        now - st.agentBoundAt <= ATTRIBUTION_FRESH_MS;
    if (!fresh) {
        // Unknown attribution must not inherit another agent's enforce
        // setting: audit ceiling (records use the wildcard mode; canDeny=no).
        return { mode: cfg.agents["*"], attributionOk: false, agentName: st.agentName || null };
    }
    return {
        mode: resolveModeForAgent(cfg, st.agentName),
        attributionOk: true,
        agentName: st.agentName,
    };
}

// ---------------------------------------------------------------------------
// Bounded history enrichment (slow path only — never the <=5ms local path).
// ---------------------------------------------------------------------------

async function readHistory(client, sessionID, directory, limitMs) {
    if (!client || !client.session || typeof client.session.messages !== "function") {
        return null;
    }
    let timer = null;
    try {
        const cap = new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), limitMs);
        });
        // Path-key era tolerance (live-runtime finding, 2026-10-03): the SDK
        // renamed the messages path param `id` -> `sessionID` between
        // opencode 1.18.5 (refs) and 1.18.34 (installed). Each era's
        // serializer picks only its declared key and ignores the other, so
        // sending BOTH keeps enrichment working across the rename. A missing
        // key degrades to `/session/undefined/message` -> 404 -> silent
        // fail-open null (no outcomes, no attribution, mechanical never
        // fires) — the exact defect the real-runtime receipt surfaced.
        const r = await Promise.race([client.session.messages({
            path: { id: sessionID, sessionID },
            query: { directory, limit: 32 },
        }), cap]);
        if (r && r.error) return null; // degraded, not fatal
        return r && Array.isArray(r.data) ? r.data : null;
    } catch {
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// enrichFromHistory — fill missing ring outcomes by callID, refresh agent
// attribution from the most recent assistant message, and return the
// scrubbed last-assistant text excerpt (or null). Own denials are excluded
// from evidence by construction (classifyHistoryPart labels them).
function enrichFromHistory(st, messages, now) {
    let excerpt = null;
    if (!Array.isArray(messages) || messages.length === 0) return excerpt;
    const byCall = new Map();
    let agent = null;
    for (let mi = messages.length - 1; mi >= 0; mi--) {
        const msg = messages[mi];
        if (agent === null && msg && msg.role === "assistant" && typeof msg.agent === "string") {
            agent = msg.agent;
            if (Array.isArray(msg.parts)) {
                const texts = msg.parts
                    .filter((p) => p && p.type === "text" && typeof p.text === "string")
                    .map((p) => p.text)
                    .join(" ");
                if (texts.length > 0) excerpt = texts;
            }
        }
        if (Array.isArray(msg && msg.parts)) {
            for (const p of msg.parts) {
                if (p && p.type === "tool" && typeof p.callID === "string" && !byCall.has(p.callID)) {
                    byCall.set(p.callID, p);
                }
            }
        }
        if (agent !== null && byCall.size >= 64) break; // bounded walk
    }
    if (agent) {
        st.agentName = agent;
        st.agentBoundAt = now;
    }
    for (const obs of st.ring) {
        if (obs.outcome === null && !obs.ownDenial && !obs.exempt && !obs.unsupported) {
            const part = byCall.get(obs.callID);
            if (part) {
                const cls = classifyHistoryPart(part, st.ownDenied);
                if (cls) obs.outcome = cls;
            }
        }
    }
    return excerpt;
}

// ---------------------------------------------------------------------------
// Deny application — the ONLY throw site in the pack.
// ---------------------------------------------------------------------------

function leaseKey(rule, sig) {
    return rule + ":" + sig;
}

function createLease(st, rule, sig, cfg, now) {
    const leaseCfg = rule === "mechanical" ? cfg.mechanical : cfg.semantic;
    const lease = {
        rule,
        sig,
        expiresAt: now + leaseCfg.lease_seconds * 1000,
        hits: 1, // the arming denial consumed the first hit
        maxHits: leaseCfg.max_denials,
    };
    st.leases[leaseKey(rule, sig)] = lease;
    return lease;
}

function applyDeny({ st, cfg, canDeny, decision, obs, tool, sig, now, root, mode, agentName }) {
    // Leases and own-denial markers arm ONLY on ACTUAL denials (enforce).
    // Audit mode records would-deny and leaves no deny instrument behind —
    // flipping a session to enforce later cannot inherit audit-armed leases.
    let lease = null;
    let hitsLeft = 0;
    if (canDeny) {
        lease =
            decision.lease ||
            createLease(st, decision.rule, sig, cfg, now);
        if (decision.lease) leaseConsume(lease); // a live lease denying again
        hitsLeft = Math.max(0, lease.maxHits - lease.hits);
        // Own-denial bookkeeping: the denied call never becomes evidence and
        // does not accrue fresh spend.
        obs.ownDenial = true;
        st.ownDenied.add(obs.callID);
        st.spend.accrued = Math.max(0, st.spend.accrued - 1);
    } else if (decision.lease) {
        // Audit echo of a live lease: display-only, no consumption.
        lease = decision.lease;
        hitsLeft = Math.max(0, lease.maxHits - lease.hits);
    }
    const expiresAt = lease ? lease.expiresAt : now + 1000;
    const rule = decision.rule || (lease && lease.rule) || "unknown";
    const reason = buildDenyReason({
        tool,
        sigId: shortId(sig),
        rule,
        evidenceIds: decision.evidenceIds || [],
        expiresAt,
        hitsLeft,
    });
    diagRecord(root, {
        ...baseRec(st, cfg, now),
        kind: "deny",
        rule,
        action: canDeny ? "deny" : "would-deny",
        mode,
        sig: shortId(sig),
        evidence_ids: (decision.evidenceIds || []).map(String).slice(0, 8),
        lease_expires: new Date(expiresAt).toISOString(),
        lease_hits: lease ? lease.hits : 0,
        lease_max: lease ? lease.maxHits : 0,
        reason,
    });
    if (canDeny) {
        // THROW is the deny contract (shell-guard semantics, verified against
        // the installed runtime: the before-hook failure blocks item.execute
        // and the model sees this message as the tool error). Enforce only.
        throw new Error(reason);
    }
    // audit: record and allow — no throw, no lease, no own-denial marking
}

// ---------------------------------------------------------------------------
// The hook.
// ---------------------------------------------------------------------------

export const server = async ({ client, directory } = {}) => ({
    "tool.execute.before": async (input, output) => {
        // TOP-LEVEL FAIL-OPEN: any error anywhere -> allow (bare return).
        let root = null;
        try {
            const t0 = _now();
            root = repoRoot();
            // Dual-form judge wiring (operator decision 2026-10-05): fill the
            // literal judge target fields from the user-level
            // session-progress-llm.json (mtime-cached like the repo config;
            // per-field, a repo-config literal still wins). Env fallback
            // applies at judgeTarget time for any field neither supplies.
            const baseCfg = loadConfig(root);
            const cfg = mergeUserJudgeConfig(baseCfg, loadUserJudgeConfig(baseCfg));
            if (!cfg.enabled) return; // allow: kill switch

            const tool = input && typeof input.tool === "string" ? input.tool : null;
            const sessionID = input && typeof input.sessionID === "string" ? input.sessionID : null;
            const callID = input && typeof input.callID === "string" ? input.callID : null;
            if (!tool || !sessionID || !callID || !output || typeof output !== "object") {
                return; // allow: malformed hook input
            }
            const now = _now();
            const st = sessionState(sessionID, cfg, now);

            // (1) exact signature (or unsupported -> unenforceable, allowed)
            const args = output.args; // READ-ONLY: never mutated
            const sigRes = computeSignature(tool, args);
            const sig = sigRes.sig || null;

            // (2) polling exemption (exact grammar only)
            const exempt =
                tool === "bash" &&
                !!sig &&
                isPollingExemptCommand(args && args.command, cfg);

            // (3) attribution + effective mode — BEFORE recording: `off`
            // agents are not observed at all (unknown attribution: no deny).
            const { mode, attributionOk, agentName } = resolveMode(st, cfg, now);
            if (mode === "off") return; // allow: this agent is off
            const canDeny = mode === "enforce" && attributionOk;

            // (4) record the attempted observation (current call included)
            const obs = {
                seq: ++st.seq,
                callID,
                tool,
                sig,
                ts: now,
                exempt,
                unsupported: !!sigRes.unsupported,
                ownDenial: false,
                outcome: null,
            };
            st.ring.push(obs);
            st.ring = boundRing(st.ring, cfg.state.ring_entries, cfg.state.ring_bytes);
            if (exempt || obs.unsupported) {
                // Exempt/unsupported: allow, never deny, never accrue spend.
                return;
            }
            st.spend.accrued += 1;

            // (5) existing leases on this exact signature (prior policy
            // decisions — no new judge call). Both rules checked. A CAPPED
            // lease is RETAINED until expiry (it allows, but its window
            // still blocks re-arming); only an EXPIRED lease is forgotten.
            for (const rule of ["mechanical", "semantic"]) {
                const key = leaseKey(rule, sig);
                const lease = st.leases[key];
                const dec = leaseDecision(lease, now);
                if (dec.action === "expired") {
                    delete st.leases[key];
                    continue;
                }
                if (dec.action === "capped") {
                    continue; // deny-hit cap reached: allow, lease still arms
                }
                if (dec.action === "deny") {
                    applyDeny({
                        st, cfg, canDeny,
                        decision: { rule, lease, evidenceIds: [] },
                        obs, tool, sig, now, root, mode, agentName,
                    });
                    return; // audit path: would-deny recorded, allow
                }
            }

            // (6) mechanical fast path — local only, adapter-gated. An
            // existing (capped, unexpired) mechanical lease for this exact
            // signature suppresses a NEW lease: the deny-hit cap governs its
            // whole window, so fresh evidence cannot re-arm inside it.
            const mechBlocked = !!st.leases[leaseKey("mechanical", sig)];
            const mech = mechBlocked
                ? { fire: false, why: "lease-window" }
                : evaluateMechanical(st.ring, tool, sig, cfg, now);
            if (mech.fire) {
                applyDeny({
                    st, cfg, canDeny,
                    decision: { rule: "mechanical", evidenceIds: mech.evidenceIds },
                    obs, tool, sig, now, root, mode, agentName,
                });
                return; // audit path: allow
            }

            // (7) spend gate + busy slots -> allow when closed (cost control
            // only; NEVER a deny reason).
            if (mode !== "enforce" && mode !== "audit") return;
            if (!spendGateOpen(st, cfg, now)) {
                diagRecord(root, {
                    ...baseRec(st, cfg, now), kind: "skip", why: "spend-gate",
                    mode, sig: shortId(sig), accrued: st.spend.accrued,
                });
                return;
            }
            if (st.inFlight) {
                diagRecord(root, { ...baseRec(st, cfg, now), kind: "skip", why: "busy-session", mode });
                return;
            }
            if (_globalInFlight >= cfg.concurrency.global) {
                diagRecord(root, { ...baseRec(st, cfg, now), kind: "skip", why: "busy-global", mode });
                return;
            }

            // (8) ONE slow-path deadline: history enrich + judge + semantic
            // policy all share it. Consume cadence on the ATTEMPT.
            const deadlineAt = _now() + cfg.judge.timeout_ms;
            st.spend.lastAttempt = _now();
            st.spend.accrued = 0;
            st.inFlight = true;
            _globalInFlight += 1;
            let judgeCalled = false;
            try {
                const remaining = () => deadlineAt - _now();
                // F1: the history race must never overrun the shared
                // slow-path deadline. The old Math.max(25, ...) floor let
                // the race wait its 25 ms even when <=25 ms of budget
                // remained, returning AFTER the deadline (same invariant
                // family as the <=20000 ms pinned ceiling). No positive
                // budget -> skip enrichment entirely (fail-open null, allow
                // below); otherwise the race is capped at the ACTUAL
                // remaining budget — never beyond the deadline.
                const budget = remaining();
                const history = budget > 0
                    ? await readHistory(client, sessionID, directory, Math.max(0, budget))
                    : null;
                const enrichNow = _now();
                const excerpt = enrichFromHistory(st, history, enrichNow);

                // No judge call when the model is unavailable or the budget
                // is already gone — allow without spending.
                const target = judgeTarget(cfg, process.env);
                if (!target || remaining() <= 0) {
                    diagRecord(root, {
                        ...baseRec(st, cfg, enrichNow),
                        kind: "assessment",
                        judge: false,
                        why: !target ? "judge-unavailable" : "budget-exhausted",
                        mode, sig: shortId(sig),
                    });
                    return;
                }
                judgeCalled = true;
                const packet = buildJudgePacket({
                    ring: st.ring, tool, sig, now: enrichNow, agentName, assessmentId: shortId(sig) + "-" + enrichNow,
                });
                attachAssistantExcerpt(packet, excerpt || "");
                const r = await runJudge(cfg, packet, { env: process.env, now: _now, deadlineAt });
                if (r.status !== "verdict") {
                    diagRecord(root, {
                        ...baseRec(st, cfg, _now()),
                        kind: "assessment", judge: true,
                        why: r.status === "timeout" ? "judge-timeout" : `judge-${r.class || r.status}`,
                        mode, sig: shortId(sig),
                    });
                    return; // allow: timeout/error/malformed all fail open
                }
                const sem = evaluateSemantic(r.verdict, { ring: st.ring, sig, cfg, now: _now() });
                diagRecord(root, {
                    ...baseRec(st, cfg, _now()),
                    kind: "assessment",
                    judge: true,
                    verdict: r.verdict.verdict,
                    confidence: r.verdict.confidence,
                    why: sem.fire
                        ? st.leases[leaseKey("semantic", sig)]
                            ? "fired-but-lease-window"
                            : "denied"
                        : `no-deny:${sem.why}`,
                    mode, sig: shortId(sig),
                });
                if (sem.fire && !st.leases[leaseKey("semantic", sig)]) {
                    applyDeny({
                        st, cfg, canDeny,
                        decision: {
                            rule: "semantic",
                            evidenceIds: sem.evidenceIds.length ? sem.evidenceIds : sem.priorIds,
                        },
                        obs, tool, sig, now: _now(), root, mode, agentName,
                    });
                    return; // audit path: allow
                }
                return; // allow: verdict says not a loop
            } finally {
                st.inFlight = false;
                _globalInFlight -= 1;
                if (judgeCalled) {
                    diagRecord(root, {
                        ...baseRec(st, cfg, _now()),
                        kind: "assessment-latency",
                        latency_ms: _now() - t0,
                    });
                }
            }
        } catch (e) {
            // The deny throw is the ONLY error that escapes the policy
            // layer on purpose. Everything else is a fail-open.
            if (e && typeof e.message === "string" && e.message.startsWith(OWN_DENIAL_MARKER)) {
                throw e;
            }
            try {
                diagRecord(root || repoRoot(), {
                    ...baseRec(null, null, _now()),
                    kind: "internal-error",
                    error_class: (e && e.name) || "Error",
                    message: String((e && e.message) || e).slice(0, 200),
                });
            } catch {
                /* diagnostics must never break fail-open */
            }
            return; // allow
        }
    },
});

export const SessionProgressPlugin = server;

// ---------------------------------------------------------------------------
// Test seams — synthetic clock, state reset, state inspection. Test-only;
// no behavioral branch depends on these existing.
// ---------------------------------------------------------------------------

export const __test = {
    setNow(fn) {
        _now = typeof fn === "function" ? fn : () => Date.now();
    },
    resetState() {
        _sessions.clear();
        _globalInFlight = 0;
        _diag.queue.length = 0;
        _diag.writing = false;
        _diag.dropped = 0;
        _diag.lastStatusWrite = 0;
        _diag.totals = { records: 0, denied: 0, wouldDeny: 0, assessments: 0, judgeCalls: 0 };
    },
    sessions() {
        return _sessions;
    },
    globalInFlight() {
        return _globalInFlight;
    },
    diagStats() {
        return { ..._diag.totals, dropped: _diag.dropped, queued: _diag.queue.length };
    },
};

export default { id, server };
