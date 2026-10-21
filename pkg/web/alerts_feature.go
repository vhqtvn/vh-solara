package web

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/alerts"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

func durSec(s int) time.Duration { return time.Duration(s) * time.Second }

// AlertsOptions carries the daemon's controller posture and worker identity
// into the alerts stack (notify controller-hub S1). The zero value is the
// standalone/v3 posture: no controller URL, default local identity — exactly
// what fixtureserver and the integration tests run with.
type AlertsOptions struct {
	// ControllerURL is the daemon's --controller connect configuration.
	// Non-empty ⇒ controller mode ⇒ local FCM fenced at init (v4 (j)).
	ControllerURL string
	// WorkerID is the daemon's stable controller identity (--id, the same
	// value RegisterMessage carries — not a parallel identity). Defaults to
	// "local" when empty.
	WorkerID string
	// WorkerName is the display name (--name). Defaults to "local".
	WorkerName string
}

// InitAlerts builds the daemon-side notifications engine, mounts its management
// API, and wires it to subscribe each project store as it comes up. The config
// lives at VH_STATE_DIR/alerts.jsonc (seeded with defaults on first run). The
// detector watchers run until ctx is cancelled (daemon teardown). Returns the
// engine (nil on config load error, which is non-fatal to the daemon).
//
// S1 additions: the durable source spool (the feed's authoritative record
// store) attaches unconditionally, and the ownership fence runs BEFORE the
// notifier could attach — in controller mode local FCM is disabled at this
// point, which is before the tunnel agent starts (InitAlerts runs inside
// setupWebMode at client-daemon.go:65; agent.NewDaemon at :73 starts later).
func (s *Server) InitAlerts(ctx context.Context, opts AlertsOptions) (*alerts.Engine, error) {
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
	// Durable source (S1): every emitted notice gets a durable
	// (source_id, epoch, seq) record — the ring stays the public id space,
	// the spool is the authoritative feed source going forward.
	workerID := opts.WorkerID
	if workerID == "" {
		workerID = "local"
	}
	workerName := opts.WorkerName
	if workerName == "" {
		workerName = "local"
	}
	engine.SetSource(alerts.NewSourceSpool(stateBaseDir(), workerID, alerts.SourceSpoolCap))

	// Ownership fence (S1, v4 (j)/§9.4): controller mode ⇒ local FCM never
	// attaches — structurally, so no later reconnect/timeout path can revive
	// it. Fail-closed: missing/corrupt ownership state in controller mode
	// also leaves it disabled (with the visible disposition note below).
	own := alerts.DecideNotifyOwnership(stateBaseDir(), opts.ControllerURL != "")
	if own.LocalFCMFenced {
		level := slog.LevelInfo
		if own.Healed {
			level = slog.LevelWarn
		}
		vhlog.Logger().Log(ctx, level, "notify: local FCM fenced", "controller_mode", own.ControllerMode, "healed", own.Healed, "disposition", own.Note)
	}
	// Notify channel: daemon-global notice-history ring + FCM token registry
	// + the /vh/notify/* routes, plus (Slice 2) the FCM sender itself. The
	// registry is shared between the routes and the sender — the sender fans
	// out to List() and prunes dead tokens via Prune(). The sender attaches
	// ONLY when the config carries a credentials file AND it loads AND the
	// ownership fence permits local sending; a load failure silently
	// disables the channel (NotifyReady false → probe enabled:false, upserts
	// 503) without touching anything else in alerts.
	// (v3) The attached sender also runs the periodic channel-health log
	// line (window counters) until ctx is cancelled; its per-failure logging
	// rides the daemon's shared vhlog logger (see pkg/vhlog).
	tokens := alerts.NewTokenRegistry(stateBaseDir())
	if store.Get().NotifyConfigured() && !own.LocalFCMFenced {
		if notifier, nerr := alerts.NewNotifier(store, presence, tokens); nerr == nil {
			engine.SetNotifier(notifier)
			notifier.StartHealthLoop(ctx, 0) // daemon default interval
		}
	}
	engine.SetHistory(alerts.NewHistory(stateBaseDir()))
	s.RegisterFeature(notifyFeature{engine: engine, tokens: tokens, workerID: workerID, workerName: workerName})
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
// each channel's stored secret when the client sends an empty one. The notify
// section is carried over from prev, not the wire shape (the alerts settings
// UI doesn't edit it) — without this, a UI save would silently STRIP a
// hand-written notify block from alerts.jsonc.
func mergeConfig(prev alerts.Config, in wireConfig) alerts.Config {
	prevSecret := map[string]string{}
	for _, ch := range prev.Channels {
		prevSecret[ch.ID] = ch.Secret
	}
	out := alerts.Config{Profiles: in.Profiles, Active: in.Active, Detect: in.Detect, Notify: prev.Notify}
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
