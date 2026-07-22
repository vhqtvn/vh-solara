package e2e

// In-process e2e coverage for the server-side session DEMOTION transition — the
// exact mechanism behind the idle-root-unopenable bug: a session's subtree goes
// idle past the projection cutoff → collapses to a CollapsedBranchStub →
// serializes into a projected snapshot → reaches the client over the stream.
//
// This is "Option C" / "massive test" coverage for the projection lifecycle. It
// exercises the REAL pkg/state projection code (selfActiveLocked /
// descendActiveClosureLocked / buildStubLocked) through the REAL worker web
// server (handleStream proj=1 path) driven by the REAL aggregator backed by the
// REAL fake OpenCode fixture. The only deviation from production is the cutoff
// duration, shrunk via the test-only state.SetProjectionCutoffForTest hook so
// the transition is observable without a 10-minute wall-clock wait. That hook
// mirrors the accepted web.SetStaleDispatchThresholdForTest precedent
// (pkg/web/queue.go) and is production-default-off.
//
// The shared `cluster` (TestMain in coordination_test.go) is used. Every test
// arms the cutoff override and restores the production default (10m / v1) in a
// t.Cleanup so the tiny cutoff never leaks into sibling tests in the same
// `go test` run.
//
// WHY THE WORKER-LOCAL STREAM (not the coordination tunnel): the coordination
// API's /vh/stream proxy (pkg/server/coordapi.go coordEvents) rebuilds the
// upstream query via dirQuery, which carries ONLY `dir`+`sessions`+`cursor` —
// `proj=1` is STRIPPED through the tunnel, so a projected (stub-bearing)
// snapshot is NOT observable over the coordination path without a pkg/server
// change (forbidden by this slice's constraints). The worker-local
// /vh/stream?proj=1 path (cluster.WorkerVHURL, the same httptest server the
// queue_recovery suite drives) runs the identical projection code and is the
// faithful achievable observation surface. This deviation is documented here
// and reported in the closeout.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/state"
)

// testCutoff is the shrunk projection cutoff used by this suite. The production
// default is 10*time.Minute (pkg/state/projection.go: defaultProjectionCutoff).
// testCutoffVersion is bumped to 2 so the snapshot envelope's cutoffVersion
// field visibly reflects the override (the client uses it to detect a boundary
// change).
const (
	testCutoff        = 250 * time.Millisecond
	testCutoffVersion = uint32(2)
	// targetSessionID is the fixture session this suite drives through the
	// demotion lifecycle. It is deliberately "other" (NOT "demo"): the sibling
	// coordination tests (TestE2E_SpawnSendAbortOverTunnel aborts demo;
	// TestE2E_MCPOverController/_MCPLocalModeDirectToWorker send_message to
	// demo, leaving an in-flight assistant that resists /fixture/reset) contend
	// on "demo". "other" is a pristine idle ROOT session
	// (pkg/fixtures/opencode.go seed: {"id":"other", ...} no parentID) that no
	// other test in the package touches, so the lifecycle assertions are
	// isolated from cross-test fixture mutation. An idle leaf root still gets a
	// collapsed-branch stub (see CollapsedBranchStub.HasChildren doc), so the
	// demotion/re-materialization contract is fully exercisable on it.
	targetSessionID = "other"
)

// streamClient fails fast (5s) if a projected snapshot never arrives instead
// of hanging the test on the otherwise long-lived stream connection.
var streamClient = http.Client{Timeout: 5 * time.Second}

// projectedGateFact mirrors the gate slice of a projected snapshot, keyed by
// sessionID. Only ACTIVE (busy/retry/pending/recent-within-cutoff) sessions get
// a gate entry; idle-past-cutoff sessions do NOT appear here (they are in
// stubs).
type projectedGateFact struct {
	Activity string `json:"activity"`
}

// projectedSnapshot captures the fields of a projected snapshot envelope that
// this suite asserts against. Sessions is the wholesale-style list of FULL
// session payloads (each carries an "id"); stubs is the collapsed-frontier list
// (each carries id + kind). projected/cause/cutoffVersion/cutoffMs are stamped
// by SnapshotProjected via projectionCutoff() and are asserted to prove the
// override took effect.
type projectedSnapshot struct {
	Projected     bool                         `json:"projected"`
	Cause         string                       `json:"cause"`
	CutoffVersion uint32                       `json:"cutoffVersion"`
	CutoffMs      uint64                       `json:"cutoffMs"`
	Gate          map[string]projectedGateFact `json:"gate"`
	Sessions      []json.RawMessage            `json:"sessions"`
	Stubs         []struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
	} `json:"stubs"`
}

// armProjectionCutoff arms the test-only cutoff override and schedules a
// production-default restore + fixture reset for the demo session. It MUST be
// called at the top of every test in this file (the cluster is shared). The
// restore is unconditional so a leaked tiny cutoff never shortens demotion for
// sibling tests in the same `go test` run.
func armProjectionCutoff(t *testing.T) {
	t.Helper()
	state.SetProjectionCutoffForTest(testCutoff, testCutoffVersion)
	t.Cleanup(func() {
		state.SetProjectionCutoffForTest(0, 0)
		postFixture(t, "/fixture/reset?session="+targetSessionID)
	})
}

// fetchProjectedSnapshot opens a FRESH /vh/stream?proj=1 connection to the
// worker, reads SSE frames until the first `event: snapshot`, and parses its
// `data:` JSON. Opening a new stream is the cleanest deterministic snapshot
// rebuild trigger: each stream open calls store.SnapshotProjected(filter,
// "initial", ...) (pkg/web/server.go handleStream ~line 1475), which re-runs
// the demotion logic against the CURRENT cutoff + activity state. The body is
// closed as soon as the snapshot frame is parsed (the stream otherwise stays
// open, live-tailing events).
func fetchProjectedSnapshot(t *testing.T) projectedSnapshot {
	t.Helper()
	resp, err := streamClient.Get(cluster.WorkerVHURL + "/vh/stream?proj=1")
	if err != nil {
		t.Fatalf("open projected stream: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("projected stream: want 200, got %d", resp.StatusCode)
	}
	// The demo fixture snapshot is small, but bump the scanner buffer so a
	// large single-line JSON data frame never silently truncates.
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		if sc.Text() != "event: snapshot" {
			continue
		}
		// The data: line follows the event: line (writeRaw emits
		// id/event/data). Scan until it appears.
		for sc.Scan() {
			line := sc.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			payload := strings.TrimPrefix(line, "data: ")
			var snap projectedSnapshot
			if err := json.Unmarshal([]byte(payload), &snap); err != nil {
				t.Fatalf("decode projected snapshot: %v (data=%.120s)", err, payload)
			}
			return snap
		}
	}
	t.Fatalf("projected stream closed before emitting a snapshot event")
	return projectedSnapshot{}
}

// hasFullSession reports whether id appears as a FULL (non-stub) session in the
// snapshot — either as an active gate entry or in the full-sessions list.
func hasFullSession(s projectedSnapshot, id string) bool {
	if _, ok := s.Gate[id]; ok {
		return true
	}
	for _, raw := range s.Sessions {
		var m struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(raw, &m) == nil && m.ID == id {
			return true
		}
	}
	return false
}

// stubKind returns the stub Kind for id ("collapsed-branch" for a collapsed
// subtree) and whether such a stub is present.
func stubKind(s projectedSnapshot, id string) (kind string, ok bool) {
	for _, st := range s.Stubs {
		if st.ID == id {
			return st.Kind, true
		}
	}
	return "", false
}

// postFixture POSTs a /oc/fixture/* path through the worker's OpenCode
// passthrough proxy (pkg/web/server.go handlePassthrough trims the /oc prefix
// and reverse-proxies to the fake). A CSRF header is sent on every call: the
// worker's csrfGuard requires it for unsafe-method /oc/* requests, so POSTing
// (rather than GETing) the state-changing fixture ops is the conservative,
// proven shape (mirrors queue_recovery_test.go's postJSON). Body is empty —
// the fixture handlers read only the query string.
func postFixture(t *testing.T, path string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, cluster.WorkerVHURL+"/oc"+path, nil)
	if err != nil {
		t.Fatalf("new fixture request: %v", err)
	}
	req.Header.Set(csrfHeaderName, csrfHeaderValue)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("fixture POST %s: %v", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("fixture POST %s: want 200, got %d", path, resp.StatusCode)
	}
	// Drain so the keep-alive connection is reusable.
	bufio.NewReader(resp.Body).Reset(bytes.NewReader(nil))
}

// ensureIdlePastCutoff drives the target session to a known idle baseline: it
// resets the session (clears busy + emits session.idle, bumping lastActivityAt
// to now), sleeps past the cutoff, and POLLS the projected snapshot until the
// target is confirmed idle (a stub) so the caller starts from a deterministic
// state. Call this at the start of every test in this file (tests share the
// cluster + fixture). The poll guards against slow async propagation of the
// session.idle event through the aggregator.
func ensureIdlePastCutoff(t *testing.T) {
	t.Helper()
	postFixture(t, "/fixture/reset?session="+targetSessionID)
	time.Sleep(testCutoff + 150*time.Millisecond)
	waitFor(t, func() bool {
		s := fetchProjectedSnapshot(t)
		_, isStub := stubKind(s, targetSessionID)
		return isStub && !hasFullSession(s, targetSessionID)
	}, "ensureIdlePastCutoff: target should be an idle stub at baseline")
}

// waitFor returns true if cond becomes true within the poll budget, else fails
// the test with msg. The activity events (session.status/session.idle) travel
// asynchronously from the fixture through the aggregator to the store, so a
// short poll is required when asserting a just-driven transition.
func waitFor(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("waitFor timed out: %s", msg)
}

// TestProjectionDemotion_StubBaselineIdle proves the baseline stub emission
// path: an idle-past-cutoff session appears in the projected snapshot as a
// collapsed-branch stub (NOT as a full session), and the snapshot envelope
// carries the override cutoffVersion (proving the hook reached the shared
// cluster's store). This is the zero-scaffolding part of the slice — it
// validates that stubs are constructed and serialized over the stream.
func TestProjectionDemotion_StubBaselineIdle(t *testing.T) {
	armProjectionCutoff(t)
	ensureIdlePastCutoff(t)

	snap := fetchProjectedSnapshot(t)

	// The override took effect (the hook reached the shared cluster's store).
	if snap.CutoffVersion != testCutoffVersion {
		t.Fatalf("cutoffVersion: want %d (override), got %d — SetProjectionCutoffForTest did not reach the store", testCutoffVersion, snap.CutoffVersion)
	}
	if snap.CutoffMs != uint64(testCutoff.Milliseconds()) {
		t.Fatalf("cutoffMs: want %d, got %d", uint64(testCutoff.Milliseconds()), snap.CutoffMs)
	}
	if !snap.Projected {
		t.Fatalf("snapshot not projected (cause=%q) — stream did not honor proj=1", snap.Cause)
	}

	// demo is idle-past-cutoff → must be a stub, NOT a full session.
	if hasFullSession(snap, targetSessionID) {
		t.Fatalf("demo should be collapsed to a stub (idle-past-cutoff) but appears as a full session; gate=%v", snap.Gate)
	}
	kind, ok := stubKind(snap, targetSessionID)
	if !ok {
		t.Fatalf("demo should appear as a collapsed-branch stub; stubs=%+v", snap.Stubs)
	}
	if kind != "collapsed-branch" {
		t.Fatalf("demo stub kind: want \"collapsed-branch\", got %q", kind)
	}
}

// TestProjectionDemotion_FullStubFullTransition is the core deliverable: it
// proves the server-side DEMOTION transition end-to-end over the stream — the
// exact mechanism behind the idle-root-unopenable bug. The full lifecycle is
// round-tripped:
//  1. busy  → demo is a FULL session (active gate entry), not a stub.
//  2. idle  → after the cutoff, demo DEMOTES to a collapsed-branch stub.
//  3. busy  → demo RE-MATERIALIZES as a full session.
//
// Each observation opens a fresh projected stream, which deterministically
// rebuilds the snapshot (handleStream → SnapshotProjected "initial") — that
// stream-(re)open is the snapshot-rebuild trigger.
func TestProjectionDemotion_FullStubFullTransition(t *testing.T) {
	armProjectionCutoff(t)
	ensureIdlePastCutoff(t)

	// --- Phase 1: ACTIVE → FULL -------------------------------------------
	// /fixture/busy emits session.status{busy} → bumps lastActivityAt +
	// activity=busy → selfActiveLocked is true (busy) → demo is full.
	postFixture(t, "/fixture/busy?session="+targetSessionID)
	waitFor(t, func() bool {
		s := fetchProjectedSnapshot(t)
		return hasFullSession(s, targetSessionID)
	}, "demo should become a FULL session after /fixture/busy")

	// Sanity: while busy, demo must NOT be a stub.
	busySnap := fetchProjectedSnapshot(t)
	if _, ok := stubKind(busySnap, targetSessionID); ok {
		t.Fatalf("demo is busy yet appears as a stub; a busy session must stay full (stubs=%+v)", busySnap.Stubs)
	}
	if gf, ok := busySnap.Gate[targetSessionID]; !ok {
		t.Fatalf("demo busy snapshot missing gate entry; gate=%v", busySnap.Gate)
	} else if gf.Activity != "busy" {
		t.Fatalf("demo gate activity while busy: want \"busy\", got %q", gf.Activity)
	}

	// --- Phase 2: IDLE past cutoff → DEMOTE to STUB -----------------------
	// /fixture/reset clears busy + emits session.idle (bumps lastActivityAt to
	// now). Sleep longer than the cutoff so demo is idle-past-cutoff; the next
	// snapshot construction demotes it.
	postFixture(t, "/fixture/reset?session="+targetSessionID)
	time.Sleep(testCutoff + 150*time.Millisecond)

	waitFor(t, func() bool {
		s := fetchProjectedSnapshot(t)
		_, isStub := stubKind(s, targetSessionID)
		return isStub && !hasFullSession(s, targetSessionID)
	}, "demo should DEMOTE to a collapsed-branch stub after going idle past the cutoff")

	demotedSnap := fetchProjectedSnapshot(t)
	kind, ok := stubKind(demotedSnap, targetSessionID)
	if !ok {
		t.Fatalf("post-demotion snapshot: demo should be a stub; stubs=%+v", demotedSnap.Stubs)
	}
	if kind != "collapsed-branch" {
		t.Fatalf("post-demotion stub kind: want \"collapsed-branch\", got %q", kind)
	}
	if hasFullSession(demotedSnap, targetSessionID) {
		t.Fatalf("post-demotion snapshot: demo should NOT be a full session; gate=%v", demotedSnap.Gate)
	}

	// --- Phase 3: RE-ACTIVATE → RE-MATERIALIZE as FULL --------------------
	// A second busy proves the lifecycle round-trips: a once-collapsed stub
	// returns to a full session when activity resumes. This is the recovery
	// half of the idle-root-unopenable fix surface.
	postFixture(t, "/fixture/busy?session="+targetSessionID)
	waitFor(t, func() bool {
		s := fetchProjectedSnapshot(t)
		return hasFullSession(s, targetSessionID)
	}, "demo should RE-MATERIALIZE as a full session after re-activation")

	rematSnap := fetchProjectedSnapshot(t)
	if !hasFullSession(rematSnap, targetSessionID) {
		t.Fatalf("re-materialization: demo should be full again; gate=%v stubs=%+v", rematSnap.Gate, rematSnap.Stubs)
	}
	if _, ok := stubKind(rematSnap, targetSessionID); ok {
		t.Fatalf("re-materialization: demo should no longer be a stub; stubs=%+v", rematSnap.Stubs)
	}
}

// readNextSnapshot scans an OPEN SSE response body for the next
// `event: snapshot` frame and decodes its `data:` JSON into dst. Returns false
// (without failing) if the body closes or the read errors before a snapshot
// frame — the caller decides whether that is a test failure (e.g. a promotion
// that never arrived). Non-snapshot frames (activity, ping) are skipped. This
// is the KEEP-STREAM-OPEN reader the fresh-stream-per-poll helpers cannot
// provide: the response body stays open across multiple snapshot frames.
func readNextSnapshot(t *testing.T, sc *bufio.Scanner, dst *projectedSnapshot) bool {
	t.Helper()
	for sc.Scan() {
		if sc.Text() != "event: snapshot" {
			continue
		}
		for sc.Scan() {
			line := sc.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			payload := strings.TrimPrefix(line, "data: ")
			if err := json.Unmarshal([]byte(payload), dst); err != nil {
				t.Fatalf("decode snapshot: %v (data=%.120s)", err, payload)
			}
			return true
		}
	}
	// A context-deadline cancellation (the stream's bounded ctx expired) is the
	// expected end-of-body for an open stream; don't fatal on it.
	if err := sc.Err(); err != nil && !errors.Is(err, context.Canceled) {
		t.Fatalf("stream read error: %v", err)
	}
	return false
}

// TestProjectionDemotion_SweepDemotesOnAlreadyOpenStream is THE proving test
// for the Phase-2 time-driven demotion sweep. The gap it closes: a projection
// re-snapshot carrying a DEMOTION fires only on initial/reconnect/
// ev.FrontierChanged (all event/connection-driven), but DEMOTION is a wall-
// clock transition — a session idle at T becomes stub-eligible at T+cutoff with
// NO event firing. On an ALREADY-OPEN proj=1 stream, the idle session lingered
// materialized until an unrelated frontier change or reconnect. The sweep
// goroutine (Store.RunDemotionSweep, started by aggregator.Run) catches that
// crossing and arms the promotion-coalesce path, so the open stream receives a
// "promotion" snapshot in which the session is now a stub.
//
// This is the assertion the fresh-stream-per-poll tests above CANNOT make:
// every fetchProjectedSnapshot call re-opens the stream, which re-projects at
// current time and masks the gap. Here the stream stays OPEN across the cutoff
// crossing — the only signal that can reach the client is the sweep.
//
// FAIL-without (sweep absent → open stream never receives the demotion) /
// PASS-with.
func TestProjectionDemotion_SweepDemotesOnAlreadyOpenStream(t *testing.T) {
	armProjectionCutoff(t)

	// --- Baseline: drive target BUSY so it is a FULL session. ---------------
	// The fresh-stream poll here ALSO updates lastNotifiedClosure (via
	// SnapshotProjected), so the sweep's shrink baseline includes the target
	// before we drive the demotion below.
	postFixture(t, "/fixture/busy?session="+targetSessionID)
	waitFor(t, func() bool {
		s := fetchProjectedSnapshot(t)
		return hasFullSession(s, targetSessionID)
	}, "baseline: target should be a FULL session after /fixture/busy")

	// --- Open a projected stream and KEEP IT OPEN. -------------------------
	// The stream stays open across the cutoff crossing below — this is what
	// the fresh-stream-per-poll tests cannot exercise. A 5s deadline bounds the
	// read so the test fails fast instead of hanging on a missing sweep.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		cluster.WorkerVHURL+"/vh/stream?proj=1", nil)
	if err != nil {
		cancel()
		t.Fatalf("new stream request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatalf("open stream: %v", err)
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)

	// Consume the initial snapshot (target is full here).
	var initSnap projectedSnapshot
	if !readNextSnapshot(t, sc, &initSnap) {
		t.Fatal("stream closed before initial snapshot")
	}
	if !hasFullSession(initSnap, targetSessionID) {
		t.Fatalf("initial snapshot: target should be a FULL session (busy baseline); gate=%v stubs=%+v",
			initSnap.Gate, initSnap.Stubs)
	}

	// --- Drive the demotion: reset to idle, sleep past cutoff. -------------
	// /fixture/reset clears busy + emits session.idle (bumps lastActivityAt to
	// now). busy→idle does NOT arm FrontierChanged (wasSelfActive=true), so NO
	// event-driven promotion snapshot fires — the ONLY signal that can reach
	// the open stream is the sweep. Sleep past the 250ms cutoff so the target
	// ages out of the active closure.
	postFixture(t, "/fixture/reset?session="+targetSessionID)
	// The sweep ticks every max(testCutoff/10, 1ms) = 25ms. Within ~25ms of the
	// cutoff crossing it arms; the 150ms coalesce then flushes. Budget 3s.
	time.Sleep(testCutoff + 50*time.Millisecond) // ensure past-cutoff before reading

	// --- Assert: the open stream received a promotion snapshot demoting target. ---
	promoCount := 0
	var demoteSnap projectedSnapshot
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var snap projectedSnapshot
		if !readNextSnapshot(t, sc, &snap) {
			break // stream closed (ctx deadline) before another snapshot
		}
		if snap.Cause == "promotion" {
			promoCount++
			if _, isStub := stubKind(snap, targetSessionID); isStub && !hasFullSession(snap, targetSessionID) {
				demoteSnap = snap
				break
			}
		}
	}

	if promoCount == 0 {
		t.Fatal("open stream received ZERO promotion snapshots after idle-past-cutoff — " +
			"the demotion sweep did not fire (time-driven gap is present)")
	}
	if demoteSnap.Cause == "" {
		t.Fatalf("open stream shipped %d promotion snapshot(s) but NONE demoted target to a stub — "+
			"the sweep fired but the snapshot did not reflect the demotion (last snap gate=%v)",
			promoCount, demoteSnap.Gate)
	}
	kind, ok := stubKind(demoteSnap, targetSessionID)
	if !ok || kind != "collapsed-branch" {
		t.Fatalf("demotion snapshot: target should be a collapsed-branch stub; stubs=%+v", demoteSnap.Stubs)
	}
	if hasFullSession(demoteSnap, targetSessionID) {
		t.Fatalf("demotion snapshot: target should NOT be a full session; gate=%v", demoteSnap.Gate)
	}
}
