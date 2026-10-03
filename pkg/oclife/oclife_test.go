package oclife

import (
	"encoding/json"
	"testing"
	"time"
)

func TestDeathWatchSnapshotFields(t *testing.T) {
	l := New(TopologyDetached)
	l.SetReady()

	s := l.Snapshot()
	if s.DownSince != nil {
		t.Fatalf("DownSince set before any death: %v", s.DownSince)
	}
	if s.RestartAttempts != 0 || s.RestartCapped {
		t.Fatalf("restart progress set before any death: %+v", s)
	}

	// Death observed → down-since recorded without changing state.
	l.MarkDown()
	s = l.Snapshot()
	if s.State != StateReady {
		t.Fatalf("MarkDown changed state: %s", s.State)
	}
	if s.DownSince == nil {
		t.Fatal("DownSince nil after MarkDown")
	}
	first := *s.DownSince

	// Repeated MarkDown keeps the first timestamp.
	time.Sleep(2 * time.Millisecond)
	l.MarkDown()
	if got := *l.Snapshot().DownSince; !got.Equal(first) {
		t.Fatalf("MarkDown moved DownSince: first=%v now=%v", first, got)
	}

	// Restart progress is reported verbatim.
	l.SetRestartProgress(3, true)
	s = l.Snapshot()
	if s.RestartAttempts != 3 || !s.RestartCapped {
		t.Fatalf("restart progress not reported: %+v", s)
	}

	// A failed state (crash-loop give-up) keeps the down-window detail…
	l.SetFailed("opencode crash-loop: 3 restarts in 10m0s — giving up", nil)
	s = l.Snapshot()
	if s.DownSince == nil || !s.RestartCapped {
		t.Fatalf("failed state lost death-watch detail: %+v", s)
	}

	// …and the next ready clears it.
	l.SetReady()
	s = l.Snapshot()
	if s.DownSince != nil || s.RestartAttempts != 0 || s.RestartCapped {
		t.Fatalf("ready state kept stale death-watch detail: %+v", s)
	}
}

// TestFailedOwnedSnapshot validates the failed-state snapshot + owned capability
// flags (validation plan item #1): a lifecycle constructed for the owned
// topology and transitioned to failed reports the right state, failure detail,
// and the full owned capability set.
func TestFailedOwnedSnapshot(t *testing.T) {
	l := New(TopologyOwned)
	l.SetOpenCodeURL("http://127.0.0.1:4096")
	ec := 1
	l.SetFailed("opencode serve failed to listen on port 4096: port not ready after 30s", &ec)

	s := l.Snapshot()
	if s.Topology != TopologyOwned {
		t.Errorf("topology = %q, want owned", s.Topology)
	}
	if s.State != StateFailed {
		t.Errorf("state = %q, want failed", s.State)
	}
	if s.OpenCodeURL != "http://127.0.0.1:4096" {
		t.Errorf("opencode_url = %q", s.OpenCodeURL)
	}
	if s.FailureSummary == "" {
		t.Error("failure_summary should be set in failed state")
	}
	if s.ExitCode == nil || *s.ExitCode != 1 {
		t.Errorf("exit_code = %v, want 1", s.ExitCode)
	}
	// Owned-topology capability truth (the row from the task's capability table).
	if !s.Capabilities.CanRestart {
		t.Error("owned can_restart should be true")
	}
	if !s.Capabilities.HasProcessOutput {
		t.Error("owned has_process_output should be true")
	}
	if !s.Capabilities.HasLogTail {
		t.Error("owned has_log_tail should be true")
	}
	if !s.Capabilities.HasExitStatus {
		t.Error("owned has_exit_status should be true")
	}
	if s.DiagnosticCompleteness != DiagComplete {
		t.Errorf("diag = %q, want complete", s.DiagnosticCompleteness)
	}
	if s.StateChangedAt.IsZero() {
		t.Error("state_changed_at should be set")
	}
	// The ring is allocated for owned (Slice 2 will wire process output to it).
	if l.Ring() == nil {
		t.Error("owned ring should be non-nil")
	}
}

// TestExternalTopologyCapabilities confirms external topology advertises NO
// capabilities and unavailable diagnostics — no fake data, no ring.
func TestExternalTopologyCapabilities(t *testing.T) {
	l := New(TopologyExternal)
	s := l.Snapshot()
	if s.Capabilities.CanRestart || s.Capabilities.HasProcessOutput ||
		s.Capabilities.HasLogTail || s.Capabilities.HasExitStatus {
		t.Error("external topology must advertise NO capabilities")
	}
	if s.DiagnosticCompleteness != DiagUnavailable {
		t.Errorf("diag = %q, want unavailable", s.DiagnosticCompleteness)
	}
	if l.Ring() != nil {
		t.Error("external topology ring must be nil")
	}
}

// TestDetachedExitStatusPartial confirms detached topology reports partial
// diagnostics: log tail is available, but the exit code is NOT reliably
// observable (pid-alive polling only).
func TestDetachedExitStatusPartial(t *testing.T) {
	l := New(TopologyDetached)
	s := l.Snapshot()
	if s.Capabilities.HasExitStatus {
		t.Error("detached has_exit_status should be false (partial — pid polling only)")
	}
	if !s.Capabilities.HasLogTail {
		t.Error("detached has_log_tail should be true (disk log)")
	}
	if !s.Capabilities.CanRestart {
		t.Error("detached can_restart should be true")
	}
	if s.DiagnosticCompleteness != DiagPartial {
		t.Errorf("diag = %q, want partial", s.DiagnosticCompleteness)
	}
}

// TestTransitionClearsStaleFailure confirms a move out of failed clears the
// failure summary + exit code: a snapshot after a restart sequence never shows
// failure detail that belongs to a prior failed spell.
func TestTransitionClearsStaleFailure(t *testing.T) {
	l := New(TopologyOwned)
	ec := 2
	l.SetFailed("boom", &ec)
	l.SetStarting()
	s := l.Snapshot()
	if s.State != StateStarting {
		t.Fatalf("state = %q, want starting", s.State)
	}
	if s.FailureSummary != "" {
		t.Errorf("failure_summary should clear on starting, got %q", s.FailureSummary)
	}
	if s.ExitCode != nil {
		t.Errorf("exit_code should clear on starting, got %v", s.ExitCode)
	}
}

// TestInitialStateStarting confirms a fresh lifecycle reports starting.
func TestInitialStateStarting(t *testing.T) {
	for _, topo := range []Topology{TopologyOwned, TopologyDetached, TopologyExternal} {
		l := New(topo)
		if s := l.Snapshot(); s.State != StateStarting {
			t.Errorf("topology %s: initial state = %s, want starting", topo, s.State)
		}
	}
}

// TestSnapshotAdditiveJSON pins the additive-fields contract: an OLD consumer
// decoding a NEW snapshot ignores the unknown fields, and a snapshot with no
// death-watch activity marshals without the new keys at all.
func TestSnapshotAdditiveJSON(t *testing.T) {
	l := New(TopologyDetached)
	l.SetReady()
	b, err := json.Marshal(l.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"down_since", "restart_attempts", "restart_capped"} {
		if _, ok := raw[key]; ok {
			t.Fatalf("key %q present in an all-clear snapshot: %s", key, b)
		}
	}

	// New fields round-trip.
	l.MarkDown()
	l.SetRestartProgress(2, false)
	b, _ = json.Marshal(l.Snapshot())
	var s Snapshot
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatalf("new snapshot not decodable into Snapshot: %v", err)
	}
	if s.DownSince == nil || s.RestartAttempts != 2 {
		t.Fatalf("death-watch fields did not round-trip: %s", b)
	}
}
