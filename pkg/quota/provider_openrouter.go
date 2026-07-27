package quota

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"time"
)

// fetchOpenRouter reads credit balance (used vs total).
func fetchOpenRouter(ctx context.Context, auth map[string]json.RawMessage) ProviderResult {
	res := ProviderResult{ProviderID: "openrouter", ProviderName: "OpenRouter", FetchedAt: time.Now().UnixMilli()}
	e := entry(auth, "openrouter")
	key := str(e, "key", "token")
	if key == "" {
		res.Error = "Not configured"
		return res
	}
	res.Configured = true
	payload, _, err := getJSON(ctx, "https://openrouter.ai/api/v1/credits", map[string]string{
		"Authorization": "Bearer " + key, "Content-Type": "application/json",
	})
	if err != nil {
		res.Error = err.Error()
		return res
	}
	data := obj(payload, "data")
	total, hasTotal := toNumber(data["total_credits"])
	usage, hasUsage := toNumber(data["total_usage"])
	var up *float64
	label := ""
	if hasTotal && hasUsage && total > 0 {
		up = f64p(math.Max(0, math.Min(100, usage/total*100)))
		label = fmt.Sprintf("$%.2f remaining", math.Max(0, total-usage))
	}
	res.Windows = append(res.Windows, makeWindow("credits", up, nil, nil, label))
	res.OK = true
	return res
}
