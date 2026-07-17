package diagnostics

import "sync/atomic"

// --- Fixed cardinality enums -------------------------------------------------
//
// Every dimension these probes record into is one of a small fixed set. There
// is NO per-session-id, per-stream-id, or per-URL axis — by construction the
// diagnostic cardinality is bounded for the lifetime of the process.

// SourceClass identifies the origin of an event crossing the ingest boundary.
const (
	SourceOpencodeLive    = iota // 0 — a real OpenCode SSE event decoded in SubscribeEvents dispatch
	SourceHydrate                // 1 — reconstructed during initial hydrate (no upstream ingest t0)
	SourceDaemonGenerated        // 2 — emitted by the daemon itself (notice / messages.loaded / .error)
	numSourceClasses
)

// sourceClassName mirrors the constants for JSON output.
var sourceClassName = [numSourceClasses]string{
	"opencode_live",
	"hydrate",
	"daemon_generated",
}

// EmitClass is Probe 2's fixed emit-kind classifier. The exact kind string
// from the wire is collapsed into one of these so emit-rate aggregates stay
// bounded regardless of how many distinct event types OpenCode introduces.
const (
	EmitClassStructural    = iota // 0 — session.*, status, activity.*, permission.*, question.*, notice
	EmitClassMessage              // 1 — message.* (single message, NOT messages.batch)
	EmitClassPart                 // 2 — part.* (deltas)
	EmitClassMessagesBatch        // 3 — messages.* (loaded/error batch signals)
	EmitClassOther                // 4 — anything not classified above
	numEmitClasses
)

var emitClassName = [numEmitClasses]string{
	"structural",
	"message",
	"part",
	"messages_batch",
	"other",
}

// StreamClass is Probe 3's fixed SSE-stream classifier. Derived from the
// stream's message filter, NOT from any per-session id.
const (
	StreamClassTree     = iota // 0 — tree-only (?sessions absent/empty)
	StreamClassSelected        // 1 — selected session(s) (?sessions=a,b,c)
	StreamClassFirehose        // 2 — ?sessions=all
	StreamClassOther           // 3 — fallback (unused today)
	numStreamClasses
)

var streamClassName = [numStreamClasses]string{
	"tree",
	"selected_session",
	"firehose",
	"other",
}

// Side distinguishes the two wsRWC roles (Probe 5).
const (
	SideServer = iota // 0 — controller-side wsRWC (yamux Server)
	SideClient        // 1 — worker-side wsRWC (yamux Client)
	numSides
)

var sideName = [numSides]string{"controller_server", "worker_client"}

// CopyDir is Probe 6's two io.Copy directions in the controller raw proxy.
const (
	CopyYamuxToBrowser = iota // 0 — io.Copy(clientConn, stream.Raw())
	CopyBrowserToYamux        // 1 — io.Copy(stream.Raw(), clientBuf)
	numCopyDirs
)

var copyDirName = [numCopyDirs]string{"yamux_to_browser", "browser_to_yamux"}

// YamuxWriteDir is Probe 4's two yamux.Stream write directions. Probe 4 was
// originally installed ONLY on the controller browser→yamux leg (where it
// measured the request direction), but the SSE/response direction — where
// yamux flow-control / send-window backpressure actually accumulates — is the
// worker's local-service→yamux write. Splitting the accounting keeps BOTH
// directions visible (the controller-direction is still useful as the
// request-egress signal) while making the response direction the primary
// tunable for "the tunnel is wedging". The two are never summed together: a
// per-direction histogram is the only way to tell a slow request write apart
// from a slow response write when both go through the same yamux.Session.
//
//	yamux_response: worker-side local-service → yamux.Stream.Write
//	                (pkg/agent/daemon.go handleRawProxy copy leg) — the primary
//	                egress signal; flow-control blocking accumulates here.
//	yamux_request:  controller-side browser → yamux.Stream.Write
//	                (pkg/server/proxy.go handleRawProxy copy leg + the initial
//	                request write) — preserved for symmetry.
const (
	YamuxWriteResponse = iota // 0 — worker local-service→yamux (response/egress)
	YamuxWriteRequest         // 1 — controller browser→yamux (request)
	numYamuxWriteDirs
)

var yamuxWriteDirName = [numYamuxWriteDirs]string{"yamux_response", "yamux_request"}

// DisconnectReason enumerates why an SSE stream ended (Probe 3) — fixed set.
const (
	DiscRequestCtxClosed        = iota // 0 — r.Context().Done() (browser closed)
	DiscSubscriberChannelClosed        // 1 — store dropped this subscriber (slow consumer)
	DiscWriteFailure                   // 2 — a Write call returned an error
	numDiscReasons
)

var discReasonName = [numDiscReasons]string{
	"request_ctx_closed",
	"subscriber_channel_closed",
	"write_failure",
}

// CopyTerm enumerates how a controller io.Copy direction ended (Probe 6).
const (
	CopyTermNormal = iota // 0 — io.Copy returned nil (clean EOF)
	CopyTermError         // 1 — io.Copy returned a non-nil error
	numCopyTerms
)

var copyTermName = [numCopyTerms]string{"normal", "error"}

// StreamCloseReason enumerates why a yamux proxy stream closed (Probe 4).
const (
	StreamCloseAck       = iota // 0 — closed normally after both copies finished
	StreamCloseSetup            // 1 — closed during setup (OpenStream/WriteJSON/ReadJSON/body/Hijack failure)
	StreamCloseCopyError        // 2 — closed because a copy errored
	numStreamCloseReasons
)

var streamCloseReasonName = [numStreamCloseReasons]string{
	"ack",
	"setup",
	"copy_error",
}

// slow-incident thresholds (nanoseconds). Crossing one records an Incident into
// the bounded ring so the operator can see the worst recent cases without
// per-frame logging. Tuned to catch pathological latency, not normal traffic.
// The externally-used thresholds are exported (SlowEmitAgeNs, SlowStreamWriteNs,
// SlowWSWriteNs) so callers and the registry share one source of truth.
const (
	slowSSEWriteNs    = 50 * 1_000_000  // 50ms per SSE Write
	slowSSEFlushNs    = 50 * 1_000_000  // 50ms per SSE Flush
	SlowStreamWriteNs = 50 * 1_000_000  // 50ms per yamux stream Write (Probe 4)
	SlowWSWriteNs     = 100 * 1_000_000 // 100ms per wsRWC.Write total (Probe 5)
	SlowEmitAgeNs     = 500 * 1_000_000 // 500ms ingest→emit age (Probe 2)
)

// --- Probe 1: ingest (pkg/opencode/client.go dispatch boundary) -------------

// IngestStats is the ingest-boundary accumulator. Probe 1 stamps an
// opencode_live event with a monotonic-capable ingest t0 (unix-nano) the
// instant its `data:` envelope is decoded, BEFORE any handler/store work.
type IngestStats struct {
	// Total events decoded (opencode_live only — hydrate/daemon bypass this
	// boundary and are accounted at emit instead).
	Events Counter
	// Total payload bytes decoded (Properties field length).
	Bytes Counter
	// Ingest→dispatch-completion latency (dispatch overhead; small but useful
	// to confirm the parse itself is not the bottleneck).
	DispatchDur Histogram
	// Histogram of raw payload byte sizes (bounded buckets via latencyBucketsNs
	// reused as size buckets — coarse but enough to spot a giant-frame outlier).
	BytesHist Histogram
}

// --- Probe 2: store emit (pkg/state/store.go Store.emit) --------------------

// EmitStats is the emit-boundary accumulator, updated from inside Store.emit
// with PURE ATOMICS only (no mutex, no channel, no allocation). The ingest→emit
// age is recorded only when an ingest t0 was carried in (live events).
type EmitStats struct {
	// per-class event count and payload bytes (fixed 5 classes).
	ClassCount [numEmitClasses]Counter
	ClassBytes [numEmitClasses]Counter
	// per-source event count (live / hydrate / daemon) — fixed 3 sources.
	SourceCount [numSourceClasses]Counter
	// ingest→emit age histogram (only for events carrying an ingest t0).
	EmitAge Histogram
	// Subscriber-drop count: a full 256-buffer subscriber channel closed+dropped
	// (the existing backpressure sentinel). Behavior is unchanged; this only
	// counts the existing drop.
	SubscriberDrops Counter
}

// --- Probe 3: per-SSE-stream steady-state (pkg/web/server.go /vh/stream) ----

// StreamStats is one per-class accumulator (fixed 3 classes: tree / selected /
// firehose). Every concurrent /vh/stream connection reports into its class
// bucket. The actual ResponseWriter is wrapped by streamStatsWriter (see
// handler.go) so per-Write and per-Flush timing is captured.
type StreamStats struct {
	// Connections opened in this class (total).
	Opens Counter
	// Bytes written (sum across all streams of this class).
	Bytes Counter
	// Number of Write calls (≈ events + pings + snapshot writes, since each
	// handler-side frame is a single fmt.Fprintf → one Write).
	Writes Counter
	// Number of Flush calls.
	Flushes Counter
	// Write errors (Write returned non-nil).
	WriteErrors Counter
	// Per-Write duration histogram (time the underlying ResponseWriter.Write
	// call took — local TCP buffering only; see caveat in handler.go).
	WriteDur Histogram
	// Per-Flush duration histogram.
	FlushDur Histogram
	// Inter-arrival gap between successive Write calls on the SAME stream
	// (nanoseconds). High gap + low write dur ⇒ the store/subscription path is
	// the bottleneck; low gap + high write dur ⇒ the egress path is.
	Interarrival Histogram
	// Ping Write+Flush combined duration (Probe 3 "delayed ping" sentinel).
	PingDur Histogram
	// Snapshot-path vs replay-path counts (which baseline branch handleStream took).
	SnapshotPath Counter
	ReplayPath   Counter
	// Snapshot wire bytes (the maybeCompressSnapshot'd payload written).
	SnapshotBytes Counter
	// Disconnect-reason counts.
	DiscReason [numDiscReasons]Counter
	// Slow Write incidents (bounded ring).
	SlowWrites IncidentRing
	// Slow Flush incidents (bounded ring).
	SlowFlushes IncidentRing
}

// --- Probe 4: yamux stream-write pressure (pkg/server/proxy.go + pkg/agent/daemon.go) -----

// YamuxStats is the yamux stream probe. It accounts for BOTH write directions
// (controller browser→yamux request leg AND worker local-service→yamux
// response leg) via YamuxWriteDir-keyed per-direction accumulators. The
// response direction is the primary egress signal — that's where yamux
// flow-control / send-window backpressure accumulates.
//
// ActiveStreams is a process-global INC/DEC counter (incremented on proxy
// stream open, decremented on close) — NOT a per-NumStreams() sample. The
// previous design sampled worker.Transport.Session.NumStreams() into the
// gauge, but with multiple workers each sample overwrote the others' (last
// sample wins, not total). The new design is the true global count. For
// per-session correlation on a slow write, the slow-incident's Aux field
// carries the relevant session's NumStreams() sampled at THAT incident only
// (see YamuxWriteMonitor.WithSession).
type YamuxStats struct {
	// Streams opened (controller→worker OpenStream attempts).
	StreamsOpened Counter
	// Streams that failed to open.
	StreamOpenFails Counter
	// Active proxy streams right now (global inc/dec: +1 on open, -1 on
	// close). Distinct from any single yamux.Session.NumStreams() — a
	// multi-worker controller would otherwise see the last-sampled session
	// overwrite the others.
	ActiveStreams atomic.Int64
	// Stream-open duration histogram.
	OpenDur Histogram
	// BytesRead: bytes copied FROM yamux.Stream on the controller leg
	// (yamux→browser). This is the controller-side view of the response bytes;
	// the worker-side write of those same bytes is in WriteByDir[Response].
	// Retained because it captures the full response byte volume that crossed
	// the controller's io.Copy (including any bytes the worker wrote but the
	// controller hasn't drained yet — a backpressure signal).
	BytesRead Counter
	// Per-direction write accounting. The response direction
	// (worker local-service→yamux) is the primary egress signal.
	WriteByDir [numYamuxWriteDirs]YamuxWriteStats
	// Close-reason counts.
	CloseReason [numStreamCloseReasons]Counter
}

// YamuxWriteStats is one yamux write-direction's accumulator (response or
// request). Each Write into a yamux.Stream in either the worker
// local-service→yamux leg OR the controller browser→yamux leg reports into
// exactly one of these.
type YamuxWriteStats struct {
	// Bytes written into yamux.Stream in this direction.
	Bytes Counter
	// Per-Write-call duration.
	Dur Histogram
	// Writes whose duration exceeded SlowStreamWriteNs.
	SlowWrites Counter
	// Slow stream-write incidents (bounded ring; Aux carries the relevant
	// session's NumStreams() sampled at the slow write, NOT the global
	// ActiveStreams gauge, so per-session correlation survives a multi-worker
	// controller).
	SlowWriteIncidents IncidentRing
}

// --- Probe 5: wsRWC.Write probe (pkg/tunnel/websocket.go) -------------------

// WSWriteStats is ONE side's accumulator for the underlying WebSocket write
// path (the single critical section all tunnel frames pass through). mutex-wait
// and WriteMessage durations are recorded SEPARATELY so head-of-line delay
// serialized by yamux's own sender (which shows up as stream-Write wait, not
// wsRWC.mu contention) is distinguishable from true wsRWC contention.
type WSWriteStats struct {
	// Input bytes (sum of len(p) across Write calls).
	Bytes Counter
	// Number of Write calls.
	Writes Counter
	// Write errors.
	Errors Counter
	// mutex-wait duration: time blocked on wsRWC.mu before acquiring it.
	MutexWaitDur Histogram
	// WriteMessage duration: time inside conn.WriteMessage (handing bytes to
	// the underlying WebSocket / TCP).
	WriteMsgDur Histogram
	// Total Write-call duration (mutex-wait + WriteMessage + tiny overhead).
	TotalDur Histogram
	// Active proxy-stream count sampled at each wsRWC.Write. Sourced from the
	// lock-free process-local gauge Yamux.ActiveStreams (atomic.Int64), NOT
	// yamux.Session.NumStreams() — NumStreams() acquires the session streamLock
	// and is reserved for the threshold-gated slow-write incident's Aux only
	// (see pkg/tunnel/websocket.go Write). The gauge is inc/dec'd around each
	// proxy stream's lifetime on BOTH tunnel endpoints: controller side in
	// pkg/server/proxy.go handleRawProxy, worker side in pkg/agent/daemon.go
	// handleRawProxy. Reported as a histogram so the "write was slow while N
	// streams were active" correlation is visible on each process independently.
	ActiveStreamsAtWrite Histogram
	// Slow Write incidents (bounded ring; Detail = mutex-wait, Aux = active streams).
	SlowWriteIncidents IncidentRing
}

// --- Probe 6: controller browser-leg io.Copy accounting ---------------------

// CopyStats is per-direction accounting for the two raw io.Copy calls in the
// controller proxy. The controller stays protocol-agnostic — NO SSE parsing.
type CopyStats struct {
	// Total bytes copied in this direction.
	Bytes Counter
	// Total time spent in io.Copy for this direction (one duration per
	// connection, accumulated). Useful as a coarse "how blocked was this leg"
	// signal — the per-chunk granularity is in Probe 4's WriteDur instead.
	Dur Histogram
	// Copy termination counts (normal EOF vs error).
	Term [numCopyTerms]Counter
}

// --- Registry ---------------------------------------------------------------

// Registry holds every probe's accumulators. The package-level Default is the
// singleton all probes report into; both the worker (probes 1-3, 5-client) and
// the controller (probes 4, 5-server, 6) import and write to it.
type Registry struct {
	Ingest  IngestStats
	Emit    EmitStats
	Stream  [numStreamClasses]StreamStats
	Yamux   YamuxStats
	WSWrite [numSides]WSWriteStats
	Copy    [numCopyDirs]CopyStats

	// startedAt is the process/registry creation time, reported in the snapshot
	// so a consumer can compute rates per second since start.
	startedAt int64
}

// Default is the singleton all probes report into.
var Default = newRegistry()

// newRegistry constructs a Registry with every Histogram's min sentinel
// initialized (so a 0 observation seeds cleanly — see TestHistogramMinZeroObservation).
func newRegistry() *Registry {
	r := &Registry{startedAt: nowNano()}
	r.initSentinels()
	return r
}

// ResetForTest zeroes the singleton. Test-only — production never resets.
func ResetForTest() {
	r := Default
	r.Ingest = IngestStats{}
	r.Emit = EmitStats{}
	for i := range r.Stream {
		r.Stream[i] = StreamStats{}
	}
	r.Yamux = YamuxStats{}
	for i := range r.WSWrite {
		r.WSWrite[i] = WSWriteStats{}
	}
	for i := range r.Copy {
		r.Copy[i] = CopyStats{}
	}
	r.startedAt = nowNano()
	r.initSentinels()
}
