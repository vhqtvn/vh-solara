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
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

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

	// FrontierChanged (Phase 2 finding B) is true when THIS specific event
	// changed the collapsed-frontier membership (session create/delete/reparent,
	// pending-input boundary change, or the FIRST activity of a previously-
	// inactive session). The stream handler gates the promotion coalesce arm on
	// this per-event flag instead of comparing a global counter against a
	// snapshot-stamped value (which races with the aggregator's concurrent
	// poll-loop re-applies). json:"-" keeps it off the wire (the wire shape is
	// bit-for-bit unchanged — seq/kind/payload only).
	FrontierChanged bool `json:"-"`
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
	// Projected (Phase 2 Gate A — collapsed-frontier projection): when true, this
	// snapshot uses MERGE semantics — sessions absent from Sessions are PRESERVED
	// on the client as hidden (collapsed behind a frontier stub), NOT deleted.
	// Only an explicit session.delete event removes a session. Absent or false
	// means AUTHORITY_COMPLETE — the classic wholesale-replace where omission ===
	// deleted (legacy behavior). The dual capability negotiation protects both
	// directions: `?proj=1` query param (protects old clients that don't send it)
	// + this `projected` envelope field (protects new clients against old servers
	// that ignore proj=1 and emit AUTHORITY_COMPLETE). Phase 2: the field exists
	// for capability negotiation but is NOT populated — the server still emits
	// complete snapshots. Phase 4 wires the actual projection.
	Projected bool `json:"projected,omitempty"`
	// Cause identifies why a projected snapshot was emitted:
	//   "initial"     — first open (fresh client, no valid cursor)
	//   "reconnect"   — projected resume: re-project the frontier after cursor
	//                   replay succeeds (rebuilds the ephemeral stubs a reloaded
	//                   client lost); also used when the cursor is too old to replay
	//   "promotion"   — hidden→active atomic promotion (live activity on a stubbed session)
	//   "lazy-expand" — branch expand endpoint response
	//   "resync"      — epoch-change forced re-snapshot
	// Absent in AUTHORITY_COMPLETE. Populated by the projection path (Phase 4+).
	Cause string `json:"cause,omitempty"`
	// StructuralRevision (Phase 3 Gate B) is the Store-wide monotonic per-epoch
	// counter stamped in every snapshot envelope. The client tracks
	// lastAppliedStructuralRevision: < → discard stale, == → idempotent skip,
	// > → apply. Absent (omitempty) when 0 = fresh store with no mutations — the
	// client treats an absent field as "always apply" (also protects against old
	// servers that don't stamp it). See Store.structuralRevision.
	StructuralRevision uint64 `json:"structuralRevision,omitempty"`
	// FrontierSeq (Phase 2 finding B) is the frontier-membership counter
	// captured under RLock at snapshot construction time. NEVER serialized
	// (json:"-"). DIAGNOSTICS-ONLY: retained for observability (not yet wired
	// to the /vh/diag/latency endpoint). The stream handler does NOT read it
	// gate uses the per-event ClientEvent.FrontierChanged flag instead.
	FrontierSeq uint64 `json:"-"`
	// Stubs (Phase 4) carries collapsed-branch stubs for idle subtrees in a
	// projected snapshot. Each stub represents a subtree that exists on the
	// server but is NOT materialized as full sessions — the client renders it
	// as a collapsed row with a descendant-count badge. Expanding a stub
	// triggers a lazy-fetch to the branch endpoint. Absent in AUTHORITY_COMPLETE
	// snapshots (projected=false).
	Stubs []CollapsedBranchStub `json:"stubs,omitempty"`
	// CutoffVersion + CutoffMs (Phase 6 Gate E) carry the projection cutoff
	// that was active when this snapshot was constructed. CutoffVersion is a
	// monotonic version that bumps when the server changes the cutoff policy
	// (so the client can detect a boundary change). CutoffMs is the cutoff
	// duration in milliseconds (default 600000 = 10 minutes). A session whose
	// newest activity is older than (now - cutoffMs) is considered idle and
	// collapsed into a frontier stub.
	//
	// Anti-thrash guarantee (Gate E): demotion happens ONLY at snapshot
	// construction time (initial/promotion/reconnect) — there are NO timer-
	// driven demotion events. The 15s ping ticker stays ping-only. This means
	// a session active every 9:59 (just under the 10min cutoff) never gets
	// demoted between activity bursts, because no snapshot is constructed
	// between bursts.
	//
	// Absent in AUTHORITY_COMPLETE snapshots (projected=false). Omitted when
	// CutoffVersion is 0 (fresh store, never stamped — treated as "no cutoff
	// info" by the client).
	CutoffVersion uint32 `json:"cutoffVersion,omitempty"`
	CutoffMs      uint64 `json:"cutoffMs,omitempty"`
	// StaleCursor (Theme 3 / Finding A): set ONLY by SnapshotBranch when a
	// non-empty pagination cursor child was deleted/reparented between page
	// requests (cursor not found under parentID). The client reads this to
	// restart the branch expansion ONCE from page 0 under a fresh branch
	// structural generation, rather than treating the empty batch as terminal
	// pagination completion — which would permanently omit the siblings after
	// the deleted cursor. Absent on every other path (omitempty).
	StaleCursor bool `json:"staleCursor,omitempty"`
	// ProjectConstants (Phase 3 trim): when the client opts into hoisted
	// constants via ?hoist=1, the server extracts per-session fields that are
	// identical across all sessions in a project (model, projectID, directory)
	// and emits them ONCE at snapshot level. Sessions whose value matches the
	// hoisted constant have that field stripped from their info JSON; sessions
	// with a per-session override keep the inline field. The client resolves:
	// session.field || projectConstants.field.
	//
	// Absent when hoist is not requested (old clients) or when no sessions are
	// active (omitempty). ADDITIVE — old clients that don't know about it simply
	// ignore it and read per-session fields (which are still present for them).
	ProjectConstants *ProjectConstants `json:"projectConstants,omitempty"`
}

// ProjectConstants carries project-level constants hoisted out of per-session
// info JSON to avoid repeating them N× (440 sessions × ~60 bytes = ~26 KB
// savings in the study's representative snapshot). See Snapshot.ProjectConstants.
type ProjectConstants struct {
	Model     json.RawMessage `json:"model,omitempty"`
	ProjectID string          `json:"projectID,omitempty"`
	Directory string          `json:"directory,omitempty"`
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

// WindowMaxCount and WindowMaxBytes are the operator-tunable bounds for the
// initial message-window projection (the cold-load tail) AND the historical
// page endpoint. Package-level VARS (not consts) precisely so tests can shrink
// them for deterministic window assertions — the same escape-hatch pattern as
// partTextCap. The defaults (100 messages / 1 MiB) are the operator-recommended
// dual bound: whichever hits first stops the window. The projector always
// includes at least the newest complete message even when the byte budget is
// exceeded (the oversized_item case). Exported so the HTTP layer (pkg/web) can
// clamp ?limit= / ?max_bytes= query params to the same canonical ceiling a
// historical page must not exceed (a single page must not carry more than the
// initial window's footprint).
var (
	WindowMaxCount = 100
	WindowMaxBytes = 1 << 20 // 1 MiB
)

// messageSerializedBytes returns the raw message-value byte size of a
// projection: len(Info) + sum(len(Parts)). This is the size measure the window
// projector budgets against. It is an APPROXIMATE content budget: it omits the
// marshaled-JSON envelope framing (the {"info":...,"parts":[...]} object/array
// keys, commas, braces the wire payload adds per message), so a window accepted
// at exactly maxBytes produces a decompressed wire payload slightly ABOVE
// maxBytes. The framing overhead is small and bounded per message; the per-part
// 1 MiB text cap (commit 516186b) is the hard OOM guardrail, and this aggregate
// cap delivers the order-of-magnitude bound the slice targets. Pure: no
// allocation, no store access.
func messageSerializedBytes(m MessageWithParts) int {
	n := len(m.Info)
	for _, p := range m.Parts {
		n += len(p)
	}
	return n
}

// messageIDFromInfo extracts the envelope id from a message info JSON blob. Used
// by the window projector to populate OldestLoadedID (the historical-page
// cursor). Returns "" on parse failure (the projector treats this as "no id
// available" — the client falls back to its own oldest-known id).
func messageIDFromInfo(info json.RawMessage) string {
	var env messageInfoEnvelope
	if json.Unmarshal(info, &env) == nil {
		return env.ID
	}
	return ""
}

// projectMessageWindow bounds a session's message list (creation-ordered, oldest
// first) to a recent tail of at most maxCount messages whose aggregate
// serialized size does not exceed maxBytes. Messages stay atomic: a message is
// NEVER split or truncated for windowing (the per-part text cap is a separate,
// earlier guardrail). The newest message is ALWAYS included, even if it alone
// exceeds the byte budget (the oversized case — the projector returns it alone
// and signals oversized_item + actual_bytes/budget_bytes so a client can render
// a diagnostic without a freeze).
//
// PURE and DETERMINISTIC: same input list → same bounded list + same WindowMeta.
// This is what preserves the monotonic revision-validation contract under
// windowing (no false staleness discard): the same captured state always
// projects to the same bytes, so publishColdBatch's msgRev equality check is
// sound. The projector performs NO store access and NO lock acquisition — it
// operates on an already-captured []MessageWithParts.
//
// The result preserves creation order (oldest first), matching the wire shape
// the client expects for prepend-on-load-more.
func projectMessageWindow(list []MessageWithParts, maxCount, maxBytes int) ([]MessageWithParts, WindowMeta) {
	meta := WindowMeta{}
	n := len(list)
	if n == 0 {
		// Empty (but PRESENT) session transcript. Return a non-nil empty slice
		// (NOT nil) so the caller can distinguish "0-message session, emit an
		// empty batch so the client knows it loaded as empty" from "session
		// gone (sm==nil), emit nothing." This matches the pre-windowing
		// behavior where captureMessagesBatchLocked returned make([]MessageWithParts, 0, ...).
		return []MessageWithParts{}, meta
	}
	if maxCount < 1 {
		maxCount = 1 // always include at least the newest
	}
	// The newest message is ALWAYS in the window (even if oversized). Walk
	// older messages newest-to-oldest, stopping at the first bound hit.
	newest := list[n-1]
	newestSize := messageSerializedBytes(newest)
	accCap := maxCount
	if n < accCap {
		accCap = n
	}
	tail := make([]MessageWithParts, 0, accCap)
	tail = append(tail, newest)
	accumulated := newestSize
	oldestID := messageIDFromInfo(newest.Info)

	if newestSize > maxBytes {
		// Oversized newest: return it ALONE. has_older reflects whether older
		// messages exist beyond this one. The diagnostics let a client explain
		// WHY it sees a single oversized item instead of the expected window.
		meta.MessageCount = 1
		meta.SerializedBytes = newestSize
		meta.OldestLoadedID = oldestID
		meta.HasOlder = n > 1
		meta.OversizedItem = true
		meta.ActualBytes = newestSize
		meta.BudgetBytes = maxBytes
		return tail, meta
	}

	countLimited := false
	bytesLimited := false
	for i := n - 2; i >= 0; i-- {
		m := list[i]
		size := messageSerializedBytes(m)
		if len(tail)+1 > maxCount {
			countLimited = true
			break
		}
		if accumulated+size > maxBytes {
			bytesLimited = true
			break
		}
		tail = append(tail, m)
		accumulated += size
		oldestID = messageIDFromInfo(m.Info)
	}
	meta.MessageCount = len(tail)
	meta.SerializedBytes = accumulated
	meta.OldestLoadedID = oldestID
	meta.HasOlder = countLimited || bytesLimited
	meta.CountLimited = countLimited
	meta.BytesLimited = bytesLimited
	// tail was built newest-first; reverse to creation order (oldest first).
	for i, j := 0, len(tail)-1; i < j; i, j = i+1, j-1 {
		tail[i], tail[j] = tail[j], tail[i]
	}
	return tail, meta
}

// MessagePageResult is the response envelope for the historical-page endpoint
// (GET /vh/session/{sessionId}/messages?before=...). It is DISTINCT from the
// cold-load messages.batch envelope: the client treats the items[] as a
// PREPEND/MERGE-BY-ID source (NEVER a wholesale replace) and MUST NOT confuse
// this response with a messages.batch or messages.loaded event. The endpoint
// never emits SSE events of any kind — it is a one-shot HTTP read.
//
// The fields mirror the bounded-window metadata contract (WindowMeta) but add
// the page-specific cursor echoes (request_before, newest_id, boundary_found)
// the prepend path needs. session_id / daemon_epoch / baseline_seq travel on
// the envelope so a client can correlate the page with a snapshot cursor. The
// stampMeta middleware stamps X-VH-Seq / X-VH-Epoch response headers at
// REQUEST ENTRY (before the handler runs); BaselineSeq below is captured at the
// actual SnapshotMessagesPage RLock (inside the handler). On a quiescent warm
// session the two seq values match; under a concurrent mutation during the
// request they can diverge (BaselineSeq is the more accurate capture cursor).
// The Contract-B freshness check (Phase 4 client) uses BaselineSeq — NOT
// X-VH-Seq — as the authoritative page-capture watermark and discards a page
// whose capture raced with a session mutation.
type MessagePageResult struct {
	// SessionID is the session this page belongs to. Always set on the wire.
	SessionID string `json:"session_id"`
	// ProjectID is the project directory (reqDir / ?dir=) the request resolved
	// to. Empty for the default project (the SPA fills it client-side).
	ProjectID string `json:"project_id,omitempty"`
	// DaemonEpoch is the store epoch at capture, so a client detects a daemon
	// restart (epoch change) that invalidates all historical cursors.
	DaemonEpoch string `json:"daemon_epoch"`
	// RequestBefore echoes the ?before=<id> cursor the client sent. Empty when
	// the client sent no cursor (the projector returns an empty page in that
	// case, since the initial-window path is the documented source of the
	// first cursor).
	RequestBefore string `json:"request_before,omitempty"`
	// BaselineSeq is the store seq captured under RLock at the moment
	// SnapshotMessagesPage read the transcript — the authoritative page-capture
	// watermark for Contract-B. The X-VH-Seq response header is stamped
	// earlier (at request entry by the stampMeta middleware); the two match on
	// a quiescent warm session but can diverge under concurrent mutation
	// (BaselineSeq is the more accurate cursor). The Phase 4 client compares
	// BaselineSeq against its connection cursor to discard stale pages.
	BaselineSeq uint64 `json:"baseline_seq"`
	// Items is the page, creation-ordered (oldest first) so the client can
	// prepend the slice verbatim after a one-item overlap dedup. ALWAYS non-nil
	// (empty [] when the page is empty) so the client distinguishes "empty
	// page" from "missing field".
	Items []MessageWithParts `json:"items"`
	// BoundaryFound is true when RequestBefore was located in the ordered
	// transcript at capture time. False means the cursor is stale (the message
	// was deleted, or the client sent a cursor it never received) — the client
	// refetches from a known-good cursor. Distinct from HasOlder: an oldest
	// message with no older neighbors has BoundaryFound=true, HasOlder=false.
	BoundaryFound bool `json:"boundary_found"`
	// OldestID is the message id of the OLDEST item in the page (the new
	// ?before= cursor for the NEXT historical page). Empty when the page is
	// empty.
	OldestID string `json:"oldest_id,omitempty"`
	// NewestID is the message id of the NEWEST item in the page (= RequestBefore
	// when boundary_found, since the boundary message is the page overlap).
	// Empty when the page is empty.
	NewestID string `json:"newest_id,omitempty"`
	// HasOlder is true when older messages exist beyond this page. The client
	// uses this (NOT boundary_found) to decide whether to render a "Load older"
	// affordance below the prepended page.
	HasOlder bool `json:"has_older"`
	// MessageCount is len(Items); carried explicitly so a client reads it
	// without decoding the items array.
	MessageCount int `json:"message_count"`
	// SerializedBytes is the sum of len(Info)+sum(len(Parts)) across the page
	// — same raw-value size measure as WindowMeta.SerializedBytes. A client
	// uses this to decide whether to evict far pages under the resident cache
	// byte budget.
	SerializedBytes int `json:"serialized_bytes"`
	// CountLimited / BytesLimited signal WHY the page stopped, mirroring
	// WindowMeta. A "Load older" affordance is meaningful iff HasOlder (which
	// is set when either limit fires AND older messages exist).
	CountLimited bool `json:"count_limited"`
	BytesLimited bool `json:"bytes_limited"`
	// OversizedItem / ActualBytes / BudgetBytes mirror WindowMeta: set ONLY in
	// the oversized-anchor case (the ?before= message alone exceeds the byte
	// budget). The page returns the anchor alone so the client never sees a
	// silent gap, and signals the overflow so it can explain the single-item
	// page.
	OversizedItem bool `json:"oversized_item,omitempty"`
	ActualBytes   int  `json:"actual_bytes,omitempty"`
	BudgetBytes   int  `json:"budget_bytes,omitempty"`
}

// projectMessagePage paginates a session's FULL message list (creation-ordered,
// oldest first) into a single historical page anchored at the `before` cursor.
// The page is INCLUSIVE of `before` as a one-item OVERLAP (the newest item in
// the page), followed by strictly-older messages bounded by (maxCount, maxBytes)
// — mirroring projectMessageWindow's dual bound. The overlap lets a client
// robustly dedup against its resident window (it prepends items whose ids are
// NOT already present), so continuity is preserved even if the resident cache
// evicted the boundary message.
//
// Contract:
//   - `before` is REQUIRED. An empty cursor returns an empty page with
//     boundary_found=false (the initial window is the documented source of the
//     first cursor; a missing cursor is a client bug or a stale-cache fetch).
//   - `before` not found in the list returns an empty page with
//     boundary_found=false (the client refetches from a known-good cursor;
//     Contract-B's dirty-flag is the primary guard against resurrecting a
//     deleted-then-recreated message).
//   - If the anchor (`before`) alone exceeds maxBytes, the page returns it
//     ALONE with oversized_item + actual_bytes/budget_bytes (the same
//     atomic-message guarantee as projectMessageWindow).
//   - `limit` bounds TOTAL page size (overlap + older), matching
//     projectMessageWindow's maxCount semantics.
//
// PURE and DETERMINISTIC: same input list + cursor → same page + same metadata.
// This is what makes the page a point-in-time Contract-B snapshot the client can
// validate against its cursor (no server-side retry loop needed; the GET is a
// read). No store access, no lock.
//
// The result preserves creation order (oldest first) so the client can prepend
// the slice verbatim.
func projectMessagePage(list []MessageWithParts, before string, maxCount, maxBytes int) MessagePageResult {
	res := MessagePageResult{Items: []MessageWithParts{}, RequestBefore: before}
	if before == "" || len(list) == 0 {
		return res // boundary_found stays false
	}
	if maxCount < 1 {
		maxCount = 1 // always include at least the anchor
	}
	if maxBytes < 1 {
		maxBytes = 1 // avoid the oversized short-circuit firing on any non-empty anchor
	}
	// Find the anchor index (linear scan; list is creation-ordered oldest-first,
	// so the scan is stable across message id reuse — the FIRST match wins, and
	// ids are unique within a session's lifetime).
	anchorIdx := -1
	for i := range list {
		if messageIDFromInfo(list[i].Info) == before {
			anchorIdx = i
			break
		}
	}
	if anchorIdx < 0 {
		return res // before not found; boundary_found stays false
	}
	res.BoundaryFound = true
	// The anchor is the page's newest item (the overlap). Walk older messages
	// newest-to-oldest from index < anchorIdx, dual-bounded.
	anchor := list[anchorIdx]
	anchorSize := messageSerializedBytes(anchor)
	page := make([]MessageWithParts, 0, maxCount)
	page = append(page, anchor)
	res.NewestID = before
	res.OldestID = before
	res.SerializedBytes = anchorSize

	if anchorSize > maxBytes {
		// Oversized anchor: return it ALONE. has_older reflects whether older
		// messages exist beyond the anchor (i.e. anchorIdx > 0).
		res.Items = page
		res.HasOlder = anchorIdx > 0
		res.OversizedItem = true
		res.ActualBytes = anchorSize
		res.BudgetBytes = maxBytes
		res.MessageCount = 1
		return res
	}

	countLimited := false
	bytesLimited := false
	for i := anchorIdx - 1; i >= 0; i-- {
		m := list[i]
		size := messageSerializedBytes(m)
		if len(page)+1 > maxCount {
			countLimited = true
			break
		}
		if res.SerializedBytes+size > maxBytes {
			bytesLimited = true
			break
		}
		page = append(page, m)
		res.SerializedBytes += size
		res.OldestID = messageIDFromInfo(m.Info)
	}
	res.HasOlder = countLimited || bytesLimited
	res.CountLimited = countLimited
	res.BytesLimited = bytesLimited
	// page was built newest-first (anchor, older, older...); reverse to
	// creation order (oldest first) for the client's verbatim prepend.
	for i, j := 0, len(page)-1; i < j; i, j = i+1, j-1 {
		page[i], page[j] = page[j], page[i]
	}
	res.Items = page
	res.MessageCount = len(page)
	return res
}

// SnapshotMessagesPage is the Store accessor backing the historical-page HTTP
// endpoint (GET /vh/session/{sessionId}/messages?before=...). It captures the
// FULL per-session message list under a read lock (a point-in-time consistent
// view, NOT the bounded window Snapshot carries), paginates it via
// projectMessagePage outside the lock, and stamps the envelope with the session
// id + daemon epoch + baseline seq so the client can correlate the page with a
// snapshot cursor and run its Contract-B freshness check.
//
// Pure read: performs NO writeback and bumps NO msgRev (mirrors Snapshot). The
// Contract-B freshness contract is enforced CLIENT-SIDE (Phase 4): the server
// stamps X-VH-Seq / X-VH-Epoch via the stampMeta middleware at request entry,
// and the client discards the page if the session mutated during the flight
// (the dirty-flag mechanism, NOT a server-side retry loop).
//
// limit / maxBytes <= 0 fall back to the package WindowMaxCount / WindowMaxBytes
// defaults so the endpoint is safe to call with no query params beyond `before`.
func (s *Store) SnapshotMessagesPage(sid, before string, limit, maxBytes int) MessagePageResult {
	if limit <= 0 {
		limit = WindowMaxCount
	}
	if maxBytes <= 0 {
		maxBytes = WindowMaxBytes
	}
	s.mu.RLock()
	sm := s.messages[sid]
	epoch := s.epoch
	seq := s.seq
	var full []MessageWithParts
	if sm != nil {
		// Defensive copy of info + each part, exactly as captureMessagesBatchLocked
		// does — the slice escapes the lock and is read during pagination, so a
		// concurrent writer must not observe in-place mutation.
		full = make([]MessageWithParts, 0, len(sm.order))
		for _, mid := range sm.order {
			me := sm.byID[mid]
			if me == nil {
				continue
			}
			parts := make([]json.RawMessage, 0, len(me.partOrder))
			for _, pid := range me.partOrder {
				parts = append(parts, append([]byte(nil), me.parts[pid]...))
			}
			full = append(full, MessageWithParts{
				Info:  append([]byte(nil), me.info...),
				Parts: parts,
			})
		}
	}
	s.mu.RUnlock()
	res := projectMessagePage(full, before, limit, maxBytes)
	res.SessionID = sid
	res.DaemonEpoch = epoch
	res.BaselineSeq = seq
	return res
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
	// subtreeBusyCount is the INCREMENTAL per-node busy aggregate (Gate C
	// de-risking prototype). subtreeBusyCount[id] = the number of busy/retry
	// sessions in id's subtree, INCLUDING id itself when it is busy/retry. It is
	// the count generalization of computeSubtreeBusyLocked's per-node bool (bool
	// = count > 0); maintaining the stricter count invariant proves the
	// incremental-index pattern for the remaining 7 collapsed-frontier indexes.
	//
	// Maintained incrementally at every mutation site that can change it —
	// setActivityLocked (busy-state chokepoint), upsertSessionLocked +
	// Hydrate's direct assign (create/reparent), deleteSessionLocked (delete) —
	// so a Snapshot/SendableNow read is O(1) per node instead of the O(n)
	// computeSubtreeBusyLocked recompute. ADDITIVE prototype: the snapshot path
	// still calls computeSubtreeBusyLocked unchanged; this index coexists and is
	// proven equivalent by TestSubtreeBusyCountProperty (random-mutation
	// differential vs an independent O(n) recompute). Entries exist ONLY for
	// live sessions (sessions in s.sessions); phantom status events for unknown
	// sessionIDs do NOT create entries, matching computeSubtreeBusyLocked's
	// iteration over s.sessions. Guarded by s.mu (same as busyCount).
	subtreeBusyCount map[string]int
	// Phase 1 (Gate C extension): the remaining 7 incremental subtree indexes
	// the collapsed-frontier projection (O1) reads to build roots + active
	// closure + frontier stubs in O(|roots|+|closure|×depth+|frontier|) instead
	// of O(n). ADDITIVE in Phase 1: the snapshot path
	// (computeSubtreeBusyLocked / Snapshot / SendableNow / busyCount[root]) is
	// UNCHANGED — these indexes coexist with the prototype and are proven
	// equivalent to an independent O(n) recompute by TestSubtreeIndexesProperty.
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
	// shape as subtreeBusyCount; pendingInputSelf is the per-session 0/1 shadow
	// so notePendingInputChangeLocked can resolve a delta without re-deriving
	// the prior self from the already-mutated perms/questions maps).
	children               map[string][]string // parentID→ordered child ids; ""=roots (in sync with rootIDs)
	rootIDs                []string            // ordered live roots (orphans included)
	subtreeRetryCount      map[string]int
	subtreePendingInput    map[string]int
	pendingInputSelf       map[string]int // per-session own (0/1); delta-resolution shadow for subtreePendingInput
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
	// window walk is O(buckets-in-window). recentBucketRetentionMinutes bounds
	// the number of buckets retained (memory-bounded; generous vs the default
	// 10-min projection cutoff in Phase 6).
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
	// structuralRevision is the Store-wide monotonic per-epoch counter for the
	// collapsed-frontier projection (Phase 3, Gate B). It is bumped under s.mu
	// on every projection-affecting mutation (session create/delete/reparent,
	// activity change, permission/question asked/replied). Stamped in every
	// Snapshot envelope so the client can discard stale responses (<), skip
	// idempotent re-applies (==), and apply fresh state (>). Modeled EXACTLY on
	// nextMsgRev: Store-wide (not per-session), zero is never handed out via bump
	// (first bump yields 1), and 0 = "fresh store, no mutations" — emitted via
	// omitempty so the client treats an absent field as "old server, always
	// apply". Not reset within a single Store lifetime (epoch is per-process:
	// newEpoch at New, never reassigned), so the counter is monotonic per-epoch
	// by construction; a new Store (new process/epoch) starts fresh at 0.
	structuralRevision uint64
	// frontierSeq (Phase 2 tunnel-amp finding B) is the DIAGNOSTICS-ONLY
	// monotonic counter for collapsed-frontier membership changes. It mirrors
	// the same predicate as the per-event ClientEvent.FrontierChanged flag
	// (retained for observability — not yet wired to /vh/diag/latency). The
	// stream handler's promotion-coalesce arm gates on FrontierChanged, NOT on
	// this counter.
	//
	// BUMPED on: session create/reparent (upsertSessionLocked, hydrate);
	// delete (deleteSessionLocked); pending-input boundary change
	// (notePendingInputChangeLocked); the FIRST activity of a previously-
	// inactive (>cutoff) session (setActivityLocked). NOT bumped on busy↔retry
	// flips, metadata-only session.updated, or any activity transition of an
	// already-selfActive session.
	//
	// DISTINCT from structuralRevision: structuralRevision bumps on EVERY
	// activity transition + every upsert (the client uses it for staleness/
	// idempotency guards and MUST stay coarse). frontierSeq is the narrower
	// signal. atomic.Uint64 so the diagnostics reader is lock-free via
	// FrontierSeq().
	frontierSeq atomic.Uint64
	// curFrontierChanged (Phase 2 finding B) is set to true by the frontier
	// bump sites BEFORE the accompanying emit() call, so emit() can stamp
	// ClientEvent.FrontierChanged. emit() resets it to false after stamping.
	// The stream handler gates the promotion coalesce arm on this per-event
	// flag (wantsProject(r) && ev.FrontierChanged).
	curFrontierChanged bool
	// demotionGen (Phase 2 demotion sweep) is a SEPARATE atomic signal from
	// curFrontierChanged / frontierSeq. The event-driven amplifier gate
	// (ev.FrontierChanged) stays exactly as-is; this signal carries ONLY
	// time-driven demotion (a session aging past the projection cutoff with no
	// accompanying event). The sweep goroutine (RunDemotionSweep) Add(1)s it
	// when it detects the active closure has SHRUNK since the last
	// notification. Each handleStream independently compares it to its own
	// last-seen value (via DemotionGen) and arms the promotion path when it has
	// advanced — so EVERY concurrent proj=1 stream ships the demotion snapshot
	// (mirroring how ev.FrontierChanged fans out per-event), not just one. The
	// earlier store-global consuming CAS (timeFrontierChanged /
	// ConsumeTimeFrontierChange) delivered to exactly ONE stream and lost
	// demotions across multi-tab viewers.
	demotionGen atomic.Uint64
	// lastNotifiedClosure (Phase 2 demotion sweep) is the baseline active-closure
	// the sweep compares against to detect time-driven SHRINK. It mirrors "what
	// clients currently see" — updated both by SnapshotProjected (the authority
	// for the client's view) and by the sweep itself (so its baseline advances).
	// Stored as an atomic.Pointer[map[string]bool] so concurrent RLock holders
	// (multiple projected streams flushing promotions) can update it race-free
	// without upgrading to the write lock. The pointed-to map is treated as
	// immutable after store (computeActiveClosureLocked returns a fresh map each
	// call). Nil (zero value) on a fresh store → the first sweep tick
	// initializes it WITHOUT signaling (first-tick safety).
	lastNotifiedClosure atomic.Pointer[map[string]bool]
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
	// recentlyArchived is the short-TTL tombstone set by RemoveSessions (the
	// archive path). It prevents a stale session.updated / session.compacted
	// arriving with archived=null (because OpenCode rewrote the record from a
	// pre-PATCH snapshot on a busy/compacting descendant) from RESURRECTING an
	// archived session back into the live tree. Guarded by s.mu; lazily
	// GC'd on read (isRecentlyArchivedLocked). Cleared by Hydrate for a
	// genuinely active session (the authoritative reconcile — e.g. unarchive).
	// See recentArchiveTTL.
	recentlyArchived map[string]time.Time

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
		epoch:            newEpoch(),
		sessions:         map[string]*sessionEntry{},
		messages:         map[string]*sessionMessages{},
		todos:            map[string]json.RawMessage{},
		perms:            map[string]map[string]json.RawMessage{},
		questions:        map[string]map[string]json.RawMessage{},
		permBlocked:      map[string]bool{},
		statuses:         map[string]json.RawMessage{},
		activity:         map[string]string{},
		activitySeq:      map[string]uint64{},
		unread:           map[string]bool{},
		busyCount:        map[string]int{},
		subtreeBusyCount: map[string]int{},
		// Phase 1 (Gate C extension): the remaining 7 incremental subtree
		// indexes. Maps are non-nil; rootIDs / recentBucketKeys start nil and
		// are grown by rootsAppendLocked / insertRecentBucketKeyLocked.
		children:               map[string][]string{},
		subtreeRetryCount:      map[string]int{},
		subtreePendingInput:    map[string]int{},
		pendingInputSelf:       map[string]int{},
		subtreeDescendantCount: map[string]int{},
		lastActivityAt:         map[string]time.Time{},
		subtreeNewestActivity:  map[string]time.Time{},
		recentBucket:           map[int64][]string{},
		msgLoaded:              map[string]bool{},
		msgRev:                 map[string]uint64{},
		coldFetchActive:        map[string]bool{},
		seeded:                 map[string]bool{},
		recentlyArchived:       map[string]time.Time{},
		ring:                   newRingBuffer(ringCapacity),
		subs:                   map[int]*subscriber{},
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

// bumpStructuralRevisionLocked advances the Store-wide structural revision
// counter for the collapsed-frontier projection (Phase 3 Gate B). Caller must
// hold s.mu. Exactly one bump per projection-affecting mutation — the client
// uses the stamped value to discard stale snapshot responses (<), skip
// idempotent re-applies (==), and apply fresh state (>). Zero is never handed
// out: the first bump yields 1, so 0 remains a safe "fresh store, never
// mutated" sentinel (omitted from JSON via omitempty).
//
// Phase 4: the stream handler detects structural-change by inspecting the
// event KIND (isStructuralKind), NOT via a separate KindStructuralChange event.
// This avoids doubling the event volume on every mutation. See
// isStructuralKind for the complete list.
func (s *Store) bumpStructuralRevisionLocked() {
	s.structuralRevision++
}

// bumpFrontierSeqLocked advances the collapsed-frontier-membership counter
// (Phase 2 finding B). Caller must hold s.mu. Bumped only at genuine
// frontier-change sites (create/delete/reparent, pending-input boundary,
// first activity of a previously-inactive session). See Store.frontierSeq.
func (s *Store) bumpFrontierSeqLocked() {
	s.frontierSeq.Add(1)
}

// FrontierSeq returns the current frontier-membership counter. Lock-free
// (atomic load). DIAGNOSTICS-ONLY: retained for observability (not yet wired
// to the /vh/diag/latency endpoint). The stream handler does NOT call this —
// the promotion-arm gate uses the per-event ClientEvent.FrontierChanged flag.
func (s *Store) FrontierSeq() uint64 {
	return s.frontierSeq.Load()
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
	ev := ClientEvent{Seq: s.seq, Kind: kind, Payload: payload, ingestNano: s.curEmitIngest, FrontierChanged: s.curFrontierChanged}
	s.curFrontierChanged = false
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
// setActivityLocked records an activity transition using the REAL wall-clock
// now (the live Apply path). It is the original entry point; the at-parameterized
// variant below is the O1 fix path used by status-reconcile/hydrate.
func (s *Store) setActivityLocked(sessionID, st string) {
	s.setActivityAtLocked(sessionID, st, time.Now())
}

// setActivityAtLocked is setActivityLocked with an explicit activity timestamp
// `at` (O1 fix): the status-reconcile/hydrate path seeds `at` from the
// session's own time.updated so a reconcile does NOT stamp now and spuriously
// promote a long-idle session into the recent-activity window. `now` is still
// captured separately for the cutoff boundary (the "within the activity window"
// check must use real wall-clock now). Both touchActivityTimeLocked and
// touchRecentBucketLocked use the SAME stampTime so the two indexes never
// disagree: refRecentBucket derives bucket membership from lastActivityAt (set
// by touchActivityTimeLocked), so the bucket MUST use the same timestamp.
// stampTime is `at` when it carries upstream recency (non-zero), else real now
// (original behavior for the live Apply path, which passes time.Now(), and for
// sessions whose info lacks time.updated).
func (s *Store) setActivityAtLocked(sessionID, st string, at time.Time) {
	// Archive tombstone (Issue 4 B-i): a busy status for a recently-archived
	// id (the subagent is still running) must NOT record activity or emit for
	// it — otherwise the periodic status reconcile re-marks it busy →
	// re-promotes it back into the active closure. The tombstone suppresses
	// this; upsertSessionLocked already blocks the session from re-entering
	// s.sessions, so this guard additionally prevents a phantom activity
	// emit. Expires per recentArchiveTTL; Hydrate clears for genuinely active.
	if s.isRecentlyArchivedLocked(sessionID) {
		return
	}
	prev := s.activity[sessionID]
	if prev == st {
		return
	}
	// Phase 2 (finding B): compute whether this is a genuine promotion BEFORE
	// the emit, so the event's FrontierChanged flag is deterministic (the
	// earlier global-counter gate raced with the aggregator's concurrent
	// poll-loop re-applies). A genuine promotion (inactive stub → busy) changes
	// frontier membership; an activity flip of a session that was ALREADY
	// selfActive does NOT (it stays materialized regardless of busy↔retry /
	// busy→idle). Uses `prev` activity + the OLD lastActivityAt
	// (touchActivityTimeLocked below overwrites it to stampTime). `now` (real
	// wall-clock) drives only the cutoff boundary; stampTime drives the activity
	// time + bucket so a status-reconcile can seed recency from time.updated
	// without spuriously promoting a long-idle session (O1 fix).
	now := time.Now()
	// O1 fix: stampTime is the single timestamp both touchActivityTimeLocked and
	// touchRecentBucketLocked use — they MUST agree because refRecentBucket
	// derives bucket membership from lastActivityAt. stampTime is `at` (upstream
	// session.time.updated) when non-zero, else real now (live Apply path +
	// sessions lacking time.updated keep original behavior).
	stampTime := at
	if stampTime.IsZero() {
		stampTime = now
	}
	_, cutoffDuration := projectionCutoff()
	wasCutoff := now.Add(-cutoffDuration)
	wasSelfActive := prev == ActivityBusy || prev == ActivityRetry ||
		s.pendingInputSelf[sessionID] > 0
	if !wasSelfActive {
		if t := s.lastActivityAt[sessionID]; !t.IsZero() && t.After(wasCutoff) {
			wasSelfActive = true
		}
	}
	// Phase 2 (finding B): curFrontierChanged (stamped onto the emitted event)
	// and frontierSeq (retained diagnostics counter) MUST advance from the same
	// predicate so the two never diverge. Both bump here, before the
	// wasBusy==isBusy early-return below — a non-busy transition of a cold
	// session (e.g. session.error) is still a genuine promotion that must bump
	// both, even though wasBusy==isBusy would skip the subtreeBusyCount block.
	if !wasSelfActive && s.sessions[sessionID] != nil {
		s.curFrontierChanged = true
		s.bumpFrontierSeqLocked()
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

	// Phase 1 (Gate C extension): maintain the 7 remaining incremental subtree
	// indexes at every REAL activity transition. retry-count, activity-time,
	// and the recent bucket must update on busy-neutral transitions too
	// (busy↔retry, error→idle), so this block runs BEFORE the wasBusy==isBusy
	// early-return below. Each helper is phantom-guarded (no-op when sessionID
	// is not yet in the live tree — the contribution is seeded on create via
	// the upsert maintainers).
	s.maintainSubtreeRetryOnActivityLocked(sessionID, prev, st)
	s.touchActivityTimeLocked(sessionID, stampTime)
	s.touchRecentBucketLocked(sessionID, stampTime)
	// Phase 3 (Gate B): every real activity transition (including busy-neutral
	// busy↔retry, error→idle) is a projection-affecting structural change.
	s.bumpStructuralRevisionLocked()

	// Track the root subtree's busy count to detect "finished" (busy -> idle).
	wasBusy := prev == ActivityBusy || prev == ActivityRetry
	isBusy := st == ActivityBusy || st == ActivityRetry
	if wasBusy == isBusy {
		return
	}

	// Incremental subtreeBusyCount maintenance (Gate C de-risk prototype).
	// A real busy↔non-busy flip changes id's own contribution by ±1 and every
	// live ancestor's aggregate by ±1. Guarded on live-tree membership: a
	// phantom status event for an unknown sessionID must NOT create an index
	// entry (computeSubtreeBusyLocked iterates s.sessions only); the own-
	// contribution for a phantom-busy-then-created session is seeded in
	// upsertSessionLocked / Hydrate when it enters the live tree.
	if s.sessions[sessionID] != nil {
		delta := 1
		if !isBusy {
			delta = -1
		}
		s.subtreeBusyCount[sessionID] += delta
		s.adjustAncestorSubtreeBusyLocked(sessionID, delta)
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

// --- incremental subtreeBusyCount maintenance (Gate C de-risk prototype) ---
//
// These helpers maintain s.subtreeBusyCount incrementally. The reference is
// computeSubtreeBusyLocked (O(n) recompute, UNCHANGED — the snapshot path still
// calls it). The invariant each helper preserves:
//
//	subtreeBusyCount[id] == (1 if activity[id] is busy/retry else 0)
//	                     + Σ subtreeBusyCount[child] for each live child of id
//
// for every id in s.sessions. Three sites mutate it:
//   - setActivityLocked: own-contribution ±1 + propagate to ancestors
//   - upsertSessionLocked + Hydrate direct-assign: create/reparent
//   - deleteSessionLocked: remove + propagate to ancestors
//
// All callers hold s.mu (the index lives under the same lock as busyCount).

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
		// O1 fix: seed the activity timestamp from the session's OWN time.updated
		// (reconstructed state), NOT wall-clock now. A status reconcile/hydrate
		// stamps real activity recency so a long-idle session is not spuriously
		// promoted into the recent-activity window. Falls back to now when the
		// session or its time.updated is absent/zero.
		at := activityTimeFromSessionLocked(s, sid)
		s.setActivityAtLocked(sid, a, at)
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
			s.setActivityAtLocked(sid, ActivityIdle, activityTimeFromSessionLocked(s, sid))
		}
	}
	for sid := range s.sessions {
		clearActivity(sid)
	}
	for sid := range s.messages {
		clearActivity(sid)
	}
}

// activityTimeFromSessionLocked extracts the session's time.updated (unix ms)
// as a time.Time for the O1 status-reconcile recency seed. Returns the zero
// time.Time (→ setActivityAtLocked falls back to the cutoff `now` boundary and
// touchActivityTimeLocked skips the monotonic-advance when zero) when the
// session or its time.updated is absent. Caller holds s.mu.
func activityTimeFromSessionLocked(s *Store, sid string) time.Time {
	se := s.sessions[sid]
	if se == nil {
		return time.Time{}
	}
	var partial struct {
		Time struct {
			Updated *float64 `json:"updated"`
		} `json:"time"`
	}
	if json.Unmarshal(se.info, &partial) != nil || partial.Time.Updated == nil {
		return time.Time{}
	}
	return time.UnixMilli(int64(*partial.Time.Updated))
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
			// Phase 1 (Gate C extension): pending-input chokepoint. Phantom-
			// guarded (no-op when SessionID is not yet live; the contribution
			// is seeded on create via maintainSubtreePendingInputOnSessionUpsertLocked).
			s.notePendingInputChangeLocked(p.SessionID)
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
			// Phase 1 (Gate C extension): pending-input chokepoint.
			s.notePendingInputChangeLocked(p.SessionID)
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
			// Phase 1 (Gate C extension): pending-input chokepoint.
			s.notePendingInputChangeLocked(p.SessionID)
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
			// Phase 1 (Gate C extension): pending-input chokepoint.
			s.notePendingInputChangeLocked(p.SessionID)
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
	// Archive tombstone (Issue 4 B-i): a session.updated / session.compacted
	// arriving with archived=null for an id that was recently archived (via
	// RemoveSessions) is the transient clobber — OpenCode rewrote the record
	// from a pre-PATCH snapshot while a busy/compacting descendant was still
	// running. Suppress the resurrection; the live tree stays clean until the
	// tombstone expires or Hydrate confirms the session is genuinely active
	// (unarchive). Without this the session re-enters s.sessions and the next
	// busy status re-promotes it.
	if s.isRecentlyArchivedLocked(env.ID) {
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
	// Incremental subtreeBusyCount maintenance (Gate C de-risk prototype):
	// create / reparent. Must run AFTER s.sessions[env.ID] is written (the
	// helper reads the live entry for the same-parent fast path) and BEFORE the
	// emit so a concurrent Snapshot reader (under RLock) never observes a
	// half-updated index. See maintainSubtreeBusyOnSessionUpsertLocked.
	s.maintainSubtreeBusyOnSessionUpsertLocked(env.ID, prev, env.ParentID)
	// Phase 1 (Gate C extension): maintain the 7 remaining indexes. ORDER
	// MATTERS: topology (children) first so the newest-activity local-max
	// recompute reads a consistent children[id]; sums (retry / pendingInput /
	// descendant) in any order (each scans s.sessions independently for the
	// fresh-create orphan reabsorption, matching the prototype); newestActivity
	// last (reads s.children[id]). All no-ops on the same-effective-parent
	// fast path; all under s.mu, before the emit so a concurrent Snapshot
	// reader never observes a half-updated index.
	s.maintainChildrenOnSessionUpsertLocked(env.ID, prev, env.ParentID)
	s.maintainSubtreeRetryOnSessionUpsertLocked(env.ID, prev, env.ParentID)
	s.maintainSubtreePendingInputOnSessionUpsertLocked(env.ID, prev, env.ParentID)
	s.maintainSubtreeDescendantOnSessionUpsertLocked(env.ID, prev, env.ParentID)
	s.maintainNewestActivityOnSessionUpsertLocked(env.ID, prev, env.ParentID)
	// Phase 3 (Gate B): session create / reparent is a projection-affecting
	// structural change (tree topology or a session's info bytes changed).
	s.bumpStructuralRevisionLocked()
	// Phase 2 (finding B): only a genuine frontier change bumps the counter.
	// Create (prev==nil) or reparent (parent changed) changes which sessions
	// are materialized vs collapsed; a metadata-only session.updated (same
	// effective parent) does NOT and must not arm a promotion re-snapshot.
	frontierChanged := prev == nil || prev.parentID != env.ParentID
	if frontierChanged {
		s.bumpFrontierSeqLocked()
	}
	// A session.updated replaces the entry, so repopulate the denormalized
	// last-assistant summary from the (persisted) message view.
	s.recomputeLastAssistantLocked(env.ID)
	if frontierChanged {
		s.curFrontierChanged = true
	}
	s.emit(KindSessionUpsert, p.Info)
}

func (s *Store) deleteSessionLocked(id string) {
	// Incremental subtreeBusyCount maintenance (Gate C de-risk prototype):
	// propagate id's whole-subtree contribution out of every live ancestor
	// BEFORE unlinking (we need the entry to read id's parentID and the index
	// entry to read the subtree count). Descendants become orphaned roots on
	// delete; their own subtreeBusyCount values are self-contained (X was their
	// parent, not child) and need no adjustment, matching computeSubtreeBusyLocked.
	if sub := s.subtreeBusyCount[id]; sub != 0 {
		if se := s.sessions[id]; se != nil {
			s.adjustAncestorChainFromLocked(se.parentID, -sub)
		}
	}
	// Phase 1 (Gate C extension): maintain the 7 remaining indexes. Same shape
	// as the prototype busy-delete block above, but unified in one helper
	// (sum-class propagation, topology orphaning + unlink, max-class chain
	// recompute, bucket removal). Must run BEFORE the per-session delete(...)
	// calls — we read se.parentID + the index entries to resolve subtrees.
	if se := s.sessions[id]; se != nil {
		s.maintainIndexesOnDeleteLocked(id, se)
	}
	// Phase 3 (Gate B): session deletion is a projection-affecting structural
	// change (the tree loses a node; descendants may be orphaned to roots).
	s.bumpStructuralRevisionLocked()
	// Phase 2 (finding B): deletion changes the frontier membership.
	s.bumpFrontierSeqLocked()
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
	delete(s.subtreeBusyCount, id) // Gate C de-risk prototype index
	// Phase 1 (Gate C extension): drop id's own entries from each new index.
	delete(s.children, id) // direct-child list (already emptied by orphaning)
	delete(s.subtreeRetryCount, id)
	delete(s.subtreePendingInput, id)
	delete(s.pendingInputSelf, id)
	delete(s.subtreeDescendantCount, id)
	delete(s.lastActivityAt, id)
	delete(s.subtreeNewestActivity, id)
	// Clear the automated-spawn permission-blocked fact on termination. This is
	// the single session-removal chokepoint (live session.deleted, archive via
	// time.archived, and hydrate prune all funnel here), so one delete covers
	// every termination cause. Caller accounting keyed on permission_blocked
	// observes it while the session is alive; once gone, the gate is gone too.
	delete(s.permBlocked, id)
	s.curFrontierChanged = true
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
	expiry := time.Now().Add(recentArchiveTTL)
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
		// Phase 1 (Gate C extension): pending-input chokepoint (per add).
		s.notePendingInputChangeLocked(e.SessionID)
		s.emit(KindQuestionSet, raw)
	}
	for sid, m := range s.questions {
		for id := range m {
			if !seen[sid+"\x00"+id] {
				delete(m, id)
				// Phase 1 (Gate C extension): pending-input chokepoint (per delete).
				s.notePendingInputChangeLocked(sid)
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
		// Phase 1 (Gate C extension): pending-input chokepoint (per add).
		s.notePendingInputChangeLocked(e.SessionID)
		s.emit(KindPermissionSet, raw)
	}
	for sid, m := range s.perms {
		for id := range m {
			if !seen[sid+"\x00"+id] {
				delete(m, id)
				// Phase 1 (Gate C extension): pending-input chokepoint (per delete).
				s.notePendingInputChangeLocked(sid)
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
		// Collapse byte-identical duplicates to match Snapshot.Permissions
		// exactly (TestPendingPermissionsMatchesSnapshot pins the two paths to
		// the same set). See dedupRawMessages for the lossless / order-
		// preserving contract.
		list = dedupRawMessages(list)
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
	// Apply the per-part text cap (P1-AGG-006) on the wholesale path: a single
	// part.upsert carrying a huge payload (or a history-fetch entry) is bounded
	// here. capPartJSON is a no-op for parts under the cap. discardPartDelta
	// below reseeds the accumulator from this capped authoritative text, so the
	// next streaming delta appends onto a cap-respecting base.
	part = capPartJSON(part)
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

// recentArchiveTTL is how long RemoveSessions' tombstone suppresses
// resurrection of an archived session by a stale session.updated /
// session.compacted arriving with archived=null (OpenCode can rewrite the
// full record from a pre-PATCH snapshot while a busy/compacting descendant
// is still running). A package-level var (not const) so tests can shrink it
// for deterministic expiry assertions. The TTL must cover the transient
// clobber window; the web layer's archive re-assert (handleArchive) and the
// periodic resync provide additional self-heal. The tombstone is cleared only
// by the explicit unarchive flow (ClearArchiveTombstones); Hydrate does NOT
// clear it, because a hydrate can't tell a genuine unarchive from a stale
// clobber (both carry archived=null).
var recentArchiveTTL = 30 * time.Second

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
// A package-level var (not const) for the same reason as deltaFlushInterval:
// tests can shrink it to a few bytes for deterministic truncation assertions.
// The cap is a STOPGAP guardrail; a larger transcript-windowing fix will
// follow separately and is intentionally out of scope here.
var partTextCap = 1 << 20 // 1 MiB

// truncatedMarker returns the visible cap-reached marker that gets appended to
// a sealed part field. omitted is the number of original output bytes that were
// dropped (len(original) - partTextCap). The marker is deterministic given N,
// so a part sealed twice from the same input produces byte-identical text —
// this is what preserves the monotonic revision validation contract under
// truncation (no false staleness discard).
func truncatedMarker(omitted int) string {
	return "\n…[output truncated: " + strconv.Itoa(omitted) + " further bytes omitted]…"
}

// applyCapToString bounds s to partTextCap bytes, appending truncatedMarker if
// truncation occurred. Returns the (possibly truncated) string and a flag
// indicating whether truncation was applied. The cap lands on a UTF-8 rune
// boundary so the result is always valid UTF-8 (a mid-rune cut would otherwise
// be re-marshal'd by encoding/json as U+FFFD, lossy and nondeterministic under
// some decoders). Same input → same output (deterministic).
//
// Returns s unchanged if len(s) <= partTextCap.
func applyCapToString(s string) (string, bool) {
	if len(s) <= partTextCap {
		return s, false
	}
	omitted := len(s) - partTextCap
	marker := truncatedMarker(omitted)
	cut := partTextCap - len(marker)
	if cut < 0 {
		cut = 0
	}
	// Back up to the largest rune boundary <= cut so we don't end mid-codepoint.
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + marker, true
}

// capPartJSON applies partTextCap to every string field of the part JSON
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
func capPartJSON(part json.RawMessage) json.RawMessage {
	if len(part) <= partTextCap {
		// Fast path: the entire JSON envelope is under the cap, so no string
		// field at any depth can be over it either. Avoids an unmarshal+marshal
		// pair on every wholesale upsert.
		return part
	}
	var p map[string]any
	if json.Unmarshal(part, &p) != nil {
		return part
	}
	if !capStringsInPlace(p) {
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
func capStringsInPlace(v any) bool {
	switch x := v.(type) {
	case map[string]any:
		changed := false
		for k, item := range x {
			if s, ok := item.(string); ok {
				if capped, truncated := applyCapToString(s); truncated {
					x[k] = capped
					changed = true
				}
			} else if capStringsInPlace(item) {
				changed = true
			}
		}
		return changed
	case []any:
		changed := false
		for i, item := range x {
			if s, ok := item.(string); ok {
				if capped, truncated := applyCapToString(s); truncated {
					x[i] = capped
					changed = true
				}
			} else if capStringsInPlace(item) {
				changed = true
			}
		}
		return changed
	default:
		// Numbers, bools, json.Number, nil — no string to cap.
		return false
	}
}

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
	// Per-part text cap (P1-AGG-006 guardrail): if this (partID, field) is
	// already sealed at the cap, drop the delta — the part's text is frozen
	// at the cap with the truncation marker. Otherwise append and re-check
	// the cap; if the accumulated text crossed it, truncate to (cap - marker)
	// and append a visible marker recording the omitted byte count, then seal
	// so further deltas are dropped. Bounds store memory regardless of upstream
	// output volume (a 100 MB bash stdout stays at the cap). The throttle flush
	// below persists the sealed text into me.parts naturally. Sealing is
	// deterministic: same input → same truncated text + marker → revision
	// validation is not falsely invalidated.
	if me.sealedFields == nil || !me.sealedFields[key] {
		buf.WriteString(delta)
		if buf.Len() > partTextCap {
			// strings.Builder has no truncate-in-place; rebuild.
			capped, _ := applyCapToString(buf.String())
			buf.Reset()
			buf.WriteString(capped)
			if me.sealedFields == nil {
				me.sealedFields = map[string]bool{}
			}
			me.sealedFields[key] = true
		}
	}

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
// Also clears the matching sealed-fields entries: a fresh authoritative base
// re-evaluates the cap from scratch. Caller holds s.mu.
func discardPartDeltaLocked(me *messageEntry, partID string) {
	if me == nil {
		return
	}
	if me.deltaBuf != nil {
		for k := range me.deltaBuf {
			if pid, _, ok := strings.Cut(k, "\x00"); ok && pid == partID {
				delete(me.deltaBuf, k)
			}
		}
	}
	if me.sealedFields != nil {
		for k := range me.sealedFields {
			if pid, _, ok := strings.Cut(k, "\x00"); ok && pid == partID {
				delete(me.sealedFields, k)
			}
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
	// Phase 3 (Gate B): capture the structural revision under the read lock so
	// the stamped value is consistent with the captured state.
	structuralRevision := s.structuralRevision
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
		Epoch:              epoch,
		Seq:                seq,
		StructuralRevision: structuralRevision,
		Messages:           map[string][]MessageWithParts{},
		MessageWindows:     map[string]WindowMeta{},
		Todos:              map[string]json.RawMessage{},
		Permissions:        map[string][]json.RawMessage{},
		Questions:          map[string][]json.RawMessage{},
		Statuses:           map[string]json.RawMessage{},
		Activity:           map[string]string{},
		Gate:               map[string]GateFacts{},
		LastAgents:         map[string]string{},
		CurrentVerbs:       map[string]VerbFacet{},
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
		// Collapse byte-identical duplicates (the permission-array bloat fix).
		// LOSSLESS and order-preserving; see dedupRawMessages. Applied here at
		// the materialization phase so the wire payload is the authoritative
		// deduped set without touching s.perms (the store's source of truth
		// keeps every entry keyed by its permID — a future permission.delete
		// for any one id still clears correctly through PendingPermissions /
		// the live emit path).
		out = dedupRawMessages(out)
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
		// Bound the per-session message list to the recent-window tail. Pure:
		// operates on the already-materialized `out` (a private copy), no store
		// access. Deterministic: same captured state → same bounded list + same
		// WindowMeta, which is what preserves the pure-projection invariant
		// (Snapshot never bumps msgRev, and the window adds no nondeterminism).
		// The full list is materialized first (this is the status quo — the
		// capture loop walks sm.order in full); the window bound is a WIRE/
		// browser-memory fix, not a store-memory optimization.
		bounded, meta := projectMessageWindow(out, WindowMaxCount, WindowMaxBytes)
		snap.Messages[sid] = bounded
		snap.MessageWindows[sid] = meta
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
		// Skip tombstoned ids. A hydrate cannot distinguish a GENUINE unarchive
		// (archived=null because the operator restored it) from a STALE CLOBBER
		// (archived=null because OpenCode rewrote the record from a pre-PATCH
		// snapshot while a busy descendant was still running) — both look
		// identical here. Re-inserting would defeat the tombstone precisely
		// during the re-assert window it protects. The tombstone is cleared
		// ONLY by the explicit unarchive flow (ClearArchiveTombstones, called
		// by handleArchive after the direct-SQLite unarchive succeeds); it also
		// expires via recentArchiveTTL. Hydrate assigns s.sessions directly
		// (bypassing upsertSessionLocked, whose own guard would otherwise fire),
		// so this skip must live HERE.
		if s.isRecentlyArchivedLocked(env.ID) {
			continue
		}
		seen[env.ID] = true
		if old := s.sessions[env.ID]; old == nil || !bytes.Equal(old.info, info) {
			s.sessions[env.ID] = &sessionEntry{id: env.ID, parentID: env.ParentID, info: info}
			// Incremental subtreeBusyCount maintenance (Gate C de-risk
			// prototype): Hydrate assigns s.sessions directly (bypassing
			// upsertSessionLocked), so it must maintain the index here too.
			// `old` is the prev entry (nil for a fresh create). Covers the same
			// create / same-parent / reparent cases as upsertSessionLocked.
			s.maintainSubtreeBusyOnSessionUpsertLocked(env.ID, old, env.ParentID)
			// Phase 1 (Gate C extension): same 5 maintainers as
			// upsertSessionLocked (Hydrate assigns s.sessions directly,
			// bypassing upsertSessionLocked, so it must maintain every index).
			// Order: topology → sums → newestActivity. See upsertSessionLocked.
			s.maintainChildrenOnSessionUpsertLocked(env.ID, old, env.ParentID)
			s.maintainSubtreeRetryOnSessionUpsertLocked(env.ID, old, env.ParentID)
			s.maintainSubtreePendingInputOnSessionUpsertLocked(env.ID, old, env.ParentID)
			s.maintainSubtreeDescendantOnSessionUpsertLocked(env.ID, old, env.ParentID)
			s.maintainNewestActivityOnSessionUpsertLocked(env.ID, old, env.ParentID)
			// Phase 3 (Gate B): hydrate create/reparent is a projection-affecting
			// structural change.
			s.bumpStructuralRevisionLocked()
			// Phase 2 (finding B): only a genuine frontier change (create or
			// reparent) bumps the counter — mirrors upsertSessionLocked. A
			// metadata-only hydrate refresh (same effective parent) does NOT
			// change frontier membership.
			if old == nil || old.parentID != env.ParentID {
				s.bumpFrontierSeqLocked()
				s.curFrontierChanged = true
			}
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
		// covers unflushed streaming text.) sealedFields is cleared in the same
		// branch: a fresh authoritative base re-evaluates the cap from scratch.
		if !(coldLoad && len(me.liveTouchedParts) > 0) {
			me.deltaBuf = nil
			me.deltaLastEmit = time.Time{}
			me.sealedFields = nil
		}

		seenPart := make(map[string]bool, len(mwp.Parts))
		for _, part := range mwp.Parts {
			var pe partEnvelope
			if json.Unmarshal(part, &pe) != nil || pe.ID == "" {
				continue
			}
			seenPart[pe.ID] = true
			// Apply the per-part text cap (P1-AGG-006) on the history-fetch
			// path: a fetched part carrying pathological text is bounded here
			// (the wholesale upsert path caps via upsertPartLocked; this path
			// writes me.parts directly so it must cap independently). capPartJSON
			// is a no-op for parts under the cap.
			part = capPartJSON(part)
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
// The returned list is the BOUNDED recent-window tail (projectMessageWindow),
// not the full transcript: the cold-load messages.batch ships only the initial
// window, and older messages arrive via the historical HTTP page endpoint. The
// returned WindowMeta describes the window (has_older, limits, oversized) so
// packageMessagesBatch can carry it in the outer payload without decompression.
// The revision token is still the FULL-state msgRev[sid] (the bound is pure and
// deterministic, so the revision gate's equality check remains sound).
func (s *Store) captureMessagesBatchLocked(sid string) ([]MessageWithParts, uint64, WindowMeta) {
	sm := s.messages[sid]
	if sm == nil {
		return nil, s.msgRev[sid], WindowMeta{} // defensive: no message state (empty fetch / deleted)
	}
	full := make([]MessageWithParts, 0, len(sm.order))
	for _, mid := range sm.order {
		me := sm.byID[mid]
		if me == nil {
			continue
		}
		parts := make([]json.RawMessage, 0, len(me.partOrder))
		for _, pid := range me.partOrder {
			parts = append(parts, append([]byte(nil), me.parts[pid]...))
		}
		full = append(full, MessageWithParts{
			Info:  append([]byte(nil), me.info...),
			Parts: parts,
		})
	}
	bounded, meta := projectMessageWindow(full, WindowMaxCount, WindowMaxBytes)
	return bounded, s.msgRev[sid], meta
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
//	{"sessionID": sid, "encoding":"gzip64", "data":"<base64-gzip>", "window": {...}}
//
// sessionID stays PLAIN TEXT so payloadSessionID (store interest filter) and
// sendable() (web egress filter) keep extracting it — replacing the whole
// payload with a base64 blob would silently drop the batch for Stream-2
// (open-session) subscribers. Only the heavy messages array is compressed:
// "data" is base64( gzip( {"messages":[...]} ) ). base64 is required because
// SSE data: fields are text/UTF-8 and raw gzip bytes are not valid UTF-8.
// Always-compress policy (the batch only fires for cold-loads, which are
// non-trivial by nature, so there is no small-payload case worth a threshold).
//
// "window" carries the WindowMeta ALONGSIDE sessionID/encoding/data so a client
// reads has_older / count / limits WITHOUT decompressing the gzip'd messages
// array (decompression is the expensive step the window is meant to defer).
func packageMessagesBatch(sid string, list []MessageWithParts, window WindowMeta) json.RawMessage {
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
		SessionID string     `json:"sessionID"`
		Encoding  string     `json:"encoding"`
		Data      string     `json:"data"`
		Window    WindowMeta `json:"window"`
	}{SessionID: sid, Encoding: "gzip64", Data: base64.StdEncoding.EncodeToString(buf.Bytes()), Window: window})
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
		list, rev, window := s.captureMessagesBatchLocked(sid)
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
		payload := packageMessagesBatch(sid, list, window)
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
	list, _, window := s.captureMessagesBatchLocked(sid)
	if list == nil {
		return ColdBatchSessionGone
	}
	payload := packageMessagesBatch(sid, list, window)
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

// SessionIDs returns the ids of the LIVE (active) sessions in this store's
// project scope. Archived sessions are excluded: archive via time.archived
// funnels through deleteSessionLocked and removes them from s.sessions, so
// only currently-active ids appear here. This live-only set is the
// authoritative input to queue orphan reconciliation (reconcileQueuesForAgg),
// which relies on archived ids being ABSENT to treat their leftover
// queue.json files as orphans that get cleaned up — returning archived ids
// here would silently retain those files forever. Distinct from HasSession's
// per-id O(1) check.
func (s *Store) SessionIDs() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(s.sessions))
	for id := range s.sessions {
		out = append(out, id)
	}
	return out
}

// HasSession reports whether sid is a member of this store's project scope.
// Cheap O(1) RLock + map lookup. Used for project-isolation guards at the HTTP
// boundary and as a defense-in-depth backstop in the aggregator. Distinct from
// SessionIDs (O(n) alloc + copy) because per-filter-ID checks need O(1).
func (s *Store) HasSession(sid string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.sessions[sid]
	return ok
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
