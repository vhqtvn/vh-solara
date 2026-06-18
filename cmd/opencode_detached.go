package cmd

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
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
// when the daemon exits).
func startOpenCodeServeDetached(bin string, port int, workspace string) (*exec.Cmd, error) {
	if bin == "" {
		bin = "opencode"
	}
	cmd := exec.Command(bin, "serve", "--port", strconv.Itoa(port), "--hostname", "127.0.0.1")
	if workspace != "" {
		cmd.Dir = workspace
	}
	cmd.Env = os.Environ()
	if lf, err := os.OpenFile(ocLogPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
		cmd.Stdout = lf
		cmd.Stderr = lf
	}
	setSurviveAttrs(cmd)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start detached opencode serve: %v", err)
	}
	return cmd, nil
}
