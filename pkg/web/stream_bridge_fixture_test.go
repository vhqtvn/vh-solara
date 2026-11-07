package web

// stream_bridge_fixture_test.go — slice 2 of the whole-data-flow
// verification pilot (card task-2026-11-07t04-03-03-o12-gots-bridge-ob1-ob2).
//
// THE BRIDGE, GO HALF. This file drives the REAL /vh/stream handler (via
// httptest, against REAL aggregator+state.Store instances) to emit the
// OB1+OB2 scenario matrix, and commits the handler's ACTUAL response bytes
// as fixtures under web/tests/unit/go-bridge-fixtures/ for the TS-side
// consumer (web/tests/unit/session-cursor-bridge.test.ts — the same pilot's
// TS half). Obligation identities (per tmp/agent-runs/formal-verify-fullflow/
// o11-obligation-map.md §4):
//
//   OB1 — the sent cursor= must sit strictly below every undisposed delivery
//         obligation; the server's replay-range selection then serves exactly
//         seq > cursor from the ring (or honestly falls back).
//   OB2 — fallback_reason truthfulness: the branch the server actually took
//         (replay vs fresh, and WHY) is named truthfully on the always-on
//         "stream baseline" journal line (six-way discriminator: the five
//         fresh fallback_reasons epoch_mismatch | compatibility_fallback |
//         stale_cursor_exceeds_head | ring_eviction | cursorless, plus
//         "none" on the replay path; epoch_mismatch is exercised on real
//         bytes by the OB5 K family below).
//
// SERVER TRUTHFULNESS IS ITSELF UNDER TEST: the assertions below pin the
// journal discriminator per scenario (including ≥1 genuine ring_eviction and
// ≥1 compatibility_fallback) AND the OB1 replay-range wire property (every
// replayed message-class frame's globalSeq > cursor, in ring order).
//
// FIXTURE FORMAT — each committed .sse file is:
//
//   : bridge-fixture: <name>
//   : request: <the generator's request URL + cursor source>
//   : journal: <the always-on "stream baseline" line captured via vhlog>
//   : normalizations: <the two documented byte normalizations, see below>
//   <the handler's actual response bytes, verbatim apart from those
//    normalizations, from the first flushed byte to the post-live-tail idle>
//
// DETERMINISM / NORMALIZATIONS (documented, shape-preserving, applied
// identically at capture and at drift-check):
//   1. `retry: <n>` — the handler's per-connection jittered SSE retry hint
//      (sseRetryBaseMs + rand.Intn(sseRetryJitterMs)) is normalized to the
//      deterministic base `retry: 2000`.
//   2. `ep-<24 hex>` — the per-store-lifetime epoch id (state.newEpoch,
//      crypto/rand) is normalized to a deterministic PER-LIFE token:
//      ep-0000000000000000000aaaaa for the FIRST store life of a scenario
//      and ep-0000000000000000000bbbbb for the SECOND (OB5 chain K's
//      epoch-change stores). The mapping is ROLE-based (the scenario's
//      builder assigns the token when it constructs the store), never
//      first-appearance-in-bytes, so distinct store lives NEVER collapse to
//      one token and the double-build determinism receipt holds. An epoch
//      the scenario did not register fails the capture loudly (it would
//      leak crypto/rand bytes into committed fixtures).
//   3. `time=<RFC3339>` — the captured "stream baseline" journal line's
//      vhlog wall-clock timestamp is pinned to time=<normalized>; the line's
//      semantic content (path=, fallback_reason=, and the other key=value
//      discriminator fields) stays verbatim.
// Every scenario is captured TWICE from two freshly-built identical
// store/server instances; the normalized bytes must be byte-identical or the
// generator fails loudly (any residual nondeterminism — e.g. a gzip64
// envelope the epoch regex cannot reach — turns red here, not in CI drift).
//
// DRIFT GUARD — in default mode this test regenerates every fixture in
// memory and compares byte-for-byte against the committed files; ANY drift
// between current handler behavior and the committed fixtures is RED with
// regeneration instructions. Regenerate with:
//
//   VH_BRIDGE_FIXTURE_REGEN=1 go test ./pkg/web/ -run TestStreamBridgeFixture
//
//   VH_BRIDGE_FIXTURE_REGEN_FORCE=1 ... — write even when the committed set
//   is absent/different without diffing (first generation only).
//
// HONEST SCOPE (mirrored in the fixture README): fixtures are captured from
// per-scenario test stores whose ring capacity is a test knob (4 for the
// eviction chain, 1000 elsewhere; the production premise of 4096 is a
// user-supplied settled premise and the discriminator path is
// capacity-independent); the generator's requests omit `dir=` (default
// aggregator — a store-routing parameter that does not change the branch
// selection under test) but DO exercise `epoch=` in the OB5 K family: K1
// carries the store's REAL epoch (a matching handshake must stay replay)
// and K2/K3B carry the DEAD store-A pairing (cursor from A's seq space
// paired with A's epoch against a SECOND store life — the client's real
// reconnect URL shape, forcing the epoch_mismatch branch). The claim this
// file supports is an obligation-preservation OBSERVATION at this revision,
// not production correctness.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// bridgeFixtureDir — committed fixture home, relative to the package dir go
// test runs in (pkg/web). The TS-side consumer resolves the same directory
// from web/tests/unit (see session-cursor-bridge.test.ts).
const bridgeFixtureDir = "../../web/tests/unit/go-bridge-fixtures"

// The three documented normalizations (see file header). The epoch tokens
// are PER-STORE-LIFE and ROLE-based: bridgeEpochTokA is the FIRST store life
// of every scenario (the seven original scenarios each have exactly one —
// this is the token they have always carried), bridgeEpochTokB is the SECOND
// store life of an epoch-change scenario (OB5 chain K).
var (
	bridgeRetryRe   = regexp.MustCompile(`(?m)^retry: \d+$`)
	bridgeEpochRe   = regexp.MustCompile(`ep-[0-9a-f]{24}`)
	bridgeTimeRe    = regexp.MustCompile(`^time=[^ ]+ `)
	bridgeEpochTok  = "ep-0000000000000000000aaaaa"
	bridgeEpoch2Tok = "ep-0000000000000000000bbbbb"
	bridgeRetryTok  = "retry: 2000"
	bridgeTimeTok   = "time=<normalized>"
)

// bridgeNormalizeLife maps each REAL per-store-lifetime epoch id to its
// scenario-assigned deterministic token. `life` is builder-owned (the
// builder holds agg.Store().Epoch() for every store it constructs); an
// epoch missing from the map FAILS the capture — residual crypto/rand bytes
// in committed fixtures would be nondeterminism the drift guard cannot
// tell apart from handler drift.
func bridgeNormalizeLife(t *testing.T, b []byte, life map[string]string) []byte {
	t.Helper()
	out := bridgeRetryRe.ReplaceAll(b, []byte(bridgeRetryTok))
	var unmapped []string
	norm := bridgeEpochRe.ReplaceAllFunc(out, func(m []byte) []byte {
		if tok, ok := life[string(m)]; ok {
			return []byte(tok)
		}
		unmapped = append(unmapped, string(m))
		return m
	})
	if len(unmapped) > 0 {
		t.Fatalf("bridge fixture: unmapped store epoch(s) %v — register every store life of the scenario before capture", unmapped)
	}
	return norm
}

// bridgeLifeA is the single-store-life mapping every original scenario uses.
func bridgeLifeA(t *testing.T, agg *aggregator.Aggregator) map[string]string {
	t.Helper()
	return map[string]string{agg.Store().Epoch(): bridgeEpochTok}
}

// bridgeJournalLine normalizes a captured "stream baseline" journal line:
// trimmed, with the vhlog wall-clock timestamp pinned (the semantic content
// is the key=value discriminator fields, which stay verbatim).
func bridgeJournalLine(line string) string {
	return bridgeTimeRe.ReplaceAllString(strings.TrimSpace(line), bridgeTimeTok+" ")
}

// bridgeSSEFrame is the parsed view the assertions use (id/event/data).
type bridgeSSEFrame struct {
	id    string
	event string
	data  string
}

// bridgeParseFrames parses COMPLETE SSE blocks (event:-bearing only) from
// normalized fixture bytes — the same block-splitting discipline as
// startSSEReader, applied to a static buffer.
func bridgeParseFrames(b []byte) []bridgeSSEFrame {
	var out []bridgeSSEFrame
	for _, block := range strings.Split(string(b), "\n\n") {
		if !strings.Contains(block, "event: ") {
			continue
		}
		var f bridgeSSEFrame
		for _, line := range strings.Split(block, "\n") {
			line = strings.TrimSpace(line)
			switch {
			case strings.HasPrefix(line, "id: "):
				f.id = strings.TrimSpace(line[4:])
			case strings.HasPrefix(line, "event: "):
				f.event = strings.TrimSpace(line[7:])
			case strings.HasPrefix(line, "data: "):
				f.data = line[6:]
			}
		}
		if f.event != "" {
			out = append(out, f)
		}
	}
	return out
}

// bridgeGlobalSeq extracts the store-seq component of a compound SSE id.
func bridgeGlobalSeq(t *testing.T, id string) uint64 {
	t.Helper()
	seq, ok := parseResumeCursor(id)
	if !ok {
		t.Fatalf("frame id %q: no numeric global seq", id)
	}
	return seq
}

func bridgeHasFrame(frames []bridgeSSEFrame, event string) bool {
	for _, f := range frames {
		if f.event == event {
			return true
		}
	}
	return false
}

// bridgeServer builds a per-scenario server + store with a stub "opencode"
// upstream whose every route succeeds with an empty JSON page (so the
// fresh-connect hydration kick deterministically completes ONCE during
// warm-up instead of racing the scripted live-tail applies).
func bridgeServer(t *testing.T, ringCap int) (*Server, *aggregator.Aggregator, *httptest.Server) {
	t.Helper()
	oc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("[]"))
	}))
	t.Cleanup(oc.Close)
	agg := aggregator.New(oc.URL, ringCap)
	srv, err := NewServer(agg, oc.URL, ringCap)
	if err != nil {
		t.Fatal(err)
	}
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)
	return srv, agg, web
}

// bridgeGet opens a stream URL (cursor always via the ?cursor= query param —
// the SPA's manual-reconnect shape; an empty cursor means cursorless). The
// body is registered for close-at-cleanup as leaked-connection hygiene: an
// SSE handler only exits when its client disconnects, so ANY exit path that
// leaves a body open would wedge httptest.Server.Close during t.Cleanup
// (double-Close is harmless).
func bridgeGet(t *testing.T, web *httptest.Server, url string) *http.Response {
	t.Helper()
	resp, err := http.Get(web.URL + url)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("GET %s: status %d", url, resp.StatusCode)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

// bridgeReader — ONE background reader appending the exact flushed bytes
// into its buffer. SSE bodies never EOF, so the ONLY way a read loop ends is
// the body's Close; captures therefore come in two shapes:
//
//	bridgeCaptureRaw  — read-until-idle, then Close the body and collect
//	                    (the connect is DONE after this).
//	phased reader     — for connections that must SURVIVE a scripted live
//	                    tail (R1/E1): start the reader, waitIdle for the
//	                    initial burst, apply the script, waitIdle again for
//	                    the tail, THEN closeAndCollect. Never wrap the body
//	                    in a close-suppressing shim — a reader parked in
//	                    Read on an open body can never be joined (that was
//	                    the first draft's hang).
type bridgeReader struct {
	mu   sync.Mutex
	buf  bytes.Buffer
	done chan struct{}
}

func startBridgeReader(body io.Reader) *bridgeReader {
	r := &bridgeReader{done: make(chan struct{})}
	go func() {
		defer close(r.done)
		tmp := make([]byte, 4096)
		for {
			n, err := body.Read(tmp)
			if n > 0 {
				r.mu.Lock()
				r.buf.Write(tmp[:n])
				r.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	return r
}

func (r *bridgeReader) len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.buf.Len()
}

// waitIdle returns once `idle` has passed with no new bytes (the deadline
// re-arms on growth).
func (r *bridgeReader) waitIdle(idle time.Duration) {
	deadline := time.Now().Add(idle)
	last := -1
	for {
		time.Sleep(15 * time.Millisecond)
		n := r.len()
		if n != last {
			last = n
			deadline = time.Now().Add(idle)
		}
		if time.Now().After(deadline) {
			return
		}
	}
}

// closeAndCollect closes the REAL body (unblocking the reader), joins it,
// and returns the exact flushed bytes.
func (r *bridgeReader) closeAndCollect(t *testing.T, body io.ReadCloser) []byte {
	t.Helper()
	_ = body.Close()
	<-r.done
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]byte, r.buf.Len())
	copy(out, r.buf.Bytes())
	return out
}

// bridgeCaptureRaw reads the raw SSE body until `idle` passes with no new
// bytes (deadline re-arms on activity), then closes and returns the exact
// flushed bytes.
func bridgeCaptureRaw(t *testing.T, body io.ReadCloser, idle time.Duration) []byte {
	t.Helper()
	r := startBridgeReader(body)
	r.waitIdle(idle)
	return r.closeAndCollect(t, body)
}

// bridgeWarmup completes s1's message hydration ONCE (cursorless connect
// whose triggerMessageLoad kick fetches the stub's empty page and marks the
// session loaded) so later fresh connects' triggerMessageLoad is a no-op and
// their captures stay deterministic. The warm-up connection's own bytes are
// discarded. Polls the store's loaded gate until it flips (bounded).
func bridgeWarmup(t *testing.T, agg *aggregator.Aggregator, web *httptest.Server, sid string) {
	t.Helper()
	resp := bridgeGet(t, web, "/vh/stream?sessions="+sid+"&z=1&part_delta=1")
	_ = bridgeCaptureRaw(t, resp.Body, 250*time.Millisecond)
	deadline := time.Now().Add(5 * time.Second)
	for !agg.Store().IsMessagesLoaded(sid) {
		if time.Now().After(deadline) {
			t.Fatalf("warmup: session %s never reached IsMessagesLoaded (stub fetch must succeed)", sid)
		}
		time.Sleep(10 * time.Millisecond)
	}
	// The completion event lands in the ring asynchronously of the gate; one
	// quiet beat makes the ring stable BEFORE the scripted applies.
	time.Sleep(50 * time.Millisecond)
}

// bridgeFixture is one scenario's captured artifact. epochTok is the
// per-life token this file's store maps to (shown in the file's
// normalizations header).
type bridgeFixture struct {
	name     string
	request  string
	journal  string
	raw      []byte // normalized response bytes
	epochTok string
}

func (f *bridgeFixture) fileBytes() []byte {
	tok := f.epochTok
	if tok == "" {
		tok = bridgeEpochTok
	}
	head := fmt.Sprintf(
		": bridge-fixture: %s\n: request: %s\n: journal: %s\n: normalizations: %s -> %s ; %s -> %s ; %s -> %s\n\n",
		f.name, f.request, f.journal, `retry: <jitter>`, bridgeRetryTok, `ep-<24hex>`, tok, `time=<RFC3339>`, bridgeTimeTok,
	)
	return append([]byte(head), f.raw...)
}

func (f *bridgeFixture) frames(t *testing.T) []bridgeSSEFrame {
	t.Helper()
	return bridgeParseFrames(f.raw)
}

// bridgeCapture runs one connect inside the vhlog capture window and returns
// the raw normalized bytes plus the (single) "stream baseline" journal line.
// life is the scenario's epoch→token mapping (see bridgeNormalizeLife).
func bridgeCapture(t *testing.T, web *httptest.Server, url string, life map[string]string) ([]byte, string) {
	t.Helper()
	var raw []byte
	lines := captureBaselines(t, func() {
		resp := bridgeGet(t, web, url)
		raw = bridgeCaptureRaw(t, resp.Body, 350*time.Millisecond)
	})
	line := lastBaselineLine(t, lines, 1)
	return bridgeNormalizeLife(t, raw, life), bridgeJournalLine(line)
}

// ─── scenario scripts ────────────────────────────────────────────────────────
//
// Every builder constructs a FRESH server+store, runs the script, and returns
// its fixtures. The generator runs each builder TWICE and requires identical
// output (determinism receipt).

func bridgeSeedRC(t *testing.T, agg *aggregator.Aggregator, web *httptest.Server) {
	t.Helper()
	store := agg.Store()
	store.Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	store.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"s1","role":"user"}}`))
	bridgeWarmup(t, agg, web, "s1")
}

// bridgeLiveRC applies the scripted post-snapshot live events (ring cap 1000:
// nothing evicts) and returns their seqs.
func bridgeLiveRC(t *testing.T, agg *aggregator.Aggregator) (m2, p1up, appendSeq uint64) {
	t.Helper()
	store := agg.Store()
	m2 = store.Head() + 1
	store.Apply(ev("message.updated", `{"info":{"id":"m2","sessionID":"s1","role":"user"}}`))
	p1up = store.Head() + 1
	store.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"s1","messageID":"m1","type":"text","text":""}}`))
	appendSeq = store.Head() + 1
	store.Apply(ev("message.part.delta", `{"sessionID":"s1","messageID":"m1","partID":"p1","field":"text","delta":"a"}`))
	if store.Head() != appendSeq {
		t.Fatalf("delta flush: head=%d want append seq %d (first-of-burst must flush synchronously)", store.Head(), appendSeq)
	}
	return m2, p1up, appendSeq
}

// bridgeBuildRC — chain R (replay repair) + chain C (compatibility fallback).
// One store instance; three fixtures:
//
//	R1 initial cursorless (snapshot + live tail m2/p1up/append),
//	R2 replay reconnect at cursor=<p1up> (the prefix-remembered claim after
//	   the TS harness delivers only snapshot+m2+p1up, withholding append),
//	C3 legacy (no part_delta) reconnect at cursor=<m2> — §4.3 flip (the TS
//	   harness withholds p1up+append via a shorter prefix).
func bridgeBuildRC(t *testing.T) []bridgeFixture {
	t.Helper()
	_, agg, web := bridgeServer(t, 1000)
	life := bridgeLifeA(t, agg)
	bridgeSeedRC(t, agg, web)

	// R1: cursorless fresh connect; keep it OPEN, land the live tail, capture
	// the whole body (snapshot + live frames) with a PHASED bridgeReader.
	// The CONNECT happens inside the captureBaselines window: the handler
	// writes its baseline line microseconds after the first flush, so a
	// connect outside the window can race the writer swap and lose the line.
	var resp *http.Response
	var rd *bridgeReader
	lines := captureBaselines(t, func() {
		resp = bridgeGet(t, web, "/vh/stream?sessions=s1&z=1&part_delta=1")
		rd = startBridgeReader(resp.Body)
		rd.waitIdle(250 * time.Millisecond)
	})
	var r1raw []byte
	if len(lines) != 1 {
		t.Fatalf("R1: captured %d baseline lines, want 1: %v", len(lines), lines)
	}
	r1journal := bridgeJournalLine(lines[0])
	m2, p1up, _ := bridgeLiveRC(t, agg)
	rd.waitIdle(350 * time.Millisecond)
	r1raw = rd.closeAndCollect(t, resp.Body)

	r2raw, r2journal := bridgeCapture(t, web,
		fmt.Sprintf("/vh/stream?cursor=%d&sessions=s1&z=1&part_delta=1", p1up), life)

	c3raw, c3journal := bridgeCapture(t, web,
		fmt.Sprintf("/vh/stream?cursor=%d&sessions=s1&z=1", m2), life)

	return []bridgeFixture{
		{name: "R1-initial-cursorless.sse",
			request: "GET /vh/stream?sessions=s1&z=1&part_delta=1 (cursorless; live tail scripted post-snapshot)",
			journal: r1journal, raw: bridgeNormalizeLife(t, r1raw, life)},
		{name: "R2-replay-in-range.sse",
			request: fmt.Sprintf("GET /vh/stream?cursor=%d&sessions=s1&z=1&part_delta=1 (cursor = the client's prefix-remembered claim = p1.upsert seq)", p1up),
			journal: r2journal, raw: r2raw},
		{name: "C3-compat-fallback.sse",
			request: fmt.Sprintf("GET /vh/stream?cursor=%d&sessions=s1&z=1 (NO part_delta opt-in — legacy connection)", m2),
			journal: c3journal, raw: c3raw},
	}
}

// bridgeBuildE — chain E (ring eviction + fallback discharge). Ring cap 4:
//
//	E1 initial cursorless (snapshot@head0 + live m2),
//	then 5 further events evict the snapshot's window,
//	E2 reconnect at cursor=<snapshot seq> (the floor-only claim after the
//	harness's prefix-cut withholds the live m2) → journal ring_eviction,
//	fresh snapshot@head that discharges the missed range client-side.
func bridgeBuildE(t *testing.T) []bridgeFixture {
	t.Helper()
	_, agg, web := bridgeServer(t, 4)
	life := bridgeLifeA(t, agg)
	store := agg.Store()
	store.Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	store.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"s1","role":"user"}}`))
	bridgeWarmup(t, agg, web, "s1")
	snapSeq := store.Head()

	var eres *http.Response
	var erd *bridgeReader
	lines := captureBaselines(t, func() {
		eres = bridgeGet(t, web, "/vh/stream?sessions=s1&z=1&part_delta=1")
		erd = startBridgeReader(eres.Body)
		erd.waitIdle(250 * time.Millisecond)
	})
	var e1raw []byte
	if len(lines) != 1 {
		t.Fatalf("E1: captured %d baseline lines, want 1: %v", len(lines), lines)
	}
	e1journal := bridgeJournalLine(lines[0])
	m2seq := store.Head() + 1
	store.Apply(ev("message.updated", `{"info":{"id":"m2","sessionID":"s1","role":"user"}}`))
	_ = m2seq // m2's live frame is asserted via the E1/E2 fixture bytes below
	erd.waitIdle(350 * time.Millisecond)
	e1raw = erd.closeAndCollect(t, eres.Body)

	// Five further events: ring cap 4 retains only the last 4, so the
	// snapshot cursor's +1 window start (m2) falls below the retained floor.
	store.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"s1","messageID":"m1","type":"text","text":""}}`))
	store.Apply(ev("message.part.delta", `{"sessionID":"s1","messageID":"m1","partID":"p1","field":"text","delta":"a"}`))
	store.Apply(ev("message.updated", `{"info":{"id":"m3","sessionID":"s1","role":"user"}}`))
	store.Apply(ev("message.updated", `{"info":{"id":"m4","sessionID":"s1","role":"user"}}`))
	store.Apply(ev("message.updated", `{"info":{"id":"m5","sessionID":"s1","role":"user"}}`))

	e2raw, e2journal := bridgeCapture(t, web,
		fmt.Sprintf("/vh/stream?cursor=%d&sessions=s1&z=1&part_delta=1", snapSeq), life)

	return []bridgeFixture{
		{name: "E1-initial-cursorless.sse",
			request: "GET /vh/stream?sessions=s1&z=1&part_delta=1 (cursorless; live tail m2 post-snapshot)",
			journal: e1journal, raw: bridgeNormalizeLife(t, e1raw, life)},
		{name: "E2-ring-eviction.sse",
			request: fmt.Sprintf("GET /vh/stream?cursor=%d&sessions=s1&z=1&part_delta=1 (cursor = snapshot seq — the floor-only claim after the live tail was missed; 5 later events evicted the window, ring cap 4)", snapSeq),
			journal: e2journal, raw: e2raw},
	}
}

// bridgeBuildS — stale cursor exceeding head (cursor > head after a store
// restart shape). GO-side-only fixture (journal discriminator pin).
func bridgeBuildS(t *testing.T) []bridgeFixture {
	t.Helper()
	_, agg, web := bridgeServer(t, 1000)
	life := bridgeLifeA(t, agg)
	store := agg.Store()
	store.Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	bridgeWarmup(t, agg, web, "s1")
	head := store.Head()

	sraw, sjournal := bridgeCapture(t, web,
		fmt.Sprintf("/vh/stream?cursor=%d&sessions=s1&z=1&part_delta=1", head+50_000), life)

	return []bridgeFixture{
		{name: "S1-stale-cursor-exceeds-head.sse",
			request: fmt.Sprintf("GET /vh/stream?cursor=%d&sessions=s1&z=1&part_delta=1 (cursor > head=%d)", head+50_000, head),
			journal: sjournal, raw: sraw},
	}
}

// bridgeBuildT — the treeEmitter-gated reconnect snapshot pair (obligation
// map S-B): tree=2 replay reconnect emits the replayed delta FIRST, then the
// SnapshotWithTreePartial pair tree.snapshot + snapshot + snapshot.complete.
// GO-side-only fixture (the tree stream is Stream 1; the TS half of this
// bridge drives the session stream only).
func bridgeBuildT(t *testing.T) []bridgeFixture {
	t.Helper()
	_, agg, web := bridgeServer(t, 1000)
	life := bridgeLifeA(t, agg)
	store := agg.Store()
	applyCreate(store, "R", "")
	applyCreate(store, "C1", "R")
	head := store.Head()

	// Throwaway initial tree connect (establishes nothing we assert on).
	resp := bridgeGet(t, web, "/vh/stream?sessions=&tree=2&part_delta=1")
	_ = bridgeCaptureRaw(t, resp.Body, 250*time.Millisecond)

	applyCreate(store, "C2", "R")

	traw, tjournal := bridgeCapture(t, web,
		fmt.Sprintf("/vh/stream?cursor=%d&sessions=&tree=2&part_delta=1", head), life)

	return []bridgeFixture{
		{name: "T1-tree2-replay-reconnect-pair.sse",
			request: fmt.Sprintf("GET /vh/stream?cursor=%d&sessions=&tree=2&part_delta=1 (replay reconnect over the C2 delta)", head),
			journal: tjournal, raw: traw},
	}
}

// bridgeBuildK — chain K (OB5 epoch handshake through the bridge): DISTINCT
// lifetime epochs, real emission, both handshake outcomes. The TS half
// (session-cursor-bridge.test.ts, chain K) pairs these with an epoch-scoped
// obligation oracle. Three fixtures, three store lives:
//
//	K1 epoch-PRESERVED resume — K's own store A (the exact bridgeBuildRC
//	  script), reconnect URL carrying &epoch=<A's REAL epoch> alongside
//	  cursor=<p1up>. A matching handshake must NOT flip the replay branch:
//	  journal stays path=replay fallback_reason=none (the bridge twin of
//	  TestStreamEpoch_MatchValidCursorReplays, on real newEpoch bytes).
//
//	K2 epoch-CHANGE resume (the crux) — a SECOND store life seeded so its
//	  fresh snapshot lands at seq 7 with B-EXCLUSIVE message ids (n1..n3 —
//	  absent from every A-delivered set): the capture URL is the client's
//	  real DEAD-STORE pairing cursor=<A p1up>&epoch=<A's REAL epoch>, which
//	  the handler computes against store B's epoch → mismatch → fresh
//	  snapshot → journal path=fresh fallback_reason=epoch_mismatch
//	  had_cursor=true (the discriminator arm the pilot deferred, now on
//	  real bytes). The high snapshot seq (7 ≥ A's withheld append@7) is the
//	  geometry the pre-OB5 TS oracle false-greened on (cross-epoch floor
//	  discharge); B-exclusive content makes the lie observable.
//
//	K3B epoch-CHANGE low resume — a THIRD store life (a second B role,
//	  token bbbbb) MIRRORING A's seq layout (snapshot@4 + scripted live
//	  tail n1@5, q1up@6), captured for the SAME dead pairing. The TS side
//	  withholds the live tail's last frame so epoch B holds an OPEN
//	  obligation at seq 6 — a seq the dead A-cursor (6) numerically
//	  covers: the K3 perturbation leg's over-claim geometry. (K2 and K3B
//	  need separate stores because the two shapes are geometrically
//	  exclusive: a B snapshot ≥ A's open seq leaves no B obligation ≤ A's
//	  cursor, and vice versa — OB1's cursor<open invariant forces it.)
func bridgeBuildK(t *testing.T) []bridgeFixture {
	t.Helper()

	// Store A — same life shape as bridgeBuildRC (deterministic: same script
	// ⇒ same seqs ⇒ the dead cursor equals the R chain's p1up).
	_, aggA, webA := bridgeServer(t, 1000)
	lifeA := bridgeLifeA(t, aggA)
	bridgeSeedRC(t, aggA, webA)
	_, p1up, _ := bridgeLiveRC(t, aggA)
	if p1up != 6 || aggA.Store().Head() != 7 {
		t.Fatalf("K store A layout drifted: p1up=%d head=%d, want p1up=6 head=7 (must mirror the R chain's seq space)", p1up, aggA.Store().Head())
	}
	realA := aggA.Store().Epoch()

	// K1: the SAME-epoch resume — cursor+epoch PAIRED against store A.
	k1raw, k1journal := bridgeCapture(t, webA,
		fmt.Sprintf("/vh/stream?cursor=%d&sessions=s1&z=1&part_delta=1&epoch=%s", p1up, realA), lifeA)

	// Store B (K2) — the HIGH second life: B-exclusive ids push the snapshot
	// to seq 7 so it numerically covers A's withheld append@7.
	_, aggB, webB := bridgeServer(t, 1000)
	lifeB := map[string]string{aggB.Store().Epoch(): bridgeEpoch2Tok}
	storeB := aggB.Store()
	storeB.Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	storeB.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"s1","role":"user"}}`))
	bridgeWarmup(t, aggB, webB, "s1")
	storeB.Apply(ev("message.updated", `{"info":{"id":"n1","sessionID":"s1","role":"user"}}`))
	storeB.Apply(ev("message.updated", `{"info":{"id":"n2","sessionID":"s1","role":"user"}}`))
	storeB.Apply(ev("message.updated", `{"info":{"id":"n3","sessionID":"s1","role":"user"}}`))
	if storeB.Head() != 7 {
		t.Fatalf("K store B layout drifted: head=%d, want 7 (snapshot must cover A's withheld append@7)", storeB.Head())
	}

	// K2: the DEAD-STORE pairing — A's cursor + A's epoch against store B.
	k2raw, k2journal := bridgeCapture(t, webB,
		fmt.Sprintf("/vh/stream?cursor=%d&sessions=s1&z=1&part_delta=1&epoch=%s", p1up, realA), lifeB)

	// Store C (K3B) — the LOW second life: A's mirrored layout (snapshot@4)
	// plus a scripted live tail on the SAME connection (phased reader).
	_, aggC, webC := bridgeServer(t, 1000)
	lifeC := map[string]string{aggC.Store().Epoch(): bridgeEpoch2Tok}
	storeC := aggC.Store()
	storeC.Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	storeC.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"s1","role":"user"}}`))
	bridgeWarmup(t, aggC, webC, "s1")
	if storeC.Head() != 4 {
		t.Fatalf("K store C layout drifted: head=%d, want 4 (mirrored A layout)", storeC.Head())
	}

	var resp *http.Response
	var rd *bridgeReader
	lines := captureBaselines(t, func() {
		resp = bridgeGet(t, webC,
			fmt.Sprintf("/vh/stream?cursor=%d&sessions=s1&z=1&part_delta=1&epoch=%s", p1up, realA))
		rd = startBridgeReader(resp.Body)
		rd.waitIdle(250 * time.Millisecond)
	})
	if len(lines) != 1 {
		t.Fatalf("K3B: captured %d baseline lines, want 1: %v", len(lines), lines)
	}
	k3journal := bridgeJournalLine(lines[0])
	storeC.Apply(ev("message.updated", `{"info":{"id":"n1","sessionID":"s1","role":"user"}}`))
	storeC.Apply(ev("message.part.updated", `{"part":{"id":"q1","sessionID":"s1","messageID":"n1","type":"text","text":""}}`))
	rd.waitIdle(350 * time.Millisecond)
	k3raw := rd.closeAndCollect(t, resp.Body)

	return []bridgeFixture{
		{name: "K1-epoch-preserved-replay.sse", epochTok: bridgeEpochTok,
			request: fmt.Sprintf("GET /vh/stream?cursor=%d&sessions=s1&z=1&part_delta=1&epoch=%s (cursor+epoch = the client's SAME-store pairing; a matching handshake must stay replay)", p1up, bridgeEpochTok),
			journal: k1journal, raw: k1raw},
		{name: "K2-epoch-change-fresh.sse", epochTok: bridgeEpoch2Tok,
			request: fmt.Sprintf("GET /vh/stream?cursor=%d&sessions=s1&z=1&part_delta=1&epoch=%s (cursor+epoch = the client's DEAD-store pairing; served by a SECOND store life whose epoch differs → epoch_mismatch fresh snapshot@7 with B-exclusive ids n1..n3)", p1up, bridgeEpochTok),
			journal: k2journal, raw: k2raw},
		{name: "K3B-epoch-change-low-live.sse", epochTok: bridgeEpoch2Tok,
			request: fmt.Sprintf("GET /vh/stream?cursor=%d&sessions=s1&z=1&part_delta=1&epoch=%s (the SAME dead pairing against a low second life: epoch_mismatch fresh snapshot@4 + scripted live tail n1@5/q1up@6 — the TS side withholds q1up@6)", p1up, bridgeEpochTok),
			journal: k3journal, raw: bridgeNormalizeLife(t, k3raw, lifeC)},
	}
}

// bridgeManifest is the machine contract the TS half cross-checks.
type bridgeManifest struct {
	GeneratedBy    string             `json:"generatedBy"`
	Normalizations []string           `json:"normalizations"`
	Scenarios      []bridgeScenarioMD `json:"scenarios"`
}

type bridgeScenarioMD struct {
	File              string          `json:"file"`
	Chain             string          `json:"chain"`
	Request           string          `json:"request"`
	Journal           string          `json:"journal"`
	ClientDisposition string          `json:"clientDisposition"`
	Frames            []bridgeFrameMD `json:"frames"`
}

type bridgeFrameMD struct {
	Event string `json:"event"`
	ID    string `json:"id"`
}

const bridgeClientDispositionPrefix = "go-side-only"

func bridgeBuildAll(t *testing.T) ([]bridgeFixture, []byte) {
	t.Helper()
	var fixtures []bridgeFixture
	fixtures = append(fixtures, bridgeBuildRC(t)...)
	fixtures = append(fixtures, bridgeBuildE(t)...)
	fixtures = append(fixtures, bridgeBuildS(t)...)
	fixtures = append(fixtures, bridgeBuildT(t)...)
	fixtures = append(fixtures, bridgeBuildK(t)...)

	dispositions := map[string]string{
		"R1-initial-cursorless.sse":          "fresh-snapshot-applies (floor=snapshot seq); live tail delivered by the TS harness as a PREFIX (tail withheld = real disconnect shape)",
		"R2-replay-in-range.sse":             "replay-repair: every replayed frame's globalSeq > cursor; withheld obligation re-served and applied",
		"C3-compat-fallback.sse":             "legacy fresh-snapshot fallback applies; missed part content arrives via the snapshot (full-text reference)",
		"E1-initial-cursorless.sse":          "fresh-snapshot-applies (floor=snapshot seq); live tail m2 present — the TS harness delivers it as a WITHHELD prefix (floor-only claim)",
		"E2-ring-eviction.sse":               "fallback discharge: fresh snapshot applies (floor=snapshot seq) and DISCHARGES the withheld m2 obligation; the NEXT reconnect claims the snapshot seq",
		"S1-stale-cursor-exceeds-head.sse":   bridgeClientDispositionPrefix + " (journal discriminator pin; not consumed by the TS harness)",
		"T1-tree2-replay-reconnect-pair.sse": bridgeClientDispositionPrefix + " (tree stream / Stream 1; not consumed by the session-stream harness)",
		"K1-epoch-preserved-replay.sse":      "epoch-preserved resume (OB5 K1): the reconnect URL's cursor+epoch PAIRING matches the store — journal stays replay/none; obligations repair within the same epoch",
		"K2-epoch-change-fresh.sse":          "epoch-change crux (OB5 K2): the dead-store cursor+epoch pair forces epoch_mismatch → fresh snapshot with B-exclusive content; obligations re-seed under the NEW epoch; the NEXT reconnect claims B's snapshot seq paired with B's epoch",
		"K3B-epoch-change-low-live.sse":      "epoch-change low resume (OB5 K3): B's live tail leaves an OPEN epoch-B obligation at a seq the dead A-cursor covers — the perturbation leg's over-claim geometry",
	}
	chains := map[string]string{
		"R1-initial-cursorless.sse": "R", "R2-replay-in-range.sse": "R", "C3-compat-fallback.sse": "C",
		"E1-initial-cursorless.sse": "E", "E2-ring-eviction.sse": "E",
		"S1-stale-cursor-exceeds-head.sse": "S", "T1-tree2-replay-reconnect-pair.sse": "T",
		"K1-epoch-preserved-replay.sse": "K", "K2-epoch-change-fresh.sse": "K", "K3B-epoch-change-low-live.sse": "K",
	}
	md := bridgeManifest{
		GeneratedBy: "pkg/web/stream_bridge_fixture_test.go (VH_BRIDGE_FIXTURE_REGEN=1); regenerate after ANY handler behavior change",
		Normalizations: []string{
			"retry: <jitter> -> retry: 2000 (per-connection random SSE retry hint)",
			"ep-<24hex> -> ep-0000000000000000000aaaaa (FIRST store life of a scenario) / ep-0000000000000000000bbbbb (SECOND store life — OB5 epoch-change scenarios); per-store-lifetime crypto/rand epoch ids, ROLE-mapped by the scenario's builder so distinct lives never collapse to one token",
			"time=<RFC3339> -> " + bridgeTimeTok + " (journal-line vhlog wall-clock timestamp; discriminator fields verbatim)",
		},
	}
	for _, f := range fixtures {
		s := bridgeScenarioMD{File: f.name, Chain: chains[f.name], Request: f.request, Journal: f.journal,
			ClientDisposition: dispositions[f.name]}
		for _, fr := range f.frames(t) {
			s.Frames = append(s.Frames, bridgeFrameMD{Event: fr.event, ID: fr.id})
		}
		md.Scenarios = append(md.Scenarios, s)
	}
	mb, err := json.MarshalIndent(md, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return fixtures, append(mb, '\n')
}

// ─── the test: generate, assert truthfulness, compare/write ─────────────────

func TestStreamBridgeFixture(t *testing.T) {
	fixtures, manifest := bridgeBuildAll(t)

	// Server-side truthfulness assertions (OB2 journal discriminator + OB1
	// replay-range wire property). These run in BOTH modes — the committed
	// fixtures and the live handler are held to the same bar.
	byName := map[string]*bridgeFixture{}
	for i := range fixtures {
		byName[fixtures[i].name] = &fixtures[i]
	}
	assertR := func(name, path, reason string) []bridgeSSEFrame {
		f := byName[name]
		if !strings.Contains(f.journal, "path="+path) || !strings.Contains(f.journal, "fallback_reason="+reason) {
			t.Errorf("%s: journal = %q, want path=%s fallback_reason=%s", name, f.journal, path, reason)
		}
		return f.frames(t)
	}

	// R1: fresh + cursorless; the live tail carries m2/p1up/append in ring
	// order with ascending ids.
	r1 := assertR("R1-initial-cursorless.sse", "fresh", "cursorless")
	if !bridgeHasFrame(r1, "snapshot") {
		t.Errorf("R1: no snapshot frame; events=%v", bridgeNames(r1))
	}
	if !bridgeHasFrame(r1, "message.upsert") || !bridgeHasFrame(r1, "part.upsert") || !bridgeHasFrame(r1, "part.append") {
		t.Errorf("R1: live tail must carry message.upsert+part.upsert+part.append; events=%v", bridgeNames(r1))
	}

	// R2: replay, reason none; OB1 — EVERY replayed frame's globalSeq >
	// cursor (the p1.upsert seq), ascending; no snapshot on a non-tree
	// replay.
	r2f := byName["R2-replay-in-range.sse"]
	p1up := bridgeCursorOf(t, r2f.journal)
	r2 := assertR("R2-replay-in-range.sse", "replay", "none")
	if bridgeHasFrame(r2, "snapshot") {
		t.Errorf("R2: non-tree replay must not re-ship a snapshot; events=%v", bridgeNames(r2))
	}
	var last uint64
	for _, fr := range r2 {
		if fr.event == "part.append" || fr.event == "part.upsert" || fr.event == "message.upsert" {
			seq := bridgeGlobalSeq(t, fr.id)
			if seq <= p1up {
				t.Errorf("R2: OB1 violation — replayed %s id=%s covers cursor=%d", fr.event, fr.id, p1up)
			}
			if seq < last {
				t.Errorf("R2: replay order not ascending: %s id=%s after %d", fr.event, fr.id, last)
			}
			last = seq
		}
	}
	if !bridgeHasFrame(r2, "part.append") {
		t.Errorf("R2: opted-in replay must deliver the part.append suffix; events=%v", bridgeNames(r2))
	}

	// C3: fresh + compatibility_fallback + part_append_in_range=true; a
	// snapshot IS served (the legacy catch-up).
	c3f := byName["C3-compat-fallback.sse"]
	if !strings.Contains(c3f.journal, "part_append_in_range=true") {
		t.Errorf("C3: journal = %q, want part_append_in_range=true", c3f.journal)
	}
	c3 := assertR("C3-compat-fallback.sse", "fresh", "compatibility_fallback")
	if !bridgeHasFrame(c3, "snapshot") {
		t.Errorf("C3: compatibility fallback must serve a snapshot; events=%v", bridgeNames(c3))
	}

	// E2: fresh + ring_eviction + had_cursor=true; snapshot served at head.
	e2f := byName["E2-ring-eviction.sse"]
	if !strings.Contains(e2f.journal, "had_cursor=true") {
		t.Errorf("E2: journal = %q, want had_cursor=true", e2f.journal)
	}
	e2 := assertR("E2-ring-eviction.sse", "fresh", "ring_eviction")
	if !bridgeHasFrame(e2, "snapshot") {
		t.Errorf("E2: ring eviction must serve a fresh snapshot; events=%v", bridgeNames(e2))
	}
	for _, fr := range e2 {
		if fr.event == "snapshot" {
			head := bridgeHeadOf(t, e2f.journal)
			if got := bridgeGlobalSeq(t, fr.id); got != head {
				t.Errorf("E2: snapshot id seq=%d want head=%d", got, head)
			}
		}
	}

	// S1: fresh + stale_cursor_exceeds_head.
	assertR("S1-stale-cursor-exceeds-head.sse", "fresh", "stale_cursor_exceeds_head")

	// T1: replay + none; the treeEmitter-gated reconnect snapshot PAIR —
	// tree.snapshot AND snapshot AND snapshot.complete present, after the
	// replayed delta.
	t1 := assertR("T1-tree2-replay-reconnect-pair.sse", "replay", "none")
	if len(t1) == 0 || t1[0].event != "tree.op" {
		t.Errorf("T1: replayed delta (tree.op) must come FIRST; events=%v", bridgeNames(t1))
	}
	if !bridgeHasFrame(t1, "tree.snapshot") || !bridgeHasFrame(t1, "snapshot") || !bridgeHasFrame(t1, "snapshot.complete") {
		t.Errorf("T1: reconnect pair tree.snapshot+snapshot+snapshot.complete must follow the replay; events=%v", bridgeNames(t1))
	}

	// K1 (OB5): a MATCHING epoch handshake must not flip the replay branch —
	// same wire shape as R2 (every replayed message-class frame's globalSeq >
	// cursor, ascending; no snapshot re-ship).
	k1f := byName["K1-epoch-preserved-replay.sse"]
	k1cursor := bridgeCursorOf(t, k1f.journal)
	if k1cursor != 6 {
		t.Errorf("K1: journal cursor=%d, want 6 (the dead-pairing cursor K2/K3B are generated for)", k1cursor)
	}
	k1 := assertR("K1-epoch-preserved-replay.sse", "replay", "none")
	if bridgeHasFrame(k1, "snapshot") {
		t.Errorf("K1: same-epoch replay must not re-ship a snapshot; events=%v", bridgeNames(k1))
	}
	last = 0
	for _, fr := range k1 {
		if fr.event == "part.append" || fr.event == "part.upsert" || fr.event == "message.upsert" {
			seq := bridgeGlobalSeq(t, fr.id)
			if seq <= k1cursor {
				t.Errorf("K1: OB1 violation — replayed %s id=%s covers cursor=%d", fr.event, fr.id, k1cursor)
			}
			if seq < last {
				t.Errorf("K1: replay order not ascending: %s id=%s after %d", fr.event, fr.id, last)
			}
			last = seq
		}
	}
	if !strings.Contains(k1f.request, "&epoch="+bridgeEpochTok) {
		t.Errorf("K1: request line must pin the cursor+epoch PAIRING (epoch=%s): %s", bridgeEpochTok, k1f.request)
	}

	// K2 (OB5): the epoch_mismatch branch on real bytes — the discriminator
	// arm the pilot deferred. Fresh snapshot at head with B-exclusive ids;
	// had_cursor=true; cursor=6 (the dead pairing).
	k2f := byName["K2-epoch-change-fresh.sse"]
	if !strings.Contains(k2f.journal, "had_cursor=true") {
		t.Errorf("K2: journal = %q, want had_cursor=true", k2f.journal)
	}
	if got := bridgeCursorOf(t, k2f.journal); got != 6 {
		t.Errorf("K2: journal cursor=%d, want 6 (the dead A-store cursor)", got)
	}
	k2 := assertR("K2-epoch-change-fresh.sse", "fresh", "epoch_mismatch")
	if !bridgeHasFrame(k2, "snapshot") {
		t.Errorf("K2: epoch_mismatch must serve a fresh snapshot; events=%v", bridgeNames(k2))
	}
	k2head := bridgeHeadOf(t, k2f.journal)
	if k2head < 7 {
		t.Errorf("K2: head=%d, want >= 7 (B's snapshot must numerically cover A's withheld append@7 — the false-green geometry)", k2head)
	}
	for _, fr := range k2 {
		if fr.event == "snapshot" {
			if got := bridgeGlobalSeq(t, fr.id); got != k2head {
				t.Errorf("K2: snapshot id seq=%d want head=%d", got, k2head)
			}
			for _, want := range []string{`"id":"n1"`, `"id":"n2"`, `"id":"n3"`} {
				if !strings.Contains(fr.data, want) {
					t.Errorf("K2: snapshot must carry B-exclusive %s (content witness for the TS oracle); data=%s", want, fr.data)
				}
			}
		}
	}
	if !strings.Contains(k2f.request, "&epoch="+bridgeEpochTok) {
		t.Errorf("K2: request line must pin the DEAD pairing (cursor=6 declared against epoch=%s): %s", bridgeEpochTok, k2f.request)
	}

	// K3B (OB5): same discriminator, LOW second life — snapshot@4 + a
	// scripted live tail (message.upsert@5, part.upsert@6) whose seqs mirror
	// A's, so epoch B's withheld q1up@6 sits at a seq the dead cursor covers.
	k3f := byName["K3B-epoch-change-low-live.sse"]
	k3 := assertR("K3B-epoch-change-low-live.sse", "fresh", "epoch_mismatch")
	if !bridgeHasFrame(k3, "snapshot") || !bridgeHasFrame(k3, "message.upsert") || !bridgeHasFrame(k3, "part.upsert") {
		t.Errorf("K3B: snapshot + live tail message.upsert + part.upsert must all be present; events=%v", bridgeNames(k3))
	}
	var k3snap, k3m, k3p uint64
	for _, fr := range k3 {
		switch fr.event {
		case "snapshot":
			k3snap = bridgeGlobalSeq(t, fr.id)
		case "message.upsert":
			k3m = bridgeGlobalSeq(t, fr.id)
		case "part.upsert":
			k3p = bridgeGlobalSeq(t, fr.id)
		}
	}
	if k3snap != 4 || k3m != 5 || k3p != 6 {
		t.Errorf("K3B: mirrored layout drifted — snapshot@%d message@%d part@%d, want 4/5/6 (the perturbation geometry needs the open obligation at 6)", k3snap, k3m, k3p)
	}
	if !strings.Contains(k3f.request, "&epoch="+bridgeEpochTok) {
		t.Errorf("K3B: request line must pin the DEAD pairing (cursor=6 declared against epoch=%s): %s", bridgeEpochTok, k3f.request)
	}

	// The six-way discriminator is now covered on real bytes: the five fresh
	// fallback_reasons (cursorless, compatibility_fallback,
	// stale_cursor_exceeds_head, ring_eviction, epoch_mismatch) + none.
	seen := map[string]bool{}
	for _, f := range fixtures {
		if m := regexp.MustCompile(`fallback_reason=(\w+)`).FindStringSubmatch(f.journal); m != nil {
			seen[m[1]] = true
		}
	}
	for _, want := range []string{"cursorless", "none", "compatibility_fallback", "ring_eviction", "stale_cursor_exceeds_head", "epoch_mismatch"} {
		if !seen[want] {
			t.Errorf("six-way discriminator: %s not covered across the fixture matrix", want)
		}
	}

	// Determinism receipt: rebuild EVERYTHING from scratch and require
	// byte-identical artifacts (report the first differing byte to make any
	// residual nondeterminism immediately locatable).
	fixtures2, manifest2 := bridgeBuildAll(t)
	if !bytes.Equal(manifest, manifest2) {
		i := bridgeFirstDiff(manifest, manifest2)
		lo, hi := max(0, i-120), min(len(manifest), len(manifest2), i+120)
		t.Fatalf("bridge fixtures: manifest not deterministic across two full builds at byte %d:\n  A: %q\n  B: %q", i,
			manifest[lo:min(i+120, len(manifest))], manifest2[lo:hi])
	}
	if len(fixtures) != len(fixtures2) {
		t.Fatalf("bridge fixtures: build sizes differ (%d vs %d)", len(fixtures), len(fixtures2))
	}
	for i := range fixtures {
		if !bytes.Equal(fixtures[i].fileBytes(), fixtures2[i].fileBytes()) {
			a, b := fixtures[i].fileBytes(), fixtures2[i].fileBytes()
			d := bridgeFirstDiff(a, b)
			t.Errorf("%s: not deterministic across two full builds at byte %d — see the normalizations note in this file's header\n  A: %q\n  B: %q",
				fixtures[i].name, d, a[max(0, d-100):min(d+100, len(a))], b[max(0, d-100):min(d+100, len(b))])
		}
	}

	// Commit or compare.
	dir := bridgeFixtureDir
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		if err == nil || !os.IsNotExist(err) {
			t.Fatalf("fixture dir %s: %v", dir, err)
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	regen := os.Getenv("VH_BRIDGE_FIXTURE_REGEN") == "1"
	force := os.Getenv("VH_BRIDGE_FIXTURE_REGEN_FORCE") == "1"
	if regen || force {
		for _, f := range fixtures {
			if err := os.WriteFile(filepath.Join(dir, f.name), f.fileBytes(), 0o644); err != nil {
				t.Fatalf("write %s: %v", f.name, err)
			}
			t.Logf("regenerated %s", f.name)
		}
		if err := os.WriteFile(filepath.Join(dir, "manifest.json"), manifest, 0o644); err != nil {
			t.Fatalf("write manifest: %v", err)
		}
		t.Logf("regenerated manifest.json (%d scenarios)", len(fixtures))
		return
	}

	// Drift guard: committed artifacts must equal the regenerated ones.
	drift := false
	for _, f := range fixtures {
		committed, err := os.ReadFile(filepath.Join(dir, f.name))
		if err != nil {
			t.Errorf("%s: committed fixture missing (%v) — regenerate with VH_BRIDGE_FIXTURE_REGEN=1", f.name, err)
			drift = true
			continue
		}
		if !bytes.Equal(committed, f.fileBytes()) {
			t.Errorf("%s: DRIFTED from current handler behavior — regenerate with VH_BRIDGE_FIXTURE_REGEN=1 go test ./pkg/web/ -run TestStreamBridgeFixture", f.name)
			drift = true
		}
	}
	committedMD, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Errorf("manifest.json missing (%v) — regenerate with VH_BRIDGE_FIXTURE_REGEN=1", err)
		drift = true
	} else if !bytes.Equal(committedMD, manifest) {
		t.Errorf("manifest.json DRIFTED from current handler behavior — regenerate with VH_BRIDGE_FIXTURE_REGEN=1")
		drift = true
	}
	if drift {
		t.Log("fixture drift detected: the committed go-bridge fixtures no longer match the handler's current emission")
	}
}

// bridgeCursorOf / bridgeHeadOf parse the journal line's cursor=/head= fields
// (vhlog renders key=value pairs).
func bridgeJournalField(t *testing.T, line, key string) uint64 {
	t.Helper()
	re := regexp.MustCompile(key + `=(\d+)`)
	m := re.FindStringSubmatch(line)
	if m == nil {
		t.Fatalf("journal line %q: no %s field", line, key)
	}
	n, err := strconv.ParseUint(m[1], 10, 64)
	if err != nil {
		t.Fatalf("journal %s=%s: %v", key, m[1], err)
	}
	return n
}

func bridgeCursorOf(t *testing.T, line string) uint64 { return bridgeJournalField(t, line, "cursor") }
func bridgeHeadOf(t *testing.T, line string) uint64   { return bridgeJournalField(t, line, "head") }

// bridgeFirstDiff returns the index of the first differing byte (or the
// shorter length when one is a prefix of the other).
func bridgeFirstDiff(a, b []byte) int {
	n := min(len(a), len(b))
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			return i
		}
	}
	return n
}

func bridgeNames(frames []bridgeSSEFrame) []string {
	var out []string
	for _, f := range frames {
		out = append(out, f.event)
	}
	return out
}
