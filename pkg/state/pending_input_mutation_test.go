package state

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// This file is the M2/L-06 standing-check bundle (remediation brief §M2 paired
// check + writer-map §5). It pins the EXCLUSIVE-OWNER invariant for the
// pending-input subtree index: ONE helper family owns all production writes to
// s.perms / s.questions affecting pending input, so the subtreePendingInput
// index can no longer be left stale by a forgotten delta call.
//
// Two checks, each catching a distinct failure mode:
//
//   - TestPendingInputMutationMaintainsSubtreeIndex — BEHAVIORAL. Drives every
//     pending-input mutation path (live events + reconcile entrypoints + phantom
//     deferred-seed) and asserts the incremental subtreePendingInput index
//     equals an independent O(n) recompute after every step. Catches an
//     INCORRECT delta inside the owner helper.
//   - TestPendingInputMutationExclusiveOwner — STATIC (AST). Asserts every
//     direct production write to s.perms / s.questions occurs inside the four
//     owner helpers or the exempted deleteSessionLocked teardown. Catches a
//     future BYPASS site (a new direct write outside the owners).
//
// Together they close the L-06 class: the index can no longer depend on a
// caller remembering a separate post-mutation repair call, AND a new direct
// write site is a compile/test-time failure rather than a stale-index bug.

// assertPendingEquals is a focused check that pins both the incremental index
// value for a node AND the reference agreement, with a precise failure message.
func assertPendingEquals(t *testing.T, s *Store, id string, want int, trace string) {
	t.Helper()
	s.mu.RLock()
	got := s.subtreePendingInput[id]
	s.mu.RUnlock()
	if got != want {
		t.Fatalf("[%s] subtreePendingInput[%s]=%d, want %d", trace, id, got, want)
	}
	if d := subtreePendingInputDiff(s); d != "" {
		t.Fatalf("[%s] subtreePendingInput diverged from reference recompute: %s\n%s", trace, d, dumpTreeIndexes(s))
	}
}

// TestPendingInputMutationMaintainsSubtreeIndex is the M2/L-06 behavioral
// standing-check. It exercises the exclusive-owner helper family through every
// pending-input mutation shape and asserts the subtreePendingInput index stays
// exactly correct (self + ancestor deltas) at every step, matching an
// independent O(n) recompute.
//
// Covered shapes (per remediation-brief §M2 detector spec):
//   - permission set and delete (live + reconcile),
//   - question set and delete (live + reconcile),
//   - reconciliation replacement (SetPendingPermissions / SetPendingQuestions),
//   - transitions from pending to non-pending and back,
//   - ancestor subtree deltas (child flip propagates to parent + root),
//   - phantom / not-yet-materialized session behavior (deferred seed on create
//     and on Hydrate direct-assign).
//
// It would FAIL if a raw mutation could bypass subtree index maintenance: the
// reference comparison is computed from the live maps, so any mutation that
// changes a session's own contribution without adjusting the index surfaces as
// a differential failure.
func TestPendingInputMutationMaintainsSubtreeIndex(t *testing.T) {
	// --- tree: R → A → C (root / mid / leaf) so ancestor deltas are observable ---
	newTree := func() *Store {
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("R", "")))
		s.Apply(ev("session.created", evSessionCreated("A", "R")))
		s.Apply(ev("session.created", evSessionCreated("C", "A")))
		assertPendingEquals(t, s, "R", 0, "seed")
		return s
	}

	t.Run("permission_set_flips_leaf_and_ancestors", func(t *testing.T) {
		s := newTree()
		s.Apply(ev("permission.asked", evPermissionAsked("C", "p1")))
		// self(C)=1 → +1 up the chain: C, A, R all see their subtree sum rise.
		assertPendingEquals(t, s, "C", 1, "perm set on C: self")
		assertPendingEquals(t, s, "A", 1, "perm set on C: parent A")
		assertPendingEquals(t, s, "R", 1, "perm set on C: root R")
	})

	t.Run("permission_replied_clears_back_to_zero", func(t *testing.T) {
		s := newTree()
		s.Apply(ev("permission.asked", evPermissionAsked("C", "p1")))
		s.Apply(ev("permission.replied", evPermissionReplied("C", "p1")))
		// self(C)=0 → -1 down the chain; every entry returns to 0.
		assertPendingEquals(t, s, "C", 0, "perm replied on C: self")
		assertPendingEquals(t, s, "A", 0, "perm replied on C: parent A")
		assertPendingEquals(t, s, "R", 0, "perm replied on C: root R")
	})

	t.Run("question_set_and_clear", func(t *testing.T) {
		s := newTree()
		s.Apply(ev("question.asked", evQuestionAsked("C", "q1")))
		assertPendingEquals(t, s, "C", 1, "question set on C: self")
		assertPendingEquals(t, s, "A", 1, "question set on C: parent A")
		assertPendingEquals(t, s, "R", 1, "question set on C: root R")
		s.Apply(ev("question.replied", evQuestionReplied("C", "q1")))
		assertPendingEquals(t, s, "C", 0, "question replied on C: self")
		assertPendingEquals(t, s, "A", 0, "question replied on C: parent A")
		assertPendingEquals(t, s, "R", 0, "question replied on C: root R")
	})

	t.Run("pending_to_nonpending_to_back_via_perm_then_question", func(t *testing.T) {
		// The brief's "pending → non-pending → back" transition. Adding a
		// question while a permission is already pending is a NO-FLIP (self
		// stays 1); clearing the permission is also a NO-FLIP (question still
		// pending); clearing the question finally flips to 0. This proves the
		// delta is resolved from the COMBINED perms+questions contribution,
		// not either map alone.
		s := newTree()
		s.Apply(ev("permission.asked", evPermissionAsked("C", "p1")))
		assertPendingEquals(t, s, "C", 1, "perm only")
		s.Apply(ev("question.asked", evQuestionAsked("C", "q1")))
		assertPendingEquals(t, s, "C", 1, "perm+question (no flip)")
		assertPendingEquals(t, s, "R", 1, "perm+question root (no flip)")
		s.Apply(ev("permission.replied", evPermissionReplied("C", "p1")))
		assertPendingEquals(t, s, "C", 1, "perm cleared, question still pending (no flip)")
		assertPendingEquals(t, s, "R", 1, "perm cleared root (no flip)")
		s.Apply(ev("question.replied", evQuestionReplied("C", "q1")))
		assertPendingEquals(t, s, "C", 0, "question cleared → finally non-pending")
		assertPendingEquals(t, s, "R", 0, "question cleared root → finally 0")
		// And back to pending.
		s.Apply(ev("permission.asked", evPermissionAsked("C", "p1")))
		assertPendingEquals(t, s, "C", 1, "re-pending via perm")
		assertPendingEquals(t, s, "R", 1, "re-pending root")
	})

	t.Run("reconcile_replacement_permissions", func(t *testing.T) {
		// SetPendingPermissions performs exact-set reconciliation: incoming
		// requests are added, requests no longer present are dropped, each via
		// the owner helper. Net contribution must equal the new set's size-clamp
		// (0/1 per session regardless of how many perms/questions are pending).
		s := newTree()
		// Seed C with two permissions via the live path.
		s.Apply(ev("permission.asked", evPermissionAsked("C", "p1")))
		s.Apply(ev("permission.asked", evPermissionAsked("C", "p2")))
		assertPendingEquals(t, s, "C", 1, "two perms, self still 1 (0/1 clamp)")
		// Reconcile to exactly {p3} — drops p1,p2, adds p3. Net self unchanged
		// (still pending), so no ancestor delta should fire, but the index must
		// stay exact through three separate owner-helper calls.
		s.SetPendingPermissions([]json.RawMessage{
			json.RawMessage(evPermissionAsked("C", "p3")),
		})
		assertPendingEquals(t, s, "C", 1, "reconcile to {p3}: still pending")
		assertPendingEquals(t, s, "R", 1, "reconcile to {p3}: root still 1")
		// Reconcile to empty — drops p3, contribution finally flips to 0.
		s.SetPendingPermissions(nil)
		assertPendingEquals(t, s, "C", 0, "reconcile to empty: non-pending")
		assertPendingEquals(t, s, "R", 0, "reconcile to empty: root 0")
	})

	t.Run("reconcile_replacement_questions", func(t *testing.T) {
		s := newTree()
		s.SetPendingQuestions([]json.RawMessage{
			json.RawMessage(evQuestionAsked("C", "q1")),
			json.RawMessage(evQuestionAsked("A", "q2")),
		})
		// C and A both pending → subtree sums: C=1, A=1(self)+1(C)=2, R=2.
		assertPendingEquals(t, s, "C", 1, "reconcile questions: C self")
		assertPendingEquals(t, s, "A", 2, "reconcile questions: A subtree (self + C)")
		assertPendingEquals(t, s, "R", 2, "reconcile questions: R subtree (A + C)")
		// Drop A's question only — A self flips 1→0, subtree A drops to 1 (C).
		s.SetPendingQuestions([]json.RawMessage{
			json.RawMessage(evQuestionAsked("C", "q1")),
		})
		assertPendingEquals(t, s, "A", 1, "drop A's question: A subtree back to 1 (C)")
		assertPendingEquals(t, s, "R", 1, "drop A's question: R back to 1")
	})

	t.Run("ancestor_subtree_delta_two_children", func(t *testing.T) {
		// Two leaves under A: C and D. Each pending leaf adds 1 to A and R.
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("R", "")))
		s.Apply(ev("session.created", evSessionCreated("A", "R")))
		s.Apply(ev("session.created", evSessionCreated("C", "A")))
		s.Apply(ev("session.created", evSessionCreated("D", "A")))
		s.Apply(ev("permission.asked", evPermissionAsked("C", "p1")))
		assertPendingEquals(t, s, "A", 1, "C pending")
		assertPendingEquals(t, s, "R", 1, "C pending root")
		s.Apply(ev("question.asked", evQuestionAsked("D", "q1")))
		assertPendingEquals(t, s, "A", 2, "C+D pending")
		assertPendingEquals(t, s, "R", 2, "C+D pending root")
		s.Apply(ev("permission.replied", evPermissionReplied("C", "p1")))
		assertPendingEquals(t, s, "A", 1, "C cleared, D pending")
		s.Apply(ev("question.replied", evQuestionReplied("D", "q1")))
		assertPendingEquals(t, s, "A", 0, "both cleared")
		assertPendingEquals(t, s, "R", 0, "both cleared root")
	})

	t.Run("phantom_perm_deferred_then_seeded_on_create", func(t *testing.T) {
		// A permission event arrives BEFORE session.created (missed ordering /
		// daemon restart). The owner helper writes the map but the phantom
		// guard defers the index delta; on later session.created the upsert
		// seed records the contribution.
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("R", "")))
		s.Apply(ev("session.created", evSessionCreated("A", "R")))
		// Ghost perm before "ghost" exists.
		s.Apply(ev("permission.asked", evPermissionAsked("ghost", "p1")))
		// Map write happened, but the index is untouched (phantom).
		s.mu.RLock()
		permEntry := s.perms["ghost"]["p1"]
		idxGhost := s.subtreePendingInput["ghost"]
		idxA := s.subtreePendingInput["A"]
		s.mu.RUnlock()
		if permEntry == nil {
			t.Fatalf("phantom perm: map write must still happen, got nil entry")
		}
		if idxGhost != 0 {
			t.Fatalf("phantom perm: subtreePendingInput[ghost]=%d, want 0 (deferred)", idxGhost)
		}
		if idxA != 0 {
			t.Fatalf("phantom perm: subtreePendingInput[A]=%d, want 0 (no ancestor delta while phantom)", idxA)
		}
		// Now materialize ghost as a child of A. The upsert seed must record
		// the deferred contribution (self(ghost)=1) and propagate up to A and R.
		s.Apply(ev("session.created", evSessionCreated("ghost", "A")))
		assertPendingEquals(t, s, "ghost", 1, "phantom resolved on create: self seeded")
		assertPendingEquals(t, s, "A", 1, "phantom resolved on create: parent A seeded")
		assertPendingEquals(t, s, "R", 1, "phantom resolved on create: root R seeded")
		// Clearing via the owner helper now does a real delta (-1).
		s.Apply(ev("permission.replied", evPermissionReplied("ghost", "p1")))
		assertPendingEquals(t, s, "ghost", 0, "post-materialize clear: self 0")
		assertPendingEquals(t, s, "R", 0, "post-materialize clear: root 0")
	})

	t.Run("phantom_perm_deferred_then_seeded_on_hydrate", func(t *testing.T) {
		// Hydrate assigns s.sessions directly (bypassing upsertSessionLocked),
		// so it maintains the pending index itself. A phantom perm before
		// Hydrate must seed on the Hydrate direct-assign path.
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("R", "")))
		s.Apply(ev("permission.asked", evPermissionAsked("ghost", "p1")))
		// ghost is still phantom here.
		s.Hydrate([]json.RawMessage{
			json.RawMessage(`{"id":"R"}`),
			json.RawMessage(`{"id":"ghost","parentID":"R","title":"g"}`),
		}, nil)
		assertPendingEquals(t, s, "ghost", 1, "phantom resolved on hydrate: self seeded")
		assertPendingEquals(t, s, "R", 1, "phantom resolved on hydrate: root seeded")
	})

	t.Run("delete_session_zeroes_subtree_contribution", func(t *testing.T) {
		// The exempted teardown path (deleteSessionLocked) zeroes the deleted
		// node's whole-subtree contribution via maintainIndexesOnDeleteLocked
		// (whole-sum, NOT the owner-helper delta). Verify it stays correct.
		s := newTree()
		s.Apply(ev("permission.asked", evPermissionAsked("C", "p1")))
		s.Apply(ev("question.asked", evQuestionAsked("A", "q1")))
		// A subtree = self(A:q1) + C:p1 = 2; R = 2.
		assertPendingEquals(t, s, "A", 2, "before delete C: A subtree")
		assertPendingEquals(t, s, "R", 2, "before delete C: R subtree")
		// Delete C: its contribution (1) leaves A and R.
		s.Apply(ev("session.deleted", `{"info":{"id":"C"}}`))
		assertPendingEquals(t, s, "A", 1, "after delete C: A subtree (only self q1)")
		assertPendingEquals(t, s, "R", 1, "after delete C: R subtree")
		// Delete A: remaining contribution leaves R.
		s.Apply(ev("session.deleted", `{"info":{"id":"A"}}`))
		assertPendingEquals(t, s, "R", 0, "after delete A: R empty")
	})

	t.Run("wire_projection_reads_pending_input_flag", func(t *testing.T) {
		// Locks the tree_emitter.go reader retarget (M2 step: pendingInputSelf
		// removed → buildNodeLocked + isActiveLocked re-derive via
		// pendingInputSelfLocked). The PendingInput / SubtreeNeedsInput flags
		// must reflect a fresh perm set with no shadow lag.
		s := newTree()
		e := NewTreeEmitter(s, "/proj")
		_ = e.SnapshotFrontier("cold")
		// Before: no pending input on C.
		n, ok := e.buildNodeLocked("C", true)
		if !ok {
			t.Fatalf("buildNodeLocked(C) not found")
		}
		if n.Flags.PendingInput || n.Flags.SubtreeNeedsInput {
			t.Fatalf("before perm: C flags = %+v, want no pending input", n.Flags)
		}
		// Set a permission; flags must flip on C (self) and propagate to R.
		s.Apply(ev("permission.asked", evPermissionAsked("C", "p1")))
		nC, _ := e.buildNodeLocked("C", true)
		if !nC.Flags.PendingInput {
			t.Fatalf("after perm: C.PendingInput=false, want true (retargeted reader)")
		}
		if !nC.Flags.Permission {
			t.Fatalf("after perm: C.Permission=false, want true")
		}
		nR, _ := e.buildNodeLocked("R", true)
		if !nR.Flags.SubtreeNeedsInput {
			t.Fatalf("after perm on C: R.SubtreeNeedsInput=false, want true (ancestor delta)")
		}
		// isActiveLocked must also see C as active (retargeted second reader).
		if !isActiveLocked(s, "C") {
			t.Fatalf("isActiveLocked(C)=false after perm, want true (retargeted reader)")
		}
	})
}

// TestPendingInputMutationExclusiveOwner is the M2/L-06 STATIC standing-check.
// It walks every non-test .go file in this package with go/ast and asserts that
// every DIRECT production write to s.perms / s.questions — an assignment whose
// LHS references s.perms/s.questions, or a delete() whose first argument
// references s.perms/s.questions — is inside one of the allowed functions:
//
//   - setPermissionLocked / clearPermissionLocked / setQuestionLocked /
//     clearQuestionLocked — the four EXCLUSIVE owners (M2 helper family).
//   - deleteSessionLocked — the EXEMPTED teardown site (whole-session removal
//     whose index maintenance is whole-sum zeroing via
//     maintainIndexesOnDeleteLocked, NOT a per-entry delta; routing it through
//     the owner helpers would be wrong).
//
// What this catches: a future author adding `s.perms[x] = v`, `s.questions[x]
// = v`, `delete(s.perms, x)`, or `delete(s.questions, x)` anywhere outside the
// allowed functions — the most likely bypass patterns — makes this test fail.
//
// Honest limitation (documented, not hidden): this AST check detects DIRECT
// references to s.perms / s.questions. It does NOT detect an ALIASED delete of
// the form `m := s.perms[x]; delete(m, y)` (the local `m` hides the link). The
// clear* owner helpers deliberately use that aliased form for the nil-guarded
// single-lookup delete; it is the OWNED internal detail and is covered by the
// behavioral test instead. A bypass using the same aliased pattern outside the
// owners would not be caught here, but the behavioral test would surface the
// resulting stale index for any exercised path.
func TestPendingInputMutationExclusiveOwner(t *testing.T) {
	// Structural assertion: the retired shadow field is gone. If it returns,
	// the M2 exclusive-owner model regressed (the helper captures wasPending
	// itself, so no shadow is needed).
	if _, ok := reflect.TypeOf(Store{}).FieldByName("pendingInputSelf"); ok {
		t.Fatal("Store.pendingInputSelf must not exist: M2/L-06 retired the old-self shadow (the owner helper captures wasPending itself)")
	}

	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := filepath.Dir(thisFile)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read package dir %s: %v", dir, err)
	}

	allowed := map[string]string{
		"setPermissionLocked":   "exclusive owner (permission set)",
		"clearPermissionLocked": "exclusive owner (permission clear)",
		"setQuestionLocked":     "exclusive owner (question set)",
		"clearQuestionLocked":   "exclusive owner (question clear)",
		"deleteSessionLocked":   "exempted teardown (whole-sum zeroing, not delta)",
	}

	fset := token.NewFileSet()
	var bad int
	for _, ent := range entries {
		name := ent.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		path := filepath.Join(dir, name)
		f, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			fnName := fn.Name.Name
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				// Assignment whose LHS references s.perms / s.questions.
				if as, ok := n.(*ast.AssignStmt); ok {
					for _, lhs := range as.Lhs {
						if refsStoreMap(lhs, "perms") || refsStoreMap(lhs, "questions") {
							if _, allowed_ := allowed[fnName]; !allowed_ {
								pos := fset.Position(as.Pos())
								t.Errorf("%s: direct write to s.perms/s.questions in %q — must route through the exclusive owner (setPermissionLocked/clearPermissionLocked/setQuestionLocked/clearQuestionLocked) or be the exempted deleteSessionLocked teardown", pos, fnName)
								bad++
							}
						}
					}
				}
				// delete() whose first argument references s.perms / s.questions.
				if ce, ok := n.(*ast.CallExpr); ok {
					if id, ok := ce.Fun.(*ast.Ident); ok && id.Name == "delete" && len(ce.Args) > 0 {
						if refsStoreMap(ce.Args[0], "perms") || refsStoreMap(ce.Args[0], "questions") {
							if _, allowed_ := allowed[fnName]; !allowed_ {
								pos := fset.Position(ce.Pos())
								t.Errorf("%s: direct delete of s.perms/s.questions in %q — must route through the exclusive owner or be the exempted deleteSessionLocked teardown", pos, fnName)
								bad++
							}
						}
					}
				}
				return true
			})
		}
	}
	if bad > 0 {
		t.Fatalf("TestPendingInputMutationExclusiveOwner: %d direct production write(s) to s.perms/s.questions outside the exclusive owner helpers + exempted teardown", bad)
	}
}

// refsStoreMap reports whether expr contains a SelectorExpr `s.<field>` (the
// receiver Store accessing one of its perms/questions maps). Used by the static
// check to detect direct writes/deletes referencing those maps.
func refsStoreMap(expr ast.Expr, field string) bool {
	found := false
	ast.Inspect(expr, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		if id, ok := sel.X.(*ast.Ident); ok && id.Name == "s" && sel.Sel.Name == field {
			found = true
		}
		return true
	})
	return found
}
