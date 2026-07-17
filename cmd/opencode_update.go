package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/web"
)

var semverRe = regexp.MustCompile(`v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)`)

// Running-version tracking: the version of the live `opencode serve` process,
// captured each time we (re)start it. Distinct from the on-disk installed
// version, which an update advances without touching the running process.
var (
	ocRunningMu  sync.Mutex
	ocRunningVer string
)

// setOpenCodeRunningVersion records the version of the just-(re)started serve.
func setOpenCodeRunningVersion(v string) {
	ocRunningMu.Lock()
	ocRunningVer = v
	ocRunningMu.Unlock()
}

// openCodeRunningVersion returns the last-captured running version.
func openCodeRunningVersion() string {
	ocRunningMu.Lock()
	defer ocRunningMu.Unlock()
	return ocRunningVer
}

func normVer(s string) string {
	if m := semverRe.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return ""
}

// opencodeCurrentVersion runs `<bin> --version` in OpenCode's environment.
func opencodeCurrentVersion(ctx context.Context, bin, cwd string) string {
	if bin == "" {
		bin = "opencode"
	}
	c := exec.CommandContext(ctx, bin, "--version")
	c.Env = os.Environ()
	c.Dir = cwd
	out, err := c.Output()
	if err != nil {
		return ""
	}
	return normVer(string(out))
}

// opencodeLatestVersion queries the npm registry for the latest opencode-ai.
// Best-effort: returns "" on any failure (the update can still be triggered).
func opencodeLatestVersion(ctx context.Context) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://registry.npmjs.org/opencode-ai/latest", nil)
	if err != nil {
		return ""
	}
	cl := &http.Client{Timeout: 10 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	var v struct {
		Version string `json:"version"`
	}
	if json.NewDecoder(resp.Body).Decode(&v) != nil {
		return ""
	}
	return normVer(v.Version)
}

// runOpencodeUpdate updates OpenCode in its own environment (so an nvm/PATH
// wrapper is honoured): the default is `<bin> upgrade`, overridable with a
// custom shell command (--opencode-update-cmd). Output streams to w (and the
// daemon log) so the UI can show the install log live. It does NOT restart
// OpenCode — that's a separate, explicit step.
func runOpencodeUpdate(ctx context.Context, bin, customCmd, cwd string, w io.Writer) error {
	if bin == "" {
		bin = "opencode"
	}
	out := io.MultiWriter(w, os.Stdout) // stream to client AND keep the server log
	cmdStr := strings.TrimSpace(customCmd)
	if cmdStr == "" {
		cmdStr = bin + " upgrade"
	}
	fmt.Fprintf(out, "[vh] running: %s\n", cmdStr)
	if err := runShellCmd(ctx, cmdStr, cwd, out); err != nil {
		return fmt.Errorf("opencode update failed: %w", err)
	}
	return nil
}

// runShellCmd runs a command via the platform shell, inheriting the daemon's
// environment (so an nvm/PATH wrapper is honoured) and the workspace dir. If w is
// nil, output goes to the daemon's stdout/stderr.
func runShellCmd(ctx context.Context, command, cwd string, w io.Writer) error {
	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.CommandContext(ctx, "cmd", "/c", command)
	} else {
		c = exec.CommandContext(ctx, "sh", "-c", command)
	}
	c.Env = os.Environ()
	c.Dir = cwd
	if w == nil {
		c.Stdout, c.Stderr = os.Stdout, os.Stderr
	} else {
		c.Stdout, c.Stderr = w, w
	}
	return c.Run()
}

// ---------------------------------------------------------------------------
// OpenCode changelog (best-effort, never blocks the update flow)
//
// Served at GET /vh/opencode-changelog. The dialog shows it as a collapsible
// "What's new (since <installed>)" panel so the operator can spot
// breaking/migration changes BEFORE clicking update. It is purely an aid: a
// fetch failure degrades to a quiet "Changelog unavailable" line and NEVER
// gates the update button or the version fetch.
//
// Source: https://opencode.ai/changelog.json — already-parsed structured JSON.
// OpenCode's changelog has NO machine-readable breaking marker; the "⚠ may
// affect you" flag below is a best-effort heuristic, never authoritative.
// ---------------------------------------------------------------------------

const ocChangelogTTL = 3 * time.Minute

// ocChangelogURL is the changelog source. Package var (not a const) so tests can
// point it at an httptest server; production code never changes it.
var ocChangelogURL = "https://opencode.ai/changelog.json"

var (
	ocChangelogMu    sync.Mutex
	ocChangelogCache []rawChangelogRelease
	ocChangelogAt    time.Time
)

// rawChangelogRelease mirrors the shape served by opencode.ai/changelog.json.
// Items are raw prose strings; OpencodeChangelog promotes them to
// web.ChangelogItem (applying the heuristic) on the way out. highlights is a
// forward-compatible field that is empty today.
type rawChangelogRelease struct {
	Tag        string                `json:"tag"`
	Name       string                `json:"name"`
	Date       string                `json:"date"`
	URL        string                `json:"url"`
	Highlights []string              `json:"highlights"`
	Sections   []rawChangelogSection `json:"sections"`
}

type rawChangelogSection struct {
	Title string   `json:"title"`
	Items []string `json:"items"`
}

// decodeChangelog parses the changelog body defensively. opencode.ai serves a
// top-level array of releases today; to stay robust against a future wrapper
// object, an object body is probed across the common keys (releases/data/
// changelog/entries). An unrecognized shape yields an error (the caller shows
// "Changelog unavailable" — never a broken dialog).
func decodeChangelog(body []byte) ([]rawChangelogRelease, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return nil, fmt.Errorf("changelog: empty body")
	}
	switch trimmed[0] {
	case '[':
		var releases []rawChangelogRelease
		if err := json.Unmarshal(trimmed, &releases); err != nil {
			return nil, err
		}
		return releases, nil
	case '{':
		// Defensive: tolerate a wrapper object. opencode.ai serves a bare array
		// today; a future wrapper must not 500 the dialog.
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(trimmed, &obj); err != nil {
			return nil, err
		}
		for _, key := range []string{"releases", "data", "changelog", "entries"} {
			if raw, ok := obj[key]; ok {
				var releases []rawChangelogRelease
				if err := json.Unmarshal(raw, &releases); err == nil {
					return releases, nil
				}
			}
		}
		return nil, fmt.Errorf("changelog: unrecognized object shape")
	}
	return nil, fmt.Errorf("changelog: unrecognized shape")
}

// fetchOpencodeChangelogRaw fetches + parses changelog.json behind a short
// in-memory cache. Best-effort: errors are returned (and NOT cached, so a
// transient blip self-heals on the next open) and never reach the update flow.
func fetchOpencodeChangelogRaw(ctx context.Context) ([]rawChangelogRelease, error) {
	ocChangelogMu.Lock()
	if len(ocChangelogCache) > 0 && time.Since(ocChangelogAt) < ocChangelogTTL {
		out := ocChangelogCache
		ocChangelogMu.Unlock()
		return out, nil
	}
	ocChangelogMu.Unlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ocChangelogURL, nil)
	if err != nil {
		return nil, err
	}
	cl := &http.Client{Timeout: 10 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("changelog: HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	releases, err := decodeChangelog(body)
	if err != nil {
		return nil, err
	}

	ocChangelogMu.Lock()
	ocChangelogCache = releases
	ocChangelogAt = time.Now()
	ocChangelogMu.Unlock()
	return releases, nil
}

// compareSemver compares two version strings (raw tags like "v1.17.18" or
// normalized "1.17.18" both work — normVer extracts the core). Returns -1, 0,
// +1 like bytes.Compare. A pre-release version sorts BEFORE its non-pre-release
// counterpart (1.0.0-beta < 1.0.0), per semver. Non-parseable components compare
// 0 at that position. Intentionally simple (OpenCode ships no build metadata of
// concern); used only for the changelog range filter.
func compareSemver(a, b string) int {
	an := normVer(a)
	bn := normVer(b)
	if an == "" || bn == "" {
		// Don't let a parse failure collapse distinct inputs to "equal"; fall
		// back to a stable lexical compare.
		if an == bn {
			return 0
		}
		if an < bn {
			return -1
		}
		return 1
	}
	coreA, preA := splitPre(an)
	coreB, preB := splitPre(bn)
	if c := cmpDots(coreA, coreB); c != 0 {
		return c
	}
	// Same core: a version WITHOUT a pre-release > a version WITH one.
	switch {
	case preA == "" && preB != "":
		return 1
	case preA != "" && preB == "":
		return -1
	case preA == preB:
		return 0
	}
	// Both have pre-release identifiers. Per semver, compare dot-separated
	// identifiers: numeric ids compare numerically AND sort before non-numeric
	// ids; otherwise lexical; a shorter equal-prefix list sorts first. This is
	// why 1.0.0-beta.2 < 1.0.0-beta.11 (2 < 11 numerically), which a whole-string
	// lexical compare would get wrong.
	return cmpPreRelease(preA, preB)
}

func splitPre(v string) (core, pre string) {
	if i := strings.IndexByte(v, '-'); i >= 0 {
		return v[:i], v[i+1:]
	}
	return v, ""
}

// cmpPreRelease compares two semver pre-release strings (the part after '-') by
// dot-separated identifier, per semver precedence: numeric identifiers compare
// numerically and sort before non-numeric ones; otherwise identifiers compare
// lexically; a shorter identifier list with an equal prefix sorts first.
func cmpPreRelease(a, b string) int {
	as := strings.Split(a, ".")
	bs := strings.Split(b, ".")
	n := len(as)
	if len(bs) < n {
		n = len(bs)
	}
	for i := 0; i < n; i++ {
		if c := cmpPreIdent(as[i], bs[i]); c != 0 {
			return c
		}
	}
	if len(as) == len(bs) {
		return 0
	}
	if len(as) < len(bs) {
		return -1
	}
	return 1
}

// cmpPreIdent compares two pre-release identifiers. A numeric identifier sorts
// before a non-numeric one; two numeric ids compare numerically; two non-numeric
// ids compare lexically.
func cmpPreIdent(a, b string) int {
	an, aErr := strconv.Atoi(a)
	bn, bErr := strconv.Atoi(b)
	aNum, bNum := aErr == nil, bErr == nil
	switch {
	case aNum && bNum:
		if an < bn {
			return -1
		}
		if an > bn {
			return 1
		}
		return 0
	case aNum && !bNum:
		return -1 // numeric sorts before non-numeric
	case !aNum && bNum:
		return 1
	default:
		if a < b {
			return -1
		}
		if a > b {
			return 1
		}
		return 0
	}
}

func cmpDots(a, b string) int {
	as := strings.Split(a, ".")
	bs := strings.Split(b, ".")
	n := len(as)
	if len(bs) > n {
		n = len(bs)
	}
	for i := 0; i < n; i++ {
		var ai, bi int
		if i < len(as) {
			ai = atoiSafe(as[i])
		}
		if i < len(bs) {
			bi = atoiSafe(bs[i])
		}
		if ai != bi {
			if ai < bi {
				return -1
			}
			return 1
		}
	}
	return 0
}

func atoiSafe(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// filterChangelogReleases returns the releases in the semver half-open range
// (from, to] — i.e. installed < tag <= latest — ordered newest first. An empty
// from/to means no bound on that side. The result is re-sorted newest-first as a
// safety net (opencode.ai already serves newest-first). Releases with an
// unparseable tag are kept only when both bounds are empty (otherwise they can't
// be placed in the range and are dropped).
func filterChangelogReleases(in []rawChangelogRelease, from, to string) []rawChangelogRelease {
	out := make([]rawChangelogRelease, 0, len(in))
	bounded := from != "" || to != ""
	for _, r := range in {
		tag := normVer(r.Tag)
		if tag == "" {
			if !bounded {
				out = append(out, r)
			}
			continue
		}
		if from != "" && compareSemver(tag, from) <= 0 {
			continue // tag <= installed: strictly greater than `from` required
		}
		if to != "" && compareSemver(tag, to) > 0 {
			continue // tag > latest: at most `to` allowed
		}
		out = append(out, r)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return compareSemver(out[i].Tag, out[j].Tag) > 0 // newest first
	})
	return out
}

// ocMayAffectTokens are the case-insensitive substrings the heuristic scans for.
// These are NOT a severity taxonomy — OpenCode's notes don't flag breaking
// changes, so this is only a hint labelled "⚠ may affect you", never "BREAKING".
// Kept deliberately broad (e.g. "migrat" catches migrate/migration/migrating).
var ocMayAffectTokens = []string{
	"breaking", "migrat", "removed", "deprecat",
	"no longer", "replaced", "renamed", "must now", "required",
}

// ocHighPrioritySections are the sections whose items the heuristic flags. A
// vh-solara operator drives OpenCode over its HTTP/SSE surface, not the Desktop
// app, so a Desktop-only "migration" note is unlikely to affect them — Desktop
// and TUI are excluded. Matched case-insensitively on the trimmed title.
var ocHighPrioritySections = map[string]bool{
	"core":       true,
	"sdk":        true,
	"extensions": true,
}

// itemMayAffectYou reports whether the item text matches a breaking/migration
// token (case-insensitive). Section gating is the caller's job so this stays a
// pure text predicate that's trivial to test.
func itemMayAffectYou(text string) bool {
	low := strings.ToLower(text)
	for _, tok := range ocMayAffectTokens {
		if strings.Contains(low, tok) {
			return true
		}
	}
	return false
}

// OpencodeChangelog is the daemon-wired fetcher for /vh/opencode-changelog. It
// fetches + caches changelog.json, filters to the semver range (from, to]
// (installed < tag <= latest), and applies the best-effort "may affect you"
// heuristic to items in Core/SDK/Extensions sections only. Best-effort end to
// end: any failure returns an error so the handler degrades to "Changelog
// unavailable" without blocking the update button.
//
// from/to are normalized semver strings; an empty bound means no bound on that
// side (the SPA passes the installed/latest versions explicitly).
func OpencodeChangelog(ctx context.Context, from, to string) ([]web.ChangelogRelease, error) {
	raw, err := fetchOpencodeChangelogRaw(ctx)
	if err != nil {
		return nil, err
	}
	filtered := filterChangelogReleases(raw, from, to)
	out := make([]web.ChangelogRelease, 0, len(filtered))
	for _, r := range filtered {
		rel := web.ChangelogRelease{
			Tag:  r.Tag,
			Name: r.Name,
			Date: r.Date,
			URL:  r.URL,
		}
		// Forward-compat: always emit highlights as [] (not null/omitted) so the
		// field is never silently dropped even though it's empty today.
		rel.Highlights = append([]string(nil), r.Highlights...)
		if rel.Highlights == nil {
			rel.Highlights = []string{}
		}
		for _, sec := range r.Sections {
			highPri := ocHighPrioritySections[strings.ToLower(strings.TrimSpace(sec.Title))]
			items := make([]web.ChangelogItem, 0, len(sec.Items))
			for _, it := range sec.Items {
				items = append(items, web.ChangelogItem{
					Text:         it,
					MayAffectYou: highPri && itemMayAffectYou(it),
				})
			}
			rel.Sections = append(rel.Sections, web.ChangelogSection{
				Title: sec.Title,
				Items: items,
			})
		}
		out = append(out, rel)
	}
	return out, nil
}
