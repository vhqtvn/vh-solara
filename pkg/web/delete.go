package web

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// Deleting uses OpenCode's NATIVE delete (DELETE /session/:id): it removes the
// session (and its whole subtree — OpenCode auto-cascades to children) from
// OpenCode's store. Delete is DESTRUCTIVE and IRREVERSIBLE; there is no undelete.
// This handler mirrors handleArchive's archive branch (pkg/web/archive.go):
// compute the live subtree, apply the C5 fingerprint drift fence, loop the
// per-id op (here DeleteSession), then prune the local live view
// (RemoveSessions + queue cleanup + pins unpin). Delete does NOT need the
// post-archive re-assert goroutine — that exists only because a busy/compacting
// subagent can clobber time.archived on rewrite; delete has no such field to
// clobber (the session is gone, not flagged).

// POST /vh/delete {sessionID, expectedFingerprint?} — delete a session and all
// its subsessions. Destructive + irreversible.
func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		SessionID           string `json:"sessionID"`
		ExpectedFingerprint string `json:"expectedFingerprint,omitempty"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10) // a session id is tiny
	if json.NewDecoder(r.Body).Decode(&body) != nil || body.SessionID == "" {
		http.Error(w, "sessionID required", http.StatusBadRequest)
		return
	}
	dir := reqDir(r)
	agg := s.aggFor(dir)

	// The subtree is live, so cascade is computed from the store. (Mirrors the
	// archive branch: a delete of id cascades to id + its subsessions.)
	affected := agg.Store().Descendants(body.SessionID)
	// Fallback: if the requested session isn't in the live store (e.g. an orphan
	// whose parent was archived/deleted server-side, or a session OpenCode
	// already cascade-deleted), delete at least the requested id directly so
	// OpenCode removes it and the client receives it in the affected list to
	// prune. See handleArchive for the identical fallback rationale.
	if len(affected) == 0 {
		affected = []string{body.SessionID}
	}
	// C5 — delete-preview drift fence. Same point-in-time fence as archive over
	// the T0→T1 preview→commit window: if the caller carried a preview
	// fingerprint (the FE's SessionContextMenu threads the one returned by
	// GET /vh/session/:id/descendants), reject when the live affected set's
	// MEMBERSHIP changed between preview and commit (a spawn, a delete, or a
	// reparent in/out of the subtree). 409 Conflict and NO delete is performed
	// (we return before the DeleteSession loop). The FE re-fetches descendants
	// and re-shows the confirmation dialog against the current set; it does NOT
	// auto-retry (the operator must re-consent to the new set — that is the
	// entire point of the fence, and doubly so for a destructive, irreversible
	// op). See handleArchive for the full rationale; the residual race (a
	// mutation landing AFTER this check but before the loop) is accepted for the
	// same reasons. The fingerprint is a pure function of the id-set, so an
	// internal reparent does NOT reject — only membership changes do. Absent
	// expectedFingerprint (legacy / unattended programmatic deletes) → no fence.
	if body.ExpectedFingerprint != "" {
		cur := state.FingerprintIDs(affected)
		if cur != body.ExpectedFingerprint {
			writeJSON(w, http.StatusConflict, jsonBytes(map[string]any{
				"ok":    false,
				"error": "descendants_changed",
				"current": map[string]any{
					"fingerprint": cur,
					"affected":    affected,
				},
			}))
			return
		}
	}
	// Loop the per-id op. OpenCode's DELETE auto-cascades to children, so once a
	// parent is deleted its descendants return 404 on their own delete (tolerated
	// below — a verifiably-gone session satisfies the delete intent). The loop
	// is kept for STRUCTURAL PARITY with archive (and for orphan robustness: an
	// orphan not in OpenCode's parent→child tree is only reached by its own id).
	for _, id := range affected {
		if err := agg.Client().DeleteSession(r.Context(), id); err != nil {
			// Distinguish "session is gone" (404/410) from everything else.
			//
			// 404/410 — the session doesn't exist in OpenCode (a ghost, OR a
			// descendant already cascade-deleted by an earlier iteration's
			// parent delete in this very loop, OR a prior delete). The delete
			// intent is satisfied — the session is verifiably gone — so
			// tolerate: log, continue, and let RemoveSessions prune the tree.
			//
			// All other statuses (400 schema rejection, 401/403 auth, 409
			// conflict, 429 rate-limited, 5xx, network) mean the session IS
			// still live in OpenCode or the server is broken. Abort so the
			// delete does NOT reach RemoveSessions (which would fire
			// KindSessionDelete → CleanupSession and delete the session's queue
			// state). A failed delete must preserve the queue — the session may
			// still be active. Return 502. (Identical boundary to archive.)
			var ocErr *opencode.Error
			if errors.As(err, &ocErr) && (ocErr.Status == http.StatusNotFound || ocErr.Status == http.StatusGone) {
				log.Printf("[delete] DeleteSession(%s): %v (session gone)", id, err)
				continue
			}
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
	}
	// Drop them from the live view immediately (clients prune via delete).
	agg.Store().RemoveSessions(affected)
	// Delete clears the queue: a successful delete deletes that session's queue
	// state. Done AFTER the delete commits so a failed delete never loses queued
	// messages. Mirrors archive's queue cleanup (FIX-QUEUE-GC-2) and composes
	// idempotently with the KindSessionDelete subscriber RemoveSessions fires.
	root, err := projectRoot(dir)
	if err == nil {
		for _, id := range affected {
			s.queues.CleanupSession(root, safeID.ReplaceAllString(id, ""))
		}
	}
	// A deleted session is no longer active, so unpin it from the worker-wide
	// PinStore and broadcast (mirrors archive's direct hook). removePinsAndBroadcast
	// is idempotent (a no-op when none of the ids are present) and follows the
	// uniform cleanup→broadcast rule.
	s.removePinsAndBroadcast(affected)
	writeJSONResp(w, map[string]any{"ok": true, "affected": affected})
}
