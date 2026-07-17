// Package state holds the daemon's materialized view of OpenCode session state
// and the monotonic, replayable event log that clients resume from.
//
// The store is schema-light: session/message/part payloads are kept as raw JSON
// and only the envelope fields needed for structure (ids, parentID) are parsed.
package state

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync"
	"time"

	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// Client-facing event kinds. The payload is the raw OpenCode payload, untouched.
const (
	KindSessionUpsert = "session.upsert"
	KindSessionDelete = "session.delete"
	KindMessageUpsert = "message.upsert"
	KindMessageDelete = "message.delete"
	KindPartUpsert    = "part.upsert"
	KindPartDelete    = "part.delete"
	// KindMessagesLoaded is the authoritative "this session's full message
	// history has been fetched and reconciled" completion signal for an
	// on-demand (lazy async) hydration. Emitted by the aggregator's
	// EnsureMessagesAsync after a successful fetch — UNCONDITIONALLY, including
	// when the fetch returned zero or byte-identical messages (no message.*
	// delta would otherwise ever signal "done" → a client would wedge on its
	// loading state forever). Recorded in the ring (replayable, seq-stamped),
	// like message.*/part.*; the snapshot gate's MessagesLoaded=true is the
	// same fact for a connecting client, so the event only matters while a
	// fetch is in flight for a client already connected. Session-scoped
	// (payload {sessionID}); the web layer's sendable() filters it to a
	// subscribed session so the tree-only Stream 1 never sees it.
	KindMessagesLoaded = "messages.loaded"
	// KindMessagesError signals an on-demand message hydration fetch FAILED for
	// a session. The session is NOT marked loaded (a later selection / transport
	// reconnect retries). Emitted so a connected client can surface the failure
	// instead of wedging on the loading state. Same lifetime/replay scope as
	// KindMessagesLoaded. Payload {sessionID, error}.
	KindMessagesError = "messages.error"
	// KindMessagesBatch carries a session's ENTIRE cold-load message+part
	// history as ONE wholesale event, collapsing what would otherwise be N
	// per-message message.upsert + per-part part.upsert events into a single
	// fan-out unit. Emitted by reconcileMessagesLocked ONLY on a cold-load
	// (session was not previously loaded: msgLoaded[sid] false at entry) — the
	// warm/incremental reconcile path (daemon OpenCode-stream reconnect for an
	// already-loaded session) keeps emitting individual upserts so a connected
	// client reconciles incrementally. The payload is {sessionID, encoding,
	// data}: sessionID stays PLAIN TEXT so the store/web interest filters
	// (payloadSessionID / sendable) keep working — only the heavy messages
	// array is compressed. "encoding":"gzip64" marks the form; "data" is the
	// base64-encoded gzip of the inner {messages:[...]} JSON (text compresses
	// ~5-10x, cutting cold-load hydrate over the controller tunnel; base64 is
	// required because SSE data: fields are text/UTF-8 and raw gzip bytes are
	// not valid UTF-8). The client (web/src/sync/stream.ts) base64-decodes +
	// gunzips (native DecompressionStream) + JSON.parses it back to
	// {sessionID, messages} and ingests via the same buildMessages path a warm
	// snapshot uses. Emitted BEFORE EmitMessagesLoaded so messages.loaded
	// remains the back-of-channel completion signal (the client reveal gate
	// still waits for it). Message-class (filtered to subscribed sessions like
	// the other message.* / part.* / messages.* kinds).
	KindMessagesBatch   = "messages.batch"
	KindTodo            = "todo"
	KindPermissionSet   = "permission.upsert"
	KindPermissionClear = "permission.delete"
	KindStatus          = "status"
	KindActivity        = "activity"
	// KindActivityVerb carries a session's current rich activity (the tool name +
	// its salient state) so a client can render "Reading parser.go" for an
	// UNOPENED subagent — without loading its Tier-B messages. It is NOT prefixed
	// message./part. so the web layer's sendable() always-streams it on the
	// tree-only Stream 1 to every client (mirrors activity/todo). Emitted only on
	// facet change (idempotent); cleared (empty tool) on idle/error/turn-complete.
	KindActivityVerb  = "activity.verb"
	KindQuestionSet   = "question.upsert"
	KindQuestionClear = "question.delete"
	KindUnreadSet     = "unread.set"
	KindUnreadClear   = "unread.clear"
	// KindLastAgentSet carries a session's cold-seeded lastAgent (the agent name
	// of its most recent assistant turn) to ALREADY-CONNECTED clients. lastAgent
	// is a snapshot-only facet (carried in Snapshot.LastAgents, NOT on the
	// session payload), and the cold seed (SetLastAgents) runs as a non-blocking
	// background goroutine that typically completes AFTER a client's first
	// snapshot landed — so without this live event the seeded label would sit in
	// the store unseen until the next reconnect served a fresh snapshot. Emitted
	// per session only when the value actually changes (idempotent). NOT prefixed
	// message./part. so the web layer's sendable() always-streams it on the
	// tree-only Stream 1 (mirrors activity.verb / activity / unread.*).
	KindLastAgentSet = "lastAgent.set"
	// KindNotice carries a daemon-detected alert (turn finished, waiting on a
	// human, stuck/runaway/stalled) for in-app delivery. It is NOT part of the
	// materialized view — it's a transient fan-out, not stored in any snapshot —
	// so a resuming client only sees notices emitted after it connects.
	KindNotice = "notice"
)

// Per-session activity states surfaced to clients (sidebar status).
const (
	ActivityIdle  = "idle"
	ActivityBusy  = "busy"
	ActivityRetry = "retry"
	ActivityError = "error"
)

// ClientEvent is one stamped, fan-out unit. Seq is the daemon's own monotonic
// counter (OpenCode event ids are ignored for resumption).
type ClientEvent struct {
	Seq     uint64          `json:"seq"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`

	// ingestNano is DIAGNOSTIC-ONLY: the local ingest t0 (monotonic-derived
	// nanoseconds elapsed since process start, via diag.MonoNow()) carried
	// from the opencode.SubscribeEvents boundary (Probe 1), used by Probe 2 to
	// measure ingest→emit age. Monotonic-derived — NOT wall-clock UnixNano —
	// so clock adjustments (NTP jumps, manual date changes) cannot make the
	// recorded age negative or falsely large. It is UNEXPORTED so json.Marshal
	// never emits it — the wire shape (seq/kind/payload) is bit-for-bit
	// unchanged, the ring stores it transparently, and writeEvent/replay
	// ignore it. Zero means "no ingest t0" (hydrate/daemon events).
	ingestNano int64
}

// Snapshot is the full current view plus the head seq a client resumes from.
type Snapshot struct {
	// Epoch identifies this store's lifetime. seq resets to 0 when the daemon
	// restarts (the view is in-memory, not durable), so a resume cursor is only
	// valid within one (epoch). A coordinator keys cursors by (worker, epoch, seq)
	// and re-snapshots when the epoch it sees changes.
	Epoch       string                        `json:"epoch"`
	Seq         uint64                        `json:"seq"`
	Sessions    []json.RawMessage             `json:"sessions"`
	Messages    map[string][]MessageWithParts `json:"messages"`
	Todos       map[string]json.RawMessage    `json:"todos,omitempty"`
	Permissions map[string][]json.RawMessage  `json:"permissions,omitempty"`
	Questions   map[string][]json.RawMessage  `json:"questions,omitempty"`
	Statuses    map[string]json.RawMessage    `json:"statuses,omitempty"`
	Activity    map[string]string             `json:"activity,omitempty"`
	// LastAgents carries the agent name of each session's most recent assistant
	// turn, so the tree can render per-agent chips on a COLD snapshot — before any
	// session's message history is hydrated. Like Activity, this is a snapshot-only
	// facet (NOT on the session payload) so it survives per-session upsert events
	// (which replace the session object on the client). Keyed by sessionID.
	LastAgents map[string]string `json:"lastAgents,omitempty"`
	// CurrentVerbs carries the rich current activity (tool + salient state) of
	// each session that is currently mid-tool, so a client can render
	// "Reading parser.go" for an UNOPENED subagent from the tree-only snapshot —
	// without loading its Tier-B messages. Like LastAgents, this is a snapshot-only
	// facet (NOT on the session payload) so it survives per-session upsert events.
	// Only sessions with a live running tool appear; the facet self-heals on the
	// next live part event. Keyed by sessionID.
	CurrentVerbs map[string]VerbFacet `json:"currentVerbs,omitempty"`
	// Gate carries the per-session "is this safe to act on" facts inline (A2), so a
	// coordinator evaluates its send/act gate from one snapshot — no N+1 detail
	// fetch, no message-history walk. Keyed by sessionID.
	Gate map[string]GateFacts `json:"gate,omitempty"`
	// Root sessions that finished (their subtree went busy -> idle) and haven't
	// been acknowledged yet — surfaced as an "unread/finished" indicator. Cleared
	// via Ack (the client scrolling that session to the bottom).
	Unread []string `json:"unread,omitempty"`
}

// GateFacts is the denormalized "is this session safe to act on" summary for one
// session — the raw facts a coordinator composes into its send/act gate, carried
// inline on every snapshot so a driver needn't issue an N+1 per-session detail
// fetch or walk message history. Every field is a raw opencode fact; vh-solara
// applies NO policy here (it does not, e.g., decide that finish_reason=="length"
// means "send continue" — the consumer interprets).
type GateFacts struct {
	Activity string `json:"activity"` // idle|busy|retry|error
	// Hydrated reports whether this session's messages have been loaded. The
	// message-derived fields below (last_assistant_completed, finish_reason,
	// tokens) are AUTHORITATIVE only when hydrated is true. After a daemon restart
	// (new epoch) an idle, never-opened session reports hydrated=false with
	// last_assistant_completed=false / empty finish_reason — that is "not yet
	// known", NOT "in-flight". A coordinator should force-hydrate (open) the
	// session, or trust `activity`, before relying on those fields (§1.7).
	Hydrated bool `json:"hydrated"`
	// MessagesLoaded reports strictly whether this session's FULL message
	// history has been fetched (the msgLoaded memo) — NOT "do we have any
	// message state at all". It is the gate-side counterpart of the lazy-async
	// hydration completion (the messages.loaded event / EnsureMessagesAsync).
	//
	// Distinct from Hydrated (above), which is "we have message state (live
	// events OR a history hydrate)" and conflates partial-exists with
	// fully-loaded: a session that received live message.* events has
	// messages[sid]!=nil → Hydrated=true but MessagesLoaded=false (the tail of
	// live deltas is NOT the full ordered history). A client must base its
	// "deliver the transcript / stop showing the loading state" decision on
	// MessagesLoaded, not Hydrated.
	//
	// NAMING: this Go field serializes to JSON `"messagesLoaded"`, the SAME
	// spelling as the FE's web/src/sync/store.ts SyncState.messagesLoaded map
	// (Record<string,boolean>). They are DIFFERENT facts that happen to share a
	// name by design (the FE map mirrors this gate field per connected client):
	//   - server gate GateFacts.MessagesLoaded = "the daemon fetched this
	//     session's full history" (the msgLoaded memo, set by the aggregator's
	//     background fetch).
	//   - FE SyncState.messagesLoaded[id] = "Stream 2 has DELIVERED the real
	//     message list for this session to THIS client" (set from the snapshot
	//     gate, when true, OR from a messages.loaded event).
	MessagesLoaded         bool   `json:"messagesLoaded"`
	LastAssistantCompleted bool   `json:"last_assistant_completed"` // latest assistant turn has time.completed (meaningful iff hydrated)
	FinishReason           string `json:"finish_reason,omitempty"`  // raw opencode `finish` of the latest assistant msg (meaningful iff hydrated)
	// LastAssistantEmpty is true when the latest assistant message has no
	// non-whitespace TEXT content (tool/file parts don't count). finish_reason is
	// the completion REASON, not a content signal — it's present on every
	// completed turn (incl. empty ones, e.g. stop with no text), so it can't
	// discriminate empty from non-empty; this field does. Meaningful iff hydrated.
	LastAssistantEmpty bool `json:"last_assistant_empty"`
	SubtreeBusy        bool `json:"subtree_busy"`       // any session in this subtree (incl. self) is busy/retry
	PendingQuestion    bool `json:"pending_question"`   // a question awaits a typed reply (a plain message won't satisfy it)
	PendingPermission  bool `json:"pending_permission"` // a permission awaits a typed reply
	// PermissionBlocked records that this session's automated-spawn permission
	// policy auto-rejected a prompt (an observable fact, NOT a policy — the policy
	// that triggered the reject lives in the web layer). It is STICKY past the
	// permission clearing so a caller observes it post-hoc, and clears on session
	// termination. See store.MarkPermissionBlocked.
	PermissionBlocked bool            `json:"permission_blocked"`
	Tokens            json.RawMessage `json:"tokens,omitempty"` // raw token-usage object of the latest assistant turn (meaningful iff hydrated)
}

// MessageWithParts mirrors OpenCode's GET /session/:id/message item shape.
type MessageWithParts struct {
	Info  json.RawMessage   `json:"info"`
	Parts []json.RawMessage `json:"parts"`
}

// VerbFacet is the RAW current-activity primitive for a session — the tool name
// plus the salient slice of its part `state` (input + status + time.start). The
// client formats it via its EXISTING toolVerb/toolSubject (Path B2); Go does NOT
// replicate the per-tool target picker. Only the formatting-salient state fields
// are carried (not the mutable output/error/metadata) so a running tool whose
// output grows part-by-part does NOT re-emit the facet — the verb/subject are
// stable across that growth. Empty (Tool=="") means "no current activity".
type VerbFacet struct {
	Tool  string          `json:"tool"`
	State json.RawMessage `json:"state,omitempty"`
}

// --- internal view structures ---

type sessionEntry struct {
	id       string
	parentID string
	info     json.RawMessage
	// Denormalized summary of the session's most recent assistant turn (A2),
	// refreshed whenever an assistant message changes. Kept on the session so the
	// tree-only list snapshot can carry the gate facts (finish reason + token
	// usage) WITHOUT the session's full message history being hydrated.
	hasAssistant      bool            // the session has at least one assistant message
	lastFinish        string          // raw `finish` of the latest assistant msg ("" if none/in-flight)
	lastTokens        json.RawMessage // raw `tokens` of the latest assistant msg
	lastAsstCompleted bool            // the latest assistant msg has time.completed
	lastAsstEmpty     bool            // the latest assistant msg has no non-whitespace text content
	lastAgent         string          // the agent name of the latest assistant msg (cold-seedable; see SetLastAgents)
	// currentVerb is the session's rich current-activity facet (tool + salient
	// state), refreshed on tool transitions and cleared on idle/error/turn-
	// complete. Surfaced in the snapshot as CurrentVerbs so a client renders the
	// verb for an UNOPENED subagent. Preserved across a session.updated that
	// replaces the entry (mirrors lastAgent) so a metadata refresh can't wipe a
	// live-set verb.
	currentVerb VerbFacet
}

type messageEntry struct {
	id        string
	info      json.RawMessage
	partOrder []string
	parts     map[string]json.RawMessage
	// Cached from info so we can detect an in-flight assistant turn without
	// re-parsing JSON: an assistant message with no completed time is generating.
	role      string
	completed bool
	// Cached from info for the gate facts (A2): opencode's `finish` reason
	// (e.g. "stop"|"length"|"tool-calls"; present iff the turn completed) and the
	// raw `tokens` usage object. Kept raw — vh-solara reports, never interprets.
	finish string
	tokens json.RawMessage
	// agent is the opencode `info.agent` string cached from info, used to populate
	// lastAgent on the session entry when this is the latest assistant message.
	agent string
	// deltaBuf is the native streaming-text accumulator (Option C / P1-AGG-004):
	// per (partID, field) it holds the authoritative accumulated field text in a
	// strings.Builder so a token-delta flood appends at amortized O(len(delta))
	// instead of the old per-char full JSON unmarshal+marshal + O(n²) full-text
	// copy. me.parts[partID] lags the accumulator by at most one throttle window
	// and is reconciled on flush (flushPartDeltasLocked). Keyed by
	// partID+"\x00"+field. A missing entry means "no unflushed text beyond what
	// me.parts already records". Reset to truth on upsertPartLocked (a
	// message.part.updated snapshot supersedes buffered deltas) and on
	// reconcileMessagesLocked (a history fetch is authoritative).
	deltaBuf map[string]*strings.Builder
	// deltaLastEmit bounds the part.upsert emit rate for THIS message's streaming
	// field: a delta appends to deltaBuf unconditionally, but the (O(part size)
	// marshal + emit + ring push) only fires when time.Since(deltaLastEmit) >=
	// deltaFlushInterval. Lazy time-check under s.mu — no timer goroutine, no
	// producer backpressure. The zero value means "never emitted" so the first
	// delta of a burst always flushes (first token appears instantly); the FE
	// further coalesces streaming markdown to ~5fps, so ~30fps of part events is
	// well within the live-feel budget.
	deltaLastEmit time.Time
	// liveTouchedBody marks a message whose BODY (info + cached fields) was
	// set by a live event (upsertMessageLocked) during an in-flight cold
	// full-history GET. On a cold-load reconcile the live body is NEWER than
	// the stale fetched body, so reconcile must NOT overwrite it. Not checked
	// on a warm resync (coldLoad==false), where the fetched list IS
	// authoritative. Cleared after each cold reconcile.
	liveTouchedBody bool
	// liveTouchedParts tracks per-part live updates (upsertPartLocked /
	// appendPartDeltaLocked) during an in-flight cold full-history GET. A
	// part flagged here is skipped on cold-load reconcile (its live body +
	// unflushed streaming accumulator are newer than the stale fetched body).
	// A non-empty map also preserves the message-level deltaBuf across the
	// reconcile (streaming deltas have authoritative accumulated text that a
	// stale fetch must not discard). Cleared after each cold reconcile.
	liveTouchedParts map[string]bool
}

type sessionMessages struct {
	order []string // message ids in creation order
	byID  map[string]*messageEntry
}

// --- envelope parse helpers ---

type sessionEnvelope struct {
	ID       string `json:"id"`
	ParentID string `json:"parentID"`
	Time     struct {
		Archived *float64 `json:"archived"`
	} `json:"time"`
}

func (e sessionEnvelope) archivedAt() bool { return e.Time.Archived != nil && *e.Time.Archived != 0 }

type messageInfoEnvelope struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionID"`
	Role      string `json:"role"`
	Time      struct {
		Completed *float64 `json:"completed"`
	} `json:"time"`
	// Assistant-turn facts surfaced for the gate (A2). `finish` is opencode's
	// raw completion reason; `tokens` the raw usage object.
	Finish string          `json:"finish"`
	Tokens json.RawMessage `json:"tokens"`
	// Agent is opencode's `info.agent` (the agent that produced an assistant
	// message). Cached here so the denormalized lastAgent on the session entry can
	// be set without re-parsing info.
	Agent string `json:"agent"`
}

type partEnvelope struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionID"`
	MessageID string `json:"messageID"`
}

type permissionEnvelope struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionID"`
}

// Store is the materialized view + event log. Safe for concurrent use.
type Store struct {
	mu sync.RWMutex

	epoch     string // stable for this store's lifetime; see Snapshot.Epoch
	seq       uint64
	sessions  map[string]*sessionEntry
	messages  map[string]*sessionMessages           // sessionID -> messages
	todos     map[string]json.RawMessage            // sessionID -> todos payload
	perms     map[string]map[string]json.RawMessage // sessionID -> permID -> permission
	questions map[string]map[string]json.RawMessage // sessionID -> questionID -> request
	// permBlocked[sid] records that the session's automated-spawn permission
	// policy auto-rejected a prompt. This is an observable FACT (the gate renders
	// it as GateFacts.PermissionBlocked); the POLICY that decided the reject
	// lives in the web layer. It is sticky past the permission clearing and
	// cleared on session termination (deleteSessionLocked).
	permBlocked map[string]bool
	statuses    map[string]json.RawMessage // sessionID -> status payload
	activity    map[string]string          // sessionID -> idle|busy|retry|error
	// activitySeq[sid] = the event seq at which the session's activity last
	// changed. Backs the If-Idle-Seq compare-and-swap: a coordinator that observed
	// a session sendable at seq N can ask to send "only if nothing changed since
	// N", so a turn that started-and-finished in the gap can't be double-driven.
	activitySeq map[string]uint64
	// Finished-unread tracking. busyCount[root] = number of busy/retry sessions in
	// the root's subtree; when it falls to 0 the root is marked unread (a finished
	// task awaiting acknowledgement). suppressUnread guards the hydrate reconcile.
	unread         map[string]bool
	busyCount      map[string]int
	suppressUnread bool
	// msgLoaded marks sessions whose message history has been fetched. Messages
	// are hydrated lazily (on first open) so startup doesn't fetch every
	// session's history — critical with thousands of sessions.
	msgLoaded map[string]bool
	// msgRev is a per-session message revision TOKEN bumped under s.mu for
	// EVERY mutation capable of changing that session's cold-batch/snapshot
	// message output (message/part upsert+delete, streaming part-delta append
	// via appendPartDeltaLocked's write-side throttle flush into me.parts,
	// history reconcile). Snapshot is NOT on this list — it is a pure read
	// projection under RLock and never bumps the token. It backs the
	// stale-batch guard: cold-load messages.batch packaging (JSON
	// marshal + gzip + base64) runs OUTSIDE s.mu (mirroring the SSE snapshot
	// precedent in pkg/web/server.go), so a live mutation landing during
	// packaging would otherwise let a STALE prepared batch overwrite newer
	// live deltas on the client — and the client treats messages.batch as a
	// WHOLESALE REPLACEMENT (web/src/sync/stream.ts). publishColdBatch
	// captures the token at capture time and, after packaging, re-acquires
	// the lock and emits the batch ONLY if the token is unchanged —
	// discarding + retrying when a mutation invalidated the captured
	// projection.
	//
	// The token is drawn from nextMsgRev (Store-wide monotonic) via
	// bumpMsgRev, NOT a per-session counter, so it is GLOBALLY NON-REPEATING.
	// A per-session counter that resets on delete would be vulnerable to an
	// ABA race: old session cold-batch captures at token N; session deleted;
	// same ID recreated; one mutation reproduces token N; the stale
	// publication validates N==N and emits the OLD session's wholesale batch
	// over the NEW state. The Store-wide counter guarantees a recreated
	// session always gets a strictly-greater token than any in-flight batch
	// could have captured. Cleared in deleteSessionLocked alongside the other
	// per-session maps (the map entry is dropped — no leak of deleted session
	// IDs — but nextMsgRev keeps climbing). A never-bumped session reads as 0
	// (Go map zero value), which is a valid baseline.
	msgRev map[string]uint64
	// nextMsgRev is the Store-wide monotonic source of per-session message
	// revision tokens. bumpMsgRev advances it (++ once per logical mutation)
	// and assigns the new value to the owning session's msgRev[sid]. See the
	// msgRev comment for why it is Store-wide (non-repeating) rather than
	// per-session (ABA-vulnerable). Zero is never handed out: the first bump
	// yields 1, so 0 remains a safe "never mutated" sentinel.
	nextMsgRev uint64
	// coldFetchActive marks sessions whose background full-history GET
	// (EnsureMessagesAsync) is in flight. Live events that arrive while this
	// flag is set tag their entries (liveTouchedBody / liveTouchedParts) so
	// the cold-load reconcile does NOT clobber the newer live body with the
	// stale fetched one (C-F2). Set by MarkColdFetchStart (called by the
	// aggregator before the GET); cleared in the cold-load reconcile block
	// after SetSessionMessages has merged. Distinct from msgLoaded: msgLoaded
	// persists for the session lifetime (marks "history was loaded"),
	// coldFetchActive is a transient in-flight window.
	coldFetchActive map[string]bool
	// seeded marks sessions whose lastAgent has already been cold-seeded by the
	// aggregator (via a lightweight message-tail fetch during hydrate). It makes
	// the cold-seed fire-once-per-session for the aggregator's lifetime instead
	// of on every (re)connect: a seeded session is skipped until it is removed.
	// Cleared in deleteSessionLocked, so a removed-then-recreated session is
	// re-seeded. Distinct from msgLoaded: opening a session (msgLoaded) derives
	// lastAgent authoritatively from the full history; seeded only suppresses
	// the lightweight tail re-fetch for un-opened sessions.
	seeded map[string]bool

	ring *ringBuffer
	subs map[int]*subscriber
	next int

	// curEmitIngest / curEmitSource carry the provenance of the event(s)
	// about-to-be-emitted by s.emit, for Probe 2 attribution. They are PLAIN
	// fields (no atomic) accessed ONLY under s.mu — every emit-path caller
	// holds s.mu. Apply sets curEmitIngest = ev.ingestNano (monotonic-derived)
	// + curEmitSource = live and defers a reset to daemon; Hydrate sets
	// hydrate and defers a reset; all other emit-path methods
	// (EmitMessagesLoaded/Error, publishColdBatch, SetSessionMessages,
	// RemoveSessions, etc.) inherit the daemon default (initialized in New).
	// Zero ingest = "no upstream t0 carried".
	curEmitIngest int64
	curEmitSource uint8
}

// newEpoch returns a random per-lifetime store id. crypto/rand is used so it's
// distinct across restarts without needing a clock (and stays unguessable).
func newEpoch() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "ep-fallback"
	}
	return "ep-" + hex.EncodeToString(b[:])
}

// New returns an empty store with an event ring of the given capacity.
func New(ringCapacity int) *Store {
	return &Store{
		epoch:           newEpoch(),
		sessions:        map[string]*sessionEntry{},
		messages:        map[string]*sessionMessages{},
		todos:           map[string]json.RawMessage{},
		perms:           map[string]map[string]json.RawMessage{},
		questions:       map[string]map[string]json.RawMessage{},
		permBlocked:     map[string]bool{},
		statuses:        map[string]json.RawMessage{},
		activity:        map[string]string{},
		activitySeq:     map[string]uint64{},
		unread:          map[string]bool{},
		busyCount:       map[string]int{},
		msgLoaded:       map[string]bool{},
		msgRev:          map[string]uint64{},
		coldFetchActive: map[string]bool{},
		seeded:          map[string]bool{},
		ring:            newRingBuffer(ringCapacity),
		subs:            map[int]*subscriber{},
		// Finding 4: SourceOpencodeLive is the iota zero value. Without an
		// explicit init here, ordinary daemon-originated emissions (messages
		// .loaded/error, activity, etc.) would be misattributed as
		// opencode_live in Probe 2's SourceCount. Daemon-generated is the safe
		// default for every emit path that does NOT set it explicitly.
		curEmitSource: diag.SourceDaemonGenerated,
	}
}

// bumpMsgRev advances the Store-wide monotonic token and assigns it to the
// owning session's msgRev[sid]. Called under s.mu for EVERY mutation capable
// of changing a session's cold-batch/snapshot message projection (message/part
// upsert+delete, streaming part-delta append + its write-side throttle flush
// into me.parts, history reconcile). Snapshot never calls this: it is a pure
// read projection under RLock that captures the buffered deltas onto fresh
// copies and overlays them during a lock-free materialization (see
// projectPartCaptured) with no writeback. Store-wide (not per-session) so
// the token is globally non-repeating: a deleted-then-recreated session can
// never reuse an old in-flight batch's token (the ABA fix). Exactly one bump
// per logical change.
func (s *Store) bumpMsgRev(sid string) {
	s.nextMsgRev++
	s.msgRev[sid] = s.nextMsgRev
}

// emit stamps, records, and fans out a client event. Caller must hold s.mu.
//
// Interest filtering is applied HERE (upstream of the channel) so a
// subscriber whose Interest excludes the event never has it enqueued — a slow
// high-volume producer (background subagent token deltas, re-emitted as
// part.upsert) cannot fill a structural-only subscriber's channel and starve it
// of the session.upsert/activity/status events it actually wants. The
// payload's sessionID is resolved ONCE per emit (at most one JSON unmarshal,
// regardless of subscriber count) and only for message-class events.
// Nonblocking fanout is preserved for INCLUDED events: a full channel still
// closes+removes that subscriber, never blocking the producer.
func (s *Store) emit(kind string, payload json.RawMessage) {
	s.seq++
	ev := ClientEvent{Seq: s.seq, Kind: kind, Payload: payload, ingestNano: s.curEmitIngest}
	s.ring.push(ev)
	sid := ""
	if isMessageClassKind(kind) {
		sid = payloadSessionID(payload)
	}
	// PROBE 2 (latency diagnostics): emit-boundary aggregates. PURE ATOMICS
	// only — no mutex, no channel, no allocation, no blocking — because this
	// runs under s.mu on every event. Records per-class count/bytes (fixed 5
	// classes), per-source count (live/hydrate/daemon — fixed 3), ingest→emit
	// age histogram when an ingest t0 was carried, and subscriber drops (the
	// existing backpressure sentinel — the drop itself is unchanged, only
	// counted). The fan-out loop below is byte-for-byte unchanged.
	//
	// Finding 2: the slow-emit IncidentRing capture was REMOVED from this
	// boundary. The ring's scoped mutex (IncidentRing.mu) and the dynamic
	// "emit_age:"+kind label allocation violated the hard lock-free / no-alloc
	// invariant for code that runs under s.mu. The atomic-CAS EmitAge
	// histogram stays (it is pure atomics) and still attributes slow emits in
	// aggregate; per-incident detail for this boundary is simply not recorded.
	// Slow-incident capture is retained on the SSE/yamux/ws boundaries (their
	// mutex acquire happens OUTSIDE any held store lock).
	emitMono := diag.MonoNow()
	cls := diag.ClassifyEmitKind(kind)
	diag.Default.Emit.ClassCount[cls].Inc()
	diag.Default.Emit.ClassBytes[cls].Add(uint64(len(payload)))
	diag.Default.Emit.SourceCount[s.curEmitSource].Inc()
	if s.curEmitIngest > 0 {
		age := emitMono - s.curEmitIngest
		if age >= 0 {
			diag.Default.Emit.EmitAge.Observe(age)
		}
	}
	for id, sub := range s.subs {
		if !sub.interest.wants(kind, sid) {
			continue // excluded by interest: never enters this channel
		}
		select {
		case sub.ch <- ev:
		default:
			// Slow consumer: drop it. The client will reconnect and re-snapshot.
			// PROBE 2: count the existing drop (the backpressure sentinel).
			diag.Default.Emit.SubscriberDrops.Inc()
			close(sub.ch)
			delete(s.subs, id)
		}
	}
}

// EmitNotice fans out a transient notice event to live subscribers. Unlike the
// view events, a notice is not recorded into any snapshot — it is delivered only
// to currently-connected clients (resuming clients won't replay it). Safe to
// call from any goroutine.
func (s *Store) EmitNotice(payload json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Finding 4: EmitNotice deliberately bypasses s.emit (it must NOT record to
	// the ring or advance seq — a notice is transient). But it still reports
	// into Probe 2's atomic class/source counters so notice events are
	// accounted. Class is structural (ClassifyEmitKind maps "notice" →
	// structural), source is daemon-generated (the default). PURE ATOMICS
	// only — consistent with the emit() boundary invariant.
	cls := diag.ClassifyEmitKind(KindNotice)
	diag.Default.Emit.ClassCount[cls].Inc()
	diag.Default.Emit.ClassBytes[cls].Add(uint64(len(payload)))
	diag.Default.Emit.SourceCount[diag.SourceDaemonGenerated].Inc()
	// Fan out WITHOUT recording to the ring or advancing seq: a notice is a live
	// alert, not part of the replayable view. Reusing the current head seq keeps
	// resume cursors monotonic (no gap, no duplicate-advance).
	ev := ClientEvent{Seq: s.seq, Kind: KindNotice, Payload: payload}
	for id, sub := range s.subs {
		select {
		case sub.ch <- ev:
		default:
			// Slow consumer: drop it. PROBE 2: count the existing drop.
			diag.Default.Emit.SubscriberDrops.Inc()
			close(sub.ch)
			delete(s.subs, id)
		}
	}
}

func rawObj(kv map[string]interface{}) json.RawMessage {
	b, _ := json.Marshal(kv)
	return b
}

// EmitMessagesLoaded fans out a messages.loaded completion event for ONE
// session: the authoritative "this session's full message history has been
// fetched and reconciled" signal. Recorded in the ring (replayable) so it
// composes with the seq-baseline guard like any view event. The aggregator
// emits this after a successful EnsureMessagesAsync fetch — including when the
// fetch returned zero or byte-identical messages, so a connected client never
// wedges on its loading state waiting for a message.* delta that never comes.
//
// fetchMs/reconcileMs split the window the client already measures as `hydrate`
// (first snapshot → this event): fetchMs = the upstream OpenCode GET
// /session/:id/message round-trip; reconcileMs = the daemon-side
// SetSessionMessages (decode + id-level diff + emit). They are carried verbatim
// on the payload so the Servers panel can show where a session-switch stall
// lives without a second probe. Non-negative; the only production caller is the
// aggregator's EnsureMessagesAsync. Safe to call from any goroutine.
func (s *Store) EmitMessagesLoaded(sid string, fetchMs, reconcileMs int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.emit(KindMessagesLoaded, rawObj(map[string]interface{}{
		"sessionID":   sid,
		"fetchMs":     fetchMs,
		"reconcileMs": reconcileMs,
	}))
}

// EmitMessagesError fans out a messages.error for ONE session: an on-demand
// hydration fetch failed and the session is NOT marked loaded (a later
// selection / transport reconnect retries). Emitted so a connected client can
// surface the failure instead of wedging on the loading state. Safe to call
// from any goroutine.
func (s *Store) EmitMessagesError(sid string, errMsg string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.emit(KindMessagesError, rawObj(map[string]interface{}{"sessionID": sid, "error": errMsg}))
}

// normalizeActivity maps an OpenCode SessionStatus.type to a UI activity state.
func normalizeActivity(statusType string) string {
	switch statusType {
	case "busy":
		return ActivityBusy
	case "retry":
		return ActivityRetry
	default:
		return ActivityIdle
	}
}

// setActivityLocked records a session's activity and emits a client event only
// when it changes. Caller must hold s.mu.
func (s *Store) setActivityLocked(sessionID, st string) {
	prev := s.activity[sessionID]
	if prev == st {
		return
	}
	s.activity[sessionID] = st
	s.emit(KindActivity, rawObj(map[string]interface{}{"sessionID": sessionID, "state": st}))
	s.activitySeq[sessionID] = s.seq // the seq of the activity event just emitted

	// Clear the rich current-activity facet when the session stops working
	// (idle/error). The turn's last tool part may still read status:"running"
	// (a stale snapshot), so the authoritative activity signal — not the
	// message scan — owns the "definitely not doing anything anymore" clear.
	if st != ActivityBusy && st != ActivityRetry {
		s.setCurrentVerbLocked(sessionID, VerbFacet{})
	}

	// Track the root subtree's busy count to detect "finished" (busy -> idle).
	wasBusy := prev == ActivityBusy || prev == ActivityRetry
	isBusy := st == ActivityBusy || st == ActivityRetry
	if wasBusy == isBusy {
		return
	}
	root := s.rootOfLocked(sessionID)
	if isBusy {
		if s.busyCount[root] == 0 {
			s.clearUnreadLocked(root) // running again — no longer a stale "finished"
		}
		s.busyCount[root]++
	} else {
		if s.busyCount[root] > 0 {
			s.busyCount[root]--
		}
		if s.busyCount[root] == 0 && !s.suppressUnread {
			s.markUnreadLocked(root)
		}
	}
}

// rootOfLocked walks parentID up to the top session still in the store.
func (s *Store) rootOfLocked(id string) string {
	cur := id
	for i := 0; i < 100000; i++ {
		e := s.sessions[cur]
		if e == nil || e.parentID == "" || s.sessions[e.parentID] == nil {
			return cur
		}
		cur = e.parentID
	}
	return cur
}

func (s *Store) markUnreadLocked(id string) {
	if s.sessions[id] == nil || s.unread[id] {
		return
	}
	s.unread[id] = true
	s.emit(KindUnreadSet, rawObj(map[string]interface{}{"sessionID": id}))
}

func (s *Store) clearUnreadLocked(id string) {
	if !s.unread[id] {
		return
	}
	delete(s.unread, id)
	s.emit(KindUnreadClear, rawObj(map[string]interface{}{"sessionID": id}))
}

// AckUnread clears a root's finished-unread flag (the client scrolled it to the
// bottom). The id may be any session in the subtree; its root is acked.
func (s *Store) AckUnread(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.clearUnreadLocked(s.rootOfLocked(sessionID))
}

// MarkIdle authoritatively marks a session idle and emits the activity event.
// Used by the abort verb: OpenCode does not emit session.idle on abort, so
// without this the authoritative activity stays "busy" until a stale event (or
// a stream reconnect's snapshot) re-applies it and re-arms the working
// indicator on a turn the user already stopped. setActivityLocked is a no-op
// when already idle, so a later real session.idle reconciles harmlessly.
func (s *Store) MarkIdle(sessionID string) {
	s.mu.Lock()
	s.setActivityLocked(sessionID, ActivityIdle)
	s.mu.Unlock()
}

// SetActivityFromStatuses seeds activity from a GET /session/status snapshot
// (sessionID -> SessionStatus). Used by the aggregator on (re)hydrate.
// SetActivityFromStatuses makes /session/status the authoritative source of
// per-session activity for ALL live sessions (matches opencode web). Sessions
// reported busy/retry are marked so; every other known session is cleared to
// idle. Clearing matters after a restart: a turn terminated mid-generation
// leaves an incomplete last message, and without an explicit idle the UI's
// fallback heuristic would spin that session forever.
func (s *Store) SetActivityFromStatuses(statuses map[string]json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Reconciling activity on (re)hydrate must not spuriously flag sessions as
	// finished-unread (busyCount still tracks correctly, just don't mark).
	s.suppressUnread = true
	defer func() { s.suppressUnread = false }()
	busy := map[string]bool{}
	for sid, raw := range statuses {
		var st struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(raw, &st)
		a := normalizeActivity(st.Type)
		s.setActivityLocked(sid, a)
		if a != ActivityIdle {
			busy[sid] = true
		}
	}
	// Clear everything else. Known sessions and loaded sessions are set idle;
	// never-busy sessions with no entry already render idle, so they're skipped
	// to avoid a churn of no-op events on large session lists.
	// clearActivity idles any session no longer reported busy. Named to avoid
	// shadowing the Go 1.21+ builtin clear (this repo is Go 1.25).
	clearActivity := func(sid string) {
		if !busy[sid] {
			s.setActivityLocked(sid, ActivityIdle)
		}
	}
	for sid := range s.sessions {
		clearActivity(sid)
	}
	for sid := range s.messages {
		clearActivity(sid)
	}
}

// Apply reduces a single live OpenCode event into the view and emits the
// corresponding client event(s).
func (s *Store) Apply(ev opencode.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// PROBE 2: attribute emits inside this Apply to the live upstream source
	// and carry the ingest t0 (Probe 1) so emit can measure ingest→emit age.
	// Reset on exit so the next emit-path caller (which re-acquires s.mu) sees
	// the daemon default unless it sets otherwise.
	s.curEmitIngest = ev.IngestNano
	s.curEmitSource = diag.SourceOpencodeLive
	defer func() { s.curEmitIngest = 0; s.curEmitSource = diag.SourceDaemonGenerated }()

	switch ev.Type {
	case "session.created", "session.updated", "session.compacted":
		s.upsertSessionLocked(ev.Properties) // properties.info is the Session
	case "session.deleted":
		var p struct {
			Info sessionEnvelope `json:"info"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && p.Info.ID != "" {
			s.deleteSessionLocked(p.Info.ID)
		}
	case "session.status", "session.idle", "session.error", "session.diff":
		var p struct {
			SessionID string `json:"sessionID"`
			Status    struct {
				Type string `json:"type"`
			} `json:"status"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && p.SessionID != "" {
			s.statuses[p.SessionID] = ev.Properties
			s.emit(KindStatus, ev.Properties)
			switch ev.Type {
			case "session.idle":
				s.setActivityLocked(p.SessionID, ActivityIdle)
			case "session.error":
				s.setActivityLocked(p.SessionID, ActivityError)
			case "session.status":
				s.setActivityLocked(p.SessionID, normalizeActivity(p.Status.Type))
			}
		}
	case "message.updated":
		var p struct {
			Info json.RawMessage `json:"info"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && len(p.Info) > 0 {
			s.upsertMessageLocked(p.Info)
		}
	case "message.removed":
		var p struct {
			SessionID string `json:"sessionID"`
			MessageID string `json:"messageID"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil {
			s.deleteMessageLocked(p.SessionID, p.MessageID)
		}
	case "message.part.updated":
		var p struct {
			Part json.RawMessage `json:"part"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && len(p.Part) > 0 {
			s.upsertPartLocked(p.Part)
		}
	case "message.part.delta":
		// Token-level streaming: OpenCode publishes deltas ({field,delta})
		// separately from the full message.part.updated snapshot. Accumulate them
		// so streaming text appears live instead of only at the next snapshot.
		var p struct {
			SessionID string `json:"sessionID"`
			MessageID string `json:"messageID"`
			PartID    string `json:"partID"`
			Field     string `json:"field"`
			Delta     string `json:"delta"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && p.SessionID != "" && p.PartID != "" && p.Delta != "" {
			s.appendPartDeltaLocked(p.SessionID, p.MessageID, p.PartID, p.Field, p.Delta)
		}
	case "message.part.removed":
		var p struct {
			SessionID string `json:"sessionID"`
			MessageID string `json:"messageID"`
			PartID    string `json:"partID"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil {
			s.deletePartLocked(p.SessionID, p.MessageID, p.PartID)
		}
	case "todo.updated":
		var p struct {
			SessionID string `json:"sessionID"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && p.SessionID != "" {
			s.todos[p.SessionID] = ev.Properties
			s.emit(KindTodo, ev.Properties)
		}
	case "permission.asked", "permission.updated":
		// OpenCode emits "permission.asked"; "permission.updated" is kept for
		// compatibility. Properties are the permission Request ({id, sessionID, …}).
		var p permissionEnvelope
		if json.Unmarshal(ev.Properties, &p) == nil && p.SessionID != "" && p.ID != "" {
			if s.perms[p.SessionID] == nil {
				s.perms[p.SessionID] = map[string]json.RawMessage{}
			}
			s.perms[p.SessionID][p.ID] = ev.Properties
			s.emit(KindPermissionSet, ev.Properties)
		}
	case "permission.replied":
		// OpenCode sends {sessionID, requestID, reply}; older/fixture payloads use
		// permissionID. Normalize so the client's delete (keyed by permissionID)
		// always clears the card.
		var p struct {
			SessionID    string `json:"sessionID"`
			RequestID    string `json:"requestID"`
			PermissionID string `json:"permissionID"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && p.SessionID != "" {
			id := p.RequestID
			if id == "" {
				id = p.PermissionID
			}
			if m := s.perms[p.SessionID]; m != nil {
				delete(m, id)
			}
			s.emit(KindPermissionClear, rawObj(map[string]interface{}{
				"sessionID": p.SessionID, "permissionID": id,
			}))
		}
	case "question.asked":
		var p struct {
			ID        string `json:"id"`
			SessionID string `json:"sessionID"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && p.SessionID != "" && p.ID != "" {
			if s.questions[p.SessionID] == nil {
				s.questions[p.SessionID] = map[string]json.RawMessage{}
			}
			s.questions[p.SessionID][p.ID] = ev.Properties
			s.emit(KindQuestionSet, ev.Properties)
		}
	case "question.replied", "question.rejected":
		var p struct {
			SessionID string `json:"sessionID"`
			RequestID string `json:"requestID"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && p.SessionID != "" {
			if m := s.questions[p.SessionID]; m != nil {
				delete(m, p.RequestID)
			}
			s.emit(KindQuestionClear, rawObj(map[string]interface{}{
				"sessionID": p.SessionID, "questionID": p.RequestID,
			}))
		}
	default:
		// server.connected / heartbeat / instance.disposed / file.* — ignored for the view.
	}
}

func (s *Store) upsertSessionLocked(props json.RawMessage) {
	var p struct {
		Info json.RawMessage `json:"info"`
	}
	if json.Unmarshal(props, &p) != nil || len(p.Info) == 0 {
		return
	}
	var env sessionEnvelope
	if json.Unmarshal(p.Info, &env) != nil || env.ID == "" {
		return
	}
	// A session archived in OpenCode (time.archived set) leaves the live tree —
	// e.g. when archived from another client. Treat the update as a delete.
	if env.archivedAt() {
		if _, ok := s.sessions[env.ID]; ok {
			s.deleteSessionLocked(env.ID)
		}
		return
	}
	// Preserve the cold-seeded lastAgent (set by SetLastAgents during hydrate)
	// across a session.updated that replaces the entry. Without this, a
	// metadata/title update for an un-opened session would wipe its cold-seeded
	// agent chip. recomputeLastAssistantLocked below does NOT restore it for
	// un-hydrated sessions (it leaves lastAgent untouched when sm==nil), so we
	// carry it over explicitly here.
	prev := s.sessions[env.ID]
	s.sessions[env.ID] = &sessionEntry{id: env.ID, parentID: env.ParentID, info: p.Info}
	if prev != nil {
		s.sessions[env.ID].lastAgent = prev.lastAgent
		// Preserve the live-set current-activity facet across an entry-replacing
		// session.updated (mirrors lastAgent) so a metadata/title refresh can't
		// wipe "Reading parser.go" for a running subagent.
		s.sessions[env.ID].currentVerb = prev.currentVerb
	}
	// A session.updated replaces the entry, so repopulate the denormalized
	// last-assistant summary from the (persisted) message view.
	s.recomputeLastAssistantLocked(env.ID)
	s.emit(KindSessionUpsert, p.Info)
}

func (s *Store) deleteSessionLocked(id string) {
	delete(s.sessions, id)
	delete(s.messages, id)
	delete(s.msgLoaded, id)
	delete(s.msgRev, id)
	delete(s.coldFetchActive, id)
	// Drop the cold-seed memo so a session recreated under the same id (live
	// session.deleted then session.created, an archive/un-archive, or a hydrate
	// prune-then-reappear) gets its lastAgent re-seeded from a fresh tail fetch.
	delete(s.seeded, id)
	delete(s.todos, id)
	delete(s.perms, id)
	delete(s.questions, id)
	delete(s.statuses, id)
	delete(s.activity, id)
	delete(s.activitySeq, id)
	delete(s.unread, id)
	delete(s.busyCount, id)
	// Clear the automated-spawn permission-blocked fact on termination. This is
	// the single session-removal chokepoint (live session.deleted, archive via
	// time.archived, and hydrate prune all funnel here), so one delete covers
	// every termination cause. Caller accounting keyed on permission_blocked
	// observes it while the session is alive; once gone, the gate is gone too.
	delete(s.permBlocked, id)
	s.emit(KindSessionDelete, rawObj(map[string]interface{}{"id": id}))
}

// --- archive (OpenCode-native: time.archived is the source of truth) ---

// descendantsLocked returns id plus every session transitively parented by it.
func (s *Store) descendantsLocked(id string) []string {
	children := map[string][]string{}
	for _, se := range s.sessions {
		if se.parentID != "" {
			children[se.parentID] = append(children[se.parentID], se.id)
		}
	}
	out := []string{}
	stack := []string{id}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		out = append(out, cur)
		stack = append(stack, children[cur]...)
	}
	return out
}

// Descendants returns id plus every live session transitively parented by it
// (used to cascade an archive across a session's subsessions).
func (s *Store) Descendants(id string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.sessions[id] == nil {
		return nil
	}
	return s.descendantsLocked(id)
}

// RemoveSessions drops sessions from the live view and emits session.delete for
// each, so connected clients prune them immediately (e.g. right after they were
// archived in OpenCode). A subsequent re-hydrate keeps things consistent.
func (s *Store) RemoveSessions(ids []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range ids {
		if _, ok := s.sessions[id]; ok {
			s.deleteSessionLocked(id)
		}
	}
}

// SetPendingQuestions reconciles the pending-question set to exactly the given
// requests (the GET /question response). Used on (re-)hydrate so a question that
// arrived as a missed live event — e.g. across a daemon restart — is restored.
// Emits upserts for present requests and clears for ones no longer pending.
func (s *Store) SetPendingQuestions(requests []json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	seen := map[string]bool{}
	for _, raw := range requests {
		var e struct {
			ID        string `json:"id"`
			SessionID string `json:"sessionID"`
		}
		if json.Unmarshal(raw, &e) != nil || e.ID == "" || e.SessionID == "" {
			continue
		}
		seen[e.SessionID+"\x00"+e.ID] = true
		if s.questions[e.SessionID] == nil {
			s.questions[e.SessionID] = map[string]json.RawMessage{}
		}
		s.questions[e.SessionID][e.ID] = raw
		s.emit(KindQuestionSet, raw)
	}
	for sid, m := range s.questions {
		for id := range m {
			if !seen[sid+"\x00"+id] {
				delete(m, id)
				s.emit(KindQuestionClear, rawObj(map[string]interface{}{"sessionID": sid, "questionID": id}))
			}
		}
	}
}

// SetPendingPermissions reconciles the pending-permission set to exactly the
// given requests (the GET /permission response) — the permission counterpart of
// SetPendingQuestions.
func (s *Store) SetPendingPermissions(requests []json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	seen := map[string]bool{}
	for _, raw := range requests {
		var e permissionEnvelope
		if json.Unmarshal(raw, &e) != nil || e.ID == "" || e.SessionID == "" {
			continue
		}
		seen[e.SessionID+"\x00"+e.ID] = true
		if s.perms[e.SessionID] == nil {
			s.perms[e.SessionID] = map[string]json.RawMessage{}
		}
		s.perms[e.SessionID][e.ID] = raw
		s.emit(KindPermissionSet, raw)
	}
	for sid, m := range s.perms {
		for id := range m {
			if !seen[sid+"\x00"+id] {
				delete(m, id)
				s.emit(KindPermissionClear, rawObj(map[string]interface{}{"sessionID": sid, "permissionID": id}))
			}
		}
	}
}

// PendingPermissions returns a copy of the pending-permission set under a READ
// lock. It exists so callers that only need permissions (e.g. the 2s reconcile
// backstop) do not pay for a full Snapshot: Snapshot materializes every
// message/part of every loaded session (an O(n) tree walk) and projects
// buffered streaming deltas onto fresh copies — but it still runs under the
// store lock and builds the whole materialized view. The reconcile loop reads
// only permissions, so a read-locked perms-only read is the proportional cost.
//
// The return shape (map[sessionID][]json.RawMessage) matches Snapshot.Permissions
// in structure, but the COPY semantics here are NARROWER than Snapshot's:
// Snapshot conservatively copies every escaping json.RawMessage byte (so the
// snapshot never aliases a store-owned backing array), whereas this method
// copies only the outer map and each per-session slice and SHARES the underlying
// permission byte arrays with the store. That is safe for its sole caller (the
// reconcile backstop, which treats the payloads as read-only and drops them
// before re-locking); callers that retain the bytes past another writer must
// copy them explicitly.
func (s *Store) PendingPermissions() map[string][]json.RawMessage {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string][]json.RawMessage, len(s.perms))
	for sid, m := range s.perms {
		// Omit empty-inner-map sessions to match Snapshot.Permissions exactly.
		if len(m) == 0 {
			continue
		}
		list := make([]json.RawMessage, 0, len(m))
		for _, perm := range m {
			list = append(list, perm)
		}
		out[sid] = list
	}
	return out
}

func (s *Store) upsertMessageLocked(info json.RawMessage) {
	var env messageInfoEnvelope
	if json.Unmarshal(info, &env) != nil || env.ID == "" || env.SessionID == "" {
		return
	}
	sm := s.messages[env.SessionID]
	if sm == nil {
		sm = &sessionMessages{byID: map[string]*messageEntry{}}
		s.messages[env.SessionID] = sm
	}
	if me := sm.byID[env.ID]; me != nil {
		me.info = info
		me.role = env.Role
		me.completed = env.Time.Completed != nil
		me.finish = env.Finish
		me.tokens = env.Tokens
		me.agent = env.Agent
		// Mark live-touched so a concurrent cold-load reconcile (background
		// full-history GET in flight) does NOT clobber this newer live body
		// with the stale fetched one (C-F2). Only tagged while a cold GET is
		// in flight (coldFetchActive); events outside that window are
		// authoritative snapshots the next reconcile can overwrite. Cleared
		// after the cold reconcile.
		if s.coldFetchActive[env.SessionID] {
			me.liveTouchedBody = true
		}
	} else {
		sm.byID[env.ID] = &messageEntry{
			id: env.ID, info: info, parts: map[string]json.RawMessage{},
			role: env.Role, completed: env.Time.Completed != nil,
			finish: env.Finish, tokens: env.Tokens, agent: env.Agent,
		}
		sm.order = append(sm.order, env.ID)
		// A live-created message is also live-touched (its body is at least as
		// new as what the in-flight cold GET will return) — but only while a
		// cold GET is in flight.
		if s.coldFetchActive[env.SessionID] {
			sm.byID[env.ID].liveTouchedBody = true
		}
	}
	// Any change to this session's message body/order changes its cold-batch
	// projection, so bump the per-session message revision token under the
	// lock. This is what lets publishColdBatch discard a stale prepared batch
	// when a live mutation lands during (unlocked) packaging.
	s.bumpMsgRev(env.SessionID)
	s.emit(KindMessageUpsert, info)
	if env.Role == "assistant" {
		s.recomputeLastAssistantLocked(env.SessionID)
		// An assistant message.updated marks a turn boundary (a completing turn's
		// running tools finalize, or a new multi-step turn begins): re-evaluate the
		// current-activity facet. When all tools completed it clears; when a new
		// turn's first tool is already running it sets.
		s.recomputeCurrentVerbLocked(env.SessionID)
	}

	// Escalate to busy from the live message stream: OpenCode's session.status/idle
	// events are not reliable for a streaming turn (a session can generate for
	// minutes while still reporting idle), which left the sidebar showing no
	// spinner for an actively-running session. An in-flight assistant message is
	// the authoritative "generating" signal.
	//
	// We only SET busy here, never idle. A multi-step turn (text → tool → text)
	// produces several assistant messages, and between two steps there's a gap
	// where no assistant message is in-flight yet — inferring idle from that gap
	// flipped the session idle→busy repeatedly within a single logical run, and
	// each transient idle dip fired a spurious "finished" notification (one per
	// tool call). Idle is owned by the authoritative session.idle event (which
	// fires once when the turn truly ends) and by the rehydrate snapshot.
	if env.Role == "assistant" && s.assistantInflightLocked(env.SessionID) {
		s.setActivityLocked(env.SessionID, ActivityBusy)
	}
}

// assistantInflightLocked reports whether a session has an assistant message
// that hasn't completed yet (i.e. a turn is still generating). Caller holds s.mu.
func (s *Store) assistantInflightLocked(sessionID string) bool {
	sm := s.messages[sessionID]
	if sm == nil {
		return false
	}
	for _, me := range sm.byID {
		if me.role == "assistant" && !me.completed {
			return true
		}
	}
	return false
}

// recomputeLastAssistantLocked refreshes a session's denormalized last-assistant
// summary (finish reason + token usage + completion of the most recent assistant
// message) from the in-memory message view, so the tree-only list snapshot can
// expose the gate facts without the full history being hydrated. A session that
// ran a turn during this daemon's lifetime has its messages in the store from the
// live event stream, so this is populated for exactly the sessions a coordinator
// can observe transitioning. Caller holds s.mu.
func (s *Store) recomputeLastAssistantLocked(sessionID string) {
	se := s.sessions[sessionID]
	if se == nil {
		return
	}
	sm := s.messages[sessionID]
	if sm == nil {
		// Messages not hydrated. Reset the gate-facts fields that are only
		// authoritative when hydrated (mirrors the pre-existing behavior), but
		// PRESERVE lastAgent — it may have been cold-seeded by SetLastAgents
		// during hydrate for a session whose full history we deliberately don't
		// fetch. Resetting it here would wipe every cold-seeded chip the moment a
		// session.updated (e.g. a title/metadata refresh) replaced the entry, since
		// upsertSessionLocked routes here after the replace. lastAgent becomes
		// authoritative again once the session is opened (messages loaded → this
		// branch is skipped and the scan below sets it from real data).
		se.hasAssistant = false
		se.lastFinish = ""
		se.lastTokens = nil
		se.lastAsstCompleted = false
		se.lastAsstEmpty = false
		return
	}
	se.hasAssistant = false
	se.lastFinish = ""
	se.lastTokens = nil
	se.lastAsstCompleted = false
	se.lastAsstEmpty = false
	se.lastAgent = ""
	for i := len(sm.order) - 1; i >= 0; i-- {
		me := sm.byID[sm.order[i]]
		if me == nil || me.role != "assistant" {
			continue
		}
		se.hasAssistant = true
		se.lastFinish = me.finish
		se.lastTokens = me.tokens
		se.lastAsstCompleted = me.completed
		se.lastAsstEmpty = !messageHasContent(me)
		se.lastAgent = me.agent
		return
	}
}

// recomputeCurrentVerbLocked refreshes a session's rich current-activity facet
// (tool name + salient state) from the in-memory message view, mirroring the
// client's activeVerbFromTurn scan: the newest assistant message is scanned
// newest-part-first for the first RUNNING tool, whose {tool, state} becomes the
// facet. When no running tool is found (turn boundary, all tools completed) the
// facet is cleared. It is the Tier-A source that lets a client render
// "Reading parser.go" for an UNOPENED subagent — Go emits the RAW primitive and
// the client formats it via its existing toolVerb/toolSubject (Path B2).
//
// Only the formatting-salient state fields (input + status + time.start) are
// stored, so a running tool whose output grows part-by-part does NOT re-emit:
// the verb/subject are stable across that growth. Idempotent — emits
// KindActivityVerb only when the facet actually changes. Caller holds s.mu.
//
// Hooked from upsertPartLocked (part snapshots → tool transitions) and
// upsertMessageLocked (assistant turn boundary); cleared authoritatively by
// setActivityLocked on idle/error. Mirrors recomputeLastAssistantLocked.
func (s *Store) recomputeCurrentVerbLocked(sessionID string) {
	se := s.sessions[sessionID]
	if se == nil {
		return
	}
	var next VerbFacet
	if sm := s.messages[sessionID]; sm != nil {
		for i := len(sm.order) - 1; i >= 0; i-- {
			me := sm.byID[sm.order[i]]
			if me == nil || me.role != "assistant" {
				continue
			}
			// Newest assistant message: scan its parts newest-first for the first
			// running tool (matches activeVerbFromTurn's pass-1 precedence).
			for j := len(me.partOrder) - 1; j >= 0; j-- {
				raw := me.parts[me.partOrder[j]]
				var p struct {
					Type  string          `json:"type"`
					Tool  string          `json:"tool"`
					State json.RawMessage `json:"state"`
				}
				if json.Unmarshal(raw, &p) != nil || p.Type != "tool" {
					continue
				}
				var st struct {
					Status string          `json:"status"`
					Input  json.RawMessage `json:"input"`
					Time   struct {
						Start *float64 `json:"start"`
					} `json:"time"`
				}
				_ = json.Unmarshal(p.State, &st)
				if st.Status != "running" {
					continue // not live — keep scanning older parts
				}
				next = VerbFacet{Tool: p.Tool, State: verbStatePayload(st.Status, st.Input, st.Time.Start)}
				break
			}
			break // only the newest assistant message bounds the in-flight turn
		}
	}
	s.setCurrentVerbLocked(sessionID, next)
}

// verbStatePayload marshals the formatting-salient slice of a tool part's state
// (input + status + time.start) into a stable object the client feeds verbatim
// to toolVerb/toolSubject. Trimming the mutable output/error/metadata keeps the
// facet byte-stable while a tool runs, so its growing output doesn't re-emit.
// json.Marshal sorts map keys, so the output is deterministic for byte compare.
func verbStatePayload(status string, input json.RawMessage, start *float64) json.RawMessage {
	m := map[string]any{}
	if status != "" {
		m["status"] = status
	}
	if len(input) > 0 && string(input) != "null" {
		m["input"] = input // already JSON; embed raw (json.Marshal copies bytes)
	}
	if start != nil {
		m["time"] = map[string]any{"start": *start}
	}
	b, _ := json.Marshal(m)
	return b
}

// setCurrentVerbLocked records a session's current-activity facet and emits a
// KindActivityVerb event ONLY when it changes (idempotent). An empty Tool clears
// the facet. Caller holds s.mu.
func (s *Store) setCurrentVerbLocked(sessionID string, facet VerbFacet) {
	se := s.sessions[sessionID]
	if se == nil {
		return
	}
	prev := se.currentVerb
	if facet.Tool == prev.Tool && bytes.Equal(facet.State, prev.State) {
		return
	}
	se.currentVerb = facet
	payload, _ := json.Marshal(map[string]any{
		"sessionID": sessionID,
		"tool":      facet.Tool,
		"state":     json.RawMessage(facet.State),
	})
	s.emit(KindActivityVerb, payload)
}

// messageHasContent reports whether an assistant message did anything: produced a
// non-whitespace TEXT reply, OR called a tool, OR emitted a file. A turn with any
// of those is NOT empty. Only "envelope" parts (reasoning, step markers, etc.)
// with no text/tool/file → empty (the GLM empty-stop case). A tool-only turn is
// the agent WORKING, so it counts as non-empty (don't auto-continue it).
func messageHasContent(me *messageEntry) bool {
	for _, raw := range me.parts {
		var p struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &p) != nil {
			continue
		}
		switch p.Type {
		case "tool", "file":
			return true
		case "text":
			if strings.TrimSpace(p.Text) != "" {
				return true
			}
		}
	}
	return false
}

func (s *Store) deleteMessageLocked(sessionID, messageID string) {
	sm := s.messages[sessionID]
	if sm != nil {
		if _, ok := sm.byID[messageID]; ok {
			delete(sm.byID, messageID)
			sm.order = removeString(sm.order, messageID)
		}
	}
	s.recomputeLastAssistantLocked(sessionID)
	// A message deletion changes this session's cold-batch projection; bump the
	// per-session message revision token so a concurrently-packaging cold batch
	// is discarded as stale.
	s.bumpMsgRev(sessionID)
	s.emit(KindMessageDelete, rawObj(map[string]interface{}{"sessionID": sessionID, "messageID": messageID}))
}

func (s *Store) upsertPartLocked(part json.RawMessage) {
	var env partEnvelope
	if json.Unmarshal(part, &env) != nil || env.ID == "" || env.MessageID == "" || env.SessionID == "" {
		return
	}
	sm := s.messages[env.SessionID]
	if sm == nil {
		sm = &sessionMessages{byID: map[string]*messageEntry{}}
		s.messages[env.SessionID] = sm
	}
	me := sm.byID[env.MessageID]
	if me == nil {
		// Part can arrive before its message.updated; create a placeholder.
		me = &messageEntry{id: env.MessageID, parts: map[string]json.RawMessage{}}
		sm.byID[env.MessageID] = me
		sm.order = append(sm.order, env.MessageID)
	}
	if _, ok := me.parts[env.ID]; !ok {
		me.partOrder = append(me.partOrder, env.ID)
	}
	me.parts[env.ID] = part
	// Mark live-touched so a concurrent cold-load reconcile does NOT clobber
	// this newer live part body with the stale fetched one (C-F2). Only tagged
	// while a cold GET is in flight (coldFetchActive); events outside that
	// window are authoritative snapshots the next reconcile can overwrite.
	// Cleared after the cold reconcile.
	if s.coldFetchActive[env.SessionID] {
		if me.liveTouchedParts == nil {
			me.liveTouchedParts = map[string]bool{}
		}
		me.liveTouchedParts[env.ID] = true
	}
	// An authoritative part snapshot changes this session's cold-batch
	// projection; bump the per-session message revision token so a concurrently-
	// packaging cold batch is discarded as stale.
	s.bumpMsgRev(env.SessionID)
	s.emit(KindPartUpsert, part)
	// Authoritative snapshot: discard any unflushed streaming accumulator for
	// this part — the snapshot supersedes buffered deltas (never let stale
	// buffered text override truth). The next delta re-seeds the accumulator
	// from this snapshot's field value, so deltas append onto the correct base.
	discardPartDeltaLocked(me, env.ID)
	// A part can finalize the latest assistant turn's text content (and parts may
	// arrive after the completed message.updated), so refresh the empty/finish
	// summary. Streaming deltas don't need this — the turn isn't completed yet, and
	// a part.updated snapshot follows them.
	s.recomputeLastAssistantLocked(env.SessionID)
	// Tool transitions arrive as part.updated snapshots (status running→completed,
	// or a new tool starting): refresh the rich current-activity facet. The
	// per-token delta path (appendPartDeltaLocked) deliberately does NOT route here
	// — it must not drive verb emission.
	s.recomputeCurrentVerbLocked(env.SessionID)
}

// deltaFlushInterval bounds the part.upsert emit rate during a token-delta
// burst (Option C / P1-AGG-004). A package-level var (not const) so tests can
// override it for deterministic throttle assertions. 30ms ≈ 33fps of part
// events — well within the live-feel budget (the FE coalesces streaming
// markdown to ~5fps in components/Part.tsx / lib/streamMd.ts), while cutting
// the per-char marshal+emit+ring-push cost to ~1× per window.
var deltaFlushInterval = 30 * time.Millisecond

// appendPartDeltaLocked applies a streaming text delta to a part using a NATIVE
// accumulator (strings.Builder) + a lazy time-throttled emit, instead of the
// old per-delta full JSON unmarshal+marshal + O(n²) full-text copy. The delta is
// always appended to the accumulator (cheap); the expensive rebuild+emit fires
// at most once per deltaFlushInterval. A later message.part.updated snapshot
// overwrites the part authoritatively and resets the accumulator (see
// upsertPartLocked). This is the WRITE-SIDE throttle flush into me.parts (the
// per-message emit path), distinct from the READ-SIDE projection: a Snapshot
// captures the unflushed accumulator (per partID) under RLock into a private
// copy, then overlays it onto a fresh part copy during lock-free
// materialization (projectPartCaptured) WITHOUT writing back into me.parts, so
// a point-in-time read reflects the live accumulated text while the
// accumulator stays intact for the writer.
func (s *Store) appendPartDeltaLocked(sessionID, messageID, partID, field, delta string) {
	if field == "" {
		field = "text"
	}
	sm := s.messages[sessionID]
	if sm == nil {
		sm = &sessionMessages{byID: map[string]*messageEntry{}}
		s.messages[sessionID] = sm
	}
	me := sm.byID[messageID]
	if me == nil {
		me = &messageEntry{id: messageID, parts: map[string]json.RawMessage{}}
		sm.byID[messageID] = me
		sm.order = append(sm.order, messageID)
	}
	// Ensure a part envelope exists (a delta can precede its part.updated) so
	// the part is ordered + the accumulator has a base to seed from. A later
	// message.part.updated overwrites it authoritatively.
	if _, had := me.parts[partID]; !had {
		me.parts[partID] = partPlaceholderJSON(partID, sessionID, messageID)
		me.partOrder = append(me.partOrder, partID)
	}
	// Mark live-touched so a concurrent cold-load reconcile does NOT clobber
	// this part's live-accumulated text (deltaBuf) with the stale fetched
	// body, nor wipe the unflushed accumulator (C-F2). Only tagged while a
	// cold GET is in flight (coldFetchActive). Cleared after the cold
	// reconcile.
	if s.coldFetchActive[sessionID] {
		if me.liveTouchedParts == nil {
			me.liveTouchedParts = map[string]bool{}
		}
		me.liveTouchedParts[partID] = true
	}

	// Native accumulator: append the delta to a strings.Builder keyed by
	// (partID, field). strings.Builder amortizes the growth, so N single-char
	// deltas cost O(N) total — NOT the old O(n²) full-text copy. The Builder
	// holds the authoritative accumulated field text; me.parts[partID] lags by
	// at most one throttle window.
	key := partID + "\x00" + field
	buf, ok := me.deltaBuf[key]
	if !ok {
		buf = &strings.Builder{}
		// Seed from the part's current authoritative field value (a prior
		// snapshot's text, or "" for the placeholder). This is the ONE unmarshal
		// per burst — not per char.
		var p map[string]any
		_ = json.Unmarshal(me.parts[partID], &p)
		if v, ok := p[field].(string); ok {
			buf.WriteString(v)
		}
		if me.deltaBuf == nil {
			me.deltaBuf = map[string]*strings.Builder{}
		}
		me.deltaBuf[key] = buf
	}
	buf.WriteString(delta)

	// Time-throttled flush (lazy, no goroutine): rebuild the part JSON from the
	// native accumulator + emit part.upsert at most ~1× per deltaFlushInterval.
	// The first delta of a burst always flushes (deltaLastEmit zero → elapsed
	// huge) so the first token appears instantly.
	now := time.Now()
	if now.Sub(me.deltaLastEmit) >= deltaFlushInterval {
		me.flushPartDeltasLocked(s, true)
		me.deltaLastEmit = now
	}

	// A streaming delta (and its throttled flush, which rewrites me.parts
	// directly without going through upsertPartLocked) changes this session's
	// cold-batch projection; bump the per-session message revision token so a
	// concurrently-packaging cold batch is discarded as stale.
	s.bumpMsgRev(sessionID)

	// Streaming deltas mean the turn is actively generating right now — assert
	// busy (cheap no-op once set) even when this delta was buffered. Cleared
	// when the assistant message completes (upsertMessageLocked) or on
	// session.idle. This makes the running indicator track real token flow even
	// when OpenCode's session.status lags.
	if me.role != "user" {
		s.setActivityLocked(sessionID, ActivityBusy)
	}
}

// flushPartDeltasLocked rebuilds me.parts from any unflushed deltaBuf entries
// and, when emit is true, emits a part.upsert for each changed part. Called at
// the throttle boundary in appendPartDeltaLocked (emit=true, under Apply's
// lock). The accumulators are KEPT across the flush (not deleted): subsequent
// deltas keep appending to the same Builder, and the next flush SETS the field
// from the full accumulated text (never appends), so there is no
// double-application. Reset happens only on authoritative overwrite
// (upsertPartLocked / reconcileMessagesLocked) or part deletion. Caller holds
// s.mu in WRITE mode (this method mutates me.parts and may emit).
//
// Snapshot does NOT call this method — it captures the buffered deltas onto
// fresh copies under RLock and overlays them during a lock-free materialization
// (projectPartCaptured) without writing back to me.parts, so Snapshot can run
// under RLock and its heavy projection can run after RUnlock.
func (me *messageEntry) flushPartDeltasLocked(s *Store, emit bool) {
	for key, buf := range me.deltaBuf {
		partID, field, ok := strings.Cut(key, "\x00")
		if !ok {
			continue
		}
		var part map[string]any
		_ = json.Unmarshal(me.parts[partID], &part)
		if part == nil {
			// Defensive: the placeholder is always created in appendPartDeltaLocked
			// before a buffer exists, so this only triggers under malformed state.
			part = map[string]any{"id": partID, "type": "text"}
		}
		part[field] = buf.String()
		if updated, err := json.Marshal(part); err == nil {
			me.parts[partID] = updated
			if emit {
				s.emit(KindPartUpsert, updated)
			}
		}
	}
}

// --- Snapshot capture types ---
//
// These are PRIVATE copies of the mutable store fields read during Snapshot's
// materialization. They are populated under s.mu.RLock (the CAPTURE phase) so
// the MATERIALIZATION phase can run after s.mu.RUnlock without aliasing any
// store-owned memory. See the ownership audit in the Snapshot doc comment:
// every store map (sessions/messages/todos/perms/questions/statuses/activity/
// unread) is mutated in place by writers; sessionEntry scalars are mutated in
// place by recomputeLastAssistantLocked / setCurrentVerbLocked; messageEntry
// fields (parts map, partOrder slice, deltaBuf strings.Builders) are mutated in
// place. NOTHING read after RUnlock may alias store memory, so each field here
// that came from a byte slice or map is a fresh copy taken under the lock.

// snapSessionCap holds the per-session scalar facts the Gate / LastAgents /
// CurrentVerbs / Sessions projection reads. Every json.RawMessage field is a
// private byte copy captured under the lock.
type snapSessionCap struct {
	info              json.RawMessage // copy of se.info
	hasAssistant      bool
	lastAsstCompleted bool
	lastAsstEmpty     bool
	lastFinish        string
	lastTokens        json.RawMessage // copy of se.lastTokens
	lastAgent         string
	currentVerbTool   string
	currentVerbState  json.RawMessage // copy of se.currentVerb.State
	// Existence facts read from store-level maps.
	msgLoaded    bool   // s.msgLoaded[sid]
	hasMessages  bool   // s.messages[sid] != nil
	hasQuestions bool   // len(s.questions[sid]) > 0
	hasPerms     bool   // len(s.perms[sid]) > 0
	permBlocked  bool   // s.permBlocked[sid]
	activity     string // s.activity[sid] ("" if absent)
}

// snapPartCap holds one captured part: a private byte copy of its base plus the
// per-field buffered delta text (if any) for this partID. deltas is nil when the
// part has no buffered deltaBuf entries (the common case), in which case
// projectPartCaptured returns base unchanged.
type snapPartCap struct {
	id     string
	base   json.RawMessage   // copy of me.parts[partID]
	deltas map[string]string // field -> cloned builder text for matching partID; nil if none
}

// snapMessageCap holds one captured message: a private byte copy of its info and
// its parts in partOrder, each pre-projected into a snapPartCap.
type snapMessageCap struct {
	info  json.RawMessage // copy of me.info
	parts []snapPartCap   // in me.partOrder
}

// captureDeltaText returns an OWNERSHIP-INDEPENDENT copy of buf's current
// accumulated text for the Snapshot capture phase. strings.Clone is REQUIRED
// here: in Go 1.25, (*strings.Builder).String() is implemented as
// unsafe.String(unsafe.SliceData(b.buf), len(b.buf)) — it does NOT copy, so a
// bare buf.String() would alias the builder's mutable backing array and survive
// past RUnlock as a live reference into store-owned memory (violating the
// Snapshot capture invariant that nothing read after RUnlock may alias store
// memory). strings.Clone allocates a fresh backing array the builder can never
// reach. Extracted as a named helper so the ownership property is testable
// directly (the full Snapshot path re-marshals the delta into fresh JSON bytes,
// which would mask the aliasing). Pinned by
// TestSnapshotDeltaCaptureIsOwnershipIndependent.
func captureDeltaText(buf *strings.Builder) string {
	return strings.Clone(buf.String())
}

// projectPartCaptured replicates the former projectPartLocked overlay logic but
// operates on a captured part (snapPartCap) so it can run OUTSIDE s.mu. The
// input bytes (base) and the delta strings are already private copies taken
// under the lock, so the returned slice never aliases store memory and is safe
// to retain past RUnlock. Called only by Snapshot's materialize phase.
//
// Mirrors the prior method byte-for-byte: no deltas -> return base as-is;
// overlay path decodes base into a fresh map, applies each buffered field,
// re-marshals, and falls back to base on a marshal error. The id is carried on
// the capture only to seed the defensive empty-base placeholder, matching the
// prior behavior exactly.
func projectPartCaptured(pc snapPartCap) json.RawMessage {
	if len(pc.deltas) == 0 {
		return pc.base
	}
	var part map[string]any
	if len(pc.base) > 0 {
		_ = json.Unmarshal(pc.base, &part)
	}
	if part == nil {
		part = map[string]any{"id": pc.id, "type": "text"}
	}
	for field, txt := range pc.deltas {
		part[field] = txt
	}
	if updated, err := json.Marshal(part); err == nil {
		return updated
	}
	return pc.base
}

// discardPartDeltaLocked drops every streaming accumulator entry whose partID
// matches — used when an authoritative snapshot (message.part.updated) or a
// history-fetch reconcile supersedes buffered deltas, and on part deletion.
// Caller holds s.mu.
func discardPartDeltaLocked(me *messageEntry, partID string) {
	if me == nil || me.deltaBuf == nil {
		return
	}
	for k := range me.deltaBuf {
		if pid, _, ok := strings.Cut(k, "\x00"); ok && pid == partID {
			delete(me.deltaBuf, k)
		}
	}
}

// partPlaceholderJSON returns a minimal text-part JSON for a delta that arrived
// before its message.part.updated (so the part is orderable + the accumulator
// has a base to seed from). The streaming field starts empty; deltas populate
// it via the native accumulator. A later message.part.updated overwrites it
// authoritatively.
func partPlaceholderJSON(partID, sessionID, messageID string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{
		"id": partID, "sessionID": sessionID, "messageID": messageID, "type": "text",
	})
	return b
}

func (s *Store) deletePartLocked(sessionID, messageID, partID string) {
	if sm := s.messages[sessionID]; sm != nil {
		if me := sm.byID[messageID]; me != nil {
			if _, ok := me.parts[partID]; ok {
				delete(me.parts, partID)
				me.partOrder = removeString(me.partOrder, partID)
			}
			// Drop any streaming accumulator for the deleted part.
			discardPartDeltaLocked(me, partID)
		}
	}
	// A part deletion changes this session's cold-batch projection; bump the
	// per-session message revision token so a concurrently-packaging cold batch
	// is discarded as stale.
	s.bumpMsgRev(sessionID)
	s.emit(KindPartDelete, rawObj(map[string]interface{}{
		"sessionID": sessionID, "messageID": messageID, "partID": partID,
	}))
	s.recomputeLastAssistantLocked(sessionID)
}

// Snapshot returns the current view and the head seq. The filter has THREE
// shapes, all load-bearing for the web session-load latency contract:
//   - messagesFor == nil          → firehose: every session's messages AND every
//     per-session structural row (Sessions/Gate/Questions/Activity/LastAgents/
//     CurrentVerbs/Permissions/Todos/Statuses/Unread). Used by ?sessions=all.
//   - messagesFor != nil && empty → Stream-1 tree owner: the FULL structural
//     tree for ALL sessions (the session-list view) but NO messages. The full
//     tree here is sacred — it is the session-list view.
//   - messagesFor != nil && > 0   → Stream-2 "open one session": SCOPE. Only the
//     SELECTED sessions' structural rows AND messages ship; every other session
//     is omitted entirely from the per-session-keyed maps. The Stream-2 consumer
//     (applySessionSnapshot / fetchSessionMessages) reads only
//     snap.messages[id] + snap.gate[id].messagesLoaded, so omitting unselected
//     sessions' structural rows is safe and avoids shipping the whole tree on
//     every "open one session" request.
//
// scopeSelected gates ONLY the len > 0 case; nil and empty-{} are UNCHANGED.
//
// Snapshot is a PURE READ PROJECTION: it mutates NO store state. It runs in two
// phases so a writer (Apply, which holds s.mu for write) is NOT blocked behind
// the heavy part of the work:
//
//  1. CAPTURE under s.mu.RLock: copy every mutable field the materialization
//     will read into locals (snapSessionCap / snapPartCap / snapMessageCap plus
//     the per-session byte-slice maps). All json.RawMessage bytes are COPIED so
//     the locals never alias store-owned backing arrays. This is the ONLY span
//     that holds the read lock. computeSubtreeBusyLocked also runs here; its
//     self-contained result map is kept whole.
//
//  2. MATERIALIZE after s.mu.RUnlock: build the Snapshot struct purely from the
//     captured locals, calling projectPartCaptured per part. The expensive JSON
//     unmarshal+marshal for parts with buffered deltas happens HERE, outside the
//     lock. No field of s.* / se.* / me.* is read after RUnlock.
//
// The narrowing is real for parts WITH buffered deltas (active streaming): the
// unmarshal+marshal moves out of the reader window, so a concurrent Apply no
// longer waits on it. For parts WITHOUT deltas (the common, static case) the
// capture does the same single byte-copy of the base that the old fast path did,
// then materialize assigns it directly — so the lock-window work for those parts
// is unchanged; the win is targeted at the streaming-contention case (large
// transcripts with active part-delta ingestion), not the static-snapshot case.
//
// Apply (the writer) still waits for the CAPTURE of any in-flight Snapshot —
// that is expected and fine; this method narrows the reader window from
// "capture+project+materialize+copy" to "capture", it does not eliminate writer
// blocking. The monotonic msgRev machinery (bumpMsgRev) stays on the Apply/flush
// path; Snapshot never bumps it.
//
// All json.RawMessage bytes that escape RLock are conservatively COPIED so they
// never alias store-owned backing arrays (a later writer under the write lock
// would otherwise be free to replace those slices — copying keeps the snapshot
// safe under the race detector and against any future in-place mutation).
//
// OWNERSHIP AUDIT (why each capture copies what it does):
//   - Store maps (sessions/messages/todos/perms/questions/statuses/activity/
//     unread/permBlocked/msgLoaded) are all mutated IN PLACE by writers (delete
//     keys, set keys) → captured by value, scoped under the lock.
//   - sessionEntry pointers are replaced wholesale by upsertSessionLocked, AND
//     their scalar fields are mutated in place by recomputeLastAssistantLocked
//     and setCurrentVerbLocked → all scalar facts + the info/lastTokens/
//     currentVerb.State bytes are copied into snapSessionCap; no *sessionEntry
//     is retained past RUnlock.
//   - messageEntry fields are mutated in place: upsertMessageLocked replaces
//     info/role/etc; upsertPartLocked does me.parts[id]=... and reassigns
//     me.partOrder; appendPartDeltaLocked mutates a strings.Builder VALUE in
//     place (the dangerous one) and reassigns me.deltaBuf[key] → info, the
//     partOrder slice, the parts bytes, and each matching deltaBuf entry's
//     builder text are all copied into snapMessageCap / snapPartCap; the
//     deltaBuf builders are snapshotted via captureDeltaText (strings.Clone of
//     the builder text at capture time), so the captured strings never alias
//     the builder's mutable backing array — a bare .String() would NOT suffice
//     in Go 1.25 (it returns unsafe.String over the builder's buffer, no copy).
func (s *Store) Snapshot(messagesFor map[string]bool) Snapshot {
	s.mu.RLock()

	scopeSelected := messagesFor != nil && len(messagesFor) > 0
	// inScope reports whether a session's per-session structural rows should
	// ship. When scopeSelected, only the selected sessions ship; nil/{} ship
	// every session (firehose / full tree).
	inScope := func(sid string) bool {
		if !scopeSelected {
			return true
		}
		return messagesFor[sid]
	}

	// --- CAPTURE PHASE (under s.mu.RLock) ---
	// Copy every mutable field the materialization will read into locals. After
	// RUnlock NOTHING may alias store-owned memory — see the ownership audit in
	// the doc comment. Scoping (inScope / messagesFor) is applied HERE so the
	// materialize phase is a straight assembly.

	epoch := s.epoch
	seq := s.seq
	// subtreeBusy is a self-contained map[string]bool from computeSubtreeBusyLocked
	// (it allocates its own maps internally and returns a fresh one); safe to keep
	// whole and read post-RUnlock. The walk is ALWAYS global even when scoped: a
	// selected session's subtree_busy depends on its descendants, which may be
	// unselected.
	subtreeBusy := s.computeSubtreeBusyLocked()

	// Per-session scalar facts (Gate / LastAgents / CurrentVerbs / Sessions).
	sessions := make(map[string]snapSessionCap, len(s.sessions))
	for sid, se := range s.sessions {
		if !inScope(sid) {
			continue
		}
		sessions[sid] = snapSessionCap{
			info:              append([]byte(nil), se.info...),
			hasAssistant:      se.hasAssistant,
			lastAsstCompleted: se.lastAsstCompleted,
			lastAsstEmpty:     se.lastAsstEmpty,
			lastFinish:        se.lastFinish,
			lastTokens:        append([]byte(nil), se.lastTokens...),
			lastAgent:         se.lastAgent,
			currentVerbTool:   se.currentVerb.Tool,
			currentVerbState:  append([]byte(nil), se.currentVerb.State...),
			msgLoaded:         s.msgLoaded[sid],
			hasMessages:       s.messages[sid] != nil,
			hasQuestions:      len(s.questions[sid]) > 0,
			hasPerms:          len(s.perms[sid]) > 0,
			permBlocked:       s.permBlocked[sid],
			activity:          s.activity[sid],
		}
	}

	// Questions: per in-scope session, bytes copied. s.questions is a nested
	// map (sessionID -> questionID -> bytes); iteration order is nondeterministic
	// here exactly as in the prior append loop, so parity is set-equality.
	questions := map[string][][]byte{}
	for sid, m := range s.questions {
		if !inScope(sid) {
			continue
		}
		var qs [][]byte
		for _, q := range m {
			qs = append(qs, append([]byte(nil), q...))
		}
		questions[sid] = qs
	}
	// Activity: per in-scope session.
	activity := map[string]string{}
	for sid, st := range s.activity {
		if !inScope(sid) {
			continue
		}
		activity[sid] = st
	}
	// Unread: in-scope ids.
	unread := make([]string, 0, len(s.unread))
	for id := range s.unread {
		if inScope(id) {
			unread = append(unread, id)
		}
	}
	// Todos: per in-scope session, bytes copied.
	todos := map[string][]byte{}
	for sid, t := range s.todos {
		if !inScope(sid) {
			continue
		}
		todos[sid] = append([]byte(nil), t...)
	}
	// Permissions: per in-scope session, bytes copied. s.perms is a nested
	// map (sessionID -> permID -> bytes); iteration order is nondeterministic
	// here exactly as in the prior append loop.
	perms := map[string][][]byte{}
	for sid, m := range s.perms {
		if !inScope(sid) {
			continue
		}
		var ps [][]byte
		for _, perm := range m {
			ps = append(ps, append([]byte(nil), perm...))
		}
		perms[sid] = ps
	}
	// Statuses: per in-scope session, bytes copied.
	statuses := map[string][]byte{}
	for sid, st := range s.statuses {
		if !inScope(sid) {
			continue
		}
		statuses[sid] = append([]byte(nil), st...)
	}
	// Messages: ordered per session, with per-part capture (base bytes + the
	// matching deltaBuf entries snapshotted as field→text). Gated by messagesFor
	// (nil=all ship; empty=none ship; non-empty=only listed) — a SEPARATE gate
	// from inScope, identical to the prior code.
	messages := map[string][]snapMessageCap{}
	for sid, sm := range s.messages {
		if messagesFor != nil && !messagesFor[sid] {
			continue
		}
		list := make([]snapMessageCap, 0, len(sm.order))
		for _, mid := range sm.order {
			me := sm.byID[mid]
			if me == nil {
				continue
			}
			mc := snapMessageCap{
				info: append([]byte(nil), me.info...),
			}
			mc.parts = make([]snapPartCap, 0, len(me.partOrder))
			for _, pid := range me.partOrder {
				pc := snapPartCap{
					id:   pid,
					base: append([]byte(nil), me.parts[pid]...),
				}
				// Snapshot any buffered deltaBuf entries targeting this partID
				// as field→accumulated-text. Mirrors the former
				// projectPartLocked key scan; captureDeltaText returns an
				// OWNERSHIP-INDEPENDENT copy of the builder's current text. A
				// bare buf.String() is NOT enough here: in Go 1.25 it is
				// unsafe.String over the builder's mutable backing array (no
				// copy), so it would alias store-owned memory and survive past
				// RUnlock — violating the capture invariant that nothing read
				// after RUnlock aliases store memory. Proven by
				// TestSnapshotDeltaCaptureIsOwnershipIndependent.
				if len(me.deltaBuf) > 0 {
					for k, buf := range me.deltaBuf {
						dpid, field, ok := strings.Cut(k, "\x00")
						if !ok || dpid != pid {
							continue
						}
						if pc.deltas == nil {
							pc.deltas = map[string]string{}
						}
						pc.deltas[field] = captureDeltaText(buf)
					}
				}
				mc.parts = append(mc.parts, pc)
			}
			list = append(list, mc)
		}
		messages[sid] = list
	}

	s.mu.RUnlock()

	// --- MATERIALIZATION PHASE (NO LOCK) ---
	// Build the Snapshot purely from the captured locals. The captured byte
	// slices are already private copies, so they are assigned directly to the
	// output (no double-copy); the no-aliasing invariant holds because every
	// output slice is a fresh capture-time copy of store bytes. The JSON
	// unmarshal+marshal for parts with buffered deltas happens here.
	//
	// Test seam: fires after RUnlock, before materialization. nil in production;
	// a test sets it to prove materialization runs outside the lock (an Apply
	// that needs the write lock completes while Snapshot blocks here).
	if snapshotMaterializeHook != nil {
		snapshotMaterializeHook()
	}

	snap := Snapshot{
		Epoch:        epoch,
		Seq:          seq,
		Messages:     map[string][]MessageWithParts{},
		Todos:        map[string]json.RawMessage{},
		Permissions:  map[string][]json.RawMessage{},
		Questions:    map[string][]json.RawMessage{},
		Statuses:     map[string]json.RawMessage{},
		Activity:     map[string]string{},
		Gate:         map[string]GateFacts{},
		LastAgents:   map[string]string{},
		CurrentVerbs: map[string]VerbFacet{},
	}

	// Per-session gate facts + facets. Iterating the captured `sessions` map
	// (not s.sessions) — order is nondeterministic here exactly as it was in the
	// prior map iteration; parity is set-equality of elements.
	for sid, sc := range sessions {
		act := sc.activity
		if act == "" {
			act = ActivityIdle // a never-touched session renders idle
		}
		snap.Gate[sid] = GateFacts{
			Activity: act,
			// We have message state (live events OR a history hydrate) iff
			// msgLoaded or a messages entry exists. When false, the message-
			// derived fields below are "not yet known", which a cold/un-opened
			// session after a restart can't be distinguished from in-flight
			// without this.
			Hydrated: sc.msgLoaded || sc.hasMessages,
			// MessagesLoaded is the STRICT "full history fetched" memo
			// (msgLoaded), independent of whether live message.* events have
			// populated a partial messages[sid] entry. See the
			// GateFacts.MessagesLoaded doc for why it is distinct from Hydrated.
			MessagesLoaded:         sc.msgLoaded,
			LastAssistantCompleted: sc.hasAssistant && sc.lastAsstCompleted,
			LastAssistantEmpty:     sc.lastAsstEmpty,
			FinishReason:           sc.lastFinish,
			SubtreeBusy:            subtreeBusy[sid],
			PendingQuestion:        sc.hasQuestions,
			PendingPermission:      sc.hasPerms,
			PermissionBlocked:      sc.permBlocked,
			// Tokens is the private byte copy captured above — assigned directly
			// (no aliasing; see the doc comment's copy invariant).
			Tokens: sc.lastTokens,
		}
		if sc.lastAgent != "" {
			snap.LastAgents[sid] = sc.lastAgent
		}
		// Surface the live current-activity facet (only sessions with a running
		// tool carry one) so a client renders the rich verb for an UNOPENED
		// subagent straight from the tree-only snapshot. State is the private
		// byte copy captured above.
		if sc.currentVerbTool != "" {
			snap.CurrentVerbs[sid] = VerbFacet{
				Tool:  sc.currentVerbTool,
				State: sc.currentVerbState,
			}
		}
		// Sessions slice: append each captured info bytes (already a copy).
		snap.Sessions = append(snap.Sessions, sc.info)
	}
	for sid, qs := range questions {
		// Preserve the original's omit-empty semantics: a session whose inner
		// map is empty must NOT appear in snap.Questions at all (the lazy-append
		// in the prior code never set the key when the inner loop body never
		// ran). Skipping an empty captured slice reproduces that exactly.
		if len(qs) == 0 {
			continue
		}
		out := make([]json.RawMessage, len(qs))
		for i, q := range qs {
			out[i] = q // captured copy
		}
		snap.Questions[sid] = out
	}
	for sid, st := range activity {
		snap.Activity[sid] = st
	}
	snap.Unread = unread
	for sid, t := range todos {
		snap.Todos[sid] = t // captured copy
	}
	for sid, ps := range perms {
		// Preserve the original's omit-empty semantics: a session whose inner
		// map is empty must NOT appear in snap.Permissions (TestPendingPermissions-
		// OmitsEmptyInnerMap). See the Questions loop above.
		if len(ps) == 0 {
			continue
		}
		out := make([]json.RawMessage, len(ps))
		for i, p := range ps {
			out[i] = p // captured copy
		}
		snap.Permissions[sid] = out
	}
	for sid, st := range statuses {
		snap.Statuses[sid] = st // captured copy
	}
	for sid, list := range messages {
		out := make([]MessageWithParts, 0, len(list))
		for _, mc := range list {
			parts := make([]json.RawMessage, 0, len(mc.parts))
			for _, pc := range mc.parts {
				// Pure projection on the captured part: overlay the captured
				// buffered deltas onto the captured base without touching the
				// store. This is the lock-free part of the old work.
				parts = append(parts, projectPartCaptured(pc))
			}
			out = append(out, MessageWithParts{
				Info:  mc.info, // captured copy
				Parts: parts,
			})
		}
		snap.Messages[sid] = out
	}
	return snap
}

// snapshotMaterializeHook is a test seam fired after Snapshot releases s.mu and
// before it materializes the result from captured locals. A test sets it to
// block (e.g. on a channel) so it can drive a concurrent Apply (which needs the
// write lock) to completion while a Snapshot is parked in its lock-free
// materialization phase — proving the reader window was narrowed to the capture.
// Nil in production. See coldBatchAfterCaptureHook for the same pattern on the
// cold-batch path.
var snapshotMaterializeHook func()

// computeSubtreeBusyLocked returns, for every session, whether any session in its
// subtree (including itself) is busy or retry — the gate's "no busy descendant"
// fact, so a coordinator needn't walk the tree itself. O(n) via memoized
// post-order over the parent links. Caller holds s.mu.
func (s *Store) computeSubtreeBusyLocked() map[string]bool {
	children := map[string][]string{}
	for id, se := range s.sessions {
		if se.parentID != "" && s.sessions[se.parentID] != nil {
			children[se.parentID] = append(children[se.parentID], id)
		}
	}
	busy := func(id string) bool {
		a := s.activity[id]
		return a == ActivityBusy || a == ActivityRetry
	}
	memo := map[string]bool{}
	var visit func(id string) bool
	visit = func(id string) bool {
		if v, ok := memo[id]; ok {
			return v
		}
		// Seed before recursion so a malformed cyclic parent link can't recurse
		// forever (session trees are acyclic, but never trust external data).
		memo[id] = busy(id)
		res := memo[id]
		for _, c := range children[id] {
			if visit(c) {
				res = true
			}
		}
		memo[id] = res
		return res
	}
	for id := range s.sessions {
		visit(id)
	}
	return memo
}

// SendableNow reports whether a plain message is safe to send to a session right
// now — the §1.1 gate as a single fact — plus the seq at which the session's
// activity last changed (for If-Idle-Seq CAS). sendable means: activity idle, no
// busy descendant, the latest assistant turn completed (or none yet), and no
// pending question or permission (those need a typed reply, not a message).
// exists is false for an unknown session. This is a raw mechanism check; the
// decision to *use* it (i.e. whether to gate a send) belongs to the caller.
func (s *Store) SendableNow(sid string) (sendable bool, activitySeq uint64, exists bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	se := s.sessions[sid]
	if se == nil {
		return false, 0, false
	}
	act := s.activity[sid]
	if act == "" {
		act = ActivityIdle
	}
	subtreeBusy := s.computeSubtreeBusyLocked()[sid]
	inflight := se.hasAssistant && !se.lastAsstCompleted
	sendable = act == ActivityIdle &&
		!subtreeBusy &&
		!inflight &&
		len(s.questions[sid]) == 0 &&
		len(s.perms[sid]) == 0
	return sendable, s.activitySeq[sid], true
}

// subscriber is one live-tail consumer registration: its buffered channel plus
// the Interest that governs which emitted events are enqueued. Held under s.mu.
type subscriber struct {
	ch       chan ClientEvent
	interest Interest
}

// Interest expresses which events a live-tail subscriber wants, evaluated at
// fanout time so irrelevant high-volume events never enter the subscriber's
// channel. The zero value means "all events" (the historical Subscribe
// behavior): structural, notification, control, AND every message/part event
// for every session.
//
// A non-zero Interest restricts ONLY the message-class events
// (message.*/part.*/messages.*) to the sessions listed in MessageSessions.
// Structural/notification/control events (session.*, activity, status, todo,
// unread.*, activity.verb, permission.*, question.*, notice) are ALWAYS
// delivered — they are the channels an operator must not lose behind a token
// flood. This mirrors the web layer's sendable() priority separation, pushed
// upstream from SSE egress into the store fanout.
//
// MessageSessions == nil means "deliver all message-class events too" (the
// firehose, matching the web layer's ?sessions=all). A non-nil map (including an
// empty one) means "deliver message-class events only for sessions in the set"
// (an empty set drops ALL message-class events — the tree-only Stream 1).
type Interest struct {
	// MessageSessions is the allow-set of session ids for message-class events.
	// nil = all (firehose); non-nil (incl. empty) = only the listed sessions.
	MessageSessions map[string]bool
}

// wants reports whether a subscriber with this interest wants an event of the
// given kind whose payload sessionID is sid ("" when the event is not
// message-class or has no sessionID). It is the SINGLE place that maps an event
// kind to a delivery class, so the kind→class rule is not duplicated across the
// codebase (the web layer's sendable() stays only as a defensive double-check).
func (i Interest) wants(kind, sid string) bool {
	if !isMessageClassKind(kind) {
		return true // structural/notification/control: always delivered
	}
	if i.MessageSessions == nil {
		return true // firehose: all message-class events
	}
	return sid != "" && i.MessageSessions[sid]
}

// isMessageClassKind reports whether kind is a message/part/messages event —
// the ONLY kinds subject to per-session interest filtering. Every other kind
// (session.*, activity, status, todo, unread.*, activity.verb, permission.*,
// question.*, notice) is delivered to every subscriber unconditionally. Listed
// by exact Kind constant (not string-prefix matching) so the set is explicit,
// typed, and greppable.
func isMessageClassKind(kind string) bool {
	switch kind {
	case KindMessageUpsert, KindMessageDelete,
		KindPartUpsert, KindPartDelete,
		KindMessagesLoaded, KindMessagesError,
		KindMessagesBatch:
		return true
	}
	return false
}

// payloadSessionID extracts the top-level "sessionID" from a message-class
// event payload (one JSON unmarshal). Returns "" when absent or unparseable;
// callers treat "" as "not in any allow-set" (the event is dropped for filtered
// subscribers), matching the web layer's sendable() semantics.
func payloadSessionID(payload json.RawMessage) string {
	var p struct {
		SessionID string `json:"sessionID"`
	}
	_ = json.Unmarshal(payload, &p)
	return p.SessionID
}

// Subscribe registers a live-tail consumer that receives ALL events (the zero
// Interest). Returns the channel and an unsubscribe func. The channel is closed
// if the consumer falls too far behind (nonblocking fanout is preserved).
//
// Backward-compatible entry point: internal consumers that need every event
// (the alerts engine) and existing tests use it unchanged. Use SubscribeWith to
// restrict message-class events to a session allow-set.
func (s *Store) Subscribe(buffer int) (<-chan ClientEvent, func()) {
	return s.SubscribeWith(buffer, Interest{})
}

// SubscribeWith registers a live-tail consumer whose Interest is applied AT
// FANOUT: events the interest excludes never enter the channel, so a slow
// high-volume producer (e.g. a background subagent's token-delta flood, which
// the store re-emits as part.upsert events) cannot fill a structural-only
// subscriber's channel and starve it of the session.upsert/activity/status
// events it actually wants. The nonblocking guarantee is preserved for included
// events — a full channel still closes+removes the subscriber, never blocking
// the producer. See Interest for the kind→class mapping.
func (s *Store) SubscribeWith(buffer int, interest Interest) (<-chan ClientEvent, func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.next
	s.next++
	sub := &subscriber{ch: make(chan ClientEvent, buffer), interest: interest}
	s.subs[id] = sub
	return sub.ch, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if cur, ok := s.subs[id]; ok {
			close(cur.ch)
			delete(s.subs, id)
		}
	}
}

// Close tears down all live subscribers: each subscriber's channel is closed
// and dropped from the registry. This forces downstream SSE handleStream loops
// (which range over their subscriber channel) to exit cleanly so the browser
// reconnects and re-snapshots against a freshly-built aggregator. It is the
// teardown half of a project reload: after the aggregator's Run context is
// cancelled, Close severs any in-flight client streams for the old store.
//
// Safe to call from any goroutine; idempotent (closing an already-closed set is
// a no-op because the map is cleared under s.mu). New subscribers registered
// after Close get a fresh, open channel — Close is one-shot, not sticky.
func (s *Store) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, sub := range s.subs {
		close(sub.ch)
		delete(s.subs, id)
	}
}

// MarkPermissionBlocked records that sessionID's automated-spawn permission
// policy auto-rejected a prompt. This sets an OBSERVABLE FACT (rendered on the
// gate as PermissionBlocked) — the policy decision lives in the web layer; the
// store only records the outcome so callers can observe it post-hoc. The flag
// is sticky past the permission clearing and is cleared on session termination
// (deleteSessionLocked). No-op if the session is no longer tracked.
func (s *Store) MarkPermissionBlocked(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.sessions[sessionID]; !ok {
		return
	}
	s.permBlocked[sessionID] = true
}

// Epoch returns this store's lifetime id (see Snapshot.Epoch).
func (s *Store) Epoch() string { return s.epoch }

// Head returns the current head seq without building a full snapshot — for
// cheaply stamping X-VH-Seq response headers.
func (s *Store) Head() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.seq
}

// RunningRoots returns the number of session roots whose subtree has at least
// one busy/retry session (busyCount[root] > 0). It mirrors the SPA
// runningSessionCount() semantics per-workspace: a root counts if any turn is
// in flight anywhere in its subtree. Used to aggregate a cross-workspace
// "restart will interrupt N running sessions" count without building snapshots.
func (s *Store) RunningRoots() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, c := range s.busyCount {
		if c > 0 {
			n++
		}
	}
	return n
}

// RootCount returns the number of LIVE session roots — roots among the
// non-archived sessions in the live tree. It uses the SAME orphan-inclusive root
// definition as rootOfLocked / busyCount / RunningRoots: a session is a root when
// it has no parentID OR its parentID is not present in the live store, so a child
// never counts even if its parent has been archived (an orphaned child becomes its
// own root). Archived sessions are already removed from s.sessions (archive via
// time.archived funnels through deleteSessionLocked), so they're excluded
// naturally and don't inflate the count. RootCount draws from the same population
// RunningRoots() does, so roots >= running always holds; pair the two for an idle
// count (idle = roots − running). Used by /vh/projects for the project switcher's
// per-workspace "X running, Y idle" badge (children were never meant to count).
func (s *Store) RootCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, e := range s.sessions {
		if e.parentID == "" || s.sessions[e.parentID] == nil {
			n++
		}
	}
	return n
}

// Replay returns buffered events with seq > cursor. ok is false when the cursor
// is older than the buffer's oldest retained event (caller must send a snapshot).
func (s *Store) Replay(cursor uint64) (events []ClientEvent, head uint64, ok bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.ring.since(cursor, s.seq)
}

// Hydrate replaces the view from a full fetch (sessions + messages per session),
// emitting upsert/delete client events only for ids that are new, changed, or
// gone — so connected clients reconcile incrementally without re-receiving
// unchanged history. Used on the daemon's own (re)connect to OpenCode, whose
// event stream has no replay. Byte comparison decides "changed".
//
// The session reconcile + message reconcile run under s.mu, then the lock is
// released BEFORE the cold-batch packaging loop: marshal+gzip+base64 is too
// expensive to hold the global lock for (it blocks all Apply ingestion). Each
// cold batch is published via publishColdBatch, which re-validates the per-
// session revision before emitting so a stale batch can never overwrite newer
// live deltas.
func (s *Store) Hydrate(sessions []json.RawMessage, messages map[string][]MessageWithParts) {
	s.mu.Lock()

	// PROBE 2: attribute emits inside this Hydrate to the hydrate source
	// (reconstructed state — no upstream ingest t0 carried). Reset BEFORE
	// s.mu.Unlock() below (NOT via defer) so the write stays under the lock —
	// otherwise the deferred reset races with Apply's writes to the same field.
	s.curEmitSource = diag.SourceHydrate

	// --- sessions ---
	seen := make(map[string]bool, len(sessions))
	for _, info := range sessions {
		var env sessionEnvelope
		if json.Unmarshal(info, &env) != nil || env.ID == "" {
			continue
		}
		if env.archivedAt() {
			continue // archived sessions are not part of the live tree
		}
		seen[env.ID] = true
		if old := s.sessions[env.ID]; old == nil || !bytes.Equal(old.info, info) {
			s.sessions[env.ID] = &sessionEntry{id: env.ID, parentID: env.ParentID, info: info}
			s.emit(KindSessionUpsert, info)
		}
	}
	for id := range s.sessions {
		if !seen[id] {
			s.deleteSessionLocked(id)
		}
	}

	// --- messages + parts (only for the sessions provided; lazy hydration
	// means this is empty on first connect and just the opened sessions on
	// reconnect, instead of every session). Reconcile under the lock; collect
	// the cold-load sessions so their (expensive) batch packaging runs OUTSIDE
	// s.mu via publishColdBatch (marshal+gzip+base64 must not hold the global
	// lock — it blocks all Apply ingestion during compression). ---
	var coldBatched []string
	for sid, list := range messages {
		if s.reconcileMessagesLocked(sid, list) {
			coldBatched = append(coldBatched, sid)
		}
	}
	s.curEmitSource = diag.SourceDaemonGenerated // PROBE 2: reset (under lock) before cold-batch
	s.mu.Unlock()

	// Package each cold batch outside the lock. Per-session revision validation
	// (inside publishColdBatch) guarantees each emitted batch is current for its
	// own session; inter-session order is not significant since each batch
	// carries its own sessionID. Hydrate does not emit messages.loaded — that is
	// the aggregator's per-session completion signal, not part of bulk hydrate
	// (reconnect replays via snapshots, not loaded events).
	for _, sid := range coldBatched {
		_ = s.publishColdBatch(sid)
	}
}

// reconcileMessagesLocked diffs one session's full message list into the store,
// emitting upsert/delete events for changes, and marks the session's messages
// as loaded. Caller must hold s.mu. It returns coldLoad=true when this was the
// session's first load (!s.msgLoaded[sid] at entry); in that case the caller is
// responsible for packaging the wholesale KindMessagesBatch OUTSIDE s.mu via
// publishColdBatch (marshal+gzip+base64 is too expensive to hold the global
// lock for — it blocks all event ingestion). On the warm/incremental path it
// returns false and no batch is produced (individual upserts are emitted here).
//
// Cold-load batching: when the session was NOT previously loaded
// (s.msgLoaded[sid] false at entry — the SetSessionMessages lazy-hydration path,
// or a Hydrate on a fresh daemon with no connected clients), the per-message
// message.upsert + per-part part.upsert emits are SUPPRESSED and a SINGLE
// KindMessagesBatch is emitted instead (by publishColdBatch, outside the lock),
// carrying the entire reconciled message+part list as one wholesale payload. This
// collapses the cold-load N-event fan-out (over the controller tunnel each event
// becomes a yamux frame + WebSocket message + flow-control round-trip — the root
// cause of the session-switch cold-load stall) into a single event the client
// ingests in one mutation. The warm/incremental path (msgLoaded already true — a
// daemon OpenCode-stream reconnect for an already-loaded session) keeps emitting
// individual upserts so a connected client reconciles only the diffs.
func (s *Store) reconcileMessagesLocked(sid string, list []MessageWithParts) (coldLoad bool) {
	coldLoad = !s.msgLoaded[sid] // detect BEFORE setting it true (msgLoaded lifecycle is unchanged)
	s.msgLoaded[sid] = true
	// The authoritative history reconcile rewrites this session's message/part
	// state (info, parts, order, and — on the warm path — absence deletions),
	// so bump the per-session message revision token under the lock. This is
	// what lets publishColdBatch discard a stale prepared batch whose capture
	// point predates this reconcile. Covers BOTH cold and warm reconciles: a
	// warm re-fetch of an already-loaded session while a prior cold batch is
	// still mid-packaging must also invalidate that batch.
	s.bumpMsgRev(sid)
	sm := s.messages[sid]
	if sm == nil {
		sm = &sessionMessages{byID: map[string]*messageEntry{}}
		s.messages[sid] = sm
	}
	seenMsg := make(map[string]bool, len(list))
	for _, mwp := range list {
		var env messageInfoEnvelope
		if json.Unmarshal(mwp.Info, &env) != nil || env.ID == "" {
			continue
		}
		seenMsg[env.ID] = true
		me := sm.byID[env.ID]
		if me == nil {
			me = &messageEntry{id: env.ID, info: mwp.Info, parts: map[string]json.RawMessage{}}
			sm.byID[env.ID] = me
			sm.order = append(sm.order, env.ID)
			if !coldLoad {
				s.emit(KindMessageUpsert, mwp.Info)
			}
		} else if !bytes.Equal(me.info, mwp.Info) && !(coldLoad && me.liveTouchedBody) {
			// C-F2: on a cold load, a live message.updated during the in-flight
			// GET means the store body is NEWER than the stale fetched body —
			// preserve the live body (skip the overwrite). The warm resync
			// path (coldLoad==false) treats the fetch as authoritative and
			// still overwrites unconditionally.
			me.info = mwp.Info
			if !coldLoad {
				s.emit(KindMessageUpsert, mwp.Info)
			}
		}
		// C-F2: when a live event touched the message body during the cold
		// fetch window, the live info + cached fields are newer than the stale
		// fetched envelope — preserve them wholesale (do NOT overwrite the
		// cached role/completed/finish/tokens/agent from the stale fetch).
		if !(coldLoad && me.liveTouchedBody) {
			me.role = env.Role
			me.completed = env.Time.Completed != nil
			me.finish = env.Finish
			me.tokens = env.Tokens
			me.agent = env.Agent
		}
		// A history fetch is authoritative for this message's parts: discard
		// streaming accumulators (they were building on stale/live bases) —
		// UNLESS a live part event (snapshot or delta) touched this message
		// during the fetch window, in which case the accumulators hold newer
		// live text the stale fetch must not discard (C-F2). (A non-empty
		// deltaBuf implies at least one live-touched part, so this check also
		// covers unflushed streaming text.)
		if !(coldLoad && len(me.liveTouchedParts) > 0) {
			me.deltaBuf = nil
			me.deltaLastEmit = time.Time{}
		}

		seenPart := make(map[string]bool, len(mwp.Parts))
		for _, part := range mwp.Parts {
			var pe partEnvelope
			if json.Unmarshal(part, &pe) != nil || pe.ID == "" {
				continue
			}
			seenPart[pe.ID] = true
			if old, ok := me.parts[pe.ID]; !ok {
				me.parts[pe.ID] = part
				me.partOrder = append(me.partOrder, pe.ID)
				if !coldLoad {
					s.emit(KindPartUpsert, part)
				}
			} else if !bytes.Equal(old, part) && !(coldLoad && me.liveTouchedParts[pe.ID]) {
				// C-F2: on a cold load, a live part event (snapshot or delta) during
				// the in-flight GET means the store part body is NEWER than the
				// stale fetched body — preserve the live body (skip the overwrite).
				// The warm resync path (coldLoad==false) treats the fetch as
				// authoritative and still overwrites.
				me.parts[pe.ID] = part
				if !coldLoad {
					s.emit(KindPartUpsert, part)
				}
			}
		}
		// Absence-deletion is AUTHORITATIVE-only: skipped on a cold load
		// (coldLoad==true), where the fetched list can be stale relative to
		// live message/part events that arrived during the in-flight fetch.
		// On a cold load the live event tail is the source of truth for "what
		// exists now"; deleting a store part merely because it's absent from a
		// stale fetch would clobber newer live state (e.g. a live
		// message.part.updated for a brand-new part landing mid-fetch).
		for pid := range me.parts {
			if !seenPart[pid] && !coldLoad {
				delete(me.parts, pid)
				me.partOrder = removeString(me.partOrder, pid)
				s.emit(KindPartDelete, rawObj(map[string]interface{}{
					"sessionID": sid, "messageID": env.ID, "partID": pid,
				}))
			}
		}
	}
	// Same cold-load gate as the part loop above: on a cold load a fetched
	// message list can be stale relative to live events, so absence from the
	// fetch is NOT a reliable deletion signal — only the warm resync path
	// (reconnect/re-fetch for an already-loaded session, coldLoad==false)
	// reconciles authoritatively and prunes absent messages. Live deletion
	// (session.deleted / explicit removal events) is the authoritative prune
	// path for a cold-loaded session.
	for mid := range sm.byID {
		if !seenMsg[mid] && !coldLoad {
			delete(sm.byID, mid)
			sm.order = removeString(sm.order, mid)
			s.emit(KindMessageDelete, rawObj(map[string]interface{}{
				"sessionID": sid, "messageID": mid,
			}))
		}
	}
	s.recomputeLastAssistantLocked(sid)

	if coldLoad {
		// Clear the live-touch markers (C-F2): they are scoped to the cold-fetch
		// window and have served their purpose. Cold load happens once per
		// session lifetime (msgLoaded is cleared only by deleteSessionLocked),
		// but clearing here keeps the semantics explicit and the memory tidy.
		for _, me := range sm.byID {
			me.liveTouchedBody = false
			me.liveTouchedParts = nil
		}
		delete(s.coldFetchActive, sid)
		// NOTE: the wholesale KindMessagesBatch is NOT emitted here. It is
		// packaged OUTSIDE s.mu by publishColdBatch (the caller), because the
		// marshal+gzip+base64 pipeline is too expensive to hold the global
		// lock for (it blocks all Apply ingestion during compression). The
		// caller re-validates the per-session message revision before emitting
		// so a stale prepared batch can never overwrite newer live deltas.
	}
	return coldLoad
}

// captureMessagesBatchLocked builds the wholesale-batch projection for one
// session (the same MessageWithParts {Info, Parts} shape, in sm.order /
// me.partOrder order, that the snapshot serialization uses) and returns it
// together with the current per-session message revision. Caller must hold s.mu.
//
// Every json.RawMessage whose backing bytes escape the lock (me.info and each
// me.parts[pid]) is COPIED. Message/part mutations today REPLACE map values
// (they never mutate a backing array in place), so the copy is defensive; but it
// is required for the -race detector (packaging reads these bytes outside s.mu)
// and bulletproofs any future in-place mutation. Returns a nil list when there
// is no message state (e.g. an empty cold fetch, or the session was deleted
// between reconcile and capture) — the caller treats nil as "nothing to emit".
func (s *Store) captureMessagesBatchLocked(sid string) ([]MessageWithParts, uint64) {
	sm := s.messages[sid]
	if sm == nil {
		return nil, s.msgRev[sid] // defensive: no message state (empty fetch / deleted)
	}
	list := make([]MessageWithParts, 0, len(sm.order))
	for _, mid := range sm.order {
		me := sm.byID[mid]
		if me == nil {
			continue
		}
		parts := make([]json.RawMessage, 0, len(me.partOrder))
		for _, pid := range me.partOrder {
			parts = append(parts, append([]byte(nil), me.parts[pid]...))
		}
		list = append(list, MessageWithParts{
			Info:  append([]byte(nil), me.info...),
			Parts: parts,
		})
	}
	return list, s.msgRev[sid]
}

// packageMessagesBatch performs the APPLICATION-COMPRESSED encoding of a
// captured message projection into a KindMessagesBatch payload. It is PURE: no
// store access, no lock, no s.mu — this is the work that was previously done
// under the write lock (the root cause of the cold-load contention) and now runs
// outside it. Returns nil on any marshal/gzip error (already logged) so the
// caller can skip emitting a malformed batch.
//
// The payload shape (mirroring the SSE snapshot precedent at server.go:1075-1093,
// which also marshals/compresses AFTER returning from the store lock):
//
//	{"sessionID": sid, "encoding":"gzip64", "data":"<base64-gzip>"}
//
// sessionID stays PLAIN TEXT so payloadSessionID (store interest filter) and
// sendable() (web egress filter) keep extracting it — replacing the whole
// payload with a base64 blob would silently drop the batch for Stream-2
// (open-session) subscribers. Only the heavy messages array is compressed:
// "data" is base64( gzip( {"messages":[...]} ) ). base64 is required because
// SSE data: fields are text/UTF-8 and raw gzip bytes are not valid UTF-8.
// Always-compress policy (the batch only fires for cold-loads, which are
// non-trivial by nature, so there is no small-payload case worth a threshold).
func packageMessagesBatch(sid string, list []MessageWithParts) json.RawMessage {
	if list == nil {
		return nil
	}
	inner, err := json.Marshal(struct {
		Messages []MessageWithParts `json:"messages"`
	}{Messages: list})
	if err != nil {
		// Cannot fail for this well-typed anonymous struct today, but a silent
		// discard would mask a future regression (e.g. a non-marshalable field
		// added to MessageWithParts). Bail rather than emit a malformed batch.
		vhlog.Warn("messages.batch: marshal inner failed", "sessionID", sid, "err", err)
		return nil
	}
	// gzip the inner messages JSON, then base64-encode so the bytes survive
	// SSE's text/UTF-8 data: framing. Default compression level: the batch is
	// only emitted on cold-load, so the marginal CPU is fine and gzip's default
	// (DefaultCompression) gives the best size/speed tradeoff.
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	_, _ = gw.Write(inner) // gzip.Writer.Write does not return a meaningful error mid-stream
	if err := gw.Close(); err != nil {
		// gzip.Close flushes the trailer; on failure buf holds an incomplete
		// gzip stream whose base64 would be undecodable on the client. The
		// *bytes.Buffer backing writer cannot fail today, but do not silently
		// swallow a future regression — skip emitting (the client re-fetches on
		// the next cold load) instead of corrupt bytes.
		vhlog.Warn("messages.batch: gzip close failed", "sessionID", sid, "err", err)
		return nil
	}
	payload, err := json.Marshal(struct {
		SessionID string `json:"sessionID"`
		Encoding  string `json:"encoding"`
		Data      string `json:"data"`
	}{SessionID: sid, Encoding: "gzip64", Data: base64.StdEncoding.EncodeToString(buf.Bytes())})
	if err != nil {
		vhlog.Warn("messages.batch: marshal payload failed", "sessionID", sid, "err", err)
		return nil
	}
	return payload
}

// coldBatchAfterCaptureHook is a test-only seam. When non-nil, publishColdBatch
// invokes it AFTER capturing the projection under the lock and releasing the
// lock, BEFORE packaging. A test sets it to block (e.g. on a channel) so it can
// apply a concurrent same-session mutation between capture and publish, then
// assert the stale prepared batch is discarded and the retry emits the newer
// state. Nil in production.
var coldBatchAfterCaptureHook func(sid string)

// ColdBatchStatus is the outcome of a cold-load messages.batch publication
// (publishColdBatch / SetSessionMessages). It makes publication success
// EXPLICIT so the aggregator callers can gate EmitMessagesLoaded correctly:
// messages.loaded must follow a valid messages.batch, and must NOT fire when
// the session disappeared or packaging failed (Finding 3 — without this the
// aggregator UNCONDITIONALLY called EmitMessagesLoaded, so messages.loaded
// could be delivered with no preceding messages.batch, breaking the
// one-batch-before-loaded ordering contract the client relies on).
type ColdBatchStatus int

const (
	// ColdBatchEmitted: a revision-VALID KindMessagesBatch was published. The
	// caller SHOULD follow with EmitMessagesLoaded (one-batch-then-loaded).
	ColdBatchEmitted ColdBatchStatus = iota
	// ColdBatchWarmReconcile: reconcileMessagesLocked ran the WARM path (the
	// session was already loaded — a daemon reconnect), so no wholesale batch
	// is emitted (individual upserts/deletes were emitted inside reconcile).
	// The caller SHOULD follow with EmitMessagesLoaded (the client needs the
	// completion signal to exit the loading state).
	ColdBatchWarmReconcile
	// ColdBatchSessionGone: there was no message state to emit — the session
	// was deleted between reconcile and capture, or the fetch returned an empty
	// result for a now-gone session. The caller MUST NOT call
	// EmitMessagesLoaded: the session is gone, and emitting loaded (or an empty
	// batch to satisfy ordering) would reintroduce state after session.delete.
	ColdBatchSessionGone
	// ColdBatchPackagingFailed: marshal/gzip failed (already logged). No batch
	// was emitted. The caller MUST NOT call EmitMessagesLoaded; the client
	// re-fetches on the next cold load.
	ColdBatchPackagingFailed
)

// publishColdBatch packages and emits a session's cold-load KindMessagesBatch
// with the marshal+gzip+base64 pipeline performed OUTSIDE s.mu, while
// GUARANTEEING a stale prepared batch can never overwrite newer live deltas.
// This is the unlocked-packaging counterpart to reconcileMessagesLocked: that
// mutates under the lock and returns coldLoad=true; the caller then invokes this.
//
// The risk it mitigates: the client treats messages.batch as a WHOLESALE
// REPLACEMENT (stream.ts:201-217). If the projection were captured under the
// lock, the lock released, compressed outside, and then emitted under a NEW
// sequence number, a live part/message delta that landed during compression
// would be OVERWRITTEN by the stale batch on the client. The per-session message
// revision (bumped by every message/part mutation + reconcile) is the staleness
// gate.
//
// Three-phase loop:
//  1. Under s.mu.Lock(): capture the reconciled ordered projection (copying the
//     escaping json.RawMessage bytes) + the current revision; release the lock.
//  2. Outside the lock: marshal {messages:[...]}, gzip, base64, envelope. (This
//     is the work that previously blocked all Apply ingestion for a large
//     transcript.)
//  3. Under s.mu.Lock() again: re-read the revision. If UNCHANGED, the captured
//     projection is still current → emit. If CHANGED, a live mutation (message/
//     part upsert/delete, a buffered part-delta append, or another reconcile)
//     landed during packaging → DISCARD the prepared payload and retry.
//
// Bounded retry with FAIL-SAFE: after maxColdBatchRetries capture/repackage
// cycles all detect a changed revision (a session changing so fast it never
// converges), the last resort repackages ONCE UNDER s.mu so the emitted batch is
// guaranteed current at emit time. This trades a single locked compression (the
// old behavior, for this rare case only) for correctness — it never emits
// knowingly-stale data and never gives up without delivering a valid batch.
//
// Returns a ColdBatchStatus so the caller can gate EmitMessagesLoaded: a loaded
// event is correct ONLY after ColdBatchEmitted (or a genuine warm reconcile
// handled by the caller, ColdBatchWarmReconcile). SessionGone / PackagingFailed
// MUST NOT trigger a loaded event (Finding 3).
func (s *Store) publishColdBatch(sid string) ColdBatchStatus {
	const maxColdBatchRetries = 8
	for attempt := 0; attempt < maxColdBatchRetries; attempt++ {
		s.mu.Lock()
		list, rev := s.captureMessagesBatchLocked(sid)
		s.mu.Unlock()

		// Test seam: block here so a test can race a same-session mutation in
		// the gap between capture and validation. Nil in production (zero cost).
		if coldBatchAfterCaptureHook != nil {
			coldBatchAfterCaptureHook(sid)
		}

		if list == nil {
			// No message state (e.g. an empty cold fetch, or the session was
			// deleted between reconcile and capture): nothing to emit. The
			// session is still marked loaded; the client renders an empty
			// transcript. (Matches the old emitMessagesBatchLocked no-op.) The
			// caller must NOT follow with messages.loaded when the session is
			// gone (Finding 3).
			return ColdBatchSessionGone
		}
		payload := packageMessagesBatch(sid, list)
		if payload == nil {
			// Marshal/gzip failed (already logged). Do not emit a malformed
			// batch; the client re-fetches on the next cold load.
			return ColdBatchPackagingFailed
		}

		s.mu.Lock()
		unchanged := s.msgRev[sid] == rev
		if unchanged {
			s.emit(KindMessagesBatch, payload)
			s.mu.Unlock()
			return ColdBatchEmitted // delivered a revision-VALID batch
		}
		s.mu.Unlock()
		// Revision changed during packaging → the captured projection is stale.
		// Discard the payload and retry from the current state (bounded by
		// maxColdBatchRetries, then the fail-safe locked repackage below).
	}
	// Pathological fast-changing session: retry never converged. FAIL SAFE by
	// repackaging ONCE under s.mu so the emitted batch is current at emit time
	// (reverting to the old locked-compression behavior for this rare case
	// rather than emitting knowingly-stale data or skipping the batch).
	s.mu.Lock()
	defer s.mu.Unlock()
	list, _ := s.captureMessagesBatchLocked(sid)
	if list == nil {
		return ColdBatchSessionGone
	}
	payload := packageMessagesBatch(sid, list)
	if payload == nil {
		return ColdBatchPackagingFailed
	}
	s.emit(KindMessagesBatch, payload)
	return ColdBatchEmitted
}

// IsMessagesLoaded reports whether a session's history has been fetched.
func (s *Store) IsMessagesLoaded(sid string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.msgLoaded[sid]
}

// SessionIDs returns all known (incl. archived) session ids.
func (s *Store) SessionIDs() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(s.sessions))
	for id := range s.sessions {
		out = append(out, id)
	}
	return out
}

// LoadedSessions returns the ids whose messages have been hydrated — the set to
// re-fetch on reconnect (instead of every session).
func (s *Store) LoadedSessions() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(s.msgLoaded))
	for id := range s.msgLoaded {
		out = append(out, id)
	}
	return out
}

// MarkColdFetchStart records that a full-history GET is in flight for the given
// session. Live events that arrive while the flag is set tag their entries
// (liveTouchedBody / liveTouchedParts) so the subsequent cold-load reconcile
// (SetSessionMessages) preserves the newer live body instead of clobbering it
// with the stale fetched one (C-F2). Called by BOTH aggregator cold-load paths
// before the GET — EnsureMessagesAsync (the async first-open path, a853677) and
// EnsureMessages (the synchronous GET /vh/snapshot path, bf88e7e) — each setting
// it after the IsMessagesLoaded early-return and before client.Messages. It is
// cleared on success by reconcileMessagesLocked after the cold merge completes,
// and on failure by ClearColdFetchActive in the winner's defer (no reconcile
// runs to clear it).
func (s *Store) MarkColdFetchStart(sessionID string) {
	s.mu.Lock()
	s.coldFetchActive[sessionID] = true
	s.mu.Unlock()
}

// ClearColdFetchActive removes the in-flight cold-fetch marker for a session.
// Called UNCONDITIONALLY in the winner's defer of BOTH cold-load paths
// (EnsureMessages and EnsureMessagesAsync): on GET failure it is the only clear
// (no reconcile runs to clear it), and on success it is idempotent — the
// cold-load reconcile (reconcileMessagesLocked) already cleared the marker
// inside SetSessionMessages. This keeps a transient gap event between a failed
// GET and its retry from being wrongly preserved by the next successful
// reconcile.
func (s *Store) ClearColdFetchActive(sessionID string) {
	s.mu.Lock()
	delete(s.coldFetchActive, sessionID)
	s.mu.Unlock()
}

// SetSessionMessages installs a freshly-fetched message list for one session
// (used by lazy hydration when a client first opens it). On the COLD path
// (session not previously loaded) it does NOT return until a revision-valid
// cold batch has been published.
//
// Returns a ColdBatchStatus the aggregator uses to gate EmitMessagesLoaded
// (Finding 3): Emitted means a valid messages.batch was published (caller SHOULD
// emit loaded); WarmReconcile means the session was already loaded and the
// incremental upsert/delete events were emitted inside reconcile (caller SHOULD
// emit loaded — the client needs the completion signal); SessionGone /
// PackagingFailed mean NO batch was published and the caller MUST NOT emit
// loaded (the session is gone or the batch failed — emitting loaded without a
// preceding batch would break the one-batch-before-loaded ordering, and
// emitting an empty batch to satisfy ordering would reintroduce state after
// session.delete).
func (s *Store) SetSessionMessages(sid string, list []MessageWithParts) ColdBatchStatus {
	s.mu.Lock()
	cold := s.reconcileMessagesLocked(sid, list)
	s.mu.Unlock()
	if cold {
		// marshal+gzip+base64 happens OUTSIDE s.mu; the per-session revision is
		// re-validated before emit so a stale batch is discarded + retried.
		return s.publishColdBatch(sid)
	}
	// Warm path: reconcileMessagesLocked already emitted the incremental
	// upsert/delete deltas under the lock. No wholesale batch is needed; the
	// caller should still emit messages.loaded (the client exits the loading
	// state on the loaded event, not on a batch — a warm reconnect may emit
	// zero deltas if nothing changed).
	return ColdBatchWarmReconcile
}

// SetLastAgents cold-seeds the agent name of each session's most recent
// assistant turn, fetched as a lightweight message tail by the aggregator during
// hydrate. This is what lets the tree render per-agent chips on a COLD snapshot
// (before any session's full message history is hydrated) — the tree-only
// snapshot carries no messages, so lastAgent can't be derived client-side until
// the session is opened. Re-seeding is memoized (ColdSeedNeeded/MarkColdSeeded):
// each cold session is tail-fetched at most once per aggregator lifetime, so
// reconnects skip already-seeded sessions. Once a session is opened (messages
// loaded), recomputeLastAssistantLocked overrides the seed authoritatively from
// the full history.
func (s *Store) SetLastAgents(agents map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for sid, agent := range agents {
		se := s.sessions[sid]
		if se == nil {
			continue
		}
		if se.lastAgent == agent {
			continue // idempotent: no change, no fanout
		}
		se.lastAgent = agent
		if agent == "" {
			continue // never broadcast an empty seed (nothing for the chip to show)
		}
		// Push the seeded label to already-connected clients as a live event:
		// the cold seed runs as a background goroutine that usually finishes
		// AFTER a client's first snapshot, so Snapshot.LastAgents would otherwise
		// not carry this label until the next reconnect. Mirrors how
		// setCurrentVerbLocked fans activity.verb out for a snapshot-only facet.
		s.emit(KindLastAgentSet, rawObj(map[string]interface{}{
			"sessionID": sid,
			"agent":     agent,
		}))
	}
}

// ColdSeedNeeded returns the subset of `ids` whose lastAgent has NOT yet been
// cold-seeded, limited to sessions currently tracked. The aggregator calls this
// on (re)connect to fetch a lightweight tail for only the un-seeded sessions
// instead of re-fetching every cold session every time. It is a read-only query
// (claim happens per-session in MarkColdSeeded after a successful fetch), so a
// fetch failure is not marked seeded and retries on the next reconnect — same
// graceful behavior as before this memo existed.
func (s *Store) ColdSeedNeeded(ids []string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if s.sessions[id] != nil && !s.seeded[id] {
			out = append(out, id)
		}
	}
	return out
}

// MarkColdSeeded records that a session's lastAgent has been cold-seeded, so
// subsequent reconnects skip re-fetching its tail. Only marks sessions that
// still exist: a delete that raced between the tail fetch and this call leaves
// seeded clean, so a recreated session is re-seeded. Caller passes one id at a
// time as each tail fetch succeeds (8-wide in the aggregator).
func (s *Store) MarkColdSeeded(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions[id] != nil {
		s.seeded[id] = true
	}
}

func removeString(xs []string, x string) []string {
	for i, v := range xs {
		if v == x {
			return append(xs[:i], xs[i+1:]...)
		}
	}
	return xs
}
