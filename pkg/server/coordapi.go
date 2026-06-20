package server

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
)

// Cross-worker coordination API (A3). A path-addressed family that lets an
// external coordinator drive any worker's sessions uniformly — no wildcard-DNS
// Host hacks, no /oc/* passthrough. Each route proxies through the existing
// registry+tunnel to the worker's local vh-solara /vh/* handlers (V1 gate facts,
// V2 typed verbs), so the controller adds addressing + auth and no policy.
//
//	GET    /api/workers/{id}/sessions                          → /vh/snapshot
//	GET    /api/workers/{id}/sessions/{sid}                    → /vh/snapshot?sessions={sid}
//	POST   /api/workers/{id}/sessions                          → /vh/spawn
//	POST   /api/workers/{id}/sessions/{sid}/message            → /vh/send
//	DELETE /api/workers/{id}/sessions/{sid}                    → /vh/abort
//	POST   /api/workers/{id}/sessions/{sid}/archive            → /vh/archive
//	POST   /api/workers/{id}/sessions/{sid}/questions/{qid}    → /vh/answer-question
//	POST   /api/workers/{id}/sessions/{sid}/permissions/{pid}  → /vh/reply-permission
//	GET    /api/workers/{id}/events                            → /vh/stream  (SSE)
//
// Responses carry the worker's X-VH-Epoch / X-VH-Seq through transparently, so
// the coordinator keys its cursor by (worker, epoch, seq). These routes bypass
// the session-auth edge and are gated by a bearer token instead (see
// checkAPIBearer) — the coordinator is a non-browser client.

const apiBearerHeader = "Authorization"

// registerCoordRoutes installs the coordination API on its own mux (matched
// before session auth in Start).
func (d *Daemon) registerCoordRoutes(mux *http.ServeMux) {
	// Bearer-gated worker discovery for headless clients (the dashboard's
	// GET /api/workers is session-authed; this is its coordination-API peer).
	mux.HandleFunc("GET /api/coord/workers", d.coordListWorkers)
	mux.HandleFunc("GET /api/workers/{id}/skill/emit", d.coordSkillEmit)
	mux.HandleFunc("GET /api/workers/{id}/projects", d.coordProjects)
	mux.HandleFunc("GET /api/workers/{id}/sessions", d.coordSnapshot)
	mux.HandleFunc("POST /api/workers/{id}/sessions", d.coordSpawn)
	mux.HandleFunc("GET /api/workers/{id}/sessions/{sid}", d.coordSessionDetail)
	mux.HandleFunc("DELETE /api/workers/{id}/sessions/{sid}", d.coordAbort)
	mux.HandleFunc("POST /api/workers/{id}/sessions/{sid}/message", d.coordMessage)
	mux.HandleFunc("POST /api/workers/{id}/sessions/{sid}/archive", d.coordArchive)
	mux.HandleFunc("POST /api/workers/{id}/sessions/{sid}/questions/{qid}", d.coordAnswerQuestion)
	mux.HandleFunc("POST /api/workers/{id}/sessions/{sid}/permissions/{pid}", d.coordReplyPermission)
	mux.HandleFunc("GET /api/workers/{id}/events", d.coordEvents)
}

// coordFront serves coordination routes (bearer-gated) before falling through to
// the session-authed edge. A coordination path is one coordMux matches.
func (d *Daemon) coordFront(coordMux *http.ServeMux, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, pattern := coordMux.Handler(r); pattern != "" {
			if !d.checkAPIBearer(w, r) {
				return
			}
			coordMux.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// checkAPIBearer enforces the bearer token on the coordination API. An empty
// APIToken leaves it open (matching the RegSecret default; only safe when the
// listener isn't reachable by untrusted parties). Writes the 401 itself.
func (d *Daemon) checkAPIBearer(w http.ResponseWriter, r *http.Request) bool {
	if d.APIToken == "" {
		return true
	}
	got := r.Header.Get(apiBearerHeader)
	const pfx = "Bearer "
	if len(got) > len(pfx) && got[:len(pfx)] == pfx &&
		subtle.ConstantTimeCompare([]byte(got[len(pfx):]), []byte(d.APIToken)) == 1 {
		return true
	}
	http.Error(w, "unauthorized (coordination API requires a valid bearer token)", http.StatusUnauthorized)
	return false
}

// worker resolves an online worker by id, writing the error response on failure.
func (d *Daemon) coordWorker(w http.ResponseWriter, r *http.Request) (*Worker, bool) {
	id := r.PathValue("id")
	worker, ok := d.Registry.GetWorker(id)
	if !ok {
		http.Error(w, "worker not found", http.StatusNotFound)
		return nil, false
	}
	if worker.Status == "offline" || worker.Transport == nil || worker.Transport.IsClosed() {
		http.Error(w, "worker offline", http.StatusBadGateway)
		return nil, false
	}
	return worker, true
}

// proxyToVH rewrites the request onto a worker's local /vh path (method, path,
// query, body) and proxies it through the tunnel. A non-nil bodyObj is marshalled
// as JSON and the CSRF header is set so the worker's /vh guard accepts the write.
// The worker's response (incl. X-VH-Epoch/X-VH-Seq) streams straight back.
func (d *Daemon) proxyToVH(w http.ResponseWriter, r *http.Request, worker *Worker, method, vhPath, rawQuery string, bodyObj any) {
	r.Method = method
	r.URL.Path = vhPath
	r.URL.RawQuery = rawQuery
	r.RequestURI = ""
	if bodyObj != nil {
		b, _ := json.Marshal(bodyObj)
		r.Body = io.NopCloser(bytes.NewReader(b))
		r.ContentLength = int64(len(b))
		r.Header.Set("Content-Length", strconv.Itoa(len(b)))
		r.Header.Set("Content-Type", "application/json")
	}
	if method != http.MethodGet {
		r.Header.Set("X-VH-CSRF", "1") // the worker /vh CSRF guard requires a custom header
	}
	// Force non-keep-alive on the proxied exchange. HandleWorkerDirect HIJACKS the
	// inbound connection and pipes it raw to the worker; if the worker answers with
	// keep-alive (Content-Length) the HTTP client reads the body and returns the
	// still-hijacked connection to its pool, and a subsequent request is smuggled
	// straight down the tunnel — bypassing this router. Connection: close makes the
	// worker close after the response, so the client never reuses the connection.
	// (Coordination requests are never WebSocket upgrades, so this is safe here;
	// the host-based browser proxy path is untouched.)
	r.Header.Set("Connection", "close")
	r.Close = true
	d.Proxy.HandleWorkerDirect(worker.ID, worker, w, r)
}

// dirQuery carries a ?dir= project selector through to the worker if present.
func dirQuery(r *http.Request, extra url.Values) string {
	q := url.Values{}
	if dir := r.URL.Query().Get("dir"); dir != "" {
		q.Set("dir", dir)
	}
	for k, vs := range extra {
		for _, v := range vs {
			q.Add(k, v)
		}
	}
	return q.Encode()
}

// readJSONObj reads the request body into a map (empty body → empty map) so path
// params can be merged in before forwarding.
func readJSONObj(r *http.Request) map[string]any {
	out := map[string]any{}
	b, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if len(bytes.TrimSpace(b)) > 0 {
		_ = json.Unmarshal(b, &out)
	}
	return out
}

// --- handlers ---

// coordListWorkers returns the registered workers (id, name, status) for headless
// discovery — the bearer-gated peer of the dashboard's GET /api/workers.
func (d *Daemon) coordListWorkers(w http.ResponseWriter, r *http.Request) {
	type pubWorker struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Version string `json:"version"`
		Status  string `json:"status"`
	}
	out := []pubWorker{}
	for _, wv := range d.Registry.ListWorkers() {
		out = append(out, pubWorker{ID: wv.ID, Name: wv.Name, Version: wv.Version, Status: wv.Status})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// coordSkillEmit returns a worker's version-stamped client skill (the cross
// machine mirror of /vh/skill/emit) so a coordinator can drift-check against the
// running daemon's surface.
func (d *Daemon) coordSkillEmit(w http.ResponseWriter, r *http.Request) {
	worker, ok := d.coordWorker(w, r)
	if !ok {
		return
	}
	d.proxyToVH(w, r, worker, http.MethodGet, "/vh/skill/emit", "", nil)
}

// coordProjects lists the project instances a worker bridges (dir/epoch/seq/
// sessions) — the cross-machine mirror of the worker's /vh/projects, so a
// coordinator can resolve "this project dir" → the right per-project cursor.
func (d *Daemon) coordProjects(w http.ResponseWriter, r *http.Request) {
	worker, ok := d.coordWorker(w, r)
	if !ok {
		return
	}
	d.proxyToVH(w, r, worker, http.MethodGet, "/vh/projects", "", nil)
}

func (d *Daemon) coordSnapshot(w http.ResponseWriter, r *http.Request) {
	worker, ok := d.coordWorker(w, r)
	if !ok {
		return
	}
	// Carry the caller's sessions= filter through (tree-only by default).
	extra := url.Values{}
	if v := r.URL.Query().Get("sessions"); v != "" {
		extra.Set("sessions", v)
	}
	d.proxyToVH(w, r, worker, http.MethodGet, "/vh/snapshot", dirQuery(r, extra), nil)
}

func (d *Daemon) coordSessionDetail(w http.ResponseWriter, r *http.Request) {
	worker, ok := d.coordWorker(w, r)
	if !ok {
		return
	}
	extra := url.Values{"sessions": {r.PathValue("sid")}}
	d.proxyToVH(w, r, worker, http.MethodGet, "/vh/snapshot", dirQuery(r, extra), nil)
}

func (d *Daemon) coordEvents(w http.ResponseWriter, r *http.Request) {
	worker, ok := d.coordWorker(w, r)
	if !ok {
		return
	}
	extra := url.Values{}
	if v := r.URL.Query().Get("sessions"); v != "" {
		extra.Set("sessions", v)
	}
	if v := r.URL.Query().Get("cursor"); v != "" {
		extra.Set("cursor", v)
	}
	d.proxyToVH(w, r, worker, http.MethodGet, "/vh/stream", dirQuery(r, extra), nil)
}

func (d *Daemon) coordSpawn(w http.ResponseWriter, r *http.Request) {
	worker, ok := d.coordWorker(w, r)
	if !ok {
		return
	}
	d.proxyToVH(w, r, worker, http.MethodPost, "/vh/spawn", dirQuery(r, nil), readJSONObj(r))
}

func (d *Daemon) coordMessage(w http.ResponseWriter, r *http.Request) {
	worker, ok := d.coordWorker(w, r)
	if !ok {
		return
	}
	body := readJSONObj(r)
	body["sessionID"] = r.PathValue("sid")
	// Forward an If-Idle-Seq CAS header if the caller set one.
	if v := r.Header.Get("If-Idle-Seq"); v != "" {
		r.Header.Set("If-Idle-Seq", v)
	}
	d.proxyToVH(w, r, worker, http.MethodPost, "/vh/send", dirQuery(r, nil), body)
}

func (d *Daemon) coordAbort(w http.ResponseWriter, r *http.Request) {
	worker, ok := d.coordWorker(w, r)
	if !ok {
		return
	}
	body := map[string]any{"sessionID": r.PathValue("sid")}
	if k := r.URL.Query().Get("idempotency_key"); k != "" {
		body["idempotency_key"] = k
	}
	d.proxyToVH(w, r, worker, http.MethodPost, "/vh/abort", dirQuery(r, nil), body)
}

func (d *Daemon) coordArchive(w http.ResponseWriter, r *http.Request) {
	worker, ok := d.coordWorker(w, r)
	if !ok {
		return
	}
	body := map[string]any{"sessionID": r.PathValue("sid")}
	d.proxyToVH(w, r, worker, http.MethodPost, "/vh/archive", dirQuery(r, nil), body)
}

func (d *Daemon) coordAnswerQuestion(w http.ResponseWriter, r *http.Request) {
	worker, ok := d.coordWorker(w, r)
	if !ok {
		return
	}
	body := readJSONObj(r)
	body["questionID"] = r.PathValue("qid")
	d.proxyToVH(w, r, worker, http.MethodPost, "/vh/answer-question", dirQuery(r, nil), body)
}

func (d *Daemon) coordReplyPermission(w http.ResponseWriter, r *http.Request) {
	worker, ok := d.coordWorker(w, r)
	if !ok {
		return
	}
	body := readJSONObj(r)
	body["permissionID"] = r.PathValue("pid")
	body["sessionID"] = r.PathValue("sid") // enables the worker's legacy-route fallback
	d.proxyToVH(w, r, worker, http.MethodPost, "/vh/reply-permission", dirQuery(r, nil), body)
}
