package web

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/state"
)

// C5 — archive-preview drift fence. These tests drive the full
// GET /vh/session/:id/descendants (preview) → POST /vh/archive (commit) flow
// with a stateless subtree-id-set fingerprint precondition: when the affected
// set's membership changed between preview and commit (spawn / delete /
// reparent in-or-out of the subtree), the commit returns 409 Conflict and
// archives NOTHING; the FE re-fetches + re-shows the dialog. An internal
// reparent (id stays in the subtree) does NOT reject — only membership changes
// do.
//
// The crux is TestArchiveDrift_SpawnBetweenPreviewAndCommit: the precise
// over-archive scenario C5 exists to prevent (a subagent spawns under the
// target between the operator opening the dialog and clicking confirm).

// postArchiveFP POSTs /vh/archive with a CSRF header + optional fingerprint and
// returns (status, decoded body). The body is the raw JSON map so the caller
// can inspect the 409 shape or the 200 affected list.
func postArchiveFP(t *testing.T, url, id, fingerprint string) (int, map[string]any) {
	t.Helper()
	body := map[string]any{"sessionID": id}
	if fingerprint != "" {
		body["expectedFingerprint"] = fingerprint
	}
	resp := csrfPost(t, url+"/vh/archive", body)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// previewFingerprint GETs /vh/session/:id/descendants and returns just the C5
// fingerprint (+ the descendant id list for sanity). Thin wrapper over the
// shared getDescendants helper so the drift test reads at the fingerprint level.
func previewFingerprint(t *testing.T, url, id string) (fingerprint string, ids []string) {
	t.Helper()
	_, _, _, env := getDescendants(t, url, id)
	for _, d := range env.Data.Descendants {
		ids = append(ids, d.ID)
	}
	return env.Data.Fingerprint, ids
}

// TestArchiveDrift_SpawnBetweenPreviewAndCommit is the C5 crux: a new
// descendant spawns under the target between the preview and the commit. The
// stale fingerprint MUST 409 and archive NOTHING — the operator never saw the
// new session and did not consent to archiving it.
func TestArchiveDrift_SpawnBetweenPreviewAndCommit(t *testing.T) {
	f := &fakeOC{}
	web, agg, srv, _ := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)
	// Seed root s1 + one child c1.
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1","title":"root"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c1","parentID":"s1","title":"child1"}}`))

	// T0 — preview. Capture the fingerprint of {s1, c1}.
	fpBefore, idsBefore := previewFingerprint(t, web.URL, "s1")
	if len(idsBefore) != 2 {
		t.Fatalf("preview before drift: want 2 descendants [s1 c1], got %v", idsBefore)
	}

	// DRIFT — a subagent spawns under s1 between preview and commit. This is
	// the over-archive case: without the fence the commit would archive c2, a
	// session the operator never saw.
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c2","parentID":"s1","title":"child2"}}`))

	// T1 — commit with the STALE fingerprint.
	status, body := postArchiveFP(t, web.URL, "s1", fpBefore)
	if status != http.StatusConflict {
		t.Fatalf("drift commit: got %d, want 409 (no archive performed)", status)
	}
	// Body shape: {ok:false, error:"descendants_changed",
	//              current:{fingerprint:<new>, affected:[s1,c1,c2]}}
	if body["ok"] != false {
		t.Fatalf("409 body ok: got %v, want false", body["ok"])
	}
	if body["error"] != "descendants_changed" {
		t.Fatalf("409 body error: got %v, want \"descendants_changed\"", body["error"])
	}
	cur, _ := body["current"].(map[string]any)
	if cur == nil {
		t.Fatalf("409 body missing current: %v", body)
	}
	if cur["fingerprint"] == fpBefore {
		t.Fatal("409 current.fingerprint equals the stale one — must reflect the new live set")
	}
	// current.affected must include the spawned c2 (the live set the server
	// would have archived without the fence).
	affected, _ := cur["affected"].([]any)
	if !containsAny(affected, "c2") {
		t.Fatalf("409 current.affected must include spawned c2, got %v", affected)
	}

	// NO-ARCHIVE PROOF — nothing was PATCHed (SetArchived never ran) and the
	// sessions are still live (not removed / not tombstoned).
	if patches := archivedPATCHes(f); len(patches) != 0 {
		t.Fatalf("drift must archive NOTHING — SetArchived PATCHes fired: %v", patches)
	}
	if got := agg.Store().Descendants("s1"); len(got) != 3 {
		t.Fatalf("drift must NOT remove sessions — Descendants(s1) want 3 [s1 c1 c2], got %v", got)
	}
	if agg.Store().IsRecentlyArchived("s1") {
		t.Fatal("drift must NOT tombstone s1 — no archive happened")
	}
}

// TestArchiveDrift_MatchingFingerprint_Archives is the happy path: no drift
// between preview and commit → the fingerprint matches → 200 + archive
// proceeds normally (the fence is transparent when nothing changed).
func TestArchiveDrift_MatchingFingerprint_Archives(t *testing.T) {
	f := &fakeOC{}
	web, agg, srv, _ := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1","title":"root"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c1","parentID":"s1"}}`))

	fp, _ := previewFingerprint(t, web.URL, "s1")

	// No drift — commit immediately with the matching fingerprint.
	status, body := postArchiveFP(t, web.URL, "s1", fp)
	if status != http.StatusOK {
		t.Fatalf("matching-fingerprint commit: got %d, want 200", status)
	}
	affected, _ := body["affected"].([]any)
	if len(affected) != 2 || !containsAny(affected, "s1") || !containsAny(affected, "c1") {
		t.Fatalf("matching-fingerprint affected: want [s1 c1], got %v", affected)
	}
	// Archive really happened.
	if patches := archivedPATCHes(f); len(patches) != 2 {
		t.Fatalf("matching fingerprint: want 2 SetArchived PATCHes [s1 c1], got %v", patches)
	}
	if agg.Store().Descendants("s1") != nil {
		t.Fatal("matching fingerprint: sessions must be removed from the live store")
	}
}

// TestArchiveDrift_AbsentFingerprint_BackwardCompat pins the opt-in contract:
// when expectedFingerprint is absent (legacy FE, unattended programmatic
// archives), the handler applies the current no-precondition behavior — no 409,
// archive proceeds. This matches the If-Idle-Seq opt-in precedent (verbs.go).
func TestArchiveDrift_AbsentFingerprint_BackwardCompat(t *testing.T) {
	f := &fakeOC{}
	web, agg, srv, _ := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c1","parentID":"s1"}}`))

	// POST with NO expectedFingerprint even though a spawn happened — must NOT
	// 409 (no fence applied).
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c2","parentID":"s1"}}`))
	status, body := postArchiveFP(t, web.URL, "s1", "") // no fingerprint
	if status != http.StatusOK {
		t.Fatalf("absent-fingerprint commit: got %d, want 200 (backward-compat)", status)
	}
	affected, _ := body["affected"].([]any)
	if len(affected) != 3 {
		t.Fatalf("absent fingerprint: want 3 affected (current behavior, all live), got %v", affected)
	}
	if len(archivedPATCHes(f)) != 3 {
		t.Fatalf("absent fingerprint: want 3 SetArchived PATCHes, got %v", archivedPATCHes(f))
	}
}

// TestArchiveDrift_InternalReparent_NotRejected pins the named exception: an
// internal reparent (an id stays inside the subtree) does NOT change the
// descendant id-set, so the fingerprint is unchanged and the commit proceeds.
// Only membership changes (spawn / delete / reparent across the boundary)
// reject. The descendant set {s1, c1, g1} is preserved whether g1 is parented
// under c1 or directly under s1.
func TestArchiveDrift_InternalReparent_NotRejected(t *testing.T) {
	f := &fakeOC{}
	web, agg, srv, _ := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c1","parentID":"s1"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"g1","parentID":"c1"}}`)) // grandchild under c1

	fp, _ := previewFingerprint(t, web.URL, "s1") // fingerprint of {s1, c1, g1}

	// Internal reparent: move g1 from c1 to s1 (both inside the subtree). The
	// id-set {s1, c1, g1} is unchanged → fingerprint unchanged → no 409.
	agg.Store().Apply(ev("session.created", `{"info":{"id":"g1","parentID":"s1"}}`))

	// Sanity: the live descendant set is still exactly {s1, c1, g1}.
	if got := agg.Store().Descendants("s1"); len(got) != 3 {
		t.Fatalf("post-reparent Descendants(s1): want 3 ids, got %v", got)
	}

	status, body := postArchiveFP(t, web.URL, "s1", fp)
	if status != http.StatusOK {
		t.Fatalf("internal-reparent commit: got %d, want 200 (id-set unchanged, no 409)", status)
	}
	affected, _ := body["affected"].([]any)
	if len(affected) != 3 {
		t.Fatalf("internal reparent affected: want 3 [s1 c1 g1], got %v", affected)
	}
}

// TestArchiveDrift_DescendantsEndpointReturnsFingerprint pins the additive
// envelope contract: GET /vh/session/:id/descendants now includes
// data.fingerprint alongside the existing {sessionId, descendants}. This is
// the only wire-shape change on the preview side (additive — old FEs ignore it).
func TestArchiveDrift_DescendantsEndpointReturnsFingerprint(t *testing.T) {
	f := &fakeOC{}
	web, agg, _, _ := queueLifecycleServer(t, f)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1","title":"R"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c1","parentID":"s1","title":"C"}}`))

	fp, ids := previewFingerprint(t, web.URL, "s1")
	if len(ids) != 2 {
		t.Fatalf("descendants want [s1 c1], got %v", ids)
	}
	// The fingerprint is a 64-char sha256-hex of the sorted id-set.
	if len(fp) != 64 {
		t.Fatalf("fingerprint len want 64 (sha256 hex), got %d (%q)", len(fp), fp)
	}
	// And it matches a fresh recompute over the same id-set via the public
	// state.FingerprintIDs — proving preview + commit use the identical pure
	// function (the handler calls the same helper the test pins here).
	if want := state.FingerprintIDs([]string{"s1", "c1"}); fp != want {
		t.Fatalf("preview fingerprint %q != state.FingerprintIDs %q", fp, want)
	}
}

// containsAny reports whether the any-slice contains the given string (the
// JSON-decoded affected lists arrive as []any).
func containsAny(xs []any, s string) bool {
	for _, x := range xs {
		if v, ok := x.(string); ok && v == s {
			return true
		}
	}
	return false
}
