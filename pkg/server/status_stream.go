package server

// status_stream.go — GET /vh/fleet/stream: the SSE live fleet-status stream
// (Slice 1 of the controller stream/read-state brief,
// tmp/agent-runs/android-push-20260928/stream-readstate-brief.md).
//
// One held connection per client pushes the FULL current rollup JSON body per
// published generation as SSE event `fleet.status` — a current-state stream,
// not a transition log. No deltas, no replay buffer, no Last-Event-ID
// recovery: a reconnect simply receives the current generation. The wire
// shape (retry hint, named events, no ids) mirrors the worker's SSE surface
// (pkg/web/server.go handleStream) per the brief's E13.
//
// Refresh driving: the stream does NOT rely on the notify watcher (it starts
// only with a configured store AND transport and calls the TTL-cached serve
// anyway — conditional, cache-mediated). While subscribers exist, one
// service-owned demand loop ticks ~every 15s through the ordinary
// single-flight serve(), so the rollup keeps refreshing on its own when only
// stream clients exist; a plain GET's refresh satisfies the same demand for
// free.
//
// Safety posture (brief A2): capacity-one coalesced wakeups (bursty
// generations collapse to the latest — a slow client never queues a
// backlog), finite per-frame write deadlines with stalled writers closed, a
// daemon-wide subscriber cap (503 + Retry-After before headers), and no
// network write ever performed under the service lock.

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"time"
)

// Production stream constants. Overridable per-service (lane-1 tests tighten
// the cadences via the fleetStatusService fields set in newFleetStatusService).
const (
	// fleetStreamMaxSubs is the daemon-wide subscriber cap, bootstrapping
	// reservations included: single-operator scale (a phone, a watch bridge,
	// a browser tab or two) — 16 is already generous.
	fleetStreamMaxSubs = 16
	// fleetStreamHeartbeat is the named-ping cadence for otherwise-quiet
	// streams (~15s, matching the worker SSE and the watcher interval).
	fleetStreamHeartbeat = 15 * time.Second
	// fleetStreamDemandInterval is the subscriber-demand refresh cadence:
	// while subscribers exist, one loop calls the ordinary serve() every
	// ~15s. With the default 5s generation TTL each tick lands past expiry
	// and publishes a fresh generation — the steady-state frame cadence the
	// brief budgets for (~one full snapshot per 15s per client).
	fleetStreamDemandInterval = 15 * time.Second
	// fleetStreamWriteBudget is the finite per-frame write/flush deadline,
	// refreshed before every frame; a writer stalled longer than this is
	// closed (the client's EventSource reconnects per the retry hint).
	fleetStreamWriteBudget = 10 * time.Second
)

// fleetStreamSub is one live SSE subscriber: a capacity-one wake channel
// (never closed — subscribers are removed from the registry map instead, so
// a late nonblocking send can never hit a closed channel). Dedup is NOT
// subscriber state: each handler keeps its own local last, seeded by the
// validated bootstrap serve() after registration (see handleFleetStream).
type fleetStreamSub struct {
	wake chan struct{}
}

// streamKnobs returns the (test-overridable) stream cadence snapshot.
// Guarded by mu; both the handler and the demand loop read through here so
// tests can retighten cadences without racing the loop.
func (s *fleetStatusService) streamKnobs() (heartbeat, demand, writeBudget time.Duration, maxSubs int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.streamHeartbeat, s.streamDemandInterval, s.streamWriteBudget, s.streamMaxSubs
}

// subscribeStream admits one subscriber (cap enforced BEFORE any headers are
// committed: over-cap callers get a plain 503). Registering the first
// subscriber also starts the demand refresh loop.
func (s *fleetStatusService) subscribeStream() (*fleetStreamSub, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.subs) >= s.streamMaxSubs {
		return nil, false
	}
	sub := &fleetStreamSub{
		wake: make(chan struct{}, 1),
	}
	s.subs[sub] = struct{}{}
	s.ensureStreamDemandLocked()
	return sub, true
}

// unsubscribeStream removes a subscriber on every handler exit path. Removing
// the LAST subscriber stops the demand refresh loop (its serve() ticks exist
// only for stream clients).
func (s *fleetStatusService) unsubscribeStream(sub *fleetStreamSub) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.subs, sub)
	if len(s.subs) == 0 && s.streamDemandCancel != nil {
		s.streamDemandCancel()
		s.streamDemandCancel = nil
	}
}

// wakeStreamSubscribers nonblocking-sends every subscriber's wake channel
// after a publication (both the normal and the fallback path call this). A
// full channel means coalesce, never disconnect: the pending token
// reconciles the subscriber to the NEWEST state on its next serve(), which
// is the whole point — intermediate generations may be skipped by design.
// Channel sends only (no network I/O) happen under mu.
func (s *fleetStatusService) wakeStreamSubscribers() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for sub := range s.subs {
		select {
		case sub.wake <- struct{}{}:
		default: // already pending: coalesce
		}
	}
}

// streamSubscriberCount reports the live subscriber count (test
// observability, mirroring refreshCount's precedent).
func (s *fleetStatusService) streamSubscriberCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.subs)
}

// streamDemandActive reports whether the demand refresh loop is running
// (test observability).
func (s *fleetStatusService) streamDemandActive() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.streamDemandCancel != nil
}

// ensureStreamDemandLocked starts the single demand refresh loop if it is
// not already running. Caller holds mu.
func (s *fleetStatusService) ensureStreamDemandLocked() {
	if s.streamDemandCancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.streamDemandCancel = cancel
	go s.streamDemandLoop(ctx)
}

// streamDemandLoop keeps the rollup refreshing while stream subscribers
// exist: every demand tick calls the ordinary serve(), whose TTL check and
// single-flight acquisition coalesce everything (a concurrent GET's refresh,
// the notify watcher's ticks when configured — all share one in-flight
// refresh). Daemon shutdown is process exit (the Daemon exposes no stop hook
// today); the loop's own lifetime is first-subscriber → last-subscriber via
// the cancel installed under mu.
func (s *fleetStatusService) streamDemandLoop(ctx context.Context) {
	for {
		_, demand, _, _ := s.streamKnobs()
		if demand <= 0 {
			demand = fleetStreamDemandInterval
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(demand):
			if _, err := s.serve(ctx); err != nil && ctx.Err() == nil {
				// A demand tick that cannot settle (registry churn,
				// acquisition timeout) is logged and retried on the next
				// tick — stream clients keep their last validated snapshot
				// and their heartbeat; the handler's own serve failures
				// are what close a stream. ctx.Canceled is the NORMAL
				// last-subscriber shutdown, not a failure.
				log.Printf("fleet stream: demand refresh did not settle: %v", err)
			}
		}
	}
}

// handleFleetStream serves GET /vh/fleet/stream: one held SSE connection
// pushing the full rollup body per published generation.
//
// Failure posture (brief A2/A5): everything that can fail BEFORE headers
// (capacity, write-deadline support, the bootstrap snapshot) answers a
// plain-text http.Error and releases the subscriber slot. Once 200 is
// committed the stream never emits http.Error text — any terminal failure
// (write error, deadline exceeded, serve failure) simply closes the
// connection and the client's EventSource reconnects (retry: 2000).
func (d *Daemon) handleFleetStream(w http.ResponseWriter, r *http.Request) {
	svc := d.fleetStatusService()
	_, _, writeBudget, _ := svc.streamKnobs()

	// HEAD rides the GET mux pattern (as everywhere); it is a reachability
	// probe, not a stream: answer with the SSE headers and no body, and do
	// NOT consume a subscriber slot (mirrors handleFleetStatus's HEAD
	// branch).
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "private, no-cache, no-transform")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)
		return
	}

	rc := http.NewResponseController(w)

	// Finite write enforcement must be CONFIRMED before headers are
	// committed (the middleware chain must not hide the connection: scs's
	// session wrapper implements Unwrap, so the controller reaches the real
	// connection). If deadlines cannot be enforced, refuse rather than
	// silently lose the bound — an unbounded SSE writer is exactly the
	// stalled-writer hazard this surface must not have. This call is a
	// SUPPORT PROBE only: the deadline it arms can go stale while the
	// bootstrap serve() below waits (a valid slow refresh may take up to
	// RefreshBudget*2+1s), so the committed stream re-arms a fresh budget
	// just before WriteHeader.
	if err := rc.SetWriteDeadline(time.Now().Add(writeBudget)); err != nil {
		http.Error(w, "fleet stream unavailable: streaming write deadlines unsupported by this connection", http.StatusServiceUnavailable)
		return
	}

	// Capacity admission before headers: over-cap gets a plain 503 with a
	// retry hint (single-operator scale — the client backs off and retries).
	sub, ok := svc.subscribeStream()
	if !ok {
		w.Header().Set("Retry-After", "5")
		http.Error(w, "fleet stream at capacity", http.StatusServiceUnavailable)
		return
	}
	defer svc.unsubscribeStream(sub)

	// Bootstrap: a VALIDATED current generation through the ordinary serve()
	// (never a raw registry capture — a published generation can carry
	// obsolete stamps). Failure releases the slot (the defer above) and
	// answers before headers.
	gen, err := svc.serve(r.Context())
	if err != nil {
		// Mirror of the re-arm below: the bootstrap serve() can outlive the
		// admission probe's deadline (bounded churn waits up to
		// RefreshBudget*2+1s), so this pre-header 503 needs a fresh budget —
		// otherwise its write fails on the expired probe deadline and the
		// client sees EOF instead of the documented 503.
		if err := rc.SetWriteDeadline(time.Now().Add(writeBudget)); err != nil {
			http.Error(w, "fleet stream unavailable: streaming write deadlines unsupported by this connection", http.StatusServiceUnavailable)
			return
		}
		http.Error(w, "fleet status unavailable: "+err.Error(), http.StatusServiceUnavailable)
		return
	}

	// Commit 200 + SSE headers. No hop-by-hop Connection header (HTTP/2
	// compatibility); X-Accel-Buffering tells nginx not to buffer. The
	// support probe above may have armed its deadline long before this
	// point (the bootstrap serve can legitimately outlive it), so re-arm a
	// FRESH write budget here: the committed stream — preamble, bootstrap
	// frame, and everything writeFrame later writes — starts with a full
	// budget regardless of how long the bootstrap took.
	if err := rc.SetWriteDeadline(time.Now().Add(writeBudget)); err != nil {
		http.Error(w, "fleet stream unavailable: streaming write deadlines unsupported by this connection", http.StatusServiceUnavailable)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "private, no-cache, no-transform")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	// writeFrame is the ONLY post-commit writer: refresh the write deadline
	// per frame, write the named event, flush. Any error is terminal (the
	// caller returns and the connection closes).
	writeFrame := func(event string, data []byte) error {
		if err := rc.SetWriteDeadline(time.Now().Add(writeBudget)); err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data); err != nil {
			return err
		}
		return rc.Flush()
	}

	// Preamble + bootstrap snapshot. The retry hint arms the client's
	// native reconnect backoff; the bootstrap frame is UNCONDITIONAL (the
	// client holds nothing yet) even when serve() returned the very
	// generation current at registration.
	if _, err := fmt.Fprint(w, "retry: 2000\n\n"); err != nil {
		return
	}
	if err := writeFrame("fleet.status", gen.body); err != nil {
		return
	}
	last := gen

	heartbeat, _, _, _ := svc.streamKnobs()
	hb := time.NewTimer(heartbeat)
	defer hb.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-sub.wake:
			// A publication happened (or a coalesced burst): reconcile to
			// the newest validated state.
		case <-hb.C:
			// Heartbeat tick: reconcile through serve() first so a broken
			// refresh machinery is self-detected (terminal close) and a
			// pending generation is not outrun by the ping cadence; then,
			// only when nothing new was sent, emit the named keepalive.
			// Pings are NOT generation publications (last stays put).
			gen, err = svc.serve(r.Context())
			if err != nil {
				log.Printf("fleet stream: closing after refresh failure: %v", err)
				return
			}
			if gen != last {
				if err := writeFrame("fleet.status", gen.body); err != nil {
					return
				}
				last = gen
			} else if err := writeFrame("ping", []byte("{}")); err != nil {
				return
			}
			hb.Reset(heartbeat)
			continue
		}
		hb.Reset(heartbeat)
		gen, err = svc.serve(r.Context())
		if err != nil {
			// Post-commit terminal failure: close the stream (never append
			// http.Error text into SSE); the client reconnects per retry.
			log.Printf("fleet stream: closing after refresh failure: %v", err)
			return
		}
		if gen == last {
			continue // spurious/coalesced wake already at newest state
		}
		if err := writeFrame("fleet.status", gen.body); err != nil {
			return
		}
		last = gen
	}
}
