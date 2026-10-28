package web

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/render"
)

// generatedHighlightCSSPath is the committed web build input carrying the EXACT
// bytes of render.New().HighlightCSS() — the same bytes the /vh/highlight.css
// handler serves. src/index.tsx imports it as the FIRST stylesheet so the
// bundled app stylesheet contains the highlight rules (unlayered, before all
// app rules) and pane documents no longer fetch /vh/highlight.css per pane —
// eight same-URL fetches that serialized inside the browser network stack
// (~one RTT per pane; see the 2026-10-10 P0 diagnosis in
// docs/checkpoints/2026-10-11-page-load-perf-waterfall-closeout.md). The handler itself is unchanged
// and keeps serving standalone consumers.
//
// This test is the drift gate: if the chroma pin (go.mod) or the renderer's
// sheet composition changes, the committed artifact stops matching and this
// test fails loudly instead of the SPA silently diverging from the handler.
const generatedHighlightCSSPath = "../../web/src/styles/highlight.generated.css"

// regenEnv, when set to "1", regenerates the committed artifact from the
// renderer instead of only comparing (golden-update pattern).
const regenEnv = "VH_REGEN_HIGHLIGHT_CSS"

func TestHighlightParityGeneratedCSSArtifact(t *testing.T) {
	if os.Getenv(regenEnv) == "1" {
		css, err := render.New().HighlightCSS()
		if err != nil {
			t.Fatalf("render.New().HighlightCSS(): %v", err)
		}
		if err := os.WriteFile(generatedHighlightCSSPath, []byte(css), 0o644); err != nil {
			t.Fatalf("regenerate %s: %v", generatedHighlightCSSPath, err)
		}
		sum := sha256.Sum256([]byte(css))
		t.Logf("regenerated %s (%d bytes, sha256 %s)", generatedHighlightCSSPath, len(css), hex.EncodeToString(sum[:]))
		return
	}

	css, err := render.New().HighlightCSS()
	if err != nil {
		t.Fatalf("render.New().HighlightCSS(): %v", err)
	}
	artifact, rerr := os.ReadFile(generatedHighlightCSSPath)
	if rerr != nil {
		t.Fatalf("committed highlight stylesheet artifact is missing/unreadable (%v).\n"+
			"It is a GENERATED file — the exact bytes of render.New().HighlightCSS().\n"+
			"Regenerate and commit it (repo root):\n"+
			"  %s=1 go test ./pkg/web/ -run TestHighlightParityGeneratedCSSArtifact -count=1", rerr, regenEnv)
	}

	if bytes.Equal(artifact, []byte(css)) {
		return
	}

	sumA := sha256.Sum256(artifact)
	sumC := sha256.Sum256([]byte(css))
	t.Fatalf("committed artifact web/src/styles/highlight.generated.css (%d bytes, sha256 %s)\n"+
		"does NOT match render.New().HighlightCSS() (%d bytes, sha256 %s).\n"+
		"The SPA's bundled highlight sheet has drifted from what the daemon serves.\n"+
		"Regenerate and commit the artifact (repo root):\n"+
		"  %s=1 go test ./pkg/web/ -run TestHighlightParityGeneratedCSSArtifact -count=1",
		len(artifact), hex.EncodeToString(sumA[:]), len(css), hex.EncodeToString(sumC[:]), regenEnv)
}
