package quota

import (
	"encoding/json"
	"fmt"
	"math"
	"time"
)

// entry pulls the first matching auth entry and normalizes a bare-string token.
func entry(auth map[string]json.RawMessage, aliases ...string) map[string]any {
	for _, a := range aliases {
		raw, ok := auth[a]
		if !ok {
			continue
		}
		var s string
		if json.Unmarshal(raw, &s) == nil && s != "" {
			return map[string]any{"token": s}
		}
		var m map[string]any
		if json.Unmarshal(raw, &m) == nil && m != nil {
			return m
		}
	}
	return nil
}

func str(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func toNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case string:
		var f float64
		if _, err := fmt.Sscanf(n, "%g", &f); err == nil {
			return f, true
		}
	}
	return 0, false
}

// toTimestampMillis converts seconds-or-millis epoch / RFC3339 to ms.
func toTimestampMillis(v any) *int64 {
	switch t := v.(type) {
	case float64:
		ms := int64(t)
		if ms < 1_000_000_000_000 {
			ms *= 1000
		}
		return &ms
	case string:
		if parsed, err := time.Parse(time.RFC3339, t); err == nil {
			ms := parsed.UnixMilli()
			return &ms
		}
	}
	return nil
}

func f64p(v float64) *float64 { return &v }

func makeWindow(label string, usedPercent *float64, windowSeconds *int64, resetAt *int64, valueLabel string) UsageWindow {
	w := UsageWindow{Label: label, UsedPercent: usedPercent, WindowSeconds: windowSeconds, ResetAt: resetAt, ValueLabel: valueLabel}
	if usedPercent != nil {
		w.RemainingPercent = f64p(math.Max(0, 100-*usedPercent))
	}
	if resetAt != nil {
		delta := (*resetAt - time.Now().UnixMilli()) / 1000
		if delta < 0 {
			delta = 0
		}
		w.ResetAfterSeconds = &delta
	}
	return w
}

func obj(m map[string]any, key string) map[string]any {
	if v, ok := m[key].(map[string]any); ok {
		return v
	}
	return nil
}

func arr(m map[string]any, key string) []any {
	if v, ok := m[key].([]any); ok {
		return v
	}
	return nil
}

func bearerJSON(key string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + key, "Content-Type": "application/json"}
}

func clampPct(v float64) float64 { return math.Max(0, math.Min(100, v)) }

// findLimit returns the first entry in a z.ai/zhipuai `data.limits` array whose
// `type` matches.
func findLimit(limits []any, typ string) map[string]any {
	for _, it := range limits {
		if m, ok := it.(map[string]any); ok {
			if t, _ := m["type"].(string); t == typ {
				return m
			}
		}
	}
	return nil
}

// zaiWindowSeconds maps a z.ai/zhipuai limit's {unit,number} to seconds.
// ZAI_TOKEN_WINDOW_SECONDS = {3: 3600} — unit 3 means hours.
func zaiWindowSeconds(limit map[string]any) *int64 {
	if limit == nil {
		return nil
	}
	num, ok := toNumber(limit["number"])
	if !ok {
		return nil
	}
	unit, _ := toNumber(limit["unit"])
	if int(unit) != 3 {
		return nil
	}
	s := int64(3600 * num)
	return &s
}

// resolveWindowLabel renders a window-seconds count as weekly/Nd/Nh/Ns.
func resolveWindowLabel(windowSeconds *int64) string {
	if windowSeconds == nil || *windowSeconds == 0 {
		return "tokens"
	}
	ws := *windowSeconds
	if ws%86400 == 0 {
		if days := ws / 86400; days == 7 {
			return "weekly"
		} else {
			return fmt.Sprintf("%dd", days)
		}
	}
	if ws%3600 == 0 {
		return fmt.Sprintf("%dh", ws/3600)
	}
	return fmt.Sprintf("%ds", ws)
}

func durationToLabel(duration float64, unit string) string {
	if duration == 0 || unit == "" {
		return "limit"
	}
	switch unit {
	case "TIME_UNIT_MINUTE":
		return fmt.Sprintf("%dm", int64(duration))
	case "TIME_UNIT_HOUR":
		return fmt.Sprintf("%dh", int64(duration))
	case "TIME_UNIT_DAY":
		return fmt.Sprintf("%dd", int64(duration))
	}
	return "limit"
}

func durationToSeconds(duration float64, unit string) *int64 {
	if duration == 0 || unit == "" {
		return nil
	}
	var mult int64
	switch unit {
	case "TIME_UNIT_MINUTE":
		mult = 60
	case "TIME_UNIT_HOUR":
		mult = 3600
	case "TIME_UNIT_DAY":
		mult = 86400
	default:
		return nil
	}
	s := int64(duration) * mult
	return &s
}

func nanoPercent(m map[string]any, key string) *float64 {
	if pu, ok := toNumber(m["percentUsed"]); ok {
		return f64p(clampPct(pu * 100))
	}
	used, hasU := toNumber(m["used"])
	limit, hasL := toNumber(m["limit"])
	if !hasL {
		if lm := obj(m, "limits"); lm != nil {
			limit, hasL = toNumber(lm[key])
		}
	}
	if hasU && hasL && limit > 0 {
		return f64p(clampPct(used / limit * 100))
	}
	return nil
}

// buildCopilotWindows turns a GitHub Copilot quota_snapshots payload into windows.
func buildCopilotWindows(payload map[string]any) []UsageWindow {
	quota := obj(payload, "quota_snapshots")
	resetAt := toTimestampMillis(payload["quota_reset_date"])
	var windows []UsageWindow
	add := func(label, key string) {
		snap := obj(quota, key)
		if snap == nil {
			return
		}
		entitlement, hasE := toNumber(snap["entitlement"])
		remaining, hasR := toNumber(snap["remaining"])
		var up *float64
		if hasE && hasR && entitlement > 0 {
			up = f64p(clampPct(100 - remaining/entitlement*100))
		}
		valueLabel := ""
		if hasE && hasR {
			valueLabel = fmt.Sprintf("%.0f / %.0f left", remaining, entitlement)
		}
		windows = append(windows, makeWindow(label, up, nil, resetAt, valueLabel))
	}
	add("chat", "chat")
	add("completions", "completions")
	add("premium", "premium_interactions")
	return windows
}
