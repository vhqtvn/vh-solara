package quota

import (
	"context"
	"encoding/json"
	"time"
)

// fetchZhipuai reads Zhipu AI coding-plan token + MCP-tools windows.
func fetchZhipuai(ctx context.Context, auth map[string]json.RawMessage) ProviderResult {
	res := ProviderResult{ProviderID: "zhipuai-coding-plan", ProviderName: "Zhipu AI Coding Plan", FetchedAt: time.Now().UnixMilli()}
	e := entry(auth, "zhipuai-coding-plan")
	key := str(e, "key", "token")
	if key == "" {
		res.Error = "Not configured"
		return res
	}
	res.Configured = true
	payload, _, err := getJSON(ctx, "https://open.bigmodel.cn/api/monitor/usage/quota/limit", bearerJSON(key))
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
		res.Windows = append(res.Windows, makeWindow("Tokens", up, ws, toTimestampMillis(tl["nextResetTime"]), ""))
	}
	if ml := findLimit(limits, "TIME_LIMIT"); ml != nil {
		var monthSeconds int64 = 30 * 24 * 60 * 60 // unit=5 means a 30-day MCP window
		var up *float64
		if n, ok := toNumber(ml["percentage"]); ok {
			up = f64p(n)
		}
		res.Windows = append(res.Windows, makeWindow("MCP Tools", up, &monthSeconds, toTimestampMillis(ml["nextResetTime"]), ""))
	}
	res.OK = true
	return res
}
