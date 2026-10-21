package web

// notify_internal_test.go — lane-1 tests for the PRIVATE controller↔worker
// notify surface (notify controller-hub S2 / v4 §3.1): bearer-gated feed
// pages (ascending, durable-bounded, clamped limit, numeric ts), the
// watermark ACK (idempotent, no-regress, 409 beyond the durable head), the
// plain-404 denial shape on every missing/wrong-token path, the CSRF/session
// exemptions that let the tokenless-cookie controller fetch through, and the
// live enrollment provider.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/alerts"
	"github.com/vhqtvn/vh-solara/pkg/auth"
	"github.com/vhqtvn/vh-solara/pkg/tunnel"
)

// newInternalNotifyTestServer boots a worker web Server with the alerts
// engine and the private notify surface armed (the daemon's InitAlerts →
// EnableInternalNotify order, grounded at a temp VH_STATE_DIR). Returns the
// server, its engine (to append spool records), the armed token, and the
// state dir (to plant persisted ownership state).
func newInternalNotifyTestServer(t *testing.T, controllerMode bool) (*Server, *alerts.Engine, string, string) {
	t.Helper()
	stateDir := t.TempDir()
	t.Setenv("VH_STATE_DIR", stateDir)

	const deadURL = "http://127.0.0.1:1"
	srv, err := NewServer(aggregator.New(deadURL, 100), deadURL, 100)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	ctrlURL := ""
	if controllerMode {
		ctrlURL = "ws://controller.invalid/vh-solara/ws"
	}
	eng, err := srv.InitAlerts(t.Context(), AlertsOptions{
		ControllerURL: ctrlURL,
		WorkerID:      "worker-x",
		WorkerName:    "worker-x",
	})
	if err != nil {
		t.Fatalf("InitAlerts: %v", err)
	}
	token := NewInternalNotifyToken()
	srv.EnableInternalNotify(eng, token, controllerMode)
	return srv, eng, token, stateDir
}

func authedGet(ts *httptest.Server, path, token string) (*http.Response, string) {
	req, _ := http.NewRequest(http.MethodGet, ts.URL+path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err.Error()
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(resp.Body)
	return resp, buf.String()
}

func authedPost(ts *httptest.Server, path, token, body string) (*http.Response, string) {
	req, _ := http.NewRequest(http.MethodPost, ts.URL+path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err.Error()
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(resp.Body)
	return resp, buf.String()
}

func feedAppendN(t *testing.T, eng *alerts.Engine, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		if _, err := eng.Source().Append(alerts.Notice{
			Type: alerts.TypeWaiting, Kind: alerts.KindPermission,
			SessionID: "ses", Title: "Review", Ts: int64(1700000000000 + i),
		}, alerts.DetectionContext{Attended: true, IdleSec: 45, ProfileEligible: true}); err != nil {
			t.Fatalf("Append %d: %v", i, err)
		}
	}
}

// --- bearer denial shape ---

func TestInternalNotifyFeedDenialMatrix(t *testing.T) {
	srv, eng, token, _ := newInternalNotifyTestServer(t, true)
	feedAppendN(t, eng, 2)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	for _, path := range []string{tunnel.InternalNotifyFeedPath, tunnel.InternalNotifyAckPath} {
		// GET without token: plain 404, no JSON envelope.
		resp, body := authedGet(ts, path, "")
		if resp == nil || resp.StatusCode != http.StatusNotFound {
			t.Fatalf("GET %s without token: want plain 404, got %v %q", path, resp, body)
		}
		if strings.Contains(body, "{") {
			t.Fatalf("GET %s denial must not be a JSON envelope: %q", path, body)
		}
		// GET with wrong token: identical denial.
		resp, body = authedGet(ts, path, strings.Repeat("x", 64))
		if resp == nil || resp.StatusCode != http.StatusNotFound {
			t.Fatalf("GET %s wrong token: want 404, got %v %q", path, resp, body)
		}
		// POST without token (the ACK shape): plain 404, and the CSRF guard
		// must NOT 403 first (the surface is exempt from X-VH-CSRF).
		resp, body = authedPost(ts, path, "", `{"watermark":1}`)
		if resp == nil || resp.StatusCode != http.StatusNotFound {
			t.Fatalf("POST %s without token: want plain 404 (not a CSRF 403), got %v %q", path, resp, body)
		}
		// The token in a query parameter is NOT a header: still denied.
		resp, body = authedGet(ts, path+"?token="+token, "")
		if resp == nil || resp.StatusCode != http.StatusNotFound {
			t.Fatalf("GET %s?token=…: query-borne token must be denied, got %v %q", path, resp, body)
		}
	}

	// An UNARMED server (no EnableInternalNotify) mounts nothing: the path
	// never serves feed data (it falls to the SPA catch-all shell).
	t.Setenv("VH_STATE_DIR", t.TempDir())
	bare, err := NewServer(aggregator.New("http://127.0.0.1:1", 100), "http://127.0.0.1:1", 100)
	if err != nil {
		t.Fatal(err)
	}
	if got := bare.NotifyEnrollment(); got != nil {
		t.Fatalf("unarmed server must advertise no enrollment, got %+v", got)
	}
	bareTS := httptest.NewServer(bare.Handler())
	t.Cleanup(bareTS.Close)
	resp, body := authedGet(bareTS, tunnel.InternalNotifyFeedPath, "anything")
	if resp == nil {
		t.Fatalf("unarmed server request failed: %s", body)
	}
	if strings.Contains(body, `"records"`) || strings.Contains(body, `"source_id"`) {
		t.Fatalf("unarmed server must never serve feed data, got %d %q", resp.StatusCode, body)
	}
}

// --- feed page semantics over HTTP ---

func TestInternalNotifyFeedPages(t *testing.T) {
	srv, eng, token, _ := newInternalNotifyTestServer(t, true)
	feedAppendN(t, eng, 5)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	// Full page: source metadata + ascending records + resume cursor.
	resp, body := authedGet(ts, tunnel.InternalNotifyFeedPath, token)
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("feed: %v %q", resp, body)
	}
	var page struct {
		Source struct {
			SourceID   string `json:"source_id"`
			Epoch      string `json:"epoch"`
			FirstSeq   int64  `json:"firstSeq"`
			LastSeq    int64  `json:"lastSeq"`
			DurableSeq int64  `json:"durableSeq"`
			Overflow   int64  `json:"overflow"`
			AckedSeq   int64  `json:"ackedSeq"`
		} `json:"source"`
		Records []struct {
			Seq             int64  `json:"seq"`
			Type            string `json:"type"`
			Kind            string `json:"kind"`
			SessionID       string `json:"sessionID"`
			Attended        bool   `json:"attended"`
			IdleSec         int    `json:"idleSec"`
			ProfileEligible bool   `json:"profileEligible"`
			Ts              int64  `json:"ts"` // NUMERIC (v4 Position C)
		} `json:"records"`
		NextSince int64 `json:"nextSince"`
	}
	if err := json.Unmarshal([]byte(body), &page); err != nil {
		t.Fatalf("feed body: %v\n%s", err, body)
	}
	if page.Source.SourceID != "worker-x" || page.Source.Epoch == "" {
		t.Fatalf("source metadata mismatch: %+v", page.Source)
	}
	if page.Source.FirstSeq != 1 || page.Source.LastSeq != 5 || page.Source.DurableSeq != 5 || page.Source.Overflow != 0 {
		t.Fatalf("source accounting mismatch: %+v", page.Source)
	}
	if len(page.Records) != 5 || page.Records[0].Seq != 1 || page.Records[4].Seq != 5 {
		t.Fatalf("records must be ascending 1..5: %+v", page.Records)
	}
	if page.NextSince != 5 {
		t.Fatalf("nextAfter full page = %d, want 5", page.NextSince)
	}
	r := page.Records[0]
	if r.Type != alerts.TypeWaiting || !r.Attended || r.IdleSec != 45 || !r.ProfileEligible {
		t.Fatalf("detection-time snapshot must ride the record: %+v", r)
	}
	// ts must serialize as a JSON NUMBER in the private feed.
	if !strings.Contains(body, `"ts":1700000000000`) {
		t.Fatalf("private feed ts must stay numeric, body: %s", body[:min(400, len(body))])
	}

	// Cursor resume: strictly above since_seq.
	resp, body = authedGet(ts, tunnel.InternalNotifyFeedPath+"?since_seq=3", token)
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("cursor feed: %v", resp)
	}
	if err := json.Unmarshal([]byte(body), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Records) != 2 || page.Records[0].Seq != 4 || page.NextSince != 5 {
		t.Fatalf("cursor resume mismatch: %+v next=%d", page.Records, page.NextSince)
	}

	// Caught-up cursor: empty page, nextSince parked at the durable head.
	resp, body = authedGet(ts, tunnel.InternalNotifyFeedPath+"?since_seq=5", token)
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("caught-up feed: %v", resp)
	}
	if err := json.Unmarshal([]byte(body), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Records) != 0 || page.NextSince != 5 {
		t.Fatalf("caught-up page must be empty with nextSince at the durable head: %+v next=%d", page.Records, page.NextSince)
	}

	// Validation: bad since / bad limit → 400 envelope.
	for _, q := range []string{"?since_seq=-1", "?since_seq=abc", "?limit=-2", "?limit=zz"} {
		resp, _ = authedGet(ts, tunnel.InternalNotifyFeedPath+q, token)
		if resp == nil || resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: want 400, got %v", q, resp)
		}
	}
	// Method discipline: DELETE with a valid token → 405.
	req, _ := http.NewRequest(http.MethodDelete, ts.URL+tunnel.InternalNotifyFeedPath, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	dresp, err := http.DefaultClient.Do(req)
	if err != nil || dresp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE feed: want 405, got %v err=%v", dresp, err)
	}
}

func TestInternalNotifyFeedLimitClamp(t *testing.T) {
	srv, eng, token, _ := newInternalNotifyTestServer(t, true)
	feedAppendN(t, eng, internalFeedMaxLimit+3) // 503 durable records
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	// limit above the max clamps to the max — never an error (the public
	// history clamp posture).
	resp, body := authedGet(ts, fmt.Sprintf("%s?limit=%d", tunnel.InternalNotifyFeedPath, internalFeedMaxLimit*20), token)
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("clamped feed: %v %q", resp, body)
	}
	var page struct {
		Records []struct {
			Seq int64 `json:"seq"`
		} `json:"records"`
		NextSince int64 `json:"nextSince"`
	}
	if err := json.Unmarshal([]byte(body), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Records) != internalFeedMaxLimit {
		t.Fatalf("limit must clamp to %d, got %d", internalFeedMaxLimit, len(page.Records))
	}
	if page.Records[0].Seq != 1 || page.NextSince != int64(internalFeedMaxLimit) {
		t.Fatalf("clamped page must serve the first window: start=%d next=%d", page.Records[0].Seq, page.NextSince)
	}

	// The default (no limit param) applies the same window.
	resp, body = authedGet(ts, tunnel.InternalNotifyFeedPath, token)
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("default feed: %v", resp)
	}
	if err := json.Unmarshal([]byte(body), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Records) != internalFeedDefaultLimit {
		t.Fatalf("default limit must be %d, got %d", internalFeedDefaultLimit, len(page.Records))
	}
}

// --- the ACK control mutation ---

func TestInternalNotifyAckSemantics(t *testing.T) {
	srv, eng, token, _ := newInternalNotifyTestServer(t, true)
	feedAppendN(t, eng, 4)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	// Idempotent success, and no X-VH-CSRF header needed (the surface is
	// CSRF-exempt; the bearer token is the authentication).
	resp, body := authedPost(ts, tunnel.InternalNotifyAckPath, token, `{"watermark":2}`)
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("ACK 2: %v %q", resp, body)
	}
	var ack struct {
		Ok        bool  `json:"ok"`
		Watermark int64 `json:"watermark"`
		Trimmed   int   `json:"trimmed"`
	}
	if err := json.Unmarshal([]byte(body), &ack); err != nil {
		t.Fatal(err)
	}
	if !ack.Ok || ack.Watermark != 2 || ack.Trimmed != 2 {
		t.Fatalf("ACK 2 response mismatch: %+v", ack)
	}

	// Lost-ACK retry (same watermark): idempotent success, nothing trimmed.
	resp, body = authedPost(ts, tunnel.InternalNotifyAckPath, token, `{"watermark":2}`)
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("ACK 2 replay: %v %q", resp, body)
	}
	if err := json.Unmarshal([]byte(body), &ack); err != nil {
		t.Fatal(err)
	}
	if !ack.Ok || ack.Watermark != 2 || ack.Trimmed != 0 {
		t.Fatalf("ACK replay must be a no-op success: %+v", ack)
	}

	// Older watermark (delayed duplicate): no regression, still 200.
	resp, _ = authedPost(ts, tunnel.InternalNotifyAckPath, token, `{"watermark":1}`)
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("older ACK must succeed, got %v", resp)
	}

	// Beyond the durable head: 409 (v4 §9.8 — never ACK non-durable events).
	resp, body = authedPost(ts, tunnel.InternalNotifyAckPath, token, `{"watermark":99}`)
	if resp == nil || resp.StatusCode != http.StatusConflict {
		t.Fatalf("ACK beyond durable head: want 409, got %v %q", resp, body)
	}

	// Negative watermark: 400.
	resp, _ = authedPost(ts, tunnel.InternalNotifyAckPath, token, `{"watermark":-1}`)
	if resp == nil || resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("negative ACK: want 400, got %v", resp)
	}

	// Coherent trim: the feed no longer serves the consumed prefix, and the
	// source metadata carries the accounting.
	resp, body = authedGet(ts, tunnel.InternalNotifyFeedPath, token)
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("post-ACK feed: %v", resp)
	}
	var page struct {
		Source struct {
			FirstSeq   int64 `json:"firstSeq"`
			LastSeq    int64 `json:"lastSeq"`
			AckedSeq   int64 `json:"ackedSeq"`
			AckedTrim  int64 `json:"ackedTrim"`
			DurableSeq int64 `json:"durableSeq"`
		} `json:"source"`
		Records []struct {
			Seq int64 `json:"seq"`
		} `json:"records"`
	}
	if err := json.Unmarshal([]byte(body), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Records) != 2 || page.Records[0].Seq != 3 {
		t.Fatalf("consumed prefix must be trimmed from the feed: %+v", page.Records)
	}
	if page.Source.FirstSeq != 3 || page.Source.AckedSeq != 2 || page.Source.AckedTrim != 2 {
		t.Fatalf("trim accounting mismatch: %+v", page.Source)
	}
}

// --- the enrollment provider ---

func TestInternalNotifyEnrollmentProvider(t *testing.T) {
	srv, eng, token, stateDir := newInternalNotifyTestServer(t, true)
	n := srv.NotifyEnrollment()
	if n == nil {
		t.Fatal("armed server must advertise an enrollment")
	}
	spool := eng.Source()
	if n.SourceID != spool.SourceID() || n.SourceID != "worker-x" {
		t.Fatalf("enrollment source identity mismatch: %+v", n)
	}
	if n.Epoch != spool.Epoch() || n.Epoch == "" {
		t.Fatalf("enrollment must carry the CURRENT spool epoch, got %q", n.Epoch)
	}
	if n.NotifyCap != 1 {
		t.Fatalf("cap 1 (private feed + ACK), got %d", n.NotifyCap)
	}
	if n.Token != token {
		t.Fatal("enrollment token must equal the armed private-surface token")
	}
	if n.Mode != alerts.OwnershipModeController || !n.Fenced {
		t.Fatalf("controller-mode enrollment must report fenced ownership: %+v", n)
	}
	// Pre-transfer: the persisted watermark is null (OwnershipState.Watermark
	// is *int64) — the provider must carry that honestly, not invent a 0.
	if n.Watermark != nil {
		t.Fatalf("pre-transfer watermark must be nil, got %d", *n.Watermark)
	}

	// Plant a durable watermark (the S3/S4 transfer outcome) in the
	// persisted ownership state; the provider reads it LIVE — no restart,
	// each (re)connect advertises the current handshake state.
	wm := int64(1234)
	if err := os.WriteFile(filepath.Join(stateDir, "notify-ownership.json"),
		[]byte(fmt.Sprintf(`{"mode":"controller","fenced_at":1,"watermark":%d}`, wm)), 0o600); err != nil {
		t.Fatal(err)
	}
	n = srv.NotifyEnrollment()
	if n.Watermark == nil || *n.Watermark != wm {
		t.Fatalf("planted watermark must flow into the enrollment, got %+v", n.Watermark)
	}

	// Standalone launch (no controller URL, fresh state): mode/fence follow
	// the PERSISTED ownership state — standalone and unfenced here.
	srv2, _, token2, _ := newInternalNotifyTestServer(t, false)
	n2 := srv2.NotifyEnrollment()
	if n2 == nil || n2.Token != token2 {
		t.Fatal("standalone-mode server still arms the surface with its own token")
	}
	if n2.Fenced {
		t.Fatalf("a fresh standalone state dir must not report fenced, got %+v", n2)
	}
	if n2.Mode != alerts.OwnershipModeStandalone {
		t.Fatalf("standalone enrollment mode mismatch: %+v", n2)
	}
}

func TestNewInternalNotifyTokenShape(t *testing.T) {
	tok := NewInternalNotifyToken()
	if len(tok) != 64 {
		t.Fatalf("token is 32 crypto/rand bytes hex-encoded, got len %d", len(tok))
	}
	for _, c := range tok {
		if !strings.ContainsRune("0123456789abcdef", c) {
			t.Fatalf("token must be hex, got %q", tok)
		}
	}
	a, b := NewInternalNotifyToken(), NewInternalNotifyToken()
	if a == b {
		t.Fatal("tokens must be unique per mint")
	}
	// The enrollment validator accepts it (the constructor-side contract).
	if err := (&tunnel.NotifyEnrollment{SourceID: "w", Epoch: "e", NotifyCap: 1, Token: tok}).Validate(); err != nil {
		t.Fatalf("minted token must pass enrollment validation: %v", err)
	}
}

// The DEFER F1 epoch-label assertion at the surface that renders it: after a
// parseable-but-invalid spool document forces replacement, the coverage gap
// is LABELED with the departed epoch (prevEpoch), not the fresh one — the
// discontinuity stays centrally attributable.
func TestInternalNotifyCoverageLabelsDepartedEpoch(t *testing.T) {
	stateDir := t.TempDir()
	// Plant a parseable-but-invalid document under a KNOWN epoch (duplicate
	// seqs — damaged, not written by this code).
	doc := `{"epoch":"departed-era","lastSeq":3,"firstSeq":1,` +
		`"records":[{"seq":1,"type":"finished","ts":1},{"seq":1,"type":"finished","ts":2}]}`
	if err := os.WriteFile(filepath.Join(stateDir, "notify-source.json"), []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}

	// Minimal engine carrying the reloaded spool (the coverage surface reads
	// only the engine's source and the worker id).
	store, err := alerts.NewStore(filepath.Join(stateDir, "alerts.jsonc"))
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	presence := alerts.NewPresence()
	eng := alerts.NewEngine(store, presence, alerts.NewDispatcher(store, presence))
	spool := alerts.NewSourceSpool(stateDir, "worker-x", 0)
	eng.SetSource(spool)
	f := notifyFeature{engine: eng, workerID: "worker-x"}

	if spool.PrevEpoch() != "departed-era" {
		t.Fatalf("replacement must name the departed epoch, got %q", spool.PrevEpoch())
	}
	cov := f.v4Coverage()
	if cov.Complete {
		t.Fatal("rotation discontinuity must degrade coverage")
	}
	found := false
	for _, g := range cov.Gaps {
		if g.FromSeq == 1 && g.ToSeq == 0 { // the empty-range rotation marker
			found = true
			if g.Epoch != "departed-era" {
				t.Fatalf("rotation gap must carry the DEPARTED epoch label, got %q", g.Epoch)
			}
			if g.SourceID != "worker-x" {
				t.Fatalf("gap source mismatch: %+v", g)
			}
		}
	}
	if !found {
		t.Fatalf("rotation discontinuity must name its empty-range gap: %+v", cov.Gaps)
	}
}

// The spool may be missing only when the engine was built without one; the
// handlers must answer 503 (never panic, never serve an empty-but-200 page).
func TestInternalNotifyNoSpoolAnswersUnavailable(t *testing.T) {
	t.Setenv("VH_STATE_DIR", t.TempDir())
	srv, err := NewServer(aggregator.New("http://127.0.0.1:1", 100), "http://127.0.0.1:1", 100)
	if err != nil {
		t.Fatal(err)
	}
	// Engine WITHOUT a durable source (the defensive posture), then arm the
	// surface against it.
	eng, err := srv.InitAlerts(t.Context(), AlertsOptions{WorkerID: "w"})
	if err != nil {
		t.Fatalf("InitAlerts: %v", err)
	}
	eng.SetSource(nil)
	token := NewInternalNotifyToken()
	srv.EnableInternalNotify(eng, token, false)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	resp, _ := authedGet(ts, tunnel.InternalNotifyFeedPath, token)
	if resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("feed with no spool must answer 503 after auth, got %v", resp)
	}
	resp, _ = authedPost(ts, tunnel.InternalNotifyAckPath, token, `{"watermark":1}`)
	if resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("ack with no spool must answer 503 after auth, got %v", resp)
	}
}

// --- B1: the empty-page cursor race at the HTTP surface ---

// TestInternalNotifyFeedEmptyPageNeverSkipsDurableAppend hammers the REAL
// serveFeed handler with cursor-following fetches while records are appended
// durably, and asserts the B1 invariant on EVERY response: an empty page
// parks nextSince at the cursor (never past a head an interleaved append
// advanced), a full page's nextSince is its last record's seq, and the whole
// run drains every durable record exactly once — no seq is skipped. The
// pre-B1 serveFeed composed FeedPage and DurableSeq as two separate spool
// critical sections and could answer records=[] + nextSince=N+1.
func TestInternalNotifyFeedEmptyPageNeverSkipsDurableAppend(t *testing.T) {
	srv, eng, token, _ := newInternalNotifyTestServer(t, true)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	const rounds = 400
	fetchOne := func(since int64) (recs []struct {
		Seq int64 `json:"seq"`
	}, next int64, ok bool) {
		resp, body := authedGet(ts, tunnel.InternalNotifyFeedPath+"?since_seq="+strconv.FormatInt(since, 10)+"&limit=500", token)
		if resp == nil || resp.StatusCode != http.StatusOK {
			t.Errorf("feed fetch since=%d: bad response %v %q", since, resp, body)
			return nil, 0, false
		}
		var page struct {
			Records []struct {
				Seq int64 `json:"seq"`
			} `json:"records"`
			NextSince int64 `json:"nextSince"`
		}
		if err := json.Unmarshal([]byte(body), &page); err != nil {
			t.Errorf("feed body since=%d: %v (%s)", since, err, body)
			return nil, 0, false
		}
		return page.Records, page.NextSince, true
	}

	stop := make(chan struct{})
	var wg sync.WaitGroup
	var mu sync.Mutex
	seen := make(map[int64]bool)

	wg.Add(1)
	go func() { // appender: durably lands seqs 1..rounds
		defer wg.Done()
		defer close(stop)
		for i := 0; i < rounds; i++ {
			if _, err := eng.Source().Append(alerts.Notice{
				Type: alerts.TypeFinished, SessionID: "ses", Title: "race", Ts: int64(1700000000000 + i),
			}, alerts.DetectionContext{Attended: true}); err != nil {
				t.Errorf("hammer Append %d: %v", i, err)
				return
			}
		}
	}()
	wg.Add(1)
	go func() { // fetcher: follows nextSince like the controller pull loop
		defer wg.Done()
		since := int64(0)
		for {
			recs, next, ok := fetchOne(since)
			if !ok {
				return
			}
			if len(recs) == 0 {
				// B1 crux: an empty page must park at the cursor the EMPTY
				// page was taken at — nextSince > since with an empty page
				// is exactly the skip shape (record next would never be
				// served by a subsequent seq>nextSince fetch).
				if next != since {
					t.Errorf("B1 SKIP SHAPE over HTTP: empty page with nextSince=%d > since=%d", next, since)
					return
				}
			} else {
				if last := recs[len(recs)-1].Seq; next != last {
					t.Errorf("full page cursor must be the last record %d, got %d", last, next)
					return
				}
				mu.Lock()
				for _, r := range recs {
					if r.Seq <= since {
						t.Errorf("record %d not strictly above cursor %d", r.Seq, since)
						mu.Unlock()
						return
					}
					seen[r.Seq] = true
				}
				mu.Unlock()
				since = next
			}
			select {
			case <-stop:
				// Final drain: everything durable must be reachable from
				// the LAST cursor the loop observed.
				for {
					recs, next, ok := fetchOne(since)
					if !ok {
						return
					}
					if len(recs) == 0 {
						if next != since {
							t.Errorf("final drain: empty page nextSince=%d since=%d", next, since)
						}
						return
					}
					mu.Lock()
					for _, r := range recs {
						seen[r.Seq] = true
					}
					mu.Unlock()
					since = next
				}
			default:
			}
		}
	}()
	wg.Wait()

	// Every durably appended seq was delivered exactly once — none skipped.
	for i := 1; i <= rounds; i++ {
		if !seen[int64(i)] {
			t.Fatalf("durable record %d was never delivered by the cursor-following fetcher (skipped)", i)
		}
	}
}

// --- B7 rider: the auth boundary under real session auth ---

// TestInternalNotifyBearerBoundaryWithSessionAuth pins the auth split when
// the worker edge carries REAL passphrase session auth: the private notify
// surface authenticates by BEARRIER alone (the controller's fetch carries no
// cookie — valid bearer succeeds without any session; wrong/missing bearer
// gets the plain 404), while an adjacent session-gated /vh/* route keeps
// requiring browser auth (the /vh/internal/notify/ session exemption leaks
// NOWHERE else).
func TestInternalNotifyBearerBoundaryWithSessionAuth(t *testing.T) {
	srv, eng, token, _ := newInternalNotifyTestServer(t, true)
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	srv.SetAuth(a)
	feedAppendN(t, eng, 2)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	// (1) Valid bearer WITHOUT any session cookie: the feed serves and the
	// ACK mutates — the session exemption for the prefix is what lets the
	// cookie-less controller fetch through, and the bearer check is the
	// authentication.
	resp, body := authedGet(ts, tunnel.InternalNotifyFeedPath, token)
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("bearer feed without session cookie: want 200, got %v %q", resp, body)
	}
	var page struct {
		Records []struct {
			Seq int64 `json:"seq"`
		} `json:"records"`
	}
	if err := json.Unmarshal([]byte(body), &page); err != nil || len(page.Records) != 2 {
		t.Fatalf("bearer feed body must carry the 2 records: err=%v body=%s", err, body)
	}
	resp, body = authedPost(ts, tunnel.InternalNotifyAckPath, token, `{"watermark":1}`)
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("bearer ACK without session cookie: want 200, got %v %q", resp, body)
	}

	// (2) Wrong / missing bearer: the SAME plain-404 denial shape as
	// without session auth (no session-leak shortcut around the bearer).
	for _, tok := range []string{"", strings.Repeat("x", 64)} {
		resp, body = authedGet(ts, tunnel.InternalNotifyFeedPath, tok)
		if resp == nil || resp.StatusCode != http.StatusNotFound || strings.Contains(body, "{") {
			t.Fatalf("GET feed bearer=%q: want plain 404, got %v %q", tok, resp, body)
		}
		resp, body = authedPost(ts, tunnel.InternalNotifyAckPath, tok, `{"watermark":1}`)
		if resp == nil || resp.StatusCode != http.StatusNotFound {
			t.Fatalf("POST ack bearer=%q: want plain 404, got %v %q", tok, resp, body)
		}
	}

	// (3) Adjacent protected path (/vh/diag/latency — a session-gated /vh/*
	// route): WITHOUT a session cookie it is still refused (401 — the
	// internal-notify exemption must not leak); WITH a real session cookie
	// it serves. No bearer exemption applies outside the private prefix.
	resp, _ = authedGet(ts, "/vh/diag/latency", token)
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("adjacent protected path without session: want 401 (no exemption leakage), got %v", resp)
	}

	loginClient := &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	lresp, err := loginClient.PostForm(ts.URL+"/auth/login", map[string][]string{"passphrase": {"secret"}})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	defer lresp.Body.Close()
	var session *http.Cookie
	for _, c := range lresp.Cookies() {
		if c.Name == "vh_session" && c.Value != "" {
			session = c
		}
	}
	if session == nil {
		t.Fatal("login must set a vh_session cookie")
	}
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/vh/diag/latency", nil)
	req.AddCookie(session)
	dresp, err := http.DefaultClient.Do(req)
	if err != nil || dresp.StatusCode != http.StatusOK {
		t.Fatalf("adjacent protected path WITH session: want 200, got %v err=%v", dresp, err)
	}
	dresp.Body.Close()

	// And the session cookie grants NOTHING on the private surface: a
	// cookie-only feed fetch (no bearer) still gets the plain 404.
	req, _ = http.NewRequest(http.MethodGet, ts.URL+tunnel.InternalNotifyFeedPath, nil)
	req.AddCookie(session)
	cresp, err := http.DefaultClient.Do(req)
	if err != nil || cresp.StatusCode != http.StatusNotFound {
		t.Fatalf("session cookie without bearer must not open the private feed, got %v err=%v", cresp, err)
	}
	cresp.Body.Close()
}
