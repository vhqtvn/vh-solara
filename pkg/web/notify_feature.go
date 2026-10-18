package web

// notify_feature.go — the /vh/notify/* routes: the notice-history reader,
// the token-registry probe, and the token upsert endpoint. The FCM sender
// (Slice 2) attaches in InitAlerts when the config carries a credentials
// file; until then Engine.NotifyReady() is false, so the probe reports
// {"enabled":false,"count":0,"policies":{...},"last_attempt":"","last_error":""}
// and POST /vh/notify/tokens answers 503 — exactly the unconfigured-channel
// contract (stable shape in both states).
//
// v3: the POST body accepts push_policy ("when_unattended" default |
// "always"; anything else → 400 invalid push_policy), and the probe reports
// per-policy token counts plus the channel-level last_attempt/last_error.
//
// Secrets discipline: token VALUES never cross the wire on any read route
// (the probe returns counts and sanitized channel state only) and are never
// logged.

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/alerts"
)

// notifyFeature mounts the notify-channel management routes. Daemon-global,
// like alertsFeature: one engine, one token registry, one history ring per
// host. Auth + CSRF ride the shared /vh/* middleware stack (session auth on
// everything; X-VH-CSRF on the mutating POST).
type notifyFeature struct {
	engine *alerts.Engine
	tokens *alerts.TokenRegistry
}

func (notifyFeature) Name() string { return "notify" }

func (f notifyFeature) Routes(svc Services) map[string]http.HandlerFunc {
	return map[string]http.HandlerFunc{
		"/vh/notify/tokens": func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodPost:
				// Channel-unconfigured check FIRST (the /vh/alerts/push/subscribe
				// 503 pattern): with no sender attached the channel is unavailable
				// regardless of the body. Slice 2 flips NotifyReady when the
				// sender exists.
				if !f.engine.NotifyReady() {
					writeJSON(w, http.StatusServiceUnavailable, errResp("notify unavailable"))
					return
				}
				var in struct {
					Token      string `json:"token"`
					Label      string `json:"label"`
					PushPolicy string `json:"push_policy"` // "" | when_unattended | always ("" = when_unattended)
				}
				if !decodeBody(w, r, &in) {
					return
				}
				if err := f.tokens.Upsert(in.Token, in.Label, in.PushPolicy); err != nil {
					// Client errors (sentinel registry errors) answer 400;
					// anything else is an I/O/persistence failure → 500.
					status := http.StatusInternalServerError
					if errors.Is(err, alerts.ErrNotifyTokenRequired) || errors.Is(err, alerts.ErrNotifyTokenCap) ||
						errors.Is(err, alerts.ErrNotifyTokenPolicy) {
						status = http.StatusBadRequest
					}
					writeJSON(w, status, errResp(err.Error()))
					return
				}
				writeJSON(w, http.StatusOK, jsonBytes(map[string]any{"ok": true}))
			case http.MethodGet:
				// Probe (never an error, never token values/labels): configured
				// channels answer {"enabled":true,"count":n,"policies":{...},
				// "last_attempt":"...","last_error":"..."} — policy COUNTS only,
				// plus the channel-level observability surface (RFC3339 of the
				// last FCM send attempt, empty before any attempt; sanitized
				// last_error, empty when the latest attempt succeeded). The
				// shape is identical in the configured/unconfigured states.
				probe := notifyProbe{
					Enabled:  f.engine.NotifyReady(),
					Count:    f.tokens.Count(),
					Policies: f.tokens.PolicyCounts(),
				}
				if nt := f.engine.Notifier(); nt != nil {
					if at, lastErr := nt.Health(); !at.IsZero() {
						probe.LastAttempt = at.Format(time.RFC3339)
						probe.LastError = lastErr
					}
				}
				writeJSON(w, http.StatusOK, jsonBytes(probe))
			default:
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			}
		},
		"/vh/notify/history": func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			q := r.URL.Query()
			var since int64
			if s := q.Get("since"); s != "" {
				v, err := strconv.ParseInt(s, 10, 64)
				if err != nil || v < 0 {
					writeJSON(w, http.StatusBadRequest, errResp("bad since"))
					return
				}
				since = v
			}
			limit := 0 // 0/absent -> History's default (50), clamped to max 200
			if s := q.Get("limit"); s != "" {
				v, err := strconv.Atoi(s)
				if err != nil || v < 0 {
					writeJSON(w, http.StatusBadRequest, errResp("bad limit"))
					return
				}
				limit = v
			}
			events, lastID := f.engine.History().Query(since, limit)
			writeJSON(w, http.StatusOK, jsonBytes(notifyHistoryResp{Events: events, LastID: lastID}))
		},
	}
}

// notifyProbe is the GET /vh/notify/tokens response shape. Policies carries
// token COUNTS by push policy (both keys always present — never values or
// labels); LastAttempt/LastError are the channel-level observability surface
// (RFC3339 of the last FCM send attempt, "" before any attempt; sanitized
// last_error, "" when the latest attempt succeeded).
type notifyProbe struct {
	Enabled     bool           `json:"enabled"`
	Count       int            `json:"count"`
	Policies    map[string]int `json:"policies"`
	LastAttempt string         `json:"last_attempt"`
	LastError   string         `json:"last_error"`
}

// notifyHistoryResp is the GET /vh/notify/history response shape.
type notifyHistoryResp struct {
	Events []alerts.HistoryEvent `json:"events"`
	LastID int64                 `json:"lastId"`
}
