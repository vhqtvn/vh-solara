package alerts

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
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
		if !ok || !ch.Enabled || ch.URL == "" {
			continue
		}
		if d.onCooldown(n.Type, n.SessionID, chID, cooldown) {
			continue
		}
		go d.post(ch, n)
	}
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

// SendTest POSTs a synthetic notice to one channel by id, ignoring profile,
// attendance, and cooldown — for the settings "send test" button. Returns the
// HTTP status or an error.
func (d *Dispatcher) SendTest(channelID string) (int, error) {
	ch, ok := d.cfg.resolvedChannel(channelID)
	if !ok {
		return 0, fmt.Errorf("unknown channel %q", channelID)
	}
	if ch.URL == "" {
		return 0, fmt.Errorf("channel %q has no url", channelID)
	}
	n := Notice{
		Type:    TypeFinished,
		Detail:  "Test notification from vh-solara",
		Title:   "Test",
		Project: "(test)",
		Ts:      d.now().UnixMilli(),
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
