package aggregator

// lifecycle_upstream_down_test.go — oc-death-watch S2 gate: while the daemon
// KNOWS the OpenCode upstream is down (SetUpstreamDownProbe reporting true),
// Run's reconnect and hydrate-retry backoffs jump straight to their caps
// instead of ramping from 1s; with NO predicate installed (external
// --opencode-url mode, bare tests), Run's timing behavior is EXACTLY as
// before the gate — the external-mode regression case.
//
// Seam (mirrors hydrate_retry_test.go): fake the opencode BACKEND, not the
// client. deadUpstreamHandler fails everything fast (connection-refused
// semantics without the dial latency); sessionFailHandler keeps the /event
// SSE healthy while ListSessions 500s forever — the hydrate-clamp case.
// Knobs are PER-INSTANCE (hydrateBackoffMax / reconnectBackoffMax, set
// before Run so the goroutine launch establishes the happens-before edge) —
// the package's documented discipline (see the field docs in aggregator.go),
// NOT package globals.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
)

// deadUpstreamHandler counts /event dials and fails EVERY request fast with
// 502 — the shape a dead port presents (connection refused ≈ immediate
// error; a 502 surfaces identically at Run's decision points without dial
// timeouts).
type deadUpstreamHandler struct {
	eventHits atomic.Int32
}

func (h *deadUpstreamHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/event") {
		h.eventHits.Add(1)
	}
	http.Error(w, "upstream down", http.StatusBadGateway)
}

func (h *deadUpstreamHandler) hits() int32 { return h.eventHits.Load() }

// sessionFailHandler keeps the /event stream healthy (fixtures SSE) while the
// live session list (GET /session, no archived param — exactly what
// ListSessions issues) 500s FOREVER, counting each gated attempt. The
// hydrate-retry loop therefore runs indefinitely against a healthy stream —
// the incident shape the hydrate clamp must quiet.
type sessionFailHandler struct {
	inner       http.Handler
	sessionHits atomic.Int32
}

func (h *sessionFailHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Query().Get("archived") == "" && r.URL.Path == "/session" {
		h.sessionHits.Add(1)
		http.Error(w, "gate: upstream down", http.StatusInternalServerError)
		return
	}
	h.inner.ServeHTTP(w, r)
}

// parkReconcilers + shrink knobs shared by all three cases. Set BEFORE Run
// (happens-before discipline documented on hydrateRetryBase).
func gatedAgg(url string) *Aggregator {
	a := New(url, 100)
	a.statusReconcileInterval = time.Hour
	a.treeReconcileInterval = time.Hour
	return a
}

// TestRunUpstreamDownSkipsReconnectRamp: predicate present + down ⇒ the
// SECOND /event dial arrives within the shrunk cap (~60ms), not after the
// ungated 1s base — and never faster than the cap (the gate caps, it does not
// spin).
func TestRunUpstreamDownSkipsReconnectRamp(t *testing.T) {
	h := &deadUpstreamHandler{}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := gatedAgg(oc.URL)
	agg.reconnectBackoffMax = 60 * time.Millisecond
	agg.hydrateRetryBase = 2 * time.Millisecond
	agg.hydrateBackoffMax = 5 * time.Millisecond
	agg.SetUpstreamDownProbe(func() bool { return true })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runDone := make(chan struct{})
	go func() {
		agg.RunManaged(ctx)
		close(runDone)
	}()

	// First dial lands immediately; the second must land within the cap, not
	// the 1s ungated base. 500ms bounds the window generously (CI jitter on
	// a 60ms cap) while staying far under the 1s the ungated ramp would take.
	deadline := time.Now().Add(500 * time.Millisecond)
	for h.hits() < 2 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	if got := h.hits(); got < 2 {
		t.Fatalf("gated reconnect did not re-dial within 500ms (hits=%d) — the down gate must skip the 1s ramp", got)
	}
	// The gate CAPS the backoff; it must not spin: after 3 dials at a 60ms
	// cap, well over a 1s window would show >15 hits if the clamp were lost
	// and the hydrate micro-backoff were pacing reconnects instead.
	time.Sleep(150 * time.Millisecond)
	if got := h.hits(); got > 12 {
		t.Fatalf("reconnect pacing too hot for a 60ms cap: %d dials — gate must cap, not spin", got)
	}

	cancel()
	select {
	case <-runDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after ctx cancel")
	}
	agg.Stop()
	agg.waitColdSeed()
}

// TestRunWithoutProbeKeepsReconnectRamp: NO predicate (external
// --opencode-url mode) ⇒ behavior identical to pre-gate: the second /event
// dial waits out the full 1s base backoff. Observation window 600ms (>>60ms
// gate pace, <<1s ungated pace) must see EXACTLY one dial. This is the
// external-mode regression case — an operator-managed OpenCode must never
// have its reconnect cadence silently changed by lifecycle knowledge the
// daemon does not have.
func TestRunWithoutProbeKeepsReconnectRamp(t *testing.T) {
	h := &deadUpstreamHandler{}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := gatedAgg(oc.URL)
	agg.hydrateRetryBase = 2 * time.Millisecond
	agg.hydrateBackoffMax = 5 * time.Millisecond
	// Deliberately NO SetUpstreamDownProbe: external-mode shape.

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runDone := make(chan struct{})
	go func() {
		agg.RunManaged(ctx)
		close(runDone)
	}()

	// Wait for the first dial, then hold a 600ms window: ungated, the next
	// reconnect sleeps backoff=1s, so no second dial may arrive.
	deadline := time.Now().Add(2 * time.Second)
	for h.hits() < 1 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	if h.hits() < 1 {
		t.Fatal("Run never dialed the upstream (first connect missing?)")
	}
	time.Sleep(600 * time.Millisecond)
	if got := h.hits(); got != 1 {
		t.Fatalf("external-mode reconnect cadence changed: %d dials in a 600ms window, want exactly 1 (ungated base backoff is 1s)", got)
	}

	cancel()
	select {
	case <-runDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after ctx cancel")
	}
	agg.Stop()
	agg.waitColdSeed()
}

// TestRunUpstreamDownCapsHydrateRetryBackoff: stream healthy, ListSessions
// failing forever, predicate down ⇒ hydrate retries pace at the (shrunk)
// cap — a bounded count of attempts in the window — instead of the dense
// base-paced burst the ungated ramp produces.
func TestRunUpstreamDownCapsHydrateRetryBackoff(t *testing.T) {
	fx := fixtures.New()
	gate := &sessionFailHandler{inner: fx.Handler()}
	oc := httptest.NewServer(gate)
	defer oc.Close()

	agg := gatedAgg(oc.URL)
	agg.hydrateRetryBase = 2 * time.Millisecond
	agg.hydrateBackoffMax = 80 * time.Millisecond
	agg.SetUpstreamDownProbe(func() bool { return true })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runDone := make(chan struct{})
	go func() {
		agg.RunManaged(ctx)
		close(runDone)
	}()

	// 400ms window at an 80ms cap ⇒ ~5-6 attempts. Ungated (2ms base
	// doubling): the first ~7 retries fit inside 250ms (2+4+8+16+32+64+128),
	// i.e. ≥7 — the separation the assertion rides. Allow generous margins
	// both ways for CI jitter: gated must exceed 1 (still retrying — the
	// gate caps, never pauses) and stay ≤ 6 (no base-paced burst).
	deadline := time.Now().Add(2 * time.Second)
	for gate.sessionHits.Load() < 1 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	time.Sleep(400 * time.Millisecond)
	got := gate.sessionHits.Load()
	if got < 2 {
		t.Fatalf("gated hydrate retries stalled: %d attempts in 400ms — the gate caps the backoff, it must not stop retrying", got)
	}
	if got > 6 {
		t.Fatalf("hydrate retry burst too dense for an 80ms cap: %d attempts in 400ms (ungated burst shape)", got)
	}

	cancel()
	select {
	case <-runDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after ctx cancel")
	}
	agg.Stop()
	agg.waitColdSeed()
}
