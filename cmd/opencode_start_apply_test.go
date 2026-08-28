package cmd

// TestApplyDetachedOCStartMatrix — the verdict→wiring mapping both cobra arms
// consume (lifecycle transitions, ring seeding, port/URL/cmd passthrough).
// Deliberately platform-independent (pure ApplyDetachedOCStart logic — no
// flock, no /proc): the scenario-based start/restart tests live in
// opencode_start_test.go behind //go:build linux.

import (
	"os"
	"os/exec"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/oclife"
)

func TestApplyDetachedOCStartMatrix(t *testing.T) {
	// Scope the state dir: ocLogPath writes under it during the ring-seeding
	// arms (the scenario helper the linux-only tests use is not needed here).
	t.Setenv("VH_STATE_DIR", t.TempDir())

	// A disk log to observe ring seeding (reattach/occupied seed it; the
	// fresh-ring reconnect is exactly what the tail exists for).
	if err := os.WriteFile(ocLogPath(), []byte("detached-log-tail\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dummy := &exec.Cmd{}

	cases := []struct {
		name           string
		res            DetachedStartResult
		wantLife       oclife.State
		wantPort       int
		wantURL        string
		wantCmd        *exec.Cmd
		wantRingSeeded bool
	}{
		{
			name:           "spawned",
			res:            DetachedStartResult{Verdict: DetachedStartSpawned, PID: 11, Port: 4100, Cmd: dummy},
			wantLife:       oclife.StateReady,
			wantPort:       4100,
			wantURL:        "http://127.0.0.1:4100",
			wantCmd:        dummy,
			wantRingSeeded: false,
		},
		{
			name:           "reattached",
			res:            DetachedStartResult{Verdict: DetachedStartReattached, PID: 12, Port: 4101},
			wantLife:       oclife.StateReady,
			wantPort:       4101,
			wantURL:        "http://127.0.0.1:4101",
			wantRingSeeded: true,
		},
		{
			name:           "occupied",
			res:            DetachedStartResult{Verdict: DetachedStartOccupied, PID: 13, Port: 4102, Reason: "probe refused"},
			wantLife:       oclife.StateFailed,
			wantPort:       4102,
			wantURL:        "http://127.0.0.1:4102",
			wantRingSeeded: true,
		},
		{
			name:     "contended without known port",
			res:      DetachedStartResult{Verdict: DetachedStartContended, Reason: "starter lock held"},
			wantLife: oclife.StateFailed,
			wantPort: 0,
			wantURL:  "", // caller's dead-loopback fallback applies
		},
		{
			name:     "contended with recorded port hint",
			res:      DetachedStartResult{Verdict: DetachedStartContended, Port: 4103, Reason: "starter lock held"},
			wantLife: oclife.StateFailed,
			wantPort: 4103,
			wantURL:  "http://127.0.0.1:4103",
		},
		{
			name:     "orphaned owner",
			res:      DetachedStartResult{Verdict: DetachedStartOrphanedOwner, Reason: "holders: pid 1 (sleep)", Holders: []string{"pid 1 (sleep)"}},
			wantLife: oclife.StateFailed,
			wantPort: 0,
			wantURL:  "",
		},
		{
			name:     "failed with targeted port",
			res:      DetachedStartResult{Verdict: DetachedStartFailed, Port: 4104, Reason: "readiness timeout"},
			wantLife: oclife.StateFailed,
			wantPort: 4104,
			wantURL:  "http://127.0.0.1:4104",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			life := oclife.New(oclife.TopologyDetached)
			port, url, cmd := ApplyDetachedOCStart(tc.res, life, "test")
			snap := life.Snapshot()
			if snap.State != tc.wantLife {
				t.Fatalf("life state=%s want=%s", snap.State, tc.wantLife)
			}
			if port != tc.wantPort || url != tc.wantURL {
				t.Fatalf("port/url=%d/%q want %d/%q", port, url, tc.wantPort, tc.wantURL)
			}
			if cmd != tc.wantCmd {
				t.Fatalf("cmd passthrough mismatch")
			}
			switch tc.res.Verdict {
			case DetachedStartOccupied, DetachedStartContended, DetachedStartOrphanedOwner, DetachedStartFailed:
				if snap.FailureSummary != tc.res.Reason {
					t.Fatalf("failure summary=%q want the transaction reason %q", snap.FailureSummary, tc.res.Reason)
				}
			}
			seeded := len(life.Ring().Tail(0)) > 0
			if seeded != tc.wantRingSeeded {
				t.Fatalf("ring seeded=%v want %v", seeded, tc.wantRingSeeded)
			}
		})
	}
}
