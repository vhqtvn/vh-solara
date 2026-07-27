package quota

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// authPath resolves OpenCode's auth.json (~/.local/share/opencode/auth.json),
// overridable via VH_OPENCODE_AUTH for tests/custom installs.
func authPath() string {
	if p := os.Getenv("VH_OPENCODE_AUTH"); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "share", "opencode", "auth.json")
}

func readAuth() map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	p := authPath()
	if p == "" {
		return out
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return out
	}
	_ = json.Unmarshal(b, &out)
	return out
}
