package web

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// startUnixUpstream serves a tiny "consumer" web app on a unix socket and
// records what it received, so the proxy contract can be asserted.
func startUnixUpstream(t *testing.T) (sock string, seenPath *string, seenCookie *string) {
	t.Helper()
	sock = filepath.Join(t.TempDir(), "up.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	var lastPath, lastCookie string
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		lastPath = r.URL.Path
		lastCookie = r.Header.Get("Cookie")
		switch r.URL.Path {
		case "/data":
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte("DATA"))
		case "/go":
			http.Redirect(w, r, "/dest", http.StatusFound)
		default:
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte("<html><head><title>x</title></head><body>board</body></html>"))
		}
	})
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return sock, &lastPath, &lastCookie
}

func registerView(t *testing.T, s *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/vh/views", strings.NewReader(body))
	rec := httptest.NewRecorder()
	s.handleViews(rec, req)
	return rec
}

func TestViewProxyContract(t *testing.T) {
	sock, seenPath, seenCookie := startUnixUpstream(t)
	s := &Server{views: newViewRegistry()}

	// Register a view bound to the unix-socket upstream under /board.
	rec := registerView(t, s, `{"view_id":"b","title":"Board","path_prefix":"/board","upstream":"unix:`+sock+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("register: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}

	// Dispatch wraps a "fell through" terminal so we can tell proxy vs. miss.
	h := s.dispatchView(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "fell through", http.StatusTeapot)
	}))

	// (1) HTML root: proxied, prefix stripped to "/", <base> injected, our CSP +
	// framing set, and the vh session cookie NOT forwarded upstream.
	req := httptest.NewRequest(http.MethodGet, "/board/", nil)
	req.Header.Set("Cookie", "vh_session=secret")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /board/: want 200, got %d", rec.Code)
	}
	if *seenPath != "/" {
		t.Fatalf("upstream should see stripped path /, saw %q", *seenPath)
	}
	if *seenCookie != "" {
		t.Fatalf("vh session cookie must NOT be forwarded upstream, upstream saw %q", *seenCookie)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "board") {
		t.Fatalf("expected proxied body, got %q", body)
	}
	if !strings.Contains(body, `<base href="/board/">`) {
		t.Fatalf("expected injected <base>, got %q", body)
	}
	if rec.Header().Get("Content-Security-Policy") != viewCSP {
		t.Fatalf("expected view CSP, got %q", rec.Header().Get("Content-Security-Policy"))
	}
	if rec.Header().Get("X-Frame-Options") != "SAMEORIGIN" {
		t.Fatalf("expected X-Frame-Options SAMEORIGIN, got %q", rec.Header().Get("X-Frame-Options"))
	}

	// (2) Sub-path asset: proxied with the prefix stripped.
	req = httptest.NewRequest(http.MethodGet, "/board/data", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Body.String() != "DATA" || *seenPath != "/data" {
		t.Fatalf("asset: body=%q upstreamPath=%q", rec.Body.String(), *seenPath)
	}

	// (3) Redirect Location is rewritten under the prefix (no auto-follow).
	req = httptest.NewRequest(http.MethodGet, "/board/go", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("redirect: want 302, got %d", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "/board/dest" {
		t.Fatalf("Location should be rewritten under prefix, got %q", loc)
	}

	// (4) A non-view path falls through to the mux.
	req = httptest.NewRequest(http.MethodGet, "/vh/snapshot", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusTeapot {
		t.Fatalf("non-view path should fall through, got %d", rec.Code)
	}

	// (5) List shows it; DELETE unregisters; then the prefix falls through.
	listReq := httptest.NewRequest(http.MethodGet, "/vh/views", nil)
	listRec := httptest.NewRecorder()
	s.handleViews(listRec, listReq)
	var got []viewReg
	if err := json.Unmarshal(listRec.Body.Bytes(), &got); err != nil || len(got) != 1 || got[0].ID != "b" {
		t.Fatalf("list: err=%v body=%s", err, listRec.Body.String())
	}
	if got[0].Sandbox != defaultSandbox {
		t.Fatalf("expected default sandbox, got %q", got[0].Sandbox)
	}
	delReq := httptest.NewRequest(http.MethodDelete, "/vh/views?view_id=b", nil)
	delRec := httptest.NewRecorder()
	s.handleViews(delRec, delReq)
	req = httptest.NewRequest(http.MethodGet, "/board/", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusTeapot {
		t.Fatalf("after unregister, /board/ should fall through, got %d", rec.Code)
	}
}

func TestViewPrefixValidation(t *testing.T) {
	s := &Server{views: newViewRegistry()}
	bad := []string{
		`{"view_id":"a","path_prefix":"/","upstream":"unix:/x.sock"}`,       // root
		`{"view_id":"a","path_prefix":"/vh/x","upstream":"unix:/x.sock"}`,   // reserved
		`{"view_id":"a","path_prefix":"board","upstream":"unix:/x.sock"}`,   // no leading slash
		`{"view_id":"a","path_prefix":"/ok","upstream":"ftp://x"}`,          // bad upstream
		`{"view_id":"","path_prefix":"/ok","upstream":"unix:/x.sock"}`,      // no id
	}
	for _, b := range bad {
		rec := registerView(t, s, b)
		if rec.Code == http.StatusOK {
			t.Fatalf("expected rejection for %s", b)
		}
	}
	// Overlapping prefix is a conflict.
	if rec := registerView(t, s, `{"view_id":"a","path_prefix":"/a","upstream":"unix:/x.sock"}`); rec.Code != http.StatusOK {
		t.Fatalf("first register should pass: %d %s", rec.Code, rec.Body.String())
	}
	if rec := registerView(t, s, `{"view_id":"c","path_prefix":"/a/b","upstream":"unix:/x.sock"}`); rec.Code != http.StatusConflict {
		t.Fatalf("overlapping prefix should 409, got %d", rec.Code)
	}
}

// sanity: insertAfterTag places <base> right after <head>.
func TestInsertAfterTag(t *testing.T) {
	out := insertAfterTag([]byte("<HTML><HEAD>\n<title>t</title></head></html>"), []byte("<base>"))
	if !bytes.Contains(out, []byte("<HEAD><base>")) {
		t.Fatalf("base not inserted after head: %s", out)
	}
	// no head/html → prepend
	out = insertAfterTag([]byte("plain"), []byte("<base>"))
	if !bytes.HasPrefix(out, []byte("<base>plain")) {
		t.Fatalf("base not prepended: %s", out)
	}
}

func TestThemeTokensEndpoint(t *testing.T) {
	s := &Server{}
	// JSON baseline: mode + the published --vh-* tokens.
	rec := httptest.NewRecorder()
	s.handleThemeJSON(rec, httptest.NewRequest(http.MethodGet, "/vh/theme.json", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("theme.json: %d", rec.Code)
	}
	var out struct {
		Mode   string            `json:"mode"`
		Tokens map[string]string `json:"tokens"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Mode != "dark" {
		t.Fatalf("mode: %q", out.Mode)
	}
	for _, want := range []string{"--vh-bg", "--vh-surface", "--vh-fg", "--vh-muted", "--vh-accent", "--vh-border", "--vh-ok", "--vh-warn", "--vh-error"} {
		if out.Tokens[want] == "" {
			t.Fatalf("missing token %s", want)
		}
	}
	// CSS baseline: a :root rule carrying the same tokens.
	rec = httptest.NewRecorder()
	s.handleThemeCSS(rec, httptest.NewRequest(http.MethodGet, "/vh/theme.css", nil))
	body := rec.Body.String()
	if !strings.Contains(rec.Header().Get("Content-Type"), "text/css") {
		t.Fatalf("theme.css content-type: %q", rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(body, ":root{") || !strings.Contains(body, "--vh-bg:") {
		t.Fatalf("theme.css body: %q", body)
	}
}
