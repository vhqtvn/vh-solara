package cmd

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/web"
)

// resetChangelogCache clears the package-level cache so tests are independent.
func resetChangelogCache() {
	ocChangelogMu.Lock()
	ocChangelogCache = nil
	ocChangelogAt = time.Time{}
	ocChangelogMu.Unlock()
}

func TestDecodeChangelog(t *testing.T) {
	t.Run("bare array", func(t *testing.T) {
		body := []byte(`[{"tag":"v1.0.0","name":"v1.0.0","sections":[{"title":"Core","items":["x"]}]}]`)
		got, err := decodeChangelog(body)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(got) != 1 || got[0].Tag != "v1.0.0" {
			t.Fatalf("got %+v", got)
		}
		if len(got[0].Sections) != 1 || got[0].Sections[0].Title != "Core" {
			t.Fatalf("sections got %+v", got[0].Sections)
		}
		if len(got[0].Sections[0].Items) != 1 || got[0].Sections[0].Items[0] != "x" {
			t.Fatalf("items got %+v", got[0].Sections[0].Items)
		}
	})

	t.Run("wrapper object releases", func(t *testing.T) {
		body := []byte(`{"releases":[{"tag":"v2.0.0"}],"meta":{"x":1}}`)
		got, err := decodeChangelog(body)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(got) != 1 || got[0].Tag != "v2.0.0" {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("wrapper object data key", func(t *testing.T) {
		body := []byte(`{"data":[{"tag":"v3.0.0"}]}`)
		got, err := decodeChangelog(body)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(got) != 1 || got[0].Tag != "v3.0.0" {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("empty body", func(t *testing.T) {
		if _, err := decodeChangelog([]byte("   ")); err == nil {
			t.Fatal("expected error for empty body")
		}
	})

	t.Run("unrecognized shape", func(t *testing.T) {
		if _, err := decodeChangelog([]byte(`"just a string"`)); err == nil {
			t.Fatal("expected error for non-array/object body")
		}
	})
}

func TestCompareSemver(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.0.0", "1.0.0", 0},
		{"1.0.0", "1.0.1", -1},
		{"1.0.1", "1.0.0", 1},
		{"1.0.0", "1.1.0", -1},
		{"1.0.0", "2.0.0", -1},
		{"v1.17.18", "1.17.18", 0}, // v-prefix tolerated
		// Pre-release sorts BEFORE its non-pre counterpart.
		{"1.0.0-beta", "1.0.0", -1},
		{"1.0.0", "1.0.0-beta", 1},
		{"1.0.0-alpha", "1.0.0-beta", -1},
		// Numeric pre-release identifiers compare NUMERICALLY, not lexically:
		// 1.0.0-beta.11 is NEWER than 1.0.0-beta.2. (A whole-string lexical
		// compare would get this wrong: "beta.11" < "beta.2".)
		{"1.0.0-beta.2", "1.0.0-beta.11", -1},
		{"1.0.0-beta.11", "1.0.0-beta.2", 1},
		// A numeric identifier sorts BEFORE a non-numeric one at the same slot.
		{"1.0.0-1", "1.0.0-alpha", -1},
		// Shorter equal-prefix identifier list sorts first.
		{"1.0.0-alpha", "1.0.0-alpha.1", -1},
		// All real OpenCode tags are 3-part (v1.17.18); no sub-3-part cases here.
	}
	for _, c := range cases {
		got := compareSemver(c.a, c.b)
		// Normalize: only sign matters for the assertion.
		if (got < 0 && c.want >= 0) || (got > 0 && c.want <= 0) || (got == 0 && c.want != 0) {
			t.Errorf("compareSemver(%q,%q)=%d want sign %d", c.a, c.b, got, c.want)
		}
	}
}

func TestFilterChangelogReleases(t *testing.T) {
	in := []rawChangelogRelease{
		{Tag: "v1.0.0"},
		{Tag: "v1.1.0"},
		{Tag: "v1.2.0"},
		{Tag: "v1.3.0"},
		{Tag: "v2.0.0"},
	}
	// Range (from, to] = (1.1.0, 2.0.0] → keep 1.2.0, 1.3.0, 2.0.0; newest first.
	got := filterChangelogReleases(in, "1.1.0", "2.0.0")
	tags := make([]string, len(got))
	for i, r := range got {
		tags[i] = r.Tag
	}
	wantTags := []string{"v2.0.0", "v1.3.0", "v1.2.0"}
	if len(tags) != len(wantTags) {
		t.Fatalf("got %v want %v", tags, wantTags)
	}
	for i := range wantTags {
		if tags[i] != wantTags[i] {
			t.Fatalf("got %v want %v", tags, wantTags)
		}
	}

	// Strict lower bound: from itself is excluded.
	got2 := filterChangelogReleases(in, "1.1.0", "1.1.0")
	if len(got2) != 0 {
		t.Fatalf("from==to should exclude all (half-open), got %d", len(got2))
	}

	// Empty bounds keep everything (newest first).
	got3 := filterChangelogReleases(in, "", "")
	if len(got3) != len(in) || got3[0].Tag != "v2.0.0" {
		t.Fatalf("empty bounds should keep all newest-first, got %+v", got3)
	}

	// Pre-release bounds use numeric identifier precedence, not lexical: the
	// range (1.0.0-beta.2, 1.0.0-beta.11] must keep beta.11 (and exclude beta.2,
	// which is the lower bound). Regression for the whole-string lexical bug.
	preIn := []rawChangelogRelease{
		{Tag: "1.0.0-beta.2"},
		{Tag: "1.0.0-beta.9"},
		{Tag: "1.0.0-beta.11"},
	}
	gotPre := filterChangelogReleases(preIn, "1.0.0-beta.2", "1.0.0-beta.11")
	if len(gotPre) != 2 || gotPre[0].Tag != "1.0.0-beta.11" || gotPre[1].Tag != "1.0.0-beta.9" {
		t.Fatalf("pre-release numeric range wrong, got %+v", gotPre)
	}
}

func TestFilterChangelogReleasesUnparseableTag(t *testing.T) {
	in := []rawChangelogRelease{
		{Tag: "not-a-version"},
		{Tag: "v1.2.0"},
	}
	// Bounded: unparseable tag dropped (can't be placed in range).
	got := filterChangelogReleases(in, "1.0.0", "2.0.0")
	if len(got) != 1 || got[0].Tag != "v1.2.0" {
		t.Fatalf("bounded should drop unparseable, got %+v", got)
	}
	// Unbounded: unparseable tag kept.
	got2 := filterChangelogReleases(in, "", "")
	if len(got2) != 2 {
		t.Fatalf("unbounded should keep unparseable, got %+v", got2)
	}
}

func TestItemMayAffectYou(t *testing.T) {
	matches := []string{
		"This is a BREAKING change",        // case-insensitive "breaking"
		"We migrated the settings folder",  // "migrat"
		"Removed the legacy flag",          // "removed"
		"Deprecated --foo",                 // "deprecat"
		"This no longer works",             // "no longer"
		"Config was replaced by a new one", // "replaced"
		"Field renamed to bar",             // "renamed"
		"You must now set FOO",             // "must now"
		"A restart is required",            // "required"
	}
	for _, s := range matches {
		if !itemMayAffectYou(s) {
			t.Errorf("expected match for %q", s)
		}
	}
	nonMatches := []string{
		"Added a nice feature",
		"Improved performance of the TUI",
		"",
	}
	for _, s := range nonMatches {
		if itemMayAffectYou(s) {
			t.Errorf("expected NO match for %q", s)
		}
	}
}

// newChangelogServer returns an httptest server serving `body` at the changelog
// URL, with an atomic hit counter so cache behavior is observable.
func newChangelogServer(t *testing.T, status int, body []byte) (*httptest.Server, *int32) {
	t.Helper()
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func TestFetchOpencodeChangelogRawCaches(t *testing.T) {
	resetChangelogCache()
	origURL := ocChangelogURL
	t.Cleanup(func() { ocChangelogURL = origURL })

	body, _ := json.Marshal([]rawChangelogRelease{{Tag: "v1.0.0"}})
	srv, hits := newChangelogServer(t, 200, body)
	ocChangelogURL = srv.URL

	ctx := context.Background()
	if _, err := fetchOpencodeChangelogRaw(ctx); err != nil {
		t.Fatalf("first fetch: %v", err)
	}
	if _, err := fetchOpencodeChangelogRaw(ctx); err != nil {
		t.Fatalf("second fetch (cache): %v", err)
	}
	if c := atomic.LoadInt32(hits); c != 1 {
		t.Fatalf("expected 1 upstream hit (cached), got %d", c)
	}
}

func TestFetchOpencodeChangelogRawErrorsNotCached(t *testing.T) {
	resetChangelogCache()
	origURL := ocChangelogURL
	t.Cleanup(func() { ocChangelogURL = origURL })

	// A server that fails the first request then succeeds. We assert the failure
	// is NOT cached by making the second call re-hit the (now-healthy) server.
	var hits int32
	goodBody, _ := json.Marshal([]rawChangelogRelease{{Tag: "v1.0.0"}})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&hits, 1)
		if n == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write(goodBody)
	}))
	t.Cleanup(srv.Close)
	ocChangelogURL = srv.URL

	ctx := context.Background()
	if _, err := fetchOpencodeChangelogRaw(ctx); err == nil {
		t.Fatal("expected error on first (failing) fetch")
	}
	// Cache must NOT hold the failure.
	got, err := fetchOpencodeChangelogRaw(ctx)
	if err != nil {
		t.Fatalf("second fetch should succeed: %v", err)
	}
	if len(got) != 1 || got[0].Tag != "v1.0.0" {
		t.Fatalf("got %+v", got)
	}
	if c := atomic.LoadInt32(&hits); c != 2 {
		t.Fatalf("expected 2 upstream hits (error not cached), got %d", c)
	}
}

func TestFetchOpencodeChangelogRawRefetchesAfterTTL(t *testing.T) {
	resetChangelogCache()
	origURL := ocChangelogURL
	t.Cleanup(func() { ocChangelogURL = origURL })

	body, _ := json.Marshal([]rawChangelogRelease{{Tag: "v1.0.0"}})
	srv, hits := newChangelogServer(t, 200, body)
	ocChangelogURL = srv.URL

	ctx := context.Background()
	if _, err := fetchOpencodeChangelogRaw(ctx); err != nil {
		t.Fatalf("first fetch: %v", err)
	}
	// Simulate TTL expiry by backdating the cache timestamp (same package).
	ocChangelogMu.Lock()
	ocChangelogAt = time.Now().Add(-ocChangelogTTL - time.Second)
	ocChangelogMu.Unlock()

	if _, err := fetchOpencodeChangelogRaw(ctx); err != nil {
		t.Fatalf("post-TTL fetch: %v", err)
	}
	if c := atomic.LoadInt32(hits); c != 2 {
		t.Fatalf("expected 2 upstream hits after TTL expiry, got %d", c)
	}
}

// TestOpencodeChangelogHeuristicGating verifies the orchestrator gates the
// "may affect you" flag to Core/SDK/Extensions sections (a Desktop item that
// matches a migration token must NOT be flagged). It avoids the network by
// pre-seeding the cache.
func TestOpencodeChangelogHeuristicGating(t *testing.T) {
	resetChangelogCache()
	seed := []rawChangelogRelease{{
		Tag: "v0.2.0",
		Sections: []rawChangelogSection{
			{Title: "Desktop", Items: []string{"Migration of the settings folder"}},
			{Title: "Core", Items: []string{
				"Removed the legacy flag",
				"Added a nice feature",
			}},
			{Title: "SDK", Items: []string{"Renamed the client option"}},
		},
	}}
	ocChangelogMu.Lock()
	ocChangelogCache = seed
	ocChangelogAt = time.Now()
	ocChangelogMu.Unlock()
	t.Cleanup(resetChangelogCache)

	got, err := OpencodeChangelog(context.Background(), "", "")
	if err != nil {
		t.Fatalf("OpencodeChangelog: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d releases", len(got))
	}
	findSec := func(title string) *web.ChangelogSection {
		for i := range got[0].Sections {
			if got[0].Sections[i].Title == title {
				return &got[0].Sections[i]
			}
		}
		return nil
	}
	// Desktop item: matches "migrat" but Desktop is excluded → NOT flagged.
	desk := findSec("Desktop")
	if desk == nil || len(desk.Items) != 1 {
		t.Fatalf("desktop section missing: %+v", got[0].Sections)
	}
	if desk.Items[0].MayAffectYou {
		t.Errorf("Desktop item must NOT be flagged (heuristic is section-gated)")
	}
	// Core "Removed …" → flagged; Core "Added …" → not flagged.
	core := findSec("Core")
	if core == nil || len(core.Items) != 2 {
		t.Fatalf("core section missing: %+v", got[0].Sections)
	}
	if !core.Items[0].MayAffectYou {
		t.Errorf("Core 'Removed' item should be flagged")
	}
	if core.Items[1].MayAffectYou {
		t.Errorf("Core 'Added' item should NOT be flagged")
	}
	// SDK "Renamed …" → flagged.
	sdk := findSec("SDK")
	if sdk == nil || len(sdk.Items) != 1 || !sdk.Items[0].MayAffectYou {
		t.Errorf("SDK 'Renamed' item should be flagged, got %+v", sdk)
	}
	// Forward-compat: highlights emitted as [] not null.
	if got[0].Highlights == nil {
		t.Errorf("Highlights should be non-nil [] (forward-compat)")
	}
}
