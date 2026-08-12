package state

// part_upsert_burst_fixture_test.go — Slice 4A deliverable: the incident-shaped
// fixture that characterizes whether a compaction-sweep burst (many historical
// TOOL parts re-upserted in a short window) measurably delays the completed-
// message settle signal or fills the subscriber queue. This is the
// MEASUREMENT that feeds the slice-4B decision gate (researcher→debate), which
// decides whether slice-4C ingress no-op suppression (O2) is justified or O1
// (no change) stands.
//
// This is a CHARACTERIZATION fixture, not a behavior proof. Slice 4A adds NO
// production behavior change — only the observation probe wired in
// upsertPartLocked. The numbers this fixture reports are the controlled-variant
// evidence for 4B; the real duplicate-composition question (were the 49 incident
// rewrites byte-identical or changed?) is UNKNOWN and CANNOT be resolved by a
// synthetic fixture — it needs real production capture. This fixture
// characterizes CONTROLLED variants (byte-identical vs materially changed) and
// says so plainly.
//
// See docs/ai/wire-protocols/compaction-burst-axis.md §"Slice 4A detail" for the
// spec (telemetry fields + fixture shape + variants).

import (
	"encoding/json"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
)

// Incident-shape constants (from the user's DB reconstruction of the observed
// compaction burst): ~49 TOOL parts / ~226KB total / ~28KB max / ~30
// interleaved message.updated re-persists.
const (
	burstNumHistMessages = 30 // 15 user + 15 assistant pairs
	burstNumToolParts    = 49 // distributed across the 15 assistant messages
	burstMaxPartBytes    = 28 * 1024
	burstTargetTotalKB   = 226
)

// burstVariant names one characterized scenario. The brief lists five:
// byte-identical, materially changed, healthy writer, modestly delayed writer,
// slow writer (overflow). The content axis (identical vs changed) and the
// writer axis (healthy / delayed / slow) combine into the runs below.
type burstVariant struct {
	name       string
	identical  bool          // true = byte-identical rewrites; false = materially changed
	drainDelay time.Duration // 0 = healthy; small = modestly delayed; huge = slow/blocked
	buffer     int           // subscriber channel buffer (256 = production)
	// overflowSweeps, when >0, repeats the 49-part sweep this many times to
	// exceed the subscriber buffer and exercise the 256-event overflow/close
	// path. 0 = a single incident-shaped sweep.
	overflowSweeps int
}

// burstResult is the measured characterization of one variant.
type burstResult struct {
	variant burstVariant

	// Probe-measured burst totals (from PartUpsertBurst, reset immediately
	// before the burst so these reflect ONLY the sweep, not the seed).
	events              uint64
	bytes               uint64
	toolEvents          uint64
	toolBytes           uint64
	identicalEvents     uint64
	identicalBytes      uint64
	changedEvents       uint64
	changedBytes        uint64
	distinctParts       int
	subChanEventsHighWa int64

	// Subscriber-measured (the SSE-write proxy in this deterministic in-process
	// test). completedLatency is the emit→subscriber-delivery gap for the final
	// completed assistant message — the primary settle marker. delivered=false
	// means the completed frame did NOT reach the subscriber via the channel
	// (overflow closed it; the frame is only in the snapshot).
	completedLatency time.Duration
	delivered        bool
	subscriberClosed bool
	subHighWater     int // the subscriber goroutine's own len(ch) max sample
	eventsSeen       int
}

// makeBurstToolPart builds a TOOL part JSON with the given output payload. This
// is the compaction-burst population (type:"tool" with a large state.output).
func makeBurstToolPart(id, sid, mid, output string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{
		"id": id, "sessionID": sid, "messageID": mid,
		"type": "tool", "tool": "bash",
		"state": map[string]any{
			"status": "completed",
			"input":  map[string]any{"command": "cat big.log"},
			"output": output,
		},
	})
	return b
}

// burstPartSizes returns 49 output sizes summing to ~226KB with a 28KB max, so
// the fixture reconstructs the incident's byte volume + max-part shape.
func burstPartSizes() []int {
	sizes := make([]int, burstNumToolParts)
	sizes[0] = burstMaxPartBytes // the 28KB max part
	// Distribute the remaining ~198KB across the other 48 parts (~4125 each).
	remaining := burstTargetTotalKB*1024 - burstMaxPartBytes
	per := remaining / (burstNumToolParts - 1)
	for i := 1; i < burstNumToolParts; i++ {
		sizes[i] = per
	}
	// Add the rounding remainder to part 1 so the total is exact.
	sizes[1] += (burstTargetTotalKB * 1024) - burstMaxPartBytes - per*(burstNumToolParts-1)
	return sizes
}

// burstOutput returns deterministic output content of the given byte length for
// part index i. The content is a repeated marker with the index baked in so two
// parts (or two rewrites) differ by index/rewrite — used for the "materially
// changed" variant.
func burstOutput(i, rewrite, size int) string {
	if size <= 0 {
		return ""
	}
	// A short header that varies by (part index, rewrite) so "changed" rewrites
	// are genuinely different bytes, then padded to size.
	header := strings.Repeat("x", size)
	// Overwrite the first ~24 bytes with a varying marker without changing length.
	marker := []byte(header)
	mk := []byte("p")
	mk = append(mk, byte('0'+i%10))
	mk = append(mk, byte('r'))
	mk = append(mk, byte('0'+rewrite%10), ':')
	for j := 0; j < len(mk) && j < len(marker); j++ {
		marker[j] = mk[j]
	}
	return string(marker)
}

// seedBurstHistory creates the session + 30 historical messages + 49 TOOL parts
// (the pre-compaction authoritative state). Returns the list of (messageID,
// partID) pairs in sweep order plus the seeded part payloads (so the burst can
// re-upsert them byte-identical or build a changed variant).
func seedBurstHistory(s *Store, sid string) (asstMsgIDs, partIDs []string, partsByIndex []json.RawMessage) {
	s.Apply(ev("session.created", `{"info":{"id":"`+sid+`","title":"burst-root"}}`))
	sizes := burstPartSizes()
	// 15 user + 15 assistant pairs. Distribute 49 TOOL parts across the 15
	// assistant messages: first 4 get 4 parts each (16), remaining 11 get 3
	// each (33). 16+33 = 49.
	partIdx := 0
	flushParts := func(asstID string, n int) {
		for k := 0; k < n; k++ {
			pid := "pt_" + asstID + "_" + indexStr(partIdx)
			out := burstOutput(partIdx, 0, sizes[partIdx])
			part := makeBurstToolPart(pid, sid, asstID, out)
			s.Apply(ev("message.part.updated", `{"part":`+string(part)+`}`))
			asstMsgIDs = append(asstMsgIDs, asstID) // track owning message for the sweep
			partIDs = append(partIDs, pid)
			partsByIndex = append(partsByIndex, part)
			partIdx++
		}
	}
	for i := 0; i < 15; i++ {
		uid := "u" + indexStr(i)
		asstID := "a" + indexStr(i)
		s.Apply(ev("message.updated", `{"info":{"id":"`+uid+`","sessionID":"`+sid+`","role":"user"}}`))
		s.Apply(ev("message.updated", `{"info":{"id":"`+asstID+`","sessionID":"`+sid+`","role":"assistant","time":{"completed":`+msNow()+`}}}`))
		n := 3
		if i < 4 {
			n = 4
		}
		flushParts(asstID, n)
	}
	return asstMsgIDs, partIDs, partsByIndex
}

// msNow returns a Unix-ms "completed" timestamp string suitable for inlining in
// message.updated JSON.
func msNow() string {
	return indexStr(int(time.Now().UnixMilli()))
}

// indexStr is a local strconv.Itoa (avoid importing strconv just for this).
func indexStr(i int) string {
	return jsonIntString(i)
}

func jsonIntString(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

// drainSubscriber runs a subscriber goroutine that drains ch with the given
// per-event delay, sampling the channel high-water and recording the completed-
// message emit→delivery latency. It stops when done is closed OR the channel is
// closed. Metrics are written only by this goroutine; the caller reads them
// after the join (done via wg).
type subMetrics struct {
	highWater        int
	eventsSeen       int
	delivered        bool
	closed           bool
	completedLatency time.Duration
}

func drainSubscriber(wg *sync.WaitGroup, ch <-chan ClientEvent, done <-chan struct{},
	finalMsgID string, completedEmitUnixNano *atomic.Int64, completedDeliverUnixNano *atomic.Int64,
	delay time.Duration, m *subMetrics) {
	defer wg.Done()
	for {
		if n := len(ch); n > m.highWater {
			m.highWater = n
		}
		var ev ClientEvent
		var ok bool
		if delay > 0 {
			select {
			case ev, ok = <-ch:
			case <-time.After(delay):
				continue // re-sample high-water, then retry read
			case <-done:
				return
			}
		} else {
			select {
			case ev, ok = <-ch:
			case <-done:
				return
			}
		}
		if !ok {
			m.closed = true
			return
		}
		m.eventsSeen++
		if ev.Kind == KindMessageUpsert && isCompletedAssistant(ev.Payload, finalMsgID) {
			completedDeliverUnixNano.Store(time.Now().UnixNano())
			m.delivered = true
			m.completedLatency = time.Duration(completedDeliverUnixNano.Load() - completedEmitUnixNano.Load())
			return // settle marker observed — done
		}
		if delay > 0 {
			// Simulate a modestly-delayed SSE writer: sleep after draining one
			// event so the burst (driven synchronously on the main goroutine)
			// outpaces the drain and the queue fills.
			select {
			case <-time.After(delay):
			case <-done:
				return
			}
		}
	}
}

// isCompletedAssistant reports whether a KindMessageUpsert payload is the
// completed assistant message with the given id (the settle marker).
func isCompletedAssistant(payload json.RawMessage, wantID string) bool {
	var p struct {
		ID   string `json:"id"`
		Role string `json:"role"`
		Time struct {
			Completed *float64 `json:"completed"`
		} `json:"time"`
	}
	if json.Unmarshal(payload, &p) != nil {
		return false
	}
	return p.ID == wantID && p.Role == "assistant" && p.Time.Completed != nil
}

// runBurstVariant drives one incident-shaped burst variant and returns its
// measured characterization. This is the core of the slice-4A fixture.
func runBurstVariant(t *testing.T, v burstVariant) burstResult {
	t.Helper()
	const sid = "sess"
	const liveMsg = "m_live_settle"
	const livePart = "p_live_settle"

	// Fresh store; 1ns flush interval so every live-suffix delta flushes
	// synchronously (deterministic, like newPartDeltaTelemetryStore).
	s := mustNew(t, withFlushInterval(DefaultConfig(4096), time.Nanosecond))

	// Seed the historical state. Seed calls Observe but we reset the probe
	// immediately before the burst so only the sweep is characterized.
	asstMsgIDs, partIDs, partsByIndex := seedBurstHistory(s, sid)
	if len(partIDs) != burstNumToolParts {
		t.Fatalf("seed produced %d tool parts, want %d", len(partIDs), burstNumToolParts)
	}

	// Create the inflight live assistant message + a text part for the live
	// suffix frames (concurrent with the sweep).
	s.Apply(ev("message.updated", `{"info":{"id":"`+liveMsg+`","sessionID":"`+sid+`","role":"assistant"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"`+livePart+`","sessionID":"`+sid+`","messageID":"`+liveMsg+`","type":"text","text":""}}`))

	// RESET the probe so the burst numbers are clean (the seed's "changed"
	// classifications for new parts do not pollute the sweep characterization).
	diag.ResetForTest()

	// Register the subscriber (production 256 buffer unless the variant
	// overrides it for the overflow path). Use a legacy (non-WantsPartDelta)
	// subscriber so live-suffix frames arrive as full KindPartUpsert — the
	// conservative shape that maximizes per-event bytes (worst case for queue
	// fill).
	interest := Interest{MessageSessions: map[string]bool{sid: true}}
	ch, stop := s.SubscribeWith(v.buffer, interest)
	defer stop()

	var (
		wg                       sync.WaitGroup
		m                        subMetrics
		completedEmitUnixNano    atomic.Int64
		completedDeliverUnixNano atomic.Int64
		done                     = make(chan struct{})
	)
	// For the overflow variant, do NOT drain during the burst (the subscriber
	// is the slow/blocked writer). For all others, start the drain goroutine.
	if v.overflowSweeps == 0 {
		wg.Add(1)
		go drainSubscriber(&wg, ch, done, liveMsg, &completedEmitUnixNano, &completedDeliverUnixNano, v.drainDelay, &m)
	}

	// Drive the burst: per sweep, 49 TOOL-part re-upserts + 30 message.updated
	// re-persists, interleaved with live-suffix part.append deltas on the
	// inflight message (the "concurrent first + continued live suffix frames").
	sweeps := 1
	if v.overflowSweeps > 0 {
		sweeps = v.overflowSweeps
	}
	for sw := 0; sw < sweeps; sw++ {
		for i, pid := range partIDs {
			// Re-upsert the TOOL part: identical bytes, or materially changed.
			var part json.RawMessage
			if v.identical {
				part = partsByIndex[i]
			} else {
				// Changed: same size, different content (rewrite-index marker).
				part = makeBurstToolPart(pid, sid, asstMsgIDs[i], burstOutput(i, sw+1, len(partsByIndex[i])-120))
			}
			s.Apply(ev("message.part.updated", `{"part":`+string(part)+`}`))
			// Interleave a live-suffix delta every few parts.
			if i%3 == 0 {
				applyDelta(s, sid, liveMsg, livePart, "text", "token ")
			}
		}
		// Re-persist the assistant + user messages (the compaction re-write of
		// the message envelopes). Walk the 15 assistant messages + 15 user.
		for i := 0; i < 15; i++ {
			s.Apply(ev("message.updated", `{"info":{"id":"u`+indexStr(i)+`","sessionID":"`+sid+`","role":"user"}}`))
			s.Apply(ev("message.updated", `{"info":{"id":"a`+indexStr(i)+`","sessionID":"`+sid+`","role":"assistant","time":{"completed":`+msNow()+`}}}`))
		}
	}

	// Stamp the emit time, then drive the final completed assistant message
	// (the settle marker). The subscriber records its delivery time; the gap is
	// the emit→SSE-write latency proxy.
	completedEmitUnixNano.Store(time.Now().UnixNano())
	s.Apply(ev("message.updated", `{"info":{"id":"`+liveMsg+`","sessionID":"`+sid+`","role":"assistant","time":{"completed":`+msNow()+`}}}`))

	// Join the subscriber: let it drain the burst backlog + the settle marker.
	// `done` is closed ONLY on a timeout (to unblock the goroutine before the
	// fatal) — closing it eagerly would race the marker read and falsely report
	// "not delivered" even for a healthy writer.
	if v.overflowSweeps == 0 {
		waitWithTimeout(t, &wg, 30*time.Second, done, "drain subscriber")
	} else {
		// Overflow variant: the subscriber was never started; characterize the
		// closed channel directly (drain buffered events + detect close).
		characterizeOverflow(ch, &m)
	}

	// Read the probe snapshot (burst-only numbers, post-reset).
	snap := diag.Snapshot()
	pb := snap.Probes.PartUpsertBurst
	return burstResult{
		variant:             v,
		events:              pb.Events,
		bytes:               pb.Bytes,
		toolEvents:          pb.ToolEvents,
		toolBytes:           pb.ToolBytes,
		identicalEvents:     pb.IdenticalEvents,
		identicalBytes:      pb.IdenticalBytes,
		changedEvents:       pb.ChangedEvents,
		changedBytes:        pb.ChangedBytes,
		distinctParts:       pb.DistinctParts,
		subChanEventsHighWa: pb.SubChanEventsHighWater,
		completedLatency:    m.completedLatency,
		delivered:           m.delivered,
		subscriberClosed:    m.closed,
		subHighWater:        m.highWater,
		eventsSeen:          m.eventsSeen,
	}
}

// characterizeOverflow drains the (overflow-closed) subscriber channel: counts
// the buffered events readable on a closed channel, then confirms the close.
func characterizeOverflow(ch <-chan ClientEvent, m *subMetrics) {
	if n := len(ch); n > m.highWater {
		m.highWater = n
	}
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				m.closed = true
				return
			}
			m.eventsSeen++
		default:
			// Channel not yet closed and empty — but overflow should have
			// closed it. Mark not-closed and return (the variant's assertion
			// will flag this).
			return
		}
	}
}

// waitWithTimeout waits for wg up to timeout, closing done and failing the test
// on a stall so a pathological drain never hangs the suite. `done` is closed
// ONLY on timeout — the normal path joins on the subscriber observing the
// settle marker (closing done eagerly would race that read).
func waitWithTimeout(t *testing.T, wg *sync.WaitGroup, timeout time.Duration, done chan struct{}, what string) {
	t.Helper()
	c := make(chan struct{})
	go func() { wg.Wait(); close(c) }()
	select {
	case <-c:
	case <-time.After(timeout):
		close(done) // unblock the drain goroutine's select before the fatal
		t.Fatalf("%s did not finish within %s", what, timeout)
	}
}

// logBurstResult prints one variant's measured characterization to the test log
// (the closeout report aggregates these).
func logBurstResult(t *testing.T, r burstResult) {
	t.Helper()
	t.Logf("=== %s ===", r.variant.name)
	t.Logf("  probe: events=%d bytes=%d (%.1f KB) | tool events=%d bytes=%d (%.1f KB)",
		r.events, r.bytes, float64(r.bytes)/1024, r.toolEvents, r.toolBytes, float64(r.toolBytes)/1024)
	t.Logf("  identical vs changed: identical events=%d bytes=%d | changed events=%d bytes=%d",
		r.identicalEvents, r.identicalBytes, r.changedEvents, r.changedBytes)
	t.Logf("  distinct parts (probe): %d", r.distinctParts)
	t.Logf("  subscriber: high-water(sub goroutine)=%d | global sub_chan_events_high_water=%d | events_seen=%d | closed=%v",
		r.subHighWater, r.subChanEventsHighWa, r.eventsSeen, r.subscriberClosed)
	if r.delivered {
		t.Logf("  completed-message emit→delivery latency: %v", r.completedLatency)
	} else {
		t.Logf("  completed-message emit→delivery latency: NOT DELIVERED via channel (subscriber closed; frame only in snapshot)")
	}
}

// TestPartUpsertBurst_IncidentFixture is the slice-4A characterization test. It
// runs the five variants the brief names and reports the measured numbers. It
// does NOT assert hard thresholds (this is characterization, not a gate); the
// numbers feed the slice-4B decision. Soft assertions confirm the probe
// mechanics are sound (identical variant → identical count > 0; changed variant
// → changed count dominates; overflow variant → subscriber closed).
func TestPartUpsertBurst_IncidentFixture(t *testing.T) {
	diag.ResetForTest()
	t.Cleanup(diag.ResetForTest)

	variants := []burstVariant{
		{
			name:      "byte-identical + healthy writer (drained, buf 256)",
			identical: true, drainDelay: 0, buffer: 256,
		},
		{
			name:      "materially-changed + healthy writer (drained, buf 256)",
			identical: false, drainDelay: 0, buffer: 256,
		},
		{
			name:      "byte-identical + modestly-delayed writer (2ms/event, buf 256)",
			identical: true, drainDelay: 2 * time.Millisecond, buffer: 256,
		},
		{
			name:      "materially-changed + modestly-delayed writer (2ms/event, buf 256)",
			identical: false, drainDelay: 2 * time.Millisecond, buffer: 256,
		},
		{
			name: "slow/blocked writer — overflow/close path (7x sweep, buf 256, no drain)",
			// 7x49 = 343 authoritative part.upserts > 256 → overflow closes the
			// subscriber. Content is identical (a pure re-persist flood); the
			// point is the queue-mechanic, not the content split.
			identical: true, buffer: 256, overflowSweeps: 7,
		},
	}

	t.Logf("Slice 4A incident-shaped burst fixture: %d variants. Burst shape: %d TOOL parts / ~%dKB total / %dKB max part / %d historical messages.",
		len(variants), burstNumToolParts, burstTargetTotalKB, burstMaxPartBytes/1024, burstNumHistMessages)

	for _, v := range variants {
		v := v
		t.Run(v.name, func(t *testing.T) {
			r := runBurstVariant(t, v)
			logBurstResult(t, r)

			// b-F2 (slice-4A commit-review): fail-visible structural outcomes
			// for the NON-overflow variants. These are the load-bearing settle
			// + queue outcomes the fixture exists to characterize — previously
			// only t.Logf'd (invisible to a pass/fail reader). The overflow
			// variant keeps its own close assertion in the switch below.
			//   (i)   the completed assistant-message marker (settle signal)
			//         was DELIVERED to the subscriber via the channel;
			//   (ii)  the subscriber was NOT closed (no overflow/close fired);
			//   (iii) the subscriber-channel high-water stayed below capacity.
			// No arbitrary latency threshold — only structural outcomes.
			if v.overflowSweeps == 0 {
				if !r.delivered {
					t.Errorf("non-overflow variant: completed settle marker NOT delivered to subscriber (expected channel delivery for a draining subscriber)")
				}
				if r.subscriberClosed {
					t.Errorf("non-overflow variant: subscriber was closed (overflow/close path fired unexpectedly for a draining subscriber)")
				}
				if r.subHighWater >= v.buffer {
					t.Errorf("non-overflow variant: subscriber-channel high-water %d reached capacity %d (queue-fill signature not expected for a draining subscriber)", r.subHighWater, v.buffer)
				}
			}

			// Soft mechanical assertions (the probe is sound):
			switch {
			case v.overflowSweeps > 0:
				// Overflow variant: subscriber MUST have been closed by the
				// 256-event overflow path (the slice-2/4 slow-reader recovery
				// proof, exercised here at incident scale).
				if !r.subscriberClosed {
					t.Errorf("overflow variant: subscriber not closed (expected the 256-event overflow/close path to fire)")
				}
				if r.distinctParts == 0 {
					t.Errorf("overflow variant: probe recorded 0 distinct parts (probe not wired)")
				}
			case v.identical:
				// Identical content: the probe MUST classify the sweep as
				// identical-dominant (the O2-suppression-candidate signal).
				if r.identicalEvents == 0 {
					t.Errorf("identical variant: probe recorded 0 identical events (classification broken)")
				}
				if r.distinctParts == 0 {
					t.Errorf("identical variant: probe recorded 0 distinct parts (probe not wired)")
				}
			default:
				// Changed content: the probe MUST classify the sweep as
				// changed-dominant (O2 would NOT suppress these).
				if r.changedEvents == 0 {
					t.Errorf("changed variant: probe recorded 0 changed events (classification broken)")
				}
				if r.identicalEvents > r.changedEvents {
					t.Errorf("changed variant: identical (%d) > changed (%d) — classification inverted", r.identicalEvents, r.changedEvents)
				}
			}
		})
	}
}
