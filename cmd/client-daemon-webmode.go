package cmd

import (
	"log"
	"time"
)

// setupWebMode is the mode owner: it selects and starts the web UI backend
// (opencode web / openchamber / vh) according to --web, populating the
// runtime's web-mode handles. The WebVH arm is large enough to live in its
// own method (setupVHMode); the two smaller arms are inline.
//
// On fatal spawn/listen failures this calls log.Fatalf exactly as the
// original Run closure did (opencode web / openchamber kill the worker; the
// vh arm records failures in the lifecycle instead — see setupVHMode).
func (rt *clientDaemonRuntime) setupWebMode() {
	switch daemonWeb {
	case WebOpenCode:
		// OpenCode ships its own web UI via `opencode web`.
		// Auto-assign a free port if none was provided.
		if rt.webPort == 0 {
			rt.webPort = freePort()
		}
		log.Printf("Web mode: opencode web (bin=%s, port=%d, host=%s)", daemonOpenCodeBin, rt.webPort, daemonOpenCodeHost)

		c, err := startOpenCodeWeb(daemonOpenCodeBin, daemonOpenCodeHost, rt.webPort, daemonOpenCodePasswd, rt.cwd)
		if err != nil {
			log.Fatalf("Failed to start opencode web: %v", err)
		}
		rt.opencodeWebCmd = c
		log.Printf("Started opencode web on port %d (pid=%d)", rt.webPort, c.Process.Pid)

		if err := waitForPort(rt.webPort, 30*time.Second); err != nil {
			log.Fatalf("opencode web failed to listen on port %d: %v", rt.webPort, err)
		}
		log.Printf("Verified opencode web is actively listening on port %d.", rt.webPort)

	case WebOpenChamber:
		if daemonChamber != "" {
			// 1. Check if OpenChamber is already running
			port, err := getRunningOpenChamberPort(daemonChamber)
			if err == nil && port > 0 {
				log.Printf("Found existing OpenChamber running on port %d", port)
				rt.webPort = port
			} else {
				log.Printf("No existing OpenChamber found (%v). Starting a new one...", err)
				if rt.webPort == 0 {
					rt.webPort = freePort()
				}

				err := startOpenChamber(daemonChamber, rt.webPort, rt.cwd)
				if err != nil {
					log.Fatalf("Failed to start OpenChamber: %v", err)
				}
				log.Printf("Started detached OpenChamber on port %d", rt.webPort)
			}

			// Probe the port to ensure it's alive and listening
			if err := waitForPort(rt.webPort, 15*time.Second); err != nil {
				log.Fatalf("OpenChamber failed to listen on port %d: %v", rt.webPort, err)
			}
			log.Printf("Verified OpenChamber is actively listening on port %d.", rt.webPort)
		}

	case WebVH:
		rt.setupVHMode()

	default:
		log.Fatalf("Invalid --web value %q (expected %q, %q, or %q)", daemonWeb, WebOpenCode, WebOpenChamber, WebVH)
	}
}
