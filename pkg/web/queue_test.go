package web

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// newTestStore builds a sessionQueueStore rooted at a temp dir so tests get a
// clean filesystem each run.
func newTestStore(t *testing.T, sessionID string) (*sessionQueueStore, string) {
	t.Helper()
	root := t.TempDir()
	return &sessionQueueStore{path: queuePath(root, sessionID)}, root
}

func mustEnqueue(t *testing.T, s *sessionQueueStore, text string) QueueItem {
	t.Helper()
	it, err := s.Enqueue(text, nil, QueueSendConfig{}, "")
	if err != nil {
		t.Fatalf("Enqueue(%q): %v", text, err)
	}
	return it
}

func TestQueueEnqueuePersistsAndReloads(t *testing.T) {
	s, root := newTestStore(t, "s1")
	mustEnqueue(t, s, "first")
	mustEnqueue(t, s, "second")

	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Text != "first" || got[1].Text != "second" {
		t.Fatalf("List = %+v, want [first,second]", got)
	}
	for _, it := range got {
		if it.State != QueuePending {
			t.Fatalf("state = %s, want pending", it.State)
		}
		if it.ID == "" {
			t.Fatal("backend-issued id is empty")
		}
	}

	// Reload from disk: a fresh store pointing at the same file sees both.
	s2 := &sessionQueueStore{path: queuePath(root, "s1")}
	got2, err := s2.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got2) != 2 || got2[0].ID != got[0].ID || got2[1].ID != got[1].ID {
		t.Fatalf("reload lost items or order: %+v", got2)
	}
}

// TestQueueAttachmentsAlwaysArrayOnWire pins the wire contract: an item enqueued
// with nil/empty attachments MUST serialize as "attachments":[] — never absent
// (omitempty) and never null (nil slice). The sole FE consumer (buildParts)
// iterates this field; undefined/null would throw without the ?? [] guard.
func TestQueueAttachmentsAlwaysArrayOnWire(t *testing.T) {
	s, _ := newTestStore(t, "s1")

	// nil is the common case: mustEnqueue passes nil, and an HTTP body with no
	// attachments field decodes to nil (queue_http.go:94, no omitempty on decode).
	it, err := s.Enqueue("no-atts", nil, QueueSendConfig{}, "")
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	raw, err := json.Marshal(it)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !bytes.Contains(raw, []byte(`"attachments":[]`)) {
		t.Fatalf("wire: attachments not an empty array: %s", raw)
	}

	var back QueueItem
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if back.Attachments == nil {
		t.Fatal("unmarshaled Attachments = nil, want non-nil empty slice")
	}
	if len(back.Attachments) != 0 {
		t.Fatalf("unmarshaled Attachments len = %d, want 0", len(back.Attachments))
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	listRaw, _ := json.Marshal(list)
	if !bytes.Contains(listRaw, []byte(`"attachments":[]`)) {
		t.Fatalf("list wire: attachments not an empty array: %s", listRaw)
	}
}

// TestQueueLegacyReloadAttachmentsAlwaysArray pins the reload-path half of the
// "attachments always an array on the wire" contract. A queue.json persisted
// BEFORE this slice had no `attachments` key on items (the field used omitempty),
// so json.Unmarshal leaves QueueItem.Attachments nil. With omitempty now
// removed, a nil would serialize as "attachments":null — breaking the contract
// the Enqueue nil→[] normalization establishes for new items. The load()
// post-load normalization must convert nil→[] for EVERY item read from disk so
// a legacy file reloaded via List() still serializes as "attachments":[].
func TestQueueLegacyReloadAttachmentsAlwaysArray(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, ".vh-solara", "sessions", "s1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Legacy on-disk item: NO `attachments` key (the pre-slice shape). Match the
	// queueFile envelope load() reads: {"order":N,"items":[...]}.
	legacy := []byte(`{"order":1,"items":[` +
		`{"id":"q-legacy","order":1,"state":"pending","text":"legacy-no-atts","createdAt":1700000000000}` +
		`]}`)
	if err := os.WriteFile(queuePath(root, "s1"), legacy, 0o644); err != nil {
		t.Fatal(err)
	}

	// Fresh store re-reads the seeded file via load() (no in-memory cache).
	s := &sessionQueueStore{path: queuePath(root, "s1")}
	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("List: got %d items, want 1", len(list))
	}
	if list[0].Attachments == nil {
		t.Fatal("legacy item Attachments = nil after load, want non-nil empty slice (load normalization missing)")
	}

	// The wire shape MUST be "attachments":[] — present and an empty array, not
	// absent (omitempty) and not null (nil slice).
	raw, err := json.Marshal(list)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !bytes.Contains(raw, []byte(`"attachments":[]`)) {
		t.Fatalf("legacy reload wire: attachments not an empty array: %s", raw)
	}
}

func TestQueueFIFOOrdering(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	for i := 0; i < 5; i++ {
		mustEnqueue(t, s, "m"+strconv.Itoa(i))
	}
	// Claim must return the oldest pending first, in FIFO order.
	for i := 0; i < 5; i++ {
		it, won, err := s.Claim()
		if err != nil || !won {
			t.Fatalf("claim %d: won=%v err=%v", i, won, err)
		}
		want := "m" + strconv.Itoa(i)
		if it.Text != want {
			t.Fatalf("claim %d = %q, want %q (FIFO)", i, it.Text, want)
		}
	}
	// No more pending.
	_, won, err := s.Claim()
	if err != nil || won {
		t.Fatalf("claim after drain: won=%v err=%v", won, err)
	}
}

func TestQueueClaimSingleWinner(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	mustEnqueue(t, s, "only")

	// Two simultaneous claims: exactly one must win, the other gets nothing.
	var winners int64
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, won, err := s.Claim()
			if err != nil {
				t.Errorf("claim: %v", err)
				return
			}
			if won {
				atomic.AddInt64(&winners, 1)
			}
		}()
	}
	wg.Wait()
	if winners != 1 {
		t.Fatalf("expected exactly 1 claim winner, got %d", winners)
	}
}

func TestQueueConcurrentEnqueuesPreserved(t *testing.T) {
	s, root := newTestStore(t, "s1")
	const N = 50
	var wg sync.WaitGroup
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.Enqueue("x", nil, QueueSendConfig{}, ""); err != nil {
				t.Errorf("enqueue: %v", err)
			}
		}()
	}
	wg.Wait()
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != N {
		t.Fatalf("expected %d items after concurrent enqueue, got %d", N, len(got))
	}
	// Orders must be unique and monotonic (no two items share an order).
	seen := map[uint64]bool{}
	var prev uint64
	for _, it := range got {
		if seen[it.Order] {
			t.Fatalf("duplicate order %d", it.Order)
		}
		seen[it.Order] = true
		if it.Order < prev {
			t.Fatalf("orders not monotonic in slice: %d after %d", it.Order, prev)
		}
		prev = it.Order
	}
	// Reload confirms all N were durable.
	s2 := &sessionQueueStore{path: queuePath(root, "s1")}
	got2, _ := s2.List()
	if len(got2) != N {
		t.Fatalf("reload lost concurrent items: got %d", len(got2))
	}
}

func TestQueueRemoveRejectsDispatchingAcceptsPending(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	a := mustEnqueue(t, s, "a")
	b := mustEnqueue(t, s, "b")

	// Claim b's predecessor a → a is now dispatching, not removable (the
	// active-dispatch safety guard: the state machine must own its transition
	// to terminal first).
	if _, won, err := s.Claim(); err != nil || !won {
		t.Fatalf("claim: won=%v err=%v", won, err)
	}
	if err := s.Remove(a.ID); !errors.Is(err, errQueueNotRemovable) {
		t.Fatalf("remove dispatching item: err=%v, want errQueueNotRemovable", err)
	}
	// b is still pending → removable.
	if err := s.Remove(b.ID); err != nil {
		t.Fatalf("remove pending item: %v", err)
	}
	got, _ := s.List()
	if len(got) != 1 || got[0].ID != a.ID {
		t.Fatalf("after remove, got %+v, want only [a]", got)
	}
	// Missing item → not-found.
	if err := s.Remove("q-does-not-exist"); !errors.Is(err, errQueueNotFound) {
		t.Fatalf("remove missing: err=%v, want errQueueNotFound", err)
	}
}

// TestQueueRemoveAcceptsTerminalStates pins FIX-QUEUE-GC-4: operators may
// explicitly dismiss terminal items (sent/failed/unknown) that today accumulate
// forever. The docstring at queue.go:19-21 promises terminal items "persist
// until explicit operator dismissal" — this test pins the missing dismissal
// path. For each terminal state: setup the item, remove it, assert success,
// assert the survivors persisted, and assert a fresh store on the same path
// sees the survivors (atomic persistence contract).
func TestQueueRemoveAcceptsTerminalStates(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state QueueItemState
	}{
		{"sent", QueueSent},
		{"failed", QueueFailed},
		{"unknown", QueueUnknown},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, root := newTestStore(t, "s1")
			// Enqueue two items; claim+resolve the first to the target terminal
			// state, leaving the second pending as a survivor we can verify
			// persisted across the removal.
			target := mustEnqueue(t, s, "to-"+tc.name)
			survivor := mustEnqueue(t, s, "survivor")
			if _, won, err := s.Claim(); err != nil || !won {
				t.Fatalf("claim: won=%v err=%v", won, err)
			}
			if _, err := s.Resolve(target.ID, tc.state, "detail-"+tc.name); err != nil {
				t.Fatalf("resolve to %s: %v", tc.name, err)
			}

			// Remove the terminal item — must succeed (the new dismissal path).
			if err := s.Remove(target.ID); err != nil {
				t.Fatalf("remove terminal %s item: %v", tc.name, err)
			}

			// Survivors persisted in memory: only the pending survivor remains.
			got, err := s.List()
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != 1 || got[0].ID != survivor.ID {
				t.Fatalf("%s: after remove, got %+v, want only [survivor]", tc.name, got)
			}

			// Atomic persistence: a fresh store on the same path sees the
			// survivors, not the removed item. Pins the temp-file + fsync +
			// rename contract used by save() — never a half-written queue.json.
			s2 := &sessionQueueStore{path: queuePath(root, "s1")}
			got2, err := s2.List()
			if err != nil {
				t.Fatalf("reload: %v", err)
			}
			if len(got2) != 1 || got2[0].ID != survivor.ID {
				t.Fatalf("%s: reload lost survivor or resurrected removed item: %+v", tc.name, got2)
			}
		})
	}
}

// TestQueueRemoveIsIdempotentAfterRemoval pins the idempotent re-removal
// contract: a second Remove() of an already-removed id returns errQueueNotFound
// (graceful missing-item handling), NOT a silent ok and NOT a panic. This
// matters for stale-id retries from the FE (network blip → re-DELETE) and for
// concurrent dismissal attempts across browser tabs.
func TestQueueRemoveIsIdempotentAfterRemoval(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	a := mustEnqueue(t, s, "a")
	if err := s.Remove(a.ID); err != nil {
		t.Fatalf("first remove: %v", err)
	}
	// Second remove of the same id: item is gone → errQueueNotFound (NOT a
	// silent ok, so the caller can distinguish "removed just now" from "was
	// already gone").
	if err := s.Remove(a.ID); !errors.Is(err, errQueueNotFound) {
		t.Fatalf("second remove: err=%v, want errQueueNotFound", err)
	}
}

func TestQueueClaimedItemNotClaimedTwice(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	mustEnqueue(t, s, "only")
	it, won, err := s.Claim()
	if err != nil || !won {
		t.Fatalf("first claim: won=%v err=%v", won, err)
	}
	// Second claim: nothing pending (the item is dispatching, not pending).
	_, won2, err := s.Claim()
	if err != nil || won2 {
		t.Fatalf("second claim: won=%v err=%v, want no winner", won2, err)
	}
	if it.State != QueueDispatching {
		t.Fatalf("claimed item state = %s, want dispatching", it.State)
	}
}

func TestQueueTerminalSurvivesRestart(t *testing.T) {
	s, root := newTestStore(t, "s1")
	a := mustEnqueue(t, s, "a")
	if _, won, err := s.Claim(); err != nil || !won {
		t.Fatalf("claim: %v", won)
	}
	if _, err := s.Resolve(a.ID, QueueFailed, "definitive rejection"); err != nil {
		t.Fatalf("resolve failed: %v", err)
	}

	// Reload: the failed item must persist (no time-based cleanup, no repend).
	s2 := &sessionQueueStore{path: queuePath(root, "s1")}
	got, err := s2.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].State != QueueFailed || got[0].Detail != "definitive rejection" {
		t.Fatalf("reload: got %+v, want one failed item with detail", got)
	}
}

func TestQueueResolveNeverRepends(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	a := mustEnqueue(t, s, "a")

	// Resolving a PENDING item is rejected (must claim first).
	if _, err := s.Resolve(a.ID, QueueSent, ""); !errors.Is(err, errQueueNotClaimed) {
		t.Fatalf("resolve pending: err=%v, want errQueueNotClaimed", err)
	}
	// A non-terminal target (pending) is rejected outright.
	if _, _, err := s.resolveTarget(a.ID, QueuePending, ""); !errors.Is(err, errQueueCannotRepend) {
		t.Fatalf("resolve to pending: err=%v, want errQueueCannotRepend", err)
	}

	// Claim then resolve sent. Re-resolving to failed/unknown is allowed (idempotent
	// re-report) but never repends.
	if _, won, err := s.Claim(); err != nil || !won {
		t.Fatalf("claim: %v", won)
	}
	if _, err := s.Resolve(a.ID, QueueSent, ""); err != nil {
		t.Fatalf("resolve sent: %v", err)
	}
	if _, err := s.Resolve(a.ID, QueueUnknown, "network blip"); err != nil {
		t.Fatalf("re-resolve terminal→terminal: %v", err)
	}
	got, _ := s.List()
	if got[0].State != QueueUnknown {
		t.Fatalf("after re-resolve state = %s, want unknown", got[0].State)
	}
	// No resolution path can return it to pending.
	for _, st := range []QueueItemState{QueuePending} {
		if _, _, err := s.resolveTarget(a.ID, st, ""); !errors.Is(err, errQueueCannotRepend) {
			t.Fatalf("resolve to %s repended: err=%v", st, err)
		}
	}
}

// resolveTarget wraps Resolve so tests can assert the cannot-repend guard
// without going through the HTTP layer.
func (s *sessionQueueStore) resolveTarget(id string, target QueueItemState, detail string) (QueueItem, bool, error) {
	if !isTerminalState(target) {
		return QueueItem{}, false, errQueueCannotRepend
	}
	it, err := s.Resolve(id, target, detail)
	return it, err == nil, err
}

func TestQueueMalformedFileIsExplicitError(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, ".vh-solara", "sessions", "s1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Write truncated/garbage JSON.
	if err := os.WriteFile(queuePath(root, "s1"), []byte(`{"items":[{"id":"x","order`), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &sessionQueueStore{path: queuePath(root, "s1")}
	if _, err := s.List(); err == nil {
		t.Fatal("List on malformed file: want explicit error, got nil (silent loss)")
	}
	// Enqueue must also fail loudly rather than overwriting/losing the bad file.
	if _, err := s.Enqueue("x", nil, QueueSendConfig{}, ""); err == nil {
		t.Fatal("Enqueue on malformed file: want explicit error, got nil")
	}
}

func TestQueueRegistryDeleteStoreRemovesFile(t *testing.T) {
	root := t.TempDir()
	qr := newQueueRegistry()
	st := qr.store(root, "s1")
	mustEnqueue(t, st, "a")
	// File exists.
	if _, err := os.Stat(queuePath(root, "s1")); err != nil {
		t.Fatalf("queue.json should exist: %v", err)
	}
	qr.deleteStore(root, "s1")
	// File gone.
	if _, err := os.Stat(queuePath(root, "s1")); !os.IsNotExist(err) {
		t.Fatalf("after deleteStore: want not-exist, got %v", err)
	}
	// deleteStore on a never-loaded session still removes any file on disk.
	if err := os.MkdirAll(filepath.Dir(queuePath(root, "s2")), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(queuePath(root, "s2"), []byte(`{"order":0,"items":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	qr.deleteStore(root, "s2")
	if _, err := os.Stat(queuePath(root, "s2")); !os.IsNotExist(err) {
		t.Fatalf("deleteStore never-loaded: want not-exist, got %v", err)
	}
}

// --- HTTP-level smoke (CSRF, routing, response shapes) -----------------------

func newQueueTestServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	root := t.TempDir()
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	agg := aggregator.New(oc.URL, 100)
	srv, err := NewServer(agg, oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	// Override the project root resolution to the temp dir by setting the
	// daemon cwd: projectRoot("") returns os.Getwd(), so chdir into root makes
	// the default project resolve there.
	t.Chdir(root)
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)
	// Issue A: await the Server's owned background goroutines at test end.
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})
	return web, root
}

func csrfPost(t *testing.T, url string, body any) *http.Response {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(csrfHeader, "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestQueueHTTPCSRFEnforced(t *testing.T) {
	web, _ := newQueueTestServer(t)
	// POST without CSRF header → 403.
	b, _ := json.Marshal(map[string]any{"text": "hi"})
	resp, err := http.Post(web.URL+"/vh/session/s1/queue", "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("POST without CSRF: got %d, want 403", resp.StatusCode)
	}
}

func TestQueueHTTPEndpointRoundTrip(t *testing.T) {
	web, root := newQueueTestServer(t)
	sid := "s1"

	// Enqueue two.
	r1 := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue", map[string]any{"text": "first", "originClientId": "browser-A"})
	defer r1.Body.Close()
	if r1.StatusCode != 200 {
		b, _ := io.ReadAll(r1.Body)
		t.Fatalf("enqueue 1: %d %s", r1.StatusCode, b)
	}
	var enq1 struct {
		Item QueueItem `json:"item"`
	}
	if err := json.NewDecoder(r1.Body).Decode(&enq1); err != nil {
		t.Fatal(err)
	}
	r2 := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue", map[string]any{"text": "second"})
	defer r2.Body.Close()
	if r2.StatusCode != 200 {
		t.Fatalf("enqueue 2: %d", r2.StatusCode)
	}

	// List.
	resp, err := http.Get(web.URL + "/vh/session/" + sid + "/queue")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var list struct {
		Items []QueueItem `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 2 {
		t.Fatalf("list: got %d items, want 2", len(list.Items))
	}
	if list.Items[0].OriginClientID != "browser-A" {
		t.Fatalf("originClientId not echoed: %+v", list.Items[0])
	}

	// Claim returns the oldest (first).
	cr := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue/claim", map[string]any{})
	defer cr.Body.Close()
	var claim struct {
		Item QueueItem `json:"item"`
	}
	if err := json.NewDecoder(cr.Body).Decode(&claim); err != nil {
		t.Fatal(err)
	}
	if claim.Item.Text != "first" {
		t.Fatalf("claim returned %q, want first (FIFO)", claim.Item.Text)
	}

	// Claim again → null item (second is still pending! claim only takes the
	// oldest pending; after claiming first, second is now the oldest pending).
	// So a second claim SHOULD return "second", not null. Verify it does.
	cr2 := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue/claim", map[string]any{})
	defer cr2.Body.Close()
	var claim2 struct {
		Item *QueueItem `json:"item"`
	}
	if err := json.NewDecoder(cr2.Body).Decode(&claim2); err != nil {
		t.Fatal(err)
	}
	if claim2.Item == nil || claim2.Item.Text != "second" {
		t.Fatalf("second claim: got %+v, want second", claim2.Item)
	}

	// Third claim → null (nothing pending).
	cr3 := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue/claim", map[string]any{})
	defer cr3.Body.Close()
	var claim3 struct {
		Item *QueueItem `json:"item"`
	}
	if err := json.NewDecoder(cr3.Body).Decode(&claim3); err != nil {
		t.Fatal(err)
	}
	if claim3.Item != nil {
		t.Fatalf("third claim: got %+v, want null", claim3.Item)
	}

	// Resolve the first (dispatching) as failed.
	rr := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue/"+claim.Item.ID+"/resolve", map[string]any{"state": "failed", "detail": "rejected"})
	defer rr.Body.Close()
	if rr.StatusCode != 200 {
		b, _ := io.ReadAll(rr.Body)
		t.Fatalf("resolve failed: %d %s", rr.StatusCode, b)
	}

	// Resolve to pending → 400 (cannot repend).
	rrBad := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue/"+claim.Item.ID+"/resolve", map[string]any{"state": "pending"})
	defer rrBad.Body.Close()
	if rrBad.StatusCode != 400 {
		t.Fatalf("resolve to pending: got %d, want 400", rrBad.StatusCode)
	}

	// Remove a dispatching item (claim2 = "second", still in flight) → 409.
	// The active-dispatch safety guard: the state machine must own the
	// transition to terminal first.
	req, _ := http.NewRequest(http.MethodDelete, web.URL+"/vh/session/"+sid+"/queue/"+claim2.Item.ID, nil)
	req.Header.Set(csrfHeader, "1")
	dr, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	dr.Body.Close()
	if dr.StatusCode != http.StatusConflict {
		t.Fatalf("remove dispatching: got %d, want 409", dr.StatusCode)
	}

	// Remove a TERMINAL item (claim = "first", resolved to failed above) → 200.
	// This is the FIX-QUEUE-GC-4 dismissal path: operators may explicitly clear
	// recovered/failed items from view.
	req2, _ := http.NewRequest(http.MethodDelete, web.URL+"/vh/session/"+sid+"/queue/"+claim.Item.ID, nil)
	req2.Header.Set(csrfHeader, "1")
	dr2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	dr2.Body.Close()
	if dr2.StatusCode != 200 {
		t.Fatalf("remove terminal failed: got %d, want 200", dr2.StatusCode)
	}

	// The queue file is durable on disk (archive cleanup is exercised at the
	// store/registry level in TestQueueRegistryDeleteStoreRemovesFile; the HTTP
	// archive path requires a live session in the aggregator store, which is
	// out of scope for the queue store contract).
	if _, err := os.Stat(queuePath(root, sid)); err != nil {
		t.Fatalf("queue.json should be durable on disk: %v", err)
	}
}

// TestQueueRegistryConcurrentArchiveVsEnqueueNoResurrection is the regression
// guard for B2: a concurrent archive (deleteStore) vs enqueue must not
// RESURRECT the deleted queue nor silently lose a durably-enqueued item.
//
// Buggy mechanism (pre-fix): deleteStore acquired qr.mu, removed the map entry,
// RELEASED qr.mu, then acquired the OLD st.mu and os.Remove'd the file. A
// concurrent store()/Enqueue (needing qr.mu, now free) created a NEW
// sessionQueueStore at the same path, lazily load()ed the STILL-EXISTING file
// (picking up the seeded items), enqueued, and save()d — writing the old items
// back to disk (resurrection) or being deleted by a late os.Remove (silent
// loss). The NEW store had a DIFFERENT mutex than the OLD st, so locking only
// st.mu did nothing to block the racer.
//
// The fix holds qr.mu across BOTH the map-removal AND os.Remove, so store()
// cannot create a new entry until deleteStore fully completes. This test fires
// the race in a loop and asserts the resurrection invariant holds: after
// deleteStore has completed, NONE of the pre-archive seeded items may appear on
// disk, and every on-disk item is a legitimately post-archive enqueue.
func TestQueueRegistryConcurrentArchiveVsEnqueueNoResurrection(t *testing.T) {
	const iterations = 50 // many shots at the window; pre-fix resurrects quickly
	for iter := 0; iter < iterations; iter++ {
		root := t.TempDir()
		qr := newQueueRegistry()

		// Seed items durably — these are the "resurrection bait". Without the
		// fix, a racer's new store load()s them from the not-yet-removed file.
		seed := qr.store(root, "s1")
		seedIDs := make(map[string]bool)
		for i := 0; i < 3; i++ {
			it := mustEnqueue(t, seed, "seed-"+strconv.Itoa(iter)+"-"+strconv.Itoa(i))
			seedIDs[it.ID] = true
		}

		// Race ONE archive against MANY enqueues. Race items use a distinct text
		// prefix so we can tell them apart from resurrected seed items on disk.
		const racers = 60
		var wg sync.WaitGroup
		wg.Add(1 + racers)
		go func() {
			defer wg.Done()
			qr.deleteStore(root, "s1")
		}()
		successfulRaceTexts := make([][]string, racers)
		var mu sync.Mutex
		for g := 0; g < racers; g++ {
			g := g
			text := "race-" + strconv.Itoa(iter) + "-" + strconv.Itoa(g)
			go func() {
				defer wg.Done()
				s := qr.store(root, "s1")
				if _, err := s.Enqueue(text, nil, QueueSendConfig{}, ""); err == nil {
					mu.Lock()
					successfulRaceTexts[g] = []string{text}
					mu.Unlock()
				}
			}()
		}
		wg.Wait()

		// Reload from disk via a FRESH store (bypassing the registry cache) to
		// read the authoritative on-disk state, not a stale in-memory copy.
		fresh := &sessionQueueStore{path: queuePath(root, "s1")}
		list, err := fresh.List()
		if err != nil {
			t.Fatalf("iter %d: reload after race: %v", iter, err)
		}

		// Build the set of legitimately-successful race texts (some enqueues
		// may have errored if they hit the malformed/reload path — none should
		// here, but be defensive).
		okRace := map[string]bool{}
		for _, texts := range successfulRaceTexts {
			for _, tx := range texts {
				okRace[tx] = true
			}
		}

		// Invariant 1 (no resurrection): no seeded item may be on disk after
		// deleteStore completed. Pre-fix this fired when a racer's new store
		// load()ed the seeded file during the archive window and save()d it back.
		for _, it := range list {
			if seedIDs[it.ID] {
				t.Fatalf("iter %d: RESURRECTION — seeded item %q present on disk after archive (deleteStore window not closed by registry lock)", iter, it.Text)
			}
		}

		// Invariant 2 (no phantom): every on-disk item must be a legitimately
		// successful race enqueue. No item may appear on disk that no goroutine
		// durably committed. (A successful enqueue that was later deleted by
		// archive is simply absent — that is correct, not a loss.)
		for _, it := range list {
			if !okRace[it.Text] {
				t.Fatalf("iter %d: PHANTOM — on-disk item %q was not a successful enqueue", iter, it.Text)
			}
		}
	}
}

// TestQueueRegistryArchiveAfterEnqueuePreservesPostArchiveEnqueue is the
// deterministic complement to the race test above: when an enqueue strictly
// FOLLOWS a completed deleteStore, it MUST be durable on disk (no silent loss).
// This pins the post-fix serial behavior: store() creates a fresh empty store
// (load finds no file), enqueues, and saves — the item survives.
func TestQueueRegistryArchiveAfterEnqueuePreservesPostArchiveEnqueue(t *testing.T) {
	root := t.TempDir()
	qr := newQueueRegistry()
	st := qr.store(root, "s1")
	mustEnqueue(t, st, "before-archive")
	// Archive deletes the seeded item + the file.
	qr.deleteStore(root, "s1")
	if _, err := os.Stat(queuePath(root, "s1")); !os.IsNotExist(err) {
		t.Fatalf("after deleteStore: want not-exist, got %v", err)
	}
	// An enqueue strictly after archive must survive (fresh store, no file →
	// load is empty → enqueue → save creates a new file with exactly this item).
	st2 := qr.store(root, "s1")
	it, err := st2.Enqueue("after-archive", nil, QueueSendConfig{}, "")
	if err != nil {
		t.Fatalf("enqueue after archive: %v", err)
	}
	fresh := &sessionQueueStore{path: queuePath(root, "s1")}
	list, err := fresh.List()
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if len(list) != 1 || list[0].ID != it.ID || list[0].Text != "after-archive" {
		t.Fatalf("post-archive enqueue lost or resurrected: %+v", list)
	}
	// The pre-archive item MUST NOT have resurrected.
	for _, x := range list {
		if x.Text == "before-archive" {
			t.Fatalf("pre-archive item resurrected after deleteStore: %+v", x)
		}
	}
}

// TestQueueResolveRollsBackOnSaveFailure pins D1: Resolve mutates State/Detail/
// ResolvedAt in memory before save(); a save failure must restore the prior
// terminal state so the in-memory view stays consistent with disk (mirrors
// Enqueue/Claim rollback). We force a save failure by pointing the store path
// at an unwritable location (a path whose parent dir cannot be created).
func TestQueueResolveRollsBackOnSaveFailure(t *testing.T) {
	root := t.TempDir()
	qr := newQueueRegistry()
	st := qr.store(root, "s1")
	a := mustEnqueue(t, st, "a")
	if _, won, err := st.Claim(); err != nil || !won {
		t.Fatalf("claim: won=%v err=%v", won, err)
	}
	if _, err := st.Resolve(a.ID, QueueSent, "first-ok"); err != nil {
		t.Fatalf("resolve sent: %v", err)
	}
	got, _ := st.List()
	if got[0].State != QueueSent || got[0].Detail != "first-ok" {
		t.Fatalf("precondition: want sent/first-ok, got %+v", got[0])
	}

	// Corrupt the on-disk file so the NEXT save (writeQueueAtomic does
	// MkdirAll(dir) — make the queue path's parent a FILE so MkdirAll fails).
	// This makes save() return an error without touching the item fields.
	parent := filepath.Dir(st.path)
	if err := os.RemoveAll(parent); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(parent, []byte("blocker"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Resolve to a NEW terminal state; save() must fail and the in-memory item
	// must roll back to the prior sent/first-ok (not unknown/second).
	if _, err := st.Resolve(a.ID, QueueUnknown, "second"); err == nil {
		t.Fatal("resolve: want save error from blocked parent dir, got nil")
	}
	got2, _ := st.List()
	if len(got2) != 1 {
		t.Fatalf("rollback: want 1 item, got %d", len(got2))
	}
	if got2[0].State != QueueSent || got2[0].Detail != "first-ok" {
		t.Fatalf("rollback failed: want sent/first-ok, got state=%s detail=%q", got2[0].State, got2[0].Detail)
	}
	if got2[0].ResolvedAt != got[0].ResolvedAt {
		t.Fatalf("rollback failed: ResolvedAt changed %d -> %d", got[0].ResolvedAt, got2[0].ResolvedAt)
	}
}

// TestQueueRemoveRollsBackOnSaveFailure pins F2: Remove mutates the in-memory
// slice (shortens it) before save(); a save failure must restore the pre-remove
// slice so the in-memory view stays consistent with disk (mirrors the
// Resolve/Enqueue/Claim rollback pattern). Without rollback, a save failure
// would leave memory without the item while disk still has it, and a later
// successful mutation would persist the shortened slice — silently deleting an
// item whose remove request failed. We force a save failure by making the queue
// path's parent dir unwritable (a file where a dir is expected → MkdirAll fails).
func TestQueueRemoveRollsBackOnSaveFailure(t *testing.T) {
	root := t.TempDir()
	qr := newQueueRegistry()
	st := qr.store(root, "s1")
	a := mustEnqueue(t, st, "a")
	b := mustEnqueue(t, st, "b")

	// Precondition: two pending items present.
	got, _ := st.List()
	if len(got) != 2 {
		t.Fatalf("precondition: want 2 items, got %d", len(got))
	}

	// Block save() by replacing the queue path's parent dir with a file so
	// writeQueueAtomic's MkdirAll fails. This makes save() return an error
	// without touching the item fields (same mechanism as the Resolve test).
	parent := filepath.Dir(st.path)
	if err := os.RemoveAll(parent); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(parent, []byte("blocker"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Remove a pending item; save() must fail and the in-memory item must roll
	// back so both items are still present.
	if err := st.Remove(a.ID); err == nil {
		t.Fatal("remove: want save error from blocked parent dir, got nil")
	}
	got2, _ := st.List()
	if len(got2) != 2 {
		t.Fatalf("rollback: want 2 items still present, got %d", len(got2))
	}
	ids := map[string]bool{got2[0].ID: true, got2[1].ID: true}
	if !ids[a.ID] || !ids[b.ID] {
		t.Fatalf("rollback failed: want both a(%q) and b(%q) present, got %+v", a.ID, b.ID, got2)
	}

	// A subsequent successful operation can still see the item: unblock the dir
	// and claim the oldest pending (a) — it must succeed, proving the rolled-
	// back item is genuinely still in the store and operational.
	if err := os.Remove(parent); err != nil {
		t.Fatal(err)
	}
	it, won, err := st.Claim()
	if err != nil || !won {
		t.Fatalf("claim after rollback: won=%v err=%v", won, err)
	}
	if it.ID != a.ID {
		t.Fatalf("claim after rollback: got %q, want oldest pending a(%q)", it.ID, a.ID)
	}
}

// TestQueueArchivedStoreRejectsRetainedPointer is the deterministic BLK-1
// regression guard. The bug: handleQueueEnqueue resolves s.queues.store(root,
// sid) — which acquires+releases qr.mu and returns a *sessionQueueStore — and
// THEN calls Enqueue (which acquires st.mu). During that gap a concurrent
// deleteStore (archive) can fully complete: it takes qr.mu, removes the map
// entry, takes st.mu, os.Removes queue.json, releases both. The retained
// pointer's Enqueue then proceeds: loaded==true so it appends to the STALE
// pre-archive s.items and save() writes queue.json back into existence —
// resurrecting archived-away messages plus the new item.
//
// The B2 race test (TestQueueRegistryConcurrentArchiveVsEnqueueNoResurrection)
// misses this because it re-looks-up via store() each iteration rather than
// HOLDING a pointer across the archive boundary. This test holds the pointer.
//
// The fix: deleteStore sets st.archived=true (the tombstone) under BOTH qr.mu
// and st.mu before map removal + os.Remove; every mutation checks `archived`
// right after acquiring st.mu and returns errQueueArchived without mutating or
// save()ing — so a retained pointer can no longer resurrect.
func TestQueueArchivedStoreRejectsRetainedPointer(t *testing.T) {
	root := t.TempDir()
	qr := newQueueRegistry()
	sid := "s1"

	// 1. Seed a store with N items via store().Enqueue and confirm queue.json
	//    exists with them.
	const seedN = 3
	seedIDs := make([]string, 0, seedN)
	for i := 0; i < seedN; i++ {
		it := mustEnqueue(t, qr.store(root, sid), "seed-"+strconv.Itoa(i))
		seedIDs = append(seedIDs, it.ID)
	}
	if _, err := os.Stat(queuePath(root, sid)); err != nil {
		t.Fatalf("queue.json should exist after seeding: %v", err)
	}

	// 2. Obtain a retained pointer via store(root, sid). This is the pointer
	//    the handler holds across the archive gap (BLK-1).
	st := qr.store(root, sid)

	// 3. deleteStore simulates archive: tombstones st and removes the file.
	qr.deleteStore(root, sid)

	// 4. Enqueue on the RETAINED st pointer must return errQueueArchived (not
	//    append, not save, not resurrect).
	if _, err := st.Enqueue("retained-pointer", nil, QueueSendConfig{}, ""); !errors.Is(err, errQueueArchived) {
		t.Fatalf("retained Enqueue after archive: err=%v, want errQueueArchived", err)
	}

	// 5. queue.json must NOT exist on disk — no resurrection.
	if _, err := os.Stat(queuePath(root, sid)); !os.IsNotExist(err) {
		t.Fatalf("BLK-1 RESURRECTION: queue.json exists after retained-pointer Enqueue (err=%v); tombstone failed to block save()", err)
	}

	// 6. The same retained-pointer gap applies to Claim/Resolve/Remove: each
	//    acquires only st.mu, so each must observe archived==true and refuse.
	if _, _, err := st.Claim(); !errors.Is(err, errQueueArchived) {
		t.Fatalf("retained Claim after archive: err=%v, want errQueueArchived", err)
	}
	if _, err := st.Resolve(seedIDs[0], QueueSent, ""); !errors.Is(err, errQueueArchived) {
		t.Fatalf("retained Resolve after archive: err=%v, want errQueueArchived", err)
	}
	if err := st.Remove(seedIDs[0]); !errors.Is(err, errQueueArchived) {
		t.Fatalf("retained Remove after archive: err=%v, want errQueueArchived", err)
	}
	// Resolve to a non-terminal target still returns errQueueCannotRepend
	// (checked before lock acquisition) — confirms the archived check does not
	// shadow the cannot-repend guard.
	if _, err := st.Resolve(seedIDs[0], QueuePending, ""); !errors.Is(err, errQueueCannotRepend) {
		t.Fatalf("retained Resolve to pending: err=%v, want errQueueCannotRepend (checked pre-lock)", err)
	}

	// 7. A FRESH store() lookup AFTER deleteStore creates a brand-new
	//    sessionQueueStore (archived==false, loaded==false) — correct
	//    post-archive behavior, NOT tombstoned. Its Enqueue load()s (no file →
	//    empty), appends, save()s → a new queue.json with ONLY the new item.
	freshIt, err := qr.store(root, sid).Enqueue("after-archive", nil, QueueSendConfig{}, "")
	if err != nil {
		t.Fatalf("fresh post-archive Enqueue: %v", err)
	}
	fresh := &sessionQueueStore{path: queuePath(root, sid)}
	list, err := fresh.List()
	if err != nil {
		t.Fatalf("fresh reload: %v", err)
	}
	if len(list) != 1 || list[0].ID != freshIt.ID || list[0].Text != "after-archive" {
		t.Fatalf("fresh post-archive queue = %+v, want only [after-archive]", list)
	}
	for _, x := range list {
		for _, sid := range seedIDs {
			if x.ID == sid {
				t.Fatalf("BLK-1 RESURRECTION: seeded item %q present in fresh post-archive queue", x.Text)
			}
		}
	}
}

// TestQueueArchivedStoreConcurrentNoResurrection is the -race concurrency
// variant of BLK-1: a goroutine HOLDS a retained store pointer and enqueues
// against it while another goroutine calls deleteStore. Under the tombstone
// fix, the retained Enqueue either (a) completes before deleteStore tombstones
// (file then removed by archive — correct), or (b) observes archived==true and
// returns errQueueArchived. It must NEVER resurrect the archived-away seeded
// items on disk. The deterministic test above is the primary guard; this
// variant exercises the race detector and the resurrection invariant in a loop.
func TestQueueArchivedStoreConcurrentNoResurrection(t *testing.T) {
	const iterations = 40
	for iter := 0; iter < iterations; iter++ {
		root := t.TempDir()
		qr := newQueueRegistry()
		sid := "s1"

		// Seed items durably — resurrection bait.
		seed := qr.store(root, sid)
		seedIDs := make(map[string]bool)
		for i := 0; i < 3; i++ {
			it := mustEnqueue(t, seed, "seed-"+strconv.Itoa(iter)+"-"+strconv.Itoa(i))
			seedIDs[it.ID] = true
		}

		// Retained pointer held across the archive boundary (the BLK-1 gap).
		st := qr.store(root, sid)

		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, _ = st.Enqueue("retained", nil, QueueSendConfig{}, "")
		}()
		go func() {
			defer wg.Done()
			qr.deleteStore(root, sid)
		}()
		wg.Wait()

		// Reload the authoritative on-disk state via a fresh store (bypassing
		// the registry cache). If queue.json does not exist, archive won —
		// correct. If it exists, every item must be the retained enqueue (never
		// a seeded item).
		fresh := &sessionQueueStore{path: queuePath(root, sid)}
		list, err := fresh.List()
		if err != nil {
			t.Fatalf("iter %d: reload: %v", iter, err)
		}
		for _, it := range list {
			if seedIDs[it.ID] {
				t.Fatalf("iter %d: BLK-1 RESURRECTION — seeded item %q on disk after concurrent archive+retained-enqueue", iter, it.Text)
			}
		}
	}
}

// TestQueuePath_vhSolaraDirInvariant locks the structural relationship between
// queuePath and vhSolaraDir: for any session ID that can reach queuePath,
// vhSolaraDir(queuePath(root, sid)) must resolve to root/.vh-solara. If
// queuePath's layout ever gains/loses a path level (or vhSolaraDir's nested
// filepath.Dir count drifts), this fails loudly instead of vhSolaraDir silently
// targeting the wrong dir (and save() writing the project's .gitignore into the
// wrong place via EnsureRuntimeGitignore).
//
// Session IDs reaching queuePath are always pre-sanitized by safeID
// (attach.go: `[^A-Za-z0-9_.-]` → ""), which strips '/' among others, at every
// entry point (queue_http.go:28, archive.go:94). The cases below cover the full
// safeID-allowed character set; multi-segment slash-bearing IDs are intentionally
// NOT tested here because they cannot reach queuePath in production. (Caveat:
// vhSolaraDir's three-nested-filepath.Dir derivation is therefore correct by
// construction ONLY because of that sanitization — if a future caller bypasses
// safeID, the invariant would break for slash-bearing IDs. That is a latent
// fragility worth a follow-up, not in scope for this hardening slice.)
func TestQueuePath_vhSolaraDirInvariant(t *testing.T) {
	root := t.TempDir()
	// Representative IDs spanning the safeID-allowed character set
	// ([A-Za-z0-9_.-]); these are the only shapes that can reach queuePath.
	for _, sid := range []string{
		"s1",                 // simple lowercase+digit (the common shape)
		"a",                  // single char
		"01HQ7X9KF2VEXAMPLE", // ULID-style (realistic opencode shape)
		"with_underscore",    // underscore
		"with-hyphen",        // hyphen
		"with.dot",           // dot
		"MIXED_Case-123.xyz", // mixed allowed chars
	} {
		got := vhSolaraDir(queuePath(root, sid))
		want := filepath.Join(root, ".vh-solara")
		if got != want {
			t.Fatalf("vhSolaraDir(queuePath(%q,%q)) = %q, want %q", root, sid, got, want)
		}
	}
}

// --- Stale-dispatch recovery (FIX-QUEUE-STUCK-1) ----------------------------
//
// Recovery transitions abandoned `dispatching` items to terminal `unknown` on
// every List() load. NEVER to `pending`. NEVER re-dispatched. The 11 cases
// below pin the full state machine: durability, the stale/fresh/legacy
// recovery rules, rollback on save failure, restart-recovery (the operator's
// original bug), non-dispatching states untouched, and that a recovered-unknown
// is still upgradable to sent by a later Resolve (the existing terminal→
// terminal transition).

// seedDispatchingItem writes a dispatching item directly into the store with the
// given DispatchStartedAt, bypassing Claim() (which stamps time.Now()). This
// lets recovery tests simulate stale/fresh/legacy dispatching items
// deterministically without wall-clock sleeps. The item is persisted durably
// so a fresh sessionQueueStore pointing at the same path observes it.
func seedDispatchingItem(t *testing.T, s *sessionQueueStore, id, text string, dispatchStartedAt int64) QueueItem {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		t.Fatalf("seedDispatchingItem load: %v", err)
	}
	s.order++
	it := QueueItem{
		ID:                id,
		Order:             s.order,
		State:             QueueDispatching,
		Text:              text,
		Attachments:       []QueueAttachment{},
		CreatedAt:         time.Now().UnixMilli(),
		DispatchStartedAt: dispatchStartedAt,
	}
	s.items = append(s.items, it)
	if err := s.save(); err != nil {
		t.Fatalf("seedDispatchingItem save: %v", err)
	}
	return it
}

// 1. Claim durably records both state and DispatchStartedAt in one save.
// After Claim, reload the store from disk and assert both State==dispatching
// and DispatchStartedAt > 0 survived the round-trip (so recovery has a
// timestamp to age).
func TestQueueClaimRecordsDispatchStartedAtDurably(t *testing.T) {
	s, root := newTestStore(t, "s1")
	mustEnqueue(t, s, "only")
	it, won, err := s.Claim()
	if err != nil || !won {
		t.Fatalf("claim: won=%v err=%v", won, err)
	}
	if it.State != QueueDispatching {
		t.Fatalf("claimed item state = %s, want dispatching", it.State)
	}
	if it.DispatchStartedAt <= 0 {
		t.Fatalf("claimed item DispatchStartedAt = %d, want > 0", it.DispatchStartedAt)
	}
	// Reload from disk via a FRESH store: both the state and the timestamp
	// must be durable. (List() runs recovery, but a just-claimed item is
	// non-stale, so it stays dispatching.)
	s2 := &sessionQueueStore{path: queuePath(root, "s1")}
	got, err := s2.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("reload: got %d items, want 1", len(got))
	}
	if got[0].State != QueueDispatching {
		t.Fatalf("reload: state = %s, want dispatching (durable)", got[0].State)
	}
	if got[0].DispatchStartedAt != it.DispatchStartedAt {
		t.Fatalf("reload: DispatchStartedAt = %d, want %d (durable)", got[0].DispatchStartedAt, it.DispatchStartedAt)
	}
}

// 2. Non-stale dispatching stays dispatching after List().
func TestQueueRecoveryLeavesNonStaleDispatchingAlone(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	now := time.Now()
	seedDispatchingItem(t, s, "q-fresh", "fresh", now.UnixMilli())
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].State != QueueDispatching {
		t.Fatalf("non-stale dispatching recovered: got %+v, want dispatching", got)
	}
	if got[0].ResolvedAt != 0 {
		t.Fatalf("non-stale dispatching got ResolvedAt = %d, want 0 (untouched)", got[0].ResolvedAt)
	}
	if got[0].Detail != "" {
		t.Fatalf("non-stale dispatching got Detail = %q, want empty (untouched)", got[0].Detail)
	}
}

// 3. Stale dispatching becomes unknown after List().
func TestQueueRecoveryRecoversStaleDispatchingToUnknown(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	now := time.Now()
	staleStartedAt := now.Add(-staleDispatchThreshold - time.Second).UnixMilli()
	seedDispatchingItem(t, s, "q-stale", "stale", staleStartedAt)
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].State != QueueUnknown {
		t.Fatalf("stale dispatching not recovered: got state=%s, want unknown", got[0].State)
	}
}

// 4. Recovered item has ResolvedAt + diagnostic Detail.
func TestQueueRecoverySetsResolvedAtAndDetail(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	now := time.Now()
	staleStartedAt := now.Add(-staleDispatchThreshold - time.Second).UnixMilli()
	seedDispatchingItem(t, s, "q-stale", "stale", staleStartedAt)
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d items, want 1", len(got))
	}
	if got[0].State != QueueUnknown {
		t.Fatalf("state = %s, want unknown", got[0].State)
	}
	if got[0].ResolvedAt <= 0 {
		t.Fatalf("recovered item ResolvedAt = %d, want > 0", got[0].ResolvedAt)
	}
	if got[0].Detail != staleDispatchRecoveryDetail {
		t.Fatalf("recovered item Detail = %q, want exact diagnostic text", got[0].Detail)
	}
}

// 5. Recovery is durable across a fresh store reload.
func TestQueueRecoveryDurableAcrossReload(t *testing.T) {
	s, root := newTestStore(t, "s1")
	now := time.Now()
	staleStartedAt := now.Add(-staleDispatchThreshold - time.Second).UnixMilli()
	seedDispatchingItem(t, s, "q-stale", "stale", staleStartedAt)
	// First List() triggers recovery + persistence.
	first, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if first[0].State != QueueUnknown {
		t.Fatalf("precondition: want unknown after first List, got %s", first[0].State)
	}
	// Fresh store reload: the recovery must be durable on disk.
	s2 := &sessionQueueStore{path: queuePath(root, "s1")}
	got, err := s2.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].State != QueueUnknown {
		t.Fatalf("recovery not durable: got state=%s, want unknown", got[0].State)
	}
	if got[0].ResolvedAt != first[0].ResolvedAt {
		t.Fatalf("recovery ResolvedAt drifted: first=%d reload=%d", first[0].ResolvedAt, got[0].ResolvedAt)
	}
	if got[0].Detail != staleDispatchRecoveryDetail {
		t.Fatalf("recovery Detail not durable: got %q", got[0].Detail)
	}
}

// 6. Recovery never makes an item claimable. After recovery to unknown, Claim()
// must return (zero, false, nil) — no item to claim. Recovery produces terminal
// `unknown`, never `pending`.
func TestQueueRecoveryNeverMakesItemClaimable(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	now := time.Now()
	staleStartedAt := now.Add(-staleDispatchThreshold - time.Second).UnixMilli()
	seedDispatchingItem(t, s, "q-stale", "stale", staleStartedAt)
	if _, err := s.List(); err != nil {
		t.Fatal(err)
	}
	it, won, err := s.Claim()
	if err != nil {
		t.Fatalf("claim after recovery: err=%v", err)
	}
	if won {
		t.Fatalf("claim after recovery: won=true item=%+v, want (zero,false,nil) — recovery must never produce a claimable (pending) item", it)
	}
}

// 7. Multiple stale items recovered in one atomic save.
func TestQueueRecoveryMultipleStaleItemsOneSave(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	now := time.Now()
	staleStartedAt := now.Add(-staleDispatchThreshold - time.Second).UnixMilli()
	seedDispatchingItem(t, s, "q-a", "a", staleStartedAt)
	seedDispatchingItem(t, s, "q-b", "b", staleStartedAt)
	seedDispatchingItem(t, s, "q-c", "c", staleStartedAt)
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d items, want 3", len(got))
	}
	for _, it := range got {
		if it.State != QueueUnknown {
			t.Fatalf("item %q state = %s, want unknown (all stale items recovered in one save)", it.ID, it.State)
		}
		if it.Detail != staleDispatchRecoveryDetail {
			t.Fatalf("item %q Detail = %q, want diagnostic text", it.ID, it.Detail)
		}
	}
}

// 8. Save failure during recovery rolls back ALL in-memory mutations. The
// in-memory state must be fully restored to pre-recovery (item still
// dispatching, ResolvedAt=0, Detail="") so a later successful mutation does not
// persist a silently-recovered item.
func TestQueueRecoveryRollsBackOnSaveFailure(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	now := time.Now()
	staleStartedAt := now.Add(-staleDispatchThreshold - time.Second).UnixMilli()
	seedDispatchingItem(t, s, "q-stale", "stale", staleStartedAt)

	// Block save() by replacing the queue path's parent dir with a file so
	// writeQueueAtomic's MkdirAll fails (same mechanism as the Resolve/Remove
	// rollback tests above).
	parent := filepath.Dir(s.path)
	if err := os.RemoveAll(parent); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(parent, []byte("blocker"), 0o644); err != nil {
		t.Fatal(err)
	}

	// List() must fail (save error during recovery persistence) and roll back
	// the in-memory recovery so the item is still dispatching.
	if _, err := s.List(); err == nil {
		t.Fatal("List: want save error from blocked parent dir, got nil")
	}

	// Inspect the in-memory state directly (List returned an error, so we
	// cannot use it to re-inspect). The item must be fully rolled back to
	// its pre-recovery dispatching shape.
	s.mu.Lock()
	items := make([]QueueItem, len(s.items))
	copy(items, s.items)
	s.mu.Unlock()
	if len(items) != 1 {
		t.Fatalf("rollback: want 1 item in memory, got %d", len(items))
	}
	if items[0].State != QueueDispatching {
		t.Fatalf("rollback failed: state = %s, want dispatching", items[0].State)
	}
	if items[0].ResolvedAt != 0 {
		t.Fatalf("rollback failed: ResolvedAt = %d, want 0 (pre-recovery)", items[0].ResolvedAt)
	}
	if items[0].Detail != "" {
		t.Fatalf("rollback failed: Detail = %q, want empty (pre-recovery)", items[0].Detail)
	}
}

// 9. Legacy dispatching with DispatchStartedAt==0 becomes unknown on first
// List(). This is the RESTART-RECOVERY case the operator observed: an item
// stuck dispatching across a vh-solara restart, persisted by a pre-this-fix
// binary that wrote no dispatchStartedAt field. Loading such a file must
// recover the item to terminal unknown.
func TestQueueRecoveryLegacyDispatchingBecomesUnknown(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, ".vh-solara", "sessions", "s1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Legacy on-disk item: dispatching state, NO dispatchStartedAt field (the
	// pre-this-fix shape). Matches the queueFile envelope load() reads.
	legacy := []byte(`{"order":1,"items":[` +
		`{"id":"q-legacy","order":1,"state":"dispatching","text":"legacy-stuck","createdAt":1700000000000,"attachments":[]}` +
		`]}`)
	if err := os.WriteFile(queuePath(root, "s1"), legacy, 0o644); err != nil {
		t.Fatal(err)
	}
	// Fresh store re-reads the seeded file via load() (no in-memory cache).
	s := &sessionQueueStore{path: queuePath(root, "s1")}
	got, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 || got[0].State != QueueUnknown {
		t.Fatalf("legacy dispatching not recovered: got state=%s, want unknown", got[0].State)
	}
	if got[0].DispatchStartedAt != 0 {
		t.Fatalf("legacy recovery mutated DispatchStartedAt = %d, want 0 preserved", got[0].DispatchStartedAt)
	}
	if got[0].Detail != staleDispatchRecoveryDetail {
		t.Fatalf("legacy recovery Detail = %q, want diagnostic text", got[0].Detail)
	}
	if got[0].ResolvedAt <= 0 {
		t.Fatalf("legacy recovery ResolvedAt = %d, want > 0", got[0].ResolvedAt)
	}
}

// 10. pending/sent/failed/existing-unknown items unchanged by recovery. Only
// dispatching items are ever recovered; every other state is left alone.
func TestQueueRecoveryLeavesNonDispatchingStatesUnchanged(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	// Order so Claim drains the three terminal-destined items first (FIFO),
	// leaving the last one pending.
	sent := mustEnqueue(t, s, "to-sent")
	failed := mustEnqueue(t, s, "to-failed")
	unknown := mustEnqueue(t, s, "to-unknown")
	pending := mustEnqueue(t, s, "stays-pending")

	// Claim+resolve each terminal-destined item in FIFO order.
	claimed, won, err := s.Claim()
	if err != nil || !won || claimed.ID != sent.ID {
		t.Fatalf("claim sent-destined: won=%v err=%v got=%q want=%q", won, err, claimed.ID, sent.ID)
	}
	if _, err := s.Resolve(claimed.ID, QueueSent, "sent-detail"); err != nil {
		t.Fatalf("resolve sent: %v", err)
	}
	claimed, won, err = s.Claim()
	if err != nil || !won || claimed.ID != failed.ID {
		t.Fatalf("claim failed-destined: won=%v err=%v got=%q want=%q", won, err, claimed.ID, failed.ID)
	}
	if _, err := s.Resolve(claimed.ID, QueueFailed, "failed-detail"); err != nil {
		t.Fatalf("resolve failed: %v", err)
	}
	claimed, won, err = s.Claim()
	if err != nil || !won || claimed.ID != unknown.ID {
		t.Fatalf("claim unknown-destined: won=%v err=%v got=%q want=%q", won, err, claimed.ID, unknown.ID)
	}
	if _, err := s.Resolve(claimed.ID, QueueUnknown, "unknown-detail"); err != nil {
		t.Fatalf("resolve unknown: %v", err)
	}
	// pending stays pending (never claimed).

	// List() triggers recovery. None of the items are dispatching, so recovery
	// must be a no-op: every item retains its pre-List state and detail.
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]QueueItem{}
	for _, it := range got {
		byID[it.ID] = it
	}
	checkState := func(id string, wantState QueueItemState, wantDetail string) {
		t.Helper()
		it, ok := byID[id]
		if !ok {
			t.Fatalf("item %q missing from List result", id)
		}
		if it.State != wantState {
			t.Errorf("item %q state = %s, want %s (recovery mutated a non-dispatching item)", id, it.State, wantState)
		}
		if wantDetail != "" && it.Detail != wantDetail {
			t.Errorf("item %q detail = %q, want %q", id, it.Detail, wantDetail)
		}
	}
	checkState(sent.ID, QueueSent, "sent-detail")
	checkState(failed.ID, QueueFailed, "failed-detail")
	checkState(unknown.ID, QueueUnknown, "unknown-detail")
	checkState(pending.ID, QueuePending, "")
}

// 11. A later Resolve(id, QueueSent, ...) can upgrade a recovery-produced
// unknown to sent. This confirms the existing terminal→terminal transition
// still works on recovered items: recovery's `unknown` is a real terminal
// state, and a delayed confirmation (e.g., a late OpenCode ack arriving) can
// refine it without any special-case code.
func TestQueueRecoveredUnknownCanBeResolvedToSent(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	now := time.Now()
	staleStartedAt := now.Add(-staleDispatchThreshold - time.Second).UnixMilli()
	seedDispatchingItem(t, s, "q-stale", "stale", staleStartedAt)
	// Recovery → unknown.
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].State != QueueUnknown {
		t.Fatalf("precondition: want unknown after recovery, got %+v", got)
	}
	// A later resolve to sent must succeed (terminal→terminal transition).
	resolved, err := s.Resolve(got[0].ID, QueueSent, "late-confirmation")
	if err != nil {
		t.Fatalf("resolve recovered-unknown to sent: %v", err)
	}
	if resolved.State != QueueSent || resolved.Detail != "late-confirmation" {
		t.Fatalf("resolve result: got state=%s detail=%q, want sent/late-confirmation", resolved.State, resolved.Detail)
	}
	after, _ := s.List()
	if len(after) != 1 || after[0].State != QueueSent || after[0].Detail != "late-confirmation" {
		t.Fatalf("after resolve: got state=%s detail=%q, want sent/late-confirmation", after[0].State, after[0].Detail)
	}
}

// --- Session queue cleanup primitive (FIX-QUEUE-GC-1) -----------------------
//
// deleteStore is generalized into an idempotent web-owned cleanup: it removes
// queue.json AND attempts empty-only rmdir of the parent session directory.
// NEVER os.RemoveAll — the attachment lifecycle (peer attachments/ subdir) is
// unproven against retained OpenCode transcript file:// references, so the
// directory survives whenever attachments/, an atomic-write temp file, or
// anything else is present. The 10 cases below pin the full cleanup contract
// that GC-2 (event subscription), GC-3 (orphan reconciliation), GC-4 (terminal
// dismissal), and GC-5 (automatic compaction) will build on.

// 1. Registered store is tombstoned (BLK-1) and removed from the registry map.
// The retained pointer's archived flag must be true so a retained store cannot
// resurrect via save() — the load-bearing contract every mutation relies on.
func TestQueueCleanupTombstonesRegisteredStore(t *testing.T) {
	root := t.TempDir()
	qr := newQueueRegistry()
	sid := "s1"
	st := qr.store(root, sid)
	mustEnqueue(t, st, "a")
	qr.deleteStore(root, sid)
	// The store must no longer be in the registry map.
	qr.mu.Lock()
	_, present := qr.stores[storeKey(root, sid)]
	qr.mu.Unlock()
	if present {
		t.Fatal("deleteStore: store still present in registry map")
	}
	// The retained pointer's tombstone flag must be set under its own mutex
	// so a retained pointer cannot resurrect via save() (BLK-1).
	st.mu.Lock()
	archived := st.archived
	st.mu.Unlock()
	if !archived {
		t.Fatal("deleteStore: retained store pointer archived=false, want true (BLK-1 tombstone)")
	}
}

// 2. Queue file on disk is removed.
func TestQueueCleanupRemovesQueueFile(t *testing.T) {
	root := t.TempDir()
	qr := newQueueRegistry()
	sid := "s1"
	mustEnqueue(t, qr.store(root, sid), "a")
	if _, err := os.Stat(queuePath(root, sid)); err != nil {
		t.Fatalf("precondition: queue.json should exist: %v", err)
	}
	qr.deleteStore(root, sid)
	if _, err := os.Stat(queuePath(root, sid)); !os.IsNotExist(err) {
		t.Fatalf("after deleteStore: want not-exist, got %v", err)
	}
}

// 3. Idempotent: queue file already absent → no panic. deleteStore has no
// error return; this asserts the ENOENT path is swallowed and the registry is
// left in a usable state (a subsequent store()+Enqueue works).
func TestQueueCleanupIdempotentNoFile(t *testing.T) {
	root := t.TempDir()
	qr := newQueueRegistry()
	sid := "never-existed"
	// No file on disk, no store in registry. deleteStore must not panic.
	qr.deleteStore(root, sid)
	// Registry must still be usable: a subsequent store()+Enqueue works.
	st := qr.store(root, sid)
	mustEnqueue(t, st, "post-cleanup")
}

// 4. Empty parent session directory is removed after queue.json removal. This
// is the "empty-directory litter" orphan scenario from the GC-2/3 solution
// brief: a session whose queue.json is the only artifact should leave no
// .vh-solara/sessions/<id>/ litter behind.
func TestQueueCleanupRemovesEmptyParentDir(t *testing.T) {
	root := t.TempDir()
	qr := newQueueRegistry()
	sid := "s1"
	mustEnqueue(t, qr.store(root, sid), "a")
	dir := filepath.Dir(queuePath(root, sid))
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("precondition: session dir should exist: %v", err)
	}
	qr.deleteStore(root, sid)
	// queue.json gone (verified in case 2); the empty parent dir must also
	// be gone.
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("after deleteStore: empty session dir should be gone, got %v", err)
	}
}

// 5. Parent containing attachments/ subdir → directory survives. The
// attachment lifecycle is unproven (OpenCode transcripts may retain file://
// references to attachment URLs), so the queue GC MUST NOT remove a directory
// that still holds attachment data. Only queue.json is removed. This is the
// reason we use os.Remove (empty-only) instead of os.RemoveAll.
func TestQueueCleanupPreservesDirWithAttachments(t *testing.T) {
	root := t.TempDir()
	qr := newQueueRegistry()
	sid := "s1"
	mustEnqueue(t, qr.store(root, sid), "a")
	dir := filepath.Dir(queuePath(root, sid))
	attachDir := filepath.Join(dir, "attachments")
	if err := os.MkdirAll(attachDir, 0o755); err != nil {
		t.Fatal(err)
	}
	dummy := filepath.Join(attachDir, "image.png")
	if err := os.WriteFile(dummy, []byte("png-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	qr.deleteStore(root, sid)
	// queue.json gone.
	if _, err := os.Stat(queuePath(root, sid)); !os.IsNotExist(err) {
		t.Fatalf("after deleteStore: queue.json should be gone, got %v", err)
	}
	// Session directory + attachments/ + dummy file MUST survive.
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("session dir should survive (has attachments/): %v", err)
	}
	if _, err := os.Stat(attachDir); err != nil {
		t.Fatalf("attachments/ should survive: %v", err)
	}
	if _, err := os.Stat(dummy); err != nil {
		t.Fatalf("attachment file should survive: %v", err)
	}
}

// 6. Parent containing an atomic-write temp file → directory survives. Models
// a racing writeQueueAtomic temp file (".queue.json.tmp-*") that hasn't been
// cleaned up yet. The temp must not be silently lost; the directory pins until
// the next save() cycle completes its own temp cleanup. Pinning on a temp is
// correct: an in-flight atomic write must not be silently lost.
func TestQueueCleanupPreservesDirWithAtomicTempFile(t *testing.T) {
	root := t.TempDir()
	qr := newQueueRegistry()
	sid := "s1"
	mustEnqueue(t, qr.store(root, sid), "a")
	dir := filepath.Dir(queuePath(root, sid))
	// Simulate a writeQueueAtomic temp file: same prefix pattern
	// ("." + base + ".tmp-*"). See writeQueueAtomic in queue.go.
	tmp := filepath.Join(dir, ".queue.json.tmp-fakeRace123")
	if err := os.WriteFile(tmp, []byte("partial"), 0o644); err != nil {
		t.Fatal(err)
	}
	qr.deleteStore(root, sid)
	// queue.json gone.
	if _, err := os.Stat(queuePath(root, sid)); !os.IsNotExist(err) {
		t.Fatalf("after deleteStore: queue.json should be gone, got %v", err)
	}
	// Session directory + temp file MUST survive (the directory is non-empty
	// so empty-only rmdir fails and is swallowed — the safe behavior).
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("session dir should survive (has temp file): %v", err)
	}
	if _, err := os.Stat(tmp); err != nil {
		t.Fatalf("atomic-write temp file should survive: %v", err)
	}
}

// 7. Idempotent: parent directory already missing → no panic. deleteStore on
// a session whose directory was already removed (e.g., by a previous cleanup
// call, or by an external janitor) must not panic and must leave the registry
// in a usable state.
func TestQueueCleanupIdempotentNoDir(t *testing.T) {
	root := t.TempDir()
	qr := newQueueRegistry()
	sid := "s1"
	// No file on disk, no directory on disk, no store in registry. deleteStore
	// must not panic on the double-ENOENT (path + dir).
	qr.deleteStore(root, sid)
	// Registry still usable: a subsequent store()+Enqueue works (save() does
	// MkdirAll, recreating the directory).
	st := qr.store(root, sid)
	mustEnqueue(t, st, "post-cleanup")
}

// 8. Concurrent retained store pointer cannot recreate the deleted store.
// Mirrors the BLK-1 invariant (TestQueueArchivedStoreRejectsRetainedPointer)
// but exercises the cleanup-primitive generalization directly: a retained
// *sessionQueueStore obtained before cleanup calls save() — the only path that
// writes queue.json — and must observe errQueueArchived, leaving no queue.json
// on disk. This is the load-bearing concurrency guarantee GC-2/3/4/5 depend on
// for safe invocation from event listeners / reconciliation sweeps.
//
// st.mu is held around save() to mirror the happens-before discipline every
// production caller follows (e.g. Enqueue/Claim/Resolve/Remove and the
// seedDispatchingItem helper at L1032): save() reads s.archived at queue.go:198
// relying on the caller's lock, and deleteStore writes st.archived under st.mu
// at queue.go:585. Without the test-side lock the read would race with that
// write under `go test -race`.
func TestQueueCleanupRetainedPointerCannotRecreate(t *testing.T) {
	root := t.TempDir()
	qr := newQueueRegistry()
	sid := "s1"
	st := qr.store(root, sid)
	mustEnqueue(t, st, "seed")
	// Retained pointer held across cleanup.
	qr.deleteStore(root, sid)
	// save() on the retained pointer must return errQueueArchived (the
	// tombstone contract: BLK-1 last-resort guard inside save()). Hold st.mu
	// around the call to match the production happens-before discipline.
	st.mu.Lock()
	err := st.save()
	st.mu.Unlock()
	if !errors.Is(err, errQueueArchived) {
		t.Fatalf("retained save() after cleanup: err=%v, want errQueueArchived", err)
	}
	// queue.json MUST NOT exist on disk — no resurrection.
	if _, err := os.Stat(queuePath(root, sid)); !os.IsNotExist(err) {
		t.Fatalf("retained save() recreated queue.json (BLK-1 regression): %v", err)
	}
}

// 9. Repeated cleanup is idempotent: a second call produces no filesystem side
// effects and no panic. After the first call has removed queue.json and the
// empty parent directory, the second call's ENOENT-on-both paths must be
// swallowed cleanly.
func TestQueueCleanupRepeatedIsIdempotent(t *testing.T) {
	root := t.TempDir()
	qr := newQueueRegistry()
	sid := "s1"
	mustEnqueue(t, qr.store(root, sid), "a")
	dir := filepath.Dir(queuePath(root, sid))
	qr.deleteStore(root, sid)
	// First call removed queue.json + empty parent dir.
	if _, err := os.Stat(queuePath(root, sid)); !os.IsNotExist(err) {
		t.Fatalf("first deleteStore: queue.json should be gone, got %v", err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("first deleteStore: empty session dir should be gone, got %v", err)
	}
	// Second call must be a no-op (no panic, both ENOENT paths swallowed).
	qr.deleteStore(root, sid)
	// State unchanged.
	if _, err := os.Stat(queuePath(root, sid)); !os.IsNotExist(err) {
		t.Fatalf("second deleteStore: queue.json should still be gone, got %v", err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("second deleteStore: session dir should still be gone, got %v", err)
	}
}

// 10. Cleanup discovers on-disk queue.json even without a registered store.
// The no-store branch must still attempt filesystem cleanup so a hand-seeded
// queue.json (e.g., from a previous binary's persistence, or a restart hydrate
// prune that left a stale file) gets removed and the empty parent dir is
// cleaned up. This is the foundation for GC-3 (orphan reconciliation).
func TestQueueCleanupRemovesOrphanedFileOnDisk(t *testing.T) {
	root := t.TempDir()
	qr := newQueueRegistry()
	sid := "s1"
	// Seed queue.json directly on disk, bypassing the registry entirely.
	dir := filepath.Dir(queuePath(root, sid))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(queuePath(root, sid), []byte(`{"order":0,"items":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	// Cleanup hits the no-store branch and must still remove the file + the
	// now-empty parent dir.
	qr.deleteStore(root, sid)
	if _, err := os.Stat(queuePath(root, sid)); !os.IsNotExist(err) {
		t.Fatalf("no-store branch: queue.json should be gone, got %v", err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("no-store branch: empty session dir should be gone, got %v", err)
	}
}
