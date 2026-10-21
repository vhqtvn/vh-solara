package e2e

// notify_feed_test.go — lane-3 e2e for the notify controller-hub S2 (v4
// §2 steps 2-4, §3.1 private feed): a REAL controller daemon + REAL worker
// agent over an actual yamux tunnel (StartCluster), the worker armed with
// the production wiring (InitAlerts durable spool + EnableInternalNotify
// bearer surface + live enrollment on every registration).
//
// Proven here, over the real tunnel:
//   1. enrollment: the controller's source registry records the worker's
//      capability advertisement (source identity, epoch, ownership START
//      state) — token never crosses the diagnostics surface;
//   2. the private feed: durable-bounded ascending pages, cursor resume,
//      the limit clamp, and the source metadata block;
//   3. the watermark ACK: idempotent under replay, monotone under delayed
//      duplicates, refused beyond the durable head, trims coherently;
//   4. the public denial matrix: worker public host, controller main host,
//      worker subdomain (the generic raw proxy), with and without a token;
//   5. unrelated tunnel traffic survives concurrent feed pulls (the parent
//      tunnel is never closed by a pull; streams clean up).
//
// The controller's PULL LOOP is S3 — this file proves the transport and the
// worker-side semantics, not scheduling.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/alerts"
	"github.com/vhqtvn/vh-solara/pkg/server"
	"github.com/vhqtvn/vh-solara/pkg/tunnel"
)

const (
	notifyFeedTimeout = 10 * time.Second
	notifyFeedBodyCap = 4 << 20 // a full 500-record page has huge headroom
)

// notifyFeedPage mirrors the private feed response shape for decoding.
type notifyFeedPage struct {
	Source struct {
		SourceID    string `json:"source_id"`
		Epoch       string `json:"epoch"`
		FirstSeq    int64  `json:"firstSeq"`
		LastSeq     int64  `json:"lastSeq"`
		DurableSeq  int64  `json:"durableSeq"`
		Overflow    int64  `json:"overflow"`
		AckedSeq    int64  `json:"ackedSeq"`
		AckedTrim   int64  `json:"ackedTrim"`
		LastPersist string `json:"lastPersistError"`
	} `json:"source"`
	Records []struct {
		Seq             int64  `json:"seq"`
		Type            string `json:"type"`
		Kind            string `json:"kind"`
		SessionID       string `json:"sessionID"`
		Title           string `json:"title"`
		Ts              int64  `json:"ts"`
		Attended        bool   `json:"attended"`
		ProfileEligible bool   `json:"profileEligible"`
	} `json:"records"`
	NextSince int64 `json:"nextSince"`
}

type notifyAckResp struct {
	Ok        bool  `json:"ok"`
	Watermark int64 `json:"watermark"`
	Trimmed   int   `json:"trimmed"`
}

// startNotifyCluster boots the full stack with the worker's notify S2
// surface armed exactly like production (cmd/client-daemon-vh.go): durable
// spool + ownership fence before the tunnel agent, private routes on the
// worker web port, live enrollment attached to every registration — under
// the AUTHENTICATED registration posture (B2): a registration secret is
// configured on the controller and the agent dials with it, so the
// enrollment the worker advertises is recorded.
func startNotifyCluster(t *testing.T) *Cluster {
	t.Helper()
	// The harness contract: pin VH_STATE_DIR BEFORE StartCluster — the
	// alerts config, spool, and ownership state ground there.
	t.Setenv("VH_STATE_DIR", filepath.Join(t.TempDir(), "vh-state"))
	c, err := StartClusterWithOptions(WithNotifyEnrollment(), WithHostPattern("$ID.localhost"), WithRegSecret("e2e-reg-secret"))
	if err != nil {
		t.Fatalf("StartCluster: %v", err)
	}
	t.Cleanup(c.Close)
	if c.AlertsEngine == nil || c.NotifyToken == "" {
		t.Fatal("harness must arm the alerts engine + private token")
	}
	return c
}

// notifyWorker returns the registered worker for tunnel fetches.
func notifyWorker(t *testing.T, c *Cluster) *server.Worker {
	t.Helper()
	w, ok := c.Daemon.Registry.GetWorker(c.WorkerID)
	if !ok {
		t.Fatalf("worker %s not registered", c.WorkerID)
	}
	return w
}

// fetchFeed pulls one feed page through the REAL tunnel (the controller's
// bounded internal transport).
func fetchFeed(t *testing.T, c *Cluster, w *server.Worker, since int64, limit int) notifyFeedPage {
	t.Helper()
	b, err := c.Daemon.Proxy.FetchNotifyFeedPage(context.Background(), w, c.NotifyToken, since, limit, notifyFeedTimeout, notifyFeedBodyCap)
	if err != nil {
		t.Fatalf("FetchNotifyFeedPage(since=%d limit=%d): %v", since, limit, err)
	}
	var p notifyFeedPage
	if err := json.Unmarshal(b, &p); err != nil {
		t.Fatalf("feed page JSON: %v\n%s", err, b)
	}
	return p
}

// waitEnrolled polls the controller's source registry until the worker's
// enrollment lands (registration is asynchronous to StartCluster's return).
func waitEnrolled(t *testing.T, c *Cluster) server.NotifySourceEntry {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		for _, e := range c.Daemon.DescribeNotifySources() {
			if e.SourceID == c.WorkerID {
				return e
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("worker enrollment never reached the controller's source registry")
	return server.NotifySourceEntry{}
}

func appendFeedRecords(t *testing.T, c *Cluster, n int) {
	t.Helper()
	spool := c.AlertsEngine.Source()
	for i := 0; i < n; i++ {
		if _, err := spool.Append(alerts.Notice{
			Type:      alerts.TypeWaiting,
			Kind:      alerts.KindPermission,
			SessionID: fmt.Sprintf("ses-%d", i),
			Title:     "Review requested",
			Detail:    "e2e feed record",
			Ts:        time.Now().UnixMilli(),
		}, alerts.DetectionContext{Attended: true, IdleSec: 60, ProfileEligible: true}); err != nil {
			t.Fatalf("spool Append %d: %v", i, err)
		}
	}
}

// --- 1 + 2 + 3: enrollment, feed pages, ACK — the happy-path spine ---

func TestNotifyFeedEnrollPageAckOverRealTunnel(t *testing.T) {
	c := startNotifyCluster(t)
	w := notifyWorker(t, c)

	// (1) Enrollment: the capability advertisement reached the controller's
	// source registry over the tunnel — identity, epoch, ownership START.
	en := waitEnrolled(t, c)
	if en.Epoch == "" {
		t.Fatal("enrollment must carry the durable source epoch")
	}
	if en.Mode != alerts.OwnershipModeController || !en.Fenced {
		t.Fatalf("controller-mode enrollment must report fenced ownership: %+v", en)
	}
	if en.NotifyCap != 1 {
		t.Fatalf("cap 1 = private feed + watermark ACK, got %d", en.NotifyCap)
	}
	// Secret hygiene: the diagnostics surface never carries the token.
	for _, e := range c.Daemon.DescribeNotifySources() {
		if e.Token != "" {
			t.Fatalf("DescribeNotifySources must strip tokens, got %q", e.Token)
		}
	}

	// The feed's source metadata must agree with the enrolled identity —
	// the epoch the controller recorded IS the epoch the feed serves under.
	p := fetchFeed(t, c, w, 0, 100)
	if p.Source.SourceID != c.WorkerID || p.Source.Epoch != en.Epoch {
		t.Fatalf("feed identity %+v disagrees with enrollment epoch %q", p.Source, en.Epoch)
	}
	if len(p.Records) != 0 || p.NextSince != 0 {
		t.Fatalf("fresh spool must feed an empty page, got %+v next=%d", p.Records, p.NextSince)
	}

	// (2) Feed pages with cursor resume: 8 records, paged 3 at a time.
	appendFeedRecords(t, c, 8)
	var seqs []int64
	since := int64(0)
	for {
		page := fetchFeed(t, c, w, since, 3)
		if page.Source.DurableSeq != 8 {
			t.Fatalf("durable head must be 8, got %d", page.Source.DurableSeq)
		}
		if page.Source.LastSeq != 8 || page.Source.FirstSeq != 1 {
			t.Fatalf("source accounting mismatch: %+v", page.Source)
		}
		for _, r := range page.Records {
			if r.Seq <= since {
				t.Fatalf("records must be strictly above the cursor: %d <= %d", r.Seq, since)
			}
			seqs = append(seqs, r.Seq)
		}
		if page.NextSince < since {
			t.Fatalf("cursor must never regress: %d < %d", page.NextSince, since)
		}
		since = page.NextSince
		if len(page.Records) == 0 {
			break
		}
	}
	if len(seqs) != 8 {
		t.Fatalf("paged feed must deliver all 8 records in order, got %v", seqs)
	}
	for i, s := range seqs {
		if s != int64(i+1) {
			t.Fatalf("ascending order broken: %v", seqs)
		}
	}
	// The detection-time snapshot rides the record (numeric ts, attendance).
	full := fetchFeed(t, c, w, 0, 100)
	r0 := full.Records[0]
	if r0.Type != alerts.TypeWaiting || r0.Kind != alerts.KindPermission || !r0.Attended || !r0.ProfileEligible || r0.Ts == 0 {
		t.Fatalf("record snapshot mismatch: %+v", r0)
	}

	// (3) Watermark ACK over the tunnel.
	ackBytes, err := c.Daemon.Proxy.PostNotifyAck(context.Background(), w, c.NotifyToken, 5, notifyFeedTimeout, notifyFeedBodyCap)
	if err != nil {
		t.Fatalf("PostNotifyAck(5): %v", err)
	}
	var ack notifyAckResp
	if err := json.Unmarshal(ackBytes, &ack); err != nil {
		t.Fatalf("ack JSON: %v\n%s", err, ackBytes)
	}
	if !ack.Ok || ack.Watermark != 5 || ack.Trimmed != 5 {
		t.Fatalf("ack(5) mismatch: %+v", ack)
	}

	// Lost-ACK retry (the same watermark arrives twice): idempotent no-op.
	ackBytes, err = c.Daemon.Proxy.PostNotifyAck(context.Background(), w, c.NotifyToken, 5, notifyFeedTimeout, notifyFeedBodyCap)
	if err != nil {
		t.Fatalf("PostNotifyAck(5) replay: %v", err)
	}
	if err := json.Unmarshal(ackBytes, &ack); err != nil {
		t.Fatal(err)
	}
	if !ack.Ok || ack.Watermark != 5 || ack.Trimmed != 0 {
		t.Fatalf("ack replay must trim nothing: %+v", ack)
	}

	// Delayed duplicate (older watermark): no regression, still ok.
	if _, err = c.Daemon.Proxy.PostNotifyAck(context.Background(), w, c.NotifyToken, 2, notifyFeedTimeout, notifyFeedBodyCap); err != nil {
		t.Fatalf("older ack: %v", err)
	}

	// Beyond the durable head: the worker refuses 409, surfaced as an
	// "HTTP 409" transport error for the controller to classify.
	_, err = c.Daemon.Proxy.PostNotifyAck(context.Background(), w, c.NotifyToken, 99, notifyFeedTimeout, notifyFeedBodyCap)
	if err == nil || !strings.Contains(err.Error(), "409") {
		t.Fatalf("ack beyond durable head must surface the worker's 409, got %v", err)
	}

	// Coherent trim: the feed no longer serves the consumed prefix and the
	// accounting names the trim (not overflow — a consumed record is not a
	// coverage gap).
	post := fetchFeed(t, c, w, 0, 100)
	if len(post.Records) != 3 || post.Records[0].Seq != 6 {
		t.Fatalf("post-ACK feed must serve 6..8, got %+v", post.Records)
	}
	if post.Source.AckedSeq != 5 || post.Source.AckedTrim != 5 || post.Source.FirstSeq != 6 {
		t.Fatalf("trim accounting mismatch: %+v", post.Source)
	}
	if post.Source.Overflow != 0 {
		t.Fatalf("ACK trims must not count as overflow, got %d", post.Source.Overflow)
	}
	// Cursor resume past the trim still works.
	tail := fetchFeed(t, c, w, 5, 100)
	if len(tail.Records) != 3 || tail.Records[2].Seq != 8 || tail.NextSince != 8 {
		t.Fatalf("tail page mismatch: %+v next=%d", tail.Records, tail.NextSince)
	}
}

// --- 4: the public denial matrix ---

func TestNotifyFeedPublicDenialMatrix(t *testing.T) {
	c := startNotifyCluster(t)
	w := notifyWorker(t, c)
	waitEnrolled(t, c)
	appendFeedRecords(t, c, 2) // feed has real data to leak

	feedPath := tunnel.InternalNotifyFeedPath
	ackPath := tunnel.InternalNotifyAckPath
	denied := func(name string, resp *http.Response, body []byte) {
		t.Helper()
		if resp == nil {
			t.Fatalf("%s: no response", name)
		}
		if resp.StatusCode == http.StatusOK {
			t.Fatalf("%s: feed must be denied on public surfaces, got 200 %s", name, body)
		}
		if strings.Contains(string(body), `"records"`) || strings.Contains(string(body), `"source_id"`) {
			t.Fatalf("%s: denial must not leak feed data: %s", name, body)
		}
		if strings.Contains(string(body), c.NotifyToken) {
			t.Fatalf("%s: denial must not echo the token", name)
		}
	}

	// (a) Worker public host — the worker's own web port, reached directly
	// (no token, and a guessed token).
	for _, tok := range []string{"", strings.Repeat("g", 64)} {
		req, _ := http.NewRequest(http.MethodGet, c.WorkerVHURL+feedPath, nil)
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		denied(fmt.Sprintf("worker host (token=%v)", tok != ""), resp, b)
	}
	// The mutating surface too: POST without the token must not 403 on CSRF
	// or 401 on session — the plain 404 shape.
	req, _ := http.NewRequest(http.MethodPost, c.WorkerVHURL+ackPath, strings.NewReader(`{"watermark":1}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	denied("worker host POST ack", resp, b)

	// (b) Controller MAIN host — no userMux route exists; the request is
	// denied before anything can proxy it to a worker.
	for _, tok := range []string{"", strings.Repeat("g", 64)} {
		req, _ := http.NewRequest(http.MethodGet, c.ControllerURL+feedPath, nil)
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		denied(fmt.Sprintf("main host (token=%v)", tok != ""), resp, b)
	}

	// (c) Worker SUBDOMAIN through the controller — the generic raw proxy
	// byte-forwards the request down the tunnel to the worker, where the
	// bearer check denies it. A browser has no token; without one the
	// answer is the worker's plain 404.
	doSub := func(method, path, token string, body io.Reader) (*http.Response, []byte) {
		req, err := http.NewRequest(method, c.ControllerURL+path, body)
		if err != nil {
			t.Fatal(err)
		}
		req.Host = "worker-e2e.localhost"
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, b
	}
	for _, tok := range []string{"", strings.Repeat("g", 64)} {
		resp, b := doSub(http.MethodGet, feedPath, tok, nil)
		denied(fmt.Sprintf("subdomain proxy (token=%v)", tok != ""), resp, b)
	}
	resp, b = doSub(http.MethodPost, ackPath, "", strings.NewReader(`{"watermark":1}`))
	denied("subdomain proxy POST ack", resp, b)

	// Baseline sanity: the SAME subdomain proxy path DOES reach the worker
	// for an ordinary public route (the denial above is the bearer check,
	// not a broken proxy) — /vh/healthz is the always-open probe.
	resp, b = doSub(http.MethodGet, "/vh/healthz", "", nil)
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("subdomain proxy baseline /vh/healthz: %v %s", resp, b)
	}

	// And the authenticated tunnel fetch still works AFTER all the denial
	// probing (the surface is alive; denial never wedged the worker).
	page := fetchFeed(t, c, w, 0, 100)
	if len(page.Records) != 2 {
		t.Fatalf("authenticated fetch after denials must still serve the feed, got %+v", page.Records)
	}
}

// --- 5: limit clamp over the real tunnel ---

func TestNotifyFeedLimitClamp(t *testing.T) {
	c := startNotifyCluster(t)
	w := notifyWorker(t, c)
	waitEnrolled(t, c)
	appendFeedRecords(t, c, 503) // durable seqs 1..503

	// limit far above the max clamps to the max (never an error).
	page := fetchFeed(t, c, w, 0, 100000)
	if len(page.Records) != 500 {
		t.Fatalf("limit must clamp to 500 over the tunnel, got %d", len(page.Records))
	}
	if page.Records[0].Seq != 1 || page.Records[499].Seq != 500 || page.NextSince != 500 {
		t.Fatalf("clamped window mismatch: start=%d end=%d next=%d",
			page.Records[0].Seq, page.Records[499].Seq, page.NextSince)
	}
	// The remainder pages through the cursor.
	rest := fetchFeed(t, c, w, 500, 500)
	if len(rest.Records) != 3 || rest.Records[0].Seq != 501 || rest.NextSince != 503 {
		t.Fatalf("remainder mismatch: %+v next=%d", rest.Records, rest.NextSince)
	}
}

// --- 6: unrelated tunnel traffic survives concurrent pulls ---

func TestNotifyFeedConcurrentPullsCoexistWithTunnelTraffic(t *testing.T) {
	c := startNotifyCluster(t)
	w := notifyWorker(t, c)
	waitEnrolled(t, c)
	appendFeedRecords(t, c, 40)

	// Interleave feed pulls (the S2 transport) with the S1 bounded JSON
	// fetch (unrelated traffic on the same yamux session) plus subdomain
	// proxy requests (the browser-shaped raw-proxy path). Nothing may break
	// the others: a pull must never close or wedge the parent tunnel.
	var wg sync.WaitGroup
	errs := make(chan error, 64)
	for i := 0; i < 8; i++ {
		wg.Add(3)
		go func(i int) { // feed pull thread
			defer wg.Done()
			since := int64(i % 4)
			for pull := 0; pull < 5; pull++ {
				if _, err := c.Daemon.Proxy.FetchNotifyFeedPage(context.Background(), w, c.NotifyToken, since, 10, notifyFeedTimeout, notifyFeedBodyCap); err != nil {
					errs <- fmt.Errorf("feed pull %d/%d: %w", i, pull, err)
					return
				}
			}
		}(i)
		go func() { // S1 bounded JSON fetch thread (unrelated traffic)
			defer wg.Done()
			for pull := 0; pull < 5; pull++ {
				if _, err := c.Daemon.Proxy.FetchWorkerJSONBounded(context.Background(), w, "/vh/healthz", notifyFeedTimeout, 1<<20); err != nil {
					errs <- fmt.Errorf("json fetch: %w", err)
					return
				}
			}
		}()
		go func() { // subdomain raw-proxy thread (browser-shaped traffic)
			defer wg.Done()
			for pull := 0; pull < 5; pull++ {
				req, err := http.NewRequest(http.MethodGet, c.ControllerURL+"/vh/healthz", nil)
				if err != nil {
					errs <- err
					return
				}
				req.Host = "worker-e2e.localhost"
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					errs <- fmt.Errorf("subdomain proxy: %w", err)
					return
				}
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				if resp.StatusCode != http.StatusOK {
					errs <- fmt.Errorf("subdomain proxy: status %d", resp.StatusCode)
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	// The tunnel still serves a full sequential pass afterwards.
	since, got := int64(0), 0
	for {
		page := fetchFeed(t, c, w, since, 7)
		got += len(page.Records)
		if len(page.Records) == 0 {
			break
		}
		since = page.NextSince
	}
	if got != 40 {
		t.Fatalf("post-concurrency full pass: got %d records, want 40", got)
	}
}

// The mixed-version downgrade path: a controller that recorded an enrollment
// drops the worker's entry when the capability disappears (a re-registration
// without the notify block). The nil-block path itself is unit-proven
// (pkg/server TestNotifyRegistryNilBlockRemovesEntry); here the WIRE side is
// pinned — a pre-S2 agent (no SetNotifyEnroll) registers fine and the
// controller's registry simply has no entry for it.
func TestNotifyFeedLegacyWorkerRegistersIneligible(t *testing.T) {
	// Boot the plain cluster (NO WithNotifyEnrollment): the agent registers
	// without a notify block — the pre-S2 wire shape.
	t.Setenv("VH_STATE_DIR", filepath.Join(t.TempDir(), "vh-state"))
	c, err := StartClusterWithOptions(WithHostPattern("$ID.localhost"))
	if err != nil {
		t.Fatalf("StartCluster: %v", err)
	}
	t.Cleanup(c.Close)

	// The worker is online (registration succeeded — a missing capability
	// must not take the tunnel down)…
	w, ok := c.Daemon.Registry.GetWorker(c.WorkerID)
	if !ok {
		t.Fatal("legacy-shape worker must register")
	}
	// …and the source registry carries no notify entry for it.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if len(c.Daemon.DescribeNotifySources()) == 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if entries := c.Daemon.DescribeNotifySources(); len(entries) != 0 {
		t.Fatalf("legacy worker must stay notify-ineligible, got %+v", entries)
	}
	// Ordinary tunnel traffic works for it regardless (unrelated to notify).
	if _, err := c.Daemon.Proxy.FetchWorkerJSONBounded(context.Background(), w, "/vh/healthz", notifyFeedTimeout, 1<<20); err != nil {
		t.Fatalf("legacy worker tunnel fetch: %v", err)
	}
}

// The B2 authenticated-enrollment gate over the real tunnel: a worker that
// advertises a structurally valid notify block under the OPEN registration
// posture (no RegSecret on the controller) is registered for tunnel
// purposes — legacy registration keeps working — but its enrollment is
// REFUSED: the registry carries the explicit notify-INELIGIBLE marker for
// it, never an eligible entry, and never a token.
func TestNotifyFeedOpenRegistrationAdvertisedCapabilityIneligible(t *testing.T) {
	// Same production arming as startNotifyCluster (notify block on every
	// registration) but WITHOUT WithRegSecret: the open posture.
	t.Setenv("VH_STATE_DIR", filepath.Join(t.TempDir(), "vh-state"))
	c, err := StartClusterWithOptions(WithNotifyEnrollment(), WithHostPattern("$ID.localhost"))
	if err != nil {
		t.Fatalf("StartCluster: %v", err)
	}
	t.Cleanup(c.Close)
	if c.AlertsEngine == nil || c.NotifyToken == "" {
		t.Fatal("harness must arm the alerts engine + private token")
	}

	// The tunnel itself registered fine (legacy registration unaffected).
	w, ok := c.Daemon.Registry.GetWorker(c.WorkerID)
	if !ok {
		t.Fatal("open-posture worker must still register for the tunnel")
	}

	// The notify capability is refused: wait for the marker (registration
	// is asynchronous to StartCluster's return) and pin its shape.
	deadline := time.Now().Add(15 * time.Second)
	var marked *server.NotifySourceEntry
	for time.Now().Before(deadline) {
		for _, e := range c.Daemon.DescribeNotifySources() {
			if e.SourceID == c.WorkerID {
				m := e
				marked = &m
				break
			}
		}
		if marked != nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if marked == nil {
		t.Fatal("open-posture advertisement must produce the explicit notify-ineligible marker")
	}
	if !marked.Ineligible {
		t.Fatalf("marker must be explicitly ineligible, got %+v", marked)
	}
	if marked.Token != "" || marked.Epoch != "" || marked.NotifyCap != 0 || marked.Fenced {
		t.Fatalf("ineligible marker must carry NO enrolled state (no token/epoch/cap/fence), got %+v", marked)
	}
	// It is the ONLY entry — no eligible enrollment was recorded anywhere.
	if entries := c.Daemon.DescribeNotifySources(); len(entries) != 1 {
		t.Fatalf("exactly the ineligible marker must exist, got %+v", entries)
	}

	// Ordinary tunnel traffic still works (only the notify capability was
	// refused, never the tunnel).
	if _, err := c.Daemon.Proxy.FetchWorkerJSONBounded(context.Background(), w, "/vh/healthz", notifyFeedTimeout, 1<<20); err != nil {
		t.Fatalf("open-posture worker tunnel fetch: %v", err)
	}
}
