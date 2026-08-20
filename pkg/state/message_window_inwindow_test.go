package state

// MessageInWindow predicate tests: the Stream-2 egress window filter
// (pkg/web sendable) needs a server-side "is this message inside the client's
// snapshot window" verdict. The predicate must replicate projectMessageWindow's
// newest-tail dual-bound semantics EXACTLY — a divergent constant or a
// different bound evaluation would drop events a cold client CAN render (or
// pass events it cannot). These tests pin:
//
//  1. The pure walk (messageInWindowOrder) against the projector itself: for
//     every id in a seeded session, membership == id ∈ projectMessageWindow
//     output (the anti-divergence property, checked through the store's REAL
//     representation — not a parallel test fixture).
//  2. The edge cases: oversized newest (window = {newest} alone), byte bound,
//     missing session/message → false (out-of-window), empty session → false.
//  3. The exported accessor (MessageInWindow) plumbing.

import (
	"encoding/json"
	"strings"
	"testing"
)

// inwinEntry builds a minimal messageEntry (id + info + one part) for direct
// pure-helper tests. Sizes are controlled via JSON string padding (infoPad 'i'
// bytes, partPad 'x' bytes); the exact totals do not matter — what matters is
// that the SAME bytes feed both messageInWindowOrder (via the entry) and
// projectMessageWindow (via the list), so parity assertions are exact.
func inwinEntry(id string, infoPad, partPad int) *messageEntry {
	info := json.RawMessage(`{"id":"` + id + `","role":"user","pad":"` + strings.Repeat("i", infoPad) + `"}`)
	part := json.RawMessage(`{"id":"` + id + `-p0","type":"text","text":"` + strings.Repeat("x", partPad) + `"}`)
	me := &messageEntry{
		id:        id,
		info:      info,
		partOrder: []string{id + "-p0"},
		parts:     map[string]json.RawMessage{id + "-p0": part},
	}
	return me
}

// TestMessageInWindow_PureMatchesProjector is the anti-divergence property:
// for a hand-built ordered session, messageInWindowOrder(id) must be true
// exactly for the ids projectMessageWindow keeps. Covers the count-bound
// ordinary case.
func TestMessageInWindow_PureMatchesProjector(t *testing.T) {
	const n = 8
	order := make([]string, 0, n)
	byID := make(map[string]*messageEntry, n)
	var list []MessageWithParts
	for i := 1; i <= n; i++ {
		id := "m" + itoa(i)
		me := inwinEntry(id, 60, 40)
		order = append(order, id)
		byID[id] = me
		list = append(list, MessageWithParts{Info: me.info, Parts: []json.RawMessage{me.parts[id+"-p0"]}})
	}
	const maxCount = 3
	const maxBytes = 1 << 20

	bounded, _ := projectMessageWindow(list, maxCount, maxBytes)
	want := map[string]bool{}
	for _, m := range bounded {
		want[messageIDFromInfo(m.Info)] = true
	}
	if len(want) != maxCount {
		t.Fatalf("projector sanity: want %d window ids, got %v", maxCount, want)
	}

	for _, id := range order {
		got := messageInWindowOrder(order, byID, id, maxCount, maxBytes)
		if got != want[id] {
			t.Fatalf("divergence at %s: helper=%v projector=%v (window=%v)", id, got, want[id], want)
		}
	}
	// Unknown ids and empty targets are out-of-window.
	if messageInWindowOrder(order, byID, "nope", maxCount, maxBytes) {
		t.Fatal("unknown message id must be out-of-window")
	}
	if messageInWindowOrder(nil, nil, "m1", maxCount, maxBytes) {
		t.Fatal("empty session must be out-of-window")
	}
	if messageInWindowOrder(order, byID, "", maxCount, maxBytes) {
		t.Fatal("empty message id must be out-of-window")
	}
}

// TestMessageInWindow_PureByteBoundAndOversized pins the byte-bound and
// oversized-newest semantics: the oversized newest collapses the window to
// {newest} ALONE (even the second-newest is out), and an ordinary byte bound
// stops the walk mid-history with the newest still in.
func TestMessageInWindow_PureByteBoundAndOversized(t *testing.T) {
	n := 5
	build := func(newestPartBytes int) ([]string, map[string]*messageEntry) {
		order := make([]string, 0, n)
		byID := map[string]*messageEntry{}
		for i := 1; i <= n; i++ {
			id := "m" + itoa(i)
			partBytes := 40
			if i == n {
				partBytes = newestPartBytes
			}
			byID[id] = inwinEntry(id, 60, partBytes)
			order = append(order, id)
		}
		return order, byID
	}

	// Oversized newest (alone > maxBytes): window = {newest} — m4 is OUT even
	// though the count bound (100) would include it.
	order, byID := build(5000)
	for _, id := range order {
		want := id == "m"+itoa(n)
		if got := messageInWindowOrder(order, byID, id, 100, 1000); got != want {
			t.Fatalf("oversized newest: %s got %v want %v", id, got, want)
		}
	}

	// Ordinary byte bound: budget 400, entries ~140 bytes (infoPad 60 +
	// partPad 40 + JSON framing) → newest few in, older out. Cross-check
	// against the projector for exactness.
	order, byID = build(40)
	list := make([]MessageWithParts, 0, n)
	for _, id := range order {
		me := byID[id]
		list = append(list, MessageWithParts{Info: me.info, Parts: []json.RawMessage{me.parts[id+"-p0"]}})
	}
	bounded, _ := projectMessageWindow(list, 100, 400)
	want := map[string]bool{}
	for _, m := range bounded {
		want[messageIDFromInfo(m.Info)] = true
	}
	if len(want) < 2 || len(want) == n {
		t.Fatalf("projector sanity: byte bound should keep a strict non-empty subset, got %v", want)
	}
	for _, id := range order {
		if got := messageInWindowOrder(order, byID, id, 100, 400); got != want[id] {
			t.Fatalf("byte-bound divergence at %s: helper=%v projector=%v", id, got, want[id])
		}
	}
}

// TestMessageInWindow_StoreAccessorAndSnapshotParity drives the EXPORTED
// accessor through a real store seeded via Apply, and cross-checks the verdict
// against the store's own Snapshot projection (the cold-client initial window
// source): MessageInWindow(sid, id) must be true exactly for ids in
// Snapshot(nil).Messages[sid]. This is the property the Stream-2 egress filter
// depends on: "out-of-window server-side" == "absent from the cold snapshot".
func TestMessageInWindow_StoreAccessorAndSnapshotParity(t *testing.T) {
	s := mustNew(t, withWindowBounds(DefaultConfig(100), 3, 1<<20))

	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))
	for i := 1; i <= 6; i++ {
		s.Apply(ev("message.updated", `{"info":{"id":"m`+itoa(i)+`","sessionID":"sess","role":"user"}}`))
	}

	snap := s.Snapshot(nil)
	win := snap.Messages["sess"]
	if len(win) != 3 {
		t.Fatalf("snapshot sanity: want 3-message window, got %d", len(win))
	}
	want := map[string]bool{}
	for _, m := range win {
		want[messageIDFromInfo(m.Info)] = true
	}

	for i := 1; i <= 6; i++ {
		id := "m" + itoa(i)
		got := s.MessageInWindow("sess", id)
		if got != want[id] {
			t.Fatalf("snapshot parity divergence at %s: MessageInWindow=%v snapshot-has=%v", id, got, want[id])
		}
	}

	// Missing session / missing message → false (out-of-window).
	if s.MessageInWindow("ghost", "m1") {
		t.Fatal("missing session must be out-of-window")
	}
	if s.MessageInWindow("sess", "ghost") {
		t.Fatal("missing message must be out-of-window")
	}
}

// TestMessageInWindow_KeylessPlaceholderNewest pins the 0d39634 live-streaming
// shape through the membership walk: a part delta for a brand-new message
// creates a keyless placeholder (entry exists, info empty, sorts LAST via
// orderKey=+inf), which is therefore order[n-1]. The walk MUST return true for
// it — the order[n-1]==mid fast path precedes every other check, so
// live-stream parts are never dropped. A future reshuffle of the check order
// (nil/size checks first) would silently drop ALL live-stream parts; this test
// catches that. Parity with the projector asserted alongside (the projector
// also always keeps the newest, keyless included — its entry simply carries
// nil Info, so it is detected positionally).
func TestMessageInWindow_KeylessPlaceholderNewest(t *testing.T) {
	keyless := inwinEntry("mk", 10, 10)
	keyless.info = nil // placeholder: part arrived before the message envelope
	order := []string{"m1", "m2", "mk"}
	byID := map[string]*messageEntry{
		"m1": inwinEntry("m1", 10, 10),
		"m2": inwinEntry("m2", 10, 10),
		"mk": keyless,
	}
	const maxCount, maxBytes = 3, 1 << 20

	if !messageInWindowOrder(order, byID, "mk", maxCount, maxBytes) {
		t.Fatal("keyless placeholder newest: membership must be true (order[n-1]==mid fast path) — live-stream parts would be dropped")
	}

	list := []MessageWithParts{}
	for _, id := range order {
		me := byID[id]
		list = append(list, MessageWithParts{Info: me.info, Parts: []json.RawMessage{me.parts[id+"-p0"]}})
	}
	bounded, _ := projectMessageWindow(list, maxCount, maxBytes)
	if len(bounded) != 3 {
		t.Fatalf("projector sanity: want all 3 (newest always in, keyless included), got %d", len(bounded))
	}
	want := map[string]bool{}
	for _, m := range bounded {
		if id := messageIDFromInfo(m.Info); id != "" {
			want[id] = true
		}
	}
	for _, id := range []string{"m1", "m2"} {
		if got := messageInWindowOrder(order, byID, id, maxCount, maxBytes); got != want[id] {
			t.Fatalf("keyless newest: id %s helper=%v projector=%v (divergence)", id, got, want[id])
		}
	}
}
