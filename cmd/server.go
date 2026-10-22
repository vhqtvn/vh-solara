package cmd

import (
	"log"
	"os"
	"time"

	"github.com/spf13/cobra"
	"github.com/vhqtvn/vh-solara/pkg/alerts"
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
// Unset = disabled per operation: public POST answers 503
// notify-unavailable, the public GET probe answers 200 with
// enabled:false, and the rest of the family answers 409 naming this
// flag. A set-but-invalid file fails startup.
var serverNotifyStore string

// serverNotifyFCMCreds is the optional Google service-account JSON path
// (--notify-fcm-credentials) used to send FCM push notifications (see
// pkg/server/notify_transport.go). Unset = no transport configured (the
// registry still works; POST /vh/admin/notify/test answers 409). A
// set-but-invalid file fails startup.
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

// Notify controller-hub S4 knobs: the central FCM dispatcher (per-event
// pushes from the central ledger). Dispatch is DISABLED BY DEFAULT while
// the legacy fleet-condition watcher still runs (S5 retires it): enable
// only after the token migration is verified and Pulse has re-registered
// — see --notify-dispatch's help for the documented enable order.
var (
	serverNotifyDispatch       bool
	serverNotifyDispatchPoll   time.Duration
	serverNotifyStaleAfter     time.Duration
	serverNotifyDispatchCool   time.Duration
	serverNotifyDispatchTTLSec int
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
		// the family disabled per operation (public POST 503, GET probe
		// 200 enabled:false, rest 409 naming this flag). A missing file in
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
		// (S5) The legacy fleet-condition watcher's aggregate notification
		// loop is RETIRED — no startup wiring remains. Fleet status
		// itself (GET /vh/fleet/status, its SSE stream, and the
		// lazy-refresh cache) never depended on the watcher's ticks; the
		// watcher's only outputs were legacy delivery-history appends
		// (the archive stays readable) and token fan-out sends (the S4
		// central dispatcher owns delivery now, --notify-dispatch).
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
		// Central FCM dispatcher (notify controller-hub S4,
		// pkg/server/notify_dispatch.go): per-event pushes from the central
		// ledger through the CONTROLLER's own shared-sender instance (the
		// worker sender machinery, controller credentials — v4 (a)).
		// Opt-in via --notify-dispatch; since the S5 retirement of the
		// legacy watcher it is the ONLY notification delivery writer, so
		// a controller running without it delivers no pushes at all. The
		// enable order is documented on the flag itself.
		if serverNotifyDispatch {
			if serverNotifyStore == "" {
				log.Fatalf("--notify-dispatch requires --notify-store (the central ledger + token registry)")
			}
			if serverNotifyFCMCreds == "" {
				log.Fatalf("--notify-dispatch requires --notify-fcm-credentials (the controller's FCM credentials)")
			}
			transport, err := alerts.NewFCMTransportFromFile(serverNotifyFCMCreds, "", serverNotifyDispatchTTLSec)
			if err != nil {
				log.Fatalf("--notify-dispatch: FCM credentials: %v", err)
			}
			if err := daemon.StartNotifyDispatch(server.NotifyDispatchConfig{
				PollInterval: serverNotifyDispatchPoll,
				StaleAfter:   serverNotifyStaleAfter,
				Cooldown:     serverNotifyDispatchCool,
				TTLSec:       serverNotifyDispatchTTLSec,
			}, transport); err != nil {
				log.Fatalf("--notify-dispatch: %v", err)
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
	serverCmd.Flags().StringVar(&serverNotifyStore, "notify-store", "", "Path to the push-notification token registry JSON file for the companion app, managed via public POST/GET /vh/notify/tokens + admin PATCH/DELETE /vh/admin/notify/tokens/{id} (rewritten as canonical JSON on change; created on first change when missing). A set-but-invalid file fails startup. Unset = disabled per operation: public POST answers 503 notify-unavailable, the public GET probe answers 200 with enabled:false, and the rest of the family (admin list/PATCH/DELETE, test-send, history) answer 409 naming this flag.")
	serverCmd.Flags().StringVar(&serverNotifyFCMCreds, "notify-fcm-credentials", "", "Path to the Google service-account JSON (client_email, private_key, project_id) used to send FCM push notifications via POST /vh/admin/notify/test. A set-but-invalid file fails startup. Unset = no transport configured (test-send answers 409; the token registry still works).")
	serverCmd.Flags().DurationVar(&serverNotifyIngestPoll, "notify-ingest-poll", 3*time.Second, "Poll interval for the controller notify pull loop (per enrolled source; unmeasured default — tune per fleet). Requires --notify-store.")
	serverCmd.Flags().IntVar(&serverNotifyIngestConcurrency, "notify-ingest-concurrency", 4, "Maximum simultaneous notify feed fetches across the fleet (bounded fleet concurrency for the pull loop).")
	serverCmd.Flags().IntVar(&serverNotifyLedgerRetention, "notify-ledger-retention", 50000, "Central notify ledger retention bound: the number of newest committed events retained before prefix compaction (prefix truncation only; dedupe knowledge survives truncation). 0 = default.")
	serverCmd.Flags().BoolVar(&serverNotifyDispatch, "notify-dispatch", false, "Enable the central per-event FCM dispatcher (notify controller-hub S4): pushes committed ledger events through the controller's FCM credentials under the v4 gating ladder (detection-time attendance snapshot, freshness, persisted cooldown). Requires --notify-store and --notify-fcm-credentials. Disabled by default: the rollout order is (1) deploy with dispatch off, (2) verify the token migration and let Pulse re-register, (3) enable this flag. Since the S5 cutover retired the legacy fleet watcher, the dispatcher is the ONLY notification delivery writer — a controller with this flag off delivers no pushes (history/registry/probe still work).")
	serverCmd.Flags().DurationVar(&serverNotifyDispatchPoll, "notify-dispatch-poll", 3*time.Second, "Poll interval for the central FCM dispatcher (unmeasured default — tune per fleet).")
	serverCmd.Flags().DurationVar(&serverNotifyStaleAfter, "notify-stale-after", 24*time.Hour, "Stale-push threshold: ledger events older than this are history-only (never pushed, however much TTL remains; v4 §9.8 default 24h, operator-tunable).")
	serverCmd.Flags().DurationVar(&serverNotifyDispatchCool, "notify-dispatch-cooldown", 300*time.Second, "Central push cooldown per (source, notice type, token hash): a second push of the same key within this window is suppressed; decisions persist across controller restarts (the shared cooldown_sec knob; default 300s).")
	serverCmd.Flags().IntVar(&serverNotifyDispatchTTLSec, "notify-dispatch-ttl-sec", 86400, "Configured FCM TTL for central pushes, bounded by each event's remaining freshness (an old replay never gets a fresh full TTL).")
	registerAuthFlags(serverCmd, &serverAuth)
	rootCmd.AddCommand(serverCmd)
}
