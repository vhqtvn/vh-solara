package web

// Server-managed tab-only named layouts — worker-scoped v1: the HTTP API.
//
// GET  /vh/layouts → layoutsPublicResp {revision, entries:[…]} (entries sorted
//                   by name for a deterministic wire shape; never nil).
// PUT  /vh/layouts → PER-ENTRY upsert. The body carries exactly ONE entry plus
//                   the REQUIRED baseRevision CAS guard:
//
//                     { "baseRevision": <int64>,
//                       "entry": { "scope":"tab", "name":…, "tabTitle":…,
//                                  "layout":{…}, "savedAt":<ms> } }
//
//                   This per-entry granularity is PINNED by the task card's F3
//                   envelope (task-2026-09-17t20-32-39): a whole-catalog
//                   replace is a design violation and this handler does not
//                   accept one. Responses: 200 with the full committed public
//                   doc, 409 (CAS mismatch) with the CURRENT public doc in the
//                   body (same shape as pins), 400 machine-readable for any
//                   validation failure, 500 on persist failure.
//
// NO SSE FAN-OUT (v1, pinned by the card): unlike pins there is no
// FanOutPinsUpdate analog and no layouts.updated frame. Clients converge by
// refetching GET /vh/layouts (revision is CAS-only; it is never an ordering
// or sequencing authority).
//
// Strict-input contract (mirrors pins_http.go): the HTTP layer REJECTS what a
// lenient client might send — wrong scope, untrimmed/empty/oversized name or
// tabTitle, negative savedAt, non-object or oversized layout — with a
// MACHINE-READABLE JSON 400 {error, message} rather than coercing. The
// trimming the TypeScript client performs client-side
// (host-web/src/dockview/namedLayouts.ts caps NAMED_LAYOUT_NAME_MAX=60 and
// TAB_TITLE_MAX=80) is NOT re-done server-side: the server requires the
// already-normalized form so the stored bytes are exactly what the client
// validated. (tabTitle's client-side empty→name fallback is likewise a
// client concern; an empty tabTitle here is a 400.)

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// maxLayoutNameLen mirrors NAMED_LAYOUT_NAME_MAX in
// host-web/src/dockview/namedLayouts.ts. The TS client trims and caps before
// sending; the server requires the normalized form (non-empty, ≤ this many
// chars, no surrounding whitespace).
const maxLayoutNameLen = 60

// maxLayoutTabTitleLen mirrors TAB_TITLE_MAX in
// host-web/src/dockview/namedLayouts.ts (the client's empty-fallback-to-name
// happens before sending; the server requires a non-empty normalized title).
const maxLayoutTabTitleLen = 80

// maxLayoutJSONBytes caps a single entry's serialized layout payload. A
// fractional dockview layout is a few KiB in practice; 256 KiB is a generous
// ceiling that bounds the catalog file (≤100 entries × 256 KiB ≈ 25 MiB
// worst case) while accepting any realistic document. BYTE-based on purpose
// (stored-bytes semantics): it bounds the STORED entry size on the raw
// undecoded-interior bytes of the Layout field, checked POST-decode — the
// outer PUT json.Decode in handleNamedLayoutsPut has already copied Layout
// as a json.RawMessage by the time validateTabLayoutEntry measures it. The
// request-level allocation bound is the 1 MiB http.MaxBytesReader wrapped
// around r.Body in handleNamedLayoutsPut.
const maxLayoutJSONBytes = 256 << 10

// layoutsScopeTab is the only entry scope accepted in v1. The TS side models
// a "master" scope too; it is explicitly out of server scope for v1.
const layoutsScopeTab = "tab"

// layoutsPublicResp is the wire shape for GET /vh/layouts and the
// success/conflict body of PUT /vh/layouts. It deliberately OMITS
// schemaVersion (internal persistence detail, same policy as pins). Entries
// is sorted by name for a deterministic wire shape and is always non-nil (at
// least []).
type layoutsPublicResp struct {
	Revision int64            `json:"revision"`
	Entries  []TabLayoutEntry `json:"entries"`
}

// layoutsPublicRespFromDoc derives the wire response from a full
// NamedLayoutsDoc, sorting entries by name and guaranteeing a non-nil slice.
func layoutsPublicRespFromDoc(doc NamedLayoutsDoc) layoutsPublicResp {
	out := layoutsPublicResp{
		Revision: doc.Revision,
		Entries:  make([]TabLayoutEntry, 0, len(doc.Entries)),
	}
	names := make([]string, 0, len(doc.Entries))
	for k := range doc.Entries {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, n := range names {
		out.Entries = append(out.Entries, doc.Entries[n])
	}
	return out
}

// putLayoutsReq is the PUT /vh/layouts request body. BaseRevision is REQUIRED
// (nil → 400); it is the CAS guard value the client read from its last
// GET/response. Entry is REQUIRED (nil → 400) and carries exactly ONE layout
// entry — per-entry granularity is the pinned contract. The decoder is
// lenient on unknown fields (forward compatibility, same policy as pins).
type putLayoutsReq struct {
	BaseRevision *int64          `json:"baseRevision"`
	Entry        *TabLayoutEntry `json:"entry"`
}

// layoutErrResp is the MACHINE-READABLE error body for PUT /vh/layouts 400s:
// {error: "<stable code>", message: "<human-readable>"}. Error codes are a
// stable contract for the host-web client (phases 3-4): invalid_body,
// missing_base_revision, missing_entry, invalid_scope, invalid_name,
// invalid_tab_title, invalid_saved_at, invalid_layout, layout_too_large,
// catalog_full.
type layoutErrResp struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

// writeLayoutsErr emits a machine-readable JSON error with the given status.
func writeLayoutsErr(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(layoutErrResp{Error: code, Message: message})
}

// handleNamedLayouts serves GET (read) and PUT (per-entry CAS upsert) for the
// worker-wide named-layouts catalog. Registered as a single path with a method
// switch (same convention as /vh/pins and /vh/notes). PUT is state-changing
// and is guarded by csrfGuard — the outer middleware wrapping every /vh/*
// route — so no per-handler CSRF check is needed.
func (s *Server) handleNamedLayouts(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSONResp(w, layoutsPublicRespFromDoc(s.namedLayouts.Snapshot()))
	case http.MethodPut:
		s.handleNamedLayoutsPut(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// validateTabLayoutEntry checks the strict-input contract for one entry.
// Returns the stable error code + message for the first violation, or "".
// Input must be the ALREADY-NORMALIZED client form (the TS client trims and
// caps before sending); the server does not coerce.
func validateTabLayoutEntry(e *TabLayoutEntry) (code, message string) {
	if e.Scope != layoutsScopeTab {
		return "invalid_scope", `entry.scope must be exactly "tab" (v1)`
	}
	if e.Name == "" {
		return "invalid_name", "entry.name must be non-empty (trim client-side before sending)"
	}
	if utf8.RuneCountInString(e.Name) > maxLayoutNameLen {
		return "invalid_name", "entry.name exceeds the 60-char cap"
	}
	if e.Name != strings.TrimSpace(e.Name) {
		return "invalid_name", "entry.name must be pre-trimmed (no surrounding whitespace)"
	}
	if e.TabTitle == "" {
		return "invalid_tab_title", "entry.tabTitle must be non-empty (apply the client-side name fallback before sending)"
	}
	if utf8.RuneCountInString(e.TabTitle) > maxLayoutTabTitleLen {
		return "invalid_tab_title", "entry.tabTitle exceeds the 80-char cap"
	}
	if e.TabTitle != strings.TrimSpace(e.TabTitle) {
		return "invalid_tab_title", "entry.tabTitle must be pre-trimmed (no surrounding whitespace)"
	}
	if e.SavedAt < 0 {
		return "invalid_saved_at", "entry.savedAt must be a non-negative epoch-milliseconds value"
	}
	trimmed := bytes.TrimSpace(e.Layout)
	if len(trimmed) == 0 || trimmed[0] != '{' || trimmed[len(trimmed)-1] != '}' {
		return "invalid_layout", "entry.layout must be a non-empty JSON object"
	}
	if len(e.Layout) > maxLayoutJSONBytes {
		return "layout_too_large", "entry.layout exceeds the 256 KiB cap"
	}
	return "", ""
}

// handleNamedLayoutsPut validates and applies a per-entry compare-and-swap
// upsert. Validation precedence: ALL 400 (malformed input) checks run BEFORE
// the CAS check (409). A malformed request is always rejected regardless of
// server state; only a well-formed request reaches the CAS guard.
func (s *Server) handleNamedLayoutsPut(w http.ResponseWriter, r *http.Request) {
	// 1. Parse body. Lenient on unknown fields (forward-compat); strict on
	//    malformed JSON. 1 MiB is the same request cap as pins; it also
	//    comfortably bounds the 256 KiB max layout + envelope.
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req putLayoutsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeLayoutsErr(w, http.StatusBadRequest, "invalid_body", "invalid JSON body: "+err.Error())
		return
	}

	// 2. baseRevision is required — a *int64 distinguishes absent from
	//    explicit-0 (the legitimate initial CAS value).
	if req.BaseRevision == nil {
		writeLayoutsErr(w, http.StatusBadRequest, "missing_base_revision", "baseRevision is required (the CAS guard value from your last GET)")
		return
	}

	// 3. entry is required — exactly ONE entry per PUT (pinned per-entry
	//    granularity; there is no whole-catalog form).
	if req.Entry == nil {
		writeLayoutsErr(w, http.StatusBadRequest, "missing_entry", "entry is required (exactly one entry per PUT)")
		return
	}

	// 4. Strict per-entry validation (BEFORE the CAS guard, per the
	//    validation-precedence contract).
	if code, message := validateTabLayoutEntry(req.Entry); code != "" {
		writeLayoutsErr(w, http.StatusBadRequest, code, message)
		return
	}

	// 5. Apply via the store's CAS-guarded upsert.
	ok, cur, err := s.namedLayouts.Upsert(*req.BaseRevision, *req.Entry)
	if err != nil {
		if errors.Is(err, ErrNamedLayoutsCatalogFull) {
			// The catalog is at its cap and this would be a NEW name. The
			// request is well-formed but not acceptable: reject with a
			// machine-readable 400 so the client can prompt for an overwrite
			// or delete. (Not a 409: the server state did not change and the
			// CAS value is not the problem.)
			writeLayoutsErr(w, http.StatusBadRequest, "catalog_full", "the named-layout catalog is full (100 entries); overwrite an existing name or delete one first")
			return
		}
		// Persist failure — the store stayed consistent with disk
		// (candidate-then-save). Surface as 500; the client may retry with
		// the same baseRevision (the doc did not advance).
		vhlog.Error("named-layouts: persist failed", "err", err)
		http.Error(w, "named-layouts persist failed", http.StatusInternalServerError)
		return
	}
	if !ok {
		// CAS mismatch — return the full current public doc so the client
		// can adopt server state and retry. Do NOT partially apply.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(layoutsPublicRespFromDoc(cur))
		return
	}
	// Success — full committed public doc (same shape as GET). NO fan-out:
	// v1 has no layouts.updated SSE frame (pinned by the card); clients
	// converge by refetching.
	writeJSONResp(w, layoutsPublicRespFromDoc(cur))
}
