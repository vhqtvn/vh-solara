package web

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strconv"
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
// The lazy asset maps (distAssetMeta / hostAssetMeta) are the existence probes,
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

// --- S1 static caching/compression matrix (perf slice 1) -------------------
//
// The contract under test (pkg/web serveStaticAsset):
//   - hashed build assets (assets/ prefix, either embed) → Cache-Control:
//     public, max-age=31536000, immutable;
//   - every other static → strong content-hash ETag + Cache-Control: no-cache;
//   - text statics ≥ 1 KiB are gzipped when the request offers gzip (Vary:
//     Accept-Encoding on both variants); identity otherwise; smaller/binary
//     files are never compressed;
//   - If-None-Match revalidation → 304 empty body.

// gzipTestBody builds a deterministic text body of roughly n bytes (repetitive
// text compresses well, like real minified JS).
func gzipTestBody(n int) []byte {
	line := []byte("// gzip matrix padding line — repeated to reach the size floor\n")
	var b []byte
	for len(b) < n {
		b = append(b, line...)
	}
	return b
}

// httpGetHeaders issues a GET with explicit request headers. Headers must be
// set explicitly for Accept-Encoding assertions: an implicit absence makes the
// stdlib transport add `Accept-Encoding: gzip` and transparently decompress.
func httpGetHeaders(t *testing.T, url string, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, body
}

// newCacheMatrixServer plants a representative embed pair: a hashed app bundle
// (>1 KiB, compressible), a hashed host bundle, a non-hashed sw.js (>1 KiB), a
// sub-threshold manifest, and a binary png.
func newCacheMatrixServer(t *testing.T) *httptest.Server {
	t.Helper()
	bigJS := gzipTestBody(2048)
	hostJS := gzipTestBody(1536)
	smallManifest := []byte(`{"name":"vh-solara","short_name":"vh"}`)
	png := append([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, make([]byte, 64)...)
	appIndex := "<!doctype html><html><head><title>VHSolara</title></head><body><div id=\"root\"></div></body></html>"
	hostIndex := "<!doctype html><html><head><title>VHSolara · Host</title></head><body><div id=\"root\"></div></body></html>"
	dist := fstest.MapFS{
		"index.html":             {Data: []byte(appIndex)},
		"sw.js":                  {Data: bigJS},
		"manifest.webmanifest":   {Data: smallManifest},
		"icon-192.png":           {Data: png},
		"assets/app-B3xV1zC4.js": {Data: bigJS},
		"assets/app-Qt7Lm2.css":  {Data: bigJS},
	}
	host := fstest.MapFS{
		"index.html":               {Data: []byte(hostIndex)},
		"icon.svg":                 {Data: []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)},
		"assets/host-Q9w8e7rT.js":  {Data: hostJS},
		"assets/host-Nb2mK5pL.css": {Data: hostJS},
	}
	return newStaticTestServer(t, dist, host)
}

// TestStaticCacheHeaders pins the Cache-Control split (immutable hashed vs
// ETag+no-cache non-hashed), ETag presence, and the gzip eligibility rules
// (text ≥ threshold, offered, actually smaller) across BOTH embeds.
func TestStaticCacheHeaders(t *testing.T) {
	ws := newCacheMatrixServer(t)
	defer ws.Close()

	gzipOK := map[string]string{"Accept-Encoding": "gzip"}
	identity := map[string]string{"Accept-Encoding": "identity"}

	tests := []struct {
		name        string
		path        string
		reqHeaders  map[string]string
		wantCC      string
		wantGzipped bool
	}{
		{name: "dist hashed js immutable+gzip", path: "/assets/app-B3xV1zC4.js", reqHeaders: gzipOK,
			wantCC: "public, max-age=31536000, immutable", wantGzipped: true},
		{name: "dist hashed css immutable+gzip", path: "/assets/app-Qt7Lm2.css", reqHeaders: gzipOK,
			wantCC: "public, max-age=31536000, immutable", wantGzipped: true},
		{name: "dist hashed js identity when not offered", path: "/assets/app-B3xV1zC4.js", reqHeaders: identity,
			wantCC: "public, max-age=31536000, immutable", wantGzipped: false},
		{name: "dist sw.js revalidate+gzip", path: "/sw.js", reqHeaders: gzipOK,
			wantCC: "no-cache", wantGzipped: true},
		{name: "dist manifest below threshold identity", path: "/manifest.webmanifest", reqHeaders: gzipOK,
			wantCC: "no-cache", wantGzipped: false},
		{name: "dist png binary identity", path: "/icon-192.png", reqHeaders: gzipOK,
			wantCC: "no-cache", wantGzipped: false},
		{name: "host hashed js immutable+gzip", path: "/host/assets/host-Q9w8e7rT.js", reqHeaders: gzipOK,
			wantCC: "public, max-age=31536000, immutable", wantGzipped: true},
		{name: "host hashed css immutable+gzip", path: "/host/assets/host-Nb2mK5pL.css", reqHeaders: gzipOK,
			wantCC: "public, max-age=31536000, immutable", wantGzipped: true},
		{name: "host icon.svg small identity", path: "/host/icon.svg", reqHeaders: gzipOK,
			wantCC: "no-cache", wantGzipped: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resp, body := httpGetHeaders(t, ws.URL+tc.path, tc.reqHeaders)
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200", resp.StatusCode)
			}
			if cc := resp.Header.Get("Cache-Control"); cc != tc.wantCC {
				t.Errorf("Cache-Control = %q, want %q", cc, tc.wantCC)
			}
			etag := resp.Header.Get("ETag")
			if len(etag) < 2 || etag[0] != '"' || etag[len(etag)-1] != '"' {
				t.Errorf("ETag = %q, want a quoted strong validator", etag)
			}
			ce := resp.Header.Get("Content-Encoding")
			if tc.wantGzipped {
				if ce != "gzip" {
					t.Fatalf("Content-Encoding = %q, want gzip", ce)
				}
				zr, err := gzip.NewReader(bytes.NewReader(body))
				if err != nil {
					t.Fatalf("gzip body undecodable: %v", err)
				}
				raw, err := io.ReadAll(zr)
				if err != nil {
					t.Fatalf("gzip body unreadable: %v", err)
				}
				if len(raw) < minGzipSize {
					t.Errorf("decompressed body = %d bytes, want >= %d (threshold class)", len(raw), minGzipSize)
				}
				if int64(len(body)) >= int64(len(raw)) {
					t.Errorf("gzipped body (%d bytes) did not shrink vs raw (%d bytes)", len(body), len(raw))
				}
				if cl := resp.Header.Get("Content-Length"); cl != strconv.Itoa(len(body)) {
					t.Errorf("Content-Length = %q, want %d (the gzip byte length)", cl, len(body))
				}
				if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/") && !strings.Contains(ct, "javascript") && !strings.Contains(ct, "json") && !strings.Contains(ct, "css") {
					t.Errorf("Content-Type = %q, want a text-ish type on the gzip path", ct)
				}
			} else if ce != "" {
				t.Fatalf("Content-Encoding = %q, want none", ce)
			}
			// Vary must be present exactly when the representation can vary
			// (gzip-eligible asset), on BOTH variants.
			vary := resp.Header.Values("Vary")
			hasAEVary := false
			for _, v := range vary {
				if strings.Contains(v, "Accept-Encoding") {
					hasAEVary = true
				}
			}
			eligible := tc.wantGzipped || (tc.reqHeaders["Accept-Encoding"] == "identity" && gzipEligiblePath(tc.path))
			if eligible && !hasAEVary {
				t.Errorf("Vary missing Accept-Encoding on a gzip-eligible asset: %v", vary)
			}
			if !eligible && hasAEVary {
				t.Errorf("Vary unexpectedly present on a non-eligible asset: %v", vary)
			}
		})
	}

	// Identity variant of an ELIGIBLE asset (explicit identity) must stay raw
	// and still carry Vary.
	resp, body := httpGetHeaders(t, ws.URL+"/sw.js", identity)
	if resp.Header.Get("Content-Encoding") != "" {
		t.Errorf("identity request got Content-Encoding %q", resp.Header.Get("Content-Encoding"))
	}
	if len(body) < minGzipSize {
		t.Errorf("identity body = %d bytes, want the raw file", len(body))
	}
	if !strings.Contains(strings.Join(resp.Header.Values("Vary"), ","), "Accept-Encoding") {
		t.Errorf("identity variant of gzip-eligible /sw.js missing Vary: Accept-Encoding")
	}
}

// gzipEligiblePath mirrors the eligibility rule for test-side expectations:
// text extension on a static path (the test fixtures make every text file
// here either ≥1 KiB or the sub-threshold manifest/host-icon cases).
func gzipEligiblePath(urlPath string) bool {
	trim := strings.TrimPrefix(urlPath, "/host/")
	trim = strings.TrimPrefix(trim, "/")
	switch {
	case strings.HasSuffix(trim, ".js"), strings.HasSuffix(trim, ".css"),
		strings.HasSuffix(trim, ".html"), strings.HasSuffix(trim, ".svg"),
		strings.HasSuffix(trim, ".json"), strings.HasSuffix(trim, ".webmanifest"),
		strings.HasSuffix(trim, ".txt"), strings.HasSuffix(trim, ".xml"), strings.HasSuffix(trim, ".map"):
		return true
	}
	return false
}

// TestStaticETagRevalidation pins the conditional-request semantics: a
// matching If-None-Match (exact, weak-prefixed, or wildcard) short-circuits to
// 304 with an empty body while keeping ETag + Cache-Control; a non-matching
// validator serves the full body. Covers both the revalidate class (sw.js)
// and the immutable class (hashed bundle) — immutable assets carry the same
// strong ETag so an expired-cache revalidation still 304s.
func TestStaticETagRevalidation(t *testing.T) {
	ws := newCacheMatrixServer(t)
	defer ws.Close()

	for _, path := range []string{"/sw.js", "/assets/app-B3xV1zC4.js", "/host/assets/host-Q9w8e7rT.js"} {
		t.Run(path, func(t *testing.T) {
			resp, _ := httpGetHeaders(t, ws.URL+path, nil)
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("initial GET status = %d", resp.StatusCode)
			}
			etag := resp.Header.Get("ETag")
			if etag == "" {
				t.Fatalf("initial GET missing ETag")
			}

			// Exact match → 304, empty body, validator + cache policy kept.
			r304, b304 := httpGetHeaders(t, ws.URL+path, map[string]string{"If-None-Match": etag})
			if r304.StatusCode != http.StatusNotModified {
				t.Fatalf("If-None-Match exact: status = %d, want 304", r304.StatusCode)
			}
			if len(b304) != 0 {
				t.Errorf("304 body = %d bytes, want empty", len(b304))
			}
			if r304.Header.Get("ETag") != etag {
				t.Errorf("304 ETag = %q, want %q", r304.Header.Get("ETag"), etag)
			}
			if r304.Header.Get("Cache-Control") == "" {
				t.Errorf("304 missing Cache-Control")
			}

			// Weak-prefixed form of the same validator still matches
			// (If-None-Match uses weak comparison).
			weak := `W/` + etag
			rw, _ := httpGetHeaders(t, ws.URL+path, map[string]string{"If-None-Match": weak})
			if rw.StatusCode != http.StatusNotModified {
				t.Errorf("If-None-Match weak: status = %d, want 304", rw.StatusCode)
			}

			// Wildcard matches any current representation.
			rstar, _ := httpGetHeaders(t, ws.URL+path, map[string]string{"If-None-Match": "*"})
			if rstar.StatusCode != http.StatusNotModified {
				t.Errorf("If-None-Match *: status = %d, want 304", rstar.StatusCode)
			}

			// A list containing the validator matches.
			elist := `"deadbeef"` + ", " + etag + `, "cafef00d"`
			rl, _ := httpGetHeaders(t, ws.URL+path, map[string]string{"If-None-Match": elist})
			if rl.StatusCode != http.StatusNotModified {
				t.Errorf("If-None-Match list: status = %d, want 304", rl.StatusCode)
			}

			// Non-matching validator → full 200 body.
			rmiss, bmiss := httpGetHeaders(t, ws.URL+path, map[string]string{"If-None-Match": `"00000000000000000000000000000000"`})
			if rmiss.StatusCode != http.StatusOK {
				t.Fatalf("If-None-Match miss: status = %d, want 200", rmiss.StatusCode)
			}
			if len(bmiss) == 0 {
				t.Errorf("If-None-Match miss returned an empty body")
			}
		})
	}
}

// TestStaticGzipNegotiation pins Accept-Encoding negotiation beyond the
// matrix's offered/identity pair: q=0 exclusion and an unrelated coding do not
// trigger gzip, and a Range request on an eligible asset falls back to the
// identity FileServer path (206, no Content-Encoding).
func TestStaticGzipNegotiation(t *testing.T) {
	ws := newCacheMatrixServer(t)
	defer ws.Close()

	t.Run("gzip q=0 is not accepted", func(t *testing.T) {
		resp, _ := httpGetHeaders(t, ws.URL+"/sw.js", map[string]string{"Accept-Encoding": "gzip;q=0, br"})
		if resp.Header.Get("Content-Encoding") != "" {
			t.Errorf("Content-Encoding = %q, want none (q=0 refuses gzip)", resp.Header.Get("Content-Encoding"))
		}
	})
	t.Run("explicit gzip q=0 overrides a wildcard offer", func(t *testing.T) {
		// RFC 9110 §12.5.3: "*" matches only codings NOT otherwise listed —
		// "gzip;q=0, *" must NOT count as offering gzip.
		resp, _ := httpGetHeaders(t, ws.URL+"/sw.js", map[string]string{"Accept-Encoding": "gzip;q=0, *;q=1"})
		if resp.Header.Get("Content-Encoding") != "" {
			t.Errorf("Content-Encoding = %q, want none (explicit gzip refusal beats the wildcard)",
				resp.Header.Get("Content-Encoding"))
		}
	})
	t.Run("empty Accept-Encoding stays identity", func(t *testing.T) {
		// Header explicitly set empty: the Go transport then does NOT inject
		// its own Accept-Encoding, so the server sees the absent-header case.
		resp, _ := httpGetHeaders(t, ws.URL+"/sw.js", map[string]string{"Accept-Encoding": ""})
		if resp.Header.Get("Content-Encoding") != "" {
			t.Errorf("Content-Encoding = %q, want none (no coding offered)", resp.Header.Get("Content-Encoding"))
		}
	})
	t.Run("deflate-only does not get gzip", func(t *testing.T) {
		resp, _ := httpGetHeaders(t, ws.URL+"/sw.js", map[string]string{"Accept-Encoding": "deflate"})
		if resp.Header.Get("Content-Encoding") != "" {
			t.Errorf("Content-Encoding = %q, want none (no gzip offered)", resp.Header.Get("Content-Encoding"))
		}
	})
	t.Run("star accepts gzip", func(t *testing.T) {
		resp, body := httpGetHeaders(t, ws.URL+"/sw.js", map[string]string{"Accept-Encoding": "*"})
		if resp.Header.Get("Content-Encoding") != "gzip" {
			t.Fatalf("Content-Encoding = %q, want gzip (* offers all codings)", resp.Header.Get("Content-Encoding"))
		}
		if _, err := gzip.NewReader(bytes.NewReader(body)); err != nil {
			t.Errorf("body under * is not gzip: %v", err)
		}
	})
	t.Run("range request falls back to identity FileServer", func(t *testing.T) {
		resp, body := httpGetHeaders(t, ws.URL+"/sw.js", map[string]string{
			"Accept-Encoding": "gzip",
			"Range":           "bytes=0-9",
		})
		if resp.StatusCode != http.StatusPartialContent {
			t.Fatalf("status = %d, want 206 (identity FileServer handles the range)", resp.StatusCode)
		}
		if resp.Header.Get("Content-Encoding") != "" {
			t.Errorf("range response unexpectedly compressed: %q", resp.Header.Get("Content-Encoding"))
		}
		if len(body) != 10 {
			t.Errorf("range body = %d bytes, want 10", len(body))
		}
	})
	t.Run("HEAD on gzip path sends headers without a body", func(t *testing.T) {
		req, err := http.NewRequest(http.MethodHead, ws.URL+"/sw.js", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Accept-Encoding", "gzip")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("HEAD status = %d, want 200", resp.StatusCode)
		}
		if resp.Header.Get("Content-Encoding") != "gzip" {
			t.Errorf("HEAD Content-Encoding = %q, want gzip", resp.Header.Get("Content-Encoding"))
		}
		if cl := resp.Header.Get("Content-Length"); cl == "" {
			t.Errorf("HEAD missing Content-Length on the gzip path")
		}
	})
}

// TestShellsStayNoCache pins that the two shell routes (`/` and `/app`) remain
// uncached deploy-freshness points: explicit no-cache, NO ETag, NO content
// encoding — in both real-build and placeholder branches of each shell.
func TestShellsStayNoCache(t *testing.T) {
	t.Run("real shells", func(t *testing.T) {
		ws := newCacheMatrixServer(t) // real index.html in both embeds
		defer ws.Close()
		for _, path := range []string{"/", "/app"} {
			resp, _ := httpGetHeaders(t, ws.URL+path, map[string]string{"Accept-Encoding": "gzip"})
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("%s status = %d", path, resp.StatusCode)
			}
			if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
				t.Errorf("%s Cache-Control = %q, want no-cache", path, cc)
			}
			if resp.Header.Get("ETag") != "" {
				t.Errorf("%s must not carry an ETag (shells are not asset-cached): %q", path, resp.Header.Get("ETag"))
			}
			if resp.Header.Get("Content-Encoding") != "" {
				t.Errorf("%s must not be compressed (shell routes stay outside the gzip layer): %q",
					path, resp.Header.Get("Content-Encoding"))
			}
		}
	})
	t.Run("placeholder shells", func(t *testing.T) {
		dist := fstest.MapFS{"placeholder.html": {Data: []byte("app placeholder")}}
		host := fstest.MapFS{"placeholder.html": {Data: []byte("host placeholder")}}
		ws := newStaticTestServer(t, dist, host)
		defer ws.Close()
		for _, path := range []string{"/", "/app"} {
			resp, _ := httpGetHeaders(t, ws.URL+path, nil)
			if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
				t.Errorf("%s (placeholder) Cache-Control = %q, want no-cache", path, cc)
			}
		}
	})
}

// TestStaticSecurityHeadersUnchanged pins that the S1 caching layer did not
// disturb the security-header contract on static routes: every representative
// route still carries exactly the path-aware CSP the middleware computes, plus
// nosniff / X-Frame-Options / Referrer-Policy.
func TestStaticSecurityHeadersUnchanged(t *testing.T) {
	bigJS := gzipTestBody(2048)
	appIndex := "<!doctype html><html><head><title>VHSolara</title></head><body><div id=\"root\"></div></body></html>"
	hostIndex := "<!doctype html><html><head><title>VHSolara · Host</title></head><body><div id=\"root\"></div></body></html>"
	dist := fstest.MapFS{
		"index.html":             {Data: []byte(appIndex)},
		"sw.js":                  {Data: bigJS},
		"assets/app-B3xV1zC4.js": {Data: bigJS},
	}
	host := fstest.MapFS{
		"index.html":              {Data: []byte(hostIndex)},
		"assets/host-Q9w8e7rT.js": {Data: bigJS},
	}
	agg := aggregator.New("http://127.0.0.1:1", 100)
	srv, err := NewServer(agg, "http://127.0.0.1:1", 1000)
	if err != nil {
		t.Fatal(err)
	}
	srv.staticFS = dist
	srv.static = http.FileServer(http.FS(dist))
	srv.hostFS = host
	srv.hostStatic = http.FileServer(http.FS(host))
	ws := httptest.NewServer(srv.Handler())
	defer ws.Close()

	for _, path := range []string{"/", "/app", "/sw.js", "/assets/app-B3xV1zC4.js", "/host/assets/host-Q9w8e7rT.js"} {
		t.Run(path, func(t *testing.T) {
			resp, _ := httpGetHeaders(t, ws.URL+path, map[string]string{"Accept-Encoding": "gzip"})
			if got, want := resp.Header.Get("Content-Security-Policy"), srv.contentSecurityPolicyForPath(path); got != want {
				t.Errorf("CSP = %q, want %q", got, want)
			}
			if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
				t.Errorf("X-Content-Type-Options = %q, want nosniff", resp.Header.Get("X-Content-Type-Options"))
			}
			if resp.Header.Get("X-Frame-Options") != "SAMEORIGIN" {
				t.Errorf("X-Frame-Options = %q, want SAMEORIGIN (default frame-ancestors posture)",
					resp.Header.Get("X-Frame-Options"))
			}
			if resp.Header.Get("Referrer-Policy") != "same-origin" {
				t.Errorf("Referrer-Policy = %q, want same-origin", resp.Header.Get("Referrer-Policy"))
			}
		})
	}
}

// TestFaviconCaching pins that the /favicon.ico delegation goes through the
// same static caching contract (host icon in production posture): ETag +
// no-cache when the icon is embedded, and 304 on revalidation. The cold-build
// 404 disposition stays pinned by TestFaviconRoute (favicon_test.go).
func TestFaviconCaching(t *testing.T) {
	ws := newCacheMatrixServer(t) // host icon.svg present; hostShellAtRoot default true
	defer ws.Close()

	resp, _ := httpGetHeaders(t, ws.URL+"/favicon.ico", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "image/") {
		t.Errorf("Content-Type = %q, want image/*", resp.Header.Get("Content-Type"))
	}
	etag := resp.Header.Get("ETag")
	if etag == "" {
		t.Fatalf("favicon missing ETag")
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("Cache-Control = %q, want no-cache (icon.svg is a non-hashed static)", cc)
	}
	if resp.Header.Get("Content-Encoding") != "" {
		t.Errorf("small svg icon must stay identity, got %q", resp.Header.Get("Content-Encoding"))
	}
	r304, b304 := httpGetHeaders(t, ws.URL+"/favicon.ico", map[string]string{"If-None-Match": etag})
	if r304.StatusCode != http.StatusNotModified {
		t.Fatalf("revalidate status = %d, want 304", r304.StatusCode)
	}
	if len(b304) != 0 {
		t.Errorf("304 body = %d bytes, want empty", len(b304))
	}
}

// TestStaticContentTypeOnGzipPath pins that the gzip branch's Content-Type
// matches what the identity FileServer path serves for the same file (the walk
// records it with the same extension-table-then-sniff algorithm).
func TestStaticContentTypeOnGzipPath(t *testing.T) {
	ws := newCacheMatrixServer(t)
	defer ws.Close()

	for _, path := range []string{"/sw.js", "/assets/app-B3xV1zC4.js", "/host/assets/host-Q9w8e7rT.js"} {
		t.Run(path, func(t *testing.T) {
			ident, _ := httpGetHeaders(t, ws.URL+path, map[string]string{"Accept-Encoding": "identity"})
			gz, _ := httpGetHeaders(t, ws.URL+path, map[string]string{"Accept-Encoding": "gzip"})
			if a, b := ident.Header.Get("Content-Type"), gz.Header.Get("Content-Type"); a != b {
				t.Errorf("Content-Type diverged: identity %q vs gzip %q", a, b)
			}
		})
	}
}

// TestStaticIdentityWithoutAcceptEncodingHeader (S2 pin B-F2) pins the
// truly-ABSENT Accept-Encoding header case: a request that carries NO
// Accept-Encoding header at all (not merely an empty value — that form is
// already pinned by TestStaticGzipNegotiation) must get the IDENTITY variant.
// This matters because the stdlib transport auto-adds `Accept-Encoding: gzip`
// and transparently decompresses when the application sets nothing — masking
// server-side negotiation bugs from ordinary clients. Two server-observable
// routes cover it:
//   - a real round trip over http.Client{Transport: DisableCompression: true},
//     which never injects the header (precondition-asserted via resp.Request);
//   - direct handler invocation with httptest.NewRequest, which constructs a
//     request without the header (precondition-asserted on the raw header map).
//
// No server.go changes: additive test only, on the existing gzip matrix
// fixtures (both the non-hashed /sw.js revalidate class and a hashed asset).
func TestStaticIdentityWithoutAcceptEncodingHeader(t *testing.T) {
	raw := gzipTestBody(2048) // exactly what the fixtures serve for these files

	t.Run("DisableCompression client omits the header", func(t *testing.T) {
		ws := newCacheMatrixServer(t)
		defer ws.Close()
		client := &http.Client{Transport: &http.Transport{DisableCompression: true}}
		for _, path := range []string{"/sw.js", "/assets/app-B3xV1zC4.js"} {
			req, err := http.NewRequest(http.MethodGet, ws.URL+path, nil)
			if err != nil {
				t.Fatal(err)
			}
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			// Precondition: the request as sent carried NO Accept-Encoding
			// (no redirects here, so resp.Request is the request as sent).
			if ae := resp.Request.Header.Get("Accept-Encoding"); ae != "" {
				t.Fatalf("%s precondition: Accept-Encoding = %q, want absent (DisableCompression)", path, ae)
			}
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("%s status = %d, want 200", path, resp.StatusCode)
			}
			if ce := resp.Header.Get("Content-Encoding"); ce != "" {
				t.Errorf("%s Content-Encoding = %q, want none (identity variant)", path, ce)
			}
			if !bytes.Equal(body, raw) {
				t.Errorf("%s identity body diverged from the served file (%d vs %d bytes)",
					path, len(body), len(raw))
			}
			if !strings.Contains(strings.Join(resp.Header.Values("Vary"), ","), "Accept-Encoding") {
				t.Errorf("%s identity variant of a gzip-eligible static missing Vary: Accept-Encoding", path)
			}
		}
	})

	t.Run("direct handler invocation sees no header", func(t *testing.T) {
		bigJS := gzipTestBody(2048)
		appIndex := "<!doctype html><html><head><title>VHSolara</title></head><body><div id=\"root\"></div></body></html>"
		dist := fstest.MapFS{
			"index.html":             {Data: []byte(appIndex)},
			"sw.js":                  {Data: bigJS},
			"assets/app-B3xV1zC4.js": {Data: bigJS},
		}
		agg := aggregator.New("http://127.0.0.1:1", 100)
		srv, err := NewServer(agg, "http://127.0.0.1:1", 1000)
		if err != nil {
			t.Fatal(err)
		}
		srv.staticFS = dist
		srv.static = http.FileServer(http.FS(dist))
		handler := srv.Handler()

		for _, path := range []string{"/sw.js", "/assets/app-B3xV1zC4.js"} {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			// Precondition: the header key is genuinely ABSENT from the map
			// (Get cannot distinguish absent from empty).
			if _, present := req.Header["Accept-Encoding"]; present {
				t.Fatalf("%s precondition: Accept-Encoding unexpectedly present in %v", path, req.Header)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			resp := rec.Result()
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("%s status = %d, want 200", path, resp.StatusCode)
			}
			if ce := resp.Header.Get("Content-Encoding"); ce != "" {
				t.Errorf("%s Content-Encoding = %q, want none (no coding offered)", path, ce)
			}
			if !bytes.Equal(body, bigJS) {
				t.Errorf("%s identity body diverged from the served file (%d vs %d bytes)", path, len(body), len(bigJS))
			}
			// The identity variant of a gzip-eligible static still declares
			// its variance (same contract the DisableCompression subtest and
			// TestStaticCacheHeaders pin on both variants).
			if !strings.Contains(strings.Join(resp.Header.Values("Vary"), ","), "Accept-Encoding") {
				t.Errorf("%s identity variant of a gzip-eligible static missing Vary: Accept-Encoding", path)
			}
		}
	})
}
