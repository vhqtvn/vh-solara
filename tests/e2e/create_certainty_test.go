package e2e

// Create-certainty Slice 1 — in-process e2e for the /vh/session/create
// protocol over the REAL stack (worker web server → aggregator → fake
// OpenCode), exercising BOTH route topologies the design names:
//
//   - direct worker (cluster.WorkerVHURL loopback) with the fixture's
//     create-hold modes, proving the two LOSS BOUNDARIES end-to-end:
//     delayed-response recovery (hold → release → receipt resolves the exact
//     id, exactly one upstream create) and permanently-lost upstream id
//     (drop → worker caches unknown; recovery NEVER fabricates an id; the
//     receipt lookup on a miss causes ZERO creates — the acceptance gate);
//   - controller per-worker-subdomain (WithHostPattern), proving the route,
//     its CSRF posture, and the receipt lookup survive the raw tunnel proxy
//     (controller → yamux → worker) with body fidelity.
//
// The shared `cluster` (TestMain in coordination_test.go) backs the
// direct-worker tests; fixture mode state is always restored via
// ResetCreateHold cleanup (serial-suite hygiene — the reset also deletes any
// session a held/dropped create minted).

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
)

// createResp mirrors the receipt envelope the worker emits
// (pkg/web/session_create.go) for decoding here.
type createResp struct {
	Protocol  string `json:"protocol"`
	Version   int    `json:"version"`
	State     string `json:"state"`
	Replayed  bool   `json:"replayed"`
	SessionID string `json:"sessionID"`
	Code      string `json:"code"`
}

// getCreateReceipt GETs the recovery-only receipt lookup (no CSRF needed).
func getCreateReceipt(t *testing.T, rawURL, key, dir string) (int, createResp) {
	t.Helper()
	u := rawURL + "/vh/session/create/receipt?key=" + url.QueryEscape(key)
	if dir != "" {
		u += "&dir=" + url.QueryEscape(dir)
	}
	resp, err := http.Get(u)
	if err != nil {
		t.Fatalf("receipt GET: %v", err)
	}
	defer resp.Body.Close()
	var out createResp
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// postCreateResult carries a raw create POST outcome from the worker.
type postCreateResult struct {
	st   int
	body createResp
	ok   bool
}

// postCreateAsync issues the CSRF-bearing create POST in the background (the
// hold mode blocks it server-side until release). Self-contained on purpose:
// no *testing.T in the goroutine, errors surface through the channel.
func postCreateAsync(rawURL, key, dir string) <-chan postCreateResult {
	ch := make(chan postCreateResult, 1)
	go func() {
		u := rawURL + "/vh/session/create"
		if dir != "" {
			u += "?dir=" + url.QueryEscape(dir)
		}
		req, err := http.NewRequest(http.MethodPost, u,
			strings.NewReader(fmt.Sprintf(`{"idempotency_key":%q}`, key)))
		if err != nil {
			ch <- postCreateResult{}
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(csrfHeaderName, csrfHeaderValue)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			ch <- postCreateResult{}
			return
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		var out createResp
		_ = json.Unmarshal(body, &out)
		ch <- postCreateResult{st: resp.StatusCode, body: out, ok: true}
	}()
	return ch
}

// TestSessionCreateHoldThenReleaseReceiptResolves is the POSITIVE crux
// (delayed-response boundary): the fixture commits the session and withholds
// the response; the worker's create stays in flight (409 receipt); release
// delivers the id inside the worker's server-owned window; the receipt lookup
// then resolves the EXACT id with exactly ONE upstream create.
func TestSessionCreateHoldThenReleaseReceiptResolves(t *testing.T) {
	const key = "e2e-create-hold-1"
	cluster.Fake.SetCreateMode(fixtures.CreateCommitThenHoldResponse)
	t.Cleanup(cluster.Fake.ResetCreateHold)
	before := cluster.Fake.CreateArrivals()

	res := postCreateAsync(cluster.WorkerVHURL, key, "")

	// While held: the receipt lookup reports in_flight (bounded poll — the
	// claim must be observed before release).
	deadline := time.Now().Add(5 * time.Second)
	sawInFlight := false
	for time.Now().Before(deadline) {
		st, out := getCreateReceipt(t, cluster.WorkerVHURL, key, "")
		if st == http.StatusConflict && out.State == "in_flight" {
			sawInFlight = true
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !sawInFlight {
		t.Fatal("receipt never reported in_flight while the create was held")
	}
	if got := cluster.Fake.CreateArrivals(); got != before+1 {
		t.Fatalf("exactly one upstream create while held, want delta 1, got %d", got-before)
	}

	// Release inside the worker's server-owned window → the id reaches the
	// worker → the POST resolves created (fresh, replayed=false).
	cluster.Fake.ReleaseCreateHold()
	select {
	case r := <-res:
		if !r.ok || r.st != http.StatusOK || r.body.State != "created" {
			t.Fatalf("held create after release: want 200 created, got st=%d resp=%+v", r.st, r.body)
		}
		if r.body.Replayed {
			t.Fatal("fresh create must carry replayed=false")
		}
		if r.body.SessionID == "" {
			t.Fatal("created receipt must carry a session id")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("release did not resolve the held create POST")
	}

	// The recovery lookup now returns the SAME id without re-executing.
	st, out := getCreateReceipt(t, cluster.WorkerVHURL, key, "")
	if st != http.StatusOK || out.State != "created" || !out.Replayed {
		t.Fatalf("receipt after resolution: want 200 created replayed=true, got %d %+v", st, out)
	}
	if got := cluster.Fake.CreateArrivals(); got != before+1 {
		t.Fatalf("recovery must not re-create: want delta 1, got %d", got-before)
	}
	t.Logf("create-certainty positive crux: held create %q resolved via receipt lookup (id=%s, one upstream create)",
		key, out.SessionID)
}

// TestSessionCreateDroppedResponseStaysUnknownNeverFabricates is the NEGATIVE
// crux (permanently-lost-id boundary): the fixture commits the session but
// drops the response, so the worker can NEVER learn the id. The create
// classifies unknown (202), the receipt stays unknown with NO fabricated id,
// and — the acceptance gate — a receipt miss causes ZERO creates.
func TestSessionCreateDroppedResponseStaysUnknownNeverFabricates(t *testing.T) {
	const key = "e2e-create-drop-1"
	cluster.Fake.SetCreateMode(fixtures.CreateCommitThenDropResponse)
	t.Cleanup(cluster.Fake.ResetCreateHold)
	before := cluster.Fake.CreateArrivals()

	resp, body := postJSON(t, cluster.WorkerVHURL+"/vh/session/create",
		map[string]any{"idempotency_key": key})
	if resp == nil || resp.StatusCode != http.StatusAccepted {
		t.Fatalf("dropped create: want 202 unknown, got resp=%v body=%s", resp, body)
	}
	var out createResp
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode dropped-create body %s: %v", body, err)
	}
	if out.State != "unknown" {
		t.Fatalf("dropped create state want unknown, got %q", out.State)
	}
	if out.SessionID != "" {
		t.Fatalf("unknown must NEVER carry a session id, got %q", out.SessionID)
	}
	if got := cluster.Fake.CreateArrivals(); got != before+1 {
		t.Fatalf("exactly one upstream create (committed then dropped), want delta 1, got %d", got-before)
	}

	// Recovery on the unknown receipt: stays honestly unknown, never
	// fabricates, never re-executes.
	st, rout := getCreateReceipt(t, cluster.WorkerVHURL, key, "")
	if st != http.StatusAccepted || rout.State != "unknown" || rout.SessionID != "" || !rout.Replayed {
		t.Fatalf("unknown receipt: want 202 unknown replayed=true (no id), got %d %+v", st, rout)
	}
	if got := cluster.Fake.CreateArrivals(); got != before+1 {
		t.Fatalf("unknown receipt lookup must not create: delta %d", got-before)
	}

	// THE GATE — recovery miss causes ZERO creates: lookups for keys with NO
	// receipt (never used / other dir) are pure misses.
	for _, missKey := range []string{"never-used-key", key + "-other-dir"} {
		arrivals := cluster.Fake.CreateArrivals()
		st, mout := getCreateReceipt(t, cluster.WorkerVHURL, missKey, "")
		if st != http.StatusNotFound || mout.State != "unavailable" {
			t.Fatalf("miss key %q: want 404 unavailable, got %d %+v", missKey, st, mout)
		}
		if got := cluster.Fake.CreateArrivals(); got != arrivals {
			t.Fatalf("GATE: recovery lookup on %q created a session (delta %d)", missKey, got-arrivals)
		}
	}
	t.Logf("create-certainty negative crux: dropped create %q stays unknown; recovery misses caused zero creates", key)
}

// TestSessionCreateDirectoryNamespacing proves the receipt is scoped to the
// CAPTURED project directory through the real worker: the same key under two
// dirs mints two receipts, each resolvable only under its own dir, and a
// cross-dir lookup is an honest miss that never creates.
func TestSessionCreateDirectoryNamespacing(t *testing.T) {
	dirA := filepath.Join(t.TempDir(), "ns-a")
	dirB := filepath.Join(t.TempDir(), "ns-b")
	const key = "e2e-create-ns"

	post := func(dir string) createResp {
		resp, body := postJSON(t, cluster.WorkerVHURL+"/vh/session/create?dir="+url.QueryEscape(dir),
			map[string]any{"idempotency_key": key})
		if resp == nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("create under %s: resp=%v body=%s", dir, resp, body)
		}
		var out createResp
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatalf("decode: %v (body=%s)", err, body)
		}
		if out.State != "created" || out.SessionID == "" {
			t.Fatalf("create under %s: %+v", dir, out)
		}
		return out
	}
	a, b := post(dirA), post(dirB)
	if a.SessionID == b.SessionID {
		t.Fatalf("same key under two dirs must mint independent receipts, both %s", a.SessionID)
	}

	st, out := getCreateReceipt(t, cluster.WorkerVHURL, key, dirA)
	if st != http.StatusOK || out.SessionID != a.SessionID || !out.Replayed {
		t.Fatalf("receipt under dirA: want %s replayed, got %d %+v", a.SessionID, st, out)
	}
	st, out = getCreateReceipt(t, cluster.WorkerVHURL, key, dirB)
	if st != http.StatusOK || out.SessionID != b.SessionID {
		t.Fatalf("receipt under dirB: want %s, got %d %+v", b.SessionID, st, out)
	}
	arrivals := cluster.Fake.CreateArrivals()
	st, out = getCreateReceipt(t, cluster.WorkerVHURL, key, filepath.Join(t.TempDir(), "ns-c"))
	if st != http.StatusNotFound || out.State != "unavailable" {
		t.Fatalf("cross-dir receipt: want 404 unavailable, got %d %+v", st, out)
	}
	if got := cluster.Fake.CreateArrivals(); got != arrivals {
		t.Fatalf("cross-dir miss must not create (delta %d)", got-arrivals)
	}
}

// TestSessionCreateControllerSubdomainTopology proves the protocol through the
// controller's per-worker-subdomain raw proxy (the production browser path
// for controller-reached workers): capability read, the worker's TRUE CSRF
// posture, create with body fidelity, and receipt round-trip — all through
// controller auth/host routing → yamux → worker.
func TestSessionCreateControllerSubdomainTopology(t *testing.T) {
	t.Setenv("VH_STATE_DIR", t.TempDir())

	c, err := StartClusterWithOptions(WithHostPattern("$ID.localhost"))
	if err != nil {
		t.Fatalf("StartClusterWithOptions: %v", err)
	}
	defer c.Close()

	// Capability read through the tunnel: 200, no-store, protocol body.
	resp, body := doViaSubdomain(t, c, http.MethodGet, "/vh/session/create/capabilities", nil, false)
	if resp.StatusCode != 200 {
		t.Fatalf("capabilities via subdomain: status %d body %s", resp.StatusCode, body)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("capabilities Cache-Control via subdomain: want no-store, got %q", cc)
	}
	var caps struct {
		Protocol     string `json:"protocol"`
		Version      int    `json:"version"`
		RecoveryOnly bool   `json:"recovery_only"`
	}
	if err := json.Unmarshal(body, &caps); err != nil || caps.Protocol != "vh-session-create" || caps.Version != 1 || !caps.RecoveryOnly {
		t.Fatalf("capabilities body via subdomain: %s (err=%v)", body, err)
	}

	// Missing CSRF → the worker's TRUE 403 (the guard survives the proxy).
	resp, body = doViaSubdomain(t, c, http.MethodPost, "/vh/session/create",
		[]byte(`{"idempotency_key":"sub-1"}`), false)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("no-CSRF create via subdomain: status %d (want worker's true 403), body %s", resp.StatusCode, body)
	}

	// THE CREATE with CSRF + JSON body through the hand-serialized proxy path.
	const key = "sub-1"
	resp, body = doViaSubdomain(t, c, http.MethodPost, "/vh/session/create",
		[]byte(fmt.Sprintf(`{"idempotency_key":%q}`, key)), true)
	if resp.StatusCode != 200 {
		t.Fatalf("create via subdomain: status %d body %s", resp.StatusCode, body)
	}
	var created createResp
	if err := json.Unmarshal(body, &created); err != nil || created.State != "created" || created.SessionID == "" || created.Replayed {
		t.Fatalf("create via subdomain body: %s (err=%v)", body, err)
	}

	// Receipt round-trip through the same path: same id, replayed=true.
	resp, body = doViaSubdomain(t, c, http.MethodGet, "/vh/session/create/receipt?key="+url.QueryEscape(key), nil, false)
	if resp.StatusCode != 200 {
		t.Fatalf("receipt via subdomain: status %d body %s", resp.StatusCode, body)
	}
	var receipt createResp
	if err := json.Unmarshal(body, &receipt); err != nil || receipt.SessionID != created.SessionID || !receipt.Replayed {
		t.Fatalf("receipt via subdomain: want id=%s replayed=true, got %s (err=%v)", created.SessionID, body, err)
	}
	t.Logf("create-certainty topology: subdomain proxy round-trip ok (id=%s)", receipt.SessionID)
}
