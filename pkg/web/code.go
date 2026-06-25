package web

import (
	"context"
	"html"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/vhqtvn/vh-solara/pkg/render"
)

// Read-only codebase view. Endpoints serve the project directory (?dir=) on the
// daemon: a lazy file tree, file contents (chroma-highlighted server-side into
// class HTML so the client ships no highlighter), raw bytes (images), and a
// git-grep search. Everything is path-confined to the project dir and size-capped
// so a huge repo / file never overloads a phone.
//
// Future LSP-backed endpoints (symbols, references) would slot into this same
// /vh/code/* namespace, fronting OpenCode's language servers.

const (
	codeMaxFileBytes      = 2 << 20  // 2 MiB: refuse to read larger files
	codeHighlightMaxBytes = 512 << 10 // 512 KiB: above this serve plain (chroma is O(n))
	codeHighlightMaxLines = 6000      // and cap lines so a giant <pre> never hangs the page
	codeSearchMaxResults  = 200
	codeRawMaxBytes       = 16 << 20 // 16 MiB for image/raw serving
)

// codeDir resolves and validates the project directory from the request.
func codeDir(r *http.Request) (string, bool) {
	dir := reqDir(r)
	if dir == "" {
		return "", false
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return "", false
	}
	return dir, true
}

// safeJoin resolves rel under root, rejecting traversal (..) and symlinks that
// escape the project directory.
func safeJoin(root, rel string) (string, bool) {
	rel = strings.TrimPrefix(filepath.ToSlash(rel), "/")
	abs := filepath.Clean(filepath.Join(root, rel))
	rootClean := filepath.Clean(root)
	if abs != rootClean && !strings.HasPrefix(abs, rootClean+string(filepath.Separator)) {
		return "", false
	}
	// Block symlinks that point outside the repo (read-only, but still confine).
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		rootReal, _ := filepath.EvalSymlinks(rootClean)
		if rootReal == "" {
			rootReal = rootClean
		}
		if real != rootReal && !strings.HasPrefix(real, rootReal+string(filepath.Separator)) {
			return "", false
		}
	}
	return abs, true
}

type codeEntry struct {
	Name string `json:"name"`
	Path string `json:"path"` // rel to project dir
	Type string `json:"type"` // "dir" | "file"
}

// GET /vh/code/tree?path=<rel> — immediate children of one directory (lazy).
func (s *Server) handleCodeTree(w http.ResponseWriter, r *http.Request) {
	dir, ok := codeDir(r)
	if !ok {
		http.Error(w, "open a project directory", http.StatusBadRequest)
		return
	}
	rel := r.URL.Query().Get("path")
	abs, ok := safeJoin(dir, rel)
	if !ok {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	ents, err := os.ReadDir(abs)
	if err != nil {
		http.Error(w, "cannot read directory", http.StatusNotFound)
		return
	}
	// Candidate child rel paths, for one batched git check-ignore.
	rels := make([]string, 0, len(ents))
	for _, e := range ents {
		if e.Name() == ".git" {
			continue
		}
		rels = append(rels, filepath.ToSlash(filepath.Join(rel, e.Name())))
	}
	ignored := gitIgnored(r.Context(), dir, rels)

	out := []codeEntry{}
	for _, e := range ents {
		if e.Name() == ".git" {
			continue
		}
		childRel := filepath.ToSlash(filepath.Join(rel, e.Name()))
		if ignored[childRel] {
			continue
		}
		typ := "file"
		if e.IsDir() {
			typ = "dir"
		}
		out = append(out, codeEntry{Name: e.Name(), Path: childRel, Type: typ})
	}
	// Dirs first, then files; each alphabetical (case-insensitive).
	sort.Slice(out, func(i, j int) bool {
		if (out[i].Type == "dir") != (out[j].Type == "dir") {
			return out[i].Type == "dir"
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	writeJSON(w, http.StatusOK, jsonBytes(map[string]any{"path": rel, "entries": out}))
}

// gitIgnored returns which of rels are git-ignored (batched). Empty if not a repo.
func gitIgnored(ctx context.Context, dir string, rels []string) map[string]bool {
	ignored := map[string]bool{}
	if len(rels) == 0 {
		return ignored
	}
	cmd := exec.CommandContext(ctx, "git", "-C", dir, "check-ignore", "--stdin")
	cmd.Stdin = strings.NewReader(strings.Join(rels, "\n"))
	out, _ := cmd.Output() // exit 1 when nothing matches — fine
	for _, l := range strings.Split(string(out), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			ignored[l] = true
		}
	}
	return ignored
}

var imageExt = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true,
	".svg": true, ".ico": true, ".bmp": true, ".avif": true,
}

// GET /vh/code/file?path=<rel>&view=raw|rendered — one file's content.
func (s *Server) handleCodeFile(w http.ResponseWriter, r *http.Request) {
	dir, ok := codeDir(r)
	if !ok {
		http.Error(w, "open a project directory", http.StatusBadRequest)
		return
	}
	rel := r.URL.Query().Get("path")
	abs, ok := safeJoin(dir, rel)
	if !ok {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	st, err := os.Stat(abs)
	if err != nil || st.IsDir() {
		http.Error(w, "not a file", http.StatusNotFound)
		return
	}
	name := filepath.Base(abs)
	ext := strings.ToLower(filepath.Ext(name))
	if imageExt[ext] {
		writeJSON(w, http.StatusOK, jsonBytes(map[string]any{"kind": "image", "path": rel, "size": st.Size()}))
		return
	}
	if st.Size() > codeMaxFileBytes {
		writeJSON(w, http.StatusOK, jsonBytes(map[string]any{"kind": "toolarge", "path": rel, "size": st.Size()}))
		return
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		http.Error(w, "cannot read file", http.StatusInternalServerError)
		return
	}
	// Binary sniff: NUL byte or invalid UTF-8 → not text.
	probe := data
	if len(probe) > 8000 {
		probe = probe[:8000]
	}
	if indexByteZero(probe) || !utf8.Valid(data) {
		writeJSON(w, http.StatusOK, jsonBytes(map[string]any{"kind": "binary", "path": rel, "size": st.Size()}))
		return
	}
	src := string(data)
	lines := strings.Count(src, "\n") + 1
	lang := render.LexerName(name)
	isMd := ext == ".md" || ext == ".markdown"

	if r.URL.Query().Get("view") == "rendered" && isMd {
		writeJSON(w, http.StatusOK, jsonBytes(map[string]any{
			"kind": "markdown", "path": rel, "html": s.renderer.Markdown(src), "lang": lang, "lines": lines,
		}))
		return
	}

	// Above the highlight cap, serve plain (escaped) text — cheap, no chroma.
	if st.Size() > codeHighlightMaxBytes || lines > codeHighlightMaxLines {
		writeJSON(w, http.StatusOK, jsonBytes(map[string]any{
			"kind": "text", "path": rel, "highlighted": false, "lang": lang, "lines": lines,
			"html": "<pre class=\"code-plain\">" + html.EscapeString(src) + "</pre>",
		}))
		return
	}
	htmlStr, err := s.renderer.HighlightFile(name, src)
	if err != nil {
		htmlStr = "<pre class=\"code-plain\">" + html.EscapeString(src) + "</pre>"
	}
	writeJSON(w, http.StatusOK, jsonBytes(map[string]any{
		"kind": "text", "path": rel, "highlighted": err == nil, "lang": lang, "lines": lines,
		"isMarkdown": isMd, "html": htmlStr,
	}))
}

func indexByteZero(b []byte) bool {
	for _, c := range b {
		if c == 0 {
			return true
		}
	}
	return false
}

// GET /vh/code/raw?path=<rel> — raw bytes (images, downloads). Range-capable.
func (s *Server) handleCodeRaw(w http.ResponseWriter, r *http.Request) {
	dir, ok := codeDir(r)
	if !ok {
		http.Error(w, "open a project directory", http.StatusBadRequest)
		return
	}
	abs, ok := safeJoin(dir, r.URL.Query().Get("path"))
	if !ok {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	st, err := os.Stat(abs)
	if err != nil || st.IsDir() || st.Size() > codeRawMaxBytes {
		http.Error(w, "not servable", http.StatusNotFound)
		return
	}
	f, err := os.Open(abs)
	if err != nil {
		http.Error(w, "cannot open", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	// http.ServeContent sniffs content-type + handles range; SVG is served as text
	// by the sniffer, so set it explicitly (it's displayed in an <img>, never as a
	// document, so this is safe).
	if strings.ToLower(filepath.Ext(abs)) == ".svg" {
		w.Header().Set("Content-Type", "image/svg+xml")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, abs, st.ModTime(), f)
}

type searchHit struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

// GET /vh/code/search?q=<query>&limit= — git grep (fixed-string, case-insensitive).
func (s *Server) handleCodeSearch(w http.ResponseWriter, r *http.Request) {
	dir, ok := codeDir(r)
	if !ok {
		http.Error(w, "open a project directory", http.StatusBadRequest)
		return
	}
	q := r.URL.Query().Get("q")
	if strings.TrimSpace(q) == "" {
		writeJSON(w, http.StatusOK, jsonBytes(map[string]any{"hits": []searchHit{}}))
		return
	}
	limit := codeSearchMaxResults
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n < codeSearchMaxResults {
		limit = n
	}
	// -I skip binary, -n line numbers, -F fixed string, -i case-insensitive,
	// --no-color, -e <query> (so a leading '-' isn't treated as a flag).
	args := []string{"grep", "--untracked", "-I", "-n", "-F", "-i", "--no-color", "-e", q}
	// Optional focus folder: scope the search to a subtree via a pathspec.
	if scope := strings.TrimPrefix(filepath.ToSlash(r.URL.Query().Get("path")), "/"); scope != "" {
		if _, ok := safeJoin(dir, scope); ok {
			args = append(args, "--", scope)
		}
	}
	// --untracked also searches new files not yet committed (still respects
	// .gitignore), so the search matches what the tree shows.
	out, _ := runGit(r.Context(), dir, args...)
	hits := []searchHit{}
	for _, line := range strings.Split(out, "\n") {
		if line == "" || len(hits) >= limit {
			break
		}
		// path:line:text  (path may contain ':' only if quoted; tracked paths don't)
		a := strings.SplitN(line, ":", 3)
		if len(a) < 3 {
			continue
		}
		ln, err := strconv.Atoi(a[1])
		if err != nil {
			continue
		}
		text := a[2]
		if len(text) > 400 {
			text = text[:400]
		}
		hits = append(hits, searchHit{Path: filepath.ToSlash(a[0]), Line: ln, Text: text})
	}
	writeJSON(w, http.StatusOK, jsonBytes(map[string]any{"hits": hits, "capped": len(hits) >= limit}))
}

// GET /vh/code/styles — available chroma highlight styles (for the picker).
func (s *Server) handleCodeStyles(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, jsonBytes(map[string]any{
		"styles": render.StyleNames(), "default": render.DefaultStyle,
	}))
}

// GET /vh/code/highlight.css?style=<name> — one chroma style, scoped to .code-hl,
// so picking a style only re-themes the code view.
func (s *Server) handleCodeHighlightCSS(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("style")
	css, err := s.renderer.StyleCSS(name, ".code-hl")
	if err != nil || css == "" {
		http.Error(w, "unknown style", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write([]byte(css))
}
