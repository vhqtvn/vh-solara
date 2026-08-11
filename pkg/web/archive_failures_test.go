package web

// Archive-failure visibility — Slice 1 regression tests.
//
// This file covers the Slice-1 subset of the archive-failure visibility feature:
// a permanently-stuck archive ROOT (OpenCode 400/403, or retry-budget exhaust
// on a root/unresolvable chain) becomes visible on the mobile SPA via a
// persistent banner, the visibility survives reconnect via the SSE snapshot
// bootstrap, clears when a retry succeeds (clear-on-success at the success
// funnel), and never conflates with the orphan banner.
//
// RT map (Slice-1 subset — Slice 2 owns the backstop-concurrency test):
//   RT1  Stuck root visible AFTER the 200-accepted response returned.
//   RT2  Bootstrap snapshot: a client connecting AFTER the failure receives it.
//   RT3  Disconnect/reconnect does not lose unresolved failures.
//   RT4  Retry acceptance (200) does NOT prematurely clear the warning.
//   RT5  Successful bg retry clears the record + broadcasts to all clients.
//   RT6  Repeat permanent failure UPSERTS one coherent record (no duplicates).
//   RT7  Tenant isolation: another project's failures don't appear here.
//   RT10 Reason displayed is the classified token, never raw opencode.Error.Body.
//
// Frontend RTs (tree-independence, dismiss-no-erase, reason display) live under
// web/tests/unit/ArchiveFailureBanner.test.tsx.

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// decodeArchiveFailuresSSE decodes an archive-failures.{snapshot,updated} SSE
// data payload. Both frames carry the same archiveFailuresDoc shape.
func decodeArchiveFailuresSSE(t *testing.T, data string) archiveFailuresDoc {
	t.Helper()
	var r archiveFailuresDoc
	if err := json.Unmarshal([]byte(data), &r); err != nil {
		t.Fatalf("decode archive-failures SSE data: %v (data: %s)", err, data)
	}
	return r
}

// archiveFailureIDs is a convenience for membership assertions.
func archiveFailureIDs(doc archiveFailuresDoc) map[string]bool {
	out := make(map[string]bool, len(doc.Failures))
	for _, f := range doc.Failures {
		out[f.ID] = true
	}
	return out
}

// hasArchiveFailureID reports whether id appears in srv's registry (any project).
func hasArchiveFailureID(t *testing.T, srv *Server, id string) bool {
	t.Helper()
	for _, fl := range srv.ArchiveFailures() {
		if fl.ID == id {
			return true
		}
	}
	return false
}

// RT1 — a permanently-stuck archive root (OpenCode 403) is recorded in the
// registry AFTER the 200-accepted handler response returned. This is the core
// visibility gap Slice 1 closes: the SPA saw the 200-accepted and assumed
// success; the stuck root was invisible. Now ArchiveFailures() surfaces it.
func TestArchiveFailures_StuckRootVisibleAfterAccepted(t *testing.T) {
	f := &fakeOC{archiveStatusByID: map[string]int{"r": http.StatusForbidden}}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetArchiveRetryConfig(3, 1*time.Millisecond, 2*time.Millisecond)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	seedQueueFile(t, root, "r")

	resp, _ := postArchive(t, web.URL, "r")
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive: got %d, want 200 (job accepted)", resp.StatusCode)
	}
	// The handler returned 200-accepted. The cascade is async. The stuck root
	// must become visible once the job reaches terminal state.
	srv.awaitArchiveJobs(t, 5*time.Second)

	if !hasArchiveFailureID(t, srv, "r") {
		t.Errorf("stuck root r not in ArchiveFailures after 200-accepted + job terminal (visibility gap): %+v", srv.ArchiveFailures())
	}
	// RT10 (backend half): the recorded reason is the classified token, and the
	// registry never carries raw opencode.Error.Body.
	for _, fl := range srv.ArchiveFailures() {
		if fl.ID == "r" {
			if fl.Reason != "permanent:403" {
				t.Errorf("reason = %q, want classified token %q", fl.Reason, "permanent:403")
			}
			if strings.Contains(fl.Reason, "Body") {
				t.Errorf("reason carries raw Body prose (must be classified token only): %q", fl.Reason)
			}
			if fl.Dir != "" {
				t.Errorf("Dir = %q, want empty (default project)", fl.Dir)
			}
		}
	}
}

// RT2 — a client connecting AFTER the failure receives it in the initial SSE
// snapshot (the bootstrap catch-up). The registry is in-memory + not replayed,
// so the archive-failures.snapshot frame IS the catch-up for a late client.
func TestArchiveFailures_BootstrapSnapshot(t *testing.T) {
	f := &fakeOC{archiveStatusByID: map[string]int{"r": http.StatusForbidden}}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetArchiveRetryConfig(3, 1*time.Millisecond, 2*time.Millisecond)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	seedQueueFile(t, root, "r")

	// Drive the failure into the registry FIRST (no client connected yet).
	postArchive(t, web.URL, "r")
	srv.awaitArchiveJobs(t, 5*time.Second)
	if !hasArchiveFailureID(t, srv, "r") {
		t.Fatalf("seed: r not recorded before bootstrap test")
	}

	// NOW connect a fresh SSE stream — the snapshot must carry r.
	sresp, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatalf("GET /vh/stream: %v", err)
	}
	defer sresp.Body.Close()
	ch := startSSEReader(t, sresp.Body)
	events := drainIdle(ch, 600*time.Millisecond)

	snapData, ok := eventDataFor(events, "archive-failures.snapshot", "failures")
	if !ok {
		t.Fatalf("fresh connect did not receive archive-failures.snapshot; events: %v", eventNames(events))
	}
	doc := decodeArchiveFailuresSSE(t, snapData)
	if !archiveFailureIDs(doc)["r"] {
		t.Errorf("bootstrap snapshot missing stuck root r; doc=%+v", doc)
	}
	// RT10: the snapshot DTO carries the classified token only.
	for _, fl := range doc.Failures {
		if fl.ID == "r" && fl.Reason != "permanent:403" {
			t.Errorf("snapshot reason = %q, want %q", fl.Reason, "permanent:403")
		}
		if strings.Contains(snapData, "Body") {
			t.Errorf("snapshot carries raw Body prose: %s", snapData)
		}
	}
}

// RT3 — disconnect/reconnect does not lose unresolved failures. The snapshot
// is emitted on EVERY fresh connect, so a client that disconnects and reconnects
// re-receives the still-unresolved failure.
func TestArchiveFailures_ReconnectNoLoss(t *testing.T) {
	f := &fakeOC{archiveStatusByID: map[string]int{"r": http.StatusForbidden}}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetArchiveRetryConfig(3, 1*time.Millisecond, 2*time.Millisecond)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	seedQueueFile(t, root, "r")

	postArchive(t, web.URL, "r")
	srv.awaitArchiveJobs(t, 5*time.Second)

	// First connection.
	s1, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatal(err)
	}
	ch1 := startSSEReader(t, s1.Body)
	ev1 := drainIdle(ch1, 500*time.Millisecond)
	if _, ok := eventDataFor(ev1, "archive-failures.snapshot", "r"); !ok {
		t.Fatalf("first connect snapshot missing r; events=%v", eventNames(ev1))
	}
	s1.Body.Close()

	// Second connection (simulate reconnect).
	s2, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Body.Close()
	ch2 := startSSEReader(t, s2.Body)
	ev2 := drainIdle(ch2, 500*time.Millisecond)
	if _, ok := eventDataFor(ev2, "archive-failures.snapshot", "r"); !ok {
		t.Fatalf("reconnect snapshot missing r (unresolved failure lost on reconnect); events=%v", eventNames(ev2))
	}
}

// RT4 — retry acceptance (200) does NOT prematurely clear the warning. The
// 200-accepted handler response MUST NOT clear the record; only the bg job's
// success funnel does. This is the load-bearing clear-lifecycle rule.
func TestArchiveFailures_RetryAcceptedDoesNotClear(t *testing.T) {
	f := &fakeOC{archiveStatusByID: map[string]int{"r": http.StatusForbidden}}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetArchiveRetryConfig(3, 1*time.Millisecond, 2*time.Millisecond)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	seedQueueFile(t, root, "r")

	// First archive: r fails permanently → recorded.
	postArchive(t, web.URL, "r")
	srv.awaitArchiveJobs(t, 5*time.Second)
	if !hasArchiveFailureID(t, srv, "r") {
		t.Fatalf("seed: r not recorded")
	}

	// Now flip fakeOC to SUCCESS and re-issue (the retry). The handler returns
	// 200-accepted. The record MUST still be present immediately after the
	// handler responds (before the bg job runs) — acceptance ≠ success.
	f.archiveStatusByID = nil // r now PATCHes 200 (success)
	resp, _ := postArchive(t, web.URL, "r")
	if resp.StatusCode != 200 {
		t.Fatalf("retry /vh/archive: got %d, want 200 (accepted)", resp.StatusCode)
	}
	// Assert IMMEDIATELY — no awaitArchiveJobs. The handler's 200-accepted
	// response must not have cleared the record.
	if !hasArchiveFailureID(t, srv, "r") {
		t.Errorf("record cleared on 200-accepted BEFORE the bg job succeeded (acceptance ≠ success violated)")
	}
}

// RT5 — a successful bg retry clears the record AND broadcasts the clear to all
// connected clients via archive-failures.updated. This is the happy-path
// resolution: the operator sees the warning, clicks retry, the cascade
// succeeds, and every connected client removes the warning.
func TestArchiveFailures_SuccessClearsAndBroadcasts(t *testing.T) {
	f := &fakeOC{archiveStatusByID: map[string]int{"r": http.StatusForbidden}}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetArchiveRetryConfig(3, 1*time.Millisecond, 2*time.Millisecond)
	srv.SetReassertDelay(5 * time.Millisecond)
	// listSessionsReply reports r as archived so the re-assert phase is a no-op.
	f.listSessionsReply = []byte(`[{"id":"r","time":{"archived":1}}]`)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	seedQueueFile(t, root, "r")

	// Seed the failure.
	postArchive(t, web.URL, "r")
	srv.awaitArchiveJobs(t, 5*time.Second)
	if !hasArchiveFailureID(t, srv, "r") {
		t.Fatalf("seed: r not recorded")
	}

	// Connect TWO clients (both receive the snapshot with r).
	s1, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer s1.Body.Close()
	s2, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Body.Close()
	ch1 := startSSEReader(t, s1.Body)
	ch2 := startSSEReader(t, s2.Body)
	drainIdle(ch1, 500*time.Millisecond) // consume bootstrap
	drainIdle(ch2, 500*time.Millisecond)

	// Flip to success + retry.
	f.archiveStatusByID = nil
	postArchive(t, web.URL, "r")
	srv.awaitArchiveJobs(t, 5*time.Second)

	// The registry must no longer carry r (clear-on-success at the funnel).
	if hasArchiveFailureID(t, srv, "r") {
		t.Errorf("r still in registry after successful retry (clear-on-success did not fire): %+v", srv.ArchiveFailures())
	}

	// Both clients must receive an archive-failures.updated frame with an empty
	// failures set (the clear broadcast). Drain with a generous idle to capture
	// the transient fan-out.
	ev1 := drainIdle(ch1, 800*time.Millisecond)
	ev2 := drainIdle(ch2, 800*time.Millisecond)
	for label, evs := range map[string][]sseEvent{"client1": ev1, "client2": ev2} {
		data, ok := eventDataFor(evs, "archive-failures.updated", "failures")
		if !ok {
			t.Errorf("%s: no archive-failures.updated frame after successful retry; events=%v", label, eventNames(evs))
			continue
		}
		doc := decodeArchiveFailuresSSE(t, data)
		if len(doc.Failures) != 0 {
			t.Errorf("%s: updated frame not empty after clear (got %d failures)", label, len(doc.Failures))
		}
	}
}

// RT6 — repeat permanent failure for the same (dir,id) UPSERTS one coherent
// record (refreshed Reason/At), NOT a duplicate append. The registry is a SET
// of unresolved failures keyed by (dir,id), not an append-log.
func TestArchiveFailures_RepeatUpsertsOneRecord(t *testing.T) {
	f := &fakeOC{archiveStatusByID: map[string]int{"r": http.StatusForbidden}}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetArchiveRetryConfig(3, 1*time.Millisecond, 2*time.Millisecond)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	seedQueueFile(t, root, "r")

	// First failure.
	postArchive(t, web.URL, "r")
	srv.awaitArchiveJobs(t, 5*time.Second)
	// Second failure (retry that fails again).
	postArchive(t, web.URL, "r")
	srv.awaitArchiveJobs(t, 5*time.Second)

	fails := srv.ArchiveFailures()
	count := 0
	for _, fl := range fails {
		if fl.ID == "r" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("repeat permanent failure produced %d records for r, want 1 (UPSERT — registry is a set, not an append-log): %+v", count, fails)
	}
}

// RT7 — tenant isolation: another project's failures do NOT appear in this
// project's snapshot or stream. The registry is per-project (dir,id)-keyed, the
// snapshot is filtered to reqDir(r), and the fan-out is per-project (like
// labels, NOT worker-wide like pins).
func TestArchiveFailures_TenantIsolation(t *testing.T) {
	f := &fakeOC{archiveStatusByID: map[string]int{"r": http.StatusForbidden}}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetArchiveRetryConfig(3, 1*time.Millisecond, 2*time.Millisecond)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	seedQueueFile(t, root, "r")

	// Drive a failure in the DEFAULT project ("").
	postArchive(t, web.URL, "r")
	srv.awaitArchiveJobs(t, 5*time.Second)

	// Seed a failure in a DIFFERENT project directly (the registry mutation is
	// package-visible; this models a second project's cascade having failed
	// without needing a second full aggregator + HTTP flow).
	srv.recordArchiveFailure("/other-project", "other-root", "src-other", "exhausted:3")

	// Registry-level isolation: each project's doc carries ONLY its own failures.
	docDefault := srv.archiveFailuresDocForDir("")
	if !archiveFailureIDs(docDefault)["r"] {
		t.Errorf("default project doc missing r: %+v", docDefault)
	}
	if archiveFailureIDs(docDefault)["other-root"] {
		t.Errorf("default project doc leaked other-project's failure (tenant isolation violated): %+v", docDefault)
	}
	docOther := srv.archiveFailuresDocForDir("/other-project")
	if !archiveFailureIDs(docOther)["other-root"] {
		t.Errorf("other-project doc missing other-root: %+v", docOther)
	}
	if archiveFailureIDs(docOther)["r"] {
		t.Errorf("other-project doc leaked default project's r: %+v", docOther)
	}

	// SSE-level isolation: a default-project stream's snapshot carries ONLY r.
	sresp, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer sresp.Body.Close()
	ch := startSSEReader(t, sresp.Body)
	events := drainIdle(ch, 600*time.Millisecond)
	snapData, ok := eventDataFor(events, "archive-failures.snapshot", "failures")
	if !ok {
		t.Fatalf("no archive-failures.snapshot; events=%v", eventNames(events))
	}
	if strings.Contains(snapData, "other-root") {
		t.Errorf("default-project stream snapshot leaked other-project's failure: %s", snapData)
	}
	if !strings.Contains(snapData, `"r"`) {
		t.Errorf("default-project stream snapshot missing r: %s", snapData)
	}

	// Fan-out isolation: a clear in the default project must NOT reach a stream
	// whose dir is /other-project. Record an SSE reader on the default stream,
	// then clear a failure in /other-project and assert the default stream does
	// NOT receive an updated frame mentioning other-root.
	srv.clearArchiveFailure("/other-project", "other-root")
	late := drainIdle(ch, 500*time.Millisecond)
	for _, e := range late {
		if e.event == "archive-failures.updated" && strings.Contains(e.data, "other-root") {
			t.Errorf("default stream received other-project's clear fan-out (tenant isolation violated): %s", e.data)
		}
	}
}
