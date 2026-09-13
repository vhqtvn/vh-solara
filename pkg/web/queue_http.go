package web

// HTTP handlers for the backend-authoritative per-session message queue. See
// queue.go for the store + lifecycle. These follow the /vh/* verb conventions
// (decodeBody for JSON, writeJSONResp for responses, errResp/structured
// conflict+not-found). CSRF is enforced by csrfGuard on POST/DELETE.
//
// Routes (registered in server.go Handler() via Go 1.22 method patterns):
//
//	GET    /vh/session/{sessionId}/queue              — list
//	POST   /vh/session/{sessionId}/queue              — enqueue (backend issues id+order)
//	DELETE /vh/session/{sessionId}/queue/{itemId}     — remove (pending + terminal; not dispatching)
//	POST   /vh/session/{sessionId}/queue/claim        — atomically claim oldest pending
//	POST   /vh/session/{sessionId}/queue/{itemId}/resolve — record sent/failed/unknown
//
// Project is resolved via ?dir= / x-opencode-directory (reqDir → projectRoot),
// matching every other /vh/* handler. The session id is sanitized with safeID
// before any filesystem use (same as attachments).

import (
	"errors"
	"net/http"
)

// resolveQueueCtx extracts + validates the session id and project root from a
// queue request. Writes the error response and returns ok=false on failure.
func (s *Server) resolveQueueCtx(w http.ResponseWriter, r *http.Request) (sid, root string, ok bool) {
	sid = safeID.ReplaceAllString(r.PathValue("sessionId"), "")
	if sid == "" {
		http.Error(w, "session required", http.StatusBadRequest)
		return "", "", false
	}
	root, err := projectRoot(reqDir(r))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return "", "", false
	}
	return sid, root, true
}

// writeQueueStoreErr maps a store sentinel error to its HTTP status + body.
// The two slice-1 conflict sentinels carry a machine-readable "code" field
// (queue_admission_conflict / queue_resolve_conflict) so the FE can
// feature-detect them without parsing prose; legacy sentinels keep the plain
// errResp shape they always had.
func writeQueueStoreErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errQueueNotFound):
		writeJSON(w, http.StatusNotFound, errResp(err.Error()))
	case errors.Is(err, errQueueNotRemovable):
		writeJSON(w, http.StatusConflict, errResp(err.Error()))
	case errors.Is(err, errQueueNotClaimed):
		writeJSON(w, http.StatusConflict, errResp(err.Error()))
	case errors.Is(err, errQueueCannotRepend):
		writeJSON(w, http.StatusBadRequest, errResp(err.Error()))
	case errors.Is(err, errQueueAdmissionConflict):
		writeJSON(w, http.StatusConflict, jsonBytes(map[string]any{"ok": false, "error": err.Error(), "code": "queue_admission_conflict"}))
	case errors.Is(err, errQueueAdmissionFull):
		writeJSON(w, http.StatusTooManyRequests, jsonBytes(map[string]any{"ok": false, "error": err.Error(), "code": "queue_admission_full"}))
	case errors.Is(err, errQueueResolveConflict):
		writeJSON(w, http.StatusConflict, jsonBytes(map[string]any{"ok": false, "error": err.Error(), "code": "queue_resolve_conflict"}))
	case errors.Is(err, errQueueBadAttemptID):
		writeJSON(w, http.StatusBadRequest, errResp(err.Error()))
	case errors.Is(err, errQueueArchived):
		// 410 Gone: the session queue was archived away; the retained pointer
		// the handler resolved via store() is now a tombstoned store (BLK-1).
		// A fresh store() lookup would create a new empty store, but the
		// handler holds the retained pointer from before archive — surface the
		// archived state so the FE treats it like any non-2xx (claim returns
		// no-claim; enqueue/remove/resolve surface the error).
		writeJSON(w, http.StatusGone, errResp(err.Error()))
	default:
		// A malformed/unreadable queue.json surfaces as a 500 so the operator
		// can investigate instead of silently losing items.
		writeJSON(w, http.StatusInternalServerError, errResp(err.Error()))
	}
}

// GET /vh/session/{sessionId}/queue — list all items (FIFO order).
func (s *Server) handleQueueList(w http.ResponseWriter, r *http.Request) {
	sid, root, ok := s.resolveQueueCtx(w, r)
	if !ok {
		return
	}
	items, err := s.queues.store(root, sid).List()
	if err != nil {
		writeQueueStoreErr(w, err)
		return
	}
	// Opportunistic message-id reconciliation: if any listed item is a
	// delivered-but-stuck candidate (unknown + correlation id + not terminal),
	// kick off ONE async reconcile pass using this dir's opencode client. This
	// reuses the FE's natural list/sync cadence (no separate poller) and is
	// bounded by the per-item throttle + terminal markers. The response is
	// returned immediately; reconciliation (Resolve→sent) is observed by the
	// FE on its NEXT poll. When nothing is eligible (the common case) there is
	// no spawn, no aggFor lookup, and no side effect — so existing List
	// traffic is unaffected.
	if hasReconcileCandidate(items) {
		go s.reconcileSessionQueue(reqDir(r), sid, root)
	}
	writeJSONResp(w, map[string]any{"items": items})
}

// POST /vh/session/{sessionId}/queue — enqueue. Body:
//
//	{text, attachments?, sendConfig?, originClientId?, attemptId?}
//
// The backend issues the id and monotonic order. originClientId is
// diagnostics-only and never affects ordering/visibility/dispatch.
//
// attemptId (OPTIONAL, send-reliability slice 1) makes the admission durably
// idempotent: the same (attemptId, canonical payload) replay returns the
// ORIGINAL admission receipt with "replayed": true and creates no second
// item; the same attemptId with a CHANGED payload is a 409 conflict
// (code "queue_admission_conflict"); a new attemptId at receipt capacity is a
// 429 (code "queue_admission_full"). Requests WITHOUT attemptId keep the
// legacy non-idempotent behavior and always respond "replayed": false.
// Receipt lifetime = session-queue lifetime; archive/cleanup ends the replay
// guarantee (a post-cleanup replay is a fresh admission).
func (s *Server) handleQueueEnqueue(w http.ResponseWriter, r *http.Request) {
	sid, root, ok := s.resolveQueueCtx(w, r)
	if !ok {
		return
	}
	var body struct {
		Text           string            `json:"text"`
		Attachments    []QueueAttachment `json:"attachments"`
		SendConfig     QueueSendConfig   `json:"sendConfig"`
		OriginClientID string            `json:"originClientId"`
		AttemptID      string            `json:"attemptId"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	item, replayed, err := s.queues.store(root, sid).EnqueueWithAttemptID(body.AttemptID, body.Text, body.Attachments, body.SendConfig, body.OriginClientID)
	if err != nil {
		writeQueueStoreErr(w, err)
		return
	}
	writeJSONResp(w, map[string]any{"item": item, "replayed": replayed})
}

// DELETE /vh/session/{sessionId}/queue/{itemId} — remove an item. Operators
// may dismiss any item that is not actively in flight: `pending` (cancel
// before dispatch) and terminal `sent`/`failed`/`unknown` (clear a recovered
// or completed item from view — FIX-QUEUE-GC-4). A `dispatching` item is
// rejected (409): the dispatch may be in flight, so the state machine must own
// the transition to terminal first. Missing item → 404.
func (s *Server) handleQueueRemove(w http.ResponseWriter, r *http.Request) {
	sid, root, ok := s.resolveQueueCtx(w, r)
	if !ok {
		return
	}
	itemID := r.PathValue("itemId")
	if itemID == "" {
		http.Error(w, "itemId required", http.StatusBadRequest)
		return
	}
	if err := s.queues.store(root, sid).Remove(itemID); err != nil {
		writeQueueStoreErr(w, err)
		return
	}
	writeJSONResp(w, map[string]any{"ok": true})
}

// POST /vh/session/{sessionId}/queue/claim — atomically claim the oldest
// pending item (move it to dispatching). Exactly one caller wins a given item
// (serialized by the per-session mutex). Response always 200:
//
//	{item: <QueueItem>}  — won the claim
//	{item: null}         — no pending item to dispatch
func (s *Server) handleQueueClaim(w http.ResponseWriter, r *http.Request) {
	sid, root, ok := s.resolveQueueCtx(w, r)
	if !ok {
		return
	}
	item, won, err := s.queues.store(root, sid).Claim()
	if err != nil {
		writeQueueStoreErr(w, err)
		return
	}
	if !won {
		writeJSONResp(w, map[string]any{"item": nil})
		return
	}
	writeJSONResp(w, map[string]any{"item": item})
}

// POST /vh/session/{sessionId}/queue/{itemId}/resolve — record a terminal
// outcome. Body: {state, detail?}. state must be sent/failed/unknown (never
// pending — cannot repend). A pending item must be claimed first (409).
// Terminal resolution is MONOTONIC (send-reliability slice 1): an IDENTICAL
// re-resolve (same state + detail) is a successful no-op that preserves the
// original timestamps; unknown → sent is allowed (manual/reconciler recovery);
// any other terminal rewrite or downgrade — notably sent → failed/unknown —
// is a 409 conflict (code "queue_resolve_conflict") rather than silently
// applied or silently lost.
func (s *Server) handleQueueResolve(w http.ResponseWriter, r *http.Request) {
	sid, root, ok := s.resolveQueueCtx(w, r)
	if !ok {
		return
	}
	itemID := r.PathValue("itemId")
	if itemID == "" {
		http.Error(w, "itemId required", http.StatusBadRequest)
		return
	}
	var body struct {
		State  string `json:"state"`
		Detail string `json:"detail"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	target := QueueItemState(body.State)
	if !isTerminalState(target) {
		writeJSON(w, http.StatusBadRequest, errResp("state must be sent, failed, or unknown (cannot repend)"))
		return
	}
	item, err := s.queues.store(root, sid).Resolve(itemID, target, body.Detail)
	if err != nil {
		writeQueueStoreErr(w, err)
		return
	}
	writeJSONResp(w, map[string]any{"item": item})
}
