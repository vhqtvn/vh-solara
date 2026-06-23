// Package projectcfg discovers, parses, and validates a project's checked-in
// vh-solara process/view config (`.vh-solara/project.jsonc`). The config lets a
// repo declare companion processes (a board, a docs server, …) and views that
// vh-solara owns and surfaces in its UI whenever the project is open — so the
// user never launches anything by hand. Because vh-solara EXECUTES these
// declarations, the parsed config carries a stable hash (canonical sha256) used
// by the trust gate (see pkg/web/trust.go): only an operator-approved config
// (hash) may run, and any change re-prompts.
//
// The hash is computed over the CANONICAL re-marshaled DECLARATIONS (comment
// and whitespace invariant, independent of the repo's on-disk location), so a
// repo move keeps trust while a real command change re-gates.
package projectcfg

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ConfigName is the conventional, checked-in config path (relative to the
// project root).
const ConfigName = ".vh-solara/project.jsonc"

// Restart policies.
const (
	RestartOnFailure = "on-failure" // default: restart on unexpected exit
	RestartAlways    = "always"     // restart on ANY exit (within one daemon lifetime)
	RestartNo        = "no"         // never restart
)

// Config is the resolved, validated declaration set for one project.
type Config struct {
	Dir       string    `json:"-"` // absolute project root the config was loaded for
	Path      string    `json:"-"` // absolute source file (for diagnostics)
	Processes []Process `json:"processes,omitempty"`
	Views     []View    `json:"views,omitempty"`
}

// Process is one declared companion process. Serialized fields mirror the
// file; resolved fields are tagged json:"-" so the canonical hash reflects the
// author's declarations, not derived paths.
type Process struct {
	ID        string            `json:"id"`
	Command   json.RawMessage   `json:"command"` // string (→ sh -c) or []string
	Cwd       string            `json:"cwd,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Restart   string            `json:"restart,omitempty"`
	Readiness *Readiness        `json:"readiness,omitempty"`

	// Resolved (json:"-" → not part of the canonical hash).
	Argv          []string `json:"-"` // executable + args (sh -c <s> for a string command)
	ShellCommand  string   `json:"-"` // original string form, if command was a string
	AbsCwd        string   `json:"-"` // resolved absolute working directory
	DisplayCommand string  `json:"-"` // human form for the trust review (joined argv or the shell string)
}

// Readiness is the optional readiness probe. Exactly one of Unix/HTTP/Log is
// honored (precedence Unix > HTTP > Log); omit entirely to use the default
// heuristic (see procmgr).
type Readiness struct {
	Unix string `json:"unix,omitempty"` // socket path → connect() success
	HTTP string `json:"http,omitempty"` // URL → 2xx
	Log  string `json:"log,omitempty"`  // regex on stdout+stderr
}

// View is one declared reverse-proxy view bound (optionally) to a managed
// process socket.
type View struct {
	ID         string `json:"id"`
	Title      string `json:"title,omitempty"`
	PathPrefix string `json:"path_prefix"`
	Upstream   string `json:"upstream"`
	DependsOn  string `json:"depends_on,omitempty"`
	Sandbox    string `json:"sandbox,omitempty"`
}

// canonical is the serialization shape used for hashing: it drops the resolved
// (json:"-") fields by construction (Config re-marshals without them).
func (c *Config) canonical() []byte {
	b, _ := json.Marshal(c)
	return b
}

// Hash returns the sha256 hex of the canonical declaration bytes. Stable across
// comment/whitespace/repo-location changes; changes iff a declared value
// changes.
func (c *Config) Hash() string {
	sum := sha256.Sum256(c.canonical())
	return hex.EncodeToString(sum[:])
}

// CanonicalJSON is the pretty-printed declaration bytes shown in the trust
// review (deterministic, so it matches what was hashed).
func (c *Config) CanonicalJSON() []byte {
	b, _ := json.MarshalIndent(c, "", "  ")
	return b
}

// ProcessByID looks up a declared process by id.
func (c *Config) ProcessByID(id string) (*Process, bool) {
	for i := range c.Processes {
		if c.Processes[i].ID == id {
			return &c.Processes[i], true
		}
	}
	return nil, false
}

// LoadResult bundles a parsed config with its raw bytes.
type LoadResult struct {
	Config *Config
	Hash   string
}

// NotFound reports whether err means "no project config present" (the common
// case for projects without managed processes).
type NotFound struct{ path string }

func (e NotFound) Error() string { return "no project config at " + e.path }

// IsNotFound reports whether err is a NotFound.
func IsNotFound(err error) bool {
	var nf NotFound
	return errors.As(err, &nf)
}

// Load discovers and parses the project config under root. If override is
// non-empty it is used as the config path (absolute, or relative to root);
// otherwise the conventional root/.vh-solara/project.jsonc is tried and a
// NotFound is returned if absent. All relative paths in the declarations (cwd,
// readiness.unix, view upstream unix:) are resolved against root.
func Load(root, override string) (*LoadResult, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	var path string
	switch {
	case override != "":
		if filepath.IsAbs(override) {
			path = override
		} else {
			path = filepath.Join(rootAbs, override)
		}
	default:
		path = filepath.Join(rootAbs, ConfigName)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, NotFound{path: path}
		}
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(stripJSONC(raw), &c); err != nil {
		return nil, fmt.Errorf("project config %s: %w", path, err)
	}
	c.Dir = rootAbs
	c.Path = path
	if err := resolveAndValidate(&c); err != nil {
		return nil, fmt.Errorf("project config %s: %w", path, err)
	}
	return &LoadResult{Config: &c, Hash: c.Hash()}, nil
}

func resolveAndValidate(c *Config) error {
	seenProc := map[string]bool{}
	for i := range c.Processes {
		p := &c.Processes[i]
		id := strings.TrimSpace(p.ID)
		if id == "" {
			return errors.New("processes[].id is required")
		}
		if !isSafeID(id) {
			return fmt.Errorf("processes[].id %q must be [A-Za-z0-9_.-]", id)
		}
		if seenProc[id] {
			return fmt.Errorf("processes[].id %q is not unique", id)
		}
		seenProc[id] = true
		p.ID = id

		argv, shell, err := resolveCommand(p.Command)
		if err != nil {
			return fmt.Errorf("process %q command: %w", id, err)
		}
		if len(argv) == 0 {
			return fmt.Errorf("process %q command is empty", id)
		}
		p.Argv = argv
		p.ShellCommand = shell
		if shell != "" {
			p.DisplayCommand = shell
		} else {
			p.DisplayCommand = strings.Join(argv, " ")
		}

		switch p.Restart = strings.TrimSpace(p.Restart); p.Restart {
		case "":
			p.Restart = RestartOnFailure
		case RestartOnFailure, RestartAlways, RestartNo:
		default:
			return fmt.Errorf("process %q restart must be %s|%s|%s", id, RestartOnFailure, RestartAlways, RestartNo)
		}

		// Resolve cwd.
		cwd := strings.TrimSpace(p.Cwd)
		if cwd == "" || cwd == "." {
			p.AbsCwd = c.Dir
		} else if filepath.IsAbs(cwd) {
			p.AbsCwd = cwd
		} else {
			p.AbsCwd = filepath.Join(c.Dir, cwd)
		}
		if info, err := os.Stat(p.AbsCwd); err != nil || !info.IsDir() {
			return fmt.Errorf("process %q cwd %q is not a directory", id, p.AbsCwd)
		}

		// Resolve readiness.unix relative path.
		if p.Readiness != nil && p.Readiness.Unix != "" {
			p.Readiness.Unix = resolvePath(c.Dir, p.Readiness.Unix)
		}
	}

	seenView := map[string]bool{}
	for i := range c.Views {
		v := &c.Views[i]
		id := strings.TrimSpace(v.ID)
		if id == "" {
			return errors.New("views[].id is required")
		}
		if !isSafeID(id) {
			return fmt.Errorf("views[].id %q must be [A-Za-z0-9_.-]", id)
		}
		if seenView[id] {
			return fmt.Errorf("views[].id %q is not unique", id)
		}
		seenView[id] = true
		v.ID = id
		if strings.TrimSpace(v.PathPrefix) == "" {
			return fmt.Errorf("view %q path_prefix is required", id)
		}
		if strings.TrimSpace(v.Upstream) == "" {
			return fmt.Errorf("view %q upstream is required", id)
		}
		// Resolve a unix: upstream socket path if it is relative.
		if up, ok := resolveUnixUpstream(c.Dir, v.Upstream); ok {
			v.Upstream = up
		}
		if dep := strings.TrimSpace(v.DependsOn); dep != "" {
			if _, ok := c.ProcessByID(dep); !ok {
				return fmt.Errorf("view %q depends_on %q does not match a declared process", id, dep)
			}
			v.DependsOn = dep
		}
	}
	return nil
}

// resolveCommand accepts a JSON string (→ sh -c) or array of strings.
func resolveCommand(raw json.RawMessage) (argv []string, shell string, err error) {
	if len(raw) == 0 {
		return nil, "", errors.New("missing")
	}
	// Try array first.
	var arr []string
	if e := json.Unmarshal(raw, &arr); e == nil {
		// Trim/validate each token is non-empty after trim of the executable.
		out := make([]string, 0, len(arr))
		for _, a := range arr {
			out = append(out, a)
		}
		return out, "", nil
	}
	var s string
	if e := json.Unmarshal(raw, &s); e == nil {
		s = strings.TrimSpace(s)
		if s == "" {
			return nil, "", errors.New("empty string")
		}
		return []string{defaultShell, "-c", s}, s, nil
	}
	return nil, "", errors.New("must be a string or array of strings")
}

// defaultShell is the shell used for a string command. /bin/sh for portability;
// the operator's repo controls the script content.
const defaultShell = "/bin/sh"

// resolveUnixUpstream, if upstream is "unix:<path>" with a relative path,
// returns the resolved "unix:<abspath>" form and ok=true.
func resolveUnixUpstream(root, upstream string) (string, bool) {
	const pre = "unix:"
	if !strings.HasPrefix(upstream, pre) {
		return upstream, false
	}
	sock := strings.TrimPrefix(upstream, pre)
	if sock == "" || filepath.IsAbs(sock) {
		return upstream, true
	}
	return pre + filepath.Join(root, sock), true
}

func resolvePath(root, p string) string {
	if filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(root, p)
}

func isSafeID(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_' || r == '-' || r == '.':
		default:
			return false
		}
	}
	return true
}
