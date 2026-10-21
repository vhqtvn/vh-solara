package tunnel

import (
	"fmt"
	"strings"
)

// Tunnel message types
const (
	TypeRegister       = "register"
	TypeHeartbeat      = "heartbeat"
	TypeError          = "error"
	TypeKillInstance   = "kill_instance"
	TypeFatalDuplicate = "fatal_duplicate"

	// Raw proxy — bidirectional byte stream to a local port (for WebSocket upgrades, HTTP, SSE, etc.)
	TypeRawProxy = "raw_proxy"
)

// Private notify-surface wire paths (notify controller-hub S2 / v4 §3.1).
// They live in the wire-contract package because BOTH sides build them:
// the worker serves them (pkg/web notify_internal.go) and the controller's
// bounded internal fetch requests them (pkg/server). They are PRIVATE
// routes — authorization is the enrollment-carried bearer token, never the
// prefix itself.
const (
	InternalNotifyFeedPath = "/vh/internal/notify/feed"
	InternalNotifyAckPath  = "/vh/internal/notify/ack"
)

// BaseMessage represents the common envelope for all tunnel frames.
type BaseMessage struct {
	Type      string `json:"type"`
	RequestID string `json:"request_id,omitempty"`
	WorkerID  string `json:"worker_id,omitempty"`
}

// RegisterMessage is sent by the worker to register with the controller.
type RegisterMessage struct {
	BaseMessage
	WorkerName string `json:"worker_name"`
	Version    string `json:"version"`

	// Notify is the additive notify capability enrollment (notify
	// controller-hub S2 / v4 §2 step 2). nil/absent = a pre-S2 worker with
	// no durable notify source — the controller marks it notify-ineligible
	// (the §9.7 mixed-version row), everything else about registration is
	// unchanged. The block rides EVERY registration (each tunnel
	// reconnect), so the controller's source registry stays current.
	Notify *NotifyEnrollment `json:"notify,omitempty"`
}

// NotifyEnrollment is the notify capability advertisement a capable worker
// attaches to its tunnel registration. It carries the durable source
// identity ({source_id, epoch} — v4 §9.2; the worker starts every epoch at
// seq 0, so no seq rides enrollment) plus the ownership-handshake START
// (brief §2 "Ownership and cutover"): the worker's CURRENT watermark/
// ownership state at connect time — {mode, fenced, H} — so the controller
// can reconcile ownership without a separate first round trip. Full H
// transfer semantics land in S3/S4; S2 proves the fields flow and persist.
type NotifyEnrollment struct {
	// SourceID is the worker's stable source identity. In the
	// one-source-per-worker v4 design it EQUALS the registering WorkerID;
	// the controller enforces the equality (a mismatched enrollment is
	// rejected, never recorded).
	SourceID string `json:"source_id"`
	// Epoch is the durable source spool's CURRENT epoch (stable across
	// ordinary restarts; rotates only on genuine source-state replacement).
	Epoch string `json:"epoch"`
	// NotifyCap is the notify capability VERSION (1 = private feed +
	// watermark ACK). 0/negative = malformed → rejected.
	NotifyCap int `json:"notify_cap"`
	// Mode is the worker's persisted notify ownership mode
	// (alerts.OwnershipModeController|Standalone; "" when the state file
	// was unreadable — reported honestly, never guessed).
	Mode string `json:"mode"`
	// Fenced reports whether local FCM is fenced on this worker (v4 (j)).
	Fenced bool `json:"fenced"`
	// Watermark is the durable ownership watermark H (null until the
	// S3/S4 transfer protocol populates it).
	Watermark *int64 `json:"watermark"`
	// Token is the worker's per-process bearer credential for the private
	// feed/ACK surface (/vh/internal/notify/*). Minted fresh at every
	// worker start (crypto/rand), shared ONLY with the controller through
	// this tunnel-carried registration, and never exposed on any public
	// surface — a browser proxied through the worker-subdomain path cannot
	// know it, which is exactly what makes the private prefix private
	// ("a private-looking prefix is not authorization"; brief §2 route
	// ownership). Constrained by Validate to header-safe characters and a
	// bounded length: the controller interpolates it into an Authorization
	// header on its internal fetches, so a hostile worker must not be able
	// to smuggle CR/LF through the registry.
	Token string `json:"token"`
}

// Validate checks the enrollment block's structural floor. A nil-returning
// enrollment is recordable; anything else is rejected by the controller
// (the worker still registers — a malformed capability must not take the
// tunnel down, it only fails to enroll).
func (n *NotifyEnrollment) Validate() error {
	if n == nil {
		return fmt.Errorf("nil enrollment")
	}
	if n.SourceID == "" {
		return fmt.Errorf("empty source_id")
	}
	if n.Epoch == "" {
		return fmt.Errorf("empty epoch")
	}
	if n.NotifyCap < 1 {
		return fmt.Errorf("notify_cap %d < 1", n.NotifyCap)
	}
	if n.Token == "" {
		return fmt.Errorf("empty token")
	}
	// Header-safety floor: the controller builds "Authorization: Bearer
	// <token>" request lines from this value, so restrict it to
	// non-whitespace, non-control, quote-free characters with a bounded
	// length BEFORE it ever reaches the registry. This is a floor, not a
	// format: the worker mints hex (NewInternalNotifyToken), but the wire
	// type must not trust that.
	if len(n.Token) < 16 || len(n.Token) > 128 {
		return fmt.Errorf("token length %d outside [16,128]", len(n.Token))
	}
	for _, c := range n.Token {
		if !tokenSafe(c) {
			return fmt.Errorf("token carries header-unsafe characters")
		}
	}
	// Mode is the persisted ownership mode (alerts.OwnershipController |
	// alerts.OwnershipStandalone, "" when the worker's state file was
	// unreadable — reported honestly). tunnel does not import alerts; the
	// literal vocabulary is pinned here and cross-checked by tests.
	switch n.Mode {
	case "", "controller", "standalone":
	default:
		return fmt.Errorf("mode %q not in {|\"\", controller, standalone}", n.Mode)
	}
	return nil
}

// tokenSafe reports whether c is safe to embed in a single-line HTTP header
// value: visible ASCII minus the header/quote separators.
func tokenSafe(c rune) bool {
	if c <= ' ' || c >= 0x7f {
		return false
	}
	return !strings.ContainsRune(`"(),/:;<=>?@[\]{}`, c)
}

// HeartbeatMessage is sent periodically by the worker.
type HeartbeatMessage struct {
	BaseMessage
	Timestamp string `json:"timestamp"`
}

// ErrorMessage indicates an error in proxying.
type ErrorMessage struct {
	BaseMessage
	Code    string `json:"code"`
	Message string `json:"message"`
}

// RawProxyMessage requests raw bidirectional proxying to a local port (for WebSocket upgrades).
type RawProxyMessage struct {
	BaseMessage
	Port int `json:"port"`
}
