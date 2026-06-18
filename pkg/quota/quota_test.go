package quota

import "testing"

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
		t.Errorf("nanoPercent nested limit = %v, want 25", p)
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
