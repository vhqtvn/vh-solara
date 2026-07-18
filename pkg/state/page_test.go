package state

// This file pins the historical-page projection (Phase 2): projectMessagePage
// paginates a session's FULL transcript by an exclusive `before` cursor with a
// one-item overlap, dual-bounded by (limit, maxBytes). It is the pure heart of
// the GET /vh/session/{sessionId}/messages endpoint; SnapshotMessagesPage is the
// Store accessor that captures the full list under RLock and stamps the envelope.
//
// Contract (SETTLED):
//   - `before` is REQUIRED. The page is INCLUSIVE of `before` (overlap) +
//     strictly-older messages, creation-ordered (oldest first) so the client
//     prepends verbatim.
//   - `before` not found / empty → empty page, boundary_found=false.
//   - Oversized anchor (before alone > maxBytes) → [anchor] alone + diagnostics.
//   - Pure + deterministic (same input → same page + same metadata).

import (
	"encoding/json"
	"strings"
	"testing"
)

// pageMsg builds a MessageWithParts with id <id> and one text part of <textSize>
// 'x' bytes, identical in shape to winMsg but named for the page-test context.
func pageMsg(id string, textSize int) MessageWithParts {
	info := json.RawMessage(`{"id":"` + id + `","sessionID":"s","role":"user"}`)
	part := json.RawMessage(`{"id":"` + id + `-p0","type":"text","text":"` + strings.Repeat("x", textSize) + `"}`)
	return MessageWithParts{Info: info, Parts: []json.RawMessage{part}}
}

// fiveMessageList builds [m1..m5] each with a 10-byte text part, creation-ordered
// oldest-first. Used by the pure-helper tests as the canonical fixture.
func fiveMessageList() []MessageWithParts {
	return []MessageWithParts{
		pageMsg("m1", 10),
		pageMsg("m2", 10),
		pageMsg("m3", 10),
		pageMsg("m4", 10),
		pageMsg("m5", 10),
	}
}

// TestPage_IncludesOverlap pins the one-item overlap contract: the page's NEWEST
// item is always the `before` message itself (the client dedups it against its
// resident window). Without the overlap, a resident cache that evicted the
// boundary would show a silent gap.
func TestPage_IncludesOverlap(t *testing.T) {
	list := fiveMessageList() // [m1..m5]
	res := projectMessagePage(list, "m3", 5, 1<<20)
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true, got false")
	}
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m1", "m2", "m3"}) {
		t.Fatalf("items: want [m1 m2 m3] (overlap m3 + strictly-older m1,m2), got %v", got)
	}
	if res.NewestID != "m3" {
		t.Fatalf("newest_id: want m3 (overlap), got %q", res.NewestID)
	}
	if res.OldestID != "m1" {
		t.Fatalf("oldest_id: want m1, got %q", res.OldestID)
	}
	if res.HasOlder {
		t.Fatalf("has_older: want false (exhausted older messages), got true")
	}
	if res.CountLimited || res.BytesLimited {
		t.Fatalf("limits: want both false, got count=%v bytes=%v", res.CountLimited, res.BytesLimited)
	}
}

// TestPage_CountBound pins the dual bound's count axis: `limit` bounds TOTAL
// page size (overlap + older), matching projectMessageWindow's maxCount
// semantics. A limit=2 page anchored at m3 carries m3 + at most 1 older.
func TestPage_CountBound(t *testing.T) {
	list := fiveMessageList()
	res := projectMessagePage(list, "m3", 2, 1<<20)
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true, got false")
	}
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m2", "m3"}) {
		t.Fatalf("items: want [m2 m3] (limit=2: overlap + 1 older), got %v", got)
	}
	if !res.CountLimited {
		t.Fatalf("count_limited: want true (limit=2 hit with m1 still older)")
	}
	if res.BytesLimited {
		t.Fatalf("bytes_limited: want false, got true")
	}
	if !res.HasOlder {
		t.Fatalf("has_older: want true (m1 exists beyond the page), got false")
	}
	if res.MessageCount != 2 {
		t.Fatalf("message_count: want 2, got %d", res.MessageCount)
	}
}

// TestPage_ByteBound pins the dual bound's byte axis: when adding the next older
// message would exceed maxBytes, the page stops and signals bytes_limited +
// has_older.
func TestPage_ByteBound(t *testing.T) {
	// Each message ~ info(~40B) + part(~30B + 50 'x') ≈ 120B raw. Anchor m3
	// alone fits; adding m2 would cross ~240B. Set maxBytes=200 so the byte
	// bound fires after the anchor.
	list := fiveMessageList()
	anchorSize := messageSerializedBytes(list[2])
	maxBytes := anchorSize + 50 // room for the anchor only, not anchor+m2
	res := projectMessagePage(list, "m3", 5, maxBytes)
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true, got false")
	}
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m3"}) {
		t.Fatalf("items: want [m3] (byte bound stops before m2), got %v", got)
	}
	if !res.BytesLimited {
		t.Fatalf("bytes_limited: want true, got false")
	}
	if res.CountLimited {
		t.Fatalf("count_limited: want false, got true")
	}
	if !res.HasOlder {
		t.Fatalf("has_older: want true (m1,m2 exist beyond the page), got false")
	}
	if res.SerializedBytes != anchorSize {
		t.Fatalf("serialized_bytes: want %d (anchor only), got %d", anchorSize, res.SerializedBytes)
	}
}

// TestPage_OversizedAnchor pins the atomic-message guarantee on the page path:
// when the anchor (before) ALONE exceeds maxBytes, the page returns it alone +
// oversized_item / actual_bytes / budget_bytes so the client renders the item
// without a silent gap. has_older reflects whether older messages exist beyond
// the anchor.
func TestPage_OversizedAnchor(t *testing.T) {
	list := []MessageWithParts{
		pageMsg("m1", 10),
		pageMsg("m2", 500), // anchor, oversized
		pageMsg("m3", 10),
	}
	anchorSize := messageSerializedBytes(list[1])
	maxBytes := anchorSize - 1 // anchor alone exceeds budget
	res := projectMessagePage(list, "m2", 5, maxBytes)
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true, got false")
	}
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m2"}) {
		t.Fatalf("items: want [m2] (oversized anchor alone), got %v", got)
	}
	if !res.OversizedItem {
		t.Fatalf("oversized_item: want true, got false")
	}
	if res.ActualBytes != anchorSize {
		t.Fatalf("actual_bytes: want %d, got %d", anchorSize, res.ActualBytes)
	}
	if res.BudgetBytes != maxBytes {
		t.Fatalf("budget_bytes: want %d, got %d", maxBytes, res.BudgetBytes)
	}
	// m1 exists beyond the anchor → has_older true.
	if !res.HasOlder {
		t.Fatalf("has_older: want true (m1 exists beyond oversized anchor), got false")
	}
	if res.MessageCount != 1 {
		t.Fatalf("message_count: want 1, got %d", res.MessageCount)
	}
}

// TestPage_OversizedAnchor_NewestMessage: when the anchor is the OLDEST message
// (no older neighbors), the oversized case still returns it alone but has_older
// is false.
func TestPage_OversizedAnchor_OldestMessage(t *testing.T) {
	list := []MessageWithParts{
		pageMsg("m1", 500), // anchor, oversized, AND oldest
		pageMsg("m2", 10),
	}
	anchorSize := messageSerializedBytes(list[0])
	res := projectMessagePage(list, "m1", 5, anchorSize-1)
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true")
	}
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m1"}) {
		t.Fatalf("items: want [m1], got %v", got)
	}
	if !res.OversizedItem {
		t.Fatalf("oversized_item: want true")
	}
	if res.HasOlder {
		t.Fatalf("has_older: want false (anchor IS the oldest), got true")
	}
}

// TestPage_BeforeNotFound pins the stale-boundary contract: a cursor the store
// does not recognize (deleted-then-recreated, or a client bug) returns an empty
// page with boundary_found=false. The Contract-B dirty-flag (Phase 4 client) is
// the primary guard; this is the defined response when it does reach the server.
func TestPage_BeforeNotFound(t *testing.T) {
	list := fiveMessageList()
	res := projectMessagePage(list, "nonexistent", 5, 1<<20)
	if res.BoundaryFound {
		t.Fatalf("boundary_found: want false (cursor not in list)")
	}
	if len(res.Items) != 0 {
		t.Fatalf("items: want empty, got %v", msgIDs(res.Items))
	}
	if res.NewestID != "" || res.OldestID != "" {
		t.Fatalf("ids: want empty (no boundary), got newest=%q oldest=%q", res.NewestID, res.OldestID)
	}
	if res.HasOlder {
		t.Fatalf("has_older: want false when boundary not found")
	}
}

// TestPage_EmptyBefore pins the required-cursor contract: before="" returns an
// empty page with boundary_found=false. The initial window (Phase 1) is the
// documented source of the first cursor; a missing cursor is a client bug.
func TestPage_EmptyBefore(t *testing.T) {
	list := fiveMessageList()
	res := projectMessagePage(list, "", 5, 1<<20)
	if res.BoundaryFound {
		t.Fatalf("boundary_found: want false (no cursor)")
	}
	if len(res.Items) != 0 {
		t.Fatalf("items: want empty, got %v", msgIDs(res.Items))
	}
}

// TestPage_EmptyList pins the empty-transcript contract: a present-but-empty
// session (no messages) returns an empty page with boundary_found=false (a
// present cursor cannot exist in an empty list).
func TestPage_EmptyList(t *testing.T) {
	res := projectMessagePage([]MessageWithParts{}, "m1", 5, 1<<20)
	if res.BoundaryFound {
		t.Fatalf("boundary_found: want false (empty list)")
	}
	if res.Items == nil {
		t.Fatalf("items: want non-nil empty slice, got nil")
	}
	if len(res.Items) != 0 {
		t.Fatalf("items: want empty, got %v", msgIDs(res.Items))
	}
}

// TestPage_BeforeIsOldest pins the end-of-history case: when the anchor IS the
// oldest message, the page is [anchor] alone, boundary_found=true, has_older=
// false (the client renders NO further "Load older" affordance below this page).
func TestPage_BeforeIsOldest(t *testing.T) {
	list := fiveMessageList() // m1 is oldest
	res := projectMessagePage(list, "m1", 5, 1<<20)
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true")
	}
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m1"}) {
		t.Fatalf("items: want [m1] (oldest, no older neighbors), got %v", got)
	}
	if res.HasOlder {
		t.Fatalf("has_older: want false (anchor is oldest), got true")
	}
	if res.NewestID != "m1" || res.OldestID != "m1" {
		t.Fatalf("ids: want newest=oldest=m1, got newest=%q oldest=%q", res.NewestID, res.OldestID)
	}
}

// TestPage_BeforeIsNewest pins the anchor-at-tail case: when the anchor IS the
// newest message, the page walks ALL older messages (bounded by limit/bytes).
// This is the first "Load older" click after the initial window.
func TestPage_BeforeIsNewest(t *testing.T) {
	list := fiveMessageList() // m5 is newest
	res := projectMessagePage(list, "m5", 5, 1<<20)
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true")
	}
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m1", "m2", "m3", "m4", "m5"}) {
		t.Fatalf("items: want [m1..m5] (overlap + all older), got %v", got)
	}
	if res.HasOlder {
		t.Fatalf("has_older: want false (exhausted), got true")
	}
	if res.NewestID != "m5" {
		t.Fatalf("newest_id: want m5, got %q", res.NewestID)
	}
	if res.OldestID != "m1" {
		t.Fatalf("oldest_id: want m1, got %q", res.OldestID)
	}
}

// TestPage_Ordering pins that the page is creation-ordered (oldest first) so the
// client prepends the slice verbatim after dedup. The projector walks
// newest-to-oldest internally but reverses before returning.
func TestPage_Ordering(t *testing.T) {
	list := fiveMessageList()
	res := projectMessagePage(list, "m4", 5, 1<<20)
	// m4 + strictly older m1,m2,m3 → [m1,m2,m3,m4]
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m1", "m2", "m3", "m4"}) {
		t.Fatalf("items: want [m1 m2 m3 m4] (creation-ordered), got %v", got)
	}
}

// TestPage_Determinism pins the purity contract: same input list + cursor → same
// page + same metadata. This is what lets the page serve as a point-in-time
// Contract-B snapshot the client validates against its cursor.
func TestPage_Determinism(t *testing.T) {
	list := fiveMessageList()
	r1 := projectMessagePage(list, "m3", 3, 1<<20)
	r2 := projectMessagePage(list, "m3", 3, 1<<20)
	if !equalMessageLists(r1.Items, r2.Items) {
		t.Fatalf("determinism: items differ between calls")
	}
	if r1.MessageCount != r2.MessageCount ||
		r1.SerializedBytes != r2.SerializedBytes ||
		r1.HasOlder != r2.HasOlder ||
		r1.CountLimited != r2.CountLimited ||
		r1.BytesLimited != r2.BytesLimited ||
		r1.OldestID != r2.OldestID ||
		r1.NewestID != r2.NewestID ||
		r1.BoundaryFound != r2.BoundaryFound {
		t.Fatalf("determinism: metadata differs: r1=%+v r2=%+v", r1, r2)
	}
}

// TestPage_ItemsAlwaysNonNil pins that the projector NEVER returns a nil Items
// slice — empty pages return []MessageWithParts{} so the JSON wire shape is
// "items":[] (NOT "items":null). A null would break the client's prepend loop.
func TestPage_ItemsAlwaysNonNil(t *testing.T) {
	cases := []struct {
		name   string
		list   []MessageWithParts
		before string
	}{
		{"empty list", []MessageWithParts{}, "m1"},
		{"empty before", fiveMessageList(), ""},
		{"before not found", fiveMessageList(), "nope"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := projectMessagePage(tc.list, tc.before, 5, 1<<20)
			if res.Items == nil {
				t.Fatalf("items: want non-nil empty slice, got nil")
			}
		})
	}
}

// --- Store accessor tests ---

// TestSnapshotMessagesPage_Accessor pins the end-to-end Store accessor: seed
// messages via Apply, paginate via SnapshotMessagesPage, assert the envelope is
// stamped (SessionID, DaemonEpoch, BaselineSeq) and the items match the
// projectMessagePage contract.
func TestSnapshotMessagesPage_Accessor(t *testing.T) {
	s := New(100)
	seedFourMessages(t, s, "pg") // m1..m4, no parts
	res := s.SnapshotMessagesPage("pg", "m3", 5, 1<<20)
	if res.SessionID != "pg" {
		t.Fatalf("session_id: want pg, got %q", res.SessionID)
	}
	if res.DaemonEpoch != s.Epoch() {
		t.Fatalf("daemon_epoch: want %q, got %q", s.Epoch(), res.DaemonEpoch)
	}
	if res.BaselineSeq != s.Head() {
		t.Fatalf("baseline_seq: want %d, got %d", s.Head(), res.BaselineSeq)
	}
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true")
	}
	// m3 + strictly older m1,m2 → [m1,m2,m3]
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m1", "m2", "m3"}) {
		t.Fatalf("items: want [m1 m2 m3], got %v", got)
	}
	if res.NewestID != "m3" || res.OldestID != "m1" {
		t.Fatalf("ids: want newest=m3 oldest=m1, got newest=%q oldest=%q", res.NewestID, res.OldestID)
	}
}

// TestSnapshotMessagesPage_MissingSession pins that a session the store does not
// know returns an empty page with the envelope still stamped (SessionID echoed,
// DaemonEpoch/BaselineSeq current). The client distinguishes "session gone"
// from "session empty" by the epoch/seq + the boundary_found=false + items=[].
func TestSnapshotMessagesPage_MissingSession(t *testing.T) {
	s := New(100)
	res := s.SnapshotMessagesPage("ghost", "m1", 5, 1<<20)
	if res.SessionID != "ghost" {
		t.Fatalf("session_id: want ghost (echoed), got %q", res.SessionID)
	}
	if res.DaemonEpoch != s.Epoch() {
		t.Fatalf("daemon_epoch: want current epoch, got %q", res.DaemonEpoch)
	}
	if res.BoundaryFound {
		t.Fatalf("boundary_found: want false (session unknown)")
	}
	if res.Items == nil || len(res.Items) != 0 {
		t.Fatalf("items: want non-nil empty, got %v", res.Items)
	}
}

// TestSnapshotMessagesPage_DefaultsWhenBoundsZero pins that limit<=0 / maxBytes
// <=0 fall back to the package WindowMaxCount / WindowMaxBytes defaults, so the
// HTTP handler is safe to call SnapshotMessagesPage with no query params beyond
// `before`. Shrinks the defaults so the fallback is observable without seeding
// 100+ messages.
func TestSnapshotMessagesPage_DefaultsWhenBoundsZero(t *testing.T) {
	withWindowBounds(t, 2, 1<<20)
	s := New(100)
	seedFourMessages(t, s, "df") // m1..m4
	// limit=0 → defaults to WindowMaxCount=2; page = [m2,m3] (overlap m3 + 1 older)
	res := s.SnapshotMessagesPage("df", "m3", 0, 0)
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true")
	}
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m2", "m3"}) {
		t.Fatalf("items: want [m2 m3] (limit defaulted to 2), got %v", got)
	}
	if !res.CountLimited {
		t.Fatalf("count_limited: want true (limit=2 hit)")
	}
}

// TestSnapshotMessagesPage_DefensiveCopy pins that the accessor's captured info
// + parts are defensive copies: mutating the returned Items slices (or the
// underlying store state after capture) does NOT change a re-paginated result.
// This is the -race safety the capture loop's append([]byte(nil), ...) provides.
func TestSnapshotMessagesPage_DefensiveCopy(t *testing.T) {
	s := New(100)
	seedFourMessages(t, s, "dc") // m1..m4
	r1 := s.SnapshotMessagesPage("dc", "m3", 5, 1<<20)
	// Corrupt the returned info bytes in place.
	if len(r1.Items) > 0 {
		copy(r1.Items[0].Info, []byte("ZZZZZZZZ"))
	}
	// Re-paginate: the store's internal bytes must be unaffected.
	r2 := s.SnapshotMessagesPage("dc", "m3", 5, 1<<20)
	if !equalMessageLists(r1.Items, r2.Items) {
		// r1 was corrupted by the test; compare r2 against a fresh capture.
		r3 := s.SnapshotMessagesPage("dc", "m3", 5, 1<<20)
		if !equalMessageLists(r2.Items, r3.Items) {
			t.Fatalf("defensive copy: two clean captures differ (store corrupted by return-value mutation)")
		}
	}
	// The IDs must still parse correctly (the corruption did not leak in).
	for i, want := range []string{"m1", "m2", "m3"} {
		if got := messageIDFromInfo(r2.Items[i].Info); got != want {
			t.Fatalf("defensive copy leak: item[%d] id want %q, got %q", i, want, got)
		}
	}
}
