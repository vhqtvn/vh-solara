package cmd

import (
	"context"
	"log"
	"os"
	"syscall"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/agent"
)

// attachKillFunc wires daemon.KillFunc — the teardown owner — to the runtime's
// web-mode handles. It is invoked from the SIGINT/SIGTERM handler (and from the
// agent Daemon's own HealthCheck-exit path) and tears the started children down
// in the same order as the original in-closure KillFunc.
func (rt *clientDaemonRuntime) attachKillFunc(daemon *agent.Daemon) {
	daemon.KillFunc = func() {
		if rt.opencodeWebCmd != nil && rt.opencodeWebCmd.Process != nil {
			log.Printf("Stopping opencode web (pid=%d)...", rt.opencodeWebCmd.Process.Pid)
			_ = rt.opencodeWebCmd.Process.Signal(syscall.SIGTERM)
		}
		if rt.vhCancel != nil {
			rt.vhCancel()
		}
		if rt.vhHTTP != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_ = rt.vhHTTP.Shutdown(ctx)
			cancel()
		}
		// Issue A: cancel + await the Server's owned background goroutines
		// (post-archive re-assert) so no detached goroutine outlives the
		// daemon at the controller-tunnel teardown path. vhSrv is set only
		// in the WebOpenChamber case; nil in the others (no web.Server).
		if rt.vhSrv != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_ = rt.vhSrv.Shutdown(ctx)
			cancel()
		}
		// In detached mode we deliberately leave OpenCode running so a vh
		// restart/self-update reconnects to the same instance.
		if rt.opencodeServeCmd != nil && rt.opencodeServeCmd.Process != nil && !daemonOpenCodeDetached {
			log.Printf("Stopping opencode serve (pid=%d)...", rt.opencodeServeCmd.Process.Pid)
			_ = rt.opencodeServeCmd.Process.Signal(syscall.SIGTERM)
		}
		// Tear down repo-declared managed processes (SIGTERM the process
		// groups) and stop their supervisor goroutines.
		if rt.procMgr != nil {
			rt.procMgr.StopAll()
		}
		if rt.procCtxCancel != nil {
			rt.procCtxCancel()
		}
		removeDaemonState()
		os.Exit(0)
	}
}

// attachHealthCheck wires daemon.HealthCheck — the health owner. A false
// return exits the agent Daemon (pkg/agent/daemon.go). The WebVH arm always
// returns true: OpenCode health is a SEPARATE concern surfaced via ocLife, so
// a dead OpenCode must NOT take the reporting worker offline (p1-oc-001).
func (rt *clientDaemonRuntime) attachHealthCheck(daemon *agent.Daemon) {
	daemon.HealthCheck = func() bool {
		switch daemonWeb {
		case WebOpenCode:
			if rt.opencodeWebCmd != nil && rt.opencodeWebCmd.Process != nil {
				// process is no longer alive => definitively dead
				if rt.opencodeWebCmd.ProcessState != nil {
					return false
				}
			}
			return true
		case WebOpenChamber:
			if daemonChamber == "" {
				return true // No script to verify, assume alive to avoid false positives
			}
			port, err := getRunningOpenChamberPort(daemonChamber)
			if err != nil || port != rt.webPort {
				return false // Definitive proof it's dead
			}
			return true
		case WebVH:
			// The worker's OWN web server is alive as long as this daemon
			// process is running (it is this process). OpenCode health is a
			// SEPARATE concern, surfaced via /vh/opencode/status (ocLife) —
			// a dead OpenCode must NOT take the reporting worker offline.
			// Returning false here exits the daemon (pkg/agent/daemon.go),
			// so the old opencodeServeCmd.ProcessState check that coupled
			// worker death to OpenCode death is deliberately removed as the
			// core of p1-oc-001's decoupling.
			return true
		}
		return true
	}
}
