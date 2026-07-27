package quota

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// fetchKimi reads Kimi-for-coding usage (weekly + per-window rate limits).
func fetchKimi(ctx context.Context, auth map[string]json.RawMessage) ProviderResult {
	res := ProviderResult{ProviderID: "kimi-for-coding", ProviderName: "Kimi for Coding", FetchedAt: time.Now().UnixMilli()}
	e := entry(auth, "kimi-for-coding", "kimi")
	key := str(e, "key", "token")
	if key == "" {
		res.Error = "Not configured"
		return res
	}
	res.Configured = true
	payload, _, err := getJSON(ctx, "https://api.kimi.com/coding/v1/usages", bearerJSON(key))
	if err != nil {
		res.Error = err.Error()
		return res
	}
	if usage := obj(payload, "usage"); usage != nil {
		limit, hasL := toNumber(usage["limit"])
		remaining, hasR := toNumber(usage["remaining"])
		var up *float64
		if hasL && hasR && limit > 0 {
			up = f64p(clampPct(100 - remaining/limit*100))
		}
		res.Windows = append(res.Windows, makeWindow("weekly", up, nil, toTimestampMillis(usage["resetTime"]), ""))
	}
	for _, it := range arr(payload, "limits") {
		lm, ok := it.(map[string]any)
		if !ok {
			continue
		}
		window := obj(lm, "window")
		detail := obj(lm, "detail")
		duration, _ := toNumber(window["duration"])
		unit, _ := window["timeUnit"].(string)
		rawLabel := durationToLabel(duration, unit)
		ws := durationToSeconds(duration, unit)
		label := rawLabel
		if ws != nil && *ws == 5*60*60 {
			label = fmt.Sprintf("Rate Limit (%s)", rawLabel)
		}
		total, hasT := toNumber(detail["limit"])
		remaining, hasR := toNumber(detail["remaining"])
		var up *float64
		if hasT && hasR && total > 0 {
			up = f64p(clampPct(100 - remaining/total*100))
		}
		res.Windows = append(res.Windows, makeWindow(label, up, ws, toTimestampMillis(detail["resetTime"]), ""))
	}
	res.OK = true
	return res
}
