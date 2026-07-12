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

func ocProjectKey() string {
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	sum := sha1.Sum([]byte(cwd))
	return hex.EncodeToString(sum[:])
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
// ownership falls back to pid-alive + port-responds.
func ocCmdlineMatches(pid, port int) bool {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return true
	}
	args := strings.ReplaceAll(string(b), "\x00", " ")
	return strings.Contains(args, "opencode") && strings.Contains(args, "--port "+strconv.Itoa(port))
}

func ocPortResponds(port int) bool {
	cl := &http.Client{Timeout: 2 * time.Second}
	resp, err := cl.Get(fmt.Sprintf("http://127.0.0.1:%d/session", port))
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode < 500
}

// ocInstanceOurs reports whether the recorded instance is still our live OpenCode.
func ocInstanceOurs(s ocState) bool {
	return ocProcessAlive(s.PID) && ocCmdlineMatches(s.PID, s.Port) && ocPortResponds(s.Port)
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
func startOpenCodeServeDetached(bin string, port int, workspace string, extraW ...io.Writer) (*exec.Cmd, error) {
	if bin == "" {
		bin = "opencode"
	}
	cmd := exec.Command(bin, "serve", "--port", strconv.Itoa(port), "--hostname", "127.0.0.1")
	if workspace != "" {
		cmd.Dir = workspace
	}
	cmd.Env = os.Environ()
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
