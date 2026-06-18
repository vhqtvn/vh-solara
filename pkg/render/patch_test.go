package render

import (
	"strings"
	"testing"
)

func TestPatchRender(t *testing.T) {
	r := New()
	patch := `diff --git a/x.go b/x.go
index 111..222 100644
--- a/x.go
+++ b/x.go
@@ -1,3 +1,3 @@
 ctx line
-old line
+new line`
	out := r.Patch(patch)
	if !strings.Contains(out, "vh-diff-hunk") {
		t.Fatalf("missing hunk header class: %s", out)
	}
	if !strings.Contains(out, "vh-diff-add") || !strings.Contains(out, "vh-diff-del") {
		t.Fatalf("missing add/del lines: %s", out)
	}
	if !strings.Contains(out, "vh-diff-meta") {
		t.Fatalf("missing meta lines: %s", out)
	}
}

func TestPatchEscapes(t *testing.T) {
	r := New()
	out := r.Patch("+<script>alert(1)</script>")
	if strings.Contains(out, "<script>") {
		t.Fatalf("patch content not escaped: %s", out)
	}
}

func TestPatchSplit(t *testing.T) {
	r := New()
	patch := `@@ -1,3 +1,3 @@
 ctx line
-old line
+new line`
	out := r.PatchSplit(patch)
	if !strings.Contains(out, "vh-diff-split") {
		t.Fatalf("missing split container: %s", out)
	}
	// A changed line pairs del (left) and add (right) in one row.
	if !strings.Contains(out, "vh-diff-row") || !strings.Contains(out, "vh-diff-del") || !strings.Contains(out, "vh-diff-add") {
		t.Fatalf("missing paired row: %s", out)
	}
	// The hunk header spans both columns.
	if !strings.Contains(out, "vh-diff-span2") {
		t.Fatalf("missing full-width hunk row: %s", out)
	}
}

func TestPatchSplitEscapes(t *testing.T) {
	r := New()
	out := r.PatchSplit("+<script>alert(1)</script>")
	if strings.Contains(out, "<script>") {
		t.Fatalf("split patch content not escaped: %s", out)
	}
}
