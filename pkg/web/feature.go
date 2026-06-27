package web

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// Feature module mechanism (B). A Feature is a self-contained capability that
// registers HTTP routes on the worker server without core having to know about
// it. The server walks its feature registry at startup and mounts each one. The
// coordination verbs (V2) are the first feature (dogfood). Features expose
// mechanism only — no consumer policy.
//
// Boundary: a Feature receives a narrow Services value — read the materialized
// store and resolve the per-directory aggregator (which exposes the opencode
// write client), plus the shared idempotency helper. It gets NO access to the
// tunnel, auth internals, or another feature's state.

// Services is the narrow shared surface handed to each Feature.
type Services struct {
	// Agg resolves the aggregator for a project dir ("" = default). Through it a
	// feature reads the store (Store()) and writes via opencode (Client()).
	Agg func(dir string) *aggregator.Aggregator
	// ReqDir extracts the requested project dir from a request (?dir= / header).
	ReqDir func(*http.Request) string
	// idem backs WithIdempotency; not exported so a feature must go through the
	// helper (consistent replay/in-flight semantics).
	idem *idemCache
}

// WithIdempotency runs fn unless the idempotency key replays a prior response (or
// a concurrent duplicate is in flight → 409). With an empty key, fn runs plainly.
// fn returns (status, jsonBody, outcome). outcome is the fresh result
// classification (see the Outcome* constants in verbs.go) a caller parsing the
// JSON body uses for its accounting. On replay, a success-class fresh outcome
// (created / prompt_retried_to_existing) is rewritten to "reused" in the cached
// body, so a body-only caller sees the non-counting replay signal without
// inspecting headers. The X-VH-Idempotent-Replay header is preserved (backward
// compat). This is the one write-safety primitive a feature needs; the CAS lives
// in the verb that wants it (via Agg(...).Store()).
func (svc Services) WithIdempotency(w http.ResponseWriter, key string, fn func() (int, []byte, string)) {
	if key == "" {
		st, b, _ := fn()
		writeJSON(w, st, b)
		return
	}
	entry, replay, inflight := svc.idem.begin(key)
	if replay {
		w.Header().Set("X-VH-Idempotent-Replay", "1")
		writeJSON(w, entry.status, rewriteOutcomeReused(entry.body, entry.outcome))
		return
	}
	if inflight {
		http.Error(w, "idempotency_key already in progress", http.StatusConflict)
		return
	}
	st, b, oc := fn()
	svc.idem.finish(key, st, b, oc)
	writeJSON(w, st, b)
}

// rewriteOutcomeReused rewrites the cached body's "outcome" field to "reused" for
// success-class fresh outcomes (created / prompt_retried_to_existing) — the side
// effect they describe already happened and is being re-reported, so a body-only
// caller sees the non-counting replay signal. Terminal outcomes (failed / refused)
// and bodies without an outcome field are returned verbatim: a replayed failure
// stays a failure (the retryable signal is preserved).
func rewriteOutcomeReused(body []byte, freshOutcome string) []byte {
	if freshOutcome != OutcomeCreated && freshOutcome != OutcomePromptRetried {
		return body
	}
	var m map[string]any
	if json.Unmarshal(body, &m) != nil {
		return body
	}
	m["outcome"] = OutcomeReused
	out, err := json.Marshal(m)
	if err != nil {
		return body
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// Feature is a registerable capability module.
type Feature interface {
	Name() string
	// Routes returns full-path patterns → handlers to mount on the server mux.
	Routes(Services) map[string]http.HandlerFunc
}

// defaultFeatures are the built-in modules every server mounts. Part A's verbs
// dogfood the mechanism as the first feature.
func defaultFeatures() []Feature {
	return []Feature{coordinationFeature{}}
}

// services builds the Services value passed to features.
func (s *Server) services() Services {
	return Services{Agg: s.aggFor, ReqDir: reqDir, idem: s.idem}
}

// mountFeatures registers every feature's routes on the mux.
func (s *Server) mountFeatures(mux *http.ServeMux) {
	svc := s.services()
	for _, f := range s.features {
		for pattern, h := range f.Routes(svc) {
			mux.HandleFunc(pattern, h)
		}
	}
}

// --- idempotency cache (shared infra used via Services.WithIdempotency) ---

// idemCache is a small TTL cache of completed verb responses keyed by the
// caller's idempotency_key, plus an in-flight guard so concurrent duplicates of
// the same key can't double-execute the side effect. Generic; no domain logic.
type idemCache struct {
	mu       sync.Mutex
	done     map[string]idemEntry
	inflight map[string]bool
	ttl      time.Duration
}

type idemEntry struct {
	status  int
	body    []byte
	outcome string
	at      time.Time
}

func newIdemCache(ttl time.Duration) *idemCache {
	return &idemCache{done: map[string]idemEntry{}, inflight: map[string]bool{}, ttl: ttl}
}

func (c *idemCache) begin(key string) (entry idemEntry, replay bool, inflight bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.done[key]; ok && time.Since(e.at) < c.ttl {
		return e, true, false
	}
	if c.inflight[key] {
		return idemEntry{}, false, true
	}
	c.inflight[key] = true
	return idemEntry{}, false, false
}

func (c *idemCache) finish(key string, status int, body []byte, outcome string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.inflight, key)
	c.done[key] = idemEntry{status: status, body: body, outcome: outcome, at: time.Now()}
	for k, e := range c.done {
		if time.Since(e.at) >= c.ttl {
			delete(c.done, k)
		}
	}
}

// --- small shared helpers used by feature handlers ---

func jsonBytes(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func errResp(msg string) []byte { return jsonBytes(map[string]any{"ok": false, "error": msg}) }

// errRespOutcome is errResp with a result outcome classification, used by verbs
// that tag their failures (spawn/send → "failed").
func errRespOutcome(msg, outcome string) []byte {
	return jsonBytes(map[string]any{"ok": false, "error": msg, "outcome": outcome})
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

func orNull(b []byte) []byte {
	if len(b) == 0 {
		return []byte("null")
	}
	return b
}
