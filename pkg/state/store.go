// Package state holds the daemon's materialized view of OpenCode session state
// and the monotonic, replayable event log that clients resume from.
//
// The store is schema-light: session/message/part payloads are kept as raw JSON
// and only the envelope fields needed for structure (ids, parentID) are parsed.
package state

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
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
	// KindPermissionBlocked records the FIRST observable false→true transition
	// of a session's automated-spawn permission auto-rejection (MarkPermissionBlocked).
	// It is a sticky historical fact (NOT the pending-request lifecycle that
	// KindPermissionSet / KindPermissionClear carry) — it survives a permission
	// clearing and is cleared only on session termination (deleteSessionLocked →
	// KindSessionDelete). At most once per session lifetime. Idempotent: an
	// already-blocked session emits nothing on a repeat MarkPermissionBlocked.
	// Payload {sessionID, permissionWasBlocked:true}. NOT prefixed message./part.
	// so the server publishes it as a replayable event on the tree-only Stream 1
	// and advances the snapshot sequence. CURRENT WEB CLIENTS DO NOT CONSUME IT
	// INCREMENTALLY: permission.blocked is absent from the web layer's
	// TREE_STREAM_KINDS and has no reducer case, so an already-connected SPA never
	// applies the live frame. They converge the permission-blocked state from
	// snapshot / reconnect data instead — GateFacts.PermissionWasBlocked carries
	// the flag, so a client that connected before the transition and one that
	// connected after compose correctly. Wiring the live web consumer is deferred
	// to the L-08 track.
	KindPermissionBlocked = "permission.blocked"
	// KindNotice carries a daemon-detected alert (turn finished, waiting on a
	// human, stuck/runaway/stalled) for in-app delivery. It is NOT part of the
	// materialized view — it's a transient fan-out, not stored in any snapshot —
	// so a resuming client only sees notices emitted after it connects.
	KindNotice = "notice"
	// KindTreeOrphanCheck is a server-internal event (Phase 2 §9) emitted when a
	// session's root archive status may have changed — on delete reparenting
	// (deleteSessionLocked re-roots children → their chain root changed) or on
	// archive/un-archive. The tree emitter translates it to a
	// node.facet{flags:{orphan}} for each known node whose orphan status
	// changed. Payload {"id":id}. NOT prefixed session./message./part. so the
	// web layer's sendable() always-streams it on the tree-only Stream 1.
	KindTreeOrphanCheck = "tree.orphan"
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
	Epoch    string                        `json:"epoch"`
	Seq      uint64                        `json:"seq"`
	Sessions []json.RawMessage             `json:"sessions"`
	Messages map[string][]MessageWithParts `json:"messages"`
	// MessageWindows carries the per-session bounded-window metadata for every
	// session in Messages. A client reads has_older / count / limits WITHOUT
	// decoding the message array, so it can render a "Load older" affordance
	// and reason about completeness from the cold snapshot alone. Keyed by
	// sessionID; omitted entirely when no sessions carry messages (tree-only).
	MessageWindows map[string]WindowMeta        `json:"messageWindows,omitempty"`
	Todos          map[string]json.RawMessage   `json:"todos,omitempty"`
	Permissions    map[string][]json.RawMessage `json:"permissions,omitempty"`
	Questions      map[string][]json.RawMessage `json:"questions,omitempty"`
	Statuses       map[string]json.RawMessage   `json:"statuses,omitempty"`
	Activity       map[string]string            `json:"activity,omitempty"`
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
	// Partial, when non-nil, marks this snapshot as a PARTIAL tree-Stream-1
	// detail frame: only the session IDs in Partial.Scope carry
	// sessions/activity/gate/lastAgents/currentVerbs (frontier-scoped → the
	// client MERGES these and must NOT delete buried detail absent from scope);
	// the global maps (questions/permissions/unread) are authoritative-complete
	// (the client REPLACES them); todos/statuses are omitted. Every other caller
	// (the full Snapshot(), /vh/snapshot, coordapi, MCP) leaves Partial nil so the
	// legacy wholesale-replace apply path runs unchanged. See PartialMeta.
	Partial *PartialMeta `json:"partial,omitempty"`
}

// PartialMeta is the wire metadata a tree-Stream-1 partial detail frame carries
// so the client picks the scoped installer (D3) instead of the wholesale
// projectSnapshot path. Partiality is tree-Stream-1-only (D7): the handleStream
// tree=2 cold/reconnect/ring-gap paths set it; every non-SPA consumer stays full.
type PartialMeta struct {
	// Mode is the partial-frame discriminator. Today only "tree-stream-1-frontier".
	// A client that does not recognize the mode MUST fall back to wholesale apply
	// (defensive: an unknown partial mode is treated as a full snapshot).
	Mode string `json:"mode"`
	// Scope is the EXACT set of session IDs whose per-session detail
	// (sessions/activity/gate/lastAgents/currentVerbs) is included. A client
	// merges these by id and preserves detail for ids NOT in scope (buried
	// frontier detail is never deleted by a partial frame).
	Scope []string `json:"scope"`
	// Authority tags each carried map with one of:
	//   "global"  — authoritative-complete; the client REPLACES its whole map
	//                (questions, permissions, unread).
	//   "frontier"— scoped to Scope; the client MERGES (only Scope ids), never
	//                deleting ids outside Scope (sessions, activity, gate,
	//                lastAgents, currentVerbs).
	//   "omitted" — not carried in this frame; the client MUST NOT touch its
	//                existing map (todos, statuses).
	// A map absent from Authority is treated as "omitted".
	Authority map[string]string `json:"authority"`
	// RingGap is set ONLY on a same-epoch reconnect whose cursor the shared replay
	// ring evicted (hasCursor && !replayOK). The missed deltas that would have
	// updated buried detail were lost, so the client must MECHANICALLY invalidate
	// retained frontier-mergeable detail (sessions/gate/activity/lastAgents/
	// currentVerbs) for ids NOT in Scope — the set is "everything retained minus
	// what this frame covers", NOT inferred from omission (too-narrow = stale
	// detail persists; the broad clear is the safe mechanical choice because the
	// ring consumed the per-id change evidence). Global Q/P/unread are
	// authoritative-replaced regardless. A replay-OK reconnect (deltas applied)
	// and a fresh (no-cursor) connect leave this false — no invalidation.
	RingGap bool `json:"ringGap,omitempty"`
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
	// HasMessages is the alias of Hydrated (Posture B alias-during-transition).
	// It carries the SAME value and is the more honest name for the fact Hydrated
	// actually reports: "some message state exists" (a live tail OR a history
	// hydrate) — it does NOT mean "fully loaded" (that is MessagesLoaded, a
	// separate field that stays unchanged). Dual-emitted alongside hydrated so
	// the SPA can migrate to the exact name while a stale/un-reloaded tab keeps
	// reading the old one. Removal of `hydrated` is gated on an operator-approved
	// cutoff; see docs/ai/wire-field-deprecation.md (audit L-03 / remediation M3).
	HasMessages bool `json:"hasMessages"`
	// MessagesLoaded reports whether this session's FULL message history has
	// been fetched AND the resident parts are consistent with a completed
	// assistant turn (msgLoaded && resident parts) — NOT "do we have any
	// message state at all". The resident-parts conjunct is the S5 contract
	// fix: it can NEVER be true when the newest completed assistant has zero
	// resident parts (the signature of unfetched/lost parts). See
	// IsMessagesLoaded / latestAssistantResidentLocked. It is the gate-side
	// counterpart of the lazy-async hydration completion (the messages.loaded
	// event / EnsureMessagesAsync).
	//
	// Distinct from Hydrated (above), which is "we have message state (live
	// events OR a history hydrate)" and conflates partial-exists with
	// fully-loaded: a session that received live message.* events has
	// messages[sid]!=nil → Hydrated=true but MessagesLoaded=false (the tail of
	// live deltas is NOT the full ordered history). A client must base its
	// "deliver the transcript / stop showing the loading state" decision on
	// MessagesLoaded, not Hydrated.
	//
	// NAMING: this Go field serializes to JSON `"messagesLoaded"` and is
	// preserved as-is on the wire. The FE client-side state map that mirrors it
	// per connected client was renamed to SyncState.messagesDelivered (commit
	// 87784ab) to distinguish client-DELIVERED state from the wire gate fact.
	// The two are intentionally DISTINCT names now:
	//   - server gate GateFacts.MessagesLoaded = "the daemon fetched this
	//     session's full history AND the resident parts are consistent" (the
	//     msgLoaded memo AND latestAssistantResidentLocked, so it can never
	//     report loaded with zero parts on a completed message).
	//   - FE SyncState.messagesDelivered[id] = "Stream 2 has DELIVERED the real
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
	PermissionBlocked bool `json:"permission_blocked"`
	// PermissionWasBlocked is the alias of PermissionBlocked (Posture B
	// alias-during-transition). It carries the SAME value and is the more exact
	// name for the sticky historical fact ("permission blocking occurred
	// historically") rather than a bare current auto-reject state. Dual-emitted
	// alongside permission_blocked so non-SPA consumers (coordapi/MCP/headless)
	// keep working while new readers adopt the exact name. Removal of
	// `permission_blocked` is gated on an operator-approved cutoff; see
	// docs/ai/wire-field-deprecation.md (audit L-09 / remediation M12).
	PermissionWasBlocked bool            `json:"permissionWasBlocked"`
	Tokens               json.RawMessage `json:"tokens,omitempty"` // raw token-usage object of the latest assistant turn (meaningful iff hydrated)
}

// MessageWithParts mirrors OpenCode's GET /session/:id/message item shape.
type MessageWithParts struct {
	Info  json.RawMessage   `json:"info"`
	Parts []json.RawMessage `json:"parts"`
}

// WindowMeta describes a bounded message-window projection: the metadata that
// travels ALONGSIDE a bounded []MessageWithParts so a client knows whether the
// window is complete, whether older messages exist beyond it, and WHY the
// projection stopped. Distinct from the message array itself: the client reads
// has_older / count / limits WITHOUT decoding the (potentially gzip+base64)
// messages payload.
//
// Fields are designed for the transcript-windowing protocol (Phase 1+):
//   - The initial cold-load window (Snapshot messages + cold messages.batch)
//     carries this so the client renders a "Load older" affordance when
//     has_older is set, and so it never assumes the window == the whole
//     transcript.
//   - oversized_item is the diagnostic case: when even the single newest
//     message exceeds the byte budget, the projector returns it ALONE (always
//     include at least one) and signals the overflow so a client can explain
//     the single-item window without a freeze or a silent gap.
type WindowMeta struct {
	// OldestLoadedID is the message id of the OLDEST message in the window.
	// Empty when the window is empty. The client uses this as the `?before=`
	// cursor for the next historical page fetch.
	OldestLoadedID string `json:"oldest_loaded_id,omitempty"`
	// HasOlder is true when older messages exist beyond this window (the
	// projection stopped before exhausting the ordered list). This is the
	// "show a Load-older affordance" bit. False means the window IS the whole
	// transcript.
	HasOlder bool `json:"has_older"`
	// MessageCount is the number of messages in the window (len of the
	// accompanying message array).
	MessageCount int `json:"message_count"`
	// SerializedBytes is the sum of len(Info)+sum(len(Parts)) across the
	// window — the raw wire payload size. A client uses this to reason about
	// memory pressure and to decide whether to evict far pages.
	SerializedBytes int `json:"serialized_bytes"`
	// CountLimited is true when the projection stopped because it hit the
	// message-count budget (more messages existed within the byte budget).
	CountLimited bool `json:"count_limited"`
	// BytesLimited is true when the projection stopped because adding the next
	// message would have exceeded the byte budget.
	BytesLimited bool `json:"bytes_limited"`
	// OversizedItem, ActualBytes, BudgetBytes are set ONLY in the oversized
	// case: the single newest message alone exceeds the byte budget. The
	// projector returns it alone (always include at least one) + these
	// diagnostics. A client renders the item but flags that the window could
	// not include any neighbors.
	OversizedItem bool `json:"oversized_item,omitempty"`
	ActualBytes   int  `json:"actual_bytes,omitempty"`
	BudgetBytes   int  `json:"budget_bytes,omitempty"`
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
	// orphan is the Defect-3 backstop flag, set by sweepOrphansLocked when the
	// session's parentID chain terminates at a parent that is ABSENT from the
	// live store but PRESENT in the authoritative archived snapshot
	// (Store.archivedSnapshot). It is the durable, cross-restart signal that a
	// straggler's ancestor was archived — distinct from isOrphanLocked (the
	// emit-time computation in tree_emitter.go, which Slice 2 widens to consult
	// the same snapshot). A chain that terminates at a LIVE root or an
	// UNRESOLVABLE parent is NEVER flagged (e88f19e false-positive gate). The
	// sweep is idempotent and re-evaluates every live session each run, so a
	// parent that un-archives (leaves the snapshot) clears the child's flag on
	// the next sweep. Defaults to false (zero value) on entry creation; the
	// sweep is the sole writer.
	orphan bool
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
	// terminalError caches the opencode `info.error.name` for a COMPLETED
	// assistant turn that ended terminally (e.g. an abort — the confirmed shape
	// "MessageAbortedError"). The messages-loaded gate uses it as a POSITIVE
	// terminal classification: a zero-parts completed assistant carrying a
	// recognized terminal error produced no output, so zero resident parts is
	// source truth and the turn is admitted as loaded on the FIRST reconcile —
	// WITHOUT the two-empty confirmation re-fetch the non-aborted zero-parts
	// case needs (see isTerminalError / latestAssistantResidentLocked /
	// reconcileMessagesLocked). Empty for normal turns. Set from
	// messageInfoEnvelope.errorName() in BOTH reconcileMessagesLocked (history
	// fetch) and upsertMessageLocked (live message.updated), alongside
	// finish/tokens/agent; cleared implicitly when the entry is dropped
	// (message/part removal or session delete drop the whole messageEntry).
	terminalError string
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
	// sealedFields tracks (partID+"\x00"+field) entries whose accumulated text
	// has crossed partTextCap and been truncated. Once sealed, further streaming
	// deltas to that (partID, field) are DROPPED — the part is "frozen" at the
	// cap with the truncation marker. Cleared alongside deltaBuf (a fresh
	// authoritative snapshot or a reconcile reseeds the accumulator from a new
	// base, re-evaluating the cap).
	sealedFields map[string]bool
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
	// on a warm resync (coldLoad==false), where the fetched list is
	// authoritative ONLY for PRESENT message/part bodies (overwrite/merge) —
	// absence never deletes (Option A; see reconcileMessagesLocked). Cleared
	// after each cold reconcile.
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
	// historyExhausted is true once a backward older-page fetch (Part B
	// EnsureOlderMessages) reached the session's oldest message
	// (X-Next-Cursor == ""). Until then false → projectMessagePage's HasOlder
	// stays truthful even when the resident walk hits the resident floor (older
	// history may exist in opencode beyond the bounded cold-load tail).
	// Reset to false implicitly when a fresh sessionMessages is created (cold
	// load / reconnect) — the bounded tail never proves exhaustion.
	historyExhausted bool
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
		Created   *float64 `json:"created"`
	} `json:"time"`
	// Assistant-turn facts surfaced for the gate (A2). `finish` is opencode's
	// raw completion reason; `tokens` the raw usage object.
	Finish string          `json:"finish"`
	Tokens json.RawMessage `json:"tokens"`
	// Agent is opencode's `info.agent` (the agent that produced an assistant
	// message). Cached here so the denormalized lastAgent on the session entry can
	// be set without re-parsing info.
	Agent string `json:"agent"`
	// Error is opencode's `info.error`, present iff the turn ended terminally
	// (e.g. an abort). Carries the structured error opencode attached —
	// notably `name` (e.g. "MessageAbortedError"). Cached so the messages-
	// loaded gate can classify a zero-parts COMPLETED assistant as a
	// positively-terminal turn (it produced no output) and admit it on the
	// FIRST reconcile without a re-fetch. Absent (nil) on older or non-error
	// responses — backward-compatible, since older structs simply omit the
	// field. Data is kept raw (vh-solara reports, never interprets).
	Error *messageErrorEnvelope `json:"error,omitempty"`
}

// messageErrorEnvelope mirrors opencode's `info.error` shape: a named error
// (e.g. "MessageAbortedError") with an opaque data payload. Only Name is
// interpreted by the gate (terminal-error classification); Data is preserved
// raw for reporting.
type messageErrorEnvelope struct {
	Name string          `json:"name"`
	Data json.RawMessage `json:"data"`
}

// errorName returns the opencode `info.error.name` for this envelope, or "" when
// the turn carries no terminal error (env.Error == nil). Used to populate
// messageEntry.terminalError from BOTH the history-fetch reconcile
// (reconcileMessagesLocked) and the live message.updated path
// (upsertMessageLocked), alongside finish/tokens/agent.
func (e *messageInfoEnvelope) errorName() string {
	if e.Error != nil {
		return e.Error.Name
	}
	return ""
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
	// Finished-unread tracking. The per-root busy aggregate is derived from the
	// incremental subtreeBusyCount index (single source of truth — see
	// RunningRoots); when a root's subtree goes fully idle the root is marked
	// unread (a finished task awaiting acknowledgement). The finished mark is
	// governed by an EXPLICIT per-transition markOnIdle policy threaded into
	// setActivityAtLocked (M9/L-16): ordinary completions mark, status-reconcile
	// does not — replacing the retired ambient Store.suppressUnread flag. The
	// mark/clear is driven from setActivityAtLocked (the busy↔non-busy
	// chokepoint), reading subtreeBusyCount[root] before/after the delta, and
	// targets `root` (root-scoped reach is by design — audit L-13). (The legacy
	// root-keyed busyCount was RETIRED: it had asymmetric maintenance — a
	// reparent gap and a phantom-status gap — that let RunningRoots diverge from
	// per-session activity and report a phantom running root. subtreeBusyCount
	// has neither gap.)
	unread map[string]bool
	// Completion-grace window + completion-authority guard (Lane A fix for the
	// stale "1 running" strand). When an assistant turn COMPLETES without a
	// timely session.idle, the root's busy aggregate (subtreeBusyCount[root])
	// would strand at 1 until the ~60s /session/status reconcile clears it —
	// and if /session/status itself is stale (reports busy) the strand is
	// permanent. The grace window is the fast clearer; completionAuthoritative
	// is the permanent guard.
	//
	// graceTimers[sid] holds the pending completion-grace timer for sid (absent
	// when none is armed). It fires after completionGrace, deferring the idle
	// clear past a multi-step turn's inter-step gap so we do NOT dip the spinner
	// or fire a spurious "finished" between steps (the upsertMessageLocked
	// comment constraint). graceGen[sid] is bumped on every grace-canceling
	// event (new inflight, session.idle, delete, hydrate) so a timer callback
	// that races a cancel detects the supersede and aborts — time.Timer.Stop
	// does not guarantee the callback will not run once started.
	graceTimers map[string]*time.Timer
	graceGen    map[string]uint64
	// completionAuthoritative[sid] is set when the turn is AUTHORITATIVELY
	// over: the grace window fired OR session.idle was observed. While set, a
	// stale busy from /session/status (the HTTP poll) must NOT re-escalate the
	// session — message.updated{completed} wins over a stale status snapshot.
	// Cleared when a NEW assistant message goes inflight (a new turn started).
	completionAuthoritative map[string]bool
	// completionGrace is the grace-window duration (default 5s via
	// defaultCompletionGrace; shrunk in tests). Set on the Store instance in New
	// so a test can shrink s.completionGrace without a global-mutation race.
	// It is ALSO the settle-window for the P7 stop-settle timer (turn_state.go):
	// the same "missed session.idle" fallback, reused for the abort case.
	completionGrace time.Duration
	// P7 turn-boundary state machine (turn_state.go). turnState[sid] is the
	// authoritative turn-boundary state (idle|running|stopping), distinct from
	// the activity map (the UI spinner indicator). abortSettling[sid] is the
	// fail-closed gate (a session-scoped abort is settling — a new turn's caller
	// must await it). stopTurnID[sid] is the stopping payload's
	// pendingCancellationTurnID. stopTimers[sid] / stopGen[sid] are the settle
	// timer + its supersede counter (mirroring graceTimers / graceGen) — OpenCode
	// does not emit session.idle on abort, so the terminal that opens the gate
	// may never arrive; the timer force-opens it after completionGrace.
	turnState     map[string]TurnState
	abortSettling map[string]bool
	stopTurnID    map[string]string
	stopTimers    map[string]*time.Timer
	stopGen       map[string]uint64
	// abortWaitCh carries a per-session one-shot notification channel closed when
	// the abort gate opens (abortSettling → false), waking any /vh/send
	// consumer blocked in WaitAbortSettling. Created when Stop closes the gate;
	// closed+deleted at every gate-opening site (terminal, settle timer,
	// authoritative new turn, reconcile clear, session delete). Managed via
	// setAbortSettlingLocked so no open-site misses a wake-up.
	abortWaitCh map[string]chan struct{}
	// liveIdleObserved distinguishes OBSERVED terminals (session.idle,
	// session.error) from an INFERRED one (graceFire). The #2696 guard
	// (upsertMessageLocked) blocks on observed terminals only.
	//
	// Principle (Deviation 1 of the P7 slice): never BLOCK a turn on an
	// inference — an inferred terminal that is wrong suppresses real work.
	// graceFire is an inference; a subsequent inflight after graceFire is a
	// genuine new turn, not the #2696 trap (OpenCode stamping its fs-snapshot
	// diff onto the user message AFTER the turn went idle). This is the same
	// observed-vs-inferred line that runs through every correctness lesson in
	// this repo.
	//
	// Mechanically: set by a live session.idle OR session.error event (both
	// OBSERVED terminals), NOT by graceFire (an INFERENCE of completion); distinct from
	// completionAuthoritative (set by BOTH session.idle and graceFire, used for
	// the stale-busy guard). Cleared by an authoritative new turn
	// (markTurnRunningLocked). See upsertMessageLocked.
	liveIdleObserved map[string]bool
	// translator is the SINGLE VERSIONED boundary at which raw opencode.Event
	// wire-JSON is parsed into a NormalizedEvent for Apply (slice #3 — the
	// contract/translator rewire). Defaults to TranslatorV1 (the current
	// opencode event shape); a future shape is a translator swap, not a 16th
	// Apply switch arm. See translate.go.
	translator Translator
	// deltaFlushInterval is the per-instance throttle window for streaming
	// part-delta flushes (Option C / P1-AGG-004). Promoted off the package
	// global so tests shrink the instance under test rather than the shared
	// global (mirrors completionGrace); under -race a global shrink can race
	// a lingering callback from a prior -count iteration that still reads it.
	deltaFlushInterval time.Duration
	// partTextCap is the per-instance accumulated-text cap for a single part
	// field (P1-AGG-006). Promoted off the package global for the same race
	// reason as deltaFlushInterval.
	partTextCap int
	// windowMaxCount / windowMaxBytes are the per-instance dual bound for the
	// initial message-window projection. Promoted off the EXPORTED package
	// globals (which pkg/web still reads as the canonical ?limit=/?max_bytes=
	// clamp ceiling — distinct concern, no per-instance mutation in prod) so
	// tests shrink the instance, not the shared global.
	windowMaxCount int
	windowMaxBytes int
	// recentArchiveTTL is the per-instance tombstone TTL for RemoveSessions.
	// Promoted off the package global for the same race reason as
	// deltaFlushInterval.
	recentArchiveTTL time.Duration
	// recentBucketRetentionMinutes is the per-instance bound on the number of
	// minute-buckets retained in s.recentBucket (memory-bounded; generous vs the
	// default 10-min projection cutoff in Phase 6). Promoted off the former
	// package-global var (audit L-15 / remediation M6): the hot-path reader
	// evictRecentBucketsLocked now reads this instance field under s.mu instead
	// of an unsynchronized package var, so a -race run cannot observe a global
	// mutation racing a lingering goroutine — mirroring the GAP-S5 promotion
	// applied to the other tunables. Set once at construction from Config.
	recentBucketRetentionMinutes int
	// subtreeBusyCount is the INCREMENTAL per-node busy aggregate and the SINGLE
	// SOURCE OF TRUTH for the per-root running count (Store.RunningRoots derives
	// from it). subtreeBusyCount[id] = the number of busy/retry sessions in id's
	// subtree, INCLUDING id itself when it is busy/retry. It is the count
	// generalization of computeSubtreeBusyLocked's per-node bool (bool
	// = count > 0); maintaining the stricter count invariant proves the
	// incremental-index pattern for the remaining 7 collapsed-frontier indexes.
	//
	// Maintained incrementally at every mutation site that can change it —
	// setActivityLocked (busy-state chokepoint, which also derives the
	// finished-unread trigger from this index), upsertSessionLocked +
	// Hydrate's direct assign (create/reparent), deleteSessionLocked (delete) —
	// so a Snapshot/SendableNow / RunningRoots read is O(1) per node instead of
	// an O(n) computeSubtreeBusyLocked recompute. This index is the SOLE
	// production authority for subtree-busy: the snapshot capture, the gate
	// wire value, and SendableNow all read subtreeBusyCount[id] > 0 (the M1
	// collapse retired the dual authority). It is proven equivalent to the
	// former O(n) recompute by TestSubtreeBusyCountProperty (random-mutation
	// differential vs an independent O(n) recompute), and TestBusyEquivalence_*
	// pins that RunningRoots (derived from it) agrees with per-session activity
	// across every terminal transition. Entries exist ONLY for live sessions
	// (sessions in s.sessions); phantom status events for unknown sessionIDs do
	// NOT create entries, matching computeSubtreeBusyLocked's iteration over
	// s.sessions. Guarded by s.mu.
	subtreeBusyCount map[string]int
	// Phase 1 (Gate C extension): the remaining 7 incremental subtree indexes
	// the collapsed-frontier projection (O1) reads to build roots + active
	// closure + frontier stubs in O(|roots|+|closure|×depth+|frontier|) instead
	// of O(n). The snapshot path (Snapshot / SendableNow) reads subtreeBusyCount
	// and these indexes directly — they are the production authority (the M1
	// collapse retired the dual authority), proven equivalent to an independent
	// O(n) recompute by TestSubtreeIndexesProperty.
	// See subtree_indexes.go for the per-index invariants + maintenance sites.
	//
	// Topology: children[parentID] = ordered live direct-child ids; children[""]
	// is kept in sync with rootIDs (both list the live roots). rootIDs is the
	// ordered list of live roots (orphan-inclusive: a child whose parentID
	// points at a deleted id is effectively a root, per effectiveParentOfLocked
	// / rootOfLocked). subtreeDescendantCount[id] = number of live nodes in
	// id's subtree including id itself (stub wire field "descendantCount").
	// subtreeRetryCount / subtreePendingInput[id] = the count of retry /
	// pending-input sessions in id's subtree incl id (sum-class aggregates, same
	// shape as subtreeBusyCount). subtreePendingInput is maintained by the
	// EXCLUSIVE-OWNER helper family in subtree_indexes.go (setPermissionLocked
	// / clearPermissionLocked / setQuestionLocked / clearQuestionLocked) which
	// captures wasPending itself, so no per-session old-self shadow is kept
	// (remediation M2 / audit L-06 retired the former pendingInputSelf field).
	children               map[string][]string // parentID→ordered child ids; ""=roots (in sync with rootIDs)
	rootIDs                []string            // ordered live roots (orphans included)
	subtreeRetryCount      map[string]int
	subtreePendingInput    map[string]int
	subtreeDescendantCount map[string]int // live nodes in subtree incl self
	// MAX class — subtreeNewestActivity. lastActivityAt[id] = id's own last
	// real activity time (zero = never; bumped ONLY in setActivityLocked on a
	// real transition, NOT on create — a newly-created session has zero activity
	// time and collapses as a frontier stub until its first activity change).
	// subtreeNewestActivity[id] = MAX(lastActivityAt[id], MAX over live children
	// of subtreeNewestActivity[child]). Zero when no node in the subtree has
	// ever recorded activity. Drives the projection's "recent" cutoff window.
	lastActivityAt        map[string]time.Time
	subtreeNewestActivity map[string]time.Time
	// BUCKET class — recentBucket. A session lives in at most ONE minute bucket
	// (Unix/60) — the one for its last-activity minute. recentBucketKeys is the
	// sorted ascending list of bucket minutes, so the projection's cutoff
	// window walk is O(buckets-in-window). s.recentBucketRetentionMinutes (the
	// instance field above) bounds the number of buckets retained
	// (memory-bounded; generous vs the default 10-min projection cutoff in
	// Phase 6).
	recentBucket     map[int64][]string // unix-minute → session ids
	recentBucketKeys []int64            // sorted ascending bucket minutes
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
	// pendingEmptyNewest / confirmedEmptyNewest distinguish a newest COMPLETED
	// assistant message with zero resident parts that is SOURCE TRUTH (the
	// server genuinely has no parts for that turn — e.g. a finished turn whose
	// only output was consumed/dropped upstream) from a TRANSIENT GAP (a
	// schema-drift cold load that returned an envelope-only message while the
	// opencode DB actually has its parts, or a live race where a newer
	// assistant turn completed via message.upsert after the fetch but its
	// parts — which arrive via separate part.append events — have not streamed
	// yet). The resident-parts gate added in 3b3860e forces a re-fetch for ANY
	// zero-parts newest completed assistant to recover the schema-drift parts,
	// but a single fetch returning zero parts is AMBIGUOUS: it cannot tell a
	// lying cold load from a faithful one. Only a SECOND authoritative
	// reconcile observing the SAME empty newest id confirms source truth — the
	// schema-drift shape instead resolves via the len(parts)>0 branch once the
	// re-fetch serves the real parts. Tracking is therefore two-stage:
	//   - pendingEmptyNewest[sid]   = newest-completed-assistant id seen empty
	//                                 in the MOST RECENT reconcile (awaiting
	//                                 confirmation); and
	//   - confirmedEmptyNewest[sid] = that same id once a SECOND reconcile
	//                                 observed it empty again (source truth).
	// Both are set inside reconcileMessagesLocked (under s.mu — no new lock)
	// and read by latestAssistantResidentLocked, which admits a zero-parts
	// newest only when its id equals confirmedEmptyNewest[sid]. The aggregator
	// (EnsureMessages / EnsureMessagesAsync) performs ONE bounded
	// disambiguating re-fetch when a fetch leaves the session not-loaded
	// specifically because of an unconfirmed empty newest, so the
	// schema-drift↔source-truth distinction resolves within a single open
	// (neither loops forever on a genuinely-empty turn nor silently serves a
	// lying cold load). Cleared on session delete so a recreated id re-confirms.
	// Mirrors the 3b3860e derivation (itself in the spirit of the busyCount
	// retirement c4c4ef1: derive from source, not a cached flag).
	pendingEmptyNewest   map[string]string // sid → empty newest-completed-assistant id seen in the most recent reconcile (awaiting confirmation)
	confirmedEmptyNewest map[string]string // sid → empty newest-completed-assistant id confirmed by ≥2 reconciles (source truth)
	// seeded marks sessions whose lastAgent has already been cold-seeded by the
	// aggregator (via a lightweight message-tail fetch during hydrate). It makes
	// the cold-seed fire-once-per-session for the aggregator's lifetime instead
	// of on every (re)connect: a seeded session is skipped until it is removed.
	// Cleared in deleteSessionLocked, so a removed-then-recreated session is
	// re-seeded. Distinct from msgLoaded: opening a session (msgLoaded) derives
	// lastAgent authoritatively from the full history; seeded only suppresses
	// the lightweight tail re-fetch for un-opened sessions.
	seeded map[string]bool
	// recentlyArchived is the short-TTL tombstone set by RemoveSessions (the
	// archive path). It prevents a stale session.updated / session.compacted
	// arriving with archived=null (because OpenCode rewrote the record from a
	// pre-PATCH snapshot on a busy/compacting descendant) from RESURRECTING an
	// archived session back into the live tree. Guarded by s.mu; lazily
	// GC'd on read (isRecentlyArchivedLocked). Cleared by Hydrate for a
	// genuinely active session (the authoritative reconcile — e.g. unarchive).
	// See recentArchiveTTL.
	recentlyArchived map[string]time.Time
	// archivedSnapshot is the AUTHORITATIVE cross-restart set of session IDs
	// whose time.archived != 0 — rebuilt by RefreshArchivedSnapshot from
	// OpenCode's archived-session list (e.g. ListArchivedSessions /
	// /session?archived=true) on every hydrate + 5s reconcile, then consumed by
	// sweepOrphansLocked (the Defect-3 backstop) and — via
	// isArchivedAuthoritativeLocked — by Slice 2's isOrphanLocked at emit time.
	// It is the ONLY authority that survives a daemon restart: the tombstones
	// (recentlyArchived, above) are in-memory, 30s TTL, and lost on restart, so
	// without this snapshot a fresh store cannot tell an archived parent from an
	// unresolvable one and would classify the straggler as a plain root (the
	// Defect-2 false-negative). Guarded by s.mu; read-only under the lock by the
	// sweep + the emit-time accessor (no concurrent writers).
	archivedSnapshot map[string]bool

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

// Config is the single validated configuration object governing every Store
// tunable (audit L-15 / remediation M6). Construction of a Store MUST go
// through NewWithConfig, which validates the complete configuration before any
// runtime state is allocated or exposed: non-positive or otherwise invalid
// values are rejected at construction so a malformed Store can never exist.
//
// Every tunable lives here AND as the matching Store instance field — there is
// no package-global or caller-specific path by which a tunable can avoid
// validation. Future tunables have one required home (this struct) and one
// validation boundary (validate / NewWithConfig).
//
// DefaultConfig fills the package-default values (the same values New used to
// inline before M6); production callers that take operator-supplied
// configuration should build a Config explicitly and handle the error returned
// by NewWithConfig rather than using the New compatibility wrapper.
type Config struct {
	// RingCapacity is the event-ring retention capacity (resume-via-replay
	// window). Must be positive.
	RingCapacity int
	// CompletionGrace is the grace-window duration an assistant turn waits
	// before authoritatively clearing busy (default defaultCompletionGrace).
	// Must be positive.
	CompletionGrace time.Duration
	// DeltaFlushInterval is the per-instance throttle window for streaming
	// part-delta flushes (Option C / P1-AGG-004; default deltaFlushInterval).
	// Must be positive.
	DeltaFlushInterval time.Duration
	// PartTextCap bounds the accumulated length of a single part's text field,
	// in bytes (default partTextCap). Must be positive.
	PartTextCap int
	// WindowMaxCount / WindowMaxBytes are the dual bound for the initial
	// message-window projection (defaults WindowMaxCount / WindowMaxBytes).
	// Must be positive.
	WindowMaxCount int
	WindowMaxBytes int
	// RecentArchiveTTL is the tombstone TTL for RemoveSessions
	// (default recentArchiveTTL). Must be positive.
	RecentArchiveTTL time.Duration
	// RecentBucketRetentionMinutes bounds the number of minute-buckets retained
	// in s.recentBucket (default defaultRecentBucketRetentionMinutes). Must be
	// positive.
	RecentBucketRetentionMinutes int
}

// DefaultConfig returns a Config populated with the package-default tunable
// values for the given ring capacity. This is the configuration the legacy
// positional New(ringCapacity) constructor produced; New delegates here. A
// caller that takes operator-supplied configuration should construct a Config
// explicitly (overriding the fields it exposes) and pass it to NewWithConfig.
func DefaultConfig(ringCapacity int) Config {
	return Config{
		RingCapacity:                 ringCapacity,
		CompletionGrace:              defaultCompletionGrace,
		DeltaFlushInterval:           deltaFlushInterval,
		PartTextCap:                  partTextCap,
		WindowMaxCount:               WindowMaxCount,
		WindowMaxBytes:               WindowMaxBytes,
		RecentArchiveTTL:             recentArchiveTTL,
		RecentBucketRetentionMinutes: defaultRecentBucketRetentionMinutes,
	}
}

// validate returns an error describing the first non-positive or otherwise
// invalid tunable in cfg, or nil if the whole family is sane. It is the single
// construction-time guard (M6): NewWithConfig calls it before allocating any
// runtime state, so a malformed Store can never exist.
func (cfg Config) validate() error {
	if cfg.RingCapacity <= 0 {
		return fmt.Errorf("state.Config: RingCapacity must be positive, got %d", cfg.RingCapacity)
	}
	if cfg.CompletionGrace <= 0 {
		return fmt.Errorf("state.Config: CompletionGrace must be positive, got %v", cfg.CompletionGrace)
	}
	if cfg.DeltaFlushInterval <= 0 {
		return fmt.Errorf("state.Config: DeltaFlushInterval must be positive, got %v", cfg.DeltaFlushInterval)
	}
	if cfg.PartTextCap <= 0 {
		return fmt.Errorf("state.Config: PartTextCap must be positive, got %d", cfg.PartTextCap)
	}
	if cfg.WindowMaxCount <= 0 {
		return fmt.Errorf("state.Config: WindowMaxCount must be positive, got %d", cfg.WindowMaxCount)
	}
	if cfg.WindowMaxBytes <= 0 {
		return fmt.Errorf("state.Config: WindowMaxBytes must be positive, got %d", cfg.WindowMaxBytes)
	}
	if cfg.RecentArchiveTTL <= 0 {
		return fmt.Errorf("state.Config: RecentArchiveTTL must be positive, got %v", cfg.RecentArchiveTTL)
	}
	if cfg.RecentBucketRetentionMinutes <= 0 {
		return fmt.Errorf("state.Config: RecentBucketRetentionMinutes must be positive, got %d", cfg.RecentBucketRetentionMinutes)
	}
	return nil
}

// NewWithConfig is the canonical validated Store constructor (audit L-15 /
// remediation M6). It validates the complete Config before allocating any
// runtime state and returns an error (not a panic) on invalid configuration,
// so production callers that take operator-supplied configuration can handle
// the failure. Every tunable, including recentBucketRetentionMinutes, becomes
// a Store instance field sourced from cfg.
func NewWithConfig(cfg Config) (*Store, error) {
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &Store{
		epoch:                   newEpoch(),
		sessions:                map[string]*sessionEntry{},
		messages:                map[string]*sessionMessages{},
		todos:                   map[string]json.RawMessage{},
		perms:                   map[string]map[string]json.RawMessage{},
		questions:               map[string]map[string]json.RawMessage{},
		permBlocked:             map[string]bool{},
		statuses:                map[string]json.RawMessage{},
		activity:                map[string]string{},
		activitySeq:             map[string]uint64{},
		unread:                  map[string]bool{},
		graceTimers:             map[string]*time.Timer{},
		graceGen:                map[string]uint64{},
		completionAuthoritative: map[string]bool{},
		// P7 turn-boundary state machine (turn_state.go): the per-session
		// idle|running|stopping layer + the fail-closed abort gate + the settle
		// timer / supersede counter.
		turnState:        map[string]TurnState{},
		abortSettling:    map[string]bool{},
		stopTurnID:       map[string]string{},
		stopTimers:       map[string]*time.Timer{},
		stopGen:          map[string]uint64{},
		abortWaitCh:      map[string]chan struct{}{},
		liveIdleObserved: map[string]bool{},
		// P7 slice #3: the versioned opencode→NormalizedEvent translator. Default
		// to the current event shape (v1); Apply routes through Translate.
		translator: TranslatorV1{},
		// Every tunable is sourced from the validated Config (M6): the
		// package-default values arrive via DefaultConfig, but the instance
		// fields are the only thing the hot paths read — there is no
		// package-global hot-path read left in the tunable family.
		completionGrace:              cfg.CompletionGrace,
		deltaFlushInterval:           cfg.DeltaFlushInterval,
		partTextCap:                  cfg.PartTextCap,
		windowMaxCount:               cfg.WindowMaxCount,
		windowMaxBytes:               cfg.WindowMaxBytes,
		recentArchiveTTL:             cfg.RecentArchiveTTL,
		recentBucketRetentionMinutes: cfg.RecentBucketRetentionMinutes,
		subtreeBusyCount:             map[string]int{},
		// Phase 1 (Gate C extension): the remaining 7 incremental subtree
		// indexes. Maps are non-nil; rootIDs / recentBucketKeys start nil and
		// are grown by rootsAppendLocked / insertRecentBucketKeyLocked.
		children:               map[string][]string{},
		subtreeRetryCount:      map[string]int{},
		subtreePendingInput:    map[string]int{},
		subtreeDescendantCount: map[string]int{},
		lastActivityAt:         map[string]time.Time{},
		subtreeNewestActivity:  map[string]time.Time{},
		recentBucket:           map[int64][]string{},
		msgLoaded:              map[string]bool{},
		msgRev:                 map[string]uint64{},
		coldFetchActive:        map[string]bool{},
		pendingEmptyNewest:     map[string]string{},
		confirmedEmptyNewest:   map[string]string{},
		seeded:                 map[string]bool{},
		recentlyArchived:       map[string]time.Time{},
		archivedSnapshot:       map[string]bool{},
		ring:                   newRingBuffer(cfg.RingCapacity),
		subs:                   map[int]*subscriber{},
		// Finding 4: SourceOpencodeLive is the iota zero value. Without an
		// explicit init here, ordinary daemon-originated emissions (messages
		// .loaded/error, activity, etc.) would be misattributed as
		// opencode_live in Probe 2's SourceCount. Daemon-generated is the safe
		// default for every emit path that does NOT set it explicitly.
		curEmitSource: diag.SourceDaemonGenerated,
	}, nil
}

// New returns an empty store with an event ring of the given capacity. It is a
// COMPATIBILITY WRAPPER (audit L-15 / remediation M6) retained because the
// constructor migration is large (~230 call sites): it translates the legacy
// positional ringCapacity argument into a validated Config via DefaultConfig
// and delegates to NewWithConfig, so every legacy call site still flows
// through the single construction-time validation chokepoint.
//
// The panic is reachable ONLY for a non-positive ringCapacity, which every
// production and test caller already avoids (the smallest capacity in the
// suite is 3). Production code that takes operator-supplied tunables should
// call NewWithConfig directly and handle the returned error rather than rely
// on this wrapper's panic-on-invalid behavior.
func New(ringCapacity int) *Store {
	s, err := NewWithConfig(DefaultConfig(ringCapacity))
	if err != nil {
		panic(fmt.Sprintf("state.New(%d): %v", ringCapacity, err))
	}
	return s
}

func rawObj(kv map[string]interface{}) json.RawMessage {
	b, _ := json.Marshal(kv)
	return b
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

// --- incremental subtreeBusyCount maintenance (Gate C de-risk prototype) ---
//
// These helpers maintain s.subtreeBusyCount incrementally. The reference is
// computeSubtreeBusyLocked (O(n) recompute, now test/reference-only — the
// production snapshot capture, gate wire value, and SendableNow read this
// index directly). The invariant each helper preserves:
//
//	subtreeBusyCount[id] == (1 if activity[id] is busy/retry else 0)
//	                     + Σ subtreeBusyCount[child] for each live child of id
//
// for every id in s.sessions. Three sites mutate it:
//   - setActivityLocked: own-contribution ±1 + propagate to ancestors
//   - upsertSessionLocked + Hydrate direct-assign: create/reparent
//   - deleteSessionLocked: remove + propagate to ancestors
//
// All callers hold s.mu (the index lives under the same lock as s.sessions).

// subtreeBusySelfLocked returns id's OWN contribution to its subtree busy
// count: 1 when its activity is busy/retry, else 0. Caller holds s.mu.
func (s *Store) subtreeBusySelfLocked(id string) int {
	a := s.activity[id]
	if a == ActivityBusy || a == ActivityRetry {
		return 1
	}
	return 0
}

// adjustAncestorChainFromLocked adds delta to subtreeBusyCount[firstParentID]
// and every live strict ancestor above it, walking parentID up while the parent
// exists in s.sessions. Stops at an empty parentID or a parent absent from the
// live tree — the SAME orphan-inclusive root definition as rootOfLocked, so an
// orphaned child's chain terminates at itself. firstParentID is the PARENT of
// the session whose subtree changed (not the session itself): callers propagate
// a subtree delta up from a session's parent without touching the session's own
// entry. Caller holds s.mu.
func (s *Store) adjustAncestorChainFromLocked(firstParentID string, delta int) {
	cur := firstParentID
	for i := 0; i < 100000; i++ { // bound vs a malformed cyclic parent link
		if cur == "" {
			return
		}
		se := s.sessions[cur]
		if se == nil {
			return // parent absent from live tree → orphan root, stop
		}
		s.subtreeBusyCount[cur] += delta
		cur = se.parentID
	}
}

// adjustAncestorSubtreeBusyLocked adds delta to every strict ancestor of id
// (walking id's parentID up). id's OWN entry is NOT touched. No-op when id is
// absent from the live tree (phantom). Caller holds s.mu.
func (s *Store) adjustAncestorSubtreeBusyLocked(id string, delta int) {
	se := s.sessions[id]
	if se == nil {
		return
	}
	s.adjustAncestorChainFromLocked(se.parentID, delta)
}

// maintainSubtreeBusyOnSessionUpsertLocked updates the incremental index after
// a session entry was just created or replaced (potentially reparented). prev is
// the prior *sessionEntry (nil for a fresh create); newParentID is the entry's
// new parentID. The caller must have ALREADY written s.sessions[id] with the new
// entry. Caller holds s.mu.
//
// Three cases:
//   - Fresh create (prev == nil): seed id's own contribution from its CURRENT
//     activity (which may have been set by a phantom status event that landed
//     before session.created — setActivityLocked is guarded on live-tree
//     membership, so the seeding happens here). A brand-new session has no
//     descendants, so the subtree count equals the self-contribution.
//   - Same parent (prev.parentID == newParentID): no topology change and upsert
//     does not touch activity → index already correct. No-op.
//   - Reparent: id's whole-subtree contribution (subtreeBusyCount[id], which
//     the move does not alter) is subtracted from the OLD ancestor chain and
//     added to the NEW ancestor chain. id's own entry is unchanged.
func (s *Store) maintainSubtreeBusyOnSessionUpsertLocked(id string, prev *sessionEntry, newParentID string) {
	switch {
	case prev == nil:
		// Fresh create (or recreate of a previously-deleted id). id's subtree
		// count = own busy contribution + the sum of subtreeBusyCount over any
		// live direct children. The recreate-with-orphaned-descendants case is
		// real in production: a parent's session.deleted orphans its children
		// (deleteSessionLocked does not cascade), and a later session.created /
		// archive-un-archive / hydrate-prune-then-reappear for the same id
		// must reabsorb those still-live descendants (their own subtree counts
		// are self-contained and correct). This scan is O(n) in live sessions,
		// but fresh create is the cold path — reparent, status, and activity
		// transitions are the hot O(depth) paths — and matches
		// computeSubtreeBusyLocked, which rebuilds children every call.
		total := s.subtreeBusySelfLocked(id)
		for cid, ce := range s.sessions {
			if ce.parentID == id {
				total += s.subtreeBusyCount[cid]
			}
		}
		if total != 0 {
			s.subtreeBusyCount[id] = total
			s.adjustAncestorChainFromLocked(newParentID, total)
		}
	case prev.parentID == newParentID:
		// No topology change; activity is untouched by upsert. No-op.
	default:
		// Reparent. id's own subtree count is unchanged by the move; only its
		// ancestors' aggregates shift.
		if sub := s.subtreeBusyCount[id]; sub != 0 {
			s.adjustAncestorChainFromLocked(prev.parentID, -sub)
			s.adjustAncestorChainFromLocked(newParentID, +sub)
		}
	}
}

// --- end incremental subtreeBusyCount maintenance ---

// --- archive (OpenCode-native: time.archived is the source of truth) ---

// isRecentlyArchivedLocked reports whether id is within the archive tombstone
// window (set by RemoveSessions). Lazily GCs expired entries. Caller must hold
// s.mu. Returns false (and cleans up) once the TTL has elapsed so a genuine
// re-creation or a long-delayed event is processed normally.
func (s *Store) isRecentlyArchivedLocked(id string) bool {
	if exp, ok := s.recentlyArchived[id]; ok {
		if time.Now().Before(exp) {
			return true
		}
		delete(s.recentlyArchived, id)
	}
	return false
}

// RemoveSessions drops sessions from the live view and emits session.delete for
// each, so connected clients prune them immediately (e.g. right after they were
// archived in OpenCode). A subsequent re-hydrate keeps things consistent.
//
// It also arms a short-TTL tombstone (recentlyArchived) per id: this is the
// archive path, and OpenCode can transiently revert time.archived by rewriting
// the full record from a pre-PATCH snapshot while a busy/compacting descendant
// is still running. The tombstone blocks that stale session.updated /
// session.compacted (archived=null) from resurrecting the id via
// upsertSessionLocked, and blocks a busy status from re-promoting it via
// setActivityLocked. Cleared ONLY by ClearArchiveTombstones (the explicit
// unarchive flow) or by TTL expiry. Hydrate deliberately does NOT clear it —
// see recentArchiveTTL.
func (s *Store) RemoveSessions(ids []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	expiry := time.Now().Add(s.recentArchiveTTL)
	for _, id := range ids {
		if _, ok := s.sessions[id]; ok {
			s.deleteSessionLocked(id)
		}
		s.recentlyArchived[id] = expiry
	}
}

// ClearArchiveTombstones removes the archive-resurrection tombstone for each
// given id. This is the EXPLICIT unarchive path: it is called by the unarchive
// handler (handleArchive's /vh/unarchive branch) after the direct-SQLite
// unarchive succeeds and before Rehydrate, so the restored sessions re-enter
// the live tree (without this, Hydrate's and upsertSessionLocked's tombstone
// guards would keep them absent). Callers outside the unarchive flow must NOT
// call this — let the tombstone expire via recentArchiveTTL so the stale-clobber
// window stays protected.
func (s *Store) ClearArchiveTombstones(ids []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range ids {
		delete(s.recentlyArchived, id)
	}
}

// IsRecentlyArchived reports whether id is within the archive-resurrection
// tombstone window. It is the public (lock-acquiring) read used by the archive
// re-assert goroutine to decide whether to re-PATCH an id: if the tombstone is
// gone (explicit unarchive via ClearArchiveTombstones, or TTL expiry) the
// archive intent no longer holds and re-PATCHing would undo a legitimate
// unarchive.
func (s *Store) IsRecentlyArchived(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.isRecentlyArchivedLocked(id)
}

// --- authoritative archived-ID snapshot + Defect-3 backstop sweep ---
//
// The live store CANNOT be the orphan authority: RemoveSessions drops an
// archived parent from s.sessions, so a child whose parentID points at it
// classifies as a plain root (effectiveParentOfLocked returns "" for an absent
// parent) — the Defect-2 false-negative. The tombstone (recentlyArchived,
// 30s TTL) is a resurrection-guard, not an orphan authority: it is in-memory
// and lost on daemon restart, so a fresh store cannot reconstruct it. The ONLY
// cross-restart authority is OpenCode's archived-session list, captured here as
// archivedSnapshot and rebuilt on every hydrate + 5s reconcile by
// RefreshArchivedSnapshot. sweepOrphansLocked then flags live sessions whose
// parentID chain terminates at a confirmed-archived parent — the Defect-3
// backstop that makes the recurrence (a straggler left behind after a partial
// archive cascade) detectable and, once Slice 2 widens isOrphanLocked,
// visible to the operator.

// RefreshArchivedSnapshot rebuilds the authoritative archived-ID snapshot from
// rawArchived (the result of OpenCode's archived-session fetch, e.g.
// ListArchivedSessions / /session?archived=true) and then runs the orphan
// backstop sweep, flagging live sessions whose parentID chain terminates at a
// confirmed-archived parent.
//
// The HTTP fetch MUST happen OUTSIDE the store lock (the aggregator owns it);
// this method takes s.mu only for the in-memory snapshot rebuild + sweep, so no
// store lock is ever held across network I/O. Invoked by the aggregator at
// hydrate (after Hydrate reconciles the live tree) and on each 5s tree-reconcile
// tick (after ReconcileSessions). Idempotent: rebuilding the snapshot from the
// same input yields the same set, and the sweep re-evaluates every live session
// each run (clearing stale flags when a parent leaves the snapshot, e.g. after a
// legitimate un-archive).
func (s *Store) RefreshArchivedSnapshot(rawArchived []json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rebuildArchivedSnapshotLocked(rawArchived)
	s.sweepOrphansLocked()
}

// rebuildArchivedSnapshotLocked rebuilds s.archivedSnapshot from rawArchived. An
// id is archived iff its session info carries time.archived != 0 — the SAME
// filter archivedDescendants (pkg/web/archive.go:356-408) applies, reused here so
// the snapshot and the unarchive walk agree on what "archived" means. The map is
// rebuilt wholesale (not merged) so ids that left the archived set (a legitimate
// un-archive) are dropped on the next refresh. Caller holds s.mu.
func (s *Store) rebuildArchivedSnapshotLocked(rawArchived []json.RawMessage) {
	next := make(map[string]bool, len(rawArchived))
	for _, raw := range rawArchived {
		var env sessionEnvelope
		if json.Unmarshal(raw, &env) != nil || env.ID == "" {
			continue
		}
		// Defensive filter: archivedDescendants keeps only genuinely archived
		// members (time.archived set to a non-zero value) so non-archived
		// entries that leak into the list (OpenCode 1.17.x ?archived=true is
		// documented as ignored by some versions) are never admitted.
		if env.archivedAt() {
			next[env.ID] = true
		}
	}
	s.archivedSnapshot = next
}

// sweepOrphansLocked is the Defect-3 backstop: it flags every live session whose
// parentID chain terminates at an archived parent (see
// chainTerminatesAtArchivedLocked for both termination conditions). A chain that
// terminates at a LIVE root (parentID == "") or an UNRESOLVABLE parent (absent
// from both the live store and the archived snapshot) is NEVER flagged — the
// e88f19e false-positive gate, non-negotiable. Idempotent: re-evaluates every
// live session each run, setting OR clearing sessionEntry.orphan so the flag
// tracks the current snapshot.
//
// PROPAGATION (archive-defect-chain Slice 2): when a session's flag CHANGES, the
// sweep emits a KindTreeOrphanCheck for it, prompting the tree emitter to
// recompute the orphan facet and emit node.facet{flags:{orphan}} to each
// connection that knows the node — so an ALREADY-CONNECTED client sees the flag
// flip without waiting for an unrelated session event on the straggler or a
// full reconnect. Without this, RefreshArchivedSnapshot would update the stored
// se.orphan but never re-emit, leaving connected clients on the stale pre-flip
// flag until the next reconnect (the restart case works because reconnect forces
// a fresh SnapshotFrontier; the live rehydrate case did not). The emission is
// change-gated: steady-state sweeps (no flag flips) emit nothing. Caller holds
// s.mu.
func (s *Store) sweepOrphansLocked() {
	for id, se := range s.sessions {
		now := s.chainTerminatesAtArchivedLocked(id)
		if now != se.orphan {
			se.orphan = now
			// Propagate the flip to connected clients (see PROPAGATION above).
			s.emitOrphanCheckLocked([]string{id})
		}
	}
}

// chainTerminatesAtArchivedLocked reports whether id's parentID chain, walked up
// through live ancestors, terminates at an ARCHIVED parent. Two termination
// conditions, both resolving to "archived":
//   - the parent is ABSENT from the live store AND present in the authoritative
//     archived snapshot (the production path: RemoveSessions dropped an archived
//     parent, so the straggler's parentID points at a session no longer resident);
//   - the parent is STILL resident but carries time.archived (§9.1 archive-keep
//     defense / direct state inspection). In production archive REMOVES the
//     session, so this branch is only reached for the archive-keep hypothetical —
//     but resolving it here keeps emit (isOrphanLocked) and the sweep
//     (sweepOrphansLocked), which both call this function, in lockstep.
//
// Returns false for a live root (parentID == "") and for a chain ending at an
// unresolvable parent (absent from both the live store and the snapshot) — the
// e88f19e false-positive gate. Bounded against cyclic parent links (defensive;
// malformed data). Caller holds s.mu.
func (s *Store) chainTerminatesAtArchivedLocked(id string) bool {
	cur := id
	seen := map[string]bool{id: true}
	for i := 0; i < 100000; i++ {
		se := s.sessions[cur]
		if se == nil {
			// Defensive: iterating live sessions, cur should always exist. A
			// concurrent mutation is impossible (caller holds s.mu).
			return false
		}
		pid := se.parentID
		if pid == "" {
			// cur is a live root; the chain terminates at a live node.
			return false
		}
		if s.sessions[pid] == nil {
			// Parent absent from the live store → the chain TERMINATES at pid.
			// Flag iff pid is confirmed-archived (in the snapshot). An
			// unresolvable pid (never existed, not in snapshot) is NOT flagged.
			return s.archivedSnapshot[pid]
		}
		// Parent is still resident. §9.1 archive-keep defense: an archived
		// ancestor that is STILL present orphans its descendants. (In production
		// archive removes the session, so this is only reached for the
		// archive-keep hypothetical / direct inspection.)
		if isArchivedLocked(s, pid) {
			return true
		}
		// Parent is live → walk up. Cycle guard against malformed parent links.
		if seen[pid] {
			return false
		}
		seen[pid] = true
		cur = pid
	}
	return false
}

// isArchivedAuthoritativeLocked reports whether id is in the authoritative
// archived-ID snapshot (archivedSnapshot) — the cross-restart authority for
// "this session was archived". Distinct from the in-memory tombstone
// (isRecentlyArchivedLocked): the tombstone is a 30s resurrection-guard lost on
// daemon restart, whereas the snapshot is rebuilt from OpenCode's
// archived-session list on every hydrate + 5s reconcile and so survives restart.
// Slice 2's isOrphanLocked consults this to classify a straggler whose archived
// parent is gone from the live store, without duplicating the fetch. Caller
// holds s.mu.
func (s *Store) isArchivedAuthoritativeLocked(id string) bool {
	return s.archivedSnapshot[id]
}

// IsOrphanFlagged reports whether the Defect-3 backstop sweep has flagged id as
// an orphan (its parentID chain terminates at a confirmed-archived parent). It
// is the public, lock-acquiring read used by tests and diagnostics; the emitted
// node flag is derived separately by isOrphanLocked at emit time (Slice 2 widens
// that computation to consult the same snapshot, at which point the swept flag
// and the emitted flag converge). Returns false for an unknown id.
func (s *Store) IsOrphanFlagged(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if se := s.sessions[id]; se != nil {
		return se.orphan
	}
	return false
}

// ChainTerminatesAtArchived is the public, lock-acquiring form of
// chainTerminatesAtArchivedLocked. It reports whether id's parentID chain,
// walked up through live ancestors, terminates at an ARCHIVED parent (the same
// authority Slices 1/2 use for the orphan classification). The archive cascade
// job (pkg/web/archive.go runArchiveCascade) consults it to classify a
// permanently-stuck id: true → descendant of an archived root → leave live so
// the orphan sweep flags it (OrphanBanner surfaces it); false → root or
// unresolvable chain → surface as an explicit job failure and NEVER orphan-flag
// (the e88f19e false-positive gate). Returns false for an unknown id.
func (s *Store) ChainTerminatesAtArchived(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.sessions[id] == nil {
		return false
	}
	return s.chainTerminatesAtArchivedLocked(id)
}

// IsArchiveRootResolved reports whether a stuck-root archive target has been
// resolved out-of-band — archived or deleted by another tool / a direct
// OpenCode call, OUTSIDE this daemon's archive cascade. It is the Slice-2
// OOB-reconcile backstop's predicate (pkg/web archive_backstop.go
// reconcileArchiveFailures): a stale archiveJobFailure record for id is cleared
// once this returns true, closing the ONE gap Slice 1 left (a root recorded
// permanently-stuck, then archived/deleted out-of-band, would otherwise persist
// its warning until daemon restart — Slice 1's clear-on-success fires only at
// THIS daemon's cascade success funnel, which never ran for an OOB resolution).
//
// Resolved means ANY of (mirroring the authorities sweepOrphansLocked +
// classifyArchiveFailure already use, never inventing a new one):
//   - id is ABSENT from the live session tree. An OOB archive completes → the
//     next tree-reconcile tick (runTreeReconcile) fetches /session (which
//     EXCLUDES archived entries) → ReconcileSessions evicts id from s.sessions.
//     An OOB delete → id drops out of /session → same eviction. Either way id
//     is gone from the live tree.
//   - id is STILL present but confirmed archived in the authoritative snapshot
//     (archivedSnapshot, rebuilt by RefreshArchivedSnapshot from OpenCode's
//     archived-session list). Covers the window before ReconcileSessions evicts.
//   - id's parentID chain now terminates at an ARCHIVED ancestor
//     (chainTerminatesAtArchivedLocked) — id was re-parented under, or is a
//     descendant of, an OOB-archived root. The stuck-root record for id is
//     stale because id is no longer a root that needs archiving on its own.
//
// Takes s.mu.RLock internally (read-only — the same authority the public
// ChainTerminatesAtArchived takes). The Slice-2 backstop calls this while
// holding the Server's bgMu, establishing the bgMu → store.s.mu lock-order
// direction (bgMu ALWAYS outermost when both are held — see reconcileOneArchiveFailure).
// Returns true for an id never seeded (absent → resolved) — the correct
// disposition for a ghost root whose stale warning should clear.
func (s *Store) IsArchiveRootResolved(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.sessions[id] == nil {
		return true // absent from the live tree (OOB archive or delete evicted it)
	}
	if s.archivedSnapshot[id] {
		return true // present but confirmed archived in the authoritative snapshot
	}
	return s.chainTerminatesAtArchivedLocked(id) // re-parented under an archived ancestor
}

// ParentOf returns the raw parentID of id from the live store ("" for a root or
// an unknown id). The archive cascade job captures a snapshot of the parent
// chain for every id in the frozen affected scope BEFORE any RemoveSessions
// mutates the tree, so classifyArchiveFailure can recognize a failed descendant
// of a root archived by the SAME job (the authoritative archivedSnapshot is not
// refreshed mid-job, and RemoveSessions re-roots children — both would otherwise
// make ChainTerminatesAtArchived return false for a just-orphaned child).
func (s *Store) ParentOf(id string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if se := s.sessions[id]; se != nil {
		return se.parentID
	}
	return ""
}

// RemoveSessionIfPresent is the compare-and-swap archive removal: it always
// arms the archive-resurrection tombstone (the resurrection guard is needed
// after any successful SetArchived, even for an id not currently in the live
// store — it blocks a stale session.updated from resurrecting it), but it
// deletes id from the live store + returns whether it ACTUALLY performed the
// deletion. The archive cascade job uses the return value to decide whether
// THIS job owns the queue/pin cleanup for the id — a concurrent re-issue whose
// job already RemoveSessions'd the id returns false, so CleanupSession is NOT
// double-called (the RT4 no-double-queue-cleanup contract under concurrent
// detached jobs). This preserves the old RemoveSessions tombstone-always
// semantics while adding the CAS gate the F2 fix requires.
func (s *Store) RemoveSessionIfPresent(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, present := s.sessions[id]
	if present {
		s.deleteSessionLocked(id)
	}
	s.recentlyArchived[id] = time.Now().Add(s.recentArchiveTTL)
	return present
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
		// Collapse byte-identical duplicates to match Snapshot.Permissions
		// exactly (TestPendingPermissionsMatchesSnapshot pins the two paths to
		// the same set). See dedupRawMessages for the lossless / order-
		// preserving contract.
		list = dedupRawMessages(list)
		out[sid] = list
	}
	return out
}

// deltaFlushInterval is the DEFAULT per-instance value of the part.upsert
// emit-rate throttle during a token-delta burst (Option C / P1-AGG-004). It is
// read once at Store construction (New) into s.deltaFlushInterval, which is
// the field actually read hot under mutation; tests shrink s.deltaFlushInterval
// on the instance under test, NOT this global, so a -race run cannot observe
// a global mutation racing a lingering goroutine from a prior -count
// iteration (GAP-S5). 30ms ≈ 33fps of part events — well within the live-feel
// budget (the FE coalesces streaming markdown to ~5fps in components/Part.tsx
// / lib/streamMd.ts), while cutting the per-char marshal+emit+ring-push cost
// to ~1× per window.
const deltaFlushInterval = 30 * time.Millisecond

// recentArchiveTTL is the DEFAULT per-instance tombstone TTL: how long
// RemoveSessions' tombstone suppresses resurrection of an archived session by
// a stale session.updated / session.compacted arriving with archived=null
// (OpenCode can rewrite the full record from a pre-PATCH snapshot while a
// busy/compacting descendant is still running). Read once at Store
// construction into s.recentArchiveTTL; tests shrink the instance field, not
// this global (GAP-S5). The TTL must cover the transient clobber window; the
// web layer's archive re-assert (handleArchive) and the periodic resync
// provide additional self-heal. The tombstone is cleared only by the explicit
// unarchive flow (ClearArchiveTombstones); Hydrate does NOT clear it, because
// a hydrate can't tell a genuine unarchive from a stale clobber (both carry
// archived=null).
const recentArchiveTTL = 30 * time.Second

// defaultCompletionGrace is how long the store waits after an assistant turn
// completes (with no in-flight assistant message remaining) before
// authoritatively clearing busy — deferring the idle clear past a multi-step
// turn's inter-step gap so the spinner does not dip and no spurious "finished"
// notification fires between steps (text → tool → text). session.idle (when
// OpenCode emits it) clears immediately and cancels the timer; this window
// only owns the missed-session.idle case. Read once at Store construction
// into s.completionGrace; tests shrink the instance field, not this global —
// the same per-instance promotion pattern GAP-S5 extends to the other
// tunables above.
const defaultCompletionGrace = 5 * time.Second

// partTextCap bounds the accumulated length of a single part's text field, in
// bytes. External latency analysis (17.8k sessions / 13 GB) found one bash
// `tool` part whose unbounded stdout grew to 100 MB — a single pathological
// part dominated snapshot/transport/client cost. This cap (1 MiB, generous for
// any realistic tool output) bounds the store's per-part memory regardless of
// upstream volume: once a (partID, field) accumulator crosses the cap, the
// text is truncated to (cap - marker) and a visible marker recording the
// omitted byte count is appended; further deltas to that sealed (partID, field)
// are dropped. Applies to ALL part types uniformly (no tool special-casing).
//
// This is the DEFAULT per-instance value: read once at Store construction
// into s.partTextCap (GAP-S5), which is the field the hot paths read; tests
// shrink the instance field to a few bytes for deterministic truncation
// assertions. The cap is a STOPGAP guardrail; a larger transcript-windowing
// fix will follow separately and is intentionally out of scope here.
const partTextCap = 1 << 20 // 1 MiB

// truncatedMarker returns the visible cap-reached marker that gets appended to
// a sealed part field. omitted is the number of original output bytes that were
// dropped (len(original) - partTextCap). The marker is deterministic given N,
// so a part sealed twice from the same input produces byte-identical text —
// this is what preserves the monotonic revision validation contract under
// truncation (no false staleness discard).
func truncatedMarker(omitted int) string {
	return "\n…[output truncated: " + strconv.Itoa(omitted) + " further bytes omitted]…"
}

// applyCapToString bounds s to textCap bytes, appending truncatedMarker if
// truncation occurred. Returns the (possibly truncated) string and a flag
// indicating whether truncation was applied. The cap lands on a UTF-8 rune
// boundary so the result is always valid UTF-8 (a mid-rune cut would otherwise
// be re-marshal'd by encoding/json as U+FFFD, lossy and nondeterministic under
// some decoders). Same input + cap → same output (deterministic).
//
// Returns s unchanged if len(s) <= textCap. Pure: no store access, no lock —
// the cap is threaded in by the caller (the per-instance s.partTextCap) so a
// test can shrink the instance without a global-mutation race.
func applyCapToString(s string, textCap int) (string, bool) {
	if len(s) <= textCap {
		return s, false
	}
	omitted := len(s) - textCap
	marker := truncatedMarker(omitted)
	cut := textCap - len(marker)
	if cut < 0 {
		cut = 0
	}
	// Back up to the largest rune boundary <= cut so we don't end mid-codepoint.
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + marker, true
}

// capPartJSON applies the partTextCap to every string field of the part JSON
// uniformly, RECURSING into nested objects and arrays. Only fields OVER the
// cap are touched (so short metadata strings like id/type pass through
// byte-identical); any field that crosses the cap is replaced with its
// applyCapToString form. This is what bounds the motivating pathological case:
// a bash `tool` part whose unbounded stdout lives at part.state.output
// (nested two levels deep), not at any top-level field — a top-level-only
// walk would miss it entirely. Returns part unchanged if no field needed
// truncation or if the input is malformed JSON. Used on the wholesale upsert
// paths (upsertPartLocked, reconcileMessagesLocked) so a single huge
// part.upsert or history-fetch payload is bounded — the streaming delta path
// is bounded separately in appendPartDeltaLocked.
//
// Determinism: Go randomizes map iteration order, but applyCapToString is
// pure and encoding/json Marshal sorts map keys alphabetically, so the
// marshaled output is identical regardless of traversal order — this is what
// preserves the monotonic revision validation contract under truncation.
// Pure: no store access, no lock — textCap is threaded in by the caller (the
// per-instance s.partTextCap) so a test can shrink the instance without a
// global-mutation race.
func capPartJSON(part json.RawMessage, textCap int) json.RawMessage {
	if len(part) <= textCap {
		// Fast path: the entire JSON envelope is under the cap, so no string
		// field at any depth can be over it either. Avoids an unmarshal+marshal
		// pair on every wholesale upsert.
		return part
	}
	var p map[string]any
	if json.Unmarshal(part, &p) != nil {
		return part
	}
	if !capStringsInPlace(p, textCap) {
		return part
	}
	if updated, err := json.Marshal(p); err == nil {
		return updated
	}
	return part
}

// capStringsInPlace walks v recursively and applies applyCapToString to every
// string at any depth, mutating maps/arrays in place. Returns whether any
// string was truncated. Used by capPartJSON; the recursion is what lets the
// cap reach nested tool-output paths like state.output / state.error.
func capStringsInPlace(v any, textCap int) bool {
	switch x := v.(type) {
	case map[string]any:
		changed := false
		for k, item := range x {
			if s, ok := item.(string); ok {
				if capped, truncated := applyCapToString(s, textCap); truncated {
					x[k] = capped
					changed = true
				}
			} else if capStringsInPlace(item, textCap) {
				changed = true
			}
		}
		return changed
	case []any:
		changed := false
		for i, item := range x {
			if s, ok := item.(string); ok {
				if capped, truncated := applyCapToString(s, textCap); truncated {
					x[i] = capped
					changed = true
				}
			} else if capStringsInPlace(item, textCap) {
				changed = true
			}
		}
		return changed
	default:
		// Numbers, bools, json.Number, nil — no string to cap.
		return false
	}
}

// Epoch returns this store's lifetime id (see Snapshot.Epoch).
func (s *Store) Epoch() string { return s.epoch }

// dedupRawMessages returns subslice of in containing only the first occurrence
// of each byte-identical entry (order preserved; later duplicates dropped). It
// is the wire-volume fix for the permission-array bloat observed on the live
// controller topology: 937/1016 sessions carried arrays with byte-identical
// entries repeated (e.g. {todowrite,*,deny} 3×). The map keyed by permID keeps
// distinct IDs distinct, so byte-identical VALUES across distinct keys is the
// degenerate case this collapses.
//
// LOSSLESS: byte-identical entries carry zero information — the client already
// keys its permission map by payload.id, so duplicate ids collapse on the
// client anyway; byte-identical entries (same id, somehow landed under multiple
// map keys via the rehydrate path) render one card either way. Dropping the
// redundant copies changes ONLY the wire byte count, never the rendered set.
//
// ORDER-PRESERVING (first-occurrence wins) so the snapshot is deterministic
// within a single call — matters for revision validation / diff stability
// (a later snapshot of the same store state must not reshuffle the array on
// the dedup boundary). The input order comes from Go map iteration, which is
// nondeterministic across runs, so the dedup itself is stable within one call
// but the output is not byte-stable across calls. Revision validation keys on
// Snapshot.Seq, so cross-call nondeterminism is correct.
// Returned slice aliases the input backing array (via in[:0]) — the caller
// MUST NOT retain a separate view of `in` after calling, since the compaction
// overwrites the prefix of the backing array. The output slice reuses the
// backing array with zero extra allocation; the `seen` map IS allocated
// unconditionally for len(in) ≥ 2.
func dedupRawMessages(in []json.RawMessage) []json.RawMessage {
	if len(in) < 2 {
		return in
	}
	seen := make(map[string]struct{}, len(in))
	out := in[:0] // reuse the backing array in place
	for _, p := range in {
		key := string(p)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, p)
	}
	return out
}
