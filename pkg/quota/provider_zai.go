package quota

import (
	"context"
	"encoding/json"
	"time"
)

// fetchZai reads the z.ai coding-plan token window.
func fetchZai(ctx context.Context, auth map[string]json.RawMessage) ProviderResult {
	res := ProviderResult{ProviderID: "zai-coding-plan", ProviderName: "z.ai", FetchedAt: time.Now().UnixMilli()}
	e := entry(auth, "zai-coding-plan", "zai", "z.ai")
	key := str(e, "key", "token")
	if key == "" {
		res.Error = "Not configured"
		return res
	}
	res.Configured = true
	payload, _, err := getJSON(ctx, "https://api.z.ai/api/monitor/usage/quota/limit", bearerJSON(key))
	if err != nil {
		res.Error = err.Error()
		return res
	}
	limits := arr(obj(payload, "data"), "limits")
	if tl := findLimit(limits, "TOKENS_LIMIT"); tl != nil {
		ws := zaiWindowSeconds(tl)
		var up *float64
		if n, ok := toNumber(tl["percentage"]); ok {
			up = f64p(n)
		}
		res.Windows = append(res.Windows, makeWindow(resolveWindowLabel(ws), up, ws, toTimestampMillis(tl["nextResetTime"]), ""))
	}
	res.OK = true
	return res
}
