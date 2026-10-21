package web

// notify_feature.go — the /vh/notify/* routes: the notice-history reader,
// the token-registry probe, and the token upsert endpoint. The FCM sender
// (Slice 2) attaches in InitAlerts when the config carries a credentials
// file AND the ownership fence permits local sending (controller mode fences
// it — S1); until then Engine.NotifyReady() is false, so the probe reports
// {"enabled":false,"count":0,"policies":{...},"last_attempt":"","last_error":""}
// and POST /vh/notify/tokens answers 503 — exactly the unconfigured-channel
// contract (stable shape in both states).
//
// v4 (Position C, §3.1 + golden fixtures at pkg/server/testdata/notify_v4/):
// GET /vh/notify/history serves the v4 event DTO — `ts` is a DECIMAL STRING
// of epoch millis (public-DTO-boundary conversion only; the ring and spool
// stay numeric int64), plus the additive kind/count/label/worker/source
// fields and the response-level coverage object. Documented standalone
// omissions: `ui_url` (no worker-host config on the standalone loopback
// surface — the doc's omit rule) and `source` on ring-only legacy events
// that predate the spool.
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
// everything; X-VH-CSRF on the mutating POST). workerID/workerName are the
// daemon identity passed through InitAlerts (default "local") — the v4 DTO's
// worker ref and label source.
type notifyFeature struct {
	engine     *alerts.Engine
	tokens     *alerts.TokenRegistry
	workerID   string
	workerName string
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
			// Paging/lastId semantics are UNCHANGED from v3 (History.Query);
			// only the served event DTO is v4.
			events, lastID := f.engine.History().Query(since, limit)
			writeJSON(w, http.StatusOK, jsonBytes(notifyHistoryResp{
				Events:   f.v4Events(events),
				LastID:   lastID,
				Coverage: f.v4Coverage(),
			}))
		},
	}
}

// v4Events maps ring events onto the v4 public DTO, joining the durable
// source spool BY THE SEQ THE RING EVENT CARRIES (the spool-owned correlation
// key, t1b-F1 — the reversal of the old (ringGen, id) join): each event
// stamped at recording time with its OWN notice's (epoch, seq) resolves to
// exactly that record, so a ring id reset or reuse — file loss, corrupt
// recovery, or a rolled-back persist failure — can never serve an older
// record's kind or source tuple.
//
// Served-kind authority (the fix for the F3 contract_drift): the BASELINE
// condition is computed from the ring event's OWN retained Kind — stamped at
// detection time, independent of the spool correlation key — so a waiting
// notice serves its true condition (§9.1: kind=question ⇒ question_pending)
// even when its spool record is unavailable: append failed (SpoolSeq 0), or a
// later rotation/eviction dropped the record (epoch mismatch / lookup miss).
// When the join DOES succeed, the spool record remains the authority (it must
// agree with the ring Kind for post-S1 events, and it also covers pre-fix
// ring documents recorded before the ring retained Kind) — computing the
// baseline from the ring first is what removes the old bug where a Kind-less
// pre-join computation mis-served new question notices as permission_pending.
// The permission_pending fallback therefore applies ONLY to genuinely
// subtype-less records: pre-S1 legacy waiting events with empty ring Kind AND
// no spool join. Events whose key is absent or whose epoch no longer matches
// the spool's (a rotation replaced the spool state) omit `source` —
// documented behavior.
func (f notifyFeature) v4Events(events []alerts.HistoryEvent) []notifyEventV4 {
	out := make([]notifyEventV4, 0, len(events))
	spool := f.engine.Source()
	for _, ev := range events {
		title := ev.Title
		if title == "" {
			title = ev.Type // label fallback (every emitted type carries a title today)
		}
		// The baseline condition consumes the ring's OWN retained subtype:
		// correct standalone (no join possible), and never the Kind-less
		// pre-join computation that mis-served question notices as
		// permission_pending when their spool record was unavailable.
		n := alerts.Notice{Type: ev.Type, Kind: ev.Kind, SessionID: ev.SessionID, Root: ev.Root, Title: ev.Title}
		dto := notifyEventV4{
			ID:        ev.ID,
			Type:      ev.Type,
			SessionID: ev.SessionID,
			Root:      ev.Root,
			Project:   ev.Project,
			Title:     ev.Title,
			Detail:    ev.Detail,
			Ts:        strconv.FormatInt(ev.Ts, 10), // Position C: decimal string at the DTO boundary
			Kind:      alerts.ConditionOf(n),
			Count:     1,
			Label:     f.workerName + " — " + title,
			Worker:    notifyWorkerRef{ID: f.workerID, Name: f.workerName},
			// ui_url intentionally omitted: no worker-host config on the
			// standalone loopback surface (doc omit rule).
		}
		if spool != nil && ev.SpoolSeq > 0 && ev.SpoolEpoch == spool.Epoch() {
			// The epoch guard is load-bearing: a rotated spool re-allocates
			// seqs from 1 under a fresh epoch, and an old-epoch seq must not
			// join a new-epoch record — a mismatch serves source-omitted.
			if rec, ok := spool.LookupBySeq(ev.SpoolSeq); ok {
				// The join succeeded: the spool record is the authority for
				// the subtype (it must agree with the ring Kind for post-S1
				// events; it also covers pre-fix ring documents whose ring
				// events predate Kind retention).
				n.Kind = rec.Kind
				dto.Kind = alerts.ConditionOf(n)
				dto.Source = &notifySourceRef{Epoch: spool.Epoch(), Seq: ev.SpoolSeq}
			}
		}
		out = append(out, dto)
	}
	return out
}

// v4Coverage reports single-worker degraded coverage (v4 (d)). complete is
// true ONLY when the durable source can honestly claim the full retained
// window; it degrades on any of:
//   - overflow: the spool evicted oldest records to its bound — one
//     best-effort gap names the evicted seq range of the CURRENT epoch;
//   - persistence failure (B1): the spool's last persist failed — records in
//     the undurable seq range exist in memory only, and a gap names that
//     range; even when no record is retained yet (init-time persist failure)
//     complete degrades with no gap (nothing nameable is missing — the error
//     surface is the signal);
//   - epoch rotation (B1): the spool state was REPLACED — corrupt-file
//     recovery, or a LOST spool file when the ring's era proves one existed
//     (t1b-F2) — so the prior range is discontinuous. Its extent is
//     UNRECOVERABLE — the prior document is unreadable or deleted by
//     definition — so the gap uses the EMPTY-RANGE convention (from_seq:1,
//     to_seq:0, i.e. from > to) marking "an unknown range of the named epoch
//     is gone". The gap carries the OLD epoch when it was known pre-rotation
//     (prevEpoch), else the CURRENT epoch (the corrupt/lost case never knows
//     the old value). No new wire field — the frozen gap shape carries it.
//
// Central ids are never fabricated into holes.
func (f notifyFeature) v4Coverage() notifyCoverage {
	cov := notifyCoverage{Complete: true, Gaps: []notifySourceGap{}}
	spool := f.engine.Source()
	if spool == nil {
		return cov
	}
	if spool.OverflowTotal() > 0 {
		first := spool.FirstSeq()
		if first > 1 {
			cov.Complete = false
			cov.Gaps = append(cov.Gaps, notifySourceGap{
				SourceID: f.workerID, Epoch: spool.Epoch(), FromSeq: 1, ToSeq: first - 1,
			})
		}
	}
	if spool.LastPersistError() != "" {
		// The last persist failed: nothing later than the last successful
		// persist is durable. The undurable range is KNOWN (nameable gap);
		// an empty range still degrades complete (init failure, no records).
		cov.Complete = false
		if from, to := spool.UndurableSeqRange(); from <= to {
			cov.Gaps = append(cov.Gaps, notifySourceGap{
				SourceID: f.workerID, Epoch: spool.Epoch(), FromSeq: from, ToSeq: to,
			})
		}
	}
	if spool.RotatedAt() != 0 {
		// Rotation-with-discontinuity: the old range is unrecoverable, so
		// name the OLD epoch if it was known pre-rotation, else the current
		// one, with the empty-range marker (see the doc comment above).
		cov.Complete = false
		gapEpoch := spool.Epoch()
		if prev := spool.PrevEpoch(); prev != "" {
			gapEpoch = prev
		}
		cov.Gaps = append(cov.Gaps, notifySourceGap{
			SourceID: f.workerID, Epoch: gapEpoch, FromSeq: 1, ToSeq: 0,
		})
	}
	return cov
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

// notifyHistoryResp is the GET /vh/notify/history response shape (v4).
type notifyHistoryResp struct {
	Events   []notifyEventV4 `json:"events"`
	LastID   int64           `json:"lastId"`
	Coverage notifyCoverage  `json:"coverage"`
}

// notifyEventV4 is one v4 public history event. Base v3 fields keep their
// exact names/shapes (sessionID spelling preserved); `ts` is the negotiated
// BREAKING type change (Position C: decimal string of epoch millis); kind/
// count/label/worker/source are v4-additive; ui_url is the one field the
// contract may omit — omitted here (standalone surface, no worker host).
type notifyEventV4 struct {
	ID        int64            `json:"id"`
	Type      string           `json:"type"`
	SessionID string           `json:"sessionID"`
	Root      string           `json:"root"`
	Project   string           `json:"project"`
	Title     string           `json:"title"`
	Detail    string           `json:"detail"`
	Ts        string           `json:"ts"`
	Kind      string           `json:"kind"`
	Count     int              `json:"count"`
	Label     string           `json:"label"`
	Worker    notifyWorkerRef  `json:"worker"`
	Source    *notifySourceRef `json:"source,omitempty"`
}

// notifyWorkerRef names the origin worker (source_id equals worker.id in the
// one-source-per-worker design).
type notifyWorkerRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// notifySourceRef is the durable-source identity (v4 §9.2) — epoch a string,
// seq an integer. Omitted on ring-only legacy events.
type notifySourceRef struct {
	Epoch string `json:"epoch"`
	Seq   int64  `json:"seq"`
}

// notifyCoverage is the additive response-level coverage object (v4 (d)):
// source gaps (spool overflow / persistence loss / source reset) — never
// fabricated central-id holes.
type notifyCoverage struct {
	Complete bool              `json:"complete"`
	Gaps     []notifySourceGap `json:"gaps"`
}

// notifySourceGap names one source's missing inclusive seq range.
type notifySourceGap struct {
	SourceID string `json:"source_id"`
	Epoch    string `json:"epoch"`
	FromSeq  int64  `json:"from_seq"`
	ToSeq    int64  `json:"to_seq"`
}
