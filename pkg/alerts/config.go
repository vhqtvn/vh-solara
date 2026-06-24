// Package alerts is the daemon-side notification system: it watches the live
// session event stream, detects noteworthy states (a turn finished, a session
// is waiting on a human, or a session is "stuck" — looping in thought, running
// a runaway command, or silently hung), and routes those notices to outbound
// channels (webhooks) and — via a "notice" event on the store bus — to the web
// UI for in-app / OS notifications.
//
// Routing is attendance-aware: a notice fires to a channel based on the active
// notification PROFILE and whether the user is actually attending (presence
// heartbeats from connected devices), not merely whether a browser is open.
package alerts

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

// Notice types.
const (
	TypeFinished      = "finished"       // a root turn completed (settled)
	TypeWaiting       = "waiting"        // a session needs human input (permission/question)
	TypeStuckThinking = "stuck-thinking" // reasoning has streamed too long (loop)
	TypeRunaway       = "runaway"        // a non-task tool has run too long
	TypeStalled       = "stalled"        // busy but no output for too long (hang)
)

// AllTypes is the canonical ordered set, used as the default `types` filter.
var AllTypes = []string{TypeFinished, TypeWaiting, TypeStuckThinking, TypeRunaway, TypeStalled}

// Channel policy values (when a profile lets a channel fire).
const (
	PolicyAlways         = "always"          // fire regardless of attendance
	PolicyWhenUnattended = "when_unattended" // fire only when the user is idle/away
	PolicyNever          = "never"           // never fire this channel
)

// Device scope (default in-app delivery for a device under a profile).
const (
	ScopeOff     = "off"     // no in-app notifications
	ScopeCurrent = "current" // only for the device's focused session/root
	ScopeAll     = "all"     // any session
)

// Channel is one outbound webhook target. Secrets support ${VH_...} env refs so
// they needn't be written into the file in clear.
type Channel struct {
	ID      string `json:"id"`
	Type    string `json:"type"` // currently only "generic"
	URL     string `json:"url"`
	Secret  string `json:"secret,omitempty"` // HMAC-SHA256 signing key (optional)
	Enabled bool   `json:"enabled"`
}

// Profile bundles routing for a mode ("At desk", "Away", "Silent", …). Switch
// the active profile to flip routing en masse.
type Profile struct {
	Name          string   `json:"name"`
	Channels      []string `json:"channels"`       // channel ids this profile enables
	ChannelPolicy string   `json:"channel_policy"` // always | when_unattended | never
	DeviceScope   string   `json:"device_scope"`   // off | current | all (default for devices)
	Types         []string `json:"types"`          // notice types to deliver (empty = all)
}

// Detect holds detector thresholds (seconds).
type Detect struct {
	FinishedSettleSec int `json:"finished_settle_sec"` // re-check window before "finished"
	ThinkSec          int `json:"think_sec"`           // reasoning active longer → stuck-thinking
	CommandSec        int `json:"command_sec"`         // non-task tool running longer → runaway
	StalledSec        int `json:"stalled_sec"`         // busy + no output longer → stalled
	CooldownSec       int `json:"cooldown_sec"`        // per (type, session) dispatch cooldown
	IdleSec           int `json:"idle_sec"`            // no device interaction this long → unattended
}

// Config is the full alerts/notifications config (VH_STATE_DIR/alerts.jsonc).
type Config struct {
	Channels []Channel `json:"channels"`
	Profiles []Profile `json:"profiles"`
	Active   string    `json:"active_profile"`
	Detect   Detect    `json:"detect"`
}

// DefaultConfig is the seed written when no file exists: detectors at sane
// thresholds, no channels, and three built-in profiles.
func DefaultConfig() Config {
	return Config{
		Channels: []Channel{},
		Active:   "At desk",
		Detect: Detect{
			FinishedSettleSec: 5,
			ThinkSec:          300,
			CommandSec:        300,
			StalledSec:        180,
			CooldownSec:       300,
			IdleSec:           120,
		},
		Profiles: []Profile{
			{Name: "At desk", ChannelPolicy: PolicyWhenUnattended, DeviceScope: ScopeCurrent, Types: nil},
			{Name: "Away", ChannelPolicy: PolicyAlways, DeviceScope: ScopeOff, Types: nil},
			{Name: "Silent", ChannelPolicy: PolicyNever, DeviceScope: ScopeOff, Types: nil},
		},
	}
}

// profileByName returns the active profile, falling back to the first, then a
// permissive default.
func (c *Config) ActiveProfile() Profile {
	for _, p := range c.Profiles {
		if p.Name == c.Active {
			return p
		}
	}
	if len(c.Profiles) > 0 {
		return c.Profiles[0]
	}
	return Profile{Name: "default", ChannelPolicy: PolicyWhenUnattended, DeviceScope: ScopeCurrent}
}

// wantsType reports whether a profile delivers a given notice type (empty Types
// means all).
func (p Profile) wantsType(t string) bool {
	if len(p.Types) == 0 {
		return true
	}
	for _, x := range p.Types {
		if x == t {
			return true
		}
	}
	return false
}

var envRef = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

// resolveEnv expands ${VAR} refs from the environment (used for secret URLs/keys
// so they stay out of the file).
func resolveEnv(s string) string {
	return envRef.ReplaceAllStringFunc(s, func(m string) string {
		name := m[2 : len(m)-1]
		return os.Getenv(name)
	})
}

// Store loads/saves the config file and guards in-memory access.
type Store struct {
	path   string
	mu     sync.RWMutex
	cfg    Config
	header []byte                     // leading comment/whitespace block, preserved verbatim
	extra  map[string]json.RawMessage // unknown top-level keys, preserved on save
}

// ConfigPath returns VH_STATE_DIR/alerts.jsonc (the daemon's per-host config).
func ConfigPath(stateDir string) string { return filepath.Join(stateDir, "alerts.jsonc") }

// NewStore loads the config from path, seeding a default file if absent.
func NewStore(path string) (*Store, error) {
	s := &Store{path: path, extra: map[string]json.RawMessage{}}
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		s.cfg = DefaultConfig()
		if werr := s.save(); werr != nil {
			return nil, werr
		}
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	s.header = leadingComment(raw)
	stripped := stripJSONC(raw)
	if err := json.Unmarshal(stripped, &s.cfg); err != nil {
		return nil, fmt.Errorf("alerts config %s: %w", path, err)
	}
	// Preserve any top-level keys we don't model, so a UI save never drops them.
	all := map[string]json.RawMessage{}
	_ = json.Unmarshal(stripped, &all)
	for k, v := range all {
		switch k {
		case "channels", "profiles", "active_profile", "detect":
		default:
			s.extra[k] = v
		}
	}
	return s, nil
}

// save writes the config losslessly-ish: the leading comment header is kept
// verbatim, unknown top-level keys are preserved, and known keys serialize in a
// stable order — so a UI edit produces a minimal diff. (Inline comments inside
// the object are not yet preserved; that's a follow-up surgical editor.)
func (s *Store) save() error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	merged := map[string]json.RawMessage{}
	for k, v := range s.extra {
		merged[k] = v
	}
	add := func(k string, v any) { b, _ := json.Marshal(v); merged[k] = b }
	add("channels", s.cfg.Channels)
	add("profiles", s.cfg.Profiles)
	add("active_profile", s.cfg.Active)
	add("detect", s.cfg.Detect)
	body, err := marshalOrdered(merged, []string{"detect", "active_profile", "profiles", "channels"})
	if err != nil {
		return err
	}
	out := append(append([]byte{}, s.header...), body...)
	out = append(out, '\n')
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Get returns a copy-ish snapshot of the config (slices are shared read-only).
func (s *Store) Get() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg
}

// resolvedChannel returns a channel with ${ENV} expanded in url/secret.
func (s *Store) resolvedChannel(id string) (Channel, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, c := range s.cfg.Channels {
		if c.ID == id {
			c.URL = resolveEnv(c.URL)
			c.Secret = resolveEnv(c.Secret)
			return c, true
		}
	}
	return Channel{}, false
}

// SetActive switches the active profile and persists.
func (s *Store) SetActive(name string) error {
	s.mu.Lock()
	s.cfg.Active = name
	s.mu.Unlock()
	return s.save()
}

// Replace overwrites the whole config (settings UI "save") and persists,
// preserving the header comment + unknown top-level keys.
func (s *Store) Replace(c Config) error {
	s.mu.Lock()
	s.cfg = c
	s.mu.Unlock()
	return s.save()
}
