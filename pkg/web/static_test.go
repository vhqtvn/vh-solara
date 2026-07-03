package web

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestServesEmbeddedSPA(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	// Root serves the embedded index.html. That is either the real SPA shell
	// (when an embed-producing target materialized a `make web` build into
	// pkg/web/dist) or the self-contained fallback placeholder committed so a
	// cold `go build`/`go test` works with NO frontend build. <title>VHSolara</title>
	// is present in both, so it is the stable marker for "index.html was served".
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
