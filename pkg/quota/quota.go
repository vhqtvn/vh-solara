// Package quota reports provider usage quotas by reading OpenCode's stored
// credentials (auth.json) and calling each provider's own usage endpoint —
// the same mechanism OpenChamber uses. Only providers reachable with the
// stored token/key (no OAuth-refresh dance) are implemented: Claude, Codex
// (ChatGPT), OpenRouter, z.ai coding plan, Zhipu AI coding plan, Kimi for
// Coding, NanoGPT, and GitHub Copilot (+ add-on). Google/Gemini needs an OAuth
// refresh flow and is intentionally omitted.
package quota

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// UsageWindow is one rate-limit/credit window for a provider.
type UsageWindow struct {
	Label             string   `json:"label"`
	UsedPercent       *float64 `json:"usedPercent"`
	RemainingPercent  *float64 `json:"remainingPercent"`
	WindowSeconds     *int64   `json:"windowSeconds"`
	ResetAfterSeconds *int64   `json:"resetAfterSeconds"`
	ResetAt           *int64   `json:"resetAt"`
	ValueLabel        string   `json:"valueLabel,omitempty"`
}

// ProviderResult is the per-provider quota report.
type ProviderResult struct {
	ProviderID   string        `json:"providerId"`
	ProviderName string        `json:"providerName"`
	OK           bool          `json:"ok"`
	Configured   bool          `json:"configured"`
	Windows      []UsageWindow `json:"windows"`
	Error        string        `json:"error,omitempty"`
	FetchedAt    int64         `json:"fetchedAt"`
}

// Report is the full multi-provider response.
type Report struct {
	Providers []ProviderResult `json:"providers"`
	FetchedAt int64            `json:"fetchedAt"`
}

// authPath resolves OpenCode's auth.json (~/.local/share/opencode/auth.json),
// overridable via VH_OPENCODE_AUTH for tests/custom installs.
func authPath() string {
	if p := os.Getenv("VH_OPENCODE_AUTH"); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "share", "opencode", "auth.json")
}

func readAuth() map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	p := authPath()
	if p == "" {
		return out
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return out
	}
	_ = json.Unmarshal(b, &out)
	return out
}

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

var httpClient = &http.Client{Timeout: 10 * time.Second}

func getJSON(ctx context.Context, url string, headers map[string]string) (map[string]any, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, 0, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, fmt.Errorf("API error: %d", resp.StatusCode)
	}
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, resp.StatusCode, err
	}
	return out, resp.StatusCode, nil
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

// configuredProviders detects which providers are present in auth.json.
func configuredProviders(auth map[string]json.RawMessage) []string {
	var ids []string
	if e := entry(auth, "anthropic", "claude"); e != nil && str(e, "access", "token") != "" {
		ids = append(ids, "claude")
	}
	if e := entry(auth, "openai", "codex", "chatgpt"); e != nil && str(e, "access", "token") != "" {
		ids = append(ids, "codex")
	}
	if e := entry(auth, "openrouter"); e != nil && str(e, "key", "token") != "" {
		ids = append(ids, "openrouter")
	}
	if e := entry(auth, "zai-coding-plan", "zai", "z.ai"); e != nil && str(e, "key", "token") != "" {
		ids = append(ids, "zai-coding-plan")
	}
	if e := entry(auth, "zhipuai-coding-plan"); e != nil && str(e, "key", "token") != "" {
		ids = append(ids, "zhipuai-coding-plan")
	}
	if e := entry(auth, "kimi-for-coding", "kimi"); e != nil && str(e, "key", "token") != "" {
		ids = append(ids, "kimi-for-coding")
	}
	if e := entry(auth, "nano-gpt", "nanogpt", "nano_gpt"); e != nil && str(e, "key", "token") != "" {
		ids = append(ids, "nano-gpt")
	}
	if e := entry(auth, "github-copilot", "copilot"); e != nil && str(e, "access", "token") != "" {
		ids = append(ids, "github-copilot", "github-copilot-addon")
	}
	return ids
}

// Fetch reports quotas for all supported, configured providers concurrently.
// If VH_QUOTA_FIXTURE holds JSON, it is returned verbatim (test/demo hook).
func Fetch(ctx context.Context) Report {
	if fx := os.Getenv("VH_QUOTA_FIXTURE"); fx != "" {
		var r Report
		if json.Unmarshal([]byte(fx), &r) == nil {
			r.FetchedAt = time.Now().UnixMilli()
			return r
		}
	}
	auth := readAuth()
	ids := configuredProviders(auth)
	results := make([]ProviderResult, len(ids))
	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			switch id {
			case "claude":
				results[i] = fetchClaude(ctx, auth)
			case "codex":
				results[i] = fetchCodex(ctx, auth)
			case "openrouter":
				results[i] = fetchOpenRouter(ctx, auth)
			case "zai-coding-plan":
				results[i] = fetchZai(ctx, auth)
			case "zhipuai-coding-plan":
				results[i] = fetchZhipuai(ctx, auth)
			case "kimi-for-coding":
				results[i] = fetchKimi(ctx, auth)
			case "nano-gpt":
				results[i] = fetchNanoGpt(ctx, auth)
			case "github-copilot":
				results[i] = fetchCopilot(ctx, auth)
			case "github-copilot-addon":
				results[i] = fetchCopilotAddon(ctx, auth)
			}
		}(i, id)
	}
	wg.Wait()
	sort.Slice(results, func(a, b int) bool { return results[a].ProviderName < results[b].ProviderName })
	return Report{Providers: results, FetchedAt: time.Now().UnixMilli()}
}
