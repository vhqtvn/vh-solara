package diagnostics

import (
	"encoding/json"
	"net/http"
)

// snapshotJSON is the wire shape of GET /vh/diag/latency. Field names mirror
// the probe names so an operator reading the JSON can map straight back to the
// probe definitions. All durations are nanoseconds; bytes are raw counts.
// No raw transcript content, session IDs, or URLs ever appear here.
type snapshotJSON struct {
	StartedAtNs int64 `json:"started_at_ns"`
	Probes      struct {
		Ingest  ingestJSON    `json:"ingest"`
		Emit    emitJSON      `json:"emit"`
		Stream  []streamJSON  `json:"stream"`
		Yamux   yamuxJSON     `json:"yamux"`
		WSWrite []wsWriteJSON `json:"ws_write"`
		Copy    []copyJSON    `json:"copy"`
		Tunnel  tunnelJSON    `json:"tunnel"`
	} `json:"probes"`
}

type ingestJSON struct {
	Events      uint64            `json:"events"`
	Bytes       uint64            `json:"bytes"`
	DispatchDur histogramSnapshot `json:"dispatch_dur"`
	BytesHist   histogramSnapshot `json:"bytes_hist"`
}

type emitJSON struct {
	ClassCount  map[string]uint64 `json:"class_count"`
	ClassBytes  map[string]uint64 `json:"class_bytes"`
	SourceCount map[string]uint64 `json:"source_count"`
	EmitAge     histogramSnapshot `json:"emit_age"`
	SubDrops    uint64            `json:"subscriber_drops"`
}

type streamJSON struct {
	Class         string            `json:"class"`
	Opens         uint64            `json:"opens"`
	Bytes         uint64            `json:"bytes"`
	Writes        uint64            `json:"writes"`
	Flushes       uint64            `json:"flushes"`
	WriteErrors   uint64            `json:"write_errors"`
	WriteDur      histogramSnapshot `json:"write_dur"`
	FlushDur      histogramSnapshot `json:"flush_dur"`
	Interarrival  histogramSnapshot `json:"interarrival"`
	PingDur       histogramSnapshot `json:"ping_dur"`
	SnapshotPath  uint64            `json:"snapshot_path"`
	ReplayPath    uint64            `json:"replay_path"`
	SnapshotBytes uint64            `json:"snapshot_bytes"`
	DiscReason    map[string]uint64 `json:"disc_reason"`
	SlowWrites    []Incident        `json:"slow_writes"`
	SlowFlushes   []Incident        `json:"slow_flushes"`
}

type yamuxJSON struct {
	StreamsOpened        uint64            `json:"streams_opened"`
	StreamOpenFails      uint64            `json:"stream_open_fails"`
	ActiveStreams        int64             `json:"active_streams"`
	OpenDur              histogramSnapshot `json:"open_dur"`
	BytesRead            uint64            `json:"bytes_read"`
	WriteByDir           []yamuxWriteJSON  `json:"write_by_dir"`
	CloseReason          map[string]uint64 `json:"close_reason"`
	ReqWriteDur          histogramSnapshot `json:"req_write_dur"`
	AckDur               histogramSnapshot `json:"ack_dur"`
	SetupDur             histogramSnapshot `json:"setup_dur"`
	TunnelDownRejections uint64            `json:"tunnel_down_rejections"`
}

type yamuxWriteJSON struct {
	Dir                string            `json:"dir"`
	Bytes              uint64            `json:"bytes"`
	Dur                histogramSnapshot `json:"dur"`
	SlowWrites         uint64            `json:"slow_writes"`
	SlowWriteIncidents []Incident        `json:"slow_write_incidents"`
}

type wsWriteJSON struct {
	Side                 string            `json:"side"`
	Bytes                uint64            `json:"bytes"`
	Writes               uint64            `json:"writes"`
	Errors               uint64            `json:"errors"`
	MutexWaitDur         histogramSnapshot `json:"mutex_wait_dur"`
	WriteMsgDur          histogramSnapshot `json:"write_msg_dur"`
	TotalDur             histogramSnapshot `json:"total_dur"`
	ActiveStreamsAtWrite histogramSnapshot `json:"active_streams_at_write"`
	SlowWriteIncidents   []Incident        `json:"slow_write_incidents"`
}

type copyJSON struct {
	Dir   string            `json:"dir"`
	Bytes uint64            `json:"bytes"`
	Dur   histogramSnapshot `json:"dur"`
	Term  map[string]uint64 `json:"term"`
}

// tunnelJSON is the worker-side tunnel-lifecycle probe's wire shape. On the
// controller process these fields stay zero (the worker is the only writer);
// the aggregator fan-out pulls per-worker values through FetchWorkerSnapshot.
type tunnelJSON struct {
	DialAttempts       uint64 `json:"dial_attempts"`
	DialFailures       uint64 `json:"dial_failures"`
	Connected          uint64 `json:"connected"`
	Disconnects        uint64 `json:"disconnects"`
	IdleResets         uint64 `json:"idle_resets"`
	LastBackoffNs      int64  `json:"last_backoff_ns"`
	LastConnectedAtNs  int64  `json:"last_connected_at_ns"`
	LastDisconnectAtNs int64  `json:"last_disconnect_at_ns"`
	CurrentState       string `json:"current_state"`
}

// Snapshot returns a JSON-serializable snapshot of every probe accumulator.
// Cardinality is bounded: every map has a fixed key set; every ring is capped
// at maxIncidents. Safe to call concurrently with probes writing into the
// registry (individual reads are atomic; the snapshot is point-in-time
// consistent per-field but not cross-field).
func Snapshot() snapshotJSON {
	r := Default
	out := snapshotJSON{StartedAtNs: r.startedAt}

	out.Probes.Ingest = ingestJSON{
		Events:      r.Ingest.Events.Load(),
		Bytes:       r.Ingest.Bytes.Load(),
		DispatchDur: r.Ingest.DispatchDur.snapshot(),
		BytesHist:   r.Ingest.BytesHist.snapshot(),
	}

	out.Probes.Emit.ClassCount = map[string]uint64{}
	out.Probes.Emit.ClassBytes = map[string]uint64{}
	out.Probes.Emit.SourceCount = map[string]uint64{}
	for i := 0; i < numEmitClasses; i++ {
		out.Probes.Emit.ClassCount[emitClassName[i]] = r.Emit.ClassCount[i].Load()
		out.Probes.Emit.ClassBytes[emitClassName[i]] = r.Emit.ClassBytes[i].Load()
	}
	for i := 0; i < numSourceClasses; i++ {
		out.Probes.Emit.SourceCount[sourceClassName[i]] = r.Emit.SourceCount[i].Load()
	}
	out.Probes.Emit.EmitAge = r.Emit.EmitAge.snapshot()
	out.Probes.Emit.SubDrops = r.Emit.SubscriberDrops.Load()

	out.Probes.Stream = make([]streamJSON, 0, numStreamClasses)
	for i := 0; i < numStreamClasses; i++ {
		s := &r.Stream[i]
		entry := streamJSON{
			Class:         streamClassName[i],
			Opens:         s.Opens.Load(),
			Bytes:         s.Bytes.Load(),
			Writes:        s.Writes.Load(),
			Flushes:       s.Flushes.Load(),
			WriteErrors:   s.WriteErrors.Load(),
			WriteDur:      s.WriteDur.snapshot(),
			FlushDur:      s.FlushDur.snapshot(),
			Interarrival:  s.Interarrival.snapshot(),
			PingDur:       s.PingDur.snapshot(),
			SnapshotPath:  s.SnapshotPath.Load(),
			ReplayPath:    s.ReplayPath.Load(),
			SnapshotBytes: s.SnapshotBytes.Load(),
			DiscReason:    map[string]uint64{},
			SlowWrites:    s.SlowWrites.Snapshot(),
			SlowFlushes:   s.SlowFlushes.Snapshot(),
		}
		for j := 0; j < numDiscReasons; j++ {
			entry.DiscReason[discReasonName[j]] = s.DiscReason[j].Load()
		}
		out.Probes.Stream = append(out.Probes.Stream, entry)
	}

	y := &r.Yamux
	out.Probes.Yamux = yamuxJSON{
		StreamsOpened:        y.StreamsOpened.Load(),
		StreamOpenFails:      y.StreamOpenFails.Load(),
		ActiveStreams:        y.ActiveStreams.Load(),
		OpenDur:              y.OpenDur.snapshot(),
		BytesRead:            y.BytesRead.Load(),
		WriteByDir:           make([]yamuxWriteJSON, 0, numYamuxWriteDirs),
		CloseReason:          map[string]uint64{},
		ReqWriteDur:          y.ReqWriteDur.snapshot(),
		AckDur:               y.AckDur.snapshot(),
		SetupDur:             y.SetupDur.snapshot(),
		TunnelDownRejections: y.TunnelDownRejections.Load(),
	}
	for i := 0; i < numYamuxWriteDirs; i++ {
		wd := &y.WriteByDir[i]
		out.Probes.Yamux.WriteByDir = append(out.Probes.Yamux.WriteByDir, yamuxWriteJSON{
			Dir:                yamuxWriteDirName[i],
			Bytes:              wd.Bytes.Load(),
			Dur:                wd.Dur.snapshot(),
			SlowWrites:         wd.SlowWrites.Load(),
			SlowWriteIncidents: wd.SlowWriteIncidents.Snapshot(),
		})
	}
	for j := 0; j < numStreamCloseReasons; j++ {
		out.Probes.Yamux.CloseReason[streamCloseReasonName[j]] = y.CloseReason[j].Load()
	}

	out.Probes.WSWrite = make([]wsWriteJSON, 0, numSides)
	for i := 0; i < numSides; i++ {
		w := &r.WSWrite[i]
		out.Probes.WSWrite = append(out.Probes.WSWrite, wsWriteJSON{
			Side:                 sideName[i],
			Bytes:                w.Bytes.Load(),
			Writes:               w.Writes.Load(),
			Errors:               w.Errors.Load(),
			MutexWaitDur:         w.MutexWaitDur.snapshot(),
			WriteMsgDur:          w.WriteMsgDur.snapshot(),
			TotalDur:             w.TotalDur.snapshot(),
			ActiveStreamsAtWrite: w.ActiveStreamsAtWrite.snapshot(),
			SlowWriteIncidents:   w.SlowWriteIncidents.Snapshot(),
		})
	}

	out.Probes.Copy = make([]copyJSON, 0, numCopyDirs)
	for i := 0; i < numCopyDirs; i++ {
		c := &r.Copy[i]
		entry := copyJSON{
			Dir:   copyDirName[i],
			Bytes: c.Bytes.Load(),
			Dur:   c.Dur.snapshot(),
			Term:  map[string]uint64{},
		}
		for j := 0; j < numCopyTerms; j++ {
			entry.Term[copyTermName[j]] = c.Term[j].Load()
		}
		out.Probes.Copy = append(out.Probes.Copy, entry)
	}

	// Probe 7: worker-side tunnel lifecycle. On the controller process every
	// counter stays zero (the worker is the only writer); the aggregator
	// fan-out pulls per-worker values through FetchWorkerSnapshot.
	t := &r.Tunnel
	stateIdx := int(t.CurrentState.Load())
	if stateIdx < 0 || stateIdx >= numTunnelStates {
		stateIdx = 0
	}
	out.Probes.Tunnel = tunnelJSON{
		DialAttempts:       t.DialAttempts.Load(),
		DialFailures:       t.DialFailures.Load(),
		Connected:          t.Connected.Load(),
		Disconnects:        t.Disconnects.Load(),
		IdleResets:         t.IdleResets.Load(),
		LastBackoffNs:      t.LastBackoffNs.Load(),
		LastConnectedAtNs:  t.LastConnectedAtNs.Load(),
		LastDisconnectAtNs: t.LastDisconnectAtNs.Load(),
		CurrentState:       tunnelStateName[stateIdx],
	}

	return out
}

// Handler returns a read-only GET http.Handler that emits the diagnostic
// snapshot as JSON. It performs no mutation and reads no sensitive content.
// The caller is responsible for auth-gating (mount under an auth-protected mux
// — mirroring the existing /vh/* pattern, GET-only so NO X-VH-CSRF exception
// is required, since CSRF defense only applies to unsafe methods).
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(Snapshot())
	})
}
