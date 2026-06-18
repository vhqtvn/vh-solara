package web

import (
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// Typed, daemon-aware write verbs (A1). These are the coordination action set —
// send / spawn / abort / answer-question / reply-permission — promoted from
// transparent /oc/* passthrough so the daemon observes every write, dedups
// retries (idempotency_key), and can compare-and-swap on idle (If-Idle-Seq).
// They forward to the local OpenCode server via the read/write client; archive
// is already first-class (archive.go). All verbs are mechanism: they carry no
// policy about WHEN to act — the caller (a coordinator) decides that.
//
// Shape: each verb is a POST with a JSON body. An optional "idempotency_key"
// field makes a retry safe (the original response is replayed). send additionally
// honors an "If-Idle-Seq" header for CAS (see handleSend).

// ifIdleSeqHeader carries the snapshot seq for the send CAS (see handleSend).
// The idempotency key travels in the request body, not a header.
const ifIdleSeqHeader = "If-Idle-Seq"

// idemCache is a small TTL cache of completed verb responses keyed by the
// caller's idempotency_key, plus an in-flight guard so concurrent duplicates of
// the same key can't double-execute the side effect. Generic; no domain logic.
type idemCache struct {
	mu       sync.Mutex
	done     map[string]idemEntry
	inflight map[string]bool
	ttl      time.Duration
}

type idemEntry struct {
	status int
	body   []byte
	at     time.Time
}

func newIdemCache(ttl time.Duration) *idemCache {
	return &idemCache{done: map[string]idemEntry{}, inflight: map[string]bool{}, ttl: ttl}
}

// begin claims a key. ok=false means proceed (the caller must later call finish).
// When ok=true, either a completed response is replayed (entry valid) or the key
// is still in flight (entry zero) — the handler returns 409 in the latter case.
func (c *idemCache) begin(key string) (entry idemEntry, replay bool, inflight bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.done[key]; ok && time.Since(e.at) < c.ttl {
		return e, true, false
	}
	if c.inflight[key] {
		return idemEntry{}, false, true
	}
	c.inflight[key] = true
	return idemEntry{}, false, false
}

func (c *idemCache) finish(key string, status int, body []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.inflight, key)
	c.done[key] = idemEntry{status: status, body: body, at: time.Now()}
	// Opportunistic GC of expired entries (bounded work; the map stays small).
	for k, e := range c.done {
		if time.Since(e.at) >= c.ttl {
			delete(c.done, k)
		}
	}
}

func (c *idemCache) abort(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.inflight, key)
}

// withIdempotency wraps a verb body. If the request carries an idempotency_key,
// a replay returns the stored response and a concurrent duplicate gets 409; the
// captured response of a fresh execution is stored. With no key, fn runs plainly.
// fn returns (status, jsonBody).
func (s *Server) withIdempotency(w http.ResponseWriter, key string, fn func() (int, []byte)) {
	if key == "" {
		st, b := fn()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(st)
		_, _ = w.Write(b)
		return
	}
	entry, replay, inflight := s.idem.begin(key)
	if replay {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-VH-Idempotent-Replay", "1")
		w.WriteHeader(entry.status)
		_, _ = w.Write(entry.body)
		return
	}
	if inflight {
		http.Error(w, "idempotency_key already in progress", http.StatusConflict)
		return
	}
	st, b := fn()
	s.idem.finish(key, st, b)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(st)
	_, _ = w.Write(b)
}

func jsonBytes(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// errResp builds a {error} body for a verb result.
func errResp(msg string) []byte { return jsonBytes(map[string]any{"ok": false, "error": msg}) }

// --- send ------------------------------------------------------------------

// handleSend POSTs a message to a session (the typed `send-message` verb).
// Body: {sessionID, text?|parts?, agent?, model?, variant?, idempotency_key?}.
// Header (optional): If-Idle-Seq: <seq> — compare-and-swap; the send is accepted
// only if the session is still sendable AND its activity hasn't changed since the
// given snapshot seq, else 409. Without the header no CAS is applied (the caller
// owns send-when-idle discipline; see §1.8).
func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		SessionID      string          `json:"sessionID"`
		Text           string          `json:"text"`
		Parts          json.RawMessage `json:"parts"`
		Agent          string          `json:"agent"`
		Model          json.RawMessage `json:"model"`
		Variant        string          `json:"variant"`
		IdempotencyKey string          `json:"idempotency_key"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.SessionID == "" {
		http.Error(w, "sessionID required", http.StatusBadRequest)
		return
	}
	agg := s.aggFor(reqDir(r))

	// Optional CAS: If-Idle-Seq.
	if raw := r.Header.Get(ifIdleSeqHeader); raw != "" {
		providedSeq, perr := strconv.ParseUint(raw, 10, 64)
		if perr != nil {
			http.Error(w, "invalid "+ifIdleSeqHeader+" header", http.StatusBadRequest)
			return
		}
		sendable, activitySeq, exists := agg.Store().SendableNow(body.SessionID)
		if !exists {
			http.Error(w, "unknown session", http.StatusNotFound)
			return
		}
		if !sendable {
			http.Error(w, "session not sendable (busy/blocked) — CAS precondition failed", http.StatusConflict)
			return
		}
		if activitySeq > providedSeq {
			http.Error(w, "session changed since If-Idle-Seq — CAS precondition failed", http.StatusConflict)
			return
		}
	}

	// Build the OpenCode prompt body. Prefer explicit parts; else wrap text.
	ocBody := map[string]any{}
	if len(body.Parts) > 0 {
		ocBody["parts"] = body.Parts
	} else if body.Text != "" {
		ocBody["parts"] = []map[string]any{{"type": "text", "text": body.Text}}
	} else {
		http.Error(w, "text or parts required", http.StatusBadRequest)
		return
	}
	if body.Agent != "" {
		ocBody["agent"] = body.Agent
	}
	if len(body.Model) > 0 {
		ocBody["model"] = body.Model
	}
	if body.Variant != "" {
		ocBody["variant"] = body.Variant
	}

	s.withIdempotency(w, body.IdempotencyKey, func() (int, []byte) {
		resp, err := agg.Client().Prompt(r.Context(), body.SessionID, jsonBytes(ocBody))
		if err != nil {
			return http.StatusBadGateway, errResp(err.Error())
		}
		return http.StatusOK, jsonBytes(map[string]any{"ok": true, "sessionID": body.SessionID, "response": json.RawMessage(orNull(resp))})
	})
}

// --- spawn -----------------------------------------------------------------

// handleSpawn creates a session and optionally sends it a first prompt (the
// `spawn-session` verb). Body: {prompt?, parts?, agent?, model?, title?,
// parentID?, idempotency_key?}; dir via ?dir= / x-opencode-directory. Returns
// {ok, sessionID}.
func (s *Server) handleSpawn(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Prompt         string          `json:"prompt"`
		Parts          json.RawMessage `json:"parts"`
		Agent          string          `json:"agent"`
		Model          json.RawMessage `json:"model"`
		Title          string          `json:"title"`
		ParentID       string          `json:"parentID"`
		IdempotencyKey string          `json:"idempotency_key"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	agg := s.aggFor(reqDir(r))

	s.withIdempotency(w, body.IdempotencyKey, func() (int, []byte) {
		create := map[string]any{}
		if body.Title != "" {
			create["title"] = body.Title
		}
		if body.ParentID != "" {
			create["parentID"] = body.ParentID
		}
		sessRaw, err := agg.Client().CreateSession(r.Context(), jsonBytes(create))
		if err != nil {
			return http.StatusBadGateway, errResp(err.Error())
		}
		var sess struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(sessRaw, &sess)
		if sess.ID == "" {
			return http.StatusBadGateway, errResp("spawn: created session has no id")
		}
		// Optional first prompt.
		if len(body.Parts) > 0 || body.Prompt != "" {
			ocBody := map[string]any{}
			if len(body.Parts) > 0 {
				ocBody["parts"] = body.Parts
			} else {
				ocBody["parts"] = []map[string]any{{"type": "text", "text": body.Prompt}}
			}
			if body.Agent != "" {
				ocBody["agent"] = body.Agent
			}
			if len(body.Model) > 0 {
				ocBody["model"] = body.Model
			}
			if _, err := agg.Client().Prompt(r.Context(), sess.ID, jsonBytes(ocBody)); err != nil {
				// The session exists; surface the prompt failure but return the id so
				// the caller can retry the prompt without re-spawning.
				return http.StatusBadGateway, jsonBytes(map[string]any{"ok": false, "sessionID": sess.ID, "error": "session created but prompt failed: " + err.Error()})
			}
		}
		return http.StatusOK, jsonBytes(map[string]any{"ok": true, "sessionID": sess.ID})
	})
}

// --- abort -----------------------------------------------------------------

// handleAbort cancels a session's in-flight turn. Body: {sessionID,
// idempotency_key?}. NOTE: the resulting idle is asynchronous — callers must wait
// for the session.idle transition before sending again (do not send-after-abort).
func (s *Server) handleAbort(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		SessionID      string `json:"sessionID"`
		IdempotencyKey string `json:"idempotency_key"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.SessionID == "" {
		http.Error(w, "sessionID required", http.StatusBadRequest)
		return
	}
	agg := s.aggFor(reqDir(r))
	s.withIdempotency(w, body.IdempotencyKey, func() (int, []byte) {
		if err := agg.Client().Abort(r.Context(), body.SessionID); err != nil {
			return http.StatusBadGateway, errResp(err.Error())
		}
		return http.StatusOK, jsonBytes(map[string]any{"ok": true})
	})
}

// --- answer-question -------------------------------------------------------

// handleAnswerQuestion replies to a pending question. Body: {questionID,
// answers, idempotency_key?}. answers is OpenCode's shape ([[...]] per question).
// Naturally CAS-on-request-id: replying to a cleared question returns the
// upstream's error.
func (s *Server) handleAnswerQuestion(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		QuestionID     string          `json:"questionID"`
		Answers        json.RawMessage `json:"answers"`
		IdempotencyKey string          `json:"idempotency_key"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.QuestionID == "" || len(body.Answers) == 0 {
		http.Error(w, "questionID and answers required", http.StatusBadRequest)
		return
	}
	agg := s.aggFor(reqDir(r))
	s.withIdempotency(w, body.IdempotencyKey, func() (int, []byte) {
		ocBody := jsonBytes(map[string]any{"answers": body.Answers})
		if err := agg.Client().AnswerQuestion(r.Context(), body.QuestionID, ocBody); err != nil {
			return http.StatusBadGateway, errResp(err.Error())
		}
		return http.StatusOK, jsonBytes(map[string]any{"ok": true})
	})
}

// --- reply-permission ------------------------------------------------------

// handleReplyPermission replies to a pending permission. Body: {permissionID,
// sessionID?, reply, idempotency_key?} where reply ∈ {once, always, reject}.
// sessionID enables the legacy-route fallback for older servers.
func (s *Server) handleReplyPermission(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		PermissionID   string `json:"permissionID"`
		SessionID      string `json:"sessionID"`
		Reply          string `json:"reply"`
		IdempotencyKey string `json:"idempotency_key"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.PermissionID == "" {
		http.Error(w, "permissionID required", http.StatusBadRequest)
		return
	}
	switch body.Reply {
	case "once", "always", "reject":
	default:
		http.Error(w, "reply must be one of: once, always, reject", http.StatusBadRequest)
		return
	}
	agg := s.aggFor(reqDir(r))
	s.withIdempotency(w, body.IdempotencyKey, func() (int, []byte) {
		if err := agg.Client().ReplyPermission(r.Context(), body.PermissionID, body.SessionID, body.Reply); err != nil {
			return http.StatusBadGateway, errResp(err.Error())
		}
		return http.StatusOK, jsonBytes(map[string]any{"ok": true})
	})
}

// decodeBody reads a small JSON body, writing a 400 on failure. Returns false if
// the caller should stop.
func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

// orNull returns the raw bytes or a JSON null when empty (prompt_async replies
// 204 with no body), so the {response} field is always valid JSON.
func orNull(b []byte) []byte {
	if len(b) == 0 {
		return []byte("null")
	}
	return b
}
