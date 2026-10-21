package server

// notify_registry.go — the controller's enrolled notify-source registry
// (notify controller-hub S2 / v4 §2 step 2, §9.7): which connected workers
// advertised the notify capability, under what durable source identity
// {source_id, epoch}, with which ownership-handshake START state
// {mode, fenced, H} and private-feed bearer token. This is the GROUNDWORK
// store for S3's pull loop — S2 only records and persists it.
//
// Persistence: in-memory always; file-backed when an anchor path is armed
// (LoadNotifyStore derives `<notify-store>.sources`, the same
// derived-path convention the delivery-history file uses). Atomic
// tmp+rename, 0600, write-on-change. A missing anchor file in an existing
// directory starts empty (created on first change); an UNREADABLE or
// malformed existing file is a load error the caller surfaces at startup —
// never a silent reset (the same discipline as --notify-store itself).
//
// Secret hygiene: the per-worker feed token is a secret-in-storage. It never
// appears in logs or diagnostics shapes — Describe() returns token-less
// copies for any read surface; only the internal Get (the S3 pull path)
// exposes it.
//
// Mixed-version semantics (v4 §9.7): a registration WITHOUT a notify block
// removes the worker's entry — the capability disappeared (downgrade), so
// central eligibility stops. A registration with an INVALID block (failed
// tunnel.NotifyEnrollment.Validate, or source_id != worker id) is rejected
// and NEVER recorded — but the worker still registers: a malformed
// capability must not take the tunnel down, it only fails to enroll.

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/tunnel"
)

// NotifySourceEntry is one enrolled source's controller-side record.
type NotifySourceEntry struct {
	SourceID   string `json:"source_id"`
	WorkerID   string `json:"worker_id"`
	WorkerName string `json:"worker_name"`
	Epoch      string `json:"epoch"`
	NotifyCap  int    `json:"notify_cap"`
	// Mode/Fenced/Watermark are the ownership-handshake START fields the
	// worker reported at enrollment (brief §2 "Ownership and cutover");
	// full transfer semantics land S3/S4.
	Mode      string `json:"mode"`
	Fenced    bool   `json:"fenced"`
	Watermark *int64 `json:"watermark"`
	// Ineligible marks a worker whose notify advertisement was REFUSED at
	// the registration gate (B2): it carried a structurally valid notify
	// block, but the registration was not authenticated (the controller's
	// open-registration posture — no RegSecret), and "a self-asserted
	// worker ID is not sufficient security evidence" (brief §2 step 2).
	// The entry is the explicit notify-INELIGIBLE representation: it never
	// carries a token, never enrolls, and exists so an operator reading the
	// registry sees the refused capability rather than a silent absence.
	// An eligible enrollment (same source_id key) overwrites it.
	Ineligible bool `json:"ineligible,omitempty"`
	// Token is the worker's private-feed bearer credential — secret in
	// storage; never logged, never served by Describe.
	Token    string `json:"token"`
	LastSeen int64  `json:"last_seen"` // unix millis of the last carrying registration
}

// notifySourceFile is the persisted document shape.
type notifySourceFile struct {
	Schema  int                 `json:"schema"`
	Sources []NotifySourceEntry `json:"sources"`
}

const notifySourcesSchema = 1

// notifySourceRegistry is the mutex-guarded enrolled-source map (keyed by
// source_id — the dedupe identity; one source per worker in v4). A nil or
// zero-value registry is memory-only.
type notifySourceRegistry struct {
	mu      sync.Mutex
	path    string // "" = memory-only (no anchor armed)
	sources map[string]NotifySourceEntry
}

// newNotifySourceRegistry builds a MEMORY-ONLY registry. The file anchor is
// installed later by armNotifySources (LoadNotifyStore derives it); until
// then entries live and die with the process — the literal-built Daemon
// posture (tests, e2e).
func newNotifySourceRegistry() *notifySourceRegistry {
	return &notifySourceRegistry{sources: make(map[string]NotifySourceEntry)}
}

// armNotifySources installs the persistence anchor (or stays memory-only on
// ""). Returns an error when an existing anchor file is unreadable or
// malformed — startup must fail loudly rather than run unpersisted (the
// --notify-store discipline).
func (r *notifySourceRegistry) armNotifySources(path string) error {
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			r.mu.Lock()
			r.path = path
			r.mu.Unlock()
			return nil
		}
		return fmt.Errorf("notify sources %s: %w", path, err)
	}
	var f notifySourceFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return fmt.Errorf("notify sources %s: malformed: %w", path, err)
	}
	if f.Schema != notifySourcesSchema {
		return fmt.Errorf("notify sources %s: schema %d != %d", path, f.Schema, notifySourcesSchema)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.path = path
	r.sources = make(map[string]NotifySourceEntry, len(f.Sources))
	for _, s := range f.Sources {
		if s.SourceID != "" {
			r.sources[s.SourceID] = s
		}
	}
	return nil
}

// persistLocked writes the registry canonically (atomic tmp+rename, 0600).
// Caller holds mu. Memory-only registries (no path) are a no-op.
func (r *notifySourceRegistry) persistLocked() error {
	if r.path == "" {
		return nil
	}
	f := notifySourceFile{Schema: notifySourcesSchema, Sources: make([]NotifySourceEntry, 0, len(r.sources))}
	for _, s := range r.sources {
		f.Sources = append(f.Sources, s)
	}
	out, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(r.path), 0o700); err != nil {
		return err
	}
	tmp := r.path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, r.path)
}

// RecordNotifyEnrollment validates and records (or rejects) the enrollment a
// registration carried. workerID/workerName are the REGISTERED identity —
// the one-source-per-worker rule (v4 §3.1: "source_id equals worker.id")
// makes a mismatched SourceID a rejection, never a record. A nil enrollment
// is the capability-disappeared path: the worker's entry (if any) is removed
// (v4 §9.7 downgrade row — central eligibility stops with the capability).
// The return value reports whether an eligible entry is now recorded.
func (r *notifySourceRegistry) RecordNotifyEnrollment(enroll *tunnel.NotifyEnrollment, workerID, workerName string) bool {
	if enroll == nil {
		r.mu.Lock()
		defer r.mu.Unlock()
		if _, ok := r.sources[workerID]; ok {
			delete(r.sources, workerID)
			if err := r.persistLocked(); err != nil {
				// In-memory truth is authoritative for liveness; a persist
				// failure is logged (no secrets) and retried by the next
				// registration.
				log.Printf("notify sources: capability-disappeared persist failed: %v", err)
			}
			log.Printf("notify sources: worker %s re-registered without notify capability — removed from central eligibility", workerID)
		}
		return false
	}
	if err := enroll.Validate(); err != nil {
		log.Printf("notify sources: rejected enrollment from worker %s: %v", workerID, err)
		return false
	}
	if enroll.SourceID != workerID {
		// One source per worker: the enrollment's source identity MUST be
		// the registered worker id. A self-asserted mismatch is never a
		// recordable binding (brief §2 step 2: "a self-asserted worker ID
		// is not sufficient security evidence").
		log.Printf("notify sources: rejected enrollment from worker %s: source_id %q != worker id (one-source-per-worker)", workerID, enroll.SourceID)
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	prev, had := r.sources[enroll.SourceID]
	entry := NotifySourceEntry{
		SourceID:   enroll.SourceID,
		WorkerID:   workerID,
		WorkerName: workerName,
		Epoch:      enroll.Epoch,
		NotifyCap:  enroll.NotifyCap,
		Mode:       enroll.Mode,
		Fenced:     enroll.Fenced,
		Watermark:  enroll.Watermark,
		Token:      enroll.Token,
		LastSeen:   time.Now().UnixMilli(),
	}
	r.sources[enroll.SourceID] = entry
	if err := r.persistLocked(); err != nil {
		log.Printf("notify sources: enrollment persist failed (kept in memory): %v", err)
	}
	if !had || prev.Epoch != enroll.Epoch {
		log.Printf("notify sources: enrolled %s (worker %s) epoch %s cap %d mode %q fenced=%v (new source identity)",
			enroll.SourceID, workerID, shortEpoch(enroll.Epoch), enroll.NotifyCap, enroll.Mode, enroll.Fenced)
	}
	return true
}

// MarkNotifyIneligible records the explicit notify-INELIGIBLE representation
// for a worker whose registration carried a notify block but was NOT
// authenticated (B2: the controller's open-registration posture — RegSecret
// unset, so any peer can dial and self-assert a worker ID). The enrollment
// is NOT recorded (no epoch, no token, never eligible); the marker exists so
// the refusal is visible in the registry instead of a silent absence, and a
// later authenticated enrollment (same source_id key) overwrites it.
//
// Logs ONE visible line (numbers/IDs only — no secrets) the FIRST time per
// worker (the transition into ineligibility); steady-state re-registrations
// that would rewrite the identical marker do not re-log.
func (r *notifySourceRegistry) MarkNotifyIneligible(workerID, workerName string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	prev, had := r.sources[workerID]
	entry := NotifySourceEntry{
		SourceID:   workerID,
		WorkerID:   workerID,
		WorkerName: workerName,
		Ineligible: true,
		LastSeen:   time.Now().UnixMilli(),
	}
	already := had && prev.Ineligible && prev.WorkerName == workerName && prev.Token == "" && prev.Epoch == ""
	if already {
		// Refresh LastSeen only; no log noise, no persist churn beyond the
		// timestamp change.
		prev.LastSeen = entry.LastSeen
		r.sources[workerID] = prev
		return
	}
	r.sources[workerID] = entry
	if err := r.persistLocked(); err != nil {
		log.Printf("notify sources: ineligibility persist failed (kept in memory): %v", err)
	}
	log.Printf("notify sources: worker %s advertised the notify capability over an UNAUTHENTICATED registration (no registration secret configured) — enrollment refused, worker marked notify-ineligible", workerID)
}

// Get returns the full entry (token included) for the pull path. Only the
// controller's internal fetch surfaces may consume the token. An
// Ineligible entry carries no token by construction; callers must check
// entry.Ineligible before treating an entry as an enrolled source.
func (r *notifySourceRegistry) Get(sourceID string) (NotifySourceEntry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.sources[sourceID]
	return e, ok
}

// Describe returns token-less copies of all entries — the diagnostics shape.
// Tokens are secrets-in-storage; they never cross a read surface.
func (r *notifySourceRegistry) Describe() []NotifySourceEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]NotifySourceEntry, 0, len(r.sources))
	for _, e := range r.sources {
		e.Token = ""
		out = append(out, e)
	}
	return out
}

// DescribeNotifySources returns token-less copies of every enrolled source —
// the diagnostics/e2e observation surface for enrollment (S2; the S5 admin UI
// consumes the same shape). Tokens are secrets-in-storage and never cross a
// read surface; a nil registry (zero-value Daemon) reports empty.
func (d *Daemon) DescribeNotifySources() []NotifySourceEntry {
	if d == nil || d.notifySources == nil {
		return nil
	}
	return d.notifySources.Describe()
}

// shortEpoch reduces an epoch to a loggable prefix (epochs are 32-hex; a
// short prefix identifies without carrying the full value around logs).
func shortEpoch(epoch string) string {
	if len(epoch) <= 8 {
		return epoch
	}
	return epoch[:8] + "…"
}
