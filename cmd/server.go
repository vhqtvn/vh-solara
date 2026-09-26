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

// serverStatusConfig is the optional fleet-status config file path
// (--status-config): the JSONC document holding the expected
// workers/projects rosters for GET /vh/fleet/status (see
// pkg/server/status_config.go). Unset = config management disabled
// (discovered scope; PUT /vh/fleet/config answers 409).
var serverStatusConfig string

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
		// A set-but-bad config file is a STARTUP FAILURE, never a silent
		// fallback to discovered scope: LoadStatusConfig names the path and
		// the precise reason.
		if serverStatusConfig != "" {
			if err := daemon.LoadStatusConfig(serverStatusConfig); err != nil {
				log.Fatalf("--status-config: %v", err)
			}
		}
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
	serverCmd.Flags().StringVar(&serverStatusConfig, "status-config", "", "Path to the fleet-status config JSONC file: the expected workers/projects rosters for GET /vh/fleet/status, managed live via PUT /vh/fleet/config (the file is rewritten as canonical JSON on save; comments allowed on read). A set-but-invalid file fails startup. Unset = config management disabled (discovered scope).")
	registerAuthFlags(serverCmd, &serverAuth)
	rootCmd.AddCommand(serverCmd)
}
