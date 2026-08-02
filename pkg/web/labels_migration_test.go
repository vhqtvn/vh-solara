package web

// Per-project labels cutover — migration + recovery coverage (task items 6-9).
//
// migrateLabelsToPerProject (labels_registry.go) is the one-time, idempotent,
// synchronous cutover that partitions the legacy worker-wide labels.json into
// per-project files. These tests exercise it directly:
//
//   - 6: legacy cross-project group memberships partition correctly across the
//        owning projects' docs.
//   - 7: unknown roots + unattributable tag/group definitions reach
//        labels-legacy-unassigned.json (never an arbitrary project).
//   - 8: interrupted / repeated migration is idempotent (marker-gated; outputs
//        are overwrites re-derived from the immutable source/backup).
//   - 9: an empty web project selection cannot trigger migration or write labels
//        into the daemon cwd (migration is boot-time only; resolving a store for
//        an unmutated project writes nothing).
//
// Lane: Go co-located unit (pkg/web/). Drives migrateLabelsToPerProject +
// NewServer directly with VH_STATE_DIR isolated per test, then inspects the
// on-disk outputs.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// writeLegacyLabels writes a labelsFile as the legacy worker-wide labels.json
// under the current stateBaseDir(). Used to stage pre-cutover state.
func writeLegacyLabels(t *testing.T, lf labelsFile) {
	t.Helper()
	data, err := json.MarshalIndent(lf, "", "  ")
	if err != nil {
		t.Fatalf("marshal legacy: %v", err)
	}
	path := filepath.Join(stateBaseDir(), labelsLegacyFile)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir legacy dir: %v", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write legacy %s: %v", path, err)
	}
}

// readProjectLabelsFile reads and decodes a per-project labels.json for key.
func readProjectLabelsFile(t *testing.T, key string) labelsFile {
	t.Helper()
	data, err := os.ReadFile(labelsProjectFile(key))
	if err != nil {
		t.Fatalf("read project file for key %s: %v", key, err)
	}
	var lf labelsFile
	if err := json.Unmarshal(data, &lf); err != nil {
		t.Fatalf("unmarshal project file for key %s: %v", key, err)
	}
	return lf
}

// migrationMarkerPath is the completion-marker path under stateBaseDir().
func migrationMarkerPath() string {
	return filepath.Join(stateBaseDir(), labelsMigrationMarker)
}

// runMigration sets a fresh VH_STATE_DIR and calls migrateLabelsToPerProject.
func runMigration(t *testing.T) {
	t.Helper()
	if err := migrateLabelsToPerProject(); err != nil {
		t.Fatalf("migrateLabelsToPerProject: %v", err)
	}
}

// TestLabelsMigration_PartitionsCrossProjectMemberships (item 6): a legacy
// worker-wide doc whose single group spans two projects' roots is split so each
// project's doc carries the SAME group definition with ONLY its own roots
// (order preserved), and each project's sidecar attributes its roots to its own
// key. Tag assignments follow the owning root; tag definitions are copied to
// each project that uses them.
func TestLabelsMigration_PartitionsCrossProjectMemberships(t *testing.T) {
	dirA := t.TempDir()
	dirB := t.TempDir()
	keyA := projectKey(dirA)
	keyB := projectKey(dirB)
	t.Setenv("VH_STATE_DIR", t.TempDir())

	writeLegacyLabels(t, labelsFile{
		SchemaVersion: labelsSchemaVersion,
		LabelsDoc: LabelsDoc{
			Revision: 7, // worker-wide revision is RESET to 0 per project
			Groups: []LabelGroup{{
				ID: "g1", Name: "Shared", Color: "blue",
				OrderedRootSessionIDs: []string{"rA1", "rA2", "rB1"},
			}},
			Tags:                  []LabelTag{{ID: "t1", Name: "T", Color: "red"}},
			TagIDsByRootSessionID: map[string][]string{"rA1": {"t1"}, "rB1": {"t1"}},
		},
		ProjectByRootSessionID: map[string]string{"rA1": keyA, "rA2": keyA, "rB1": keyB},
	})
	runMigration(t)

	docA := readProjectLabelsFile(t, keyA)
	docB := readProjectLabelsFile(t, keyB)

	// Revision reset to 0 (independent CAS domain).
	if docA.Revision != 0 || docB.Revision != 0 {
		t.Fatalf("revision not reset: A=%d B=%d, want 0/0", docA.Revision, docB.Revision)
	}
	// Group g1 split: A gets [rA1, rA2], B gets [rB1].
	if len(docA.Groups) != 1 || docA.Groups[0].ID != "g1" {
		t.Fatalf("project A groups = %+v, want one g1", docA.Groups)
	}
	if got := docA.Groups[0].OrderedRootSessionIDs; len(got) != 2 || got[0] != "rA1" || got[1] != "rA2" {
		t.Fatalf("project A g1 roots = %v, want [rA1 rA2]", got)
	}
	if len(docB.Groups) != 1 || docB.Groups[0].ID != "g1" {
		t.Fatalf("project B groups = %+v, want one g1", docB.Groups)
	}
	if got := docB.Groups[0].OrderedRootSessionIDs; len(got) != 1 || got[0] != "rB1" {
		t.Fatalf("project B g1 roots = %v, want [rB1]", got)
	}
	// Tag assignments followed the owning root.
	if got := docA.TagIDsByRootSessionID["rA1"]; len(got) != 1 || got[0] != "t1" {
		t.Fatalf("project A tag assign rA1 = %v, want [t1]", got)
	}
	if got := docB.TagIDsByRootSessionID["rB1"]; len(got) != 1 || got[0] != "t1" {
		t.Fatalf("project B tag assign rB1 = %v, want [t1]", got)
	}
	// Tag def t1 copied to BOTH projects (each uses it).
	if !labelTagDefExists(docA, "t1") || !labelTagDefExists(docB, "t1") {
		t.Fatalf("tag def t1 must be copied to both projects; A tags=%+v B tags=%+v", docA.Tags, docB.Tags)
	}
	// Sidecar attributes each project's roots to its OWN key.
	if docA.ProjectByRootSessionID["rA1"] != keyA || docA.ProjectByRootSessionID["rA2"] != keyA {
		t.Fatalf("project A sidecar = %+v, want rA1/rA2 → %s", docA.ProjectByRootSessionID, keyA)
	}
	if docB.ProjectByRootSessionID["rB1"] != keyB {
		t.Fatalf("project B sidecar = %+v, want rB1 → %s", docB.ProjectByRootSessionID, keyB)
	}
	// Legacy removed; backup + marker present.
	if _, err := os.Stat(filepath.Join(stateBaseDir(), labelsLegacyFile)); err == nil {
		t.Fatalf("legacy labels.json still present after migration")
	}
	if _, err := os.Stat(filepath.Join(stateBaseDir(), labelsBackupFile)); err != nil {
		t.Fatalf("backup missing after migration: %v", err)
	}
	if _, err := os.Stat(migrationMarkerPath()); err != nil {
		t.Fatalf("marker missing after migration: %v", err)
	}
	// No unassigned sink needed (everything was attributable).
	if _, err := os.Stat(filepath.Join(stateBaseDir(), labelsUnassignedFile)); err == nil {
		t.Fatalf("unassigned sink written despite no ambiguous material")
	}
}

// TestLabelsMigration_UnknownRootsAndUnassignedDefs (item 7): roots with no
// sidecar attribution, assignment-free group definitions, and unused tag
// definitions all reach labels-legacy-unassigned.json — NEVER an arbitrary
// project's doc.
func TestLabelsMigration_UnknownRootsAndUnassignedDefs(t *testing.T) {
	dirA := t.TempDir()
	keyA := projectKey(dirA)
	t.Setenv("VH_STATE_DIR", t.TempDir())

	writeLegacyLabels(t, labelsFile{
		SchemaVersion: labelsSchemaVersion,
		LabelsDoc: LabelsDoc{
			Groups: []LabelGroup{
				{ID: "gKnown", Name: "Known", Color: "blue", OrderedRootSessionIDs: []string{"rA1"}},
				{ID: "gUnknown", Name: "Unknown", Color: "green", OrderedRootSessionIDs: []string{"rGhost"}},
				{ID: "gEmpty", Name: "Empty", Color: "red", OrderedRootSessionIDs: []string{}}, // assignment-free
			},
			Tags: []LabelTag{
				{ID: "tUsed", Name: "Used", Color: "red"},
				{ID: "tUnused", Name: "Unused", Color: "red"}, // unused → unassigned
			},
			TagIDsByRootSessionID: map[string][]string{
				"rA1":    {"tUsed"},   // attributable → A
				"rGhost": {"tUnused"}, // unknown root → unassigned (carries tUnused)
			},
		},
		ProjectByRootSessionID: map[string]string{"rA1": keyA}, // rGhost NOT attributed
	})
	runMigration(t)

	// Project A gets ONLY its attributable material: gKnown[rA1], tUsed, rA1→tUsed.
	docA := readProjectLabelsFile(t, keyA)
	if len(docA.Groups) != 1 || docA.Groups[0].ID != "gKnown" {
		t.Fatalf("project A groups = %+v, want only gKnown", docA.Groups)
	}
	if !labelTagDefExists(docA, "tUsed") || labelTagDefExists(docA, "tUnused") {
		t.Fatalf("project A tags = %+v, want only tUsed", docA.Tags)
	}

	// Unassigned sink carries the ambiguous material.
	unData, err := os.ReadFile(filepath.Join(stateBaseDir(), labelsUnassignedFile))
	if err != nil {
		t.Fatalf("unassigned sink missing: %v", err)
	}
	var un labelsFile
	if err := json.Unmarshal(unData, &un); err != nil {
		t.Fatalf("unmarshal unassigned: %v", err)
	}
	// gUnknown (carries rGhost), gEmpty (assignment-free), rGhost tag assign,
	// and tUnused def all land in unassigned.
	if !labelGroupDefExists(un, "gUnknown") {
		t.Fatalf("unassigned missing gUnknown (unknown roots): %+v", un.Groups)
	}
	if !labelGroupDefExists(un, "gEmpty") {
		t.Fatalf("unassigned missing gEmpty (assignment-free def): %+v", un.Groups)
	}
	if _, ok := un.TagIDsByRootSessionID["rGhost"]; !ok {
		t.Fatalf("unassigned missing rGhost tag assignment: %+v", un.TagIDsByRootSessionID)
	}
	if !labelTagDefExists(un, "tUnused") {
		t.Fatalf("unassigned missing tUnused (used only by unknown root): %+v", un.Tags)
	}
	// Project A must NOT carry any of the ambiguous material.
	if labelGroupDefExists(docA, "gUnknown") || labelGroupDefExists(docA, "gEmpty") {
		t.Fatalf("project A leaked ambiguous group defs: %+v", docA.Groups)
	}
	if _, ok := docA.TagIDsByRootSessionID["rGhost"]; ok {
		t.Fatalf("project A leaked unknown root rGhost")
	}
}

// TestLabelsMigration_Idempotent (item 8): running migration twice (and
// simulating an interruption where the marker is absent but per-project outputs
// exist) produces identical, non-duplicated, non-repartitioned results.
func TestLabelsMigration_Idempotent(t *testing.T) {
	dirA := t.TempDir()
	keyA := projectKey(dirA)
	t.Setenv("VH_STATE_DIR", t.TempDir())

	writeLegacyLabels(t, labelsFile{
		SchemaVersion: labelsSchemaVersion,
		LabelsDoc: LabelsDoc{
			Groups:                []LabelGroup{{ID: "g1", Name: "G", Color: "blue", OrderedRootSessionIDs: []string{"rA1"}}},
			Tags:                  []LabelTag{{ID: "t1", Name: "T", Color: "red"}},
			TagIDsByRootSessionID: map[string][]string{"rA1": {"t1"}},
		},
		ProjectByRootSessionID: map[string]string{"rA1": keyA},
	})
	runMigration(t)
	docAFirst := readProjectLabelsFile(t, keyA)

	// Run migration AGAIN — the marker must short-circuit it (idempotent).
	runMigration(t)
	docASecond := readProjectLabelsFile(t, keyA)
	if docAFirst.Revision != docASecond.Revision || len(docAFirst.Groups) != len(docASecond.Groups) {
		t.Fatalf("re-run altered project A doc: first=%+v second=%+v", docAFirst, docASecond)
	}

	// Simulate an interruption: remove the marker (but leave per-project outputs
	// + backup), then re-run. The backup is the durable source-of-truth, so the
	// re-derivation must reproduce the SAME per-project output byte-stably.
	if err := os.Remove(migrationMarkerPath()); err != nil {
		t.Fatalf("remove marker (simulate interruption): %v", err)
	}
	// Legacy is already gone (cutover removed it); the backup must drive the retry.
	runMigration(t)
	docAThird := readProjectLabelsFile(t, keyA)
	if got := docAThird.Groups[0].OrderedRootSessionIDs; len(got) != 1 || got[0] != "rA1" {
		t.Fatalf("post-interruption re-run repartitioned project A: %+v", docAThird)
	}
	if _, err := os.Stat(migrationMarkerPath()); err != nil {
		t.Fatalf("marker not re-written after interruption recovery: %v", err)
	}
}

// TestLabelsMigration_EmptySelectionDoesNotWriteIntoCwd (item 9): with no legacy
// data, a fresh NewServer writes ONLY the completion marker (no top-level
// labels.json, no file in the daemon cwd). A GET for the empty/default project
// resolves the store but writes nothing (missing-file → zero doc, no persist).
// Only a real mutation materializes a per-project file, and even then never at
// the top-level legacy path or in the daemon cwd.
func TestLabelsMigration_EmptySelectionDoesNotWriteIntoCwd(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("VH_STATE_DIR", stateDir)

	const deadURL = "http://127.0.0.1:1"
	agg := aggregator.New(deadURL, 100)
	srv, err := NewServer(agg, deadURL, 100)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})

	// Migration ran at boot: ONLY the marker exists. No legacy file, no
	// top-level labels.json, no per-project file yet.
	if _, err := os.Stat(filepath.Join(stateDir, labelsLegacyFile)); err == nil {
		t.Fatalf("a fresh boot wrote a top-level labels.json — migration must be a no-op with no legacy data")
	}
	if _, err := os.Stat(migrationMarkerPath()); err != nil {
		t.Fatalf("completion marker missing after fresh boot: %v", err)
	}
	// No per-project dir materialized yet (no mutation has happened).
	if entries, _ := os.ReadDir(filepath.Join(stateDir, "projects")); len(entries) != 0 {
		t.Fatalf("fresh boot materialized per-project files with no mutation: %v", entries)
	}

	// A GET for the empty/default project resolves the store but must NOT write.
	resp, err := http.Get(web.URL + "/vh/labels")
	if err != nil {
		t.Fatalf("GET /vh/labels: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("GET /vh/labels status = %d, want 200", resp.StatusCode)
	}
	// Still no per-project file (GET does not persist a missing file).
	defaultKey := projectKey(mustProjectRoot(t, ""))
	if _, err := os.Stat(labelsProjectFile(defaultKey)); err == nil {
		t.Fatalf("GET materialized the default project's labels.json — resolving a store must not write")
	}
	// And nothing in the daemon cwd.
	if _, err := os.Stat("labels.json"); err == nil {
		t.Fatalf("a labels.json appeared in the daemon cwd — must never happen")
	}
}

// --- small shared defs/helpers (test-only) ----------------------------------

func labelTagDefExists(lf labelsFile, id string) bool {
	for _, tg := range lf.Tags {
		if tg.ID == id {
			return true
		}
	}
	return false
}

func labelGroupDefExists(lf labelsFile, id string) bool {
	for _, g := range lf.Groups {
		if g.ID == id {
			return true
		}
	}
	return false
}

// --- corrupt / unparseable source recovery (DEFER F5-Go) ---------------------
//
// migrateLabelsToPerProject's recovery branch fires when the legacy source is
// UNPARSEABLE (json.Unmarshal fails) or SCHEMA-MISMATCHED (SchemaVersion !=
// labelsSchemaVersion). It cannot partition such input safely, so its contract
// is: preserve the raw bytes verbatim in BOTH the backup and the unassigned
// sink, remove the legacy file, write the completion marker, return nil, and
// write NO per-project store. These tests pin that contract (items 1-6).

// seedLegacyLabelsRaw writes raw bytes verbatim as the legacy worker-wide
// labels.json under the current stateBaseDir(). Used to stage an unparseable /
// schema-mismatched legacy file the migration must recover from.
func seedLegacyLabelsRaw(t *testing.T, raw []byte) {
	t.Helper()
	path := filepath.Join(stateBaseDir(), labelsLegacyFile)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir legacy dir: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatalf("write legacy %s: %v", path, err)
	}
}

// assertCorruptRecoveryContract asserts the documented recovery behavior when
// migrateLabelsToPerProject encounters an unparseable / schema-mismatched legacy
// source (labels_registry.go recovery branch). Covers DEFER F5-Go items 1-5:
//  1. raw bytes preserved verbatim in BOTH the backup and the unassigned sink,
//  2. the legacy labels.json is removed,
//  3. the completion marker is present,
//  4. no error is returned (the recovery branch returns writeMigrationMarker,
//     which is nil on success),
//  5. NO per-project store is materialized from unparseable input.
func assertCorruptRecoveryContract(t *testing.T, raw []byte) {
	t.Helper()
	// 4. No panic / no error: the recovery branch returns writeMigrationMarker,
	//    which is nil on success.
	if err := migrateLabelsToPerProject(); err != nil {
		t.Fatalf("migrateLabelsToPerProject on corrupt source returned error: %v (contract: nil on recovery)", err)
	}
	base := stateBaseDir()
	// 1. Raw bytes preserved verbatim in BOTH the backup and the unassigned sink.
	backup, err := os.ReadFile(filepath.Join(base, labelsBackupFile))
	if err != nil {
		t.Fatalf("backup missing after corrupt-source recovery: %v", err)
	}
	if !bytes.Equal(backup, raw) {
		t.Fatalf("backup bytes diverged from source raw: got %q want %q", backup, raw)
	}
	unassigned, err := os.ReadFile(filepath.Join(base, labelsUnassignedFile))
	if err != nil {
		t.Fatalf("unassigned sink missing after corrupt-source recovery: %v", err)
	}
	if !bytes.Equal(unassigned, raw) {
		t.Fatalf("unassigned sink bytes diverged from source raw: got %q want %q", unassigned, raw)
	}
	// 2. Legacy file removed (single cutover).
	if _, err := os.Stat(filepath.Join(base, labelsLegacyFile)); err == nil {
		t.Fatalf("legacy labels.json still present after corrupt-source recovery")
	}
	// 3. Completion marker present.
	if _, err := os.Stat(migrationMarkerPath()); err != nil {
		t.Fatalf("completion marker missing after corrupt-source recovery: %v", err)
	}
	// 5. NO per-project store materialized from unparseable input. projects/ is
	//    absent unless the partition loop (never reached on this branch) wrote
	//    one; a missing dir reads as zero entries.
	if entries, _ := os.ReadDir(filepath.Join(base, "projects")); len(entries) != 0 {
		t.Fatalf("corrupt-source recovery wrote per-project stores from unparseable input: %v", entries)
	}
}

// TestLabelsMigration_UnparseableJSONSourcePreserved (DEFER F5-Go): a legacy
// labels.json whose bytes are not valid JSON cannot be partitioned safely. The
// recovery branch must preserve the raw bytes verbatim in BOTH the backup and
// the unassigned sink, remove the legacy file, write the marker, return nil,
// and write NO per-project store.
func TestLabelsMigration_UnparseableJSONSourcePreserved(t *testing.T) {
	t.Setenv("VH_STATE_DIR", t.TempDir())
	// Bytes that fail json.Unmarshal outright (recovery branch via err != nil).
	raw := []byte("{totally not valid json at all")
	seedLegacyLabelsRaw(t, raw)
	assertCorruptRecoveryContract(t, raw)
}

// TestLabelsMigration_SchemaMismatchedSourcePreserved (DEFER F5-Go): a legacy
// labels.json that PARSES as JSON but carries a foreign/unknown schemaVersion is
// treated identically to an unparseable one — the recovery branch keys on
// SchemaVersion != labelsSchemaVersion and preserves the raw bytes. This guards
// the second half of the branch predicate (which a pure garbage-JSON seed would
// not exercise).
func TestLabelsMigration_SchemaMismatchedSourcePreserved(t *testing.T) {
	t.Setenv("VH_STATE_DIR", t.TempDir())
	// Valid JSON object, but a schemaVersion this binary will never write.
	raw := []byte(`{"schemaVersion":999,"revision":3,"groups":[{"id":"g","name":"G","color":"blue","orderedRootSessionIds":["r1"]}],"tags":[],"tagIdsByRootSessionId":{}}`)
	// Sanity: the seed MUST parse as JSON (otherwise this collapses into the
	// unparseable case and stops exercising the schema-version predicate).
	var lf labelsFile
	if err := json.Unmarshal(raw, &lf); err != nil {
		t.Fatalf("schema-mismatch seed must be valid JSON: %v", err)
	}
	if lf.SchemaVersion == labelsSchemaVersion {
		t.Fatalf("schema-mismatch seed accidentally matches labelsSchemaVersion=%d", labelsSchemaVersion)
	}
	seedLegacyLabelsRaw(t, raw)
	assertCorruptRecoveryContract(t, raw)
}

// TestLabelsMigration_CorruptSourceIdempotent (DEFER F5-Go, item 6): re-running
// migration after a corrupt-source recovery is a no-op. The completion marker
// short-circuits the second run (step a), so the backup, the unassigned sink,
// and the marker are byte-stable and no per-project store materializes.
//
// It also simulates an interruption (removing the marker after recovery, with
// the legacy file already gone): the retry re-runs the recovery branch against
// the backup as the durable source and MUST leave the raw bytes preserved and
// still write no per-project store.
func TestLabelsMigration_CorruptSourceIdempotent(t *testing.T) {
	t.Setenv("VH_STATE_DIR", t.TempDir())
	raw := []byte("{totally not valid json at all")
	seedLegacyLabelsRaw(t, raw)

	// First run: recovery branch lands the backup + unassigned sink + marker.
	if err := migrateLabelsToPerProject(); err != nil {
		t.Fatalf("migrate #1: %v", err)
	}
	base := stateBaseDir()
	backupBefore, err := os.ReadFile(filepath.Join(base, labelsBackupFile))
	if err != nil {
		t.Fatalf("read backup after run #1: %v", err)
	}
	unassignedBefore, err := os.ReadFile(filepath.Join(base, labelsUnassignedFile))
	if err != nil {
		t.Fatalf("read unassigned after run #1: %v", err)
	}

	// Second run: marker present → must short-circuit (no re-do of any work).
	if err := migrateLabelsToPerProject(); err != nil {
		t.Fatalf("migrate #2 (marker present) returned error: %v (contract: nil)", err)
	}
	backupAfter, err := os.ReadFile(filepath.Join(base, labelsBackupFile))
	if err != nil {
		t.Fatalf("read backup after run #2: %v", err)
	}
	unassignedAfter, err := os.ReadFile(filepath.Join(base, labelsUnassignedFile))
	if err != nil {
		t.Fatalf("read unassigned after run #2: %v", err)
	}
	if !bytes.Equal(backupAfter, backupBefore) {
		t.Fatalf("marker-gated re-run rewrote backup: got %q want %q", backupAfter, backupBefore)
	}
	if !bytes.Equal(unassignedAfter, unassignedBefore) {
		t.Fatalf("marker-gated re-run rewrote unassigned sink: got %q want %q", unassignedAfter, unassignedBefore)
	}
	// Legacy still gone; no per-project store materialized.
	if _, err := os.Stat(filepath.Join(base, labelsLegacyFile)); err == nil {
		t.Fatalf("legacy labels.json re-appeared after marker-gated re-run")
	}
	if entries, _ := os.ReadDir(filepath.Join(base, "projects")); len(entries) != 0 {
		t.Fatalf("marker-gated re-run materialized per-project stores: %v", entries)
	}

	// Interruption simulation: drop the marker (legacy already gone; the backup
	// is the durable source). The retry re-runs the recovery branch against the
	// backup and MUST leave the raw bytes preserved + no per-project store.
	if err := os.Remove(migrationMarkerPath()); err != nil {
		t.Fatalf("remove marker (simulate interruption): %v", err)
	}
	if err := migrateLabelsToPerProject(); err != nil {
		t.Fatalf("migrate #3 (post-interruption): %v", err)
	}
	backupRetry, err := os.ReadFile(filepath.Join(base, labelsBackupFile))
	if err != nil {
		t.Fatalf("read backup after interruption retry: %v", err)
	}
	unassignedRetry, err := os.ReadFile(filepath.Join(base, labelsUnassignedFile))
	if err != nil {
		t.Fatalf("read unassigned after interruption retry: %v", err)
	}
	if !bytes.Equal(backupRetry, raw) {
		t.Fatalf("post-interruption retry altered backup: got %q want %q", backupRetry, raw)
	}
	if !bytes.Equal(unassignedRetry, raw) {
		t.Fatalf("post-interruption retry altered unassigned sink: got %q want %q", unassignedRetry, raw)
	}
	if _, err := os.Stat(migrationMarkerPath()); err != nil {
		t.Fatalf("marker not re-written after interruption recovery: %v", err)
	}
	if entries, _ := os.ReadDir(filepath.Join(base, "projects")); len(entries) != 0 {
		t.Fatalf("post-interruption retry materialized per-project stores: %v", entries)
	}
}
