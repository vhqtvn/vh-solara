package opencode

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"database/sql"
)

// openTempDB opens a brand-new SQLite DB file at path (creating it) and runs the
// statements in schema against it. The caller closes the returned handle.
func openTempDB(t *testing.T, path, schema string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	if schema != "" {
		if _, err := db.Exec(schema); err != nil {
			db.Close()
			t.Fatalf("apply schema: %v", err)
		}
	}
	return db
}

// mimickedSchema is a minimal v1.17.18 `session` table that contains the
// columns the unarchive code path reads/writes (id PK, time_archived, and
// time_updated so the test can assert it is NOT bumped). Other columns the real
// table has (project_id, title, ...) are intentionally omitted — they are not
// part of the coupling surface the self-check guards.
const mimickedSchema = `
CREATE TABLE session (
	id TEXT PRIMARY KEY,
	time_created INTEGER NOT NULL,
	time_updated INTEGER NOT NULL,
	time_archived INTEGER
);`

// TestUnarchivePositive verifies the happy path against a mimicked-schema DB:
// archive a row (non-null time_archived), run the unarchive, then assert
// time_archived is NULL, exactly one row was affected, and time_updated was NOT
// bumped (the UPDATE must keep the session's list position).
func TestUnarchivePositive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "opencode.db")
	db := openTempDB(t, path, mimickedSchema)
	const id = "ses_abc"
	const created, updated = 1700000000000, 1700000000001
	if _, err := db.Exec(
		`INSERT INTO session (id, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?)`,
		id, created, updated, 1700000000002); err != nil {
		t.Fatalf("seed row: %v", err)
	}
	db.Close()

	if err := unarchiveAt(context.Background(), path, []string{id}); err != nil {
		t.Fatalf("unarchiveAt returned error: %v", err)
	}

	// Re-open read-only-ish and verify final row state.
	chk := openTempDB(t, path, "")
	defer chk.Close()
	var archived sql.NullInt64
	var gotUpdated int64
	if err := chk.QueryRow(
		`SELECT time_archived, time_updated FROM session WHERE id = ?`, id).
		Scan(&archived, &gotUpdated); err != nil {
		t.Fatalf("verify select: %v", err)
	}
	if archived.Valid {
		t.Fatalf("time_archived = %d after unarchive; want NULL", archived.Int64)
	}
	if gotUpdated != updated {
		t.Fatalf("time_updated = %d after unarchive; want %d (the UPDATE must NOT bump time_updated)",
			gotUpdated, updated)
	}
}

// TestUnarchiveAlreadyNullIsStillOneRow confirms the plain `WHERE id = ?` UPDATE
// is naturally idempotent: an already-NULL time_archived still matches the row,
// so rowsAffected stays 1 (a re-issue does not look like "session unknown").
func TestUnarchiveAlreadyNullIsStillOneRow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "opencode.db")
	db := openTempDB(t, path, mimickedSchema)
	const id = "ses_idem"
	if _, err := db.Exec(
		`INSERT INTO session (id, time_created, time_updated, time_archived) VALUES (?, ?, ?, NULL)`,
		id, 1, 2); err != nil {
		t.Fatalf("seed row: %v", err)
	}
	db.Close()

	if err := unarchiveAt(context.Background(), path, []string{id}); err != nil {
		t.Fatalf("idempotent unarchive should succeed, got: %v", err)
	}
}

// TestUnarchiveUnknownIDFailsLoudly: a real session id that is not in this DB
// file must report rowsAffected != 1 and surface a clear error (the operator
// would otherwise believe a different DB file was the right one).
func TestUnarchiveUnknownIDFailsLoudly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "opencode.db")
	db := openTempDB(t, path, mimickedSchema)
	db.Close()

	err := unarchiveAt(context.Background(), path, []string{"ses_does_not_exist"})
	if err == nil {
		t.Fatal("expected an error for an unknown session id, got nil")
	}
	if !strings.Contains(err.Error(), "expected exactly 1 row affected") {
		t.Fatalf("expected a rowsAffected error, got: %v", err)
	}
}

// TestUnarchiveBatchesMultipleIDs: a single open + self-check covers a batch,
// and each id is updated independently.
func TestUnarchiveBatchesMultipleIDs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "opencode.db")
	db := openTempDB(t, path, mimickedSchema)
	ids := []string{"ses_one", "ses_two", "ses_three"}
	for _, id := range ids {
		if _, err := db.Exec(
			`INSERT INTO session (id, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?)`,
			id, 1, 2, 1700000000003); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
	}
	db.Close()

	if err := unarchiveAt(context.Background(), path, ids); err != nil {
		t.Fatalf("batch unarchive: %v", err)
	}

	chk := openTempDB(t, path, "")
	defer chk.Close()
	rows, err := chk.Query(`SELECT id, time_archived FROM session`)
	if err != nil {
		t.Fatalf("verify query: %v", err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var id string
		var a sql.NullInt64
		if err := rows.Scan(&id, &a); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if a.Valid {
			t.Fatalf("id %s still archived after batch unarchive", id)
		}
		count++
	}
	if count != len(ids) {
		t.Fatalf("verified %d rows, expected %d", count, len(ids))
	}
}

// TestUnarchiveMissingFileFails: a resolved-but-absent DB file is a loud
// SchemaError (never an empty-DB write that litters a stray file).
func TestUnarchiveMissingFileFails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "does-not-exist.db")
	err := unarchiveAt(context.Background(), path, []string{"ses_x"})
	if err == nil {
		t.Fatal("expected an error for a missing DB file, got nil")
	}
	se, ok := err.(*SchemaError)
	if !ok {
		t.Fatalf("expected *SchemaError for missing file, got %T: %v", err, err)
	}
	if !strings.Contains(se.Error(), "DB file not reachable") {
		t.Fatalf("unexpected SchemaError message: %v", err)
	}
}

// --- Drift detector: the self-check MUST fail loudly on each kind of drift. ---

// runUnarchiveExpectingSchemaError builds a mimicked DB, seeds a real archived
// row, THEN applies the drift mutation, and asserts unarchiveAt refuses with a
// *SchemaError. The seed runs first so the mutation is free to rename/drop the
// time_archived column or the whole session table; the self-check must then
// short-circuit BEFORE the UPDATE (the row exists, proving the guard fires
// rather than a wrong write). Returns the error for message assertions.
func runUnarchiveExpectingSchemaError(t *testing.T, mutateSchema func(db *sql.DB) error, wantSubstr string) *SchemaError {
	t.Helper()
	path := filepath.Join(t.TempDir(), "opencode.db")
	db := openTempDB(t, path, mimickedSchema)
	// Seed the row against the ORIGINAL schema first.
	if _, err := db.Exec(
		`INSERT INTO session (id, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?)`,
		"ses_drift", 1, 2, 3); err != nil {
		db.Close()
		t.Fatalf("seed row: %v", err)
	}
	// Now apply the drift (may rename/drop columns or the table).
	if mutateSchema != nil {
		if err := mutateSchema(db); err != nil {
			db.Close()
			t.Fatalf("apply drift: %v", err)
		}
	}
	db.Close()

	err := unarchiveAt(context.Background(), path, []string{"ses_drift"})
	if err == nil {
		t.Fatal("expected a *SchemaError (drift), got nil — the guard failed to fire")
	}
	se, ok := err.(*SchemaError)
	if !ok {
		t.Fatalf("expected *SchemaError, got %T: %v", err, err)
	}
	if !strings.Contains(se.Error(), wantSubstr) {
		t.Fatalf("SchemaError message mismatch:\n want substring: %q\n got: %v", wantSubstr, se)
	}
	// Every SchemaError must point the operator at the coupling doc + version.
	if !strings.Contains(se.Error(), opencodeCouplingDoc) {
		t.Fatalf("SchemaError must reference the coupling doc %q, got: %v", opencodeCouplingDoc, se)
	}
	if !strings.Contains(se.Error(), opencodeValidatedTag) {
		t.Fatalf("SchemaError must name the validated version %q, got: %v", opencodeValidatedTag, se)
	}
	return se
}

func TestDriftColumnRenamed(t *testing.T) {
	runUnarchiveExpectingSchemaError(t, func(db *sql.DB) error {
		_, err := db.Exec(`ALTER TABLE session RENAME COLUMN time_archived TO archived_at`)
		return err
	}, "not found on table")
}

func TestDriftColumnWrongType(t *testing.T) {
	runUnarchiveExpectingSchemaError(t, func(db *sql.DB) error {
		if _, err := db.Exec(`ALTER TABLE session RENAME COLUMN time_archived TO _old`); err != nil {
			return err
		}
		_, err := db.Exec(`ALTER TABLE session ADD COLUMN time_archived TEXT`)
		return err
	}, "has type")
}

func TestDriftColumnNotNull(t *testing.T) {
	runUnarchiveExpectingSchemaError(t, func(db *sql.DB) error {
		// Rebuild the column as NOT NULL (SQLite cannot ALTER a column in place;
		// the standard rebuild-via-temp-table gives us the NOT NULL variant).
		_, err := db.Exec(`
			CREATE TABLE session_nn (id TEXT PRIMARY KEY, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER NOT NULL);
			INSERT INTO session_nn (id, time_created, time_updated, time_archived) SELECT id, time_created, time_updated, COALESCE(time_archived, 0) FROM session;
			DROP TABLE session;
			ALTER TABLE session_nn RENAME TO session;`)
		return err
	}, "NOT NULL")
}

func TestDriftTableMissing(t *testing.T) {
	runUnarchiveExpectingSchemaError(t, func(db *sql.DB) error {
		_, err := db.Exec(`DROP TABLE session`)
		return err
	}, "not found on table")
}

// TestResolveDBPathOverride covers the operator escape hatch precedence and the
// :memory: refusal. The CLI/Go-fallback branches are exercised implicitly by
// the build/runtime; asserting their exact filesystem result here would be
// environment-dependent.
func TestResolveDBPathOverride(t *testing.T) {
	t.Setenv(opencodeDBOverrideEnv, "/tmp/some/explicit/opencode.db")
	got, err := ResolveDBPath(context.Background())
	if err != nil {
		t.Fatalf("override resolve: %v", err)
	}
	if got != "/tmp/some/explicit/opencode.db" {
		t.Fatalf("override not honored: got %q", got)
	}
}

func TestResolveDBPathMemoryRefused(t *testing.T) {
	t.Setenv(opencodeDBOverrideEnv, ":memory:")
	if _, err := ResolveDBPath(context.Background()); err == nil {
		t.Fatal("expected an error for :memory: override, got nil")
	}
}

// TestUnarchiveGuard covers the topology contract for direct-DB unarchive:
// external + unset → refuses (naming the env hatch + the coupling doc);
// VH_OPENCODE_DB_PATH set → allowed even when external;
// co-located → allowed regardless of the override.
func TestUnarchiveGuard(t *testing.T) {
	// Start from a clean slate (no inherited override).
	t.Setenv(opencodeDBOverrideEnv, "")

	// Co-located (spawned) topology: always allowed, no override needed.
	if err := UnarchiveGuard(false); err != nil {
		t.Fatalf("co-located, no override: unexpected refusal: %v", err)
	}

	// External + unset → must refuse with an actionable message.
	err := UnarchiveGuard(true)
	if err == nil {
		t.Fatal("external + unset: expected refusal, got nil")
	}
	if !strings.Contains(err.Error(), opencodeDBOverrideEnv) {
		t.Errorf("external refusal does not name %s: %v", opencodeDBOverrideEnv, err)
	}
	if !strings.Contains(err.Error(), opencodeCouplingDoc) {
		t.Errorf("external refusal does not reference the coupling doc %s: %v", opencodeCouplingDoc, err)
	}

	// External + VH_OPENCODE_DB_PATH explicitly set → allowed.
	t.Setenv(opencodeDBOverrideEnv, "/tmp/explicit/opencode.db")
	if err := UnarchiveGuard(true); err != nil {
		t.Fatalf("external + override set: unexpected refusal: %v", err)
	}

	// Co-located + override set → still allowed.
	if err := UnarchiveGuard(false); err != nil {
		t.Fatalf("co-located + override set: unexpected refusal: %v", err)
	}
}

func TestSanitizeChannel(t *testing.T) {
	cases := map[string]string{
		"local":         "local",
		"feature/x@y z": "feature-x-y-z",
		"":              "local",
		"stable-1.2":    "stable-1.2",
	}
	for in, want := range cases {
		if got := sanitizeChannel(in); got != want {
			t.Errorf("sanitizeChannel(%q) = %q, want %q", in, got, want)
		}
	}
}
