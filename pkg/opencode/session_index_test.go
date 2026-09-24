package opencode

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

// session_index_test.go — the self-converging session-list index
// (session_index.go). Every test runs against a throwaway DB file; nothing here
// can reach a real OpenCode DB (EnsureSessionListIndex is only exercised on the
// external/override path with an explicit temp file).

// indexSchema mimics the parts of OpenCode's `session` table the list query and
// the index touch, plus OpenCode's own session_project_idx.
const indexSchema = `
CREATE TABLE session (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	parent_id TEXT,
	directory TEXT NOT NULL,
	time_created INTEGER NOT NULL,
	time_updated INTEGER NOT NULL,
	time_archived INTEGER
);
CREATE INDEX session_project_idx ON session (project_id);
CREATE INDEX session_parent_idx ON session (parent_id);
`

// listQuery is the shape OpenCode actually runs for a worktree-root instance
// (path "" skips the directory filter); listQueryDir is the directory-filtered
// variant. The index must serve both without a temp B-tree.
const listQuery = `SELECT * FROM session WHERE project_id = 'p' ORDER BY time_updated DESC LIMIT 32000`
const listQueryDir = `SELECT * FROM session WHERE project_id = 'p' AND directory = '/d' ORDER BY time_updated DESC LIMIT 32000`

func newIndexDB(t *testing.T, extra string) (path string, db *sql.DB) {
	t.Helper()
	path = filepath.Join(t.TempDir(), "opencode.db")
	db = openTempDB(t, path, indexSchema+extra)
	t.Cleanup(func() { db.Close() })
	return path, db
}

func converge(t *testing.T, path string) IndexAction {
	t.Helper()
	act, err := ensureSessionListIndexAt(context.Background(), path)
	if err != nil {
		t.Fatalf("converge: %v", err)
	}
	return act
}

func indexNames(t *testing.T, db *sql.DB) map[string]bool {
	t.Helper()
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		out[n] = true
	}
	return out
}

func queryPlan(t *testing.T, db *sql.DB, q string) string {
	t.Helper()
	rows, err := db.Query("EXPLAIN QUERY PLAN " + q)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var id, parent, notused int
		var detail string
		if err := rows.Scan(&id, &parent, &notused, &detail); err != nil {
			t.Fatal(err)
		}
		b.WriteString(detail + "\n")
	}
	return b.String()
}

func ownedCols(t *testing.T, db *sql.DB) []string {
	t.Helper()
	cols, _, err := indexKeyColumns(context.Background(), db, sessionListIndexName)
	if err != nil {
		t.Fatal(err)
	}
	return cols
}

// No upstream equivalent → ours is created, and it removes the temp B-tree
// from OpenCode's list query (the whole point).
func TestSessionIndex_CreatesWhenAbsentAndFixesPlan(t *testing.T) {
	path, db := newIndexDB(t, "")
	if plan := queryPlan(t, db, listQuery); !strings.Contains(plan, "TEMP B-TREE") {
		t.Fatalf("precondition: list query should need a temp B-tree without the index, plan:\n%s", plan)
	}
	if act := converge(t, path); act != IndexCreated {
		t.Fatalf("action = %s, want %s", act, IndexCreated)
	}
	if !indexNames(t, db)[sessionListIndexName] {
		t.Fatalf("owned index not created")
	}
	for _, q := range []string{listQuery, listQueryDir} {
		plan := queryPlan(t, db, q)
		if strings.Contains(plan, "TEMP B-TREE") || !strings.Contains(plan, sessionListIndexName) {
			t.Errorf("list query should use %s with no temp B-tree\nquery: %s\nplan:\n%s", sessionListIndexName, q, plan)
		}
	}
}

// Re-running is a no-op.
func TestSessionIndex_IdempotentKeep(t *testing.T) {
	path, _ := newIndexDB(t, "")
	converge(t, path)
	if act := converge(t, path); act != IndexKept {
		t.Fatalf("second run action = %s, want %s", act, IndexKept)
	}
}

// Upstream ships an equivalent index while ours exists → ours is dropped and
// upstream's is left alone.
func TestSessionIndex_DropsOursWhenUpstreamAppears(t *testing.T) {
	path, db := newIndexDB(t, "")
	converge(t, path)
	if _, err := db.Exec(`CREATE INDEX session_project_updated_idx ON session (project_id, time_updated, id)`); err != nil {
		t.Fatal(err)
	}
	if act := converge(t, path); act != IndexDroppedOurs {
		t.Fatalf("action = %s, want %s", act, IndexDroppedOurs)
	}
	names := indexNames(t, db)
	if names[sessionListIndexName] {
		t.Errorf("owned index should have been dropped")
	}
	if !names["session_project_updated_idx"] {
		t.Errorf("upstream index must never be touched")
	}
	// And it stays converged: no re-creation while upstream covers it.
	if act := converge(t, path); act != IndexUpstreamPresent {
		t.Errorf("follow-up action = %s, want %s", act, IndexUpstreamPresent)
	}
}

// Upstream equivalent already present, ours never created → nothing to do.
// DESC key direction still counts as equivalent.
func TestSessionIndex_UpstreamPresentNoCreate(t *testing.T) {
	path, db := newIndexDB(t, `CREATE INDEX up_idx ON session (project_id, time_updated DESC);`)
	if act := converge(t, path); act != IndexUpstreamPresent {
		t.Fatalf("action = %s, want %s", act, IndexUpstreamPresent)
	}
	if indexNames(t, db)[sessionListIndexName] {
		t.Errorf("must not create ours when upstream already covers the query")
	}
}

// Indexes that do NOT serve the list query never count as upstream
// equivalents: ours is still created, and theirs are left untouched.
func TestSessionIndex_NonEquivalentUpstreamStillCreatesOurs(t *testing.T) {
	cases := map[string]string{
		// A column between project_id and time_updated breaks the ORDER BY for
		// the project-only query OpenCode actually runs.
		"directory-in-middle": `CREATE INDEX x_idx ON session (project_id, directory, time_updated);`,
		"wrong-order":         `CREATE INDEX x_idx ON session (time_updated, project_id);`,
		"partial":             `CREATE INDEX x_idx ON session (project_id, time_updated) WHERE time_archived IS NULL;`,
		"expression":          `CREATE INDEX x_idx ON session (project_id, (time_updated + 0));`,
		"too-short":           `CREATE INDEX x_idx ON session (project_id);`,
	}
	for name, ddl := range cases {
		t.Run(name, func(t *testing.T) {
			path, db := newIndexDB(t, ddl)
			if act := converge(t, path); act != IndexCreated {
				t.Fatalf("action = %s, want %s", act, IndexCreated)
			}
			names := indexNames(t, db)
			if !names[sessionListIndexName] || !names["x_idx"] {
				t.Errorf("want both owned and upstream index present, got %v", names)
			}
		})
	}
}

// Our name exists but with the wrong shape (drift) → dropped and recreated
// with the right columns.
func TestSessionIndex_RecreatesDriftedOwned(t *testing.T) {
	path, db := newIndexDB(t, `CREATE INDEX `+sessionListIndexName+` ON session (project_id);`)
	if act := converge(t, path); act != IndexRecreated {
		t.Fatalf("action = %s, want %s", act, IndexRecreated)
	}
	if got := strings.Join(ownedCols(t, db), ","); got != strings.Join(sessionListIndexCols, ",") {
		t.Errorf("owned index cols = %s, want %v", got, sessionListIndexCols)
	}
}

// Converging never drops or alters an index it does not own.
func TestSessionIndex_NeverTouchesForeignIndexes(t *testing.T) {
	path, db := newIndexDB(t, `CREATE INDEX x_idx ON session (project_id, directory, time_updated);`)
	before := indexNames(t, db)
	converge(t, path)
	converge(t, path)
	after := indexNames(t, db)
	for n := range before {
		if !after[n] {
			t.Errorf("foreign index %s was removed", n)
		}
	}
}

// A schema that lost a needed column refuses loudly and creates nothing.
func TestSessionIndex_MissingColumnRefuses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "opencode.db")
	db := openTempDB(t, path, `CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, time_archived INTEGER);`) // no time_updated
	defer db.Close()
	_, err := ensureSessionListIndexAt(context.Background(), path)
	var se *SchemaError
	if !errors.As(err, &se) {
		t.Fatalf("want *SchemaError, got %v", err)
	}
	if indexNames(t, db)[sessionListIndexName] {
		t.Errorf("no index may be created against a drifted schema")
	}
}

func TestSessionIndex_MissingFileFails(t *testing.T) {
	if _, err := ensureSessionListIndexAt(context.Background(), filepath.Join(t.TempDir(), "nope.db")); err == nil {
		t.Fatal("want an error for a missing DB file")
	}
}

// External topology without an explicit DB path is skipped before any DB is
// resolved or opened; with VH_OPENCODE_DB_PATH it converges that file.
func TestSessionIndex_ExternalTopologyGuard(t *testing.T) {
	t.Setenv(opencodeDBOverrideEnv, "")
	act, err := EnsureSessionListIndex(context.Background(), true)
	if err != nil || act != IndexSkippedExternal {
		t.Fatalf("external without override: act=%s err=%v, want %s", act, err, IndexSkippedExternal)
	}

	path, db := newIndexDB(t, "")
	t.Setenv(opencodeDBOverrideEnv, path)
	act, err = EnsureSessionListIndex(context.Background(), true)
	if err != nil || act != IndexCreated {
		t.Fatalf("external with override: act=%s err=%v, want %s", act, err, IndexCreated)
	}
	if !indexNames(t, db)[sessionListIndexName] {
		t.Errorf("override path should have been converged")
	}
}

// An earlier name of OUR index (retiredSessionIndexNames) is dropped and the
// current one created — the upgrade path for DBs converged by the first version.
func TestSessionIndex_MigratesRetiredOwnedIndex(t *testing.T) {
	path, db := newIndexDB(t, `CREATE INDEX vhsolara_session_project_dir_updated_idx ON session (project_id, directory, time_updated);`)
	if act := converge(t, path); act != IndexCreated {
		t.Fatalf("action = %s, want %s", act, IndexCreated)
	}
	names := indexNames(t, db)
	if names["vhsolara_session_project_dir_updated_idx"] {
		t.Errorf("retired owned index should have been dropped")
	}
	if !names[sessionListIndexName] {
		t.Errorf("current owned index should have been created")
	}
	// Stays converged.
	if act := converge(t, path); act != IndexKept {
		t.Errorf("follow-up action = %s, want %s", act, IndexKept)
	}
}
