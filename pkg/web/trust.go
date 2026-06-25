package web

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// Managed-project config trust store (the security gate for running repo-declared
// commands). vh-solara will EXECUTE commands a project's .vh-solara/project.jsonc
// declares; that must be an explicit, per-project opt-in — never silent. A project
// is trusted for exactly one config hash; editing the config re-gates it.
//
// Records live at <stateBaseDir()>/trust/<sha1(canonicalDir)>.json. The dir is
// canonicalized through EvalSymlinks so a symlink-alias of an already-trusted path
// can't bypass the gate.

// Trust states surfaced to the UI.
const (
	TrustTrusted   = "trusted"   // record present and hash matches
	TrustChanged   = "changed"   // previously trusted, but config hash differs now
	TrustUntrusted = "untrusted" // never trusted (no record)
)

// TrustRecord is the persisted opt-in for one project config.
type TrustRecord struct {
	Dir        string    `json:"dir"`         // canonical absolute project dir
	ConfigHash string    `json:"config_hash"` // sha256 hex of the approved config
	TrustedAt  time.Time `json:"trusted_at"`
}

// TrustStore is the per-project config-truth ledger.
type TrustStore struct {
	base string     // directory holding <sha1>.json records
	mu   sync.Mutex // guards the on-disk record files
}

// NewTrustStore creates a store rooted at <stateBaseDir()>/trust.
func NewTrustStore() (*TrustStore, error) {
	base := filepath.Join(stateBaseDir(), "trust")
	if err := os.MkdirAll(base, 0o700); err != nil {
		return nil, err
	}
	return &TrustStore{base: base}, nil
}

// NewTrustStoreAt is for tests/fixtures that want an isolated root.
func NewTrustStoreAt(base string) *TrustStore {
	_ = os.MkdirAll(base, 0o700)
	return &TrustStore{base: base}
}

// canonicalDir resolves a project dir to a stable absolute path with symlinks
// evaluated, so two paths that refer to the same on-disk project share one trust
// record. It never returns "" — on any failure it falls back to filepath.Abs.
func canonicalDir(dir string) string {
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	if real, err := filepath.EvalSymlinks(dir); err == nil && real != "" {
		return real
	}
	return dir
}

func (ts *TrustStore) recordPath(dir string) string {
	sum := sha1Sum(canonicalDir(dir))
	return filepath.Join(ts.base, sum+".json")
}

// State reports the trust state of (dir, configHash). TrustChanged means a record
// exists for dir but its hash differs (config was edited since approval).
func (ts *TrustStore) State(dir, configHash string) string {
	rec, ok := ts.load(dir)
	if !ok {
		return TrustUntrusted
	}
	if rec.ConfigHash == configHash {
		return TrustTrusted
	}
	return TrustChanged
}

// IsTrusted is true only when a record exists AND its hash matches exactly.
func (ts *TrustStore) IsTrusted(dir, configHash string) bool {
	return ts.State(dir, configHash) == TrustTrusted
}

// Grant records approval of this exact config hash for the project. Idempotent.
func (ts *TrustStore) Grant(dir, configHash string) error {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	rec := TrustRecord{Dir: canonicalDir(dir), ConfigHash: configHash, TrustedAt: time.Now().UTC()}
	return writeTrustRecord(ts.recordPath(dir), rec)
}

// Revoke removes the trust record for a project (next open re-gates). No error if
// there was no record.
func (ts *TrustStore) Revoke(dir string) error {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	if err := os.Remove(ts.recordPath(dir)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// load reads the record for dir (if any). Caller may hold or not hold ts.mu.
func (ts *TrustStore) load(dir string) (TrustRecord, bool) {
	b, err := os.ReadFile(ts.recordPath(dir))
	if err != nil {
		return TrustRecord{}, false
	}
	var rec TrustRecord
	if err := json.Unmarshal(b, &rec); err != nil {
		return TrustRecord{}, false
	}
	return rec, true
}

// writeTrustRecord atomically writes (temp + rename) so a crash mid-write can't
// leave a truncated/partial trust record.
func writeTrustRecord(path string, rec TrustRecord) error {
	b, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	vhlog.Info("managed-project trust granted", "dir", rec.Dir, "hash", rec.ConfigHash)
	return nil
}

// sha1Sum returns the hex sha1 of s (matches the projectKey scheme in notes.go).
func sha1Sum(s string) string {
	return projectKey(s)
}
