package server

// status_config.go — the fleet-status configuration core (slice C1 of the
// fleet-status config redesign; operator-confirmed recommendation in
// tmp/agent-runs/watch-status-20260922/config-brief.md). The expected
// worker/project rosters for GET /vh/fleet/status live in ONE JSONC file
// selected by --status-config, replacing the unpushed --status-worker /
// --status-project repeatable flags.
//
// Shape (schema 1):
//
//	{
//	  "workers":  [{ "id": "build-box", "label": "Primary builder" }],
//	  "projects": [{ "dir": "/srv/repos/service", "label": "Prod" }]
//	}
//
// Semantics:
//   - ids/dirs are the v1 authority; labels are INERT schema room (stored,
//     echoed by GET, persisted — NOT consumed by the rollup yet).
//   - Reads (startup file load AND PUT body) accept the repo JSONC dialect
//     (// and /* */ comments, trailing commas) via projectcfg.StripJSONC —
//     the bounded reuse decision from the brief. Strict decoding
//     (json.Decoder.DisallowUnknownFields) rejects unknown keys at EVERY
//     level, and a trailing second JSON document is rejected.
//   - Writes (PUT persistence) are canonical JSON (2-space indent, sorted
//     entries, no comments) — a UI save LOSES hand-written comments; that
//     tradeoff is accepted and documented here.
//   - project dirs are VERBATIM: whitespace-only entries are rejected, but a
//     non-blank entry keeps its exact spelling (NO trimming, no path
//     cleaning) — preserving the landed exact-match semantics of
//     normalizeProjectRoster (commit-review F2).
//   - worker ids must pass validWorkerHostLabel (they are substituted into
//     configured HostPattern deep links), and duplicate ids/dirs are
//     REJECTED at this boundary instead of being silently deduped.
//
// Live apply: PUT validates → persists atomically (sibling tmp file + rename
// in the same directory) → swaps the holder's rosters → bumps the holder
// generation. The rollup cache (status.go) stamps every published generation
// with the holder generation it was built under and refuses to serve one
// built under an older generation — so a config apply invalidates the rollup
// cache instantly, AND a stale in-flight refresh (started before the swap)
// can never publish over a newer config (the E9 concern from the brief).
//
// Routes (controller userMux, session-cookie auth family — same chain as
// GET /vh/fleet/status):
//
//	GET /vh/fleet/config → {"schema":1,"writable":bool,"workers":[…],
//	                       "projects":[…]} — the effective config.
//	                       writable=false when no --status-config path is
//	                       set (config management disabled).
//	PUT /vh/fleet/config → same body schema as the file. Requires the
//	                       X-VH-CSRF header, enforced IN the handler (the
//	                       controller csrfGuard only gates unsafe methods
//	                       under /api/, and this is a /vh/ mutation):
//	                       403 without it. 409 when writable=false (no
//	                       persistence path configured — honest refusal,
//	                       not silent acceptance). 400 + precise error on
//	                       an invalid body. 200 with the effective config
//	                       on success.
//
// hostInterceptor carves /vh/fleet/config out of the worker-subdomain proxy
// (daemon.go): the manage surface is controller-owned and must answer from
// every host the SPA is served on — the worker has no /vh/fleet/config route,
// and its catch-all would serve the SPA shell (200 text/html) instead. See
// TestHostInterceptorFleetConfigRoutePrecedence (status_config_test.go).

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"

	"github.com/vhqtvn/vh-solara/pkg/projectcfg"
)

// maxFleetConfigLabelRunes is the label ceiling: free text, ≤64 Unicode code
// points (runes, not bytes). Labels are inert display room in v1.
const maxFleetConfigLabelRunes = 64

// maxFleetConfigBodyBytes caps a PUT request body (a config document is a
// few KiB; anything near 1 MiB is a client bug or abuse).
const maxFleetConfigBodyBytes = 1 << 20

// ---------------------------------------------------------------------------
// Wire / file shape (schema 1)
// ---------------------------------------------------------------------------

// fleetConfigWorker is one expected worker. ID is the registry worker ID
// (must be a safe host label — it feeds HostPattern deep links). Label is
// inert v1 display room.
type fleetConfigWorker struct {
	ID    string `json:"id"`
	Label string `json:"label,omitempty"`
}

// fleetConfigProject is one expected project directory. Dir matches the
// worker-reported dir by exact VERBATIM string equality (no trimming on
// either side). Label is inert v1 display room.
type fleetConfigProject struct {
	Dir   string `json:"dir"`
	Label string `json:"label,omitempty"`
}

// fleetStatusConfig is the whole document, shared by the file, the PUT body,
// and the effective-config responses.
type fleetStatusConfig struct {
	Workers  []fleetConfigWorker  `json:"workers"`
	Projects []fleetConfigProject `json:"projects"`
}

// fleetConfigResponse is the GET / effective-config body.
type fleetConfigResponse struct {
	Schema   int                  `json:"schema"`
	Writable bool                 `json:"writable"`
	Workers  []fleetConfigWorker  `json:"workers"`
	Projects []fleetConfigProject `json:"projects"`
}

// ---------------------------------------------------------------------------
// Strict decode + validate (shared by file load and PUT body)
// ---------------------------------------------------------------------------

// decodeStatusConfig strictly decodes exactly ONE JSONC document into a
// VALIDATED, canonicalized config. Shared by loadStatusConfigFile and the
// PUT handler so the two surfaces cannot drift. Canonicalization (sorting)
// makes both the persisted file and the GET/PUT echo deterministic.
func decodeStatusConfig(data []byte) (*fleetStatusConfig, error) {
	stripped := projectcfg.StripJSONC(data)
	dec := json.NewDecoder(bytes.NewReader(stripped))
	dec.DisallowUnknownFields()
	var cfg *fleetStatusConfig
	if err := dec.Decode(&cfg); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, errors.New("empty document")
		}
		return nil, fmt.Errorf("invalid JSON: %v", err)
	}
	if cfg == nil {
		return nil, errors.New("document must be a JSON object, not null")
	}
	var trailing json.RawMessage
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("expected exactly one JSON document (trailing content)")
	}
	if err := validateStatusConfig(cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

// validateStatusConfig enforces the schema rules and canonicalizes entry
// order (workers by id, projects by dir — the same order the rollup's
// normalizeFleetRoster/normalizeProjectRoster produces, so file, echo, and
// rollup agree). Mutates cfg (sorts in place).
func validateStatusConfig(cfg *fleetStatusConfig) error {
	seenWorkers := make(map[string]bool, len(cfg.Workers))
	for i, w := range cfg.Workers {
		if !validWorkerHostLabel(w.ID) {
			return fmt.Errorf("workers[%d].id: invalid worker id %q (must be non-empty ASCII letters/digits/'.'/'_'/'-' — the id is substituted into configured host patterns)", i, w.ID)
		}
		if seenWorkers[w.ID] {
			return fmt.Errorf("workers[%d].id: duplicate worker id %q", i, w.ID)
		}
		seenWorkers[w.ID] = true
		if n := len([]rune(w.Label)); n > maxFleetConfigLabelRunes {
			return fmt.Errorf("workers[%d].label: %d code points exceeds the %d-code-point limit", i, n, maxFleetConfigLabelRunes)
		}
	}
	seenDirs := make(map[string]bool, len(cfg.Projects))
	for i, p := range cfg.Projects {
		if strings.TrimSpace(p.Dir) == "" {
			return fmt.Errorf("projects[%d].dir: blank project dir (whitespace-only entries are rejected; non-blank entries are stored VERBATIM — no trimming)", i)
		}
		if seenDirs[p.Dir] {
			return fmt.Errorf("projects[%d].dir: duplicate project dir %q", i, p.Dir)
		}
		seenDirs[p.Dir] = true
		if n := len([]rune(p.Label)); n > maxFleetConfigLabelRunes {
			return fmt.Errorf("projects[%d].label: %d code points exceeds the %d-code-point limit", i, n, maxFleetConfigLabelRunes)
		}
	}
	sort.Slice(cfg.Workers, func(i, j int) bool { return cfg.Workers[i].ID < cfg.Workers[j].ID })
	sort.Slice(cfg.Projects, func(i, j int) bool { return cfg.Projects[i].Dir < cfg.Projects[j].Dir })
	return nil
}

// ---------------------------------------------------------------------------
// File load / persist
// ---------------------------------------------------------------------------

// loadStatusConfigFile reads and strictly decodes the config at path. Errors
// name the path plus the precise reason — a set-but-bad --status-config is a
// startup failure, never a silent fallback to discovered scope.
func loadStatusConfigFile(path string) (*fleetStatusConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read status config %s: %v", path, err)
	}
	cfg, err := decodeStatusConfig(data)
	if err != nil {
		return nil, fmt.Errorf("status config %s: %v", path, err)
	}
	return cfg, nil
}

// persistStatusConfig writes cfg as canonical JSON (2-space indent, sorted
// entries, trailing newline, no comments — a save loses hand-written
// comments) atomically: sibling temp file in the SAME directory, then rename
// over the target (the pkg/alerts config-save house pattern), so a crash
// mid-write can never leave a truncated document the next startup would
// refuse to load. Callers serialize concurrent persists (the holder does).
func persistStatusConfig(path string, cfg *fleetStatusConfig) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal status config: %v", err)
	}
	data = append(data, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write %s: %v", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename %s to %s: %v", tmp, path, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Holder: mutex-guarded current rosters on the Daemon
// ---------------------------------------------------------------------------

// statusConfigHolder is the daemon's fleet-status configuration state: the
// current expected rosters plus the optional persistence path. Zero value =
// unconfigured (empty rosters ⇒ discovered scope; writable=false). gen is
// bumped on every roster change and is the rollup-cache invalidation signal
// (see status.go: fleetGeneration.cfgGen).
type statusConfigHolder struct {
	mu       sync.Mutex
	path     string // persistence path; "" = read-only (PUT refused with 409)
	workers  []fleetConfigWorker
	projects []fleetConfigProject
	gen      uint64
}

// statusConfigSnapshot is one coherent copy of the holder state (deep-copied
// entry slices; never nil, so JSON renders [] not null).
type statusConfigSnapshot struct {
	path     string
	workers  []fleetConfigWorker
	projects []fleetConfigProject
	gen      uint64
}

// workerIDs returns the roster worker ids in order (the rollup normalizes
// them through normalizeFleetRoster, exactly as the landed flag path did).
func (s statusConfigSnapshot) workerIDs() []string {
	ids := make([]string, 0, len(s.workers))
	for _, w := range s.workers {
		ids = append(ids, w.ID)
	}
	return ids
}

// projectDirs returns the roster project dirs in order, VERBATIM (the rollup
// normalizes them through normalizeProjectRoster — no trimming).
func (s statusConfigSnapshot) projectDirs() []string {
	dirs := make([]string, 0, len(s.projects))
	for _, p := range s.projects {
		dirs = append(dirs, p.Dir)
	}
	return dirs
}

func (h *statusConfigHolder) snapshot() statusConfigSnapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	snap := statusConfigSnapshot{path: h.path, gen: h.gen}
	snap.workers = append([]fleetConfigWorker(nil), h.workers...)
	snap.projects = append([]fleetConfigProject(nil), h.projects...)
	if snap.workers == nil {
		snap.workers = []fleetConfigWorker{}
	}
	if snap.projects == nil {
		snap.projects = []fleetConfigProject{}
	}
	return snap
}

func (h *statusConfigHolder) generation() uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.gen
}

func (h *statusConfigHolder) writable() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.path != ""
}

// setLoaded installs the startup config (--status-config): the persistence
// path plus the rosters. Bumps gen so a pre-Start rollup generation can
// never be mistaken for current.
func (h *statusConfigHolder) setLoaded(path string, cfg *fleetStatusConfig) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.path = path
	h.workers = append([]fleetConfigWorker(nil), cfg.Workers...)
	h.projects = append([]fleetConfigProject(nil), cfg.Projects...)
	h.gen++
}

// applyValidated swaps already-validated rosters WITHOUT persistence and
// WITHOUT changing the path (test seam for driving the rollup through the
// same holder the config file feeds; also the hook a future non-file source
// would use). cfg must have passed validateStatusConfig.
func (h *statusConfigHolder) applyValidated(cfg *fleetStatusConfig) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.workers = append([]fleetConfigWorker(nil), cfg.Workers...)
	h.projects = append([]fleetConfigProject(nil), cfg.Projects...)
	h.gen++
}

// replaceAndPersist is the PUT path: atomically persist, then swap the
// rosters (path unchanged). Serialized under mu, so concurrent PUTs cannot
// interleave tmp-file writes; a failed persist leaves the running state
// untouched. cfg must have passed decodeStatusConfig.
func (h *statusConfigHolder) replaceAndPersist(cfg *fleetStatusConfig) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.path == "" {
		return errors.New("no persistence path configured") // defensive; the handler 409s first
	}
	if err := persistStatusConfig(h.path, cfg); err != nil {
		return err
	}
	h.workers = append([]fleetConfigWorker(nil), cfg.Workers...)
	h.projects = append([]fleetConfigProject(nil), cfg.Projects...)
	h.gen++
	return nil
}

// ---------------------------------------------------------------------------
// Daemon surface: startup load + manage API handlers
// ---------------------------------------------------------------------------

// LoadStatusConfig reads, validates, and installs the fleet-status config at
// path (the --status-config startup path). A missing/unreadable/invalid file
// returns an error naming the path and the precise reason — the caller
// (cmd/server.go) fails startup on it rather than silently switching to
// discovered scope. On error the daemon's config state is unchanged.
func (d *Daemon) LoadStatusConfig(path string) error {
	cfg, err := loadStatusConfigFile(path)
	if err != nil {
		return err
	}
	d.statusCfg.setLoaded(path, cfg)
	return nil
}

// handleFleetConfigGet serves GET /vh/fleet/config: the effective config
// (schema 1, writable flag, both rosters — sorted, labels echoed). Read-only
// and CSRF-exempt by the repo convention (csrfGuard gates unsafe methods
// only; GET carries no state change).
func (d *Daemon) handleFleetConfigGet(w http.ResponseWriter, r *http.Request) {
	writeFleetConfigResponse(w, http.StatusOK, d.statusCfg.snapshot())
}

// handleFleetConfigPut serves PUT /vh/fleet/config — the live manage verb.
//
// Check order: CSRF (403) → writable (409) → decode+validate (400) →
// persist+swap (200). Security precedes state precedes input.
//
// CSRF is enforced HERE, not in middleware: the controller csrfGuard
// (daemon.go) requires X-VH-CSRF only on unsafe methods under /api/, and
// this route is a /vh/ mutation outside its scope — so the handler mirrors
// the guard's own check (same header, same non-empty test, same 403) to keep
// the repo's mutation convention airtight on this surface too.
//
// 409 (not 400/403) when writable=false: the request may be perfectly
// authenticated, CSRF-carrying, and valid — the daemon simply has no
// persistence path (--status-config unset), and accepting it without
// persisting would silently lie about durability.
//
// Success: validate → atomic persist (tmp+rename) → hot-swap rosters in the
// running daemon → the rollup cache generation is invalidated by the
// holder-generation bump (fleetGeneration.cfgGen in status.go; no explicit
// cache poke needed) → 200 with the effective config.
func (d *Daemon) handleFleetConfigPut(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get(csrfHeader) == "" {
		http.Error(w, "missing "+csrfHeader+" header (CSRF protection)", http.StatusForbidden)
		return
	}
	if !d.statusCfg.writable() {
		http.Error(w, "fleet status config is read-only: no --status-config path is configured on this controller", http.StatusConflict)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxFleetConfigBodyBytes))
	if err != nil {
		http.Error(w, "invalid fleet config: request body exceeds the byte cap", http.StatusBadRequest)
		return
	}
	cfg, err := decodeStatusConfig(body)
	if err != nil {
		http.Error(w, "invalid fleet config: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := d.statusCfg.replaceAndPersist(cfg); err != nil {
		http.Error(w, "fleet status config: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeFleetConfigResponse(w, http.StatusOK, d.statusCfg.snapshot())
}

// writeFleetConfigResponse renders the effective-config JSON.
func writeFleetConfigResponse(w http.ResponseWriter, status int, snap statusConfigSnapshot) {
	resp := fleetConfigResponse{
		Schema:   1,
		Writable: snap.path != "",
		Workers:  snap.workers,
		Projects: snap.projects,
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-cache")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(resp)
}
