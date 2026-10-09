package web

// Git-safety slice (send-net-resilience slice 6, debate-2 Q3): the push
// operation-specific bound + the read-only reconciliation log endpoint.
// Gate round 3 (B-F3 + defer B-F2) extends the honesty contract to COMMIT:
// a commit killed by the standard 30s bound answers 504 outcome-unknown.
//
// Under test:
//   - gitPushTimeout: default 5m (replaces the universal 30s kill for PUSH
//     only), VH_GIT_PUSH_TIMEOUT_SECS override, garbage → default.
//   - handleGitPush under a bound that fires: honest 504 naming the bound and
//     the unknown outcome — NOT the old 502-with-git-output shape.
//   - handleGitCommit under a bound that fires (B-F3): the SAME honesty
//     contract — 504 outcome-unknown, not the generic 502 "failure" (the
//     kill can land after the ref update but before the response). A
//     non-deadline git failure keeps the legacy 502 shape byte-identically.
//   - handleGitLog: newest-first entries, n clamped, unborn branch = valid
//     EMPTY log (reconciliation signal: the commit did not land), no dir 400.

import (
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGitPushTimeoutConfig(t *testing.T) {
	t.Run("default is 5 minutes (the universal 30s kill no longer applies to push)", func(t *testing.T) {
		if got := gitPushTimeout(); got != 5*time.Minute {
			t.Fatalf("gitPushTimeout() = %v, want 5m", got)
		}
	})
	t.Run("VH_GIT_PUSH_TIMEOUT_SECS overrides", func(t *testing.T) {
		t.Setenv("VH_GIT_PUSH_TIMEOUT_SECS", "7")
		if got := gitPushTimeout(); got != 7*time.Second {
			t.Fatalf("gitPushTimeout() = %v, want 7s", got)
		}
	})
	t.Run("garbage falls back to the default (bound always ON)", func(t *testing.T) {
		t.Setenv("VH_GIT_PUSH_TIMEOUT_SECS", "not-a-number")
		if got := gitPushTimeout(); got != 5*time.Minute {
			t.Fatalf("gitPushTimeout() = %v, want 5m default", got)
		}
	})
	t.Run("zero/negative falls back to the default (cannot disable the bound)", func(t *testing.T) {
		t.Setenv("VH_GIT_PUSH_TIMEOUT_SECS", "0")
		if got := gitPushTimeout(); got != 5*time.Minute {
			t.Fatalf("gitPushTimeout() = %v, want 5m default", got)
		}
	})
}

// TestGitPushBoundKills proves the per-op push bound end-to-end with REAL
// git: a pre-push hook that outlives a 1s configured bound is killed AT the
// bound and answered with an honest 504 (outcome unknown), not a 502 git
// failure. The kill timing (>= bound, << hook sleep) proves the bound — not
// the hook — ended the command.
func TestGitPushBoundKills(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh not available (pre-push hook needs a shell)")
	}
	base := t.TempDir()
	origin := filepath.Join(base, "origin.git")
	gitT(t, base, "init", "--bare", origin)
	dir := filepath.Join(base, "repo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	gitT(t, dir, "init")
	gitT(t, dir, "config", "user.email", "t@t")
	gitT(t, dir, "config", "user.name", "t")
	gitT(t, dir, "remote", "add", "origin", origin)
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitT(t, dir, "add", "a.txt")
	gitT(t, dir, "commit", "-m", "init")
	// Establish the upstream BEFORE installing the hook: plain `git push`
	// refuses upstream-less branches before any hook runs (and the hook would
	// sleep past the test's patience).
	gitT(t, dir, "push", "-u", "origin", "HEAD")
	// A pre-push hook that sleeps far past the configured bound.
	hook := filepath.Join(dir, ".git", "hooks", "pre-push")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nsleep 10\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("VH_GIT_PUSH_TIMEOUT_SECS", "1")
	s := &Server{}
	req := httptest.NewRequest("POST", "/vh/git/push?dir="+dir, nil)
	w := httptest.NewRecorder()
	start := time.Now()
	s.handleGitPush(w, req)
	elapsed := time.Since(start)

	if w.Code != 504 {
		t.Fatalf("push bound-kill: code=%d body=%s, want 504", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, "outcome unknown") || !strings.Contains(body, "bound") {
		t.Fatalf("push bound-kill body must name the bound and the unknown outcome, got: %s", body)
	}
	if elapsed < 1*time.Second {
		t.Fatalf("push returned in %v, before the 1s bound fired", elapsed)
	}
	if elapsed >= 10*time.Second {
		t.Fatalf("push waited %v — the bound did not kill the hook-hung command", elapsed)
	}
}

// TestGitPushUnderBoundSucceeds pins the non-intervention side of the bound:
// a push that finishes inside the bound behaves exactly as before (200 + ok).
func TestGitPushUnderBoundSucceeds(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	base := t.TempDir()
	origin := filepath.Join(base, "origin.git")
	gitT(t, base, "init", "--bare", origin)
	dir := filepath.Join(base, "repo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	gitT(t, dir, "init")
	gitT(t, dir, "config", "user.email", "t@t")
	gitT(t, dir, "config", "user.name", "t")
	gitT(t, dir, "remote", "add", "origin", origin)
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitT(t, dir, "add", "a.txt")
	gitT(t, dir, "commit", "-m", "init")
	gitT(t, dir, "push", "-u", "origin", "HEAD")

	s := &Server{}
	req := httptest.NewRequest("POST", "/vh/git/push?dir="+dir, nil)
	w := httptest.NewRecorder()
	s.handleGitPush(w, req)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"ok":true`) {
		t.Fatalf("push under bound: code=%d body=%s, want 200 ok", w.Code, w.Body.String())
	}
}

// TestGitCommitBoundKills (slice-6 gate round 3, B-F3 + defer B-F2) proves the
// commit bound-expiry honesty contract with REAL git, mirroring
// TestGitPushBoundKills: a pre-commit hook that outlives a shrunk standard
// bound is killed AT the bound and answered with an honest 504 (outcome
// unknown), not the generic 502 git failure. The kill can land after the ref
// update but before the response — the same may-have-landed dishonesty the
// push 504 exists to fix. The standard bound is production-fixed at 30s (no
// env override, unlike push), so the test shrinks the package-level var —
// the sanctioned seam; the handler under test reads the same var runGit does.
func TestGitCommitBoundKills(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh not available (pre-commit hook needs a shell)")
	}
	base := t.TempDir()
	dir := filepath.Join(base, "repo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	gitT(t, dir, "init")
	gitT(t, dir, "config", "user.email", "t@t")
	gitT(t, dir, "config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitT(t, dir, "add", "a.txt")
	gitT(t, dir, "commit", "-m", "init")
	// A second change, staged, so the commit carries real work into the hook.
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitT(t, dir, "add", "a.txt")
	// A pre-commit hook that sleeps far past the shrunk bound.
	hook := filepath.Join(dir, ".git", "hooks", "pre-commit")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nsleep 10\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	orig := gitCommandTimeout
	gitCommandTimeout = 1 * time.Second
	t.Cleanup(func() { gitCommandTimeout = orig })

	s := &Server{}
	req := httptest.NewRequest("POST", "/vh/git/commit?dir="+dir, strings.NewReader(`{"message":"second"}`))
	w := httptest.NewRecorder()
	start := time.Now()
	s.handleGitCommit(w, req)
	elapsed := time.Since(start)

	if w.Code != 504 {
		t.Fatalf("commit bound-kill: code=%d body=%s, want 504", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, "outcome unknown") || !strings.Contains(body, "bound") {
		t.Fatalf("commit bound-kill body must name the bound and the unknown outcome, got: %s", body)
	}
	if elapsed < 1*time.Second {
		t.Fatalf("commit returned in %v, before the 1s bound fired", elapsed)
	}
	if elapsed >= 10*time.Second {
		t.Fatalf("commit waited %v — the bound did not kill the hook-hung command", elapsed)
	}
}

// TestGitCommitNonDeadlineErrorStays502 pins the other side of B-F3: only
// bound-expiry is reclassified. A commit that fails for a NON-deadline reason
// (nothing staged → git exits 1 with output) keeps the legacy 502 + trimmed
// git output shape byte-identically.
func TestGitCommitNonDeadlineErrorStays502(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	gitT(t, dir, "init")
	gitT(t, dir, "config", "user.email", "t@t")
	gitT(t, dir, "config", "user.name", "t")

	s := &Server{}
	req := httptest.NewRequest("POST", "/vh/git/commit?dir="+dir, strings.NewReader(`{"message":"nothing in index"}`))
	w := httptest.NewRecorder()
	s.handleGitCommit(w, req)
	if w.Code != 502 || !strings.Contains(w.Body.String(), "nothing to commit") {
		t.Fatalf("commit non-deadline failure: code=%d body=%s, want 502 with git output", w.Code, w.Body.String())
	}
}

// TestGitLog exercises the reconciliation read: newest-first entries, n
// clamping, unborn branch as a VALID empty log, and the dir/method gates.
func TestGitLog(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	gitT(t, dir, "init")
	gitT(t, dir, "config", "user.email", "t@t")
	gitT(t, dir, "config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitT(t, dir, "add", "a.txt")
	gitT(t, dir, "commit", "-m", "first subject, with a comma")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitT(t, dir, "add", "a.txt")
	gitT(t, dir, "commit", "-m", "second subject")

	s := &Server{}
	get := func(q string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.handleGitLog(w, httptest.NewRequest("GET", "/vh/git/log"+q, nil))
		return w
	}

	// n=1 → just the newest commit.
	w := get("?dir=" + dir + "&n=1")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "second subject") || strings.Contains(w.Body.String(), "first subject") {
		t.Fatalf("log n=1: code=%d body=%s", w.Code, w.Body.String())
	}

	// Oversized n clamps to the 20 cap without error (2 exist → both).
	w = get("?dir=" + dir + "&n=99")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "first subject, with a comma") {
		t.Fatalf("log n=99 (clamped): code=%d body=%s", w.Code, w.Body.String())
	}

	// Unborn branch (fresh repo, no commits) is a VALID empty log — the
	// reconciliation signal that a commit did NOT land, not an error.
	fresh := t.TempDir()
	gitT(t, fresh, "init")
	w = get("?dir=" + fresh)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"commits":[]`) {
		t.Fatalf("log unborn: code=%d body=%s, want 200 empty commits", w.Code, w.Body.String())
	}

	// No dir → 400.
	if w := get(""); w.Code != 400 {
		t.Fatalf("log without dir: code=%d, want 400", w.Code)
	}

	// Non-GET → 405.
	req := httptest.NewRequest("POST", "/vh/git/log?dir="+dir, nil)
	w = httptest.NewRecorder()
	s.handleGitLog(w, req)
	if w.Code != 405 {
		t.Fatalf("log POST: code=%d, want 405", w.Code)
	}
}
