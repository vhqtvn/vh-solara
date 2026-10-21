package alerts

// notify_source.go — the durable worker notice source (notify controller-hub
// S1 / v4 §9.2): every engine-emitted notice gets a durable record with the
// persistent identity (source_id, epoch, seq) BEFORE it is declared available
// for centralized delivery. This spool REPLACES the 500-event history ring as
// the authoritative feed source; the ring (history.go) stays untouched as the
// public /vh/notify/history id space, and the SPOOL OWNS the correlation key
// (t1b-F1): the engine tap appends to the spool FIRST, then records the ring
// event CARRYING the spool's (epoch, seq) — public history joins the spool BY
// SEQ, so ring id resets/reuse (file loss, corrupt recovery, or a rolled-back
// persist failure) can never re-join an older record.
//
// Reliability posture (v4 §9.8 / brief §1):
//   - Bounded: 10,000 records by default (SourceSpoolCap). Overflow evicts the
//     OLDEST record WITH accounting (overflowTotal + firstSeq) so coverage can
//     report the evicted prefix as a gap — never silent ring eviction.
//   - Persistence failure is VISIBLE: Append returns the error (the engine tap
//     logs it) and LastPersistError exposes it for health surfaces. A failed
//     append is never silently acknowledged as durable. The same bar holds at
//     INIT: a fresh/rotated spool whose initial head persist fails keeps the
//     error on LastPersistError — the constructor never silently claims the
//     epoch was persisted when its write failed (the epoch exists in memory
//     only until a later successful persist lands it).
//   - Crash honesty — two regimes, deliberately separated (there is NO fsync
//     anywhere in this file):
//     * PROCESS crash: the atomic rename (tmp+rename, 0600, under the spool
//       lock, on every append — the history.go pattern) is the durability
//       boundary. Loss is bounded to the un-persisted tail: records whose
//       rename never completed. Their seqs were never durable, so after
//       restart the counter resumes at the last PERSISTED seq; a seq is never
//       re-used for a second DURABLE record within an epoch.
//     * HOST/FILESYSTEM crash: rename ordering alone does NOT guarantee the
//       renamed file's CONTENTS survive — a just-renamed document may lose
//       some or all of its contents on some filesystems. No fsync guarantee
//       is claimed; the tmp+rename shape only rules out reading a torn or
//       partial file as valid state (a lost file degrades to the rotation
//       path, which is centrally visible via the coverage gap).
//   - Epoch stability (§9.2): ordinary restarts preserve epoch and seq. The
//     epoch rotates ONLY on genuine source-state replacement — here: a
//     corrupt, INVALID, or lost spool file (content that READS but fails to
//     parse, or a parseable load failing the validateSourceFile invariants ⇒
//     fresh epoch + seq reset, with rotatedAt recorded so the discontinuity
//     is detectable centrally). A
//     missing file is FIRST-RUN vs LOST, decided by the ring-era witness: if
//     the ring document bears post-S1 evidence (a non-empty generation or
//     events recorded through the spool-carrying tap), the spool EXISTED and
//     was lost — the rotation discontinuity is stamped exactly as the corrupt
//     case (t1b-F2); with no ring evidence it is a true first run (or a
//     pre-S1 upgrade where no spool ever existed) and the init is clean.
//   - Unreadable-but-PRESENT file (b-F1): a read error that is NOT
//     os.IsNotExist — EACCES on an intact mode-0000 file under a non-root
//     daemon, a symlink loop, ... — is neither a loss nor corruption: the
//     unread bytes may be perfectly authoritative. The spool enters a
//     degraded PRESERVING state: NO fresh epoch (empty-but-preserved
//     identity), no rotation stamp, no init persist, the init error visible
//     on LastPersistError, and every later persist SKIPPED so the tmp+rename
//     can never REPLACE the unread file (rename needs directory permissions,
//     not file read permission — the overwrite would silently destroy
//     retained durable records this process never saw). Append still
//     allocates and records in memory and reports the skipped persist
//     honestly. Recovery is out-of-band: restore read access and restart —
//     construction then reads the ORIGINAL file and resumes with its epoch
//     and records intact (no runtime re-read loop, by design).
//
// Records are enriched at detection time (v4 §2 step 1): the full notice
// payload, numeric int64 detection ts, origin-worker attendance snapshot
// (attended + the idle window used), the active profile's wantsType verdict,
// and the effective central cooldown key prefix (source_id|type — the
// controller appends |token_hash per §3.4 rung 4). The controller applies v4
// gating from the record without re-deriving worker state.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// SourceSpoolCap is the retained-record bound (v4 §9.8 S0 default:
// 10,000 events per worker; operator-tunable bar, frozen until S2/S3 give the
// feed a place to read a configured override).
const SourceSpoolCap = 10000

// SourceRecord is one durably recorded notice — the private worker→controller
// feed unit. Timestamps stay NUMERIC int64 here and on the future private
// feed (v4 (b)); only the public history DTO stringifies.
type SourceRecord struct {
	Seq  int64  `json:"seq"`
	Type string `json:"type"`
	Kind string `json:"kind"` // "" | permission | question (Notice.Kind)
	// SessionID/Root/Project are empty for daemon-level notices (the
	// EmitDaemonNotice shape) — by design, as on the public ring.
	SessionID       string `json:"sessionID"`
	Root            string `json:"root"`
	Project         string `json:"project"`
	Title           string `json:"title"`
	Detail          string `json:"detail"`
	Ts              int64  `json:"ts"`       // detection time, unix millis (numeric)
	Attended        bool   `json:"attended"` // origin-worker attendance AT DETECTION
	IdleSec         int    `json:"idleSec"`  // the idle window used for that verdict
	ProfileEligible bool   `json:"profileEligible"`
	CooldownKey     string `json:"cooldownKey"` // source_id|type (central appends |token_hash)
}

// DetectionContext is the detection-time snapshot captured alongside the
// notice (v4 (h): attendance measured at DETECTION on the origin worker).
type DetectionContext struct {
	Attended        bool
	IdleSec         int
	ProfileEligible bool
}

// sourceFile is the persisted document: identity + accounting + the records
// (oldest -> newest, len <= cap).
type sourceFile struct {
	Epoch     string `json:"epoch"`
	PrevEpoch string `json:"prevEpoch,omitempty"` // set only across a rotation whose old epoch was known
	RotatedAt int64  `json:"rotatedAt,omitempty"` // epoch rotation time (millis), if ever rotated
	LastSeq   int64  `json:"lastSeq"`             // highest seq ever allocated in this epoch
	FirstSeq  int64  `json:"firstSeq"`            // seq of the oldest RETAINED record (gap floor)
	Overflow  int64  `json:"overflow"`            // total records evicted from the head by the CAPACITY bound, ever (this epoch)
	// AckedSeq is the controller's durable-commit watermark: the controller
	// confirmed central ingestion through this seq (S2 / v4 §2 step 4).
	// 0 = never ACKed.
	AckedSeq int64 `json:"ackedSeq"`
	// AckedTrim counts records dropped from the retained slice BY ACK
	// trims (records ≤ a watermark the controller confirmed consumed) —
	// deliberately separate from Overflow so capacity evictions (potential
	// coverage gaps) never masquerade as confirmed-consumed trims. Identity:
	// overflow + ackedTrim == firstSeq-1 (every allocated record is
	// retained, capacity-evicted, or ack-trimmed).
	AckedTrim int64          `json:"ackedTrim"`
	Records   []SourceRecord `json:"records"`
}

// SourceSpool is the durable notice source under stateDir
// (stateDir/notify-source.json). Safe for concurrent use.
type SourceSpool struct {
	mu       sync.Mutex
	path     string
	sourceID string
	cap      int

	epoch     string
	prevEpoch string
	rotatedAt int64
	lastSeq   int64
	firstSeq  int64
	overflow  int64
	ackedSeq  int64
	ackedTrim int64
	records   []SourceRecord

	// durableSeq is the highest seq known to be in a PERSISTED document
	// (in-memory only; on load it equals lastSeq — the file on disk is the
	// last successful persist). Records in (durableSeq, lastSeq] exist only
	// in memory: they were appended while persists were failing and become
	// durable only when a later persist succeeds (the whole-document write
	// carries them along). UndurableSeqRange() exposes that range for the
	// coverage surface (B1). ALL spool READS are bounded to durableSeq
	// (S2): LookupBySeq and the private feed never serve the undurable
	// tail — a record that is not durable is not feedable.
	durableSeq int64

	// ackDirty records that the current ackedSeq was applied in memory but
	// its persist never landed (a failed AckWatermark write). The next
	// AckWatermark call — including an otherwise-idempotent replay —
	// retries the persist, so a watermark is never acknowledged as durable
	// while it exists in memory only. Cleared by any successful persist
	// (AckWatermark's own or a later Append's whole-document write).
	ackDirty bool

	// preserveFile is armed at construction when the spool file EXISTS but
	// could not be READ (a non-IsNotExist read error, b-F1). While armed,
	// persistLocked refuses to write: the tmp+rename would REPLACE the
	// unread authoritative file (rename needs directory permissions, not
	// file read permission), destroying durable records this process never
	// saw. It is never cleared at runtime — recovery is out-of-band (fix
	// read access and restart; the next construction reads the ORIGINAL
	// file and resumes with its epoch and records intact). There is no
	// re-read loop by design.
	preserveFile bool

	lastErr   error
	lastErrAt time.Time
}

// errSpoolUnreadAuthoritative is returned by persistLocked while the spool
// is in the degraded preserving state (b-F1): the authoritative file existed
// but could not be read at construction, so every persist is skipped — a
// tmp+rename write would replace unread durable state. Recovery is
// out-of-band: fix read access and restart (the on-disk records are
// preserved until then).
var errSpoolUnreadAuthoritative = errors.New("notify source spool: persist skipped — authoritative file unreadable at init (fix read access and restart; on-disk records are preserved)")

// NewSourceSpool loads (or starts) the durable source under stateDir. sourceID
// is the worker's stable controller identity (the daemon --id); it seeds the
// cooldown-key prefix and coverage gap source_id. capacity <= 0 means
// SourceSpoolCap. A fresh spool persists its head immediately so the epoch is
// stable across restarts from the very first init (before any event).
func NewSourceSpool(stateDir, sourceID string, capacity int) *SourceSpool {
	if capacity <= 0 {
		capacity = SourceSpoolCap
	}
	return loadSourceSpool(filepath.Join(stateDir, "notify-source.json"), sourceID, capacity)
}

// loadSourceSpool builds the spool at path. Load semantics:
//   - readable, valid file ⇒ ordinary restart: epoch, seq, and retained
//     records all preserved as persisted.
//   - corrupt file  ⇒ GENUINE source-state replacement (§9.2): fresh epoch +
//     seq reset + rotatedAt stamped. The previous epoch is unreadable, so
//     prevEpoch stays empty — the new epoch value itself is the centrally
//     detectable discontinuity. A PARSEABLE document that fails the
//     validateSourceFile sequence invariants (t1b-F1: damaged, not written
//     by this code) takes this SAME path — accepting it could re-allocate a
//     (epoch, seq) identity that already exists durably inside the very
//     document being loaded.
//   - unreadable-but-PRESENT file (b-F1: any read error OTHER than
//     os.IsNotExist — the bytes may be intact, e.g. EACCES under a non-root
//     daemon) ⇒ degraded PRESERVING state: NO fresh-init, NO rotation, NO
//     init persist, preserveFile armed so no later persist can replace the
//     unread file, and the init error visible on LastPersistError.
//     Recovery is out-of-band: fix read access and restart.
//   - missing file (os.IsNotExist ONLY) ⇒ first run OR lost spool, decided
//     by the ring-era witness (t1b-F2): when the ring document in the same
//     state dir bears post-S1 evidence, the spool EXISTED and was LOST —
//     fresh epoch, seq reset, and the rotation discontinuity STAMPED
//     (rotatedAt; the prior epoch is unknowable from a deleted file, so
//     the coverage gap uses the empty-range convention under the current
//     epoch). Without ring evidence (true first run, or a pre-S1 upgrade
//     where no spool ever existed) the init is CLEAN: fresh epoch, seq
//     starts at 0 (next append = 1), persisted immediately, complete
//     coverage honest.
func loadSourceSpool(path, sourceID string, capacity int) *SourceSpool {
	s := &SourceSpool{path: path, sourceID: sourceID, cap: capacity, firstSeq: 1}
	raw, err := os.ReadFile(path)
	if err == nil {
		var f sourceFile
		if json.Unmarshal(raw, &f) == nil && f.Epoch != "" {
			if verr := validateSourceFile(raw, &f); verr != nil {
				// Structurally invalid but parseable (t1b-F1): DAMAGED state,
				// never a load — accepting it could re-allocate an identity
				// that already exists durably inside this very document.
				// Log the reason visibly (numbers only — no record payloads,
				// no secrets) and fall through to the same replacement path
				// an unparseable file takes.
				vhlog.Logger().Error("notify source spool: persisted document failed validation — replacing source state (fresh epoch, visible rotation)",
					"reason", verr.Error(), "file", filepath.Base(path))
				// DEFER F1 (S1-gate follow-up): the document READ — its epoch
				// is knowable — so the rotation names the OLD epoch in
				// prevEpoch. The coverage surface (v4Coverage) then labels the
				// rotation gap with the departed epoch instead of the fresh
				// one, making the discontinuity centrally attributable.
				s.prevEpoch = f.Epoch
			} else {
				s.epoch = f.Epoch
				s.prevEpoch = f.PrevEpoch
				s.rotatedAt = f.RotatedAt
				s.lastSeq = f.LastSeq
				s.firstSeq = f.FirstSeq
				s.overflow = f.Overflow
				s.ackedSeq = f.AckedSeq
				s.ackedTrim = f.AckedTrim
				s.records = append([]SourceRecord{}, f.Records...)
				if s.firstSeq == 0 {
					s.firstSeq = 1
				}
				s.trimLocked() // honor a smaller capacity than the file carried
				// Everything loaded came from the last successful persist.
				s.durableSeq = s.lastSeq
				return s
			}
		}
		// Corrupt (unreadable JSON or empty epoch) or INVALID (failed
		// validateSourceFile): rotate.
		s.epoch = newSourceEpoch()
		s.rotatedAt = time.Now().UnixMilli()
		s.lastSeq = 0
		s.firstSeq = 1
		s.overflow = 0
		s.records = nil
		s.recordInitPersist(s.persistLocked())
		return s
	}
	// Unreadable but PRESENT (b-F1): any read error other than IsNotExist
	// means the file exists and is AUTHORITATIVE but invisible to this
	// process (EACCES on an intact file, a symlink loop, ...). It is
	// neither missing (first-run/loss) nor corrupt (the bytes may be
	// perfectly intact) — so no fresh-init, no rotation, and above all no
	// persist: the tmp+rename would REPLACE the unread file (rename needs
	// directory permissions, not file read permission), silently
	// destroying retained durable records this process never saw. Degraded
	// preserving state: empty-but-preserved identity (epoch stays "", no
	// mint; lastSeq 0; nothing rotated; no head persist attempted), the
	// init error visible on LastPersistError from construction, and
	// preserveFile armed so Append keeps allocating/recording in memory
	// while every persist is skipped and reported honestly. Recovery is
	// out-of-band: restore read access and restart — construction then
	// reads the ORIGINAL file and resumes with its epoch and records
	// intact (no runtime re-read loop, by design).
	if !os.IsNotExist(err) {
		s.preserveFile = true
		s.lastErr = fmt.Errorf("notify source spool: file present but unreadable — degraded preserving state, persistence disabled until restart: %w", err)
		s.lastErrAt = time.Now()
		vhlog.Logger().Error("notify source spool: authoritative file exists but cannot be read — not initializing fresh, not overwriting (fix read access and restart; on-disk records are preserved)",
			"file", filepath.Base(path), "reason", err.Error())
		return s
	}
	// Missing (os.IsNotExist ONLY): first run or lost spool, decided by the
	// ring's era (the decidable prior-existence witness). Either way seq
	// restarts under a new epoch, so no durable seq is ever re-used for
	// different content; only the rotation stamp — and with it the coverage
	// discontinuity — differs.
	s.epoch = newSourceEpoch()
	s.firstSeq = 1
	if ringBearsPostS1Evidence(filepath.Dir(path)) {
		s.rotatedAt = time.Now().UnixMilli()
	}
	s.recordInitPersist(s.persistLocked())
	return s
}

// validateSourceFile checks the sequence invariants a persisted document must
// satisfy before loadSourceSpool accepts its epoch (the t1b-F1 data-integrity
// gate). A parseable-but-damaged document — e.g. records present with a
// missing/zeroed lastSeq — must NEVER be loaded as-is: the next Append would
// allocate and persist a seq that already exists durably under the SAME
// epoch, colliding the (source, epoch, seq) identity LookupBySeq joins by and
// any future controller dedupe relies on. Rejecting routes the document to
// the genuine-replacement path (fresh epoch + visible rotation), preserving
// the no-durable-sequence-reuse invariant.
//
// Returns a short reason (counts and seqs only — no payloads, no secrets)
// when invalid; nil when the document is coherent, i.e. exactly the shapes
// persistLocked writes:
//   - lastSeq PRESENT (a missing field is invalid, not zero) and >= 0;
//   - ackedSeq in [0, lastSeq] (the watermark can never exceed what was
//     allocated, and is only set for durably-headable seqs);
//   - every record seq > 0, strictly increasing in slice order (no
//     duplicates, no reordering), and <= lastSeq;
//   - with records retained: firstSeq == records[0].Seq, the slice is
//     consecutive (records[i].Seq == firstSeq+i — head-only removal leaves
//     no interior gaps), and it ends AT lastSeq (cap >= 1 always retains the
//     newest allocation);
//   - with no records retained: EITHER nothing was ever allocated (lastSeq
//     == 0, overflow == 0, ackedTrim == 0, firstSeq <= 1) OR every allocated
//     record was consumed by ACK trims (S2 "ACK all": firstSeq ==
//     lastSeq+1, ackedSeq == lastSeq, overflow+ackedTrim == lastSeq);
//   - retention accounting coherent: overflow + ackedTrim == firstSeq-1
//     (every not-retained record is either a capacity eviction or an
//     ACK-trimmed one; an S1 document carries ackedTrim 0 and degenerates
//     to the old overflow == firstSeq-1 rule), which also bounds firstSeq
//     <= lastSeq+1 on every path above.
func validateSourceFile(raw []byte, f *sourceFile) error {
	// Presence probe: a MISSING lastSeq unmarshals into the value struct as
	// 0 — indistinguishable from a persisted 0 without the pointer probe.
	// A document whose records survived but whose head counter did not is
	// damaged, not "nothing allocated yet" (t1b-F1's exact shape).
	var probe struct {
		LastSeq *int64 `json:"lastSeq"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil || probe.LastSeq == nil {
		return fmt.Errorf("lastSeq field missing")
	}
	if f.LastSeq < 0 {
		return fmt.Errorf("lastSeq %d is negative", f.LastSeq)
	}
	if f.AckedSeq < 0 || f.AckedSeq > f.LastSeq {
		return fmt.Errorf("ackedSeq %d outside [0, lastSeq %d]", f.AckedSeq, f.LastSeq)
	}
	if len(f.Records) == 0 {
		if f.LastSeq == 0 {
			// Fresh epoch: nothing allocated, nothing removed.
			if f.Overflow != 0 {
				return fmt.Errorf("no records retained but overflow %d > 0", f.Overflow)
			}
			if f.AckedTrim != 0 || f.AckedSeq != 0 {
				return fmt.Errorf("no records retained but ackedTrim %d / ackedSeq %d set", f.AckedTrim, f.AckedSeq)
			}
			if f.FirstSeq < 0 || f.FirstSeq > 1 {
				return fmt.Errorf("no records retained but firstSeq %d", f.FirstSeq)
			}
			return nil
		}
		// S2 ACK-all shape: the watermark consumed everything allocated.
		if f.AckedSeq != f.LastSeq {
			return fmt.Errorf("no records retained with lastSeq %d but ackedSeq %d (ACK-all requires equality)", f.LastSeq, f.AckedSeq)
		}
		if f.FirstSeq != f.LastSeq+1 {
			return fmt.Errorf("no records retained but firstSeq %d != lastSeq+1 %d", f.FirstSeq, f.LastSeq+1)
		}
		if f.Overflow+f.AckedTrim != f.LastSeq {
			return fmt.Errorf("no records retained but overflow %d + ackedTrim %d != lastSeq %d", f.Overflow, f.AckedTrim, f.LastSeq)
		}
		return nil
	}
	for i := range f.Records {
		seq := f.Records[i].Seq
		if seq <= 0 {
			return fmt.Errorf("record %d has non-positive seq %d", i, seq)
		}
		if i > 0 && seq <= f.Records[i-1].Seq {
			return fmt.Errorf("record %d seq %d not strictly increasing (previous %d)", i, seq, f.Records[i-1].Seq)
		}
	}
	first := f.Records[0].Seq
	last := f.Records[len(f.Records)-1].Seq
	if last != f.LastSeq {
		if last > f.LastSeq {
			return fmt.Errorf("regressed lastSeq %d below retained max seq %d", f.LastSeq, last)
		}
		return fmt.Errorf("retained slice ends at seq %d, short of lastSeq %d", last, f.LastSeq)
	}
	if f.FirstSeq != first {
		return fmt.Errorf("firstSeq %d contradicts oldest retained seq %d", f.FirstSeq, first)
	}
	for i := range f.Records {
		if got := f.Records[i].Seq; got != first+int64(i) {
			return fmt.Errorf("record %d seq %d breaks the consecutive run from firstSeq %d", i, got, first)
		}
	}
	if f.Overflow+f.AckedTrim != f.FirstSeq-1 {
		return fmt.Errorf("overflow %d + ackedTrim %d contradicts firstSeq %d (head-removal accounting)", f.Overflow, f.AckedTrim, f.FirstSeq)
	}
	return nil
}

// recordInitPersist captures an INIT persist failure into the visible error
// surface (B2): the constructor still returns a usable in-memory spool, but a
// head that failed to persist is never silently acknowledged as durable —
// LastPersistError stays non-empty (and coverage degrades) until some later
// append persists cleanly.
func (s *SourceSpool) recordInitPersist(err error) {
	if err != nil {
		s.lastErr = fmt.Errorf("notify source spool init persist failed: %w", err)
		s.lastErrAt = time.Now()
	}
}

// newSourceEpoch mints a fresh random epoch (16 random bytes, hex). No
// relation to prior epochs by construction.
func newSourceEpoch() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failure: fall back to time-derived uniqueness. Never
		// reuse an in-memory constant (that WOULD silently merge epochs).
		return fmt.Sprintf("epoch-%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// Append records n durably with the next strictly-increasing seq and the
// detection-time context, and persists the whole document. It returns the
// record (with its identity) AND the persist error: on failure the record was
// appended in memory but is NOT durable — the error is the visible signal
// (also retained on LastPersistError); a later successful append persists the
// whole document, carrying this record along (and clears LastPersistError —
// the last persist is then clean). Overflow evicts the oldest retained record
// under accounting (overflow++, firstSeq advances).
//
// The returned Seq (when err == nil) is the durable correlation key the
// engine tap stamps into the ring event (t1b-F1): a durably-persisted seq is
// never re-allocated — a restart resumes from the persisted counter — so
// joining by it can never mis-attribute. Callers must NOT carry the seq on
// failure: an undurable seq can be re-used for a different notice after a
// crash.
func (s *SourceSpool) Append(n Notice, dctx DetectionContext) (SourceRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastSeq++
	rec := SourceRecord{
		Seq:             s.lastSeq,
		Type:            n.Type,
		Kind:            n.Kind,
		SessionID:       n.SessionID,
		Root:            n.Root,
		Project:         n.Project,
		Title:           n.Title,
		Detail:          n.Detail,
		Ts:              n.Ts,
		Attended:        dctx.Attended,
		IdleSec:         dctx.IdleSec,
		ProfileEligible: dctx.ProfileEligible,
		CooldownKey:     s.sourceID + "|" + n.Type,
	}
	if len(s.records) == 0 {
		s.firstSeq = rec.Seq
	}
	s.records = append(s.records, rec)
	s.trimLocked()
	err := s.persistLocked()
	if err != nil {
		s.lastErr = err
		s.lastErrAt = time.Now()
		return rec, fmt.Errorf("notify source spool persist failed: %w", err)
	}
	// Clean persist: the whole document (this record AND any earlier
	// in-memory-only ones) is now durable, and the visible error surface
	// must report "" — LastPersistError documents empty-when-last-clean.
	// A clean whole-document write also lands any in-memory-only ACK
	// watermark (ackDirty), so it is cleared here too.
	s.durableSeq = rec.Seq
	s.lastErr = nil
	s.lastErrAt = time.Time{}
	s.ackDirty = false
	return rec, nil
}

// trimLocked enforces the capacity bound, evicting from the OLDEST end with
// accounting. Caller holds mu.
func (s *SourceSpool) trimLocked() {
	for len(s.records) > s.cap {
		s.records = s.records[1:]
		s.overflow++
	}
	if len(s.records) > 0 {
		s.firstSeq = s.records[0].Seq
	}
}

// persistLocked writes the whole document atomically (tmp + rename, 0600).
// Caller holds mu. No fsync — by the two crash regimes documented at the top
// of this file: the rename bounds PROCESS-crash loss to the un-persisted
// tail, while a HOST/FILESYSTEM crash may still lose a just-renamed file's
// contents (no fsync guarantee is claimed; such loss degrades to the visible
// rotation path).
func (s *SourceSpool) persistLocked() error {
	if s.preserveFile {
		// b-F1: the authoritative file was unreadable at construction.
		// The tmp+rename below would REPLACE it (rename needs directory
		// permissions, not file read permission), destroying durable
		// records this process never saw. Skip the write entirely —
		// before the marshal, the tmp write, anything — and let the
		// caller surface this error visibly. Cleared only by
		// constructing on a readable file (fix read access and restart);
		// there is no runtime re-read.
		return errSpoolUnreadAuthoritative
	}
	out, err := json.MarshalIndent(sourceFile{
		Epoch: s.epoch, PrevEpoch: s.prevEpoch, RotatedAt: s.rotatedAt,
		LastSeq: s.lastSeq, FirstSeq: s.firstSeq, Overflow: s.overflow,
		AckedSeq: s.ackedSeq, AckedTrim: s.ackedTrim,
		Records: s.records,
	}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// LookupBySeq returns the retained durable record with the given seq — the
// reversed join (t1b-F1): the ring event CARRIES the (epoch, seq) of its own
// notice's record, so the lookup resolves THAT record and nothing else,
// regardless of ring id resets/reuse. The caller must also verify the epoch
// matches the spool's CURRENT epoch (the ring event's stored SpoolEpoch): a
// rotated spool re-allocates seqs from 1 under a fresh epoch, and an
// old-epoch seq must not join a new-epoch record — post-rotation lookups
// fail on the epoch check and the event serves source-omitted, the documented
// ring-only behavior. ok=false also for seqs evicted by overflow, for ring-only
// legacy events that predate the spool (seq 0 is never looked up), and — made
// EXPLICIT in S2 — for any seq in the UNDURABLE tail (seq > the durable head):
// the public join already refuses undurable keys by construction (the ring
// stamps a seq only on durable success), so this bound changes no observable
// join behavior; it makes the no-undurable-reads rule structural for ALL
// spool reads, LookupBySeq and the private feed alike.
//
// Records are ordered by strictly-increasing seq, so the search is binary.
func (s *SourceSpool) LookupBySeq(seq int64) (SourceRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if seq > s.durableSeq {
		// Durable-bound read (S2): an undurable record is never served.
		return SourceRecord{}, false
	}
	lo, hi := 0, len(s.records)
	for lo < hi {
		mid := int(uint(lo+hi) >> 1)
		if s.records[mid].Seq < seq {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	if lo < len(s.records) && s.records[lo].Seq == seq {
		return s.records[lo], true
	}
	return SourceRecord{}, false
}

// Epoch returns the current source epoch (stable across ordinary restarts).
func (s *SourceSpool) Epoch() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.epoch
}

// LastSeq returns the highest seq ever allocated in this epoch (persisted
// value after a restart — the resume point for the future feed cursor).
func (s *SourceSpool) LastSeq() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastSeq
}

// FirstSeq returns the seq of the oldest RETAINED record; when no record is
// retained it is lastSeq+1, so the overflow gap range [1, FirstSeq-1] always
// covers everything ever evicted.
func (s *SourceSpool) FirstSeq() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.records) == 0 {
		return s.lastSeq + 1
	}
	return s.firstSeq
}

// OverflowTotal returns how many oldest records were evicted from the head of
// this epoch's spool (the degraded-coverage counter for v4 §9.8).
func (s *SourceSpool) OverflowTotal() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.overflow
}

// PrevEpoch returns the epoch that preceded the current one across a
// rotation whose old epoch was KNOWN pre-rotation ("" when the rotation was
// triggered by an unreadable/lost file — the old epoch value itself is gone).
func (s *SourceSpool) PrevEpoch() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.prevEpoch
}

// RotatedAt returns the rotation timestamp (unix millis) of the current
// epoch, 0 when this epoch never rotated. Non-zero means the spool state was
// REPLACED at that moment and the prior range is discontinuous — the signal
// coverage degrades on (B1).
func (s *SourceSpool) RotatedAt() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rotatedAt
}

// UndurableSeqRange returns the inclusive seq range of records that exist
// only in memory because their persists failed (B1): appended after the last
// successful persist, not yet carried into a durable document. from > to
// (empty range) when everything retained is durable. A later successful
// append persists the whole document — carrying these along — and the range
// empties.
func (s *SourceSpool) UndurableSeqRange() (from, to int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.durableSeq + 1, s.lastSeq
}

// LastPersistError exposes the most recent persistence failure ("" when the
// last append persisted cleanly) for health/diagnostic surfaces — persistence
// failures must be visible, never silently acknowledged.
func (s *SourceSpool) LastPersistError() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastErr == nil {
		return ""
	}
	return s.lastErr.Error()
}

// SourceID returns the stable source identity the spool was seeded with
// (the daemon --id — the same identity tunnel enrollment advertises).
func (s *SourceSpool) SourceID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sourceID
}

// DurableSeq returns the durable head: the highest seq known to be inside a
// PERSISTED document. ALL feedable reads are bounded to it (S2) — records in
// (DurableSeq, LastSeq] exist in memory only and are never served.
func (s *SourceSpool) DurableSeq() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.durableSeq
}

// AckedSeq returns the controller's durable-commit watermark (0 = never
// ACKed) — the retention hint the private ACK endpoint advances.
func (s *SourceSpool) AckedSeq() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ackedSeq
}

// AckedTrimTotal returns how many records were dropped from the retained
// slice by ACK trims (centrally confirmed consumed), kept separate from
// OverflowTotal's capacity evictions so coverage never mistakes a consumed
// trim for a lost gap.
func (s *SourceSpool) AckedTrimTotal() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ackedTrim
}

// feedPageDefaultLimit mirrors the private feed's documented page default
// (the HTTP layer owns the client-facing constant; the spool applies the same
// floor so a zero/negative limit can never request an unbounded page).
const feedPageDefaultLimit = 200

// FeedPage returns up to limit DURABLE records with seq strictly greater
// than sinceSeq, ascending (the private feed's page-forward cursor
// semantics, S2 / v4 §2 step 3): records ≤ sinceSeq are already consumed by
// the cursor, records > the durable head are not feedable, and the page is
// bounded by limit (≤ 0 defensively becomes the documented default). The
// returned slice is a copy — callers cannot alias spool state.
func (s *SourceSpool) FeedPage(sinceSeq int64, limit int) []SourceRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit <= 0 {
		limit = feedPageDefaultLimit
	}
	// Binary search for the first retained record with seq > sinceSeq.
	lo, hi := 0, len(s.records)
	for lo < hi {
		mid := int(uint(lo+hi) >> 1)
		if s.records[mid].Seq <= sinceSeq {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	out := make([]SourceRecord, 0, min(limit, len(s.records)-lo))
	for i := lo; i < len(s.records) && len(out) < limit; i++ {
		if s.records[i].Seq > s.durableSeq {
			break // durable-bound read: the undurable tail is never fed
		}
		out = append(out, s.records[i])
	}
	return out
}

// SourceMeta is the durable-source state block served alongside a feed page
// (v4 §9): identity, retention/eviction accounting, and durability state —
// everything the controller needs to compute coverage/gaps without another
// round trip. It is captured ATOMICALLY with the page it rides (FeedSnapshot)
// so every number describes the SAME spool state (B1: the feed response must
// never mix numbers from independently-locked reads).
type SourceMeta struct {
	SourceID         string
	Epoch            string
	PrevEpoch        string
	RotatedAt        int64
	FirstSeq         int64
	LastSeq          int64
	DurableSeq       int64
	Overflow         int64
	AckedSeq         int64
	AckedTrim        int64
	LastPersistError string
}

// FeedSnapshot is ONE atomic view of the private feed: a page of records,
// the source metadata, and the resume cursor, all computed under a SINGLE
// hold of the spool mutex (B1 — the empty-page cursor race). The old
// two-lock composition (FeedPage, then DurableSeq as a separate critical
// section) could interleave with a concurrent Append: an empty page read at
// durable head N, then an Append landing N+1 durably, then DurableSeq
// reading N+1 produced records=[] + nextSince=N+1 — and the next fetch
// (seq > N+1) skipped record N+1 forever, with no overflow/trim marker. A
// snapshot cannot observe half-state: NextSince is the LAST RETURNED
// record's seq, or max(sinceSeq, the snapshot's OWN durable head) when the
// page is empty — so an empty page always parks the cursor at the durable
// head the EMPTY PAGE was taken at, and a record that becomes durable after
// the snapshot is simply served by the next fetch.
type FeedSnapshot struct {
	Records   []SourceRecord
	Meta      SourceMeta
	NextSince int64
}

// FeedSnapshot returns up to limit DURABLE records with seq strictly greater
// than sinceSeq (FeedPage's page-forward semantics), TOGETHER with the
// source metadata and the resume cursor, all under one lock hold (B1). The
// returned slice is a copy — callers cannot alias spool state.
func (s *SourceSpool) FeedSnapshot(sinceSeq int64, limit int) FeedSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit <= 0 {
		limit = feedPageDefaultLimit
	}
	// Binary search for the first retained record with seq > sinceSeq.
	lo, hi := 0, len(s.records)
	for lo < hi {
		mid := int(uint(lo+hi) >> 1)
		if s.records[mid].Seq <= sinceSeq {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	out := make([]SourceRecord, 0, min(limit, len(s.records)-lo))
	for i := lo; i < len(s.records) && len(out) < limit; i++ {
		if s.records[i].Seq > s.durableSeq {
			break // durable-bound read: the undurable tail is never fed
		}
		out = append(out, s.records[i])
	}
	// Cursor: the last returned record's seq, else max(since, THIS
	// snapshot's durable head) — the max() floor keeps a stale cursor
	// (since_seq behind an already-consumed trimmed prefix) from re-serving,
	// while never naming a durable seq the page itself did not observe.
	next := sinceSeq
	if s.durableSeq > next {
		next = s.durableSeq
	}
	if n := len(out); n > 0 {
		next = out[n-1].Seq
	}
	firstSeq := s.firstSeq
	if len(s.records) == 0 {
		firstSeq = s.lastSeq + 1
	}
	meta := SourceMeta{
		SourceID:   s.sourceID,
		Epoch:      s.epoch,
		PrevEpoch:  s.prevEpoch,
		RotatedAt:  s.rotatedAt,
		FirstSeq:   firstSeq,
		LastSeq:    s.lastSeq,
		DurableSeq: s.durableSeq,
		Overflow:   s.overflow,
		AckedSeq:   s.ackedSeq,
		AckedTrim:  s.ackedTrim,
	}
	if s.lastErr != nil {
		meta.LastPersistError = s.lastErr.Error()
	}
	return FeedSnapshot{Records: out, Meta: meta, NextSince: next}
}

// ErrAckBeyondDurableHead marks an ACK watermark the spool refuses to apply:
// the controller may only confirm central commit through seqs that are
// durable HERE (v4 §9.8: never ACK non-durable events). The HTTP layer maps
// it to 409 so the controller can treat it as a retryable protocol signal,
// not a server failure.
var ErrAckBeyondDurableHead = errors.New("ack watermark beyond the durable head")

// AckWatermark records the controller's durable-commit watermark N (central
// ingestion succeeded through N) and MAY trim retained records ≤ N
// (retention reclamation — optional-lazy by design; correctness lives in the
// controller's cursor, not in the trim). Accounting stays coherent: firstSeq
// advances past the trimmed prefix, overflow is UNTOUCHED (a consumed trim is
// not a capacity gap), and ackedTrim accumulates the trimmed count so the
// file invariant overflow+ackedTrim == firstSeq-1 holds.
//
// Idempotent and monotone: N == the current watermark is a no-op success;
// N < the current watermark never regresses the recorded value (also a
// no-op success — a delayed/duplicated ACK is the normal loss-retry shape,
// v4 §3 "Tunnel drop mid-page / ACK loss"). N > the durable head is refused
// with ErrAckBeyondDurableHead. A persist failure returns the error WITH the
// in-memory state applied and ackDirty armed — the visible-error posture
// (never silently acknowledge durability); the next call, including an
// idempotent replay, retries the persist.
func (s *SourceSpool) AckWatermark(seq int64) (trimmed int, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if seq < 0 {
		return 0, fmt.Errorf("negative watermark %d", seq)
	}
	if seq > s.durableSeq {
		return 0, fmt.Errorf("%w: %d > durable head %d", ErrAckBeyondDurableHead, seq, s.durableSeq)
	}
	applied := false
	if seq > s.ackedSeq {
		s.ackedSeq = seq
		applied = true
		// Trim the confirmed-consumed prefix. Records ≤ seq are durable by
		// the bound above, so this can never drop an undurable record.
		drop := 0
		for drop < len(s.records) && s.records[drop].Seq <= seq {
			drop++
		}
		if drop > 0 {
			s.records = s.records[drop:]
			s.ackedTrim += int64(drop)
			trimmed = drop
			if len(s.records) > 0 {
				s.firstSeq = s.records[0].Seq
			} else {
				s.firstSeq = s.lastSeq + 1
			}
		}
	}
	if !applied && !s.ackDirty {
		// Pure idempotent replay of an already-persisted watermark.
		return 0, nil
	}
	// Applied now, or applied earlier but never persisted (ackDirty): one
	// whole-document persist lands the watermark (plus any in-memory-only
	// records) durably.
	if perr := s.persistLocked(); perr != nil {
		s.lastErr = perr
		s.lastErrAt = time.Now()
		s.ackDirty = true
		return trimmed, fmt.Errorf("notify source spool: ack persist failed: %w", perr)
	}
	// A1: the persist SUCCEEDED — the visible error surface must report the
	// clean persist regardless of whether THIS call applied a new watermark
	// or only retried a dirty one. The old `if applied` guard left the
	// stale "ack persist failed" error on the ackDirty-retry path (a
	// successful retry still advertised the failure it had just repaired).
	s.ackDirty = false
	s.lastErr = nil
	s.lastErrAt = time.Time{}
	return trimmed, nil
}
