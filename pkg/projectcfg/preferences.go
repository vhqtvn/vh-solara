package projectcfg

import (
	"encoding/json"
	"path/filepath"
)

// ResolvePreferencesPath returns the personal-preferences overlay path for a
// project root, mirroring ResolvePath: the overlay lives in the SAME directory
// as the resolved config (so `--project-config` relocates both together) and is
// named preferences.local.jsonc. Used by the editor write-back (PUT), the live
// watch (SSE), and the one-time migration (EnsureLocalSetup) — all of which must
// know the target even when the file does not yet exist.
func ResolvePreferencesPath(root, override string) (string, error) {
	cfgPath, err := ResolvePath(root, override)
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(cfgPath), filepath.Base(PreferencesName)), nil
}

// ParseAgentStyles parses ONLY the agentStyles map from raw JSONC bytes — the
// personal-preferences overlay. It returns (nil, nil) when agentStyles is
// absent, so a caller can treat "key not present" exactly like "file not
// present": both mean "no overlay; use the base". A present-but-empty
// `agentStyles: {}` returns a non-nil empty map (an explicit clear). A malformed
// document returns an error.
func ParseAgentStyles(raw []byte) (map[string]AgentStyle, error) {
	var doc struct {
		AgentStyles map[string]AgentStyle `json:"agentStyles,omitempty"`
	}
	if err := json.Unmarshal(stripJSONC(raw), &doc); err != nil {
		return nil, err
	}
	return doc.AgentStyles, nil
}
