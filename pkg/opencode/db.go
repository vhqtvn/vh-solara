package opencode

// Direct-SQLite unarchive for OpenCode sessions.
//
// WHY THIS EXISTS
//
// OpenCode 1.17.x has NO HTTP mechanism to clear a session's archived state:
// PATCH /session/:id {"time":{"archived":null}} returns 400 (the request schema
// is Schema.optional(Schema.Finite), which rejects JSON null), and there is no
// dedicated unarchive endpoint. The only semantically-correct clear is
// time_archived = NULL, matching OpenCode's own "active = time_archived IS NULL"
// model. So vh-solara writes that value directly to OpenCode's single global
// SQLite DB.
//
// ARCHIVING (setting a timestamp) is unchanged: it uses the working HTTP PATCH
// path (pkg/opencode/client.go SetArchived with a non-nil timestamp). Only the
// CLEAR goes through here.
//
// See docs/architecture/opencode-sqlite-unarchive.md for the full coupling
// contract: concurrency model, cache/clobber caveats, drift handling, the macOS
// data-dir note, non-goals, and the upstream issues to track so this path can be
// retired when OpenCode ships a real HTTP unarchive.
//
// Every schema/path claim below is validated against:
//
//	validatedAgainst = "opencode v1.17.18"
//
// (sst/opencode tag v1.17.18). Source citations live in
// researches/sources/opencode-sqlite-unarchive-spec.md.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver; registers driver name "sqlite". No cgo -> preserves the single-binary cross-compile release model.
)

// Coupling doc + validated version, referenced from every loud-failure error so
// an operator landing on a refusal knows exactly where the contract lives and
// which upstream version it was checked against.
const (
	opencodeCouplingDoc    = "docs/architecture/opencode-sqlite-unarchive.md"
	opencodeValidatedTag   = "opencode v1.17.18"
	opencodeDBOverrideEnv  = "VH_OPENCODE_DB_PATH" // operator escape hatch: explicit absolute DB file path
	opencodeChannelEnv     = "VH_OPENCODE_CHANNEL" // optional: names the OpenCode installation channel when it is NOT a published one (latest/beta/prod)
	opencodeDBPathCliTO    = 3 * time.Second       // `opencode db path` shell-out budget
	opencodeShelloutOpenTO = 5 * time.Second       // open + self-check + UPDATE budget (single point write)
)

// Captured v1.17.18 session-table contract the unarchive UPDATE depends on.
// Source: packages/core/src/session/sql.ts @ v1.17.18 (SessionTable).
// The runtime self-check (assertSessionSchema) compares the live DB against
// these; any mismatch refuses the write loudly.
const (
	opencodeSessionTable   = "session"       // literal table name
	opencodeArchivedColumn = "time_archived" // drizzle integer() -> SQLite affinity INTEGER, nullable, unindexed
	opencodeArchivedType   = "INTEGER"       // PRAGMA table_info 'type' must contain this
)

// published channels resolve to the plain "opencode.db" filename; any other
// channel name uses "opencode-<sanitized>.db" (OpenCode dev builds default to
// channel "local" -> "opencode-local.db"). vh-solara cannot read the build-time
// OPENCODE_CHANNEL define, so it defaults to the published-channel file and lets
// an operator name a dev channel via opencodeChannelEnv.
var opencodePublishedChannels = map[string]bool{"latest": true, "beta": true, "prod": true}

// SchemaError is returned when the live OpenCode DB no longer matches the
// captured v1.17.18 contract (renamed column/table, retyped column, added NOT
// NULL, etc.) or the DB file is missing/unreadable. It is intentionally LOUD:
// its message names the coupling doc and the validated version so silent
// corruption can never happen — a schema drift turns into a visible, localized
// refusal rather than a wrong write.
type SchemaError struct {
	Path  string // DB file path that was being used
	Cause string // human-readable mismatch
}

func (e *SchemaError) Error() string {
	return fmt.Sprintf("opencode DB schema mismatch (validatedAgainst=%s) at %s: %s\n"+
		" refusing the unarchive write to avoid corrupting state. "+
		"OpenCode may have changed its DB schema; re-validate against the new version and update %s.",
		opencodeValidatedTag, e.Path, e.Cause, opencodeCouplingDoc)
}

// UnarchiveGuard enforces the topology contract for direct-DB unarchive BEFORE
// any DB file is opened. ResolveDBPath is a PROCESS-LOCAL resolver (env override
// → `opencode db path` → Go fallback). In the SPAWNED/co-located topology the
// spawned `opencode serve` inherits the same env (`cmd.Env = os.Environ()`) and
// runs on the same host, so the resolved file IS the running instance's file and
// the write lands correctly.
//
// In the EXTERNAL topology (--opencode-url) the session ids come from a REMOTE
// OpenCode instance (ListArchivedSessions is HTTP, external-aware), but the DB
// resolver still resolves a LOCAL file that may NOT be the one the remote
// instance uses. Writing there would target the wrong DB or, in the common case
// where no local DB exists, fail loudly at os.Stat. The guard turns this into a
// FAST, actionable refusal: the operator must set VH_OPENCODE_DB_PATH explicitly
// (taking responsibility for the file), or use the spawned topology.
//
// Semantics:
//   - VH_OPENCODE_DB_PATH explicitly set → allow (operator owns the file choice).
//   - co-located (external == false)     → allow (env inherited, same file).
//   - external + unset                   → refuse.
//
// The guard MUST run before ResolveDBPath / any DB open so a refusal never
// touches the DB handle.
func UnarchiveGuard(external bool) error {
	if v := strings.TrimSpace(os.Getenv(opencodeDBOverrideEnv)); v != "" {
		return nil // explicit override → operator owns the file choice
	}
	if external {
		return fmt.Errorf("unarchive via direct DB requires %s to be explicitly bound when OpenCode is attached externally (--opencode-url); the local DB may not be the one the remote instance uses. See %s",
			opencodeDBOverrideEnv, opencodeCouplingDoc)
	}
	return nil
}

// UnarchiveSessions clears time_archived (sets it to NULL) for each given
// session id by writing directly to OpenCode's global SQLite DB. It is the only
// supported way to unarchive against OpenCode 1.17.x.
//
// It opens a short-lived WAL connection to the resolved DB, runs the always-on
// schema self-check ONCE, then issues
//
//	UPDATE session SET time_archived = NULL WHERE id = ?
//
// per id, asserting exactly one row is affected per id (the id is the table's
// primary key, so at most one row can match). time_updated is intentionally NOT
// bumped (a raw UPDATE bypasses Drizzle's $onUpdate hook, and re-ordering the
// session in time_updated-ordered lists would be an unrelated semantic change).
//
// The direct write emits NO OpenCode session.updated event; callers that hold a
// cached view should re-hydrate after this returns (the running OpenCode process
// re-reads session rows fresh from the DB on every /session call, so the clear
// is visible there without any push). See the coupling doc's cache/clobber
// sections.
func UnarchiveSessions(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	path, err := ResolveDBPath(ctx)
	if err != nil {
		return err
	}
	return unarchiveAt(ctx, path, ids)
}

// ResolveDBPath returns OpenCode's single global SQLite DB file path. Resolution
// order (first wins):
//
//  1. VH_OPENCODE_DB_PATH env — operator explicit absolute path (escape hatch).
//  2. `opencode db path` shell-out — identical-by-construction to what the
//     running OpenCode process uses (drift-free). vh-solara inherits the same
//     env as the `opencode serve` process it spawns (cmd sets cmd.Env =
//     os.Environ()), so the CLI resolves the same file.
//  3. Go re-implementation of Database.path() per the spec's pseudo-formula
//     (XDG_DATA_HOME || ~/.local/share)/opencode/<file>, honoring OPENCODE_DB
//     and the channel filename branches.
//
// On any failure it returns a loud error referencing the coupling doc; vh-solara
// never guesses the DB path (a wrong file is a silent wrong-file write).
func ResolveDBPath(ctx context.Context) (string, error) {
	// 1. Operator override wins over everything.
	if v := strings.TrimSpace(os.Getenv(opencodeDBOverrideEnv)); v != "" {
		if v == ":memory:" {
			return "", fmt.Errorf("%s=:memory: is not a writable file; unarchive needs a real DB path. See %s",
				opencodeDBOverrideEnv, opencodeCouplingDoc)
		}
		return v, nil
	}
	// 2. Prefer the OpenCode CLI (drift-free).
	if p, ok := dbPathViaCLI(ctx); ok {
		return p, nil
	}
	// 3. Go fallback.
	p, err := fallbackDBPath()
	if err != nil {
		return "", fmt.Errorf("cannot resolve opencode DB path: %w (set %s to the absolute DB path, or see %s)",
			err, opencodeDBOverrideEnv, opencodeCouplingDoc)
	}
	return p, nil
}

// dbPathViaCLI runs `opencode db path` and returns the trimmed stdout. Returns
// (path, false) if the opencode binary is not on PATH or the command fails for
// any reason — the caller then falls back to the Go resolver. A :memory: result
// is treated as unusable.
func dbPathViaCLI(ctx context.Context) (string, bool) {
	bin, err := exec.LookPath("opencode")
	if err != nil {
		return "", false
	}
	cctx, cancel := context.WithTimeout(ctx, opencodeDBPathCliTO)
	defer cancel()
	out, err := exec.CommandContext(cctx, bin, "db", "path").Output()
	if err != nil {
		return "", false
	}
	p := strings.TrimSpace(string(out))
	if p == "" || p == ":memory:" {
		return "", false
	}
	return p, true
}

// fallbackDBPath re-implements OpenCode's Database.path() (v1.17.18) in Go. It
// reads the SAME env the running `opencode serve` process sees (vh-solara
// inherits the environment). xdg-basedir is XDG-spec-literal — it does NO
// platform branching, so macOS uses ~/.local/share too (NOT ~/Library/...).
func fallbackDBPath() (string, error) {
	// OPENCODE_DB wins over the default filename logic.
	if v := strings.TrimSpace(os.Getenv("OPENCODE_DB")); v != "" {
		if v == ":memory:" {
			return "", errors.New("OPENCODE_DB=:memory: is not a writable file")
		}
		if filepath.IsAbs(v) {
			return v, nil
		}
		dataDir, err := opencodeDataDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(dataDir, "opencode", v), nil
	}
	dataDir, err := opencodeDataDir()
	if err != nil {
		return "", err
	}
	// Channel filename. OPENCODE_DISABLE_CHANNEL_DB forces the plain file.
	if d := strings.TrimSpace(os.Getenv("OPENCODE_DISABLE_CHANNEL_DB")); d == "1" || d == "true" {
		return filepath.Join(dataDir, "opencode", "opencode.db"), nil
	}
	ch := strings.TrimSpace(os.Getenv(opencodeChannelEnv))
	if ch != "" && !opencodePublishedChannels[ch] {
		// Operator named a non-published (e.g. dev) channel -> opencode-<ch>.db.
		return filepath.Join(dataDir, "opencode", "opencode-"+sanitizeChannel(ch)+".db"), nil
	}
	// Default: the normal published-binary case.
	return filepath.Join(dataDir, "opencode", "opencode.db"), nil
}

// opencodeDataDir returns OpenCode's data directory: $XDG_DATA_HOME if set
// (xdg-basedir uses it verbatim, no platform branching), else ~/.local/share.
// Home honors OPENCODE_TEST_HOME (the test override) before os.UserHomeDir().
func opencodeDataDir() (string, error) {
	if v := os.Getenv("XDG_DATA_HOME"); v != "" {
		return v, nil
	}
	home := os.Getenv("OPENCODE_TEST_HOME")
	if home == "" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home dir: %w", err)
		}
	}
	return filepath.Join(home, ".local", "share"), nil
}

// sanitizeChannel mirrors OpenCode's channel filename sanitization:
// `InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")`.
func sanitizeChannel(ch string) string {
	var b strings.Builder
	for _, r := range ch {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	out := b.String()
	if out == "" {
		return "local"
	}
	return out
}

// unarchiveAtPath is the testable core: it opens the DB at an explicit path,
// runs the self-check once, and UPDATEs each id. It does NOT resolve the path.
func unarchiveAt(ctx context.Context, path string, ids []string) error {
	if fi, err := os.Stat(path); err != nil {
		return &SchemaError{Path: path, Cause: fmt.Sprintf("DB file not reachable: %v (is opencode running? set %s to the absolute DB path)", err, opencodeDBOverrideEnv)}
	} else if fi.IsDir() {
		return &SchemaError{Path: path, Cause: "resolved path is a directory, not a DB file"}
	}

	db, err := openDB(path)
	if err != nil {
		return fmt.Errorf("open opencode DB %s: %w (see %s)", path, err, opencodeCouplingDoc)
	}
	defer db.Close()

	// Bound the whole open+self-check+UPDATE window so a stalled/busy DB does
	// not hang the unarchive request indefinitely.
	cctx, cancel := context.WithTimeout(ctx, opencodeShelloutOpenTO)
	defer cancel()

	if err := assertSessionSchema(cctx, db, path); err != nil {
		return err
	}

	// Plain WHERE id = ? : always matches the row (a no-op re-write still
	// reports rowsAffected==1 as long as the row exists), so the assertion is a
	// clean "the session id is real and lives in this DB file" check. time_updated
	// is intentionally NOT touched.
	const stmt = "UPDATE " + opencodeSessionTable + " SET " + opencodeArchivedColumn + " = NULL WHERE id = ?"
	for _, id := range ids {
		if id == "" {
			continue
		}
		res, err := db.ExecContext(cctx, stmt, id)
		if err != nil {
			return fmt.Errorf("opencode unarchive UPDATE %s failed: %w (see %s)", id, err, opencodeCouplingDoc)
		}
		n, err := res.RowsAffected()
		if err != nil {
			return fmt.Errorf("opencode unarchive %s: cannot read rows affected: %w", id, err)
		}
		if n != 1 {
			return fmt.Errorf("opencode unarchive %s: expected exactly 1 row affected, got %d (unknown session id or wrong DB file); see %s",
				id, n, opencodeCouplingDoc)
		}
	}
	return nil
}

// openDB opens a WAL connection to the DB file with pragmas that let vh-solara
// coexist safely with the running OpenCode process (which also runs WAL): match
// its busy_timeout, use the same journal_mode/synchronous, and keep the pool to
// a single connection so we never contend with ourselves for the write lock.
// No wal_checkpoint(TRUNCATE)/VACUUM — OpenCode owns checkpointing.
func openDB(path string) (*sql.DB, error) {
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return db, nil
}

// assertSessionSchema is the always-on runtime drift guard. Before any UPDATE
// it introspects the live DB and asserts the captured v1.17.18 contract holds:
// the `session` table exists and has a `time_archived` column whose type
// contains INTEGER and which is nullable (notnull=0). On ANY mismatch it
// returns a loud *SchemaError and the caller refuses the write.
//
// PRAGMA table_info is used (not sqlite_master DDL parsing) because it returns
// parsed, stable column metadata and matches how OpenCode's own migration
// bootstrapper introspects tables.
func assertSessionSchema(ctx context.Context, db *sql.DB, path string) error {
	rows, err := db.QueryContext(ctx, "PRAGMA table_info("+opencodeSessionTable+")")
	if err != nil {
		return &SchemaError{Path: path, Cause: fmt.Sprintf("PRAGMA table_info(%s) failed: %v", opencodeSessionTable, err)}
	}
	defer rows.Close()

	found := false
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return &SchemaError{Path: path, Cause: fmt.Sprintf("scanning table_info row failed: %v", err)}
		}
		if name != opencodeArchivedColumn {
			continue
		}
		found = true
		if !strings.Contains(strings.ToUpper(ctype), opencodeArchivedType) {
			return &SchemaError{Path: path, Cause: fmt.Sprintf(
				"column %q has type %q; expected a type containing %q",
				opencodeArchivedColumn, ctype, opencodeArchivedType)}
		}
		if notnull != 0 {
			return &SchemaError{Path: path, Cause: fmt.Sprintf(
				"column %q is NOT NULL; expected nullable (the unarchive sets it to NULL)",
				opencodeArchivedColumn)}
		}
	}
	if err := rows.Err(); err != nil {
		return &SchemaError{Path: path, Cause: fmt.Sprintf("iterating table_info rows failed: %v", err)}
	}
	if !found {
		// A missing table also surfaces here (PRAGMA returns zero rows for a
		// non-existent table), so this single branch covers both "column gone"
		// and "whole table gone".
		return &SchemaError{Path: path, Cause: fmt.Sprintf(
			"column %q not found on table %q (table missing or renamed upstream)",
			opencodeArchivedColumn, opencodeSessionTable)}
	}
	return nil
}
