package projectcfg

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// LocalSetupMu serializes the read-modify-write of the local-preferences
// overlay (preferences.local.jsonc) and the one-time migration that rewrites
// project.jsonc. It is shared between EnsureLocalSetup (run once per project
// open from pkg/web.OpenProject) and the interactive HTTP PUT handler
// (pkg/web.handleProjectSettings): without a shared lock, a PUT landing while
// the migration mid-rewrites both files could interleave and corrupt them. Hold
// it across each whole RMW of either file.
var LocalSetupMu sync.Mutex

// localGitignoreGlobs is the exact content ensured at .vh-solara/.gitignore for
// every project vh-solara writes into: a header + the local-preferences globs +
// the runtime-data globs. Order matters only for the create-from-scratch case;
// the append-missing path checks each line for membership independently, so a
// partially-present file (e.g. one an older vh-solara wrote with only the prefs
// globs) gets the missing runtime lines appended without disturbing the rest.
var localGitignoreGlobs = []string{
	"# vh-solara local files — not committed (local preferences + runtime data).",
	"*.local",
	"*.local.jsonc",
	"# Runtime data vh-solara writes for any project (attachments, queue,",
	"# adopter-declared sockets/logs):",
	"/sessions/",
	"/run/",
}

// EnsureLocalSetup performs the one-time, idempotent local-preferences setup for
// a project discovered at root (override mirrors Load/ResolvePath resolution):
//
//  1. MIGRATE agentStyles: if the checked-in project.jsonc declares a top-level
//     `agentStyles`, move it to the gitignored preferences.local.jsonc overlay
//     and remove it from project.jsonc (comment-preserving). This keeps the
//     committed file declarative-only. Crash-safe ordering: the overlay is
//     written and flushed BEFORE project.jsonc is rewritten, so a crash between
//     the two steps leaves both files consistent enough that the next run
//     finishes the migration (the overlay is the authoritative local copy; the
//     stale key in project.jsonc just gets removed on re-run). Removing
//     agentStyles does NOT change the trust hash — canonical() serializes only
//     Processes+Views (see projectcfg.go), so the trust grant stays valid.
//
//  2. ENSURE .vh-solara/.gitignore exists with the local-preferences + runtime-
//     data globs (see localGitignoreGlobs): create it if absent, or append any
//     missing line (no duplicates, comments preserved) if it already exists.
//
// It is a no-op when project.jsonc lacks agentStyles and the gitignore already
// carries every glob, so it is safe to call on every project open. Errors are
// returned but should never block project open — callers log and continue.
func EnsureLocalSetup(root, override string) error {
	LocalSetupMu.Lock()
	defer LocalSetupMu.Unlock()

	cfgPath, err := ResolvePath(root, override)
	if err != nil {
		return err
	}
	// Non-managed project (no project.jsonc) → nothing to migrate. The
	// migration step bails here; the runtime-gitignore ensure for non-managed
	// projects is handled separately by EnsureRuntimeGitignore at the
	// attachment/queue write paths (see pkg/web/attach.go, pkg/web/queue.go).
	if _, err := os.Stat(cfgPath); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	prefPath, err := ResolvePreferencesPath(root, override)
	if err != nil {
		return err
	}

	if err := migrateAgentStyles(cfgPath, prefPath); err != nil {
		return err
	}
	return ensureLocalGitignore(filepath.Dir(cfgPath))
}

// EnsureRuntimeGitignore is the standalone entry point for the runtime write
// paths (attachments upload in pkg/web/attach.go, queue save in
// pkg/web/queue.go) that create a project's .vh-solara/ tree for ANY project —
// managed or not. It ensures .vh-solara/.gitignore (dir = the .vh-solara
// directory, which MUST already exist — callers MkdirAll it first) carries the
// local-preferences + runtime-data ignore globs, so a non-managed project whose
// first .vh-solara/ write is an attachment upload or a queued message also gets
// the safety net without going through EnsureLocalSetup (which bails on a
// missing project.jsonc).
//
// It is independent of project.jsonc and never touches it. Idempotent:
// create-from-scratch or append-missing, comments preserved. Acquires
// LocalSetupMu so it cannot interleave with EnsureLocalSetup's gitignore step or
// a concurrent preferences PUT. Errors are returned but callers should log and
// continue — never block an upload or a queue save.
func EnsureRuntimeGitignore(dir string) error {
	LocalSetupMu.Lock()
	defer LocalSetupMu.Unlock()
	return ensureLocalGitignore(dir)
}

// migrateAgentStyles moves a top-level agentStyles from project.jsonc (cfgPath)
// to the preferences.local.jsonc overlay (prefPath), then removes it from
// project.jsonc. See EnsureLocalSetup for the crash-safety ordering and the
// trust-hash note. Idempotent: a project.jsonc without agentStyles is a no-op.
func migrateAgentStyles(cfgPath, prefPath string) error {
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		// No project config → nothing to migrate (the common non-managed-project
		// case). A missing overlay is handled below.
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	migrated, hasKey := extractAgentStyles(raw)
	if !hasKey {
		return nil // already clean
	}

	// (b) Write the overlay BEFORE touching project.jsonc. Three cases:
	//   - overlay absent → create it with the migrated agentStyles
	//   - overlay exists without agentStyles → splice the migrated value in
	//   - overlay already declares agentStyles → local is authoritative, keep it
	//     intact (we still clear the stale team default from project.jsonc below)
	existing, rerr := os.ReadFile(prefPath)
	if rerr != nil && !os.IsNotExist(rerr) {
		return rerr
	}
	if migrated != nil {
		var newOverlay []byte
		if len(existing) == 0 {
			// Overlay absent → create it with the migrated agentStyles.
			newOverlay, err = SpliceTopLevelKey(nil, "agentStyles", migrated)
		} else if hasTopLevelKey(existing, "agentStyles") {
			// Overlay already declares agentStyles → local is authoritative; keep
			// it intact. We STILL clear the stale team default from project.jsonc.
			newOverlay = existing
		} else {
			// Overlay exists but lacks the key → splice the migrated value in.
			newOverlay, err = SpliceTopLevelKey(existing, "agentStyles", migrated)
		}
		if err != nil {
			return err
		}
		// Skip a no-op write (idempotent re-run where nothing changed).
		if !bytes.Equal(newOverlay, existing) {
			if err := os.MkdirAll(filepath.Dir(prefPath), 0o755); err != nil {
				return err
			}
			if err := writeFileAtomic(prefPath, newOverlay, 0o644); err != nil {
				return err
			}
		}
	}

	// (c) ONLY after the overlay is flushed, remove agentStyles from
	// project.jsonc (comment-preserving). If we crashed before this step the
	// next run re-reads project.jsonc (key still present) and redoes (b)+(c);
	// the overlay already holds the value (or a local edit that wins), so no
	// data is lost.
	cleaned := RemoveTopLevelKey(raw, "agentStyles")
	if !bytes.Equal(cleaned, raw) {
		if err := writeFileAtomic(cfgPath, cleaned, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// extractAgentStyles pulls the agentStyles map from raw JSONC. Returns
// (map, true) when the top-level key is present (the map may be nil for a
// `null` value, or empty for `{}`), and (nil, false) when the key is absent or
// the document has no root object. A malformed value returns false (leave the
// file alone rather than risk a bad migration).
func extractAgentStyles(raw []byte) (map[string]AgentStyle, bool) {
	if !hasTopLevelKey(raw, "agentStyles") {
		return nil, false
	}
	styles, err := ParseAgentStyles(raw)
	if err != nil {
		return nil, false
	}
	return styles, true
}

// hasTopLevelKey reports whether raw's root object declares a top-level `key`.
// Tolerates comments and brace/quote tracking via blankComments; returns false
// for a missing root object.
func hasTopLevelKey(raw []byte, key string) bool {
	scan := blankComments(raw)
	open := indexRootOpen(scan)
	if open < 0 {
		return false
	}
	_, _, _, found := findTopLevelValue(scan, open, key)
	return found
}

// ensureLocalGitignore creates dir/.gitignore with the local-ignore globs if it
// is absent, or appends any missing glob line (no duplicates, comments
// preserved) if it already exists. Idempotent.
func ensureLocalGitignore(dir string) error {
	path := filepath.Join(dir, ".gitignore")
	cur, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			body := strings.Join(localGitignoreGlobs, "\n") + "\n"
			return os.WriteFile(path, []byte(body), 0o644)
		}
		return err
	}
	// Append any missing line. Membership is checked per exact line, so an
	// existing user comment or a reordered set is preserved untouched.
	have := map[string]bool{}
	for _, l := range strings.Split(string(cur), "\n") {
		have[l] = true
	}
	var add []string
	for _, l := range localGitignoreGlobs {
		if !have[l] {
			add = append(add, l)
		}
	}
	if len(add) == 0 {
		return nil
	}
	body := string(cur)
	if len(body) == 0 || body[len(body)-1] != '\n' {
		body += "\n"
	}
	body += strings.Join(add, "\n") + "\n"
	return os.WriteFile(path, []byte(body), 0o644)
}
