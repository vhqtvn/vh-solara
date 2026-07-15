package web

import (
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/projectcfg"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// Attachments are stored under the project's own tree so OpenCode (which reads
// file:// URLs from disk) can pick them up:
//
//	<projectRoot>/.vh-solara/sessions/<sessionID>/attachments/<timestamp>_<name>
//
// The .vh-solara folder holds local-only data; the user is expected to
// gitignore it in their project.

const maxAttachBytes = 32 << 20 // 32 MiB per file

var safeID = regexp.MustCompile(`[^A-Za-z0-9_.-]`)

// projectRoot resolves a project directory to an absolute filesystem root. The
// default project ("") maps to the daemon's cwd (the OpenCode serve cwd).
func projectRoot(dir string) (string, error) {
	if dir == "" {
		return os.Getwd()
	}
	return filepath.Abs(dir)
}

// POST /vh/attach?session=<id>  (multipart form, field "file") — save an upload
// into the project's .vh-solara attachments dir and return a file part the
// client can include in the next message.
func (s *Server) handleAttach(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	sid := safeID.ReplaceAllString(r.URL.Query().Get("session"), "")
	if sid == "" {
		http.Error(w, "session required", http.StatusBadRequest)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxAttachBytes+1<<20)
	if err := r.ParseMultipartForm(maxAttachBytes); err != nil {
		http.Error(w, "invalid upload: "+err.Error(), http.StatusBadRequest)
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "file field required", http.StatusBadRequest)
		return
	}
	defer file.Close()

	root, err := projectRoot(reqDir(r))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	dir := filepath.Join(root, ".vh-solara", "sessions", sid, "attachments")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// Ensure .vh-solara/.gitignore covers runtime data. Non-managed projects
	// (no project.jsonc) never reach EnsureLocalSetup, so this is their entry
	// point. Best-effort: a failure is logged and never blocks the upload.
	if err := projectcfg.EnsureRuntimeGitignore(filepath.Join(root, ".vh-solara")); err != nil {
		vhlog.Warn("attach: ensure .vh-solara/.gitignore failed", "dir", root, "err", err)
	}

	name := filepath.Base(hdr.Filename)
	name = safeID.ReplaceAllString(name, "_")
	if name == "" || name == "." {
		name = "file"
	}
	fname := time.Now().Format("20060102-150405") + "_" + name
	dst := filepath.Join(dir, fname)
	out, err := os.Create(dst)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if _, err := io.Copy(out, file); err != nil {
		out.Close()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out.Close()

	mimeType := hdr.Header.Get("Content-Type")
	if mimeType == "" || mimeType == "application/octet-stream" {
		if byExt := mime.TypeByExtension(filepath.Ext(name)); byExt != "" {
			mimeType = byExt
		}
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	writeJSONResp(w, map[string]any{
		"type":     "file",
		"url":      fileURL(dst),
		"filename": name,
		"mime":     mimeType,
		"path":     dst,
	})
}

// fileURL builds a file:// URL from an absolute path (forward slashes, escaped).
func fileURL(absPath string) string {
	p := filepath.ToSlash(absPath)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p // Windows drive paths -> file:///C:/...
	}
	u := url.URL{Scheme: "file", Path: p}
	return u.String()
}
