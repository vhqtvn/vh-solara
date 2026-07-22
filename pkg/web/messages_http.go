package web

// HTTP handler for the historical-message-page endpoint. This is the
// transcript-windowing structural fix's "load older" path: a client that has
// received the bounded initial window (Phase 1) paginates OLDER messages on
// demand via this GET, prepending each page below the resident tail.
//
// Route (registered in server.go Handler() via Go 1.22 method patterns):
//
//	GET /vh/session/{sessionId}/messages?before=<id>&limit=&max_bytes=
//
// Contract (SETTLED — Contract B, server conditional-freshness):
//   - GET-only → csrfGuard exempts it (CSRF defense applies to unsafe methods).
//   - Read-only: NO new server state, NO SSE event fan-out, NO messages.batch /
//     messages.loaded emission — neither in the HTTP response NOR as a side
//     effect. The response is a one-shot JSON envelope (MessagePageResult) the
//     client merges by id. The handler does NOT call EnsureMessages: doing so
//     would (a) trigger cold-load SSE publication on a not-yet-hydrated session
//     (violating the no-side-effect contract), and (b) bump s.seq between the
//     stampMeta X-VH-Seq capture (request entry) and SnapshotMessagesPage's
//     baseline_seq capture, giving the client two inconsistent freshness
//     cursors. Instead, hydration is the Stream2 subscription's responsibility
//     (the cold-load fires when the client subscribes, before any page request
//     is issued). If the session is not yet hydrated when a page is requested,
//     the store returns an empty page (boundary_found=false); the client
//     retries after its SSE initial window lands.
//   - `before` is REQUIRED. The page is INCLUSIVE of `before` as a one-item
//     overlap (robust dedup) + strictly-older messages, dual-bounded by
//     (limit, max_bytes). See pkg/state.store.go projectMessagePage.
//   - stampMeta middleware stamps X-VH-Seq + X-VH-Epoch on every /vh/* response
//     — the client validates these against its connection cursor (Phase 4
//     dirty-flag discard + bounded retry).
//
// Project is resolved via ?dir= / x-opencode-directory (reqDir → aggFor), the
// same as every other /vh/* handler. The session id is sanitized with safeID
// before store use (same as attachments + queue).

import (
	"encoding/json"
	"net/http"
	"strconv"

	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// handleSessionMessages serves a single historical-message page for a session.
// See messages_http.go file doc for the full contract.
func (s *Server) handleSessionMessages(w http.ResponseWriter, r *http.Request) {
	w = diag.NewHandlerBytesWriter(w, diag.ProxyPathMessages) // PROBE 8: attribute non-stream tunnel bytes
	sid := safeID.ReplaceAllString(r.PathValue("sessionId"), "")
	if sid == "" {
		http.Error(w, "session required", http.StatusBadRequest)
		return
	}
	before := r.URL.Query().Get("before")
	if before == "" {
		// `before` is REQUIRED: the initial window (Phase 1 Snapshot +
		// cold-load messages.batch) is the documented source of the first
		// cursor (the resident oldest_loaded_id). An empty cursor here is a
		// client bug or a stale-cache fetch — surface it rather than
		// silently returning the newest tail (which would conflate this
		// endpoint with the snapshot path).
		http.Error(w, "before cursor required", http.StatusBadRequest)
		return
	}
	// limit / max_bytes are optional and clamped to the package defaults. The
	// upper bound is the cold-window default (state.WindowMaxCount /
	// state.WindowMaxBytes): a single page must not exceed the initial
	// window's footprint, so a runaway client parameter cannot reintroduce
	// the whole-transcript snapshot/OOM the slice is fixing. Values above
	// the ceiling are clamped down to the ceiling (not rejected); invalid /
	// missing values fall back to the default.
	limit := state.WindowMaxCount
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = n
			if limit > state.WindowMaxCount {
				limit = state.WindowMaxCount
			}
		}
	}
	maxBytes := state.WindowMaxBytes
	if mb := r.URL.Query().Get("max_bytes"); mb != "" {
		if n, err := strconv.Atoi(mb); err == nil && n > 0 {
			maxBytes = n
			if maxBytes > state.WindowMaxBytes {
				maxBytes = state.WindowMaxBytes
			}
		}
	}

	dir := reqDir(r)
	agg := s.aggFor(dir)
	// NOTE: deliberately NOT calling EnsureMessages here. The handler is a
	// pure point-in-time read; hydration is the Stream2 subscription's job
	// (the cold-load fires when the client subscribes, before any page
	// request). Calling EnsureMessages would (a) publish messages.batch /
	// messages.loaded SSE events on a cold session (violating the no-side-
	// effect contract), and (b) bump s.seq between the X-VH-Seq header
	// stamp (request entry) and the baseline_seq capture below, giving the
	// client inconsistent freshness cursors. If the session is not yet
	// hydrated, SnapshotMessagesPage returns an empty page
	// (boundary_found=false); the client retries after its initial window.

	res := agg.Store().SnapshotMessagesPage(sid, before, limit, maxBytes)
	res.ProjectID = dir

	b, err := json.Marshal(res)
	if err != nil {
		// MessagePageResult is a well-typed struct, so this cannot fail today;
		// but a silent discard would mask a future regression. Surface it as a
		// 500 instead of writing a nil slice (which would emit "null").
		http.Error(w, "messages page marshal failed", http.StatusInternalServerError)
		return
	}
	// gzip64-wrap on the same opt-in (z=1) + threshold as handleSnapshot. A
	// historical page can be large (up to the window budget), and the same
	// tunnel-agnostic application-level compression applies: the controller
	// raw-proxies the body verbatim and the client decodes unconditionally.
	// A client that did not opt in (no z=1) gets the raw JSON unchanged.
	w.Header().Set("Content-Type", "application/json")
	w.Write(maybeCompressSnapshot(b, wantsCompress(r)))
}
