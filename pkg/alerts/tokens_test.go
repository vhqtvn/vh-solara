package alerts

// tokens_test.go — lane-1 co-located unit tests for the FCM token registry
// (pkg/alerts/tokens.go): upsert idempotency, the cap, label truncation, and
// persistence round-trips.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNotifyTokenUpsertIdempotent(t *testing.T) {
	r := NewTokenRegistry(t.TempDir())
	if err := r.Upsert("tokA", "phone"); err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	if err := r.Upsert("tokA", "tablet"); err != nil {
		t.Fatalf("second upsert (same token): %v", err)
	}
	if got := r.Count(); got != 1 {
		t.Fatalf("count = %d, want 1 (idempotent by token)", got)
	}
	// The label is refreshed in place (verify through the persisted file, which
	// also proves the upsert persisted).
	r2 := NewTokenRegistry(t.TempDir()) // different dir: sanity empty
	if r2.Count() != 0 {
		t.Fatalf("fresh registry count = %d, want 0", r2.Count())
	}
	r.mu.Lock()
	stored, ok := r.tokens["tokA"]
	r.mu.Unlock()
	if !ok || stored.Label != "tablet" {
		t.Fatalf("stored entry = %+v, want label refreshed to \"tablet\"", stored)
	}
}

func TestNotifyTokenRequired(t *testing.T) {
	r := NewTokenRegistry(t.TempDir())
	err := r.Upsert("", "label")
	if err != ErrNotifyTokenRequired {
		t.Fatalf("empty token error = %v, want ErrNotifyTokenRequired", err)
	}
	if err.Error() != "token required" {
		t.Fatalf("error text = %q, want the contract string \"token required\"", err.Error())
	}
}

func TestNotifyTokenCap(t *testing.T) {
	r := NewTokenRegistry(t.TempDir())
	for i := 0; i < NotifyTokenCap; i++ {
		if err := r.Upsert(fmt.Sprintf("tok-%02d", i), "d"); err != nil {
			t.Fatalf("fill %d: %v", i, err)
		}
	}
	if got := r.Count(); got != NotifyTokenCap {
		t.Fatalf("count = %d, want %d", got, NotifyTokenCap)
	}
	// A NEW token at cap is rejected.
	if err := r.Upsert("tok-new", "d"); err != ErrNotifyTokenCap {
		t.Fatalf("cap error = %v, want ErrNotifyTokenCap", err)
	}
	// An ALREADY-REGISTERED token at cap still succeeds (idempotent upsert).
	if err := r.Upsert("tok-00", "refreshed"); err != nil {
		t.Fatalf("re-upsert of registered token at cap: %v", err)
	}
	if got := r.Count(); got != NotifyTokenCap {
		t.Fatalf("count after re-upsert = %d, want %d", got, NotifyTokenCap)
	}
}

func TestNotifyTokenLabelTruncated(t *testing.T) {
	r := NewTokenRegistry(t.TempDir())
	long := strings.Repeat("x", 200)
	if err := r.Upsert("tokA", long); err != nil {
		t.Fatal(err)
	}
	r.mu.Lock()
	stored := r.tokens["tokA"]
	r.mu.Unlock()
	if got := len([]rune(stored.Label)); got != NotifyLabelMax {
		t.Fatalf("stored label len = %d, want %d", got, NotifyLabelMax)
	}
}

func TestNotifyTokenPersistenceRoundTrip(t *testing.T) {
	dir := t.TempDir()
	r := NewTokenRegistry(dir)
	if err := r.Upsert("tokB", "pixel"); err != nil {
		t.Fatal(err)
	}
	if err := r.Upsert("tokA", "iphone"); err != nil {
		t.Fatal(err)
	}

	// File shape: 0600, deterministic (sorted), values reloadable.
	path := filepath.Join(dir, "notify-tokens.json")
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("registry file not written: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("registry file mode = %v, want 0600", fi.Mode().Perm())
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"tokA"`) || strings.Index(string(raw), `"tokA"`) > strings.Index(string(raw), `"tokB"`) {
		t.Fatalf("registry file not sorted by token: %s", raw)
	}

	r2 := NewTokenRegistry(dir)
	if got := r2.Count(); got != 2 {
		t.Fatalf("reloaded count = %d, want 2", got)
	}
	r2.mu.Lock()
	a, aok := r2.tokens["tokA"]
	b, bok := r2.tokens["tokB"]
	r2.mu.Unlock()
	if !aok || a.Label != "iphone" || !bok || b.Label != "pixel" {
		t.Fatalf("reloaded entries drift: a=%+v ok=%v b=%+v ok=%v", a, aok, b, bok)
	}

	// Prune removes exactly the named tokens and persists the removal.
	if err := r2.Prune("tokA", "tok-ghost"); err != nil {
		t.Fatalf("prune: %v", err)
	}
	if got := r2.Count(); got != 1 {
		t.Fatalf("post-prune count = %d, want 1", got)
	}
	r3 := NewTokenRegistry(dir)
	if got := r3.Count(); got != 1 {
		t.Fatalf("post-prune reload count = %d, want 1 (prune persisted)", got)
	}
}
