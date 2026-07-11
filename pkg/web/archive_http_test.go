package web

import (
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"
)

// TestUnarchiveGuardWiredInHTTPPath is the HTTP-level regression guard for the
// topology guard at pkg/web/archive.go. UnarchiveGuard is unit-tested as a pure
// function in pkg/opencode/db_test.go (TestUnarchiveGuard), but nothing
// previously mounted the real /vh/unarchive handler to assert the guard is
// actually CALLED — a regression that removed or reordered the guard call at
// archive.go (e.g. moving it after the DB open / ListArchivedSessions) would
// not be caught by the pure-function test.
//
// This needs NO temp SQLite DB: the guard runs BEFORE any DB access or upstream
// HTTP call, so with OpenCode attached externally and VH_OPENCODE_DB_PATH unset,
// the handler must refuse with 502 naming the override env and the coupling doc.
// Do NOT add a positive/DB-backed case here — the unarchiveAt core is already
// covered by the pkg/opencode/db_test.go suite.
func TestUnarchiveGuardWiredInHTTPPath(t *testing.T) {
	// External topology + no DB override → guard refuses before touching any DB.
	t.Setenv("VH_OPENCODE_DB_PATH", "")
	f := &fakeOC{}
	web, _, srv := newVerbServerSrv(t, f)
	srv.SetExternalOpenCode(true)

	// CSRF-passing POST (mirrors the post() helper in verbs_test.go, but reads
	// the raw body because the guard's refusal is plain text via http.Error, not
	// a JSON body).
	req, _ := http.NewRequest(http.MethodPost, web.URL+"/vh/unarchive",
		bytes.NewBufferString(`{"sessionID":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(csrfHeader, "1") // pass the CSRF guard
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("external + unset VH_OPENCODE_DB_PATH: want 502, got %d (body=%q)",
			resp.StatusCode, body)
	}
	// The guard's refusal must name the override env and the coupling doc so an
	// operator landing on it knows the escape hatch + the contract.
	if !strings.Contains(string(body), "VH_OPENCODE_DB_PATH") {
		t.Errorf("refusal does not name VH_OPENCODE_DB_PATH: %q", body)
	}
	if !strings.Contains(string(body), "docs/architecture/opencode-sqlite-unarchive.md") {
		t.Errorf("refusal does not reference the coupling doc: %q", body)
	}
}
