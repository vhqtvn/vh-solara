package server

// notify_public_history_test.go — lane-1 co-located tests for the CENTRAL
// public history route (slice S5; see notify_public_history.go): GET
// /vh/notify/history served from the ledger in the golden v4 shape.
//
// This file closes the S0-review DEFER "served-output conformance": the
// SAME validators that pin the frozen goldens (v4CheckHistoryEvent /
// v4CheckPublicTs, notify_v4_fixture_test.go) run against the LIVE
// handler's decoded response — the served surface cannot drift from the
// fixtures. Covers: the disabled 409 posture, since/limit validation and
// paging semantics (identical to the v3 legacy family), the golden event
// envelope (ts decimal STRING, additive v4 fields, label, worker/source,
// ui_url present/absent), daemon-level events, the worker-name fallback,
// and the coverage flatten (internal open_end/reason markers never reach
// the wire; empty gaps render [] not null).

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// pubRec builds one pre-id commit record with full field control (the
// ledger-test lrec fixes kind/session; the conformance scenarios need
// the real golden vocabulary).
func pubRec(seq int64, typ, kind, sessionID, project, title string) NotifyEvent {
	return NotifyEvent{
		Type: typ, SessionID: sessionID, Root: sessionID,
		Project: project, Title: title, Detail: "detail " + title,
		Ts: 1792455000000 + seq, Kind: kind, Count: 1, Seq: seq,
		Attended: true, IdleSec: 10, ProfileEligible: true,
		CooldownKey: "src|" + typ,
	}
}

// pubPage commits one page for a source through the daemon's ARMED
// ledger (the real S3 commit seam — the same one ingest drives).
func pubPage(t *testing.T, d *Daemon, sourceID, workerName, epoch string, recs ...NotifyEvent) {
	t.Helper()
	if _, err := d.ledger().CommitPage(notifyPageCommit{
		SourceID: sourceID, WorkerID: sourceID, WorkerName: workerName,
		Epoch: epoch, Records: recs, AdvanceTo: recs[len(recs)-1].Seq,
	}); err != nil {
		t.Fatalf("CommitPage(%s): %v", sourceID, err)
	}
}

// pubGet issues an authenticated GET against the real handler chain and
// decodes the JSON body.
func pubGet(t *testing.T, h http.Handler, cookie *http.Cookie, path string) (int, map[string]any) {
	t.Helper()
	rec := doNotify(t, h, http.MethodGet, path, "", func(r *http.Request) { r.AddCookie(cookie) })
	if rec.Code != http.StatusOK {
		return rec.Code, nil
	}
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode history response: %v\nbody: %s", err, rec.Body.String())
	}
	return rec.Code, m
}

// pubSeedGolden commits the golden-v4-fixture scenario set (two workers;
// waiting+question, session_started, finished, daemon-level worker_down)
// and returns the committed head.
func pubSeedGolden(t *testing.T, d *Daemon) {
	t.Helper()
	// Per-source seqs start at 1 (the ledger's ingest contract); central
	// ids are assigned at commit time and are what the conformance pins.
	pubPage(t, d, "bason", "bason", "bason-epoch-0007",
		pubRec(1, "session_started", "session_started", "ses_bason_1", "/home/op/repo-alpha", "Session started"),
		pubRec(2, "waiting", "question_pending", "ses_bason_1", "/home/op/repo-alpha", "Question pending"),
	)
	pubPage(t, d, "iris", "iris", "iris-epoch-0002",
		pubRec(1, "finished", "session_unread", "ses_iris_8", "/home/op/repo-gamma", "Deploy blocked"),
		pubRec(2, "waiting", "permission_pending", "ses_iris_8", "/home/op/repo-gamma", "Deploy blocked"),
		pubRec(3, "waiting", "permission_pending", "ses_iris_8", "/home/op/repo-gamma", "Deploy blocked"),
		pubRec(4, "stalled", "worker_down", "", "", "OpenCode"),
	)
}

// TestNotifyPublicHistory_DisabledPosture pins the family posture: no
// --notify-store ⇒ no ledger ⇒ the honest 409 naming the flag (the
// dialog's disabled detection relies on it).
func TestNotifyPublicHistory_DisabledPosture(t *testing.T) {
	_, h, cookie := newNotifyAuthDaemon(t)
	rec := doNotify(t, h, http.MethodGet, "/vh/notify/history", "", func(r *http.Request) { r.AddCookie(cookie) })
	if rec.Code != http.StatusConflict {
		t.Fatalf("want 409 without a store, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "--notify-store") {
		t.Fatalf("409 body must name --notify-store, got %q", rec.Body.String())
	}
}

// TestNotifyPublicHistory_ValidationAndPaging pins the v3-identical
// paging contract: bad since/limit 400s in the v4 envelope, the 50/200
// default/clamp, newest-limit-ascending for since=0/absent, and strict
// ascending-from-since+1 for since>0.
func TestNotifyPublicHistory_ValidationAndPaging(t *testing.T) {
	d, h, cookie := newNotifyAuthDaemon(t)
	loadNotifyStore(t, d)

	// 60 single-event pages from one source (the head must be 60).
	for i := int64(1); i <= 60; i++ {
		pubPage(t, d, "wrk", "wrk", "e1", pubRec(i, "finished", "session_unread", fmt.Sprintf("s%d", i), "/p", "t"))
	}

	bad := func(q, wantErr string) {
		t.Helper()
		rec := doNotify(t, h, http.MethodGet, "/vh/notify/history?"+q, "", func(r *http.Request) { r.AddCookie(cookie) })
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: want 400, got %d: %s", q, rec.Code, rec.Body.String())
		}
		var env struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil || env.OK || env.Error != wantErr {
			t.Fatalf("%s: want v4 envelope {ok:false,error:%q}, got %s", q, wantErr, rec.Body.String())
		}
	}
	bad("since=x", "bad since")
	bad("since=-1", "bad since")
	bad("limit=x", "bad limit")
	bad("limit=-1", "bad limit")

	ids := func(m map[string]any) []int64 {
		t.Helper()
		evs, ok := m["events"].([]any)
		if !ok {
			t.Fatalf("events must be an array, got %T", m["events"])
		}
		out := make([]int64, 0, len(evs))
		for i, raw := range evs {
			out = append(out, v4WantInt(t, fmt.Sprintf("events[%d]", i), raw.(map[string]any), "id"))
		}
		return out
	}
	assertAscendingRange := func(q string, got []int64, wantFirst, wantLen int64) {
		t.Helper()
		if int64(len(got)) != wantLen {
			t.Fatalf("%s: want %d events, got %d (%v)", q, wantLen, len(got), got)
		}
		for i, id := range got {
			if want := wantFirst + int64(i); id != want {
				t.Fatalf("%s: ids must be ascending contiguous from %d, got %v", q, wantFirst, got)
			}
		}
	}

	// since absent/0 ⇒ the NEWEST limit events ascending; default 50.
	code, m := pubGet(t, h, cookie, "/vh/notify/history")
	if code != http.StatusOK {
		t.Fatalf("default GET: %d", code)
	}
	assertAscendingRange("default", ids(m), 11, 50)
	if last := v4WantInt(t, "resp", m, "lastId"); last != 60 {
		t.Fatalf("lastId must be the committed head 60, got %d", last)
	}

	// limit=5 ⇒ the 5 newest ascending.
	_, m = pubGet(t, h, cookie, "/vh/notify/history?limit=5")
	assertAscendingRange("limit=5", ids(m), 56, 5)

	// limit=0 ⇒ the default (50), not the empty page.
	_, m = pubGet(t, h, cookie, "/vh/notify/history?limit=0")
	assertAscendingRange("limit=0", ids(m), 11, 50)

	// limit clamped at 200: a SECOND source seeds 150 more (per-source
	// seqs restart at 1), total head 210; ask 500 ⇒ the newest 200.
	for i := int64(1); i <= 150; i++ {
		pubPage(t, d, "wrk2", "wrk2", "e1", pubRec(i, "finished", "session_unread", fmt.Sprintf("w2s%d", i), "/p", "t"))
	}
	_, m = pubGet(t, h, cookie, "/vh/notify/history?limit=500")
	assertAscendingRange("limit=500 clamp", ids(m), 11, 200)

	// since>0 ⇒ ascending from since+1, capped by limit.
	_, m = pubGet(t, h, cookie, "/vh/notify/history?since=5&limit=10")
	assertAscendingRange("since=5", ids(m), 6, 10)

	// since beyond the head ⇒ empty events (still 200 + lastId).
	_, m = pubGet(t, h, cookie, "/vh/notify/history?since=9999")
	if evs := m["events"].([]any); len(evs) != 0 {
		t.Fatalf("since beyond head must return empty events, got %d", len(evs))
	}
	if last := v4WantInt(t, "resp", m, "lastId"); last != 210 {
		t.Fatalf("lastId must stay the head 210, got %d", last)
	}
}

// TestNotifyPublicHistory_GoldenShapeConformance closes the S0-review
// DEFER "served-output conformance": the SERVED response — through the
// real auth chain, from a seeded ledger, with a worker host pattern —
// passes the SAME validators as the frozen goldens (v4CheckHistoryEvent)
// and mirrors history_response_v4.json's scenario set (two workers,
// waiting+question, session_started, finished, daemon-level worker_down).
func TestNotifyPublicHistory_GoldenShapeConformance(t *testing.T) {
	d, h, cookie := newNotifyAuthDaemon(t)
	loadNotifyStore(t, d)
	pubSeedGolden(t, d)
	d.HostPattern = "$ID.example"

	code, m := pubGet(t, h, cookie, "/vh/notify/history")
	if code != http.StatusOK {
		t.Fatalf("GET: %d", code)
	}
	// The golden envelope: EXACTLY these three top-level keys (no schema
	// field — both fixtures agree).
	if len(m) != 3 {
		t.Fatalf("response must carry exactly {events,lastId,coverage}, got %v", mKeys(m))
	}
	for _, k := range []string{"events", "lastId", "coverage"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("missing top-level key %q (have %v)", k, mKeys(m))
		}
	}

	events := v4WantArray(t, "served", m, "events")
	if len(events) != 6 {
		t.Fatalf("want all 6 seeded events, got %d", len(events))
	}
	var sawQuestion, sawSessionStarted, sawDaemonDown, sawPerWorkerAttribution bool
	var prevID int64
	for i, raw := range events {
		ev, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("events[%d]: must be an object, got %T", i, raw)
		}
		v4CheckHistoryEvent(t, i, ev)
		id := v4WantInt(t, fmt.Sprintf("events[%d]", i), ev, "id")
		if i > 0 && id != prevID+1 {
			t.Fatalf("events[%d]: central ids must be contiguous, %d follows %d", i, id, prevID)
		}
		prevID = id

		// Host pattern configured ⇒ ui_url present + https, per §3.1.
		if u := v4WantString(t, fmt.Sprintf("events[%d]", i), ev, "ui_url"); !strings.HasPrefix(u, "https://") {
			t.Fatalf("events[%d]: ui_url must be an https link, got %q", i, u)
		}

		w := ev["worker"].(map[string]any)
		src := ev["source"].(map[string]any)
		workerName := w["name"].(string)
		// label is computed at serve time: "<worker name> — <title>".
		if want := workerName + " — " + ev["title"].(string); ev["label"].(string) != want {
			t.Fatalf("events[%d]: label must be %q, got %q", i, want, ev["label"].(string))
		}
		// Per-worker attribution: iris events carry iris's source epoch.
		if w["id"].(string) == "iris" && src["epoch"].(string) == "iris-epoch-0002" {
			sawPerWorkerAttribution = true
		}

		typ, kind := ev["type"].(string), ev["kind"].(string)
		switch {
		case typ == "waiting" && kind == "question_pending":
			sawQuestion = true
			want := "https://bason.example/app?session=ses_bason_1&dir=%2Fhome%2Fop%2Frepo-alpha"
			if ev["ui_url"].(string) != want {
				t.Fatalf("question event ui_url: want %q, got %q", want, ev["ui_url"].(string))
			}
		case typ == "session_started":
			sawSessionStarted = true
		case typ == "stalled" && kind == "worker_down":
			sawDaemonDown = true
			for _, k := range []string{"sessionID", "root", "project"} {
				if s, _ := ev[k].(string); s != "" {
					t.Fatalf("daemon-level worker_down must carry empty %s, got %q", k, s)
				}
			}
			if ev["title"].(string) != "OpenCode" {
				t.Fatalf("daemon-level worker_down title must be OpenCode, got %q", ev["title"].(string))
			}
			// Daemon-level ⇒ the worker's bare /app root, no session query.
			if u := ev["ui_url"].(string); u != "https://iris.example/app" {
				t.Fatalf("daemon-level ui_url must be the bare worker /app root, got %q", u)
			}
		}
	}
	if !sawQuestion || !sawSessionStarted || !sawDaemonDown || !sawPerWorkerAttribution {
		t.Fatalf("scenario coverage: question=%v session_started=%v daemon_down=%v attribution=%v",
			sawQuestion, sawSessionStarted, sawDaemonDown, sawPerWorkerAttribution)
	}
	if last := v4WantInt(t, "served", m, "lastId"); last != 6 {
		t.Fatalf("lastId must be the committed head 6, got %d", last)
	}

	// Complete coverage: no gaps known ⇒ {complete:true, gaps:[]} (the
	// array must be EMPTY, never null).
	cov := v4WantObject(t, "served", m, "coverage")
	if !v4WantBool(t, "coverage", cov, "complete") {
		t.Fatal("fresh seed must be complete")
	}
	if gaps, ok := cov["gaps"].([]any); !ok || len(gaps) != 0 {
		t.Fatalf("complete coverage must render gaps:[], got %T %v", cov["gaps"], cov["gaps"])
	}
}

// TestNotifyPublicHistory_GapsFlatten pins the gaps surface: the ledger's
// internal gap records (worker_prefix_lost closed range, epoch-rotation
// OPEN-END marker) flatten to the golden 4-key entries — source_id,
// epoch, from_seq, to_seq — with open_end/reason NEVER on the wire, and
// complete=false while any gap is known.
func TestNotifyPublicHistory_GapsFlatten(t *testing.T) {
	d, h, cookie := newNotifyAuthDaemon(t)
	loadNotifyStore(t, d)
	pubPage(t, d, "iris", "iris", "iris-epoch-0001",
		pubRec(1, "finished", "session_unread", "s1", "/p", "t"),
		pubRec(2, "finished", "session_unread", "s2", "/p", "t"),
	)
	// A departed-prefix gap: records jump 3 → commit 4..5 with the
	// explicit same-epoch gap covering [3,3].
	if _, err := d.ledger().CommitPage(notifyPageCommit{
		SourceID: "iris", WorkerID: "iris", WorkerName: "iris", Epoch: "iris-epoch-0001",
		Records:   []NotifyEvent{pubRec(4, "finished", "session_unread", "s4", "/p", "t")},
		AdvanceTo: 4,
		Gap:       &NotifySourceGap{Epoch: "iris-epoch-0001", FromSeq: 3, ToSeq: 3, Reason: "worker_prefix_lost"},
	}); err != nil {
		t.Fatalf("gap commit: %v", err)
	}
	// Epoch rotation: the ledger records the OPEN-END departure gap for
	// the old epoch automatically, then the new epoch restarts at seq 1.
	if err := d.ledger().ResetSourceEpoch("iris", "iris-epoch-0002"); err != nil {
		t.Fatalf("ResetSourceEpoch: %v", err)
	}
	pubPage(t, d, "iris", "iris", "iris-epoch-0002",
		pubRec(1, "finished", "session_unread", "n1", "/p", "t"),
	)

	_, m := pubGet(t, h, cookie, "/vh/notify/history")
	cov := v4WantObject(t, "served", m, "coverage")
	if v4WantBool(t, "coverage", cov, "complete") {
		t.Fatal("coverage.complete must be false while gaps are known")
	}
	gaps := v4WantArray(t, "coverage", cov, "gaps")
	if len(gaps) != 2 {
		t.Fatalf("want the prefix-loss gap + the epoch-rotation gap, got %d: %v", len(gaps), gaps)
	}
	// The ledger records BOTH gaps under the DEPARTED epoch key
	// (iris-epoch-0001): the explicit prefix-loss range [3,3] and the
	// rotation's open-end marker at the old cursor+1 [5,5]. Nothing under
	// the new epoch — it started clean at seq 1.
	byRange := map[[2]int64]string{}
	for i, raw := range gaps {
		g, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("gaps[%d]: must be an object, got %T", i, raw)
		}
		if len(g) != 4 {
			t.Fatalf("gaps[%d]: must carry EXACTLY the 4 golden keys, got %v", i, mKeys(g))
		}
		for _, k := range []string{"source_id", "epoch", "from_seq", "to_seq"} {
			if _, ok := g[k]; !ok {
				t.Fatalf("gaps[%d]: missing key %q", i, k)
			}
		}
		if sid := v4WantString(t, fmt.Sprintf("gaps[%d]", i), g, "source_id"); sid != "iris" {
			t.Fatalf("gaps[%d]: source_id must be iris, got %q", i, sid)
		}
		if ep := v4WantString(t, fmt.Sprintf("gaps[%d]", i), g, "epoch"); ep != "iris-epoch-0001" {
			t.Fatalf("gaps[%d]: gap must be keyed by the DEPARTED epoch, got %q", i, ep)
		}
		from, to := v4WantInt(t, fmt.Sprintf("gaps[%d]", i), g, "from_seq"), v4WantInt(t, fmt.Sprintf("gaps[%d]", i), g, "to_seq")
		byRange[[2]int64{from, to}] = "present"
	}
	if _, ok := byRange[[2]int64{3, 3}]; !ok {
		t.Fatalf("want the departed-prefix (worker_prefix_lost) gap [3,3], got %v", gaps)
	}
	if _, ok := byRange[[2]int64{5, 5}]; !ok {
		t.Fatalf("want the epoch-rotation open-end gap [5,5] (old cursor+1), got %v", gaps)
	}
}

// TestNotifyPublicHistory_NoHostPatternNoUIURL pins §3.1's ONLY
// absent-able field: without a usable worker host pattern the served
// events omit ui_url entirely (never an empty string, never a
// controller-relative guess).
func TestNotifyPublicHistory_NoHostPatternNoUIURL(t *testing.T) {
	d, h, cookie := newNotifyAuthDaemon(t)
	loadNotifyStore(t, d)
	pubPage(t, d, "bason", "bason", "e1",
		pubRec(1, "finished", "session_unread", "s1", "/p", "t"),
	)
	// newNotifyAuthDaemon leaves HostPattern "" — no usable pattern.
	_, m := pubGet(t, h, cookie, "/vh/notify/history")
	events := v4WantArray(t, "served", m, "events")
	if len(events) != 1 {
		t.Fatalf("want 1 event, got %d", len(events))
	}
	ev := events[0].(map[string]any)
	v4CheckHistoryEvent(t, 0, ev)
	if _, present := ev["ui_url"]; present {
		t.Fatalf("ui_url must be OMITTED without a host pattern, got %q", ev["ui_url"])
	}
}

// TestNotifyPublicHistory_WorkerNameFallback pins the serve-time name
// convention (mirrors the dispatch message builder): an event whose
// stored worker name is empty falls back to the worker id in BOTH
// worker.name and label — the public surface never renders an empty
// name.
func TestNotifyPublicHistory_WorkerNameFallback(t *testing.T) {
	d, h, cookie := newNotifyAuthDaemon(t)
	loadNotifyStore(t, d)
	pubPage(t, d, "wrk-9", "", "e1",
		pubRec(1, "finished", "session_unread", "s1", "/p", "t"),
	)
	_, m := pubGet(t, h, cookie, "/vh/notify/history")
	ev := v4WantArray(t, "served", m, "events")[0].(map[string]any)
	v4CheckHistoryEvent(t, 0, ev)
	w := v4WantObject(t, "events[0]", ev, "worker")
	if name := v4WantString(t, "worker", w, "name"); name != "wrk-9" {
		t.Fatalf("worker.name must fall back to the id, got %q", name)
	}
	if label := v4WantString(t, "events[0]", ev, "label"); label != "wrk-9 — t" {
		t.Fatalf("label must use the fallback name, got %q", label)
	}
}

// TestNotifyPublicHistory_EmptyLedger pins the fresh-boot shape: events
// [] (never null), lastId 0, coverage {complete:true, gaps:[]}.
func TestNotifyPublicHistory_EmptyLedger(t *testing.T) {
	d, h, cookie := newNotifyAuthDaemon(t)
	loadNotifyStore(t, d)
	_, m := pubGet(t, h, cookie, "/vh/notify/history")
	if evs, ok := m["events"].([]any); !ok || len(evs) != 0 {
		t.Fatalf("empty ledger must render events:[], got %T %v", m["events"], m["events"])
	}
	if last := v4WantInt(t, "served", m, "lastId"); last != 0 {
		t.Fatalf("empty ledger lastId must be 0, got %d", last)
	}
	cov := v4WantObject(t, "served", m, "coverage")
	if !v4WantBool(t, "coverage", cov, "complete") {
		t.Fatal("empty ledger must be complete")
	}
	if gaps, ok := cov["gaps"].([]any); !ok || len(gaps) != 0 {
		t.Fatalf("empty ledger must render gaps:[], got %T %v", cov["gaps"], cov["gaps"])
	}
}

// mKeys returns the decoded object's keys (stable failure messages).
func mKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
