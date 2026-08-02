package web

// Server-managed root-session labels (groups + tags) — Slice 2: the HTTP API.
//
// This slice exposes the Slice-1 LabelStore (pkg/web/labels.go, commit 24ecf6b)
// over HTTP with the exact contract the PinStore already has
// (pkg/web/pins_http.go):
//   - GET /vh/labels returns the public LabelsDoc.
//   - PUT /vh/labels (CSRF-guarded, baseRevision CAS) validates + normalizes +
//     atomically persists and returns the committed authority.
//   - Stale revision → 409 + authority body.
//   - Validation rejection (*LabelRejection) → 400 + structured body carrying
//     the rejection reason/ids AND the self-healed authority doc.
//
// No SSE fan-out in this slice (that is slice 3). handleLabels persists and
// returns authority only.
//
// LABELS CLONE THE PIN HTTP CONTRACT with ONE deliberate addition. Pins map a
// validation failure to a plain 400: the pin store normalizes silently and the
// HTTP layer does only light structural checks (empty/dupe/oversized ids), so
// pins emit a machine-readable 400 ONLY for the anti-resurrection case and
// return the authority body ONLY on the 409 path. Labels move ALL invariant
// validation into the store (slice 1), so EVERY store *LabelRejection is mapped
// to a machine-readable 400 that ALSO carries the authoritative current doc —
// the client adopts it (self-heal) in one round-trip on BOTH the 400 and 409
// paths. This is the documented "400 self-heal" addition vs pins.
//
// PUBLIC PROJECTION (honest deviation from pins): pins need a dedicated
// pinsPublicResp because PinsDoc carries the private projectBySessionId. Labels
// have NO private field in their public type — Snapshot() already returns
// LabelsDoc (revision, groups, tags, tagIdsByRootSessionId), which IS exactly
// the wire shape. So GET / PUT-200 / 409 marshal LabelsDoc directly, and the 400
// body embeds it. schemaVersion and projectByRootSessionId live only in the
// private labelsFile and never cross the wire (proven by the GET-shape test's
// byte-contains checks, mirroring the pins projectBySessionId-leak guard).

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// kindLabelsUpdated is the SSE event name for the transient labels fan-out frame
// (Slice 3), emitted after a committed PUT 200 and after lifecycle cleanup that
// changed the doc. The direct analogue of kindPinsUpdated (pkg/web/pins_http.go):
// it carries no `id:` line (writeRawNoID) so it never becomes a resume cursor —
// it is orthogonal to the state store's seq space, and a reconnecting client
// catches up via the labels.snapshot bootstrap frame emitted on connect.
const kindLabelsUpdated = "labels.updated"

// putLabelsReq is the PUT /vh/labels request body. BaseRevision is REQUIRED
// (nil → 400); it is the CAS guard the client read from its last GET/response.
// Revision is SERVER-OWNED and intentionally absent from the request — the
// server assigns it (base+1) on a successful Replace. The decoder is lenient on
// unknown fields (forward compatibility: a future client sending a new optional
// field must not get a 400), mirroring putPinsReq.
type putLabelsReq struct {
	BaseRevision          *int64              `json:"baseRevision"`
	Groups                []LabelGroup        `json:"groups"`
	Tags                  []LabelTag          `json:"tags"`
	TagIDsByRootSessionID map[string][]string `json:"tagIdsByRootSessionId"`
}

// labelsRejectionResp is the machine-readable 400 body emitted when PUT /vh/labels
// fails store validation (*LabelRejection). It carries the rejection metadata
// (error/message/ids) AND the self-healed authoritative current doc (embedded
// LabelsDoc) so the client adopts server state in one round-trip — the labels
// analogue of pins' 409-authority-body, extended to the 400 path because the
// label store is the single validation chokepoint.
//
// Contract (LOCKED):
//
//	{ "error": "<LabelRejectionReason>",
//	  "message": "<human-readable detail>",
//	  "ids": ["<offending ids>"],          // omitted when empty
//	  "revision": <int>,                    // promoted from embedded LabelsDoc
//	  "groups": [...],
//	  "tags": [...],
//	  "tagIdsByRootSessionId": {...} }
//
// Clients MUST adopt the promoted revision/groups/tags/tagIdsByRootSessionId as
// the new authority (self-heal); error/message/ids are for logging/display and
// optional bounded-retry logic (slice 4 facade).
type labelsRejectionResp struct {
	Error     string   `json:"error"`
	Message   string   `json:"message"`
	IDs       []string `json:"ids,omitempty"`
	LabelsDoc          // embedded → promotes revision/groups/tags/tagIdsByRootSessionId
}

// labelsRejectionRespFrom builds the structured 400 body from a store
// *LabelRejection and the authoritative current snapshot the failed Replace
// returned (cur is the current doc — nothing was persisted on rejection, so cur
// IS the self-healed authority the client should adopt).
func labelsRejectionRespFrom(rej *LabelRejection, cur LabelsDoc) labelsRejectionResp {
	return labelsRejectionResp{
		Error:     string(rej.Reason),
		Message:   rej.Detail,
		IDs:       rej.IDs,
		LabelsDoc: cur,
	}
}

// handleLabels serves GET (read) and PUT (compare-and-swap replace) for the
// worker-wide labels doc. Registered as a single path with a method switch
// (same convention as /vh/pins and /vh/notes). PUT is state-changing and is
// guarded by csrfGuard — the outer middleware wrapping every /vh/* route — so
// no per-handler CSRF check is needed (but the test suite verifies a headerless
// PUT is rejected, mirroring the pins CSRF test).
func (s *Server) handleLabels(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		// Per-project: resolve the store from reqDir(r). A nil store (unresolvable
		// project) yields an empty wire-shaped doc — the caller learns there are no
		// labels for this project rather than 500-ing.
		if st := s.labelsForDir(reqDir(r)); st != nil {
			writeJSONResp(w, st.Snapshot())
		} else {
			writeJSONResp(w, emptyLabelsDoc())
		}
	case http.MethodPut:
		s.handleLabelsPut(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleLabelsPut validates and applies a compare-and-swap replacement of the
// whole labels doc.
//
// Validation precedence (mirrors pins): the structural 400 checks (malformed
// JSON, missing baseRevision) run BEFORE the store call. The store then
// validates the candidate BEFORE the CAS check (slice-1 design: a malformed doc
// is always a clear *LabelRejection regardless of any revision race), so a
// structurally-invalid-but-stale-revision request yields a 400 (not a silent
// 409) — this ordering is pinned by TestLabelStoreReplaceStaleAndInvalid.
//
// On success → 200 + committed authority. On CAS mismatch → 409 + authority.
// On store validation rejection → 400 + structured body (rejection + authority).
// On persist failure → 500 (store stayed consistent with disk; the candidate was
// built separately and only assigned after a successful save).
func (s *Server) handleLabelsPut(w http.ResponseWriter, r *http.Request) {
	// 1. Parse body. Lenient on unknown fields (forward-compat); strict on
	//    malformed JSON. 1 MiB matches pins and dwarfs any realistic doc (50
	//    groups + 100 tags + UUID-keyed assignments).
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req putLabelsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body: "+err.Error(), http.StatusBadRequest)
		return
	}

	// 2. baseRevision is required (must be explicitly present, even for the
	//    initial empty doc). A *int64 distinguishes absent from explicit-0 (the
	//    legitimate initial CAS value).
	if req.BaseRevision == nil {
		http.Error(w, "baseRevision required", http.StatusBadRequest)
		return
	}

	// 3. Build the candidate. Revision is server-owned; the store ignores any
	//    candidate Revision and assigns base+1 on success. Nil slices/maps are
	//    normalized by the store's validateLabelsDoc, so a client omitting them
	//    is equivalent to sending empty collections.
	candidate := LabelsDoc{
		Groups:                req.Groups,
		Tags:                  req.Tags,
		TagIDsByRootSessionID: req.TagIDsByRootSessionID,
	}

	dir := reqDir(r)
	// 4. Build the authoritative active-ROOT inventory (root id → project key)
	//    for THIS project only, then resolve the per-project store, Replace
	//    (validate → normalize → CAS → atomic persist). Replace returns the
	//    current snapshot on every non-success path (rejection, CAS mismatch),
	//    which is the self-healed authority the client adopts.
	//
	//    Per-project isolation: a PUT for project A validates against A's active
	//    roots only and writes A's store only. The store is resolved via
	//    labelsForDir(dir); a nil store (unresolvable project) maps to 500 — a
	//    mutation cannot land for a project we cannot identify.
	activeRootProjects := s.activeRootProjectsForDir(dir)
	st := s.labelsForDir(dir)
	if st == nil {
		http.Error(w, "labels: project directory not resolvable", http.StatusBadRequest)
		return
	}
	ok, cur, err := st.Replace(*req.BaseRevision, candidate, activeRootProjects)
	if err != nil {
		var rej *LabelRejection
		if errors.As(err, &rej) {
			// Store validation rejection → 400 with structured body + authority.
			// The client adopts the embedded doc (self-heal) and may use
			// error/ids for a bounded retry or display.
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(labelsRejectionRespFrom(rej, cur))
			return
		}
		// Persist failure — surface as 500; the client may retry with the same
		// baseRevision (the doc did not advance).
		vhlog.Error("labels: persist failed", "err", err)
		http.Error(w, "labels persist failed", http.StatusInternalServerError)
		return
	}
	if !ok {
		// CAS mismatch — return the full current public doc so the client can
		// adopt server state and retry. Do NOT partially apply. (Mirrors pins.)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(cur)
		return
	}
	// Success — committed authority (same shape as GET). Fan the new doc out to
	// THIS project's live subscribers ONLY (per-project: a label mutation in
	// project A must not reach project B's stream) BEFORE writing the HTTP
	// response, so a concurrent SSE listener observes the update no later than
	// the PUT caller receives its 200 (mirrors pins' handlePinsPut ordering).
	// cur is the post-write snapshot returned by Replace, so this emits
	// committed state without an extra Snapshot() read. Transient (not
	// replayed); reconnect catches up via the labels.snapshot bootstrap frame.
	s.fanOutLabelsUpdate(dir, cur)
	writeJSONResp(w, cur)
}

// activeRootProjectsForDir builds the activeRootProjects map argument for
// LabelStore.Replace for a SINGLE project (dir). Each active ROOT session id
// (one whose parentID == "", per Store.RootInventory().IsRoot — the STRICT root
// definition labels require, NOT the orphan-inclusive RootCount) is mapped to
// this project's stable key (projectKey(projectRoot(dir)) — the SAME
// sha1-of-abs-cwd key pkg/web/notes.go and pins.go use, so the cleanup sidecar
// and projectByRootSessionId agree on project identity).
//
// Per-project isolation: this replaces the former worker-wide activeRootProjects
// (which aggregated roots across ALL of s.aggs). A PUT for project A now
// validates only against A's live roots, so a root reference from another
// project cannot leak into A's doc, and a stale cross-project ref cannot
// survive. This is the labels analogue of the per-dir narrowing the per-project
// cutover requires; the ONLY difference from the former global builder is the
// single-project scope.
//
// Uses aggForExisting(dir) — it does NOT open a project. A PUT for an unopened
// project yields an empty inventory, so every newly-referenced root fails the
// store's unknown_root check (fail-closed): labels cannot reference roots the
// server is not tracking for that project. A dir whose projectRoot fails to
// resolve returns nil (same fail-closed behavior).
func (s *Server) activeRootProjectsForDir(dir string) map[string]string {
	root, err := projectRoot(dir)
	if err != nil {
		vhlog.Warn("labels: skipping project in active-root map (projectRoot failed)", "dir", dir, "err", err)
		return nil
	}
	key := projectKey(root)
	a := s.aggForExisting(dir)
	if a == nil {
		return nil
	}
	out := map[string]string{}
	for _, inv := range a.Store().RootInventory() {
		if inv.IsRoot {
			out[inv.SessionID] = key
		}
	}
	return out
}
