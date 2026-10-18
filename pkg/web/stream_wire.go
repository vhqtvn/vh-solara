package web

// SSE wire/snapshot-encoding helpers, moved verbatim from server.go (slice 11
// of the server.go split): the compound SSE id scheme (compoundSSEID,
// parseResumeCursor), the raw frame writers (writeEvent, writeRaw,
// writeRawNoID), the tree=2 checked-delivery boundary (deliverTreeOps), the
// truthful completion boundary (snapshotComplete, writeSnapshotComplete), and
// the gzip64 snapshot envelope (snapshotCompressThreshold, wantsCompress,
// wantsTree2, wantsPartDelta, maybeCompressSnapshot). Frame bytes, the
// checked-vs-unchecked write split, and the compression envelope are
// unchanged; only the declarations moved.

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/vhqtvn/vh-solara/pkg/state"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// compoundSSEID encodes a compound SSE id in the form "globalSeq.ordinal".
// The globalSeq is the STORE seq (used for resume/replay via store.Replay);
// the ordinal is a per-connection, stream-role-specific delivery counter that
// counts ONLY Inv1-relevant logical source events (O3). The FE parses both
// parts: globalSeq → cursor/resume bookkeeping; ordinal → per-stream gap
// detection (a gap in the ordinal is DIRECTLY actionable as real loss).
func compoundSSEID(seq, ordinal uint64) string {
	return strconv.FormatUint(seq, 10) + "." + strconv.FormatUint(ordinal, 10)
}

// parseResumeCursor extracts the global store seq from a Last-Event-ID value
// that may be either the new compound form ("globalSeq.ordinal") or a legacy
// plain numeric string. The ordinal component is connection-local and is
// discarded here — only the global seq feeds store.Replay(). Returns the parsed
// seq and true if the value was non-empty and numeric; (0, false) otherwise.
func parseResumeCursor(cursorStr string) (uint64, bool) {
	if cursorStr == "" {
		return 0, false
	}
	// Compound form: take everything before the first dot.
	if i := strings.IndexByte(cursorStr, '.'); i >= 0 {
		cursorStr = cursorStr[:i]
	}
	seq, err := strconv.ParseUint(cursorStr, 10, 64)
	if err != nil {
		return 0, false
	}
	return seq, true
}

func writeEvent(w io.Writer, id string, kind string, payload []byte) {
	writeRaw(w, id, kind, payload)
}

func writeRaw(w io.Writer, id string, event string, data []byte) {
	fmt.Fprintf(w, "id: %s\nevent: %s\ndata: %s\n\n", id, event, data)
}

// writeRawNoID writes an SSE frame WITHOUT an `id:` line, so the event does not
// move the client's Last-Event-ID resume cursor. Used for transient fan-out
// (notice, pins.updated) and bootstrap frames that are orthogonal to the state
// store's seq space (pins.snapshot) — events that are NOT part of the
// replayable ring and must never become a resume point. Mirrors writeRaw minus
// the id line. The browser listeners (stream.ts) dispatch on the `event:` name
// and ignore the absence of an id (existing notice/ping frames already omit it).
func writeRawNoID(w io.Writer, event string, data []byte) {
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
}

// deliverTreeOps is the L-14/M5 checked delivery boundary for the tree=2
// TreeEmitter path. It marshals ALL tree.op frames for one prepared store event
// into a single buffer BEFORE any write (so a marshal failure puts NOTHING on
// the wire), then performs ONE checked write — err == nil AND n == len(buf) —
// and calls treeEmitter.Commit ONLY on full acceptance. On any failure (marshal
// error, write error, short write) it returns a non-nil error and leaves the
// committed emitter state UNCHANGED; the caller MUST abort the stream rather
// than continue past an advanced baseline.
//
// This replaces the former per-op writeRaw loop, which marshaled+wrote each op
// in turn and discarded writeRaw's (n, err) — so a dropped or partial frame
// silently advanced the emitter's committed cache, poisoning later translation
// (it assumed the client had observed state that was never delivered).
//
// Delivery success here is LOCAL write acceptance (the HTTP/OS layer accepted
// the bytes), NOT proof of browser receipt. There is no rollback: because
// Prepare never mutated committed state, failure only discards the prepared
// object.
// deliverTreeOps marshals ALL tree.op frames for one prepared store event into
// a single buffer BEFORE any write, then performs ONE checked write, and calls
// treeEmitter.Commit ONLY on full acceptance. The `id` parameter is the compound
// SSE id stamped on each tree.op frame (globalSeq.ordinal) — see compoundSSEID.
func deliverTreeOps(w io.Writer, treeEmitter *state.TreeEmitter, prepared *state.PreparedTranslation, id string) error {
	if prepared == nil || len(prepared.Ops) == 0 {
		return nil // nothing to deliver; Next == committed, so no commit needed
	}
	var buf bytes.Buffer
	for _, op := range prepared.Ops {
		b, err := json.Marshal(op)
		if err != nil {
			return fmt.Errorf("tree=2 tree.op marshal (event seq %d): %w", prepared.EventSeq, err)
		}
		// Mirror writeRaw's frame shape exactly (id/event/data).
		fmt.Fprintf(&buf, "id: %s\nevent: tree.op\ndata: %s\n\n", id, b)
	}
	n, err := w.Write(buf.Bytes())
	if err != nil {
		return fmt.Errorf("tree=2 tree.op write (event seq %d): %w", prepared.EventSeq, err)
	}
	if n != buf.Len() {
		return fmt.Errorf("tree=2 tree.op short write (event seq %d): %d/%d bytes", prepared.EventSeq, n, buf.Len())
	}
	treeEmitter.Commit(prepared)
	return nil
}

// snapshotComplete is the Q5 truthful completion boundary. Emitted on the wire
// ONLY after BOTH projections of a single SnapshotWithTree capture have been
// written: tree.snapshot (structure, gzip64/async) and the legacy detail
// snapshot (raw/sync). Because SnapshotWithTree derived both under ONE store
// RLock, both carry the SAME {epoch, seq}; this event truthfully asserts that
// cross-projection atomicity. The FE stages tree+detail by {epoch, revision}
// and marks authoritativeReady on receipt — the verifiable convergence
// boundary that resyncTree/reconcile needed. Before the single-capture
// consolidation (commit B), stamping this label would have been false
// confidence (two independent RLocks could diverge across a writer).
type snapshotComplete struct {
	Epoch       string   `json:"epoch"`
	Revision    uint64   `json:"revision"`
	Projections []string `json:"projections"`
}

// writeSnapshotComplete marshals + writes the snapshot.complete SSE frame,
// stamped with the capture's {epoch, seq} (revision == seq). The SSE id is the
// compound id passed by the caller (same globalSeq as both projections; ordinal
// is 0 for tree-stream snapshots since the FE does not gap-check snapshots).
func writeSnapshotComplete(w io.Writer, epoch string, seq uint64, id string) {
	cb, err := json.Marshal(snapshotComplete{
		Epoch:       epoch,
		Revision:    seq,
		Projections: []string{"tree", "detail"},
	})
	if err != nil {
		vhlog.Warn("snapshot.complete: marshal failed", "err", err)
		return
	}
	writeRaw(w, id, "snapshot.complete", cb)
}

// snapshotCompressThreshold is the minimum marshaled-snapshot size above which
// maybeCompressSnapshot will gzip64-wrap the payload. Below it the raw JSON is
// sent as-is: small payloads (cold/messageless partial snapshots, a tiny tree)
// gain nothing from gzip and base64 inflates them, and keeping them raw lets
// the client ingest them on the synchronous fast path (no async
// DecompressionStream round-trip). Above the threshold, two payloads benefit:
// (1) the warm open of a loaded session (a full transcript — megabytes), and
// (2) the tree-only snapshot for a real project (~760 KiB–1.1 MiB of highly
// repetitive JSON — one directory/projectID/model/agent set repeated across
// ~1k sessions). Both clients opt in via `z=1`; the tree stream was wired to
// `z=1` after a live study found the tree reconnect cadence (~60/hr) was
// shipping ~40–68 MiB/hr of uncompressed tree snapshots through the tunnel.
const snapshotCompressThreshold = 2048

// wantsCompress reports whether the client opted into gzip64 snapshot encoding
// via the `z=1` query flag. EventSource cannot set custom request headers, so
// the opt-in is a query param (not Accept-Encoding). An absent/false flag keeps
// the legacy raw-JSON wire shape bit-for-bit — this is what protects a stale
// cached PWA (old client) against a new server that would otherwise emit a
// base64 blob it cannot render. The client's decode helper is a total function
// (pass-through when encoding is absent), so the reverse (new client, old
// server) also interops without special handling.
func wantsCompress(r *http.Request) bool {
	return r.URL.Query().Get("z") == "1"
}

// wantsTree2 reports whether the client opted into the server-owned session
// tree (Phase 2: tree=2) via the `tree=2` query flag. When true, handleStream
// emits a tree.snapshot (frontier) instead of the legacy wholesale snapshot,
// and live structural events are translated to tree delta ops
// (node.upsert/remove/move/children/facet) via state.TreeEmitter. The
// GET /vh/tree/children expand endpoint (handleTreeChildren) is the lazy-load
// counterpart. This is the sole structure-emission path (Phase 4 deleted the
// proj=1 projected path); old clients that don't send tree=2 get the flat
// wholesale snapshot on the non-tree branch.
func wantsTree2(r *http.Request) bool {
	return r.URL.Query().Get("tree") == "2"
}

// wantsPartDelta (slice 2 of part-append-streaming — see
// docs/ai/wire-protocols/part-append-streaming.md §3) reports whether the client
// opted into the KindPartAppend suffix wire format via the `part_delta=1` query
// flag. It mirrors wantsCompress (`z=1`) exactly: a query-param opt-in (no custom
// request header — EventSource cannot set one), per-connection, established once
// at /vh/stream open. When true, handleStream threads it into the store
// subscription (Interest.WantsPartDelta) so the part-delta flush path
// (flushPartDeltasLocked → emitPartAppend) delivers KindPartAppend suffix frames
// to this connection for allowlisted top-level fields (text/reasoning) instead
// of re-emitting the full accumulated text every flush (the O(L²)→O(L) lever).
// When false (the legacy default — absent param or any value other than "1"),
// the connection keeps the byte-identical full part.upsert wire shape: this is
// what protects a stale cached PWA (old client) against a new server that would
// otherwise emit a suffix it cannot interpret. The client kill-switch is simply
// to drop the param.
func wantsPartDelta(r *http.Request) bool {
	return r.URL.Query().Get("part_delta") == "1"
}

// maybeCompressSnapshot gzip64-wraps a marshaled snapshot payload when compress
// is requested AND the payload is large enough to benefit. The envelope mirrors
// the cold-load messages.batch convention exactly:
//
//	{"encoding":"gzip64","data":"<base64(gzip(snapshotJSON))>"}
//
// so the client decodes it through the same native DecompressionStream path.
// Returns the bytes to write as the event/response body (the envelope when
// compressed, or the input unchanged when not). base64 is required because SSE
// data: fields are text/UTF-8 and raw gzip bytes are not valid UTF-8; the same
// applies to a JSON response body a client parses before feature-detecting.
func maybeCompressSnapshot(raw []byte, compress bool) []byte {
	if !compress || len(raw) < snapshotCompressThreshold {
		return raw
	}
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	_, _ = gw.Write(raw) // gzip.Writer.Write does not return a meaningful error mid-stream
	if err := gw.Close(); err != nil {
		// gzip.Close flushes the trailer; on failure buf holds an incomplete
		// gzip stream. The *bytes.Buffer backing writer cannot fail today, but a
		// silent discard would mask a future regression — fall back to the raw
		// JSON (the client's decode helper is pass-through when encoding is
		// absent, so this degrades gracefully rather than shipping corrupt bytes).
		vhlog.Warn("snapshot: gzip close failed, sending raw", "err", err)
		return raw
	}
	out, err := json.Marshal(struct {
		Encoding string `json:"encoding"`
		Data     string `json:"data"`
	}{Encoding: "gzip64", Data: base64.StdEncoding.EncodeToString(buf.Bytes())})
	if err != nil {
		vhlog.Warn("snapshot: marshal gzip64 envelope failed, sending raw", "err", err)
		return raw
	}
	return out
}
