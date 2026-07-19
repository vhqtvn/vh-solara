package server

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/vhqtvn/vh-solara/pkg/auth"
	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
	"github.com/vhqtvn/vh-solara/pkg/tunnel"
)

// Daemon is the main controller server.
type Daemon struct {
	Addr        string
	DaemonAddr  string
	HostPattern string

	// Auth, when set, gates the user-facing edge (the dashboard + every proxied
	// worker subdomain). nil = no auth (only safe on a loopback bind).
	Auth *auth.Authenticator

	// RegSecret, when non-empty, is required (constant-time) on the worker
	// registration handshake via the X-VH-Worker-Secret header. Empty = open
	// registration (the historical behavior; only safe when the registration
	// listener isn't reachable by untrusted parties).
	RegSecret string

	// APIToken, when non-empty, is the bearer token required on the cross-worker
	// coordination API (/api/workers/{id}/sessions|events). Empty = open (only
	// safe when the edge isn't reachable by untrusted parties). The coordination
	// API bypasses the session-auth edge — it's a headless, non-browser client.
	APIToken string

	Registry   *Registry
	Proxy      *Proxy
	WSUpgrader websocket.Upgrader

	updateMu  sync.Mutex
	updateLog strings.Builder

	// fetchWorkerDiag, when non-nil, overrides the production per-worker diag
	// fetcher used by handleDiagAggregate. Tests set this to inject a fake
	// (no real yamux session required). nil in production — handleDiagAggregate
	// then falls back to d.Proxy.FetchWorkerSnapshot.
	fetchWorkerDiag workerDiagFetcher
}

// NewDaemon initialises a new server daemon.
func NewDaemon(addr, daemonAddr, hostPattern string) *Daemon {
	registry := NewRegistry()
	proxy := NewProxy(registry)

	return &Daemon{
		Addr:        addr,
		DaemonAddr:  daemonAddr,
		HostPattern: hostPattern,

		Registry: registry,
		Proxy:    proxy,
		WSUpgrader: websocket.Upgrader{
			ReadBufferSize:  256 * 1024,
			WriteBufferSize: 256 * 1024,
			CheckOrigin: func(r *http.Request) bool {
				return true // allow all for MVP since it's behind Nginx
			},
		},
	}
}

// Start boots the HTTP server.
func (d *Daemon) Start() error {
	// 1. Worker tunnel endpoint (Daemon Mux)
	daemonMux := http.NewServeMux()
	daemonMux.HandleFunc("/vh-solara/ws", d.handleWorkerWS)

	go func() {
		log.Printf("Starting vh-solara daemon registration server on %s", d.DaemonAddr)
		if err := http.ListenAndServe(d.DaemonAddr, daemonMux); err != nil {
			log.Fatalf("Daemon registration server failed: %v", err)
		}
	}()

	// 2. Main API & UI endpoints (User Mux)
	log.Printf("Starting vh-solara user UI server on %s", d.Addr)
	return http.ListenAndServe(d.Addr, d.buildRootHandler())
}

// buildRootHandler constructs the served HTTP handler for the user edge: the
// userMux routes (liveness probe, dashboard, machine management), optional
// wildcard-host interception, the auth gate, and the bearer-gated coordination
// front (matched before session auth). The worker-tunnel listener (DaemonAddr)
// is separate and built in Start. Extracted so the edge handler chain is
// unit-testable without standing up a real listener.
func (d *Daemon) buildRootHandler() http.Handler {
	userMux := http.NewServeMux()

	// Liveness probe — auth-exempt so health checks work pre-login. It rides
	// Auth.Middleware's top-of-middleware /vh/healthz exemption (see
	// pkg/auth/auth.go), which applies to EVERY gated mode (passphrase / oidc /
	// trust-proxy) for BOTH controller and worker — so a credential-less
	// Docker/compose healthcheck always gets 200. A request with no
	// cookie/bearer/header must still get 200.
	userMux.HandleFunc("GET /vh/healthz", d.handleHealthz)

	// Machine management API
	userMux.HandleFunc("GET /api/workers", d.handleListWorkers)
	userMux.HandleFunc("DELETE /api/workers", d.handleCleanupWorkers)
	userMux.HandleFunc("POST /api/workers/{id}/kill", d.handleKillWorker)
	userMux.HandleFunc("GET /{$}", d.handleUIPage)

	// Latency diagnostics — AGGREGATED global view. The controller merges its
	// own probes (diag.Default) with every connected worker's snapshot fetched
	// through the yamux tunnel, returning one envelope so the SPA's Performance
	// dialog shows the whole fleet from any host (controller dashboard or any
	// worker subdomain). See pkg/server/diag_aggregate.go for the schema,
	// bounded fan-out, and per-worker timeout invariants.
	//
	// Auth-gated by Auth.Middleware (the whole userMux chain is wrapped at the
	// bottom of buildRootHandler). GET-only so NO X-VH-CSRF exception is needed
	// (csrfGuard below only enforces the header on unsafe methods under /api/).
	// hostInterceptor special-cases this path to fall through to userMux even on
	// a worker subdomain, so the aggregator wins over the per-worker proxy.
	userMux.HandleFunc("GET /vh/diag/latency", d.handleDiagAggregate)

	// Cross-worker coordination API (A3) — its own mux, gated by a bearer token
	// and matched BEFORE session auth (headless, non-browser client).
	coordMux := http.NewServeMux()
	d.registerCoordRoutes(coordMux)

	// Wrap the userMux in a middleware to intercept wildcard host patterns
	var rootHandler http.Handler = userMux

	if d.HostPattern != "" {
		// Escape the pattern literal and replace \$ID back with a regex capture group
		regexStr := regexp.QuoteMeta(d.HostPattern)
		regexStr = strings.ReplaceAll(regexStr, "\\$ID", "(?P<id>[^.]+)")
		regexStr = "^" + regexStr + "$"

		hostRegex, err := regexp.Compile(regexStr)
		if err == nil {
			log.Printf("Enabled host-based OpenChamber provisioning for pattern: %s (regex: %s)", d.HostPattern, regexStr)
			rootHandler = d.hostInterceptor(hostRegex, userMux)
		} else {
			log.Printf("Warning: failed to compile host-pattern regex: %v", err)
		}
	}

	// CSRF defense-in-depth: require the X-VH-CSRF custom header on the
	// browser-facing mutating endpoints (POST/PUT/PATCH/DELETE under /api/), so a
	// forged cross-site request can't drive the dashboard's worker-management
	// verbs even if a SameSite=Lax cookie were to ride along. Mirrors the worker's
	// pkg/web csrfGuard (same header name + non-empty check + unsafe-method
	// gating) and sits INSIDE Auth.Middleware (like the worker's chain), so the
	// 403 only fires for authenticated browser requests; GET/HEAD/OPTIONS and
	// non-/api/ paths pass through untouched. The bearer-gated coordination API
	// (coordFront, outside auth) and the worker tunnel listener are not routed
	// through here.
	rootHandler = csrfGuard(rootHandler)

	// Auth gates the entire user edge — the dashboard and every proxied worker
	// subdomain — outside the host interceptor. The worker registration listener
	// (DaemonAddr) is separate and intentionally not covered here. nil = no-op.
	rootHandler = d.Auth.Middleware(rootHandler)

	// The coordination API sits OUTSIDE session auth (bearer-gated instead), so a
	// headless coordinator reaches it without a browser session.
	rootHandler = d.coordFront(coordMux, rootHandler)

	return rootHandler
}

// csrfHeader is the custom header a same-origin browser client sends on mutating
// requests to prove it is not a forged cross-site request. A cross-site page
// cannot set a custom header without a CORS preflight, which the controller
// never approves, so only same-origin dashboard JS reaches the mutating
// endpoints. Mirrors pkg/web's const of the same name; header value "1" is the
// convention used by the worker SPA's installCsrf (web/src/csrf.ts) and the
// coordination-API proxy (coordapi.go).
const csrfHeader = "X-VH-CSRF"

// csrfGuard mirrors pkg/web's csrfGuard for the controller's browser-facing
// mutating endpoints. It requires the X-VH-CSRF header on POST/PUT/PATCH/DELETE
// to /api/* (the dashboard's worker-management verbs), returning 403 when it is
// missing; GET/HEAD/OPTIONS and non-/api/ paths pass through. This is
// defense-in-depth on top of the SameSite=Lax session cookie
// (pkg/auth/auth.go:99) — the cookie alone is not relied on. The bearer-gated
// coordination API (matched by coordFront BEFORE Auth.Middleware) and the worker
// registration listener (DaemonAddr) are NOT routed through this guard, so
// neither is affected.
func csrfGuard(next http.Handler) http.Handler {
	unsafe := map[string]bool{
		http.MethodPost:   true,
		http.MethodPut:    true,
		http.MethodPatch:  true,
		http.MethodDelete: true,
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if unsafe[r.Method] && strings.HasPrefix(r.URL.Path, "/api/") && r.Header.Get(csrfHeader) == "" {
			http.Error(w, "missing "+csrfHeader+" header (CSRF protection)", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// handleHealthz is the auth-exempt liveness probe for the controller edge, so
// /vh/healthz is a real cross-binary contract served by BOTH the controller
// (pkg/server) and the worker (pkg/web). Body mirrors pkg/web/server.go.
func (d *Daemon) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("ok"))
}

func (d *Daemon) hostInterceptor(pattern *regexp.Regexp, next http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		host := r.Host // e.g., "e8b1.mysite.com:8080"
		// Strip port if present
		if idx := strings.Index(host, ":"); idx != -1 {
			host = host[:idx]
		}

		// Route precedence: the aggregated /vh/diag/latency is CONTROLLER-OWNED
		// and must be served by the aggregator even when the browser's host is a
		// per-worker subdomain (e.g. "workerID.controller.example.com"). Without
		// this carve-out the hostInterceptor would proxy the request down to that
		// worker, returning a single-worker snapshot and forcing the operator to
		// re-fetch per project. Falling through to `next` (the userMux chain)
		// serves the global aggregator regardless of host. Per-worker
		// /vh/diag/latency remains reachable on the worker for the aggregator's
		// own fan-out (which goes through the tunnel via Proxy.FetchWorkerSnapshot,
		// not through this hostInterceptor).
		if r.URL.Path == "/vh/diag/latency" {
			next.ServeHTTP(w, r)
			return
		}

		matches := pattern.FindStringSubmatch(host)
		if len(matches) > 1 {
			workerID := matches[1]
			log.Printf("[HostInterceptor] Host %q matched pattern, extracted worker ID: %s", host, workerID)

			// Exact match only. A prefix fallback (a subdomain that is a prefix of a
			// worker ID) would route a request to an unintended worker and let a
			// short guessed subdomain reach a real one — so the subdomain must equal
			// the worker ID verbatim.
			worker, ok := d.Registry.GetWorker(workerID)
			if !ok || worker.Status == "offline" {
				// PROBE 4 (Phase 4): record the controller-side fast-fail for
				// the "worker not found / offline" case (parallel to the
				// nil/closed-transport branch in pkg/server/proxy.go). A
				// non-zero rate here while the browser's EventSource retries
				// is the signature of "operator hit the controller while the
				// worker tunnel was down".
				diag.Default.Yamux.TunnelDownRejections.Inc()
				log.Printf("[HostInterceptor] Worker %s not found or offline", workerID)
				http.Error(w, fmt.Sprintf("Worker %s not found or offline", workerID), http.StatusBadGateway)
				return
			}

			log.Printf("[HostInterceptor] Proxying to worker %s (transport closed: %v)",
				worker.ID, worker.Transport == nil || worker.Transport.IsClosed())
			d.Proxy.HandleWorkerDirect(worker.ID, worker, w, r)
			return
		}

		log.Printf("[HostInterceptor] Host %q did not match pattern", host)

		next.ServeHTTP(w, r)
	}
}

// handleWorkerWS accepts connections from the agent and sets up a yamux session.
func (d *Daemon) handleWorkerWS(w http.ResponseWriter, r *http.Request) {
	// Registration secret check, before the upgrade. The header rides the WS dial
	// handshake (the client forwards it like any --header). Constant-time compare
	// so a wrong secret can't be timed. Empty RegSecret = open (historical).
	if d.RegSecret != "" {
		got := r.Header.Get("X-VH-Worker-Secret")
		if subtle.ConstantTimeCompare([]byte(got), []byte(d.RegSecret)) != 1 {
			log.Printf("Rejected worker registration: bad or missing X-VH-Worker-Secret")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}

	conn, err := d.WSUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Failed to upgrade WS: %v", err)
		return
	}

	// Create yamux server session over the WebSocket
	mux, err := tunnel.NewMuxTransportServer(conn)
	if err != nil {
		log.Printf("Failed to init yamux session: %v", err)
		conn.Close()
		return
	}
	defer mux.Close()

	// The first stream from the client carries the registration message
	regStream, err := mux.AcceptStream()
	if err != nil {
		log.Printf("Failed to accept registration stream: %v", err)
		return
	}

	var reg tunnel.RegisterMessage
	if err := regStream.ReadJSON(&reg); err != nil {
		log.Printf("Failed to read registration: %v", err)
		regStream.Close()
		return
	}
	regStream.Close()

	if reg.Type != tunnel.TypeRegister {
		log.Printf("Expected register, got %s", reg.Type)
		return
	}

	// Use the client-provided worker ID directly.
	// The client daemon already ensures uniqueness per instance.
	// On reconnect, this will replace the existing offline entry via Registry.AddWorker.
	workerID := reg.WorkerID

	if worker, exists := d.Registry.GetWorker(workerID); exists && worker.Status == "online" && worker.Transport != nil && !worker.Transport.IsClosed() {
		log.Printf("Worker ID %q is already online, rejecting duplicate connection", workerID)
		errStream, err := mux.OpenStream()
		if err == nil {
			errStream.WriteJSON(tunnel.BaseMessage{
				Type:     tunnel.TypeFatalDuplicate,
				WorkerID: workerID,
			})
			time.Sleep(100 * time.Millisecond)
			errStream.Close()
		}
		return
	}

	worker := &Worker{
		ID:        workerID,
		Name:      reg.WorkerName,
		Version:   reg.Version,
		Transport: mux,
		LastSeen:  time.Now(),
		Status:    "online",
	}

	d.Registry.AddWorker(worker)
	log.Printf("Worker registered: %s (%s) [Original ID: %s]", worker.ID, worker.Name, reg.WorkerID)
	defer d.Registry.MarkWorkerOffline(worker.ID)

	// Accept streams from the client (heartbeats, responses, etc.)
	// In the yamux model, responses come back on the stream they were sent on,
	// so the server only needs to accept streams that the client initiates
	// (e.g. heartbeats).
	for {
		stream, err := mux.AcceptStream()
		if err != nil {
			log.Printf("Worker %s disconnected: %v", worker.ID, err)
			break
		}

		go func() {
			defer stream.Close()

			var base tunnel.BaseMessage
			if err := stream.ReadJSON(&base); err != nil {
				return
			}

			switch base.Type {
			case tunnel.TypeHeartbeat:
				d.Registry.UpdateHeartbeat(worker.ID)
			default:
				log.Printf("Unexpected client-initiated stream type: %s", base.Type)
			}
		}()
	}
}

// placeholder handlers for API routes
func (d *Daemon) handleListWorkers(w http.ResponseWriter, r *http.Request) {
	workers := d.Registry.ListWorkers()
	// Strip transport from serialization
	type pubWorker struct {
		ID       string    `json:"id"`
		Name     string    `json:"name"`
		Version  string    `json:"version"`
		LastSeen time.Time `json:"last_seen"`
		Status   string    `json:"status"`
		URL      string    `json:"url,omitempty"`
	}
	out := []pubWorker{}
	for _, wv := range workers {
		wUrl := ""
		if d.HostPattern != "" {
			wUrl = "https://" + strings.ReplaceAll(d.HostPattern, "$ID", wv.ID)
		}

		out = append(out, pubWorker{
			ID:       wv.ID,
			Name:     wv.Name,
			Version:  wv.Version,
			LastSeen: wv.LastSeen,
			Status:   wv.Status,
			URL:      wUrl,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func (d *Daemon) handleCleanupWorkers(w http.ResponseWriter, r *http.Request) {
	d.Registry.CleanupOfflineWorkers()
	w.WriteHeader(http.StatusOK)
}

func (d *Daemon) handleKillWorker(w http.ResponseWriter, r *http.Request) {
	workerID := r.PathValue("id")
	if workerID == "" {
		http.Error(w, "missing worker id", http.StatusBadRequest)
		return
	}

	worker, exists := d.Registry.GetWorker(workerID)
	if !exists {
		http.Error(w, "worker not found", http.StatusNotFound)
		return
	}
	if worker.Status == "offline" || worker.Transport == nil {
		http.Error(w, "worker is already offline", http.StatusConflict)
		return
	}

	// Send kill via a yamux stream
	stream, err := worker.Transport.OpenStream()
	if err != nil {
		http.Error(w, "failed to open stream to worker", http.StatusInternalServerError)
		return
	}
	defer stream.Close()

	killMsg := tunnel.BaseMessage{
		Type:     tunnel.TypeKillInstance,
		WorkerID: workerID,
	}
	if err := stream.WriteJSON(killMsg); err != nil {
		http.Error(w, "failed to send kill message", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (d *Daemon) handleUIPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html")
	fmt.Fprint(w, `<!DOCTYPE html>
<html>
<head>
	<title>vh-solara Dashboard</title>
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<style>
		:root {
			--bg: #0b0f19;
			--card-bg: #151b2b;
			--border: #232d42;
			--text-main: #f3f4f6;
			--text-muted: #9ca3af;
			--primary: #3b82f6;
			--primary-hover: #2563eb;
			--danger: #ef4444;
			--danger-hover: #dc2626;
			--success: #10b981;
			--modal-bg: rgba(0,0,0,0.6);
			--input-bg: rgba(0,0,0,0.2);
		}

		:root.light-theme {
			--bg: #f8fafc;
			--card-bg: #ffffff;
			--border: #e2e8f0;
			--text-main: #0f172a;
			--text-muted: #64748b;
			--primary: #2563eb;
			--primary-hover: #1d4ed8;
			--danger: #dc2626;
			--danger-hover: #b91c1c;
			--success: #059669;
			--modal-bg: rgba(15,23,42,0.4);
			--input-bg: #f8fafc;
		}

		* { box-sizing: border-box; }
		body { 
			font-family: 'Inter', system-ui, -apple-system, sans-serif; 
			background: var(--bg); 
			color: var(--text-main); 
			margin: 0; padding: 2rem; 
			display: flex; justify-content: center;
			line-height: 1.5;
			transition: background-color 0.3s ease, color 0.3s ease;
		}
		.container { width: 100%; max-width: 1000px; }
		h1, h2 { margin-top: 0; font-weight: 600; letter-spacing: -0.025em; }
		h1 { font-size: 1.5rem; }
		h2 { font-size: 1.25rem; }
		
		.card { 
			background: var(--card-bg); 
			padding: 2rem; 
			border-radius: 16px; 
			border: 1px solid var(--border);
			box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06); 
			margin-bottom: 2rem; 
			transition: all 0.3s ease;
		}
		.card:hover {
			box-shadow: 0 10px 15px -3px rgba(0,0,0,0.15), 0 4px 6px -2px rgba(0,0,0,0.08); 
			border-color: #3b82f640;
		}
		
		button { 
			background: var(--primary); color: white; border: none; 
			padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer; 
			font-weight: 500; font-size: 0.875rem; 
			transition: all 0.2s ease; 
			display: inline-flex; align-items: center; justify-content: center;
			gap: 0.5rem;
		}
		button:hover { background: var(--primary-hover); transform: translateY(-1px); }
		button:active { transform: translateY(0); }
		button.danger { background: transparent; color: var(--danger); border: 1px solid var(--border); }
		button.danger:hover { background: rgba(239, 68, 68, 0.1); border-color: var(--danger); }
		button.secondary { background: transparent; color: var(--text-main); border: 1px solid var(--border); box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
		button.secondary:hover { background: var(--border); }
		button.icon-btn { padding: 0.4rem; border-radius: 6px; }
		button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
		
		table { width: 100%; border-collapse: separate; border-spacing: 0; margin-top: 0.5rem; }
		th, td { padding: 1rem; text-align: left; border-bottom: 1px solid var(--border); transition: border-color 0.3s ease; }
		th { color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase; font-weight: 600; letter-spacing: 0.05em; border-bottom: 2px solid var(--border); }
		tr { transition: background-color 0.2s ease; }
		tr:hover td { background-color: rgba(148, 163, 184, 0.05); }
		tr:last-child td { border-bottom: none; }
		
		.badge { 
			padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.725rem; font-weight: 600; 
			text-transform: uppercase; letter-spacing: 0.05em; display: inline-block;
		}
		.badge.online { background: rgba(16, 185, 129, 0.1); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.2); }
		.badge.offline { background: rgba(156, 163, 175, 0.1); color: var(--text-muted); border: 1px solid rgba(156, 163, 175, 0.2); }
		
		.header-actions { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;flex-wrap: wrap; gap: 1rem;}
		.action-buttons { display: flex; gap: 0.5rem; flex-wrap: wrap;}
		
		.name-col { max-width: 250px; }
		.name-text { font-weight: 600; color: var(--text-main); margin-bottom: 0.125rem;}
		.text-gray { color: var(--text-muted); }
		.text-sm { font-size: 0.85rem; }
		.fade-in { animation: fadeIn 0.4s ease-out forwards; opacity: 0; }
		
		@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
		
		/* Scrollbar */
		::-webkit-scrollbar { width: 8px; height: 8px; }
		::-webkit-scrollbar-track { background: transparent; }
		::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
		::-webkit-scrollbar-thumb:hover { background: #64748b; }

		/* Theme Toggle Icons */
		.theme-icon-light { display: none; }
		.theme-icon-dark { display: block; }
		:root.light-theme .theme-icon-light { display: block; }
		:root.light-theme .theme-icon-dark { display: none; }
	</style>
	<script>
		// Theme initialization before content loads to prevent flash
		const savedTheme = localStorage.getItem('theme');
		const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
		if (savedTheme === 'light' || (!savedTheme && prefersLight)) {
			document.documentElement.classList.add('light-theme');
		}
	</script>
</head>
<body>
	<div class="container fade-in">
		<div class="card">
			<div class="header-actions">
				<h1>Connected Machines</h1>
				<div class="action-buttons">
					<button class="secondary icon-btn" onclick="toggleTheme()" aria-label="Toggle Theme" title="Toggle Theme">
						<svg class="theme-icon-dark" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
						<svg class="theme-icon-light" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
					</button>
					<button class="secondary" onclick="cleanupWorkers()">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
						Clean Offline
					</button>
				</div>
			</div>
			
			<div style="overflow-x: auto;">
				<table id="workersTable">
					<thead>
						<tr>
							<th>Name / ID</th>
							<th>Status</th>
							<th style="text-align: right;">Actions</th>
						</tr>
					</thead>
					<tbody id="workersBody">
						<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 3rem;">Loading workers...</td></tr>
					</tbody>
				</table>
			</div>
		</div>
	</div>

	<script>
		let pollingTimeout;
		
		function toggleTheme() {
			const isLight = document.documentElement.classList.toggle('light-theme');
			localStorage.setItem('theme', isLight ? 'light' : 'dark');
		}

		// X-VH-CSRF is required by the server on mutating requests (defense-in-depth
		// against CSRF; the SameSite=Lax session cookie alone is not relied on). A
		// cross-site page cannot set a custom header without a CORS preflight the
		// server never grants, so only this same-origin dashboard can pass it.
		function csrfHeaders() {
			return { 'X-VH-CSRF': '1' };
		}

		async function killWorker(id) {
			if(confirm("Terminate this OpenCode session?")) {
				await fetch('/api/workers/' + encodeURIComponent(id) + '/kill', {method: 'POST', headers: csrfHeaders()});
				fetchWorkers();
			}
		}

		async function cleanupWorkers() {
			await fetch('/api/workers', {method: 'DELETE', headers: csrfHeaders()});
			fetchWorkers();
		}

		async function fetchWorkers() {
			try {
				const workersRes = await fetch('/api/workers');
				const workers = await workersRes.json();

				const tbody = document.getElementById('workersBody');
				
				if (!workers || workers.length === 0) {
					tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 3rem;">No workers connected</td></tr>';
					return;
				}

				// Find existing rows
				const existingRows = Array.from(tbody.querySelectorAll('tr[data-worker-id]'));
				const existingMap = new Map(existingRows.map(tr => [tr.dataset.workerId, tr]));
				
				// Remove the "Loading workers..." or "No workers connected" row if needed
				if (existingRows.length === 0) {
					tbody.innerHTML = '';
				}

				const processedIds = new Set();

				workers.forEach((w, idx) => {
					processedIds.add(w.id);
					let isNew = false;
					let tr = existingMap.get(w.id);
					
					if (!tr) {
						isNew = true;
						tr = document.createElement('tr');
						tr.dataset.workerId = w.id;
						tr.style.animationDelay = (idx * 0.05) + 's';
						tr.className = 'fade-in';
						tr.style.opacity = '0'; // reset for animation
						tbody.appendChild(tr);
					}
					
					if (w.status === 'offline') {
						tr.style.opacity = '0.5';
					} else {
						tr.style.opacity = '';
					}

					// SECURITY: build the row with DOM APIs (createElement / textContent /
					// addEventListener / property assignment). The /api/workers payload is
					// already safely JSON-parsed; the ONLY XSS sink was this innerHTML
					// concatenation, which let a worker-controlled name/id/status/url inject
					// markup, forge an event-handler attribute, or break out of the onclick
					// JS string. Never assign worker-controlled text to innerHTML or inline
					// handlers.
					while (tr.firstChild) { tr.removeChild(tr.firstChild); }

					const shortId = w.id.length > 20 ? w.id.substring(0, 20) + '...' : w.id;

					const nameTd = document.createElement('td');
					nameTd.className = 'name-col';
					const nameDiv = document.createElement('div');
					nameDiv.className = 'name-text';
					nameDiv.textContent = w.name;
					const idDiv = document.createElement('div');
					idDiv.className = 'text-gray text-sm';
					idDiv.textContent = shortId;
					nameTd.appendChild(nameDiv);
					nameTd.appendChild(idDiv);
					if (w.url) {
						const urlA = document.createElement('a');
						urlA.href = w.url;
						urlA.target = '_blank';
						urlA.style.color = 'var(--primary)';
						urlA.style.textDecoration = 'none';
						urlA.style.fontSize = '0.8rem';
						urlA.textContent = 'Open Web ↗';
						nameTd.appendChild(urlA);
					}

					const statusTd = document.createElement('td');
					const badge = document.createElement('span');
					badge.className = 'badge ' + w.status;
					badge.textContent = w.status;
					statusTd.appendChild(badge);

					const actionsTd = document.createElement('td');
					actionsTd.style.textAlign = 'right';
					const actionsDiv = document.createElement('div');
					actionsDiv.className = 'action-buttons';
					actionsDiv.style.justifyContent = 'flex-end';
					if (w.status !== 'offline') {
						const killBtn = document.createElement('button');
						killBtn.className = 'danger';
						killBtn.type = 'button';
						killBtn.textContent = 'Kill';
						killBtn.addEventListener('click', () => killWorker(w.id));
						actionsDiv.appendChild(killBtn);
					}
					actionsTd.appendChild(actionsDiv);

					tr.appendChild(nameTd);
					tr.appendChild(statusTd);
					tr.appendChild(actionsTd);
				});

				// Remove rows for workers that no longer exist
				existingRows.forEach(tr => {
					if (!processedIds.has(tr.dataset.workerId)) {
						tr.remove();
					}
				});
			} catch(e) {
				console.error('Failed to fetch workers:', e);
			}
		}



		function pollWorkers() {
			fetchWorkers();
			pollingTimeout = setTimeout(pollWorkers, 3000);
		}

		pollWorkers();
	</script>
</body>
</html>`)
}
