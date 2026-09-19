package web

// Tests for the restart queue fence (restart_fence.go) — the queue-dispatch
// arm of the restart-interruption fix. Store-level tests pin the fence's
// durability, idempotence, and fail-open rollback; handler-level tests pin
// that BOTH restart routes fence in-flight dispatches BEFORE the restart
// hook kills the process; recovery/reconcile tests pin that the marker
// selects the restart-specific detail texts WITHOUT weakening the generic
// paths (the detector, its 3×404 budget, and the exact-match → sent heal
// are unchanged — see the companion tests added to
// queue_msg_reconcile_test.go).

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/oclife"
)

// TestRestartFenceStampsOnlyDispatchingItemsDurably: the fence stamps
// EXACTLY the in-flight (`dispatching`) items — pending items (waiting for a
// connection) and terminal items (already settled) are untouched — and the
// stamp is durable across a cold reload of the store from disk.
func TestRestartFenceStampsOnlyDispatchingItemsDurably(t *testing.T) {
	s, root := newTestStore(t, "s1")

	// Claim order matters (Claim picks the OLDEST pending): settle the sent
	// item while it is the oldest pending, then leave the last one pending.
	claimed := mustEnqueue(t, s, "in flight")
	if _, _, err := s.Claim(); err != nil {
		t.Fatalf("Claim: %v", err)
	}
	done := mustEnqueue(t, s, "already settled")
	if _, _, err := s.Claim(); err != nil {
		t.Fatalf("Claim (done): %v", err)
	}
	if _, err := s.Resolve(done.ID, QueueSent, "sent ok"); err != nil {
		t.Fatalf("Resolve(sent): %v", err)
	}
	pending := mustEnqueue(t, s, "still waiting")

	fenceAt := time.Unix(1700000000, 0)
	n, err := s.fenceDispatchingForRestart(fenceAt)
	if err != nil {
		t.Fatalf("fenceDispatchingForRestart: %v", err)
	}
	if n != 1 {
		t.Fatalf("fenced count = %d, want 1 (only the dispatching item)", n)
	}

	// Fresh store at the same path reloads the stamp from disk (durability).
	fresh := &sessionQueueStore{path: queuePath(root, "s1")}
	items, err := fresh.List()
	if err != nil {
		t.Fatalf("fresh List: %v", err)
	}
	byID := map[string]QueueItem{}
	for _, it := range items {
		byID[it.ID] = it
	}
	if got := byID[claimed.ID]; got.RestartFenceAt != fenceAt.UnixMilli() {
		t.Fatalf("dispatching item RestartFenceAt = %d, want %d (durable stamp)",
			got.RestartFenceAt, fenceAt.UnixMilli())
	}
	if got := byID[pending.ID]; got.RestartFenceAt != 0 {
		t.Fatalf("pending item must NOT be fenced, got RestartFenceAt=%d", got.RestartFenceAt)
	}
	if got := byID[done.ID]; got.RestartFenceAt != 0 {
		t.Fatalf("terminal (sent) item must NOT be fenced, got RestartFenceAt=%d", got.RestartFenceAt)
	}
}

// TestRestartFenceIdempotentKeepsFirstStamp: a second restart before
// recovery must not rewrite the interruption time — the FIRST stamp is the
// honest one — and a fully-fenced store performs no save (no-op).
func TestRestartFenceIdempotentKeepsFirstStamp(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	mustEnqueue(t, s, "probe")
	if _, _, err := s.Claim(); err != nil {
		t.Fatalf("Claim: %v", err)
	}

	first := time.Unix(1700000000, 0)
	if _, err := s.fenceDispatchingForRestart(first); err != nil {
		t.Fatalf("first fence: %v", err)
	}
	second := first.Add(37 * time.Minute)
	n, err := s.fenceDispatchingForRestart(second)
	if err != nil {
		t.Fatalf("second fence: %v", err)
	}
	if n != 0 {
		t.Fatalf("second fence stamped %d items, want 0 (already fenced)", n)
	}

	items, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(items) != 1 || items[0].RestartFenceAt != first.UnixMilli() {
		t.Fatalf("RestartFenceAt drifted on re-fence: got %+v, want first stamp %d",
			items[0], first.UnixMilli())
	}
}

// TestRestartFenceSaveFailureFailsOpenAndRollsBack: when the atomic save
// fails (blocked parent dir — same mechanism as the recovery rollback
// tests), the fence returns the error, rolls the in-memory mutation back
// (RestartFenceAt stays 0 so the generic recovery texts apply), and never
// panics — the restart caller logs and proceeds (fail-open).
func TestRestartFenceSaveFailureFailsOpenAndRollsBack(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	mustEnqueue(t, s, "probe")
	if _, _, err := s.Claim(); err != nil {
		t.Fatalf("Claim: %v", err)
	}

	parent := filepath.Dir(s.path)
	if err := os.RemoveAll(parent); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(parent, []byte("blocker"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := s.fenceDispatchingForRestart(time.Now()); err == nil {
		t.Fatal("fence: want save error from blocked parent dir, got nil")
	}

	s.mu.Lock()
	items := make([]QueueItem, len(s.items))
	copy(items, s.items)
	s.mu.Unlock()
	if len(items) != 1 || items[0].RestartFenceAt != 0 {
		t.Fatalf("fence rollback failed: %+v, want RestartFenceAt=0 (unfenced on save failure)", items)
	}
}

// TestRestartFenceRegistryWalksAllStores: the registry-level fence reaches
// every registered (root, session) store — restarts are fleet-wide by
// nature, and a dispatch in ANY project's queue is equally mid-flight.
func TestRestartFenceRegistryWalksAllStores(t *testing.T) {
	qr := newQueueRegistry()
	rootA, rootB := t.TempDir(), t.TempDir()

	sA := qr.store(rootA, "sess-a")
	mustEnqueue(t, sA, "a")
	if _, _, err := sA.Claim(); err != nil {
		t.Fatalf("claim a: %v", err)
	}
	sB := qr.store(rootB, "sess-b")
	mustEnqueue(t, sB, "b")
	if _, _, err := sB.Claim(); err != nil {
		t.Fatalf("claim b: %v", err)
	}
	// A pending item in a third store must not be fenced (and must not
	// block the walk).
	sC := qr.store(rootA, "sess-c")
	mustEnqueue(t, sC, "c-pending")

	if n := qr.fenceDispatchingForRestart(time.Now()); n != 2 {
		t.Fatalf("registry fence stamped %d items, want 2 (one per dispatching store)", n)
	}

	for _, st := range []*sessionQueueStore{sA, sB} {
		items, err := st.List()
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		if len(items) != 1 || items[0].RestartFenceAt == 0 {
			t.Fatalf("store %s: dispatching item not fenced: %+v", st.path, items)
		}
	}
	items, err := sC.List()
	if err != nil {
		t.Fatalf("List c: %v", err)
	}
	if len(items) != 1 || items[0].RestartFenceAt != 0 {
		t.Fatalf("pending item must not be fenced: %+v", items)
	}
}

// queueListItemField fetches one item field from GET /vh/session/{sid}/queue
// on the verb test server (handler-level fence tests). Returns the raw item
// map or nil when the item list is empty.
func queueListItem(t *testing.T, base, sid, dir, itemID string) map[string]any {
	t.Helper()
	u := base + "/vh/session/" + sid + "/queue?dir=" + url.QueryEscape(dir)
	resp, err := http.Get(u)
	if err != nil {
		t.Fatalf("queue list: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("queue list: status %d", resp.StatusCode)
	}
	var out struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("queue list decode: %v", err)
	}
	for _, it := range out.Items {
		if it["id"] == itemID {
			return it
		}
	}
	return nil
}

// TestRestartRoutesFenceInflightQueueBeforeRestartHook drives BOTH restart
// routes against a server whose queue holds one in-flight (dispatching) item
// and pins the ordering: the fence is durable BEFORE the restart hook runs
// (the hook models restartOC killing the process — by the time it runs, the
// only remaining write opportunity is gone). Also pins that the fence does
// NOT change the item's state: it is still `dispatching` (the state machine
// stays owned by stale recovery + the reconciler).
func TestRestartRoutesFenceInflightQueueBeforeRestartHook(t *testing.T) {
	for _, route := range []string{"/vh/opencode/restart", "/vh/restart-opencode"} {
		t.Run(route, func(t *testing.T) {
			f := &fakeOC{}
			web, _, srv := newVerbServerSrv(t, f)

			if route == "/vh/opencode/restart" {
				life := oclife.New(oclife.TopologyOwned)
				life.SetReady()
				srv.SetOpenCodeLifecycle(life)
			}

			// One claimed (in-flight) queue item in a per-test project dir.
			dir := t.TempDir()
			st, body, _ := post(t, web.URL+"/vh/session/s-fence/queue?dir="+url.QueryEscape(dir),
				`{"text":"mid-dispatch probe"}`, nil)
			if st != http.StatusOK {
				t.Fatalf("enqueue: status=%d body=%v", st, body)
			}
			st, body, _ = post(t, web.URL+"/vh/session/s-fence/queue/claim?dir="+url.QueryEscape(dir), "", nil)
			if st != http.StatusOK {
				t.Fatalf("claim: status=%d body=%v", st, body)
			}
			var claim struct {
				Item struct {
					ID    string `json:"id"`
					State string `json:"state"`
				} `json:"item"`
			}
			if err := decodePostBody(body, &claim); err != nil {
				t.Fatalf("claim decode: %v", err)
			}
			if claim.Item.State != "dispatching" {
				t.Fatalf("claim: state=%q, want dispatching", claim.Item.State)
			}
			itemID := claim.Item.ID

			hookCalled := false
			fencedBeforeHook := false
			stillDispatchingInHook := true
			srv.SetRestartOpenCode(func(ctx context.Context) error {
				hookCalled = true
				it := queueListItem(t, web.URL, "s-fence", dir, itemID)
				if it == nil {
					t.Fatal("restart hook: queued item vanished")
				}
				if ms, _ := it["restartFenceAt"].(float64); ms <= 0 {
					fencedBeforeHook = false
				} else {
					fencedBeforeHook = true
					if s, _ := it["state"].(string); s != "dispatching" {
						stillDispatchingInHook = false
					}
				}
				return nil
			})

			st, body, _ = post(t, web.URL+route, "", nil)
			if st != http.StatusOK {
				t.Fatalf("POST %s: status=%d body=%v", route, st, body)
			}
			if !hookCalled {
				t.Fatal("restart hook was not called")
			}
			if !fencedBeforeHook {
				t.Fatal("restart hook ran before the queue fence was durable — fenceInflightQueueDispatches ordering broken")
			}
			if !stillDispatchingInHook {
				t.Fatal("fence changed the item state — it must NOT touch the state machine (recovery + reconciler own it)")
			}

			// Post-restart: the marker survives on the (still dispatching)
			// item; the state machine will take it from here unchanged.
			it := queueListItem(t, web.URL, "s-fence", dir, itemID)
			if it == nil {
				t.Fatal("item vanished after restart")
			}
			if ms, _ := it["restartFenceAt"].(float64); ms <= 0 {
				t.Fatalf("post-restart restartFenceAt = %v, want > 0", it["restartFenceAt"])
			}
			if s, _ := it["state"].(string); s != "dispatching" {
				t.Fatalf("post-restart state = %q, want dispatching (fence stamps, recovery transitions)", s)
			}
		})
	}
}

// decodePostBody re-decodes a post() body map into a typed struct (post
// returns map[string]any; these tests want typed fields).
func decodePostBody(body map[string]any, dst any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, dst)
}

// TestStaleRecoveryPrefersRestartFenceDetail: recoverStaleDispatchingLocked
// picks the restart-specific detail for a FENCED item and keeps the generic
// text for an unfenced one (the pre-fence behavior — a regression pin).
func TestStaleRecoveryPrefersRestartFenceDetail(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	now := time.Now()
	staleStartedAt := now.Add(-staleDispatchThreshold - time.Second).UnixMilli()

	// Seed the fenced item FIRST, fence it, then seed the unfenced control —
	// the fence stamps every currently-dispatching item, so the control must
	// not exist at fence time.
	fenced := seedDispatchingItem(t, s, "q-restart", "killed mid-dispatch", staleStartedAt)
	if n, err := s.fenceDispatchingForRestart(now); err != nil || n != 1 {
		t.Fatalf("fence: n=%d err=%v, want n=1", n, err)
	}
	plain := seedDispatchingItem(t, s, "q-plain", "plain abandoned dispatch", staleStartedAt)

	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]QueueItem{}
	for _, it := range got {
		byID[it.ID] = it
	}
	if d := byID[fenced.ID]; d.State != QueueUnknown || d.Detail != restartFenceStaleRecoveryDetail {
		t.Fatalf("fenced item: state=%q detail=%q, want unknown + restart-fence detail", d.State, d.Detail)
	}
	if d := byID[plain.ID]; d.State != QueueUnknown || d.Detail != staleDispatchRecoveryDetail {
		t.Fatalf("unfenced item: state=%q detail=%q, want unknown + GENERIC detail (unchanged path)", d.State, d.Detail)
	}
}
