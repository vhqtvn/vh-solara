package web

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/quota"
)

// Project notes + user todos are persisted server-side so they survive client
// reconnects and are shared across devices (laptop/phone). OpenCode has no
// notes store, so the daemon keeps its own small JSON file, keyed by the
// project working directory (one daemon serves one cwd).

type todoItem struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	Done bool   `json:"done"`
}

type notesDoc struct {
	Notes string     `json:"notes"`
	Todos []todoItem `json:"todos"`
}

var notesMu sync.Mutex

// notesPath returns the per-project notes file path, creating its parent dir.
// It is derived from the working directory so each project gets its own notes
// without any client-supplied key.
func notesPath() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	dir := filepath.Join(stateBaseDir(), "notes")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return filepath.Join(dir, projectKey(cwd)+".json"), nil
}

// stateBaseDir is the root for daemon-persisted vh state (notes, archive).
// VH_STATE_DIR overrides it (used by fixtures/tests for isolation).
func stateBaseDir() string {
	if d := os.Getenv("VH_STATE_DIR"); d != "" {
		return d
	}
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "vh-solara")
}

// projectKey derives a stable filename key for a project directory.
func projectKey(cwd string) string {
	sum := sha1.Sum([]byte(cwd))
	return hex.EncodeToString(sum[:])
}

func readNotes() notesDoc {
	doc := notesDoc{Todos: []todoItem{}}
	p, err := notesPath()
	if err != nil {
		return doc
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return doc
	}
	_ = json.Unmarshal(b, &doc)
	if doc.Todos == nil {
		doc.Todos = []todoItem{}
	}
	return doc
}

func writeNotes(doc notesDoc) error {
	p, err := notesPath()
	if err != nil {
		return err
	}
	if doc.Todos == nil {
		doc.Todos = []todoItem{}
	}
	b, _ := json.MarshalIndent(doc, "", "  ")
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// handleNotes serves GET (load) and PUT (replace) for the project's notes doc.
func (s *Server) handleNotes(w http.ResponseWriter, r *http.Request) {
	notesMu.Lock()
	defer notesMu.Unlock()

	switch r.Method {
	case http.MethodGet:
		writeJSONResp(w, readNotes())
	case http.MethodPut, http.MethodPost:
		var doc notesDoc
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MiB of notes+todos is plenty
		if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		if err := writeNotes(doc); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSONResp(w, doc)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func writeJSONResp(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// handleQuota reports per-provider usage quotas, cached briefly so a polling UI
// doesn't hammer the upstream provider APIs. ?refresh=1 forces a re-fetch.
func (s *Server) handleQuota(w http.ResponseWriter, r *http.Request) {
	s.quotaMu.Lock()
	fresh := s.quotaCache != nil && time.Since(s.quotaAt) < 45*time.Second
	if r.URL.Query().Get("refresh") == "1" {
		fresh = false
	}
	if fresh {
		rep := *s.quotaCache
		s.quotaMu.Unlock()
		writeJSONResp(w, rep)
		return
	}
	s.quotaMu.Unlock()

	rep := quota.Fetch(r.Context())
	s.quotaMu.Lock()
	s.quotaCache = &rep
	s.quotaAt = time.Now()
	s.quotaMu.Unlock()
	writeJSONResp(w, rep)
}
