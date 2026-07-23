package cmd

import (
	"context"
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
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/vhqtvn/vh-solara/pkg/agent"
	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/oclife"
	"github.com/vhqtvn/vh-solara/pkg/procmgr"
	"github.com/vhqtvn/vh-solara/pkg/web"
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

		// Parse headers array into map "K: V"
		headerMap := make(map[string]string)
		for _, h := range daemonHeaders {
			parts := strings.SplitN(h, ":", 2)
			if len(parts) == 2 {
				headerMap[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
			}
		}
		// Registration secret (if the controller requires one). Env wins so it
		// needn't appear in the process args.
		secret := daemonControllerSecret
		if v := os.Getenv("VH_CONTROLLER_SECRET"); v != "" {
			secret = v
		}
		if secret != "" {
			headerMap["X-VH-Worker-Secret"] = secret
		}

		workerID := daemonWorkerID

		cwd, err := os.Getwd()
		if err != nil {
			cwd = "."
		}

		workerName := daemonWorkerName
		if workerName == "" {
			workerName = fmt.Sprintf("Local Devbox (%s)", cwd)
		}

		webPort := daemonWebPort

		// Track the opencode web process (opencode web mode) so we can clean it up on shutdown.
		var opencodeWebCmd *exec.Cmd
		// vh mode: the internal `opencode serve` process, plus a cancel for the
		// aggregator goroutine and a handle to the embedded web server.
		var opencodeServeCmd *exec.Cmd
		var opencodeMu sync.Mutex // serializes restarts of opencodeServeCmd
		// ocReapDone is closed by the owned-topology reaper goroutine once it has
		// reaped opencodeServeCmd (the SOLE Wait() caller in normal operation).
		// restartOpencodeLocked waits on it instead of a racing second Wait().
		var ocReapDone chan struct{}
		// ocLife is the worker-local OpenCode lifecycle, served at
		// /vh/opencode/status. nil outside the WebVH arm. It is the decoupling
		// hinge: a fatal OpenCode startup failure is recorded here as a failed
		// state instead of killing the reporting worker.
		var ocLife *oclife.Lifecycle
		var vhCancel context.CancelFunc
		var vhHTTP *http.Server
		// vhSrv is the vh web Server (set only in the WebOpenChamber case where
		// the daemon builds it). Hoisted to this scope so daemon.KillFunc (after
		// the switch) can cancel + await its owned background goroutines.
		var vhSrv *web.Server
		// Managed-project process manager (torn down alongside OpenCode).
		var procMgr *procmgr.Manager
		var procCtxCancel context.CancelFunc

		switch daemonWeb {
		case WebOpenCode:
			// OpenCode ships its own web UI via `opencode web`.
			// Auto-assign a free port if none was provided.
			if webPort == 0 {
				webPort = freePort()
			}
			log.Printf("Web mode: opencode web (bin=%s, port=%d, host=%s)", daemonOpenCodeBin, webPort, daemonOpenCodeHost)

			c, err := startOpenCodeWeb(daemonOpenCodeBin, daemonOpenCodeHost, webPort, daemonOpenCodePasswd, cwd)
			if err != nil {
				log.Fatalf("Failed to start opencode web: %v", err)
			}
			opencodeWebCmd = c
			log.Printf("Started opencode web on port %d (pid=%d)", webPort, c.Process.Pid)

			if err := waitForPort(webPort, 30*time.Second); err != nil {
				log.Fatalf("opencode web failed to listen on port %d: %v", webPort, err)
			}
			log.Printf("Verified opencode web is actively listening on port %d.", webPort)

		case WebOpenChamber:
			if daemonChamber != "" {
				// 1. Check if OpenChamber is already running
				port, err := getRunningOpenChamberPort(daemonChamber)
				if err == nil && port > 0 {
					log.Printf("Found existing OpenChamber running on port %d", port)
					webPort = port
				} else {
					log.Printf("No existing OpenChamber found (%v). Starting a new one...", err)
					if webPort == 0 {
						webPort = freePort()
					}

					err := startOpenChamber(daemonChamber, webPort, cwd)
					if err != nil {
						log.Fatalf("Failed to start OpenChamber: %v", err)
					}
					log.Printf("Started detached OpenChamber on port %d", webPort)
				}

				// Probe the port to ensure it's alive and listening
				if err := waitForPort(webPort, 15*time.Second); err != nil {
					log.Fatalf("OpenChamber failed to listen on port %d: %v", webPort, err)
				}
				log.Printf("Verified OpenChamber is actively listening on port %d.", webPort)
			}

		case WebVH:
			// vh-solara's own UI: run `opencode serve` headless on an internal
			// loopback port, aggregate its state, and serve our web UI on the
			// controller-proxied port.
			if webPort == 0 {
				webPort = freePort()
			}
			// OpenCode-external (attach, don't spawn) is enabled purely by URL.
			external := daemonOpenCodeURL != ""
			var opencodeURL string
			opencodePort := 0

			// The topology fixes the lifecycle capability posture (owned /
			// detached / external). It is determined BEFORE any spawn so that a
			// fatal spawn/listen failure can be recorded in the lifecycle
			// instead of killing the worker: the whole point of p1-oc-001 is
			// that a dead OpenCode must NOT take the reporting worker with it.
			var topo oclife.Topology
			switch {
			case external:
				topo = oclife.TopologyExternal
			case daemonOpenCodeDetached:
				topo = oclife.TopologyDetached
			default:
				topo = oclife.TopologyOwned
			}
			ocLife = oclife.New(topo)

			switch {
			case external:
				// External-managed: attach to an already-running OpenCode (e.g. its
				// own systemd service) instead of spawning one.
				opencodeURL = strings.TrimRight(daemonOpenCodeURL, "/")
				log.Printf("Web mode: vh (external OpenCode at %s, web port=%d)", opencodeURL, webPort)
				if err := waitForURL(opencodeURL+"/session", 30*time.Second); err != nil {
					// DECOUPLED: do NOT kill the worker. Record the failure and
					// keep serving so the operator can diagnose + restart OpenCode
					// remotely through the tunnel. opencodeURL stays set (the
					// lazy proxy dials it per-request and surfaces 502).
					log.Printf("external OpenCode not reachable at %s: %v (worker stays up; opencode status=failed)", opencodeURL, err)
					ocLife.SetFailed(fmt.Sprintf("external OpenCode not reachable at %s: %v", opencodeURL, err), nil)
				} else {
					ocLife.SetReady()
					log.Printf("Attached to external OpenCode at %s.", opencodeURL)
				}

			case daemonOpenCodeDetached:
				// Managed-but-survivable: reconnect to the OpenCode we spawned
				// previously (recorded in a pidfile) if it's still ours + reachable;
				// otherwise spawn a fresh detached one. Survives a vh restart/update.
				if st, ok := readOCState(); ok && ocInstanceOurs(st) {
					opencodePort = st.Port
					opencodeURL = fmt.Sprintf("http://127.0.0.1:%d", st.Port)
					ocLife.SetReady() // reconnected to a known-live instance
					// Seed the lifecycle ring with the detached disk-log tail so
					// /vh/opencode/logs reflects recent history after a vh reconnect:
					// the in-memory ring is fresh on restart, but the process kept
					// running and accumulating output on disk. Without this the
					// endpoint returns 200/empty despite HasLogTail=true.
					seedRingFromDiskLog(ocLife.Ring(), ocLogPath())
					log.Printf("Web mode: vh (reconnected to our detached OpenCode pid=%d port=%d, web port=%d)", st.PID, st.Port, webPort)
				} else {
					opencodePort = freePort()
					if st, ok := readOCState(); ok && portFree(st.Port) {
						opencodePort = st.Port // reuse the stable port when free
					}
					// Pre-set opencodeURL so a failure below still leaves a
					// parseable (dead) loopback target for the lazy proxy.
					opencodeURL = fmt.Sprintf("http://127.0.0.1:%d", opencodePort)
					// Fan the detached process's output into the lifecycle ring
					// alongside the per-project disk log (unblocks Slice 2 logs).
					c, err := startOpenCodeServeDetached(daemonOpenCodeBin, opencodePort, cwd, ocLife.Ring().Writer())
					if err != nil {
						log.Printf("Failed to start detached opencode serve: %v (worker stays up; opencode status=failed)", err)
						ocLife.SetFailed(fmt.Sprintf("failed to start detached opencode serve: %v", err), nil)
					} else {
						opencodeServeCmd = c
						if err := waitForPort(opencodePort, 30*time.Second); err != nil {
							log.Printf("opencode serve failed to listen on port %d: %v (worker stays up; opencode status=failed)", opencodePort, err)
							ocLife.SetFailed(fmt.Sprintf("opencode serve failed to listen on port %d: %v", opencodePort, err), nil)
						} else {
							writeOCState(ocState{PID: c.Process.Pid, Port: opencodePort})
							ocLife.SetReady()
							log.Printf("Web mode: vh (spawned detached OpenCode pid=%d port=%d, web port=%d)", c.Process.Pid, opencodePort, webPort)
						}
					}
				}

			default: // owned
				opencodePort = freePort()
				log.Printf("Web mode: vh (opencode serve internal port=%d, web port=%d)", opencodePort, webPort)
				// Pre-set opencodeURL so a failure below still leaves a parseable
				// (dead) loopback target for the lazy proxy.
				opencodeURL = fmt.Sprintf("http://127.0.0.1:%d", opencodePort)
				// Fan the owned process's output into the lifecycle ring alongside
				// the daemon's stdout (unblocks Slice 2 logs view).
				c, err := startOpenCodeServe(daemonOpenCodeBin, opencodePort, cwd, ocLife.Ring().Writer())
				if err != nil {
					log.Printf("Failed to start opencode serve: %v (worker stays up; opencode status=failed)", err)
					ocLife.SetFailed(fmt.Sprintf("failed to start opencode serve: %v", err), nil)
				} else {
					opencodeServeCmd = c
					log.Printf("Started opencode serve on port %d (pid=%d)", opencodePort, c.Process.Pid)
					// Owned reaper: the SOLE Wait() caller for this child during
					// normal operation. It records a post-startup crash in the
					// lifecycle (and, as a side effect, populates cmd.ProcessState
					// so the HealthCheck's existing ProcessState check works —
					// previously nobody reaped the owned child, so a crash was
					// never detected). The done channel lets restartOpencodeLocked
					// observe the reap without a racing second Wait().
					ocReapDone = make(chan struct{})
					go reapOwnedOpenCode(c, ocReapDone, ocLife)
					if err := waitForPort(opencodePort, 30*time.Second); err != nil {
						log.Printf("opencode serve failed to listen on port %d: %v (worker stays up; opencode status=failed)", opencodePort, err)
						ocLife.SetFailed(fmt.Sprintf("opencode serve failed to listen on port %d: %v", opencodePort, err), nil)
					} else {
						ocLife.SetReady()
						log.Printf("Verified opencode serve is listening on port %d.", opencodePort)
					}
				}
			}
			if opencodeURL == "" {
				// Defensive: every arm above sets a parseable URL (a dead
				// loopback on failure). If a future arm forgets, fall back
				// rather than kill the worker — the whole point of this slice.
				opencodeURL = "http://127.0.0.1:0"
				log.Printf("internal warning: opencodeURL not set by topology arm; using dead loopback %s", opencodeURL)
			}
			ocLife.SetOpenCodeURL(opencodeURL)
			// A detached OpenCode shares this process's systemd cgroup; with the
			// default KillMode=control-group a unit restart kills it too. Nudge the
			// operator to set KillMode=process so detached OpenCode actually survives.
			if daemonOpenCodeDetached && !external && os.Getenv("INVOCATION_ID") != "" {
				log.Printf("note: running --opencode-detached under systemd — set 'KillMode=process' in the vh unit so a restart doesn't kill OpenCode (see README)")
			}
			// Register this daemon so `vh-solara kill` can find it.
			writeDaemonState()

			// Capture the version of the serve we just started/attached as the
			// running version (distinct from on-disk installed after an update).
			setOpenCodeRunningVersion(opencodeCurrentVersion(context.Background(), daemonOpenCodeBin, cwd))

			agg := aggregator.New(opencodeURL, vhEventRingCapacity)

		// Build the web server first — it seeds the archived-session overlay
		// into the store before the aggregator hydrates.
		srv, err := web.NewServer(agg, opencodeURL, vhEventRingCapacity)
		if err != nil {
			log.Fatalf("Failed to build vh web server: %v", err)
		}
		vhSrv = srv
			// Record whether OpenCode is attached externally (--opencode-url) so
			// the direct-DB unarchive guard can refuse fast in that topology (the
			// local DB may not be the remote instance's). See pkg/opencode/db.go.
			srv.SetExternalOpenCode(external)
			// Expose the worker-local OpenCode lifecycle at /vh/opencode/status
			// so the controller/operator can observe a failed OpenCode THROUGH
			// the tunnel without this worker having died with it.
			srv.SetOpenCodeLifecycle(ocLife)

			// Managed-project processes + views: discover a checked-in
			// .vh-solara/project.jsonc, gate it behind explicit per-project trust,
			// and run the declared processes (procmgr) + views (shared registry).
			// Bound to a cancellable context torn down on shutdown. Projects
			// (including the default = daemon cwd) are discovered LAZILY when a
			// browser first opens them — never at daemon boot — so a restart never
			// silently starts repo-declared commands with no operator present.
			procCtx, procCancel := context.WithCancel(context.Background())
			procCtxCancel = procCancel
			procMgr = procmgr.NewManager(procCtx)
			trustStore, err := web.NewTrustStore()
			if err != nil {
				log.Printf("Managed projects disabled: trust store unavailable: %v", err)
			} else {
				trustOnOpen := daemonTrustOnOpen || os.Getenv("VH_TRUST_CONFIG") != ""
				srv.InitManaged(procMgr, trustStore, daemonProjectConfig, trustOnOpen)
				if trustOnOpen {
					log.Printf("Managed projects: auto-trust enabled — repo-declared configs run without a prompt")
				}
			}

			// restartOpencodeLocked SIGTERMs + reaps the current opencode and
			// respawns it on the same port; the aggregator's reconnect loop
			// re-hydrates automatically. Caller must hold opencodeMu. It also
			// drives the lifecycle state machine (starting → ready | failed) so
			// /vh/opencode/status reflects the restart outcome.
			restartOpencodeLocked := func() error {
				if external {
					// We don't own the process; restart via the operator's command
					// (e.g. `systemctl --user restart opencode`).
					if daemonOpenCodeRestart == "" {
						return fmt.Errorf("OpenCode is externally managed; set --opencode-restart-cmd to enable restart from the UI")
					}
					ocLife.SetStarting()
					if err := runShellCmd(context.Background(), daemonOpenCodeRestart, cwd, nil); err != nil {
						ocLife.SetFailed(fmt.Sprintf("external restart command failed: %v", err), nil)
						return err
					}
					if err := waitForURL(opencodeURL+"/session", 30*time.Second); err != nil {
						ocLife.SetFailed(fmt.Sprintf("external OpenCode not reachable after restart: %v", err), nil)
						return err
					}
					ocLife.SetReady()
					return nil
				}
				if daemonOpenCodeDetached {
					// Kill the recorded detached instance (we may not hold its *Cmd
					// after a vh reconnect) and respawn detached on the same port.
					ocLife.SetStarting()
					if st, ok := readOCState(); ok {
						killPID(st.PID)
					}
					if opencodeServeCmd != nil && opencodeServeCmd.Process != nil {
						killPID(opencodeServeCmd.Process.Pid)
					}
					time.Sleep(300 * time.Millisecond)
					c, err := startOpenCodeServeDetached(daemonOpenCodeBin, opencodePort, cwd, ocLife.Ring().Writer())
					if err != nil {
						ocLife.SetFailed(fmt.Sprintf("failed to start detached opencode serve: %v", err), nil)
						return err
					}
					opencodeServeCmd = c
					if err := waitForPort(opencodePort, 30*time.Second); err != nil {
						ocLife.SetFailed(fmt.Sprintf("opencode serve failed to listen on port %d: %v", opencodePort, err), nil)
						return err
					}
					writeOCState(ocState{PID: c.Process.Pid, Port: opencodePort})
					ocLife.SetReady()
					return nil
				}
				// Owned. The reaper goroutine is the SOLE Wait() caller, so stop the
				// current child by signaling + waiting on its reaper-done channel
				// (NOT a second Wait — that would race the reaper). Then respawn on
				// the same port and start a fresh reaper for the new child.
				ocLife.SetStarting()
				oldDone := ocReapDone
				if opencodeServeCmd != nil && opencodeServeCmd.Process != nil {
					_ = opencodeServeCmd.Process.Signal(syscall.SIGTERM)
				}
				if oldDone != nil {
					<-oldDone // reaper has reaped the old child; safe to respawn
				}
				c, err := startOpenCodeServe(daemonOpenCodeBin, opencodePort, cwd, ocLife.Ring().Writer())
				if err != nil {
					ocLife.SetFailed(fmt.Sprintf("failed to start opencode serve: %v", err), nil)
					opencodeServeCmd = nil
					ocReapDone = nil
					return err
				}
				opencodeServeCmd = c
				ocReapDone = make(chan struct{})
				go reapOwnedOpenCode(c, ocReapDone, ocLife)
				if err := waitForPort(opencodePort, 30*time.Second); err != nil {
					ocLife.SetFailed(fmt.Sprintf("opencode serve failed to listen on port %d: %v", opencodePort, err), nil)
					return err
				}
				ocLife.SetReady()
				return nil
			}

			if len(daemonCORSOrigins) > 0 {
				srv.SetCORSOrigins(daemonCORSOrigins)
			}

			srv.SetRestartOpenCode(func(ctx context.Context) error {
				opencodeMu.Lock()
				defer opencodeMu.Unlock()
				log.Printf("Restarting opencode serve on port %d (requested via UI)…", opencodePort)
				if err := restartOpencodeLocked(); err != nil {
					return err
				}
				setOpenCodeRunningVersion(opencodeCurrentVersion(ctx, daemonOpenCodeBin, cwd))
				return nil
			})

			// Restart the vh daemon itself. Under a supervisor (--external-managed)
			// we exit cleanly and let it relaunch; otherwise we re-exec the binary
			// (also picks up a self-update). OpenCode survives a vh restart only in
			// detached/external mode; we never kill it here.
			srv.SetRestartServer(func() {
				log.Printf("Restarting vh server (external-managed=%v)…", daemonExternalManaged)
				if vhHTTP != nil {
					ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
					_ = vhHTTP.Shutdown(ctx)
					cancel()
				}
				// Issue A: cancel + await the Server's owned background
				// goroutines (post-archive re-assert) so no detached goroutine
				// outlives the daemon. Bounded by the same 2s window.
				{
					ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
					_ = srv.Shutdown(ctx)
					cancel()
				}
				if vhCancel != nil {
					vhCancel()
				}
				removeDaemonState()
				if daemonExternalManaged {
					os.Exit(0) // supervisor (systemd Restart=always) relaunches us
				}
				if err := execSelf(); err != nil {
					// Windows / exec failure: spawn a fresh copy, then exit.
					c := exec.Command(os.Args[0], os.Args[1:]...)
					c.Stdout, c.Stderr = os.Stdout, os.Stderr
					setSurviveAttrs(c)
					_ = c.Start()
					os.Exit(0)
				}
			})

			// Surface this vh-solara build's version to the web UI.
			srv.SetAppVersion(Version)

			// Version check: installed from `<bin> --version`, running captured at
			// the last (re)start, latest from npm.
			srv.SetOpenCodeVersion(func(ctx context.Context) (string, string, string, error) {
				return opencodeCurrentVersion(ctx, daemonOpenCodeBin, cwd), openCodeRunningVersion(), opencodeLatestVersion(ctx), nil
			})

			// Update OpenCode in its own environment, streaming the install log to
			// the UI. Does NOT restart — the UI confirms the new version and
			// restarts separately. Update command defaults to `<bin> upgrade`,
			// overridable via --opencode-update-cmd (e.g. an nvm/npm wrapper).
			srv.SetUpdateOpenCode(func(ctx context.Context, w io.Writer) error {
				opencodeMu.Lock()
				defer opencodeMu.Unlock()
				return runOpencodeUpdate(ctx, daemonOpenCodeBin, daemonOpenCodeUpdate, cwd, w)
			})
			// Best-effort changelog fetcher (opencode.ai/changelog.json, short
			// in-memory cache). Never blocks the update/version flow — the handler
			// degrades to "Changelog unavailable" on any failure.
			srv.SetOpencodeChangelog(OpencodeChangelog)

			var vhCtx context.Context
			vhCtx, vhCancel = context.WithCancel(context.Background())
			go agg.Run(vhCtx)

			// Notifications/alerts engine: daemon-side detection + outbound webhooks,
			// plus the in-app notice bus. Non-fatal if its config can't load.
			if _, err := srv.InitAlerts(vhCtx); err != nil {
				log.Printf("alerts engine disabled: %v", err)
			}

			handler := srv.Handler()
			// Optional AF_UNIX listener for the same /vh/* — reachable by bind-mount
			// from a container with no host networking, no port discovery.
			if daemonVHSock != "" {
				uds, err := serveUnixSocket(daemonVHSock, handler)
				if err != nil {
					log.Fatalf("vh unix socket: %v", err)
				}
				defer uds.Close()
				defer os.Remove(daemonVHSock)
				log.Printf("vh web server also listening on unix socket %s", daemonVHSock)
			}
			vhHTTP = &http.Server{
				Addr:    fmt.Sprintf("127.0.0.1:%d", webPort),
				Handler: handler,
				// Slowloris guard. No WriteTimeout/ReadTimeout: /vh/stream and the
				// /oc event passthrough are long-lived SSE responses that a write
				// deadline would sever.
				ReadHeaderTimeout: 15 * time.Second,
				IdleTimeout:       120 * time.Second,
			}
			go func() {
				if err := vhHTTP.ListenAndServe(); err != nil && err != http.ErrServerClosed {
					log.Fatalf("vh web server failed: %v", err)
				}
			}()
			if err := waitForPort(webPort, 10*time.Second); err != nil {
				log.Fatalf("vh web server failed to listen on port %d: %v", webPort, err)
			}
			log.Printf("Verified vh web server is listening on port %d.", webPort)

		default:
			log.Fatalf("Invalid --web value %q (expected %q, %q, or %q)", daemonWeb, WebOpenCode, WebOpenChamber, WebVH)
		}

		proxy := agent.NewProxy(webPort)
		daemon := agent.NewDaemon(daemonController, workerID, workerName, "0.1.0", headerMap, proxy)

		daemon.KillFunc = func() {
			if opencodeWebCmd != nil && opencodeWebCmd.Process != nil {
				log.Printf("Stopping opencode web (pid=%d)...", opencodeWebCmd.Process.Pid)
				_ = opencodeWebCmd.Process.Signal(syscall.SIGTERM)
			}
			if vhCancel != nil {
				vhCancel()
			}
			if vhHTTP != nil {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				_ = vhHTTP.Shutdown(ctx)
				cancel()
			}
			// Issue A: cancel + await the Server's owned background goroutines
			// (post-archive re-assert) so no detached goroutine outlives the
			// daemon at the controller-tunnel teardown path. vhSrv is set only
			// in the WebOpenChamber case; nil in the others (no web.Server).
			if vhSrv != nil {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				_ = vhSrv.Shutdown(ctx)
				cancel()
			}
			// In detached mode we deliberately leave OpenCode running so a vh
			// restart/self-update reconnects to the same instance.
			if opencodeServeCmd != nil && opencodeServeCmd.Process != nil && !daemonOpenCodeDetached {
				log.Printf("Stopping opencode serve (pid=%d)...", opencodeServeCmd.Process.Pid)
				_ = opencodeServeCmd.Process.Signal(syscall.SIGTERM)
			}
			// Tear down repo-declared managed processes (SIGTERM the process
			// groups) and stop their supervisor goroutines.
			if procMgr != nil {
				procMgr.StopAll()
			}
			if procCtxCancel != nil {
				procCtxCancel()
			}
			removeDaemonState()
			os.Exit(0)
		}

		daemon.HealthCheck = func() bool {
			switch daemonWeb {
			case WebOpenCode:
				if opencodeWebCmd != nil && opencodeWebCmd.Process != nil {
					// process is no longer alive => definitively dead
					if opencodeWebCmd.ProcessState != nil {
						return false
					}
				}
				return true
			case WebOpenChamber:
				if daemonChamber == "" {
					return true // No script to verify, assume alive to avoid false positives
				}
				port, err := getRunningOpenChamberPort(daemonChamber)
				if err != nil || port != webPort {
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

		go daemon.Start()

		log.Printf("Daemon Proxy started for WorkerID %s (Web: %s, Port: %d)", workerID, daemonWeb, webPort)

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
// restartOpencodeLocked can observe it instead of a racing second Wait (a
// second Wait on the same *Cmd races the first and is a data race).
//
// A clean (code 0) exit is recorded as stopped; any other exit (or a Wait
// error) is recorded as failed with the exit code when observable. life may be
// nil for callers that only want the reap side effect.
//
// ORDERING INVARIANT: the lifecycle state-set (SetStopped/SetFailed) MUST
// happen BEFORE close(done). restartOpencodeLocked unblocks its owned restart
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
