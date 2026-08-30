package cmd

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"

	"github.com/vhqtvn/vh-solara/pkg/oclife"
	"github.com/vhqtvn/vh-solara/pkg/procmgr"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// clientDaemonRuntime carries the state the client-daemon Run closure builds
// and shares across the web-mode setup, the agent daemon wiring, and the
// teardown/health owners. It is constructed by newClientDaemonRuntime from the
// resolved flags/env (the preamble) and the zero-valued hoisted handles; the
// web-mode methods populate it, and KillFunc/HealthCheck read it.
//
// Lifetime: one struct per process. It is heap-allocated (closures passed to
// the web Server and the agent Daemon escape it) which is semantically
// identical to the closure captures it replaces.
type clientDaemonRuntime struct {
	// Preamble-derived config (flags + env).
	cwd        string
	webPort    int
	workerID   string
	workerName string
	headerMap  map[string]string

	// Track the opencode web process (opencode web mode) so we can clean it up on shutdown.
	opencodeWebCmd *exec.Cmd
	// vh mode: the internal `opencode serve` process, plus a cancel for the
	// aggregator goroutine and a handle to the embedded web server.
	opencodeServeCmd *exec.Cmd
	opencodeMu       sync.Mutex // serializes restarts of opencodeServeCmd
	// ocReapDone is closed by the owned-topology reaper goroutine once it has
	// reaped opencodeServeCmd (the SOLE Wait() caller in normal operation).
	// restartOpencode waits on it instead of a racing second Wait(). It is a
	// receive-only view of the current child's reaper-done channel; the
	// restart path hands the shared owned-restart operation a fresh one per
	// replacement child.
	ocReapDone <-chan struct{}
	// ocLife is the worker-local OpenCode lifecycle, served at
	// /vh/opencode/status. nil outside the WebVH arm. It is the decoupling
	// hinge: a fatal OpenCode startup failure is recorded here as a failed
	// state instead of killing the reporting worker.
	ocLife   *oclife.Lifecycle
	vhCancel context.CancelFunc
	vhHTTP   *http.Server
	// vhSrv is the vh web Server (set only in the WebOpenChamber case where
	// the daemon builds it). Hoisted to this scope so daemon.KillFunc (after
	// the switch) can cancel + await its owned background goroutines.
	vhSrv *web.Server
	// vhUDS is the optional AF_UNIX listener for /vh/*. Retained for
	// reachability; the original in-closure defers that closed/removed it
	// never fired (os.Exit in KillFunc preempts defers), and serveUnixSocket
	// owns a Serve goroutine that keeps the socket open for the process
	// lifetime — that effective behavior is preserved.
	vhUDS *http.Server
	// Managed-project process manager (torn down alongside OpenCode).
	procMgr       *procmgr.Manager
	procCtxCancel context.CancelFunc

	// WebVH topology state (captured by restartOpencode + the vh hooks).
	external     bool
	opencodeURL  string
	opencodePort int
}

// newClientDaemonRuntime resolves the daemon flags + env into the runtime
// preamble fields. The hoisted web-mode handles are left zero (nil) and are
// populated by the setup methods depending on the selected --web mode.
func newClientDaemonRuntime() *clientDaemonRuntime {
	rt := &clientDaemonRuntime{}

	// Parse headers array into map "K: V"
	rt.headerMap = make(map[string]string)
	for _, h := range daemonHeaders {
		parts := strings.SplitN(h, ":", 2)
		if len(parts) == 2 {
			rt.headerMap[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
		}
	}
	// Registration secret (if the controller requires one). Env wins so it
	// needn't appear in the process args.
	secret := daemonControllerSecret
	if v := os.Getenv("VH_CONTROLLER_SECRET"); v != "" {
		secret = v
	}
	if secret != "" {
		rt.headerMap["X-VH-Worker-Secret"] = secret
	}

	rt.workerID = daemonWorkerID

	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	rt.cwd = cwd

	rt.workerName = daemonWorkerName
	if rt.workerName == "" {
		rt.workerName = fmt.Sprintf("Local Devbox (%s)", cwd)
	}

	rt.webPort = daemonWebPort
	return rt
}
