package alerts

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Notice is the typed alert payload emitted on the store bus (for in-app
// delivery) and POSTed to webhook channels.
type Notice struct {
	Type      string `json:"type"`              // finished | waiting | stuck-thinking | runaway | stalled
	SessionID string `json:"sessionID"`         // the session the notice is about
	Root      string `json:"root"`              // its root session
	Project   string `json:"project"`           // project dir
	Title     string `json:"title,omitempty"`   // session title (best-effort)
	Detail    string `json:"detail,omitempty"`  // short human description
	Ts        int64  `json:"ts"`                // unix millis when detected
}

// Dispatcher routes notices to webhook channels per the active profile,
// attendance policy, and per-(type,session,channel) cooldown. In-app delivery is
// handled separately by the engine (store fan-out); this only does outbound.
type Dispatcher struct {
	cfg      *Store
	presence *Presence
	client   *http.Client
	now      func() time.Time

	mu       sync.Mutex
	lastFire map[string]time.Time // "type|session|channel" -> last POST time
}

func NewDispatcher(cfg *Store, presence *Presence) *Dispatcher {
	return &Dispatcher{
		cfg:      cfg,
		presence: presence,
		client:   &http.Client{Timeout: 10 * time.Second},
		now:      time.Now,
		lastFire: map[string]time.Time{},
	}
}

// Dispatch evaluates routing for a notice and POSTs to eligible channels. It
// never blocks the caller — each POST runs in its own goroutine.
func (d *Dispatcher) Dispatch(n Notice) {
	cfg := d.cfg.Get()
	prof := cfg.ActiveProfile()
	if !prof.wantsType(n.Type) {
		return
	}
	switch prof.ChannelPolicy {
	case PolicyNever:
		return
	case PolicyWhenUnattended:
		idle := time.Duration(cfg.Detect.IdleSec) * time.Second
		if d.presence.Attended(idle) {
			return // user is at the keyboard — no outbound channels
		}
	case PolicyAlways:
		// always fire
	default:
		return
	}

	cooldown := time.Duration(cfg.Detect.CooldownSec) * time.Second
	for _, chID := range prof.Channels {
		ch, ok := d.cfg.resolvedChannel(chID)
		if !ok || !ch.Enabled || !configured(ch) {
			continue
		}
		if d.onCooldown(n.Type, n.SessionID, chID, cooldown) {
			continue
		}
		if ch.Type == ChannelCommand {
			go d.run(ch, n)
		} else {
			go d.post(ch, n)
		}
	}
}

// configured reports whether a channel has the target its type needs.
func configured(ch Channel) bool {
	if ch.Type == ChannelCommand {
		return ch.Command != ""
	}
	return ch.URL != ""
}

// noticeEnv renders the notice as VH_ALERT_* environment variables for a
// command channel. VH_ALERT_JSON carries the whole payload for scripts that
// want structured access.
func noticeEnv(n Notice) []string {
	b, _ := json.Marshal(n)
	return []string{
		"VH_ALERT_TYPE=" + n.Type,
		"VH_ALERT_SESSION=" + n.SessionID,
		"VH_ALERT_ROOT=" + n.Root,
		"VH_ALERT_PROJECT=" + n.Project,
		"VH_ALERT_TITLE=" + n.Title,
		"VH_ALERT_DETAIL=" + n.Detail,
		"VH_ALERT_TS=" + strconv.FormatInt(n.Ts, 10),
		"VH_ALERT_JSON=" + string(b),
	}
}

// run executes a command channel's program with the notice in its environment.
// Output is discarded (use "send test" to see it). The command runs with the
// daemon's environment plus VH_ALERT_*; this is the operator's own config, the
// same trust level as managed-project processes.
func (d *Dispatcher) run(ch Channel, n Notice) {
	if ch.Command == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ch.Command, ch.Args...)
	cmd.Env = append(os.Environ(), noticeEnv(n)...)
	_ = cmd.Run()
}

// onCooldown reports whether this (type,session,channel) fired within the
// window; if not, it records "now" and returns false (allow).
func (d *Dispatcher) onCooldown(typ, session, channel string, window time.Duration) bool {
	if window <= 0 {
		return false
	}
	key := typ + "|" + session + "|" + channel
	d.mu.Lock()
	defer d.mu.Unlock()
	now := d.now()
	if last, ok := d.lastFire[key]; ok && now.Sub(last) < window {
		return true
	}
	d.lastFire[key] = now
	return false
}

// post sends one webhook, signing the body with HMAC-SHA256 when the channel
// has a secret.
func (d *Dispatcher) post(ch Channel, n Notice) {
	body, err := json.Marshal(n)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ch.URL, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "vh-solara-alerts/1")
	if ch.Secret != "" {
		mac := hmac.New(sha256.New, []byte(ch.Secret))
		mac.Write(body)
		req.Header.Set("X-VH-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return
	}
	_ = resp.Body.Close()
}

// SendTest delivers a synthetic notice to one channel by id, ignoring profile,
// attendance, and cooldown — for the settings "send test" button. For a webhook
// it returns the HTTP status; for a command, the process exit code (0 on
// success). A non-nil error includes a short snippet of the failure.
func (d *Dispatcher) SendTest(channelID string) (int, error) {
	ch, ok := d.cfg.resolvedChannel(channelID)
	if !ok {
		return 0, fmt.Errorf("unknown channel %q", channelID)
	}
	n := Notice{
		Type:    TypeFinished,
		Detail:  "Test notification from vh-solara",
		Title:   "Test",
		Project: "(test)",
		Ts:      d.now().UnixMilli(),
	}
	if ch.Type == ChannelCommand {
		return d.runTest(ch, n)
	}
	if ch.URL == "" {
		return 0, fmt.Errorf("channel %q has no url", channelID)
	}
	body, _ := json.Marshal(n)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ch.URL, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "vh-solara-alerts/1")
	if ch.Secret != "" {
		mac := hmac.New(sha256.New, []byte(ch.Secret))
		mac.Write(body)
		req.Header.Set("X-VH-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

// runTest runs a command channel synchronously, returning the exit code and, on
// failure, a snippet of its combined output so the operator can debug it.
func (d *Dispatcher) runTest(ch Channel, n Notice) (int, error) {
	if ch.Command == "" {
		return 0, fmt.Errorf("channel %q has no command", ch.ID)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ch.Command, ch.Args...)
	cmd.Env = append(os.Environ(), noticeEnv(n)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode(), fmt.Errorf("exit %d: %s", ee.ExitCode(), snippet(out))
		}
		return 0, err
	}
	return 0, nil
}

// snippet trims command output to a single short line for error messages.
func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 200 {
		s = s[:200] + "…"
	}
	return s
}
