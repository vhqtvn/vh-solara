package web

import (
	"net/http"
	"strings"
)

// Theme tokens for embedded views: a documented, STABLE set of semantic theme
// custom properties so a proxied/embedded view can render native to vh-solara's
// look. Generic — vh-solara just publishes its tokens under a stable "--vh-*"
// namespace; consumers map them to their own styles (keeping their palette as a
// fallback). No per-consumer theming here.
//
// Theme is PER-CLIENT: each browser/device keeps its own (localStorage), so the
// server is client-theme-agnostic. Two delivery channels reflect that:
//   - This endpoint (/vh/theme.json, /vh/theme.css): a STATIC DEFAULT (dark)
//     baseline — same bytes for every client (the server can't know a client's
//     theme). Use it only as a build-time reference / fallback before the live
//     push arrives — NOT as the client's actual theme.
//   - postMessage from the SPA to the iframe (see web/src/themeTokens.ts): the
//     CLIENT's ACTUAL active theme, pushed on iframe load and on every theme/mode
//     change. This is inherently per-client (each client's SPA posts its own
//     theme to its own iframe), so two clients in different themes each get
//     theirs — this is the authoritative per-client source.
//
// The "--vh-*" names are the published contract; the values here mirror the dark
// :root in web/src/styles.css (the default theme).

type themeToken struct{ name, value string }

const defaultThemeMode = "dark"

var defaultThemeTokens = []themeToken{
	{"--vh-bg", "#0d1117"},       // page background        (← --bg)
	{"--vh-surface", "#11161d"},  // panel/elevated surface (← --bg-2)
	{"--vh-fg", "#c9d1d9"},       // text                   (← --fg)
	{"--vh-muted", "#8b949e"},    // dim/secondary text     (← --fg-dim)
	{"--vh-accent", "#58a6ff"},   // primary accent         (← --accent)
	{"--vh-accent-2", "#d2a8ff"}, // secondary accent       (← --accent-2)
	{"--vh-border", "#21262d"},   // borders/dividers       (← --border)
	{"--vh-ok", "#3fb950"},       // status: success        (← --ok)
	{"--vh-warn", "#d29922"},     // status: warning        (← --warn)
	{"--vh-error", "#f85149"},    // status: error          (← --danger)
}

// GET /vh/theme.json — { mode, tokens{ "--vh-*": "#..." } } default baseline.
func (s *Server) handleThemeJSON(w http.ResponseWriter, r *http.Request) {
	tokens := make(map[string]string, len(defaultThemeTokens))
	for _, t := range defaultThemeTokens {
		tokens[t.name] = t.value
	}
	writeJSONResp(w, map[string]any{"mode": defaultThemeMode, "tokens": tokens})
}

// GET /vh/theme.css — the same baseline as a :root rule the view can <link>.
func (s *Server) handleThemeCSS(w http.ResponseWriter, r *http.Request) {
	var b strings.Builder
	b.WriteString(":root{color-scheme:" + defaultThemeMode + ";")
	for _, t := range defaultThemeTokens {
		b.WriteString(t.name + ":" + t.value + ";")
	}
	b.WriteString("}\n")
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	_, _ = w.Write([]byte(b.String()))
}
