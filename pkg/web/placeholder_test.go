package web

import (
	"os"
	"strings"
	"testing"
)

func TestPlaceholderSelfContained(t *testing.T) {
	// Read the COMMITTED placeholder from disk, not the embed FS. This enforces the
	// invariant on the tracked source regardless of local embed state, so a
	// materialized SPA shell accidentally committed (e.g. `git commit -a` after
	// `make build`) fails CI instead of shipping a cold-clone that 404s on /assets/*.
	b, err := os.ReadFile("dist/index.html")
	if err != nil {
		t.Fatalf("read dist/index.html: %v", err)
	}
	html := string(b)
	if strings.Contains(html, "/assets/") {
		t.Errorf("committed dist/index.html references /assets/ — was a materialized SPA shell committed? Run commit-gate.sh revert pkg/web/dist/index.html")
	}
	if strings.Contains(html, "/sw.js") {
		t.Errorf("committed dist/index.html must not reference /sw.js")
	}
	if !strings.Contains(html, "<title>VHSolara</title>") {
		t.Errorf("placeholder missing <title>VHSolara</title>")
	}
	if !strings.Contains(html, "not built") {
		t.Errorf("placeholder missing the 'not built' banner text")
	}
}
