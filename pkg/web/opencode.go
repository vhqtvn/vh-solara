package web

import (
	"context"
	"io"
	"net/http"
)

// OpenCode version/update hooks, wired by the daemon (which knows the binary
// and the environment OpenCode runs under). nil when OpenCode isn't managed.
type OpenCodeVersions struct {
	// Installed is the on-disk binary's version (`<bin> --version`). Running is
	// the version of the live `opencode serve` process (captured when it was
	// last started). After an update without a restart, Installed advances while
	// Running stays — that gap is what the UI prompts the user to apply.
	Installed string `json:"installed"`
	Running   string `json:"running"`
	Latest    string `json:"latest"`

	UpdateAvailable bool `json:"updateAvailable"` // a newer version than Installed exists
	RestartNeeded   bool `json:"restartNeeded"`   // Installed differs from Running
}

func (s *Server) SetOpenCodeVersion(fn func(context.Context) (installed, running, latest string, err error)) {
	s.ocVersionFn = fn
}

// SetUpdateOpenCode wires the update hook. It runs the configured update command
// streaming its output to w, and must NOT restart OpenCode — restart is a
// separate, explicit user action so the operator can confirm the new version and
// choose when to interrupt running sessions.
func (s *Server) SetUpdateOpenCode(fn func(ctx context.Context, w io.Writer) error) { s.ocUpdateFn = fn }

// GET /vh/opencode-version — installed vs running vs latest OpenCode version.
func (s *Server) handleOpenCodeVersion(w http.ResponseWriter, r *http.Request) {
	if s.ocVersionFn == nil {
		http.Error(w, "OpenCode is not managed by this server", http.StatusNotImplemented)
		return
	}
	installed, running, latest, err := s.ocVersionFn(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSONResp(w, OpenCodeVersions{
		Installed:       installed,
		Running:         running,
		Latest:          latest,
		UpdateAvailable: latest != "" && installed != "" && latest != installed,
		RestartNeeded:   installed != "" && running != "" && installed != running,
	})
}

// POST /vh/update-opencode — run the configured OpenCode update (default
// `<bin> upgrade`, or --opencode-update-cmd) in OpenCode's environment, STREAMING
// its stdout/stderr to the response so the UI can show the install log live. Does
// not restart OpenCode; the client confirms the new version and restarts
// separately. The stream is plain text, chunked, flushed as output arrives.
func (s *Server) handleUpdateOpenCode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.ocUpdateFn == nil {
		http.Error(w, "OpenCode is not managed by this server", http.StatusNotImplemented)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)

	fw := &flushWriter{w: w}
	if f, ok := w.(http.Flusher); ok {
		fw.f = f
	}
	if err := s.ocUpdateFn(r.Context(), fw); err != nil {
		// The 200 header is already sent, so surface the failure in the stream
		// itself with a sentinel the client scans for.
		_, _ = io.WriteString(fw, "\n[vh] update failed: "+err.Error()+"\n")
		return
	}
	_, _ = io.WriteString(fw, "\n[vh] update complete\n")
}

// flushWriter flushes the HTTP response after every write so the client sees the
// install log line-by-line instead of buffered to the end.
type flushWriter struct {
	w io.Writer
	f http.Flusher
}

func (fw *flushWriter) Write(p []byte) (int, error) {
	n, err := fw.w.Write(p)
	if fw.f != nil {
		fw.f.Flush()
	}
	return n, err
}
