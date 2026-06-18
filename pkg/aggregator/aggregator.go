// Package aggregator maintains a persistent connection to a local OpenCode
// server, feeding its events into a state.Store so clients can resume from the
// daemon instead of re-deriving everything themselves.
package aggregator

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/state"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// Aggregator couples an OpenCode client with a materialized Store.
type Aggregator struct {
	client *opencode.Client
	store  *state.Store
}

// New builds an aggregator targeting an opencode server base URL.
func New(baseURL string, ringCapacity int) *Aggregator {
	return &Aggregator{
		client: opencode.New(baseURL),
		store:  state.New(ringCapacity),
	}
}

// NewForDirectory builds an aggregator scoped to a project directory (sent to
// OpenCode via the x-opencode-directory header), for multi-project support.
func NewForDirectory(baseURL, directory string, ringCapacity int) *Aggregator {
	c := opencode.New(baseURL)
	c.Directory = directory
	return &Aggregator{client: c, store: state.New(ringCapacity)}
}

// Directory returns the project directory this aggregator is scoped to ("" =
// the OpenCode serve cwd / default).
func (a *Aggregator) Directory() string { return a.client.Directory }

// Store exposes the materialized view for the web layer.
func (a *Aggregator) Store() *state.Store { return a.store }

// Client exposes the underlying OpenCode client (used for write passthrough).
func (a *Aggregator) Client() *opencode.Client { return a.client }

func decodeMessages(items []json.RawMessage) []state.MessageWithParts {
	mwp := make([]state.MessageWithParts, 0, len(items))
	for _, it := range items {
		var m state.MessageWithParts
		if json.Unmarshal(it, &m) == nil {
			mwp = append(mwp, m)
		}
	}
	return mwp
}

// EnsureMessages lazily loads a session's message history on first open. It is
// a no-op once the session is loaded; subsequent live events keep it current.
func (a *Aggregator) EnsureMessages(ctx context.Context, sessionID string) error {
	if sessionID == "" || a.store.IsMessagesLoaded(sessionID) {
		return nil
	}
	items, err := a.client.Messages(ctx, sessionID)
	if err != nil {
		return err
	}
	a.store.SetSessionMessages(sessionID, decodeMessages(items))
	return nil
}

// Rehydrate re-fetches the full state from OpenCode and reconciles the store.
// Safe to call at any time: Hydrate diffs by id and emits only the changes, so
// connected clients converge without a full resync. This is the "reload server
// state" primitive — it rebuilds the view from the source of truth (OpenCode)
// without restarting the process or touching the running OpenCode.
func (a *Aggregator) Rehydrate(ctx context.Context) error { return a.hydrate(ctx) }

// Run keeps a live tail on OpenCode's event stream, re-hydrating the full view
// on every (re)connect because the stream has no replay. It blocks until ctx is
// cancelled.
func (a *Aggregator) Run(ctx context.Context) {
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		start := time.Now()

		// Open the live tail first so events occurring during hydration are not
		// lost; the store is idempotent, so any overlap with the snapshot is safe.
		subCtx, cancel := context.WithCancel(ctx)
		errc := make(chan error, 1)
		go func() {
			errc <- a.client.SubscribeEvents(subCtx, func(ev opencode.Event) error {
				// Per-event trace (VH_DEBUG): the single most useful signal when an
				// event isn't producing the expected store change (e.g. the
				// permission.asked / message.part.delta drift bugs).
				if vhlog.Enabled() {
					vhlog.Debug("oc event", "type", ev.Type, "bytes", len(ev.Properties))
				}
				a.store.Apply(ev)
				return nil
			})
		}()

		if err := a.hydrate(ctx); err != nil {
			log.Printf("[aggregator] hydrate failed: %v", err)
		} else {
			log.Printf("[aggregator] hydrated; tailing events")
		}

		err := <-errc
		cancel()
		if ctx.Err() != nil {
			return
		}

		// A connection that survived a while is "healthy"; reset backoff.
		if time.Since(start) > 30*time.Second {
			backoff = time.Second
		}
		log.Printf("[aggregator] event stream ended (%v); reconnecting in %v", err, backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

// hydrate fetches the full session list (flat, with parentID) plus each
// session's messages, then reconciles them into the store via id-level diff.
func (a *Aggregator) hydrate(ctx context.Context) error {
	sessions, err := a.client.ListSessions(ctx)
	if err != nil {
		return err
	}
	// Messages are hydrated LAZILY: at startup we fetch none (the tree + live
	// stream are enough). On reconnect we re-fetch only the sessions a client
	// has actually opened, so a project with thousands of sessions doesn't pay
	// thousands of message fetches. Unopened sessions load on first open
	// (EnsureMessages).
	messages := make(map[string][]state.MessageWithParts)
	for _, id := range a.store.LoadedSessions() {
		items, err := a.client.Messages(ctx, id)
		if err != nil {
			log.Printf("[aggregator] messages fetch failed for %s: %v", id, err)
			continue
		}
		messages[id] = decodeMessages(items)
	}
	a.store.Hydrate(sessions, messages)

	// Seed per-session activity (busy/idle/error) so the sidebar shows status
	// for sessions even before any live status event arrives.
	if statuses, err := a.client.SessionStatuses(ctx); err == nil {
		a.store.SetActivityFromStatuses(statuses)
	}

	// Recover questions/permissions still pending an answer. These only arrive
	// via live events otherwise, so without this a daemon restart (or a fresh
	// client) would drop an unanswered question/permission the user must act on.
	if qs, err := a.client.ListQuestions(ctx); err == nil {
		a.store.SetPendingQuestions(qs)
	}
	if ps, err := a.client.ListPermissions(ctx); err == nil {
		a.store.SetPendingPermissions(ps)
	}
	return nil
}
