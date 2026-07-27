package quota

import (
	"encoding/json"
	"testing"
	"time"
)

func TestResolveWindowLabel(t *testing.T) {
	s := func(v int64) *int64 { return &v }
	cases := []struct {
		in   *int64
		want string
	}{
		{nil, "tokens"},
		{s(0), "tokens"},
		{s(3600), "1h"},
		{s(5 * 3600), "5h"},
		{s(86400), "1d"},
		{s(7 * 86400), "weekly"},
		{s(3 * 86400), "3d"},
		{s(90), "90s"},
	}
	for _, c := range cases {
		if got := resolveWindowLabel(c.in); got != c.want {
			t.Errorf("resolveWindowLabel(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestZaiWindowSeconds(t *testing.T) {
	// unit 3 (hours) * number 5 = 5h
	got := zaiWindowSeconds(map[string]any{"unit": float64(3), "number": float64(5)})
	if got == nil || *got != 5*3600 {
		t.Fatalf("zaiWindowSeconds = %v, want 18000", got)
	}
	// unknown unit -> nil
	if zaiWindowSeconds(map[string]any{"unit": float64(9), "number": float64(5)}) != nil {
		t.Errorf("expected nil for unknown unit")
	}
	if zaiWindowSeconds(nil) != nil {
		t.Errorf("expected nil for nil limit")
	}
}

func TestDurationToSecondsAndLabel(t *testing.T) {
	if s := durationToSeconds(5, "TIME_UNIT_HOUR"); s == nil || *s != 5*3600 {
		t.Errorf("durationToSeconds(5,HOUR) = %v", s)
	}
	if s := durationToSeconds(10, "TIME_UNIT_MINUTE"); s == nil || *s != 600 {
		t.Errorf("durationToSeconds(10,MIN) = %v", s)
	}
	if durationToSeconds(0, "TIME_UNIT_DAY") != nil {
		t.Errorf("zero duration should be nil")
	}
	if l := durationToLabel(7, "TIME_UNIT_DAY"); l != "7d" {
		t.Errorf("durationToLabel = %q", l)
	}
	if l := durationToLabel(0, ""); l != "limit" {
		t.Errorf("durationToLabel fallback = %q", l)
	}
}

func TestNanoPercent(t *testing.T) {
	if p := nanoPercent(map[string]any{"percentUsed": float64(0.42)}, "daily"); p == nil || *p != 42 {
		t.Errorf("nanoPercent percentUsed = %v, want 42", p)
	}
	if p := nanoPercent(map[string]any{"used": float64(25), "limit": float64(100)}, "daily"); p == nil || *p != 25 {
		t.Errorf("nanoPercent used/limit = %v, want 25", p)
	}
	// limit nested under .limits[key]
	if p := nanoPercent(map[string]any{"used": float64(10), "limits": map[string]any{"monthly": float64(40)}}, "monthly"); p == nil || *p != 25 {
		t.Errorf("nanoPercent nested limit = %v", p)
	}
	if nanoPercent(map[string]any{}, "daily") != nil {
		t.Errorf("expected nil with no data")
	}
}

func TestBuildCopilotWindows(t *testing.T) {
	payload := map[string]any{
		"quota_reset_date": "2026-07-01T00:00:00Z",
		"quota_snapshots": map[string]any{
			"chat":                 map[string]any{"entitlement": float64(100), "remaining": float64(75)},
			"premium_interactions": map[string]any{"entitlement": float64(50), "remaining": float64(0)},
		},
	}
	w := buildCopilotWindows(payload)
	if len(w) != 2 {
		t.Fatalf("expected 2 windows, got %d", len(w))
	}
	if w[0].Label != "chat" || w[0].UsedPercent == nil || *w[0].UsedPercent != 25 {
		t.Errorf("chat window wrong: %+v", w[0])
	}
	if w[1].Label != "premium" || w[1].UsedPercent == nil || *w[1].UsedPercent != 100 {
		t.Errorf("premium window wrong: %+v", w[1])
	}
	if w[1].ValueLabel != "0 / 50 left" {
		t.Errorf("premium valueLabel = %q", w[1].ValueLabel)
	}
}

func TestFindLimit(t *testing.T) {
	limits := []any{
		map[string]any{"type": "TOKENS_LIMIT", "percentage": float64(30)},
		map[string]any{"type": "TIME_LIMIT", "percentage": float64(10)},
	}
	if m := findLimit(limits, "TIME_LIMIT"); m == nil || m["percentage"] != float64(10) {
		t.Errorf("findLimit TIME_LIMIT = %v", m)
	}
	if findLimit(limits, "NOPE") != nil {
		t.Errorf("expected nil for missing type")
	}
}

// The pure cross-provider helpers below were previously untested; they are the
// shared parsing toolkit every provider relies on, so they get co-located
// coverage here alongside the provider-specific helpers above.

func TestEntry(t *testing.T) {
	auth := map[string]json.RawMessage{
		"bare":   json.RawMessage(`"tok123"`),
		"obj":    json.RawMessage(`{"access":"a","accountId":"acct1"}`),
		"empty":  json.RawMessage(`""`),
		"broken": json.RawMessage(`{not json`),
	}
	// bare-string token normalizes to {"token": ...}
	if e := entry(auth, "bare"); e == nil || e["token"] != "tok123" {
		t.Errorf("entry(bare) = %v", e)
	}
	// object form passes through
	if e := entry(auth, "obj"); e == nil || e["access"] != "a" || e["accountId"] != "acct1" {
		t.Errorf("entry(obj) = %v", e)
	}
	// empty string is skipped, falls through to nil
	if e := entry(auth, "empty"); e != nil {
		t.Errorf("entry(empty) = %v, want nil", e)
	}
	// broken JSON falls through (Unmarshal fails) to nil
	if e := entry(auth, "broken"); e != nil {
		t.Errorf("entry(broken) = %v, want nil", e)
	}
	// alias resolution: first missing, second hit
	if e := entry(auth, "missing", "obj"); e == nil || e["access"] != "a" {
		t.Errorf("entry alias resolution = %v", e)
	}
	// nothing matches
	if entry(auth, "nope1", "nope2") != nil {
		t.Errorf("entry(no-match) want nil")
	}
}

func TestStr(t *testing.T) {
	m := map[string]any{"a": "", "b": "hit", "c": "later"}
	if got := str(m, "a", "b", "c"); got != "hit" {
		t.Errorf("str want first non-empty = %q", got)
	}
	if got := str(m, "a"); got != "" {
		t.Errorf("str empty want %q got %q", "", got)
	}
}

func TestToNumber(t *testing.T) {
	if f, ok := toNumber(float64(3.5)); !ok || f != 3.5 {
		t.Errorf("toNumber(float64) = %v,%v", f, ok)
	}
	if f, ok := toNumber(json.Number("42")); !ok || f != 42 {
		t.Errorf("toNumber(json.Number) = %v,%v", f, ok)
	}
	if f, ok := toNumber("17.5"); !ok || f != 17.5 {
		t.Errorf("toNumber(string) = %v,%v", f, ok)
	}
	if _, ok := toNumber("not-a-number"); ok {
		t.Errorf("toNumber(garbage) want false")
	}
	if _, ok := toNumber(true); ok {
		t.Errorf("toNumber(bool) want false")
	}
}

func TestToTimestampMillis(t *testing.T) {
	// seconds-scale float is multiplied up to millis
	if ms := toTimestampMillis(float64(1_700_000_000)); ms == nil || *ms != 1_700_000_000_000 {
		t.Errorf("toTimestampMillis(seconds) = %v", ms)
	}
	// millis-scale float passes through
	if ms := toTimestampMillis(float64(1_700_000_000_000)); ms == nil || *ms != 1_700_000_000_000 {
		t.Errorf("toTimestampMillis(millis) = %v", ms)
	}
	// RFC3339 string -> its UnixMilli
	want := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	if ms := toTimestampMillis("2026-07-01T00:00:00Z"); ms == nil || *ms != want {
		t.Errorf("toTimestampMillis(rfc3339) = %v, want %d", ms, want)
	}
	if toTimestampMillis("garbage") != nil {
		t.Errorf("toTimestampMillis(garbage) want nil")
	}
	if toTimestampMillis(true) != nil {
		t.Errorf("toTimestampMillis(bool) want nil")
	}
}

func TestClampPct(t *testing.T) {
	if clampPct(-5) != 0 {
		t.Errorf("clampPct(-5) want 0")
	}
	if clampPct(150) != 100 {
		t.Errorf("clampPct(150) want 100")
	}
	if clampPct(42) != 42 {
		t.Errorf("clampPct(42) want 42")
	}
}

func TestObjArr(t *testing.T) {
	m := map[string]any{
		"o": map[string]any{"k": 1},
		"a": []any{1, 2},
	}
	if obj(m, "o")["k"] != 1 {
		t.Errorf("obj miss")
	}
	if obj(m, "missing") != nil {
		t.Errorf("obj missing want nil")
	}
	if obj(m, "a") != nil { // a is array, not object
		t.Errorf("obj on array want nil")
	}
	if len(arr(m, "a")) != 2 {
		t.Errorf("arr len want 2")
	}
	if arr(m, "o") != nil { // o is object, not array
		t.Errorf("arr on object want nil")
	}
	if arr(m, "missing") != nil {
		t.Errorf("arr missing want nil")
	}
}

func TestMakeWindow(t *testing.T) {
	// usedPercent set -> RemainingPercent derived and clamped at >=0
	w := makeWindow("5h", f64p(30), nil, nil, "lbl")
	if w.Label != "5h" || w.ValueLabel != "lbl" {
		t.Errorf("makeWindow passthrough wrong: %+v", w)
	}
	if w.UsedPercent == nil || *w.UsedPercent != 30 {
		t.Errorf("UsedPercent = %v", w.UsedPercent)
	}
	if w.RemainingPercent == nil || *w.RemainingPercent != 70 {
		t.Errorf("RemainingPercent = %v, want 70", w.RemainingPercent)
	}
	if w.ResetAfterSeconds != nil {
		t.Errorf("ResetAfterSeconds want nil when resetAt nil")
	}

	// over-100 used clamps RemainingPercent to 0
	w2 := makeWindow("x", f64p(150), nil, nil, "")
	if w2.RemainingPercent == nil || *w2.RemainingPercent != 0 {
		t.Errorf("clamped RemainingPercent = %v, want 0", w2.RemainingPercent)
	}

	// nil usedPercent -> nil RemainingPercent
	w3 := makeWindow("x", nil, nil, nil, "")
	if w3.RemainingPercent != nil {
		t.Errorf("nil used -> RemainingPercent want nil")
	}

	// future resetAt -> ResetAfterSeconds set and >=0, ResetAt passed through
	futureMs := time.Now().Add(100 * time.Second).UnixMilli()
	w4 := makeWindow("x", nil, nil, &futureMs, "")
	if w4.ResetAt == nil || *w4.ResetAt != futureMs {
		t.Errorf("ResetAt passthrough wrong: %v", w4.ResetAt)
	}
	if w4.ResetAfterSeconds == nil || *w4.ResetAfterSeconds <= 0 || *w4.ResetAfterSeconds > 100 {
		t.Errorf("ResetAfterSeconds = %v, want (0,100]", w4.ResetAfterSeconds)
	}
}
