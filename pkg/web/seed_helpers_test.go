package web

// seed_helpers_test.go — the shared seed-vs-hydrate race guard for direct
// store seeding in pkg/web tests (ORCH-F3).
//
// WHY THIS EXISTS (the ghost-delete race, 2026-08-23 CI flake): newReloadServer
// starts `go agg.Run(...)`, whose initial hydrate fetches the fake's /session
// list and state.Store.Hydrate DELETES every store session absent from that
// list (pkg/state/hydration.go:127-131 — "a session absent from the fetch is
// deleted"). The 5s tree-reconcile tick ghost-removes the same way
// (ReconcileSessions). Directly Apply()-ing a session.created event therefore
// races BOTH: on a slow/loaded CI runner the initial hydrate can complete AFTER
// the seeding and delete the just-seeded session (observed as "got 0 messages"
// snapshots and as live part events that are never delivered). The guard closes
// the class with two measures:
//
//  1. BARRIER: wait for the aggregator's initial hydrate to fully complete
//     BEFORE seeding, so its empty-list delete pass runs against the pre-seed
//     store. AnyHydrateCompleted is the sticky end-of-success flag Run's
//     hydrate sets; nothing else hydrates in these tests (the only other
//     Rehydrate callers are the archive HTTP handlers, unused here).
//  2. REGISTRATION: add the session to the fake's authoritative /session list
//     (race-safe setter, mirroring setMessage), so every LATER fetch — the 5s
//     tree-reconcile tick, any reconnect hydrate — preserves it. The envelope
//     is byte-identical to the info blob sessionCreatedEvent seeds, so a
//     re-hydrate's bytes.Equal comparison (hydration.go:107) emits no spurious
//     session.upsert into the replay window.
//
// Every test that needs a seeded session must go through seedSession — a bare
// Apply(sessionCreatedEvent(...)) + waitFor(HasSession) pair is the race, even
// if it happens to win on an unloaded machine.

import (
	"fmt"
	"testing"
)

// seedSession seeds one session into the store AND the fake's authoritative
// /session list, guarded against the seed-vs-hydrate ghost-delete race (see the
// file comment). After it returns, the session exists in the store and survives
// any later hydrate/reconcile. Tests that also need messages layer
// messageUpdatedEvent Applies on top (see seedSessionMessages).
func seedSession(t *testing.T, srv *Server, fake *fakeOpenCode, sid string) {
	t.Helper()
	waitFor(t, func() bool { return srv.agg.AnyHydrateCompleted() },
		"aggregator initial hydrate before seeding "+sid)
	fake.addSession(sid)
	srv.agg.Store().Apply(sessionCreatedEvent(sid))
	waitFor(t, func() bool { return srv.agg.Store().HasSession(sid) },
		"seed session "+sid)
}

// addSession appends one session envelope to the fake's authoritative /session
// list (the endpoint the aggregator's hydrate and tree-reconcile poll). The
// handler reads f.sessions under f.mu, so post-start writes MUST go through
// here (see setMessage for the identical rationale). The envelope mirrors the
// info sub-blob sessionCreatedEvent seeds — same fields, same order — so
// Hydrate's byte-equality check treats the hydrated and seeded entries as
// identical and emits nothing.
func (f *fakeOpenCode) addSession(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessions = append(f.sessions, fmt.Sprintf(`{"id":%q,"title":%q}`, id, id))
}
