package aggregator

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestVocabularyMessagesDeliveredAndAnyHydrate is the Go half of the standing
// check for audit L-02 / remediation M11. The aggregator's sticky "at least one
// successful hydrate has completed" flag was renamed — the prior hydrated+Once
// spelling (field and exported method) — to anyHydrateCompleted /
// AnyHydrateCompleted so it no longer implies the same completion state as the
// client's per-session delivery fact. The obsolete identifiers must be entirely
// absent from production Go source under pkg/, and the replacements must be
// present. This pins the distinct layer-specific meaning and prevents the old
// cross-layer collision from returning.
//
// The TS half — the client SyncState messagesLoaded state map renamed to
// messagesDelivered while the wire GateFacts.messagesLoaded field stays — is
// pinned in web/tests/unit/vocabulary.test.ts.
func TestVocabularyMessagesDeliveredAndAnyHydrate(t *testing.T) {
	pkgRoot, err := filepath.Abs("..") // pkg/ (this test's package dir is pkg/aggregator)
	if err != nil {
		t.Fatalf("resolve pkg root: %v", err)
	}
	// Build the obsolete tokens from fragments so this test's own source does
	// not contain the contiguous obsolete spelling (which would self-report).
	obsoleteLower := "hydrated" + "Once"
	obsoleteUpper := "Hydrated" + "Once"

	var hits []string
	sawField, sawMethod := false, false
	err = filepath.Walk(pkgRoot, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(p, ".go") {
			return nil
		}
		b, rerr := os.ReadFile(p)
		if rerr != nil {
			return rerr
		}
		src := string(b)
		rel, _ := filepath.Rel(pkgRoot, p)
		if strings.Contains(src, obsoleteLower) {
			hits = append(hits, rel+": "+obsoleteLower)
		}
		if strings.Contains(src, obsoleteUpper) {
			hits = append(hits, rel+": "+obsoleteUpper)
		}
		if strings.Contains(src, "anyHydrateCompleted") {
			sawField = true
		}
		if strings.Contains(src, "AnyHydrateCompleted") {
			sawMethod = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", pkgRoot, err)
	}
	if len(hits) > 0 {
		t.Fatalf("obsolete aggregator identifiers still present (L-02/M11 rename must be total):\n  %s", strings.Join(hits, "\n  "))
	}
	if !sawField {
		t.Error("replacement anyHydrateCompleted not found under pkg/ (rename incomplete)")
	}
	if !sawMethod {
		t.Error("replacement AnyHydrateCompleted not found under pkg/ (rename incomplete)")
	}
}
