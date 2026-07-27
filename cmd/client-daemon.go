package cmd

import (
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strconv"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/vhqtvn/vh-solara/pkg/agent"
	"github.com/vhqtvn/vh-solara/pkg/oclife"
)

const (
	WebOpenCode    = "opencode"
	WebOpenChamber = "openchamber"
	WebVH          = "vh"

	// vhEventRingCapacity bounds the daemon's replayable client-event log.
	vhEventRingCapacity = 4096
)

var (
	daemonController       string
	daemonWorkerID         string
	daemonWorkerName       string
	daemonHeaders          []string
	daemonControllerSecret string
	daemonWeb              string
	daemonChamber          string
	daemonWebPort          int
	daemonVHSock           string
	daemonOpenCodeBin      string
	daemonOpenCodeHost     string
	daemonOpenCodePasswd   string
	daemonOpenCodeUpdate   string
	daemonOpenCodeURL      string
	daemonOpenCodeRestart  string
	daemonOpenCodeDetached bool
	daemonExternalManaged  bool
	daemonCORSOrigins      []string
	daemonProjectConfig    string // --project-config override path for managed projects
	daemonTrustOnOpen      bool   // headless: auto-approve repo-declared configs
)

var clientDaemonCmd = &cobra.Command{
	Use:   "client-daemon",
	Short: "Run the persistent client daemon",
	Run: func(cmd *cobra.Command, args []string) {
		log.Printf("Starting vh-solara client-daemon...")

		rt := newClientDaemonRuntime()

		// Mode owner: select and start the web UI backend per --web.
		rt.setupWebMode()

		// Runtime owner: wire the controller-tunnel agent daemon.
		proxy := agent.NewProxy(rt.webPort)
		daemon := agent.NewDaemon(daemonController, rt.workerID, rt.workerName, "0.1.0", rt.headerMap, proxy)

		// Teardown + health owners.
		rt.attachKillFunc(daemon)
		rt.attachHealthCheck(daemon)

		go daemon.Start()

		log.Printf("Daemon Proxy started for WorkerID %s (Web: %s, Port: %d)", rt.workerID, daemonWeb, rt.webPort)

		// Wait for shutdown signal
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
		<-sigCh

		log.Println("Received termination signal, shutting down...")
		daemon.KillFunc()
	},
}

// freePort returns an OS-assigned free TCP port on 127.0.0.1.
func freePort() int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 8080 // fallback
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func getRunningOpenChamberPort(chamberScript string) (int, error) {
	cmd := exec.Command("bash", "-c", fmt.Sprintf("%s status", chamberScript))
	out, err := cmd.Output()
	if err != nil {
		return 0, fmt.Errorf("status command failed: %v", err)
	}

	re := regexp.MustCompile(`◆\s+port\s+(\d+)`)
	matches := re.FindAllStringSubmatch(string(out), -1)
	if len(matches) > 0 {
		port, err := strconv.Atoi(matches[0][1])
		if err == nil {
			return port, nil
		}
	}
	return 0, fmt.Errorf("no running openchamber port pattern matched")
}

func startOpenChamber(chamberScript string, webPort int, workspace string) error {
	scriptWithArgs := fmt.Sprintf("%s --port %d", chamberScript, webPort)
	cmd := exec.Command("bash", "-c", scriptWithArgs)
	if workspace != "" {
		cmd.Dir = workspace
	}

	cmd.Env = os.Environ()
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start openchamber: %v", err)
	}

	// Do not wait or hold onto cmd.Process - let it daemonize / run independently
	return nil
}

// startOpenCodeWeb launches `opencode web` detached, returning the started cmd.
// The process is tracked by the caller so it can be terminated on shutdown.
func startOpenCodeWeb(bin, hostname string, port int, password, workspace string) (*exec.Cmd, error) {
	if bin == "" {
		bin = "opencode"
	}
	cmd := exec.Command(bin, "web", "--port", strconv.Itoa(port), "--hostname", hostname)
	if workspace != "" {
		cmd.Dir = workspace
	}
	cmd.Env = os.Environ()
	if password != "" {
		cmd.Env = append(cmd.Env, "OPENCODE_SERVER_PASSWORD="+password)
	}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	// Apply platform-specific process-group / death-signal settings so the
	// child dies with the daemon (no orphan on abrupt daemon exit).
	setDetachedAttrs(cmd)

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start opencode web: %v", err)
	}
	return cmd, nil
}

// startOpenCodeServe launches `opencode serve` headless on a loopback port,
// returning the started cmd. No server password is set: the internal server is
// bound to 127.0.0.1 and only reachable through the tunnel, where the controller
// and nginx enforce auth. When extraW writers are supplied, the process's
// stdout/stderr are fanned out to them IN ADDITION to the daemon's own stdout —
// used to mirror output into the OpenCode lifecycle ring (owned topology) so
// /vh/opencode/logs (Slice 2) can serve a bounded tail from a captured child.
func startOpenCodeServe(bin string, port int, workspace string, extraW ...io.Writer) (*exec.Cmd, error) {
	if bin == "" {
		bin = "opencode"
	}
	cmd := exec.Command(bin, "serve", "--port", strconv.Itoa(port), "--hostname", "127.0.0.1")
	if workspace != "" {
		cmd.Dir = workspace
	}
	cmd.Env = os.Environ()
	// Fan stdout/stderr to the daemon's inherited stdout AND any extra sinks
	// (the lifecycle ring). nil sinks are dropped so a caller passing an
	// explicit nil stays safe; io.MultiWriter panics on a nil Write.
	sinks := []io.Writer{os.Stdout}
	for _, w := range extraW {
		if w != nil {
			sinks = append(sinks, w)
		}
	}
	if len(sinks) == 1 {
		cmd.Stdout = sinks[0]
		cmd.Stderr = sinks[0]
	} else {
		mw := io.MultiWriter(sinks...)
		cmd.Stdout = mw
		cmd.Stderr = mw
	}

	// Tie the child's lifetime to the daemon (no orphan on abrupt daemon exit).
	setDetachedAttrs(cmd)

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start opencode serve: %v", err)
	}
	return cmd, nil
}

func waitForPort(port int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
		if err == nil {
			conn.Close()
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("port %d not ready after %v", port, timeout)
}

// waitForURL polls a URL until it answers (any non-5xx) or times out — used to
// confirm an externally-managed OpenCode is reachable.
func waitForURL(url string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	cl := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		resp, err := cl.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode < 500 {
				return nil
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("%s not reachable after %v", url, timeout)
}

// reapOwnedOpenCode is the SOLE Wait() caller for the owned `opencode serve`
// child during normal operation. It exists so a POST-STARTUP crash is observed:
// it records the exit in the lifecycle (so /vh/opencode/status reflects death
// rather than lying "ready") and, as a side effect, populates cmd.ProcessState
// (which the old HealthCheck relied on but never got, because nothing reaped
// the owned child). The done channel is closed once the reap completes, so
// restartOpencode can observe it instead of a racing second Wait (a
// second Wait on the same *Cmd races the first and is a data race).
//
// A clean (code 0) exit is recorded as stopped; any other exit (or a Wait
// error) is recorded as failed with the exit code when observable. life may be
// nil for callers that only want the reap side effect.
//
// ORDERING INVARIANT: the lifecycle state-set (SetStopped/SetFailed) MUST
// happen BEFORE close(done). restartOpencode unblocks its owned restart
// on <-oldDone, so closing done only after the state is recorded guarantees
// that the restart path's SetStarting() → SetReady() overwrites the reaper's
// honest exit report in the correct order. Closing done first (the old
// ordering) let this reaper's state-set land AFTER the fresh SetReady() under
// scheduler/GC delay, stranding the lifecycle on failed/stopped until the next
// poll. See TestReapOwnedOpenCode* for the ordering guarantee.
func reapOwnedOpenCode(cmd *exec.Cmd, done chan struct{}, life *oclife.Lifecycle) {
	err := cmd.Wait()
	var (
		ec      *int
		summary string
	)
	if cmd.ProcessState != nil {
		code := cmd.ProcessState.ExitCode()
		ec = &code
	}
	if err != nil {
		summary = err.Error()
	}
	// Record the exit BEFORE closing done — see the ORDERING INVARIANT above.
	if life != nil {
		switch {
		case ec != nil && *ec == 0 && summary == "":
			life.SetStopped()
		case summary == "" && ec != nil:
			life.SetFailed(fmt.Sprintf("opencode serve exited with code %d", *ec), ec)
		case summary == "":
			life.SetFailed("opencode serve exited", ec)
		default:
			life.SetFailed(summary, ec)
		}
	}
	// Close done LAST so a caller observing it knows the reaper has fully
	// recorded the exit (both the Wait return and the lifecycle state-set).
	if done != nil {
		close(done)
	}
}

func init() {
	clientDaemonCmd.Flags().StringVarP(&daemonController, "controller", "c", "ws://localhost:8080/vh-solara/ws", "Controller websocket URL")
	clientDaemonCmd.Flags().StringSliceVarP(&daemonHeaders, "header", "H", []string{}, "Custom headers to pass to the controller")
	clientDaemonCmd.Flags().StringVar(&daemonControllerSecret, "controller-secret", "", "Registration secret the controller requires (sent as X-VH-Worker-Secret; prefer the VH_CONTROLLER_SECRET env var)")
	clientDaemonCmd.Flags().StringVar(&daemonWorkerID, "id", "", "Worker ID (required)")
	clientDaemonCmd.MarkFlagRequired("id")
	clientDaemonCmd.Flags().StringVar(&daemonWorkerName, "name", "", "Worker Name (auto-generated if empty)")

	// Web UI selector
	clientDaemonCmd.Flags().StringVar(&daemonWeb, "web", WebOpenCode, "Web UI backend: vh (built-in stateful UI), opencode (built-in `opencode web`), or openchamber")
	clientDaemonCmd.Flags().StringVar(&daemonChamber, "chamber", "", "(openchamber only) Bash script to start OpenChamber")
	clientDaemonCmd.Flags().IntVar(&daemonWebPort, "web-port", 0, "Port for the worker's web UI to listen on (0 to auto-assign). Pin it if a local 'mcp --local' needs a stable base-url.")
	// Deprecated alias for --web-port (legacy name from the OpenChamber era; this
	// port is the generic web-UI port for every --web mode, not OpenChamber-only).
	clientDaemonCmd.Flags().IntVar(&daemonWebPort, "chamber-port", 0, "Deprecated: use --web-port")
	_ = clientDaemonCmd.Flags().MarkDeprecated("chamber-port", "use --web-port")
	clientDaemonCmd.Flags().StringVar(&daemonVHSock, "vh-sock", "", "(vh only) Also serve /vh/* on this AF_UNIX socket path (bind-mount it to reach the worker from a container with no host networking)")

	// opencode web mode options
	clientDaemonCmd.Flags().StringVar(&daemonOpenCodeBin, "opencode-bin", "opencode", "(opencode only) Path to the opencode binary")
	clientDaemonCmd.Flags().StringVar(&daemonOpenCodeHost, "opencode-hostname", "127.0.0.1", "(opencode only) Hostname for `opencode web --hostname`")
	clientDaemonCmd.Flags().StringVar(&daemonOpenCodePasswd, "opencode-password", "", "(opencode only) Sets OPENCODE_SERVER_PASSWORD for the web UI")
	clientDaemonCmd.Flags().StringVar(&daemonOpenCodeUpdate, "opencode-update-cmd", "", "(vh only) Command to update OpenCode (default: `<opencode-bin> upgrade`); runs in OpenCode's environment")
	clientDaemonCmd.Flags().StringArrayVar(&daemonCORSOrigins, "cors-origin", nil, "(vh only) Allowed cross-origin caller (repeatable; e.g. https://app.example.com, or * to allow any)")
	clientDaemonCmd.Flags().StringVar(&daemonOpenCodeURL, "opencode-url", "", "(vh only) Attach to an externally-managed OpenCode at this URL instead of spawning one (e.g. http://127.0.0.1:4096)")
	clientDaemonCmd.Flags().BoolVar(&daemonExternalManaged, "external-managed", false, "(vh only) The vh daemon is run under a supervisor (e.g. systemd, Restart=always); on a 'restart server' request it exits cleanly and lets the supervisor relaunch it, instead of re-exec'ing itself")
	clientDaemonCmd.Flags().StringVar(&daemonOpenCodeRestart, "opencode-restart-cmd", "", "(vh only, external) Command to restart externally-managed OpenCode, e.g. 'systemctl --user restart opencode'")
	clientDaemonCmd.Flags().BoolVar(&daemonOpenCodeDetached, "opencode-detached", false, "(vh only) Spawn OpenCode detached and reconnect to it across vh restarts (survives self-update); vh owns it via a pidfile")

	// Managed-project processes + views (repo-declared .vh-solara/project.jsonc).
	clientDaemonCmd.Flags().StringVar(&daemonProjectConfig, "project-config", "", "(vh only) Override path to the managed-project config (default: <project>/.vh-solara/project.jsonc)")
	clientDaemonCmd.Flags().BoolVar(&daemonTrustOnOpen, "trust-on-open", false, "(vh only) Auto-approve repo-declared configs without a prompt (headless escape hatch; also set via VH_TRUST_CONFIG=1). Use only on trusted single-user setups")

	rootCmd.AddCommand(clientDaemonCmd)
}
