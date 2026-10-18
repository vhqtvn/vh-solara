package web

// Server-side render endpoints, moved verbatim from server.go (slice 1 of the
// server.go split): POST /vh/render (batch markdown/diff/patch → sanitized
// HTML) and GET /vh/highlight.css (the cached chroma stylesheet). Routes are
// registered in server.go (Handler). The shared *render.Renderer and its
// cssOnce/css cache are Server fields (see server.go) also used by the code
// viewer (code.go).

import (
	"encoding/json"
	"io"
	"net/http"
	"runtime"
	"sync"

	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
)

// renderRequest is one item in a POST /vh/render batch. Clients render in-flight
// (streaming) content themselves and call this only for settled content, keyed
// by a stable id so results can be matched back and cached client-side.
type renderRequest struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"` // "markdown" | "diff" | "patch"
	Text   string `json:"text,omitempty"`
	File   string `json:"file,omitempty"`
	Before string `json:"before,omitempty"`
	After  string `json:"after,omitempty"`
	Patch  string `json:"patch,omitempty"`
	Mode   string `json:"mode,omitempty"` // patch: "split" for side-by-side, else unified
}

type renderResult struct {
	ID   string `json:"id"`
	HTML string `json:"html"`
}

func (s *Server) handleRender(w http.ResponseWriter, r *http.Request) {
	w = diag.NewHandlerBytesWriter(w, diag.ProxyPathRender) // PROBE 8: attribute non-stream tunnel bytes
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var reqs []renderRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&reqs); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Render the batch across goroutines: the per-block work (goldmark + chroma +
	// sanitize) is CPU-bound and concurrent-safe (each call uses a local buffer;
	// only the renderer's cache map is mutex-guarded), so a big first-open batch
	// uses all cores instead of one. Bounded to NumCPU; results indexed (the
	// client maps by id, order doesn't matter). An unrendered slot keeps ID="" and
	// is filtered out (matches the old "skip unknown kind" behavior).
	slots := make([]renderResult, len(reqs))
	conc := runtime.NumCPU()
	if conc < 1 {
		conc = 1
	}
	sem := make(chan struct{}, conc)
	var wg sync.WaitGroup
	for i := range reqs {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			req := reqs[i]
			var html string
			switch req.Kind {
			case "markdown":
				html = s.renderer.Markdown(req.Text)
			case "diff":
				html = s.renderer.Diff(req.File, req.Before, req.After)
			case "patch":
				if req.Mode == "split" {
					html = s.renderer.PatchSplit(req.Patch)
				} else {
					html = s.renderer.Patch(req.Patch)
				}
			default:
				return // leave slot zero (ID=="") → filtered below
			}
			slots[i] = renderResult{ID: req.ID, HTML: html}
		}(i)
	}
	wg.Wait()
	results := make([]renderResult, 0, len(slots))
	for _, r := range slots {
		if r.ID != "" {
			results = append(results, r)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(results)
}

func (s *Server) handleHighlightCSS(w http.ResponseWriter, r *http.Request) {
	s.cssOnce.Do(func() {
		css, err := s.renderer.HighlightCSS()
		if err == nil {
			s.css = css
		}
	})
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	io.WriteString(w, s.css)
}
