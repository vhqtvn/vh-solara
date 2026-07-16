package state

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"io"
	"reflect"
	"sort"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

func ev(t, props string) opencode.Event {
	return opencode.Event{Type: t, Properties: json.RawMessage(props)}
}

func TestReducerBuildsTreeAndMessages(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a","title":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"b","parentID":"a","title":"child"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"user"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"hi"}}`))

	snap := s.Snapshot(nil)
	if len(snap.Sessions) != 2 {
		t.Fatalf("want 2 sessions, got %d", len(snap.Sessions))
	}
	msgs := snap.Messages["a"]
	if len(msgs) != 1 {
		t.Fatalf("want 1 message in session a, got %d", len(msgs))
	}
	if len(msgs[0].Parts) != 1 {
		t.Fatalf("want 1 part, got %d", len(msgs[0].Parts))
	}

	// Child parent linkage is preserved in the raw session payload.
	var foundChild bool
	for _, raw := range snap.Sessions {
		var e sessionEnvelope
		_ = json.Unmarshal(raw, &e)
		if e.ID == "b" && e.ParentID == "a" {
			foundChild = true
		}
	}
	if !foundChild {
		t.Fatal("child session b with parentID a not found")
	}
}

func TestReducerDeleteSession(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a","title":"root"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a"}}`))
	s.Apply(ev("session.deleted", `{"info":{"id":"a"}}`))

	snap := s.Snapshot(nil)
	if len(snap.Sessions) != 0 {
		t.Fatalf("want 0 sessions after delete, got %d", len(snap.Sessions))
	}
	if _, ok := snap.Messages["a"]; ok {
		t.Fatal("messages for deleted session should be cleared")
	}
}

func TestSnapshotMessageScoping(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"b"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"ma","sessionID":"a"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"mb","sessionID":"b"}}`))

	// Tree-only (empty, non-nil filter): no messages.
	if got := s.Snapshot(map[string]bool{}); len(got.Messages) != 0 {
		t.Fatalf("tree-only snapshot should have no messages, got %d", len(got.Messages))
	}
	// Scoped to "a": only a's messages.
	scoped := s.Snapshot(map[string]bool{"a": true})
	if _, ok := scoped.Messages["a"]; !ok {
		t.Fatal("scoped snapshot missing session a messages")
	}
	if _, ok := scoped.Messages["b"]; ok {
		t.Fatal("scoped snapshot should not include session b messages")
	}
}

func TestPartStreamingUpsertInPlace(t *testing.T) {
	s := New(100)
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"a","messageID":"m1","text":"he"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"a","messageID":"m1","text":"hello"}}`))

	snap := s.Snapshot(nil)
	parts := snap.Messages["a"][0].Parts
	if len(parts) != 1 {
		t.Fatalf("streaming should update part in place, got %d parts", len(parts))
	}
	var p struct{ Text string }
	_ = json.Unmarshal(parts[0], &p)
	if p.Text != "hello" {
		t.Fatalf("want latest text 'hello', got %q", p.Text)
	}
}

func TestActivityDerivation(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	s.Apply(ev("session.status", `{"sessionID":"a","status":{"type":"busy"}}`))
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityBusy {
		t.Fatalf("want busy, got %q", got)
	}
	s.Apply(ev("session.idle", `{"sessionID":"a"}`))
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityIdle {
		t.Fatalf("want idle, got %q", got)
	}
	s.Apply(ev("session.error", `{"sessionID":"a"}`))
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityError {
		t.Fatalf("want error, got %q", got)
	}
}

func TestActivityReconcileClearsTerminatedSession(t *testing.T) {
	s := New(100)
	// A session mid-generation: an incomplete assistant turn, marked busy.
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","time":{"created":1}}}`))
	s.Apply(ev("session.status", `{"sessionID":"a","status":{"type":"busy"}}`))
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityBusy {
		t.Fatalf("precondition: want busy, got %q", got)
	}
	// On re-hydrate, /session/status no longer reports it busy (the turn was
	// terminated while generating). The reconcile must clear it to idle so the
	// UI stops spinning — even though its last message is still incomplete.
	s.SetActivityFromStatuses(map[string]json.RawMessage{})
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityIdle {
		t.Fatalf("want idle after reconcile, got %q", got)
	}
}

func TestActivityFromMessageStream(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	// No session.status event at all — busy is derived from the live message
	// stream (OpenCode's status can lag a streaming turn). An incomplete
	// assistant message means the turn is generating.
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","time":{"created":1}}}`))
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityBusy {
		t.Fatalf("incomplete assistant should be busy, got %q", got)
	}
	// Streaming deltas keep it busy.
	s.Apply(ev("message.part.delta", `{"sessionID":"a","messageID":"m1","partID":"p1","field":"text","delta":"hi"}`))
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityBusy {
		t.Fatalf("streaming delta should stay busy, got %q", got)
	}
	// Completing a single assistant message does NOT idle the session: a
	// multi-step turn (text → tool → text) completes one assistant message
	// before the next step starts, and inferring idle from that gap fired a
	// spurious "finished" notification per step. Idle is owned by session.idle.
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","time":{"created":1,"completed":2}}}`))
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityBusy {
		t.Fatalf("completed assistant alone should stay busy (idle owned by session.idle), got %q", got)
	}
	// The authoritative session.idle settles it.
	s.Apply(ev("session.idle", `{"sessionID":"a"}`))
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityIdle {
		t.Fatalf("session.idle should settle to idle, got %q", got)
	}
}

func partText(snap Snapshot, sid, partID string) string {
	for _, mw := range snap.Messages[sid] {
		for _, raw := range mw.Parts {
			var p struct {
				ID, Text string
			}
			if json.Unmarshal(raw, &p) == nil && p.ID == partID {
				return p.Text
			}
		}
	}
	return ""
}

// partTextFromRaw decodes a single part json.RawMessage (as stored in
// me.parts[partID]) and returns its "text" field. Used by purity assertions
// that inspect the STORE's internal me.parts (not a Snapshot projection, which
// overlays buffered deltas) to prove Snapshot did not write back into me.parts.
func partTextFromRaw(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var p struct {
		Text string
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatalf("partTextFromRaw unmarshal %q: %v", string(raw), err)
	}
	return p.Text
}

func TestPartDeltaAccumulatesStreaming(t *testing.T) {
	s := New(100)
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":""}}`))
	s.Apply(ev("message.part.delta", `{"sessionID":"a","messageID":"m1","partID":"p1","field":"text","delta":"Hel"}`))
	s.Apply(ev("message.part.delta", `{"sessionID":"a","messageID":"m1","partID":"p1","field":"text","delta":"lo"}`))
	if got := partText(s.Snapshot(map[string]bool{"a": true}), "a", "p1"); got != "Hello" {
		t.Fatalf("want accumulated 'Hello', got %q", got)
	}
	// A later full snapshot overwrites authoritatively.
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"Hello, world"}}`))
	if got := partText(s.Snapshot(map[string]bool{"a": true}), "a", "p1"); got != "Hello, world" {
		t.Fatalf("want 'Hello, world' after snapshot, got %q", got)
	}
}

func TestPartDeltaBeforePartCreatesIt(t *testing.T) {
	s := New(100)
	// Delta can arrive before the part.updated that creates the part.
	s.Apply(ev("message.part.delta", `{"sessionID":"a","messageID":"m1","partID":"p1","field":"text","delta":"hi"}`))
	if got := partText(s.Snapshot(map[string]bool{"a": true}), "a", "p1"); got != "hi" {
		t.Fatalf("want 'hi' from delta-created part, got %q", got)
	}
}

func TestPermissionAskedSurfacesAndRepliedClears(t *testing.T) {
	s := New(100)
	// OpenCode emits "permission.asked" (the Request) — not "permission.updated".
	s.Apply(ev("permission.asked", `{"id":"per_1","sessionID":"a","permission":"bash","title":"run x"}`))
	if got := s.Snapshot(nil).Permissions["a"]; len(got) != 1 {
		t.Fatalf("want 1 pending permission after permission.asked, got %d", len(got))
	}
	// And clears with {sessionID, requestID} (not permissionID).
	s.Apply(ev("permission.replied", `{"sessionID":"a","requestID":"per_1","reply":"once"}`))
	if got := s.Snapshot(nil).Permissions["a"]; len(got) != 0 {
		t.Fatalf("want permission cleared after reply, got %d", len(got))
	}
}

// normalizePerms converts a map[sessionID][]json.RawMessage into an order-
// independent form (sessionID -> sorted raw strings) so two reads can be
// compared regardless of map/slice iteration order.
func normalizePerms(m map[string][]json.RawMessage) map[string][]string {
	out := make(map[string][]string, len(m))
	for sid, list := range m {
		ss := make([]string, len(list))
		for i, raw := range list {
			ss[i] = string(raw)
		}
		sort.Strings(ss)
		out[sid] = ss
	}
	return out
}

// TestPendingPermissionsRoundTrip verifies SetPendingPermissions (the rehydrate
// path) is readable through PendingPermissions with the expected shape.
func TestPendingPermissionsRoundTrip(t *testing.T) {
	s := New(100)
	s.SetPendingPermissions([]json.RawMessage{
		json.RawMessage(`{"id":"p1","sessionID":"a","permission":"bash"}`),
		json.RawMessage(`{"id":"p2","sessionID":"a","permission":"edit"}`),
		json.RawMessage(`{"id":"p3","sessionID":"b","permission":"bash"}`),
	})
	got := s.PendingPermissions()
	if len(got) != 2 {
		t.Fatalf("want 2 sessions with pending perms, got %d (%v)", len(got), got)
	}
	if len(got["a"]) != 2 {
		t.Fatalf("session a want 2 perms, got %d", len(got["a"]))
	}
	if len(got["b"]) != 1 {
		t.Fatalf("session b want 1 perm, got %d", len(got["b"]))
	}
	// An unknown session returns no entry (map zero value is nil).
	if _, ok := got["nope"]; ok {
		t.Fatal("unknown session must not appear in the map")
	}
}

// TestPendingPermissionsMatchesSnapshot is the core correctness property for
// switching the reconcile loop off Snapshot: PendingPermissions must surface the
// SAME pending set Snapshot.Permissions does (the reconcile loop must not see a
// different set of permissions to reject). Both paths iterate the same store
// field, so this is a parity assertion against the prior source of truth.
func TestPendingPermissionsMatchesSnapshot(t *testing.T) {
	s := New(100)
	s.SetPendingPermissions([]json.RawMessage{
		json.RawMessage(`{"id":"p1","sessionID":"a","permission":"bash"}`),
		json.RawMessage(`{"id":"p2","sessionID":"a","permission":"edit"}`),
		json.RawMessage(`{"id":"p3","sessionID":"b","permission":"bash"}`),
	})
	// A live event arriving between the two reads must be visible to both in the
	// same way: add one more for a then read both back-to-back.
	s.Apply(ev("permission.asked", `{"id":"p4","sessionID":"a","permission":"web"}`))

	want := normalizePerms(s.Snapshot(nil).Permissions)
	got := normalizePerms(s.PendingPermissions())
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("PendingPermissions diverged from Snapshot.Permissions:\n got=%v\nwant=%v", got, want)
	}
}

// TestPendingPermissionsOmitsEmptyInnerMap is the empty-inner-map parity edge
// case for advisory D1. A session key can linger in s.perms with a zero-length
// inner map when its last perm is deleted but the session itself is not yet
// removed — reachable via the permission.replied handler and the
// SetPendingPermissions reconcile (store.go delete-before-removal paths).
// Snapshot.Permissions omits such a session entirely (it only assigns a key
// inside the append loop), so PendingPermissions must omit it too rather than
// emitting out[sid] = []json.RawMessage{}.
func TestPendingPermissionsOmitsEmptyInnerMap(t *testing.T) {
	s := New(100)
	// Seed a real perm for session "a", then reply to clear it. After the reply,
	// s.perms["a"] still exists (the replied handler deletes the inner entry,
	// not the session key) but its inner map is empty — the exact divergence
	// state. A second session "b" keeps a real perm so the maps aren't trivially
	// empty.
	s.Apply(ev("permission.asked", `{"id":"per_1","sessionID":"a","permission":"bash","title":"run x"}`))
	s.Apply(ev("permission.asked", `{"id":"per_2","sessionID":"b","permission":"edit","title":"edit y"}`))
	s.Apply(ev("permission.replied", `{"sessionID":"a","requestID":"per_1","reply":"once"}`))

	// Both reads must OMIT session "a" (the empty-inner-map session) and keep
	// session "b" (the populated one). Parity holds on both sides.
	snapPerms := s.Snapshot(nil).Permissions
	got := s.PendingPermissions()

	if _, ok := snapPerms["a"]; ok {
		t.Fatalf(`Snapshot.Permissions must omit the empty-inner-map session "a", got %v`, snapPerms["a"])
	}
	if _, ok := got["a"]; ok {
		t.Fatalf(`PendingPermissions must omit the empty-inner-map session "a", got %v`, got["a"])
	}
	if _, ok := snapPerms["b"]; !ok || len(snapPerms["b"]) != 1 {
		t.Fatalf(`Snapshot.Permissions must still surface populated session "b" with 1 perm, got %v`, snapPerms["b"])
	}
	if _, ok := got["b"]; !ok || len(got["b"]) != 1 {
		t.Fatalf(`PendingPermissions must still surface populated session "b" with 1 perm, got %v`, got["b"])
	}

	// And the two readers agree on the whole map (the core parity property,
	// now including the empty-inner-map edge).
	if !reflect.DeepEqual(normalizePerms(got), normalizePerms(snapPerms)) {
		t.Fatalf("PendingPermissions diverged from Snapshot.Permissions on the empty-inner-map edge:\n got=%v\nwant=%v",
			normalizePerms(got), normalizePerms(snapPerms))
	}
}

// TestPendingPermissionsReturnsIndependentCopies asserts the structural copy
// contract: the returned outer map and per-session slices are independent of the
// store, so a caller mutating the returned structure (adding/removing keys,
// appending to a slice) cannot corrupt the store's pending-permission state.
// (The underlying json.RawMessage byte arrays are intentionally shared with the
// store, matching Snapshot.Permissions — callers treat them as read-only.)
func TestPendingPermissionsReturnsIndependentCopies(t *testing.T) {
	s := New(100)
	s.SetPendingPermissions([]json.RawMessage{
		json.RawMessage(`{"id":"p1","sessionID":"a","permission":"bash"}`),
	})
	got := s.PendingPermissions()

	// Mutate the returned structure: add a fake session, drop a real one, append
	// to a slice, and reassign a slice entry. None of this may reach the store.
	got["injected"] = []json.RawMessage{json.RawMessage(`{"id":"evil","sessionID":"x"}`)}
	delete(got, "a")
	got["a"] = append(got["a"], json.RawMessage(`{"id":"extra","sessionID":"a"}`))

	// A fresh read must be unaffected.
	again := s.PendingPermissions()
	if _, ok := again["injected"]; ok {
		t.Fatal("mutating the returned map must not add sessions to the store")
	}
	if len(again["a"]) != 1 {
		t.Fatalf("session a still wants 1 perm after caller mutated its returned copy, got %d", len(again["a"]))
	}
	// Snapshot.Permissions (the other reader of the same field) must agree.
	if len(s.Snapshot(nil).Permissions["a"]) != 1 {
		t.Fatal("Snapshot.Permissions must also be unaffected by caller mutation of the PendingPermissions result")
	}
}

func TestSetActivityFromStatuses(t *testing.T) {
	s := New(100)
	ch, unsub := s.Subscribe(8)
	defer unsub()
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		"a": json.RawMessage(`{"type":"busy"}`),
		"b": json.RawMessage(`{"type":"idle"}`),
	})
	snap := s.Snapshot(nil)
	if snap.Activity["a"] != ActivityBusy || snap.Activity["b"] != ActivityIdle {
		t.Fatalf("seed failed: %+v", snap.Activity)
	}
	// at least one activity event emitted
	select {
	case e := <-ch:
		if e.Kind != KindActivity {
			t.Fatalf("want activity event, got %s", e.Kind)
		}
	default:
		t.Fatal("expected an activity event")
	}
}

func TestGateFactsFinishAndUsage(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	// In-flight assistant turn: no finish, not completed → busy, not "completed".
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","time":{"created":1}}}`))
	g := s.Snapshot(nil).Gate["a"]
	if g.Activity != ActivityBusy {
		t.Fatalf("in-flight turn: want busy, got %q", g.Activity)
	}
	if g.LastAssistantCompleted {
		t.Fatal("in-flight turn must not report last_assistant_completed")
	}
	if g.FinishReason != "" {
		t.Fatalf("in-flight turn has no finish reason, got %q", g.FinishReason)
	}

	// Turn completes with finish=length and token usage, then session.idle settles.
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","time":{"created":1,"completed":2},"finish":"length","tokens":{"input":10,"output":20,"total":30}}}`))
	s.Apply(ev("session.idle", `{"sessionID":"a"}`))
	g = s.Snapshot(nil).Gate["a"]
	if g.Activity != ActivityIdle {
		t.Fatalf("after idle: want idle, got %q", g.Activity)
	}
	if !g.LastAssistantCompleted {
		t.Fatal("completed turn must report last_assistant_completed")
	}
	if g.FinishReason != "length" {
		t.Fatalf("want raw finish reason 'length', got %q", g.FinishReason)
	}
	if g.SubtreeBusy {
		t.Fatal("quiesced session must not report subtree_busy")
	}
	var tok struct{ Input, Output, Total int }
	if json.Unmarshal(g.Tokens, &tok) != nil || tok.Total != 30 {
		t.Fatalf("want raw token usage total=30, got %s", string(g.Tokens))
	}

	// finish_reason survives a session.updated (which replaces the session entry).
	s.Apply(ev("session.updated", `{"info":{"id":"a","title":"renamed"}}`))
	if got := s.Snapshot(nil).Gate["a"].FinishReason; got != "length" {
		t.Fatalf("finish reason must survive session.updated, got %q", got)
	}
}

func TestGateSubtreeBusyAndPendingFlags(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"child","parentID":"root"}}`))
	// A busy subagent makes the root's subtree busy even though the root is idle.
	s.Apply(ev("session.idle", `{"sessionID":"root"}`))
	s.Apply(ev("session.status", `{"sessionID":"child","status":{"type":"busy"}}`))
	snap := s.Snapshot(nil)
	if !snap.Gate["root"].SubtreeBusy {
		t.Fatal("root with a busy child must report subtree_busy")
	}
	if snap.Gate["root"].Activity != ActivityIdle {
		t.Fatalf("root itself is idle, got %q", snap.Gate["root"].Activity)
	}
	if !snap.Gate["child"].SubtreeBusy {
		t.Fatal("busy child reports subtree_busy for itself")
	}

	// Child finishes → root subtree quiesces.
	s.Apply(ev("session.idle", `{"sessionID":"child"}`))
	if s.Snapshot(nil).Gate["root"].SubtreeBusy {
		t.Fatal("root subtree must quiesce after child idles")
	}

	// Pending question/permission gates.
	s.Apply(ev("question.asked", `{"id":"q1","sessionID":"root"}`))
	s.Apply(ev("permission.asked", `{"id":"p1","sessionID":"child","permission":"bash"}`))
	snap = s.Snapshot(nil)
	if !snap.Gate["root"].PendingQuestion || snap.Gate["root"].PendingPermission {
		t.Fatalf("root should have pending question, no permission: %+v", snap.Gate["root"])
	}
	if !snap.Gate["child"].PendingPermission || snap.Gate["child"].PendingQuestion {
		t.Fatalf("child should have pending permission, no question: %+v", snap.Gate["child"])
	}
}

// TestRootCount covers the live-root total that backs the project switcher's
// "X running, Y idle" badge (idle = roots − running). RootCount must (a) count
// ROOTS only — children never count even while attached to a live parent;
// (b) treat an orphaned child (parentID not in the live tree) as its own root,
// matching rootOfLocked / busyCount / RunningRoots; (c) exclude archived
// sessions (archive via time.archived funnels through deleteSessionLocked); and
// (d) never fall below RunningRoots, since both draw from the same population.
func TestRootCount(t *testing.T) {
	s := New(100)

	// Empty store → 0 roots, 0 running.
	if got := s.RootCount(); got != 0 {
		t.Fatalf("empty store: want 0 roots, got %d", got)
	}

	// Children never count: a is a root, a1 is its child. b is a second root.
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"a1","parentID":"a"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"b"}}`))
	if got := s.RootCount(); got != 2 {
		t.Fatalf("two roots (a, b) + one child (a1): want 2 roots, got %d", got)
	}

	// An orphan (parentID not in the live tree) counts as its own root — same
	// orphan-inclusive definition as rootOfLocked / busyCount / RunningRoots.
	s.Apply(ev("session.created", `{"info":{"id":"o","parentID":"ghost"}}`))
	if got := s.RootCount(); got != 3 {
		t.Fatalf("orphan child o: want 3 roots (a, b, o), got %d", got)
	}

	// RootCount draws from the SAME population as RunningRoots (live roots), so
	// roots >= running always holds. Make a's subtree busy via its child a1.
	s.Apply(ev("session.status", `{"sessionID":"a1","status":{"type":"busy"}}`))
	running := s.RunningRoots()
	if running != 1 {
		t.Fatalf("busy child a1 should make 1 running root, got %d", running)
	}
	if roots := s.RootCount(); roots < running {
		t.Fatalf("roots (%d) must be >= running (%d)", roots, running)
	}

	// Archiving a live ROOT removes it from the live tree (time.archived funnels
	// through deleteSessionLocked), so it stops counting. Archived sessions must
	// NOT inflate the idle count. b and o are childless roots, so archiving them
	// drops the count cleanly.
	s.Apply(ev("session.updated", `{"info":{"id":"b","time":{"archived":12345}}}`))
	if got := s.RootCount(); got != 2 {
		t.Fatalf("after archiving root b: want 2 roots (a, o), got %d", got)
	}
	s.Apply(ev("session.updated", `{"info":{"id":"o","time":{"archived":99999}}}`))
	if got := s.RootCount(); got != 1 {
		t.Fatalf("after archiving root o: want 1 root (a), got %d", got)
	}

	// Orphan promotion: deleting root a leaves its child a1 with no live parent,
	// so a1 becomes its own root (matches rootOfLocked's orphan-inclusive walk).
	// The count stays 1 (a out, a1 promoted) — proving children aren't lost,
	// they re-root.
	s.Apply(ev("session.deleted", `{"info":{"id":"a"}}`))
	if got := s.RootCount(); got != 1 {
		t.Fatalf("after deleting root a: want 1 root (a1 promoted), got %d", got)
	}

	// Removing the last session brings it to 0.
	s.Apply(ev("session.deleted", `{"info":{"id":"a1"}}`))
	if got := s.RootCount(); got != 0 {
		t.Fatalf("after deleting a1: want 0 roots, got %d", got)
	}
	if got := s.RunningRoots(); got != 0 {
		t.Fatalf("after deleting the last root: want 0 running, got %d", got)
	}
}

func TestGateLastAssistantEmpty(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	// A completed turn that ended with finish=stop but produced NO text (e.g. an
	// empty stop / tool-only turn) — finish_reason can't distinguish this, the
	// empty flag must.
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","time":{"created":1,"completed":2},"finish":"stop"}}`))
	g := s.Snapshot(nil).Gate["a"]
	if g.FinishReason != "stop" || !g.LastAssistantCompleted {
		t.Fatalf("precondition: want completed stop, got %+v", g)
	}
	if !g.LastAssistantEmpty {
		t.Fatal("a completed assistant message with no text part must be last_assistant_empty=true")
	}

	// Now give it a real text reply → not empty.
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"hello there"}}`))
	if s.Snapshot(nil).Gate["a"].LastAssistantEmpty {
		t.Fatal("a message with a non-whitespace text part must be last_assistant_empty=false")
	}

	// Whitespace-only text still counts as empty.
	s.Apply(ev("session.created", `{"info":{"id":"b"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m2","sessionID":"b","role":"assistant","time":{"created":1,"completed":2},"finish":"stop"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p2","sessionID":"b","messageID":"m2","type":"text","text":"   \n  "}}`))
	if !s.Snapshot(nil).Gate["b"].LastAssistantEmpty {
		t.Fatal("whitespace-only text must be treated as empty")
	}

	// A tool-only turn (no text) is the agent WORKING → NON-empty (don't continue it).
	s.Apply(ev("session.created", `{"info":{"id":"c"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m3","sessionID":"c","role":"assistant","time":{"created":1,"completed":2},"finish":"tool-calls"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p3","sessionID":"c","messageID":"m3","type":"tool","tool":"bash"}}`))
	if s.Snapshot(nil).Gate["c"].LastAssistantEmpty {
		t.Fatal("a tool-only turn must be NON-empty (the agent is working)")
	}

	// An "envelope" turn — reasoning only, no text/tool/file (the GLM empty-stop) →
	// empty.
	s.Apply(ev("session.created", `{"info":{"id":"d"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m4","sessionID":"d","role":"assistant","time":{"created":1,"completed":2},"finish":"stop"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p4","sessionID":"d","messageID":"m4","type":"reasoning","text":"thinking..."}}`))
	if !s.Snapshot(nil).Gate["d"].LastAssistantEmpty {
		t.Fatal("a reasoning-only (no text/tool/file) turn must be empty")
	}
}

func TestGateHydratedFlag(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	// No message state yet (cold/never-opened) → hydrated=false, so a consumer
	// knows last_assistant_completed=false means "unknown", not "in-flight".
	if s.Snapshot(nil).Gate["a"].Hydrated {
		t.Fatal("session with no message state must report hydrated=false")
	}
	// Live message events give us authoritative state → hydrated=true.
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","time":{"created":1,"completed":2},"finish":"stop"}}`))
	g := s.Snapshot(nil).Gate["a"]
	if !g.Hydrated {
		t.Fatal("session with live messages must report hydrated=true")
	}
	if g.FinishReason != "stop" || !g.LastAssistantCompleted {
		t.Fatalf("hydrated session should carry authoritative finish/completed, got %+v", g)
	}
}

func TestSnapshotEpochSetAndStable(t *testing.T) {
	s := New(100)
	e := s.Snapshot(nil).Epoch
	if e == "" || s.Epoch() != e {
		t.Fatalf("epoch must be set and match Epoch(), got snapshot=%q Epoch()=%q", e, s.Epoch())
	}
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	if got := s.Snapshot(nil).Epoch; got != e {
		t.Fatalf("epoch must be stable within a store lifetime, changed %q -> %q", e, got)
	}
	// A distinct store has a distinct epoch.
	if New(100).Snapshot(nil).Epoch == e {
		t.Fatal("two stores must have distinct epochs")
	}
}

func TestHydrateDiffEmitsOnlyChanges(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a","title":"v1"}}`))
	before := s.Snapshot(nil).Seq

	// Re-hydrate with a changed title for a, a new session b, and a gone (omitted).
	s.Hydrate(
		[]json.RawMessage{
			json.RawMessage(`{"id":"a","title":"v2"}`),
			json.RawMessage(`{"id":"b","title":"new"}`),
		},
		map[string][]MessageWithParts{},
	)
	after := s.Snapshot(nil).Seq
	// Expect exactly 2 emits: upsert(a changed) + upsert(b new). No delete.
	if after-before != 2 {
		t.Fatalf("want 2 client events from hydrate, got %d", after-before)
	}

	// Hydrating identical state emits nothing.
	stable := s.Snapshot(nil).Seq
	s.Hydrate(
		[]json.RawMessage{
			json.RawMessage(`{"id":"a","title":"v2"}`),
			json.RawMessage(`{"id":"b","title":"new"}`),
		},
		map[string][]MessageWithParts{},
	)
	if s.Snapshot(nil).Seq != stable {
		t.Fatalf("idempotent hydrate should emit nothing, seq moved from %d to %d", stable, s.Snapshot(nil).Seq)
	}
}

// TestLastAgentTrackedFromAssistantMessages verifies lastAgent is derived from
// the most recent assistant message's info.agent and exposed in the snapshot via
// the LastAgents facet (so the tree renders chips on a cold tree without message
// history). Also covers the cold-seed survival across session.updated.
func TestLastAgentTrackedFromAssistantMessages(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	// A user message carries no agent → no chip yet.
	s.Apply(ev("message.updated", `{"info":{"id":"u1","sessionID":"a","role":"user"}}`))
	if got := s.Snapshot(nil).LastAgents["a"]; got != "" {
		t.Fatalf("no assistant yet: want empty lastAgent, got %q", got)
	}
	// First assistant turn with agent=build.
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","agent":"build"}}`))
	if got := s.Snapshot(nil).LastAgents["a"]; got != "build" {
		t.Fatalf("want lastAgent 'build', got %q", got)
	}
	// A newer assistant message with a different agent overrides.
	s.Apply(ev("message.updated", `{"info":{"id":"m2","sessionID":"a","role":"assistant","agent":"plan"}}`))
	if got := s.Snapshot(nil).LastAgents["a"]; got != "plan" {
		t.Fatalf("newer assistant: want lastAgent 'plan', got %q", got)
	}

	// lastAgent survives a session.updated that replaces the entry (mirrors how
	// finish_reason survives in TestGateFactsFinishAndUsage).
	s.Apply(ev("session.updated", `{"info":{"id":"a","title":"renamed"}}`))
	if got := s.Snapshot(nil).LastAgents["a"]; got != "plan" {
		t.Fatalf("lastAgent must survive session.updated, got %q", got)
	}

	// A session with no assistant message has no lastAgent.
	s.Apply(ev("session.created", `{"info":{"id":"b"}}`))
	if _, ok := s.Snapshot(nil).LastAgents["b"]; ok {
		t.Fatal("session with no assistant must not appear in LastAgents")
	}
}

// TestLastAgentColdSeedPreserved verifies the cold-seed flow: SetLastAgents
// (called by the aggregator hydrate for un-opened sessions) seeds the field, a
// subsequent session.updated preserves it (messages still un-hydrated), and
// opening the session (loading messages) makes the live scan authoritative.
func TestLastAgentColdSeedPreserved(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"cold"}}`))
	// Cold-seed the agent as the aggregator would for an un-opened session.
	s.SetLastAgents(map[string]string{"cold": "build"})
	if got := s.Snapshot(nil).LastAgents["cold"]; got != "build" {
		t.Fatalf("cold-seed: want lastAgent 'build', got %q", got)
	}
	// A metadata refresh (session.updated) must NOT wipe the cold-seed.
	s.Apply(ev("session.updated", `{"info":{"id":"cold","title":"refreshed"}}`))
	if got := s.Snapshot(nil).LastAgents["cold"]; got != "build" {
		t.Fatalf("cold-seed must survive session.updated, got %q", got)
	}
	// Once the session is opened (messages loaded), the live scan takes over —
	// here the loaded history has an assistant with agent=plan, which overrides.
	s.SetSessionMessages("cold", []MessageWithParts{
		{Info: json.RawMessage(`{"id":"a1","sessionID":"cold","role":"user"}`)},
		{Info: json.RawMessage(`{"id":"a2","sessionID":"cold","role":"assistant","agent":"plan"}`)},
	})
	if got := s.Snapshot(nil).LastAgents["cold"]; got != "plan" {
		t.Fatalf("loaded session: want live-derived lastAgent 'plan', got %q", got)
	}
}

// TestSetLastAgentsEmitsLiveEvent pins the fix for the cold-tree chip
// regression: SetLastAgents (the aggregator's background cold seed) must fan out
// a lastAgent.set event per session whose label actually changed, so a client
// already connected when the seed completes receives the label as a live update
// (its first snapshot landed mid-seed with an empty lastAgents map). Emission is
// idempotent (no re-emit for an unchanged value), skips unknown sessions, and
// never broadcasts an empty seed (nothing for the chip to show). Mirrors how
// setCurrentVerbLocked fans activity.verb out for a snapshot-only facet.
func TestSetLastAgentsEmitsLiveEvent(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"b"}}`))
	ch, unsub := s.Subscribe(64)
	defer unsub()

	// First seed: one event per known session, none for the unknown "ghost".
	s.SetLastAgents(map[string]string{"a": "build", "b": "plan", "ghost": "x"})

	type ev struct{ sid, agent string }
	var got []ev
	drain := func() {
		for {
			select {
			case e := <-ch:
				if e.Kind != KindLastAgentSet {
					continue // ignore session.upsert etc.
				}
				var p struct {
					SessionID string `json:"sessionID"`
					Agent     string `json:"agent"`
				}
				if json.Unmarshal(e.Payload, &p) == nil {
					got = append(got, ev{p.SessionID, p.Agent})
				}
			default:
				return
			}
		}
	}
	drain()
	if len(got) != 2 {
		t.Fatalf("seed: want 2 lastAgent.set events (a,b), got %d: %+v", len(got), got)
	}
	byID := map[string]string{}
	for _, e := range got {
		byID[e.sid] = e.agent
	}
	if byID["a"] != "build" || byID["b"] != "plan" {
		t.Fatalf("seed payloads wrong: %+v", byID)
	}
	// Snapshot must still carry both (the event does not replace the snapshot facet).
	snap := s.Snapshot(nil)
	if snap.LastAgents["a"] != "build" || snap.LastAgents["b"] != "plan" {
		t.Fatalf("snapshot lastAgents wrong: %+v", snap.LastAgents)
	}

	// Idempotent: re-seeding the SAME value must NOT re-emit (no fanout spam).
	s.SetLastAgents(map[string]string{"a": "build"})
	got = nil
	drain()
	if len(got) != 0 {
		t.Fatalf("idempotent re-seed must not re-emit, got %d events: %+v", len(got), got)
	}

	// A genuine change DOES re-emit (one event, for the changed session only).
	s.SetLastAgents(map[string]string{"a": "plan", "b": "plan"})
	got = nil
	drain()
	if len(got) != 1 || got[0].sid != "a" || got[0].agent != "plan" {
		t.Fatalf("changed-value re-seed: want one a=plan event, got %+v", got)
	}

	// An empty seed clears the field but must NOT broadcast (nothing to show).
	s.SetLastAgents(map[string]string{"a": ""})
	got = nil
	drain()
	if len(got) != 0 {
		t.Fatalf("empty seed must not broadcast, got %+v", got)
	}
	if s.Snapshot(nil).LastAgents["a"] != "" {
		t.Fatal("empty seed must clear the snapshot facet")
	}
}

// TestColdSeedMemoAndInvalidation covers the reconnect fetch-storm memo at the
// store layer: ColdSeedNeeded reports only un-seeded tracked sessions,
// MarkColdSeeded suppresses them on subsequent queries, and the memo is dropped
// on session removal (the single deleteSessionLocked chokepoint) so a session
// recreated under the same id is re-seeded. Mirrors the aggregator's use.
func TestColdSeedMemoAndInvalidation(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"b"}}`))

	// Initially both are un-seeded; an untracked id is ignored.
	need := s.ColdSeedNeeded([]string{"a", "b", "ghost"})
	if len(need) != 2 {
		t.Fatalf("initial ColdSeedNeeded: want [a b], got %v", need)
	}

	// Seed both: ColdSeedNeeded goes empty for them.
	s.MarkColdSeeded("a")
	s.MarkColdSeeded("b")
	if got := s.ColdSeedNeeded([]string{"a", "b"}); len(got) != 0 {
		t.Fatalf("after seeding both: want [] (both memoized), got %v", got)
	}

	// MarkColdSeeded is a no-op for a session deleted in the race window.
	s.MarkColdSeeded("ghost") // not tracked -> must not be recorded
	if got := s.ColdSeedNeeded([]string{"ghost"}); len(got) != 0 {
		t.Fatalf("untracked session must never be reported as needing seed, got %v", got)
	}

	// Removing "a" (live session.deleted funnels through deleteSessionLocked)
	// drops its memo; recreating it makes it need seeding again. "b" — never
	// removed — must stay seeded (no over-invalidation on an unrelated removal).
	s.Apply(ev("session.deleted", `{"info":{"id":"a"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	need = s.ColdSeedNeeded([]string{"a", "b"})
	if len(need) != 1 || need[0] != "a" {
		t.Fatalf("after remove+recreate of a: want [a] (re-seeded), got %v", need)
	}
	if got := s.ColdSeedNeeded([]string{"b"}); len(got) != 0 {
		t.Fatalf("b must remain seeded (invalidate only on its own removal), got %v", got)
	}
}

// TestRecomputeCurrentVerbRunningThenCleared covers the Tier-A current-activity
// facet (O4 hybrid): a running tool part seeds the facet (surfaced in the
// snapshot so an UNOPENED subagent's "Reading parser.go" renders without loading
// Tier-B messages), and the authoritative idle signal clears it — even though a
// stale part snapshot may still read status:"running".
func TestRecomputeCurrentVerbRunningThenCleared(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"child","parentID":"root"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"child","role":"assistant","time":{"created":1}}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"child","messageID":"m1","type":"tool","tool":"read","state":{"status":"running","input":{"filePath":"src/parser.go"},"time":{"start":4000}}}}`))

	snap := s.Snapshot(map[string]bool{}) // tree-only — messages NOT included
	facet, ok := snap.CurrentVerbs["child"]
	if !ok {
		t.Fatal("tree-only snapshot missing currentVerbs for a session with a running tool")
	}
	if facet.Tool != "read" {
		t.Fatalf("want facet tool 'read', got %q", facet.Tool)
	}
	// The salient state (input + status + time.start) is carried; the client
	// formats it via its existing toolVerb/toolSubject (Path B2).
	var st struct {
		Status string         `json:"status"`
		Input  map[string]any `json:"input"`
		Time   struct {
			Start float64 `json:"start"`
		} `json:"time"`
	}
	if json.Unmarshal(facet.State, &st) != nil {
		t.Fatalf("facet state not valid JSON: %s", facet.State)
	}
	if st.Status != "running" || st.Input["filePath"] != "src/parser.go" || st.Time.Start != 4000 {
		t.Fatalf("facet salient state wrong: status=%q input=%v time=%+v", st.Status, st.Input, st.Time)
	}
	// Tree-only snapshot must NOT have hydrated the child's messages — this is
	// the whole point: the verb renders without Tier-B message data.
	if _, loaded := snap.Messages["child"]; loaded {
		t.Fatal("tree-only snapshot must not carry the child's messages")
	}

	// The session goes idle (turn truly ended). Even if a later part snapshot
	// hadn't flipped the tool to completed, the authoritative idle clears the
	// facet so a stale "Reading …" can't linger.
	s.Apply(ev("session.idle", `{"sessionID":"child"}`))
	if got := s.Snapshot(map[string]bool{}).CurrentVerbs; len(got) != 0 {
		t.Fatalf("want currentVerbs cleared on idle, got %+v", got)
	}
}

// TestRecomputeCurrentVerbPicksNewestRunningTool mirrors the client's
// activeVerbFromTurn precedence: among the newest assistant message's parts, the
// NEWEST running tool wins; a completed tool is skipped in favor of an older
// running one. A non-running latest part does not clear an older running tool.
func TestRecomputeCurrentVerbPicksNewestRunningTool(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"s"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"s","role":"assistant"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"s","messageID":"m1","type":"tool","tool":"bash","state":{"status":"running","input":{"command":"old"},"time":{"start":1000}}}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p2","sessionID":"s","messageID":"m1","type":"tool","tool":"read","state":{"status":"completed"},"time":{"start":2000,"end":2100}}}`))
	// p2 is newer but completed; p1 (older) is still running → facet is p1.
	if got := s.Snapshot(nil).CurrentVerbs["s"].Tool; got != "bash" {
		t.Fatalf("want oldest-running 'bash' when newest tool completed, got %q", got)
	}
	// A newer running tool takes over.
	s.Apply(ev("message.part.updated", `{"part":{"id":"p3","sessionID":"s","messageID":"m1","type":"tool","tool":"grep","state":{"status":"running","input":{"pattern":"TODO"},"time":{"start":3000}}}}`))
	if got := s.Snapshot(nil).CurrentVerbs["s"].Tool; got != "grep" {
		t.Fatalf("want newest running 'grep', got %q", got)
	}
}

// TestCurrentVerbPreservedAcrossSessionUpsert mirrors the lastAgent guarantee:
// a session.updated that replaces the entry (e.g. a metadata/title refresh) must
// NOT wipe a live-set current-activity facet for a running subagent.
func TestCurrentVerbPreservedAcrossSessionUpsert(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"child"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"child","role":"assistant"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"child","messageID":"m1","type":"tool","tool":"read","state":{"status":"running","input":{"filePath":"a.go"},"time":{"start":1}}}}`))
	s.Apply(ev("session.updated", `{"info":{"id":"child","title":"refreshed"}}`))
	if got := s.Snapshot(nil).CurrentVerbs["child"].Tool; got != "read" {
		t.Fatalf("currentVerb must survive session.updated, got %q", got)
	}
}

// drainKind reads all currently-buffered events of `kind` from ch (non-blocking).
func drainKind(ch <-chan ClientEvent, kind string) []ClientEvent {
	var out []ClientEvent
	for {
		select {
		case e := <-ch:
			if e.Kind == kind {
				out = append(out, e)
			}
		default:
			return out
		}
	}
}

// TestActivityVerbEmitOnTransitionNotDelta is the Stream-1 routing contract for
// the Tier-A verb event: a tool transition (running tool appears) emits exactly
// one KindActivityVerb; the per-token delta path (message.part.delta) emits
// NONE; an identical re-upsert is idempotent (no extra emit); idle clears it.
// The event kind is NOT prefixed message./part. so the web layer's sendable()
// always-streams it on the tree-only Stream 1 to every client (mirrors activity).
func TestActivityVerbEmitOnTransitionNotDelta(t *testing.T) {
	s := New(100)
	ch, unsub := s.Subscribe(128)
	defer unsub()
	drainKind(ch, "") // drop the subscribe-time backlog (none, but be safe)

	s.Apply(ev("session.created", `{"info":{"id":"s"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"s","role":"assistant"}}`))
	drainKind(ch, "") // drop session.upsert + message.upsert

	// 1) A running tool appears → exactly one activity.verb carrying tool + state.
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"s","messageID":"m1","type":"tool","tool":"read","state":{"status":"running","input":{"filePath":"src/parser.go"},"output":"","time":{"start":4000}}}}`))
	evs := drainKind(ch, KindActivityVerb)
	if len(evs) != 1 {
		t.Fatalf("running tool: want 1 %s event, got %d", KindActivityVerb, len(evs))
	}
	var p struct {
		SessionID string          `json:"sessionID"`
		Tool      string          `json:"tool"`
		State     json.RawMessage `json:"state"`
	}
	if json.Unmarshal(evs[0].Payload, &p) != nil || p.SessionID != "s" || p.Tool != "read" {
		t.Fatalf("activity.verb payload wrong: %s", evs[0].Payload)
	}
	// State carries salient fields; the mutable `output` is trimmed so growth
	// doesn't re-emit.
	var st map[string]json.RawMessage
	_ = json.Unmarshal(p.State, &st)
	if _, hasOutput := st["output"]; hasOutput {
		t.Fatalf("facet state must trim mutable output, got %s", p.State)
	}

	// 2) Re-upsert the SAME running tool (state byte-stable) → idempotent, no emit.
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"s","messageID":"m1","type":"tool","tool":"read","state":{"status":"running","input":{"filePath":"src/parser.go"},"output":"grow","time":{"start":4000}}}}`))
	if len(drainKind(ch, KindActivityVerb)) != 0 {
		t.Fatal("re-upsert of a stable running tool must not re-emit activity.verb")
	}

	// 3) The per-token delta path must NOT drive verb emission.
	s.Apply(ev("message.part.delta", `{"sessionID":"s","messageID":"m1","partID":"p2","field":"text","delta":"tok"}`))
	if len(drainKind(ch, KindActivityVerb)) != 0 {
		t.Fatal("message.part.delta must not emit activity.verb")
	}

	// 4) Idle clears the facet → one activity.verb with empty tool.
	s.Apply(ev("session.idle", `{"sessionID":"s"}`))
	evs = drainKind(ch, KindActivityVerb)
	if len(evs) != 1 {
		t.Fatalf("idle: want 1 clearing %s event, got %d", KindActivityVerb, len(evs))
	}
	if json.Unmarshal(evs[0].Payload, &p) != nil || p.Tool != "" {
		t.Fatalf("idle clear payload must have empty tool, got %s", evs[0].Payload)
	}
}

// TestGateMessagesLoadedVsHydrated pins the Slice-C gate contract: Hydrated
// conflates "any message state" (live events OR a history hydrate), while
// MessagesLoaded is the STRICT "full history fetched" memo. A session that has
// only received live message.* events has messages[sid]!=nil → Hydrated=true
// but MessagesLoaded MUST be false (the tail of live deltas is not the full
// ordered history). Only SetSessionMessages (the history fetch path) flips
// MessagesLoaded.
func TestGateMessagesLoadedVsHydrated(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	// Cold: no message state at all → both false.
	if g := s.Snapshot(nil).Gate["a"]; g.Hydrated || g.MessagesLoaded {
		t.Fatalf("cold session: want Hydrated=false MessagesLoaded=false, got %+v", g)
	}
	// Live message events populate messages[sid] (Hydrated=true) but do NOT
	// fetch the full history (MessagesLoaded stays false). This is the
	// partial-exists case Slice C must distinguish from fully-loaded.
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","time":{"created":1,"completed":2},"finish":"stop"}}`))
	if g := s.Snapshot(nil).Gate["a"]; !g.Hydrated || g.MessagesLoaded {
		t.Fatalf("live-only session: want Hydrated=true MessagesLoaded=false, got %+v", g)
	}
	// A history fetch (the lazy hydration path) flips MessagesLoaded.
	s.SetSessionMessages("a", nil)
	if g := s.Snapshot(nil).Gate["a"]; !g.Hydrated || !g.MessagesLoaded {
		t.Fatalf("after SetSessionMessages: want Hydrated=true MessagesLoaded=true, got %+v", g)
	}
}

// TestEmitMessagesLoadedError pins the two new completion events: they are
// emitted to subscribers, seq-stamped + recorded in the ring (replayable), and
// carry the sessionID (+ error) payload. The aggregator relies on these to
// signal on-demand-hydration completion/failure to a connected Stream-2 client.
func TestEmitMessagesLoadedError(t *testing.T) {
	s := New(100)
	ch, unsub := s.Subscribe(128)
	defer unsub()
	drainKind(ch, "") // drop subscribe-time backlog

	s.EmitMessagesLoaded("a", 5, 3)
	loaded := drainKind(ch, KindMessagesLoaded)
	if len(loaded) != 1 {
		t.Fatalf("want 1 %s event, got %d", KindMessagesLoaded, len(loaded))
	}
	var p1 struct {
		SessionID   string
		FetchMs     int64
		ReconcileMs int64
	}
	if json.Unmarshal(loaded[0].Payload, &p1) != nil || p1.SessionID != "a" {
		t.Fatalf("messages.loaded payload must carry sessionID:a, got %s", loaded[0].Payload)
	}
	// The split-timing fields are part of the payload shape now. The VALUES are
	// non-deterministic in production (real fetch/reconcile wall-clock); here we
	// pass deterministic inputs, so assert presence + non-negative only — the
	// same relaxation the aggregator tests use — to avoid coupling to numbers.
	if p1.FetchMs < 0 || p1.ReconcileMs < 0 {
		t.Fatalf("messages.loaded payload must carry fetchMs/reconcileMs (>=0), got %s", loaded[0].Payload)
	}
	if loaded[0].Seq == 0 {
		t.Fatal("messages.loaded must be seq-stamped (replayable)")
	}

	s.EmitMessagesError("b", "boom")
	errd := drainKind(ch, KindMessagesError)
	if len(errd) != 1 {
		t.Fatalf("want 1 %s event, got %d", KindMessagesError, len(errd))
	}
	var p2 struct {
		SessionID string
		Error     string
	}
	if json.Unmarshal(errd[0].Payload, &p2) != nil || p2.SessionID != "b" || p2.Error != "boom" {
		t.Fatalf("messages.error payload must be {sessionID:b,error:boom}, got %s", errd[0].Payload)
	}
	if errd[0].Seq <= loaded[0].Seq {
		t.Fatal("messages.error seq must advance past the prior event")
	}

	// Replay must include both (they are part of the replayable ring), so a
	// resuming client that missed them converges. Snapshot gate is the
	// authoritative per-session state; the events only matter while a fetch is
	// in flight.
	evs, _, ok := s.Replay(0)
	if !ok {
		t.Fatal("Replay(0) must be ok")
	}
	var loadN, errN int
	for _, e := range evs {
		switch e.Kind {
		case KindMessagesLoaded:
			loadN++
		case KindMessagesError:
			errN++
		}
	}
	if loadN != 1 || errN != 1 {
		t.Fatalf("replay must contain 1 messages.loaded + 1 messages.error, got load=%d err=%d", loadN, errN)
	}
}

// TestColdLoadEmitsSingleMessagesBatch pins the Fix #3 structural change: a
// cold-load SetSessionMessages (session not previously loaded) must emit exactly
// ONE KindMessagesBatch carrying the full reconciled message+part list, instead
// of N per-message message.upsert + per-part part.upsert events. This collapses
// the cold-load N-event fan-out (over the controller tunnel each event becomes a
// yamux frame + WebSocket message + flow-control round-trip — the root cause of
// the session-switch cold-load stall) into a single event. It also asserts:
//   - the batch precedes messages.loaded (the aggregator emits loaded AFTER
//     SetSessionMessages; loaded stays the back-of-channel completion signal /
//     reveal gate), and
//   - a WARM reconcile (a second SetSessionMessages once the session is already
//     loaded — the daemon OpenCode-stream reconnect path) reverts to individual
//     message.upsert/part.upsert emits (incremental reconcile, no batch), and
//   - the batch payload's sessionID + message count match the input.
func TestColdLoadEmitsSingleMessagesBatch(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"cold"}}`))
	ch, unsub := s.Subscribe(256) // firehose: see every message-class event
	defer unsub()
	drainKind(ch, "") // drop subscribe-time backlog

	// COLD load: 3 messages, each with a part. Previously this fanned out to
	// 3 message.upsert + 3 part.upsert = 6 events; now it must be ONE batch.
	s.SetSessionMessages("cold", []MessageWithParts{
		{Info: json.RawMessage(`{"id":"m1","sessionID":"cold","role":"user","time":{"created":1}}`),
			Parts: []json.RawMessage{json.RawMessage(`{"id":"p1","sessionID":"cold","messageID":"m1","type":"text","text":"a"}`)}},
		{Info: json.RawMessage(`{"id":"m2","sessionID":"cold","role":"assistant","time":{"created":2}}`),
			Parts: []json.RawMessage{json.RawMessage(`{"id":"p2","sessionID":"cold","messageID":"m2","type":"text","text":"b"}`)}},
		{Info: json.RawMessage(`{"id":"m3","sessionID":"cold","role":"user","time":{"created":3}}`),
			Parts: []json.RawMessage{json.RawMessage(`{"id":"p3","sessionID":"cold","messageID":"m3","type":"text","text":"c"}`)}},
	})
	// Mirrors the aggregator's EnsureMessagesAsync ordering: SetSessionMessages
	// (the batch) THEN EmitMessagesLoaded (the completion signal).
	s.EmitMessagesLoaded("cold", 10, 5)

	// Collect the message-class events IN ORDER (drainAll preserves arrival
	// order; drainKind filters, so use drainAll and keep the kinds we care
	// about).
	var got []string
	for _, e := range drainAll(ch) {
		switch e.Kind {
		case KindMessageUpsert, KindPartUpsert, KindMessagesBatch, KindMessagesLoaded:
			got = append(got, e.Kind)
			if e.Kind == KindMessagesBatch {
				// The batch payload is now {sessionID, encoding, data} where
				// data is base64(gzip({"messages":[...]})). sessionID stays
				// plain so interest filtering (payloadSessionID / sendable)
				// keeps working — round-trip the compression here.
				var env struct {
					SessionID string `json:"sessionID"`
					Encoding  string `json:"encoding"`
					Data      string `json:"data"`
				}
				if err := json.Unmarshal(e.Payload, &env); err != nil {
					t.Fatalf("messages.batch payload unmarshal: %v", err)
				}
				if env.SessionID != "cold" {
					t.Fatalf("messages.batch sessionID: want cold, got %q", env.SessionID)
				}
				if env.Encoding != "gzip64" {
					t.Fatalf("messages.batch encoding: want gzip64, got %q", env.Encoding)
				}
				// Plain sessionID must survive at the top level (the store/web
				// interest filters rely on it): re-extract it the same way
				// payloadSessionID does to pin the invariant.
				if got := payloadSessionID(e.Payload); got != "cold" {
					t.Fatalf("payloadSessionID(batch): want cold, got %q", got)
				}
				raw, err := base64.StdEncoding.DecodeString(env.Data)
				if err != nil {
					t.Fatalf("messages.batch base64 decode: %v", err)
				}
				gr, err := gzip.NewReader(bytes.NewReader(raw))
				if err != nil {
					t.Fatalf("messages.batch gzip reader: %v", err)
				}
				inner, err := io.ReadAll(gr)
				if err != nil {
					t.Fatalf("messages.batch gunzip: %v", err)
				}
				var p struct {
					Messages []MessageWithParts `json:"messages"`
				}
				if err := json.Unmarshal(inner, &p); err != nil {
					t.Fatalf("messages.batch inner unmarshal: %v", err)
				}
				if len(p.Messages) != 3 {
					t.Fatalf("messages.batch message count: want 3, got %d", len(p.Messages))
				}
				// Each message carries its part (mirrors snapshot serialization).
				for i, m := range p.Messages {
					if len(m.Parts) != 1 {
						t.Fatalf("messages.batch message %d part count: want 1, got %d", i, len(m.Parts))
					}
				}
			}
		}
	}

	// Exactly ONE batch (no per-message/per-part upserts), THEN messages.loaded.
	wantSeq := []string{KindMessagesBatch, KindMessagesLoaded}
	if !reflect.DeepEqual(got, wantSeq) {
		t.Fatalf("cold-load event sequence: want %v, got %v", wantSeq, got)
	}

	// WARM reconcile: a second SetSessionMessages on the now-loaded session
	// (the daemon OpenCode-stream reconnect path) must emit INDIVIDUAL upserts
	// again — incremental reconcile, no batch. Add a new message + change one.
	drainAll(ch) // clear
	s.SetSessionMessages("cold", []MessageWithParts{
		{Info: json.RawMessage(`{"id":"m1","sessionID":"cold","role":"user","time":{"created":1}}`),
			Parts: []json.RawMessage{json.RawMessage(`{"id":"p1","sessionID":"cold","messageID":"m1","type":"text","text":"a"}`)}},
		{Info: json.RawMessage(`{"id":"m2","sessionID":"cold","role":"assistant","time":{"created":2}}`),
			Parts: []json.RawMessage{json.RawMessage(`{"id":"p2","sessionID":"cold","messageID":"m2","type":"text","text":"b"}`)}},
		{Info: json.RawMessage(`{"id":"m3","sessionID":"cold","role":"user","time":{"created":3}}`),
			Parts: []json.RawMessage{json.RawMessage(`{"id":"p3","sessionID":"cold","messageID":"m3","type":"text","text":"c"}`)}},
		{Info: json.RawMessage(`{"id":"m4","sessionID":"cold","role":"assistant","time":{"created":4}}`),
			Parts: []json.RawMessage{json.RawMessage(`{"id":"p4","sessionID":"cold","messageID":"m4","type":"text","text":"d"}`)}},
	})
	var warmBatch, warmUpsert int
	for _, e := range drainAll(ch) {
		switch e.Kind {
		case KindMessagesBatch:
			warmBatch++
		case KindMessageUpsert, KindPartUpsert:
			warmUpsert++
		}
	}
	if warmBatch != 0 {
		t.Fatalf("warm reconcile must NOT emit a batch, got %d", warmBatch)
	}
	if warmUpsert == 0 {
		t.Fatalf("warm reconcile must emit individual upserts (incremental), got 0")
	}
}

// partTextFromBatch decodes a KindMessagesBatch payload
// ({sessionID,encoding:"gzip64",data:base64(gzip({"messages":[...]}))}) and
// returns the .text of the named (sessionID,messageID,partID) part. Used by the
// cold-batch staleness tests to assert which body a batch carried.
func partTextFromBatch(t *testing.T, payload json.RawMessage, sid, mid, pid string) string {
	t.Helper()
	var env struct {
		SessionID string `json:"sessionID"`
		Encoding  string `json:"encoding"`
		Data      string `json:"data"`
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		t.Fatalf("batch payload unmarshal: %v", err)
	}
	// Assert the envelope is for THIS session and uses the gzip64 encoding
	// (packageMessagesBatch contract). A misrouted batch or a changed encoding
	// would otherwise silently pass these staleness assertions.
	if env.SessionID != sid {
		t.Fatalf("batch sessionID: want %q, got %q", sid, env.SessionID)
	}
	if env.Encoding != "gzip64" {
		t.Fatalf("batch encoding: want gzip64, got %q", env.Encoding)
	}
	raw, err := base64.StdEncoding.DecodeString(env.Data)
	if err != nil {
		t.Fatalf("batch base64 decode: %v", err)
	}
	gr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("batch gzip reader: %v", err)
	}
	inner, err := io.ReadAll(gr)
	if err != nil {
		t.Fatalf("batch gunzip: %v", err)
	}
	// Closing the reader verifies the gzip trailer flushed correctly (a
	// truncated/corrupt stream would error here even when io.ReadAll succeeded
	// on a partial read).
	if err := gr.Close(); err != nil {
		t.Fatalf("batch gzip close: %v", err)
	}
	var p struct {
		Messages []MessageWithParts `json:"messages"`
	}
	if err := json.Unmarshal(inner, &p); err != nil {
		t.Fatalf("batch inner unmarshal: %v", err)
	}
	for _, m := range p.Messages {
		var me struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(m.Info, &me)
		if me.ID != mid {
			continue
		}
		for _, part := range m.Parts {
			var pe struct {
				ID   string `json:"id"`
				Text string `json:"text"`
			}
			_ = json.Unmarshal(part, &pe)
			if pe.ID == pid {
				return pe.Text
			}
		}
	}
	t.Fatalf("part %s/%s/%s not found in batch", sid, mid, pid)
	return ""
}

// TestColdBatchDiscardsStaleAfterConcurrentMutation is the proving test for the
// revision-validation correctness of the unlocked cold-batch packaging path
// (publishColdBatch). It deterministically reproduces the race this slice
// eliminates: a stale prepared batch MUST NOT overwrite a newer live delta on
// the client (which treats messages.batch as a wholesale replacement —
// stream.ts:201-217).
//
// Mechanism, via the coldBatchAfterCaptureHook test seam:
//  1. SetSessionMessages(OLD) runs in a goroutine; publishColdBatch captures the
//     OLD projection under the lock, releases the lock, and BLOCKS in the hook
//     before packaging.
//  2. The main test goroutine — while packaging is blocked — applies a NEWER
//     authoritative message.part.updated for the SAME part. upsertPartLocked
//     bumps the session's revision token via bumpMsgRev under the lock.
//  3. The hook is released; publishColdBatch's validation re-reads the revision,
//     sees it changed, and DISCARDS the OLD payload, then retries and captures
//     the NEW state, which validates and is emitted.
//
// Assertions: exactly ONE batch is emitted (the discarded one never lands); it
// carries the NEW text, never OLD; messages.loaded follows the valid batch.
func TestColdBatchDiscardsStaleAfterConcurrentMutation(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"stale"}}`))
	ch, unsub := s.Subscribe(256) // firehose: see every message-class event
	defer unsub()
	drainAll(ch) // drop subscribe-time backlog

	// OLD cold-fetch result: one message + one part with text "OLD".
	oldList := []MessageWithParts{
		{Info: json.RawMessage(`{"id":"m1","sessionID":"stale","role":"assistant","time":{"created":1}}`),
			Parts: []json.RawMessage{json.RawMessage(`{"id":"p1","sessionID":"stale","messageID":"m1","type":"text","text":"OLD"}`)}},
	}

	// Coordination via the test seam: the hook signals it has captured the OLD
	// projection, then blocks until the test applies the newer mutation and
	// releases it. capturedOnce guards the close (the retry re-enters the hook);
	// a closed releaseCh returns immediately on re-entry so the retry does not
	// re-block.
	capturedCh := make(chan struct{})
	releaseCh := make(chan struct{})
	var capturedOnce sync.Once
	coldBatchAfterCaptureHook = func(sid string) {
		if sid != "stale" {
			return
		}
		capturedOnce.Do(func() { close(capturedCh) })
		<-releaseCh // block until released (instant no-op after close)
	}
	t.Cleanup(func() { coldBatchAfterCaptureHook = nil })

	// Run the cold load in a goroutine: it blocks inside publishColdBatch's hook
	// after capturing OLD.
	done := make(chan struct{})
	go func() {
		s.SetSessionMessages("stale", oldList)
		close(done)
	}()

	// Wait until the OLD projection has been captured (and packaging is blocked).
	<-capturedCh

	// While packaging is blocked, apply a NEWER authoritative part body for the
	// same part. upsertPartLocked bumps the session's revision token via
	// bumpMsgRev → the validation step MUST discard the captured (OLD) batch and
	// retry. (The event shape wraps the part under "part": — that is what the
	// Apply dispatch expects.)
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"stale","messageID":"m1","type":"text","text":"NEW"}}`))

	// Release packaging; the retry captures NEW and emits a revision-valid batch.
	close(releaseCh)
	<-done // SetSessionMessages returned → a valid batch was published

	// Mirror the aggregator ordering: SetSessionMessages THEN EmitMessagesLoaded.
	s.EmitMessagesLoaded("stale", 1, 1)

	// Collect message-class events in arrival order.
	var batches []ClientEvent
	var seq []string
	for _, e := range drainAll(ch) {
		switch e.Kind {
		case KindMessagesBatch, KindMessagesLoaded:
			seq = append(seq, e.Kind)
			if e.Kind == KindMessagesBatch {
				batches = append(batches, e)
			}
		}
	}

	// Exactly ONE batch (the retry's valid one; the OLD capture was discarded).
	if len(batches) != 1 {
		t.Fatalf("want exactly 1 batch (stale discarded), got %d", len(batches))
	}
	// The batch must precede messages.loaded (the reveal-gate ordering contract).
	wantSeq := []string{KindMessagesBatch, KindMessagesLoaded}
	if !reflect.DeepEqual(seq, wantSeq) {
		t.Fatalf("event sequence: want %v, got %v", wantSeq, seq)
	}
	// The batch must carry the NEW text, never the OLD text.
	gotText := partTextFromBatch(t, batches[0].Payload, "stale", "m1", "p1")
	if gotText != "NEW" {
		t.Fatalf("batch part text: want NEW (stale OLD discarded), got %q", gotText)
	}
}

// TestColdBatchPublishesConcurrentWithConcurrentApply is the race-detector
// companion: it runs Apply (live mutations) on one goroutine while a cold-load
// SetSessionMessages (publishColdBatch packaging) runs on another, repeatedly,
// under -race. The -race flag is the real assertion here: the byte-copy in
// captureMessagesBatchLocked must keep packaging (which reads those bytes
// outside s.mu) race-free vs concurrent Apply mutations of the same session.
//
// NOTE: this test deliberately does NOT subscribe/drain. The store's nonblocking
// fanout CLOSES a subscriber's channel on overflow; a closed channel would make
// drainAll's select-with-default spin forever (it always receives zero values).
// The race detector — not event inspection — is the assertion.
func TestColdBatchPublishesConcurrentWithConcurrentApply(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"race"}}`))

	const mutations = 400
	const reloads = 30
	var wg sync.WaitGroup

	// Mutator goroutine: rapidly upserts part bodies for the same session so the
	// per-session revision churns continuously during cold-batch packaging.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < mutations; i++ {
			s.Apply(ev("message.part.updated",
				`{"part":{"id":"p1","sessionID":"race","messageID":"m1","type":"text","text":"v`+strconv.Itoa(i)+`"}}`))
		}
	}()

	// Loader goroutine: repeatedly marks the session as not-loaded and re-runs a
	// cold load, exercising publishColdBatch's capture/package/validate loop
	// against the concurrent mutator. delete-under-lock mirrors a fresh session.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < reloads; i++ {
			s.mu.Lock()
			delete(s.msgLoaded, "race")
			s.mu.Unlock()
			s.SetSessionMessages("race", []MessageWithParts{
				{Info: json.RawMessage(`{"id":"m1","sessionID":"race","role":"assistant","time":{"created":1}}`),
					Parts: []json.RawMessage{json.RawMessage(`{"id":"p1","sessionID":"race","messageID":"m1","type":"text","text":"cold"}`)}},
			})
		}
	}()

	wg.Wait()
}

// startBlockedColdBatch installs a coldBatchAfterCaptureHook for sid that
// signals capturedCh ONCE (on first capture) and then blocks on releaseCh
// (returning immediately once releaseCh is closed). Returns the two channels;
// the hook is cleared via t.Cleanup. This is the shared coordination primitive
// for the cold-batch staleness proving tests: it lets a test deterministically
// race a same-session mutation in the gap between capture and validation.
func startBlockedColdBatch(t *testing.T, sid string) (capturedCh, releaseCh chan struct{}) {
	t.Helper()
	capturedCh = make(chan struct{})
	releaseCh = make(chan struct{})
	var once sync.Once
	coldBatchAfterCaptureHook = func(s string) {
		if s != sid {
			return
		}
		once.Do(func() { close(capturedCh) })
		<-releaseCh // block until released (instant no-op after close)
	}
	t.Cleanup(func() { coldBatchAfterCaptureHook = nil })
	return capturedCh, releaseCh
}

// decodeBatchMessages decodes a KindMessagesBatch payload
// ({sessionID,encoding:"gzip64",data:base64(gzip({"messages":[...]}))}) into the
// message list, asserting the envelope + gzip integrity. Used by the
// cold-batch tests that need to inspect message/part COUNTS (not just one part's
// text, which partTextFromBatch covers).
func decodeBatchMessages(t *testing.T, payload json.RawMessage) []MessageWithParts {
	t.Helper()
	var env struct {
		SessionID string `json:"sessionID"`
		Encoding  string `json:"encoding"`
		Data      string `json:"data"`
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		t.Fatalf("batch payload unmarshal: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(env.Data)
	if err != nil {
		t.Fatalf("batch base64 decode: %v", err)
	}
	gr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("batch gzip reader: %v", err)
	}
	inner, err := io.ReadAll(gr)
	if err != nil {
		t.Fatalf("batch gunzip: %v", err)
	}
	if err := gr.Close(); err != nil {
		t.Fatalf("batch gzip close: %v", err)
	}
	var p struct {
		Messages []MessageWithParts `json:"messages"`
	}
	if err := json.Unmarshal(inner, &p); err != nil {
		t.Fatalf("batch inner unmarshal: %v", err)
	}
	return p.Messages
}

// collectBatches drains the subscriber channel and returns the
// KindMessagesBatch events in arrival order.
func collectBatches(t *testing.T, ch <-chan ClientEvent) []ClientEvent {
	t.Helper()
	var out []ClientEvent
	for _, e := range drainAll(ch) {
		if e.Kind == KindMessagesBatch {
			out = append(out, e)
		}
	}
	return out
}

// seedOnePartSession builds a session <sid> with one assistant message m1 and
// one text part p1 carrying <text>, returning nothing (state is in the store).
// Used by the cold-batch staleness tests' common setup.
func seedOnePartSession(s *Store, sid, text string) {
	s.Apply(ev("session.created", `{"info":{"id":"`+sid+`"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"`+sid+`","role":"assistant","time":{"created":1}}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"`+sid+`","messageID":"m1","type":"text","text":"`+text+`"}}`))
}

// TestSnapshotDoesNotMutateColdBatchCapture is the proving test for the
// Snapshot purity invariant (sub-phase 2.2): Snapshot is a PURE READ
// PROJECTION — it must NOT mutate me.parts and must NOT bump the per-session
// message revision, otherwise it would invalidate a concurrently-packaging
// cold batch's captured (revision, projection) pair.
//
// Pre-purity behavior (the OLD code this test replaces): Snapshot called
// flushPartDeltasLocked(s, false), which REWROTE me.parts from "BASEA" to
// "BASEAB" and bumped the revision; that forced a mid-package cold batch to be
// discarded+retried. TestColdBatchSnapshotFlushBumpsRev (the test this one
// replaces) asserted the OLD behavior: exactly one batch carrying "BASEAB".
//
// Post-purity behavior (the NEW invariant this test asserts): Snapshot overlays
// buffered deltas onto a FRESHLY-ALLOCATED copy (projectPartLocked) without
// touching me.parts, and does not bump the revision. So a cold batch captured
// mid-package with text "BASEA" + token T validates (T==T) and emits "BASEA"
// unchanged — no discard, no retry, exactly one batch.
//
// Reproduction (via coldBatchAfterCaptureHook + a large deltaFlushInterval):
//  1. Seed part p1 text "BASE"; apply delta "A" (first delta flushes → me.parts
//     "BASEA") and delta "B" immediately (throttled → stays in deltaBuf, so
//     me.parts lags at "BASEA" while the accumulator holds "BASEAB").
//  2. publishColdBatch captures me.parts ("BASEA") + token T, blocks in the hook.
//  3. Snapshot({sid}) must NOT mutate me.parts ("BASEA") NOR bump the token.
//     (Its OUTPUT still reflects "BASEAB" via projectPartLocked — verified
//     separately below — but the STORE is untouched.)
//  4. Release: publishColdBatch re-reads the token. T==T → emit "BASEA"
//     unchanged, no retry.
//
// Assert: exactly ONE batch carrying "BASEA" (the captured text, unchanged).
// Fails if Snapshot regresses to mutating me.parts / bumping the revision
// (which would instead produce a discard+retry emitting "BASEAB").
func TestSnapshotDoesNotMutateColdBatchCapture(t *testing.T) {
	// Force throttling so the second delta stays buffered (deterministic,
	// independent of host scheduling jitter).
	prevInterval := deltaFlushInterval
	deltaFlushInterval = time.Hour
	t.Cleanup(func() { deltaFlushInterval = prevInterval })

	s := New(100)
	seedOnePartSession(s, "snap", "BASE")
	// delta "A": first delta always flushes (deltaLastEmit zero) → me.parts "BASEA".
	s.Apply(ev("message.part.delta", `{"sessionID":"snap","messageID":"m1","partID":"p1","field":"text","delta":"A"}`))
	// delta "B": throttled (deltaFlushInterval=time.Hour) → stays in deltaBuf;
	// me.parts still "BASEA" but the accumulator holds "BASEAB".
	s.Apply(ev("message.part.delta", `{"sessionID":"snap","messageID":"m1","partID":"p1","field":"text","delta":"B"}`))

	// Sanity: confirm the projection contract holds BEFORE the cold-batch dance —
	// Snapshot's OUTPUT must reflect the buffered "B" via overlay, even though
	// me.parts lags at "BASEA". This proves the snapshot still carries the live
	// accumulated text without flushing it into the store.
	if got := partText(s.Snapshot(map[string]bool{"snap": true}), "snap", "p1"); got != "BASEAB" {
		t.Fatalf("snapshot output pre-batch: want BASEAB (projection overlay), got %q", got)
	}

	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainAll(ch)

	capturedCh, releaseCh := startBlockedColdBatch(t, "snap")

	// Record the pre-Snapshot revision token so we can assert Snapshot left it
	// untouched.
	preRev := s.msgRev["snap"]

	done := make(chan struct{})
	go func() {
		// Cold-load publication directly (msgLoaded["snap"] is false). Calling
		// publishColdBatch instead of SetSessionMessages avoids reconcile
		// overwriting the carefully-built deltaBuf accumulator.
		s.publishColdBatch("snap")
		close(done)
	}()
	<-capturedCh

	// Snapshot must be a pure read here: NO mutation of me.parts, NO rev bump.
	s.Snapshot(map[string]bool{"snap": true})

	// Purity assertion 1: the revision token is unchanged by Snapshot.
	if postRev := s.msgRev["snap"]; postRev != preRev {
		t.Fatalf("Snapshot mutated msgRev: pre=%d post=%d (purity violated)", preRev, postRev)
	}
	// Purity assertion 2: me.parts still holds the pre-Snapshot "BASEA" (the
	// buffered "B" was NOT flushed back into the store).
	s.mu.RLock()
	me := s.messages["snap"].byID["m1"]
	gotStored := partTextFromRaw(t, me.parts["p1"])
	s.mu.RUnlock()
	if gotStored != "BASEA" {
		t.Fatalf("Snapshot mutated me.parts: want BASEA (pure read), got %q", gotStored)
	}

	close(releaseCh)
	<-done

	batches := collectBatches(t, ch)
	if len(batches) != 1 {
		t.Fatalf("want exactly 1 batch (no discard/retry — Snapshot is pure), got %d", len(batches))
	}
	got := partTextFromBatch(t, batches[0].Payload, "snap", "m1", "p1")
	if got != "BASEA" {
		t.Fatalf("batch text: want BASEA (captured text, unchanged by pure Snapshot), got %q", got)
	}
}

// TestColdBatchRecreatedSessionDoesNotReuseOldToken is the proving test for
// Finding 2 (ABA): a per-session revision counter that resets on delete lets a
// recreated session REUSE an old in-flight batch's captured token, so the stale
// publication validates token==token and emits the OLD session's wholesale batch
// over the NEW state. The Store-wide monotonic counter (bumpMsgRev via
// nextMsgRev) guarantees a recreated session always gets a strictly-greater
// token than any in-flight batch could have captured.
//
// Reproduction (via coldBatchAfterCaptureHook):
//  1. Build session "aba" with m1/p1 text "OLD" (2 revision bumps).
//  2. publishColdBatch captures "OLD" + token T, blocks in the hook.
//  3. session.deleted "aba" (clears msgRev); session.created "aba"; re-apply the
//     SAME 2 mutations with text "NEW". Under a per-session counter this
//     reproduces token T (2 bumps from 0); under the Store-wide monotonic
//     counter the token is T+2 (> T, never equal).
//  4. Release: publishColdBatch re-reads the token. With the fix T+2≠T →
//     discard, retry captures "NEW", emit. Without the fix T==T → emit "OLD"
//     (the deleted session's stale batch over the recreated state).
//
// Assert: exactly ONE batch carrying "NEW" (the recreated state), never "OLD".
func TestColdBatchRecreatedSessionDoesNotReuseOldToken(t *testing.T) {
	s := New(100)
	seedOnePartSession(s, "aba", "OLD") // 2 revision bumps → token T (under either scheme)

	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainAll(ch)

	capturedCh, releaseCh := startBlockedColdBatch(t, "aba")

	done := make(chan struct{})
	go func() {
		s.publishColdBatch("aba") // captures "OLD" + token T, blocks
		close(done)
	}()
	<-capturedCh

	// Delete + recreate the SAME session id, re-applying the SAME mutation
	// sequence (2 bumps) with NEW text. Per-session counter: reproduces token T.
	// Store-wide monotonic: token T+2 (strictly greater).
	s.Apply(ev("session.deleted", `{"info":{"id":"aba"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"aba"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"aba","role":"assistant","time":{"created":1}}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"aba","messageID":"m1","type":"text","text":"NEW"}}`))

	close(releaseCh)
	<-done

	batches := collectBatches(t, ch)
	if len(batches) != 1 {
		t.Fatalf("want exactly 1 batch, got %d", len(batches))
	}
	got := partTextFromBatch(t, batches[0].Payload, "aba", "m1", "p1")
	if got != "NEW" {
		t.Fatalf("batch text: want NEW (recreated session), got %q (old session's stale batch leaked through — ABA)", got)
	}
}

// TestSetSessionMessagesReturnsSessionGoneWhenDeletedDuringCapture is the proving
// test for Finding 3: messages.loaded must NEVER fire without a preceding valid
// messages.batch. publishColdBatch returns a ColdBatchStatus that distinguishes
// "valid batch published" (Emitted / WarmReconcile) from "no batch published"
// (SessionGone / PackagingFailed); the aggregator gates EmitMessagesLoaded on
// Emitted|WarmReconcile ONLY.
//
// This test forces the SessionGone path deterministically: a session.deleted
// landing in the capture→validation window makes capture return nil on the
// retry, so publishColdBatch returns ColdBatchSessionGone and emits NO batch.
// The test then MIRRORS the aggregator's gating and asserts no batch AND no
// messages.loaded. Without the Finding 3 fix SetSessionMessages has no return
// value (the status cannot exist), so this test cannot even be written.
//
// (The SessionGone status is only reachable via the narrow reconcile→capture
// window; the coldBatchAfterCaptureHook is the deterministic injection point.
// The happy-path regression guard — that a successful cold/zero-message load
// DOES emit messages.loaded — is TestEnsureMessagesAsyncSuccessEmitsCompletion
// in pkg/aggregator.)
func TestSetSessionMessagesReturnsSessionGoneWhenDeletedDuringCapture(t *testing.T) {
	s := New(100)
	seedOnePartSession(s, "gone", "OLD")

	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainAll(ch)

	// The hook deletes the session ON THE FIRST CAPTURE, so attempt 0's
	// validation sees a changed token (delete cleared msgRev → 0 ≠ T) and
	// discards; attempt 1's capture then reads s.messages["gone"]==nil → returns
	// nil → ColdBatchSessionGone. No batch is ever emitted.
	capturedCh := make(chan struct{})
	releaseCh := make(chan struct{})
	var once sync.Once
	coldBatchAfterCaptureHook = func(sid string) {
		if sid != "gone" {
			return
		}
		once.Do(func() {
			// Simulate a live session.deleted landing between capture and
			// validation. deleteSessionLocked clears msgRev + s.messages.
			s.mu.Lock()
			s.deleteSessionLocked("gone")
			s.mu.Unlock()
			close(capturedCh)
		})
		<-releaseCh // subsequent attempts (the nil-capture retry) pass through
	}
	t.Cleanup(func() { coldBatchAfterCaptureHook = nil })

	oldList := []MessageWithParts{
		{Info: json.RawMessage(`{"id":"m1","sessionID":"gone","role":"assistant","time":{"created":1}}`),
			Parts: []json.RawMessage{json.RawMessage(`{"id":"p1","sessionID":"gone","messageID":"m1","type":"text","text":"OLD"}`)}},
	}

	var status ColdBatchStatus
	done := make(chan struct{})
	go func() {
		status = s.SetSessionMessages("gone", oldList)
		close(done)
	}()
	<-capturedCh
	close(releaseCh)
	<-done

	// The status MUST be SessionGone (capture returned nil on the retry).
	if status != ColdBatchSessionGone {
		t.Fatalf("SetSessionMessages status: want ColdBatchSessionGone, got %v", status)
	}

	// Mirror the aggregator's Finding-3 gating: loaded is emitted ONLY for
	// Emitted|WarmReconcile. For SessionGone it MUST NOT be emitted.
	if status == ColdBatchEmitted || status == ColdBatchWarmReconcile {
		s.EmitMessagesLoaded("gone", 1, 1)
	}

	// Assert NO messages.batch and NO messages.loaded for the gone session.
	for _, e := range drainAll(ch) {
		if e.Kind == KindMessagesBatch || e.Kind == KindMessagesLoaded {
			t.Fatalf("unexpected event for gone session: %s (loaded must not fire without a preceding valid batch)", e.Kind)
		}
	}
}

// TestColdBatchInvalidatedByMessageRemoved is a nice-to-have covering the
// message.removed revision path: a live message deletion during packaging MUST
// invalidate the captured batch so the retry reflects the deletion (0 messages),
// never the deleted message. Without the delete bump the stale batch would carry
// the deleted message.
func TestColdBatchInvalidatedByMessageRemoved(t *testing.T) {
	s := New(100)
	seedOnePartSession(s, "mr", "OLD")
	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainAll(ch)

	capturedCh, releaseCh := startBlockedColdBatch(t, "mr")
	done := make(chan struct{})
	go func() {
		s.publishColdBatch("mr")
		close(done)
	}()
	<-capturedCh
	s.Apply(ev("message.removed", `{"sessionID":"mr","messageID":"m1"}`))
	close(releaseCh)
	<-done

	batches := collectBatches(t, ch)
	if len(batches) != 1 {
		t.Fatalf("want exactly 1 batch, got %d", len(batches))
	}
	msgs := decodeBatchMessages(t, batches[0].Payload)
	if len(msgs) != 0 {
		t.Fatalf("want 0 messages (m1 deleted before emit), got %d", len(msgs))
	}
}

// TestColdBatchInvalidatedByPartRemoved covers the message.part.removed revision
// path: a live part deletion during packaging MUST invalidate the captured batch
// so the retry reflects the deletion (part gone), never the deleted part.
func TestColdBatchInvalidatedByPartRemoved(t *testing.T) {
	s := New(100)
	seedOnePartSession(s, "pr", "OLD")
	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainAll(ch)

	capturedCh, releaseCh := startBlockedColdBatch(t, "pr")
	done := make(chan struct{})
	go func() {
		s.publishColdBatch("pr")
		close(done)
	}()
	<-capturedCh
	s.Apply(ev("message.part.removed", `{"sessionID":"pr","messageID":"m1","partID":"p1"}`))
	close(releaseCh)
	<-done

	batches := collectBatches(t, ch)
	if len(batches) != 1 {
		t.Fatalf("want exactly 1 batch, got %d", len(batches))
	}
	msgs := decodeBatchMessages(t, batches[0].Payload)
	if len(msgs) != 1 {
		t.Fatalf("want 1 message (m1 still present), got %d", len(msgs))
	}
	// The part must be GONE in the emitted batch (deleted before emit). Without
	// the part-delete bump the stale batch would still carry p1.
	var partCount int
	for _, part := range msgs[0].Parts {
		var pe struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(part, &pe)
		if pe.ID == "p1" {
			partCount++
		}
	}
	if partCount != 0 {
		t.Fatalf("want p1 absent (deleted before emit), still present %d time(s)", partCount)
	}
}

// TestColdBatchInvalidatedByMessageUpdated covers the message.updated revision
// path: a live message body change during packaging MUST invalidate the captured
// batch so the retry carries the updated body. Asserted via the role field
// (assistant→user) so the proof is content-based, not just batch-count.
func TestColdBatchInvalidatedByMessageUpdated(t *testing.T) {
	s := New(100)
	seedOnePartSession(s, "mu", "OLD")
	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainAll(ch)

	capturedCh, releaseCh := startBlockedColdBatch(t, "mu")
	done := make(chan struct{})
	go func() {
		s.publishColdBatch("mu")
		close(done)
	}()
	<-capturedCh
	// Change the message body (role assistant→user) during packaging.
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"mu","role":"user","time":{"created":1}}}`))
	close(releaseCh)
	<-done

	batches := collectBatches(t, ch)
	if len(batches) != 1 {
		t.Fatalf("want exactly 1 batch, got %d", len(batches))
	}
	msgs := decodeBatchMessages(t, batches[0].Payload)
	if len(msgs) != 1 {
		t.Fatalf("want 1 message, got %d", len(msgs))
	}
	var info struct {
		ID   string `json:"id"`
		Role string `json:"role"`
	}
	if err := json.Unmarshal(msgs[0].Info, &info); err != nil {
		t.Fatalf("unmarshal message info: %v", err)
	}
	if info.Role != "user" {
		t.Fatalf("want role user (updated before emit), got %q (stale assistant leaked through)", info.Role)
	}
}

// TestColdBatchInvalidatedByWarmReconcile covers the warm-reconcile revision
// path: a warm re-fetch (msgLoaded already true) of a session while a prior cold
// batch is mid-packaging MUST invalidate that batch. reconcileMessagesLocked
// bumps the token on BOTH cold and warm paths.
func TestColdBatchInvalidatedByWarmReconcile(t *testing.T) {
	s := New(100)
	seedOnePartSession(s, "wr", "OLD")
	// Pretend the session is already loaded so the SetSessionMessages below is a
	// WARM reconcile (coldLoad==false) — it emits deltas + bumps the token but
	// does NOT itself call publishColdBatch.
	s.mu.Lock()
	s.msgLoaded["wr"] = true
	s.mu.Unlock()

	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainAll(ch)

	capturedCh, releaseCh := startBlockedColdBatch(t, "wr")
	done := make(chan struct{})
	go func() {
		s.publishColdBatch("wr") // captures "OLD", blocks
		close(done)
	}()
	<-capturedCh
	// Warm reconcile with NEWER text. Bumps the token → invalidates the captured
	// "OLD" batch; the release then makes publishColdBatch retry + capture "WARM".
	s.SetSessionMessages("wr", []MessageWithParts{
		{Info: json.RawMessage(`{"id":"m1","sessionID":"wr","role":"assistant","time":{"created":1}}`),
			Parts: []json.RawMessage{json.RawMessage(`{"id":"p1","sessionID":"wr","messageID":"m1","type":"text","text":"WARM"}`)}},
	})
	close(releaseCh)
	<-done

	batches := collectBatches(t, ch)
	if len(batches) != 1 {
		t.Fatalf("want exactly 1 batch, got %d", len(batches))
	}
	got := partTextFromBatch(t, batches[0].Payload, "wr", "m1", "p1")
	if got != "WARM" {
		t.Fatalf("batch text: want WARM (warm-reconciled), got %q (pre-reconcile stale leaked through)", got)
	}
}

// TestPublishColdBatchRetryExhaustionFallsBackToLocked covers the bounded-retry
// FAIL-SAFE: a session changing so fast that every capture validates stale
// (revision churns on every attempt) must NOT give up without delivering a valid
// batch. After maxColdBatchRetries the last resort repackages ONCE UNDER s.mu so
// the emitted batch is current at emit time. Asserts exactly ONE batch carrying
// the final state (no stale emit, no skip).
func TestPublishColdBatchRetryExhaustionFallsBackToLocked(t *testing.T) {
	s := New(100)
	seedOnePartSession(s, "ex", "OLD")
	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainAll(ch)

	// The hook applies a part.updated on EVERY capture (including retries), so
	// the token churns on every attempt and the retry loop never converges →
	// forces the fail-safe locked repackage. Text is fixed ("LOCKED") so the
	// fallback's locked capture reads a stable value.
	coldBatchAfterCaptureHook = func(sid string) {
		if sid != "ex" {
			return
		}
		s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"ex","messageID":"m1","type":"text","text":"LOCKED"}}`))
	}
	t.Cleanup(func() { coldBatchAfterCaptureHook = nil })

	s.publishColdBatch("ex")

	batches := collectBatches(t, ch)
	if len(batches) != 1 {
		t.Fatalf("want exactly 1 batch (the fail-safe locked repackage), got %d", len(batches))
	}
	got := partTextFromBatch(t, batches[0].Payload, "ex", "m1", "p1")
	if got != "LOCKED" {
		t.Fatalf("batch text: want LOCKED (fail-safe current capture), got %q", got)
	}
}

// sessionIDsFromSnapshot unmarshals snap.Sessions (raw info blobs) into a set of
// session IDs, so a scoping test can assert which sessions shipped without
// depending on slice order (map-iteration order is non-deterministic).
func sessionIDsFromSnapshot(t *testing.T, snap Snapshot) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	for _, raw := range snap.Sessions {
		var e sessionEnvelope
		if json.Unmarshal(raw, &e) == nil && e.ID != "" {
			out[e.ID] = true
		}
	}
	return out
}

// setupTwoSessionStore seeds a store with two sessions (a, b), each carrying a
// representative spread of per-session structural data so a scoping test can
// assert each field is included/excluded independently: an assistant message
// (→ Messages + LastAgents), a pending permission (→ Permissions +
// Gate.PendingPermission), and a pending question (→ Questions +
// Gate.PendingQuestion). SetSessionMessages (the authoritative history-fetch
// path) both populates messages AND flips msgLoaded[sid]=true, so the gate's
// MessagesLoaded field is meaningful for the FE-contract assertion. Both
// sessions are marked idle so they appear in Activity.
func setupTwoSessionStore(t *testing.T) *Store {
	t.Helper()
	s := New(100)
	for _, sid := range []string{"a", "b"} {
		s.Apply(ev("session.created", `{"info":{"id":"`+sid+`"}}`))
		s.SetSessionMessages(sid, []MessageWithParts{
			{Info: json.RawMessage(`{"id":"m_` + sid + `","sessionID":"` + sid + `","role":"assistant","agent":"builder"}`),
				Parts: []json.RawMessage{json.RawMessage(`{"id":"p_` + sid + `","sessionID":"` + sid + `","messageID":"m_` + sid + `","type":"text","text":"hi"}`)}},
		})
		s.Apply(ev("permission.asked", `{"id":"perm_`+sid+`","sessionID":"`+sid+`","permission":"bash"}`))
		s.Apply(ev("question.asked", `{"id":"q_`+sid+`","sessionID":"`+sid+`"}`))
		s.MarkIdle(sid)
	}
	// Deterministically seed LastAgents (the scoping test cares about WHICH
	// sessions ship, not how lastAgent was derived).
	s.SetLastAgents(map[string]string{"a": "builder", "b": "builder"})
	return s
}

// TestSnapshotNilIsFirehose pins the messagesFor==nil contract: every session's
// messages AND every per-session structural row ship. Slice 2 leaves this case
// UNCHANGED.
func TestSnapshotNilIsFirehose(t *testing.T) {
	s := setupTwoSessionStore(t)
	snap := s.Snapshot(nil)

	ids := sessionIDsFromSnapshot(t, snap)
	if !ids["a"] || !ids["b"] {
		t.Fatalf("nil snapshot must ship BOTH sessions, got sessions=%v", ids)
	}
	for _, sid := range []string{"a", "b"} {
		if msgs, ok := snap.Messages[sid]; !ok || len(msgs) != 1 {
			t.Fatalf("nil snapshot must ship %q's messages, got Messages[%q]=%v", sid, sid, snap.Messages[sid])
		}
		if _, ok := snap.Gate[sid]; !ok {
			t.Fatalf("nil snapshot must ship %q's gate", sid)
		}
		if _, ok := snap.Permissions[sid]; !ok || len(snap.Permissions[sid]) != 1 {
			t.Fatalf("nil snapshot must ship %q's permission", sid)
		}
		if _, ok := snap.Questions[sid]; !ok || len(snap.Questions[sid]) != 1 {
			t.Fatalf("nil snapshot must ship %q's question", sid)
		}
		if _, ok := snap.LastAgents[sid]; !ok {
			t.Fatalf("nil snapshot must ship %q's lastAgent", sid)
		}
		if _, ok := snap.Activity[sid]; !ok {
			t.Fatalf("nil snapshot must ship %q's activity", sid)
		}
	}
}

// TestSnapshotEmptyIsTreeOnly pins the Stream-1 contract (messagesFor != nil &&
// empty): NO messages, but the FULL structural tree for ALL sessions — it is the
// session-list view. Slice 2 leaves this case UNCHANGED.
func TestSnapshotEmptyIsTreeOnly(t *testing.T) {
	s := setupTwoSessionStore(t)
	snap := s.Snapshot(map[string]bool{})

	// Tree-only: NO messages at all.
	if len(snap.Messages) != 0 {
		t.Fatalf("empty-filter (tree-only) snapshot must ship NO messages, got %d sessions", len(snap.Messages))
	}
	// ...but the FULL structural tree for ALL sessions.
	ids := sessionIDsFromSnapshot(t, snap)
	if !ids["a"] || !ids["b"] {
		t.Fatalf("tree-only snapshot must still ship BOTH sessions (full tree), got sessions=%v", ids)
	}
	for _, sid := range []string{"a", "b"} {
		if _, ok := snap.Gate[sid]; !ok {
			t.Fatalf("tree-only snapshot must ship %q's gate (full tree)", sid)
		}
		if _, ok := snap.Permissions[sid]; !ok {
			t.Fatalf("tree-only snapshot must ship %q's permission (full tree)", sid)
		}
		if _, ok := snap.Questions[sid]; !ok {
			t.Fatalf("tree-only snapshot must ship %q's question (full tree)", sid)
		}
		if _, ok := snap.LastAgents[sid]; !ok {
			t.Fatalf("tree-only snapshot must ship %q's lastAgent (full tree)", sid)
		}
	}
}

// TestSnapshotScopedOmitsUnselected is the core Slice 2 assertion: a non-empty
// filter (Stream-2 "open one session") ships messages + per-session structural
// rows for the SELECTED session ONLY. An unrelated session "b" is omitted from
// EVERY per-session-keyed structural map (Sessions/Gate/Questions/Activity/
// LastAgents/Permissions). It also covers the FE contract: the open-session
// stream reads gate[a].messagesLoaded, so gate["a"] must be present.
func TestSnapshotScopedOmitsUnselected(t *testing.T) {
	s := setupTwoSessionStore(t)
	snap := s.Snapshot(map[string]bool{"a": true})

	// Messages: only "a".
	if msgs, ok := snap.Messages["a"]; !ok || len(msgs) != 1 {
		t.Fatalf(`scoped snapshot must ship selected "a"'s messages, got Messages[a]=%v`, snap.Messages["a"])
	}
	if _, ok := snap.Messages["b"]; ok {
		t.Fatal(`scoped snapshot must NOT ship unselected "b"'s messages`)
	}

	// Sessions slice: only "a".
	ids := sessionIDsFromSnapshot(t, snap)
	if !ids["a"] {
		t.Fatalf(`scoped snapshot must ship selected "a"'s session row, got sessions=%v`, ids)
	}
	if ids["b"] {
		t.Fatalf(`scoped snapshot must NOT ship unselected "b"'s session row, got sessions=%v`, ids)
	}

	// Every per-session structural map: "a" present, "b" ABSENT.
	if _, ok := snap.Gate["a"]; !ok {
		t.Fatal(`scoped snapshot must ship selected "a"'s gate`)
	}
	if _, ok := snap.Gate["b"]; ok {
		t.Fatal(`scoped snapshot must NOT ship unselected "b"'s gate`)
	}
	// FE contract: applySessionSnapshot reads snap.gate[a].messagesLoaded. It
	// must be present (and true here, since SetSessionMessages flipped msgLoaded).
	if !snap.Gate["a"].MessagesLoaded {
		t.Fatalf(`scoped snapshot gate["a"].messagesLoaded must be true after SetSessionMessages, got false`)
	}

	if _, ok := snap.Permissions["a"]; !ok || len(snap.Permissions["a"]) != 1 {
		t.Fatalf(`scoped snapshot must ship "a"'s permission, got Permissions[a]=%v`, snap.Permissions["a"])
	}
	if _, ok := snap.Permissions["b"]; ok {
		t.Fatal(`scoped snapshot must NOT ship "b"'s permission`)
	}

	if _, ok := snap.Questions["a"]; !ok || len(snap.Questions["a"]) != 1 {
		t.Fatalf(`scoped snapshot must ship "a"'s question, got Questions[a]=%v`, snap.Questions["a"])
	}
	if _, ok := snap.Questions["b"]; ok {
		t.Fatal(`scoped snapshot must NOT ship "b"'s question`)
	}

	if _, ok := snap.LastAgents["a"]; !ok {
		t.Fatal(`scoped snapshot must ship "a"'s lastAgent`)
	}
	if _, ok := snap.LastAgents["b"]; ok {
		t.Fatal(`scoped snapshot must NOT ship "b"'s lastAgent`)
	}

	if _, ok := snap.Activity["a"]; !ok {
		t.Fatal(`scoped snapshot must ship "a"'s activity`)
	}
	if _, ok := snap.Activity["b"]; ok {
		t.Fatal(`scoped snapshot must NOT ship "b"'s activity`)
	}
}

// TestSnapshotScopedFlushConverges proves the scoping invariant for the
// read-side projection: a scoped Snapshot PROJECTS (overlays onto fresh
// copies) ONLY the selected sessions' buffered streaming accumulators, and an
// unselected session's BUFFERED deltas stay intact in deltaBuf and converge on
// the next full Snapshot(nil) — no data loss. The throttle window is stretched
// to an hour so all deltas after the first land (and stay) in the buffer; only
// a Snapshot projection materializes them (the live-tail contract). Note the
// projection does NOT write back into me.parts (Snapshot is observationally
// pure — see TestSnapshotIsObservationallyPure); it overlays onto the returned
// copy. (The other half of the invariant — deltaBuf ownership is strictly per
// messageEntry with no cross-session state — is structural; see
// flushPartDeltasLocked, the write-side path.)
func TestSnapshotScopedFlushConverges(t *testing.T) {
	withFlushInterval(t, time.Hour)

	s := New(100)
	for _, sid := range []string{"a", "b"} {
		s.Apply(ev("session.created", `{"info":{"id":"`+sid+`"}}`))
		s.Apply(ev("message.updated", `{"info":{"id":"m_`+sid+`","sessionID":"`+sid+`","role":"assistant"}}`))
		s.Apply(ev("message.part.updated", `{"part":{"id":"p_`+sid+`","sessionID":"`+sid+`","messageID":"m_`+sid+`","type":"text","text":""}}`))
	}
	// First delta of a burst always flushes; subsequent ones buffer for the hour.
	applyDelta(s, "a", "m_a", "p_a", "text", "A1")
	applyDelta(s, "a", "m_a", "p_a", "text", "A2") // buffered
	applyDelta(s, "b", "m_b", "p_b", "text", "B1")
	applyDelta(s, "b", "m_b", "p_b", "text", "B2") // buffered — must NOT be lost

	// Scoped to "a": "a" is flushed (A1+A2 materialize); "b" is NOT flushed and
	// (correctly) omitted from messages.
	scoped := s.Snapshot(map[string]bool{"a": true})
	if got := partText(scoped, "a", "p_a"); got != "A1A2" {
		t.Fatalf(`scoped snapshot must project selected "a"'s buffered deltas, want A1A2, got %q`, got)
	}
	if _, ok := scoped.Messages["b"]; ok {
		t.Fatal(`scoped snapshot must NOT ship unselected "b"'s messages`)
	}

	// Full snapshot must converge "b"'s still-buffered deltas (B1B2) — proving
	// the scoped projection did not drop them (deltaBuf is untouched by the
	// read-side projection; the writer's accumulator survives).
	full := s.Snapshot(nil)
	if got := partText(full, "b", "p_b"); got != "B1B2" {
		t.Fatalf(`full Snapshot(nil) must converge unselected "b"'s buffered deltas (no data loss), want B1B2, got %q`, got)
	}
	if got := partText(full, "a", "p_a"); got != "A1A2" {
		t.Fatalf(`full Snapshot(nil) must retain "a"'s materialized text, want A1A2, got %q`, got)
	}
}

// messageInternalsSnapshot captures the subset of a messageEntry's mutable
// internal state that a PURE Snapshot must NOT disturb: the me.parts byte
// slices, the deltaBuf accumulator contents (per key, the Builder's current
// text), deltaLastEmit, and the partOrder. Used by
// TestSnapshotIsObservationallyPure to prove Snapshot leaves the store's
// internals byte-identical.
type messageInternalsSnapshot struct {
	parts           map[string][]byte
	deltaBufText    map[string]string
	deltaLastEmit   time.Time
	liveTouchedBody bool
	partOrder       []string
}

// storeInternalsSnapshot is the store-wide aggregate captured by
// captureStoreInternals: every messageEntry's internals plus the Store-level
// mutable counters (seq, ring head/count, subscriber id counter, subscriber
// count). A pure Snapshot leaves ALL of these byte-identical.
type storeInternalsSnapshot struct {
	parts     map[string]map[string]messageInternalsSnapshot
	seq       uint64
	ringHead  int
	ringCount int
	nextSub   int
	numSubs   int
}

func captureMessageInternals(me *messageEntry) messageInternalsSnapshot {
	out := messageInternalsSnapshot{
		parts:           make(map[string][]byte, len(me.parts)),
		deltaBufText:    make(map[string]string, len(me.deltaBuf)),
		deltaLastEmit:   me.deltaLastEmit,
		liveTouchedBody: me.liveTouchedBody,
		partOrder:       append([]string(nil), me.partOrder...),
	}
	for k, v := range me.parts {
		out.parts[k] = append([]byte(nil), v...)
	}
	for k, b := range me.deltaBuf {
		if b != nil {
			out.deltaBufText[k] = b.String()
		}
	}
	return out
}

// TestSnapshotIsObservationallyPure is the headline purity gate for sub-phase
// 2.2: Snapshot must be a PURE READ PROJECTION that mutates NO store state. It
// builds a store with buffered streaming deltas (some flushed into me.parts,
// some still in deltaBuf), captures the per-messageEntry internal fields a
// write-back would disturb, calls Snapshot TWICE (once full firehose, once
// scoped), then re-captures and asserts byte-identical internals. It also
// asserts both snapshots produce identical OUTPUT for an in-scope session (a
// pure read over unchanged state is deterministic).
//
// SCOPE OF CAPTURE: it captures me.parts, me.deltaBuf (Builder text),
// me.deltaLastEmit, me.liveTouchedBody, me.partOrder, plus Store-level seq /
// ring head+count / subscriber id+count. It does NOT capture Store-level
// msgRev / nextMsgRev (those are bumped ONLY on the Apply write path and are
// NOT touched by a read-only Snapshot — asserting them here would be
// redundant with the "Snapshot never calls bumpMsgRev" contract) nor the
// per-part liveTouchedParts map (only set while a cold GET is in flight, which
// this test never triggers). The capture is the set of fields a HISTORICAL
// flush-back would have mutated, not an exhaustive dump of every Store field.
//
// Fails if Snapshot regresses to the HISTORICAL mutating path (calling the
// write-side flushPartDeltasLocked, which would rewrite me.parts, bump nothing
// here, but still mutate me.parts and the deltaBuf-adjacent state) or to
// mutating ANY captured field.
func TestSnapshotIsObservationallyPure(t *testing.T) {
	// Stretch the throttle window so deltas after the first stay buffered —
	// this is what gives Snapshot something to project (deltaBuf non-empty).
	withFlushInterval(t, time.Hour)

	s := New(100)
	for _, sid := range []string{"a", "b"} {
		s.Apply(ev("session.created", `{"info":{"id":"`+sid+`"}}`))
		s.Apply(ev("message.updated", `{"info":{"id":"m_`+sid+`","sessionID":"`+sid+`","role":"assistant"}}`))
		s.Apply(ev("message.part.updated", `{"part":{"id":"p_`+sid+`","sessionID":"`+sid+`","messageID":"m_`+sid+`","type":"text","text":""}}`))
	}
	// First delta of a burst always flushes → me.parts "A1"/"B1"; the second
	// delta buffers (deltaFlushInterval=time.Hour) → deltaBuf non-empty, me.parts
	// lags. This is exactly the state whose projection overlay a flush would
	// disturb.
	applyDelta(s, "a", "m_a", "p_a", "text", "A1")
	applyDelta(s, "a", "m_a", "p_a", "text", "A2") // buffered
	applyDelta(s, "b", "m_b", "p_b", "text", "B1")
	applyDelta(s, "b", "m_b", "p_b", "text", "B2") // buffered

	// Subscribe so the subscriber-side state (s.subs, s.next) is also in scope
	// for purity: a pure Snapshot must not add/remove subscribers.
	ch, unsub := s.Subscribe(8)
	defer unsub()
	drainAll(ch)

	// Capture the full set of internal fields a flush or emit would touch.
	captureStoreInternals := func() storeInternalsSnapshot {
		out := storeInternalsSnapshot{
			parts: map[string]map[string]messageInternalsSnapshot{},
		}
		s.mu.RLock()
		defer s.mu.RUnlock()
		for sid, sm := range s.messages {
			out.parts[sid] = map[string]messageInternalsSnapshot{}
			for mid, me := range sm.byID {
				out.parts[sid][mid] = captureMessageInternals(me)
			}
		}
		out.seq = s.seq
		if s.ring != nil {
			out.ringHead = s.ring.head
			out.ringCount = s.ring.count
		}
		out.nextSub = s.next
		out.numSubs = len(s.subs)
		return out
	}

	before := captureStoreInternals()

	// Two snapshots back-to-back: full firehose + scoped. A pure read leaves
	// the store byte-identical and produces deterministic in-scope output.
	fullSnap := s.Snapshot(nil)
	scopedSnap := s.Snapshot(map[string]bool{"a": true})

	after := captureStoreInternals()

	// Purity assertion 1: every captured internal field is byte-identical.
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("Snapshot mutated store internals:\nbefore=%+v\nafter =%+v", before, after)
	}

	// Purity assertion 2: the in-scope session "a" produces identical output in
	// the full and scoped snapshots (a pure read over unchanged state is
	// deterministic — and the scoped path overlays deltaBuf exactly like the
	// full path).
	if gotFull, gotScoped := partText(fullSnap, "a", "p_a"), partText(scopedSnap, "a", "p_a"); gotFull != gotScoped {
		t.Fatalf("in-scope output drifted between full and scoped snapshots: full=%q scoped=%q", gotFull, gotScoped)
	}
	// And the projection overlay itself still works — the buffered "A2" must
	// appear in the snapshot OUTPUT even though me.parts["p_a"] still holds
	// only "A1" (proven by the deep-equal assertion above).
	if got := partText(scopedSnap, "a", "p_a"); got != "A1A2" {
		t.Fatalf("scoped snapshot projection must overlay buffered A2, want A1A2, got %q", got)
	}
}

// TestSnapshotConcurrentWithApply is the headline race/deadlock gate for the
// Snapshot RLock move (sub-phase 2.3): multiple goroutines take snapshots
// (full firehose AND scoped) while a writer concurrently applies part deltas
// and message upserts. Under -race this must report no data race; the
// goroutines must all complete (no deadlock from RLock/Lock interaction).
//
// The signal is race-clean + completion within the test timeout — NOT a
// precise wall-clock overlap assertion (RLock-vs-Lock scheduling is host-
// dependent). The store's existing single-writer serialization still holds:
// Apply takes s.mu (write), Snapshot takes s.mu.RLock (read); concurrent
// Snapshots overlap with each other and serialize only against the writer.
func TestSnapshotConcurrentWithApply(t *testing.T) {
	s := New(64)
	for _, sid := range []string{"x", "y"} {
		s.Apply(ev("session.created", `{"info":{"id":"`+sid+`"}}`))
		s.Apply(ev("message.updated", `{"info":{"id":"m_`+sid+`","sessionID":"`+sid+`","role":"assistant"}}`))
		s.Apply(ev("message.part.updated", `{"part":{"id":"p_`+sid+`","sessionID":"`+sid+`","messageID":"m_`+sid+`","type":"text","text":""}}`))
	}

	const mutations = 300
	const snapsFull = 150
	const snapsScoped = 150
	var wg sync.WaitGroup

	// Writer: rapidly applies part deltas (which append to deltaBuf and may
	// trigger a throttled flush rewriting me.parts) and occasional authoritative
	// message.part.updated upserts. This exercises both the deltaBuf path and
	// the direct me.parts-replace path against concurrent Snapshot readers.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < mutations; i++ {
			sid := "x"
			if i%2 == 0 {
				sid = "y"
			}
			s.Apply(ev("message.part.delta",
				`{"sessionID":"`+sid+`","messageID":"m_`+sid+`","partID":"p_`+sid+`","field":"text","delta":"d`+strconv.Itoa(i)+`"}`))
			// Every 7th iteration, an authoritative overwrite resets the part
			// text and discards the buffered accumulator — exercises the
			// me.parts replace path under concurrent readers.
			if i%7 == 0 {
				s.Apply(ev("message.part.updated",
					`{"part":{"id":"p_`+sid+`","sessionID":"`+sid+`","messageID":"m_`+sid+`","type":"text","text":"reset`+strconv.Itoa(i)+`"}}`))
			}
		}
	}()

	// Reader A: full firehose snapshots.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < snapsFull; i++ {
			snap := s.Snapshot(nil)
			// Smoke-check the shape so a non-deterministic panic (e.g. nil-map
			// access from a torn read) surfaces here rather than silently.
			_ = snap.Seq
			_ = len(snap.Messages)
			_ = len(snap.Sessions)
		}
	}()

	// Reader B: scoped snapshots. Two concurrent scoped readers + the full
	// reader above prove RLock overlap among readers.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < snapsScoped; i++ {
			snap := s.Snapshot(map[string]bool{"x": true})
			_ = snap.Seq
			// "x" is in scope; "y" must be absent from the scoped messages map
			// (shape contract — verify it doesn't drift under concurrency).
			if _, ok := snap.Messages["x"]; !ok {
				// "x" is being mutated concurrently; it always exists in
				// s.sessions, so its messages entry should always ship. A miss
				// would indicate a torn read.
				t.Errorf("scoped snapshot missing in-scope session x messages")
				return
			}
			// The UNSELECTED session "y" must NEVER leak into a snapshot scoped
			// to {"x": true} — not into messages, nor any per-session map. This
			// is the scope-leak guard; a regression that dropped the inScope
			// gate on any field would surface here under the concurrent writer.
			if _, ok := snap.Messages["y"]; ok {
				t.Errorf("scoped snapshot leaked unselected session y into messages")
				return
			}
			if _, ok := snap.Gate["y"]; ok {
				t.Errorf("scoped snapshot leaked unselected session y into gate")
				return
			}
			if _, ok := snap.Activity["y"]; ok {
				t.Errorf("scoped snapshot leaked unselected session y into activity")
				return
			}
		}
	}()

	wg.Wait()
}

// TestSnapshotCopiesAllRawMessageBytes is the proving test for the Snapshot
// copy invariant (Finding 1): EVERY json.RawMessage byte that escapes the RLock
// must be a FRESH copy, never aliasing a store-owned backing array. It builds a
// store with every RawMessage-bearing snapshot field populated (gate tokens,
// currentVerb state, session info, message info + parts, todos, permissions,
// questions, statuses), takes a snapshot, OVERWRITES every byte of every
// returned RawMessage slice in-place with a sentinel, then takes a SECOND
// snapshot and asserts the second snapshot's bytes are UNCHANGED (the store was
// not corrupted).
//
// On the PRE-FIX code, mutating snap.Gate[sid].Tokens and
// snap.CurrentVerbs[sid].State corrupted se.lastTokens / se.currentVerb.State
// (the snapshot slices aliased the store-owned backing arrays), so the second
// snapshot read the corrupted bytes and this test FAILED. After the copy fix
// (append([]byte(nil), ...) for Tokens; a fresh VerbFacet with copied State for
// CurrentVerbs) it PASSES. The remaining fields (Sessions/Messages/Todos/etc.)
// were ALREADY copied via projectPartLocked / append([]byte(nil), ...); their
// rows here are regression guards that catch any future revert of those copies.
func TestSnapshotCopiesAllRawMessageBytes(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a","title":"root"}}`))
	// A completed assistant turn with token usage → populates se.lastTokens.
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","time":{"created":1,"completed":2},"finish":"stop","tokens":{"input":10,"output":20,"total":30}}}`))
	// A running tool part → populates se.currentVerb (Tool + State).
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"a","messageID":"m1","type":"tool","tool":"read","state":{"status":"running","input":{"filePath":"src/parser.go"},"time":{"start":4000}}}}`))
	// A text part → makes Messages[].Parts non-empty with a real base to copy.
	s.Apply(ev("message.part.updated", `{"part":{"id":"p2","sessionID":"a","messageID":"m1","type":"text","text":"hello"}}`))
	// The remaining RawMessage-bearing snapshot fields.
	s.Apply(ev("todo.updated", `{"sessionID":"a","todos":[{"content":"ship it"}]}`))
	s.Apply(ev("permission.asked", `{"id":"per_1","sessionID":"a","permission":"bash","title":"run x"}`))
	s.Apply(ev("question.asked", `{"id":"q_1","sessionID":"a"}`))
	s.Apply(ev("session.status", `{"sessionID":"a","status":{"type":"busy","message":"working"}}`))

	snap1 := s.Snapshot(nil)

	// saveAndCorrupt returns a pristine COPY of b and then OVERWRITES every byte
	// of b's backing array in place. If b aliases a store-owned backing array,
	// the in-place write corrupts the store (caught by the second snapshot).
	saveAndCorrupt := func(b json.RawMessage) []byte {
		pristine := append([]byte(nil), b...)
		for i := range b {
			b[i] = 0x01 // invalid-in-JSON sentinel
		}
		return pristine
	}

	// Headline (Finding 1): gate tokens + current-verb state.
	wantTokens := saveAndCorrupt(snap1.Gate["a"].Tokens)
	verb := snap1.CurrentVerbs["a"]
	wantVerbState := saveAndCorrupt(verb.State)

	// Regression guards for every OTHER RawMessage-bearing snapshot field.
	wantSessionInfo := saveAndCorrupt(snap1.Sessions[0])
	var wantMsgInfo []byte
	var wantMsgParts [][]byte
	for _, m := range snap1.Messages["a"] {
		wantMsgInfo = saveAndCorrupt(m.Info)
		for _, p := range m.Parts {
			wantMsgParts = append(wantMsgParts, saveAndCorrupt(p))
		}
	}
	wantTodo := saveAndCorrupt(snap1.Todos["a"])
	wantStatus := saveAndCorrupt(snap1.Statuses["a"])
	var wantPerms, wantQuestions [][]byte
	for _, p := range snap1.Permissions["a"] {
		wantPerms = append(wantPerms, saveAndCorrupt(p))
	}
	for _, q := range snap1.Questions["a"] {
		wantQuestions = append(wantQuestions, saveAndCorrupt(q))
	}

	// Sanity: every corruption target must be non-empty, else the test proves
	// nothing (an empty slice has no bytes to alias).
	if len(wantTokens) == 0 {
		t.Fatal("Gate tokens empty — setup did not populate se.lastTokens")
	}
	if len(wantVerbState) == 0 {
		t.Fatal("CurrentVerbs state empty — setup did not populate se.currentVerb.State")
	}
	if len(wantSessionInfo) == 0 || len(wantMsgInfo) == 0 || len(wantMsgParts) == 0 ||
		len(wantTodo) == 0 || len(wantStatus) == 0 || len(wantPerms) == 0 || len(wantQuestions) == 0 {
		t.Fatalf("a RawMessage-bearing snapshot field is empty — setup incomplete: info=%d msgInfo=%d parts=%d todo=%d status=%d perms=%d questions=%d",
			len(wantSessionInfo), len(wantMsgInfo), len(wantMsgParts), len(wantTodo), len(wantStatus), len(wantPerms), len(wantQuestions))
	}

	// Second snapshot: the store must be UNAFFECTED by the in-place corruption
	// of snap1's bytes (no aliasing). Each field must match its pristine copy.
	snap2 := s.Snapshot(nil)

	if got := snap2.Gate["a"].Tokens; !bytes.Equal(got, wantTokens) {
		t.Fatalf("Gate tokens aliased store bytes: in-place mutation corrupted se.lastTokens.\nwant %s\n got %s", wantTokens, got)
	}
	if got := snap2.CurrentVerbs["a"].State; !bytes.Equal(got, wantVerbState) {
		t.Fatalf("CurrentVerbs state aliased store bytes: in-place mutation corrupted se.currentVerb.State.\nwant %s\n got %s", wantVerbState, got)
	}
	if got := snap2.Sessions[0]; !bytes.Equal(got, wantSessionInfo) {
		t.Fatalf("Sessions info aliased store bytes.\nwant %s\n got %s", wantSessionInfo, got)
	}
	msgs := snap2.Messages["a"]
	if len(msgs) != 1 {
		t.Fatalf("want 1 message in snap2, got %d", len(msgs))
	}
	if got := msgs[0].Info; !bytes.Equal(got, wantMsgInfo) {
		t.Fatalf("Message info aliased store bytes.\nwant %s\n got %s", wantMsgInfo, got)
	}
	if len(msgs[0].Parts) != len(wantMsgParts) {
		t.Fatalf("want %d parts in snap2 message, got %d", len(wantMsgParts), len(msgs[0].Parts))
	}
	for i, want := range wantMsgParts {
		if got := msgs[0].Parts[i]; !bytes.Equal(got, want) {
			t.Fatalf("Message part %d aliased store bytes.\nwant %s\n got %s", i, want, got)
		}
	}
	if got := snap2.Todos["a"]; !bytes.Equal(got, wantTodo) {
		t.Fatalf("Todos aliased store bytes.\nwant %s\n got %s", wantTodo, got)
	}
	if got := snap2.Statuses["a"]; !bytes.Equal(got, wantStatus) {
		t.Fatalf("Statuses aliased store bytes.\nwant %s\n got %s", wantStatus, got)
	}
	perms2 := snap2.Permissions["a"]
	if len(perms2) != len(wantPerms) {
		t.Fatalf("want %d permissions in snap2, got %d", len(wantPerms), len(perms2))
	}
	for i, want := range wantPerms {
		if got := perms2[i]; !bytes.Equal(got, want) {
			t.Fatalf("Permission %d aliased store bytes.\nwant %s\n got %s", i, want, got)
		}
	}
	questions2 := snap2.Questions["a"]
	if len(questions2) != len(wantQuestions) {
		t.Fatalf("want %d questions in snap2, got %d", len(wantQuestions), len(questions2))
	}
	for i, want := range wantQuestions {
		if got := questions2[i]; !bytes.Equal(got, want) {
			t.Fatalf("Question %d aliased store bytes.\nwant %s\n got %s", i, want, got)
		}
	}
}
