package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestHandleOpenCodeChangelogSuccess: a wired fetcher's releases pass through as
// {available:true, releases:[...], from, to}.
func TestHandleOpenCodeChangelogSuccess(t *testing.T) {
	srv := newTestServer(t)
	srv.SetOpencodeChangelog(func(ctx context.Context, from, to string) ([]ChangelogRelease, error) {
		if from != "1.0.0" || to != "1.2.0" {
			t.Errorf("fetcher got from=%q to=%q, want 1.0.0/1.2.0", from, to)
		}
		return []ChangelogRelease{{
			Tag: "v1.2.0", Highlights: []string{},
			Sections: []ChangelogSection{{Title: "Core", Items: []ChangelogItem{{Text: "Removed foo", MayAffectYou: true}}}},
		}}, nil
	})

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	res, err := http.Get(web.URL + "/vh/opencode-changelog?from=1.0.0&to=1.2.0")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var got ChangelogResponse
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.Available {
		t.Errorf("Available=false, want true; error=%q", got.Error)
	}
	if got.From != "1.0.0" || got.To != "1.2.0" {
		t.Errorf("from/to = %q/%q", got.From, got.To)
	}
	if len(got.Releases) != 1 || got.Releases[0].Tag != "v1.2.0" {
		t.Errorf("releases = %+v", got.Releases)
	}
	if len(got.Releases[0].Sections[0].Items) != 1 || !got.Releases[0].Sections[0].Items[0].MayAffectYou {
		t.Errorf("flag passthrough lost, got %+v", got.Releases[0].Sections[0].Items)
	}
}

// TestHandleOpenCodeChangelogFetchError: a fetcher error degrades to a clean
// {available:false} (still HTTP 200) so the SPA never sees a broken fetch.
func TestHandleOpenCodeChangelogFetchError(t *testing.T) {
	srv := newTestServer(t)
	srv.SetOpencodeChangelog(func(ctx context.Context, from, to string) ([]ChangelogRelease, error) {
		return nil, context.DeadlineExceeded
	})

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	res, err := http.Get(web.URL + "/vh/opencode-changelog?from=1.0.0&to=1.2.0")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (best-effort, always 200)", res.StatusCode)
	}
	var got ChangelogResponse
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Available {
		t.Errorf("Available=true, want false on fetch error")
	}
	if got.Error == "" {
		t.Errorf("expected a non-empty error string")
	}
	if len(got.Releases) != 0 {
		t.Errorf("expected no releases on error, got %d", len(got.Releases))
	}
}

// TestHandleOpenCodeChangelogNilFn: when no fetcher is wired (nil), the endpoint
// reports {available:false} rather than panicking — the update button is never
// gated on changelog availability.
func TestHandleOpenCodeChangelogNilFn(t *testing.T) {
	srv := newTestServer(t)
	// Deliberately do NOT call SetOpencodeChangelog.

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	res, err := http.Get(web.URL + "/vh/opencode-changelog?from=1.0.0&to=1.2.0")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var got ChangelogResponse
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Available {
		t.Errorf("Available=true, want false when no fetcher wired")
	}
}

// TestHandleOpenCodeChangelogMethodNotAllowed: only GET is allowed. A POST with
// the X-VH-CSRF header bypasses csrfGuard (which otherwise 403s unsafe methods)
// and reaches the handler's own GET-only guard, which returns 405.
func TestHandleOpenCodeChangelogMethodNotAllowed(t *testing.T) {
	srv := newTestServer(t)
	srv.SetOpencodeChangelog(func(ctx context.Context, from, to string) ([]ChangelogRelease, error) {
		return nil, nil
	})

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	req, err := http.NewRequest(http.MethodPost, web.URL+"/vh/opencode-changelog", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("X-VH-CSRF", "1") // pass csrfGuard so the handler's method guard is reached
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST status = %d, want 405", res.StatusCode)
	}
}

// TestHandleOpenCodeChangelogDefaultsFromVersionFn: when from/to are omitted, the
// handler fills them from ocVersionFn (installed/latest) so a bare request still
// returns a meaningful range.
func TestHandleOpenCodeChangelogDefaultsFromVersionFn(t *testing.T) {
	srv := newTestServer(t)
	srv.SetOpenCodeVersion(func(context.Context) (string, string, string, error) {
		return "0.9.0", "0.9.0", "1.0.0", nil // installed, running, latest
	})
	var seenFrom, seenTo string
	srv.SetOpencodeChangelog(func(ctx context.Context, from, to string) ([]ChangelogRelease, error) {
		seenFrom, seenTo = from, to
		return []ChangelogRelease{}, nil
	})

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	// No query string → both bounds default.
	res, err := http.Get(web.URL + "/vh/opencode-changelog")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if seenFrom != "0.9.0" || seenTo != "1.0.0" {
		t.Errorf("defaulted bounds = %q/%q, want 0.9.0/1.0.0", seenFrom, seenTo)
	}
}
