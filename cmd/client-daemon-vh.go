package cmd

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/oclife"
	"github.com/vhqtvn/vh-solara/pkg/procmgr"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// setupVHMode is the process owner for the --web=vh topology: it spawns (or
// attaches to) the OpenCode serve process, builds the embedded web Server,
// wires the managed-project process manager, registers the restart/update/
// version hooks, and starts the controller-facing HTTP listener.
//
// DECOUPLING (p1-oc-001): a fatal OpenCode spawn/listen failure is recorded
// in ocLife as a failed state and the worker keeps serving — a dead OpenCode
// must NOT take the reporting worker with it. Only the web.Server build itself
// is log.Fatalf (unrecoverable), matching the original closure.
func (rt *clientDaemonRuntime) setupVHMode() {
	// vh-solara's own UI: run `opencode serve` headless on an internal
	// loopback port, aggregate its state, and serve our web UI on the
	// controller-proxied port.
	if rt.webPort == 0 {
		rt.webPort = freePort()
	}
	// OpenCode-external (attach, don't spawn) is enabled purely by URL.
	rt.external = daemonOpenCodeURL != ""

	// The topology fixes the lifecycle capability posture (owned /
	// detached / external). It is determined BEFORE any spawn so that a
	// fatal spawn/listen failure can be recorded in the lifecycle
	// instead of killing the worker: the whole point of p1-oc-001 is
	// that a dead OpenCode must NOT take the reporting worker with it.
	var topo oclife.Topology
	switch {
	case rt.external:
		topo = oclife.TopologyExternal
	case daemonOpenCodeDetached:
		topo = oclife.TopologyDetached
	default:
		topo = oclife.TopologyOwned
	}
	rt.ocLife = oclife.New(topo)

	switch {
	case rt.external:
		// External-managed: attach to an already-running OpenCode (e.g. its
		// own systemd service) instead of spawning one.
		rt.opencodeURL = strings.TrimRight(daemonOpenCodeURL, "/")
		log.Printf("Web mode: vh (external OpenCode at %s, web port=%d)", rt.opencodeURL, rt.webPort)
		if err := waitForURL(rt.opencodeURL+"/session", 30*time.Second); err != nil {
			// DECOUPLED: do NOT kill the worker. Record the failure and
			// keep serving so the operator can diagnose + restart OpenCode
			// remotely through the tunnel. opencodeURL stays set (the
			// lazy proxy dials it per-request and surfaces 502).
			log.Printf("external OpenCode not reachable at %s: %v (worker stays up; opencode status=failed)", rt.opencodeURL, err)
			rt.ocLife.SetFailed(fmt.Sprintf("external OpenCode not reachable at %s: %v", rt.opencodeURL, err), nil)
		} else {
			rt.ocLife.SetReady()
			log.Printf("Attached to external OpenCode at %s.", rt.opencodeURL)
		}

	case daemonOpenCodeDetached:
		// Managed-but-survivable: reconnect to the OpenCode we spawned
		// previously (recorded in a pidfile) if it's still ours + reachable;
		// otherwise spawn a fresh detached one. Survives a vh restart/update.
		if st, ok := readOCState(); ok && ocInstanceOurs(st) {
			rt.opencodePort = st.Port
			rt.opencodeURL = fmt.Sprintf("http://127.0.0.1:%d", st.Port)
			rt.ocLife.SetReady() // reconnected to a known-live instance
			// Seed the lifecycle ring with the detached disk-log tail so
			// /vh/opencode/logs reflects recent history after a vh reconnect:
			// the in-memory ring is fresh on restart, but the process kept
			// running and accumulating output on disk. Without this the
			// endpoint returns 200/empty despite HasLogTail=true.
			seedRingFromDiskLog(rt.ocLife.Ring(), ocLogPath())
			log.Printf("Web mode: vh (reconnected to our detached OpenCode pid=%d port=%d, web port=%d)", st.PID, st.Port, rt.webPort)
		} else {
			rt.opencodePort = freePort()
			if st, ok := readOCState(); ok && portFree(st.Port) {
				rt.opencodePort = st.Port // reuse the stable port when free
			}
			// Pre-set opencodeURL so a failure below still leaves a
			// parseable (dead) loopback target for the lazy proxy.
			rt.opencodeURL = fmt.Sprintf("http://127.0.0.1:%d", rt.opencodePort)
			// Fan the detached process's output into the lifecycle ring
			// alongside the per-project disk log (unblocks Slice 2 logs).
			c, err := startOpenCodeServeDetached(daemonOpenCodeBin, rt.opencodePort, rt.cwd, rt.ocLife.Ring().Writer())
			if err != nil {
				log.Printf("Failed to start detached opencode serve: %v (worker stays up; opencode status=failed)", err)
				rt.ocLife.SetFailed(fmt.Sprintf("failed to start detached opencode serve: %v", err), nil)
			} else {
				rt.opencodeServeCmd = c
				if err := waitForPort(rt.opencodePort, 30*time.Second); err != nil {
					log.Printf("opencode serve failed to listen on port %d: %v (worker stays up; opencode status=failed)", rt.opencodePort, err)
					rt.ocLife.SetFailed(fmt.Sprintf("opencode serve failed to listen on port %d: %v", rt.opencodePort, err), nil)
				} else {
					writeOCState(ocState{PID: c.Process.Pid, Port: rt.opencodePort})
					rt.ocLife.SetReady()
					log.Printf("Web mode: vh (spawned detached OpenCode pid=%d port=%d, web port=%d)", c.Process.Pid, rt.opencodePort, rt.webPort)
				}
			}
		}

	default: // owned
		rt.opencodePort = freePort()
		log.Printf("Web mode: vh (opencode serve internal port=%d, web port=%d)", rt.opencodePort, rt.webPort)
		// Pre-set opencodeURL so a failure below still leaves a parseable
		// (dead) loopback target for the lazy proxy.
		rt.opencodeURL = fmt.Sprintf("http://127.0.0.1:%d", rt.opencodePort)
		// Fan the owned process's output into the lifecycle ring alongside
		// the daemon's stdout (unblocks Slice 2 logs view).
		c, err := startOpenCodeServe(daemonOpenCodeBin, rt.opencodePort, rt.cwd, rt.ocLife.Ring().Writer())
		if err != nil {
			log.Printf("Failed to start opencode serve: %v (worker stays up; opencode status=failed)", err)
			rt.ocLife.SetFailed(fmt.Sprintf("failed to start opencode serve: %v", err), nil)
		} else {
			rt.opencodeServeCmd = c
			log.Printf("Started opencode serve on port %d (pid=%d)", rt.opencodePort, c.Process.Pid)
			// Owned reaper: the SOLE Wait() caller for this child during
			// normal operation. It records a post-startup crash in the
			// lifecycle (and, as a side effect, populates cmd.ProcessState
			// so the HealthCheck's existing ProcessState check works —
			// previously nobody reaped the owned child, so a crash was
			// never detected). The done channel lets restartOpencode
			// observe the reap without a racing second Wait().
			rt.ocReapDone = make(chan struct{})
			go reapOwnedOpenCode(c, rt.ocReapDone, rt.ocLife)
			if err := waitForPort(rt.opencodePort, 30*time.Second); err != nil {
				log.Printf("opencode serve failed to listen on port %d: %v (worker stays up; opencode status=failed)", rt.opencodePort, err)
				rt.ocLife.SetFailed(fmt.Sprintf("opencode serve failed to listen on port %d: %v", rt.opencodePort, err), nil)
			} else {
				rt.ocLife.SetReady()
				log.Printf("Verified opencode serve is listening on port %d.", rt.opencodePort)
			}
		}
	}
	if rt.opencodeURL == "" {
		// Defensive: every arm above sets a parseable URL (a dead
		// loopback on failure). If a future arm forgets, fall back
		// rather than kill the worker — the whole point of this slice.
		rt.opencodeURL = "http://127.0.0.1:0"
		log.Printf("internal warning: opencodeURL not set by topology arm; using dead loopback %s", rt.opencodeURL)
	}
	rt.ocLife.SetOpenCodeURL(rt.opencodeURL)
	// A detached OpenCode shares this process's systemd cgroup; with the
	// default KillMode=control-group a unit restart kills it too. Nudge the
	// operator to set KillMode=process so detached OpenCode actually survives.
	if daemonOpenCodeDetached && !rt.external && os.Getenv("INVOCATION_ID") != "" {
		log.Printf("note: running --opencode-detached under systemd — set 'KillMode=process' in the vh unit so a restart doesn't kill OpenCode (see README)")
	}
	// Register this daemon so `vh-solara kill` can find it.
	writeDaemonState()

	// Capture the version of the serve we just started/attached as the
	// running version (distinct from on-disk installed after an update).
	setOpenCodeRunningVersion(opencodeCurrentVersion(context.Background(), daemonOpenCodeBin, rt.cwd))

	agg := aggregator.New(rt.opencodeURL, vhEventRingCapacity)

	// Build the web server first — it seeds the archived-session overlay
	// into the store before the aggregator hydrates.
	srv, err := web.NewServer(agg, rt.opencodeURL, vhEventRingCapacity)
	if err != nil {
		log.Fatalf("Failed to build vh web server: %v", err)
	}
	rt.vhSrv = srv
	// Record whether OpenCode is attached externally (--opencode-url) so
	// the direct-DB unarchive guard can refuse fast in that topology (the
	// local DB may not be the remote instance's). See pkg/opencode/db.go.
	srv.SetExternalOpenCode(rt.external)
	// Expose the worker-local OpenCode lifecycle at /vh/opencode/status
	// so the controller/operator can observe a failed OpenCode THROUGH
	// the tunnel without this worker having died with it.
	srv.SetOpenCodeLifecycle(rt.ocLife)

	// Managed-project processes + views: discover a checked-in
	// .vh-solara/project.jsonc, gate it behind explicit per-project trust,
	// and run the declared processes (procmgr) + views (shared registry).
	// Bound to a cancellable context torn down on shutdown. Projects
	// (including the default = daemon cwd) are discovered LAZILY when a
	// browser first opens them — never at daemon boot — so a restart never
	// silently starts repo-declared commands with no operator present.
	procCtx, procCancel := context.WithCancel(context.Background())
	rt.procCtxCancel = procCancel
	rt.procMgr = procmgr.NewManager(procCtx)
	trustStore, err := web.NewTrustStore()
	if err != nil {
		log.Printf("Managed projects disabled: trust store unavailable: %v", err)
	} else {
		trustOnOpen := daemonTrustOnOpen || os.Getenv("VH_TRUST_CONFIG") != ""
		srv.InitManaged(rt.procMgr, trustStore, daemonProjectConfig, trustOnOpen)
		if trustOnOpen {
			log.Printf("Managed projects: auto-trust enabled — repo-declared configs run without a prompt")
		}
	}

	if len(daemonCORSOrigins) > 0 {
		srv.SetCORSOrigins(daemonCORSOrigins)
	}

	srv.SetRestartOpenCode(func(ctx context.Context) error {
		rt.opencodeMu.Lock()
		defer rt.opencodeMu.Unlock()
		log.Printf("Restarting opencode serve on port %d (requested via UI)…", rt.opencodePort)
		if err := rt.restartOpencode(); err != nil {
			return err
		}
		setOpenCodeRunningVersion(opencodeCurrentVersion(ctx, daemonOpenCodeBin, rt.cwd))
		return nil
	})

	// Restart the vh daemon itself. Under a supervisor (--external-managed)
	// we exit cleanly and let it relaunch; otherwise we re-exec the binary
	// (also picks up a self-update). OpenCode survives a vh restart only in
	// detached/external mode; we never kill it here.
	srv.SetRestartServer(func() {
		log.Printf("Restarting vh server (external-managed=%v)…", daemonExternalManaged)
		if rt.vhHTTP != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_ = rt.vhHTTP.Shutdown(ctx)
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
		if rt.vhCancel != nil {
			rt.vhCancel()
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
		return opencodeCurrentVersion(ctx, daemonOpenCodeBin, rt.cwd), openCodeRunningVersion(), opencodeLatestVersion(ctx), nil
	})

	// Update OpenCode in its own environment, streaming the install log to
	// the UI. Does NOT restart — the UI confirms the new version and
	// restarts separately. Update command defaults to `<bin> upgrade`,
	// overridable via --opencode-update-cmd (e.g. an nvm/npm wrapper).
	srv.SetUpdateOpenCode(func(ctx context.Context, w io.Writer) error {
		rt.opencodeMu.Lock()
		defer rt.opencodeMu.Unlock()
		return runOpencodeUpdate(ctx, daemonOpenCodeBin, daemonOpenCodeUpdate, rt.cwd, w)
	})
	// Best-effort changelog fetcher (opencode.ai/changelog.json, short
	// in-memory cache). Never blocks the update/version flow — the handler
	// degrades to "Changelog unavailable" on any failure.
	srv.SetOpencodeChangelog(OpencodeChangelog)

	var vhCtx context.Context
	vhCtx, rt.vhCancel = context.WithCancel(context.Background())
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
		rt.vhUDS = uds
		// The original in-closure `defer uds.Close()` / `defer os.Remove`
		// never fired: KillFunc calls os.Exit(0), which preempts defers.
		// serveUnixSocket owns a Serve goroutine that keeps the listener
		// open for the process lifetime — that effective behavior is
		// preserved here. The handle is retained on the runtime so a
		// future change can wire shutdown cleanup.
		log.Printf("vh web server also listening on unix socket %s", daemonVHSock)
	}
	rt.vhHTTP = &http.Server{
		Addr:    fmt.Sprintf("127.0.0.1:%d", rt.webPort),
		Handler: handler,
		// Slowloris guard. No WriteTimeout/ReadTimeout: /vh/stream and the
		// /oc event passthrough are long-lived SSE responses that a write
		// deadline would sever.
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	go func() {
		if err := rt.vhHTTP.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("vh web server failed: %v", err)
		}
	}()
	if err := waitForPort(rt.webPort, 10*time.Second); err != nil {
		log.Fatalf("vh web server failed to listen on port %d: %v", rt.webPort, err)
	}
	log.Printf("Verified vh web server is listening on port %d.", rt.webPort)
}

// restartOpencode SIGTERMs + reaps the current opencode and respawns it on the
// same port; the aggregator's reconnect loop re-hydrates automatically. Caller
// must hold rt.opencodeMu. It also drives the lifecycle state machine
// (starting → ready | failed) so /vh/opencode/status reflects the restart
// outcome.
func (rt *clientDaemonRuntime) restartOpencode() error {
	if rt.external {
		// We don't own the process; restart via the operator's command
		// (e.g. `systemctl --user restart opencode`).
		if daemonOpenCodeRestart == "" {
			return fmt.Errorf("OpenCode is externally managed; set --opencode-restart-cmd to enable restart from the UI")
		}
		rt.ocLife.SetStarting()
		if err := runShellCmd(context.Background(), daemonOpenCodeRestart, rt.cwd, nil); err != nil {
			rt.ocLife.SetFailed(fmt.Sprintf("external restart command failed: %v", err), nil)
			return err
		}
		if err := waitForURL(rt.opencodeURL+"/session", 30*time.Second); err != nil {
			rt.ocLife.SetFailed(fmt.Sprintf("external OpenCode not reachable after restart: %v", err), nil)
			return err
		}
		rt.ocLife.SetReady()
		return nil
	}
	if daemonOpenCodeDetached {
		// Kill the recorded detached instance (we may not hold its *Cmd
		// after a vh reconnect) and respawn detached on the same port.
		rt.ocLife.SetStarting()
		if st, ok := readOCState(); ok {
			killPID(st.PID)
		}
		if rt.opencodeServeCmd != nil && rt.opencodeServeCmd.Process != nil {
			killPID(rt.opencodeServeCmd.Process.Pid)
		}
		time.Sleep(300 * time.Millisecond)
		c, err := startOpenCodeServeDetached(daemonOpenCodeBin, rt.opencodePort, rt.cwd, rt.ocLife.Ring().Writer())
		if err != nil {
			rt.ocLife.SetFailed(fmt.Sprintf("failed to start detached opencode serve: %v", err), nil)
			return err
		}
		rt.opencodeServeCmd = c
		if err := waitForPort(rt.opencodePort, 30*time.Second); err != nil {
			rt.ocLife.SetFailed(fmt.Sprintf("opencode serve failed to listen on port %d: %v", rt.opencodePort, err), nil)
			return err
		}
		writeOCState(ocState{PID: c.Process.Pid, Port: rt.opencodePort})
		rt.ocLife.SetReady()
		return nil
	}
	// Owned. The reaper goroutine is the SOLE Wait() caller, so stop the
	// current child by signaling + waiting on its reaper-done channel
	// (NOT a second Wait — that would race the reaper). Then respawn on
	// the same port and start a fresh reaper for the new child.
	rt.ocLife.SetStarting()
	oldDone := rt.ocReapDone
	if rt.opencodeServeCmd != nil && rt.opencodeServeCmd.Process != nil {
		_ = rt.opencodeServeCmd.Process.Signal(syscall.SIGTERM)
	}
	if oldDone != nil {
		<-oldDone // reaper has reaped the old child; safe to respawn
	}
	c, err := startOpenCodeServe(daemonOpenCodeBin, rt.opencodePort, rt.cwd, rt.ocLife.Ring().Writer())
	if err != nil {
		rt.ocLife.SetFailed(fmt.Sprintf("failed to start opencode serve: %v", err), nil)
		rt.opencodeServeCmd = nil
		rt.ocReapDone = nil
		return err
	}
	rt.opencodeServeCmd = c
	rt.ocReapDone = make(chan struct{})
	go reapOwnedOpenCode(c, rt.ocReapDone, rt.ocLife)
	if err := waitForPort(rt.opencodePort, 30*time.Second); err != nil {
		rt.ocLife.SetFailed(fmt.Sprintf("opencode serve failed to listen on port %d: %v", rt.opencodePort, err), nil)
		return err
	}
	rt.ocLife.SetReady()
	return nil
}
