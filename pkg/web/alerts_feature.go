package web

import (
	"context"
	"net/http"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/alerts"
)

func durSec(s int) time.Duration { return time.Duration(s) * time.Second }

// InitAlerts builds the daemon-side notifications engine, mounts its management
// API, and wires it to subscribe each project store as it comes up. The config
// lives at VH_STATE_DIR/alerts.jsonc (seeded with defaults on first run). The
// detector watchers run until ctx is cancelled (daemon teardown). Returns the
// engine (nil on config load error, which is non-fatal to the daemon).
func (s *Server) InitAlerts(ctx context.Context) (*alerts.Engine, error) {
	store, err := alerts.NewStore(alerts.ConfigPath(stateBaseDir()))
	if err != nil {
		return nil, err
	}
	presence := alerts.NewPresence()
	dispatcher := alerts.NewDispatcher(store, presence)
	engine := alerts.NewEngine(store, presence, dispatcher)
	// Web Push (closed-app delivery) is optional — a key/store failure disables
	// push without taking down the rest of alerts.
	if pusher, perr := alerts.NewPusher(store, presence, stateBaseDir()); perr == nil {
		engine.SetPusher(pusher)
	}
	s.RegisterFeature(alertsFeature{engine: engine})
	s.SetAggHook(func(dir string, a *aggregator.Aggregator) {
		engine.Attach(ctx, dir, a.Store())
	})
	return engine, nil
}

// alertsFeature mounts the notifications/alerts management API. It is daemon-
// global (one engine per host); routes read/write the alerts config, switch the
// active profile, accept device presence heartbeats, and fire test webhooks.
//
// Secrets are write-only over the wire: GET never returns a channel secret (only
// a hasSecret flag); a save with an empty secret on an existing channel keeps
// the stored one, so the masked UI never wipes a secret it didn't display.
type alertsFeature struct {
	engine *alerts.Engine
}

func (alertsFeature) Name() string { return "alerts" }

// wireChannel is the masked, client-facing channel shape.
type wireChannel struct {
	ID        string   `json:"id"`
	Type      string   `json:"type"`
	URL       string   `json:"url"`
	Enabled   bool     `json:"enabled"`
	HasSecret bool     `json:"hasSecret"`
	Secret    string   `json:"secret,omitempty"` // inbound only (a new/changed secret)
	Command   string   `json:"command"`
	Args      []string `json:"args"`
}

type wireConfig struct {
	Channels []wireChannel    `json:"channels"`
	Profiles []alerts.Profile `json:"profiles"`
	Active   string           `json:"active_profile"`
	Detect   alerts.Detect    `json:"detect"`
}

func maskConfig(c alerts.Config) wireConfig {
	out := wireConfig{Profiles: c.Profiles, Active: c.Active, Detect: c.Detect}
	for _, ch := range c.Channels {
		args := ch.Args
		if args == nil {
			args = []string{}
		}
		out.Channels = append(out.Channels, wireChannel{
			ID: ch.ID, Type: ch.Type, URL: ch.URL, Enabled: ch.Enabled,
			HasSecret: ch.Secret != "", Command: ch.Command, Args: args,
		})
	}
	if out.Channels == nil {
		out.Channels = []wireChannel{}
	}
	if out.Profiles == nil {
		out.Profiles = []alerts.Profile{}
	}
	return out
}

// mergeConfig folds an inbound wireConfig onto the current config, preserving
// each channel's stored secret when the client sends an empty one.
func mergeConfig(prev alerts.Config, in wireConfig) alerts.Config {
	prevSecret := map[string]string{}
	for _, ch := range prev.Channels {
		prevSecret[ch.ID] = ch.Secret
	}
	out := alerts.Config{Profiles: in.Profiles, Active: in.Active, Detect: in.Detect}
	for _, ch := range in.Channels {
		secret := ch.Secret
		if secret == "" {
			secret = prevSecret[ch.ID] // keep stored secret (write-only field)
		}
		var args []string
		for _, a := range ch.Args {
			if a != "" {
				args = append(args, a)
			}
		}
		out.Channels = append(out.Channels, alerts.Channel{
			ID: ch.ID, Type: ch.Type, URL: ch.URL, Enabled: ch.Enabled, Secret: secret,
			Command: ch.Command, Args: args,
		})
	}
	if out.Channels == nil {
		out.Channels = []alerts.Channel{}
	}
	return out
}

func (f alertsFeature) Routes(svc Services) map[string]http.HandlerFunc {
	cfg := f.engine.Config()
	return map[string]http.HandlerFunc{
		"/vh/alerts/config": func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet:
				writeJSON(w, http.StatusOK, jsonBytes(maskConfig(cfg.Get())))
			case http.MethodPut, http.MethodPost:
				var in wireConfig
				if !decodeBody(w, r, &in) {
					return
				}
				merged := mergeConfig(cfg.Get(), in)
				if err := cfg.Replace(merged); err != nil {
					writeJSON(w, http.StatusInternalServerError, errResp(err.Error()))
					return
				}
				writeJSON(w, http.StatusOK, jsonBytes(maskConfig(cfg.Get())))
			default:
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			}
		},
		"/vh/alerts/profile": func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			var in struct {
				Name string `json:"name"`
			}
			if !decodeBody(w, r, &in) {
				return
			}
			if err := cfg.SetActive(in.Name); err != nil {
				writeJSON(w, http.StatusInternalServerError, errResp(err.Error()))
				return
			}
			writeJSON(w, http.StatusOK, jsonBytes(map[string]any{"ok": true, "active_profile": in.Name}))
		},
		"/vh/alerts/presence": func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			var d alerts.Device
			if !decodeBody(w, r, &d) {
				return
			}
			if d.ID == "" {
				writeJSON(w, http.StatusBadRequest, errResp("missing device id"))
				return
			}
			f.engine.Presence().Heartbeat(d)
			idle := f.engine.Config().Get().Detect.IdleSec
			writeJSON(w, http.StatusOK, jsonBytes(map[string]any{
				"ok":       true,
				"attended": f.engine.Presence().Attended(durSec(idle)),
			}))
		},
		"/vh/alerts/devices": func(w http.ResponseWriter, r *http.Request) {
			// Devices stale after ~3x the idle window are pruned/omitted.
			idle := f.engine.Config().Get().Detect.IdleSec
			devices := f.engine.Presence().Devices(durSec(idle * 3))
			writeJSON(w, http.StatusOK, jsonBytes(map[string]any{"devices": devices}))
		},
		"/vh/alerts/push/key": func(w http.ResponseWriter, r *http.Request) {
			p := f.engine.Pusher()
			if p == nil {
				writeJSON(w, http.StatusOK, jsonBytes(map[string]any{"enabled": false}))
				return
			}
			writeJSON(w, http.StatusOK, jsonBytes(map[string]any{"enabled": true, "publicKey": p.PublicKey()}))
		},
		"/vh/alerts/push/subscribe": func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			p := f.engine.Pusher()
			if p == nil {
				writeJSON(w, http.StatusServiceUnavailable, errResp("push unavailable"))
				return
			}
			// Accept the browser PushSubscription shape plus deviceId + scope.
			var in struct {
				DeviceID     string `json:"deviceId"`
				Scope        string `json:"scope"`
				Subscription struct {
					Endpoint string `json:"endpoint"`
					Keys     struct {
						P256dh string `json:"p256dh"`
						Auth   string `json:"auth"`
					} `json:"keys"`
				} `json:"subscription"`
			}
			if !decodeBody(w, r, &in) {
				return
			}
			err := p.Subscribe(alerts.PushSub{
				DeviceID: in.DeviceID,
				Endpoint: in.Subscription.Endpoint,
				P256dh:   in.Subscription.Keys.P256dh,
				Auth:     in.Subscription.Keys.Auth,
				Scope:    in.Scope,
			})
			if err != nil {
				writeJSON(w, http.StatusBadRequest, errResp(err.Error()))
				return
			}
			writeJSON(w, http.StatusOK, jsonBytes(map[string]any{"ok": true}))
		},
		"/vh/alerts/push/unsubscribe": func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			p := f.engine.Pusher()
			if p == nil {
				writeJSON(w, http.StatusOK, jsonBytes(map[string]any{"ok": true}))
				return
			}
			var in struct {
				DeviceID string `json:"deviceId"`
			}
			if !decodeBody(w, r, &in) {
				return
			}
			_ = p.Unsubscribe(in.DeviceID)
			writeJSON(w, http.StatusOK, jsonBytes(map[string]any{"ok": true}))
		},
		"/vh/alerts/test": func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			var in struct {
				Channel string `json:"channel"`
			}
			if !decodeBody(w, r, &in) {
				return
			}
			status, err := f.engine.Dispatcher().SendTest(in.Channel)
			if err != nil {
				writeJSON(w, http.StatusBadGateway, errResp(err.Error()))
				return
			}
			writeJSON(w, http.StatusOK, jsonBytes(map[string]any{"ok": true, "status": status}))
		},
	}
}
