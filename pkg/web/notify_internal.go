package web

// notify_internal.go — the PRIVATE controller↔worker notify surface (notify
// controller-hub S2 / v4 §3.1 "/vh/internal/notify/feed"):
//
//	GET  /vh/internal/notify/feed?since_seq=<n>&limit=<n>   — spool pages
//	POST /vh/internal/notify/ack  {"watermark": <n>}        — durable-commit ACK
//
// Route ownership (v4 §3 route table + brief §2 "Registration and public
// route ownership"): these routes are controller-only over the yamux tunnel.
// They mount on the worker's ONE web port (there is no second listener in
// this architecture — the agent's raw proxy always targets that port), so
// the AUTHORIZATION that makes them private is the per-process bearer token
// minted at daemon start (NewInternalNotifyToken) and shared with the
// controller ONLY through the tunnel-carried registration block
// (tunnel.NotifyEnrollment.Token). A browser reaching the same paths through
// the worker-subdomain proxy, the generic proxy, or direct loopback access
// has no token and receives a plain 404 — no feed data, no route
// confirmation ("a private-looking prefix is not authorization" holds
// because the credential, not the prefix, opens the surface).
//
// The token check rides BEFORE session auth's exemption matters: pkg/auth
// exempts /vh/internal/notify/ from the browser session gate (the
// controller's fetch carries no cookie) and pkg/web's csrfGuard exempts it
// from X-VH-CSRF (a non-browser bearer client; a cross-site page cannot set
// an Authorization header with a secret it does not know). The handler's
// constant-time bearer check IS the authentication for this surface.
//
// Timestamps stay NUMERIC int64 here (v4 Position C): only the PUBLIC
// history DTO stringifies ts at its boundary.

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/alerts"
	"github.com/vhqtvn/vh-solara/pkg/tunnel"
)

const (
	internalNotifyFeedPath = tunnel.InternalNotifyFeedPath
	internalNotifyAckPath  = tunnel.InternalNotifyAckPath

	// internalFeedDefaultLimit / internalFeedMaxLimit bound one feed page
	// (documented S2 choice; v4 §2 step 3 "bounded page/byte work per
	// round"). Default 200 mirrors the public history default; the max is
	// 500 — larger than the public 200 because the feed records are leaner
	// (no DTO inflation) and the controller pages in a tight loop.
	internalFeedDefaultLimit = 200
	internalFeedMaxLimit     = 500
)

// NewInternalNotifyToken mints the per-process bearer credential for the
// private notify surface: 32 crypto/rand bytes, hex-encoded (64 chars —
// inside tunnel.NotifyEnrollment.Validate's header-safe window by
// construction). Fresh at every daemon start: a restarted worker
// re-registers with a new token, so an old token has no value after a
// restart even if it leaked.
func NewInternalNotifyToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failure: time-derived uniqueness, never a shared
		// constant (the same posture as the spool's newSourceEpoch) — and
		// still inside Validate's length/charset window.
		return fmt.Sprintf("tok-%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// internalNotifyFeature mounts the private feed/ACK routes. Registered only
// by EnableInternalNotify (daemon + enrolled test harnesses); the zero
// value serves nothing.
type internalNotifyFeature struct {
	engine         *alerts.Engine
	token          string
	stateDir       string
	controllerMode bool
}

func (internalNotifyFeature) Name() string { return "notify-internal" }

func (f internalNotifyFeature) Routes(svc Services) map[string]http.HandlerFunc {
	return map[string]http.HandlerFunc{
		internalNotifyFeedPath: f.serveFeed,
		internalNotifyAckPath:  f.serveAck,
	}
}

// denyInternal answers a request with a plain 404: no JSON envelope, no
// route confirmation, no feed data — used for missing AND wrong tokens
// alike. (An UNMOUNTED path on this server would fall through to the SPA
// catch-all 200 shell; the 404 here is deliberately stricter and leaks
// less — the private surface answers nothing but the token holder.)
func denyInternal(w http.ResponseWriter) {
	http.Error(w, "404 page not found", http.StatusNotFound)
}

// authorized enforces the bearer token in constant time. The token is the
// worker's per-process secret shared only with the controller.
func (f internalNotifyFeature) authorized(r *http.Request) bool {
	const pfx = "Bearer "
	got := r.Header.Get("Authorization")
	if len(got) <= len(pfx) || got[:len(pfx)] != pfx {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got[len(pfx):]), []byte(f.token)) == 1
}

// feedSourceMeta is the per-response source metadata block: identity,
// retention/eviction accounting, and durability state — everything the
// controller needs to compute coverage/gaps per v4 §9 without another
// round trip (records carry only their own seq; the epoch lives HERE).
type feedSourceMeta struct {
	SourceID         string `json:"source_id"`
	Epoch            string `json:"epoch"`
	PrevEpoch        string `json:"prevEpoch,omitempty"`
	RotatedAt        int64  `json:"rotatedAt,omitempty"`
	FirstSeq         int64  `json:"firstSeq"`
	LastSeq          int64  `json:"lastSeq"`
	DurableSeq       int64  `json:"durableSeq"`
	Overflow         int64  `json:"overflow"`
	AckedSeq         int64  `json:"ackedSeq"`
	AckedTrim        int64  `json:"ackedTrim"`
	LastPersistError string `json:"lastPersistError,omitempty"`
}

// feedPageResp is the GET /vh/internal/notify/feed response. nextSince is
// the cursor the controller should send as since_seq next: the last
// returned record's seq, or max(since_seq, durableSeq) when the page is
// empty (caught up) so a later pull after new durable appends resumes
// exactly past what it has seen.
type feedPageResp struct {
	Source    feedSourceMeta        `json:"source"`
	Records   []alerts.SourceRecord `json:"records"`
	NextSince int64                 `json:"nextSince"`
}

func (f internalNotifyFeature) sourceMeta(m alerts.SourceMeta) feedSourceMeta {
	return feedSourceMeta{
		SourceID:         m.SourceID,
		Epoch:            m.Epoch,
		PrevEpoch:        m.PrevEpoch,
		RotatedAt:        m.RotatedAt,
		FirstSeq:         m.FirstSeq,
		LastSeq:          m.LastSeq,
		DurableSeq:       m.DurableSeq,
		Overflow:         m.Overflow,
		AckedSeq:         m.AckedSeq,
		AckedTrim:        m.AckedTrim,
		LastPersistError: m.LastPersistError,
	}
}

// serveFeed serves one DURABLE-BOUNDED, ascending, page-forward page of the
// spool (S2 / v4 §2 step 3):
//
//	since_seq  absent/0 → from the oldest retained record (full replay
//	           posture; overflow/evicted prefixes are nameable via the
//	           metadata block); n > 0 → records with seq > n only.
//	limit      absent/0 → 200; > 500 clamped to 500 (not an error — the
//	           public history clamp posture); negative or non-numeric → 400.
//	negative or non-numeric since_seq → 400.
//
// Reads never touch the undurable tail: the snapshot stops at the durable
// head (made structural in the spool, S2), so a persistence-failed append is
// never fed even though it is visible in LastPersistError/metadata.
func (f internalNotifyFeature) serveFeed(w http.ResponseWriter, r *http.Request) {
	if !f.authorized(r) {
		denyInternal(w)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	spool := f.spool()
	if spool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errResp("notify source unavailable"))
		return
	}
	q := r.URL.Query()
	since := int64(0)
	if s := q.Get("since_seq"); s != "" {
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil || v < 0 {
			writeJSON(w, http.StatusBadRequest, errResp("bad since"))
			return
		}
		since = v
	}
	limit := internalFeedDefaultLimit
	if s := q.Get("limit"); s != "" {
		v, err := strconv.Atoi(s)
		if err != nil || v < 0 {
			writeJSON(w, http.StatusBadRequest, errResp("bad limit"))
			return
		}
		if v > 0 {
			limit = v
		}
	}
	if limit > internalFeedMaxLimit {
		limit = internalFeedMaxLimit
	}
	// B1 (empty-page cursor race): ONE snapshot under ONE spool lock — the
	// response (records, metadata, cursor) is assembled ENTIRELY from it,
	// with no post-hoc spool getter calls. The old composition (FeedPage,
	// then DurableSeq as a separate critical section) could interleave with
	// a concurrent Append and return records=[] + nextSince=N+1, permanently
	// skipping record N+1. The snapshot's own durable head bounds the
	// empty-page cursor, so an empty page always parks at a head the EMPTY
	// PAGE was actually taken at.
	snap := spool.FeedSnapshot(since, limit)
	records := snap.Records
	if records == nil {
		records = []alerts.SourceRecord{} // serialize as [], never null
	}
	writeJSON(w, http.StatusOK, jsonBytes(feedPageResp{
		Source:    f.sourceMeta(snap.Meta),
		Records:   records,
		NextSince: snap.NextSince,
	}))
}

// ackRequestBody is the POST /vh/internal/notify/ack body: the controller's
// durable watermark (central commit succeeded through this seq).
type ackRequestBody struct {
	Watermark int64 `json:"watermark"`
}

// serveAck records the controller's durable-commit watermark and trims the
// confirmed-consumed prefix (S2 / v4 §2 step 4 — "worker retention
// reclamation must rely on a later controller durable-watermark
// acknowledgment"). Idempotent and monotone (an older watermark never
// regresses; a replayed one is a no-op success); a watermark beyond the
// durable head is refused 409 (v4 §9.8 "never ACK non-durable events").
// Persist failures answer 500 with the error — never a silent success.
func (f internalNotifyFeature) serveAck(w http.ResponseWriter, r *http.Request) {
	if !f.authorized(r) {
		denyInternal(w)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	spool := f.spool()
	if spool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errResp("notify source unavailable"))
		return
	}
	var in ackRequestBody
	if !decodeBody(w, r, &in) {
		return
	}
	if in.Watermark < 0 {
		writeJSON(w, http.StatusBadRequest, errResp("bad watermark"))
		return
	}
	trimmed, err := spool.AckWatermark(in.Watermark)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, alerts.ErrAckBeyondDurableHead) {
			status = http.StatusConflict
		}
		writeJSON(w, status, errResp(err.Error()))
		return
	}
	writeJSON(w, http.StatusOK, jsonBytes(map[string]any{
		"ok":        true,
		"watermark": spool.AckedSeq(),
		"trimmed":   trimmed,
	}))
}

// spool returns the engine's durable source (nil when the engine was built
// without one — the defensive unconfigured posture).
func (f internalNotifyFeature) spool() *alerts.SourceSpool {
	if f.engine == nil {
		return nil
	}
	return f.engine.Source()
}

// EnableInternalNotify arms the private notify surface: it mounts the
// bearer-gated feed/ACK routes and records the enrollment context the
// NotifyEnrollment provider reads. Call AFTER InitAlerts (the engine and its
// durable source must exist) and BEFORE the agent daemon starts. token
// should come from NewInternalNotifyToken(). controllerMode is the daemon's
// --controller posture — it feeds the enrollment's fence report exactly like
// DecideNotifyOwnership decided it at alerts init (controller mode ⇒ fenced,
// before the tunnel connects).
func (s *Server) EnableInternalNotify(engine *alerts.Engine, token string, controllerMode bool) {
	f := internalNotifyFeature{
		engine:         engine,
		token:          token,
		stateDir:       stateBaseDir(),
		controllerMode: controllerMode,
	}
	s.internalNotify = &f
	s.RegisterFeature(f)
}

// NotifyEnrollment returns the CURRENT notify capability advertisement for
// tunnel registration — live, read at every (re)connect: the spool epoch can
// rotate mid-run (genuine replacement), and the persisted ownership state
// can change under a future transfer protocol. nil when the internal notify
// surface is not armed (or the engine has no durable source): the agent then
// registers WITHOUT a notify block — the pre-S2 wire shape.
//
// The ownership fields are the H-handshake START (brief §2 "Ownership and
// cutover"): the worker's CURRENT mode/fence/watermark so the controller can
// reconcile ownership without an extra round trip. Full H-transfer semantics
// land in S3/S4; S2 proves the fields flow and persist. Mode "" means the
// ownership state could not be read — reported honestly, never guessed.
func (s *Server) NotifyEnrollment() *tunnel.NotifyEnrollment {
	f := s.internalNotify
	if f == nil || f.token == "" {
		return nil
	}
	spool := f.spool()
	if spool == nil {
		return nil
	}
	n := &tunnel.NotifyEnrollment{
		SourceID:  spool.SourceID(),
		Epoch:     spool.Epoch(),
		NotifyCap: 1, // cap 1: private feed + watermark ACK
		Token:     f.token,
	}
	if st, ok := alerts.ReadNotifyOwnership(f.stateDir); ok {
		n.Mode = st.Mode
		n.Watermark = st.Watermark
	}
	// Fence report mirrors DecideNotifyOwnership: controller mode fences
	// ALWAYS (fail-closed — even when the state file is unreadable); a
	// standalone launch keeps the fence only while the persisted mode says
	// controller (a disconnect/flag change never restores local authority).
	n.Fenced = f.controllerMode || n.Mode == alerts.OwnershipModeController
	return n
}
