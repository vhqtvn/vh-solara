package server

// notify_http.go — the /vh/notify/* HTTP family (slice S1; v4 registration
// + probe since notify controller-hub S4; see notify_transport.go for the
// program header). Controller userMux, session-cookie auth family — the
// same chain as /vh/fleet/config:
//
//	POST   /vh/notify/tokens          v4 PUBLIC registration (CSRF): the app
//	                                 submits {token, label?, push_policy?}
//	GET    /vh/notify/tokens          v4 PUBLIC channel probe (never errors)
//	GET    /vh/admin/notify/tokens    masked list for the management UI
//	DELETE /vh/notify/tokens/{id}     revoke (CSRF; 404 unknown id) [admin,
//	                                 relocates to /vh/admin/notify/* in S5]
//	PATCH  /vh/notify/tokens/{id}     update label/scope (CSRF; strict decode)
//	POST   /vh/notify/test            test-send {token?|id?} (CSRF)
//
// Conventions carried over from the fleet-config family:
//   - Mutations require X-VH-CSRF enforced IN the handler (403 without
//     it): the controller csrfGuard (daemon.go) only gates unsafe methods
//     under /api/, and these are /vh/ mutations outside its scope.
//   - GET is CSRF-exempt (repo convention — GET carries no state change);
//     unauthenticated requests under /vh/* get auth's clean API-class 401.
//   - Honest refusals, never silent no-ops: no --notify-store path ⇒ the
//     v4 PUBLIC POST answers 503 "notify unavailable" BEFORE body
//     validation (the worker-compatible channel-unavailable posture, v4
//     §3.1 — 503 wins over 400); the ADMIN family (masked list,
//     DELETE/PATCH/{id}, test-send) keeps its honest 409 posture naming
//     the flag until S5 relocates it; no --notify-fcm-credentials ⇒
//     test-send 409s naming the flag (the registry itself still works —
//     tokens can be enrolled before credentials exist).
//   - Bodies are strict JSON (DisallowUnknownFields, exactly one
//     document) capped at 4 KiB (http.MaxBytesReader, like the config
//     PUT's cap discipline). Unlike the config FILE reads, request bodies
//     do not accept JSONC — they are app-generated, not hand-edited.
//   - The v4 PUBLIC registration response is exactly {"ok":true} — no
//     masked entry echo, never a token value (v4 §3.1). Every error the
//     public registration route answers after the CSRF gate is the v4
//     JSON envelope {"ok":false,"error":…} (t1a-F2/t1c-F2 — the response
//     table in notify-fcm.md §3.1; the plain-text http.Error renderer
//     stays on the ADMIN family only). The ADMIN masked list renders
//     notifyTokenWire (preview only).
//
// hostInterceptor carves the whole /vh/notify/ prefix out of the
// worker-subdomain proxy (daemon.go): the family is controller-owned and
// must answer from every host the SPA/app can be served through.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/alerts"
)

// maxNotifyBodyBytes caps every /vh/notify/* request body (a token
// submission is well under 2 KiB; anything near 4 KiB is a client bug or
// abuse). Deliberately sized so a maximal (2048-byte) token plus JSON
// syntax always fits.
const maxNotifyBodyBytes = 4 << 10

// notifyTestSendInterval is the minimum spacing between test sends
// (per-Daemon, in-memory — see the Daemon fields). Test sends drive the
// REAL transport (an operator comparing "did my phone buzz" needs no
// faster cadence), and FCM budgets are shared with the watcher's real
// dispatches, so a rapid re-click loop must be refused server-side, not
// just de-bounced in one UI.
const notifyTestSendInterval = 10 * time.Second

// notifyTestSendNow is the clock seam for the test-send rate limit
// (house pattern: a package var so lane-1 tests advance time
// deterministically instead of sleeping). Production reads time.Now.
var notifyTestSendNow = time.Now

// notifyTestSendAllow is the check-and-record gate for one test send:
// when the interval since the last ATTEMPT has elapsed it records now
// and returns ok; otherwise it returns the remaining wait WITHOUT
// recording (a refused send must not extend the window). The attempt
// (not the success) is what consumes a slot — a failed send hit the
// provider exactly like a successful one.
func (d *Daemon) notifyTestSendAllow() (ok bool, wait time.Duration) {
	d.notifyTestSendMu.Lock()
	defer d.notifyTestSendMu.Unlock()
	now := notifyTestSendNow()
	if !d.notifyTestSendLast.IsZero() {
		if elapsed := now.Sub(d.notifyTestSendLast); elapsed < notifyTestSendInterval {
			return false, notifyTestSendInterval - elapsed
		}
	}
	d.notifyTestSendLast = now
	return true, 0
}

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

// decodeStrictNotifyBody is the strict-decode core shared by the
// plain-text and v4-envelope wrappers: it decodes exactly one bounded
// JSON document into dst and returns the 400 message on failure ("" on
// success) WITHOUT writing the response — rendering is the wrapper's
// concern. w feeds only http.MaxBytesReader's connection management.
func decodeStrictNotifyBody(w http.ResponseWriter, r *http.Request, what string, dst any) (string, error) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxNotifyBodyBytes))
	if err != nil {
		return "invalid " + what + ": request body exceeds the byte cap", err
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return "invalid " + what + ": empty document", err
		}
		return "invalid " + what + ": " + err.Error(), err
	}
	var trailing json.RawMessage
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		// NOTE: err is nil here when a trailing document WAS decoded —
		// the returned error must be non-nil either way, or the caller
		// would proceed with the partially-decoded first document (the
		// bug the lifecycle test caught: a 400 on the wire AND a create).
		return "invalid " + what + ": expected exactly one JSON document (trailing content)", errors.New("trailing content")
	}
	return "", nil
}

// decodeNotifyBody strictly decodes exactly one bounded JSON document
// into dst, answering failures with the family's PLAIN-TEXT 400 (the
// admin-surface renderer). Error text is prefixed by what so each
// endpoint's 400s name their surface.
func decodeNotifyBody(w http.ResponseWriter, r *http.Request, what string, dst any) error {
	msg, err := decodeStrictNotifyBody(w, r, what, dst)
	if err != nil {
		http.Error(w, msg, http.StatusBadRequest)
	}
	return err
}

// decodeNotifyBodyV4 is decodeNotifyBody's v4-public variant: identical
// strictness, but failures render through the JSON envelope (t1c-F2 —
// the public registration route answers every error as
// {"ok":false,"error":…} like the mirrored worker route; status codes
// unchanged).
func decodeNotifyBodyV4(w http.ResponseWriter, r *http.Request, what string, dst any) error {
	msg, err := decodeStrictNotifyBody(w, r, what, dst)
	if err != nil {
		notifyV4Error(w, http.StatusBadRequest, msg)
	}
	return err
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
// POST /vh/notify/tokens — v4 public registration (idempotent by raw token)
// ---------------------------------------------------------------------------

// notifyV4Error renders the v4 public error envelope {"ok":false,...}.
func notifyV4Error(w http.ResponseWriter, status int, msg string) {
	writeNotifyJSON(w, status, struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}{OK: false, Error: msg})
}

// handleNotifyTokenCreate serves POST /vh/notify/tokens — the v4 central
// registration contract (notify-fcm.md §3.1; golden fixture
// registration_request_v4.json). The body {token,label?,push_policy?} is
// the token's COMPLETE desired state (full-state POST rule: a re-POST
// without push_policy RESETS the policy to when_unattended — clients must
// always send the field); it never touches the administrative scope.
//
// Check order: CSRF (403) → channel unconfigured 503 "notify unavailable"
// BEFORE body validation (the interpreted-behavior gate: 503 wins over
// 400, exactly like the worker route) → decode (400) → token required
// (400) → policy vocabulary (400 "invalid push_policy") → submit (cap →
// 400 "token limit reached"; persistence → 500). Success answers
// 200 {"ok":true} — the registration NEVER echoes a masked entry or any
// token material on the public surface. EVERY error this handler answers
// after the CSRF gate is the v4 JSON envelope {"ok":false,"error":…}
// (t1a-F2/t1c-F2) — never a plain-text http.Error.
func (d *Daemon) handleNotifyTokenCreate(w http.ResponseWriter, r *http.Request) {
	if !requireNotifyCSRF(w, r) {
		return
	}
	if !d.notifyStore.configured() {
		notifyV4Error(w, http.StatusServiceUnavailable, "notify unavailable")
		return
	}
	var req struct {
		Token      string `json:"token"`
		Label      string `json:"label"`
		PushPolicy string `json:"push_policy"` // "" | when_unattended | always ("" = when_unattended)
	}
	if err := decodeNotifyBodyV4(w, r, "token submission", &req); err != nil {
		return
	}
	if req.Token == "" {
		notifyV4Error(w, http.StatusBadRequest, alerts.ErrNotifyTokenRequired.Error())
		return
	}
	if err := validNotifyToken(req.Token); err != nil {
		notifyV4Error(w, http.StatusBadRequest, "invalid token submission — token: "+err.Error())
		return
	}
	if req.PushPolicy != "" && req.PushPolicy != alerts.PolicyWhenUnattended && req.PushPolicy != alerts.PolicyAlways {
		notifyV4Error(w, http.StatusBadRequest, alerts.ErrNotifyTokenPolicy.Error())
		return
	}
	_, _, err := d.notifyStore.submit(req.Token, req.Label, req.PushPolicy)
	if err != nil {
		if errors.Is(err, alerts.ErrNotifyTokenCap) {
			notifyV4Error(w, http.StatusBadRequest, alerts.ErrNotifyTokenCap.Error())
			return
		}
		notifyV4Error(w, http.StatusInternalServerError, "notification registry: "+err.Error())
		return
	}
	writeNotifyJSON(w, http.StatusOK, struct {
		OK bool `json:"ok"`
	}{OK: true})
}

// ---------------------------------------------------------------------------
// GET /vh/notify/tokens — the v4 channel probe (never an error)
// ---------------------------------------------------------------------------

// notifyProbeWire is the v4 probe response — the worker probe shape with
// CENTRAL semantics (v4 §3.1; golden fixture probe_response_v4.json):
// enabled reports the controller sender's configuration/readiness (the
// central dispatcher is armed with a configured transport), NOT worker
// coverage; policies carries token COUNTS by push_policy; the
// last_attempt/last_error pair keeps the v3 LATEST-COMPLETED-ATTEMPT
// semantics, describing the CENTRAL sender's attempts. Token values and
// labels are never returned by any read route.
type notifyProbeWire struct {
	Enabled     bool           `json:"enabled"`
	Count       int            `json:"count"`
	Policies    map[string]int `json:"policies"`
	LastAttempt string         `json:"last_attempt"`
	LastError   string         `json:"last_error"`
}

// handleNotifyTokenProbe serves GET /vh/notify/tokens. Never an error (the
// app verifies connectivity by this route's HTTP success alone — keep it
// 200-always): an unconfigured store reports the honest disabled shape
// rather than a 409, unlike the admin family.
func (d *Daemon) handleNotifyTokenProbe(w http.ResponseWriter, r *http.Request) {
	probe := notifyProbeWire{
		Enabled:  false,
		Policies: map[string]int{alerts.PolicyWhenUnattended: 0, alerts.PolicyAlways: 0},
	}
	if d.notifyStore.configured() {
		snap := d.notifyStore.snapshot()
		probe.Count = len(snap.entries)
		probe.Policies = policyCounts(&snap)
	}
	if d.centralNotifyEnabled() {
		if at, lastErr := d.centralNotifyHealth(); !at.IsZero() {
			probe.Enabled = true
			probe.LastAttempt = at.Format(time.RFC3339)
			probe.LastError = lastErr
		} else {
			probe.Enabled = true
		}
	}
	writeNotifyJSON(w, http.StatusOK, probe)
}

// ---------------------------------------------------------------------------
// GET /vh/admin/notify/tokens — masked list (the admin surface)
// ---------------------------------------------------------------------------

// handleNotifyAdminTokenList serves the masked registry for the management
// UI (the S1 GET /vh/notify/tokens list, kept working verbatim against the
// migrated store). The v4 public GET is the probe (above); this admin home
// is where S5 relocates PATCH/DELETE/test alongside it and points
// NotifyDialog at it. Read-only and CSRF-exempt (repo convention);
// unauthenticated requests get auth's clean 401 before the handler runs.
// 409 (not an empty 200) when no store is configured — an empty list would
// read as "zero devices registered", which is a lie.
func (d *Daemon) handleNotifyAdminTokenList(w http.ResponseWriter, r *http.Request) {
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
// rate limit (429 + Retry-After, notifyTestSendAllow) → send → 200
// {sent, transport, error?}. The rate-limit gate sits AFTER resolution
// on purpose: a malformed request or unknown id must keep its precise
// 400/404 and must NOT consume a rate-limit slot; only a send about to
// hit the provider does.
//
// The response reports PROVIDER ACCEPTANCE only ("sent: the transport
// accepted the message") — never device delivery; the error string is
// the sanitized transport error (typed classes surface their meaning,
// e.g. unregistered tokens, so the operator can diagnose a dead
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
	// Rate limit: one test send per interval across the whole controller
	// (single-operator). Refusals carry the standard Retry-After hint and
	// a short body naming the wait; they do not extend the window.
	if ok, wait := d.notifyTestSendAllow(); !ok {
		secs := int(math.Ceil(wait.Seconds()))
		w.Header().Set("Retry-After", strconv.Itoa(secs))
		http.Error(w, fmt.Sprintf("test-send rate limit: wait %ds before the next test send", secs), http.StatusTooManyRequests)
		return
	}
	sendErr := sender.Send(r.Context(), token, testNotifyMessage())
	// Best-effort telemetry on the by-id path — handed to the store's
	// ASYNC drain (a synchronous persist here would put a full-file write
	// on the request path; the response must not wait for it). Never
	// unwinds the send result; a persist failure is swallowed inside
	// recordSendResult exactly as before.
	for _, id := range storeIDs {
		d.notifyStore.recordSendResultAsync(id, sendErr)
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
