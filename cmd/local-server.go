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
	"sync"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/oclife"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// local-server runs the vh web UI + an OpenCode backend purely locally — no
// controller/proxy connection. It's the standalone counterpart to
// `client-daemon --web=vh`: open the printed http://<addr> in a browser.
var (
	localAddr             string
	localVHSock           string
	localOpenCodeBin      string
	localOpenCodeURL      string
	localOpenCodeDetached bool
	localOpenCodeUpdate   string
	localOpenCodeRestart  string
	localCORSOrigins      []string
	localFrameAncestors   []string
	localExternalManaged  bool
	localAuth             authFlags
)

var localServerCmd = &cobra.Command{
	Use:   "local-server",
	Short: "Serve the vh web UI locally (no proxy/controller connection)",
	Long: `Run the vh-solara web UI and an OpenCode backend on this machine and
serve them directly on --addr, without connecting to a controller/proxy server.

OpenCode is spawned via 'opencode serve' by default; attach to an existing one
with --opencode-url, or spawn a survivable detached instance with
--opencode-detached.`,
	Run: func(cmd *cobra.Command, args []string) {
		cwd, err := os.Getwd()
		if err != nil {
			cwd = "."
		}

		var opencodeServeCmd *exec.Cmd
		// opencodeReapDone is the CURRENT owned child's exit oracle — closed
		// once the child has exited AND its wait observer has recorded that
		// exit in ocLife (P1-API-005). nil for the boot-spawned child (the
		// boot arm owns its readiness wait and deliberately has no observer).
		var opencodeReapDone <-chan struct{}
		var opencodeMu sync.Mutex
		var vhCancel context.CancelFunc
		var vhHTTP *http.Server

		external := localOpenCodeURL != ""
		var opencodeURL string
		opencodePort := 0

		// DECOUPLING (p2-api-004 / oc-003): a fatal OpenCode spawn/listen
		// failure is recorded in ocLife as a failed state and local-server
		// keeps serving — a dead OpenCode must NOT take the reporting
		// process with it. Mirrors client-daemon's setupVHMode. The topology
		// is fixed BEFORE any spawn so a fatal spawn/listen failure can be
		// recorded in the lifecycle instead of killing the process: the
		// whole point of this slice is that a dead OpenCode must NOT take
		// the local-server process with it.
		var topo oclife.Topology
		switch {
		case external:
			topo = oclife.TopologyExternal
		case localOpenCodeDetached:
			topo = oclife.TopologyDetached
		default:
			topo = oclife.TopologyOwned
		}
		ocLife := oclife.New(topo)

		switch {
		case external:
			opencodeURL = strings.TrimRight(localOpenCodeURL, "/")
			log.Printf("local-server: attaching to external OpenCode at %s", opencodeURL)
			if err := waitForURL(opencodeURL+"/session", 30*time.Second); err != nil {
				// DECOUPLED: do NOT kill the process. Record the failure and
				// keep serving so the operator can diagnose + restart OpenCode
				// locally. opencodeURL stays set (the aggregator's lazy proxy
				// dials it per-request and surfaces 502).
				log.Printf("external OpenCode not reachable at %s: %v (local-server stays up; opencode status=failed)", opencodeURL, err)
				ocLife.SetFailed(fmt.Sprintf("external OpenCode not reachable at %s: %v", opencodeURL, err), nil)
			} else {
				ocLife.SetReady()
			}

		case localOpenCodeDetached:
			// SPLIT-BRAIN GUARD (incident 2026-08-28) + CROSS-PROCESS SPAWN
			// SERIALIZATION (P1-API-002): the whole cooperating-starter
			// transaction lives in EnsureDetachedOpenCode — the same single
			// code path client-daemon's setupVHMode routes through. It never
			// spawns beside a live, cmdline-matching instance; losers
			// (Contended/OrphanedOwner) fail fast into a failed lifecycle while
			// local-server keeps serving. This arm only wires the result.
			res := EnsureDetachedOpenCode(localOpenCodeBin, cwd)
			opencodePort, opencodeURL, opencodeServeCmd = ApplyDetachedOCStart(res, ocLife, "local-server")

		default:
			opencodePort = freePort()
			// Pre-set opencodeURL so a failure below still leaves a parseable
			// (dead) loopback target for the aggregator's lazy proxy.
			opencodeURL = fmt.Sprintf("http://127.0.0.1:%d", opencodePort)
			c, err := startOpenCodeServe(localOpenCodeBin, opencodePort, cwd)
			if err != nil {
				log.Printf("Failed to start opencode serve: %v (local-server stays up; opencode status=failed)", err)
				ocLife.SetFailed(fmt.Sprintf("failed to start opencode serve: %v", err), nil)
			} else {
				opencodeServeCmd = c
				if err := waitForPort(opencodePort, 30*time.Second); err != nil {
					log.Printf("opencode serve failed to listen on port %d: %v (local-server stays up; opencode status=failed)", opencodePort, err)
					ocLife.SetFailed(fmt.Sprintf("opencode serve failed to listen on port %d: %v", opencodePort, err), nil)
				} else {
					ocLife.SetReady()
					log.Printf("local-server: spawned OpenCode pid=%d port=%d", c.Process.Pid, opencodePort)
				}
			}
		}
		if opencodeURL == "" {
			// Defensive: every arm above sets a parseable URL (a dead
			// loopback on failure). If a future arm forgets, fall back
			// rather than kill the process — the whole point of this slice.
			opencodeURL = "http://127.0.0.1:0"
			log.Printf("internal warning: opencodeURL not set by topology arm; using dead loopback %s", opencodeURL)
		}
		ocLife.SetOpenCodeURL(opencodeURL)

		// Register this daemon so `vh-solara kill` can find it.
		writeDaemonState()

		// Record the version of the serve we just started (or attached to) as the
		// running version — distinct from the on-disk installed version after an
		// update. Best-effort; "" if `--version` can't be read.
		setOpenCodeRunningVersion(opencodeCurrentVersion(context.Background(), localOpenCodeBin, cwd))

		agg := aggregator.New(opencodeURL, vhEventRingCapacity)
		srv, err := web.NewServer(agg, opencodeURL, vhEventRingCapacity)
		if err != nil {
			log.Fatalf("Failed to build vh web server: %v", err)
		}
		// Record whether OpenCode is attached externally (--opencode-url) so the
		// direct-DB unarchive guard can refuse fast in that topology (the local DB
		// may not be the remote instance's). See pkg/opencode/db.go.
		srv.SetExternalOpenCode(external)
		// Expose the local OpenCode lifecycle at /vh/opencode/status so the
		// operator can observe a failed OpenCode without local-server having
		// died with it. Mirrors client-daemon's setupVHMode wiring.
		srv.SetOpenCodeLifecycle(ocLife)

		// Restart the owned OpenCode in place; the aggregator re-hydrates. Caller
		// holds opencodeMu. Drives ocLife through starting → ready|failed so
		// /vh/opencode/status reflects the restart outcome (mirrors
		// client-daemon's restartOpencode). A restart is a readiness event:
		// the restarted process becomes ready or fails, so the lifecycle must
		// transition with it or the status endpoint would lie.
		restartOpencodeLocked := func() error {
			if external {
				if localOpenCodeRestart == "" {
					return fmt.Errorf("OpenCode is externally managed; set --opencode-restart-cmd to enable restart from the UI")
				}
				ocLife.SetStarting()
				if err := runShellCmd(context.Background(), localOpenCodeRestart, cwd, nil); err != nil {
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
			if localOpenCodeDetached {
				// Serialized restart (P1-API-002): the same shared transaction
				// client-daemon routes through — under the starter lock, revalidate
				// the recorded pid before signaling (never signal a recycled pid),
				// wait out the old owner, respawn on the stable port.
				ocLife.SetStarting()
				curPID := 0
				if opencodeServeCmd != nil && opencodeServeCmd.Process != nil {
					curPID = opencodeServeCmd.Process.Pid
				}
				oldPort := opencodePort
				c, effectivePort, err := restartDetachedOpenCode(localOpenCodeBin, oldPort, cwd, curPID)
				if c != nil {
					opencodeServeCmd = c
				}
				if err != nil {
					ocLife.SetFailed(fmt.Sprintf("detached opencode restart failed: %v", err), nil)
					return err
				}
				// P1-API-003: BEFORE the readiness flip, propagate a fresh spawn
				// port to everything still targeting the old one — the ocLife
				// status URL and the RUNNING web server's proxy + aggregators
				// (applyFreshPortRetarget is the SAME wiring client-daemon's arm
				// uses, so the two binaries cannot drift). Same-port restarts
				// no-op here.
				if p, u, retargeted := applyFreshPortRetarget(effectivePort, oldPort, ocLife, srv); retargeted {
					opencodePort, opencodeURL = p, u
					log.Printf("detached opencode restart landed on a fresh port %d — retargeted the running local-server (was port %d)", p, oldPort)
				}
				ocLife.SetReady()
				return nil
			}
			// Owned (P1-API-005): the SHARED child-aware restart operation —
			// the same rules client-daemon's owned arm follows, so the two
			// binaries cannot drift. Readiness is attributed to the
			// REPLACEMENT CHILD itself (never to "something accepting
			// connections" on the port): the stable port is attempted only
			// when verifiably free; a pre-readiness child exit (the lost
			// bind-race signature) earns exactly ONE bounded fresh-port attempt,
			// retargeted through applyFreshPortRetarget BEFORE SetReady;
			// exhaustion fails closed (SetFailed + local-server keeps serving,
			// p1-oc-001).
			//
			// OWNERSHIP: local-server keeps DIRECT wait ownership — no
			// sole-reaper subsystem. Its existing wait is adapted into the exit
			// oracle the core requires: the Spawn closure starts one
			// reapOwnedOpenCode observer per replacement child (that adapter's
			// ordering invariant — lifecycle state-set BEFORE the oracle closes —
			// is pinned by TestReapOwnedOpenCode*), and the stop path below
			// awaits that oracle instead of a second racing Wait. The core itself
			// never Wait()s the child.
			ocLife.SetStarting()
			if opencodeServeCmd != nil && opencodeServeCmd.Process != nil {
				_ = opencodeServeCmd.Process.Signal(syscall.SIGTERM)
			}
			if opencodeReapDone != nil {
				<-opencodeReapDone // observer has reaped + recorded the old child
			} else if opencodeServeCmd != nil && opencodeServeCmd.Process != nil {
				// The BOOT-spawned child has no observer (its readiness wait
				// is the boot arm's, deliberately untouched): the direct Wait
				// stays here — nobody else is waiting on it.
				_ = opencodeServeCmd.Wait()
			}
			res := restartOwnedOpenCode(ownedRestartConfig{
				Life:       ocLife,
				Srv:        srv,
				StablePort: opencodePort,
				// Direct-wait ownership adapted to the oracle contract: spawn
				// ONE child and hand the core its exit oracle, closed only
				// after the exit is recorded in the lifecycle.
				Spawn: func(port int) (*exec.Cmd, <-chan struct{}, error) {
					c, err := startOpenCodeServe(localOpenCodeBin, port, cwd)
					if err != nil {
						return nil, nil, err
					}
					done := make(chan struct{})
					go reapOwnedOpenCode(c, done, ocLife)
					return c, done, nil
				},
			})
			opencodeServeCmd = res.Cmd
			opencodeReapDone = res.Exited
			if res.Err != nil {
				// The core already recorded SetFailed; local-server keeps
				// serving. Nothing after this point may SetReady — the
				// write-order guarantee that a child-failure state stays final.
				return res.Err
			}
			if res.Retargeted {
				opencodePort, opencodeURL = res.Port, res.URL
			}
			return nil
		}

		if len(localCORSOrigins) > 0 {
			srv.SetCORSOrigins(localCORSOrigins)
		}
		if len(localFrameAncestors) > 0 {
			srv.SetFrameAncestors(localFrameAncestors)
		}
		authn, err := buildAuth(localAddr, &localAuth)
		if err != nil {
			log.Fatalf("Auth setup failed: %v", err)
		}
		srv.SetAuth(authn)
		srv.SetAppVersion(Version) // so /vh/version and /vh/skill/emit report the real build
		srv.SetRestartOpenCode(func(ctx context.Context) error {
			opencodeMu.Lock()
			defer opencodeMu.Unlock()
			log.Printf("Restarting opencode serve on port %d (requested via UI)…", opencodePort)
			if err := restartOpencodeLocked(); err != nil {
				return err
			}
			// The restarted serve now runs the on-disk version (picks up an update).
			setOpenCodeRunningVersion(opencodeCurrentVersion(ctx, localOpenCodeBin, cwd))
			return nil
		})
		srv.SetRestartServer(func() {
			log.Printf("Restarting vh local-server (external-managed=%v)…", localExternalManaged)
			if vhHTTP != nil {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				_ = vhHTTP.Shutdown(ctx)
				cancel()
			}
			// Issue A: cancel + await the Server's owned background goroutines
			// (post-archive re-assert) so no detached goroutine outlives the
			// daemon. Bounded by the same 2s window as the HTTP shutdown.
			{
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				_ = srv.Shutdown(ctx)
				cancel()
			}
			if vhCancel != nil {
				vhCancel()
			}
			removeDaemonState()
			if localExternalManaged {
				os.Exit(0)
			}
			if err := execSelf(); err != nil {
				c := exec.Command(os.Args[0], os.Args[1:]...)
				c.Stdout, c.Stderr = os.Stdout, os.Stderr
				setSurviveAttrs(c)
				_ = c.Start()
				os.Exit(0)
			}
		})
		srv.SetOpenCodeVersion(func(ctx context.Context) (string, string, string, error) {
			return opencodeCurrentVersion(ctx, localOpenCodeBin, cwd), openCodeRunningVersion(), opencodeLatestVersion(ctx), nil
		})
		srv.SetUpdateOpenCode(func(ctx context.Context, w io.Writer) error {
			// Update only — no restart. The UI confirms the new version and
			// restarts separately so the user controls when sessions are cut.
			opencodeMu.Lock()
			defer opencodeMu.Unlock()
			return runOpencodeUpdate(ctx, localOpenCodeBin, localOpenCodeUpdate, cwd, w)
		})
		// Best-effort changelog fetcher; never blocks the update/version flow.
		srv.SetOpencodeChangelog(OpencodeChangelog)

		var vhCtx context.Context
		vhCtx, vhCancel = context.WithCancel(context.Background())
		// Ensure the aggregator's context is cancelled on every return path (the
		// restart hook also calls vhCancel; CancelFunc is idempotent).
		defer vhCancel()
		go agg.Run(vhCtx)
		handler := srv.Handler()
		// Optional AF_UNIX listener for the same /vh/* — reachable by bind-mount
		// from a container with no host networking, no port discovery.
		if localVHSock != "" {
			uds, err := serveUnixSocket(localVHSock, handler)
			if err != nil {
				log.Fatalf("vh unix socket: %v", err)
			}
			defer uds.Close()
			defer os.Remove(localVHSock)
			log.Printf("vh local-server also listening on unix socket %s", localVHSock)
		}
		vhHTTP = &http.Server{
			Addr:    localAddr,
			Handler: handler,
			// No Read/Write timeout: /vh/stream + /oc event passthrough are SSE.
			ReadHeaderTimeout: 15 * time.Second,
			IdleTimeout:       120 * time.Second,
		}
		log.Printf("vh local-server ready: http://%s  (OpenCode at %s)", localAddr, opencodeURL)
		if err := vhHTTP.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("vh local-server failed: %v", err)
		}
	},
}

func init() {
	localServerCmd.Flags().StringVarP(&localAddr, "addr", "a", "127.0.0.1:7700", "Address to serve the vh web UI on")
	localServerCmd.Flags().StringVar(&localVHSock, "vh-sock", "", "Also serve /vh/* on this AF_UNIX socket path (bind-mount it to reach the worker from a container with no host networking)")
	localServerCmd.Flags().StringVar(&localOpenCodeBin, "opencode-bin", "opencode", "Path to the opencode binary")
	localServerCmd.Flags().StringVar(&localOpenCodeURL, "opencode-url", "", "Attach to an externally-managed OpenCode at this URL instead of spawning one")
	localServerCmd.Flags().BoolVar(&localOpenCodeDetached, "opencode-detached", false, "Spawn OpenCode detached and reconnect across restarts (survives self-update)")
	localServerCmd.Flags().StringVar(&localOpenCodeUpdate, "opencode-update-cmd", "", "Command to update OpenCode (default: `<opencode-bin> upgrade`)")
	localServerCmd.Flags().StringVar(&localOpenCodeRestart, "opencode-restart-cmd", "", "(external) Command to restart externally-managed OpenCode")
	localServerCmd.Flags().StringArrayVar(&localCORSOrigins, "cors-origin", nil, "Allowed cross-origin caller (repeatable; or * to allow any)")
	localServerCmd.Flags().StringArrayVar(&localFrameAncestors, "frame-ancestors", nil, "Allowed CSP frame-ancestors for cross-origin <iframe> embedding (repeatable; e.g. 'self' https://app.my-root-domain). Default 'self'; the list REPLACES the default, so include 'self' if the app's own iframes (e.g. the code viewer) must still work")
	localServerCmd.Flags().BoolVar(&localExternalManaged, "external-managed", false, "Run under a supervisor; on a 'restart server' request exit cleanly instead of re-exec'ing")
	registerAuthFlags(localServerCmd, &localAuth)
	rootCmd.AddCommand(localServerCmd)
}
