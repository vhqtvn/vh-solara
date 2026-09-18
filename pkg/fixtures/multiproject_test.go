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
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
