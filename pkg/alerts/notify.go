package alerts

// notify.go — the FCM (Firebase Cloud Messaging) HTTP v1 sender channel for
// the WORKER's standalone /vh/notify/* surface (Slice 2; unchanged v3
// behavior). Where Web Push reaches a BROWSER through its push service, this
// reaches a PHONE through FCM — data-only messages (no `notification`
// block; the device renders from the vh_* data fields) so the client app
// owns presentation.
//
// Since notify controller-hub S4 the TRANSPORT core — OAuth2
// service-account flow, send policy (401 refresh-once / one cheap 5xx
// retry), UNREGISTERED evidence classification, and the attempt-lifecycle
// observability surface — is shared with the controller's central
// dispatcher via fcm_transport.go (FCMTransport, the narrowly-shared seam;
// see that file). This file keeps the WORKER's delivery POLICY: the
// profile type filter, PER-TOKEN attendance gating, and the per-(type,
// token) cooldown from the SAME cooldown_sec knob as Web Push.
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
	"context"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"
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
//
// The embedded fcmTransport (by value — fcm_transport.go) carries the
// SHARED transport core: the OAuth flow, the send policy, UNREGISTERED
// classification, and the health surface. Field promotion keeps the
// historical in-package access shape (nt.fcmBase / nt.now / nt.logger /
// nt.statMu …) compiling unchanged.
type Notifier struct {
	FCMTransport
	cfg      *Store
	presence *Presence
	tokens   *TokenRegistry // shared with the /vh/notify routes (enumerate + Prune)

	mu   sync.Mutex
	cool map[string]time.Time // "type|tokenHash" -> last send
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
		FCMTransport: *newFCMTransport(creds, key, project, ttl),
		cfg:          cfg,
		presence:     presence,
		tokens:       tokens,
		cool:         map[string]time.Time{},
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

// ConditionOf is the exported view of the §9.1 notice-type → condition
// mapping, for surfaces that render history records (the v4 public history
// DTO's `kind` field). It is a pure function over the notice fields the ring
// and spool records carry; a ring-only legacy waiting record (no Kind — the
// distinction was push-only before v4) maps to permission_pending, the
// documented default.
func ConditionOf(n Notice) string { return notifyCondition(n) }

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

// deliver sends one message, best-effort — the pusher posture is unchanged:
// a failure never blocks or breaks anything, but it is OBSERVED (one log
// line per failure, window counters, last_attempt/last_error). Since S4 the
// whole attempt lifecycle — including the 401-refresh/5xx-retry send policy
// and the worker registry's prune on canonical UNREGISTERED evidence — runs
// in the shared FCMTransport.Deliver (fcm_transport.go); this wrapper only
// supplies the worker's prune action.
func (n *Notifier) deliver(tok NotifyToken, msg fcmMessage) {
	android := &AndroidConfig{TTLSeconds: n.ttl}
	if msg.Android != nil {
		android.Priority = msg.Android.Priority
		android.CollapseKey = msg.Android.CollapseKey
	}
	_ = n.FCMTransport.Deliver(tok.Token, tok.Label, msg.Data, android, func() error {
		return n.tokens.Prune(tok.Token)
	})
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

// --- observability surface (v3; the surface lives on the shared core) ---

// StartHealthLoop is the worker's wrapper over the shared core's health
// loop (fcm_transport.go), supplying the worker's own enabled state (the
// alerts config's notify section) and policy counts (the worker token
// registry). interval <= 0 means the daemon default (notifyHealthInterval).
// Returns immediately; the loop exits when ctx is cancelled (daemon
// teardown). SetLogger and Health are the promoted core methods, unchanged.
func (n *Notifier) StartHealthLoop(ctx context.Context, interval time.Duration) {
	n.FCMTransport.StartHealthLoop(ctx, interval,
		func() bool { return n.cfg.Get().NotifyConfigured() },
		n.tokens.PolicyCounts)
}
