package e2e

// notify_history_read_e2e_test.go — lane-3 proof for the global history
// read cursor (Slice 2 of
// tmp/agent-runs/android-push-20260928/stream-readstate-brief.md):
// POST /vh/notify/history/read + the history GET echo, through the real
// controller edge with REAL passphrase session auth.
//
// The scenario is the cross-device story the slice exists for: a
// phone-like client POSTs the read cursor, and a watch-like client (a
// second, later GET with no CSRF — reads are exempt) learns the SHARED
// cursor+unread state from the history envelope. Both requests are
// issued with the WORKER-SUBDOMAIN Host header: the /vh/notify/ prefix
// carve-out must keep them on the controller (a proxied request would
// die on the worker, which has no /vh/notify/ routes). The 401/403
// ladder runs over real HTTP (auth middleware + in-handler CSRF), and
// the acknowledged cursor is verified in the PERSISTED history file.
//
// No FCM/transport involvement (the ack path never touches the
// transport); the lane-1 suite (pkg/server/notify_history_test.go)
// pins the full decode/persistence/concurrency matrix.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// readStateView mirrors the read-ack and history envelopes (local copy
// so a wire drift breaks compilation, not silence).
type readStateView struct {
	Schema      int   `json:"schema"`
	ReadID      int64 `json:"read_id"`
	UnreadCount int64 `json:"unread_count"`
}

// e2eNotifyReq issues a cookie-authenticated request against the
// controller edge, optionally overriding the Host (worker-subdomain
// carve-out proof) and attaching the CSRF header.
func e2eNotifyReq(t *testing.T, c *Cluster, method, path, body string, host string, cookie *http.Cookie, csrf bool) (*http.Response, []byte) {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, c.ControllerURL+path, r)
	if err != nil {
		t.Fatal(err)
	}
	if host != "" {
		req.Host = host
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	if csrf {
		req.Header.Set("X-VH-CSRF", "1")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

// e2eLogin performs the real passphrase login flow and returns the
// vh_session cookie. The client refuses to follow the 303 so the
// Set-Cookie on the redirect itself is observed.
func e2eLogin(t *testing.T, c *Cluster, passphrase string) *http.Cookie {
	t.Helper()
	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := noRedirect.PostForm(c.ControllerURL+"/auth/login", url.Values{"passphrase": {passphrase}})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("login: want 303, got %d", resp.StatusCode)
	}
	for _, ck := range resp.Cookies() {
		if ck.Name == "vh_session" && ck.Value != "" {
			return ck
		}
	}
	t.Fatal("login: no vh_session cookie set")
	return nil
}

// TestE2E_NotifyHistoryReadSharedCursor is the lane-3 crux: the read
// advance + echo through the real handler chain (auth middleware →
// userMux → holder) under the worker-subdomain Host, and the shared
// cursor visible to a second device through the history GET.
func TestE2E_NotifyHistoryReadSharedCursor(t *testing.T) {
	c, err := StartClusterWithOptions(WithHostPattern("$ID.stream.example"), WithPassphraseAuth("e2e-secret"))
	if err != nil {
		t.Fatalf("StartCluster: %v", err)
	}
	t.Cleanup(c.Close)
	workerHost := c.WorkerID + ".stream.example"

	// Seed a store + a 3-event history file, then install both on the
	// running controller (holder state is read per request).
	dir := t.TempDir()
	storePath := filepath.Join(dir, "notify-tokens.json")
	if err := os.WriteFile(storePath, []byte(`{"schema":1,"tokens":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	histPath := storePath + ".history"
	events := `{"id":1,"ts":"2026-09-28T00:00:00Z","kind":"permission_pending","action":"appeared","count":2,"title":"vh-solara","body":"2 permissions pending","deliveries":[]},{"id":2,"ts":"2026-09-28T00:01:00Z","kind":"worker_down","action":"appeared","count":1,"title":"vh-solara","body":"1 worker down","deliveries":[]},{"id":3,"ts":"2026-09-28T00:02:00Z","kind":"worker_down","action":"cleared","count":0,"title":"vh-solara","body":"1 worker down (cleared)","deliveries":[]}`
	if err := os.WriteFile(histPath, []byte(fmt.Sprintf("{\"schema\":1,\"events\":[%s]}\n", events)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := c.Daemon.LoadNotifyStore(storePath); err != nil {
		t.Fatalf("LoadNotifyStore: %v", err)
	}

	// Auth ladder over real HTTP (API-class /vh/* → clean 401).
	resp, body := e2eNotifyReq(t, c, http.MethodGet, "/vh/notify/history", "", workerHost, nil, false)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated history GET: want 401, got %d: %s", resp.StatusCode, body)
	}
	resp, body = e2eNotifyReq(t, c, http.MethodPost, "/vh/notify/history/read", `{"id":2}`, workerHost, nil, true)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated read POST: want 401, got %d: %s", resp.StatusCode, body)
	}

	// Login; then the CSRF gate fires BEFORE anything else in-handler.
	session := e2eLogin(t, c, "e2e-secret")
	resp, body = e2eNotifyReq(t, c, http.MethodPost, "/vh/notify/history/read", `{"id":2}`, workerHost, session, false)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("read POST without CSRF: want 403, got %d: %s", resp.StatusCode, body)
	}

	// Phone acks read-through 2 — under the WORKER-SUBDOMAIN Host (the
	// prefix carve-out keeps it on the controller).
	resp, body = e2eNotifyReq(t, c, http.MethodPost, "/vh/notify/history/read", `{"id":2}`, workerHost, session, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("phone ack: want 200, got %d: %s", resp.StatusCode, body)
	}
	var ack readStateView
	if err := json.Unmarshal(body, &ack); err != nil {
		t.Fatalf("ack body: %v (%s)", err, body)
	}
	if ack.Schema != 1 || ack.ReadID != 2 || ack.UnreadCount != 1 {
		t.Fatalf("ack echo: %+v, want read_id=2 unread=1", ack)
	}

	// Watch-like second device: plain history GET (no CSRF — reads are
	// exempt) sees the SHARED cursor and count.
	resp, body = e2eNotifyReq(t, c, http.MethodGet, "/vh/notify/history", "", workerHost, session, false)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("watch history GET: want 200, got %d: %s", resp.StatusCode, body)
	}
	var hist struct {
		readStateView
		Events []struct {
			ID int64 `json:"id"`
		} `json:"events"`
		FirstID int64 `json:"first_id"`
		LastID  int64 `json:"last_id"`
	}
	if err := json.Unmarshal(body, &hist); err != nil {
		t.Fatalf("history body: %v (%s)", err, body)
	}
	if hist.ReadID != 2 || hist.UnreadCount != 1 || len(hist.Events) != 3 || hist.FirstID != 1 || hist.LastID != 3 {
		t.Fatalf("history echo: read_id=%d unread=%d events=%d first=%d last=%d",
			hist.ReadID, hist.UnreadCount, len(hist.Events), hist.FirstID, hist.LastID)
	}

	// Stale replay from the phone: 200 no-op, state unchanged.
	resp, body = e2eNotifyReq(t, c, http.MethodPost, "/vh/notify/history/read", `{"id":1}`, workerHost, session, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("stale replay: want 200, got %d: %s", resp.StatusCode, body)
	}
	if err := json.Unmarshal(body, &ack); err != nil || ack.ReadID != 2 || ack.UnreadCount != 1 {
		t.Fatalf("stale replay echo: %+v (%v)", ack, err)
	}

	// Future id: 400 naming the newest retained id.
	resp, body = e2eNotifyReq(t, c, http.MethodPost, "/vh/notify/history/read", `{"id":99}`, workerHost, session, true)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("future id: want 400, got %d: %s", resp.StatusCode, body)
	}
	if !strings.Contains(string(body), "newest event id 3") {
		t.Fatalf("future id refusal must name the newest id: %s", body)
	}

	// The acknowledged cursor is durably persisted in the history file
	// (the same atomic write that carries the retained events).
	persisted, err := os.ReadFile(histPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(persisted), `"read_id": 2`) {
		t.Fatalf("persisted history must carry read_id 2, got: %s", persisted)
	}
}
