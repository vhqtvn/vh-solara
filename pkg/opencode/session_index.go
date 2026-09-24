package opencode

// Self-converging session-list index on OpenCode's SQLite DB.
//
// WHY THIS EXISTS
//
// OpenCode's instance-scoped session list (`GET /session`, the `Session.list`
// query) is
//
//	SELECT * FROM session WHERE project_id = ? AND directory = ?
//	ORDER BY time_updated DESC LIMIT ?
//
// and OpenCode ships no index on time_updated (none in any migration through
// v1.18.31). SQLite therefore builds a temp B-tree for the ORDER BY; past
// cache_size (2 MB) it spills to /var/tmp/etilqs_* temp files. At OpenCode's
// default LIMIT 100 that is harmless, but vh-solara's aggregator fetches whole
// session lists (10k–16k rows on large projects), and each such call wrote
// ~17 MB of sort scratch and burned OpenCode's single JS thread. An index on
// session(project_id, directory, time_updated) lets SQLite read rows already in
// order and stop at LIMIT (verified with EXPLAIN QUERY PLAN: the temp B-tree
// disappears).
//
// CONVERGE, NOT JUST CREATE
//
// EnsureSessionListIndex is idempotent and self-retiring:
//
//   - Our index carries a vh-solara-namespaced name (sessionListIndexName), so we
//     never create or drop an index we do not own, and a future upstream
//     migration that uses a plain CREATE INDEX with its own name can never
//     collide with ours and fail OpenCode's startup.
//   - "Upstream equivalent" is decided structurally (PRAGMA index_list +
//     index_xinfo), not by name: any NON-partial index on `session`, other than
//     ours, whose leading KEY columns are exactly (project_id, directory,
//     time_updated), in that order. Extra trailing key columns are fine;
//     ASC/DESC is irrelevant (SQLite scans an index both ways); an expression
//     column never counts.
//   - Rules, re-evaluated on every run:
//     upstream equivalent + ours      → DROP ours (upstream took over)
//     upstream equivalent, no ours    → nothing to do
//     no upstream, no ours            → CREATE ours
//     no upstream, ours as expected   → nothing to do
//     no upstream, ours drifted       → DROP + CREATE ours
//
// The caller (pkg/web) runs it after every (re)attach to a serving — hence
// already-migrated — OpenCode process, so an OpenCode upgrade that adds an
// equivalent index, or rebuilds the table (silently dropping ours), converges
// on the next attach. Failure is never fatal: the caller logs and carries on.
//
// See docs/architecture/opencode-sqlite-unarchive.md ("Session-list index")
// for the coupling contract and the retirement condition.

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	// sessionListIndexName is the index vh-solara owns. The vhsolara_ prefix is
	// the ownership marker: nothing else in this package ever touches an index
	// whose name does not match it exactly.
	sessionListIndexName = "vhsolara_session_project_dir_updated_idx"
	// sessionIndexTimeout bounds one converge run (open + introspect + DDL).
	// CREATE INDEX over ~40k session rows takes well under a second; the rest
	// is headroom for busy_timeout waits while OpenCode holds the write lock.
	sessionIndexTimeout = 30 * time.Second
)

// sessionListIndexCols are the leading key columns the OpenCode list query
// needs, in order.
var sessionListIndexCols = []string{"project_id", "directory", "time_updated"}

// IndexAction is the outcome of one EnsureSessionListIndex run.
type IndexAction string

const (
	IndexCreated         IndexAction = "created"          // no upstream equivalent; ours created
	IndexRecreated       IndexAction = "recreated"        // ours had drifted; dropped + recreated
	IndexKept            IndexAction = "kept"             // ours already present and correct
	IndexDroppedOurs     IndexAction = "dropped-ours"     // upstream equivalent appeared; ours removed
	IndexUpstreamPresent IndexAction = "upstream-present" // upstream equivalent exists; ours absent
	IndexSkippedExternal IndexAction = "skipped-external" // OpenCode attached externally, no explicit DB path
)

// sessionIndexMu serializes converge runs within the process so concurrent
// (re)attach callbacks never race each other's DDL.
var sessionIndexMu sync.Mutex

// EnsureSessionListIndex converges OpenCode's DB to have exactly one index that
// serves the session-list query (see the file doc). external mirrors the
// UnarchiveGuard topology rule: when OpenCode is attached externally
// (--opencode-url) the locally resolved DB may not be the remote instance's, so
// the run is skipped unless VH_OPENCODE_DB_PATH names the file explicitly.
func EnsureSessionListIndex(ctx context.Context, external bool) (IndexAction, error) {
	if external && strings.TrimSpace(os.Getenv(opencodeDBOverrideEnv)) == "" {
		return IndexSkippedExternal, nil
	}
	path, err := ResolveDBPath(ctx)
	if err != nil {
		return "", err
	}
	return ensureSessionListIndexAt(ctx, path)
}

// indexShape is the introspected shape of one index on `session`.
type indexShape struct {
	name       string
	partial    bool
	keyCols    []string // KEY columns in order; "" marks an expression column
	expression bool     // any key column is an expression
}

// ensureSessionListIndexAt is the testable core: it converges the DB at an
// explicit path. It does NOT resolve the path or apply the topology guard.
func ensureSessionListIndexAt(ctx context.Context, path string) (IndexAction, error) {
	sessionIndexMu.Lock()
	defer sessionIndexMu.Unlock()

	if fi, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("opencode DB not reachable at %s: %w", path, err)
	} else if fi.IsDir() {
		return "", fmt.Errorf("opencode DB path %s is a directory", path)
	}

	db, err := openDB(path)
	if err != nil {
		return "", fmt.Errorf("open opencode DB %s: %w", path, err)
	}
	defer db.Close()

	cctx, cancel := context.WithTimeout(ctx, sessionIndexTimeout)
	defer cancel()

	if err := assertSessionIndexColumns(cctx, db, path); err != nil {
		return "", err
	}
	shapes, err := sessionIndexShapes(cctx, db)
	if err != nil {
		return "", fmt.Errorf("introspect session indexes in %s: %w", path, err)
	}

	var ours *indexShape
	upstream := ""
	for i := range shapes {
		sh := &shapes[i]
		if sh.name == sessionListIndexName {
			ours = sh
			continue
		}
		if isEquivalentSessionListIndex(*sh) {
			upstream = sh.name
		}
	}

	switch {
	case upstream != "" && ours != nil:
		if _, err := db.ExecContext(cctx, `DROP INDEX IF EXISTS "`+sessionListIndexName+`"`); err != nil {
			return "", fmt.Errorf("drop %s (upstream %s now covers it): %w", sessionListIndexName, upstream, err)
		}
		return IndexDroppedOurs, nil
	case upstream != "":
		return IndexUpstreamPresent, nil
	case ours == nil:
		if err := createSessionListIndex(cctx, db); err != nil {
			return "", err
		}
		return IndexCreated, nil
	case isExactOwnedShape(*ours):
		return IndexKept, nil
	default:
		if _, err := db.ExecContext(cctx, `DROP INDEX IF EXISTS "`+sessionListIndexName+`"`); err != nil {
			return "", fmt.Errorf("drop drifted %s: %w", sessionListIndexName, err)
		}
		if err := createSessionListIndex(cctx, db); err != nil {
			return "", err
		}
		return IndexRecreated, nil
	}
}

func createSessionListIndex(ctx context.Context, db *sql.DB) error {
	stmt := `CREATE INDEX IF NOT EXISTS "` + sessionListIndexName + `" ON ` + opencodeSessionTable +
		` (` + strings.Join(sessionListIndexCols, ", ") + `)`
	if _, err := db.ExecContext(ctx, stmt); err != nil {
		return fmt.Errorf("create %s: %w", sessionListIndexName, err)
	}
	return nil
}

// isEquivalentSessionListIndex reports whether sh (an index NOT owned by us)
// serves the list query: non-partial, no expression among the leading columns,
// and leading key columns exactly sessionListIndexCols.
func isEquivalentSessionListIndex(sh indexShape) bool {
	if sh.partial || len(sh.keyCols) < len(sessionListIndexCols) {
		return false
	}
	for i, want := range sessionListIndexCols {
		if sh.keyCols[i] != want { // "" (expression) never matches
			return false
		}
	}
	return true
}

// isExactOwnedShape reports whether our index still has exactly the shape we
// create (anything else is drift and gets rebuilt).
func isExactOwnedShape(sh indexShape) bool {
	if sh.partial || sh.expression || len(sh.keyCols) != len(sessionListIndexCols) {
		return false
	}
	for i, want := range sessionListIndexCols {
		if sh.keyCols[i] != want {
			return false
		}
	}
	return true
}

// assertSessionIndexColumns refuses to act unless `session` still has every
// column the index needs (a renamed/removed column means OpenCode's schema moved
// and this coupling must be re-validated, not guessed at).
func assertSessionIndexColumns(ctx context.Context, db *sql.DB, path string) error {
	rows, err := db.QueryContext(ctx, "PRAGMA table_info("+opencodeSessionTable+")")
	if err != nil {
		return &SchemaError{Path: path, Cause: fmt.Sprintf("PRAGMA table_info(%s) failed: %v", opencodeSessionTable, err)}
	}
	defer rows.Close()
	have := map[string]bool{}
	for rows.Next() {
		var cid, notnull, pk int
		var name, ctype string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return &SchemaError{Path: path, Cause: fmt.Sprintf("scanning table_info row failed: %v", err)}
		}
		have[name] = true
	}
	if err := rows.Err(); err != nil {
		return &SchemaError{Path: path, Cause: fmt.Sprintf("iterating table_info rows failed: %v", err)}
	}
	for _, c := range sessionListIndexCols {
		if !have[c] {
			return &SchemaError{Path: path, Cause: fmt.Sprintf("column %q not found on table %q; session-list index not applied", c, opencodeSessionTable)}
		}
	}
	return nil
}

// sessionIndexShapes introspects every index on `session`.
func sessionIndexShapes(ctx context.Context, db *sql.DB) ([]indexShape, error) {
	rows, err := db.QueryContext(ctx, "PRAGMA index_list("+opencodeSessionTable+")")
	if err != nil {
		return nil, err
	}
	var shapes []indexShape
	for rows.Next() {
		// index_list columns: seq, name, unique, origin, partial.
		var seq, unique, partial int
		var name, origin string
		if err := rows.Scan(&seq, &name, &unique, &origin, &partial); err != nil {
			rows.Close()
			return nil, err
		}
		shapes = append(shapes, indexShape{name: name, partial: partial != 0})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	for i := range shapes {
		cols, expr, err := indexKeyColumns(ctx, db, shapes[i].name)
		if err != nil {
			return nil, err
		}
		shapes[i].keyCols = cols
		shapes[i].expression = expr
	}
	return shapes, nil
}

// indexKeyColumns returns an index's KEY columns in order ("" for an expression
// column) and whether any key column is an expression.
func indexKeyColumns(ctx context.Context, db *sql.DB, index string) ([]string, bool, error) {
	rows, err := db.QueryContext(ctx, `PRAGMA index_xinfo("`+strings.ReplaceAll(index, `"`, `""`)+`")`)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	var cols []string
	expr := false
	for rows.Next() {
		// index_xinfo columns: seqno, cid, name, desc, coll, key.
		var seqno, cid, desc, key int
		var name, coll sql.NullString
		if err := rows.Scan(&seqno, &cid, &name, &desc, &coll, &key); err != nil {
			return nil, false, err
		}
		if key == 0 {
			continue // auxiliary rowid column, not part of the key
		}
		if cid == -2 || !name.Valid {
			expr = true
			cols = append(cols, "")
			continue
		}
		cols = append(cols, name.String)
	}
	return cols, expr, rows.Err()
}
