package alerts

// FCM token registry for the /vh/notify/* routes (Slice 1). Token VALUES are
// secrets-in-transit: no read route ever returns them (GET /vh/notify/tokens
// reports only enabled+count) and nothing logs them. Persistence follows the
// push-subs.json pattern: JSON under the state dir, atomic tmp+rename, 0600,
// reloaded on daemon start.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const (
	// NotifyTokenCap is the registry cap: upserts of NEW tokens beyond it fail
	// (an already-registered token always succeeds — idempotent by token).
	NotifyTokenCap = 32
	// NotifyLabelMax bounds the optional label (the contract's "≤64 chars").
	NotifyLabelMax = 64
)

// Registry errors — the /vh/notify/tokens route maps them onto 400 responses.
var (
	ErrNotifyTokenRequired = errors.New("token required")
	ErrNotifyTokenCap      = errors.New("token limit reached")
	// ErrNotifyTokenPolicy rejects a push_policy other than
	// PolicyWhenUnattended or PolicyAlways (an empty policy is the
	// when_unattended default — backward compatible with old POST bodies).
	ErrNotifyTokenPolicy = errors.New("invalid push_policy")
)

// NotifyToken is one registered FCM delivery token.
type NotifyToken struct {
	Token      string `json:"token"`
	Label      string `json:"label,omitempty"`       // optional device label (≤64 chars)
	PushPolicy string `json:"push_policy,omitempty"` // when_unattended (default, omitted) | always
	Ts         int64  `json:"ts"`                    // first registered, unix millis
}

// normalizePushPolicy canonicalizes a stored/loaded policy: empty or unknown
// values become PolicyWhenUnattended (the fail-closed default — a hand-edited
// file entry never widens delivery to always).
func normalizePushPolicy(p string) string {
	if p == PolicyAlways {
		return PolicyAlways
	}
	return PolicyWhenUnattended
}

// TokenRegistry stores the tokens at <stateDir>/notify-tokens.json.
type TokenRegistry struct {
	mu     sync.Mutex
	path   string
	tokens map[string]NotifyToken // token -> entry
}

// NewTokenRegistry loads (or starts) the registry under stateDir.
func NewTokenRegistry(stateDir string) *TokenRegistry {
	r := &TokenRegistry{
		path:   filepath.Join(stateDir, "notify-tokens.json"),
		tokens: map[string]NotifyToken{},
	}
	raw, err := os.ReadFile(r.path)
	if err != nil {
		return r
	}
	var list []NotifyToken
	if json.Unmarshal(raw, &list) != nil {
		return r // corrupt file -> empty registry (push-subs posture)
	}
	for _, t := range list {
		if t.Token != "" {
			t.PushPolicy = normalizePushPolicy(t.PushPolicy)
			r.tokens[t.Token] = t
		}
	}
	return r
}

// Upsert registers a token, idempotent by token: an existing entry keeps its
// first-seen ts and gets its label AND push policy refreshed (the POST body is
// the full desired state — a re-POST without push_policy resets an always
// token to when_unattended); a NEW entry beyond NotifyTokenCap fails with
// ErrNotifyTokenCap. An empty token fails with ErrNotifyTokenRequired; a
// policy other than "" | when_unattended | always fails with
// ErrNotifyTokenPolicy. Labels longer than NotifyLabelMax runes are
// truncated. Persistence errors are returned to the caller.
func (r *TokenRegistry) Upsert(token, label, policy string) error {
	if token == "" {
		return ErrNotifyTokenRequired
	}
	if policy != "" && policy != PolicyWhenUnattended && policy != PolicyAlways {
		return ErrNotifyTokenPolicy
	}
	policy = normalizePushPolicy(policy)
	label = truncateRunes(label, NotifyLabelMax)
	r.mu.Lock()
	defer r.mu.Unlock()
	if prev, ok := r.tokens[token]; ok {
		prev.Label = label
		prev.PushPolicy = policy
		r.tokens[token] = prev
		return r.persistLocked()
	}
	if len(r.tokens) >= NotifyTokenCap {
		return ErrNotifyTokenCap
	}
	r.tokens[token] = NotifyToken{Token: token, Label: label, PushPolicy: policy, Ts: time.Now().UnixMilli()}
	return r.persistLocked()
}

// Prune removes the named tokens (Slice 2: FCM reports a token invalid →
// drop it). Unknown tokens are a no-op. Persistence errors are returned.
func (r *TokenRegistry) Prune(tokens ...string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	removed := false
	for _, t := range tokens {
		if _, ok := r.tokens[t]; ok {
			delete(r.tokens, t)
			removed = true
		}
	}
	if !removed {
		return nil
	}
	return r.persistLocked()
}

// Count returns the number of registered tokens (never their values).
func (r *TokenRegistry) Count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.tokens)
}

// PolicyCounts returns the token counts by push policy — the probe's
// "policies" object (counts only, never values or labels). Both keys are
// always present.
func (r *TokenRegistry) PolicyCounts() map[string]int {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := map[string]int{PolicyWhenUnattended: 0, PolicyAlways: 0}
	for _, t := range r.tokens {
		out[normalizePushPolicy(t.PushPolicy)]++
	}
	return out
}

// List returns a snapshot of the registered tokens for the notify sender's
// fan-out (Slice 2). Token VALUES are delivery secrets: callers must never
// expose or log them — they go straight into FCM message requests.
func (r *TokenRegistry) List() []NotifyToken {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]NotifyToken, 0, len(r.tokens))
	for _, t := range r.tokens {
		out = append(out, t)
	}
	return out
}

// persistLocked writes the registry atomically (tmp + rename, 0600), sorted by
// token for deterministic files. The default policy is written ABSENT (the
// omitempty legacy shape) so a pre-v3 file and a v3 file differ only for
// always tokens; the reload normalizes absence back to when_unattended.
// Caller holds mu.
func (r *TokenRegistry) persistLocked() error {
	list := make([]NotifyToken, 0, len(r.tokens))
	for _, t := range r.tokens {
		if t.PushPolicy == PolicyWhenUnattended {
			t.PushPolicy = ""
		}
		list = append(list, t)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Token < list[j].Token })
	out, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(r.path), 0o700); err != nil {
		return err
	}
	tmp := r.path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, r.path)
}

// truncateRunes bounds s to max runes (a no-op under the fast path).
func truncateRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	if len(s) <= max {
		return s
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}
