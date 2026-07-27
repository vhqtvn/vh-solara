package quota

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// fetchCodex reads ChatGPT/Codex rate-limit windows + credit balance.
func fetchCodex(ctx context.Context, auth map[string]json.RawMessage) ProviderResult {
	res := ProviderResult{ProviderID: "codex", ProviderName: "Codex", FetchedAt: time.Now().UnixMilli()}
	e := entry(auth, "openai", "codex", "chatgpt")
	token := str(e, "access", "token")
	if token == "" {
		res.Error = "Not configured"
		return res
	}
	res.Configured = true
	headers := map[string]string{"Authorization": "Bearer " + token, "Content-Type": "application/json"}
	if acct := str(e, "accountId"); acct != "" {
		headers["ChatGPT-Account-Id"] = acct
	}
	payload, _, err := getJSON(ctx, "https://chatgpt.com/backend-api/wham/usage", headers)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	rl := obj(payload, "rate_limit")
	addRL := func(label, key string) {
		w := obj(rl, key)
		if w == nil {
			return
		}
		var up *float64
		if n, ok := toNumber(w["used_percent"]); ok {
			up = f64p(n)
		}
		var ws *int64
		if n, ok := toNumber(w["limit_window_seconds"]); ok {
			s := int64(n)
			ws = &s
		}
		res.Windows = append(res.Windows, makeWindow(label, up, ws, toTimestampMillis(w["reset_at"]), ""))
	}
	if rl != nil {
		addRL("5h", "primary_window")
		addRL("weekly", "secondary_window")
	}
	if credits := obj(payload, "credits"); credits != nil {
		label := ""
		if u, _ := credits["unlimited"].(bool); u {
			label = "Unlimited"
		} else if bal, ok := toNumber(credits["balance"]); ok {
			label = fmt.Sprintf("$%.2f remaining", bal)
		}
		if label != "" {
			res.Windows = append(res.Windows, makeWindow("credits", nil, nil, nil, label))
		}
	}
	res.OK = true
	return res
}
