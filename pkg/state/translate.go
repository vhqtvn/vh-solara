// Package state: the versioned event-translation boundary (slice #3 — the
// contract/translator rewire). This file owns the NORMALIZED contract the state
// layer consumes and the single Translator that produces it from raw
// opencode.Event. It is adapted from paseo's AgentStreamEvent model (AGPL: the
// MODEL is adapted, never the code — this is a clean-room Go implementation
// written from the study's prose invariants).
//
// WHY A TRANSLATOR (what collapsed). Before this slice, Apply scattered ~15
// inline `json.Unmarshal(ev.Properties, &anonymousStruct)` parses across its
// switch arms — one per wire event type, each deciding the handler AND extracting
// that handler's routing fields. That made opencode's wire shape load-bearing in
// 15 places: an event-shape change was a 16th arm, not a translator swap. This
// file is the SINGLE place opencode wire-JSON is parsed for ROUTING. Apply now
// switches on NormalizedEvent.Kind and consumes typed routing fields; it never
// re-parses wire JSON for routing.
//
// BEHAVIOR-PRESERVING (the F4 fold is the ONE intentional change). TranslatorV1
// replicates EXACTLY the per-arm parsing + validity guards that used to live
// inline in Apply, so the rewire is a pure refactor modulo F4 (session.error
// arms liveIdleObserved — see Apply's NormSessionTerminalError arm). Parse
// failure / failed guard → NormIgnored (Apply no-ops), matching the prior
// `if json.Unmarshal(...) == nil && <guard>` skip semantics. The opaque Raw
// payload is stored/emitted byte-identically by the handlers (no re-serialization
// → no behavior change); the translator EXTRACTS it but does NOT interpret it.
// The deep parse inside a handler (e.g. upsertMessageLocked parsing info into
// messageInfoEnvelope) is handler DOMAIN logic on an already-extracted blob, not
// Apply-level routing — it stays put.
//
// WHAT THIS SLICE DOES NOT DO (deferred). The tool-call callId defensive-parsing
// invariant (paseo ToolCallDetail: a part with no callId is DROPPED, never
// synthesized) is NOT enforced here — current pass-through store-all-parts
// behavior is preserved. Enforcing it is its own slice with its own RED test
// (attribution: a behavioral change in the same commit that restructures the
// code the net-tests guard would re-baseline those tests). See the F4 follow-up.
package state

import (
	"encoding/json"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// NormalizedKind enumerates the normalized event kinds the state layer consumes.
// Apply switches on these (never on raw opencode "type" strings). Distinct type
// AND distinct Norm* names from the client-facing string emit kinds (KindStatus,
// KindTodo, … store.go) — no collision. Adding/removing a kind is a versioned
// translator change.
type NormalizedKind int

const (
	// NormIgnored: server.connected / heartbeat / instance.disposed / file.* —
	// or a wire payload that failed its validity guard. Apply no-ops.
	NormIgnored NormalizedKind = iota
	// NormSessionUpsert: session.created/updated/compacted. Raw = the WHOLE raw
	// opencode properties (upsertSessionLocked parses {info} itself).
	NormSessionUpsert
	NormSessionDelete
	// NormSessionStatus: session.status — AUTHORITATIVE runner status
	// (busy|retry|idle). StatusType carries opencode's status.type.
	NormSessionStatus
	// NormSessionTerminalIdle: session.idle — an OBSERVED turn terminal. Apply
	// arms liveIdleObserved (the #2696 discriminator) on this kind.
	NormSessionTerminalIdle
	// NormSessionTerminalError: session.error — an OBSERVED turn terminal. Apply
	// arms liveIdleObserved on this kind TOO (F4: the guard's coverage widens
	// from {session.idle} to {session.idle, session.error}).
	NormSessionTerminalError
	// NormSessionDiff: session.diff — a status snapshot that stores + emits but
	// drives no activity/turn-state change (the shared status-family prefix only).
	NormSessionDiff
	NormMessageUpsert
	NormMessageRemove
	NormPartUpsert
	NormPartDelta
	NormPartRemove
	NormTodoUpsert
	NormPermissionSet
	NormPermissionClear
	NormQuestionSet
	NormQuestionClear
)

// NormalizedEvent is the opencode-agnostic event the state layer consumes. The
// typed routing fields (SessionID/MessageID/PartID/Field/Delta/StatusType/ID) are
// what the state layer DECIDES on; Raw is the opaque payload handlers STORE/EMIT
// byte-identically (no re-serialization → no behavior change). Per kind, Raw
// carries: NormSessionUpsert / the NormSession* status family / NormTodoUpsert /
// NormPermissionSet → the whole raw opencode properties; NormMessageUpsert → the
// message info sub-blob; NormPartUpsert → the part sub-blob. (Unused for the
// remove/clear kinds.)
type NormalizedEvent struct {
	Kind      NormalizedKind
	SessionID string
	MessageID string
	PartID    string
	// Field + Delta are NormPartDelta's streaming-text routing fields.
	Field string
	Delta string
	// StatusType is NormSessionStatus's opencode status.type (busy/retry/idle/…).
	StatusType string
	// ID is the primary entity id, per kind: NormPermissionSet = the permission
	// request id; NormPermissionClear = the resolved clear-id (requestID or
	// permissionID); NormQuestionSet = the question id; NormQuestionClear = the
	// request id.
	ID  string
	Raw json.RawMessage
}

// Translator maps one raw opencode.Event to a NormalizedEvent. It is the SINGLE
// VERSIONED boundary at which opencode wire-JSON is parsed for routing. Version()
// is kept even with one implementation today (one method; a future opencode
// event-shape change becomes a translator swap, not a 16th switch arm).
type Translator interface {
	Translate(raw opencode.Event) (NormalizedEvent, error)
	Version() string
}

// TranslatorV1 is the current opencode event-shape ("v1") Translator. Translate
// replicates EXACTLY the per-arm parsing + validity guards that used to live
// inline in Apply, so the rewire is behavior-preserving modulo the F4 fold.
type TranslatorV1 struct{}

// Version is the opencode event-shape version this translator maps.
func (TranslatorV1) Version() string { return "v1" }

// Translate maps a raw opencode event to its NormalizedEvent. A payload that
// fails to parse OR fails its validity guard yields NormIgnored (Apply no-ops),
// matching the prior `if json.Unmarshal(...) == nil && <guard>` skip semantics.
// It never returns a non-nil error today; the error return is retained per the
// approved contract so a future translator can signal a hard failure.
func (TranslatorV1) Translate(raw opencode.Event) (NormalizedEvent, error) {
	switch raw.Type {
	case "session.created", "session.updated", "session.compacted":
		// upsertSessionLocked takes the WHOLE properties (it parses {info} itself),
		// so Raw is the whole raw properties — byte-identical to the prior call.
		return NormalizedEvent{Kind: NormSessionUpsert, Raw: raw.Properties}, nil
	case "session.deleted":
		var p struct {
			Info sessionEnvelope `json:"info"`
		}
		if json.Unmarshal(raw.Properties, &p) != nil || p.Info.ID == "" {
			return NormalizedEvent{Kind: NormIgnored}, nil
		}
		return NormalizedEvent{Kind: NormSessionDelete, SessionID: p.Info.ID}, nil
	case "session.status", "session.idle", "session.error", "session.diff":
		var p struct {
			SessionID string `json:"sessionID"`
			Status    struct {
				Type string `json:"type"`
			} `json:"status"`
		}
		if json.Unmarshal(raw.Properties, &p) != nil || p.SessionID == "" {
			return NormalizedEvent{Kind: NormIgnored}, nil
		}
		ne := NormalizedEvent{SessionID: p.SessionID, StatusType: p.Status.Type, Raw: raw.Properties}
		switch raw.Type {
		case "session.status":
			ne.Kind = NormSessionStatus
		case "session.idle":
			ne.Kind = NormSessionTerminalIdle
		case "session.error":
			ne.Kind = NormSessionTerminalError
		case "session.diff":
			ne.Kind = NormSessionDiff
		}
		return ne, nil
	case "message.updated":
		var p struct {
			Info json.RawMessage `json:"info"`
		}
		if json.Unmarshal(raw.Properties, &p) != nil || len(p.Info) == 0 {
			return NormalizedEvent{Kind: NormIgnored}, nil
		}
		return NormalizedEvent{Kind: NormMessageUpsert, Raw: p.Info}, nil
	case "message.removed":
		var p struct {
			SessionID string `json:"sessionID"`
			MessageID string `json:"messageID"`
		}
		if json.Unmarshal(raw.Properties, &p) != nil {
			return NormalizedEvent{Kind: NormIgnored}, nil
		}
		return NormalizedEvent{Kind: NormMessageRemove, SessionID: p.SessionID, MessageID: p.MessageID}, nil
	case "message.part.updated":
		var p struct {
			Part json.RawMessage `json:"part"`
		}
		if json.Unmarshal(raw.Properties, &p) != nil || len(p.Part) == 0 {
			return NormalizedEvent{Kind: NormIgnored}, nil
		}
		return NormalizedEvent{Kind: NormPartUpsert, Raw: p.Part}, nil
	case "message.part.delta":
		var p struct {
			SessionID string `json:"sessionID"`
			MessageID string `json:"messageID"`
			PartID    string `json:"partID"`
			Field     string `json:"field"`
			Delta     string `json:"delta"`
		}
		if json.Unmarshal(raw.Properties, &p) != nil || p.SessionID == "" || p.PartID == "" || p.Delta == "" {
			return NormalizedEvent{Kind: NormIgnored}, nil
		}
		return NormalizedEvent{Kind: NormPartDelta, SessionID: p.SessionID, MessageID: p.MessageID, PartID: p.PartID, Field: p.Field, Delta: p.Delta}, nil
	case "message.part.removed":
		var p struct {
			SessionID string `json:"sessionID"`
			MessageID string `json:"messageID"`
			PartID    string `json:"partID"`
		}
		if json.Unmarshal(raw.Properties, &p) != nil {
			return NormalizedEvent{Kind: NormIgnored}, nil
		}
		return NormalizedEvent{Kind: NormPartRemove, SessionID: p.SessionID, MessageID: p.MessageID, PartID: p.PartID}, nil
	case "todo.updated":
		var p struct {
			SessionID string `json:"sessionID"`
		}
		if json.Unmarshal(raw.Properties, &p) != nil || p.SessionID == "" {
			return NormalizedEvent{Kind: NormIgnored}, nil
		}
		return NormalizedEvent{Kind: NormTodoUpsert, SessionID: p.SessionID, Raw: raw.Properties}, nil
	case "permission.asked", "permission.updated":
		// OpenCode emits "permission.asked"; "permission.updated" is kept for
		// compatibility. Properties are the permission Request ({id, sessionID, …}).
		var p permissionEnvelope
		if json.Unmarshal(raw.Properties, &p) != nil || p.SessionID == "" || p.ID == "" {
			return NormalizedEvent{Kind: NormIgnored}, nil
		}
		return NormalizedEvent{Kind: NormPermissionSet, SessionID: p.SessionID, ID: p.ID, Raw: raw.Properties}, nil
	case "permission.replied":
		// OpenCode sends {sessionID, requestID, reply}; older/fixture payloads use
		// permissionID. Normalize so the clear (keyed by the resolved id) always
		// fires.
		var p struct {
			SessionID    string `json:"sessionID"`
			RequestID    string `json:"requestID"`
			PermissionID string `json:"permissionID"`
		}
		if json.Unmarshal(raw.Properties, &p) != nil || p.SessionID == "" {
			return NormalizedEvent{Kind: NormIgnored}, nil
		}
		id := p.RequestID
		if id == "" {
			id = p.PermissionID
		}
		return NormalizedEvent{Kind: NormPermissionClear, SessionID: p.SessionID, ID: id}, nil
	case "question.asked":
		var p struct {
			ID        string `json:"id"`
			SessionID string `json:"sessionID"`
		}
		if json.Unmarshal(raw.Properties, &p) != nil || p.SessionID == "" || p.ID == "" {
			return NormalizedEvent{Kind: NormIgnored}, nil
		}
		return NormalizedEvent{Kind: NormQuestionSet, SessionID: p.SessionID, ID: p.ID, Raw: raw.Properties}, nil
	case "question.replied", "question.rejected":
		var p struct {
			SessionID string `json:"sessionID"`
			RequestID string `json:"requestID"`
		}
		if json.Unmarshal(raw.Properties, &p) != nil || p.SessionID == "" {
			return NormalizedEvent{Kind: NormIgnored}, nil
		}
		return NormalizedEvent{Kind: NormQuestionClear, SessionID: p.SessionID, ID: p.RequestID}, nil
	default:
		// server.connected / heartbeat / instance.disposed / file.* — ignored for the view.
		return NormalizedEvent{Kind: NormIgnored}, nil
	}
}
