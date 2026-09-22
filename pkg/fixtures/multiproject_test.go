package fixtures

// Unit coverage for the Phase-A1 multi-project contention fixture
// (SeedMultiProject / MultiProjectSpec — measurement infrastructure; see
// tmp/agent-runs/multiproject-contention-20260918/brief.md §6). Pins the
// contracts the e2e measurement (tests/e2e/multiproject_latency_test.go)
// derives its session ids and expectations from:
//
//   - determinism: same spec → byte-identical sessions+messages
//   - N genuinely distinct dirs: per-dir listing serves ONLY that dir's
//     seeded set; demoDir/default listing is unchanged; unknown dirs keep
//     the synthetic placeholder
//   - size control: SmallPartBytes / BulkPartBytes are exact
//   - id scheme stability: mp<i>_s<j> / mp<i>_b<k>

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestSeedMultiProjectDeterminism(t *testing.T) {
	spec := DefaultMultiProjectSpec()
	spec.Projects = 3 // smaller: identical-shape check, not full size

	f1, f2 := New(), New()
	d1, d2 := f1.SeedMultiProject(spec), f2.SeedMultiProject(spec)
	if fmt.Sprint(d1) != fmt.Sprint(d2) {
		t.Fatalf("dirs differ between seedings: %v vs %v", d1, d2)
	}

	// Compare ONLY the mp-seeded subset: New()'s consolidated demo sessions
	// carry time.Now()-derived timestamps, so a millisecond boundary between
	// the two New() calls would make a whole-fixture comparison flake. The
	// multi-project contract under test is the SEEDED data, which uses the
	// fixed mpEpochBase.
	mpSessions := func(f *FakeOpenCode) []map[string]any {
		out := []map[string]any{}
		for _, s := range f.sessions {
			if id, _ := s["id"].(string); strings.HasPrefix(id, "mp") {
				out = append(out, s)
			}
		}
		return out
	}
	mpMessages := func(f *FakeOpenCode) map[string][]messageWithParts {
		out := map[string][]messageWithParts{}
		for sid, msgs := range f.messages {
			if strings.HasPrefix(sid, "mp") {
				out[sid] = msgs
			}
		}
		return out
	}
	b1, err := json.Marshal(mpSessions(f1))
	if err != nil {
		t.Fatal(err)
	}
	b2, err := json.Marshal(mpSessions(f2))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(b1, b2) {
		t.Fatalf("mp sessions JSON differs between seedings (%d vs %d bytes)", len(b1), len(b2))
	}
	// maps marshal with sorted keys, so identical content → identical bytes.
	m1, err := json.Marshal(mpMessages(f1))
	if err != nil {
		t.Fatal(err)
	}
	m2, err := json.Marshal(mpMessages(f2))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(m1, m2) {
		t.Fatalf("mp messages JSON differs between seedings (%d vs %d bytes)", len(m1), len(m2))
	}
	// The e2e's bulk-vs-small contrast depends on bulk content NOT surviving
	// gzip at prose-like ratios: assert the seeded bulk text is far less
	// compressible than the ordinary filler (a 600 KiB random base64 part must
	// not collapse to ~1% of its size the way repeated prose does).
	bulk := f1.messages["mp0_b0"][1].Parts[0]["text"].(string)
	if len(bulk) != spec.BulkPartBytes {
		t.Fatalf("bulk part length = %d, want %d", len(bulk), spec.BulkPartBytes)
	}
	uniq := map[byte]bool{}
	for i := 0; i < len(bulk); i += 997 { // stride-sample, deterministic
		uniq[bulk[i]] = true
	}
	if len(uniq) < 40 {
		t.Fatalf("bulk text looks compressible: only %d distinct byte values sampled", len(uniq))
	}
}

func TestSeedMultiProjectDirectoryScoping(t *testing.T) {
	spec := MultiProjectSpec{Projects: 3, SessionsPerProj: 2, BulkSessions: 1, TurnsPerSession: 2, SmallPartBytes: 512, BulkPartBytes: 2048}

	f := New()
	dirs := f.SeedMultiProject(spec)
	if len(dirs) != 3 {
		t.Fatalf("seeded %d dirs, want 3", len(dirs))
	}
	seen := map[string]bool{}
	for _, d := range dirs {
		if seen[d] {
			t.Fatalf("duplicate dir %q", d)
		}
		seen[d] = true
	}

	srv := startFixtureHTTP(t, f)

	// Baseline: the demoDir listing is IDENTICAL to an unseeded fake (the
	// multi-project sessions must not leak into the consolidated set).
	plain := New()
	plainSrv := startFixtureHTTP(t, plain)
	listIDs := func(s *httptest.Server, dir string) []string {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, s.URL+"/session", nil)
		if dir != "" {
			req.Header.Set("x-opencode-directory", dir)
		}
		resp, err := s.Client().Do(req)
		if err != nil {
			t.Fatalf("GET /session (dir=%q): %v", dir, err)
		}
		defer resp.Body.Close()
		var out []map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatalf("decode /session (dir=%q): %v", dir, err)
		}
		ids := make([]string, 0, len(out))
		for _, s := range out {
			id, _ := s["id"].(string)
			ids = append(ids, id)
			if d, _ := s["directory"].(string); dir != "" && d != dir {
				t.Fatalf("dir=%q listing returned session %q with directory %q", dir, id, d)
			}
		}
		return ids
	}
	if got := fmt.Sprint(listIDs(srv, "")); got != fmt.Sprint(listIDs(plainSrv, "")) {
		t.Fatalf("default (no-header) listing changed by multi-project seeding:\nseeded=%v\nplain=%v", got, listIDs(plainSrv, ""))
	}
	if got := fmt.Sprint(listIDs(srv, DemoDir())); got != fmt.Sprint(listIDs(plainSrv, DemoDir())) {
		t.Fatalf("demoDir listing changed by multi-project seeding:\nseeded=%v\nplain=%v", got, listIDs(plainSrv, DemoDir()))
	}

	// Each seeded dir serves ONLY its own set, with the pinned id scheme and
	// the exact expected count (ordinary + bulk).
	for i, dir := range dirs {
		ids := listIDs(srv, dir)
		want := spec.SessionsPerProj + spec.BulkSessions
		if len(ids) != want {
			t.Fatalf("dir=%q listing: %d sessions (%v), want %d", dir, len(ids), ids, want)
		}
		for j := 0; j < spec.SessionsPerProj; j++ {
			wantID := fmt.Sprintf("mp%d_s%d", i, j)
			found := false
			for _, id := range ids {
				if id == wantID {
					found = true
				}
			}
			if !found {
				t.Fatalf("dir=%q listing missing ordinary id %q (got %v)", dir, wantID, ids)
			}
		}
		for b := 0; b < spec.BulkSessions; b++ {
			wantID := fmt.Sprintf("mp%d_b%d", i, b)
			found := false
			for _, id := range ids {
				if id == wantID {
					found = true
				}
			}
			if !found {
				t.Fatalf("dir=%q listing missing bulk id %q (got %v)", dir, wantID, ids)
			}
		}
	}

	// Unknown dir keeps the synthetic placeholder (switcher demoability).
	ids := listIDs(srv, "/work/alpha")
	if len(ids) != 1 || ids[0] != "proj_alpha" {
		t.Fatalf("unknown dir placeholder changed: %v", ids)
	}
}

func TestSeedMultiProjectSizeControl(t *testing.T) {
	spec := MultiProjectSpec{Projects: 1, SessionsPerProj: 1, BulkSessions: 1, TurnsPerSession: 3, SmallPartBytes: 1234, BulkPartBytes: 5000}
	f := New()
	f.SeedMultiProject(spec)

	msgs := f.messages["mp0_s0"]
	if len(msgs) != spec.TurnsPerSession*2 {
		t.Fatalf("ordinary session has %d messages, want %d (2 per turn)", len(msgs), spec.TurnsPerSession*2)
	}
	for i, m := range msgs {
		role, _ := m.Info["role"].(string)
		wantLen := 0
		switch role {
		case "user":
			wantLen = 1234 / 4 // clamped SmallPartBytes/4 = 308
			if wantLen < 128 {
				wantLen = 128
			}
			if wantLen > 1024 {
				wantLen = 1024
			}
		case "assistant":
			wantLen = spec.SmallPartBytes
		default:
			t.Fatalf("message %d has unexpected role %q", i, role)
		}
		got, _ := m.Parts[0]["text"].(string)
		if len(got) != wantLen {
			t.Fatalf("%s part length = %d, want exactly %d", role, len(got), wantLen)
		}
	}

	bulk := f.messages["mp0_b0"]
	if len(bulk) != 2 {
		t.Fatalf("bulk session has %d messages, want 2 (user + assistant)", len(bulk))
	}
	got, _ := bulk[1].Parts[0]["text"].(string)
	if len(got) != spec.BulkPartBytes {
		t.Fatalf("bulk part length = %d, want exactly %d", len(got), spec.BulkPartBytes)
	}
	// BulkSessions=1: no second bulk session may exist for the project.
	if msgs := f.messages["mp0_b1"]; len(msgs) != 0 {
		t.Fatalf("unexpected second bulk session: %d messages", len(msgs))
	}
}

func TestSeedMultiProjectIdSchemeStability(t *testing.T) {
	// The e2e derives selected/bulk session ids from this scheme without
	// consulting the fixture internals — pin it.
	f := New()
	dirs := f.SeedMultiProject(MultiProjectSpec{Projects: 2, SessionsPerProj: 2, BulkSessions: 2, TurnsPerSession: 1, SmallPartBytes: 64, BulkPartBytes: 64})
	if dirs[0] != "/work/mproj0" || dirs[1] != "/work/mproj1" {
		t.Fatalf("dir scheme changed: %v", dirs)
	}
	for _, sid := range []string{"mp0_s0", "mp0_s1", "mp0_b0", "mp0_b1", "mp1_s0", "mp1_b1"} {
		if _, ok := f.messages[sid]; !ok {
			t.Fatalf("expected session id %q missing from messages", sid)
		}
	}
}

// --- Phase A2 sustained-workload controls (mpworkload.go) --------------------

// mpSeedForTest drives POST /fixture/mp-seed. The wire body is the snake_case
// DTO (mirroring the lane-6 spec); a Go-marshaled MultiProjectSpec would not
// match the DTO tags for the underscore keys.
func mpSeedForTest(t *testing.T, srv *httptest.Server, spec MultiProjectSpec) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"projects":          spec.Projects,
		"sessions_per_proj": spec.SessionsPerProj,
		"bulk_sessions":     spec.BulkSessions,
		"turns_per_session": spec.TurnsPerSession,
		"small_part_bytes":  spec.SmallPartBytes,
		"bulk_part_bytes":   spec.BulkPartBytes,
	})
	resp, _ := postJSON(t, srv, "/fixture/mp-seed", string(body))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("mp-seed -> %d", resp.StatusCode)
	}
}

// mpWLStart arms a run and returns the parsed start snapshot.
func mpWLStart(t *testing.T, srv *httptest.Server, spec MPWorkloadSpec) mpStatusView {
	t.Helper()
	body, _ := json.Marshal(spec)
	resp, raw := postJSON(t, srv, "/fixture/mp-workload/start", string(body))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("workload start -> %d: %s", resp.StatusCode, raw)
	}
	var v mpStatusView
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	return v
}

// mpWLPost drives release/stop/reset and returns the snapshot.
func mpWLPost(t *testing.T, srv *httptest.Server, verb string, runID uint64, wantCode int) mpStatusView {
	t.Helper()
	resp, raw := postJSON(t, srv, fmt.Sprintf("/fixture/mp-workload/%s?run=%d", verb, runID), "")
	if resp.StatusCode != wantCode {
		t.Fatalf("workload %s -> %d (want %d): %s", verb, resp.StatusCode, wantCode, raw)
	}
	var v mpStatusView
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decode %s: %v", verb, err)
	}
	return v
}

// mpWLStatus polls status until state==want or the deadline; returns the final
// snapshot (fatal on deadline).
func mpWLStatus(t *testing.T, srv *httptest.Server, runID uint64, want string, deadline time.Duration) mpStatusView {
	t.Helper()
	deadlineT := time.Now().Add(deadline)
	for {
		resp, raw := get(t, srv, fmt.Sprintf("/fixture/mp-workload/status?run=%d", runID))
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status -> %d", resp.StatusCode)
		}
		var v mpStatusView
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatalf("decode status: %v", err)
		}
		if v.State == want {
			return v
		}
		if time.Now().After(deadlineT) {
			t.Fatalf("run %d never reached %q (state=%s emitted=%d)", runID, want, v.State, v.Emitted)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// mpStatusView is the test-side decode of the workload snapshot JSON.
type mpStatusView struct {
	RunID      uint64 `json:"run_id"`
	State      string `json:"state"`
	Emitted    int64  `json:"emitted"`
	Bookends   int64  `json:"bookends"`
	DroppedRun uint64 `json:"dropped_run"`
	Expected   []struct {
		SID        string `json:"sid"`
		MessageID  string `json:"message_id"`
		PartID     string `json:"part_id"`
		Events     int    `json:"events"`
		ChunkBytes int    `json:"chunk_bytes"`
		FinalLen   int    `json:"final_len"`
		Digest     string `json:"digest"`
	} `json:"expected"`
}

func TestMPWorkloadBarrierCadenceAndAccounting(t *testing.T) {
	f := New()
	f.SeedMultiProject(MultiProjectSpec{Projects: 2, SessionsPerProj: 2, BulkSessions: 0, TurnsPerSession: 2, SmallPartBytes: 256, BulkPartBytes: 256})
	srv := startFixtureHTTP(t, f)

	start := mpWLStart(t, srv, MPWorkloadSpec{Projects: 2, Events: 8, ChunkBytes: 96, BulkProject: -1, CadenceMs: 5})
	if start.State != "armed" || start.RunID == 0 {
		t.Fatalf("start state=%s run=%d, want armed/nonzero", start.State, start.RunID)
	}
	// Barrier: armed emits nothing.
	time.Sleep(120 * time.Millisecond)
	st := mpWLStatus(t, srv, start.RunID, "armed", time.Second)
	if st.Emitted != 0 {
		t.Fatalf("armed run emitted %d events, want 0 (barrier must hold)", st.Emitted)
	}

	mpWLPost(t, srv, "release", start.RunID, http.StatusOK)
	done := mpWLStatus(t, srv, start.RunID, "done", 5*time.Second)
	if done.Emitted != int64(8*2) {
		t.Fatalf("emitted=%d, want 16 (8 events × 2 sessions)", done.Emitted)
	}
	if done.DroppedRun != 0 {
		t.Fatalf("dropped_run=%d, want 0 with no stuck subscriber", done.DroppedRun)
	}

	// Final content: byte-exact against the expected digest, persisted in the
	// fixture store.
	for _, e := range done.Expected {
		msgs := f.messages[e.SID]
		var got map[string]any
		for _, m := range msgs {
			if id, _ := m.Info["id"].(string); id == e.MessageID {
				got = m.Parts[0]
			}
		}
		if got == nil {
			t.Fatalf("session %s: run message %s not persisted", e.SID, e.MessageID)
		}
		text, _ := got["text"].(string)
		if len(text) != e.FinalLen {
			t.Fatalf("%s: persisted text len=%d, want %d", e.SID, len(text), e.FinalLen)
		}
		sum := sha256.Sum256([]byte(text))
		if hex.EncodeToString(sum[:]) != e.Digest {
			t.Fatalf("%s: persisted digest != expected digest", e.SID)
		}
		if !utf8.ValidString(text) {
			t.Fatalf("%s: persisted text is not valid UTF-8", e.SID)
		}
	}
}

func TestMPWorkloadByteExactChunksAndDeterminism(t *testing.T) {
	newFixture := func() (*FakeOpenCode, *httptest.Server, mpStatusView) {
		f := New()
		f.SeedMultiProject(MultiProjectSpec{Projects: 1, SessionsPerProj: 1, BulkSessions: 0, TurnsPerSession: 1, SmallPartBytes: 64, BulkPartBytes: 64})
		srv := startFixtureHTTP(t, f)
		st := mpWLStart(t, srv, MPWorkloadSpec{Projects: 1, Events: 5, ChunkBytes: 64, BulkProject: -1, CadenceMs: 2})
		mpWLPost(t, srv, "release", st.RunID, http.StatusOK)
		return f, srv, mpWLStatus(t, srv, st.RunID, "done", 5*time.Second)
	}
	f1, _, d1 := newFixture()
	_, _, d2 := newFixture()

	e1, e2 := d1.Expected[0], d2.Expected[0]
	if e1.Digest != e2.Digest || e1.FinalLen != e2.FinalLen {
		t.Fatalf("determinism: same spec+run produced different content (%s/%d vs %s/%d)", e1.Digest, e1.FinalLen, e2.Digest, e2.FinalLen)
	}

	// Byte layout: each chunk is marker+filler, exactly ChunkBytes, markers
	// strictly ordered, content valid UTF-8.
	text := f1.messages[e1.SID][len(f1.messages[e1.SID])-1].Parts[0]["text"].(string)
	const chunk = 64
	if len(text) != 5*chunk {
		t.Fatalf("final len=%d, want %d", len(text), 5*chunk)
	}
	for k := 1; k <= 5; k++ {
		c := text[(k-1)*chunk : k*chunk]
		wantMarker := fmt.Sprintf("[p0r%dc%06d]", d1.RunID, k)
		if !strings.HasPrefix(c, wantMarker) {
			t.Fatalf("chunk %d starts with %q, want marker %q", k, c[:16], wantMarker)
		}
		if !utf8.ValidString(c) {
			t.Fatalf("chunk %d is not valid UTF-8", k)
		}
	}
	// Filler is multi-byte (the workload exists to move real UTF-8 bytes).
	if utf8.RuneCountInString(text) >= len(text) {
		t.Fatalf("filler collapsed to ASCII: %d runes for %d bytes", utf8.RuneCountInString(text), len(text))
	}
}

func TestMPWorkloadStopResetAndReuse(t *testing.T) {
	f := New()
	f.SeedMultiProject(MultiProjectSpec{Projects: 1, SessionsPerProj: 1, BulkSessions: 0, TurnsPerSession: 1, SmallPartBytes: 64, BulkPartBytes: 64})
	srv := startFixtureHTTP(t, f)

	start := mpWLStart(t, srv, MPWorkloadSpec{Projects: 1, Events: 60, ChunkBytes: 64, BulkProject: -1, CadenceMs: 10})
	mpWLPost(t, srv, "release", start.RunID, http.StatusOK)

	// A second start while running must be a 409 (one active run).
	body, _ := json.Marshal(MPWorkloadSpec{Projects: 1, Events: 1, ChunkBytes: 64, BulkProject: -1, CadenceMs: 5})
	resp, raw := postJSON(t, srv, "/fixture/mp-workload/start", string(body))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("second start -> %d (want 409): %s", resp.StatusCode, raw)
	}

	// Stop mid-run: partial emission, cancelled state. Poll until at least one
	// tick fired before stopping (a fixed sleep would flake on a loaded
	// machine — the commit review's A-F3).
	stopDeadline := time.Now().Add(3 * time.Second)
	for {
		st := mpWLStatus(t, srv, start.RunID, "running", time.Second)
		if st.Emitted > 0 {
			break
		}
		if time.Now().After(stopDeadline) {
			t.Fatalf("run never emitted within 3s of release (state=%s)", st.State)
		}
		time.Sleep(20 * time.Millisecond)
	}
	stopped := mpWLPost(t, srv, "stop", start.RunID, http.StatusOK)
	if stopped.State != "cancelled" {
		t.Fatalf("stop state=%s, want cancelled", stopped.State)
	}
	if stopped.Emitted <= 0 || stopped.Emitted >= 60 {
		t.Fatalf("cancelled run emitted=%d, want strictly between 0 and 60", stopped.Emitted)
	}

	// The cancelled run never persisted its message; reset must be a surgical
	// no-op on the transcript but free the active slot for reuse.
	mpWLPost(t, srv, "reset", start.RunID, http.StatusOK)
	// After reset, a fresh run on the same session succeeds with a NEW message id.
	next := mpWLStart(t, srv, MPWorkloadSpec{Projects: 1, Events: 3, ChunkBytes: 64, BulkProject: -1, CadenceMs: 2})
	if next.RunID == start.RunID {
		t.Fatalf("reuse: run id %d reused", next.RunID)
	}
	mpWLPost(t, srv, "release", next.RunID, http.StatusOK)
	done := mpWLStatus(t, srv, next.RunID, "done", 5*time.Second)
	e := done.Expected[0]
	if e.MessageID == start.Expected[0].MessageID {
		t.Fatalf("reuse: message id %s reused across runs", e.MessageID)
	}
	// Body run_id selection (the lane-6 spec posts {run_id} bodies): with a
	// LATER run armed on the same session, resetting run `next` by body id
	// must remove ONLY next's message — the most-recent-run default would
	// silently hit the later run instead (the commit review's B-F1).
	third := mpWLStart(t, srv, MPWorkloadSpec{Projects: 1, Events: 2, ChunkBytes: 64, BulkProject: -1, CadenceMs: 50})
	time.Sleep(120 * time.Millisecond) // third run partially emitted (or still armed; both fine)
	respThird, rawThird := postJSON(t, srv, fmt.Sprintf("/fixture/mp-workload/reset"), fmt.Sprintf(`{"run_id":%d}`, next.RunID))
	if respThird.StatusCode != http.StatusOK {
		t.Fatalf("body-run_id reset -> %d: %s", respThird.StatusCode, rawThird)
	}
	f.mu.Lock()
	nextStillPresent := false
	for _, m := range f.messages[e.SID] {
		if id, _ := m.Info["id"].(string); id == e.MessageID {
			nextStillPresent = true
		}
	}
	f.mu.Unlock()
	if nextStillPresent {
		t.Fatalf("body-run_id reset did not remove run %d's message %s (selection fell through to the latest run?)", next.RunID, e.MessageID)
	}
	mpWLPost(t, srv, "stop", third.RunID, http.StatusOK)
	mpWLPost(t, srv, "reset", third.RunID, http.StatusOK)
	// Snapshot the COMPLETED-run reset path below on a fresh fourth run.
	fourth := mpWLStart(t, srv, MPWorkloadSpec{Projects: 1, Events: 3, ChunkBytes: 64, BulkProject: -1, CadenceMs: 2})
	mpWLPost(t, srv, "release", fourth.RunID, http.StatusOK)
	done4 := mpWLStatus(t, srv, fourth.RunID, "done", 5*time.Second)
	e4 := done4.Expected[0]
	// Reset the COMPLETED fourth run: exactly its message is removed, the
	// seeded baseline stays.
	snapshot := func() (n int, hasRunMsg bool) {
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, m := range f.messages[e4.SID] {
			n++
			if id, _ := m.Info["id"].(string); id == e4.MessageID {
				hasRunMsg = true
			}
		}
		return
	}
	baselineN, baselineHas := snapshot()
	if !baselineHas {
		t.Fatalf("run message %s not persisted before reset", e4.MessageID)
	}
	mpWLPost(t, srv, "reset", fourth.RunID, http.StatusOK)
	afterN, afterHas := snapshot()
	if afterHas {
		t.Fatalf("run message %s still present after reset", e4.MessageID)
	}
	if afterN != baselineN-1 {
		t.Fatalf("after reset: %d messages, want baseline-1=%d (only the run message removed)", afterN, baselineN-1)
	}
}

func TestMPWorkloadOverflowAccounting(t *testing.T) {
	f := New()
	f.SeedMultiProject(MultiProjectSpec{Projects: 1, SessionsPerProj: 1, BulkSessions: 0, TurnsPerSession: 1, SmallPartBytes: 64, BulkPartBytes: 64})
	srv := startFixtureHTTP(t, f)

	// A stuck subscriber (never drained) overflows the bounded channel; a
	// drained subscriber must still receive EVERY event.
	stuck, unstuck := f.subscribe()
	defer unstuck()
	drained, undrain := f.subscribe()
	defer undrain()
	received := make(chan int, 1)
	go func() {
		n := 0
		for range drained {
			n++
		}
		received <- n
	}()

	start := mpWLStart(t, srv, MPWorkloadSpec{Projects: 1, Events: 200, ChunkBytes: 64, BulkProject: -1, CadenceMs: 1})
	mpWLPost(t, srv, "release", start.RunID, http.StatusOK)
	done := mpWLStatus(t, srv, start.RunID, "done", 10*time.Second)
	_ = stuck

	if done.DroppedRun == 0 {
		t.Fatalf("stuck subscriber never overflowed: dropped_run=0 (accounting broken or cap changed)")
	}
	if done.Emitted != 200 {
		t.Fatalf("emitted=%d, want 200", done.Emitted)
	}
	// The drained subscriber saw every delta + bookend the fixture emitted.
	undrain()
	select {
	case n := <-received:
		if int64(n) != done.Emitted+done.Bookends {
			t.Fatalf("drained subscriber received %d events, want emitted+bookends=%d", n, done.Emitted+done.Bookends)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("drained subscriber channel never closed")
	}
}

func TestMPWorkloadStartValidationAndSeedIdempotence(t *testing.T) {
	f := New()
	srv := startFixtureHTTP(t, f)

	// Unseeded sessions: 400 + the missing list.
	body, _ := json.Marshal(MPWorkloadSpec{Projects: 2, Events: 2, ChunkBytes: 64, BulkProject: -1, CadenceMs: 5})
	resp, raw := postJSON(t, srv, "/fixture/mp-workload/start", string(body))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("start on unseeded -> %d (want 400): %s", resp.StatusCode, raw)
	}
	if !strings.Contains(string(raw), "mp0_s0") {
		t.Fatalf("400 body does not name the missing session: %s", raw)
	}

	// mp-seed is idempotent: first call 200, repeat 409 (no duplicate sessions).
	mpSeedForTest(t, srv, MultiProjectSpec{Projects: 2, SessionsPerProj: 2, BulkSessions: 0, TurnsPerSession: 1, SmallPartBytes: 64, BulkPartBytes: 64})
	// Regression gate for the wire-DTO bug the first A2 lane run hit: a
	// snake_case body that silently zeroed the underscore keys seeded EMPTY
	// dirs (placeholder-only listings). The seeded dir must serve REAL mp
	// sessions through the scoped listing.
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/session", nil)
	req.Header.Set("x-opencode-directory", "/work/mproj0")
	resp2, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("scoped listing: %v", err)
	}
	var listed []map[string]any
	if err := json.NewDecoder(resp2.Body).Decode(&listed); err != nil {
		t.Fatalf("decode listing: %v", err)
	}
	resp2.Body.Close()
	if len(listed) != 2 {
		t.Fatalf("scoped listing after mp-seed returned %d sessions, want 2 (DTO regression): %v", len(listed), listed)
	}
	for _, s := range listed {
		if id, _ := s["id"].(string); !strings.HasPrefix(id, "mp0_") {
			t.Fatalf("scoped listing returned placeholder/non-mp session %v", s["id"])
		}
	}
	seedBody, _ := json.Marshal(map[string]any{"projects": 2, "sessions_per_proj": 2, "bulk_sessions": 0, "turns_per_session": 1, "small_part_bytes": 64, "bulk_part_bytes": 64})
	resp, raw = postJSON(t, srv, "/fixture/mp-seed", string(seedBody))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("second mp-seed -> %d (want 409): %s", resp.StatusCode, raw)
	}

	// session_idx selects the ordinary index (mp0_s1) and unknown idx fails.
	st := mpWLStart(t, srv, MPWorkloadSpec{Projects: 1, SessionIdx: 1, Events: 2, ChunkBytes: 64, BulkProject: -1, CadenceMs: 2})
	if st.Expected[0].SID != "mp0_s1" {
		t.Fatalf("session_idx=1 resolved %s, want mp0_s1", st.Expected[0].SID)
	}
	mpWLPost(t, srv, "stop", st.RunID, http.StatusOK)
	body, _ = json.Marshal(MPWorkloadSpec{Projects: 1, SessionIdx: 5, Events: 2, ChunkBytes: 64, BulkProject: -1, CadenceMs: 2})
	resp, raw = postJSON(t, srv, "/fixture/mp-workload/start", string(body))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("start with unknown session_idx -> %d (want 400): %s", resp.StatusCode, raw)
	}
}
