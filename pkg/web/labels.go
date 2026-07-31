package web

// Server-managed root-session labels (groups + tags) — Slice 1: the durable,
// worker-wide LabelStore, its on-disk schema, and full invariant validation.
//
// This slice implements ONLY the standalone store + its tests. There is no HTTP
// handler, no SSE/stream, no web/UI change, and no wiring into the Server struct
// (slices 2/3 do that). The store is path-agnostic: callers pass the on-disk
// path. Slice 2 will ground it at filepath.Join(stateBaseDir(), "labels.json").
//
// LABELS CLONE THE PIN SUBSYSTEM'S CONTRACT (pkg/web/pins.go):
//   - Worker-wide / daemon-level scope: one labels.json under stateBaseDir()
//     (same flat worker-global dir notes.go/pins.go use; no worker-id subpath).
//   - Atomic file persistence (temp → fsync → chmod → rename → dir fsync).
//   - Monotonic revision CAS: a caller reads Snapshot(), computes a new doc
//     against baseRevision = doc.Revision, and Replace succeeds only if the
//     on-disk revision is still baseRevision.
//   - Deep-copy snapshots so callers cannot mutate internal state.
//   - Self-healing cleanup (RemoveRootIDs) that drops stale root references
//     while PRESERVING group/tag definitions (so a future restore is possible).
//
// THE ONE DELIBERATE DIFFERENCE FROM PINS — the store enforces its invariants.
// PinStore.Replace normalizes silently and leaves semantic validation
// (anti-resurrection, dupes) to the HTTP layer. The label design (see the
// approved plan) requires the STORE to enforce every invariant — roots-only,
// exclusive groups, dangling tag refs, validated color tokens, name rules —
// because labels are structurally richer than a flat id list and the contract is
// cleaner when the authoritative store is the single validation chokepoint. The
// HTTP layer (slice 2) maps a store *LabelRejection to a 400 and a CAS mismatch
// (ok=false) to a 409.
//
// ROOTS-ONLY AUTHORITY (invariant #1): the store does NOT trust the client's
// claim that an id is a root. It validates every referenced root against the
// authoritative active-root inventory the caller passes (activeRootProjects),
// which slice 2 builds from pkg/state.Store.RootInventory() filtered to IsRoot
// (the strict parentID == "" definition). A root not in that map is rejected as
// unknown_root — unless it is RETAINED (already in the current server doc), in
// which case it skips re-validation, mirroring PinStore's anti-resurrection
// semantics so an archival race never makes a valid Replace spuriously fail
// (cleanup, not Replace, evicts archived roots).

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// --- v1 validation policy (single source of truth — slice 6 tunes here) -----
//
// All limits and the color palette live in this one block so a later slice can
// adjust them in one place. Names are trimmed before the empty/length checks;
// counts are hard caps (a Replace exceeding them is rejected, not silently
// truncated — silently dropping a group/tag DEFINITION would lose data).

const (
	// labelsSchemaVersion is the on-disk schema version this binary writes and
	// reads. NewLabelStore resets an unreadable or schema-mismatched file to a
	// zero doc rather than crashing, so a future bump is forward-compatible.
	labelsSchemaVersion = 1

	// maxGroups / maxTags cap the group and tag DEFINITION counts. Exceeding
	// either is a hard rejection (Replace returns *LabelRejection).
	maxGroups = 50
	maxTags   = 100

	// maxGroupNameLen / maxTagNameLen bound name length AFTER trimming.
	maxGroupNameLen = 64
	maxTagNameLen   = 64
)

// validColorTokens is the single source of truth for the semantic hue names a
// group/tag color may carry. Colors are validated MEMBERSHIP tokens, never
// arbitrary CSS (the SPA maps a token to a light/dark-respecting swatch). The
// starter set is intentionally small and clearly-named; slice 6 finalizes the
// exact tokens against verified light/dark contrast — edit ONLY here.
var validColorTokens = []string{
	"red", "orange", "amber", "green", "teal", "blue", "purple", "gray",
}

// validColorTokenSet is the O(1) lookup built once from validColorTokens.
var validColorTokenSet = func() map[string]bool {
	m := make(map[string]bool, len(validColorTokens))
	for _, t := range validColorTokens {
		m[t] = true
	}
	return m
}()

// --- public types (the wire shape; TS mirror lives in a later slice) --------

// LabelGroup is a browser-tab-group-style grouping of root sessions: a named,
// colored, foldable container. A root session is in AT MOST one group
// (exclusive-group invariant). OrderedRootSessionIDs is the persisted per-group
// root order (the order the user arranged); it is the SOLE membership set for
// this group (ProjectByRootSessionID is cleanup metadata, not a second
// membership authority — mirrors pins).
type LabelGroup struct {
	ID                    string   `json:"id"`
	Name                  string   `json:"name"`
	Color                 string   `json:"color"`
	Collapsed             bool     `json:"collapsed"`
	OrderedRootSessionIDs []string `json:"orderedRootSessionIds"`
}

// LabelTag is a free-form, worker-wide tag (a label chip). A root may carry
// many tags; tags are NOT exclusive. Tags and groups are SEPARATE namespaces —
// a group and a tag may share a name.
type LabelTag struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// LabelsDoc is the public, wire-facing shape: the authoritative groups, tags,
// per-root tag assignments, and the monotonic revision. This is what GET
// returns, PUT sends (minus Revision, which the server owns), and Snapshot
// yields. The private on-disk shape (labelsFile) adds schemaVersion and
// projectByRootSessionId.
type LabelsDoc struct {
	Revision              int64               `json:"revision"`
	Groups                []LabelGroup        `json:"groups"`
	Tags                  []LabelTag          `json:"tags"`
	TagIDsByRootSessionID map[string][]string `json:"tagIdsByRootSessionId"`
}

// labelsFile is the private persisted shape. It embeds LabelsDoc (so the public
// fields round-trip verbatim) and adds the schema version + the
// project-ownership sidecar (cleanup metadata only, mirroring pins'
// projectBySessionId). Persisted JSON field order, verified by the round-trip
// test: schemaVersion, revision, groups, tags, tagIdsByRootSessionId,
// projectByRootSessionId (the embedded LabelsDoc fields promote at the embed
// position, between schemaVersion and projectByRootSessionId).
type labelsFile struct {
	SchemaVersion int `json:"schemaVersion"`
	LabelsDoc         // embedded; Revision/Groups/Tags/TagIDsByRootSessionID promote
	// ProjectByRootSessionID records which project each referenced root belongs
	// to (projectKey(projectRoot(dir)) — the SAME sha1-of-abs-cwd key pkg/web/
	// notes.go and pins.go use). omitempty so a fresh doc with no roots persists
	// without the key; a nil map is normalized to empty on load. It is NEVER a
	// membership authority — only OrderedRootSessionIDs (per group) and the
	// TagIDsByRootSessionID keys are.
	ProjectByRootSessionID map[string]string `json:"projectByRootSessionId,omitempty"`
}

// --- rejection type (the store's invariant-violation signal) ----------------

// LabelRejectionReason is a machine-readable short code carried by
// LabelRejection. Stable across versions so a client can parse and react
// (e.g. drop offending roots in one bounded retry). Slice 2's HTTP layer maps
// each to a 400 body.
type LabelRejectionReason string

const (
	LabelRejectionTooManyGroups        LabelRejectionReason = "too_many_groups"
	LabelRejectionTooManyTags          LabelRejectionReason = "too_many_tags"
	LabelRejectionEmptyGroupID         LabelRejectionReason = "empty_group_id"
	LabelRejectionDuplicateGroupID     LabelRejectionReason = "duplicate_group_id"
	LabelRejectionEmptyGroupName       LabelRejectionReason = "empty_group_name"
	LabelRejectionGroupNameTooLong     LabelRejectionReason = "group_name_too_long"
	LabelRejectionDuplicateGroupName   LabelRejectionReason = "duplicate_group_name"
	LabelRejectionBadGroupColor        LabelRejectionReason = "bad_group_color"
	LabelRejectionEmptyTagID           LabelRejectionReason = "empty_tag_id"
	LabelRejectionDuplicateTagID       LabelRejectionReason = "duplicate_tag_id"
	LabelRejectionEmptyTagName         LabelRejectionReason = "empty_tag_name"
	LabelRejectionTagNameTooLong       LabelRejectionReason = "tag_name_too_long"
	LabelRejectionDuplicateTagName     LabelRejectionReason = "duplicate_tag_name"
	LabelRejectionBadTagColor          LabelRejectionReason = "bad_tag_color"
	LabelRejectionDuplicateRootInGroup LabelRejectionReason = "duplicate_root_in_group"
	LabelRejectionExclusiveGroup       LabelRejectionReason = "exclusive_group_violation"
	LabelRejectionDanglingTagRef       LabelRejectionReason = "dangling_tag_ref"
	LabelRejectionUnknownRoot          LabelRejectionReason = "unknown_root"
)

// LabelRejection is returned by LabelStore.Replace when the candidate doc
// violates a store invariant. It is DISTINCT from a CAS mismatch (Replace
// returns ok=false, err=nil for that) and from a persist failure (err != nil,
// non-*LabelRejection). Slice 2 type-asserts via IsLabelRejection to map it to
// a 400; a CAS mismatch maps to 409; any other error maps to 500.
type LabelRejection struct {
	Reason LabelRejectionReason
	Detail string
	// IDs carries the offending group/tag/root ids that triggered the rejection,
	// for a machine-readable 400 body. Empty when not applicable.
	IDs []string
}

func (e *LabelRejection) Error() string {
	if len(e.IDs) > 0 {
		return fmt.Sprintf("labels: %s: %s [%s]", e.Reason, e.Detail, strings.Join(e.IDs, ","))
	}
	return fmt.Sprintf("labels: %s: %s", e.Reason, e.Detail)
}

// IsLabelRejection reports whether err is a store-invariant rejection (as
// opposed to a CAS mismatch, which yields err==nil, or a persist failure, which
// yields a non-rejection error).
func IsLabelRejection(err error) bool {
	var r *LabelRejection
	return errors.As(err, &r)
}

// --- the store --------------------------------------------------------------

// LabelStore owns the worker-wide labels doc: a mutex, the on-disk path, and
// the in-memory labelsFile copy. All mutations persist the new state atomically
// before returning, so a successful response is always durable (mirrors
// PinStore and queue.go).
type LabelStore struct {
	mu   sync.Mutex
	path string
	doc  labelsFile
}

// zeroLabelsFile returns a fresh zero doc: schema 1, revision 0, empty groups,
// empty tags, empty tag map, empty project sidecar. Used on missing-file load
// and on corrupt/schema-mismatch reset. It never touches disk.
func zeroLabelsFile() labelsFile {
	return labelsFile{
		SchemaVersion:          labelsSchemaVersion,
		LabelsDoc:              LabelsDoc{Groups: []LabelGroup{}, Tags: []LabelTag{}, TagIDsByRootSessionID: map[string][]string{}},
		ProjectByRootSessionID: map[string]string{},
	}
}

// NewLabelStore loads (or initializes) the label store at path.
//
//   - Missing file: returns a store holding a zero doc WITHOUT writing (the
//     file is created lazily on the first successful mutation).
//   - Present + valid (schemaVersion == 1): unmarshals into the store, with
//     nil-slice/nil-map normalization so callers never observe nil.
//   - Corrupt JSON or schemaVersion != 1: resets to a zero doc IN MEMORY and
//     returns (store, nil) — never panics, never deletes/rewrites the on-disk
//     file on read (the operator can inspect the bad file). A subsequent
//     successful Replace overwrites it atomically.
//   - Any other read error (permission, etc.): returned to the caller.
func NewLabelStore(path string) (*LabelStore, error) {
	st := &LabelStore{path: path}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			st.doc = zeroLabelsFile()
			return st, nil
		}
		return nil, fmt.Errorf("labels: read %s: %w", path, err)
	}
	var lf labelsFile
	if err := json.Unmarshal(data, &lf); err != nil {
		// Corrupt → zero doc in memory, on-disk file left intact.
		st.doc = zeroLabelsFile()
		return st, nil
	}
	if lf.SchemaVersion != labelsSchemaVersion {
		// Schema mismatch → zero doc in memory, on-disk file left intact.
		st.doc = zeroLabelsFile()
		return st, nil
	}
	// Normalize so callers and the wire shape never see nil slice/map.
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
	st.doc = lf
	return st, nil
}

// Snapshot returns a thread-safe DEEP copy of the public doc. Callers may
// mutate the returned Groups / OrderedRootSessionIDs / Tags / TagIDsByRootSessionID
// freely without affecting the store — every slice and map, including the
// nested per-root tag slices, is copied. (ProjectByRootSessionID is private
// cleanup metadata and is NOT exposed here.)
func (s *LabelStore) Snapshot() LabelsDoc {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshotPublicLocked()
}

// Replace applies a compare-and-swap replacement of the WHOLE labels doc.
//
// baseRevision is the CAS guard: if it != the current on-disk revision the call
// returns (false, currentSnapshot, nil) without mutating. The candidate is
// validated + normalized BEFORE the CAS check, so a structurally invalid doc
// yields a *LabelRejection regardless of any revision race (clearer than hiding
// a malformed doc behind a 409).
//
// activeRootProjects is the authoritative active-ROOT inventory (root id →
// project key) the caller built from pkg/state.Store.RootInventory() filtered to
// IsRoot. Every NEWLY-referenced root (one not already retained in the current
// server doc) must be a key in this map or the candidate is rejected
// (unknown_root) — this is invariant #1 (roots-only), enforced by the store
// against the authoritative inventory, not trusted from the client. Retained
// roots skip re-validation (mirror of PinStore anti-resurrection) so an archival
// race never makes a valid Replace spuriously fail; cleanup evicts archived
// roots instead.
//
// Validation enforces every invariant (see validateLabelsDoc). On success the
// new doc is normalized, ProjectByRootSessionID is rebuilt for exactly the
// retained+newly-introduced referenced roots (carry-over from the prior doc for
// known roots, activeRootProjects[id] for new roots, "" if absent — a missing
// lookup never blocks), Revision is incremented, the new doc is persisted
// atomically, and the new public snapshot is returned.
//
// On persist failure the in-memory doc is NOT mutated (the candidate was built
// separately and only assigned after a successful save), so the store stays
// consistent with disk. Returns (false, currentSnapshot, err).
func (s *LabelStore) Replace(baseRevision int64, next LabelsDoc, activeRootProjects map[string]string) (ok bool, current LabelsDoc, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// 1. Validate + normalize BEFORE CAS. A malformed doc is always a clear
	//    rejection; a valid-but-stale doc falls through to the CAS check.
	retainedRoots := referencedRootsInLabelsDoc(s.doc.LabelsDoc)
	normalized, rej := validateLabelsDoc(next, retainedRoots, activeRootProjects)
	if rej != nil {
		return false, s.snapshotPublicLocked(), rej
	}

	// 2. CAS guard.
	if baseRevision != s.doc.Revision {
		return false, s.snapshotPublicLocked(), nil
	}

	// 3. Rebuild ProjectByRootSessionID for exactly the referenced roots.
	//    Carry over prior values for known roots; for newly-introduced roots
	//    record what activeRootProjects knows ("" if absent — never block).
	referenced := referencedRootsInLabelsDoc(normalized)
	oldProjects := s.doc.ProjectByRootSessionID
	newProjects := make(map[string]string, len(referenced))
	for id := range referenced {
		if pk, ok := oldProjects[id]; ok {
			newProjects[id] = pk
			continue
		}
		// Indexing a nil activeRootProjects is safe (returns "").
		newProjects[id] = activeRootProjects[id]
	}

	// 4. Build candidate (Revision is server-owned; next.Revision ignored).
	//    Deep-copy the normalized doc into fresh, store-owned collections so a
	//    caller that mutates its input doc AFTER Replace returns cannot drift
	//    the store's in-memory state (no CAS bump, no re-validation, no disk
	//    write). Mirrors PinStore's normalizeOrderLocked defensive allocation
	//    and the read-side copy in snapshotPublicLocked.
	owned := cloneLabelsDoc(normalized)
	candidate := labelsFile{
		SchemaVersion: labelsSchemaVersion,
		LabelsDoc: LabelsDoc{
			Revision:              s.doc.Revision + 1,
			Groups:                owned.Groups,
			Tags:                  owned.Tags,
			TagIDsByRootSessionID: owned.TagIDsByRootSessionID,
		},
		ProjectByRootSessionID: newProjects,
	}
	if err := s.persistLocked(candidate); err != nil {
		// s.doc untouched (candidate was never assigned) → consistent with disk.
		return false, s.snapshotPublicLocked(), err
	}
	s.doc = candidate
	return true, s.snapshotPublicLocked(), nil
}

// RemoveRootIDs is the self-healing cleanup primitive: it drops every given
// root id from ALL group OrderedRootSessionIDs lists, drops its
// TagIDsByRootSessionID entry, and drops its ProjectByRootSessionID entry —
// while PRESERVING every group/tag DEFINITION (invariant #7: definitions
// survive even when their assignments are gone, so a future restore is
// possible). This is the direct analogue of PinStore.RemoveIDs and is driven by
// the lifecycle layers (slice 3) on archive/delete.
//
// Idempotent: if none of the ids are referenced anywhere, it returns
// (false, snapshot, nil) WITHOUT bumping Revision or touching disk. Otherwise
// Revision is incremented and the new doc is persisted atomically. On persist
// failure the in-memory doc is NOT mutated. Returns (false, snapshot, err).
func (s *LabelStore) RemoveRootIDs(idsToRemove []string) (changed bool, current LabelsDoc, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	remove := make(map[string]bool, len(idsToRemove))
	for _, id := range idsToRemove {
		if id == "" {
			continue
		}
		remove[id] = true
	}
	if len(remove) == 0 {
		return false, s.snapshotPublicLocked(), nil
	}

	// Detect whether any target is actually referenced; if not, this is a no-op.
	referenced := referencedRootsInLabelsDoc(s.doc.LabelsDoc)
	present := false
	for id := range remove {
		if referenced[id] {
			present = true
			break
		}
	}
	if !present {
		return false, s.snapshotPublicLocked(), nil
	}

	// Strip from every group's root list (keep the group definition).
	newGroups := make([]LabelGroup, len(s.doc.Groups))
	for i, g := range s.doc.Groups {
		list := make([]string, 0, len(g.OrderedRootSessionIDs))
		for _, rid := range g.OrderedRootSessionIDs {
			if !remove[rid] {
				list = append(list, rid)
			}
		}
		newGroups[i] = g
		newGroups[i].OrderedRootSessionIDs = list
	}
	// Strip tag assignments + project sidecar for removed roots; keep all
	// others verbatim (definitions untouched).
	newTagAssign := make(map[string][]string, len(s.doc.TagIDsByRootSessionID))
	for rid, tags := range s.doc.TagIDsByRootSessionID {
		if remove[rid] {
			continue
		}
		// Copy the per-root tag slice so the candidate owns no store memory.
		cp := make([]string, len(tags))
		copy(cp, tags)
		newTagAssign[rid] = cp
	}
	newProjects := make(map[string]string, len(s.doc.ProjectByRootSessionID))
	for rid, pk := range s.doc.ProjectByRootSessionID {
		if remove[rid] {
			continue
		}
		newProjects[rid] = pk
	}

	candidate := labelsFile{
		SchemaVersion: labelsSchemaVersion,
		LabelsDoc: LabelsDoc{
			Revision:              s.doc.Revision + 1,
			Groups:                newGroups,
			Tags:                  s.doc.Tags, // definitions preserved
			TagIDsByRootSessionID: newTagAssign,
		},
		ProjectByRootSessionID: newProjects,
	}
	if err := s.persistLocked(candidate); err != nil {
		return false, s.snapshotPublicLocked(), err
	}
	s.doc = candidate
	return true, s.snapshotPublicLocked(), nil
}

// --- validation + normalization --------------------------------------------

// validateLabelsDoc validates and normalizes a candidate LabelsDoc against the
// store invariants. It returns the normalized doc (with nils replaced by empty
// collections, names trimmed, empty root refs dropped from group lists, empty
// tag-assignment keys dropped, and per-root tag lists deduped) and a
// *LabelRejection describing the first violated invariant (nil if the doc is
// valid). Pure function over its inputs.
//
// retainedRoots is the set of root ids already present in the current server
// doc; a referenced root that is retained skips the unknown_root check (mirror
// of PinStore anti-resurrection). activeRootProjects is the authoritative
// active-root inventory; a NON-retained referenced root must be a key in it.
func validateLabelsDoc(next LabelsDoc, retainedRoots map[string]bool, activeRootProjects map[string]string) (LabelsDoc, *LabelRejection) {
	// --- normalize nils ---
	if next.Groups == nil {
		next.Groups = []LabelGroup{}
	}
	if next.Tags == nil {
		next.Tags = []LabelTag{}
	}
	if next.TagIDsByRootSessionID == nil {
		next.TagIDsByRootSessionID = map[string][]string{}
	}

	// --- groups: count, ids, names (trimmed/unique-ci), colors ---
	if len(next.Groups) > maxGroups {
		return next, &LabelRejection{
			Reason: LabelRejectionTooManyGroups,
			Detail: fmt.Sprintf("group count %d exceeds cap %d", len(next.Groups), maxGroups),
		}
	}
	seenGroupIDs := make(map[string]bool, len(next.Groups))
	seenGroupNames := make(map[string]bool, len(next.Groups))
	for i := range next.Groups {
		g := &next.Groups[i]
		if g.ID == "" {
			return next, &LabelRejection{Reason: LabelRejectionEmptyGroupID, Detail: "group id is empty"}
		}
		if seenGroupIDs[g.ID] {
			return next, &LabelRejection{Reason: LabelRejectionDuplicateGroupID, Detail: "duplicate group id " + g.ID, IDs: []string{g.ID}}
		}
		seenGroupIDs[g.ID] = true

		g.Name = strings.TrimSpace(g.Name)
		if g.Name == "" {
			return next, &LabelRejection{Reason: LabelRejectionEmptyGroupName, Detail: "group " + g.ID + " name is empty", IDs: []string{g.ID}}
		}
		if len(g.Name) > maxGroupNameLen {
			return next, &LabelRejection{Reason: LabelRejectionGroupNameTooLong, Detail: fmt.Sprintf("group %s name length %d exceeds %d", g.ID, len(g.Name), maxGroupNameLen), IDs: []string{g.ID}}
		}
		lname := strings.ToLower(g.Name)
		if seenGroupNames[lname] {
			return next, &LabelRejection{Reason: LabelRejectionDuplicateGroupName, Detail: "duplicate group name (case-insensitive) " + g.Name, IDs: []string{g.ID}}
		}
		seenGroupNames[lname] = true

		if !validColorTokenSet[g.Color] {
			return next, &LabelRejection{Reason: LabelRejectionBadGroupColor, Detail: "group " + g.ID + " color " + g.Color + " is not a valid token", IDs: []string{g.ID}}
		}
	}

	// --- tags: count, ids, names (trimmed/unique-ci), colors ---
	if len(next.Tags) > maxTags {
		return next, &LabelRejection{
			Reason: LabelRejectionTooManyTags,
			Detail: fmt.Sprintf("tag count %d exceeds cap %d", len(next.Tags), maxTags),
		}
	}
	tagExists := make(map[string]bool, len(next.Tags))
	seenTagNames := make(map[string]bool, len(next.Tags))
	for i := range next.Tags {
		tg := &next.Tags[i]
		if tg.ID == "" {
			return next, &LabelRejection{Reason: LabelRejectionEmptyTagID, Detail: "tag id is empty"}
		}
		if tagExists[tg.ID] {
			return next, &LabelRejection{Reason: LabelRejectionDuplicateTagID, Detail: "duplicate tag id " + tg.ID, IDs: []string{tg.ID}}
		}
		tagExists[tg.ID] = true

		tg.Name = strings.TrimSpace(tg.Name)
		if tg.Name == "" {
			return next, &LabelRejection{Reason: LabelRejectionEmptyTagName, Detail: "tag " + tg.ID + " name is empty", IDs: []string{tg.ID}}
		}
		if len(tg.Name) > maxTagNameLen {
			return next, &LabelRejection{Reason: LabelRejectionTagNameTooLong, Detail: fmt.Sprintf("tag %s name length %d exceeds %d", tg.ID, len(tg.Name), maxTagNameLen), IDs: []string{tg.ID}}
		}
		lname := strings.ToLower(tg.Name)
		if seenTagNames[lname] {
			return next, &LabelRejection{Reason: LabelRejectionDuplicateTagName, Detail: "duplicate tag name (case-insensitive) " + tg.Name, IDs: []string{tg.ID}}
		}
		seenTagNames[lname] = true

		if !validColorTokenSet[tg.Color] {
			return next, &LabelRejection{Reason: LabelRejectionBadTagColor, Detail: "tag " + tg.ID + " color " + tg.Color + " is not a valid token", IDs: []string{tg.ID}}
		}
	}

	// --- exclusive groups + per-list dedupe (invariant #2) ---
	// A root may be in at most one group and at most once within that group's
	// list. Empty root refs are dropped silently (normalization, mirroring
	// PinStore's empty-drop); genuine duplicates are rejected.
	rootOwner := make(map[string]string) // root id -> owning group id
	for i := range next.Groups {
		g := &next.Groups[i]
		cleaned := make([]string, 0, len(g.OrderedRootSessionIDs))
		seenInList := make(map[string]bool, len(g.OrderedRootSessionIDs))
		for _, rid := range g.OrderedRootSessionIDs {
			if rid == "" {
				continue // silent empty-drop
			}
			if seenInList[rid] {
				return next, &LabelRejection{Reason: LabelRejectionDuplicateRootInGroup, Detail: "root " + rid + " appears more than once in group " + g.ID + " ordered list", IDs: []string{rid, g.ID}}
			}
			seenInList[rid] = true
			if owner, ok := rootOwner[rid]; ok {
				return next, &LabelRejection{Reason: LabelRejectionExclusiveGroup, Detail: "root " + rid + " is in group " + owner + " and group " + g.ID + " (groups are exclusive)", IDs: []string{rid, owner, g.ID}}
			}
			rootOwner[rid] = g.ID
			cleaned = append(cleaned, rid)
		}
		g.OrderedRootSessionIDs = cleaned
	}

	// --- tag assignments: drop empty keys, dedupe per-root, dangling refs ---
	for rid, tags := range next.TagIDsByRootSessionID {
		if rid == "" {
			// Drop the empty key. Cannot delete while ranging; mark and sweep.
			// Use a sentinel-free sweep: collect non-empty keys below.
			continue
		}
		deduped := make([]string, 0, len(tags))
		seenTag := make(map[string]bool, len(tags))
		for _, tid := range tags {
			if tid == "" {
				continue // silent empty-drop
			}
			if seenTag[tid] {
				continue // tags are not exclusive; a dupe is noise — dedupe silently
			}
			seenTag[tid] = true
			if !tagExists[tid] {
				return next, &LabelRejection{Reason: LabelRejectionDanglingTagRef, Detail: "root " + rid + " references unknown tag " + tid, IDs: []string{rid, tid}}
			}
			deduped = append(deduped, tid)
		}
		next.TagIDsByRootSessionID[rid] = deduped
	}
	// Sweep empty tag-assignment keys (cannot delete during range above).
	for rid := range next.TagIDsByRootSessionID {
		if rid == "" {
			delete(next.TagIDsByRootSessionID, "")
		}
	}

	// --- roots-only (invariant #1), retained-skip (anti-resurrection mirror) ---
	// Every referenced root (group lists ∪ tag-assignment keys) that is NOT
	// retained must be a key in the authoritative active-root inventory.
	referenced := referencedRootsInLabelsDoc(next)
	var unknown []string
	for rid := range referenced {
		if retainedRoots[rid] {
			continue // retained → skip re-validation (archival race safety)
		}
		if _, ok := activeRootProjects[rid]; !ok {
			unknown = append(unknown, rid)
		}
	}
	if len(unknown) > 0 {
		return next, &LabelRejection{
			Reason: LabelRejectionUnknownRoot,
			Detail: "referenced root(s) are not active roots (parentID must be empty): not in the authoritative active-root inventory",
			IDs:    unknown,
		}
	}

	return next, nil
}

// referencedRootsInLabelsDoc returns the set of root ids referenced anywhere in
// the doc (the union of every group's OrderedRootSessionIDs and every
// TagIDsByRootSessionID key). Pure function; allocates a fresh map each call.
func referencedRootsInLabelsDoc(doc LabelsDoc) map[string]bool {
	out := make(map[string]bool)
	for _, g := range doc.Groups {
		for _, rid := range g.OrderedRootSessionIDs {
			if rid != "" {
				out[rid] = true
			}
		}
	}
	for rid := range doc.TagIDsByRootSessionID {
		if rid != "" {
			out[rid] = true
		}
	}
	return out
}

// --- snapshot + persist (mirrors PinStore, with honest "labels:" prefixes) ---

// cloneLabelsDoc returns a deep copy of doc: a fresh Groups slice (each
// LabelGroup copied, each OrderedRootSessionIDs re-allocated), a fresh Tags
// slice, and a fresh TagIDsByRootSessionID map (each per-root tag slice
// re-allocated). Replace uses it to isolate the persisted candidate from the
// caller's input doc so post-Replace caller mutation cannot drift in-memory
// store state — the write-side twin of snapshotPublicLocked's read-side copy.
// Pure function over its input.
func cloneLabelsDoc(doc LabelsDoc) LabelsDoc {
	out := LabelsDoc{
		Revision:              doc.Revision,
		Groups:                make([]LabelGroup, len(doc.Groups)),
		Tags:                  make([]LabelTag, len(doc.Tags)),
		TagIDsByRootSessionID: make(map[string][]string, len(doc.TagIDsByRootSessionID)),
	}
	for i, g := range doc.Groups {
		out.Groups[i] = g
		list := make([]string, len(g.OrderedRootSessionIDs))
		copy(list, g.OrderedRootSessionIDs)
		out.Groups[i].OrderedRootSessionIDs = list
	}
	copy(out.Tags, doc.Tags)
	for rid, tags := range doc.TagIDsByRootSessionID {
		cp := make([]string, len(tags))
		copy(cp, tags)
		out.TagIDsByRootSessionID[rid] = cp
	}
	return out
}

// snapshotPublicLocked returns a DEEP copy of the public LabelsDoc projection of
// s.doc. Caller MUST hold s.mu. Every slice and map — including the nested
// per-root tag slices — is copied so a caller can mutate the result without
// affecting the store.
func (s *LabelStore) snapshotPublicLocked() LabelsDoc {
	out := LabelsDoc{
		Revision:              s.doc.Revision,
		Groups:                make([]LabelGroup, len(s.doc.Groups)),
		Tags:                  make([]LabelTag, len(s.doc.Tags)),
		TagIDsByRootSessionID: make(map[string][]string, len(s.doc.TagIDsByRootSessionID)),
	}
	for i, g := range s.doc.Groups {
		out.Groups[i] = g
		list := make([]string, len(g.OrderedRootSessionIDs))
		copy(list, g.OrderedRootSessionIDs)
		out.Groups[i].OrderedRootSessionIDs = list
	}
	copy(out.Tags, s.doc.Tags)
	for rid, tags := range s.doc.TagIDsByRootSessionID {
		cp := make([]string, len(tags))
		copy(cp, tags)
		out.TagIDsByRootSessionID[rid] = cp
	}
	return out
}

// persistLocked writes doc atomically to s.path: marshal → ensure parent dir
// (0o700) → temp file in the same dir → write → fsync → chmod → rename →
// best-effort dir fsync. Mirrors writePinsAtomic / writeQueueAtomic. The rename
// is atomic on POSIX, so a crash at any earlier point leaves the previous path
// byte-intact (at worst the temp lingers, and every error branch after temp
// creation removes it). Caller MUST hold s.mu (serializes concurrent persists).
func (s *LabelStore) persistLocked(doc labelsFile) error {
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return fmt.Errorf("labels: encode %s: %w", s.path, err)
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("labels: mkdir %s: %w", dir, err)
	}
	return writeLabelsAtomic(s.path, data, 0o644)
}

// writeLabelsAtomic writes data to path atomically: temp file in the same dir →
// write → fsync → chmod → rename → best-effort dir fsync. On POSIX the rename is
// atomic, so a crash at any earlier point leaves the previous path byte-intact
// (at worst the temp lingers). Mirrors writePinsAtomic in pins.go / writeQueueAtomic
// in queue.go; duplicated rather than reused so labels diagnostics carry honest
// "labels:" prefixes and so a future queue.go/pins.go refactor cannot silently
// change labels persistence.
func writeLabelsAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	base := filepath.Base(path)
	tmp, err := os.CreateTemp(dir, "."+base+".tmp-*")
	if err != nil {
		return fmt.Errorf("labels: atomic write %s: create temp: %w", path, err)
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("labels: atomic write %s: write temp: %w", path, err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("labels: atomic write %s: fsync temp: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("labels: atomic write %s: close temp: %w", path, err)
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		cleanup()
		return fmt.Errorf("labels: atomic write %s: chmod temp: %w", path, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		cleanup()
		return fmt.Errorf("labels: atomic write %s: rename: %w", path, err)
	}
	syncLabelsDirBestEffort(dir)
	return nil
}

// syncLabelsDirBestEffort fsyncs dir, ignoring all errors (tmpfs/network FS may
// not support dir fsync; this is durability, not correctness).
func syncLabelsDirBestEffort(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	defer d.Close()
	_ = d.Sync()
}
