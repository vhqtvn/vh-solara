package web

// The create-certainty protocol (Slice 1: worker contract only — the SPA
// client lifecycle is Slice 2). Three routes, registered through the
// coordination feature (verbs.go) and mounted by the existing feature
// mechanism — server.go's route assembly is untouched.
//
//   GET  /vh/session/create/capabilities
//        Non-mutating capability read (GET → CSRF-exempt, auth-gated like
//        every /vh/* route). 200 with Cache-Control: no-store and body
//        {"protocol":"vh-session-create","version":1,"recovery_only":true}.
//        recovery_only:true is the promise that the receipt route below never
//        executes a create — a client may rely on polling it for recovery
//        without duplicate-create risk (within the cache-honesty limits below).
//
//   POST /vh/session/create
//        Body {"idempotency_key":"<opaque>"} — the key is REQUIRED. v1 accepts
//        NO create parameters: prompt, parts, title, parentID, agent, model,
//        permission_policy and every unknown field are REJECTED 400 BEFORE any
//        upstream invocation — and before the directory's aggregator is
//        resolved at all: for a novel ?dir= that resolution would create+start
//        an aggregator, open the managed project, and launch its Run loop, so
//        no refusal path may perform it (fail-closed against accidental spawn
//        semantics). The directory is captured per request (?dir= /
//        x-opencode-directory), and the cache key is namespaced by protocol +
//        resolved directory + opaque key — a key used on /vh/spawn or under
//        another directory never collides. The aggregator is resolved exactly
//        ONCE, only on the admitted fresh-claim path, immediately before the
//        upstream create.
//
//   GET  /vh/session/create/receipt?key=<opaque>[&dir=…]
//        RECOVERY-ONLY lookup under the captured project directory. It NEVER
//        invokes the aggregator, NEVER calls OpenCode, and NEVER falls through
//        to execute on a miss. A miss (absent/expired/replaced entry) is an
//        honest 404 — the single most important invariant of this protocol,
//        deliberately different from WithIdempotency's execute-on-miss.
//
// ── Receipt envelope (both POST and GET; protocol/version/state/replayed are
//    ALWAYS present) ─────────────────────────────────────────────────────────
//
//    state      HTTP   sessionID   meaning
//    created    200    non-empty   upstream create proven; the id is validated
//    in_flight  409    —           key claimed, upstream create still running
//    rejected   400    —           proven BEFORE upstream (validation or an
//                                  identity conflict): nothing was created
//    unknown    202    —           upstream outcome uncertain (transport
//                                  error, timeout, non-2xx, or 2xx without a
//                                  usable id). NEVER fabricates an id.
//    unavailable 404   —           no receipt: absent, expired, or evicted
//
//    409 discrimination is by the structured `code` field: "in_flight" versus
//    "idempotency_conflict" (a completed entry exists for the key but is
//    payload-bound to a different normalized create payload — rejected without
//    execution; forward-safety for a future v2 that adds create parameters).
//
// ── Marker semantics ────────────────────────────────────────────────────────
//
//    Every mutating response carries replayed:false (fresh) or replayed:true
//    (a cached receipt re-reported). The X-VH-Idempotent-Replay header is
//    DELIBERATELY NOT set on these routes: the body boolean is the only replay
//    marker (a missing marker on a mutating response is a protocol anomaly,
//    never permission to fall back to /oc/session — Slice 2's client contract).
//
// ── Claim, execution, and cancellation ownership ────────────────────────────
//
//    The key is claimed atomically BEFORE the upstream call; concurrent
//    same-key POSTs get 409 in_flight. An admitted create runs under a
//    SERVER-OWNED context — detached from the browser's request context (a
//    client disconnect never aborts the upstream create) and bounded by an
//    explicit 30s timeout, itself bounded by the server's shutdown context.
//    The cache is finished on EVERY bounded outcome, so a create that
//    outlives its requester still lands a receipt the recovery lookup finds.
//
// ── HONEST idemCache tradeoff (read before relying on recovery) ────────────
//
//    Receipts live in the SAME in-memory idemCache as the spawn/send
//    idempotency entries: memory-only, expiring 10 minutes after completion,
//    and lost entirely on worker-daemon restart. This is strictly weaker than
//    the durable queue receipts elsewhere in the worker. It is adequate for
//    the normal seconds-wide browser-response-loss window ONLY because lookup
//    misses are safe (this route never executes on a miss) and unknown
//    outcomes stay honestly unknown. It is NOT exactly-once creation across
//    restart or expiry, NOT a durable browser outbox, and NOT proof against
//    upstream commit-without-id. POST remains execute-on-miss like any
//    idempotent verb: a same-key POST after the entry expired WILL execute
//    again — that is inherent, which is why the client contract (Slice 2)
//    forbids re-POSTing an ambiguous operation and routes recovery through
//    the receipt GET exclusively.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

// sessionCreateProtocol / sessionCreateVersion identify the wire contract.
const (
	sessionCreateProtocol = "vh-session-create"
	sessionCreateVersion  = 1
)

// Receipt state vocabulary (see the file-level contract for semantics).
const (
	sessionCreateStateCreated     = "created"
	sessionCreateStateInFlight    = "in_flight"
	sessionCreateStateRejected    = "rejected"
	sessionCreateStateUnknown     = "unknown"
	sessionCreateStateUnavailable = "unavailable"
)

// sessionCreateCodeInFlight / sessionCreateCodeConflict are the structured 409
// codes distinguishing the two Conflict statuses.
const (
	sessionCreateCodeInFlight = "in_flight"
	sessionCreateCodeConflict = "idempotency_conflict"
)

// sessionCreateTimeout bounds the server-owned upstream create. A var (not a
// const) so tests can shorten it; production never reassigns it. Mirrors the
// typed client's own 30s HTTP timeout (pkg/opencode client construction).
var sessionCreateTimeout = 30 * time.Second

// sessionCreatePayloadV1 is the normalized admissible create payload for
// protocol v1 — empty create parameters. Every accepted POST normalizes to
// exactly this string, so receipts are payload-bound to it; when a future
// version adds parameters this constant (and the strict decode) grow
// together, and old keys bound to "{}" will conflict rather than silently
// re-execute under different semantics.
const sessionCreatePayloadV1 = "{}"

// sessionCreateCacheKey namespaces a create-protocol receipt key by protocol
// and resolved project directory, so the SAME opaque key used on /vh/spawn
// (raw key) or under another directory cannot collide with this entry.
func sessionCreateCacheKey(dir, key string) string {
	return sessionCreateProtocol + "\x00" + dir + "\x00" + key
}

// sessionCreateResp is the uniform receipt envelope.
type sessionCreateResp struct {
	Protocol  string `json:"protocol"`
	Version   int    `json:"version"`
	State     string `json:"state"`
	Replayed  bool   `json:"replayed"`
	SessionID string `json:"sessionID,omitempty"`
	Code      string `json:"code,omitempty"`
	Error     string `json:"error,omitempty"`
}

type sessionCreateHandlers struct{ svc Services }

// capabilities serves the non-mutating capability read (see file contract).
func (h sessionCreateHandlers) capabilities(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, jsonBytes(map[string]any{
		"protocol":      sessionCreateProtocol,
		"version":       sessionCreateVersion,
		"recovery_only": true,
	}))
}

// create executes the idempotent session-create. See the file-level contract
// for the full envelope. Ordering: Phase 1 (malformed body, missing key →
// UNCLAIMED 400, still first — an unidentifiable request claims nothing);
// Phase 2 strict admissibility (unsupported parameters → 400) runs BEFORE the
// cache is consulted, so no receipt ever answers for an inadmissible body. An
// inadmissible body on a FRESH key claims and caches the rejection receipt (a
// lookup then shows the key was proven never to reach upstream); on a key
// already holding a receipt — or in flight — it is a pure boundary refusal
// that disturbs nothing. Only then do the in-flight/conflict/replay cache
// branches and the upstream execution run, for admissible bodies only. The
// aggregator is resolved (Agg(dir)) ONLY after a fresh ADMISSIBLE claim
// succeeds — immediately before the upstream create — because for a novel
// dir that call creates+starts an aggregator, opens the managed project, and
// launches RunManaged: every earlier exit must answer with zero external
// runtime activity.
func (h sessionCreateHandlers) create(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, jsonBytes(sessionCreateResp{
			Protocol: sessionCreateProtocol, Version: sessionCreateVersion,
			State: sessionCreateStateRejected, Error: "unreadable body: " + err.Error(),
		}))
		return
	}
	// Phase 1 (lenient): extract the key only. Malformed JSON or a missing key
	// cannot identify an operation, so there is nothing to claim — plain 400.
	var keyOnly struct {
		IdempotencyKey string `json:"idempotency_key"`
	}
	if err := json.Unmarshal(raw, &keyOnly); err != nil {
		writeJSON(w, http.StatusBadRequest, jsonBytes(sessionCreateResp{
			Protocol: sessionCreateProtocol, Version: sessionCreateVersion,
			State: sessionCreateStateRejected, Error: "invalid JSON body: " + err.Error(),
		}))
		return
	}
	if keyOnly.IdempotencyKey == "" {
		writeJSON(w, http.StatusBadRequest, jsonBytes(sessionCreateResp{
			Protocol: sessionCreateProtocol, Version: sessionCreateVersion,
			State: sessionCreateStateRejected, Error: "idempotency_key required",
		}))
		return
	}

	// Resolve the directory and derive the namespaced cache key — PURE string
	// work: no aggregator, no project open, no upstream contact. Every refusal
	// below must answer BEFORE any external runtime activity, and Agg(dir) for
	// a novel dir is exactly that activity (create+start aggregator,
	// managed-project open, RunManaged launch), so the aggregator itself is
	// resolved only on the admitted path (see below).
	dir := h.svc.ReqDir(r)
	cacheKey := sessionCreateCacheKey(dir, keyOnly.IdempotencyKey)

	// Phase 2 (strict) runs BEFORE the cache is consulted: v1 admissibility is
	// a property of the REQUEST, so no completed receipt — created, unknown,
	// or rejected — may answer for an inadmissible body. The decode itself is
	// pure: nothing is claimed or mutated until it passes.
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var strict struct {
		IdempotencyKey string `json:"idempotency_key"`
	}
	if err := dec.Decode(&strict); err != nil {
		body := jsonBytes(sessionCreateResp{
			Protocol: sessionCreateProtocol, Version: sessionCreateVersion,
			State: sessionCreateStateRejected,
			Error: "unsupported create parameter (protocol v1 accepts idempotency_key only): " + err.Error(),
		})
		// A FRESH key mints the CACHED rejection receipt exactly as the
		// claim-then-validate design always did — a later lookup proves
		// nothing reached upstream, and a same-key retry deterministically
		// replays the rejection (a corrected attempt must mint a new key;
		// Slice 2's client contract). Rejection receipts are payload-UNBOUND
		// ("" — they replay verbatim for any ADMISSIBLE body shape). But a
		// key that already holds a completed receipt (replay/conflict) or is
		// in flight is refused at the boundary WITHOUT disturbing it: the
		// refusal writes no state and never overwrites the existing entry.
		_, replay, conflict, inflight := h.svc.idem.beginBound(cacheKey, sessionCreatePayloadV1)
		if !replay && !conflict && !inflight {
			h.svc.idem.finishPayload(cacheKey, "", http.StatusBadRequest, body, "")
		}
		writeJSON(w, http.StatusBadRequest, body)
		return
	}

	entry, replay, conflict, inflight := h.svc.idem.beginBound(cacheKey, sessionCreatePayloadV1)
	if inflight {
		writeJSON(w, http.StatusConflict, jsonBytes(sessionCreateResp{
			Protocol: sessionCreateProtocol, Version: sessionCreateVersion,
			State: sessionCreateStateInFlight, Code: sessionCreateCodeInFlight,
		}))
		return
	}
	if conflict {
		writeJSON(w, http.StatusConflict, jsonBytes(sessionCreateResp{
			Protocol: sessionCreateProtocol, Version: sessionCreateVersion,
			State: sessionCreateStateRejected, Code: sessionCreateCodeConflict,
			Error: "idempotency_key is already bound to a different create payload",
		}))
		return
	}
	if replay {
		writeJSON(w, entry.status, sessionCreateReplayed(entry.body))
		return
	}

	// Admitted — a fresh ADMISSIBLE claim, the only path that may touch the
	// directory's runtime. Snapshot the aggregator ONCE, immediately before
	// the upstream create, bound to the SAME dir string resolved above (claim
	// and execution cannot diverge even if the request's dir header were
	// somehow re-read later). No refusal above — malformed, inadmissible,
	// in-flight, conflict, replay — has resolved it.
	agg := h.svc.Agg(dir)

	// Server-owned context: browser cancellation never aborts the
	// upstream create; the explicit timeout bounds it; the shutdown context
	// (nil-safe) lets Server.Shutdown retire it with the daemon.
	ctx := context.Background()
	if h.svc.ShutdownCtx != nil {
		ctx = h.svc.ShutdownCtx
	}
	ctx, cancel := context.WithTimeout(ctx, sessionCreateTimeout)
	defer cancel()

	sessRaw, err := agg.Client().CreateSession(ctx, json.RawMessage(sessionCreatePayloadV1))
	if err != nil {
		// A transport/upstream failure CANNOT prove no session was created
		// (commit-without-response is exactly the loss this protocol models),
		// so it is cached and reported as unknown — never as a safe rejection,
		// and never with a fabricated id.
		body := jsonBytes(sessionCreateResp{
			Protocol: sessionCreateProtocol, Version: sessionCreateVersion,
			State: sessionCreateStateUnknown,
			Error: "create outcome uncertain: " + err.Error(),
		})
		h.svc.idem.finishPayload(cacheKey, sessionCreatePayloadV1, http.StatusAccepted, body, "")
		writeJSON(w, http.StatusAccepted, body)
		return
	}
	var sess struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(sessRaw, &sess)
	if sess.ID == "" {
		// 2xx without a usable id is the same ambiguity class (E5): unknown.
		body := jsonBytes(sessionCreateResp{
			Protocol: sessionCreateProtocol, Version: sessionCreateVersion,
			State: sessionCreateStateUnknown,
			Error: "create outcome uncertain: upstream response carried no session id",
		})
		h.svc.idem.finishPayload(cacheKey, sessionCreatePayloadV1, http.StatusAccepted, body, "")
		writeJSON(w, http.StatusAccepted, body)
		return
	}
	body := jsonBytes(sessionCreateResp{
		Protocol: sessionCreateProtocol, Version: sessionCreateVersion,
		State: sessionCreateStateCreated, SessionID: sess.ID,
	})
	h.svc.idem.finishPayload(cacheKey, sessionCreatePayloadV1, http.StatusOK, body, "")
	writeJSON(w, http.StatusOK, body)
}

// receipt is the recovery-only lookup. THE GATE: it must cause ZERO creates —
// no aggregator call, no upstream fetch, no execute-on-miss, ever.
func (h sessionCreateHandlers) receipt(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	key := r.URL.Query().Get("key")
	if key == "" {
		writeJSON(w, http.StatusBadRequest, jsonBytes(sessionCreateResp{
			Protocol: sessionCreateProtocol, Version: sessionCreateVersion,
			State: sessionCreateStateRejected, Error: "key required",
		}))
		return
	}
	cacheKey := sessionCreateCacheKey(h.svc.ReqDir(r), key)
	entry, found, inflight := h.svc.idem.lookup(cacheKey)
	if inflight {
		writeJSON(w, http.StatusConflict, jsonBytes(sessionCreateResp{
			Protocol: sessionCreateProtocol, Version: sessionCreateVersion,
			State: sessionCreateStateInFlight, Code: sessionCreateCodeInFlight,
		}))
		return
	}
	if !found {
		writeJSON(w, http.StatusNotFound, jsonBytes(sessionCreateResp{
			Protocol: sessionCreateProtocol, Version: sessionCreateVersion,
			State: sessionCreateStateUnavailable,
		}))
		return
	}
	writeJSON(w, entry.status, sessionCreateReplayed(entry.body))
}

// sessionCreateReplayed re-renders a cached receipt body with replayed:true.
// The cached body is always this package's own sessionCreateResp JSON, so the
// round-trip is lossless; on an unexpected decode failure the cached bytes are
// returned verbatim (never an invented envelope).
func sessionCreateReplayed(body []byte) []byte {
	var resp sessionCreateResp
	if err := json.Unmarshal(body, &resp); err != nil {
		return body
	}
	resp.Replayed = true
	return jsonBytes(resp)
}
