package web

import (
	"context"
	"net/http"
	"strings"
)

// ChangelogItem is one bullet under a release section. MayAffectYou is the
// best-effort heuristic flag, set ONLY for items in Core/SDK/Extensions sections
// whose text matches a breaking/migration token. It is a HINT, never
// authoritative — OpenCode's changelog has no machine-readable breaking marker,
// so this must never be labelled "BREAKING".
type ChangelogItem struct {
	Text         string `json:"text"`
	MayAffectYou bool   `json:"mayAffectYou"`
}

// ChangelogSection groups items under a titled section (Core, SDK, Extensions,
// Desktop, TUI, …). Unknown titles are rendered as a normal section by the SPA.
type ChangelogSection struct {
	Title string          `json:"title"`
	Items []ChangelogItem `json:"items"`
}

// ChangelogRelease is one OpenCode release within the requested semver range
// (installed < tag <= latest), ordered newest first. Highlights is a
// forward-compatible field (empty today) the SPA renders at the top of a release
// if non-empty; it is always serialized (as [] when empty) so the field is never
// silently dropped.
type ChangelogRelease struct {
	Tag        string             `json:"tag"`
	Name       string             `json:"name"`
	Date       string             `json:"date,omitempty"`
	URL        string             `json:"url,omitempty"`
	Highlights []string           `json:"highlights"`
	Sections   []ChangelogSection `json:"sections"`
}

// ChangelogResponse is the response for GET /vh/opencode-changelog. Available is
// the single discriminator: when false, the fetch/parse failed and the SPA shows
// a quiet "Changelog unavailable" line. The update button is NEVER gated on this.
type ChangelogResponse struct {
	Available bool               `json:"available"`
	From      string             `json:"from,omitempty"`
	To        string             `json:"to,omitempty"`
	Releases  []ChangelogRelease `json:"releases,omitempty"`
	Error     string             `json:"error,omitempty"`
}

// OpenCodeChangelogFn fetches the OpenCode changelog filtered to the semver range
// (from, to] (installed < tag <= latest), newest first, with the best-effort
// "may affect you" heuristic already applied to Core/SDK/Extensions items. An
// error signals "changelog unavailable" so the handler can degrade gracefully.
// from/to are normalized semver strings ("x.y.z", no leading 'v'); an empty
// bound means no bound on that side.
type OpenCodeChangelogFn func(ctx context.Context, from, to string) ([]ChangelogRelease, error)

// SetOpencodeChangelog wires the changelog fetcher. Optional: when nil,
// /vh/opencode-changelog returns available=false (the SPA shows "unavailable")
// and the update flow is entirely unaffected.
func (s *Server) SetOpencodeChangelog(fn OpenCodeChangelogFn) { s.ocChangelogFn = fn }

// GET /vh/opencode-changelog?from=<installed>&to=<latest> — the OpenCode
// changelog filtered to the semver range between the installed and latest
// versions, with a best-effort "⚠ may affect you" heuristic on items that look
// breaking/migratory.
//
// Auth-gated like the other /vh/* routes (Auth.Middleware wraps the whole mux);
// GET is CSRF-exempt (csrfGuard only checks unsafe methods), same model as
// GET /vh/opencode-version. Best-effort end to end: a fetch/parse failure returns
// HTTP 200 with {available:false, error:...} so the SPA renders a quiet
// "Changelog unavailable" line — it NEVER blocks the update button or the
// version fetch, and a downstream fetch().then(r=>r.json()) always resolves.
//
// from/to default to the installed/latest versions the server already knows (via
// ocVersionFn) when omitted; the SPA passes them explicitly in practice, so the
// ocVersionFn fallback is rarely hit.
func (s *Server) handleOpenCodeChangelog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	from := strings.TrimSpace(q.Get("from"))
	to := strings.TrimSpace(q.Get("to"))

	// Default omitted bounds to what the server already knows. Costs one
	// ocVersionFn call (which runs <bin> --version + an npm fetch) only when a
	// bound is missing; the SPA passes explicit from/to so this is a safety net.
	if (from == "" || to == "") && s.ocVersionFn != nil {
		if installed, _, latest, err := s.ocVersionFn(r.Context()); err == nil {
			if from == "" {
				from = installed
			}
			if to == "" {
				to = latest
			}
		}
	}

	resp := ChangelogResponse{From: from, To: to}
	if s.ocChangelogFn == nil {
		resp.Available = false
		resp.Error = "changelog is not available on this server"
		writeJSONResp(w, resp)
		return
	}
	releases, err := s.ocChangelogFn(r.Context(), from, to)
	if err != nil {
		resp.Available = false
		resp.Error = "changelog unavailable"
		writeJSONResp(w, resp)
		return
	}
	resp.Available = true
	resp.Releases = releases
	writeJSONResp(w, resp)
}
