package web

import (
	"strings"
	"testing"
)

// TestPlaceholderSelfContained locks the invariant that the committed fallback
// pkg/web/dist/index.html is fully self-contained: it must NOT reference the
// hashed SPA bundle (/assets/*) or the service worker (/sw.js), which exist only
// after `make web` stages a build and an embed-producing target materializes it.
// This keeps a cold `go build`/`go test` (no frontend build) serving a real page
// with no 404s.
//
// A materialized real SPA shell legitimately references /assets/, so when a real
// build is embedded (e.g. the test ran right after `make build`), there is nothing
// placeholder-specific to enforce — only the fallback-placeholder branch asserts.
// The strong lock for "make web never dirties the tracked placeholder" lives in
// the CI workflow (the "make web leaves no tracked dist changes" guard).
func TestPlaceholderSelfContained(t *testing.T) {
	b, err := distFS.ReadFile("dist/index.html")
	if err != nil {
		t.Fatalf("read embedded dist/index.html: %v", err)
	}
	html := string(b)

	// A real SPA build references its hashed bundle; that is not the committed
	// fallback placeholder, so the self-containment checks below do not apply.
	if strings.Contains(html, "/assets/") {
		return
	}

	// The committed placeholder must not dangle references to build-only assets.
	if strings.Contains(html, "/sw.js") {
		t.Errorf("placeholder index.html must not reference /sw.js (build-only asset)")
	}
	// Sanity: it is a real, served page (not an empty/stub/regressed file).
	if !strings.Contains(html, "<title>VHSolara</title>") {
		t.Errorf("placeholder index.html missing <title>VHSolara</title>")
	}
	if !strings.Contains(html, "not built") {
		t.Errorf("placeholder index.html missing the 'not built' banner text")
	}
}
