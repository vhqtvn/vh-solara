package web

import (
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func gitT(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

func TestGitStageCommitStatus(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	gitT(t, dir, "init")
	gitT(t, dir, "config", "user.email", "t@t")
	gitT(t, dir, "config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &Server{}
	post := func(path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", path+"?dir="+dir, strings.NewReader(body))
		w := httptest.NewRecorder()
		switch {
		case strings.HasPrefix(path, "/vh/git/stage"):
			s.handleGitStage(w, req)
		case strings.HasPrefix(path, "/vh/git/commit"):
			s.handleGitCommit(w, req)
		}
		return w
	}

	// Untracked file shows up in status.
	req := httptest.NewRequest("GET", "/vh/git/status?dir="+dir, nil)
	w := httptest.NewRecorder()
	s.handleGitStatus(w, req)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "a.txt") {
		t.Fatalf("status: code=%d body=%s", w.Code, w.Body.String())
	}

	// Stage all, then commit.
	if w := post("/vh/git/stage", `{"all":true}`); w.Code != 200 {
		t.Fatalf("stage: %d %s", w.Code, w.Body.String())
	}
	if w := post("/vh/git/commit", `{"message":"init"}`); w.Code != 200 {
		t.Fatalf("commit: %d %s", w.Code, w.Body.String())
	}

	// Working tree is now clean.
	w = httptest.NewRecorder()
	s.handleGitStatus(w, httptest.NewRequest("GET", "/vh/git/status?dir="+dir, nil))
	if strings.Contains(w.Body.String(), "a.txt") {
		t.Fatalf("expected clean tree, got %s", w.Body.String())
	}

	// No dir → 400.
	w = httptest.NewRecorder()
	s.handleGitStatus(w, httptest.NewRequest("GET", "/vh/git/status", nil))
	if w.Code != 400 {
		t.Fatalf("want 400 without dir, got %d", w.Code)
	}
}
