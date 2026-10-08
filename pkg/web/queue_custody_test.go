package web

// Queue-custody fence tests (send-net-resilience slice 2a; debate-4 B3).
//
// Linux-only scenarios (flock semantics) live behind a runtime.GOOS check so
// the file compiles everywhere and the flock lane simply skips elsewhere —
// mirroring how the production split itself behaves (queue_custody_linux.go
// vs queue_custody_other.go).
//
// The two CRUX scenarios for the slice's behavioral closure are here:
//   - TestQueueCustodyStaleGenerationRejected  (two-instance stale-owner
//     rejection: an old-generation token can neither mutate nor POST)
//   - TestQueueDrainCrashAtEachTransition      (in queue_drain_test.go —
//     journal state on reload is exactly the last durable write)

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// custodyTestRoot enables the TEST-ONLY custody gate for one root and
// releases+disarms on cleanup.
func custodyTestRoot(t *testing.T) string {
	t.Helper()
	SetQueueCustodyEnabledForTest(true)
	t.Cleanup(func() { SetQueueCustodyEnabledForTest(false) })
	return t.TempDir()
}

func TestQueueCustodyDisabledByDefault(t *testing.T) {
	// NO test-enable armed: the production slice-2a posture. Acquisition must
	// fail closed BEFORE any filesystem effect.
	root := t.TempDir()
	_, err := AcquireQueueCustody(root)
	if !errors.Is(err, errQueueCustodyDisabled) {
		t.Fatalf("AcquireQueueCustody err = %v, want errQueueCustodyDisabled", err)
	}
	// Byte-equivalence of the flag-off posture: no custody artifacts exist.
	for _, name := range []string{custodyLockFileRel, custodyGenFileRel} {
		if _, err := os.Stat(filepath.Join(root, ".vh-solara", name)); !os.IsNotExist(err) {
			t.Fatalf("%s exists or stat errored (%v) — disabled acquire must have no filesystem effect", name, err)
		}
	}
}

func TestQueueCustodyExclusiveAndGenerationBump(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)

	a, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	if a.Generation() != 1 {
		t.Fatalf("first generation = %d, want 1", a.Generation())
	}

	// A second owner — a second open file description in the SAME process,
	// which flock excludes exactly like a foreign process — is rejected.
	_, err = AcquireQueueCustody(root)
	if !errors.Is(err, errQueueCustodyHeld) {
		t.Fatalf("second acquire err = %v, want errQueueCustodyHeld", err)
	}

	// Crash simulation: the kernel would free the flock when the process
	// dies; Release drops it deterministically. The next owner reacquires
	// with a MONOTONIC generation bump.
	a.Release()
	b, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
	defer b.Release()
	if b.Generation() != 2 {
		t.Fatalf("second generation = %d, want 2 (monotonic bump)", b.Generation())
	}

	// The stale token A must now be fenced: the generation authority moved.
	if err := a.FenceCheck(); !errors.Is(err, errQueueFenced) {
		t.Fatalf("stale token FenceCheck err = %v, want errQueueFenced", err)
	}
}

func TestQueueCustodyStaleGenerationRejected(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	s := &sessionQueueStore{path: queuePath(root, "s1")}

	a, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatalf("A acquire: %v", err)
	}
	if _, err := s.Enqueue("m1", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	// Crash + new owner: B takes over at generation 2.
	a.Release()
	b, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatalf("B acquire: %v", err)
	}
	defer b.Release()

	// (1) Old-generation A can MUTATE nothing: every custody store method
	// runs the compare-and-fence gate and must reject.
	if _, _, err := s.ClaimForCustody(a); !errors.Is(err, errQueueFenced) {
		t.Fatalf("stale ClaimForCustody err = %v, want errQueueFenced", err)
	}
	if _, err := s.BeginDispatchAttempt(a, "q_nope", 0); !errors.Is(err, errQueueFenced) {
		t.Fatalf("stale BeginDispatchAttempt err = %v, want errQueueFenced", err)
	}
	if err := s.RecordAttemptOutcome(a, "q_nope", 0, QueueAttemptAccepted2xx, ""); !errors.Is(err, errQueueFenced) {
		t.Fatalf("stale RecordAttemptOutcome err = %v, want errQueueFenced", err)
	}

	// (2) Old-generation A can POST nothing: the executor is fenced at its
	// claim, the poster is never invoked, and the still-pending item is
	// untouched on disk (no journal was opened by the stale owner).
	posterCalled := false
	outcome, err := RunQueuedDispatchAttempt(context.Background(), s, "s1", a, 0, func(context.Context, string, json.RawMessage) error {
		posterCalled = true
		return nil
	})
	if !errors.Is(err, errQueueFenced) {
		t.Fatalf("stale executor err = %v, want errQueueFenced", err)
	}
	if posterCalled {
		t.Fatal("stale-generation executor reached the upstream POST — the fence must skip the poster")
	}
	if (outcome != DispatchOutcome{}) {
		t.Fatalf("stale executor outcome = %+v, want zero (nothing claimed)", outcome)
	}
	diskPending, err := os.ReadFile(queuePath(root, "s1"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(diskPending), `"attempts"`) {
		t.Fatalf("stale owner opened an attempt journal: %s", diskPending)
	}

	// (3) PRE-POST FENCE WINDOW (the debate-4 B3 "before every upstream POST"
	// check, component-level): the current owner B journals claim+begin
	// successfully, then a takeover happens before the POST. The exact
	// primitive RunQueuedDispatchAttempt runs immediately before the poster —
	// tok.FenceCheck — must reject B, so the POST would be skipped while the
	// OPEN attempt stays durably journaled (honest evidence for the new
	// owner's reclassification).
	item, won, err := s.ClaimForCustody(b)
	if err != nil || !won {
		t.Fatalf("B claim: err=%v won=%v", err, won)
	}
	idx, err := s.BeginDispatchAttempt(b, item.ID, 0)
	if err != nil {
		t.Fatalf("B begin attempt: %v", err)
	}
	b.Release()
	c, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatalf("C acquire: %v", err)
	}
	defer c.Release()
	if err := b.FenceCheck(); !errors.Is(err, errQueueFenced) {
		t.Fatalf("pre-POST FenceCheck after takeover err = %v, want errQueueFenced (the executor must skip the poster)", err)
	}
	if err := c.FenceCheck(); err != nil {
		t.Fatalf("current owner C FenceCheck: %v", err)
	}
	var qf queueFile
	if err := json.Unmarshal(diskPending, &qf); err != nil {
		t.Fatal(err)
	}
	// The journal B durably wrote survives the takeover: one open attempt
	// under B's generation, and the queue stamped with B's epoch.
	diskAfter, err := os.ReadFile(queuePath(root, "s1"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(diskAfter, &qf); err != nil {
		t.Fatal(err)
	}
	if len(qf.Items) != 1 || len(qf.Items[0].Attempts) != idx+1 {
		t.Fatalf("journal after takeover = %+v, want %d attempts", qf.Items, idx+1)
	}
	last := qf.Items[0].Attempts[idx]
	if last.Generation != b.Generation() || last.TransportClass != "" {
		t.Fatalf("open attempt = %+v, want generation %d + empty transport class", last, b.Generation())
	}
	if qf.FenceGeneration != b.Generation() {
		t.Fatalf("queue.json fenceGeneration = %d, want %d (B's epoch, the last custody writer)", qf.FenceGeneration, b.Generation())
	}
}

func TestQueueCustodyGenerationAuthorityCorruptFailsClosed(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	genPath := filepath.Join(root, ".vh-solara", custodyGenFileRel)
	a, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}

	// A LIVE token's FenceCheck over a corrupt authority (a torn write /
	// disk garbage) fences — cannot prove currency ⇒ must not write. The
	// check runs while the token still holds custody so the released-token
	// revocation path cannot mask the corrupt-authority path.
	for _, garbage := range []string{"{not json", "garbage", "{}"} {
		if err := os.WriteFile(genPath, []byte(garbage), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := a.FenceCheck(); !errors.Is(err, errQueueFenced) {
			t.Fatalf("live FenceCheck over corrupt authority %q err = %v, want errQueueFenced", garbage, err)
		}
	}
	a.Release()

	// The next acquisition over the corrupt authority must fail CLOSED —
	// never rewind to 0 (a rewind could REUSE a generation and silently
	// invalidate the fence).
	if _, err := AcquireQueueCustody(root); !errors.Is(err, errQueueCustodyGenCorrupt) {
		t.Fatalf("acquire over corrupt authority err = %v, want errQueueCustodyGenCorrupt", err)
	}
}

func TestQueueCustodyGenerationCapEnforced(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	// Seed the authority AT the enforced FE-mirror cap: allocation must
	// refuse (errQueueCustodyGenExhausted) rather than mint 2^53.
	genPath := filepath.Join(root, ".vh-solara", custodyGenFileRel)
	if err := os.MkdirAll(filepath.Dir(genPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeCustodyGeneration(genPath, maxCustodyGeneration); err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireQueueCustody(root); !errors.Is(err, errQueueCustodyGenExhausted) {
		t.Fatalf("acquire at cap err = %v, want errQueueCustodyGenExhausted", err)
	}
	// Just below the cap is fine: the last allocatable generation.
	if err := writeCustodyGeneration(genPath, maxCustodyGeneration-1); err != nil {
		t.Fatal(err)
	}
	c, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatalf("acquire below cap: %v", err)
	}
	if c.Generation() != maxCustodyGeneration {
		t.Fatalf("generation = %d, want exactly maxCustodyGeneration", c.Generation())
	}
	c.Release()
}

func TestQueueCustodyClaimStampsFenceGeneration(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	s := &sessionQueueStore{path: queuePath(root, "s1")}
	tok, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	defer tok.Release()

	mustEnqueue(t, s, "m1")
	item, won, err := s.ClaimForCustody(tok)
	if err != nil || !won {
		t.Fatalf("ClaimForCustody: err=%v won=%v", err, won)
	}
	if item.OpencodeMsgID == "" {
		t.Fatal("custody claim did not mint the OpenCode correlation id (mint-at-claim contract)")
	}

	// The durable file carries the owner's generation + the claimed state.
	var qf queueFile
	data, err := os.ReadFile(queuePath(root, "s1"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &qf); err != nil {
		t.Fatal(err)
	}
	if qf.FenceGeneration != tok.Generation() {
		t.Fatalf("fenceGeneration = %d, want %d", qf.FenceGeneration, tok.Generation())
	}
	if len(qf.Items) != 1 || qf.Items[0].State != QueueDispatching {
		t.Fatalf("items = %+v, want the single item dispatching", qf.Items)
	}
}

func TestQueueCustodyGenFileWrittenAtomically(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	a, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Release()

	// The authority file is valid JSON with the exact allocated generation —
	// the shape every future reader (including the FE mirror) depends on.
	// Decoded STRICTLY (pointer member): present, non-null, numeric.
	data, err := os.ReadFile(filepath.Join(root, ".vh-solara", custodyGenFileRel))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Generation *uint64 `json:"generation"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("gen file not valid JSON (%s): %v", data, err)
	}
	if doc.Generation == nil || *doc.Generation != a.Generation() {
		t.Fatalf("gen file = %v, want %d", doc.Generation, a.Generation())
	}
	// Lock file exists but carries no authority (live ownership is the flock,
	// never the file contents).
	fi, err := os.Stat(filepath.Join(root, ".vh-solara", custodyLockFileRel))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Size() != 0 {
		t.Fatalf("lock file unexpectedly non-empty (%d bytes) — the flock is the ownership, the file must stay empty", fi.Size())
	}
}

// TestQueueCustodyGenerationAuthorityStructuralCorruption pins the STRICT
// decode of the generation authority (commit-review B-F1/B-F3): every
// malformed authority shape — absent member ({}), null member, wrong type,
// negative, non-integer number, non-object — must fail acquisition CLOSED
// with errQueueCustodyGenCorrupt. The motivating defect: json.Unmarshal
// into a plain uint64 field silently accepted {} and {"generation":null}
// as generation 0, so acquisition allocated generation 1 AGAIN — reusing a
// fencing generation, the exact silent rewind the doc comment forbids.
func TestQueueCustodyGenerationAuthorityStructuralCorruption(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	genPath := filepath.Join(root, ".vh-solara", custodyGenFileRel)
	if err := os.MkdirAll(filepath.Dir(genPath), 0o755); err != nil {
		t.Fatal(err)
	}

	malformed := []string{
		"{}",                  // absent member — the review's {} case
		`{"generation":null}`, // null member — the review's null case
		`{"generation":-1}`,   // negative: no epoch is negative
		`{"generation":"1"}`,  // wrong type: string
		`{"generation":true}`, // wrong type: bool
		`{"generation":1.5}`,  // non-integer number
		`{"generation":1e2}`,  // exponent form is not an integer literal
		"",                    // empty file: a torn write, not "no owner"
		`[]`,                  // non-object
		`"1"`,                 // non-object
		`1`,                   // non-object
		`{"generation":1,`,    // truncated JSON
	}
	for _, bad := range malformed {
		if err := os.WriteFile(genPath, []byte(bad), 0o644); err != nil {
			t.Fatal(err)
		}
		tok, err := AcquireQueueCustody(root)
		if err == nil {
			// Unexpected success (the defect): release so later shapes
			// report their own signal instead of errQueueCustodyHeld.
			tok.Release()
		}
		if !errors.Is(err, errQueueCustodyGenCorrupt) {
			t.Errorf("acquire over %q: err = %v, want errQueueCustodyGenCorrupt", bad, err)
		}
	}

	// Positive controls — strictness must not overcorrect into rejecting
	// valid authority: an explicit zero is the fresh-project epoch (same as
	// a missing file), and a persisted N allocates N+1 monotonically.
	for _, valid := range []struct {
		doc  string
		want uint64
	}{
		{`{"generation":0}`, 1},
		{`{"generation":3}`, 4},
	} {
		if err := os.WriteFile(genPath, []byte(valid.doc), 0o644); err != nil {
			t.Fatal(err)
		}
		tok, err := AcquireQueueCustody(root)
		if err != nil {
			t.Fatalf("acquire over %s: %v", valid.doc, err)
		}
		if tok.Generation() != valid.want {
			t.Fatalf("acquire over %s = generation %d, want %d", valid.doc, tok.Generation(), valid.want)
		}
		tok.Release()
	}
}

// TestQueueCustodyReleaseRevokesFence (commit-review B-F2/B-F4): fence
// validity ends AT RELEASE, not at the next owner's acquisition. A released
// token must fail FenceCheck immediately — BEFORE the generation authority
// is consulted — so a released owner's executor can never pass its pre-POST
// fence on the strength of an authority file that still names its
// generation. (The dropped D-F3 note: concurrent Release/FenceCheck pairs
// must also be race-free; the probe below runs both, meaningful under
// `go test -race`.)
func TestQueueCustodyReleaseRevokesFence(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	genPath := filepath.Join(root, ".vh-solara", custodyGenFileRel)

	a, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if err := a.FenceCheck(); err != nil {
		t.Fatalf("live token FenceCheck: %v", err)
	}
	a.Release()

	// NO successor ever acquires: the authority still names generation 1,
	// yet the released token must be rejected — by revocation, not by a
	// generation bump (the error names the release).
	cur, err := readCustodyGeneration(genPath)
	if err != nil {
		t.Fatal(err)
	}
	if cur != a.Generation() {
		t.Fatalf("authority = %d, want %d (no successor — isolates the revocation signal)", cur, a.Generation())
	}
	ferr := a.FenceCheck()
	if !errors.Is(ferr, errQueueFenced) {
		t.Fatalf("released token FenceCheck err = %v, want errQueueFenced (revoked at Release, no successor needed)", ferr)
	}
	if !strings.Contains(ferr.Error(), "released") {
		t.Fatalf("rejection reason = %q, want the revocation branch (released), not an authority comparison", ferr)
	}

	// Idempotent Release stays revoked.
	a.Release()
	if err := a.FenceCheck(); !errors.Is(err, errQueueFenced) {
		t.Fatalf("FenceCheck after double Release err = %v, want errQueueFenced", err)
	}

	// Race probe (D-F3, the dropped note): hammer Release and FenceCheck
	// concurrently. Under the token mutex this is race-free and every check
	// fences; without it the c.lock nil-write raced its readers.
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a.Release()
		}()
	}
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := a.FenceCheck(); !errors.Is(err, errQueueFenced) {
				t.Errorf("concurrent released FenceCheck err = %v, want errQueueFenced", err)
			}
		}()
	}
	wg.Wait()
}

// TestQueueCustodyReleasedTokenExecutorNeverPosts (B-F2, executor level):
// the exact pre-POST window the review named — claim and begin succeed
// under the live token, then the token is released BEFORE the executor's
// immediately-before-POST fence, with NO successor. The executor must never
// reach the poster, and the released token must not mutate the store.
func TestQueueCustodyReleasedTokenExecutorNeverPosts(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	s := &sessionQueueStore{path: queuePath(root, "s1")}
	tok, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	mustEnqueue(t, s, "window")
	mustEnqueue(t, s, "window-next") // still pending when the window opens
	item, won, err := s.ClaimForCustody(tok)
	if err != nil || !won {
		t.Fatalf("claim: err=%v won=%v", err, won)
	}
	if _, err := s.BeginDispatchAttempt(tok, item.ID, 0); err != nil {
		t.Fatalf("begin attempt: %v", err)
	}

	// The window: the owner is gone between journaling `sending` and the
	// pre-POST fence. The exact primitive the executor runs at that point
	// must reject, so the poster is skipped while the OPEN attempt stays
	// durably journaled.
	tok.Release()
	if err := tok.FenceCheck(); !errors.Is(err, errQueueFenced) {
		t.Fatalf("pre-POST fence in the release window err = %v, want errQueueFenced (the executor must skip the poster)", err)
	}
	before, err := os.ReadFile(queuePath(root, "s1"))
	if err != nil {
		t.Fatal(err)
	}

	// Executor level: a dispatch attempt driven with the released token
	// must be rejected outright — the poster is unreachable — even though a
	// pending item exists to claim, and NOTHING may land on disk.
	posterCalled := false
	outcome, err := RunQueuedDispatchAttempt(context.Background(), s, "s1", tok, 0, func(context.Context, string, json.RawMessage) error {
		posterCalled = true
		return nil
	})
	if !errors.Is(err, errQueueFenced) {
		t.Fatalf("executor with released token err = %v, want errQueueFenced", err)
	}
	if posterCalled {
		t.Fatal("released-token executor reached the upstream POST")
	}
	if (outcome != DispatchOutcome{}) {
		t.Fatalf("released-token outcome = %+v, want zero (nothing claimed)", outcome)
	}
	after, err := os.ReadFile(queuePath(root, "s1"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatalf("released-token executor mutated the store:\nbefore: %s\nafter:  %s", before, after)
	}
}

// TestQueueCustodyRecordOutcomeSaveFailureRollsBackReceipt (gate review
// T1B-F1): RecordAttemptOutcome's save-failure rollback must restore the
// target attempt BY VALUE. The defect it pins: `pre := s.items[i]` is a
// shallow struct copy whose Attempts slice header ALIASES the same backing
// array, so the in-place EndedAt/TransportClass/Detail writes SURVIVED
// `s.items[i] = pre` — after a transient save failure (e.g. ENOSPC), memory
// showed an ended attempt disk didn't have: receipt retries were rejected as
// "already ended", and a later successful save silently persisted the
// receipt the caller was told failed — violating the journal's atomic
// durable-transition contract. (The append-based BeginDispatchAttempt
// rollback is safe: restoring the slice header suffices there; only this
// in-place path aliases.)
//
// The save failure is injected at the FILESYSTEM level (no production hook):
// queue.json is replaced by a directory, so writeQueueAtomic's final rename
// (file → existing directory) fails with EISDIR deterministically — even as
// root — while the store's loaded cache keeps load() from re-reading the
// path. The failure is then cleared by restoring the original bytes.
func TestQueueCustodyRecordOutcomeSaveFailureRollsBackReceipt(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	s := &sessionQueueStore{path: queuePath(root, "s1")}
	tok, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	defer tok.Release()

	mustEnqueue(t, s, "rollback-probe")
	item, won, err := s.ClaimForCustody(tok)
	if err != nil || !won {
		t.Fatalf("claim: err=%v won=%v", err, won)
	}
	idx, err := s.BeginDispatchAttempt(tok, item.ID, 0)
	if err != nil {
		t.Fatalf("begin attempt: %v", err)
	}

	// Durable baseline: exactly one OPEN attempt on disk.
	base := journalItemByText(t, s, "rollback-probe")
	if len(base.Attempts) != idx+1 || base.Attempts[idx].TransportClass != "" || base.Attempts[idx].EndedAt != 0 {
		t.Fatalf("baseline journal = %+v, want one open attempt", base.Attempts)
	}
	good, err := os.ReadFile(s.path)
	if err != nil {
		t.Fatal(err)
	}

	// --- INJECT the save failure (ENOSPC-class): queue.json becomes a
	// directory, so every save's atomic rename fails with EISDIR.
	if err := os.Remove(s.path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(s.path, 0o755); err != nil {
		t.Fatal(err)
	}

	err = s.RecordAttemptOutcome(tok, item.ID, idx, QueueAttemptAccepted2xx, "receipt-under-failure")
	if err == nil {
		t.Fatal("RecordAttemptOutcome must fail when the save fails (the caller must be told the receipt is NOT durable)")
	}

	// (1) IN-MEMORY ROLLBACK: the attempt must still be OPEN — the rejected
	// receipt may not survive in memory (the aliased restore left
	// TransportClass/EndedAt/Detail set here).
	att := inMemoryAttemptForTest(t, s, item.ID, idx)
	if att.TransportClass != "" || att.EndedAt != 0 || att.Detail != "" {
		t.Fatalf("save failure left the rejected receipt in memory: %+v (attempt must roll back to OPEN)", att)
	}

	// (2) RETRY SYMPTOM: a retried receipt under the still-failing save must
	// fail with a SAVE error again — never "already ended" (the memory/disk
	// divergence the defect produced).
	retryErr := s.RecordAttemptOutcome(tok, item.ID, idx, QueueAttemptAccepted2xx, "retry-under-failure")
	if retryErr == nil {
		t.Fatal("retry under the still-failing save must fail")
	}
	if strings.Contains(retryErr.Error(), "already ended") {
		t.Fatalf("retry rejected as %q — memory claims an ended attempt disk doesn't have (the T1B-F1 defect)", retryErr)
	}

	// --- CLEAR the failure: restore the durable bytes.
	if err := os.Remove(s.path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.path, good, 0o644); err != nil {
		t.Fatal(err)
	}

	// (3) NO SILENT PERSISTENCE: a later SUCCESSFUL save (any other mutation
	// — here an enqueue serializes the whole store) must not smuggle the
	// rejected receipt to disk; the durable attempt stays OPEN.
	mustEnqueue(t, s, "post-failure-mutation")
	disk := journalItemByText(t, s, "rollback-probe")
	if disk.Attempts[idx].TransportClass != "" || disk.Attempts[idx].EndedAt != 0 {
		t.Fatalf("later save silently persisted the rejected receipt: %+v (durable attempt must stay open until a retry succeeds)", disk.Attempts[idx])
	}

	// (4) The retry SUCCEEDS once the failure clears: the caller re-drives
	// the receipt and it lands durably, exactly once.
	if err := s.RecordAttemptOutcome(tok, item.ID, idx, QueueAttemptAccepted2xx, "receipt-after-recovery"); err != nil {
		t.Fatalf("retry after the failure cleared: %v", err)
	}
	final := journalItemByText(t, s, "rollback-probe")
	if final.Attempts[idx].TransportClass != QueueAttemptAccepted2xx || final.Attempts[idx].EndedAt == 0 || final.Attempts[idx].Detail != "receipt-after-recovery" {
		t.Fatalf("post-retry journal = %+v, want closed accepted_2xx with the retried detail", final.Attempts[idx])
	}
}

// inMemoryAttemptForTest returns the LIVE in-memory journal record for one
// item's attempt (test seam: direct store inspection under the mutex, so a
// rollback test can distinguish memory state from disk state).
func inMemoryAttemptForTest(t *testing.T, s *sessionQueueStore, itemID string, idx int) QueueAttempt {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.items {
		if s.items[i].ID != itemID {
			continue
		}
		if idx < 0 || idx >= len(s.items[i].Attempts) {
			t.Fatalf("item %s has no attempt %d in memory (%d attempts)", itemID, idx, len(s.items[i].Attempts))
		}
		return s.items[i].Attempts[idx]
	}
	t.Fatalf("item %s not in the in-memory store", itemID)
	return QueueAttempt{}
}

// TestQueueCustodyReleasedOwnerTakeoverInterleave (B-F4, the review's named
// interleave): owner A (gen 1) is mid-dispatch when it releases; successor
// B acquires (gen 2); A's executor then attempts — it must be rejected,
// A's poster never called, and NO mutation from the attempt may land (A's
// mid-dispatch journal survives byte-identical for B's reconciler).
func TestQueueCustodyReleasedOwnerTakeoverInterleave(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	s := &sessionQueueStore{path: queuePath(root, "s1")}

	a, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	mustEnqueue(t, s, "interleave")
	mustEnqueue(t, s, "interleave-next") // stays pending across the takeover
	item, won, err := s.ClaimForCustody(a)
	if err != nil || !won {
		t.Fatalf("A claim: err=%v won=%v", err, won)
	}
	if _, err := s.BeginDispatchAttempt(a, item.ID, 0); err != nil {
		t.Fatalf("A begin attempt: %v", err)
	}

	// The takeover: A is gone, B is the new owner at a higher generation.
	a.Release()
	b, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatalf("B acquire: %v", err)
	}
	defer b.Release()
	if b.Generation() <= a.Generation() {
		t.Fatalf("B generation = %d, want > A's %d", b.Generation(), a.Generation())
	}
	if err := b.FenceCheck(); err != nil {
		t.Fatalf("current owner B FenceCheck: %v", err)
	}
	before, err := os.ReadFile(queuePath(root, "s1"))
	if err != nil {
		t.Fatal(err)
	}

	// A's executor attempts with a pending item available (pre-fix, A's
	// token was still fence-valid: it would have claimed and POSTed).
	posterCalled := false
	outcome, err := RunQueuedDispatchAttempt(context.Background(), s, "s1", a, 0, func(context.Context, string, json.RawMessage) error {
		posterCalled = true
		return nil
	})
	if !errors.Is(err, errQueueFenced) {
		t.Fatalf("released owner A executor err = %v, want errQueueFenced", err)
	}
	if posterCalled {
		t.Fatal("released owner A executor reached the upstream POST concurrent with B's epoch")
	}
	if (outcome != DispatchOutcome{}) {
		t.Fatalf("released owner A outcome = %+v, want zero (nothing claimed)", outcome)
	}
	after, err := os.ReadFile(queuePath(root, "s1"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatalf("released owner A mutated the store after the takeover:\nbefore: %s\nafter:  %s", before, after)
	}
}

// --- B-F6: barrier certification matrix (AMEND-A1 topology exclusions) --------

// TestCustodyBarrierCertificationMatrix pins the restart-causality-barrier
// predicate: certified ONLY on Linux with a SPAWNED OpenCode. External-OC is
// NEVER certified (an externally-managed instance can be restarted
// out-of-band and driven by clients this daemon cannot observe). The
// non-Linux arm is asserted directly by queue_custody_other_test.go on
// non-Linux hosts; here the runtime arm pins the half this host can observe.
func TestCustodyBarrierCertificationMatrix(t *testing.T) {
	if custodyBarrierCertified(true) {
		t.Fatal("external-OC must NEVER certify the restart barrier, on any platform")
	}
	if runtime.GOOS == "linux" && !custodyBarrierCertified(false) {
		t.Fatal("Linux + spawned-OC is the certified topology — predicate must hold here")
	}
}

// TestExternalOpenCodeSignalExcludesBarrierCertification proves the RUNTIME
// SIGNAL the predicate consumes: Server.externalOC, wired from --opencode-url
// (cmd/local-server.go: external := localOpenCodeURL != \"\"), defaulting to
// spawned (false). Flipping it to external must drop barrier certification —
// phase 2's barrier logic keys off this exact signal, so the wiring is pinned
// here (B-F6: the exclusion is enforced, not just documented).
func TestExternalOpenCodeSignalExcludesBarrierCertification(t *testing.T) {
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})
	if srv.externalOC {
		t.Fatal("default posture must be spawned-OC (externalOC=false) — a bare local-server owns its OpenCode")
	}
	if runtime.GOOS == "linux" && !custodyBarrierCertified(srv.externalOC) {
		t.Fatal("Linux + spawned-OC (the default signal) must certify the barrier")
	}
	srv.SetExternalOpenCode(true) // the --opencode-url wiring's effect
	if !srv.externalOC {
		t.Fatal("SetExternalOpenCode(true) did not set the topology signal")
	}
	if custodyBarrierCertified(srv.externalOC) {
		t.Fatal("external-OC must never certify the restart barrier (AMEND-A1 exclusion)")
	}
}

// --- D-F2 primitive: the non-mutating live-holder probe ------------------------

// TestCustodyLockHeldProbe pins the mixed-writer arbitration probe's contract
// on Linux: false when the lock file does not exist (and the probe must NOT
// create it — it is safe in the flag-off posture), false when the file exists
// but nobody holds the flock, true while a live owner (this process — same
// semantics as any other: flock is per open-file-description) holds it, and
// false again after release. The non-Linux stub is pinned by
// queue_custody_other_test.go.
func TestCustodyLockHeldProbe(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	lockPath := filepath.Join(root, ".vh-solara", custodyLockFileRel)

	// No lock file yet: not held, and the probe must not create it.
	if custodyLockHeld(lockPath) {
		t.Fatal("probe reported held with no lock file")
	}
	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Fatalf("probe created the lock file (%v) — it must be non-mutating", err)
	}

	// A live owner holds it: held.
	tok, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	if !custodyLockHeld(lockPath) {
		t.Fatal("probe reported not-held while a live owner holds the flock")
	}
	// And the probe does not disturb the owner's generation authority.
	if err := tok.FenceCheck(); err != nil {
		t.Fatalf("probe disturbed the live owner's fence: %v", err)
	}
	tok.Release()

	// File still exists (empty), flock free: not held.
	if custodyLockHeld(lockPath) {
		t.Fatal("probe reported held after release (flock must be free)")
	}
}
