package web

import (
	"bufio"
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The watch SSE must emit "changed" when the project's project.jsonc appears or
// is modified, so the UI reflects an external edit without a manual reload.
func TestProjectSettingsWatchEmitsOnChange(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ws.URL+"/vh/project-settings/watch?dir="+dir, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("watch status: %d", resp.StatusCode)
	}

	lines := make(chan string, 64)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()

	// Drain the initial ": ok" comment so we don't race the first write.
	waitForLine(t, lines, "ok", 2*time.Second)

	// Create the config — the poller should notice and push a change.
	cfgDir := filepath.Join(dir, ".vh-solara")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfgDir, "project.jsonc"), []byte(`{"agentStyles":{"x":{"label":"X"}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	waitForLine(t, lines, "data: changed", 5*time.Second)
}

// The watch must ALSO fire when the gitignored preferences.local.jsonc overlay
// appears or changes — the editor reads a merge of both files, so an external
// edit to either must nudge a reload. A missing overlay is the normal starting
// state and must not fire on its own.
func TestProjectSettingsWatchEmitsOnPreferencesChange(t *testing.T) {
	ws := newWebServer(t)
	defer ws.Close()

	dir := t.TempDir()
	cfgDir := filepath.Join(dir, ".vh-solara")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ws.URL+"/vh/project-settings/watch?dir="+dir, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("watch status: %d", resp.StatusCode)
	}

	lines := make(chan string, 64)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	// Drain the initial ": ok" comment.
	waitForLine(t, lines, "ok", 2*time.Second)

	// Create the overlay (preferences.local.jsonc) — the poller watches both
	// files, so creating the overlay alone must fire even though project.jsonc
	// is absent.
	if err := os.WriteFile(filepath.Join(cfgDir, "preferences.local.jsonc"), []byte(`{"agentStyles":{"y":{"label":"Y"}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	waitForLine(t, lines, "data: changed", 5*time.Second)
}

func waitForLine(t *testing.T, lines <-chan string, want string, d time.Duration) {
	t.Helper()
	deadline := time.After(d)
	for {
		select {
		case ln, ok := <-lines:
			if !ok {
				t.Fatalf("stream closed before seeing %q", want)
			}
			if strings.Contains(ln, want) {
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q", want)
		}
	}
}
