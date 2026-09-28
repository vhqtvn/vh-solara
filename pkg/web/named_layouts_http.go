package web

// Server-managed named layouts (tab + master scopes), worker-scoped v1: the
// HTTP API.
//
// GET  /vh/layouts → layoutsPublicResp {revision, entries:[…]} (entries sorted
//                   by name for a deterministic wire shape; never nil; each
//                   entry is the tab or the master variant per its scope).
// PUT  /vh/layouts → PER-ENTRY upsert. The body carries exactly ONE entry plus
//                   the REQUIRED baseRevision CAS guard:
//
//                     { "baseRevision": <int64>,
//                       "entry": { "scope":"tab", "name":…, "tabTitle":…,
//                                  "layout":{…}, "savedAt":<ms> }
//                       — or the master variant —
//                       "entry": { "scope":"master", "name":…,
//                                  "session":{ "activeWorkspaceName":…|null,
//                                              "workspaces":[{"name":…,
//                                                              "layout":{…}}] },
//                                  "savedAt":<ms> } }
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
// lenient client might send — wrong scope, untrimmed/empty/oversized name,
// tabTitle or workspace name, negative savedAt, non-object or oversized
// layouts, a missing/empty/malformed master session, or a scope's payload
// fields on the other scope's entry — with a MACHINE-READABLE JSON 400
// {error, message} rather than coercing. A malformed entry NEVER enters the
// store. The trimming the TypeScript client performs client-side
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

// maxLayoutJSONBytes caps a single entry's serialized layout payload (a tab
// entry's layout OR one master-session workspace's layout). A fractional
// dockview layout is a few KiB in practice; 256 KiB is a generous ceiling
// that bounds the catalog file (≤100 entries × 256 KiB ≈ 25 MiB worst case)
// while accepting any realistic document. BYTE-based on purpose
// (stored-bytes semantics): it bounds the STORED entry size on the raw
// undecoded-interior bytes of a Layout field, checked POST-decode — the
// outer PUT json.Decode in handleNamedLayoutsPut has already copied Layout
// as a json.RawMessage by the time validateLayoutBytes measures it. The
// request-level allocation bound is the 1 MiB http.MaxBytesReader wrapped
// around r.Body in handleNamedLayoutsPut.
const maxLayoutJSONBytes = 256 << 10

// layoutsScopeTab and layoutsScopeMaster are the two accepted entry scopes
// (the TS union NamedLayoutEntry discriminates on the same values). The
// name namespace spans BOTH: an upsert of a name replaces the entry whatever
// its scope — the HTTP upsert and the store are scope-blind beyond entry
// validation.
const (
	layoutsScopeTab    = "tab"
	layoutsScopeMaster = "master"
)

// maxLayoutWorkspaceNameLen caps a master session's workspace names (and the
// active-workspace name) in RUNES. It mirrors the workspace-name UI bound
// (maxlength=80 on the tabstrip rename input; TAB_TITLE_MAX applies the same
// 80 for the same reason — the value becomes a workspace name on load).
const maxLayoutWorkspaceNameLen = 80

// maxMasterSessionWorkspaces bounds a master session's workspace count. Real
// sessions are single-digit; 100 is generously above that (same scale as
// maxNamedLayouts) while keeping a poison session from storing tens of
// thousands of entries inside one catalog row (the 1 MiB request cap bounds
// bytes, not element count).
const maxMasterSessionWorkspaces = 100

// layoutsPublicResp is the wire shape for GET /vh/layouts and the
// success/conflict body of PUT /vh/layouts. It deliberately OMITS
// schemaVersion (internal persistence detail, same policy as pins). Entries
// is sorted by name for a deterministic wire shape and is always non-nil (at
// least []); each entry is the TAB variant ({scope,name,tabTitle,layout,
// savedAt}) or the MASTER variant ({scope,name,session,savedAt}) per its
// scope — the same discrimination the TS NamedLayoutEntry union applies.
type layoutsPublicResp struct {
	Revision int64              `json:"revision"`
	Entries  []NamedLayoutEntry `json:"entries"`
}

// layoutsPublicRespFromDoc derives the wire response from a full
// NamedLayoutsDoc, sorting entries by name and guaranteeing a non-nil slice.
func layoutsPublicRespFromDoc(doc NamedLayoutsDoc) layoutsPublicResp {
	out := layoutsPublicResp{
		Revision: doc.Revision,
		Entries:  make([]NamedLayoutEntry, 0, len(doc.Entries)),
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
	BaseRevision *int64            `json:"baseRevision"`
	Entry        *NamedLayoutEntry `json:"entry"`
}

// layoutErrResp is the MACHINE-READABLE error body for PUT /vh/layouts 400s:
// {error: "<stable code>", message: "<human-readable>"}. Error codes are a
// stable contract for the host-web client: invalid_body,
// missing_base_revision, missing_entry, invalid_scope, invalid_name,
// invalid_tab_title, invalid_session, invalid_saved_at, invalid_layout,
// layout_too_large, catalog_full.
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

// validateNamedLayoutEntry checks the strict-input contract for one entry of
// EITHER scope. Returns the stable error code + message for the first
// violation, or "". Input must be the ALREADY-NORMALIZED client form (the TS
// client trims and caps before sending); the server does not coerce.
//
// Scope-discriminated fields: a TAB entry must carry tabTitle + a top-level
// layout and NO session; a MASTER entry must carry session and NEITHER
// tabTitle nor a top-level layout (its layouts live in session.workspaces,
// each under the SAME opacity/size caps as a tab layout). Carrying the other
// scope's payload field is a 400, not an ignore — the wire shapes stay
// exactly the TS variants'.
func validateNamedLayoutEntry(e *NamedLayoutEntry) (code, message string) {
	if e.Scope != layoutsScopeTab && e.Scope != layoutsScopeMaster {
		return "invalid_scope", `entry.scope must be exactly "tab" or "master"`
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
	if e.SavedAt < 0 {
		return "invalid_saved_at", "entry.savedAt must be a non-negative epoch-milliseconds value"
	}
	if e.Scope == layoutsScopeTab {
		if e.TabTitle == "" {
			return "invalid_tab_title", "entry.tabTitle must be non-empty (apply the client-side name fallback before sending)"
		}
		if utf8.RuneCountInString(e.TabTitle) > maxLayoutTabTitleLen {
			return "invalid_tab_title", "entry.tabTitle exceeds the 80-char cap"
		}
		if e.TabTitle != strings.TrimSpace(e.TabTitle) {
			return "invalid_tab_title", "entry.tabTitle must be pre-trimmed (no surrounding whitespace)"
		}
		if e.Session != nil {
			return "invalid_session", `entry.session must be absent for scope "tab"`
		}
		return validateLayoutBytes(e.Layout)
	}
	// Scope "master".
	if e.TabTitle != "" {
		return "invalid_tab_title", `entry.tabTitle must be empty for scope "master" (the session carries the workspaces)`
	}
	if len(bytes.TrimSpace(e.Layout)) != 0 {
		return "invalid_layout", `entry.layout must be absent for scope "master" (layouts live in session.workspaces)`
	}
	return validateMasterSession(e.Session)
}

// validateLayoutBytes applies the tab-layout opacity/size contract to one
// opaque serialized dockview document: a non-empty JSON object within the
// 256 KiB stored-bytes cap (BYTE-based on purpose — see maxLayoutJSONBytes).
func validateLayoutBytes(layout json.RawMessage) (code, message string) {
	trimmed := bytes.TrimSpace(layout)
	if len(trimmed) == 0 || trimmed[0] != '{' || trimmed[len(trimmed)-1] != '}' {
		return "invalid_layout", "layout must be a non-empty JSON object"
	}
	if len(layout) > maxLayoutJSONBytes {
		return "layout_too_large", "layout exceeds the 256 KiB cap"
	}
	return "", ""
}

// validateMasterSession applies the strict-input contract to a master
// entry's session payload: present, a non-empty bounded workspaces array of
// {name, layout} (names non-empty ≤80 runes; layouts under the SAME
// opacity/size caps as tab layouts), and activeWorkspaceName JSON-null or a
// bounded string (it only selects which workspace activates on load — an
// unmatched name falls back to the first workspace, so emptiness is
// tolerated but the length is still capped to bound the stored doc).
func validateMasterSession(s *NamedMasterSession) (code, message string) {
	if s == nil {
		return "invalid_session", `entry.session is required for scope "master"`
	}
	if s.ActiveWorkspaceName != nil && utf8.RuneCountInString(*s.ActiveWorkspaceName) > maxLayoutWorkspaceNameLen {
		return "invalid_session", "session.activeWorkspaceName exceeds the 80-char cap"
	}
	if len(s.Workspaces) == 0 {
		return "invalid_session", "session.workspaces must be a non-empty array"
	}
	if len(s.Workspaces) > maxMasterSessionWorkspaces {
		return "invalid_session", "session.workspaces exceeds the 100-workspace cap"
	}
	for i := range s.Workspaces {
		w := &s.Workspaces[i]
		if w.Name == "" {
			return "invalid_name", "session.workspaces[].name must be non-empty"
		}
		if utf8.RuneCountInString(w.Name) > maxLayoutWorkspaceNameLen {
			return "invalid_name", "session.workspaces[].name exceeds the 80-char cap"
		}
		if code, message := validateLayoutBytes(w.Layout); code != "" {
			return code, message
		}
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
	if code, message := validateNamedLayoutEntry(req.Entry); code != "" {
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
