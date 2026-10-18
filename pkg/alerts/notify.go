package alerts

// notify.go — the FCM (Firebase Cloud Messaging) HTTP v1 sender channel for
// /vh/notify/* (Slice 2). Where Web Push reaches a BROWSER through its push
// service, this reaches a PHONE through FCM — data-only messages (no
// `notification` block; the device renders from the vh_* data fields) so the
// client app owns presentation.
//
// Auth is the Google OAuth2 service-account flow on the standard library
// only: an RS256-signed JWT (iss=client_email, aud=token_uri,
// scope=firebase.messaging) exchanged at the token endpoint for an access
// token, cached and refreshed ~5 min before expiry. Everything runs
// best-effort in per-token goroutines (the pusher fan-out pattern): a send
// failure never blocks or breaks the rest of alerts.
//
// Delivery policy is PER TOKEN (v3): a token registered with
// push_policy=always bypasses the attendance gate entirely (it still gets
// type-filtered and cooldown'd, mirroring the webhook channel_policy=always
// semantics); when_unattended tokens (the default, backward compatible) are
// suppressed while a device attends.
//
// Observability (v3): every send failure is logged (one line, channel=notify,
// classified reason, HTTP status, token identified as label-or-hash — never
// the token value), a periodic channel-health line reports window counters,
// and the probe exposes last_attempt/last_error. The failure-swallowing
// delivery POSTURE is unchanged: nothing here blocks or crashes the engine.
//
// Secrets discipline: the credentials file contents, the private key, the
// OAuth access token, and the device tokens are never logged and never
// appear in an error message — errors and log lines carry status codes,
// canonical error names, and paths only.

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

const (
	// fcmScope is the OAuth2 scope FCM HTTP v1 send requires.
	fcmScope = "https://www.googleapis.com/auth/firebase.messaging"
	// fcmDefaultBase is the FCM HTTP v1 API root (overridable for tests).
	fcmDefaultBase = "https://fcm.googleapis.com"
	// fcmDefaultTTL is the message TTL when notify.ttl_sec is unset (24h).
	fcmDefaultTTL = 86400
	// fcmTokenLeadTime is how long before expiry the cached OAuth token is
	// refreshed.
	fcmTokenLeadTime = 5 * time.Minute
	// fcmJWTLifetime is the service-account JWT validity (exp - iat).
	fcmJWTLifetime = time.Hour

	// vh_* data keys — the FCM data contract. All values are strings
	// (FCM data messages are string-only).
	notifyKindNotice = "notice"
)

// vh_condition values (the notify-channel condition vocabulary).
const (
	condPermissionPending = "permission_pending"
	condQuestionPending   = "question_pending"
	condSessionUnread     = "session_unread"
	condDegradedThinking  = "degraded_thinking"
	condDegradedRunaway   = "degraded_runaway"
	condDegradedStalled   = "degraded_stalled"
	condWorkerDown        = "worker_down"
	condSessionStarted    = "session_started" // v3: a root session started running
)

// serviceAccount is the subset of a Google service-account credentials file
// the sender needs.
type serviceAccount struct {
	ProjectID   string `json:"project_id"`
	PrivateKey  string `json:"private_key"` // PEM (PKCS#8, or PKCS#1)
	ClientEmail string `json:"client_email"`
	TokenURI    string `json:"token_uri"`
}

// Notifier is the FCM HTTP v1 sender. Delivery gating mirrors Web Push with
// one v3 change: attendance is evaluated PER TOKEN — an active-profile type
// filter applies channel-wide, but only when_unattended tokens are suppressed
// by attendance (always tokens proceed, still cooldown'd per (type, token)
// via the SAME cooldown_sec knob as Web Push, from a separate map keyed by
// type|tokenHash).
type Notifier struct {
	cfg      *Store
	presence *Presence
	tokens   *TokenRegistry // shared with the /vh/notify routes (enumerate + Prune)
	client   *http.Client
	now      func() time.Time
	logger   *slog.Logger // vhlog's shared logger by default; overridable in tests

	projectID string
	creds     serviceAccount
	signer    *rsa.PrivateKey
	ttl       int

	fcmBase string // API root; default fcmDefaultBase, overridden in tests

	mu   sync.Mutex
	cool map[string]time.Time // "type|tokenHash" -> last send

	tokMu  sync.Mutex
	tokVal string
	tokExp time.Time

	// statMu guards the observability surface: window counters for the
	// periodic health line plus the operator-checkable last_attempt /
	// last_error pair. The pair is published TOGETHER, under one lock hold,
	// only when an attempt COMPLETES — an in-flight attempt stays invisible
	// to the probe. Failures still never block delivery.
	statMu      sync.Mutex
	attempted   int64     // delivery units started since the last health line
	succeeded   int64     // delivered OK since the last health line
	failed      int64     // failed (any class) since the last health line
	pruned      int64     // pruned as UNREGISTERED since the last health line
	lastAttempt time.Time // start time of the most recent COMPLETED attempt (zero before any completes)
	lastErr     string    // sanitized outcome of that same completed attempt ("" when it succeeded)
}

// NewNotifier loads the service-account credentials named by the config's
// notify section and returns the sender. A nil error means the channel is
// live; an error means the channel must stay silently disabled (the caller
// does NOT attach the notifier, so NotifyReady stays false). Error values
// carry the path/status only — never file contents or key material.
func NewNotifier(cfg *Store, presence *Presence, tokens *TokenRegistry) (*Notifier, error) {
	if cfg == nil || presence == nil || tokens == nil {
		return nil, errors.New("notify: nil cfg, presence, or token registry")
	}
	c := cfg.Get()
	if !c.NotifyConfigured() {
		return nil, errors.New("notify: not configured")
	}
	creds, key, err := loadServiceAccount(c.Notify.CredentialsFile)
	if err != nil {
		return nil, err
	}
	project := c.Notify.ProjectID
	if project == "" {
		project = creds.ProjectID // fall back to the credentials file's project
	}
	if project == "" {
		return nil, errors.New("notify: no project_id (config or credentials file)")
	}
	ttl := c.Notify.TtlSec
	if ttl <= 0 {
		ttl = fcmDefaultTTL
	}
	return &Notifier{
		cfg:       cfg,
		presence:  presence,
		tokens:    tokens,
		client:    &http.Client{Timeout: 10 * time.Second},
		now:       time.Now,
		logger:    vhlog.Logger(), // the daemon's shared logger (single config, VH_DEBUG toggle)
		projectID: project,
		creds:     creds,
		signer:    key,
		ttl:       ttl,
		fcmBase:   fcmDefaultBase,
		cool:      map[string]time.Time{},
	}, nil
}

// loadServiceAccount reads and validates a service-account credentials file.
// The returned error names only the path and the failing step.
func loadServiceAccount(path string) (serviceAccount, *rsa.PrivateKey, error) {
	var creds serviceAccount
	raw, err := os.ReadFile(path)
	if err != nil {
		return creds, nil, fmt.Errorf("notify: read credentials %s: %w", path, err)
	}
	if err := json.Unmarshal(raw, &creds); err != nil {
		return creds, nil, fmt.Errorf("notify: parse credentials %s: not valid JSON", path)
	}
	if creds.ClientEmail == "" || creds.TokenURI == "" {
		return creds, nil, fmt.Errorf("notify: credentials %s: missing client_email or token_uri", path)
	}
	key, err := parseRSAPEM([]byte(creds.PrivateKey))
	if err != nil {
		return creds, nil, fmt.Errorf("notify: credentials %s: unusable private_key", path)
	}
	return creds, key, nil
}

// parseRSAPEM decodes a PEM-encoded RSA private key (PKCS#8 or PKCS#1 —
// Google service-account files are PKCS#8).
func parseRSAPEM(pemBytes []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("no PEM block")
	}
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if rsaKey, ok := key.(*rsa.PrivateKey); ok {
			return rsaKey, nil
		}
		return nil, errors.New("PKCS#8 key is not RSA")
	}
	return x509.ParsePKCS1PrivateKey(block.Bytes)
}

// --- OAuth2 service-account token (stdlib only) ---

// assertion builds the signed RS256 JWT for the token exchange.
func (n *Notifier) assertion(iat time.Time) (string, error) {
	header := b64url([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, err := json.Marshal(struct {
		Iss   string `json:"iss"`
		Scope string `json:"scope"`
		Aud   string `json:"aud"`
		Iat   int64  `json:"iat"`
		Exp   int64  `json:"exp"`
	}{
		Iss:   n.creds.ClientEmail,
		Scope: fcmScope,
		Aud:   n.creds.TokenURI,
		Iat:   iat.Unix(),
		Exp:   iat.Add(fcmJWTLifetime).Unix(),
	})
	if err != nil {
		return "", err
	}
	input := header + "." + b64url(claims)
	digest := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, n.signer, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return input + "." + b64url(sig), nil
}

// accessToken returns a cached access token, exchanging a fresh JWT when the
// cache is empty or within fcmTokenLeadTime of expiry. force discards the
// cache first (the 401 recovery path: refresh once, then treat as failure).
func (n *Notifier) accessToken(force bool) (string, error) {
	n.tokMu.Lock()
	defer n.tokMu.Unlock()
	now := n.now()
	if force {
		n.tokVal, n.tokExp = "", time.Time{}
	}
	if n.tokVal != "" && now.Add(fcmTokenLeadTime).Before(n.tokExp) {
		return n.tokVal, nil
	}
	assert, err := n.assertion(now)
	if err != nil {
		return "", err
	}
	form := url.Values{
		"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
		"assertion":  {assert},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.creds.TokenURI,
		strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := n.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("notify: token exchange: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("notify: token exchange status %d", resp.StatusCode)
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out); err != nil {
		return "", fmt.Errorf("notify: token exchange response: %w", err)
	}
	if out.AccessToken == "" {
		return "", errors.New("notify: token exchange returned no access_token")
	}
	if out.ExpiresIn <= 0 {
		out.ExpiresIn = 3600
	}
	n.tokVal = out.AccessToken
	n.tokExp = now.Add(time.Duration(out.ExpiresIn) * time.Second)
	return n.tokVal, nil
}

// --- message construction ---

// fcmAndroidConfig is the message.android block (delivery posture).
type fcmAndroidConfig struct {
	Priority    string `json:"priority"`               // HIGH | NORMAL
	CollapseKey string `json:"collapse_key,omitempty"` // vh_event value
	TTL         string `json:"ttl,omitempty"`          // protobuf Duration, e.g. "86400s"
}

// fcmMessage is the FCM HTTP v1 message. Data-only: no `notification` block —
// the device renders from the vh_* data fields.
type fcmMessage struct {
	Token   string            `json:"token"`
	Data    map[string]string `json:"data"`
	Android *fcmAndroidConfig `json:"android,omitempty"`
}

// notifyCondition maps a Notice onto the notify channel's condition
// vocabulary. A daemon-level stalled notice (empty sessionID/root, title
// "OpenCode" — the EmitDaemonNotice shape) means the worker itself died:
// worker_down, not a stalled session.
func notifyCondition(n Notice) string {
	switch n.Type {
	case TypeWaiting:
		if n.Kind == KindQuestion {
			return condQuestionPending
		}
		return condPermissionPending
	case TypeFinished:
		return condSessionUnread
	case TypeStuckThinking:
		return condDegradedThinking
	case TypeRunaway:
		return condDegradedRunaway
	case TypeSessionStarted:
		// v3 change 3: a root session started running. Identity mapping
		// (vh_event == vh_condition); NORMAL priority (only waiting is HIGH).
		return condSessionStarted
	case TypeStalled:
		if n.SessionID == "" && n.Root == "" && n.Title == "OpenCode" {
			return condWorkerDown
		}
		return condDegradedStalled
	default:
		return n.Type // unknown/future types pass through verbatim
	}
}

// buildMessage renders the data-only FCM message for one token. All data
// values are strings (FCM requirement). `waiting` goes out HIGH priority —
// load-bearing: normal-priority FCM is deferred by Android Doze.
func (n *Notifier) buildMessage(notice Notice, token string) fcmMessage {
	priority := "NORMAL"
	if notice.Type == TypeWaiting {
		priority = "HIGH"
	}
	return fcmMessage{
		Token: token,
		Data: map[string]string{
			"vh_kind":      notifyKindNotice,
			"vh_event":     notice.Type,
			"vh_condition": notifyCondition(notice),
			"vh_count":     "1", // fixed in v1 (no aggregation yet)
			"vh_ts":        strconv.FormatInt(notice.Ts, 10),
		},
		Android: &fcmAndroidConfig{
			Priority:    priority,
			CollapseKey: notice.Type,
			TTL:         strconv.Itoa(n.ttl) + "s",
		},
	}
}

// --- gating + fan-out (mirrors Pusher.Send) ---

// Send delivers a notice to every eligible registered token. Gate order:
// the channel must still be configured, the active profile must want the
// type, then attendance is applied PER TOKEN — a when_unattended token (the
// default) is suppressed while a device attends (FCM is the away path), an
// always token proceeds regardless (mirroring the webhook channel_policy
// semantics: attendance-exempt, still type-filtered and cooldown'd). Each
// (type, token) must be past its cooldown — the SAME cooldown_sec knob as
// Web Push, from a separate map keyed type|tokenHash, applying to BOTH
// policies. Non-blocking.
func (n *Notifier) Send(notice Notice) {
	cfg := n.cfg.Get()
	if !cfg.NotifyConfigured() {
		return // channel disabled at runtime (config edit dropped the section)
	}
	prof := cfg.ActiveProfile()
	if !prof.wantsType(notice.Type) {
		return
	}
	attended := n.presence.Attended(time.Duration(cfg.Detect.IdleSec) * time.Second)
	cooldown := time.Duration(cfg.Detect.CooldownSec) * time.Second
	for _, tok := range n.tokens.List() {
		if attended && normalizePushPolicy(tok.PushPolicy) != PolicyAlways {
			continue // someone's here and this token only pushes when unattended
		}
		if n.onCooldown(notice.Type, tok.Token, cooldown) {
			continue
		}
		go n.deliver(tok, n.buildMessage(notice, tok.Token))
	}
}

// onCooldown reports whether this (type, token) sent within the window; if
// not, it records "now" and returns false (allow). The token enters the key
// hashed — cooldown state must never retain more token material than needed.
func (n *Notifier) onCooldown(typ, token string, window time.Duration) bool {
	if window <= 0 {
		return false
	}
	sum := sha256.Sum256([]byte(token))
	key := typ + "|" + hex.EncodeToString(sum[:16])
	n.mu.Lock()
	defer n.mu.Unlock()
	now := n.now()
	if last, ok := n.cool[key]; ok && now.Sub(last) < window {
		return true
	}
	n.cool[key] = now
	return false
}

// tokenRef renders a token for log lines: the LABEL when present, else the
// same sha256 hash prefix the cooldown map keys on (sum[:16] bytes, hex).
// The token VALUE never enters a log line or error string.
func tokenRef(tok NotifyToken) string {
	if tok.Label != "" {
		return tok.Label
	}
	sum := sha256.Sum256([]byte(tok.Token))
	return hex.EncodeToString(sum[:16])
}

// sendFailure classifies one failed delivery for the log line, the window
// counters, and the probe's sanitized last_error. reason is a short
// classified phrase; status is the HTTP status when the failure came from a
// response (0 otherwise); canonical is FCM's google error.status name when
// the body carried one (e.g. NOT_FOUND, UNREGISTERED); err optionally
// carries the underlying transport error (which never contains token or key
// material — only URLs, timeouts, and status lines).
type sendFailure struct {
	reason    string
	status    int
	canonical string
	err       error
	pruned    bool // the UNREGISTERED prune path (counted separately, still logged)
}

// summary renders the sanitized operator-facing error string for the probe:
// "404 NOT_FOUND" when a status and canonical name exist, "429 rate limited
// (quota)" when only a status does, or the bare reason (no status), e.g.
// "oauth exchange failed".
func (f *sendFailure) summary() string {
	switch {
	case f.status > 0 && f.canonical != "":
		return strconv.Itoa(f.status) + " " + f.canonical
	case f.status > 0:
		return strconv.Itoa(f.status) + " " + f.reason
	default:
		return f.reason
	}
}

// deliver sends one message, best-effort — the pusher posture is unchanged:
// a failure never blocks or breaks anything, but it is now OBSERVED (one log
// line per failure, window counters, last_attempt/last_error). A 401 forces
// ONE token refresh + retry; a 5xx gets ONE cheap retry; there is no queue
// and no backoff loop.
func (n *Notifier) deliver(tok NotifyToken, msg fcmMessage) {
	started := n.now() // this attempt's start time, published with its own outcome below

	n.statMu.Lock()
	n.attempted++
	n.statMu.Unlock()

	f := n.send(tok.Token, msg, 0, false)

	// Publish last_attempt and last_error TOGETHER, only at attempt
	// COMPLETION: the pair always describes ONE whole attempt — its start
	// time plus its own outcome (a success clears the error). Until then
	// the probe shows the untouched zero state, and overlapping attempts
	// can never pair one attempt's timestamp with another's outcome.
	n.statMu.Lock()
	n.lastAttempt = started
	switch {
	case f == nil:
		n.succeeded++
		n.lastErr = "" // the completed attempt succeeded — current channel health is OK
	case f.pruned:
		n.pruned++
		n.lastErr = f.summary()
	default:
		n.failed++
		n.lastErr = f.summary()
	}
	n.statMu.Unlock()

	if f != nil {
		n.logFailure(tok, f)
	}
}

// logFailure emits the one-line-per-failure record. channel=notify, the
// classified reason, the HTTP status where applicable, and the token as
// label-or-hash — never the value, credentials material, or response bodies.
func (n *Notifier) logFailure(tok NotifyToken, f *sendFailure) {
	attrs := []any{"channel", "notify", "token", tokenRef(tok), "reason", f.reason}
	if f.status > 0 {
		attrs = append(attrs, "status", f.status)
	}
	if f.canonical != "" {
		attrs = append(attrs, "code", f.canonical)
	}
	if f.err != nil {
		attrs = append(attrs, "err", f.err.Error())
	}
	if f.pruned {
		n.logger.Warn("notify: token unregistered, pruned", attrs...)
		return
	}
	n.logger.Warn("notify: fcm send failed", attrs...)
}

// send posts the message, applying the retry/prune policy. attempt counts
// posts so far (0 = first); refreshed marks that the OAuth token was already
// force-refreshed for this message (a second 401 is a failure). It returns
// nil on success or a classified *sendFailure.
func (n *Notifier) send(token string, msg fcmMessage, attempt int, refreshed bool) *sendFailure {
	access, err := n.accessToken(refreshed)
	if err != nil {
		return &sendFailure{reason: "oauth exchange failed", err: err}
	}
	body, err := json.Marshal(struct {
		Message fcmMessage `json:"message"`
	}{msg})
	if err != nil {
		return &sendFailure{reason: "marshal message failed", err: err}
	}
	endpoint := n.fcmBase + "/v1/projects/" + url.PathEscape(n.projectID) + "/messages:send"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return &sendFailure{reason: "request build failed", err: err}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("User-Agent", "vh-solara-notify/1")
	resp, err := n.client.Do(req)
	if err != nil {
		return &sendFailure{reason: "transport error", err: err}
	}
	defer resp.Body.Close()

	// 401 → the cached OAuth token went stale: force-refresh once and retry.
	if resp.StatusCode == http.StatusUnauthorized && !refreshed {
		return n.send(token, msg, attempt+1, true)
	}
	// 5xx → one cheap retry, then give up.
	if resp.StatusCode >= 500 && attempt < 1 {
		return n.send(token, msg, attempt+1, refreshed)
	}
	// Terminal non-2xx: read (bounded) body once for the canonical error
	// name and the UNREGISTERED inspection. Only parsed fields are used —
	// the raw body is never surfaced.
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	canonical := fcmErrorStatus(raw)

	// Token gone: 400 or 404 carrying error detail UNREGISTERED → prune.
	// A generic 404 NOT_FOUND (FCM's answer to sender-side misconfiguration,
	// e.g. a wrong/deleted project ID) carries no UNREGISTERED evidence and
	// must leave registrations intact — pruning on it would mass-erase every
	// valid token. Both statuses share the same body-inspection rule.
	if resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusNotFound {
		if fcmIsUnregistered(raw) {
			// The operator-facing canonical name for the prune decision is
			// the UNREGISTERED evidence itself (the body's top-level status
			// is a generic NOT_FOUND/INVALID_ARGUMENT).
			if perr := n.tokens.Prune(token); perr != nil {
				return &sendFailure{reason: "token unregistered but prune failed", status: resp.StatusCode, canonical: "UNREGISTERED", err: perr}
			}
			return &sendFailure{reason: "token unregistered (pruned)", status: resp.StatusCode, canonical: "UNREGISTERED", pruned: true}
		}
		return &sendFailure{reason: "fcm rejected message", status: resp.StatusCode, canonical: canonical}
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return &sendFailure{reason: "rate limited (quota)", status: resp.StatusCode, canonical: canonical}
	}
	if resp.StatusCode >= 300 {
		if resp.StatusCode == http.StatusUnauthorized {
			return &sendFailure{reason: "unauthenticated after refresh", status: resp.StatusCode, canonical: canonical}
		}
		if resp.StatusCode >= 500 {
			return &sendFailure{reason: "fcm 5xx retry exhausted", status: resp.StatusCode, canonical: canonical}
		}
		return &sendFailure{reason: "fcm error", status: resp.StatusCode, canonical: canonical}
	}
	return nil
}

// fcmErrorBody is the subset of an FCM v1 error response the prune policy
// needs.
type fcmErrorBody struct {
	Error struct {
		Code    int    `json:"code"`
		Status  string `json:"status"`
		Details []struct {
			Type      string `json:"@type"`
			ErrorCode string `json:"errorCode"`
		} `json:"details"`
	} `json:"error"`
}

// fcmIsUnregistered reports whether an FCM error body carries the
// UNREGISTERED error code (the device token is no longer valid). Two shapes
// count: a details[].errorCode entry (the FcmError detail) or a top-level
// error.status of UNREGISTERED with no details array — FCM answers dead
// tokens both ways, and pruning on either keeps the registry from retaining
// dead tokens forever.
func fcmIsUnregistered(body []byte) bool {
	var e fcmErrorBody
	if json.Unmarshal(body, &e) != nil {
		return false
	}
	if e.Error.Status == "UNREGISTERED" {
		return true
	}
	for _, d := range e.Error.Details {
		if d.ErrorCode == "UNREGISTERED" {
			return true
		}
	}
	return false
}

// fcmErrorStatus extracts FCM's google canonical error.status name (e.g.
// NOT_FOUND, UNREGISTERED, RESOURCE_EXHAUSTED) for the sanitized last_error
// surface. Only the parsed name is used — the raw body never surfaces.
func fcmErrorStatus(body []byte) string {
	var e fcmErrorBody
	if json.Unmarshal(body, &e) != nil {
		return ""
	}
	return e.Error.Status
}

// --- observability surface (v3) ---

// notifyHealthInterval is the default period of the channel-health log line.
const notifyHealthInterval = 10 * time.Minute

// SetLogger swaps the failure/health log target. Production keeps the
// daemon's shared vhlog logger; cross-package tests (pkg/web route tests)
// use a discard or buffered handler so failure-path coverage never writes
// real Warn lines into the test run's stderr. Call before the first Send —
// the per-token delivery goroutines read the field without a lock.
func (n *Notifier) SetLogger(l *slog.Logger) {
	if l != nil {
		n.logger = l
	}
}

// Health returns the operator-checkable channel state: the start time of the
// most recent COMPLETED FCM send attempt and that same attempt's sanitized
// outcome (empty when it succeeded). Both stay zero values until some
// attempt has completed — an in-flight attempt is invisible. Safe for
// concurrent use; never carries token material.
func (n *Notifier) Health() (time.Time, string) {
	n.statMu.Lock()
	defer n.statMu.Unlock()
	return n.lastAttempt, n.lastErr
}

// StartHealthLoop launches the periodic channel-health line: enabled, token
// counts by policy, and attempted/succeeded/failed/pruned counters since the
// previous line (window counters reset on each line). interval <= 0 means
// the daemon default (notifyHealthInterval). Returns immediately; the loop
// exits when ctx is cancelled (daemon teardown).
func (n *Notifier) StartHealthLoop(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = notifyHealthInterval
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				n.logHealth()
			}
		}
	}()
}

// logHealth snapshots-and-resets the window counters and emits the health
// line. The counters are maintained under statMu by deliver(); this reader
// takes the same lock, so no new races.
func (n *Notifier) logHealth() {
	n.statMu.Lock()
	attempted, succeeded, failed, pruned := n.attempted, n.succeeded, n.failed, n.pruned
	n.attempted, n.succeeded, n.failed, n.pruned = 0, 0, 0, 0
	n.statMu.Unlock()
	counts := n.tokens.PolicyCounts()
	n.logger.Info("notify: channel health",
		"channel", "notify",
		"enabled", n.cfg.Get().NotifyConfigured(),
		"tokens_when_unattended", counts[PolicyWhenUnattended],
		"tokens_always", counts[PolicyAlways],
		"attempted", attempted,
		"succeeded", succeeded,
		"failed", failed,
		"pruned", pruned)
}
