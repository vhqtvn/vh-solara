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
//   - Oversized anchor (before alone > maxBytes): anchorIdx==0 (anchor IS the
//     session's oldest) → [anchor] alone + diagnostics; anchorIdx>0 (anchor
//     HAS older history) → the required atomic pair [neighbor, anchor] so
//     OldestID advances past the cursor (NEVER [anchor] alone with HasOlder=
//     true, which was the zero-progress stall).
//   - Pure + deterministic (same input → same page + same metadata).

import (
	"encoding/json"
	"fmt"
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
// has_older. After the forward-progress fix, the FIRST strictly-older message is
// always force-included (atomic), so the byte bound stops the page at
// [first-older, anchor] — NOT [anchor] alone — and bytes_limited fires on the
// NEXT older message (the one that would cross the budget).
func TestPage_ByteBound(t *testing.T) {
	// Each message ~ info(~40B) + part(~49B) ≈ 89B raw. Anchor m3 alone fits;
	// the first strictly-older m2 is force-included (anchor+m2 ≈ 178B); adding
	// m1 would cross further. Set maxBytes = anchorSize+50 so the byte bound
	// fires on m1 (the message AFTER the force-included first-older).
	list := fiveMessageList()
	anchorSize := messageSerializedBytes(list[2])
	maxBytes := anchorSize + 50 // room for anchor + force-included m2, not +m1
	res := projectMessagePage(list, "m3", 5, maxBytes)
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true, got false")
	}
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m2", "m3"}) {
		t.Fatalf("items: want [m2 m3] (force-included first-older + anchor), got %v", got)
	}
	if !res.BytesLimited {
		t.Fatalf("bytes_limited: want true (m1 would cross budget), got false")
	}
	if res.CountLimited {
		t.Fatalf("count_limited: want false, got true")
	}
	if !res.HasOlder {
		t.Fatalf("has_older: want true (m1 exists beyond the page), got false")
	}
	if res.OldestID != "m2" {
		t.Fatalf("oldest_id: want m2 (advanced past cursor m3), got %q", res.OldestID)
	}
	wantBytes := anchorSize + messageSerializedBytes(list[1])
	if res.SerializedBytes != wantBytes {
		t.Fatalf("serialized_bytes: want %d (anchor + force-included m2), got %d", wantBytes, res.SerializedBytes)
	}
}

// TestPage_OversizedAnchor pins the atomic-message guarantee on the page path:
// when the anchor (before) ALONE exceeds maxBytes AND the anchor HAS older
// history (anchorIdx > 0, sub-case d), the page returns the REQUIRED ATOMIC
// PAIR [neighbor, anchor] so OldestID ADVANCES past the cursor — NEVER [anchor]
// alone with HasOlder=true (that was the zero-progress stall). has_older
// reflects whether messages exist beyond the neighbor; oversized_item stays
// true so the D-triggers do not misfire.
func TestPage_OversizedAnchor(t *testing.T) {
	list := []MessageWithParts{
		pageMsg("m1", 10),  // strictly older than the anchor
		pageMsg("m2", 500), // anchor, oversized
		pageMsg("m3", 10),
	}
	anchorSize := messageSerializedBytes(list[1])
	maxBytes := anchorSize - 1 // anchor alone exceeds budget
	res := projectMessagePage(list, "m2", 5, maxBytes)
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true, got false")
	}
	// CRUX: the page MUST return the pair [m1, m2], not [m2] alone. Without
	// this, OldestID stays at the cursor m2 and HasOlder=true → infinite stall.
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m1", "m2"}) {
		t.Fatalf("items: want [m1 m2] (required atomic pair: neighbor + oversized anchor), got %v", got)
	}
	if res.OldestID != "m1" {
		t.Fatalf("oldest_id: want m1 (advanced past cursor m2), got %q (STALL: cursor never advanced)", res.OldestID)
	}
	if res.NewestID != "m2" {
		t.Fatalf("newest_id: want m2 (overlap == RequestBefore), got %q", res.NewestID)
	}
	// m1 IS the session's oldest (index 0, no further older) → has_older false
	// (truthful end-of-history beyond the pair).
	if res.HasOlder {
		t.Fatalf("has_older: want false (m1 is the session's oldest; truthful end-of-history), got true")
	}
	if !res.OversizedItem {
		t.Fatalf("oversized_item: want true (anchor alone > maxBytes), got false")
	}
	if res.ActualBytes != anchorSize {
		t.Fatalf("actual_bytes: want %d (the oversized anchor's size), got %d", anchorSize, res.ActualBytes)
	}
	if res.BudgetBytes != maxBytes {
		t.Fatalf("budget_bytes: want %d, got %d", maxBytes, res.BudgetBytes)
	}
	if res.MessageCount != 2 {
		t.Fatalf("message_count: want 2 (the required pair), got %d", res.MessageCount)
	}
	if res.SerializedBytes != anchorSize+messageSerializedBytes(list[0]) {
		t.Fatalf("serialized_bytes: want %d (truthful pair total: anchor + m1), got %d", anchorSize+messageSerializedBytes(list[0]), res.SerializedBytes)
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

// --- Forward-progress guarantee tests (regression: zero-progress stall) ---
//
// projectMessagePage guarantees that for EVERY page where BoundaryFound==true &&
// HasOlder==true, OldestID advances to at least one STRICTLY-OLDER message. The
// first strictly-older is ALWAYS included (atomic), mirroring projectMessageWindow's
// "newest always included even if oversized" rule. Without this, anchor +
// first-older > maxBytes would leave the page at [anchor] with OldestID == before
// (never advanced) → the client merges 0 new messages and refetches the identical
// zero-progress page forever.

// TestPage_ForwardProgress_ByteOvershoot is the CORE stall regression (sub-case
// b): anchor + first-strictly-older > maxBytes, but the first-older alone fits.
// Before the fix the page returned [anchor] alone with OldestID == before and
// bytes_limited == true → infinite refetch loop. After the fix the first-older
// is force-included; OldestID advances. bytes_limited is the "overshot budget
// by one atomic item" signal — it fires on the NEXT older message IF one
// remains. Here m0 IS the session's oldest (list [m0, m1(anchor), m2]), so the
// loop exits naturally at the floor and bytes_limited stays FALSE (truthful
// end-of-history). The companion test WithMoreOlder covers the variant where a
// further older message does remain and bytes_limited fires.
func TestPage_ForwardProgress_ByteOvershoot(t *testing.T) {
	// [m0, m1(anchor), m2]: m0 and m1 are each ~89B; anchor m1 alone fits the
	// budget, but anchor + m0 (178B) exceeds it. m0 alone (89B) fits.
	list := []MessageWithParts{
		pageMsg("m0", 10),
		pageMsg("m1", 10), // anchor
		pageMsg("m2", 10),
	}
	anchorSize := messageSerializedBytes(list[1])
	maxBytes := anchorSize + 50 // fits anchor alone and m0 alone, but NOT anchor+m0
	res := projectMessagePage(list, "m1", 5, maxBytes)
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true, got false")
	}
	// CRUX: the page MUST include the first strictly-older (m0), not just the
	// anchor. Without this, OldestID stays at the cursor → infinite stall.
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m0", "m1"}) {
		t.Fatalf("items: want [m0 m1] (force-included first-older + anchor), got %v", got)
	}
	if res.OldestID != "m0" {
		t.Fatalf("oldest_id: want m0 (advanced past cursor m1), got %q (STALL: cursor never advanced)", res.OldestID)
	}
	// bytes_limited is the "overshot budget by one atomic item" signal: it
	// fires when the byte bound rejects the NEXT older message after the
	// force-included first-older. Here m0 IS the session's oldest (index 0, no
	// further older), so the loop exits naturally with no limit flag →
	// bytes_limited false, has_older false (truthful end-of-history).
	if res.HasOlder {
		t.Fatalf("has_older: want false (m0 is the session's oldest; truthful end-of-history), got true")
	}
	if res.BytesLimited {
		t.Fatalf("bytes_limited: want false (loop exited naturally at the oldest), got true")
	}
	if res.CountLimited {
		t.Fatalf("count_limited: want false, got true")
	}
	if res.OversizedItem {
		t.Fatalf("oversized_item: want false (sub-case b, not c), got true")
	}
}

// TestPage_ForwardProgress_ByteOvershoot_WithMoreOlder is sub-case (b) where
// further older messages DO remain beyond the force-included first-older. Here
// bytes_limited fires on the next older message as the overshoot signal, and
// has_older is true (correctly).
func TestPage_ForwardProgress_ByteOvershoot_WithMoreOlder(t *testing.T) {
	// [m0, m1, m2(anchor), m3]: anchor m2 + first-older m1 > maxBytes, but m1
	// alone fits. m0 exists beyond m1 → has_older should be true.
	list := []MessageWithParts{
		pageMsg("m0", 10),
		pageMsg("m1", 10), // first strictly-older (force-included)
		pageMsg("m2", 10), // anchor
		pageMsg("m3", 10),
	}
	anchorSize := messageSerializedBytes(list[2])
	maxBytes := anchorSize + 50 // fits anchor alone and m1 alone, but NOT anchor+m1
	res := projectMessagePage(list, "m2", 5, maxBytes)
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true, got false")
	}
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m1", "m2"}) {
		t.Fatalf("items: want [m1 m2] (force-included first-older + anchor), got %v", got)
	}
	if res.OldestID != "m1" {
		t.Fatalf("oldest_id: want m1 (advanced past cursor m2), got %q", res.OldestID)
	}
	// m0 exists beyond the force-included m1 → bytes_limited fires on the m0
	// check (res.SerializedBytes already overshot, so m0 definitely overflows),
	// and has_older is true.
	if !res.BytesLimited {
		t.Fatalf("bytes_limited: want true (m0 would cross the overshot budget), got false")
	}
	if !res.HasOlder {
		t.Fatalf("has_older: want true (m0 exists beyond the page), got false")
	}
	if res.CountLimited {
		t.Fatalf("count_limited: want false, got true")
	}
}

// TestPage_ForwardProgress_OversizedNeighbor is sub-case (c): the first
// strictly-older alone exceeds maxBytes. The page MUST still include it (atomic
// forward progress); OldestID advances; oversized_item/actual_bytes/budget_bytes
// are stamped. bytes_limited/count_limited stay false (matching
// projectMessageWindow's oversized-newest precedent at window_test.go:164-165).
func TestPage_ForwardProgress_OversizedNeighbor(t *testing.T) {
	// [m0(big), m1(anchor), m2]: m0 alone (5000B) exceeds the budget (1000B).
	// m1 fits. The page force-includes m0 anyway for forward progress.
	list := []MessageWithParts{
		pageMsg("m0", 5000), // first strictly-older, oversized
		pageMsg("m1", 10),   // anchor
		pageMsg("m2", 10),
	}
	maxBytes := 1000
	neighborSize := messageSerializedBytes(list[0])
	res := projectMessagePage(list, "m1", 5, maxBytes)
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true, got false")
	}
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m0", "m1"}) {
		t.Fatalf("items: want [m0 m1] (force-included oversized neighbor + anchor), got %v", got)
	}
	if res.OldestID != "m0" {
		t.Fatalf("oldest_id: want m0 (advanced past cursor m1), got %q", res.OldestID)
	}
	if !res.OversizedItem {
		t.Fatalf("oversized_item: want true (neighbor alone > maxBytes), got false")
	}
	if res.ActualBytes != neighborSize {
		t.Fatalf("actual_bytes: want %d (the oversized neighbor's size), got %d", neighborSize, res.ActualBytes)
	}
	if res.BudgetBytes != maxBytes {
		t.Fatalf("budget_bytes: want %d, got %d", maxBytes, res.BudgetBytes)
	}
	// Matching projectMessageWindow's oversized precedent: bytes_limited and
	// count_limited are NOT set (the oversized short-circuit fires before either
	// bound is evaluated).
	if res.BytesLimited || res.CountLimited {
		t.Fatalf("bytes_limited/count_limited: want both false (oversized precedent), got bytes=%v count=%v", res.BytesLimited, res.CountLimited)
	}
	// m0 IS the session's oldest (index 0) → has_older false (truthful).
	if res.HasOlder {
		t.Fatalf("has_older: want false (m0 is the session's oldest), got true")
	}
}

// TestPage_ForwardProgress_OversizedNeighbor_WithMoreOlder: sub-case (c) where
// further older messages exist beyond the oversized neighbor. has_older is true;
// oversized_item still stamps the diagnostics.
func TestPage_ForwardProgress_OversizedNeighbor_WithMoreOlder(t *testing.T) {
	// [m0, m1(big), m2(anchor), m3]: m1 alone exceeds the budget. m0 exists
	// beyond m1 → has_older should be true.
	list := []MessageWithParts{
		pageMsg("m0", 10),
		pageMsg("m1", 5000), // first strictly-older, oversized
		pageMsg("m2", 10),   // anchor
		pageMsg("m3", 10),
	}
	maxBytes := 1000
	res := projectMessagePage(list, "m2", 5, maxBytes)
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true, got false")
	}
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m1", "m2"}) {
		t.Fatalf("items: want [m1 m2] (oversized neighbor + anchor), got %v", got)
	}
	if res.OldestID != "m1" {
		t.Fatalf("oldest_id: want m1 (advanced), got %q", res.OldestID)
	}
	if !res.OversizedItem {
		t.Fatalf("oversized_item: want true, got false")
	}
	// m0 exists beyond the oversized m1 → has_older true.
	if !res.HasOlder {
		t.Fatalf("has_older: want true (m0 exists beyond the oversized neighbor), got false")
	}
	if res.BytesLimited || res.CountLimited {
		t.Fatalf("bytes/count limited: want false (oversized precedent), got bytes=%v count=%v", res.BytesLimited, res.CountLimited)
	}
}

// TestPage_ForwardProgress_ForceIncludedIsOldest guards constraint #2: when the
// force-included first-older IS the session's oldest message (no further older
// exists), has_older MUST be false — do NOT leave a stale bytes_limited=true
// implying more exist. This is the truthful end-of-history signal.
func TestPage_ForwardProgress_ForceIncludedIsOldest(t *testing.T) {
	// [m0(big-ish), m1(anchor)]: m0 is the ONLY strictly-older. anchor + m0 >
	// maxBytes (sub-case b), but m0 alone fits. After force-including m0, the
	// loop exits (no further older) → bytes_limited stays false, has_older
	// stays false.
	list := []MessageWithParts{
		pageMsg("m0", 10), // the ONLY strictly-older; force-included
		pageMsg("m1", 10), // anchor
		pageMsg("m2", 10),
	}
	anchorSize := messageSerializedBytes(list[1])
	maxBytes := anchorSize + 50 // anchor + m0 > maxBytes, but m0 alone fits
	res := projectMessagePage(list, "m1", 5, maxBytes)
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true, got false")
	}
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m0", "m1"}) {
		t.Fatalf("items: want [m0 m1], got %v", got)
	}
	if res.OldestID != "m0" {
		t.Fatalf("oldest_id: want m0 (advanced), got %q", res.OldestID)
	}
	// CRUX (constraint #2): has_older MUST be false. m0 is the session's oldest;
	// a stale bytes_limited=true would imply more older exist (wrong).
	if res.HasOlder {
		t.Fatalf("has_older: want false (force-included m0 IS the session's oldest; constraint #2), got true")
	}
	if res.BytesLimited {
		t.Fatalf("bytes_limited: want false (loop exited at the oldest, no stale flag), got true")
	}
	if res.CountLimited {
		t.Fatalf("count_limited: want false, got true")
	}
}

// TestPage_ForwardProgress_ChainedWalk verifies that two successive "Load older"
// calls from above a big message each advance oldest_id STRICTLY — the client
// can walk backward through history without stalling. This is the end-to-end
// forward-progress guarantee: the fix at one page boundary does not create a
// stall at the next.
//
// This walk APPROACHES the big message from above (the realistic "Load older"
// direction): neither cursor IS the oversized message. The sibling
// TestPage_ForwardProgress_ChainedWalk_OversizedCursor covers the case where
// the cursor itself IS the oversized message (sub-case d: the required pair).
func TestPage_ForwardProgress_ChainedWalk(t *testing.T) {
	// [m0, m1(big), m2, m3, m4]: m1 is oversized (alone > budget). Walking
	// backward from m4: call 1 byte-bounds at m2 (m1 too big to add after
	// m2+m3); call 2 force-includes the oversized m1 as its first-strictly-older.
	list := []MessageWithParts{
		pageMsg("m0", 10),
		pageMsg("m1", 5000), // oversized message in the middle
		pageMsg("m2", 10),
		pageMsg("m3", 10),
		pageMsg("m4", 10),
	}
	maxBytes := 1000

	// Call 1: before=m4. First strictly-older m3 force-included; m2 included;
	// m1 too big (bytes_limited). oldest_id advances to m2.
	res1 := projectMessagePage(list, "m4", 5, maxBytes)
	if res1.OldestID != "m2" {
		t.Fatalf("call 1 (before=m4): oldest_id want m2, got %q", res1.OldestID)
	}
	if !res1.HasOlder {
		t.Fatalf("call 1: has_older want true (m0,m1 exist), got false")
	}
	if !isStrictlyOlder(list, "m2", "m4") {
		t.Fatalf("call 1: oldest_id m2 must be strictly older than cursor m4")
	}

	// Call 2: before=m2 (the new cursor from call 1). First strictly-older is
	// m1 (oversized, alone > budget). Force-included (sub-case c). oldest_id
	// advances to m1 — STRICTLY older than m2.
	res2 := projectMessagePage(list, "m2", 5, maxBytes)
	if res2.OldestID != "m1" {
		t.Fatalf("call 2 (before=m2): oldest_id want m1, got %q", res2.OldestID)
	}
	if !res2.OversizedItem {
		t.Fatalf("call 2: oversized_item want true (m1 alone > budget), got false")
	}
	if !res2.HasOlder {
		t.Fatalf("call 2: has_older want true (m0 exists beyond m1), got false")
	}
	if !isStrictlyOlder(list, "m1", "m2") {
		t.Fatalf("call 2: oldest_id m1 must be strictly older than cursor m2")
	}
}

// TestPage_ForwardProgress_OversizedAnchor_WithNeighbors is the DIRECT infinite-
// refetch regression (sub-case d, multiple older neighbors). When the oversized
// anchor has more than one older neighbor, the page MUST return the required
// pair [first-neighbor, anchor], OldestID MUST advance to the first neighbor
// (NOT stay at the cursor), AND OldestID MUST differ from before. Before the
// O1 fix this returned [anchor] alone with OldestID==before && HasOlder=true →
// zero progress → infinite refetch.
func TestPage_ForwardProgress_OversizedAnchor_WithNeighbors(t *testing.T) {
	// [m0, m1, oversized-anchor]: the anchor alone exceeds the budget; m0 and
	// m1 are both strictly older. The pair is [m1, anchor]; m0 exists beyond.
	list := []MessageWithParts{
		pageMsg("m0", 10),
		pageMsg("m1", 10),
		pageMsg("big", 5000), // oversized anchor
	}
	anchorSize := messageSerializedBytes(list[2])
	maxBytes := anchorSize - 1 // anchor alone exceeds budget
	res := projectMessagePage(list, "big", 5, maxBytes)
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true, got false")
	}
	// CRUX: the pair, not [anchor] alone.
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m1", "big"}) {
		t.Fatalf("items: want [m1 big] (required pair: first-neighbor + oversized anchor), got %v", got)
	}
	// CRUX: OldestID MUST be strictly older than the cursor (the direct
	// infinite-refetch assertion).
	if res.OldestID == res.RequestBefore {
		t.Fatalf("oldest_id == before (%q): STALL — cursor never advanced (infinite refetch)", res.OldestID)
	}
	if res.OldestID != "m1" {
		t.Fatalf("oldest_id: want m1 (advanced past cursor 'big'), got %q", res.OldestID)
	}
	if res.NewestID != "big" {
		t.Fatalf("newest_id: want big (overlap == RequestBefore), got %q", res.NewestID)
	}
	// m0 exists beyond the neighbor m1 → has_older true.
	if !res.HasOlder {
		t.Fatalf("has_older: want true (m0 exists beyond the neighbor m1), got false")
	}
	if !res.OversizedItem {
		t.Fatalf("oversized_item: want true (anchor alone > maxBytes), got false")
	}
	// The D-trigger gating flags: OversizedItem=true suppresses the boundary-
	// demand fetch; bytes_limited/count_limited stay false (no ordinary
	// accumulation ran for this branch).
	if res.BytesLimited || res.CountLimited {
		t.Fatalf("bytes/count limited: want both false (oversized-anchor pair branch), got bytes=%v count=%v", res.BytesLimited, res.CountLimited)
	}
	if res.ActualBytes != anchorSize {
		t.Fatalf("actual_bytes: want %d (the oversized anchor's size), got %d", anchorSize, res.ActualBytes)
	}
	if res.MessageCount != 2 {
		t.Fatalf("message_count: want 2 (the required pair), got %d", res.MessageCount)
	}
}

// TestPage_ForwardProgress_OversizedAnchor_MaxCount1 pins the maxCount=1 TWO-
// ITEM EXCEPTION: when the anchor is oversized with an older neighbor, the page
// returns 2 items (the required pair) even though the caller passed limit=1,
// because the overlap anchor + one strictly-older progress item are both part
// of the minimum required atomic set. This mirrors projectMessageWindow force-
// including its oversized newest regardless of maxCount.
func TestPage_ForwardProgress_OversizedAnchor_MaxCount1(t *testing.T) {
	list := []MessageWithParts{
		pageMsg("m1", 10),
		pageMsg("big", 5000), // oversized anchor
	}
	anchorSize := messageSerializedBytes(list[1])
	maxBytes := anchorSize - 1 // anchor alone exceeds budget
	// maxCount=1: the caller asked for at most 1 item, but the minimum
	// required atomic set is the pair [neighbor, anchor] (2 items).
	res := projectMessagePage(list, "big", 1, maxBytes)
	if !res.BoundaryFound {
		t.Fatalf("boundary_found: want true, got false")
	}
	if got := msgIDs(res.Items); !equalStrings(got, []string{"m1", "big"}) {
		t.Fatalf("items: want [m1 big] (maxCount=1 two-item exception), got %v", got)
	}
	if res.MessageCount != 2 {
		t.Fatalf("message_count: want 2 (the exception returns the required pair despite limit=1), got %d", res.MessageCount)
	}
	if res.OldestID != "m1" {
		t.Fatalf("oldest_id: want m1 (advanced past cursor 'big'), got %q", res.OldestID)
	}
	if !res.OversizedItem {
		t.Fatalf("oversized_item: want true, got false")
	}
	// m1 IS the oldest → has_older false.
	if res.HasOlder {
		t.Fatalf("has_older: want false (m1 is the session's oldest), got true")
	}
}

// TestPage_ForwardProgress_MaxCount1_NormalAnchor pins the ORDINARY maxCount=1
// two-item outcome (complement to TestPage_ForwardProgress_OversizedAnchor_
// MaxCount1): even with a NON-oversized anchor, maxCount=1 still returns 2 items
// because the first strictly-older message is always force-included (the
// forward-progress guarantee), and then the count bound stops the next-older.
//
// Sub-case A (anchorIdx>1): the count bound fires on the next-older →
// CountLimited=true, HasOlder=true, OldestID advances to the first-older.
// Sub-case B (anchorIdx==1): the first-older IS the session's oldest → the loop
// exits at the floor with no limit flag → CountLimited=false, HasOlder=false
// (truthful end-of-history).
func TestPage_ForwardProgress_MaxCount1_NormalAnchor(t *testing.T) {
	t.Run("anchorIdx_gt1_count_bound_fires", func(t *testing.T) {
		// [m0, m1, m2(anchor), m3]: anchor m2 fits; first-older m1 is force-
		// included; the count bound stops m0. Page = [m1, m2] (2 items).
		list := []MessageWithParts{
			pageMsg("m0", 10),
			pageMsg("m1", 10), // first strictly-older (force-included)
			pageMsg("m2", 10), // anchor
			pageMsg("m3", 10),
		}
		res := projectMessagePage(list, "m2", 1, 1<<20)
		if !res.BoundaryFound {
			t.Fatalf("boundary_found: want true, got false")
		}
		if got := msgIDs(res.Items); !equalStrings(got, []string{"m1", "m2"}) {
			t.Fatalf("items: want [m1 m2] (force-included first-older + anchor), got %v", got)
		}
		if res.MessageCount != 2 {
			t.Fatalf("message_count: want 2 (force-included first-older + anchor despite limit=1), got %d", res.MessageCount)
		}
		if res.OldestID != "m1" {
			t.Fatalf("oldest_id: want m1 (advanced past cursor m2), got %q", res.OldestID)
		}
		if !res.CountLimited {
			t.Fatalf("count_limited: want true (count bound fired on the next-older m0), got false")
		}
		if res.BytesLimited {
			t.Fatalf("bytes_limited: want false (generous budget), got true")
		}
		if res.OversizedItem {
			t.Fatalf("oversized_item: want false (non-oversized anchor), got true")
		}
		if !res.HasOlder {
			t.Fatalf("has_older: want true (m0 exists beyond the page), got false")
		}
	})

	t.Run("anchorIdx_eq1_loop_exits_at_floor", func(t *testing.T) {
		// [m0, m1(anchor)]: the first-older m0 IS the session's oldest. It is
		// force-included; the loop has nothing further to walk → exits at the
		// floor with no limit flag. Page = [m0, m1] (2 items).
		list := []MessageWithParts{
			pageMsg("m0", 10), // the ONLY strictly-older; force-included
			pageMsg("m1", 10), // anchor
		}
		res := projectMessagePage(list, "m1", 1, 1<<20)
		if !res.BoundaryFound {
			t.Fatalf("boundary_found: want true, got false")
		}
		if got := msgIDs(res.Items); !equalStrings(got, []string{"m0", "m1"}) {
			t.Fatalf("items: want [m0 m1] (force-included first-older + anchor), got %v", got)
		}
		if res.MessageCount != 2 {
			t.Fatalf("message_count: want 2 (force-included first-older + anchor), got %d", res.MessageCount)
		}
		if res.OldestID != "m0" {
			t.Fatalf("oldest_id: want m0 (advanced past cursor m1), got %q", res.OldestID)
		}
		if res.CountLimited {
			t.Fatalf("count_limited: want false (loop exited at the floor, no next-older to bound), got true")
		}
		if res.BytesLimited {
			t.Fatalf("bytes_limited: want false (generous budget), got true")
		}
		if res.OversizedItem {
			t.Fatalf("oversized_item: want false (non-oversized anchor), got true")
		}
		if res.HasOlder {
			t.Fatalf("has_older: want false (m0 is the session's oldest; truthful end-of-history), got true")
		}
	})
}

// TestPage_ForwardProgress_ChainedWalk_OversizedCursor proves repeated paging
// from a cursor AT an oversized message produces ≥1 newly-older message whenever
// has_older=true, advances the cursor each step, does NOT loop on the oversized
// anchor, and terminates with has_older=false. This is the end-to-end
// forward-progress guarantee for the residual stall class (sub-case d): before
// the O1 fix, a page whose `before` cursor was the oversized message returned
// [anchor] alone with OldestID==before && HasOlder=true → the walk could never
// advance past the oversized anchor.
func TestPage_ForwardProgress_ChainedWalk_OversizedCursor(t *testing.T) {
	// [m0, m1, m2, big-oversized-anchor, m4]: the oversized message is the
	// page cursor for call 1. The walk must step through the oversized anchor
	// (pair), then through the normal older neighbors, terminating at m0.
	list := []MessageWithParts{
		pageMsg("m0", 10),
		pageMsg("m1", 10),
		pageMsg("m2", 10),
		pageMsg("big", 5000), // oversized; IS the call-1 cursor
		pageMsg("m4", 10),
	}
	anchorSize := messageSerializedBytes(list[3])
	maxBytes := anchorSize - 1 // 'big' alone exceeds budget

	// Call 1: before=big (the oversized cursor). Sub-case d: required pair
	// [m2, big]; OldestID advances to m2; has_older=true (m0,m1 beyond).
	res1 := projectMessagePage(list, "big", 5, maxBytes)
	if res1.OldestID == res1.RequestBefore {
		t.Fatalf("call 1: oldest_id == before (%q): STALL (the oversized cursor never advanced)", res1.OldestID)
	}
	if res1.OldestID != "m2" {
		t.Fatalf("call 1 (before=big): oldest_id want m2, got %q", res1.OldestID)
	}
	if got := msgIDs(res1.Items); !equalStrings(got, []string{"m2", "big"}) {
		t.Fatalf("call 1: items want [m2 big] (required pair), got %v", got)
	}
	if !res1.HasOlder {
		t.Fatalf("call 1: has_older want true (m0,m1 exist beyond m2), got false")
	}
	if !res1.OversizedItem {
		t.Fatalf("call 1: oversized_item want true, got false")
	}
	if !isStrictlyOlder(list, "m2", "big") {
		t.Fatalf("call 1: oldest_id m2 must be strictly older than cursor big")
	}

	// Call 2: before=m2 (the new cursor). 'big' is no longer involved; the
	// walk continues through the normal older neighbors. maxBytes is now
	// generous relative to the small messages, so the page reaches m1 (and
	// possibly m0). OldestID advances strictly past m2.
	res2 := projectMessagePage(list, "m2", 5, maxBytes)
	if res2.OldestID == res2.RequestBefore {
		t.Fatalf("call 2: oldest_id == before (%q): STALL", res2.OldestID)
	}
	if !isStrictlyOlder(list, res2.OldestID, "m2") {
		t.Fatalf("call 2: oldest_id %q must be strictly older than cursor m2", res2.OldestID)
	}
	// With the generous budget relative to small messages, call 2 reaches the
	// oldest message m0 → has_older=false (truthful end-of-history).
	if res2.OldestID != "m0" {
		t.Fatalf("call 2 (before=m2): oldest_id want m0 (reached start), got %q", res2.OldestID)
	}
	if res2.HasOlder {
		t.Fatalf("call 2: has_older want false (reached m0, the session's oldest), got true")
	}

	// Termination invariant: the walk MUST have terminated with has_older=false
	// (call 2), proving it does NOT loop forever on the oversized anchor.
	if res1.HasOlder && !res2.HasOlder {
		// expected: call 1 had more history, call 2 exhausted it.
	} else {
		t.Fatalf("chained walk did not terminate: call1.has_older=%v call2.has_older=%v", res1.HasOlder, res2.HasOlder)
	}
}

// isStrictlyOlder returns true if `older` appears before `newer` in the
// creation-ordered list (oldest first). Used by the chained-walk test to verify
// strict oldest_id advancement.
func isStrictlyOlder(list []MessageWithParts, older, newer string) bool {
	olderIdx, newerIdx := -1, -1
	for i := range list {
		id := messageIDFromInfo(list[i].Info)
		if id == older {
			olderIdx = i
		}
		if id == newer {
			newerIdx = i
		}
	}
	if olderIdx < 0 || newerIdx < 0 {
		return false
	}
	return olderIdx < newerIdx
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
	s := mustNew(t, withWindowBounds(DefaultConfig(100), 2, 1<<20))
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

// TestSnapshotMessagesPage_FullResidentSupportsOlderHistory is the Part-A revert
// regression guard. After a FULL cold-load (the pre-Part-A / reverted behavior —
// EnsureMessages calls client.Messages, not MessagesTail), the resident store
// holds the WHOLE transcript, so paging older-than-the-newest-window
// (before = oldest id of the newest WindowMaxCount) returns a REAL older page
// reaching back to the transcript start — WITHOUT a reconnect/reload.
//
// This guards against re-introducing the MessagesTail(WindowMaxCount) bound (the
// reverted Part A) without a compatible Part-B history-recovery mechanism: under
// that bound the resident store would hold only the newest WindowMaxCount, so
// paging before their oldest would return just the overlap item (len(Items)==1,
// OldestID == the boundary) — silently losing older-history access until a
// reconnect. Here the full-resident path pages back to m1.
func TestSnapshotMessagesPage_FullResidentSupportsOlderHistory(t *testing.T) {
	total := WindowMaxCount + 50 // > WindowMaxCount (100) → newest window is a strict subset

	t.Run("full-resident-exhausted-pages-to-start-HasOlder-false", func(t *testing.T) {
		st := New(1024)
		st.Apply(ev("session.created", `{"info":{"id":"s","title":"S"}}`))
		// Seed a FULL transcript (oldest-first), the post-boundary-demand shape
		// (cold-load bounded to WindowMaxCount, then older history merged in via
		// the cursor; historyExhausted=true marks "we have the session's oldest").
		list := make([]MessageWithParts, total)
		for i := 0; i < total; i++ {
			list[i] = pageMsg(fmt.Sprintf("m%d", i+1), 10) // m1..m{total}
		}
		st.SetSessionMessages("s", list)
		st.MergeOlderMessages("s", nil, true) // mark historyExhausted=true (full transcript resident)

		oldestOfNewestWindow := fmt.Sprintf("m%d", total-WindowMaxCount+1) // m51
		page := st.SnapshotMessagesPage("s", oldestOfNewestWindow, WindowMaxCount, 1<<20)

		if !page.BoundaryFound {
			t.Fatalf("boundary_found: want true (full transcript resident), got false")
		}
		if len(page.Items) <= 1 {
			t.Fatalf("older page must return the boundary + strictly-older messages; got %d items", len(page.Items))
		}
		if page.OldestID != "m1" {
			t.Fatalf("oldest_id: want m1 (paged to transcript start), got %q", page.OldestID)
		}
		// historyExhausted=true (full transcript) → no older remains.
		if page.HasOlder {
			t.Fatalf("has_older: want false (historyExhausted=true, paged to m1 the start), got true")
		}
		if !page.HistoryExhausted {
			t.Fatalf("history_exhausted: want true (full transcript resident), got false")
		}
	})

	t.Run("bounded-resident-not-exhausted-HasOlder-true", func(t *testing.T) {
		// The Part-B cold-load shape: resident = newest WindowMaxCount only
		// (m51..m150), historyExhausted=false (older history exists but is not
		// yet resident — the boundary-demand path will fetch it).
		st := New(1024)
		st.Apply(ev("session.created", `{"info":{"id":"s","title":"S"}}`))
		bounded := make([]MessageWithParts, WindowMaxCount)
		for i := 0; i < WindowMaxCount; i++ {
			bounded[i] = pageMsg(fmt.Sprintf("m%d", total-WindowMaxCount+1+i), 10) // m51..m150
		}
		st.SetSessionMessages("s", bounded) // historyExhausted=false (default)

		page := st.SnapshotMessagesPage("s", "m51", WindowMaxCount, 1<<20)
		if !page.BoundaryFound {
			t.Fatalf("boundary_found: want true (m51 resident), got false")
		}
		// CRUX (d): HasOlder hinges on !historyExhausted when not count/byte
		// limited. The bounded resident has NOT exhausted history → HasOlder=true
		// (older history natively accessible via the boundary-demand path).
		if !page.HasOlder {
			t.Fatalf("has_older: want true (bounded resident, historyExhausted=false → older exists), got false")
		}
		if page.HistoryExhausted {
			t.Fatalf("history_exhausted: want false (bounded resident), got true")
		}
	})

	t.Run("boundary-demand-ID-prepend-merges-older-then-exhausts", func(t *testing.T) {
		// Start bounded (m51..m150, historyExhausted=false). Simulate the
		// boundary-demand: MergeOlderMessages prepends the strictly-older page
		// (m1..m50) by ID, then a final merge marks historyExhausted=true.
		st := New(1024)
		st.Apply(ev("session.created", `{"info":{"id":"s","title":"S"}}`))
		bounded := make([]MessageWithParts, WindowMaxCount)
		for i := 0; i < WindowMaxCount; i++ {
			bounded[i] = pageMsg(fmt.Sprintf("m%d", total-WindowMaxCount+1+i), 10)
		}
		st.SetSessionMessages("s", bounded)

		// Older page m1..m50 (oldest-first, as the cursor returns), not exhausted.
		older := make([]MessageWithParts, total-WindowMaxCount)
		for i := 0; i < total-WindowMaxCount; i++ {
			older[i] = pageMsg(fmt.Sprintf("m%d", i+1), 10) // m1..m50
		}
		st.MergeOlderMessages("s", older, false) // ID-prepend; historyExhausted still false

		// After the prepend, paging from m51 reaches m1 (the merged older page).
		page := st.SnapshotMessagesPage("s", "m51", WindowMaxCount, 1<<20)
		if page.OldestID != "m1" {
			t.Fatalf("after ID-prepend merge: oldest_id want m1, got %q (prepend did not merge the older page)", page.OldestID)
		}
		if len(page.Items) <= 1 {
			t.Fatalf("after ID-prepend merge: page must include older items, got %d", len(page.Items))
		}
		// Still not exhausted → HasOlder=true (the cursor's X-Next-Cursor was set).
		if !page.HasOlder {
			t.Fatalf("after merge (historyExhausted=false): has_older want true, got false")
		}

		// Final merge: the cursor's X-Next-Cursor is now empty → historyExhausted=true.
		st.MergeOlderMessages("s", nil, true)
		page2 := st.SnapshotMessagesPage("s", "m51", WindowMaxCount, 1<<20)
		if page2.OldestID != "m1" {
			t.Fatalf("after exhaust: oldest_id want m1, got %q", page2.OldestID)
		}
		// historyExhausted=true → HasOlder=false (truthful end-of-history).
		if page2.HasOlder {
			t.Fatalf("after historyExhausted=true: has_older want false (end-of-history), got true")
		}
		if !page2.HistoryExhausted {
			t.Fatalf("history_exhausted: want true after the empty-X-Next-Cursor merge, got false")
		}
	})
}

// TestSnapshotMessagesPage_CursorSetExhaustion pins that the cold-load cursor
// evidence entry (SetSessionMessagesExhausted — the tail GET's X-Next-Cursor
// verdict) drives the page endpoint's HasOlder correction exactly like the
// MergeOlderMessages-set flag does: a NOT-exhausted bounded resident (cursor
// present) pages with has_older=true; an exhausted one (cursor absent — even at
// an exact window fit, the old len<limit heuristic's blind edge) reports
// has_older=false with no wasted affordance.
//
// The oversized-floor subtests pin the OF1 remedy's envelope half: an OVERSIZED
// page at the resident floor must not report has_older=false while
// historyExhausted=false (the resident floor is then NOT the session floor —
// older opencode history may exist beyond it), and the envelope's OR must never
// DOWNGRADE a projector-set has_older=true (the anchorIdx>1 oversized pair has
// resident-local older history; that verdict survives even exhaustion).
func TestSnapshotMessagesPage_CursorSetExhaustion(t *testing.T) {
	t.Run("cursor-present-not-exhausted", func(t *testing.T) {
		st := New(1024)
		st.Apply(ev("session.created", `{"info":{"id":"s","title":"S"}}`))
		bounded := make([]MessageWithParts, WindowMaxCount)
		for i := 0; i < WindowMaxCount; i++ {
			bounded[i] = pageMsg(fmt.Sprintf("m%d", i+1), 10) // m1..m100, light
		}
		st.SetSessionMessagesExhausted("s", bounded, false) // X-Next-Cursor present

		page := st.SnapshotMessagesPage("s", "m1", WindowMaxCount, 1<<20)
		if !page.BoundaryFound {
			t.Fatalf("boundary_found: want true (m1 resident), got false")
		}
		if !page.HasOlder {
			t.Fatalf("has_older: want true (cursor said older history exists beyond the tail), got false")
		}
		if page.HistoryExhausted {
			t.Fatalf("history_exhausted: want false, got true")
		}
	})

	t.Run("cursor-absent-exhausted-exact-fit", func(t *testing.T) {
		st := New(1024)
		st.Apply(ev("session.created", `{"info":{"id":"s","title":"S"}}`))
		full := make([]MessageWithParts, WindowMaxCount)
		for i := 0; i < WindowMaxCount; i++ {
			full[i] = pageMsg(fmt.Sprintf("m%d", i+1), 10) // exactly WindowMaxCount
		}
		st.SetSessionMessagesExhausted("s", full, true) // NO X-Next-Cursor: tail IS everything

		// Page from the oldest resident: anchor == session oldest → floor.
		page := st.SnapshotMessagesPage("s", "m1", WindowMaxCount, 1<<20)
		if !page.BoundaryFound {
			t.Fatalf("boundary_found: want true, got false")
		}
		if page.HasOlder {
			t.Fatalf("has_older: want false (cursor-absent exhaustion — no inverse lie at the exact-fit edge), got true")
		}
		if !page.HistoryExhausted {
			t.Fatalf("history_exhausted: want true, got false")
		}
	})

	// OF1: an OVERSIZED message sitting AT the resident floor. The projector's
	// sub-case A returns [anchor] alone with HasOlder=false (resident-local
	// verdict: no resident message is older). The envelope must OR
	// !historyExhausted in — the resident list may be a fetch-bounded tail, so
	// the oversized resident floor is NOT necessarily the session floor.
	t.Run("oversized-floor-not-exhausted", func(t *testing.T) {
		st := New(1024)
		st.Apply(ev("session.created", `{"info":{"id":"s","title":"S"}}`))
		// Creation order (oldest first): the oversized big IS the resident
		// floor; m2/m3 are newer light messages.
		list := []MessageWithParts{pageMsg("big", 700), pageMsg("m2", 10), pageMsg("m3", 10)}
		st.SetSessionMessagesExhausted("s", list, false) // bounded tail, older history unknown

		page := st.SnapshotMessagesPage("s", "big", WindowMaxCount, 512)
		if !page.BoundaryFound {
			t.Fatalf("boundary_found: want true (big resident), got false")
		}
		if !page.OversizedItem {
			t.Fatalf("oversized_item: want true (big alone exceeds the 512B budget), got false")
		}
		if page.CountLimited || page.BytesLimited {
			t.Fatalf("limits: want none (oversized sub-case A sets neither), got count=%v bytes=%v",
				page.CountLimited, page.BytesLimited)
		}
		if len(page.Items) != 1 || page.OldestID != "big" {
			t.Fatalf("items: want the lone oversized anchor [big] (sub-case A), got %d items oldest=%q",
				len(page.Items), page.OldestID)
		}
		// THE OF1 fix: has_older must stay true — the affordance must not die
		// at the oversized floor while historyExhausted=false.
		if !page.HasOlder {
			t.Fatalf("has_older: want true (oversized resident floor, historyExhausted=false — resident floor ≠ session floor), got false")
		}
		if page.HistoryExhausted {
			t.Fatalf("history_exhausted: want false, got true")
		}
	})

	t.Run("oversized-floor-exhausted", func(t *testing.T) {
		st := New(1024)
		st.Apply(ev("session.created", `{"info":{"id":"s","title":"S"}}`))
		list := []MessageWithParts{pageMsg("big", 700), pageMsg("m2", 10), pageMsg("m3", 10)}
		st.SetSessionMessagesExhausted("s", list, true) // backward walk reached the session's oldest

		page := st.SnapshotMessagesPage("s", "big", WindowMaxCount, 512)
		if !page.BoundaryFound || !page.OversizedItem {
			t.Fatalf("boundary_found/oversized_item: want true/true, got %v/%v",
				page.BoundaryFound, page.OversizedItem)
		}
		// Truthful end-of-history ONLY when historyExhausted=true: the same
		// oversized floor that reports has_older=true when not exhausted.
		if page.HasOlder {
			t.Fatalf("has_older: want false (oversized floor IS the session floor once historyExhausted=true), got true")
		}
		if !page.HistoryExhausted {
			t.Fatalf("history_exhausted: want true, got false")
		}
	})

	// The envelope ORs; it must never DOWNGRADE. An anchorIdx>1 oversized
	// anchor projects the atomic pair [neighbor, anchor] with HasOlder=true
	// (resident-local older history exists beyond the neighbor) — exhaustion
	// must not clear a projector-set true.
	t.Run("oversized-pair-anchorIdx2-exhausted-keeps-projector-true", func(t *testing.T) {
		st := New(1024)
		st.Apply(ev("session.created", `{"info":{"id":"s","title":"S"}}`))
		// Creation order: m1, m2, big(anchor, oversized), m4 (newest).
		list := []MessageWithParts{pageMsg("m1", 10), pageMsg("m2", 10), pageMsg("big", 700), pageMsg("m4", 10)}
		st.SetSessionMessagesExhausted("s", list, true)

		page := st.SnapshotMessagesPage("s", "big", WindowMaxCount, 512)
		if !page.BoundaryFound || !page.OversizedItem {
			t.Fatalf("boundary_found/oversized_item: want true/true, got %v/%v",
				page.BoundaryFound, page.OversizedItem)
		}
		if len(page.Items) != 2 || page.OldestID != "m2" {
			t.Fatalf("items: want the atomic pair [m2, big] (sub-case d), got %d items oldest=%q",
				len(page.Items), page.OldestID)
		}
		// Projector set HasOlder=true (anchorIdx=2 > 1: m1 remains beyond the
		// neighbor). historyExhausted=true must NOT clear it — the walk still
		// has resident-local older history to page through.
		if !page.HasOlder {
			t.Fatalf("has_older: want true (projector-set resident-local older survives the envelope OR; exhaustion must not downgrade), got false")
		}
		if !page.HistoryExhausted {
			t.Fatalf("history_exhausted: want true, got false")
		}
	})

	// Companion pin from the other side: the SAME sub-case d shape at
	// anchorIdx==1 projects HasOlder=false (the neighbor IS the floor), so an
	// exhausted pair reports has_older=false — the OR is false||false.
	t.Run("oversized-pair-anchorIdx1-exhausted", func(t *testing.T) {
		st := New(1024)
		st.Apply(ev("session.created", `{"info":{"id":"s","title":"S"}}`))
		list := []MessageWithParts{pageMsg("m1", 10), pageMsg("big", 700), pageMsg("m3", 10)}
		st.SetSessionMessagesExhausted("s", list, true)

		page := st.SnapshotMessagesPage("s", "big", WindowMaxCount, 512)
		if len(page.Items) != 2 || page.OldestID != "m1" {
			t.Fatalf("items: want the atomic pair [m1, big] (sub-case d), got %d items oldest=%q",
				len(page.Items), page.OldestID)
		}
		if page.HasOlder {
			t.Fatalf("has_older: want false (neighbor m1 IS the floor and historyExhausted=true — truthful end-of-history), got true")
		}
	})
}

// TestMergeOlderMessagesExhaustionFlipBumpsMsgRev pins the msgRev contract of
// the exhaustion flip — the empty AND the all-duplicates floor-reaching merge,
// the two revision-validation gaps the has_older truthfulness chain left open
// (1dfcd9e9 left the flip unbumped; f57c32f9 bumped only the len(items)==0
// variant, leaving the non-empty all-dupes sibling). Flipping
// historyExhausted false→true changes the cold-batch/snapshot projection input
// (the SAME resident list now projects has_older=false), so msgRev[sid] MUST
// advance exactly once — with or without a prepend surviving dedup; without
// the bump, an in-flight publishColdBatch that captured the stale (list,
// exhausted=false) pair under the same lock passes the ABA equality check and
// emits a stale has_older=true window. The flip's observable outcome
// (WindowMeta.HasOlder turning false) is asserted alongside the revision
// mechanics, and the neighboring no-bump cases (repeat floor call — empty AND
// all-dupes, non-floor empty merge) plus the preserved non-empty prepend bump
// are pinned so "exactly when" stays exact.
func TestMergeOlderMessagesExhaustionFlipBumpsMsgRev(t *testing.T) {
	// seedNotExhausted builds a session whose resident list is a
	// fetch-truncated tail: 3 light messages, historyExhausted=false
	// (SetSessionMessagesExhausted is the authoritative-evidence entrypoint),
	// so the window projects has_older=true with NEITHER dual bound firing.
	seedNotExhausted := func(t *testing.T) *Store {
		t.Helper()
		st := New(1024)
		st.Apply(ev("session.created", `{"info":{"id":"s","title":"S"}}`))
		st.SetSessionMessagesExhausted("s", []MessageWithParts{
			pageMsg("m1", 10), pageMsg("m2", 10), pageMsg("m3", 10),
		}, false)
		return st
	}

	t.Run("empty-floor-flip-bumps-exactly-once-and-flips-HasOlder", func(t *testing.T) {
		st := seedNotExhausted(t)
		// Precondition: the fetch-truncated light tail projects has_older=true.
		pre := st.Snapshot(map[string]bool{"s": true}).MessageWindows["s"]
		if !pre.HasOlder {
			t.Fatalf("precondition: fetch-truncated not-exhausted resident must project has_older=true, got %+v", pre)
		}
		before := st.msgRevSnapshot("s")
		if before == 0 {
			t.Fatalf("precondition: reconcile must have bumped msgRev (non-zero baseline), got 0")
		}
		st.MergeOlderMessages("s", nil, true) // empty floor-reaching page: the flip
		after := st.msgRevSnapshot("s")
		if after != before+1 {
			t.Fatalf("empty floor flip: msgRev want exactly before+1 (one bump), got %d → %d", before, after)
		}
		// Outcome: the flag flip is observable — the same resident list now
		// projects has_older=false (truthful end-of-history, no inverse lie).
		post := st.Snapshot(map[string]bool{"s": true}).MessageWindows["s"]
		if post.HasOlder {
			t.Fatalf("after empty floor flip: has_older want false, got true")
		}
	})

	t.Run("repeat-empty-floor-no-rebump", func(t *testing.T) {
		st := seedNotExhausted(t)
		st.MergeOlderMessages("s", nil, true) // the flip (bumps once)
		rev := st.msgRevSnapshot("s")
		st.MergeOlderMessages("s", nil, true) // repeat: flag already true
		if got := st.msgRevSnapshot("s"); got != rev {
			t.Fatalf("repeated empty floor merge must NOT bump msgRev (snapshot retry churn): %d → %d", rev, got)
		}
	})

	t.Run("empty-non-floor-merge-no-bump", func(t *testing.T) {
		st := seedNotExhausted(t)
		rev := st.msgRevSnapshot("s")
		st.MergeOlderMessages("s", nil, false) // empty page, NOT floor-reaching: nothing changed
		if got := st.msgRevSnapshot("s"); got != rev {
			t.Fatalf("empty non-floor merge must NOT bump msgRev: %d → %d", rev, got)
		}
	})

	t.Run("nonempty-prepend-bump-preserved", func(t *testing.T) {
		st := seedNotExhausted(t)
		rev := st.msgRevSnapshot("s")
		st.MergeOlderMessages("s", []MessageWithParts{pageMsg("m0", 10)}, false)
		if got := st.msgRevSnapshot("s"); got != rev+1 {
			t.Fatalf("non-empty prepend: msgRev want exactly rev+1 (existing bump preserved), got %d → %d", rev, got)
		}
		// The prepend is observable: paging before=m1 now reaches m0.
		page := st.SnapshotMessagesPage("s", "m1", 10, 1<<20)
		if page.OldestID != "m0" {
			t.Fatalf("after prepend: page oldest_id want m0, got %q", page.OldestID)
		}
	})

	t.Run("nonempty-floor-page-single-bump", func(t *testing.T) {
		// A floor-reaching page that DOES carry a genuinely-new older id flips
		// the flag AND prepends: exactly ONE bump total (the prepend-path bump
		// covers both — no double bump for one logical change).
		st := seedNotExhausted(t)
		rev := st.msgRevSnapshot("s")
		st.MergeOlderMessages("s", []MessageWithParts{pageMsg("m0", 10)}, true)
		if got := st.msgRevSnapshot("s"); got != rev+1 {
			t.Fatalf("non-empty floor merge: msgRev want exactly rev+1 (single bump for prepend+flip), got %d → %d", rev, got)
		}
		post := st.Snapshot(map[string]bool{"s": true}).MessageWindows["s"]
		if post.HasOlder {
			t.Fatalf("after floor merge: has_older want false, got true")
		}
	})

	t.Run("all-dupes-floor-flip-bumps-exactly-once-and-flips-HasOlder", func(t *testing.T) {
		// The f57c32f9 bump keyed on len(items)==0; this sibling is the
		// NON-empty floor page whose every item is already resident (e.g. the
		// overlap anchor re-served alone, or ids that arrived live before the
		// page landed): the byID dedup empties `prepend`, but the flag still
		// flipped — the same resident list now projects has_older=false — so
		// msgRev must advance exactly once anyway.
		st := seedNotExhausted(t)
		before := st.msgRevSnapshot("s")
		if before == 0 {
			t.Fatalf("precondition: reconcile must have bumped msgRev (non-zero baseline), got 0")
		}
		st.MergeOlderMessages("s", []MessageWithParts{
			pageMsg("m1", 10), pageMsg("m2", 10), pageMsg("m3", 10),
		}, true) // all-resident floor page: flips the flag, prepends nothing
		if after := st.msgRevSnapshot("s"); after != before+1 {
			t.Fatalf("all-dupes floor flip: msgRev want exactly before+1 (one bump), got %d → %d", before, after)
		}
		post := st.Snapshot(map[string]bool{"s": true}).MessageWindows["s"]
		if post.HasOlder {
			t.Fatalf("after all-dupes floor flip: has_older want false (truthful end-of-history), got true")
		}
		if post.MessageCount != 3 {
			t.Fatalf("after all-dupes floor flip: window message_count want 3 (dedup prepended nothing), got %d", post.MessageCount)
		}
	})

	t.Run("repeat-all-dupes-floor-no-rebump", func(t *testing.T) {
		st := seedNotExhausted(t)
		allDupes := []MessageWithParts{
			pageMsg("m1", 10), pageMsg("m2", 10), pageMsg("m3", 10),
		}
		st.MergeOlderMessages("s", allDupes, true) // the flip (bumps once)
		rev := st.msgRevSnapshot("s")
		st.MergeOlderMessages("s", allDupes, true) // repeat: flag already true, all items still resident
		if got := st.msgRevSnapshot("s"); got != rev {
			t.Fatalf("repeated all-dupes floor merge must NOT bump msgRev (snapshot retry churn): %d → %d", rev, got)
		}
	})

	t.Run("mixed-dupe-new-floor-single-bump", func(t *testing.T) {
		// The PRODUCTION floor-page shape: the overlap anchor (a dupe by
		// design) alongside a genuinely-new older id, floor-reaching.
		// Prepends AND flips — still exactly ONE bump (one logical merge).
		st := seedNotExhausted(t)
		rev := st.msgRevSnapshot("s")
		st.MergeOlderMessages("s", []MessageWithParts{
			pageMsg("m1", 10), // dupe overlap anchor
			pageMsg("m0", 10), // genuinely-new older id
		}, true)
		if got := st.msgRevSnapshot("s"); got != rev+1 {
			t.Fatalf("mixed dupe+new floor merge: msgRev want exactly rev+1 (single bump for prepend+flip), got %d → %d", rev, got)
		}
		post := st.Snapshot(map[string]bool{"s": true}).MessageWindows["s"]
		if post.HasOlder {
			t.Fatalf("after mixed floor merge: has_older want false, got true")
		}
		if post.MessageCount != 4 {
			t.Fatalf("after mixed floor merge: window message_count want 4 (m0 prepended), got %d", post.MessageCount)
		}
	})
}
