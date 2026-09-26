package cmd

import (
	"log"
	"os"

	"github.com/spf13/cobra"
	"github.com/vhqtvn/vh-solara/pkg/server"
)

var serverAddr string
var daemonAddr string
var hostPattern string
var serverAuth authFlags
var serverWorkerSecret string
var serverAPIToken string

// serverStatusWorkers is the optional expected-fleet roster for
// GET /vh/fleet/status (--status-worker, repeatable). Empty = the rollup
// reports the explicitly-discovered scope instead.
var serverStatusWorkers []string

// serverStatusProjects is the optional expected-project roster for
// GET /vh/fleet/status (--status-project, repeatable). Entries are matched
// VERBATIM against the worker-reported dir (whitespace-only entries are
// ignored as blank; surrounding whitespace in a non-blank entry is
// significant). Empty = the rollup reports every instantiated project a
// worker discovers instead.
var serverStatusProjects []string

var serverCmd = &cobra.Command{
	Use:   "server",
	Short: "Run the central controller server",
	Run: func(cmd *cobra.Command, args []string) {
		daemon := server.NewDaemon(serverAddr, daemonAddr, hostPattern)
		a, err := buildAuth(serverAddr, &serverAuth)
		if err != nil {
			log.Fatalf("Auth setup failed: %v", err)
		}
		daemon.Auth = a
		daemon.RegSecret = serverWorkerSecret
		if v := os.Getenv("VH_WORKER_SECRET"); v != "" {
			daemon.RegSecret = v
		}
		daemon.APIToken = serverAPIToken
		if v := os.Getenv("VH_API_TOKEN"); v != "" {
			daemon.APIToken = v
		}
		daemon.StatusWorkerRoster = serverStatusWorkers
		daemon.StatusProjectRoster = serverStatusProjects
		if err := daemon.Start(); err != nil {
			log.Fatalf("Server failed: %v", err)
		}
	},
}

func init() {
	serverCmd.Flags().StringVarP(&serverAddr, "addr", "a", ":8080", "Server address to listen on for user connections")
	serverCmd.Flags().StringVarP(&daemonAddr, "daemon-addr", "d", ":8081", "Server address to listen on for agent daemon connections")
	serverCmd.Flags().StringVar(&hostPattern, "host-pattern", "", "Host template to extract/build worker URLs (e.g., '$ID.example.com')")
	serverCmd.Flags().StringVar(&serverWorkerSecret, "worker-secret", "", "Shared secret required from workers on registration via X-VH-Worker-Secret (prefer the VH_WORKER_SECRET env var); empty = open registration")
	serverCmd.Flags().StringVar(&serverAPIToken, "api-token", "", "Bearer token required on the cross-worker coordination API /api/workers/{id}/sessions|events (prefer the VH_API_TOKEN env var); empty = open")
	serverCmd.Flags().StringArrayVar(&serverStatusWorkers, "status-worker", nil, "Expected fleet-status worker ID for GET /vh/fleet/status (repeatable; blank entries ignored). When set, the rollup scopes to exactly these IDs and IDs never registered are reported 'missing'. Unset = discovered scope.")
	serverCmd.Flags().StringArrayVar(&serverStatusProjects, "status-project", nil, "Expected fleet-status project directory for GET /vh/fleet/status (repeatable; whitespace-only entries are ignored as blank; non-blank entries match the worker-reported dir VERBATIM — no trimming or path canonicalization, so include any whitespace the worker itself reports). When set, per-worker project discovery is scoped to exactly these dirs (others are excluded from the rollup) and a configured dir instantiated on no online worker is reported 'project_missing'. Unset = discovered (instantiated) project scope.")
	registerAuthFlags(serverCmd, &serverAuth)
	rootCmd.AddCommand(serverCmd)
}
