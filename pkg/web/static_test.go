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

	// Root serves the SPA shell.
	resp, err := http.Get(ws.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(body), `<div id="root">`) {
		t.Fatalf("root did not serve SPA shell: %s", body)
	}
	if !strings.Contains(string(body), "/assets/") {
		t.Fatalf("SPA shell missing bundled assets reference: %s", body)
	}

	// Unknown client-route falls back to index.html (SPA routing).
	resp2, err := http.Get(ws.URL + "/session/anything")
	if err != nil {
		t.Fatal(err)
	}
	body2, _ := io.ReadAll(resp2.Body)
	resp2.Body.Close()
	if !strings.Contains(string(body2), `<div id="root">`) {
		t.Fatalf("SPA fallback failed for client route: %s", body2)
	}
}
