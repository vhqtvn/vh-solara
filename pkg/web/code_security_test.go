package web

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// A benign /vh/* GET with a novel ?dir= must only STAMP headers — it must not
// open a project (create an aggregator / launch managed processes) for that dir.
func TestStampMetaDoesNotOpenProject(t *testing.T) {
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	dir := t.TempDir() // a novel project directory, never opened
	res, err := http.Get(web.URL + "/vh/code/styles?dir=" + url.QueryEscape(dir))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.Header.Get("X-VH-Epoch") == "" {
		t.Error("stampMeta should still stamp X-VH-Epoch (from the default store)")
	}
	// The map is seeded with the default ("") aggregator; stamping must not have
	// added one for the novel dir.
	srv.aggMu.Lock()
	_, opened := srv.aggs[dir]
	srv.aggMu.Unlock()
	if opened {
		t.Errorf("a header-stamp request opened an aggregator for %q; want none", dir)
	}
}

// safeJoin is the path-confinement guard for every code-view endpoint, so its
// rejection of traversal and escaping symlinks is security-critical — cover it.
func TestSafeJoinConfinement(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		rel    string
		wantOK bool
	}{
		{"sub/a.txt", true},
		{"sub", true},
		{"", true},
		{"/sub/a.txt", true},        // leading slash is stripped, stays under root
		{"../a.txt", false},         // parent traversal
		{"sub/../../a.txt", false},  // climbs out after cleaning
		{"../../etc/passwd", false}, // deep traversal
	}
	for _, c := range cases {
		if _, ok := safeJoin(root, c.rel); ok != c.wantOK {
			t.Errorf("safeJoin(root, %q) ok=%v, want %v", c.rel, ok, c.wantOK)
		}
	}
}

func TestSafeJoinRejectsEscapingSymlink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("s"), 0o644); err != nil {
		t.Fatal(err)
	}
	// root/escape -> outside (a symlink that leaves the project dir)
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	if _, ok := safeJoin(root, "escape/secret"); ok {
		t.Error("safeJoin allowed a path through a symlink escaping the root")
	}

	// An in-root symlink must still be allowed.
	if err := os.MkdirAll(filepath.Join(root, "real"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "real", "f"), []byte("f"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "real"), filepath.Join(root, "inlink")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	if _, ok := safeJoin(root, "inlink/f"); !ok {
		t.Error("safeJoin rejected an in-root symlink")
	}
}

// ssrfControl is the dial-time guard for view-proxy upstreams; it must block
// link-local (incl. cloud-metadata) but allow loopback/LAN.
func TestSSRFControlBlocksLinkLocal(t *testing.T) {
	blocked := []string{"169.254.169.254:80", "169.254.0.1:8080", "[fe80::1]:80"}
	for _, a := range blocked {
		if err := ssrfControl("tcp", a, nil); err == nil {
			t.Errorf("ssrfControl(%q) allowed a link-local dial; want blocked", a)
		}
	}
	allowed := []string{"127.0.0.1:8080", "192.168.1.10:80", "10.0.0.5:3000", "[::1]:80"}
	for _, a := range allowed {
		if err := ssrfControl("tcp", a, nil); err != nil {
			t.Errorf("ssrfControl(%q) blocked an allowed dial: %v", a, err)
		}
	}
}

// handleCodeRaw's ?download=1 path: attachment disposition with an RFC 5987
// percent-escaped basename, the larger download cap (files over the inline cap
// are downloadable but not inline-servable), and confinement (traversal +
// escaping symlinks) unchanged by the param. The inline path must behave
// exactly as before the param existed.
func TestCodeRawDownloadParam(t *testing.T) {
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Non-ASCII basename: must survive Content-Disposition percent-encoded.
	if err := os.WriteFile(filepath.Join(dir, "café.bin"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	get := func(t *testing.T, query string) *http.Response {
		t.Helper()
		res, err := http.Get(web.URL + "/vh/code/raw?dir=" + url.QueryEscape(dir) + "&" + query)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { res.Body.Close() })
		return res
	}

	// Inline path unchanged: 200 and no Content-Disposition.
	if res := get(t, "path=a.txt"); res.StatusCode != http.StatusOK {
		t.Errorf("inline a.txt: status %d, want 200", res.StatusCode)
	} else if cd := res.Header.Get("Content-Disposition"); cd != "" {
		t.Errorf("inline a.txt: Content-Disposition %q; want none", cd)
	}

	// download=1: attachment with the escaped basename (RFC 5987 filename*).
	if res := get(t, "path=a.txt&download=1"); res.StatusCode != http.StatusOK {
		t.Errorf("download a.txt: status %d, want 200", res.StatusCode)
	} else if cd := res.Header.Get("Content-Disposition"); cd != `attachment; filename*=UTF-8''a.txt` {
		t.Errorf("download a.txt: Content-Disposition %q", cd)
	}

	// Non-ASCII basename: é is UTF-8 C3 A9 → %C3%A9.
	if res := get(t, "path=caf%C3%A9.bin&download=1"); res.StatusCode != http.StatusOK {
		t.Errorf("download café.bin: status %d, want 200", res.StatusCode)
	} else if cd := res.Header.Get("Content-Disposition"); cd != `attachment; filename*=UTF-8''caf%C3%A9.bin` {
		t.Errorf("download café.bin: Content-Disposition %q; want RFC 5987 escaping", cd)
	}

	// Over the inline cap but under the download cap: inline 404, download 200.
	// Truncate makes the fixture sparse — the gate is stat size, and ServeContent
	// streams the (zero) bytes, so a >16 MiB case costs almost nothing.
	big := filepath.Join(dir, "big.bin")
	bf, err := os.Create(big)
	if err != nil {
		t.Fatal(err)
	}
	if err := bf.Truncate(int64(codeRawMaxBytes) + 1); err != nil {
		t.Fatal(err)
	}
	bf.Close()
	if res := get(t, "path=big.bin"); res.StatusCode != http.StatusNotFound {
		t.Errorf("inline big.bin: status %d, want 404 (over codeRawMaxBytes)", res.StatusCode)
	}
	if res := get(t, "path=big.bin&download=1"); res.StatusCode != http.StatusOK {
		t.Errorf("download big.bin: status %d, want 200 (under codeDownloadMaxBytes)", res.StatusCode)
	} else if cd := res.Header.Get("Content-Disposition"); cd != `attachment; filename*=UTF-8''big.bin` {
		t.Errorf("download big.bin: Content-Disposition %q", cd)
	}

	// Over even the download cap: still 404 (sparse, and never opened — the
	// stat gate rejects before the read).
	huge := filepath.Join(dir, "huge.bin")
	hf, err := os.Create(huge)
	if err != nil {
		t.Fatal(err)
	}
	if err := hf.Truncate(int64(codeDownloadMaxBytes) + 1); err != nil {
		t.Fatal(err)
	}
	hf.Close()
	if res := get(t, "path=huge.bin&download=1"); res.StatusCode != http.StatusNotFound {
		t.Errorf("download huge.bin: status %d, want 404 (over codeDownloadMaxBytes)", res.StatusCode)
	}

	// Confinement is unchanged by download=1.
	if res := get(t, "path=../a.txt&download=1"); res.StatusCode != http.StatusBadRequest {
		t.Errorf("traversal with download=1: status %d, want 400", res.StatusCode)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("s"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "escape")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	if res := get(t, "path=escape/secret&download=1"); res.StatusCode != http.StatusBadRequest {
		t.Errorf("escaping symlink with download=1: status %d, want 400", res.StatusCode)
	}
}
