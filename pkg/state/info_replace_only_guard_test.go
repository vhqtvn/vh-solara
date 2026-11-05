package state

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestMessageInfoReplaceOnlyConvention is the R1 STATIC standing-check. It
// clones the structure of TestPendingInputMutationExclusiveOwner
// (pending_input_mutation_test.go): os.ReadDir of this package's own
// directory, skip _test.go files, parser.ParseFile + ast.Inspect over every
// function body.
//
// The convention under guard is the one documented on the neverStartedRaw
// field (store.go, "Aliasing convention"): retain sites store the incoming
// body slice with NO defensive copy, so neverStartedRaw can share a backing
// array with me.info — and safety then rests on the REPLACE-ONLY convention
// for me.info: every write is a whole-slice replacement, never an in-place
// mutation. Any future in-place write to me.info while the alias exists would
// silently corrupt the revocation body.
//
// Forbidden shapes (any non-test source in this package):
//
//   - append(me.info, …) / append(me.neverStartedRaw, …) — ANY call to
//     append whose FIRST argument references either field. This covers the
//     x = append(x, …) self-assign form (extends the shared backing array in
//     place) and the filter-in-place idiom append(me.info[:0], …) — the
//     first-argument reference check is deliberately "anywhere in the first
//     argument", not "exactly the field", so both are caught.
//   - index writes me.info[i] = … / me.neverStartedRaw[i] = …
//   - copy(me.info, …) / copy(me.neverStartedRaw, …) — copy writes its
//     FIRST argument in place.
//
// Accepted shapes (asserted on synthetic sources by the companion
// TestMessageInfoReplaceOnlyConventionSynthetic, so the guard is provably
// non-vacuous and provably quiet on the legal forms):
//
//   - whole-slice assignment me.info = merged
//   - plain re-slicing me.info = me.info[:n]
//   - defensive copy me.info = append([]byte(nil), me.info...) — the field
//     is the variadic SOURCE, not the first argument.
//
// Honest limitation (documented, not hidden — the same class as the
// precedent's documented aliased-delete hole): this check detects DIRECT
// references spelled with the conventional messageEntry receiver `me`
// (me.info / me.neverStartedRaw — the spelling every current access uses).
// A renamed receiver or an alias (e := me; e.info[i] = 0, or b := me.info;
// b[i] = 0) escapes it. The behavioral tests around neverStartedRaw
// (never_started_test.go) remain the backstop for exercised aliased paths.
func TestMessageInfoReplaceOnlyConvention(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := filepath.Dir(thisFile)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read package dir %s: %v", dir, err)
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
		for _, v := range entryReplaceOnlyViolations(fset, f) {
			t.Error(v)
			bad++
		}
	}
	if bad > 0 {
		t.Fatalf("TestMessageInfoReplaceOnlyConvention: %d in-place write(s) to me.info/me.neverStartedRaw — the replace-only convention (store.go, neverStartedRaw aliasing) requires whole-slice replacement", bad)
	}
}

// TestMessageInfoReplaceOnlyConventionSynthetic pins the detector's
// classification on synthetic sources parsed straight from strings (no file
// reads, no mutation): the allowed shapes produce ZERO violations and each
// forbidden shape is caught. Without this companion, the standing check above
// could not distinguish "guard accepts the legal forms" from "guard never
// fires".
func TestMessageInfoReplaceOnlyConventionSynthetic(t *testing.T) {
	const allowedSrc = `package state

func allowedShapes(me *messageEntry, merged, raw, src, other []byte, i, n int) {
	me.info = merged                      // whole-slice assignment
	me.info = me.info[:n]                 // plain re-slicing (new header; no backing write)
	me.neverStartedRaw = raw              // whole-slice assignment (retain site form)
	me.neverStartedRaw = nil              // clear
	me.info = append([]byte(nil), me.info...)  // defensive copy: field is the SOURCE
	other = append(other, src...)              // append on an unrelated slice
	_ = copy(src, me.info)                     // copy reading FROM the field
	_ = i
}
`
	const forbiddenSrc = `package state

func forbiddenShapes(me *messageEntry, b, src []byte, i int) {
	me.info = append(me.info, b...)        // self-assign append (backing-array hazard)
	_ = append(me.neverStartedRaw, b...)   // bare append still writes the backing array
	me.info = append(me.info[:0], src...)  // filter-in-place idiom (first arg references the field)
	me.info[i] = b[0]                      // index write
	copy(me.info, src)                     // copy destination write
	_ = i
}
`

	fset := token.NewFileSet()
	allowed, err := parser.ParseFile(fset, "synthetic_allowed.go", allowedSrc, 0)
	if err != nil {
		t.Fatalf("parse synthetic allowed source: %v", err)
	}
	if vs := entryReplaceOnlyViolations(fset, allowed); len(vs) != 0 {
		t.Fatalf("allowed shapes must produce zero violations, got %d:\n%s", len(vs), strings.Join(vs, "\n"))
	}

	forbidden, err := parser.ParseFile(fset, "synthetic_forbidden.go", forbiddenSrc, 0)
	if err != nil {
		t.Fatalf("parse synthetic forbidden source: %v", err)
	}
	vs := entryReplaceOnlyViolations(fset, forbidden)
	if len(vs) != 5 {
		t.Fatalf("forbidden shapes must produce exactly 5 violations (one per shape), got %d:\n%s", len(vs), strings.Join(vs, "\n"))
	}
	joined := strings.Join(vs, "\n")
	for _, want := range []string{
		"append(me.info",            // self-assign append
		"append(me.neverStartedRaw", // bare append
		"append(me.info",            // filter-in-place (first-arg reference)
		"index write to me.info",    // index write
		"copy(me.info",              // copy destination
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("violation output missing expected shape %q:\n%s", want, joined)
		}
	}
}

// entryReplaceOnlyViolations returns one human-readable violation string per
// forbidden in-place write on me.info / me.neverStartedRaw found in f's
// function bodies. Shared by the package-walk standing check and the
// synthetic classification test.
func entryReplaceOnlyViolations(fset *token.FileSet, f *ast.File) []string {
	var out []string
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		fnName := fn.Name.Name
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			// Index writes: me.info[i] = … / me.neverStartedRaw[i] = …
			if as, ok := n.(*ast.AssignStmt); ok {
				for _, lhs := range as.Lhs {
					if _, isIndex := lhs.(*ast.IndexExpr); !isIndex {
						continue
					}
					if field, found := refsEntryByteSlice(lhs); found {
						pos := fset.Position(as.Pos())
						out = append(out, fmt.Sprintf("%s: index write to me.%s in %q — replace-only convention (store.go, neverStartedRaw aliasing) requires whole-slice assignment", pos, field, fnName))
					}
				}
			}
			// append(me.<field>, …) with the field as the first argument —
			// the self-assign AND bare-call AND filter-in-place forms all
			// write the existing backing array; copy(me.<field>, …) writes
			// its destination in place.
			if ce, ok := n.(*ast.CallExpr); ok {
				id, ok := ce.Fun.(*ast.Ident)
				if !ok || (id.Name != "append" && id.Name != "copy") || len(ce.Args) == 0 {
					return true
				}
				if field, found := refsEntryByteSlice(ce.Args[0]); found {
					pos := fset.Position(ce.Pos())
					out = append(out, fmt.Sprintf("%s: %s(me.%s, …) in %q — writes the backing array in place; replace-only convention (store.go, neverStartedRaw aliasing) requires whole-slice assignment", pos, id.Name, field, fnName))
				}
			}
			return true
		})
	}
	return out
}

// refsEntryByteSlice reports whether expr contains a SelectorExpr
// `me.info` / `me.neverStartedRaw` (the conventional messageEntry receiver
// spelling — see the limitation note on TestMessageInfoReplaceOnlyConvention).
func refsEntryByteSlice(expr ast.Expr) (field string, found bool) {
	ast.Inspect(expr, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		if id, ok := sel.X.(*ast.Ident); ok && id.Name == "me" && (sel.Sel.Name == "info" || sel.Sel.Name == "neverStartedRaw") {
			field = sel.Sel.Name
			found = true
		}
		return true
	})
	return field, found
}
