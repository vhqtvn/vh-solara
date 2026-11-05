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

// watchEventWait is the budget for a poller-driven SSE "changed" event.
// History (keep in sync with the fence in handleProjectSettingsWatch):
//   - 5s original budget: CI failure 2026-10-31 at exactly 5.00s.
//   - 30s since 4d612ed: gate failure 2026-11-02 at exactly 30.00s.
//
// Both signatures shared one root cause — NOT slow ticks: the handler sampled
// its baseline snapshot AFTER flushing the ": ok" readiness fence, so an edit
// landing in that gap was swallowed permanently and no budget could recover
// (full-budget timeouts are the fingerprint of a swallowed event, not a slow
// one). Fixed in f3441a14 by sampling the baseline BEFORE ": ok". 30s is kept
// purely as parallel-load headroom (measured write→event latency under a full
// `go test ./pkg/... ./cmd/` gate load: ~0.2s); a "changed" wait that consumes
// 30s post-fence means a whole-pipeline stall, not a tight budget. A reported
// 10.00s failure (2026-11-05) matched no budget this file ever had — signature
// was conflated with cmd's TestOCSpawnRacehammer 10s internal deadline.
const watchEventWait = 30 * time.Second

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
	cfgPath := filepath.Join(cfgDir, "project.jsonc")
	cfgBody := []byte(`{"agentStyles":{"x":{"label":"X"}}}`)
	if err := os.WriteFile(cfgPath, cfgBody, 0o644); err != nil {
		t.Fatal(err)
	}
	waitForChangedRearmed(t, lines, cfgPath, cfgBody)
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
	prefPath := filepath.Join(cfgDir, "preferences.local.jsonc")
	prefBody := []byte(`{"agentStyles":{"y":{"label":"Y"}}}`)
	if err := os.WriteFile(prefPath, prefBody, 0o644); err != nil {
		t.Fatal(err)
	}
	waitForChangedRearmed(t, lines, prefPath, prefBody)
}

// waitForChangedRearmed waits for the "data: changed" event, re-writing the
// file (fresh mtime = a new snapshot flip) every 2s until it arrives. The
// watch contract is LEVEL-triggered: any snapshot change between polls emits,
// so re-evidencing the edit is contract-legal and makes a single missed
// one-shot detection self-heal on the next tick instead of burning the whole
// budget blind. The baseline-before-": ok" fence (f3441a14) already
// guarantees the initial write differs from the baseline; re-arm covers any
// residual unknown swallow. The timeout message is deliberately diagnostic —
// last line seen and how long ago — so a future failure attributes the stall
// to a pipeline segment (no ticks at all → poller starved; heartbeats but no
// "changed" → detection miss; nothing since write → delivery stalled) instead
// of arriving as an unattributable full-budget signature.
func waitForChangedRearmed(t *testing.T, lines <-chan string, path string, body []byte) {
	t.Helper()
	deadline := time.After(watchEventWait)
	rearm := time.NewTicker(2 * time.Second)
	defer rearm.Stop()
	rearms := 0
	lastLine, lastAt := "", time.Now()
	fail := func() {
		t.Fatalf("timed out waiting %v for %q; last line %q seen %.1fs ago; %d re-arms",
			watchEventWait, "data: changed", lastLine, time.Since(lastAt).Seconds(), rearms)
	}
	for {
		select {
		case ln, ok := <-lines:
			if !ok {
				t.Fatalf("stream closed before seeing %q (last line %q %.1fs ago; %d re-arms)",
					"data: changed", lastLine, time.Since(lastAt).Seconds(), rearms)
			}
			lastLine, lastAt = ln, time.Now()
			if strings.Contains(ln, "data: changed") {
				return
			}
		case <-rearm.C:
			rearms++
			if err := os.WriteFile(path, body, 0o644); err != nil {
				t.Fatalf("re-arm write: %v", err)
			}
		case <-deadline:
			fail()
		}
	}
}

func waitForLine(t *testing.T, lines <-chan string, want string, d time.Duration) {
	t.Helper()
	deadline := time.After(d)
	lastLine, lastAt := "", time.Now()
	for {
		select {
		case ln, ok := <-lines:
			if !ok {
				t.Fatalf("stream closed before seeing %q (last line %q %.1fs ago)", want, lastLine, time.Since(lastAt).Seconds())
			}
			lastLine, lastAt = ln, time.Now()
			if strings.Contains(ln, want) {
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q; last line %q seen %.1fs ago", want, lastLine, time.Since(lastAt).Seconds())
		}
	}
}
