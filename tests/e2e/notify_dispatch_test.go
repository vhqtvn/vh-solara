package e2e

// notify_dispatch_test.go — lane-3 e2e for the notify controller-hub S4:
// the CENTRAL DISPATCH spine over the real StartCluster tunnel — worker
// spool detection records (attended + unattended) → the S3 pull loop
// ingests them through the real yamux feed → the central ledger commits →
// the S4 central dispatcher applies the v4 gating ladder → the shared
// worker sender machinery (pkg/alerts.FCMTransport, the controller's own
// instance) delivers to the fake FCM.
//
// Proven here, end to end:
//   1. detection-time attendance semantics across the wire: an ATTENDED
//      origin suppresses the when_unattended token while the always token
//      still receives it (always bypasses attendance ONLY);
//   2. the central cooldown over the wire: the always token does NOT
//      receive the second (unattended) waiting event of the same
//      (source, type) key inside the window — while the when_unattended
//      token, not yet cooled down, receives exactly it;
//   3. the golden v4 FCM envelope on the wire: vh_worker_id/name,
//      vh_history_id (the CENTRAL ledger id), vh_ui_url derived from the
//      controller's configured host pattern;
//   4. secret hygiene: the dispatch state file keys on token hashes only.
//
// The mock FCM + OAuth endpoints are local httptest servers wired through
// a real service-account credentials file (the JWT/OAuth flow is real;
// only the endpoints are fakes) — the same seam as
// pkg/alerts/notify_test.go.

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/alerts"
	"github.com/vhqtvn/vh-solara/pkg/server"
)

const (
	e2eTokAlways = "e2e-dispatch-token-always"
	e2eTokWU     = "e2e-dispatch-token-when-unattended"
)

// e2eFCMMock captures every FCM send (token + data) and answers 200.
type e2eFCMMock struct {
	mu       sync.Mutex
	receipts chan map[string]string // data maps
}

func (m *e2eFCMMock) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	var body struct {
		Message struct {
			Token string            `json:"token"`
			Data  map[string]string `json:"data"`
		} `json:"message"`
	}
	_ = json.Unmarshal(b, &body)
	m.mu.Lock()
	data := body.Message.Data
	data["·token"] = body.Message.Token
	m.receipts <- data
	m.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{}`))
}

// startDispatchCluster boots the full S4 posture: the S3 ingest cluster
// PLUS a schema-2 token registry pre-seeded with the two policy tokens
// (written BEFORE the controller loads the store — the production boot
// order) and, after boot, the central dispatcher over the shared
// transport against local OAuth/FCM fakes.
func startDispatchCluster(t *testing.T) (*Cluster, *e2eFCMMock) {
	t.Helper()
	t.Setenv("VH_STATE_DIR", filepath.Join(t.TempDir(), "vh-state"))
	storePath := filepath.Join(t.TempDir(), "notify-store.json")

	// The pre-seeded v4 registry: one always token, one when_unattended
	// token (schema 2, explicit policies).
	seed := map[string]any{
		"schema": 2,
		"tokens": []map[string]any{
			{"id": "0011223344556677", "token": e2eTokAlways, "label": "always phone", "push_policy": "always", "created_at": "2026-10-20T00:00:00Z", "scope": map[string]any{"enabled": true, "conditions": []string{}}},
			{"id": "8899aabbccddeeff", "token": e2eTokWU, "label": "wu phone", "push_policy": "when_unattended", "created_at": "2026-10-20T00:00:00Z", "scope": map[string]any{"enabled": true, "conditions": []string{}}},
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

	// The mock OAuth + FCM endpoints and the controller's OWN shared
	// transport instance (real service-account credentials whose
	// token_uri points at the mock OAuth).
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
		_, _ = w.Write([]byte(`{"access_token":"e2e-dispatch-access","expires_in":3600,"token_type":"Bearer"}`))
	}))
	t.Cleanup(tokenSrv.Close)
	fcm := &e2eFCMMock{receipts: make(chan map[string]string, 8)}
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
		PollInterval: ingestPollInterval,
		StaleAfter:   24 * time.Hour,
		Cooldown:     300 * time.Second,
		TTLSec:       3600,
	}, trans); err != nil {
		t.Fatalf("StartNotifyDispatch: %v", err)
	}
	t.Cleanup(c.Daemon.StopNotifyDispatch)
	return c, fcm
}

// collectDispatchReceipts collects exactly n receipts (15s deadline) and
// then asserts 500ms of silence — the S4-gate C1 closure: the receipt
// stream is EXACTLY the expected multiset, never a filtered view of it
// (a receipt for an unexpected token or history id lands in the collected
// set and fails the multiset assertion instead of being discarded).
func collectDispatchReceipts(t *testing.T, fcm *e2eFCMMock, n int) []map[string]string {
	t.Helper()
	out := make([]map[string]string, 0, n)
	deadline := time.Now().Add(15 * time.Second)
	for len(out) < n {
		select {
		case r := <-fcm.receipts:
			out = append(out, r)
		case <-time.After(time.Until(deadline)):
			t.Fatalf("only %d/%d FCM receipts within the deadline: %+v", len(out), n, out)
			return nil
		}
	}
	assertNoDispatchReceipt(t, fcm, "", "exact receipt multiset")
	return out
}

// assertNoDispatchReceipt asserts no further receipt for token arrives.
func assertNoDispatchReceipt(t *testing.T, fcm *e2eFCMMock, token, context string) {
	t.Helper()
	select {
	case r := <-fcm.receipts:
		t.Fatalf("unexpected FCM receipt (%s): %+v", context, r)
	case <-time.After(500 * time.Millisecond):
	}
}

// TestNotifyDispatchEndToEndOverRealTunnel is the S4 behavioral-closure
// proof: worker notice → durable feed → real-tunnel pull → ledger commit →
// central gating ladder → FCM receipt — when_unattended SUPPRESSED under an
// attended origin while always DELIVERS; the second (unattended) event
// delivers to when_unattended but the central cooldown suppresses always.
func TestNotifyDispatchEndToEndOverRealTunnel(t *testing.T) {
	c, fcm := startDispatchCluster(t)
	waitEnrolled(t, c)

	// Two waiting/permission records on the worker's durable spool: an
	// ATTENDED detection first, an UNATTENDED detection second (the
	// detection-time snapshots the ladder must honor).
	spool := c.AlertsEngine.Source()
	now := time.Now().UnixMilli()
	rec1, err := spool.Append(alerts.Notice{
		Type: alerts.TypeWaiting, Kind: alerts.KindPermission,
		SessionID: "ses-dispatch-1", Root: "ses-dispatch-1", Project: "/workspace/e2e",
		Title: "Review requested", Detail: "detection → dispatch e2e", Ts: now,
	}, alerts.DetectionContext{Attended: true, IdleSec: 60, ProfileEligible: true})
	if err != nil {
		t.Fatalf("spool Append 1: %v", err)
	}
	rec2, err := spool.Append(alerts.Notice{
		Type: alerts.TypeWaiting, Kind: alerts.KindPermission,
		SessionID: "ses-dispatch-2", Root: "ses-dispatch-2", Project: "/workspace/e2e",
		Title: "Review requested", Detail: "detection → dispatch e2e", Ts: now + 1,
	}, alerts.DetectionContext{Attended: false, IdleSec: 60, ProfileEligible: true})
	if err != nil {
		t.Fatalf("spool Append 2: %v", err)
	}
	_ = rec1
	_ = rec2

	// The spine: ingest pulls both (central ids 1, 2), the dispatcher
	// delivers exactly two pushes:
	//   event 1 (attended)  → always ONLY;
	//   event 2 (unattended, same source|type) → when_unattended ONLY
	//   (always is centrally cooldown'd by its event-1 push).
	// collectDispatchReceipts pins the EXACT multiset (S4-gate C1): two
	// receipts and only two, no stray delivery discarded on the floor.
	rs := collectDispatchReceipts(t, fcm, 2)
	r1, r2 := rs[0], rs[1]
	if r1["·token"] != e2eTokAlways || r1["vh_history_id"] != "1" {
		t.Fatalf("receipt 1 must be (always, central id 1), got token %q id %q", r1["·token"], r1["vh_history_id"])
	}
	if r2["·token"] != e2eTokWU || r2["vh_history_id"] != "2" {
		t.Fatalf("receipt 2 must be (when_unattended, central id 2), got token %q id %q", r2["·token"], r2["vh_history_id"])
	}
	if r1["vh_event"] != "waiting" || r1["vh_condition"] != "permission_pending" {
		t.Fatalf("receipt 1 data = %v", r1)
	}
	if r1["vh_worker_id"] != c.WorkerID || r1["vh_worker_name"] == "" {
		t.Fatalf("receipt 1 worker attribution = %v / %v", r1["vh_worker_id"], r1["vh_worker_name"])
	}
	// ui_url follows the golden query order: session FIRST, then dir.
	if want := fmt.Sprintf("https://%s.localhost/app?session=ses-dispatch-1&dir=%%2Fworkspace%%2Fe2e", c.WorkerID); r1["vh_ui_url"] != want {
		t.Fatalf("receipt 1 vh_ui_url = %q, want the controller-derived %q", r1["vh_ui_url"], want)
	}
	if r2["vh_session_id"] != "ses-dispatch-2" {
		t.Fatalf("receipt 2 must be the UNATTENDED event for the when_unattended token, got %v", r2)
	}

	// Secret hygiene: the dispatch state file carries token HASHES only.
	raw, err := os.ReadFile(c.NotifyStorePath + ".dispatch")
	if err != nil {
		t.Fatalf("read dispatch state: %v", err)
	}
	if strings.Contains(string(raw), e2eTokAlways) || strings.Contains(string(raw), e2eTokWU) {
		t.Fatal("dispatch state must key on token hashes, never raw token values")
	}

	// The public probe reports the armed central channel over the real
	// HTTP edge (no auth on this cluster): enabled, count 2, policies.
	probeResp, err := http.Get(c.ControllerURL + "/vh/notify/tokens")
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	defer probeResp.Body.Close()
	pb, _ := io.ReadAll(probeResp.Body)
	var probe struct {
		Enabled  bool           `json:"enabled"`
		Count    int            `json:"count"`
		Policies map[string]int `json:"policies"`
	}
	if err := json.Unmarshal(pb, &probe); err != nil {
		t.Fatalf("probe body: %v (%s)", err, pb)
	}
	if !probe.Enabled || probe.Count != 2 || probe.Policies["always"] != 1 || probe.Policies["when_unattended"] != 1 {
		t.Fatalf("probe = %+v, want enabled / count 2 / always 1 / when_unattended 1", probe)
	}
}
