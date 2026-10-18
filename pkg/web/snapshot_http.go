// Snapshot HTTP handlers, moved verbatim from server.go (slice 12 of the
// server.go split): the one-shot GET /vh/snapshot path (handleSnapshot) and
// its helpers — messageFilter (sessions query-param parsing, nil-vs-empty
// distinction), projectScopedFilter (project-isolation guard at the HTTP
// boundary), ensureMessages (synchronous lazy hydration for the one-shot GET)
// and triggerMessageLoad (non-blocking counterpart for the stream first-open
// path, see stream_http.go handleStream), plus handleAck (POST /vh/ack unread
// clear). Routes are registered in server.go (Handler).
package web

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// messageFilter parses the `sessions` query param into a Snapshot filter:
//   - "all"          -> nil   (all sessions' messages)
//   - absent/empty   -> {}    (no messages; tree-only)
//   - "a,b,c"        -> {a,b,c}
func messageFilter(r *http.Request) map[string]bool {
	q := r.URL.Query().Get("sessions")
	if q == "all" {
		return nil
	}
	filter := map[string]bool{}
	for _, id := range strings.Split(q, ",") {
		if id = strings.TrimSpace(id); id != "" {
			filter[id] = true
		}
	}
	return filter
}

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	w = diag.NewHandlerBytesWriter(w, diag.ProxyPathSnapshot) // PROBE 8: attribute non-stream tunnel bytes
	agg := s.aggFor(reqDir(r))
	filter := messageFilter(r)
	filter = s.projectScopedFilter(agg, filter)
	s.ensureMessages(r.Context(), agg, filter)
	snap := agg.Store().Snapshot(filter)
	b, err := json.Marshal(snap)
	if err != nil {
		// snap is a well-typed *state.Snapshot, so this cannot fail today; but a
		// silent discard would mask a future regression. Surface it as a 500
		// instead of writing a nil slice (which would emit "null" as the body).
		vhlog.Error("snapshot: marshal failed", "dir", reqDir(r), "err", err)
		http.Error(w, "snapshot marshal failed", http.StatusInternalServerError)
		return
	}
	// gzip64-wrap on the same opt-in (z=1) + threshold as the stream snapshot.
	// fetchSessionMessages (refreshOpenSessions) pulls these on a tree reconnect
	// for every open session — each was shipping a full uncompressed transcript
	// through the tunnel. Application-level gzip64 (not HTTP Content-Encoding)
	// so it is tunnel-agnostic: the controller raw-proxies the body verbatim
	// (io.Copy in pkg/server/proxy.go) and the client decodes unconditionally.
	// A client that did not opt in (no z=1) gets the legacy raw JSON unchanged.
	w.Header().Set("Content-Type", "application/json")
	w.Write(maybeCompressSnapshot(b, wantsCompress(r)))
}

// ensureMessages lazily hydrates the messages for the sessions a snapshot/stream
// request will include, so lazy hydration is transparent to clients.
func (s *Server) ensureMessages(ctx context.Context, agg *aggregator.Aggregator, filter map[string]bool) {
	if filter == nil { // "all"
		for _, id := range agg.Store().SessionIDs() {
			_ = agg.EnsureMessages(ctx, id)
		}
		return
	}
	for id := range filter {
		_ = agg.EnsureMessages(ctx, id)
	}
}

// projectScopedFilter returns a filter containing only the IDs that are members
// of agg's project-scoped store. A nil filter ("all" request) passes through
// unchanged — the SAFE branch at the call site already iterates SessionIDs(),
// which is project-scoped by construction. This is the project-isolation guard
// at the HTTP boundary: without it, a request from project B carrying a session
// ID that belongs to project A would hydrate project A's messages into project
// B's store (OpenCode's /session/<id>/message endpoint is project-blind).
func (s *Server) projectScopedFilter(agg *aggregator.Aggregator, filter map[string]bool) map[string]bool {
	if filter == nil {
		return nil
	}
	scoped := make(map[string]bool, len(filter))
	for id := range filter {
		if agg.Store().HasSession(id) {
			scoped[id] = true
		}
	}
	return scoped
}

// triggerMessageLoad is the NON-BLOCKING counterpart of ensureMessages used on
// the Stream 2 first-open path: it kicks off async hydration (EnsureMessagesAsync)
// for unloaded selected sessions and returns immediately, so handleStream can
// send the snapshot at once and then forward the message.*/part.* deltas +
// messages.loaded completion over the same open connection as the background
// fetch reconciles. This is what makes selecting an unloaded session fast on
// first open. No-op (deduped to one in-flight fetch) for already-loaded or
// in-flight sessions. NOTE: handleSnapshot (the one-shot GET) intentionally
// keeps the SYNCHRONOUS ensureMessages above — a snapshot consumer expects the
// full current view in the response body.
func (s *Server) triggerMessageLoad(agg *aggregator.Aggregator, filter map[string]bool) {
	if filter == nil { // "all" — explicit firehose; async-trigger every unloaded session
		for _, id := range agg.Store().SessionIDs() {
			agg.EnsureMessagesAsync(id)
		}
		return
	}
	for id := range filter {
		agg.EnsureMessagesAsync(id)
	}
}

// handleAck clears a root session's finished-unread flag (the client scrolled
// that session to the bottom). POST /vh/ack {sessionID}. Cross-device: the
// resulting unread.clear event/snapshot reaches every connected client.
func (s *Server) handleAck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		SessionID string `json:"sessionID"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	if json.NewDecoder(r.Body).Decode(&body) != nil || body.SessionID == "" {
		http.Error(w, "sessionID required", http.StatusBadRequest)
		return
	}
	s.aggFor(reqDir(r)).Store().AckUnread(body.SessionID)
	writeJSONResp(w, map[string]any{"ok": true})
}
