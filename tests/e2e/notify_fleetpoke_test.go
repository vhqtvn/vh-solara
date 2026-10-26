package e2e

// notify_fleetpoke_test.go — lane-3 e2e for the v4.1 fleet_changed status
// poke (notify-fcm.md §3.3 v4.1): the FULL spine over the real StartCluster
// tunnel —
//
//   worker session transition (fixture busy/idle over the real /event
//   stream) → worker store gate facts → controller fleet-status rollup
//   acquisition over the yamux tunnel → generation fingerprint diff → the
//   debounce state machine → fake-FCM receipt of the SILENT status poke
//   (vh_kind:"status", NORMAL, collapse_key fleet_changed) — plus the
//   session_started masking fix end to end: the same transition drives the
//   worker engine's REAL 20s sweep → session_started NOTICE through the
//   central dispatch spine (kind notice) — and the no-history rule over the
//   real public route: pokes appear nowhere in /vh/notify/history.
//
// Debounce boundedness: several rapid transitions inside one refractory
// produce a BOUNDED number of poke waves (leading + at most one catch-up
// per window per token), then silence.

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/alerts"
	"github.com/vhqtvn/vh-solara/pkg/server"
)

// fleetPokeReceipt is one captured FCM send: token, data map, and the
// android posture (priority/collapse/ttl ride the wire too).
type fleetPokeReceipt struct {
	Token       string
	Data        map[string]string
	Priority    string
	CollapseKey string
	TTL         string
	HasNotifBlk bool
}

// fleetPokeFCM captures every send (concurrently — the poke fan-out and the
// notice dispatcher deliver in parallel goroutines) and answers 200.
type fleetPokeFCM struct {
	mu       sync.Mutex
	receipts []fleetPokeReceipt
}

func (m *fleetPokeFCM) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	var body struct {
		Message struct {
			Token   string            `json:"token"`
			Data    map[string]string `json:"data"`
			Android *struct {
				Priority    string `json:"priority"`
				CollapseKey string `json:"collapse_key"`
				TTL         string `json:"ttl"`
			} `json:"android"`
			Notification *json.RawMessage `json:"notification"`
		} `json:"message"`
	}
	_ = json.Unmarshal(b, &body)
	m.mu.Lock()
	rec := fleetPokeReceipt{
		Token:       body.Message.Token,
		Data:        body.Message.Data,
		HasNotifBlk: body.Message.Notification != nil,
	}
	if body.Message.Android != nil {
		rec.Priority = body.Message.Android.Priority
		rec.CollapseKey = body.Message.Android.CollapseKey
		rec.TTL = body.Message.Android.TTL
	}
	m.receipts = append(m.receipts, rec)
	m.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{}`))
}

func (m *fleetPokeFCM) all() []fleetPokeReceipt {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]fleetPokeReceipt, len(m.receipts))
	copy(out, m.receipts)
	return out
}

// startFleetPokeCluster boots the full v4.1 posture: the S3/S4 notify
// cluster (enrollment + registry + ingest) with the central dispatcher AND
// its fleet_changed poke watcher armed at TEST CADENCES (poke tick 500ms —
// the rollup's own 5s generation TTL still bounds real acquisitions; poke
// debounce 15s, comfortably above the TTL so mid-window transitions are
// observable and absorbed).
func startFleetPokeCluster(t *testing.T) (*Cluster, *fleetPokeFCM) {
	t.Helper()
	t.Setenv("VH_STATE_DIR", filepath.Join(t.TempDir(), "vh-state"))
	storePath := filepath.Join(t.TempDir(), "notify-store.json")

	seed := map[string]any{
		"schema": 2,
		"tokens": []map[string]any{
			{"id": "0011223344556677", "token": e2eTokAlways, "label": "always phone", "push_policy": "always", "created_at": "2026-10-26T00:00:00Z", "scope": map[string]any{"enabled": true, "conditions": []string{}}},
			{"id": "8899aabbccddeeff", "token": e2eTokWU, "label": "wu phone", "push_policy": "when_unattended", "created_at": "2026-10-26T00:00:00Z", "scope": map[string]any{"enabled": true, "conditions": []string{}}},
		},
	}
	seedJSON, _ := json.MarshalIndent(seed, "", "  ")
	if err := os.WriteFile(storePath, append(seedJSON, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}

	c, err := StartClusterWithOptions(
		WithNotifyEnrollment(),
		WithHostPattern("$ID.localhost"),
		WithRegSecret("e2e-reg-secret"),
		WithNotifyStore(storePath),
		WithNotifyIngest(ingestPollInterval),
	)
	if err != nil {
		t.Fatalf("StartCluster: %v", err)
	}
	t.Cleanup(c.Close)

	// Mock OAuth + FCM and the controller's OWN shared transport (real
	// service-account credentials whose token_uri points at the mock
	// OAuth) — the same seam as the S4 dispatch e2e.
	dir := t.TempDir()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa keygen: %v", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatalf("marshal pkcs8: %v", err)
	}
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"e2e-poke-access","expires_in":3600,"token_type":"Bearer"}`))
	}))
	t.Cleanup(tokenSrv.Close)
	fcm := &fleetPokeFCM{}
	fcmSrv := httptest.NewServer(fcm)
	t.Cleanup(fcmSrv.Close)

	creds, _ := json.Marshal(map[string]any{
		"type":         "service_account",
		"project_id":   "proj-e2e",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"client_email": "bot@proj-e2e.iam.gserviceaccount.com",
		"token_uri":    tokenSrv.URL,
	})
	credsPath := filepath.Join(dir, "fcm-creds.json")
	if err := os.WriteFile(credsPath, creds, 0o600); err != nil {
		t.Fatal(err)
	}
	trans, err := alerts.NewFCMTransportFromFile(credsPath, "proj-e2e", 3600)
	if err != nil {
		t.Fatalf("NewFCMTransportFromFile: %v", err)
	}
	trans.SetBaseURL(fcmSrv.URL)

	if err := c.Daemon.StartNotifyDispatch(server.NotifyDispatchConfig{
		PollInterval:      ingestPollInterval,
		StaleAfter:        24 * time.Hour,
		Cooldown:          300 * time.Second,
		TTLSec:            3600,
		FleetPokeInterval: 500 * time.Millisecond,
		FleetPokeDebounce: 15 * time.Second,
	}, trans); err != nil {
		t.Fatalf("StartNotifyDispatch: %v", err)
	}
	t.Cleanup(c.Daemon.StopNotifyDispatch)
	return c, fcm
}

// fleetPokeCounters tallies receipts by "event|token".
type fleetPokeCounters map[string]int

// TestNotifyFleetPokeOverRealTunnel is the v4.1 behavioral-closure proof:
// a worker session transition over the real tunnel produces (a) the SILENT
// status poke at the fake FCM for EVERY registered token (both policies),
// bounded by the debounce under rapid transitions, exactly NOT in history,
// and (b) — the masking fix — the session_started NOTICE for the same
// transition through the real worker sweep + central dispatch spine.
func TestNotifyFleetPokeOverRealTunnel(t *testing.T) {
	c, fcm := startFleetPokeCluster(t)
	waitEnrolled(t, c)

	// A fresh test-owned ROOT session, spawned over the tunnel and gated on
	// store residency; it starts IDLE.
	root := spawnFleetRootOverTunnel(c, t, "fleet poke proof")

	// Wait past the worker engine's FIRST sweep tick (20s + margin): the
	// running-root baseline must be established (root idle) before the
	// transition, or session_started would be swallowed by the baseline
	// rule. The engine attaches when the first aggregator is touched —
	// the poke watcher's own ticks + the spawn above all touched it well
	// inside the first second after StartNotifyDispatch.
	time.Sleep(22 * time.Second)

	// The fleet is quiet so far: the poke watcher baselined long ago and
	// nothing may have fired yet.
	for _, r := range fcm.all() {
		t.Fatalf("quiet fleet produced an FCM receipt before any transition: %+v", r)
	}

	// --- rapid transitions on the real /event stream ----------------------
	// busy → idle → busy: three transitions. The rollup samples at its 5s
	// TTL cadence; whatever subset it observes must produce a BOUNDED
	// number of poke waves (leading + at most one catch-up inside the 15s
	// refractory) — never one per transition.
	fleetWorkerPost(c, t, "/oc/fixture/busy?session="+root)
	time.Sleep(2 * time.Second)
	fleetWorkerPost(c, t, "/oc/fixture/idle?session="+root)
	time.Sleep(2 * time.Second)
	fleetWorkerPost(c, t, "/oc/fixture/busy?session="+root) // end BUSY: the engine sweep below must observe it

	// The leading poke wave (plus any catch-up) lands within TTL + tick +
	// debounce margins. Collect for 20s.
	time.Sleep(20 * time.Second)

	all := fcm.all()
	pokes := fleetPokeCounters{}
	for _, r := range all {
		switch r.Data["vh_event"] {
		case "fleet_changed":
			pokes["fleet_changed|"+r.Token]++
			// The silent-kind wire contract, on the real wire.
			if r.Data["vh_kind"] != "status" {
				t.Fatalf("poke vh_kind = %q, want status", r.Data["vh_kind"])
			}
			if r.Data["vh_count"] != "1" {
				t.Fatalf("poke vh_count = %q, want 1", r.Data["vh_count"])
			}
			if len(r.Data["vh_ts"]) < 13 {
				t.Fatalf("poke vh_ts = %q, want unix-millis digits", r.Data["vh_ts"])
			}
			if _, ok := r.Data["vh_condition"]; ok {
				t.Fatalf("poke must not carry vh_condition (notice vocabulary): %v", r.Data)
			}
			if _, ok := r.Data["vh_worker_id"]; ok {
				t.Fatalf("poke payload must stay minimal (no worker/session/figure keys): %v", r.Data)
			}
			if r.Priority != "NORMAL" {
				t.Fatalf("poke android.priority = %q, want NORMAL", r.Priority)
			}
			if r.CollapseKey != "fleet_changed" {
				t.Fatalf("poke android.collapse_key = %q, want fleet_changed", r.CollapseKey)
			}
			if r.TTL != "300s" {
				t.Fatalf("poke android.ttl = %q, want the short 300s bound", r.TTL)
			}
			if r.HasNotifBlk {
				t.Fatal("poke must be data-only (no notification block)")
			}
		}
	}

	// Every registered token — BOTH policies (the attendance rung does not
	// exist for pokes) — received at least one poke, and the rapid
	// transitions produced a BOUNDED wave count per token.
	for _, tok := range []string{e2eTokAlways, e2eTokWU} {
		n := pokes["fleet_changed|"+tok]
		if n == 0 {
			t.Fatalf("token %s never received a fleet_changed poke (receipts: %+v)", tok, all)
		}
		if n > 2 {
			t.Fatalf("token %s received %d poke waves for 3 rapid transitions — debounce is not bounding (receipts: %+v)", tok, n, all)
		}
	}

	// --- the masking fix, end to end ---------------------------------------
	// The worker engine's next 20s sweep observes the root's idle→busy
	// transition and fires session_started (per-session detection: the
	// churn's opposite transitions do not mask it), which flows spool →
	// feed → ingest → ledger → dispatcher → FCM. The root stays busy, so
	// exactly one fire is expected: one receipt per token.
	countByEventToken := func() fleetPokeCounters {
		out := fleetPokeCounters{}
		for _, r := range fcm.all() {
			if ev := r.Data["vh_event"]; ev != "" {
				out[ev+"|"+r.Token]++
			}
		}
		return out
	}
	deadline := time.Now().Add(45 * time.Second)
	for {
		cur := countByEventToken()
		if cur["session_started|"+e2eTokAlways] > 0 && cur["session_started|"+e2eTokWU] > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("session_started notice never reached both tokens within the sweep budget (receipts: %+v)", fcm.all())
		}
		time.Sleep(500 * time.Millisecond)
	}
	for _, r := range fcm.all() {
		if r.Data["vh_event"] == "session_started" {
			if r.Data["vh_kind"] != "notice" || r.Data["vh_condition"] != "session_started" {
				t.Fatalf("session_started receipt must be a NOTICE with the identity condition: %+v", r.Data)
			}
		}
	}

	// --- quiet: no further receipts -----------------------------------------
	// The fleet is now still (root stays busy); nothing more may arrive.
	nQuiet := len(fcm.all())
	time.Sleep(3 * time.Second)
	if got := len(fcm.all()); got != nQuiet {
		t.Fatalf("quiet fleet produced %d extra receipts: %+v", got-nQuiet, fcm.all()[nQuiet:])
	}

	// --- the no-history rule over the real public route ---------------------
	// Pokes appear NOWHERE in /vh/notify/history: the only event is the
	// session_started notice, ids contiguous from 1, and lastId covers
	// exactly the notices (central ids untouched by poke waves).
	resp, body, err := c.Do(http.MethodGet, "/vh/notify/history?limit=200", "", "", nil)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /vh/notify/history: %d (err %v) %s", statusOf(resp), err, body)
	}
	var hist struct {
		Events []struct {
			ID    int    `json:"id"`
			Type  string `json:"type"`
			Kind  string `json:"kind"`
			Title string `json:"title"`
		} `json:"events"`
		LastID int64 `json:"lastId"`
	}
	if err := json.Unmarshal(body, &hist); err != nil {
		t.Fatalf("history body: %v (%s)", err, body)
	}
	if len(hist.Events) == 0 || hist.LastID == 0 {
		t.Fatalf("the session_started notice must be in central history: %s", body)
	}
	for i, ev := range hist.Events {
		if ev.ID != i+1 {
			t.Fatalf("central ids must stay contiguous from 1 (no poke consumed an id): %+v", hist.Events)
		}
		if ev.Type == "fleet_changed" || ev.Kind == "status" || ev.Kind == "fleet_changed" {
			t.Fatalf("a status poke landed in history: %+v", ev)
		}
	}
	// The only notices are session_started (nothing else fired in this
	// test's owned topology).
	for _, ev := range hist.Events {
		if ev.Type != "session_started" {
			t.Fatalf("unexpected history event %q — the poke path must not create notices: %+v", ev.Type, hist.Events)
		}
	}
}
