package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/auth"
)

// TestDiagBusyRouteAuthChainWorker pins the security boundary for the
// /vh/diag/busy diagnostic route, mirroring TestDiagLatencyRouteAuthChainWorker.
// Proves through the pkg/web chain (securityHeaders → auth → cors → csrfGuard →
// … → mux):
//
//   - an UNAUTHENTICATED GET is rejected (401: /vh/* is an API request path);
//   - an AUTHENTICATED GET returns 200 with a JSON diagnostic snapshot;
//   - an unsafe POST WITHOUT X-VH-CSRF is stopped by csrfGuard (403);
//   - an unsafe POST WITH X-VH-CSRF still reaches handleDiagBusy's own method
//     guard and is rejected with 405 — the route is read-only at the handler
//     level too (defense in depth) — and the 405 advertises Allow: GET, HEAD
//     (RFC 7231);
//   - an AUTHENTICATED HEAD returns 200 (the handler allows GET+HEAD);
//   - /vh/healthz remains the ONLY auth exemption on the edge.
//
// This test FAILS if /vh/diag/busy is accidentally mounted outside auth or
// starts accepting mutations.
func TestDiagBusyRouteAuthChainWorker(t *testing.T) {
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	// Install REAL passphrase auth so Auth.Middleware actually gates — proving
	// the route is reachable only through the authenticated chain rather than a
	// nil/ModeNone no-op pass-through.
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	srv.SetAuth(a)
	h := srv.Handler()

	// Perform the passphrase login flow and return the vh_session cookie.
	session := func() *http.Cookie {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader("passphrase=secret"))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusSeeOther {
			t.Fatalf("login: want 303, got %d (body=%q)", rec.Code, rec.Body.String())
		}
		for _, c := range rec.Result().Cookies() {
			if c.Name == "vh_session" && c.Value != "" {
				return c
			}
		}
		t.Fatal("login: no vh_session cookie set")
		return nil
	}()

	// 1. Unauthenticated GET → rejected (401: /vh/* is an API request path).
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/diag/busy", nil)
	h.ServeHTTP(rec, req)
	if rec.Code == http.StatusOK {
		t.Fatalf("unauthenticated GET /vh/diag/busy: want rejection (not 200), got 200 — route is mounted OUTSIDE auth")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET /vh/diag/busy: want 401 (API path challenge), got %d", rec.Code)
	}

	// 2. Authenticated GET → 200 JSON snapshot.
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodGet, "/vh/diag/busy", nil)
	req2.AddCookie(session)
	h.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("authenticated GET /vh/diag/busy: want 200, got %d (body=%q)", rec2.Code, rec2.Body.String())
	}
	if ct := rec2.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("authenticated GET /vh/diag/busy: want Content-Type application/json, got %q", ct)
	}
	var snap diagBusyResp
	if err := json.Unmarshal(rec2.Body.Bytes(), &snap); err != nil {
		t.Fatalf("authenticated GET /vh/diag/busy: body is not valid JSON: %v (body=%q)", err, rec2.Body.String())
	}
	// An empty fleet (no sessions seeded) must report 0 running roots and a
	// non-nil workspaces slice (the default "" workspace is always present).
	if snap.RunningRoots != 0 {
		t.Fatalf("authenticated GET /vh/diag/busy: empty fleet runningRoots want 0, got %d", snap.RunningRoots)
	}

	// 3a. Unsafe POST WITHOUT X-VH-CSRF → 403 (csrfGuard defense).
	rec3 := httptest.NewRecorder()
	req3 := httptest.NewRequest(http.MethodPost, "/vh/diag/busy", nil)
	req3.AddCookie(session)
	h.ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusForbidden {
		t.Fatalf("authenticated POST /vh/diag/busy without %s: want 403 (csrfGuard), got %d (body=%q)",
			csrfHeader, rec3.Code, rec3.Body.String())
	}

	// 3b. Unsafe POST WITH X-VH-CSRF → 405 (handler-level method guard). The
	// CSRF header lets the request past csrfGuard so handleDiagBusy's own
	// GET/HEAD-only check fires — proving read-only enforcement at the handler
	// level too (defense in depth).
	rec4 := httptest.NewRecorder()
	req4 := httptest.NewRequest(http.MethodPost, "/vh/diag/busy", nil)
	req4.AddCookie(session)
	req4.Header.Set(csrfHeader, "1")
	h.ServeHTTP(rec4, req4)
	if rec4.Code != http.StatusMethodNotAllowed {
		t.Fatalf("authenticated POST /vh/diag/busy with %s: want 405 (handler-level GET/HEAD-only), got %d (body=%q)",
			csrfHeader, rec4.Code, rec4.Body.String())
	}
	// 3c. The 405 from the handler-level method guard must advertise the
	// allowed methods (RFC 7231 Allow: GET, HEAD) so well-behaved clients can
	// adapt and so a future tightening/drop is caught here.
	if allow := rec4.Result().Header.Get("Allow"); allow != "GET, HEAD" {
		t.Fatalf("405 POST /vh/diag/busy: Allow header want %q, got %q", "GET, HEAD", allow)
	}
	// 3d. Authenticated HEAD /vh/diag/busy → 200. The handler allows GET+HEAD;
	// pin HEAD so a future accidental narrowing to GET-only is caught.
	recHead := httptest.NewRecorder()
	reqHead := httptest.NewRequest(http.MethodHead, "/vh/diag/busy", nil)
	reqHead.AddCookie(session)
	h.ServeHTTP(recHead, reqHead)
	if recHead.Code != http.StatusOK {
		t.Fatalf("authenticated HEAD /vh/diag/busy: want 200, got %d (body=%q)", recHead.Code, recHead.Body.String())
	}

	// 4. /vh/healthz remains the ONLY auth exemption: a credential-less GET
	// still answers 200.
	rec5 := httptest.NewRecorder()
	req5 := httptest.NewRequest(http.MethodGet, "/vh/healthz", nil)
	h.ServeHTTP(rec5, req5)
	if rec5.Code != http.StatusOK {
		t.Fatalf("GET /vh/healthz without credentials: want 200 (only auth exemption), got %d", rec5.Code)
	}
}

// TestDiagBusyReflectsBusyState seeds a busy root through the aggregator's
// store and asserts /vh/diag/busy surfaces it (runningRoots=1, the root's id in
// busyRootIds, and the session's subtreeBusy contribution). This proves the
// endpoint reads the SAME index RunningRoots derives from — so the running
// count and the diagnostic can never disagree.
func TestDiagBusyReflectsBusyState(t *testing.T) {
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	// Seed a busy root directly in the default workspace's store.
	for _, e := range busyEvents("diagroot") {
		srv.agg.Store().Apply(e)
	}

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)
	resp, err := http.Get(web.URL + "/vh/diag/busy")
	if err != nil {
		t.Fatalf("GET /vh/diag/busy: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /vh/diag/busy: want 200, got %d", resp.StatusCode)
	}
	var out diagBusyResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.RunningRoots != 1 {
		t.Fatalf("runningRoots want 1 (seeded busy root), got %d", out.RunningRoots)
	}
	// The default workspace ("") must carry the busy root + the session.
	var def *diagBusyWorkspace
	for i := range out.Workspaces {
		if out.Workspaces[i].Dir == "" {
			def = &out.Workspaces[i]
			break
		}
	}
	if def == nil {
		t.Fatalf("default workspace missing from diag/busy response: %+v", out.Workspaces)
	}
	if def.RunningRoots != 1 || len(def.BusyRootIDs) != 1 || def.BusyRootIDs[0] != "diagroot" {
		t.Fatalf("default workspace busy root mismatch: runningRoots=%d busyRootIds=%v", def.RunningRoots, def.BusyRootIDs)
	}
	// The seeded session must appear with subtreeBusy>=1 (it is a busy root).
	var sess *busyDiagSessionJSON
	for i := range def.Sessions {
		if def.Sessions[i].ID == "diagroot" {
			sess = &def.Sessions[i]
			break
		}
	}
	if sess == nil {
		t.Fatalf("seeded session diagroot missing from diag/busy sessions: %+v", def.Sessions)
	}
	if sess.Activity != "busy" || sess.SubtreeBusy < 1 {
		t.Fatalf("seeded session diagroot: want activity=busy subtreeBusy>=1, got %+v", sess)
	}
}
