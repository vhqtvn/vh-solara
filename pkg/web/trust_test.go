package web

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTrustStore_StatesAndGrant(t *testing.T) {
	ts := NewTrustStoreAt(t.TempDir())

	dir := t.TempDir() // a real path so Abs/EvalSymlinks are stable
	h1 := "aaaa1111bbbb2222"
	h2 := "cccc3333dddd4444"

	if got := ts.State(dir, h1); got != TrustUntrusted {
		t.Fatalf("fresh dir: state=%s, want untrusted", got)
	}
	if ts.IsTrusted(dir, h1) {
		t.Fatal("fresh dir should not be trusted")
	}

	if err := ts.Grant(dir, h1); err != nil {
		t.Fatal(err)
	}
	if got := ts.State(dir, h1); got != TrustTrusted {
		t.Fatalf("after grant: state=%s, want trusted", got)
	}
	if !ts.IsTrusted(dir, h1) {
		t.Fatal("should be trusted for matching hash")
	}

	// Hash change (config edited) → re-gate.
	if got := ts.State(dir, h2); got != TrustChanged {
		t.Fatalf("after hash change: state=%s, want changed", got)
	}
	if ts.IsTrusted(dir, h2) {
		t.Fatal("should NOT be trusted for a different hash")
	}

	// Re-grant with the new hash → trusted again.
	if err := ts.Grant(dir, h2); err != nil {
		t.Fatal(err)
	}
	if got := ts.State(dir, h2); got != TrustTrusted {
		t.Fatalf("re-grant: state=%s, want trusted", got)
	}
}

func TestTrustStore_Revoke(t *testing.T) {
	ts := NewTrustStoreAt(t.TempDir())
	dir := t.TempDir()
	if err := ts.Grant(dir, "h"); err != nil {
		t.Fatal(err)
	}
	if err := ts.Revoke(dir); err != nil {
		t.Fatal(err)
	}
	if got := ts.State(dir, "h"); got != TrustUntrusted {
		t.Fatalf("after revoke: state=%s, want untrusted", got)
	}
	// Revoke again is a no-op (no error).
	if err := ts.Revoke(dir); err != nil {
		t.Fatalf("re-revoke should be noop, got %v", err)
	}
}

func TestTrustStore_SymlinkAliasSharesRecord(t *testing.T) {
	// Two paths (one a symlink) to the same on-disk dir must share one trust
	// record, so a symlink alias can't bypass the gate.
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(real, link); err != nil {
		t.Skip("symlink unsupported:", err)
	}
	ts := NewTrustStoreAt(t.TempDir())
	if err := ts.Grant(real, "h"); err != nil {
		t.Fatal(err)
	}
	if !ts.IsTrusted(link, "h") {
		t.Fatal("symlink alias should resolve to the same trusted record")
	}
}
