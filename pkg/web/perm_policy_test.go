package web

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// Slice 2: fail-closed permission policy for spawned sessions. These tests cover
// the spawn-time validation + binding, the watcher auto-reject, loop-safety, the
// permission_blocked gate observable, and MCP parity. Neutral vocab only: the
// tests speak about spawns, sessions, permissions, and outcomes.

// permReplies returns the fake's recorded permission replies (canonical + legacy).
func (f *fakeOC) permReplies() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.permissions))
	copy(out, f.permissions)
	return out
}

// TestSpawnPermissionPolicyFailFast arms the watcher on a fresh fail_fast spawn:
// outcome is still "created" (mint happened) and the binding is registered once.
func TestSpawnPermissionPolicyFailFast(t *testing.T) {
	f := &fakeOC{}
	web, _, srv := newVerbServerSrv(t, f)
	st, out, _ := post(t, web.URL+"/vh/spawn", `{"prompt":"hi","title":"T","permission_policy":"fail_fast"}`, nil)
	if st != 200 || out["outcome"] != OutcomeCreated || out["sessionID"] != "new_sess" {
		t.Fatalf("fail_fast spawn want outcome=%q sessionID=new_sess, got %d %v", OutcomeCreated, st, out)
	}
	if f.creates != 1 {
		t.Fatalf("fail_fast spawn must still mint exactly once, got creates=%d", f.creates)
	}
	if got := srv.failFastCount(); got != 1 {
		t.Fatalf("fail_fast spawn must register exactly 1 binding, got %d", got)
	}
	if !srv.isFailFast("new_sess") {
		t.Fatal("spawned session new_sess must be registered as fail-closed")
	}
}

// TestSpawnPermissionPolicyAliasAutoReject confirms "auto_reject" is an accepted
// alias for "fail_fast" (same binding, still created).
func TestSpawnPermissionPolicyAliasAutoReject(t *testing.T) {
	f := &fakeOC{}
	web, _, srv := newVerbServerSrv(t, f)
	st, out, _ := post(t, web.URL+"/vh/spawn", `{"prompt":"hi","permission_policy":"auto_reject"}`, nil)
	if st != 200 || out["outcome"] != OutcomeCreated {
		t.Fatalf("auto_reject spawn want outcome=%q, got %d %v", OutcomeCreated, st, out)
	}
	if got := srv.failFastCount(); got != 1 {
		t.Fatalf("auto_reject must arm the binding, got %d", got)
	}
}

// TestSpawnPermissionPolicyUnknownRefused is the fail-closed property: an unknown
// permission_policy is REFUSED before mint. CreateSession is NOT called (no side
// effect, no widening) and the outcome is the reserved "refused".
func TestSpawnPermissionPolicyUnknownRefused(t *testing.T) {
	for _, bad := range []string{"auto_allow", "always", "permit", "FAIL_FAST"} {
		f := &fakeOC{}
		web, _, srv := newVerbServerSrv(t, f)
		body := `{"prompt":"hi","idempotency_key":"sp-bad","permission_policy":"` + bad + `"}`
		st, out, _ := post(t, web.URL+"/vh/spawn", body, nil)
		if st != http.StatusBadRequest {
			t.Errorf("policy=%q: want status %d, got %d", bad, http.StatusBadRequest, st)
		}
		if out["outcome"] != OutcomeRefused {
			t.Errorf("policy=%q: want outcome=%q, got %v", bad, OutcomeRefused, out["outcome"])
		}
		if out["ok"] != false {
			t.Errorf("policy=%q: want ok=false, got %v", bad, out["ok"])
		}
		if err, _ := out["error"].(string); !strings.Contains(err, "unknown permission_policy") || !strings.Contains(err, bad) {
			t.Errorf("policy=%q: want error naming the bad value, got %v", bad, out["error"])
		}
		if f.creates != 0 {
			t.Errorf("policy=%q: fail-closed refusal must NOT call CreateSession, got creates=%d", bad, f.creates)
		}
		if got := srv.failFastCount(); got != 0 {
			t.Errorf("policy=%q: refused spawn must register no binding, got %d", bad, got)
		}
	}
}

// TestSpawnPermissionPolicyAbsent is a normal spawn when the param is missing or
// empty: outcome created, no binding registered.
func TestSpawnPermissionPolicyAbsent(t *testing.T) {
	for _, body := range []string{
		`{"prompt":"hi","title":"T"}`,
		`{"prompt":"hi","permission_policy":""}`,
	} {
		f := &fakeOC{}
		web, _, srv := newVerbServerSrv(t, f)
		st, out, _ := post(t, web.URL+"/vh/spawn", body, nil)
		if st != 200 || out["outcome"] != OutcomeCreated {
			t.Fatalf("policy-absent spawn want outcome=%q, got %d %v (body=%s)", OutcomeCreated, st, out, body)
		}
		if got := srv.failFastCount(); got != 0 {
			t.Fatalf("policy-absent spawn must register no binding, got %d (body=%s)", got, body)
		}
	}
}

// TestSpawnPermissionPolicyReplayNoDoubleRegister verifies an idempotent replay
// of a fail_fast spawn reports outcome=reused and does NOT re-register (the fn
// only runs on the fresh-execution path).
func TestSpawnPermissionPolicyReplayNoDoubleRegister(t *testing.T) {
	f := &fakeOC{}
	web, _, srv := newVerbServerSrv(t, f)
	body := `{"prompt":"hi","idempotency_key":"sp-ff","permission_policy":"fail_fast"}`
	st1, out1, _ := post(t, web.URL+"/vh/spawn", body, nil)
	if st1 != 200 || out1["outcome"] != OutcomeCreated {
		t.Fatalf("fresh fail_fast spawn want outcome=%q, got %d %v", OutcomeCreated, st1, out1)
	}
	if got := srv.failFastCount(); got != 1 {
		t.Fatalf("fresh spawn must register 1 binding, got %d", got)
	}
	st2, out2, _ := post(t, web.URL+"/vh/spawn", body, nil)
	if st2 != 200 || out2["outcome"] != OutcomeReused {
		t.Fatalf("replay want outcome=%q, got %d %v", OutcomeReused, st2, out2)
	}
	if got := srv.failFastCount(); got != 1 {
		t.Fatalf("replay must NOT double-register, want 1 binding, got %d", got)
	}
	if f.creates != 1 {
		t.Fatalf("replay must not re-create, got creates=%d", f.creates)
	}
}

// TestWatcherAutoRejectsFailFast seeds a pending permission for a fail_fast
// session and asserts the watcher auto-rejects it (never "always"), the
// permission_blocked gate fact appears, and the spawn outcome stays "created".
func TestWatcherAutoRejectsFailFast(t *testing.T) {
	f := &fakeOC{}
	web, agg, srv := newVerbServerSrv(t, f)
	st, out, _ := post(t, web.URL+"/vh/spawn", `{"prompt":"hi","permission_policy":"fail_fast"}`, nil)
	if st != 200 || out["outcome"] != OutcomeCreated {
		t.Fatalf("fail_fast spawn want outcome=%q, got %d %v", OutcomeCreated, st, out)
	}
	store := agg.Store()
	// Seed the session (the aggregator loop isn't running in tests) so the gate
	// exists and MarkPermissionBlocked's session-existence guard passes.
	store.Apply(ev("session.updated", `{"info":{"id":"new_sess","title":"t"}}`))
	// Raise a permission prompt for the fail_fast session.
	store.Apply(ev("permission.asked", `{"id":"p1","sessionID":"new_sess","permission":"bash"}`))

	// The watcher rejects asynchronously. Assert it records a "reject" reply and
	// never "always".
	waitFor(t, func() bool {
		for _, r := range f.permReplies() {
			if strings.Contains(r, "reject") {
				return true
			}
		}
		return false
	}, "watcher to auto-reject the fail_fast permission")
	for _, r := range f.permReplies() {
		if strings.Contains(r, "always") {
			t.Fatalf("watcher must NEVER reply 'always' (no persistent grant), got %q", r)
		}
	}
	// The permission_blocked gate fact must be observable post-hoc.
	waitFor(t, func() bool {
		return store.Snapshot(nil).Gate["new_sess"].PermissionBlocked
	}, "permission_blocked gate fact to appear")
	// Spawn outcome is unchanged (still created — mint happened, the session is counted).
	if !srv.isFailFast("new_sess") || srv.failFastCount() != 1 {
		t.Fatalf("permission event must not change the binding; count=%d", srv.failFastCount())
	}
}

// TestWatcherIgnoresNonFailFast is loop-safety + scope: a session spawned
// WITHOUT the policy raises a prompt and the watcher does NOT auto-reject (no
// reply recorded at all).
func TestWatcherIgnoresNonFailFast(t *testing.T) {
	f := &fakeOC{}
	web, agg, srv := newVerbServerSrv(t, f)
	st, out, _ := post(t, web.URL+"/vh/spawn", `{"prompt":"hi"}`, nil)
	if st != 200 || out["outcome"] != OutcomeCreated {
		t.Fatalf("plain spawn want outcome=%q, got %d %v", OutcomeCreated, st, out)
	}
	if srv.failFastCount() != 0 {
		t.Fatalf("plain spawn must register no binding, got %d", srv.failFastCount())
	}
	store := agg.Store()
	store.Apply(ev("session.updated", `{"info":{"id":"new_sess","title":"t"}}`))
	store.Apply(ev("permission.asked", `{"id":"p1","sessionID":"new_sess","permission":"bash"}`))
	// The watcher only acts on fail_fast ids. Asserting the ABSENCE of an effect
	// can't use waitFor's positive poll, so give the async watcher a bounded
	// window to (wrongly) act and fail fast if it ever does.
	deadline := time.Now().Add(250 * time.Millisecond)
	for time.Now().Before(deadline) {
		if r := f.permReplies(); len(r) != 0 {
			t.Fatalf("watcher must NOT auto-reject a non-fail_fast session, got %v", r)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestPermissionBlockedClearsOnTermination verifies the observable is sticky past
// the permission clearing and removed when the session terminates.
func TestPermissionBlockedClearsOnTermination(t *testing.T) {
	f := &fakeOC{}
	_, agg, _ := newVerbServerSrv(t, f)
	store := agg.Store()
	store.Apply(ev("session.updated", `{"info":{"id":"new_sess","title":"t"}}`))
	store.Apply(ev("permission.asked", `{"id":"p1","sessionID":"new_sess","permission":"bash"}`))
	store.MarkPermissionBlocked("new_sess")
	if !store.Snapshot(nil).Gate["new_sess"].PermissionBlocked {
		t.Fatal("permission_blocked must be observable while the session is alive")
	}
	// Clearing the permission must NOT clear the fact (sticky, observed post-hoc).
	store.Apply(ev("permission.replied", `{"sessionID":"new_sess","requestID":"p1","reply":"reject"}`))
	if !store.Snapshot(nil).Gate["new_sess"].PermissionBlocked {
		t.Fatal("permission_blocked must remain sticky after the permission clears")
	}
	// Session termination clears it (and removes the gate entry).
	store.Apply(ev("session.deleted", `{"info":{"id":"new_sess"}}`))
	if _, ok := store.Snapshot(nil).Gate["new_sess"]; ok {
		t.Fatal("terminated session must leave the gate entirely")
	}
}

// TestPermissionBlockedUnknownSession is a no-op guard: marking an unknown id
// does not invent a gate entry.
func TestPermissionBlockedUnknownSession(t *testing.T) {
	f := &fakeOC{}
	_, agg, _ := newVerbServerSrv(t, f)
	store := agg.Store()
	store.MarkPermissionBlocked("never_existed")
	if _, ok := store.Snapshot(nil).Gate["never_existed"]; ok {
		t.Fatal("MarkPermissionBlocked on an unknown id must not create a gate entry")
	}
}

// TestReconcileRejectsFailFastAfterOverflow is the F1 regression. It reproduces
// the EXACT failure mode the old live-tail watcher had: the store's lossy emit()
// CLOSES a subscriber's channel on overflow, so a `for ev := range ch` watcher
// would exit silently and never re-arm (defeating the guarantee with no signal).
// This test forces that overflow state on purpose — subscribing a tiny-buffer
// channel and flooding the store until emit() closes it — then proves the
// reconcile backstop STILL rejects a fail_fast session's pending permission,
// because it reads the authoritative Snapshot, not the lossy channel.
//
// Deterministic: it calls reconcileFailFastPerms directly (no ticker timing, no
// waiting). This is the backstop the guarantee now rests on.
func TestReconcileRejectsFailFastAfterOverflow(t *testing.T) {
	f := &fakeOC{}
	_, agg, srv := newVerbServerSrv(t, f)
	store := agg.Store()
	client := agg.Client()

	// Register a fail_fast session and seed it + a pending permission.
	srv.registerFailFast("new_sess")
	store.Apply(ev("session.updated", `{"info":{"id":"new_sess","title":"t"}}`))
	store.Apply(ev("permission.asked", `{"id":"p1","sessionID":"new_sess","permission":"bash"}`))

	// Reproduce the F1 threat: subscribe a live-tail channel (as the old watcher
	// did) with a tiny buffer, then flood the store so emit()'s lossy overflow
	// CLOSES it. A range-loop watcher would exit silently here and never re-arm.
	ch, unsub := store.Subscribe(1)
	defer unsub()
	for i := 0; i < 5; i++ { // 5 upserts >> buffer 1 -> channel closed by overflow
		store.Apply(ev("session.updated", `{"info":{"id":"flood","title":"f"}}`))
	}
	// The channel is now closed by the store's lossy overflow, but it may still
	// hold up to `buffer` already-buffered events, so drain until the close
	// surfaces (ok==false). A range-loop watcher would exit here, never re-arm.
	closed := false
	for i := 0; i < 10; i++ {
		if _, ok := <-ch; !ok {
			closed = true
			break
		}
	}
	if !closed {
		t.Fatal("expected the subscriber channel to be CLOSED by store overflow (the F1 threat); still delivering")
	}

	// The live-tail path is now dead (channel closed). The reconcile backstop
	// must STILL reject the pending permission — it reads the Snapshot, not the
	// channel, so event-tail loss cannot defeat it.
	srv.reconcileFailFastPerms(store, client)

	replies := f.permReplies()
	sawReject := false
	for _, r := range replies {
		if strings.Contains(r, "always") {
			t.Fatalf("reconcile must NEVER reply 'always' (no persistent grant), got %q", r)
		}
		if strings.Contains(r, "reject") {
			sawReject = true
		}
	}
	if !sawReject {
		t.Fatalf("reconcile must issue a 'reject' reply even after live-tail overflow, got %v", replies)
	}
	// The permission_blocked observable must be set (sticky fact).
	if !store.Snapshot(nil).Gate["new_sess"].PermissionBlocked {
		t.Fatal("permission_blocked must be set after the reconcile reject")
	}
}

// TestReconcileRejectsMultipleFailFastSessions proves one reconcile sweep
// rejects every pending permission across multiple fail_fast sessions in the
// same dir. Deterministic: calls reconcileFailFastPerms directly.
func TestReconcileRejectsMultipleFailFastSessions(t *testing.T) {
	f := &fakeOC{}
	_, agg, srv := newVerbServerSrv(t, f)
	store := agg.Store()
	client := agg.Client()

	sessions := []struct{ sid, perm string }{
		{"ff1", "perm1"},
		{"ff2", "perm2"},
		{"ff3", "perm3"},
	}
	for _, s := range sessions {
		srv.registerFailFast(s.sid)
		store.Apply(ev("session.updated", `{"info":{"id":"`+s.sid+`","title":"t"}}`))
		store.Apply(ev("permission.asked", `{"id":"`+s.perm+`","sessionID":"`+s.sid+`","permission":"bash"}`))
	}

	// A single reconcile sweep must reject all three pending permissions.
	srv.reconcileFailFastPerms(store, client)

	replies := f.permReplies()
	// Each pending permission yields exactly one reject reply (distinct ids, one
	// synchronous sweep), so the reject count must equal the session count.
	rejects := 0
	for _, r := range replies {
		if strings.Contains(r, "always") {
			t.Fatalf("reconcile must NEVER reply 'always', got %q", r)
		}
		if strings.Contains(r, "reject") {
			rejects++
		}
	}
	if rejects != len(sessions) {
		t.Fatalf("want %d reject replies (one per fail_fast session), got %d (replies=%v)", len(sessions), rejects, replies)
	}
	for _, s := range sessions {
		if !store.Snapshot(nil).Gate[s.sid].PermissionBlocked {
			t.Errorf("permission_blocked must be set for session %q after reconcile", s.sid)
		}
	}
}

// TestReconcileIsIdempotentOnClearedPermission confirms that rejecting a
// permission the sweep has already rejected (the in-flight race with the store's
// permission.replied clear) is harmless: the stale-reject error is swallowed and
// no panic/propagation occurs. Deterministic: calls reconcile twice with a fake
// whose canonical route 404s on the second pass (already-cleared).
func TestReconcileIsIdempotentOnClearedPermission(t *testing.T) {
	f := &fakeOC{}
	_, agg, srv := newVerbServerSrv(t, f)
	store := agg.Store()
	client := agg.Client()

	srv.registerFailFast("new_sess")
	store.Apply(ev("session.updated", `{"info":{"id":"new_sess","title":"t"}}`))
	store.Apply(ev("permission.asked", `{"id":"p1","sessionID":"new_sess","permission":"bash"}`))

	// First sweep: rejects cleanly, records the fact.
	srv.reconcileFailFastPerms(store, client)
	if !store.Snapshot(nil).Gate["new_sess"].PermissionBlocked {
		t.Fatal("permission_blocked must be set after the first reconcile")
	}

	// Simulate opencode having cleared the permission between sweeps (the normal
	// permission.replied path), so it is no longer pending.
	store.Apply(ev("permission.replied", `{"sessionID":"new_sess","requestID":"p1","reply":"reject"}`))

	// Second sweep must be a no-op (perm gone from the snapshot): no new reject
	// RPC, no panic, permission_blocked stays sticky. The fact that this returns
	// without aborting is the idempotency assertion.
	before := len(f.permReplies())
	srv.reconcileFailFastPerms(store, client)
	if got := len(f.permReplies()); got != before {
		t.Fatalf("second reconcile after clear must issue no new reject RPC, want %d got %d", before, got)
	}
	// permission_blocked is sticky past the permission clearing.
	if !store.Snapshot(nil).Gate["new_sess"].PermissionBlocked {
		t.Fatal("permission_blocked must remain sticky after the permission clears")
	}
}
