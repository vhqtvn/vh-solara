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
	daemonChamberPrt       int
	daemonOpenCodeBin      string
	daemonOpenCodeHost     string
	daemonOpenCodePasswd   string
	daemonOpenCodeUpdate   string
	daemonOpenCodeURL      string
	daemonOpenCodeRestart  string
	daemonOpenCodeDetached bool
	daemonExternalManaged  bool
	daemonCORSOrigins      []string
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

		chamberPort := daemonChamberPrt

		// Track the opencode web process (opencode web mode) so we can clean it up on shutdown.
		var opencodeWebCmd *exec.Cmd
		// vh mode: the internal `opencode serve` process, plus a cancel for the
		// aggregator goroutine and a handle to the embedded web server.
		var opencodeServeCmd *exec.Cmd
		var opencodeMu sync.Mutex // serializes restarts of opencodeServeCmd
		var vhCancel context.CancelFunc
		var vhHTTP *http.Server

		switch daemonWeb {
		case WebOpenCode:
			// OpenCode ships its own web UI via `opencode web`.
			// Auto-assign a free port if none was provided.
			if chamberPort == 0 {
				chamberPort = freePort()
			}
			log.Printf("Web mode: opencode web (bin=%s, port=%d, host=%s)", daemonOpenCodeBin, chamberPort, daemonOpenCodeHost)

			c, err := startOpenCodeWeb(daemonOpenCodeBin, daemonOpenCodeHost, chamberPort, daemonOpenCodePasswd, cwd)
			if err != nil {
				log.Fatalf("Failed to start opencode web: %v", err)
			}
			opencodeWebCmd = c
			log.Printf("Started opencode web on port %d (pid=%d)", chamberPort, c.Process.Pid)

			if err := waitForPort(chamberPort, 30*time.Second); err != nil {
				log.Fatalf("opencode web failed to listen on port %d: %v", chamberPort, err)
			}
			log.Printf("Verified opencode web is actively listening on port %d.", chamberPort)

		case WebOpenChamber:
			if daemonChamber != "" {
				// 1. Check if OpenChamber is already running
				port, err := getRunningOpenChamberPort(daemonChamber)
				if err == nil && port > 0 {
					log.Printf("Found existing OpenChamber running on port %d", port)
					chamberPort = port
				} else {
					log.Printf("No existing OpenChamber found (%v). Starting a new one...", err)
					if chamberPort == 0 {
						chamberPort = freePort()
					}

					err := startOpenChamber(daemonChamber, chamberPort, cwd)
					if err != nil {
						log.Fatalf("Failed to start OpenChamber: %v", err)
					}
					log.Printf("Started detached OpenChamber on port %d", chamberPort)
				}

				// Probe the port to ensure it's alive and listening
				if err := waitForPort(chamberPort, 15*time.Second); err != nil {
					log.Fatalf("OpenChamber failed to listen on port %d: %v", chamberPort, err)
				}
				log.Printf("Verified OpenChamber is actively listening on port %d.", chamberPort)
			}

		case WebVH:
			// vh-solara's own UI: run `opencode serve` headless on an internal
			// loopback port, aggregate its state, and serve our web UI on the
			// controller-proxied port.
			if chamberPort == 0 {
				chamberPort = freePort()
			}
			// OpenCode-external (attach, don't spawn) is enabled purely by URL.
			external := daemonOpenCodeURL != ""
			var opencodeURL string
			opencodePort := 0
			switch {
			case external:
				// External-managed: attach to an already-running OpenCode (e.g. its
				// own systemd service) instead of spawning one.
				opencodeURL = strings.TrimRight(daemonOpenCodeURL, "/")
				log.Printf("Web mode: vh (external OpenCode at %s, web port=%d)", opencodeURL, chamberPort)
				if err := waitForURL(opencodeURL+"/session", 30*time.Second); err != nil {
					log.Fatalf("external OpenCode not reachable at %s: %v", opencodeURL, err)
				}
				log.Printf("Attached to external OpenCode at %s.", opencodeURL)

			case daemonOpenCodeDetached:
				// Managed-but-survivable: reconnect to the OpenCode we spawned
				// previously (recorded in a pidfile) if it's still ours + reachable;
				// otherwise spawn a fresh detached one. Survives a vh restart/update.
				if st, ok := readOCState(); ok && ocInstanceOurs(st) {
					opencodePort = st.Port
					opencodeURL = fmt.Sprintf("http://127.0.0.1:%d", st.Port)
					log.Printf("Web mode: vh (reconnected to our detached OpenCode pid=%d port=%d, web port=%d)", st.PID, st.Port, chamberPort)
				} else {
					opencodePort = freePort()
					if st, ok := readOCState(); ok && portFree(st.Port) {
						opencodePort = st.Port // reuse the stable port when free
					}
					c, err := startOpenCodeServeDetached(daemonOpenCodeBin, opencodePort, cwd)
					if err != nil {
						log.Fatalf("Failed to start detached opencode serve: %v", err)
					}
					opencodeServeCmd = c
					if err := waitForPort(opencodePort, 30*time.Second); err != nil {
						log.Fatalf("opencode serve failed to listen on port %d: %v", opencodePort, err)
					}
					writeOCState(ocState{PID: c.Process.Pid, Port: opencodePort})
					opencodeURL = fmt.Sprintf("http://127.0.0.1:%d", opencodePort)
					log.Printf("Web mode: vh (spawned detached OpenCode pid=%d port=%d, web port=%d)", c.Process.Pid, opencodePort, chamberPort)
				}

			default:
				opencodePort = freePort()
				log.Printf("Web mode: vh (opencode serve internal port=%d, web port=%d)", opencodePort, chamberPort)
				c, err := startOpenCodeServe(daemonOpenCodeBin, opencodePort, cwd)
				if err != nil {
					log.Fatalf("Failed to start opencode serve: %v", err)
				}
				opencodeServeCmd = c
				log.Printf("Started opencode serve on port %d (pid=%d)", opencodePort, c.Process.Pid)
				if err := waitForPort(opencodePort, 30*time.Second); err != nil {
					log.Fatalf("opencode serve failed to listen on port %d: %v", opencodePort, err)
				}
				log.Printf("Verified opencode serve is listening on port %d.", opencodePort)
				opencodeURL = fmt.Sprintf("http://127.0.0.1:%d", opencodePort)
			}
			if opencodeURL == "" {
				log.Fatalf("internal error: opencodeURL not set (no OpenCode target)")
			}
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

			// restartOpencodeLocked SIGTERMs + reaps the current opencode and
			// respawns it on the same port; the aggregator's reconnect loop
			// re-hydrates automatically. Caller must hold opencodeMu.
			restartOpencodeLocked := func() error {
				if external {
					// We don't own the process; restart via the operator's command
					// (e.g. `systemctl --user restart opencode`).
					if daemonOpenCodeRestart == "" {
						return fmt.Errorf("OpenCode is externally managed; set --opencode-restart-cmd to enable restart from the UI")
					}
					if err := runShellCmd(context.Background(), daemonOpenCodeRestart, cwd, nil); err != nil {
						return err
					}
					return waitForURL(opencodeURL+"/session", 30*time.Second)
				}
				if daemonOpenCodeDetached {
					// Kill the recorded detached instance (we may not hold its *Cmd
					// after a vh reconnect) and respawn detached on the same port.
					if st, ok := readOCState(); ok {
						killPID(st.PID)
					}
					if opencodeServeCmd != nil && opencodeServeCmd.Process != nil {
						killPID(opencodeServeCmd.Process.Pid)
					}
					time.Sleep(300 * time.Millisecond)
					c, err := startOpenCodeServeDetached(daemonOpenCodeBin, opencodePort, cwd)
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
				c, err := startOpenCodeServe(daemonOpenCodeBin, opencodePort, cwd)
				if err != nil {
					return err
				}
				opencodeServeCmd = c
				return waitForPort(opencodePort, 30*time.Second)
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

			var vhCtx context.Context
			vhCtx, vhCancel = context.WithCancel(context.Background())
			go agg.Run(vhCtx)
			vhHTTP = &http.Server{
				Addr:    fmt.Sprintf("127.0.0.1:%d", chamberPort),
				Handler: srv.Handler(),
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
			if err := waitForPort(chamberPort, 10*time.Second); err != nil {
				log.Fatalf("vh web server failed to listen on port %d: %v", chamberPort, err)
			}
			log.Printf("Verified vh web server is listening on port %d.", chamberPort)

		default:
			log.Fatalf("Invalid --web value %q (expected %q, %q, or %q)", daemonWeb, WebOpenCode, WebOpenChamber, WebVH)
		}

		proxy := agent.NewProxy(chamberPort)
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
			// In detached mode we deliberately leave OpenCode running so a vh
			// restart/self-update reconnects to the same instance.
			if opencodeServeCmd != nil && opencodeServeCmd.Process != nil && !daemonOpenCodeDetached {
				log.Printf("Stopping opencode serve (pid=%d)...", opencodeServeCmd.Process.Pid)
				_ = opencodeServeCmd.Process.Signal(syscall.SIGTERM)
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
				if err != nil || port != chamberPort {
					return false // Definitive proof it's dead
				}
				return true
			case WebVH:
				// Dead only if the internal opencode serve process has exited.
				if opencodeServeCmd != nil && opencodeServeCmd.ProcessState != nil {
					return false
				}
				return true
			}
			return true
		}

		go daemon.Start()

		log.Printf("Daemon Proxy started for WorkerID %s (Web: %s, Port: %d)", workerID, daemonWeb, chamberPort)

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

func startOpenChamber(chamberScript string, chamberPort int, workspace string) error {
	scriptWithArgs := fmt.Sprintf("%s --port %d", chamberScript, chamberPort)
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
// and nginx enforce auth.
func startOpenCodeServe(bin string, port int, workspace string) (*exec.Cmd, error) {
	if bin == "" {
		bin = "opencode"
	}
	cmd := exec.Command(bin, "serve", "--port", strconv.Itoa(port), "--hostname", "127.0.0.1")
	if workspace != "" {
		cmd.Dir = workspace
	}
	cmd.Env = os.Environ()
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

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
	clientDaemonCmd.Flags().IntVar(&daemonChamberPrt, "chamber-port", 0, "Port for the web UI to listen on (0 to auto-assign)")

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

	rootCmd.AddCommand(clientDaemonCmd)
}
