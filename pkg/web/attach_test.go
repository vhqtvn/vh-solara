package web

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Same-second, same-basename uploads must not silently overwrite each other:
// two screenshot.png picked in one multi-select used to mint the identical
// `<seconds-timestamp>_<name>` stored path and os.Create truncated on
// collision, so both chips referenced the SECOND file's bytes. The stored name
// is now unique within the second (deterministic _1/_2… suffix, O_EXCL — never
// truncates). The client-visible `filename` field is intentionally unchanged.

func postAttach(t *testing.T, s *Server, dir, session, filename, content string) map[string]any {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "/vh/attach?session="+session+"&dir="+dir, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	s.handleAttach(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("attach %q: status %d: %s", filename, rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("attach %q: bad JSON: %v", filename, err)
	}
	return resp
}

// TestAttachSameSecondSameNameDistinctPaths — handler-level proof: two
// same-name uploads land at DISTINCT stored paths with BOTH files' bytes
// intact (the pre-fix behavior truncated the first file).
func TestAttachSameSecondSameNameDistinctPaths(t *testing.T) {
	root := t.TempDir()
	s := &Server{}
	first := postAttach(t, s, root, "s1", "screenshot.png", "FIRST-BYTES")
	second := postAttach(t, s, root, "s1", "screenshot.png", "SECOND-BYTES")

	p1, _ := first["path"].(string)
	p2, _ := second["path"].(string)
	if p1 == "" || p2 == "" {
		t.Fatalf("missing path in responses: %q vs %q", p1, p2)
	}
	if p1 == p2 {
		t.Fatalf("same-second same-name uploads collided: both stored at %q", p1)
	}

	// Both files' bytes intact at their own stored paths — the crux (pre-fix,
	// the first file held SECOND-BYTES after the truncate).
	b1, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(p1)))
	if err != nil {
		t.Fatalf("read first: %v", err)
	}
	b2, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(p2)))
	if err != nil {
		t.Fatalf("read second: %v", err)
	}
	if string(b1) != "FIRST-BYTES" || string(b2) != "SECOND-BYTES" {
		t.Fatalf("bytes not intact: first=%q second=%q", b1, b2)
	}

	// The client-visible name is unchanged for both (the fix targets the
	// STORED path only).
	if first["filename"] != "screenshot.png" || second["filename"] != "screenshot.png" {
		t.Fatalf("filename field changed: %v / %v", first["filename"], second["filename"])
	}
}

// TestCreateUniqueAttachSuffixAndFallback — deterministic (fixed clock) cells
// for the stored-name minting: base name kept for the first upload, monotonic
// _N suffix on same-second collision, nanosecond fallback once the suffix
// budget is exhausted, and never a truncate.
func TestCreateUniqueAttachSuffixAndFallback(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	base := now.Format("20060102-150405") + "_shot.png"

	// First upload: the classic base name, unchanged shape.
	f1, p1, err := createUniqueAttach(dir, "shot.png", now)
	if err != nil {
		t.Fatal(err)
	}
	f1.Close()
	if filepath.Base(p1) != base {
		t.Fatalf("first upload should keep the base name, got %q", filepath.Base(p1))
	}

	// Same second, same name: deterministic _1 suffix.
	f2, p2, err := createUniqueAttach(dir, "shot.png", now)
	if err != nil {
		t.Fatal(err)
	}
	f2.Close()
	if filepath.Base(p2) != base+"_1" {
		t.Fatalf("second upload should get the _1 suffix, got %q", filepath.Base(p2))
	}

	// Pre-existing file content is never truncated: seed base.._63, then the
	// 64th-plus call must fall back to the nanosecond-stamped name.
	seed := "PRE-EXISTING"
	if err := os.WriteFile(filepath.Join(dir, base), []byte(seed), 0o644); err != nil {
		t.Fatal(err)
	}
	for i := 1; i < 64; i++ {
		p := filepath.Join(dir, fmt.Sprintf("%s_%d", base, i))
		if err := os.WriteFile(p, []byte(seed), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	fn, pn, err := createUniqueAttach(dir, "shot.png", now)
	if err != nil {
		t.Fatal(err)
	}
	fn.Close()
	got := filepath.Base(pn)
	if !strings.HasPrefix(got, base+"_") {
		t.Fatalf("fallback should stay namespaced under the base, got %q", got)
	}
	if got == base || got == fmt.Sprintf("%s_%d", base, 1) {
		t.Fatalf("fallback reused a collided name: %q", got)
	}
	// Nanosecond names carry 19-digit UnixNano — far beyond the ≤2-digit
	// monotonic suffixes seeded above.
	if !strings.HasSuffix(got, "000000000") { // zero-nanosecond fixed clock
		t.Fatalf("expected the fixed clock's nanosecond fallback, got %q", got)
	}
	// The seeded base file was not truncated.
	b, err := os.ReadFile(filepath.Join(dir, base))
	if err != nil || string(b) != seed {
		t.Fatalf("pre-existing file altered: %q, %v", b, err)
	}
}
