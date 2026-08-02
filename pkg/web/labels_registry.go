package web

// Per-project labels registry + one-time worker-wide → per-project migration.
//
// This file replaces the single worker-wide LabelStore (Slice 1/2 design: one
// labels.json under stateBaseDir()) with a LAZY REGISTRY keyed by the existing
// project key (projectKey(projectRoot(dir)) — the same sha1-of-abs-cwd key
// pkg/web/notes.go and pins.go use). Each project owns an INDEPENDENT store at
//
//	<stateBaseDir>/projects/<key>/labels.json
//
// with its own revision/CAS domain. The store API (labels.go) is unchanged;
// only its scope moves from worker-wide to per-project.
//
// Three concerns live here:
//  1. labelRegistry + (*Server).labelsForDir — lazy, per-project store lookup.
//  2. migrateLabelsToPerProject — a one-time, idempotent, synchronous cutover
//     that partitions the legacy worker-wide labels.json into per-project files
//     using the existing projectByRootSessionId sidecar to attribute roots, and
//     routes ambiguous material to labels-legacy-unassigned.json (NEVER to an
//     arbitrary project).
//  3. partitionLabelsFile — the pure partition function the migration calls.
//
// Non-goals: pins.go and notes.go stay worker-wide; the LabelsDoc wire schema is
// unchanged; there is no dual-writer (the legacy file is removed in the single
// cutover step, with a backup preserved).

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// labelsMigrationMarker is the completion marker touched LAST by a successful
// migration. Its presence means the cutover is durable: the legacy file was
// partitioned (or preserved as unparseable) and per-project files are the source
// of truth. Its absence means the migration must (re)run — all migration steps
// are idempotent overwrites, so a retry after interruption re-derives every
// output from the immutable source/backup.
const labelsMigrationMarker = ".labels-migrated-v1"

// labelsLegacyFile is the worker-wide source path (pre-cutover location).
const labelsLegacyFile = "labels.json"

// labelsBackupFile is the raw byte-for-byte backup of the legacy file, written
// BEFORE any per-project output and kept forever as the durable pre-cutover
// snapshot an operator can recover from.
const labelsBackupFile = "labels.json.pre-migration.bak"

// labelsUnassignedFile is the sink for ambiguous material that could not be
// attributed to any single project: empty groups, unused/assignment-free tag
// definitions, and references (group memberships or tag assignments) whose root
// has no projectByRootSessionId attribution. It is written ONLY when such
// material exists. It is NEVER auto-merged into cwd, the first-opened project,
// or any arbitrary project — an operator must triage it deliberately.
const labelsUnassignedFile = "labels-legacy-unassigned.json"

// labelRegistry is the lazy per-project LabelStore registry. Stores are created
// on first access via (*Server).labelsForDir and cached by project key for the
// daemon's lifetime. Each cached store retains its own revision/CAS domain and
// atomic persistence lifecycle; validation invariants (labels.go) are unchanged.
type labelRegistry struct {
	mu     sync.Mutex
	stores map[string]*LabelStore
}

func newLabelRegistry() *labelRegistry {
	return &labelRegistry{stores: map[string]*LabelStore{}}
}

// labelsForDir resolves (and lazily creates) the per-project LabelStore for dir.
// dir flows from reqDir(r) (HTTP/stream bootstrap) or the aggregator's dir
// (lifecycle/reconcile). It returns nil when dir cannot be resolved to a project
// root or the store cannot be constructed — callers MUST handle nil by skipping
// the operation (the handler returns an empty doc / the lifecycle layer no-ops).
//
// A missing project file yields a zero-doc store (NewLabelStore does NOT write on
// a missing file), so merely RESOLVING a store for an empty/unresolved web
// project selection writes nothing — the file materializes lazily on the first
// successful mutation only. The default/empty dir resolves to the daemon-cwd
// project key, mirroring how the default aggregator and activeRootProjects have
// always attributed the daemon's own project.
func (s *Server) labelsForDir(dir string) *LabelStore {
	root, err := projectRoot(dir)
	if err != nil {
		vhlog.Warn("labels: resolve project root failed", "dir", dir, "err", err)
		return nil
	}
	key := projectKey(root)
	s.labelsReg.mu.Lock()
	defer s.labelsReg.mu.Unlock()
	if st, ok := s.labelsReg.stores[key]; ok {
		return st
	}
	st, err := NewLabelStore(filepath.Join(stateBaseDir(), "projects", key, "labels.json"))
	if err != nil {
		vhlog.Error("labels: open per-project store failed", "dir", dir, "key", key, "err", err)
		return nil
	}
	s.labelsReg.stores[key] = st
	return st
}

// --- one-time cutover -------------------------------------------------------

// migrateLabelsToPerProject performs the one-time, idempotent partition of the
// legacy worker-wide labels.json into per-project files. It is called
// synchronously from NewServer BEFORE any HTTP request can reach labelsForDir,
// so no concurrent mutation is possible during an interrupted run.
//
// Backup + marker scheme (highest-risk path — conservative + recoverable):
//   - If the completion marker (.labels-migrated-v1) exists, the cutover is
//     already durable → return immediately (idempotent on retry).
//   - The source is the legacy file if present, else the backup (an interrupted
//     retry after the legacy was removed but before the marker landed finds the
//     backup and re-derives every output from it).
//   - If no source exists, there is nothing to migrate → write the marker.
//   - The legacy file is backed up byte-for-byte (labels.json.pre-migration.bak)
//     BEFORE any partition output, and the backup is kept forever.
//   - Per-project files are written via writeLabelsAtomic (POSIX-atomic rename),
//     each fully re-derived from the immutable source — a retry overwrites them
//     identically, never duplicates or repartitions.
//   - Ambiguous material reaches labels-legacy-unassigned.json.
//   - The legacy file is removed (single cutover point — no dual-writer) and the
//     marker is written LAST, so a crash before the marker leaves a fully
//     re-derivable state; a crash after it leaves a complete one.
//
// If the source is present but unparseable or schema-mismatched, it CANNOT be
// partitioned safely: its raw bytes are preserved verbatim in BOTH the backup
// and the unassigned sink (so an operator can recover/triage), the legacy file
// is removed, and the marker is written. Data is never silently dropped and the
// migration never retries forever on a bad file.
func migrateLabelsToPerProject() error {
	base := stateBaseDir()
	legacyPath := filepath.Join(base, labelsLegacyFile)
	backupPath := filepath.Join(base, labelsBackupFile)
	markerPath := filepath.Join(base, labelsMigrationMarker)
	unassignedPath := filepath.Join(base, labelsUnassignedFile)
	projectsDir := filepath.Join(base, "projects")

	// (a) Completion marker present → done.
	if _, err := os.Stat(markerPath); err == nil {
		return nil
	}

	// (b) Resolve source: legacy first, else backup (interrupted retry).
	sourcePath := ""
	if _, err := os.Stat(legacyPath); err == nil {
		sourcePath = legacyPath
	} else if _, err := os.Stat(backupPath); err == nil {
		sourcePath = backupPath
	}

	// Ensure the base dir exists for any output we write below.
	if err := os.MkdirAll(base, 0o700); err != nil {
		return fmt.Errorf("labels migration: mkdir %s: %w", base, err)
	}

	if sourcePath == "" {
		// Nothing to migrate (fresh install) — just mark done.
		return writeMigrationMarker(markerPath)
	}

	// (c) Read + parse source.
	data, err := os.ReadFile(sourcePath)
	if err != nil {
		return fmt.Errorf("labels migration: read %s: %w", sourcePath, err)
	}
	var lf labelsFile
	if err := json.Unmarshal(data, &lf); err != nil || lf.SchemaVersion != labelsSchemaVersion {
		// Unparseable / schema mismatch: cannot partition. Preserve the raw
		// bytes in the backup AND the unassigned sink, remove the legacy file
		// (single cutover), mark done. Never lose data; never retry forever.
		vhlog.Warn("labels migration: source unparseable/schema-mismatch; preserving raw bytes in backup + unassigned sink", "path", sourcePath)
		if _, statErr := os.Stat(backupPath); statErr != nil {
			if werr := writeLabelsAtomic(backupPath, data, 0o644); werr != nil {
				return fmt.Errorf("labels migration: write backup: %w", werr)
			}
		}
		if _, statErr := os.Stat(unassignedPath); statErr != nil {
			if werr := writeLabelsAtomic(unassignedPath, data, 0o644); werr != nil {
				return fmt.Errorf("labels migration: write unassigned: %w", werr)
			}
		}
		if sourcePath == legacyPath {
			_ = os.Remove(legacyPath)
		}
		return writeMigrationMarker(markerPath)
	}

	// Normalize nil collections so partition ranges are robust (mirrors
	// NewLabelStore's load normalization).
	if lf.Groups == nil {
		lf.Groups = []LabelGroup{}
	}
	for i := range lf.Groups {
		if lf.Groups[i].OrderedRootSessionIDs == nil {
			lf.Groups[i].OrderedRootSessionIDs = []string{}
		}
	}
	if lf.Tags == nil {
		lf.Tags = []LabelTag{}
	}
	if lf.TagIDsByRootSessionID == nil {
		lf.TagIDsByRootSessionID = map[string][]string{}
	}
	if lf.ProjectByRootSessionID == nil {
		lf.ProjectByRootSessionID = map[string]string{}
	}

	// (d) Partition.
	perProject, unassigned := partitionLabelsFile(lf)

	// (e) Backup source (byte-for-byte) if absent — durable source-of-truth
	//     until the marker lands.
	if _, statErr := os.Stat(backupPath); statErr != nil {
		if werr := writeLabelsAtomic(backupPath, data, 0o644); werr != nil {
			return fmt.Errorf("labels migration: write backup: %w", werr)
		}
	}

	// (f) Write each per-project file (idempotent overwrite). writeLabelsAtomic
	//     does not create the parent dir (only the store's persistLocked does),
	//     so ensure projects/<key>/ exists before each atomic write.
	for key, doc := range perProject {
		projectDir := filepath.Join(projectsDir, key)
		if err := os.MkdirAll(projectDir, 0o700); err != nil {
			return fmt.Errorf("labels migration: mkdir project %s: %w", key, err)
		}
		buf, mErr := json.MarshalIndent(doc, "", "  ")
		if mErr != nil {
			return fmt.Errorf("labels migration: marshal project %s: %w", key, mErr)
		}
		if werr := writeLabelsAtomic(filepath.Join(projectDir, "labels.json"), buf, 0o644); werr != nil {
			return fmt.Errorf("labels migration: write project %s: %w", key, werr)
		}
	}

	// (g) Write the unassigned sink only when it carries ambiguous material.
	if len(unassigned.Groups) > 0 || len(unassigned.Tags) > 0 || len(unassigned.TagIDsByRootSessionID) > 0 {
		buf, mErr := json.MarshalIndent(unassigned, "", "  ")
		if mErr != nil {
			return fmt.Errorf("labels migration: marshal unassigned: %w", mErr)
		}
		if werr := writeLabelsAtomic(unassignedPath, buf, 0o644); werr != nil {
			return fmt.Errorf("labels migration: write unassigned: %w", werr)
		}
	}

	// (h) Cutover: remove the legacy file (the backup preserves it). Single
	//     point — no legacy/new dual-writer exists after this.
	if sourcePath == legacyPath {
		_ = os.Remove(legacyPath)
	}

	// (i) Marker LAST.
	return writeMigrationMarker(markerPath)
}

// writeMigrationMarker writes the completion marker atomically.
func writeMigrationMarker(markerPath string) error {
	return writeLabelsAtomic(markerPath, []byte("v1\n"), 0o644)
}

// partitionLabelsFile splits a legacy worker-wide labelsFile into per-project
// documents keyed by the existing projectKey, plus an unassigned sink for
// ambiguous material. Attribution is by lf.ProjectByRootSessionID (root id →
// project key) — the SAME sha1-of-abs-cwd key the worker already maintains.
//
// Membership partition:
//   - Groups: OrderedRootSessionIDs are split by owning project — each project
//     gets the SAME definition carrying ONLY its roots (order preserved); roots
//     with no sidecar attribution go to unassigned; a group with NO roots at all
//     (assignment-free definition) goes wholesale to unassigned.
//   - Tag assignments (TagIDsByRootSessionID): a known root's tags go to its
//     owning project; an unknown root's tags go to unassigned.
//   - Tag definitions: copied to EVERY project whose attributable assignment
//     uses the tag (so partition can never create a dangling tag ref); a tag
//     used only by unattributable roots, or unused entirely, goes to unassigned.
//
// Each output doc is an INDEPENDENT CAS domain: Revision resets to 0, and the
// sidecar (ProjectByRootSessionID) is populated with the doc's own key for every
// referenced root, so the reconcile scope fence (projects[rid] == key) holds.
// Ambiguous material is NEVER auto-assigned to cwd, the first-opened project, or
// any arbitrary project.
func partitionLabelsFile(lf labelsFile) (perProject map[string]labelsFile, unassigned labelsFile) {
	ownerOf := lf.ProjectByRootSessionID // root id → project key
	docs := map[string]*labelsFile{}
	get := func(key string) *labelsFile {
		if d, ok := docs[key]; ok {
			return d
		}
		d := zeroLabelsFile()
		docs[key] = &d
		return &d
	}
	unassigned = zeroLabelsFile()
	unp := &unassigned

	// tagUsers[tagID] = set of project keys that reference the tag via an
	// ATTRIBUTABLE (known-root) assignment. Unattributable roots do NOT count —
	// their tags flow to unassigned, and a tag used only there is unassigned too.
	tagUsers := map[string]map[string]bool{}
	markUser := func(tagID, key string) {
		if tagUsers[tagID] == nil {
			tagUsers[tagID] = map[string]bool{}
		}
		tagUsers[tagID][key] = true
	}

	// 1. Partition group memberships.
	for _, g := range lf.Groups {
		byOwner := map[string][]string{} // key → ordered roots
		var unRoots []string
		for _, rid := range g.OrderedRootSessionIDs {
			if rid == "" {
				continue
			}
			if key, ok := ownerOf[rid]; ok {
				byOwner[key] = append(byOwner[key], rid)
			} else {
				unRoots = append(unRoots, rid)
			}
		}
		if len(byOwner) == 0 && len(unRoots) == 0 {
			// Assignment-free group definition → unassigned.
			unp.Groups = append(unp.Groups, withRoots(g, nil))
			continue
		}
		for key, roots := range byOwner {
			d := get(key)
			d.Groups = append(d.Groups, withRoots(g, roots))
		}
		if len(unRoots) > 0 {
			unp.Groups = append(unp.Groups, withRoots(g, unRoots))
		}
	}

	// 2. Partition tag assignments; record attributable tag usage.
	for rid, tags := range lf.TagIDsByRootSessionID {
		if rid == "" {
			continue
		}
		cp := append([]string(nil), tags...)
		if key, ok := ownerOf[rid]; ok {
			d := get(key)
			d.TagIDsByRootSessionID[rid] = cp
			for _, tid := range cp {
				if tid != "" {
					markUser(tid, key)
				}
			}
		} else {
			unp.TagIDsByRootSessionID[rid] = cp
		}
	}

	// 3. Tag definitions: copy to each attributable project that uses the tag;
	//    unused / unattributable-only tags go to unassigned.
	for _, tg := range lf.Tags {
		users := tagUsers[tg.ID]
		if len(users) == 0 {
			unp.Tags = append(unp.Tags, tg)
			continue
		}
		for key := range users {
			d := get(key)
			d.Tags = append(d.Tags, tg)
		}
	}

	// 4. Finalize: build the sidecar (own key for every referenced root) and
	//    dereference into value docs. Revision stays 0 (zeroLabelsFile) — each
	//    project is a fresh independent CAS domain.
	perProject = map[string]labelsFile{}
	for key, d := range docs {
		out := *d
		referenced := referencedRootsInLabelsDoc(out.LabelsDoc)
		out.ProjectByRootSessionID = make(map[string]string, len(referenced))
		for rid := range referenced {
			out.ProjectByRootSessionID[rid] = key
		}
		perProject[key] = out
	}
	// Unassigned sidecar stays empty (its roots are unattributable by design).
	return perProject, unassigned
}

// withRoots returns a copy of g carrying exactly roots as its ordered list (a
// fresh slice, never aliasing the source). nil → empty list so the output never
// holds a nil OrderedRootSessionIDs.
func withRoots(g LabelGroup, roots []string) LabelGroup {
	out := g
	if roots == nil {
		out.OrderedRootSessionIDs = []string{}
	} else {
		out.OrderedRootSessionIDs = append([]string(nil), roots...)
	}
	return out
}

// emptyLabelsDoc returns a wire-shaped empty LabelsDoc (revision 0, non-nil
// empty collections) for the bootstrap path when no project store is resolvable.
// Using non-nil collections keeps the JSON shape ([] / {}, not null) consistent
// with Snapshot() across the connected lifecycle.
func emptyLabelsDoc() LabelsDoc {
	return LabelsDoc{
		Groups:                []LabelGroup{},
		Tags:                  []LabelTag{},
		TagIDsByRootSessionID: map[string][]string{},
	}
}
