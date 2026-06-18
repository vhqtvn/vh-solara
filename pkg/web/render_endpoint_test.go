package web

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

func newWebServer(t *testing.T) *httptest.Server {
	t.Helper()
	agg := aggregator.New("http://127.0.0.1:1", 100) // not started; render needs no opencode
	srv, err := NewServer(agg, "http://127.0.0.1:1", 1000)
	if err != nil {
		t.Fatal(err)
	}
	return httptest.NewServer(srv.Handler())
}

func TestRenderEndpointBatch(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	body, _ := json.Marshal([]map[string]string{
		{"id": "a", "kind": "markdown", "text": "# Hi\n```go\nvar x = 1\n```"},
		{"id": "b", "kind": "diff", "file": "f.go", "before": "a\n", "after": "b\n"},
	})
	resp, err := http.Post(ws.URL+"/vh/render", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var results []struct {
		ID   string `json:"id"`
		HTML string `json:"html"`
	}
	json.NewDecoder(resp.Body).Decode(&results)
	if len(results) != 2 {
		t.Fatalf("want 2 results, got %d", len(results))
	}
	byID := map[string]string{}
	for _, r := range results {
		byID[r.ID] = r.HTML
	}
	if !strings.Contains(byID["a"], "<h1") || !strings.Contains(byID["a"], "chroma") {
		t.Fatalf("markdown render wrong: %s", byID["a"])
	}
	if !strings.Contains(byID["b"], "vh-diff") {
		t.Fatalf("diff render wrong: %s", byID["b"])
	}
}

func TestHighlightCSSEndpoint(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	resp, err := http.Get(ws.URL + "/vh/highlight.css")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/css") {
		t.Fatalf("want text/css, got %q", ct)
	}
	b, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(b), ".chroma") {
		t.Fatal("css missing .chroma rules")
	}
}
