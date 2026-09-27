package server

// notify_store_test.go — lane-1 co-located tests for the push-token
// registry (slice S1; see notify_store.go). Covers: the strict decode
// matrix (unknown keys, bad schema, bad ids/tokens/conditions, JSONC on
// read, duplicate detection), idempotent submit, atomic persist + reload
// (canonical bytes, 0600, no tmp leftovers), PATCH/DELETE semantics via
// the holder, best-effort recordSendResult (persist failure must not
// panic and must still update memory), and the masking helper.

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// newStoreHolder builds a holder whose persistence path points inside a
// temp dir (file need not exist yet — first persist creates it).
func newStoreHolder(t *testing.T) (*notifyStoreHolder, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "notify-tokens.json")
	var h notifyStoreHolder
	h.setLoaded(path, &notifyStoreFile{Schema: notifyStoreSchema, Tokens: []notifyStoreEntry{}})
	return &h, path
}

// ---------------------------------------------------------------------------
// Strict decode matrix
// ---------------------------------------------------------------------------

// TestNotifyStore_DecodeValidationMatrix pins the file contract: strict
// fields, schema-1 gate, validated entries, JSONC accepted on read.
func TestNotifyStore_DecodeValidationMatrix(t *testing.T) {
	valid := []struct {
		name string
		in   string
		want []notifyStoreEntry
	}{
		{"empty registry", `{"schema":1,"tokens":[]}`, []notifyStoreEntry{}},
		{"nil tokens normalized", `{"schema":1}`, []notifyStoreEntry{}},
		{"JSONC comments accepted", "{\n  // registry\n  \"schema\": 1,\n  \"tokens\": [ { \"id\": \"0011223344556677\", \"token\": \"abcdefghijklmnop\", \"created_at\": \"2026-09-28T00:00:00Z\", \"scope\": {\"enabled\": true, \"conditions\": []}, }, ],\n}\n",
			[]notifyStoreEntry{{ID: "0011223344556677", Token: "abcdefghijklmnop", CreatedAt: time.Date(2026, 9, 28, 0, 0, 0, 0, time.UTC), Scope: notifyScope{Enabled: true, Conditions: []string{}}}}},
		{"nil conditions normalized to explicit all", `{"schema":1,"tokens":[{"id":"0011223344556677","token":"abcdefghijklmnop","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":false}}]}`,
			[]notifyStoreEntry{{ID: "0011223344556677", Token: "abcdefghijklmnop", CreatedAt: time.Date(2026, 9, 28, 0, 0, 0, 0, time.UTC), Scope: notifyScope{Enabled: false, Conditions: []string{}}}}},
		{"subset conditions", `{"schema":1,"tokens":[{"id":"0011223344556677","token":"abcdefghijklmnop","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true,"conditions":["worker_down","session_error"]}}]}`,
			[]notifyStoreEntry{{ID: "0011223344556677", Token: "abcdefghijklmnop", CreatedAt: time.Date(2026, 9, 28, 0, 0, 0, 0, time.UTC), Scope: notifyScope{Enabled: true, Conditions: []string{"worker_down", "session_error"}}}}},
	}
	for _, tc := range valid {
		f, err := decodeNotifyStore([]byte(tc.in))
		if err != nil {
			t.Errorf("%s: unexpected error: %v", tc.name, err)
			continue
		}
		if !reflect.DeepEqual(f.Tokens, tc.want) {
			t.Errorf("%s: entries = %+v, want %+v", tc.name, f.Tokens, tc.want)
		}
	}

	invalid := []struct {
		name   string
		in     string
		marker string
	}{
		{"empty document", ``, "empty document"},
		{"null document", `null`, "not null"},
		{"trailing second document", `{"schema":1,"tokens":[]} {"schema":1}`, "exactly one JSON document"},
		{"unknown top-level key", `{"schema":1,"tokens":[],"nope":1}`, `unknown field "nope"`},
		{"unknown entry key", `{"schema":1,"tokens":[{"id":"0011223344556677","token":"abcdefghijklmnop","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true,"conditions":[]},"bogus":1}]}`, `unknown field "bogus"`},
		{"unknown scope key", `{"schema":1,"tokens":[{"id":"0011223344556677","token":"abcdefghijklmnop","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true,"conditions":[],"x":1}}]}`, `unknown field "x"`},
		{"wrong schema", `{"schema":2,"tokens":[]}`, "schema version 2 not supported"},
		{"schema zero", `{"schema":0,"tokens":[]}`, "schema version 0 not supported"},
		{"id not hex", `{"schema":1,"tokens":[{"id":"zz","token":"abcdefghijklmnop","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true}}]}`, "must be exactly 16 lowercase hex"},
		{"id uppercase", `{"schema":1,"tokens":[{"id":"AABBCCDD00112233","token":"abcdefghijklmnop","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true}}]}`, "must be exactly 16 lowercase hex"},
		{"id wrong length", `{"schema":1,"tokens":[{"id":"00112233","token":"abcdefghijklmnop","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true}}]}`, "must be exactly 16 lowercase hex"},
		{"token too short", `{"schema":1,"tokens":[{"id":"0011223344556677","token":"short","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true}}]}`, "length 5 outside"},
		{"token with space", `{"schema":1,"tokens":[{"id":"0011223344556677","token":"abc defghijklmnop","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true}}]}`, "not printable ASCII"},
		{"token with control", `{"schema":1,"tokens":[{"id":"0011223344556677","token":"abc\u0001defghijklmno","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true}}]}`, "not printable ASCII"},
		{"token non-ascii", `{"schema":1,"tokens":[{"id":"0011223344556677","token":"ab€cdefghijklmnop","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true}}]}`, "not printable ASCII"},
		{"unknown condition", `{"schema":1,"tokens":[{"id":"0011223344556677","token":"abcdefghijklmnop","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true,"conditions":["made_up"]}}]}`, `unknown condition "made_up"`},
		{"duplicate condition", `{"schema":1,"tokens":[{"id":"0011223344556677","token":"abcdefghijklmnop","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true,"conditions":["worker_down","worker_down"]}}]}`, `duplicate condition "worker_down"`},
		{"missing created_at", `{"schema":1,"tokens":[{"id":"0011223344556677","token":"abcdefghijklmnop","scope":{"enabled":true}}]}`, "created_at is required"},
		{"label too long", `{"schema":1,"tokens":[{"id":"0011223344556677","token":"abcdefghijklmnop","label":"` + strings.Repeat("x", 65) + `","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true}}]}`, "code points exceeds"},
		{"duplicate id", `{"schema":1,"tokens":[{"id":"0011223344556677","token":"aaaaaaaaaaaaaaaa","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true}},{"id":"0011223344556677","token":"bbbbbbbbbbbbbbbb","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true}}]}`, `duplicate id`},
		{"duplicate token", `{"schema":1,"tokens":[{"id":"0011223344556677","token":"aaaaaaaaaaaaaaaa","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true}},{"id":"8899aabbccddeeff","token":"aaaaaaaaaaaaaaaa","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true}}]}`, `duplicate token`},
	}
	for _, tc := range invalid {
		_, err := decodeNotifyStore([]byte(tc.in))
		if err == nil {
			t.Errorf("%s: accepted invalid document", tc.name)
			continue
		}
		if !strings.Contains(err.Error(), tc.marker) {
			t.Errorf("%s: error %q does not contain marker %q", tc.name, err.Error(), tc.marker)
		}
	}
}

// TestNotifyStore_LoadFileErrors pins the startup-load failure shape
// (path named) and the success path installing entries.
func TestNotifyStore_LoadFileErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := loadNotifyStoreFile(filepath.Join(dir, "missing.json")); err == nil || !strings.Contains(err.Error(), "missing.json") {
		t.Errorf("missing file: want error naming the path, got %v", err)
	}
	bad := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(bad, []byte(`{"schema":1,"tokens":[],"x":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadNotifyStoreFile(bad); err == nil || !strings.Contains(err.Error(), "bad.json") {
		t.Errorf("bad file: want error naming the path, got %v", err)
	}

	var d Daemon
	if err := d.LoadNotifyStore(bad); err == nil {
		t.Error("LoadNotifyStore on a bad file must fail")
	}
	if d.notifyStore.configured() {
		t.Error("failed load must leave the daemon's registry state unchanged (disabled)")
	}
}

// ---------------------------------------------------------------------------
// Load-time mode repair (b-F1)
// ---------------------------------------------------------------------------

// TestNotifyStore_LoadRepairsLooseMode pins the b-F1 fix: an
// operator-created store file with group/other permission bits (0644 — the
// normal 022-umask posture) is tightened to 0600 at load, with a one-line
// warning naming the path and modes, while entries still install. An
// already-0600 file loads silently (no spurious repair).
func TestNotifyStore_LoadRepairsLooseMode(t *testing.T) {
	dir := t.TempDir()
	doc := `{"schema":1,"tokens":[{"id":"0011223344556677","token":"abcdefghijklmnop","created_at":"2026-09-28T00:00:00Z","scope":{"enabled":true,"conditions":[]}}]}`

	// Capture the standard logger (package tests run serially — no
	// t.Parallel anywhere in pkg/server).
	var lb strings.Builder
	oldLog := log.Writer()
	log.SetOutput(&lb)
	defer log.SetOutput(oldLog)

	// Loose posture: 0644, forced with Chmod so a strict umask cannot
	// mask the write mode and make the test vacuously pass.
	loose := filepath.Join(dir, "loose.json")
	if err := os.WriteFile(loose, []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(loose, 0o644); err != nil {
		t.Fatal(err)
	}
	var d Daemon
	if err := d.LoadNotifyStore(loose); err != nil {
		t.Fatalf("LoadNotifyStore: %v", err)
	}
	info, err := os.Stat(loose)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("loose file mode after load = %o, want 0600 (repaired)", perm)
	}
	snap := d.notifyStore.snapshot()
	if len(snap.entries) != 1 || snap.entries[0].Token != "abcdefghijklmnop" {
		t.Errorf("entries after load = %+v, want the 1 loaded entry", snap.entries)
	}
	warned := lb.String()
	for _, marker := range []string{loose, "644", "600"} {
		if !strings.Contains(warned, marker) {
			t.Errorf("repair warning = %q, want it to name the path and modes (missing %q)", warned, marker)
		}
	}

	// Already-tight posture: 0600 loads with NO warning and stays 0600.
	lb.Reset()
	tight := filepath.Join(dir, "tight.json")
	if err := os.WriteFile(tight, []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(tight, 0o600); err != nil {
		t.Fatal(err)
	}
	var d2 Daemon
	if err := d2.LoadNotifyStore(tight); err != nil {
		t.Fatalf("LoadNotifyStore (tight): %v", err)
	}
	if info, err := os.Stat(tight); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("tight file must stay 0600 (info=%v err=%v)", info, err)
	}
	if lb.Len() != 0 {
		t.Errorf("already-0600 file must not warn, got %q", lb.String())
	}
}

// TestNotifyStore_LoadChmodFailureFails pins the loud-failure branch of
// the b-F1 repair: when the mode cannot be tightened, LoadNotifyStore
// returns an error naming the path and the daemon registry stays
// unconfigured — startup fails loudly, never silently serves a
// world-readable token file. (Red form is structural: the notifyChmod
// seam only exists post-fix.)
func TestNotifyStore_LoadChmodFailureFails(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "chmodfails.json")
	if err := os.WriteFile(path, []byte(`{"schema":1,"tokens":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	old := notifyChmod
	notifyChmod = func(string, fs.FileMode) error { return errors.New("simulated EPERM") }
	defer func() { notifyChmod = old }()
	var d Daemon
	err := d.LoadNotifyStore(path)
	if err == nil || !strings.Contains(err.Error(), path) {
		t.Fatalf("chmod failure: want error naming the path, got %v", err)
	}
	if !strings.Contains(err.Error(), "0600") {
		t.Errorf("chmod-failure error should name the 0600 target: %v", err)
	}
	if d.notifyStore.configured() {
		t.Error("failed load must leave the daemon's registry unconfigured")
	}
}

// ---------------------------------------------------------------------------
// Submit / persist / reload
// ---------------------------------------------------------------------------

// TestNotifyStore_IdempotentSubmit pins the uniqueness rule: the same raw
// token submitted twice returns the EXISTING entry (created=false,
// unchanged id/label), never a duplicate.
func TestNotifyStore_IdempotentSubmit(t *testing.T) {
	h, _ := newStoreHolder(t)
	e1, created, err := h.submit("fcm-token-aaaaaaaaaaaaaa", "Operator phone")
	if err != nil || !created {
		t.Fatalf("first submit: created=%v err=%v", created, err)
	}
	if !validNotifyID(e1.ID) {
		t.Fatalf("generated id %q is not 16 lowercase hex chars", e1.ID)
	}
	if e1.Scope.Enabled != true || len(e1.Scope.Conditions) != 0 {
		t.Errorf("default scope = %+v, want enabled + empty (all-nine) conditions", e1.Scope)
	}

	// Re-submit the same token with a DIFFERENT label: same entry returns,
	// label NOT mutated (label changes belong to PATCH).
	e2, created, err := h.submit("fcm-token-aaaaaaaaaaaaaa", "Renamed")
	if err != nil {
		t.Fatalf("re-submit: %v", err)
	}
	if created {
		t.Error("re-submit must not create a duplicate")
	}
	if e2.ID != e1.ID {
		t.Errorf("re-submit returned id %q, want the existing %q", e2.ID, e1.ID)
	}
	if e2.Label == "Renamed" {
		t.Error("re-submit must not mutate the stored label")
	}
	snap := h.snapshot()
	if len(snap.entries) != 1 {
		t.Fatalf("registry holds %d entries after idempotent re-submit, want 1", len(snap.entries))
	}
}

// TestNotifyStore_PersistReload pins the atomic-persist + reload cycle:
// canonical bytes (2-space JSON + trailing newline), 0600 permissions, no
// tmp leftovers, and a reload into a FRESH holder reproducing entries.
func TestNotifyStore_PersistReload(t *testing.T) {
	h, path := newStoreHolder(t)
	if _, _, err := h.submit("fcm-token-bbbbbbbbbbbbbb", "Pixel 8"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.submit("fcm-token-cccccccccccccc", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("persisted file missing: %v", err)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("tmp file left behind after persist (stat err=%v)", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("file permissions = %o, want 0600", perm)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(string(data), "\n") {
		t.Error("canonical persist must end with a newline")
	}
	if !strings.Contains(string(data), "\n  \"schema\": 1,") {
		t.Errorf("canonical persist must be 2-space-indented JSON, got:\n%s", data)
	}

	// Reload into a fresh holder (the startup path).
	f, err := loadNotifyStoreFile(path)
	if err != nil {
		t.Fatalf("reload persisted store: %v", err)
	}
	var h2 notifyStoreHolder
	h2.setLoaded(path, f)
	snap := h2.snapshot()
	if len(snap.entries) != 2 {
		t.Fatalf("reload: %d entries, want 2", len(snap.entries))
	}
	if snap.entries[0].Token != "fcm-token-bbbbbbbbbbbbbb" || snap.entries[0].Label != "Pixel 8" {
		t.Errorf("reload entry 0 = %+v", snap.entries[0])
	}
	// Generation discipline: load bumped it, submit bumped it again per create.
	if g := h2.generation(); g != 1 {
		t.Errorf("fresh holder generation = %d, want 1 (load)", g)
	}
	if g := h.generation(); g != 3 { // load + 2 creates
		t.Errorf("holder generation = %d, want 3 (load + 2 creates)", g)
	}
}

// TestNotifyStore_PersistFailureUntouched pins persist-before-swap: a
// persist failure leaves the running registry unchanged.
func TestNotifyStore_PersistFailureUntouched(t *testing.T) {
	dir := t.TempDir()
	// A DIRECTORY at the target path forces the tmp-write/rename to fail.
	path := filepath.Join(dir, "blocked.json")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	var h notifyStoreHolder
	h.setLoaded(path, &notifyStoreFile{Schema: 1, Tokens: []notifyStoreEntry{}})
	if _, _, err := h.submit("fcm-token-dddddddddddddd", "x"); err == nil {
		t.Fatal("submit must fail when persist fails")
	}
	snap := h.snapshot()
	if len(snap.entries) != 0 {
		t.Errorf("failed persist must leave running state untouched, got %d entries", len(snap.entries))
	}
}

// TestNotifyStore_PersistOverStaleLooseTmp pins the b-F1 exclusive-create
// fix: a pre-existing <store>.tmp crash artifact at a loose mode (0644,
// holding junk) must NOT be truncated-and-reused by the persist — Go
// applies the requested perm only when CREATING, so reuse would publish
// the raw-token registry at the artifact's weak mode. The persist must
// clear the stale tmp, create a fresh 0600 one, and publish at 0600.
//
// Observability note — what this test can and cannot see: the tmp's
// transient mode DURING the persist window is not observable from a unit
// test (sampling the sibling mid-persist races the rename), and O_EXCL
// itself is not directly assertable; the post-persist observables are the
// proxies: final store mode 0600 (the red/green discriminator — the
// pre-fix os.WriteFile path truncates-and-renames at 0644), canonical
// contents (clear-and-recreate must not corrupt data), no leftover tmp,
// and a strict reload of the published file.
func TestNotifyStore_PersistOverStaleLooseTmp(t *testing.T) {
	h, path := newStoreHolder(t)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte("stale crash-artifact junk"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Force the loose mode regardless of the test process's umask, so
	// the posture cannot be vacuously tight.
	if err := os.Chmod(tmp, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.submit("fcm-token-stale-tmp-0001", "Phone"); err != nil {
		t.Fatalf("submit over a stale tmp: %v", err)
	}
	// (a) The stale artifact was replaced, not reused: the published
	// store holds the canonical registry (no junk).
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read persisted store: %v", err)
	}
	if strings.Contains(string(data), "stale crash-artifact junk") {
		t.Errorf("published store still holds the stale tmp contents:\n%s", data)
	}
	// (b) The store file exists and no tmp sibling survives the persist.
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Errorf("stale tmp must not survive the persist (stat err=%v)", err)
	}
	// (c) The published registry is mode 0600 — the observable at the
	// heart of b-F1 (pre-fix: the rename publishes the artifact's 0644).
	// Assert BEFORE any loadNotifyStoreFile call below: the load-time
	// mode repair (a prior fix round) would tighten a just-published 0644
	// and mask the defect this test exists to catch.
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("published store mode = %o, want 0600 (stale tmp must not leak its mode)", perm)
	}
	// The strict reload comes last (its repair side effect is intentionally
	// not what proves the fix): the canonical form must round-trip.
	if _, err := loadNotifyStoreFile(path); err != nil {
		t.Errorf("published store must strictly reload: %v", err)
	}
	// The submit itself landed.
	if got := len(h.snapshot().entries); got != 1 {
		t.Errorf("entries after submit = %d, want 1", got)
	}
}

// TestNotifyStore_PersistDoubleCollisionFails pins the never-fallback
// branch of the b-F1 fix: when the exclusive tmp create collides with a
// stale artifact, the persist clears it and retries the create exactly
// ONCE; a SECOND collision fails the persist naming the path — it never
// degrades to a non-exclusive write. Arranged deterministically through
// the notifyCreateExcl seam (a genuine second EEXIST landing between our
// own remove and create cannot be arranged portably in a unit test); red
// form is structural, like TestNotifyStore_LoadChmodFailureFails — the
// seam only exists post-fix.
func TestNotifyStore_PersistDoubleCollisionFails(t *testing.T) {
	h, path := newStoreHolder(t)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	calls := 0
	old := notifyCreateExcl
	notifyCreateExcl = func(name string) (*os.File, error) {
		calls++
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrExist}
	}
	defer func() { notifyCreateExcl = old }()
	_, _, err := h.submit("fcm-token-collide-000001", "x")
	if err == nil {
		t.Fatal("submit must fail when the exclusive tmp create collides twice")
	}
	if calls != 2 {
		t.Errorf("exclusive-create attempts = %d, want exactly 2 (initial + ONE retry, no loop)", calls)
	}
	if !strings.Contains(err.Error(), tmp) {
		t.Errorf("failure must name the colliding path %s, got: %v", tmp, err)
	}
	// The store file is untouched (persist-before-swap: the rename never
	// ran, so nothing was published).
	if _, serr := os.Stat(path); !os.IsNotExist(serr) {
		t.Errorf("store file must not exist after a failed persist (stat err=%v)", serr)
	}
	// The cleared stale tmp is not left behind either.
	if _, serr := os.Stat(tmp); !os.IsNotExist(serr) {
		t.Errorf("tmp must not survive the failed persist (stat err=%v)", serr)
	}
	// Running state is untouched (submit rolled its append back).
	if got := len(h.snapshot().entries); got != 0 {
		t.Errorf("entries after failed submit = %d, want 0", got)
	}
}

// ---------------------------------------------------------------------------
// PATCH / DELETE / recordSendResult
// ---------------------------------------------------------------------------

// TestNotifyStore_PatchDeleteSemantics pins holder patch/delete: unknown
// id, wholesale scope replacement, label clear, validation of the MERGED
// entry, and generation bumps.
func TestNotifyStore_PatchDeleteSemantics(t *testing.T) {
	h, _ := newStoreHolder(t)
	e, _, err := h.submit("fcm-token-eeeeeeeeeeeeee", "Old")
	if err != nil {
		t.Fatal(err)
	}
	genBefore := h.generation()

	if _, ok, err := h.patch("8899aabbccddeeff", notifyPatch{}); ok || err != nil {
		t.Errorf("patch unknown id: ok=%v err=%v, want ok=false err=nil", ok, err)
	}

	newLabel := "New"
	enabled := false
	conds := []string{"session_unread"}
	patched, ok, err := h.patch(e.ID, notifyPatch{Label: &newLabel, Scope: &notifyScope{Enabled: enabled, Conditions: conds}})
	if !ok || err != nil {
		t.Fatalf("patch: ok=%v err=%v", ok, err)
	}
	if patched.Label != "New" || patched.Scope.Enabled || !reflect.DeepEqual(patched.Scope.Conditions, []string{"session_unread"}) {
		t.Errorf("patched entry = %+v", patched)
	}
	if h.generation() != genBefore+1 {
		t.Errorf("patch must bump generation: %d → %d", genBefore, h.generation())
	}

	// Merged-entry validation: an over-long label on PATCH fails without
	// mutating state.
	long := strings.Repeat("y", 65)
	if _, ok, err := h.patch(e.ID, notifyPatch{Label: &long}); err == nil || !ok {
		t.Errorf("patch over-long label: want validation error, got ok=%v err=%v", ok, err)
	}
	cur, _ := h.byID(e.ID)
	if cur.Label != "New" {
		t.Errorf("failed patch must not mutate: label = %q", cur.Label)
	}

	// Telemetry does NOT bump the generation.
	genBefore = h.generation()
	h.recordSendResult(e.ID, nil)
	h.recordSendResult(e.ID, errErrForTest())
	if h.generation() != genBefore {
		t.Error("recordSendResult must not bump the generation")
	}
	cur, _ = h.byID(e.ID)
	if cur.LastUsedAt == nil {
		t.Error("recordSendResult must set last_used_at")
	}
	if !strings.Contains(cur.LastError, "boom") {
		t.Errorf("last_error = %q, want the send error text", cur.LastError)
	}
	// Success clears the error and the persist still round-trips.
	h.recordSendResult(e.ID, nil)
	cur, _ = h.byID(e.ID)
	if cur.LastError != "" {
		t.Errorf("successful send must clear last_error, got %q", cur.LastError)
	}

	// recordSendResult on an unknown/deleted id is a no-op.
	h.recordSendResult("8899aabbccddeeff", errErrForTest())

	// Delete: unknown then known.
	if ok, err := h.delete("8899aabbccddeeff"); ok || err != nil {
		t.Errorf("delete unknown: ok=%v err=%v", ok, err)
	}
	if ok, err := h.delete(e.ID); !ok || err != nil {
		t.Fatalf("delete: ok=%v err=%v", ok, err)
	}
	if _, ok := h.byID(e.ID); ok {
		t.Error("deleted entry must be gone")
	}
	if len(h.snapshot().entries) != 0 {
		t.Error("registry must be empty after delete")
	}
}

// errErrForTest is a stable fake send error.
func errErrForTest() error { return &NotifyRetryError{Status: 503, Detail: "boom"} }

// TestNotifyStore_RecordSendResultPersistFailure pins the best-effort
// rule: a persist failure must not panic and the in-memory entry is still
// updated (the next successful persist carries it).
func TestNotifyStore_RecordSendResultPersistFailure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "blocked2.json")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	var h notifyStoreHolder
	// setLoaded installs entries in memory only (no persist), so the
	// blocked path never trips here — recordSendResult's persist will
	// fail against it, which is exactly the condition under test.
	h.setLoaded(path, &notifyStoreFile{Schema: 1, Tokens: []notifyStoreEntry{{
		ID: "0011223344556677", Token: "fcm-token-ffffffffffff", CreatedAt: time.Now().UTC(),
		Scope: notifyScope{Enabled: true, Conditions: []string{}},
	}}})
	h.recordSendResult("0011223344556677", errErrForTest())
	cur, ok := h.byID("0011223344556677")
	if !ok || cur.LastUsedAt == nil || !strings.Contains(cur.LastError, "boom") {
		t.Errorf("best-effort update lost on persist failure: %+v ok=%v", cur, ok)
	}
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

// TestMaskNotifyToken pins the preview rule: first 6 + last 4 for long
// tokens; full asterisks when too short to preview safely.
func TestMaskNotifyToken(t *testing.T) {
	if got, want := maskNotifyToken("ABCDEFGHIJKLMNOP"), "ABCDEF"+string('…')+"MNOP"; got != want {
		t.Errorf("mask = %q, want %q", got, want)
	}
	for _, tok := range []string{"", "abc", "abcdefghij"} {
		if got := maskNotifyToken(tok); got != strings.Repeat("*", len(tok)) {
			t.Errorf("short token %q masked to %q, want asterisks", tok, got)
		}
	}
}

// TestNotifyStore_CanonicalFileRoundTrip proves the file this build
// WRITES always reloads through the strict reader (no omitempty drift).
func TestNotifyStore_CanonicalFileRoundTrip(t *testing.T) {
	h, path := newStoreHolder(t)
	e, _, err := h.submit("fcm-token-roundtripaaa", "lbl")
	if err != nil {
		t.Fatal(err)
	}
	h.recordSendResult(e.ID, errErrForTest())
	f, err := loadNotifyStoreFile(path)
	if err != nil {
		t.Fatalf("strict reader rejected our own canonical file: %v", err)
	}
	var raw map[string]any
	data, _ := os.ReadFile(path)
	_ = json.Unmarshal(data, &raw)
	if _, ok := raw["tokens"]; !ok {
		t.Error("canonical file must carry the tokens array")
	}
	if len(f.Tokens) != 1 || f.Tokens[0].LastError == "" {
		t.Errorf("round-trip lost state: %+v", f.Tokens)
	}
}

// ---------------------------------------------------------------------------
// Async send-result recorder (S2)
// ---------------------------------------------------------------------------

// waitForNotify polls cond every 5ms until it holds or the deadline
// passes; returns whether cond ever held. Shared by the S2 notify tests
// for ASYNC effects (the telemetry drain, the watcher's background
// dispatch) that must not be asserted synchronously.
func waitForNotify(deadline time.Duration, cond func() bool) bool {
	deadlineTimer := time.NewTimer(deadline)
	defer deadlineTimer.Stop()
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		if cond() {
			return true
		}
		select {
		case <-deadlineTimer.C:
			return cond()
		case <-tick.C:
		}
	}
}

// TestNotifyStore_RecordSendResultAsyncOffCriticalPath pins the S2
// requirement that the telemetry write runs OFF the send critical path:
// with the persist seam BLOCKED (notifyCreateExcl parked on a channel),
// recordSendResultAsync must return immediately and the store FILE must
// not yet carry the outcome; once the seam unblocks, the drain goroutine
// must land last_used_at/last_error in memory AND in the file without
// any further prodding. (The "not landed yet" check reads the FILE, not
// the holder: recordSendResult holds the holder mutex across the parked
// persist, so a memory check would block on that mutex.)
func TestNotifyStore_RecordSendResultAsyncOffCriticalPath(t *testing.T) {
	h, path := newStoreHolder(t)
	e, _, err := h.submit("fcm-token-asyncrecorder", "lbl")
	if err != nil {
		t.Fatal(err)
	}

	blocked := make(chan struct{})
	orig := notifyCreateExcl
	notifyCreateExcl = func(name string) (*os.File, error) {
		<-blocked
		return orig(name)
	}
	var unblockOnce sync.Once
	unblock := func() { unblockOnce.Do(func() { close(blocked) }) }
	// Restore the seam AND release the drain even on a fatal partway
	// through (a permanently parked global seam would hang every later
	// persist in the package).
	t.Cleanup(func() { notifyCreateExcl = orig; unblock() })

	done := make(chan struct{})
	go func() {
		defer close(done)
		h.recordSendResultAsync(e.ID, errErrForTest())
	}()
	select {
	case <-done:
		// Returned without the write landing — exactly the contract.
	case <-time.After(2 * time.Second):
		t.Fatal("recordSendResultAsync blocked while the persist seam was wedged — it must return off the critical path")
	}
	// The write has not landed while the seam is still blocked (check
	// the FILE — see the comment above for why not the holder).
	if data, err := os.ReadFile(path); err == nil && strings.Contains(string(data), "boom") {
		t.Fatal("telemetry write landed while the persist seam was still blocked — the drain is not actually asynchronous")
	}

	unblock()
	if !waitForNotify(2*time.Second, func() bool {
		f, err := loadNotifyStoreFile(path)
		return err == nil && len(f.Tokens) == 1 && f.Tokens[0].LastUsedAt != nil && strings.Contains(f.Tokens[0].LastError, "boom")
	}) {
		t.Fatal("drain never landed the telemetry in memory+file after unblock")
	}
}

// TestNotifyStore_RetireIsDelete pins that the S2 sender's retirement
// path is exactly the holder's delete: the unregistered-class outcome
// removes the entry, persists, and bumps the generation (a STRUCTURAL
// change), while an unknown id (already deleted mid-send) is a no-op.
func TestNotifyStore_RetireIsDelete(t *testing.T) {
	h, path := newStoreHolder(t)
	e, _, err := h.submit("fcm-token-retire-me-now", "lbl")
	if err != nil {
		t.Fatal(err)
	}
	genBefore := h.generation()

	ok, err := h.delete(e.ID)
	if err != nil || !ok {
		t.Fatalf("retire (delete): ok=%v err=%v", ok, err)
	}
	if h.generation() != genBefore+1 {
		t.Errorf("retirement must bump the structural generation: %d → %d", genBefore, h.generation())
	}
	if _, still := h.byID(e.ID); still {
		t.Error("retired token must be gone from the registry")
	}
	f, err := loadNotifyStoreFile(path)
	if err != nil || len(f.Tokens) != 0 {
		t.Fatalf("retirement must persist: err=%v tokens=%d", err, len(f.Tokens))
	}
	// Double retire (already deleted mid-send): no-op, no error.
	if ok, err := h.delete(e.ID); ok || err != nil {
		t.Errorf("retire of unknown id: want ok=false nil, got %v %v", ok, err)
	}
}
