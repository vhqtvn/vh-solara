package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/vhqtvn/vh-solara/pkg/procmgr"
	"github.com/vhqtvn/vh-solara/pkg/projectcfg"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// Managed-project orchestration: discover a checked-in .vh-solara/project.jsonc,
// gate it behind an explicit per-project trust approval, then run the declared
// processes (via procmgr) and register the declared views (via viewRegistry).
//
// Lifecycle (see design): processes start on first project open once trusted and
// run until the daemon exits or the user stops them — never auto-torn-down. On a
// daemon restart nothing auto-starts; the browser re-opening the project is the
// trigger, and because the trust record persists there's no re-prompt unless the
// config's hash changed.

// Project states surfaced by the orchestrator.
const (
	StateNone       = "none" // no .vh-solara/project.jsonc — not a managed project
	StateAwaitTrust = "awaiting-trust"
	StateChanged    = "changed" // previously trusted but config hash differs now
	StateTrusted    = "trusted" // trusted & processes started
)

// viewStatus const for a managed view.
const (
	ViewRegistered     = "registered"
	ViewPrefixConflict = "prefix-conflict"
	ViewPending        = "pending" // declared but not yet registered (project not trusted)
)

// Orchestrator owns repo-declared processes+views, gluing the config loader, the
// trust gate, the process manager, and the shared view registry.
type Orchestrator struct {
	mgr         *procmgr.Manager
	trust       *TrustStore
	views       *viewRegistry // shared with Server.views
	cfgOverride string        // --project-config override ("" = conventional discovery)
	autoTrust   bool          // headless escape hatch: auto-approve configs on open

	mu sync.Mutex
	// cfgs holds the TRUSTED, currently-running config per dir — and ONLY that.
	// It is the single source of commands the manager may (re)launch, so a
	// start/restart can never run a config edit that hasn't been re-approved.
	// Trust state and the review are always derived from a fresh on-disk read
	// (loadFresh), never from this cache.
	cfgs    map[string]*projectcfg.LoadResult
	viewReg map[string]map[string]string // dir → viewID → ViewRegistered|ViewPrefixConflict|ViewPending
	// gen is bumped on every startLocked so a late "process ready" callback from a
	// superseded config generation is ignored (no stale view registration).
	gen map[string]uint64
}

// NewOrchestrator builds the orchestrator over the given manager, trust store, and
// shared view registry. cfgOverride ("") uses conventional discovery.
func NewOrchestrator(mgr *procmgr.Manager, trust *TrustStore, views *viewRegistry, cfgOverride string) *Orchestrator {
	return &Orchestrator{
		mgr: mgr, trust: trust, views: views, cfgOverride: cfgOverride,
		cfgs:    map[string]*projectcfg.LoadResult{},
		viewReg: map[string]map[string]string{},
		gen:     map[string]uint64{},
	}
}

// OpenProject is the project-open hook: discover the config, gate on trust, and if
// trusted start the processes + register the views. Safe to call repeatedly (a
// trusted re-open is a no-op for already-running processes). It never blocks on
// process readiness — that runs in the manager's supervisor.
func (o *Orchestrator) OpenProject(dir string) {
	root, err := projectRoot(dir)
	if err != nil {
		return
	}
	lr := o.loadFresh(root)
	if lr == nil {
		return
	}
	if o.autoTrust && o.trust.State(root, lr.Hash) != TrustTrusted {
		// Headless escape hatch (--trust-on-open / VH_TRUST_CONFIG): approve the
		// config without a prompt. Intended for trusted single-user setups.
		if err := o.trust.Grant(root, lr.Hash); err != nil {
			vhlog.Warn("managed-project auto-trust failed", "dir", root, "err", err)
			return
		}
	}
	// Only a trusted config is cached + started; an untrusted/changed config is
	// left to the trust gate (the UI prompts; nothing runs until Grant).
	if o.trust.IsTrusted(root, lr.Hash) {
		o.mu.Lock()
		o.cfgs[root] = lr
		o.startLocked(root, lr)
		o.mu.Unlock()
	}
}

// loadFresh always reads + parses the config from disk (NO caching) so trust
// state and the review reflect the CURRENT file — a config edit while the daemon
// is up is seen immediately. nil = no config present (or unreadable). Never
// touches o.mu, so callers may hold it or not.
func (o *Orchestrator) loadFresh(root string) *projectcfg.LoadResult {
	lr, err := projectcfg.Load(root, o.cfgOverride)
	if err != nil {
		if projectcfg.IsNotFound(err) {
			return nil
		}
		vhlog.Warn("managed-project config load failed", "dir", root, "err", err)
		return nil
	}
	return lr
}

// startLocked starts every declared process (idempotent) and registers its views,
// deferring any view with depends_on until its process is ready. Caller holds o.mu.
func (o *Orchestrator) startLocked(root string, lr *projectcfg.LoadResult) {
	// New generation: invalidates any in-flight "process ready" callback from a
	// previous (now re-approved) config.
	o.gen[root]++
	gen := o.gen[root]

	// Group views by the process they wait for (depends_on); the rest register now.
	viewsByDep := map[string][]projectcfg.View{}
	var immediate []projectcfg.View
	for _, v := range lr.Config.Views {
		if v.DependsOn != "" {
			viewsByDep[v.DependsOn] = append(viewsByDep[v.DependsOn], v)
		} else {
			immediate = append(immediate, v)
		}
	}

	// Processes.
	for i := range lr.Config.Processes {
		p := lr.Config.Processes[i]
		spec := procmgr.ProcSpec{
			Dir:       root,
			ID:        p.ID,
			Argv:      p.Argv,
			Cwd:       p.AbsCwd,
			Env:       p.Env,
			Restart:   p.Restart,
			Readiness: p.Readiness,
		}
		deps := viewsByDep[p.ID]
		// Documented default-readiness heuristic: if the author omitted a probe but
		// a dependent view binds a unix socket, treat the process as ready once that
		// socket accepts connections (otherwise procmgr falls back to a short settle).
		if spec.Readiness == nil {
			if sock := firstUnixUpstreamSock(deps); sock != "" {
				spec.Readiness = &projectcfg.Readiness{Unix: sock}
			}
		}
		// Authoring footgun: a view waiting on this process but bound to a different
		// socket than the process's readiness.unix.
		if p.Readiness != nil && p.Readiness.Unix != "" {
			for _, v := range deps {
				if s, ok := unixUpstreamSock(v.Upstream); ok && s != p.Readiness.Unix {
					vhlog.Warn("managed-project view upstream socket differs from depended-on process readiness.unix",
						"dir", root, "view", v.ID, "view_socket", s, "process", p.ID, "readiness_unix", p.Readiness.Unix)
				}
			}
		}
		if len(deps) > 0 {
			pid := p.ID
			spec.OnReady = func() { o.onProcReady(root, gen, pid) }
		}
		if err := o.mgr.Start(spec); err != nil {
			vhlog.Error("managed-project process start failed", "dir", root, "id", p.ID, "err", err)
		}
	}

	// Views. Evict any managed view this project registered under a previous
	// (now re-approved) config but no longer declares — BEFORE re-registering, so
	// a view renamed while keeping its path_prefix doesn't self-conflict against
	// the stale registration (and a removed view stops serving its old prefix).
	newIDs := make(map[string]bool, len(lr.Config.Views))
	for _, v := range lr.Config.Views {
		newIDs[v.ID] = true
	}
	for oldID := range o.viewReg[root] {
		if !newIDs[oldID] {
			o.views.delManaged(root, oldID)
		}
	}
	reg := map[string]string{}
	for _, v := range immediate {
		reg[v.ID] = o.registerView(root, v)
	}
	// Dependent views: register now if the process is already ready (e.g. a
	// re-approval of a still-running project), otherwise mark pending — the
	// OnReady callback registers them once the process comes up.
	for dep, vs := range viewsByDep {
		ready := false
		if st, ok := o.mgr.Status(root, dep); ok && st.Status == procmgr.StatusReady {
			ready = true
		}
		for _, v := range vs {
			if ready {
				reg[v.ID] = o.registerView(root, v)
			} else {
				reg[v.ID] = ViewPending
			}
		}
	}
	o.viewReg[root] = reg
}

// onProcReady registers the views that depend on a process once it reaches
// readiness. Fired from the supervisor goroutine; no-ops if a re-approval has
// superseded this generation.
func (o *Orchestrator) onProcReady(root string, gen uint64, procID string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.gen[root] != gen {
		return // superseded by a newer config/approval
	}
	lr := o.cfgs[root]
	reg := o.viewReg[root]
	if lr == nil || reg == nil {
		return
	}
	for _, v := range lr.Config.Views {
		if v.DependsOn == procID {
			reg[v.ID] = o.registerView(root, v)
		}
	}
}

// firstUnixUpstreamSock returns the socket path of the first view (in order)
// whose upstream is a unix socket, or "" if none.
func firstUnixUpstreamSock(views []projectcfg.View) string {
	for _, v := range views {
		if s, ok := unixUpstreamSock(v.Upstream); ok {
			return s
		}
	}
	return ""
}

// unixUpstreamSock extracts the socket path from a "unix:<path>" upstream.
func unixUpstreamSock(upstream string) (string, bool) {
	const pre = "unix:"
	if strings.HasPrefix(upstream, pre) {
		return strings.TrimPrefix(upstream, pre), true
	}
	return "", false
}

// registerView builds the proxy for a declared view and registers it; returns the
// view status (registered or prefix-conflict).
func (o *Orchestrator) registerView(root string, v projectcfg.View) string {
	declared, err := normalizeViewPrefix(v.PathPrefix)
	if err != nil {
		vhlog.Warn("managed-project view bad prefix", "id", v.ID, "prefix", v.PathPrefix, "err", err)
		return ViewPrefixConflict
	}
	// Mount under a per-project namespace so this project's views are independent
	// of every other project's (a second project may declare the same prefix/id).
	prefix := managedViewPrefix(root, declared)
	proxy, err := buildViewProxy(prefix, v.Upstream)
	if err != nil {
		vhlog.Warn("managed-project view bad upstream", "id", v.ID, "upstream", v.Upstream, "err", err)
		return ViewPrefixConflict
	}
	title := strings.TrimSpace(v.Title)
	if title == "" {
		title = v.ID
	}
	reg := &viewReg{
		ID:         managedViewKey(root, v.ID),
		Title:      title,
		PathPrefix: prefix,
		Upstream:   v.Upstream,
		Sandbox:    sanitizeSandbox(v.Sandbox),
		Origin:     OriginManaged,
		Dir:        root,
		proxy:      proxy,
	}
	if err := o.views.putManaged(reg); err != nil {
		vhlog.Info("managed-project view prefix-conflict (process still runs)", "dir", root, "id", v.ID, "prefix", prefix)
		return ViewPrefixConflict
	}
	return ViewRegistered
}

// Grant approves the current config for a project and starts it. Used by
// POST /vh/trust.
func (o *Orchestrator) Grant(dir string) error {
	root, err := projectRoot(dir)
	if err != nil {
		return err
	}
	lr := o.loadFresh(root)
	if lr == nil {
		return fmt.Errorf("no managed-project config at %s", root)
	}
	// Approve exactly the config currently on disk (the same one Snapshot showed
	// in the review), then pin + start it.
	if err := o.trust.Grant(root, lr.Hash); err != nil {
		return err
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	o.cfgs[root] = lr
	o.startLocked(root, lr)
	return nil
}

// Control starts/stops/restarts one declared process.
func (o *Orchestrator) Control(dir, id, action string) error {
	root, err := projectRoot(dir)
	if err != nil {
		return err
	}
	switch action {
	case "start":
		return o.mgr.Start(o.specFor(root, id))
	case "stop":
		o.mgr.Stop(root, id)
		return nil
	case "restart":
		return o.mgr.Restart(root, id)
	default:
		return fmt.Errorf("unknown action %q", action)
	}
}

// specFor rebuilds the ProcSpec for a declared process from the TRUSTED, running
// config (o.cfgs) — never from a fresh disk read. This is a security boundary: a
// manual start/restart must not launch a config edit that hasn't been
// re-approved through the trust gate. Returns an empty-id spec (→ mgr errors) if
// the project isn't currently trusted+loaded or the process isn't declared.
func (o *Orchestrator) specFor(root, id string) procmgr.ProcSpec {
	o.mu.Lock()
	lr := o.cfgs[root]
	o.mu.Unlock()
	if lr == nil {
		return procmgr.ProcSpec{}
	}
	for _, p := range lr.Config.Processes {
		if p.ID == id {
			return procmgr.ProcSpec{
				Dir: root, ID: p.ID, Argv: p.Argv, Cwd: p.AbsCwd,
				Env: p.Env, Restart: p.Restart, Readiness: p.Readiness,
			}
		}
	}
	return procmgr.ProcSpec{}
}

// --- payloads ---

// ManagedProject is the GET /vh/managed?dir= response.
type ManagedProject struct {
	Dir        string               `json:"dir"`
	State      string               `json:"state"`
	ConfigHash string               `json:"config_hash,omitempty"`
	Review     *ManagedReview       `json:"review,omitempty"`
	Processes  []procmgr.ProcStatus `json:"processes"`
	Views      []ManagedViewStatus  `json:"views"`
}

// ManagedReview is the display-before-run payload for an untrusted config.
type ManagedReview struct {
	ConfigJSON string              `json:"config_json"`
	Processes  []ManagedReviewProc `json:"processes"`
	Views      []ManagedReviewView `json:"views"`
}

// ManagedReviewProc describes one declared process for review (env values masked).
type ManagedReviewProc struct {
	ID      string   `json:"id"`
	Command string   `json:"command"`
	Cwd     string   `json:"cwd"`
	EnvKeys []string `json:"env_keys"`
	Restart string   `json:"restart"`
}

// ManagedReviewView describes one declared view for review.
type ManagedReviewView struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	PathPrefix string `json:"path_prefix"`
	Upstream   string `json:"upstream"`
	DependsOn  string `json:"depends_on"`
}

// ManagedViewStatus is the live registration state of a declared view.
type ManagedViewStatus struct {
	ID     string `json:"id"`
	Prefix string `json:"path_prefix"`
	Status string `json:"status"`
}

// Snapshot builds the current view of a project for the UI. It is READ-ONLY: it
// reads the config fresh from disk so the state/review reflect the file right
// now (an edit while the daemon is up flips the project to "changed"), but it
// never starts anything — running processes keep their last-trusted config until
// the operator re-approves through Grant.
func (o *Orchestrator) Snapshot(dir string) ManagedProject {
	root, _ := projectRoot(dir)
	out := ManagedProject{Dir: root, Processes: []procmgr.ProcStatus{}, Views: []ManagedViewStatus{}}

	lr := o.loadFresh(root)
	if lr == nil {
		out.State = StateNone
		return out
	}
	out.ConfigHash = lr.Hash

	o.mu.Lock()
	reg := o.viewReg[root]
	o.mu.Unlock()

	// State + review derive from the CURRENT file vs the trust record.
	switch o.trust.State(root, lr.Hash) {
	case TrustTrusted:
		out.State = StateTrusted
	case TrustChanged:
		out.State = StateChanged
		out.Review = buildReview(lr)
	default:
		out.State = StateAwaitTrust
		out.Review = buildReview(lr)
	}

	out.Processes = o.mgr.Statuses(root)
	for _, v := range lr.Config.Views {
		st := reg[v.ID]
		if st == "" {
			st = ViewPending // declared but not registered yet (not trusted)
		}
		out.Views = append(out.Views, ManagedViewStatus{ID: v.ID, Prefix: v.PathPrefix, Status: st})
	}
	return out
}

func buildReview(lr *projectcfg.LoadResult) *ManagedReview {
	r := &ManagedReview{ConfigJSON: string(lr.Config.CanonicalJSON())}
	for _, p := range lr.Config.Processes {
		r.Processes = append(r.Processes, ManagedReviewProc{
			ID:      p.ID,
			Command: p.DisplayCommand,
			Cwd:     p.AbsCwd,
			EnvKeys: sortedKeys(p.Env),
			Restart: p.Restart,
		})
	}
	for _, v := range lr.Config.Views {
		r.Views = append(r.Views, ManagedReviewView{
			ID: v.ID, Title: v.Title, PathPrefix: v.PathPrefix, Upstream: v.Upstream, DependsOn: v.DependsOn,
		})
	}
	return r
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// --- HTTP handlers (Server methods; auth + CSRF come from the handler chain) ---

// handleManaged: GET ?dir= → project snapshot (state + review + statuses).
// POST ?dir=&id=&action=start|stop|restart → control a declared process.
// GET ?dir=&id=&logs[&max=N] → tailed process logs.
func (s *Server) handleManaged(w http.ResponseWriter, r *http.Request) {
	if s.managed == nil {
		writeJSONResp(w, ManagedProject{State: StateNone})
		return
	}
	dir := reqDir(r)
	switch r.Method {
	case http.MethodGet:
		if r.URL.Query().Has("logs") {
			id := r.URL.Query().Get("id")
			max := 64 * 1024
			b, ok := s.managed.mgr.Logs(absDir(dir), id, max)
			if !ok {
				http.Error(w, "no logs", http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = w.Write(b)
			return
		}
		writeJSONResp(w, s.managed.Snapshot(dir))
	case http.MethodPost:
		id := r.URL.Query().Get("id")
		action := r.URL.Query().Get("action")
		if id == "" || action == "" {
			http.Error(w, "id and action required", http.StatusBadRequest)
			return
		}
		if err := s.managed.Control(dir, id, action); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSONResp(w, map[string]any{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// projectSettingsMu serializes the read-modify-write of project.jsonc so two
// concurrent saves can't interleave and corrupt the file.
var projectSettingsMu sync.Mutex

// handleProjectSettings serves per-project UI settings read from (GET) and the
// display-only `agentStyles` written back to (PUT) .vh-solara/project.jsonc.
//
// GET returns `notes` (tri-state; omitted when not declared, so the client falls
// back to its global pref) and `agentStyles` (raw declared treatments — the
// client sanitizes color/style against fixed enums). Tolerant: any read/parse
// miss returns an empty object.
//
// PUT { agentStyles, dryRun } edits ONLY the agentStyles key via a
// comment-preserving splice that never touches the trust-gated processes/views
// (and leaves the trust hash unchanged, so no re-gate). dryRun returns the old
// and new file text for a confirm-diff; otherwise the new text is written
// (creating .vh-solara/ as needed).
func (s *Server) handleProjectSettings(w http.ResponseWriter, r *http.Request) {
	override := ""
	if s.managed != nil {
		override = s.managed.cfgOverride
	}
	switch r.Method {
	case http.MethodGet:
		out := map[string]any{}
		root, err := projectRoot(reqDir(r))
		if err != nil {
			writeJSONResp(w, out)
			return
		}
		lr, err := projectcfg.Load(root, override)
		if err == nil && lr.Config != nil {
			if lr.Config.Notes != nil {
				out["notes"] = *lr.Config.Notes
			}
			if len(lr.Config.AgentStyles) > 0 {
				out["agentStyles"] = lr.Config.AgentStyles
			}
		}
		writeJSONResp(w, out)

	case http.MethodPut, http.MethodPost:
		var body struct {
			AgentStyles map[string]projectcfg.AgentStyle `json:"agentStyles"`
			DryRun      bool                             `json:"dryRun"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		root, err := projectRoot(reqDir(r))
		if err != nil {
			http.Error(w, "no project root", http.StatusBadRequest)
			return
		}
		path, err := projectcfg.ResolvePath(root, override)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		projectSettingsMu.Lock()
		defer projectSettingsMu.Unlock()

		oldRaw, readErr := os.ReadFile(path)
		if readErr != nil && !os.IsNotExist(readErr) {
			http.Error(w, readErr.Error(), http.StatusInternalServerError)
			return
		}
		newRaw, err := projectcfg.SpliceTopLevelKey(oldRaw, "agentStyles", body.AgentStyles)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if body.DryRun {
			writeJSONResp(w, map[string]any{"old": string(oldRaw), "new": string(newRaw)})
			return
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := os.WriteFile(path, newRaw, 0o644); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSONResp(w, map[string]any{"ok": true})

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleTrust: GET ?dir= → {state, config_hash}. POST {dir} → approve current
// config + start the project.
func (s *Server) handleTrust(w http.ResponseWriter, r *http.Request) {
	if s.managed == nil {
		http.Error(w, "managed projects disabled", http.StatusNotFound)
		return
	}
	switch r.Method {
	case http.MethodGet:
		dir := reqDir(r)
		root, err := projectRoot(dir)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		lr, err := projectcfg.Load(root, s.managed.cfgOverride)
		if err != nil {
			writeJSONResp(w, map[string]any{"state": StateNone})
			return
		}
		writeJSONResp(w, map[string]any{"state": s.managed.trust.State(root, lr.Hash), "config_hash": lr.Hash})
	case http.MethodPost:
		var in struct {
			Dir string `json:"dir"`
		}
		if !decodeBody(w, r, &in) {
			return
		}
		if err := s.managed.Grant(in.Dir); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSONResp(w, map[string]any{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// absDir resolves reqDir's dir to an absolute path for process-key lookups.
func absDir(dir string) string {
	if dir == "" {
		if cwd, err := os.Getwd(); err == nil {
			return cwd
		}
	}
	if abs, err := filepath.Abs(dir); err == nil {
		return abs
	}
	return dir
}
