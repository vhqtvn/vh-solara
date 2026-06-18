package web

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

// In-session git actions. OpenCode exposes only read VCS (status/diff) + patch
// apply, so staging/committing/pushing shell out to git in the project
// directory. Writes require an explicit project dir (the URL's ?dir=) — we don't
// guess a cwd. CSRF is enforced by the server middleware on these POSTs.

func gitRepoDir(r *http.Request) (string, bool) {
	dir := reqDir(r)
	if dir == "" {
		return "", false
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return "", false
	}
	return dir, true
}

// runGit executes git in dir with a timeout, returning combined output.
func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return string(out), err
}

type gitFile struct {
	File     string `json:"file"`
	Index    string `json:"index"`    // staged status (X)
	Worktree string `json:"worktree"` // unstaged status (Y)
}

// GET /vh/git/status — parsed `git status --porcelain=v1 -z` + current branch.
func (s *Server) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	dir, ok := gitRepoDir(r)
	if !ok {
		http.Error(w, "open a project directory to use git actions", http.StatusBadRequest)
		return
	}
	branch, _ := runGit(r.Context(), dir, "rev-parse", "--abbrev-ref", "HEAD")
	out, err := runGit(r.Context(), dir, "status", "--porcelain=v1", "-z")
	if err != nil {
		http.Error(w, "not a git repository", http.StatusBadRequest)
		return
	}
	files := []gitFile{}
	parts := strings.Split(out, "\x00")
	for i := 0; i < len(parts); i++ {
		e := parts[i]
		if len(e) < 4 {
			continue
		}
		x, y, path := string(e[0]), string(e[1]), e[3:]
		// A rename/copy carries the new path as the next NUL field.
		if x == "R" || x == "C" {
			if i+1 < len(parts) {
				path = parts[i+1]
				i++
			}
		}
		files = append(files, gitFile{File: path, Index: x, Worktree: y})
	}
	writeJSONResp(w, map[string]any{"branch": strings.TrimSpace(branch), "files": files})
}

type gitFilesBody struct {
	Files []string `json:"files"`
	All   bool     `json:"all"`
}

func decodeGitBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	if json.NewDecoder(r.Body).Decode(v) != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return false
	}
	return true
}

func (s *Server) gitAction(w http.ResponseWriter, r *http.Request, build func(b gitFilesBody) [][]string) {
	dir, ok := gitRepoDir(r)
	if !ok {
		http.Error(w, "open a project directory to use git actions", http.StatusBadRequest)
		return
	}
	var b gitFilesBody
	if !decodeGitBody(w, r, &b) {
		return
	}
	for _, args := range build(b) {
		if out, err := runGit(r.Context(), dir, args...); err != nil {
			http.Error(w, strings.TrimSpace(out)+" ("+err.Error()+")", http.StatusBadGateway)
			return
		}
	}
	writeJSONResp(w, map[string]any{"ok": true})
}

// POST /vh/git/stage {files|all}
func (s *Server) handleGitStage(w http.ResponseWriter, r *http.Request) {
	s.gitAction(w, r, func(b gitFilesBody) [][]string {
		if b.All || len(b.Files) == 0 {
			return [][]string{{"add", "-A"}}
		}
		return [][]string{append([]string{"add", "--"}, b.Files...)}
	})
}

// POST /vh/git/unstage {files|all}
func (s *Server) handleGitUnstage(w http.ResponseWriter, r *http.Request) {
	s.gitAction(w, r, func(b gitFilesBody) [][]string {
		if b.All || len(b.Files) == 0 {
			return [][]string{{"reset", "--quiet"}}
		}
		return [][]string{append([]string{"restore", "--staged", "--"}, b.Files...)}
	})
}

// POST /vh/git/discard {files} — discard working-tree changes (destructive; the
// UI confirms first).
func (s *Server) handleGitDiscard(w http.ResponseWriter, r *http.Request) {
	s.gitAction(w, r, func(b gitFilesBody) [][]string {
		if len(b.Files) == 0 {
			return nil
		}
		// `restore` reverts tracked edits; `clean` removes untracked files. Run
		// both so a discard covers either kind.
		return [][]string{
			append([]string{"restore", "--"}, b.Files...),
			append([]string{"clean", "-fd", "--"}, b.Files...),
		}
	})
}

// POST /vh/git/commit {message}
func (s *Server) handleGitCommit(w http.ResponseWriter, r *http.Request) {
	dir, ok := gitRepoDir(r)
	if !ok {
		http.Error(w, "open a project directory to use git actions", http.StatusBadRequest)
		return
	}
	var b struct {
		Message string `json:"message"`
	}
	if !decodeGitBody(w, r, &b) {
		return
	}
	if strings.TrimSpace(b.Message) == "" {
		http.Error(w, "commit message required", http.StatusBadRequest)
		return
	}
	out, err := runGit(r.Context(), dir, "commit", "-m", b.Message)
	if err != nil {
		http.Error(w, strings.TrimSpace(out), http.StatusBadGateway)
		return
	}
	writeJSONResp(w, map[string]any{"ok": true, "output": strings.TrimSpace(out)})
}

// POST /vh/git/push
func (s *Server) handleGitPush(w http.ResponseWriter, r *http.Request) {
	dir, ok := gitRepoDir(r)
	if !ok {
		http.Error(w, "open a project directory to use git actions", http.StatusBadRequest)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	out, err := runGit(r.Context(), dir, "push")
	if err != nil {
		http.Error(w, strings.TrimSpace(out), http.StatusBadGateway)
		return
	}
	writeJSONResp(w, map[string]any{"ok": true, "output": strings.TrimSpace(out)})
}
