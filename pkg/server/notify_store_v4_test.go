package server

// notify_store_v4_test.go — lane-1 tests for the S4 token-registry upgrade
// (notify controller-hub S4 / v4 §3.2, brief §5): the schema-1 → schema-2
// migration matrix (legacy tokens with scopes/disabled/unsupported
// conditions; backup-first + atomic replace; re-migration idempotence;
// corrupt/future-schema fail-closed) and the registry cap.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/alerts"
)

// legacySchema1Doc is a representative pre-S4 controller registry: three
// tokens with scopes (all-nine, disabled+unsupported-condition, §9.1-
// intersecting subset) and full metadata.
const legacySchema1Doc = `{
  "schema": 1,
  "tokens": [
    {
      "id": "0011223344556677",
      "token": "legacy-token-aaaaaaaa",
      "label": "Operator phone",
      "created_at": "2026-09-28T01:02:03Z",
      "last_used_at": "2026-10-01T04:05:06Z",
      "last_error": "404 NOT_FOUND",
      "scope": {"enabled": true, "conditions": []}
    },
    {
      "id": "8899aabbccddeeff",
      "token": "legacy-token-bbbbbbbb",
      "created_at": "2026-09-29T00:00:00Z",
      "scope": {"enabled": false, "conditions": ["worker_missing"]}
    },
    {
      "id": "5566778899aabbcc",
      "token": "legacy-token-cccccccc",
      "label": "Tablet",
      "created_at": "2026-09-30T00:00:00Z",
      "scope": {"enabled": true, "conditions": ["worker_down", "session_unread"]}
    }
  ]
}`

// TestNotifyStoreV4_MigrationFromSchema1 pins the full v4 §3.2 migration:
// conservative policy default (when_unattended for every legacy token),
// verbatim preservation of ids/values/labels/creation/use/error metadata
// and scopes (disabled stays disabled, unsupported legacy conditions stay
// restricted), the schema-2 file REPLACING the original atomically, and
// the ORIGINAL bytes backed up beside it.
func TestNotifyStoreV4_MigrationFromSchema1(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "notify-store.json")
	if err := os.WriteFile(path, []byte(legacySchema1Doc), 0o600); err != nil {
		t.Fatal(err)
	}

	var d Daemon
	if err := d.LoadNotifyStore(path); err != nil {
		t.Fatalf("LoadNotifyStore with a schema-1 store: %v", err)
	}
	snap := d.notifyStore.snapshot()
	if len(snap.entries) != 3 {
		t.Fatalf("migration must preserve all 3 tokens, got %d", len(snap.entries))
	}
	byID := map[string]notifyStoreEntry{}
	for _, e := range snap.entries {
		byID[e.ID] = e
	}

	// Token A: full metadata preserved, policy defaulted, scope verbatim.
	a := byID["0011223344556677"]
	if a.Token != "legacy-token-aaaaaaaa" || a.Label != "Operator phone" {
		t.Errorf("token A identity preserved: %+v", a)
	}
	if a.PushPolicy != alerts.PolicyWhenUnattended {
		t.Errorf("token A policy = %q, want the conservative when_unattended default", a.PushPolicy)
	}
	if a.CreatedAt.IsZero() || a.LastUsedAt == nil || a.LastUsedAt.IsZero() || a.LastError != "404 NOT_FOUND" {
		t.Errorf("token A metadata preserved: created=%v last_used=%v last_error=%q", a.CreatedAt, a.LastUsedAt, a.LastError)
	}
	if !a.Scope.Enabled || len(a.Scope.Conditions) != 0 {
		t.Errorf("token A scope = %+v, want enabled + empty (all nine)", a.Scope)
	}

	// Token B: administrative disable + unsupported legacy restriction stay
	// DORMANT and visible — never broadened. (The restriction stays in the
	// stored scope; the DISABLED flag separately suppresses everything.)
	b := byID["8899aabbccddeeff"]
	if b.Scope.Enabled || len(b.Scope.Conditions) != 1 || b.Scope.Conditions[0] != "worker_missing" {
		t.Fatalf("token B scope = %+v, want disabled + the unsupported worker_missing restriction preserved", b.Scope)
	}
	// Dormant, not broadened: no §9.1 condition may reach this token —
	// the unsupported restriction matches nothing centrally.
	for _, kind := range []string{"permission_pending", "question_pending", "session_unread", "worker_down", "session_started"} {
		if notifyScopeMatches(b.Scope, kind) {
			t.Errorf("unsupported legacy restriction broadened: %q must not match", kind)
		}
	}

	// Token C: §9.1-intersecting subset preserved.
	c := byID["5566778899aabbcc"]
	if !c.Scope.Enabled || len(c.Scope.Conditions) != 2 || c.Scope.Conditions[0] != "worker_down" || c.Scope.Conditions[1] != "session_unread" {
		t.Errorf("token C scope = %+v, want the preserved subset", c.Scope)
	}

	// The replaced file is schema 2 with explicit policies.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Schema int `json:"schema"`
		Tokens []struct {
			PushPolicy string `json:"push_policy"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("replaced file is JSON: %v", err)
	}
	if doc.Schema != 2 || len(doc.Tokens) != 3 {
		t.Fatalf("replaced file = schema %d tokens %d, want schema 2 / 3", doc.Schema, len(doc.Tokens))
	}
	for i, tok := range doc.Tokens {
		if tok.PushPolicy != alerts.PolicyWhenUnattended {
			t.Errorf("replaced file token %d policy = %q, want explicit when_unattended", i, tok.PushPolicy)
		}
	}

	// The backup carries the ORIGINAL schema-1 bytes verbatim.
	backup, err := os.ReadFile(path + notifyStoreBackupSuffix)
	if err != nil {
		t.Fatalf("the migration must write the schema-1 backup: %v", err)
	}
	if string(backup) != legacySchema1Doc {
		t.Fatalf("backup must carry the ORIGINAL bytes verbatim:\n%s", backup)
	}
}

// TestNotifyStoreV4_MigrationIdempotent pins the re-migration posture: a
// schema-2 file loads as an ordinary schema-2 load — no re-migration, no
// backup churn (the backup still holds the original schema-1 bytes).
func TestNotifyStoreV4_MigrationIdempotent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "notify-store.json")
	if err := os.WriteFile(path, []byte(legacySchema1Doc), 0o600); err != nil {
		t.Fatal(err)
	}
	var d Daemon
	if err := d.LoadNotifyStore(path); err != nil {
		t.Fatalf("first load (migrating): %v", err)
	}

	// Re-load: a plain schema-2 load. The file on disk must stay schema 2
	// and the backup must be untouched by further loads.
	var d2 Daemon
	if err := d2.LoadNotifyStore(path); err != nil {
		t.Fatalf("re-load (idempotent): %v", err)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), `"schema": 2`) {
		t.Fatalf("re-load must keep the schema-2 file:\n%s", raw)
	}
	backup, err := os.ReadFile(path + notifyStoreBackupSuffix)
	if err != nil || string(backup) != legacySchema1Doc {
		t.Fatalf("backup must remain the original schema-1 document after re-loads")
	}
}

// TestNotifyStoreV4_MigrationFailsClosed pins the fail-closed posture: a
// migration whose BACKUP write fails leaves the original schema-1 file
// UNTOUCHED and startup failed (never a half-migrated registry).
func TestNotifyStoreV4_MigrationFailsClosed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "notify-store.json")
	if err := os.WriteFile(path, []byte(legacySchema1Doc), 0o600); err != nil {
		t.Fatal(err)
	}
	// A DIRECTORY at the backup path forces the atomic backup write to fail.
	if err := os.Mkdir(path+notifyStoreBackupSuffix, 0o700); err != nil {
		t.Fatal(err)
	}
	var d Daemon
	err := d.LoadNotifyStore(path)
	if err == nil || !strings.Contains(err.Error(), "migration") {
		t.Fatalf("backup failure must fail the load with a migration error, got %v", err)
	}
	// The original file is untouched (still schema 1, still the same bytes).
	raw, _ := os.ReadFile(path)
	if string(raw) != legacySchema1Doc {
		t.Fatalf("a failed migration must leave the original schema-1 file untouched")
	}
	if d.notifyStore.configured() {
		t.Error("failed load must leave the daemon's registry unconfigured")
	}
}

// TestNotifyStoreV4_CorruptAndFutureSchemaFailClosed pins the set-but-bad
// discipline at the file level: garbage refuses startup; a schema from a
// FUTURE build refuses startup (and a legacy binary equally refuses the
// migrated schema-2 file — rollback must never silently reopen it).
func TestNotifyStoreV4_CorruptAndFutureSchemaFailClosed(t *testing.T) {
	dir := t.TempDir()

	corrupt := filepath.Join(dir, "corrupt.json")
	if err := os.WriteFile(corrupt, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	var d1 Daemon
	if err := d1.LoadNotifyStore(corrupt); err == nil || !strings.Contains(err.Error(), "corrupt.json") {
		t.Fatalf("corrupt store: want error naming the path, got %v", err)
	}

	future := filepath.Join(dir, "future.json")
	if err := os.WriteFile(future, []byte(`{"schema":3,"tokens":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var d2 Daemon
	if err := d2.LoadNotifyStore(future); err == nil || !strings.Contains(err.Error(), "schema version 3 not supported") {
		t.Fatalf("future schema: want refusal, got %v", err)
	}

	// The rollback direction: a PRE-S4 binary refuses the schema-2 file
	// (pinned through the decoder directly — the old error text).
	f, migrated, err := decodeNotifyStore([]byte(`{"schema":2,"tokens":[]}`))
	if err != nil || migrated || f == nil || f.Schema != 2 {
		t.Fatalf("schema-2 decode: f=%+v migrated=%v err=%v", f, migrated, err)
	}
}

// TestNotifyStoreV4_Cap pins the v4 §3.1 32-token cap at the holder level:
// a NEW token beyond the cap fails with the shared sentinel; an
// already-registered token always succeeds (idempotent by token).
func TestNotifyStoreV4_Cap(t *testing.T) {
	h, _ := newStoreHolder(t)
	firstTok := "fcm-token-cap-000000001"
	for i := 0; i < notifyTokenCap; i++ {
		tok := firstTok + string(rune('a'+i%26)) + string(rune('a'+i/26)) + strconv.Itoa(i)
		if _, created, err := h.submit(tok, "", ""); err != nil || !created {
			t.Fatalf("submit %d: created=%v err=%v", i, created, err)
		}
	}
	if _, _, err := h.submit("fcm-token-over-the-cap-1", "", ""); err != alerts.ErrNotifyTokenCap {
		t.Fatalf("33rd distinct token: err=%v, want ErrNotifyTokenCap", err)
	}
	// An already-registered token re-POSTs fine at the cap (idempotent by
	// token — the registration-refresh flow must keep working).
	if _, _, err := h.submit(firstTok+"aa0", "", alerts.PolicyAlways); err != nil {
		t.Fatalf("existing re-POST at cap must succeed (idempotent): %v", err)
	}
	snap := h.snapshot()
	if len(snap.entries) != notifyTokenCap {
		t.Fatalf("registry holds %d entries, want the cap %d", len(snap.entries), notifyTokenCap)
	}
}

// TestNotifyStoreV4_PolicyCounts pins the probe's policies computation.
func TestNotifyStoreV4_PolicyCounts(t *testing.T) {
	h, _ := newStoreHolder(t)
	if _, _, err := h.submit("fcm-token-counts-0001", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.submit("fcm-token-counts-0002", "", alerts.PolicyAlways); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.submit("fcm-token-counts-0003", "", alerts.PolicyAlways); err != nil {
		t.Fatal(err)
	}
	// A full-state re-POST without the policy resets token 1's policy —
	// counts must reflect the reset.
	if _, _, err := h.submit("fcm-token-counts-0003", "", ""); err != nil {
		t.Fatal(err)
	}
	snapCounts := h.snapshot()
	got := policyCounts(&snapCounts)
	if got[alerts.PolicyWhenUnattended] != 2 || got[alerts.PolicyAlways] != 1 {
		t.Fatalf("policy counts = %v, want 2 when_unattended / 1 always", got)
	}
	if _, _, err := h.submit("fcm-token-counts-0001", "", "sometimes"); err != alerts.ErrNotifyTokenPolicy {
		t.Fatalf("invalid policy at the holder: err=%v, want ErrNotifyTokenPolicy", err)
	}
}
