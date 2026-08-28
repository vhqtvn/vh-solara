package cmd

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/ringlog"
)

// Managed-but-survivable OpenCode: vh spawns `opencode serve` DETACHED and
// records {pid,port} in a per-project state file. On (re)start vh checks whether
// that instance is still ours and reachable; if so it reconnects instead of
// spawning a duplicate, so a vh restart/self-update doesn't kill the user's
// OpenCode session.

type ocState struct {
	PID  int `json:"pid"`
	Port int `json:"port"`
}

func ocStateBaseDir() string {
	if d := os.Getenv("VH_STATE_DIR"); d != "" {
		return d
	}
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "vh-solara")
}

func ocStateDir() string {
	dir := filepath.Join(ocStateBaseDir(), "opencode")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

// OCProjectKey returns the per-project key the detached-OpenCode state, log,
// and lock files are named by: the sha1 of the given working directory, hex
// encoded. Exported so cross-package tests (tests/integration) derive the
// exact key the binaries use instead of reimplementing the derivation (a
// reimplementation would silently drift if the key function ever changes).
func OCProjectKey(dir string) string {
	sum := sha1.Sum([]byte(dir))
	return hex.EncodeToString(sum[:])
}

func ocProjectKey() string {
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	return OCProjectKey(cwd)
}

func ocStatePath() string { return filepath.Join(ocStateDir(), ocProjectKey()+".json") }
func ocLogPath() string   { return filepath.Join(ocStateDir(), ocProjectKey()+".log") }

func readOCState() (ocState, bool) { return readOCStateFrom(ocStatePath()) }

func readOCStateFrom(path string) (ocState, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return ocState{}, false
	}
	var s ocState
	if json.Unmarshal(b, &s) != nil || s.PID <= 0 || s.Port <= 0 {
		return ocState{}, false
	}
	return s, true
}

// --- vh daemon registry (so `vh-solara kill` can find running daemons) ---

type daemonState struct {
	PID int    `json:"pid"`
	CWD string `json:"cwd"`
}

func daemonStateDir() string {
	dir := filepath.Join(ocStateBaseDir(), "daemons")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}
func daemonStatePath() string { return filepath.Join(daemonStateDir(), ocProjectKey()+".json") }

func writeDaemonState() {
	cwd, _ := os.Getwd()
	b, _ := json.Marshal(daemonState{PID: os.Getpid(), CWD: cwd})
	tmp := daemonStatePath() + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		_ = os.Rename(tmp, daemonStatePath())
	}
}
func removeDaemonState() { _ = os.Remove(daemonStatePath()) }

func writeOCState(s ocState) {
	b, _ := json.Marshal(s)
	tmp := ocStatePath() + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		_ = os.Rename(tmp, ocStatePath())
	}
}

func ocProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil // unix: nil = exists; windows: errs → false
}

// ocCmdlineMatches confirms the pid is an `opencode serve` on our port (Linux
// /proc). On platforms without /proc it returns true (can't verify), so
// ownership falls back to pid-alive alone — a live recorded pid is then never
// spawned beside, and the HTTP probe only picks reattach vs failed. A zombie
// or recycled pid reads back empty/foreign cmdline here → false (may spawn).
func ocCmdlineMatches(pid, port int) bool {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return true
	}
	args := strings.ReplaceAll(string(b), "\x00", " ")
	return strings.Contains(args, "opencode") && strings.Contains(args, "--port "+strconv.Itoa(port))
}

// --- detached-instance gate (split-brain guard) ---
//
// INCIDENT (2026-08-28): a daemon restart at peak load probed the recorded
// instance's /session, blew its 2s budget (the endpoint enumerates the whole
// session table and the instance was serving two streams + a supervisor turn),
// and fell into the spawn branch while the old pid was still alive and
// mid-turn. Result: two `opencode serve` processes on one project sqlite DB —
// in-flight runs continued invisibly on the orphan, the UI went stale, and a
// user resume started a duplicate run.
//
// The gate below therefore separates OWNERSHIP from ATTACHABILITY:
//
//   - Ownership (pid alive + cmdline matches `opencode serve --port N`) is
//     the spawn authority. Only a pid that is DEAD or recycled into a foreign
//     cmdline may be replaced by a fresh spawn.
//   - The HTTP probe only decides whether we can reattach RIGHT NOW. A live,
//     cmdline-matching instance that answers slowly (or not at all) is NEVER
//     spawned beside — spawning beside it is strictly worse than an explicit
//     ocLife failed state the operator can recover from remotely via the
//     restart action (which kills + respawns on the same port).
//
// EXPLICIT POLICY — probe refused + pid alive + cmdline match: NEVER spawn.
// Connection refused with a live, matching process means the listener died or
// is wedged while the process (which may still hold the project DB and finish
// in-flight runs) lives on. A zombie is not affected: its /proc cmdline reads
// back empty, so it classifies as recycled (may spawn).

type ocGateVerdict int

const (
	ocGateNoState  ocGateVerdict = iota // no recorded state: free to spawn
	ocGateForeign                       // recorded pid dead or recycled: free to spawn
	ocGateReattach                      // ours + answering: reattach, never spawn
	ocGateOccupied                      // ours but not answering: NEVER spawn
)

// maySpawn reports whether the verdict permits the spawn branch. It is the
// never-spawn-while-alive rule in code: ocGateOccupied — the only verdict
// whose pid is provably still our OpenCode — always answers false.
func (v ocGateVerdict) maySpawn() bool {
	return v == ocGateNoState || v == ocGateForeign
}

type ocGateReport struct {
	Verdict ocGateVerdict
	State   ocState
	Reason  string // operator-facing outcome, surfaced in logs + ocLife failures
}

// Probe tuning. Package vars so tests can shrink the retry window.
var (
	ocProbeAttempts = 3
	ocProbeTimeout  = 2 * time.Second
	ocProbeRetryGap = 500 * time.Millisecond
)

// classifyOCInstance is the single gate both detached spawn paths
// (client-daemon --web=vh and local-server --opencode-detached) route
// through before spawning or reattaching.
func classifyOCInstance(s ocState, ok bool) ocGateReport {
	if !ok {
		return ocGateReport{Verdict: ocGateNoState, Reason: "no recorded detached instance"}
	}
	if !ocProcessAlive(s.PID) {
		return ocGateReport{Verdict: ocGateForeign, State: s, Reason: fmt.Sprintf("recorded pid %d is not running", s.PID)}
	}
	if !ocCmdlineMatches(s.PID, s.Port) {
		return ocGateReport{Verdict: ocGateForeign, State: s, Reason: fmt.Sprintf("pid %d is alive but no longer `opencode serve --port %d` (recycled pid)", s.PID, s.Port)}
	}
	// pid alive + cmdline matches: the slot is OCCUPIED by our instance.
	// Spawning is forbidden no matter what the probe says; the probe only
	// chooses between reattach-now and an explicit failed lifecycle.
	reason := ocAttachable(s.Port)
	if reason == "" {
		return ocGateReport{Verdict: ocGateReattach, State: s, Reason: fmt.Sprintf("pid %d answering on port %d", s.PID, s.Port)}
	}
	return ocGateReport{Verdict: ocGateOccupied, State: s, Reason: reason}
}

// ocAttachable probes the recorded port with retries, returning "" when the
// instance is attachable, else the last observed failure for messages.
func ocAttachable(port int) string {
	var last string
	for i := 0; i < ocProbeAttempts; i++ {
		if i > 0 {
			time.Sleep(ocProbeRetryGap)
		}
		if last = ocProbePort(port); last == "" {
			return ""
		}
	}
	return last
}

// ocProbePort issues ONE probe attempt: cheap endpoint first, heavyweight
// fallback second. Returns "" when the listener answers (any HTTP status
// < 500 on either endpoint), else a human-readable failure.
//
// /api/health is a trivial liveness route in current opencode builds (see
// refs/opencode packages/protocol/src/groups/health.ts) with no DB work. On
// builds that predate the route it 404s — still proof the listener answers —
// so /session (which enumerates the whole session table and is exactly the
// endpoint a loaded instance blows the budget on) is only consulted when
// health is genuinely unreachable or 5xxing.
func ocProbePort(port int) string {
	cl := &http.Client{Timeout: ocProbeTimeout}
	var last string
	for _, path := range []string{"/api/health", "/session"} {
		resp, err := cl.Get(fmt.Sprintf("http://127.0.0.1:%d%s", port, path))
		if err != nil {
			last = fmt.Sprintf("GET %s: %v", path, err)
			continue
		}
		resp.Body.Close()
		if resp.StatusCode < 500 {
			return ""
		}
		last = fmt.Sprintf("GET %s: HTTP %d", path, resp.StatusCode)
	}
	return last
}

func portFree(port int) bool {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	ln.Close()
	return true
}

func killPID(pid int) {
	if pid <= 0 {
		return
	}
	if p, err := os.FindProcess(pid); err == nil {
		_ = p.Signal(syscall.SIGTERM)
	}
}

// startOpenCodeServeDetached spawns `opencode serve` fully detached (survives
// the daemon), logging to a per-project file (its inherited stdout would close
// when the daemon exits). When extraW writers are supplied, they are fanned out
// alongside the disk log — used to mirror the output into the OpenCode
// lifecycle ring so /vh/opencode/logs (Slice 2) can serve a bounded tail.
//
// extraFiles is the exec.Cmd.ExtraFiles payload for the spawn-slot owner-lock
// handoff (fd 3 in the child, non-CLOEXEC by construction); nil spawns without
// the handoff (non-Linux platforms, or callers outside the guarded
// transaction). Callers must NOT close the files themselves — the guarded
// choreography (startChildWithOwner) owns the parent's copy lifecycle.
func startOpenCodeServeDetached(bin string, port int, workspace string, extraFiles []*os.File, extraW ...io.Writer) (*exec.Cmd, error) {
	if bin == "" {
		bin = "opencode"
	}
	cmd := exec.Command(bin, "serve", "--port", strconv.Itoa(port), "--hostname", "127.0.0.1")
	if workspace != "" {
		cmd.Dir = workspace
	}
	cmd.Env = os.Environ()
	cmd.ExtraFiles = extraFiles
	// Fan output to the per-project disk log AND any extra sinks (the lifecycle
	// ring). A nil sink is dropped so a caller passing an explicit nil stays
	// safe; io.MultiWriter would otherwise panic on a nil Write.
	sinks := make([]io.Writer, 0, 1+len(extraW))
	if lf, err := os.OpenFile(ocLogPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
		sinks = append(sinks, lf)
	}
	for _, w := range extraW {
		if w != nil {
			sinks = append(sinks, w)
		}
	}
	if len(sinks) == 1 {
		cmd.Stdout = sinks[0]
		cmd.Stderr = sinks[0]
	} else if len(sinks) > 1 {
		mw := io.MultiWriter(sinks...)
		cmd.Stdout = mw
		cmd.Stderr = mw
	}
	setSurviveAttrs(cmd)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start detached opencode serve: %v", err)
	}
	return cmd, nil
}

// seedRingFromDiskLog loads a bounded tail of the detached OpenCode disk log
// into the lifecycle ring. It exists for the detached-reconnect path: a vh
// restart reconnects to a still-running detached OpenCode whose output keeps
// accumulating on disk, but the in-memory ring is fresh and empty — without
// seeding, /vh/opencode/logs answers 200 with an empty body despite
// HasLogTail=true (a capability-contract violation).
//
// Behavior:
//   - A nil ring is a no-op (defensive; external topology has none).
//   - A missing log file (fresh instance, never spawned) is a silent no-op.
//   - Otherwise the last ringlog.DefaultCap bytes are read (Seek + bounded
//     io.ReadAll) and appended to the ring. The ring evicts head over cap, so a
//     bounded seed is safe even if the file has grown huge.
//   - All errors are non-fatal: a missing/corrupt log must NOT block worker
//     startup. A warning is logged and the ring is left in whatever partial
//     state the read produced.
func seedRingFromDiskLog(ring *ringlog.Ring, logPath string) {
	if ring == nil {
		return
	}
	info, err := os.Stat(logPath)
	if err != nil {
		// Missing file = fresh instance (or first-ever detached spawn); not an error.
		return
	}
	if info.Size() == 0 {
		return
	}
	f, err := os.Open(logPath)
	if err != nil {
		log.Printf("seedRingFromDiskLog: open %s: %v (continuing with empty ring)", logPath, err)
		return
	}
	defer f.Close()
	var off int64
	if info.Size() > int64(ringlog.DefaultCap) {
		off = info.Size() - int64(ringlog.DefaultCap)
	}
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		log.Printf("seedRingFromDiskLog: seek %s: %v (continuing with empty ring)", logPath, err)
		return
	}
	tail, err := io.ReadAll(f)
	if err != nil {
		log.Printf("seedRingFromDiskLog: read %s: %v (continuing with partial ring)", logPath, err)
		return
	}
	ring.Append(string(tail))
}
