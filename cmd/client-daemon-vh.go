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
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/oclife"
	"github.com/vhqtvn/vh-solara/pkg/procmgr"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// wireDaemonDispatch applies the --daemon-dispatch opt-in for the --web=vh
// topology, mirroring local-server's reference wiring (send-net-resilience
// 2b): the daemon takes exclusive custody-fenced ownership of queue
// dispatch. Spawned (owned), restart-managed, and detached OpenCode
// topologies enable normally; the EXTERNAL topology (--opencode-url) is
// REFUSED — the queue-custody fence is available, but the restart
// causality barrier is NOT certified for an externally-managed OpenCode
// (an out-of-band restart this daemon cannot observe breaks the certified
// auto-recovery ladder's premises), so dispatch stays browser-owned.
// Non-Linux needs no case here: custody acquisition fails closed
// platform-side (AcquireQueueCustody refuses; the drain loop treats any
// non-held acquire as a fail-closed exit), so an enabled capability cannot
// dispatch on an unsupported platform.
//
// It must run BEFORE the first project is opened (aggFor starts the
// per-project drain loop at project-open time) and before the first
// /vh/version read (the capability advert reads the live value) — the same
// ordering local-server guarantees. Returns whether the capability was
// enabled (pure decision seam: unit-tested in client_daemon_dispatch_test.go
// because setupVHMode itself spawns a real OpenCode).
func wireDaemonDispatch(flagSet, external bool) bool {
	if !flagSet {
		return false
	}
	if external {
		log.Printf("client-daemon: --daemon-dispatch ignored in --opencode-url (external) mode: the queue-custody fence is available but the restart causality barrier is NOT certified for an externally-managed OpenCode — dispatch stays browser-owned. Re-run without --opencode-url to use daemon dispatch.")
		return false
	}
	web.SetDaemonDispatchEnabled(true)
	log.Printf("client-daemon: daemon queue dispatch ENABLED (custody-fenced; certified auto-recovery ladder active)")
	return true
}

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

	// Daemon-lifetime context (oc-death-watch S1): created BEFORE the
	// topology arms so the death watcher — armed inside
	// startDetachedOpenCode — is bound to the same cancellation the
	// teardown path (KillFunc) and the restart-server hook drive.
	rt.vhCtx, rt.vhCancel = context.WithCancel(context.Background())

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
		rt.startDetachedOpenCode()

	default: // owned
		rt.startOwnedOpenCode()
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

	// Daemon queue dispatch (the --daemon-dispatch opt-in; production
	// default OFF — the browser stays the dispatcher via the legacy
	// claim/POST/resolve path). Applied AFTER the aggregator exists and
	// BEFORE the web server / any project-open so the first /vh/version
	// read and the first drain loop already see the final capability
	// posture — the same ordering local-server guarantees.
	wireDaemonDispatch(daemonDaemonDispatch, rt.external)

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
	// Converge OpenCode's session-list index on every (re)attach (see
	// pkg/opencode/session_index.go). Opt-in here so tests never touch a real DB.
	srv.EnableSessionListIndex()
	// Expose the worker-local OpenCode lifecycle at /vh/opencode/status
	// so the controller/operator can observe a failed OpenCode THROUGH
	// the tunnel without this worker having died with it.
	srv.SetOpenCodeLifecycle(rt.ocLife)
	// Retry-storm gating (oc-death-watch S2): while the death watcher KNOWS
	// OpenCode is down (lifecycle DownSince set — observed death, kept
	// across the failed→starting restart sequence, cleared on ready), every
	// aggregator Run loop (the default one below + one per opened project
	// dir via aggFor) skips its 1s reconnect/hydrate ramp and waits at the
	// capped backoff instead. External mode gets no probe: it has no
	// lifecycle knowledge of the operator-managed OpenCode, and its
	// aggregators must behave exactly as before this gate existed.
	if !rt.external {
		life := rt.ocLife
		srv.SetUpstreamDownProbe(func() bool { return life.Snapshot().DownSince != nil })
	}

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
	if len(daemonFrameAncestors) > 0 {
		srv.SetFrameAncestors(daemonFrameAncestors)
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
		// Tear down repo-declared managed processes exactly like the
		// teardown path does. Without this every UI-triggered vh restart
		// orphaned one generation of managed procs (they run in their own
		// process groups, and KillMode=process leaves them to systemd).
		if rt.procMgr != nil {
			rt.procMgr.StopAll()
		}
		if rt.procCtxCancel != nil {
			rt.procCtxCancel()
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

	// vhCtx was created at the top of setupVHMode, BEFORE the topology
	// arms, so the death watcher shares it (oc-death-watch S1).
	vhCtx := rt.vhCtx
	go agg.Run(vhCtx)

	// Notifications/alerts engine: daemon-side detection + outbound webhooks,
	// plus the in-app notice bus. Non-fatal if its config can't load.
	if alertEngine, err := srv.InitAlerts(vhCtx); err != nil {
		log.Printf("alerts engine disabled: %v", err)
	} else if rt.ocWatcher != nil {
		// oc-death-watch S2: route the death watcher's notifications
		// through the alerts engine — exactly one "OpenCode down" notice
		// per down-spell and one per crash-loop give-up (the watcher
		// dedups; the engine's dispatcher/pusher cooldowns back it up).
		// Owned-mode boots have no ocWatcher (the reaper owns exit
		// observation there) and get no watcher-driven notices.
		rt.ocWatcher.SetAlert(func(event, detail string) {
			alertEngine.EmitDaemonNotice(detail)
		})
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

// startOwnedOpenCode is the ENTIRE owned topology arm of setupVHMode's vh
// mode (P1-API-006 A1): it runs the child-attributed initial boot and
// FINALIZES the effective port/URL on the runtime. Extracted from the cobra
// arm so the boot seam is testable without booting the whole daemon (mirrors
// startDetachedOpenCode) — the arm itself is a one-line call, so what tests
// exercise here is exactly what production runs.
//
// BOOT CONTRACT (settled design; researched — NO operator-fixed owned boot
// port exists, both binaries select it internally, and no port-provenance
// machinery is added):
//
//   - The initial candidate port is internally selected (freePort) when the
//     runtime does not already carry one; a pre-set rt.opencodePort (tests,
//     future callers) is honored as the candidate — the same field the
//     restart arm treats as the stable port.
//   - Readiness is CHILD-ATTRIBUTED (the old dial-only waitForPort credited
//     any squatter that won the boot port — a false SetReady proxying
//     foreign content): the boot routes through the same shared core as the
//     restart, so a pre-readiness child exit (lost bind race,
//     squatter-detected-via-child-death) earns exactly ONE fresh
//     auto-selected-port retry, and exhaustion fails closed (SetFailed +
//     the worker keeps serving, p1-oc-001).
//   - The URL is finalized BEFORE any consumer is constructed: setupVHMode
//     builds the aggregator/web server only after this arm returns, so at
//     boot there are no subscribers to retarget — Srv stays nil and the
//     lifecycle URL is still updated by the core's retarget seam.
//   - The exit observer is installed from the start: each spawned child gets
//     the sole-reaper gate, so a post-readiness crash flips the lifecycle to
//     failed and a later restart can await the reap.
func (rt *clientDaemonRuntime) startOwnedOpenCode() {
	if rt.opencodePort == 0 {
		rt.opencodePort = freePort()
	}
	log.Printf("Web mode: vh (opencode serve internal port=%d, web port=%d)", rt.opencodePort, rt.webPort)
	// The shared child-aware boot/restart operation — boot is the degenerate
	// restart: no previous child to stop, and the "stable" port is the
	// internally selected initial candidate. Same attribution, retry, and
	// synchronized publication rules as the restart (one mechanism, both
	// paths — the A1 requirement).
	res := restartOwnedOpenCode(ownedRestartConfig{
		Life: rt.ocLife,
		// No running server exists yet: the URL is finalized below, before
		// setupVHMode constructs the aggregator/web server. A nil Srv is the
		// designed defensive shape (the lifecycle URL still follows a fresh
		// port through the retarget seam).
		Srv:        nil,
		StablePort: rt.opencodePort,
		// Sole-reaper ownership: the closure starts the ONE Wait() goroutine
		// per spawned child and hands the core its exit gate. The core never
		// Wait()s the child.
		Spawn: func(port int) (*exec.Cmd, *ownedExitGate, error) {
			// Fan the owned process's output into the lifecycle ring
			// alongside the daemon's stdout (unblocks Slice 2 logs view).
			c, err := startOpenCodeServe(daemonOpenCodeBin, port, rt.cwd, rt.ocLife.Ring().Writer())
			if err != nil {
				return nil, nil, err
			}
			gate := newOwnedExitGate()
			go reapOwnedOpenCode(c, gate, rt.ocLife)
			return c, gate, nil
		},
	})
	rt.opencodeServeCmd = res.Cmd
	rt.ocReapDone = res.Exited
	// FINALIZE the effective URL on the effective port — success and failure
	// alike. On failure this is the last attempted port: a parseable dead
	// loopback target for the lazy proxy (per-request 502), never a foreign
	// listener's port masquerading as ready.
	rt.opencodePort = res.Port
	rt.opencodeURL = fmt.Sprintf("http://127.0.0.1:%d", rt.opencodePort)
	if res.Err != nil {
		// The core already recorded SetFailed; the worker keeps serving
		// (p1-oc-001). The child handle + observer are retained — the child
		// may come up late, and its exit stays recorded.
		log.Printf("owned opencode boot failed: %v (worker stays up; opencode status=failed)", res.Err)
		return
	}
	log.Printf("Verified opencode serve is listening on port %d (pid=%d).", rt.opencodePort, res.Cmd.Process.Pid)
}

// startDetachedOpenCode is the ENTIRE detached topology arm of setupVHMode's
// vh mode: it runs the one cooperating-starter transaction and wires the
// result onto the runtime (port, proxy URL, retained child, lifecycle
// transitions, ring seeding). Extracted from the cobra arm so the boot seam
// is testable without booting the whole daemon — the arm itself is a one-line
// call, so what tests exercise here is exactly what production runs.
//
// Managed-but-survivable: reconnect to the OpenCode we spawned previously
// (recorded in a pidfile) if it's still ours + reachable; otherwise spawn a
// fresh detached one. Survives a vh restart/update.
//
// SPLIT-BRAIN GUARD (incident 2026-08-28) + CROSS-PROCESS SPAWN
// SERIALIZATION (P1-API-002): the transaction never spawns beside a live,
// cmdline-matching instance, and a loser (Contended/OrphanedOwner) fails
// fast into a failed lifecycle while this worker keeps serving (p1-oc-001
// decoupling).
func (rt *clientDaemonRuntime) startDetachedOpenCode() {
	res := EnsureDetachedOpenCode(daemonOpenCodeBin, rt.cwd, rt.ocLife.Ring().Writer())
	rt.opencodePort, rt.opencodeURL, rt.opencodeServeCmd = ApplyDetachedOCStart(res, rt.ocLife, "Web mode: vh")
	rt.armOpenCodeWatcher(res)
}

// armOpenCodeWatcher starts the detached-OpenCode death watcher (oc-death
// watch S1) and points it at whatever the boot verdict left: the child we
// spawned (parent wait fast path), the recorded instance we reattached to
// or found occupied (identity poll — not our child), or the
// readiness-failure retained child (still ours, still worth watching — its
// pid feeds the next restart's curPID). Contended/OrphanedOwner boots arm
// nothing (no live child of ours to watch). External URLs never get a
// watcher. A runtime without a daemon-lifetime context (boot-seam tests)
// arms nothing — the watcher is a daemon-lifetime concern.
func (rt *clientDaemonRuntime) armOpenCodeWatcher(res DetachedStartResult) {
	if rt.vhCtx == nil {
		return
	}
	rt.ocWatcher = newOCDeathWatcher(rt.ocLife, rt.autoRestartDetached)
	rt.ocWatcher.Start(rt.vhCtx)
	switch res.Verdict {
	case DetachedStartSpawned, DetachedStartFailed:
		// Failed keeps a readiness-failure child only when we spawned one
		// this boot (spawn-error failures carry PID 0 and arm nothing).
		if res.PID > 0 {
			rt.ocWatcher.Arm(res.PID, res.Port, true)
		}
	case DetachedStartReattached, DetachedStartOccupied:
		// A previous daemon's child — we are not its parent; the
		// identity-poll path applies.
		if res.PID > 0 {
			rt.ocWatcher.Arm(res.PID, res.Port, false)
		}
	}
}

// detachedArm builds the SHARED serialized detached restart (ocDetachedRestartArm)
// wired to this runtime's fields — the exact wiring the old inlined arm of
// restartOpencode had. The UI restart hook and the death watcher BOTH route
// through it, so user- and watcher-driven restarts cannot drift.
func (rt *clientDaemonRuntime) detachedArm() *ocDetachedRestartArm {
	return &ocDetachedRestartArm{
		Bin:  daemonOpenCodeBin,
		Cwd:  rt.cwd,
		Life: rt.ocLife,
		Noun: "daemon",
		Srv:  func() *web.Server { return rt.vhSrv },
		Cmd:  func() *exec.Cmd { return rt.opencodeServeCmd },
		SetCmd: func(c *exec.Cmd) {
			rt.opencodeServeCmd = c
		},
		Port: func() int { return rt.opencodePort },
		SetPort: func(port int, url string) {
			rt.opencodePort, rt.opencodeURL = port, url
		},
		// Re-arm the watcher on whatever child the attempt retained — the
		// watcher is what notices if a readiness-failure retained child
		// dies (its pid feeds the next restart's curPID).
		OnDone: func(c *exec.Cmd, effectivePort int, err error) {
			if w := rt.ocWatcher; w != nil && c != nil && c.Process != nil && effectivePort > 0 {
				w.Arm(c.Process.Pid, effectivePort, true)
			}
		},
	}
}

// autoRestartDetached is the death watcher's restart executor: ONE
// serialized attempt through the same detachedArm the UI restart hook
// uses. The watcher's plain state checks cannot see races (a user restart
// completing while an attempt waits for the mutex), so the generation is
// re-checked under the lock: if a newer child was armed (the user restart
// won), this attempt is a no-op; if a restart is in flight (starting) or a
// deliberate stop landed (stopped), it skips. Exactly one spawn results
// from a user restart racing the watcher.
func (rt *clientDaemonRuntime) autoRestartDetached(gen uint64) {
	rt.opencodeMu.Lock()
	defer rt.opencodeMu.Unlock()
	w := rt.ocWatcher
	if w == nil || w.Generation() != gen {
		return // superseded by a newer child (e.g. the user restart's spawn)
	}
	switch rt.ocLife.Snapshot().State {
	case oclife.StateStarting, oclife.StateStopped:
		return
	}
	if err := rt.detachedArm().Run(); err != nil {
		log.Printf("opencode watch: auto-restart attempt failed: %v", err)
	}
}

// restartOpencode stops the current opencode and respawns it through the
// topology-appropriate path; the aggregator's reconnect loop re-hydrates
// automatically. Caller must hold rt.opencodeMu. It also drives the lifecycle
// state machine (starting → ready | failed) so /vh/opencode/status reflects
// the restart outcome.
//
// Port policy per arm (R9: "respawns on the same port" was never true for
// either arm — do not restate it):
//   - owned: the stop path is BOUNDED (stopOwnedOpenCodeChild: SIGTERM grace
//     → SIGKILL → fail-closed). The replacement PREFERS the stable port but
//     only when verifiably free; a pre-readiness child exit (the lost bind
//     race) earns exactly ONE fresh-port attempt, retargeted through
//     applyFreshPortRetarget BEFORE readiness is published.
//   - detached: the serialized restart re-checks the recorded port for a
//     foreign listener after the owner-release wait (port parity with the
//     boot path) and respawns on it when still free, else swaps to a fresh
//     port with the same running-daemon retarget.
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
		// Serialized restart (P1-API-002) through the SHARED detached arm —
		// the exact wiring the death watcher's auto-restart uses, so the
		// two cannot drift: under the per-project starter lock, reread
		// state and revalidate the recorded pid (alive + cmdline match)
		// IMMEDIATELY before signaling — a recycled pid is never signaled —
		// wait for the old owner to release the owner lock, respawn on the
		// stable port (fresh-port swap retargeted BEFORE the readiness
		// flip), and re-arm the death watcher on the retained child.
		return rt.detachedArm().Run()
	}
	// Owned (P1-API-005). The reaper goroutine is the SOLE Wait() caller, so
	// stop the current child through stopOwnedOpenCodeChild — signal + wait
	// on its reaper-done channel (NOT a second Wait — that would race the
	// reaper), BOUNDED: SIGTERM grace → SIGKILL → fail-closed (R11: a
	// SIGTERM-immune child can no longer wedge this handler and every later
	// opencodeMu holder). Then the SHARED child-aware restart operation
	// drives the replacement: readiness
	// is attributed to the replacement child itself — never to "something
	// accepting connections" on the port — with one bounded fresh-port
	// attempt, retargeted through the P1-API-003 seam BEFORE SetReady, when
	// the stable port is occupied or the child loses the bind race, and
	// fail-closed exhaustion (SetFailed + worker keeps serving).
	rt.ocLife.SetStarting()
	if err := stopOwnedOpenCodeChild(rt.ocLife, rt.opencodeServeCmd, rt.ocReapDone); err != nil {
		// Fail-closed (R11): the old child could not be stopped in band —
		// the helper already recorded SetFailed; the worker keeps serving
		// (p1-oc-001) and nothing after this point may SetReady. The
		// caller's deferred opencodeMu release still runs.
		return err
	}
	res := restartOwnedOpenCode(ownedRestartConfig{
		Life:       rt.ocLife,
		Srv:        rt.vhSrv,
		StablePort: rt.opencodePort,
		// Sole-reaper ownership preserved: the closure starts the ONE
		// Wait() goroutine for the replacement child and hands the core its
		// exit gate (whose oracle closes once the exit is recorded in the
		// lifecycle, under the gate's synchronized publication boundary).
		// The core never Wait()s the child.
		Spawn: func(port int) (*exec.Cmd, *ownedExitGate, error) {
			c, err := startOpenCodeServe(daemonOpenCodeBin, port, rt.cwd, rt.ocLife.Ring().Writer())
			if err != nil {
				return nil, nil, err
			}
			gate := newOwnedExitGate()
			go reapOwnedOpenCode(c, gate, rt.ocLife)
			return c, gate, nil
		},
	})
	rt.opencodeServeCmd = res.Cmd
	rt.ocReapDone = res.Exited
	if res.Err != nil {
		// The core already recorded SetFailed; the worker keeps serving
		// (p1-oc-001). Nothing after this point may SetReady — the
		// write-order guarantee that a child-failure state stays final.
		return res.Err
	}
	if res.Retargeted {
		rt.opencodePort, rt.opencodeURL = res.Port, res.URL
	}
	return nil
}
