package e2e

// User-space shaped link — Phase-A1b test infrastructure (measurement only;
// no product change). Answers the one question the A1 loopback baseline could
// not: with a bandwidth-constrained worker uplink (the production-shaped
// shared bottleneck), does the single multiplexed yamux tunnel impose
// cross-project head-of-line blocking on small requests while a bulk stream
// saturates the link — and is that degradation the TUNNEL's fault (fairness)
// or just the LINK's fault (bandwidth)?
//
// Shape: a TCP-level relay (net.Listener) placed IN FRONT of the real
// listener, io.Copy'ing each direction through a shaper:
//
//	token bucket per direction  — shared across ALL connections of the link,
//	                              modeling one full-duplex physical link whose
//	                              up/down channels are independently capped;
//	16 KiB token slices         — a large write acquires tokens slice-by-slice
//	                              so concurrent connections interleave at
//	                              slice granularity (fair-ish sharing) instead
//	                              of one writer monopolizing the bucket;
//	burst-gated one-way delay   — paid ONCE when a direction wakes from
//	                              ≥mpQuietGate of silence, not per Write. A
//	                              real full-duplex link pipelines back-to-back
//	                              writes; a naive per-write sleep over-counts
//	                              RTT for chatty paths (first draft measured
//	                              the tunnel's idle smalls at ~6 delay steps
//	                              vs direct's ~2 — pure shaper artifact that
//	                              drowned the queuing signal this measurement
//	                              exists to see). Effect: each quiet flow pays
//	                              ≈one one-way delay per burst; a direction
//	                              kept busy by bulk streaming pays none extra,
//	                              matching how propagation overlaps streaming
//	                              on a real wire.
//
// Deliberate fidelity limits (documented, accepted): pure user-space — no
// tc/netem, no privileges; no loss, no reordering, no jitter. Loopback TCP
// with huge buffers + no loss UNDER-represents real-link TCP behavior (a lossy
// link would stall the single tunnel TCP connection harder — fast retransmit
// stops ALL yamux streams — so what this rig measures is the QUEUING/scheduling
// component of head-of-line blocking only; the loss component would only make
// the tunnel case relatively worse). Because the RTT is burst-gated rather
// than per-packet, absolute latencies lean loopback-like inside a busy
// direction; the measured CONTRASTS (during/idle per route, tunnel-vs-direct)
// are RTT-invariant either way — a constant RTT added to both idle and during
// would only compress the factors toward 1.0.
//
// Placement (the discriminating design):
//
//	tunnel-throttled: the worker AGENT's WS dial points at a shaped link in
//	                  front of the controller daemon's tunnel endpoint —
//	                  every byte of every yamux stream (all tabs, heartbeats)
//	                  crosses ONE shaped pipe.
//	direct-throttled: the client's "direct" requests go at a shaped link in
//	                  front of the worker's web port with the SAME cap — the
//	                  same slow link, but each request class holds its own TCP
//	                  connection, so the contrast isolates "one multiplexed
//	                  tunnel under saturation" from "same bandwidth, separate
//	                  connections".

import (
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"testing"
	"time"
)

// mpLinkConfig are the shaper knobs. Rates are bytes/sec (bytes, not bits).
type mpLinkConfig struct {
	BytesPerSec int64         // token refill rate, per direction
	BurstBytes  int64         // token bucket depth (idle links may burst this much instantly)
	SliceBytes  int           // max bytes per token acquisition (interleave granularity)
	OneWayDelay time.Duration // one-way propagation, paid once per burst after ≥mpQuietGate of direction silence
}

// mpDefaultLinkConfigs are the two A1b caps. 20 Mbps ≈ a decent remote-office
// link; 5 Mbps ≈ a constrained/throttled uplink. Delay 20 ms one-way per the
// A1b design direction (≈40 ms RTT through a relay).
func mpDefaultLinkConfigs() []struct {
	label string
	cfg   mpLinkConfig
} {
	return []struct {
		label string
		cfg   mpLinkConfig
	}{
		{"cap20", mpLinkConfig{BytesPerSec: 2_500_000, BurstBytes: 64 * 1024, SliceBytes: 16 * 1024, OneWayDelay: 20 * time.Millisecond}},
		{"cap5", mpLinkConfig{BytesPerSec: 625_000, BurstBytes: 64 * 1024, SliceBytes: 16 * 1024, OneWayDelay: 20 * time.Millisecond}},
	}
}

// mpTokenBucket is a blocking, wall-clock-refilled token bucket. take(n)
// returns only after n tokens were consumed; sleep-retry granularity is the
// deficit-derived wait, so concurrent takers converge without busy-spinning.
type mpTokenBucket struct {
	mu     sync.Mutex
	tokens int64
	last   time.Time
	rate   int64 // bytes/sec
	cap    int64
	taken  int64 // total bytes consumed (true wire bytes through this direction)
}

func newMPTokenBucket(rate, burst int64) *mpTokenBucket {
	return &mpTokenBucket{tokens: burst, last: time.Now(), rate: rate, cap: burst}
}

// totalTaken returns the total bytes this bucket has admitted — the TRUE
// wire-byte count for its direction (the Q4c deflate experiment compares
// these totals across VH_TUNNEL_DEFLATE policies; note the recorded rows'
// "bytes" are post-decompression application bytes, not wire bytes).
func (b *mpTokenBucket) totalTaken() int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.taken
}

func (b *mpTokenBucket) take(n int) {
	if n <= 0 {
		return
	}
	for {
		b.mu.Lock()
		now := time.Now()
		if elapsed := now.Sub(b.last); elapsed > 0 {
			b.tokens += int64(elapsed) * b.rate / int64(time.Second)
			if b.tokens > b.cap {
				b.tokens = b.cap
			}
		}
		b.last = now
		if int64(n) <= b.tokens {
			b.tokens -= int64(n)
			b.taken += int64(n)
			b.mu.Unlock()
			return
		}
		deficit := int64(n) - b.tokens
		b.mu.Unlock()
		wait := time.Duration(deficit * int64(time.Second) / b.rate)
		if wait < 200*time.Microsecond {
			wait = 200 * time.Microsecond
		}
		time.Sleep(wait)
	}
}

// mpQuietGate is the direction-silence threshold that re-arms the one-way
// delay: writes spaced closer than this are one "burst" (pipelined on a real
// full-duplex link — no extra propagation per write). It must exceed the
// slowest inter-slice spacing (16 KiB at the 5 Mbps cap ≈ 26 ms) so a
// saturated direction never flap-re-arms mid-stream.
const mpQuietGate = 100 * time.Millisecond

// mpShapedWriter is the shaped write side of one relay direction: after
// ≥mpQuietGate of silence, sleep the one-way delay once (burst start);
// then drain the payload through the shared bucket in SliceBytes slices.
// Single-goroutine per direction by construction (the copy loop) — no lock.
type mpShapedWriter struct {
	dst        net.Conn
	cfg        mpLinkConfig
	bucket     *mpTokenBucket
	lastActive time.Time
}

func (w *mpShapedWriter) Write(p []byte) (int, error) {
	if w.cfg.OneWayDelay > 0 && time.Since(w.lastActive) > mpQuietGate {
		time.Sleep(w.cfg.OneWayDelay)
	}
	off := 0
	for off < len(p) {
		n := len(p) - off
		if n > w.cfg.SliceBytes {
			n = w.cfg.SliceBytes
		}
		w.bucket.take(n)
		wrote, err := w.dst.Write(p[off : off+n])
		off += wrote
		if err != nil {
			w.lastActive = time.Now()
			return off, err
		}
	}
	w.lastActive = time.Now()
	return off, nil
}

// mpShapedLink is a shaped TCP relay listening on a free loopback port and
// forwarding to backend. All accepted connections share the two per-direction
// buckets (one physical link, full duplex, symmetric caps).
type mpShapedLink struct {
	cfg       mpLinkConfig
	backend   string
	ln        net.Listener
	toBackend *mpTokenBucket // client→backend direction, shared by all conns
	toClient  *mpTokenBucket // backend→client direction, shared by all conns

	mu    sync.Mutex
	conns map[net.Conn]struct{}
	done  bool
}

// startMPShapedLink boots the relay and returns it ready to accept.
func startMPShapedLink(cfg mpLinkConfig, backend string) (*mpShapedLink, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("shaped link listen: %w", err)
	}
	l := &mpShapedLink{
		cfg:       cfg,
		backend:   backend,
		ln:        ln,
		toBackend: newMPTokenBucket(cfg.BytesPerSec, cfg.BurstBytes),
		toClient:  newMPTokenBucket(cfg.BytesPerSec, cfg.BurstBytes),
		conns:     make(map[net.Conn]struct{}),
	}
	go l.accept()
	return l, nil
}

// Addr is the relay's dial address (host:port).
func (l *mpShapedLink) Addr() string { return l.ln.Addr().String() }

func (l *mpShapedLink) accept() {
	for {
		c, err := l.ln.Accept()
		if err != nil {
			return // listener closed
		}
		l.mu.Lock()
		if l.done {
			l.mu.Unlock()
			c.Close()
			return
		}
		l.conns[c] = struct{}{}
		l.mu.Unlock()
		go l.serve(c)
	}
}

// mpCopyBuf is the relay copy buffer. Large (256 KiB) so adjacent sender
// writes coalesce into one shaped write wherever the sender outpaces the
// shaped drain (bulk streaming) — shaping stays dominated by the token
// bucket, not by write-boundary artifacts.
//
// mpHideWriteTo exists because io.CopyBuffer prefers src.(io.WriterTo) and
// *net.TCPConn implements WriteTo (its own 32 KiB internal buffering), which
// would silently bypass this buffer. Wrapping the source in a bare
// io.Reader forces the documented 256 KiB buffered path.
const mpCopyBuf = 256 * 1024

type mpHideWriteTo struct{ io.Reader }

// serve relays one client connection to the backend: client→backend shaped by
// the toBackend bucket, backend→client shaped by the toClient bucket (shared
// across all connections of this link).
func (l *mpShapedLink) serve(c net.Conn) {
	defer l.removeConn(c)
	b, err := net.DialTimeout("tcp", l.backend, 5*time.Second)
	if err != nil {
		c.Close()
		return
	}
	toBackend := &mpShapedWriter{dst: b, cfg: l.cfg, bucket: l.toBackend}
	toClient := &mpShapedWriter{dst: c, cfg: l.cfg, bucket: l.toClient}

	go func() {
		_, _ = io.CopyBuffer(toBackend, mpHideWriteTo{c}, make([]byte, mpCopyBuf))
		b.Close()
		c.Close()
	}()
	_, _ = io.CopyBuffer(toClient, mpHideWriteTo{b}, make([]byte, mpCopyBuf))
	b.Close()
	c.Close()
}

func (l *mpShapedLink) removeConn(c net.Conn) {
	l.mu.Lock()
	delete(l.conns, c)
	l.mu.Unlock()
}

// Close stops the listener and tears down tracked client connections. Relay
// goroutines drain on their own (bounded by the closed conns).
func (l *mpShapedLink) Close() {
	l.mu.Lock()
	l.done = true
	for c := range l.conns {
		c.Close()
	}
	l.mu.Unlock()
	l.ln.Close()
}

// --- test: bulk-vs-small + tab burst through the shaped link (Phase A1b) ---

// TestMultiProjectContentionShapedLink is the Phase-A1b lane-3 measurement:
// the same demand shapes as TestMultiProjectContentionBaseline, but with the
// worker uplink bandwidth-capped by an in-process user-space shaper so the
// bulk stream actually SATURATES the shared bottleneck. Scenarios:
//
//  1. bulk-vs-small UNDER CAP (20 Mbps and 5 Mbps, 20 ms one-way delay):
//     while project 0 streams its ~600 KiB bulk session, small requests
//     (/vh/snapshot + a tree open) run against OTHER projects — measured
//     during-bulk vs idle, on the tunnel-throttled route (shaper on the
//     agent↔controller WS leg) vs the direct-throttled route (shaper on the
//     client→worker leg, same cap). The KEY OUTPUT is the per-route
//     during/idle slowdown factor contrast: tunnel degrading much worse than
//     direct ⇒ fairness/head-of-line signal (fork yamux / multi-tunnel
//     options); degrading equally ⇒ pure bandwidth story (compression /
//     snapshots / cursor-replay options).
//  2. 7-project tab burst UNDER CAP (both caps — the cap-scaling contrast is
//     nearly free): tree+session open latencies tunnel vs direct — does the
//     loopback's benign ratio turn pathological under a real link?
//
// Cap-order discipline: cap20 measures direct first; cap5 measures tunnel
// first (order-balanced across caps, mirroring A1's cold/warm split). Each
// cap boots its OWN cluster: fresh fixture, both bulk sessions cold per
// route, shapers per cluster. Pass criteria stay STRUCTURAL (requests
// succeed, correct bytes, test completes) with ONE added structural floor:
// mpAssertShaperFloor proves the shaper actually shaped (a silently bypassed
// shaper fails) — a lower bound on bulk completion, not a perf gate.
// Serial by design; targeted well under 60s.
func TestMultiProjectContentionShapedLink(t *testing.T) {
	rec := newMPRecorder()
	for ci, cap := range mpDefaultLinkConfigs() {
		directFirst := ci%2 == 0
		t.Logf("[shaped %s] booting cluster (rate=%d B/s burst=%d slice=%d delay=%s, directFirst=%v)",
			cap.label, cap.cfg.BytesPerSec, cap.cfg.BurstBytes, cap.cfg.SliceBytes, cap.cfg.OneWayDelay, directFirst)

		m := startMPClusterShaped(t, &cap.cfg)
		dirs := mpBootstrapDirs(t, m.Cluster, 7)

		// Direct-throttled route: shaped link in front of the worker web port.
		webPort, err := portOf(m.WorkerVHURL)
		if err != nil {
			t.Fatalf("shaped %s: worker port: %v", cap.label, err)
		}
		dlink, err := startMPShapedLink(cap.cfg, fmt.Sprintf("127.0.0.1:%d", webPort))
		if err != nil {
			t.Fatalf("shaped %s: direct link: %v", cap.label, err)
		}
		directRoute := mpRoute{name: "direct", base: "http://" + dlink.Addr()}
		tunnelRoute := mpTunnel(m.Cluster)

		// Warmup pass through the REAL measured (shaped) routes: absorbs
		// process-first costs (yamux path, route setup, JSON/gzip warm-up)
		// and proves the shaped substrate works before measuring. Recorded
		// as "warmup" rows, excluded from contrasts.
		mpTabBurst(t, rec, m.Cluster, directRoute, dirs, "warmup", 1)
		mpTabBurst(t, rec, m.Cluster, tunnelRoute, dirs, "warmup", 1)

		routes := []mpRoute{tunnelRoute, directRoute}
		bulkIdx := map[string]int{"tunnel": 1, "direct": 0}
		if directFirst {
			routes = []mpRoute{directRoute, tunnelRoute}
		}
		for _, route := range routes {
			mpTabBurst(t, rec, m.Cluster, route, dirs, cap.label+"-burst", 3)
			mpBulkProbe(t, rec, m.Cluster, route, dirs, bulkIdx[route.name], cap.label)
		}
		mpAssertShaperFloor(t, rec, cap.label, cap.cfg.BytesPerSec)

		// Q4c rail: true wire bytes admitted by each shaped direction. The
		// tunnel leg's totals are the on-the-wire (post-deflate) byte counts
		// the VH_TUNNEL_DEFLATE experiment compares across policies — the
		// recorder rows' bytes are post-decompression application bytes.
		tbW2C, tbC2W := m.tunnelLink.toBackend.totalTaken(), m.tunnelLink.toClient.totalTaken()
		dbW2C, dbC2W := dlink.toBackend.totalTaken(), dlink.toClient.totalTaken()
		t.Logf("[wire %-5s] tunnel leg wire bytes: worker→ctrl=%d ctrl→worker=%d total=%d | direct leg: client→worker=%d worker→client=%d total=%d",
			cap.label, tbW2C, tbC2W, tbW2C+tbC2W, dbW2C, dbC2W, dbW2C+dbC2W)

		dlink.Close()
		m.Close()
	}
	rec.reportShaped(t)
}

// --- DEFER burn (A1b commit review): coarse cap-rate floor ---

// mpShaperFloorFrac is the coarse "the shaper actually shaped" floor: each
// cap's recorded bulk completion must be at least this fraction of
// bulk-bytes/cap-rate, per route. Structural intent, not a perf gate: its
// only job is to fail the test when the shaper is SILENTLY BYPASSED — on the
// unshaped loopback the same ~600 KiB bulk stream completes in ~24 ms (A1
// baseline bulk-during rows: 23.9/26.1 ms) versus floors of ~170 ms @20 Mbps
// and ~680 ms @5 Mbps, so a bypass fails by an order of magnitude, never
// marginally. Why 0.7 and not higher: the true minimum is
// (bytes-burst)/rate (the bucket boots full at BurstBytes) with hydrate ramp
// and burst-gated RTT on top, and measured shaped runs land at only
// ~1.4-1.5× the floor — 0.7 stays generously below the physics while
// remaining far above bypass speed. Deterministic-safe by direction: this is
// a LOWER bound on duration, so a slower/loaded machine only pushes
// completion further above the floor; the green direction cannot flake.
const mpShaperFloorFrac = 0.7

// bulkRowOf returns the recorded bulk row for (label-during, route) — the
// ~600 KiB transfer whose completion time the cap-rate floor checks.
func (r *mpRecorder) bulkRowOf(label, route string) (mpRow, bool) {
	for _, row := range r.rows {
		if row.Scenario == label+"-during" && row.Route == route && row.Class == "bulk" && row.N > 0 {
			return row, true
		}
	}
	return mpRow{}, false
}

// mpAssertShaperFloor checks the cap-rate floor for one cap across both
// routes. A missing bulk row is itself a failure (the floor is unverifiable,
// so a bypass cannot be excluded) — the outcome-gated style of the A1 F5 fix.
func mpAssertShaperFloor(t *testing.T, rec *mpRecorder, label string, bytesPerSec int64) {
	t.Helper()
	for _, route := range []string{"direct", "tunnel"} {
		row, ok := rec.bulkRowOf(label, route)
		if !ok {
			t.Errorf("[shaper-floor %s %s] no bulk row recorded — cap-rate floor unverifiable (shaper bypass cannot be excluded)", label, route)
			continue
		}
		floorMs := mpShaperFloorFrac * float64(row.BytesMean) / float64(bytesPerSec) * 1000
		if row.TotMed < floorMs {
			t.Errorf("[shaper-floor %s %s] bulk completion %.2fms < floor %.2fms (%.2f×bytes/rate, %d bytes @ %d B/s) — the shaper did not shape this route (bypassed?)",
				label, route, row.TotMed, floorMs, mpShaperFloorFrac, row.BytesMean, bytesPerSec)
			continue
		}
		t.Logf("[shaper-floor %s %s] bulk completion %.2fms ≥ floor %.2fms (%.2f×%d bytes @ %d B/s) — shaper active on this route",
			label, route, row.TotMed, floorMs, mpShaperFloorFrac, row.BytesMean, bytesPerSec)
	}
}

// mpA1bVerdictBucket is the report-level (NOT asserted) contrast threshold: a
// tunnel slowdown factor exceeding the direct factor by this much AND by more
// than mpA1bVerdictDeltaMs of absolute median degradation reads as a
// fairness/head-of-line signal rather than a pure bandwidth story. The
// absolute floor keeps sub-millisecond median noise from tripping the label;
// worst-case HOL shows in the tail section regardless. Report hint only —
// the pass criteria stay structural.
const (
	mpA1bVerdictBucket  = 1.5
	mpA1bVerdictDeltaMs = 10.0
)

// reportShaped prints the Phase-A1b final report: the full row table, the
// KEY OUTPUT (during-bulk vs idle slowdown factors per cap/route/class plus
// the tunnel-vs-direct factor contrast), the under-cap 7-project burst
// ratios, and bulk completion times. Honors the VH_MP_SHAPED_OUT dump.
func (r *mpRecorder) reportShaped(t *testing.T) {
	t.Helper()
	t.Logf("=== MULTI-PROJECT SHAPED-LINK CONTENTION (Phase A1b) — %d rows ===", len(r.rows))
	r.printRows(t)

	t.Logf("--- during-bulk vs idle small-request slowdown factors (A1b key output) ---")
	for _, cap := range mpDefaultLinkConfigs() {
		for _, class := range []string{"small", "treeopen"} {
			idleMed, duringMed := map[string]float64{}, map[string]float64{}
			for _, route := range []string{"direct", "tunnel"} {
				idle, ok1 := r.medOf(cap.label+"-base", route, class)
				during, ok2 := r.medOf(cap.label+"-during", route, class)
				if !ok1 || !ok2 {
					continue
				}
				idleMed[route], duringMed[route] = idle, during
				t.Logf("[slowdown %-5s %-6s %-8s] idle=%.2fms during=%.2fms factor=%.1fx",
					cap.label, route, class, idle, during, mpRatio(during, idle))
			}
			if len(idleMed) == 2 && len(duringMed) == 2 {
				fd, ft := mpRatio(duringMed["direct"], idleMed["direct"]), mpRatio(duringMed["tunnel"], idleMed["tunnel"])
				tDelta := duringMed["tunnel"] - idleMed["tunnel"]
				verdict := "equal within noise (bandwidth story → demand-reduction options)"
				if ft > fd*mpA1bVerdictBucket && tDelta > mpA1bVerdictDeltaMs {
					verdict = "tunnel degrades worse (fairness/head-of-line signal → tunnel-fairness options)"
				}
				t.Logf("[contrast %-5s %-8s] tunnel factor=%.1fx (+%.2fms) vs direct factor=%.1fx (+%.2fms) → %s",
					cap.label, class, ft, tDelta, fd, duringMed["direct"]-idleMed["direct"], verdict)
			}
		}
	}

	t.Logf("--- during-bulk TAIL (worst-case small request; where HOL shows first) ---")
	for _, cap := range mpDefaultLinkConfigs() {
		for _, class := range []string{"small", "treeopen"} {
			for _, route := range []string{"direct", "tunnel"} {
				idleMax, ok1 := r.maxOf(cap.label+"-base", route, class)
				duringMax, ok2 := r.maxOf(cap.label+"-during", route, class)
				if !ok1 || !ok2 {
					continue
				}
				t.Logf("[tail %-5s %-6s %-8s] idle_max=%.2fms during_max=%.2fms worst-case added=%.2fms",
					cap.label, route, class, idleMax, duringMax, duringMax-idleMax)
			}
		}
	}

	t.Logf("--- 7-project tab burst under cap: tunnel/direct total-median ratios ---")
	for _, cap := range mpDefaultLinkConfigs() {
		for _, class := range []string{"tree", "session"} {
			d, dok := r.medOf(cap.label+"-burst", "direct", class)
			v, vok := r.medOf(cap.label+"-burst", "tunnel", class)
			if !dok || !vok {
				continue
			}
			t.Logf("[burst %-5s %-7s] tunnel/direct total_med = %.2fx (direct=%.2fms tunnel=%.2fms)",
				cap.label, class, mpRatio(v, d), d, v)
		}
	}

	t.Logf("--- bulk completion times (the ~600 KiB transfer through each route) ---")
	for _, cap := range mpDefaultLinkConfigs() {
		for _, route := range []string{"direct", "tunnel"} {
			if v, ok := r.medOf(cap.label+"-during", route, "bulk"); ok {
				t.Logf("[bulk %-5s %-6s] completion=%.2fms", cap.label, route, v)
			}
		}
	}

	if out := os.Getenv("VH_MP_SHAPED_OUT"); out != "" {
		r.dumpJSON(t, "shaped", out)
	}
}
