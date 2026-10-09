package web

// Mixed-writer arbitration tests (send-net-resilience slice 2b phase 1, D-F2):
// while a LIVE queue-custody owner dispatches a project's queue, the
// browser-facing claim/resolve routes must refuse with 409 +
// code "queue_custody_active"; enqueue and list stay open (admission is the
// client's durable gesture; list is read-only). With the capability OFF (the
// production posture) the arbitration is DORMANT: no filesystem probes, no
// lock files, byte-equivalent legacy behavior.
//
// Linux-only (flock semantics); the non-Linux stub behavior
// (custodyLockHeld constant-false) is pinned by queue_custody_other_test.go.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// refusedBody asserts the arbitration refusal shape on a response and
// returns the decoded body.
func refusedBody(t *testing.T, resp *http.Response) map[string]any {
	t.Helper()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, want 409 (queue_custody_active); body: %s", resp.StatusCode, b)
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode refusal body: %v", err)
	}
	if body["code"] != "queue_custody_active" {
		t.Fatalf("refusal code = %v, want queue_custody_active (machine-readable)", body["code"])
	}
	if body["ok"] != false {
		t.Fatalf("refusal ok = %v, want false", body["ok"])
	}
	if _, ok := body["error"].(string); !ok || body["error"] == "" {
		t.Fatalf("refusal error = %v, want a non-empty string (the OLD-TAB shape: a legacy client parsing only ok/error/code must keep working)", body["error"])
	}
	return body
}

// assertCustodyCapabilityPayload pins the AMEND-A4 cutover contract on a
// 409 queue_custody_active body: the refusal carries a machine-readable
// CAPABILITY payload — never a bare error. The queue remains server-held
// (nothing lost), the daemon is the dispatch owner, an updated client exists
// (the receiving client spoke the pre-custody claim/resolve protocol), and
// the guidance names upgrade-and-reconnect — refresh is never the sole exit.
func assertCustodyCapabilityPayload(t *testing.T, body map[string]any) {
	t.Helper()
	cust, ok := body["custody"].(map[string]any)
	if !ok {
		t.Fatalf("409 body carries no capability payload: %v (AMEND-A4: never a bare error)", body)
	}
	if cust["dispatchOwner"] != "daemon" {
		t.Fatalf("custody.dispatchOwner = %v, want \"daemon\"", cust["dispatchOwner"])
	}
	if cust["queueHeld"] != true {
		t.Fatalf("custody.queueHeld = %v, want true (the queue remains server-held — nothing lost)", cust["queueHeld"])
	}
	if cust["updateAvailable"] != true {
		t.Fatalf("custody.updateAvailable = %v, want true (the claiming client predates the custody era)", cust["updateAvailable"])
	}
	g, ok := cust["guidance"].(string)
	if !ok || g == "" {
		t.Fatalf("custody.guidance = %v, want non-empty text", cust["guidance"])
	}
	// The recovery path is upgrade-and-reconnect — a RELOAD must not be the
	// prescribed sole exit (offline / stale-SW tabs cannot rely on one).
	for _, forbidden := range []string{"refresh immediately", "reload required"} {
		if strings.Contains(strings.ToLower(g), forbidden) {
			t.Fatalf("custody.guidance prescribes a reload as the exit: %q", g)
		}
	}
	if !strings.Contains(g, "reload is NOT required") {
		t.Fatalf("custody.guidance must state the no-reload posture explicitly: %q", g)
	}
}

func TestQueueHTTPClaimResolveRefusedWhileCustodyHeld(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	web, root := newQueueTestServer(t)
	SetQueueCustodyEnabledForTest(true)
	t.Cleanup(func() { SetQueueCustodyEnabledForTest(false) })

	// Enqueue BEFORE custody activates (also proves enqueue worked normally).
	r := csrfPost(t, web.URL+"/vh/session/s1/queue", map[string]any{"text": "queued by browser"})
	if r.StatusCode != 200 {
		b, _ := io.ReadAll(r.Body)
		r.Body.Close()
		t.Fatalf("pre-custody enqueue status = %d: %s", r.StatusCode, b)
	}
	r.Body.Close()

	// A LIVE custody owner takes the project's queue.
	tok, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	defer tok.Release()

	// Enqueue stays OPEN while custody holds (admission is the client's
	// durable gesture — the custody era still admits browser input).
	r = csrfPost(t, web.URL+"/vh/session/s1/queue", map[string]any{"text": "admitted during custody"})
	defer r.Body.Close()
	if r.StatusCode != 200 {
		b, _ := io.ReadAll(r.Body)
		t.Fatalf("enqueue during custody status = %d, want 200 (admission stays open): %s", r.StatusCode, b)
	}

	// List stays OPEN (read-only observation).
	resp, err := http.Get(web.URL + "/vh/session/s1/queue")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("list during custody status = %d, want 200", resp.StatusCode)
	}

	// Claim: REFUSED — the custody owner is this queue's single dispatcher.
	claimRefusal := refusedBody(t, csrfPost(t, web.URL+"/vh/session/s1/queue/claim", map[string]any{}))
	assertCustodyCapabilityPayload(t, claimRefusal)

	// Resolve: REFUSED, BEFORE any store access (a nonexistent item id still
	// yields the arbitration error, proving the guard precedes the store).
	resolveRefusal := refusedBody(t, csrfPost(t, web.URL+"/vh/session/s1/queue/item-does-not-exist/resolve", map[string]any{"state": "sent"}))
	assertCustodyCapabilityPayload(t, resolveRefusal)

	// After the custody owner releases, the legacy routes work again.
	tok.Release()
	r = csrfPost(t, web.URL+"/vh/session/s1/queue/claim", map[string]any{})
	defer r.Body.Close()
	if r.StatusCode != 200 {
		b, _ := io.ReadAll(r.Body)
		t.Fatalf("post-release claim status = %d, want 200: %s", r.StatusCode, b)
	}
	var claimResp struct {
		Item *QueueItem `json:"item"`
	}
	if err := json.NewDecoder(r.Body).Decode(&claimResp); err != nil {
		t.Fatal(err)
	}
	if claimResp.Item == nil {
		t.Fatal("post-release claim won nothing — the enqueued items should be pending")
	}
}

// TestQueueHTTPArbitrationDormantWhenCapabilityOff pins the production
// posture: with the daemon-dispatch capability off and no test hook armed,
// the arbitration never fires AND never touches the filesystem — no custody
// lock file is created by probing, and claim behaves exactly as before.
func TestQueueHTTPArbitrationDormantWhenCapabilityOff(t *testing.T) {
	web, root := newQueueTestServer(t)
	// NOTE: deliberately NOT arming SetQueueCustodyEnabledForTest.

	r := csrfPost(t, web.URL+"/vh/session/s1/queue/claim", map[string]any{})
	defer r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatalf("flag-off claim status = %d, want 200 (arbitration dormant)", r.StatusCode)
	}
	// The dormant gate must not have probed (a probe never CREATES the file,
	// but the stronger claim is it never RAN — asserted by file absence).
	lockPath := filepath.Join(root, ".vh-solara", custodyLockFileRel)
	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Fatalf("custody lock file exists with the capability off (%v) — dormant gate must have no FS effects", err)
	}
}

// TestQueueHTTPArbitrationDirect pins the Server-level helper itself: false
// when the capability is off (no probe), false when on but no live holder,
// true exactly when a live holder exists. This is the seam phase 2's drain
// loop will also consult before treating the browser as a co-writer.
func TestQueueHTTPArbitrationDirect(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})
	root := t.TempDir()

	// Capability off (production posture): never refused, no FS effects.
	if srv.queueCustodyArbitrationRefused(root) {
		t.Fatal("arbitration refused with the capability off — must be dormant")
	}
	if _, err := os.Stat(filepath.Join(root, ".vh-solara", custodyLockFileRel)); !os.IsNotExist(err) {
		t.Fatal("dormant arbitration touched the filesystem")
	}

	// Capability on, no live holder: not refused.
	SetQueueCustodyEnabledForTest(true)
	t.Cleanup(func() { SetQueueCustodyEnabledForTest(false) })
	if srv.queueCustodyArbitrationRefused(root) {
		t.Fatal("arbitration refused with no live holder")
	}

	// Live holder: refused.
	tok, err := AcquireQueueCustody(root)
	if err != nil {
		t.Fatal(err)
	}
	defer tok.Release()
	if !srv.queueCustodyArbitrationRefused(root) {
		t.Fatal("arbitration not refused while a live custody owner holds the queue")
	}
}
