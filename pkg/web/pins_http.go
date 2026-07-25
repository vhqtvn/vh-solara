package web

// Server-managed pinned sessions — Phase 2 (HTTP API) + Phase 3 (SSE fan-out).
//
// Phase 2 (commit abc3351) added GET/PUT /vh/pins handlers, the
// active-session-projects builder (the authoritative active-session set across
// all s.aggs), and the strict input-validation helpers. It wired the PinStore
// into the Server struct (server.go: NewServer constructs it once at startup
// from filepath.Join(stateBaseDir(), "pins.json")).
//
// Phase 3 (this slice) adds the worker-wide broadcast after a committed PUT:
// FanOutPinsUpdate fans the committed public doc to EVERY s.aggs project store's
// live subscribers via state.Store.EmitTransient(kindPinsUpdated, …), and the
// live-tail loop in server.go forwards it as a transient `pins.updated` SSE
// frame (no id line, not replayed — reconnecting clients catch up via the
// pins.snapshot bootstrap frame also added in Phase 3).
//
// Non-goals (later phases): handleArchive cleanup hook + session.delete
// subscriber + reconcile backstop (Phase 4); web/UI stream.ts listener (Phases
// 5-6).
//
// Public wire shape: GET and PUT-200/409 responses share pinsPublicResp, which
// OMITS projectBySessionId (that is internal cleanup metadata — Phase 1's
// PinsDoc carries it, but the HTTP response must not leak it).
// orderedSessionIds is always a non-nil slice (at least []).
//
// Strict-input contract: the HTTP layer REJECTS what Phase 1's store would
// silently normalize — empty IDs, duplicates, and an oversized list all return
// 400 instead of being coerced. The client gets a clear error rather than a
// silently-different result. This is the intentional difference between the
// permissive store API (used by future internal callers like the cleanup
// sidecar) and the strict external HTTP boundary.

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/state"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// maxPinIDLen caps the length of a single session ID accepted by PUT /vh/pins.
// OpenCode session IDs are UUIDs (36 chars); 256 is a generous ceiling that
// accepts any plausible ID format while rejecting pathological/abusive input
// before it reaches the store. Documented for clients; enforced in handlePinsPut.
const maxPinIDLen = 256

// kindPinsUpdated is the SSE event name carried on the wire for a transient
// pin-mutation fan-out (Phase 3). It is pushed via state.Store.EmitTransient,
// which carries it as ClientEvent.Kind; the live-tail loop in handleStream
// forwards it with this exact string as the SSE `event:` name (no id line, not
// replayed). Phase 5's stream.ts listener dispatches on addEventListener(name).
// A distinct name (rather than a notice sub-kind) keeps it cleanly separable
// from the established "notice" channel on the wire.
const kindPinsUpdated = "pins.updated"

// pinsPublicResp is the wire shape for GET /vh/pins and the success/conflict
// body of PUT /vh/pins. It deliberately OMITS projectBySessionId (internal
// cleanup metadata). OrderedSessionIDs is always non-nil (at least []).
type pinsPublicResp struct {
	Revision          int64    `json:"revision"`
	Initialized       bool     `json:"initialized"`
	OrderedSessionIDs []string `json:"orderedSessionIds"`
}

// pinsPublicRespFromDoc derives the wire response from a full PinsDoc, dropping
// projectBySessionId and guaranteeing a non-nil slice.
func pinsPublicRespFromDoc(doc PinsDoc) pinsPublicResp {
	ids := doc.OrderedSessionIDs
	if ids == nil {
		ids = []string{}
	}
	return pinsPublicResp{
		Revision:          doc.Revision,
		Initialized:       doc.Initialized,
		OrderedSessionIDs: ids,
	}
}

// putPinsReq is the PUT /vh/pins request body. BaseRevision is REQUIRED (nil →
// 400); it is the CAS guard value the client read from its last GET/response.
// InitializeOnly selects the init-guard form (succeeds only on an
// uninitialized doc). MigrationID is advisory client idempotency metadata —
// accepted and ignored in this slice (no idempotency store is built; a future
// slice may wire it into s.idem if cross-request dedup is needed).
type putPinsReq struct {
	BaseRevision      *int64   `json:"baseRevision"`
	OrderedSessionIDs []string `json:"orderedSessionIds"`
	InitializeOnly    bool     `json:"initializeOnly,omitempty"`
	MigrationID       string   `json:"migrationId,omitempty"`
}

// handlePins serves GET (read) and PUT (compare-and-swap replace) for the
// worker-wide pinned-sessions doc. Registered as a single path with a method
// switch (same convention as /vh/notes). PUT is state-changing and is guarded
// by csrfGuard — the outer middleware wrapping every /vh/* route — so no
// per-handler CSRF check is needed.
func (s *Server) handlePins(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSONResp(w, pinsPublicRespFromDoc(s.pins.Snapshot()))
	case http.MethodPut:
		s.handlePinsPut(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handlePinsPut validates and applies a compare-and-swap replacement of the
// pinned-sessions order.
//
// Validation precedence: all 400 (malformed input) checks run BEFORE the
// CAS/init-mismatch check (409). A malformed request is always rejected
// regardless of server state; only a well-formed request reaches the CAS guard.
//
// Anti-resurrection: only IDs NOT already in the current server doc are
// validated against the active-session set. Retained IDs are preserved
// as-is (a retained pin whose owning project is currently unopened must
// survive — its session is absent from every active set but the pin is
// already established).
func (s *Server) handlePinsPut(w http.ResponseWriter, r *http.Request) {
	// 1. Parse body. Lenient on unknown fields (forward-compat: a future client
	//    sending a new optional field must not get a 400); strict on malformed
	//    JSON. 1 MiB is far beyond any realistic 50-ID payload.
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req putPinsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body: "+err.Error(), http.StatusBadRequest)
		return
	}

	// 2. baseRevision is required (must be explicitly present, even for
	//    initializeOnly). A *int64 distinguishes absent from explicit-0 (the
	//    legitimate initial CAS value).
	if req.BaseRevision == nil {
		http.Error(w, "baseRevision required", http.StatusBadRequest)
		return
	}

	// 3. Per-item validation (strict input): non-empty, length-bounded, no
	//    duplicates. Phase 1's store would silently drop empties and dedupe;
	//    the HTTP layer rejects them so the client gets a clear error.
	seen := make(map[string]bool, len(req.OrderedSessionIDs))
	for _, id := range req.OrderedSessionIDs {
		if id == "" {
			http.Error(w, "orderedSessionIds contains an empty id", http.StatusBadRequest)
			return
		}
		if len(id) > maxPinIDLen {
			http.Error(w, "orderedSessionIds contains an id exceeding "+strconv.Itoa(maxPinIDLen)+" chars", http.StatusBadRequest)
			return
		}
		if seen[id] {
			http.Error(w, "orderedSessionIds contains a duplicate id: "+id, http.StatusBadRequest)
			return
		}
		seen[id] = true
	}
	// Total count cap (consistent with Phase 1's maxPinnedSessions). After the
	// dupe check above, len == unique count.
	if len(req.OrderedSessionIDs) > maxPinnedSessions {
		http.Error(w, "orderedSessionIds exceeds the "+strconv.Itoa(maxPinnedSessions)+" pinned-session cap", http.StatusBadRequest)
		return
	}

	// 4. Anti-resurrection validation. Every newly-added ID (not already in
	//    the current server doc) must be present in the worker's authoritative
	//    active-session set. Retained IDs are NOT re-validated.
	currentDoc := s.pins.Snapshot()
	retained := make(map[string]bool, len(currentDoc.OrderedSessionIDs))
	for _, id := range currentDoc.OrderedSessionIDs {
		retained[id] = true
	}
	activeProjects := s.activeSessionProjects()
	for _, id := range req.OrderedSessionIDs {
		if retained[id] {
			continue
		}
		if _, ok := activeProjects[id]; !ok {
			http.Error(w, "unknown session id (not active on this worker): "+id, http.StatusBadRequest)
			return
		}
	}

	// 5. advisory migrationId — accepted, not stored (no idempotency store in
	//    this slice). Logged at debug so a client can confirm receipt without
	//    polluting normal logs.
	if req.MigrationID != "" {
		vhlog.Debug("pins: migrationId received", "id", req.MigrationID)
	}

	// 6. Apply via Phase 1's Replace (CAS-guarded, atomically persisted).
	ok, cur, err := s.pins.Replace(*req.BaseRevision, req.OrderedSessionIDs, activeProjects, req.InitializeOnly)
	if err != nil {
		// Persist failure — the store stayed consistent with disk (Phase 1
		// builds the candidate separately and only assigns after a successful
		// save). Surface as 500; the client may retry with the same
		// baseRevision (the doc did not advance).
		vhlog.Error("pins: persist failed", "err", err)
		http.Error(w, "pins persist failed", http.StatusInternalServerError)
		return
	}
	if !ok {
		// CAS/init mismatch — return the full current public doc so the client
		// can adopt server state and retry. Do NOT partially apply.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(pinsPublicRespFromDoc(cur))
		return
	}
	// Success — full committed public doc (same shape as GET). Fan out the
	// committed state to ALL project stores' live subscribers BEFORE writing
	// the HTTP response, so a concurrent SSE listener observes the update no
	// later than the PUT caller receives its 200. cur is the post-write
	// snapshot returned by Replace, so this emits committed state without an
	// extra Snapshot() read. Transient (not replayed); reconnect catches up
	// via the pins.snapshot bootstrap frame.
	s.FanOutPinsUpdate(cur)
	writeJSONResp(w, pinsPublicRespFromDoc(cur))
}

// activeSessionProjects builds the activeSessionProjects map argument for
// PinStore.Replace from the current authoritative session state across ALL of
// the worker's project aggregators (s.aggs). Each active session ID is mapped
// to its stable project key (projectKey(projectRoot(dir)) — the SAME
// sha1-of-absolute-cwd key pkg/web/notes.go uses, so the cleanup sidecar and
// projectBySessionId agree on project identity).
//
// This map is ALSO the authoritative active-session set for anti-resurrection
// validation: a newly-added pin ID must be a key in this map (or already
// retained in the pin doc).
//
// Concurrency mirrors handleProjects/handleRunningSessions: s.aggMu is held
// only to snapshot the dir→aggregator entries; each aggregator's Store is then
// read under its own RLock via SessionIDs(). A dir whose projectRoot fails to
// resolve (effectively never — os.Getwd/filepath.Abs failure) is skipped with a
// log, so sessions from an unresolvable project are absent from the map
// (newly-added IDs from that project fail anti-resurrection — the safe,
// fail-closed behavior).
func (s *Server) activeSessionProjects() map[string]string {
	type entry struct {
		dir string
		agg *aggregator.Aggregator
	}
	s.aggMu.Lock()
	live := make([]entry, 0, len(s.aggs))
	for dir, a := range s.aggs {
		live = append(live, entry{dir, a})
	}
	s.aggMu.Unlock()

	out := map[string]string{}
	for _, e := range live {
		root, err := projectRoot(e.dir)
		if err != nil {
			vhlog.Warn("pins: skipping project in active-session map (projectRoot failed)", "dir", e.dir, "err", err)
			continue
		}
		key := projectKey(root)
		for _, sid := range e.agg.Store().SessionIDs() {
			out[sid] = key
		}
	}
	return out
}

// FanOutPinsUpdate pushes a transient pins.updated full-state frame carrying the
// committed pin doc to the LIVE subscribers of EVERY active project store
// (s.aggs). Pins are worker-wide, but /vh/stream is backed by PER-PROJECT
// state.Store instances — a pin mutation that happened while the operator was
// viewing project A must still reach a subscriber currently on project B's
// stream, so the fan-out iterates every aggregator's store, not just the
// default/active one. Mirrors the activeSessionProjects/handleProjects pattern:
// s.aggMu is held only to snapshot the dir→aggregator entries; each store's
// EmitTransient is then called outside the lock.
//
// The payload is marshaled ONCE (the public projection, identical to the GET /
// PUT-200 body) and reused for every store — EmitTransient does not mutate it.
// EmitTransient (pkg/state) pushes a transient event: it is NOT recorded to the
// replay ring and does NOT advance seq, so a reconnecting client never replays
// it (the pins.snapshot bootstrap frame in handleStream is the catch-up). Safe
// to call from any goroutine (the PUT handler's success path).
func (s *Server) FanOutPinsUpdate(doc PinsDoc) {
	raw, err := json.Marshal(pinsPublicRespFromDoc(doc))
	if err != nil {
		// Cannot fail for a well-typed pinsPublicResp today; log and skip the
		// fan-out rather than emitting a nil/"null" frame. The PUT still
		// returned 200 + the committed doc to the caller — only the live
		// notification is lost (clients self-correct on next GET/reconnect).
		vhlog.Warn("pins.updated fan-out: marshal failed, skipping broadcast", "err", err)
		return
	}
	// Snapshot s.aggs under aggMu, then emit outside the lock so a slow
	// EmitTransient cannot extend the critical section. Only the store is
	// needed (the fan-out is worker-wide, not per-dir). aggMu acquisition
	// matches handleProjects/activeSessionProjects even though the test
	// fixtures mutate s.aggs without the lock (FanOutPinsUpdate is the only
	// production caller of the locked read).
	s.aggMu.Lock()
	live := make([]*state.Store, 0, len(s.aggs))
	for _, a := range s.aggs {
		live = append(live, a.Store())
	}
	s.aggMu.Unlock()
	for _, st := range live {
		st.EmitTransient(kindPinsUpdated, raw)
	}
}
