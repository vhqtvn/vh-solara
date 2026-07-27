package quota

import (
	"context"
	"encoding/json"
	"time"
)

// fetchClaude reads Anthropic OAuth usage (Pro/Max subscription windows).
func fetchClaude(ctx context.Context, auth map[string]json.RawMessage) ProviderResult {
	res := ProviderResult{ProviderID: "claude", ProviderName: "Claude", FetchedAt: time.Now().UnixMilli()}
	e := entry(auth, "anthropic", "claude")
	token := str(e, "access", "token")
	if token == "" {
		res.Error = "Not configured"
		return res
	}
	res.Configured = true
	payload, _, err := getJSON(ctx, "https://api.anthropic.com/api/oauth/usage", map[string]string{
		"Authorization":  "Bearer " + token,
		"anthropic-beta": "oauth-2025-04-20",
	})
	if err != nil {
		res.Error = err.Error()
		return res
	}
	add := func(label, key string) {
		w := obj(payload, key)
		if w == nil {
			return
		}
		var up *float64
		if n, ok := toNumber(w["utilization"]); ok {
			up = f64p(n)
		}
		res.Windows = append(res.Windows, makeWindow(label, up, nil, toTimestampMillis(w["resets_at"]), ""))
	}
	add("5h", "five_hour")
	add("7d", "seven_day")
	add("7d-sonnet", "seven_day_sonnet")
	add("7d-opus", "seven_day_opus")
	res.OK = true
	return res
}
