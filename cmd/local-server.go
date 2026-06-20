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
		var opencodeMu sync.Mutex
		var vhCancel context.CancelFunc
		var vhHTTP *http.Server

		external := localOpenCodeURL != ""
		var opencodeURL string
		opencodePort := 0
		switch {
		case external:
			opencodeURL = strings.TrimRight(localOpenCodeURL, "/")
			log.Printf("local-server: attaching to external OpenCode at %s", opencodeURL)
			if err := waitForURL(opencodeURL+"/session", 30*time.Second); err != nil {
				log.Fatalf("external OpenCode not reachable at %s: %v", opencodeURL, err)
			}

		case localOpenCodeDetached:
			if st, ok := readOCState(); ok && ocInstanceOurs(st) {
				opencodePort = st.Port
				opencodeURL = fmt.Sprintf("http://127.0.0.1:%d", st.Port)
				log.Printf("local-server: reconnected to our detached OpenCode pid=%d port=%d", st.PID, st.Port)
			} else {
				opencodePort = freePort()
				if st, ok := readOCState(); ok && portFree(st.Port) {
					opencodePort = st.Port
				}
				c, err := startOpenCodeServeDetached(localOpenCodeBin, opencodePort, cwd)
				if err != nil {
					log.Fatalf("Failed to start detached opencode serve: %v", err)
				}
				opencodeServeCmd = c
				if err := waitForPort(opencodePort, 30*time.Second); err != nil {
					log.Fatalf("opencode serve failed to listen on port %d: %v", opencodePort, err)
				}
				writeOCState(ocState{PID: c.Process.Pid, Port: opencodePort})
				opencodeURL = fmt.Sprintf("http://127.0.0.1:%d", opencodePort)
				log.Printf("local-server: spawned detached OpenCode pid=%d port=%d", c.Process.Pid, opencodePort)
			}

		default:
			opencodePort = freePort()
			c, err := startOpenCodeServe(localOpenCodeBin, opencodePort, cwd)
			if err != nil {
				log.Fatalf("Failed to start opencode serve: %v", err)
			}
			opencodeServeCmd = c
			if err := waitForPort(opencodePort, 30*time.Second); err != nil {
				log.Fatalf("opencode serve failed to listen on port %d: %v", opencodePort, err)
			}
			opencodeURL = fmt.Sprintf("http://127.0.0.1:%d", opencodePort)
			log.Printf("local-server: spawned OpenCode pid=%d port=%d", c.Process.Pid, opencodePort)
		}

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

		// Restart the owned OpenCode in place; the aggregator re-hydrates. Caller
		// holds opencodeMu.
		restartOpencodeLocked := func() error {
			if external {
				if localOpenCodeRestart == "" {
					return fmt.Errorf("OpenCode is externally managed; set --opencode-restart-cmd to enable restart from the UI")
				}
				if err := runShellCmd(context.Background(), localOpenCodeRestart, cwd, nil); err != nil {
					return err
				}
				return waitForURL(opencodeURL+"/session", 30*time.Second)
			}
			if localOpenCodeDetached {
				if st, ok := readOCState(); ok {
					killPID(st.PID)
				}
				if opencodeServeCmd != nil && opencodeServeCmd.Process != nil {
					killPID(opencodeServeCmd.Process.Pid)
				}
				time.Sleep(300 * time.Millisecond)
				c, err := startOpenCodeServeDetached(localOpenCodeBin, opencodePort, cwd)
				if err != nil {
					return err
				}
				opencodeServeCmd = c
				if err := waitForPort(opencodePort, 30*time.Second); err != nil {
					return err
				}
				writeOCState(ocState{PID: c.Process.Pid, Port: opencodePort})
				return nil
			}
			if opencodeServeCmd != nil && opencodeServeCmd.Process != nil {
				_ = opencodeServeCmd.Process.Signal(syscall.SIGTERM)
				_ = opencodeServeCmd.Wait()
			}
			c, err := startOpenCodeServe(localOpenCodeBin, opencodePort, cwd)
			if err != nil {
				return err
			}
			opencodeServeCmd = c
			return waitForPort(opencodePort, 30*time.Second)
		}

		if len(localCORSOrigins) > 0 {
			srv.SetCORSOrigins(localCORSOrigins)
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
	localServerCmd.Flags().BoolVar(&localExternalManaged, "external-managed", false, "Run under a supervisor; on a 'restart server' request exit cleanly instead of re-exec'ing")
	registerAuthFlags(localServerCmd, &localAuth)
	rootCmd.AddCommand(localServerCmd)
}
