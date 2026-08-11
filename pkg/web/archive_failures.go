package web

// Server-managed archive-failure visibility (Slice 1 of the archive-failure
// chain) — the SSE + wire surface for stuck archive ROOTS.
//
// A permanently-stuck archive root (OpenCode 400/403 on PATCH /session/:id
// time.archived, or the bounded retry budget exhausting on a root/unresolvable
// chain) is recorded in the in-memory (dir,id) registry by recordArchiveFailure
// (pkg/web/archive.go) and surfaced to the mobile SPA via TWO SSE frames:
//
//   - archive-failures.snapshot — emitted on EVERY fresh /vh/stream connect
//     (the bootstrap catch-up, filtered to reqDir(r) — only this project's
//     failures). A reconnecting client never loses unresolved failures.
//   - archive-failures.updated — emitted transiently on record/clear (the live
//     tail). Not replayed (EmitTransient); reconnect catches up via the
//     snapshot bootstrap frame.
//
// The registry is in-memory + current-daemon-only (no persistence, no replay
// ring). The clear-on-success at the runArchiveCascade success funnel is the
// load-bearing correctness rule: a stuck-root record clears the moment a retry
// actually succeeds (200-ok / 404-410-ghost / 409-already-archived), NEVER at
// the 200-accepted handler response (acceptance ≠ success — the cascade runs
// async). See pkg/web/archive.go clearArchiveFailure for the full lifecycle.
//
// Tenant isolation mirrors fanOutLabelsUpdate: snapshot + updated are per-
// project (one aggregator's live subscribers), NOT worker-wide like pins — a
// failure in project A never reaches project B's stream.
//
// The wire DTO carries ONLY the classified reason token ("permanent:403",
// "exhausted:5", "cancelled:shutdown") — NEVER raw opencode.Error.Body (that
// stays in log.Printf only). The banner displays the token verbatim so the
// operator sees the failure category without leaking upstream error prose.

import (
	"encoding/json"
	"sort"

	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// kindArchiveFailuresUpdated is the SSE event name for the transient archive-
// failures fan-out frame, emitted after recordArchiveFailure (stuck root
// recorded/refreshed) and clearArchiveFailure (retry succeeded — record
// removed). The direct analogue of kindLabelsUpdated / kindPinsUpdated: it
// carries no `id:` line (writeRawNoID) so it never becomes a resume cursor —
// it is orthogonal to the state store's seq space, and a reconnecting client
// catches up via the archive-failures.snapshot bootstrap frame emitted on
// connect. The frame body is the FULL per-project archiveFailuresDoc (same
// shape as the snapshot), so the client applies it idempotently (replace the
// local set with the server's current set).
const kindArchiveFailuresUpdated = "archive-failures.updated"

// archiveJobFailureDTO is the wire shape for ONE stuck-root failure. It
// purposefully OMITS Dir (the snapshot/updated frames are already per-project —
// dir filtering happened server-side) and carries ONLY the classified reason
// token (never raw opencode.Error.Body — that stays in server logs). At is unix
// millis for a stable wire encoding.
type archiveJobFailureDTO struct {
	ID      string `json:"id"`
	Reason  string `json:"reason"`            // classified token: "permanent:403" | "exhausted:5" | "cancelled:shutdown"
	RootSrc string `json:"rootSrc,omitempty"` // the originating POST /vh/archive sessionID (empty → unknown)
	At      int64  `json:"at"`                // unix millis
}

// archiveFailuresDoc is the wire body for BOTH the snapshot bootstrap frame
// and the updated fan-out frame (same shape — the client replaces its local
// per-project set with Failures on either). Sorted by At then ID for
// deterministic output. An empty Failures slice means "no stuck roots for this
// project" — the client renders no banner (or removes it if previously shown).
type archiveFailuresDoc struct {
	Failures []archiveJobFailureDTO `json:"failures"`
}

// archiveFailuresDocForDir is the public per-project wire-DTO builder for the
// SSE bootstrap snapshot (server.go handleStream). It locks the registry,
// builds the doc via archiveFailuresDocForDirLocked, and unlocks. The fan-out
// path (recordArchiveFailure / clearArchiveFailure) calls the Locked variant
// inline under a held lock to avoid a double lock/unlock.
func (s *Server) archiveFailuresDocForDir(dir string) archiveFailuresDoc {
	s.archiveFailuresMu.Lock()
	defer s.archiveFailuresMu.Unlock()
	return s.archiveFailuresDocForDirLocked(dir)
}

// archiveFailuresDocForDirLocked builds the wire DTO for ONE project's stuck-
// root failures. Caller MUST hold archiveFailuresMu. Sorted by At then ID for
// deterministic output (so two equal Sets serialize identically — important for
// snapshot-vs-update equality checks in tests).
func (s *Server) archiveFailuresDocForDirLocked(dir string) archiveFailuresDoc {
	var entries []archiveJobFailure
	for k, fl := range s.archiveFailures {
		if k.Dir == dir {
			entries = append(entries, fl)
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		if !entries[i].At.Equal(entries[j].At) {
			return entries[i].At.Before(entries[j].At)
		}
		return entries[i].ID < entries[j].ID
	})
	doc := archiveFailuresDoc{Failures: make([]archiveJobFailureDTO, 0, len(entries))}
	for _, fl := range entries {
		doc.Failures = append(doc.Failures, archiveJobFailureDTO{
			ID:      fl.ID,
			Reason:  fl.Reason,
			RootSrc: fl.RootSrc,
			At:      fl.At.UnixMilli(),
		})
	}
	return doc
}

// fanOutArchiveFailuresUpdate emits an archive-failures.updated transient
// frame to THIS project's live subscribers ONLY (per-project: a stuck root in
// project A must not reach project B's stream — mirrors fanOutLabelsUpdate).
// dir scoping matches aggForExisting: a project with no open aggregator has no
// live subscribers to reach, so it is silently dropped (the snapshot-on-
// reconnect bootstrap is the catch-up). EmitTransient is transient (not
// recorded to the replay ring, no seq advance), so a reconnecting client never
// replays it — archive-failures.snapshot on connect is the catch-up.
func (s *Server) fanOutArchiveFailuresUpdate(dir string, doc archiveFailuresDoc) {
	a := s.aggForExisting(dir)
	if a == nil {
		return
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		vhlog.Warn("archive-failures.updated fan-out: marshal failed, skipping", "err", err)
		return
	}
	a.Store().EmitTransient(kindArchiveFailuresUpdated, raw)
}
