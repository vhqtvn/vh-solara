package web

import (
	"encoding/json"
	"net/http"
	"strconv"
)

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

	h.svc.WithIdempotency(w, body.IdempotencyKey, func() (int, []byte) {
		resp, err := agg.Client().Prompt(r.Context(), body.SessionID, jsonBytes(ocBody))
		if err != nil {
			return http.StatusBadGateway, errResp(err.Error())
		}
		return http.StatusOK, jsonBytes(map[string]any{"ok": true, "sessionID": body.SessionID, "response": json.RawMessage(orNull(resp))})
	})
}

// spawn creates a session and optionally sends it a first prompt. Body:
// {prompt?, parts?, agent?, model?, title?, parentID?, idempotency_key?}; dir via
// ?dir= / x-opencode-directory. Returns {ok, sessionID}.
func (h coordHandlers) spawn(w http.ResponseWriter, r *http.Request) {
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
	agg := h.svc.Agg(h.svc.ReqDir(r))

	h.svc.WithIdempotency(w, body.IdempotencyKey, func() (int, []byte) {
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
				return http.StatusBadGateway, jsonBytes(map[string]any{"ok": false, "sessionID": sess.ID, "error": "session created but prompt failed: " + err.Error()})
			}
		}
		return http.StatusOK, jsonBytes(map[string]any{"ok": true, "sessionID": sess.ID})
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
	h.svc.WithIdempotency(w, body.IdempotencyKey, func() (int, []byte) {
		if err := agg.Client().Abort(r.Context(), body.SessionID); err != nil {
			return http.StatusBadGateway, errResp(err.Error())
		}
		return http.StatusOK, jsonBytes(map[string]any{"ok": true})
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
	h.svc.WithIdempotency(w, body.IdempotencyKey, func() (int, []byte) {
		ocBody := jsonBytes(map[string]any{"answers": body.Answers})
		if err := agg.Client().AnswerQuestion(r.Context(), body.QuestionID, ocBody); err != nil {
			return http.StatusBadGateway, errResp(err.Error())
		}
		return http.StatusOK, jsonBytes(map[string]any{"ok": true})
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
	h.svc.WithIdempotency(w, body.IdempotencyKey, func() (int, []byte) {
		if err := agg.Client().ReplyPermission(r.Context(), body.PermissionID, body.SessionID, body.Reply); err != nil {
			return http.StatusBadGateway, errResp(err.Error())
		}
		return http.StatusOK, jsonBytes(map[string]any{"ok": true})
	})
}
