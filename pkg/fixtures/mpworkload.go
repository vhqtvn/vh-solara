package fixtures

// Phase A2 sustained multi-project streaming workload — fixture-side controls.
//
// The existing prompt-simulation path (simulatePrompt/streamAssistant) emits
// only 4 small chunks at 180ms intervals: fine for interactive-spec coverage,
// far too little to drive SUSTAINED multi-project demand through a real
// browser. This file adds an opt-in, fixture-only control surface:
//
//	POST /fixture/mp-workload/start    {spec}   → armed run (no emission yet)
//	POST /fixture/mp-workload/release  {run_id} → emission begins
//	GET  /fixture/mp-workload/status   [run=]   → live accounting
//	POST /fixture/mp-workload/stop     {run_id} → cancel mid-run
//	POST /fixture/mp-workload/reset    {run_id} → remove the run's messages
//	POST /fixture/mp-seed              {spec}   → runtime SeedMultiProject opt-in
//
// (All reachable from lane 6 through the web server's /oc/* proxy, exactly
// like the existing /fixture/reset family.)
//
// Contracts the lane-6 spec (web/tests/e2e/multiproject-latency.spec.ts) and
// the lane-1 unit tests (multiproject_test.go) rely on:
//
//   - Determinism: chunk content is a pure function of (project index, run id,
//     tick, chunk size) — same spec + same run id ⇒ byte-identical content and
//     digest on any fixture instance. Timestamps in bookend events are
//     wall-clock (irrelevant to the content digest).
//   - Byte-exact UTF-8 chunks: every chunk is EXACTLY ChunkBytes of valid
//     UTF-8 (marker prefix + rune-safe filler; truncation never splits a
//     rune), so the wire `start` offsets and the browser TextEncoder digests
//     reconcile in bytes.
//   - Start barrier: start() only ARMS a run; nothing is emitted until
//     release(), so pages can finish connecting before demand begins.
//   - Accounting: emitted counts message.part.delta chunks; the fixture-level
//     subscriber overflow (FakeOpenCode.emit's close-on-full channel fanout,
//     bounded capacity) is counted SEPARATELY (emitDroppedTotal, reported as
//     dropped_total and per-run dropped_run) from anything the application
//     layer does. "Delivered" is the consumer's observation (browser frames /
//     store content), not a fixture-side claim.
//   - One active run: a second start while a run is armed/running is a 409,
//     keeping serial-suite semantics deterministic.
//   - Reset is surgical: it removes exactly the messages the run created
//     (fixture store + message.removed emits so the aggregator store drops
//     them too — the same rationale as handleFixtureReset) and never touches
//     the seeded baseline. /fixture/reset is NOT used for mp sessions: the
//     baseline snapshot is taken at New(), so it would classify post-New
//     SeedMultiProject data as "accumulated" and wipe the seed.
//
// MEASUREMENT/TEST infrastructure only — never exercised by the shipped
// binary. Default fixture behavior is unchanged (nothing here runs unless a
// test drives these routes).

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"
)

// MPWorkloadSpec is the JSON body for /fixture/mp-workload/start. One "tick"
// advances EVERY session by one chunk, so all projects stream in lockstep and
// per-event correlation across pages is the tick number (encoded in each
// chunk's marker).
type MPWorkloadSpec struct {
	Projects       int `json:"projects"`         // 1..9 distinct projects (sessions mp<i>_s<session_idx>)
	SessionIdx     int `json:"session_idx"`      // which seeded ordinary session index per project (default 0 = the page-selected one)
	Events         int `json:"events"`           // delta chunks per session (>=1)
	ChunkBytes     int `json:"chunk_bytes"`      // EXACT UTF-8 bytes per chunk (>=32)
	BulkProject    int `json:"bulk_project"`     // -1 = none, else project index using BulkChunkBytes
	BulkChunkBytes int `json:"bulk_chunk_bytes"` // EXACT UTF-8 bytes per chunk for the bulk project (>=32)
	CadenceMs      int `json:"cadence_ms"`       // 1..1000; one tick per cadence
}

// mpWorkloadExpected is the per-session contract computed at start() time —
// the final content the run will stream, exposed so the spec can gate on
// byte-exact digests without reconstructing content client-side.
type mpWorkloadExpected struct {
	SID        string `json:"sid"`
	MessageID  string `json:"message_id"`
	PartID     string `json:"part_id"`
	Events     int    `json:"events"`
	ChunkBytes int    `json:"chunk_bytes"`
	FinalLen   int    `json:"final_len"`
	Digest     string `json:"digest"` // sha256 hex of the accumulated final text

	finalText string
}

// mpWorkloadRun is one armed/running/finished workload run.
type mpWorkloadRun struct {
	id          uint64
	spec        MPWorkloadSpec
	perSession  []mpWorkloadExpected
	state       string // armed | running | done | cancelled | reset
	emitted     int64  // atomic: message.part.delta chunks emitted
	bookends    int64  // atomic: message/part bookend events emitted
	droppedBase uint64 // emitDroppedTotal snapshot at start
	startedAt   time.Time
	finishedAt  time.Time
	barrier     chan struct{}
	cancel      chan struct{}
	done        chan struct{}
}

const (
	mpWorkloadMinChunk = 32
	mpWorkloadMaxChunk = 256 * 1024
)

// mpWorkloadMarker returns the deterministic per-chunk ASCII marker
// "[p<proj>r<run>c<tick>]" (tick zero-padded to 6). The run id makes markers
// unique across runs, so a serial suite rerunning against a live fixtureserver
// never confuses a stale prior-run marker with current progress.
func mpWorkloadMarker(proj, run int, tick int) string {
	return fmt.Sprintf("[p%dr%dc%06d]", proj, run, tick)
}

// mpWorkloadFiller returns EXACTLY n bytes of deterministic, markdown-inert
// UTF-8 filler. 3-byte runes (≡ ≈ ≥) fill the body; a 1- or 2-byte tail (x /
// ·) lands the byte count exactly without ever splitting a rune. No
// markdown-active characters, no whitespace — so the rendered textContent is
// byte-identical to the raw part text and DOM-side digests reconcile.
func mpWorkloadFiller(seed, n int) string {
	if n <= 0 {
		return ""
	}
	runes := []rune{'≡', '≈', '≥'}
	out := make([]rune, 0, n/3+2)
	for rem := n; rem > 0; {
		switch {
		case rem >= 3:
			out = append(out, runes[(seed+rem)%3])
			rem -= 3
		case rem == 2:
			out = append(out, '·') // U+00B7, 2 bytes
			rem -= 2
		default:
			out = append(out, 'x')
			rem--
		}
	}
	return string(out)
}

// mpWorkloadChunk builds the deterministic chunk for (project, run, tick) with
// EXACTLY n bytes: ASCII marker + rune-safe filler.
func mpWorkloadChunk(proj, run, tick, n int) string {
	if n <= 0 {
		return ""
	}
	m := mpWorkloadMarker(proj, run, tick)
	if len(m) >= n {
		return m[:n] // ASCII-only truncation stays rune-safe
	}
	return m + mpWorkloadFiller(proj+run+tick, n-len(m))
}

// mpWorkloadValidate clamps + validates a spec and resolves target sessions.
// Returns the resolved per-session slice or the missing session ids.
func (f *FakeOpenCode) mpWorkloadValidate(spec *MPWorkloadSpec) ([]mpWorkloadExpected, []string) {
	if spec.Projects < 1 {
		spec.Projects = 1
	}
	if spec.Projects > 9 {
		spec.Projects = 9
	}
	if spec.SessionIdx < 0 {
		spec.SessionIdx = 0
	}
	if spec.Events < 1 {
		spec.Events = 1
	}
	if spec.Events > 20_000 {
		spec.Events = 20_000
	}
	if spec.ChunkBytes < mpWorkloadMinChunk {
		spec.ChunkBytes = mpWorkloadMinChunk
	}
	if spec.ChunkBytes > mpWorkloadMaxChunk {
		spec.ChunkBytes = mpWorkloadMaxChunk
	}
	if spec.BulkProject >= spec.Projects {
		spec.BulkProject = -1
	}
	if spec.BulkProject >= 0 {
		if spec.BulkChunkBytes < mpWorkloadMinChunk {
			spec.BulkChunkBytes = mpWorkloadMinChunk
		}
		if spec.BulkChunkBytes > mpWorkloadMaxChunk {
			spec.BulkChunkBytes = mpWorkloadMaxChunk
		}
	}
	if spec.CadenceMs < 1 {
		spec.CadenceMs = 1
	}
	if spec.CadenceMs > 1000 {
		spec.CadenceMs = 1000
	}

	// Resolve + validate every target session BEFORE building content: a run
	// must never half-start against an unseeded project.
	f.mu.Lock()
	have := make(map[string]bool, len(f.sessions))
	for _, s := range f.sessions {
		if id, _ := s["id"].(string); id != "" {
			have[id] = true
		}
	}
	f.mu.Unlock()

	var missing []string
	out := make([]mpWorkloadExpected, 0, spec.Projects)
	for i := 0; i < spec.Projects; i++ {
		sid := fmt.Sprintf("mp%d_s%d", i, spec.SessionIdx)
		if !have[sid] {
			missing = append(missing, sid)
			continue
		}
		chunk := spec.ChunkBytes
		if spec.BulkProject == i {
			chunk = spec.BulkChunkBytes
		}
		out = append(out, mpWorkloadExpected{
			SID:        sid,
			MessageID:  fmt.Sprintf("%s_w%d", sid, 0), // run id substituted below
			PartID:     fmt.Sprintf("%s_w%d_p1", sid, 0),
			Events:     spec.Events,
			ChunkBytes: chunk,
		})
	}
	return out, missing
}

// mpWorkloadBuildFinal fills each expected entry's final text + digest for the
// given run id (pure function of spec+run; called with the run id assigned).
func mpWorkloadBuildFinal(per []mpWorkloadExpected, run uint64) {
	for i := range per {
		e := &per[i]
		e.MessageID = fmt.Sprintf("%s_w%d", e.SID, run)
		e.PartID = fmt.Sprintf("%s_w%d_p1", e.SID, run)
		var b []byte
		for t := 1; t <= e.Events; t++ {
			b = append(b, mpWorkloadChunk(i, int(run), t, e.ChunkBytes)...)
		}
		e.FinalLen = len(b)
		sum := sha256.Sum256(b)
		e.Digest = hex.EncodeToString(sum[:])
		e.finalText = string(b)
	}
}

// mpWorkloadState strings.
const (
	mpStateArmed     = "armed"
	mpStateRunning   = "running"
	mpStateDone      = "done"
	mpStateCancelled = "cancelled"
	mpStateReset     = "reset"
)

// mpWorkloadSnapshot is the status view (also the start response body).
type mpWorkloadSnapshot struct {
	RunID        uint64               `json:"run_id"`
	State        string               `json:"state"`
	Spec         MPWorkloadSpec       `json:"spec"`
	Emitted      int64                `json:"emitted"`
	Bookends     int64                `json:"bookends"`
	DroppedRun   uint64               `json:"dropped_run"`
	DroppedTotal uint64               `json:"dropped_total"`
	ElapsedMs    int64                `json:"elapsed_ms,omitempty"`
	Expected     []mpWorkloadExpected `json:"expected"`
}

func (f *FakeOpenCode) mpWorkloadSnapshotLocked(r *mpWorkloadRun) mpWorkloadSnapshot {
	sn := mpWorkloadSnapshot{
		RunID:        r.id,
		State:        r.state,
		Spec:         r.spec,
		Emitted:      atomic.LoadInt64(&r.emitted),
		Bookends:     atomic.LoadInt64(&r.bookends),
		DroppedTotal: atomic.LoadUint64(&f.emitDroppedTotal),
		Expected:     r.perSession,
	}
	sn.DroppedRun = sn.DroppedTotal - r.droppedBase
	if !r.startedAt.IsZero() {
		end := r.finishedAt
		if end.IsZero() {
			end = time.Now()
		}
		sn.ElapsedMs = end.Sub(r.startedAt).Milliseconds()
	}
	// Final texts are kilobytes-to-megabytes; the status view exposes lengths +
	// digests only (the e2e reconstructs nothing — it digests what the DOM
	// shows and compares). COPY first: Expected shares r.perSession's backing
	// array, and clearing finalText in place would wipe the run's own copy the
	// emitter needs for the final authoritative part.
	exp := make([]mpWorkloadExpected, len(r.perSession))
	copy(exp, r.perSession)
	for i := range exp {
		exp[i].finalText = ""
	}
	sn.Expected = exp
	return sn
}

// handleMPWorkloadStart arms a run: validate, resolve sessions, precompute the
// deterministic expected content, launch the (barrier-blocked) emitter.
func (f *FakeOpenCode) handleMPWorkloadStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var spec MPWorkloadSpec
	if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	per, missing := f.mpWorkloadValidate(&spec)
	if len(missing) > 0 {
		w.WriteHeader(http.StatusBadRequest)
		writeJSON(w, map[string]any{"error": "sessions not seeded (call /fixture/mp-seed first)", "missing": missing})
		return
	}

	f.mpWLmu.Lock()
	if f.mpActiveID != 0 {
		active := f.mpRuns[f.mpActiveID]
		if active != nil && (active.state == mpStateArmed || active.state == mpStateRunning) {
			id := f.mpActiveID
			st := active.state
			f.mpWLmu.Unlock()
			w.WriteHeader(http.StatusConflict)
			writeJSON(w, map[string]any{"error": "a workload run is already active", "active_run_id": id, "active_state": st})
			return
		}
		f.mpActiveID = 0
	}
	f.mpRunSeq++
	run := &mpWorkloadRun{
		id:          f.mpRunSeq,
		spec:        spec,
		perSession:  per,
		state:       mpStateArmed,
		droppedBase: atomic.LoadUint64(&f.emitDroppedTotal),
		barrier:     make(chan struct{}),
		cancel:      make(chan struct{}),
		done:        make(chan struct{}),
	}
	mpWorkloadBuildFinal(run.perSession, run.id)
	f.mpRuns[run.id] = run
	f.mpActiveID = run.id
	f.mpWLmu.Unlock()

	go f.mpWorkloadRunLoop(run)
	writeJSON(w, f.mpWorkloadSnapshot(run))
}

// mpRunByID resolves a run from the request: the ?run= query parameter or a
// JSON body {"run_id":N} (the lane-6 spec posts bodies; the lane-1 helpers
// use the query). Default (neither present) = most recent run. Returns nil
// after writing the error response when absent/unparsable.
func (f *FakeOpenCode) mpRunByID(w http.ResponseWriter, r *http.Request) *mpWorkloadRun {
	id := uint64(0)
	explicit := false
	if q := r.URL.Query().Get("run"); q != "" {
		n, err := strconv.ParseUint(q, 10, 64)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			writeJSON(w, map[string]any{"error": "unparsable run id", "run": q})
			return nil
		}
		id, explicit = n, true
	} else {
		var body struct {
			RunID uint64 `json:"run_id"`
		}
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body) // absent/empty body → zero
		}
		if body.RunID != 0 {
			id, explicit = body.RunID, true
		}
	}
	f.mpWLmu.Lock()
	defer f.mpWLmu.Unlock()
	if !explicit {
		id = f.mpRunSeq // most recent
	}
	run := f.mpRuns[id]
	if run == nil {
		w.WriteHeader(http.StatusNotFound)
		writeJSON(w, map[string]any{"error": "unknown run", "run_id": id})
		return nil
	}
	return run
}

func (f *FakeOpenCode) mpWorkloadSnapshot(r *mpWorkloadRun) mpWorkloadSnapshot {
	f.mpWLmu.Lock()
	defer f.mpWLmu.Unlock()
	return f.mpWorkloadSnapshotLocked(r)
}

func (f *FakeOpenCode) handleMPWorkloadStatus(w http.ResponseWriter, r *http.Request) {
	run := f.mpRunByID(w, r)
	if run == nil {
		return
	}
	writeJSON(w, f.mpWorkloadSnapshot(run))
}

// handleMPWorkloadRelease opens the start barrier; emission begins.
func (f *FakeOpenCode) handleMPWorkloadRelease(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	run := f.mpRunByID(w, r)
	if run == nil {
		return
	}
	f.mpWLmu.Lock()
	state := run.state
	if state == mpStateArmed {
		// Flip state under the lock, then close the barrier outside it — a
		// concurrent second release observes running and takes the idempotent
		// no-op branch, so the barrier channel is closed exactly once (the
		// close-of-closed-channel panic window the commit review flagged).
		run.state = mpStateRunning
		run.startedAt = time.Now()
	}
	f.mpWLmu.Unlock()
	if state == mpStateArmed {
		close(run.barrier)
	}
	writeJSON(w, f.mpWorkloadSnapshot(run))
}

// handleMPWorkloadStop cancels a run (idempotent; waits briefly for the
// emitter goroutine to drain out of its tick loop).
func (f *FakeOpenCode) handleMPWorkloadStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	run := f.mpRunByID(w, r)
	if run == nil {
		return
	}
	f.mpWLmu.Lock()
	state := run.state
	f.mpWLmu.Unlock()
	if state == mpStateArmed || state == mpStateRunning {
		select {
		case <-run.cancel:
		default:
			close(run.cancel)
		}
		select {
		case <-run.done:
		case <-time.After(2 * time.Second):
		}
	}
	writeJSON(w, f.mpWorkloadSnapshot(run))
}

// handleMPWorkloadReset removes exactly the messages this run created: from
// the fixture's message store AND (via message.removed, the same aggregator
// -store-clear rationale as handleFixtureReset) from the aggregator store.
// Does not touch the seeded baseline or any other run's messages.
func (f *FakeOpenCode) handleMPWorkloadReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	run := f.mpRunByID(w, r)
	if run == nil {
		return
	}
	// Make sure the emitter is finished before mutating the transcript: a
	// still-armed/running run is cancelled first (an armed run's emitter would
	// otherwise park on the barrier forever — the goroutine leak the commit
	// review flagged), then we wait for it to drain out of its tick loop.
	f.mpWLmu.Lock()
	st := run.state
	f.mpWLmu.Unlock()
	if st == mpStateArmed || st == mpStateRunning {
		select {
		case <-run.cancel:
		default:
			close(run.cancel)
		}
	}
	select {
	case <-run.done:
	case <-time.After(2 * time.Second):
	}
	removed := 0
	for i := range run.perSession {
		e := &run.perSession[i]
		f.mu.Lock()
		msgs := f.messages[e.SID]
		kept := msgs[:0]
		gone := false
		for _, m := range msgs {
			if id, _ := m.Info["id"].(string); id == e.MessageID {
				gone = true
				continue
			}
			kept = append(kept, m)
		}
		if gone {
			if len(kept) == 0 {
				delete(f.messages, e.SID)
			} else {
				f.messages[e.SID] = kept
			}
			removed++
		}
		f.mu.Unlock()
		if gone {
			f.emit("message.removed", map[string]any{"sessionID": e.SID, "messageID": e.MessageID})
		}
	}
	f.mpWLmu.Lock()
	run.state = mpStateReset
	run.finishedAt = time.Now()
	if f.mpActiveID == run.id {
		f.mpActiveID = 0
	}
	f.mpWLmu.Unlock()
	sn := f.mpWorkloadSnapshot(run)
	writeJSON(w, map[string]any{"run_id": sn.RunID, "state": sn.State, "removed_messages": removed, "emitted": sn.Emitted, "dropped_run": sn.DroppedRun})
}

// mpWorkloadRunLoop is the emitter: blocked at the barrier until release, then
// per tick one message.part.delta per session, then final authoritative
// bookends + persistence. Deterministic content; wall-clock timestamps only in
// bookend event metadata (never in the streamed text).
func (f *FakeOpenCode) mpWorkloadRunLoop(run *mpWorkloadRun) {
	defer f.mpWorkloadFinish(run)
	select {
	case <-run.barrier:
	case <-run.cancel:
		return
	}
	now := func() float64 { return float64(time.Now().UnixMilli()) }

	// Opening bookends: assistant message row + empty streaming part (mirrors
	// streamAssistant's shape — the SPA/store create the row from these).
	for i := range run.perSession {
		e := &run.perSession[i]
		f.emit("message.updated", map[string]any{"info": map[string]any{
			"id": e.MessageID, "sessionID": e.SID, "role": "assistant",
			"time": map[string]any{"created": now()},
		}})
		f.emit("message.part.updated", map[string]any{"part": map[string]any{
			"id": e.PartID, "sessionID": e.SID, "messageID": e.MessageID, "type": "text",
			"text": "", "time": map[string]any{"start": now()},
		}})
	}
	atomic.AddInt64(&run.bookends, int64(2*len(run.perSession)))

	ticker := time.NewTicker(time.Duration(run.spec.CadenceMs) * time.Millisecond)
	defer ticker.Stop()
	for tick := 1; tick <= run.spec.Events; tick++ {
		select {
		case <-run.cancel:
			return
		case <-ticker.C:
		}
		for i := range run.perSession {
			e := &run.perSession[i]
			f.emit("message.part.delta", map[string]any{
				"sessionID": e.SID, "messageID": e.MessageID, "partID": e.PartID,
				"field": "text", "delta": mpWorkloadChunk(i, int(run.id), tick, e.ChunkBytes),
			})
			atomic.AddInt64(&run.emitted, 1)
		}
	}

	// Final bookends: the authoritative full part (identical to the
	// accumulated deltas by construction) + completed message, persisted so
	// cold hydration sees the finished turn.
	for i := range run.perSession {
		e := &run.perSession[i]
		part := map[string]any{
			"id": e.PartID, "sessionID": e.SID, "messageID": e.MessageID, "type": "text",
			"text": e.finalText, "time": map[string]any{"start": now(), "end": now()},
		}
		info := map[string]any{
			"id": e.MessageID, "sessionID": e.SID, "role": "assistant", "agent": "build",
			"time": map[string]any{"created": now(), "completed": now()},
		}
		f.appendMessage(e.SID, messageWithParts{Info: info, Parts: []map[string]any{part}})
		f.emit("message.part.updated", map[string]any{"part": part})
		f.emit("message.updated", map[string]any{"info": info})
		atomic.AddInt64(&run.bookends, 2) // appendMessage persists; the two emits are the bookends
	}
}

// mpWorkloadFinish marks terminal state and frees the active-run slot.
func (f *FakeOpenCode) mpWorkloadFinish(run *mpWorkloadRun) {
	f.mpWLmu.Lock()
	if run.state == mpStateRunning || run.state == mpStateArmed {
		if run.cancelled() {
			run.state = mpStateCancelled
		} else {
			run.state = mpStateDone
		}
	}
	run.finishedAt = time.Now()
	if f.mpActiveID == run.id {
		f.mpActiveID = 0
	}
	f.mpWLmu.Unlock()
	close(run.done)
}

func (r *mpWorkloadRun) cancelled() bool {
	select {
	case <-r.cancel:
		return true
	default:
		return false
	}
}

// handleMPSeed opts into SeedMultiProject at runtime (before hydration — the
// lane-6 fixtureserver does not seed mp data on boot). Idempotent: a second
// call returns 409 + the already-populated dirs instead of duplicating
// sessions (serial-suite / reused-webServer safety).
//
// The wire body uses snake_case keys; MultiProjectSpec itself carries no json
// tags (A1 contract), so decode through an explicit DTO — decoding the struct
// directly would silently zero every underscore key (exactly the bug the
// first A2 run hit: seeded dirs with zero sessions).
func (f *FakeOpenCode) handleMPSeed(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Projects        int `json:"projects"`
		SessionsPerProj int `json:"sessions_per_proj"`
		BulkSessions    int `json:"bulk_sessions"`
		TurnsPerSession int `json:"turns_per_session"`
		SmallPartBytes  int `json:"small_part_bytes"`
		BulkPartBytes   int `json:"bulk_part_bytes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	spec := MultiProjectSpec{
		Projects:        body.Projects,
		SessionsPerProj: body.SessionsPerProj,
		BulkSessions:    body.BulkSessions,
		TurnsPerSession: body.TurnsPerSession,
		SmallPartBytes:  body.SmallPartBytes,
		BulkPartBytes:   body.BulkPartBytes,
	}
	if spec.Projects <= 0 {
		spec.Projects = 7
	}
	f.mu.Lock()
	seeded := false
	dirs := []string{}
	for _, s := range f.sessions {
		d, _ := s["directory"].(string)
		if len(d) > len("/work/mproj") && d[:len("/work/mproj")] == "/work/mproj" {
			seeded = true
		}
	}
	f.mu.Unlock()
	if seeded {
		for i := 0; i < spec.Projects; i++ {
			dirs = append(dirs, fmt.Sprintf("/work/mproj%d", i))
		}
		w.WriteHeader(http.StatusConflict)
		writeJSON(w, map[string]any{"already_seeded": true, "dirs": dirs})
		return
	}
	dirs = f.SeedMultiProject(spec)
	writeJSON(w, map[string]any{"dirs": dirs})
}
