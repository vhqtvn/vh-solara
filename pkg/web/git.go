package web

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// In-session git actions. OpenCode exposes only read VCS (status/diff) + patch
// apply, so staging/committing/pushing shell out to git in the project
// directory. Writes require an explicit project dir (the URL's ?dir=) — we don't
// guess a cwd. CSRF is enforced by the server middleware on these POSTs.

// gitCommandTimeout is the standard per-command bound for every git op EXCEPT
// push (see gitPushTimeout). A commit/status/stage is a fast LOCAL operation
// (objects + a ref update); only pathological hooks/gc could make one slow,
// and killing it leaves the index staged — recoverable, not duplicated.
//
// It is a var (not a const) ONLY as the test seam: the bound is deliberately
// NOT operator-configurable (unlike push's env), so tests shrink it to
// exercise bound-expiry (TestGitCommitBoundKills). Production default 30s.
var gitCommandTimeout = 30 * time.Second

// defaultGitPushTimeout replaces the universal 30s kill for PUSH specifically
// (send-net-resilience slice 6, debate-2 Q3). Rationale: pushes move real
// payloads over real links — 50 MB over a 2 Mbps weak link is ~200s, well
// past the old 30s cap that killed legitimately-slow pushes mid-transfer and
// surfaced them as 502 "failures" for a push that may have landed. 5 minutes
// covers multi-hundred-MB pushes on decent links and tens-of-MB on very slow
// ones, while still bounding a hung socket (the bound is never removed — a
// bound-expiry is answered with an honest 504 outcome-unknown, and a push
// RETRY is benign: git re-pushes or reports "Everything up-to-date").
// Operators with routinely-larger pushes override via the env below.
const defaultGitPushTimeout = 5 * time.Minute

// gitPushTimeoutEnv configures the push bound in seconds (additive config,
// default ON). Zero/negative/garbage values fall back to the default — the
// bound cannot be silently disabled.
const gitPushTimeoutEnv = "VH_GIT_PUSH_TIMEOUT_SECS"

func gitPushTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv(gitPushTimeoutEnv)); v != "" {
		if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
			return time.Duration(secs) * time.Second
		}
		log.Printf("[git] invalid %s=%q; using default %s", gitPushTimeoutEnv, v, defaultGitPushTimeout)
	}
	return defaultGitPushTimeout
}

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

// runGit executes git in dir with the standard per-command bound, returning
// combined output.
func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	return runGitCtx(ctx, dir, args...)
}

// runGitCtx executes git in dir under an EXISTING caller-owned context with
// no inner bound — the caller owns cancellation (the push bound).
func runGitCtx(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	// WaitDelay bounds the pipe-drain after a context kill: git's children
	// (hooks, credential helpers, ssh) inherit stdout/stderr and can outlive
	// the killed parent, which would otherwise hang CombinedOutput until the
	// LAST grandchild exits (observed: a bound-killed push waiting out a
	// sleeping pre-push hook). After the kill, wait at most this long for the
	// pipes, then return with the collected output.
	cmd.WaitDelay = 2 * time.Second
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

// confineGitFiles validates client-supplied file pathspecs against the repo
// root, rejecting any that traverse ".." or escape via a symlink. On success it
// returns the paths normalized to repo-relative (slash) form suitable for
// `git <cmd> -- <path>...`; on any escape it returns ok=false so the caller
// rejects the whole request before git runs. Mirrors pkg/web/code.go's safeJoin
// confinement (rejects ".." AND symlink escape via EvalSymlinks).
func confineGitFiles(dir string, files []string) ([]string, bool) {
	out := make([]string, 0, len(files))
	for _, f := range files {
		abs, ok := safeJoin(dir, f)
		if !ok {
			return nil, false
		}
		rel, err := filepath.Rel(dir, abs)
		if err != nil {
			return nil, false
		}
		out = append(out, filepath.ToSlash(rel))
	}
	return out, true
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
	// Confine per-file pathspecs to the repo (reject ".." traversal and symlinks
	// that escape) before they reach git. git is invoked argv-only (no shell)
	// and the build closures always emit a "--" separator, so this is
	// defense-in-depth parity with the code view's safeJoin (code.go), not a fix
	// for a present shell-injection hole. b.All operates tree-wide (add -A /
	// reset) and carries no per-file pathspec to confine.
	if !b.All {
		confined, ok := confineGitFiles(dir, b.Files)
		if !ok {
			http.Error(w, "file path escapes repository", http.StatusBadRequest)
			return
		}
		b.Files = confined
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

// POST /vh/git/commit {message} — under the same standard bound as every
// other local git op, but with the push-style honesty contract (slice-6 gate
// round 3, B-F3): a commit killed by the bound is outcome-UNKNOWN — the kill
// can land after the ref update but before the response — so bound-expiry
// answers 504 with outcome-unknown wording, NOT the generic 502 "failure"
// (the same may-have-landed dishonesty the push 504 exists to fix). Unlike
// push, a retry is NOT unconditionally benign (a landed-but-unconfirmed
// commit plus a retry mints a second commit), so the wording points at
// status/log reconciliation — the FE ward flow handles the rest. Non-deadline
// failures keep the legacy 502 + trimmed git output shape. The handler
// derives its own bounded context (like push) so DeadlineExceeded surfaces —
// runGit's PRIVATE inner context cannot be distinguished from other errors
// by the caller.
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
	timeout := gitCommandTimeout
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	out, err := runGitCtx(ctx, dir, "commit", "-m", b.Message)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			http.Error(w,
				fmt.Sprintf("git commit exceeded the %s bound and was cancelled — outcome unknown: the commit may or may not have landed. Check status and the recent-commits log before retrying; the staged files survive either way.", timeout),
				http.StatusGatewayTimeout)
			return
		}
		http.Error(w, strings.TrimSpace(out), http.StatusBadGateway)
		return
	}
	writeJSONResp(w, map[string]any{"ok": true, "output": strings.TrimSpace(out)})
}

// POST /vh/git/push — under the operation-specific push bound (slice 6), NOT
// the universal 30s kill. A bound-expiry is answered with an honest 504: the
// push was cancelled mid-flight and its outcome is UNKNOWN (the ref may or
// may not have been updated remotely) — never a plain "failed". The FE maps
// 5xx to outcome-uncertain; a push retry is benign either way.
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
	timeout := gitPushTimeout()
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	out, err := runGitCtx(ctx, dir, "push")
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			http.Error(w,
				fmt.Sprintf("git push exceeded the %s bound and was cancelled — outcome unknown: the push may have partially completed. Retrying a push is safe (git re-pushes or reports up-to-date).", timeout),
				http.StatusGatewayTimeout)
			return
		}
		http.Error(w, strings.TrimSpace(out), http.StatusBadGateway)
		return
	}
	writeJSONResp(w, map[string]any{"ok": true, "output": strings.TrimSpace(out)})
}

type gitLogEntry struct {
	Hash    string `json:"hash"`
	Subject string `json:"subject"`
	Date    string `json:"date"`
}

// GET /vh/git/log?n=5 — recent commits, newest first, for the slice-6
// reconciliation surface (an unconfirmed commit is adjudicated by LOOKING:
// does the drafted message appear in the log, and did the staged files
// clear). Read-only; n is clamped to [1,20]. An unborn branch (no commits
// yet) is a VALID empty log — the reconciliation signal that a commit did
// NOT land — not an error.
func (s *Server) handleGitLog(w http.ResponseWriter, r *http.Request) {
	dir, ok := gitRepoDir(r)
	if !ok {
		http.Error(w, "open a project directory to use git actions", http.StatusBadRequest)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	n := 5
	if v := r.URL.Query().Get("n"); v != "" {
		if p, err := strconv.Atoi(v); err == nil {
			n = p
		}
	}
	if n < 1 {
		n = 1
	}
	if n > 20 {
		n = 20
	}
	// %x1f (unit separator) delimits hash/subject/date — subjects may contain
	// any printable text, including commas and quotes.
	out, err := runGit(r.Context(), dir, "log", "-n", strconv.Itoa(n), "--pretty=format:%H%x1f%s%x1f%ci")
	if err != nil {
		if strings.Contains(out, "does not have any commits yet") {
			writeJSONResp(w, map[string]any{"commits": []gitLogEntry{}})
			return
		}
		http.Error(w, "not a git repository", http.StatusBadRequest)
		return
	}
	commits := []gitLogEntry{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\x1f", 3)
		if len(parts) != 3 {
			continue
		}
		commits = append(commits, gitLogEntry{Hash: parts[0], Subject: parts[1], Date: parts[2]})
	}
	writeJSONResp(w, map[string]any{"commits": commits})
}
