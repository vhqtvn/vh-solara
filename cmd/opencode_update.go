package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

var semverRe = regexp.MustCompile(`v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)`)

// Running-version tracking: the version of the live `opencode serve` process,
// captured each time we (re)start it. Distinct from the on-disk installed
// version, which an update advances without touching the running process.
var (
	ocRunningMu  sync.Mutex
	ocRunningVer string
)

// setOpenCodeRunningVersion records the version of the just-(re)started serve.
func setOpenCodeRunningVersion(v string) {
	ocRunningMu.Lock()
	ocRunningVer = v
	ocRunningMu.Unlock()
}

// openCodeRunningVersion returns the last-captured running version.
func openCodeRunningVersion() string {
	ocRunningMu.Lock()
	defer ocRunningMu.Unlock()
	return ocRunningVer
}

func normVer(s string) string {
	if m := semverRe.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return ""
}

// opencodeCurrentVersion runs `<bin> --version` in OpenCode's environment.
func opencodeCurrentVersion(ctx context.Context, bin, cwd string) string {
	if bin == "" {
		bin = "opencode"
	}
	c := exec.CommandContext(ctx, bin, "--version")
	c.Env = os.Environ()
	c.Dir = cwd
	out, err := c.Output()
	if err != nil {
		return ""
	}
	return normVer(string(out))
}

// opencodeLatestVersion queries the npm registry for the latest opencode-ai.
// Best-effort: returns "" on any failure (the update can still be triggered).
func opencodeLatestVersion(ctx context.Context) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://registry.npmjs.org/opencode-ai/latest", nil)
	if err != nil {
		return ""
	}
	cl := &http.Client{Timeout: 10 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	var v struct {
		Version string `json:"version"`
	}
	if json.NewDecoder(resp.Body).Decode(&v) != nil {
		return ""
	}
	return normVer(v.Version)
}

// runOpencodeUpdate updates OpenCode in its own environment (so an nvm/PATH
// wrapper is honoured): the default is `<bin> upgrade`, overridable with a
// custom shell command (--opencode-update-cmd). Output streams to w (and the
// daemon log) so the UI can show the install log live. It does NOT restart
// OpenCode — that's a separate, explicit step.
func runOpencodeUpdate(ctx context.Context, bin, customCmd, cwd string, w io.Writer) error {
	if bin == "" {
		bin = "opencode"
	}
	out := io.MultiWriter(w, os.Stdout) // stream to client AND keep the server log
	cmdStr := strings.TrimSpace(customCmd)
	if cmdStr == "" {
		cmdStr = bin + " upgrade"
	}
	fmt.Fprintf(out, "[vh] running: %s\n", cmdStr)
	if err := runShellCmd(ctx, cmdStr, cwd, out); err != nil {
		return fmt.Errorf("opencode update failed: %w", err)
	}
	return nil
}

// runShellCmd runs a command via the platform shell, inheriting the daemon's
// environment (so an nvm/PATH wrapper is honoured) and the workspace dir. If w is
// nil, output goes to the daemon's stdout/stderr.
func runShellCmd(ctx context.Context, command, cwd string, w io.Writer) error {
	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.CommandContext(ctx, "cmd", "/c", command)
	} else {
		c = exec.CommandContext(ctx, "sh", "-c", command)
	}
	c.Env = os.Environ()
	c.Dir = cwd
	if w == nil {
		c.Stdout, c.Stderr = os.Stdout, os.Stderr
	} else {
		c.Stdout, c.Stderr = w, w
	}
	return c.Run()
}
