// Package kit provisions a versioned template "kit" into a target repo (C).
// vh-solara provides the MECHANISM only — it ships no kit content. A kit is a
// directory of templates + a manifest declaring parameters and layers. The
// two-layer model the coordination kit uses:
//
//   - engine layer  (type "engine", e.g. controlplane-core):  vh-managed; an
//     update overwrites these files (unless a file carries a vh:keep marker).
//   - overlay layer (type "overlay", e.g. controlplane-policy): consumer-owned;
//     an install/update NEVER clobbers an existing overlay file.
//
// Parameters are injected into template files via {{vh:name}} placeholders. A
// lockfile (.vh-kit.json) in the repo records what was installed for idempotent
// re-install and status.
package kit

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// LockfileName is written at the repo root to track an installed kit.
const LockfileName = ".vh-kit.json"

const keepMarker = "vh:keep" // an engine file containing this is never overwritten

// Manifest is a kit's manifest.json.
type Manifest struct {
	Name        string      `json:"name"`
	Version     string      `json:"version"`
	Description string      `json:"description,omitempty"`
	Parameters  []Parameter `json:"parameters,omitempty"`
	Layers      []Layer     `json:"layers"`
}

// Parameter is a value injected into templates at install time.
type Parameter struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Default     string `json:"default,omitempty"`
	Required    bool   `json:"required,omitempty"`
	Secret      bool   `json:"secret,omitempty"` // not recorded in the lockfile
}

// Layer is one provisioning unit within a kit.
type Layer struct {
	Name   string `json:"name"`
	Type   string `json:"type"`   // "engine" | "overlay"
	Source string `json:"source"` // subdirectory of the kit holding this layer's files
}

const (
	LayerEngine  = "engine"
	LayerOverlay = "overlay"
)

// Lockfile records an installed kit in the target repo.
type Lockfile struct {
	Kit        string              `json:"kit"`
	Version    string              `json:"version"`
	Layers     map[string][]string `json:"layers"`     // layer name -> installed relative paths
	Parameters map[string]string   `json:"parameters"` // non-secret params used
}

// Report summarizes an install/update.
type Report struct {
	Kit       string
	Version   string
	Written   []string // files created or overwritten
	Preserved []string // overlay files left untouched (already present)
	Kept      []string // engine files skipped due to a vh:keep marker
}

var placeholderRE = regexp.MustCompile(`\{\{vh:([a-zA-Z0-9_]+)\}\}`)

// LoadManifest reads and validates a kit's manifest.json.
func LoadManifest(kitDir string) (*Manifest, error) {
	b, err := os.ReadFile(filepath.Join(kitDir, "manifest.json"))
	if err != nil {
		return nil, fmt.Errorf("read manifest: %w", err)
	}
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}
	if m.Name == "" || m.Version == "" {
		return nil, fmt.Errorf("manifest: name and version are required")
	}
	if len(m.Layers) == 0 {
		return nil, fmt.Errorf("manifest: at least one layer is required")
	}
	for _, l := range m.Layers {
		if l.Name == "" || l.Source == "" {
			return nil, fmt.Errorf("manifest: layer name and source are required")
		}
		if l.Type != LayerEngine && l.Type != LayerOverlay {
			return nil, fmt.Errorf("manifest: layer %q has invalid type %q (want engine|overlay)", l.Name, l.Type)
		}
	}
	return &m, nil
}

// resolveParams merges provided values over defaults and checks required ones.
func (m *Manifest) resolveParams(provided map[string]string) (map[string]string, error) {
	out := map[string]string{}
	known := map[string]bool{}
	var missing []string
	for _, p := range m.Parameters {
		known[p.Name] = true
		if v, ok := provided[p.Name]; ok {
			out[p.Name] = v
		} else if p.Default != "" {
			out[p.Name] = p.Default
		} else if p.Required {
			missing = append(missing, p.Name)
		} else {
			out[p.Name] = ""
		}
	}
	for k := range provided {
		if !known[k] {
			return nil, fmt.Errorf("unknown parameter %q (not declared in the manifest)", k)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return nil, fmt.Errorf("missing required parameter(s): %s", strings.Join(missing, ", "))
	}
	return out, nil
}

// substitute replaces {{vh:name}} with param values. An unknown placeholder is an
// error (a kit bug) rather than a silent empty.
func substitute(content []byte, params map[string]string) ([]byte, error) {
	var unknown []string
	out := placeholderRE.ReplaceAllFunc(content, func(m []byte) []byte {
		name := placeholderRE.FindSubmatch(m)[1]
		if v, ok := params[string(name)]; ok {
			return []byte(v)
		}
		unknown = append(unknown, string(name))
		return m
	})
	if len(unknown) > 0 {
		return nil, fmt.Errorf("template references undeclared parameter(s): %s", strings.Join(unique(unknown), ", "))
	}
	return out, nil
}

func unique(xs []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, x := range xs {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	sort.Strings(out)
	return out
}

// Install provisions the kit into repoDir. It is idempotent: overlay files that
// already exist are preserved; engine files are overwritten unless they carry a
// vh:keep marker. Writes/updates the lockfile.
func Install(kitDir, repoDir string, provided map[string]string) (*Report, error) {
	m, err := LoadManifest(kitDir)
	if err != nil {
		return nil, err
	}
	params, err := m.resolveParams(provided)
	if err != nil {
		return nil, err
	}
	if info, err := os.Stat(repoDir); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("target repo %q is not a directory", repoDir)
	}

	rep := &Report{Kit: m.Name, Version: m.Version}
	lock := Lockfile{Kit: m.Name, Version: m.Version, Layers: map[string][]string{}, Parameters: map[string]string{}}
	for _, p := range m.Parameters {
		if !p.Secret {
			lock.Parameters[p.Name] = params[p.Name]
		}
	}

	for _, layer := range m.Layers {
		srcRoot := filepath.Join(kitDir, layer.Source)
		if info, err := os.Stat(srcRoot); err != nil || !info.IsDir() {
			return nil, fmt.Errorf("layer %q: source dir %q not found in kit", layer.Name, layer.Source)
		}
		err := filepath.Walk(srcRoot, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			if info.IsDir() {
				return nil
			}
			rel, err := filepath.Rel(srcRoot, path)
			if err != nil {
				return err
			}
			target := filepath.Join(repoDir, rel)

			raw, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			content, err := substitute(raw, params)
			if err != nil {
				return fmt.Errorf("%s: %w", rel, err)
			}

			exists := fileExists(target)
			switch layer.Type {
			case LayerOverlay:
				if exists {
					rep.Preserved = append(rep.Preserved, rel)
					lock.Layers[layer.Name] = append(lock.Layers[layer.Name], rel)
					return nil // never clobber consumer-owned policy
				}
			case LayerEngine:
				if exists && hasKeepMarker(target) {
					rep.Kept = append(rep.Kept, rel)
					lock.Layers[layer.Name] = append(lock.Layers[layer.Name], rel)
					return nil
				}
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(target, content, 0o644); err != nil {
				return err
			}
			rep.Written = append(rep.Written, rel)
			lock.Layers[layer.Name] = append(lock.Layers[layer.Name], rel)
			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("layer %q: %w", layer.Name, err)
		}
	}

	if err := writeLockfile(repoDir, &lock); err != nil {
		return nil, err
	}
	sort.Strings(rep.Written)
	sort.Strings(rep.Preserved)
	sort.Strings(rep.Kept)
	return rep, nil
}

// Status reads the lockfile from a repo, if any.
func Status(repoDir string) (*Lockfile, error) {
	b, err := os.ReadFile(filepath.Join(repoDir, LockfileName))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var l Lockfile
	if err := json.Unmarshal(b, &l); err != nil {
		return nil, err
	}
	return &l, nil
}

func writeLockfile(repoDir string, l *Lockfile) error {
	for k := range l.Layers {
		sort.Strings(l.Layers[k])
	}
	b, _ := json.MarshalIndent(l, "", "  ")
	return os.WriteFile(filepath.Join(repoDir, LockfileName), append(b, '\n'), 0o644)
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

func hasKeepMarker(p string) bool {
	b, err := os.ReadFile(p)
	if err != nil {
		return false
	}
	return strings.Contains(string(b), keepMarker)
}
