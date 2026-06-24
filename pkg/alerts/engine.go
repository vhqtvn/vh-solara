package alerts

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/state"
)

const sweepInterval = 20 * time.Second

// Engine is the daemon-side detection brain. One Engine serves the whole daemon;
// Attach() wires it to each project store as aggregators come up. It maintains a
// lightweight per-session model built purely from the event stream (the bus
// carries no timestamps, so the engine stamps arrival time itself) and, on a
// periodic sweep, fires notices for the detector rules.
type Engine struct {
	cfg        *Store
	presence   *Presence
	dispatcher *Dispatcher
	pusher     *Pusher // optional; nil if Web Push is unavailable

	mu       sync.Mutex
	watchers map[string]*watcher // dir -> watcher
}

func NewEngine(cfg *Store, presence *Presence, dispatcher *Dispatcher) *Engine {
	return &Engine{
		cfg:        cfg,
		presence:   presence,
		dispatcher: dispatcher,
		watchers:   map[string]*watcher{},
	}
}

// Presence exposes the presence registry (for HTTP heartbeat handlers).
func (e *Engine) Presence() *Presence { return e.presence }

// Dispatcher exposes the dispatcher (for the "send test" endpoint).
func (e *Engine) Dispatcher() *Dispatcher { return e.dispatcher }

// SetPusher attaches the Web Push sender (closed-app delivery). Optional.
func (e *Engine) SetPusher(p *Pusher) { e.pusher = p }

// Pusher exposes the Web Push sender (for the subscribe/key endpoints). May be nil.
func (e *Engine) Pusher() *Pusher { return e.pusher }

// Config exposes the config store (for settings endpoints).
func (e *Engine) Config() *Store { return e.cfg }

// Attach begins watching a project store. Idempotent per dir. The watcher runs
// until ctx is cancelled (daemon teardown).
func (e *Engine) Attach(ctx context.Context, dir string, store *state.Store) {
	e.mu.Lock()
	if _, ok := e.watchers[dir]; ok {
		e.mu.Unlock()
		return
	}
	w := &watcher{
		engine:   e,
		dir:      dir,
		store:    store,
		sessions: map[string]*sessTrack{},
		finishAt: map[string]time.Time{},
		firedRun: map[string]bool{},
		firedReq: map[string]bool{},
		now:      time.Now,
	}
	e.watchers[dir] = w
	e.mu.Unlock()
	go w.run(ctx)
}

// sessTrack is the engine's local model of one session, built from events.
type sessTrack struct {
	parentID string
	title    string
	activity string // idle | busy | retry | error

	lastEventAt time.Time // last event of any kind for this session (stall timer)

	reasoningPartID     string
	reasoningSince      time.Time
	reasoningLastUpdate time.Time
	stuckFired          bool

	stalledFired bool

	// running non-completed tool parts: partID -> tool track
	runningTools map[string]*toolTrack
}

type toolTrack struct {
	tool  string
	since time.Time
}

type watcher struct {
	engine *Engine
	dir    string
	store  *state.Store

	baseline uint64 // snapshot head seq; only events past this may FIRE
	now      func() time.Time

	mu       sync.Mutex
	sessions map[string]*sessTrack
	finishAt map[string]time.Time // root -> time its subtree went idle (pending settle)
	firedRun map[string]bool      // partID -> runaway already fired
	firedReq map[string]bool      // permission/question id -> waiting already fired
}

func isBusy(a string) bool { return a == state.ActivityBusy || a == state.ActivityRetry }

func (w *watcher) track(sid string) *sessTrack {
	t := w.sessions[sid]
	if t == nil {
		t = &sessTrack{runningTools: map[string]*toolTrack{}, lastEventAt: w.now()}
		w.sessions[sid] = t
	}
	return t
}

func (w *watcher) run(ctx context.Context) {
	ch, unsub := w.store.Subscribe(256)
	defer unsub()

	// Baseline from a snapshot taken AFTER subscribing: events up to this seq are
	// already reflected in the seed, so only later events are allowed to fire.
	snap := w.store.Snapshot(map[string]bool{}) // no message history needed
	w.baseline = snap.Seq
	w.seed(snap)

	ticker := time.NewTicker(sweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return // dropped as a slow consumer; engine attaches fresh elsewhere
			}
			w.onEvent(ev)
		case <-ticker.C:
			w.sweep()
		}
	}
}

// seed populates tracker state from a snapshot without firing anything.
func (w *watcher) seed(snap state.Snapshot) {
	w.mu.Lock()
	defer w.mu.Unlock()
	now := w.now()
	for _, info := range snap.Sessions {
		var s sessionInfo
		if json.Unmarshal(info, &s) != nil || s.ID == "" {
			continue
		}
		t := w.track(s.ID)
		t.parentID = s.ParentID
		t.title = s.Title
		t.lastEventAt = now
	}
	for sid, act := range snap.Activity {
		w.track(sid).activity = act
	}
}

type sessionInfo struct {
	ID       string `json:"id"`
	ParentID string `json:"parentID"`
	Title    string `json:"title"`
}

type partMsg struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionID"`
	Type      string `json:"type"`
	Tool      string `json:"tool"`
	State     struct {
		Status string `json:"status"`
	} `json:"state"`
}

type idSession struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionID"`
}

// onEvent updates the local model and records fire-eligible signals. Firing for
// transition rules (waiting, finished) is gated on ev.Seq > baseline so existing
// state at startup never alerts.
func (w *watcher) onEvent(ev state.ClientEvent) {
	live := ev.Seq > w.baseline
	w.mu.Lock()
	defer w.mu.Unlock()
	now := w.now()

	switch ev.Kind {
	case state.KindSessionUpsert:
		var s sessionInfo
		if json.Unmarshal(ev.Payload, &s) == nil && s.ID != "" {
			t := w.track(s.ID)
			t.parentID = s.ParentID
			t.title = s.Title
			t.lastEventAt = now
		}
	case state.KindSessionDelete:
		var s idSession
		if json.Unmarshal(ev.Payload, &s) == nil {
			delete(w.sessions, s.ID)
		}
	case state.KindActivity:
		var a struct {
			SessionID string `json:"sessionID"`
			State     string `json:"state"`
		}
		if json.Unmarshal(ev.Payload, &a) == nil && a.SessionID != "" {
			t := w.track(a.SessionID)
			t.activity = a.State
			t.lastEventAt = now
			if !isBusy(a.State) {
				t.stalledFired = false // settled; a new busy episode may stall again
			}
		}
	case state.KindPartUpsert:
		var p partMsg
		if json.Unmarshal(ev.Payload, &p) == nil && p.SessionID != "" {
			t := w.track(p.SessionID)
			t.lastEventAt = now
			t.stalledFired = false
			switch p.Type {
			case "reasoning":
				if t.reasoningPartID != p.ID {
					t.reasoningPartID = p.ID
					t.reasoningSince = now
					t.stuckFired = false
				}
				t.reasoningLastUpdate = now
			default:
				// any non-reasoning part means the model moved past thinking
				t.reasoningPartID = ""
				t.stuckFired = false
			}
			if p.Type == "tool" {
				switch p.State.Status {
				case "running":
					if t.runningTools[p.ID] == nil {
						t.runningTools[p.ID] = &toolTrack{tool: p.Tool, since: now}
					}
				default: // completed | error | pending | (empty)
					delete(t.runningTools, p.ID)
					delete(w.firedRun, p.ID)
				}
			}
		}
	case state.KindPartDelete:
		var p struct {
			SessionID string `json:"sessionID"`
			PartID    string `json:"partID"`
		}
		if json.Unmarshal(ev.Payload, &p) == nil {
			if t := w.sessions[p.SessionID]; t != nil {
				t.lastEventAt = now
				delete(t.runningTools, p.PartID)
				delete(w.firedRun, p.PartID)
			}
		}
	case state.KindMessageUpsert, state.KindTodo, state.KindStatus:
		var s idSession
		if json.Unmarshal(ev.Payload, &s) == nil && s.SessionID != "" {
			w.track(s.SessionID).lastEventAt = now
		}
	case state.KindPermissionSet, state.KindQuestionSet:
		var s idSession
		if json.Unmarshal(ev.Payload, &s) == nil && s.SessionID != "" {
			t := w.track(s.SessionID)
			t.lastEventAt = now
			if live && s.ID != "" && !w.firedReq[s.ID] {
				w.firedReq[s.ID] = true
				w.fire(s.SessionID, TypeWaiting, "Waiting for your input")
			}
		}
	case state.KindPermissionClear, state.KindQuestionClear:
		var s struct {
			PermissionID string `json:"permissionID"`
			QuestionID   string `json:"questionID"`
		}
		if json.Unmarshal(ev.Payload, &s) == nil {
			delete(w.firedReq, s.PermissionID)
			delete(w.firedReq, s.QuestionID)
		}
	case state.KindUnreadSet:
		var s idSession
		if json.Unmarshal(ev.Payload, &s) == nil && s.SessionID != "" && live {
			w.finishAt[s.SessionID] = now // root finished; confirm after settle
		}
	case state.KindUnreadClear:
		var s idSession
		if json.Unmarshal(ev.Payload, &s) == nil {
			delete(w.finishAt, s.SessionID)
		}
	}
}

// sweep evaluates the time-based detector rules.
func (w *watcher) sweep() {
	cfg := w.engine.cfg.Get().Detect
	thinkDur := time.Duration(cfg.ThinkSec) * time.Second
	cmdDur := time.Duration(cfg.CommandSec) * time.Second
	stalledDur := time.Duration(cfg.StalledSec) * time.Second
	settle := time.Duration(cfg.FinishedSettleSec) * time.Second

	w.mu.Lock()
	now := w.now()

	type pending struct {
		sid, typ, detail string
	}
	var fires []pending

	// finished: confirm settled root turns via the store's send gate.
	for root, at := range w.finishAt {
		if now.Sub(at) < settle {
			continue
		}
		delete(w.finishAt, root)
		if sendable, _, exists := w.store.SendableNow(root); exists && sendable {
			fires = append(fires, pending{root, TypeFinished, "Turn finished"})
		}
	}

	for sid, t := range w.sessions {
		excluded := w.hasRunningTaskLocked(sid) || w.hasBusyDescendantLocked(sid)

		// stuck-thinking: reasoning actively streaming beyond the threshold.
		if t.reasoningPartID != "" && isBusy(t.activity) && !t.stuckFired && !excluded &&
			now.Sub(t.reasoningSince) > thinkDur &&
			now.Sub(t.reasoningLastUpdate) < 2*sweepInterval {
			t.stuckFired = true
			fires = append(fires, pending{sid, TypeStuckThinking, "Thinking for a long time"})
		}

		// runaway: a non-task tool running too long (no coordinator exclusion — the
		// long-running command itself is the evidence).
		for pid, tt := range t.runningTools {
			if tt.tool == "task" || w.firedRun[pid] {
				continue
			}
			if now.Sub(tt.since) > cmdDur {
				w.firedRun[pid] = true
				fires = append(fires, pending{sid, TypeRunaway, "Command running for a long time: " + tt.tool})
			}
		}

		// stalled: busy but silent (no events) too long, and not a coordinator.
		if isBusy(t.activity) && !t.stalledFired && !excluded &&
			now.Sub(t.lastEventAt) > stalledDur {
			t.stalledFired = true
			fires = append(fires, pending{sid, TypeStalled, "No output for a while"})
		}
	}
	w.mu.Unlock()

	for _, f := range fires {
		w.mu.Lock()
		w.fire(f.sid, f.typ, f.detail)
		w.mu.Unlock()
	}
}

// hasRunningTaskLocked reports whether the session has a running `task` tool
// part (it is delegating to a child and legitimately waiting). Caller holds mu.
func (w *watcher) hasRunningTaskLocked(sid string) bool {
	t := w.sessions[sid]
	if t == nil {
		return false
	}
	for _, tt := range t.runningTools {
		if tt.tool == "task" {
			return true
		}
	}
	return false
}

// hasBusyDescendantLocked reports whether any other session whose ancestry runs
// through sid is busy (sid is a coordinator waiting on children). Caller holds mu.
func (w *watcher) hasBusyDescendantLocked(sid string) bool {
	for id, t := range w.sessions {
		if id == sid || !isBusy(t.activity) {
			continue
		}
		cur := t.parentID
		for hops := 0; cur != "" && hops < 64; hops++ {
			if cur == sid {
				return true
			}
			p := w.sessions[cur]
			if p == nil {
				break
			}
			cur = p.parentID
		}
	}
	return false
}

// rootOfLocked walks parentID to the top tracked session. Caller holds mu.
func (w *watcher) rootOfLocked(sid string) string {
	cur := sid
	for hops := 0; hops < 64; hops++ {
		t := w.sessions[cur]
		if t == nil || t.parentID == "" || w.sessions[t.parentID] == nil {
			return cur
		}
		cur = t.parentID
	}
	return cur
}

// fire emits a notice in-app (store fan-out) and to webhook channels. Caller
// holds mu (for tracker reads); the dispatch itself is non-blocking.
func (w *watcher) fire(sid, typ, detail string) {
	t := w.sessions[sid]
	title := ""
	if t != nil {
		title = t.title
	}
	root := w.rootOfLocked(sid)
	n := Notice{
		Type:      typ,
		SessionID: sid,
		Root:      root,
		Project:   w.dir,
		Title:     title,
		Detail:    detail,
		Ts:        w.now().UnixMilli(),
	}
	payload, _ := json.Marshal(n)
	w.store.EmitNotice(payload)
	w.engine.dispatcher.Dispatch(n)
	if w.engine.pusher != nil {
		w.engine.pusher.Send(n)
	}
}
