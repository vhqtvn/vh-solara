package alerts

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/state"
)

// fakeClock is a controllable clock for the time-based detectors.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}
func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// newTestWatcher builds a watcher wired to a capturing delivery sink and a fake
// clock, with the default detector thresholds (think/cmd 300s, stalled 180s,
// finished settle 5s). baseline=0 so any event with Seq>=1 is "live".
func newTestWatcher(t *testing.T) (*watcher, *fakeClock, *[]Notice, *state.Store) {
	t.Helper()
	cfg, err := NewStore(filepath.Join(t.TempDir(), "alerts.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	eng := NewEngine(cfg, NewPresence(), NewDispatcher(cfg, NewPresence()))
	st := state.New(4096)
	clk := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	var mu sync.Mutex
	var fired []Notice
	w := &watcher{
		engine:   eng,
		dir:      "proj",
		store:    st,
		now:      clk.Now,
		sessions: map[string]*sessTrack{},
		finishAt: map[string]time.Time{},
		firedRun: map[string]bool{},
		firedReq: map[string]bool{},
		deliver: func(n Notice) {
			mu.Lock()
			fired = append(fired, n)
			mu.Unlock()
		},
	}
	return w, clk, &fired, st
}

func ev(seq uint64, kind string, payload any) state.ClientEvent {
	b, _ := json.Marshal(payload)
	return state.ClientEvent{Seq: seq, Kind: kind, Payload: b}
}
func activity(seq uint64, sid, st string) state.ClientEvent {
	return ev(seq, state.KindActivity, map[string]any{"sessionID": sid, "state": st})
}
func reasoningPart(seq uint64, sid, id string) state.ClientEvent {
	return ev(seq, state.KindPartUpsert, map[string]any{"id": id, "sessionID": sid, "messageID": "m1", "type": "reasoning"})
}
func toolPart(seq uint64, sid, id, tool, status string) state.ClientEvent {
	return ev(seq, state.KindPartUpsert, map[string]any{
		"id": id, "sessionID": sid, "messageID": "m1", "type": "tool",
		"tool": tool, "state": map[string]any{"status": status},
	})
}
func session(seq uint64, id, parent string) state.ClientEvent {
	return ev(seq, state.KindSessionUpsert, map[string]any{"id": id, "parentID": parent, "title": id})
}

func count(fired []Notice, typ, sid string) int {
	n := 0
	for _, f := range fired {
		if f.Type == typ && (sid == "" || f.SessionID == sid) {
			n++
		}
	}
	return n
}
func has(fired []Notice, typ, sid string) bool { return count(fired, typ, sid) > 0 }

func TestEngineStuckThinking(t *testing.T) {
	w, clk, fired, _ := newTestWatcher(t)
	w.onEvent(activity(1, "s1", state.ActivityBusy))
	w.onEvent(reasoningPart(2, "s1", "r1")) // since=T0, lastUpdate=T0
	clk.advance(290 * time.Second)
	w.onEvent(reasoningPart(3, "s1", "r1")) // refresh lastUpdate; same part → since stays T0
	clk.advance(20 * time.Second)           // now T0+310: since 310>300, lastUpdate 20s<40s
	w.sweep()
	if !has(*fired, TypeStuckThinking, "s1") {
		t.Fatalf("expected stuck-thinking to fire; got %+v", *fired)
	}
	// fires once per episode
	clk.advance(5 * time.Second)
	w.sweep()
	if count(*fired, TypeStuckThinking, "s1") != 1 {
		t.Errorf("stuck-thinking fired more than once: %d", count(*fired, TypeStuckThinking, "s1"))
	}
}

func TestEngineStuckThinkingNotFiredWhenFrozen(t *testing.T) {
	// Reasoning that stopped updating long ago is "stalled", not "stuck-thinking".
	w, clk, fired, _ := newTestWatcher(t)
	w.onEvent(activity(1, "s1", state.ActivityBusy))
	w.onEvent(reasoningPart(2, "s1", "r1"))
	clk.advance(400 * time.Second) // since old AND lastUpdate old (>40s)
	w.sweep()
	if has(*fired, TypeStuckThinking, "s1") {
		t.Errorf("frozen reasoning must not fire stuck-thinking")
	}
}

func TestEngineStuckExcludedByRunningTask(t *testing.T) {
	w, clk, fired, _ := newTestWatcher(t)
	w.onEvent(activity(1, "s1", state.ActivityBusy))
	w.onEvent(toolPart(2, "s1", "tk", "task", "running")) // delegating
	w.onEvent(reasoningPart(3, "s1", "r1"))
	clk.advance(290 * time.Second)
	w.onEvent(reasoningPart(4, "s1", "r1"))
	clk.advance(20 * time.Second)
	w.sweep()
	if has(*fired, TypeStuckThinking, "s1") {
		t.Errorf("coordinator with a running task must not fire stuck-thinking")
	}
}

func TestEngineRunaway(t *testing.T) {
	w, clk, fired, _ := newTestWatcher(t)
	w.onEvent(toolPart(1, "s1", "b1", "bash", "running"))
	clk.advance(301 * time.Second)
	w.sweep()
	if !has(*fired, TypeRunaway, "s1") {
		t.Fatalf("expected runaway; got %+v", *fired)
	}
}

func TestEngineTaskToolIsNotRunaway(t *testing.T) {
	w, clk, fired, _ := newTestWatcher(t)
	w.onEvent(toolPart(1, "s1", "tk", "task", "running"))
	clk.advance(900 * time.Second)
	w.sweep()
	if has(*fired, TypeRunaway, "s1") {
		t.Errorf("a long-running task tool is delegation, not a runaway command")
	}
}

func TestEngineRunawayClearedOnCompletion(t *testing.T) {
	w, clk, fired, _ := newTestWatcher(t)
	w.onEvent(toolPart(1, "s1", "b1", "bash", "running"))
	clk.advance(100 * time.Second)
	w.onEvent(toolPart(2, "s1", "b1", "bash", "completed")) // finished in time
	clk.advance(400 * time.Second)
	w.sweep()
	if has(*fired, TypeRunaway, "s1") {
		t.Errorf("completed tool must not fire runaway")
	}
}

func TestEngineStalled(t *testing.T) {
	w, clk, fired, _ := newTestWatcher(t)
	w.onEvent(activity(1, "s1", state.ActivityBusy))
	clk.advance(181 * time.Second)
	w.sweep()
	if !has(*fired, TypeStalled, "s1") {
		t.Fatalf("expected stalled; got %+v", *fired)
	}
}

func TestEngineStalledExcludedByBusyDescendant(t *testing.T) {
	w, clk, fired, _ := newTestWatcher(t)
	w.onEvent(session(1, "parent", ""))
	w.onEvent(session(2, "child", "parent"))
	w.onEvent(activity(3, "parent", state.ActivityBusy))
	w.onEvent(activity(4, "child", state.ActivityBusy))
	clk.advance(200 * time.Second)
	w.sweep()
	if has(*fired, TypeStalled, "parent") {
		t.Errorf("coordinator with a busy descendant must not fire stalled")
	}
}

func TestEngineWaitingFiresOnceAndRespectsBaseline(t *testing.T) {
	w, _, fired, _ := newTestWatcher(t)
	perm := func(seq uint64, id string) state.ClientEvent {
		return ev(seq, state.KindPermissionSet, map[string]any{"sessionID": "s1", "id": id})
	}
	w.onEvent(perm(1, "p1"))
	w.onEvent(perm(2, "p1")) // repeat of same request id
	if c := count(*fired, TypeWaiting, "s1"); c != 1 {
		t.Fatalf("waiting should fire exactly once per request id, got %d", c)
	}
	// A different request fires again.
	w.onEvent(perm(3, "p2"))
	if c := count(*fired, TypeWaiting, "s1"); c != 2 {
		t.Errorf("a new request id should fire; got %d", c)
	}
}

func TestEngineWaitingSuppressedBeforeBaseline(t *testing.T) {
	w, _, fired, _ := newTestWatcher(t)
	w.baseline = 100 // pre-existing state from the startup snapshot
	w.onEvent(ev(5, state.KindPermissionSet, map[string]any{"sessionID": "s1", "id": "old"}))
	if has(*fired, TypeWaiting, "s1") {
		t.Errorf("a permission already present at startup must not alert")
	}
}

func TestEngineFinishedAfterSettle(t *testing.T) {
	w, clk, fired, st := newTestWatcher(t)
	// Hydrate an idle, message-free session so SendableNow(root) is true.
	info, _ := json.Marshal(map[string]any{"id": "root"})
	st.Hydrate([]json.RawMessage{info}, nil)

	w.onEvent(ev(1, state.KindUnreadSet, map[string]any{"sessionID": "root"}))
	// Before the settle window elapses, nothing fires.
	clk.advance(3 * time.Second)
	w.sweep()
	if has(*fired, TypeFinished, "root") {
		t.Fatalf("fired before settle window")
	}
	clk.advance(3 * time.Second) // total 6s > 5s settle
	w.sweep()
	if !has(*fired, TypeFinished, "root") {
		t.Fatalf("expected finished after settle; got %+v", *fired)
	}
}

func TestEngineFinishedSuppressedWhenNotSendable(t *testing.T) {
	w, clk, fired, _ := newTestWatcher(t)
	// No session in the store → SendableNow reports exists=false → must not fire.
	w.onEvent(ev(1, state.KindUnreadSet, map[string]any{"sessionID": "ghost"}))
	clk.advance(10 * time.Second)
	w.sweep()
	if has(*fired, TypeFinished, "ghost") {
		t.Errorf("finished must not fire when the session isn't sendable")
	}
}

// TestEmitDaemonNoticeFansOutToAllProjects (oc-death-watch S2): a daemon-level
// notice reaches EVERY attached project store's in-app bus with the agreed
// shape — existing kind TypeStalled, Title naming the subject, Detail carrying
// the event text, and empty session/root (it is not about any session). The
// outbound dispatcher/pusher arms are the same one-line delegations Attach's
// deliver performs (their routing/cooldown logic is covered by
// routing_test.go); this test pins the fan-out + shape.
func TestEmitDaemonNoticeFansOutToAllProjects(t *testing.T) {
	cfg, err := NewStore(filepath.Join(t.TempDir(), "alerts.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	eng := NewEngine(cfg, NewPresence(), NewDispatcher(cfg, NewPresence()))

	subs := map[string]<-chan state.ClientEvent{}
	for _, dir := range []string{"projA", "projB"} {
		st := state.New(4096)
		eng.Attach(ctx, dir, st)
		ch, unsub := st.Subscribe(16)
		defer unsub()
		subs[dir] = ch
	}

	eng.EmitDaemonNotice("opencode serve pid 42 exited (signal TERM/15) after 1h2m")

	for dir, ch := range subs {
		select {
		case ev := <-ch:
			if ev.Kind != state.KindNotice {
				t.Fatalf("%s: fan-out kind = %q, want %q", dir, ev.Kind, state.KindNotice)
			}
			var n Notice
			if err := json.Unmarshal(ev.Payload, &n); err != nil {
				t.Fatalf("%s: payload not a Notice: %v", dir, err)
			}
			if n.Type != TypeStalled {
				t.Errorf("%s: type = %q, want existing kind %q", dir, n.Type, TypeStalled)
			}
			if n.Title != "OpenCode" {
				t.Errorf("%s: title = %q, want %q", dir, n.Title, "OpenCode")
			}
			if n.Detail != "opencode serve pid 42 exited (signal TERM/15) after 1h2m" {
				t.Errorf("%s: detail = %q, want the event text verbatim", dir, n.Detail)
			}
			if n.SessionID != "" || n.Root != "" {
				t.Errorf("%s: daemon notice must not claim a session (sessionID=%q root=%q)", dir, n.SessionID, n.Root)
			}
			if n.Ts == 0 {
				t.Errorf("%s: ts must be stamped", dir)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%s: never received the daemon notice on its store bus", dir)
		}
	}

	// A store attached AFTER the emit is a LIVE-subscriber fan-out, not a
	// replay — no notice may arrive on it (EmitNotice has no replay by
	// design; a fresh subscriber sees only later events).
	late := state.New(4096)
	eng.Attach(ctx, "projLate", late)
	lateCh, lateUnsub := late.Subscribe(16)
	defer lateUnsub()
	select {
	case ev := <-lateCh:
		t.Fatalf("late-attached store unexpectedly received a notice: %+v", ev)
	case <-time.After(150 * time.Millisecond):
		// good — no replay
	}
}

// --- session_started (v3 change 3) ---

// lastOfType returns the most recent notice of typ (nil when none fired).
func lastOfType(fired []Notice, typ string) *Notice {
	for i := len(fired) - 1; i >= 0; i-- {
		if fired[i].Type == typ {
			return &fired[i]
		}
	}
	return nil
}

// TestEngineSessionStartedBaselineThenIncrease pins the core contract: the
// FIRST sweep establishes the running-root baseline WITHOUT firing (sessions
// already running at startup never alert), an unchanged set never fires, and
// an INCREASE fires exactly ONE notice carrying the representative
// newly-running root (sessionID/root/title from the new root, human-readable
// detail).
func TestEngineSessionStartedBaselineThenIncrease(t *testing.T) {
	w, _, fired, _ := newTestWatcher(t)

	// root-a is already running at the first sweep → baseline, not a fire.
	w.onEvent(session(1, "root-a", ""))
	w.onEvent(activity(2, "root-a", state.ActivityBusy))
	w.sweep() // first sweep: baseline
	if has(*fired, TypeSessionStarted, "") {
		t.Fatalf("first sweep must baseline, not fire: %+v", *fired)
	}
	// Unchanged on the next sweep: still nothing.
	w.sweep()
	if has(*fired, TypeSessionStarted, "") {
		t.Fatalf("unchanged running set must not fire: %+v", *fired)
	}

	// A second root goes running → increase → exactly one notice, and the
	// representative is the NEWLY running root (not the baselined one).
	w.onEvent(session(3, "root-b", ""))
	w.onEvent(activity(4, "root-b", state.ActivityBusy))
	w.sweep()
	if c := count(*fired, TypeSessionStarted, ""); c != 1 {
		t.Fatalf("session_started fired %d times, want exactly 1: %+v", c, *fired)
	}
	n := lastOfType(*fired, TypeSessionStarted)
	if n.SessionID != "root-b" || n.Root != "root-b" {
		t.Errorf("notice must carry the newly-running root: %+v", n)
	}
	if n.Title != "root-b" { // the session() helper stamps title=id
		t.Errorf("notice title = %q, want the root's title", n.Title)
	}
	if n.Detail == "" {
		t.Errorf("notice detail must be human-readable, got empty")
	}
}

// TestEngineSessionStartedMultipleNewOneNotice: several new running roots in
// ONE sweep collapse to ONE notice (the representative is deterministic —
// the lexicographically first new root).
func TestEngineSessionStartedMultipleNewOneNotice(t *testing.T) {
	w, _, fired, _ := newTestWatcher(t)
	w.sweep() // baseline: empty
	w.onEvent(session(1, "r2", ""))
	w.onEvent(activity(2, "r2", state.ActivityBusy))
	w.onEvent(session(3, "r1", ""))
	w.onEvent(activity(4, "r1", state.ActivityBusy))
	w.sweep()
	if c := count(*fired, TypeSessionStarted, ""); c != 1 {
		t.Fatalf("multiple new roots in one sweep must fire exactly once, got %d: %+v", c, *fired)
	}
	if n := lastOfType(*fired, TypeSessionStarted); n.SessionID != "r1" {
		t.Errorf("representative = %q, want the deterministic first new root r1", n.SessionID)
	}
}

// TestEngineSessionStartedNotOnDecreaseOrReplacement: a decrease never fires,
// and a REPLACEMENT (one stops, another starts — count unchanged between
// sweeps) never fires either; the detector is count-increase-only.
func TestEngineSessionStartedNotOnDecreaseOrReplacement(t *testing.T) {
	w, _, fired, _ := newTestWatcher(t)
	w.onEvent(session(1, "a", ""))
	w.onEvent(activity(2, "a", state.ActivityBusy))
	w.onEvent(session(3, "b", ""))
	w.onEvent(activity(4, "b", state.ActivityBusy))
	w.sweep() // baseline {a, b}

	// Decrease: a stops → {b}, no fire.
	w.onEvent(activity(5, "a", state.ActivityIdle))
	w.sweep()
	if has(*fired, TypeSessionStarted, "") {
		t.Fatalf("decrease must not fire: %+v", *fired)
	}

	// Replacement: c starts and b stops → {c} vs {b}, count equal → no fire.
	w.onEvent(session(6, "c", ""))
	w.onEvent(activity(7, "c", state.ActivityBusy))
	w.onEvent(activity(8, "b", state.ActivityIdle))
	w.sweep()
	if has(*fired, TypeSessionStarted, "") {
		t.Fatalf("count-preserving replacement must not fire: %+v", *fired)
	}
}

// TestEngineSessionStartedRestartFiresAgain: a root that stops running and
// later runs again is a NEW increase (0 → 1) and fires again — subject to
// the downstream per-(type,session)/(type,token) cooldowns, not to any
// detector-side once-ever latch.
func TestEngineSessionStartedRestartFiresAgain(t *testing.T) {
	w, _, fired, _ := newTestWatcher(t)
	w.onEvent(session(1, "a", ""))
	w.sweep() // baseline: a exists but idle → {}

	w.onEvent(activity(2, "a", state.ActivityBusy))
	w.sweep() // {} → {a}: fire #1
	if c := count(*fired, TypeSessionStarted, ""); c != 1 {
		t.Fatalf("first increase must fire, got %d: %+v", c, *fired)
	}
	w.onEvent(activity(3, "a", state.ActivityIdle))
	w.sweep() // {a} → {}: no fire
	if c := count(*fired, TypeSessionStarted, ""); c != 1 {
		t.Fatalf("decrease must not add a fire: %+v", *fired)
	}
	w.onEvent(activity(4, "a", state.ActivityBusy))
	w.sweep() // {} → {a}: fire #2 — restart is a new increase
	if c := count(*fired, TypeSessionStarted, ""); c != 2 {
		t.Fatalf("restart must fire again, got %d total: %+v", c, *fired)
	}
}

// TestEngineSessionStartedBusyChildIsNotARunningRoot: "running ROOT sessions"
// counts roots by their OWN activity. A busy child under an idle root is the
// root's ongoing turn (delegation), not a new session start; when the root
// itself goes busy the increase fires with the ROOT carried.
func TestEngineSessionStartedBusyChildIsNotARunningRoot(t *testing.T) {
	w, _, fired, _ := newTestWatcher(t)
	w.onEvent(session(1, "root", ""))
	w.onEvent(session(2, "child", "root"))
	w.sweep() // baseline: {}

	w.onEvent(activity(3, "child", state.ActivityBusy)) // child runs, root idle
	w.sweep()
	if has(*fired, TypeSessionStarted, "") {
		t.Fatalf("a busy child under an idle root is not a new running root: %+v", *fired)
	}

	w.onEvent(activity(4, "root", state.ActivityBusy)) // the root itself runs
	w.sweep()
	if c := count(*fired, TypeSessionStarted, ""); c != 1 {
		t.Fatalf("root going busy must fire once, got %d: %+v", c, *fired)
	}
	if n := lastOfType(*fired, TypeSessionStarted); n.SessionID != "root" || n.Root != "root" {
		t.Errorf("notice must carry the root, got %+v", n)
	}
}
