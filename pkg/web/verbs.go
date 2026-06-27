package web

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// upstreamStatus maps an opencode write error to the verb's HTTP status: a 4xx
// from opencode is propagated (so a stale request-id / bad arg surfaces as a
// client error, not an opaque 502); transport or 5xx → 502. With goneOn404, a
// 404 (the request/resource is no longer pending) becomes 410 Gone — the
// request-id CAS semantics for answer-question / reply-permission (§5).
func upstreamStatus(err error, goneOn404 bool) int {
	var oe *opencode.Error
	if errors.As(err, &oe) {
		if goneOn404 && oe.Status == http.StatusNotFound {
			return http.StatusGone
		}
		if oe.Status >= 400 && oe.Status < 500 {
			return oe.Status
		}
	}
	return http.StatusBadGateway
}

// coordinationFeature is the first Feature module (B dogfood): the typed,
// daemon-aware write verbs (A1) — send / spawn / abort / answer-question /
// reply-permission. Promoted from transparent /oc/* passthrough so the daemon
// observes every write, dedups retries (idempotency_key), and can compare-and-
// swap on idle (If-Idle-Seq). They forward to opencode via the aggregator's
// client. Archive is a separate core route (archive.go). All mechanism — they
// carry no policy about WHEN to act; the caller (a coordinator) decides that.
type coordinationFeature struct{}

func (coordinationFeature) Name() string { return "coordination" }

func (coordinationFeature) Routes(svc Services) map[string]http.HandlerFunc {
	h := coordHandlers{svc}
	return map[string]http.HandlerFunc{
		"/vh/send":             h.send,
		"/vh/spawn":            h.spawn,
		"/vh/abort":            h.abort,
		"/vh/answer-question":  h.answerQuestion,
		"/vh/reply-permission": h.replyPermission,
	}
}

// ifIdleSeqHeader carries the snapshot seq for the send CAS (see send). The
// idempotency key travels in the request body, not a header.
const ifIdleSeqHeader = "If-Idle-Seq"

// outcome values classify a verb result so a caller parsing the JSON body (not
// headers) can classify it for its accounting. ONLY "created" means a new session
// was minted (counting); all others are non-counting.
//   - created                  : spawn minted a new session.
//   - reused                   : an idempotency replay of a prior success — the
//     side effect already happened; don't re-count it.
//   - prompt_retried_to_existing: a prompt was delivered into an existing session
//     (send). Not counting (the session predates it).
//   - refused                  : deterministic rejection before any side effect
//     (the spawn handler's fail-closed permission_policy validation path: an
//     unknown/illegal policy is refused before mint — no session created,
//     nothing widened).
//   - failed                   : accepted but errored upstream (transient/retryable).
const (
	OutcomeCreated       = "created"
	OutcomeReused        = "reused"
	OutcomePromptRetried = "prompt_retried_to_existing"
	OutcomeRefused       = "refused"
	OutcomeFailed        = "failed"
)

type coordHandlers struct{ svc Services }

// send POSTs a message to a session. Body: {sessionID, text?|parts?, agent?,
// model?, variant?, idempotency_key?}. Optional header If-Idle-Seq: <seq> —
// compare-and-swap; the send is accepted only if the session is still sendable
// AND its activity hasn't changed since the given snapshot seq, else 409. Without
// the header no CAS is applied (the caller owns send-when-idle discipline §1.8).
func (h coordHandlers) send(w http.ResponseWriter, r *http.Request) {
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
	agg := h.svc.Agg(h.svc.ReqDir(r))

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

	h.svc.WithIdempotency(w, body.IdempotencyKey, func() (int, []byte, string) {
		resp, err := agg.Client().Prompt(r.Context(), body.SessionID, jsonBytes(ocBody))
		if err != nil {
			return upstreamStatus(err, false), errRespOutcome(err.Error(), OutcomeFailed), OutcomeFailed
		}
		return http.StatusOK, jsonBytes(map[string]any{"ok": true, "sessionID": body.SessionID, "response": json.RawMessage(orNull(resp)), "outcome": OutcomePromptRetried}), OutcomePromptRetried
	})
}

// spawn creates a session and optionally sends it a first prompt. Body:
// {prompt?, parts?, agent?, model?, title?, parentID?, idempotency_key?,
//
//	permission_policy?}; dir via ?dir= / x-opencode-directory. Returns {ok,
//
// sessionID}. permission_policy is vh-solara-only: it arms a fail-closed
// permission watcher on the spawned session (unattended/automated spawning) so a
// prompt can't hang the worker. It is NOT forwarded to opencode's CreateSession
// (no equivalent single flag there); the create body is built from title+parentID
// only, as always.
func (h coordHandlers) spawn(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Prompt           string          `json:"prompt"`
		Parts            json.RawMessage `json:"parts"`
		Agent            string          `json:"agent"`
		Model            json.RawMessage `json:"model"`
		Title            string          `json:"title"`
		ParentID         string          `json:"parentID"`
		IdempotencyKey   string          `json:"idempotency_key"`
		PermissionPolicy string          `json:"permission_policy"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	agg := h.svc.Agg(h.svc.ReqDir(r))

	h.svc.WithIdempotency(w, body.IdempotencyKey, func() (int, []byte, string) {
		// Fail-closed validation BEFORE mint: an unknown permission_policy is
		// REFUSED with no CreateSession call (no side effect, no widening). A
		// prompt-influenced spawner passing garbage can, at worst, get a refusal
		// or a more-restrictive session — never a wider grant. Absent/empty means
		// a normal spawn (no binding); "fail_fast"/"auto_reject" arm the watcher.
		// There is deliberately NO permissive value (no auto_allow/always).
		switch body.PermissionPolicy {
		case "", "fail_fast", "auto_reject":
		default:
			return http.StatusBadRequest, jsonBytes(map[string]any{
				"ok":                false,
				"error":             "unknown permission_policy: " + body.PermissionPolicy,
				"outcome":           OutcomeRefused,
				"sessionID":         "",
				"permission_policy": body.PermissionPolicy,
			}), OutcomeRefused
		}
		create := map[string]any{}
		if body.Title != "" {
			create["title"] = body.Title
		}
		if body.ParentID != "" {
			create["parentID"] = body.ParentID
		}
		sessRaw, err := agg.Client().CreateSession(r.Context(), jsonBytes(create))
		if err != nil {
			return upstreamStatus(err, false), errRespOutcome(err.Error(), OutcomeFailed), OutcomeFailed
		}
		var sess struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(sessRaw, &sess)
		if sess.ID == "" {
			return http.StatusBadGateway, errRespOutcome("spawn: created session has no id", OutcomeFailed), OutcomeFailed
		}
		// Arm the fail-closed watcher for this session. This runs only on the
		// fresh-execution path (a replay returns the cached response without
		// re-running fn), so the binding is registered exactly once. The watcher
		// was already subscribed to this dir's store by aggFor above, so a later
		// permission prompt will be auto-rejected (never "always") and surface
		// the permission_blocked observable on the gate.
		if body.PermissionPolicy != "" {
			h.svc.RegisterFailFast(sess.ID)
		}
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
				// A session WAS minted (sess.ID set) even though its first turn failed. By the
				// accounting rule a minted session is counting, so outcome MUST be "created"
				// (not "failed", which is reserved for the no-mint case). ok:false + outcome:"created"
				// is intentional and correct: outcome is the mint/accounting signal (a session exists
				// → the session is counted), ok is the operational status (the first turn did not complete).
				// The classification is also "created" (success-class) so an idempotency replay
				// rewrites the body outcome to "reused" — the session was already counted on the first
				// attempt and must not be double-counted on retry.
				return upstreamStatus(err, false), jsonBytes(map[string]any{"ok": false, "sessionID": sess.ID, "error": "session created but prompt failed: " + err.Error(), "outcome": OutcomeCreated}), OutcomeCreated
			}
		}
		return http.StatusOK, jsonBytes(map[string]any{"ok": true, "sessionID": sess.ID, "outcome": OutcomeCreated}), OutcomeCreated
	})
}

// abort cancels a session's in-flight turn. Body: {sessionID, idempotency_key?}.
// NOTE: the resulting idle is asynchronous — callers must wait for the
// session.idle transition before sending again (do not send-after-abort).
func (h coordHandlers) abort(w http.ResponseWriter, r *http.Request) {
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
	agg := h.svc.Agg(h.svc.ReqDir(r))
	h.svc.WithIdempotency(w, body.IdempotencyKey, func() (int, []byte, string) {
		if err := agg.Client().Abort(r.Context(), body.SessionID); err != nil {
			return upstreamStatus(err, false), errResp(err.Error()), ""
		}
		return http.StatusOK, jsonBytes(map[string]any{"ok": true}), ""
	})
}

// answerQuestion replies to a pending question. Body: {questionID, answers,
// idempotency_key?}. Naturally CAS-on-request-id (a cleared question errors
// upstream).
func (h coordHandlers) answerQuestion(w http.ResponseWriter, r *http.Request) {
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
	agg := h.svc.Agg(h.svc.ReqDir(r))
	h.svc.WithIdempotency(w, body.IdempotencyKey, func() (int, []byte, string) {
		ocBody := jsonBytes(map[string]any{"answers": body.Answers})
		if err := agg.Client().AnswerQuestion(r.Context(), body.QuestionID, ocBody); err != nil {
			return upstreamStatus(err, true), errResp(err.Error()), ""
		}
		return http.StatusOK, jsonBytes(map[string]any{"ok": true}), ""
	})
}

// replyPermission replies to a pending permission. Body: {permissionID,
// sessionID?, reply: once|always|reject, idempotency_key?}.
func (h coordHandlers) replyPermission(w http.ResponseWriter, r *http.Request) {
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
	agg := h.svc.Agg(h.svc.ReqDir(r))
	h.svc.WithIdempotency(w, body.IdempotencyKey, func() (int, []byte, string) {
		if err := agg.Client().ReplyPermission(r.Context(), body.PermissionID, body.SessionID, body.Reply); err != nil {
			return upstreamStatus(err, true), errResp(err.Error()), ""
		}
		return http.StatusOK, jsonBytes(map[string]any{"ok": true}), ""
	})
}
