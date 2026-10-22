package cmd

import (
	"log"
	"os"
	"time"

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

// serverNotifyStore is the optional push-notification token registry file
// path (--notify-store): the JSON file holding the companion-app device
// tokens managed via /vh/notify/tokens (see pkg/server/notify_store.go).
// Unset = the whole /vh/notify/ family answers 409 (notifications
// disabled). A set-but-invalid file fails startup.
var serverNotifyStore string

// serverNotifyFCMCreds is the optional Google service-account JSON path
// (--notify-fcm-credentials) used to send FCM push notifications (see
// pkg/server/notify_transport.go). Unset = no transport configured (the
// registry still works; POST /vh/notify/test answers 409). A set-but-
// invalid file fails startup.
var serverNotifyFCMCreds string

// Notify controller-hub S3 knobs: the controller pull loop's cadence/
// concurrency and the central ledger's retention bound. The poll interval
// default (3s) is an UNMEASURED default (docs/architecture/
// notify-controller-hub-brief.md §2) — tune per fleet size and latency.
var (
	serverNotifyIngestPoll        time.Duration
	serverNotifyIngestConcurrency int
	serverNotifyLedgerRetention   int
)

var serverCmd = &cobra.Command{
	Use:   "server",
	Short: "Run the central controller server",
	Run: func(cmd *cobra.Command, args []string) {
		daemon := server.NewDaemon(serverAddr, daemonAddr, hostPattern)
		// Advertise the controller's real build version on the worker dial
		// response (X-VH-Controller-Version) so workers can enforce their
		// own version floor; see pkg/version.
		daemon.Version = Version
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
		// the precise reason. A missing file in an existing directory
		// starts empty (created on first save).
		if serverStatusConfig != "" {
			if err := daemon.LoadStatusConfig(serverStatusConfig); err != nil {
				log.Fatalf("--status-config: %v", err)
			}
		}
		// Same discipline for the notification registry: set-but-bad fails
		// startup (LoadNotifyStore names the path and reason); unset leaves
		// the family in the honest 409 disabled posture. A missing file in
		// an existing directory starts empty (created on first change).
		if serverNotifyStore != "" {
			// Central ledger retention (notify controller-hub S3): applied
			// when LoadNotifyStore arms the <store>.ledger journal.
			daemon.SetNotifyLedgerRetention(serverNotifyLedgerRetention)
			if err := daemon.LoadNotifyStore(serverNotifyStore); err != nil {
				log.Fatalf("--notify-store: %v", err)
			}
		}
		// Push transport wiring: FCM credentials when provided, the null
		// (disabled) transport otherwise. Credential load/parse failure is
		// a STARTUP FAILURE naming the path and reason — never a silent
		// null transport that would turn every test-send into a mystery.
		notifier := server.NewNullNotifier()
		if serverNotifyFCMCreds != "" {
			fcm, err := server.NewFCMNotifierFromFile(serverNotifyFCMCreds)
			if err != nil {
				log.Fatalf("--notify-fcm-credentials: %v", err)
			}
			notifier = fcm
		}
		daemon.SetNotifyTransport(notifier)
		// Fleet-condition watcher (notify_watcher.go): starts ONLY when
		// both the registry and a real transport are configured — no
		// store means nobody to send to; no creds means nothing to send
		// through (history-only mode is a later slice, not half-built
		// here). A no-start is silent BY DESIGN (the unset-flag postures
		// already speak through their 409s).
		daemon.StartNotifyWatcher()
		// Controller pull loop (notify controller-hub S3,
		// pkg/server/notify_ingest.go): pulls private feed pages from
		// enrolled workers into the central ledger (exactly-once ingest,
		// commit-then-ACK). Requires --notify-store (a durable ledger); the
		// loop idles when no eligible sources are enrolled, so starting it
		// with the store set is always safe.
		if serverNotifyStore != "" {
			if err := daemon.StartNotifyIngest(server.NotifyIngestConfig{
				PollInterval:  serverNotifyIngestPoll,
				MaxConcurrent: serverNotifyIngestConcurrency,
			}); err != nil {
				log.Fatalf("--notify-store: ingest loop: %v", err)
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
	serverCmd.Flags().StringVar(&serverStatusConfig, "status-config", "", "Path to the fleet-status config JSONC file: the expected workers/projects rosters for GET /vh/fleet/status, managed live via PUT /vh/fleet/config (the file is rewritten as canonical JSON on save; comments allowed on read; created on first save when missing). A set-but-invalid file fails startup. Unset = config management disabled (discovered scope).")
	serverCmd.Flags().StringVar(&serverNotifyStore, "notify-store", "", "Path to the push-notification token registry JSON file for the companion app, managed via POST/GET/PATCH/DELETE /vh/notify/tokens (rewritten as canonical JSON on change; created on first change when missing). A set-but-invalid file fails startup. Unset = the /vh/notify/ endpoints answer 409 (notifications disabled).")
	serverCmd.Flags().StringVar(&serverNotifyFCMCreds, "notify-fcm-credentials", "", "Path to the Google service-account JSON (client_email, private_key, project_id) used to send FCM push notifications via POST /vh/notify/test. A set-but-invalid file fails startup. Unset = no transport configured (test-send answers 409; the token registry still works).")
	serverCmd.Flags().DurationVar(&serverNotifyIngestPoll, "notify-ingest-poll", 3*time.Second, "Poll interval for the controller notify pull loop (per enrolled source; unmeasured default — tune per fleet). Requires --notify-store.")
	serverCmd.Flags().IntVar(&serverNotifyIngestConcurrency, "notify-ingest-concurrency", 4, "Maximum simultaneous notify feed fetches across the fleet (bounded fleet concurrency for the pull loop).")
	serverCmd.Flags().IntVar(&serverNotifyLedgerRetention, "notify-ledger-retention", 50000, "Central notify ledger retention bound: the number of newest committed events retained before prefix compaction (prefix truncation only; dedupe knowledge survives truncation). 0 = default.")
	registerAuthFlags(serverCmd, &serverAuth)
	rootCmd.AddCommand(serverCmd)
}
