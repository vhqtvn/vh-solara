package web

import (
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// TestServesHostAndAppRoutes pins the folded dual-SPA routing on the REAL embed
// (cold build = both placeholders). `/` serves the HOST shell; `/app` serves the
// SINGLE-SERVER SPA. The two placeholders carry distinct <title> markers so the
// routing is asserted by WHICH shell was served, not just "an html page was
// served". The host placeholder title is "VHSolara · Host"; the single-server
// placeholder title is "VHSolara" (no "· Host" suffix).
func TestServesHostAndAppRoutes(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	// `/` → host shell (cold build: host placeholder).
	resp, err := http.Get(ws.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	html := string(body)
	if !strings.Contains(html, "<title>VHSolara · Host</title>") {
		t.Fatalf("`/` did not serve the host shell: %s", html)
	}

	// `/app` → single-server SPA (cold build: dist placeholder).
	resp2, err := http.Get(ws.URL + "/app")
	if err != nil {
		t.Fatal(err)
	}
	body2, _ := io.ReadAll(resp2.Body)
	resp2.Body.Close()
	html2 := string(body2)
	if !strings.Contains(html2, "<title>VHSolara</title>") {
		t.Fatalf("`/app` did not serve the single-server SPA: %s", html2)
	}
	// The host marker must NOT leak onto /app (it is a different shell).
	if strings.Contains(html2, "· Host") {
		t.Fatalf("`/app` leaked the host shell title: %s", html2)
	}

	// When a real host build is embedded (the hashed /host/assets/ bundle
	// reference is present), additionally assert the host mount point exists.
	// The host placeholder intentionally has no /host/assets/ or #root (it is a
	// static banner), so this only fires for a materialized host build.
	if strings.Contains(html, "/host/assets/") {
		if !strings.Contains(html, `<div id="root">`) {
			t.Fatalf("host shell missing #root mount point: %s", html)
		}
	}
}

// newStaticTestServer builds a Server whose dist (single-server) AND host embed
// FSes are overridden with the given test FSes, so handleStatic's
// index/placeholder preference and the dual routing can be exercised
// independently of the embed state (CI runs cold-build only, so the
// index-wins branch is otherwise never hit).
func newStaticTestServer(t *testing.T, distFS, hostFS fs.FS) *httptest.Server {
	t.Helper()
	agg := aggregator.New("http://127.0.0.1:1", 100) // not started; static serving needs no opencode
	srv, err := NewServer(agg, "http://127.0.0.1:1", 1000)
	if err != nil {
		t.Fatal(err)
	}
	srv.staticFS = distFS
	// Rebuild the FileServer over the swapped FS so static-asset requests in
	// tests serve from the test FS (handleStatic delegates real-asset paths to
	// srv.static). Without this, staticFS and static would disagree after swap.
	srv.static = http.FileServer(http.FS(distFS))
	srv.hostFS = hostFS
	srv.hostStatic = http.FileServer(http.FS(hostFS))
	return httptest.NewServer(srv.Handler())
}

// TestServesIndexOverPlaceholder pins handleStatic's index-preferred /
// placeholder-fallback contract for BOTH shells (server.go fallback paths). CI
// only ever runs in cold-build state where the placeholders alone are embedded,
// so without an injected FS the index-wins ordering is untested: a future edit
// that inverts the two ReadFile blocks would silently serve a "not built" banner
// in production with a real SPA embedded, and no unit test would catch it.
func TestServesIndexOverPlaceholder(t *testing.T) {
	// Real SPA shells carry the hashed bundle reference + #root mount point; the
	// placeholders are self-contained "not built" banners with neither.
	appIndex := "<!doctype html><html><head><title>VHSolara</title></head>" +
		"<body><div id=\"root\"></div>" +
		"<script src=\"/assets/app-abc123.js\"></script></body></html>"
	appPlaceholder := "<!doctype html><html><head><title>VHSolara</title></head>" +
		"<body>vh-solara web UI was not built.</body></html>"
	hostIndex := "<!doctype html><html><head><title>VHSolara · Host</title></head>" +
		"<body><div id=\"root\"></div>" +
		"<script src=\"/host/assets/host-xyz.js\"></script></body></html>"
	hostPlaceholder := "<!doctype html><html><head><title>VHSolara · Host</title></head>" +
		"<body>host shell was not built.</body></html>"

	tests := []struct {
		name        string
		dist        fstest.MapFS
		host        fstest.MapFS
		getPath     string
		wantContain []string
		notContain  []string
	}{
		{
			name: "single-server index wins when both present (served at /app)",
			dist: fstest.MapFS{
				"index.html":       {Data: []byte(appIndex)},
				"placeholder.html": {Data: []byte(appPlaceholder)},
			},
			host:        fstest.MapFS{"placeholder.html": {Data: []byte(hostPlaceholder)}},
			getPath:     "/app",
			wantContain: []string{"/assets/", `<div id="root">`},
			notContain:  []string{"not built"},
		},
		{
			name: "single-server placeholder served when index absent (at /app)",
			dist: fstest.MapFS{
				"placeholder.html": {Data: []byte(appPlaceholder)},
			},
			host:        fstest.MapFS{"placeholder.html": {Data: []byte(hostPlaceholder)}},
			getPath:     "/app",
			wantContain: []string{"web UI was not built"},
			notContain:  []string{"/assets/"},
		},
		{
			name: "host index wins when both present (served at /)",
			dist: fstest.MapFS{
				"placeholder.html": {Data: []byte(appPlaceholder)},
			},
			host: fstest.MapFS{
				"index.html":       {Data: []byte(hostIndex)},
				"placeholder.html": {Data: []byte(hostPlaceholder)},
			},
			getPath:     "/",
			wantContain: []string{"/host/assets/", `<div id="root">`},
			notContain:  []string{"not built"},
		},
		{
			name: "host placeholder served when index absent (at /)",
			dist: fstest.MapFS{
				"placeholder.html": {Data: []byte(appPlaceholder)},
			},
			host:        fstest.MapFS{"placeholder.html": {Data: []byte(hostPlaceholder)}},
			getPath:     "/",
			wantContain: []string{"host shell was not built"},
			notContain:  []string{"/host/assets/"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ws := newStaticTestServer(t, tc.dist, tc.host)
			defer ws.Close()

			resp, err := http.Get(ws.URL + tc.getPath)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200", resp.StatusCode)
			}
			if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
				t.Fatalf("Content-Type = %q, want text/html prefix", ct)
			}
			html := string(body)
			for _, want := range tc.wantContain {
				if !strings.Contains(html, want) {
					t.Errorf("body missing %q: %s", want, html)
				}
			}
			for _, notWant := range tc.notContain {
				if strings.Contains(html, notWant) {
					t.Errorf("body unexpectedly contains %q: %s", notWant, html)
				}
			}
		})
	}
}

// TestStaticServesKnownAssetAndRouting locks handleStatic's asset + routing
// branches:
//   - a single-server root asset path (`/assets/app.js`) is served by the dist
//     FileServer;
//   - a host namespaced asset path (`/host/assets/host.js`) is served by the host
//     FileServer (prefix-stripped);
//   - an unknown root path (`/session/whatever`) falls through to the HOST shell
//     (host is the default at `/`);
//   - an unknown `/app/*` path falls through to the SINGLE-SERVER SPA index
//     (SPA-history fallback for the single-server's mount point).
//
// The lazy path sets (knownStatic / knownHostStatic) are the existence probes,
// so this also pins that a real asset path is recognized by the map lookup.
func TestStaticServesKnownAssetAndRouting(t *testing.T) {
	appIndex := "<!doctype html><html><head><title>VHSolara</title></head>" +
		"<body><div id=\"root\"></div></body></html>"
	hostIndex := "<!doctype html><html><head><title>VHSolara · Host</title></head>" +
		"<body><div id=\"root\"></div></body></html>"
	asset := "// app asset body abc"
	hostAsset := "// host asset body xyz"
	dist := fstest.MapFS{
		"index.html":    {Data: []byte(appIndex)},
		"assets/app.js": {Data: []byte(asset)},
	}
	host := fstest.MapFS{
		"index.html":     {Data: []byte(hostIndex)},
		"assets/host.js": {Data: []byte(hostAsset)},
	}
	ws := newStaticTestServer(t, dist, host)
	defer ws.Close()

	// Known single-server asset at root `/assets/app.js` → dist FileServer.
	resp, err := http.Get(ws.URL + "/assets/app.js")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("single-server asset status = %d, want 200", resp.StatusCode)
	}
	if string(body) != asset {
		t.Errorf("single-server asset body = %q, want %q", string(body), asset)
	}

	// Known host asset at `/host/assets/host.js` → host FileServer.
	respH, err := http.Get(ws.URL + "/host/assets/host.js")
	if err != nil {
		t.Fatal(err)
	}
	bodyH, _ := io.ReadAll(respH.Body)
	respH.Body.Close()
	if respH.StatusCode != http.StatusOK {
		t.Fatalf("host asset status = %d, want 200", respH.StatusCode)
	}
	if string(bodyH) != hostAsset {
		t.Errorf("host asset body = %q, want %q", string(bodyH), hostAsset)
	}

	// Unknown root path → HOST index (host is the default at `/`).
	resp3, err := http.Get(ws.URL + "/session/whatever")
	if err != nil {
		t.Fatal(err)
	}
	body3, _ := io.ReadAll(resp3.Body)
	resp3.Body.Close()
	if resp3.StatusCode != http.StatusOK {
		t.Fatalf("fallback status = %d, want 200", resp3.StatusCode)
	}
	if !strings.Contains(string(body3), "VHSolara · Host") {
		t.Errorf("unknown root path did not fall through to host index: %s", body3)
	}

	// Unknown `/app/*` path → SINGLE-SERVER index (SPA fallback for /app/*).
	resp4, err := http.Get(ws.URL + "/app/session/whatever")
	if err != nil {
		t.Fatal(err)
	}
	body4, _ := io.ReadAll(resp4.Body)
	resp4.Body.Close()
	if resp4.StatusCode != http.StatusOK {
		t.Fatalf("/app fallback status = %d, want 200", resp4.StatusCode)
	}
	if !strings.Contains(string(body4), `<div id="root">`) {
		t.Errorf("/app/* fallback did not serve single-server index: %s", body4)
	}
	if strings.Contains(string(body4), "· Host") {
		t.Errorf("/app/* fallback leaked host shell: %s", body4)
	}
}
