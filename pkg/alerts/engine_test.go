package alerts

import (
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
