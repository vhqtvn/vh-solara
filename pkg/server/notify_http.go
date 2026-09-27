package server

// notify_http.go — the /vh/notify/* HTTP family (slice S1; see
// notify_transport.go for the program header). Controller userMux,
// session-cookie auth family — the same chain as /vh/fleet/config:
//
//	POST   /vh/notify/tokens       app submits {token, label?} (CSRF)
//	GET    /vh/notify/tokens       masked list for the management UI
//	DELETE /vh/notify/tokens/{id}  revoke (CSRF; 404 unknown id)
//	PATCH  /vh/notify/tokens/{id}  update label/scope (CSRF; strict decode)
//	POST   /vh/notify/test         test-send {token?|id?} (CSRF)
//
// Conventions carried over from the fleet-config family:
//   - Mutations require X-VH-CSRF enforced IN the handler (403 without
//     it): the controller csrfGuard (daemon.go) only gates unsafe methods
//     under /api/, and these are /vh/ mutations outside its scope.
//   - GET is CSRF-exempt (repo convention — GET carries no state change);
//     unauthenticated requests under /vh/* get auth's clean API-class 401.
//   - Disabled postures are HONEST refusals, never silent no-ops: no
//     --notify-store path ⇒ 409 naming the flag on every family endpoint;
//     no --notify-fcm-credentials ⇒ test-send 409s naming the flag (the
//     registry itself still works — tokens can be enrolled before
//     credentials exist).
//   - Bodies are strict JSON (DisallowUnknownFields, exactly one
//     document) capped at 4 KiB (http.MaxBytesReader, like the config
//     PUT's cap discipline). Unlike the config FILE reads, request bodies
//     do not accept JSONC — they are app-generated, not hand-edited.
//   - Responses are additive schema-1 JSON and NEVER echo a raw token:
//     notifyEntryWire renders a masked preview only.
//
// hostInterceptor carves the whole /vh/notify/ prefix out of the
// worker-subdomain proxy (daemon.go): the family is controller-owned and
// must answer from every host the SPA/app can be served through.

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// maxNotifyBodyBytes caps every /vh/notify/* request body (a token
// submission is well under 2 KiB; anything near 4 KiB is a client bug or
// abuse). Deliberately sized so a maximal (2048-byte) token plus JSON
// syntax always fits.
const maxNotifyBodyBytes = 4 << 10

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// requireNotifyCSRF enforces the repo mutation convention in-handler (the
// /api/-scoped csrfGuard cannot see /vh/ paths). Returns false after
// writing the 403.
func requireNotifyCSRF(w http.ResponseWriter, r *http.Request) bool {
	if r.Header.Get(csrfHeader) == "" {
		http.Error(w, "missing "+csrfHeader+" header (CSRF protection)", http.StatusForbidden)
		return false
	}
	return true
}

// notifyStoreDisabled writes the family's honest disabled posture (409
// naming the flag), mirroring the writable:false precedent.
func notifyStoreDisabled(w http.ResponseWriter) {
	http.Error(w, "notification registry is not configured: no --notify-store path is set on this controller", http.StatusConflict)
}

// decodeNotifyBody strictly decodes exactly one bounded JSON document
// into dst. Error text is prefixed by what so each endpoint's 400s name
// their surface.
func decodeNotifyBody(w http.ResponseWriter, r *http.Request, what string, dst any) error {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxNotifyBodyBytes))
	if err != nil {
		http.Error(w, "invalid "+what+": request body exceeds the byte cap", http.StatusBadRequest)
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			http.Error(w, "invalid "+what+": empty document", http.StatusBadRequest)
			return err
		}
		http.Error(w, "invalid "+what+": "+err.Error(), http.StatusBadRequest)
		return err
	}
	var trailing json.RawMessage
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		// NOTE: err is nil here when a trailing document WAS decoded —
		// the returned error must be non-nil either way, or the caller
		// would proceed with the partially-decoded first document (the
		// bug the lifecycle test caught: a 400 on the wire AND a create).
		http.Error(w, "invalid "+what+": expected exactly one JSON document (trailing content)", http.StatusBadRequest)
		return errors.New("trailing content")
	}
	return nil
}

// writeNotifyJSON renders the family's response envelope.
func writeNotifyJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-cache")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// testNotifyMessage is the fixed message POST /vh/notify/test sends —
// deterministic on purpose (S2 will define the real event vocabulary;
// the operator comparing "did my phone buzz" needs no timestamp noise).
func testNotifyMessage() NotifyMessage {
	return NotifyMessage{
		Title: "vh-solara",
		Body:  "Test notification — push transport is working.",
		Data:  map[string]string{"vh_kind": "test"},
	}
}

// notifySender returns the configured transport (nullNotifier for the
// nil/literal-Daemon posture).
func (d *Daemon) notifySender() Notifier {
	if d.notifyTransport == nil {
		return nullNotifier{}
	}
	return d.notifyTransport
}

// ---------------------------------------------------------------------------
// POST /vh/notify/tokens — enroll (idempotent by raw token)
// ---------------------------------------------------------------------------

// handleNotifyTokenCreate serves POST /vh/notify/tokens.
//
// Check order: CSRF (403) → registry configured (409) → decode/validate
// (400) → submit (500 on persist failure). 201 + masked entry on create;
// 200 + masked entry (created:false) when the token is already registered
// — the app's re-registration on every boot is the expected flow.
func (d *Daemon) handleNotifyTokenCreate(w http.ResponseWriter, r *http.Request) {
	if !requireNotifyCSRF(w, r) {
		return
	}
	if !d.notifyStore.configured() {
		notifyStoreDisabled(w)
		return
	}
	var req struct {
		Token string `json:"token"`
		Label string `json:"label"`
	}
	if err := decodeNotifyBody(w, r, "token submission", &req); err != nil {
		return
	}
	if err := validNotifyToken(req.Token); err != nil {
		http.Error(w, "invalid token submission — token: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := validateNotifyLabel(req.Label); err != nil {
		http.Error(w, "invalid token submission — "+err.Error(), http.StatusBadRequest)
		return
	}
	entry, created, err := d.notifyStore.submit(req.Token, req.Label)
	if err != nil {
		http.Error(w, "notification registry: "+err.Error(), http.StatusInternalServerError)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeNotifyJSON(w, status, struct {
		Schema  int             `json:"schema"`
		Created bool            `json:"created"`
		Token   notifyTokenWire `json:"token"`
	}{Schema: 1, Created: created, Token: notifyEntryWire(entry)})
}

// ---------------------------------------------------------------------------
// GET /vh/notify/tokens — masked list
// ---------------------------------------------------------------------------

// handleNotifyTokenList serves GET /vh/notify/tokens: the masked registry
// for the management UI (S3). Read-only and CSRF-exempt (repo
// convention); unauthenticated requests get auth's clean 401 before the
// handler runs. 409 (not an empty 200) when no store is configured — an
// empty list would read as "zero devices registered", which is a lie.
func (d *Daemon) handleNotifyTokenList(w http.ResponseWriter, r *http.Request) {
	if !d.notifyStore.configured() {
		notifyStoreDisabled(w)
		return
	}
	snap := d.notifyStore.snapshot()
	tokens := make([]notifyTokenWire, 0, len(snap.entries))
	for i := range snap.entries {
		tokens = append(tokens, notifyEntryWire(snap.entries[i]))
	}
	writeNotifyJSON(w, http.StatusOK, struct {
		Schema int               `json:"schema"`
		Tokens []notifyTokenWire `json:"tokens"`
	}{Schema: 1, Tokens: tokens})
}

// ---------------------------------------------------------------------------
// DELETE /vh/notify/tokens/{id} — revoke
// ---------------------------------------------------------------------------

// handleNotifyTokenDelete serves DELETE /vh/notify/tokens/{id}: 204 on
// success, 404 for an unknown id, 409 when the registry is disabled,
// 500 on persist failure.
func (d *Daemon) handleNotifyTokenDelete(w http.ResponseWriter, r *http.Request) {
	if !requireNotifyCSRF(w, r) {
		return
	}
	if !d.notifyStore.configured() {
		notifyStoreDisabled(w)
		return
	}
	id := r.PathValue("id")
	if !validNotifyID(id) {
		http.Error(w, "invalid token id", http.StatusBadRequest)
		return
	}
	ok, err := d.notifyStore.delete(id)
	if !ok {
		http.Error(w, "unknown token id", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "notification registry: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// PATCH /vh/notify/tokens/{id} — update label/scope
// ---------------------------------------------------------------------------

// notifyScopePatchWire is the strict PATCH body's scope member: BOTH
// fields required when scope is present (scope is replaced wholesale —
// the brief's complete-replacement semantics; a missing member is a 400,
// never a silent default).
type notifyScopePatchWire struct {
	Enabled    *bool     `json:"enabled"`
	Conditions *[]string `json:"conditions"`
}

// handleNotifyTokenPatch serves PATCH /vh/notify/tokens/{id}: a partial
// update of label and/or scope (unknown fields rejected; at least one
// field required — a fully-empty patch is a 400, not a no-op). 200 with
// the masked entry on success; 404 unknown id; 409 disabled.
func (d *Daemon) handleNotifyTokenPatch(w http.ResponseWriter, r *http.Request) {
	if !requireNotifyCSRF(w, r) {
		return
	}
	if !d.notifyStore.configured() {
		notifyStoreDisabled(w)
		return
	}
	id := r.PathValue("id")
	if !validNotifyID(id) {
		http.Error(w, "invalid token id", http.StatusBadRequest)
		return
	}
	var req struct {
		Label *string               `json:"label"`
		Scope *notifyScopePatchWire `json:"scope"`
	}
	if err := decodeNotifyBody(w, r, "token patch", &req); err != nil {
		return
	}
	if req.Label == nil && req.Scope == nil {
		http.Error(w, "invalid token patch: nothing to update (set label and/or scope)", http.StatusBadRequest)
		return
	}
	var patch notifyPatch
	if req.Label != nil {
		if err := validateNotifyLabel(*req.Label); err != nil {
			http.Error(w, "invalid token patch — "+err.Error(), http.StatusBadRequest)
			return
		}
		patch.Label = req.Label
	}
	if req.Scope != nil {
		if req.Scope.Enabled == nil {
			http.Error(w, "invalid token patch — scope.enabled is required when scope is present", http.StatusBadRequest)
			return
		}
		if req.Scope.Conditions == nil {
			http.Error(w, "invalid token patch — scope.conditions is required when scope is present (empty list = all nine condition kinds)", http.StatusBadRequest)
			return
		}
		scope := notifyScope{Enabled: *req.Scope.Enabled, Conditions: *req.Scope.Conditions}
		if err := validateNotifyScope(scope); err != nil {
			http.Error(w, "invalid token patch — scope."+err.Error(), http.StatusBadRequest)
			return
		}
		patch.Scope = &scope
	}
	entry, ok, err := d.notifyStore.patch(id, patch)
	if err != nil {
		// Validation errors inside patch (merged-entry check) are client
		// errors; persist failures are ours.
		http.Error(w, "notification registry: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "unknown token id", http.StatusNotFound)
		return
	}
	writeNotifyJSON(w, http.StatusOK, struct {
		Schema int             `json:"schema"`
		Token  notifyTokenWire `json:"token"`
	}{Schema: 1, Token: notifyEntryWire(entry)})
}

// ---------------------------------------------------------------------------
// POST /vh/notify/test — test-send
// ---------------------------------------------------------------------------

// handleNotifyTest serves POST /vh/notify/test.
//
// Body {token?, id?} — EXACTLY ONE of the two: a bare token lets the
// operator test BEFORE registering (e.g. pasting a token from the app);
// id resolves the stored token through the registry (and records the
// attempt in last_used_at/last_error, best-effort).
//
// Check order: CSRF (403) → transport configured (409 naming
// --notify-fcm-credentials) → decode (400) → resolve token (409 store
// disabled for the by-id path / 404 unknown id / 400 bad bare token) →
// send → 200 {sent, transport, error?}.
//
// The response reports PROVIDER ACCEPTANCE only ("sent: the transport
// accepted the message") — never device delivery; the error string is
// the sanitized transport error (typed classes surface their meaning,
// e.g. invalid/unregistered tokens, so the operator can diagnose a dead
// registration without a separate API).
func (d *Daemon) handleNotifyTest(w http.ResponseWriter, r *http.Request) {
	if !requireNotifyCSRF(w, r) {
		return
	}
	sender := d.notifySender()
	if notifyTransportDisabled(d.notifyTransport) {
		http.Error(w, "notification transport is not configured: no --notify-fcm-credentials path is set on this controller (test-send unavailable)", http.StatusConflict)
		return
	}
	var req struct {
		Token string `json:"token"`
		ID    string `json:"id"`
	}
	if err := decodeNotifyBody(w, r, "test-send request", &req); err != nil {
		return
	}
	if (req.Token == "") == (req.ID == "") {
		http.Error(w, "invalid test-send request: provide exactly one of token or id", http.StatusBadRequest)
		return
	}
	var (
		token    string
		storeIDs []string
	)
	if req.ID != "" {
		if !d.notifyStore.configured() {
			notifyStoreDisabled(w)
			return
		}
		if !validNotifyID(req.ID) {
			http.Error(w, "invalid token id", http.StatusBadRequest)
			return
		}
		entry, ok := d.notifyStore.byID(req.ID)
		if !ok {
			http.Error(w, "unknown token id", http.StatusNotFound)
			return
		}
		token = entry.Token
		storeIDs = []string{req.ID}
	} else {
		if err := validNotifyToken(req.Token); err != nil {
			http.Error(w, "invalid test-send request — token: "+err.Error(), http.StatusBadRequest)
			return
		}
		token = req.Token
	}
	sendErr := sender.Send(r.Context(), token, testNotifyMessage())
	// Best-effort telemetry on the by-id path: never unwinds the send
	// result, never blocks on persist failure.
	for _, id := range storeIDs {
		d.notifyStore.recordSendResult(id, sendErr)
	}
	resp := struct {
		Schema    int    `json:"schema"`
		Sent      bool   `json:"sent"`
		Transport string `json:"transport"`
		Error     string `json:"error,omitempty"`
	}{Schema: 1, Sent: sendErr == nil, Transport: sender.Name()}
	if sendErr != nil {
		resp.Error = truncateRunes(sendErr.Error(), 512)
	}
	writeNotifyJSON(w, http.StatusOK, resp)
}

// SetNotifyTransport installs the push transport (cmd/server.go wiring:
// an *FCMNotifier from --notify-fcm-credentials, or NewNullNotifier()).
// nil disables (the literal-Daemon posture). Set before Start.
func (d *Daemon) SetNotifyTransport(n Notifier) {
	d.notifyTransport = n
}
