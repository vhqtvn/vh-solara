package version

import (
	"strings"
	"testing"
)

// TestParse pins the clean-semver shape: v-prefix tolerated, prerelease
// tolerated, everything else (dev/test/garbage/empty/make's "+dev" stamp)
// unparseable — which the predicates turn into the fail-open ALLOW.
func TestParse(t *testing.T) {
	for _, tc := range []struct {
		in    string
		ok    bool
		major int
		minor int
		patch int
		pre   string
		note  string
	}{
		{"1.67.0", true, 1, 67, 0, "", "bare release"},
		{"v1.67.0", true, 1, 67, 0, "", "v-prefixed release"},
		{"0.1.0", true, 0, 1, 0, "", "fielded old worker"},
		{"1.68.0-rc.1", true, 1, 68, 0, "rc.1", "prerelease"},
		{"1.0.0-beta.2", true, 1, 0, 0, "beta.2", "prerelease"},
		{" 1.67.0 ", true, 1, 67, 0, "", "surrounding whitespace trimmed"},
		{"dev", false, 0, 0, 0, "", "plain go build"},
		{"test", false, 0, 0, 0, "", "harness versions"},
		{"v1.66.3+dev", false, 0, 0, 0, "", "make dev stamp — must NOT parse as 1.66.3"},
		{"1.67.0+dev", false, 0, 0, 0, "", "make dev stamp at floor"},
		{"", false, 0, 0, 0, "", "missing header"},
		{"banana", false, 0, 0, 0, "", "garbage"},
		{"1.2", false, 0, 0, 0, "", "two components"},
		{"vh-solara 1.67.0", false, 0, 0, 0, "", "prefixed string — anchored regex must reject"},
	} {
		v, ok := Parse(tc.in)
		if ok != tc.ok {
			t.Errorf("Parse(%q): ok = %v, want %v (%s)", tc.in, ok, tc.ok, tc.note)
			continue
		}
		if !ok {
			continue
		}
		if v.Major != tc.major || v.Minor != tc.minor || v.Patch != tc.patch || v.Pre != tc.pre {
			t.Errorf("Parse(%q) = %d.%d.%d-%q, want %d.%d.%d-%q",
				tc.in, v.Major, v.Minor, v.Patch, v.Pre, tc.major, tc.minor, tc.patch, tc.pre)
		}
	}
}

// TestCompare covers the semver precedence matrix the boundary relies on.
func TestCompare(t *testing.T) {
	// Each pair must satisfy a.Compare(b) == want AND b.Compare(a) == -want.
	for _, tc := range []struct {
		a, b string
		want int
		note string
	}{
		{"1.67.0", "1.67.0", 0, "equal"},
		{"v1.67.0", "1.67.0", 0, "v-prefix irrelevant"},
		{"1.68.0", "1.67.0", 1, "patch-level gt"},
		{"1.67.1", "1.67.0", 1, "patch gt"},
		{"2.0.0", "1.67.0", 1, "major gt"},
		{"1.66.9", "1.67.0", -1, "below floor"},
		{"0.1.0", "1.67.0", -1, "old fielded worker"},
		{"1.67.0-rc.1", "1.67.0", -1, "prerelease < release"},
		{"1.68.0-rc.1", "1.67.0", 1, "higher core with prerelease still gt floor"},
		{"1.0.0-beta.2", "1.0.0-beta.11", -1, "numeric identifiers compare numerically"},
		{"1.0.0-alpha", "1.0.0-beta", -1, "lexical identifiers"},
		{"1.0.0-alpha", "1.0.0-alpha.1", -1, "shorter equal-prefix list first"},
		{"1.0.0-2", "1.0.0-beta", -1, "numeric before non-numeric"},
		{"1.0.0-beta", "1.0.0-2", 1, "non-numeric after numeric"},
	} {
		va, oka := Parse(tc.a)
		vb, okb := Parse(tc.b)
		if !oka || !okb {
			t.Fatalf("fixture versions must be clean: %q/%q", tc.a, tc.b)
		}
		if got := va.Compare(vb); got != tc.want {
			t.Errorf("Compare(%q, %q) = %d, want %d (%s)", tc.a, tc.b, got, tc.want, tc.note)
		}
		if got := vb.Compare(va); got != -tc.want {
			t.Errorf("Compare(%q, %q) = %d, want %d (antisymmetry, %s)", tc.b, tc.a, got, -tc.want, tc.note)
		}
	}
}

// TestWorkerAllowed pins the controller-side predicate: missing ⇒ refuse,
// below-floor clean ⇒ refuse, at/above floor ⇒ allow, dev shapes ⇒ allow.
func TestWorkerAllowed(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want bool
		note string
	}{
		{"", false, "no header = pre-boundary worker"},
		{"0.1.0", false, "old fielded worker, clean and below floor"},
		{"1.66.9", false, "just below floor"},
		{"1.67.0", true, "at floor"},
		{"1.67.0-rc.1", false, "prerelease of the floor sorts below it"},
		{"1.68.0", true, "above floor"},
		{"v2.0.0", true, "v-prefixed release"},
		{"dev", true, "plain go build"},
		{"test", true, "harness version"},
		{"v1.66.3+dev", true, "make dev stamp — fail-open"},
		{"garbage", true, "garbage — fail-open"},
	} {
		if got := WorkerAllowed(tc.in); got != tc.want {
			t.Errorf("WorkerAllowed(%q) = %v, want %v (%s)", tc.in, got, tc.want, tc.note)
		}
	}
}

// TestControllerAllowed pins the worker-side predicate (same shape, floor
// constant must be clean and equal to MinControllerVersion).
func TestControllerAllowed(t *testing.T) {
	if _, ok := Parse(MinControllerVersion); !ok {
		t.Fatalf("MinControllerVersion %q is not a clean semver", MinControllerVersion)
	}
	if _, ok := Parse(MinWorkerVersion); !ok {
		t.Fatalf("MinWorkerVersion %q is not a clean semver", MinWorkerVersion)
	}
	for _, tc := range []struct {
		in   string
		want bool
		note string
	}{
		{"", false, "absent header = pre-boundary controller"},
		{"0.1.0", false, "old controller"},
		{"1.66.0", false, "below floor"},
		{"1.67.0", true, "at floor"},
		{"1.68.1", true, "above floor"},
		{"dev", true, "dev controller"},
		{"v1.67.0+dev", true, "make dev stamp"},
	} {
		if got := ControllerAllowed(tc.in); got != tc.want {
			t.Errorf("ControllerAllowed(%q) = %v, want %v (%s)", tc.in, got, tc.want, tc.note)
		}
	}
}

// TestRefusalReasons pins that the operator-facing prose names the floor and
// the upgrade requirement, and is empty exactly when allowed.
func TestRefusalReasons(t *testing.T) {
	r := WorkerRefusalReason("")
	if r == "" || !contains(r, MinWorkerVersion) {
		t.Errorf("WorkerRefusalReason(\"\") must name the floor %q, got %q", MinWorkerVersion, r)
	}
	r = WorkerRefusalReason("0.1.0")
	if r == "" || !contains(r, "0.1.0") || !contains(r, MinWorkerVersion) {
		t.Errorf("WorkerRefusalReason(\"0.1.0\") must name the version and floor, got %q", r)
	}
	if r := WorkerRefusalReason("1.67.0"); r != "" {
		t.Errorf("WorkerRefusalReason at floor must be empty, got %q", r)
	}
	if r := WorkerRefusalReason("dev"); r != "" {
		t.Errorf("WorkerRefusalReason(dev) must be empty, got %q", r)
	}

	r = ControllerRefusalReason("")
	if r == "" || !contains(r, HeaderControllerVersion) || !contains(r, MinControllerVersion) {
		t.Errorf("ControllerRefusalReason(\"\") must name the header and floor, got %q", r)
	}
	r = ControllerRefusalReason("1.2.3")
	if r == "" || !contains(r, "1.2.3") || !contains(r, MinControllerVersion) {
		t.Errorf("ControllerRefusalReason(\"1.2.3\") must name the version and floor, got %q", r)
	}
	if r := ControllerRefusalReason("1.67.0"); r != "" {
		t.Errorf("ControllerRefusalReason at floor must be empty, got %q", r)
	}
	if r := ControllerRefusalReason("test"); r != "" {
		t.Errorf("ControllerRefusalReason(test) must be empty, got %q", r)
	}
}

func contains(s, sub string) bool {
	return strings.Contains(s, sub)
}
