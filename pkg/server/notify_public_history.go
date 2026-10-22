package server

// notify_public_history.go — the central public history route (notify
// controller-hub S5, the LAST public route of the v4 program): GET
// /vh/notify/history served from the CENTRAL LEDGER (notify_ledger.go, S3
// read API) in the v4 public shape pinned by the golden fixtures
// (pkg/server/testdata/notify_v4/history_response_v4.json +
// history_response_gaps.json).
//
// Shape (golden, NO schema field):
//
//	{
//	  "events": [{
//	      "id": <int central id>,
//	      "type": "...", "sessionID": "...", "root": "...", "project": "...",
//	      "title": "...", "detail": "...",
//	      "ts": "<DECIMAL STRING, unix millis>",   // stringified ONLY here
//	      "kind": "...", "count": <int>,
//	      "label": "<worker name> — <title>",       // computed at serve time
//	      "worker": {"id": "...", "name": "..."},
//	      "source": {"epoch": "...", "seq": <int>},
//	      "ui_url": "https://<worker-host>/app?session=..&dir=.."   // ONLY
//	                // absent-able event field (no usable host pattern)
//	  }],
//	  "lastId": <int committed global head>,
//	  "coverage": {"complete": <bool>, "gaps": [
//	      {"source_id": "...", "epoch": "...", "from_seq": <int>, "to_seq": <int>}
//	  ]}
//	}
//
// Paging is identical to the v3 legacy semantics (notify_history.go):
// since > 0 ⇒ ascending from since+1; since 0/absent ⇒ the newest `limit`
// events ascending; limit 0/absent ⇒ 50; limit > 200 ⇒ clamped to 200;
// negative or non-numeric since/limit ⇒ 400 {"ok":false,"error":"bad since"
// | "bad limit"} (notifyV4Error). lastId is the COMMITTED HEAD (a pointer,
// not the last retained event — it can exceed the newest returned id after
// prefix truncation) and central ids are contiguous [FirstID..Head].
//
// Coverage renders the ledger's knowledge flattened: each source's gaps
// become {source_id, epoch, from_seq, to_seq} entries (the internal
// open_end/reason markers stay internal — the public shape is the golden
// 4-key entry). complete = no source gaps known.
//
// Auth/CSRF: GET + session cookie per the family (userMux auth chain;
// read-only, CSRF-exempt); the /vh/notify/ prefix carve-out keeps it
// answering on worker-subdomain hosts. Store unconfigured (no ledger
// armed) ⇒ the family's honest 409 naming --notify-store — the dialog's
// disabled-detection depends on it.
//
// The LEGACY controller history (the fleet-condition watcher's file-backed
// record) is NOT spliced into these ids: it remains readable at its
// archive route GET /vh/admin/notify/legacy-history with its own cursor
// namespace (notify_history.go).

import (
	"net/http"
	"strconv"
)

// notifyPublicEventWire is one central history event in the v4 public
// shape. Base v3 fields are ALWAYS present (no omitempty); ui_url is the
// ONLY absent-able event field (§3.1) — omitted when the controller has no
// usable worker host pattern for the event's origin worker.
type notifyPublicEventWire struct {
	ID        int64                  `json:"id"`
	Type      string                 `json:"type"`
	SessionID string                 `json:"sessionID"`
	Root      string                 `json:"root"`
	Project   string                 `json:"project"`
	Title     string                 `json:"title"`
	Detail    string                 `json:"detail"`
	Ts        string                 `json:"ts"` // DECIMAL STRING (unix millis)
	Kind      string                 `json:"kind"`
	Count     int                    `json:"count"`
	Label     string                 `json:"label"`
	Worker    notifyPublicWorkerWire `json:"worker"`
	Source    notifyPublicSourceWire `json:"source"`
	UIURL     string                 `json:"ui_url,omitempty"`
}

type notifyPublicWorkerWire struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type notifyPublicSourceWire struct {
	Epoch string `json:"epoch"`
	Seq   int64  `json:"seq"`
}

// notifyPublicGapWire is one coverage gap entry in the golden 4-key shape.
// The internal NotifySourceGap's open_end/reason markers are bookkeeping
// for the ledger/ingest layers; the public shape carries the bounded
// range (from_seq/to_seq, from<=to, or the {from_seq:1, to_seq:0}
// empty-range sentinel naming an epoch whose unknown-extent prefix is
// gone) keyed by source_id + epoch.
type notifyPublicGapWire struct {
	SourceID string `json:"source_id"`
	Epoch    string `json:"epoch"`
	FromSeq  int64  `json:"from_seq"`
	ToSeq    int64  `json:"to_seq"`
}

type notifyPublicCoverageWire struct {
	Complete bool                  `json:"complete"`
	Gaps     []notifyPublicGapWire `json:"gaps"`
}

type notifyPublicHistoryResponse struct {
	Events   []notifyPublicEventWire  `json:"events"`
	LastID   int64                    `json:"lastId"`
	Coverage notifyPublicCoverageWire `json:"coverage"`
}

// handleNotifyHistoryCentral serves GET /vh/notify/history from the
// central ledger in the golden v4 public shape.
func (d *Daemon) handleNotifyHistoryCentral(w http.ResponseWriter, r *http.Request) {
	// Family disabled posture: NewDaemon pre-arms a memory ledger, so the
	// honest gate is the STORE being configured (no --notify-store ⇒ no
	// durable central history — the dialog's disabled detection relies on
	// the family's 409 naming the flag, same as every other route).
	if !d.notifyStore.configured() || d.ledger() == nil {
		notifyStoreDisabled(w)
		return
	}

	q := r.URL.Query()
	since := int64(0)
	if raw := q.Get("since"); raw != "" {
		v, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || v < 0 {
			notifyV4Error(w, http.StatusBadRequest, "bad since")
			return
		}
		since = v
	}
	limit := notifyHistoryDefaultLimit
	if raw := q.Get("limit"); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 0 {
			notifyV4Error(w, http.StatusBadRequest, "bad limit")
			return
		}
		if v > notifyHistoryMaxLimit {
			v = notifyHistoryMaxLimit
		}
		if v > 0 {
			limit = v
		}
	}

	ledger := d.ledger()
	events := ledger.EventsSince(since, limit)
	cov := ledger.Coverage()

	resp := notifyPublicHistoryResponse{
		Events:   make([]notifyPublicEventWire, 0, len(events)),
		LastID:   ledger.Head(),
		Coverage: notifyPublicCoverageFromLedger(cov),
	}
	for _, ev := range events {
		resp.Events = append(resp.Events, notifyPublicEventWire{
			ID:        ev.ID,
			Type:      ev.Type,
			SessionID: ev.SessionID,
			Root:      ev.Root,
			Project:   ev.Project,
			Title:     ev.Title,
			Detail:    ev.Detail,
			Ts:        strconv.FormatInt(ev.Ts, 10),
			Kind:      ev.Kind,
			Count:     ev.Count,
			Label:     notifyPublicLabel(ev),
			Worker: notifyPublicWorkerWire{
				ID:   ev.WorkerID,
				Name: notifyPublicWorkerName(ev),
			},
			Source: notifyPublicSourceWire{
				Epoch: ev.Epoch,
				Seq:   ev.Seq,
			},
			UIURL: dispatchUIURL(d.HostPattern, ev.WorkerID, ev.SessionID, ev.Project),
		})
	}
	writeNotifyJSON(w, http.StatusOK, resp)
}

// notifyPublicCoverageFromLedger flattens the ledger coverage snapshot
// into the public shape: every source's gaps keyed by source_id
// (complete = none known anywhere). An empty gap list renders as [],
// never null.
func notifyPublicCoverageFromLedger(c NotifyCoverage) notifyPublicCoverageWire {
	wire := notifyPublicCoverageWire{
		Complete: c.Complete,
		Gaps:     []notifyPublicGapWire{},
	}
	for _, src := range c.Sources {
		for _, g := range src.Gaps {
			wire.Gaps = append(wire.Gaps, notifyPublicGapWire{
				SourceID: src.SourceID,
				Epoch:    g.Epoch,
				FromSeq:  g.FromSeq,
				ToSeq:    g.ToSeq,
			})
		}
	}
	return wire
}

// notifyPublicWorkerName mirrors the dispatch message convention: a stored
// empty worker name falls back to the worker id so label/worker.name never
// render empty.
func notifyPublicWorkerName(ev NotifyEvent) string {
	if ev.WorkerName == "" {
		return ev.WorkerID
	}
	return ev.WorkerName
}

// notifyPublicLabel computes "<worker name> — <title>" at serve time —
// never persisted (the worker name can improve without a ledger rewrite).
func notifyPublicLabel(ev NotifyEvent) string {
	return notifyPublicWorkerName(ev) + " — " + ev.Title
}
