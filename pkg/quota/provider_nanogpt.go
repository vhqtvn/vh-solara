package quota

import (
	"context"
	"encoding/json"
	"time"
)

// fetchNanoGpt reads NanoGPT subscription daily/monthly usage.
func fetchNanoGpt(ctx context.Context, auth map[string]json.RawMessage) ProviderResult {
	res := ProviderResult{ProviderID: "nano-gpt", ProviderName: "NanoGPT", FetchedAt: time.Now().UnixMilli()}
	e := entry(auth, "nano-gpt", "nanogpt", "nano_gpt")
	key := str(e, "key", "token")
	if key == "" {
		res.Error = "Not configured"
		return res
	}
	res.Configured = true
	payload, _, err := getJSON(ctx, "https://nano-gpt.com/api/subscription/v1/usage", bearerJSON(key))
	if err != nil {
		res.Error = err.Error()
		return res
	}
	state := str(payload, "state")
	if state == "" {
		state = "active"
	}
	valueLabel := ""
	if state != "active" {
		valueLabel = "(" + state + ")"
	}
	period := obj(payload, "period")
	if daily := obj(payload, "daily"); daily != nil {
		var ws int64 = 86400
		res.Windows = append(res.Windows, makeWindow("daily", nanoPercent(daily, "daily"), &ws, toTimestampMillis(daily["resetAt"]), valueLabel))
	}
	if monthly := obj(payload, "monthly"); monthly != nil {
		reset := monthly["resetAt"]
		if reset == nil && period != nil {
			reset = period["currentPeriodEnd"]
		}
		res.Windows = append(res.Windows, makeWindow("monthly", nanoPercent(monthly, "monthly"), nil, toTimestampMillis(reset), valueLabel))
	}
	res.OK = true
	return res
}
