// Package oclife models the lifecycle of the OpenCode process a vh-solara
// worker drives, independent of whether that process is currently reachable.
//
// It exists to DECOUPLE the worker's own liveness from OpenCode readiness: a
// fatal OpenCode startup failure (bad config, missing binary, port clash) is
// recorded as a failed state here instead of killing the worker process via
// log.Fatalf, so the worker keeps reporting to the controller and an operator
// can diagnose and restart OpenCode remotely through the tunnel.
//
// A Lifecycle is concurrency-safe. The topology (owned/detached/external) fixes
// the capability flags and diagnostic-completeness posture at construction;
// state transitions are reported through the setter methods. The read-only
// snapshot is served by the worker's /vh/opencode/status endpoint and is stable
// enough for Slice 2 to build /vh/opencode/logs on top of (the ring exposed via
// Ring() backs that future log-tail endpoint).
package oclife

import (
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/ringlog"
)

// Topology identifies how the worker relates to the OpenCode process.
type Topology string

const (
	// TopologyOwned: the worker spawned `opencode serve` as a child whose
	// lifetime is tied to the daemon. Full process observability (a reaped
	// exit code via Wait, merged stdout/stderr via the ring).
	TopologyOwned Topology = "owned"
	// TopologyDetached: the worker spawned `opencode serve` detached (survives
	// a daemon restart, tracked via pidfile). A log tail exists on disk; the
	// exit code is only partially observable (pid-alive polling, not a reaped
	// code, so HasExitStatus is false).
	TopologyDetached Topology = "detached"
	// TopologyExternal: the worker attaches to an operator-managed OpenCode it
	// did not spawn. No process/output/exit observability; reachability is
	// probe-only.
	TopologyExternal Topology = "external"
)

// State is the lifecycle state of the OpenCode process from the worker's view.
// It intentionally mirrors procmgr's vocabulary (starting|ready|failed|stopped)
// and adds `unknown` for the external/detached blind spots where the worker
// cannot tell what the process is doing.
type State string

const (
	// StateStarting: the process has been spawned (or a restart is in flight)
	// but has not yet reached readiness.
	StateStarting State = "starting"
	// StateReady: the process is reachable and serving (readiness probe passed).
	// Named "ready" (not "running") to align with procmgr's vocabulary.
	StateReady State = "ready"
	// StateFailed: a startup gate or the process itself failed (exec error,
	// port-listen timeout, readiness timeout, or a reaped non-zero exit). See
	// FailureSummary + ExitCode for detail.
	StateFailed State = "failed"
	// StateStopped: the process was intentionally stopped (user-initiated
	// shutdown) and is not expected to come back on its own.
	StateStopped State = "stopped"
	// StateUnknown: the worker cannot determine the process state (e.g. an
	// external OpenCode that was unreachable at probe time and is not owned).
	StateUnknown State = "unknown"
)

// DiagnosticCompleteness describes how much failure detail the topology can
// actually provide. It is the honest answer to "if this is failed, how much do
// you know about why".
type DiagnosticCompleteness string

const (
	// DiagComplete: exit code + merged output tail are both available (owned).
	DiagComplete DiagnosticCompleteness = "complete"
	// DiagPartial: some signal but not a full picture (detached: disk log tail
	// exists; exit code is not reliably reaped).
	DiagPartial DiagnosticCompleteness = "partial"
	// DiagUnavailable: no process/output detail at all (external: probe-only).
	DiagUnavailable DiagnosticCompleteness = "unavailable"
)

// Capabilities reports what the topology can actually do for this OpenCode.
// Fields are per-topology truth; they are NOT faked. A false here means the
// corresponding /vh/opencode/* sub-endpoint (Slice 2+) MUST refuse rather than
// invent data.
type Capabilities struct {
	// CanRestart is true when the worker can restart OpenCode itself (owned +
	// detached: it can respawn on the same port). External requires an
	// operator-supplied restart command (deferred to a later slice).
	CanRestart bool `json:"can_restart"`
	// HasProcessOutput is true when the worker captures the process's merged
	// stdout/stderr (owned: into the ring; detached: onto a disk log the
	// worker can tail).
	HasProcessOutput bool `json:"has_process_output"`
	// HasLogTail is true when a bounded recent log tail is retrievable (owned
	// ring + detached disk log).
	HasLogTail bool `json:"has_log_tail"`
	// HasExitStatus is true when a reliable exit code is observable (owned via
	// a reaping Wait goroutine; detached is false because the pid may be
	// adopted/reused, so only pid-alive polling is available).
	HasExitStatus bool `json:"has_exit_status"`
}

// Snapshot is the read-only lifecycle view served by /vh/opencode/status. All
// fields are populated for every topology; "unobservable" values are nil/empty
// per the capability flags rather than omitted, so a client can branch on shape
// without a second round-trip.
type Snapshot struct {
	Topology               Topology               `json:"topology"`
	State                  State                  `json:"state"`
	StateChangedAt         time.Time              `json:"state_changed_at"`
	OpenCodeURL            string                 `json:"opencode_url,omitempty"`
	FailureSummary         string                 `json:"failure_summary,omitempty"`
	ExitCode               *int                   `json:"exit_code,omitempty"`
	Capabilities           Capabilities           `json:"capabilities"`
	DiagnosticCompleteness DiagnosticCompleteness `json:"diagnostic_completeness"`
}

// Lifecycle is the worker-local OpenCode state machine. Construct one per
// worker daemon; the topology is fixed for the lifetime of the object.
type Lifecycle struct {
	// ring holds the captured process output for owned and detached topologies
	// (process-output capture is possible). nil for external (no output
	// observability). Guarded by mu.
	ring *ringlog.Ring

	caps Capabilities
	diag DiagnosticCompleteness

	mu             sync.Mutex
	topology       Topology
	state          State
	stateChangedAt time.Time
	opencodeURL    string
	failureSummary string
	exitCode       *int
}

// New returns a Lifecycle for the given topology, starting in StateStarting.
// The ring is allocated for owned and detached topologies; external gets none.
func New(topology Topology) *Lifecycle {
	l := &Lifecycle{
		topology:       topology,
		state:          StateStarting,
		stateChangedAt: time.Now(),
	}
	switch topology {
	case TopologyOwned:
		l.ring = ringlog.New(ringlog.DefaultCap)
		l.caps = Capabilities{
			CanRestart:       true,
			HasProcessOutput: true,
			HasLogTail:       true,
			HasExitStatus:    true,
		}
		l.diag = DiagComplete
	case TopologyDetached:
		l.ring = ringlog.New(ringlog.DefaultCap)
		l.caps = Capabilities{
			CanRestart:       true,
			HasProcessOutput: true,
			HasLogTail:       true,
			HasExitStatus:    false, // partial: pid-alive polling only
		}
		l.diag = DiagPartial
	default: // TopologyExternal
		l.caps = Capabilities{} // all false
		l.diag = DiagUnavailable
	}
	return l
}

// SetReady marks the process reachable and serving.
func (l *Lifecycle) SetReady() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.transition(StateReady, "", nil)
}

// SetFailed marks a startup gate or the process itself failed. summary is a
// concise human-readable cause; exit is the reaped exit code when observable
// (nil for startup-gate failures with no process exit yet).
func (l *Lifecycle) SetFailed(summary string, exit *int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.transition(StateFailed, summary, exit)
}

// SetStarting marks the process spawned/respawning and awaiting readiness
// (used at construction and during a restart sequence).
func (l *Lifecycle) SetStarting() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.transition(StateStarting, "", nil)
}

// SetStopped marks an intentional shutdown (clean exit code 0 or a
// user-initiated stop).
func (l *Lifecycle) SetStopped() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.transition(StateStopped, "", nil)
}

// SetUnknown records that the worker cannot determine the process state (e.g.
// an external OpenCode unreachable at probe time).
func (l *Lifecycle) SetUnknown() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.transition(StateUnknown, "", nil)
}

// transition sets the state and records the change time + detail. Caller holds
// mu. A move into failed records the summary + exit code; any other state
// clears stale failure detail so a snapshot never shows failure info that
// belongs to a prior failed spell (restart sequences go failed→starting→ready).
func (l *Lifecycle) transition(state State, summary string, exit *int) {
	l.state = state
	l.stateChangedAt = time.Now()
	if state == StateFailed {
		l.failureSummary = summary
		l.exitCode = exit
	} else {
		l.failureSummary = ""
		l.exitCode = nil
	}
}

// SetOpenCodeURL records the OpenCode base URL the aggregator/reverse-proxy
// dials. Set once the topology arm resolves it (even on failure — the URL is
// what the lazy proxy needs to stay well-formed; a dead URL yields per-request
// 502 rather than a construction error).
func (l *Lifecycle) SetOpenCodeURL(u string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.opencodeURL = u
}

// Ring returns the process-output ring, or nil for topologies that don't
// capture output (external). The returned ring is shared; callers writing to
// it (e.g. an io.MultiWriter fan-out from the process's stdout/stderr) append
// concurrently, and reads via Snapshot/Tail are safe.
func (l *Lifecycle) Ring() *ringlog.Ring {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.ring
}

// Snapshot returns a point-in-time copy of the lifecycle state.
func (l *Lifecycle) Snapshot() Snapshot {
	l.mu.Lock()
	defer l.mu.Unlock()
	return Snapshot{
		Topology:               l.topology,
		State:                  l.state,
		StateChangedAt:         l.stateChangedAt,
		OpenCodeURL:            l.opencodeURL,
		FailureSummary:         l.failureSummary,
		ExitCode:               l.exitCode,
		Capabilities:           l.caps,
		DiagnosticCompleteness: l.diag,
	}
}
