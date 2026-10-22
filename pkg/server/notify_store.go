package server

// notify_store.go — the file-backed push-notification token registry
// (slice S1; see notify_transport.go for the program header). Same
// persistence discipline as statusConfigHolder (status_config.go):
//
//   - explicit path ("" = registry disabled — every /vh/notify/* handler
//     answers the honest 409 posture naming --notify-store);
//   - mutex-guarded holder with coherent deep-copied snapshot reads and a
//     generation counter (bumped on STRUCTURAL changes only — create,
//     delete, patch; last_used_at/last_error bookkeeping deliberately does
//     NOT bump it, so send telemetry cannot churn S2's policy fencing).
//     SEPARATELY, every entry carries an in-memory per-REGISTRATION
//     generation (RegGen, t1a-F1) re-minted on each successful
//     registration refresh — see notifyStoreEntry.RegGen;
//   - atomic persist: canonical 2-space JSON + trailing newline, sibling
//     tmp file created EXCLUSIVELY at 0600 (write→sync→rename; a stale
//     loose-mode .tmp crash artifact is cleared and the create retried
//     once — a second collision fails the persist), persist BEFORE swap
//     (a failed persist leaves running state untouched);
//   - strict decode (DisallowUnknownFields, exactly one JSON document,
//     JSONC accepted on read like the status config) at startup load AND on
//     the persisted shape, so the file the server writes always reloads;
//   - load-time mode repair: a pre-existing file carrying group/other
//     permission bits (a normal 022 umask yields 0644) is tightened to
//     0600 at load with a one-line warning — the 0600 tmp+rename persist
//     only repairs the mode on the first registry mutation, which may
//     never come. A chmod failure fails startup loudly (b-F1).
//
// Entry shape (file + memory; schema 2 — notify controller-hub S4):
//
//	{"schema":2,"tokens":[{
//	  "id":"16-hex-chars",          // server-generated, 8 random bytes
//	  "token":"<raw FCM token>",    // stored VERBATIM — needed to send
//	  "label":"Operator phone",     // free text, ≤64 code points
//	  "push_policy":"when_unattended", // when_unattended (default) | always (v4 §3.1)
//	  "created_at":"RFC3339",
//	  "last_used_at":null,          // set on send attempts (best-effort)
//	  "last_error":"",              // last send failure text ("" = ok)
//	  "scope":{"enabled":true,"conditions":[]}
//	}]}
//
// scope.conditions is the selectable subset of the NINE fleet condition
// kinds (status.go fleetConditionOrder — validated against that single
// source of truth). An EMPTY list is stored explicitly and MEANS "all
// nine kinds" (S2 resolves it against the vocabulary, so a future tenth
// kind automatically reaches scope-all devices without a migration).
// Uniqueness: submitting the same raw token twice returns the EXISTING
// entry (idempotent) — never a duplicate.
//
// SCHEMA-1 MIGRATION (v4 §3.2, brief §5): a schema-1 file (the pre-S4
// controller registry — object with token records + scopes, no policies)
// migrates at load: every entry DEFAULTS conservatively to
// push_policy=when_unattended; ids/values/labels/creation/use/error
// metadata and scopes are preserved verbatim; scope.enabled=false stays
// disabled; unsupported legacy condition restrictions stay dormant and
// visible (never broadened). The migration is versioned, BACKUP-FIRST
// (the original bytes land at <path>.schema1.bak before anything is
// replaced), atomic (tmp+rename persist), and fail-closed (a backup or
// persist failure fails startup — the original file is left untouched).
// Re-migration is idempotent: the replaced file is schema-2 and reloads
// without a migration. A schema the build does not know (future) is
// REFUSED — a legacy binary equally refuses schema 2 ("schema version 2
// not supported (want 1)"), so a migrated store is never silently
// reopened by rollback (v4 §9.7).
//
// The raw token NEVER leaves this file + memory except as the Send()
// argument: every HTTP response shape renders notifyTokenWire (masked
// preview only). Backups of the store file must be protected like
// credentials (tokens are bearer send-targets).

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/vhqtvn/vh-solara/pkg/alerts"
	"github.com/vhqtvn/vh-solara/pkg/projectcfg"
)

const (
	// notifyStoreSchema is the file/schema version this build reads+writes.
	// Schema 2 (S4) adds the per-token push_policy; schema 1 migrates at
	// load (see the file header).
	notifyStoreSchema = 2
	// notifyStoreSchemaV1 is the pre-S4 controller registry version (no
	// push_policy). Accepted at load for migration only; never written.
	notifyStoreSchemaV1 = 1
	// notifyStoreBackupSuffix names the schema-1 pre-migration backup the
	// v4 migration writes BESIDE the store before replacing it.
	notifyStoreBackupSuffix = ".schema1.bak"
	// notifyTokenMinBytes / notifyTokenMaxBytes bound a submitted token:
	// real FCM registration tokens are ~152-163 printable-ASCII chars;
	// the floor stops trivial garbage and the ceiling (deliberately under
	// the 4 KiB request-body cap so a maximal token plus JSON syntax
	// always fits) stops abuse.
	notifyTokenMinBytes = 16
	notifyTokenMaxBytes = 2048
	// maxNotifyLabelRunes matches the fleet-config label ceiling.
	maxNotifyLabelRunes = 64
	// maxNotifyLastErrorBytes bounds the stored last_error text.
	maxNotifyLastErrorBytes = 512
	// notifyIDBytes is the entry-ID entropy (8 bytes → 16 hex chars).
	notifyIDBytes = 8
	// notifyTokenCap is the registry cap (v4 §3.1: the shared 32-token
	// bound — the same number as the worker registry's alerts.NotifyTokenCap).
	// Upserts of NEW tokens beyond it fail; an already-registered token
	// always succeeds (idempotent by token).
	notifyTokenCap = alerts.NotifyTokenCap
)

// notifyConditionSet is the selectable condition vocabulary — exactly the
// nine fleet condition kinds (single source of truth: status.go
// fleetConditionOrder).
var notifyConditionSet = func() map[string]bool {
	m := make(map[string]bool, len(fleetConditionOrder))
	for _, k := range fleetConditionOrder {
		m[k] = true
	}
	return m
}()

// ---------------------------------------------------------------------------
// Entry + file shape
// ---------------------------------------------------------------------------

// notifyScope is the per-device v1 policy: enabled gates the S2 sender;
// conditions is the explicit condition subset (empty = all nine kinds).
type notifyScope struct {
	Enabled    bool     `json:"enabled"`
	Conditions []string `json:"conditions"` // no omitempty: explicit [] means "all nine"
}

// notifyStoreEntry is one registered device.
type notifyStoreEntry struct {
	ID         string      `json:"id"`
	Token      string      `json:"token"`
	Label      string      `json:"label,omitempty"`
	PushPolicy string      `json:"push_policy"` // when_unattended (default) | always — always written explicitly (visible migration posture)
	CreatedAt  time.Time   `json:"created_at"`
	LastUsedAt *time.Time  `json:"last_used_at,omitempty"`
	LastError  string      `json:"last_error,omitempty"`
	Scope      notifyScope `json:"scope"`

	// RegGen is the IN-MEMORY per-registration generation (t1a-F1; never
	// persisted — json:"-"): the identity of the entry's CURRENT
	// incarnation, minted from the holder's counter whenever an entry is
	// installed (load, create) and RE-MINTED on every successful
	// registration refresh (the submit merge path: same id+token, new
	// label/policy). It feeds generation-bound pruning
	// (notify_dispatch.go): a prune closure captures it at send-claim
	// time and the atomic check-and-delete
	// (deleteIfRegistrationCurrent) refuses to prune when the incarnation
	// has moved — a stale in-flight UNREGISTERED must not delete a
	// since-REFRESHED registration (v4 §3.5 "older token generation").
	// Administrative patches and send telemetry deliberately PRESERVE it
	// (neither is a re-registration). Memory-only is sound:
	// StopNotifyDispatch joins every in-flight send before a reload can
	// re-mint, so no captured generation is ever compared across a load.
	RegGen uint64 `json:"-"`
}

// notifyStoreFile is the whole persisted document.
type notifyStoreFile struct {
	Schema int                `json:"schema"`
	Tokens []notifyStoreEntry `json:"tokens"`
}

// ---------------------------------------------------------------------------
// Validation (shared by file load and the HTTP surfaces)
// ---------------------------------------------------------------------------

// validNotifyToken enforces the charset/length sanity bounds: opaque
// printable-ASCII (0x21–0x7E — no whitespace, no controls, no non-ASCII),
// 16..2048 bytes.
func validNotifyToken(tok string) error {
	n := len(tok)
	if n < notifyTokenMinBytes || n > notifyTokenMaxBytes {
		return fmt.Errorf("length %d outside the %d..%d byte bounds", n, notifyTokenMinBytes, notifyTokenMaxBytes)
	}
	for i := 0; i < n; i++ {
		if tok[i] < 0x21 || tok[i] > 0x7e {
			return fmt.Errorf("byte at offset %d is not printable ASCII (tokens are opaque printable-ASCII strings; no whitespace or controls)", i)
		}
	}
	return nil
}

// validNotifyID pins the server-generated ID shape: 16 lowercase hex
// chars. Load rejects anything else (hand-edited files).
func validNotifyID(id string) bool {
	if len(id) != notifyIDBytes*2 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// validateNotifyScope enforces: conditions from the nine-kind vocabulary,
// no duplicates. Empty/nil = all nine (valid).
func validateNotifyScope(s notifyScope) error {
	seen := make(map[string]bool, len(s.Conditions))
	for i, c := range s.Conditions {
		if !notifyConditionSet[c] {
			return fmt.Errorf("conditions[%d]: unknown condition %q (selectable kinds are the nine fleet conditions)", i, c)
		}
		if seen[c] {
			return fmt.Errorf("conditions[%d]: duplicate condition %q", i, c)
		}
		seen[c] = true
	}
	return nil
}

// validateNotifyLabel enforces the ≤64-code-point label ceiling (empty ok).
func validateNotifyLabel(label string) error {
	if n := len([]rune(label)); n > maxNotifyLabelRunes {
		return fmt.Errorf("label: %d code points exceeds the %d-code-point limit", n, maxNotifyLabelRunes)
	}
	return nil
}

// validateNotifyEntry is the full per-entry check applied at file load
// (and defensively inside submit before persist).
func validateNotifyEntry(e *notifyStoreEntry) error {
	if !validNotifyID(e.ID) {
		return fmt.Errorf("id %q must be exactly %d lowercase hex chars", e.ID, notifyIDBytes*2)
	}
	if err := validNotifyToken(e.Token); err != nil {
		return fmt.Errorf("token: %v", err)
	}
	if err := validateNotifyLabel(e.Label); err != nil {
		return err
	}
	if p := e.PushPolicy; p != "" && p != alerts.PolicyWhenUnattended && p != alerts.PolicyAlways {
		return fmt.Errorf("push_policy %q is not %q or %q", p, alerts.PolicyWhenUnattended, alerts.PolicyAlways)
	}
	if e.CreatedAt.IsZero() {
		return errors.New("created_at is required")
	}
	return validateNotifyScope(e.Scope)
}

// newNotifyID mints an entry ID: 8 crypto-random bytes, lowercase hex.
func newNotifyID() (string, error) {
	b := make([]byte, notifyIDBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate token id: %v", err)
	}
	return hex.EncodeToString(b), nil
}

// ---------------------------------------------------------------------------
// Decode / persist
// ---------------------------------------------------------------------------

// decodeNotifyStore strictly decodes exactly ONE JSONC document into a
// validated store. Shared by the startup file load; the same parser would
// catch a hand-corrupted file at startup instead of mid-send. Schema 1
// (the pre-S4 shape, no push_policy) and schema 2 are accepted: a schema-1
// document returns the MIGRATED shape (schema 2, every policy defaulted to
// when_unattended) with migrated=true — the caller (loadNotifyStoreFile)
// then performs the backup-first, atomic, fail-closed file migration. A
// schema outside {1,2} is refused.
func decodeNotifyStore(data []byte) (f *notifyStoreFile, migrated bool, err error) {
	stripped := projectcfg.StripJSONC(data)
	dec := json.NewDecoder(bytes.NewReader(stripped))
	dec.DisallowUnknownFields()
	if derr := dec.Decode(&f); derr != nil {
		if errors.Is(derr, io.EOF) {
			return nil, false, errors.New("empty document")
		}
		return nil, false, fmt.Errorf("invalid JSON: %v", derr)
	}
	if f == nil {
		return nil, false, errors.New("document must be a JSON object, not null")
	}
	var trailing json.RawMessage
	if terr := dec.Decode(&trailing); !errors.Is(terr, io.EOF) {
		return nil, false, errors.New("expected exactly one JSON document (trailing content)")
	}
	switch f.Schema {
	case notifyStoreSchema:
	case notifyStoreSchemaV1:
		migrated = true
	default:
		return nil, false, fmt.Errorf("schema version %d not supported (this build reads %d and migrates %d)", f.Schema, notifyStoreSchema, notifyStoreSchemaV1)
	}
	seenID := make(map[string]bool, len(f.Tokens))
	seenToken := make(map[string]bool, len(f.Tokens))
	for i := range f.Tokens {
		e := &f.Tokens[i]
		if migrated {
			// Schema-1 documents predate push_policy: the conservative v4
			// §3.2 migration default. (A schema-1 file cannot carry a
			// policy — DisallowUnknownFields rejected the key in that
			// document shape — so this cannot override anything.)
			e.PushPolicy = alerts.PolicyWhenUnattended
		}
		if verr := validateNotifyEntry(e); verr != nil {
			return nil, false, fmt.Errorf("tokens[%d]: %v", i, verr)
		}
		if seenID[e.ID] {
			return nil, false, fmt.Errorf("tokens[%d]: duplicate id %q", i, e.ID)
		}
		seenID[e.ID] = true
		if seenToken[e.Token] {
			return nil, false, fmt.Errorf("tokens[%d]: duplicate token", i)
		}
		seenToken[e.Token] = true
		// Normalize nil conditions to the explicit empty list ("all nine").
		if e.Scope.Conditions == nil {
			e.Scope.Conditions = []string{}
		}
		// Canonical in-memory policy: the fail-closed default when absent.
		e.PushPolicy = alerts.NormalizePushPolicy(e.PushPolicy)
	}
	if f.Tokens == nil {
		f.Tokens = []notifyStoreEntry{}
	}
	if migrated {
		f.Schema = notifyStoreSchema
	}
	return f, migrated, nil
}

// notifyChmod is os.Chmod as a var so lane-1 tests can force the
// repair-failure branch deterministically (a real EPERM cannot be arranged
// portably in a unit test).
var notifyChmod = os.Chmod

// loadNotifyStoreFile reads and strictly decodes the registry at path.
// A MISSING file inside an existing directory is the one tolerated
// posture: it loads as the empty registry (exactly what decoding
// {"schema":2,"tokens":[]} produces); the file is created lazily by the
// first mutation through the existing atomic persist path. A missing or
// non-directory PARENT is a typo and returns an error naming the
// directory — fail at boot, not at first write. Every other error names
// the path plus the precise reason — a set-but-bad --notify-store is a
// startup failure, never a silent empty registry.
//
// A schema-1 document migrates (v4 §3.2 / brief §5): the ORIGINAL bytes
// are backed up to <path>.schema1.bak FIRST, then the migrated schema-2
// document replaces the file atomically (tmp+rename). Backup or persist
// failure returns an error — startup fails closed with the original file
// untouched. Re-loading a migrated file is a plain schema-2 load (the
// backup is not rewritten). See decodeNotifyStore for the field mapping.
//
// A successfully loaded file also has its mode secured: any bit beyond
// 0600 (group/other read/write/exec) is repaired with a one-line warning,
// because the file holds raw FCM bearer tokens (b-F1). Repair, not fatal
// — no data is destroyed; but a chmod FAILURE returns an error so
// startup fails loudly naming the path (the set-but-bad flag discipline).
// Windows caveat: Go synthesizes 0666/0444 permission bits there and
// Chmod only toggles the read-only attribute, so the repair branch fires
// benignly (one warning line per load; no failure short of an attribute
// error) — real Windows access control is ACL-based, outside these bits.
func loadNotifyStoreFile(path string) (*notifyStoreFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// First boot: empty start only when the parent directory
			// exists — otherwise the path is a typo and must fail now,
			// naming the directory. Short-circuits BEFORE the
			// decode/stat/repair sequence below: there is no file to
			// decode or secure yet.
			if perr := requireExistingParentDir(path); perr != nil {
				return nil, perr
			}
			return &notifyStoreFile{Schema: notifyStoreSchema, Tokens: []notifyStoreEntry{}}, nil
		}
		return nil, fmt.Errorf("read notify store %s: %v", path, err)
	}
	f, migrated, err := decodeNotifyStore(data)
	if err != nil {
		return nil, fmt.Errorf("notify store %s: %v", path, err)
	}
	if migrated {
		if err := migrateNotifyStoreFile(path, data, f); err != nil {
			return nil, fmt.Errorf("notify store %s: schema-1 migration: %v", path, err)
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("stat notify store %s: %v", path, err)
	}
	if perm := info.Mode().Perm(); perm&^0o600 != 0 {
		if err := notifyChmod(path, 0o600); err != nil {
			return nil, fmt.Errorf("notify store %s: tighten mode %o to 0600: %v", path, uint32(perm), err)
		}
		log.Printf("Warning: notify store %s was mode %o (group/other bits set on a file holding raw FCM bearer tokens) — repaired to 0600", path, uint32(perm))
	}
	return f, nil
}

// migrateNotifyStoreFile performs the versioned, backup-first, atomic,
// fail-closed schema-1 → schema-2 migration: raw (the exact pre-migration
// file bytes, JSONC included) lands at path+notifyStoreBackupSuffix via
// the same atomic 0600 discipline, THEN the migrated document replaces
// the store. A failure at either step aborts with the store file still
// holding the original schema-1 document (the persist is tmp+rename; the
// backup write happens before it).
func migrateNotifyStoreFile(path string, raw []byte, f *notifyStoreFile) error {
	backup := path + notifyStoreBackupSuffix
	if err := persistAtomic0600(backup, raw); err != nil {
		return fmt.Errorf("write schema-1 backup %s: %v", backup, err)
	}
	if err := persistNotifyStore(path, f); err != nil {
		return fmt.Errorf("replace with migrated schema-2 document: %v", err)
	}
	log.Printf("notify store %s: migrated schema 1 -> %d (policies defaulted to %s; %d token(s) preserved verbatim; original backed up at %s)",
		path, notifyStoreSchema, alerts.PolicyWhenUnattended, len(f.Tokens), backup)
	return nil
}

// notifyCreateExcl is the persist tmp exclusive-create seam — os.OpenFile
// with O_WRONLY|O_CREATE|O_EXCL at 0600. A var (like notifyChmod) so a
// lane-1 test can force the double-collision failure branch
// deterministically: a genuine second EEXIST landing between our own
// remove and create cannot be arranged portably in a unit test.
var notifyCreateExcl = func(name string) (*os.File, error) {
	return os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
}

// persistNotifyStore writes the canonical form (2-space indent, trailing
// newline, no comments) atomically via persistAtomic0600. See that helper
// for the O_EXCL/0600/rename discipline; callers serialize persists (the
// holder does, under its mutex).
func persistNotifyStore(path string, f *notifyStoreFile) error {
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal notify store: %v", err)
	}
	data = append(data, '\n')
	return persistAtomic0600(path, data)
}

// persistAtomic0600 publishes data at path atomically: an EXCLUSIVELY-
// created 0600 sibling tmp file → full write → sync → close → rename, so
// a crash mid-write can never leave a truncated document the next startup
// would refuse to load, and the published file is mode 0600 by
// construction. The tmp is created O_EXCL (never O_TRUNC) and never
// reused: Go applies the requested perm only when CREATING, so writing
// through a pre-existing <path>.tmp (a crash artifact from an interrupted
// persist, or anything else that grabbed the predictable sibling path)
// would publish the file at that artifact's mode. On EEXIST the stale tmp
// is cleared and the exclusive create retried ONCE; a second collision
// fails the persist naming path+reason — never a non-exclusive fallback
// write.
//
// Shared by the token registry (raw FCM bearer tokens — secret) and the
// notification history (non-secret, but the SAME discipline is kept for
// uniformity and defense-in-depth: one crash-safe write path, one mode
// posture, one set of tests). Callers serialize persists.
func persistAtomic0600(path string, data []byte) error {
	tmp := path + ".tmp"
	tf, err := notifyCreateExcl(tmp)
	if err != nil {
		if !errors.Is(err, os.ErrExist) {
			return fmt.Errorf("create %s: %v", tmp, err)
		}
		// Stale crash artifact (or foreign occupant), possibly at a
		// loose mode: clear it and retry the EXCLUSIVE create once.
		if rmErr := os.Remove(tmp); rmErr != nil {
			return fmt.Errorf("clear stale tmp %s: %v", tmp, rmErr)
		}
		if tf, err = notifyCreateExcl(tmp); err != nil {
			return fmt.Errorf("create %s after clearing a stale collision: %v", tmp, err)
		}
	}
	// Belt-and-braces: the exclusive create already requested 0600, but a
	// process umask masks creation modes DOWN (perm &^ umask), so pin the
	// exact mode — the rename must publish 0600 whatever the umask.
	if err := os.Chmod(tmp, 0o600); err != nil {
		_ = tf.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("secure %s to 0600: %v", tmp, err)
	}
	if _, err := tf.Write(data); err != nil {
		_ = tf.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("write %s: %v", tmp, err)
	}
	if err := tf.Sync(); err != nil {
		_ = tf.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("sync %s: %v", tmp, err)
	}
	if err := tf.Close(); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("close %s: %v", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename %s to %s: %v", tmp, path, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Clone helpers (snapshots never share mutable state with the holder)
// ---------------------------------------------------------------------------

func cloneNotifyScope(s notifyScope) notifyScope {
	out := notifyScope{Enabled: s.Enabled}
	out.Conditions = append([]string(nil), s.Conditions...)
	if out.Conditions == nil {
		out.Conditions = []string{}
	}
	return out
}

func cloneNotifyEntry(e *notifyStoreEntry) notifyStoreEntry {
	out := notifyStoreEntry{
		ID:         e.ID,
		Token:      e.Token,
		Label:      e.Label,
		PushPolicy: e.PushPolicy,
		CreatedAt:  e.CreatedAt,
		LastError:  e.LastError,
		Scope:      cloneNotifyScope(e.Scope),
		RegGen:     e.RegGen,
	}
	if e.LastUsedAt != nil {
		v := *e.LastUsedAt
		out.LastUsedAt = &v
	}
	return out
}

func cloneNotifyEntries(in []notifyStoreEntry) []notifyStoreEntry {
	out := make([]notifyStoreEntry, 0, len(in))
	for i := range in {
		out = append(out, cloneNotifyEntry(&in[i]))
	}
	return out
}

// ---------------------------------------------------------------------------
// Holder: mutex-guarded registry on the Daemon
// ---------------------------------------------------------------------------

// notifyStoreHolder is the daemon's notification-token registry: the
// entries plus the persistence path. Zero value = unconfigured (every
// mutating handler refuses with the 409 posture; the family's GET list
// refuses too — there is nothing meaningful to list without a store).
type notifyStoreHolder struct {
	mu      sync.Mutex
	path    string // persistence path; "" = registry disabled
	entries []notifyStoreEntry
	gen     uint64

	// regGenSeq mints the per-registration generations (notifyStoreEntry
	// .RegGen — see that field). Guarded by mu; deliberately NOT part of
	// the persisted shape.
	regGenSeq uint64

	// results/recordOnce carry the ASYNCHRONOUS send-telemetry drain: a
	// small buffered channel plus one drain goroutine, created lazily on
	// the first recordSendResultAsync call (see that method for why the
	// write must live off the send critical path). The goroutine runs for
	// the process lifetime — this daemon has no shutdown path for its
	// other forever-goroutines either (daemon.go Start).
	results    chan notifySendOutcome
	recordOnce sync.Once

	// flushMu/enqueued/processed/flushProgress carry the deterministic
	// join bookkeeping for the async drain (see flushSendResults):
	// enqueued counts outcomes handed to the drain goroutine, processed
	// counts outcomes whose recordSendResult — including the best-effort
	// persist — has COMPLETED. flushMu is deliberately NOT h.mu: the
	// drain takes it only for nanosecond counter updates, never across
	// the (slow, potentially wedged) persist, so the off-critical-path
	// contract of recordSendResultAsync is unaffected. flushProgress is
	// a close-broadcast wakeup channel, lazily (re)created under flushMu
	// so the holder's zero value stays valid.
	flushMu       sync.Mutex
	flushProgress chan struct{}
	enqueued      int
	processed     int
}

// notifySendOutcome is one queued recordSendResult job.
type notifySendOutcome struct {
	id  string
	err error
}

// notifyResultQueueDepth bounds the async telemetry backlog. Sends are
// few in v1 (one operator, a handful of devices); a full queue means the
// drain goroutine is wedged on a pathological persist, and DROPPING
// telemetry (never blocking the send path, never growing without bound)
// is the documented best-effort trade.
const notifyResultQueueDepth = 64

// notifyStoreSnapshot is one coherent deep copy of the holder state.
type notifyStoreSnapshot struct {
	path    string
	entries []notifyStoreEntry
	gen     uint64
}

func (h *notifyStoreHolder) snapshot() notifyStoreSnapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	return notifyStoreSnapshot{
		path:    h.path,
		entries: cloneNotifyEntries(h.entries),
		gen:     h.gen,
	}
}

func (h *notifyStoreHolder) generation() uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.gen
}

func (h *notifyStoreHolder) configured() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.path != ""
}

// setLoaded installs the startup registry (--notify-store): persistence
// path plus entries. Bumps gen. Each installed entry is minted a FRESH
// registration generation (RegGen) — a load births new in-memory
// incarnations (safe: StopNotifyDispatch joined every in-flight send
// before this can run).
func (h *notifyStoreHolder) setLoaded(path string, f *notifyStoreFile) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.path = path
	h.entries = cloneNotifyEntries(f.Tokens)
	for i := range h.entries {
		h.entries[i].RegGen = h.nextRegGenLocked()
	}
	h.gen++
}

// nextRegGenLocked mints the next per-registration generation. Caller
// holds h.mu.
func (h *notifyStoreHolder) nextRegGenLocked() uint64 {
	h.regGenSeq++
	return h.regGenSeq
}

// persistLocked writes the CURRENT entries under the holder lock. Caller
// holds h.mu.
func (h *notifyStoreHolder) persistLocked() error {
	if h.path == "" {
		return errors.New("no persistence path configured")
	}
	return persistNotifyStore(h.path, &notifyStoreFile{Schema: notifyStoreSchema, Tokens: cloneNotifyEntries(h.entries)})
}

// submit registers token (idempotently, v4 §3.1 FULL-STATE POST
// semantics): the body {token,label,push_policy} is the token's COMPLETE
// desired state. An existing entry with the same raw token gets its label
// AND policy REFRESHED (a re-POST without push_policy RESETS an always
// token to when_unattended) — but the ADMINISTRATIVE surfaces are never
// touched: scope.enabled=false stays disabled and explicit scope
// conditions stay restricted (a later Pulse POST does not override
// administrative disable/scopes, v4 §3.2). A successful refresh is a NEW
// REGISTRATION INCARNATION: the entry keeps its stable administrative ID,
// scopes, and metadata, but its per-registration generation (RegGen) is
// RE-MINTED (t1a-F1) — a dispatcher prune claimed against the
// pre-refresh incarnation must not delete the refreshed registration. A
// FAILED refresh (persist error) leaves RegGen untouched. A new entry
// gets a fresh ID, the given label/policy, created_at=now, and the
// default scope (enabled, conditions=[] = all nine); the registry cap
// (notifyTokenCap) refuses a NEW token beyond it. Labels over the
// ceiling are normalized to ≤64 code points ELLIPSIS INCLUDED on BOTH
// branches (normalizeNotifyLabel), and the merged refresh entry passes
// the SAME validateNotifyEntry gate a fresh create does BEFORE anything
// persists (t1b-F1): a successful public refresh can never leave behind
// a registry the strict reload would refuse. Persist-before-swap: a
// persist failure returns the error and leaves running state untouched.
// Bumps gen only on create (RegGen moves on every successful refresh).
func (h *notifyStoreHolder) submit(token, label, policy string) (entry notifyStoreEntry, created bool, err error) {
	if policy != "" && policy != alerts.PolicyWhenUnattended && policy != alerts.PolicyAlways {
		return notifyStoreEntry{}, false, alerts.ErrNotifyTokenPolicy
	}
	policy = alerts.NormalizePushPolicy(policy)
	label = normalizeNotifyLabel(label, maxNotifyLabelRunes)
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.path == "" {
		return notifyStoreEntry{}, false, errors.New("no persistence path configured")
	}
	for i := range h.entries {
		if h.entries[i].Token == token {
			merged := cloneNotifyEntry(&h.entries[i])
			merged.Label = label
			merged.PushPolicy = policy
			// t1b-F1: the merged refresh must pass the SAME strict
			// validation the file load applies (the create branch below
			// always has). Without this gate a successful public refresh
			// could persist a registry the strict reload REFUSES at next
			// startup — the byte-based truncator once produced a
			// 64-bytes+ellipsis (65-rune) label exactly here.
			// Post-normalization the label always passes; anything else
			// that fails is rejected WITHOUT persisting.
			if err := validateNotifyEntry(&merged); err != nil {
				return notifyStoreEntry{}, false, err
			}
			if err := persistNotifyStore(h.path, &notifyStoreFile{Schema: notifyStoreSchema, Tokens: withReplaced(cloneNotifyEntries(h.entries), i, merged)}); err != nil {
				return notifyStoreEntry{}, false, err
			}
			// The refresh landed: this is a NEW incarnation of the same
			// registration (stable id/scopes/metadata, moved RegGen) —
			// minted only AFTER the persist so a failed refresh cannot
			// invalidate in-flight prunes (t1a-F1).
			merged.RegGen = h.nextRegGenLocked()
			h.entries[i] = merged
			return cloneNotifyEntry(&h.entries[i]), false, nil
		}
	}
	if len(h.entries) >= notifyTokenCap {
		return notifyStoreEntry{}, false, alerts.ErrNotifyTokenCap
	}
	id, err := newNotifyID()
	if err != nil {
		return notifyStoreEntry{}, false, err
	}
	e := notifyStoreEntry{
		ID:         id,
		Token:      token,
		Label:      label,
		PushPolicy: policy,
		CreatedAt:  time.Now().UTC(),
		Scope:      notifyScope{Enabled: true, Conditions: []string{}},
		RegGen:     h.nextRegGenLocked(),
	}
	// Defense-in-depth: the constructed entry must pass the same
	// validation the file load applies (handler-side checks should have
	// caught label/token/policy problems already).
	if err := validateNotifyEntry(&e); err != nil {
		return notifyStoreEntry{}, false, err
	}
	h.entries = append(h.entries, e)
	if err := h.persistLocked(); err != nil {
		// Roll the in-memory append back: the swap never happened.
		h.entries = h.entries[:len(h.entries)-1]
		return notifyStoreEntry{}, false, err
	}
	h.gen++
	return cloneNotifyEntry(&h.entries[len(h.entries)-1]), true, nil
}

// byID returns a deep copy of the entry with the given ID.
func (h *notifyStoreHolder) byID(id string) (notifyStoreEntry, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for i := range h.entries {
		if h.entries[i].ID == id {
			return cloneNotifyEntry(&h.entries[i]), true
		}
	}
	return notifyStoreEntry{}, false
}

// delete removes the entry with the given ID. ok=false when unknown (the
// handler 404s). Persist-before-swap; bumps gen on success.
func (h *notifyStoreHolder) delete(id string) (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.path == "" {
		return false, errors.New("no persistence path configured")
	}
	idx := -1
	for i := range h.entries {
		if h.entries[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return false, nil
	}
	updated := append(h.entries[:idx:idx], h.entries[idx+1:]...)
	if err := persistNotifyStore(h.path, &notifyStoreFile{Schema: notifyStoreSchema, Tokens: cloneNotifyEntries(updated)}); err != nil {
		return true, err
	}
	h.entries = updated
	h.gen++
	return true, nil
}

// deleteIfRegistrationCurrent is the dispatcher's ATOMIC prune gate
// (t1a-F1): the generation check AND the conditional deletion run under
// ONE hold of the store mutex, so a registration refresh can never land
// between the check and the delete. The entry with the given id is
// removed only when its CURRENT token value and registration generation
// still match the values captured at send-claim time; every mismatch is
// the RETAIN verdict (deleted=false, err nil): unknown id (deleted
// mid-send, or re-registered as a NEW entry with a fresh random id),
// replaced token, or a REFRESHED registration whose generation moved past
// the captured one (same id+token re-POST — the merge path re-mints
// RegGen). Persist-before-swap like delete; bumps gen on success.
func (h *notifyStoreHolder) deleteIfRegistrationCurrent(id, token string, regGen uint64) (deleted bool, err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.path == "" {
		return false, errors.New("no persistence path configured")
	}
	idx := -1
	for i := range h.entries {
		if h.entries[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 || h.entries[idx].Token != token || h.entries[idx].RegGen != regGen {
		return false, nil // stale incarnation: since re-registered/replaced/refreshed — retain
	}
	updated := append(h.entries[:idx:idx], h.entries[idx+1:]...)
	if err := persistNotifyStore(h.path, &notifyStoreFile{Schema: notifyStoreSchema, Tokens: cloneNotifyEntries(updated)}); err != nil {
		return true, err
	}
	h.entries = updated
	h.gen++
	return true, nil
}

// notifyPatch is a partial update: nil fields keep the current value.
type notifyPatch struct {
	Label *string
	Scope *notifyScope
}

// patch applies a partial update to the entry with the given ID
// (ok=false when unknown). Validation runs against the MERGED entry, so a
// label/scope change cannot put the registry into a state the strict file
// load would reject. Persist-before-swap; bumps gen on success.
func (h *notifyStoreHolder) patch(id string, p notifyPatch) (notifyStoreEntry, bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.path == "" {
		return notifyStoreEntry{}, false, errors.New("no persistence path configured")
	}
	idx := -1
	for i := range h.entries {
		if h.entries[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return notifyStoreEntry{}, false, nil
	}
	merged := cloneNotifyEntry(&h.entries[idx])
	if p.Label != nil {
		merged.Label = *p.Label
	}
	if p.Scope != nil {
		merged.Scope = cloneNotifyScope(*p.Scope)
	}
	if err := validateNotifyEntry(&merged); err != nil {
		return notifyStoreEntry{}, true, err
	}
	if err := persistNotifyStore(h.path, &notifyStoreFile{Schema: notifyStoreSchema, Tokens: withReplaced(cloneNotifyEntries(h.entries), idx, merged)}); err != nil {
		return notifyStoreEntry{}, true, err
	}
	h.entries[idx] = merged
	h.gen++
	return cloneNotifyEntry(&h.entries[idx]), true, nil
}

// withReplaced returns a copy of entries with entries[i] replaced by e.
func withReplaced(entries []notifyStoreEntry, i int, e notifyStoreEntry) []notifyStoreEntry {
	out := append([]notifyStoreEntry(nil), entries...)
	out[i] = e
	return out
}

// recordSendResult updates last_used_at/last_error for the entry (unknown
// ID is a no-op — the entry may have been deleted mid-send). BEST-EFFORT:
// a persist failure is swallowed (the send outcome must not unwind on
// telemetry trouble); the in-memory entry is still updated so the next
// successful persist carries it. Does NOT bump gen (telemetry is not a
// structural change — see the file header).
func (h *notifyStoreHolder) recordSendResult(id string, sendErr error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	idx := -1
	for i := range h.entries {
		if h.entries[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return
	}
	now := time.Now().UTC()
	h.entries[idx].LastUsedAt = &now
	if sendErr != nil {
		h.entries[idx].LastError = truncateRunes(sendErr.Error(), maxNotifyLastErrorBytes)
	} else {
		h.entries[idx].LastError = ""
	}
	_ = h.persistLocked()
}

// recordSendResultAsync hands one send outcome to the background drain
// goroutine and returns IMMEDIATELY — the registry telemetry write (a
// full-file persist under the holder mutex) must never sit on the send
// critical path: the watcher's dispatch and the test-send handler answer
// without waiting for the file to land, and a slow/blocked persist cannot
// delay the next send. The drain runs recordSendResult (documented
// best-effort) exactly as the synchronous path did. When the queue is
// full the outcome is DROPPED with a log line (see
// notifyResultQueueDepth) — telemetry, not delivery, is the sacrificial
// layer. The zero-time lastNotifiedAt semantics of the watcher are
// unaffected: this records only registry bookkeeping. Every hand-off
// (and every drop) is reflected in the flush bookkeeping under flushMu
// so flushSendResults can join the drain deterministically.
func (h *notifyStoreHolder) recordSendResultAsync(id string, err error) {
	h.recordOnce.Do(func() {
		h.results = make(chan notifySendOutcome, notifyResultQueueDepth)
		go h.drainSendResults()
	})
	// The reservation (enqueued++) shares ONE flushMu critical section
	// with the send and its rollback, so a concurrent flushSendResults
	// never observes a half-reserved count: every outcome counted as
	// enqueued is already in the channel and owed a drain wakeup.
	// Holding flushMu across the buffered send is safe — flushMu is
	// never held across a persist.
	h.flushMu.Lock()
	h.enqueued++
	select {
	case h.results <- notifySendOutcome{id: id, err: err}:
	default:
		h.enqueued-- // dropped: the drain will never see this outcome
		log.Printf("notify: send-result queue full (depth %d) — dropping telemetry for token %s", notifyResultQueueDepth, id)
	}
	h.flushMu.Unlock()
}

// drainSendResults is the single background consumer of the async
// telemetry queue (started lazily, runs for the process lifetime).
func (h *notifyStoreHolder) drainSendResults() {
	for out := range h.results {
		h.recordSendResult(out.id, out.err)
		h.drainProgress()
	}
}

// drainProgress marks one queued outcome as fully recorded (recordSendResult
// has returned — the best-effort persist attempt is over) and wakes any
// flushSendResults waiter.
func (h *notifyStoreHolder) drainProgress() {
	h.flushMu.Lock()
	h.processed++
	if h.flushProgress != nil {
		close(h.flushProgress)
		h.flushProgress = nil
	}
	h.flushMu.Unlock()
}

// flushSendResults deterministically joins the async send-result drain:
// it blocks until every outcome handed to recordSendResultAsync so far
// has been fully recorded — recordSendResult returned and its best-effort
// persist with it. Tests wire it via t.Cleanup registered AFTER the
// t.TempDir call that owns the persistence path (cleanups run LIFO, so
// the join executes BEFORE the TempDir RemoveAll): without the join, the
// drain goroutine's persist can race the test temp dir's removal
// ("unlinkat ...: directory not empty"). Purely a join — it does NOT
// stop the drain (the daemon has no shutdown path), it preserves the
// drop-on-full policy, and it returns immediately on a holder whose
// drain never started or has nothing pending.
func (h *notifyStoreHolder) flushSendResults() {
	h.flushMu.Lock()
	for h.processed < h.enqueued {
		if h.flushProgress == nil {
			h.flushProgress = make(chan struct{})
		}
		wakeup := h.flushProgress
		// Release flushMu while waiting: publishers (senders, the drain's
		// progress updates) need it to signal completion.
		h.flushMu.Unlock()
		<-wakeup
		h.flushMu.Lock()
	}
	h.flushMu.Unlock()
}

// normalizeNotifyLabel bounds label to at most max CODE POINTS, counting
// any ellipsis it appends (the t1b-F1 label fix): a label over the
// ceiling is cut to its first max-1 runes + "…" (U+2026), so the RESULT
// — ellipsis included — is exactly max runes and always passes
// validateNotifyLabel at load; a label at or under the ceiling
// (including exactly max runes) is returned verbatim. The byte-based
// truncateRunes is NOT suitable here: on a 65-ASCII-char label it
// produced 64 bytes + the 1-rune ellipsis = 65 code points (a form the
// strict reload refuses), and on multibyte labels it cut far under the
// documented rune allowance (64 CJK runes = 192 bytes → ~21 runes).
func normalizeNotifyLabel(label string, max int) string {
	if max <= 0 {
		return ""
	}
	if utf8.RuneCountInString(label) <= max {
		return label
	}
	rs := make([]rune, 0, max)
	for _, r := range label {
		if len(rs) == max-1 {
			break
		}
		rs = append(rs, r)
	}
	return string(rs) + "…"
}

// truncateRunes cuts s to at most max BYTES on a rune boundary
// (byte-bounded text — last_error; labels use normalizeNotifyLabel).
func truncateRunes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := s[:max]
	for len(cut) > 0 && !utf8.RuneStart(cut[len(cut)-1]) {
		cut = cut[:len(cut)-1]
	}
	return cut + "…"
}

// ---------------------------------------------------------------------------
// Masked wire shape (the ONLY shape HTTP responses may render)
// ---------------------------------------------------------------------------

// notifyTokenWire is the response view of an entry: the raw token is
// replaced by a masked preview (first 6 + last 4 chars) — the raw token
// NEVER appears in any list/get/patch/create response.
type notifyTokenWire struct {
	ID           string      `json:"id"`
	Label        string      `json:"label"`
	TokenPreview string      `json:"token_preview"`
	PushPolicy   string      `json:"push_policy"`
	CreatedAt    time.Time   `json:"created_at"`
	LastUsedAt   *time.Time  `json:"last_used_at"`
	LastError    string      `json:"last_error"`
	Scope        notifyScope `json:"scope"`
}

// maskNotifyToken renders the masked preview: first 6 + "…" + last 4
// bytes. Tokens too short to preview safely (≤10 bytes — the preview
// would reconstruct most of the secret) render as full asterisks.
func maskNotifyToken(tok string) string {
	n := len(tok)
	if n <= 10 {
		return strings.Repeat("*", n)
	}
	return tok[:6] + "…" + tok[n-4:]
}

// notifyEntryWire converts an entry to its masked response shape.
func notifyEntryWire(e notifyStoreEntry) notifyTokenWire {
	return notifyTokenWire{
		ID:           e.ID,
		Label:        e.Label,
		TokenPreview: maskNotifyToken(e.Token),
		PushPolicy:   alerts.NormalizePushPolicy(e.PushPolicy),
		CreatedAt:    e.CreatedAt,
		LastUsedAt:   e.LastUsedAt,
		LastError:    e.LastError,
		Scope:        cloneNotifyScope(e.Scope),
	}
}

// policyCounts reports the token counts by push policy — the v4 probe's
// "policies" object (counts only, never values or labels; both keys always
// present; the two counts sum to the entry count).
func policyCounts(s *notifyStoreSnapshot) map[string]int {
	out := map[string]int{alerts.PolicyWhenUnattended: 0, alerts.PolicyAlways: 0}
	for i := range s.entries {
		out[alerts.NormalizePushPolicy(s.entries[i].PushPolicy)]++
	}
	return out
}

// ---------------------------------------------------------------------------
// Daemon surface
// ---------------------------------------------------------------------------

// LoadNotifyStore reads, validates, secures, and installs the
// notification-token registry at path (the --notify-store startup path).
// Securing = the load-time 0600 mode repair (see loadNotifyStoreFile). A
// missing file inside an EXISTING directory installs the empty registry,
// configured at that path (the file is created on the first mutation).
// Any other unreadable/invalid file returns an error naming the path and
// the precise reason — the caller (cmd/server.go) fails startup on it rather
// than silently running a disabled or empty registry. On error the
// daemon's registry state is unchanged.
//
// The same call installs the delivery-history holder at path+".history"
// (notify_history.go): a missing history file starts empty; a present-
// but-bad one fails here with the same set-but-bad discipline (the
// operator's reliable record is not silently discarded).
//
// It also arms the CENTRAL NOTIFY LEDGER journal at path+".ledger"
// (notify_ledger.go — notify controller-hub S3), with the just-armed
// path+".sources" file as its fail-closed deletion witness: a missing
// ledger alongside existing enrolled sources refuses startup (the global
// id head must never silently restart at 1 — see the ledger's recovery
// proof). Re-loading (controller-restart tests) re-arms from the committed
// journal and resumes committed cursors. Since S4 the re-load ALSO stops
// and JOINS the central dispatcher (notify_dispatch.go) — the ledger swap
// (armNotifyLedgerFor, under notifyLedgerMu) never lands under an in-flight
// dispatch claim/send — and since t1b-F1 the stop-joins precede the
// REGISTRY READ itself, extended by B-F1 to the THIRD writer: the
// legacy fleet watcher (notify_watcher.go) is stop-joined too (see
// the ordering invariant inside).
func (d *Daemon) LoadNotifyStore(path string) error {
	// ORDERING INVARIANT (t1b-F1, extended to all three writers by
	// B-F1): quiesce + JOIN every notify-writer loop BEFORE the
	// registry read — the ingest pull loop, the central dispatcher,
	// AND the legacy fleet watcher (notify_watcher.go), whose fan-out
	// sends carry the same generation-fenced UNREGISTERED prune
	// (deleteIfRegistrationCurrent, which persists the retirement
	// before swapping memory). All three stops are stop-JOINS — each
	// returns only after every pull/dispatch/tick goroutine has
	// drained, INCLUDING any in-flight FCM send AND its prune.
	// Reading the file first would let the installed snapshot
	// post-date a joined prune: an in-flight watcher (or dispatcher)
	// send whose canonical UNREGISTERED answer lands while the reload
	// is parked in the join durably retires the token, and setLoaded
	// would then reinstall the stale entry from the pre-join snapshot
	// — minting a fresh RegGen, resurrecting the confirmed-UNREGISTERED
	// token in memory (and a later persist could restore it to disk).
	// RegGen cannot fence this resurrection class: installing an older
	// registry snapshot is NOT a registration refresh — the install
	// post-dates a COMPLETED prune yet rewinds the registry past it.
	// Stop-then-read guarantees no installed snapshot can predate ANY
	// joined prune: a confirmed-UNREGISTERED token stays retired across
	// reload, in memory AND on disk.
	d.StopNotifyIngest()
	d.StopNotifyDispatch()
	d.StopNotifyWatcher()
	f, err := loadNotifyStoreFile(path)
	if err != nil {
		return err
	}
	if err := d.notifyHistory.setPath(path + ".history"); err != nil {
		return err
	}
	// Notify-source registry anchor (notify controller-hub S2): the same
	// derived-path convention as the history file. Set-but-bad fails
	// startup — never a silent memory-only fallback for a configured
	// controller. A lazy-built Daemon (zero value) gets its registry here.
	if d.notifySources == nil {
		d.notifySources = newNotifySourceRegistry()
	}
	if err := d.notifySources.armNotifySources(path + ".sources"); err != nil {
		return err
	}
	// Central ledger journal (notify controller-hub S3): armed AFTER the
	// sources anchor so the witness check sees the enrollment state. The
	// loops were already stopped — and JOINED (b-F2/B-F1: the stops above
	// return only after every pull/dispatch/tick goroutine has drained) —
	// at the TOP of this call, so the re-arm never swaps the ledger under
	// an in-flight commit, ACK, claim, or send (and the registry read
	// above never snapshots under one either).
	if err := d.armNotifyLedgerFor(path); err != nil {
		return err
	}
	d.notifyStore.setLoaded(path, f)
	return nil
}
