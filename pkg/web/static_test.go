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

func TestServesEmbeddedSPA(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	// Root serves embedded index.html (the real SPA shell, when an
	// embed-producing target materialized a `make web` build into pkg/web/dist)
	// or the self-contained fallback placeholder.html (cold build with NO
	// frontend build). <title>VHSolara</title> is present in both, so it is the
	// stable marker for "an html shell was served".
	resp, err := http.Get(ws.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	html := string(body)
	if !strings.Contains(html, "<title>VHSolara</title>") {
		t.Fatalf("root did not serve index.html: %s", html)
	}

	// Unknown client-route falls back to index.html (SPA routing) for both the
	// real shell and the placeholder.
	resp2, err := http.Get(ws.URL + "/session/anything")
	if err != nil {
		t.Fatal(err)
	}
	body2, _ := io.ReadAll(resp2.Body)
	resp2.Body.Close()
	if !strings.Contains(string(body2), "<title>VHSolara</title>") {
		t.Fatalf("SPA fallback failed for client route: %s", body2)
	}

	// When a real SPA build is embedded (the hashed /assets/ bundle reference is
	// present), additionally assert the SPA mount point exists. The fallback
	// placeholder intentionally has no /assets/ or #root (it is a static banner).
	if strings.Contains(html, "/assets/") {
		if !strings.Contains(html, `<div id="root">`) {
			t.Fatalf("SPA shell missing #root mount point: %s", html)
		}
	}
}

// newStaticTestServer builds a Server whose staticFS is overridden with the
// given test FS, so handleStatic's index/placeholder preference can be
// exercised independently of the embed state (CI runs cold-build only, so the
// index-wins branch is otherwise never hit).
func newStaticTestServer(t *testing.T, staticFS fs.FS) *httptest.Server {
	t.Helper()
	agg := aggregator.New("http://127.0.0.1:1", 100) // not started; static serving needs no opencode
	srv, err := NewServer(agg, "http://127.0.0.1:1", 1000)
	if err != nil {
		t.Fatal(err)
	}
	srv.staticFS = staticFS
	return httptest.NewServer(srv.Handler())
}

// TestServesIndexOverPlaceholder pins handleStatic's index-preferred /
// placeholder-fallback contract (server.go fallback path). CI only ever runs
// in cold-build state where placeholder.html alone is embedded, so without an
// injected FS the index-wins ordering is untested: a future edit that inverts
// the two ReadFile blocks would silently serve the "not built" banner in
// production with a real SPA embedded, and no unit test would catch it.
func TestServesIndexOverPlaceholder(t *testing.T) {
	// A real SPA shell carries the hashed /assets/ bundle reference and the
	// #root mount point; the placeholder is a self-contained "not built" banner
	// with neither (see TestPlaceholderSelfContained).
	indexHTML := "<!doctype html><html><head><title>VHSolara</title></head>" +
		"<body><div id=\"root\"></div>" +
		"<script src=\"/assets/app-abc123.js\"></script></body></html>"
	placeholderHTML := "<!doctype html><html><head><title>VHSolara</title></head>" +
		"<body>vh-solara web UI was not built. Run `make web`.</body></html>"

	tests := []struct {
		name        string
		fs          fstest.MapFS
		wantContain []string
		notContain  []string
	}{
		{
			name: "index wins when both index and placeholder present",
			fs: fstest.MapFS{
				"index.html":       {Data: []byte(indexHTML)},
				"placeholder.html": {Data: []byte(placeholderHTML)},
			},
			wantContain: []string{"/assets/", `<div id="root">`},
			notContain:  []string{"not built"},
		},
		{
			name: "placeholder served when index absent",
			fs: fstest.MapFS{
				"placeholder.html": {Data: []byte(placeholderHTML)},
			},
			wantContain: []string{"not built"},
			notContain:  []string{"/assets/"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ws := newStaticTestServer(t, tc.fs)
			defer ws.Close()

			resp, err := http.Get(ws.URL + "/")
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
