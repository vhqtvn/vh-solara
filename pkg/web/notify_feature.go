package web

// notify_feature.go — the /vh/notify/* routes (Slice 1 of the FCM notify
// channel): the notice-history reader, the token-registry probe, and the
// token upsert endpoint. The FCM sender itself lands in Slice 2; until it is
// attached Engine.NotifyReady() is false, so the probe reports
// {"enabled":false,"count":0} and POST /vh/notify/tokens answers 503 —
// exactly the unconfigured-channel contract.
//
// Secrets discipline: token VALUES never cross the wire on any read route
// (the probe returns enabled+count only) and are never logged.

import (
	"net/http"
	"strconv"

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
					Token string `json:"token"`
					Label string `json:"label"`
				}
				if !decodeBody(w, r, &in) {
					return
				}
				if err := f.tokens.Upsert(in.Token, in.Label); err != nil {
					writeJSON(w, http.StatusBadRequest, errResp(err.Error()))
					return
				}
				writeJSON(w, http.StatusOK, jsonBytes(map[string]any{"ok": true}))
			case http.MethodGet:
				// Probe (never an error, never token values/labels): configured
				// channels answer {"enabled":true,"count":n}; this slice always
				// reports enabled:false with the registry count (0 while upserts
				// answer 503).
				writeJSON(w, http.StatusOK, jsonBytes(notifyProbe{
					Enabled: f.engine.NotifyReady(),
					Count:   f.tokens.Count(),
				}))
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

// notifyProbe is the GET /vh/notify/tokens response shape.
type notifyProbe struct {
	Enabled bool `json:"enabled"`
	Count   int  `json:"count"`
}

// notifyHistoryResp is the GET /vh/notify/history response shape.
type notifyHistoryResp struct {
	Events []alerts.HistoryEvent `json:"events"`
	LastID int64                 `json:"lastId"`
}
