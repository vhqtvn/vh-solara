// Package version implements the fail-safe controller/worker version
// boundary for the tunnel WebSocket dial (worker → controller, endpoint
// /vh-solara/ws).
//
// DELIBERATE INVERSION OF THE REPO'S VERSION-MIX PRECEDENTS. This repository
// has two established precedents for mixed worker/controller versions, both
// graceful-degradation designs:
//
//   - permessage-deflate negotiation (Q4c): compression activates only when
//     BOTH endpoints offer it, so any version mix simply stays uncompressed;
//   - lean-gates acquisition (fit WAN tunnels): the controller falls back to
//     full /vh/gates acquisition when a worker doesn't speak the lean path.
//
// The version boundary intentionally INVERTS both: a mixed incompatible pair
// must NOT connect at all. The controller refuses too-old / header-less
// workers before the WS upgrade; the worker refuses controllers that don't
// advertise a sufficient version and keeps retrying (the existing reconnect
// loop). There is NO legacy compatibility path. This is an operator
// directive with a controller-first rollout (fleet-status program, slice 1).
//
// Fail-open posture for non-release builds: a version string that is not a
// clean `MAJOR.MINOR.PATCH[-pre]` (optionally "v"-prefixed) — e.g. "dev",
// "test", or the Makefile's "<last-tag>+dev" stamp — is ALLOWED on both
// sides. The operator deploys locally-built untagged binaries reporting
// "dev"; refusing them would break their own deployment. Note this also
// covers make-built checkouts in the window before the floor tag exists:
// their stamp carries a "+dev" suffix and is therefore treated as a dev
// build, never as a below-floor release. A clean parseable version BELOW the
// floor (e.g. the fielded "0.1.0" workers) is refused; old fielded workers
// send no version headers at all and are refused at the header check first.
//
// This is a coordination fence, not authentication: the registration secret
// (X-VH-Worker-Secret) remains the auth boundary. Both sides must derive
// their floors from THIS package so they cannot drift apart.
package version

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Dial/response header names for the boundary. The worker sends the first
// two on its WS dial; the controller sets the third on the 101 upgrade
// response (its absence in a dial response identifies a pre-boundary
// controller).
const (
	HeaderWorkerVersion     = "X-VH-Worker-Version"
	HeaderMinController     = "X-VH-Min-Controller"
	HeaderControllerVersion = "X-VH-Controller-Version"
)

// Version floors. Semantics: "must speak this protocol" — the floor is the
// first release carrying the boundary, not a feature level. Both are the
// designated next tag (releases are tag-driven; cmd.Version is ldflags-
// stamped and there is no in-repo version constant). Bump BOTH together with
// the protocol change they guard; the two constants may diverge only when
// the two sides' protocols genuinely diverge.
//
// RELEASE CONTRACT (fleet-status S1, followsups-brief family 1): the first
// tag that ships this package must ALSO ship the fleet-selection gate
// fields (pkg/state GateFacts.FleetSelected + the fleet_selection marker on
// /vh/gates and /vh/snapshot envelopes), and the floors above must EQUAL
// that first shipping tag. A floor-satisfying but field-less worker (the
// tag lands without the fields, or below 1.67.0) passes the tunnel boundary
// yet fails the controller's acquisition-side vocabulary check on every
// refresh (worker `error`, never a healthy empty fold). Rule: ship both
// under ONE tag, or bump both floors in the same release commit that
// changes the selection vocabulary. Operator release checklist lives at
// docs/architecture/03-stateful-aggregator.md → "GET /vh/gates".
const (
	MinWorkerVersion     = "1.67.0"
	MinControllerVersion = "1.67.0"
)

// cleanVerRe matches a FULL string of the shape v?MAJOR.MINOR.PATCH with an
// optional "-prerelease". Deliberately ANCHORED (unlike cmd/opencode_update
// .go's extract-anywhere semverRe): a Makefile dev stamp like
// "v1.66.3+dev" must NOT parse as a clean 1.66.3 (it would be refused as
// below-floor even though the binary carries the boundary code) — the "+dev"
// suffix keeps it in the fail-open dev-build bucket. Anything that doesn't
// match whole (dev, test, garbage) is treated as a dev build and allowed.
var cleanVerRe = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$`)

// Version is a parsed clean semver. Pre is the raw pre-release string (""
// for a release); build metadata is rejected at parse time (see cleanVerRe).
type Version struct {
	Major, Minor, Patch int
	Pre                 string
}

// Parse parses a clean semver. ok is false for anything else ("" included) —
// callers decide what an unparseable version means (here: dev build ⇒ allow).
func Parse(v string) (Version, bool) {
	m := cleanVerRe.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		return Version{}, false
	}
	ver := Version{Pre: m[4]}
	// Regex guarantees numeric; Atoi can't fail.
	ver.Major, _ = strconv.Atoi(m[1])
	ver.Minor, _ = strconv.Atoi(m[2])
	ver.Patch, _ = strconv.Atoi(m[3])
	return ver, true
}

// Compare orders two clean versions per semver precedence: numeric core
// component-by-component, then pre-release rules (a pre-release sorts BEFORE
// its release; numeric identifiers compare numerically and before
// non-numeric; otherwise lexical; a shorter equal-prefix identifier list
// sorts first). Returns -1, 0, or +1. Callers must only pass versions
// obtained from Parse (the boundary predicates do; nothing else calls this).
// Pattern extracted from cmd/opencode_update.go's compareSemver family.
func (v Version) Compare(o Version) int {
	if c := cmpInt(v.Major, o.Major); c != 0 {
		return c
	}
	if c := cmpInt(v.Minor, o.Minor); c != 0 {
		return c
	}
	if c := cmpInt(v.Patch, o.Patch); c != 0 {
		return c
	}
	// Same core: no pre-release > any pre-release.
	switch {
	case v.Pre == "" && o.Pre != "":
		return 1
	case v.Pre != "" && o.Pre == "":
		return -1
	case v.Pre == o.Pre:
		return 0
	}
	return cmpPreRelease(v.Pre, o.Pre)
}

// cmpPreRelease compares dot-separated pre-release identifier lists per
// semver precedence.
func cmpPreRelease(a, b string) int {
	as := strings.Split(a, ".")
	bs := strings.Split(b, ".")
	n := len(as)
	if len(bs) < n {
		n = len(bs)
	}
	for i := 0; i < n; i++ {
		an, aErr := strconv.Atoi(as[i])
		bn, bErr := strconv.Atoi(bs[i])
		switch {
		case aErr == nil && bErr == nil:
			if c := cmpInt(an, bn); c != 0 {
				return c
			}
		case aErr == nil:
			return -1 // numeric identifiers sort before non-numeric
		case bErr == nil:
			return 1
		default:
			if c := strings.Compare(as[i], bs[i]); c != 0 {
				return c
			}
		}
	}
	return cmpInt(len(as), len(bs)) // shorter equal-prefix list sorts first
}

func cmpInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// allowed is the shared fail-safe predicate. Empty (= header absent on the
// wire) means a pre-boundary build ⇒ REFUSE. Unparseable non-empty means a
// dev build ⇒ ALLOW (fail-open; see the package doc). A clean version must
// be >= floor.
func allowed(v, floor string) bool {
	if v == "" {
		return false
	}
	ver, ok := Parse(v)
	if !ok {
		return true // dev/test/"+dev"-stamped build — operator's own binaries
	}
	fl, _ := Parse(floor) // floors are package constants; always clean
	return ver.Compare(fl) >= 0
}

// WorkerAllowed reports whether a worker's advertised version satisfies the
// controller's MinWorkerVersion floor.
func WorkerAllowed(workerVersion string) bool {
	return allowed(workerVersion, MinWorkerVersion)
}

// ControllerAllowed reports whether a controller's advertised version
// satisfies the worker's MinControllerVersion floor.
func ControllerAllowed(controllerVersion string) bool {
	return allowed(controllerVersion, MinControllerVersion)
}

// WorkerRefusalReason returns the human-readable reason a worker version is
// refused by the controller ("" when allowed). One source for the HTTP error
// body and both sides' logs, so the floor and the upgrade ask can't drift.
func WorkerRefusalReason(workerVersion string) string {
	switch {
	case WorkerAllowed(workerVersion):
		return ""
	case workerVersion == "":
		return fmt.Sprintf(
			"worker sent no %s header (vh-solara older than %s); upgrade the vh-solara worker binary to >= %s and reconnect",
			HeaderWorkerVersion, MinWorkerVersion, MinWorkerVersion)
	default:
		return fmt.Sprintf(
			"worker version %s is below the controller minimum %s; upgrade the vh-solara worker binary to >= %s and reconnect",
			workerVersion, MinWorkerVersion, MinWorkerVersion)
	}
}

// ControllerRefusalReason returns the human-readable reason a controller
// version is refused by the worker ("" when allowed).
func ControllerRefusalReason(controllerVersion string) string {
	switch {
	case ControllerAllowed(controllerVersion):
		return ""
	case controllerVersion == "":
		return fmt.Sprintf(
			"controller did not advertise %s (vh-solara older than %s); upgrade the vh-solara controller to >= %s",
			HeaderControllerVersion, MinControllerVersion, MinControllerVersion)
	default:
		return fmt.Sprintf(
			"controller version %s is below the worker minimum %s; upgrade the vh-solara controller to >= %s",
			controllerVersion, MinControllerVersion, MinControllerVersion)
	}
}
