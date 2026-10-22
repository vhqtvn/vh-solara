package server

// notify_v4_fixture_test.go — S0 contract-freeze validator for the v4
// golden wire shapes at testdata/notify_v4/ (docs/architecture/notify-fcm.md
// §8, v4 2026-10-21). It is a SCHEMA-SHAPE validator: field presence +
// types on each golden fixture, most importantly `ts` as a DECIMAL STRING
// of epoch milliseconds on public history shapes (v4 §1 (b) / §7.2,
// Position C) — a JSON number there fails the test. S3–S5 must additionally
// pin their served output byte-shape-identical to these fixtures (field
// names/types; key order insensitive).

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// v4FixturePath resolves a fixture name inside the frozen golden-fixture
// directory (S0, 2026-10-21).
func v4FixturePath(name string) string {
	return filepath.Join("testdata", "notify_v4", name)
}

// v4Kinds is the frozen condition vocabulary (contract §9.1) — the complete
// notice-type→condition enumeration. No public history event may carry a
// kind outside this set.
var v4Kinds = map[string]bool{
	"permission_pending": true,
	"question_pending":   true,
	"session_unread":     true,
	"degraded_thinking":  true,
	"degraded_runaway":   true,
	"degraded_stalled":   true,
	"worker_down":        true,
	"session_started":    true,
}

func loadV4Fixture(t *testing.T, name string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(v4FixturePath(name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("fixture %s: not a JSON object: %v", name, err)
	}
	return m
}

func v4WantObject(t *testing.T, ctx string, m map[string]any, key string) map[string]any {
	t.Helper()
	v, ok := m[key]
	if !ok {
		t.Fatalf("%s: missing required field %q", ctx, key)
	}
	obj, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("%s: field %q must be an object, got %T", ctx, key, v)
	}
	return obj
}

func v4WantArray(t *testing.T, ctx string, m map[string]any, key string) []any {
	t.Helper()
	v, ok := m[key]
	if !ok {
		t.Fatalf("%s: missing required field %q", ctx, key)
	}
	arr, ok := v.([]any)
	if !ok {
		t.Fatalf("%s: field %q must be an array, got %T", ctx, key, v)
	}
	return arr
}

func v4WantString(t *testing.T, ctx string, m map[string]any, key string) string {
	t.Helper()
	v, ok := m[key]
	if !ok {
		t.Fatalf("%s: missing required field %q", ctx, key)
	}
	s, ok := v.(string)
	if !ok {
		t.Fatalf("%s: field %q must be a string, got %T", ctx, key, v)
	}
	return s
}

func v4WantInt(t *testing.T, ctx string, m map[string]any, key string) int64 {
	t.Helper()
	v, ok := m[key]
	if !ok {
		t.Fatalf("%s: missing required field %q", ctx, key)
	}
	f, ok := v.(float64)
	if !ok {
		t.Fatalf("%s: field %q must be a JSON number (integer), got %T", ctx, key, v)
	}
	if f != math.Trunc(f) {
		t.Fatalf("%s: field %q must be an integer, got %v", ctx, key, f)
	}
	return int64(f)
}

func v4WantBool(t *testing.T, ctx string, m map[string]any, key string) bool {
	t.Helper()
	v, ok := m[key]
	if !ok {
		t.Fatalf("%s: missing required field %q", ctx, key)
	}
	b, ok := v.(bool)
	if !ok {
		t.Fatalf("%s: field %q must be a boolean, got %T", ctx, key, v)
	}
	return b
}

// v4CheckPublicTs pins THE v4 breaking type change: `ts` on a public
// history surface is a decimal STRING of Unix epoch milliseconds. A JSON
// number decodes as float64 and fails here (numeric is NOT allowed).
func v4CheckPublicTs(t *testing.T, ctx string, ev map[string]any) {
	t.Helper()
	v, ok := ev["ts"]
	if !ok {
		t.Fatalf("%s: missing required field %q", ctx, "ts")
	}
	s, ok := v.(string)
	if !ok {
		t.Fatalf("%s: ts must be a decimal STRING of epoch millis (v4 Position C — breaking, negotiated); JSON numbers are a contract violation, got %T", ctx, v)
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		t.Fatalf("%s: ts %q must be a positive base-10 integer string of epoch millis", ctx, s)
	}
}

// v4CheckHistoryEvent validates one public history event's full schema:
// the v3 base fields (always present), the v4 additive fields, and the
// ts-as-string rule. Returns the event for scenario-level assertions.
func v4CheckHistoryEvent(t *testing.T, idx int, ev map[string]any) map[string]any {
	t.Helper()
	ctx := fmt.Sprintf("events[%d]", idx)
	for _, k := range []string{"id", "type", "sessionID", "root", "project", "title", "detail"} {
		if _, present := ev[k]; !present {
			t.Fatalf("%s: missing required v3 base field %q (always present, no omitempty)", ctx, k)
		}
	}
	v4WantInt(t, ctx, ev, "id")
	for _, k := range []string{"type", "sessionID", "root", "project", "title", "detail"} {
		v4WantString(t, ctx, ev, k)
	}
	v4CheckPublicTs(t, ctx, ev)

	// v4 additive fields (§1 (c)).
	kind := v4WantString(t, ctx, ev, "kind")
	if !v4Kinds[kind] {
		t.Fatalf("%s: kind %q is outside the frozen v4 condition vocabulary %v", ctx, kind, v4Kinds)
	}
	if cnt := v4WantInt(t, ctx, ev, "count"); cnt < 1 {
		t.Fatalf("%s: count must be >= 1, got %d", ctx, cnt)
	}
	v4WantString(t, ctx, ev, "label")
	w := v4WantObject(t, ctx, ev, "worker")
	if id := v4WantString(t, ctx, w, "id"); id == "" {
		t.Fatalf("%s: worker.id must be non-empty", ctx)
	}
	v4WantString(t, ctx, w, "name")
	src := v4WantObject(t, ctx, ev, "source")
	if ep := v4WantString(t, ctx, src, "epoch"); ep == "" {
		t.Fatalf("%s: source.epoch must be non-empty", ctx)
	}
	if sq := v4WantInt(t, ctx, src, "seq"); sq < 0 {
		t.Fatalf("%s: source.seq must be >= 0, got %d", ctx, sq)
	}
	// ui_url: the ONE event field that may be omitted (no usable worker
	// host); when present it MUST be a string — a non-string here is a
	// contract violation. Callers assert presence where the fixture
	// configures hosts.
	if u, present := ev["ui_url"]; present {
		if _, ok := u.(string); !ok {
			t.Fatalf("%s: ui_url must be a string when present, got %T", ctx, u)
		}
	}
	return ev
}

// TestNotifyV4HistoryResponseFixture validates the canonical complete-
// coverage history response: >=3 events covering the required scenarios
// (waiting+question, session_started, daemon worker_down), all additive
// fields present, ts STRINGS, coverage complete, ascending ids, lastId
// head pointer.
func TestNotifyV4HistoryResponseFixture(t *testing.T) {
	m := loadV4Fixture(t, "history_response_v4.json")
	events := v4WantArray(t, "history_response_v4", m, "events")
	if len(events) < 3 {
		t.Fatalf("history fixture must have >= 3 events, got %d", len(events))
	}

	var sawQuestion, sawSessionStarted, sawDaemonDown bool
	var prevID, maxID int64
	for i, raw := range events {
		ev, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("events[%d]: must be an object, got %T", i, raw)
		}
		v4CheckHistoryEvent(t, i, ev)
		// This fixture has worker hosts configured for every event, so
		// ui_url must be present and non-empty on all of them.
		if u := v4WantString(t, fmt.Sprintf("events[%d]", i), ev, "ui_url"); !strings.HasPrefix(u, "http") {
			t.Fatalf("events[%d]: ui_url %q must be an http(s) link", i, u)
		}
		id := v4WantInt(t, "events["+strconv.Itoa(i)+"]", ev, "id")
		// Contiguity, not just strict increase: retention is prefix
		// truncation only (§3.1 (e)), so a served page carries no
		// fabricated central-id holes.
		if i > 0 && id != prevID+1 {
			t.Fatalf("events[%d]: id %d must be exactly previous+1 (contiguous; prefix truncation only — no fabricated holes), previous %d", i, id, prevID)
		}
		prevID, maxID = id, id

		typ := ev["type"].(string)
		kind := ev["kind"].(string)
		switch {
		case typ == "waiting" && kind == "question_pending":
			sawQuestion = true
		case typ == "session_started" && kind == "session_started":
			sawSessionStarted = true
		case typ == "stalled" && kind == "worker_down":
			if ev["sessionID"].(string) != "" || ev["root"].(string) != "" {
				t.Fatalf("events[%d]: daemon-level worker_down must carry EMPTY sessionID/root", i)
			}
			if title := ev["title"].(string); title != "OpenCode" {
				t.Fatalf("events[%d]: daemon-level worker_down title must be \"OpenCode\", got %q", i, title)
			}
			sawDaemonDown = true
		}
	}
	if !sawQuestion || !sawSessionStarted || !sawDaemonDown {
		t.Fatalf("fixture must include waiting+question_pending (%v), session_started (%v), and a daemon worker_down (%v)",
			sawQuestion, sawSessionStarted, sawDaemonDown)
	}

	lastID := v4WantInt(t, "history_response_v4", m, "lastId")
	if lastID < maxID {
		t.Fatalf("lastId %d must be >= max event id %d (committed global head)", lastID, maxID)
	}

	coverage := v4WantObject(t, "history_response_v4", m, "coverage")
	if !v4WantBool(t, "coverage", coverage, "complete") {
		t.Fatal("coverage.complete must be true in the canonical fixture")
	}
	if gaps := v4WantArray(t, "coverage", coverage, "gaps"); len(gaps) != 0 {
		t.Fatalf("coverage.gaps must be empty when complete, got %d entries", len(gaps))
	}
}

// TestNotifyV4HistoryGapsFixture validates the source-gap shape: the same
// per-event schema (ts still a STRING), coverage.complete=false, and gap
// entries naming source_id/epoch and an inclusive from_seq..to_seq range.
// Source gaps must live in coverage — never as fabricated central-id holes
// (the events page itself stays contiguous and ascending).
func TestNotifyV4HistoryGapsFixture(t *testing.T) {
	m := loadV4Fixture(t, "history_response_gaps.json")
	events := v4WantArray(t, "history_response_gaps", m, "events")
	if len(events) == 0 {
		t.Fatal("gaps fixture must contain events")
	}
	var prevID int64
	for i, raw := range events {
		ev, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("events[%d]: must be an object, got %T", i, raw)
		}
		v4CheckHistoryEvent(t, i, ev)
		id := v4WantInt(t, "events["+strconv.Itoa(i)+"]", ev, "id")
		if i > 0 && id != prevID+1 {
			t.Fatalf("events[%d]: central ids must stay contiguous (no fabricated holes): id %d follows %d", i, id, prevID)
		}
		prevID = id
	}
	v4WantInt(t, "history_response_gaps", m, "lastId")

	coverage := v4WantObject(t, "history_response_gaps", m, "coverage")
	if v4WantBool(t, "coverage", coverage, "complete") {
		t.Fatal("coverage.complete must be false when gaps are reported")
	}
	gaps := v4WantArray(t, "coverage", coverage, "gaps")
	if len(gaps) == 0 {
		t.Fatal("coverage.gaps must be non-empty when complete=false")
	}
	for i, raw := range gaps {
		g, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("coverage.gaps[%d]: must be an object, got %T", i, raw)
		}
		ctx := fmt.Sprintf("coverage.gaps[%d]", i)
		if sid := v4WantString(t, ctx, g, "source_id"); sid == "" {
			t.Fatalf("%s: source_id must be non-empty", ctx)
		}
		if ep := v4WantString(t, ctx, g, "epoch"); ep == "" {
			t.Fatalf("%s: epoch must be non-empty", ctx)
		}
		from := v4WantInt(t, ctx, g, "from_seq")
		to := v4WantInt(t, ctx, g, "to_seq")
		// The EMPTY-RANGE sentinel {from_seq:1, to_seq:0} is the one legal
		// from>to shape: the worker standalone surface (pkg/web
		// notify_feature.go) emits it for an epoch whose unknown-extent
		// prefix is entirely gone (rotation with discontinuity before
		// enrollment/overflow). Sanctioned additive in S5 (README note in
		// testdata/notify_v4/); every other from>to remains malformed.
		if from == 1 && to == 0 {
			continue
		}
		if from < 0 || to < from {
			t.Fatalf("%s: need 0 <= from_seq <= to_seq (or the {1,0} empty-range sentinel), got [%d..%d]", ctx, from, to)
		}
	}
}

// TestNotifyV4RegistrationRequestFixture pins the central registration
// request: the exact v3 shape (token/label/push_policy) — full-state POST
// semantics unchanged, only served centrally now.
func TestNotifyV4RegistrationRequestFixture(t *testing.T) {
	m := loadV4Fixture(t, "registration_request_v4.json")
	if tok := v4WantString(t, "registration_request", m, "token"); tok == "" {
		t.Fatal("token must be non-empty")
	}
	v4WantString(t, "registration_request", m, "label")
	pol := v4WantString(t, "registration_request", m, "push_policy")
	if pol != "when_unattended" && pol != "always" {
		t.Fatalf("push_policy must be when_unattended|always, got %q", pol)
	}
}

// TestNotifyV4ProbeResponseFixture pins the central probe response: v3
// field shape with central-`enabled` semantics (controller sender
// readiness); policy counts sum to count; never token material.
func TestNotifyV4ProbeResponseFixture(t *testing.T) {
	m := loadV4Fixture(t, "probe_response_v4.json")
	v4WantBool(t, "probe", m, "enabled")
	count := v4WantInt(t, "probe", m, "count")
	pol := v4WantObject(t, "probe", m, "policies")
	wu := v4WantInt(t, "probe.policies", pol, "when_unattended")
	al := v4WantInt(t, "probe.policies", pol, "always")
	if wu < 0 || al < 0 {
		t.Fatalf("policy counts must be >= 0, got when_unattended=%d always=%d", wu, al)
	}
	if wu+al != count {
		t.Fatalf("policy counts must sum to count: %d+%d != %d", wu, al, count)
	}
	// last_attempt/last_error: LATEST-COMPLETED-ATTEMPT pair — string-typed,
	// empty until an attempt completes; never carries token material.
	v4WantString(t, "probe", m, "last_attempt")
	v4WantString(t, "probe", m, "last_error")
}

// TestNotifyV4FCMMessageFixture pins the v4 FCM data-only message: the
// five existing vh_* keys (semantics unchanged) plus the five additive v4
// keys, every value a string, no `notification` block, waiting→HIGH
// priority with collapse-by-event, ttl in "<n>s" form.
func TestNotifyV4FCMMessageFixture(t *testing.T) {
	m := loadV4Fixture(t, "fcm_message_v4.json")
	msg := v4WantObject(t, "fcm_message", m, "message")
	if tok := v4WantString(t, "message", msg, "token"); tok == "" {
		t.Fatal("message.token must be non-empty")
	}
	if _, hasNotification := msg["notification"]; hasNotification {
		t.Fatal("message must be data-only: no `notification` block")
	}
	data := v4WantObject(t, "message", msg, "data")

	wantKeys := []string{
		// existing five (v1–v3, unchanged)
		"vh_kind", "vh_event", "vh_condition", "vh_count", "vh_ts",
		// additive five (v4 §1 (f))
		"vh_worker_id", "vh_worker_name", "vh_session_id", "vh_history_id", "vh_ui_url",
	}
	got := map[string]bool{}
	for k, v := range data {
		if _, ok := v.(string); !ok {
			t.Fatalf("data.%s must be a string (FCM data-message requirement), got %T", k, v)
		}
		got[k] = true
	}
	for _, k := range wantKeys {
		if !got[k] {
			t.Fatalf("data missing required key %q", k)
		}
	}
	if len(got) != len(wantKeys) {
		t.Fatalf("golden data shape has exactly the %d contract keys, got %d", len(wantKeys), len(got))
	}

	if kv := v4WantString(t, "data", data, "vh_kind"); kv != "notice" {
		t.Fatalf("vh_kind must be \"notice\", got %q", kv)
	}
	if ev := v4WantString(t, "data", data, "vh_event"); ev != "waiting" {
		t.Fatalf("golden message must demonstrate waiting (HIGH-priority class), got %q", ev)
	}
	if cond := v4WantString(t, "data", data, "vh_condition"); !v4Kinds[cond] {
		t.Fatalf("vh_condition %q outside the frozen v4 condition vocabulary", cond)
	}
	if c := v4WantString(t, "data", data, "vh_count"); c != "1" {
		t.Fatalf("vh_count is fixed \"1\", got %q", c)
	}
	if ts := v4WantString(t, "data", data, "vh_ts"); ts == "" {
		t.Fatal("vh_ts must be non-empty")
	} else if n, err := strconv.ParseInt(ts, 10, 64); err != nil || n <= 0 {
		t.Fatalf("vh_ts %q must be positive epoch-millis digits", ts)
	}
	if hid := v4WantString(t, "data", data, "vh_history_id"); hid == "" {
		t.Fatal("vh_history_id must be non-empty (decimal string of the central id)")
	}
	if u := v4WantString(t, "data", data, "vh_ui_url"); !strings.HasPrefix(u, "http") {
		t.Fatalf("vh_ui_url %q must be an http(s) link", u)
	}

	android := v4WantObject(t, "message", msg, "android")
	if p := v4WantString(t, "android", android, "priority"); p != "HIGH" {
		t.Fatalf("waiting must map to HIGH priority (Android Doze), got %q", p)
	}
	if ck := v4WantString(t, "android", android, "collapse_key"); ck != "waiting" {
		t.Fatalf("collapse_key must equal vh_event (\"waiting\"), got %q", ck)
	}
	ttl := v4WantString(t, "android", android, "ttl")
	if len(ttl) < 2 || ttl[len(ttl)-1] != 's' || !isDigits(ttl[:len(ttl)-1]) {
		t.Fatalf("ttl must be \"<n>s\" protobuf-duration form, got %q", ttl)
	}
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
