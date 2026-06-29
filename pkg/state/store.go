// Package state holds the daemon's materialized view of OpenCode session state
// and the monotonic, replayable event log that clients resume from.
//
// The store is schema-light: session/message/part payloads are kept as raw JSON
// and only the envelope fields needed for structure (ids, parentID) are parsed.
package state

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// Client-facing event kinds. The payload is the raw OpenCode payload, untouched.
const (
	KindSessionUpsert   = "session.upsert"
	KindSessionDelete   = "session.delete"
	KindMessageUpsert   = "message.upsert"
	KindMessageDelete   = "message.delete"
	KindPartUpsert      = "part.upsert"
	KindPartDelete      = "part.delete"
	KindTodo            = "todo"
	KindPermissionSet   = "permission.upsert"
	KindPermissionClear = "permission.delete"
	KindStatus          = "status"
	KindActivity        = "activity"
	KindQuestionSet     = "question.upsert"
	KindQuestionClear   = "question.delete"
	KindUnreadSet       = "unread.set"
	KindUnreadClear     = "unread.clear"
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
	Hydrated               bool   `json:"hydrated"`
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

	ring *ringBuffer
	subs map[int]chan ClientEvent
	next int
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
		epoch:       newEpoch(),
		sessions:    map[string]*sessionEntry{},
		messages:    map[string]*sessionMessages{},
		todos:       map[string]json.RawMessage{},
		perms:       map[string]map[string]json.RawMessage{},
		questions:   map[string]map[string]json.RawMessage{},
		permBlocked: map[string]bool{},
		statuses:    map[string]json.RawMessage{},
		activity:    map[string]string{},
		activitySeq: map[string]uint64{},
		unread:      map[string]bool{},
		busyCount:   map[string]int{},
		msgLoaded:   map[string]bool{},
		ring:        newRingBuffer(ringCapacity),
		subs:        map[int]chan ClientEvent{},
	}
}

// emit stamps, records, and fans out a client event. Caller must hold s.mu.
func (s *Store) emit(kind string, payload json.RawMessage) {
	s.seq++
	ev := ClientEvent{Seq: s.seq, Kind: kind, Payload: payload}
	s.ring.push(ev)
	for id, ch := range s.subs {
		select {
		case ch <- ev:
		default:
			// Slow consumer: drop it. The client will reconnect and re-snapshot.
			close(ch)
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
	// Fan out WITHOUT recording to the ring or advancing seq: a notice is a live
	// alert, not part of the replayable view. Reusing the current head seq keeps
	// resume cursors monotonic (no gap, no duplicate-advance).
	ev := ClientEvent{Seq: s.seq, Kind: KindNotice, Payload: payload}
	for id, ch := range s.subs {
		select {
		case ch <- ev:
		default:
			close(ch)
			delete(s.subs, id)
		}
	}
}

func rawObj(kv map[string]interface{}) json.RawMessage {
	b, _ := json.Marshal(kv)
	return b
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
	clear := func(sid string) {
		if !busy[sid] {
			s.setActivityLocked(sid, ActivityIdle)
		}
	}
	for sid := range s.sessions {
		clear(sid)
	}
	for sid := range s.messages {
		clear(sid)
	}
}

// Apply reduces a single live OpenCode event into the view and emits the
// corresponding client event(s).
func (s *Store) Apply(ev opencode.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()

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
	} else {
		sm.byID[env.ID] = &messageEntry{
			id: env.ID, info: info, parts: map[string]json.RawMessage{},
			role: env.Role, completed: env.Time.Completed != nil,
			finish: env.Finish, tokens: env.Tokens, agent: env.Agent,
		}
		sm.order = append(sm.order, env.ID)
	}
	s.emit(KindMessageUpsert, info)
	if env.Role == "assistant" {
		s.recomputeLastAssistantLocked(env.SessionID)
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
	s.emit(KindPartUpsert, part)
	// A part can finalize the latest assistant turn's text content (and parts may
	// arrive after the completed message.updated), so refresh the empty/finish
	// summary. Streaming deltas don't need this — the turn isn't completed yet, and
	// a part.updated snapshot follows them.
	s.recomputeLastAssistantLocked(env.SessionID)
}

// appendPartDeltaLocked applies a streaming text delta to a part (creating a
// minimal text part if the delta precedes its part.updated), then re-emits the
// part so clients render the accumulated text live. A later message.part.updated
// snapshot overwrites it authoritatively.
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
	existing, had := me.parts[partID]
	var part map[string]any
	if had {
		_ = json.Unmarshal(existing, &part)
	}
	if part == nil {
		part = map[string]any{"id": partID, "sessionID": sessionID, "messageID": messageID, "type": "text"}
	}
	if !had {
		me.partOrder = append(me.partOrder, partID)
	}
	prev, _ := part[field].(string)
	part[field] = prev + delta
	updated, err := json.Marshal(part)
	if err != nil {
		return
	}
	me.parts[partID] = updated
	s.emit(KindPartUpsert, updated)

	// Streaming deltas mean the turn is actively generating right now — assert
	// busy (cheap no-op once set). Cleared when the assistant message completes
	// (upsertMessageLocked) or on session.idle. This makes the running indicator
	// track real token flow even when OpenCode's session.status lags.
	if me.role != "user" {
		s.setActivityLocked(sessionID, ActivityBusy)
	}
}

func (s *Store) deletePartLocked(sessionID, messageID, partID string) {
	if sm := s.messages[sessionID]; sm != nil {
		if me := sm.byID[messageID]; me != nil {
			if _, ok := me.parts[partID]; ok {
				delete(me.parts, partID)
				me.partOrder = removeString(me.partOrder, partID)
			}
		}
	}
	s.emit(KindPartDelete, rawObj(map[string]interface{}{
		"sessionID": sessionID, "messageID": messageID, "partID": partID,
	}))
	s.recomputeLastAssistantLocked(sessionID)
}

// Snapshot returns the current view and the head seq. The session tree, todos,
// permissions, and statuses are always included (they are small); messages are
// included only for sessions in messagesFor. A nil messagesFor includes all
// sessions' messages; an empty (non-nil) map includes none — letting a phone
// fetch a tree-only snapshot and pull message history per session on demand.
func (s *Store) Snapshot(messagesFor map[string]bool) Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()

	snap := Snapshot{
		Epoch:       s.epoch,
		Seq:         s.seq,
		Messages:    map[string][]MessageWithParts{},
		Todos:       map[string]json.RawMessage{},
		Permissions: map[string][]json.RawMessage{},
		Questions:   map[string][]json.RawMessage{},
		Statuses:    map[string]json.RawMessage{},
		Activity:    map[string]string{},
		Gate:        map[string]GateFacts{},
		LastAgents:  map[string]string{},
	}
	// Per-session gate facts (denormalized; see GateFacts). subtree_busy needs a
	// tree walk, so compute it once here in O(n) and index per session.
	subtreeBusy := s.computeSubtreeBusyLocked()
	for sid, se := range s.sessions {
		act := s.activity[sid]
		if act == "" {
			act = ActivityIdle // a never-touched session renders idle
		}
		snap.Gate[sid] = GateFacts{
			Activity: act,
			// We have message state (live events OR a history hydrate) iff msgLoaded or
			// a messages entry exists. When false, the message-derived fields below are
			// "not yet known", which a cold/un-opened session after a restart can't be
			// distinguished from in-flight without this.
			Hydrated:               s.msgLoaded[sid] || s.messages[sid] != nil,
			LastAssistantCompleted: se.hasAssistant && se.lastAsstCompleted,
			LastAssistantEmpty:     se.lastAsstEmpty,
			FinishReason:           se.lastFinish,
			SubtreeBusy:            subtreeBusy[sid],
			PendingQuestion:        len(s.questions[sid]) > 0,
			PendingPermission:      len(s.perms[sid]) > 0,
			PermissionBlocked:      s.permBlocked[sid],
			Tokens:                 se.lastTokens,
		}
		if se.lastAgent != "" {
			snap.LastAgents[sid] = se.lastAgent
		}
	}
	for sid, m := range s.questions {
		for _, q := range m {
			snap.Questions[sid] = append(snap.Questions[sid], q)
		}
	}
	for sid, st := range s.activity {
		snap.Activity[sid] = st
	}
	for id := range s.unread {
		snap.Unread = append(snap.Unread, id)
	}
	for _, se := range s.sessions {
		snap.Sessions = append(snap.Sessions, se.info)
	}
	for sid, sm := range s.messages {
		if messagesFor != nil && !messagesFor[sid] {
			continue
		}
		list := make([]MessageWithParts, 0, len(sm.order))
		for _, mid := range sm.order {
			me := sm.byID[mid]
			if me == nil {
				continue
			}
			parts := make([]json.RawMessage, 0, len(me.partOrder))
			for _, pid := range me.partOrder {
				parts = append(parts, me.parts[pid])
			}
			list = append(list, MessageWithParts{Info: me.info, Parts: parts})
		}
		snap.Messages[sid] = list
	}
	for sid, t := range s.todos {
		snap.Todos[sid] = t
	}
	for sid, m := range s.perms {
		for _, perm := range m {
			snap.Permissions[sid] = append(snap.Permissions[sid], perm)
		}
	}
	for sid, st := range s.statuses {
		snap.Statuses[sid] = st
	}
	return snap
}

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

// Subscribe registers a new live-tail consumer. Returns the channel and an
// unsubscribe func. The channel is closed if the consumer falls too far behind.
func (s *Store) Subscribe(buffer int) (<-chan ClientEvent, func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.next
	s.next++
	ch := make(chan ClientEvent, buffer)
	s.subs[id] = ch
	return ch, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if c, ok := s.subs[id]; ok {
			close(c)
			delete(s.subs, id)
		}
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
func (s *Store) Hydrate(sessions []json.RawMessage, messages map[string][]MessageWithParts) {
	s.mu.Lock()
	defer s.mu.Unlock()

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
	// reconnect, instead of every session) ---
	for sid, list := range messages {
		s.reconcileMessagesLocked(sid, list)
	}
}

// reconcileMessagesLocked diffs one session's full message list into the store,
// emitting upsert/delete events for changes, and marks the session's messages
// as loaded. Caller must hold s.mu.
func (s *Store) reconcileMessagesLocked(sid string, list []MessageWithParts) {
	s.msgLoaded[sid] = true
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
			s.emit(KindMessageUpsert, mwp.Info)
		} else if !bytes.Equal(me.info, mwp.Info) {
			me.info = mwp.Info
			s.emit(KindMessageUpsert, mwp.Info)
		}
		me.role = env.Role
		me.completed = env.Time.Completed != nil
		me.finish = env.Finish
		me.tokens = env.Tokens
		me.agent = env.Agent

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
				s.emit(KindPartUpsert, part)
			} else if !bytes.Equal(old, part) {
				me.parts[pe.ID] = part
				s.emit(KindPartUpsert, part)
			}
		}
		for pid := range me.parts {
			if !seenPart[pid] {
				delete(me.parts, pid)
				me.partOrder = removeString(me.partOrder, pid)
				s.emit(KindPartDelete, rawObj(map[string]interface{}{
					"sessionID": sid, "messageID": env.ID, "partID": pid,
				}))
			}
		}
	}
	for mid := range sm.byID {
		if !seenMsg[mid] {
			delete(sm.byID, mid)
			sm.order = removeString(sm.order, mid)
			s.emit(KindMessageDelete, rawObj(map[string]interface{}{
				"sessionID": sid, "messageID": mid,
			}))
		}
	}
	s.recomputeLastAssistantLocked(sid)
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

// SetSessionMessages installs a freshly-fetched message list for one session
// (used by lazy hydration when a client first opens it).
func (s *Store) SetSessionMessages(sid string, list []MessageWithParts) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reconcileMessagesLocked(sid, list)
}

// SetLastAgents cold-seeds the agent name of each session's most recent
// assistant turn, fetched as a lightweight message tail by the aggregator during
// hydrate. This is what lets the tree render per-agent chips on a COLD snapshot
// (before any session's full message history is hydrated) — the tree-only
// snapshot carries no messages, so lastAgent can't be derived client-side until
// the session is opened. Re-seeding on each reconnect is idempotent. Once a
// session is opened (messages loaded), recomputeLastAssistantLocked overrides
// the seed authoritatively from the full history.
func (s *Store) SetLastAgents(agents map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for sid, agent := range agents {
		if se := s.sessions[sid]; se != nil {
			se.lastAgent = agent
		}
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
