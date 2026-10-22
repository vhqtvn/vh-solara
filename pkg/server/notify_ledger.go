package server

// notify_ledger.go — the central transactional notify ledger (notify
// controller-hub S3 / v4 §9.3, brief §1): the controller-side journal that
// turns per-worker feed pages into the merged global event stream with
// exactly-once ingestion.
//
// ---------------------------------------------------------------------------
// THE TRANSACTION BOUNDARY (brief §1: "Independent JSON writes must not be
// described as an atomic transaction")
// ---------------------------------------------------------------------------
//
// One page commit = ONE newline-terminated JSON line appended to a single
// journal file and fsync'd. The line carries the ENTIRE effect of the commit:
//
//   - the central event(s) (with their freshly allocated ids — which is also
//     the persisted dispatch intent: the event record embeds every gating
//     input S4 needs, so a committed event IS a recorded intent; there is
//     deliberately no second intent store to keep atomic),
//   - the source's FULL post-commit state (epoch, dedupe floor LowSeq, cursor
//     HighSeq, acked watermark, gap list, public floor) — cursor + dedupe +
//     gap knowledge travel in the same line as the events, so they can never
//     disagree,
//   - all under one mutex-held, one-Write, one-fsync append.
//
// Because the whole effect is one line, there is no intermediate state to
// observe: after any crash, on reload the ledger is EITHER fully at the
// pre-page state OR fully at the post-page state, never mixed.
//
// ---------------------------------------------------------------------------
// RECOVERY PROOF — what a crash can and cannot lose
// ---------------------------------------------------------------------------
//
// Durability boundary: CommitPage/RecordAck/ResetSourceEpoch perform
// f.Write(line) followed by f.Sync(). A commit EXISTS iff its full line
// (including the trailing '\n') was written AND Sync returned nil.
//
//   - Crash mid-Write (process crash): the line may be partially appended.
//     A partial line necessarily lacks the trailing '\n' (a single Write of
//     line+'\n' either lands whole or ends mid-buffer), so on reload the
//     bytes after the last '\n' are an UNCOMMITTED TAIL: discarded, and the
//     file is truncated back to the last complete line. The commit never
//     existed (memory state was not advanced — memory advances only after
//     Sync succeeds). NOTHING COMMITTED IS LOST.
//   - Write/Sync returned an ERROR: the in-memory state is NOT advanced, the
//     file is truncated back to the last committed offset (committedEnd), and
//     the error is returned to the pull loop, which retries the page from the
//     old cursor (dedupe absorbs the replay). At most the failed page's
//     events are (temporarily) un-ingested. If that ROLLBACK TRUNCATE
//     ITSELF fails, the ledger is POISONED (b-F4): a fragment of unknown
//     extent survives, so every further mutation is refused
//     (ErrNotifyLedgerPoisoned — fatal, never a retryable source failure)
//     until a successful reopen (armNotifyLedger) recovers the journal
//     from disk. Without the poison the next append would commit BEHIND
//     the fragment and the journal would be unreplayable after a restart.
//   - Crash after Sync, before memory advance: the line is durable; reload
//     replays it. State = post-page. Consistent.
//   - Host/filesystem crash: Sync'd appends are the durability claim (this
//     ledger DOES fsync — deliberately stronger than the S1 worker spool's
//     rename-only posture, because this file IS the global id authority).
//     Compaction (below) additionally fsyncs the temp file and best-effort
//     fsyncs the directory around the rename.
//
// Fail-closed bars (v4 §6/§9.3, brief §3 "Central ledger lost/corrupt"):
// the ledger NEVER silently restarts the global id at 1.
//   - Unreadable file, malformed line anywhere except the uncommitted tail,
//     a first line that is not the ledger header, or semantically invalid
//     records (non-contiguous ids, cursor regressions, ack beyond cursor)
//     ⇒ Open error; the caller must stop ingestion+dispatch and surface it.
//     EVERY source-state transition validates on its own (b-F3): a first
//     page and a snapshot-carried source get the same ack≤cursor /
//     events≤cursor bars as an established one, and no transition may
//     lower an established head — including via a snapshot, which is only
//     legal at the one position compaction writes it (the first record
//     after the header; compaction rewrites the journal wholesale, it
//     never appends one behind existing content).
//   - File MISSING while the enrolled-sources anchor (<notify-store>.sources)
//     exists ⇒ the ledger was deleted after the controller had enrolled
//     workers; refusing (a prior ledger may have committed ids the phone
//     already saw). Only a pristine controller (neither file present) starts
//     a fresh ledger at id 1.
//   - File present but ZERO bytes ⇒ the SAME witness policy (b-F1): a
//     TRUNCATED established journal produces exactly this state, so
//     refuse while the sources witness exists. A pristine controller has
//     neither file, and the legitimate crash-between-create-and-header
//     window occurs only on a first arm (before any enrollment persisted
//     a witness) — there, re-initializing at head 0 loses nothing.
//
// Head non-regression: ids are allocated as head+1 under the commit mutex in
// commit order, are contiguous 1..head (retained suffix [firstID..head] after
// prefix truncation), and the counter is reconstructed from the journal on
// every load. A truncated (tail-discarded) reload observes exactly the last
// committed head; a healthy reload observes the same head it had.
//
// ---------------------------------------------------------------------------
// RETENTION, DEDUPE SURVIVAL, AND GAPS
// ---------------------------------------------------------------------------
//
// Retention (prefix truncation only — never interior holes): when retained
// events exceed the configured bound (default 50_000; §9.8 freezes no
// central-ledger number — this default is an S3-documented, operator-tunable
// choice sized to cover the §9.8 worker bar of 10_000/worker for a small
// fleet), the ledger COMPACTS: header + one `snapshot` record (the retained
// contiguous suffix + full per-source states) written to a temp file, fsync'd,
// atomically renamed over the journal. A crash before the rename leaves the
// old journal intact (valid, just longer); after it, the compacted state
// (identical head, fewer retained events). Compaction failure never
// invalidates the already-durable page commit that triggered it.
//
// Dedupe knowledge OUTLIVES public-record truncation: each source's
// {epoch, LowSeq, HighSeq} is part of the source STATE that compaction keeps
// verbatim — a re-pulled old page after controller restart + truncation still
// dedupes (the re-pull is a no-op, never a re-insert). Per source the dedupe
// key is (epoch, seq ∈ [LowSeq, HighSeq]); epochs are separate namespaces by
// construction (an epoch change MUST go through ResetSourceEpoch first —
// CommitPage refuses an epoch mismatch).
//
// Source gaps (worker overflow / rotation / our own truncation) are recorded
// in the source state so S5 can serve public `coverage.gaps` accurately:
//   - worker_prefix_lost: the feed's meta.FirstSeq jumped past our committed
//     cursor+1 (the worker evicted/lost records we never ingested) — closed
//     range [cursor+1, FirstSeq-1] under the current epoch;
//   - epoch_rotation: the feed's epoch changed — the old epoch's un-ingested
//     tail is [oldCursor+1, …] with an UNKNOWN upper bound (open_end; the
//     worker cannot name the old epoch's final seq);
//   - public_floor: compaction advances a per-source floor naming the oldest
//     source seq whose central event is still publicly retained (our own
//     truncation, distinguishable from a worker-side loss).
//
// Secret hygiene: the ledger stores worker ids/names, epochs, seqs, notice
// payloads — NEVER feed tokens (the token lives only in the source registry's
// private entries and the in-flight fetch headers).

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

// Ledger journal record kinds.
const (
	ledgerRecHeader      = "ledger"      // first line: {"v":1,"type":"ledger",...}
	ledgerRecPage        = "page"        // one page commit: events + full source state
	ledgerRecAck         = "ack"         // worker-accepted watermark (post-commit)
	ledgerRecEpochReset  = "epoch_reset" // source replacement: gap + cursor reset
	ledgerRecSnapshot    = "snapshot"    // compaction checkpoint: full state
	notifyLedgerSchema   = 1
	notifyLedgerGapCap   = 64 // per-source retained gap records (ol dropped)
	notifyLedgerFallback = 50_000
)

// NotifyEvent is one committed central event — the merged-history unit and
// (by design) the persisted dispatch intent: the gating inputs S4 needs ride
// the record itself, committed atomically with it. Timestamps stay NUMERIC
// int64 internally (v4 Position C); the PUBLIC history DTO stringifies at its
// boundary (S5). Label and ui_url are computed at serve time from the stored
// worker name / the controller's host pattern, never persisted.
type NotifyEvent struct {
	ID int64 `json:"id"` // central id, allocated in commit order, contiguous 1..head

	// v3 base fields (daemon-level notices carry empty sessionID/root/project
	// by design — mirrored from the worker record verbatim).
	Type      string `json:"type"`
	SessionID string `json:"sessionID"`
	Root      string `json:"root"`
	Project   string `json:"project"`
	Title     string `json:"title"`
	Detail    string `json:"detail"`
	Ts        int64  `json:"ts"` // detection ts, unix millis (numeric internal)

	// v4 additive fields.
	Kind       string `json:"kind"` // the §9.1 condition vocabulary, mapped at ingest
	Count      int    `json:"count"`
	WorkerID   string `json:"worker_id"`
	WorkerName string `json:"worker_name"`
	Epoch      string `json:"epoch"`
	Seq        int64  `json:"seq"`

	// Gating inputs (the dispatch-intent payload for S4; v4 §3.4 rungs 2-4).
	Attended        bool   `json:"attended"`
	IdleSec         int    `json:"idleSec"`
	ProfileEligible bool   `json:"profileEligible"`
	CooldownKey     string `json:"cooldownKey"`
}

// NotifySourceGap is one recorded source-coverage gap (internal shape; S5
// maps to the public coverage.gaps entry).
type NotifySourceGap struct {
	Epoch   string `json:"epoch"`
	FromSeq int64  `json:"from_seq"`
	ToSeq   int64  `json:"to_seq"`
	// OpenEnd marks an unknown upper bound (epoch rotation: the departed
	// epoch's final seq is unknowable). ToSeq then carries FromSeq and the
	// range means "at least one missing".
	OpenEnd bool   `json:"open_end,omitempty"`
	Reason  string `json:"reason"` // worker_prefix_lost | epoch_rotation
}

// notifySourceState is a source's FULL committed state — the unit that makes
// cursor/dedupe/gap travel atomically with every page commit.
type notifySourceState struct {
	SourceID   string `json:"source_id"`
	WorkerID   string `json:"worker_id"`
	WorkerName string `json:"worker_name"`
	// Epoch is the committed source epoch ("" until the first commit).
	Epoch string `json:"epoch,omitempty"`
	// LowSeq is the dedupe floor: the first seq ingested under Epoch.
	LowSeq int64 `json:"low_seq,omitempty"`
	// HighSeq is the committed cursor: every seq in [LowSeq, HighSeq] under
	// Epoch is either committed as events or consumed by a recorded gap.
	HighSeq int64 `json:"high_seq,omitempty"`
	// AckedSeq is the watermark the worker last accepted (≤ HighSeq).
	AckedSeq int64 `json:"acked_seq,omitempty"`
	// Gaps observed for this source (bounded, oldest dropped).
	Gaps []NotifySourceGap `json:"gaps,omitempty"`
	// PublicFloor is the oldest source seq whose central event is still
	// retained after OUR truncation (0 = nothing truncated for this source).
	PublicFloor int64 `json:"public_floor,omitempty"`
}

// ledgerRecord is one journal line. Exactly one of the payload groups is set,
// per Type.
type ledgerRecord struct {
	V    int    `json:"v"`
	Type string `json:"type"`

	// page: the committed events plus the source's full post-commit state.
	Events []NotifyEvent      `json:"events,omitempty"`
	Source *notifySourceState `json:"source,omitempty"`

	// ack: the worker-accepted watermark.
	AckSource string `json:"ack_source,omitempty"`
	AckSeq    int64  `json:"ack_seq,omitempty"`

	// epoch_reset: source replacement (gap under the OLD epoch, cursor reset).
	ResetSource string           `json:"reset_source,omitempty"`
	ResetFrom   string           `json:"reset_from,omitempty"` // departed epoch
	ResetTo     string           `json:"reset_to,omitempty"`   // new epoch
	ResetGap    *NotifySourceGap `json:"reset_gap,omitempty"`

	// snapshot: the compaction checkpoint (full state).
	Snapshot *ledgerSnapshot `json:"snapshot,omitempty"`
}

// ledgerSnapshot is the full ledger state as written by compaction.
type ledgerSnapshot struct {
	Head    int64               `json:"head"`
	Events  []NotifyEvent       `json:"events"`
	Sources []notifySourceState `json:"sources"`
}

// notifyLedger is the mutex-guarded central journal. A zero/path-less ledger
// is memory-only (tests/e2e posture — never used for production ingestion;
// StartNotifyIngest refuses a memory-only ledger).
type notifyLedger struct {
	mu   sync.Mutex
	path string // "" = memory-only

	// f is the O_APPEND handle (nil when memory-only). All writes happen
	// under mu; committedEnd tracks the durable prefix length.
	f            *os.File
	committedEnd int64

	head    int64
	firstID int64 // oldest retained event id (0 when nothing retained)
	events  []NotifyEvent
	sources map[string]*notifySourceState

	retention     int
	compactFailed bool // sticky: last compaction attempt failed (commit stays durable)

	// poisoned is sticky-FATAL (b-F4): a rollback failure left journal
	// bytes of unknown extent beyond the committed prefix, so every
	// further mutation is refused until a successful reopen
	// (armNotifyLedger / LoadNotifyStore) recovers the ledger from the
	// on-disk journal. See ErrNotifyLedgerPoisoned.
	poisoned error

	// testWrite/testSync/testTruncate are TEST-ONLY failure-injection
	// seams (b-F4); nil in production — zero behavior change. When set,
	// each REPLACES the corresponding file operation in appendLine so
	// tests can fail Write/Sync/Truncate deterministically, including
	// short writes with nil errors (they receive the real handle and may
	// delegate to it for partial-byte realism).
	testWrite    func(f *os.File, b []byte) (int, error)
	testSync     func(f *os.File) error
	testTruncate func(f *os.File, size int64) error
}

// newMemoryNotifyLedger builds a memory-only ledger (no anchor, no journal,
// no persistence). For tests and the pre-LoadNotifyStore Daemon zero value
// only — restart semantics do not apply.
func newMemoryNotifyLedger() *notifyLedger {
	return &notifyLedger{
		sources:   make(map[string]*notifySourceState),
		retention: notifyLedgerFallback,
	}
}

// armNotifyLedger loads (or initializes) the ledger at path, using
// sourcesWitness (the enrolled-sources anchor path) for the missing-file
// fail-closed witness. See the recovery proof in the file header for the
// load rules. Memory-only when path == "".
func armNotifyLedger(path, sourcesWitness string, retention int) (*notifyLedger, error) {
	if retention <= 0 {
		retention = notifyLedgerFallback
	}
	l := &notifyLedger{path: path, sources: make(map[string]*notifySourceState), retention: retention}
	if path == "" {
		return l, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("notify ledger %s: unreadable: %w", path, err)
		}
		// Missing file: fail CLOSED when the sources witness says a prior
		// controller had enrolled workers — a ledger that may have committed
		// ids was destroyed, and silently restarting at id 1 would regress
		// the head every client already saw (brief §3 "Central ledger
		// lost/corrupt": restore/recovery disposition, never a reset).
		if _, serr := os.Stat(sourcesWitness); serr == nil {
			return nil, fmt.Errorf("notify ledger %s: MISSING while enrolled sources exist at %s — refusing to restart global ids at 1 (restore the ledger or remove both files deliberately)", path, sourcesWitness)
		} else if !os.IsNotExist(serr) {
			return nil, fmt.Errorf("notify ledger %s: cannot stat sources witness %s: %w", path, sourcesWitness, serr)
		}
		// Pristine controller: initialize eagerly (header only) so a later
		// "ledger missing + sources exist" state unambiguously means deletion.
		if err := l.initFile(); err != nil {
			return nil, err
		}
		if err := l.openAppend(); err != nil {
			return nil, err
		}
		return l, nil
	}
	if len(raw) == 0 {
		// Zero-byte journal: the SAME witness policy as the missing-file
		// bar (b-F1). A TRUNCATED established journal produces exactly
		// this state, and re-initializing would silently regress the
		// global head while enrolled sources exist. A pristine controller
		// has neither file; the legitimate crash-between-create-and-header
		// window occurs only on a first arm, when no enrollment has yet
		// persisted a sources witness (the anchor is created lazily by
		// the first enrollment/ineligibility mutation).
		if _, serr := os.Stat(sourcesWitness); serr == nil {
			return nil, fmt.Errorf("notify ledger %s: ZERO bytes (truncated?) while enrolled sources exist at %s — refusing to restart global ids at 1 (restore the ledger or remove both files deliberately)", path, sourcesWitness)
		} else if !os.IsNotExist(serr) {
			return nil, fmt.Errorf("notify ledger %s: cannot stat sources witness %s: %w", path, sourcesWitness, serr)
		}
		if err := l.initFile(); err != nil {
			return nil, err
		}
		if err := l.openAppend(); err != nil {
			return nil, err
		}
		return l, nil
	}
	// Replay. Bytes after the last '\n' are the uncommitted tail (a torn
	// partial append): discard + truncate. Any COMPLETE line that fails to
	// parse or validate is corruption: fail closed.
	validEnd := bytes.LastIndexByte(raw, '\n') + 1
	if validEnd == 0 {
		return nil, fmt.Errorf("notify ledger %s: no newline-terminated first line (not a ledger file)", path)
	}
	if validEnd < len(raw) {
		log.Printf("notify ledger %s: discarding %d-byte uncommitted tail (crash mid-append) and truncating", path, len(raw)-validEnd)
		if err := os.Truncate(path, int64(validEnd)); err != nil {
			return nil, fmt.Errorf("notify ledger %s: truncate torn tail: %w", path, err)
		}
		raw = raw[:validEnd]
	}
	lines := bytes.Split(raw, []byte("\n")) // last element is "" (file ends with '\n')
	for i, line := range lines {
		if len(line) == 0 {
			if i != len(lines)-1 {
				// The writer never emits blank lines; an interior one is
				// corruption (and would let a headerless journal hide its
				// first record behind a leading blank — b-F3 grammar).
				return nil, fmt.Errorf("notify ledger %s: corrupt at line %d: empty interior line", path, i+1)
			}
			continue
		}
		if err := l.replayRecord(line, i+1); err != nil {
			return nil, fmt.Errorf("notify ledger %s: corrupt at line %d: %w", path, i+1, err)
		}
	}
	if l.firstID > 0 && len(l.events) == 0 {
		return nil, fmt.Errorf("notify ledger %s: corrupt: firstID %d set but no events retained", path, l.firstID)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("notify ledger %s: open for append: %w", path, err)
	}
	l.f = f
	l.committedEnd = int64(validEnd)
	return l, nil
}

// openAppend (re)opens the journal for appending (O_APPEND — every Write
// lands at the durable tail regardless of offset state).
func (l *notifyLedger) openAppend() error {
	f, err := os.OpenFile(l.path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("notify ledger %s: open for append: %w", l.path, err)
	}
	l.f = f
	return nil
}

// initFile creates the journal with its header line (0600, synced).
func (l *notifyLedger) initFile() error {
	if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err != nil {
		return fmt.Errorf("notify ledger %s: %w", l.path, err)
	}
	f, err := os.OpenFile(l.path, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("notify ledger %s: create: %w", l.path, err)
	}
	defer f.Close()
	hdr, err := json.Marshal(ledgerRecord{V: notifyLedgerSchema, Type: ledgerRecHeader})
	if err != nil {
		return err
	}
	line := append(hdr, '\n')
	if _, err := f.Write(line); err != nil {
		return fmt.Errorf("notify ledger %s: write header: %w", l.path, err)
	}
	if err := f.Sync(); err != nil {
		return fmt.Errorf("notify ledger %s: sync header: %w", l.path, err)
	}
	syncDir(filepath.Dir(l.path))
	l.committedEnd = int64(len(line))
	return nil
}

// syncDir best-effort fsync of a directory (makes a just-rename'd entry
// durable on platforms where that matters; failures are logged, not fatal —
// the fsync'd file contents remain the primary durability claim).
func syncDir(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		log.Printf("notify ledger: directory sync %s: %v (best-effort)", dir, err)
	}
}

// replayRecord applies one complete journal line to the in-memory state.
// Every structural violation is an error → the caller fails closed.
//
// Journal grammar (b-F3): the header is line 1, exactly once; pages/acks/
// epoch_resets follow; a snapshot is legal at exactly ONE position — the
// first record after the header (the compacted-file shape), because
// compaction rewrites the journal wholesale (tmp+rename) and never appends
// a snapshot behind existing records. Every source-state transition
// validates on its own — "first" or "snapshot-carried" is no exemption.
func (l *notifyLedger) replayRecord(line []byte, lineNo int) error {
	var r ledgerRecord
	if err := json.Unmarshal(line, &r); err != nil {
		return fmt.Errorf("malformed JSON: %w", err)
	}
	if r.V != notifyLedgerSchema {
		return fmt.Errorf("schema %d != %d", r.V, notifyLedgerSchema)
	}
	// b-F3(i): the header anchors the grammar — a journal whose first
	// record is anything else never replayed from a writer's output.
	if lineNo == 1 && r.Type != ledgerRecHeader {
		return fmt.Errorf("first record is %q — the ledger header must be the first line", r.Type)
	}
	switch r.Type {
	case ledgerRecHeader:
		if lineNo != 1 {
			return fmt.Errorf("header not first line")
		}
		return nil
	case ledgerRecPage:
		if r.Source == nil {
			return fmt.Errorf("page record without source state")
		}
		for i, ev := range r.Events {
			if ev.ID != l.head+1+int64(i) {
				return fmt.Errorf("event id %d breaks contiguity (want %d)", ev.ID, l.head+1+int64(i))
			}
			if ev.Ts == 0 || ev.Type == "" {
				return fmt.Errorf("event %d missing type/ts", ev.ID)
			}
		}
		st := r.Source
		// b-F3(ii): EVERY source-state transition validates independently
		// of whether prior state exists — a source's FIRST page gets the
		// same bars: ack may never exceed the cursor, and no event of the
		// transition may outrun the cursor it rode.
		if st.AckedSeq > st.HighSeq {
			return fmt.Errorf("source %s ack %d beyond cursor %d", st.SourceID, st.AckedSeq, st.HighSeq)
		}
		if n := len(r.Events); n > 0 && r.Events[n-1].Seq > st.HighSeq {
			return fmt.Errorf("source %s event seq %d beyond cursor %d", st.SourceID, r.Events[n-1].Seq, st.HighSeq)
		}
		if prev, ok := l.sources[st.SourceID]; ok {
			// An epoch change MUST ride an epoch_reset record; a page that
			// silently switches epoch is corruption (a reset cursor would
			// otherwise masquerade as continuity).
			if prev.Epoch != "" && st.Epoch != prev.Epoch {
				return fmt.Errorf("source %s epoch changed %q -> %q without a reset record", st.SourceID, prev.Epoch, st.Epoch)
			}
			if st.HighSeq < prev.HighSeq {
				return fmt.Errorf("source %s cursor regressed %d -> %d", st.SourceID, prev.HighSeq, st.HighSeq)
			}
		}
		l.appendEventsLocked(r.Events)
		l.sources[st.SourceID] = stateClone(st)
		return nil
	case ledgerRecAck:
		st, ok := l.sources[r.AckSource]
		if !ok {
			return fmt.Errorf("ack for unknown source %q", r.AckSource)
		}
		if r.AckSeq > st.HighSeq {
			return fmt.Errorf("ack %d beyond committed cursor %d (ACK may only follow a commit)", r.AckSeq, st.HighSeq)
		}
		if r.AckSeq > st.AckedSeq {
			st.AckedSeq = r.AckSeq
		}
		return nil
	case ledgerRecEpochReset:
		// d-F6 (write/replay symmetry): ResetSourceEpoch legally writes a
		// reset for a source with no prior state; replay accepts exactly
		// that — the reset ESTABLISHES the source under the new epoch
		// (the same rule as a first page). A legally-writable journal must
		// always reload. A departed-epoch mismatch against an ESTABLISHED
		// source remains corruption.
		st, ok := l.sources[r.ResetSource]
		if !ok {
			st = &notifySourceState{SourceID: r.ResetSource}
			l.sources[r.ResetSource] = st
		}
		if st.Epoch != "" && st.Epoch != r.ResetFrom {
			return fmt.Errorf("epoch_reset departs %q but committed epoch is %q", r.ResetFrom, st.Epoch)
		}
		if r.ResetGap != nil {
			st.Gaps = appendGapBounded(st.Gaps, *r.ResetGap)
		}
		st.Epoch = r.ResetTo
		st.LowSeq, st.HighSeq, st.AckedSeq = 0, 0, 0
		return nil
	case ledgerRecSnapshot:
		if r.Snapshot == nil {
			return fmt.Errorf("snapshot record without payload")
		}
		// b-F3(iii): a snapshot is legal at exactly ONE position — the
		// first record after the header. Compaction rewrites the journal
		// wholesale (tmp+rename); it never appends a snapshot behind
		// existing records, so ANY snapshot behind prior content (head,
		// events, or sources) is corruption: the trailing head-LOWERING
		// snapshot (previously only head increases were rejected), the
		// mid-journal snapshot carrying regressed cursors — all of it.
		if l.head > 0 || len(l.events) > 0 || len(l.sources) > 0 {
			return fmt.Errorf("snapshot behind prior journal content (head %d, %d events, %d sources) — a snapshot may only be the first record after the header (compaction rewrites the journal wholesale)", l.head, len(l.events), len(l.sources))
		}
		snap := r.Snapshot
		for i := 1; i < len(snap.Events); i++ {
			if snap.Events[i].ID != snap.Events[i-1].ID+1 {
				return fmt.Errorf("snapshot events not contiguous at id %d", snap.Events[i].ID)
			}
		}
		if n := len(snap.Events); n > 0 && snap.Head != snap.Events[n-1].ID {
			return fmt.Errorf("snapshot head %d != last event id %d", snap.Head, snap.Events[n-1].ID)
		}
		// b-F3(ii): snapshot-carried source states validate independently
		// too — no establishing exemption. Ack may never exceed the
		// cursor, and the cursor may never sit below a retained event of
		// the same (worker, epoch): those events were ingested THROUGH
		// it, so a lower cursor is a regressed cursor.
		maxSeq := make(map[string]int64) // workerID\x00epoch -> max retained seq
		for _, ev := range snap.Events {
			k := ev.WorkerID + "\x00" + ev.Epoch
			if ev.Seq > maxSeq[k] {
				maxSeq[k] = ev.Seq
			}
		}
		for i := range snap.Sources {
			st := &snap.Sources[i]
			if st.AckedSeq > st.HighSeq {
				return fmt.Errorf("snapshot source %s ack %d beyond cursor %d", st.SourceID, st.AckedSeq, st.HighSeq)
			}
			if st.Epoch != "" {
				if mx, ok := maxSeq[st.WorkerID+"\x00"+st.Epoch]; ok && st.HighSeq < mx {
					return fmt.Errorf("snapshot source %s cursor %d below its retained event seq %d (regressed cursor)", st.SourceID, st.HighSeq, mx)
				}
			}
		}
		// The compacted-file shape (header + one snapshot, no prior
		// records): the snapshot establishes head/firstID itself; ids may
		// only ever move FORWARD within a journal, so a first-record
		// snapshot is the legitimate post-compaction baseline, not a reset.
		l.events = append([]NotifyEvent{}, snap.Events...)
		if n := len(l.events); n > 0 {
			l.firstID = l.events[0].ID
			l.head = l.events[n-1].ID
		} else {
			l.head = snap.Head // everything truncated; head preserved
		}
		l.sources = make(map[string]*notifySourceState, len(snap.Sources))
		for i := range snap.Sources {
			st := stateClone(&snap.Sources[i])
			l.sources[st.SourceID] = st
		}
		return nil
	default:
		return fmt.Errorf("unknown record type %q", r.Type)
	}
}

// appendEventsLocked extends the retained window (compaction never runs
// during replay — retention is enforced on live commits only).
func (l *notifyLedger) appendEventsLocked(evs []NotifyEvent) {
	l.events = append(l.events, evs...)
	l.head += int64(len(evs))
	if l.firstID == 0 && len(l.events) > 0 {
		l.firstID = l.events[0].ID
	}
}

// stateClone deep-copies a source state (gaps included).
func stateClone(st *notifySourceState) *notifySourceState {
	out := *st
	out.Gaps = append([]NotifySourceGap(nil), st.Gaps...)
	return &out
}

// appendGapBounded appends a gap, dropping the OLDEST beyond the cap.
func appendGapBounded(gaps []NotifySourceGap, g NotifySourceGap) []NotifySourceGap {
	gaps = append(gaps, g)
	if len(gaps) > notifyLedgerGapCap {
		gaps = gaps[len(gaps)-notifyLedgerGapCap:]
	}
	return gaps
}

// appendLine is the durability boundary: one Write + one Sync; on ANY
// failure the file is truncated back to the committed prefix and the error
// returned (the commit then never happened). Caller holds mu.
//
// Failure-injection seams (testWrite/testSync/testTruncate) are test-only
// (b-F4): nil in production, zero behavior change.
func (l *notifyLedger) appendLine(rec ledgerRecord) error {
	if l.path == "" {
		return nil // memory-only: no durability claim
	}
	if l.poisoned != nil {
		// b-F4: sticky-fatal — a previous rollback failed and left journal
		// bytes of unknown extent; any further append would commit BEHIND
		// the fragment. Only a successful reopen (armNotifyLedger, which
		// recovers from the on-disk journal) clears this — by replacing
		// the ledger object, never by retrying.
		return fmt.Errorf("notify ledger %s: %w (previous: %v)", l.path, ErrNotifyLedgerPoisoned, l.poisoned)
	}
	if l.f == nil {
		return fmt.Errorf("notify ledger: no append handle")
	}
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	line := append(b, '\n')
	write := l.f.Write
	if l.testWrite != nil {
		write = func(p []byte) (int, error) { return l.testWrite(l.f, p) }
	}
	n, werr := write(line)
	if werr == nil && n == len(line) {
		sync := l.f.Sync
		if l.testSync != nil {
			sync = func() error { return l.testSync(l.f) }
		}
		werr = sync()
		if werr == nil {
			l.committedEnd += int64(len(line))
			return nil
		}
	} else if werr == nil {
		// c-F2: synthesize an explicit short-write error — never a nil
		// wrap (the degenerate %!w(<nil>) message).
		werr = fmt.Errorf("short write: %d of %d bytes", n, len(line))
	}
	// Partial write or sync failure: roll the file back to the committed
	// prefix so no torn bytes survive into the next append.
	truncate := l.f.Truncate
	if l.testTruncate != nil {
		truncate = func(size int64) error { return l.testTruncate(l.f, size) }
	}
	if terr := truncate(l.committedEnd); terr != nil {
		// b-F4: the rollback FAILED — journal bytes of unknown extent
		// survive beyond the committed prefix. Poison the ledger: the
		// next append would commit BEHIND the fragment, Sync would
		// succeed, the worker would be ACKed — and the journal would be
		// unreplayable after a restart. FATAL (ErrNotifyLedgerPoisoned),
		// never a retryable source failure; only a successful reopen
		// recovers.
		l.poisoned = fmt.Errorf("append failed (%v); rollback to %d failed (%v)", werr, l.committedEnd, terr)
		return fmt.Errorf("notify ledger %s: %w: %v", l.path, ErrNotifyLedgerPoisoned, l.poisoned)
	}
	return fmt.Errorf("append (rolled back to committed prefix): %w", werr)
}

// ---------------------------------------------------------------------------
// Commit surface (the S3 pull loop is the only caller)
// ---------------------------------------------------------------------------

// ErrEpochMismatch is returned by CommitPage when the page's epoch differs
// from the committed epoch — the caller MUST route through
// ResetSourceEpoch first (source replacement is an explicit, gap-recording
// transition, never a silent cursor jump).
var ErrEpochMismatch = fmt.Errorf("notify ledger: page epoch does not match the committed source epoch (reset first)")

// ErrNotifyLedgerPoisoned marks a FATAL ledger condition (b-F4): a failed
// rollback left journal bytes of unknown extent beyond the committed
// prefix, so the ledger refuses ALL further mutations until a successful
// reopen (armNotifyLedger via LoadNotifyStore) recovers it from the
// on-disk journal. Callers must classify it as fatal — NOT a retryable
// per-source failure (retrying cannot repair the fragment; only recovery
// from the durable prefix can).
var ErrNotifyLedgerPoisoned = errors.New("notify ledger poisoned (failed rollback — reopen required)")

// notifyPageCommit is one page's ingest intent: seq-ascending records under
// one epoch, the feed's resume cursor (AdvanceTo), and an optional gap that
// this fetch observed (worker-side prefix loss).
type notifyPageCommit struct {
	SourceID   string
	WorkerID   string
	WorkerName string
	Epoch      string
	Records    []NotifyEvent // pre-id events (ID ignored, assigned here)
	AdvanceTo  int64         // the feed's nextSince for this page
	Gap        *NotifySourceGap
}

// CommitPage ingests one feed page atomically: dedupe-absorb replays, assign
// central ids in commit order, persist events + cursor + dedupe + gap as ONE
// journal line. All-or-nothing: on any error the ledger is unchanged.
//
// Rules enforced (violations are errors, never silent):
//   - epoch must match the committed source epoch (or be the first commit);
//   - after dedupe filtering (seq ≤ HighSeq under the same epoch), the
//     remaining records are strictly ascending and start above HighSeq;
//   - AdvanceTo (the feed cursor) is ≥ the last new record's seq;
//   - every fresh event carries the replay-required event invariants
//     (Type != "", Ts != 0) — write/replay symmetry: the journal can never
//     contain a line the replay grammar would reject;
//   - the ENTIRE consumed interval (committed cursor, new cursor] is
//     accounted for (b-F1): every seq in it is either a fresh record from
//     this page or covered by an explicit same-epoch gap entry — leading
//     holes, interior holes between consecutive fresh records, and trailing
//     jumps past the last covered seq (c-F6) are all refused;
//   - a pure replay (no new records, no state change) is an idempotent no-op.
func (l *notifyLedger) CommitPage(c notifyPageCommit) ([]NotifyEvent, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if c.Epoch == "" {
		return nil, fmt.Errorf("commit: empty epoch")
	}
	var base *notifySourceState
	if prev, ok := l.sources[c.SourceID]; ok {
		base = stateClone(prev)
	} else {
		base = &notifySourceState{SourceID: c.SourceID}
	}
	if c.WorkerID != "" {
		base.WorkerID = c.WorkerID
		base.WorkerName = c.WorkerName
	}
	if base.Epoch != "" && base.Epoch != c.Epoch {
		return nil, fmt.Errorf("%w: source %s committed %q, page %q", ErrEpochMismatch, c.SourceID, base.Epoch, c.Epoch)
	}
	// Input shape: the feed serves strictly ascending pages.
	for i := 1; i < len(c.Records); i++ {
		if c.Records[i].Seq <= c.Records[i-1].Seq {
			return nil, fmt.Errorf("commit: input records not strictly ascending (%d after %d)", c.Records[i].Seq, c.Records[i-1].Seq)
		}
	}
	// Dedupe: absorb records at or below the committed cursor (same-epoch
	// replay). The pull loop retries pages from the old cursor after
	// failures; the feed also re-serves a page on cursor races — one central
	// event per (source, epoch, seq) under all of it.
	fresh := make([]NotifyEvent, 0, len(c.Records))
	for _, r := range c.Records {
		if r.Seq <= base.HighSeq {
			continue // replay under the same epoch: absorbed
		}
		ev := r
		ev.ID = l.head + 1 + int64(len(fresh))
		ev.Epoch = c.Epoch
		ev.WorkerID = c.WorkerID
		ev.WorkerName = c.WorkerName
		fresh = append(fresh, ev)
	}
	// Write/replay validation symmetry (tier1_b:F1): replayRecord rejects
	// a page event whose Type is empty or Ts is 0 ("event %d missing
	// type/ts"), so the write side refuses those shapes HERE — before
	// appendLine, before any cursor/memory advancement. The journal can
	// never contain a line the replay grammar would reject: without this
	// bar a correctly-identified page could commit + ACK (the worker
	// trims), and the controller would then refuse to restart from its
	// own journal — the controller is the trust boundary for worker-fed
	// data.
	//
	// Enumeration of replayRecord's page checks and their write-side
	// guarantee, so the mirror stays total:
	//   - event id contiguity (head+1+i): by construction — ids are
	//     assigned above under the commit mutex;
	//   - Type != "" and Ts != 0: worker-fed fields carried verbatim —
	//     the ONLY replay bar the write side could violate, enforced
	//     right below;
	//   - source state present, ack ≤ cursor, last event seq ≤ cursor,
	//     epoch match, cursor non-regression: all by construction
	//     (Source is always set below, newHigh ≥ max(lastNew, AdvanceTo)
	//     ≥ the committed ack/cursor, and the epoch mismatch returned
	//     above).
	// Absorbed replays (seq ≤ HighSeq) never ride the line; each was
	// validated at its own commit.
	for i := range fresh {
		if fresh[i].Type == "" || fresh[i].Ts == 0 {
			return nil, fmt.Errorf("commit: event %d (seq %d) missing type/ts (type %q, ts %d) — the journal only ever holds lines the replay grammar accepts", fresh[i].ID, fresh[i].Seq, fresh[i].Type, fresh[i].Ts)
		}
	}
	lastNew := base.HighSeq
	if n := len(fresh); n > 0 {
		lastNew = fresh[n-1].Seq
	}
	if len(fresh) > 0 && c.AdvanceTo < lastNew {
		return nil, fmt.Errorf("commit: feed cursor %d below last record %d (malformed page)", c.AdvanceTo, lastNew)
	}
	// The ENTIRE consumed interval (base.HighSeq, newHigh] must be
	// accounted for (b-F1): every seq in it is either a fresh record from
	// this page or covered by an explicit SAME-EPOCH gap entry. The old
	// rule covered only the trailing edge (AdvanceTo past the last
	// record), so a page [seq 4] at cursor 2 could commit silently and
	// strand seq 3 forever (its later delivery is replay-discarded). The
	// ledger is the transactional authority, so it carries this bar
	// itself. (An AdvanceTo at/below the committed cursor with no fresh
	// records is a fully-stale page: the interval is empty, this passes,
	// and it is absorbed below as a no-op — the dedupe contract.)
	newHigh := lastNew
	if c.AdvanceTo > newHigh {
		newHigh = c.AdvanceTo
	}
	if err := explainIntervalHoles(base.HighSeq, newHigh, fresh, c.Gap, c.Epoch); err != nil {
		return nil, err
	}
	if len(fresh) == 0 && newHigh == base.HighSeq && c.Gap == nil {
		return nil, nil // pure replay, nothing to persist
	}
	// Build the post-commit state.
	base.Epoch = c.Epoch
	if base.LowSeq == 0 && len(fresh) > 0 {
		base.LowSeq = fresh[0].Seq
	}
	base.HighSeq = newHigh
	if c.Gap != nil {
		base.Gaps = appendGapBounded(base.Gaps, *c.Gap)
	}
	rec := ledgerRecord{V: notifyLedgerSchema, Type: ledgerRecPage, Events: fresh, Source: base}
	if err := l.appendLine(rec); err != nil {
		return nil, err
	}
	// Durable: advance memory.
	l.appendEventsLocked(fresh)
	l.sources[c.SourceID] = base
	if err := l.enforceRetentionLocked(); err != nil {
		// The commit is durable; only compaction failed. Sticky-flag it and
		// retry on the next commit — ingestion must not stop over it.
		l.compactFailed = true
		log.Printf("notify ledger %s: compaction failed (commit is durable; will retry): %v", l.path, err)
	}
	return fresh, nil
}

// gapCoversClosed reports whether g covers the CLOSED seq range [from, to]
// under epoch. Only a SAME-EPOCH gap counts (an epoch_rotation gap names a
// departed namespace and covers nothing in the current one); the gap must
// start at or before the range and extend through its end. An OpenEnd gap
// covers onward from FromSeq by construction (unknown upper bound).
func gapCoversClosed(g *NotifySourceGap, epoch string, from, to int64) bool {
	if g == nil || g.Epoch != epoch || g.FromSeq > from {
		return false
	}
	return g.OpenEnd || g.ToSeq >= to
}

// explainIntervalHoles enforces the b-F1 interval bar for one CommitPage:
// every seq in the consumed interval (prevHigh, newHigh] must be covered by
// a fresh record from the page or an explicit same-epoch gap entry. fresh
// seqs are strictly ascending and all > prevHigh (the input-shape and
// dedupe filters upstream guarantee both), so one walk from prevHigh+1
// decides every hole class:
//
//   - LEADING hole: the first fresh seq sits above prevHigh+1 and no gap
//     covers [prevHigh+1, firstFresh-1];
//   - INTERIOR hole: consecutive fresh seqs a, b with b > a+1 and no gap
//     covering [a+1, b-1];
//   - TRAILING jump: newHigh (AdvanceTo) past the last covered seq — the
//     c-F6 rule, now one case of the same walk.
//
// A nil return means the interval is fully explained; every refusal names
// the uncovered range — a hole is NEVER silently committed.
func explainIntervalHoles(prevHigh, newHigh int64, fresh []NotifyEvent, gap *NotifySourceGap, epoch string) error {
	if newHigh <= prevHigh {
		return nil // empty interval: nothing consumed, nothing to explain
	}
	want := prevHigh + 1
	for i := range fresh {
		s := fresh[i].Seq
		if s > want {
			kind := "interior hole"
			if i == 0 {
				kind = "leading hole"
			}
			if !gapCoversClosed(gap, epoch, want, s-1) {
				return fmt.Errorf("commit: %s [%d,%d] in the consumed interval (cursor %d, next record %d) has no same-epoch gap covering it — refusing to silently skip seqs", kind, want, s-1, prevHigh, s)
			}
		}
		want = s + 1
	}
	if want <= newHigh {
		// Trailing jump (c-F6): the feed cursor moved past everything
		// fresh — only a covering gap may explain the remainder.
		if gap == nil {
			return fmt.Errorf("commit: feed cursor %d beyond last record %d without a covering gap", newHigh, want-1)
		}
		if !gapCoversClosed(gap, epoch, want, newHigh) {
			// A closed gap ending short of the claimed cursor leaves
			// (ToSeq, cursor] silently skipped; an OpenEnd gap covers
			// onward by construction.
			return fmt.Errorf("commit: feed cursor %d beyond both the last record %d and the covering gap end %d (gap epoch %q, page epoch %q) — range (%d, %d] would be silently skipped", newHigh, want-1, gap.ToSeq, gap.Epoch, epoch, gap.ToSeq, newHigh)
		}
	}
	return nil
}

// ResetSourceEpoch records a source replacement (the feed's epoch changed —
// v4 §9.2 genuine rotation): a gap under the DEPARTED epoch for its
// un-ingested tail (open end — the old epoch's final seq is unknowable),
// then cursor/dedupe/ack reset under the new epoch. Idempotent when the
// state already carries the new epoch.
func (l *notifyLedger) ResetSourceEpoch(sourceID, newEpoch string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if newEpoch == "" {
		return fmt.Errorf("epoch reset: empty new epoch")
	}
	var base *notifySourceState
	if prev, ok := l.sources[sourceID]; ok {
		base = stateClone(prev)
	} else {
		base = &notifySourceState{SourceID: sourceID}
	}
	if base.Epoch == newEpoch {
		return nil
	}
	old := base.Epoch
	oldCursor := base.HighSeq
	var gap *NotifySourceGap
	if old != "" {
		g := NotifySourceGap{
			Epoch:   old,
			FromSeq: oldCursor + 1,
			ToSeq:   oldCursor + 1,
			OpenEnd: true,
			Reason:  "epoch_rotation",
		}
		gap = &g
	}
	if gap != nil {
		base.Gaps = appendGapBounded(base.Gaps, *gap)
	}
	base.Epoch = newEpoch
	base.LowSeq, base.HighSeq, base.AckedSeq = 0, 0, 0
	rec := ledgerRecord{
		V: notifyLedgerSchema, Type: ledgerRecEpochReset,
		ResetSource: sourceID, ResetFrom: old, ResetTo: newEpoch, ResetGap: gap,
	}
	if err := l.appendLine(rec); err != nil {
		return err
	}
	l.sources[sourceID] = base
	if old != "" {
		log.Printf("notify ledger: source %s replaced epoch %s -> %s — cursor reset, gap recorded under the departed epoch from seq %d (open end)", sourceID, shortEpoch(old), shortEpoch(newEpoch), oldCursor+1)
	}
	return nil
}

// RecordAck persists a worker-accepted watermark (post-commit only:
// seq must be ≤ the committed cursor — the structural "ACK never precedes
// its commit" bar, also enforced on journal replay). Monotone.
func (l *notifyLedger) RecordAck(sourceID string, seq int64) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	st, ok := l.sources[sourceID]
	if !ok {
		return fmt.Errorf("ack: unknown source %s", sourceID)
	}
	if seq > st.HighSeq {
		return fmt.Errorf("ack: %d beyond committed cursor %d — ACK may only follow a commit", seq, st.HighSeq)
	}
	if seq <= st.AckedSeq {
		return nil // monotone replay
	}
	if err := l.appendLine(ledgerRecord{V: notifyLedgerSchema, Type: ledgerRecAck, AckSource: sourceID, AckSeq: seq}); err != nil {
		return err
	}
	st.AckedSeq = seq
	return nil
}

// enforceRetentionLocked compacts when the retained window exceeds the
// bound: newest `retention` events + full source states as one snapshot
// record, written to a temp file (fsync) and renamed over the journal —
// the resulting journal is HEADER + SNAPSHOT ONLY (replay accepts a
// snapshot at exactly that first-record position; b-F3). Per
// source, PublicFloor advances past the dropped events (our-truncation gap
// knowledge: the oldest seq of the source's CURRENT epoch still publicly
// retained). Never called during replay.
func (l *notifyLedger) enforceRetentionLocked() error {
	if l.path == "" || int64(len(l.events)) <= int64(l.retention) {
		return nil
	}
	dropN := len(l.events) - l.retention
	droppedFor := make(map[string]bool) // workerID -> dropped at least one event (any epoch)
	for _, ev := range l.events[:dropN] {
		droppedFor[ev.WorkerID] = true
	}
	retained := append([]NotifyEvent{}, l.events[dropN:]...)
	// Oldest retained seq per (workerID, epoch) — the post-truncation floors.
	oldestRetained := make(map[string]int64)
	for _, ev := range retained {
		key := ev.WorkerID + "\x00" + ev.Epoch
		if prev, ok := oldestRetained[key]; !ok || ev.Seq < prev {
			oldestRetained[key] = ev.Seq
		}
	}
	for _, st := range l.sources {
		if !droppedFor[st.WorkerID] {
			continue
		}
		floor := int64(0)
		if seq, ok := oldestRetained[st.WorkerID+"\x00"+st.Epoch]; ok {
			floor = seq
		}
		// Nothing retained under the current epoch: everything the source
		// emitted under it is gone — floor past the newest dropped seq of
		// this source's current epoch (or 1 when even that is unknown).
		if floor == 0 {
			for _, ev := range l.events[:dropN] {
				if ev.WorkerID == st.WorkerID && ev.Epoch == st.Epoch && ev.Seq > floor {
					floor = ev.Seq // newest dropped seq of this (worker, epoch)
				}
			}
			floor++ // seqs ≤ the newest dropped one are no longer retained
			if floor <= 1 {
				floor = 1
			}
		}
		if floor > st.PublicFloor {
			st.PublicFloor = floor
		}
	}
	snap := &ledgerSnapshot{Events: retained}
	if n := len(retained); n > 0 {
		snap.Head = retained[n-1].ID
	} else {
		snap.Head = l.head
	}
	sources := make([]notifySourceState, 0, len(l.sources))
	for _, st := range l.sources {
		sources = append(sources, *stateClone(st))
	}
	snap.Sources = sources
	sort.Slice(snap.Sources, func(i, j int) bool { return snap.Sources[i].SourceID < snap.Sources[j].SourceID })

	tmp := l.path + ".compact.tmp"
	b, err := json.Marshal(ledgerRecord{V: notifyLedgerSchema, Type: ledgerRecSnapshot, Snapshot: snap})
	if err != nil {
		return err
	}
	hdr, _ := json.Marshal(ledgerRecord{V: notifyLedgerSchema, Type: ledgerRecHeader})
	content := append(append(hdr, '\n'), b...)
	content = append(content, '\n')
	if err := os.WriteFile(tmp, content, 0o600); err != nil {
		return err
	}
	tf, err := os.OpenFile(tmp, os.O_RDONLY, 0o600)
	if err != nil {
		return err
	}
	serr := tf.Sync()
	tf.Close()
	if serr != nil {
		return serr
	}
	if l.f != nil {
		l.f.Close() // the old journal handle; the rename replaces the file
		l.f = nil
	}
	if err := os.Rename(tmp, l.path); err != nil {
		// Reopen the still-intact old journal; the compaction is retried.
		if f, oerr := os.OpenFile(l.path, os.O_APPEND|os.O_WRONLY, 0o600); oerr == nil {
			l.f = f
		}
		return err
	}
	syncDir(filepath.Dir(l.path))
	f, err := os.OpenFile(l.path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("reopen after compaction: %w", err)
	}
	l.f = f
	l.committedEnd = int64(len(content))
	// Durable swap: apply the compacted state (head unchanged, prefix gone).
	l.events = retained
	l.head = snap.Head
	if n := len(retained); n > 0 {
		l.firstID = retained[0].ID
	} else {
		l.firstID = 0
	}
	l.compactFailed = false
	return nil
}

// ---------------------------------------------------------------------------
// Read surface (internal, for S4/S5 + tests — no public routes in S3)
// ---------------------------------------------------------------------------

// NotifyCoverageSource is one source's coverage contribution.
type NotifyCoverageSource struct {
	SourceID    string
	WorkerID    string
	WorkerName  string
	Epoch       string
	Cursor      int64
	AckedSeq    int64
	Gaps        []NotifySourceGap
	PublicFloor int64
}

// NotifyCoverage is the coverage snapshot (head + truncation + per-source
// gaps) S5 will serve as public `coverage` alongside the event page.
type NotifyCoverage struct {
	Head     int64
	FirstID  int64 // oldest retained central id (prefix truncation marker)
	Complete bool  // no source gaps known
	Sources  []NotifyCoverageSource
}

// SourceState returns a copy of a source's committed state (the ingest resume
// cursor). ok=false when the source never committed.
func (l *notifyLedger) SourceState(sourceID string) (notifySourceState, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	st, ok := l.sources[sourceID]
	if !ok {
		return notifySourceState{}, false
	}
	return *stateClone(st), true
}

// Head returns the committed global head (the lastId semantics: a head
// pointer, not the last retained event).
func (l *notifyLedger) Head() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.head
}

// FirstID returns the oldest RETAINED central id (0 when empty). Retention is
// prefix truncation only, so ids are contiguous [FirstID..Head] when non-empty.
func (l *notifyLedger) FirstID() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.firstID
}

// EventsSince pages events with the v4 public semantics: since > 0 returns
// up to limit events with id > since, ascending (oldest-first); since == 0
// returns the NEWEST limit events, ascending. limit <= 0 becomes 50.
// Retention is prefix-only: the returned window is contiguous.
func (l *notifyLedger) EventsSince(sinceID int64, limit int) []NotifyEvent {
	l.mu.Lock()
	defer l.mu.Unlock()
	if limit <= 0 {
		limit = 50
	}
	if sinceID > 0 {
		// Binary search for the first retained id > sinceID.
		lo, hi := 0, len(l.events)
		for lo < hi {
			mid := int(uint(lo+hi) >> 1)
			if l.events[mid].ID <= sinceID {
				lo = mid + 1
			} else {
				hi = mid
			}
		}
		if lo >= len(l.events) {
			return nil
		}
		out := append([]NotifyEvent(nil), l.events[lo:]...)
		if len(out) > limit {
			out = out[:limit]
		}
		return out
	}
	// since == 0: newest page, ascending.
	start := len(l.events) - limit
	if start < 0 {
		start = 0
	}
	return append([]NotifyEvent(nil), l.events[start:]...)
}

// Coverage builds the coverage snapshot.
func (l *notifyLedger) Coverage() NotifyCoverage {
	l.mu.Lock()
	defer l.mu.Unlock()
	cov := NotifyCoverage{Head: l.head, FirstID: l.firstID, Complete: true, Sources: []NotifyCoverageSource{}}
	for _, st := range l.sources {
		cov.Sources = append(cov.Sources, NotifyCoverageSource{
			SourceID:    st.SourceID,
			WorkerID:    st.WorkerID,
			WorkerName:  st.WorkerName,
			Epoch:       st.Epoch,
			Cursor:      st.HighSeq,
			AckedSeq:    st.AckedSeq,
			Gaps:        append([]NotifySourceGap(nil), st.Gaps...),
			PublicFloor: st.PublicFloor,
		})
		if len(st.Gaps) > 0 {
			cov.Complete = false
		}
	}
	sort.Slice(cov.Sources, func(i, j int) bool { return cov.Sources[i].SourceID < cov.Sources[j].SourceID })
	return cov
}

// Close releases the journal handle (tests / daemon teardown).
func (l *notifyLedger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return nil
	}
	err := l.f.Close()
	l.f = nil
	return err
}
