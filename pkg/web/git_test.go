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

// TestConfineGitFiles pins the path-confinement gate that git file arguments
// (b.Files) must pass before reaching git. Mirrors code_security_test.go's
// safeJoin coverage: a legit in-repo path is accepted (and normalized), while
// ".." traversal and an escaping symlink are rejected so they are never passed
// to git.
func TestConfineGitFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Legit in-repo path is accepted and normalized to a repo-relative slash path.
	got, ok := confineGitFiles(root, []string{"sub/a.txt"})
	if !ok || len(got) != 1 || got[0] != "sub/a.txt" {
		t.Fatalf("confineGitFiles(legit) = %v, %v (want [sub/a.txt], true)", got, ok)
	}

	// ".." traversal is rejected (not passed to git).
	if _, ok := confineGitFiles(root, []string{"../escape.txt"}); ok {
		t.Error("confineGitFiles accepted a parent-traversal path")
	}
	// A legit path mixed with a bad one rejects the whole request.
	if _, ok := confineGitFiles(root, []string{"sub/a.txt", "../../etc/passwd"}); ok {
		t.Error("confineGitFiles accepted a batch containing a traversal path")
	}

	// A symlink that escapes the repo is rejected.
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("s"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	if _, ok := confineGitFiles(root, []string{"escape/secret"}); ok {
		t.Error("confineGitFiles accepted a path through an escaping symlink")
	}
}

// TestGitStageRejectsTraversal proves the confinement gate is wired into the
// stage handler end-to-end: a legit file path is staged (200), while a
// traversal path is rejected with 400 before git runs.
func TestGitStageRejectsTraversal(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	gitT(t, dir, "init")
	gitT(t, dir, "config", "user.email", "t@t")
	gitT(t, dir, "config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &Server{}
	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/vh/git/stage?dir="+dir, strings.NewReader(body))
		w := httptest.NewRecorder()
		s.handleGitStage(w, req)
		return w
	}

	// Legit file path → staged (200).
	if w := post(`{"files":["a.txt"]}`); w.Code != 200 {
		t.Fatalf("legit stage: code=%d body=%s", w.Code, w.Body.String())
	}
	// Traversal path → rejected (400), never reaches git.
	if w := post(`{"files":["../../etc/passwd"]}`); w.Code != 400 {
		t.Fatalf("traversal stage: code=%d, want 400", w.Code)
	}
}
