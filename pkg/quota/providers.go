package quota

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
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

func fetchCopilotUser(ctx context.Context, token string) (map[string]any, error) {
	payload, _, err := getJSON(ctx, "https://api.github.com/copilot_internal/user", map[string]string{
		"Authorization":        "token " + token, // GitHub uses `token`, not `Bearer`
		"Accept":               "application/json",
		"Editor-Version":       "vscode/1.96.2",
		"X-Github-Api-Version": "2025-04-01",
	})
	return payload, err
}

// fetchCopilot reads GitHub Copilot chat/completions/premium windows.
func fetchCopilot(ctx context.Context, auth map[string]json.RawMessage) ProviderResult {
	res := ProviderResult{ProviderID: "github-copilot", ProviderName: "GitHub Copilot", FetchedAt: time.Now().UnixMilli()}
	e := entry(auth, "github-copilot", "copilot")
	token := str(e, "access", "token")
	if token == "" {
		res.Error = "Not configured"
		return res
	}
	res.Configured = true
	payload, err := fetchCopilotUser(ctx, token)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	res.Windows = buildCopilotWindows(payload)
	res.OK = true
	return res
}

// fetchCopilotAddon reports only the Copilot premium-interactions window.
func fetchCopilotAddon(ctx context.Context, auth map[string]json.RawMessage) ProviderResult {
	res := ProviderResult{ProviderID: "github-copilot-addon", ProviderName: "GitHub Copilot Add-on", FetchedAt: time.Now().UnixMilli()}
	e := entry(auth, "github-copilot", "copilot")
	token := str(e, "access", "token")
	if token == "" {
		res.Error = "Not configured"
		return res
	}
	res.Configured = true
	payload, err := fetchCopilotUser(ctx, token)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	windows := buildCopilotWindows(payload)
	for _, w := range windows {
		if w.Label == "premium" {
			res.Windows = []UsageWindow{w}
			break
		}
	}
	if res.Windows == nil {
		res.Windows = windows
	}
	res.OK = true
	return res
}
