package web

// Queue-custody fence (send-net-resilience slice 2a; debate-3 AMEND-A1 +
// debate-4 B3 — the binding contract).
//
// The fence gives ONE daemon exclusive, crash-recoverable custody over a
// project's queue dispatch state, with a monotonic fencing generation that
// lets a stale owner's writes be REJECTED instead of silently overwriting a
// newer owner's state. It is the write-ahead-journal writer's safety backstop
// (queue_drain.go): every custody-mode mutation and every upstream POST is
// compare-and-fenced first.
//
// MECHANISM (three cooperating artifacts under <root>/.vh-solara/):
//
//   - queue.custody.lock — a flock(2) file. LIVE ownership is the held flock,
//     not the file's existence (the file survives crashes as an empty file;
//     the kernel releases the flock when the owning process dies, which is
//     the stale-lock-detection primitive: after a crash the lock is simply
//     free). A second acquisition attempt — including a SECOND open file
//     description in the SAME process, since flock locks belong to the open
//     file description, not the PID — fails immediately (LOCK_EX|LOCK_NB)
//     with errQueueCustodyHeld: fail-closed on an already-owned queue, never
//     wait out the holder.
//
//   - queue.custody.gen — {"generation":N}, atomically written (temp+fsync+
//     rename via writeQueueAtomic) on every acquisition while the flock is
//     held. This is the project-level GENERATION AUTHORITY. Because it is
//     only ever written under the flock, each holder monotonically allocates
//     the next generation (N+1); a reader comparing its own generation
//     against this file detects a newer owner.
//
//   - sessions/<sid>/queue.json FenceGeneration — the per-queue MIRROR of the
//     owner's project generation, stamped on every custody-mode save of that
//     queue (see fenceGateLocked). Each QueueAttempt record carries the
//     generation it was started under (the debate-4 B3 requirement), so a
//     recovered queue file tells any reader which custody epoch produced
//     each dispatch attempt.
//
// COMPARE-AND-FENCE (before every custody-mode mutation and every upstream
// POST — enforced in fenceGateLocked under the store mutex, and again in the
// executor immediately before the POST):
//
//  0. Released token ⇒ errQueueFenced, before the authority is even read —
//     fence validity is revoked AT Release (the token mutex makes the
//     revoke and the check atomic), so a released owner's executor can
//     never pass its pre-POST fence on the strength of an authority file
//     that still names its generation.
//  1. Re-read queue.custody.gen. Unreadable, corrupt, or != the token's
//     generation ⇒ errQueueFenced (a newer owner exists, or the authority is
//     lost — either way this writer is stale and must not proceed).
//  2. Load queue.json (fail-closed on errQueueFileCorrupt / errQueueSchemaNewer
//     — the corrupt/recovered-queue generation handling: a corrupt queue file
//     never reaches a custody mutation, because load() refuses and nothing is
//     rewritten; a NEWER-schema file is never reinterpreted).
//  3. If the loaded file's FenceGeneration > the token's generation, a newer
//     owner already wrote this queue ⇒ errQueueFenced. (Lower or equal is
//     fine: lower = the file predates our epoch and our next save stamps it
//     up; equal = ours.)
//
// CORRUPT GENERATION FILE: acquisition fails closed with
// errQueueCustodyGenCorrupt rather than re-allocating blind — a rewind could
// REUSE a generation and silently invalidate the fence. "Corrupt" is every
// malformed authority shape (unparseable JSON, non-object, absent or null
// generation member, wrong member type, negative value — the strict decode
// in readCustodyGeneration; a plain-uint64 decode once accepted {} and
// {"generation":null} as generation 0, silently reusing generation 1). The
// operator investigates; the lock is released.
//
// GENERATION WIDTH (the FE-mirror decision): Go persists uint64 (the
// slice-1 schema, queueFile.FenceGeneration / QueueAttempt.Generation). For
// the JavaScript mirror the value MUST stay below 2^53 (Number.MAX_SAFE_
// INTEGER), so allocation ENFORCES a cap: acquisition refuses to allocate
// beyond maxCustodyGeneration (2^53-1) with errQueueCustodyGenExhausted
// instead of letting the counter drift into the unsafe range. This is not a
// practical limit — a generation is allocated exactly once per custody
// acquisition (per daemon start per project), so reaching 2^53 requires
// ~9e15 daemon restarts — but the cap makes the FE-safety property a
// machine-checked invariant instead of a hope. (The alternative —
// serializing as a JSON string — was rejected because every comparison site
// in Go would then pay a parse, and the on-disk shape would diverge from the
// slice-1 uint64 fields that already shipped.)
//
// TOPOLOGY / PLATFORM MATRIX (AMEND-A1: the restart causality barrier is
// claimed ONLY inside this matrix):
//
//   INSIDE (certified): ONE vh-solara daemon per project root per machine;
//   Linux (flock); OpenCode SPAWNED by that daemon (spawned-OC — the
//   cmd/opencode_lock*.go spawn slot). Inside the matrix, a post-restart
//   exact-ID GET 404 may be read as a causality barrier (slice 2b's
//   certified redelivery classes).
//
//   OUTSIDE (excluded):
//   - non-Linux platforms: custody is UNAVAILABLE (errQueueCustodyUnsupported,
//     fail-closed — see queue_custody_other.go). The journal/fence paths are
//     unreachable; the legacy browser-dispatch path is unaffected. No
//     causality claim.
//   - two daemons on one project root: the second acquisition fails closed
//     (errQueueCustodyHeld). No split-brain; the operator resolves.
//   - external-OpenCode mode (an OpenCode this daemon did not spawn): the
//     fence itself is daemon-side and still enforces single-writer queue.json
//     custody, BUT the restart causality barrier is NOT claimed — an
//     externally-managed OpenCode can be restarted out-of-band and driven by
//     other clients this daemon cannot observe. Clearly-labeled best-effort:
//     queue custody holds; the barrier does not.
//
// RELATIONSHIP to cmd/opencode_lock.go / cmd/opencode_lock_linux.go: that
// two-role flock protocol serializes only the detached OpenCode SPAWN SLOT
// (one `opencode serve` per project). It does NOT fence queue.json custody
// or dispatch — a daemon could hold the spawn slot while a second daemon
// dispatched queue items. This fence is the separate, queue-store-resident
// mechanism for exactly that gap (debate-3 A1). Do not conflate the two.
//
// CAPABILITY GATE (the flag-era posture): daemon dispatch is OPT-IN via
// SetDaemonDispatchEnabled (cmd/local-server.go --daemon-dispatch,
// default OFF) — with it off, NO production code path acquires custody:
// queueCustodyAllowed() refuses acquisition unless the capability is on or a
// test explicitly opts in (SetQueueCustodyEnabledForTest), so with the flag
// OFF the legacy browser-driven claim/POST/resolve path is byte-equivalent to
// today: no lock files are created, no generations are allocated, and no
// journal fields are written. With it on, the DRAIN LOOP
// (queue_drain_loop.go, started from aggFor) is the production caller — the
// single daemon worker of the custody protocol.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// custodyLock is the held platform-lock handle (flock on Linux; the non-Linux
// build's acquire stub never produces one). Release drops the lock.
type custodyLock interface{ Release() }

// Sentinel errors for the custody fence. The custody path has no HTTP
// surface in slice 2a (no route reaches it), so these are store-level only.
var (
	// errQueueCustodyDisabled: the daemon-dispatch capability is OFF (the
	// slice-2a default) and no test override is armed — acquisition is
	// refused before any filesystem effect.
	errQueueCustodyDisabled = errors.New("queue custody disabled (daemon dispatch capability off)")
	// errQueueCustodyHeld: another live owner holds the per-project flock.
	// Fail-closed: never wait out the holder, never share custody.
	errQueueCustodyHeld = errors.New("queue custody already held by another owner")
	// errQueueCustodyUnsupported: this platform cannot support the fence
	// (non-Linux: no flock). Custody mode is unavailable, fail-closed.
	errQueueCustodyUnsupported = errors.New("queue custody unsupported on this platform (requires Linux flock)")
	// errQueueCustodyGenCorrupt: the generation authority file is unreadable
	// or malformed. Acquisition fails closed rather than re-allocating blind
	// (a rewind could reuse a generation and silently invalidate the fence).
	errQueueCustodyGenCorrupt = errors.New("queue custody generation file corrupt")
	// errQueueCustodyGenExhausted: the enforced 2^53-1 generation cap (the
	// FE-mirror safety invariant — see the file doc comment). Refuse rather
	// than allocate an unrepresentable-as-JSON-number generation.
	errQueueCustodyGenExhausted = errors.New("queue custody generation exhausted (2^53-1 cap)")
	// errQueueFenced: a compare-and-fence check rejected this writer — a
	// newer custody owner exists (or the generation authority is lost). The
	// stale owner's mutation/POST must not proceed.
	errQueueFenced = errors.New("queue custody fence rejected a stale-generation write")
	// errQueueCustodyActive (D-F2 mixed-writer arbitration): a LIVE custody
	// owner dispatches this project's queue, so the LEGACY browser-facing
	// claim/resolve mutations are refused with a typed, machine-readable
	// error (the design's migration signal: old SPAs feature-detect the
	// ownership conflict and refresh). Enqueue stays open — admission is the
	// client's durable gesture, not a dispatch mutation. Refused at the
	// ROUTE layer only (queue_http.go); the store itself stays callable by
	// the custody owner.
	errQueueCustodyActive = errors.New("queue custody active: a custody owner dispatches this project's queue; browser claim/resolve refused")
)

// custodyBarrierCertified reports whether the RESTART CAUSALITY BARRIER —
// "OpenCode restarted since the POST + post-restart exact-ID GET 404 ⇒ the
// POST never durably persisted, so redelivery cannot duplicate" — may be
// CERTIFIED for this daemon's topology (the AMEND-A1 matrix; slice 2b's
// certified redelivery classes key off it). The claim holds ONLY inside:
//
//	Linux (flock custody — enforced by the platform split,
//	        queue_custody_linux.go vs queue_custody_other.go)
//	+ an OpenCode instance this daemon SPAWNED (spawned-OC).
//
// External OpenCode (SetExternalOpenCode(true), wired from --opencode-url in
// cmd/local-server.go) is EXCLUDED: an externally-managed instance can be
// restarted out-of-band and driven by other clients this daemon cannot
// observe, so a post-restart 404 proves nothing there. Queue custody itself
// still enforces single-writer queue.json in external mode; only the barrier
// claim drops. Phase 2's barrier/recovery logic MUST consult this predicate
// before classifying any item into a certified-redeliver class — B-F6's
// enforced exclusion is exactly this boolean's `externalOC` arm.
func custodyBarrierCertified(externalOC bool) bool {
	return runtime.GOOS == "linux" && !externalOC
}

// maxCustodyGeneration is the enforced generation ceiling: 2^53-1
// (Number.MAX_SAFE_INTEGER). See the FE-mirror decision in the file doc
// comment — the cap keeps every persisted generation exactly representable
// as a JavaScript number for the FE mirror, as a machine-checked invariant.
const maxCustodyGeneration = uint64(1)<<53 - 1

// queueCustodyTestEnable is the TEST-ONLY bypass of the daemon-dispatch
// capability gate (production gates custody on SetDaemonDispatchEnabled —
// the --daemon-dispatch opt-in, default OFF; the drain loop in
// queue_drain_loop.go is the production caller). Atomic so the test-time
// write and the acquire-time read never race under `go test -race` (mirrors
// SetStaleDispatchThresholdForTest). Production never sets it; with both it
// and the flag unset, AcquireQueueCustody fails with errQueueCustodyDisabled
// and the legacy path is byte-equivalent.
var queueCustodyTestEnable atomic.Bool

// SetQueueCustodyEnabledForTest arms/disarms the TEST-ONLY capability bypass
// for the queue-custody fence. TEST-ONLY: production code MUST NOT call this
// — daemon dispatch custody is gated by daemonDispatchCapable (false in
// slice 2a) and ships disabled. Callers SHOULD defer-restore (e.g.
// `defer SetQueueCustodyEnabledForTest(false)`).
func SetQueueCustodyEnabledForTest(v bool) {
	queueCustodyTestEnable.Store(v)
}

// queueCustodyAllowed reports whether custody acquisition is permitted: the
// daemon-dispatch capability is enabled at runtime (SetDaemonDispatchEnabled —
// the --daemon-dispatch opt-in) or a test override is armed.
func queueCustodyAllowed() bool {
	return daemonDispatchEnabled.Load() || queueCustodyTestEnable.Load()
}

// QueueCustody is ONE holder's per-project custody token: the fencing
// generation it allocated at acquisition plus the held platform lock.
// Fence validity ends AT RELEASE, not at the next owner's acquisition:
// Release REVOKES the token (the released-token semantics — commit-review
// B-F2/B-F4; the earlier "zombie-owner" semantics, where a released token
// stayed fence-valid until a successor bumped the authority, left a
// pre-POST window in which a released owner could pass its fence and fire
// a stale POST). Safe for concurrent use: an internal mutex guards the
// released flag together with FenceCheck's read of it and Release's
// lock-handle drop, so a concurrent Release/FenceCheck pair can never
// observe a half-released token (this also closes the c.lock nil-write
// race the deferred D-F3 note flagged, at the same site).
type QueueCustody struct {
	root string
	gen  uint64
	lock custodyLock

	mu       sync.Mutex // guards lock and released (FenceCheck reads released under mu)
	released bool
}

// custodyLockFileRel / custodyGenFileRel place the fence artifacts inside the
// project's .vh-solara/ runtime dir (peer to sessions/), keyed to the SAME
// root as the queue files they fence — unlike the cmd/ spawn locks, which
// key like the ocState file they protect (see ocSpawnLockPath).
const (
	custodyLockFileRel = "queue.custody.lock"
	custodyGenFileRel  = "queue.custody.gen"
)

// AcquireQueueCustody takes exclusive, fail-closed queue-custody ownership
// of one project root (see the file doc comment for the full protocol and
// the topology/platform matrix). On success the caller owns generation N+1
// (N = the last persisted generation, 0 if none) and MUST eventually Release
// (process exit also releases — the flock dies with the process). Errors:
//
//   - errQueueCustodyDisabled     capability off (production slice-2a default)
//   - errQueueCustodyUnsupported  non-Linux platform (fail-closed)
//   - errQueueCustodyHeld         another live owner holds the flock
//   - errQueueCustodyGenCorrupt   generation authority unreadable/malformed
//   - errQueueCustodyGenExhausted 2^53-1 cap reached (never re-allocate)
func AcquireQueueCustody(root string) (*QueueCustody, error) {
	if !queueCustodyAllowed() {
		return nil, errQueueCustodyDisabled
	}
	// Platform refusal BEFORE ANY filesystem effect (tier1_b-F1, matured
	// phase-1 defer): the non-Linux stub must refuse without creating so
	// much as the .vh-solara directory — "fail-closed" means
	// fail-BEFORE-effects. custodyPlatformRefusal is the platform-split
	// guard (nil on Linux; errQueueCustody elsewhere), so the ordering here
	// is the machine-checked invariant the !linux test pins.
	if err := custodyPlatformRefusal(); err != nil {
		return nil, err
	}
	vhDir := filepath.Join(root, ".vh-solara")
	if err := os.MkdirAll(vhDir, 0o755); err != nil {
		return nil, fmt.Errorf("queue custody: mkdir %s: %w", vhDir, err)
	}
	// Platform lock FIRST: everything below runs while the flock is held, so
	// the generation read-bump-write sequence is serialized across owners.
	lock, err := custodyLockAcquire(filepath.Join(vhDir, custodyLockFileRel))
	if err != nil {
		return nil, err
	}
	gen, err := readCustodyGeneration(filepath.Join(vhDir, custodyGenFileRel))
	if err != nil {
		lock.Release()
		return nil, err
	}
	if gen >= maxCustodyGeneration {
		lock.Release()
		return nil, fmt.Errorf("%w: generation %d", errQueueCustodyGenExhausted, gen)
	}
	next := gen + 1
	if err := writeCustodyGeneration(filepath.Join(vhDir, custodyGenFileRel), next); err != nil {
		lock.Release()
		return nil, err
	}
	return &QueueCustody{root: root, gen: next, lock: lock}, nil
}

// Generation returns the fencing generation this token allocated. Every
// custody-mode save stamps it into queue.json (fenceGeneration) and every
// attempt journal record carries it (QueueAttempt.Generation).
func (c *QueueCustody) Generation() uint64 { return c.gen }

// Release drops the custody lock and REVOKES the token's fence validity —
// atomically with respect to FenceCheck (both synchronize on the token's
// mutex; FenceCheck rejects a released token BEFORE reading the generation
// authority). Idempotent. After Release the token can neither pass a fence
// check nor drive a custody mutation: a released owner's executor is
// rejected at its pre-POST fence even though the authority file still
// names its generation (no successor needed). Process exit releases the
// flock implicitly; in-memory tokens die with the process, so the
// revocation gap cannot outlive the holder.
//
// HONEST BOUNDARY (the client-side-fencing split): Release revokes THIS
// token's validity atomically, but a pure check-then-POST gap is inherent
// to client-side fencing — a token that passes FenceCheck and is released
// and superseded before its POST leaves the machine is not detectable at
// the client. For that residual window the WRITE fence stays authoritative:
// every journal mutation (RecordAttemptOutcome included) re-runs the
// compare-and-fence gate, so the stale epoch's receipt is REJECTED and no
// stale write lands. The POST itself may still have reached OpenCode;
// detecting that duplicate is the reconciler / correlation-id job, not the
// fence's.
func (c *QueueCustody) Release() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.released || c.lock == nil {
		c.released = true
		return
	}
	c.lock.Release()
	c.lock = nil
	c.released = true
}

// FenceCheck re-reads the generation authority and reports whether this
// token is still the CURRENT custody owner. Called before every custody-mode
// state mutation (under the store mutex, via fenceGateLocked) and
// immediately before every upstream POST (in the executor). A RELEASED
// token is rejected before the authority is even read — validity was
// revoked at Release under the token's mutex, so the released-pre-POST
// window (B-F2/B-F4) cannot pass even with no successor on the file.
// Unreadable or corrupt authority also fences: a writer that cannot prove
// it is current must not write.
func (c *QueueCustody) FenceCheck() error {
	if c == nil {
		return fmt.Errorf("%w: nil custody token", errQueueFenced)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.released {
		return fmt.Errorf("%w: token generation %d released (fence validity revoked at Release)", errQueueFenced, c.gen)
	}
	cur, err := readCustodyGeneration(filepath.Join(c.root, ".vh-solara", custodyGenFileRel))
	if err != nil {
		return fmt.Errorf("%w: %v", errQueueFenced, err)
	}
	if cur != c.gen {
		return fmt.Errorf("%w: token generation %d, authority generation %d (a newer owner exists)", errQueueFenced, c.gen, cur)
	}
	return nil
}

// custodyGenerationDoc is the on-disk shape of queue.custody.gen. The
// Generation member is a POINTER so the strict reader can distinguish a
// present, non-null, valid integer (the only acceptable shape — a fresh
// write of it is what writeCustodyGeneration produces) from every
// malformed authority shape: an absent member ({}) and a null member
// ({"generation":null}) both decode to a nil pointer, which the reader
// treats as corrupt — never silently 0.
type custodyGenerationDoc struct {
	Generation *uint64 `json:"generation"`
}

// readCustodyGeneration reads the generation authority. A missing file is 0
// (no owner ever acquired). Every malformed shape — unparseable JSON, a
// non-object document, an absent ({}) or null generation member, a wrong
// member type (string/bool/float/non-integer literal), or a negative value —
// is errQueueCustodyGenCorrupt, NEVER silently zero (that would rewind the
// counter and reuse generations). Commit-review B-F1/B-F3: the previous
// plain-uint64 decode accepted {} and {"generation":null} as generation 0,
// so acquisition allocated generation 1 AGAIN — reusing a fencing
// generation.
func readCustodyGeneration(path string) (uint64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, fmt.Errorf("%w: read %s: %v", errQueueCustodyGenCorrupt, path, err)
	}
	var doc custodyGenerationDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return 0, fmt.Errorf("%w: parse %s: %v", errQueueCustodyGenCorrupt, path, err)
	}
	if doc.Generation == nil {
		return 0, fmt.Errorf("%w: %s: generation member absent or null (%s)", errQueueCustodyGenCorrupt, path, data)
	}
	return *doc.Generation, nil
}

// writeCustodyGeneration atomically persists the generation authority
// (temp+fsync+rename via the queue's atomic writer — crash-safe at every
// point). Only ever called while the flock is held.
func writeCustodyGeneration(path string, gen uint64) error {
	data, err := json.Marshal(custodyGenerationDoc{Generation: &gen})
	if err != nil {
		return fmt.Errorf("queue custody: encode generation: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("queue custody: mkdir: %w", err)
	}
	return writeQueueAtomic(path, data, 0o644)
}

// fenceGateLocked is the compare-and-fence gate every custody-mode store
// mutation passes through, called under s.mu BEFORE mutating. Steps 1-3 of
// the protocol in the file doc comment: token currency (generation
// authority), queue load (fail-closed on corrupt/newer-schema — the
// corrupt/recovered-queue generation handling), and the on-disk
// FenceGeneration comparison. On success the store's fenceGeneration is
// stamped to the token's so the subsequent save() persists the epoch.
func (s *sessionQueueStore) fenceGateLocked(tok *QueueCustody) error {
	if err := tok.FenceCheck(); err != nil {
		return err
	}
	if err := s.load(); err != nil {
		// Corrupt or newer-schema queue.json: fail closed. Nothing is
		// assigned and nothing is saved — corrupt bytes are preserved.
		return err
	}
	if s.fenceGeneration > tok.gen {
		return fmt.Errorf("%w: queue.json fenceGeneration %d > token generation %d (a newer owner wrote this queue)", errQueueFenced, s.fenceGeneration, tok.gen)
	}
	// Stamp the epoch: this save (and every attempt record within it) is
	// attributable to the token's generation.
	s.fenceGeneration = tok.gen
	return nil
}

// ClaimForCustody is the custody-mode claim: the same atomic
// oldest-pending→dispatching transition + opencodeMsgID mint as Claim() (the
// design's "prepared" state), but behind the compare-and-fence gate and
// stamping the fencing generation into the same atomic save. It is the
// journal writer's entry point (queue_drain.go); the legacy browser-facing
// Claim() is unchanged and unfenced (slice 2a: browser dispatch stays the
// production path; the exclusive cutover is a later slice).
func (s *sessionQueueStore) ClaimForCustody(tok *QueueCustody) (QueueItem, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		return QueueItem{}, false, errQueueArchived
	}
	if err := s.fenceGateLocked(tok); err != nil {
		return QueueItem{}, false, err
	}
	// The claim stamps the custody ERA MARKER (ClaimGeneration) in the same
	// atomic save as the state transition + correlation-id mint: every item
	// this epoch claims is certifiable by the slice-2b classifier, while
	// ClaimGeneration==0 items (legacy browser claims) never are.
	return s.claimOldestPendingLocked(tok.gen)
}

// BeginDispatchAttempt durably journals the write-ahead transition
// `prepared → sending` for one item: it appends a QueueAttempt record
// (generation, StartedAt; TransportClass empty = in flight) to the item's
// attempt journal and atomically saves BEFORE the caller performs the
// upstream POST. This is the record a crash leaves behind: on reload, an
// item whose last attempt is open was mid-POST when its writer died — the
// reconciliation input the certification classes (slice 2b) key off. The
// attempt's identity is its index in the item's Attempts slice (the slice-1
// schema carries no per-attempt id field; generation+StartedAt identify it).
// Requires the item to be `dispatching` (claimed — the "prepared" state).
// ocGen is the OpenCode process generation observed NOW (the
// restart-barrier input; 0 = unknown, which never certifies a barrier —
// see QueueAttempt.OCGeneration).
func (s *sessionQueueStore) BeginDispatchAttempt(tok *QueueCustody, itemID string, ocGen uint64) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		return 0, errQueueArchived
	}
	if err := s.fenceGateLocked(tok); err != nil {
		return 0, err
	}
	for i := range s.items {
		if s.items[i].ID != itemID {
			continue
		}
		if s.items[i].State != QueueDispatching {
			return 0, fmt.Errorf("queue: begin attempt: item %s state %s, want dispatching (claim first)", itemID, s.items[i].State)
		}
		pre := s.items[i] // rollback snapshot (scalar + slice header)
		s.items[i].Attempts = append(s.items[i].Attempts, QueueAttempt{
			Generation:   tok.gen,
			OCGeneration: ocGen,
			StartedAt:    queueNow().UnixMilli(),
		})
		if err := s.save(); err != nil {
			s.items[i] = pre
			return 0, err
		}
		return len(s.items[i].Attempts) - 1, nil
	}
	return 0, errQueueNotFound
}

// RecordAttemptOutcome durably records the transport-class outcome receipt
// for one journal attempt (`sending → receipt`): EndedAt, TransportClass
// (connect_failed | written_unknown | server_error | accepted_2xx), and an
// optional diagnostic Detail. Slice 2a records the receipt and NOTHING else:
// no auto-redelivery, no auto-resolve — classification decisions (observed /
// ambiguous / certified-redeliver) belong to the reconciler (passive, this
// slice) and the certified recovery classes (slice 2b, only after the crash
// proofs). A receipt for an ALREADY-ENDED attempt is rejected (an attempt
// journals exactly one outcome).
func (s *sessionQueueStore) RecordAttemptOutcome(tok *QueueCustody, itemID string, attemptIdx int, class QueueAttemptTransportClass, detail string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		return errQueueArchived
	}
	if err := s.fenceGateLocked(tok); err != nil {
		return err
	}
	for i := range s.items {
		if s.items[i].ID != itemID {
			continue
		}
		if attemptIdx < 0 || attemptIdx >= len(s.items[i].Attempts) {
			return fmt.Errorf("queue: record outcome: item %s has no attempt %d", itemID, attemptIdx)
		}
		if s.items[i].Attempts[attemptIdx].TransportClass != "" {
			return fmt.Errorf("queue: record outcome: item %s attempt %d already ended (%s)", itemID, attemptIdx, s.items[i].Attempts[attemptIdx].TransportClass)
		}
		// Rollback snapshot BY VALUE of the target attempt (gate review
		// T1B-F1): a shallow item copy (`pre := s.items[i]`) snapshots only
		// the Attempts slice HEADER — the backing array stays aliased, so
		// the in-place receipt writes below would SURVIVE `s.items[i] = pre`
		// after a save failure. Memory would then show an ended attempt disk
		// doesn't have (receipt retries rejected as "already ended"), and a
		// later successful save would silently persist the receipt the
		// caller was told failed — breaking the journal's atomic
		// durable-transition contract. The append-based rollback in
		// BeginDispatchAttempt is unaffected (restoring the slice header
		// suffices there); only this in-place mutation path needs the
		// by-value attempt snapshot.
		preAtt := s.items[i].Attempts[attemptIdx]
		s.items[i].Attempts[attemptIdx].EndedAt = queueNow().UnixMilli()
		s.items[i].Attempts[attemptIdx].TransportClass = class
		s.items[i].Attempts[attemptIdx].Detail = detail
		if err := s.save(); err != nil {
			s.items[i].Attempts[attemptIdx] = preAtt
			return err
		}
		return nil
	}
	return errQueueNotFound
}

// maxCertifiedRedeliveries bounds how many total dispatch attempts one item
// tolerates under the certified-recovery loop (slice 2b phase 2). Classes 1-3
// (design.md "Certified Redelivery") are unconditioned per-occurrence, so
// without a cap a persistently-down OpenCode would produce an infinite
// claim→connect_failed→requeue cycle at the recovery cadence. The cap
// mirrors reconcileMaxAttempts's philosophy (bounded work, operator-facing
// exhaustion) — an item that exhausts it terminalizes as unknown with an
// explicit budget-exhausted detail (NOT the ambiguous marker: exhaustion is
// "we stopped trying", not "delivery is uncertain").
const maxCertifiedRedeliveries = 8

// requeueBudgetExhaustedDetailFmt is the terminal detail when an item hits
// maxCertifiedRedeliveries. The %d is the attempt count.
const requeueBudgetExhaustedDetailFmt = "Certified redelivery budget exhausted after %d attempt(s): every certified redelivery class stayed recoverable but the dispatch never succeeded (OpenCode likely unreachable). Manual review advised."

// RequeueForCertifiedRedelivery transitions one item BACK into the
// dispatchable state after the classifier certified a redelivery class
// (never-started / connect_failed / post-restart barrier — the operator-
// accepted debate-4 DEFAULT ladder). Slice 2b phase 2's ONLY repend path,
// and deliberately narrow:
//
//   - Accepted states: `unknown` (already recovered) or `dispatching` (stale
//     only — re-checked under s.mu so an IN-FLIGHT dispatch is never
//     requeued under itself).
//   - The OpenCode correlation id is PRESERVED VERBATIM (mint-at-claim
//     invariant, queue.go "PROPERTIES PRESERVED"): redelivery re-POSTs under
//     the SAME opencodeMsgID. This is safe for exactly the certified
//     classes — never-started (the id never left the machine: zero attempt
//     records prove no POST ran), connect_failed (the dial never established
//     ⇒ OpenCode never saw the id), and the post-restart barrier (a
//     post-restart exact-ID GET 404 proves the projector transaction never
//     committed, and the projector pin shows MessageUpdated UPSERTS by
//     message id, so even a racing late fiber cannot create a second row).
//     A RE-MINT is never performed here: only Claim mints, and this path
//     bypasses Claim on purpose (the design's "redispatch same
//     opencodeMsgID" for the barrier class; re-minting would also orphan the
//     reconciler correlation for any id OpenCode DID see).
//   - Bookkeeping reset: ReconcileAttempts/ReconcileTerminal/AmbiguousDelivery
//     clear and the in-memory reconcile throttle entry is pruned — the item
//     re-enters the dispatch lifecycle with a fresh reconciliation budget
//     for its next outcome.
//   - DispatchStartedAt is re-stamped to NOW so stale-dispatch recovery does
//     not immediately re-`unknown` the item before the drain loop resumes
//     it (the loop's resume is begin→fence→POST→receipt for an
//     already-dispatching item — ResumeQueuedDispatchAttempt).
//   - Fenced like every custody mutation (fenceGateLocked) and rolled back
//     on save failure.
func (s *sessionQueueStore) RequeueForCertifiedRedelivery(tok *QueueCustody, itemID, justification string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		return errQueueArchived
	}
	if err := s.fenceGateLocked(tok); err != nil {
		return err
	}
	nowMs := queueNow().UnixMilli()
	thresholdMs := int64(currentStaleThreshold() / time.Millisecond)
	for i := range s.items {
		if s.items[i].ID != itemID {
			continue
		}
		st := s.items[i].State
		switch {
		case st == QueueUnknown:
			// recovered terminal — requeue allowed
		case st == QueueDispatching:
			// stale only: an in-flight dispatch (fresh DispatchStartedAt, or
			// the legacy zero timestamp inside its first threshold window)
			// must never be requeued under itself.
			started := s.items[i].DispatchStartedAt
			if started > 0 && nowMs-started <= thresholdMs {
				return fmt.Errorf("queue: requeue: item %s dispatch is in flight (started %dms ago, threshold %dms)", itemID, nowMs-started, thresholdMs)
			}
		default:
			return fmt.Errorf("queue: requeue: item %s state %s, want unknown or stale dispatching", itemID, st)
		}
		if len(s.items[i].Attempts) >= maxCertifiedRedeliveries {
			// Budget exhausted: terminal unknown (fail-closed), never
			// ambiguous-marked (exhaustion is not delivery uncertainty).
			pre := s.items[i]
			s.items[i].State = QueueUnknown
			s.items[i].ResolvedAt = nowMs
			s.items[i].Detail = fmt.Sprintf(requeueBudgetExhaustedDetailFmt, len(s.items[i].Attempts))
			s.items[i].ReconcileTerminal = true
			s.items[i].RequeuePending = false // terminal items await nothing
			// [deferred C-F2] exhaustion ≠ uncertainty: a stale ambiguous
			// marker must not survive the budget terminal (mirrors the
			// requeue branch's reset) — slice 3's FE consumes the marker.
			s.items[i].AmbiguousDelivery = false
			if err := s.save(); err != nil {
				s.items[i] = pre
				return err
			}
			delete(s.reconcileLast, itemID)
			return nil
		}
		pre := s.items[i] // rollback snapshot (scalar fields only)
		s.items[i].State = QueueDispatching
		s.items[i].DispatchStartedAt = nowMs
		s.items[i].ResolvedAt = 0
		s.items[i].ReconcileAttempts = 0
		s.items[i].ReconcileTerminal = false
		s.items[i].AmbiguousDelivery = false
		s.items[i].RequeuePending = true
		s.items[i].Detail = justification
		if err := s.save(); err != nil {
			s.items[i] = pre
			return err
		}
		delete(s.reconcileLast, itemID)
		return nil
	}
	return errQueueNotFound
}

// invalidateLoadedCache drops the store's lazy-loaded in-memory copy so the
// next mutation re-reads queue.json from disk (T1C-F3, matured phase-1
// defer). The drain loop calls it on every registered store of a project
// root AT CUSTODY ACQUISITION: the fence authority (queue.custody.gen) is
// always read fresh from disk, but the store's `loaded` cache could predate
// the acquisition — masking any queue.json write that landed between the
// cache's load and this epoch (e.g. a legacy browser claim that raced the
// arbitration probe). After invalidation the first custody mutation reloads
// disk state, so a pre-epoch foreign write is OBSERVED (and the fence's
// queue.json FenceGeneration comparison runs against the real file) instead
// of being silently overwritten by the cached view. Within the held epoch
// the store remains the single writer (arbitration + fence refuse everyone
// else), so no per-mutation reload is needed — the invalidation point is
// the epoch boundary. Safe with respect to unsaved in-memory state: every
// mutation persists via save() before returning, so memory==disk at any
// quiet point this can run.
func (s *sessionQueueStore) invalidateLoadedCache() {
	s.mu.Lock()
	s.loaded = false
	s.mu.Unlock()
}

// invalidateStoresUnderRoot invalidates the lazy-load cache of every
// REGISTERED store under root (see invalidateLoadedCache). Filesystem-only
// sessions (queue.json present, store never materialized in this process)
// need nothing: their store loads fresh on first touch.
func (qr *queueRegistry) invalidateStoresUnderRoot(root string) {
	prefix := root + "\x00"
	qr.mu.Lock()
	var stores []*sessionQueueStore
	for k, st := range qr.stores {
		if strings.HasPrefix(k, prefix) {
			stores = append(stores, st)
		}
	}
	qr.mu.Unlock()
	for _, st := range stores {
		st.invalidateLoadedCache()
	}
}
