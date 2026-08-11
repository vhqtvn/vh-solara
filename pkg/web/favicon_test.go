package web

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// newFaviconTestServer builds a Server (hostShellAtRoot = NewServer default =
// true) with the given dist (single-server) and host embed FSes, returning
// both so the fold switch can be toggled for the legacy-mode case. Mirrors
// newStaticTestServer (static_test.go) / newCSPTestServer (csp_route_test.go).
func newFaviconTestServer(t *testing.T, distFS, hostFS fstest.MapFS) (*Server, *httptest.Server) {
	t.Helper()
	agg := aggregator.New("http://127.0.0.1:1", 100) // not started; static serving needs no opencode
	srv, err := NewServer(agg, "http://127.0.0.1:1", 1000)
	if err != nil {
		t.Fatal(err)
	}
	srv.staticFS = distFS
	// Rebuild the FileServer over the swapped FS so the favicon's
	// delegated FileServer serves from the test FS (serveFavicon delegates to
	// srv.static / srv.hostStatic). Without this, staticFS and static would
	// disagree after the swap (same reason newStaticTestServer rebuilds it).
	srv.static = http.FileServer(http.FS(distFS))
	srv.hostFS = hostFS
	srv.hostStatic = http.FileServer(http.FS(hostFS))
	return srv, httptest.NewServer(srv.Handler())
}

// TestFaviconRoute pins handleStatic's `/favicon.ico` disposition across the
// fold switch and the cold-build (placeholder-only) state:
//   - production (hostShellAtRoot): `/favicon.ico` serves the HOST icon.svg
//     (the shell that owns `/`), NOT the host index HTML;
//   - legacy/test (hostShellAtRoot=false): it serves the single-server
//     icon.svg (the shell that owns `/` in that mode);
//   - cold-build (icon absent from the embed): the delegated FileServer
//     returns 404 — NOT the SPA index HTML (the pre-fix fallthrough behavior),
//     proving no compile dependency on a built bundle was introduced.
//
// Browsers auto-request `/favicon.ico` for any page regardless of
// <link rel="icon">; this route makes it resolve to a real icon instead of
// falling through to the SPA index HTML (which a browser cannot use as an
// icon). See server.go serveFavicon.
func TestFaviconRoute(t *testing.T) {
	hostIcon := `<svg id="host-icon" xmlns="http://www.w3.org/2000/svg"></svg>`
	appIcon := `<svg id="app-icon" xmlns="http://www.w3.org/2000/svg"></svg>`
	hostIndex := "<!doctype html><html><head><title>VHSolara · Host</title></head>" +
		"<body><div id=\"root\"></div></body></html>"
	appIndex := "<!doctype html><html><head><title>VHSolara</title></head>" +
		"<body><div id=\"root\"></div></body></html>"

	t.Run("production_serves_host_icon", func(t *testing.T) {
		dist := fstest.MapFS{
			"index.html": {Data: []byte(appIndex)},
			"icon.svg":   {Data: []byte(appIcon)},
		}
		host := fstest.MapFS{
			"index.html": {Data: []byte(hostIndex)},
			"icon.svg":   {Data: []byte(hostIcon)},
		}
		_, ws := newFaviconTestServer(t, dist, host)
		defer ws.Close()
		// hostShellAtRoot is the NewServer default (true) — production posture.

		resp, err := http.Get(ws.URL + "/favicon.ico")
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		if string(body) != hostIcon {
			t.Errorf("/favicon.ico body = %q, want host icon %q (must NOT be the host index HTML)",
				string(body), hostIcon)
		}
	})

	t.Run("legacy_serves_single_server_icon", func(t *testing.T) {
		dist := fstest.MapFS{
			"index.html": {Data: []byte(appIndex)},
			"icon.svg":   {Data: []byte(appIcon)},
		}
		host := fstest.MapFS{
			"index.html": {Data: []byte(hostIndex)},
			"icon.svg":   {Data: []byte(hostIcon)},
		}
		srv, ws := newFaviconTestServer(t, dist, host)
		defer ws.Close()
		srv.SetHostShellAtRoot(false) // single-server SPA owns `/` (legacy/test)

		resp, err := http.Get(ws.URL + "/favicon.ico")
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		if string(body) != appIcon {
			t.Errorf("/favicon.ico body = %q, want single-server icon %q "+
				"(legacy mode: single-server owns `/`)", string(body), appIcon)
		}
	})

	t.Run("cold_build_404_when_icon_absent", func(t *testing.T) {
		// Placeholder-only embed: no icon.svg in either FS (cold `go build`
		// state). The favicon route must 404 (FileServer on a missing file)
		// rather than fall through to serve the SPA index HTML. The 404 here
		// is the proof that no compile dependency on a built bundle was added.
		dist := fstest.MapFS{"placeholder.html": {Data: []byte("app placeholder")}}
		host := fstest.MapFS{"placeholder.html": {Data: []byte("host placeholder")}}
		_, ws := newFaviconTestServer(t, dist, host)
		defer ws.Close()

		resp, err := http.Get(ws.URL + "/favicon.ico")
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("status = %d, want 404 (icon absent in cold-build; must NOT "+
				"fall through to the SPA index)", resp.StatusCode)
		}
		if strings.Contains(string(body), "<html") {
			t.Errorf("/favicon.ico returned HTML in cold-build (want a plain 404, "+
				"not the SPA index): %s", string(body))
		}
	})
}
